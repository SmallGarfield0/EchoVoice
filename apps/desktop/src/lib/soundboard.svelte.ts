// Soundboard domain controller.
//
// Owns the soundboard feature state and actions: server/local libraries,
// the popover and its source rail, the soundboard editor, upload/delete flows,
// playback (server API + local upload path), the inbound playback audio graph,
// and the persisted playback/listening volume preferences.
//
// This file uses the .svelte.ts extension so Svelte 5 `$state` runes work
// inside the class. Template-bound DOM elements and the few variables the
// existing template still assigns directly (tab, source server, editor name,
// editor duration) stay in the workspace component and are injected through
// hooks.

import { tick } from "svelte";
import {
  deleteServerSoundboardItem,
  fetchContentAsset,
  getServer,
  getSoundboardItems,
  playSoundboardItem,
  updateServerSoundboardItem,
  uploadContentAsset,
  uploadServerSoundboardItem
} from "./api";
import {
  cacheContentAsset,
  getOrFetchContentAsset,
  readCachedContentAsset,
  sha256Hex
} from "./content-cache";
import {
  clampSoundboardVolumePercent,
  createLocalSoundboardItem,
  formatSoundboardPosition,
  loadLocalSoundboardItems,
  loadSoundboardVolumePercent,
  parseSoundboardPosition,
  saveLocalSoundboardItems,
  soundboardListeningVolumeStorageKey,
  soundboardPlaybackVolumeStorageKey,
  type LocalSoundboardItem
} from "./soundboard";
import { loadCredential } from "./storage";
import type { LocalEmojiItem } from "./emoji";
import type {
  CustomEmoji,
  ServerSummary,
  SoundboardItem,
  SoundboardPlayback,
  StoredServer,
  VoiceState
} from "./types";

const serverSoundboardLibraryStorageKey = "ev.soundboard.serverLibraries.v1";
const serverSoundboardLibraryRefreshIntervalMS = 60_000;

export type SinkAudioContext = AudioContext & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

export type SinkAudioElement = HTMLAudioElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
};

export type ActiveSoundboardAudio = {
  audio: SinkAudioElement;
  source?: MediaElementAudioSourceNode;
  gain?: GainNode;
  rawGain: number;
  listeningScaled: boolean;
  outputScaled: boolean;
};

export type ServerSoundboardLibrary = {
  serverID: string;
  serverName: string;
  serverIconDataURL: string;
  baseURL: string;
  soundboardEnabled: boolean;
  items: SoundboardItem[];
  refreshedAtMS: number;
};

export type SoundboardEditorTarget =
  | { kind: "server"; item: SoundboardItem }
  | { kind: "local"; item: LocalSoundboardItem };

type SoundboardEmojiAsset = {
  asset_sha256: string;
  size_bytes: number;
  mime_type: string;
};

type SoundboardEmojiLibraryView = {
  emojis: CustomEmoji[];
};

/**
 * Cross-cutting dependencies injected by the workspace component. Every side
 * effect that belongs to another domain (emoji, audio output, accompaniment
 * dialog state) and every template-bound DOM reference flows through these
 * lazy arrow hooks so the controller never imports the component.
 */
export type SoundboardHooks = {
  server: () => ServerSummary | null;
  baseUrl: () => string;
  sessionToken: () => string;
  savedServers: () => StoredServer[];
  currentVoiceState: () => VoiceState | null;
  canPlaySoundboard: () => boolean;
  canManageServerSoundboard: () => boolean;
  audioDeafened: () => boolean;
  selectedAudioOutputDeviceId: () => string;
  outputVolumePercent: () => number;
  accompanimentActionBusy: () => boolean;
  setAccompanimentDialogOpen: (open: boolean) => void;
  translate: (key: string, params?: Record<string, string | number>) => string;
  setError: (message: string) => void;
  customEmojis: () => CustomEmoji[];
  serverEmojiLibraries: () => ReadonlyMap<string, SoundboardEmojiLibraryView>;
  openEmojiPicker: (anchor: HTMLButtonElement, purpose: "soundboard") => Promise<void>;
  closeEmojiPicker: () => void;
  emojiPickerPurpose: () => "composer" | "soundboard";
  loadEmojiSourceSession: (serverID: string) => Promise<{ baseURL: string; sessionToken: string }>;
  ensureEmojiAsset: (item: SoundboardEmojiAsset, allowDownload: boolean, originServerID?: string) => Promise<string>;
  refreshSavedServerEmojiLibraries: () => Promise<void>;
  setAudioElementSink: (audio: HTMLAudioElement) => Promise<void>;
  // Template-bound DOM references stay owned by the component.
  popoverAnchor: () => HTMLButtonElement | null;
  popoverElement: () => HTMLDivElement | null;
  localInputElement: () => HTMLInputElement | null;
  serverInputElement: () => HTMLInputElement | null;
  managerInputElement: () => HTMLInputElement | null;
  // The existing template writes these values directly, so the component
  // keeps the variables and exposes them through getter/setter hooks.
  tab: () => "server" | "local";
  setTab: (tab: "server" | "local") => void;
  sourceServerID: () => string;
  setSourceServerID: (serverID: string) => void;
  editorDurationMS: () => number;
  setEditorDurationMS: (durationMS: number) => void;
  editorName: () => string;
  setEditorName: (name: string) => void;
};

function normalizeSoundboardItem(item: SoundboardItem): SoundboardItem {
  return {
    ...item,
    icon_emoji: item.icon_emoji ?? "",
    icon_asset_sha256: item.icon_asset_sha256 ?? "",
    start_ms: Number.isSafeInteger(item.start_ms) && item.start_ms >= 0 ? item.start_ms : 0,
    end_ms: Number.isSafeInteger(item.end_ms) && item.end_ms > 0 ? item.end_ms : 0,
    base_volume: Number.isFinite(item.base_volume)
      ? clampSoundboardVolumePercent(item.base_volume * 100) / 100
      : 1
  };
}

function loadServerSoundboardLibraries(): Map<string, ServerSoundboardLibrary> {
  const libraries = new Map<string, ServerSoundboardLibrary>();
  try {
    const parsed = JSON.parse(localStorage.getItem(serverSoundboardLibraryStorageKey) ?? "[]") as ServerSoundboardLibrary[];
    if (!Array.isArray(parsed)) return libraries;
    for (const library of parsed) {
      if (!library?.serverID || !library.baseURL || !Array.isArray(library.items)) continue;
      libraries.set(library.serverID, {
        ...library,
        serverName: library.serverName || "EchoVoice",
        serverIconDataURL: library.serverIconDataURL || "",
        soundboardEnabled: Boolean(library.soundboardEnabled),
        refreshedAtMS: Number.isFinite(library.refreshedAtMS) ? library.refreshedAtMS : 0,
        items: library.items.map(normalizeSoundboardItem).sort((left, right) => left.name.localeCompare(right.name))
      });
    }
  } catch {
    // Invalid metadata is discarded; content-addressed audio remains in the global cache.
  }
  return libraries;
}

export class SoundboardController {
  // Server-authoritative items for the active workspace.
  items = $state<SoundboardItem[]>([]);
  // Per-saved-server libraries (active server first, then cached sources).
  serverLibraries = $state<Map<string, ServerSoundboardLibrary>>(loadServerSoundboardLibraries());
  localItems = $state<LocalSoundboardItem[]>(loadLocalSoundboardItems());
  // Popover / source rail.
  popoverOpen = $state(false);
  popoverStyle = $state("");
  actionBusyId = $state("");
  // Editor.
  editorTarget = $state<SoundboardEditorTarget | null>(null);
  editorStart = $state("0:00");
  editorEnd = $state("");
  editorIconEmoji = $state("");
  editorIconAssetSHA256 = $state("");
  editorIconSizeBytes = $state(0);
  editorIconMIMEType = $state("");
  editorError = $state("");
  editorAudioURL = $state("");
  editorAudioLoading = $state(false);
  editorBaseVolumePercent = $state(100);
  editorPreviewAudio = $state<SinkAudioElement | null>(null);
  editorPreviewing = $state(false);
  editorPreviewEndTimer = 0;
  // Playback graph (not template-bound; hot paths read fields directly).
  activeAudio = new Set<HTMLAudioElement>();
  activeAudioDetails = new Map<HTMLAudioElement, ActiveSoundboardAudio>();
  audioContext = $state<SinkAudioContext | null>(null);
  handledPlaybackIds = new Set<string>();
  // Persisted volume preferences.
  playbackVolumePercent = $state(loadSoundboardVolumePercent(soundboardPlaybackVolumeStorageKey));
  listeningVolumePercent = $state(loadSoundboardVolumePercent(soundboardListeningVolumeStorageKey, true));

  private hooks: SoundboardHooks;

  constructor(hooks: SoundboardHooks) {
    this.hooks = hooks;
  }

  // ---- popover ----------------------------------------------------------------

  updatePopoverPosition() {
    const anchor = this.hooks.popoverAnchor();
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const viewportPadding = 8;
    const width = Math.min(620, window.innerWidth - viewportPadding * 2);
    const left = Math.max(
      viewportPadding,
      Math.min(rect.right - width, window.innerWidth - width - viewportPadding)
    );
    const availableHeight = Math.max(260, rect.top - viewportPadding * 2);
    const maxHeight = Math.min(560, availableHeight);
    const bottom = Math.max(viewportPadding, window.innerHeight - rect.top + 8);
    this.popoverStyle = `left: ${Math.round(left)}px; bottom: ${Math.round(bottom)}px; width: ${Math.round(width)}px; max-height: ${Math.round(maxHeight)}px;`;
  }

  async togglePopover() {
    if (this.popoverOpen) {
      this.closePopover();
      return;
    }
    const server = this.hooks.server();
    if (!server?.soundboard_enabled || !this.hooks.currentVoiceState() || this.hooks.currentVoiceState()?.mode === "listener" || !this.hooks.sessionToken() || !this.hooks.canPlaySoundboard()) return;
    if (!this.hooks.accompanimentActionBusy()) this.hooks.setAccompanimentDialogOpen(false);
    this.popoverOpen = true;
    this.hooks.setTab("server");
    this.hooks.setSourceServerID(server.server_id);
    await tick();
    this.updatePopoverPosition();
    this.hooks.popoverElement()?.focus();
    try {
      this.items = (await getSoundboardItems(this.hooks.baseUrl(), this.hooks.sessionToken())).map(normalizeSoundboardItem);
      this.syncCurrentServerLibrary();
      void this.refreshSavedServerLibraries();
      void this.hooks.refreshSavedServerEmojiLibraries();
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("soundboard.loadFailed"));
    }
  }

  async loadServerManagement() {
    const server = this.hooks.server();
    if (!server?.soundboard_enabled || !this.hooks.sessionToken() || !this.hooks.canManageServerSoundboard()) return;
    try {
      this.items = (await getSoundboardItems(this.hooks.baseUrl(), this.hooks.sessionToken())).map(normalizeSoundboardItem);
      this.syncCurrentServerLibrary();
      void this.prepareIcons(this.items, server.server_id);
      this.hooks.setError("");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("soundboard.loadFailed"));
    }
  }

  closePopover() {
    this.popoverOpen = false;
  }

  handlePopoverKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.closePopover();
    this.hooks.popoverAnchor()?.focus();
  }

  // ---- registry / server events ------------------------------------------------

  mergeItem(item: SoundboardItem) {
    if (!item?.item_id) return;
    const normalized = normalizeSoundboardItem(item);
    const exists = this.items.some((candidate) => candidate.item_id === normalized.item_id);
    this.items = (exists
      ? this.items.map((candidate) => candidate.item_id === normalized.item_id ? normalized : candidate)
      : [...this.items, normalized]
    ).sort((left, right) => left.name.localeCompare(right.name));
    this.syncCurrentServerLibrary();
    void this.prepareIcons(this.items, this.hooks.server()?.server_id ?? "");
  }

  removeItem(item: SoundboardItem) {
    if (!item?.item_id) return;
    this.items = this.items.filter((candidate) => candidate.item_id !== item.item_id);
    this.syncCurrentServerLibrary();
  }

  /** Workspace load/reload path: fetch, normalize and replace the active items. */
  async loadWorkspaceItems(serverValue: ServerSummary, token: string, signal?: AbortSignal) {
    this.items = serverValue.soundboard_enabled
      ? await getSoundboardItems(this.hooks.baseUrl(), token, signal).catch((caught) => {
          if (signal?.aborted) throw caught;
          return [];
        })
      : [];
    this.items = this.items.map(normalizeSoundboardItem);
  }

  /** Server update said soundboard is disabled: clear UI state and stop audio. */
  handleServerSoundboardDisabled() {
    this.popoverOpen = false;
    this.items = [];
    this.stopAllAudio();
  }

  /** Workspace teardown: matches the original clearActiveServerWorkspace reset. */
  resetWorkspaceState() {
    this.items = [];
    this.popoverOpen = false;
  }

  // ---- saved-server libraries -------------------------------------------------

  persistServerLibraries(next: Map<string, ServerSoundboardLibrary>) {
    this.serverLibraries = next;
    localStorage.setItem(serverSoundboardLibraryStorageKey, JSON.stringify([...next.values()]));
  }

  setServerLibrary(library: ServerSoundboardLibrary) {
    const next = new Map(this.serverLibraries);
    next.set(library.serverID, {
      ...library,
      items: library.items.map(normalizeSoundboardItem).sort((left, right) => left.name.localeCompare(right.name))
    });
    this.persistServerLibraries(next);
    void this.prepareIcons(library.items, library.serverID);
  }

  syncCurrentServerLibrary() {
    const server = this.hooks.server();
    if (!server?.server_id) return;
    this.setServerLibrary({
      serverID: server.server_id,
      serverName: server.name,
      serverIconDataURL: server.icon_data_url ?? "",
      baseURL: this.hooks.baseUrl(),
      soundboardEnabled: Boolean(server.soundboard_enabled),
      items: server.soundboard_enabled ? this.items : [],
      refreshedAtMS: Date.now()
    });
  }

  sourceLibraries() {
    const server = this.hooks.server();
    const current = server?.server_id ? {
      serverID: server.server_id,
      serverName: server.name,
      serverIconDataURL: server.icon_data_url ?? "",
      baseURL: this.hooks.baseUrl(),
      soundboardEnabled: Boolean(server.soundboard_enabled),
      items: this.items,
      refreshedAtMS: Date.now()
    } satisfies ServerSoundboardLibrary : undefined;
    const ordered = current ? [current] : [];
    for (const savedServer of this.hooks.savedServers()) {
      if (savedServer.server_id === server?.server_id) continue;
      const library = this.serverLibraries.get(savedServer.server_id);
      if (library?.soundboardEnabled && library.items.length > 0) ordered.push(library);
    }
    return ordered;
  }

  activeSourceLibrary() {
    const sourceServerID = this.hooks.sourceServerID();
    const server = this.hooks.server();
    const values = this.sourceLibraries();
    return values.find((library) => (
      library.serverID === (sourceServerID || server?.server_id)
    )) ?? values[0];
  }

  async refreshSavedServerLibrary(savedServer: StoredServer) {
    const server = this.hooks.server();
    if (savedServer.server_id === server?.server_id) {
      this.syncCurrentServerLibrary();
      return;
    }
    const cached = this.serverLibraries.get(savedServer.server_id);
    if (cached && Date.now() - cached.refreshedAtMS < serverSoundboardLibraryRefreshIntervalMS) {
      void this.prepareIcons(cached.items, cached.serverID);
      return;
    }
    const credential = await loadCredential(savedServer.server_id);
    if (!credential) return;
    const sourceServer = await getServer(savedServer.base_url);
    if (!sourceServer.soundboard_enabled) {
      this.setServerLibrary({
        serverID: savedServer.server_id,
        serverName: sourceServer.name || savedServer.name,
        serverIconDataURL: sourceServer.icon_data_url ?? savedServer.icon_data_url ?? "",
        baseURL: savedServer.base_url,
        soundboardEnabled: false,
        items: [],
        refreshedAtMS: Date.now()
      });
      return;
    }
    const sourceSession = await this.hooks.loadEmojiSourceSession(savedServer.server_id);
    const items = await getSoundboardItems(sourceSession.baseURL, sourceSession.sessionToken);
    this.setServerLibrary({
      serverID: savedServer.server_id,
      serverName: sourceServer.name || savedServer.name,
      serverIconDataURL: sourceServer.icon_data_url ?? savedServer.icon_data_url ?? "",
      baseURL: sourceSession.baseURL,
      soundboardEnabled: true,
      items,
      refreshedAtMS: Date.now()
    });
  }

  async refreshSavedServerLibraries() {
    await Promise.allSettled(this.hooks.savedServers().map((savedServer) => this.refreshSavedServerLibrary(savedServer)));
  }

  iconMetadata(item: Pick<SoundboardItem | LocalSoundboardItem, "icon_asset_sha256">, originServerID = "") {
    if (!item.icon_asset_sha256) return null;
    const server = this.hooks.server();
    if (!originServerID || originServerID === server?.server_id) {
      const current = this.hooks.customEmojis().find((emoji) => emoji.asset_sha256 === item.icon_asset_sha256);
      if (current) return current;
    }
    return this.hooks.serverEmojiLibraries().get(originServerID)?.emojis.find((emoji) => emoji.asset_sha256 === item.icon_asset_sha256) ?? null;
  }

  async prepareIcons(items: Array<SoundboardItem | LocalSoundboardItem>, originServerID = "") {
    await Promise.allSettled(items.map(async (item) => {
      if (!item.icon_asset_sha256) return;
      const metadata = "icon_size_bytes" in item && item.icon_size_bytes && item.icon_mime_type
        ? { asset_sha256: item.icon_asset_sha256, size_bytes: item.icon_size_bytes, mime_type: item.icon_mime_type }
        : this.iconMetadata(item, originServerID);
      if (metadata) await this.hooks.ensureEmojiAsset(metadata, true, originServerID);
    }));
  }

  // ---- upload / delete ---------------------------------------------------------

  async importLocal(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || this.actionBusyId) return;
    if (!file.type.startsWith("audio/")) {
      this.hooks.setError(this.hooks.translate("soundboard.audioRequired"));
      return;
    }
    this.actionBusyId = "local-import";
    try {
      const sha = await sha256Hex(file);
      await cacheContentAsset(sha, new Response(file, { headers: { "Content-Type": file.type } }));
      if (!this.localItems.some((item) => item.asset_sha256 === sha)) {
        this.localItems = [...this.localItems, createLocalSoundboardItem(file, sha)]
          .sort((left, right) => left.name.localeCompare(right.name));
        saveLocalSoundboardItems(this.localItems);
      }
      this.hooks.setError("");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("soundboard.importFailed"));
    } finally {
      this.actionBusyId = "";
    }
  }

  async uploadServer(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !this.hooks.sessionToken() || !this.hooks.canManageServerSoundboard() || this.actionBusyId) return;
    this.actionBusyId = "server-upload";
    try {
      const name = file.name.replace(/\.[^.]+$/, "").trim().slice(0, 48) || file.name.slice(0, 48);
      this.mergeItem(await uploadServerSoundboardItem(this.hooks.baseUrl(), this.hooks.sessionToken(), name, file));
      this.hooks.setError("");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("soundboard.uploadFailed"));
    } finally {
      this.actionBusyId = "";
    }
  }

  async deleteServerItem(item: SoundboardItem) {
    if (!this.hooks.sessionToken() || !this.hooks.canManageServerSoundboard() || this.actionBusyId) return;
    this.actionBusyId = item.item_id;
    try {
      this.removeItem(await deleteServerSoundboardItem(this.hooks.baseUrl(), this.hooks.sessionToken(), item.item_id));
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("soundboard.deleteFailed"));
    } finally {
      this.actionBusyId = "";
    }
  }

  deleteLocalItem(item: LocalSoundboardItem) {
    if (this.actionBusyId) return;
    this.localItems = this.localItems.filter((candidate) => candidate.local_id !== item.local_id);
    saveLocalSoundboardItems(this.localItems);
  }

  // ---- editor ------------------------------------------------------------------

  openEditor(target: SoundboardEditorTarget) {
    this.clearEditorAudio();
    this.editorTarget = target;
    this.hooks.setEditorName(target.item.name);
    this.editorStart = formatSoundboardPosition(target.item.start_ms ?? 0);
    this.editorEnd = target.item.end_ms ? formatSoundboardPosition(target.item.end_ms) : "";
    this.editorIconEmoji = target.item.icon_emoji ?? "";
    this.editorIconAssetSHA256 = target.item.icon_asset_sha256 ?? "";
    this.editorIconSizeBytes = target.kind === "local" ? target.item.icon_size_bytes ?? 0 : 0;
    this.editorIconMIMEType = target.kind === "local" ? target.item.icon_mime_type ?? "" : "";
    this.editorError = "";
    this.hooks.setEditorDurationMS(0);
    this.editorBaseVolumePercent = clampSoundboardVolumePercent((target.item.base_volume ?? 1) * 100);
    if (target.kind === "server") void this.prepareIcons([target.item], this.hooks.server()?.server_id ?? "");
    void this.prepareEditorAudio(target);
  }

  /** Compares editor targets by identity/keys because Svelte $state proxies
   * and their raw counterparts do not compare equal with `===`. */
  private editorTargetMatches(target: SoundboardEditorTarget): boolean {
    const current = this.editorTarget;
    if (current === target) return true;
    if (!current || !target || current.kind !== target.kind) return false;
    if (target.kind === "server") {
      return (current.item as SoundboardItem).item_id === (target.item as SoundboardItem).item_id;
    }
    return (current.item as LocalSoundboardItem).local_id === (target.item as LocalSoundboardItem).local_id;
  }

  closeEditor() {
    if (this.actionBusyId === "editor-save") return;
    this.resetEditor();
  }

  resetEditor() {
    if (this.hooks.emojiPickerPurpose() === "soundboard") this.hooks.closeEmojiPicker();
    this.editorTarget = null;
    this.editorError = "";
    this.clearEditorAudio();
  }

  clearEditorAudio() {
    this.stopEditorPreview();
    if (this.editorAudioURL) URL.revokeObjectURL(this.editorAudioURL);
    this.editorAudioURL = "";
    this.editorAudioLoading = false;
    this.hooks.setEditorDurationMS(0);
  }

  async prepareEditorAudio(target: SoundboardEditorTarget) {
    this.editorAudioLoading = true;
    try {
      let response = await readCachedContentAsset(target.item.asset_sha256);
      if (!response && target.kind === "server" && this.hooks.sessionToken()) {
        response = await getOrFetchContentAsset(
          target.item.asset_sha256,
          () => fetchContentAsset(this.hooks.baseUrl(), this.hooks.sessionToken(), target.item.asset_sha256)
        );
      }
      if (!response) throw new Error(this.hooks.translate("soundboard.localAssetMissing"));
      const blob = await response.blob();
      if (!this.editorTargetMatches(target)) return;
      this.editorAudioURL = URL.createObjectURL(blob);
    } catch (caught) {
      if (this.editorTargetMatches(target)) {
        this.editorError = caught instanceof Error ? caught.message : this.hooks.translate("soundboard.waveformUnavailable");
      }
    } finally {
      if (this.editorTargetMatches(target)) this.editorAudioLoading = false;
    }
  }

  updateEditorRange(startMS: number, endMS: number) {
    this.stopEditorPreview();
    this.editorStart = formatSoundboardPosition(startMS);
    this.editorEnd = endMS > 0 ? formatSoundboardPosition(endMS) : "";
    this.editorError = "";
  }

  async openIconPicker(event: MouseEvent) {
    await this.hooks.openEmojiPicker(event.currentTarget as HTMLButtonElement, "soundboard");
  }

  selectDefaultIcon(value: string) {
    this.editorIconEmoji = value;
    this.editorIconAssetSHA256 = "";
    this.editorIconSizeBytes = 0;
    this.editorIconMIMEType = "";
  }

  selectCustomIcon(emoji: CustomEmoji | LocalEmojiItem, originServerID = this.hooks.server()?.server_id ?? "") {
    this.editorIconEmoji = `:${emoji.shortcode}:`;
    this.editorIconAssetSHA256 = emoji.asset_sha256;
    this.editorIconSizeBytes = emoji.size_bytes;
    this.editorIconMIMEType = emoji.mime_type;
    void this.hooks.ensureEmojiAsset(emoji, true, originServerID);
  }

  clearIcon() {
    this.editorIconEmoji = "";
    this.editorIconAssetSHA256 = "";
    this.editorIconSizeBytes = 0;
    this.editorIconMIMEType = "";
  }

  async saveEditor() {
    const target = this.editorTarget;
    if (!target || this.actionBusyId) return;
    const name = this.hooks.editorName().trim();
    const startMS = parseSoundboardPosition(this.editorStart);
    const endMS = parseSoundboardPosition(this.editorEnd);
    if (!name || name.length > 48) {
      this.editorError = this.hooks.translate("soundboard.nameInvalid");
      return;
    }
    if (startMS === null || endMS === null || (endMS > 0 && endMS <= startMS)) {
      this.editorError = this.hooks.translate("soundboard.rangeInvalid");
      return;
    }
    if (this.hooks.editorDurationMS() > 0 && (startMS >= this.hooks.editorDurationMS() || endMS > this.hooks.editorDurationMS())) {
      this.editorError = this.hooks.translate("soundboard.rangeBeyondDuration");
      return;
    }
    this.actionBusyId = "editor-save";
    try {
      if (target.kind === "server") {
        if (!this.hooks.sessionToken() || !this.hooks.canManageServerSoundboard()) throw new Error(this.hooks.translate("soundboard.managePermissionRequired"));
        this.mergeItem(await updateServerSoundboardItem(this.hooks.baseUrl(), this.hooks.sessionToken(), target.item.item_id, {
          name,
          icon_emoji: this.editorIconEmoji,
          icon_asset_sha256: this.editorIconAssetSHA256,
          start_ms: startMS,
          end_ms: endMS,
          base_volume: this.editorBaseVolumePercent / 100
        }));
      } else {
        this.localItems = this.localItems.map((item) => item.local_id === target.item.local_id ? {
          ...item,
          name,
          icon_emoji: this.editorIconEmoji,
          icon_asset_sha256: this.editorIconAssetSHA256,
          icon_size_bytes: this.editorIconSizeBytes,
          icon_mime_type: this.editorIconMIMEType,
          start_ms: startMS,
          end_ms: endMS,
          base_volume: this.editorBaseVolumePercent / 100
        } : item).sort((left, right) => left.name.localeCompare(right.name));
        saveLocalSoundboardItems(this.localItems);
        void this.prepareIcons(this.localItems);
      }
      this.resetEditor();
    } catch (caught) {
      this.editorError = caught instanceof Error ? caught.message : this.hooks.translate("soundboard.updateFailed");
    } finally {
      this.actionBusyId = "";
    }
  }

  // ---- playback ------------------------------------------------------------------

  async playServer(item: SoundboardItem, originServerID = this.hooks.sourceServerID() || this.hooks.server()?.server_id || "") {
    const state = this.hooks.currentVoiceState();
    if (!state || !this.hooks.sessionToken() || this.actionBusyId) return;
    this.actionBusyId = item.item_id;
    try {
      const server = this.hooks.server();
      if (!originServerID || originServerID === server?.server_id) {
        await playSoundboardItem(this.hooks.baseUrl(), this.hooks.sessionToken(), {
          channel_id: state.channel_id,
          item_id: item.item_id,
          volume: this.playbackVolumePercent / 100
        });
      } else {
        const source = await this.hooks.loadEmojiSourceSession(originServerID);
        const response = await getOrFetchContentAsset(
          item.asset_sha256,
          () => fetchContentAsset(source.baseURL, source.sessionToken, item.asset_sha256)
        );
        const blob = await response.blob();
        const asset = await uploadContentAsset(
          this.hooks.baseUrl(),
          this.hooks.sessionToken(),
          "soundboard",
          new File([blob], `${item.name}.${this.fileExtension(item.mime_type)}`, { type: item.mime_type })
        );
        await playSoundboardItem(this.hooks.baseUrl(), this.hooks.sessionToken(), {
          channel_id: state.channel_id,
          asset_sha256: asset.sha256,
          name: item.name,
          volume: this.playbackVolumePercent / 100,
          base_volume: item.base_volume,
          start_ms: item.start_ms,
          end_ms: item.end_ms
        });
      }
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("soundboard.playFailed"));
    } finally {
      window.setTimeout(() => {
        if (this.actionBusyId === item.item_id) this.actionBusyId = "";
      }, 750);
    }
  }

  async playLocal(item: LocalSoundboardItem) {
    const state = this.hooks.currentVoiceState();
    if (!state || !this.hooks.sessionToken() || this.actionBusyId) return;
    this.actionBusyId = item.local_id;
    try {
      const cached = await readCachedContentAsset(item.asset_sha256);
      if (!cached) throw new Error(this.hooks.translate("soundboard.localAssetMissing"));
      const blob = await cached.blob();
      const file = new File([blob], `${item.name}.${this.fileExtension(item.mime_type)}`, { type: item.mime_type });
      const asset = await uploadContentAsset(this.hooks.baseUrl(), this.hooks.sessionToken(), "soundboard", file);
      await playSoundboardItem(this.hooks.baseUrl(), this.hooks.sessionToken(), {
        channel_id: state.channel_id,
        asset_sha256: asset.sha256,
        name: item.name,
        volume: this.playbackVolumePercent / 100,
        base_volume: item.base_volume,
        start_ms: item.start_ms,
        end_ms: item.end_ms
      });
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("soundboard.playFailed"));
    } finally {
      window.setTimeout(() => {
        if (this.actionBusyId === item.local_id) this.actionBusyId = "";
      }, 750);
    }
  }

  fileExtension(mimeType: string) {
    if (mimeType.includes("mpeg")) return "mp3";
    if (mimeType.includes("ogg") || mimeType.includes("opus")) return "ogg";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
    return "wav";
  }

  audioGainValue(detail: ActiveSoundboardAudio) {
    const listeningScale = detail.listeningScaled ? this.listeningVolumePercent / 100 : 1;
    const outputScale = detail.outputScaled ? this.hooks.outputVolumePercent() / 100 : 1;
    return Math.max(0, detail.rawGain * listeningScale * outputScale);
  }

  applyAudioGain(detail: ActiveSoundboardAudio) {
    const value = this.audioGainValue(detail);
    if (detail.gain && this.audioContext) {
      detail.gain.gain.setTargetAtTime(value, this.audioContext.currentTime, 0.01);
    } else {
      detail.audio.volume = Math.min(1, value);
    }
  }

  applyAudioGains() {
    for (const detail of this.activeAudioDetails.values()) this.applyAudioGain(detail);
  }

  async ensureAudioContext() {
    if (!this.audioContext || this.audioContext.state === "closed") {
      this.audioContext = new AudioContext() as SinkAudioContext;
    }
    if (this.audioContext.setSinkId && this.hooks.selectedAudioOutputDeviceId()) {
      await this.audioContext.setSinkId(this.hooks.selectedAudioOutputDeviceId());
    }
    if (this.audioContext.state === "suspended") await this.audioContext.resume();
    return this.audioContext;
  }

  async registerAudio(
    audio: SinkAudioElement,
    rawGain: number,
    listeningScaled: boolean,
    outputScaled = true
  ) {
    const detail: ActiveSoundboardAudio = { audio, rawGain, listeningScaled, outputScaled };
    this.activeAudioDetails.set(audio, detail);
    try {
      const context = await this.ensureAudioContext();
      detail.source = context.createMediaElementSource(audio);
      detail.gain = context.createGain();
      detail.source.connect(detail.gain);
      detail.gain.connect(context.destination);
    } catch {
      await this.hooks.setAudioElementSink(audio).catch(() => undefined);
    }
    this.applyAudioGain(detail);
    return detail;
  }

  unregisterAudio(audio: HTMLAudioElement) {
    const detail = this.activeAudioDetails.get(audio);
    detail?.source?.disconnect();
    detail?.gain?.disconnect();
    this.activeAudioDetails.delete(audio);
    this.activeAudio.delete(audio);
  }

  changePlaybackVolume(event: Event) {
    this.playbackVolumePercent = clampSoundboardVolumePercent(Number((event.currentTarget as HTMLInputElement).value));
    localStorage.setItem(soundboardPlaybackVolumeStorageKey, String(this.playbackVolumePercent));
  }

  changeListeningVolume(event: Event) {
    this.listeningVolumePercent = clampSoundboardVolumePercent(Number((event.currentTarget as HTMLInputElement).value), true);
    localStorage.setItem(soundboardListeningVolumeStorageKey, String(this.listeningVolumePercent));
    this.applyAudioGains();
  }

  changeEditorBaseVolume(event: Event) {
    this.editorBaseVolumePercent = clampSoundboardVolumePercent(Number((event.currentTarget as HTMLInputElement).value));
    if (this.editorPreviewAudio) {
      const detail = this.activeAudioDetails.get(this.editorPreviewAudio);
      if (detail) {
        detail.rawGain = this.editorBaseVolumePercent / 100;
        this.applyAudioGain(detail);
      }
    }
  }

  stopEditorPreview() {
    if (this.editorPreviewEndTimer) window.clearTimeout(this.editorPreviewEndTimer);
    this.editorPreviewEndTimer = 0;
    const audio = this.editorPreviewAudio;
    this.editorPreviewAudio = null;
    this.editorPreviewing = false;
    if (!audio) return;
    audio.pause();
    this.unregisterAudio(audio);
    audio.src = "";
  }

  async toggleEditorPreview() {
    if (this.editorPreviewAudio) {
      this.stopEditorPreview();
      return;
    }
    if (!this.editorAudioURL) return;
    const startMS = parseSoundboardPosition(this.editorStart);
    const endMS = parseSoundboardPosition(this.editorEnd);
    if (startMS === null || endMS === null || (endMS > 0 && endMS <= startMS)) {
      this.editorError = this.hooks.translate("soundboard.rangeInvalid");
      return;
    }
    const audio = new Audio(this.editorAudioURL) as SinkAudioElement;
    this.editorPreviewAudio = audio;
    this.editorPreviewing = true;
    const cleanup = () => {
      if (this.editorPreviewAudio === audio) this.stopEditorPreview();
    };
    audio.addEventListener("ended", cleanup, { once: true });
    audio.addEventListener("error", cleanup, { once: true });
    try {
      await this.registerAudio(audio, this.editorBaseVolumePercent / 100, false);
      if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise<void>((resolve, reject) => {
          audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
          audio.addEventListener("error", () => reject(new Error(this.hooks.translate("soundboard.playFailed"))), { once: true });
          audio.load();
        });
      }
      const startSeconds = startMS / 1000;
      if (Number.isFinite(audio.duration) && startSeconds >= audio.duration) throw new Error(this.hooks.translate("soundboard.rangeBeyondDuration"));
      if (startSeconds > 0) audio.currentTime = startSeconds;
      await audio.play();
      if (endMS > startMS) {
        this.editorPreviewEndTimer = window.setTimeout(cleanup, endMS - startMS + 80);
      }
    } catch (caught) {
      cleanup();
      this.editorError = caught instanceof Error ? caught.message : this.hooks.translate("soundboard.playFailed");
    }
  }

  async handlePlayback(playback: SoundboardPlayback) {
    if (!playback?.playback_id || this.handledPlaybackIds.has(playback.playback_id)) return;
    this.handledPlaybackIds.add(playback.playback_id);
    while (this.handledPlaybackIds.size > 128) {
      const oldest = this.handledPlaybackIds.values().next().value;
      if (!oldest) break;
      this.handledPlaybackIds.delete(oldest);
    }
    if (this.hooks.audioDeafened() || this.hooks.currentVoiceState()?.channel_id !== playback.channel_id || !this.hooks.sessionToken()) return;
    let cleanupPlayback: (() => void) | null = null;
    try {
      const response = await getOrFetchContentAsset(
        playback.asset_sha256,
        () => fetchContentAsset(this.hooks.baseUrl(), this.hooks.sessionToken(), playback.asset_sha256)
      );
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url) as SinkAudioElement;
      await this.registerAudio(audio, Number.isFinite(playback.volume) ? playback.volume : 1, true);
      let cleaned = false;
      let endTimer = 0;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        if (endTimer) window.clearTimeout(endTimer);
        this.unregisterAudio(audio);
        URL.revokeObjectURL(url);
        audio.src = "";
      };
      cleanupPlayback = cleanup;
      audio.addEventListener("ended", cleanup, { once: true });
      audio.addEventListener("error", cleanup, { once: true });
      this.activeAudio.add(audio);
      const delay = Math.max(0, playback.play_at_ms - Date.now());
      if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
      if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
        await new Promise<void>((resolve, reject) => {
          audio.addEventListener("loadedmetadata", () => resolve(), { once: true });
          audio.addEventListener("error", () => reject(new Error(this.hooks.translate("soundboard.playFailed"))), { once: true });
          audio.load();
        });
      }
      const startSeconds = Math.max(0, (playback.start_ms ?? 0) / 1000);
      const endSeconds = playback.end_ms ? playback.end_ms / 1000 : 0;
      if (Number.isFinite(audio.duration) && startSeconds >= audio.duration) {
        throw new Error(this.hooks.translate("soundboard.rangeBeyondDuration"));
      }
      if (startSeconds > 0) audio.currentTime = startSeconds;
      await audio.play();
      if (endSeconds > startSeconds) {
        const stopAtEnd = () => {
          if (audio.currentTime + 0.02 < endSeconds) return;
          audio.pause();
          cleanup();
        };
        audio.addEventListener("timeupdate", stopAtEnd);
        endTimer = window.setTimeout(() => {
          audio.pause();
          cleanup();
        }, Math.max(0, (endSeconds - startSeconds) * 1000 + 80));
      }
    } catch (caught) {
      cleanupPlayback?.();
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("soundboard.playFailed"));
    }
  }

  stopAllAudio() {
    this.stopEditorPreview();
    for (const audio of this.activeAudio) {
      audio.pause();
      this.unregisterAudio(audio);
      if (audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
      audio.src = "";
    }
    this.activeAudio.clear();
    this.activeAudioDetails.clear();
    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
  }

  // ---- audio output device ------------------------------------------------------

  getAudioContext() {
    return this.audioContext;
  }

  getAudioElements() {
    return [...this.activeAudio];
  }

  async syncOutputDevice(deviceID: string) {
    if (this.audioContext?.setSinkId) {
      await this.audioContext.setSinkId(deviceID);
    }
  }
}
