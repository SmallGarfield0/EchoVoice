// Pure decision logic for the periodic voice peer health checks. Extracted
// from the workspace component so the background-throttling guard stays
// deterministic and unit-testable.
//
// The core rule: a wall-clock delta measured across a hidden/frozen window is
// not evidence of a broken peer. Browsers suspend timers and media decoding
// for background tabs, so re-seed the sample instead of tearing down a
// healthy connection right after the user returns.

export type VoicePeerInboundSample = {
  bytes: number;
  lastProgressAtMS: number;
};

export type VoicePeerHealthInput = {
  nowMS: number;
  connectionState: string;
  disconnectedAtMS?: number;
  hiddenSinceMS: number;
  mediaExpected: boolean;
  previousSample: VoicePeerInboundSample | null;
  inboundBytes: number;
  disconnectedRetryThresholdMS?: number;
  stalledRetryThresholdMS?: number;
};

export type VoicePeerHealthDecision =
  | { action: "retry"; reason: "disconnected" | "stalled" }
  | { action: "seed"; sample: VoicePeerInboundSample }
  | { action: "keep" };

export const defaultDisconnectedRetryThresholdMS = 6_000;
export const defaultStalledRetryThresholdMS = 7_500;

export function decideVoicePeerHealth(input: VoicePeerHealthInput): VoicePeerHealthDecision {
  const disconnectedThreshold = input.disconnectedRetryThresholdMS ?? defaultDisconnectedRetryThresholdMS;
  const stalledThreshold = input.stalledRetryThresholdMS ?? defaultStalledRetryThresholdMS;

  if (input.connectionState === "disconnected") {
    const disconnectedAtMS = input.disconnectedAtMS ?? input.nowMS;
    if (input.nowMS - disconnectedAtMS >= disconnectedThreshold) {
      return { action: "retry", reason: "disconnected" };
    }
    return { action: "keep" };
  }
  if (input.connectionState !== "connected") return { action: "keep" };

  const previous = input.previousSample;
  if (!previous || input.inboundBytes > previous.bytes || !input.mediaExpected) {
    return { action: "seed", sample: { bytes: input.inboundBytes, lastProgressAtMS: input.nowMS } };
  }
  if (input.nowMS - previous.lastProgressAtMS < stalledThreshold) return { action: "keep" };
  if (input.hiddenSinceMS > 0 && previous.lastProgressAtMS <= input.hiddenSinceMS) {
    // The page was hidden or frozen across the entire measurement window:
    // missing bytes are not evidence of a broken peer. Re-seed the sample so
    // the next visible window gets a fresh baseline.
    return { action: "seed", sample: { bytes: input.inboundBytes, lastProgressAtMS: input.nowMS } };
  }
  return { action: "retry", reason: "stalled" };
}
