// Which member id owns the stream a peer connection delivered.
//
// The renderer and every playback check look a remote screen share up by the
// share owner's member id, while peer connections are keyed by whatever id the
// signalling used (a participant id when the caller had one). Filing the stream
// under the peer key therefore produces the worst possible outcome: the stats
// say frames are decoding while the card, which looks up the owner id, keeps
// showing "waiting". Keep the rule in one place so it can be tested.
export type ScreenShareStreamKeyInput = {
  share?: { share_id: string; owner_member_id: string };
  boundShareId: string;
  fallbackMemberId: string;
};

export function screenShareStreamOwnerMemberId(input: ScreenShareStreamKeyInput): string {
  const share = input.share;
  if (share && input.boundShareId && share.share_id === input.boundShareId) {
    return share.owner_member_id;
  }
  return input.fallbackMemberId;
}
