// Remote control session lifecycle and input forwarding.
//
// Owns the server-authoritative remote control session list, the request /
// approve / reject / revoke flows, the active capture state machine, local
// input capture (pointer / keyboard / wheel) with pointer-frame coalescing,
// the respect-window clock, heartbeat and refresh timers, and the native host
// lifecycle (Tauri). Native input event LISTENING stays in the workspace
// component (it lazily imports the Tauri event API) and reports into
// syncRespectWindow.
//
// Hot-path discipline: input handlers read this state directly; the
// component's legacy `$` aliases (kept fresh by the realtimeSyncTick bump)
// feed templates only.

import { flushSync, tick } from "svelte";
import {
  getRemoteControlSessions,
  heartbeatRemoteControl,
  requestRemoteControl,
  suspendRemoteControl,
  updateRemoteControl
} from "./api";
import {
  applyNativeRemoteControlInput,
  startNativeRemoteControlHost,
  stopNativeRemoteControlHost
} from "./storage";
import { normalizedRemoteControlPoint, SerialAsyncQueue } from "./remote-control";
import type {
  DesktopCaptureSource,
  DesktopMediaCapabilities,
  RemoteControlInput,
  RemoteControlInputEvent,
  RemoteControlSession,
  ScreenShareSession,
  VoiceState
} from "./types";

export type RemoteControlHooks = {
  memberId: () => string;
  sessionToken: () => string;
  baseUrl: () => string;
  activeServerId: () => string;
  eventSocket: () => WebSocket | null;
  currentVoiceState: () => VoiceState | null;
  translate: (key: string, params?: Record<string, unknown>) => string;
  setError: (message: string) => void;
  setStatusKey: (key: string) => void;
  serverRemoteControlEnabled: () => boolean;
  canRequestRemoteControl: () => boolean;
  canAcceptRemoteControl: () => boolean;
  canHostRemoteControl: () => boolean;
  isTauriRuntime: () => boolean;
  desktopMediaCapabilities: () => DesktopMediaCapabilities | null;
  desktopMediaCapabilitiesLoading: () => boolean;
  selectedDesktopCaptureSource: () => DesktopCaptureSource | undefined;
  nativeScreenShareSenderSession: () => { sessionId: string; shareId: string } | null;
  screenShareSessions: () => ScreenShareSession[];
  isWatchingScreenShare: (share: ScreenShareSession) => boolean;
  openScreenShareViewer: (share: ScreenShareSession) => void;
  focusedScreenShareId: () => string;
};

export class RemoteControlController {
  // ---- reactive state (mirrored into component $: aliases) -----------------
  sessions = $state<RemoteControlSession[]>([]);
  busyId = $state("");
  requestErrors = $state<Map<string, string>>(new Map());
  captureControlId = $state("");
  respectClock = $state(Date.now());

  // ---- internal state (no template reads) ----------------------------------
  private inputSequence = Date.now() * 1000;
  private respectSyncBusy = false;
  private respectSyncQueued = false;
  private heartbeatBusy = false;
  private heartbeatTimer: number | undefined;
  private respectTimer: number | undefined;
  private realtimeRevision = 0;
  private refreshPromise: Promise<void> | null = null;
  private clientGeneration = 0;
  private pointerFrame = 0;
  private autoStartedIds = new Set<string>();
  private nativeHostControlId = "";
  private nativeHostStartingControlId = "";
  private nativeHostStartPromise: Promise<void> | null = null;
  private pendingPointerInput: RemoteControlInputEvent | null = null;
  private readonly nativeInputQueue = new SerialAsyncQueue();

  constructor(private hooks: RemoteControlHooks) {}

  // ---- timers --------------------------------------------------------------

  /** Starts the periodic heartbeat and respect-clock timers (called on mount). */
  startTimers(): void {
    this.stopTimers();
    // Hidden tabs throttle timers far below the server's 10s lease, so a
    // backgrounded controller would burn renewals without keeping the lease.
    // Pause while hidden; the browser return recovery renews immediately.
    this.heartbeatTimer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      void this.heartbeatActive();
    }, 3000);
    this.respectTimer = window.setInterval(() => {
      if (document.visibilityState === "hidden") return;
      this.respectClock = Date.now();
    }, 250);
  }

  stopTimers(): void {
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.respectTimer) window.clearInterval(this.respectTimer);
    this.respectTimer = undefined;
  }

  /** Tear everything down on component destroy. */
  stop(): void {
    this.stopTimers();
    if (this.pointerFrame) {
      window.cancelAnimationFrame(this.pointerFrame);
      this.pointerFrame = 0;
    }
    this.pendingPointerInput = null;
    this.releaseActiveCapture();
    if (this.nativeHostControlId) {
      void stopNativeRemoteControlHost(this.nativeHostControlId).catch(() => undefined);
      this.nativeHostControlId = "";
    }
    this.nativeHostStartingControlId = "";
    this.nativeHostStartPromise = null;
  }

  // ---- refresh / heartbeat -------------------------------------------------

  async refreshSessions(): Promise<void> {
    if (!this.hooks.sessionToken()) return;
    if (this.refreshPromise) return this.refreshPromise;
    const requestBaseUrl = this.hooks.baseUrl();
    const requestSessionToken = this.hooks.sessionToken();
    const requestRevision = this.realtimeRevision;
    const requestGeneration = this.clientGeneration;
    const request = (async () => {
      try {
        const controls = await getRemoteControlSessions(requestBaseUrl, requestSessionToken);
        if (
          this.hooks.baseUrl() !== requestBaseUrl ||
          this.hooks.sessionToken() !== requestSessionToken ||
          this.realtimeRevision !== requestRevision ||
          this.clientGeneration !== requestGeneration
        ) return;
        this.replaceSessions(controls);
      } catch {
        // WebSocket events remain authoritative while a transient refresh fails.
      }
    })();
    this.refreshPromise = request;
    try {
      await request;
    } finally {
      if (this.refreshPromise === request) this.refreshPromise = null;
    }
  }

  async heartbeatActive(): Promise<void> {
    if (this.heartbeatBusy || !this.hooks.sessionToken()) return;
    const participantId = this.hooks.currentVoiceState()?.participant_id ?? "";
    const activeControls = this.sessions.filter(
      (control) => control.status === "active" && control.controller_participant_id === participantId
    );
    if (activeControls.length === 0) return;
    const requestBaseUrl = this.hooks.baseUrl();
    const requestSessionToken = this.hooks.sessionToken();
    const requestGeneration = this.clientGeneration;
    this.heartbeatBusy = true;
    try {
      const results = await Promise.allSettled(
        activeControls.map((control) => heartbeatRemoteControl(requestBaseUrl, requestSessionToken, control.control_id))
      );
      if (
        this.hooks.baseUrl() !== requestBaseUrl ||
        this.hooks.sessionToken() !== requestSessionToken ||
        this.clientGeneration !== requestGeneration
      ) return;
      let refreshRequired = false;
      for (const result of results) {
        if (result.status === "fulfilled") this.mergeSession(result.value);
        else refreshRequired = true;
      }
      if (refreshRequired) await this.refreshSessions();
    } finally {
      this.heartbeatBusy = false;
    }
  }

  // ---- queries -------------------------------------------------------------

  controlsForShare(shareId: string, controls = this.sessions): RemoteControlSession[] {
    return controls.filter((control) => control.share_id === shareId);
  }

  pendingForShare(shareId: string, controls = this.sessions): RemoteControlSession[] {
    return this.controlsForShare(shareId, controls).filter((control) => control.status === "pending");
  }

  activeForShare(shareId: string, controls = this.sessions): RemoteControlSession | undefined {
    return this.controlsForShare(shareId, controls).find((control) => control.status === "active");
  }

  currentMemberForShare(shareId: string, controls = this.sessions): RemoteControlSession | undefined {
    const participantId = this.hooks.currentVoiceState()?.participant_id ?? "";
    return this.controlsForShare(shareId, controls).find(
      (control) =>
        (participantId
          ? control.controller_participant_id === participantId
          : control.controller_member_id === this.hooks.memberId()) &&
        ["pending", "active"].includes(control.status)
    );
  }

  occupiedByOther(shareId: string): boolean {
    const active = this.activeForShare(shareId);
    if (!active) return false;
    const participantId = this.hooks.currentVoiceState()?.participant_id ?? "";
    return participantId
      ? active.controller_participant_id !== participantId
      : active.controller_member_id !== this.hooks.memberId();
  }

  isSuspended(control: RemoteControlSession | undefined): boolean {
    return Boolean(control?.respect_until_ms && control.respect_until_ms > this.respectClock);
  }

  respectSeconds(control: RemoteControlSession | undefined): number {
    if (!control?.respect_until_ms) return 0;
    return Math.max(0, Math.ceil((control.respect_until_ms - this.respectClock) / 1000));
  }

  canRequestScreenShareControl(share: ScreenShareSession): boolean {
    return Boolean(
      share.owner_member_id !== this.hooks.memberId() &&
        share.remote_control_allowed &&
        this.hooks.serverRemoteControlEnabled() &&
        this.hooks.canRequestRemoteControl() &&
        !this.activeForShare(share.share_id) &&
        this.hooks.isWatchingScreenShare(share)
    );
  }

  requestError(shareId: string): string {
    return this.requestErrors.get(shareId) ?? "";
  }

  setRequestError(shareId: string, message: string): void {
    const next = new Map(this.requestErrors);
    if (message) next.set(shareId, message);
    else next.delete(shareId);
    this.requestErrors = next;
  }

  requestUnavailableReason(share: ScreenShareSession): string {
    if (!this.hooks.serverRemoteControlEnabled()) return this.hooks.translate("remoteControl.serverFeatureDisabled");
    if (!share.remote_control_allowed) return this.hooks.translate("remoteControl.shareNotAllowed");
    if (!this.hooks.canRequestRemoteControl()) return this.hooks.translate("remoteControl.requestPermissionMissing");
    if (!this.hooks.isWatchingScreenShare(share)) return this.hooks.translate("remoteControl.watchFirst");
    if (this.occupiedByOther(share.share_id)) return this.hooks.translate("remoteControl.waitingForController");
    return "";
  }

  screenShareRemoteControlUnavailableReason(): string {
    if (!this.hooks.serverRemoteControlEnabled()) return this.hooks.translate("remoteControl.serverFeatureDisabled");
    if (!this.hooks.canAcceptRemoteControl()) return this.hooks.translate("remoteControl.acceptPermissionMissing");
    if (!this.hooks.isTauriRuntime()) return this.hooks.translate("screenShare.webRemoteControlUnavailable");
    const source = this.hooks.selectedDesktopCaptureSource();
    if (!source) return this.hooks.translate("remoteControl.chooseNativeSource");
    if (this.hooks.desktopMediaCapabilitiesLoading()) return this.hooks.translate("remoteControl.capabilitiesChecking");
    const capabilities = this.hooks.desktopMediaCapabilities();
    if (!capabilities || capabilities.platform === "unknown") {
      return this.hooks.translate("remoteControl.nativeComponentUnavailable");
    }
    if (!capabilities.remoteControlHost) return this.hooks.translate("remoteControl.nativeComponentUnavailable");
    if (!capabilities.remoteControlSourceKinds.includes(source.kind)) {
      return this.hooks.translate("remoteControl.sourceUnsupported");
    }
    return "";
  }

  // ---- session registry mutations ------------------------------------------

  replaceSessions(items: RemoteControlSession[]): void {
    this.realtimeRevision += 1;
    this.sessions = items.filter((control) => control.status === "pending" || control.status === "active");
    for (const controlId of this.autoStartedIds) {
      if (!this.sessions.some((control) => control.control_id === controlId)) {
        this.autoStartedIds.delete(controlId);
      }
    }
    if (
      this.captureControlId &&
      !this.sessions.some((control) => control.control_id === this.captureControlId && control.status === "active")
    ) {
      this.captureControlId = "";
    }
    if (
      this.nativeHostControlId &&
      !this.sessions.some((control) => control.control_id === this.nativeHostControlId && control.status === "active")
    ) {
      void stopNativeRemoteControlHost(this.nativeHostControlId).catch(() => undefined);
      this.nativeHostControlId = "";
    }
    for (const control of this.sessions) {
      if (control.status === "active" && control.owner_member_id === this.hooks.memberId()) {
        void this.ensureNativeHost(control);
      }
      if (
        control.status === "active" &&
        this.currentMemberForShare(control.share_id, [control]) &&
        this.captureControlId !== control.control_id
      ) {
        this.autoActivateCapture(control);
      }
    }
  }

  clearForShare(shareId: string): void {
    this.setRequestError(shareId, "");
    const controls = this.sessions.filter((control) => control.share_id === shareId);
    if (controls.length === 0) return;
    this.realtimeRevision += 1;
    this.sessions = this.sessions.filter((control) => control.share_id !== shareId);
    for (const control of controls) this.autoStartedIds.delete(control.control_id);
    if (controls.some((control) => control.control_id === this.captureControlId)) {
      this.captureControlId = "";
    }
    const hosted = controls.find((control) => control.control_id === this.nativeHostControlId);
    if (hosted) {
      void stopNativeRemoteControlHost(hosted.control_id).catch(() => undefined);
      this.nativeHostControlId = "";
    }
  }

  filterByChannelIds(visibleChannelIds: Set<string>): void {
    this.sessions = this.sessions.filter((control) => visibleChannelIds.has(control.channel_id));
  }

  mergeSession(control: RemoteControlSession): void {
    if (!control?.control_id) return;
    this.realtimeRevision += 1;
    if (control.controller_member_id === this.hooks.memberId()) this.setRequestError(control.share_id, "");
    if (control.status === "rejected" || control.status === "revoked") {
      this.sessions = this.sessions.filter((item) => item.control_id !== control.control_id);
      this.autoStartedIds.delete(control.control_id);
      if (this.captureControlId === control.control_id) this.captureControlId = "";
      if (this.nativeHostControlId === control.control_id) {
        void stopNativeRemoteControlHost(control.control_id).catch(() => undefined);
        this.nativeHostControlId = "";
      }
      this.hooks.setStatusKey(control.status === "rejected" ? "remoteControl.rejected" : "remoteControl.revoked");
      return;
    }
    const exists = this.sessions.some((item) => item.control_id === control.control_id);
    this.sessions = exists
      ? this.sessions.map((item) => (item.control_id === control.control_id ? control : item))
      : [...this.sessions, control];
    if (control.status === "active" && control.owner_member_id === this.hooks.memberId()) {
      void this.ensureNativeHost(control);
    }
    if (
      control.status === "active" &&
      this.currentMemberForShare(control.share_id, [control]) &&
      this.captureControlId !== control.control_id
    ) {
      this.autoActivateCapture(control);
    }
  }

  async resetClientState(): Promise<void> {
    this.clientGeneration += 1;
    this.realtimeRevision += 1;
    this.releaseActiveCapture();
    this.sessions = [];
    this.autoStartedIds.clear();
    this.requestErrors = new Map();
    this.busyId = "";
    this.respectSyncBusy = false;
    this.respectSyncQueued = false;
    if (this.pointerFrame) {
      window.cancelAnimationFrame(this.pointerFrame);
      this.pointerFrame = 0;
    }
    this.pendingPointerInput = null;

    const starting = this.nativeHostStartPromise;
    if (starting) await starting.catch(() => undefined);
    const hostedControlId = this.nativeHostControlId;
    this.nativeHostControlId = "";
    this.nativeHostStartingControlId = "";
    this.nativeHostStartPromise = null;
    if (hostedControlId) {
      await stopNativeRemoteControlHost(hostedControlId).catch(() => undefined);
    }
  }

  async endBeforeWorkspaceSwitch(targetServerId: string): Promise<void> {
    if (!this.hooks.activeServerId() || this.hooks.activeServerId() === targetServerId) return;
    if (this.hooks.sessionToken() && this.sessions.length > 0) {
      const requestBaseUrl = this.hooks.baseUrl();
      const requestSessionToken = this.hooks.sessionToken();
      const controls = [...this.sessions];
      this.releaseActiveCapture();
      const revokeRequests = Promise.allSettled(
        controls.map((control) => updateRemoteControl(requestBaseUrl, requestSessionToken, control.control_id, "revoke"))
      );
      await Promise.race([
        revokeRequests,
        new Promise<void>((resolve) => window.setTimeout(resolve, 1200))
      ]);
    }
    await this.resetClientState();
  }

  // ---- native host lifecycle ------------------------------------------------

  /** Clears the native host id after the native screen share sender stopped. */
  clearNativeHostId(): void {
    this.nativeHostControlId = "";
  }

  async prepareNativeHost(control: RemoteControlSession, sender: { sessionId: string; shareId: string }): Promise<void> {
    if (this.nativeHostControlId === control.control_id) return;
    if (
      this.nativeHostStartingControlId === control.control_id &&
      this.nativeHostStartPromise
    ) {
      await this.nativeHostStartPromise;
      return;
    }
    if (this.nativeHostStartPromise) {
      await this.nativeHostStartPromise.catch(() => undefined);
      if (this.nativeHostControlId === control.control_id) return;
    }

    const startPromise = (async () => {
      if (this.nativeHostControlId && this.nativeHostControlId !== control.control_id) {
        await stopNativeRemoteControlHost(this.nativeHostControlId).catch(() => undefined);
        this.nativeHostControlId = "";
      }
      await startNativeRemoteControlHost(control.control_id, sender.sessionId);
      this.nativeHostControlId = control.control_id;
    })();
    this.nativeHostStartingControlId = control.control_id;
    this.nativeHostStartPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.nativeHostStartPromise === startPromise) {
        this.nativeHostStartPromise = null;
        this.nativeHostStartingControlId = "";
      }
    }
  }

  async ensureNativeHost(control: RemoteControlSession): Promise<void> {
    if (control.owner_member_id !== this.hooks.memberId() || control.status !== "active") return;
    if (this.nativeHostControlId === control.control_id) return;
    const sender = this.hooks.nativeScreenShareSenderSession();
    if (
      !this.hooks.isTauriRuntime() ||
      !this.hooks.desktopMediaCapabilities()?.remoteControlHost ||
      !sender ||
      sender.shareId !== control.share_id
    ) {
      this.hooks.setError(this.hooks.translate("remoteControl.hostUnavailable"));
      await this.revoke(control).catch(() => undefined);
      return;
    }
    try {
      await this.prepareNativeHost(control, sender);
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("remoteControl.hostUnavailable"));
      await this.revoke(control).catch(() => undefined);
    }
  }

  // ---- request / decide / revoke --------------------------------------------

  async requestScreenShareControl(share: ScreenShareSession): Promise<void> {
    if (!this.hooks.sessionToken() || this.busyId) return;
    if (!this.canRequestScreenShareControl(share)) {
      this.setRequestError(share.share_id, this.requestUnavailableReason(share));
      return;
    }
    this.busyId = share.share_id;
    this.setRequestError(share.share_id, "");
    this.hooks.setError("");
    flushSync();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    const abortController = new AbortController();
    const timeout = window.setTimeout(() => abortController.abort(), 10000);
    const requestBaseUrl = this.hooks.baseUrl();
    const requestSessionToken = this.hooks.sessionToken();
    const requestGeneration = this.clientGeneration;
    try {
      const control = await requestRemoteControl(
        requestBaseUrl,
        requestSessionToken,
        share.share_id,
        abortController.signal
      );
      if (
        this.hooks.baseUrl() !== requestBaseUrl ||
        this.hooks.sessionToken() !== requestSessionToken ||
        this.clientGeneration !== requestGeneration
      ) {
        void updateRemoteControl(requestBaseUrl, requestSessionToken, control.control_id, "revoke").catch(() => undefined);
        return;
      }
      this.mergeSession(control);
      this.hooks.setStatusKey("remoteControl.pending");
      flushSync();
    } catch (caught) {
      const status = caught instanceof Error && "status" in caught
        ? Number((caught as Error & { status?: number }).status ?? 0)
        : 0;
      const code = caught instanceof Error && "code" in caught
        ? String((caught as Error & { code?: string }).code ?? "")
        : "";
      const message = abortController.signal.aborted
        ? this.hooks.translate("remoteControl.requestTimedOut")
        : code === "EV_REMOTE_CONTROL_PENDING_LIMIT"
          ? this.hooks.translate("remoteControl.tooManyPending")
          : code === "EV_REMOTE_CONTROL_REQUEST_LIMIT" || status === 429
            ? this.hooks.translate("remoteControl.requestRateLimited")
            : code === "EV_REMOTE_CONTROL_OCCUPIED" || status === 409
              ? this.hooks.translate("remoteControl.waitingForController")
              : status === 404 || status === 405
                ? this.hooks.translate("remoteControl.serverUpdateRequired")
                : caught instanceof Error && caught.message
                  ? caught.message
                  : this.hooks.translate("remoteControl.requestFailed");
      this.setRequestError(share.share_id, message);
      this.hooks.setError(message);
    } finally {
      window.clearTimeout(timeout);
      this.busyId = "";
      flushSync();
    }
  }

  async decide(control: RemoteControlSession, action: "approve" | "reject"): Promise<void> {
    if (!this.hooks.sessionToken() || this.busyId) return;
    if (action === "approve" && !this.hooks.canHostRemoteControl()) {
      this.hooks.setError(this.hooks.translate("remoteControl.hostUnavailable"));
      return;
    }
    const activeControl = this.activeForShare(control.share_id);
    if (action === "approve" && activeControl && activeControl.control_id !== control.control_id) {
      this.hooks.setError(this.hooks.translate("remoteControl.waitingForController"));
      return;
    }
    this.busyId = control.control_id;
    this.hooks.setError("");
    const requestBaseUrl = this.hooks.baseUrl();
    const requestSessionToken = this.hooks.sessionToken();
    const requestGeneration = this.clientGeneration;
    let hostPrepared = false;
    try {
      if (action === "approve") {
        const sender = this.hooks.nativeScreenShareSenderSession();
        if (!sender || sender.shareId !== control.share_id) {
          throw new Error(this.hooks.translate("remoteControl.hostUnavailable"));
        }
        await this.prepareNativeHost(control, sender);
        hostPrepared = true;
      }
      const updated = await updateRemoteControl(requestBaseUrl, requestSessionToken, control.control_id, action);
      if (
        this.hooks.baseUrl() !== requestBaseUrl ||
        this.hooks.sessionToken() !== requestSessionToken ||
        this.clientGeneration !== requestGeneration
      ) {
        if (updated.status === "active") {
          void updateRemoteControl(requestBaseUrl, requestSessionToken, control.control_id, "revoke").catch(() => undefined);
        }
        return;
      }
      this.mergeSession(updated);
    } catch (caught) {
      if (hostPrepared && this.nativeHostControlId === control.control_id) {
        await stopNativeRemoteControlHost(control.control_id).catch(() => undefined);
        this.nativeHostControlId = "";
      }
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("remoteControl.actionFailed"));
    } finally {
      this.busyId = "";
    }
  }

  async revoke(control: RemoteControlSession): Promise<void> {
    if (!this.hooks.sessionToken() || this.busyId) return;
    this.busyId = control.control_id;
    this.hooks.setError("");
    const requestBaseUrl = this.hooks.baseUrl();
    const requestSessionToken = this.hooks.sessionToken();
    const requestGeneration = this.clientGeneration;
    try {
      const updated = await updateRemoteControl(requestBaseUrl, requestSessionToken, control.control_id, "revoke");
      if (
        this.hooks.baseUrl() !== requestBaseUrl ||
        this.hooks.sessionToken() !== requestSessionToken ||
        this.clientGeneration !== requestGeneration
      ) return;
      this.mergeSession(updated);
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("remoteControl.actionFailed"));
    } finally {
      this.busyId = "";
    }
  }

  // ---- capture state machine ------------------------------------------------

  toggleCapture(control: RemoteControlSession): void {
    if (control.status !== "active" || control.controller_member_id !== this.hooks.memberId()) return;
    if (this.captureControlId === control.control_id) {
      this.releaseInputs(control);
      this.captureControlId = "";
      return;
    }
    this.activateCapture(control);
  }

  activateCapture(control: RemoteControlSession): void {
    if (control.status !== "active" || !this.currentMemberForShare(control.share_id, [control])) return;
    const share = this.hooks.screenShareSessions().find((item) => item.share_id === control.share_id);
    if (share && this.hooks.focusedScreenShareId() !== share.share_id && this.hooks.isWatchingScreenShare(share)) {
      this.hooks.openScreenShareViewer(share);
    }
    this.releaseActiveCapture();
    this.autoStartedIds.add(control.control_id);
    this.captureControlId = control.control_id;
    void tick().then(() => {
      const viewer = document.querySelector<HTMLElement>(`.screen-share-focus-media[data-control-id="${control.control_id}"]`);
      viewer?.focus();
    });
  }

  autoActivateCapture(control: RemoteControlSession): void {
    if (this.autoStartedIds.has(control.control_id)) return;
    this.activateCapture(control);
  }

  // ---- input forwarding ------------------------------------------------------

  sendInput(control: RemoteControlSession, event: RemoteControlInputEvent): void {
    if (
      this.captureControlId !== control.control_id ||
      control.status !== "active" ||
      this.isSuspended(control) ||
      this.hooks.eventSocket()?.readyState !== WebSocket.OPEN
    ) return;
    this.inputSequence += 1;
    const payload: RemoteControlInput = {
      control_id: control.control_id,
      sequence: this.inputSequence,
      event
    };
    this.hooks.eventSocket()?.send(JSON.stringify({ type: "remote_control.input", payload }));
  }

  releaseInputs(control: RemoteControlSession): void {
    if (this.captureControlId !== control.control_id) return;
    if (this.pointerFrame) {
      window.cancelAnimationFrame(this.pointerFrame);
      this.pointerFrame = 0;
    }
    this.pendingPointerInput = null;
    this.sendInput(control, { type: "release_all" });
  }

  releaseActiveCapture(): void {
    if (!this.captureControlId) return;
    const control = this.sessions.find(
      (item) => item.control_id === this.captureControlId && item.status === "active"
    );
    if (control) this.releaseInputs(control);
    this.captureControlId = "";
  }

  queuePointerInput(control: RemoteControlSession, event: RemoteControlInputEvent): void {
    this.pendingPointerInput = event;
    if (this.pointerFrame) return;
    this.pointerFrame = window.requestAnimationFrame(() => {
      this.pointerFrame = 0;
      const pending = this.pendingPointerInput;
      this.pendingPointerInput = null;
      if (pending) this.sendInput(control, pending);
    });
  }

  videoPoint(event: PointerEvent | WheelEvent, container: HTMLElement) {
    const video = container.querySelector("video");
    if (!video) return null;
    const rect = video.getBoundingClientRect();
    return normalizedRemoteControlPoint({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      intrinsicWidth: video.videoWidth,
      intrinsicHeight: video.videoHeight
    }, event.clientX, event.clientY);
  }

  handlePointerMove(event: PointerEvent, control: RemoteControlSession): void {
    if (this.captureControlId !== control.control_id) return;
    const point = this.videoPoint(event, event.currentTarget as HTMLElement);
    if (!point) return;
    this.queuePointerInput(control, { type: "pointer_move", ...point, buttons: event.buttons });
  }

  handlePointerButton(event: PointerEvent, control: RemoteControlSession, pressed: boolean): void {
    if (this.captureControlId !== control.control_id) return;
    const container = event.currentTarget as HTMLElement;
    const point = this.videoPoint(event, container);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    container.focus();
    if (pressed) container.setPointerCapture?.(event.pointerId);
    else if (container.hasPointerCapture?.(event.pointerId)) container.releasePointerCapture(event.pointerId);
    this.sendInput(control, {
      type: "pointer_button",
      ...point,
      button: event.button,
      buttons: event.buttons,
      pressed
    });
  }

  handleWheel(event: WheelEvent, control: RemoteControlSession): void {
    if (this.captureControlId !== control.control_id) return;
    const point = this.videoPoint(event, event.currentTarget as HTMLElement);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    this.sendInput(control, {
      type: "wheel",
      ...point,
      delta_x: event.deltaX,
      delta_y: event.deltaY
    });
  }

  handleKey(event: KeyboardEvent, control: RemoteControlSession, pressed: boolean): void {
    if (this.captureControlId !== control.control_id) return;
    if (pressed && event.key === "Escape") {
      event.preventDefault();
      this.releaseInputs(control);
      this.captureControlId = "";
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const modifiers: Array<"Alt" | "Control" | "Meta" | "Shift"> = [];
    if (event.altKey) modifiers.push("Alt");
    if (event.ctrlKey) modifiers.push("Control");
    if (event.metaKey) modifiers.push("Meta");
    if (event.shiftKey) modifiers.push("Shift");
    this.sendInput(control, {
      type: "key",
      code: event.code,
      key: event.key,
      pressed,
      repeat: event.repeat,
      modifiers
    });
  }

  handleInput(input: RemoteControlInput): void {
    const control = this.sessions.find((item) => item.control_id === input.control_id);
    const sender = this.hooks.nativeScreenShareSenderSession();
    if (!control || control.status !== "active" || control.owner_member_id !== this.hooks.memberId() || !sender) return;
    const senderSessionId = sender.sessionId;
    this.nativeInputQueue.enqueue(
      async () => {
        const currentControl = this.sessions.find(
          (item) => item.control_id === input.control_id && item.status === "active"
        );
        if (
          !currentControl ||
          currentControl.owner_member_id !== this.hooks.memberId() ||
          this.hooks.nativeScreenShareSenderSession()?.sessionId !== senderSessionId
        ) return;
        await applyNativeRemoteControlInput(senderSessionId, input);
      },
      (caught) => {
        const message = caught instanceof Error ? caught.message : String(caught);
        const normalized = message.toLowerCase();
        if (!normalized.includes("suspended") && !normalized.includes("not active")) this.hooks.setError(message);
      }
    );
  }

  async syncRespectWindow(controlId: string, respectUntilMs: number): Promise<void> {
    const control = this.sessions.find(
      (item) => item.control_id === controlId && item.status === "active" && item.owner_member_id === this.hooks.memberId()
    );
    if (!control || !this.hooks.sessionToken()) return;
    this.mergeSession({ ...control, respect_until_ms: respectUntilMs, updated_at_ms: Date.now() });
    this.respectSyncQueued = true;
    if (this.respectSyncBusy) return;
    this.respectSyncBusy = true;
    try {
      while (this.respectSyncQueued) {
        this.respectSyncQueued = false;
        const active = this.sessions.find(
          (item) => item.control_id === controlId && item.status === "active" && item.owner_member_id === this.hooks.memberId()
        );
        if (!active || !this.hooks.sessionToken()) break;
        const optimisticRespectUntilMS = active.respect_until_ms ?? 0;
        try {
          const updated = await suspendRemoteControl(this.hooks.baseUrl(), this.hooks.sessionToken(), controlId);
          const latest = this.sessions.find((item) => item.control_id === controlId);
          this.mergeSession({
            ...updated,
            respect_until_ms: Math.max(
              updated.respect_until_ms ?? 0,
              optimisticRespectUntilMS,
              latest?.respect_until_ms ?? 0
            )
          });
        } catch {
          // Native enforcement remains authoritative locally; later input retries server synchronization.
        }
      }
    } finally {
      this.respectSyncBusy = false;
      if (this.respectSyncQueued) {
        const latest = this.sessions.find(
          (item) => item.control_id === controlId && item.status === "active" && item.owner_member_id === this.hooks.memberId()
        );
        if (latest) void this.syncRespectWindow(controlId, latest.respect_until_ms ?? Date.now() + 3000);
      }
    }
  }
}
