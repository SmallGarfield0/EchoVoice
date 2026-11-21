import type { ScreenSharePathKind } from "./screenSharePath";

// Only sustained evidence from the network can justify an ICE rebuild. Low
// bitrate on a static desktop and frame drops on a busy decoder are local
// observations that cannot establish the relay will improve delivery.
// The path is chosen once, while the watch is starting, and never changed by the
// client again. Every switch rebuilds the peer connection — new ICE, new DTLS,
// roughly a second of black picture — and the fresh connection starts with a
// cold receiver estimate, so each rebuild also perturbs the bandwidth estimate
// the sender is steering by. Two automatic switches in a row is how a viewer
// ends up watching a direct path, then a relay, then a direct path again for no
// gain. After the startup window the decision belongs to the user, who can pick
// either path explicitly.

export type ScreenSharePathPreference = "auto" | "direct" | "relay";

export type ScreenSharePathSwitchAction = "hold" | "prefer-relay";

export interface ScreenSharePathQualitySample {
  pathKind: ScreenSharePathKind;
  preference: ScreenSharePathPreference;
  /** Difference since the previous sample, not a cumulative counter. */
  packetLossPercent: number;
  jitterMS: number;
  /** When the current run of degraded samples started, if it has. */
  degradedSinceMS?: number;
  nowMS: number;
  /** Time since this watch started; the automatic choice only lives in here. */
  watchingMS: number;
  /** Number of samples already taken in the current run, including this one. */
  degradedSamples: number;
  relaySwitches: number;
}

/** Loss above this share of the window is not normal congestion control. */
export const screenShareLossyPathPercent = 2;
/** Smoothed inter-arrival jitter that a healthy path stays under. */
export const screenShareJitterLimitMS = 40;
/** The degradation has to persist this long before the path is blamed. */
export const screenSharePathSwitchHoldMS = 4_000;
/** Samples needed before a run counts; one bad sample is noise. */
export const screenSharePathSwitchSamples = 3;
/** One switch per share: after that the user decides. */
export const screenShareRelaySwitchesPerShare = 1;
/**
 * How long after a watch starts the client may still change the path by itself.
 * The encode needs a moment to ramp and the receiver estimate to converge, so
 * the window is longer than the degradation hold; it is short enough that a
 * viewer never sees the path change under them mid-watch.
 */
export const screenShareStartupProbeMS = 10_000;
/**
 * How long a relayed rebuild gets to produce a picture before it counts as
 * failure. Long enough to cover ICE + DTLS on a relayed pair, short enough that
 * a viewer does not sit on a black screen.
 */
export const screenShareRelayVerdictMS = 8_000;

/**
 * Relay-only gathering has exactly one way to succeed: a TURN allocation. If the
 * server's TURN port or relay range is not reachable, gathering produces no
 * candidates at all and the connection can never start — the picture is simply
 * black until the watch deadline expires. Waiting is pointless once the machine
 * has had this long to allocate one.
 */
export const screenShareRelayCandidateDeadlineMS = 6_000;

export type ScreenShareRelayAvailability = "wait" | "ok" | "unavailable";

export function screenShareRelayCandidateVerdict(input: {
  preference: ScreenSharePathPreference;
  relayConfigured: boolean;
  relayCandidates: number;
  connected: boolean;
  waitedMS: number;
}): ScreenShareRelayAvailability {
  if (input.preference !== "relay" || !input.relayConfigured) return "ok";
  if (input.connected) return "ok";
  if (input.relayCandidates > 0) return "ok";
  return input.waitedMS >= screenShareRelayCandidateDeadlineMS ? "unavailable" : "wait";
}

/**
 * There is no ICE policy for "never relay", so a viewer that insists on a direct
 * path is given a configuration without TURN servers. A server entry that lists
 * both a TURN and a STUN url keeps the STUN url, so the direct path can still
 * learn its public address from it.
 */
export function screenShareDirectIceServers(
  iceServers: RTCIceServer[] | undefined
): RTCIceServer[] {
  if (!iceServers?.length) return [];
  const direct: RTCIceServer[] = [];
  for (const server of iceServers) {
    const urls = typeof server.urls === "string" ? [server.urls] : server.urls ?? [];
    const kept = urls.filter((url) => !/^\s*turns?:/i.test(url));
    if (!kept.length) continue;
    direct.push({ ...server, urls: kept.length === 1 ? kept[0] : kept });
  }
  return direct;
}

export function screenSharePathQualityIsDegraded(sample: Pick<ScreenSharePathQualitySample, "packetLossPercent" | "jitterMS">): boolean {
  return (Number.isFinite(sample.packetLossPercent) && sample.packetLossPercent >= screenShareLossyPathPercent) ||
    (Number.isFinite(sample.jitterMS) && sample.jitterMS >= screenShareJitterLimitMS);
}

export function decideScreenSharePathSwitch(
  sample: ScreenSharePathQualitySample
): ScreenSharePathSwitchAction {
  if (sample.pathKind === "unknown") return "hold";
  // The decision belongs to the startup window. Outside it the client has no
  // business moving a picture the user is already watching.
  if (sample.watchingMS > screenShareStartupProbeMS) return "hold";
  if (sample.preference !== "auto") return "hold";
  if (sample.relaySwitches >= screenShareRelaySwitchesPerShare) return "hold";
  if (!screenSharePathQualityIsDegraded(sample)) return "hold";
  if (sample.degradedSamples < screenSharePathSwitchSamples) return "hold";
  const heldForMS =
    sample.degradedSinceMS === undefined ? 0 : sample.nowMS - sample.degradedSinceMS;
  if (sample.pathKind !== "direct") return "hold";
  if (heldForMS < screenSharePathSwitchHoldMS) return "hold";
  return "prefer-relay";
}
