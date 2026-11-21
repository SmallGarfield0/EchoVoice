/**
 * Recovery decisions for a watched screen share.
 *
 * An ICE failure used to tear the whole peer connection down and start a fresh
 * watch: a new offer, a new encoder path on the sharer, and a keyframe wait, all
 * of which is a second or more of black screen and a viewer that blinks out of
 * the sharer's list. Asking the sharer to restart ICE on the connection that
 * already exists keeps the encoder and the keyframe state, so the picture comes
 * back in a fraction of the time.
 *
 * The request is not free and not always safe: an older sharer ignores an
 * unknown signal type, and a link that keeps failing would otherwise renegotiate
 * forever. So every restart request carries a fallback rebuild, and a second
 * failure inside the cooldown window goes straight to the rebuild.
 */

export const screenShareIceRestartCooldownMS = 4_000;
export const screenShareIceRestartFallbackMS = 2_500;
export const screenShareRebuildDelayMS = 400;
export const screenShareDisconnectedRebuildDelayMS = 2_500;
export const screenShareUnhealthyRebuildDelayMS = 6_000;

export type ScreenShareRecoveryState = "healthy" | "failed" | "disconnected" | "unhealthy";

export type ScreenShareRecoveryDecision =
  | { action: "hold" }
  | { action: "request-ice-restart"; fallbackDelayMS: number }
  | { action: "rebuild"; delayMS: number };

export function decideScreenShareRecovery(input: {
  state: ScreenShareRecoveryState;
  nowMS: number;
  lastIceRestartRequestedAtMS?: number;
}): ScreenShareRecoveryDecision {
  switch (input.state) {
    case "healthy":
      return { action: "hold" };
    case "unhealthy":
      return { action: "rebuild", delayMS: screenShareUnhealthyRebuildDelayMS };
    case "disconnected":
      // A transient disconnect usually heals on its own, and restarting ICE here
      // would renegotiate a connection that is not actually broken.
      return { action: "rebuild", delayMS: screenShareDisconnectedRebuildDelayMS };
    case "failed":
      break;
  }

  const lastRequest = input.lastIceRestartRequestedAtMS;
  const sinceRequest =
    lastRequest === undefined ? Number.POSITIVE_INFINITY : input.nowMS - lastRequest;
  if (sinceRequest < screenShareIceRestartFallbackMS) {
    // The request is still in flight. A failing connection reports both a failed
    // connection state and a failed ICE state, so this branch is reached a second
    // time almost immediately; rebuilding here would tear down the connection we
    // are trying to save. The fallback timer scheduled with the request already
    // covers the sharer-ignored-it case.
    return { action: "hold" };
  }
  if (sinceRequest < screenShareIceRestartCooldownMS) {
    // The restart was answered (or ignored) and the connection is still failed.
    // Rebuild instead of renegotiating the same broken path again.
    return { action: "rebuild", delayMS: screenShareRebuildDelayMS };
  }
  return { action: "request-ice-restart", fallbackDelayMS: screenShareIceRestartFallbackMS };
}
