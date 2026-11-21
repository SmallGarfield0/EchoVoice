/** The only part of an RTCPeerConnection this decision needs. */
export type ScreenShareReceiverSource = {
  getReceivers: () => ReadonlyArray<{ track?: { kind?: string } | null } | null>;
};

/**
 * True when the connection carries an inbound video track, meaning we are the
 * viewer on it.
 *
 * Two peers that share to each other end up on one connection (the peer
 * connection map is keyed by member), so "I added a video sender" is not enough
 * to call a connection outgoing. The receiver list is.
 */
export function screenSharePeerReceivesVideo(connection: ScreenShareReceiverSource): boolean {
  return connection
    .getReceivers()
    .some((receiver) => receiver?.track?.kind === "video");
}

/** The states that make a send-only share connection worthless to keep. */
export type ScreenShareConnectionStates = {
  connectionState?: string;
  iceConnectionState?: string;
};

/**
 * True when a connection has failed for good.
 *
 * `disconnected` is not included on purpose: it is the state that recovers on
 * its own, and treating it as dead would tear down connections that were about
 * to come back.
 */
export function screenShareConnectionHasFailed(connection: ScreenShareConnectionStates): boolean {
  return connection.connectionState === "failed" || connection.iceConnectionState === "failed";
}

/**
 * True while a connection has not finished connecting yet.
 *
 * A viewer that never completes ICE leaves its connection in `connecting`
 * forever: it never fails, so the failure cleanup never runs, and the encoder
 * behind it keeps producing frames for a peer that never asked for them again.
 */
export function screenShareConnectionIsConnecting(
  connection: ScreenShareConnectionStates
): boolean {
  return (
    connection.connectionState === "new" ||
    connection.connectionState === "connecting" ||
    connection.iceConnectionState === "checking"
  );
}
