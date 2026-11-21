use bytes::Bytes;
use std::time::SystemTime;
use webrtc::rtp::codecs::{h264::H264Payloader, opus::OpusPayloader};
use webrtc::rtp::extension::{abs_send_time_extension::AbsSendTimeExtension, HeaderExtension};
use webrtc::rtp::packet::Packet;
use webrtc::rtp::packetizer::{new_packetizer, Packetizer, Payloader};
use webrtc::rtp::sequence::new_random_sequencer;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::TrackLocalWriter;

/// Each bound sender owns its RTP timestamp and sequence space. Source ticks
/// include intervals lost before packetization, so a slow viewer can skip media
/// without creating fictitious packet loss or shifting its audio/video clocks.
pub(super) struct ScreenSharePacketizer {
    inner: Box<dyn Packetizer + Send + Sync>,
    previous_tick: Option<u64>,
    stamp_send_time: bool,
}

impl ScreenSharePacketizer {
    pub fn video() -> Self {
        Self::new(Box::new(H264Payloader::default()), 90_000, true)
    }

    pub fn audio() -> Self {
        Self::new(Box::new(OpusPayloader), 48_000, false)
    }

    fn new(payloader: Box<dyn Payloader + Send + Sync>, rate: u32, stamp_send_time: bool) -> Self {
        // Match webrtc-rs TrackLocalStaticSample's outgoing MTU. The bound
        // TrackLocalStaticRTP fills in the negotiated payload type and SSRC.
        let sequencer = Box::new(new_random_sequencer());
        Self {
            inner: Box::new(new_packetizer(1200, 0, 0, payloader, sequencer, rate)),
            previous_tick: None,
            stamp_send_time,
        }
    }

    fn packets(&mut self, data: &Bytes, tick: u64) -> Result<Vec<Packet>, webrtc::Error> {
        if let Some(previous) = self.previous_tick {
            let next = tick.max(previous.saturating_add(1));
            self.inner.skip_samples(next.wrapping_sub(previous) as u32);
            self.previous_tick = Some(next);
        } else {
            self.previous_tick = Some(tick);
        }
        Ok(self.inner.packetize(data, 0)?)
    }

    pub async fn write(
        &mut self,
        track: &TrackLocalStaticRTP,
        data: &Bytes,
        tick: u64,
    ) -> Result<(), webrtc::Error> {
        if !track.all_binding_paused().await {
            for packet in self.packets(data, tick)? {
                if self.stamp_send_time {
                    let ext =
                        HeaderExtension::AbsSendTime(AbsSendTimeExtension::new(SystemTime::now()));
                    // The track resolves the ID from each negotiated binding.
                    track.write_rtp_with_extensions(&packet, &[ext]).await?;
                } else {
                    track.write_rtp(&packet).await?;
                }
            }
        }
        Ok(())
    }
}

pub(super) fn video_tick(capture_ns: u64) -> u64 {
    ((u128::from(capture_ns) * 90_000) / 1_000_000_000) as u64
}

/// Equivalent encodings of the Constrained Baseline subprofile in RFC 6184
/// table 5 (including the alternative Main/Extended profile_idc values).
pub(crate) fn is_constrained_baseline(profile_idc: u8, constraints: u8) -> bool {
    match profile_idc {
        0x42 => constraints & 0x4f == 0x40,
        0x4d => constraints & 0x8f == 0x80,
        0x58 => constraints & 0xcf == 0xc0,
        _ => false,
    }
}

pub(super) fn same_h264_subprofile(left: &str, right: &str) -> bool {
    fn profile(value: &str) -> Option<(u8, u8)> {
        let n = u32::from_str_radix(value, 16).ok()?;
        (value.len() == 6).then_some(((n >> 16) as u8, (n >> 8) as u8))
    }
    match (profile(left), profile(right)) {
        (Some(a), Some(b)) => {
            a == b || (is_constrained_baseline(a.0, a.1) && is_constrained_baseline(b.0, b.1))
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_uses_source_time_across_skips_and_layer_switches() {
        let data = Bytes::from_static(&[0, 0, 1, 0x65, 1, 2, 3]);
        let mut fast = ScreenSharePacketizer::video();
        let mut slow = ScreenSharePacketizer::video();
        let send = |writer: &mut ScreenSharePacketizer, ns| {
            writer
                .packets(&data, video_tick(ns))
                .unwrap()
                .remove(0)
                .header
        };
        let fast_start = send(&mut fast, 0);
        let slow_start = send(&mut slow, 0);
        send(&mut fast, 16_666_667);
        let fast_end = send(&mut fast, 1_000_000_000);
        let slow_end = send(&mut slow, 1_000_000_000);
        assert_eq!(
            fast_end.timestamp.wrapping_sub(fast_start.timestamp),
            90_000
        );
        assert_eq!(
            slow_end.timestamp.wrapping_sub(slow_start.timestamp),
            90_000
        );
        assert_eq!(
            slow_end
                .sequence_number
                .wrapping_sub(slow_start.sequence_number),
            1
        );
    }

    #[test]
    fn constrained_baseline_variants_match_and_distinct_high_profiles_stay_distinct() {
        assert!(same_h264_subprofile("42c02a", "42e01f"));
        assert!(same_h264_subprofile("4de01f", "58c02a"));
        assert!(!same_h264_subprofile("64002a", "640c2a"));
        assert!(!same_h264_subprofile("42c02a", "64002a"));
        assert!(!same_h264_subprofile("42c12a", "42e02a"));
    }

    #[test]
    fn skipped_audio_intervals_advance_only_the_rtp_clock() {
        let mut writer = ScreenSharePacketizer::audio();
        let data = Bytes::from_static(&[0xf8, 0xff, 0xfe]);
        let first = writer.packets(&data, 960).unwrap().remove(0).header;
        let next = writer.packets(&data, 4 * 960).unwrap().remove(0).header;
        assert_eq!(next.timestamp.wrapping_sub(first.timestamp), 3 * 960);
        assert_eq!(next.sequence_number.wrapping_sub(first.sequence_number), 1);
    }
}
