// Which network path a watched screen share is actually using.
//
// The viewer can only learn this from the ICE candidate pair that won, and the
// answer decides what to do about a bad picture: a relayed share pays for a
// server hop and a shared uplink, so its ceiling is the TURN port pool, while a
// direct share is limited by the two endpoints alone. Without this reading a
// "why is it blurry" report cannot be told apart from an encoder problem, and
// nothing can be measured about how often sharing escapes to the relay at all.

export type ScreenSharePathKind = "direct" | "relay" | "unknown";

/**
 * Classify the candidate pair that carries the media.
 *
 * One relay candidate is enough to call the pair relayed: the hop is paid for
 * even when the other end gathered a host candidate. Anything short of two
 * known candidate types stays unknown instead of guessing "direct", because a
 * missing sample is not evidence of a direct path - and "we cannot tell" is the
 * reading that must never be reported as "peer to peer works".
 */
export function screenSharePathKind(
  localCandidateType: string | undefined,
  remoteCandidateType: string | undefined
): ScreenSharePathKind {
  const local = normalizeCandidateType(localCandidateType);
  const remote = normalizeCandidateType(remoteCandidateType);
  if (local === "relay" || remote === "relay") return "relay";
  if (!local || !remote) return "unknown";
  return "direct";
}

/**
 * Resolve the pair's candidate types through the same stats report that
 * described the pair, so a stale candidate list can never be matched to a pair
 * from a later connection.
 */
export function screenSharePathKindFromStats(
  stats: { get(id: string): unknown },
  pair: { localCandidateId?: string; remoteCandidateId?: string }
): ScreenSharePathKind {
  const local = pair.localCandidateId ? stats.get(pair.localCandidateId) : undefined;
  const remote = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : undefined;
  return screenSharePathKind(candidateTypeOf(local), candidateTypeOf(remote));
}

export type ScreenShareCandidatePairReport = {
  type?: string;
  state?: string;
  nominated?: boolean;
  bytesSent?: number;
  bytesReceived?: number;
  localCandidateId?: string;
  remoteCandidateId?: string;
};

export type ScreenShareCandidatePair = {
  localCandidateId?: string;
  remoteCandidateId?: string;
};

/**
 * Pick the candidate pair that actually carries media.
 *
 * A peer connection reports every pair it tried, most of them dead. The one
 * that matters is the nominated or succeeded pair with the most traffic in the
 * direction being measured: the sender counts bytes it sent, the receiver counts
 * bytes it received. Selecting by the wrong direction picks a background
 * connectivity check and reports a path the media never used.
 */
export function selectScreenShareCandidatePair(
  reports: Iterable<ScreenShareCandidatePairReport>,
  direction: "incoming" | "outgoing"
): { pair: ScreenShareCandidatePair; bytes: number } | undefined {
  let best: { pair: ScreenShareCandidatePair; bytes: number } | undefined;
  for (const report of reports) {
    if (report.type !== "candidate-pair") continue;
    if (report.state !== "succeeded" && report.nominated !== true) continue;
    const bytes = (direction === "outgoing" ? report.bytesSent : report.bytesReceived) ?? 0;
    if (best && bytes <= best.bytes) continue;
    best = {
      pair: {
        localCandidateId: report.localCandidateId,
        remoteCandidateId: report.remoteCandidateId
      },
      bytes
    };
  }
  return best;
}

/**
 * Translation key for the path name shown next to the playback status, or
 * undefined when the path is not known well enough to name. Kept next to the
 * classifier so the label can never claim a path the classifier would not.
 */
export function screenSharePathLabelKey(
  pathKind: ScreenSharePathKind | undefined
): "screenShare.pathDirect" | "screenShare.pathRelay" | undefined {
  if (pathKind === "direct") return "screenShare.pathDirect";
  if (pathKind === "relay") return "screenShare.pathRelay";
  return undefined;
}

/**
 * Suffix appended to a watch status line. "checking" is a real state, not a
 * placeholder: the selected pair is unknown until ICE succeeds, and a share
 * that never starts is exactly the moment the path is being asked about.
 */
export function screenSharePathStatusSuffix(
  pathKind: ScreenSharePathKind | undefined,
  translate: (key: string) => string
): string {
  const key = screenSharePathLabelKey(pathKind);
  return ` · ${translate(key ?? "screenShare.pathProbing")}`;
}

function candidateTypeOf(report: unknown): string | undefined {
  if (!report || typeof report !== "object") return undefined;
  const value = (report as { candidateType?: unknown }).candidateType;
  return typeof value === "string" ? value : undefined;
}

function normalizeCandidateType(value: string | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
