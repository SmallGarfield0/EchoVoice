// Audio devices, volume preferences, mute/deafen flags, microphone &
// headphone tests, and voice latency/status helpers.
//
// Extracted from the workspace shell. The controller owns the audio-device
// state and the user-facing actions that mutate it. Cross-domain side effects
// (remote playback mixer, UI sounds, accompaniment/soundboard contexts, native
// voice session recovery, voice state sync) are injected through hooks so the
// controller never imports App.svelte.
//
// Svelte 5 note: this file uses the .svelte.ts extension so `$state` runes
// work inside a plain class; the workspace shell mirrors these fields into
// legacy `$:` aliases for templates.

import { updateVoiceState } from "./api";
import {
  listNativeAudioDevices,
  loadNativeMicrophoneTestStatus,
  setNativeMicrophoneTestLevels,
  setNativeVoiceLevels,
  setNativeVoiceNoiseSuppression,
  setNativeVoiceState,
  startNativeMicrophoneTest,
  stopNativeMicrophoneTest,
  testNativeHeadphones
} from "./storage";
import type { RemoteVoiceMixer } from "./remote-audio";
import type { VoiceSessionController } from "./voice-session.svelte";
import type { VoiceStateController } from "./voice-state.svelte";
import type {
  Member,
  NativeAudioDevice,
  NativeVoiceSession,
  NativeVoiceStatus,
  ScreenShareSession,
  VoiceNoiseSuppressionMode,
  VoiceState
} from "./types";

export type AudioDeviceOption = { deviceId: string; label: string; isDefault?: boolean };
export type UISoundName = "channel-join" | "channel-leave" | "audio-off" | "audio-on";
export type VoiceLatencyQuality = "unknown" | "good" | "fair" | "poor";

const audioInputDeviceStorageKey = "ev.voice.audioInputDeviceId";
const audioOutputDeviceStorageKey = "ev.voice.audioOutputDeviceId";
const microphoneMutedStorageKey = "ev.voice.microphoneMuted";
const microphoneGainStorageKey = "ev.voice.microphoneGainPercent";
const microphoneGainLimitStorageKey = "ev.voice.microphoneGainLimitPercent";
const noiseSuppressionModeStorageKey = "ev.voice.noiseSuppressionMode";
const outputVolumeStorageKey = "ev.voice.outputVolumePercent";
const memberVolumeStorageKey = "ev.voice.memberVolumePercent";
const memberVolumeLimitStorageKey = "ev.voice.memberVolumeLimitPercent";
const memberMusicVolumeStorageKey = "ev.voice.memberMusicVolumePercent";
const screenShareVolumeStorageKey = "ev.screenShare.volumePercent";
const uiSoundVolumeScale = 0.25;
const defaultMicrophoneGainLimitPercent = 300;
const defaultMemberVolumeLimitPercent = 200;
const maximumVoiceGainLimitPercent = 1000;
const noiseSuppressionModes: VoiceNoiseSuppressionMode[] = ["off", "light", "standard", "strong"];

const uiSoundURLs: Record<UISoundName, string> = {
  "channel-join": "/channel_join.mp3",
  "channel-leave": "/channel_leave.mp3",
  "audio-off": "/mic_headset_off.mp3",
  "audio-on": "/mic_headset_on.mp3"
};

export type AudioDevicesHooks = {
  // Workspace identity / context.
  memberId: () => string;
  activeServerId: () => string;
  nativeDesktopRuntime: () => boolean;
  screenSharePopoutMode: () => boolean;
  appSettingsOpen: () => boolean;
  statusKey: () => string;
  languageId: () => string;
  voiceActionBusy: () => boolean;
  setVoiceActionBusy: (busy: boolean) => void;
  // Controllers.
  voiceState: () => VoiceStateController;
  voiceSession: () => VoiceSessionController;
  // Remote playback graph & UI sounds (owned by the shell / soundboard).
  remoteVoiceMixer: () => RemoteVoiceMixer;
  activeUISounds: () => Set<HTMLAudioElement>;
  activeSoundboardAudio: () => Set<HTMLAudioElement>;
  soundboardAudioContext: () => (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
  accompanimentSyncOutputDevice: (deviceId: string) => Promise<void>;
  applySoundboardAudioGains: () => void;
  accompanimentApplyMonitorLevel: () => void;
  // Voice/session actions.
  currentVoiceState: () => VoiceState | null;
  voiceStatesByMember: () => Map<string, VoiceState>;
  screenShareSessions: () => ScreenShareSession[];
  queueCurrentVoiceSpeakingState: (force?: boolean) => void;
  // Native voice cross-hooks.
  nativeVoiceSession: () => NativeVoiceSession | null;
  nativeVoiceStatus: () => NativeVoiceStatus | null;
  applyNativeVoiceStatus: (status: NativeVoiceStatus) => void;
  clearNativeMicrophoneRecovery: (resetAttempts?: boolean) => void;
  recoverNativeMicrophone: (sessionId: string) => Promise<void>;
  scheduleNativeMicrophoneRecovery: (sessionId: string) => void;
  nativeVoiceCommandWasStaleOrMissing: (sessionId: string, caught: unknown) => boolean;
  startDesktopNativeVoiceSession: (channelId: string) => Promise<void>;
  stopCurrentNativeVoiceSession: () => void;
  startVoiceSession: (channelId: string, retryMissingNativeSession?: boolean, forceInitiatePeers?: boolean) => Promise<void>;
  // UI actions.
  setError: (message: string) => void;
  translate: (key: string, params?: Record<string, string | number>) => string;
  caughtMessage: (caught: unknown, fallback: string) => string;
  showAppAlert: (message: string, options?: { title?: string }) => Promise<unknown>;
  closeSettingsSelectMenu: () => void;
  clearCopiedInviteTimer: () => void;
  closeScreenShareViewerPanel: () => void;
  stopMediaStream: (stream: MediaStream) => void;
  flushAliases: () => void;
  // Web voice session wrappers (owned by VoiceSessionController).
  rawLocalVoiceStream: () => MediaStream | null;
  localVoiceStream: () => MediaStream | null;
  openLocalVoiceStream: () => Promise<MediaStream>;
  attachLocalVoiceStream: (stream: MediaStream) => Promise<void>;
  stopLocalVoiceInput: () => void;
  restartVoiceInput: () => Promise<void>;
  replaceOutgoingAudioTrack: (track: MediaStreamTrack | null) => Promise<void>;
  applyWebNoiseGate: () => void;
  // Member/display helpers.
  memberById: (memberId: string) => Member | undefined;
  memberRoleLabel: (member: Member) => string;
};

export class AudioDevicesController {
  // Template-visible state (mirrored into the component via $: aliases).
  micMuted = $state(false);
  audioDeafened = $state(false);
  isSpeaking = $state(false);
  voiceInputUnavailable = $state(false);
  audioInputDevices = $state<AudioDeviceOption[]>([]);
  audioOutputDevices = $state<AudioDeviceOption[]>([]);
  selectedAudioInputDeviceId = $state("");
  selectedAudioOutputDeviceId = $state("");
  audioInputDevicesLoading = $state(false);
  webPermissionInitialization = $state<Promise<void> | null>(null);
  microphoneGainLimitPercent = $state(300);
  memberVolumeLimitPercent = $state(200);
  microphoneGainPercent = $state(100);
  noiseSuppressionMode = $state<VoiceNoiseSuppressionMode>("standard");
  outputVolumePercent = $state(100);
  memberVolumePercents = $state<Record<string, number>>({});
  memberMusicVolumePercents = $state<Record<string, number>>({});
  screenShareVolumePercents = $state<Record<string, number>>({});
  screenShareVolumeMenuShareId = $state("");
  voiceParticipantMenuVolumePercent = $state(100);
  voiceParticipantMenuMusicVolumePercent = $state(100);
  nativeMemberVolumeSyncTimers = new Map<string, number>();
  nativeMemberMusicVolumeSyncTimers = new Map<string, number>();
  microphoneTestBusy = $state(false);
  microphoneTestActive = $state(false);
  microphoneTestLevel = $state(0);
  microphoneTestGeneration = 0;
  microphoneTestStream: MediaStream | null = null;
  microphoneTestAudioContext: AudioContext | null = null;
  microphoneTestSource: MediaStreamAudioSourceNode | null = null;
  microphoneTestInputGain: GainNode | null = null;
  microphoneTestAnalyser: AnalyserNode | null = null;
  microphoneTestOutputGain: GainNode | null = null;
  microphoneTestAnimationFrame: number | undefined;
  nativeMicrophoneTestSessionId = "";
  nativeMicrophoneTestStatusTimer: number | undefined;
  nativeMicrophoneTestStatusLoading = false;
  headphoneTestBusy = $state(false);
  microphonePopoverCloseTimer: number | undefined;
  microphonePopoverOpen = $state(false);

  private hooks: AudioDevicesHooks;

  constructor(hooks: AudioDevicesHooks) {
    this.hooks = hooks;
    this.micMuted = localStorage.getItem(microphoneMutedStorageKey) !== "false";
    this.selectedAudioInputDeviceId = this.loadSelectedAudioInputDeviceId();
    this.selectedAudioOutputDeviceId = this.loadSelectedAudioOutputDeviceId();
    this.microphoneGainLimitPercent = this.loadVoiceLimit(
      microphoneGainLimitStorageKey,
      defaultMicrophoneGainLimitPercent
    );
    this.memberVolumeLimitPercent = this.loadVoiceLimit(
      memberVolumeLimitStorageKey,
      defaultMemberVolumeLimitPercent
    );
    this.microphoneGainPercent = this.loadVoicePercent(
      microphoneGainStorageKey,
      100,
      this.microphoneGainLimitPercent
    );
    this.noiseSuppressionMode = this.loadNoiseSuppressionMode();
    this.outputVolumePercent = this.loadVoicePercent(outputVolumeStorageKey, 100, 100);
    this.memberVolumePercents = this.loadMemberVolumePercents();
    this.memberMusicVolumePercents = this.loadMemberMusicVolumePercents();
    this.screenShareVolumePercents = this.loadScreenShareVolumePercents();
  }

  // ── Audio status & device helpers ─────────────────────────────────────────
  currentUserStatusLabel() {
    if (this.hooks.currentVoiceState()?.mode === "listener") return this.hooks.translate("voice.listenOnly");
    if (this.hooks.voiceState().voiceConnectionContext) return this.hooks.translate("voice.connected");
    const member = this.hooks.memberById(this.hooks.memberId());
    if (!member) {
      const statusKey = this.hooks.statusKey();
      return statusKey === "status.disconnected" ? "" : this.hooks.translate(statusKey);
    }
    return this.hooks.memberRoleLabel(member);
  }

  loadSelectedAudioInputDeviceId() {
    return localStorage.getItem(audioInputDeviceStorageKey) ?? "";
  }

  loadSelectedAudioOutputDeviceId() {
    return localStorage.getItem(audioOutputDeviceStorageKey) ?? "";
  }

  loadNoiseSuppressionMode(): VoiceNoiseSuppressionMode {
    const stored = localStorage.getItem(noiseSuppressionModeStorageKey);
    return noiseSuppressionModes.includes(stored as VoiceNoiseSuppressionMode)
      ? stored as VoiceNoiseSuppressionMode
      : "standard";
  }

  noiseSuppressionModeLabel(mode: VoiceNoiseSuppressionMode) {
    if (mode === "off") return this.hooks.translate("voice.noiseSuppressionOff");
    if (mode === "light") return this.hooks.translate("voice.noiseSuppressionLight");
    if (mode === "standard") {
      return this.hooks.nativeDesktopRuntime()
        ? this.hooks.translate("voice.noiseSuppressionRNNoiseStandard")
        : this.hooks.translate("voice.noiseSuppressionWebStandard");
    }
    return this.hooks.nativeDesktopRuntime()
      ? this.hooks.translate("voice.noiseSuppressionRNNoiseStrong")
      : this.hooks.translate("voice.noiseSuppressionWebStrong");
  }

  noiseSuppressionModeDescription(mode: VoiceNoiseSuppressionMode) {
    if (mode === "off") return this.hooks.translate("voice.noiseSuppressionOffDescription");
    if (mode === "light") return this.hooks.translate("voice.noiseSuppressionLightDescription");
    if (mode === "standard") {
      return this.hooks.nativeDesktopRuntime()
        ? this.hooks.translate("voice.noiseSuppressionRNNoiseStandardDescription")
        : this.hooks.translate("voice.noiseSuppressionWebStandardDescription");
    }
    return this.hooks.nativeDesktopRuntime()
      ? this.hooks.translate("voice.noiseSuppressionRNNoiseStrongDescription")
      : this.hooks.translate("voice.noiseSuppressionWebStrongDescription");
  }

  noiseSuppressionModeIcon(mode: VoiceNoiseSuppressionMode) {
    if (mode === "off") return "noise_control_off";
    if (mode === "light") return "filter_alt";
    if (mode === "standard") return "graphic_eq";
    return "wand_stars";
  }

  async selectNoiseSuppressionMode(mode: VoiceNoiseSuppressionMode) {
    if (mode === this.noiseSuppressionMode) {
      this.hooks.closeSettingsSelectMenu();
      return;
    }
    const previous = this.noiseSuppressionMode;
    this.noiseSuppressionMode = mode;
    localStorage.setItem(noiseSuppressionModeStorageKey, mode);
    this.hooks.closeSettingsSelectMenu();
    try {
      const session = this.hooks.nativeVoiceSession();
      if (session) {
        await setNativeVoiceNoiseSuppression(session.sessionId, mode);
      } else if (!this.hooks.nativeDesktopRuntime() && this.hooks.rawLocalVoiceStream()) {
        const rawTrack = this.hooks.rawLocalVoiceStream()!.getAudioTracks()[0];
        if (rawTrack) await rawTrack.applyConstraints(this.audioConstraints());
        this.hooks.applyWebNoiseGate();
      }
      this.hooks.setError("");
    } catch (caught) {
      this.noiseSuppressionMode = previous;
      localStorage.setItem(noiseSuppressionModeStorageKey, previous);
      this.hooks.setError(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceMediaUnavailable")));
    }
  }

  clampVoicePercent(value: number, maximum: number) {
    return Math.max(0, Math.min(maximum, Math.round(Number.isFinite(value) ? value : 100)));
  }

  loadVoicePercent(key: string, fallback: number, maximum: number) {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const stored = Number(raw);
    return Number.isFinite(stored) ? this.clampVoicePercent(stored, maximum) : fallback;
  }

  loadVoiceLimit(key: string, fallback: number) {
    const stored = Number(localStorage.getItem(key));
    if (!Number.isFinite(stored) || stored < 100) return fallback;
    return Math.min(maximumVoiceGainLimitPercent, Math.round(stored));
  }

  voiceRangeProgress(value: number, maximum: number) {
    return `${Math.min(100, Math.max(0, value / Math.max(1, maximum) * 100))}%`;
  }

  loadMemberVolumePercents() {
    try {
      const value = JSON.parse(localStorage.getItem(memberVolumeStorageKey) ?? "{}") as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, volume]) => typeof volume === "number" && Number.isFinite(volume))
          .map(([key, volume]) => [key, this.clampVoicePercent(volume as number, this.memberVolumeLimitPercent)])
      ) as Record<string, number>;
    } catch {
      return {} as Record<string, number>;
    }
  }

  loadMemberMusicVolumePercents() {
    try {
      const value = JSON.parse(localStorage.getItem(memberMusicVolumeStorageKey) ?? "{}") as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, volume]) => typeof volume === "number" && Number.isFinite(volume))
          .map(([key, volume]) => [key, this.clampVoicePercent(volume as number, this.memberVolumeLimitPercent)])
      ) as Record<string, number>;
    } catch {
      return {} as Record<string, number>;
    }
  }

  loadScreenShareVolumePercents() {
    try {
      const value = JSON.parse(localStorage.getItem(screenShareVolumeStorageKey) ?? "{}") as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, volume]) => typeof volume === "number" && Number.isFinite(volume))
          .map(([key, volume]) => [key, this.clampVoicePercent(volume as number, this.memberVolumeLimitPercent)])
      ) as Record<string, number>;
    } catch {
      return {} as Record<string, number>;
    }
  }

  memberVolumeStorageId(targetMemberId: string) {
    return `${this.hooks.activeServerId() || "local"}:${targetMemberId}`;
  }

  memberVolumePercent(targetMemberId: string) {
    return this.memberVolumePercents[this.memberVolumeStorageId(targetMemberId)] ?? 100;
  }

  memberMusicVolumePercent(targetMemberId: string) {
    return this.memberMusicVolumePercents[this.memberVolumeStorageId(targetMemberId)] ?? 100;
  }

  screenShareVolumeStorageId(targetMemberId: string) {
    return `${this.hooks.activeServerId() || "local"}:${targetMemberId}`;
  }

  screenShareVolumePercent(
    targetMemberId: string,
    values: Record<string, number> = this.screenShareVolumePercents
  ) {
    return values[this.screenShareVolumeStorageId(targetMemberId)] ?? 100;
  }

  screenShareVolumeIcon(volume: number) {
    if (volume === 0) return "volume_off";
    return volume < 70 ? "volume_down" : "volume_up";
  }

  toggleScreenShareVolumeMenu(shareId: string, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const opening = this.screenShareVolumeMenuShareId !== shareId;
    this.screenShareVolumeMenuShareId = opening ? shareId : "";
    if (opening) this.hooks.closeScreenShareViewerPanel();
    this.hooks.flushAliases();
  }

  changeScreenShareVolume(targetMemberId: string, event: Event) {
    const volume = this.clampVoicePercent(
      Number((event.currentTarget as HTMLInputElement).value),
      this.memberVolumeLimitPercent
    );
    this.screenShareVolumePercents = {
      ...this.screenShareVolumePercents,
      [this.screenShareVolumeStorageId(targetMemberId)]: volume
    };
    localStorage.setItem(screenShareVolumeStorageKey, JSON.stringify(this.screenShareVolumePercents));
    this.applyScreenShareVolume(targetMemberId);
    this.hooks.flushAliases();
  }

  resetScreenShareVolume(targetMemberId: string) {
    const next = { ...this.screenShareVolumePercents };
    delete next[this.screenShareVolumeStorageId(targetMemberId)];
    this.screenShareVolumePercents = next;
    localStorage.setItem(screenShareVolumeStorageKey, JSON.stringify(this.screenShareVolumePercents));
    this.applyScreenShareVolume(targetMemberId);
    this.hooks.flushAliases();
  }

  changeMicrophoneGain(event: Event) {
    this.microphoneGainPercent = this.clampVoicePercent(
      Number((event.currentTarget as HTMLInputElement).value),
      this.microphoneGainLimitPercent
    );
    localStorage.setItem(microphoneGainStorageKey, String(this.microphoneGainPercent));
    this.hooks.voiceSession().applyMicrophoneGain();
    this.applyWebMicrophoneTestLevels();
    this.syncNativeMicrophoneTestLevels();
    this.syncNativeVoiceLevels();
    this.hooks.flushAliases();
  }

  openMicrophonePopover() {
    if (this.microphonePopoverCloseTimer) {
      window.clearTimeout(this.microphonePopoverCloseTimer);
      this.microphonePopoverCloseTimer = undefined;
    }
    this.microphonePopoverOpen = true;
    this.hooks.flushAliases();
  }

  scheduleMicrophonePopoverClose() {
    if (this.microphonePopoverCloseTimer) window.clearTimeout(this.microphonePopoverCloseTimer);
    this.hooks.clearCopiedInviteTimer();
    this.microphonePopoverCloseTimer = window.setTimeout(() => {
      this.microphonePopoverOpen = false;
      this.microphonePopoverCloseTimer = undefined;
      this.hooks.flushAliases();
    }, 320);
  }

  changeOutputVolume(event: Event) {
    this.outputVolumePercent = this.clampVoicePercent(Number((event.currentTarget as HTMLInputElement).value), 100);
    localStorage.setItem(outputVolumeStorageKey, String(this.outputVolumePercent));
    for (const audio of this.hooks.activeUISounds()) {
      audio.volume = Math.min(1, (this.outputVolumePercent / 100) * uiSoundVolumeScale);
    }
    this.hooks.applySoundboardAudioGains();
    this.applyRemoteAudioState();
    this.applyWebMicrophoneTestLevels();
    this.syncNativeMicrophoneTestLevels();
    this.syncNativeVoiceLevels();
    this.hooks.flushAliases();
  }

  changeMemberVolume(targetMemberId: string, event: Event) {
    const volume = this.clampVoicePercent(
      Number((event.currentTarget as HTMLInputElement).value),
      this.memberVolumeLimitPercent
    );
    this.voiceParticipantMenuVolumePercent = volume;
    this.memberVolumePercents = {
      ...this.memberVolumePercents,
      [this.memberVolumeStorageId(targetMemberId)]: volume
    };
    localStorage.setItem(memberVolumeStorageKey, JSON.stringify(this.memberVolumePercents));
    this.applyMemberVolume(targetMemberId);
    this.hooks.flushAliases();
  }

  changeMemberMusicVolume(targetMemberId: string, event: Event) {
    const volume = this.clampVoicePercent(
      Number((event.currentTarget as HTMLInputElement).value),
      this.memberVolumeLimitPercent
    );
    this.voiceParticipantMenuMusicVolumePercent = volume;
    this.memberMusicVolumePercents = {
      ...this.memberMusicVolumePercents,
      [this.memberVolumeStorageId(targetMemberId)]: volume
    };
    localStorage.setItem(memberMusicVolumeStorageKey, JSON.stringify(this.memberMusicVolumePercents));
    this.applyMemberMusicVolume(targetMemberId);
    this.hooks.flushAliases();
  }

  changeMicrophoneGainLimit(value: number) {
    this.microphoneGainLimitPercent = this.normalizeVoiceLimit(value, defaultMicrophoneGainLimitPercent);
    localStorage.setItem(microphoneGainLimitStorageKey, String(this.microphoneGainLimitPercent));
    if (this.microphoneGainPercent <= this.microphoneGainLimitPercent) {
      this.hooks.flushAliases();
      return;
    }
    this.microphoneGainPercent = this.microphoneGainLimitPercent;
    localStorage.setItem(microphoneGainStorageKey, String(this.microphoneGainPercent));
    this.hooks.voiceSession().applyMicrophoneGain();
    this.applyWebMicrophoneTestLevels();
    this.syncNativeMicrophoneTestLevels();
    this.syncNativeVoiceLevels();
    this.hooks.flushAliases();
  }

  changeMemberVolumeLimit(value: number) {
    this.memberVolumeLimitPercent = this.normalizeVoiceLimit(value, defaultMemberVolumeLimitPercent);
    localStorage.setItem(memberVolumeLimitStorageKey, String(this.memberVolumeLimitPercent));
    this.memberVolumePercents = this.clampStoredVolumes(this.memberVolumePercents, this.memberVolumeLimitPercent);
    this.memberMusicVolumePercents = this.clampStoredVolumes(this.memberMusicVolumePercents, this.memberVolumeLimitPercent);
    this.screenShareVolumePercents = this.clampStoredVolumes(this.screenShareVolumePercents, this.memberVolumeLimitPercent);
    this.voiceParticipantMenuVolumePercent = Math.min(
      this.voiceParticipantMenuVolumePercent,
      this.memberVolumeLimitPercent
    );
    localStorage.setItem(memberVolumeStorageKey, JSON.stringify(this.memberVolumePercents));
    localStorage.setItem(memberMusicVolumeStorageKey, JSON.stringify(this.memberMusicVolumePercents));
    localStorage.setItem(screenShareVolumeStorageKey, JSON.stringify(this.screenShareVolumePercents));
    const memberId = this.hooks.memberId();
    for (const state of this.hooks.voiceState().voiceStates) {
      if (state.member_id !== memberId) {
        this.applyMemberVolume(state.member_id);
        this.applyMemberMusicVolume(state.member_id);
      }
    }
    for (const share of this.hooks.screenShareSessions()) this.applyScreenShareVolume(share.owner_member_id);
    this.hooks.flushAliases();
  }

  normalizeVoiceLimit(value: number, fallback: number) {
    return Number.isFinite(value)
      ? Math.max(100, Math.min(maximumVoiceGainLimitPercent, Math.round(value)))
      : fallback;
  }

  clampStoredVolumes(volumes: Record<string, number>, maximum: number) {
    return Object.fromEntries(
      Object.entries(volumes).map(([key, volume]) => [key, this.clampVoicePercent(volume, maximum)])
    );
  }

  applyWebMicrophoneTestLevels() {
    const context = this.microphoneTestAudioContext;
    if (!context) return;
    this.microphoneTestInputGain?.gain.setTargetAtTime(this.microphoneGainPercent / 100, context.currentTime, 0.01);
    this.microphoneTestOutputGain?.gain.setTargetAtTime(this.outputVolumePercent / 100, context.currentTime, 0.01);
  }

  syncNativeMicrophoneTestLevels() {
    const sessionId = this.nativeMicrophoneTestSessionId;
    if (!sessionId) return;
    void setNativeMicrophoneTestLevels(sessionId, this.microphoneGainPercent, this.outputVolumePercent).catch((caught) => {
      if (this.nativeMicrophoneTestSessionId !== sessionId) return;
      console.warn("[EchoVoice] update native microphone test levels failed", caught);
    });
  }

  resetMemberVolume(targetMemberId: string) {
    const next = { ...this.memberVolumePercents };
    delete next[this.memberVolumeStorageId(targetMemberId)];
    this.memberVolumePercents = next;
    this.voiceParticipantMenuVolumePercent = 100;
    localStorage.setItem(memberVolumeStorageKey, JSON.stringify(this.memberVolumePercents));
    this.applyMemberVolume(targetMemberId);
    this.hooks.flushAliases();
  }

  resetMemberMusicVolume(targetMemberId: string) {
    const next = { ...this.memberMusicVolumePercents };
    delete next[this.memberVolumeStorageId(targetMemberId)];
    this.memberMusicVolumePercents = next;
    this.voiceParticipantMenuMusicVolumePercent = 100;
    localStorage.setItem(memberMusicVolumeStorageKey, JSON.stringify(this.memberMusicVolumePercents));
    this.applyMemberMusicVolume(targetMemberId);
    this.hooks.flushAliases();
  }

  syncNativeVoiceLevels() {
    const session = this.hooks.nativeVoiceSession();
    if (!session) return;
    void setNativeVoiceLevels(
      session.sessionId,
      this.microphoneGainPercent,
      this.outputVolumePercent
    ).catch((caught) => {
      if (this.hooks.nativeVoiceCommandWasStaleOrMissing(session.sessionId, caught)) return;
      this.hooks.setError(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceMediaUnavailable")));
    });
  }

  saveSelectedAudioInputDeviceId(deviceId: string) {
    if (deviceId) {
      localStorage.setItem(audioInputDeviceStorageKey, deviceId);
      return;
    }
    localStorage.removeItem(audioInputDeviceStorageKey);
  }

  saveSelectedAudioOutputDeviceId(deviceId: string) {
    if (deviceId) {
      localStorage.setItem(audioOutputDeviceStorageKey, deviceId);
      return;
    }
    localStorage.removeItem(audioOutputDeviceStorageKey);
  }

  nativeAudioDeviceOption(device: NativeAudioDevice): AudioDeviceOption {
    return {
      deviceId: device.id,
      label: device.isDefault
        ? this.hooks.translate("voice.currentSystemDefaultDevice", { name: device.name })
        : device.name,
      isDefault: device.isDefault
    };
  }

  initializeWebPermissions() {
    if (this.hooks.nativeDesktopRuntime() || this.hooks.screenSharePopoutMode()) return Promise.resolve();
    if (!this.webPermissionInitialization) {
      this.webPermissionInitialization = this.checkAndRequestWebPermissions();
    }
    return this.webPermissionInitialization;
  }

  async checkAndRequestWebPermissions() {
    let microphonePermission: PermissionState | "unsupported" = "unsupported";
    try {
      if (navigator.permissions?.query) {
        const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
        microphonePermission = status.state;
      }
    } catch {
      microphonePermission = "unsupported";
    }

    if (microphonePermission === "denied") {
      await this.refreshAudioInputDevices(false, false);
      this.voiceInputUnavailable = true;
      this.hooks.flushAliases();
      return;
    }
    await this.refreshAudioInputDevices(true, false);
  }

  async refreshAudioInputDevices(requestPermission = false, reportError = true) {
    if (this.hooks.nativeDesktopRuntime()) {
      this.audioInputDevicesLoading = true;
      try {
        const devices = await listNativeAudioDevices();
        this.audioInputDevices = devices.inputs
          .map((device) => this.nativeAudioDeviceOption(device))
          .sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)));
        this.audioOutputDevices = devices.outputs
          .map((device) => this.nativeAudioDeviceOption(device))
          .sort((left, right) => Number(Boolean(right.isDefault)) - Number(Boolean(left.isDefault)));
        if (this.selectedAudioInputDeviceId && !this.audioInputDevices.some((device) => device.deviceId === this.selectedAudioInputDeviceId)) {
          this.selectedAudioInputDeviceId = "";
          this.saveSelectedAudioInputDeviceId("");
        }
        if (this.selectedAudioOutputDeviceId && !this.audioOutputDevices.some((device) => device.deviceId === this.selectedAudioOutputDeviceId)) {
          this.selectedAudioOutputDeviceId = "";
          this.saveSelectedAudioOutputDeviceId("");
        }
        const nativeVoiceStatus = this.hooks.nativeVoiceStatus();
        this.voiceInputUnavailable = nativeVoiceStatus
          ? nativeVoiceStatus.phase === "failed" || !nativeVoiceStatus.microphoneAvailable
          : false;
      } catch (caught) {
        if (reportError) this.hooks.setError(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceMediaUnavailable")));
      } finally {
        this.audioInputDevicesLoading = false;
      }
      this.hooks.flushAliases();
      return;
    }
    if (!navigator.mediaDevices?.enumerateDevices) {
      this.audioInputDevices = [];
      this.audioOutputDevices = [];
      this.voiceInputUnavailable = true;
      this.hooks.flushAliases();
      return;
    }
    this.audioInputDevicesLoading = true;
    try {
      if (requestPermission && navigator.mediaDevices.getUserMedia) {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        probe.getTracks().forEach((track) => track.stop());
      }
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.audioInputDevices = devices
        .filter((device) => device.kind === "audioinput" && device.deviceId !== "default")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || this.hooks.translate("voice.microphoneUnnamed", { index: index + 1 })
        }));
      this.audioOutputDevices = devices
        .filter((device) => device.kind === "audiooutput" && device.deviceId !== "default")
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || this.hooks.translate("voice.outputUnnamed", { index: index + 1 })
        }));
      if (
        this.selectedAudioInputDeviceId &&
        !this.audioInputDevices.some((device) => device.deviceId === this.selectedAudioInputDeviceId)
      ) {
        this.selectedAudioInputDeviceId = "";
        this.saveSelectedAudioInputDeviceId("");
      }
      if (
        this.selectedAudioOutputDeviceId &&
        !this.audioOutputDevices.some((device) => device.deviceId === this.selectedAudioOutputDeviceId)
      ) {
        this.selectedAudioOutputDeviceId = "";
        this.saveSelectedAudioOutputDeviceId("");
      }
    } catch {
      this.voiceInputUnavailable = true;
      if (reportError) this.hooks.setError(this.hooks.translate("error.voiceMediaUnavailable"));
    } finally {
      this.audioInputDevicesLoading = false;
    }
    this.hooks.flushAliases();
  }

  async selectAudioInputDevice(deviceId: string) {
    this.hooks.closeSettingsSelectMenu();
    if (this.selectedAudioInputDeviceId === deviceId) return;
    if (this.microphoneTestActive) await this.stopMicrophoneTest();
    this.selectedAudioInputDeviceId = deviceId;
    this.saveSelectedAudioInputDeviceId(this.selectedAudioInputDeviceId);
    if (this.hooks.nativeDesktopRuntime() && this.hooks.currentVoiceState()) {
      await this.restartNativeVoiceForDeviceChange();
    } else if (this.hooks.currentVoiceState() && !this.micMuted && !this.audioDeafened) {
      await this.hooks.restartVoiceInput();
    }
    this.hooks.flushAliases();
  }

  async selectAudioOutputDevice(deviceId: string) {
    this.hooks.closeSettingsSelectMenu();
    if (this.selectedAudioOutputDeviceId === deviceId) return;
    if (this.microphoneTestActive) await this.stopMicrophoneTest();
    this.selectedAudioOutputDeviceId = deviceId;
    this.saveSelectedAudioOutputDeviceId(this.selectedAudioOutputDeviceId);
    if (this.hooks.nativeDesktopRuntime() && this.hooks.currentVoiceState()) {
      await this.restartNativeVoiceForDeviceChange();
      return;
    }
    await this.applyAudioOutputDevice();
    this.hooks.flushAliases();
  }

  async restartNativeVoiceForDeviceChange() {
    const state = this.hooks.currentVoiceState();
    if (!this.hooks.nativeDesktopRuntime() || !state || this.hooks.voiceActionBusy()) return;
    this.hooks.setVoiceActionBusy(true);
    try {
      if (this.microphoneTestActive || this.nativeMicrophoneTestSessionId) await this.stopMicrophoneTest();
      this.hooks.stopCurrentNativeVoiceSession();
      await this.hooks.startDesktopNativeVoiceSession(state.channel_id);
      this.hooks.setError("");
    } catch (caught) {
      this.hooks.voiceSession().setConnectionStatus("failed");
      this.hooks.setError(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceMediaUnavailable")));
    } finally {
      this.hooks.setVoiceActionBusy(false);
    }
  }

  selectedAudioInputLabel() {
    if (!this.selectedAudioInputDeviceId) {
      return this.hooks.nativeDesktopRuntime() ? this.hooks.translate("voice.systemDefaultMicrophone") : this.hooks.translate("voice.defaultMicrophone");
    }
    const selected = this.audioInputDevices.find((device) => device.deviceId === this.selectedAudioInputDeviceId);
    return selected?.label ?? this.hooks.translate("voice.defaultMicrophone");
  }

  selectedAudioOutputLabel() {
    if (!this.selectedAudioOutputDeviceId) return this.hooks.translate("voice.systemDefaultOutput");
    return this.audioOutputDevices.find((device) => device.deviceId === this.selectedAudioOutputDeviceId)?.label
      ?? this.hooks.translate("voice.systemDefaultOutput");
  }

  voiceInputStatusLabel() {
    if (this.hooks.nativeDesktopRuntime()) {
      const nativeVoiceStatus = this.hooks.nativeVoiceStatus();
      if (nativeVoiceStatus && !nativeVoiceStatus.microphoneAvailable) return this.hooks.translate("voice.microphoneListeningOnly");
      if (nativeVoiceStatus?.phase === "running") return this.hooks.translate("voice.nativeMicrophoneReady");
      if (nativeVoiceStatus?.lastError || this.voiceInputUnavailable) return this.hooks.translate("voice.microphoneListeningOnly");
      return this.hooks.translate("voice.nativeMicrophoneIdle");
    }
    if (this.voiceInputUnavailable) return this.hooks.translate("voice.microphoneListeningOnly");
    if (!this.hooks.localVoiceStream()) return this.hooks.translate("voice.microphoneUnavailable");
    return this.hooks.translate("voice.microphoneReady");
  }

  // ── Mute / deafen / microphone enablement ────────────────────────────────
  async toggleMicMuted() {
    const state = this.hooks.currentVoiceState();
    if (state?.mode === "listener") {
      await this.hooks.showAppAlert(this.hooks.translate("voice.listenOnlyMicrophoneBlocked"), { title: this.hooks.translate("voice.listenOnly") });
      return;
    }
    if (this.audioDeafened || state?.server_muted || state?.server_deafened) return;
    if (this.micMuted || this.voiceInputUnavailable) {
      await this.enableMicrophoneFromUserAction();
      return;
    }
    this.hooks.clearNativeMicrophoneRecovery();
    this.micMuted = true;
    localStorage.setItem(microphoneMutedStorageKey, "true");
    this.playUISound("audio-off");
    if (this.micMuted) {
      this.isSpeaking = false;
    }
    this.applyLocalAudioState();
    this.mergeCurrentVoiceFlags();
    void this.syncCurrentVoiceState();
    this.hooks.flushAliases();
  }

  toggleAudioDeafened() {
    const state = this.hooks.currentVoiceState();
    if (state?.server_deafened) return;
    this.audioDeafened = !this.audioDeafened;
    this.playUISound(this.audioDeafened ? "audio-off" : "audio-on");
    if (this.audioDeafened) {
      this.micMuted = true;
    }
    if (this.audioDeafened || this.micMuted) {
      this.isSpeaking = false;
    }
    this.applyLocalAudioState();
    this.applyRemoteAudioState();
    this.mergeCurrentVoiceFlags();
    void this.syncCurrentVoiceState();
    this.hooks.flushAliases();
  }

  async enableMicrophoneFromUserAction() {
    const state = this.hooks.currentVoiceState();
    if (state?.mode === "listener") {
      await this.hooks.showAppAlert(this.hooks.translate("voice.listenOnlyMicrophoneBlocked"), { title: this.hooks.translate("voice.listenOnly") });
      return;
    }
    if (state?.server_muted || state?.server_deafened) return;
    if (!state) {
      this.micMuted = false;
      this.voiceInputUnavailable = false;
      localStorage.setItem(microphoneMutedStorageKey, "false");
      this.playUISound("audio-on");
      this.hooks.flushAliases();
      return;
    }
    if (this.hooks.nativeDesktopRuntime()) {
      this.hooks.clearNativeMicrophoneRecovery();
      if (this.microphoneTestActive || this.nativeMicrophoneTestSessionId) await this.stopMicrophoneTest();
      if (!this.hooks.nativeVoiceSession() && state.channel_id) {
        await this.hooks.startVoiceSession(state.channel_id);
      }
      const nativeVoiceSession = this.hooks.nativeVoiceSession();
      if (!nativeVoiceSession) {
        this.voiceInputUnavailable = true;
        this.micMuted = true;
        await this.hooks.showAppAlert(
          this.hooks.nativeVoiceStatus()?.microphoneError || this.hooks.translate("error.voiceMediaUnavailable"),
          { title: this.hooks.translate("voice.microphoneUnavailable") }
        );
        this.hooks.flushAliases();
        return;
      }
      try {
        const sessionId = nativeVoiceSession.sessionId;
        const status = await loadNativeVoiceStatus(sessionId);
        this.hooks.applyNativeVoiceStatus(status);
        if (!status.microphoneAvailable) {
          await this.hooks.recoverNativeMicrophone(sessionId);
        } else {
          await setNativeVoiceState(sessionId, false, false);
        }
        this.micMuted = false;
        localStorage.setItem(microphoneMutedStorageKey, "false");
        this.playUISound("audio-on");
        this.voiceInputUnavailable = false;
        this.mergeCurrentVoiceFlags();
        void this.syncCurrentVoiceState();
        this.hooks.setError("");
      } catch (caught) {
        this.micMuted = true;
        this.voiceInputUnavailable = true;
        this.isSpeaking = false;
        this.mergeCurrentVoiceFlags();
        void this.syncCurrentVoiceState();
        await this.hooks.showAppAlert(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceMediaUnavailable")), {
          title: this.hooks.translate("voice.microphoneUnavailable")
        });
      }
      this.hooks.flushAliases();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.voiceInputUnavailable = true;
      this.micMuted = true;
      this.isSpeaking = false;
      await this.hooks.showAppAlert(this.hooks.translate("error.voiceMediaUnavailable"), { title: this.hooks.translate("voice.microphoneUnavailable") });
      this.mergeCurrentVoiceFlags();
      void this.syncCurrentVoiceState();
      this.hooks.flushAliases();
      return;
    }
    try {
      const stream = await this.hooks.openLocalVoiceStream();
      await this.hooks.attachLocalVoiceStream(stream);
      this.micMuted = false;
      localStorage.setItem(microphoneMutedStorageKey, "false");
      this.playUISound("audio-on");
      this.voiceInputUnavailable = false;
      this.applyLocalAudioState();
      this.mergeCurrentVoiceFlags();
      void this.syncCurrentVoiceState();
      this.hooks.setError("");
    } catch {
      this.hooks.stopLocalVoiceInput();
      this.voiceInputUnavailable = true;
      this.micMuted = true;
      this.isSpeaking = false;
      await this.hooks.replaceOutgoingAudioTrack(null);
      this.mergeCurrentVoiceFlags();
      void this.syncCurrentVoiceState();
      await this.hooks.showAppAlert(this.hooks.translate("error.voiceMediaUnavailable"), { title: this.hooks.translate("voice.microphoneUnavailable") });
    }
    this.hooks.flushAliases();
  }

  applyLocalVoiceFlags(state: VoiceState): VoiceState {
    const listenOnly = state.mode === "listener";
    return {
      ...state,
      mic_muted: listenOnly || this.micMuted || this.audioDeafened || this.voiceInputUnavailable || state.server_muted || state.server_deafened,
      audio_deafened: this.audioDeafened || state.server_deafened,
      is_speaking: !listenOnly && this.isSpeaking && !this.micMuted && !this.audioDeafened && !this.voiceInputUnavailable && !state.server_muted && !state.server_deafened
    };
  }

  mergeCurrentVoiceFlags() {
    const state = this.hooks.currentVoiceState();
    if (!state) return;
    this.hooks.voiceState().mergeConnectedVoiceState(this.applyLocalVoiceFlags(state));
    this.hooks.queueCurrentVoiceSpeakingState();
  }

  async syncCurrentVoiceState() {
    const voiceState = this.hooks.voiceState();
    if (voiceState.syncInFlight) {
      voiceState.syncQueued = true;
      return;
    }
    voiceState.syncInFlight = true;
    try {
      do {
        voiceState.syncQueued = false;
        const context = voiceState.voiceConnectionContext;
        const state = context?.state;
        if (!context || !state || !context.syncSupported) return;
        try {
          const updated = await updateVoiceState(context.baseUrl, context.sessionToken, {
            mic_muted: state.mode === "listener" || this.micMuted || this.audioDeafened || this.voiceInputUnavailable || state.server_muted || state.server_deafened,
            audio_deafened: this.audioDeafened || state.server_deafened,
            is_speaking: state.mode !== "listener" && this.isSpeaking && !this.micMuted && !this.audioDeafened && !this.voiceInputUnavailable && !state.server_muted && !state.server_deafened
          });
          if (voiceState.voiceConnectionContext?.serverId === context.serverId) voiceState.mergeConnectedVoiceState(updated);
        } catch (caught) {
          if (this.isHTTPStatus(caught, 404) || this.isHTTPStatus(caught, 405)) {
            if (voiceState.voiceConnectionContext?.serverId === context.serverId) {
              voiceState.voiceConnectionContext = { ...voiceState.voiceConnectionContext, syncSupported: false };
            }
            return;
          }
          this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.voiceStateUpdateFailed"));
        }
      } while (voiceState.syncQueued);
    } finally {
      voiceState.syncInFlight = false;
    }
  }

  applyManagedVoiceConstraints(state: VoiceState) {
    let changed = false;
    if ((state.server_muted || state.server_deafened) && !this.micMuted) {
      this.micMuted = true;
      this.isSpeaking = false;
      changed = true;
    }
    if (state.server_deafened && !this.audioDeafened) {
      this.audioDeafened = true;
      changed = true;
    }
    if (!changed) return;
    this.applyLocalAudioState();
    this.applyRemoteAudioState();
    this.hooks.flushAliases();
  }

  // ── Voice status / latency helpers ────────────────────────────────────────
  isHTTPStatus(caught: unknown, status: number) {
    return caught instanceof Error && (caught as Error & { status?: number }).status === status;
  }

  voiceStatusLabel() {
    if (this.hooks.currentVoiceState()?.mode === "listener") return this.hooks.translate("voice.listenOnly");
    const voiceSession = this.hooks.voiceSession();
    if (voiceSession.connectionStatus === "connecting") return this.hooks.translate("voice.connecting");
    if (voiceSession.connectionStatus === "failed") return this.hooks.translate("voice.failed");
    if (voiceSession.peerCount > 0) return this.hooks.translate("voice.connectedPeers", { count: voiceSession.peerCount });
    return this.hooks.translate("voice.connected");
  }

  computeVoiceLatencyQuality(latencyMS: number | null): VoiceLatencyQuality {
    if (latencyMS == null) return "unknown";
    if (latencyMS < 80) return "good";
    if (latencyMS < 180) return "fair";
    return "poor";
  }

  voiceLatencyIconForQuality(quality: VoiceLatencyQuality) {
    if (quality === "good") return "wifi";
    if (quality === "fair") return "network_wifi_2_bar";
    if (quality === "poor") return "network_wifi_1_bar";
    return "wifi_find";
  }

  voiceLatencyQualityLabelForQuality(quality: VoiceLatencyQuality) {
    if (quality === "good") return this.hooks.translate("voice.networkGood");
    if (quality === "fair") return this.hooks.translate("voice.networkFair");
    if (quality === "poor") return this.hooks.translate("voice.networkPoor");
    return this.hooks.translate("voice.networkUnknown");
  }

  formatVoiceLatencyMeasuredAt(measuredAtMS: number) {
    if (!measuredAtMS) return this.hooks.translate("voice.latencyUnknown");
    return new Intl.DateTimeFormat(this.hooks.languageId(), {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(new Date(measuredAtMS));
  }

  toggleVoiceNetworkDetails() {
    const voiceSession = this.hooks.voiceSession();
    voiceSession.networkDetailsOpen = !voiceSession.networkDetailsOpen;
    if (voiceSession.networkDetailsOpen) void this.measureVoiceLatency(true);
    this.hooks.flushAliases();
  }

  closeVoiceNetworkDetails() {
    this.hooks.voiceSession().networkDetailsOpen = false;
    this.hooks.flushAliases();
  }

  measureVoiceLatency(includeRTCDetails = false) {
    return this.hooks.voiceSession().measureLatency(includeRTCDetails);
  }

  formatKbps(value: number | null) {
    return value == null ? "-" : `${value} kbps`;
  }

  voiceStateLabel(state: VoiceState | undefined) {
    if (!state) return "";
    if (state.server_deafened) return this.hooks.translate("voice.serverDeafened");
    if (state.server_muted) return this.hooks.translate("voice.serverMuted");
    if (state.audio_deafened) return this.hooks.translate("voice.deafened");
    if (state.mic_muted) return this.hooks.translate("voice.muted");
    if (this.isVoiceStateSpeaking(state)) return this.hooks.translate("voice.speaking");
    return this.hooks.translate("voice.speakingReady");
  }

  isVoiceStateSpeaking(state: VoiceState | undefined) {
    const voiceState = this.hooks.voiceState();
    const visibleSpeakingChannelId = voiceState.voiceConnectionContext?.serverId === this.hooks.activeServerId()
      ? voiceState.voiceConnectionContext.channelId
      : "";
    return Boolean(
      visibleSpeakingChannelId &&
      state?.channel_id === visibleSpeakingChannelId &&
      state?.is_speaking &&
      !state.mic_muted &&
      !state.audio_deafened &&
      !state.server_muted &&
      !state.server_deafened
    );
  }

  hasVoiceRestriction(state: VoiceState | undefined) {
    return Boolean(state?.mic_muted || state?.audio_deafened || state?.server_muted || state?.server_deafened);
  }

  voiceRestrictionIcon(state: VoiceState | undefined) {
    if (state?.server_deafened || state?.audio_deafened) return "headset_off";
    if (state?.server_muted || state?.mic_muted) return "mic_off";
    return "";
  }

  // ── Audio constraints & local speaking ────────────────────────────────────
  audioConstraints(deviceId = this.selectedAudioInputDeviceId): MediaTrackConstraints {
    return {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      channelCount: { ideal: 1 },
      sampleRate: { ideal: 48000 },
      latency: { ideal: 0.02 },
      echoCancellation: true,
      noiseSuppression: this.noiseSuppressionMode !== "off",
      // Let the capture backend lower an over-driven microphone before it clips.
      // EchoVoice's user gain and limiter still run afterwards when extra gain is requested.
      autoGainControl: true
    };
  }

  setLocalSpeaking(next: boolean) {
    const normalized = next && !this.micMuted && !this.audioDeafened && !this.voiceInputUnavailable;
    if (this.isSpeaking === normalized) return;
    this.isSpeaking = normalized;
    this.mergeCurrentVoiceFlags();
    this.hooks.flushAliases();
  }

  // ── Audio output routing & UI sounds ──────────────────────────────────────
  async setAudioElementSink(audio: HTMLAudioElement) {
    const setSinkId = (audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
    if (!setSinkId) return;
    await setSinkId.call(audio, this.selectedAudioOutputDeviceId || "");
  }

  async applyAudioOutputDevice() {
    if (this.hooks.nativeDesktopRuntime()) return;
    try {
      const remoteVoiceMixer = this.hooks.remoteVoiceMixer();
      const context = remoteVoiceMixer.context as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
      if (context?.setSinkId) {
        await context.setSinkId(this.selectedAudioOutputDeviceId || "");
      }
      await this.hooks.accompanimentSyncOutputDevice(this.selectedAudioOutputDeviceId || "");
      const soundboardContext = this.hooks.soundboardAudioContext();
      if (soundboardContext?.setSinkId) {
        await soundboardContext.setSinkId(this.selectedAudioOutputDeviceId || "");
      }
      await Promise.allSettled(
        [
          ...remoteVoiceMixer.elementMap.values(),
          ...this.hooks.activeUISounds(),
          ...this.hooks.activeSoundboardAudio()
        ].map((audio) => this.setAudioElementSink(audio as HTMLAudioElement))
      );
      this.hooks.setError("");
    } catch (caught) {
      this.hooks.setError(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceOutputUnavailable")));
    }
  }

  playUISound(name: UISoundName) {
    const audio = new Audio(uiSoundURLs[name]);
    audio.volume = Math.min(1, (this.outputVolumePercent / 100) * uiSoundVolumeScale);
    this.hooks.activeUISounds().add(audio);
    const release = () => this.hooks.activeUISounds().delete(audio);
    audio.addEventListener("ended", release, { once: true });
    audio.addEventListener("error", release, { once: true });
    void this.setAudioElementSink(audio)
      .catch(() => undefined)
      .then(() => audio.play())
      .catch((caught) => {
        release();
        console.warn("[EchoVoice] UI sound playback failed", { name, error: caught });
      });
  }

  // ── Microphone & headphone tests ──────────────────────────────────────────
  async runMicrophoneTest() {
    if (this.microphoneTestBusy) return;
    if (this.microphoneTestActive) {
      this.microphoneTestBusy = true;
      try {
        await this.stopMicrophoneTest();
      } finally {
        this.microphoneTestBusy = false;
      }
      return;
    }

    const generation = ++this.microphoneTestGeneration;
    this.microphoneTestBusy = true;
    this.microphoneTestLevel = 0;
    this.hooks.setError("");
    try {
      if (this.hooks.nativeDesktopRuntime()) {
        const status = await startNativeMicrophoneTest(
          this.selectedAudioInputDeviceId,
          this.selectedAudioOutputDeviceId,
          this.microphoneGainPercent,
          this.outputVolumePercent
        );
        if (generation !== this.microphoneTestGeneration || !this.hooks.appSettingsOpen()) {
          await stopNativeMicrophoneTest(status.sessionId);
          return;
        }
        this.nativeMicrophoneTestSessionId = status.sessionId;
        this.microphoneTestLevel = status.inputLevel;
        this.microphoneTestActive = status.active;
        this.startNativeMicrophoneTestStatusPolling();
        this.hooks.flushAliases();
        return;
      }
      await this.startWebMicrophoneTest(generation);
    } catch (caught) {
      await this.stopMicrophoneTest();
      this.hooks.setError(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceMediaUnavailable")));
    } finally {
      this.microphoneTestBusy = false;
      this.hooks.flushAliases();
    }
  }

  async openMicrophoneTestStream() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(this.hooks.translate("error.voiceMediaUnavailable"));
    const constraints = (deviceId: string): MediaTrackConstraints => ({
      ...this.audioConstraints(deviceId),
      echoCancellation: false
    });
    if (!this.selectedAudioInputDeviceId) {
      return navigator.mediaDevices.getUserMedia({ audio: constraints(""), video: false });
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: constraints(this.selectedAudioInputDeviceId),
        video: false
      });
    } catch (selectedDeviceError) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints(""), video: false });
        this.selectedAudioInputDeviceId = "";
        this.saveSelectedAudioInputDeviceId("");
        return stream;
      } catch {
        throw selectedDeviceError;
      }
    }
  }

  async startWebMicrophoneTest(generation: number) {
    const stream = await this.openMicrophoneTestStream();
    if (generation !== this.microphoneTestGeneration || !this.hooks.appSettingsOpen()) {
      this.hooks.stopMediaStream(stream);
      return;
    }
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) {
      this.hooks.stopMediaStream(stream);
      throw new Error(this.hooks.translate("error.voiceMediaUnavailable"));
    }
    const context = new AudioContextCtor({ latencyHint: "interactive" }) as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    try {
      if (this.selectedAudioOutputDeviceId && context.setSinkId) {
        await context.setSinkId(this.selectedAudioOutputDeviceId);
      }
      const source = context.createMediaStreamSource(stream);
      const inputGain = context.createGain();
      const analyser = context.createAnalyser();
      const outputGain = context.createGain();
      inputGain.gain.value = this.microphoneGainPercent / 100;
      outputGain.gain.value = this.outputVolumePercent / 100;
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.35;
      source.connect(inputGain).connect(analyser).connect(outputGain).connect(context.destination);
      await context.resume();
      if (generation !== this.microphoneTestGeneration || !this.hooks.appSettingsOpen()) {
        source.disconnect();
        inputGain.disconnect();
        analyser.disconnect();
        outputGain.disconnect();
        this.hooks.stopMediaStream(stream);
        await context.close();
        return;
      }
      this.microphoneTestStream = stream;
      this.microphoneTestAudioContext = context;
      this.microphoneTestSource = source;
      this.microphoneTestInputGain = inputGain;
      this.microphoneTestAnalyser = analyser;
      this.microphoneTestOutputGain = outputGain;
      this.microphoneTestActive = true;
      this.updateWebMicrophoneTestLevel(generation, new Float32Array(analyser.fftSize));
    } catch (caught) {
      this.hooks.stopMediaStream(stream);
      await context.close().catch(() => undefined);
      throw caught;
    }
  }

  updateWebMicrophoneTestLevel(generation: number, samples: Float32Array) {
    if (!this.microphoneTestActive || generation !== this.microphoneTestGeneration || !this.microphoneTestAnalyser) return;
    this.microphoneTestAnalyser.getFloatTimeDomainData(samples);
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    this.microphoneTestLevel = Math.max(this.microphoneTestLevel * 0.72, Math.min(1, peak));
    this.microphoneTestAnimationFrame = window.requestAnimationFrame(() => this.updateWebMicrophoneTestLevel(generation, samples));
  }

  startNativeMicrophoneTestStatusPolling() {
    if (this.nativeMicrophoneTestStatusTimer) window.clearInterval(this.nativeMicrophoneTestStatusTimer);
    this.nativeMicrophoneTestStatusTimer = window.setInterval(() => void this.refreshNativeMicrophoneTestStatus(), 80);
  }

  async refreshNativeMicrophoneTestStatus() {
    const sessionId = this.nativeMicrophoneTestSessionId;
    if (!sessionId || this.nativeMicrophoneTestStatusLoading) return;
    this.nativeMicrophoneTestStatusLoading = true;
    try {
      const status = await loadNativeMicrophoneTestStatus(sessionId);
      if (this.nativeMicrophoneTestSessionId !== sessionId) return;
      this.microphoneTestLevel = status.inputLevel;
      this.microphoneTestActive = status.active;
      if (status.lastError) throw new Error(status.lastError);
      if (!status.active) await this.stopMicrophoneTest();
    } catch (caught) {
      if (this.nativeMicrophoneTestSessionId !== sessionId) return;
      await this.stopMicrophoneTest();
      this.hooks.setError(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceMediaUnavailable")));
    } finally {
      this.nativeMicrophoneTestStatusLoading = false;
    }
  }

  async stopMicrophoneTest() {
    this.microphoneTestGeneration += 1;
    this.microphoneTestActive = false;
    if (this.microphoneTestAnimationFrame) window.cancelAnimationFrame(this.microphoneTestAnimationFrame);
    this.microphoneTestAnimationFrame = undefined;
    if (this.nativeMicrophoneTestStatusTimer) window.clearInterval(this.nativeMicrophoneTestStatusTimer);
    this.nativeMicrophoneTestStatusTimer = undefined;
    const nativeSessionId = this.nativeMicrophoneTestSessionId;
    this.nativeMicrophoneTestSessionId = "";
    this.microphoneTestSource?.disconnect();
    this.microphoneTestInputGain?.disconnect();
    this.microphoneTestAnalyser?.disconnect();
    this.microphoneTestOutputGain?.disconnect();
    this.microphoneTestSource = null;
    this.microphoneTestInputGain = null;
    this.microphoneTestAnalyser = null;
    this.microphoneTestOutputGain = null;
    const stream = this.microphoneTestStream;
    this.microphoneTestStream = null;
    if (stream) this.hooks.stopMediaStream(stream);
    const context = this.microphoneTestAudioContext;
    this.microphoneTestAudioContext = null;
    if (context) await context.close().catch(() => undefined);
    this.microphoneTestLevel = 0;
    if (nativeSessionId) await stopNativeMicrophoneTest(nativeSessionId).catch(() => undefined);
    this.hooks.flushAliases();
  }

  async playHeadphoneChannelTest(context: AudioContext, buffer: AudioBuffer, pan: -1 | 1) {
    const source = context.createBufferSource();
    const panner = context.createStereoPanner();
    const gain = context.createGain();
    source.buffer = buffer;
    panner.pan.value = pan;
    gain.gain.value = Math.min(1, (this.outputVolumePercent / 100) * uiSoundVolumeScale);
    source.connect(panner).connect(gain).connect(context.destination);
    await new Promise<void>((resolve) => {
      source.addEventListener("ended", () => resolve(), { once: true });
      source.start();
    });
  }

  async runHeadphoneTest() {
    if (this.headphoneTestBusy) return;
    this.headphoneTestBusy = true;
    this.hooks.setError("");
    let context: AudioContext | null = null;
    try {
      if (this.hooks.nativeDesktopRuntime()) {
        await testNativeHeadphones(this.selectedAudioOutputDeviceId, this.outputVolumePercent);
        return;
      }
      context = new AudioContext() as AudioContext & { setSinkId?: (id: string) => Promise<void> };
      if (this.selectedAudioOutputDeviceId && context.setSinkId) {
        await context.setSinkId?.(this.selectedAudioOutputDeviceId);
      }
      const response = await fetch(uiSoundURLs["audio-on"]);
      if (!response.ok) throw new Error(this.hooks.translate("error.voiceOutputUnavailable"));
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      await this.playHeadphoneChannelTest(context, buffer, -1);
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      await this.playHeadphoneChannelTest(context, buffer, 1);
    } catch (caught) {
      this.hooks.setError(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceOutputUnavailable")));
    } finally {
      await context?.close().catch(() => undefined);
      this.headphoneTestBusy = false;
      this.hooks.flushAliases();
    }
  }

  // ── Volume application & native sync ──────────────────────────────────────
  applyMemberVolume(targetMemberId: string) {
    const volume = this.memberVolumePercent(targetMemberId);
    this.hooks.remoteVoiceMixer().applyVolume(targetMemberId, "voice", volume);
    this.scheduleNativeMemberVolumeSync(targetMemberId, volume);
  }

  applyMemberMusicVolume(targetMemberId: string) {
    const volume = this.memberMusicVolumePercent(targetMemberId);
    this.hooks.remoteVoiceMixer().applyVolume(targetMemberId, "accompaniment", volume);
    this.scheduleNativeMemberMusicVolumeSync(targetMemberId, volume);
  }

  applyScreenShareVolume(targetMemberId: string) {
    this.hooks.remoteVoiceMixer().applyVolume(targetMemberId, "screen-share", this.screenShareVolumePercent(targetMemberId));
  }

  scheduleNativeMemberVolumeSync(targetMemberId: string, volume: number) {
    const existingTimer = this.nativeMemberVolumeSyncTimers.get(targetMemberId);
    if (existingTimer) window.clearTimeout(existingTimer);
    const session = this.hooks.nativeVoiceSession();
    if (!session) return;
    const sessionId = session.sessionId;
    const targetParticipantId = this.hooks.voiceStatesByMember().get(targetMemberId)?.participant_id ?? targetMemberId;
    const timer = window.setTimeout(() => {
      this.nativeMemberVolumeSyncTimers.delete(targetMemberId);
      void setNativeVoiceMemberVolume(sessionId, targetParticipantId, volume).catch((caught) => {
        if (this.hooks.nativeVoiceCommandWasStaleOrMissing(sessionId, caught)) return;
        this.hooks.setError(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceMediaUnavailable")));
      });
    }, 35);
    this.nativeMemberVolumeSyncTimers.set(targetMemberId, timer);
  }

  scheduleNativeMemberMusicVolumeSync(targetMemberId: string, volume: number) {
    const existingTimer = this.nativeMemberMusicVolumeSyncTimers.get(targetMemberId);
    if (existingTimer) window.clearTimeout(existingTimer);
    const session = this.hooks.nativeVoiceSession();
    if (!session) return;
    const sessionId = session.sessionId;
    const targetParticipantId = this.hooks.voiceStatesByMember().get(targetMemberId)?.participant_id ?? targetMemberId;
    const timer = window.setTimeout(() => {
      this.nativeMemberMusicVolumeSyncTimers.delete(targetMemberId);
      void setNativeVoiceMemberMusicVolume(sessionId, targetParticipantId, volume).catch((caught) => {
        if (this.hooks.nativeVoiceCommandWasStaleOrMissing(sessionId, caught)) return;
        this.hooks.setError(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceMediaUnavailable")));
      });
    }, 35);
    this.nativeMemberMusicVolumeSyncTimers.set(targetMemberId, timer);
  }

  applyLocalAudioState() {
    const session = this.hooks.nativeVoiceSession();
    if (session) {
      void setNativeVoiceState(
        session.sessionId,
        this.micMuted || this.audioDeafened,
        this.audioDeafened
      ).catch((caught) => {
        if (this.hooks.nativeVoiceCommandWasStaleOrMissing(session.sessionId, caught)) return;
        this.hooks.setError(this.hooks.caughtMessage(caught, this.hooks.translate("error.voiceMediaUnavailable")));
      });
    }
    this.hooks.localVoiceStream()?.getAudioTracks().forEach((track) => {
      track.enabled = !this.micMuted && !this.audioDeafened;
    });
    this.hooks.rawLocalVoiceStream()?.getAudioTracks().forEach((track) => {
      track.enabled = !this.micMuted && !this.audioDeafened;
    });
  }

  applyRemoteAudioState() {
    const remoteVoiceMixer = this.hooks.remoteVoiceMixer();
    remoteVoiceMixer.setMasterGain(this.audioDeafened ? 0 : this.outputVolumePercent / 100);
    remoteVoiceMixer.setElementsMuted(this.audioDeafened);
    for (const targetMemberId of remoteVoiceMixer.memberIdsForScope("voice")) {
      this.applyMemberVolume(targetMemberId);
    }
    for (const targetMemberId of remoteVoiceMixer.memberIdsForScope("accompaniment")) {
      this.applyMemberMusicVolume(targetMemberId);
    }
    for (const targetMemberId of remoteVoiceMixer.memberIdsForScope("screen-share")) {
      this.applyScreenShareVolume(targetMemberId);
    }
    this.hooks.accompanimentApplyMonitorLevel();
  }
}
