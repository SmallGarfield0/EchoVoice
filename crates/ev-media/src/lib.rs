use ev_protocol::{ChannelId, EvUserId};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VoiceParticipantState {
    pub user_id: EvUserId,
    pub channel_id: ChannelId,
    pub self_muted: bool,
    pub self_deafened: bool,
    pub server_muted: bool,
    pub server_deafened: bool,
    pub speaking: bool,
}

impl VoiceParticipantState {
    pub fn can_send_audio(&self) -> bool {
        !self.self_muted && !self.server_muted && !self.self_deafened
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenShareSourceKind {
    Screen,
    Window,
    Application,
    BrowserTab,
    Game,
    Synthetic,
}

impl ScreenShareSourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ScreenShareSourceKind::Screen => "screen",
            ScreenShareSourceKind::Window => "window",
            ScreenShareSourceKind::Application => "application",
            ScreenShareSourceKind::BrowserTab => "browser-tab",
            ScreenShareSourceKind::Game => "game",
            ScreenShareSourceKind::Synthetic => "synthetic",
        }
    }
}

impl TryFrom<&str> for ScreenShareSourceKind {
    type Error = ScreenShareMediaError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "screen" => Ok(ScreenShareSourceKind::Screen),
            "window" => Ok(ScreenShareSourceKind::Window),
            "application" => Ok(ScreenShareSourceKind::Application),
            "browser-tab" => Ok(ScreenShareSourceKind::BrowserTab),
            "game" => Ok(ScreenShareSourceKind::Game),
            "synthetic" => Ok(ScreenShareSourceKind::Synthetic),
            _ => Err(ScreenShareMediaError::UnsupportedSourceKind),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoSize {
    width: u32,
    height: u32,
}

impl VideoSize {
    pub const MAX_WIDTH: u32 = 3840;
    pub const MAX_HEIGHT: u32 = 2160;

    pub fn new(width: u32, height: u32) -> Result<Self, ScreenShareMediaError> {
        if width == 0 || height == 0 || width > Self::MAX_WIDTH || height > Self::MAX_HEIGHT {
            return Err(ScreenShareMediaError::InvalidVideoSize);
        }
        Ok(Self { width, height })
    }

    pub fn width(self) -> u32 {
        self.width
    }

    pub fn height(self) -> u32 {
        self.height
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoFrameRate {
    fps: u32,
}

impl VideoFrameRate {
    pub const MIN: u32 = 1;
    pub const MAX: u32 = 120;

    pub fn new(fps: u32) -> Result<Self, ScreenShareMediaError> {
        if !(Self::MIN..=Self::MAX).contains(&fps) {
            return Err(ScreenShareMediaError::InvalidFrameRate);
        }
        Ok(Self { fps })
    }

    pub fn fps(self) -> u32 {
        self.fps
    }

    pub fn frame_interval_ms(self) -> i64 {
        (1000 / self.fps.max(1) as i64).max(1)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenShareVideoProfile {
    pub source_kind: ScreenShareSourceKind,
    pub output_size: VideoSize,
    pub frame_rate: VideoFrameRate,
    target_bitrate_bps: Option<u32>,
}

impl ScreenShareVideoProfile {
    pub const MIN_TARGET_BITRATE_BPS: u32 = 1_500_000;
    pub const MAX_TARGET_BITRATE_BPS: u32 = 80_000_000;
    pub const MAX_AUTO_TARGET_BITRATE_BPS: u32 = 48_000_000;
    const AUTO_BITRATE_BITS_PER_MEGAPIXEL_FRAME: u64 = 70_000;

    pub fn new(
        source_kind: ScreenShareSourceKind,
        output_size: VideoSize,
        frame_rate: VideoFrameRate,
    ) -> Self {
        Self {
            source_kind,
            output_size,
            frame_rate,
            target_bitrate_bps: None,
        }
    }

    pub fn with_target_bitrate_bps(mut self, target_bitrate_bps: u32) -> Self {
        self.target_bitrate_bps = Some(
            target_bitrate_bps.clamp(Self::MIN_TARGET_BITRATE_BPS, Self::MAX_TARGET_BITRATE_BPS),
        );
        self
    }

    pub fn target_bitrate_bps(&self) -> u32 {
        if let Some(target_bitrate_bps) = self.target_bitrate_bps {
            return target_bitrate_bps;
        }
        let pixels = self.output_size.width() as u64 * self.output_size.height() as u64;
        let bitrate = pixels
            .saturating_mul(self.frame_rate.fps() as u64)
            .saturating_mul(Self::AUTO_BITRATE_BITS_PER_MEGAPIXEL_FRAME)
            / 1_000_000;
        bitrate
            .max(Self::MIN_TARGET_BITRATE_BPS as u64)
            .min(Self::MAX_AUTO_TARGET_BITRATE_BPS as u64) as u32
    }

    pub fn required_h264_level_idc(&self) -> Option<u8> {
        self.h264_level_idc(Some(self.target_bitrate_bps()))
    }

    pub fn minimum_h264_level_idc(&self) -> Option<u8> {
        self.h264_level_idc(None)
    }

    fn h264_level_idc(&self, target_bitrate_bps: Option<u32>) -> Option<u8> {
        let macroblocks_per_frame = self
            .output_size
            .width()
            .div_ceil(16)
            .saturating_mul(self.output_size.height().div_ceil(16));
        let macroblocks_per_second = macroblocks_per_frame.saturating_mul(self.frame_rate.fps());
        [
            (31, 3_600, 108_000, 14_000_000),
            (32, 5_120, 216_000, 20_000_000),
            (40, 8_192, 245_760, 20_000_000),
            (41, 8_192, 245_760, 50_000_000),
            (42, 8_704, 522_240, 50_000_000),
            (50, 22_080, 589_824, 135_000_000),
            (51, 36_864, 983_040, 240_000_000),
            (52, 36_864, 2_073_600, 240_000_000),
            (60, 139_264, 4_177_920, 240_000_000),
            (61, 139_264, 8_355_840, 480_000_000),
            (62, 139_264, 16_711_680, 800_000_000),
        ]
        .into_iter()
        .find(|(_, max_frame, max_second, max_bitrate)| {
            macroblocks_per_frame <= *max_frame
                && macroblocks_per_second <= *max_second
                && target_bitrate_bps.is_none_or(|bitrate| bitrate <= *max_bitrate)
        })
        .map(|(level_idc, _, _, _)| level_idc)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FramePumpDecision {
    Forward,
    Drop,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenShareFramePump {
    target_frame_rate: VideoFrameRate,
    next_frame_at_ns: Option<u64>,
    last_observed_at_ns: Option<u64>,
    estimated_source_interval_ns: Option<u64>,
    forwarded_frames: u64,
    dropped_frames: u64,
}

impl ScreenShareFramePump {
    pub fn new(target_frame_rate: VideoFrameRate) -> Self {
        Self {
            target_frame_rate,
            next_frame_at_ns: None,
            last_observed_at_ns: None,
            estimated_source_interval_ns: None,
            forwarded_frames: 0,
            dropped_frames: 0,
        }
    }

    pub fn target_frame_rate(&self) -> VideoFrameRate {
        self.target_frame_rate
    }

    /// Retargets the pump without losing the observed source cadence.
    ///
    /// The next deadline is dropped instead of being recomputed: the old one was
    /// derived from the previous interval, and keeping it would delay the first
    /// frame at the new rate by up to one old interval.
    pub fn set_target_frame_rate(&mut self, target_frame_rate: VideoFrameRate) {
        if self.target_frame_rate == target_frame_rate {
            return;
        }
        self.target_frame_rate = target_frame_rate;
        self.next_frame_at_ns = None;
    }

    pub fn observe_frame(&mut self, frame_time_ms: i64) -> FramePumpDecision {
        self.observe_frame_ns(frame_time_ms.max(0) as u64 * 1_000_000)
    }

    pub fn observe_frame_ns(&mut self, frame_time_ns: u64) -> FramePumpDecision {
        self.update_source_interval(frame_time_ns);
        let frame_interval_ns = 1_000_000_000_u64 / self.target_frame_rate.fps().max(1) as u64;
        let early_tolerance_ns = self
            .estimated_source_interval_ns
            .map(|interval| interval / 2)
            .unwrap_or(1_000_000)
            .min(frame_interval_ns / 2);
        let should_forward = self
            .next_frame_at_ns
            .map(|deadline| frame_time_ns.saturating_add(early_tolerance_ns) >= deadline)
            .unwrap_or(true);
        if should_forward {
            self.next_frame_at_ns = Some(match self.next_frame_at_ns {
                Some(deadline) => {
                    let elapsed = frame_time_ns.saturating_sub(deadline);
                    let periods = elapsed / frame_interval_ns + 1;
                    deadline.saturating_add(periods.saturating_mul(frame_interval_ns))
                }
                None => frame_time_ns.saturating_add(frame_interval_ns),
            });
            self.forwarded_frames = self.forwarded_frames.saturating_add(1);
            FramePumpDecision::Forward
        } else {
            self.dropped_frames = self.dropped_frames.saturating_add(1);
            FramePumpDecision::Drop
        }
    }

    fn update_source_interval(&mut self, frame_time_ns: u64) {
        if let Some(previous) = self.last_observed_at_ns {
            let interval = frame_time_ns.saturating_sub(previous);
            if interval > 0 && interval <= 1_000_000_000 {
                self.estimated_source_interval_ns = Some(
                    self.estimated_source_interval_ns
                        .map(|estimate| estimate.saturating_mul(7).saturating_add(interval) / 8)
                        .unwrap_or(interval),
                );
            }
        }
        self.last_observed_at_ns = Some(frame_time_ns);
    }

    pub fn forwarded_frames(&self) -> u64 {
        self.forwarded_frames
    }

    pub fn dropped_frames(&self) -> u64 {
        self.dropped_frames
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenShareMediaError {
    UnsupportedSourceKind,
    InvalidVideoSize,
    InvalidFrameRate,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_pump_forwards_first_frame() {
        let frame_rate = VideoFrameRate::new(30).unwrap();
        let mut pump = ScreenShareFramePump::new(frame_rate);

        assert_eq!(pump.observe_frame(1000), FramePumpDecision::Forward);
        assert_eq!(pump.forwarded_frames(), 1);
        assert_eq!(pump.dropped_frames(), 0);
    }

    #[test]
    fn frame_pump_drops_frames_inside_interval() {
        let frame_rate = VideoFrameRate::new(30).unwrap();
        let mut pump = ScreenShareFramePump::new(frame_rate);

        assert_eq!(pump.observe_frame(1000), FramePumpDecision::Forward);
        assert_eq!(pump.observe_frame(1010), FramePumpDecision::Drop);
        assert_eq!(pump.observe_frame(1033), FramePumpDecision::Forward);
        assert_eq!(pump.forwarded_frames(), 2);
        assert_eq!(pump.dropped_frames(), 1);
    }

    #[test]
    fn frame_pump_keeps_thirty_fps_phase_with_sixty_hz_input() {
        let frame_rate = VideoFrameRate::new(30).unwrap();
        let mut pump = ScreenShareFramePump::new(frame_rate);
        let decisions = (0..12)
            .map(|index| pump.observe_frame_ns(index * 16_666_667))
            .collect::<Vec<_>>();

        assert_eq!(
            decisions,
            vec![
                FramePumpDecision::Forward,
                FramePumpDecision::Drop,
                FramePumpDecision::Forward,
                FramePumpDecision::Drop,
                FramePumpDecision::Forward,
                FramePumpDecision::Drop,
                FramePumpDecision::Forward,
                FramePumpDecision::Drop,
                FramePumpDecision::Forward,
                FramePumpDecision::Drop,
                FramePumpDecision::Forward,
                FramePumpDecision::Drop,
            ]
        );
    }

    #[test]
    fn frame_pump_does_not_drift_on_rounded_capture_timestamps() {
        let frame_rate = VideoFrameRate::new(30).unwrap();
        let mut pump = ScreenShareFramePump::new(frame_rate);
        let decisions = [0, 16, 32, 48, 64, 80, 96]
            .into_iter()
            .map(|timestamp_ms| pump.observe_frame(timestamp_ms))
            .collect::<Vec<_>>();

        assert_eq!(
            decisions,
            vec![
                FramePumpDecision::Forward,
                FramePumpDecision::Drop,
                FramePumpDecision::Forward,
                FramePumpDecision::Drop,
                FramePumpDecision::Forward,
                FramePumpDecision::Drop,
                FramePumpDecision::Forward,
            ]
        );
    }

    #[test]
    fn validates_video_profile_bounds() {
        assert!(VideoSize::new(1920, 1080).is_ok());
        assert_eq!(
            VideoSize::new(0, 1080),
            Err(ScreenShareMediaError::InvalidVideoSize)
        );
        assert_eq!(
            VideoFrameRate::new(0),
            Err(ScreenShareMediaError::InvalidFrameRate)
        );
        assert_eq!(
            VideoFrameRate::new(121),
            Err(ScreenShareMediaError::InvalidFrameRate)
        );
    }

    #[test]
    fn derives_screen_share_target_bitrate() {
        let profile = ScreenShareVideoProfile::new(
            ScreenShareSourceKind::Screen,
            VideoSize::new(1280, 720).unwrap(),
            VideoFrameRate::new(30).unwrap(),
        );

        assert_eq!(profile.target_bitrate_bps(), 1_935_360);

        let ultra_hd = ScreenShareVideoProfile::new(
            ScreenShareSourceKind::Screen,
            VideoSize::new(3840, 2160).unwrap(),
            VideoFrameRate::new(60).unwrap(),
        );
        assert_eq!(ultra_hd.target_bitrate_bps(), 34_836_480);
    }

    #[test]
    fn clamps_screen_share_target_bitrate() {
        let low = ScreenShareVideoProfile::new(
            ScreenShareSourceKind::Window,
            VideoSize::new(320, 180).unwrap(),
            VideoFrameRate::new(15).unwrap(),
        );
        let high = ScreenShareVideoProfile::new(
            ScreenShareSourceKind::Screen,
            VideoSize::new(3840, 2160).unwrap(),
            VideoFrameRate::new(120).unwrap(),
        );

        assert_eq!(
            low.target_bitrate_bps(),
            ScreenShareVideoProfile::MIN_TARGET_BITRATE_BPS
        );
        assert_eq!(
            high.target_bitrate_bps(),
            ScreenShareVideoProfile::MAX_AUTO_TARGET_BITRATE_BPS
        );
    }

    #[test]
    fn accepts_user_selected_screen_share_bitrate() {
        let profile = ScreenShareVideoProfile::new(
            ScreenShareSourceKind::Window,
            VideoSize::new(1920, 1080).unwrap(),
            VideoFrameRate::new(60).unwrap(),
        )
        .with_target_bitrate_bps(32_000_000);

        assert_eq!(profile.target_bitrate_bps(), 32_000_000);
    }

    #[test]
    fn derives_h264_level_from_size_cadence_and_bitrate() {
        let profile = |width, height, fps| {
            ScreenShareVideoProfile::new(
                ScreenShareSourceKind::Screen,
                VideoSize::new(width, height).unwrap(),
                VideoFrameRate::new(fps).unwrap(),
            )
        };

        assert_eq!(profile(320, 180, 30).required_h264_level_idc(), Some(31));
        assert_eq!(profile(1280, 720, 30).required_h264_level_idc(), Some(31));
        assert_eq!(profile(1280, 720, 60).required_h264_level_idc(), Some(32));
        assert_eq!(profile(1280, 720, 120).required_h264_level_idc(), Some(42));
        assert_eq!(profile(1920, 1080, 60).required_h264_level_idc(), Some(42));
        assert_eq!(profile(2560, 1440, 60).required_h264_level_idc(), Some(51));
        assert_eq!(profile(3840, 2160, 60).required_h264_level_idc(), Some(52));
        assert_eq!(profile(3840, 2160, 120).required_h264_level_idc(), Some(60));
    }

    #[test]
    fn separates_advertised_and_minimum_h264_levels() {
        let profile = ScreenShareVideoProfile::new(
            ScreenShareSourceKind::Screen,
            VideoSize::new(1280, 720).unwrap(),
            VideoFrameRate::new(120).unwrap(),
        )
        .with_target_bitrate_bps(80_000_000);

        assert_eq!(profile.required_h264_level_idc(), Some(50));
        assert_eq!(profile.minimum_h264_level_idc(), Some(42));
    }
}
