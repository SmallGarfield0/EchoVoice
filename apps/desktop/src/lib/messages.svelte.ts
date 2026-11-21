// Text channel message data layer.
//
// Owns the server-authoritative message list for the selected channel, the
// optimistic local send queue (pending drafts persisted per server), message
// search state, multi-selection + context-menu state, and the content
// formatting helpers (markdown-lite, code blocks, emoji/file/image tokens,
// linkification). Composer, edit editor, reply UI, message scrolling, and
// emoji asset preparation stay in the workspace component and are reached
// through hooks.
//
// Hot-path discipline: event handlers read this state directly; the
// component's legacy `$` aliases (kept fresh by the realtimeSyncTick bump)
// feed templates only.

import {
  deleteMessage,
  getMessages,
  searchMessages,
  sendMessage
} from "./api";
import {
  emojiAlias,
  getBuiltInGraphicEmoji,
  parseEmojiReferences,
  type EmojiReference,
  type DefaultEmoji
} from "./emoji";
import { savePendingMessages, type PendingMessageDraft } from "./storage";
import type { Message } from "./types";

/** A message merged with local optimistic-send state. */
export type ClientMessage = Message & {
  local_status?: "sending" | "failed";
  local_error?: string;
};

/** Screen position of the message context menu. */
export type MessageContextMenu = {
  messageId: string;
  x: number;
  y: number;
};

export type MessagesHooks = {
  memberId: () => string;
  sessionToken: () => string;
  baseUrl: () => string;
  selectedChannelId: () => string;
  translate: (key: string, params?: Record<string, unknown>) => string;
  setError: (message: string) => void;
  setStatusKey: (key: string) => void;
  showAppConfirm: (message: string, options?: Record<string, unknown>) => Promise<boolean>;
  canManageMessages: () => boolean;
  currentStorageServerId: () => string;
  prepareMessageEmojiAssets: (messages: Array<Pick<Message, "content">>) => void;
  scrollMessagesToBottom: () => void;
  messageListElement: () => HTMLDivElement | null;
  languagePackId: () => string;
  emojiObjectURL: (sha256: string) => string;
  closeCreateChannelMenu: () => void;
  closeChannelContextMenu: () => void;
  closeVoiceParticipantContextMenu: () => void;
  closeServerMenu: () => void;
  closeVoiceNetworkDetails: () => void;
  cancelEditMessage: () => void;
  clearReplyTarget: () => void;
  memberDisplayName: (memberId: string) => string;
  beginEditMessage: (message: Message) => void;
  deleteSelectedMessage: (message: Message) => Promise<void>;
};

export class MessagesController {
  // ---- message list ---------------------------------------------------------
  messages = $state<ClientMessage[]>([]);
  hasOlderMessages = $state(false);
  messageBeforeLoading = $state(false);
  // ---- edit / actions -------------------------------------------------------
  editingMessageId = $state("");
  editingMessageDraft = $state("");
  messageActionBusyId = $state("");
  // ---- search ---------------------------------------------------------------
  messageSearchQuery = $state("");
  messageSearchResults = $state<Message[]>([]);
  messageSearchLoading = $state(false);
  messageSearchOpen = $state(false);
  // ---- unread markers -------------------------------------------------------
  currentChannelNewMessageCount = $state(0);
  currentChannelNewMessageStartId = $state("");
  // ---- selection + context menu ---------------------------------------------
  selectedMessageIds = $state<Set<string>>(new Set());
  messageSelectionAnchorId = $state("");
  messageContextMenu = $state<MessageContextMenu | null>(null);
  // ---- pending local drafts -------------------------------------------------
  pendingMessageDrafts = $state<PendingMessageDraft[]>([]);
  private localMessageSequence = 0;

  constructor(private hooks: MessagesHooks) {}

  // ---- local optimistic queue ------------------------------------------------

  createLocalMessage(
    channelId: string,
    content: string,
    status: ClientMessage["local_status"],
    replyToMessageId = ""
  ): ClientMessage {
    this.localMessageSequence += 1;
    return {
      message_id: `local-${Date.now()}-${this.localMessageSequence}`,
      channel_id: channelId,
      author_id: this.hooks.memberId(),
      content,
      reply_to_message_id: replyToMessageId,
      created_at_ms: Date.now(),
      local_status: status
    };
  }

  isLocalMessage(message: Message | ClientMessage): boolean {
    return message.message_id.startsWith("local-");
  }

  replaceLocalMessage(localMessageId: string, message: Message): void {
    this.messages = this.messages
      .filter((item) => item.message_id !== localMessageId)
      .map((item) => (item.message_id === message.message_id ? message : item));
    this.mergeMessage(message);
  }

  markLocalMessageFailed(localMessageId: string, localError: string): void {
    this.messages = this.messages.map((message) =>
      message.message_id === localMessageId
        ? { ...message, local_status: "failed", local_error: localError || this.hooks.translate("error.messageSendFailed") }
        : message
    );
    const failed = this.messages.find((message) => message.message_id === localMessageId);
    if (failed) this.upsertPendingMessage(failed, localError || this.hooks.translate("error.messageSendFailed"));
  }

  async retryLocalMessage(message: ClientMessage): Promise<void> {
    if (!this.hooks.sessionToken() || message.local_status !== "failed") return;
    this.messages = this.messages.map((item) =>
      item.message_id === message.message_id ? { ...item, local_status: "sending", local_error: "" } : item
    );
    try {
      const sent = await sendMessage(
        this.hooks.baseUrl(),
        message.channel_id,
        this.hooks.sessionToken(),
        message.content,
        message.reply_to_message_id ?? ""
      );
      this.removePendingMessage(message.message_id);
      if (this.hooks.selectedChannelId() === message.channel_id) {
        this.replaceLocalMessage(message.message_id, sent);
        this.hooks.scrollMessagesToBottom();
      }
    } catch (caught) {
      if (this.hooks.selectedChannelId() === message.channel_id) {
        this.markLocalMessageFailed(
          message.message_id,
          caught instanceof Error ? caught.message : this.hooks.translate("error.messageSendFailed")
        );
      }
    }
  }

  dismissLocalMessage(message: ClientMessage): void {
    if (!this.isLocalMessage(message)) return;
    this.removePendingMessage(message.message_id);
    this.messages = this.messages.filter((item) => item.message_id !== message.message_id);
  }

  pendingLocalMessagesForChannel(channelId: string): ClientMessage[] {
    return this.pendingMessageDrafts
      .filter((message) => message.channel_id === channelId)
      .map((message) => ({
        message_id: message.local_id,
        channel_id: message.channel_id,
        author_id: this.hooks.memberId(),
        content: message.content,
        reply_to_message_id: message.reply_to_message_id,
        created_at_ms: message.created_at_ms,
        local_status: "failed",
        local_error: message.error || this.hooks.translate("error.messageSendFailed")
      }));
  }

  setPendingDrafts(drafts: PendingMessageDraft[]): void {
    this.pendingMessageDrafts = drafts;
  }

  upsertPendingMessage(message: ClientMessage, errorMessage = ""): void {
    if (!this.isLocalMessage(message)) return;
    const pending: PendingMessageDraft = {
      local_id: message.message_id,
      channel_id: message.channel_id,
      content: message.content,
      reply_to_message_id: message.reply_to_message_id,
      created_at_ms: message.created_at_ms,
      error: errorMessage || message.local_error || ""
    };
    this.pendingMessageDrafts = [
      pending,
      ...this.pendingMessageDrafts.filter((item) => item.local_id !== message.message_id)
    ].sort((left, right) => left.created_at_ms - right.created_at_ms);
    this.persistPendingMessages();
  }

  removePendingMessage(localMessageId: string): void {
    const next = this.pendingMessageDrafts.filter((message) => message.local_id !== localMessageId);
    if (next.length === this.pendingMessageDrafts.length) return;
    this.pendingMessageDrafts = next;
    this.persistPendingMessages();
  }

  persistPendingMessages(): void {
    const serverId = this.hooks.currentStorageServerId();
    if (!serverId) return;
    savePendingMessages(serverId, this.pendingMessageDrafts);
  }

  async flushPendingMessages(): Promise<void> {
    if (!this.hooks.sessionToken() || this.pendingMessageDrafts.length === 0) return;
    for (const pending of [...this.pendingMessageDrafts]) {
      try {
        const sent = await sendMessage(
          this.hooks.baseUrl(),
          pending.channel_id,
          this.hooks.sessionToken(),
          pending.content,
          pending.reply_to_message_id ?? ""
        );
        this.removePendingMessage(pending.local_id);
        if (this.hooks.selectedChannelId() === pending.channel_id) {
          this.replaceLocalMessage(pending.local_id, sent);
        }
      } catch (caught) {
        const localError = caught instanceof Error ? caught.message : this.hooks.translate("error.messageSendFailed");
        this.pendingMessageDrafts = this.pendingMessageDrafts.map((item) =>
          item.local_id === pending.local_id ? { ...item, error: localError } : item
        );
        this.persistPendingMessages();
        if (this.hooks.selectedChannelId() === pending.channel_id) {
          this.markLocalMessageFailed(pending.local_id, localError);
        }
      }
    }
  }

  // ---- server sync -----------------------------------------------------------

  async refreshCurrentChannelMessages(): Promise<void> {
    if (!this.hooks.selectedChannelId() || !this.hooks.sessionToken()) return;
    const channelId = this.hooks.selectedChannelId();
    try {
      const loadedMessages = await getMessages(this.hooks.baseUrl(), channelId, this.hooks.sessionToken());
      if (this.hooks.selectedChannelId() !== channelId) return;
      const localMessages = this.messages.filter((message) => this.isLocalMessage(message));
      const byId = new Map<string, ClientMessage>();
      for (const message of [...this.messages.filter((message) => !this.isLocalMessage(message)), ...loadedMessages]) {
        byId.set(message.message_id, message);
      }
      this.messages = [...byId.values(), ...localMessages].sort((left, right) => left.created_at_ms - right.created_at_ms);
      this.hooks.prepareMessageEmojiAssets(loadedMessages);
    } catch {
      // Reconnect recovery is best-effort; the visible connection state already communicates the issue.
    }
  }

  async loadOlderMessages(): Promise<void> {
    if (!this.hooks.selectedChannelId() || !this.hooks.sessionToken() || this.messageBeforeLoading || this.messages.length === 0) return;
    this.messageBeforeLoading = true;
    this.hooks.setError("");
    const listElement = this.hooks.messageListElement();
    const previousScrollHeight = listElement?.scrollHeight ?? 0;
    const previousScrollTop = listElement?.scrollTop ?? 0;
    try {
      const beforeMS = this.messages[0]?.created_at_ms ?? 0;
      const older = await getMessages(this.hooks.baseUrl(), this.hooks.selectedChannelId(), this.hooks.sessionToken(), beforeMS, 50);
      const known = new Set(this.messages.map((message) => message.message_id));
      this.messages = [...older.filter((message) => !known.has(message.message_id)), ...this.messages];
      this.hasOlderMessages = older.length >= 50;
      const current = this.hooks.messageListElement();
      if (current) {
        current.scrollTop = current.scrollHeight - previousScrollHeight + previousScrollTop;
      }
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.messagesLoadFailed"));
    } finally {
      this.messageBeforeLoading = false;
    }
  }

  mergeMessage(message: Message): void {
    if (!message?.message_id || message.deleted_at_ms) return;
    const exists = this.messages.some((item) => item.message_id === message.message_id);
    this.messages = exists
      ? this.messages.map((item) => (item.message_id === message.message_id ? message : item))
      : [...this.messages, message];
    this.messages = this.messages.sort((left, right) => left.created_at_ms - right.created_at_ms);
    this.hooks.prepareMessageEmojiAssets([message]);
  }

  mergeMessages(nextMessages: Message[]): void {
    if (!Array.isArray(nextMessages) || nextMessages.length === 0) return;
    const byId = new Map<string, ClientMessage>();
    for (const message of this.messages) {
      byId.set(message.message_id, message);
    }
    for (const message of nextMessages) {
      if (message?.message_id && !message.deleted_at_ms) byId.set(message.message_id, message);
    }
    this.messages = [...byId.values()].sort((left, right) => left.created_at_ms - right.created_at_ms);
    this.hooks.prepareMessageEmojiAssets(nextMessages);
  }

  removeMessage(message: Message): void {
    if (!message?.message_id) return;
    this.messages = this.messages.filter((item) => item.message_id !== message.message_id);
    this.messageSearchResults = this.messageSearchResults.filter((item) => item.message_id !== message.message_id);
    if (this.editingMessageId === message.message_id) this.hooks.cancelEditMessage();
    this.selectedMessageIds = new Set([...this.selectedMessageIds].filter((entryId) => entryId !== message.message_id));
    if (this.messageSelectionAnchorId === message.message_id) this.messageSelectionAnchorId = "";
    this.hooks.clearReplyTarget();
  }

  // ---- search ----------------------------------------------------------------

  async submitMessageSearch(): Promise<void> {
    const query = this.messageSearchQuery.trim();
    if (!query || !this.hooks.selectedChannelId() || !this.hooks.sessionToken() || this.messageSearchLoading) {
      this.messageSearchResults = [];
      this.messageSearchOpen = false;
      return;
    }
    this.messageSearchLoading = true;
    this.messageSearchOpen = true;
    this.hooks.setError("");
    try {
      this.messageSearchResults = await searchMessages(this.hooks.baseUrl(), this.hooks.selectedChannelId(), this.hooks.sessionToken(), query, 25);
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.messageSearchFailed"));
      this.messageSearchResults = [];
    } finally {
      this.messageSearchLoading = false;
    }
  }

  clearMessageSearch(): void {
    this.messageSearchQuery = "";
    this.messageSearchResults = [];
    this.messageSearchOpen = false;
    this.messageSearchLoading = false;
  }

  messageById(messageId: string | undefined): Message | ClientMessage | undefined {
    if (!messageId) return undefined;
    return this.messages.find((message) => message.message_id === messageId);
  }

  // ---- selection + context menu ----------------------------------------------

  clearMessageSelection(): void {
    this.selectedMessageIds = new Set<string>();
    this.messageSelectionAnchorId = "";
  }

  handleMessageSelection(message: Message, event: MouseEvent | KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, a, input, textarea, select")) return;
    const toggle = event.ctrlKey || event.metaKey;
    if (event.shiftKey && this.messageSelectionAnchorId) {
      const anchorIndex = this.messages.findIndex((item) => item.message_id === this.messageSelectionAnchorId);
      const targetIndex = this.messages.findIndex((item) => item.message_id === message.message_id);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [start, end] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        const range = this.messages.slice(start, end + 1).map((item) => item.message_id);
        this.selectedMessageIds = toggle
          ? new Set([...this.selectedMessageIds, ...range])
          : new Set(range);
        event.preventDefault();
        return;
      }
    }
    if (toggle) {
      const next = new Set(this.selectedMessageIds);
      if (next.has(message.message_id)) next.delete(message.message_id);
      else next.add(message.message_id);
      this.selectedMessageIds = next;
    } else {
      this.selectedMessageIds = new Set([message.message_id]);
    }
    this.messageSelectionAnchorId = message.message_id;
    event.preventDefault();
  }

  prepareMessageContextSelection(message: Message, event: MouseEvent): void {
    if (this.selectedMessageIds.has(message.message_id)) return;
    this.selectedMessageIds = event.ctrlKey || event.metaKey
      ? new Set([...this.selectedMessageIds, message.message_id])
      : new Set([message.message_id]);
    this.messageSelectionAnchorId = message.message_id;
  }

  openMessageContextMenu(message: Message, event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.prepareMessageContextSelection(message, event);
    this.hooks.closeCreateChannelMenu();
    this.hooks.closeChannelContextMenu();
    this.hooks.closeVoiceParticipantContextMenu();
    this.hooks.closeServerMenu();
    this.hooks.closeVoiceNetworkDetails();
    const selected = this.messages.filter((item) => this.selectedMessageIds.has(item.message_id));
    const multiple = selected.length > 1;
    const menuWidth = 190;
    const menuHeight =
      12 +
      (multiple ? 34 : 0) +
      (selected.some((item) => this.canCopyMessage(item)) ? 38 : 0) +
      (!multiple && !this.isLocalMessage(message) && !message.deleted_at_ms ? 38 : 0) +
      (!multiple && this.canEditMessage(message) ? 38 : 0) +
      (selected.some((item) => this.canDeleteMessage(item)) ? 38 : 0);
    this.messageContextMenu = {
      messageId: message.message_id,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8))
    };
  }

  closeMessageContextMenu(): void {
    this.messageContextMenu = null;
  }

  messageContextMenuStyle(menu: MessageContextMenu): string {
    return `left: ${menu.x}px; top: ${menu.y}px;`;
  }

  // ---- display helpers -------------------------------------------------------

  messageTime(createdAtMS: number): string {
    if (!createdAtMS) return "";
    const date = new Date(createdAtMS);
    const now = new Date();
    const sameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    return new Intl.DateTimeFormat(this.hooks.languagePackId(), {
      month: sameDay ? undefined : "2-digit",
      day: sameDay ? undefined : "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  }

  escapeHTML(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  formatMessageContent(content: string): string {
    const placeholders: string[] = [];
    const stash = (html: string) => {
      const token = `\u0000EV_PLACEHOLDER_${placeholders.length}\u0000`;
      placeholders.push(html);
      return token;
    };

    let html = this.escapeHTML(content);
    html = html.replace(/```[ \t]*([A-Za-z0-9_-]+)?[ \t]*\n?([\s\S]*?)```/g, (_match, language, code) => {
      const label = language ? `<span>${language}</span>` : "";
      return stash(`<pre class="message-code-block">${label}<code>${code.replace(/\n$/, "")}</code></pre>`);
    });
    html = html.replace(/`([^`\n]+)`/g, (_match, code) => stash(`<code>${code}</code>`));
    html = html.replace(
      /&lt;:ev:([A-Za-z0-9_]{1,32}):([a-fA-F0-9]{64}):([0-9]{1,10}):(png|gif|webp|jpg)&gt;/g,
      (_match, shortcode, sha256, sizeBytes, format) => {
        const reference = parseEmojiReferences(`<:ev:${shortcode}:${sha256}:${sizeBytes}:${format}>`)[0];
        return reference ? stash(this.formatMessageEmoji(reference)) : _match;
      }
    );
    html = html.replace(/&lt;:evb:([a-z0-9_]{1,12})&gt;/g, (_match, id) => {
      const emoji = getBuiltInGraphicEmoji(`<:evb:${id}>`);
      return emoji ? stash(this.formatMessageBuiltInEmoji(emoji)) : _match;
    });
    html = html.replace(
      /&lt;:file:([A-Za-z0-9_-]{1,160}):([0-9]{1,16}):([A-Za-z0-9_.!~*%()-]+):([A-Za-z0-9_.!~*%()-]+)&gt;/g,
      () => stash("")
    );
    html = html.replace(
      /&lt;:image:([a-fA-F0-9]{64}):([0-9]{1,12}):(png|gif|webp|jpg|avif):([A-Za-z0-9_.!~*%()-]+)&gt;/g,
      () => stash("")
    );
    html = this.linkifyMessageContent(html);
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
    html = html.replace(/(^|\s)@([A-Za-z0-9_\-\u4e00-\u9fff]+)/g, '$1<span class="mention">@$2</span>');
    html = html.replace(/\n/g, "<br />");
    for (const [index, value] of placeholders.entries()) {
      html = html.replaceAll(`\u0000EV_PLACEHOLDER_${index}\u0000`, value);
    }
    return html;
  }

  formatMessageEmoji(reference: EmojiReference): string {
    const token = this.escapeHTML(reference.token);
    const label = this.escapeHTML(`:${reference.shortcode}:`);
    const url = this.hooks.emojiObjectURL(reference.asset_sha256);
    if (url) {
      return `<button class="message-custom-emoji loaded" type="button" data-emoji-token="${token}" title="${label}"><img src="${this.escapeHTML(url)}" alt="${label}" /></button>`;
    }
    if (reference.size_bytes > 1024 * 1024) {
      return `<button class="message-custom-emoji pending large" type="button" data-emoji-token="${token}" title="${this.escapeHTML(this.hooks.translate("emoji.confirmToDownload"))}"><span class="material-symbols-rounded app-icon" aria-hidden="true">download</span><span>${label}</span></button>`;
    }
    return `<button class="message-custom-emoji pending" type="button" data-emoji-token="${token}" title="${this.escapeHTML(this.hooks.translate("emoji.loading"))}"><span class="material-symbols-rounded app-icon" aria-hidden="true">hourglass_empty</span><span>${label}</span></button>`;
  }

  formatMessageBuiltInEmoji(emoji: DefaultEmoji): string {
    if (!emoji.imageURL) return this.escapeHTML(emoji.value);
    const label = this.escapeHTML(emojiAlias(emoji.id));
    return `<span class="message-built-in-emoji" data-tooltip="${label}" aria-label="${label}"><img src="${this.escapeHTML(emoji.imageURL)}" alt="${label}" draggable="false" /></span>`;
  }

  linkifyMessageContent(html: string): string {
    return html.replace(/\bhttps?:\/\/[^\s<]+/g, (rawURL) => {
      const suffixMatch = rawURL.match(/[),.!?]+$/);
      const suffix = suffixMatch?.[0] ?? "";
      const url = suffix ? rawURL.slice(0, -suffix.length) : rawURL;
      if (!url) return rawURL;
      const href = url.replaceAll("&amp;", "&").replaceAll("&quot;", "%22");
      return `<a href="${href}" target="_blank" rel="noreferrer noopener">${url}</a>${suffix}`;
    });
  }

  // ---- context menu actions --------------------------------------------------

  selectedContextMessages(): Message[] {
    const selected = this.messageContextMenu
      ? this.messages.filter((message) => this.selectedMessageIds.has(message.message_id))
      : [];
    if (selected.length > 0) return selected;
    if (!this.messageContextMenu) return [];
    const message = this.messages.find((item) => item.message_id === this.messageContextMenu?.messageId);
    return message ? [message] : [];
  }

  copyContextMenuMessage = async (): Promise<void> => {
    const selected = this.selectedContextMessages().filter((message) => this.canCopyMessage(message));
    this.closeMessageContextMenu();
    if (selected.length === 0) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API is unavailable");
      const content = selected.length === 1
        ? selected[0].content
        : selected.map((message) => `${this.hooks.memberDisplayName(message.author_id)}: ${message.content}`).join("\n\n");
      await navigator.clipboard.writeText(content);
      this.hooks.setStatusKey("messages.copied");
    } catch {
      this.hooks.setError(this.hooks.translate("error.messageCopyFailed"));
    }
  };

  editContextMenuMessage = (): void => {
    const selected = this.selectedContextMessages();
    const message = selected.length === 1 ? selected[0] : undefined;
    this.closeMessageContextMenu();
    if (!message || !this.canEditMessage(message)) return;
    this.hooks.beginEditMessage(message);
  };

  deleteContextMenuMessage = async (): Promise<void> => {
    const selected = this.selectedContextMessages().filter((message) => this.canDeleteMessage(message));
    this.closeMessageContextMenu();
    if (selected.length === 0) return;
    if (selected.length === 1) {
      await this.hooks.deleteSelectedMessage(selected[0]);
      return;
    }
    if (!this.hooks.selectedChannelId() || !this.hooks.sessionToken() || this.messageActionBusyId) return;
    const confirmed = await this.hooks.showAppConfirm(this.hooks.translate("messages.deleteSelectedConfirm", { count: selected.length }), {
      title: this.hooks.translate("messages.deleteSelected", { count: selected.length }),
      confirmLabel: this.hooks.translate("messages.deleteSelectedAction"),
      danger: true
    });
    if (!confirmed) return;
    this.messageActionBusyId = "batch";
    this.hooks.setError("");
    let failed = 0;
    for (const message of selected) {
      try {
        this.removeMessage(
          await deleteMessage(this.hooks.baseUrl(), this.hooks.selectedChannelId(), this.hooks.sessionToken(), message.message_id)
        );
      } catch {
        failed += 1;
      }
    }
    this.messageActionBusyId = "";
    if (failed > 0) this.hooks.setError(this.hooks.translate("messages.deleteSelectedFailed", { count: failed }));
    else this.hooks.setStatusKey("messages.deletedSelected");
  };

  canEditMessage(message: Message): boolean {
    if (this.isLocalMessage(message) || message.deleted_at_ms) return false;
    return message.author_id === this.hooks.memberId();
  }

  canDeleteMessage(message: Message): boolean {
    if (this.isLocalMessage(message) || message.deleted_at_ms) return false;
    return message.author_id === this.hooks.memberId() || this.hooks.canManageMessages();
  }

  canCopyMessage(message: Message): boolean {
    return !message.deleted_at_ms && message.content.trim().length > 0;
  }
}
