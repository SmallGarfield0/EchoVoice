// Chat composer domain controller.
//
// Owns the text-channel composer and the editing surface around it:
//   - message submission (server send + optimistic local queue),
//   - the contenteditable rich-text editor (serialization, selection mapping,
//     undo/redo history, inline images, markdown-lite/emoji rendering),
//   - composer attachments (upload queue, preview object URLs, removal),
//   - reply/edit-editor state and actions,
//   - message scrolling/read-position and per-channel unread counters,
//   - attachment/image preview registries shared with the App-owned preview
//     loaders (messageAttachment* state).
//
// Message data (list/search/selection/pending drafts) stays in
// lib/messages.svelte.ts; channel files stay in lib/channel-files.svelte.ts;
// emoji rendering/autocomplete stays in lib/emoji.svelte.ts. Those controllers
// are injected lazily below, and App.svelte keeps same-name template aliases
// plus thin wrappers where existing templates/call sites use them.
//
// This file uses the .svelte.ts extension so Svelte 5 `$state` runes work in
// a plain class. Template-bound DOM refs stay in the workspace component and
// are injected through getter/setter hooks.

import { tick } from "svelte";
import {
  deleteChannelFileEntry,
  deleteMessage,
  getMessageContext,
  sendMessage,
  updateMessage,
  uploadChannelFile,
  uploadMessageImage
} from "./api";
import { classifyFilePreview } from "./file-storage";
import {
  emojiAlias,
  getBuiltInGraphicEmoji,
  materializeEmojiAliases,
  parseEmojiReferences,
  resolveEmojiAlias
} from "./emoji";
import {
  composerInlineImagePlaceholder,
  createMessageAttachmentToken,
  materializeMessageImageTokens,
  parseMessageAttachmentReferences,
  parseMessageContentSegments,
  type MessageImageReference
} from "./message-attachments";
import {
  categoryChannels as getCategoryChannels,
  childChannels as getChildChannels,
  type ChannelTree
} from "./channelList";
import {
  loadReadState,
  loadUnreadCounts,
  saveReadState,
  saveUnreadCounts,
  type StoredReadState
} from "./storage";
import type {
  ChannelFileEntry,
  ContentAsset,
  Message,
  ServerSummary
} from "./types";
import type { ChannelFilesController } from "./channel-files.svelte";
import type { EmojiController, EmojiPickerEntry } from "./emoji.svelte";
import type { ClientMessage, MessagesController } from "./messages.svelte";

const maxComposerInlineImages = 10;
const maxComposerInlineImageBytes = 25 * 1024 * 1024;
const maxComposerHistoryEntries = 100;
const supportedComposerInlineImageTypes = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);

export type ComposerInlineImage = {
  localId: string;
  file: File;
  objectURL: string;
};

export type ComposerHistorySnapshot = {
  content: string;
  imageIds: string[];
  selectionStart: number;
  selectionEnd: number;
};

type ComposerDialogOptions = {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

/**
 * Cross-cutting dependencies injected by App.svelte. Controller instances and
 * DOM refs are read lazily so construction order cannot throw TDZ errors and
 * this file never imports the workspace component.
 */
export type ChatComposerHooks = {
  // Session / permissions / shared component state.
  server: () => ServerSummary | null;
  baseUrl: () => string;
  sessionToken: () => string;
  memberId: () => string;
  selectedChannelId: () => string;
  canSendMessages: () => boolean;
  canManageMessages: () => boolean;
  canDownloadFiles: () => boolean;
  canUploadFiles: () => boolean;
  canViewFiles: () => boolean;
  fileStorageAvailable: () => boolean;
  translate: (key: string, params?: Record<string, string | number>) => string;
  setError: (message: string) => void;
  setStatusKey: (key: string) => void;
  currentStorageServerId: () => string;
  showAppConfirm: (message: string, options?: ComposerDialogOptions) => Promise<boolean>;
  // Existing domain controllers (lazy to avoid circular imports/TDZ).
  messagesController: () => MessagesController;
  channelFiles: () => ChannelFilesController;
  emoji: () => EmojiController;
  // Template-bound DOM refs stay owned by App.svelte.
  messageListElement: () => HTMLDivElement | null;
  composerEditorElement: () => HTMLDivElement | null;
  composerInputShellElement: () => HTMLDivElement | null;
  composerAttachmentInputElement: () => HTMLInputElement | null;
  messageEditEditorElement: () => HTMLDivElement | null;
  setMessageEditEditorElement: (element: HTMLDivElement | null) => void;
  // App-owned preview loader (fetches message images into the registry below).
  ensureMessageImagePreview: (reference: MessageImageReference) => Promise<void>;
  // Emoji autocomplete selected index is written directly by the template.
  emojiAutocompleteSelectedIndex: () => number;
  // Bump App.svelte's realtimeSyncTick so legacy `$:` template aliases refresh.
  flushAliases: () => void;
};

export class ChatComposerController {
  // ---- draft + editor selection ----------------------------------------------
  draft = $state("");
  composerSelectionStart = $state(0);
  composerSelectionEnd = $state(0);
  composerInputComposing = $state(false);
  // ---- inline images + history -----------------------------------------------
  composerInlineImages = $state<ComposerInlineImage[]>([]);
  composerInlineImageRegistry = $state<Map<string, ComposerInlineImage>>(new Map());
  composerUndoStack = $state<ComposerHistorySnapshot[]>([]);
  composerRedoStack = $state<ComposerHistorySnapshot[]>([]);
  composerCompositionSnapshot = $state<ComposerHistorySnapshot | null>(null);
  composerInlineImageSequence = 0;
  composerInlineImageDragActive = $state(false);
  composerInlineImageUploading = $state(false);
  composerInlineImageUploadProgress = $state(0);
  // ---- attachments ------------------------------------------------------------
  composerAttachments = $state<ChannelFileEntry[]>([]);
  composerAttachmentObjectURLs = $state<Map<string, string>>(new Map());
  composerAttachmentUploading = $state(false);
  composerAttachmentUploadProgress = $state(0);
  composerAttachmentBusyId = $state("");
  // ---- attachment/image preview registries (read/written by App preview code)
  messageAttachmentObjectURLs = $state<Map<string, string>>(new Map());
  messageAttachmentEntries = $state<Map<string, ChannelFileEntry>>(new Map());
  messageAttachmentLoadingIds = $state<Set<string>>(new Set());
  messageAttachmentErrorIds = $state<Set<string>>(new Set());
  // ---- composer layout/scrollbar ----------------------------------------------
  composerLayoutAnimationFrame = 0;
  composerEmbeddedMediaResizeObserver: ResizeObserver | null = null;
  composerLayoutObservedImages = new WeakSet<HTMLImageElement>();
  composerScrollbarVisible = $state(false);
  composerScrollbarThumbTop = $state(0);
  composerScrollbarThumbHeight = $state(24);
  composerScrollbarDragging = $state(false);
  composerScrollbarDragStartY = 0;
  composerScrollbarDragStartScrollTop = 0;
  composerPanelHeight = $state(70);
  // ---- submission / reply / edit ----------------------------------------------
  messageSubmitting = $state(false);
  replyingToMessageId = $state("");
  messageJumpLoadingId = $state("");
  // ---- unread + read-position persistence -------------------------------------
  unreadCountsByChannel = $state<Map<string, number>>(new Map());
  readStateByChannel = $state<StoredReadState>({});

  constructor(private hooks: ChatComposerHooks) {}

  private messages(): MessagesController {
    return this.hooks.messagesController();
  }

  private files(): ChannelFilesController {
    return this.hooks.channelFiles();
  }

  private emojiController(): EmojiController {
    return this.hooks.emoji();
  }

  /** Bumps App.svelte's alias refresh tick after template-visible mutations. */
  private flush(): void {
    this.hooks.flushAliases();
  }

  // ---------------------------------------------------------------------------
  // Message submission + optimistic local queue
  // ---------------------------------------------------------------------------

  async submitMessage(): Promise<void> {
    const text = this.draft.trim();
    const queuedAttachments = [...this.composerAttachments];
    const queuedImages = [...this.composerInlineImages];
    if (
      (!text && queuedAttachments.length === 0 && queuedImages.length === 0) ||
      !this.hooks.selectedChannelId() ||
      !this.hooks.sessionToken() ||
      this.messageSubmitting ||
      this.composerAttachmentUploading
    ) return;
    const channelId = this.hooks.selectedChannelId();
    const token = this.hooks.sessionToken();
    const replyToMessageId = this.replyingToMessageId;
    let localMessage: ClientMessage | null = null;
    this.messageSubmitting = true;
    this.composerInlineImageUploading = queuedImages.length > 0;
    this.composerInlineImageUploadProgress = 0;
    this.hooks.setError("");
    this.flush();
    try {
      const emojiContent = materializeEmojiAliases(text, this.emojiController().availableAliases());
      if (!(await this.emojiController().ensureMessageAssetsOnCurrentServer(emojiContent))) return;
      const uploadedImages: ContentAsset[] = [];
      for (const [index, image] of queuedImages.entries()) {
        uploadedImages.push(await uploadMessageImage(this.hooks.baseUrl(), channelId, token, image.file, (percent) => {
          this.composerInlineImageUploadProgress = Math.round(((index + percent / 100) / queuedImages.length) * 100);
        }));
      }
      const content = [
        materializeMessageImageTokens(emojiContent, uploadedImages),
        ...queuedAttachments.map(createMessageAttachmentToken)
      ].filter(Boolean).join("\n");
      localMessage = this.messages().createLocalMessage(channelId, content, "sending", replyToMessageId);
      if (this.hooks.selectedChannelId() === channelId) {
        this.messages().messages = [...this.messages().messages, localMessage].sort((left, right) => left.created_at_ms - right.created_at_ms);
        this.flush();
      }
      this.messages().upsertPendingMessage(localMessage);
      this.draft = "";
      this.emojiController().hideAutocomplete();
      this.transferComposerAttachmentObjectURLs(queuedAttachments);
      this.transferComposerInlineImageObjectURLs(queuedImages, uploadedImages);
      this.composerAttachments = [];
      this.clearReplyTarget();
      await this.resetComposerHeight();
      await this.scrollMessagesToBottom();
      this.flush();

      const message = await sendMessage(this.hooks.baseUrl(), channelId, token, content, replyToMessageId);
      this.messages().removePendingMessage(localMessage.message_id);
      if (this.hooks.selectedChannelId() === channelId) {
        this.messages().replaceLocalMessage(localMessage.message_id, message);
        await this.scrollMessagesToBottom();
      }
    } catch (caught) {
      if (localMessage && this.hooks.selectedChannelId() === channelId) {
        this.messages().markLocalMessageFailed(
          localMessage.message_id,
          caught instanceof Error ? caught.message : this.hooks.translate("error.messageSendFailed")
        );
      } else if (localMessage) {
        this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.messageSendFailed"));
      } else {
        this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.messageImageUploadFailed"));
      }
    } finally {
      this.messageSubmitting = false;
      this.composerInlineImageUploading = false;
      this.composerInlineImageUploadProgress = 0;
      this.flush();
    }
  }

  createLocalMessage(
    channelId: string,
    content: string,
    status: ClientMessage["local_status"],
    replyToMessageId = ""
  ): ClientMessage {
    const message = this.messages().createLocalMessage(channelId, content, status, replyToMessageId);
    this.flush();
    return message;
  }

  isLocalMessage(message: Message | ClientMessage): boolean {
    return this.messages().isLocalMessage(message);
  }

  replaceLocalMessage(localMessageId: string, message: Message): void {
    this.messages().replaceLocalMessage(localMessageId, message);
    this.flush();
  }

  markLocalMessageFailed(localMessageId: string, localError: string): void {
    this.messages().markLocalMessageFailed(localMessageId, localError);
    this.flush();
  }

  async retryLocalMessage(message: ClientMessage): Promise<void> {
    const pending = this.messages().retryLocalMessage(message);
    this.flush();
    return pending;
  }

  dismissLocalMessage(message: ClientMessage): void {
    this.messages().dismissLocalMessage(message);
    this.flush();
  }

  pendingLocalMessagesForChannel(channelId: string): ClientMessage[] {
    return this.messages().pendingLocalMessagesForChannel(channelId);
  }

  upsertPendingMessage(message: ClientMessage, errorMessage = ""): void {
    this.messages().upsertPendingMessage(message, errorMessage);
    this.flush();
  }

  removePendingMessage(localMessageId: string): void {
    this.messages().removePendingMessage(localMessageId);
    this.flush();
  }

  async flushPendingMessages(): Promise<void> {
    const pending = this.messages().flushPendingMessages();
    this.flush();
    return pending;
  }

  async refreshCurrentChannelMessages(): Promise<void> {
    const pending = this.messages().refreshCurrentChannelMessages();
    this.flush();
    return pending;
  }

  async replyToMessage(message: Message): Promise<void> {
    if (this.isLocalMessage(message) || message.deleted_at_ms) return;
    this.messages().closeMessageContextMenu();
    this.replyingToMessageId = message.message_id;
    this.flush();
    await tick();
    this.hooks.composerEditorElement()?.focus();
  }

  replyContextMenuMessage(): void {
    const menu = this.messages().messageContextMenu;
    const message = menu
      ? this.messages().messages.find((candidate) => candidate.message_id === menu.messageId)
      : undefined;
    if (!message) {
      this.messages().closeMessageContextMenu();
      return;
    }
    void this.replyToMessage(message);
  }

  clearReplyTarget(): void {
    this.replyingToMessageId = "";
    this.flush();
  }

  replyPreviewContent(message: Message | undefined): string {
    if (!message) return this.hooks.translate("messages.replyUnavailable");
    if (message.deleted_at_ms) return this.hooks.translate("messages.deleted");
    const content = message.content
      .replace(/<:ev:([A-Za-z0-9_]{1,32}):[a-fA-F0-9]{64}:[0-9]{1,10}:(?:png|gif|webp|jpg)>/g, ":$1:")
      .replace(/<:image:[a-fA-F0-9]{64}:[0-9]{1,12}:(?:png|gif|webp|jpg|avif):[A-Za-z0-9_.!~*%()-]+>/g, this.hooks.translate("messages.replyImage"))
      .replace(/\s+/g, " ")
      .trim();
    return content || this.hooks.translate("messages.replyEmpty");
  }

  messageById(messageId: string | undefined): Message | ClientMessage | undefined {
    return this.messages().messageById(messageId);
  }

  async jumpToMessage(messageId: string | undefined): Promise<void> {
    if (!messageId) return;
    await tick();
    let element = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
    if (!element && this.hooks.selectedChannelId() && this.hooks.sessionToken()) {
      this.messageJumpLoadingId = messageId;
      this.flush();
      const loaded = await this.loadMessageContextAround(messageId);
      this.messageJumpLoadingId = "";
      this.flush();
      if (loaded) {
        await tick();
        element = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`);
      }
    }
    if (!element) {
      this.hooks.setStatusKey("messages.replyUnavailable");
      return;
    }
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    element.classList.add("message-row-highlight");
    window.setTimeout(() => element.classList.remove("message-row-highlight"), 1400);
  }

  async loadMessageContextAround(messageId: string): Promise<boolean> {
    if (!this.hooks.selectedChannelId() || !this.hooks.sessionToken()) return false;
    try {
      const contextMessages = await getMessageContext(
        this.hooks.baseUrl(),
        this.hooks.selectedChannelId(),
        this.hooks.sessionToken(),
        messageId
      );
      this.messages().mergeMessages(contextMessages);
      this.messages().hasOlderMessages = contextMessages.length > 0;
      this.hooks.setError("");
      this.flush();
      return true;
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.messageContextLoadFailed"));
      return false;
    }
  }

  async submitMessageSearch(): Promise<void> {
    const pending = this.messages().submitMessageSearch();
    this.flush();
    return pending;
  }

  clearMessageSearch(): void {
    this.messages().clearMessageSearch();
    this.flush();
  }

  async openSearchResult(message: Message): Promise<void> {
    this.messages().messageSearchOpen = false;
    this.flush();
    await this.loadMessageContextAround(message.message_id);
    await this.jumpToMessage(message.message_id);
  }

  // ---------------------------------------------------------------------------
  // Composer attachments: object URLs, upload, removal
  // ---------------------------------------------------------------------------

  triggerComposerAttachmentUpload(): void {
    if (!this.hooks.fileStorageAvailable() || !this.hooks.canUploadFiles() || !this.hooks.canSendMessages() || this.composerAttachmentUploading) return;
    this.hooks.composerAttachmentInputElement()?.click();
  }

  setComposerAttachmentObjectURL(entry: ChannelFileEntry, file: File): void {
    const kind = classifyFilePreview(entry.name, entry.mime_type);
    if (kind !== "image" && kind !== "video" && kind !== "audio") return;
    this.revokeComposerAttachmentObjectURL(entry.entry_id);
    this.composerAttachmentObjectURLs = new Map(this.composerAttachmentObjectURLs).set(
      entry.entry_id,
      URL.createObjectURL(file)
    );
    this.flush();
  }

  revokeComposerAttachmentObjectURL(entryId: string): void {
    const objectURL = this.composerAttachmentObjectURLs.get(entryId);
    if (!objectURL) return;
    URL.revokeObjectURL(objectURL);
    const next = new Map(this.composerAttachmentObjectURLs);
    next.delete(entryId);
    this.composerAttachmentObjectURLs = next;
    this.flush();
  }

  transferComposerAttachmentObjectURLs(entries: ChannelFileEntry[]): void {
    const nextComposer = new Map(this.composerAttachmentObjectURLs);
    const nextMessages = new Map(this.messageAttachmentObjectURLs);
    const nextEntries = new Map(this.messageAttachmentEntries);
    for (const entry of entries) {
      nextEntries.set(entry.entry_id, entry);
      const objectURL = nextComposer.get(entry.entry_id);
      if (!objectURL) continue;
      const previous = nextMessages.get(entry.entry_id);
      if (previous && previous !== objectURL) URL.revokeObjectURL(previous);
      nextMessages.set(entry.entry_id, objectURL);
      nextComposer.delete(entry.entry_id);
    }
    this.composerAttachmentObjectURLs = nextComposer;
    this.messageAttachmentObjectURLs = nextMessages;
    this.messageAttachmentEntries = nextEntries;
    this.flush();
  }

  async handleComposerAttachmentInput(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (
      files.length === 0 ||
      !this.hooks.fileStorageAvailable() ||
      !this.hooks.canUploadFiles() ||
      !this.hooks.selectedChannelId() ||
      !this.hooks.sessionToken() ||
      this.composerAttachmentUploading
    ) return;
    const channelId = this.hooks.selectedChannelId();
    this.composerAttachmentUploading = true;
    this.composerAttachmentUploadProgress = 0;
    this.hooks.setError("");
    this.flush();
    try {
      for (const [index, file] of files.entries()) {
        const entry = await uploadChannelFile(this.hooks.baseUrl(), channelId, this.hooks.sessionToken(), file, "", (percent) => {
          this.composerAttachmentUploadProgress = Math.round(((index + percent / 100) / files.length) * 100);
        });
        if (this.hooks.selectedChannelId() !== channelId) continue;
        this.files().mergeFileEntry(entry);
        this.composerAttachments = [
          ...this.composerAttachments.filter((candidate) => candidate.entry_id !== entry.entry_id),
          entry
        ];
        this.setComposerAttachmentObjectURL(entry, file);
      }
      this.hooks.setStatusKey("files.uploaded");
      await tick();
      this.adjustComposerHeight();
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.fileUploadFailed"));
    } finally {
      this.composerAttachmentUploading = false;
      this.composerAttachmentUploadProgress = 0;
      this.flush();
    }
  }

  async removeComposerAttachment(entry: ChannelFileEntry): Promise<void> {
    if (!this.hooks.selectedChannelId() || !this.hooks.sessionToken() || this.composerAttachmentBusyId) return;
    if (this.files().filePreviewEntry?.entry_id === entry.entry_id) this.files().closeFilePreview();
    this.composerAttachments = this.composerAttachments.filter((candidate) => candidate.entry_id !== entry.entry_id);
    this.revokeComposerAttachmentObjectURL(entry.entry_id);
    this.composerAttachmentBusyId = entry.entry_id;
    this.flush();
    try {
      this.files().removeFileEntry(await deleteChannelFileEntry(this.hooks.baseUrl(), this.hooks.selectedChannelId(), this.hooks.sessionToken(), entry.entry_id));
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.fileDeleteFailed"));
    } finally {
      this.composerAttachmentBusyId = "";
      await tick();
      this.adjustComposerHeight();
    }
  }

  // ---------------------------------------------------------------------------
  // Inline images + editor history
  // ---------------------------------------------------------------------------

  captureComposerSnapshot(useLiveSelection = false): ComposerHistorySnapshot {
    const liveSelection = useLiveSelection ? this.composerSelectionRange() : null;
    return {
      content: this.draft,
      imageIds: this.composerInlineImages.map((image) => image.localId),
      selectionStart: liveSelection?.start ?? this.composerSelectionStart,
      selectionEnd: liveSelection?.end ?? this.composerSelectionEnd
    };
  }

  composerSnapshotsMatch(left: ComposerHistorySnapshot | undefined, right: ComposerHistorySnapshot): boolean {
    return Boolean(
      left &&
      left.content === right.content &&
      left.imageIds.length === right.imageIds.length &&
      left.imageIds.every((id, index) => id === right.imageIds[index])
    );
  }

  resetComposerHistory(): void {
    this.composerUndoStack = [];
    this.composerRedoStack = [];
    this.composerCompositionSnapshot = null;
  }

  pruneComposerImageRegistry(): void {
    const retainedIds = new Set(this.composerInlineImages.map((image) => image.localId));
    for (const snapshot of [...this.composerUndoStack, ...this.composerRedoStack]) {
      for (const imageId of snapshot.imageIds) retainedIds.add(imageId);
    }
    const nextRegistry = new Map(this.composerInlineImageRegistry);
    for (const [imageId, image] of nextRegistry) {
      if (retainedIds.has(imageId)) continue;
      URL.revokeObjectURL(image.objectURL);
      nextRegistry.delete(imageId);
    }
    this.composerInlineImageRegistry = nextRegistry;
  }

  recordComposerMutation(previous: ComposerHistorySnapshot): void {
    const current = this.captureComposerSnapshot();
    if (this.composerSnapshotsMatch(previous, current)) return;
    if (!this.composerSnapshotsMatch(this.composerUndoStack.at(-1), previous)) {
      this.composerUndoStack = [...this.composerUndoStack, previous].slice(-maxComposerHistoryEntries);
    }
    this.composerRedoStack = [];
    this.pruneComposerImageRegistry();
  }

  restoreComposerSnapshot(snapshot: ComposerHistorySnapshot): void {
    let imageIndex = 0;
    const retainedIds = new Set<string>();
    const nextImages: ComposerInlineImage[] = [];
    const content = snapshot.content.replaceAll(composerInlineImagePlaceholder, () => {
      const imageId = snapshot.imageIds[imageIndex] ?? "";
      imageIndex += 1;
      const image = this.composerInlineImageRegistry.get(imageId);
      if (!image || retainedIds.has(imageId)) return "";
      retainedIds.add(imageId);
      nextImages.push(image);
      return composerInlineImagePlaceholder;
    });
    this.composerInlineImages = nextImages;
    this.draft = content;
    this.composerSelectionStart = Math.max(0, Math.min(content.length, snapshot.selectionStart));
    this.composerSelectionEnd = Math.max(0, Math.min(content.length, snapshot.selectionEnd));
    this.hooks.composerEditorElement()?.focus({ preventScroll: true });
    this.renderComposerEditor(this.draft, this.composerSelectionStart, this.composerSelectionEnd);
    this.emojiController().hideAutocomplete();
    this.scheduleComposerLayoutRefresh();
    this.flush();
  }

  undoComposerMutation(): void {
    const previous = this.composerUndoStack.at(-1);
    if (!previous) return;
    const current = this.captureComposerSnapshot(true);
    this.composerUndoStack = this.composerUndoStack.slice(0, -1);
    this.composerRedoStack = [...this.composerRedoStack, current].slice(-maxComposerHistoryEntries);
    this.restoreComposerSnapshot(previous);
    this.pruneComposerImageRegistry();
  }

  redoComposerMutation(): void {
    const next = this.composerRedoStack.at(-1);
    if (!next) return;
    const current = this.captureComposerSnapshot(true);
    this.composerRedoStack = this.composerRedoStack.slice(0, -1);
    this.composerUndoStack = [...this.composerUndoStack, current].slice(-maxComposerHistoryEntries);
    this.restoreComposerSnapshot(next);
    this.pruneComposerImageRegistry();
  }

  transferComposerInlineImageObjectURLs(images: ComposerInlineImage[], assets: ContentAsset[]): void {
    const nextMessages = new Map(this.messageAttachmentObjectURLs);
    for (const [index, image] of images.entries()) {
      const asset = assets[index];
      if (!asset) continue;
      const previous = nextMessages.get(asset.sha256);
      if (previous && previous !== image.objectURL) URL.revokeObjectURL(previous);
      nextMessages.set(asset.sha256, image.objectURL);
    }
    const retainedObjectURLs = new Set(nextMessages.values());
    const knownImages = new Map(this.composerInlineImageRegistry);
    for (const image of this.composerInlineImages) knownImages.set(image.localId, image);
    for (const image of knownImages.values()) {
      if (!retainedObjectURLs.has(image.objectURL)) URL.revokeObjectURL(image.objectURL);
    }
    this.composerInlineImages = [];
    this.composerInlineImageRegistry = new Map();
    this.resetComposerHistory();
    this.messageAttachmentObjectURLs = nextMessages;
    this.flush();
  }

  clearComposerInlineImages(): void {
    const objectURLs = new Set<string>();
    for (const image of this.composerInlineImageRegistry.values()) objectURLs.add(image.objectURL);
    for (const image of this.composerInlineImages) objectURLs.add(image.objectURL);
    for (const objectURL of objectURLs) URL.revokeObjectURL(objectURL);
    this.composerInlineImages = [];
    this.composerInlineImageRegistry = new Map();
    this.draft = this.draft.replaceAll(composerInlineImagePlaceholder, "");
    this.composerSelectionStart = Math.min(this.composerSelectionStart, this.draft.length);
    this.composerSelectionEnd = Math.min(this.composerSelectionEnd, this.draft.length);
    this.resetComposerHistory();
    this.composerInlineImageDragActive = false;
    this.renderComposerEditor(this.draft);
    this.flush();
  }

  clearComposerAttachmentObjectURLs(): void {
    for (const objectURL of this.composerAttachmentObjectURLs.values()) URL.revokeObjectURL(objectURL);
    this.composerAttachmentObjectURLs = new Map();
    this.clearComposerInlineImages();
  }

  clearMessageAttachmentObjectURLs(): void {
    for (const objectURL of this.messageAttachmentObjectURLs.values()) URL.revokeObjectURL(objectURL);
    this.messageAttachmentObjectURLs = new Map();
    this.messageAttachmentEntries = new Map();
    this.messageAttachmentLoadingIds = new Set();
    this.messageAttachmentErrorIds = new Set();
    this.flush();
  }

  composerImageMIME(file: File): string {
    const declared = file.type.toLowerCase().split(";", 1)[0];
    if (supportedComposerInlineImageTypes.has(declared)) return declared;
    const extension = file.name.toLowerCase().split(".").pop();
    switch (extension) {
      case "avif": return "image/avif";
      case "gif": return "image/gif";
      case "jpeg":
      case "jpg": return "image/jpeg";
      case "png": return "image/png";
      case "webp": return "image/webp";
      default: return "";
    }
  }

  composerImageExtension(mimeType: string): string {
    if (mimeType === "image/jpeg") return "jpg";
    return mimeType.slice("image/".length) || "png";
  }

  async queueComposerInlineImages(
    files: File[],
    insertionRange = this.composerSelectionRange()
  ): Promise<void> {
    if (!this.hooks.selectedChannelId() || !this.hooks.canSendMessages() || this.messageSubmitting || files.length === 0) return;
    const selectedImageCount = this.countComposerInlineImages(this.draft.slice(insertionRange.start, insertionRange.end));
    const available = Math.max(0, maxComposerInlineImages - this.composerInlineImages.length + selectedImageCount);
    const next: ComposerInlineImage[] = [];
    let rejectedType = false;
    let rejectedSize = false;
    const rejectedCount = files.length > available;
    for (const file of files.slice(0, available)) {
      const mimeType = this.composerImageMIME(file);
      if (!mimeType) {
        rejectedType = true;
        continue;
      }
      if (file.size <= 0 || file.size > maxComposerInlineImageBytes) {
        rejectedSize = true;
        continue;
      }
      this.composerInlineImageSequence += 1;
      const normalizedFile = file.name.trim()
        ? file
        : new File([file], `pasted-image-${Date.now()}-${this.composerInlineImageSequence}.${this.composerImageExtension(mimeType)}`, { type: mimeType });
      next.push({
        localId: `composer-image-${Date.now()}-${this.composerInlineImageSequence}`,
        file: normalizedFile,
        objectURL: URL.createObjectURL(normalizedFile)
      });
    }
    if (next.length > 0) {
      this.replaceComposerRange(
        insertionRange.start,
        insertionRange.end,
        composerInlineImagePlaceholder.repeat(next.length),
        next
      );
    }
    if (rejectedCount) {
      this.hooks.setError(this.hooks.translate("error.messageImageLimit", { count: maxComposerInlineImages }));
    } else if (rejectedSize) {
      this.hooks.setError(this.hooks.translate("error.messageImageTooLarge", { size: 25 }));
    } else if (rejectedType) {
      this.hooks.setError(this.hooks.translate("error.messageImageUnsupported"));
    }
    await tick();
    this.scheduleComposerLayoutRefresh();
  }

  removeComposerInlineImage(localId: string): void {
    if (this.composerInlineImageUploading) return;
    const imageIndex = this.composerInlineImages.findIndex((candidate) => candidate.localId === localId);
    if (imageIndex < 0) return;
    const offset = this.composerInlineImageOffset(imageIndex);
    if (offset < 0) return;
    this.replaceComposerRange(offset, offset + composerInlineImagePlaceholder.length, "");
  }

  // ---------------------------------------------------------------------------
  // Composer layout + rendering
  // ---------------------------------------------------------------------------

  async scrollMessagesToBottom(): Promise<void> {
    await tick();
    const list = this.hooks.messageListElement();
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    this.messages().currentChannelNewMessageCount = 0;
    this.messages().currentChannelNewMessageStartId = "";
  }

  async restoreChannelReadPosition(channelId: string): Promise<void> {
    await tick();
    const list = this.hooks.messageListElement();
    if (!list) return;
    const saved = this.readStateByChannel[channelId];
    if (!saved || saved.scroll_top <= 0) {
      await this.scrollMessagesToBottom();
      return;
    }
    list.scrollTop = Math.min(saved.scroll_top, list.scrollHeight);
  }

  jumpToLatestMessages(): void {
    void this.scrollMessagesToBottom();
  }

  async resetComposerHeight(): Promise<void> {
    await tick();
    this.renderComposerEditor(this.draft);
    this.adjustComposerHeight();
  }

  adjustComposerHeight(): void {
    const editor = this.hooks.composerEditorElement();
    if (!editor) return;
    const minHeight = 42;
    const currentComposerHeight = editor.offsetHeight || minHeight;
    const messageAreaHeight = (this.hooks.messageListElement()?.clientHeight ?? minHeight * 4) + currentComposerHeight;
    const maxHeight = Math.max(minHeight, Math.floor(messageAreaHeight / 2));

    editor.style.height = "auto";
    editor.style.maxHeight = `${maxHeight}px`;
    const nextHeight = Math.min(Math.max(editor.scrollHeight, minHeight), maxHeight);
    editor.style.height = `${nextHeight}px`;
    editor.style.overflowY = editor.scrollHeight > maxHeight ? "auto" : "hidden";
    this.composerPanelHeight = nextHeight + 28;
    this.updateComposerScrollbar();
    this.flush();
  }

  scheduleComposerLayoutRefresh = (): void => {
    if (this.composerLayoutAnimationFrame) window.cancelAnimationFrame(this.composerLayoutAnimationFrame);
    this.composerLayoutAnimationFrame = window.requestAnimationFrame(() => {
      this.composerLayoutAnimationFrame = 0;
      this.adjustComposerHeight();
      this.composerLayoutAnimationFrame = window.requestAnimationFrame(() => {
        this.composerLayoutAnimationFrame = 0;
        this.adjustComposerHeight();
      });
    });
  };

  observeComposerEmbeddedMediaLayout(): void {
    const editor = this.hooks.composerEditorElement();
    if (!editor) return;
    if (typeof ResizeObserver !== "undefined") {
      this.composerEmbeddedMediaResizeObserver ??= new ResizeObserver(() => this.scheduleComposerLayoutRefresh());
      this.composerEmbeddedMediaResizeObserver.disconnect();
      for (const embed of editor.querySelectorAll<HTMLElement>(".composer-inline-image-embed")) {
        this.composerEmbeddedMediaResizeObserver.observe(embed);
      }
    }
    for (const image of editor.querySelectorAll<HTMLImageElement>("img")) {
      if (this.composerLayoutObservedImages.has(image)) continue;
      this.composerLayoutObservedImages.add(image);
      if (image.complete) {
        this.scheduleComposerLayoutRefresh();
        continue;
      }
      image.addEventListener("load", this.scheduleComposerLayoutRefresh, { once: true });
      image.addEventListener("error", this.scheduleComposerLayoutRefresh, { once: true });
    }
  }

  formatComposerEditorContent(content: string): string {
    const pattern = /\uFFFC|<:evb:[^>\n\uFFFC]+>|<:ev:[^>\n\uFFFC]+>|:[a-z0-9_]{1,12}:|\*\*[^*\n\uFFFC]*\*\*|\*[^*\n\uFFFC]+\*|`[^`\n\uFFFC]+`|https?:\/\/[^\s\uFFFC]+/g;
    const escapeHTML = (value: string) => this.messages().escapeHTML(value);
    let html = "";
    let offset = 0;
    let imageIndex = 0;
    for (const match of content.matchAll(pattern)) {
      const token = match[0];
      const index = match.index ?? offset;
      html += escapeHTML(content.slice(offset, index));
      if (token === composerInlineImagePlaceholder) {
        const image = this.composerInlineImages[imageIndex];
        imageIndex += 1;
        if (image) {
          const localId = escapeHTML(image.localId);
          const name = escapeHTML(image.file.name);
          const removeLabel = escapeHTML(this.hooks.translate("composer.removeInlineImage", { name: image.file.name }));
          html += `<span class="composer-inline-image-embed" data-composer-inline-image="${localId}" contenteditable="false" draggable="false"><img src="${escapeHTML(image.objectURL)}" alt="${name}" draggable="false"><button type="button" data-composer-remove-image="${localId}" data-tooltip="${removeLabel}" aria-label="${removeLabel}"><span class="material-symbols-rounded app-icon" aria-hidden="true">close</span></button></span>`;
        }
      } else if (token.startsWith("<:ev:") || token.startsWith("<:evb:") || /^:[a-z0-9_]{1,12}:$/.test(token)) {
        html += this.formatComposerEmoji(token);
      } else if (token.startsWith("**")) {
        html += `<span class="composer-markdown-marker">**</span><strong>${escapeHTML(token.slice(2, -2))}</strong><span class="composer-markdown-marker">**</span>`;
      } else if (token.startsWith("*")) {
        html += `<span class="composer-markdown-marker">*</span><em>${escapeHTML(token.slice(1, -1))}</em><span class="composer-markdown-marker">*</span>`;
      } else if (token.startsWith("`")) {
        html += `<span class="composer-markdown-marker">\`</span><code>${escapeHTML(token.slice(1, -1))}</code><span class="composer-markdown-marker">\`</span>`;
      } else {
        html += `<span class="composer-link">${escapeHTML(token)}</span>`;
      }
      offset = index + token.length;
    }
    return html + escapeHTML(content.slice(offset));
  }

  formatComposerEmoji(token: string): string {
    const escapeHTML = (value: string) => this.messages().escapeHTML(value);
    const internalReference = token.startsWith("<:ev:") ? parseEmojiReferences(token)[0] : undefined;
    const builtInGraphic = token.startsWith("<:evb:") ? getBuiltInGraphicEmoji(token) : undefined;
    const id = internalReference?.shortcode ?? builtInGraphic?.id ?? token.slice(1, -1);
    const resolution = builtInGraphic
      ? ({ kind: "default", emoji: builtInGraphic } as const)
      : internalReference
        ? ({ kind: "custom", emoji: internalReference } as const)
        : resolveEmojiAlias(id, this.emojiController().availableAliases());
    if (!resolution) return escapeHTML(token);

    const label = escapeHTML(emojiAlias(id));
    const serialized = escapeHTML(token);
    if (resolution.kind === "default") {
      if (resolution.emoji.imageURL) {
        return `<span class="composer-emoji-embed builtin-graphic" data-composer-token="${serialized}" contenteditable="false" draggable="false" data-tooltip="${label}" aria-label="${label}"><img src="${escapeHTML(resolution.emoji.imageURL)}" alt="${label}" draggable="false"></span>`;
      }
      return `<span class="composer-emoji-embed default" data-composer-token="${serialized}" contenteditable="false" draggable="false" data-tooltip="${label}" aria-label="${label}">${escapeHTML(resolution.emoji.value)}</span>`;
    }

    const url = this.emojiController().objectURL(resolution.emoji.asset_sha256);
    const content = url
      ? `<img src="${escapeHTML(url)}" alt="${label}" draggable="false">`
      : `<span class="material-symbols-rounded app-icon" aria-hidden="true">add_reaction</span>`;
    return `<span class="composer-emoji-embed custom${url ? " loaded" : " pending"}" data-composer-token="${serialized}" contenteditable="false" draggable="false" data-tooltip="${label}" aria-label="${label}">${content}</span>`;
  }

  composerInlineImageId(node: Node): string {
    return node instanceof HTMLElement ? node.dataset.composerInlineImage ?? "" : "";
  }

  composerAtomicToken(node: Node): string {
    return node instanceof HTMLElement ? node.dataset.composerToken ?? "" : "";
  }

  serializeComposerNode(node: Node): { content: string; imageIds: string[] } {
    const imageId = this.composerInlineImageId(node);
    if (imageId) return { content: composerInlineImagePlaceholder, imageIds: [imageId] };
    const atomicToken = this.composerAtomicToken(node);
    if (atomicToken) return { content: atomicToken, imageIds: [] };
    if (node.nodeType === Node.TEXT_NODE) return { content: node.textContent ?? "", imageIds: [] };
    if (node instanceof HTMLElement && node.tagName === "BR") return { content: "\n", imageIds: [] };

    let content = "";
    const imageIds: string[] = [];
    for (const child of Array.from(node.childNodes)) {
      const serialized = this.serializeComposerNode(child);
      content += serialized.content;
      imageIds.push(...serialized.imageIds);
    }
    return { content, imageIds };
  }

  richEditorRangeLength(range: Range): number {
    return this.serializeComposerNode(range.cloneContents()).content.length;
  }

  richEditorSelectionOffsets(editor: HTMLElement): { start: number; end: number } | null {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return null;
    const range = selection.getRangeAt(0);
    if (
      !editor.contains(range.startContainer) ||
      !editor.contains(range.endContainer)
    ) return null;

    const startRange = document.createRange();
    startRange.selectNodeContents(editor);
    startRange.setEnd(range.startContainer, range.startOffset);
    const endRange = document.createRange();
    endRange.selectNodeContents(editor);
    endRange.setEnd(range.endContainer, range.endOffset);
    return {
      start: this.richEditorRangeLength(startRange),
      end: this.richEditorRangeLength(endRange)
    };
  }

  composerRangeLength(range: Range): number {
    return this.richEditorRangeLength(range);
  }

  composerSelectionOffsets(): { start: number; end: number } | null {
    const editor = this.hooks.composerEditorElement();
    return editor ? this.richEditorSelectionOffsets(editor) : null;
  }

  composerSelectionRange(): { start: number; end: number } {
    const offsets = this.composerSelectionOffsets() ?? {
      start: this.composerSelectionStart,
      end: this.composerSelectionEnd
    };
    const start = Math.max(0, Math.min(this.draft.length, Math.min(offsets.start, offsets.end)));
    const end = Math.max(start, Math.min(this.draft.length, Math.max(offsets.start, offsets.end)));
    return { start, end };
  }

  richEditorDOMPointAtOffset(editor: HTMLElement, contentLength: number, targetOffset: number): { node: Node; offset: number } {
    const target = Math.max(0, Math.min(contentLength, targetOffset));
    let consumed = 0;
    let lastPoint: { node: Node; offset: number } = {
      node: editor,
      offset: editor.childNodes.length
    };

    const visit = (parent: Node): { node: Node; offset: number } | null => {
      const children = Array.from(parent.childNodes);
      for (const [childIndex, child] of children.entries()) {
        const atomicContent = this.composerInlineImageId(child) ? composerInlineImagePlaceholder : this.composerAtomicToken(child);
        if (atomicContent) {
          if (target <= consumed) return { node: parent, offset: childIndex };
          consumed += atomicContent.length;
          lastPoint = { node: parent, offset: childIndex + 1 };
          if (target <= consumed) return lastPoint;
          continue;
        }
        if (child.nodeType === Node.TEXT_NODE) {
          const length = child.textContent?.length ?? 0;
          if (target <= consumed + length) {
            return { node: child, offset: Math.max(0, Math.min(length, target - consumed)) };
          }
          consumed += length;
          lastPoint = { node: child, offset: length };
          continue;
        }
        if (child instanceof HTMLElement && child.tagName === "BR") {
          if (target <= consumed) return { node: parent, offset: childIndex };
          consumed += 1;
          lastPoint = { node: parent, offset: childIndex + 1 };
          if (target <= consumed) return lastPoint;
          continue;
        }
        const nestedPoint = visit(child);
        if (nestedPoint) return nestedPoint;
      }
      return null;
    };

    return visit(editor) ?? lastPoint;
  }

  restoreRichEditorSelection(editor: HTMLElement, contentLength: number, start: number, end = start): void {
    const range = document.createRange();
    const selection = window.getSelection();
    const startPoint = this.richEditorDOMPointAtOffset(editor, contentLength, Math.min(start, end));
    const endPoint = this.richEditorDOMPointAtOffset(editor, contentLength, Math.max(start, end));
    if (!startPoint || !endPoint) return;
    range.setStart(startPoint.node, startPoint.offset);
    range.setEnd(endPoint.node, endPoint.offset);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  restoreComposerSelection(start: number, end = start): void {
    const editor = this.hooks.composerEditorElement();
    if (!editor) return;
    this.restoreRichEditorSelection(editor, this.draft.length, start, end);
  }

  renderComposerEditor(content: string, selectionStart?: number, selectionEnd = selectionStart): void {
    const editor = this.hooks.composerEditorElement();
    if (!editor || this.composerInputComposing) return;
    const nextHTML = this.formatComposerEditorContent(content);
    if (editor.innerHTML !== nextHTML) editor.innerHTML = nextHTML;
    if (selectionStart !== undefined && document.activeElement === editor) {
      this.restoreComposerSelection(selectionStart, selectionEnd);
    }
    this.updateComposerImageSelection(selectionStart, selectionEnd);
    this.observeComposerEmbeddedMediaLayout();
  }

  updateComposerImageSelection(start = this.composerSelectionStart, end = this.composerSelectionEnd): void {
    const editor = this.hooks.composerEditorElement();
    if (!editor) return;
    const selectionStart = Math.min(start, end);
    const selectionEnd = Math.max(start, end);
    let imageOffset = -1;
    let searchOffset = 0;
    for (const element of editor.querySelectorAll<HTMLElement>("[data-composer-inline-image]")) {
      imageOffset = this.draft.indexOf(composerInlineImagePlaceholder, searchOffset);
      if (imageOffset < 0) break;
      element.classList.toggle("selected", selectionEnd > selectionStart && imageOffset >= selectionStart && imageOffset < selectionEnd);
      searchOffset = imageOffset + composerInlineImagePlaceholder.length;
    }
  }

  updateComposerSelection(): void {
    const offsets = this.composerSelectionOffsets();
    if (!offsets) {
      this.emojiController().hideAutocomplete();
      return;
    }
    this.composerSelectionStart = offsets.start;
    this.composerSelectionEnd = offsets.end;
    this.updateComposerImageSelection(offsets.start, offsets.end);
    this.emojiController().updateAutocomplete(offsets);
  }

  handleComposerBlur(): void {
    this.updateComposerSelection();
    window.setTimeout(() => {
      if (document.activeElement !== this.hooks.composerEditorElement()) this.emojiController().hideAutocomplete();
    }, 0);
  }

  hideEmojiAutocomplete(): void {
    this.emojiController().hideAutocomplete();
  }

  updateEmojiAutocomplete(offsets = this.composerSelectionOffsets()): void {
    this.emojiController().updateAutocomplete(offsets);
  }

  positionEmojiAutocomplete(): void {
    this.emojiController().positionAutocomplete();
  }

  moveEmojiAutocompleteSelection(delta: number): void {
    this.emojiController().moveAutocompleteSelection(delta);
  }

  selectEmojiAutocompleteEntry(entry: EmojiPickerEntry): void {
    this.emojiController().selectAutocompleteEntry(entry);
  }

  syncComposerImagesFromDOM(snapshot: { content: string; imageIds: string[] }): string {
    const imagesById = new Map(this.composerInlineImageRegistry);
    for (const image of this.composerInlineImages) imagesById.set(image.localId, image);
    const nextImages: ComposerInlineImage[] = [];
    const retainedIds = new Set<string>();
    let imageIdIndex = 0;
    const content = snapshot.content.replaceAll(composerInlineImagePlaceholder, () => {
      const imageId = snapshot.imageIds[imageIdIndex] ?? "";
      imageIdIndex += 1;
      const image = imagesById.get(imageId);
      if (!image || retainedIds.has(imageId)) return "";
      retainedIds.add(imageId);
      nextImages.push(image);
      return composerInlineImagePlaceholder;
    });
    this.composerInlineImages = nextImages;
    return content;
  }

  handleComposerInput(event: InputEvent): void {
    const editor = event.currentTarget as HTMLDivElement;
    const previous = this.captureComposerSnapshot();
    const snapshot = this.serializeComposerNode(editor);
    const offsets = this.composerSelectionOffsets() ?? {
      start: snapshot.content.length,
      end: snapshot.content.length
    };
    this.draft = this.syncComposerImagesFromDOM(snapshot);
    this.composerSelectionStart = Math.min(this.draft.length, offsets.start);
    this.composerSelectionEnd = Math.min(this.draft.length, offsets.end);
    if (!event.isComposing && !this.composerInputComposing) {
      this.recordComposerMutation(previous);
      this.renderComposerEditor(this.draft, this.composerSelectionStart, this.composerSelectionEnd);
      this.emojiController().updateAutocomplete({ start: this.composerSelectionStart, end: this.composerSelectionEnd });
    }
    this.scheduleComposerLayoutRefresh();
  }

  handleComposerCompositionStart(): void {
    this.composerCompositionSnapshot = this.captureComposerSnapshot(true);
    this.composerInputComposing = true;
    this.emojiController().hideAutocomplete();
  }

  handleComposerCompositionEnd(event: CompositionEvent): void {
    this.composerInputComposing = false;
    const editor = event.currentTarget as HTMLDivElement;
    const previous = this.composerCompositionSnapshot ?? this.captureComposerSnapshot();
    this.composerCompositionSnapshot = null;
    const snapshot = this.serializeComposerNode(editor);
    const offsets = this.composerSelectionOffsets() ?? {
      start: snapshot.content.length,
      end: snapshot.content.length
    };
    this.draft = this.syncComposerImagesFromDOM(snapshot);
    this.composerSelectionStart = Math.min(this.draft.length, offsets.start);
    this.composerSelectionEnd = Math.min(this.draft.length, offsets.end);
    this.recordComposerMutation(previous);
    this.renderComposerEditor(this.draft, this.composerSelectionStart, this.composerSelectionEnd);
    this.emojiController().updateAutocomplete({ start: this.composerSelectionStart, end: this.composerSelectionEnd });
    this.scheduleComposerLayoutRefresh();
  }

  countComposerInlineImages(content: string): number {
    return content.split(composerInlineImagePlaceholder).length - 1;
  }

  composerInlineImageOffset(imageIndex: number): number {
    let offset = -1;
    let searchOffset = 0;
    for (let index = 0; index <= imageIndex; index += 1) {
      offset = this.draft.indexOf(composerInlineImagePlaceholder, searchOffset);
      if (offset < 0) return -1;
      searchOffset = offset + composerInlineImagePlaceholder.length;
    }
    return offset;
  }

  replaceComposerRange(
    requestedStart: number,
    requestedEnd: number,
    content: string,
    insertedImages: ComposerInlineImage[] = []
  ): void {
    const editor = this.hooks.composerEditorElement();
    if (!editor) return;
    const previous = this.captureComposerSnapshot(true);
    const start = Math.max(0, Math.min(this.draft.length, Math.min(requestedStart, requestedEnd)));
    const end = Math.max(start, Math.min(this.draft.length, Math.max(requestedStart, requestedEnd)));
    if (this.countComposerInlineImages(content) !== insertedImages.length) {
      throw new Error("Composer image content is out of sync");
    }
    const imageStart = this.countComposerInlineImages(this.draft.slice(0, start));
    const removedImageCount = this.countComposerInlineImages(this.draft.slice(start, end));
    const nextRegistry = new Map(this.composerInlineImageRegistry);
    for (const image of insertedImages) nextRegistry.set(image.localId, image);
    this.composerInlineImageRegistry = nextRegistry;
    this.composerInlineImages = [
      ...this.composerInlineImages.slice(0, imageStart),
      ...insertedImages,
      ...this.composerInlineImages.slice(imageStart + removedImageCount)
    ];
    this.draft = `${this.draft.slice(0, start)}${content}${this.draft.slice(end)}`;
    const cursor = start + content.length;
    this.composerSelectionStart = cursor;
    this.composerSelectionEnd = cursor;
    this.recordComposerMutation(previous);
    editor.focus({ preventScroll: true });
    this.renderComposerEditor(this.draft, cursor, cursor);
    this.scheduleComposerLayoutRefresh();
  }

  replaceComposerSelection(content: string): void {
    const range = this.composerSelectionRange();
    this.replaceComposerRange(
      range.start,
      range.end,
      content.replaceAll(composerInlineImagePlaceholder, "")
    );
  }

  handleComposerEditorClick(event: MouseEvent): void {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[data-composer-remove-image]")
      : null;
    if (!target) return;
    event.preventDefault();
    this.removeComposerInlineImage(target.dataset.composerRemoveImage ?? "");
  }

  handleComposerPaste(event: ClipboardEvent): void {
    const clipboard = event.clipboardData;
    const insertionRange = this.composerSelectionRange();
    let imageFiles = Array.from(clipboard?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.toLowerCase().startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (imageFiles.length === 0) {
      imageFiles = Array.from(clipboard?.files ?? []).filter((file) => Boolean(this.composerImageMIME(file)));
    }
    if (imageFiles.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      this.composerSelectionStart = insertionRange.start;
      this.composerSelectionEnd = insertionRange.end;
      void this.queueComposerInlineImages(imageFiles, insertionRange);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.replaceComposerRange(
      insertionRange.start,
      insertionRange.end,
      (clipboard?.getData("text/plain") ?? "").replace(/\r\n?/g, "\n").replaceAll(composerInlineImagePlaceholder, "")
    );
  }

  composerDragContainsFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }

  handleComposerDragEnter(event: DragEvent): void {
    if (!this.composerDragContainsFiles(event) || !this.hooks.canSendMessages() || this.messageSubmitting) return;
    event.preventDefault();
    this.composerInlineImageDragActive = true;
    this.flush();
  }

  handleComposerDragOver(event: DragEvent): void {
    if (!this.composerDragContainsFiles(event) || !this.hooks.canSendMessages() || this.messageSubmitting) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    this.composerInlineImageDragActive = true;
    this.flush();
  }

  handleComposerDragLeave(event: DragEvent): void {
    const form = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && form.contains(event.relatedTarget)) return;
    this.composerInlineImageDragActive = false;
    this.flush();
  }

  composerDropRange(event: DragEvent): { start: number; end: number } {
    const editor = this.hooks.composerEditorElement();
    if (!editor) return this.composerSelectionRange();
    const caretDocument = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const caretRange = caretDocument.caretRangeFromPoint?.(event.clientX, event.clientY);
    const caretPosition = caretRange ? null : caretDocument.caretPositionFromPoint?.(event.clientX, event.clientY);
    const node = caretRange?.startContainer ?? caretPosition?.offsetNode;
    const offset = caretRange?.startOffset ?? caretPosition?.offset;
    if (!node || offset === undefined || !editor.contains(node)) {
      return { start: this.draft.length, end: this.draft.length };
    }
    const prefixRange = document.createRange();
    prefixRange.selectNodeContents(editor);
    prefixRange.setEnd(node, offset);
    const insertionOffset = Math.min(this.draft.length, this.composerRangeLength(prefixRange));
    return { start: insertionOffset, end: insertionOffset };
  }

  handleComposerImageDrop(event: DragEvent): void {
    if (!this.composerDragContainsFiles(event)) return;
    event.preventDefault();
    this.composerInlineImageDragActive = false;
    this.flush();
    const images = Array.from(event.dataTransfer?.files ?? []).filter((file) => Boolean(this.composerImageMIME(file)));
    if (images.length === 0) {
      this.hooks.setError(this.hooks.translate("error.messageImageUnsupported"));
      return;
    }
    void this.queueComposerInlineImages(images, this.composerDropRange(event));
  }

  handleComposerScroll(): void {
    this.updateComposerScrollbar();
    if (this.emojiController().autocompleteState) this.emojiController().positionAutocomplete();
  }

  updateComposerScrollbar(): void {
    const editor = this.hooks.composerEditorElement();
    if (!editor) {
      this.composerScrollbarVisible = false;
      this.flush();
      return;
    }
    const scrollHeight = editor.scrollHeight;
    const clientHeight = editor.clientHeight;
    const scrollable = scrollHeight - clientHeight;
    const hasScrollableContent = this.draft.trim().length > 0;
    this.composerScrollbarVisible = hasScrollableContent && scrollable > 3;
    if (!this.composerScrollbarVisible) {
      this.finishComposerScrollbarDrag();
      this.composerScrollbarThumbTop = 0;
      this.composerScrollbarThumbHeight = 24;
      this.flush();
      return;
    }

    const trackHeight = Math.max(24, clientHeight - 14);
    const thumbHeight = Math.max(24, Math.round((clientHeight / scrollHeight) * trackHeight));
    const thumbRange = Math.max(1, trackHeight - thumbHeight);
    this.composerScrollbarThumbHeight = thumbHeight;
    this.composerScrollbarThumbTop = Math.round((editor.scrollTop / scrollable) * thumbRange);
    this.flush();
  }

  startComposerScrollbarDrag(event: PointerEvent): void {
    const editor = this.hooks.composerEditorElement();
    if (!editor || !this.composerScrollbarVisible) return;
    event.preventDefault();
    event.stopPropagation();
    this.composerScrollbarDragging = true;
    this.composerScrollbarDragStartY = event.clientY;
    this.composerScrollbarDragStartScrollTop = editor.scrollTop;
    document.body.classList.add("composer-scrollbar-drag-active");
    window.addEventListener("pointermove", this.dragComposerScrollbar);
    window.addEventListener("pointerup", this.finishComposerScrollbarDrag);
    window.addEventListener("pointercancel", this.finishComposerScrollbarDrag);
    this.flush();
  }

  dragComposerScrollbar = (event: PointerEvent): void => {
    const editor = this.hooks.composerEditorElement();
    if (!editor || !this.composerScrollbarDragging) return;
    event.preventDefault();
    const scrollable = editor.scrollHeight - editor.clientHeight;
    const trackHeight = Math.max(24, editor.clientHeight - 14);
    const thumbRange = Math.max(1, trackHeight - this.composerScrollbarThumbHeight);
    const deltaY = event.clientY - this.composerScrollbarDragStartY;
    editor.scrollTop = this.composerScrollbarDragStartScrollTop + (deltaY / thumbRange) * scrollable;
    this.updateComposerScrollbar();
  };

  finishComposerScrollbarDrag = (): void => {
    if (!this.composerScrollbarDragging) return;
    this.composerScrollbarDragging = false;
    document.body.classList.remove("composer-scrollbar-drag-active");
    window.removeEventListener("pointermove", this.dragComposerScrollbar);
    window.removeEventListener("pointerup", this.finishComposerScrollbarDrag);
    window.removeEventListener("pointercancel", this.finishComposerScrollbarDrag);
    this.flush();
  };

  isMessageListNearBottom(): boolean {
    const list = this.hooks.messageListElement();
    if (!list) return true;
    const remaining =
      list.scrollHeight - list.scrollTop - list.clientHeight;
    return remaining < 96;
  }

  handleMessageListScroll(): void {
    const messages = this.messages();
    if (messages.currentChannelNewMessageCount > 0 && this.isMessageListNearBottom()) {
      messages.currentChannelNewMessageCount = 0;
      messages.currentChannelNewMessageStartId = "";
    }
    const list = this.hooks.messageListElement();
    if (this.hooks.selectedChannelId() && list) {
      this.readStateByChannel = {
        ...this.readStateByChannel,
        [this.hooks.selectedChannelId()]: {
          scroll_top: Math.max(0, Math.round(list.scrollTop)),
          last_read_at_ms: Date.now()
        }
      };
      this.persistReadState();
    }
  }

  incrementUnread(channelId: string): void {
    if (!channelId || channelId === this.hooks.selectedChannelId()) return;
    const next = new Map(this.unreadCountsByChannel);
    next.set(channelId, (next.get(channelId) ?? 0) + 1);
    this.unreadCountsByChannel = next;
    this.persistUnreadCounts();
    this.flush();
  }

  clearChannelUnread(channelId: string): void {
    if (!this.unreadCountsByChannel.has(channelId)) return;
    const next = new Map(this.unreadCountsByChannel);
    next.delete(channelId);
    this.unreadCountsByChannel = next;
    this.persistUnreadCounts();
    this.flush();
  }

  buildUnreadLabels(): Map<string, string> {
    const labels = new Map<string, string>();
    for (const [channelId, count] of this.unreadCountsByChannel.entries()) {
      if (count > 0) labels.set(channelId, count > 99 ? "99+" : String(count));
    }
    return labels;
  }

  buildCategoryUnreadLabels(tree: ChannelTree): Map<string, string> {
    const labels = new Map<string, string>();
    for (const category of getCategoryChannels(tree)) {
      const count = getChildChannels(tree, category.channel_id).reduce(
        (total, channel) => total + (this.unreadCountsByChannel.get(channel.channel_id) ?? 0),
        0
      );
      if (count > 0) labels.set(category.channel_id, count > 99 ? "99+" : String(count));
    }
    return labels;
  }

  persistUnreadCounts(): void {
    const serverId = this.hooks.currentStorageServerId();
    if (!serverId) return;
    saveUnreadCounts(serverId, Object.fromEntries(this.unreadCountsByChannel));
  }

  persistReadState(): void {
    const serverId = this.hooks.currentStorageServerId();
    if (!serverId) return;
    saveReadState(serverId, this.readStateByChannel);
  }

  loadWorkspaceReadState(serverId: string): void {
    this.unreadCountsByChannel = new Map(Object.entries(loadUnreadCounts(serverId)));
    this.readStateByChannel = loadReadState(serverId);
    this.flush();
  }

  handleComposerBeforeInput(event: InputEvent): void {
    if (event.inputType !== "historyUndo" && event.inputType !== "historyRedo") return;
    event.preventDefault();
    if (event.inputType === "historyUndo") this.undoComposerMutation();
    else this.redoComposerMutation();
  }

  handleComposerKeydown(event: KeyboardEvent): void {
    if (event.isComposing) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === "z" || key === "y")) {
      event.preventDefault();
      if (key === "y" || event.shiftKey) this.redoComposerMutation();
      else this.undoComposerMutation();
      return;
    }
    const emojiController = this.emojiController();
    if (emojiController.autocompleteState && emojiController.autocompleteEntries.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        emojiController.moveAutocompleteSelection(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        emojiController.selectAutocompleteEntry(emojiController.autocompleteEntries[this.hooks.emojiAutocompleteSelectedIndex()]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        emojiController.hideAutocomplete();
        return;
      }
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      const range = this.composerSelectionRange();
      if (range.start !== range.end && this.countComposerInlineImages(this.draft.slice(range.start, range.end)) > 0) {
        event.preventDefault();
        this.replaceComposerRange(range.start, range.end, "");
        return;
      }
      const imageOffset = event.key === "Backspace" ? range.start - 1 : range.start;
      if (
        range.start === range.end &&
        imageOffset >= 0 &&
        this.draft.slice(imageOffset, imageOffset + 1) === composerInlineImagePlaceholder
      ) {
        event.preventDefault();
        this.replaceComposerRange(imageOffset, imageOffset + 1, "");
      }
      return;
    }
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (event.shiftKey) {
      this.replaceComposerSelection("\n");
    } else {
      void this.submitMessage();
    }
  }

  async loadOlderMessages(): Promise<void> {
    const pending = this.messages().loadOlderMessages();
    this.flush();
    return pending;
  }

  // ---------------------------------------------------------------------------
  // Message edit editor
  // ---------------------------------------------------------------------------

  formatMessageEditTextContent(content: string): string {
    const pattern = /<:file:[A-Za-z0-9_-]{1,160}:[0-9]{1,16}:[A-Za-z0-9_.!~*%()-]+:[A-Za-z0-9_.!~*%()-]+>/g;
    const escapeHTML = (value: string) => this.messages().escapeHTML(value);
    let html = "";
    let offset = 0;
    for (const match of content.matchAll(pattern)) {
      const token = match[0];
      const index = match.index ?? offset;
      html += this.formatComposerEditorContent(content.slice(offset, index));
      const reference = parseMessageAttachmentReferences(token)[0];
      if (!reference) {
        html += escapeHTML(token);
      } else {
        html += `<span class="message-edit-attachment-embed" data-composer-token="${escapeHTML(token)}" contenteditable="false" draggable="false"><span class="material-symbols-rounded app-icon" aria-hidden="true">attach_file</span><span>${escapeHTML(reference.name)}</span></span>`;
      }
      offset = index + token.length;
    }
    return html + this.formatComposerEditorContent(content.slice(offset));
  }

  formatMessageEditContent(content: string): string {
    const escapeHTML = (value: string) => this.messages().escapeHTML(value);
    return parseMessageContentSegments(content).map((segment) => {
      if (segment.type === "text") return this.formatMessageEditTextContent(segment.content);
      const source = this.messageAttachmentObjectURLs.get(segment.image.assetSHA256);
      const label = escapeHTML(segment.image.name);
      const preview = source
        ? `<img src="${escapeHTML(source)}" alt="${label}" draggable="false">`
        : `<span class="material-symbols-rounded app-icon" aria-hidden="true">image</span>`;
      return `<span class="message-edit-inline-image" data-composer-token="${escapeHTML(segment.token)}" contenteditable="false" draggable="false" data-tooltip="${label}" aria-label="${label}">${preview}</span>`;
    }).join("");
  }

  messageEditSelectionRange(): { start: number; end: number } {
    const editor = this.hooks.messageEditEditorElement();
    const offsets = editor ? this.richEditorSelectionOffsets(editor) : null;
    const draftLength = this.messages().editingMessageDraft.length;
    const start = Math.max(0, Math.min(draftLength, Math.min(offsets?.start ?? draftLength, offsets?.end ?? draftLength)));
    const end = Math.max(start, Math.min(draftLength, Math.max(offsets?.start ?? draftLength, offsets?.end ?? draftLength)));
    return { start, end };
  }

  renderMessageEditEditor(content: string, selectionStart?: number, selectionEnd = selectionStart): void {
    const editor = this.hooks.messageEditEditorElement();
    if (!editor) return;
    const preservedSelection = selectionStart === undefined && document.activeElement === editor
      ? this.richEditorSelectionOffsets(editor)
      : null;
    const nextHTML = this.formatMessageEditContent(content);
    if (editor.innerHTML !== nextHTML) editor.innerHTML = nextHTML;
    const start = selectionStart ?? preservedSelection?.start;
    const end = selectionEnd ?? preservedSelection?.end ?? start;
    if (start !== undefined && document.activeElement === editor) {
      this.restoreRichEditorSelection(editor, content.length, start, end);
    }
    this.adjustMessageEditHeight();
  }

  async beginEditMessage(message: Message): Promise<void> {
    const messages = this.messages();
    messages.closeMessageContextMenu();
    messages.editingMessageId = message.message_id;
    messages.editingMessageDraft = message.content;
    this.flush();
    await tick();
    this.renderMessageEditEditor(messages.editingMessageDraft);
    const editor = this.hooks.messageEditEditorElement();
    if (editor) {
      editor.focus({ preventScroll: true });
      this.restoreRichEditorSelection(
        editor,
        messages.editingMessageDraft.length,
        messages.editingMessageDraft.length
      );
    }
    const imageReferences = parseMessageContentSegments(message.content)
      .filter((segment) => segment.type === "image")
      .map((segment) => segment.image);
    void Promise.allSettled([
      this.emojiController().prepareMessageAssets([message]),
      ...imageReferences.map((reference) => this.hooks.ensureMessageImagePreview(reference))
    ]).then(async () => {
      if (messages.editingMessageId !== message.message_id) return;
      await tick();
      this.renderMessageEditEditor(messages.editingMessageDraft);
    });
  }

  cancelEditMessage(): void {
    this.messages().editingMessageId = "";
    this.messages().editingMessageDraft = "";
    this.hooks.setMessageEditEditorElement(null);
    this.flush();
  }

  adjustMessageEditHeight(): void {
    const editor = this.hooks.messageEditEditorElement();
    if (!editor) return;
    const minHeight = 72;
    const maxHeight = 220;
    editor.style.height = "auto";
    const nextHeight = Math.min(Math.max(editor.scrollHeight, minHeight), maxHeight);
    editor.style.height = `${nextHeight}px`;
    editor.style.overflowY = editor.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  handleMessageEditInput(event: InputEvent): void {
    const editor = event.currentTarget as HTMLDivElement;
    this.messages().editingMessageDraft = this.serializeComposerNode(editor).content;
    this.adjustMessageEditHeight();
  }

  replaceMessageEditSelection(content: string): void {
    const editor = this.hooks.messageEditEditorElement();
    if (!editor) return;
    const range = this.messageEditSelectionRange();
    const currentDraft = this.messages().editingMessageDraft;
    this.messages().editingMessageDraft = `${currentDraft.slice(0, range.start)}${content}${currentDraft.slice(range.end)}`;
    const cursor = range.start + content.length;
    this.renderMessageEditEditor(this.messages().editingMessageDraft, cursor, cursor);
  }

  handleMessageEditPaste(event: ClipboardEvent): void {
    const content = event.clipboardData?.getData("text/plain").replace(/\r\n?/g, "\n") ?? "";
    event.preventDefault();
    if (!content) return;
    this.replaceMessageEditSelection(content);
  }

  handleMessageEditEmbeddedMediaLoad(event: Event): void {
    if (event.target instanceof HTMLImageElement) this.adjustMessageEditHeight();
  }

  handleEditMessageKeydown(event: KeyboardEvent, message: Message): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.cancelEditMessage();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (!event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        void this.submitEditedMessage(message);
      } else {
        this.replaceMessageEditSelection("\n");
      }
    }
  }

  async submitEditedMessage(message: Message): Promise<void> {
    const content = materializeEmojiAliases(this.messages().editingMessageDraft.trim(), this.emojiController().availableAliases());
    if (!content || !this.hooks.selectedChannelId() || !this.hooks.sessionToken() || this.messages().messageActionBusyId) return;
    if (content === message.content.trim()) {
      this.cancelEditMessage();
      return;
    }
    this.messages().messageActionBusyId = message.message_id;
    this.hooks.setError("");
    this.flush();
    try {
      if (!(await this.emojiController().ensureMessageAssetsOnCurrentServer(content))) return;
      const updated = await updateMessage(this.hooks.baseUrl(), this.hooks.selectedChannelId(), this.hooks.sessionToken(), message.message_id, content);
      this.messages().mergeMessage(updated);
      this.cancelEditMessage();
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.messageUpdateFailed"));
    } finally {
      this.messages().messageActionBusyId = "";
      this.flush();
    }
  }

  async deleteSelectedMessage(message: Message): Promise<void> {
    if (!this.hooks.selectedChannelId() || !this.hooks.sessionToken() || this.messages().messageActionBusyId) return;
    this.messages().closeMessageContextMenu();
    if (!(await this.hooks.showAppConfirm(this.hooks.translate("messages.deleteConfirm"), {
      title: this.hooks.translate("messages.delete"),
      confirmLabel: this.hooks.translate("messages.delete"),
      danger: true
    }))) return;
    this.messages().messageActionBusyId = message.message_id;
    this.hooks.setError("");
    this.flush();
    try {
      const removed = await deleteMessage(this.hooks.baseUrl(), this.hooks.selectedChannelId(), this.hooks.sessionToken(), message.message_id);
      this.messages().removeMessage(removed);
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.messageDeleteFailed"));
    } finally {
      this.messages().messageActionBusyId = "";
      this.flush();
    }
  }

  // ---------------------------------------------------------------------------
  // Disposal
  // ---------------------------------------------------------------------------

  dispose(): void {
    this.finishComposerScrollbarDrag();
    if (this.composerLayoutAnimationFrame) window.cancelAnimationFrame(this.composerLayoutAnimationFrame);
    this.composerEmbeddedMediaResizeObserver?.disconnect();
    this.composerEmbeddedMediaResizeObserver = null;
    this.clearComposerAttachmentObjectURLs();
    this.clearMessageAttachmentObjectURLs();
  }
}
