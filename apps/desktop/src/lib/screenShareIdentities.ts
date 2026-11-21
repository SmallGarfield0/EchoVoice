// Identity resolution for the screen share mesh.
//
// Three different ids travel through this feature and the peer connection map
// is keyed by exactly one of them:
//
//   member_id        stable for the whole workspace session; what the session
//                    list, viewer list and permission checks use.
//   participant_id   minted when a member joins a voice channel; what
//                    `screenSharePeerConnections` is keyed by, because that is
//                    what the signaling envelope carries as the peer address.
//   share_id         identifies one published share.
//
// Getting this wrong is silent: `closeScreenSharePeerConnection()` resolves the
// identity first and returns early when the lookup misses, so a wrong id leaves
// a live peer connection behind without any error. These helpers keep the rules
// in one place and are unit tested with plain lookups.

export type ScreenShareOwner = {
  owner_member_id: string;
  owner_participant_id?: string | null;
};

export type ScreenShareIdentityLookups = {
  /** True when a peer connection is already registered under this exact key. */
  hasConnection: (peerId: string) => boolean;
  /** The participant id of a member currently in the voice channel, if any. */
  participantIdForMember: (memberId: string) => string | undefined;
  /** The member id behind a participant id, if that participant is still known. */
  memberIdForParticipant: (participantId: string) => string | undefined;
  /** The member id publishing a share whose owner participant id is this one. */
  memberIdForOwnerParticipant: (participantId: string) => string | undefined;
};

/**
 * The key a share's peer connection is registered under.
 *
 * The owner participant id wins because that is what the signaling envelope
 * carries; the member id is only the fallback for a share that has not been
 * bound to a voice participant yet.
 */
export function screenShareOwnerPeerId(
  share: ScreenShareOwner,
  lookups: Pick<ScreenShareIdentityLookups, "participantIdForMember">
): string {
  return (
    share.owner_participant_id ||
    lookups.participantIdForMember(share.owner_member_id) ||
    share.owner_member_id
  );
}

/**
 * Resolve whatever identity a caller has into the peer connection key.
 *
 * Order matters: an exact hit is already a key (participant id), then a member
 * id is translated through the voice state, and only then is the input handed
 * back untouched so the caller's own "not connected" handling still sees it.
 */
export function screenSharePeerIdForIdentity(
  identity: string,
  lookups: Pick<
    ScreenShareIdentityLookups,
    "hasConnection" | "participantIdForMember"
  > & {
    /** The peer id of a share published by this member, if one exists. */
    peerIdForMemberShare?: (memberId: string) => string | undefined;
  }
): string {
  if (lookups.hasConnection(identity)) return identity;
  const ownedPeerId = lookups.peerIdForMemberShare?.(identity);
  if (ownedPeerId) return ownedPeerId;
  return lookups.participantIdForMember(identity) ?? identity;
}

/**
 * The member id behind a peer connection key, for anything user facing
 * (avatars, display names, viewer lists).
 */
export function screenShareMemberIdForPeer(
  peerId: string,
  lookups: Pick<
    ScreenShareIdentityLookups,
    "memberIdForParticipant" | "memberIdForOwnerParticipant"
  >
): string {
  return (
    lookups.memberIdForParticipant(peerId) ??
    lookups.memberIdForOwnerParticipant(peerId) ??
    peerId
  );
}
