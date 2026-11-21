// Voice channel session (Web path).
//
// Owns the WebRTC peer-connection mesh for the connected voice channel: the
// per-peer RTCPeerConnection lifecycle, offer/answer/ICE signaling, audio
// transceivers (voice + accompaniment), peer health checks and the reconcile
// loop, the processed microphone pipeline, speaking-level detection, and the
// network latency monitor. The desktop native path stays in the workspace
// component, which delegates to this controller through thin wrappers.
//
// Hot-path discipline: event handlers and signaling must read this state
// directly; the component's legacy `$:` aliases only feed templates and lag
// one effect flush behind the runes.

import { decideVoicePeerHealth } from "./voice-peer-health";
import { browserRTCConfiguration as buildBrowserRTCConfiguration } from "./browserRTCConfiguration";
import { enhanceAccompanimentOpusSDP } from "./accompaniment";
import type { RemoteVoiceMixer } from "./remote-audio";
import type { VoiceStateController } from "./voice-state.svelte";
import type {
  AccompanimentSession,
  NativeVoiceSession,
  NativeVoiceStatus,
  RTCIceServer,
  RTCSignal,
  VoiceNoiseSuppressionMode,
  VoiceState
} from "./types";

export type VoiceSessionHooks = {
  voiceState: VoiceStateController;
  remoteVoiceMixer: RemoteVoiceMixer;
  micMuted: () => boolean;
  audioDeafened: () => boolean;
  voiceInputUnavailable: () => boolean;
  isSpeaking: () => boolean;
  microphoneGainPercent: () => number;
  noiseSuppressionMode: () => VoiceNoiseSuppressionMode;
  selectedAudioInputDeviceId: () => string;
  clearSelectedAudioInputDeviceId: () => void;
  nativeDesktopRuntime: () => boolean;
  nativeVoiceSession: () => NativeVoiceSession | null;
  nativeVoiceStatus: () => NativeVoiceStatus | null;
  nativeSessionStarting: () => boolean;
  rtcIceServers: () => RTCIceServer[];
  accompanimentSessions: () => AccompanimentSession[];
  hiddenSinceMS: () => number;
  documentHidden: () => boolean;
  setMicMuted: (value: boolean) => void;
  setAudioDeafened: (value: boolean) => void;
  setVoiceInputUnavailable: (value: boolean) => void;
  setLocalSpeaking: (value: boolean) => void;
  setError: (message: string) => void;
  reportMediaError: (caught: unknown, fallbackKey: string) => void;
  translate: (key: string) => string;
  audioConstraints: (deviceId?: string) => MediaTrackConstraints;
  applyLocalAudioState: () => void;
  mergeCurrentVoiceFlags: () => void;
  syncCurrentVoiceState: () => void;
  refreshAudioInputDevices: () => Promise<void>;
  applyNativeVoiceLatency: (roundTripTimeMs: number) => void;
  sendRTCSignal: (targetParticipantId: string, signalType: RTCSignal["signal_type"], data: unknown) => boolean;
  attachRemoteScreenShare: (peerId: string, memberId: string, stream: MediaStream, track: MediaStreamTrack) => void;
  attachRemoteAudio: (memberId: string, stream: MediaStream, scope: "voice" | "accompaniment" | "screen-share") => void;
  applyMemberVolume: (memberId: string) => void;
  resumeVoiceAudioAfterBrowserReturn: () => void;
  stopVoiceSession: (options?: { clearVoicePanel?: boolean }) => void;
  stopCurrentNativeVoiceSession: () => void;
  stopCurrentNativeScreenShareSender: () => void;
  stopWebScreenShareSignalPolling: () => void;
  stopLocalScreenShareStream: (options: { programmatic: boolean }) => void;
  closeScreenShareSetup: () => void;
  closeAccompanimentVolumePopover: () => void;
  disposeWebAccompanimentPlayback: () => void;
  closeScreenShareViewerPanel: () => void;
  clearAllScreenShareWatchRetryTimers: () => void;
  clearAllScreenShareReconnectTimers: () => void;
  stopViewerScreenShareSignalPolling: () => void;
  setRemoteAudioPlaybackBlocked: (blocked: boolean) => void;
  webAccompanimentStream: () => MediaStream | null;
  handleVoiceSignalDispatch: (signal: RTCSignal) => Promise<void>;
};

type BufferedRTCRtpReceiver = RTCRtpReceiver & {
  jitterBufferTarget?: number;
  playoutDelayHint?: number;
};

export class VoiceSessionController {
  // Template-visible state (mirrored into the component via $: aliases).
  connectionStatus = $state<"idle" | "connecting" | "connected" | "failed">("idle");
  peerCount = $state(0);
  latencyMS = $state<number | null>(null);
  latencyMeasuredAtMS = $state(0);
  latencyFailureCount = $state(0);
  jitterMS = $state<number | null>(null);
  packetLossLabel = $state("-");
  inboundKbps = $state<number | null>(null);
  outboundKbps = $state<number | null>(null);
  networkSampleSource = $state("health");
  networkDetailsOpen = $state(false);
  inputLevel = $state(0);

  // Signaling/session internals (never rendered directly).
  private peerConnections = new Map<string, RTCPeerConnection>();
  private primaryTransceivers = new Map<string, RTCRtpTransceiver>();
  private accompanimentTransceivers = new Map<string, RTCRtpTransceiver>();
  private pendingIceCandidates = new Map<string, RTCIceCandidateInit[]>();
  private initialOfferPromises = new Map<string, Promise<void>>();
  private signalProcessingQueues = new Map<string, Promise<void>>();
  private peerDisconnectedAtMS = new Map<string, number>();
  private inboundProgressSamples = new Map<string, { bytes: number; lastProgressAtMS: number }>();
  private peerRetryTimers = new Map<string, number>();
  private previousRTCByteSamples = new Map<string, { bytes: number; timestamp: number }>();
  private latencyTimer = 0;
  private reconcileTimer = 0;
  resyncChannelId = "";
  localVoiceStream: MediaStream | null = null;
  rawLocalVoiceStream: MediaStream | null = null;
  private voiceAudioContext: AudioContext | null = null;
  private voiceAnalyser: AnalyserNode | null = null;
  private voiceAnalyserSource: MediaStreamAudioSourceNode | null = null;
  private voiceAnalyserData: Uint8Array<ArrayBuffer> | null = null;
  private voiceAnalyserFrame = 0;
  private speakingStartFrames = 0;
  private speakingStopFrames = 0;
  private inputProcessingContext: AudioContext | null = null;
  private inputProcessingSource: MediaStreamAudioSourceNode | null = null;
  private inputGainNode: GainNode | null = null;
  private inputNoiseGateNode: GainNode | null = null;
  private inputLimiterNode: DynamicsCompressorNode | null = null;
  private inputDestination: MediaStreamAudioDestinationNode | null = null;

  private hooks: VoiceSessionHooks;
  private speakingStartLevel = 0.05;
  private speakingStopLevel = 0.02;

  constructor(hooks: VoiceSessionHooks) {
    this.hooks = hooks;
  }

  get peerConnectionCount(): number {
    return this.peerConnections.size;
  }

  get peerConnectionStates(): string[] {
    return [...this.peerConnections.values()].map((connection) => connection.connectionState);
  }

  // ---- latency monitor ------------------------------------------------------

  startLatencyMonitor(): void {
    if (this.latencyTimer) return;
    void this.measureLatency(false);
    this.latencyTimer = window.setInterval(() => {
      if (this.hooks.documentHidden()) return;
      void this.measureLatency(this.networkDetailsOpen);
    }, 15000);
  }

  stopLatencyMonitor(): void {
    if (this.latencyTimer) {
      window.clearInterval(this.latencyTimer);
    }
    this.latencyTimer = 0;
    this.latencyMS = null;
    this.latencyMeasuredAtMS = 0;
    this.latencyFailureCount = 0;
    this.jitterMS = null;
    this.packetLossLabel = "-";
    this.inboundKbps = null;
    this.outboundKbps = null;
    this.networkSampleSource = "health";
    this.previousRTCByteSamples.clear();
    this.networkDetailsOpen = false;
  }

  async measureLatency(includeRTCDetails = false): Promise<void> {
    const voiceBaseUrl = this.hooks.voiceState.voiceConnectionContext?.baseUrl ?? "";
    if (!voiceBaseUrl || !this.hooks.voiceState.currentVoiceState()) {
      this.latencyMS = null;
      this.latencyMeasuredAtMS = 0;
      return;
    }
    const nativeSession = this.hooks.nativeVoiceSession();
    const nativeStatus = this.hooks.nativeVoiceStatus();
    if (nativeSession && nativeStatus?.roundTripTimeMs != null) {
      this.hooks.applyNativeVoiceLatency(nativeStatus.roundTripTimeMs);
      return;
    }
    if (includeRTCDetails && await this.measureRTCStats()) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 3000);
    const startedAt = performance.now();
    try {
      const response = await fetch(`${voiceBaseUrl}/healthz?latency=${Date.now()}`, {
        cache: "no-store",
        signal: controller.signal
      });
      this.latencyMS = response.ok ? Math.max(0, Math.round(performance.now() - startedAt)) : null;
      this.jitterMS = null;
      this.packetLossLabel = "-";
      this.inboundKbps = null;
      this.outboundKbps = null;
      this.networkSampleSource = "health";
      this.latencyMeasuredAtMS = Date.now();
      if (response.ok) {
        this.latencyFailureCount = 0;
      } else {
        this.latencyFailureCount += 1;
      }
    } catch {
      this.latencyMS = null;
      this.latencyMeasuredAtMS = Date.now();
      this.latencyFailureCount += 1;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async measureRTCStats(): Promise<boolean> {
    if (this.peerConnections.size === 0) return false;
    let rttMS: number | null = null;
    let jitterMS: number | null = null;
    let packetsLost = 0;
    let packetsReceived = 0;
    let inboundKbpsTotal = 0;
    let outboundKbpsTotal = 0;
    let hasRTCStats = false;

    for (const [peerId, connection] of this.peerConnections.entries()) {
      const stats = await connection.getStats();
      stats.forEach((report) => {
        const item = report as RTCStats & Record<string, any>;
        if (item.type === "candidate-pair" && (item.state === "succeeded" || item.nominated)) {
          if (typeof item.currentRoundTripTime === "number") {
            rttMS = Math.round(item.currentRoundTripTime * 1000);
            hasRTCStats = true;
          }
        }
        if ((item.type === "inbound-rtp" || item.type === "remote-inbound-rtp") && item.kind === "audio") {
          if (typeof item.jitter === "number") jitterMS = Math.round(item.jitter * 1000);
          if (typeof item.packetsLost === "number") packetsLost += Math.max(0, item.packetsLost);
          if (typeof item.packetsReceived === "number") packetsReceived += Math.max(0, item.packetsReceived);
          hasRTCStats = true;
        }
        if (item.type === "inbound-rtp" && item.kind === "audio" && typeof item.bytesReceived === "number") {
          inboundKbpsTotal += this.computeRTCBitrateKbps(`${peerId}:${item.id}:in`, item.bytesReceived, item.timestamp);
        }
        if (item.type === "outbound-rtp" && item.kind === "audio" && typeof item.bytesSent === "number") {
          outboundKbpsTotal += this.computeRTCBitrateKbps(`${peerId}:${item.id}:out`, item.bytesSent, item.timestamp);
        }
      });
    }

    if (!hasRTCStats) return false;
    const totalPackets = packetsLost + packetsReceived;
    const lossPercent = totalPackets > 0 ? Math.round((packetsLost / totalPackets) * 1000) / 10 : 0;
    this.latencyMS = rttMS;
    this.jitterMS = jitterMS;
    this.packetLossLabel = `${lossPercent}% (${packetsLost})`;
    this.inboundKbps = Math.round(inboundKbpsTotal);
    this.outboundKbps = Math.round(outboundKbpsTotal);
    this.networkSampleSource = "webrtc";
    this.latencyMeasuredAtMS = Date.now();
    this.latencyFailureCount = 0;
    return true;
  }

  private computeRTCBitrateKbps(sampleId: string, bytes: number, timestamp: number): number {
    const previous = this.previousRTCByteSamples.get(sampleId);
    this.previousRTCByteSamples.set(sampleId, { bytes, timestamp });
    if (!previous || timestamp <= previous.timestamp || bytes < previous.bytes) return 0;
    return ((bytes - previous.bytes) * 8) / (timestamp - previous.timestamp);
  }

  // ---- microphone pipeline ---------------------------------------------------

  async openLocalVoiceStream(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(this.hooks.translate("error.voiceMediaUnavailable"));
    }
    if (this.hooks.selectedAudioInputDeviceId()) {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio: this.hooks.audioConstraints(this.hooks.selectedAudioInputDeviceId()),
          video: false
        });
      } catch (selectedDeviceError) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: this.hooks.audioConstraints(""),
            video: false
          });
          this.hooks.clearSelectedAudioInputDeviceId();
          return stream;
        } catch {
          throw selectedDeviceError;
        }
      }
    }
    return navigator.mediaDevices.getUserMedia({
      audio: this.hooks.audioConstraints(""),
      video: false
    });
  }

  async createProcessedLocalVoiceStream(stream: MediaStream): Promise<MediaStream> {
    const AudioContextCtor = window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return stream;
    try {
      const captureSampleRate = stream.getAudioTracks()[0]?.getSettings().sampleRate;
      this.inputProcessingContext = new AudioContextCtor({
        latencyHint: "interactive",
        ...(captureSampleRate ? { sampleRate: captureSampleRate } : {})
      });
      this.inputProcessingSource = this.inputProcessingContext.createMediaStreamSource(stream);
      this.inputGainNode = this.inputProcessingContext.createGain();
      this.inputNoiseGateNode = this.inputProcessingContext.createGain();
      this.inputLimiterNode = this.inputProcessingContext.createDynamicsCompressor();
      this.inputLimiterNode.threshold.value = -3;
      this.inputLimiterNode.knee.value = 6;
      this.inputLimiterNode.ratio.value = 20;
      this.inputLimiterNode.attack.value = 0.003;
      this.inputLimiterNode.release.value = 0.12;
      this.inputDestination = this.inputProcessingContext.createMediaStreamDestination();
      this.applyMicrophoneGain();
      this.inputProcessingSource.connect(this.inputGainNode);
      this.inputGainNode.connect(this.inputNoiseGateNode);
      this.inputNoiseGateNode.connect(this.inputLimiterNode);
      this.inputLimiterNode.connect(this.inputDestination);
      await this.inputProcessingContext.resume();
      return this.inputDestination.stream;
    } catch {
      this.closeWebMicrophoneProcessing();
      return stream;
    }
  }

  applyMicrophoneGain(): void {
    if (!this.inputGainNode || !this.inputProcessingContext) return;
    this.inputGainNode.gain.setTargetAtTime(
      this.hooks.microphoneGainPercent() / 100,
      this.inputProcessingContext.currentTime,
      0.01
    );
  }

  applyWebNoiseGate(): void {
    if (!this.inputNoiseGateNode || !this.inputProcessingContext) return;
    let target = 1;
    if (this.hooks.noiseSuppressionMode() === "strong") {
      if (this.inputLevel <= 0.018) target = 0.08;
      else if (this.inputLevel < 0.085) target = 0.08 + (this.inputLevel - 0.018) / 0.067 * 0.92;
    }
    const current = this.inputNoiseGateNode.gain.value;
    this.inputNoiseGateNode.gain.setTargetAtTime(
      target,
      this.inputProcessingContext.currentTime,
      target > current ? 0.008 : 0.09
    );
  }

  async attachLocalVoiceStream(stream: MediaStream): Promise<void> {
    this.stopLocalVoiceInput();
    this.rawLocalVoiceStream = stream;
    this.localVoiceStream = await this.createProcessedLocalVoiceStream(stream);
    this.hooks.setVoiceInputUnavailable(false);
    this.hooks.applyLocalAudioState();
    this.startVoiceLevelMonitor(stream);
    await this.hooks.refreshAudioInputDevices();
    await this.replaceOutgoingAudioTrack(this.localVoiceStream.getAudioTracks()[0] ?? stream.getAudioTracks()[0] ?? null);
  }

  stopLocalVoiceInput(): void {
    this.stopVoiceLevelMonitor();
    const rawStream = this.rawLocalVoiceStream;
    if (this.localVoiceStream !== rawStream) this.localVoiceStream?.getTracks().forEach((track) => track.stop());
    this.closeWebMicrophoneProcessing();
    rawStream?.getTracks().forEach((track) => track.stop());
    this.localVoiceStream = null;
    this.rawLocalVoiceStream = null;
    this.inputLevel = 0;
  }

  private closeWebMicrophoneProcessing(): void {
    this.inputDestination?.stream.getTracks().forEach((track) => track.stop());
    this.inputProcessingSource?.disconnect();
    this.inputGainNode?.disconnect();
    this.inputNoiseGateNode?.disconnect();
    this.inputLimiterNode?.disconnect();
    void this.inputProcessingContext?.close().catch(() => undefined);
    this.inputProcessingContext = null;
    this.inputProcessingSource = null;
    this.inputGainNode = null;
    this.inputNoiseGateNode = null;
    this.inputLimiterNode = null;
    this.inputDestination = null;
  }

  async restartVoiceInput(): Promise<void> {
    if (!this.hooks.voiceState.currentVoiceState()) return;
    if (this.hooks.nativeDesktopRuntime()) {
      this.hooks.applyLocalAudioState();
      return;
    }
    try {
      const stream = await this.openLocalVoiceStream();
      await this.attachLocalVoiceStream(stream);
      this.hooks.setError("");
      if (this.hooks.micMuted() && !this.hooks.audioDeafened()) {
        this.hooks.setMicMuted(false);
      }
      this.hooks.mergeCurrentVoiceFlags();
      this.hooks.syncCurrentVoiceState();
    } catch {
      this.stopLocalVoiceInput();
      this.hooks.setVoiceInputUnavailable(true);
      this.hooks.setMicMuted(true);
      this.hooks.setLocalSpeaking(false);
      await this.replaceOutgoingAudioTrack(null);
      this.hooks.mergeCurrentVoiceFlags();
      this.hooks.syncCurrentVoiceState();
      this.hooks.setError(this.hooks.translate("error.voiceMediaUnavailable"));
    }
  }

  // ---- transceivers and outgoing audio ---------------------------------------

  async replaceOutgoingAudioTrack(track: MediaStreamTrack | null): Promise<void> {
    const replacements: Promise<void>[] = [];
    for (const [targetParticipantId, connection] of this.peerConnections.entries()) {
      const { primary } = this.registerVoiceAudioTransceivers(targetParticipantId, connection);
      if (!primary) {
        const remoteState = this.hooks.voiceState.connectedVoiceStateByParticipant(targetParticipantId);
        if (remoteState) this.scheduleVoicePeerRetry(remoteState);
        continue;
      }
      primary.direction = "sendrecv";
      replacements.push(
        primary.sender.replaceTrack(track).then(() => this.configureVoiceSender(primary.sender))
      );
    }
    await Promise.allSettled(replacements);
  }

  registerVoiceAudioTransceivers(targetParticipantId: string, connection: RTCPeerConnection) {
    const audioTransceivers = connection.getTransceivers().filter(
      (item) => item.receiver.track?.kind === "audio" || item.sender.track?.kind === "audio"
    );
    const registeredPrimary = this.primaryTransceivers.get(targetParticipantId);
    const primary = registeredPrimary && audioTransceivers.includes(registeredPrimary)
      ? registeredPrimary
      : audioTransceivers[0];
    if (primary) this.primaryTransceivers.set(targetParticipantId, primary);

    const registeredAccompaniment = this.accompanimentTransceivers.get(targetParticipantId);
    const accompaniment = registeredAccompaniment && audioTransceivers.includes(registeredAccompaniment)
      ? registeredAccompaniment
      : audioTransceivers.find((item) => item !== primary);
    if (accompaniment) this.accompanimentTransceivers.set(targetParticipantId, accompaniment);
    return { primary, accompaniment };
  }

  voiceAudioTrackScope(
    targetParticipantId: string,
    connection: RTCPeerConnection,
    transceiver: RTCRtpTransceiver
  ): "voice" | "accompaniment" {
    const { accompaniment } = this.registerVoiceAudioTransceivers(targetParticipantId, connection);
    if (transceiver === accompaniment) return "accompaniment";
    const audioTransceivers = connection.getTransceivers().filter(
      (item) => item.receiver.track?.kind === "audio" || item.sender.track?.kind === "audio"
    );
    return audioTransceivers.indexOf(transceiver) > 0 ? "accompaniment" : "voice";
  }

  addVoiceAudioTransceiver(
    connection: RTCPeerConnection,
    track: MediaStreamTrack | null,
    stream: MediaStream | null
  ): RTCRtpTransceiver {
    return track && stream
      ? connection.addTransceiver(track, { direction: "sendrecv", streams: [stream] })
      : connection.addTransceiver("audio", { direction: "sendrecv" });
  }

  async prepareVoiceAudioTransceivers(
    targetParticipantId: string,
    connection: RTCPeerConnection,
    allowCreate: boolean
  ) {
    let { primary, accompaniment } = this.registerVoiceAudioTransceivers(targetParticipantId, connection);
    const localTrack = this.localVoiceStream?.getAudioTracks()[0] ?? null;
    const accompanimentStream = this.hooks.webAccompanimentStream();
    const accompanimentTrack = accompanimentStream?.getAudioTracks()[0] ?? null;
    if (!primary && allowCreate) {
      primary = this.addVoiceAudioTransceiver(connection, localTrack, this.localVoiceStream);
      this.primaryTransceivers.set(targetParticipantId, primary);
    }
    if (!accompaniment && allowCreate) {
      accompaniment = this.addVoiceAudioTransceiver(connection, accompanimentTrack, accompanimentStream);
      this.accompanimentTransceivers.set(targetParticipantId, accompaniment);
    }
    if (primary) {
      primary.direction = "sendrecv";
      if (primary.sender.track !== localTrack) await primary.sender.replaceTrack(localTrack);
      await this.configureVoiceSender(primary.sender);
    }
    if (accompaniment) {
      accompaniment.direction = "sendrecv";
      if (accompaniment.sender.track !== accompanimentTrack) {
        await accompaniment.sender.replaceTrack(accompanimentTrack);
      }
      await this.configureVoiceSender(accompaniment.sender, true);
    }
    return { primary, accompaniment };
  }

  async replaceOutgoingAccompanimentTrack(track: MediaStreamTrack | null, _stream: MediaStream | null): Promise<void> {
    const replacements: Promise<void>[] = [];
    for (const [targetParticipantId, connection] of this.peerConnections.entries()) {
      const { accompaniment } = this.registerVoiceAudioTransceivers(targetParticipantId, connection);
      if (!accompaniment) {
        const remoteState = this.hooks.voiceState.connectedVoiceStateByParticipant(targetParticipantId);
        if (remoteState) this.scheduleVoicePeerRetry(remoteState);
        replacements.push(Promise.reject(new Error(this.hooks.translate("error.voiceMediaUnavailable"))));
        continue;
      }
      accompaniment.direction = "sendrecv";
      replacements.push(
        accompaniment.sender.replaceTrack(track)
          .then(() => this.configureVoiceSender(accompaniment!.sender, true))
      );
    }
    const results = await Promise.allSettled(replacements);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  async configureVoiceSender(sender: RTCRtpSender, music = false): Promise<void> {
    if (sender.track?.kind !== "audio") return;
    const parameters = sender.getParameters();
    const encodings = parameters.encodings as Array<RTCRtpEncodingParameters & {
      dtx?: "disabled" | "enabled";
      networkPriority?: RTCPriorityType;
    }>;
    if (!encodings?.length) return;
    for (const encoding of encodings) {
      if ("dtx" in encoding) encoding.dtx = "disabled";
      if (music) {
        encoding.maxBitrate = 256_000;
        encoding.priority = "high";
        encoding.networkPriority = "high";
      }
    }
    try {
      await sender.setParameters(parameters);
    } catch {
      // voiceActivityDetection=false in SDP remains the cross-browser fallback.
    }
  }

  async createContinuousVoiceOffer(connection: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
    const offer = await connection.createOffer({ voiceActivityDetection: false } as RTCOfferOptions);
    return offer.sdp ? { ...offer, sdp: enhanceAccompanimentOpusSDP(offer.sdp) } : offer;
  }

  async createContinuousVoiceAnswer(connection: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
    const answer = await connection.createAnswer({ voiceActivityDetection: false } as RTCAnswerOptions);
    return answer.sdp ? { ...answer, sdp: enhanceAccompanimentOpusSDP(answer.sdp) } : answer;
  }

  // ---- speaking-level monitor -------------------------------------------------

  startVoiceLevelMonitor(stream: MediaStream): void {
    this.stopVoiceLevelMonitor();
    const AudioContextCtor = window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    try {
      this.voiceAudioContext = new AudioContextCtor();
      this.voiceAnalyser = this.voiceAudioContext.createAnalyser();
      this.voiceAnalyser.fftSize = 1024;
      this.voiceAnalyserSource = this.voiceAudioContext.createMediaStreamSource(stream);
      this.voiceAnalyserSource.connect(this.voiceAnalyser);
      this.voiceAnalyserData = new Uint8Array(this.voiceAnalyser.fftSize);
      this.updateVoiceInputLevel();
    } catch {
      this.stopVoiceLevelMonitor();
    }
  }

  stopVoiceLevelMonitor(): void {
    if (this.voiceAnalyserFrame) {
      window.cancelAnimationFrame(this.voiceAnalyserFrame);
    }
    this.voiceAnalyserFrame = 0;
    this.voiceAnalyserSource?.disconnect();
    this.voiceAnalyser?.disconnect();
    void this.voiceAudioContext?.close().catch(() => undefined);
    this.voiceAudioContext = null;
    this.voiceAnalyser = null;
    this.voiceAnalyserSource = null;
    this.voiceAnalyserData = null;
    this.speakingStartFrames = 0;
    this.speakingStopFrames = 0;
    this.inputLevel = 0;
  }

  private updateVoiceInputLevel(): void {
    if (!this.voiceAnalyser || !this.voiceAnalyserData) return;
    this.voiceAnalyser.getByteTimeDomainData(this.voiceAnalyserData);
    let sum = 0;
    for (const sample of this.voiceAnalyserData) {
      const normalized = (sample - 128) / 128;
      sum += normalized * normalized;
    }
    this.inputLevel = Math.min(1, Math.sqrt(sum / this.voiceAnalyserData.length) * 3);
    this.applyWebNoiseGate();
    this.updateSpeakingFromInputLevel();
    this.voiceAnalyserFrame = window.requestAnimationFrame(() => this.updateVoiceInputLevel());
  }

  private updateSpeakingFromInputLevel(): void {
    if (this.hooks.micMuted() || this.hooks.audioDeafened() || this.hooks.voiceInputUnavailable()) {
      this.hooks.setLocalSpeaking(false);
      return;
    }
    if (!this.hooks.isSpeaking() && this.inputLevel >= this.speakingStartLevel) {
      this.speakingStartFrames += 1;
      if (this.speakingStartFrames >= 3) {
        this.speakingStartFrames = 0;
        this.hooks.setLocalSpeaking(true);
      }
      return;
    }
    if (this.hooks.isSpeaking() && this.inputLevel <= this.speakingStopLevel) {
      this.speakingStopFrames += 1;
      if (this.speakingStopFrames >= 12) {
        this.speakingStopFrames = 0;
        this.hooks.setLocalSpeaking(false);
      }
      return;
    }
    if (this.inputLevel < this.speakingStartLevel) {
      this.speakingStartFrames = 0;
    }
    if (this.inputLevel > this.speakingStopLevel) {
      this.speakingStopFrames = 0;
    }
  }

  // ---- session lifecycle (Web path) -------------------------------------------

  async startWebSession(channelId: string, forceInitiatePeers: boolean): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.hooks.setVoiceInputUnavailable(true);
      this.hooks.setMicMuted(true);
      this.hooks.setLocalSpeaking(false);
      this.hooks.mergeCurrentVoiceFlags();
      this.hooks.syncCurrentVoiceState();
      this.connectionStatus = "connected";
      await this.connectPeers(channelId, forceInitiatePeers);
      return;
    }
    this.connectionStatus = "connecting";
    this.hooks.setError("");
    if (this.hooks.micMuted() || this.hooks.audioDeafened()) {
      this.stopLocalVoiceInput();
      this.hooks.setVoiceInputUnavailable(false);
      this.connectionStatus = "connected";
      await this.connectPeers(channelId, forceInitiatePeers);
      return;
    }
    try {
      if (!this.localVoiceStream) {
        await this.attachLocalVoiceStream(await this.openLocalVoiceStream());
      }
      this.hooks.setVoiceInputUnavailable(false);
      this.hooks.applyLocalAudioState();
      this.connectionStatus = "connected";
      await this.connectPeers(channelId, forceInitiatePeers);
    } catch {
      this.hooks.setVoiceInputUnavailable(true);
      this.hooks.setMicMuted(true);
      this.hooks.setLocalSpeaking(false);
      this.hooks.mergeCurrentVoiceFlags();
      this.hooks.syncCurrentVoiceState();
      this.connectionStatus = "connected";
      await this.connectPeers(channelId, forceInitiatePeers);
    }
  }

  stopWebSession(): void {
    this.stopLatencyMonitor();
    this.stopReconcileLoop();
    for (const connection of this.peerConnections.values()) {
      connection.close();
    }
    this.peerConnections.clear();
    this.primaryTransceivers.clear();
    this.accompanimentTransceivers.clear();
    this.pendingIceCandidates.clear();
    this.initialOfferPromises.clear();
    this.signalProcessingQueues.clear();
    this.peerDisconnectedAtMS.clear();
    this.inboundProgressSamples.clear();
    for (const timer of this.peerRetryTimers.values()) window.clearTimeout(timer);
    this.peerRetryTimers.clear();
    this.hooks.remoteVoiceMixer.detachAll();
    this.hooks.setRemoteAudioPlaybackBlocked(false);
    this.stopLocalVoiceInput();
    this.hooks.setLocalSpeaking(false);
    this.hooks.setVoiceInputUnavailable(false);
    this.connectionStatus = "idle";
    this.peerCount = 0;
  }

  voiceTransportActive(): boolean {
    return Boolean(
      this.connectionStatus === "connecting" ||
        this.connectionStatus === "connected" ||
        this.hooks.nativeSessionStarting() ||
        this.hooks.nativeVoiceSession() ||
        this.localVoiceStream ||
        this.peerConnections.size > 0 ||
        this.latencyTimer > 0
    );
  }

  async connectPeers(channelId: string, forceInitiate = false): Promise<void> {
    const localState = this.hooks.voiceState.currentVoiceState();
    if (!localState) return;
    for (const state of this.hooks.voiceState.connectedVoiceStates.filter((item) => item.channel_id === channelId)) {
      if (state.participant_id === localState.participant_id) continue;
      // After a browser return or renderer reload the remote side may still
      // believe its old connection is healthy while ours is gone. Force the
      // offer; the participant-id ordering rule resolves any glare.
      const connection = await this.ensurePeerConnection(
        state,
        forceInitiate || localState.participant_id < state.participant_id
      );
      if (connection) await this.checkWebVoicePeerHealth(state, connection);
      this.hooks.applyMemberVolume(state.member_id);
    }
    this.hooks.resumeVoiceAudioAfterBrowserReturn();
  }

  startReconcileLoop(): void {
    this.stopReconcileLoop();
    this.reconcileTimer = window.setInterval(() => {
      // Hidden tabs throttle timers to once per minute and may freeze the page
      // entirely. Skip the periodic reconciliation while hidden; the browser
      // return recovery runs a fresh pass immediately on becoming visible.
      if (this.hooks.documentHidden()) return;
      const state = this.hooks.voiceState.currentVoiceState();
      if (state) void this.connectPeers(state.channel_id);
    }, 2500);
  }

  stopReconcileLoop(): void {
    if (this.reconcileTimer) window.clearInterval(this.reconcileTimer);
    this.reconcileTimer = 0;
  }

  async checkWebVoicePeerHealth(targetState: VoiceState, connection: RTCPeerConnection): Promise<void> {
    const targetParticipantId = targetState.participant_id;
    if (this.peerConnections.get(targetParticipantId) !== connection || connection.connectionState === "closed") return;
    const now = Date.now();
    if (connection.connectionState === "disconnected") {
      this.peerDisconnectedAtMS.set(targetParticipantId, this.peerDisconnectedAtMS.get(targetParticipantId) ?? now);
      const decision = decideVoicePeerHealth({
        nowMS: now,
        connectionState: connection.connectionState,
        disconnectedAtMS: this.peerDisconnectedAtMS.get(targetParticipantId),
        hiddenSinceMS: this.hooks.hiddenSinceMS(),
        mediaExpected: false,
        previousSample: null,
        inboundBytes: 0
      });
      if (decision.action === "retry") this.scheduleVoicePeerRetry(targetState);
      return;
    }
    this.peerDisconnectedAtMS.delete(targetParticipantId);
    if (connection.connectionState !== "connected") return;

    let inboundBytes = 0;
    try {
      const stats = await connection.getStats();
      stats.forEach((report) => {
        const item = report as RTCStats & Record<string, any>;
        if (
          item.type === "inbound-rtp" &&
          (item.kind === "audio" || item.mediaType === "audio") &&
          typeof item.bytesReceived === "number"
        ) {
          inboundBytes += Math.max(0, item.bytesReceived);
        }
      });
    } catch {
      return;
    }
    if (this.peerConnections.get(targetParticipantId) !== connection) return;
    const mediaExpected = Boolean(
      targetState.is_speaking ||
      this.hooks.accompanimentSessions().some(
        (session) => session.owner_member_id === targetState.member_id && session.channel_id === targetState.channel_id
      )
    );
    const decision = decideVoicePeerHealth({
      nowMS: now,
      connectionState: connection.connectionState,
      hiddenSinceMS: this.hooks.hiddenSinceMS(),
      mediaExpected,
      previousSample: this.inboundProgressSamples.get(targetParticipantId) ?? null,
      inboundBytes
    });
    if (decision.action === "retry") {
      this.scheduleVoicePeerRetry(targetState);
      return;
    }
    if (decision.action === "seed") {
      this.inboundProgressSamples.set(targetParticipantId, decision.sample);
    }
  }

  async ensurePeerConnection(targetState: VoiceState, initiate: boolean): Promise<RTCPeerConnection> {
    const targetParticipantId = targetState.participant_id;
    let connection = this.peerConnections.get(targetParticipantId);
    if (connection && (connection.connectionState === "failed" || connection.connectionState === "closed")) {
      this.closePeerConnection(targetParticipantId, targetState.member_id);
      connection = undefined;
    }
    if (connection) {
      if (initiate && !connection.remoteDescription) {
        await this.prepareVoiceAudioTransceivers(targetParticipantId, connection, true);
        await this.ensureInitialVoiceOffer(targetParticipantId, connection);
      }
      return connection;
    }

    connection = new RTCPeerConnection(this.browserRTCConfiguration());
    this.peerConnections.set(targetParticipantId, connection);
    this.updatePeerCount();

    connection.onicecandidate = (event) => {
      if (event.candidate) {
        this.hooks.sendRTCSignal(targetParticipantId, "ice-candidate", event.candidate.toJSON());
      }
    };
    connection.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      if (event.track.kind === "video") {
        this.hooks.attachRemoteScreenShare(targetParticipantId, targetState.member_id, stream, event.track);
        return;
      }
      const receiver = event.receiver as BufferedRTCRtpReceiver;
      if ("jitterBufferTarget" in receiver) receiver.jitterBufferTarget = 60;
      if ("playoutDelayHint" in receiver) receiver.playoutDelayHint = 0.06;
      this.hooks.attachRemoteAudio(
        targetState.member_id,
        new MediaStream([event.track]),
        this.voiceAudioTrackScope(targetParticipantId, connection!, event.transceiver)
      );
    };
    connection.onconnectionstatechange = () => {
      if (connection?.connectionState === "connected") {
        this.connectionStatus = "connected";
        this.peerDisconnectedAtMS.delete(targetParticipantId);
        this.inboundProgressSamples.delete(targetParticipantId);
        const retryTimer = this.peerRetryTimers.get(targetParticipantId);
        if (retryTimer) window.clearTimeout(retryTimer);
        this.peerRetryTimers.delete(targetParticipantId);
      }
      if (connection?.connectionState === "failed") {
        this.scheduleVoicePeerRetry(targetState);
      }
      if (connection?.connectionState === "disconnected") {
        this.peerDisconnectedAtMS.set(targetParticipantId, Date.now());
      }
    };
    if (initiate) {
      await this.prepareVoiceAudioTransceivers(targetParticipantId, connection, true);
      await this.ensureInitialVoiceOffer(targetParticipantId, connection);
    }
    return connection;
  }

  async ensureInitialVoiceOffer(targetParticipantId: string, connection: RTCPeerConnection): Promise<void> {
    const existing = this.initialOfferPromises.get(targetParticipantId);
    if (existing) return existing;
    const request = (async () => {
      if (connection.remoteDescription || connection.connectionState === "closed") return;
      const localOffer = connection.localDescription?.type === "offer" ? connection.localDescription : null;
      if (localOffer) return;
      if (connection.signalingState !== "stable") return;
      const offer = await this.createContinuousVoiceOffer(connection);
      await connection.setLocalDescription(offer);
      this.hooks.sendRTCSignal(targetParticipantId, "offer", connection.localDescription ?? offer);
    })().finally(() => {
      if (this.initialOfferPromises.get(targetParticipantId) === request) {
        this.initialOfferPromises.delete(targetParticipantId);
      }
    });
    this.initialOfferPromises.set(targetParticipantId, request);
    return request;
  }

  scheduleVoicePeerRetry(targetState: VoiceState): void {
    const targetParticipantId = targetState.participant_id;
    if (this.peerRetryTimers.has(targetParticipantId)) return;
    const timer = window.setTimeout(() => {
      this.peerRetryTimers.delete(targetParticipantId);
      const currentState = this.hooks.voiceState.currentVoiceState();
      const remoteState = this.hooks.voiceState.connectedVoiceStateByParticipant(targetParticipantId);
      if (!currentState || !remoteState || currentState.channel_id !== remoteState.channel_id) return;
      this.closePeerConnection(targetParticipantId, remoteState.member_id);
      void this.ensurePeerConnection(remoteState, currentState.participant_id < remoteState.participant_id);
    }, 1200);
    this.peerRetryTimers.set(targetParticipantId, timer);
  }

  async flushPendingVoiceIceCandidates(targetMemberId: string, connection: RTCPeerConnection): Promise<void> {
    if (!connection.remoteDescription) return;
    const candidates = this.pendingIceCandidates.get(targetMemberId) ?? [];
    this.pendingIceCandidates.delete(targetMemberId);
    for (const candidate of candidates) {
      try {
        await connection.addIceCandidate(candidate);
      } catch (caught) {
        console.warn("[EchoVoice] ignored stale voice ICE candidate", {
          targetMemberId,
          error: caught instanceof Error ? caught.message : String(caught)
        });
      }
    }
  }

  async handleVoiceSignal(signal: RTCSignal, localState: VoiceState, fromParticipantId: string): Promise<void> {
    const remoteState = this.hooks.voiceState.connectedVoiceStateByParticipant(fromParticipantId)
      ?? this.hooks.voiceState.connectedVoiceStateByMember(signal.from_member_id);
    if (!remoteState) return;

    try {
      const connection = await this.ensurePeerConnection(remoteState, false);
      if (signal.signal_type === "offer") {
        const remoteOffer = signal.data as RTCSessionDescriptionInit;
        const duplicateOffer =
          connection.remoteDescription?.type === "offer" &&
          connection.remoteDescription.sdp === remoteOffer.sdp;
        if (duplicateOffer && connection.localDescription?.type === "answer") {
          this.hooks.sendRTCSignal(fromParticipantId, "answer", connection.localDescription);
          return;
        }
        if (connection.signalingState === "have-local-offer") {
          const localOfferWins = localState.participant_id < fromParticipantId;
          if (localOfferWins) return;
          await connection.setLocalDescription({ type: "rollback" } as RTCSessionDescriptionInit);
        } else if (connection.signalingState === "have-remote-offer") {
          if (!duplicateOffer) {
            this.scheduleVoicePeerRetry(remoteState);
            return;
          }
        } else if (connection.signalingState !== "stable") {
          return;
        }
        if (!duplicateOffer) await connection.setRemoteDescription(remoteOffer);
        const { primary, accompaniment } = await this.prepareVoiceAudioTransceivers(
          fromParticipantId,
          connection,
          false
        );
        await this.flushPendingVoiceIceCandidates(fromParticipantId, connection);
        if (connection.signalingState !== "have-remote-offer") return;
        const answer = await this.createContinuousVoiceAnswer(connection);
        await connection.setLocalDescription(answer);
        if (primary) await this.configureVoiceSender(primary.sender);
        if (accompaniment) await this.configureVoiceSender(accompaniment.sender, true);
        this.hooks.sendRTCSignal(fromParticipantId, "answer", answer);
        return;
      }
      if (signal.signal_type === "answer") {
        const remoteAnswer = signal.data as RTCSessionDescriptionInit;
        if (
          connection.remoteDescription?.type === "answer" &&
          connection.remoteDescription.sdp === remoteAnswer.sdp
        ) return;
        if (connection.signalingState !== "have-local-offer") return;
        await connection.setRemoteDescription(remoteAnswer);
        await this.flushPendingVoiceIceCandidates(fromParticipantId, connection);
        await this.prepareVoiceAudioTransceivers(fromParticipantId, connection, false);
        return;
      }
      if (signal.signal_type === "ice-candidate") {
        const candidate = signal.data as RTCIceCandidateInit;
        if (connection.remoteDescription) {
          try {
            await connection.addIceCandidate(candidate);
          } catch (caught) {
            console.warn("[EchoVoice] ignored stale voice ICE candidate", {
              fromParticipantId,
              error: caught instanceof Error ? caught.message : String(caught)
            });
          }
        } else {
          const queued = this.pendingIceCandidates.get(fromParticipantId) ?? [];
          this.pendingIceCandidates.set(fromParticipantId, [...queued, candidate].slice(-64));
        }
      }
    } catch (caught) {
      console.warn("[EchoVoice] voice signal handling failed", {
        fromParticipantId,
        signalType: signal.signal_type,
        error: caught instanceof Error ? caught.message : String(caught)
      });
      this.scheduleVoicePeerRetry(remoteState);
    }
  }

  enqueueSignal(signal: RTCSignal): Promise<void> {
    const peerId = signal.from_participant_id || signal.from_member_id;
    const previous = this.signalProcessingQueues.get(peerId) ?? Promise.resolve();
    const task = previous
      .catch(() => undefined)
      .then(() => this.hooks.handleVoiceSignalDispatch(signal))
      .catch((caught) => {
        console.warn("[EchoVoice] queued voice signal handling failed", {
          peerId,
          signalType: signal.signal_type,
          error: caught instanceof Error ? caught.message : String(caught)
        });
      });
    this.signalProcessingQueues.set(peerId, task);
    void task.then(() => {
      if (this.signalProcessingQueues.get(peerId) === task) {
        this.signalProcessingQueues.delete(peerId);
      }
    });
    return task;
  }

  closePeerConnection(participantIDToClose: string, memberIDToClose = participantIDToClose): void {
    this.peerConnections.get(participantIDToClose)?.close();
    this.peerConnections.delete(participantIDToClose);
    this.primaryTransceivers.delete(participantIDToClose);
    this.accompanimentTransceivers.delete(participantIDToClose);
    this.pendingIceCandidates.delete(participantIDToClose);
    this.initialOfferPromises.delete(participantIDToClose);
    this.peerDisconnectedAtMS.delete(participantIDToClose);
    this.inboundProgressSamples.delete(participantIDToClose);
    const retryTimer = this.peerRetryTimers.get(participantIDToClose);
    if (retryTimer) window.clearTimeout(retryTimer);
    this.peerRetryTimers.delete(participantIDToClose);
    this.hooks.remoteVoiceMixer.detachForMember(memberIDToClose, "voice");
    this.hooks.remoteVoiceMixer.detachForMember(memberIDToClose, "accompaniment");
    this.updatePeerCount();
  }

  private browserRTCConfiguration(): RTCConfiguration {
    return buildBrowserRTCConfiguration(
      this.hooks.voiceState.voiceConnectionContext?.iceServers ?? this.hooks.rtcIceServers()
    );
  }

  updatePeerCount(): void {
    this.peerCount = this.hooks.nativeVoiceStatus()?.peerCount ?? this.peerConnections.size;
  }

  setConnectionStatus(status: "idle" | "connecting" | "connected" | "failed"): void {
    this.connectionStatus = status;
  }

  /** Resumes the mic processing and level-analyser contexts after the
   * browser returns (they may have been suspended while hidden/frozen). */
  resumeSuspendedInputContexts(): void {
    for (const context of [this.inputProcessingContext, this.voiceAudioContext]) {
      if (context?.state === "suspended") {
        void context.resume().catch(() => undefined);
      }
    }
  }

  /** Clears wall-clock health samples that must not count across hidden
   * windows; wired to the tab visibility monitor. */
  clearHealthSamples(): void {
    this.inboundProgressSamples.clear();
    this.peerDisconnectedAtMS.clear();
  }

  /** Total received audio bytes across all peers (E2E diagnostics). */
  async inboundAudioBytesTotal(): Promise<number> {
    let bytes = 0;
    for (const connection of this.peerConnections.values()) {
      try {
        const stats = await connection.getStats();
        stats.forEach((report) => {
          const item = report as RTCStats & Record<string, any>;
          if (
            item.type === "inbound-rtp" &&
            (item.kind === "audio" || item.mediaType === "audio") &&
            typeof item.bytesReceived === "number"
          ) {
            bytes += Math.max(0, item.bytesReceived);
          }
        });
      } catch {
        // Transient stats failures are ignored; the next sample re-reads.
      }
    }
    return bytes;
  }
}
