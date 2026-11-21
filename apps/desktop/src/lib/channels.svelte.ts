// Channel registry, selection, CRUD, warnings, context menu, panel width,
// and display helpers.
//
// Owns the server-authoritative channel list plus the channel-editor dialog
// state. The workspace component keeps thin same-name wrappers so templates
// and other domains call unchanged names; every mutation goes through the
// methods below. Svelte 5 note: this file uses the .svelte.ts extension so
// \`$state\` runes work inside a plain class.

import { tick } from "svelte";
import {
  createChannel,
  deleteChannel as deleteRemoteChannel,
  getChannels,
  getMessages,
  reorderChannels,
  updateChannel
} from "./api";
import {
  applyChannelMove,
  buildChannelTree,
  categoryChannels as getCategoryChannels,
  channelDropPlacementForTarget,
  channelDropTargetForChannel,
  channelOrderItems,
  childChannels as getChildChannels,
  sameDropTarget,
  sortChannels,
  type ChannelDropPlacement,
  type ChannelDropTarget,
  type ChannelTree
} from "./channelList";
import { saveCollapsedCategoryIds } from "./storage";
import type {
  AccompanimentSession,
  Channel,
  ScreenShareSession,
  ServerRole,
  ServerSummary,
  StoredServer,
  VoiceState
} from "./types";
import type { VoiceConnectionContext } from "./voice-state.svelte";

export type ChannelContextMenuState = {
  channelId: string;
  x: number;
  y: number;
};

export type ChannelWarningState = {
  channelId: string;
  action: "chat" | "voice";
};

export type ChannelDragState = {
  sourceId: string;
  target: ChannelDropTarget | null;
  line: ChannelDropLine | null;
  completed: boolean;
};

export type ChannelDropLine = {
  top: number;
  left: number;
  width: number;
};

export type ChannelDropCandidate = {
  target: ChannelDropTarget;
  line: ChannelDropLine;
};

export type ChannelPointerPress = {
  channelId: string;
  x: number;
  y: number;
  pointerId: number;
  dragging: boolean;
};

/**
 * Cross-cutting dependencies injected by the workspace component. Every side
 * effect that belongs to another domain (messages, files, voice, permissions,
 * screen share, remote control) flows through these lazy arrow hooks so the
 * controller never imports the component.
 */
export type ChannelsHooks = {
  memberId: () => string;
  sessionToken: () => string;
  baseUrl: () => string;
  activeServerId: () => string;
  serverId: () => string;
  serverDefaultLanguage: () => string;
  translate: (key: string, params?: Record<string, string | number>) => string;
  setError: (message: string) => void;
  canManageChannels: () => boolean;
  canManageChannelPermissions: () => boolean;
  flushAliases: () => void;
  // Selection side effects (messages/files/unread live in later domains).
  closeMessageContextMenu: () => void;
  closeServerMenu: () => void;
  clearReplyTarget: () => void;
  clearMessageSearch: () => void;
  clearMessageSelection: () => void;
  clearFileView: () => void;
  setChannelContentMode: (mode: string) => void;
  setMessages: (messages: unknown[]) => void;
  setHasOlderMessages: (value: boolean) => void;
  setCurrentChannelNewMessageCount: (value: number) => void;
  setCurrentChannelNewMessageStartId: (value: string) => void;
  setEditingMessageId: (value: string) => void;
  setEditingMessageDraft: (value: string) => void;
  clearComposerAttachmentObjectURLs: () => void;
  clearMessageAttachmentObjectURLs: () => void;
  setComposerAttachments: (attachments: unknown[]) => void;
  clearChannelUnread: (channelId: string) => void;
  focusMemberAccessFilter: (channelId: string) => void;
  selectedChannelLoadingId: () => string;
  setSelectedChannelLoadingId: (value: string) => void;
  pendingLocalMessagesForChannel: (channelId: string) => Array<{ created_at_ms: number }>;
  prepareMessageEmojiAssets: (messages: unknown[]) => void;
  restoreChannelReadPosition: (channelId: string) => void;
  // Voice page + pointer guards.
  showVoiceChannelTip: (event?: MouseEvent | KeyboardEvent) => void;
  closeVoiceChannelTip: () => void;
  isJoinedVoiceChannel: (channelId: string) => boolean;
  suppressChannelClickUntil: () => number;
  setSuppressChannelClickUntil: (value: number) => void;
  channelDragActive: () => boolean;
  clearChannelPointerPress: () => void;
  voiceActionBusy: () => boolean;
  prepareVoiceAudioPlayback: () => void;
  toggleVoiceChannel: (channel: Channel) => void;
  closeVoiceParticipantContextMenu: () => void;
  // Connected-channel navigation.
  voiceConnectionNavigationBusy: () => boolean;
  setVoiceConnectionNavigationBusy: (value: boolean) => void;
  voiceConnectionContext: () => VoiceConnectionContext | null;
  savedServerByID: (serverId: string) => StoredServer | undefined;
  reconnectSavedServer: (savedServer: StoredServer) => Promise<void>;
  workspaceReconnectRequired: () => boolean;
  serverSummary: () => ServerSummary | null;
  // Voice domain.
  currentVoiceState: () => VoiceState | null;
  stopVoiceSession: (options?: { clearVoicePanel?: boolean }) => void;
  filterVoiceStates: (predicate: (state: VoiceState) => boolean) => void;
  // Settings dialog + permissions (permission state stays in the component).
  showAppConfirm: (message: string, options?: Record<string, unknown>) => Promise<boolean>;
  roles: () => ServerRole[];
  languageOptions: () => Array<{ id: string }>;
  languagePackId: () => string;
  setSelectedPermissionChannelId: (value: string) => void;
  setChannelPermissionOverrides: (overrides: unknown[]) => void;
  setChannelPermissionDraftOverrides: (overrides: unknown[]) => void;
  setChannelPermissionLoadedChannelId: (value: string) => void;
  setChannelPermissionTargetType: (value: string) => void;
  setChannelPermissionTargetId: (value: string) => void;
  setChannelPermissionTargets: (targets: unknown[]) => void;
  setChannelPermissionTargetPickerOpen: (open: boolean) => void;
  setChannelPermissionTargetMenuStyle: (style: string) => void;
  setChannelPermissionSearch: (value: string) => void;
  loadChannelPermissionOverrides: () => void;
  saveChannelPermissionChanges: () => Promise<void>;
  cloneChannelPermissionOverrides: (overrides: unknown[]) => unknown[];
  rebuildChannelPermissionTargets: () => void;
  channelPermissionLoadedChannelId: () => string;
  selectedPermissionChannelId: () => string;
  channelPermissionOverrides: () => unknown[];
  channelTopicTextareaElement: () => HTMLTextAreaElement | null;
  setSettingsSelectMenuOpen: (value: unknown) => void;
  // Visible-snapshot side effects.
  screenShareSessions: () => ScreenShareSession[];
  accompanimentSessions: () => AccompanimentSession[];
  removeScreenShareSession: (share: ScreenShareSession) => void;
  removeAccompanimentSession: (session: AccompanimentSession) => void;
  filterRemoteControlByChannelIds: (visibleChannelIds: Set<string>) => void;
  // Panel width/resize.
  memberPanelWidth: () => number;
  closeVoiceNetworkDetails: () => void;
  closeSoundboardPopover: () => void;
  adjustComposerHeight: () => void;
  soundboardPopoverOpen: () => boolean;
  updateSoundboardPopoverPosition: () => void;
  serverPreviewLanguageId: () => string;
  languagePack: () => { id: string };
};

const channelPanelWidthStorageKey = "ev.layout.channelPanelWidth";
const defaultChannelPanelWidth = 260;
const minChannelPanelWidth = 220;
const maxChannelPanelWidth = 420;
const serverRailWidth = 72;
const minContentPanelWidth = 420;

export class ChannelsController {
  // Registry + snapshot.
  channels = $state<Channel[]>([]);
  collapsedCategoryIds = $state<Set<string>>(new Set());
  selectedChannelId = $state("");
  // Channel editor dialog.
  channelDialogOpen = $state(false);
  channelSettingsOpen = $state(false);
  channelSettingsTab = $state<"overview" | "permissions">("overview");
  channelDraft = $state<Channel | null>(null);
  channelSettingsSaving = $state(false);
  channelSettingsDirty = $state(false);
  channelDetailsDirty = $state(false);
  channelPermissionsDirty = $state(false);
  channelLocalizationLanguage = $state("");
  channelEditingId = $state("");
  channelName = $state("");
  channelType = $state<Channel["type"]>("text");
  channelParentId = $state("");
  channelCreateMenuParentId = $state<string | null>(null);
  // Warnings.
  pendingChannelWarning = $state<ChannelWarningState | null>(null);
  // Context menu.
  channelContextMenu = $state<ChannelContextMenuState | null>(null);
  // Panel width.
  channelPanelWidth = $state(loadChannelPanelWidth());
  channelPanelResizing = $state(false);
  channelPanelResizeStartX = 0;
  channelPanelResizeStartWidth = 0;
  // Pointer/drag interaction state (previously shell-local).
  channelPointerPress = $state<ChannelPointerPress | null>(null);
  channelDrag = $state<ChannelDragState>({ sourceId: "", target: null, line: null, completed: false });
  channelDragExpandTimer: number | undefined;
  channelDragExpandCategoryId = "";

  private hooks: ChannelsHooks;

  constructor(hooks: ChannelsHooks) {
    this.hooks = hooks;
  }

  // ---- registry + snapshot ---------------------------------------------------

  mergeChannel(channel: Channel): void {
    if (!channel?.channel_id) return;
    const exists = this.channels.some((item) => item.channel_id === channel.channel_id);
    this.channels = sortChannels(exists
      ? this.channels.map((item) => (item.channel_id === channel.channel_id ? channel : item))
      : [...this.channels, channel]);
  }

  /** Replaces the whole registry without removal side effects (workspace load/reset). */
  replaceChannels(nextChannels: Channel[]): void {
    this.channels = sortChannels(nextChannels.filter((channel) => Boolean(channel?.channel_id)));
  }

  applyVisibleChannelSnapshot(nextChannels: Channel[]): void {
    const normalized = sortChannels(nextChannels.filter((channel) => Boolean(channel?.channel_id)));
    const visibleChannelIds = new Set(normalized.map((channel) => channel.channel_id));

    for (const previous of [...this.channels]) {
      if (!visibleChannelIds.has(previous.channel_id)) this.removeChannel(previous);
    }
    for (const share of [...this.hooks.screenShareSessions()]) {
      if (!visibleChannelIds.has(share.channel_id)) this.hooks.removeScreenShareSession(share);
    }
    for (const accompaniment of [...this.hooks.accompanimentSessions()]) {
      if (!visibleChannelIds.has(accompaniment.channel_id)) this.hooks.removeAccompanimentSession(accompaniment);
    }
    this.hooks.filterRemoteControlByChannelIds(visibleChannelIds);
    this.channels = normalized;
  }

  removeChannel(channel: Channel): void {
    if (!channel?.channel_id) return;
    if (channel.type === "category") {
      this.hooks.clearChannelUnread(channel.channel_id);
      this.channels = sortChannels(
        this.channels
          .filter((item) => item.channel_id !== channel.channel_id)
          .map((item) => (item.parent_id === channel.channel_id ? { ...item, parent_id: undefined } : item))
      );
      const nextCollapsed = new Set(this.collapsedCategoryIds);
      nextCollapsed.delete(channel.channel_id);
      this.setCollapsedCategoryIds(nextCollapsed);
      if (this.hooks.currentVoiceState()?.channel_id === channel.channel_id) {
        this.hooks.stopVoiceSession({ clearVoicePanel: true });
      }
      this.hooks.filterVoiceStates((state) => state.channel_id !== channel.channel_id);
      if (this.selectedChannelId === channel.channel_id) {
        this.hooks.clearComposerAttachmentObjectURLs();
        this.hooks.clearMessageAttachmentObjectURLs();
        this.selectedChannelId = "";
        this.hooks.setChannelContentMode("chat");
        this.hooks.focusMemberAccessFilter("");
        this.hooks.setMessages([]);
        this.hooks.clearFileView();
      }
      return;
    }

    const removedIds = new Set([channel.channel_id]);
    this.hooks.clearChannelUnread(channel.channel_id);
    this.channels = this.channels.filter((item) => !removedIds.has(item.channel_id));
    if (this.hooks.currentVoiceState()?.channel_id === channel.channel_id) {
      this.hooks.stopVoiceSession({ clearVoicePanel: true });
    }
    this.hooks.filterVoiceStates((state) => !removedIds.has(state.channel_id));
    if (removedIds.has(this.selectedChannelId)) {
      this.hooks.clearComposerAttachmentObjectURLs();
      this.hooks.clearMessageAttachmentObjectURLs();
      this.selectedChannelId = "";
      this.hooks.setChannelContentMode("chat");
      this.hooks.focusMemberAccessFilter("");
      this.hooks.setMessages([]);
      this.hooks.clearFileView();
    }
  }

  async persistChannelOrder(nextChannels: Channel[]): Promise<void> {
    const previousChannels = this.channels;
    this.channels = nextChannels;
    try {
      this.channels = sortChannels(await reorderChannels(
        this.hooks.baseUrl(),
        this.hooks.sessionToken(),
        channelOrderItems(nextChannels)
      ));
    } catch (caught) {
      try {
        this.channels = sortChannels(await getChannels(this.hooks.baseUrl(), this.hooks.sessionToken()));
      } catch {
        this.channels = previousChannels;
      }
      throw caught;
    }
  }

  async applyChannelDropTarget(sourceId: string, target: ChannelDropTarget): Promise<void> {
    this.hooks.setError("");
    try {
      const nextChannels = applyChannelMove(this.channels, sourceId, target);
      if (!nextChannels) return;
      if (target.parentId) {
        this.expandCategory(target.parentId);
      }
      await this.persistChannelOrder(nextChannels);
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.channelUpdateFailed"));
    }
  }

  // ---- category collapse -------------------------------------------------------

  toggleCategoryCollapsed(categoryId: string): void {
    const next = new Set(this.collapsedCategoryIds);
    if (next.has(categoryId)) {
      next.delete(categoryId);
    } else {
      next.add(categoryId);
    }
    this.setCollapsedCategoryIds(next);
  }

  expandCategory(categoryId: string): void {
    if (!this.collapsedCategoryIds.has(categoryId)) return;
    const next = new Set(this.collapsedCategoryIds);
    next.delete(categoryId);
    this.setCollapsedCategoryIds(next);
  }

  setCollapsedCategoryIds(next: Set<string>): void {
    const sanitized = this.sanitizedCollapsedCategoryIds(next, this.channels);
    this.collapsedCategoryIds = sanitized;
    saveCollapsedCategoryIds(this.hooks.serverId() || this.hooks.activeServerId(), [...sanitized]);
  }

  sanitizedCollapsedCategoryIds(next: Set<string>, sourceChannels: Channel[]): Set<string> {
    const categoryIds = new Set(
      sourceChannels.filter((channel) => channel.type === "category").map((channel) => channel.channel_id)
    );
    return new Set([...next].filter((categoryId) => categoryIds.has(categoryId)));
  }

  // ---- selection ---------------------------------------------------------------

  async selectChannel(channelId: string, skipWarning = false): Promise<void> {
    const targetChannel = this.channels.find((channel) => channel.channel_id === channelId);
    if (!skipWarning && targetChannel && this.requestChannelWarning(targetChannel, "chat")) return;
    this.closeCreateChannelMenu();
    this.hooks.closeMessageContextMenu();
    this.hooks.closeServerMenu();
    this.hooks.clearReplyTarget();
    this.hooks.clearMessageSearch();
    this.hooks.clearMessageSelection();
    this.hooks.clearFileView();
    if (this.hooks.selectedChannelLoadingId() === channelId) return;
    this.selectedChannelId = channelId;
    this.hooks.setChannelContentMode("chat");
    this.hooks.focusMemberAccessFilter(channelId);
    this.hooks.setMessages([]);
    this.hooks.setHasOlderMessages(false);
    this.hooks.clearChannelUnread(channelId);
    this.hooks.setCurrentChannelNewMessageCount(0);
    this.hooks.setCurrentChannelNewMessageStartId("");
    this.hooks.setEditingMessageId("");
    this.hooks.setEditingMessageDraft("");
    this.hooks.clearComposerAttachmentObjectURLs();
    this.hooks.clearMessageAttachmentObjectURLs();
    this.hooks.setComposerAttachments([]);
    this.hooks.setError("");
    if (!this.hooks.sessionToken()) return;
    this.hooks.setSelectedChannelLoadingId(channelId);
    try {
      const loadedMessages = await getMessages(this.hooks.baseUrl(), channelId, this.hooks.sessionToken());
      if (this.selectedChannelId === channelId) {
        const mergedMessages = [
          ...loadedMessages,
          ...this.hooks.pendingLocalMessagesForChannel(channelId)
        ].sort((left, right) => left.created_at_ms - right.created_at_ms);
        this.hooks.setMessages(mergedMessages);
        this.hooks.prepareMessageEmojiAssets(mergedMessages);
        this.hooks.setHasOlderMessages(loadedMessages.length >= 50);
        this.hooks.restoreChannelReadPosition(channelId);
      }
    } catch (caught) {
      if (this.selectedChannelId === channelId) this.hooks.setMessages([]);
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.connectionFailed"));
    } finally {
      if (this.hooks.selectedChannelLoadingId() === channelId) {
        this.hooks.setSelectedChannelLoadingId("");
      }
    }
  }

  openVoiceChannelPage(channel: Channel, event?: MouseEvent | KeyboardEvent, skipWarning = false): void {
    if (!skipWarning && this.requestChannelWarning(channel, "voice")) return;
    if (this.hooks.channelDragActive() || Date.now() < this.hooks.suppressChannelClickUntil()) return;
    this.closeCreateChannelMenu();
    this.hooks.closeMessageContextMenu();
    this.hooks.closeServerMenu();
    this.hooks.clearReplyTarget();
    this.hooks.clearMessageSearch();
    this.hooks.clearMessageSelection();
    this.hooks.clearFileView();
    this.selectedChannelId = channel.channel_id;
    this.hooks.setMessages([]);
    this.hooks.setHasOlderMessages(false);
    this.hooks.setCurrentChannelNewMessageCount(0);
    this.hooks.setCurrentChannelNewMessageStartId("");
    this.hooks.setEditingMessageId("");
    this.hooks.setEditingMessageDraft("");
    this.hooks.clearComposerAttachmentObjectURLs();
    this.hooks.clearMessageAttachmentObjectURLs();
    this.hooks.setComposerAttachments([]);
    this.hooks.setChannelContentMode("voice");
    this.hooks.focusMemberAccessFilter(channel.channel_id);
    this.hooks.setError("");
    if (!this.hooks.isJoinedVoiceChannel(channel.channel_id)) {
      this.hooks.showVoiceChannelTip(event);
    } else {
      this.hooks.closeVoiceChannelTip();
    }
  }

  handleChannelClick(channel: Channel, event?: MouseEvent | KeyboardEvent): void {
    if (this.hooks.channelDragActive() || Date.now() < this.hooks.suppressChannelClickUntil()) return;
    if (this.isVoiceChannel(channel)) {
      this.openVoiceChannelPage(channel, event);
      return;
    }
    void this.selectChannel(channel.channel_id);
  }

  handleChannelDoubleClick(channel: Channel): void {
    if (this.hooks.channelDragActive() || Date.now() < this.hooks.suppressChannelClickUntil()) return;
    if (!this.isVoiceChannel(channel) || this.hooks.voiceActionBusy()) return;
    this.hooks.prepareVoiceAudioPlayback();
    this.hooks.closeVoiceChannelTip();
    this.hooks.toggleVoiceChannel(channel);
  }

  focusCategoryChannel(category: Channel): void {
    if (this.hooks.channelDragActive() || Date.now() < this.hooks.suppressChannelClickUntil()) return;
    this.closeCreateChannelMenu();
    this.hooks.closeMessageContextMenu();
    this.closeChannelContextMenu();
    this.hooks.closeServerMenu();
    this.hooks.clearReplyTarget();
    this.hooks.clearMessageSearch();
    this.hooks.clearMessageSelection();
    this.hooks.clearFileView();
    this.selectedChannelId = category.channel_id;
    this.hooks.setChannelContentMode("category");
    this.hooks.setMessages([]);
    this.hooks.setError("");
    this.hooks.focusMemberAccessFilter(category.channel_id);
  }

  async navigateToConnectedVoiceChannel(): Promise<void> {
    const context = this.hooks.voiceConnectionContext();
    if (!context || this.hooks.voiceConnectionNavigationBusy()) return;
    this.hooks.setVoiceConnectionNavigationBusy(true);
    this.hooks.setError("");
    try {
      if (
        this.hooks.activeServerId() !== context.serverId ||
        this.hooks.serverId() !== context.serverId ||
        !this.hooks.sessionToken()
      ) {
        const savedServer = this.hooks.savedServerByID(context.serverId);
        if (!savedServer) {
          this.hooks.setError(this.hooks.translate("voice.channelUnavailable"));
          return;
        }
        await this.hooks.reconnectSavedServer(savedServer);
      }
      if (
        this.hooks.activeServerId() !== context.serverId ||
        this.hooks.serverId() !== context.serverId ||
        this.hooks.workspaceReconnectRequired()
      ) return;
      const channel = this.channels.find((item) => item.channel_id === context.channelId);
      if (!channel || !this.isVoiceChannel(channel)) {
        this.hooks.setError(this.hooks.translate("voice.channelUnavailable"));
        return;
      }
      this.openVoiceChannelPage(channel, undefined, true);
    } finally {
      this.hooks.setVoiceConnectionNavigationBusy(false);
    }
  }

  // ---- CRUD + settings dialog ----------------------------------------------------

  openCreateChannel(type: Channel["type"], parentId = ""): void {
    if (!this.hooks.canManageChannels()) return;
    this.hooks.closeServerMenu();
    this.closeChannelContextMenu();
    this.channelCreateMenuParentId = null;
    if (parentId) {
      this.expandCategory(parentId);
    }
    this.channelEditingId = "";
    this.channelName = "";
    this.channelType = type;
    this.channelParentId = type === "category" ? "" : parentId;
    this.hooks.setError("");
    this.channelDialogOpen = true;
  }

  closeChannelDialog(): void {
    this.channelDialogOpen = false;
    this.channelEditingId = "";
    this.channelName = "";
    this.channelType = "text";
    this.channelParentId = "";
  }

  toggleCreateChannelMenu(parentId = ""): void {
    if (!this.hooks.canManageChannels()) return;
    this.hooks.closeServerMenu();
    this.closeChannelContextMenu();
    this.channelCreateMenuParentId = this.channelCreateMenuParentId === parentId ? null : parentId;
  }

  closeCreateChannelMenu(): void {
    this.channelCreateMenuParentId = null;
  }

  openEditChannel(channel: Channel): void {
    this.closeCreateChannelMenu();
    this.closeChannelContextMenu();
    this.hooks.closeServerMenu();
    this.channelEditingId = channel.channel_id;
    this.channelDraft = this.normalizeChannelDraft(channel);
    this.channelLocalizationLanguage = this.hooks.languageOptions().find(
      (option) => option.id !== this.effectiveChannelDefaultLanguage(channel)
    )?.id ?? this.hooks.languagePackId();
    this.channelSettingsTab = "overview";
    this.hooks.setSelectedPermissionChannelId(channel.channel_id);
    this.hooks.setChannelPermissionOverrides([]);
    this.hooks.setChannelPermissionDraftOverrides([]);
    this.hooks.setChannelPermissionLoadedChannelId("");
    this.hooks.setChannelPermissionTargetType("role");
    const everyoneRoleId = this.hooks.roles().find((role) => role.is_everyone)?.role_id
      ?? this.hooks.roles()[0]?.role_id ?? "";
    this.hooks.setChannelPermissionTargetId(everyoneRoleId);
    this.hooks.setChannelPermissionTargets(everyoneRoleId
      ? [{ targetType: "role", targetId: everyoneRoleId }]
      : []);
    this.hooks.setChannelPermissionTargetPickerOpen(false);
    this.hooks.setChannelPermissionTargetMenuStyle("");
    this.hooks.setChannelPermissionSearch("");
    this.hooks.setError("");
    this.channelSettingsOpen = true;
    this.hooks.loadChannelPermissionOverrides();
  }

  normalizeChannelDraft(channel: Channel): Channel {
    return {
      ...channel,
      parent_id: channel.parent_id ?? "",
      topic: channel.topic ?? "",
      visibility: channel.visibility ?? "default",
      warning_text: channel.warning_text ?? "",
      bitrate: channel.bitrate || 64000,
      user_limit: channel.user_limit || 0,
      permission_synced: Boolean(channel.permission_synced),
      default_language: channel.default_language ?? "",
      localizations: Object.fromEntries(
        Object.entries(channel.localizations ?? {}).map(([language, localization]) => [language, { ...localization }])
      )
    };
  }

  sameChannelSettings(left: Channel, right: Channel | undefined): boolean {
    if (!right) return false;
    const normalized = this.normalizeChannelDraft(right);
    return (
      left.name === normalized.name &&
      (left.parent_id ?? "") === (normalized.parent_id ?? "") &&
      (left.topic ?? "") === (normalized.topic ?? "") &&
      left.visibility === normalized.visibility &&
      (left.warning_text ?? "") === (normalized.warning_text ?? "") &&
      Number(left.bitrate) === Number(normalized.bitrate) &&
      Number(left.user_limit) === Number(normalized.user_limit) &&
      Boolean(left.permission_synced) === Boolean(normalized.permission_synced) &&
      (left.default_language ?? "") === (normalized.default_language ?? "") &&
      JSON.stringify(left.localizations ?? {}) === JSON.stringify(normalized.localizations ?? {})
    );
  }

  async closeChannelSettings(force = false): Promise<void> {
    if (!force && this.channelSettingsDirty &&
      !(await this.hooks.showAppConfirm(this.hooks.translate("channel.discardChangesConfirm"), { danger: true }))) return;
    this.channelSettingsOpen = false;
    this.channelDraft = null;
    this.channelEditingId = "";
    this.hooks.setChannelPermissionOverrides([]);
    this.hooks.setChannelPermissionDraftOverrides([]);
    this.hooks.setChannelPermissionLoadedChannelId("");
    this.hooks.setChannelPermissionTargets([]);
    this.hooks.setChannelPermissionTargetPickerOpen(false);
    this.hooks.setChannelPermissionTargetMenuStyle("");
    this.hooks.setError("");
  }

  resetChannelSettings(): void {
    if (!this.channelDraft) return;
    const channel = this.channels.find((item) => item.channel_id === this.channelDraft?.channel_id);
    if (channel) this.channelDraft = this.normalizeChannelDraft(channel);
    this.hooks.setChannelPermissionDraftOverrides(
      this.hooks.cloneChannelPermissionOverrides(this.hooks.channelPermissionOverrides())
    );
    this.hooks.rebuildChannelPermissionTargets();
    this.hooks.setChannelPermissionTargetPickerOpen(false);
    this.hooks.setChannelPermissionTargetMenuStyle("");
    this.hooks.setError("");
  }

  setChannelDraftVisibility(visibility: Channel["visibility"]): void {
    if (!this.channelDraft) return;
    this.channelDraft = { ...this.channelDraft, visibility };
  }

  setChannelUserLimit(value: number): void {
    if (!this.channelDraft) return;
    this.channelDraft = { ...this.channelDraft, user_limit: value };
  }

  setChannelDefaultLanguage(language: string): void {
    if (!this.channelDraft) return;
    this.channelDraft = { ...this.channelDraft, default_language: language };
    this.hooks.setSettingsSelectMenuOpen(null);
  }

  setDraftParentId(value: string): void {
    if (!this.channelDraft) return;
    this.channelDraft = { ...this.channelDraft, parent_id: value };
  }

  selectChannelLocalizationLanguage(language: string): void {
    this.channelLocalizationLanguage = language;
    this.hooks.setSettingsSelectMenuOpen(null);
  }

  setChannelLocalizationField(field: "name" | "topic" | "warning_text", value: string): void {
    if (!this.channelDraft || !this.channelLocalizationLanguage) return;
    const localizations = { ...(this.channelDraft.localizations ?? {}) };
    localizations[this.channelLocalizationLanguage] = {
      ...(localizations[this.channelLocalizationLanguage] ?? {}),
      [field]: value
    };
    this.channelDraft = { ...this.channelDraft, localizations };
  }

  async saveChannelSettings(): Promise<void> {
    if (!this.channelDraft || !this.hooks.sessionToken() || this.channelSettingsSaving || !this.channelSettingsDirty) return;
    const shouldSaveDetails = this.channelDetailsDirty;
    let shouldSavePermissions = this.channelPermissionsDirty;
    if ((shouldSaveDetails && !this.hooks.canManageChannels()) ||
        (shouldSavePermissions && !this.hooks.canManageChannelPermissions())) return;
    const name = this.channelDraft.name.trim();
    if (shouldSaveDetails && !name) return;
    if (shouldSaveDetails && this.channelDraft.visibility === "warning" && !this.channelDraft.warning_text.trim()) {
      this.hooks.setError(this.hooks.translate("channel.warningRequired"));
      return;
    }
    this.channelSettingsSaving = true;
    this.hooks.setError("");
    try {
      if (shouldSaveDetails) {
        const updated = await updateChannel(
          this.hooks.baseUrl(),
          this.hooks.sessionToken(),
          this.channelDraft.channel_id,
          {
            name,
            parent_id: this.channelDraft.type === "category" ? "" : this.channelDraft.parent_id ?? "",
            position: this.channelDraft.position,
            topic: this.channelDraft.type === "category" ? "" : (this.channelDraft.topic ?? "").trim(),
            visibility: this.channelDraft.type === "category" ? "default" : this.channelDraft.visibility,
            warning_text: this.channelDraft.type === "category" ? "" : (this.channelDraft.warning_text ?? "").trim(),
            bitrate: this.channelDraft.type === "voice" ? Number(this.channelDraft.bitrate) : 0,
            user_limit: this.channelDraft.type === "voice" ? Number(this.channelDraft.user_limit) : 0,
            permission_synced: Boolean(this.channelDraft.parent_id && this.channelDraft.permission_synced),
            default_language: this.channelDraft.default_language ?? "",
            localizations: this.channelDraft.localizations ?? {}
          }
        );
        this.mergeChannel(updated);
        this.channelDraft = this.normalizeChannelDraft(updated);
        if (updated.permission_synced) {
          shouldSavePermissions = false;
          this.hooks.setChannelPermissionOverrides([]);
          this.hooks.setChannelPermissionDraftOverrides([]);
          this.hooks.rebuildChannelPermissionTargets();
        }
        if (updated.parent_id) this.expandCategory(updated.parent_id);
      }
      if (shouldSavePermissions) {
        await this.hooks.saveChannelPermissionChanges();
      }
      if (this.channelDraft.permission_synced) {
        this.hooks.setChannelPermissionOverrides([]);
        this.hooks.setChannelPermissionDraftOverrides([]);
      }
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.channelUpdateFailed"));
    } finally {
      this.channelSettingsSaving = false;
    }
  }

  async selectChannelSettingsTab(tab: "overview" | "permissions"): Promise<void> {
    this.channelSettingsTab = tab;
    if (tab === "permissions" && this.hooks.channelPermissionLoadedChannelId() !== this.hooks.selectedPermissionChannelId()) {
      await this.hooks.loadChannelPermissionOverrides();
    }
  }

  async applyChannelTopicMarkup(prefix: string, suffix = prefix): Promise<void> {
    if (!this.channelDraft) return;
    const textarea = this.hooks.channelTopicTextareaElement();
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = this.channelDraft.topic ?? "";
    this.channelDraft = {
      ...this.channelDraft,
      topic: value.slice(0, start) + prefix + value.slice(start, end) + suffix + value.slice(end)
    };
    await tick();
    textarea.focus();
    textarea.setSelectionRange(start + prefix.length, end + prefix.length);
  }

  async submitChannel(): Promise<void> {
    const name = this.channelName.trim();
    if (!name || !this.hooks.sessionToken() || !this.hooks.canManageChannels()) return;
    this.hooks.setError("");
    try {
      const channel = await createChannel(this.hooks.baseUrl(), this.hooks.sessionToken(), {
        type: this.channelType,
        name,
        parent_id: this.channelType === "category" ? undefined : this.channelParentId || undefined
      });
      this.mergeChannel(channel);
      if (channel.parent_id) {
        this.expandCategory(channel.parent_id);
      }
      if (channel.type === "text") {
        await this.selectChannel(channel.channel_id);
      }
      this.closeChannelDialog();
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.channelCreateFailed"));
    }
  }

  async deleteChannel(channel: Channel): Promise<void> {
    if (!channel?.channel_id || !this.hooks.sessionToken() || !this.hooks.canManageChannels()) return;
    const confirmKey = channel.type === "category" ? "channel.deleteCategoryConfirm" : "channel.deleteConfirm";
    if (!(await this.hooks.showAppConfirm(this.hooks.translate(confirmKey), {
      title: this.hooks.translate("channel.delete"),
      confirmLabel: this.hooks.translate("channel.delete"),
      danger: true
    }))) return;
    this.hooks.setError("");
    try {
      const deleted = await deleteRemoteChannel(this.hooks.baseUrl(), this.hooks.sessionToken(), channel.channel_id);
      this.removeChannel(deleted);
      if (this.channelEditingId === channel.channel_id) {
        await this.closeChannelSettings(true);
      }
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.channelDeleteFailed"));
    }
  }

  async deleteContextMenuChannel(): Promise<void> {
    const channel = this.contextMenuChannel();
    this.closeChannelContextMenu();
    if (!channel) return;
    await this.deleteChannel(channel);
  }

  openContextMenuChannelEditor(): void {
    const channel = this.contextMenuChannel();
    if (!channel) {
      this.closeChannelContextMenu();
      return;
    }
    this.openEditChannel(channel);
  }

  contextMenuChannel(): Channel | undefined {
    return this.channelContextMenu
      ? this.channels.find((channel) => channel.channel_id === this.channelContextMenu?.channelId)
      : undefined;
  }

  channelContextMenuStyle(menu: ChannelContextMenuState): string {
    return "left: " + menu.x + "px; top: " + menu.y + "px;";
  }

  channelContextEditLabelKey(channel: Channel | undefined): string {
    return channel?.type === "category" ? "channel.editCategory" : "channel.edit";
  }

  channelTypeLabel(channel: Channel): string {
    if (channel.type === "category") return this.hooks.translate("channel.category");
    if (channel.type === "voice" || channel.type === "temporary_voice") return this.hooks.translate("channel.voice");
    return this.hooks.translate("channel.text");
  }

  channelContextDeleteLabelKey(channel: Channel | undefined): string {
    return channel?.type === "category" ? "channel.deleteCategory" : "channel.delete";
  }

  // ---- warnings ---------------------------------------------------------------

  requestChannelWarning(channel: Channel, action: "chat" | "voice"): boolean {
    if (channel.visibility !== "warning" || this.channelWarningAcknowledged(channel.channel_id)) return false;
    this.pendingChannelWarning = { channelId: channel.channel_id, action };
    return true;
  }

  channelWarningStorageKey(channelId: string): string {
    return "ev.channelWarning.v1." + (this.hooks.serverId() || this.hooks.activeServerId()) + "." + channelId;
  }

  channelWarningAcknowledged(channelId: string): boolean {
    return localStorage.getItem(this.channelWarningStorageKey(channelId)) === "accepted";
  }

  cancelChannelWarning(): void {
    this.pendingChannelWarning = null;
  }

  async acceptChannelWarning(): Promise<void> {
    const pending = this.pendingChannelWarning;
    this.pendingChannelWarning = null;
    if (!pending) return;
    localStorage.setItem(this.channelWarningStorageKey(pending.channelId), "accepted");
    const channel = this.channels.find((item) => item.channel_id === pending.channelId);
    if (!channel) return;
    if (pending.action === "voice") {
      this.openVoiceChannelPage(channel, undefined, true);
      return;
    }
    await this.selectChannel(channel.channel_id, true);
  }

  // ---- context menu ------------------------------------------------------------

  openChannelContextMenu(channel: Channel, event: MouseEvent): void {
    if (!this.hooks.canManageChannels() || this.hooks.channelDragActive()) return;
    event.preventDefault();
    event.stopPropagation();
    this.hooks.clearChannelPointerPress();
    this.closeCreateChannelMenu();
    this.hooks.closeMessageContextMenu();
    this.hooks.closeVoiceParticipantContextMenu();
    this.hooks.closeServerMenu();
    const menuWidth = 190;
    const menuHeight = 84;
    this.channelContextMenu = {
      channelId: channel.channel_id,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8))
    };
  }

  closeChannelContextMenu(): void {
    this.channelContextMenu = null;
  }

  // ---- panel width -----------------------------------------------------------

  setChannelPanelWidth(width: number): void {
    this.channelPanelWidth = this.clampChannelPanelWidth(width);
    this.persistChannelPanelWidth();
    if (this.hooks.soundboardPopoverOpen()) void tick().then(() => this.hooks.updateSoundboardPopoverPosition());
  }

  startChannelPanelResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.hooks.closeServerMenu();
    this.closeCreateChannelMenu();
    this.closeChannelContextMenu();
    this.hooks.closeVoiceNetworkDetails();
    this.hooks.closeSoundboardPopover();
    this.channelPanelResizing = true;
    this.channelPanelResizeStartX = event.clientX;
    this.channelPanelResizeStartWidth = this.channelPanelWidth;
    document.body.classList.add("channel-panel-resize-active");
    window.addEventListener("pointermove", this.resizeChannelPanel);
    window.addEventListener("pointerup", this.finishChannelPanelResize);
    window.addEventListener("pointercancel", this.finishChannelPanelResize);
  }

  resizeChannelPanel = (event: PointerEvent): void => {
    if (!this.channelPanelResizing) return;
    event.preventDefault();
    this.channelPanelWidth = this.clampChannelPanelWidth(
      this.channelPanelResizeStartWidth + event.clientX - this.channelPanelResizeStartX
    );
    this.hooks.adjustComposerHeight();
  };

  finishChannelPanelResize = (): void => {
    if (!this.channelPanelResizing) return;
    this.channelPanelResizing = false;
    this.channelPanelWidth = this.clampChannelPanelWidth(this.channelPanelWidth);
    this.persistChannelPanelWidth();
    this.hooks.adjustComposerHeight();
    document.body.classList.remove("channel-panel-resize-active");
    window.removeEventListener("pointermove", this.resizeChannelPanel);
    window.removeEventListener("pointerup", this.finishChannelPanelResize);
    window.removeEventListener("pointercancel", this.finishChannelPanelResize);
  };

  handleChannelPanelResizeKeydown(event: KeyboardEvent): void {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      this.setChannelPanelWidth(this.channelPanelWidth - 12);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      this.setChannelPanelWidth(this.channelPanelWidth + 12);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      this.setChannelPanelWidth(minChannelPanelWidth);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      this.setChannelPanelWidth(maxChannelPanelWidth);
    }
  }

  loadChannelPanelWidth(): number {
    return loadChannelPanelWidth();
  }

  maxAllowedChannelPanelWidth(): number {
    if (typeof window === "undefined") return maxChannelPanelWidth;
    const available = window.innerWidth - serverRailWidth - this.hooks.memberPanelWidth() - minContentPanelWidth;
    return Math.max(minChannelPanelWidth, Math.min(maxChannelPanelWidth, available));
  }

  clampChannelPanelWidth(width: number): number {
    return Math.round(Math.max(minChannelPanelWidth, Math.min(this.maxAllowedChannelPanelWidth(), width)));
  }

  persistChannelPanelWidth(): void {
    localStorage.setItem(channelPanelWidthStorageKey, String(this.channelPanelWidth));
  }

  // ---- display helpers ----------------------------------------------------------

  channelIcon(channel: Channel): string {
    if (channel.type === "category") return "folder";
    if (channel.type === "text") return "tag";
    if (this.isVoiceChannel(channel)) return "mic";
    return "radio_button_unchecked";
  }

  isVoiceChannel(channel: Channel): boolean {
    return channel.type === "voice" || channel.type === "temporary_voice";
  }

  voiceChannels(): Channel[] {
    return this.channels.filter((channel) => this.isVoiceChannel(channel));
  }

  channelDisplayName(channelId: string): string {
    const channel = this.channels.find((item) => item.channel_id === channelId);
    return channel ? this.channelNameForDisplay(channel) : channelId;
  }

  effectiveChannelDefaultLanguage(channel: Channel): string {
    return channel.default_language || this.hooks.serverDefaultLanguage() || "zh-CN";
  }

  channelLocalizationForDisplay(channel: Channel) {
    const language = this.hooks.serverPreviewLanguageId() || this.hooks.languagePack().id;
    if (language === this.effectiveChannelDefaultLanguage(channel)) return undefined;
    return channel.localizations?.[language];
  }

  channelNameForDisplay(channel: Channel): string {
    return this.channelLocalizationForDisplay(channel)?.name?.trim() || channel.name;
  }

  channelTopicForDisplay(channel: Channel): string {
    return this.channelLocalizationForDisplay(channel)?.topic?.trim() || channel.topic || "";
  }

  channelWarningForDisplay(channel: Channel): string {
    return this.channelLocalizationForDisplay(channel)?.warning_text?.trim() || channel.warning_text || "";
  }

  // ---- pointer / drag interaction (moved from the workspace shell) --------------

  private channelTreeValue(): ChannelTree {
    return buildChannelTree(this.channels);
  }

  private isChannelListInteractiveTarget(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(target.closest("button, a, input, select, textarea, .category-actions"));
  }

  handleChannelRowPointerDown(channel: Channel, event: PointerEvent): void {
    if (event.button !== 0 || this.isChannelListInteractiveTarget(event.target)) {
      this.channelPointerPress = null;
      return;
    }
    this.channelPointerPress = {
      channelId: channel.channel_id,
      x: event.clientX,
      y: event.clientY,
      pointerId: event.pointerId,
      dragging: false
    };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    this.hooks.flushAliases();
  }

  handleChannelRowPointerMove(channel: Channel, event: PointerEvent): void {
    const press = this.channelPointerPress;
    if (!press || press.channelId !== channel.channel_id || press.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    if (!press.dragging && distance > 6 && this.hooks.canManageChannels()) {
      this.channelPointerPress = { ...press, dragging: true };
      this.beginPointerChannelDrag(channel);
    }
    if (!this.channelPointerPress?.dragging) return;
    event.preventDefault();
    const candidate = this.channelDropCandidateFromPoint(event.clientX, event.clientY);
    this.setChannelDropCandidate(candidate);
    this.updateCategoryDragExpandFromCandidate(candidate);
    this.hooks.flushAliases();
  }

  async handleChannelRowPointerUp(channel: Channel, event: PointerEvent): Promise<void> {
    const press = this.channelPointerPress;
    this.channelPointerPress = null;
    this.hooks.flushAliases();
    if (!press || press.channelId !== channel.channel_id || press.pointerId !== event.pointerId) return;
    if (press.dragging) {
      event.preventDefault();
      await this.finishChannelDropAtCurrentIndicator();
    }
  }

  handleChannelRowPointerCancel(channel: Channel, event: PointerEvent): void {
    const press = this.channelPointerPress;
    if (!press || press.channelId !== channel.channel_id || press.pointerId !== event.pointerId) return;
    this.channelPointerPress = null;
    this.hooks.flushAliases();
    if (press.dragging) this.endChannelDrag();
  }

  handleCategoryHeadingKeydown(category: Channel, event: KeyboardEvent): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (this.isChannelListInteractiveTarget(event.target)) return;
    event.preventDefault();
    if (this.channelDrag.sourceId || Date.now() < this.hooks.suppressChannelClickUntil()) return;
    this.closeCreateChannelMenu();
    this.closeChannelContextMenu();
    this.focusCategoryChannel(category);
  }

  beginPointerChannelDrag(channel: Channel): void {
    if (!this.hooks.canManageChannels() || this.channelDrag.sourceId) return;
    this.hooks.setError("");
    this.clearChannelDragArtifacts();
    document.body.classList.add("channel-drag-active");
    this.channelDrag = { sourceId: channel.channel_id, target: null, line: null, completed: false };
    this.hooks.flushAliases();
  }

  endChannelDrag(): void {
    if (this.channelDrag.sourceId) {
      this.hooks.setSuppressChannelClickUntil(Date.now() + 220);
    }
    this.clearChannelDragState();
  }

  clearChannelDragState(): void {
    this.channelDrag = { sourceId: "", target: null, line: null, completed: false };
    this.clearCategoryDragExpandTimer();
    this.clearChannelDragArtifacts();
    window.requestAnimationFrame(this.clearChannelDragArtifacts.bind(this));
    window.setTimeout(this.clearChannelDragArtifacts.bind(this), 80);
    this.hooks.flushAliases();
  }

  clearChannelDragArtifacts(): void {
    if (this.channelDrag.sourceId) return;
    document.body.classList.remove("channel-drag-active");
  }

  isChannelDragging(channelId: string): boolean {
    return !this.channelDrag.completed && this.channelDrag.sourceId === channelId;
  }

  channelDropLineStyle(line: ChannelDropLine): string {
    return `top: ${line.top}px; left: ${line.left}px; width: ${line.width}px;`;
  }

  setChannelDropCandidate(candidate: ChannelDropCandidate | null): void {
    if (!this.channelDrag.sourceId || this.channelDrag.completed) return;
    if (!candidate && this.channelDrag.target && this.channelDrag.line) return;
    if (sameDropTarget(this.channelDrag.target, candidate?.target ?? null)) {
      const line = candidate?.line ?? null;
      if (
        this.channelDrag.line?.top === line?.top &&
        this.channelDrag.line?.left === line?.left &&
        this.channelDrag.line?.width === line?.width
      ) return;
    }
    this.channelDrag = { ...this.channelDrag, target: candidate?.target ?? null, line: candidate?.line ?? null };
  }

  channelDropCandidateFromPoint(clientX: number, clientY: number): ChannelDropCandidate | null {
    if (!this.channelDrag.sourceId || this.channelDrag.completed) return null;
    const element = document.elementFromPoint(clientX, clientY);
    const target = element?.closest<HTMLElement>("[data-channel-drop-target='true']");
    if (target?.dataset.channelId && target.dataset.channelId !== this.channelDrag.sourceId) {
      const targetChannel = this.channels.find((channel) => channel.channel_id === target.dataset.channelId);
      if (targetChannel) {
        const candidate = this.channelDropCandidateForElement(target, targetChannel, clientY);
        if (candidate) return candidate;
      }
    }
    const list = element?.closest<HTMLElement>(".channel-list");
    return list ? this.channelDropCandidateFromList(list, clientY) : null;
  }

  channelDropCandidateForElement(
    target: HTMLElement,
    targetChannel: Channel,
    clientY: number,
    forcedPlacement?: ChannelDropPlacement
  ): ChannelDropCandidate | null {
    const tree = this.channelTreeValue();
    const source = tree.byId.get(this.channelDrag.sourceId);
    if (!source) return null;
    const rect = target.getBoundingClientRect();
    const placement = forcedPlacement ?? channelDropPlacementForTarget(source, targetChannel, rect, clientY);
    const dropTarget = channelDropTargetForChannel(tree, source.channel_id, targetChannel.channel_id, placement);
    if (!dropTarget) return null;
    const line = this.channelDropLineForTarget(dropTarget, target);
    if (!line) return null;
    return { target: dropTarget, line };
  }

  updateCategoryDragExpandFromCandidate(candidate: ChannelDropCandidate | null): void {
    if (!candidate?.target.parentId) {
      this.clearCategoryDragExpandTimer();
      return;
    }
    this.scheduleCategoryDragExpand(candidate.target.parentId);
  }

  scheduleCategoryDragExpand(categoryId: string): void {
    if (!this.collapsedCategoryIds.has(categoryId)) {
      this.clearCategoryDragExpandTimer();
      return;
    }
    if (this.channelDragExpandCategoryId === categoryId && this.channelDragExpandTimer) return;
    this.clearCategoryDragExpandTimer();
    this.channelDragExpandCategoryId = categoryId;
    this.channelDragExpandTimer = window.setTimeout(() => {
      this.expandCategory(categoryId);
      this.clearCategoryDragExpandTimer();
    }, 650);
  }

  clearCategoryDragExpandTimer(): void {
    if (this.channelDragExpandTimer) window.clearTimeout(this.channelDragExpandTimer);
    this.channelDragExpandTimer = undefined;
    this.channelDragExpandCategoryId = "";
  }

  channelDropLineForTarget(dropTarget: ChannelDropTarget, fallbackElement: HTMLElement): ChannelDropLine | null {
    const tree = this.channelTreeValue();
    const source = tree.byId.get(this.channelDrag.sourceId);
    if (!source) return null;
    const sourceParentId =
      source.type === "category"
        ? ""
        : source.parent_id && tree.categoryIds.has(source.parent_id)
          ? source.parent_id
          : "";
    const sourceSiblings = sourceParentId ? getChildChannels(tree, sourceParentId) : tree.topLevel;
    const sourceIndex = sourceSiblings.findIndex((channel) => channel.channel_id === source.channel_id);
    const sourceElement = this.channelDropElementForChannel(source.channel_id);
    const sourceRect = sourceElement?.getBoundingClientRect();
    if (sourceParentId === dropTarget.parentId && sourceIndex === dropTarget.index && sourceRect) {
      const nested = dropTarget.parentId !== "";
      const leftOffset = nested ? 18 : 8;
      return {
        top: sourceRect.top,
        left: sourceRect.left + leftOffset,
        width: Math.max(24, sourceRect.width - leftOffset - 8)
      };
    }
    const siblings = (dropTarget.parentId ? getChildChannels(tree, dropTarget.parentId) : tree.topLevel)
      .filter((channel) => channel.channel_id !== source.channel_id);
    const index = Math.max(0, Math.min(dropTarget.index, siblings.length));
    const beforeElement = index > 0 ? this.channelDropElementForChannel(siblings[index - 1].channel_id) : null;
    const afterElement = index < siblings.length ? this.channelDropElementForChannel(siblings[index].channel_id) : null;
    const beforeRect = beforeElement?.getBoundingClientRect();
    const afterRect = afterElement?.getBoundingClientRect();
    const fallbackRect = fallbackElement.getBoundingClientRect();
    const lineRect = afterRect ?? beforeRect ?? fallbackRect;
    const nested = dropTarget.parentId !== "";
    const leftOffset = nested ? 18 : 8;
    let top = fallbackRect.bottom;
    if (beforeRect && afterRect) {
      top = beforeRect.bottom + (afterRect.top - beforeRect.bottom) / 2;
    } else if (afterRect) {
      top = afterRect.top;
    } else if (beforeRect) {
      top = beforeRect.bottom;
    }
    return {
      top,
      left: lineRect.left + leftOffset,
      width: Math.max(24, lineRect.width - leftOffset - 8)
    };
  }

  channelDropElementForChannel(channelId: string): HTMLElement | null {
    return Array.from(document.querySelectorAll<HTMLElement>("[data-channel-drop-target='true']")).find(
      (element) => element.dataset.channelId === channelId
    ) ?? null;
  }

  channelDropCandidateFromList(list: HTMLElement, clientY: number): ChannelDropCandidate | null {
    const tree = this.channelTreeValue();
    const source = tree.byId.get(this.channelDrag.sourceId);
    if (!source) return null;
    const targets = Array.from(
      list.querySelectorAll<HTMLElement>("[data-channel-drop-target='true']")
    )
      .map((target) => ({
        element: target,
        channel: target.dataset.channelId ? tree.byId.get(target.dataset.channelId) : undefined
      }))
      .filter((target): target is { element: HTMLElement; channel: Channel } => {
        if (!target.channel || target.channel.channel_id === source.channel_id) return false;
        return true;
      });
    if (targets.length === 0) return null;
    let lastValidTarget: { element: HTMLElement; channel: Channel } | null = null;
    for (const target of targets) {
      const candidate = this.channelDropCandidateForElement(target.element, target.channel, clientY);
      if (!candidate) continue;
      lastValidTarget = target;
      const rect = target.element.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return candidate;
    }
    return lastValidTarget
      ? this.channelDropCandidateForElement(lastValidTarget.element, lastValidTarget.channel, clientY, "after")
      : null;
  }

  async finishChannelDropAtCurrentIndicator(): Promise<void> {
    if (!this.channelDrag.sourceId) return;
    if (this.channelDrag.completed) {
      this.clearChannelDragState();
      return;
    }
    const sourceId = this.channelDrag.sourceId;
    const target = this.channelDrag.target;
    this.hooks.setSuppressChannelClickUntil(Date.now() + 220);
    this.clearChannelDragState();
    if (!target) return;
    await this.applyChannelDropTarget(sourceId, target);
  }
}

function loadChannelPanelWidth(): number {
  const parsed = Number(localStorage.getItem(channelPanelWidthStorageKey));
  const width = Number.isFinite(parsed) ? parsed : defaultChannelPanelWidth;
  return Math.round(Math.max(minChannelPanelWidth, Math.min(maxChannelPanelWidth, width)));
}
