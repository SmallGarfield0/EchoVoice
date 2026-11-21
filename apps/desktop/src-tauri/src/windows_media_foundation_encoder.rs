use crate::native_screen_share::{average_bgra_block, axis_ends, axis_starts, letterbox_rect};
use crate::windows_texture_encoder::TextureEncoderInput;
use ev_media::{ScreenShareSourceKind, ScreenShareVideoProfile, VideoFrameRate, VideoSize};
use rayon::prelude::*;
use std::collections::VecDeque;
use std::ffi::c_void;
use std::mem::ManuallyDrop;
use std::ptr;
use windows::core::{Interface, PWSTR, VARIANT};
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Media::MediaFoundation::{
    eAVEncCommonRateControlMode_CBR, eAVEncH264VProfile_High, CODECAPI_AVEncCommonMeanBitRate,
    CODECAPI_AVEncCommonQualityVsSpeed, CODECAPI_AVEncCommonRateControlMode,
    CODECAPI_AVEncMPVDefaultBPictureCount, CODECAPI_AVEncMPVGOPSize,
    CODECAPI_AVEncVideoForceKeyFrame, CODECAPI_AVLowLatencyMode,
    CODECAPI_VideoEncoderDisplayContentType, ICodecAPI, IMFActivate, IMFMediaEvent,
    IMFMediaEventGenerator, IMFMediaType, IMFSample, IMFTransform, METransformHaveOutput,
    METransformNeedInput, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample,
    MFMediaType_Video, MFShutdown, MFStartup, MFTEnumEx, MFT_FRIENDLY_NAME_Attribute,
    MFVideoFormat_H264, MFVideoFormat_NV12, MFVideoInterlace_Progressive, MFSTARTUP_FULL,
    MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER,
    MFT_MESSAGE_COMMAND_FLUSH, MFT_MESSAGE_NOTIFY_BEGIN_STREAMING,
    MFT_MESSAGE_NOTIFY_END_OF_STREAM, MFT_MESSAGE_NOTIFY_END_STREAMING,
    MFT_MESSAGE_NOTIFY_START_OF_STREAM, MFT_OUTPUT_DATA_BUFFER,
    MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES, MFT_OUTPUT_STREAM_INFO,
    MFT_OUTPUT_STREAM_PROVIDES_SAMPLES, MFT_REGISTER_TYPE_INFO, MF_EVENT_FLAG_NO_WAIT,
    MF_LOW_LATENCY, MF_MT_AVG_BITRATE, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE,
    MF_MT_MAJOR_TYPE, MF_MT_MPEG2_PROFILE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE,
    MF_TRANSFORM_ASYNC, MF_TRANSFORM_ASYNC_UNLOCK, MF_VERSION,
};
use windows::Win32::System::Com::{
    CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED,
};
use yuvutils_rs::{
    bgra_to_yuv_nv12, BufferStoreMut, YuvBiPlanarImageMut, YuvConversionMode, YuvRange,
    YuvStandardMatrix,
};

#[derive(Debug, Clone)]
pub(crate) struct HardwareEncoderCapability {
    pub(crate) name: String,
    pub(crate) configured_profiles: Vec<crate::ConfiguredHardwareProfile>,
}

pub(crate) struct EncodedH264Frame {
    pub(crate) data: Vec<u8>,
    pub(crate) capture_time_ns: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum H264OutputProfile {
    High,
    ConstrainedBaseline,
}

impl H264OutputProfile {
    pub(crate) fn for_compatibility(constrained: bool) -> Self {
        if constrained {
            Self::ConstrainedBaseline
        } else {
            Self::High
        }
    }

    const fn mpeg2_profile(self) -> i32 {
        match self {
            Self::High => eAVEncH264VProfile_High.0,
            Self::ConstrainedBaseline => {
                windows::Win32::Media::MediaFoundation::eAVEncH264VProfile_ConstrainedBase.0
            }
        }
    }
}
pub(crate) struct MediaFoundationH264Encoder {
    activate: IMFActivate,
    transform: IMFTransform,
    event_generator: IMFMediaEventGenerator,
    codec_api: Option<ICodecAPI>,
    input_stream_id: u32,
    output_stream_id: u32,
    output_stream_info: MFT_OUTPUT_STREAM_INFO,
    pending_need_input: u32,
    pending_capture_times: VecDeque<(u64, std::time::Instant)>,
    hardware_outputs: u64,
    hardware_residence_micros: u64,
    converter: BgraToNv12Converter,
    texture_input: Option<TextureEncoderInput>,
    profile: ScreenShareVideoProfile,
    content_mode: String,
    sample_duration_100ns: i64,
    force_keyframe_pending: bool,
    target_bitrate_bps: u32,
    advertised_level_idc: u8,
    minimum_level_idc: u8,
    output_profile: H264OutputProfile,
    sequence_header_validated: bool,
    name: String,
    pub(crate) fallback_reason: Option<String>,
    _runtime: MediaFoundationRuntime,
}

struct MediaFoundationRuntime {
    com_initialized: bool,
    media_foundation_started: bool,
}

impl MediaFoundationRuntime {
    unsafe fn new() -> Result<Self, String> {
        let com_initialized = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        if let Err(err) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
            if com_initialized {
                CoUninitialize();
            }
            return Err(format!("start Media Foundation: {err}"));
        }
        Ok(Self {
            com_initialized,
            media_foundation_started: true,
        })
    }
}

impl Drop for MediaFoundationRuntime {
    fn drop(&mut self) {
        unsafe {
            if self.media_foundation_started {
                let _ = MFShutdown();
            }
            if self.com_initialized {
                CoUninitialize();
            }
        }
    }
}

impl MediaFoundationH264Encoder {
    #[cfg(test)]
    pub(crate) fn new(profile: &ScreenShareVideoProfile) -> Result<Self, String> {
        Self::new_with_content_mode(profile, "balanced", H264OutputProfile::High)
    }

    pub(crate) fn new_with_content_mode(
        profile: &ScreenShareVideoProfile,
        content_mode: &str,
        output_profile: H264OutputProfile,
    ) -> Result<Self, String> {
        unsafe { Self::new_inner(profile, content_mode, None, output_profile) }
    }

    pub(crate) fn new_with_device(
        profile: &ScreenShareVideoProfile,
        content_mode: &str,
        device: &ID3D11Device,
        output_profile: H264OutputProfile,
    ) -> Result<Self, String> {
        unsafe { Self::new_inner(profile, content_mode, Some(device), output_profile) }
    }

    pub(crate) fn is_constrained_baseline(&self) -> bool {
        self.output_profile == H264OutputProfile::ConstrainedBaseline
    }

    pub(crate) fn note_texture_fallback(&mut self, cause: &str) {
        self.fallback_reason.get_or_insert_with(|| cause.to_owned());
    }

    pub(crate) fn uses_texture_input(&self) -> bool {
        self.texture_input.is_some()
    }

    pub(crate) fn restore_memory_input(&mut self, cause: &str) -> Result<(), String> {
        let profile = self
            .profile
            .clone()
            .with_target_bitrate_bps(self.target_bitrate_bps);
        let mut replacement =
            Self::new_with_content_mode(&profile, &self.content_mode, self.output_profile)?;
        replacement.fallback_reason = self
            .fallback_reason
            .clone()
            .or_else(|| Some(cause.to_owned()));
        replacement.force_keyframe();
        *self = replacement;
        Ok(())
    }

    unsafe fn new_inner(
        profile: &ScreenShareVideoProfile,
        content_mode: &str,
        device: Option<&ID3D11Device>,
        output_profile: H264OutputProfile,
    ) -> Result<Self, String> {
        let runtime = MediaFoundationRuntime::new()?;
        let activates = enumerate_hardware_h264_activates(device)?;
        let mut failures = Vec::new();
        for activate in activates {
            let name = activate_name(&activate);
            let transform = match activate.ActivateObject::<IMFTransform>() {
                Ok(transform) => transform,
                Err(err) => {
                    failures.push(format!("{name}: activate failed: {err}"));
                    continue;
                }
            };
            let texture_input = if let Some(device) = device {
                let attrs = transform.GetAttributes().map_err(|e| e.to_string())?;
                if attrs.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or_default() != 0 {
                    attrs
                        .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
                        .map_err(|e| e.to_string())?;
                }
                let input_type = create_video_type(profile, MFVideoFormat_NV12, None)?;
                input_type
                    .SetUINT32(
                        &windows::Win32::Media::MediaFoundation::MF_MT_ALL_SAMPLES_INDEPENDENT,
                        1,
                    )
                    .map_err(|e| e.to_string())?;
                match TextureEncoderInput::new(device, &transform, profile, &input_type) {
                    Ok(input) => Some(input),
                    Err(err) => {
                        failures.push(format!("{name}: D3D11 input: {err}"));
                        let _ = activate.ShutdownObject();
                        continue;
                    }
                }
            } else {
                None
            };
            if let Err(err) = configure_transform(&transform, profile, content_mode, output_profile)
            {
                failures.push(format!("{name}: {output_profile:?}: {err}"));
                let _ = activate.ShutdownObject();
                continue;
            }
            let event_generator = match transform.cast::<IMFMediaEventGenerator>() {
                Ok(generator) => generator,
                Err(err) => {
                    failures.push(format!("{name}: asynchronous event interface: {err}"));
                    let _ = activate.ShutdownObject();
                    continue;
                }
            };
            let (input_stream_id, output_stream_id) = stream_ids(&transform);
            let output_stream_info = match transform.GetOutputStreamInfo(output_stream_id) {
                Ok(info) => info,
                Err(err) => {
                    failures.push(format!("{name}: query output stream: {err}"));
                    let _ = activate.ShutdownObject();
                    continue;
                }
            };
            if let Err(err) = transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)
                .and_then(|_| transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0))
                .and_then(|_| transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0))
            {
                failures.push(format!("{name}: start failed: {err}"));
                let _ = activate.ShutdownObject();
                continue;
            }
            let codec_api = transform.cast::<ICodecAPI>().ok();
            eprintln!(
                "EchoVoice Media Foundation encoder selected: {} {}x{}@{} bitrate={} profile={:?}",
                name,
                profile.output_size.width(),
                profile.output_size.height(),
                profile.frame_rate.fps(),
                profile.target_bitrate_bps(),
                output_profile
            );
            return Ok(Self {
                activate,
                transform,
                event_generator,
                codec_api,
                input_stream_id,
                output_stream_id,
                output_stream_info,
                pending_need_input: 0,
                pending_capture_times: VecDeque::new(),
                hardware_outputs: 0,
                hardware_residence_micros: 0,
                texture_input,
                profile: profile.clone(),
                content_mode: content_mode.to_owned(),
                converter: BgraToNv12Converter::new(
                    profile.output_size.width() as usize,
                    profile.output_size.height() as usize,
                ),
                sample_duration_100ns: (10_000_000_u64
                    .div_ceil(profile.frame_rate.fps().max(1) as u64))
                .min(i64::MAX as u64) as i64,
                force_keyframe_pending: false,
                target_bitrate_bps: profile.target_bitrate_bps(),
                advertised_level_idc: profile.required_h264_level_idc().unwrap_or(52),
                output_profile,
                minimum_level_idc: profile.minimum_h264_level_idc().unwrap_or(52),
                sequence_header_validated: false,
                name,
                fallback_reason: None,
                _runtime: runtime,
            });
        }
        Err(format!(
            "no Media Foundation hardware H.264 encoder accepted the requested profile{}",
            if failures.is_empty() {
                String::new()
            } else {
                format!(": {}", failures.join("; "))
            }
        ))
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn force_keyframe(&mut self) {
        self.force_keyframe_pending = true;
    }

    pub(crate) fn target_bitrate_bps(&self) -> u32 {
        self.target_bitrate_bps
    }

    pub(crate) fn set_content_mode(&mut self, mode: &str) -> Result<(), String> {
        let api = self
            .codec_api
            .as_ref()
            .ok_or("encoder exposes no ICodecAPI")?;
        let quality = quality_and_gop(mode).0;
        unsafe {
            api.SetValue(&CODECAPI_AVEncCommonQualityVsSpeed, &VARIANT::from(quality))
                .map_err(|e| format!("{} cannot retune quality live: {e}", self.name))?;
            let observed = api
                .GetValue(&CODECAPI_AVEncCommonQualityVsSpeed)
                .and_then(|v| u32::try_from(&v))
                .map_err(|e| e.to_string())?;
            if observed != quality {
                return Err(format!("{} retained quality setting {observed}", self.name));
            }
        }
        self.content_mode = mode.into();
        Ok(())
    }

    pub(crate) fn set_target_bitrate_bps(&mut self, bitrate_bps: u32) -> Result<bool, String> {
        if self.target_bitrate_bps == bitrate_bps {
            return Ok(false);
        }
        let codec_api = self
            .codec_api
            .as_ref()
            .ok_or_else(|| format!("{} does not expose the dynamic bitrate API", self.name))?;
        unsafe {
            codec_api
                .SetValue(
                    &CODECAPI_AVEncCommonMeanBitRate,
                    &VARIANT::from(bitrate_bps),
                )
                .map_err(|err| format!("set {} bitrate to {bitrate_bps}: {err}", self.name))?;
        }
        self.target_bitrate_bps = bitrate_bps;
        Ok(true)
    }

    pub(crate) fn encode_bgra(
        &mut self,
        source_bgra: &[u8],
        source_width: usize,
        source_height: usize,
        source_stride: usize,
        capture_time_ns: u64,
    ) -> Result<Vec<EncodedH264Frame>, String> {
        let mut outputs = self.prepare_input()?;
        let nv12 =
            self.converter
                .convert(source_bgra, source_width, source_height, source_stride)?;
        let sample = unsafe { input_sample(nv12, capture_time_ns, self.sample_duration_100ns)? };
        self.submit(&sample, capture_time_ns, &mut outputs)?;
        Ok(outputs)
    }

    pub(crate) fn encode_texture(
        &mut self,
        texture: &ID3D11Texture2D,
        width: u32,
        height: u32,
        capture_time_ns: u64,
    ) -> Result<Vec<EncodedH264Frame>, String> {
        let mut outputs = self.prepare_input()?;
        let input = self
            .texture_input
            .as_mut()
            .ok_or("encoder has no texture input")?;
        let sample = match unsafe { input.convert(texture, width, height) } {
            Ok(sample) => sample,
            // All six samples are owned by the hardware. Leave the input credit
            // intact and let the newest capture try again after output drains.
            Err(e)
                if e.code()
                    == windows::Win32::Media::MediaFoundation::MF_E_SAMPLEALLOCATOR_EMPTY =>
            {
                return Ok(outputs)
            }
            Err(e) => return Err(format!("convert D3D11 screen texture: {e}")),
        };
        unsafe {
            sample
                .SetSampleTime((capture_time_ns / 100) as i64)
                .and_then(|_| sample.SetSampleDuration(self.sample_duration_100ns))
        }
        .map_err(|e| e.to_string())?;
        self.submit(&sample, capture_time_ns, &mut outputs)?;
        Ok(outputs)
    }

    fn prepare_input(&mut self) -> Result<Vec<EncodedH264Frame>, String> {
        let mut outputs = Vec::new();
        self.wait_for_input(&mut outputs)?;
        if self.pending_capture_times.len() >= 12 {
            self.drain_available_events(&mut outputs)?;
            if self.pending_capture_times.len() >= 12 {
                return Err(format!("{} stopped returning submitted frames", self.name));
            }
        }
        if self.force_keyframe_pending {
            if let Some(codec_api) = &self.codec_api {
                unsafe {
                    codec_api
                        .SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(1_u32))
                        .map_err(|err| {
                            format!("force the next {} frame to be a keyframe: {err}", self.name)
                        })?;
                }
            }
            self.force_keyframe_pending = false;
        }
        Ok(outputs)
    }

    fn submit(
        &mut self,
        sample: &IMFSample,
        capture_time_ns: u64,
        outputs: &mut Vec<EncodedH264Frame>,
    ) -> Result<(), String> {
        let submitted_at = std::time::Instant::now();
        unsafe {
            self.transform
                .ProcessInput(self.input_stream_id, sample, 0)
                .map_err(|err| format!("submit NV12 frame to {}: {err}", self.name))?;
        }
        self.pending_need_input = self.pending_need_input.saturating_sub(1);
        self.pending_capture_times
            .push_back((capture_time_ns, submitted_at));
        self.drain_available_events(outputs)
    }

    fn wait_for_input(&mut self, outputs: &mut Vec<EncodedH264Frame>) -> Result<(), String> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(250);
        while self.pending_need_input == 0 {
            self.drain_available_events(outputs)?;
            if self.pending_need_input == 0 {
                if std::time::Instant::now() >= deadline {
                    return Err(format!("{} timed out waiting for encoder input", self.name));
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
        }
        Ok(())
    }

    pub(crate) fn has_pending_output(&self) -> bool {
        !self.pending_capture_times.is_empty()
    }

    pub(crate) fn take_output_timing(&mut self) -> (u64, u64) {
        (
            std::mem::take(&mut self.hardware_outputs),
            std::mem::take(&mut self.hardware_residence_micros),
        )
    }

    pub(crate) fn poll_output(&mut self) -> Result<Vec<EncodedH264Frame>, String> {
        let mut outputs = Vec::new();
        self.drain_available_events(&mut outputs)?;
        Ok(outputs)
    }

    fn drain_available_events(
        &mut self,
        outputs: &mut Vec<EncodedH264Frame>,
    ) -> Result<(), String> {
        loop {
            match unsafe { self.event_generator.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
                Ok(event) => self.handle_event(event, outputs)?,
                Err(err)
                    if err.code()
                        == windows::Win32::Media::MediaFoundation::MF_E_NO_EVENTS_AVAILABLE =>
                {
                    return Ok(())
                }
                Err(err) => {
                    return Err(format!("poll {} encoder event: {err}", self.name));
                }
            }
        }
    }

    fn handle_event(
        &mut self,
        event: IMFMediaEvent,
        outputs: &mut Vec<EncodedH264Frame>,
    ) -> Result<(), String> {
        let status = unsafe { event.GetStatus() }
            .map_err(|err| format!("read {} encoder event status: {err}", self.name))?;
        status
            .ok()
            .map_err(|err| format!("{} encoder event failed: {err}", self.name))?;
        let event_type = unsafe { event.GetType() }
            .map_err(|err| format!("read {} encoder event type: {err}", self.name))?;
        if event_type == METransformNeedInput.0 as u32 {
            self.pending_need_input = self.pending_need_input.saturating_add(1);
        } else if event_type == METransformHaveOutput.0 as u32 {
            if let Some(frame) = self.process_output()? {
                outputs.push(frame);
            }
        }
        Ok(())
    }

    fn process_output(&mut self) -> Result<Option<EncodedH264Frame>, String> {
        let provides_samples = self.output_stream_info.dwFlags
            & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32
                | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32)
            != 0;
        let caller_sample = if provides_samples {
            None
        } else {
            Some(unsafe { output_sample(self.output_stream_info.cbSize)? })
        };
        let mut output = MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: self.output_stream_id,
            pSample: ManuallyDrop::new(caller_sample),
            dwStatus: 0,
            pEvents: ManuallyDrop::new(None),
        };
        let mut status = 0_u32;
        let result = unsafe {
            self.transform
                .ProcessOutput(0, std::slice::from_mut(&mut output), &mut status)
        };
        let sample = unsafe { ManuallyDrop::take(&mut output.pSample) };
        let _events = unsafe { ManuallyDrop::take(&mut output.pEvents) };
        result.map_err(|err| format!("read {} encoded H.264 frame: {err}", self.name))?;
        let Some(sample) = sample else {
            return Ok(None);
        };
        let sample_time_100ns = unsafe { sample.GetSampleTime() }.ok();
        let queued = sample_time_100ns
            .and_then(|time| {
                self.pending_capture_times
                    .iter()
                    .position(|(pts, _)| (*pts / 100) as i64 == time)
            })
            .and_then(|index| self.pending_capture_times.remove(index))
            .or_else(|| self.pending_capture_times.pop_front());
        let fallback_capture_time_ns = queued.map_or(0, |(pts, start)| {
            self.hardware_outputs = self.hardware_outputs.saturating_add(1);
            self.hardware_residence_micros = self
                .hardware_residence_micros
                .saturating_add(start.elapsed().as_micros() as u64);
            pts
        });
        let capture_time_ns = sample_time_100ns
            .and_then(|time| u64::try_from(time).ok())
            .and_then(|time| time.checked_mul(100))
            .unwrap_or(fallback_capture_time_ns);
        let data = normalize_h264_annex_b(unsafe { sample_bytes(&sample)? });
        if !self.sequence_header_validated {
            if let Some((profile_idc, profile_iop, level_idc)) = h264_sps_profile_level(&data) {
                let supported = match self.output_profile {
                    H264OutputProfile::High => profile_idc == 100,
                    H264OutputProfile::ConstrainedBaseline => {
                        crate::screen_share_rtp::is_constrained_baseline(profile_idc, profile_iop)
                    }
                };
                if !supported {
                    return Err(format!("{} produced SPS {profile_idc:02x}{profile_iop:02x}{level_idc:02x} for {:?}",self.name,self.output_profile));
                }
                if level_idc < self.minimum_level_idc {
                    return Err(format!(
                        "{} emitted H.264 level {} below required level {}",
                        self.name, level_idc, self.minimum_level_idc
                    ));
                }
                eprintln!(
                    "EchoVoice Media Foundation H.264 SPS: profile-level-id={profile_idc:02x}{profile_iop:02x}{level_idc:02x} advertised-level={:02x} minimum-level={:02x}",
                    self.advertised_level_idc,
                    self.minimum_level_idc
                );
                self.sequence_header_validated = true;
            } else {
                return Ok(None);
            }
        }
        Ok((!data.is_empty()).then_some(EncodedH264Frame {
            data,
            capture_time_ns,
        }))
    }
}

struct BgraToNv12Converter {
    width: usize,
    height: usize,
    nv12: Vec<u8>,
    source_layout: Option<(usize, usize, usize)>,
    x_starts: Vec<usize>,
    x_ends: Vec<usize>,
    y_starts: Vec<usize>,
    y_ends: Vec<usize>,
}

impl BgraToNv12Converter {
    fn new(width: usize, height: usize) -> Self {
        let width = width.saturating_sub(width % 2).max(2);
        let height = height.saturating_sub(height % 2).max(2);
        Self {
            width,
            height,
            nv12: vec![0; width.saturating_mul(height).saturating_mul(3) / 2],
            source_layout: None,
            x_starts: Vec::new(),
            x_ends: Vec::new(),
            y_starts: Vec::new(),
            y_ends: Vec::new(),
        }
    }

    fn convert(
        &mut self,
        source_bgra: &[u8],
        source_width: usize,
        source_height: usize,
        source_stride: usize,
    ) -> Result<&[u8], String> {
        validate_bgra_frame(source_bgra, source_width, source_height, source_stride)?;
        if source_width == self.width && source_height == self.height {
            let luma_len = self.width * self.height;
            let (y_plane, uv_plane) = self.nv12.split_at_mut(luma_len);
            let mut image = YuvBiPlanarImageMut {
                y_plane: BufferStoreMut::Borrowed(y_plane),
                y_stride: self.width as u32,
                uv_plane: BufferStoreMut::Borrowed(uv_plane),
                uv_stride: self.width as u32,
                width: self.width as u32,
                height: self.height as u32,
            };
            bgra_to_yuv_nv12(
                &mut image,
                source_bgra,
                source_stride as u32,
                YuvRange::Limited,
                YuvStandardMatrix::Bt709,
                YuvConversionMode::Balanced,
            )
            .map_err(|err| format!("convert BGRA screen frame to NV12: {err}"))?;
            return Ok(&self.nv12);
        }

        let source_layout = (source_width, source_height, source_stride);
        let (fit_width, fit_height, x_off, y_off) =
            letterbox_rect(self.width, self.height, source_width, source_height);
        if self.source_layout != Some(source_layout) {
            self.x_starts = axis_starts(fit_width, source_width);
            self.x_ends = axis_ends(fit_width, source_width);
            self.y_starts = axis_starts(fit_height, source_height);
            self.y_ends = axis_ends(fit_height, source_height);
            self.source_layout = Some(source_layout);
        }
        let (y_plane, uv_plane) = self.nv12.split_at_mut(self.width * self.height);
        y_plane.fill(16);
        uv_plane.fill(128);
        let width = self.width;
        let pixel = |x: usize, y: usize| {
            average_bgra_block(
                source_bgra,
                source_stride,
                (self.x_starts[x], self.x_ends[x]),
                (self.y_starts[y], self.y_ends[y]),
            )
        };
        y_plane[y_off * width..(y_off + fit_height) * width]
            .par_chunks_exact_mut(width * 2)
            .zip(
                uv_plane[y_off / 2 * width..(y_off + fit_height) / 2 * width]
                    .par_chunks_exact_mut(width),
            )
            .enumerate()
            .for_each(|(row_pair_index, (y_rows, uv_row))| {
                let y = row_pair_index * 2;
                let (y_row_0, y_row_1) = y_rows.split_at_mut(width);
                for x in (0..fit_width).step_by(2) {
                    let target_x = x_off + x;
                    let pixel_0 = pixel(x, y);
                    let pixel_1 = pixel(x + 1, y);
                    let pixel_2 = pixel(x, y + 1);
                    let pixel_3 = pixel(x + 1, y + 1);
                    y_row_0[target_x] = rgb_to_y(pixel_0);
                    y_row_0[target_x + 1] = rgb_to_y(pixel_1);
                    y_row_1[target_x] = rgb_to_y(pixel_2);
                    y_row_1[target_x + 1] = rgb_to_y(pixel_3);

                    let average = (
                        (pixel_0.0 as u32
                            + pixel_1.0 as u32
                            + pixel_2.0 as u32
                            + pixel_3.0 as u32
                            + 2)
                            / 4,
                        (pixel_0.1 as u32
                            + pixel_1.1 as u32
                            + pixel_2.1 as u32
                            + pixel_3.1 as u32
                            + 2)
                            / 4,
                        (pixel_0.2 as u32
                            + pixel_1.2 as u32
                            + pixel_2.2 as u32
                            + pixel_3.2 as u32
                            + 2)
                            / 4,
                    );
                    uv_row[target_x] = rgb_to_u(average);
                    uv_row[target_x + 1] = rgb_to_v(average);
                }
            });
        Ok(&self.nv12)
    }
}

fn validate_bgra_frame(
    source_bgra: &[u8],
    source_width: usize,
    source_height: usize,
    source_stride: usize,
) -> Result<(), String> {
    if source_width == 0 || source_height == 0 {
        return Err("captured frame has an empty size".to_string());
    }
    let min_stride = source_width
        .checked_mul(4)
        .ok_or_else(|| "captured frame row is too wide".to_string())?;
    if source_stride < min_stride {
        return Err("captured frame stride is smaller than its width".to_string());
    }
    let required_len = source_stride
        .checked_mul(source_height)
        .ok_or_else(|| "captured frame buffer is too large".to_string())?;
    if source_bgra.len() < required_len {
        return Err("captured frame buffer is truncated".to_string());
    }
    Ok(())
}

#[inline(always)]
fn rgb_to_y((red, green, blue): (u8, u8, u8)) -> u8 {
    (((47 * red as u32 + 157 * green as u32 + 16 * blue as u32 + 128) >> 8) + 16).clamp(16, 235)
        as u8
}

#[inline(always)]
fn rgb_to_u((red, green, blue): (u32, u32, u32)) -> u8 {
    (((-26 * red as i32 - 87 * green as i32 + 113 * blue as i32 + 128) >> 8) + 128).clamp(16, 240)
        as u8
}

#[inline(always)]
fn rgb_to_v((red, green, blue): (u32, u32, u32)) -> u8 {
    (((112 * red as i32 - 102 * green as i32 - 10 * blue as i32 + 128) >> 8) + 128).clamp(16, 240)
        as u8
}

unsafe fn input_sample(
    nv12: &[u8],
    capture_time_ns: u64,
    duration_100ns: i64,
) -> Result<IMFSample, String> {
    let buffer_len = u32::try_from(nv12.len())
        .map_err(|_| "NV12 screen frame exceeds Media Foundation buffer limits".to_string())?;
    let buffer = MFCreateMemoryBuffer(buffer_len)
        .map_err(|err| format!("create Media Foundation input buffer: {err}"))?;
    let mut destination = ptr::null_mut();
    buffer
        .Lock(&mut destination, None, None)
        .map_err(|err| format!("lock Media Foundation input buffer: {err}"))?;
    ptr::copy_nonoverlapping(nv12.as_ptr(), destination, nv12.len());
    let unlock_result = buffer.Unlock();
    unlock_result.map_err(|err| format!("unlock Media Foundation input buffer: {err}"))?;
    buffer
        .SetCurrentLength(buffer_len)
        .map_err(|err| format!("set Media Foundation input buffer length: {err}"))?;
    let sample =
        MFCreateSample().map_err(|err| format!("create Media Foundation input sample: {err}"))?;
    sample
        .AddBuffer(&buffer)
        .and_then(|_| sample.SetSampleTime((capture_time_ns / 100).min(i64::MAX as u64) as i64))
        .and_then(|_| sample.SetSampleDuration(duration_100ns))
        .map_err(|err| format!("configure Media Foundation input sample: {err}"))?;
    Ok(sample)
}

unsafe fn output_sample(requested_size: u32) -> Result<IMFSample, String> {
    let sample = MFCreateSample().map_err(|err| format!("create H.264 output sample: {err}"))?;
    let buffer = MFCreateMemoryBuffer(requested_size.max(4 * 1024 * 1024))
        .map_err(|err| format!("create H.264 output buffer: {err}"))?;
    sample
        .AddBuffer(&buffer)
        .map_err(|err| format!("attach H.264 output buffer: {err}"))?;
    Ok(sample)
}

unsafe fn sample_bytes(sample: &IMFSample) -> Result<Vec<u8>, String> {
    let buffer = sample
        .ConvertToContiguousBuffer()
        .map_err(|err| format!("make H.264 output contiguous: {err}"))?;
    let length = buffer
        .GetCurrentLength()
        .map_err(|err| format!("read H.264 output size: {err}"))? as usize;
    let mut source = ptr::null_mut();
    buffer
        .Lock(&mut source, None, None)
        .map_err(|err| format!("lock H.264 output buffer: {err}"))?;
    let data = std::slice::from_raw_parts(source, length).to_vec();
    buffer
        .Unlock()
        .map_err(|err| format!("unlock H.264 output buffer: {err}"))?;
    Ok(data)
}

fn normalize_h264_annex_b(data: Vec<u8>) -> Vec<u8> {
    if data.starts_with(&[0, 0, 1]) || data.starts_with(&[0, 0, 0, 1]) {
        return data;
    }
    let mut offset = 0_usize;
    let mut annex_b = Vec::with_capacity(data.len().saturating_add(32));
    while offset + 4 <= data.len() {
        let length = u32::from_be_bytes([
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ]) as usize;
        offset += 4;
        if length == 0 || offset + length > data.len() {
            return data;
        }
        annex_b.extend_from_slice(&[0, 0, 0, 1]);
        annex_b.extend_from_slice(&data[offset..offset + length]);
        offset += length;
    }
    if offset == data.len() && !annex_b.is_empty() {
        annex_b
    } else {
        data
    }
}

fn h264_sps_profile_level(data: &[u8]) -> Option<(u8, u8, u8)> {
    let mut offset = 0_usize;
    while offset + 4 <= data.len() {
        let start_code_len = if data[offset..].starts_with(&[0, 0, 0, 1]) {
            4
        } else if data[offset..].starts_with(&[0, 0, 1]) {
            3
        } else {
            offset += 1;
            continue;
        };
        let nal_start = offset + start_code_len;
        if nal_start + 4 <= data.len() && data[nal_start] & 0x1f == 7 {
            return Some((
                data[nal_start + 1],
                data[nal_start + 2],
                data[nal_start + 3],
            ));
        }
        offset = nal_start + 1;
    }
    None
}

impl Drop for MediaFoundationH264Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            let _ = self.activate.ShutdownObject();
        }
    }
}

pub(crate) fn probe_hardware_h264_encoders() -> Vec<HardwareEncoderCapability> {
    match unsafe { probe_hardware_h264_encoders_inner() } {
        Ok(capabilities) => capabilities,
        Err(err) => {
            eprintln!("EchoVoice Media Foundation encoder probe failed: {err}");
            Vec::new()
        }
    }
}

unsafe fn probe_hardware_h264_encoders_inner() -> Result<Vec<HardwareEncoderCapability>, String> {
    let _runtime = MediaFoundationRuntime::new()?;
    let activates = enumerate_hardware_h264_activates(None)?;
    let mut capabilities = Vec::new();
    for activate in activates {
        let Ok(mft) = activate.ActivateObject::<IMFTransform>() else {
            continue;
        };
        // Probe every preset on one idle transform. Repeated activation of
        // offline vendor components can otherwise take seconds per size.
        let mut configured_profiles = Vec::new();
        for (width, height) in [(1280, 720), (1920, 1080), (2560, 1440), (3840, 2160)] {
            let mut frame_rates = Vec::new();
            for fps in [30, 45, 60, 90, 120] {
                let profile = ScreenShareVideoProfile::new(
                    ScreenShareSourceKind::Screen,
                    VideoSize::new(width, height).unwrap(),
                    VideoFrameRate::new(fps).unwrap(),
                );
                let accepted = [
                    H264OutputProfile::High,
                    H264OutputProfile::ConstrainedBaseline,
                ]
                .into_iter()
                .any(|mode| {
                    let _ = mft.SetInputType(0, None, 0);
                    let _ = mft.SetOutputType(0, None, 0);
                    configure_transform(&mft, &profile, "motion", mode).is_ok()
                });
                if accepted {
                    frame_rates.push(fps);
                }
            }
            configured_profiles.push(crate::ConfiguredHardwareProfile {
                width,
                height,
                frame_rates,
            });
        }
        drop(mft);
        let _ = activate.ShutdownObject();
        capabilities.push(HardwareEncoderCapability {
            name: activate_name(&activate),
            configured_profiles,
        });
    }
    Ok(capabilities)
}

unsafe fn enumerate_hardware_h264_activates(
    device: Option<&ID3D11Device>,
) -> Result<Vec<IMFActivate>, String> {
    let input_type = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_NV12,
    };
    let output_type = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };
    let mut activates_ptr: *mut Option<IMFActivate> = ptr::null_mut();
    let mut activate_count = 0_u32;
    if let Some(device) = device {
        use windows::Win32::Media::MediaFoundation::{
            MFCreateAttributes, MFTEnum2, MFT_ENUM_ADAPTER_LUID,
        };
        let dxgi: IDXGIDevice = device.cast().map_err(|e| e.to_string())?;
        let luid = dxgi
            .GetAdapter()
            .and_then(|a| a.GetDesc())
            .map_err(|e| e.to_string())?
            .AdapterLuid;
        let mut attributes = None;
        MFCreateAttributes(&mut attributes, 1).map_err(|e| e.to_string())?;
        let attributes = attributes.ok_or("no MFT enumeration attribute store")?;
        attributes
            .SetUINT64(
                &MFT_ENUM_ADAPTER_LUID,
                ((luid.HighPart as u32 as u64) << 32) | u64::from(luid.LowPart),
            )
            .map_err(|e| e.to_string())?;
        MFTEnum2(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            Some(&input_type),
            Some(&output_type),
            &attributes,
            &mut activates_ptr,
            &mut activate_count,
        )
    } else {
        MFTEnumEx(
            MFT_CATEGORY_VIDEO_ENCODER,
            MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
            Some(&input_type),
            Some(&output_type),
            &mut activates_ptr,
            &mut activate_count,
        )
    }
    .map_err(|err| format!("enumerate hardware H.264 encoders: {err}"))?;

    let mut activates = Vec::with_capacity(activate_count as usize);
    if !activates_ptr.is_null() {
        for index in 0..activate_count as usize {
            if let Some(activate) = ptr::read(activates_ptr.add(index)) {
                activates.push(activate);
            }
        }
    }
    if !activates_ptr.is_null() {
        CoTaskMemFree(Some(activates_ptr.cast::<c_void>()));
    }
    Ok(activates)
}

unsafe fn stream_ids(transform: &IMFTransform) -> (u32, u32) {
    let mut input = [0_u32];
    let mut output = [0_u32];
    if transform.GetStreamIDs(&mut input, &mut output).is_ok() {
        (input[0], output[0])
    } else {
        (0, 0)
    }
}

unsafe fn activate_name(activate: &IMFActivate) -> String {
    let mut value = PWSTR::null();
    let mut length = 0_u32;
    if activate
        .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut value, &mut length)
        .is_err()
        || value.is_null()
    {
        return "Media Foundation hardware H.264 encoder".to_string();
    }
    let name = String::from_utf16_lossy(std::slice::from_raw_parts(value.0, length as usize));
    CoTaskMemFree(Some(value.0.cast::<c_void>()));
    name
}

fn quality_and_gop(mode: &str) -> (u32, u32) {
    match mode {
        "detail" => (85, 3),
        "motion" => (25, 1),
        _ => (60, 2),
    }
}

unsafe fn configure_transform(
    transform: &IMFTransform,
    profile: &ScreenShareVideoProfile,
    content_mode: &str,
    output_profile: H264OutputProfile,
) -> Result<(), String> {
    if let Ok(attributes) = transform.GetAttributes() {
        let is_async = attributes
            .GetUINT32(&MF_TRANSFORM_ASYNC)
            .unwrap_or_default()
            != 0;
        if is_async {
            attributes
                .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
                .map_err(|err| format!("unlock asynchronous encoder: {err}"))?;
        }
        let _ = attributes.SetUINT32(&MF_LOW_LATENCY, 1);
    }
    if let Ok(codec_api) = transform.cast::<ICodecAPI>() {
        let _ = codec_api.SetValue(&CODECAPI_AVLowLatencyMode, &VARIANT::from(true));
        let _ = codec_api.SetValue(
            &CODECAPI_AVEncCommonRateControlMode,
            &VARIANT::from(eAVEncCommonRateControlMode_CBR.0),
        );
        let _ = codec_api.SetValue(
            &CODECAPI_AVEncCommonMeanBitRate,
            &VARIANT::from(profile.target_bitrate_bps()),
        );
        let _ = codec_api.SetValue(
            &CODECAPI_VideoEncoderDisplayContentType,
            &VARIANT::from(0_u32),
        );
        let (quality_vs_speed, keyframe_seconds) = quality_and_gop(content_mode);
        let _ = codec_api.SetValue(
            &CODECAPI_AVEncCommonQualityVsSpeed,
            &VARIANT::from(quality_vs_speed),
        );
        let _ = codec_api.SetValue(
            &CODECAPI_AVEncMPVGOPSize,
            &VARIANT::from(profile.frame_rate.fps().saturating_mul(keyframe_seconds)),
        );
        let _ = codec_api.SetValue(
            &CODECAPI_AVEncMPVDefaultBPictureCount,
            &VARIANT::from(0_u32),
        );
    }

    let output_type = create_video_type(
        profile,
        MFVideoFormat_H264,
        Some(output_profile.mpeg2_profile()),
    )?;
    transform
        .SetOutputType(0, &output_type, 0)
        .map_err(|err| format!("set H.264 output type: {err}"))?;
    let input_type = create_video_type(profile, MFVideoFormat_NV12, None)?;
    transform
        .SetInputType(0, &input_type, 0)
        .map_err(|err| format!("set NV12 input type: {err}"))?;
    Ok(())
}

unsafe fn create_video_type(
    profile: &ScreenShareVideoProfile,
    subtype: windows::core::GUID,
    mpeg2_profile: Option<i32>,
) -> Result<IMFMediaType, String> {
    let media_type =
        MFCreateMediaType().map_err(|err| format!("create video media type: {err}"))?;
    media_type
        .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
        .and_then(|_| media_type.SetGUID(&MF_MT_SUBTYPE, &subtype))
        .and_then(|_| {
            media_type.SetUINT64(
                &MF_MT_FRAME_SIZE,
                pack_ratio(profile.output_size.width(), profile.output_size.height()),
            )
        })
        .and_then(|_| {
            media_type.SetUINT64(&MF_MT_FRAME_RATE, pack_ratio(profile.frame_rate.fps(), 1))
        })
        .and_then(|_| media_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack_ratio(1, 1)))
        .and_then(|_| {
            media_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
        })
        .map_err(|err| format!("configure video media type: {err}"))?;
    // Both input paths convert full-range desktop RGB to BT.709 limited NV12.
    // A driver should receive the same color contract for CPU and GPU samples.
    use windows::Win32::Media::MediaFoundation::{
        MFNominalRange_16_235, MFVideoPrimaries_BT709, MFVideoTransFunc_709,
        MFVideoTransferMatrix_BT709, MF_MT_TRANSFER_FUNCTION, MF_MT_VIDEO_NOMINAL_RANGE,
        MF_MT_VIDEO_PRIMARIES, MF_MT_YUV_MATRIX,
    };
    for (key, value) in [
        (MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0),
        (MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0),
        (MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0),
        (MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0),
    ] {
        media_type
            .SetUINT32(&key, value as u32)
            .map_err(|e| format!("configure BT.709 media type: {e}"))?;
    }
    if let Some(mpeg2_profile) = mpeg2_profile {
        media_type
            .SetUINT32(&MF_MT_AVG_BITRATE, profile.target_bitrate_bps())
            .and_then(|_| media_type.SetUINT32(&MF_MT_MPEG2_PROFILE, mpeg2_profile as u32))
            .map_err(|err| format!("configure H.264 output media type: {err}"))?;
    }
    Ok(media_type)
}

const fn pack_ratio(numerator: u32, denominator: u32) -> u64 {
    ((numerator as u64) << 32) | denominator as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn reports_media_foundation_hardware_encoders() {
        let encoders = probe_hardware_h264_encoders();
        eprintln!("EchoVoice hardware H.264 encoders: {encoders:#?}");
    }

    #[test]
    fn scaled_nv12_preserves_aspect_and_averages_fine_motion_detail() {
        let mut converter = BgraToNv12Converter::new(8, 8);
        // Two rows of alternating vertical bars per target cell. Nearest
        // sampling would alias this pattern to black or white on every pan.
        let mut bgra = vec![0u8; 16 * 8 * 4];
        for (i, pixel) in bgra.chunks_exact_mut(4).enumerate() {
            pixel.fill(if i % 2 == 0 { 255 } else { 0 });
        }
        let nv12 = converter.convert(&bgra, 16, 8, 16 * 4).unwrap();
        assert!(nv12[..16].iter().chain(&nv12[48..64]).all(|y| *y == 16));
        assert!(nv12[16..48].iter().all(|y| (124..=128).contains(y)));
        assert!(nv12[64..].iter().all(|c| *c == 128));
    }

    #[test]
    #[ignore = "requires a D3D11 adapter and a matching hardware H.264 encoder"]
    fn encodes_d3d11_texture_without_cpu_readback() {
        use windows::Win32::Graphics::Direct3D::{
            D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0,
        };
        use windows::Win32::Graphics::Direct3D11::*;
        use windows::Win32::Graphics::Dxgi::Common::*;
        unsafe {
            let mut device = None;
            let mut context = None;
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                None,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .unwrap();
            let device = device.unwrap();
            let context = context.unwrap();
            let _ = context
                .cast::<ID3D11Multithread>()
                .unwrap()
                .SetMultithreadProtected(true);
            let profile = ScreenShareVideoProfile::new(
                ScreenShareSourceKind::Synthetic,
                VideoSize::new(1920, 1080).unwrap(),
                VideoFrameRate::new(60).unwrap(),
            );
            let mut surface = None;
            device
                .CreateTexture2D(
                    &D3D11_TEXTURE2D_DESC {
                        Width: 1280,
                        Height: 720,
                        MipLevels: 1,
                        ArraySize: 1,
                        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                        SampleDesc: DXGI_SAMPLE_DESC {
                            Count: 1,
                            Quality: 0,
                        },
                        BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
                        ..Default::default()
                    },
                    None,
                    Some(&mut surface),
                )
                .unwrap();
            let surface = surface.unwrap();
            let mut view = None;
            device
                .CreateRenderTargetView(&surface, None, Some(&mut view))
                .unwrap();
            let view = view.unwrap();
            for output_profile in [
                H264OutputProfile::High,
                H264OutputProfile::ConstrainedBaseline,
            ] {
                let mut mft = MediaFoundationH264Encoder::new_with_device(
                    &profile,
                    "motion",
                    &device,
                    output_profile,
                )
                .unwrap();
                let mut frames = Vec::new();
                let started = Instant::now();
                for frame in 0..120u64 {
                    context
                        .ClearRenderTargetView(&view, &[(frame % 11) as f32 / 10.0, 0.4, 0.5, 1.0]);
                    let pts = frame * 1_000_000_000 / 60;
                    frames.extend(mft.encode_texture(&surface, 1280, 720, pts).unwrap());
                }
                eprintln!("{} 1280x720 D3D11 → 1920x1080 NV12/H.264 produced {} frames in {:?} (encode harness, unpaced)",mft.name(),frames.len(),started.elapsed());
                // Simulate the source becoming static. The last submitted update
                // must arrive without a subsequent input just to flush the hardware.
                let deadline = Instant::now() + std::time::Duration::from_millis(250);
                while mft.has_pending_output() && Instant::now() < deadline {
                    frames.extend(mft.poll_output().unwrap());
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                assert_eq!(frames.len(), 120);
                assert_eq!(
                    frames.last().unwrap().capture_time_ns,
                    (119 * 1_000_000_000u64 / 60) / 100 * 100
                );
                assert!(frames
                    .windows(2)
                    .all(|w| w[0].capture_time_ns < w[1].capture_time_ns));
                assert!(frames
                    .iter()
                    .any(|f| h264_sps_profile_level(&f.data).is_some()));
            }
        }
    }

    #[test]
    fn encodes_720p60_with_hardware_mft() {
        let profile = ScreenShareVideoProfile::new(
            ScreenShareSourceKind::Synthetic,
            VideoSize::new(1280, 720).unwrap(),
            VideoFrameRate::new(60).unwrap(),
        );
        let Ok(mut encoder) = MediaFoundationH264Encoder::new(&profile) else {
            eprintln!("EchoVoice 720p60 hardware encoder test skipped: no compatible MFT");
            return;
        };
        let bgra = vec![32_u8; 1280 * 720 * 4];
        let mut encoded = Vec::new();
        for frame_index in 0..12_u64 {
            encoded.extend(
                encoder
                    .encode_bgra(&bgra, 1280, 720, 1280 * 4, frame_index * 1_000_000_000 / 60)
                    .unwrap(),
            );
        }
        assert!(!encoded.is_empty(), "hardware MFT produced no H.264 output");
    }

    #[test]
    fn encodes_720p120_with_hardware_mft() {
        if !probe_hardware_h264_encoders().iter().any(|encoder| {
            encoder
                .configured_profiles
                .iter()
                .any(|p| p.width == 1280 && p.frame_rates.contains(&120))
        }) {
            eprintln!("EchoVoice 720p120 hardware encoder test skipped: no compatible MFT");
            return;
        }
        let profile = ScreenShareVideoProfile::new(
            ScreenShareSourceKind::Synthetic,
            VideoSize::new(1280, 720).unwrap(),
            VideoFrameRate::new(120).unwrap(),
        );
        let mut encoder = MediaFoundationH264Encoder::new(&profile).unwrap();
        let mut bgra = vec![0_u8; 1280 * 720 * 4];
        for pixel in bgra.chunks_exact_mut(4) {
            pixel.copy_from_slice(&[48, 132, 220, 255]);
        }
        let started = Instant::now();
        let mut encoded = Vec::new();
        for frame_index in 0..48_u64 {
            encoded.extend(
                encoder
                    .encode_bgra(
                        &bgra,
                        1280,
                        720,
                        1280 * 4,
                        frame_index * 1_000_000_000 / 120,
                    )
                    .unwrap(),
            );
        }
        let elapsed = started.elapsed();
        eprintln!(
            "EchoVoice {} 720p120 test: submitted=48 encoded={} elapsed={:?} throughput={:.1} fps",
            encoder.name(),
            encoded.len(),
            elapsed,
            48.0 / elapsed.as_secs_f64()
        );
        assert!(!encoded.is_empty(), "hardware MFT produced no H.264 output");
        assert!(encoded.iter().all(
            |frame| frame.data.starts_with(&[0, 0, 0, 1]) || frame.data.starts_with(&[0, 0, 1])
        ));
    }

    #[test]
    fn encodes_2160p60_with_hardware_mft() {
        let profile = ScreenShareVideoProfile::new(
            ScreenShareSourceKind::Synthetic,
            VideoSize::new(3840, 2160).unwrap(),
            VideoFrameRate::new(60).unwrap(),
        );
        let Ok(mut encoder) = MediaFoundationH264Encoder::new(&profile) else {
            eprintln!("EchoVoice 2160p60 hardware encoder test skipped: no compatible MFT");
            return;
        };
        let mut bgra = vec![0_u8; 3840 * 2160 * 4];
        for pixel in bgra.chunks_exact_mut(4) {
            pixel.copy_from_slice(&[48, 132, 220, 255]);
        }
        let started = Instant::now();
        let mut encoded = Vec::new();
        for frame_index in 0..12_u64 {
            encoded.extend(
                encoder
                    .encode_bgra(
                        &bgra,
                        3840,
                        2160,
                        3840 * 4,
                        frame_index * 1_000_000_000 / 60,
                    )
                    .unwrap(),
            );
        }
        let elapsed = started.elapsed();
        eprintln!(
            "EchoVoice {} 2160p60 test: submitted=12 encoded={} elapsed={:?} throughput={:.1} fps",
            encoder.name(),
            encoded.len(),
            elapsed,
            12.0 / elapsed.as_secs_f64()
        );
        assert!(
            !encoded.is_empty(),
            "hardware MFT produced no 2160p H.264 output"
        );
    }
}
