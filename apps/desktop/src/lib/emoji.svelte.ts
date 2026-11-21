// Emoji domain controller.
//
// Owns the emoji feature state and actions: server/local emoji libraries and
// their persisted metadata, content-addressed asset downloads (objectURL +
// global content cache), the picker and composer autocomplete, server emoji
// management (upload/edit/delete), local pack import/creation, and the
// received-emoji detail/save flow.
//
// The workspace component keeps legacy-reactive aliases for templates and a
// handful of values the template still writes directly; those live in
// EmojiHooks below. Hot paths and mutations read/write this controller.

import { tick } from "svelte";
import {
  deleteServerEmoji,
  fetchContentAsset,
  getCustomEmojis,
  getProfile,
  getRoles,
  getServer,
  refreshSession,
  updateServerEmoji,
  uploadContentAsset,
  uploadServerEmoji
} from "./api";
import {
  cacheContentAsset,
  getOrFetchContentAsset,
  readCachedContentAsset,
  sha256Hex
} from "./content-cache";
import {
  createEmojiToken,
  createLocalEmojiItem,
  createLocalEmojiPack,
  defaultEmojiCategories,
  defaultEmojis,
  emojiAlias,
  emojiSearchScore,
  findEmojiShortcodeQuery,
  isValidEmojiID,
  loadLocalEmojiPacks,
  loadRecentEmojiKeys,
  normalizeCustomEmojiMetadataList,
  normalizeEmojiShortcode,
  parseEmojiReferences,
  recordRecentEmojiKey,
  saveLocalEmojiPacks,
  type CustomEmojiMetadata,
  type DefaultEmoji,
  type EmojiReference,
  type LocalEmojiItem,
  type LocalEmojiPack
} from "./emoji";
import { hasEffectivePermission } from "./permissions";
import { loadCredential } from "./storage";
import type {
  CustomEmoji,
  LocalUserProfile,
  Message,
  ServerSummary,
  StoredServer
} from "./types";

export type EmojiPickerEntry = {
  key: string;
  id: string;
  kind: "default" | "server" | "local";
  item: DefaultEmoji | CustomEmoji | LocalEmojiItem;
  keywords: string[];
  value: string;
  imageURL: string;
  sizeBytes: number;
  originServerID: string;
};

export type EmojiPickerSection = {
  id: string;
  kind: "server" | "local" | "recent" | "default";
  label: string;
  icon: string;
  iconDataURL: string;
  entries: EmojiPickerEntry[];
};

export type EmojiAutocompleteState = {
  start: number;
  end: number;
  query: string;
};

export type EmojiEditorContext = "server" | "local" | "quick-server";

export type EmojiServerUploadTarget = {
  serverID: string;
  serverName: string;
  serverIconDataURL: string;
  baseURL: string;
  sessionToken: string;
  emojis: CustomEmoji[];
  current: boolean;
};

export type ServerEmojiLibrary = {
  serverID: string;
  serverName: string;
  serverIconDataURL: string;
  baseURL: string;
  emojiEnabled: boolean;
  emojis: CustomEmoji[];
  refreshedAtMS: number;
};

type EmojiAssetItem = Pick<
  CustomEmoji | LocalEmojiItem | EmojiReference,
  "asset_sha256" | "size_bytes" | "mime_type"
>;

type EmojiDialogOptions = {
  title?: string;
  confirmLabel?: string;
  danger?: boolean;
};

const serverEmojiLibraryStorageKey = "ev.emoji.serverLibraries.v1";
const serverEmojiLibraryRefreshIntervalMS = 60_000;

/**
 * Cross-cutting dependencies injected by the workspace component. Every side
 * effect that belongs to another domain (soundboard, composer, workspace state)
 * and every template-bound DOM reference flows through these lazy arrow hooks
 * so the controller never imports App.svelte.
 */
export type EmojiHooks = {
  server: () => ServerSummary | null;
  baseUrl: () => string;
  sessionToken: () => string;
  savedServers: () => StoredServer[];
  localUserProfile: () => LocalUserProfile;
  canSendEmoji: () => boolean;
  canManageServerEmoji: () => boolean;
  translate: (key: string, params?: Record<string, string | number>) => string;
  setError: (message: string) => void;
  soundboardEditorTarget: () => { kind: "server" | "local" } | null;
  soundboardSelectDefaultIcon: (value: string) => void;
  soundboardSelectCustomIcon: (item: CustomEmoji | LocalEmojiItem, originServerID: string) => void;
  composerEditorElement: () => HTMLDivElement | null;
  composerSelectionRange: () => { start: number; end: number };
  composerSelectionOffsets: () => { start: number; end: number } | null;
  composerInputComposing: () => boolean;
  composerInputShellElement: () => HTMLDivElement | null;
  replaceComposerRange: (start: number, end: number, content: string) => void;
  renderComposerEditor: (content: string) => void;
  renderMessageEditEditor: (content: string) => void;
  editingMessageId: () => string;
  editingMessageDraft: () => string;
  draft: () => string;
  selectedChannelId: () => string;
  canSendMessages: () => boolean;
  showAppConfirm: (message: string, options?: EmojiDialogOptions) => Promise<boolean>;
  showAppPrompt: (
    message: string,
    initialValue?: string,
    options?: { title?: string }
  ) => Promise<string | null>;
  formatFileSize: (bytes: number) => string;
  // Template-bound DOM references stay owned by the component.
  pickerAnchor: () => HTMLButtonElement | null;
  setPickerAnchor: (element: HTMLButtonElement | null) => void;
  pickerElement: () => HTMLDivElement | null;
  setPickerElement: (element: HTMLDivElement | null) => void;
  pickerSearchInputElement: () => HTMLInputElement | null;
  setPickerSearchInputElement: (element: HTMLInputElement | null) => void;
  serverManagerInputElement: () => HTMLInputElement | null;
  setServerManagerInputElement: (element: HTMLInputElement | null) => void;
  addInputElement: () => HTMLInputElement | null;
  setAddInputElement: (element: HTMLInputElement | null) => void;
  // The existing template writes these values directly, so the component keeps
  // the variables and exposes them through getter/setter hooks.
  searchQuery: () => string;
  setSearchQuery: (value: string) => void;
  hoveredEntry: () => EmojiPickerEntry | null;
  setHoveredEntry: (entry: EmojiPickerEntry | null) => void;
  serverEditingShortcode: () => string;
  setServerEditingShortcode: (value: string) => void;
  addID: () => string;
  setAddID: (value: string) => void;
  autocompleteSelectedIndex: () => number;
  setAutocompleteSelectedIndex: (value: number) => void;
  // Bumps the component's realtimeSyncTick so legacy $: aliases refresh now
  // instead of waiting for the 100ms interval timer.
  flushAliases: () => void;
};

function loadServerEmojiLibraries(): Map<string, ServerEmojiLibrary> {
  const libraries = new Map<string, ServerEmojiLibrary>();
  try {
    const parsed = JSON.parse(localStorage.getItem(serverEmojiLibraryStorageKey) ?? "[]") as ServerEmojiLibrary[];
    if (!Array.isArray(parsed)) return libraries;
    for (const library of parsed) {
      if (!library?.serverID || !library.baseURL || !Array.isArray(library.emojis)) continue;
      libraries.set(library.serverID, {
        serverID: library.serverID,
        serverName: library.serverName || "EchoVoice",
        serverIconDataURL: library.serverIconDataURL || "",
        baseURL: library.baseURL,
        emojiEnabled: Boolean(library.emojiEnabled),
        refreshedAtMS: Number.isFinite(library.refreshedAtMS) ? library.refreshedAtMS : 0,
        emojis: normalizeCustomEmojiMetadataList(library.emojis.filter((emoji) => Boolean(emoji?.emoji_id)))
      });
    }
  } catch {
    // Invalid local metadata is discarded; verified assets remain in the global content cache.
  }
  return libraries;
}

function isSupportedEmojiMIMEType(mimeType: string) {
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mimeType);
}

function isSupportedEmojiFile(file: File) {
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type);
}

function emojiCategoryIcon(category: DefaultEmoji["category"]) {
  const icons: Record<DefaultEmoji["category"], string> = {
    people: "sentiment_satisfied",
    symbols: "favorite",
    nature: "pets",
    food: "restaurant",
    activities: "sports_esports",
    travel: "travel",
    objects: "lightbulb",
    flags: "flag"
  };
  return icons[category];
}

function emojiAssetFileName(item: Pick<EmojiAssetItem, "asset_sha256" | "mime_type">) {
  const extension = item.mime_type === "image/gif"
    ? "gif"
    : item.mime_type === "image/webp"
      ? "webp"
      : item.mime_type === "image/jpeg"
        ? "jpg"
        : "png";
  return `emoji-${item.asset_sha256.slice(0, 12)}.${extension}`;
}

function nextAvailableEmojiID(requested: string, existingIDs: string[]) {
  const existing = new Set(existingIDs);
  const base = normalizeEmojiShortcode(requested) || "emoji";
  if (!existing.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const suffixText = `_${suffix}`;
    const candidate = `${base.slice(0, 12 - suffixText.length)}${suffixText}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `emoji_${Date.now().toString(36).slice(-5)}`.slice(0, 12);
}

function uniquePickerEntries(sections: EmojiPickerSection[]) {
  const entries: EmojiPickerEntry[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    if (section.kind === "recent") continue;
    for (const entry of section.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
  }
  return entries;
}

function visiblePickerSections(
  sections: EmojiPickerSection[],
  activeSectionID: string,
  rawQuery: string
) {
  const query = rawQuery.trim().toLowerCase().replace(/^:+|:+$/g, "");
  if (!query) {
    const active = sections.find((section) => section.id === activeSectionID) ?? sections[0];
    return active ? [active] : [];
  }
  return sections
    .filter((section) => section.kind !== "recent")
    .map((section) => ({
      ...section,
      entries: section.entries
        .map((entry) => ({ entry, score: emojiSearchScore(entry.id, entry.keywords, query) }))
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id))
        .map(({ entry }) => entry)
    }))
    .filter((section) => section.entries.length > 0);
}

export class EmojiController {
  customEmojis = $state<CustomEmoji[]>([]);
  serverLibraries = $state<Map<string, ServerEmojiLibrary>>(loadServerEmojiLibraries());
  localPacks = $state<LocalEmojiPack[]>(loadLocalEmojiPacks());
  pickerPurpose = $state<"composer" | "soundboard">("composer");
  pickerOpen = $state(false);
  pickerStyle = $state("");
  pickerActiveSectionID = $state("recent");
  pickerComposerRange = $state<{ start: number; end: number } | null>(null);
  recentKeys = $state<string[]>(loadRecentEmojiKeys());
  selectedLocalPackID = $state(this.localPacks[0]?.pack_id ?? "");
  actionBusyId = $state("");
  serverUploadFile = $state<File | null>(null);
  serverUploadID = $state("");
  serverUploadPreviewURL = $state("");
  editorContext = $state<EmojiEditorContext | null>(null);
  editorFile = $state<File | null>(null);
  editorSourceURL = $state("");
  localEditorQueue = $state<File[]>([]);
  managementError = $state("");
  editingID = $state("");
  addDialogOpen = $state(false);
  addTargets = $state<EmojiServerUploadTarget[]>([]);
  addTargetsLoading = $state(false);
  addTargetsGeneration = $state(0);
  addTargetKey = $state("local");
  addFile = $state<File | null>(null);
  addPreviewURL = $state("");
  addError = $state("");
  detailReference = $state<EmojiReference | null>(null);
  objectURLs = $state<Map<string, string>>(new Map());
  autocompleteState = $state<EmojiAutocompleteState | null>(null);
  autocompleteEntries = $state<EmojiPickerEntry[]>([]);
  autocompleteLeft = $state(8);

  // Non-template hot-path caches. These never need reactive aliases.
  assetLoads = new Map<string, Promise<string>>();
  sourceSessionLoads = new Map<string, Promise<{ baseURL: string; sessionToken: string }>>();
  assetsReadyByServer = new Set<string>();

  constructor(private hooks: EmojiHooks) {}

  private flush() {
    this.hooks.flushAliases();
  }

  private persistServerLibraries(next: Map<string, ServerEmojiLibrary>) {
    this.serverLibraries = next;
    localStorage.setItem(serverEmojiLibraryStorageKey, JSON.stringify([...next.values()]));
    this.flush();
  }

  private setServerLibrary(library: ServerEmojiLibrary) {
    const next = new Map(this.serverLibraries);
    next.set(library.serverID, {
      ...library,
      emojis: normalizeCustomEmojiMetadataList(library.emojis)
    });
    this.persistServerLibraries(next);
  }

  syncCurrentLibrary(
    emojis = this.customEmojis,
    enabled = Boolean(this.hooks.server()?.emoji_enabled)
  ) {
    const server = this.hooks.server();
    if (!server?.server_id) return;
    const next = new Map(this.serverLibraries);
    next.set(server.server_id, {
      serverID: server.server_id,
      serverName: server.name,
      serverIconDataURL: server.icon_data_url ?? "",
      baseURL: this.hooks.baseUrl(),
      emojiEnabled: enabled,
      emojis: enabled ? [...emojis] : [],
      refreshedAtMS: Date.now()
    });
    this.persistServerLibraries(next);
    this.flush();
  }

  async loadSourceSession(serverID: string) {
    if (serverID === this.hooks.server()?.server_id && this.hooks.sessionToken()) {
      return { baseURL: this.hooks.baseUrl(), sessionToken: this.hooks.sessionToken() };
    }
    const pending = this.sourceSessionLoads.get(serverID);
    if (pending) return pending;
    const load = (async () => {
      const savedServer = this.hooks.savedServers().find((candidate) => candidate.server_id === serverID);
      const library = this.serverLibraries.get(serverID);
      const sourceBaseURL = savedServer?.base_url || library?.baseURL || "";
      const credential = await loadCredential(serverID);
      if (!sourceBaseURL || !credential) throw new Error(this.hooks.translate("emoji.downloadFailed"));
      const refreshed = await refreshSession(
        { ...credential, baseUrl: sourceBaseURL },
        this.hooks.localUserProfile().local_profile_id
      );
      return { baseURL: sourceBaseURL, sessionToken: refreshed.session_token };
    })().finally(() => this.sourceSessionLoads.delete(serverID));
    this.sourceSessionLoads.set(serverID, load);
    return load;
  }

  private async refreshSavedLibrary(savedServer: StoredServer) {
    if (savedServer.server_id === this.hooks.server()?.server_id) {
      this.syncCurrentLibrary();
      return;
    }
    const cached = this.serverLibraries.get(savedServer.server_id);
    if (cached) {
      void Promise.allSettled(cached.emojis.map((emoji) => this.ensureAsset(emoji, false, cached.serverID)));
      if (Date.now() - cached.refreshedAtMS < serverEmojiLibraryRefreshIntervalMS) return;
    }
    const credential = await loadCredential(savedServer.server_id);
    if (!credential) {
      const next = new Map(this.serverLibraries);
      next.delete(savedServer.server_id);
      this.persistServerLibraries(next);
      return;
    }
    const sourceServer = await getServer(savedServer.base_url);
    if (!sourceServer.emoji_enabled) {
      this.setServerLibrary({
        serverID: savedServer.server_id,
        serverName: sourceServer.name || savedServer.name,
        serverIconDataURL: sourceServer.icon_data_url ?? savedServer.icon_data_url ?? "",
        baseURL: savedServer.base_url,
        emojiEnabled: false,
        emojis: [],
        refreshedAtMS: Date.now()
      });
      return;
    }
    const sourceSession = await this.loadSourceSession(savedServer.server_id);
    const emojis = normalizeCustomEmojiMetadataList(
      await getCustomEmojis(sourceSession.baseURL, sourceSession.sessionToken)
    );
    this.setServerLibrary({
      serverID: savedServer.server_id,
      serverName: sourceServer.name || savedServer.name,
      serverIconDataURL: sourceServer.icon_data_url ?? savedServer.icon_data_url ?? "",
      baseURL: sourceSession.baseURL,
      emojiEnabled: true,
      emojis,
      refreshedAtMS: Date.now()
    });
    this.flush();
    void Promise.allSettled(
      emojis
        .filter((emoji) => emoji.size_bytes <= 1024 * 1024)
        .map((emoji) => this.ensureAsset(emoji, true, savedServer.server_id))
    );
  }

  async refreshSavedLibraries() {
    await Promise.allSettled(this.hooks.savedServers().map((savedServer) => this.refreshSavedLibrary(savedServer)));
  }

  mergeItem(emoji: CustomEmoji) {
    if (!emoji?.emoji_id) return;
    this.customEmojis = normalizeCustomEmojiMetadataList([
      ...this.customEmojis.filter((candidate) => candidate.emoji_id !== emoji.emoji_id),
      emoji
    ]).sort((left, right) => left.shortcode.localeCompare(right.shortcode));
    const normalized = this.customEmojis.find((candidate) => candidate.emoji_id === emoji.emoji_id);
    if (!normalized) return;
    const server = this.hooks.server();
    if (server?.server_id) this.assetsReadyByServer.add(`${server.server_id}:${normalized.asset_sha256}`);
    this.syncCurrentLibrary(this.customEmojis, true);
    void this.prepareAssets([normalized]);
    this.hooks.renderComposerEditor(this.hooks.draft());
    this.flush();
  }

  removeItem(emoji: CustomEmoji) {
    if (!emoji?.emoji_id) return;
    this.customEmojis = this.customEmojis.filter((candidate) => candidate.emoji_id !== emoji.emoji_id);
    this.syncCurrentLibrary(this.customEmojis, true);
    this.hooks.renderComposerEditor(this.hooks.draft());
    this.flush();
  }

  availableAliases(): CustomEmojiMetadata[] {
    const server = this.hooks.server();
    if (!server?.emoji_enabled || !this.hooks.canSendEmoji()) return [];
    const items: CustomEmojiMetadata[] = [];
    const seen = new Set<string>();
    for (const emoji of [
      ...this.customEmojis,
      ...this.hooks.savedServers()
        .filter((savedServer) => savedServer.server_id !== server?.server_id)
        .flatMap((savedServer) => {
          const library = this.serverLibraries.get(savedServer.server_id);
          return library?.emojiEnabled ? library.emojis : [];
        }),
      ...this.localPacks.flatMap((pack) => pack.emojis)
    ]) {
      if (!isValidEmojiID(emoji.shortcode) || seen.has(emoji.shortcode)) continue;
      seen.add(emoji.shortcode);
      items.push(emoji);
    }
    return items;
  }

  private pickerEntry(
    item: DefaultEmoji | CustomEmoji | LocalEmojiItem,
    kind: EmojiPickerEntry["kind"],
    key: string,
    originServerID = ""
  ): EmojiPickerEntry {
    if (kind === "default") {
      const emoji = item as DefaultEmoji;
      return {
        key,
        id: emoji.id,
        kind,
        item,
        keywords: emoji.keywords,
        value: emoji.value,
        imageURL: emoji.imageURL ?? "",
        sizeBytes: 0,
        originServerID: ""
      };
    }
    const emoji = item as CustomEmoji | LocalEmojiItem;
    return {
      key,
      id: emoji.shortcode,
      kind,
      item,
      keywords: [],
      value: "",
      imageURL: this.objectURLs.get(emoji.asset_sha256) ?? "",
      sizeBytes: emoji.size_bytes,
      originServerID
    };
  }

  buildPickerSections(): EmojiPickerSection[] {
    const sections: EmojiPickerSection[] = [];
    const sourceSections: EmojiPickerSection[] = [];
    const server = this.hooks.server();
    const soundboardServerIconMode = this.pickerPurpose === "soundboard" && this.hooks.soundboardEditorTarget()?.kind === "server";
    const canBrowseCustomEmoji = Boolean(server?.emoji_enabled && (this.pickerPurpose === "soundboard" || this.hooks.canSendEmoji()));

    if (server && canBrowseCustomEmoji) {
      const orderedServerIDs = soundboardServerIconMode
        ? [server.server_id]
        : [
            server.server_id,
            ...this.hooks.savedServers().map((savedServer) => savedServer.server_id).filter((serverID) => serverID !== server.server_id)
          ];
      for (const serverID of orderedServerIDs) {
        const library = serverID === server.server_id
          ? {
              serverID,
              serverName: server.name,
              serverIconDataURL: server.icon_data_url ?? "",
              baseURL: this.hooks.baseUrl(),
              emojiEnabled: true,
              emojis: this.customEmojis,
              refreshedAtMS: Date.now()
            }
          : this.serverLibraries.get(serverID);
        if (!library?.emojiEnabled || library.emojis.length === 0) continue;
        sourceSections.push({
          id: `server:${serverID}`,
          kind: "server",
          label: library.serverName,
          icon: "dns",
          iconDataURL: library.serverIconDataURL,
          entries: library.emojis.map((emoji) => this.pickerEntry(
            emoji,
            "server",
            `server:${serverID}:${emoji.emoji_id}`,
            serverID
          ))
        });
      }
    }

    if (canBrowseCustomEmoji && !soundboardServerIconMode) {
      for (const pack of this.localPacks) {
        const entries = pack.emojis.map((emoji) => this.pickerEntry(
          emoji,
          "local",
          `local:${pack.pack_id}:${emoji.local_id}`
        ));
        if (entries.length === 0) continue;
        sourceSections.push({
          id: `local:${pack.pack_id}`,
          kind: "local",
          label: pack.name,
          icon: "inventory_2",
          iconDataURL: "",
          entries
        });
      }
    }

    const customIDs = new Set(sourceSections.flatMap((section) => section.entries.map((entry) => entry.id)));

    const defaultSections = defaultEmojiCategories.map((category) => ({
      id: `default:${category.id}`,
      kind: "default" as const,
      label: this.hooks.translate(category.labelKey),
      icon: emojiCategoryIcon(category.id),
      iconDataURL: "",
      entries: defaultEmojis
        .filter((emoji) => emoji.category === category.id && !customIDs.has(emoji.id))
        .map((emoji) => this.pickerEntry(emoji, "default", `default:${emoji.id}`))
    }));

    const entriesByKey = new Map(
      [...sourceSections, ...defaultSections].flatMap((section) => section.entries).map((entry) => [entry.key, entry])
    );
    const recentEntries = this.recentKeys
      .map((key) => entriesByKey.get(key))
      .filter((entry): entry is EmojiPickerEntry => Boolean(entry));

    sections.push(...sourceSections.filter((section) => section.kind === "server"));
    sections.push({
      id: "recent",
      kind: "recent",
      label: this.hooks.translate("emoji.recent"),
      icon: "history",
      iconDataURL: "",
      entries: recentEntries
    });
    sections.push(...sourceSections.filter((section) => section.kind === "local"), ...defaultSections);
    return sections;
  }

  visiblePickerSections(
    sections: EmojiPickerSection[],
    activeSectionID: string,
    rawQuery: string
  ) {
    return visiblePickerSections(sections, activeSectionID, rawQuery);
  }

  private currentLocalPack() {
    return this.localPacks.find((pack) => pack.pack_id === this.selectedLocalPackID) ?? this.localPacks[0];
  }

  objectURL(sha256: string) {
    return this.objectURLs.get(sha256) ?? "";
  }

  async prepareAssets(items: EmojiAssetItem[]) {
    await Promise.allSettled(items.map((item) => this.ensureAsset(item, item.size_bytes <= 1024 * 1024)));
  }

  async prepareMessageAssets(nextMessages: Array<Pick<Message, "content">>) {
    const references = nextMessages.flatMap((message) => parseEmojiReferences(message.content));
    await this.prepareAssets(references);
  }

  async refreshItems(downloadLarge = false) {
    const server = this.hooks.server();
    if (!server?.emoji_enabled || !this.hooks.sessionToken()) {
      this.customEmojis = [];
      this.syncCurrentLibrary([], false);
      return;
    }
    this.customEmojis = normalizeCustomEmojiMetadataList(
      await getCustomEmojis(this.hooks.baseUrl(), this.hooks.sessionToken())
    );
    this.syncCurrentLibrary(this.customEmojis, true);
    for (const emoji of this.customEmojis) {
      this.assetsReadyByServer.add(`${server.server_id}:${emoji.asset_sha256}`);
    }
    if (downloadLarge) {
      await Promise.allSettled(this.customEmojis.map((emoji) => this.ensureAsset(emoji, true)));
    } else {
      void this.prepareAssets(this.customEmojis);
    }
    this.hooks.renderComposerEditor(this.hooks.draft());
    this.flush();
  }

  async loadWorkspaceItems(loadedServer: ServerSummary, token: string, signal?: AbortSignal) {
    this.customEmojis = loadedServer.emoji_enabled
      ? await getCustomEmojis(this.hooks.baseUrl(), token, signal).catch((caught) => {
          if (signal?.aborted) throw caught;
          return [];
        })
      : [];
    signal?.throwIfAborted();
    this.syncCurrentLibrary(this.customEmojis, loadedServer.emoji_enabled);
    for (const emoji of this.customEmojis) {
      this.assetsReadyByServer.add(`${loadedServer.server_id}:${emoji.asset_sha256}`);
    }
    void this.prepareAssets(this.customEmojis);
  }

  handleServerEmojiDisabled() {
    this.detailReference = null;
    this.customEmojis = [];
    this.syncCurrentLibrary([], false);
    if (this.pickerActiveSectionID.startsWith("server:")) this.pickerActiveSectionID = "default:people";
    this.flush();
  }

  resetWorkspaceState() {
    this.customEmojis = [];
    this.pickerOpen = false;
    this.pickerStyle = "";
    this.hooks.setHoveredEntry(null);
    this.resetAddDialog();
    this.hideAutocomplete();
    this.cancelEditor();
    this.detailReference = null;
    this.flush();
  }

  async ensureAsset(
    item: EmojiAssetItem,
    allowDownload: boolean,
    originServerID = ""
  ) {
    const existing = this.objectURL(item.asset_sha256);
    if (existing) return existing;
    const pending = this.assetLoads.get(item.asset_sha256);
    if (pending) {
      const resolved = await pending;
      if (resolved || !allowDownload) return resolved;
      // A metadata preload for a large asset may have intentionally completed
      // without downloading. A later, user-confirmed request must be allowed to
      // escalate that same SHA-256 to a real download.
      const escalated = this.assetLoads.get(item.asset_sha256);
      if (escalated && escalated !== pending) return escalated;
    }
    const load = (async () => {
      let response = await readCachedContentAsset(item.asset_sha256);
      if (!response) {
        if (!allowDownload) return "";
        const source = originServerID
          ? await this.loadSourceSession(originServerID)
          : this.hooks.sessionToken()
            ? { baseURL: this.hooks.baseUrl(), sessionToken: this.hooks.sessionToken() }
            : null;
        if (!source) return "";
        response = await getOrFetchContentAsset(
          item.asset_sha256,
          () => fetchContentAsset(source.baseURL, source.sessionToken, item.asset_sha256)
        );
      }
      const blob = await response.blob();
      if (blob.size !== item.size_bytes || blob.type !== item.mime_type) {
        throw new Error(this.hooks.translate("emoji.assetMismatch"));
      }
      const url = URL.createObjectURL(blob);
      const previous = this.objectURLs.get(item.asset_sha256);
      if (previous) {
        URL.revokeObjectURL(url);
        return previous;
      }
      this.objectURLs = new Map(this.objectURLs).set(item.asset_sha256, url);
      this.flush();
      void tick().then(() => {
        this.hooks.renderComposerEditor(this.hooks.draft());
        if (this.hooks.editingMessageId()) this.hooks.renderMessageEditEditor(this.hooks.editingMessageDraft());
      });
      return url;
    })().finally(() => this.assetLoads.delete(item.asset_sha256));
    this.assetLoads.set(item.asset_sha256, load);
    return load;
  }

  private originServerIDForAsset(assetSHA256: string) {
    const server = this.hooks.server();
    if (server?.server_id && this.customEmojis.some((emoji) => emoji.asset_sha256 === assetSHA256)) {
      return server.server_id;
    }
    for (const savedServer of this.hooks.savedServers()) {
      if (savedServer.server_id === server?.server_id) continue;
      const library = this.serverLibraries.get(savedServer.server_id);
      if (library?.emojiEnabled && library.emojis.some((emoji) => emoji.asset_sha256 === assetSHA256)) {
        return savedServer.server_id;
      }
    }
    return "";
  }

  async ensureAssetOnCurrentServer(item: EmojiAssetItem, originServerID = "") {
    const server = this.hooks.server();
    if (!server?.server_id || !this.hooks.sessionToken() || !server.emoji_enabled || !this.hooks.canSendEmoji()) {
      throw new Error(this.hooks.translate("emoji.permissionRequired"));
    }
    const readyKey = `${server.server_id}:${item.asset_sha256}`;
    if (this.assetsReadyByServer.has(readyKey)) return;
    if (originServerID === server.server_id) {
      this.assetsReadyByServer.add(readyKey);
      return;
    }
    const resolvedOriginServerID = originServerID || this.originServerIDForAsset(item.asset_sha256);
    await this.ensureAsset(item, true, resolvedOriginServerID);
    const response = await readCachedContentAsset(item.asset_sha256);
    if (!response) throw new Error(this.hooks.translate("emoji.downloadFailed"));
    const blob = await response.blob();
    if (blob.size !== item.size_bytes || blob.type !== item.mime_type) {
      throw new Error(this.hooks.translate("emoji.assetMismatch"));
    }
    const uploaded = await uploadContentAsset(
      this.hooks.baseUrl(),
      this.hooks.sessionToken(),
      "emoji",
      new File([blob], emojiAssetFileName(item), { type: item.mime_type })
    );
    if (
      uploaded.sha256 !== item.asset_sha256 ||
      uploaded.size_bytes !== item.size_bytes ||
      uploaded.mime_type !== item.mime_type
    ) {
      throw new Error(this.hooks.translate("emoji.assetMismatch"));
    }
    this.assetsReadyByServer.add(readyKey);
  }

  async ensureMessageAssetsOnCurrentServer(content: string) {
    const references = parseEmojiReferences(content);
    const seen = new Set<string>();
    for (const reference of references) {
      if (seen.has(reference.asset_sha256)) continue;
      seen.add(reference.asset_sha256);
      if (!this.objectURL(reference.asset_sha256) && reference.size_bytes > 1024 * 1024) {
        const confirmed = await this.hooks.showAppConfirm(
          this.hooks.translate("emoji.largeDownloadConfirm", {
            size: this.hooks.formatFileSize(reference.size_bytes),
            name: emojiAlias(reference.shortcode)
          }),
          { title: this.hooks.translate("emoji.largeDownloadTitle"), confirmLabel: this.hooks.translate("emoji.download") }
        );
        if (!confirmed) return false;
      }
      await this.ensureAssetOnCurrentServer(
        reference,
        this.originServerIDForAsset(reference.asset_sha256)
      );
    }
    return true;
  }

  updatePickerPosition() {
    const anchor = this.hooks.pickerAnchor();
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const viewportPadding = 8;
    const gap = 8;
    const width = Math.min(420, window.innerWidth - viewportPadding * 2);
    const height = Math.min(440, window.innerHeight - viewportPadding * 2);
    const left = Math.max(
      viewportPadding,
      Math.min(rect.right - width, window.innerWidth - width - viewportPadding)
    );
    const above = rect.top - height - gap;
    const top = above >= viewportPadding
      ? above
      : Math.min(rect.bottom + gap, window.innerHeight - height - viewportPadding);
    this.pickerStyle = `left: ${Math.round(left)}px; top: ${Math.round(Math.max(viewportPadding, top))}px; width: ${Math.round(width)}px; height: ${Math.round(height)}px;`;
    this.flush();
  }

  async togglePicker(event: MouseEvent) {
    if (this.pickerOpen) {
      this.closePicker();
      return;
    }
    await this.openPicker(event.currentTarget as HTMLButtonElement, "composer");
  }

  async openPicker(
    anchor = this.hooks.pickerAnchor(),
    purpose: "composer" | "soundboard" = "composer"
  ) {
    if (purpose === "composer" && (!this.hooks.selectedChannelId() || !this.hooks.canSendMessages())) return;
    if (purpose === "soundboard" && !this.hooks.soundboardEditorTarget()) return;
    this.pickerPurpose = purpose;
    this.pickerComposerRange = purpose === "composer" ? this.hooks.composerSelectionRange() : null;
    this.hooks.setPickerAnchor(anchor);
    this.pickerOpen = true;
    this.hooks.setSearchQuery("");
    this.hooks.setHoveredEntry(null);
    await tick();
    const sections = this.buildPickerSections();
    this.pickerActiveSectionID = purpose === "soundboard"
      ? sections.find((section) => section.kind === "server" && section.entries.length > 0)?.id
        ?? sections.find((section) => section.id === "default:people")?.id
        ?? sections[0]?.id
        ?? ""
      : sections.some((section) => section.id === "recent" && section.entries.length > 0)
        ? "recent"
        : sections.find((section) => section.id === "default:people")?.id ?? sections[0]?.id ?? "";
    this.flush();
    await tick();
    this.updatePickerPosition();
    this.hooks.pickerSearchInputElement()?.focus({ preventScroll: true });
    const server = this.hooks.server();
    if (!server?.emoji_enabled || !this.hooks.sessionToken() || (purpose === "composer" && !this.hooks.canSendEmoji())) return;
    try {
      await this.refreshItems();
      void this.refreshSavedLibraries();
      void Promise.allSettled(
        this.localPacks.flatMap((pack) => pack.emojis).map((emoji) => this.ensureAsset(emoji, true))
      );
      await tick();
      this.updatePickerPosition();
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("emoji.loadFailed"));
    }
  }

  closePicker() {
    if (this.actionBusyId) return;
    this.pickerOpen = false;
    this.pickerComposerRange = null;
    this.hooks.setSearchQuery("");
    this.hooks.setHoveredEntry(null);
    this.pickerStyle = "";
    this.pickerPurpose = "composer";
    this.flush();
  }

  async selectPickerEntry(entry: EmojiPickerEntry) {
    if (this.pickerPurpose !== "soundboard") {
      await this.insertIntoComposer(entry.item, entry.key, undefined, entry.originServerID);
      return;
    }
    if (entry.kind === "default") {
      this.hooks.soundboardSelectDefaultIcon(entry.value);
    } else {
      this.hooks.soundboardSelectCustomIcon(entry.item as CustomEmoji | LocalEmojiItem, entry.originServerID);
    }
    const anchor = this.hooks.pickerAnchor();
    this.closePicker();
    await tick();
    anchor?.focus({ preventScroll: true });
  }

  selectPickerSection(sectionID: string) {
    this.pickerActiveSectionID = sectionID;
    this.hooks.setSearchQuery("");
    this.hooks.setHoveredEntry(null);
    this.flush();
    void tick().then(() => this.hooks.pickerSearchInputElement()?.focus({ preventScroll: true }));
  }

  /**
   * Keeps the active section valid after the picker sections rebuild (for
   * example when a server source disappears). The workspace component calls
   * this from its legacy reactive clamp so the controller owns the write.
   */
  setPickerActiveSection(sectionID: string) {
    this.pickerActiveSectionID = sectionID;
    this.flush();
  }

  handlePickerKeydown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    this.closePicker();
    void tick().then(() => this.hooks.pickerAnchor()?.focus({ preventScroll: true }));
  }

  async loadServerManagement() {
    const server = this.hooks.server();
    if (!server?.emoji_enabled || !this.hooks.sessionToken() || !this.hooks.canManageServerEmoji()) return;
    try {
      await this.refreshItems(true);
      this.managementError = "";
      this.flush();
    } catch (caught) {
      this.managementError = caught instanceof Error ? caught.message : this.hooks.translate("emoji.loadFailed");
      this.flush();
    }
  }

  private clearAddFile() {
    if (this.addPreviewURL) URL.revokeObjectURL(this.addPreviewURL);
    this.addFile = null;
    this.addPreviewURL = "";
    this.hooks.setAddID("");
    this.addError = "";
    if (this.hooks.addInputElement()) this.hooks.addInputElement()!.value = "";
  }

  /** Clears the quick-upload ID error when the template edits the ID field. */
  clearAddError() {
    this.addError = "";
    this.flush();
  }

  resetAddDialog() {
    this.addTargetsGeneration += 1;
    this.addDialogOpen = false;
    this.addTargetsLoading = false;
    this.addTargets = [];
    this.addTargetKey = "local";
    this.clearAddFile();
    this.flush();
  }

  closeAddDialog() {
    if (this.actionBusyId) return;
    this.resetAddDialog();
  }

  private async uploadTargetForSavedServer(savedServer: StoredServer) {
    try {
      const targetServer = await getServer(savedServer.base_url);
      if (!targetServer.emoji_enabled) return null;
      const targetSession = await this.loadSourceSession(savedServer.server_id);
      const [targetMember, targetRoles, targetEmojis] = await Promise.all([
        getProfile(targetSession.baseURL, targetSession.sessionToken),
        getRoles(targetSession.baseURL, targetSession.sessionToken),
        getCustomEmojis(targetSession.baseURL, targetSession.sessionToken)
      ]);
      if (!hasEffectivePermission("manage_server_emoji", targetMember.is_owner, targetMember, targetRoles)) {
        return null;
      }
      return {
        serverID: savedServer.server_id,
        serverName: targetServer.name || savedServer.name,
        serverIconDataURL: targetServer.icon_data_url ?? savedServer.icon_data_url ?? "",
        baseURL: targetSession.baseURL,
        sessionToken: targetSession.sessionToken,
        emojis: normalizeCustomEmojiMetadataList(targetEmojis),
        current: savedServer.server_id === this.hooks.server()?.server_id
      } satisfies EmojiServerUploadTarget;
    } catch {
      return null;
    }
  }

  async openAddDialog() {
    if (this.actionBusyId) return;
    this.clearAddFile();
    this.addDialogOpen = true;
    this.addTargetKey = "local";
    this.addTargets = [];
    this.addTargetsLoading = true;
    const generation = ++this.addTargetsGeneration;
    this.flush();
    const targets = await Promise.all(
      this.hooks.savedServers().map((savedServer) => this.uploadTargetForSavedServer(savedServer))
    );
    if (!this.addDialogOpen || generation !== this.addTargetsGeneration) return;
    this.addTargets = targets
      .filter((target): target is EmojiServerUploadTarget => Boolean(target))
      .sort((left, right) => Number(right.current) - Number(left.current) || left.serverName.localeCompare(right.serverName));
    this.addTargetsLoading = false;
    this.flush();
  }

  selectAddTarget(targetKey: string) {
    if (this.addTargetKey === targetKey) return;
    this.addTargetKey = targetKey;
    this.clearAddFile();
    this.flush();
  }

  private selectedAddServerTarget() {
    if (!this.addTargetKey.startsWith("server:")) return undefined;
    return this.addTargets.find((target) => target.serverID === this.addTargetKey.slice("server:".length));
  }

  selectAddFiles(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length === 0 || this.actionBusyId) return;
    const validFiles = files.filter(isSupportedEmojiFile);
    if (validFiles.length !== files.length) this.addError = this.hooks.translate("emoji.imageRequired");
    if (validFiles.length === 0) {
      this.flush();
      return;
    }
    if (this.addTargetKey === "local") {
      this.localEditorQueue = validFiles.slice(1);
      this.openEditor(validFiles[0], "local");
      return;
    }
    if (!this.selectedAddServerTarget()) {
      this.flush();
      return;
    }
    this.openEditor(validFiles[0], "quick-server");
  }

  private setQuickServerFile(file: File) {
    this.clearAddFile();
    this.addFile = file;
    this.addPreviewURL = URL.createObjectURL(file);
    this.hooks.setAddID(normalizeEmojiShortcode(file.name.replace(/\.[^.]+$/, "")));
    this.flush();
  }

  private async primeUploadedAsset(emoji: CustomEmoji, file: File, originServerID = "") {
    const fileSHA = await sha256Hex(file);
    if (
      fileSHA === emoji.asset_sha256
      && file.size === emoji.size_bytes
      && file.type === emoji.mime_type
    ) {
      await cacheContentAsset(
        emoji.asset_sha256,
        new Response(file, { headers: { "Content-Type": file.type } })
      );
      if (!this.objectURLs.has(emoji.asset_sha256)) {
        this.objectURLs = new Map(this.objectURLs).set(emoji.asset_sha256, URL.createObjectURL(file));
      }
      this.flush();
      return;
    }
    await this.ensureAsset(emoji, true, originServerID);
  }

  async submitQuickServerUpload() {
    const target = this.selectedAddServerTarget();
    const file = this.addFile;
    if (!target || !file || this.actionBusyId) return;
    const validationError = this.validateUploadID(this.hooks.addID(), target.emojis);
    if (validationError) {
      this.addError = validationError;
      this.flush();
      return;
    }
    this.actionBusyId = "quick-server-upload";
    this.flush();
    let completed = false;
    try {
      const uploaded = await uploadServerEmoji(target.baseURL, target.sessionToken, this.hooks.addID(), file);
      await this.primeUploadedAsset(uploaded, file, target.serverID);
      if (target.current) {
        this.mergeItem(uploaded);
      } else {
        const emojis = normalizeCustomEmojiMetadataList([
          ...target.emojis.filter((emoji) => emoji.emoji_id !== uploaded.emoji_id),
          uploaded
        ]);
        this.setServerLibrary({
          serverID: target.serverID,
          serverName: target.serverName,
          serverIconDataURL: target.serverIconDataURL,
          baseURL: target.baseURL,
          emojiEnabled: true,
          emojis,
          refreshedAtMS: Date.now()
        });
      }
      this.addError = "";
      completed = true;
    } catch (caught) {
      this.addError = caught instanceof Error ? caught.message : this.hooks.translate("emoji.uploadFailed");
    } finally {
      this.actionBusyId = "";
    }
    if (completed) this.closeAddDialog();
    else this.flush();
  }

  clearServerUpload() {
    if (this.serverUploadPreviewURL) URL.revokeObjectURL(this.serverUploadPreviewURL);
    this.serverUploadFile = null;
    this.serverUploadPreviewURL = "";
    this.serverUploadID = "";
    if (this.hooks.serverManagerInputElement()) this.hooks.serverManagerInputElement()!.value = "";
    this.flush();
  }

  openEditor(file: File, context: EmojiEditorContext) {
    this.closeEditor();
    this.editorContext = context;
    this.editorFile = file;
    this.editorSourceURL = URL.createObjectURL(file);
    this.flush();
  }

  closeEditor() {
    if (this.editorSourceURL) URL.revokeObjectURL(this.editorSourceURL);
    this.editorContext = null;
    this.editorFile = null;
    this.editorSourceURL = "";
    this.flush();
  }

  cancelEditor() {
    this.localEditorQueue = [];
    this.closeEditor();
  }

  setServerUploadFile(file: File) {
    if (this.serverUploadPreviewURL) URL.revokeObjectURL(this.serverUploadPreviewURL);
    this.serverUploadFile = file;
    this.serverUploadPreviewURL = URL.createObjectURL(file);
    if (!this.serverUploadID) this.serverUploadID = normalizeEmojiShortcode(file.name.replace(/\.[^.]+$/, ""));
    this.managementError = "";
    this.flush();
  }

  async acceptEditorFile(file: File) {
    const context = this.editorContext;
    this.closeEditor();
    if (context === "server") {
      this.setServerUploadFile(file);
      return;
    }
    if (context === "quick-server") {
      this.setQuickServerFile(file);
      return;
    }
    if (context !== "local") return;
    await this.storeLocalFile(file);
    const next = this.localEditorQueue[0];
    this.localEditorQueue = this.localEditorQueue.slice(1);
    if (next) this.openEditor(next, "local");
    else if (this.addDialogOpen) this.closeAddDialog();
  }

  selectServerUploadFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !this.hooks.canManageServerEmoji() || this.actionBusyId) return;
    if (!isSupportedEmojiFile(file)) {
      this.managementError = this.hooks.translate("emoji.imageRequired");
      this.flush();
      return;
    }
    this.openEditor(file, "server");
  }

  setServerUploadID(event: Event) {
    this.serverUploadID = (event.currentTarget as HTMLInputElement).value.trim();
    this.managementError = "";
    this.flush();
  }

  private validateUploadID(id: string, emojis: CustomEmoji[], excludedEmojiID = "") {
    if (!id) return this.hooks.translate("emoji.idRequired");
    if (!isValidEmojiID(id)) return this.hooks.translate("emoji.idInvalid");
    if (emojis.some((emoji) => emoji.emoji_id !== excludedEmojiID && emoji.shortcode === id)) return this.hooks.translate("emoji.idDuplicate");
    return "";
  }

  uploadErrorFor(serverUploadIDValue: string, customEmojisValue: CustomEmoji[]) {
    return this.validateUploadID(serverUploadIDValue, customEmojisValue);
  }

  async submitServerUpload() {
    if (!this.serverUploadFile || !this.hooks.sessionToken() || !this.hooks.canManageServerEmoji() || this.actionBusyId) return;
    const validationError = this.validateUploadID(this.serverUploadID, this.customEmojis);
    if (validationError) {
      this.managementError = validationError;
      this.flush();
      return;
    }
    this.actionBusyId = "server-upload";
    this.flush();
    try {
      const uploaded = await uploadServerEmoji(this.hooks.baseUrl(), this.hooks.sessionToken(), this.serverUploadID, this.serverUploadFile);
      await this.primeUploadedAsset(uploaded, this.serverUploadFile, this.hooks.server()?.server_id ?? "");
      this.mergeItem(uploaded);
      this.clearServerUpload();
      this.managementError = "";
    } catch (caught) {
      this.managementError = caught instanceof Error ? caught.message : this.hooks.translate("emoji.uploadFailed");
    } finally {
      this.actionBusyId = "";
    }
    this.flush();
  }

  async deleteServerItem(emoji: CustomEmoji) {
    if (!this.hooks.sessionToken() || !this.hooks.canManageServerEmoji() || this.actionBusyId) return;
    const confirmed = await this.hooks.showAppConfirm(this.hooks.translate("emoji.deleteConfirm", { id: emoji.shortcode }), {
      title: this.hooks.translate("emoji.deleteTitle"),
      confirmLabel: this.hooks.translate("emoji.delete")
    });
    if (!confirmed) return;
    this.actionBusyId = emoji.emoji_id;
    this.flush();
    try {
      this.removeItem(await deleteServerEmoji(this.hooks.baseUrl(), this.hooks.sessionToken(), emoji.emoji_id));
      this.managementError = "";
    } catch (caught) {
      this.managementError = caught instanceof Error ? caught.message : this.hooks.translate("emoji.deleteFailed");
    } finally {
      this.actionBusyId = "";
    }
    this.flush();
  }

  startServerEdit(emoji: CustomEmoji) {
    if (this.actionBusyId) return;
    this.editingID = emoji.emoji_id;
    this.hooks.setServerEditingShortcode(emoji.shortcode);
    this.managementError = "";
    this.flush();
  }

  cancelServerEdit() {
    this.editingID = "";
    this.hooks.setServerEditingShortcode("");
    this.flush();
  }

  async saveServerEdit(emoji: CustomEmoji) {
    if (!this.hooks.sessionToken() || !this.hooks.canManageServerEmoji() || this.actionBusyId || this.editingID !== emoji.emoji_id) return;
    const shortcode = this.hooks.serverEditingShortcode().trim();
    const validationError = this.validateUploadID(shortcode, this.customEmojis, emoji.emoji_id);
    if (validationError) {
      this.managementError = validationError;
      this.flush();
      return;
    }
    if (shortcode === emoji.shortcode) {
      this.cancelServerEdit();
      return;
    }
    this.actionBusyId = `edit:${emoji.emoji_id}`;
    this.flush();
    try {
      this.mergeItem(await updateServerEmoji(this.hooks.baseUrl(), this.hooks.sessionToken(), emoji.emoji_id, shortcode));
      this.cancelServerEdit();
      this.managementError = "";
    } catch (caught) {
      this.managementError = caught instanceof Error ? caught.message : this.hooks.translate("emoji.updateFailed");
    } finally {
      this.actionBusyId = "";
    }
    this.flush();
  }

  async createPack() {
    if (this.actionBusyId) return;
    const name = await this.hooks.showAppPrompt(this.hooks.translate("emoji.packNamePrompt"), "", { title: this.hooks.translate("emoji.createPack") });
    if (!name?.trim()) return;
    const pack = createLocalEmojiPack(name);
    this.localPacks = [...this.localPacks, pack];
    this.selectedLocalPackID = pack.pack_id;
    saveLocalEmojiPacks(this.localPacks);
    this.flush();
  }

  private async storeLocalFile(file: File) {
    let pack = this.currentLocalPack();
    if (!pack) {
      pack = createLocalEmojiPack(this.hooks.translate("emoji.defaultPackName"));
      this.localPacks = [...this.localPacks, pack];
      this.selectedLocalPackID = pack.pack_id;
    }
    this.actionBusyId = "local-import";
    this.flush();
    try {
      const sha = await sha256Hex(file);
      await cacheContentAsset(sha, new Response(file, { headers: { "Content-Type": file.type } }));
      if (pack.emojis.some((emoji) => emoji.asset_sha256 === sha)) return;
      const suggested = normalizeEmojiShortcode(file.name.replace(/\.[^.]+$/, "")) || `emoji_${pack.emojis.length + 1}`;
      const shortcode = nextAvailableEmojiID(suggested, pack.emojis.map((emoji) => emoji.shortcode));
      const item = createLocalEmojiItem({
        shortcode,
        asset_sha256: sha,
        size_bytes: file.size,
        mime_type: file.type
      });
      const updated = { ...pack, emojis: [...pack.emojis, item], updated_at_ms: Date.now() };
      this.localPacks = this.localPacks.map((candidate) => candidate.pack_id === pack?.pack_id ? updated : candidate);
      saveLocalEmojiPacks(this.localPacks);
      await this.ensureAsset(item, true);
      this.pickerActiveSectionID = `local:${pack.pack_id}`;
      this.hooks.setError("");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("emoji.importFailed"));
    } finally {
      this.actionBusyId = "";
      this.flush();
    }
  }

  private async deleteLocalItem(item: LocalEmojiItem) {
    const pack = this.localPacks.find((candidate) => candidate.emojis.some((emoji) => emoji.local_id === item.local_id));
    if (!pack || this.actionBusyId) return;
    const confirmed = await this.hooks.showAppConfirm(this.hooks.translate("emoji.removeLocalConfirm", { id: item.shortcode }), {
      title: this.hooks.translate("emoji.removeLocalTitle"),
      confirmLabel: this.hooks.translate("emoji.removeLocal"),
      danger: true
    });
    if (!confirmed) return;
    const updated = {
      ...pack,
      emojis: pack.emojis.filter((emoji) => emoji.local_id !== item.local_id),
      updated_at_ms: Date.now()
    };
    this.localPacks = this.localPacks.map((candidate) => candidate.pack_id === pack.pack_id ? updated : candidate);
    saveLocalEmojiPacks(this.localPacks);
  }

  async deleteLocalEntry(entry: EmojiPickerEntry) {
    if (entry.kind !== "local") return;
    await this.deleteLocalItem(entry.item as LocalEmojiItem);
    if (this.hooks.hoveredEntry()?.key === entry.key) this.hooks.setHoveredEntry(null);
    this.flush();
  }

  private async insertIntoComposer(
    item: DefaultEmoji | CustomEmoji | LocalEmojiItem,
    recentKey = "",
    requestedRange?: { start: number; end: number },
    originServerID = ""
  ) {
    const isDefault = "id" in item;
    if (!this.hooks.composerEditorElement() || (!isDefault && (!this.hooks.server()?.emoji_enabled || !this.hooks.canSendEmoji()))) return;
    const id = isDefault ? item.id : normalizeEmojiShortcode(item.shortcode);
    if (!isValidEmojiID(id)) return;
    const insertionRange = requestedRange ?? this.pickerComposerRange ?? this.hooks.composerSelectionRange();
    if (!isDefault && !this.objectURL(item.asset_sha256) && item.size_bytes > 1024 * 1024) {
      const confirmed = await this.hooks.showAppConfirm(
        this.hooks.translate("emoji.largeDownloadConfirm", {
          size: this.hooks.formatFileSize(item.size_bytes),
          name: emojiAlias(id)
        }),
        { title: this.hooks.translate("emoji.largeDownloadTitle"), confirmLabel: this.hooks.translate("emoji.download") }
      );
      if (!confirmed) return;
      try {
        await this.ensureAsset(item, true, originServerID);
      } catch (caught) {
        this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("emoji.downloadFailed"));
        return;
      }
    }
    let content: string;
    try {
      content = isDefault ? emojiAlias(id) : createEmojiToken(item);
    } catch {
      this.hooks.setError(this.hooks.translate("emoji.assetMismatch"));
      return;
    }
    if (recentKey) this.recentKeys = recordRecentEmojiKey(recentKey, this.recentKeys);
    this.pickerOpen = false;
    this.pickerComposerRange = null;
    this.hooks.setSearchQuery("");
    this.hideAutocomplete();
    await tick();
    this.hooks.replaceComposerRange(insertionRange.start, insertionRange.end, content);
    if (!isDefault) {
      void this.ensureAsset(item, true, originServerID).catch((caught) => {
        this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("emoji.downloadFailed"));
      });
    }
    this.flush();
  }

  async handleMessageListClick(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-emoji-token]") : null;
    if (!target) return;
    const reference = parseEmojiReferences(target.dataset.emojiToken ?? "")[0];
    if (!reference) return;
    if (!this.objectURL(reference.asset_sha256)) {
      if (reference.size_bytes > 1024 * 1024) {
        const confirmed = await this.hooks.showAppConfirm(
          this.hooks.translate("emoji.largeDownloadConfirm", { size: this.hooks.formatFileSize(reference.size_bytes), name: `:${reference.shortcode}:` }),
          { title: this.hooks.translate("emoji.largeDownloadTitle"), confirmLabel: this.hooks.translate("emoji.download") }
        );
        if (!confirmed) return;
      }
      try {
        await this.ensureAsset(reference, true);
      } catch (caught) {
        this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("emoji.downloadFailed"));
        return;
      }
    }
    this.detailReference = reference;
    this.flush();
  }

  closeDetail() {
    this.detailReference = null;
    this.flush();
  }

  async saveDetailToLocal() {
    const reference = this.detailReference;
    if (!reference || this.actionBusyId) return;
    let pack = this.currentLocalPack();
    if (!pack) {
      pack = createLocalEmojiPack(this.hooks.translate("emoji.defaultPackName"));
      this.localPacks = [...this.localPacks, pack];
      this.selectedLocalPackID = pack.pack_id;
    }
    if (pack.emojis.some((emoji) => emoji.asset_sha256 === reference.asset_sha256)) {
      this.detailReference = null;
      this.flush();
      return;
    }
    this.actionBusyId = "save-received";
    this.flush();
    try {
      await this.ensureAsset(reference, true);
      const shortcode = nextAvailableEmojiID(reference.shortcode, pack.emojis.map((emoji) => emoji.shortcode));
      const item = createLocalEmojiItem({ ...reference, shortcode });
      const updated = { ...pack, emojis: [...pack.emojis, item], updated_at_ms: Date.now() };
      this.localPacks = this.localPacks.map((candidate) => candidate.pack_id === pack?.pack_id ? updated : candidate);
      saveLocalEmojiPacks(this.localPacks);
      this.detailReference = null;
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("emoji.saveFailed"));
    } finally {
      this.actionBusyId = "";
    }
    this.flush();
  }

  hideAutocomplete() {
    this.autocompleteState = null;
    this.autocompleteEntries = [];
    this.hooks.setAutocompleteSelectedIndex(0);
    this.flush();
  }

  updateAutocomplete(offsets = this.hooks.composerSelectionOffsets()) {
    if (
      !offsets ||
      offsets.start !== offsets.end ||
      this.hooks.composerInputComposing() ||
      !this.hooks.selectedChannelId() ||
      !this.hooks.canSendMessages()
    ) {
      this.hideAutocomplete();
      return;
    }
    const shortcode = findEmojiShortcodeQuery(this.hooks.draft(), offsets.start);
    if (!shortcode) {
      this.hideAutocomplete();
      return;
    }
    const sections = this.buildPickerSections();
    const allEntries = uniquePickerEntries(sections);
    const recentEntries = sections.find((section) => section.kind === "recent")?.entries ?? [];
    const candidates = shortcode.query
      ? allEntries
          .map((entry) => ({ entry, score: emojiSearchScore(entry.id, entry.keywords, shortcode.query) }))
          .filter(({ score }) => score > 0)
          .sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id))
          .map(({ entry }) => entry)
      : [...recentEntries, ...allEntries.filter((entry) => !recentEntries.some((recent) => recent.key === entry.key))];
    if (candidates.length === 0) {
      this.hideAutocomplete();
      return;
    }
    const previousKey = this.autocompleteEntries[this.hooks.autocompleteSelectedIndex()]?.key;
    this.autocompleteState = shortcode;
    this.autocompleteEntries = candidates.slice(0, 10);
    const previousIndex = previousKey
      ? this.autocompleteEntries.findIndex((entry) => entry.key === previousKey)
      : -1;
    this.hooks.setAutocompleteSelectedIndex(previousIndex >= 0 ? previousIndex : 0);
    this.flush();
    void tick().then(() => this.positionAutocomplete());
  }

  positionAutocomplete() {
    if (!this.hooks.composerInputShellElement() || !this.hooks.composerEditorElement() || !this.autocompleteState) return;
    const shellRect = this.hooks.composerInputShellElement()!.getBoundingClientRect();
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    range?.collapse(true);
    const caretRect = range?.getClientRects()[0] ?? range?.getBoundingClientRect();
    const preferredLeft = caretRect && caretRect.left > 0 ? caretRect.left - shellRect.left - 16 : 8;
    const menuWidth = Math.min(320, Math.max(240, shellRect.width - 16));
    this.autocompleteLeft = Math.max(8, Math.min(preferredLeft, shellRect.width - menuWidth - 8));
    this.flush();
  }

  moveAutocompleteSelection(delta: number) {
    if (this.autocompleteEntries.length === 0) return;
    this.hooks.setAutocompleteSelectedIndex(
      (
        this.hooks.autocompleteSelectedIndex() + delta + this.autocompleteEntries.length
      ) % this.autocompleteEntries.length
    );
    this.flush();
  }

  selectAutocompleteEntry(entry: EmojiPickerEntry) {
    const range = this.autocompleteState;
    if (!range) return;
    void this.insertIntoComposer(
      entry.item,
      entry.key,
      { start: range.start, end: range.end },
      entry.originServerID
    );
  }

  revokeObjectURLs() {
    for (const url of this.objectURLs.values()) URL.revokeObjectURL(url);
    this.objectURLs = new Map();
    this.assetLoads.clear();
    this.sourceSessionLoads.clear();
    this.assetsReadyByServer.clear();
  }

  dispose() {
    this.closeEditor();
    this.resetAddDialog();
    this.revokeObjectURLs();
    this.clearServerUpload();
  }
}
