use std::time::{Duration, Instant};

#[derive(Clone, Copy, Default)]
pub(super) struct ContentCounters {
    pub source_updates: u64,
    pub encode_calls: u64,
    pub encode_micros: u64,
    pub encode_bytes: u64,
    pub backpressure_drops: u64,
}

pub(super) struct SmartScreenContent {
    last: Instant,
    counters: ContentCounters,
    candidate: &'static str,
    windows: u8,
    effective: &'static str,
}

impl SmartScreenContent {
    pub fn new(now: Instant) -> Self {
        Self {
            last: now,
            counters: ContentCounters::default(),
            candidate: "balanced",
            windows: 0,
            effective: "balanced",
        }
    }

    pub fn due(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.last) >= Duration::from_secs(1)
    }

    /// WGC reports source changes. Encoder bytes and wall time distinguish
    /// sustained complex motion from a blinking caret or periodic keyframe.
    pub fn observe(
        &mut self,
        now: Instant,
        next: ContentCounters,
        fps: u32,
        bitrate: u32,
    ) -> Option<(&'static str, &'static str)> {
        if !self.due(now) {
            return None;
        }
        let elapsed = now.duration_since(self.last).as_secs_f64();
        let updates = next
            .source_updates
            .saturating_sub(self.counters.source_updates) as f64
            / elapsed;
        let calls = next.encode_calls.saturating_sub(self.counters.encode_calls);
        let busy = next
            .encode_micros
            .saturating_sub(self.counters.encode_micros) as f64
            / (elapsed * 1e6);
        let bits =
            next.encode_bytes.saturating_sub(self.counters.encode_bytes) as f64 * 8.0 / elapsed;
        let drops = next
            .backpressure_drops
            .saturating_sub(self.counters.backpressure_drops);
        self.counters = next;
        self.last = now;
        let (mode, reason, hold) = if busy > 0.8 || drops > 2 {
            ("motion", "encoder-pressure", 2)
        } else if updates >= f64::from(fps) * 0.72 && bits >= f64::from(bitrate) * 0.4 && calls > 0
        {
            ("motion", "sustained-motion", 3)
        } else if updates <= (f64::from(fps) * 0.18).max(3.0) && bits < f64::from(bitrate) * 0.35 {
            ("detail", "low-activity", 5)
        } else {
            ("balanced", "observing", 5)
        };
        if self.candidate != mode {
            self.candidate = mode;
            self.windows = 0;
        }
        self.windows = self.windows.saturating_add(1);
        if self.windows < hold || self.effective == mode {
            return None;
        }
        self.effective = mode;
        Some((mode, reason))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smart_content_needs_sustained_evidence_and_recovers_when_static() {
        let start = Instant::now();
        let mut controller = SmartScreenContent::new(start);
        let mut c = ContentCounters::default();
        for window in 1..=3 {
            c.source_updates += 60;
            c.encode_calls += 60;
            c.encode_bytes += 900_000;
            let result = controller.observe(start + Duration::from_secs(window), c, 60, 8_000_000);
            assert_eq!(
                result,
                (window == 3).then_some(("motion", "sustained-motion"))
            );
        }
        for window in 4..=8 {
            let result = controller.observe(start + Duration::from_secs(window), c, 60, 8_000_000);
            assert_eq!(result, (window == 8).then_some(("detail", "low-activity")));
        }
    }
}
