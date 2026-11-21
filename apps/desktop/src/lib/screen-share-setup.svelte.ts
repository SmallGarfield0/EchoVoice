// Screen share setup domain controller.
//
// Owns the "configure & start my screen share" state and actions: the setup
// dialog and source picker, desktop capture enumeration / capabilities, the
// persisted quality preferences (resolution, frame rate, bitrate, content mode,
// cursor capture), quality menus, and the start/stop orchestration for both the
// browser and native sender paths.
//
// Deliberately NOT owned here (next extraction phase): the ScreenShareController
// session/watch registry and the raw WebRTC/native transport (peer connections,
// sender status polling, signal queues, stats, local streams). Those stay in the
// workspace component and are injected through the hooks below. The workspace
// component keeps the same-name template aliases and thin wrappers; hot paths
// (transport functions, signaling) read this controller directly.
//
// Uses the .svelte.ts extension so Svelte 5 `$state` runes work in the class.

import { tick } from "svelte";
import { endScreenShareSession, startScreenShareSession } from "./api";
import {
  availableScreenShareFrameRates,
  defaultScreenShareFrameRates,
  fitScreenShareOutputSize,
  loadScreenShareBitrate,
  loadScreenShareCaptureCursor,
  loadScreenShareContentMode,
  loadScreenShareFrameRate,
  loadScreenShareResolution,
  resolveScreenShareBitrateBps,
  saveScreenShareBitrate,
  saveScreenShareCaptureCursor,
  saveScreenShareContentMode,
  saveScreenShareFrameRate,
  saveScreenShareResolution,
  screenShareBitrateOptions,
  screenShareContentHint,
  screenShareContentModes,
  screenShareResolutionOptions,
  screenShareResolutionSize,
  screenShareSourceSizeHint,
  type ScreenShareBitrateOption,
  type ScreenShareContentMode,
  type ScreenShareResolutionPreset
} from "./screenShareSettings";
import type { ScreenShareSenderTelemetry } from "./screenShareWebRTC";
import type { ScreenSharePathKind } from "./screenSharePath";
import { screenSharePerViewerCostLabel } from "./screenShareUplink";
import { screenShareLimitationHint, screenSharePendingSettingsSuffix } from "./screenShareStreamLabel";
import {
  listDesktopCaptureSources,
  loadDesktopMediaCapabilities,
  loadNativeScreenShareSenderStatus,
  startNativeScreenShareSender,
  stopNativeScreenShareSender
} from "./storage";
import type {
  DesktopCaptureSource,
  DesktopMediaCapabilities,
  NativeScreenShareSenderSession,
  NativeScreenShareSenderStatus,
  RTCIceServer,
  ScreenShareSession,
  ServerSummary,
  VoiceState
} from "./types";

type TranslateParams = Record<string, string | number>;

type NativeScreenShareSenderStatusFallbackOptions = {
  backend?: string;
  phase?: NativeScreenShareSenderStatus["phase"];
  lastError?: string;
};

/**
 * Cross-cutting dependencies injected by the workspace component. Transport
 * state and transport functions remain in the workspace component (they are the
 * next extraction phase) and are reached through these lazy arrow hooks, so the
 * controller never imports App.svelte and construction order cannot throw TDZ.
 */
export type ScreenShareSetupHooks = {
  // Workspace / permission state.
  server: () => ServerSummary | null;
  baseUrl: () => string;
  sessionToken: () => string;
  memberId: () => string;
  currentVoiceState: () => VoiceState | null;
  canStartScreenShareSession: () => boolean;
  canHostRemoteControl: () => boolean;
  isTauriRuntime: () => boolean;
  screenShareAudioAvailable: () => boolean;
  translate: (key: string, params?: TranslateParams) => string;
  setError: (message: string) => void;
  setStatusKey: (key: string) => void;
  screenShareActionBusy: () => boolean;
  setScreenShareActionBusy: (busy: boolean) => void;

  // Setup entry side effects (other domains / shell).
  clearStaleCurrentMemberScreenShare: () => boolean;
  closeVoiceNetworkDetails: () => void;
  closeScreenShareViewerPanel: () => void;

  // ScreenShareController cross-domain.
  screenShareClearWatchers: () => void;
  mergeScreenShareSession: (session: ScreenShareSession) => void;
  removeScreenShareSession: (session: ScreenShareSession) => void;
  removeCurrentMemberScreenShareSession: (session: ScreenShareSession) => void;
  currentMemberScreenShare: () => ScreenShareSession | undefined;
  screenShareWatchingBusyIds: () => Set<string>;
  setScreenShareWatchingBusyIds: (ids: Set<string>) => void;
  screenShareViewerPanelShareId: () => string;

  // RemoteControlController cross-domain.
  remoteControlClearNativeHostId: () => void;

  // Transport state kept in App (native sender / pending web capture).
  pendingWebScreenShareStream: () => MediaStream | null;
  setPendingWebScreenShareStream: (stream: MediaStream | null) => void;
  /**
   * The panel stores a new quality choice immediately, but a running share
   * keeps the parameters it captured when each viewer joined. Without this the
   * user changes the bitrate and the picture does not move until the viewer
   * reconnects, which reads as "the setting does nothing".
   */
  applyWebScreenShareSenderSettings: () => Promise<void>;
  setWebScreenShareAudioEnabled: (enabled: boolean) => Promise<boolean>;
  setNativeScreenShareMaximumBitrate: (bitrateBps: number) => Promise<boolean>;
  setNativeScreenShareFrameRate: (frameRate: number) => Promise<boolean>;
  nativeScreenShareSenderSession: () => NativeScreenShareSenderSession | null;
  setNativeScreenShareSenderSession: (session: NativeScreenShareSenderSession | null) => void;
  setNativeScreenShareSenderStatus: (status: NativeScreenShareSenderStatus | null) => void;
  nativeScreenShareStatusRefreshError: () => string;
  setNativeScreenShareStatusRefreshError: (message: string) => void;
  nativeScreenShareRegisteredViewerIds: () => Set<string>;
  setNativeScreenShareRegisteredViewerIds: (ids: Set<string>) => void;
  nativeScreenShareAppliedAnswerMemberIds: () => Set<string>;
  setNativeScreenShareAppliedAnswerMemberIds: (ids: Set<string>) => void;
  nativeScreenShareSignalDrainInFlight: () => boolean;
  setNativeScreenShareSignalDrainInFlight: (value: boolean) => void;
  nativeScreenShareSignalDrainLastAtMS: () => number;
  setNativeScreenShareSignalDrainLastAtMS: (value: number) => void;
  nativeScreenShareViewerSyncAtMS: () => number;
  setNativeScreenShareViewerSyncAtMS: (value: number) => void;
  localScreenSharePreviewRenderingEnabled: () => boolean;
  rtcIceServers: () => RTCIceServer[];

  // Transport functions kept in App (next phase).
  openLocalScreenShareStream: (includeAudio: boolean) => Promise<MediaStream>;
  attachLocalScreenShareStream: (stream: MediaStream) => void;
  stopLocalScreenShareStream: (options: { programmatic?: boolean }) => void;
  stopMediaStream: (stream: MediaStream) => void;
  flushPendingOwnedScreenShareWatchSignals: (shareId: string) => void;
  startWebScreenShareSignalPolling: (shareId: string) => void;
  stopWebScreenShareSignalPolling: () => void;
  startNativeScreenShareStatusPolling: () => void;
  stopNativeScreenShareStatusPolling: (options?: { clearStatus?: boolean }) => void;
  scheduleNativeScreenShareStatusProbeBurst: (sessionId: string) => void;
  scheduleNativeScreenShareSignalFlush: (sessionId: string) => void;
  syncNativeScreenSharePreviewRendering: (sessionId: string) => void;
  applyNativeScreenShareSenderStatus: (status: NativeScreenShareSenderStatus) => void;
  nativeScreenShareSenderStatusFallback: (
    session: NativeScreenShareSenderSession,
    options?: NativeScreenShareSenderStatusFallbackOptions
  ) => NativeScreenShareSenderStatus;
  localScreenShareStream: () => MediaStream | null;
  webScreenShareSenderTelemetry: () => Map<string, ScreenShareSenderTelemetry>;
  webScreenShareViewerPaths: () => Map<string, ScreenSharePathKind>;
  webScreenShareSenderConfigurationErrors: () => Map<string, string>;
  screenShareWatcherSessionIds: () => Map<string, string>;
  closeAllScreenSharePeerConnections: () => void;
  stopNativeLocalScreenSharePreview: (options: { resumeThumbnail?: boolean }) => Promise<void>;
  abortableRequestWithTimeout: <T>(
    request: (signal: AbortSignal) => Promise<T>,
    timeoutMS: number,
    fallback: string
  ) => Promise<T>;
  promiseWithTimeout: <T>(promise: Promise<T>, timeoutMS: number, fallback: string) => Promise<T>;

  // Template-bound DOM refs (kept in App via bind:this).
  resolutionButton: () => HTMLButtonElement | null;
  frameRateButton: () => HTMLButtonElement | null;
  bitrateButton: () => HTMLButtonElement | null;
  contentModeButton: () => HTMLButtonElement | null;

  /** Bumps the component's realtimeSyncTick so template aliases refresh now. */
  flushAliases: () => void;
};

export class ScreenShareSetupController {
  // Dialog / source state.
  setupOpen = $state(false);
  sourceDialogOpen = $state(false);
  remoteControlAllowed = $state(false);
  audioEnabled = $state(false);
  pendingWebAudioTrackAvailable = $state<boolean | null>(null);

  // Persisted quality preferences.
  resolutionPreset = $state<ScreenShareResolutionPreset>(loadScreenShareResolution(localStorage));
  resolutionDisplayLabel = $state("");
  frameRate = $state(loadScreenShareFrameRate(localStorage));
  bitrateOption = $state<ScreenShareBitrateOption>(loadScreenShareBitrate(localStorage));
  adaptiveWebQuality = $state(localStorage.getItem("ev.screenShare.adaptiveWebQuality") === "true");
  private webPickerGeneration = 0;
  toggleAdaptiveWebQuality() {
    this.adaptiveWebQuality = !this.adaptiveWebQuality;
    localStorage.setItem("ev.screenShare.adaptiveWebQuality", String(this.adaptiveWebQuality));
    this.noteShareSettingsChange();
    this.flush();
  }
  contentMode = $state<ScreenShareContentMode>(loadScreenShareContentMode(localStorage));
  captureCursor = $state(loadScreenShareCaptureCursor(localStorage));
  // Set when quality changed while a native share is already encoding, because
  // the native encoder cannot be retuned without a new session.
  shareSettingsPending = $state(false);
  private readonly pendingQuality = new Map<string, { sessionId: string }>();
  private qualityUpdate = Promise.resolve();

  // Quality menus.
  resolutionMenuOpen = $state(false);
  resolutionMenuStyle = $state("");
  frameRateMenuOpen = $state(false);
  frameRateMenuStyle = $state("");
  bitrateMenuOpen = $state(false);
  bitrateMenuStyle = $state("");
  contentModeMenuOpen = $state(false);
  contentModeMenuStyle = $state("");
  frameRateOptions = $state<number[]>(defaultScreenShareFrameRates);

  // Desktop capture enumeration / capabilities.
  desktopCaptureBackend = $state("browser-fallback");
  desktopCaptureSources = $state<DesktopCaptureSource[]>([]);
  desktopCaptureSourcesLoading = $state(false);
  desktopCaptureSourceError = $state("");
  desktopMediaCapabilities = $state<DesktopMediaCapabilities | null>(null);
  desktopMediaCapabilitiesLoading = $state(false);
  desktopMediaCapabilitiesRequest: Promise<DesktopMediaCapabilities> | null = null;
  selectedDesktopCaptureSourceId = $state("");
  selectedDesktopCaptureSource = $state<DesktopCaptureSource | undefined>(undefined);

  // View-state derivatives refreshed by syncViewState().
  configurationSourceReady = $state(false);
  frameRateUnavailable = $state(false);
  webAudioMissing = $state(false);
  desktopCaptureScreenSources = $state<DesktopCaptureSource[]>([]);
  desktopCaptureWindowSources = $state<DesktopCaptureSource[]>([]);

  // Labels computed by transport functions in the workspace component.
  actualSettingsLabel = $state("");
  previewMetaLabel = $state("");

  constructor(private readonly hooks: ScreenShareSetupHooks) {}

  currentMemberShare(): ScreenShareSession | undefined {
    return this.hooks.currentMemberScreenShare();
  }

  // ---------------------------------------------------------------------------
  // Setup entry points & dialog controls
  // ---------------------------------------------------------------------------

  handleEntryPointerDown(event: PointerEvent) {
    event.preventDefault();
    this.openFromEntry();
  }

  handleEntryClick() {
    this.openFromEntry();
  }

  openFromEntry() {
    this.hooks.clearStaleCurrentMemberScreenShare();
    if (!this.hooks.canStartScreenShareSession()) return;
    if (!this.hooks.isTauriRuntime()) this.remoteControlAllowed = false;
    this.setupOpen = true;
    this.hooks.closeVoiceNetworkDetails();
    void this.ensureDesktopMediaCapabilities();
    this.flush();
  }

  closeSetup() {
    this.setupOpen = false;
    this.closeOptionMenus();
    this.discardPendingWebSource();
    this.flush();
  }

  openSourceStep() {
    if (!this.hooks.canStartScreenShareSession() || this.hooks.screenShareActionBusy()) return;
    if (!this.hooks.isTauriRuntime()) {
      void this.prepareWebSource();
      return;
    }
    this.sourceDialogOpen = true;
    this.closeOptionMenus();
    void this.ensureDesktopMediaCapabilities();
    void this.refreshDesktopCaptureSources();
    this.flush();
  }

  closeSourceDialog() {
    if (this.hooks.screenShareActionBusy()) return;
    this.sourceDialogOpen = false;
    this.flush();
  }

  toggleRemoteControlAllowed() {
    this.remoteControlAllowed = !this.remoteControlAllowed;
    this.flush();
  }

  // ---------------------------------------------------------------------------
  // Browser source selection
  // ---------------------------------------------------------------------------

  async prepareWebSource() {
    if (this.hooks.isTauriRuntime() || this.hooks.screenShareActionBusy()) return;
    this.hooks.setScreenShareActionBusy(true);
    this.hooks.setError("");
    this.discardPendingWebSource();
    const generation = this.webPickerGeneration;
    try {
      const stream = await this.hooks.openLocalScreenShareStream(this.audioEnabled);
      if (generation !== this.webPickerGeneration || !this.setupOpen) {
        this.hooks.stopMediaStream(stream);
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (!track) {
        this.hooks.stopMediaStream(stream);
        throw new Error(this.hooks.translate("error.screenShareMediaUnavailable"));
      }
      const settings = track.getSettings();
      const displaySurface = String(settings.displaySurface ?? "monitor");
      const source: DesktopCaptureSource = {
        sourceId: "web-selected-source",
        kind: displaySurface === "window" || displaySurface === "browser" ? "window" : "screen",
        name: track.label || this.hooks.translate("screenShare.browserSelectedSource"),
        appName: displaySurface,
        x: 0,
        y: 0,
        width: Number(settings.width ?? 0),
        height: Number(settings.height ?? 0),
        isPrimary: false,
        isCurrentApp: false
      };
      this.hooks.setPendingWebScreenShareStream(stream);
      this.pendingWebAudioTrackAvailable = this.audioEnabled
        ? stream.getAudioTracks().some((audioTrack) => audioTrack.readyState === "live")
        : null;
      this.desktopCaptureBackend = "browser-fallback";
      this.desktopCaptureSources = [source];
      this.selectedDesktopCaptureSourceId = source.sourceId;
      track.addEventListener("ended", () => {
        if (this.hooks.pendingWebScreenShareStream() === stream) this.discardPendingWebSource();
      }, { once: true });
    } catch (caught) {
      if (generation === this.webPickerGeneration) {
        this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.screenShareMediaUnavailable"));
      }
    } finally {
      this.hooks.setScreenShareActionBusy(false);
      this.flush();
    }
  }

  discardPendingWebSource() {
    this.webPickerGeneration++;
    const stream = this.hooks.pendingWebScreenShareStream();
    this.hooks.setPendingWebScreenShareStream(null);
    this.pendingWebAudioTrackAvailable = null;
    if (stream) this.hooks.stopMediaStream(stream);
    if (!this.hooks.isTauriRuntime()) {
      this.selectedDesktopCaptureSourceId = "";
      this.desktopCaptureSources = [];
    }
    this.flush();
  }

  toggleAudio() {
    const enabling = !this.audioEnabled;
    this.audioEnabled = enabling;
    this.pendingWebAudioTrackAvailable = null;
    // A share that is already running owns its viewers: retune them, and if the
    // capture never had system audio there is nothing to attach.
    if (!this.hooks.isTauriRuntime() && this.hooks.localScreenShareStream()) {
      void this.applyLiveWebAudioToggle(enabling);
      this.flush();
      return;
    }
    const stream = this.hooks.pendingWebScreenShareStream();
    if (this.hooks.isTauriRuntime() || !stream) {
      // A running native session keeps the audio setting it started with; the
      // pending-source path below only ever reaches a share that is not live.
      this.noteShareSettingsChange();
      this.flush();
      return;
    }
    if (enabling) {
      this.discardPendingWebSource();
      return;
    }
    for (const track of stream.getAudioTracks()) {
      stream.removeTrack(track);
      track.stop();
    }
    this.flush();
  }

  private async applyLiveWebAudioToggle(enabling: boolean) {
    const applied = await this.hooks.setWebScreenShareAudioEnabled(enabling);
    if (applied) return;
    // Nothing to attach: this capture was granted without system audio, and a
    // running capture cannot grow one. Be explicit instead of doing nothing.
    this.shareSettingsPending = true;
    this.flush();
  }

  // ---------------------------------------------------------------------------
  // Desktop capture enumeration & capabilities
  // ---------------------------------------------------------------------------

  async refreshDesktopCaptureSources() {
    if (this.desktopCaptureSourcesLoading) return;
    this.desktopCaptureSourcesLoading = true;
    this.desktopCaptureSourceError = "";
    try {
      const result = await listDesktopCaptureSources();
      this.desktopCaptureBackend = result.backend;
      this.desktopCaptureSources = this.sortDesktopCaptureSources(result.sources ?? []);
      if (
        this.desktopCaptureSources.length > 0 &&
        !this.desktopCaptureSources.some((source) => source.sourceId === this.selectedDesktopCaptureSourceId)
      ) {
        this.selectedDesktopCaptureSourceId = this.desktopCaptureSources[0]?.sourceId ?? "";
      }
      if (this.desktopCaptureSources.length === 0) {
        this.selectedDesktopCaptureSourceId = "";
      }
      this.desktopCaptureSourceError = result.warnings?.[0] ?? "";
    } catch (caught) {
      this.desktopCaptureBackend = this.hooks.isTauriRuntime() ? "native-unavailable" : "browser-fallback";
      this.desktopCaptureSources = [];
      this.selectedDesktopCaptureSourceId = "";
      this.desktopCaptureSourceError =
        caught instanceof Error ? caught.message : this.hooks.translate("screenShare.sourcesUnavailable");
    } finally {
      this.desktopCaptureSourcesLoading = false;
      this.flush();
    }
  }

  async ensureDesktopMediaCapabilities() {
    const cachedCapabilitiesFailed = Boolean(
      this.hooks.isTauriRuntime() && this.desktopMediaCapabilities?.platform === "unknown"
    );
    if (this.desktopMediaCapabilities && !cachedCapabilitiesFailed) return this.desktopMediaCapabilities;
    if (this.desktopMediaCapabilitiesRequest) return this.desktopMediaCapabilitiesRequest;
    this.desktopMediaCapabilitiesLoading = true;
    const request = loadDesktopMediaCapabilities()
      .then((capabilities) => {
        this.desktopMediaCapabilities = capabilities;
        return capabilities;
      })
      .catch((caught) => {
        console.warn("[EchoVoice] desktop media capabilities unavailable", caught);
        const fallback: DesktopMediaCapabilities = {
          platform: this.hooks.isTauriRuntime() ? "unknown" : "web",
          runtime: this.hooks.isTauriRuntime() ? "tauri" : "web",
          sourceEnumeration: false,
          thumbnails: false,
          nativeScreenShareSender: false,
          webCaptureFallback: !this.hooks.isTauriRuntime() && Boolean(navigator.mediaDevices?.getDisplayMedia),
          supportedFrameRates: defaultScreenShareFrameRates,
          maxNativeFrameRate: 0,
          hardwareH264Encoder: false,
          remoteControlHost: false,
          remoteControlSourceKinds: [],
          supportedSourceKinds: [],
          videoBackends: [],
          audioBackends: [],
          notes: []
        };
        this.desktopMediaCapabilities = fallback;
        return fallback;
      })
      .finally(() => {
        this.desktopMediaCapabilitiesLoading = false;
        this.desktopMediaCapabilitiesRequest = null;
        this.flush();
      });
    this.desktopMediaCapabilitiesRequest = request;
    return request;
  }

  sortDesktopCaptureSources(sources: DesktopCaptureSource[]) {
    const kindOrder: Record<DesktopCaptureSource["kind"], number> = {
      screen: 0,
      window: 1
    };
    return [...sources].sort((left, right) => {
      if (left.kind !== right.kind) return kindOrder[left.kind] - kindOrder[right.kind];
      if (left.kind === "screen" && left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }

  selectDesktopCaptureSource(source: DesktopCaptureSource) {
    this.selectedDesktopCaptureSourceId = source.sourceId;
    if (!this.desktopCaptureSources.some((item) => item.sourceId === source.sourceId)) {
      this.desktopCaptureSources = [source, ...this.desktopCaptureSources];
    }
    this.flush();
  }

  async confirmDesktopCaptureSourceSelection() {
    const source = this.selectedDesktopCaptureSource;
    if (!source) return;
    const capabilities = await this.ensureDesktopMediaCapabilities();
    if (this.hooks.isTauriRuntime() && !capabilities.nativeScreenShareSender) {
      this.hooks.setError(this.hooks.translate("error.screenShareNativeSenderUnavailable"));
      return;
    }
    this.sourceDialogOpen = false;
    this.flush();
  }

  // ---------------------------------------------------------------------------
  // Display helpers for the source picker / setup dialog
  // ---------------------------------------------------------------------------

  desktopCaptureBackendLabel() {
    if (this.desktopCaptureBackend === "windows-native-enumeration") {
      return this.hooks.translate("screenShare.backendDesktop");
    }
    if (this.desktopCaptureBackend === "browser-fallback") {
      return this.hooks.translate("screenShare.backendBrowser");
    }
    return this.hooks.translate("screenShare.backendUnavailable");
  }

  desktopNativeScreenShareUnavailable() {
    return Boolean(
      this.hooks.isTauriRuntime() &&
        this.desktopMediaCapabilities &&
        !this.desktopMediaCapabilities.nativeScreenShareSender
    );
  }

  remoteControlAvailableForSource(source: DesktopCaptureSource | undefined) {
    if (!source || !this.hooks.canHostRemoteControl() || !this.hooks.server()?.remote_control_enabled) return false;
    return this.desktopMediaCapabilities?.remoteControlSourceKinds.includes(source.kind as "screen" | "window") ?? false;
  }

  sourceDialogStatus() {
    if (this.desktopNativeScreenShareUnavailable()) {
      return this.hooks.translate("screenShare.nativeSenderPending");
    }
    return this.desktopCaptureBackendLabel();
  }

  desktopCaptureSourceIcon(source: DesktopCaptureSource) {
    return source.kind === "screen" ? "desktop_windows" : "web_asset";
  }

  desktopCaptureSourceKindLabel(source: DesktopCaptureSource) {
    return source.kind === "screen"
      ? this.hooks.translate("screenShare.sourceScreen")
      : this.hooks.translate("screenShare.sourceWindow");
  }

  desktopCaptureSourceMeta(source: DesktopCaptureSource) {
    const dimensions = `${source.width} x ${source.height}`;
    const parts = [this.desktopCaptureSourceKindLabel(source)];
    if (source.appName) parts.push(source.appName);
    if (source.isPrimary) parts.push(this.hooks.translate("screenShare.primaryDisplay"));
    parts.push(dimensions);
    return parts.join(" · ");
  }

  // ---------------------------------------------------------------------------
  // Quality option menus
  // ---------------------------------------------------------------------------

  anyOptionMenuOpen() {
    return this.resolutionMenuOpen || this.frameRateMenuOpen || this.bitrateMenuOpen || this.contentModeMenuOpen;
  }

  closeOptionMenus() {
    this.resolutionMenuOpen = false;
    this.frameRateMenuOpen = false;
    this.bitrateMenuOpen = false;
    this.contentModeMenuOpen = false;
    this.flush();
  }

  optionMenuStyle(button: HTMLButtonElement | null, optionCount: number) {
    if (!button) return "";
    const rect = button.getBoundingClientRect();
    const width = Math.max(132, Math.min(180, rect.width));
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const menuHeight = optionCount * 28 + 8;
    const belowTop = rect.bottom + 4;
    const aboveTop = rect.top - menuHeight - 4;
    const top = belowTop + menuHeight <= window.innerHeight - 8 ? belowTop : Math.max(8, aboveTop);
    return `left: ${left}px; top: ${top}px; width: ${width}px;`;
  }

  toggleResolutionMenu() {
    if (this.hooks.screenShareActionBusy()) return;
    const next = !this.resolutionMenuOpen;
    this.closeOptionMenus();
    this.resolutionMenuOpen = next;
    if (this.resolutionMenuOpen) {
      this.updateResolutionMenuPosition();
      void tick().then(() => this.updateResolutionMenuPosition());
    }
    this.flush();
  }

  updateResolutionMenuPosition() {
    this.resolutionMenuStyle = this.optionMenuStyle(
      this.hooks.resolutionButton(),
      screenShareResolutionOptions.length
    );
  }

  toggleFrameRateMenu() {
    if (this.hooks.screenShareActionBusy()) return;
    const next = !this.frameRateMenuOpen;
    this.closeOptionMenus();
    this.frameRateMenuOpen = next;
    if (this.frameRateMenuOpen) {
      this.updateFrameRateMenuPosition();
      void tick().then(() => this.updateFrameRateMenuPosition());
    }
    this.flush();
  }

  updateFrameRateMenuPosition() {
    this.frameRateMenuStyle = this.optionMenuStyle(this.hooks.frameRateButton(), this.frameRateOptions.length);
  }

  toggleBitrateMenu() {
    if (this.hooks.screenShareActionBusy()) return;
    const next = !this.bitrateMenuOpen;
    this.closeOptionMenus();
    this.bitrateMenuOpen = next;
    if (this.bitrateMenuOpen) {
      this.updateBitrateMenuPosition();
      void tick().then(() => this.updateBitrateMenuPosition());
    }
    this.flush();
  }

  updateBitrateMenuPosition() {
    this.bitrateMenuStyle = this.optionMenuStyle(this.hooks.bitrateButton(), screenShareBitrateOptions.length);
  }

  toggleContentModeMenu() {
    if (this.hooks.screenShareActionBusy()) return;
    const next = !this.contentModeMenuOpen;
    this.closeOptionMenus();
    this.contentModeMenuOpen = next;
    if (this.contentModeMenuOpen) {
      this.updateContentModeMenuPosition();
      void tick().then(() => this.updateContentModeMenuPosition());
    }
    this.flush();
  }

  updateContentModeMenuPosition() {
    this.contentModeMenuStyle = this.optionMenuStyle(this.hooks.contentModeButton(), screenShareContentModes.length);
  }

  // ---------------------------------------------------------------------------
  // Quality preference setters
  // ---------------------------------------------------------------------------

  selectResolution(preset: ScreenShareResolutionPreset, event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();
    this.resolutionPreset = preset;
    saveScreenShareResolution(localStorage, preset);
    this.resolutionMenuOpen = false;
    void this.applyPendingWebConstraints();
    this.noteShareSettingsChange();
    this.flush();
  }

  selectFrameRate(frameRate: number, event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();
    this.frameRate = frameRate;
    saveScreenShareFrameRate(localStorage, frameRate);
    this.frameRateMenuOpen = false;
    void this.applyPendingWebConstraints();
    // The native frame pump can drop frames to a lower cadence without touching
    // the encoder, so this one takes effect on the running share too.
    if (this.hooks.nativeScreenShareSenderSession()) {
      void this.applyNativeShareFrameRate();
    } else {
      this.noteShareSettingsChange();
    }
    this.flush();
  }

  selectBitrate(option: ScreenShareBitrateOption, event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();
    this.bitrateOption = option;
    saveScreenShareBitrate(localStorage, option);
    this.bitrateMenuOpen = false;
    // Bitrate is the one native knob the running encoder can accept: the
    // controller only has to lower its ceiling. Everything else still needs a
    // new session, which the pending hint covers.
    if (this.hooks.nativeScreenShareSenderSession()) {
      void this.applyNativeShareBitrate();
    } else {
      this.noteShareSettingsChange();
    }
    this.flush();
  }

  private async applyNativeShareBitrate() {
    const bitrate = this.targetBitrate();
    await this.applyNativeQuality("bitrate", () => this.hooks.setNativeScreenShareMaximumBitrate(bitrate));
  }

  private async applyNativeShareFrameRate() {
    const fps = this.frameRate;
    await this.applyNativeQuality("fps", () => this.hooks.setNativeScreenShareFrameRate(fps));
  }

  private async applyNativeQuality(key: string, apply: () => Promise<boolean>) {
    const sessionId = this.hooks.nativeScreenShareSenderSession()?.sessionId;
    if (!sessionId) return;
    const request = { sessionId };
    this.pendingQuality.set(key, request);
    this.qualityUpdate = this.qualityUpdate.then(async () => {
      if (this.pendingQuality.get(key) !== request || this.hooks.nativeScreenShareSenderSession()?.sessionId !== sessionId) return;
      const applied = await apply().catch(() => false);
      if (applied && this.pendingQuality.get(key) === request) this.pendingQuality.delete(key);
      this.flush();
    });
    await this.qualityUpdate;
  }

  selectContentMode(mode: ScreenShareContentMode, event?: Event) {
    event?.preventDefault();
    event?.stopPropagation();
    this.contentMode = mode;
    saveScreenShareContentMode(localStorage, mode);
    this.contentModeMenuOpen = false;
    void this.applyPendingWebConstraints();
    this.noteShareSettingsChange();
    this.flush();
  }

  // The web sender can be retuned in place. A native session, by contrast, is
  // built once from the settings it was started with: quality, shared audio and
  // cursor capture all need a new session. Say so, instead of showing settings
  // the running encoder never received.
  private noteShareSettingsChange() {
    if (this.hooks.nativeScreenShareSenderSession()) {
      this.shareSettingsPending = true;
    }
    void this.hooks.applyWebScreenShareSenderSettings();
  }

  toggleCursorCapture() {
    this.captureCursor = !this.captureCursor;
    saveScreenShareCaptureCursor(localStorage, this.captureCursor);
    void this.applyPendingWebConstraints();
    this.noteShareSettingsChange();
    this.flush();
  }

  async applyPendingWebConstraints() {
    // Once a share starts, the pending stream is handed over and cleared: the
    // track that must take the new constraints is the live one, otherwise the
    // encoder keeps receiving the old resolution while the panel claims the new.
    const stream = this.hooks.localScreenShareStream() ?? this.hooks.pendingWebScreenShareStream();
    const track = stream?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({
        ...this.videoConstraints(),
        cursor: this.captureCursor ? "always" : "never"
      } as MediaTrackConstraints);
    } catch {
      // Browser display tracks may expose a fixed source while still remaining shareable.
    }
    try {
      track.contentHint = screenShareContentHint(this.contentMode);
    } catch {
      // contentHint is an optional browser optimization.
    }
  }

  resolutionPresetLabel(preset: ScreenShareResolutionPreset) {
    return preset === "source" ? this.hooks.translate("screenShare.resolutionSource") : preset;
  }

  bitrateLabel(option: ScreenShareBitrateOption) {
    return option === "auto"
      ? this.hooks.translate("screenShare.bitrateAuto")
      : this.hooks.translate("screenShare.bitrateValue", { bitrate: option });
  }

  contentModeLabel(mode: ScreenShareContentMode) {
    return this.hooks.translate(`screenShare.contentMode.${mode}`);
  }

  // ---------------------------------------------------------------------------
  // Configuration computation helpers (used by transport & template labels)
  // ---------------------------------------------------------------------------

  async ensureNativeReady() {
    const source = this.selectedDesktopCaptureSource;
    if (!source) {
      throw new Error(this.hooks.translate("error.screenShareNativeSourceRequired"));
    }
    const capabilities = await this.ensureDesktopMediaCapabilities();
    if (!capabilities.nativeScreenShareSender) {
      throw new Error(this.hooks.translate("error.screenShareNativeSenderUnavailable"));
    }
  }

  desktopCaptureFrameSize(source: DesktopCaptureSource) {
    const preset = screenShareResolutionSize(this.resolutionPreset);
    const sourceWidth = Math.max(2, source.width || 1920);
    const sourceHeight = Math.max(2, source.height || 1080);
    const fitted = fitScreenShareOutputSize(
      sourceWidth,
      sourceHeight,
      Math.min(3840, preset?.width ?? sourceWidth),
      Math.min(2160, preset?.height ?? sourceHeight)
    );
    return {
      maxWidth: fitted.width,
      maxHeight: fitted.height
    };
  }

  computeActualSettingsLabel() {
    const source = this.selectedDesktopCaptureSource ?? this.desktopCaptureSources[0];
    const size = source ? this.desktopCaptureFrameSize(source) : null;
    const fpsLabel = this.hooks.translate("screenShare.fpsValue", { fps: this.frameRate });
    const sizeLabel = size ? `${size.maxWidth} x ${size.maxHeight}` : this.resolutionDisplayLabel;
    // Only "auto" hides the number it picked; a fixed choice already states it.
    const perViewerCost = this.bitrateOption === "auto"
      ? screenSharePerViewerCostLabel(this.targetBitrate(), (key, params) =>
          this.hooks.translate(key, params)
        )
      : "";
    const sourceSize = source
      ? screenShareSourceSizeHint(
          size?.maxWidth ?? 0,
          size?.maxHeight ?? 0,
          source.width,
          source.height
        )
      : "";
    const sourceHint = sourceSize
      ? ` · ${this.hooks.translate("screenShare.sourceSizeHint", { size: sourceSize })}`
      : "";
    return `${sizeLabel} / ${fpsLabel} / ${this.bitrateLabel(this.bitrateOption)}${perViewerCost}${sourceHint}${screenSharePendingSettingsSuffix(
      this.shareSettingsPending || [...this.pendingQuality.values()].some(item =>
        item.sessionId === this.hooks.nativeScreenShareSenderSession()?.sessionId),
      (key) => this.hooks.translate(key)
    )}`;
  }

  videoConstraints(): MediaTrackConstraints {
    const constraints = {
      frameRate: { ideal: this.frameRate, max: this.frameRate },
      resizeMode: this.resolutionPreset === "source" ? "none" : "crop-and-scale"
    } as MediaTrackConstraints & {
      resizeMode: "none" | "crop-and-scale";
    };
    const preset = screenShareResolutionSize(this.resolutionPreset);
    if (preset) {
      constraints.width = { ideal: preset.width, max: preset.width };
      constraints.height = { ideal: preset.height, max: preset.height };
    }
    return constraints;
  }

  resolvedFrame(track: MediaStreamTrack | null = null) {
    const trackSettings = track?.getSettings();
    const source = this.selectedDesktopCaptureSource;
    const preset = screenShareResolutionSize(this.resolutionPreset);
    const frameSize = trackSettings?.width && trackSettings?.height
      ? { maxWidth: trackSettings.width, maxHeight: trackSettings.height }
      : source
        ? this.desktopCaptureFrameSize(source)
        : preset
          ? { maxWidth: preset.width, maxHeight: preset.height }
          : { maxWidth: 1920, maxHeight: 1080 };
    return {
      width: frameSize.maxWidth,
      height: frameSize.maxHeight,
      frameRate: trackSettings?.frameRate ?? this.frameRate
    };
  }

  targetBitrate(track: MediaStreamTrack | null = null) {
    const frame = this.resolvedFrame(track);
    return resolveScreenShareBitrateBps(
      this.bitrateOption,
      frame.width,
      frame.height,
      frame.frameRate,
      this.contentMode
    );
  }

  computePreviewMetaLabel() {
    if (!this.hooks.localScreenShareStream()) return this.computeActualSettingsLabel();
    if (this.hooks.webScreenShareSenderConfigurationErrors().size > 0) {
      return this.hooks.translate("screenShare.senderSettingsNotApplied");
    }
    const telemetry = this.currentWebSenderTelemetry();
    if (!telemetry) return this.computeActualSettingsLabel();
    const unknown = this.hooks.translate("screenShare.diag.unavailable");
    const codec = telemetry.codecMimeType.split("/").at(-1)?.toUpperCase()
      || this.hooks.translate("screenShare.codecUnknown");
    const maximumBitrateMbps = this.targetBitrate(this.hooks.localScreenShareStream()?.getVideoTracks()[0] ?? null)
      / 1_000_000;
    const limitation = this.qualityLimitationLabel(telemetry.qualityLimitationReason);
    const hint = this.qualityLimitationHint(telemetry.qualityLimitationReason);
    const live = this.hooks.translate("screenShare.liveStats", {
      width: telemetry.frameWidth ?? unknown,
      height: telemetry.frameHeight ?? unknown,
      fps: telemetry.encodedFramesPerSecond === undefined ? unknown : Math.round(telemetry.encodedFramesPerSecond),
      bitrate: telemetry.bitrateBps === undefined ? unknown : this.formatMbps(telemetry.bitrateBps),
      maximum: this.formatMbps(maximumBitrateMbps * 1_000_000),
      codec
    });
    const base = limitation ? `${live} · ${hint ? `${limitation} · ${hint}` : limitation}` : live;
    // The sharer reads this line to answer "is it working", so it stays on the
    // stream itself. Which viewers are relayed and what the estimated uplink is
    // belong in diagnostics, not in the middle of the stats line.
    return base;
  }

  private currentWebSenderTelemetry() {
    const now = Date.now();
    const active = [...this.hooks.webScreenShareSenderTelemetry().entries()]
      .filter(([peerId, telemetry]) =>
        this.hooks.screenShareWatcherSessionIds().has(peerId) &&
        now - telemetry.measuredAtMS <= 4_000
      )
      .map(([, telemetry]) => telemetry);
    if (active.length === 0) return null;
    return active.sort((left, right) => {
      const limitationDifference = this.qualityLimitationRank(right.qualityLimitationReason)
        - this.qualityLimitationRank(left.qualityLimitationReason);
      if (limitationDifference !== 0) return limitationDifference;
      return (left.bitrateBps ?? Infinity) - (right.bitrateBps ?? Infinity);
    })[0];
  }

  private qualityLimitationRank(reason?: string) {
    if (reason === "bandwidth") return 3;
    if (reason === "cpu") return 2;
    if (reason === "other") return 1;
    return 0;
  }

  private qualityLimitationLabel(reason?: string) {
    if (reason === "bandwidth") return this.hooks.translate("screenShare.qualityLimitedBandwidth");
    if (reason === "cpu") return this.hooks.translate("screenShare.qualityLimitedCpu");
    if (reason === "other") return this.hooks.translate("screenShare.qualityLimitedOther");
    return "";
  }

  private qualityLimitationHint(reason?: string) {
    const hint = screenShareLimitationHint(reason);
    if (hint === "lower-bitrate") return this.hooks.translate("screenShare.qualityHintBitrate");
    if (hint === "lower-frame-rate") return this.hooks.translate("screenShare.qualityHintFrameRate");
    return "";
  }

  private formatMbps(bitrateBps: number) {
    const mbps = Math.max(0, bitrateBps) / 1_000_000;
    return mbps >= 10 ? String(Math.round(mbps)) : mbps.toFixed(1);
  }

  // ---------------------------------------------------------------------------
  // Start / stop orchestration
  // ---------------------------------------------------------------------------

  async startFromSetup() {
    if (!this.configurationSourceReady || this.frameRateUnavailable) return;
    await this.startCurrentSession();
  }

  async startCurrentSession() {
    const state = this.hooks.currentVoiceState();
    this.hooks.clearStaleCurrentMemberScreenShare();
    if (!state || !this.hooks.sessionToken() || !this.hooks.canStartScreenShareSession()) return;
    if (this.hooks.isTauriRuntime()) {
      await this.startCurrentNativeSession(state);
      return;
    }
    this.hooks.setScreenShareActionBusy(true);
    this.hooks.setError("");
    this.hooks.screenShareClearWatchers();
    let stream: MediaStream | null = null;
    try {
      stream = this.hooks.pendingWebScreenShareStream();
      this.hooks.setPendingWebScreenShareStream(null);
      // A web share takes every setting live, so no limit carries over from a
      // previous native session.
      this.shareSettingsPending = false;
      if (!stream) throw new Error(this.hooks.translate("error.screenShareNativeSourceRequired"));
      const share = await startScreenShareSession(
        this.hooks.baseUrl(),
        this.hooks.sessionToken(),
        state.channel_id,
        false
      );
      this.hooks.mergeScreenShareSession(share);
      this.hooks.attachLocalScreenShareStream(stream);
      this.hooks.flushPendingOwnedScreenShareWatchSignals(share.share_id);
      this.hooks.startWebScreenShareSignalPolling(share.share_id);
      this.closeSetup();
      this.hooks.setStatusKey(
        this.hooks.isTauriRuntime() && this.audioEnabled ? "screenShare.nativeAudioPending" : "screenShare.started"
      );
    } catch (caught) {
      if (stream) {
        this.hooks.stopMediaStream(stream);
      }
      this.hooks.setError(
        caught instanceof Error ? caught.message : this.hooks.translate("error.screenShareStartFailed")
      );
    } finally {
      this.hooks.setScreenShareActionBusy(false);
    }
  }

  async startCurrentNativeSession(state: VoiceState) {
    this.hooks.setScreenShareActionBusy(true);
    this.hooks.setError("");
    this.hooks.screenShareClearWatchers();
    let share: ScreenShareSession | null = null;
    try {
      await this.ensureNativeReady();
      const source = this.selectedDesktopCaptureSource;
      if (!source || !this.hooks.sessionToken()) return;
      const frameSize = this.desktopCaptureFrameSize(source);
      const remoteControlAllowed = Boolean(
        this.remoteControlAllowed && this.remoteControlAvailableForSource(source)
      );
      share = await startScreenShareSession(
        this.hooks.baseUrl(),
        this.hooks.sessionToken(),
        state.channel_id,
        remoteControlAllowed
      );
      this.hooks.mergeScreenShareSession(share);
      const senderSession = await startNativeScreenShareSender({
        serverId: this.hooks.server()?.server_id ?? "",
        channelId: state.channel_id,
        shareId: share.share_id,
        ownerMemberId: this.hooks.memberId(),
        sourceId: source.sourceId,
        sourceKind: source.kind,
        sourceProcessId: source.processId,
        sourceX: source.x,
        sourceY: source.y,
        sourceWidth: source.width,
        sourceHeight: source.height,
        width: frameSize.maxWidth,
        height: frameSize.maxHeight,
        frameRate: this.frameRate,
        targetBitrateBps: this.targetBitrate(),
        contentMode: this.contentMode,
        captureCursor: this.captureCursor,
        previewEnabled: this.hooks.localScreenSharePreviewRenderingEnabled(),
        includeAudio: this.audioEnabled,
        remoteControlAllowed,
        iceServers: this.hooks.rtcIceServers()
      });
      this.hooks.setNativeScreenShareSenderSession(senderSession);
      // A fresh session starts with the settings it was just given.
      this.shareSettingsPending = false;
      this.hooks.syncNativeScreenSharePreviewRendering(senderSession.sessionId);
      this.hooks.setNativeScreenShareStatusRefreshError("");
      const fallbackStatus = this.hooks.nativeScreenShareSenderStatusFallback(senderSession, {
        backend: "native-started"
      });
      this.hooks.setNativeScreenShareSenderStatus(fallbackStatus);
      this.hooks.setNativeScreenShareRegisteredViewerIds(new Set());
      this.hooks.setNativeScreenShareAppliedAnswerMemberIds(new Set());
      this.hooks.setNativeScreenShareSignalDrainInFlight(false);
      this.hooks.setNativeScreenShareSignalDrainLastAtMS(0);
      this.hooks.setNativeScreenShareViewerSyncAtMS(0);
      const initialStatus = await loadNativeScreenShareSenderStatus(senderSession.sessionId).catch(() => null);
      if (this.hooks.nativeScreenShareSenderSession()?.sessionId !== senderSession.sessionId) return;
      if (initialStatus) {
        this.hooks.applyNativeScreenShareSenderStatus(initialStatus);
      }
      this.hooks.startNativeScreenShareStatusPolling();
      this.hooks.scheduleNativeScreenShareStatusProbeBurst(senderSession.sessionId);
      this.hooks.scheduleNativeScreenShareSignalFlush(senderSession.sessionId);
      this.hooks.flushPendingOwnedScreenShareWatchSignals(share.share_id);
      this.closeSetup();
      this.hooks.setStatusKey(this.audioEnabled ? "screenShare.nativeAudioPending" : "screenShare.started");
    } catch (caught) {
      this.hooks.setNativeScreenShareSenderSession(null);
      this.hooks.stopNativeScreenShareStatusPolling();
      // A failed start has no session to apply anything to, so no pending hint.
      this.shareSettingsPending = false;
      if (share && this.hooks.sessionToken()) {
        await endScreenShareSession(this.hooks.baseUrl(), this.hooks.sessionToken(), share.share_id).catch(() => undefined);
      }
      this.hooks.setError(
        caught instanceof Error ? caught.message : this.hooks.translate("error.screenShareStartFailed")
      );
    } finally {
      this.hooks.setScreenShareActionBusy(false);
    }
  }

  async stopCurrentSession() {
    const share = this.hooks.currentMemberScreenShare();
    if (!share || !this.hooks.sessionToken() || this.hooks.screenShareActionBusy()) return;
    this.hooks.setScreenShareActionBusy(true);
    this.hooks.setError("");
    const nativeStopPromise = this.releaseLocalTransport(share);
    try {
      const ended = await this.hooks.abortableRequestWithTimeout(
        (signal) => endScreenShareSession(this.hooks.baseUrl(), this.hooks.sessionToken(), share.share_id, signal),
        3000,
        this.hooks.translate("error.screenShareStopFailed")
      );
      this.hooks.removeScreenShareSession(ended);
      this.hooks.setStatusKey("screenShare.stopped");
    } catch (caught) {
      this.hooks.removeScreenShareSession(share);
      const status = caught instanceof Error && "status" in caught ? (caught as Error & { status?: number }).status : 0;
      if (status === 404) {
        this.hooks.setStatusKey("screenShare.stopped");
      } else {
        this.hooks.setError(
          caught instanceof Error ? caught.message : this.hooks.translate("error.screenShareStopFailed")
        );
      }
    } finally {
      await nativeStopPromise;
      this.hooks.setScreenShareActionBusy(false);
    }
  }

  releaseLocalTransport(share?: ScreenShareSession | null) {
    this.closeSetup();
    const nativeStopPromise = this.stopNativeSender();
    if (share) {
      this.hooks.removeCurrentMemberScreenShareSession(share);
    } else {
      this.hooks.stopWebScreenShareSignalPolling();
      this.hooks.closeAllScreenSharePeerConnections();
      this.hooks.stopLocalScreenShareStream({ programmatic: true });
    }
    this.hooks.setScreenShareWatchingBusyIds(new Set());
    if (share && this.hooks.screenShareViewerPanelShareId() === share.share_id) {
      this.hooks.closeScreenShareViewerPanel();
    }
    this.remoteControlAllowed = false;
    this.flush();
    return nativeStopPromise;
  }

  async stopNativeSender() {
    const senderSession = this.hooks.nativeScreenShareSenderSession();
    await this.hooks.stopNativeLocalScreenSharePreview({ resumeThumbnail: false });
    this.hooks.setNativeScreenShareSenderSession(null);
    // The hint belongs to the session that could not take the change. Leaving it
    // set would make the next (web) share claim a limit it does not have.
    this.shareSettingsPending = false;
    this.hooks.stopNativeScreenShareStatusPolling();
    this.hooks.setNativeScreenShareRegisteredViewerIds(new Set());
    this.hooks.setNativeScreenShareAppliedAnswerMemberIds(new Set());
    this.hooks.setNativeScreenShareSignalDrainInFlight(false);
    this.hooks.setNativeScreenShareSignalDrainLastAtMS(0);
    this.hooks.setNativeScreenShareViewerSyncAtMS(0);
    this.hooks.remoteControlClearNativeHostId();
    if (!senderSession) return;
    await this.hooks.promiseWithTimeout(
      stopNativeScreenShareSender(senderSession.sessionId),
      1500,
      this.hooks.translate("error.screenShareStopFailed")
    ).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // View-state refresh (called from the component's legacy $: block)
  // ---------------------------------------------------------------------------

  /**
   * Recomputes the template-facing derived values. The legacy compiler does not
   * track `$state` fields read through this non-reactive controller reference,
   * so the component calls this method from a `$:` block keyed on
   * realtimeSyncTick / pendingWebScreenShareStream / screenShareAudioAvailable.
   */
  syncViewState(screenShareAudioAvailable: boolean) {
    if (!screenShareAudioAvailable && this.audioEnabled) {
      this.audioEnabled = false;
    }
    this.selectedDesktopCaptureSource = this.selectedDesktopCaptureSourceId
      ? this.desktopCaptureSources.find((source) => source.sourceId === this.selectedDesktopCaptureSourceId)
      : undefined;
    const size = this.selectedDesktopCaptureSource ? this.desktopCaptureFrameSize(this.selectedDesktopCaptureSource) : undefined;
    this.frameRateOptions = availableScreenShareFrameRates(this.desktopMediaCapabilities, size);
    this.frameRateUnavailable = !this.frameRateOptions.includes(this.frameRate);
    const pendingStream = this.hooks.pendingWebScreenShareStream();
    this.webAudioMissing = Boolean(
      !this.hooks.isTauriRuntime() &&
        pendingStream &&
        this.audioEnabled &&
        this.pendingWebAudioTrackAvailable === false
    );
    this.configurationSourceReady = this.hooks.isTauriRuntime()
      ? Boolean(this.selectedDesktopCaptureSource)
      : Boolean(pendingStream) && !this.webAudioMissing;
    this.desktopCaptureScreenSources = this.desktopCaptureSources.filter((source) => source.kind === "screen");
    this.desktopCaptureWindowSources = this.desktopCaptureSources.filter((source) => source.kind === "window");
    this.resolutionDisplayLabel = this.resolutionPresetLabel(this.resolutionPreset);
  }

  setActualSettingsLabel(label: string) {
    this.actualSettingsLabel = label;
  }

  setPreviewMetaLabel(label: string) {
    this.previewMetaLabel = label;
  }

  private flush() {
    this.syncViewState(this.hooks.screenShareAudioAvailable());
    this.hooks.flushAliases();
  }
}
