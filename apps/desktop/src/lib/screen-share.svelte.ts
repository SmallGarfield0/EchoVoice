// Screen share session registry and watch lifecycle.
//
// Owns the server-authoritative screen share session list, the local watch
// state machine (watch requests, retry/backoff timers, reconnect scheduling,
// per-share status), and the signaling helpers for share watch/unwatch
// dispatch. The WebRTC media mesh (peer connections, stats, SDP handlers) and
// the sender-side capture pipeline remain in the workspace component and are
// reached through hooks.
//
// Hot-path discipline: signaling handlers must read this state directly; the
// component's legacy `$:` aliases feed templates only.

import { drainScreenShareSignals, getScreenShareSessions, sendScreenShareSignal, setScreenShareViewer } from "./api";
import type { ScreenShareSession, RTCSignal, VoiceState } from "./types";
import type { ScreenSharePathKind } from "./screenSharePath";
import { screenSharePathStatusSuffix } from "./screenSharePath";
import { screenShareWatchShouldGiveUp } from "./screenShareLiveness";
import { screenSharePathHintIsRelayOnly, takeScreenSharePathHint } from "./screenSharePathHint";
import { noteScreenShareWatchDecision } from "./screenShareWatchLog";
import { screenShareFrameRateSuffix, screenShareResolutionSuffix } from "./screenShareStreamLabel";

import type { ScreenShareReceiverMetrics } from "./screenShareReceiverStats";

export type ScreenShareWatchStatus = {
  receiverMetrics?: ScreenShareReceiverMetrics;
  stage: "watch-sent" | "offer-received" | "answer-sent" | "track-received" | "stalled" | "failed";
  attempts: number;
  updatedAtMS: number;
  bytesReceived?: number;
  packetsReceived?: number;
  framesDecoded?: number;
  frameStatsSupported?: boolean;
  lastPlaybackProgressAtMS?: number;
  transportBytesReceived?: number;
  lastTransportProgressAtMS?: number;
  /** Which ICE path the media is on, once a candidate pair has been selected. */
  pathKind?: ScreenSharePathKind;
  /** Delivered picture size, so a viewer can tell "blurry" from "small". */
  frameWidth?: number;
  frameHeight?: number;
  /** Delivered frame rate, so a viewer can tell "juddery" from "small". */
  frameRate?: number;
  error?: string;
};

export type ScreenShareHooks = {
  memberId: () => string;
  sessionToken: () => string;
  baseUrl: () => string;
  eventSocket: () => WebSocket | null;
  currentVoiceState: () => VoiceState | null;
  translate: (key: string, params?: Record<string, unknown>) => string;
  setError: (message: string) => void;
  prepareVoiceAudioPlayback: () => void;
  openScreenShareViewer: (share: ScreenShareSession) => void;
  closeScreenShareViewerPanel: () => void;
  clearRemoteControlsForShare: (shareId: string) => void;
  releaseActiveRemoteControlCapture: () => void;
  currentMemberRemoteControlForShare: (shareId: string) => unknown;
  remoteControlCaptureControlId: () => string;
  screenShareVolumeMenuShareId: () => string;
  setScreenShareVolumeMenuShareId: (shareId: string) => void;
  focusedScreenShareId: () => string;
  setFocusedScreenShareId: (shareId: string) => void;
  poppedOutScreenShareIds: () => Set<string>;
  setPoppedOutScreenShareIds: (ids: Set<string>) => void;
  screenShareViewerPanelShareId: () => string;
  syncViewerScreenShareSignalPolling: () => void;
  stopWebScreenShareSignalPolling: () => void;
  closeAllScreenSharePeerConnections: () => void;
  closeScreenSharePeerConnection: (identity: string) => void;
  stopLocalScreenShareStream: (options: { programmatic: boolean }) => void;
  stopCurrentNativeScreenShareSender: () => void;
  clearScreenShareWatchers: () => void;
  screenShareOwnerPeerId: (share: ScreenShareSession) => string;
  screenSharePeerConnection: (peerId: string) => RTCPeerConnection | undefined;
  /** The connection feeding a share, found by share rather than by peer id. */
  screenSharePeerConnectionForShare: (shareId: string) => RTCPeerConnection | undefined;
  screenShareMemberIdForPeer: (peerId: string) => string;
  enqueueScreenShareSignal: (signal: RTCSignal) => void;
  handleRTCSignal: (signal: RTCSignal) => Promise<void>;
  handleScreenShareOfferSignal: (signal: RTCSignal) => Promise<void>;
  handleScreenShareAnswerSignal: (signal: RTCSignal) => Promise<void>;
  handleScreenShareIceCandidateSignal: (signal: RTCSignal) => Promise<void>;
  handleScreenShareIceRestartSignal: (signal: RTCSignal) => Promise<void>;
  /** Refresh TURN credentials when they are close to expiring, then return. */
  ensureFreshRTCConfig: () => Promise<void>;
  /** When the ICE server list in use was fetched; 0 means "never". */
  rtcIceConfigFetchedAtMS: () => number;
  shouldHandleScreenShareMediaSignal: (fromMemberId: string) => boolean;
  addOutgoingScreenShareForMember: (targetMemberId: string, watchSessionId: string) => Promise<void>;
  syncNativeScreenShareViewersFromSession: (session: ScreenShareSession) => void;
  applyNativeScreenShareSenderStatus: (status: unknown, phase: string) => void;
  addNativeScreenShareSenderViewer: (
    sessionId: string,
    peerId: string,
    watchSessionId: string,
    relayOnly?: boolean
  ) => Promise<unknown>;
  removeNativeScreenShareSenderViewer: (sessionId: string, peerId: string, watchSessionId: string) => Promise<unknown>;
  forwardNativeScreenShareSenderSignals: (sessionId: string) => Promise<void>;
  scheduleNativeScreenShareSignalFlush: (sessionId: string) => void;
  nativeScreenShareSenderSession: () => { sessionId: string; shareId: string } | null;
  nativeScreenShareAppliedAnswerMemberIds: () => Set<string>;
  setNativeScreenShareAppliedAnswerMemberIds: (ids: Set<string>) => void;
  nativeScreenShareRegisteredViewerIds: () => Set<string>;
  setNativeScreenShareRegisteredViewerIds: (ids: Set<string>) => void;
  screenShareWatcherSessionIds: () => Map<string, string>;
  screenShareWatchers: () => Set<string>;
  addScreenShareWatcher: (peerId: string) => void;
  removeScreenShareWatcher: (peerId: string) => void;
  voiceStatesByParticipant: () => Map<string, VoiceState>;
  voiceStatesByMember: () => Map<string, VoiceState>;
  currentMemberScreenShare: () => ScreenShareSession | undefined;
  webOwnedShareReady: (shareId: string) => boolean;
};

export class ScreenShareController {
  sessions = $state<ScreenShareSession[]>([]);
  focusedScreenShareId = $state("");
  remoteStreams = $state(new Map<string, MediaStream>());
  watchedShareIds = $state<Set<string>>(new Set());
  watchStatuses = $state<Map<string, ScreenShareWatchStatus>>(new Map());
  watchingBusyIds = $state<Set<string>>(new Set());
  watchSessionIds = new Map<string, string>();
  watchRequests = new Map<string, Promise<boolean>>();
  watchRetryTimers = new Map<string, number[]>();
  reconnectTimers = new Map<string, number>();
  reconnectDeadlines = new Map<string, number>();
  /** When the current watch attempt last rendered a frame; bounds the rebuild loop. */
  watchGiveUpFromMS = new Map<string, number>();
  watchers = new Set<string>();
  watcherSessionIds = new Map<string, string>();
  pendingOwnedWatchSignals = new Map<string, RTCSignal>();
  recentSignalFingerprints = new Map<string, number>();
  private pendingSignalCount = 0;
  private signalProcessingQueue: Promise<void> = Promise.resolve();
  // A screen that is not changing produces no encoded frames at all, so "no
  // decoded frames" cannot mean "broken". The nominated ICE pair still carries
  // STUN consent checks and RTCP, which is what a live path looks like while the
  // sender is idle. Only silence on the pair for this long is a real stall.
  private transportStallThresholdMS = 15_000;

  private hooks: ScreenShareHooks;

  constructor(hooks: ScreenShareHooks) {
    this.hooks = hooks;
  }

  // ---- session registry ------------------------------------------------------

  mergeScreenShareSession(session: ScreenShareSession): void {
    if (!session?.share_id) return;
    session = { ...session, viewer_member_ids: session.viewer_member_ids ?? [] };
    const withoutOwner = this.sessions.filter(
      (item) => item.share_id !== session.share_id && item.owner_member_id !== session.owner_member_id
    );
    this.sessions = [...withoutOwner, session].sort((left, right) => {
      if (left.channel_id !== right.channel_id) return left.channel_id.localeCompare(right.channel_id);
      if (left.started_at_ms !== right.started_at_ms) return left.started_at_ms - right.started_at_ms;
      return left.share_id.localeCompare(right.share_id);
    });
    if (session.owner_member_id === this.hooks.memberId() && this.hooks.nativeScreenShareSenderSession()?.shareId === session.share_id) {
      this.hooks.syncNativeScreenShareViewersFromSession(session);
    }
  }

  replaceScreenShareSessions(sessions: ScreenShareSession[]): void {
    const normalized = sessions
      .filter((session) => Boolean(session?.share_id))
      .map((session) => ({ ...session, viewer_member_ids: session.viewer_member_ids ?? [] }))
      .sort((left, right) => {
        if (left.channel_id !== right.channel_id) return left.channel_id.localeCompare(right.channel_id);
        if (left.started_at_ms !== right.started_at_ms) return left.started_at_ms - right.started_at_ms;
        return left.share_id.localeCompare(right.share_id);
      });
    this.sessions = normalized;
    const ownedShare = normalized.find(
      (session) => session.owner_member_id === this.hooks.memberId() && session.share_id === this.hooks.nativeScreenShareSenderSession()?.shareId
    );
    if (ownedShare) {
      this.hooks.syncNativeScreenShareViewersFromSession(ownedShare);
    }
  }

  async refreshScreenShareSessions(): Promise<void> {
    const sessionToken = this.hooks.sessionToken();
    if (!sessionToken) return;
    try {
      this.replaceScreenShareSessions(await getScreenShareSessions(this.hooks.baseUrl(), sessionToken));
    } catch {
      // WebSocket remains the primary source; refresh failures should not interrupt voice.
    }
  }

  screenShareForMember(memberIdValue: string): ScreenShareSession | undefined {
    return this.sessions.find((share) => share.owner_member_id === memberIdValue);
  }

  removeScreenShareSession(session: ScreenShareSession): void {
    if (!session?.share_id) return;
    const endingCurrentMemberShare = this.hooks.currentMemberScreenShare()?.share_id === session.share_id;
    this.sessions = this.sessions.filter((item) => item.share_id !== session.share_id);
    this.hooks.clearRemoteControlsForShare(session.share_id);
    this.watchedShareIds = withoutSetValue(this.watchedShareIds, session.share_id);
    this.hooks.syncViewerScreenShareSignalPolling();
    this.hooks.setPoppedOutScreenShareIds(withoutSetValue(this.hooks.poppedOutScreenShareIds(), session.share_id));
    this.watchingBusyIds = withoutSetValue(this.watchingBusyIds, session.share_id);
    this.clearWatchRetryTimers(session.share_id);
    this.clearReconnectTimer(session.share_id);
    this.clearWatchSession(session.share_id);
    this.clearWatchStatus(session.share_id);
    this.watchGiveUpFromMS.delete(session.share_id);
    if (this.hooks.screenShareViewerPanelShareId() === session.share_id) {
      this.hooks.closeScreenShareViewerPanel();
    }
    if (this.hooks.focusedScreenShareId() === session.share_id) {
      this.hooks.setFocusedScreenShareId("");
    }
    if (session.owner_member_id === this.hooks.memberId() && endingCurrentMemberShare) {
      this.hooks.stopWebScreenShareSignalPolling();
      this.hooks.closeAllScreenSharePeerConnections();
      this.hooks.clearScreenShareWatchers();
      this.hooks.stopLocalScreenShareStream({ programmatic: true });
      void this.hooks.stopCurrentNativeScreenShareSender();
    } else {
      this.hooks.closeScreenSharePeerConnection(session.owner_participant_id || session.owner_member_id);
    }
  }

  // ---- watch state machine ----------------------------------------------------

  canWatchScreenShare(share: ScreenShareSession): boolean {
    const state = this.hooks.currentVoiceState();
    const socket = this.hooks.eventSocket();
    return Boolean(
      share.owner_member_id !== this.hooks.memberId() &&
        state &&
        state.channel_id === share.channel_id &&
        this.hooks.sessionToken() &&
        socket &&
        socket.readyState === WebSocket.OPEN
    );
  }

  isWatchingScreenShare(share: ScreenShareSession): boolean {
    return this.watchedShareIds.has(share.share_id);
  }

  isScreenShareWatchBusy(share: ScreenShareSession): boolean {
    return this.watchingBusyIds.has(share.share_id);
  }

  setWatchStatus(shareId: string, update: Partial<Omit<ScreenShareWatchStatus, "updatedAtMS">>): void {
    if (!shareId) return;
    if (update.stage === "track-received") {
      // A frame arrived, so the clock that bounds the rebuild loop restarts.
      this.watchGiveUpFromMS = new Map(this.watchGiveUpFromMS).set(shareId, Date.now());
    }
    const current = this.watchStatuses.get(shareId);
    this.watchStatuses = new Map(this.watchStatuses).set(shareId, {
      stage: update.stage ?? current?.stage ?? "watch-sent",
      attempts: update.attempts ?? current?.attempts ?? 0,
      bytesReceived: update.bytesReceived ?? current?.bytesReceived,
      packetsReceived: update.packetsReceived ?? current?.packetsReceived,
      framesDecoded: update.framesDecoded ?? current?.framesDecoded,
      frameStatsSupported: update.frameStatsSupported ?? current?.frameStatsSupported,
      lastPlaybackProgressAtMS: update.lastPlaybackProgressAtMS ?? current?.lastPlaybackProgressAtMS,
      transportBytesReceived: update.transportBytesReceived ?? current?.transportBytesReceived,
      lastTransportProgressAtMS: update.lastTransportProgressAtMS ?? current?.lastTransportProgressAtMS,
      pathKind: update.pathKind ?? current?.pathKind,
      frameWidth: update.frameWidth ?? current?.frameWidth,
      frameHeight: update.frameHeight ?? current?.frameHeight,
      frameRate: "frameRate" in update ? update.frameRate : current?.frameRate,
      receiverMetrics: update.receiverMetrics ?? current?.receiverMetrics,
      error: update.error ?? (update.stage === "failed" ? current?.error : undefined),
      updatedAtMS: Date.now()
    });
    queueMicrotask(() => this.hooks.syncViewerScreenShareSignalPolling());
  }

  updateWatchStatusForOwner(ownerMemberId: string, update: Partial<Omit<ScreenShareWatchStatus, "updatedAtMS">>): void {
    const share =
      this.sessions.find(
        (item) => item.owner_member_id === ownerMemberId && this.watchedShareIds.has(item.share_id)
      ) ?? this.screenShareForMember(ownerMemberId);
    if (!share) return;
    this.setWatchStatus(share.share_id, update);
  }

  updateWatchStatusForShare(shareId: string, update: Partial<Omit<ScreenShareWatchStatus, "updatedAtMS">>): void {
    if (!shareId) return;
    this.setWatchStatus(shareId, update);
  }

  clearWatchStatus(shareId: string): void {
    if (!this.watchStatuses.has(shareId)) return;
    const next = new Map(this.watchStatuses);
    next.delete(shareId);
    this.watchStatuses = next;
  }

  watchFailed(shareId: string): boolean {
    return this.watchStatuses.get(shareId)?.stage === "failed";
  }

  watchStatusLabel(share: ScreenShareSession | undefined): string {
    if (!share) return "";
    const status = this.watchStatuses.get(share.share_id);
    if (!status) return this.hooks.translate("screenShare.waitingForVideo");
    if (status.stage === "failed") return status.error || this.hooks.translate("error.screenShareWatchFailed");
    if (status.stage === "offer-received") return this.hooks.translate("screenShare.watchStatusOfferReceived");
    if (status.stage === "answer-sent") {
      return `${this.hooks.translate("screenShare.watchStatusAnswerSent")}${this.watchStatusPathSuffix(status)}`;
    }
    if (status.stage === "track-received") return `${this.hooks.translate("screenShare.receiving")}${this.watchStatusResolutionSuffix(status)}${this.watchStatusFrameRateSuffix(status)}${this.watchStatusPathSuffix(status)}`;
    if (status.stage === "stalled") return `${this.hooks.translate("screenShare.watchStatusStalled")}${this.watchStatusResolutionSuffix(status)}${this.watchStatusFrameRateSuffix(status)}${this.watchStatusPathSuffix(status)}`;
    return this.hooks.translate("screenShare.watchStatusSent", { attempt: Math.max(1, status.attempts) });
  }

  // The delivered size answers "is it blurry because the encoder dropped
  // resolution, or because the sharer is only sending 720p?" - a question the
  // path label alone cannot settle.
  private watchStatusResolutionSuffix(status: ScreenShareWatchStatus): string {
    return screenShareResolutionSuffix(status.frameWidth, status.frameHeight);
  }

  // The delivered rate answers the other half: a sharp 8 fps picture is a
  // bandwidth problem, and the resolution alone would make it look fine.
  private watchStatusFrameRateSuffix(status: ScreenShareWatchStatus): string {
    return screenShareFrameRateSuffix(status.frameRate);
  }

  // The path belongs to the connection, not to the picture: naming it only
  // once frames arrive hides it exactly when it is asked about (the share that
  // never starts). A stalled share still knows which path carried it.
  private watchStatusPathSuffix(status: ScreenShareWatchStatus): string {
    return screenSharePathStatusSuffix(status.pathKind, (key) => this.hooks.translate(key));
  }

  createWatchSessionId(): string {
    if (typeof crypto.randomUUID === "function") {
      return `watch_${crypto.randomUUID()}`;
    }
    const entropy = new Uint32Array(4);
    crypto.getRandomValues(entropy);
    return `watch_${Date.now().toString(36)}_${Array.from(entropy, (value) => value.toString(36)).join("")}`;
  }

  beginWatchSession(shareId: string): string {
    const watchSessionId = this.createWatchSessionId();
    this.watchSessionIds = new Map(this.watchSessionIds).set(shareId, watchSessionId);
    return watchSessionId;
  }

  clearWatchSession(shareId: string): void {
    if (!this.watchSessionIds.has(shareId)) return;
    const next = new Map(this.watchSessionIds);
    next.delete(shareId);
    this.watchSessionIds = next;
  }

  async sendWatchRequest(share: ScreenShareSession): Promise<boolean> {
    const pending = this.watchRequests.get(share.share_id);
    if (pending) return pending;
    const request = (async () => {
      const current = this.watchStatuses.get(share.share_id);
      const attempts = (current?.attempts ?? 0) + 1;
      const watchSessionId = this.watchSessionIds.get(share.share_id) ?? this.beginWatchSession(share.share_id);
      this.setWatchStatus(share.share_id, {
        stage: "watch-sent",
        attempts
      });
      const sessionToken = this.hooks.sessionToken();
      if (!sessionToken) return false;
      try {
        const updated = await setScreenShareViewer(this.hooks.baseUrl(), sessionToken, share.share_id, true, watchSessionId);
        if (
          this.watchSessionIds.get(share.share_id) !== watchSessionId ||
          !this.watchedShareIds.has(share.share_id)
        ) {
          return false;
        }
        this.mergeScreenShareSession(updated);
        return true;
      } catch (caught) {
        if (
          this.watchSessionIds.get(share.share_id) === watchSessionId &&
          this.watchedShareIds.has(share.share_id)
        ) {
          this.setWatchStatus(share.share_id, {
            stage: "failed",
            attempts,
            error: caught instanceof Error ? caught.message : this.hooks.translate("error.screenShareWatchFailed")
          });
        }
        return false;
      }
    })();
    this.watchRequests.set(share.share_id, request);
    try {
      return await request;
    } finally {
      if (this.watchRequests.get(share.share_id) === request) {
        this.watchRequests.delete(share.share_id);
      }
    }
  }

  scheduleWatchRetries(share: ScreenShareSession): void {
    this.clearWatchRetryTimers(share.share_id);
    const requestTimers = [700, 1800, 3600, 6500].map((delay) =>
      window.setTimeout(() => {
        const latestShare = this.sessions.find((item) => item.share_id === share.share_id);
        if (!latestShare || !this.watchedShareIds.has(share.share_id)) return;
        if (this.remoteStreams.has(latestShare.owner_member_id)) return;
        const status = this.watchStatuses.get(latestShare.share_id);
        if (
          status &&
          status.stage !== "watch-sent" &&
          status.stage !== "failed"
        ) {
          return;
        }
        if (!this.canWatchScreenShare(latestShare)) {
          this.setWatchStatus(latestShare.share_id, {
            stage: "failed",
            error: this.hooks.currentVoiceState()?.channel_id === latestShare.channel_id ? this.hooks.translate("events.reconnecting") : this.hooks.translate("screenShare.joinVoiceToWatch")
          });
          return;
        }
        void this.sendWatchRequest(latestShare);
      }, delay)
    );
    const recoveryTimer = window.setTimeout(() => {
      const latestShare = this.sessions.find((item) => item.share_id === share.share_id);
      if (!latestShare || !this.watchedShareIds.has(share.share_id) || this.playbackHealthy(latestShare)) return;
      const status = this.watchStatuses.get(latestShare.share_id);
      // This timer exists to retry a watch that produced nothing at all. If any
      // bytes or frames already arrived, the picture is not a failed watch, and
      // rebuilding here would tear down a stream that is already on screen.
      const arrivedAlready =
        (status?.framesDecoded ?? 0) > 0 || (status?.bytesReceived ?? 0) > 0 || (status?.packetsReceived ?? 0) > 0;
      if (arrivedAlready) return;
      this.scheduleReconnect(share.share_id, 0);
    }, 9000);
    const timers = [...requestTimers, recoveryTimer];
    this.watchRetryTimers = new Map(this.watchRetryTimers).set(share.share_id, timers);
  }

  clearWatchRetryTimers(shareId: string): void {
    const timers = this.watchRetryTimers.get(shareId) ?? [];
    for (const timer of timers) {
      window.clearTimeout(timer);
    }
    if (!this.watchRetryTimers.has(shareId)) return;
    const next = new Map(this.watchRetryTimers);
    next.delete(shareId);
    this.watchRetryTimers = next;
  }

  clearAllWatchRetryTimers(): void {
    for (const timers of this.watchRetryTimers.values()) {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    }
    this.watchRetryTimers = new Map();
  }

  clearReconnectTimer(shareId: string): void {
    const timer = this.reconnectTimers.get(shareId);
    if (timer) window.clearTimeout(timer);
    const next = new Map(this.reconnectTimers);
    next.delete(shareId);
    this.reconnectTimers = next;
    const nextDeadlines = new Map(this.reconnectDeadlines);
    nextDeadlines.delete(shareId);
    this.reconnectDeadlines = nextDeadlines;
  }

  clearAllReconnectTimers(): void {
    for (const timer of this.reconnectTimers.values()) {
      window.clearTimeout(timer);
    }
    this.reconnectTimers = new Map();
    this.reconnectDeadlines = new Map();
  }

  playbackHealthy(share: ScreenShareSession): boolean {
    // Two lookups on purpose. The peer id of a share can be a participant id or
    // a member id depending on which side of the connection it came from, and a
    // mismatch here used to look exactly like a dead stream: frames were being
    // decoded while this returned false, so the 9 s watchdog rebuilt a healthy
    // connection over and over. The share binding is authoritative.
    const connection =
      this.hooks.screenSharePeerConnection(this.hooks.screenShareOwnerPeerId(share)) ??
      this.hooks.screenSharePeerConnectionForShare(share.share_id);
    const stream = this.remoteStreams.get(share.owner_member_id);
    const status = this.watchStatuses.get(share.share_id);
    const hasLiveVideo = Boolean(stream?.getVideoTracks().some((track) => track.readyState === "live"));
    const hasMedia = status?.frameStatsSupported
      ? (status.framesDecoded ?? 0) > 0
      : (status?.bytesReceived ?? 0) > 0 || (status?.packetsReceived ?? 0) > 0;
    // A still desktop legitimately sends no frames for as long as nothing
    // changes, so decoded frames cannot prove that the stream is alive. The
    // nominated ICE pair keeps carrying consent checks and RTCP while the
    // sender is idle, which is the signal that actually tracks liveness.
    // A hidden tab stops running the stats timer, so its last sample is stale
    // rather than meaningful; the transport state still guards against a dead
    // connection there.
    const documentHidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    const transportRecentlyAdvanced = documentHidden || Boolean(
      status?.lastTransportProgressAtMS &&
        Date.now() - status.lastTransportProgressAtMS < this.transportStallThresholdMS
    );
    const transportConnected =
      connection?.connectionState === "connected" ||
      connection?.iceConnectionState === "connected" ||
      connection?.iceConnectionState === "completed";
    return Boolean(
      connection &&
        hasLiveVideo &&
        hasMedia &&
        transportRecentlyAdvanced &&
        transportConnected
    );
  }

  scheduleReconnect(shareId: string, delayMS = 1200): void {
    if (!shareId || !this.watchedShareIds.has(shareId) || this.watchingBusyIds.has(shareId)) return;
    const deadline = Date.now() + Math.max(0, delayMS);
    const existingDeadline = this.reconnectDeadlines.get(shareId);
    if (existingDeadline !== undefined && existingDeadline <= deadline) return;
    this.clearReconnectTimer(shareId);
    const timer = window.setTimeout(() => {
      this.clearReconnectTimer(shareId);
      const share = this.sessions.find((item) => item.share_id === shareId);
      if (!share || !this.watchedShareIds.has(shareId) || this.playbackHealthy(share)) return;
      if (this.watchingBusyIds.has(shareId)) return;
      if (!this.canWatchScreenShare(share)) return;
      if (screenShareWatchShouldGiveUp(this.watchGiveUpFromMS.get(shareId), Date.now())) {
        // The session is still advertised but no frame has arrived for long
        // enough that rebuilding again would only make the sharer encode one
        // more stream nobody renders. Stop; the user can press watch again.
        this.setWatchStatus(shareId, {
          stage: "failed",
          error: this.hooks.translate("screenShare.watchUnavailable")
        });
        return;
      }
      void this.startWatchingScreenShare(share);
    }, delayMS);
    this.reconnectTimers = new Map(this.reconnectTimers).set(shareId, timer);
    this.reconnectDeadlines = new Map(this.reconnectDeadlines).set(shareId, deadline);
  }

  async toggleWatchScreenShare(share: ScreenShareSession): Promise<void> {
    if (this.isScreenShareWatchBusy(share)) return;
    if (this.isWatchingScreenShare(share)) {
      // A failed watch is still "watching" as far as the session bookkeeping is
      // concerned, so the same button is the only way back in. Retrying beats
      // making the user press stop and then watch again.
      if (this.watchFailed(share.share_id)) {
        await this.retryWatchingScreenShare(share);
        return;
      }
      await this.stopWatchingScreenShare(share);
      return;
    }
    await this.startWatchingScreenShare(share);
  }

  async retryWatchingScreenShare(share: ScreenShareSession): Promise<void> {
    if (this.isScreenShareWatchBusy(share)) return;
    // The give-up clock only starts on a first attempt, so a retry has to restart
    // it here. Without this the new attempt inherits the deadline that just
    // expired and gives up before it can open a connection.
    this.watchGiveUpFromMS = new Map(this.watchGiveUpFromMS).set(share.share_id, Date.now());
    this.clearWatchStatus(share.share_id);
    if (this.isWatchingScreenShare(share)) {
      await this.stopWatchingScreenShare(share);
    }
    await this.startWatchingScreenShare(share);
  }

  async startWatchingScreenShare(share: ScreenShareSession): Promise<void> {
    if (share.owner_member_id === this.hooks.memberId() || this.isScreenShareWatchBusy(share)) return;
    // Only the first attempt starts the clock; rebuilds keep it running so the
    // give-up deadline measures "no frame since the user pressed watch".
    const firstAttempt = !this.watchedShareIds.has(share.share_id);
    this.hooks.prepareVoiceAudioPlayback();
    this.watchingBusyIds = withSetValue(this.watchingBusyIds, share.share_id);
    this.hooks.setError("");
    try {
      if (!this.canWatchScreenShare(share)) {
        this.hooks.setError(this.hooks.currentVoiceState()?.channel_id === share.channel_id ? this.hooks.translate("events.reconnecting") : this.hooks.translate("screenShare.joinVoiceToWatch"));
        return;
      }
      this.clearReconnectTimer(share.share_id);
      this.beginWatchSession(share.share_id);
      this.hooks.closeScreenSharePeerConnection(this.hooks.screenShareOwnerPeerId(share));
      this.clearWatchStatus(share.share_id);
      if (firstAttempt) {
        this.watchGiveUpFromMS = new Map(this.watchGiveUpFromMS).set(share.share_id, Date.now());
      }
      this.watchedShareIds = withSetValue(this.watchedShareIds, share.share_id);
      this.hooks.syncViewerScreenShareSignalPolling();
      this.removeRemoteScreenShareStream(share.owner_member_id);
      // A share can outlive the two hour TURN credential, and this is the last
      // moment before a connection is built from that list.
      await this.hooks.ensureFreshRTCConfig();
      if (!(await this.sendWatchRequest(share))) {
        throw new Error(this.hooks.translate("events.reconnecting"));
      }
      this.scheduleWatchRetries(share);
      this.hooks.openScreenShareViewer(share);
    } catch (caught) {
      this.watchedShareIds = withoutSetValue(this.watchedShareIds, share.share_id);
      this.hooks.syncViewerScreenShareSignalPolling();
      this.removeRemoteScreenShareStream(share.owner_member_id);
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.screenShareWatchFailed"));
    } finally {
      this.watchingBusyIds = withoutSetValue(this.watchingBusyIds, share.share_id);
    }
  }

  async stopWatchingScreenShare(share: ScreenShareSession): Promise<void> {
    if (share.owner_member_id === this.hooks.memberId() || this.isScreenShareWatchBusy(share)) return;
    this.watchingBusyIds = withSetValue(this.watchingBusyIds, share.share_id);
    const watchSessionId = this.watchSessionIds.get(share.share_id) ?? "";
    if (this.hooks.screenShareVolumeMenuShareId() === share.share_id) this.hooks.setScreenShareVolumeMenuShareId("");
    const control = this.hooks.currentMemberRemoteControlForShare(share.share_id) as { control_id?: string } | undefined;
    if (control && this.hooks.remoteControlCaptureControlId() === control.control_id) this.hooks.releaseActiveRemoteControlCapture();
    this.watchedShareIds = withoutSetValue(this.watchedShareIds, share.share_id);
    this.hooks.syncViewerScreenShareSignalPolling();
    this.hooks.setPoppedOutScreenShareIds(withoutSetValue(this.hooks.poppedOutScreenShareIds(), share.share_id));
    this.clearWatchRetryTimers(share.share_id);
    this.clearWatchStatus(share.share_id);
    this.watchGiveUpFromMS.delete(share.share_id);
    if (this.hooks.focusedScreenShareId() === share.share_id) {
      this.hooks.setFocusedScreenShareId("");
    }
    this.hooks.closeScreenShareViewerPanel();
    this.hooks.closeScreenSharePeerConnection(this.hooks.screenShareOwnerPeerId(share));
    this.clearReconnectTimer(share.share_id);
    try {
      await this.watchRequests.get(share.share_id);
      if (this.hooks.currentVoiceState()?.channel_id === share.channel_id && this.hooks.sessionToken()) {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 6000);
        try {
          const updated = await setScreenShareViewer(
            this.hooks.baseUrl(),
            this.hooks.sessionToken(),
            share.share_id,
            false,
            watchSessionId,
            controller.signal
          );
          if (this.watchSessionIds.get(share.share_id) === watchSessionId) {
            this.mergeScreenShareSession(updated);
          }
        } finally {
          window.clearTimeout(timeout);
        }
      }
    } catch {
      // The unwatch request is best effort; the server cleans up stale viewers.
    } finally {
      this.clearWatchSession(share.share_id);
      this.watchingBusyIds = withoutSetValue(this.watchingBusyIds, share.share_id);
    }
  }

  // ---- remote stream registry ------------------------------------------------

  setRemoteScreenShareStream(remoteMemberId: string, stream: MediaStream): void {
    const previous = this.remoteStreams.get(remoteMemberId);
    if (previous && previous !== stream) {
      previous.getTracks().forEach((track) => track.stop());
    }
    // Replace the map so the component's $: aliases see the change.
    this.remoteStreams = new Map(this.remoteStreams).set(remoteMemberId, stream);
  }

  removeRemoteScreenShareStream(remoteMemberId: string): void {
    const stream = this.remoteStreams.get(remoteMemberId);
    if (!stream) return;
    stream.getTracks().forEach((track) => track.stop());
    const next = new Map(this.remoteStreams);
    next.delete(remoteMemberId);
    this.remoteStreams = next;
  }

  // ---- signaling helpers ------------------------------------------------------

  enqueueSignal(signal: RTCSignal): void {
    if (this.isDuplicateMediaSignal(signal)) return;
    if (signal.signal_type === "screen-share-ice-candidate" && this.pendingSignalCount >= 256) {
      return;
    }
    this.pendingSignalCount += 1;
    this.signalProcessingQueue = this.signalProcessingQueue
      .catch(() => undefined)
      .then(() => this.hooks.handleRTCSignal(signal))
      .finally(() => {
        this.pendingSignalCount = Math.max(0, this.pendingSignalCount - 1);
      });
  }

  isDuplicateMediaSignal(signal: RTCSignal): boolean {
    if (
      signal.signal_type !== "screen-share-offer" &&
      signal.signal_type !== "screen-share-answer" &&
      signal.signal_type !== "screen-share-ice-candidate"
    ) {
      return false;
    }
    const now = Date.now();
    const ttlMS = 30_000;
    for (const [fingerprint, seenAtMS] of this.recentSignalFingerprints) {
      if (now - seenAtMS <= ttlMS) break;
      this.recentSignalFingerprints.delete(fingerprint);
    }
    const data = JSON.stringify(signal.data ?? null);
    const fingerprint = [
      signal.signal_type,
      signal.from_member_id,
      signal.from_participant_id ?? "",
      signal.target_member_id ?? "",
      signal.target_participant_id ?? "",
      data
    ].join("\u001f");
    const seenAtMS = this.recentSignalFingerprints.get(fingerprint);
    if (seenAtMS !== undefined && now - seenAtMS <= ttlMS) return true;
    this.recentSignalFingerprints.set(fingerprint, now);
    while (this.recentSignalFingerprints.size > 1024) {
      const oldest = this.recentSignalFingerprints.keys().next().value;
      if (typeof oldest !== "string") break;
      this.recentSignalFingerprints.delete(oldest);
    }
    return false;
  }

  signalShareId(signal: RTCSignal): string {
    return screenShareDataShareId(signal.data);
  }

  signalWatchSessionId(signal: RTCSignal): string {
    return screenShareDataWatchSessionId(signal.data);
  }

  signalDescription(signal: RTCSignal): RTCSessionDescriptionInit | null {
    const data = signal.data as { description?: RTCSessionDescriptionInit } | RTCSessionDescriptionInit | null;
    if (data && "description" in data && data.description) return data.description;
    if (data && "type" in data) return data as RTCSessionDescriptionInit;
    return null;
  }

  signalCandidate(signal: RTCSignal): RTCIceCandidateInit | null {
    const data = signal.data as { candidate?: RTCIceCandidateInit } | RTCIceCandidateInit | null;
    if (data && "candidate" in data && typeof data.candidate === "object" && data.candidate) return data.candidate;
    if (data && "candidate" in data && typeof data.candidate === "string") return data as RTCIceCandidateInit;
    return null;
  }

  flushPendingOwnedWatchSignals(shareId: string): void {
    for (const [peerId, signal] of this.pendingOwnedWatchSignals) {
      if (this.signalShareId(signal) !== shareId) continue;
      this.pendingOwnedWatchSignals.delete(peerId);
      this.hooks.enqueueScreenShareSignal(signal);
    }
  }

  async handleWatchSignal(signal: RTCSignal): Promise<void> {
    const watcherPeerId = signal.from_participant_id || signal.from_member_id;
    const shareID = this.signalShareId(signal);
    const senderSession = this.hooks.nativeScreenShareSenderSession();
    const nativeOwned = senderSession?.shareId === shareID;
    const ownedShare =
      this.hooks.currentMemberScreenShare() ??
      this.sessions.find((share) => share.owner_member_id === this.hooks.memberId() && share.share_id === shareID);
    if ((!ownedShare || ownedShare.share_id !== shareID) && !nativeOwned) {
      noteScreenShareWatchDecision(
        `skip:not-owner share=${shareID} owned=${ownedShare?.share_id ?? "none"} ownShares=${
          this.sessions.filter((share) => share.owner_member_id === this.hooks.memberId()).length
        }`
      );
      return;
    }
    const webOwnedReady = Boolean(
      ownedShare?.share_id === shareID && this.hooks.webOwnedShareReady(shareID)
    );
    if (!nativeOwned && !webOwnedReady) {
      noteScreenShareWatchDecision(`skip:not-ready share=${shareID}`);
      this.pendingOwnedWatchSignals.set(watcherPeerId, signal);
      return;
    }
    this.pendingOwnedWatchSignals.delete(watcherPeerId);
    const watcherState = this.hooks.voiceStatesByParticipant().get(watcherPeerId)
      ?? this.hooks.voiceStatesByMember().get(signal.from_member_id);
    const ownedChannelId = ownedShare?.channel_id ?? this.hooks.currentVoiceState()?.channel_id ?? "";
    if (watcherState && ownedChannelId && watcherState.channel_id !== ownedChannelId) {
      noteScreenShareWatchDecision(
        `skip:channel share=${shareID} watcher=${watcherState.channel_id} owner=${ownedChannelId}`
      );
      return;
    }
    const watchSessionId = this.signalWatchSessionId(signal);
    const previousWatchSessionId = this.watcherSessionIds.get(watcherPeerId);
    if (previousWatchSessionId && !watchSessionId) return;
    if (this.watcherSessionIds.has(watcherPeerId) && previousWatchSessionId === watchSessionId) {
      return;
    }
    this.watcherSessionIds.set(watcherPeerId, watchSessionId);
    this.hooks.setNativeScreenShareAppliedAnswerMemberIds(
      withoutSetValue(this.hooks.nativeScreenShareAppliedAnswerMemberIds(), watcherPeerId)
    );
    // The per-viewer connection is created just below; refresh the credentials
    // first so a share that has been running for hours can still relay. A failed
    // refresh must not swallow the watch request: the old credentials still work
    // for the next couple of hours, and answering with them beats never
    // answering at all.
    try {
      await this.hooks.ensureFreshRTCConfig();
    } catch (caught) {
      noteScreenShareWatchDecision(
        `fresh-config-failed share=${shareID} error=${
          caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
        }`
      );
    }
    this.hooks.closeScreenSharePeerConnection(watcherPeerId);
    this.hooks.addScreenShareWatcher(watcherPeerId);
    if (nativeOwned && senderSession) {
      try {
        const status = await this.hooks.addNativeScreenShareSenderViewer(
          senderSession.sessionId,
          watcherPeerId,
          watchSessionId,
          // The viewer tells us when it chose the relay; a relay-only watch has
          // nothing but relay candidates, so the sender's ICE acceptance wait is
          // pure latency in front of nomination and DTLS.
          screenSharePathHintIsRelayOnly(takeScreenSharePathHint(shareID, watcherPeerId))
        );
        if (this.hooks.nativeScreenShareSenderSession()?.sessionId !== senderSession.sessionId) return;
        this.hooks.applyNativeScreenShareSenderStatus(status, "watch-add-viewer");
        this.hooks.setNativeScreenShareRegisteredViewerIds(
          withSetValue(this.hooks.nativeScreenShareRegisteredViewerIds(), watcherPeerId)
        );
        await this.hooks.forwardNativeScreenShareSenderSignals(senderSession.sessionId);
        if (this.hooks.nativeScreenShareSenderSession()?.sessionId !== senderSession.sessionId) return;
        this.hooks.scheduleNativeScreenShareSignalFlush(senderSession.sessionId);
      } catch (caught) {
        if (this.hooks.nativeScreenShareSenderSession()?.sessionId !== senderSession.sessionId) return;
        this.watcherSessionIds.delete(watcherPeerId);
        this.hooks.removeScreenShareWatcher(watcherPeerId);
        this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.screenShareWatchFailed"));
      }
      return;
    }
    try {
      noteScreenShareWatchDecision(`create share=${shareID} watcher=${watcherPeerId}`);
      await this.hooks.addOutgoingScreenShareForMember(watcherPeerId, watchSessionId);
    } catch (caught) {
      noteScreenShareWatchDecision(
        `fail share=${shareID} watcher=${watcherPeerId} error=${
          caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
        }`
      );
      // The sharer is the only party that can observe this failure, and staying
      // silent is what made "the viewer keeps asking and no offer ever appears"
      // look like a server problem for so long. Surface it like the native path.
      this.hooks.setError(
        caught instanceof Error && caught.message
          ? caught.message
          : this.hooks.translate("error.screenShareWatchFailed")
      );
      this.watcherSessionIds.delete(watcherPeerId);
      this.hooks.removeScreenShareWatcher(watcherPeerId);
    }
  }

  async handleUnwatchSignal(signal: RTCSignal): Promise<void> {
    const watcherPeerId = signal.from_participant_id || signal.from_member_id;
    const shareID = this.signalShareId(signal);
    const senderSession = this.hooks.nativeScreenShareSenderSession();
    const nativeOwned = senderSession?.shareId === shareID;
    const ownedShare =
      this.hooks.currentMemberScreenShare() ??
      this.sessions.find((share) => share.owner_member_id === this.hooks.memberId() && share.share_id === shareID);
    if ((!ownedShare || ownedShare.share_id !== shareID) && !nativeOwned) return;
    const watchSessionId = this.signalWatchSessionId(signal);
    const activeWatchSessionId = this.watcherSessionIds.get(watcherPeerId) ?? "";
    if (activeWatchSessionId && watchSessionId !== activeWatchSessionId) return;
    this.pendingOwnedWatchSignals.delete(watcherPeerId);
    this.watcherSessionIds.delete(watcherPeerId);
    this.hooks.removeScreenShareWatcher(watcherPeerId);
    this.hooks.closeScreenSharePeerConnection(watcherPeerId);
    if (nativeOwned && senderSession) {
      try {
        const status = await this.hooks.removeNativeScreenShareSenderViewer(
          senderSession.sessionId,
          watcherPeerId,
          watchSessionId
        );
        if (this.hooks.nativeScreenShareSenderSession()?.sessionId !== senderSession.sessionId) return;
        this.hooks.applyNativeScreenShareSenderStatus(status, "watch-remove-viewer");
        this.hooks.setNativeScreenShareRegisteredViewerIds(
          withoutSetValue(this.hooks.nativeScreenShareRegisteredViewerIds(), watcherPeerId)
        );
        await this.hooks.forwardNativeScreenShareSenderSignals(senderSession.sessionId);
      } catch {
        // Viewer tracking is best effort until native WebRTC sender owns media delivery.
      }
    }
  }

  /** Clears all mesh bookkeeping when the voice session stops. */
  clearWatchers(): void {
    this.watchers.clear();
    this.watcherSessionIds.clear();
    this.pendingOwnedWatchSignals.clear();
  }

  /** Full teardown of watch state (voice session stop / workspace switch). */
  resetWatchState(): void {
    this.clearAllWatchRetryTimers();
    this.clearAllReconnectTimers();
    this.remoteStreams = new Map();
    this.watchSessionIds = new Map();
    this.watchedShareIds = new Set();
    this.watchStatuses = new Map();
    this.watchGiveUpFromMS = new Map();
    this.watchingBusyIds = new Set();
    this.watchers.clear();
    this.watcherSessionIds.clear();
    this.pendingOwnedWatchSignals.clear();
    this.recentSignalFingerprints.clear();
  }
}

function withoutSetValue<T>(source: Set<T>, value: T): Set<T> {
  const next = new Set(source);
  next.delete(value);
  return next;
}

function withSetValue<T>(source: Set<T>, value: T): Set<T> {
  return new Set(source).add(value);
}

function screenShareDataShareId(data: unknown): string {
  return typeof (data as { share_id?: string } | null)?.share_id === "string"
    ? ((data as { share_id: string }).share_id)
    : "";
}

function screenShareDataWatchSessionId(data: unknown): string {
  return typeof (data as { watch_session_id?: string } | null)?.watch_session_id === "string"
    ? ((data as { watch_session_id: string }).watch_session_id)
    : "";
}
