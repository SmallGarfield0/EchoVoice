// Screen share transport: local/native capture, WebRTC peer mesh, stats,
// signaling, popout windows, and the focused viewer panel.
//
// Owns the transport half of the screen share domain. The session registry
// and watch state machine live in ScreenShareController
// (lib/screen-share.svelte.ts); setup/source/quality orchestration lives in
// ScreenShareSetupController (lib/screen-share-setup.svelte.ts). Cross-domain
// side effects are injected through the hooks below, so this controller never
// imports the workspace component.
//
// Hot-path discipline: signaling and media paths read controller state
// directly; component-level `$:` aliases exist only for templates.

import {
  drainScreenShareSignals,
  endScreenShareSession,
  sendScreenShareSignal
} from "./api";
import {
  closeScreenSharePopoutWindow as closeNativeScreenSharePopoutWindow,
  setNativeScreenShareQuality,
  drainNativeScreenShareSenderSignals,
  handleNativeScreenShareSenderSignal,
  loadNativeScreenShareSenderStatus,
  startDraggingScreenSharePopoutWindow,
  startResizingScreenSharePopoutWindow
} from "./storage";
import {
  applyScreenSharePlayoutDelay,
  nextScreenSharePlayoutDelayMS,
  screenShareAudioPlayoutDelayMS,
  screenShareInitialVideoPlayoutDelayMS,
  screenSharePlayoutDelayCeilingMS
} from "./screenSharePlayout";
import type { ScreenSharePlayoutReceiver } from "./screenSharePlayout";
import { enhanceScreenShareOpusSDP } from "./accompaniment";
import { decideScreenSharePathLiveness } from "./screenShareLiveness";
import { attachScreenShareVideo } from "./screenShareVideoBinding";
import { screenShareStreamOwnerMemberId } from "./screenShareStreamKey";
import {
  screenShareConnectionHasFailed,
  screenShareConnectionIsConnecting,
  screenSharePeerReceivesVideo
} from "./screenSharePeerDirection";
import {
  screenShareViewerLayerSuffix,
  summarizeScreenShareViewerLayers
} from "./screenShareViewerPaths";
import {
  decideScreenShareRecovery,
  screenShareIceRestartCooldownMS,
  type ScreenShareRecoveryState
} from "./screenShareIceRestart";
import { screenSharePathKindFromStats, selectScreenShareCandidatePair } from "./screenSharePath";
import {
  decideScreenSharePathSwitch,
  screenShareDirectIceServers,
  screenSharePathQualityIsDegraded,
  screenShareRelayCandidateVerdict
} from "./screenShareAutoRelay";
import type { ScreenSharePathPreference } from "./screenShareAutoRelay";
import { rememberScreenSharePathHint } from "./screenSharePathHint";
import { noteScreenShareWatchDecision } from "./screenShareWatchLog";
import { WebScreenShareQualityController, webScreenShareEncoding } from "./screenShareWebQuality";
import { ScreenShareContentMonitor, type EffectiveScreenContent } from "./screenShareSmartContent";
import { nativePublisherMetrics, nativePublisherSample, type NativePublisherSample } from "./screenShareNativeMetrics";
import { ScreenShareReceiverSampler, type ScreenShareInboundVideo } from "./screenShareReceiverStats";
import type { ScreenSharePathKind } from "./screenSharePath";
import {
  screenShareRelayRotationDue,
  screenShareRelayRotationSpreadMS
} from "./screenShareRelayRotation";
import {
  screenShareContentHint,
  screenShareDegradationPreference
} from "./screenShareSettings";
import {
  deriveScreenShareSenderTelemetry,
  orderScreenShareCodecs,
  type ScreenShareOutboundSample,
  type ScreenShareSenderTelemetry
} from "./screenShareWebRTC";
import type { ScreenShareController, ScreenShareWatchStatus } from "./screen-share.svelte";
import type { ScreenShareSetupController } from "./screen-share-setup.svelte";
import type { RealtimeController } from "./realtime.svelte";
import type { RemoteControlController } from "./remote-control.svelte";
import type { VoiceSessionController } from "./voice-session.svelte";
import type { VoiceStateController, VoiceConnectionContext } from "./voice-state.svelte";
import type { AccompanimentController } from "./accompaniment.svelte";
import type {
  NativeScreenShareSenderSession,
  NativeScreenShareSenderStatus,
  RTCSignal,
  ScreenShareSession,
  VoiceState
} from "./types";

type ScreenSharePopoutResizeDirection =
  | "North"
  | "NorthEast"
  | "East"
  | "SouthEast"
  | "South"
  | "SouthWest"
  | "West"
  | "NorthWest";

export type ScreenShareTransportHooks = {
  memberId: () => string;
  sessionToken: () => string;
  baseUrl: () => string;
  currentVoiceState: () => VoiceState | null;
  voiceConnectionContext: () => VoiceConnectionContext | null;
  voiceState: () => VoiceStateController;
  screenSharePopoutMode: () => boolean;
  screenSharePopoutShareId: () => string;
  nativeDesktopRuntime: () => boolean;
  isTauriRuntime: () => boolean;
  translate: (key: string, params?: Record<string, string | number>) => string;
  setError: (message: string) => void;
  showAppAlert: (message: string, options?: { title?: string }) => Promise<void>;
  screenShare: () => ScreenShareController;
  /** Refresh TURN credentials when they are close to expiring, then return. */
  ensureFreshRTCConfig: () => Promise<void>;
  /** When the ICE server list in use was fetched; 0 means "never". */
  rtcIceConfigFetchedAtMS: () => number;
  screenShareSetup: () => ScreenShareSetupController;
  realtime: () => RealtimeController;
  remoteControl: () => RemoteControlController;
  voiceSession: () => VoiceSessionController;
  accompaniment: () => AccompanimentController;
  localScreenShareVideoElement: () => HTMLVideoElement | null;
  setLocalScreenShareVideoElement: (element: HTMLVideoElement | null) => void;
  focusedScreenShareVideoElement: () => HTMLVideoElement | null;
  setFocusedScreenShareVideoElement: (element: HTMLVideoElement | null) => void;
  screenShareFocusElement: () => HTMLElement | null;
  setScreenShareFocusElement: (element: HTMLElement | null) => void;
  screenShareActionBusy: () => boolean;
  setScreenShareActionBusy: (busy: boolean) => void;
  currentMemberScreenShare: () => ScreenShareSession | undefined;
  currentMemberActiveScreenShare: () => boolean;
  focusedScreenShareId: () => string;
  setFocusedScreenShareId: (shareId: string) => void;
  poppedOutScreenShareIds: () => Set<string>;
  setPoppedOutScreenShareIds: (ids: Set<string>) => void;
  screenShareVolumeMenuShareId: () => string;
  setScreenShareVolumeMenuShareId: (shareId: string) => void;
  selectedChannelId: () => string;
  setSelectedChannelId: (channelId: string) => void;
  channelContentMode: () => "chat" | "files" | "voice" | "category";
  setChannelContentMode: (mode: "chat" | "files" | "voice" | "category") => void;
  memberDisplayName: (memberId: string) => string;
  screenShareViewerCount: (share: ScreenShareSession | undefined) => number;
  closeCreateChannelMenu: () => void;
  closeMessageContextMenu: () => void;
  closeServerMenu: () => void;
  clearReplyTarget: () => void;
  clearMessageSearch: () => void;
  clearFileView: () => void;
  focusMemberAccessFilter: (channelId: string) => void;
  releaseActiveRemoteControlCapture: () => void;
  currentMemberRemoteControlForShare: (shareId: string) => unknown;
  remoteControlCaptureControlId: () => string;
  stopCurrentScreenShareSession: () => Promise<void>;
  removeCurrentMemberScreenShareSession: (session: ScreenShareSession) => void;
  refreshScreenShareSessions: () => Promise<void>;
  enqueueScreenShareSignal: (signal: RTCSignal) => void;
  sendRTCSignal: (targetParticipantId: string, signalType: RTCSignal["signal_type"], data: unknown) => boolean;
  browserRTCConfiguration: () => RTCConfiguration;
  attachRemoteScreenShare: (peerId: string, memberId: string, stream: MediaStream, track: MediaStreamTrack) => void;
  attachRemoteAudio: (memberId: string, stream: MediaStream, scope: "voice" | "accompaniment" | "screen-share") => void;
  detachRemoteAudioForMember: (
    memberId: string,
    scope: "voice" | "accompaniment" | "screen-share"
  ) => void;
  screenShareOwnerPeerId: (share: ScreenShareSession) => string;
  screenShareMemberIdForPeer: (peerId: string) => string;
  screenSharePeerIdForIdentity: (identity: string) => string;
  flushAliases: () => void;
};

export class ScreenShareTransportController {
  // ---- template-visible state -------------------------------------------------
  screenShareStatsTimers = $state(new Map<string, number>());
  webScreenShareSenderTelemetry = $state(new Map<string, ScreenShareSenderTelemetry>());
  webScreenShareViewerPaths = $state(new Map<string, ScreenSharePathKind>());
  webScreenShareSenderConfigurationErrors = $state(new Map<string, string>());
  webScreenShareOutboundSamples = $state(new Map<string, ScreenShareOutboundSample>());
  screenShareViewerPanelShareId = $state("");
  screenShareViewerPanelStyle = $state("");
  screenSharePopoutWatchStarted = $state(false);
  screenSharePopoutWatchBusy = $state(false);
  localScreenShareStream = $state<MediaStream | null>(null);
  pendingWebScreenShareStream = $state<MediaStream | null>(null);
  nativeScreenShareSenderSession = $state<NativeScreenShareSenderSession | null>(null);
  nativeScreenShareSenderStatus = $state<NativeScreenShareSenderStatus | null>(null);
  localScreenSharePreviewRenderingEnabled = $state(true);
  nativeScreenSharePreviewSyncGeneration = $state(0);
  nativeScreenSharePreviewSyncTail = $state<Promise<void>>(Promise.resolve());
  nativeLocalScreenSharePreviewConnection = $state<RTCPeerConnection | null>(null);
  nativeLocalScreenSharePreviewStream = $state<MediaStream | null>(null);
  nativeLocalScreenSharePreviewSessionId = $state("");
  nativeLocalScreenSharePreviewWatchSessionId = $state("");
  nativeLocalScreenSharePreviewGeneration = $state(0);
  nativeLocalScreenSharePreviewRequested = $state(false);
  nativeLocalScreenSharePreviewStarting = $state(false);
  nativeLocalScreenSharePreviewError = $state("");
  pendingNativeLocalScreenSharePreviewCandidates = $state<RTCIceCandidateInit[]>([]);
  nativeScreenShareStatusRefreshError = $state("");
  nativeScreenShareStatusProbeInFlight = $state(false);
  nativeScreenShareStatusProbeLastAtMS = $state(0);
  nativeScreenShareSignalDrainInFlight = $state(false);
  nativeScreenShareSignalDrainLastAtMS = $state(0);
  nativeScreenShareViewerSyncAtMS = $state(0);
  nativeScreenShareAppliedAnswerMemberIds = $state(new Set<string>());
  nativeScreenShareRegisteredViewerIds = $state(new Set<string>());
  localScreenShareStopProgrammatic = $state(false);
  nativeScreenShareClosedSourceSessionId = $state("");
  nativeScreenShareClosedSourceRetries = $state(0);
  localScreenShareStaleTimer = $state(0);
  screenSharePeerConnections = $state(new Map<string, RTCPeerConnection>());
  screenSharePeerConnectionShareIds = $state(new Map<string, string>());
  private readonly maxPendingScreenShareIceCandidates = 64;
  pendingScreenShareIceCandidates = $state(new Map<string, RTCIceCandidateInit[]>());
  screenShareSenders = $state(new Map<string, RTCRtpSender>());
  screenShareAudioSenders = $state(new Map<string, RTCRtpSender[]>());

  // ---- internal (never read by templates) ------------------------------------
  private screenShareViewerPanelAnchor: HTMLElement | null = null;
  private nativeScreenShareStatusTimer: number | undefined;
  private nativeScreenShareStatusProbeTimers: number[] = [];
  private nativeScreenShareStatusEventUnlisten: (() => void) | null = null;
  private nativeScreenShareStatusEventSessionId = "";
  private nativeScreenShareSignalFlushTimers: number[] = [];
  private nativeScreenShareOutboundSignalForwardInFlight = false;
  private nativeScreenShareOutboundSignalForwardRequestedSessionId = "";
  private webScreenShareSignalDrainTimer: number | undefined;
  private viewerScreenShareSignalDrainTimer: number | undefined;
  private viewerScreenShareSignalDrainInFlight = false;
  private viewerScreenShareSignalDrainController: AbortController | null = null;
  private viewerScreenShareSignalPollingGeneration = 0;
  /**
   * A still desktop sends no encoded frames, so a quiet media stream is normal.
   * The nominated ICE pair keeps exchanging consent checks and RTCP while the
   * sender has nothing to encode, so only that going quiet means the path died.
   */
  private readonly transportStallThresholdMS = 15_000;
  // Video buffers adapt to the path (see lib/screenSharePlayout.ts); the audio
  // buffer follows that target with a fixed lead instead of staying at a fixed
  // value, otherwise a widened video buffer would leave audio ahead of the
  // picture it belongs to.
  /** Video receivers keyed by peer identity, so the stats tick can retune them. */
  private readonly screenShareVideoReceivers = new Map<string, RTCRtpReceiver>();
  /** Audio receivers keyed by peer identity, retuned whenever the video target moves. */
  private readonly screenShareAudioReceivers = new Map<string, RTCRtpReceiver>();
  /** Current adaptive playout delay per peer identity, in milliseconds. */
  private readonly screenSharePlayoutDelays = new Map<string, number>();
  /**
   * When this viewer last asked its sharer to restart ICE, per peer identity.
   * The cooldown keeps a broken link from renegotiating in a loop instead of
   * rebuilding the connection.
   */
  private readonly screenShareIceRestartRequests = new Map<string, number>();
  /**
   * When the TURN credentials used by this peer connection were fetched. The
   * relay dies when they expire, so a relayed path has to be rebuilt before its
   * own credential does, not before the newest one does.
   */
  private readonly screenSharePeerCredentialFetchedAtMS = new Map<string, number>();
  /** Last deliberate relay rebuild per peer, so a failed refresh cannot loop. */
  private readonly screenShareRelayRotations = new Map<string, number>();
  /** Cumulative loss counters from the previous sample tick, used for deltas. */
  private readonly screenShareReceiverCounters = new Map<
    string,
    { packetsLost: number; framesDropped: number; freezes: number; atMS: number }
  >();
  /** Consecutive samples that found no succeeded candidate pair, per viewer. */
  private readonly screenShareMissingPairSamples = new Map<string, number>();
  /**
   * Which path this viewer asked ICE for, or `auto` to let the startup check
   * decide once. `direct` withholds the TURN servers, `relay` gathers only from
   * them; both are set by the viewer, never by the client after the first choice.
   */
  private readonly screenSharePathPreferences = new Map<string, ScreenSharePathPreference>();
  /**
   * Relay candidates gathered for a relay-only viewer. Zero after the deadline
   * means the TURN server is unreachable from this machine, which no amount of
   * waiting will fix.
   */
  private readonly screenShareRelayCandidates = new Map<string, number>();
  private readonly screenShareRelayWatchTimers = new Map<string, number>();
  /** Per-share path quality run, so one bad second cannot move the stream. */
  private readonly screenSharePathHistory = new Map<
    string,
    {
      atMS: number;
      /** When this share's first quality sample was taken: the startup window. */
      startedAtMS: number;
      bytesReceived: number;
      packetsReceived: number;
      packetsLost: number;
      receivedBitrateBps?: number;
      degradedSinceMS?: number;
      degradedSamples: number;
      relaySwitches: number;
    }
  >();
  private nativeMeasurement?: { sessionId: string; sample: NativePublisherSample };
  diagnosticsOpen = $state(localStorage.getItem("ev.screenShare.diagnostics") === "true");
  toggleDiagnostics() {
    this.diagnosticsOpen = !this.diagnosticsOpen;
    localStorage.setItem("ev.screenShare.diagnostics", String(this.diagnosticsOpen));
  }

  viewerMemberId(peerId: string) {
    return this.hooks.screenShareMemberIdForPeer(peerId);
  }
  private readonly webQuality = new Map<string, WebScreenShareQualityController>();
  private readonly smartContent = new ScreenShareContentMonitor();
  private smartMode: EffectiveScreenContent = "balanced";
  private readonly appliedSmartMode = new Map<string, EffectiveScreenContent>();
  private readonly senderUpdates = new WeakMap<RTCRtpSender, Promise<boolean>>();
  private readonly receiverSamplers = new Map<string, ScreenShareReceiverSampler>();
  private readonly statsReading = new WeakSet<RTCPeerConnection>();
  /**
   * Pending cleanup for a share connection that has no viewer left.
   *
   * Longer than the viewer's own ICE-restart fallback, so a viewer that can
   * still recover gets its restart served; shorter than the ICE consent
   * teardown, so a viewer that is really gone stops costing an encoder.
   */
  private readonly outgoingShareCleanupTimers = new Map<string, number>();
  private readonly outgoingShareConnectTimers = new Map<string, number>();
  private readonly outgoingShareCleanupDelayMS = 10_000;
  private readonly outgoingShareConnectDeadlineMS = 20_000;
  private readonly localPreviewViewerId = "__echovoice_local_preview__";

  constructor(private readonly hooks: ScreenShareTransportHooks) {
    // Available in every build: when a real viewer says "it is stuck", the only
    // channel left is the browser console, and "which path, which bitrate, how
    // many frames" has to be answerable without a debug build of the client.
    (globalThis as unknown as Record<string, unknown>).__evScreenSharePaths = () =>
      this.screenSharePathReport();
  }

  private get focusedShare(): ScreenShareSession | undefined {
    return this.hooks.screenShare().sessions.find(
      (share) => share.share_id === this.hooks.focusedScreenShareId()
    );
  }

  // ---- native sender status ----------------------------------------------------

  nativeScreenShareSenderStatusFallback(
    session: NativeScreenShareSenderSession,
    options: { backend?: string; phase?: NativeScreenShareSenderStatus["phase"]; lastError?: string } = {}
  ): NativeScreenShareSenderStatus {
    return {
      sessionId: session.sessionId,
      shareId: session.shareId,
      phase: options.phase ?? session.phase ?? "starting",
      backend: options.backend ?? "native-status-pending",
      viewerMemberIds: [],
      targetBitrateBps: this.hooks.screenShareSetup().targetBitrate(),
      effectiveBitrateBps: this.hooks.screenShareSetup().targetBitrate(),
      receiverEstimatedBitrateBps: undefined,
      capturedFrames: 0,
      forwardedFrames: 0,
      encodedFrames: 0,
      droppedFrames: 0,
      throttledFrames: 0,
      encoderBackpressureDrops: 0,
      viewerBackpressureDrops: 0,
      startedAtMs: Date.now(),
      lastFrameAtMs: 0,
      previewEnabled: this.localScreenSharePreviewRenderingEnabled,
      previewUpdatedAtMs: 0,
      appliedAnswerCount: 0,
      appliedIceCandidateCount: 0,
      ignoredViewerSignalCount: 0,
      nativePeerConnectionState: "new",
      nativeIceConnectionState: "new",
      nativeIceGatheringState: "new",
      sampleWriteCount: 0,
      sampleWriteErrorCount: 0,
      lastSampleWriteError: undefined,
      lastError: options.lastError
    };
  }

  private nativeScreenShareNumber(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  /**
   * The native sender reports one path per viewer. Anything other than a
   * recognized value is dropped rather than turned into a guess: a missing path
   * must not be displayed as "direct".
   */
  private nativeViewerValues(value: unknown, supported: readonly string[]): Record<string, string> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const paths: Record<string, string> = {};
    for (const [viewerId, path] of Object.entries(value as Record<string, unknown>)) {
      if (typeof path === "string" && supported.includes(path)) paths[viewerId] = path;
    }
    return Object.keys(paths).length > 0 ? paths : undefined;
  }

  private normalizeNativeScreenShareSenderStatus(value: NativeScreenShareSenderStatus | Record<string, unknown> | null | undefined) {
    if (!value) return null;
    const item = value as Record<string, unknown>;
    const viewerMemberIds = item.viewerMemberIds ?? item.viewer_member_ids;
    return {
      sessionId: String(item.sessionId ?? item.session_id ?? ""),
      shareId: String(item.shareId ?? item.share_id ?? ""),
      phase: String(item.phase ?? "starting"),
      backend: String(item.backend ?? "native-status-pending"),
      pipeline: item.pipeline && typeof item.pipeline === "object" ? item.pipeline as NativeScreenShareSenderStatus["pipeline"] : undefined,
      viewerMemberIds: Array.isArray(viewerMemberIds)
        ? viewerMemberIds.map(String).filter((viewerId) => viewerId !== this.localPreviewViewerId)
        : [],
      viewerPaths: this.nativeViewerValues(item.viewerPaths ?? item.viewer_paths, ["direct", "relay"]),
      viewerLayers: this.nativeViewerValues(item.viewerLayers ?? item.viewer_layers, ["high", "low", "compatibility"]),
      targetBitrateBps: this.nativeScreenShareNumber(item.targetBitrateBps ?? item.target_bitrate_bps),
      effectiveBitrateBps: this.nativeScreenShareNumber(
        item.effectiveBitrateBps ?? item.effective_bitrate_bps ?? item.targetBitrateBps ?? item.target_bitrate_bps
      ),
      receiverEstimatedBitrateBps: this.nativeScreenShareNumber(
        item.receiverEstimatedBitrateBps ?? item.receiver_estimated_bitrate_bps
      ) || undefined,
      capturedFrames: this.nativeScreenShareNumber(item.capturedFrames ?? item.captured_frames),
      forwardedFrames: this.nativeScreenShareNumber(item.forwardedFrames ?? item.forwarded_frames),
      encodedFrames: this.nativeScreenShareNumber(item.encodedFrames ?? item.encoded_frames),
      droppedFrames: this.nativeScreenShareNumber(item.droppedFrames ?? item.dropped_frames),
      throttledFrames: this.nativeScreenShareNumber(item.throttledFrames ?? item.throttled_frames),
      encoderBackpressureDrops: this.nativeScreenShareNumber(
        item.encoderBackpressureDrops ?? item.encoder_backpressure_drops
      ),
      viewerBackpressureDrops: this.nativeScreenShareNumber(
        item.viewerBackpressureDrops ?? item.viewer_backpressure_drops
      ),
      audioQueueDrops: typeof (item.audioQueueDrops ?? item.audio_queue_drops) === "number"
        ? Number(item.audioQueueDrops ?? item.audio_queue_drops)
        : undefined,
      startedAtMs: this.nativeScreenShareNumber(item.startedAtMs ?? item.started_at_ms),
      lastFrameAtMs: this.nativeScreenShareNumber(item.lastFrameAtMs ?? item.last_frame_at_ms),
      previewEnabled: typeof (item.previewEnabled ?? item.preview_enabled) === "boolean"
        ? Boolean(item.previewEnabled ?? item.preview_enabled)
        : true,
      previewDataUrl: typeof (item.previewDataUrl ?? item.preview_data_url) === "string"
        ? String(item.previewDataUrl ?? item.preview_data_url)
        : undefined,
      previewUpdatedAtMs: this.nativeScreenShareNumber(item.previewUpdatedAtMs ?? item.preview_updated_at_ms),
      appliedAnswerCount: this.nativeScreenShareNumber(item.appliedAnswerCount ?? item.applied_answer_count),
      appliedIceCandidateCount: this.nativeScreenShareNumber(item.appliedIceCandidateCount ?? item.applied_ice_candidate_count),
      ignoredViewerSignalCount: this.nativeScreenShareNumber(item.ignoredViewerSignalCount ?? item.ignored_viewer_signal_count),
      nativePeerConnectionState: String(item.nativePeerConnectionState ?? item.native_peer_connection_state ?? "new"),
      nativeIceConnectionState: String(item.nativeIceConnectionState ?? item.native_ice_connection_state ?? "new"),
      nativeIceGatheringState: String(item.nativeIceGatheringState ?? item.native_ice_gathering_state ?? "new"),
      sampleWriteCount: this.nativeScreenShareNumber(item.sampleWriteCount ?? item.sample_write_count),
      sampleWriteErrorCount: this.nativeScreenShareNumber(item.sampleWriteErrorCount ?? item.sample_write_error_count),
      lastSampleWriteError: typeof (item.lastSampleWriteError ?? item.last_sample_write_error) === "string"
        ? String(item.lastSampleWriteError ?? item.last_sample_write_error)
        : undefined,
      lastError: typeof (item.lastError ?? item.last_error) === "string"
        ? String(item.lastError ?? item.last_error)
        : undefined
    } satisfies NativeScreenShareSenderStatus;
  }

  applyNativeScreenShareSenderStatus(
    value: NativeScreenShareSenderStatus | Record<string, unknown> | null | undefined,
    _phase?: string
  ) {
    const status = this.normalizeNativeScreenShareSenderStatus(value);
    if (!status) return false;
    if (this.nativeScreenShareSenderSession?.sessionId !== status.sessionId) return false;
    this.nativeScreenShareStatusRefreshError = "";
    const sample = nativePublisherSample(value as Record<string, unknown>, performance.now());
    const before = this.nativeMeasurement?.sessionId === status.sessionId ? this.nativeMeasurement.sample : undefined;
    let metrics = this.nativeScreenShareSenderStatus?.pipelineMetrics;
    if (!before || sample.atMS - before.atMS >= 750) {
      metrics = nativePublisherMetrics(sample, before);
      this.nativeMeasurement = { sessionId: status.sessionId, sample };
    }
    this.nativeScreenShareSenderStatus = { ...status, pipelineMetrics: metrics };
    if (status.viewerMemberIds.length > 0 || status.appliedAnswerCount > 0 || status.appliedIceCandidateCount > 0) {
      this.nativeScreenShareRegisteredViewerIds = new Set(status.viewerMemberIds);
    }
    if (status.phase === "failed") {
      this.hooks.setError(status.lastError || this.hooks.translate("error.screenShareStartFailed"));
      // Closing the shared window ends the source: the native side stops
      // capturing, so keeping the session up would publish a frozen last frame
      // to everyone watching. The share is over, and the sharer has to pick a
      // source again.
      if (
        (status.lastError ?? "").includes("capture source closed") &&
        this.nativeScreenShareClosedSourceSessionId !== status.sessionId
      ) {
        this.nativeScreenShareClosedSourceSessionId = status.sessionId;
        this.nativeScreenShareClosedSourceRetries = 0;
        void this.hooks.stopCurrentScreenShareSession();
      } else if (
        (status.lastError ?? "").includes("capture source closed") &&
        this.nativeScreenShareClosedSourceSessionId === status.sessionId &&
        this.nativeScreenShareClosedSourceRetries < 3
      ) {
        // The stop is refused while a share action is still busy, and a refused
        // stop leaves the share publishing a frozen frame. Ask again: the session
        // never recovers once its source is gone.
        this.nativeScreenShareClosedSourceRetries += 1;
        void this.hooks.stopCurrentScreenShareSession();
      }
    }
    this.hooks.flushAliases();
    return true;
  }

  nativeScreenSharePreviewStatusLabel() {
    const status = this.nativeScreenShareSenderStatus;
    if (!this.nativeScreenShareSenderSession) return "";
    if (!this.localScreenSharePreviewRenderingEnabled || status?.previewEnabled === false) {
      return this.hooks.translate("screenShare.previewPausedUnfocused");
    }
    if (!status) {
      return this.nativeScreenShareStatusRefreshError
        ? this.nativeScreenShareStatusRefreshError
        : this.hooks.translate("screenShare.nativePreviewWaitingFrames");
    }
    if (status.lastError) return status.lastError;
    if (status.capturedFrames <= 0) return this.hooks.translate("screenShare.nativePreviewWaitingFrames");
    if (status.encodedFrames <= 0) return this.hooks.translate("screenShare.nativePreviewWaitingEncode");
    return this.hooks.translate("screenShare.nativePreviewSending");
  }

  nativeScreenSharePreviewViewerLabel() {
    const status = this.nativeScreenShareSenderStatus;
    const label = this.hooks.translate("screenShare.viewerCountDetailed", {
      count: status?.viewerMemberIds.length ??
        this.hooks.screenShareViewerCount(this.hooks.currentMemberScreenShare())
    });
    if (!status) return label;
    // The panel answers one question — how many people are watching — so it
    // stays at the count. Path mix and uplink estimates live in the diagnostics
    // status, where an operator can read them without the sharer having to.
    const layers = summarizeScreenShareViewerLayers(
      status.viewerMemberIds,
      status.viewerLayers
    );
    return `${label}${screenShareViewerLayerSuffix(layers, this.hooks.translate)}`;
  }

  promiseWithTimeout<T>(promise: Promise<T>, timeoutMS: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error(message)), timeoutMS);
      promise.then(
        (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        (reason) => {
          window.clearTimeout(timer);
          reject(reason);
        }
      );
    });
  }

  async abortableRequestWithTimeout<T>(
    request: (signal: AbortSignal) => Promise<T>,
    timeoutMS: number,
    message: string
  ): Promise<T> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMS);
    try {
      return await request(controller.signal);
    } catch (caught) {
      if (controller.signal.aborted) throw new Error(message);
      throw caught;
    } finally {
      window.clearTimeout(timer);
    }
  }

  updateScreenShareViewerPanelPosition() {
    const anchor = this.screenShareViewerPanelAnchor;
    if (!anchor?.isConnected) {
      this.closeScreenShareViewerPanel();
      return;
    }
    const anchorRect = anchor.getBoundingClientRect();
    const contentRect = document.querySelector<HTMLElement>(".content-panel")?.getBoundingClientRect();
    const viewportPadding = 8;
    const gap = 8;
    const boundaryLeft = Math.max(viewportPadding, (contentRect?.left ?? 0) + viewportPadding);
    const boundaryRight = Math.min(
      window.innerWidth - viewportPadding,
      (contentRect?.right ?? window.innerWidth) - viewportPadding
    );
    const boundaryTop = Math.max(viewportPadding, (contentRect?.top ?? 0) + viewportPadding);
    const boundaryBottom = Math.min(
      window.innerHeight - viewportPadding,
      (contentRect?.bottom ?? window.innerHeight) - viewportPadding
    );
    const width = Math.max(180, Math.min(300, boundaryRight - boundaryLeft));
    const left = Math.max(
      boundaryLeft,
      Math.min(anchorRect.right - width, boundaryRight - width)
    );
    const spaceAbove = Math.max(0, anchorRect.top - boundaryTop - gap);
    const spaceBelow = Math.max(0, boundaryBottom - anchorRect.bottom - gap);
    const openAbove = spaceAbove >= Math.min(240, spaceBelow) || spaceAbove > spaceBelow;
    const availableHeight = Math.max(96, Math.min(380, openAbove ? spaceAbove : spaceBelow));
    this.screenShareViewerPanelStyle = openAbove
      ? `left: ${Math.round(left)}px; right: auto; top: auto; bottom: ${Math.round(window.innerHeight - anchorRect.top + gap)}px; width: ${Math.round(width)}px; max-height: ${Math.round(availableHeight)}px;`
      : `left: ${Math.round(left)}px; right: auto; top: ${Math.round(anchorRect.bottom + gap)}px; bottom: auto; width: ${Math.round(width)}px; max-height: ${Math.round(availableHeight)}px;`;
    this.hooks.flushAliases();
  }

  toggleScreenShareViewerPanel(share: ScreenShareSession, event: MouseEvent) {
    const opening = this.screenShareViewerPanelShareId !== share.share_id;
    this.screenShareViewerPanelShareId = opening ? share.share_id : "";
    this.screenShareViewerPanelAnchor = opening ? event.currentTarget as HTMLElement : null;
    this.screenShareViewerPanelStyle = "";
    if (opening) {
      this.hooks.setScreenShareVolumeMenuShareId("");
      this.updateScreenShareViewerPanelPosition();
    }
    this.hooks.flushAliases();
  }

  closeScreenShareViewerPanel() {
    this.screenShareViewerPanelShareId = "";
    this.screenShareViewerPanelStyle = "";
    this.screenShareViewerPanelAnchor = null;
    this.hooks.flushAliases();
  }

  portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      }
    };
  }

  handleScreenShareFocusControlsKeydown(event: KeyboardEvent) {
    if (
      event.key !== "Escape" ||
      (!this.screenShareViewerPanelShareId &&
        !this.hooks.screenShareVolumeMenuShareId() &&
        !this.screenSharePathMenuShareId)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.closeScreenShareViewerPanel();
    this.hooks.setScreenShareVolumeMenuShareId("");
    this.screenSharePathMenuShareId = "";
  }

  private withSetValue<T>(set: Set<T>, value: T) {
    const next = new Set(set);
    next.add(value);
    return next;
  }

  private withoutSetValue<T>(set: Set<T>, value: T) {
    const next = new Set(set);
    next.delete(value);
    return next;
  }

  screenShareVideo(node: HTMLVideoElement, stream: MediaStream | null | undefined) {
    return attachScreenShareVideo(node, stream);
  }

  configureScreenShareReceiver(receiver: RTCRtpReceiver, targetMemberId = "") {
    if (String(receiver.track?.kind) === "video") {
      if (targetMemberId) {
        this.screenShareVideoReceivers.set(targetMemberId, receiver);
        this.screenSharePlayoutDelays.set(targetMemberId, screenShareInitialVideoPlayoutDelayMS);
        this.screenShareReceiverCounters.delete(targetMemberId);
        this.screenShareMissingPairSamples.delete(targetMemberId);
        this.receiverSamplers.delete(targetMemberId);
      }
      this.applyScreenSharePlayoutDelay(receiver, screenShareInitialVideoPlayoutDelayMS);
      return;
    }
    if (targetMemberId) {
      this.screenShareAudioReceivers.set(targetMemberId, receiver);
    }
    this.applyScreenSharePlayoutDelay(
      receiver,
      screenShareAudioPlayoutDelayMS(
        this.screenSharePlayoutDelays.get(targetMemberId) ?? screenShareInitialVideoPlayoutDelayMS
      )
    );
  }

  private applyScreenSharePlayoutDelay(receiver: RTCRtpReceiver, playoutDelayMS: number) {
    // Writing the property is not proof it took: some WebView2 builds accept
    // `jitterBufferTarget` and keep their own buffer. The helper reads it back
    // and falls through to `playoutDelayHint` when the value did not stick.
    applyScreenSharePlayoutDelay(
      receiver as unknown as ScreenSharePlayoutReceiver,
      playoutDelayMS
    );
  }

  private adaptScreenSharePlayoutDelay(
    targetMemberId: string,
    totals: { jitterMS: number; packetsLost: number; framesDropped: number; freezes: number; bufferResidenceMS?: number },
    pathKind: ScreenSharePathKind = "unknown"
  ) {
    const receiver = this.screenShareVideoReceivers.get(targetMemberId);
    if (!receiver) return;
    const ceilingMS = screenSharePlayoutDelayCeilingMS(pathKind);
    const now = Date.now();
    const previous = this.screenShareReceiverCounters.get(targetMemberId);
    if (!previous) {
      // Seed the baseline. Reacting to the first sample would treat the whole
      // session's history as if it had just happened.
      this.screenShareReceiverCounters.set(targetMemberId, {
        packetsLost: totals.packetsLost,
        framesDropped: totals.framesDropped,
        freezes: totals.freezes,
        atMS: now
      });
      return;
    }
    // Stats are refreshed by the one-second poll and by the startup bursts, so
    // gate the controller to one honest sample per second instead of letting a
    // single burst ratchet the buffer to its ceiling.
    if (now - previous.atMS < 1_000) return;
    this.screenShareReceiverCounters.set(targetMemberId, {
      packetsLost: totals.packetsLost,
      framesDropped: totals.framesDropped,
      freezes: totals.freezes,
      atMS: now
    });
    // The report carries cumulative counters, so only their growth since the
    // previous sample describes the path the stream is on right now.
    const packetsLost = Math.max(0, totals.packetsLost - previous.packetsLost);
    const framesDropped = Math.max(0, totals.framesDropped - previous.framesDropped);
    const freezes = Math.max(0, totals.freezes - previous.freezes);
    const current = this.screenSharePlayoutDelays.get(targetMemberId)
      ?? screenShareInitialVideoPlayoutDelayMS;
    const next = nextScreenSharePlayoutDelayMS(
      current,
      {
        jitterMS: totals.jitterMS,
        bufferResidenceMS: totals.bufferResidenceMS,
        packetsLost,
        framesDropped,
        freezes
      },
      ceilingMS
    );
    if (next === current) return;
    this.screenSharePlayoutDelays.set(targetMemberId, next);
    this.applyScreenSharePlayoutDelay(receiver, next);
    const audioReceiver = this.screenShareAudioReceivers.get(targetMemberId);
    if (audioReceiver) {
      this.applyScreenSharePlayoutDelay(audioReceiver, screenShareAudioPlayoutDelayMS(next, ceilingMS));
    }
  }

  attachScreenSharePreviewElement() {
    const localVideo = this.hooks.localScreenShareVideoElement();
    if (!localVideo || !this.localScreenShareStream) return;
    if (this.hooks.nativeDesktopRuntime() && !this.localScreenSharePreviewRenderingEnabled) {
      localVideo.pause();
      return;
    }
    if (localVideo.srcObject !== this.localScreenShareStream) {
      localVideo.srcObject = this.localScreenShareStream;
    }
    void localVideo.play().catch(() => undefined);
  }

  stopMediaStream(stream: MediaStream) {
    stream.getTracks().forEach((track) => track.stop());
  }

  stopLocalScreenShareStream(options: { programmatic?: boolean } = {}) {
    this.smartContent.stop();
    this.smartMode = "balanced";
    this.appliedSmartMode.clear();
    this.hooks.screenShareSetup().discardPendingWebSource();
    if (this.localScreenShareStream) {
      this.localScreenShareStopProgrammatic = options.programmatic ?? true;
      this.stopMediaStream(this.localScreenShareStream);
      this.localScreenShareStream = null;
      window.setTimeout(() => {
        this.localScreenShareStopProgrammatic = false;
      }, 1200);
    }
    const localVideo = this.hooks.localScreenShareVideoElement();
    if (localVideo) {
      localVideo.pause();
      localVideo.srcObject = null;
    }
    this.hooks.flushAliases();
  }

  localScreenShareCaptureActive() {
    return Boolean(
      this.localScreenShareStream?.getVideoTracks().some((track) => track.readyState === "live") ||
        this.nativeScreenShareSenderActive()
    );
  }

  private nativeScreenShareSenderActive() {
    const phase = this.nativeScreenShareSenderStatus?.phase ?? this.nativeScreenShareSenderSession?.phase ?? "";
    return Boolean(this.nativeScreenShareSenderSession && !["failed", "stopped"].includes(phase));
  }

  startNativeScreenShareStatusPolling() {
    this.stopNativeScreenShareStatusPolling({ clearStatus: false });
    if (!this.nativeScreenShareSenderSession) return;
    if (!this.nativeScreenShareSenderStatus) {
      this.nativeScreenShareSenderStatus = this.nativeScreenShareSenderStatusFallback(this.nativeScreenShareSenderSession);
    }
    this.hooks.flushAliases();
    this.nativeScreenShareStatusRefreshError = "";
    void this.startNativeScreenShareStatusEvents(this.nativeScreenShareSenderSession.sessionId);
    void this.refreshNativeScreenShareSenderStatusProbe(this.nativeScreenShareSenderSession.sessionId);
    void this.forwardNativeScreenShareSenderSignals(this.nativeScreenShareSenderSession.sessionId);
    void this.drainOwnedScreenShareQueuedSignals(this.nativeScreenShareSenderSession.shareId, this.nativeScreenShareSenderSession.sessionId);
    this.nativeScreenShareStatusTimer = window.setInterval(() => {
      const senderSession = this.nativeScreenShareSenderSession;
      if (senderSession) {
        void this.forwardNativeScreenShareSenderSignals(senderSession.sessionId);
        void this.drainOwnedScreenShareQueuedSignals(senderSession.shareId, senderSession.sessionId);
        void this.refreshNativeScreenShareSenderStatusProbe(senderSession.sessionId);
        void this.syncCurrentNativeScreenShareViewers();
      }
    }, 250);
  }

  stopNativeScreenShareStatusPolling(options: { clearStatus?: boolean } = {}) {
    if (this.nativeScreenShareStatusTimer) {
      window.clearInterval(this.nativeScreenShareStatusTimer);
    }
    this.nativeScreenShareStatusTimer = undefined;
    this.stopNativeScreenShareStatusEvents();
    this.clearNativeScreenShareStatusProbeTimers();
    if (options.clearStatus ?? true) {
      this.nativeScreenShareSenderStatus = null;
      this.nativeScreenShareStatusRefreshError = "";
      this.nativeScreenShareStatusProbeInFlight = false;
      this.nativeScreenShareStatusProbeLastAtMS = 0;
      this.nativeScreenShareRegisteredViewerIds = new Set();
      this.nativeScreenShareAppliedAnswerMemberIds = new Set();
      this.nativeScreenShareSignalDrainInFlight = false;
      this.nativeScreenShareSignalDrainLastAtMS = 0;
      this.nativeScreenShareViewerSyncAtMS = 0;
    }
    this.clearNativeScreenShareSignalFlushTimers();
    this.hooks.flushAliases();
  }

  private async syncCurrentNativeScreenShareViewers() {
    const senderSession = this.nativeScreenShareSenderSession;
    if (!senderSession || !this.hooks.isTauriRuntime()) return;
    const now = Date.now();
    if (now - this.nativeScreenShareViewerSyncAtMS < 1000) return;
    this.nativeScreenShareViewerSyncAtMS = now;
    let ownedShare = this.hooks.screenShare().sessions.find(
      (share) => share.owner_member_id === this.hooks.memberId() && share.share_id === senderSession.shareId
    );
    if (!ownedShare && this.hooks.sessionToken()) {
      await this.hooks.refreshScreenShareSessions();
      ownedShare = this.hooks.screenShare().sessions.find(
        (share) => share.owner_member_id === this.hooks.memberId() && share.share_id === senderSession.shareId
      );
    }
    if (ownedShare) {
      await this.hooks.realtime().syncNativeScreenShareViewersFromSession(ownedShare);
    }
  }

  private clearNativeScreenShareStatusProbeTimers() {
    for (const timer of this.nativeScreenShareStatusProbeTimers) {
      window.clearTimeout(timer);
    }
    this.nativeScreenShareStatusProbeTimers = [];
  }

  scheduleNativeScreenShareStatusProbeBurst(sessionId: string) {
    if (!this.hooks.isTauriRuntime()) return;
    this.clearNativeScreenShareStatusProbeTimers();
    const delays = [120, 360, 900, 1600];
    for (const delay of delays) {
      const timer = window.setTimeout(() => {
        this.nativeScreenShareStatusProbeTimers = this.nativeScreenShareStatusProbeTimers.filter((item) => item !== timer);
        if (this.nativeScreenShareSenderSession?.sessionId === sessionId) {
          void this.refreshNativeScreenShareSenderStatusProbe(sessionId, { force: true });
        }
      }, delay);
      this.nativeScreenShareStatusProbeTimers = [...this.nativeScreenShareStatusProbeTimers, timer];
    }
  }

  private async startNativeScreenShareStatusEvents(sessionId: string) {
    if (!this.hooks.isTauriRuntime()) return;
    this.stopNativeScreenShareStatusEvents();
    this.nativeScreenShareStatusEventSessionId = sessionId;
    try {
      const eventApi = await import("@tauri-apps/api/event");
      if (this.nativeScreenShareStatusEventSessionId !== sessionId) return;
      this.nativeScreenShareStatusEventUnlisten = await eventApi.listen<NativeScreenShareSenderStatus>(
        "native-screen-share-sender-status",
        (event) => {
          this.applyNativeScreenShareSenderStatus(event.payload);
        }
      );
    } catch (caught) {
      this.nativeScreenShareStatusRefreshError = caught instanceof Error
        ? caught.message
        : this.hooks.translate("error.screenShareStartFailed");
      this.hooks.flushAliases();
    }
  }

  private stopNativeScreenShareStatusEvents() {
    this.nativeScreenShareStatusEventSessionId = "";
    if (this.nativeScreenShareStatusEventUnlisten) {
      this.nativeScreenShareStatusEventUnlisten();
      this.nativeScreenShareStatusEventUnlisten = null;
    }
  }

  private async refreshNativeScreenShareSenderStatusProbe(sessionId: string, options: { force?: boolean } = {}) {
    if (!this.hooks.isTauriRuntime()) return;
    const now = Date.now();
    if (this.nativeScreenShareStatusProbeInFlight && now - this.nativeScreenShareStatusProbeLastAtMS > 3000) {
      this.nativeScreenShareStatusProbeInFlight = false;
      this.nativeScreenShareStatusRefreshError = this.hooks.translate("screenShare.nativePreviewProbeStalled");
      this.hooks.flushAliases();
    }
    if (this.nativeScreenShareStatusProbeInFlight) return;
    if (!options.force && now - this.nativeScreenShareStatusProbeLastAtMS < 2000) return;
    this.nativeScreenShareStatusProbeInFlight = true;
    this.nativeScreenShareStatusProbeLastAtMS = now;
    try {
      const status = await this.promiseWithTimeout(
        loadNativeScreenShareSenderStatus(sessionId),
        900,
        this.hooks.translate("screenShare.nativePreviewProbeTimeout")
      );
      if (this.nativeScreenShareSenderSession?.sessionId !== sessionId) return;
      this.applyNativeScreenShareSenderStatus(status);
    } catch (caught) {
      if (this.nativeScreenShareSenderSession?.sessionId !== sessionId) return;
      this.nativeScreenShareStatusRefreshError = caught instanceof Error
        ? caught.message
        : this.hooks.translate("error.screenShareStartFailed");
      this.hooks.flushAliases();
    } finally {
      this.nativeScreenShareStatusProbeInFlight = false;
    }
  }

  async forwardNativeScreenShareSenderSignals(sessionId: string) {
    if (!this.hooks.isTauriRuntime() || this.nativeScreenShareSenderSession?.sessionId !== sessionId) return;
    if (this.nativeScreenShareOutboundSignalForwardInFlight) {
      this.nativeScreenShareOutboundSignalForwardRequestedSessionId = sessionId;
      return;
    }
    this.nativeScreenShareOutboundSignalForwardInFlight = true;
    try {
      do {
        this.nativeScreenShareOutboundSignalForwardRequestedSessionId = "";
        const signals = await drainNativeScreenShareSenderSignals(sessionId);
        if (this.nativeScreenShareSenderSession?.sessionId !== sessionId) return;
        const localPreviewSignals = signals
          .filter((signal) => signal.memberId === this.localPreviewViewerId)
          .sort(
            (left, right) =>
              Number(left.signalType !== "screen-share-offer") -
              Number(right.signalType !== "screen-share-offer")
          );
        for (const signal of localPreviewSignals) {
          try {
            await this.hooks.realtime().handleNativeLocalScreenSharePreviewSignal(signal);
          } catch (caught) {
            this.nativeLocalScreenSharePreviewStarting = false;
            this.nativeLocalScreenSharePreviewError = caught instanceof Error
              ? caught.message
              : this.hooks.translate("screenShare.localPreviewDirectFailed");
          }
        }
        const activeSignals = signals.filter((signal) => {
          if (signal.memberId === this.localPreviewViewerId) return false;
          if (!signal.memberId || !signal.signalType) return false;
          const activeWatchSessionId = this.hooks.screenShare().watcherSessionIds.get(signal.memberId) ?? "";
          const signalWatchSessionId = this.screenShareDataWatchSessionId(signal.data);
          return Boolean(
            activeWatchSessionId &&
              (!signalWatchSessionId || signalWatchSessionId === activeWatchSessionId)
          );
        });
        activeSignals.sort((left, right) => {
          const leftPriority = left.signalType === "screen-share-offer" ? 0 : 1;
          const rightPriority = right.signalType === "screen-share-offer" ? 0 : 1;
          return leftPriority - rightPriority;
        });
        for (let offset = 0; offset < activeSignals.length; offset += 4) {
          const batch = activeSignals.slice(offset, offset + 4);
          await Promise.all(batch.map(async (signal) => {
            if (
              signal.signalType !== "screen-share-offer" &&
              signal.signalType !== "screen-share-answer" &&
              signal.signalType !== "screen-share-ice-candidate"
            ) {
              return;
            }
            const targetState = this.hooks.voiceState().voiceStateByParticipant(signal.memberId);
            await this.sendScreenShareMediaSignal(
              targetState?.member_id ?? signal.memberId,
              signal.signalType,
              signal.data,
              targetState?.participant_id ?? ""
            );
          }));
        }
      } while (
        this.nativeScreenShareOutboundSignalForwardRequestedSessionId === sessionId &&
        this.nativeScreenShareSenderSession?.sessionId === sessionId
      );
    } catch (caught) {
      this.nativeScreenShareSenderStatus = this.nativeScreenShareSenderStatus
        ? {
            ...this.nativeScreenShareSenderStatus,
            lastError: caught instanceof Error ? caught.message : this.hooks.translate("error.screenShareStartFailed")
          }
        : this.nativeScreenShareSenderStatus;
      this.hooks.flushAliases();
    } finally {
      this.nativeScreenShareOutboundSignalForwardInFlight = false;
      const requestedSessionId = this.nativeScreenShareOutboundSignalForwardRequestedSessionId;
      this.nativeScreenShareOutboundSignalForwardRequestedSessionId = "";
      if (requestedSessionId && this.nativeScreenShareSenderSession?.sessionId === requestedSessionId) {
        queueMicrotask(() => void this.forwardNativeScreenShareSenderSignals(requestedSessionId));
      }
    }
  }

  startWebScreenShareSignalPolling(shareId: string) {
    this.stopWebScreenShareSignalPolling();
    void this.drainOwnedScreenShareQueuedSignals(shareId);
    this.webScreenShareSignalDrainTimer = window.setInterval(() => {
      void this.drainOwnedScreenShareQueuedSignals(shareId);
    }, 750);
  }

  stopWebScreenShareSignalPolling() {
    if (this.webScreenShareSignalDrainTimer) {
      window.clearInterval(this.webScreenShareSignalDrainTimer);
    }
    this.webScreenShareSignalDrainTimer = undefined;
  }

  syncViewerScreenShareSignalPolling() {
    const watchedShares = this.hooks.screenShare().sessions.filter(
      (share) => share.owner_member_id !== this.hooks.memberId() &&
        this.hooks.screenShare().watchedShareIds.has(share.share_id)
    );
    const socketUnavailable = this.hooks.realtime().eventSocket?.readyState !== WebSocket.OPEN;
    const fallbackNeeded = watchedShares.some(
      (share) => socketUnavailable || !this.hooks.screenShare().playbackHealthy(share)
    );
    if (!this.hooks.sessionToken() || !fallbackNeeded) {
      this.stopViewerScreenShareSignalPolling();
      return;
    }
    if (this.viewerScreenShareSignalDrainTimer) return;
    this.viewerScreenShareSignalPollingGeneration += 1;
    void this.drainViewerScreenShareQueuedSignals();
    this.viewerScreenShareSignalDrainTimer = window.setInterval(() => {
      void this.drainViewerScreenShareQueuedSignals();
    }, 750);
  }

  stopViewerScreenShareSignalPolling() {
    const hadActiveDrain = Boolean(
      this.viewerScreenShareSignalDrainTimer || this.viewerScreenShareSignalDrainController
    );
    if (this.viewerScreenShareSignalDrainTimer) {
      window.clearInterval(this.viewerScreenShareSignalDrainTimer);
    }
    this.viewerScreenShareSignalDrainTimer = undefined;
    if (hadActiveDrain) this.viewerScreenShareSignalPollingGeneration += 1;
    this.viewerScreenShareSignalDrainController?.abort();
    this.viewerScreenShareSignalDrainController = null;
  }

  private async drainViewerScreenShareQueuedSignals() {
    if (!this.hooks.sessionToken() || this.viewerScreenShareSignalDrainInFlight) return;
    const generation = this.viewerScreenShareSignalPollingGeneration;
    const watchedShares = this.hooks.screenShare().sessions
      .filter((share) => share.owner_member_id !== this.hooks.memberId() &&
        this.hooks.screenShare().watchedShareIds.has(share.share_id))
      .map((share) => ({
        share,
        watchSessionId: this.hooks.screenShare().watchSessionIds.get(share.share_id) ?? ""
      }));
    if (watchedShares.length === 0) {
      this.syncViewerScreenShareSignalPolling();
      return;
    }
    const controller = new AbortController();
    this.viewerScreenShareSignalDrainController = controller;
    this.viewerScreenShareSignalDrainInFlight = true;
    try {
      for (const { share, watchSessionId } of watchedShares) {
        const signals = await drainScreenShareSignals(
          this.hooks.baseUrl(),
          this.hooks.sessionToken(),
          share.share_id,
          watchSessionId,
          controller.signal
        );
        if (
          controller.signal.aborted ||
          generation !== this.viewerScreenShareSignalPollingGeneration ||
          !this.hooks.screenShare().watchedShareIds.has(share.share_id) ||
          this.hooks.screenShare().watchSessionIds.get(share.share_id) !== watchSessionId
        ) {
          continue;
        }
        for (const signal of signals) {
          if (signal.target_member_id && signal.target_member_id !== this.hooks.memberId()) continue;
          if (watchSessionId && this.screenShareSignalWatchSessionId(signal) !== watchSessionId) continue;
          this.hooks.enqueueScreenShareSignal(signal);
        }
      }
    } catch {
      // The WebSocket retry path remains active while the HTTP fallback recovers.
    } finally {
      if (this.viewerScreenShareSignalDrainController === controller) {
        this.viewerScreenShareSignalDrainController = null;
      }
      this.viewerScreenShareSignalDrainInFlight = false;
      if (generation === this.viewerScreenShareSignalPollingGeneration) {
        this.syncViewerScreenShareSignalPolling();
      }
    }
  }

  private async drainOwnedScreenShareQueuedSignals(shareId: string, nativeSessionId = "") {
    if (!shareId || !this.hooks.sessionToken()) return;
    if (nativeSessionId) {
      if (this.nativeScreenShareSenderSession?.sessionId !== nativeSessionId) return;
    } else if (
      this.hooks.currentMemberScreenShare()?.share_id !== shareId &&
      !this.hooks.screenShare().sessions.some(
        (share) => share.share_id === shareId && share.owner_member_id === this.hooks.memberId()
      )
    ) {
      return;
    }
    const now = Date.now();
    if (this.nativeScreenShareSignalDrainInFlight) return;
    if (now - this.nativeScreenShareSignalDrainLastAtMS < 550) return;
    this.nativeScreenShareSignalDrainInFlight = true;
    this.nativeScreenShareSignalDrainLastAtMS = now;
    try {
      const signals = await drainScreenShareSignals(this.hooks.baseUrl(), this.hooks.sessionToken(), shareId);
      if (nativeSessionId && this.nativeScreenShareSenderSession?.sessionId !== nativeSessionId) return;
      this.nativeScreenShareSignalDrainLastAtMS = Date.now();
      for (const signal of signals) {
        if (signal.target_member_id && signal.target_member_id !== this.hooks.memberId()) continue;
        if (signal.signal_type === "screen-share-answer") {
          const peerId = signal.from_participant_id || signal.from_member_id;
          if (this.nativeScreenShareAppliedAnswerMemberIds.has(peerId)) continue;
          await this.handleScreenShareAnswerSignal(signal);
          continue;
        }
        if (signal.signal_type === "screen-share-ice-candidate") {
          await this.handleScreenShareIceCandidateSignal(signal);
        }
      }
    } catch (caught) {
      if (nativeSessionId) {
        this.nativeScreenShareSenderStatus = this.nativeScreenShareSenderStatus
          ? {
              ...this.nativeScreenShareSenderStatus,
              lastError: caught instanceof Error ? caught.message : this.hooks.translate("error.screenShareWatchFailed")
            }
          : this.nativeScreenShareSenderStatus;
        this.hooks.flushAliases();
      }
      this.nativeScreenShareSignalDrainLastAtMS = Date.now();
    } finally {
      this.nativeScreenShareSignalDrainInFlight = false;
    }
  }

  private clearNativeScreenShareSignalFlushTimers() {
    for (const timer of this.nativeScreenShareSignalFlushTimers) {
      window.clearTimeout(timer);
    }
    this.nativeScreenShareSignalFlushTimers = [];
  }

  scheduleNativeScreenShareSignalFlush(sessionId: string) {
    if (!this.hooks.isTauriRuntime()) return;
    const delays = [60, 180, 420, 800];
    for (const delay of delays) {
      const timer = window.setTimeout(() => {
        this.nativeScreenShareSignalFlushTimers = this.nativeScreenShareSignalFlushTimers.filter((item) => item !== timer);
        if (this.nativeScreenShareSenderSession?.sessionId === sessionId) {
          void this.forwardNativeScreenShareSenderSignals(sessionId);
        }
      }, delay);
      this.nativeScreenShareSignalFlushTimers = [...this.nativeScreenShareSignalFlushTimers, timer];
    }
  }

  private clearLocalScreenShareStaleTimer() {
    if (!this.localScreenShareStaleTimer) return;
    window.clearTimeout(this.localScreenShareStaleTimer);
    this.localScreenShareStaleTimer = 0;
  }

  reconcileLocalScreenShareCapture(share: ScreenShareSession | undefined) {
    if (!share || this.hooks.screenShareActionBusy() || this.localScreenShareCaptureActive()) {
      this.clearLocalScreenShareStaleTimer();
      return;
    }
    if (this.localScreenShareStaleTimer) return;
    this.localScreenShareStaleTimer = window.setTimeout(() => {
      this.localScreenShareStaleTimer = 0;
      if (this.hooks.currentMemberScreenShare() && !this.hooks.screenShareActionBusy() && !this.localScreenShareCaptureActive()) {
        void this.hooks.stopCurrentScreenShareSession();
      }
    }, 700);
  }

  clearStaleCurrentMemberScreenShare() {
    const share = this.hooks.currentMemberScreenShare();
    if (!share || this.localScreenShareCaptureActive() || this.hooks.screenShareActionBusy()) return false;
    this.hooks.removeCurrentMemberScreenShareSession(share);
    if (this.hooks.sessionToken()) {
      void endScreenShareSession(this.hooks.baseUrl(), this.hooks.sessionToken(), share.share_id).catch(() => undefined);
    }
    return true;
  }

  private handleLocalScreenShareEnded() {
    if (this.localScreenShareStopProgrammatic) return;
    this.stopLocalScreenShareStream({ programmatic: true });
    if (!this.hooks.currentMemberScreenShare() || !this.hooks.sessionToken()) return;
    if (!this.hooks.screenShareActionBusy()) {
      void this.hooks.stopCurrentScreenShareSession();
      return;
    }
    window.setTimeout(() => {
      if (this.hooks.currentMemberScreenShare() && !this.localScreenShareStream && !this.hooks.screenShareActionBusy()) {
        void this.hooks.stopCurrentScreenShareSession();
      }
    }, 250);
  }

  async openLocalScreenShareStream(includeAudio = false) {
    if (this.hooks.isTauriRuntime()) {
      await this.hooks.screenShareSetup().ensureNativeReady();
      throw new Error(this.hooks.translate("error.screenShareNativeSenderUnavailable"));
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error(this.hooks.translate("error.screenShareMediaUnavailable"));
    }
    const browserVideoConstraints = {
      ...this.hooks.screenShareSetup().videoConstraints(),
      cursor: this.hooks.screenShareSetup().captureCursor ? "always" : "never"
    } as MediaTrackConstraints;
    const displayMediaOptions = {
      video: browserVideoConstraints,
      audio: includeAudio
        ? ({
            suppressLocalAudioPlayback: false
          } as MediaTrackConstraints & { suppressLocalAudioPlayback: boolean })
        : false,
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      systemAudio: includeAudio ? "include" : "exclude",
      windowAudio: includeAudio ? "system" : "exclude"
    } as DisplayMediaStreamOptions;
    const stream = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions);
    for (const track of stream.getVideoTracks()) {
      try {
        await track.applyConstraints(this.hooks.screenShareSetup().videoConstraints());
      } catch {
        // Some browsers only accept display constraints during source selection.
      }
      try {
        track.contentHint = screenShareContentHint(this.hooks.screenShareSetup().contentMode);
      } catch {
        // The capture remains usable when a browser does not expose content hints.
      }
    }
    for (const track of stream.getAudioTracks()) {
      try {
        track.contentHint = "music";
      } catch {
        // The browser can still send source audio without exposing content hints.
      }
    }
    return stream;
  }

  attachLocalScreenShareStream(stream: MediaStream) {
    if (this.localScreenShareStream && this.localScreenShareStream !== stream) {
      this.stopLocalScreenShareStream();
    }
    this.localScreenShareStream = stream;
    for (const track of stream.getVideoTracks()) {
      track.addEventListener("ended", () => this.handleLocalScreenShareEnded(), { once: true });
    }
    this.attachScreenSharePreviewElement();
    this.hooks.flushAliases();
  }

  focusedScreenShareStatusLabel(share: ScreenShareSession | undefined) {
    if (!share) return "";
    if (share.owner_member_id !== this.hooks.memberId()) {
      return this.hooks.screenShare().watchStatusLabel(share);
    }
    if (this.nativeScreenShareSenderSession && this.nativeLocalScreenSharePreviewRequested) {
      if (this.nativeLocalScreenSharePreviewError) return this.nativeLocalScreenSharePreviewError;
      if (this.nativeLocalScreenSharePreviewStream) return this.hooks.translate("screenShare.localPreviewDirectLive");
      return this.hooks.translate("screenShare.localPreviewDirectConnecting");
    }
    if (this.nativeScreenShareSenderSession) return this.nativeScreenSharePreviewStatusLabel();
    return this.localScreenShareStream
      ? this.hooks.translate("screenShare.localPreviewLive")
      : this.hooks.translate("screenShare.waitingForVideo");
  }

  async recoverScreenShareWatchesAfterReconnect() {
    if (!this.hooks.sessionToken() || !this.hooks.memberId() ||
      this.hooks.realtime().eventSocket?.readyState !== WebSocket.OPEN) return;
    // If this refresh discovers our own voice state was removed while we were
    // offline, the voice channel is eligible for an automatic rejoin.
    const connectionContext = this.hooks.voiceConnectionContext();
    if (connectionContext) {
      this.hooks.realtime().armVoiceRejoin(connectionContext.channelId);
    }
    await Promise.all([
      this.hooks.voiceState().refreshVoiceStates(true),
      this.hooks.refreshScreenShareSessions(),
      this.hooks.accompaniment().refreshSessions()
    ]);
    const persistedWatches = this.hooks.screenShare().sessions.filter(
      (share) =>
        share.owner_member_id !== this.hooks.memberId() &&
        (share.viewer_member_ids ?? []).includes(this.hooks.memberId()) &&
        this.hooks.currentVoiceState()?.channel_id === share.channel_id
    );
    for (const share of persistedWatches) {
      this.hooks.screenShare().watchedShareIds = this.withSetValue(
        this.hooks.screenShare().watchedShareIds,
        share.share_id
      );
      if (this.hooks.screenShare().playbackHealthy(share) ||
        this.hooks.screenShare().isScreenShareWatchBusy(share)) continue;
      await this.hooks.screenShare().startWatchingScreenShare(share);
    }
    this.syncViewerScreenShareSignalPolling();
  }

  async startScreenSharePopoutWatch() {
    if (!this.hooks.screenSharePopoutMode() || this.screenSharePopoutWatchBusy || this.screenSharePopoutWatchStarted) return;
    this.screenSharePopoutWatchBusy = true;
    try {
      let share = this.hooks.screenShare().sessions.find(
        (item) => item.share_id === this.hooks.screenSharePopoutShareId()
      );
      if (!share && this.hooks.sessionToken()) {
        await this.hooks.refreshScreenShareSessions();
        share = this.hooks.screenShare().sessions.find(
          (item) => item.share_id === this.hooks.screenSharePopoutShareId()
        );
      }
      if (!share) return;
      this.hooks.setSelectedChannelId(share.channel_id);
      this.hooks.setChannelContentMode("voice");
      this.hooks.setFocusedScreenShareId(share.share_id);
      if (share.owner_member_id === this.hooks.memberId()) {
        this.screenSharePopoutWatchStarted = true;
        this.hooks.flushAliases();
        return;
      }
      if (!this.hooks.screenShare().canWatchScreenShare(share)) {
        this.hooks.setError(this.hooks.translate("screenShare.joinVoiceToWatch"));
        return;
      }
      this.screenSharePopoutWatchStarted = true;
      this.hooks.flushAliases();
      await this.hooks.screenShare().startWatchingScreenShare(share);
    } finally {
      this.screenSharePopoutWatchBusy = false;
    }
  }

  openFocusedScreenShare(share: ScreenShareSession) {
    const isOwnShare = share.owner_member_id === this.hooks.memberId();
    if (isOwnShare ? !this.hooks.currentMemberActiveScreenShare() : !this.hooks.screenShare().isWatchingScreenShare(share)) return;
    this.openScreenShareViewer(share);
  }

  openScreenShareViewer(share: ScreenShareSession) {
    const isOwnShare = share.owner_member_id === this.hooks.memberId();
    if (isOwnShare ? !this.hooks.currentMemberActiveScreenShare() : !this.hooks.screenShare().isWatchingScreenShare(share)) return;
    if (this.hooks.focusedScreenShareId() !== share.share_id) this.hooks.releaseActiveRemoteControlCapture();
    this.hooks.closeCreateChannelMenu();
    this.hooks.closeMessageContextMenu();
    this.hooks.closeServerMenu();
    this.hooks.clearReplyTarget();
    this.hooks.clearMessageSearch();
    this.hooks.clearFileView();
    this.hooks.setSelectedChannelId(share.channel_id);
    this.hooks.setChannelContentMode("voice");
    void this.hooks.focusMemberAccessFilter(share.channel_id);
    this.hooks.setFocusedScreenShareId(share.share_id);
    if (isOwnShare && this.nativeScreenShareSenderSession) {
      void this.hooks.realtime().startNativeLocalScreenSharePreview(share);
    }
  }

  closeFocusedScreenShare() {
    this.closeScreenShareViewerPanel();
    this.hooks.releaseActiveRemoteControlCapture();
    if (this.nativeLocalScreenSharePreviewRequested) {
      void this.hooks.realtime().stopNativeLocalScreenSharePreview();
    }
    this.hooks.setFocusedScreenShareId("");
  }

  detachLocalScreenShareWatch(share: ScreenShareSession) {
    const control = this.hooks.currentMemberRemoteControlForShare(share.share_id) as
      { control_id?: string } | undefined;
    if (control && this.hooks.remoteControlCaptureControlId() === control.control_id) {
      this.hooks.releaseActiveRemoteControlCapture();
    }
    this.hooks.screenShare().watchedShareIds = this.withoutSetValue(
      this.hooks.screenShare().watchedShareIds,
      share.share_id
    );
    this.syncViewerScreenShareSignalPolling();
    this.hooks.setPoppedOutScreenShareIds(
      this.withoutSetValue(this.hooks.poppedOutScreenShareIds(), share.share_id)
    );
    this.hooks.screenShare().clearWatchRetryTimers(share.share_id);
    this.hooks.screenShare().clearReconnectTimer(share.share_id);
    this.hooks.screenShare().clearWatchSession(share.share_id);
    this.hooks.screenShare().clearWatchStatus(share.share_id);
    if (this.hooks.focusedScreenShareId() === share.share_id) {
      this.hooks.setFocusedScreenShareId("");
    }
    this.closeScreenShareViewerPanel();
    this.closeScreenSharePeerConnection(this.hooks.screenShareOwnerPeerId(share));
  }

  async openSystemScreenSharePopout(share: ScreenShareSession) {
    try {
      const api = await import("@tauri-apps/api/core");
      await api.invoke("open_screen_share_popout", {
        shareId: share.share_id,
        title: `${this.hooks.memberDisplayName(share.owner_member_id)} - ${this.hooks.translate("screenShare.viewerTitle")}`
      });
      return true;
    } catch (caught) {
      const message = caught instanceof Error
        ? caught.message
        : typeof caught === "string" && caught.trim()
          ? caught
          : this.hooks.translate("error.screenSharePopoutFailed");
      this.hooks.setError(message);
      await this.hooks.showAppAlert(message, { title: this.hooks.translate("screenShare.popOut") });
      return false;
    }
  }

  async openBrowserScreenSharePictureInPicture() {
    const video = this.hooks.focusedScreenShareVideoElement() as (HTMLVideoElement & {
      requestPictureInPicture?: () => Promise<unknown>;
    }) | null;
    const pictureInPictureDocument = document as Document & {
      pictureInPictureEnabled?: boolean;
      pictureInPictureElement?: Element | null;
      exitPictureInPicture?: () => Promise<void>;
    };
    if (!video || !pictureInPictureDocument.pictureInPictureEnabled || !video.requestPictureInPicture) {
      this.hooks.setError(this.hooks.translate("error.screenSharePictureInPictureUnavailable"));
      return false;
    }
    try {
      if (pictureInPictureDocument.pictureInPictureElement === video) return true;
      if (pictureInPictureDocument.pictureInPictureElement && pictureInPictureDocument.exitPictureInPicture) {
        await pictureInPictureDocument.exitPictureInPicture();
      }
      await video.requestPictureInPicture();
      return true;
    } catch (caught) {
      this.hooks.setError(
        caught instanceof Error
          ? caught.message
          : this.hooks.translate("error.screenSharePictureInPictureUnavailable")
      );
      return false;
    }
  }

  async popOutScreenShare(share: ScreenShareSession) {
    if (!this.hooks.screenShare().isWatchingScreenShare(share) || share.owner_member_id === this.hooks.memberId()) return;
    if (!this.hooks.isTauriRuntime()) {
      await this.openBrowserScreenSharePictureInPicture();
      return;
    }
    if (await this.openSystemScreenSharePopout(share)) {
      this.detachLocalScreenShareWatch(share);
    }
  }

  startScreenSharePopoutWindowDrag(event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (
      !this.hooks.screenSharePopoutMode() ||
      event.button !== 0 ||
      target?.closest("button, input, select, textarea, a, [contenteditable='true'], [data-screen-share-popout-no-drag]")
    ) return;
    event.preventDefault();
    void startDraggingScreenSharePopoutWindow();
  }

  screenSharePopoutDrag(node: HTMLElement) {
    const handler = (event: MouseEvent) => this.startScreenSharePopoutWindowDrag(event);
    node.addEventListener("mousedown", handler);
    return {
      destroy() {
        node.removeEventListener("mousedown", handler);
      }
    };
  }

  startScreenSharePopoutWindowResize(direction: ScreenSharePopoutResizeDirection, event: MouseEvent) {
    if (!this.hooks.screenSharePopoutMode() || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    void startResizingScreenSharePopoutWindow(direction);
  }

  async closeScreenSharePopoutWindow() {
    if (this.focusedShare && this.hooks.screenShare().isWatchingScreenShare(this.focusedShare)) {
      await this.hooks.screenShare().stopWatchingScreenShare(this.focusedShare);
    }
    await closeNativeScreenSharePopoutWindow();
  }

  closePoppedOutScreenShare(share: ScreenShareSession) {
    this.hooks.setPoppedOutScreenShareIds(
      this.withoutSetValue(this.hooks.poppedOutScreenShareIds(), share.share_id)
    );
  }

  async requestFocusedScreenShareFullscreen() {
    await this.hooks.screenShareFocusElement()?.requestFullscreen?.().catch(() => undefined);
  }

  // ---- WebRTC outgoing media ---------------------------------------------------

  async replaceOutgoingScreenShareTrack(track: MediaStreamTrack | null) {
    const replacements: Promise<unknown>[] = [];
    for (const [targetMemberId, connection] of this.screenSharePeerConnections.entries()) {
      const existingSender = this.screenShareSenders.get(targetMemberId);
      if (existingSender) {
        if (track) {
          this.addOutgoingScreenShareAudioForMember(targetMemberId, connection);
          replacements.push(
            existingSender
              .replaceTrack(track)
              .then(() => this.configureScreenShareSender(existingSender, targetMemberId))
              .then(() => this.renegotiateScreenSharePeerConnection(targetMemberId, connection))
              .then(() => this.configureScreenShareSender(existingSender, targetMemberId))
          );
        } else {
          connection.removeTrack(existingSender);
          this.screenShareSenders.delete(targetMemberId);
          this.removeOutgoingScreenShareAudioForMember(targetMemberId, connection);
          replacements.push(this.renegotiateScreenSharePeerConnection(targetMemberId, connection));
        }
        continue;
      }
      if (track && this.localScreenShareStream) {
        const sender = connection.addTrack(track, this.localScreenShareStream);
        this.screenShareSenders.set(targetMemberId, sender);
        this.configureScreenShareCodecPreferences(connection, sender);
        this.addOutgoingScreenShareAudioForMember(targetMemberId, connection);
        replacements.push(
          this.configureScreenShareSender(sender, targetMemberId)
            .then(() => this.renegotiateScreenSharePeerConnection(targetMemberId, connection))
            .then(() => this.configureScreenShareSender(sender, targetMemberId))
        );
      } else if (!track && this.removeOutgoingScreenShareAudioForMember(targetMemberId, connection)) {
        replacements.push(this.renegotiateScreenSharePeerConnection(targetMemberId, connection));
      }
    }
    await Promise.allSettled(replacements);
  }

  async addOutgoingScreenShareForMember(targetMemberId: string, watchSessionId = "") {
    if (
      !this.localScreenShareStream ||
      !(
        this.hooks.currentMemberScreenShare() ??
        this.hooks.screenShare().sessions.find(
          (share) => share.owner_member_id === this.hooks.memberId()
        )
      )
    ) {
      return;
    }
    const track = this.localScreenShareStream.getVideoTracks()[0];
    if (!track) return;
    const connection = this.ensureScreenSharePeerConnection(targetMemberId);
    const existingSender = this.screenShareSenders.get(targetMemberId);
    if (existingSender) {
      await existingSender.replaceTrack(track);
      await this.configureScreenShareSender(existingSender, targetMemberId);
      this.addOutgoingScreenShareAudioForMember(targetMemberId, connection);
      await this.renegotiateScreenSharePeerConnection(targetMemberId, connection, watchSessionId);
      await this.configureScreenShareSender(existingSender, targetMemberId);
      return;
    }
    const sender = connection.addTrack(track, this.localScreenShareStream);
    this.screenShareSenders.set(targetMemberId, sender);
    this.configureScreenShareCodecPreferences(connection, sender);
    this.addOutgoingScreenShareAudioForMember(targetMemberId, connection);
    await this.renegotiateScreenSharePeerConnection(targetMemberId, connection, watchSessionId);
    // Encoding parameters only exist once the sender has been negotiated, so the
    // first apply has to wait for the offer. Applying them earlier throws
    // "RTP sender encoding parameters are not ready", and letting that escape
    // aborted the whole watch: no offer, no picture, viewer retrying forever.
    await this.configureScreenShareSender(sender, targetMemberId).catch((caught: unknown) => {
      console.warn("[EchoVoice] could not apply screen share encoding parameters", {
        target: targetMemberId,
        error: caught instanceof Error ? caught.message : String(caught)
      });
      return false;
    });
  }

  private configureScreenShareCodecPreferences(connection: RTCPeerConnection, sender: RTCRtpSender) {
    const transceiver = connection.getTransceivers().find((item) => item.sender === sender);
    const capabilities = RTCRtpSender.getCapabilities?.("video");
    if (!transceiver || !capabilities?.codecs?.length || typeof transceiver.setCodecPreferences !== "function") return;
    const setup = this.hooks.screenShareSetup();
    const frame = setup.resolvedFrame(sender.track);
    const load = {
      width: frame.width,
      height: frame.height,
      frameRate: frame.frameRate,
      encoders: Math.max(1, this.screenShareSenders.size)
    };
    try {
      transceiver.setCodecPreferences(orderScreenShareCodecs(capabilities.codecs, setup.contentMode, load));
    } catch (caught) {
      console.warn("[EchoVoice] could not apply screen share codec preferences", {
        mode: setup.contentMode,
        load,
        error: caught instanceof Error ? caught.message : String(caught)
      });
    }
  }

  // A running share captured its parameters when each viewer joined, so a
  // quality change in the panel would otherwise only reach the next viewer.
  // `stable` keeps a browser that refuses one knob from tearing down a sender
  // that is already delivering frames.
  async applyScreenShareSenderSettings(): Promise<void> {
    this.webQuality.clear();
    if (this.hooks.screenShareSetup().contentMode !== "smart") {
      this.smartContent.stop();
      this.smartMode = "balanced";
      this.appliedSmartMode.clear();
    }
    if (this.screenShareSenders.size === 0) return;
    await Promise.all(
      [...this.screenShareSenders].map(([peerId, sender]) =>
        this.configureScreenShareSender(sender, peerId, { stable: true }).catch(() => false)
      )
    );
  }

  async configureScreenShareSender(
    sender: RTCRtpSender,
    targetMemberId = "",
    options: { stable?: boolean } = {}
  ) {
    const previous = this.senderUpdates.get(sender);
    const apply = () => this.applyWebSenderParameters(sender, targetMemberId, options);
    const update = previous ? previous.then(apply, apply) : apply();
    this.senderUpdates.set(sender, update);
    try {
      return await update;
    } finally {
      if (this.senderUpdates.get(sender) === update) this.senderUpdates.delete(sender);
    }
  }

  private async applyWebSenderParameters(sender: RTCRtpSender, targetMemberId: string, options: { stable?: boolean }) {
    if (targetMemberId && this.screenShareSenders.get(targetMemberId) !== sender) return false;
    const setup = this.hooks.screenShareSetup();
    const smart = setup.contentMode === "smart";
    const mode = smart ? this.smartMode : setup.contentMode;
    const tier = (smart || setup.adaptiveWebQuality) && setup.bitrateOption === "auto" ? this.webQuality.get(targetMemberId)?.tier ?? 0 : 0;
    const encodingLimits = webScreenShareEncoding(tier, mode, setup.targetBitrate(sender.track), setup.frameRate);
    const targetBitrate = encodingLimits.maxBitrate;
    let failure: unknown = null;
    for (const includePriority of [true, false]) {
      try {
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) {
          throw new Error("RTP sender encoding parameters are not ready");
        }
        const encodings = [...parameters.encodings];
        const encoding = {
          ...encodings[0],
          active: true,
          ...encodingLimits
        } as RTCRtpEncodingParameters & {
          priority?: "very-low" | "low" | "medium" | "high";
          networkPriority?: "very-low" | "low" | "medium" | "high";
        };
        if (includePriority) {
          encoding.priority = "medium";
          encoding.networkPriority = "low";
        }
        encodings[0] = encoding;
        parameters.encodings = encodings;
        const screenShareParameters = parameters as RTCRtpSendParameters & {
          degradationPreference?: "maintain-framerate" | "maintain-resolution" | "balanced";
        };
        screenShareParameters.degradationPreference = screenShareDegradationPreference(mode);
        await sender.setParameters(screenShareParameters);

        const applied = sender.getParameters().encodings?.[0];
        if (!applied || applied.maxBitrate !== targetBitrate) {
          throw new Error(`browser reported ${applied?.maxBitrate ?? "no"} max bitrate after applying ${targetBitrate}`);
        }
        if (tier > 0 && (applied.maxFramerate !== encodingLimits.maxFramerate ||
          (applied.scaleResolutionDownBy ?? 1) !== encodingLimits.scaleResolutionDownBy)) {
          throw new Error("Browser did not apply the per-viewer encoding limits");
        }
        if (targetMemberId && this.screenShareSenders.get(targetMemberId) !== sender) return false;
        if (smart && mode !== "smart") this.appliedSmartMode.set(targetMemberId, mode);
        this.clearWebScreenShareSenderConfigurationError(targetMemberId);
        return true;
      } catch (caught) {
        failure = caught;
      }
    }

    if (options.stable && this.screenShareSenders.get(targetMemberId) === sender) {
      const message = failure instanceof Error ? failure.message : String(failure ?? "unknown error");
      this.setWebScreenShareSenderConfigurationError(targetMemberId, message);
      console.warn("[EchoVoice] screen share sender parameters were not applied after negotiation", {
        targetMemberId,
        targetBitrate,
        frameRate: this.hooks.screenShareSetup().frameRate,
        error: message
      });
    }
    return false;
  }

  /**
   * Retunes the running native encoder's ceiling. The controller keeps doing
   * its own probing inside that ceiling, so this is a budget change rather than
   * a number forced onto the encoder.
   */
  async setNativeScreenShareMaximumBitrate(bitrateBps: number): Promise<boolean> {
    const session = this.nativeScreenShareSenderSession;
    if (!session || !Number.isFinite(bitrateBps) || bitrateBps <= 0) return false;
    const status = await setNativeScreenShareQuality(session.sessionId, { kind: "max-bitrate", value: Math.round(bitrateBps) });
    if (this.nativeScreenShareSenderSession?.sessionId !== session.sessionId) return false;
    this.applyNativeScreenShareSenderStatus(status, "max-bitrate-signal");
    return true;
  }

  /**
   * Retargets the running native capture cadence. The capture keeps running at
   * the source rate and the frame pump forwards fewer frames, so this does not
   * need a renegotiation or a new encoder.
   */
  async setNativeScreenShareFrameRate(frameRate: number): Promise<boolean> {
    const session = this.nativeScreenShareSenderSession;
    if (!session || !Number.isFinite(frameRate) || frameRate <= 0) return false;
    const status = await setNativeScreenShareQuality(session.sessionId, { kind: "frame-rate", value: Math.round(frameRate) });
    if (this.nativeScreenShareSenderSession?.sessionId !== session.sessionId) return false;
    this.applyNativeScreenShareSenderStatus(status, "frame-rate-signal");
    return true;
  }

  /**
   * Adds or drops the shared soundtrack on connections that are already
   * sending. Returns false when there is nothing to send: a capture granted
   * without system audio cannot grow one afterwards, so that change can only
   * reach the next share.
   */
  async setOutgoingScreenShareAudioEnabled(enabled: boolean): Promise<boolean> {
    const stream = this.localScreenShareStream;
    if (!stream || this.screenSharePeerConnections.size === 0) return false;
    if (enabled && stream.getAudioTracks().length === 0) return false;
    const changes: Promise<unknown>[] = [];
    for (const [targetMemberId, connection] of this.screenSharePeerConnections.entries()) {
      const attached = this.screenShareAudioSenders.get(targetMemberId)?.length ?? 0;
      if (enabled === (attached > 0)) continue;
      if (enabled) {
        this.addOutgoingScreenShareAudioForMember(targetMemberId, connection);
      } else {
        this.removeOutgoingScreenShareAudioForMember(targetMemberId, connection);
      }
      // A new or removed m-line only reaches the viewer through a renegotiation.
      changes.push(this.renegotiateScreenSharePeerConnection(targetMemberId, connection));
    }
    await Promise.allSettled(changes);
    return true;
  }

  private addOutgoingScreenShareAudioForMember(targetMemberId: string, connection: RTCPeerConnection) {
    if (!this.localScreenShareStream || this.screenShareAudioSenders.has(targetMemberId)) return;
    const audioTracks = this.localScreenShareStream.getAudioTracks();
    if (audioTracks.length === 0) return;
    const senders = audioTracks.map((track) => connection.addTrack(track, this.localScreenShareStream as MediaStream));
    this.screenShareAudioSenders.set(targetMemberId, senders);
  }

  private removeOutgoingScreenShareAudioForMember(targetMemberId: string, connection: RTCPeerConnection) {
    const senders = this.screenShareAudioSenders.get(targetMemberId) ?? [];
    const removed = senders.length > 0;
    for (const sender of senders) {
      connection.removeTrack(sender);
    }
    this.screenShareAudioSenders.delete(targetMemberId);
    return removed;
  }

  bindScreenSharePeerConnectionToShare(targetMemberId: string, shareId: string) {
    if (!shareId) return;
    this.screenSharePeerConnectionShareIds.set(targetMemberId, shareId);
    const connection = this.screenSharePeerConnections.get(targetMemberId);
    if (connection && connection.signalingState !== "closed") {
      void this.refreshScreenShareReceiverStats(targetMemberId, connection, shareId);
    }
  }

  screenShareIdForPeerConnection(targetMemberId: string) {
    return this.screenSharePeerConnectionShareIds.get(targetMemberId) ?? "";
  }

  /** The connection that feeds a share, found by share binding rather than by
   * a guessed peer id. Health checks need this: the peer id of a share is a
   * participant id on one side and a member id on the other, and looking up
   * the wrong one makes a live stream look dead. */
  screenSharePeerConnectionForShare(shareId: string) {
    if (!shareId) return undefined;
    for (const [peerId, connection] of this.screenSharePeerConnections.entries()) {
      if (this.screenSharePeerConnectionShareIds.get(peerId) === shareId) return connection;
    }
    return undefined;
  }

  private screenShareSignalWatchSessionIdForPeer(targetMemberId: string, shareId: string) {
    const share = this.hooks.screenShare().sessions.find((item) => item.share_id === shareId);
    if (
      share?.owner_member_id === this.hooks.memberId() ||
      this.hooks.currentMemberScreenShare()?.share_id === shareId ||
      this.nativeScreenShareSenderSession?.shareId === shareId
    ) {
      return this.hooks.screenShare().watcherSessionIds.get(targetMemberId) ?? "";
    }
    return this.hooks.screenShare().watchSessionIds.get(shareId) ?? "";
  }

  /**
   * Drops a share connection that has no viewer left on the other end.
   *
   * A viewer that closes its tab never sends unwatch, and a send-only
   * connection is excluded from the viewer recovery path, so without this the
   * peer connection - and the encoder behind it - would survive until the whole
   * share stopped.
   */
  private scheduleOutgoingScreenShareCleanup(targetMemberId: string, connection: RTCPeerConnection) {
    const pendingConnect = this.outgoingShareConnectTimers.get(targetMemberId);
    if (!screenShareConnectionHasFailed(connection)) {
      // Any non-failed state means this connection may still recover on its own,
      // so a cleanup armed earlier must not fire.
      const pending = this.outgoingShareCleanupTimers.get(targetMemberId);
      if (pending !== undefined) {
        window.clearTimeout(pending);
        this.outgoingShareCleanupTimers.delete(targetMemberId);
      }
      if (!screenShareConnectionIsConnecting(connection)) {
        // Connected (or closing): the connect deadline has done its job.
        if (pendingConnect !== undefined) {
          window.clearTimeout(pendingConnect);
          this.outgoingShareConnectTimers.delete(targetMemberId);
        }
        return;
      }
      if (pendingConnect !== undefined) return;
      // A viewer that never completes ICE never fails either, so nothing else
      // would ever release the peer connection - or its share of the encoder.
      const connectTimer = window.setTimeout(() => {
        this.outgoingShareConnectTimers.delete(targetMemberId);
        if (this.screenSharePeerConnections.get(targetMemberId) !== connection) return;
        if (!screenShareConnectionIsConnecting(connection)) return;
        this.closeScreenSharePeerConnection(targetMemberId);
      }, this.outgoingShareConnectDeadlineMS);
      this.outgoingShareConnectTimers.set(targetMemberId, connectTimer);
      return;
    }
    if (pendingConnect !== undefined) {
      window.clearTimeout(pendingConnect);
      this.outgoingShareConnectTimers.delete(targetMemberId);
    }
    if (this.outgoingShareCleanupTimers.has(targetMemberId)) return;
    const timer = window.setTimeout(() => {
      this.outgoingShareCleanupTimers.delete(targetMemberId);
      if (this.screenSharePeerConnections.get(targetMemberId) !== connection) return;
      if (!screenShareConnectionHasFailed(connection)) return;
      this.closeScreenSharePeerConnection(targetMemberId);
    }, this.outgoingShareCleanupDelayMS);
    this.outgoingShareCleanupTimers.set(targetMemberId, timer);
  }

  private handleScreenShareConnectionRecovery(
    targetMemberId: string,
    connection: RTCPeerConnection,
    shareId: string
  ) {
    if (!shareId || this.screenSharePeerConnections.get(targetMemberId) !== connection) return;
    // Recovery is the viewer's job. On a connection we only send on, asking the
    // peer to restart ICE on our behalf would just be a signal it has to drop;
    // the viewer notices the same failure and rebuilds. A peer we both send to
    // and receive from still needs the viewer half, so only pure senders are
    // skipped.
    if (this.screenShareSenders.has(targetMemberId) && !screenSharePeerReceivesVideo(connection)) {
      this.scheduleOutgoingScreenShareCleanup(targetMemberId, connection);
      return;
    }
    const failed = connection.connectionState === "failed" || connection.iceConnectionState === "failed";
    const connected = connection.connectionState === "connected" || connection.iceConnectionState === "connected";
    const disconnected =
      connection.connectionState === "disconnected" || connection.iceConnectionState === "disconnected";
    let state: ScreenShareRecoveryState;
    if (failed) {
      state = "failed";
    } else if (disconnected) {
      state = "disconnected";
    } else if (connected) {
      const share = this.hooks.screenShare().sessions.find((item) => item.share_id === shareId);
      state = share && this.hooks.screenShare().playbackHealthy(share) ? "healthy" : "unhealthy";
    } else {
      // "new" and "connecting" have nothing to recover from yet.
      return;
    }

    const decision = decideScreenShareRecovery({
      state,
      nowMS: Date.now(),
      lastIceRestartRequestedAtMS: this.screenShareIceRestartRequests.get(targetMemberId)
    });
    if (decision.action === "hold") {
      this.hooks.screenShare().clearReconnectTimer(shareId);
      return;
    }
    if (decision.action === "rebuild") {
      this.hooks.screenShare().scheduleReconnect(shareId, decision.delayMS);
      return;
    }
    // Ask the sharer to restart ICE on the connection that already exists. A
    // sharer that predates this signal ignores it, so the scheduled rebuild is
    // still the fallback rather than a race.
    this.requestScreenShareIceRestart(targetMemberId, shareId);
    this.hooks.screenShare().scheduleReconnect(shareId, decision.fallbackDelayMS);
  }

  private requestScreenShareIceRestart(targetMemberId: string, shareId: string) {
    this.screenShareIceRestartRequests.set(targetMemberId, Date.now());
    this.hooks.sendRTCSignal(targetMemberId, "screen-share-restart-ice", {
      share_id: shareId,
      watch_session_id: this.screenShareSignalWatchSessionIdForPeer(targetMemberId, shareId)
    });
  }

  /**
   * Sharer side of {@link requestScreenShareIceRestart}: renegotiate the existing
   * connection instead of tearing it down, which keeps the encoder and the
   * keyframe cadence alive for every other viewer.
   */
  async handleScreenShareIceRestartSignal(signal: RTCSignal) {
    const peerId = signal.from_participant_id || signal.from_member_id;
    const shareID = this.screenShareSignalShareId(signal);
    const watchSessionId = this.screenShareSignalWatchSessionId(signal);
    const expectedWatchSessionId = this.hooks.screenShare().watcherSessionIds.get(peerId) ?? "";
    if (expectedWatchSessionId && watchSessionId !== expectedWatchSessionId) return;
    const senderSession = this.nativeScreenShareSenderSession;
    const nativeOwned = Boolean(senderSession && shareID && senderSession.shareId === shareID);
    const ownShare = nativeOwned || (shareID
      ? this.hooks.screenShare().sessions.some(
          (item) => item.share_id === shareID && item.owner_member_id === this.hooks.memberId()
        ) || this.hooks.currentMemberScreenShare()?.share_id === shareID
      : true);
    if (!ownShare) return;
    if (nativeOwned && senderSession) {
      // The native sender owns the encoder, so only it can restart ICE without
      // throwing that encoder away. A failure here is not fatal: the viewer
      // rebuilds the whole connection when no offer arrives.
      const status = await handleNativeScreenShareSenderSignal(
        senderSession.sessionId,
        peerId,
        "screen-share-restart-ice",
        signal.data
      );
      if (this.nativeScreenShareSenderSession?.sessionId !== senderSession.sessionId) return;
      this.applyNativeScreenShareSenderStatus(status, "ice-restart-signal");
      await this.forwardNativeScreenShareSenderSignals(senderSession.sessionId);
      if (this.nativeScreenShareSenderSession?.sessionId !== senderSession.sessionId) return;
      this.scheduleNativeScreenShareSignalFlush(senderSession.sessionId);
      return;
    }
    const connection = this.screenSharePeerConnections.get(peerId);
    if (!connection) return;
    await this.renegotiateScreenSharePeerConnection(peerId, connection, watchSessionId, true);
  }

  /** Whether the ICE configuration can produce a relay candidate at all. */
  private screenShareRelayIsConfigured(): boolean {
    const configuration = this.hooks.browserRTCConfiguration();
    return (configuration.iceServers ?? []).some((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some(
        (url) => typeof url === "string" && url.trim().toLowerCase().startsWith("turn")
      );
    });
  }

  private screenSharePeerConnectionConfiguration(shareId: string): RTCConfiguration {
    const configuration = this.hooks.browserRTCConfiguration();
    const preference = shareId ? this.screenSharePathPreferences.get(shareId) ?? "auto" : "auto";
    // Forcing the direct path is not an ICE policy — there is no "never relay"
    // mode — so the TURN servers are withheld instead. That still leaves the
    // direct pair every candidate it can use on this network.
    if (preference === "direct") {
      return {
        ...configuration,
        iceServers: screenShareDirectIceServers(configuration.iceServers)
      };
    }
    // Relay-only gathering is pointless without a TURN server: it would produce
    // no candidates and turn a blurry picture into no picture.
    if (preference !== "relay" || !this.screenShareRelayIsConfigured()) return configuration;
    return { ...configuration, iceTransportPolicy: "relay" };
  }

  /** The path this viewer is using, or `auto` while the startup check runs. */
  screenSharePathPreference(shareId: string): ScreenSharePathPreference {
    return shareId ? this.screenSharePathPreferences.get(shareId) ?? "auto" : "auto";
  }

  /**
   * The viewer's own choice. Rebuilding is the only way to change which
   * candidates ICE gets, so this always starts a fresh connection — and a fresh
   * startup window, since the old samples describe the path being left behind.
   */
  setScreenSharePathPreference(shareId: string, preference: ScreenSharePathPreference): void {
    if (!shareId) return;
    if (this.screenSharePathPreference(shareId) === preference) return;
    this.screenSharePathPreferences.set(shareId, preference);
    this.screenSharePathHistory.delete(shareId);
    noteScreenShareWatchDecision(`path-preference share=${shareId} preference=${preference}`);
    console.info("[EchoVoice] screen share path preference", { share: shareId, preference });
    this.retryWatchingScreenShareOnNewPath(shareId);
  }

  /** Which viewer's path menu is open, if any. */
  screenSharePathMenuShareId = $state("");

  /**
   * What each watched share is actually running on, for people who need to answer
   * "is this direct or relayed right now" without a devtools profiler.
   *
   * The status line names the path only for a settled picture, so the interesting
   * case — a share that never settles — has no answer on screen. This reads the
   * same measurements the decisions use, and is exposed on `window` in every
   * build because a real deployment has no other channel.
   */
  screenSharePathReport(): Array<{
    shareId: string;
    preference: ScreenSharePathPreference;
    pathKind: ScreenSharePathKind;
    frameWidth?: number;
    frameHeight?: number;
    frameRate?: number;
    receivedBitrateBps?: number;
    framesDecoded?: number;
    playoutDelayMS?: number;
    relayCandidates?: number;
    missingCandidatePairSamples?: number;
    watchStage?: string;
    error?: string;
  }> {
    const reports: Array<ReturnType<ScreenShareTransportController["screenSharePathReport"]>[number]> = [];
    for (const share of this.hooks.screenShare().sessions) {
      const shareId = share.share_id;
      const status = this.hooks.screenShare().watchStatuses.get(shareId);
      let peerId = "";
      for (const [candidatePeerId, boundShareId] of this.screenSharePeerConnectionShareIds.entries()) {
        if (boundShareId === shareId) {
          peerId = candidatePeerId;
          break;
        }
      }
      const history = this.screenSharePathHistory.get(shareId);
      reports.push({
        shareId,
        preference: this.screenSharePathPreference(shareId),
        pathKind:
          status?.pathKind ?? (peerId ? this.webScreenShareViewerPaths.get(peerId) : undefined) ?? "unknown",
        frameWidth: status?.frameWidth,
        frameHeight: status?.frameHeight,
        frameRate: status?.frameRate,
        receivedBitrateBps: history?.receivedBitrateBps,
        framesDecoded: status?.framesDecoded,
        playoutDelayMS: peerId ? this.screenSharePlayoutDelays.get(peerId) : undefined,
        relayCandidates: this.screenShareRelayCandidates.get(shareId) ?? 0,
        missingCandidatePairSamples: peerId ? this.screenShareMissingPairSamples.get(peerId) : undefined,
        watchStage: status?.stage,
        error: status?.error
      });
    }
    return reports;
  }

  toggleScreenSharePathMenu(shareId: string): void {
    this.screenSharePathMenuShareId = this.screenSharePathMenuShareId === shareId ? "" : shareId;
  }

  /**
   * A relay-only connection cannot start without a TURN allocation, and a failed
   * allocation is silent: gathering simply ends with no candidate, so the viewer
   * stares at a black frame until the watch deadline. Watch for the allocation,
   * and when it never comes, hand the path back to ICE instead of to a timeout.
   */
  private startScreenShareRelayWatch(shareId: string, connection: RTCPeerConnection): void {
    this.stopScreenShareRelayWatch(shareId);
    if (!shareId) return;
    if ((this.screenSharePathPreferences.get(shareId) ?? "auto") !== "relay") return;
    if (!this.screenShareRelayIsConfigured()) return;
    this.screenShareRelayCandidates.set(shareId, 0);
    noteScreenShareWatchDecision(`relay-watch share=${shareId}`);
    const startedAtMS = Date.now();
    const timer = window.setInterval(() => {
      const verdict = screenShareRelayCandidateVerdict({
        preference: this.screenSharePathPreferences.get(shareId) ?? "auto",
        relayConfigured: this.screenShareRelayIsConfigured(),
        relayCandidates: this.screenShareRelayCandidates.get(shareId) ?? 0,
        connected: connection.connectionState === "connected",
        waitedMS: Date.now() - startedAtMS
      });
      if (verdict === "wait" && connection.connectionState !== "closed") return;
      this.stopScreenShareRelayWatch(shareId);
      if (verdict !== "unavailable") return;
      // Not a quality switch: a relay-only connection with no TURN allocation can
      // never produce a picture, so returning to ICE is the only alternative to a
      // watch that dies on its own deadline.
      this.screenSharePathPreferences.set(shareId, "direct");
      console.warn("[EchoVoice] screen share relay is unreachable; falling back to ICE", {
        share: shareId,
        waitedMS: Date.now() - startedAtMS
      });
      this.hooks.setError(this.hooks.translate("error.screenShareRelayUnavailable"));
      noteScreenShareWatchDecision(
        `relay-unavailable share=${shareId} waited=${Date.now() - startedAtMS}ms`
      );
      this.retryWatchingScreenShareOnNewPath(shareId);
    }, 500);
    this.screenShareRelayWatchTimers.set(shareId, timer);
  }

  private stopScreenShareRelayWatch(shareId: string): void {
    const timer = this.screenShareRelayWatchTimers.get(shareId);
    if (timer !== undefined) window.clearInterval(timer);
    this.screenShareRelayWatchTimers.delete(shareId);
    this.screenShareRelayCandidates.delete(shareId);
  }

  ensureScreenSharePeerConnection(targetMemberId: string, shareId = "") {
    let connection = this.screenSharePeerConnections.get(targetMemberId);
    if (connection && connection.signalingState !== "closed" && connection.connectionState !== "failed") {
      this.bindScreenSharePeerConnectionToShare(targetMemberId, shareId);
      return connection;
    }
    if (connection) {
      this.closeScreenSharePeerConnection(targetMemberId);
    }

    const boundShareId = shareId || this.screenShareIdForPeerConnection(targetMemberId) || "";
    connection = new RTCPeerConnection(this.screenSharePeerConnectionConfiguration(boundShareId));
    this.screenSharePeerConnections.set(targetMemberId, connection);
    this.screenSharePeerCredentialFetchedAtMS.set(targetMemberId, this.hooks.rtcIceConfigFetchedAtMS?.() ?? 0);
    this.bindScreenSharePeerConnectionToShare(targetMemberId, shareId);
    // A brand new connection has no measured path yet. The previous one's
    // answer describes a candidate pair that no longer exists, so repeating it
    // would be a claim about a connection that has been thrown away.
    if (boundShareId) {
      this.hooks.screenShare().setWatchStatus(boundShareId, { pathKind: "unknown" });
    }
    this.observeScreenSharePeerConnection(targetMemberId, connection);
    this.startScreenShareRelayWatch(boundShareId, connection);
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        const shareId =
          this.screenShareIdForPeerConnection(targetMemberId) ||
          this.hooks.screenShare().screenShareForMember(this.hooks.memberId())?.share_id ||
          this.hooks.screenShare().screenShareForMember(targetMemberId)?.share_id ||
          "";
        if (event.candidate.candidate.includes(" typ relay")) {
          this.screenShareRelayCandidates.set(
            shareId,
            (this.screenShareRelayCandidates.get(shareId) ?? 0) + 1
          );
        }
        void this.refreshScreenShareReceiverStats(targetMemberId, connection, shareId);
        const watchSessionId = this.screenShareSignalWatchSessionIdForPeer(targetMemberId, shareId);
        this.hooks.sendRTCSignal(targetMemberId, "screen-share-ice-candidate", {
          share_id: shareId,
          watch_session_id: watchSessionId,
          candidate: event.candidate.toJSON()
        });
      }
    };
    connection.ontrack = (event) => {
      this.configureScreenShareReceiver(event.receiver, targetMemberId);
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      // File the stream under the share's owner, not under a peer id that may
      // be a participant id: everything that renders or checks playback looks
      // the stream up by member id.
      const shareForPeer = this.hooks.screenShare().sessions.find(
        (item) => item.share_id === this.screenShareIdForPeerConnection(targetMemberId)
      );
      const remoteMemberId = screenShareStreamOwnerMemberId({
        share: shareForPeer,
        boundShareId: this.screenShareIdForPeerConnection(targetMemberId),
        fallbackMemberId: this.hooks.screenShareMemberIdForPeer(targetMemberId)
      });
      void this.refreshScreenShareReceiverStats(
        targetMemberId,
        connection,
        this.screenShareIdForPeerConnection(targetMemberId)
      );
      if (event.track.kind === "video") {
        this.hooks.attachRemoteScreenShare(targetMemberId, remoteMemberId, stream, event.track);
        return;
      }
      this.hooks.attachRemoteAudio(remoteMemberId, new MediaStream([event.track]), "screen-share");
    };
    connection.onconnectionstatechange = () => {
      const shareId = this.screenShareIdForPeerConnection(targetMemberId);
      this.handleScreenShareConnectionRecovery(targetMemberId, connection, shareId);
    };
    return connection;
  }

  private observeScreenSharePeerConnection(targetMemberId: string, connection: RTCPeerConnection) {
    connection.oniceconnectionstatechange = () => {
      const shareId = this.screenShareIdForPeerConnection(targetMemberId);
      this.handleScreenShareConnectionRecovery(targetMemberId, connection, shareId);
    };
    this.startScreenShareStatsPolling(targetMemberId, connection);
  }

  private scheduleScreenShareStatsBurst(targetMemberId: string, connection: RTCPeerConnection, shareId = "") {
    for (const delay of [80, 260, 700, 1500]) {
      window.setTimeout(() => {
        if (this.screenSharePeerConnections.get(targetMemberId) !== connection || connection.connectionState === "closed") return;
        void this.refreshScreenShareReceiverStats(targetMemberId, connection, shareId);
      }, delay);
    }
  }

  private startScreenShareStatsPolling(targetMemberId: string, connection: RTCPeerConnection) {
    this.stopScreenShareStatsPolling(targetMemberId);
    const timer = window.setInterval(() => {
      if (this.screenSharePeerConnections.get(targetMemberId) !== connection || connection.connectionState === "closed") {
        this.stopScreenShareStatsPolling(targetMemberId);
        return;
      }
      void this.refreshScreenShareReceiverStats(
        targetMemberId,
        connection,
        this.screenShareIdForPeerConnection(targetMemberId)
      );
    }, 1000);
    this.screenShareStatsTimers = new Map(this.screenShareStatsTimers).set(targetMemberId, timer);
    void this.refreshScreenShareReceiverStats(
      targetMemberId,
      connection,
      this.screenShareIdForPeerConnection(targetMemberId)
    );
  }

  private stopScreenShareStatsPolling(targetMemberId: string) {
    const timer = this.screenShareStatsTimers.get(targetMemberId);
    if (timer) window.clearInterval(timer);
    this.clearWebScreenShareSenderStats(targetMemberId);
    if (!this.screenShareStatsTimers.has(targetMemberId)) return;
    const next = new Map(this.screenShareStatsTimers);
    next.delete(targetMemberId);
    this.screenShareStatsTimers = next;
  }

  stopAllScreenShareStatsPolling() {
    for (const timer of this.screenShareStatsTimers.values()) {
      window.clearInterval(timer);
    }
    this.screenShareStatsTimers = new Map();
    this.webScreenShareSenderTelemetry = new Map();
    this.webScreenShareViewerPaths = new Map();
    this.webScreenShareSenderConfigurationErrors = new Map();
    this.webScreenShareOutboundSamples.clear();
    this.webQuality.clear();
    this.hooks.flushAliases();
  }

  private setWebScreenShareSenderConfigurationError(targetMemberId: string, message: string) {
    if (!targetMemberId) return;
    this.webScreenShareSenderConfigurationErrors = new Map(this.webScreenShareSenderConfigurationErrors).set(
      targetMemberId,
      message
    );
    this.hooks.flushAliases();
  }

  private clearWebScreenShareSenderConfigurationError(targetMemberId: string) {
    if (!targetMemberId || !this.webScreenShareSenderConfigurationErrors.has(targetMemberId)) return;
    const next = new Map(this.webScreenShareSenderConfigurationErrors);
    next.delete(targetMemberId);
    this.webScreenShareSenderConfigurationErrors = next;
    this.hooks.flushAliases();
  }

  private clearWebScreenShareSenderStats(targetMemberId: string) {
    this.webQuality.delete(targetMemberId);
    this.appliedSmartMode.delete(targetMemberId);
    if (!this.appliedSmartMode.size) {
      this.smartContent.stop();
      this.smartMode = "balanced";
    }
    if (this.webScreenShareViewerPaths.has(targetMemberId)) {
      const nextPaths = new Map(this.webScreenShareViewerPaths);
      nextPaths.delete(targetMemberId);
      this.webScreenShareViewerPaths = nextPaths;
    }
    if (this.webScreenShareSenderTelemetry.has(targetMemberId)) {
      const next = new Map(this.webScreenShareSenderTelemetry);
      next.delete(targetMemberId);
      this.webScreenShareSenderTelemetry = next;
    }
    this.clearWebScreenShareSenderConfigurationError(targetMemberId);
    const prefix = `${targetMemberId}:`;
    for (const key of this.webScreenShareOutboundSamples.keys()) {
      if (key.startsWith(prefix)) this.webScreenShareOutboundSamples.delete(key);
    }
    this.hooks.flushAliases();
  }

  private refreshWebScreenShareSenderStats(targetMemberId: string, stats: RTCStatsReport) {
    if (!this.localScreenShareStream || !this.screenShareSenders.has(targetMemberId)) return;
    let selected: (RTCStats & Record<string, any>) | null = null;
    const pairReports: Array<Record<string, any>> = [];
    let selectedPairId: string | undefined;
    stats.forEach((report) => {
      const item = report as RTCStats & Record<string, any>;
      if (item.type === "transport" && item.selectedCandidatePairId) selectedPairId = item.selectedCandidatePairId;
      if (item.type === "candidate-pair") {
        pairReports.push(item);
        return;
      }
      if (item.type !== "outbound-rtp" || (item.kind ?? item.mediaType) !== "video" || item.isRemote) return;
      if (!selected || Number(item.bytesSent ?? 0) > Number(selected.bytesSent ?? 0)) selected = item;
    });
    // Which path this viewer's share actually takes. A relayed viewer and a
    // weak direct viewer both show up as a low receiver estimate, so without
    // this the sharer cannot tell a server hop from a bad client link.
    const selectedPair = selectedPairId ? stats.get(selectedPairId) : undefined;
    const carryingPair = selectedPair ? { pair: selectedPair } : selectScreenShareCandidatePair(pairReports, "outgoing");
    if (carryingPair) {
      const pathKind = screenSharePathKindFromStats(stats, carryingPair.pair);
      if (pathKind !== "unknown" && this.webScreenShareViewerPaths.get(targetMemberId) !== pathKind) {
        this.webScreenShareViewerPaths = new Map(this.webScreenShareViewerPaths).set(targetMemberId, pathKind);
      }
    }
    if (!selected) return;

    const item = selected as RTCStats & Record<string, any>;
    const source = item.mediaSourceId ? stats.get(item.mediaSourceId) : undefined;
    const codec = item.codecId ? stats.get(item.codecId) as (RTCStats & Record<string, any>) | undefined : undefined;
    const sample: ScreenShareOutboundSample = {
      id: String(item.id ?? "outbound-video"),
      timestampMS: Number(item.timestamp ?? performance.now()),
      bytesSent: item.bytesSent,
      framesEncoded: item.framesEncoded,
      framesSent: item.framesSent,
      captureFps: source?.type === "media-source" ? source.framesPerSecond : undefined,
      keyFramesEncoded: item.keyFramesEncoded,
      totalEncodeTimeSeconds: item.totalEncodeTime,
      retransmittedBytesSent: item.retransmittedBytesSent,
      frameWidth: item.frameWidth,
      frameHeight: item.frameHeight,
      reportedFramesPerSecond: typeof item.framesPerSecond === "number" ? item.framesPerSecond : undefined,
      targetBitrateBps: typeof item.targetBitrate === "number" ? item.targetBitrate : undefined,
      qualityLimitationReason: item.qualityLimitationReason,
      qualityLimitationResolutionChanges: item.qualityLimitationResolutionChanges,
      nackCount: item.nackCount,
      pliCount: item.pliCount,
      codecMimeType: String(codec?.mimeType ?? ""),
      codecFmtpLine: String(codec?.sdpFmtpLine ?? "")
    };
    const sampleKey = `${targetMemberId}:${sample.id}`;
    const telemetry: ScreenShareSenderTelemetry = {
      ...deriveScreenShareSenderTelemetry(this.webScreenShareOutboundSamples.get(sampleKey), sample),
      measuredAtMS: Date.now()
    };
    const setup = this.hooks.screenShareSetup();
    const sender = this.screenShareSenders.get(targetMemberId);
    const smart = setup.contentMode === "smart";
    let retune = false;
    if (smart && sender?.track) {
      this.smartMode = this.smartContent.sample(sender.track, this.hooks.localScreenShareVideoElement());
      // Only the publisher's pixel evidence can change the common source hint.
      const hint = screenShareContentHint(this.smartMode);
      if (sender.track.contentHint !== hint) {
        try { sender.track.contentHint = hint; } catch { /* Optional WebRTC hint. */ }
      }
      retune = this.appliedSmartMode.get(targetMemberId) !== this.smartMode;
      telemetry.effectiveContentMode = this.appliedSmartMode.get(targetMemberId);
      telemetry.changedArea = this.smartContent.changedArea;
    }
    if (sender && setup.bitrateOption === "auto" && (smart || setup.adaptiveWebQuality) &&
        !this.webScreenShareSenderConfigurationErrors.has(targetMemberId)) {
      let controller = this.webQuality.get(targetMemberId);
      if (!controller || !this.webScreenShareOutboundSamples.has(sampleKey)) {
        controller = new WebScreenShareQualityController();
        this.webQuality.set(targetMemberId, controller);
      }
      if (controller.update({
        atMS: sample.timestampMS, actualBps: telemetry.bitrateBps, fps: telemetry.encodedFramesPerSecond,
        activeContent: smart && (this.smartContent.changedArea ?? 0) >= 0.18,
        availableBps: selectedPair?.availableOutgoingBitrate, limitation: telemetry.qualityLimitationReason,
        rttMS: selectedPair?.currentRoundTripTime === undefined ? undefined : selectedPair.currentRoundTripTime * 1000,
        encodeMS: telemetry.averageEncodeTimeMS
      }, setup.targetBitrate(sender.track), setup.frameRate)) {
        retune = true;
      }
      telemetry.qualityTier = controller.tier;
      telemetry.adaptationReason = controller.reason;
      telemetry.availableBps = selectedPair?.availableOutgoingBitrate;
    }
    if (sender && retune && !this.webScreenShareSenderConfigurationErrors.has(targetMemberId))
      void this.configureScreenShareSender(sender, targetMemberId, { stable: true });
    this.webScreenShareOutboundSamples.set(sampleKey, sample);
    this.webScreenShareSenderTelemetry = new Map(this.webScreenShareSenderTelemetry).set(targetMemberId, telemetry);
    this.hooks.flushAliases();
  }

  async refreshScreenShareReceiverStats(targetMemberId: string, connection: RTCPeerConnection, shareId = "") {
    if (this.statsReading.has(connection)) return;
    this.statsReading.add(connection);
    try {
      if (this.screenSharePeerConnections.get(targetMemberId) !== connection || String(connection.connectionState) === "closed") return;
      const stats = await connection.getStats();
      if (this.screenSharePeerConnections.get(targetMemberId) !== connection || String(connection.connectionState) === "closed") return;
      this.refreshWebScreenShareSenderStats(targetMemberId, stats);
      // An outgoing connection has no inbound media to watch. Running the
      // receiver half on it would age into a "stalled" verdict for a share the
      // sharer is not watching, and drive a reconnect it never wanted.
      if (this.screenShareSenders.has(targetMemberId) && !screenSharePeerReceivesVideo(connection)) return;
      let bytesReceived = 0;
      let packetsReceived = 0;
      let framesDecoded = 0;
      let frameWidth = 0;
      let frameHeight = 0;
      let frameStatsSupported = false;
      let jitterMS = Number.NaN;
      let packetsLost = 0;
      let framesDropped = 0;
      let freezes = 0;
      let transportBytesReceived = 0;
      let roundTripTimeMS = Number.NaN;
      const inbound: ScreenShareInboundVideo[] = [];
      let selectedPairId: string | undefined;
      stats.forEach(report => {
        if (report.type === "transport" && report.selectedCandidatePairId) selectedPairId = report.selectedCandidatePairId;
      });
      let selectedPair: { localCandidateId?: string; remoteCandidateId?: string } | undefined;
      stats.forEach((report) => {
        const item = report as unknown as ScreenShareInboundVideo & {
          type?: string;
          state?: string;
          nominated?: boolean;
          kind?: string;
          mediaType?: string;
          bytesReceived?: number;
          packetsReceived?: number;
          framesDecoded?: number;
          framesDropped?: number;
          frameWidth?: number;
          frameHeight?: number;
          freezeCount?: number;
          jitter?: number;
          packetsLost?: number;
          currentRoundTripTime?: number;
          localCandidateId?: string;
          remoteCandidateId?: string;
        };
        if (item.type === "candidate-pair") {
          if (selectedPairId ? item.id !== selectedPairId : item.state !== "succeeded" && item.nominated !== true) return;
          // Everything the path carries - STUN consent checks, RTCP sender
          // reports, media - lands in this counter. It keeps moving while the
          // sender is idle, which media counters cannot show.
          const pairBytesReceived = item.bytesReceived ?? 0;
          if (!selectedPair || pairBytesReceived > transportBytesReceived) {
            selectedPair = {
              localCandidateId: item.localCandidateId,
              remoteCandidateId: item.remoteCandidateId
            };
            transportBytesReceived = pairBytesReceived;
            // Round-trip time in seconds, when this browser reports it. It is
            // the one measurement that says how far away the viewer really is.
            roundTripTimeMS = Number.NaN;
            if (typeof item.currentRoundTripTime === "number" && Number.isFinite(item.currentRoundTripTime)) {
              roundTripTimeMS = item.currentRoundTripTime * 1_000;
            }
          }
          return;
        }
        if (item.type !== "inbound-rtp") return;
        if (item.kind !== "video" && item.mediaType !== "video") return;
        inbound.push(item);
        bytesReceived += item.bytesReceived ?? 0;
        packetsReceived += item.packetsReceived ?? 0;
        if (typeof item.framesDecoded === "number") {
          frameStatsSupported = true;
          framesDecoded += item.framesDecoded;
        }
        if (typeof item.frameWidth === "number" && item.frameWidth > 0) frameWidth = item.frameWidth;
        if (typeof item.frameHeight === "number" && item.frameHeight > 0) frameHeight = item.frameHeight;
        // `jitter` is a smoothed inter-arrival estimate in seconds.
        if (typeof item.jitter === "number" && Number.isFinite(item.jitter)) {
          jitterMS = Number.isNaN(jitterMS) ? item.jitter * 1_000 : Math.max(jitterMS, item.jitter * 1_000);
        }
        packetsLost += item.packetsLost ?? 0;
        framesDropped += item.framesDropped ?? 0;
        // Freezes the decoder reported. This is the viewer's actual symptom, so
        // the buffer controller uses it even when no loss was reported.
        if (typeof item.freezeCount === "number" && Number.isFinite(item.freezeCount)) {
          freezes += item.freezeCount;
        }
      });
      const resolvedShareId = shareId ||
        this.hooks.screenShare().screenShareForMember(targetMemberId)?.share_id ||
        "";
      // A pair that stays gone is a dead path, not a quiet one: this is what an
      // expired TURN allocation looks like, and the transport-byte timeout alone
      // would keep the frozen frame up for another eleven seconds.
      const missingCandidatePairSamples = selectedPair
        ? 0
        : (this.screenShareMissingPairSamples.get(targetMemberId) ?? 0) + 1;
      this.screenShareMissingPairSamples.set(targetMemberId, missingCandidatePairSamples);
      const current = resolvedShareId
        ? this.hooks.screenShare().watchStatuses.get(resolvedShareId)
        : undefined;
      // A reconnect briefly has no selected pair. Keep the last real reading
      // instead of downgrading a known path to "unknown" on every reuse.
      const pathKind = selectedPair ? screenSharePathKindFromStats(stats, selectedPair) : "unknown";
      const effectivePathKind = pathKind !== "unknown" ? pathKind : current?.pathKind ?? "unknown";
      let sampler = this.receiverSamplers.get(targetMemberId);
      if (!sampler) {
        sampler = new ScreenShareReceiverSampler();
        this.receiverSamplers.set(targetMemberId, sampler);
      }
      const metrics = sampler.sample(inbound);
      const documentHiddenNow = typeof document !== "undefined" && document.visibilityState === "hidden";
      // The buffer ceiling follows the path: a relayed stream can spend more
      // latency on jitter before a freeze becomes the cheaper outcome. A hidden
      // tab stops rendering on purpose, so its freezes say nothing about the
      // path and must not ratchet the buffer while the tab is away.
      if (!documentHiddenNow) {
        this.adaptScreenSharePlayoutDelay(
          targetMemberId,
          { jitterMS, packetsLost, framesDropped, freezes, bufferResidenceMS: metrics.jitterBufferMS },
          effectivePathKind
        );
      }
      const playbackProgressed = frameStatsSupported
        ? framesDecoded > (current?.framesDecoded ?? 0)
        : bytesReceived > (current?.bytesReceived ?? 0) || packetsReceived > (current?.packetsReceived ?? 0);
      const now = Date.now();
      const documentHidden = documentHiddenNow;
      const hasPlayableMedia = frameStatsSupported
        ? framesDecoded > 0
        : bytesReceived > 0 || packetsReceived > 0;
      const liveness = decideScreenSharePathLiveness({
        nowMS: now,
        documentHidden,
        hasPlayableMedia,
        mediaProgressed: playbackProgressed,
        transportBytesReceived,
        missingCandidatePairSamples,
        stallThresholdMS: this.transportStallThresholdMS,
        previous: current
      });
      const update: Partial<Omit<ScreenShareWatchStatus, "updatedAtMS">> = {
        bytesReceived,
        packetsReceived,
        framesDecoded,
        frameStatsSupported,
        lastPlaybackProgressAtMS: liveness.lastPlaybackProgressAtMS,
        transportBytesReceived,
        lastTransportProgressAtMS: liveness.lastTransportProgressAtMS
      };
      if (pathKind !== "unknown") update.pathKind = pathKind;
      if (frameWidth > 0 && frameHeight > 0) {
        update.frameWidth = frameWidth;
        update.frameHeight = frameHeight;
      }
      update.receiverMetrics = {
        ...metrics,
        jitterMS: Number.isFinite(jitterMS) ? jitterMS : undefined,
        rttMS: Number.isFinite(roundTripTimeMS) ? roundTripTimeMS : undefined
      };
      update.frameRate = metrics.decodedFps;
      if (resolvedShareId && !documentHidden) {
        this.maybeSwitchScreenSharePath({
          shareId: resolvedShareId,
          pathKind: effectivePathKind,
          bytesReceived,
          packetsReceived,
          packetsLost,
          jitterMS,
          nowMS: now
        });
      }
      // A relayed pair cannot outlive its credentials: the TURN server rejects
      // the refresh once the username timestamp passes. Rebuild it on fresh
      // credentials a little early, through the same path a stall uses.
      if (
        resolvedShareId &&
        screenShareRelayRotationDue({
          nowMS: now,
          pathKind: effectivePathKind,
          credentialFetchedAtMS: this.screenSharePeerCredentialFetchedAtMS.get(targetMemberId) ?? 0,
          lastRotationAtMS: this.screenShareRelayRotations.get(targetMemberId),
          spreadMS: screenShareRelayRotationSpreadMS(targetMemberId)
        })
      ) {
        this.screenShareRelayRotations.set(targetMemberId, now);
        const credentialsBeforeMS = this.hooks.rtcIceConfigFetchedAtMS?.() ?? 0;
        void Promise.resolve(this.hooks.ensureFreshRTCConfig?.()).then(() => {
          // Without fresh credentials a rebuild would only recreate the same
          // expired allocation, so keep the working connection and try again
          // after the hold instead of tearing the viewer down for nothing.
          if ((this.hooks.rtcIceConfigFetchedAtMS?.() ?? 0) <= credentialsBeforeMS) return;
          this.hooks.screenShare().scheduleReconnect(resolvedShareId, 0);
        });
      }
      if (liveness.stalled) {
        update.stage = "stalled";
        if (resolvedShareId) this.hooks.screenShare().scheduleReconnect(resolvedShareId, 250);
      } else if (playbackProgressed || liveness.transportProgressed || documentHidden) {
        update.stage = "track-received";
        if (resolvedShareId) this.hooks.screenShare().clearReconnectTimer(resolvedShareId);
      }
      if (resolvedShareId) {
        this.hooks.screenShare().updateWatchStatusForShare(resolvedShareId, update);
      } else {
        this.hooks.screenShare().updateWatchStatusForOwner(targetMemberId, update);
      }
    } catch {
      // The connection may close while a stats request is in flight.
    } finally {
      this.statsReading.delete(connection);
    }
  }

  /**
   * Chooses the viewing path once, while the watch is starting.
   *
   * Every switch rebuilds the connection — new ICE, new DTLS, roughly a second of
   * black picture — and hands the sender a cold bandwidth estimate, so a second
   * automatic switch right after the first only produces churn (direct, then
   * relay, then direct again for no visible gain). The client therefore decides
   * at most once, inside the startup window; after that the path belongs to the
   * user, who can pick either one explicitly.
   */
  private maybeSwitchScreenSharePath(input: {
    shareId: string;
    pathKind: ScreenSharePathKind;
    bytesReceived: number;
    packetsReceived: number;
    packetsLost: number;
    jitterMS: number;
    nowMS: number;
  }): void {
    if (!input.shareId || input.pathKind === "unknown") return;
    const history = this.screenSharePathHistory.get(input.shareId);
    if (!history) {
      this.screenSharePathHistory.set(input.shareId, {
        atMS: input.nowMS,
        startedAtMS: input.nowMS,
        bytesReceived: input.bytesReceived,
        packetsReceived: input.packetsReceived,
        packetsLost: input.packetsLost,
        degradedSamples: 0,
        relaySwitches: 0
      });
      return;
    }
    const preference = this.screenSharePathPreferences.get(input.shareId) ?? "auto";
    const now = input.nowMS;
    // Stats are polled several times a second during startup; one honest sample
    // per second keeps the rates comparable.
    const elapsedMS = now - history.atMS;
    if (elapsedMS < 1_000) return;
    const bytesDelta = Math.max(0, input.bytesReceived - history.bytesReceived);
    const packetsDelta = Math.max(0, input.packetsReceived - history.packetsReceived);
    const lostDelta = Math.max(0, input.packetsLost - history.packetsLost);
    history.atMS = now;
    history.bytesReceived = input.bytesReceived;
    history.packetsReceived = input.packetsReceived;
    history.packetsLost = input.packetsLost;
    history.receivedBitrateBps = (bytesDelta * 8 * 1_000) / elapsedMS;
    const packetsTotal = packetsDelta + lostDelta;
    const packetLossPercent = packetsTotal > 0 ? (lostDelta * 100) / packetsTotal : 0;
    const sample = {
      pathKind: input.pathKind,
      preference,
      packetLossPercent,
      jitterMS: packetsTotal > 0 ? input.jitterMS : Number.NaN
    };
    const degraded = screenSharePathQualityIsDegraded(sample);
    history.degradedSamples = degraded ? history.degradedSamples + 1 : 0;
    history.degradedSinceMS = degraded ? history.degradedSinceMS ?? now : undefined;
    const action = decideScreenSharePathSwitch({
      ...sample,
      degradedSinceMS: history.degradedSinceMS,
      nowMS: now,
      watchingMS: Math.max(0, now - history.startedAtMS),
      degradedSamples: history.degradedSamples,
      relaySwitches: history.relaySwitches
    });
    if (action === "hold") return;
    history.relaySwitches += 1;
    this.screenSharePathPreferences.set(input.shareId, "relay");
    history.degradedSinceMS = undefined;
    history.degradedSamples = 0;
    console.info("[EchoVoice] screen share path switch: prefer-relay", {
      share: input.shareId,
      packetLossPercent,
      jitterMS: sample.jitterMS
    });
    this.retryWatchingScreenShareOnNewPath(input.shareId);
  }

  private retryWatchingScreenShareOnNewPath(shareId: string): void {
    const share = this.hooks.screenShare().sessions.find((item) => item.share_id === shareId);
    if (!share) return;
    // Say which path we are about to use before the watch lands. The sharer is
    // the side that pays webrtc-ice's relay acceptance wait, and a relay-only
    // watch has no direct pair left to protect, so the hint removes about a
    // second of black screen from every hand-picked relay switch.
    const preference = this.screenSharePathPreference(shareId);
    if (preference !== "auto") {
      this.hooks.sendRTCSignal(share.owner_member_id, "screen-share-path-hint", {
        share_id: shareId,
        path: preference
      });
    }
    // The viewer owns this decision, so it also owns the rebuild: retry closes
    // this peer connection and starts a fresh watch with the new ICE policy.
    void this.hooks.screenShare().retryWatchingScreenShare(share);
  }

  private async renegotiateScreenSharePeerConnection(
    targetMemberId: string,
    connection: RTCPeerConnection,
    watchSessionId = this.hooks.screenShare().watcherSessionIds.get(targetMemberId) ?? "",
    iceRestart = false
  ) {
    if (connection.signalingState !== "stable") return;
    const shareID = this.hooks.screenShare().screenShareForMember(this.hooks.memberId())?.share_id ?? "";
    try {
      const offer = await connection.createOffer(iceRestart ? { iceRestart: true } : undefined);
      // The shared soundtrack is the only audio on this connection, and the
      // browser's default Opus fmtp asks for mono at its default bitrate.
      const describedOffer = offer.sdp
        ? { ...offer, sdp: enhanceScreenShareOpusSDP(offer.sdp) }
        : offer;
      await connection.setLocalDescription(describedOffer);
      this.hooks.sendRTCSignal(targetMemberId, "screen-share-offer", {
        share_id: shareID,
        watch_session_id: watchSessionId,
        description: describedOffer
      });
    } catch (caught) {
      // A failed screen-share renegotiation says nothing about the voice call
      // on the same peer, which runs on its own connection.
      const message = caught instanceof Error ? caught.message : String(caught);
      console.warn("[EchoVoice] screen share renegotiation failed", {
        stage: iceRestart ? "renegotiate-ice-restart" : "renegotiate",
        peer: targetMemberId,
        shareID,
        error: message,
        stack: caught instanceof Error ? caught.stack : undefined
      });
      if (shareID) {
        this.hooks.screenShare().setWatchStatus(shareID, { stage: "failed", error: message });
      }
    }
  }

  async handleScreenShareOfferSignal(signal: RTCSignal) {
    const peerId = signal.from_participant_id || signal.from_member_id;
    const shareID = this.screenShareSignalShareId(signal);
    const share = this.hooks.screenShare().sessions.find(
      (item) => item.share_id === shareID && item.owner_member_id === signal.from_member_id
    );
    if (!share || !this.hooks.screenShare().watchedShareIds.has(share.share_id)) return;
    const watchSessionId = this.screenShareSignalWatchSessionId(signal);
    const expectedWatchSessionId = this.hooks.screenShare().watchSessionIds.get(share.share_id) ?? "";
    if (expectedWatchSessionId && watchSessionId !== expectedWatchSessionId) return;
    const connection = this.ensureScreenSharePeerConnection(peerId, share.share_id);
    const description = this.screenShareSignalDescription(signal);
    if (!description) return;
    if (
      connection.remoteDescription?.type === description.type &&
      connection.remoteDescription.sdp === description.sdp
    ) {
      this.hooks.screenShare().clearWatchRetryTimers(share.share_id);
      return;
    }
    this.hooks.screenShare().setWatchStatus(share.share_id, { stage: "offer-received" });
    this.hooks.screenShare().clearWatchRetryTimers(share.share_id);
    this.hooks.screenShare().scheduleReconnect(share.share_id, 9000);
    try {
      if (connection.signalingState !== "stable") {
        await this.withScreenShareNegotiationTimeout(
          connection.setLocalDescription({ type: "rollback" } as RTCSessionDescriptionInit),
          "rollback"
        );
      }
      await this.withScreenShareNegotiationTimeout(connection.setRemoteDescription(description), "set-remote-offer");

      const answer = await this.withScreenShareNegotiationTimeout(connection.createAnswer(), "create-answer");
      await this.withScreenShareNegotiationTimeout(connection.setLocalDescription(answer), "set-local-answer");
      const localAnswer = connection.localDescription ?? answer;
      if (this.screenShareAnswerRejectsVideo(localAnswer)) {
        this.hooks.screenShare().setWatchStatus(share.share_id, {
          stage: "failed",
          error: this.hooks.translate("screenShare.watchCodecRejected")
        });
        this.closeScreenSharePeerConnection(peerId);
        return;
      }

      const answerQueued = await this.sendScreenShareMediaSignal(
        signal.from_member_id,
        "screen-share-answer",
        {
          share_id: share.share_id,
          watch_session_id: expectedWatchSessionId || watchSessionId,
          description: localAnswer
        },
        signal.from_participant_id
      );
      if (!answerQueued) {
        throw new Error(this.hooks.translate("error.screenShareWatchFailed"));
      }
      this.hooks.screenShare().setWatchStatus(share.share_id, { stage: "answer-sent" });
      this.scheduleScreenShareStatsBurst(peerId, connection, share.share_id);

      try {
        await this.withScreenShareNegotiationTimeout(
          this.flushPendingScreenShareIceCandidates(peerId, connection, share.share_id),
          "apply-remote-ice"
        );
      } catch (caught) {
        console.warn("[EchoVoice] deferred screen share ICE candidate failed", {
          from: signal.from_member_id,
          shareID: share.share_id,
          error: caught instanceof Error ? caught.message : String(caught)
        });
      }
    } catch (caught) {
      const message = caught instanceof Error
        ? caught.message
        : this.hooks.translate("error.screenShareWatchFailed");
      this.hooks.screenShare().setWatchStatus(share.share_id, { stage: "failed", error: message });
      this.closeScreenSharePeerConnection(peerId);
      this.hooks.screenShare().scheduleReconnect(share.share_id, 500);
      throw caught;
    }
  }

  private withScreenShareNegotiationTimeout<T>(operation: Promise<T>, phase: string, timeoutMS = 4000) {
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error(this.hooks.translate("error.screenShareNegotiationTimeout", { phase })));
      }, timeoutMS);
      operation.then(
        (value) => {
          window.clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          window.clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  private screenShareAnswerRejectsVideo(answer: RTCSessionDescriptionInit) {
    const sdp = answer.sdp ?? "";
    const videoLine = sdp
      .split(/\r?\n/)
      .find((line) => line.startsWith("m=video "));
    return Boolean(videoLine && /^m=video\s+0(?:\s|$)/.test(videoLine));
  }

  async handleScreenShareAnswerSignal(signal: RTCSignal) {
    const peerId = signal.from_participant_id || signal.from_member_id;
    const shareID = this.screenShareSignalShareId(signal);
    const watchSessionId = this.screenShareSignalWatchSessionId(signal);
    const expectedWatchSessionId = this.hooks.screenShare().watcherSessionIds.get(peerId) ?? "";
    if (expectedWatchSessionId && watchSessionId !== expectedWatchSessionId) return;
    const senderSession = this.nativeScreenShareSenderSession;
    if (senderSession?.shareId === shareID) {
      if (this.nativeScreenShareAppliedAnswerMemberIds.has(peerId)) {
        return;
      }
      const status = await handleNativeScreenShareSenderSignal(
        senderSession.sessionId,
        peerId,
        signal.signal_type,
        signal.data
      );
      if (this.nativeScreenShareSenderSession?.sessionId !== senderSession.sessionId) return;
      this.applyNativeScreenShareSenderStatus(status, "answer-signal");
      this.nativeScreenShareAppliedAnswerMemberIds = this.withSetValue(
        this.nativeScreenShareAppliedAnswerMemberIds,
        peerId
      );
      await this.forwardNativeScreenShareSenderSignals(senderSession.sessionId);
      if (this.nativeScreenShareSenderSession?.sessionId !== senderSession.sessionId) return;
      this.scheduleNativeScreenShareSignalFlush(senderSession.sessionId);
      return;
    }
    if (this.nativeScreenShareSenderSession) {
      console.warn("[EchoVoice] ignored native screen share answer for different share", {
        from: signal.from_member_id,
        receivedShareId: shareID,
        expectedShareId: this.nativeScreenShareSenderSession.shareId
      });
    }
    if (!this.hooks.currentMemberScreenShare()) return;
    const connection = this.screenSharePeerConnections.get(peerId);
    const description = this.screenShareSignalDescription(signal);
    if (!connection || !description) return;
    await connection.setRemoteDescription(description);
    const sender = this.screenShareSenders.get(peerId);
    if (sender) {
      await this.configureScreenShareSender(sender, peerId, { stable: true });
    }
    await this.flushPendingScreenShareIceCandidates(peerId, connection, shareID);
  }

  async handleScreenShareIceCandidateSignal(signal: RTCSignal) {
    const peerId = signal.from_participant_id || signal.from_member_id;
    const shareID = this.screenShareSignalShareId(signal);
    const watchSessionId = this.screenShareSignalWatchSessionId(signal);
    const expectedWatchSessionId = this.hooks.currentMemberScreenShare() || this.nativeScreenShareSenderSession
      ? this.hooks.screenShare().watcherSessionIds.get(peerId) ?? ""
      : this.hooks.screenShare().watchSessionIds.get(shareID) ?? "";
    if (expectedWatchSessionId && watchSessionId !== expectedWatchSessionId) return;
    const senderSession = this.nativeScreenShareSenderSession;
    if (senderSession?.shareId === shareID) {
      const status = await handleNativeScreenShareSenderSignal(
        senderSession.sessionId,
        peerId,
        signal.signal_type,
        signal.data
      );
      if (this.nativeScreenShareSenderSession?.sessionId !== senderSession.sessionId) return;
      this.applyNativeScreenShareSenderStatus(status, "ice-signal");
      await this.forwardNativeScreenShareSenderSignals(senderSession.sessionId);
      if (this.nativeScreenShareSenderSession?.sessionId !== senderSession.sessionId) return;
      this.scheduleNativeScreenShareSignalFlush(senderSession.sessionId);
      return;
    }
    if (this.nativeScreenShareSenderSession) {
      console.warn("[EchoVoice] ignored native screen share ICE candidate for different share", {
        from: signal.from_member_id,
        receivedShareId: shareID,
        expectedShareId: this.nativeScreenShareSenderSession.shareId
      });
    }
    if (!this.shouldHandleScreenShareMediaSignal(signal.from_member_id)) return;
    const connection = this.ensureScreenSharePeerConnection(peerId, shareID);
    const candidate = this.screenShareSignalCandidate(signal);
    if (!candidate) return;
    if (!connection.remoteDescription) {
      this.queuePendingScreenShareIceCandidate(peerId, candidate);
      return;
    }
    await connection.addIceCandidate(candidate);
    this.scheduleScreenShareStatsBurst(peerId, connection, shareID);
  }

  shouldHandleScreenShareMediaSignal(fromMemberID: string) {
    if (this.hooks.currentMemberScreenShare()) return true;
    return this.hooks.screenShare().sessions.some(
      (share) => share.owner_member_id === fromMemberID &&
        this.hooks.screenShare().watchedShareIds.has(share.share_id)
    );
  }

  private queuePendingScreenShareIceCandidate(memberIDToQueue: string, candidate: RTCIceCandidateInit) {
    // Candidates now arrive before the offer by design: the sharer no longer
    // waits for gathering before it sends one. Keep the newest, because a later
    // server-reflexive or relayed candidate is the one that crosses a NAT, and
    // cap the queue so a broken far end cannot grow it without bound.
    const pending = this.pendingScreenShareIceCandidates.get(memberIDToQueue) ?? [];
    const next = [...pending, candidate];
    this.pendingScreenShareIceCandidates.set(
      memberIDToQueue,
      next.length > this.maxPendingScreenShareIceCandidates
        ? next.slice(next.length - this.maxPendingScreenShareIceCandidates)
        : next
    );
  }

  async flushPendingScreenShareIceCandidates(memberIDToFlush: string, connection: RTCPeerConnection, shareId = "") {
    const candidates = this.pendingScreenShareIceCandidates.get(memberIDToFlush) ?? [];
    if (candidates.length === 0 || !connection.remoteDescription) return;
    this.pendingScreenShareIceCandidates.delete(memberIDToFlush);
    for (const candidate of candidates) {
      await connection.addIceCandidate(candidate);
    }
    this.scheduleScreenShareStatsBurst(memberIDToFlush, connection, shareId);
  }

  // ---- owned-watch signaling helpers ------------------------------------------

  flushPendingOwnedScreenShareWatchSignals(shareId: string) {
    this.hooks.screenShare().flushPendingOwnedWatchSignals(shareId);
  }

  handleScreenShareWatchSignal(signal: RTCSignal) {
    return this.hooks.screenShare().handleWatchSignal(signal);
  }

  handleScreenShareUnwatchSignal(signal: RTCSignal) {
    return this.hooks.screenShare().handleUnwatchSignal(signal);
  }

  /**
   * The viewer names the path it is about to watch through. Only "relay" matters
   * here: that watch carries nothing but relay candidates, so the ICE acceptance
   * window we keep for direct pairs is pure latency in front of nomination.
   */
  handleScreenSharePathHintSignal(signal: RTCSignal): void {
    const data = (signal.data ?? {}) as { share_id?: unknown; path?: unknown };
    const shareId = typeof data.share_id === "string" ? data.share_id : "";
    const path = data.path === "relay" ? "relay" : data.path === "direct" ? "direct" : undefined;
    if (!shareId || !path) return;
    rememberScreenSharePathHint(shareId, signal.from_member_id, path);
  }

  screenShareSignalShareId(signal: RTCSignal) {
    return this.hooks.screenShare().signalShareId(signal);
  }

  screenShareSignalWatchSessionId(signal: RTCSignal) {
    return this.hooks.screenShare().signalWatchSessionId(signal);
  }

  screenShareSignalDescription(signal: RTCSignal) {
    return this.hooks.screenShare().signalDescription(signal);
  }

  screenShareSignalCandidate(signal: RTCSignal) {
    return this.hooks.screenShare().signalCandidate(signal);
  }

  screenShareDataShareId(data: unknown) {
    return this.screenShareDataShareIdLocal(data);
  }

  screenShareDataWatchSessionId(data: unknown) {
    return this.screenShareDataWatchSessionIdLocal(data);
  }

  screenShareChannelIdForSignalData(data: unknown) {
    const shareID = this.screenShareDataShareId(data);
    if (!shareID) return "";
    const share = this.hooks.screenShare().sessions.find((item) => item.share_id === shareID);
    if (share?.channel_id) return share.channel_id;
    const currentMemberShare = this.hooks.currentMemberScreenShare();
    if (currentMemberShare?.share_id === shareID) return currentMemberShare.channel_id;
    return "";
  }

  private screenShareDataShareIdLocal(data: unknown) {
    if (!data || typeof data !== "object") return "";
    const shareID = (data as { share_id?: unknown }).share_id;
    return typeof shareID === "string" ? shareID : "";
  }

  private screenShareDataWatchSessionIdLocal(data: unknown) {
    if (!data || typeof data !== "object") return "";
    const watchSessionId = (data as { watch_session_id?: unknown }).watch_session_id;
    return typeof watchSessionId === "string" ? watchSessionId : "";
  }

  async sendScreenShareMediaSignal(
    targetMemberId: string,
    signalType: Extract<
      RTCSignal["signal_type"],
      "screen-share-offer" | "screen-share-answer" | "screen-share-ice-candidate"
    >,
    data: unknown,
    targetParticipantId = ""
  ) {
    const shareId = this.screenShareDataShareId(data);
    if (!this.hooks.sessionToken() || !shareId) return false;
    try {
      const result = await sendScreenShareSignal(
        this.hooks.baseUrl(),
        this.hooks.sessionToken(),
        shareId,
        targetMemberId,
        signalType,
        data,
        targetParticipantId
      );
      if (!result.delivered && !result.queued) {
        console.warn("[EchoVoice] screen share signal was not delivered", {
          targetMemberId,
          signalType,
          shareId,
          transport: "http"
        });
        if (signalType === "screen-share-offer" || signalType === "screen-share-answer") {
          this.hooks.screenShare().setWatchStatus(shareId, {
            stage: "failed",
            error: this.hooks.translate("error.screenShareWatchFailed")
          });
        }
        return false;
      }
      return true;
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      console.warn("[EchoVoice] screen share signal blocked", {
        targetMemberId,
        signalType,
        shareId,
        transport: "http",
        error: message
      });
      if (signalType === "screen-share-offer" || signalType === "screen-share-answer") {
        this.hooks.screenShare().setWatchStatus(shareId, {
          stage: "failed",
          error: message || this.hooks.translate("error.screenShareWatchFailed")
        });
      }
      return false;
    }
  }

  // ---- mesh teardown -----------------------------------------------------------

  closeScreenSharePeerConnection(identityToClose: string) {
    const peerId = this.hooks.screenSharePeerIdForIdentity(identityToClose);
    const remoteMemberId = this.hooks.screenShareMemberIdForPeer(peerId);
    this.stopScreenShareStatsPolling(peerId);
    this.screenSharePeerConnections.get(peerId)?.close();
    this.screenSharePeerConnections.delete(peerId);
    this.screenSharePeerConnectionShareIds.delete(peerId);
    this.screenShareSenders.delete(peerId);
    this.screenShareAudioSenders.delete(peerId);
    this.screenShareVideoReceivers.delete(peerId);
    this.screenShareAudioReceivers.delete(peerId);
    this.screenSharePlayoutDelays.delete(peerId);
    this.screenShareReceiverCounters.delete(peerId);
    this.screenShareMissingPairSamples.delete(peerId);
    this.receiverSamplers.delete(peerId);
    const pendingCleanup = this.outgoingShareCleanupTimers.get(peerId);
    if (pendingCleanup !== undefined) {
      window.clearTimeout(pendingCleanup);
      this.outgoingShareCleanupTimers.delete(peerId);
    }
    const pendingConnect = this.outgoingShareConnectTimers.get(peerId);
    if (pendingConnect !== undefined) {
      window.clearTimeout(pendingConnect);
      this.outgoingShareConnectTimers.delete(peerId);
    }
    this.screenSharePeerCredentialFetchedAtMS.delete(peerId);
    this.screenShareRelayRotations.delete(peerId);
    // Keep a recent request so the rebuild that follows does not immediately ask
    // for another restart, but do not leak the entry for a peer that went away.
    const restartRequestedAtMS = this.screenShareIceRestartRequests.get(peerId);
    if (
      restartRequestedAtMS === undefined ||
      Date.now() - restartRequestedAtMS >= screenShareIceRestartCooldownMS
    ) {
      this.screenShareIceRestartRequests.delete(peerId);
    }
    this.hooks.screenShare().watchers.delete(peerId);
    this.pendingScreenShareIceCandidates.delete(peerId);
    // Only the share's own audio. The member's voice and accompaniment live on
    // a different peer connection and keep playing; detaching them here would
    // silence a microphone that is still connected.
    this.hooks.detachRemoteAudioForMember(remoteMemberId, "screen-share");
  }

  closeAllScreenSharePeerConnections() {
    for (const memberIDToClose of this.screenSharePeerConnections.keys()) {
      this.hooks.detachRemoteAudioForMember(memberIDToClose, "screen-share");
    }
    this.stopAllScreenShareStatsPolling();
    for (const connection of this.screenSharePeerConnections.values()) {
      connection.close();
    }
    this.screenSharePeerConnections.clear();
    this.screenSharePeerConnectionShareIds.clear();
    this.screenShareSenders.clear();
    this.screenShareAudioSenders.clear();
    this.screenShareVideoReceivers.clear();
    this.screenShareAudioReceivers.clear();
    this.screenSharePlayoutDelays.clear();
    this.screenShareReceiverCounters.clear();
    this.screenShareMissingPairSamples.clear();
    this.receiverSamplers.clear();
    for (const pendingCleanup of this.outgoingShareCleanupTimers.values()) {
      window.clearTimeout(pendingCleanup);
    }
    this.outgoingShareCleanupTimers.clear();
    for (const pendingConnect of this.outgoingShareConnectTimers.values()) {
      window.clearTimeout(pendingConnect);
    }
    this.outgoingShareConnectTimers.clear();
    this.screenSharePeerCredentialFetchedAtMS.clear();
    this.screenShareRelayRotations.clear();
    this.screenSharePathPreferences.clear();
    this.screenSharePathHistory.clear();
    for (const timer of this.screenShareRelayWatchTimers.values()) window.clearInterval(timer);
    this.screenShareRelayWatchTimers.clear();
    this.screenShareRelayCandidates.clear();
    this.screenShareIceRestartRequests.clear();
    this.hooks.screenShare().clearWatchers();
    this.pendingScreenShareIceCandidates.clear();
    this.closeScreenShareViewerPanel();
    this.hooks.screenShare().resetWatchState();
  }

  // ---- lifecycle ---------------------------------------------------------------

  resetWatchStateOnVoiceStop(): void {
    this.stopAllScreenShareStatsPolling();
    this.closeScreenShareViewerPanel();
    this.hooks.screenShare().resetWatchState();
  }

  dispose(): void {
    this.stopNativeScreenShareStatusPolling();
    this.stopWebScreenShareSignalPolling();
    this.stopViewerScreenShareSignalPolling();
    this.clearLocalScreenShareStaleTimer();
    this.hooks.screenShare().clearAllReconnectTimers();
    this.closeAllScreenSharePeerConnections();
    void this.hooks.realtime().stopNativeLocalScreenSharePreview({ resumeThumbnail: false });
    this.stopLocalScreenShareStream();
    this.closeScreenShareViewerPanel();
  }
}
