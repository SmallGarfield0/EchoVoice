// Realtime transport & server-event dispatch.
//
// Owns the workspace + voice WebSocket lifecycles, presence/voice heartbeats,
// reconnect/session recovery bookkeeping, window visibility recovery, the
// voice-state refresh loop, the native local screen-share preview transport,
// and the authoritative server-event dispatch that fans events out to every
// domain controller.
//
// Cross-cutting side effects never import the workspace component: every
// domain (voice, channels, messages, files, roles, screen share, remote
// control, accompaniment, soundboard, emoji, server rail) is reached through
// lazy arrow hooks, so construction order cannot throw TDZ errors.
//
// Hot-path discipline: signaling and event handlers read controller state
// directly. The component's `$:` aliases only feed templates and may lag one
// effect flush behind the runes.

import {
  normalizeMemberMergeRequest,
  normalizeVoiceState,
  openEventSocket,
  parseServerEvent,
  refreshSession
} from "./api";
import { mergeSyncableProfileFromMember } from "./profile-sync";
import { reconnectDelayMS } from "./reconnect-policy";
import { staleNativeScreenShareViewerPeerIds } from "./screenShareViewers";
import {
  addNativeScreenShareSenderViewer,
  handleNativeScreenShareSenderSignal,
  isTauriRuntime,
  loadCredential,
  loadServers,
  removeNativeScreenShareSenderViewer,
  saveCredential,
  saveLocalUserProfile,
  saveServer,
  setNativeScreenShareSenderPreviewEnabled
} from "./storage";
import type { VoiceStateController } from "./voice-state.svelte";
import type {
  AccompanimentSession,
  Channel,
  ChannelFileEntry,
  ChannelPermissionOverride,
  CustomEmoji,
  LocalUserProfile,
  Member,
  MemberMergeRequest,
  Message,
  NativeScreenShareOutboundSignal,
  NativeScreenShareSenderSession,
  NativeScreenShareSenderStatus,
  NativeVoiceSession,
  RemoteControlInput,
  RemoteControlSession,
  RTCSignal,
  ScreenShareSession,
  ServerEvent,
  ServerRole,
  ServerSummary,
  SoundboardItem,
  SoundboardPlayback,
  StoredCredential,
  StoredServer,
  VoiceState
} from "./types";

const nativeLocalScreenSharePreviewViewerId = "__echovoice_local_preview__";

function withoutSetValue<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  next.delete(value);
  return next;
}

type TranslateParams = Record<string, string | number>;

/**
 * Cross-domain dependencies injected by the workspace component. Each hook is
 * a lazy closure so RealtimeController can be constructed before or after the
 * domain controllers it fans events out to.
 */
export type RealtimeHooks = {
  // Workspace session / connection state.
  activeServerId: () => string;
  memberId: () => string;
  baseUrl: () => string;
  sessionToken: () => string;
  server: () => ServerSummary | null;
  setServer: (server: ServerSummary | null) => void;
  storedCredential: () => StoredCredential | null;
  setStoredCredential: (credential: StoredCredential | null) => void;
  localUserProfile: () => LocalUserProfile;
  setLocalUserProfile: (profile: LocalUserProfile) => void;
  setProfileDraft: (profile: LocalUserProfile) => void;
  setDisplayName: (name: string) => void;
  setMemberId: (memberId: string) => void;
  setSessionToken: (token: string) => void;
  setIsOwner: (isOwner: boolean) => void;
  setServerReportedClientUpdateRequired: (value: boolean) => void;
  error: () => string;
  setError: (message: string) => void;
  setStatusKey: (key: string) => void;
  translate: (key: string, params?: TranslateParams) => string;
  connectionFailureMessage: (caught: unknown, signal?: AbortSignal) => string;
  showWorkspaceReconnect: (serverId: string, message: string) => void;
  workspaceReconnectRequired: () => boolean;
  setWorkspaceReconnectRequired: (value: boolean) => void;
  setWorkspaceReconnectBusy: (value: boolean) => void;
  setWorkspaceConnectionError: (message: string) => void;
  normalizeStoredCredential: (credential: StoredCredential) => StoredCredential;
  reconnectToServer: (credential: StoredCredential | null, externalSignal?: AbortSignal) => Promise<void>;
  savedServers: () => StoredServer[];
  setSavedServers: (servers: StoredServer[]) => void;
  /** Bumps the component's realtimeSyncTick so template aliases refresh. */
  flushAliases: () => void;

  // Voice / audio transport hooks.
  voiceState: () => VoiceStateController;
  currentVoiceState: () => VoiceState | null;
  localVoiceStream: () => MediaStream | null;
  nativeVoiceSession: () => NativeVoiceSession | null;
  micMuted: () => boolean;
  audioDeafened: () => boolean;
  voiceInputUnavailable: () => boolean;
  isSpeaking: () => boolean;
  voiceActionBusy: () => boolean;
  voiceConnectionStatus: () => "idle" | "connecting" | "connected" | "failed";
  ensureCurrentVoiceTransport: (state: VoiceState, restart?: boolean, forceInitiate?: boolean) => Promise<void>;
  ensureVoicePeer: (state: VoiceState, initiate: boolean) => Promise<unknown>;
  connectVoicePeers: (channelId: string, forceInitiate: boolean) => Promise<void>;
  joinVoiceRoom: (channelId: string, options?: { silent?: boolean }) => Promise<void>;
  applyMemberVolume: (memberId: string) => void;
  closePeerConnection: (participantId: string, memberId: string) => void;
  voiceTransportActive: () => boolean;
  resumeRemoteAudioPlayback: () => void;
  resumeSuspendedVoiceInputContexts: () => void;
  playUISound: (name: "channel-join" | "channel-leave") => void;
  showAppAlert: (message: string, options?: { title?: string }) => Promise<void>;
  bumpVoiceMoveSoundGeneration: () => number;
  voiceMoveSoundGeneration: () => number;
  enqueueVoiceSignal: (signal: RTCSignal) => Promise<void>;

  // Screen share / remote control hooks.
  screenShareSessions: () => ScreenShareSession[];
  remoteControlSessions: () => RemoteControlSession[];
  focusedScreenShareId: () => string;
  screenShareRefreshSessions: () => Promise<void>;
  screenShareEnqueueSignal: (signal: RTCSignal) => void;
  screenShareIsDuplicateMediaSignal: (signal: RTCSignal) => boolean;
  screenShareMergeSession: (session: ScreenShareSession) => void;
  screenShareReplaceSessions: (sessions: ScreenShareSession[]) => void;
  screenShareRemoveSession: (session: ScreenShareSession) => void;
  screenShareWatcherSessionIds: () => Map<string, string>;
  syncViewerScreenShareSignalPolling: () => void;
  flushPendingVoiceOutboundSignals: () => void;
  flushPendingMessages: () => Promise<void>;
  refreshCurrentChannelMessages: () => Promise<void>;
  recoverScreenShareWatchesAfterReconnect: () => Promise<void>;
  remoteControlRefreshSessions: () => Promise<void>;
  remoteControlHeartbeatActive: () => Promise<void>;
  remoteControlMergeSession: (control: RemoteControlSession) => void;
  remoteControlHandleInput: (input: RemoteControlInput) => void;
  accompanimentRefreshSessions: () => Promise<void>;
  accompanimentMergeSession: (session: AccompanimentSession) => void;
  accompanimentRemoveSession: (session: AccompanimentSession) => void;
  accompanimentResumeAfterBrowserReturn: () => void;

  // Channel / message / file / permission dispatch hooks.
  channels: () => Channel[];
  isVoiceChannel: (channel: Channel) => boolean;
  mergeChannel: (channel: Channel) => void;
  applyVisibleChannelSnapshot: (channels: Channel[]) => void;
  removeChannel: (channel: Channel) => void;
  selectedChannelId: () => string;
  members: () => Member[];
  setMembers: (members: Member[]) => void;
  mergeMessage: (message: Message) => void;
  mergeMessages: (messages: Message[]) => void;
  removeMessage: (message: Message) => void;
  currentChannelNewMessageCount: () => number;
  setCurrentChannelNewMessageCount: (count: number) => void;
  currentChannelNewMessageStartId: () => string;
  setCurrentChannelNewMessageStartId: (messageId: string) => void;
  isMessageListNearBottom: () => boolean;
  scrollMessagesToBottom: () => Promise<void>;
  incrementUnread: (channelId: string) => void;
  mergeFileEntry: (entry: ChannelFileEntry) => void;
  removeFileEntry: (entry: ChannelFileEntry) => void;
  selectedPermissionChannelId: () => string;
  mergeChannelPermissionOverride: (override: ChannelPermissionOverride) => void;
  removeChannelPermissionOverride: (override: ChannelPermissionOverride) => void;
  mergeRole: (role: ServerRole) => void;
  removeRole: (role: ServerRole) => void;
  sortRoles: (roles: ServerRole[]) => ServerRole[];
  replaceRoles: (roles: ServerRole[]) => void;
  ensureSelectedRole: () => void;
  channelContentMode: () => "chat" | "files" | "voice" | "category";
  clearFileView: () => void;
  renderComposerEditor: (content: string) => void;
  composerDraft: () => string;

  // Server settings / profile hooks.
  serverSettingsOpen: () => boolean;
  serverSettingsTab: () => string;
  serverSettingsDirty: () => boolean;
  setServerSettingsDraft: (draft: ServerSummary) => void;
  syncSavedServerSummary: (summary: ServerSummary) => Promise<void>;

  // Member merge event hooks.
  memberMergeIncoming: () => MemberMergeRequest[];
  setMemberMergeIncoming: (requests: MemberMergeRequest[]) => void;
  memberMergeOutgoing: () => MemberMergeRequest[];
  setMemberMergeOutgoing: (requests: MemberMergeRequest[]) => void;
  memberMergePromptRequestID: () => string;
  setMemberMergePromptResolvedExternally: (value: boolean) => void;
  appDialogHasMemberCard: () => boolean;
  settleAppDialog: (result: boolean | string | null) => void;
  mergeMemberMergeRequest: (items: MemberMergeRequest[], request: MemberMergeRequest) => MemberMergeRequest[];
  processNextMemberMergePrompt: () => Promise<void>;

  // Soundboard / emoji dispatch hooks.
  soundboardHandleServerDisabled: () => void;
  soundboardMergeItem: (item: SoundboardItem) => void;
  soundboardRemoveItem: (item: SoundboardItem) => void;
  soundboardHandlePlayback: (playback: SoundboardPlayback) => Promise<void>;
  emojiHandleServerDisabled: () => void;
  emojiRefreshItems: (downloadLarge: boolean) => Promise<void>;
  emojiSyncCurrentLibrary: () => void;
  emojiMergeItem: (item: CustomEmoji) => void;
  emojiRemoveItem: (item: CustomEmoji) => void;

  // Native screen-share preview state (owned by the workspace component).
  nativeDesktopRuntime: () => boolean;
  localScreenSharePreviewRenderingEnabled: () => boolean;
  setLocalScreenSharePreviewRenderingEnabled: (enabled: boolean) => void;
  localScreenShareVideoElement: () => HTMLVideoElement | null;
  focusedScreenShareVideoElement: () => HTMLVideoElement | null;
  nativeScreenShareSenderSession: () => NativeScreenShareSenderSession | null;
  nativeLocalScreenSharePreviewRequested: () => boolean;
  setNativeLocalScreenSharePreviewRequested: (value: boolean) => void;
  nativeLocalScreenSharePreviewStarting: () => boolean;
  setNativeLocalScreenSharePreviewStarting: (value: boolean) => void;
  nativeLocalScreenSharePreviewError: () => string;
  setNativeLocalScreenSharePreviewError: (message: string) => void;
  nativeLocalScreenSharePreviewSessionId: () => string;
  setNativeLocalScreenSharePreviewSessionId: (sessionId: string) => void;
  nativeLocalScreenSharePreviewWatchSessionId: () => string;
  setNativeLocalScreenSharePreviewWatchSessionId: (watchSessionId: string) => void;
  nativeLocalScreenSharePreviewGeneration: () => number;
  setNativeLocalScreenSharePreviewGeneration: (generation: number) => void;
  nativeLocalScreenSharePreviewConnection: () => RTCPeerConnection | null;
  setNativeLocalScreenSharePreviewConnection: (connection: RTCPeerConnection | null) => void;
  nativeLocalScreenSharePreviewStream: () => MediaStream | null;
  setNativeLocalScreenSharePreviewStream: (stream: MediaStream | null) => void;
  pendingNativeLocalScreenSharePreviewCandidates: () => RTCIceCandidateInit[];
  setPendingNativeLocalScreenSharePreviewCandidates: (candidates: RTCIceCandidateInit[]) => void;
  nativeScreenSharePreviewSyncGeneration: () => number;
  setNativeScreenSharePreviewSyncGeneration: (generation: number) => void;
  nativeScreenSharePreviewSyncTail: () => Promise<void>;
  setNativeScreenSharePreviewSyncTail: (tail: Promise<void>) => void;
  nativeScreenShareStatusRefreshError: () => string;
  setNativeScreenShareStatusRefreshError: (message: string) => void;
  nativeScreenShareSenderStatus: () => NativeScreenShareSenderStatus | null;
  setNativeScreenShareSenderStatus: (status: NativeScreenShareSenderStatus | null) => void;
  nativeScreenShareRegisteredViewerIds: () => Set<string>;
  setNativeScreenShareRegisteredViewerIds: (ids: Set<string>) => void;
  nativeScreenShareAppliedAnswerMemberIds: () => Set<string>;
  setNativeScreenShareAppliedAnswerMemberIds: (ids: Set<string>) => void;
  applyNativeScreenShareSenderStatus: (
    value: NativeScreenShareSenderStatus | Record<string, unknown> | null | undefined
  ) => boolean;
  configureScreenShareReceiver: (receiver: RTCRtpReceiver) => void;
  browserRTCConfiguration: () => RTCConfiguration;
  forwardNativeScreenShareSenderSignals: (sessionId: string) => Promise<void>;
  scheduleNativeScreenShareSignalFlush: (sessionId: string) => void;
  screenShareDataWatchSessionId: (data: unknown) => string;
};

type EventConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

export class RealtimeController {
  eventSocket = $state<WebSocket | null>(null);
  eventConnectionStatus = $state<EventConnectionStatus>("idle");

  private voiceEventSocket: WebSocket | null = null;
  private voiceEventSocketServerId = "";
  private voiceEventReconnectTimer: number | undefined;
  private voiceEventHeartbeatTimer: number | undefined;
  private voiceEventReconnectAttempts = 0;
  private pendingVoiceSpeakingState: {
    serverId: string;
    participantId: string;
    isSpeaking: boolean;
  } | null = null;
  private lastSentVoiceSpeakingSignature = "";
  private eventReconnectTimer: number | undefined;
  private presenceHeartbeatTimer: number | undefined;
  private eventReconnectAttempts = 0;
  private recoverRealtimePromise: Promise<void> | null = null;
  private recoverRealtimeQueued = false;
  // Rejoin bookkeeping: only rejoin a voice channel when the loss of our own
  // voice state is discovered while recovering from a reconnect or a browser
  // return, never when the server removed it while we stayed online.
  private voiceRejoinArmedForChannelId = "";
  private pendingVoiceAutoRejoinChannelId = "";
  private voiceAutoRejoinInFlight = false;
  private sessionRecoveryPromise: Promise<void> | null = null;
  private sessionRecoveryShowFailure = false;

  constructor(private hooks: RealtimeHooks) {}

  // ---- workspace event socket ------------------------------------------------

  connectEventSocket(): void {
    this.closeEventSocket();
    if (!this.hooks.sessionToken()) return;
    this.eventConnectionStatus = this.eventReconnectAttempts > 0 ? "reconnecting" : "connecting";
    const socket = openEventSocket(this.hooks.baseUrl(), this.hooks.sessionToken());
    this.eventSocket = socket;
    socket.onopen = () => {
      if (this.eventSocket !== socket) return;
      this.eventReconnectAttempts = 0;
      this.eventConnectionStatus = "connected";
      const voiceState = this.hooks.voiceState();
      if (voiceState.voiceConnectionContext?.serverId === this.hooks.activeServerId()) {
        this.closeVoiceEventSocket();
      }
      this.hooks.syncViewerScreenShareSignalPolling();
      this.hooks.flushPendingVoiceOutboundSignals();
      this.queueCurrentVoiceSpeakingState(true);
      void this.hooks.flushPendingMessages();
      void this.hooks.refreshCurrentChannelMessages();
      void this.hooks.recoverScreenShareWatchesAfterReconnect();
      void this.hooks.accompanimentRefreshSessions();
      void this.hooks.remoteControlRefreshSessions();
      this.startPresenceHeartbeat();
    };
    socket.onmessage = (message) => {
      if (this.eventSocket !== socket) return;
      const event = parseServerEvent(message.data);
      if (event) this.handleServerEvent(event);
    };
    socket.onerror = () => {
      socket.close();
    };
    socket.onclose = () => {
      if (this.eventSocket !== socket) return;
      this.eventSocket = null;
      this.stopPresenceHeartbeat();
      this.hooks.syncViewerScreenShareSignalPolling();
      const voiceState = this.hooks.voiceState();
      if (voiceState.voiceConnectionContext?.serverId === this.hooks.activeServerId()) {
        void this.ensureVoiceEventSocket(true);
      }
      if (!this.hooks.memberId()) return;
      this.eventConnectionStatus = "reconnecting";
      window.clearTimeout(this.eventReconnectTimer);
      this.eventReconnectAttempts += 1;
      this.recoverInvalidSession(this.hooks.translate("workspace.connectionLost"), this.hooks.sessionToken(), false);
      if (this.eventReconnectAttempts >= 5) {
        this.hooks.showWorkspaceReconnect(this.hooks.activeServerId(), this.hooks.translate("workspace.connectionLost"));
        return;
      }
      const delayMS = reconnectDelayMS(this.eventReconnectAttempts);
      this.eventReconnectTimer = window.setTimeout(() => this.connectEventSocket(), delayMS);
    };
  }

  handleSessionInvalidEvent = (event: Event): void => {
    if (
      !this.hooks.activeServerId() ||
      !this.hooks.sessionToken() ||
      this.hooks.workspaceReconnectRequired()
    ) return;
    const detail = (event as CustomEvent<{ message?: string; sessionToken?: string }>).detail;
    if (detail?.sessionToken && detail.sessionToken !== this.hooks.sessionToken()) return;
    this.recoverInvalidSession(
      detail?.message || this.hooks.translate("workspace.sessionExpired"),
      detail?.sessionToken || this.hooks.sessionToken(),
      true
    );
  }

  private recoverInvalidSession(message: string, failedSessionToken: string, showFailure: boolean): void {
    if (
      !this.hooks.activeServerId() ||
      !failedSessionToken ||
      failedSessionToken !== this.hooks.sessionToken()
    ) return;
    this.sessionRecoveryShowFailure = this.sessionRecoveryShowFailure || showFailure;
    if (this.sessionRecoveryPromise) return;
    const recovery = this.renewActiveSession(message, failedSessionToken);
    this.sessionRecoveryPromise = recovery;
    void recovery.finally(() => {
      if (this.sessionRecoveryPromise !== recovery) return;
      this.sessionRecoveryPromise = null;
      this.sessionRecoveryShowFailure = false;
    });
  }

  private async renewActiveSession(message: string, failedSessionToken: string): Promise<void> {
    const recoveryServerId = this.hooks.activeServerId();
    try {
      const credential = this.hooks.storedCredential()?.server_id === recoveryServerId
        ? this.hooks.storedCredential()
        : await loadCredential(recoveryServerId);
      if (!credential) throw new Error(this.hooks.translate("workspace.sessionExpired"));
      const normalizedCredential = this.hooks.normalizeStoredCredential(credential);
      const refreshed = await refreshSession(
        normalizedCredential,
        this.hooks.localUserProfile().local_profile_id
      );
      if (this.hooks.activeServerId() !== recoveryServerId || this.hooks.sessionToken() !== failedSessionToken) return;

      this.hooks.setStoredCredential(normalizedCredential);
      this.hooks.setMemberId(refreshed.member_id);
      this.hooks.setSessionToken(refreshed.session_token);
      this.hooks.setIsOwner(refreshed.is_owner);
      this.hooks.setServerReportedClientUpdateRequired(Boolean(refreshed.client_update_required));
      const voiceState = this.hooks.voiceState();
      if (voiceState.voiceConnectionContext?.serverId === recoveryServerId) {
        voiceState.voiceConnectionContext = {
          ...voiceState.voiceConnectionContext,
          sessionToken: refreshed.session_token,
          memberId: refreshed.member_id
        };
      }
      this.closeEventSocket();
      if (voiceState.voiceConnectionContext) {
        this.voiceRejoinArmedForChannelId = voiceState.voiceConnectionContext.channelId;
      }
      this.connectEventSocket();
      this.startVoiceStatesRefreshLoop();
      this.hooks.setWorkspaceReconnectRequired(false);
      this.hooks.setWorkspaceReconnectBusy(false);
      this.hooks.setWorkspaceConnectionError("");
      this.hooks.setStatusKey(refreshed.is_owner ? "status.connectedOwner" : "status.connected");
      if (this.hooks.error() === message || this.hooks.error().includes("session token")) {
        this.hooks.setError("");
      }
      void voiceState.refreshVoiceStates(true);
    } catch (caught) {
      if (
        this.sessionRecoveryShowFailure &&
        this.hooks.activeServerId() === recoveryServerId &&
        this.hooks.sessionToken() === failedSessionToken
      ) {
        this.hooks.showWorkspaceReconnect(
          recoveryServerId,
          this.hooks.connectionFailureMessage(caught) || message
        );
      }
    }
  }

  closeEventSocket(): void {
    window.clearTimeout(this.eventReconnectTimer);
    this.eventReconnectTimer = undefined;
    this.eventReconnectAttempts = 0;
    this.eventConnectionStatus = "disconnected";
    this.stopPresenceHeartbeat();
    const socket = this.eventSocket;
    this.eventSocket = null;
    this.hooks.syncViewerScreenShareSignalPolling();
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    socket.close();
  }

  // ---- voice event socket ----------------------------------------------------

  async prepareVoiceConnectionForWorkspaceSwitch(targetServerId: string): Promise<boolean> {
    const context = this.hooks.voiceState().voiceConnectionContext;
    if (!context) return true;
    if (context.serverId === targetServerId) {
      return this.hooks.activeServerId() === targetServerId ? true : this.ensureVoiceEventSocket(true);
    }
    return this.ensureVoiceEventSocket(true);
  }

  async ensureVoiceEventSocket(forceDedicated = false): Promise<boolean> {
    const context = this.hooks.voiceState().voiceConnectionContext;
    if (!context) return false;
    if (
      !forceDedicated &&
      context.serverId === this.hooks.activeServerId() &&
      this.eventSocket?.readyState === WebSocket.OPEN
    ) {
      return true;
    }
    if (
      this.voiceEventSocketServerId === context.serverId &&
      (this.voiceEventSocket?.readyState === WebSocket.OPEN || this.voiceEventSocket?.readyState === WebSocket.CONNECTING)
    ) {
      return waitForEventSocketOpen(this.voiceEventSocket, 3000);
    }

    this.closeVoiceEventSocket();
    const socket = openEventSocket(context.baseUrl, context.sessionToken);
    const serverId = context.serverId;
    this.voiceEventSocket = socket;
    this.voiceEventSocketServerId = serverId;
    socket.onopen = () => {
      if (this.voiceEventSocket !== socket || this.hooks.voiceState().voiceConnectionContext?.serverId !== serverId) return;
      this.voiceEventReconnectAttempts = 0;
      this.startVoiceEventHeartbeat();
      this.hooks.flushPendingVoiceOutboundSignals();
      this.queueCurrentVoiceSpeakingState(true);
    };
    socket.onmessage = (message) => {
      if (this.hooks.voiceState().voiceConnectionContext?.serverId !== serverId) return;
      const event = parseServerEvent(message.data);
      if (event) this.handleDetachedVoiceEvent(event);
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.voiceEventSocket !== socket) return;
      this.voiceEventSocket = null;
      this.voiceEventSocketServerId = "";
      this.stopVoiceEventHeartbeat();
      const contextAfterClose = this.hooks.voiceState().voiceConnectionContext;
      if (
        !contextAfterClose ||
        contextAfterClose.serverId !== serverId ||
        this.hooks.activeServerId() === serverId
      ) return;
      this.voiceEventReconnectAttempts += 1;
      const delayMS = reconnectDelayMS(this.voiceEventReconnectAttempts, { baseMS: 750 });
      window.clearTimeout(this.voiceEventReconnectTimer);
      this.voiceEventReconnectTimer = window.setTimeout(() => void this.ensureVoiceEventSocket(true), delayMS);
    };
    return waitForEventSocketOpen(socket, 3000);
  }

  closeVoiceEventSocket(): void {
    window.clearTimeout(this.voiceEventReconnectTimer);
    this.voiceEventReconnectTimer = undefined;
    this.voiceEventReconnectAttempts = 0;
    this.stopVoiceEventHeartbeat();
    const socket = this.voiceEventSocket;
    this.voiceEventSocket = null;
    this.voiceEventSocketServerId = "";
    if (!socket) return;
    socket.onclose = null;
    socket.close();
  }

  private startVoiceEventHeartbeat(): void {
    this.stopVoiceEventHeartbeat();
    this.sendVoiceEventHeartbeat();
    this.voiceEventHeartbeatTimer = window.setInterval(() => this.sendVoiceEventHeartbeat(), 15000);
  }

  private stopVoiceEventHeartbeat(): void {
    if (this.voiceEventHeartbeatTimer) window.clearInterval(this.voiceEventHeartbeatTimer);
    this.voiceEventHeartbeatTimer = undefined;
  }

  private sendVoiceEventHeartbeat(): void {
    if (this.voiceEventSocket?.readyState !== WebSocket.OPEN) return;
    this.voiceEventSocket.send(JSON.stringify({ type: "presence.heartbeat", payload: { at_ms: Date.now() } }));
  }

  /** Socket that may carry voice RTC signals: dedicated voice socket first. */
  activeVoiceSignalSocket(): WebSocket | null {
    const context = this.hooks.voiceState().voiceConnectionContext;
    if (!context) return null;
    if (context.serverId === this.hooks.activeServerId() && this.eventSocket?.readyState === WebSocket.OPEN) {
      return this.eventSocket;
    }
    if (this.voiceEventSocketServerId === context.serverId && this.voiceEventSocket?.readyState === WebSocket.OPEN) {
      return this.voiceEventSocket;
    }
    return null;
  }

  queueCurrentVoiceSpeakingState(force = false): void {
    const voiceState = this.hooks.voiceState();
    const context = voiceState.voiceConnectionContext;
    const state = context?.state;
    if (!context || !state?.participant_id) return;
    const nextSpeaking = Boolean(
      state.mode !== "listener" &&
      this.hooks.isSpeaking() &&
      !this.hooks.micMuted() &&
      !this.hooks.audioDeafened() &&
      !this.hooks.voiceInputUnavailable() &&
      !state.server_muted &&
      !state.server_deafened
    );
    const signature = `${context.serverId}:${state.participant_id}:${nextSpeaking}`;
    if (!force && !this.pendingVoiceSpeakingState && signature === this.lastSentVoiceSpeakingSignature) return;
    this.pendingVoiceSpeakingState = {
      serverId: context.serverId,
      participantId: state.participant_id,
      isSpeaking: nextSpeaking
    };
    this.flushPendingVoiceSpeakingState();
  }

  flushPendingVoiceSpeakingState(): void {
    const pending = this.pendingVoiceSpeakingState;
    const context = this.hooks.voiceState().voiceConnectionContext;
    const socket = this.activeVoiceSignalSocket();
    if (
      !pending ||
      !context ||
      pending.serverId !== context.serverId ||
      pending.participantId !== context.state.participant_id ||
      socket?.readyState !== WebSocket.OPEN
    ) return;
    try {
      socket.send(JSON.stringify({
        type: "voice.speaking.update",
        payload: { is_speaking: pending.isSpeaking }
      }));
      this.lastSentVoiceSpeakingSignature = `${pending.serverId}:${pending.participantId}:${pending.isSpeaking}`;
      this.pendingVoiceSpeakingState = null;
    } catch {
      // Keep the latest value queued; reconnect handlers force a resend.
    }
  }

  resetPendingSpeakingState(): void {
    this.pendingVoiceSpeakingState = null;
    this.lastSentVoiceSpeakingSignature = "";
  }

  armVoiceRejoin(channelId: string): void {
    this.voiceRejoinArmedForChannelId = channelId;
  }

  clearVoiceRejoinArmed(): void {
    this.voiceRejoinArmedForChannelId = "";
  }

  // ---- presence heartbeat ----------------------------------------------------

  private startPresenceHeartbeat(): void {
    this.stopPresenceHeartbeat();
    this.sendPresenceHeartbeat();
    this.presenceHeartbeatTimer = window.setInterval(() => this.sendPresenceHeartbeat(), 15000);
  }

  private stopPresenceHeartbeat(): void {
    if (this.presenceHeartbeatTimer) window.clearInterval(this.presenceHeartbeatTimer);
    this.presenceHeartbeatTimer = undefined;
  }

  private sendPresenceHeartbeat(): void {
    if (this.eventSocket?.readyState !== WebSocket.OPEN) return;
    this.eventSocket.send(JSON.stringify({ type: "presence.heartbeat", payload: { at_ms: Date.now() } }));
  }

  // ---- window visibility / background recovery -------------------------------

  attachWindowListeners(): void {
    window.addEventListener("online", this.handleWindowOnline);
    window.addEventListener("focus", this.handleWindowFocus);
    window.addEventListener("blur", this.handleWindowBlur);
    window.addEventListener("echovoice:session-invalid", this.handleSessionInvalidEvent);
  }

  detachWindowListeners(): void {
    window.removeEventListener("online", this.handleWindowOnline);
    window.removeEventListener("focus", this.handleWindowFocus);
    window.removeEventListener("blur", this.handleWindowBlur);
    window.removeEventListener("echovoice:session-invalid", this.handleSessionInvalidEvent);
  }

  private handleWindowOnline = (): void => {
    this.recoverScreenSharesWhenBrowserReturns();
  };

  private handleWindowFocus = (): void => {
    this.setLocalScreenSharePreviewRendering(true);
    this.recoverScreenSharesWhenBrowserReturns();
    this.resumeVoiceAudioAfterBrowserReturn();
    if (
      this.hooks.remoteControlSessions().length > 0 ||
      this.hooks.screenShareSessions().some((share) => share.remote_control_allowed)
    ) {
      void this.hooks.remoteControlRefreshSessions();
    }
  };

  private handleWindowBlur = (): void => {
    this.setLocalScreenSharePreviewRendering(false);
  };

  private recoverScreenSharesWhenBrowserReturns(): void {
    if (this.eventSocket?.readyState === WebSocket.OPEN) {
      void this.hooks.recoverScreenShareWatchesAfterReconnect();
    }
  }

  recoverAfterBrowserReturn(): Promise<void> {
    if (this.recoverRealtimePromise) {
      this.recoverRealtimeQueued = true;
      return this.recoverRealtimePromise;
    }
    const recovery = (async () => {
      do {
        this.recoverRealtimeQueued = false;
        // Resume audio graphs that browsers suspend while hidden or frozen.
        this.resumeVoiceAudioAfterBrowserReturn();
        // Fire heartbeats immediately instead of waiting for throttled timers.
        this.sendPresenceHeartbeat();
        this.sendVoiceEventHeartbeat();
        if (
          this.hooks.remoteControlSessions().length > 0 ||
          this.hooks.screenShareSessions().some((share) => share.remote_control_allowed)
        ) {
          void this.hooks.remoteControlHeartbeatActive();
          void this.hooks.remoteControlRefreshSessions();
        }
        // Re-sync voice state and reconcile peers right away instead of
        // waiting for the periodic loops, which are paused while hidden.
        // Force the offer: after a freeze the remote side may still consider
        // its old connection healthy while ours was suspended.
        if (this.hooks.sessionToken()) {
          // A browser return can discover that the server removed our voice
          // state while we were suspended; arm the same auto-rejoin the
          // reconnect path uses so the teardown below rejoins the channel.
          const voiceState = this.hooks.voiceState();
          if (voiceState.voiceConnectionContext) {
            this.voiceRejoinArmedForChannelId = voiceState.voiceConnectionContext.channelId;
          }
          await voiceState.refreshVoiceStates(true);
          const state = this.hooks.currentVoiceState();
          if (state) await this.hooks.connectVoicePeers(state.channel_id, true);
        }
        this.recoverScreenSharesWhenBrowserReturns();
      } while (this.recoverRealtimeQueued);
    })();
    this.recoverRealtimePromise = recovery;
    void recovery.finally(() => {
      if (this.recoverRealtimePromise === recovery) {
        this.recoverRealtimePromise = null;
      }
    });
    return recovery;
  }

  // ---- native screen-share preview transport ---------------------------------

  setLocalScreenSharePreviewRendering(windowFocused: boolean): void {
    if (!this.hooks.nativeDesktopRuntime()) return;
    const enabled = windowFocused && document.visibilityState === "visible";
    if (this.hooks.localScreenSharePreviewRenderingEnabled() === enabled) return;
    if (!enabled) {
      this.hooks.localScreenShareVideoElement()?.pause();
      this.hooks.focusedScreenShareVideoElement()?.pause();
    }
    this.hooks.setLocalScreenSharePreviewRenderingEnabled(enabled);
    if (!enabled) {
      void this.stopNativeLocalScreenSharePreview({ resumeThumbnail: false });
    } else {
      const focusedOwnShare = this.hooks.screenShareSessions().find(
        (share) => share.share_id === this.hooks.focusedScreenShareId() && share.owner_member_id === this.hooks.memberId()
      );
      if (focusedOwnShare) void this.startNativeLocalScreenSharePreview(focusedOwnShare);
    }
    void this.syncNativeScreenSharePreviewRendering();
  }

  private nativeScreenShareThumbnailRenderingDesired(): boolean {
    return this.hooks.localScreenSharePreviewRenderingEnabled() && !this.hooks.nativeLocalScreenSharePreviewRequested();
  }

  syncNativeScreenSharePreviewRendering(requestedSessionId?: string): Promise<void> {
    const sessionId = requestedSessionId ?? this.hooks.nativeScreenShareSenderSession()?.sessionId ?? "";
    if (!this.hooks.nativeDesktopRuntime() || !sessionId) return Promise.resolve();
    const generation = this.hooks.nativeScreenSharePreviewSyncGeneration() + 1;
    this.hooks.setNativeScreenSharePreviewSyncGeneration(generation);
    const sync = this.hooks.nativeScreenSharePreviewSyncTail().then(async () => {
      if (this.hooks.nativeScreenShareSenderSession()?.sessionId !== sessionId) return;
      const enabled = this.nativeScreenShareThumbnailRenderingDesired();
      try {
        const status = await setNativeScreenShareSenderPreviewEnabled(sessionId, enabled);
        if (
          generation === this.hooks.nativeScreenSharePreviewSyncGeneration() &&
          this.hooks.nativeScreenShareSenderSession()?.sessionId === sessionId
        ) {
          this.hooks.applyNativeScreenShareSenderStatus(status);
        }
      } catch (caught) {
        if (
          enabled &&
          generation === this.hooks.nativeScreenSharePreviewSyncGeneration() &&
          this.hooks.nativeScreenShareSenderSession()?.sessionId === sessionId
        ) {
          this.hooks.setNativeScreenShareStatusRefreshError(
            caught instanceof Error ? caught.message : this.hooks.translate("screenShare.nativePreviewProbeStalled")
          );
        }
      }
    });
    this.hooks.setNativeScreenSharePreviewSyncTail(sync.catch(() => undefined));
    return sync;
  }

  async startNativeLocalScreenSharePreview(share: ScreenShareSession): Promise<void> {
    const senderSession = this.hooks.nativeScreenShareSenderSession();
    if (
      !this.hooks.nativeDesktopRuntime() ||
      !this.hooks.localScreenSharePreviewRenderingEnabled() ||
      share.owner_member_id !== this.hooks.memberId() ||
      senderSession?.shareId !== share.share_id
    ) return;
    if (
      this.hooks.nativeLocalScreenSharePreviewRequested() &&
      this.hooks.nativeLocalScreenSharePreviewSessionId() === senderSession.sessionId &&
      this.hooks.nativeLocalScreenSharePreviewConnection() &&
      this.hooks.nativeLocalScreenSharePreviewConnection()?.connectionState !== "closed"
    ) return;

    if (this.hooks.nativeLocalScreenSharePreviewConnection() || this.hooks.nativeLocalScreenSharePreviewWatchSessionId()) {
      await this.stopNativeLocalScreenSharePreview({ resumeThumbnail: false });
      if (this.hooks.nativeScreenShareSenderSession()?.sessionId !== senderSession.sessionId) return;
    }

    const generation = this.hooks.nativeLocalScreenSharePreviewGeneration() + 1;
    this.hooks.setNativeLocalScreenSharePreviewGeneration(generation);
    const watchSessionId = `local_preview_${senderSession.sessionId}_${generation}`;
    const connection = new RTCPeerConnection(this.hooks.browserRTCConfiguration());
    this.hooks.setNativeLocalScreenSharePreviewRequested(true);
    this.hooks.setNativeLocalScreenSharePreviewStarting(true);
    this.hooks.setNativeLocalScreenSharePreviewError("");
    this.hooks.setNativeLocalScreenSharePreviewStream(null);
    this.hooks.setNativeLocalScreenSharePreviewSessionId(senderSession.sessionId);
    this.hooks.setNativeLocalScreenSharePreviewWatchSessionId(watchSessionId);
    this.hooks.setPendingNativeLocalScreenSharePreviewCandidates([]);
    this.hooks.setNativeLocalScreenSharePreviewConnection(connection);
    void this.syncNativeScreenSharePreviewRendering(senderSession.sessionId);

    connection.ontrack = (event) => {
      if (
        generation !== this.hooks.nativeLocalScreenSharePreviewGeneration() ||
        this.hooks.nativeLocalScreenSharePreviewConnection() !== connection ||
        event.track.kind !== "video"
      ) return;
      this.hooks.configureScreenShareReceiver(event.receiver);
      this.hooks.setNativeLocalScreenSharePreviewStream(new MediaStream([event.track]));
      this.hooks.setNativeLocalScreenSharePreviewStarting(false);
      this.hooks.setNativeLocalScreenSharePreviewError("");
      event.track.addEventListener("ended", () => {
        if (this.hooks.nativeLocalScreenSharePreviewConnection() !== connection) return;
        this.hooks.setNativeLocalScreenSharePreviewStream(null);
        this.hooks.setNativeLocalScreenSharePreviewError(this.hooks.translate("screenShare.localPreviewDirectEnded"));
      }, { once: true });
    };
    connection.onicecandidate = (event) => {
      if (
        !event.candidate ||
        generation !== this.hooks.nativeLocalScreenSharePreviewGeneration() ||
        this.hooks.nativeLocalScreenSharePreviewConnection() !== connection
      ) return;
      void handleNativeScreenShareSenderSignal(
        senderSession.sessionId,
        nativeLocalScreenSharePreviewViewerId,
        "screen-share-ice-candidate",
        {
          share_id: share.share_id,
          watch_session_id: watchSessionId,
          candidate: event.candidate.toJSON()
        }
      ).then((status) => {
        if (this.hooks.nativeScreenShareSenderSession()?.sessionId === senderSession.sessionId) {
          this.hooks.applyNativeScreenShareSenderStatus(status);
          this.hooks.scheduleNativeScreenShareSignalFlush(senderSession.sessionId);
        }
      }).catch((caught) => {
        if (this.hooks.nativeLocalScreenSharePreviewConnection() !== connection) return;
        this.hooks.setNativeLocalScreenSharePreviewError(caught instanceof Error
          ? caught.message
          : this.hooks.translate("screenShare.localPreviewDirectFailed"));
      });
    };
    connection.onconnectionstatechange = () => {
      if (this.hooks.nativeLocalScreenSharePreviewConnection() !== connection) return;
      if (connection.connectionState === "connected") {
        this.hooks.setNativeLocalScreenSharePreviewStarting(false);
        return;
      }
      if (connection.connectionState === "failed" || connection.connectionState === "disconnected") {
        this.hooks.setNativeLocalScreenSharePreviewStarting(false);
        this.hooks.setNativeLocalScreenSharePreviewError(this.hooks.translate("screenShare.localPreviewDirectFailed"));
      }
    };

    try {
      const status = await addNativeScreenShareSenderViewer(
        senderSession.sessionId,
        nativeLocalScreenSharePreviewViewerId,
        watchSessionId
      );
      if (
        generation !== this.hooks.nativeLocalScreenSharePreviewGeneration() ||
        this.hooks.nativeLocalScreenSharePreviewConnection() !== connection ||
        this.hooks.nativeScreenShareSenderSession()?.sessionId !== senderSession.sessionId
      ) return;
      this.hooks.applyNativeScreenShareSenderStatus(status);
      await this.hooks.forwardNativeScreenShareSenderSignals(senderSession.sessionId);
      this.hooks.scheduleNativeScreenShareSignalFlush(senderSession.sessionId);
    } catch (caught) {
      if (generation !== this.hooks.nativeLocalScreenSharePreviewGeneration()) return;
      this.hooks.setNativeLocalScreenSharePreviewStarting(false);
      this.hooks.setNativeLocalScreenSharePreviewError(caught instanceof Error
        ? caught.message
        : this.hooks.translate("screenShare.localPreviewDirectFailed"));
      connection.close();
      if (this.hooks.nativeLocalScreenSharePreviewConnection() === connection) {
        this.hooks.setNativeLocalScreenSharePreviewConnection(null);
      }
    }
  }

  async stopNativeLocalScreenSharePreview(
    options: { resumeThumbnail?: boolean } = {}
  ): Promise<void> {
    const sessionId = this.hooks.nativeLocalScreenSharePreviewSessionId();
    const watchSessionId = this.hooks.nativeLocalScreenSharePreviewWatchSessionId();
    this.hooks.setNativeLocalScreenSharePreviewGeneration(this.hooks.nativeLocalScreenSharePreviewGeneration() + 1);
    this.hooks.setNativeLocalScreenSharePreviewRequested(false);
    this.hooks.setNativeLocalScreenSharePreviewStarting(false);
    this.hooks.setNativeLocalScreenSharePreviewError("");
    this.hooks.setPendingNativeLocalScreenSharePreviewCandidates([]);
    this.hooks.nativeLocalScreenSharePreviewConnection()?.close();
    this.hooks.setNativeLocalScreenSharePreviewConnection(null);
    this.hooks.nativeLocalScreenSharePreviewStream()?.getTracks().forEach((track) => track.stop());
    this.hooks.setNativeLocalScreenSharePreviewStream(null);
    this.hooks.setNativeLocalScreenSharePreviewSessionId("");
    this.hooks.setNativeLocalScreenSharePreviewWatchSessionId("");
    if (sessionId && watchSessionId && this.hooks.nativeScreenShareSenderSession()?.sessionId === sessionId) {
      await removeNativeScreenShareSenderViewer(
        sessionId,
        nativeLocalScreenSharePreviewViewerId,
        watchSessionId
      ).catch(() => undefined);
    }
    if ((options.resumeThumbnail ?? true) && this.hooks.nativeScreenShareSenderSession()?.sessionId === sessionId) {
      void this.syncNativeScreenSharePreviewRendering(sessionId);
    }
  }

  async handleNativeLocalScreenSharePreviewSignal(signal: NativeScreenShareOutboundSignal): Promise<void> {
    const connection = this.hooks.nativeLocalScreenSharePreviewConnection();
    const senderSession = this.hooks.nativeScreenShareSenderSession();
    const watchSessionId = this.hooks.nativeLocalScreenSharePreviewWatchSessionId();
    if (
      !connection ||
      !senderSession ||
      signal.memberId !== nativeLocalScreenSharePreviewViewerId ||
      this.hooks.screenShareDataWatchSessionId(signal.data) !== watchSessionId ||
      this.hooks.nativeLocalScreenSharePreviewSessionId() !== senderSession.sessionId
    ) return;
    const data = signal.data && typeof signal.data === "object"
      ? signal.data as Record<string, unknown>
      : {};
    if (signal.signalType === "screen-share-offer") {
      const descriptionValue = data.description ?? signal.data;
      if (!descriptionValue || typeof descriptionValue !== "object") return;
      const description = descriptionValue as RTCSessionDescriptionInit;
      await connection.setRemoteDescription(description);
      for (const candidate of this.hooks.pendingNativeLocalScreenSharePreviewCandidates()) {
        await connection.addIceCandidate(candidate).catch(() => undefined);
      }
      this.hooks.setPendingNativeLocalScreenSharePreviewCandidates([]);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      const status = await handleNativeScreenShareSenderSignal(
        senderSession.sessionId,
        nativeLocalScreenSharePreviewViewerId,
        "screen-share-answer",
        {
          share_id: senderSession.shareId,
          watch_session_id: watchSessionId,
          description: connection.localDescription ?? answer
        }
      );
      if (this.hooks.nativeScreenShareSenderSession()?.sessionId === senderSession.sessionId) {
        this.hooks.applyNativeScreenShareSenderStatus(status);
      }
      return;
    }
    if (signal.signalType !== "screen-share-ice-candidate") return;
    const candidateValue = data.candidate;
    if (!candidateValue || typeof candidateValue !== "object") return;
    const candidate = candidateValue as RTCIceCandidateInit;
    if (connection.remoteDescription) {
      await connection.addIceCandidate(candidate).catch(() => undefined);
    } else {
      this.hooks.setPendingNativeLocalScreenSharePreviewCandidates([
        ...this.hooks.pendingNativeLocalScreenSharePreviewCandidates(),
        candidate
      ].slice(-64));
    }
  }

  resumeVoiceAudioAfterBrowserReturn(): void {
    if (this.hooks.nativeDesktopRuntime()) return;
    this.hooks.resumeRemoteAudioPlayback();
    this.hooks.resumeSuspendedVoiceInputContexts();
    this.hooks.accompanimentResumeAfterBrowserReturn();
  }

  // ---- voice state refresh loop ----------------------------------------------

  startVoiceStatesRefreshLoop(): void {
    this.stopVoiceStatesRefreshLoop();
    const voiceState = this.hooks.voiceState();
    void voiceState.refreshVoiceStates();
    voiceState.refreshTimer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      const context = voiceState.voiceConnectionContext;
      if (context && !this.hooks.voiceTransportActive()) {
        // Self-heal a zombie context (e.g. a renderer eviction raced a state
        // refresh, or a reconnect missed its events): an authoritative
        // refresh either rebuilds the transport from server state or, when
        // the server removed us, tears down and automatically rejoins.
        void voiceState.refreshVoiceStates(true);
        return;
      }
      if (this.eventSocket?.readyState !== WebSocket.OPEN) void voiceState.refreshVoiceStates();
      void this.hooks.accompanimentRefreshSessions();
      if (
        this.hooks.remoteControlSessions().length > 0 ||
        this.hooks.screenShareSessions().some((share) => share.remote_control_allowed)
      ) {
        void this.hooks.remoteControlRefreshSessions();
      }
    }, 5000);
  }

  stopVoiceStatesRefreshLoop(): void {
    const voiceState = this.hooks.voiceState();
    if (voiceState.refreshTimer) {
      window.clearInterval(voiceState.refreshTimer);
    }
    voiceState.refreshTimer = 0;
    voiceState.refreshQueued = false;
  }

  refreshScreenShareSessions(): Promise<void> {
    return this.hooks.screenShareRefreshSessions();
  }

  refreshRemoteControlSessions(): Promise<void> {
    return this.hooks.remoteControlRefreshSessions();
  }

  heartbeatActiveRemoteControls(): Promise<void> {
    return this.hooks.remoteControlHeartbeatActive();
  }

  // ---- server event dispatch -------------------------------------------------

  handleServerEvent(event: ServerEvent): void {
    if (event.type === "server.updated") {
      const emojiWasEnabled = Boolean(this.hooks.server()?.emoji_enabled);
      const updatedServer = event.payload as ServerSummary;
      this.hooks.setServer(updatedServer);
      void this.hooks.syncSavedServerSummary(updatedServer).catch(() => undefined);
      if (this.hooks.serverSettingsOpen() && !this.hooks.serverSettingsDirty()) {
        this.hooks.setServerSettingsDraft({ ...(event.payload as ServerSummary) });
      }
      if (!updatedServer.file_storage_enabled && this.hooks.channelContentMode() === "files") {
        this.hooks.clearFileView();
      }
      if (!updatedServer.soundboard_enabled) {
        this.hooks.soundboardHandleServerDisabled();
        this.hooks.flushAliases();
      }
      if (!updatedServer.emoji_enabled) {
        this.hooks.emojiHandleServerDisabled();
        this.hooks.renderComposerEditor(this.hooks.composerDraft());
      } else if (!emojiWasEnabled) {
        void this.hooks.emojiRefreshItems(
          this.hooks.serverSettingsOpen() && this.hooks.serverSettingsTab() === "emoji"
        ).catch(() => undefined);
      } else {
        this.hooks.emojiSyncCurrentLibrary();
      }
      return;
    }
    if (event.type === "channel.created" || event.type === "channel.updated") {
      this.mergeChannel(event.payload as Channel);
      return;
    }
    if (event.type === "channels.reordered") {
      const payload = event.payload as { channels?: Channel[] };
      if (Array.isArray(payload.channels)) {
        this.applyVisibleChannelSnapshot(payload.channels);
      }
      return;
    }
    if (event.type === "channel.deleted") {
      this.removeChannel(event.payload as Channel);
      return;
    }
    if (
      event.type === "member.joined" ||
      event.type === "member.updated" ||
      event.type === "member.presence.updated"
    ) {
      this.mergeMember(event.payload as Member);
      return;
    }
    if (event.type === "member.identity_linked") {
      const payload = event.payload as { member?: Member; previous_member_id?: string };
      if (payload.previous_member_id === this.hooks.memberId() && payload.member?.member_id) {
        void this.reconnectAfterIdentityLink(payload.member);
      }
      return;
    }
    if (event.type === "member.merge.requested") {
      const request = normalizeMemberMergeRequest(event.payload as MemberMergeRequest);
      if (request.target_member_id === this.hooks.memberId()) {
        this.hooks.setMemberMergeIncoming(
          this.hooks.mergeMemberMergeRequest(this.hooks.memberMergeIncoming(), request)
        );
        void this.hooks.processNextMemberMergePrompt();
      }
      return;
    }
    if (event.type === "member.merge.resolved") {
      const request = normalizeMemberMergeRequest(event.payload as MemberMergeRequest);
      this.hooks.setMemberMergeIncoming(
        this.hooks.memberMergeIncoming().filter((item) => item.request_id !== request.request_id)
      );
      this.hooks.setMemberMergeOutgoing(
        this.hooks.memberMergeOutgoing().filter((item) => item.request_id !== request.request_id)
      );
      if (this.hooks.memberMergePromptRequestID() === request.request_id) {
        this.hooks.setMemberMergePromptResolvedExternally(true);
        if (this.hooks.appDialogHasMemberCard()) this.hooks.settleAppDialog(null);
      }
      return;
    }
    if (event.type === "member.left") {
      this.removeMember(event.payload as Member);
      return;
    }
    if (event.type === "role.created" || event.type === "role.updated") {
      this.hooks.mergeRole(event.payload as ServerRole);
      return;
    }
    if (event.type === "role.deleted") {
      this.hooks.removeRole(event.payload as ServerRole);
      return;
    }
    if (event.type === "roles.reordered") {
      const payload = event.payload as { roles?: ServerRole[] };
      if (Array.isArray(payload.roles)) {
        this.hooks.replaceRoles(this.hooks.sortRoles(payload.roles));
        this.hooks.ensureSelectedRole();
      }
      return;
    }
    if (event.type === "message.created") {
      const message = event.payload as Message;
      if (message.channel_id === this.hooks.selectedChannelId()) {
        const shouldScroll = this.hooks.isMessageListNearBottom();
        this.mergeMessage(message);
        if (shouldScroll || message.author_id === this.hooks.memberId()) {
          void this.hooks.scrollMessagesToBottom();
        } else {
          if (!this.hooks.currentChannelNewMessageStartId()) {
            this.hooks.setCurrentChannelNewMessageStartId(message.message_id);
          }
          this.hooks.setCurrentChannelNewMessageCount(this.hooks.currentChannelNewMessageCount() + 1);
        }
      } else if (message.author_id !== this.hooks.memberId()) {
        this.hooks.incrementUnread(message.channel_id);
      }
      return;
    }
    if (event.type === "message.updated") {
      const message = event.payload as Message;
      if (message.channel_id === this.hooks.selectedChannelId()) this.mergeMessage(message);
      return;
    }
    if (event.type === "message.deleted") {
      this.removeMessage(event.payload as Message);
      return;
    }
    if (event.type === "file.created" || event.type === "file.updated") {
      this.hooks.mergeFileEntry(event.payload as ChannelFileEntry);
      return;
    }
    if (event.type === "file.deleted") {
      this.hooks.removeFileEntry(event.payload as ChannelFileEntry);
      return;
    }
    if (event.type === "channel.permission_override.updated") {
      const override = event.payload as ChannelPermissionOverride;
      if (override.channel_id === this.hooks.selectedPermissionChannelId()) {
        this.hooks.mergeChannelPermissionOverride(override);
      }
      return;
    }
    if (event.type === "channel.permission_override.deleted") {
      const override = event.payload as ChannelPermissionOverride;
      if (override.channel_id === this.hooks.selectedPermissionChannelId()) {
        this.hooks.removeChannelPermissionOverride(override);
      }
      return;
    }
    if (event.type === "voice.states.snapshot") {
      const payload = event.payload as { voice_states?: VoiceState[] };
      const voiceState = this.hooks.voiceState();
      voiceState.voiceStateRealtimeRevision += 1;
      voiceState.replaceVoiceStates(Array.isArray(payload.voice_states) ? payload.voice_states : []);
      return;
    }
    if (event.type === "voice.state.updated" || event.type === "voice.speaking.updated") {
      const voiceState = this.hooks.voiceState();
      voiceState.voiceStateRealtimeRevision += 1;
      const normalized = normalizeVoiceState(event.payload as VoiceState);
      const state = event.type === "voice.state.updated"
        ? voiceState.preserveRealtimeSpeakingState(normalized)
        : normalized;
      voiceState.mergeVoiceState(state);
      if (
        !voiceState.voiceConnectionContext &&
        state.member_id === this.hooks.memberId() &&
        state.device_id === this.hooks.localUserProfile().local_profile_id
      ) {
        // Pass the controller's live state, not the $: aliases: the aliases
        // flush one effect later, so a stale (pre-merge) snapshot here would
        // make replaceConnectedVoiceStates misread our own state as removed
        // and tear the just-established context back down.
        voiceState.establishVoiceConnectionContext(state, voiceState.voiceStates);
        voiceState.replaceConnectedVoiceStates(voiceState.voiceStates);
      } else if (voiceState.voiceConnectionContext?.serverId === this.hooks.activeServerId()) {
        this.handleConnectedVoiceStateUpdated(state);
      }
      return;
    }
    if (event.type === "voice.state.deleted") {
      const voiceState = this.hooks.voiceState();
      voiceState.voiceStateRealtimeRevision += 1;
      const state = normalizeVoiceState(event.payload as VoiceState);
      voiceState.removeVoiceState(state);
      if (voiceState.voiceConnectionContext?.serverId === this.hooks.activeServerId()) {
        this.handleConnectedVoiceStateDeleted(state);
      }
      return;
    }
    if (
      event.type === "voice.device.displaced" ||
      event.type === "voice.device.kicked" ||
      event.type === "voice.device.kicked.silent"
    ) {
      const voiceState = this.hooks.voiceState();
      voiceState.voiceStateRealtimeRevision += 1;
      const state = normalizeVoiceState(event.payload as VoiceState);
      voiceState.removeVoiceState(state);
      if (voiceState.voiceConnectionContext?.serverId === this.hooks.activeServerId()) {
        this.handleConnectedVoiceDeviceRemoved(state, event.type);
      }
      return;
    }
    if (event.type === "screen_share.started" || event.type === "screen_share.updated") {
      this.mergeScreenShareSession(event.payload as ScreenShareSession);
      return;
    }
    if (event.type === "screen_share.ended") {
      this.hooks.screenShareRemoveSession(event.payload as ScreenShareSession);
      return;
    }
    if (event.type === "accompaniment.started") {
      this.hooks.accompanimentMergeSession(event.payload as AccompanimentSession);
      return;
    }
    if (event.type === "accompaniment.ended") {
      this.hooks.accompanimentRemoveSession(event.payload as AccompanimentSession);
      return;
    }
    if (event.type === "soundboard.item.created" || event.type === "soundboard.item.updated") {
      this.hooks.soundboardMergeItem(event.payload as SoundboardItem);
      return;
    }
    if (event.type === "soundboard.item.deleted") {
      this.hooks.soundboardRemoveItem(event.payload as SoundboardItem);
      return;
    }
    if (event.type === "soundboard.played") {
      void this.hooks.soundboardHandlePlayback(event.payload as SoundboardPlayback);
      return;
    }
    if (event.type === "emoji.created" || event.type === "emoji.updated") {
      this.hooks.emojiMergeItem(event.payload as CustomEmoji);
      return;
    }
    if (event.type === "emoji.deleted") {
      this.hooks.emojiRemoveItem(event.payload as CustomEmoji);
      return;
    }
    if (
      event.type === "remote_control.requested" ||
      event.type === "remote_control.approved" ||
      event.type === "remote_control.rejected" ||
      event.type === "remote_control.revoked" ||
      event.type === "remote_control.suspended"
    ) {
      this.hooks.remoteControlMergeSession(event.payload as RemoteControlSession);
      return;
    }
    if (event.type === "remote_control.input") {
      void this.hooks.remoteControlHandleInput(event.payload as RemoteControlInput);
      return;
    }
    if (event.type === "rtc.signal") {
      const signal = event.payload as RTCSignal;
      const voiceState = this.hooks.voiceState();
      if (voiceState.voiceConnectionContext?.serverId !== this.hooks.activeServerId()) return;
      if (signal.signal_type.startsWith("screen-share-")) {
        this.enqueueScreenShareSignal(signal);
      } else {
        void this.enqueueVoiceSignal(signal);
      }
    }
  }

  handleConnectedVoiceStateUpdated(state: VoiceState): void {
    const voiceState = this.hooks.voiceState();
    const context = voiceState.voiceConnectionContext;
    if (!context) return;
    const previousCurrentState = context.state;
    const previousMemberState = voiceState.connectedVoiceStates.find(
      (item) => item.participant_id === state.participant_id
    );
    voiceState.playRemoteVoiceTransition(previousMemberState, state, previousCurrentState.channel_id);
    const localStateMoved = (
      previousCurrentState.participant_id === state.participant_id ||
      (state.member_id === context.memberId && state.device_id === context.deviceId)
    ) && previousCurrentState.channel_id !== state.channel_id;
    if (localStateMoved) voiceState.clearVoiceSpeakingStates(previousCurrentState.channel_id);
    voiceState.mergeConnectedVoiceState(state);
    if (localStateMoved) {
      this.restartLocalVoiceTransportAfterMove(state);
      return;
    }
    if (
      previousMemberState?.channel_id === previousCurrentState.channel_id &&
      state.channel_id !== previousCurrentState.channel_id
    ) {
      this.hooks.closePeerConnection(state.participant_id, state.member_id);
      return;
    }
    const currentState = voiceState.currentVoiceState();
    if (
      (this.hooks.localVoiceStream() || this.hooks.nativeVoiceSession()) &&
      currentState?.channel_id === state.channel_id &&
      state.participant_id !== currentState.participant_id
    ) {
      void this.hooks.ensureVoicePeer(state, currentState.participant_id < state.participant_id).then(() => {
        this.hooks.applyMemberVolume(state.member_id);
      });
    }
  }

  handleConnectedVoiceStateDeleted(state: VoiceState): void {
    const voiceState = this.hooks.voiceState();
    const context = voiceState.voiceConnectionContext;
    if (!context) return;
    const previousMemberState = voiceState.connectedVoiceStates.find(
      (item) => item.participant_id === state.participant_id
    ) ?? state;
    voiceState.playRemoteVoiceTransition(previousMemberState, undefined, context.channelId);
    const removedLocalState = voiceState.removeConnectedVoiceState(state);
    if (!removedLocalState) this.hooks.closePeerConnection(state.participant_id, state.member_id);
  }

  handleConnectedVoiceDeviceRemoved(
    state: VoiceState,
    eventType: "voice.device.displaced" | "voice.device.kicked" | "voice.device.kicked.silent"
  ): void {
    const voiceState = this.hooks.voiceState();
    if (!voiceState.removeConnectedVoiceState(state)) return;
    if (eventType === "voice.device.kicked" || eventType === "voice.device.kicked.silent") {
      this.hooks.playUISound("channel-leave");
    }
    if (eventType === "voice.device.kicked.silent") return;
    void this.hooks.showAppAlert(
      this.hooks.translate(eventType === "voice.device.displaced" ? "voice.deviceDisplaced" : "voice.deviceKicked"),
      { title: this.hooks.translate("voice.disconnected") }
    );
  }

  private handleDetachedVoiceEvent(event: ServerEvent): void {
    if (event.type === "channels.reordered") {
      const payload = event.payload as { channels?: Channel[] };
      const voiceState = this.hooks.voiceState();
      const context = voiceState.voiceConnectionContext;
      const connectedChannel = Array.isArray(payload.channels) && context
        ? payload.channels.find((channel) => channel.channel_id === context.channelId)
        : undefined;
      if (context && connectedChannel) {
        voiceState.voiceConnectionContext = { ...context, channelName: connectedChannel.name };
      }
      return;
    }
    if (event.type === "voice.states.snapshot") {
      const payload = event.payload as { voice_states?: VoiceState[] };
      const voiceState = this.hooks.voiceState();
      voiceState.voiceStateRealtimeRevision += 1;
      voiceState.replaceConnectedVoiceStates(Array.isArray(payload.voice_states) ? payload.voice_states : []);
      return;
    }
    if (event.type === "voice.state.updated" || event.type === "voice.speaking.updated") {
      const voiceState = this.hooks.voiceState();
      voiceState.voiceStateRealtimeRevision += 1;
      const normalized = normalizeVoiceState(event.payload as VoiceState);
      this.handleConnectedVoiceStateUpdated(
        event.type === "voice.state.updated" ? voiceState.preserveRealtimeSpeakingState(normalized) : normalized
      );
      return;
    }
    if (event.type === "voice.state.deleted") {
      const voiceState = this.hooks.voiceState();
      voiceState.voiceStateRealtimeRevision += 1;
      this.handleConnectedVoiceStateDeleted(normalizeVoiceState(event.payload as VoiceState));
      return;
    }
    if (
      event.type === "voice.device.displaced" ||
      event.type === "voice.device.kicked" ||
      event.type === "voice.device.kicked.silent"
    ) {
      const voiceState = this.hooks.voiceState();
      voiceState.voiceStateRealtimeRevision += 1;
      this.handleConnectedVoiceDeviceRemoved(normalizeVoiceState(event.payload as VoiceState), event.type);
      return;
    }
    if (event.type !== "rtc.signal") return;
    const signal = event.payload as RTCSignal;
    if (signal.signal_type.startsWith("screen-share-")) return;
    void this.enqueueVoiceSignal(signal);
  }

  async reconnectAfterIdentityLink(linkedMember: Member): Promise<void> {
    const previousCredential = this.hooks.storedCredential();
    this.closeEventSocket();
    this.hooks.setSessionToken("");
    this.hooks.setMemberId(linkedMember.member_id);
    if (!previousCredential) {
      this.hooks.setError(this.hooks.translate("error.connectionFailed"));
      return;
    }
    const migratedCredential: StoredCredential = {
      ...previousCredential,
      member_id: linkedMember.member_id
    };
    const profile = mergeSyncableProfileFromMember(this.hooks.localUserProfile(), linkedMember);
    this.hooks.setLocalUserProfile(profile);
    saveLocalUserProfile(profile);
    this.hooks.setProfileDraft({ ...profile });
    this.hooks.setDisplayName(profile.display_name);
    this.hooks.setStoredCredential(migratedCredential);
    try {
      await saveCredential(migratedCredential);
      const savedServer = this.hooks.savedServers().find(
        (item) => item.server_id === migratedCredential.server_id
      );
      if (savedServer) {
        await saveServer({ ...savedServer, member_id: linkedMember.member_id });
        this.hooks.setSavedServers(await loadServers());
      }
      await this.hooks.reconnectToServer(migratedCredential);
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.connectionFailed"));
    }
  }

  // ---- signal enqueueing & entity merge helpers ------------------------------

  enqueueScreenShareSignal(signal: RTCSignal): void {
    this.hooks.screenShareEnqueueSignal(signal);
  }

  enqueueVoiceSignal(signal: RTCSignal): Promise<void> {
    return this.hooks.enqueueVoiceSignal(signal);
  }

  isDuplicateScreenShareMediaSignal(signal: RTCSignal): boolean {
    return this.hooks.screenShareIsDuplicateMediaSignal(signal);
  }

  mergeChannel(channel: Channel): void {
    this.hooks.flushAliases();
    this.hooks.mergeChannel(channel);
  }

  applyVisibleChannelSnapshot(nextChannels: Channel[]): void {
    this.hooks.flushAliases();
    this.hooks.applyVisibleChannelSnapshot(nextChannels);
  }

  removeChannel(channel: Channel): void {
    this.hooks.flushAliases();
    this.hooks.removeChannel(channel);
  }

  mergeMember(member: Member): void {
    if (!member?.member_id) return;
    const nextMember = { ...member, role_ids: member.role_ids ?? [] };
    const members = this.hooks.members();
    const exists = members.some((item) => item.member_id === nextMember.member_id);
    this.hooks.setMembers(exists
      ? members.map((item) => (item.member_id === nextMember.member_id ? nextMember : item))
      : [...members, nextMember].sort((left, right) => left.display_name.localeCompare(right.display_name)));
    if (nextMember.member_id === this.hooks.memberId()) {
      this.hooks.setIsOwner(nextMember.is_owner);
    }
  }

  removeMember(member: Member): void {
    if (!member?.member_id) return;
    this.hooks.setMembers(this.hooks.members().filter((item) => item.member_id !== member.member_id));
    const voiceState = this.hooks.voiceState();
    voiceState.voiceStates = voiceState.voiceStates.filter((state) => state.member_id !== member.member_id);
  }

  mergeMessage(message: Message): void {
    this.hooks.flushAliases();
    this.hooks.mergeMessage(message);
  }

  mergeMessages(nextMessages: Message[]): void {
    this.hooks.flushAliases();
    this.hooks.mergeMessages(nextMessages);
  }

  removeMessage(message: Message): void {
    this.hooks.flushAliases();
    this.hooks.removeMessage(message);
  }

  restartLocalVoiceTransportAfterMove(nextState: VoiceState): void {
    const generation = this.hooks.bumpVoiceMoveSoundGeneration();
    this.hooks.playUISound("channel-leave");
    void this.hooks.ensureCurrentVoiceTransport(nextState, true)
      .then(() => {
        const currentState = this.hooks.currentVoiceState();
        if (
          generation !== this.hooks.voiceMoveSoundGeneration() ||
          currentState?.participant_id !== nextState.participant_id ||
          currentState.channel_id !== nextState.channel_id ||
          this.hooks.voiceConnectionStatus() !== "connected"
        ) return;
        this.hooks.playUISound("channel-join");
      })
      .catch((caught) => {
        if (generation !== this.hooks.voiceMoveSoundGeneration()) return;
        this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.voiceJoinFailed"));
      });
  }

  scheduleVoiceAutoRejoin(lostChannelId: string): void {
    // Only rejoin when the loss was discovered while recovering from a
    // reconnect or a browser return (armed by the reconnect recovery path).
    // A live "voice.state.deleted" while we stayed online is an intentional
    // leave from another device or a moderator action and must not rejoin.
    if (this.voiceRejoinArmedForChannelId !== lostChannelId) return;
    this.voiceRejoinArmedForChannelId = "";
    const channel = this.hooks.channels().find((item) => item.channel_id === lostChannelId);
    if (!channel || !this.hooks.isVoiceChannel(channel) || !this.hooks.sessionToken() || !this.hooks.memberId()) return;
    if (this.pendingVoiceAutoRejoinChannelId || this.voiceAutoRejoinInFlight) return;
    this.pendingVoiceAutoRejoinChannelId = lostChannelId;
    window.setTimeout(() => {
      this.pendingVoiceAutoRejoinChannelId = "";
      void this.attemptVoiceAutoRejoin(lostChannelId);
    }, 400);
  }

  private async attemptVoiceAutoRejoin(channelId: string): Promise<void> {
    if (
      this.hooks.voiceActionBusy() ||
      this.hooks.voiceState().voiceConnectionContext ||
      !this.hooks.sessionToken()
    ) return;
    this.voiceAutoRejoinInFlight = true;
    try {
      await this.hooks.joinVoiceRoom(channelId, { silent: true });
    } catch {
      this.hooks.setError(this.hooks.translate("voice.autoRejoinFailed"));
    } finally {
      this.voiceAutoRejoinInFlight = false;
    }
  }

  mergeScreenShareSession(session: ScreenShareSession): void {
    this.hooks.screenShareMergeSession(session);
  }

  replaceScreenShareSessions(sessions: ScreenShareSession[]): void {
    this.hooks.screenShareReplaceSessions(sessions);
  }

  async syncNativeScreenShareViewersFromSession(session: ScreenShareSession): Promise<void> {
    const senderSession = this.hooks.nativeScreenShareSenderSession();
    if (!senderSession || senderSession.shareId !== session.share_id || !isTauriRuntime()) return;
    const watchingMemberIds = new Set(
      (session.viewer_member_ids ?? []).filter((viewerId) => viewerId !== this.hooks.memberId())
    );
    const voiceStatesByParticipant = new Map<string, { member_id: string }>(
      this.hooks.voiceState().voiceStates.map((state) => [state.participant_id, state])
    );
    const staleViewerPeerIds = staleNativeScreenShareViewerPeerIds(
      this.hooks.nativeScreenShareRegisteredViewerIds(),
      this.hooks.screenShareWatcherSessionIds().keys(),
      watchingMemberIds,
      voiceStatesByParticipant
    );
    let changed = false;
    try {
      for (const viewerPeerId of staleViewerPeerIds) {
        const status = await removeNativeScreenShareSenderViewer(
          senderSession.sessionId,
          viewerPeerId,
          this.hooks.screenShareWatcherSessionIds().get(viewerPeerId) ?? ""
        );
        if (this.hooks.nativeScreenShareSenderSession()?.sessionId !== senderSession.sessionId) return;
        this.hooks.applyNativeScreenShareSenderStatus(status);
        this.hooks.setNativeScreenShareRegisteredViewerIds(
          withoutSetValue(this.hooks.nativeScreenShareRegisteredViewerIds(), viewerPeerId)
        );
        this.hooks.setNativeScreenShareAppliedAnswerMemberIds(
          withoutSetValue(this.hooks.nativeScreenShareAppliedAnswerMemberIds(), viewerPeerId)
        );
        changed = true;
      }
      if (changed) {
        await this.hooks.forwardNativeScreenShareSenderSignals(senderSession.sessionId);
        if (this.hooks.nativeScreenShareSenderSession()?.sessionId !== senderSession.sessionId) return;
        this.hooks.scheduleNativeScreenShareSignalFlush(senderSession.sessionId);
      }
    } catch (caught) {
      if (this.hooks.nativeScreenShareSenderSession()?.sessionId !== senderSession.sessionId) return;
      this.hooks.setNativeScreenShareSenderStatus(
        this.hooks.nativeScreenShareSenderStatus()
          ? {
              ...this.hooks.nativeScreenShareSenderStatus()!,
              lastError: caught instanceof Error ? caught.message : this.hooks.translate("error.screenShareWatchFailed")
            }
          : this.hooks.nativeScreenShareSenderStatus()
      );
    }
  }

  // ---- teardown ---------------------------------------------------------------

  dispose(): void {
    this.detachWindowListeners();
    this.closeEventSocket();
    this.closeVoiceEventSocket();
    this.stopVoiceStatesRefreshLoop();
  }
}

function waitForEventSocketOpen(socket: WebSocket, timeoutMS: number): Promise<boolean> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve(true);
  if (socket.readyState !== WebSocket.CONNECTING) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("close", handleClose);
      socket.removeEventListener("error", handleClose);
      resolve(result);
    };
    const handleOpen = () => finish(true);
    const handleClose = () => finish(false);
    const timeout = window.setTimeout(() => finish(socket.readyState === WebSocket.OPEN), timeoutMS);
    socket.addEventListener("open", handleOpen, { once: true });
    socket.addEventListener("close", handleClose, { once: true });
    socket.addEventListener("error", handleClose, { once: true });
  });
}
