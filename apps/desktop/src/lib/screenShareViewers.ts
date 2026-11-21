export interface ScreenShareViewerVoiceState {
  member_id: string;
}

export function staleNativeScreenShareViewerPeerIds(
  registeredPeerIds: Iterable<string>,
  activeWatchPeerIds: Iterable<string>,
  watchingMemberIds: Iterable<string>,
  voiceStatesByParticipant: ReadonlyMap<string, ScreenShareViewerVoiceState>
) {
  const activeWatchers = new Set(activeWatchPeerIds);
  const watching = new Set(watchingMemberIds);
  return [...registeredPeerIds].filter((peerId) => {
    if (activeWatchers.has(peerId)) return false;
    const state = voiceStatesByParticipant.get(peerId);
    return Boolean(state && !watching.has(state.member_id));
  });
}
