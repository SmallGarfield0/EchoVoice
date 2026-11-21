export type ScreenSharePathLivenessInput = {
  nowMS: number;
  documentHidden: boolean;
  /** At least one frame had been decoded before this sample. */
  hasPlayableMedia: boolean;
  /** Decoded frames, or received packets when frame stats are unavailable. */
  mediaProgressed: boolean;
  /** Total bytes seen on the selected ICE pair, ever. */
  transportBytesReceived: number;
  /** Consecutive samples that found no succeeded candidate pair at all. */
  missingCandidatePairSamples?: number;
  stallThresholdMS: number;
  previous?: {
    transportBytesReceived?: number;
    lastTransportProgressAtMS?: number;
    lastPlaybackProgressAtMS?: number;
  };
};

export type ScreenSharePathLiveness = {
  transportProgressed: boolean;
  lastTransportProgressAtMS?: number;
  lastPlaybackProgressAtMS?: number;
  stalled: boolean;
};

/**
 * How many consecutive samples may find no succeeded ICE pair before the path
 * counts as dead.
 *
 * A renegotiation or an ICE restart briefly has no nominated pair, so one or two
 * quiet samples are normal. Losing the pair for three seconds while a picture is
 * being watched is not: it is what an expired TURN allocation looks like, and
 * waiting out the full transport timeout would keep a frozen frame on screen for
 * another eleven seconds.
 */
export const screenShareMissingCandidatePairLimit = 3;

/**
 * Decides whether a watched screen share is stalled.
 *
 * A desktop that is not changing produces no encoded frames at all, so a quiet
 * media stream is the normal steady state of a shared document - not evidence of
 * a broken path. The nominated ICE pair keeps carrying consent checks and RTCP
 * while the sender is idle, so the path going silent is what actually indicates
 * a stall. Judging this by decoded frames instead tore the connection down every
 * few seconds for as long as nothing moved on screen.
 */
export function decideScreenSharePathLiveness(
  input: ScreenSharePathLivenessInput
): ScreenSharePathLiveness {
  const previousBytes = input.previous?.transportBytesReceived ?? 0;
  // Any movement counts, including a drop: a rebuilt peer connection starts a
  // fresh pair, so its counter restarts near zero while the share status, and
  // therefore this baseline, survives across the reconnect.
  const transportProgressed = input.transportBytesReceived !== previousBytes;
  const lastTransportProgressAtMS = transportProgressed || input.documentHidden
    ? input.nowMS
    : input.previous?.lastTransportProgressAtMS;
  // A hidden tab stops presenting frames without the stream being broken, so its
  // timestamps stay pinned and it never reads as stalled on return.
  const lastPlaybackProgressAtMS = input.mediaProgressed || input.documentHidden
    ? input.nowMS
    : input.previous?.lastPlaybackProgressAtMS;
  const missingCandidatePairSamples = Number.isFinite(input.missingCandidatePairSamples)
    ? Math.max(0, input.missingCandidatePairSamples ?? 0)
    : 0;
  const stalled = Boolean(
    !input.documentHidden &&
      input.hasPlayableMedia &&
      (missingCandidatePairSamples >= screenShareMissingCandidatePairLimit ||
        (lastTransportProgressAtMS !== undefined &&
          input.nowMS - lastTransportProgressAtMS >= input.stallThresholdMS))
  );
  return {
    transportProgressed,
    lastTransportProgressAtMS,
    lastPlaybackProgressAtMS,
    stalled
  };
}

/** How long a viewer keeps rebuilding before accepting that no frame is coming. */
export const screenShareWatchGiveUpMS = 20_000;

/**
 * True when a watch has been retried long enough without ever producing a frame.
 *
 * Without this the reconnect loop is unbounded: a share whose owner stopped
 * capturing but never ended the session looks permanently unhealthy, so every
 * viewer rebuilds its connection on a timer forever - and each rebuild makes the
 * sharer encode one more stream for a picture nobody will ever see.
 */
export function screenShareWatchShouldGiveUp(
  startedAtMS: number | undefined,
  nowMS: number
): boolean {
  if (startedAtMS === undefined || !Number.isFinite(startedAtMS) || startedAtMS <= 0) return false;
  if (!Number.isFinite(nowMS)) return false;
  return nowMS - startedAtMS >= screenShareWatchGiveUpMS;
}
