// Voice channel state management.
//
// Owns the server-authoritative voice state lists (all visible voice states
// plus the subset of the currently connected channel), the local voice
// connection context, realtime revision bookkeeping, and the refresh/sync
// queues. All mutation flows through the methods below so the workspace
// component only orchestrates transports and UI.
//
// Svelte 5 note: this file uses the .svelte.ts extension so `$state` runes
// work inside a plain class; component templates and `$:` blocks can track
// these fields directly.

import { getVoiceStates, normalizeVoiceState } from "./api";
import type { Channel, RTCIceServer, VoiceState } from "./types";

/** Identifies this client's active voice membership on one server. */
export type VoiceConnectionContext = {
  serverId: string;
  serverName: string;
  baseUrl: string;
  sessionToken: string;
  memberId: string;
  deviceId: string;
  channelId: string;
  channelName: string;
  iceServers: RTCIceServer[];
  syncSupported: boolean;
  state: VoiceState;
};

/**
 * Cross-cutting dependencies injected by the workspace component. Everything
 * the voice state logic needs from transports, UI, or other features flows
 * through these hooks instead of importing the component.
 */
export type VoiceStateHooks = {
  activeServerId: () => string;
  memberId: () => string;
  localProfileId: () => string;
  serverId: () => string;
  serverName: () => string;
  baseUrl: () => string;
  sessionToken: () => string;
  rtcIceServers: () => RTCIceServer[];
  channels: () => Channel[];
  channelNameForDisplay: (channel: Channel) => string;
  micMuted: () => boolean;
  audioDeafened: () => boolean;
  voiceInputUnavailable: () => boolean;
  isSpeaking: () => boolean;
  screenSharePopoutMode: () => boolean;
  playUISound: (name: "channel-join" | "channel-leave") => void;
  setLocalSpeaking: (speaking: boolean) => void;
  queueCurrentVoiceSpeakingState: (force: boolean) => void;
  resetPendingSpeakingState: () => void;
  bumpVoiceMoveSoundGeneration: () => void;
  closeVoiceEventSocket: () => void;
  stopVoiceSession: (options?: { clearVoicePanel?: boolean }) => void;
  scheduleVoiceAutoRejoin: (channelId: string) => void;
  clearVoiceRejoinArmed: () => void;
  ensureCurrentVoiceTransport: (state: VoiceState, restart?: boolean, forceInitiate?: boolean) => Promise<void>;
  ensureVoicePeer: (state: VoiceState, initiate: boolean) => Promise<unknown>;
  closePeerConnection: (participantId: string, memberId: string) => void;
  applyManagedVoiceConstraints: (state: VoiceState) => void;
  voiceTransportActive: () => boolean;
  restartLocalVoiceTransportAfterMove: (state: VoiceState) => void;
  forgetSelectedVoiceParticipant: (participantId: string) => void;
};

/** Prefers a primary (microphone) state over listener duplicates, matching
 * the UI's member-level voice grouping. */
function primaryVoiceState(states: VoiceState[], memberIdValue: string): VoiceState | undefined {
  let found: VoiceState | undefined;
  for (const state of states) {
    if (state.member_id !== memberIdValue) continue;
    if (!found || (found.mode !== "primary" && state.mode === "primary")) found = state;
  }
  return found;
}

export class VoiceStateController {
  // Server-authoritative voice states visible to this member.
  voiceStates = $state<VoiceState[]>([]);
  // Voice states relevant to the channel this device is connected to.
  connectedVoiceStates = $state<VoiceState[]>([]);
  // This device's active voice membership (null when not in voice).
  voiceConnectionContext = $state<VoiceConnectionContext | null>(null);
  // Bumped on every realtime snapshot so stale refreshes can be discarded.
  voiceStateRealtimeRevision = $state(0);
  // Refresh coalescing: one HTTP snapshot at a time, with a queued follow-up.
  refreshTimer = 0;
  refreshQueued = $state(false);
  refreshPromise = $state<Promise<boolean> | null>(null);
  // Local flag synchronization (mute/deafen) coalescing.
  syncInFlight = $state(false);
  syncQueued = $state(false);

  private hooks: VoiceStateHooks;

  constructor(hooks: VoiceStateHooks) {
    this.hooks = hooks;
  }

  /** The current device's own voice state, when connected. */
  currentVoiceState(): VoiceState | null {
    return this.voiceConnectionContext?.state ?? null;
  }

  /**
   * Synchronous lookups for signaling hot paths. The component mirrors these
   * lists into legacy `$:` maps for the UI, but those lag one effect flush
   * behind this rune state; an offer/answer arriving in the same tick must
   * resolve peers through these methods or the signal is dropped.
   */
  voiceStateByParticipant(participantId: string): VoiceState | undefined {
    return this.voiceStates.find((item) => item.participant_id === participantId);
  }

  voiceStateByMember(memberIdValue: string): VoiceState | undefined {
    return primaryVoiceState(this.voiceStates, memberIdValue);
  }

  connectedVoiceStateByParticipant(participantId: string): VoiceState | undefined {
    return this.connectedVoiceStates.find((item) => item.participant_id === participantId);
  }

  connectedVoiceStateByMember(memberIdValue: string): VoiceState | undefined {
    return primaryVoiceState(this.connectedVoiceStates, memberIdValue);
  }

  currentVoiceChannelId(): string {
    const context = this.voiceConnectionContext;
    return context && context.serverId === this.hooks.activeServerId()
      ? (context.state?.channel_id ?? "")
      : "";
  }

  // ---- normalization helpers (pure) ---------------------------------------

  sortVoiceStates(states: VoiceState[]): VoiceState[] {
    return states.sort((left, right) => {
      if (left.channel_id !== right.channel_id) return left.channel_id.localeCompare(right.channel_id);
      return left.participant_id.localeCompare(right.participant_id);
    });
  }

  /**
   * Members in OTHER channels must not render as speaking; the server sends
   * speaking state globally, so the UI restricts it to the visible channel.
   */
  restrictVoiceSpeakingState(state: VoiceState, visibleChannelId: string): VoiceState {
    if (!state.is_speaking || (visibleChannelId && state.channel_id === visibleChannelId)) return state;
    return { ...state, is_speaking: false };
  }

  /**
   * Real-time snapshots briefly drop the speaking flag while the mic keeps
   * running; carry the previous speaking state across that gap.
   */
  preserveRealtimeSpeakingState(state: VoiceState): VoiceState {
    const previous = this.connectedVoiceStates.find((item) => item.participant_id === state.participant_id)
      ?? this.voiceStates.find((item) => item.participant_id === state.participant_id);
    if (
      !previous?.is_speaking ||
      state.is_speaking ||
      previous.channel_id !== state.channel_id ||
      state.mic_muted ||
      state.audio_deafened ||
      state.server_muted ||
      state.server_deafened
    ) return state;
    return { ...state, is_speaking: true };
  }

  // ---- state merging ------------------------------------------------------

  mergeVoiceState(state: VoiceState): void {
    state = normalizeVoiceState(state);
    if (!state?.participant_id || !state.member_id || !state.channel_id) return;
    const visibleSpeakingChannelId = this.voiceConnectionContext?.serverId === this.hooks.activeServerId()
      ? this.voiceConnectionContext.channelId
      : "";
    state = this.restrictVoiceSpeakingState(state, visibleSpeakingChannelId);
    this.voiceStates = this.sortVoiceStates([
      ...this.voiceStates.filter((item) => item.participant_id !== state.participant_id),
      state
    ]);
  }

  mergeConnectedVoiceState(state: VoiceState): void {
    state = normalizeVoiceState(state);
    const context = this.voiceConnectionContext;
    if (!context || !state?.participant_id || !state.member_id || !state.channel_id) return;
    state = this.restrictVoiceSpeakingState(state, context.channelId);
    this.connectedVoiceStates = this.sortVoiceStates([
      ...this.connectedVoiceStates.filter((item) => item.participant_id !== state.participant_id),
      state
    ]);
    if (state.participant_id === context.state.participant_id || (
      state.member_id === context.memberId && state.device_id === context.deviceId
    )) {
      this.voiceConnectionContext = {
        ...context,
        channelId: state.channel_id,
        channelName: this.connectedVoiceChannelName(state.channel_id, context),
        state
      };
      this.hooks.applyManagedVoiceConstraints(state);
    }
    if (this.voiceConnectionContext?.serverId === this.hooks.activeServerId()) this.mergeVoiceState(state);
  }

  removeVoiceState(state: VoiceState): void {
    if (!state?.participant_id) return;
    const removedCurrentDevice =
      state.member_id === this.hooks.memberId() && state.device_id === this.hooks.localProfileId();
    this.voiceStates = this.voiceStates.filter((item) => item.participant_id !== state.participant_id);
    if (removedCurrentDevice) this.clearVoiceSpeakingStates(state.channel_id);
    this.hooks.forgetSelectedVoiceParticipant(state.participant_id);
  }

  /**
   * Removes a state from the connected list. Returns true when the removed
   * state belonged to this device; the caller decides whether the transport
   * must stop (live deletion events) or an automatic rejoin should follow.
   */
  removeConnectedVoiceState(state: VoiceState): boolean {
    const context = this.voiceConnectionContext;
    if (!context || !state?.participant_id) return false;
    this.connectedVoiceStates = this.connectedVoiceStates.filter((item) => item.participant_id !== state.participant_id);
    const removedCurrentDevice = state.participant_id === context.state.participant_id || (
      state.member_id === context.memberId && state.device_id === context.deviceId
    );
    if (context.serverId === this.hooks.activeServerId()) this.removeVoiceState(state);
    if (!removedCurrentDevice) return false;
    this.clearVoiceSpeakingStates(state.channel_id);
    this.hooks.stopVoiceSession({ clearVoicePanel: true });
    this.clearVoiceConnectionContext();
    this.hooks.clearVoiceRejoinArmed();
    return true;
  }

  // ---- speaking-state clearing --------------------------------------------

  clearVoiceSpeakingStates(channelId: string): void {
    if (!channelId) return;
    const clearedLocalChannel = this.voiceConnectionContext?.channelId === channelId;
    this.voiceStates = this.voiceStates.map((state) => {
      if (state.channel_id !== channelId || !state.is_speaking) return state;
      return { ...state, is_speaking: false };
    });
    this.connectedVoiceStates = this.connectedVoiceStates.map((state) =>
      state.channel_id === channelId && state.is_speaking ? { ...state, is_speaking: false } : state
    );
    if (clearedLocalChannel) this.hooks.setLocalSpeaking(false);
  }

  clearAllVoiceSpeakingStates(): void {
    this.voiceStates = this.voiceStates.map((state) =>
      state.is_speaking ? { ...state, is_speaking: false } : state
    );
    this.connectedVoiceStates = this.connectedVoiceStates.map((state) =>
      state.is_speaking ? { ...state, is_speaking: false } : state
    );
    this.hooks.setLocalSpeaking(false);
  }

  // ---- connection context lifecycle ---------------------------------------

  connectedVoiceChannelName(channelId: string, context = this.voiceConnectionContext): string {
    if (!context || context.serverId === this.hooks.activeServerId()) {
      const channel = this.hooks.channels().find((item) => item.channel_id === channelId);
      if (channel) return this.hooks.channelNameForDisplay(channel);
    }
    if (context?.channelId === channelId && context.channelName) return context.channelName;
    return channelId;
  }

  /**
   * Builds the local voice membership from a server-reported state. Called
   * when this device discovers it is already in a channel: initial connect,
   * page reload, or a state event arriving before the context exists.
   */
  establishVoiceConnectionContext(state: VoiceState, snapshot: VoiceState[] = this.voiceStates): void {
    state = normalizeVoiceState(state);
    const serverId = this.hooks.serverId();
    if (!serverId || !this.hooks.sessionToken() || !this.hooks.memberId() || !state?.participant_id) return;
    const previous = this.voiceConnectionContext;
    this.voiceConnectionContext = {
      serverId,
      serverName: this.hooks.serverName(),
      baseUrl: this.hooks.baseUrl(),
      sessionToken: this.hooks.sessionToken(),
      memberId: this.hooks.memberId(),
      deviceId: state.device_id || this.hooks.localProfileId(),
      channelId: state.channel_id,
      channelName: this.connectedVoiceChannelName(state.channel_id, previous),
      iceServers: this.hooks.rtcIceServers().map((item) => ({ ...item, urls: [...item.urls] })),
      syncSupported: previous?.serverId === serverId ? previous.syncSupported : true,
      state
    };
    this.connectedVoiceStates = this.sortVoiceStates(
      snapshot
        .map(normalizeVoiceState)
        .filter((item) => item.participant_id && item.member_id && item.channel_id)
        .map((item) => this.restrictVoiceSpeakingState(item, state.channel_id))
    );
    if (!this.connectedVoiceStates.some((item) => item.participant_id === state.participant_id)) {
      this.connectedVoiceStates = this.sortVoiceStates([...this.connectedVoiceStates, state]);
    }
    this.hooks.resetPendingSpeakingState();
    this.hooks.queueCurrentVoiceSpeakingState(true);
  }

  clearVoiceConnectionContext(): void {
    const context = this.voiceConnectionContext;
    if (context) this.clearVoiceSpeakingStates(context.channelId);
    this.hooks.bumpVoiceMoveSoundGeneration();
    this.voiceConnectionContext = null;
    this.hooks.resetPendingSpeakingState();
    this.clearAllVoiceSpeakingStates();
    this.connectedVoiceStates = [];
    this.syncInFlight = false;
    this.syncQueued = false;
    this.hooks.closeVoiceEventSocket();
  }

  playRemoteVoiceTransition(
    previousState: VoiceState | undefined,
    nextState: VoiceState | undefined,
    localChannelId: string
  ): void {
    const targetMemberId = nextState?.member_id ?? previousState?.member_id ?? "";
    if (!localChannelId || !targetMemberId || targetMemberId === this.voiceConnectionContext?.memberId) return;
    const wasInLocalChannel = previousState?.channel_id === localChannelId;
    const isInLocalChannel = nextState?.channel_id === localChannelId;
    if (!wasInLocalChannel && isInLocalChannel) {
      this.hooks.playUISound("channel-join");
    } else if (wasInLocalChannel && !isInLocalChannel) {
      this.hooks.playUISound("channel-leave");
    }
  }

  // ---- snapshot application -----------------------------------------------

  /**
   * Applies a full server snapshot. Establishes the connection context when
   * this device is in voice but no context exists (reload/reconnect), and
   * tears the session down when our state disappeared server-side.
   */
  replaceVoiceStates(remoteStates: VoiceState[]): void {
    remoteStates = remoteStates.map(normalizeVoiceState).filter((state) => state.participant_id && state.member_id && state.channel_id);
    const context = this.voiceConnectionContext?.serverId === this.hooks.activeServerId() ? this.voiceConnectionContext : null;
    const currentRemoteState = remoteStates.find(
      (state) => state.member_id === (context?.memberId ?? this.hooks.memberId()) &&
        state.device_id === (context?.deviceId ?? this.hooks.localProfileId())
    );
    const visibleSpeakingChannelId = currentRemoteState?.channel_id ?? context?.channelId ?? "";
    remoteStates = remoteStates.map((state) => this.restrictVoiceSpeakingState(state, visibleSpeakingChannelId));
    this.voiceStates = this.sortVoiceStates(remoteStates);
    if (this.voiceConnectionContext?.serverId === this.hooks.activeServerId()) {
      this.replaceConnectedVoiceStates(remoteStates);
      return;
    }
    if (this.voiceConnectionContext) return;
    if (!currentRemoteState) return;
    this.establishVoiceConnectionContext(currentRemoteState, remoteStates);
    this.replaceConnectedVoiceStates(remoteStates);
  }

  replaceConnectedVoiceStates(remoteStates: VoiceState[]): void {
    const context = this.voiceConnectionContext;
    if (!context) return;
    remoteStates = remoteStates.map(normalizeVoiceState).filter((state) => state.participant_id && state.member_id && state.channel_id);
    const currentRemoteState = remoteStates.find(
      (state) => state.member_id === context.memberId && state.device_id === context.deviceId
    );
    const visibleSpeakingChannelId = currentRemoteState?.channel_id ?? context.channelId;
    remoteStates = remoteStates.map((state) => this.restrictVoiceSpeakingState(state, visibleSpeakingChannelId));
    const previousStatesByParticipantAll = new Map(this.connectedVoiceStates.map((state) => [state.participant_id, state]));
    const previousParticipantIds = new Set(this.connectedVoiceStates.map((state) => state.participant_id));
    const remoteParticipantIds = new Set(remoteStates.map((state) => state.participant_id));
    const currentLocalState = context.state;
    const currentLocalChannelId = currentLocalState?.channel_id ?? "";
    const localStateMoved = Boolean(
      currentRemoteState &&
        currentLocalChannelId &&
        currentRemoteState.channel_id !== currentLocalChannelId
    );
    if (localStateMoved) this.clearVoiceSpeakingStates(currentLocalChannelId);
    if (currentLocalChannelId && currentRemoteState?.channel_id === currentLocalChannelId) {
      const previousStatesByParticipant = new Map(this.connectedVoiceStates.map((state) => [state.participant_id, state]));
      const remoteStatesByParticipant = new Map(remoteStates.map((state) => [state.participant_id, state]));
      const changedParticipantIds = new Set([
        ...previousStatesByParticipant.keys(),
        ...remoteStatesByParticipant.keys()
      ]);
      for (const changedParticipantId of changedParticipantIds) {
        this.playRemoteVoiceTransition(
          previousStatesByParticipant.get(changedParticipantId),
          remoteStatesByParticipant.get(changedParticipantId),
          currentLocalChannelId
        );
      }
    }
    const nextStates = remoteStates.map((state) =>
      state.participant_id === currentLocalState?.participant_id
        ? {
            ...state,
            mic_muted: this.hooks.micMuted() || this.hooks.audioDeafened() || this.hooks.voiceInputUnavailable() || state.server_muted || state.server_deafened,
            audio_deafened: this.hooks.audioDeafened() || state.server_deafened,
            is_speaking: this.hooks.isSpeaking() && !this.hooks.micMuted() && !this.hooks.audioDeafened() && !state.server_muted && !state.server_deafened
          }
        : state
    );
    this.connectedVoiceStates = this.sortVoiceStates(nextStates);
    if (currentRemoteState) {
      this.voiceConnectionContext = {
        ...context,
        channelId: currentRemoteState.channel_id,
        channelName: this.connectedVoiceChannelName(currentRemoteState.channel_id, context),
        state: this.connectedVoiceStates.find((state) => state.participant_id === currentRemoteState.participant_id)
          ?? currentRemoteState
      };
      this.hooks.applyManagedVoiceConstraints(currentRemoteState);
    }
    if (context.serverId === this.hooks.activeServerId()) this.voiceStates = [...this.connectedVoiceStates];

    for (const participantIDToClose of previousParticipantIds) {
      if (participantIDToClose !== currentLocalState?.participant_id && !remoteParticipantIds.has(participantIDToClose)) {
        const previous = previousStatesByParticipantAll.get(participantIDToClose);
        this.hooks.closePeerConnection(participantIDToClose, previous?.member_id ?? participantIDToClose);
      }
    }
    if (this.hooks.screenSharePopoutMode()) return;
    if (currentLocalChannelId && !currentRemoteState) {
      this.hooks.stopVoiceSession({ clearVoicePanel: true });
      this.clearVoiceConnectionContext();
      this.hooks.scheduleVoiceAutoRejoin(currentLocalChannelId);
      return;
    }
    if (currentRemoteState && localStateMoved) {
      this.hooks.restartLocalVoiceTransportAfterMove(currentRemoteState);
      return;
    }
    if (currentRemoteState && !this.hooks.voiceTransportActive()) {
      // Establishing transport from server-discovered state means this page
      // reloaded or returned to the tab. Force the offer so the remote side
      // cannot keep waiting on a connection that died with the old page.
      void this.hooks.ensureCurrentVoiceTransport(currentRemoteState, false, true);
    }
    const activeState = this.currentVoiceState();
    if (!activeState) return;
    for (const state of remoteStates) {
      if (state.participant_id === activeState.participant_id || state.channel_id !== activeState.channel_id) continue;
      void this.hooks.ensureVoicePeer(state, activeState.participant_id < state.participant_id);
    }
  }

  // ---- HTTP refresh --------------------------------------------------------

  /**
   * Fetches the authoritative voice state snapshot. Coalesces concurrent
   * requests and re-runs once when a refresh was queued while one was in
   * flight, so slow networks cannot silently drop the newest snapshot.
   */
  async refreshVoiceStates(requireFreshSnapshot = false): Promise<boolean> {
    const sessionToken = this.hooks.sessionToken();
    if (!sessionToken) return false;
    if (requireFreshSnapshot) {
      while (this.refreshPromise) {
        await this.refreshPromise;
      }
    } else if (this.refreshPromise) {
      this.refreshQueued = true;
      return this.refreshPromise;
    }

    const requestBaseUrl = this.hooks.baseUrl();
    const requestRealtimeRevision = this.voiceStateRealtimeRevision;
    const request = (async () => {
      try {
        const remoteStates = await getVoiceStates(requestBaseUrl, sessionToken);
        if (
          this.hooks.sessionToken() !== sessionToken ||
          this.hooks.baseUrl() !== requestBaseUrl
        ) return false;
        // Incremental events (e.g. voice.speaking.updated) bump the revision
        // while a snapshot is in flight. A plain coalesced refresh may defer
        // to that newer event, but an explicit fresh snapshot (reconnect,
        // rejoin, browser return) must stay authoritative or the teardown and
        // automatic rejoin could be skipped forever while peers keep talking.
        if (!requireFreshSnapshot && this.voiceStateRealtimeRevision !== requestRealtimeRevision) return false;
        this.replaceVoiceStates(remoteStates);
        return true;
      } catch {
        // WebSocket remains the primary source; polling failures should not interrupt chat or voice.
        return false;
      }
    })();
    this.refreshPromise = request;
    try {
      return await request;
    } finally {
      if (this.refreshPromise === request) {
        this.refreshPromise = null;
        if (this.refreshQueued) {
          this.refreshQueued = false;
          void this.refreshVoiceStates();
        }
      }
    }
  }
}
