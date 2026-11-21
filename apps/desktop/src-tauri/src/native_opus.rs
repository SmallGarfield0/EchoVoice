use std::ptr::NonNull;

use unsafe_libopus::{
    opus_decode_float, opus_decoder_create, opus_decoder_destroy, opus_encode_float,
    opus_encoder_create, opus_encoder_destroy, OpusDecoder, OpusEncoder, OPUS_APPLICATION_AUDIO,
    OPUS_APPLICATION_VOIP, OPUS_OK, OPUS_SET_BITRATE_REQUEST, OPUS_SET_COMPLEXITY_REQUEST,
    OPUS_SET_INBAND_FEC_REQUEST, OPUS_SET_PACKET_LOSS_PERC_REQUEST, OPUS_SET_VBR_REQUEST,
};

pub struct Encoder {
    state: NonNull<OpusEncoder>,
    channels: usize,
}

impl Encoder {
    pub fn new(
        sample_rate: u32,
        channels: usize,
        bitrate: i32,
        complexity: i32,
        variable_bitrate: bool,
        inband_fec: bool,
        packet_loss_percent: i32,
    ) -> Result<Self, String> {
        Self::new_with_application(
            sample_rate,
            channels,
            bitrate,
            complexity,
            variable_bitrate,
            inband_fec,
            packet_loss_percent,
            OPUS_APPLICATION_VOIP,
        )
    }

    pub fn new_audio(
        sample_rate: u32,
        channels: usize,
        bitrate: i32,
        complexity: i32,
        variable_bitrate: bool,
        inband_fec: bool,
        packet_loss_percent: i32,
    ) -> Result<Self, String> {
        Self::new_with_application(
            sample_rate,
            channels,
            bitrate,
            complexity,
            variable_bitrate,
            inband_fec,
            packet_loss_percent,
            OPUS_APPLICATION_AUDIO,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn new_with_application(
        sample_rate: u32,
        channels: usize,
        bitrate: i32,
        complexity: i32,
        variable_bitrate: bool,
        inband_fec: bool,
        packet_loss_percent: i32,
        application: i32,
    ) -> Result<Self, String> {
        let channels_i32 = checked_i32(channels, "channel count")?;
        let mut error = OPUS_OK;
        // SAFETY: libopus validates all scalar arguments and returns an owned state pointer.
        let state = unsafe {
            opus_encoder_create(sample_rate as i32, channels_i32, application, &mut error)
        };
        let state = NonNull::new(state)
            .filter(|_| error == OPUS_OK)
            .ok_or_else(|| opus_error("create encoder", error))?;
        let encoder = Self { state, channels };
        encoder.configure(OPUS_SET_BITRATE_REQUEST, bitrate, "set bitrate")?;
        encoder.configure(OPUS_SET_COMPLEXITY_REQUEST, complexity, "set complexity")?;
        encoder.configure(
            OPUS_SET_VBR_REQUEST,
            i32::from(variable_bitrate),
            "set variable bitrate",
        )?;
        encoder.configure(
            OPUS_SET_INBAND_FEC_REQUEST,
            i32::from(inband_fec),
            "set in-band FEC",
        )?;
        encoder.configure(
            OPUS_SET_PACKET_LOSS_PERC_REQUEST,
            packet_loss_percent,
            "set expected packet loss",
        )?;
        Ok(encoder)
    }

    fn configure(&self, request: i32, value: i32, operation: &str) -> Result<(), String> {
        // SAFETY: state is a live encoder owned by self and this request form takes one i32.
        let result =
            unsafe { unsafe_libopus::opus_encoder_ctl!(self.state.as_ptr(), request, value) };
        if result == OPUS_OK {
            Ok(())
        } else {
            Err(opus_error(operation, result))
        }
    }

    pub fn encode_float(
        &mut self,
        pcm: &[f32],
        frame_samples_per_channel: usize,
        output: &mut [u8],
    ) -> Result<usize, String> {
        let expected_samples = frame_samples_per_channel
            .checked_mul(self.channels)
            .ok_or_else(|| "Opus input sample count overflow".to_string())?;
        if pcm.len() != expected_samples {
            return Err(format!(
                "Opus input has {} samples, expected {expected_samples}",
                pcm.len()
            ));
        }
        let frame_size = checked_i32(frame_samples_per_channel, "frame size")?;
        let output_len = checked_i32(output.len(), "output buffer length")?;
        // SAFETY: slices provide valid pointers and lengths; state is uniquely borrowed by &mut self.
        let result = unsafe {
            opus_encode_float(
                self.state.as_ptr(),
                pcm.as_ptr(),
                frame_size,
                output.as_mut_ptr(),
                output_len,
            )
        };
        if result < 0 {
            Err(opus_error("encode frame", result))
        } else {
            Ok(result as usize)
        }
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        // SAFETY: this object owns the state and Drop runs exactly once.
        unsafe { opus_encoder_destroy(self.state.as_ptr()) };
    }
}

// The state is owned and only accessed through &mut self once encoding begins.
unsafe impl Send for Encoder {}

pub struct Decoder {
    state: NonNull<OpusDecoder>,
    channels: usize,
}

impl Decoder {
    pub fn new(sample_rate: u32, channels: usize) -> Result<Self, String> {
        let channels_i32 = checked_i32(channels, "channel count")?;
        let mut error = OPUS_OK;
        // SAFETY: libopus validates the scalar arguments and returns an owned state pointer.
        let state = unsafe { opus_decoder_create(sample_rate as i32, channels_i32, &mut error) };
        let state = NonNull::new(state)
            .filter(|_| error == OPUS_OK)
            .ok_or_else(|| opus_error("create decoder", error))?;
        Ok(Self { state, channels })
    }

    pub fn decode_float(
        &mut self,
        packet: &[u8],
        output: &mut [f32],
        max_frame_samples_per_channel: usize,
        decode_fec: bool,
    ) -> Result<usize, String> {
        let required_output = max_frame_samples_per_channel
            .checked_mul(self.channels)
            .ok_or_else(|| "Opus output sample count overflow".to_string())?;
        if output.len() < required_output {
            return Err(format!(
                "Opus output buffer has {} samples, requires at least {required_output}",
                output.len()
            ));
        }
        let packet_len = checked_i32(packet.len(), "packet length")?;
        let frame_size = checked_i32(max_frame_samples_per_channel, "maximum frame size")?;
        let packet_ptr = if packet.is_empty() {
            std::ptr::null()
        } else {
            packet.as_ptr()
        };
        // SAFETY: all buffers are valid for the supplied lengths and state is uniquely borrowed.
        let result = unsafe {
            opus_decode_float(
                self.state.as_ptr(),
                packet_ptr,
                packet_len,
                output.as_mut_ptr(),
                frame_size,
                i32::from(decode_fec),
            )
        };
        if result < 0 {
            Err(opus_error("decode packet", result))
        } else {
            Ok(result as usize)
        }
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        // SAFETY: this object owns the state and Drop runs exactly once.
        unsafe { opus_decoder_destroy(self.state.as_ptr()) };
    }
}

// The state is owned and only accessed through &mut self while receiving a track.
unsafe impl Send for Decoder {}

fn checked_i32(value: usize, name: &str) -> Result<i32, String> {
    i32::try_from(value).map_err(|_| format!("Opus {name} exceeds i32"))
}

fn opus_error(operation: &str, code: i32) -> String {
    format!("Opus {operation} failed with code {code}")
}
