/**
 * Relay credentials carry an expiry, and the TURN server re-checks it on every
 * allocation refresh (pion's `LongTermTURNRESTAuthHandler` rejects a username
 * whose timestamp has passed, on Refresh exactly like on Allocate). A relayed
 * pair therefore dies of old age: the allocation stops being refreshed and the
 * viewer freezes with no local error, minutes after a two hour share started.
 *
 * There is no way to re-authenticate an allocation in place, so a relayed
 * connection has to be rebuilt on fresh credentials before they expire. This
 * module only answers "is it time to rebuild this one"; the transport rebuilds
 * through the same reconnect path used for stalls, which already re-asks the
 * sharer for a fresh watch and re-checks the ICE configuration first.
 */

/** The TURN REST credential lifetime the server issues (two hours). */
export const screenShareCredentialLifetimeMS = 2 * 60 * 60 * 1000;

/** Rebuild this long before the credential expires, not after. */
export const screenShareRelayRotationLeadMS = 15 * 60 * 1000;

/** Spread simultaneous viewers over a minute instead of freezing them at once. */
export const screenShareRelayRotationSpreadWindowMS = 60 * 1000;

/**
 * A rebuild is only useful if it can obtain fresh credentials. When refreshing
 * fails the credential timestamp does not move, so without this floor every
 * stats tick would rebuild again on a server that is temporarily unreachable.
 */
export const screenShareRelayRotationMinIntervalMS = 15 * 60 * 1000;

export type ScreenShareRelayRotationInput = {
  nowMS: number;
  pathKind: string;
  credentialFetchedAtMS: number;
  lastRotationAtMS?: number;
  spreadMS?: number;
};

export function screenShareRelayRotationDue(input: ScreenShareRelayRotationInput): boolean {
  if (input.pathKind !== "relay") return false;
  if (!Number.isFinite(input.nowMS)) return false;
  if (!Number.isFinite(input.credentialFetchedAtMS) || input.credentialFetchedAtMS <= 0) return false;

  const lastRotationAtMS = input.lastRotationAtMS;
  if (
    lastRotationAtMS !== undefined &&
    (!Number.isFinite(lastRotationAtMS) ||
      input.nowMS - lastRotationAtMS < screenShareRelayRotationMinIntervalMS)
  ) {
    return false;
  }

  const spreadMS = Number.isFinite(input.spreadMS ?? Number.NaN)
    ? Math.max(0, Math.min(input.spreadMS ?? 0, screenShareRelayRotationSpreadWindowMS))
    : 0;
  const dueAtMS =
    input.credentialFetchedAtMS +
    screenShareCredentialLifetimeMS -
    screenShareRelayRotationLeadMS +
    spreadMS;
  return input.nowMS >= dueAtMS;
}

/**
 * A stable delay per peer so ten relayed viewers do not all rebuild inside the
 * same second. Same input always gives the same offset, which keeps the
 * decision testable.
 */
export function screenShareRelayRotationSpreadMS(peerId: string): number {
  let hash = 0;
  for (let index = 0; index < peerId.length; index += 1) {
    hash = (hash * 31 + peerId.charCodeAt(index)) % 1_000_003;
  }
  return hash % screenShareRelayRotationSpreadWindowMS;
}
