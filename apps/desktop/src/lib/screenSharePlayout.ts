export type ScreenSharePlayoutSample = {
  /** RFC 3550 inter-arrival jitter estimate in milliseconds; NaN when unknown. */
  jitterMS: number;
  /** Average residence of video frames emitted in this reporting interval. */
  bufferResidenceMS?: number;
  /** Packets lost since the previous sample, not the cumulative counter. */
  packetsLost: number;
  /** Decoder-dropped frames since the previous sample, when reported. */
  framesDropped: number;
  /**
   * Decoder freezes since the previous sample, when reported.
   *
   * A freeze is the exact symptom this controller exists to prevent, and it can
   * happen with no reported loss: the decoder simply ran out of frames. Without
   * it the buffer has no way to learn from the thing the viewer actually saw.
   */
  freezes?: number;
};

// Targets are hints to the browser. A distant, steady connection needs no
// extra jitter margin just because its propagation time is long.
export const screenShareMinVideoPlayoutDelayMS = 20;
export const screenShareInitialVideoPlayoutDelayMS = 40;
export const screenShareMaxVideoPlayoutDelayMS = 100;
export const screenShareRelayVideoPlayoutDelayMS = 140;

export function screenSharePlayoutDelayCeilingMS(pathKind: string): number {
  return pathKind === "relay" ? screenShareRelayVideoPlayoutDelayMS : screenShareMaxVideoPlayoutDelayMS;
}

// Wide hysteresis band: 12 ms of jitter is ordinary, 30 ms is a struggling
// path. In between, the current delay is kept so the controller does not
// oscillate every tick.
const screenShareJitterStressMS = 30;
const screenShareJitterCalmMS = 12;
const screenShareWidenStepMS = 20;
const screenShareNarrowStepMS = 10;

export function clampScreenSharePlayoutDelayMS(
  delayMS: number,
  ceilingMS: number = screenShareMaxVideoPlayoutDelayMS
): number {
  if (!Number.isFinite(delayMS)) return screenShareInitialVideoPlayoutDelayMS;
  const ceiling = Number.isFinite(ceilingMS) ? ceilingMS : screenShareMaxVideoPlayoutDelayMS;
  return Math.min(
    Math.max(screenShareMinVideoPlayoutDelayMS, ceiling),
    Math.max(screenShareMinVideoPlayoutDelayMS, Math.round(delayMS))
  );
}

// Keep both tracks in the same playout budget and let the receiver's A/V
// synchronizer compensate for codec and device-specific timing.
export function screenShareAudioPlayoutDelayMS(
  videoDelayMS: number,
  ceilingMS: number = screenShareMaxVideoPlayoutDelayMS
): number {
  return clampScreenSharePlayoutDelayMS(videoDelayMS, ceilingMS);
}

export function nextScreenSharePlayoutDelayMS(
  currentMS: number,
  sample: ScreenSharePlayoutSample,
  ceilingMS: number = screenShareMaxVideoPlayoutDelayMS
): number {
  const current = clampScreenSharePlayoutDelayMS(currentMS, ceilingMS);
  const jitterKnown = Number.isFinite(sample.jitterMS);
  const jitterMS = jitterKnown ? Math.max(0, sample.jitterMS) : 0;
  const packetsLost = Number.isFinite(sample.packetsLost) ? Math.max(0, sample.packetsLost) : 0;
  const framesDropped = Number.isFinite(sample.framesDropped) ? Math.max(0, sample.framesDropped) : 0;
  const freezes = typeof sample.freezes === "number" && Number.isFinite(sample.freezes)
    ? Math.max(0, sample.freezes)
    : 0;

  // Decoder saturation or an idle source cannot be repaired by buffering.
  // Raise the hint for arrival jitter, or moderate jitter with an actual
  // loss/freeze symptom. Allow missing jitter when loss coincides with a freeze.
  const stressedPlayback = framesDropped > 0 || freezes > 0 || packetsLost > 0;
  if (!stressedPlayback && jitterKnown && sample.bufferResidenceMS !== undefined &&
      sample.bufferResidenceMS >= current && sample.bufferResidenceMS >= jitterMS * 2) {
    return clampScreenSharePlayoutDelayMS(current - screenShareNarrowStepMS, ceilingMS);
  }
  if (jitterMS >= screenShareJitterStressMS ||
      (jitterMS > screenShareJitterCalmMS && stressedPlayback) ||
      (!jitterKnown && packetsLost > 0 && freezes > 0)) {
    return clampScreenSharePlayoutDelayMS(current + screenShareWidenStepMS, ceilingMS);
  }
  // An unknown jitter figure is not evidence of a calm path, so hold instead of
  // guessing our way down to the minimum.
  if (jitterKnown && jitterMS <= screenShareJitterCalmMS) {
    return clampScreenSharePlayoutDelayMS(current - screenShareNarrowStepMS, ceilingMS);
  }
  return current;
}

/**
 * The receiver buffer can be steered through two APIs, and both can lie: an
 * older WebView2 accepts `jitterBufferTarget` and keeps using its own buffer,
 * and `playoutDelayHint` is only a hint. Writing a value and assuming it took
 * effect would make the adaptive controller above a no-op on those builds, so
 * read the value back and fall through to the next API when it did not stick.
 */
export type ScreenSharePlayoutReceiver = {
  jitterBufferTarget?: number | null;
  playoutDelayHint?: number | null;
};

export type ScreenSharePlayoutControl =
  | "jitterBufferTarget"
  | "playoutDelayHint"
  | "unsupported";

/** Chrome rounds the millisecond target, so a small drift means it was applied. */
const screenSharePlayoutToleranceMS = 1;

export function applyScreenSharePlayoutDelay(
  receiver: ScreenSharePlayoutReceiver,
  delayMS: number
): ScreenSharePlayoutControl {
  const target = Math.max(0, Math.round(delayMS));
  // `in` is the support test, not the assignment: writing to a plain object
  // creates the property and would make the read-back below always succeed.
  if ("jitterBufferTarget" in receiver || receiver.jitterBufferTarget !== undefined) {
    try {
      receiver.jitterBufferTarget = target;
      const applied = receiver.jitterBufferTarget;
      if (
        typeof applied === "number" &&
        Math.abs(applied - target) <= screenSharePlayoutToleranceMS
      ) {
        return "jitterBufferTarget";
      }
    } catch {
      // The property may be read-only on this build; try the older API below.
    }
  }
  if ("playoutDelayHint" in receiver || receiver.playoutDelayHint !== undefined) {
    try {
      receiver.playoutDelayHint = target / 1000;
      const applied = receiver.playoutDelayHint;
      if (typeof applied === "number" && Math.abs(applied * 1000 - target) <= screenSharePlayoutToleranceMS) {
        return "playoutDelayHint";
      }
    } catch {
      // Fall through to unsupported.
    }
  }
  return "unsupported";
}
