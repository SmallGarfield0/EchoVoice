/**
 * The viewer's own path choice, carried to the sharer as a signal.
 *
 * It exists for one measurable reason: webrtc-ice waits a full second before it
 * may nominate a pair whose candidate type is "relay", and that wait is applied
 * to both ends of the pair. A viewer that chose the relay sends nothing but
 * relay candidates, so the sharer spends that second before it can nominate -
 * and DTLS cannot begin until it does. That second is the difference between a
 * path switch that feels instant and one that shows a black screen.
 *
 * The hint is one-shot on purpose: it describes the next watch, not the member
 * forever. A viewer that goes back to automatic comes back through "direct" and
 * simply drops the hint.
 */
export type ScreenSharePathHint = "direct" | "relay";

const hints = new Map<string, ScreenSharePathHint>();

function hintKey(shareId: string, memberId: string): string {
  return `${shareId}\u0000${memberId}`;
}

export function rememberScreenSharePathHint(
  shareId: string,
  memberId: string,
  hint: ScreenSharePathHint
): void {
  if (!shareId || !memberId) return;
  hints.set(hintKey(shareId, memberId), hint);
}

/** Reads and clears the hint: the watch that follows consumes it exactly once. */
export function takeScreenSharePathHint(
  shareId: string,
  memberId: string
): ScreenSharePathHint | undefined {
  const key = hintKey(shareId, memberId);
  const hint = hints.get(key);
  if (hint !== undefined) hints.delete(key);
  return hint;
}

/** Only a relay-only watch can be handed a shorter ICE acceptance wait. */
export function screenSharePathHintIsRelayOnly(hint: ScreenSharePathHint | undefined): boolean {
  return hint === "relay";
}
