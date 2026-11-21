// Native (Tauri) voice session transport and the shared voice signaling /
// voice-session orchestration layer.
//
// Owns the native voice session lifecycle (start/stop/status/signal loops,
// repair, microphone recovery), plus the transport-level entry points the
// rest of the shell calls for voice sessions: startVoiceSession,
// stopVoiceSession, ensureCurrentVoiceTransport, connectVoicePeers,
// ensureVoicePeer, handleRTCSignal, sendRTCSignal, and
// flushPendingVoiceOutboundSignals. Web voice transport still executes inside
// VoiceSessionController; this controller is the routing layer that picks the
// native or web path and fans signaling out to the right socket.
//
// Cross-domain dependencies are injected as lazy hooks so this controller
// never imports App.svelte.

import { KeyedTaskCoordinator } from "./keyedTaskCoordinator";
import {
  addNativeVoicePeer,
  drainNativeVoiceSignals,
  handleNativeVoiceSignal,
  loadNativeVoiceStatus,
  removeNativeVoicePeer,
  restartNativeVoiceMicrophone,
  setNativeVoiceMemberMusicVolume,
  setNativeVoiceMemberVolume,
  setNativeVoiceState,
  startNativeVoiceSession,
  stopNativeVoiceSession
} from "./storage";
import type { AudioDevicesController } from "./audio-devices.svelte";
import type { AccompanimentController } from "./accompaniment.svelte";
import type { ChannelsController } from "./channels.svelte";
import type { ChannelFilesController } from "./channel-files.svelte";
import type { ChatComposerController } from "./composer.svelte";
import type { MessagesController } from "./messages.svelte";
import type { RealtimeController } from "./realtime.svelte";
import type { ScreenShareController } from "./screen-share.svelte";
import type { ScreenShareSetupController } from "./screen-share-setup.svelte";
import type { ScreenShareTransportController } from "./screen-share-transport.svelte";
import type { VoiceSessionController } from "./voice-session.svelte";
import type { VoiceStateController, VoiceConnectionContext } from "./voice-state.svelte";
import type { NativeVoiceSession, NativeVoiceStatus, RTCSignal, VoiceState } from "./types";

export type PendingVoiceOutboundSignal = {
  channelId: string;
  targetParticipantId: string;
  signalType: RTCSignal["signal_type"];
  data: unknown;
};

export type NativeVoiceHooks = {
  // Workspace identity.
  memberId: () => string;
  activeServerId: () => string;
  baseUrl: () => string;
  sessionToken: () => string;
  nativeDesktopRuntime: () => boolean;
  // Domain controllers.
  voiceState: () => VoiceStateController;
  voiceSession: () => VoiceSessionController;
  realtime: () => RealtimeController;
  transport: () => ScreenShareTransportController;
  screenShare: () => ScreenShareController;
  screenShareSetup: () => ScreenShareSetupController;
  accompaniment: () => AccompanimentController;
  audio: () => AudioDevicesController;
  channels: () => ChannelsController;
  messages: () => MessagesController;
  channelFiles: () => ChannelFilesController;
  composer: () => ChatComposerController;
  // Shell-owned state used by clearVoicePanelSelection / stopVoiceSession.
  channelContentMode: () => "chat" | "files" | "voice" | "category";
  setChannelContentMode: (mode: "chat" | "files" | "voice" | "category") => void;
  memberSearchOpen: () => boolean;
  setMemberSearchOpen: (open: boolean) => void;
  memberSearchQuery: () => string;
  setMemberSearchQuery: (query: string) => void;
  clearMemberAccessFilter: () => void;
  screenShareActionBusy: () => boolean;
  setScreenShareActionBusy: (busy: boolean) => void;
  focusedScreenShareId: () => string;
  setFocusedScreenShareId: (id: string) => void;
  poppedOutScreenShareIds: () => Set<string>;
  setPoppedOutScreenShareIds: (ids: Set<string>) => void;
  joinedVoiceChannelId: () => string;
  pendingVoiceOutboundSignals: () => PendingVoiceOutboundSignal[];
  setPendingVoiceOutboundSignals: (signals: PendingVoiceOutboundSignal[]) => void;
  // UI/errors.
  setError: (message: string) => void;
  translate: (key: string, params?: Record<string, string | number>) => string;
  caughtMessage: (caught: unknown, fallback: string) => string;
  flushAliases: () => void;
};

export class NativeVoiceController {
  nativeVoiceSession = $state<NativeVoiceSession | null>(null);
  nativeVoiceSessionGeneration = 0;
  nativeVoiceSessionStarts = new KeyedTaskCoordinator();
  nativeVoiceSessionRepairPromise: Promise<void> | null = null;
  nativeVoiceStatus = $state<NativeVoiceStatus | null>(null);
  nativeVoiceStatusTimer: number | undefined;
  nativeVoiceSignalTimer: number | undefined;
  nativeVoiceStatusBusySessionId = "";
  nativeVoiceSignalBusySessionId = "";
  nativeMicrophoneRecoveryTimer: number | undefined;
  nativeMicrophoneRecoveryAttempts = 0;
  nativeMicrophoneRecoveryPromise: Promise<void> | null = null;
  pendingNativeVoiceSignals: RTCSignal[] = [];

  private hooks: NativeVoiceHooks;

  constructor(hooks: NativeVoiceHooks) {
    this.hooks = hooks;
  }

  // ── Native microphone recovery ────────────────────────────────────────────
  clearNativeMicrophoneRecovery(resetAttempts = true) {
    if (this.nativeMicrophoneRecoveryTimer) window.clearTimeout(this.nativeMicrophoneRecoveryTimer);
    this.nativeMicrophoneRecoveryTimer = undefined;
    if (resetAttempts) this.nativeMicrophoneRecoveryAttempts = 0;
  }

  async recoverNativeMicrophone(sessionId: string) {
    if (this.nativeMicrophoneRecoveryPromise) return this.nativeMicrophoneRecoveryPromise;
    const recovery = (async () => {
      if (this.nativeVoiceSession?.sessionId !== sessionId) return;
      const audio = this.hooks.audio();
      if (audio.microphoneTestActive || audio.nativeMicrophoneTestSessionId) await audio.stopMicrophoneTest();
      await audio.refreshAudioInputDevices(false, false);
      if (this.nativeVoiceSession?.sessionId !== sessionId) return;
      await restartNativeVoiceMicrophone(sessionId, audio.selectedAudioInputDeviceId);
      if (this.nativeVoiceSession?.sessionId !== sessionId) return;
      let status = await loadNativeVoiceStatus(sessionId);
      this.applyNativeVoiceStatus(status);
      if (!status.microphoneAvailable) {
        throw new Error(status.microphoneError || status.lastError || this.hooks.translate("error.voiceMediaUnavailable"));
      }
      await setNativeVoiceState(sessionId, false, false);
      status = await loadNativeVoiceStatus(sessionId);
      this.applyNativeVoiceStatus(status);
      audio.micMuted = false;
      audio.voiceInputUnavailable = false;
      localStorage.setItem("ev.voice.microphoneMuted", "false");
      audio.mergeCurrentVoiceFlags();
      void audio.syncCurrentVoiceState();
      this.hooks.setError("");
    })();
    this.nativeMicrophoneRecoveryPromise = recovery;
    try {
      await recovery;
    } finally {
      if (this.nativeMicrophoneRecoveryPromise === recovery) this.nativeMicrophoneRecoveryPromise = null;
    }
  }

  scheduleNativeMicrophoneRecovery(sessionId: string) {
    const delays = [500, 1_500, 4_000];
    const audio = this.hooks.audio();
    const state = this.hooks.voiceState().currentVoiceState();
    if (
      this.nativeMicrophoneRecoveryTimer ||
      this.nativeMicrophoneRecoveryPromise ||
      this.nativeMicrophoneRecoveryAttempts >= delays.length ||
      this.nativeVoiceSession?.sessionId !== sessionId ||
      this.nativeVoiceStatus?.phase !== "running" ||
      !state ||
      state.mode === "listener" ||
      state.server_muted ||
      state.server_deafened ||
      audio.micMuted ||
      audio.audioDeafened
    ) return;
    const delay = delays[this.nativeMicrophoneRecoveryAttempts];
    this.nativeMicrophoneRecoveryTimer = window.setTimeout(() => {
      this.nativeMicrophoneRecoveryTimer = undefined;
      this.nativeMicrophoneRecoveryAttempts += 1;
      void this.recoverNativeMicrophone(sessionId).catch((caught) => {
        console.warn("[EchoVoice] native microphone recovery failed", {
          attempt: this.nativeMicrophoneRecoveryAttempts,
          error: this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceMediaUnavailable"))
        });
        if (this.nativeVoiceSession?.sessionId === sessionId) this.scheduleNativeMicrophoneRecovery(sessionId);
      });
    }, delay);
  }

  // ── Native voice status / signal loops ────────────────────────────────────
  applyNativeVoiceStatus(status: NativeVoiceStatus) {
    if (this.nativeVoiceSession?.sessionId !== status.sessionId) return;
    this.nativeVoiceStatus = status;
    const voiceSession = this.hooks.voiceSession();
    voiceSession.peerCount = status.peerCount;
    voiceSession.inputLevel = status.inputLevel;
    const audio = this.hooks.audio();
    const previousInputUnavailable = audio.voiceInputUnavailable;
    audio.voiceInputUnavailable = status.phase === "failed" || !status.microphoneAvailable;
    if (status.roundTripTimeMs != null) {
      this.applyNativeVoiceLatency(status.roundTripTimeMs);
    }
    if (audio.voiceInputUnavailable) {
      audio.isSpeaking = false;
    }
    if (audio.voiceInputUnavailable !== previousInputUnavailable) {
      audio.mergeCurrentVoiceFlags();
      void audio.syncCurrentVoiceState();
    }
    if (status.phase === "running") {
      voiceSession.setConnectionStatus("connected");
    }
    if (status.microphoneAvailable) {
      this.clearNativeMicrophoneRecovery();
    } else if (status.phase === "running") {
      this.scheduleNativeMicrophoneRecovery(status.sessionId);
    }
    audio.setLocalSpeaking(status.speaking);
  }

  applyNativeVoiceLatency(roundTripTimeMs: number) {
    const voiceSession = this.hooks.voiceSession();
    voiceSession.latencyMS = Math.max(0, Math.round(roundTripTimeMs));
    voiceSession.jitterMS = null;
    voiceSession.packetLossLabel = "-";
    voiceSession.inboundKbps = null;
    voiceSession.outboundKbps = null;
    voiceSession.networkSampleSource = "webrtc";
    voiceSession.latencyMeasuredAtMS = Date.now();
    voiceSession.latencyFailureCount = 0;
  }

  async refreshNativeVoiceStatus(sessionId: string) {
    if (this.nativeVoiceStatusBusySessionId || this.nativeVoiceSession?.sessionId !== sessionId) return;
    this.nativeVoiceStatusBusySessionId = sessionId;
    try {
      this.applyNativeVoiceStatus(await loadNativeVoiceStatus(sessionId));
    } catch (caught) {
      if (this.nativeVoiceSession?.sessionId === sessionId) {
        if (this.nativeVoiceSessionWasNotFound(caught)) {
          this.repairMissingNativeVoiceSession(sessionId);
          return;
        }
        this.hooks.voiceSession().setConnectionStatus("failed");
        this.hooks.audio().voiceInputUnavailable = true;
        this.hooks.setError(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceMediaUnavailable")));
      }
    } finally {
      if (this.nativeVoiceStatusBusySessionId === sessionId) this.nativeVoiceStatusBusySessionId = "";
    }
  }

  async flushNativeVoiceSignals(sessionId: string) {
    if (this.nativeVoiceSignalBusySessionId || this.nativeVoiceSession?.sessionId !== sessionId) return;
    this.nativeVoiceSignalBusySessionId = sessionId;
    try {
      for (const signal of await drainNativeVoiceSignals(sessionId)) {
        this.sendRTCSignal(signal.memberId, signal.signalType, signal.data);
      }
    } catch (caught) {
      if (this.nativeVoiceSession?.sessionId === sessionId) {
        if (this.nativeVoiceSessionWasNotFound(caught)) {
          this.repairMissingNativeVoiceSession(sessionId);
          return;
        }
        this.hooks.voiceSession().setConnectionStatus("failed");
        this.hooks.setError(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceMediaUnavailable")));
      }
    } finally {
      if (this.nativeVoiceSignalBusySessionId === sessionId) this.nativeVoiceSignalBusySessionId = "";
    }
  }

  startNativeVoiceLoops(sessionId: string) {
    this.stopNativeVoiceLoops();
    void this.refreshNativeVoiceStatus(sessionId);
    void this.flushNativeVoiceSignals(sessionId);
    this.nativeVoiceStatusTimer = window.setInterval(() => void this.refreshNativeVoiceStatus(sessionId), 150);
    this.nativeVoiceSignalTimer = window.setInterval(() => void this.flushNativeVoiceSignals(sessionId), 35);
  }

  stopNativeVoiceLoops() {
    if (this.nativeVoiceStatusTimer) window.clearInterval(this.nativeVoiceStatusTimer);
    if (this.nativeVoiceSignalTimer) window.clearInterval(this.nativeVoiceSignalTimer);
    this.nativeVoiceStatusTimer = undefined;
    this.nativeVoiceSignalTimer = undefined;
    this.nativeVoiceStatusBusySessionId = "";
    this.nativeVoiceSignalBusySessionId = "";
  }

  stopCurrentNativeVoiceSession() {
    const session = this.nativeVoiceSession;
    this.clearNativeMicrophoneRecovery();
    this.nativeVoiceSessionGeneration += 1;
    this.nativeVoiceSession = null;
    this.nativeVoiceStatus = null;
    this.stopNativeVoiceLoops();
    this.pendingNativeVoiceSignals = [];
    if (session) void stopNativeVoiceSession(session.sessionId);
    this.hooks.flushAliases();
  }

  nativeVoiceStartKey(context: VoiceConnectionContext, channelId: string, generation: number) {
    return [generation, context.serverId, context.memberId, context.deviceId, channelId].join(":");
  }

  nativeVoiceStartTargetIsCurrent(
    context: VoiceConnectionContext,
    channelId: string,
    generation: number
  ) {
    const current = this.hooks.voiceState().voiceConnectionContext;
    return Boolean(
      generation === this.nativeVoiceSessionGeneration &&
        current?.serverId === context.serverId &&
        current.memberId === context.memberId &&
        current.deviceId === context.deviceId &&
        current.channelId === channelId
    );
  }

  nativeVoiceSessionWasNotFound(caught: unknown) {
    const message = caught instanceof Error ? caught.message : String(caught ?? "");
    return message.toLowerCase().includes("native voice session was not found");
  }

  nativeVoiceCommandWasStaleOrMissing(sessionId: string, caught: unknown) {
    if (this.nativeVoiceSession?.sessionId !== sessionId) return true;
    if (!this.nativeVoiceSessionWasNotFound(caught)) return false;
    this.repairMissingNativeVoiceSession(sessionId);
    return true;
  }

  repairMissingNativeVoiceSession(sessionId: string) {
    if (this.nativeVoiceSessionRepairPromise || this.nativeVoiceSession?.sessionId !== sessionId) return;
    const state = this.hooks.voiceState().currentVoiceState();
    if (!state?.channel_id) return;
    const repair = (async () => {
      if (this.nativeVoiceSession?.sessionId !== sessionId) return;
      this.stopCurrentNativeVoiceSession();
      this.hooks.voiceSession().setConnectionStatus("connecting");
      await this.startVoiceSession(state.channel_id, false);
      if (this.nativeVoiceSession && this.hooks.voiceSession().connectionStatus === "connected") this.hooks.setError("");
    })();
    this.nativeVoiceSessionRepairPromise = repair;
    const finishRepair = () => {
      if (this.nativeVoiceSessionRepairPromise === repair) this.nativeVoiceSessionRepairPromise = null;
    };
    void repair.then(finishRepair, (caught) => {
      finishRepair();
      if (this.hooks.voiceState().currentVoiceState()?.channel_id === state.channel_id) {
        this.hooks.voiceSession().setConnectionStatus("failed");
        this.hooks.audio().voiceInputUnavailable = true;
        this.hooks.setError(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceMediaUnavailable")));
      }
    });
  }

  async startDesktopNativeVoiceSession(channelId: string) {
    const voiceState = this.hooks.voiceState();
    const context = voiceState.voiceConnectionContext;
    if (!context) return;
    const generation = this.nativeVoiceSessionGeneration;
    if (
      this.nativeVoiceSession?.channelId === channelId &&
      this.nativeVoiceSession.memberId === context.memberId &&
      this.nativeVoiceStartTargetIsCurrent(context, channelId, generation)
    ) return;
    const startKey = this.nativeVoiceStartKey(context, channelId, generation);
    await this.nativeVoiceSessionStarts.run(startKey, async () => {
      if (!this.nativeVoiceStartTargetIsCurrent(context, channelId, generation)) return;
      const audio = this.hooks.audio();
      if (audio.microphoneTestActive || audio.nativeMicrophoneTestSessionId) await audio.stopMicrophoneTest();
      await audio.refreshAudioInputDevices(false, false);
      if (!this.nativeVoiceStartTargetIsCurrent(context, channelId, generation)) return;
      this.hooks.voiceSession().setConnectionStatus("connecting");
      const session = await startNativeVoiceSession({
        serverId: context.serverId,
        channelId,
        memberId: context.memberId,
        muted: audio.micMuted || audio.audioDeafened,
        deafened: audio.audioDeafened,
        inputGainPercent: audio.microphoneGainPercent,
        outputVolumePercent: audio.outputVolumePercent,
        inputDeviceId: audio.selectedAudioInputDeviceId,
        outputDeviceId: audio.selectedAudioOutputDeviceId,
        noiseSuppressionMode: audio.noiseSuppressionMode,
        iceServers: context.iceServers
      });
      if (!this.nativeVoiceStartTargetIsCurrent(context, channelId, generation)) {
        await stopNativeVoiceSession(session.sessionId).catch(() => undefined);
        return;
      }
      this.nativeVoiceSession = session;
      this.nativeVoiceStatus = null;
      audio.voiceInputUnavailable = false;
      this.startNativeVoiceLoops(session.sessionId);
      const queuedSignals = this.pendingNativeVoiceSignals;
      this.pendingNativeVoiceSignals = [];
      for (const signal of queuedSignals) {
        await this.hooks.realtime().enqueueVoiceSignal(signal);
        if (this.nativeVoiceSession?.sessionId !== session.sessionId) return;
      }
      await this.connectVoicePeers(channelId);
      if (this.nativeVoiceSession?.sessionId !== session.sessionId) return;
      await this.flushNativeVoiceSignals(session.sessionId);
      if (this.nativeVoiceSession?.sessionId !== session.sessionId) return;
      this.hooks.voiceSession().setConnectionStatus("connected");
    });
  }

  async startVoiceSession(
    channelId: string,
    retryMissingNativeSession = true,
    forceInitiatePeers = false
  ) {
    const voiceSession = this.hooks.voiceSession();
    voiceSession.startLatencyMonitor();
    voiceSession.startReconcileLoop();
    if (this.hooks.nativeDesktopRuntime()) {
      const voiceState = this.hooks.voiceState();
      const context = voiceState.voiceConnectionContext;
      const generation = this.nativeVoiceSessionGeneration;
      this.hooks.setError("");
      try {
        await this.startDesktopNativeVoiceSession(channelId);
      } catch (caught) {
        if (!context || !this.nativeVoiceStartTargetIsCurrent(context, channelId, generation)) return;
        if (retryMissingNativeSession && this.nativeVoiceSessionWasNotFound(caught)) {
          this.stopCurrentNativeVoiceSession();
          await this.startVoiceSession(channelId, false);
          return;
        }
        this.stopCurrentNativeVoiceSession();
        const audio = this.hooks.audio();
        audio.voiceInputUnavailable = true;
        audio.isSpeaking = false;
        voiceSession.setConnectionStatus("failed");
        audio.mergeCurrentVoiceFlags();
        void audio.syncCurrentVoiceState();
        this.hooks.setError(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceMediaUnavailable")));
      }
      return;
    }
    await voiceSession.startWebSession(channelId, forceInitiatePeers);
  }

  clearVoicePanelSelection() {
    if (this.hooks.channelContentMode() !== "voice") return;
    this.hooks.composer().clearComposerAttachmentObjectURLs();
    this.hooks.composer().clearMessageAttachmentObjectURLs();
    this.hooks.channels().selectedChannelId = "";
    this.hooks.clearMemberAccessFilter();
    this.hooks.setMemberSearchOpen(false);
    this.hooks.setMemberSearchQuery("");
    this.hooks.setChannelContentMode("chat");
    this.hooks.messages().messages = [];
    this.hooks.messages().hasOlderMessages = false;
    this.hooks.messages().currentChannelNewMessageCount = 0;
    this.hooks.messages().currentChannelNewMessageStartId = "";
    this.hooks.composer().clearReplyTarget();
    this.hooks.composer().clearMessageSearch();
    this.hooks.channelFiles().clearFileView();
  }

  stopVoiceSession(options: { clearVoicePanel?: boolean } = {}) {
    const transport = this.hooks.transport();
    this.hooks.voiceSession().stopWebSession();
    this.stopCurrentNativeVoiceSession();
    void this.hooks.screenShareSetup().stopNativeSender();
    transport.stopWebScreenShareSignalPolling();
    transport.stopLocalScreenShareStream({ programmatic: true });
    this.hooks.setScreenShareActionBusy(false);
    for (const connection of transport.screenSharePeerConnections.values()) {
      connection.close();
    }
    transport.screenSharePeerConnections.clear();
    transport.screenShareSenders.clear();
    transport.screenShareAudioSenders.clear();
    transport.pendingScreenShareIceCandidates.clear();
    transport.closeScreenShareViewerPanel();
    this.hooks.screenShare().resetWatchState();
    transport.stopViewerScreenShareSignalPolling();
    this.hooks.setPoppedOutScreenShareIds(new Set());
    this.hooks.setFocusedScreenShareId("");
    this.hooks.screenShareSetup().closeSetup();
    this.hooks.accompaniment().resetVoiceTransportState();
    if (options.clearVoicePanel) {
      this.clearVoicePanelSelection();
    }
    this.hooks.flushAliases();
  }

  voiceTransportActive() {
    return this.hooks.voiceSession().voiceTransportActive();
  }

  async ensureCurrentVoiceTransport(state: VoiceState, restart = false, forceInitiate = false) {
    const voiceState = this.hooks.voiceState();
    const audio = this.hooks.audio();
    if (!voiceState.voiceConnectionContext || !state?.channel_id) return;
    if (!restart && this.voiceTransportActive() && this.hooks.joinedVoiceChannelId() === state.channel_id) return;
    const voiceSession = this.hooks.voiceSession();
    if (voiceSession.resyncChannelId === state.channel_id) return;
    voiceSession.resyncChannelId = state.channel_id;
    try {
      if (restart) {
        this.stopVoiceSession();
      }
      if (state.mode === "listener") audio.micMuted = true;
      if (state.server_deafened) {
        audio.audioDeafened = true;
      }
      audio.isSpeaking = false;
      voiceState.mergeConnectedVoiceState(audio.applyLocalVoiceFlags(state));
      await audio.syncCurrentVoiceState();
      await this.startVoiceSession(state.channel_id, true, forceInitiate);
    } finally {
      voiceSession.resyncChannelId = "";
    }
  }

  async connectVoicePeers(channelId: string, forceInitiate = false) {
    const voiceState = this.hooks.voiceState();
    const localState = voiceState.currentVoiceState();
    if (!localState) return;
    if (this.hooks.nativeDesktopRuntime()) {
      const audio = this.hooks.audio();
      for (const state of voiceState.connectedVoiceStates.filter((item) => item.channel_id === channelId)) {
        if (state.participant_id === localState.participant_id) continue;
        await this.ensureVoicePeer(state, forceInitiate || localState.participant_id < state.participant_id);
        audio.applyMemberVolume(state.member_id);
      }
      this.hooks.realtime().resumeVoiceAudioAfterBrowserReturn();
      return;
    }
    await this.hooks.voiceSession().connectPeers(channelId, forceInitiate);
  }

  async ensureVoicePeer(targetState: VoiceState, initiate: boolean) {
    const targetParticipantId = targetState.participant_id;
    if (this.hooks.nativeDesktopRuntime()) {
      const session = this.nativeVoiceSession;
      if (!session) return null;
      await addNativeVoicePeer(session.sessionId, targetParticipantId, initiate);
      if (this.nativeVoiceSession?.sessionId !== session.sessionId) return null;
      const audio = this.hooks.audio();
      await setNativeVoiceMemberVolume(
        session.sessionId,
        targetParticipantId,
        audio.memberVolumePercent(targetState.member_id)
      );
      if (this.nativeVoiceSession?.sessionId !== session.sessionId) return null;
      await setNativeVoiceMemberMusicVolume(
        session.sessionId,
        targetParticipantId,
        audio.memberMusicVolumePercent(targetState.member_id)
      );
      if (this.nativeVoiceSession?.sessionId !== session.sessionId) return null;
      await this.flushNativeVoiceSignals(session.sessionId);
      return null;
    }
    return this.hooks.voiceSession().ensurePeerConnection(targetState, initiate);
  }

  async handleRTCSignal(signal: RTCSignal) {
    const transport = this.hooks.transport();
    const voiceState = this.hooks.voiceState();
    const voiceSession = this.hooks.voiceSession();
    const isScreenShareSignal = signal.signal_type.startsWith("screen-share-");
    const localState = voiceState.currentVoiceState();
    const fromParticipantId = signal.from_participant_id || signal.from_member_id;
    if (fromParticipantId === localState?.participant_id) {
      if (isScreenShareSignal) {
        console.warn("[EchoVoice] ignored screen share signal from self", {
          type: signal.signal_type,
          shareId: transport.screenShareSignalShareId(signal)
        });
      }
      return;
    }
    if (signal.target_participant_id && signal.target_participant_id !== localState?.participant_id) {
      if (isScreenShareSignal) {
        console.warn("[EchoVoice] ignored screen share signal for different target", {
          target: signal.target_member_id,
          localMemberId: this.hooks.memberId(),
          type: signal.signal_type,
          shareId: transport.screenShareSignalShareId(signal)
        });
      }
      return;
    }
    if (isScreenShareSignal) {
      let stage = signal.signal_type;
      try {
        if (signal.signal_type === "screen-share-watch") {
          await transport.handleScreenShareWatchSignal(signal);
          return;
        }
        if (signal.signal_type === "screen-share-unwatch") {
          await transport.handleScreenShareUnwatchSignal(signal);
          return;
        }
        if (signal.signal_type === "screen-share-path-hint") {
          transport.handleScreenSharePathHintSignal(signal);
          return;
        }
        if (signal.signal_type === "screen-share-offer") {
          stage = "screen-share-offer";
          await transport.handleScreenShareOfferSignal(signal);
          return;
        }
        if (signal.signal_type === "screen-share-answer") {
          stage = "screen-share-answer";
          await transport.handleScreenShareAnswerSignal(signal);
          return;
        }
        if (signal.signal_type === "screen-share-ice-candidate") {
          stage = "screen-share-ice-candidate";
          await transport.handleScreenShareIceCandidateSignal(signal);
          return;
        }
        if (signal.signal_type === "screen-share-restart-ice") {
          stage = "screen-share-restart-ice";
          await transport.handleScreenShareIceRestartSignal(signal);
          return;
        }
      } catch (caught) {
        console.warn("[EchoVoice] screen share signal handling failed", {
          stage,
          from: signal.from_member_id,
          target: signal.target_member_id,
          type: signal.signal_type,
          shareId: transport.screenShareSignalShareId(signal),
          error: caught instanceof Error ? caught.message : String(caught),
          stack: caught instanceof Error ? caught.stack : undefined
        });
        // A screen-share signalling hiccup must not take the voice connection
        // down with it: the screen-share transport has its own reconnect path,
        // while marking voice failed here tears down every voice peer for a
        // problem none of them caused.
      }
      return;
    }
    const currentState = localState;
    if (!currentState || currentState.channel_id !== signal.channel_id) return;
    const remoteState = voiceState.connectedVoiceStateByParticipant(fromParticipantId)
      ?? voiceState.connectedVoiceStateByMember(signal.from_member_id);
    if (!remoteState) return;

    if (this.hooks.nativeDesktopRuntime()) {
      const session = this.nativeVoiceSession;
      if (!session) {
        this.pendingNativeVoiceSignals = [...this.pendingNativeVoiceSignals, signal].slice(-64);
        return;
      }
      try {
        await handleNativeVoiceSignal(
          session.sessionId,
          fromParticipantId,
          signal.signal_type as "offer" | "answer" | "ice-candidate",
          signal.data
        );
        if (this.nativeVoiceSession?.sessionId !== session.sessionId) return;
        await this.flushNativeVoiceSignals(session.sessionId);
      } catch (caught) {
        voiceSession.setConnectionStatus("failed");
        this.hooks.setError(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceMediaUnavailable")));
      }
      return;
    }

    await voiceSession.handleVoiceSignal(signal, currentState, fromParticipantId);
  }

  sendRTCSignal(targetParticipantId: string, signalType: RTCSignal["signal_type"], data: unknown) {
    const transport = this.hooks.transport();
    const voiceState = this.hooks.voiceState();
    const isScreenShareSignal = signalType.startsWith("screen-share-");
    const shareId = transport.screenShareDataShareId(data);
    const targetState = isScreenShareSignal
      ? voiceState.voiceStateByParticipant(targetParticipantId)
      : voiceState.connectedVoiceStateByParticipant(targetParticipantId);
    const targetMemberId = targetState?.member_id ?? targetParticipantId;
    if (
      this.hooks.sessionToken() &&
      shareId &&
      (
        signalType === "screen-share-offer" ||
        signalType === "screen-share-answer" ||
        signalType === "screen-share-ice-candidate"
      )
    ) {
      void transport.sendScreenShareMediaSignal(
        targetMemberId,
        signalType,
        data,
        targetState?.participant_id ?? ""
      );
      return true;
    }
    const state = voiceState.currentVoiceState();
    const channelId = isScreenShareSignal
      ? transport.screenShareChannelIdForSignalData(data) || state?.channel_id || ""
      : state?.channel_id || "";
    const signalSocket = isScreenShareSignal ? this.hooks.realtime().eventSocket : this.hooks.realtime().activeVoiceSignalSocket();
    if (!channelId || !signalSocket || signalSocket.readyState !== WebSocket.OPEN) {
      if (isScreenShareSignal) {
        console.warn("[EchoVoice] screen share signal blocked", {
          targetMemberId,
          signalType,
          shareId,
          hasVoiceState: Boolean(state),
          resolvedChannelId: channelId,
          socketState: signalSocket?.readyState
        });
      } else if (channelId) {
        const pending = this.hooks.pendingVoiceOutboundSignals();
        this.hooks.setPendingVoiceOutboundSignals([
          ...pending,
          { channelId, targetParticipantId, signalType, data }
        ].slice(-128));
      }
      return false;
    }
    signalSocket.send(
      JSON.stringify({
        type: "rtc.signal",
        payload: {
          channel_id: channelId,
          target_member_id: targetMemberId,
          target_participant_id: targetState?.participant_id,
          signal_type: signalType,
          data
        }
      })
    );
    return true;
  }

  flushPendingVoiceOutboundSignals() {
    const voiceState = this.hooks.voiceState();
    const signalSocket = this.hooks.realtime().activeVoiceSignalSocket();
    if (!signalSocket || signalSocket.readyState !== WebSocket.OPEN) return;
    const signals = this.hooks.pendingVoiceOutboundSignals();
    this.hooks.setPendingVoiceOutboundSignals([]);
    for (const signal of signals) {
      signalSocket.send(
        JSON.stringify({
          type: "rtc.signal",
          payload: {
            channel_id: signal.channelId,
            target_member_id: voiceState.connectedVoiceStateByParticipant(signal.targetParticipantId)?.member_id ?? signal.targetParticipantId,
            target_participant_id: signal.targetParticipantId,
            signal_type: signal.signalType,
            data: signal.data
          }
        })
      );
    }
  }

  closePeerConnection(participantIDToClose: string, memberIDToClose = participantIDToClose) {
    if (this.nativeVoiceSession) {
      void removeNativeVoicePeer(this.nativeVoiceSession.sessionId, participantIDToClose);
    }
    this.hooks.voiceSession().closePeerConnection(participantIDToClose, memberIDToClose);
  }
}
