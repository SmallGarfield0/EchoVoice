// Accompaniment domain controller.
//
// Owns the accompaniment feature state and actions: the server-authoritative
// session registry and refresh queue, the source picker dialog (native process
// list on Tauri, audio file on Web), starting/stopping a session, the browser
// WebAudio send graph (de-click chain, fades, RTP warmup, transport context),
// the send-volume popover, and the persisted send-volume preference.
//
// This file uses the .svelte.ts extension so Svelte 5 `$state` runes work
// inside the class. Template-bound DOM references (the volume popover anchor,
// popover element, and hidden web file input) stay in the workspace component
// and are injected through hooks. The component keeps legacy-reactive aliases
// for template-bound fields; hot paths read this controller directly.

import { tick } from "svelte";
import {
  endAccompanimentSession,
  getAccompanimentSessions,
  startAccompanimentSession
} from "./api";
import {
  accompanimentSessionName,
  accompanimentSourceDisplayName,
  accompanimentSourceSessionName
} from "./accompaniment";
import { armAudioDeclick, ensureAudioDeclickModule } from "./remote-audio";
import {
  listDesktopAudioProcessSources,
  setNativeVoiceAccompanimentVolume,
  startNativeVoiceAccompaniment,
  stopNativeVoiceAccompaniment
} from "./storage";
import type { SinkAudioContext } from "./soundboard.svelte";
import type { VoiceConnectionContext } from "./voice-state.svelte";
import type {
  AccompanimentSession,
  DesktopAudioProcessSource,
  DesktopMediaCapabilities,
  NativeVoiceSession,
  ServerSummary,
  VoiceState
} from "./types";

const accompanimentSendVolumeStorageKey = "ev.accompaniment.sendVolumePercent";
export const maximumAccompanimentSendVolumePercent = 200;
const webAccompanimentFadeSeconds = 0.08;
const webAccompanimentRTPWarmupMS = 80;
const webAccompanimentRTPSilenceHoldMS = 180;

function clampVoicePercent(value: number, maximum: number) {
  return Math.max(0, Math.min(maximum, Math.round(Number.isFinite(value) ? value : 100)));
}

function loadVoicePercent(key: string, fallback: number, maximum: number) {
  const raw = localStorage.getItem(key);
  if (raw == null) return fallback;
  const stored = Number(raw);
  return Number.isFinite(stored) ? clampVoicePercent(stored, maximum) : fallback;
}

/**
 * Cross-cutting dependencies injected by the workspace component. Every side
 * effect that belongs to another domain (voice transport, audio output,
 * dialogs, error reporting) and every template-bound DOM reference flows
 * through these lazy arrow hooks so the controller never imports the
 * component.
 */
export type AccompanimentHooks = {
  server: () => ServerSummary | null;
  baseUrl: () => string;
  sessionToken: () => string;
  memberId: () => string;
  activeServerId: () => string;
  voiceConnectionContext: () => VoiceConnectionContext | null;
  nativeDesktopRuntime: () => boolean;
  nativeVoiceSession: () => NativeVoiceSession | null;
  currentVoiceState: () => VoiceState | null;
  canPlayAccompaniment: () => boolean;
  translate: (key: string, params?: Record<string, string | number>) => string;
  setError: (message: string) => void;
  caughtMessage: (caught: unknown, fallback: string) => string;
  isHTTPStatus: (caught: unknown, status: number) => boolean;
  nativeVoiceCommandWasStaleOrMissing: (sessionId: string, caught: unknown) => boolean;
  outputVolumePercent: () => number;
  audioDeafened: () => boolean;
  selectedAudioOutputDeviceId: () => string;
  closeSoundboardPopover: () => void;
  replaceOutgoingAccompanimentTrack: (track: MediaStreamTrack | null, stream: MediaStream | null) => Promise<void>;
  ensureDesktopMediaCapabilities: () => Promise<DesktopMediaCapabilities | null>;
  // Template-bound DOM references stay owned by the component.
  volumePopoverAnchor: () => HTMLButtonElement | null;
  setVolumePopoverAnchor: (anchor: HTMLButtonElement | null) => void;
  volumePopoverElement: () => HTMLDivElement | null;
  setVolumePopoverElement: (element: HTMLDivElement | null) => void;
  webAccompanimentFileInput: () => HTMLInputElement | null;
  // Bumps the component's realtimeSyncTick so legacy $: aliases refresh now
  // instead of waiting for the 100ms interval.
  flushAliases: () => void;
};

export class AccompanimentController {
  // Server-authoritative session registry for the active workspace.
  sessions = $state<AccompanimentSession[]>([]);
  // Picker dialog and action state.
  actionBusy = $state(false);
  dialogOpen = $state(false);
  // Send-volume popover state.
  volumePopoverOpen = $state(false);
  volumePopoverStyle = $state("");
  // Source picker state.
  selectedSourceID = $state("");
  selectedWebFile = $state<File | null>(null);
  processSources = $state<DesktopAudioProcessSource[]>([]);
  sourcesLoading = $state(false);
  sourceError = $state("");
  // Persisted send-volume preference.
  sendVolumePercent = $state(loadVoicePercent(
    accompanimentSendVolumeStorageKey,
    100,
    maximumAccompanimentSendVolumePercent
  ));

  // Refresh queue (hot path; never rendered directly).
  private realtimeRevision = 0;
  private refreshPromise: Promise<void> | null = null;
  private refreshQueued = false;

  // Web accompaniment WebAudio graph (hot path; never rendered directly).
  private audioContext: SinkAudioContext | null = null;
  private transportContext: SinkAudioContext | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private declickNode: AudioWorkletNode | null = null;
  private sendGain: GainNode | null = null;
  private monitorGain: GainNode | null = null;
  private bridgeDestination: MediaStreamAudioDestinationNode | null = null;
  private bridgeSource: MediaStreamAudioSourceNode | null = null;
  private transportDeclickNode: AudioWorkletNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private silenceSource: ConstantSourceNode | null = null;
  private objectURL = "";
  private endedDuringAction = false;
  private envelopeActive = false;
  private resumePromise: Promise<void> | null = null;

  constructor(private hooks: AccompanimentHooks) {}

  private flush() {
    this.hooks.flushAliases();
  }

  get selectedSource(): DesktopAudioProcessSource | undefined {
    const sourceID = this.selectedSourceID;
    return sourceID ? this.processSources.find((source) => source.sourceId === sourceID) : undefined;
  }

  webStream(): MediaStream | null {
    return this.destination?.stream ?? null;
  }

  /** Active-workspace sessions in the currently connected voice channel. */
  currentChannelSessions(): AccompanimentSession[] {
    const state = this.hooks.currentVoiceState();
    const context = this.hooks.voiceConnectionContext();
    return state && context?.serverId === this.hooks.activeServerId()
      ? this.sessions.filter((session) => session.channel_id === state.channel_id)
      : [];
  }

  memberIds(): Set<string> {
    return new Set(this.sessions.map((session) => session.owner_member_id));
  }

  /** The local member's session on the active workspace, when connected. */
  currentMember(): AccompanimentSession | undefined {
    const context = this.hooks.voiceConnectionContext();
    return context?.serverId === this.hooks.activeServerId()
      ? this.sessions.find((session) => session.owner_member_id === context?.memberId)
      : undefined;
  }

  /** Raw workspace-load fetch kept separate so loadWorkspace keeps its Promise.all shape. */
  fetchSessions(token: string, signal?: AbortSignal) {
    return getAccompanimentSessions(this.hooks.baseUrl(), token, signal);
  }

  // ---- session registry --------------------------------------------------------

  /** Polling refresh with the original queue/revision semantics. */
  async refreshSessions() {
    if (!this.hooks.sessionToken()) return;
    this.refreshQueued = true;
    if (this.refreshPromise) return this.refreshPromise;
    const request = (async () => {
      while (this.refreshQueued && this.hooks.sessionToken()) {
        this.refreshQueued = false;
        const requestBaseUrl = this.hooks.baseUrl();
        const requestSessionToken = this.hooks.sessionToken();
        const requestRevision = this.realtimeRevision;
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 3500);
        try {
          const sessions = await getAccompanimentSessions(requestBaseUrl, requestSessionToken, controller.signal);
          if (
            this.hooks.baseUrl() !== requestBaseUrl
            || this.hooks.sessionToken() !== requestSessionToken
            || this.realtimeRevision !== requestRevision
          ) continue;
          this.realtimeRevision += 1;
          this.sessions = sessions;
          this.flush();
        } catch {
          // WebSocket remains the primary source; refresh failures should not interrupt voice.
        } finally {
          window.clearTimeout(timeout);
        }
      }
    })();
    this.refreshPromise = request;
    try {
      await request;
    } finally {
      if (this.refreshPromise === request) this.refreshPromise = null;
      if (this.refreshQueued) void this.refreshSessions();
    }
  }

  /** Workspace load path: replace the registry with an authoritative snapshot. */
  replaceSessions(sessions: AccompanimentSession[]) {
    this.realtimeRevision += 1;
    this.sessions = sessions;
    this.flush();
  }

  mergeSession(session: AccompanimentSession) {
    if (!session?.session_id) return;
    this.realtimeRevision += 1;
    this.sessions = [
      ...this.sessions.filter(
        (item) => item.session_id !== session.session_id && item.owner_member_id !== session.owner_member_id
      ),
      session
    ].sort((left, right) => {
      if (left.channel_id !== right.channel_id) return left.channel_id.localeCompare(right.channel_id);
      if (left.started_at_ms !== right.started_at_ms) return left.started_at_ms - right.started_at_ms;
      return left.session_id.localeCompare(right.session_id);
    });
    this.flush();
  }

  removeSession(session: AccompanimentSession) {
    if (!session?.session_id) return;
    this.realtimeRevision += 1;
    this.sessions = this.sessions.filter((item) => item.session_id !== session.session_id);
    if (session.owner_member_id === this.hooks.memberId()) {
      const nativeSession = this.hooks.nativeVoiceSession();
      if (nativeSession) {
        void stopNativeVoiceAccompaniment(nativeSession.sessionId);
      } else if (!this.hooks.nativeDesktopRuntime()) {
        void this.stopWebTransport();
      }
    }
    this.flush();
  }

  // ---- dialog / source picker ----------------------------------------------------

  setDialogOpen(open: boolean) {
    this.dialogOpen = open;
    this.flush();
  }

  async openDialog() {
    const capabilities = this.hooks.nativeDesktopRuntime()
      ? await this.hooks.ensureDesktopMediaCapabilities()
      : null;
    if (
      (this.hooks.nativeDesktopRuntime() && !capabilities?.audioBackends.includes("windows-process-loopback")) ||
      !this.hooks.server()?.accompaniment_enabled ||
      this.hooks.currentVoiceState()?.mode === "listener" ||
      !this.hooks.currentVoiceState() ||
      (this.hooks.nativeDesktopRuntime() && !this.hooks.nativeVoiceSession()) ||
      !this.hooks.canPlayAccompaniment() ||
      this.currentMember() ||
      this.actionBusy
    ) return;
    this.hooks.closeSoundboardPopover();
    this.dialogOpen = true;
    this.selectedSourceID = "";
    this.selectedWebFile = null;
    const fileInput = this.hooks.webAccompanimentFileInput();
    if (fileInput) fileInput.value = "";
    this.flush();
    if (this.hooks.nativeDesktopRuntime()) {
      await this.refreshSources();
      await tick();
      this.selectedSourceID = this.processSources[0]?.sourceId ?? "";
      this.flush();
    }
  }

  closeDialog() {
    if (this.actionBusy) return;
    this.dialogOpen = false;
    this.selectedSourceID = "";
    this.selectedWebFile = null;
    const fileInput = this.hooks.webAccompanimentFileInput();
    if (fileInput) fileInput.value = "";
    this.flush();
  }

  selectSource(source: DesktopAudioProcessSource) {
    this.selectedSourceID = source.sourceId;
    this.flush();
  }

  openFilePicker() {
    this.hooks.webAccompanimentFileInput()?.click();
  }

  handleFileChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    this.selectedWebFile = file && (file.type.startsWith("audio/") || file.type === "")
      ? file
      : null;
    this.sourceError = file && !this.selectedWebFile
      ? this.hooks.translate("accompaniment.audioFileRequired")
      : "";
    this.flush();
  }

  async refreshSources() {
    if (this.sourcesLoading) return;
    this.sourcesLoading = true;
    this.sourceError = "";
    this.flush();
    try {
      const result = await listDesktopAudioProcessSources();
      this.processSources = [...(result.sources ?? [])].sort((left, right) => {
        if (left.active !== right.active) return left.active ? -1 : 1;
        return left.name.localeCompare(right.name);
      });
      if (!this.processSources.some((source) => source.sourceId === this.selectedSourceID)) {
        this.selectedSourceID = this.processSources[0]?.sourceId ?? "";
      }
      this.sourceError = this.processSources.length === 0
        ? result.warnings?.[0] ?? ""
        : "";
    } catch (caught) {
      this.processSources = [];
      this.selectedSourceID = "";
      this.sourceError = caught instanceof Error ? caught.message : this.hooks.translate("accompaniment.sourcesUnavailable");
    } finally {
      this.sourcesLoading = false;
      this.flush();
    }
  }

  // ---- start / stop ---------------------------------------------------------------

  async startFromDialog() {
    const source = this.selectedSource;
    const webFile = this.selectedWebFile;
    const voiceState = this.hooks.currentVoiceState();
    const nativeSession = this.hooks.nativeVoiceSession();
    if (
      !voiceState ||
      !this.hooks.sessionToken() ||
      (this.hooks.nativeDesktopRuntime() ? !source?.processId || !nativeSession : !webFile) ||
      this.actionBusy
    ) return;

    this.actionBusy = true;
    this.hooks.setError("");
    this.flush();
    let created: AccompanimentSession | null = null;
    try {
      const webTrack = this.hooks.nativeDesktopRuntime() || !webFile
        ? null
        : await this.prepareWebPlayback(webFile);
      created = await startAccompanimentSession(
        this.hooks.baseUrl(),
        this.hooks.sessionToken(),
        voiceState.channel_id,
        this.hooks.nativeDesktopRuntime() && source
          ? accompanimentSourceSessionName(source)
          : accompanimentSessionName(webFile?.name ?? "", this.hooks.translate("accompaniment.webAudioFile"))
      );
      this.mergeSession(created);
      if (this.hooks.nativeDesktopRuntime() && nativeSession && source?.processId) {
        await startNativeVoiceAccompaniment(
          nativeSession.sessionId,
          source.processId,
          this.sendVolumePercent
        );
      } else if (webTrack && this.destination) {
        await this.hooks.replaceOutgoingAccompanimentTrack(webTrack, this.destination.stream);
        if (this.audioElement) {
          this.endedDuringAction = false;
          this.audioElement.currentTime = 0;
          await this.audioElement.play();
          await new Promise<void>((resolve) => window.setTimeout(resolve, webAccompanimentRTPWarmupMS));
          this.fadeInPlayback();
        }
      }
      this.dialogOpen = false;
      this.selectedSourceID = "";
      this.selectedWebFile = null;
      const fileInput = this.hooks.webAccompanimentFileInput();
      if (fileInput) fileInput.value = "";
      this.flush();
    } catch (caught) {
      if (!this.hooks.nativeDesktopRuntime()) {
        await this.stopWebTransport();
      }
      if (created) {
        try {
          const ended = await endAccompanimentSession(this.hooks.baseUrl(), this.hooks.sessionToken(), created.session_id);
          this.removeSession(ended);
        } catch {
          this.removeSession(created);
        }
      }
      this.hooks.setError(this.hooks.isHTTPStatus(caught, 404)
        ? this.hooks.translate("accompaniment.serverUpgradeRequired")
        : caught instanceof Error
          ? caught.message
          : this.hooks.translate("accompaniment.startFailed"));
    } finally {
      this.actionBusy = false;
      this.flush();
      if (this.endedDuringAction && this.currentMember()) {
        this.endedDuringAction = false;
        void this.stopCurrent();
      }
    }
  }

  async stopCurrent() {
    const accompaniment = this.currentMember();
    if (!accompaniment || !this.hooks.sessionToken() || this.actionBusy) return;
    this.actionBusy = true;
    this.closeVolumePopover();
    this.hooks.setError("");
    this.flush();
    try {
      const nativeSession = this.hooks.nativeVoiceSession();
      if (nativeSession) {
        await stopNativeVoiceAccompaniment(nativeSession.sessionId);
      } else {
        await this.stopWebTransport();
      }
      const ended = await endAccompanimentSession(this.hooks.baseUrl(), this.hooks.sessionToken(), accompaniment.session_id);
      this.removeSession(ended);
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("accompaniment.stopFailed"));
    } finally {
      this.actionBusy = false;
      this.flush();
    }
  }

  // ---- Web playback graph ----------------------------------------------------------

  async prepareWebPlayback(file: File) {
    this.disposePlayback(true);
    const AudioContextCtor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) throw new Error(this.hooks.translate("accompaniment.webAudioUnavailable"));

    let context = this.audioContext;
    let transportContext = this.transportContext;
    let bridgeDestination = this.bridgeDestination;
    let destination = this.destination;
    const existingTrack = destination?.stream.getAudioTracks()[0];
    if (
      !context ||
      context.state === "closed" ||
      !transportContext ||
      transportContext.state === "closed" ||
      !bridgeDestination ||
      !destination ||
      existingTrack?.readyState !== "live"
    ) {
      this.disposePlayback();
      context = new AudioContextCtor({ latencyHint: "playback", sampleRate: 48_000 }) as SinkAudioContext;
      transportContext = new AudioContextCtor({ latencyHint: "interactive", sampleRate: 48_000 }) as SinkAudioContext;
      bridgeDestination = context.createMediaStreamDestination();
      destination = transportContext.createMediaStreamDestination();
      const bridgeSource = transportContext.createMediaStreamSource(bridgeDestination.stream);
      const monitorGain = transportContext.createGain();
      monitorGain.gain.value = 0;
      let transportDeclick: AudioWorkletNode | null = null;
      if (await ensureAudioDeclickModule(transportContext)) {
        transportDeclick = new AudioWorkletNode(transportContext, "echovoice-declick", {
          channelCount: 2,
          channelCountMode: "max",
          outputChannelCount: [2]
        });
        bridgeSource.connect(transportDeclick);
        transportDeclick.connect(destination);
        transportDeclick.connect(monitorGain);
      } else {
        bridgeSource.connect(destination);
        bridgeSource.connect(monitorGain);
      }
      monitorGain.connect(transportContext.destination);
      const silenceSource = transportContext.createConstantSource();
      silenceSource.offset.value = 0;
      silenceSource.connect(destination);
      silenceSource.start();
      this.audioContext = context;
      this.transportContext = transportContext;
      this.bridgeDestination = bridgeDestination;
      this.bridgeSource = bridgeSource;
      this.transportDeclickNode = transportDeclick;
      this.monitorGain = monitorGain;
      this.destination = destination;
      this.silenceSource = silenceSource;
      await transportContext.resume();
    }
    const audio = new Audio();
    const objectURL = URL.createObjectURL(file);
    const sourceNode = context.createMediaElementSource(audio);
    const sendGain = context.createGain();
    const track = destination.stream.getAudioTracks()[0];
    if (!track) {
      URL.revokeObjectURL(objectURL);
      await context.close().catch(() => undefined);
      throw new Error(this.hooks.translate("accompaniment.webAudioUnavailable"));
    }

    track.contentHint = "music";
    audio.preload = "auto";
    audio.src = objectURL;
    sendGain.gain.value = 0;
    let declickNode: AudioWorkletNode | null = null;
    if (await ensureAudioDeclickModule(context)) {
      declickNode = new AudioWorkletNode(context, "echovoice-declick", {
        channelCount: 2,
        channelCountMode: "max",
        outputChannelCount: [2]
      });
      sourceNode.connect(declickNode);
      declickNode.connect(sendGain);
    } else {
      sourceNode.connect(sendGain);
    }
    sendGain.connect(bridgeDestination);

    this.audioContext = context;
    this.audioElement = audio;
    this.sourceNode = sourceNode;
    this.declickNode = declickNode;
    this.sendGain = sendGain;
    this.objectURL = objectURL;
    this.envelopeActive = false;
    const outputDeviceId = this.hooks.selectedAudioOutputDeviceId();
    if (outputDeviceId && transportContext.setSinkId) {
      await transportContext.setSinkId(outputDeviceId).catch(() => undefined);
    }
    audio.onended = () => {
      if (this.actionBusy) {
        this.endedDuringAction = true;
      } else if (this.currentMember()) {
        void this.stopCurrent();
      } else {
        this.disposePlayback(true);
      }
    };

    try {
      const playRequest = audio.play();
      await Promise.all([context.resume(), playRequest]);
      return track;
    } catch (caught) {
      this.disposePlayback();
      throw new Error(this.hooks.caughtMessage(caught, this.hooks.translate("accompaniment.webPlaybackBlocked")));
    }
  }

  applyMonitorLevel() {
    const gain = this.monitorGain;
    if (!gain) return;
    gain.gain.setTargetAtTime(
      this.envelopeActive && !this.hooks.audioDeafened()
        ? (this.hooks.outputVolumePercent() / 100) * (this.sendVolumePercent / 100)
        : 0,
      gain.context.currentTime,
      0.01
    );
  }

  applySendVolume() {
    const sendGain = this.sendVolumePercent / 100;
    if (this.envelopeActive && this.sendGain) {
      this.sendGain.gain.setTargetAtTime(
        sendGain,
        this.sendGain.context.currentTime,
        0.01
      );
    }
    this.applyMonitorLevel();
    const sessionId = this.hooks.nativeVoiceSession()?.sessionId;
    if (!sessionId) return;
    void setNativeVoiceAccompanimentVolume(sessionId, this.sendVolumePercent).catch((caught) => {
      if (this.hooks.nativeVoiceCommandWasStaleOrMissing(sessionId, caught)) return;
      this.hooks.setError(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceMediaUnavailable")));
    });
  }

  private scheduleGain(gain: GainNode | null, target: number, durationSeconds: number) {
    if (!gain) return;
    const context = gain.context;
    const now = context.currentTime;
    const currentValue = gain.gain.value;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(currentValue, now);
    gain.gain.linearRampToValueAtTime(target, now + durationSeconds);
  }

  private setGainImmediately(gain: GainNode | null, target: number) {
    if (!gain) return;
    const context = gain.context;
    const now = context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(target, now);
  }

  fadeInPlayback() {
    this.envelopeActive = true;
    this.scheduleGain(
      this.sendGain,
      this.sendVolumePercent / 100,
      webAccompanimentFadeSeconds
    );
    this.scheduleGain(
      this.monitorGain,
      this.hooks.audioDeafened()
        ? 0
        : (this.hooks.outputVolumePercent() / 100) * (this.sendVolumePercent / 100),
      webAccompanimentFadeSeconds
    );
  }

  private async waitForAudioTime(
    context: AudioContext,
    targetTime: number,
    timeoutMS = 2_000
  ) {
    const deadline = Date.now() + timeoutMS;
    while (context.currentTime < targetTime && Date.now() < deadline) {
      if (context.state === "suspended") await context.resume().catch(() => undefined);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 8));
    }
    return context.currentTime >= targetTime;
  }

  private async fadeOutPlayback() {
    const context = this.audioContext;
    if (!context || !this.envelopeActive) return;
    if (context.state === "suspended") await context.resume().catch(() => undefined);
    this.envelopeActive = false;
    const releaseAt = context.currentTime
      + webAccompanimentFadeSeconds
      + webAccompanimentRTPSilenceHoldMS / 1_000;
    this.scheduleGain(this.sendGain, 0, webAccompanimentFadeSeconds);
    this.scheduleGain(this.monitorGain, 0, webAccompanimentFadeSeconds);
    await this.waitForAudioTime(context, releaseAt);
    if (this.audioContext !== context) return;
    this.setGainImmediately(this.sendGain, 0);
    this.setGainImmediately(this.monitorGain, 0);
  }

  resumeAfterBrowserReturn() {
    const context = this.audioContext;
    const transportContext = this.transportContext;
    const audio = this.audioElement;
    if (transportContext?.state === "suspended") {
      armAudioDeclick(this.transportDeclickNode);
    }
    if (!context || !audio) {
      if (transportContext?.state === "suspended") void transportContext.resume().catch(() => undefined);
      return;
    }
    if (!this.currentMember() || audio.ended) {
      if (context.state === "suspended") void context.resume().catch(() => undefined);
      if (transportContext?.state === "suspended") void transportContext.resume().catch(() => undefined);
      return;
    }
    if (
      context.state !== "suspended" &&
      transportContext?.state !== "suspended" &&
      !audio.paused
    ) return;
    if (this.resumePromise) return;

    const restoreEnvelope = this.envelopeActive;
    armAudioDeclick(this.declickNode);
    this.resumePromise = Promise.all([
      context.state === "suspended" ? context.resume() : Promise.resolve(),
      transportContext?.state === "suspended" ? transportContext.resume() : Promise.resolve(),
      audio.paused ? audio.play() : Promise.resolve()
    ]).then(() => {
      if (
        restoreEnvelope &&
        this.audioContext === context &&
        this.audioElement === audio
      ) {
        this.scheduleGain(
          this.sendGain,
          this.sendVolumePercent / 100,
          webAccompanimentFadeSeconds
        );
        this.scheduleGain(
          this.monitorGain,
          this.hooks.audioDeafened()
            ? 0
            : (this.hooks.outputVolumePercent() / 100) * (this.sendVolumePercent / 100),
          webAccompanimentFadeSeconds
        );
      }
    }).catch(() => undefined).finally(() => {
      this.resumePromise = null;
    });
  }

  disposePlayback(preserveTransport = false) {
    this.envelopeActive = false;
    this.resumePromise = null;
    const audio = this.audioElement;
    if (audio) {
      audio.onended = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    this.sourceNode?.disconnect();
    this.declickNode?.disconnect();
    this.sendGain?.disconnect();
    if (!preserveTransport) {
      this.bridgeSource?.disconnect();
      this.transportDeclickNode?.disconnect();
      this.monitorGain?.disconnect();
      try {
        this.silenceSource?.stop();
      } catch {
        // The source may already have stopped during context teardown.
      }
      this.silenceSource?.disconnect();
      this.bridgeDestination?.stream.getTracks().forEach((track) => track.stop());
      this.destination?.stream.getTracks().forEach((track) => track.stop());
      void this.audioContext?.close().catch(() => undefined);
      void this.transportContext?.close().catch(() => undefined);
    }
    if (this.objectURL) URL.revokeObjectURL(this.objectURL);
    if (!preserveTransport) {
      this.audioContext = null;
      this.transportContext = null;
      this.bridgeDestination = null;
      this.bridgeSource = null;
      this.transportDeclickNode = null;
      this.monitorGain = null;
      this.silenceSource = null;
      this.destination = null;
    }
    this.audioElement = null;
    this.sourceNode = null;
    this.declickNode = null;
    this.sendGain = null;
    this.objectURL = "";
    this.endedDuringAction = false;
  }

  async stopWebTransport() {
    if (!this.audioContext && !this.destination) return;
    await this.fadeOutPlayback();
    this.disposePlayback(true);
  }

  // ---- output-device routing ------------------------------------------------------

  /** Applies the selected output device to both Web accompaniment contexts. */
  async syncOutputDevice(deviceId: string) {
    if (this.audioContext?.setSinkId) {
      await this.audioContext.setSinkId(deviceId);
    }
    if (this.transportContext?.setSinkId) {
      await this.transportContext.setSinkId(deviceId);
    }
  }

  // ---- send volume & popover ------------------------------------------------------

  changeSendVolume(event: Event) {
    this.sendVolumePercent = clampVoicePercent(
      Number((event.currentTarget as HTMLInputElement).value),
      maximumAccompanimentSendVolumePercent
    );
    localStorage.setItem(accompanimentSendVolumeStorageKey, String(this.sendVolumePercent));
    this.applySendVolume();
    this.flush();
  }

  resetSendVolume() {
    this.sendVolumePercent = 100;
    localStorage.removeItem(accompanimentSendVolumeStorageKey);
    this.applySendVolume();
    this.flush();
  }

  updateVolumePopoverPosition() {
    const anchor = this.hooks.volumePopoverAnchor();
    const element = this.hooks.volumePopoverElement();
    if (!anchor || !element) return;
    const anchorRect = anchor.getBoundingClientRect();
    const viewportPadding = 8;
    const gap = 8;
    const width = Math.min(270, Math.max(180, window.innerWidth - viewportPadding * 2));
    const left = Math.max(
      viewportPadding,
      Math.min(anchorRect.right - width, window.innerWidth - width - viewportPadding)
    );
    const desiredHeight = Math.max(
      1,
      Math.ceil(element.scrollHeight || element.getBoundingClientRect().height)
    );
    const availableAbove = Math.max(0, anchorRect.top - gap - viewportPadding);
    const availableBelow = Math.max(0, window.innerHeight - anchorRect.bottom - gap - viewportPadding);
    const openAbove = availableAbove >= Math.min(desiredHeight, 120) || availableAbove >= availableBelow;
    const availableHeight = Math.max(72, openAbove ? availableAbove : availableBelow);
    const height = Math.min(desiredHeight, availableHeight);
    const top = openAbove
      ? Math.max(viewportPadding, anchorRect.top - gap - height)
      : Math.min(anchorRect.bottom + gap, window.innerHeight - viewportPadding - height);
    this.volumePopoverStyle = `visibility: visible; left: ${Math.round(left)}px; top: ${Math.round(top)}px; width: ${Math.round(width)}px; max-height: ${Math.round(availableHeight)}px;`;
    this.flush();
  }

  async toggleVolumePopover(event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (this.volumePopoverOpen) {
      this.closeVolumePopover();
      return;
    }
    this.hooks.setVolumePopoverAnchor(event.currentTarget as HTMLButtonElement);
    this.volumePopoverStyle = "visibility: hidden;";
    this.volumePopoverOpen = true;
    this.flush();
    await tick();
    this.updateVolumePopoverPosition();
    this.hooks.volumePopoverElement()?.focus();
  }

  closeVolumePopover(restoreFocus = false) {
    const anchor = this.hooks.volumePopoverAnchor();
    this.volumePopoverOpen = false;
    this.volumePopoverStyle = "";
    this.hooks.setVolumePopoverElement(null);
    this.hooks.setVolumePopoverAnchor(null);
    this.flush();
    if (restoreFocus) void tick().then(() => anchor?.focus());
  }

  // ---- workspace teardown ---------------------------------------------------------

  /** stopVoiceSession cleanup: closes UI and disposes the Web playback graph. */
  resetVoiceTransportState() {
    this.dialogOpen = false;
    this.closeVolumePopover();
    this.selectedSourceID = "";
    this.selectedWebFile = null;
    this.disposePlayback();
    this.flush();
  }

  /** clearActiveServerWorkspace cleanup: matches the original reset exactly. */
  resetWorkspaceState() {
    this.sessions = [];
    this.dialogOpen = false;
    this.closeVolumePopover();
    this.selectedSourceID = "";
    this.flush();
  }
}
