/**
 * One ICE/peer-connection configuration for every browser RTCPeerConnection the
 * app creates (voice, screen share, local preview).
 *
 * Two properties matter for the self-hosted TURN server this app ships with:
 *
 * - `bundlePolicy: "max-bundle"` puts every m-line of a peer connection on one
 *   ICE transport. A screen-share connection carries video *and* sharing audio,
 *   so bundling keeps it to a single TURN allocation (and a single candidate
 *   pair to keep alive) instead of one per media section. That matters because
 *   the relay port range is small and every allocation consumes one port.
 * - Deliberately no `iceCandidatePoolSize`. Pre-gathering allocates TURN ports
 *   before they are needed and holds them for idle peer connections, which
 *   works directly against the same small relay port range. Trickle ICE already
 *   gets candidates out within a few milliseconds.
 */

export type BrowserRTCIceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export function browserRTCConfiguration(servers: readonly BrowserRTCIceServer[]): RTCConfiguration {
  return {
    iceServers: servers.map((server) => ({
      urls: server.urls,
      username: server.username,
      credential: server.credential
    })),
    bundlePolicy: "max-bundle"
  };
}
