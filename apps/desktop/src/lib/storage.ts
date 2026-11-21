import type {
  DesktopAudioProcessSources,
  DesktopCaptureSources,
  DesktopMediaCapabilities,
  NativeScreenShareOutboundSignal,
  NativeScreenShareSenderSession,
  NativeScreenShareSenderStatus,
  NativeScreenShareStartRequest,
  NativeVoiceOutboundSignal,
  NativeAudioDevices,
  NativeMicrophoneTestStatus,
  NativeVoiceSession,
  NativeVoiceStartRequest,
  NativeVoiceStatus,
  VoiceNoiseSuppressionMode,
  LocalUserProfile,
  RemoteControlInput,
  StoredCredential,
  StoredServer
} from "./types";
import { avatarColorForIdentity, normalizeAvatarColor } from "./avatar";
import { normalizeNativeRemoteControlInputEvent } from "./remote-control";

const serversKey = "ev.servers";
const activeServerKey = "ev.activeServerId";
const legacyCredentialKey = "ev.lastCredential";
const localProfilePrefix = "ev.localProfileId";
const localUserProfileKey = "ev.userProfile.v1";
const collapsedCategoryPrefix = "ev.collapsedCategories";
const unreadCountsPrefix = "ev.unreadCounts";
const readStatePrefix = "ev.readState";
const pendingMessagesPrefix = "ev.pendingMessages";

export type StoredReadState = Record<string, { scroll_top: number; last_read_at_ms: number }>;

export type PendingMessageDraft = {
  local_id: string;
  channel_id: string;
  content: string;
  reply_to_message_id?: string;
  created_at_ms: number;
  error?: string;
};

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
let tauriInvokePromise: Promise<Invoke> | null = null;

export async function loadServers(): Promise<StoredServer[]> {
  if (isTauriRuntime()) {
    const invoke = await tauriInvoke();
    return invoke<StoredServer[]>("load_servers");
  }
  return readJson<StoredServer[]>(serversKey, []);
}

export async function saveServer(server: StoredServer): Promise<void> {
  if (isTauriRuntime()) {
    const invoke = await tauriInvoke();
    await invoke("save_server", { server });
    return;
  }
  const servers = await loadServers();
  const next = [
    server,
    ...servers.filter((item) => item.server_id !== server.server_id)
  ].sort((left, right) => right.last_connected_at_ms - left.last_connected_at_ms);
  localStorage.setItem(serversKey, JSON.stringify(next));
}

export async function removeServer(serverId: string): Promise<void> {
  if (isTauriRuntime()) {
    const invoke = await tauriInvoke();
    await invoke("remove_server", { serverId });
    await invoke("delete_server_credential", { serverId });
  } else {
    const servers = await loadServers();
    localStorage.setItem(
      serversKey,
      JSON.stringify(servers.filter((item) => item.server_id !== serverId))
    );
    localStorage.removeItem(credentialKey(serverId));
  }
  if (localStorage.getItem(activeServerKey) === serverId) {
    localStorage.removeItem(activeServerKey);
  }
}

export async function loadCredential(serverId: string): Promise<StoredCredential | null> {
  if (isTauriRuntime()) {
    const invoke = await tauriInvoke();
    return invoke<StoredCredential | null>("load_server_credential", { serverId });
  }
  return readJson<StoredCredential | null>(credentialKey(serverId), null);
}

export async function saveCredential(credential: StoredCredential): Promise<void> {
  if (isTauriRuntime()) {
    const invoke = await tauriInvoke();
    await invoke("save_server_credential", { credential });
    return;
  }
  localStorage.setItem(credentialKey(credential.server_id), JSON.stringify(credential));
  localStorage.setItem(legacyCredentialKey, JSON.stringify(credential));
}

export function loadActiveServerId(): string {
  return localStorage.getItem(activeServerKey) ?? "";
}

export function saveActiveServerId(serverId: string) {
  localStorage.setItem(activeServerKey, serverId);
}

export function loadLegacyCredential(): StoredCredential | null {
  return readJson<StoredCredential | null>(legacyCredentialKey, null);
}

export function clearLegacyCredential(): void {
  localStorage.removeItem(legacyCredentialKey);
}

export function loadLocalUserProfile(baseUrl = ""): LocalUserProfile {
  const existing = readJson<LocalUserProfile | null>(localUserProfileKey, null);
  if (existing?.local_profile_id) {
    return normalizeLocalUserProfile(existing);
  }
  const legacyId = baseUrl ? localStorage.getItem(localProfileKey(baseUrl)) ?? "" : "";
  const localProfileId = legacyId || createLocalProfileId();
  const profile: LocalUserProfile = {
    local_profile_id: localProfileId,
    display_name: "EchoVoice User",
    avatar_data_url: "",
    avatar_sha256: "",
    avatar_color: avatarColorForIdentity(localProfileId),
    bio: "",
    updated_at_ms: Date.now()
  };
  saveLocalUserProfile(profile);
  return profile;
}

export function hasLocalUserProfile(): boolean {
  return Boolean(readJson<LocalUserProfile | null>(localUserProfileKey, null)?.local_profile_id);
}

export function saveLocalUserProfile(profile: LocalUserProfile): void {
  localStorage.setItem(localUserProfileKey, JSON.stringify(normalizeLocalUserProfile(profile)));
}

export function exportLocalUserProfile(): string {
  return JSON.stringify(loadLocalUserProfile(), null, 2);
}

export function importLocalUserProfile(raw: string): LocalUserProfile {
  const parsed = JSON.parse(raw) as Partial<LocalUserProfile>;
  if (!parsed || typeof parsed !== "object" || !String(parsed.display_name ?? "").trim()) {
    throw new Error("Invalid EchoVoice profile file");
  }
  const current = loadLocalUserProfile();
  const profile = normalizeLocalUserProfile({
    local_profile_id: current.local_profile_id,
    display_name: String(parsed.display_name),
    avatar_data_url: String(parsed.avatar_data_url ?? ""),
    avatar_sha256: String(parsed.avatar_sha256 ?? ""),
    avatar_color: String(parsed.avatar_color ?? current.avatar_color ?? ""),
    bio: String(parsed.bio ?? ""),
    updated_at_ms: Date.now()
  });
  saveLocalUserProfile(profile);
  return profile;
}

export function loadCollapsedCategoryIds(serverId: string): string[] {
  if (!serverId) return [];
  return readJson<string[]>(collapsedCategoryKey(serverId), []);
}

export function saveCollapsedCategoryIds(serverId: string, categoryIds: string[]) {
  if (!serverId) return;
  localStorage.setItem(collapsedCategoryKey(serverId), JSON.stringify([...new Set(categoryIds)]));
}

export function loadUnreadCounts(serverId: string): Record<string, number> {
  if (!serverId) return {};
  return readJson<Record<string, number>>(unreadCountsKey(serverId), {});
}

export function saveUnreadCounts(serverId: string, counts: Record<string, number>) {
  if (!serverId) return;
  const normalized = Object.fromEntries(
    Object.entries(counts).filter(([, value]) => Number.isFinite(value) && value > 0)
  );
  localStorage.setItem(unreadCountsKey(serverId), JSON.stringify(normalized));
}

export function loadReadState(serverId: string): StoredReadState {
  if (!serverId) return {};
  return readJson<StoredReadState>(readStateKey(serverId), {});
}

export function saveReadState(serverId: string, state: StoredReadState) {
  if (!serverId) return;
  localStorage.setItem(readStateKey(serverId), JSON.stringify(state));
}

export function loadPendingMessages(serverId: string): PendingMessageDraft[] {
  if (!serverId) return [];
  return readJson<PendingMessageDraft[]>(pendingMessagesKey(serverId), []);
}

export function savePendingMessages(serverId: string, messages: PendingMessageDraft[]) {
  if (!serverId) return;
  const normalized = messages.filter((message) => message.channel_id && message.content.trim());
  localStorage.setItem(pendingMessagesKey(serverId), JSON.stringify(normalized));
}

export async function listDesktopCaptureSources(): Promise<DesktopCaptureSources> {
  if (isTauriRuntime()) {
    const invoke = await tauriInvoke();
    return invoke<DesktopCaptureSources>("list_desktop_capture_sources");
  }
  return {
    backend: "browser-fallback",
    sources: [],
    warnings: []
  };
}

export async function listDesktopAudioProcessSources(): Promise<DesktopAudioProcessSources> {
  if (isTauriRuntime()) {
    const invoke = await tauriInvoke();
    return invoke<DesktopAudioProcessSources>("list_desktop_audio_process_sources");
  }
  return {
    backend: "unsupported",
    sources: [],
    warnings: []
  };
}

export async function loadDesktopMediaCapabilities(): Promise<DesktopMediaCapabilities> {
  if (isTauriRuntime()) {
    const invoke = await tauriInvoke();
    return invoke<DesktopMediaCapabilities>("desktop_media_capabilities");
  }
  return {
    platform: "web",
    runtime: "web",
    sourceEnumeration: false,
    thumbnails: false,
    nativeScreenShareSender: false,
    webCaptureFallback: Boolean(navigator.mediaDevices?.getDisplayMedia),
    supportedFrameRates: [15, 30, 60, 120],
    maxNativeFrameRate: 0,
    hardwareH264Encoder: false,
    remoteControlHost: false,
    remoteControlSourceKinds: [],
    supportedSourceKinds: ["screen", "window", "browser-tab"],
    videoBackends: ["browser.getDisplayMedia"],
    audioBackends: ["browser.getDisplayMedia.audio"],
    notes: ["Web runtime uses the browser capture picker and browser WebRTC sender."]
  };
}

export async function startNativeScreenShareSender(
  request: NativeScreenShareStartRequest
): Promise<NativeScreenShareSenderSession> {
  if (!isTauriRuntime()) {
    throw new Error("native screen share sender requires the desktop client");
  }
  const invoke = await tauriInvoke();
  return invoke<NativeScreenShareSenderSession>("start_native_screen_share_sender", { request });
}

export async function stopNativeScreenShareSender(sessionId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("stop_native_screen_share_sender", { sessionId });
}

export async function loadNativeScreenShareSenderStatus(
  sessionId: string
): Promise<NativeScreenShareSenderStatus> {
  if (!isTauriRuntime()) {
    throw new Error("native screen share sender status requires the desktop client");
  }
  const invoke = await tauriInvoke();
  return invoke<NativeScreenShareSenderStatus>("native_screen_share_sender_status", { sessionId });
}

export async function setNativeScreenShareSenderPreviewEnabled(
  sessionId: string,
  enabled: boolean
): Promise<NativeScreenShareSenderStatus> {
  if (!isTauriRuntime()) {
    throw new Error("native screen share preview control requires the desktop client");
  }
  const invoke = await tauriInvoke();
  return invoke<NativeScreenShareSenderStatus>("native_screen_share_sender_set_preview_enabled", {
    request: { sessionId, enabled }
  });
}

export async function addNativeScreenShareSenderViewer(
  sessionId: string,
  memberId: string,
  watchSessionId = "",
  relayOnly = false
): Promise<NativeScreenShareSenderStatus> {
  if (!isTauriRuntime()) {
    throw new Error("native screen share sender viewer tracking requires the desktop client");
  }
  const invoke = await tauriInvoke();
  return invoke<NativeScreenShareSenderStatus>("native_screen_share_sender_add_viewer", {
    request: { sessionId, memberId, watchSessionId, relayOnly }
  });
}

export async function removeNativeScreenShareSenderViewer(
  sessionId: string,
  memberId: string,
  watchSessionId = ""
): Promise<NativeScreenShareSenderStatus> {
  if (!isTauriRuntime()) {
    throw new Error("native screen share sender viewer tracking requires the desktop client");
  }
  const invoke = await tauriInvoke();
  return invoke<NativeScreenShareSenderStatus>("native_screen_share_sender_remove_viewer", {
    request: { sessionId, memberId, watchSessionId }
  });
}

export async function handleNativeScreenShareSenderSignal(
  sessionId: string,
  memberId: string,
  signalType: string,
  data: unknown
): Promise<NativeScreenShareSenderStatus> {
  if (!isTauriRuntime()) {
    throw new Error("native screen share sender signaling requires the desktop client");
  }
  const invoke = await tauriInvoke();
  return invoke<NativeScreenShareSenderStatus>("native_screen_share_sender_handle_signal", {
    request: { sessionId, memberId, signalType, data }
  });
}

export async function setNativeScreenShareQuality(sessionId: string, setting: {kind: "frame-rate" | "max-bitrate"; value: number}) {
  const invoke = await tauriInvoke();
  return invoke<NativeScreenShareSenderStatus>("native_screen_share_sender_set_quality", { sessionId, setting });
}

export async function drainNativeScreenShareSenderSignals(
  sessionId: string
): Promise<NativeScreenShareOutboundSignal[]> {
  if (!isTauriRuntime()) return [];
  const invoke = await tauriInvoke();
  return invoke<NativeScreenShareOutboundSignal[]>("native_screen_share_sender_drain_signals", { sessionId });
}

export async function startNativeVoiceSession(request: NativeVoiceStartRequest): Promise<NativeVoiceSession> {
  if (!isTauriRuntime()) throw new Error("native voice requires the desktop client");
  const invoke = await tauriInvoke();
  return invoke<NativeVoiceSession>("start_native_voice_session", { request });
}

export async function listNativeAudioDevices(): Promise<NativeAudioDevices> {
  if (!isTauriRuntime()) return { inputs: [], outputs: [] };
  const invoke = await tauriInvoke();
  return invoke<NativeAudioDevices>("native_voice_list_devices");
}

export async function startNativeMicrophoneTest(
  inputDeviceId: string,
  outputDeviceId: string,
  inputGainPercent: number,
  outputVolumePercent: number
): Promise<NativeMicrophoneTestStatus> {
  if (!isTauriRuntime()) throw new Error("native microphone test requires the desktop client");
  const invoke = await tauriInvoke();
  return invoke<NativeMicrophoneTestStatus>("start_native_microphone_test", {
    request: { inputDeviceId, outputDeviceId, inputGainPercent, outputVolumePercent }
  });
}

export async function loadNativeMicrophoneTestStatus(sessionId: string): Promise<NativeMicrophoneTestStatus> {
  if (!isTauriRuntime()) throw new Error("native microphone test requires the desktop client");
  const invoke = await tauriInvoke();
  return invoke<NativeMicrophoneTestStatus>("native_microphone_test_status", { sessionId });
}

export async function setNativeMicrophoneTestLevels(
  sessionId: string,
  inputGainPercent: number,
  outputVolumePercent: number
): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("set_native_microphone_test_levels", {
    request: { sessionId, inputGainPercent, outputVolumePercent }
  });
}

export async function stopNativeMicrophoneTest(sessionId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("stop_native_microphone_test", { sessionId });
}

export async function testNativeHeadphones(outputDeviceId: string, outputVolumePercent: number): Promise<void> {
  if (!isTauriRuntime()) throw new Error("native headphone test requires the desktop client");
  const invoke = await tauriInvoke();
  await invoke("native_voice_test_headphones", {
    request: { outputDeviceId, outputVolumePercent }
  });
}

export async function stopNativeVoiceSession(sessionId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("stop_native_voice_session", { sessionId });
}

export async function addNativeVoicePeer(
  sessionId: string,
  memberId: string,
  initiate: boolean
): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("native_voice_add_peer", { request: { sessionId, memberId, initiate } });
}

export async function removeNativeVoicePeer(sessionId: string, memberId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("native_voice_remove_peer", { request: { sessionId, memberId } });
}

export async function handleNativeVoiceSignal(
  sessionId: string,
  memberId: string,
  signalType: NativeVoiceOutboundSignal["signalType"],
  data: unknown
): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("native_voice_handle_signal", {
    request: { sessionId, memberId, signalType, data }
  });
}

export async function setNativeVoiceState(
  sessionId: string,
  muted: boolean,
  deafened: boolean
): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("native_voice_set_state", { request: { sessionId, muted, deafened } });
}

export async function restartNativeVoiceMicrophone(
  sessionId: string,
  inputDeviceId: string
): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("native_voice_restart_microphone", { request: { sessionId, inputDeviceId } });
}

export async function setNativeVoiceLevels(
  sessionId: string,
  inputGainPercent: number,
  outputVolumePercent: number
): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("native_voice_set_levels", {
    request: { sessionId, inputGainPercent, outputVolumePercent }
  });
}

export async function setNativeVoiceNoiseSuppression(
  sessionId: string,
  mode: VoiceNoiseSuppressionMode
): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("native_voice_set_noise_suppression", {
    request: { sessionId, mode }
  });
}

export async function setNativeVoiceMemberVolume(
  sessionId: string,
  memberId: string,
  volumePercent: number
): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("native_voice_set_member_volume", {
    request: { sessionId, memberId, volumePercent }
  });
}

export async function setNativeVoiceMemberMusicVolume(
  sessionId: string,
  memberId: string,
  volumePercent: number
): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("native_voice_set_member_music_volume", {
    request: { sessionId, memberId, volumePercent }
  });
}

export async function startNativeVoiceAccompaniment(
  sessionId: string,
  processId: number,
  volumePercent: number
): Promise<void> {
  if (!isTauriRuntime()) throw new Error("music playback requires the desktop client");
  const invoke = await tauriInvoke();
  await invoke("native_voice_start_accompaniment", {
    request: { sessionId, processId, volumePercent }
  });
}

export async function setNativeVoiceAccompanimentVolume(
  sessionId: string,
  volumePercent: number
): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("native_voice_set_accompaniment_volume", {
    request: { sessionId, volumePercent }
  });
}

export async function stopNativeVoiceAccompaniment(sessionId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("native_voice_stop_accompaniment", { sessionId });
}

export async function loadNativeVoiceStatus(sessionId: string): Promise<NativeVoiceStatus> {
  if (!isTauriRuntime()) throw new Error("native voice requires the desktop client");
  const invoke = await tauriInvoke();
  return invoke<NativeVoiceStatus>("native_voice_status", { sessionId });
}

export async function drainNativeVoiceSignals(sessionId: string): Promise<NativeVoiceOutboundSignal[]> {
  if (!isTauriRuntime()) return [];
  const invoke = await tauriInvoke();
  return invoke<NativeVoiceOutboundSignal[]>("native_voice_drain_signals", { sessionId });
}

export async function minimizeDesktopWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("desktop_window_minimize");
}

export async function toggleMaximizeDesktopWindow(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  const invoke = await tauriInvoke();
  return invoke<boolean>("desktop_window_toggle_maximize");
}

export async function isDesktopWindowMaximized(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  const invoke = await tauriInvoke();
  return invoke<boolean>("desktop_window_is_maximized");
}

export async function startDraggingDesktopWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("desktop_window_start_dragging");
}

export async function closeDesktopWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("desktop_window_close");
}

export async function startDraggingScreenSharePopoutWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("screen_share_popout_start_dragging");
}

export async function startResizingScreenSharePopoutWindow(
  direction: "North" | "NorthEast" | "East" | "SouthEast" | "South" | "SouthWest" | "West" | "NorthWest"
): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("screen_share_popout_start_resize_dragging", { direction });
}

export async function closeScreenSharePopoutWindow(): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("screen_share_popout_close");
}

export async function startNativeRemoteControlHost(controlId: string, senderSessionId: string): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("remote control hosting requires the desktop client");
  }
  const invoke = await tauriInvoke();
  await invoke("start_native_remote_control_host", {
    request: { controlId, senderSessionId }
  });
}

export async function stopNativeRemoteControlHost(controlId: string): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("stop_native_remote_control_host", { request: { controlId } });
}

export async function applyNativeRemoteControlInput(
  senderSessionId: string,
  input: RemoteControlInput
): Promise<void> {
  if (!isTauriRuntime()) return;
  const invoke = await tauriInvoke();
  await invoke("apply_native_remote_control_input", {
    request: {
      controlId: input.control_id,
      senderSessionId,
      sequence: input.sequence,
      event: normalizeNativeRemoteControlInputEvent(input.event)
    }
  });
}

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

async function tauriInvoke(): Promise<Invoke> {
	tauriInvokePromise ??= import("@tauri-apps/api/core").then((api) => {
		const nativeInvoke = api.invoke as Invoke;
		const invoke: Invoke = async <T>(command: string, args?: Record<string, unknown>) => {
			try {
				return await nativeInvoke<T>(command, args);
			} catch (caught) {
				if (caught instanceof Error) throw caught;
				if (typeof caught === "string" && caught.trim()) throw new Error(caught.trim());
				if (caught && typeof caught === "object" && "message" in caught) {
					const message = String((caught as { message?: unknown }).message ?? "").trim();
					if (message) throw new Error(message);
				}
				throw new Error(`Tauri command failed: ${command}`);
			}
		};
		return invoke;
	});
	return tauriInvokePromise;
}

function credentialKey(serverId: string): string {
  return `ev.credential.${serverId}`;
}

function localProfileKey(baseUrl: string): string {
  return `${localProfilePrefix}.${encodeURIComponent(baseUrl.trim())}`;
}

function createLocalProfileId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function normalizeLocalUserProfile(profile: LocalUserProfile): LocalUserProfile {
	const localProfileId = String(profile.local_profile_id || createLocalProfileId());
	return {
		local_profile_id: localProfileId,
		display_name: String(profile.display_name || "EchoVoice User").trim().slice(0, 64),
		avatar_data_url: String(profile.avatar_data_url ?? ""),
		avatar_sha256: String(profile.avatar_sha256 ?? ""),
		avatar_color: normalizeAvatarColor(profile.avatar_color, localProfileId),
		bio: String(profile.bio ?? "").trim().slice(0, 500),
		updated_at_ms: Number(profile.updated_at_ms) > 0 ? Number(profile.updated_at_ms) : Date.now()
	};
}

function collapsedCategoryKey(serverId: string): string {
  return `${collapsedCategoryPrefix}.${serverId}`;
}

function unreadCountsKey(serverId: string): string {
  return `${unreadCountsPrefix}.${serverId}`;
}

function readStateKey(serverId: string): string {
  return `${readStatePrefix}.${serverId}`;
}

function pendingMessagesKey(serverId: string): string {
  return `${pendingMessagesPrefix}.${serverId}`;
}

function readJson<T>(key: string, fallback: T): T {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    localStorage.removeItem(key);
    return fallback;
  }
}
