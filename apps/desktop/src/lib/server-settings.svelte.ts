// Server settings, server profile, invites, and audit log.
//
// Owns the server settings dialog (draft editing, feature flags, icon crop),
// the per-server profile dialog, the invite management dialog, and the audit
// log browser. The server rail navigation and the emoji/soundboard management
// editors stay in the workspace component and are reached through hooks.
//
// Hot-path discipline: event handlers read this state directly; the
// component's legacy `$` aliases (kept fresh by the realtimeSyncTick bump)
// feed templates only.

import {
  createServerInvite,
  deleteServerInvite,
  getAuditLogs,
  getServerInvites,
  updateServer,
  updateServerProfile
} from "./api";
import { normalizeAvatarColor } from "./avatar";
import { effectiveProfileForServer, profileOverrides } from "./profile-sync";
import { loadLocalUserProfile } from "./storage";
import type {
  AuditLog,
  LocalUserProfile,
  Member,
  ProfileOverrides,
  ServerInvite,
  ServerSummary
} from "./types";

/** Toggleable server feature flags in the settings dialog. */
export type ServerFeatureKey =
  | "screen_share_enabled"
  | "remote_control_enabled"
  | "accompaniment_enabled"
  | "soundboard_enabled"
  | "emoji_enabled"
  | "file_storage_enabled"
  | "dm_relay_enabled"
  | "home_mailbox_enabled";

/** Feature rows rendered by the server details and server settings dialogs. */
export const serverFeatures: Array<{ key: ServerFeatureKey; labelKey: string; descriptionKey: string; icon: string }> = [
  { key: "screen_share_enabled", labelKey: "feature.screenShare", descriptionKey: "featureDescription.screenShare", icon: "screen_share" },
  { key: "remote_control_enabled", labelKey: "feature.remoteControl", descriptionKey: "featureDescription.remoteControl", icon: "touch_app" },
  { key: "accompaniment_enabled", labelKey: "feature.accompaniment", descriptionKey: "featureDescription.accompaniment", icon: "library_music" },
  { key: "soundboard_enabled", labelKey: "feature.soundboard", descriptionKey: "featureDescription.soundboard", icon: "graphic_eq" },
  { key: "emoji_enabled", labelKey: "feature.emoji", descriptionKey: "featureDescription.emoji", icon: "add_reaction" },
  { key: "file_storage_enabled", labelKey: "feature.fileStorage", descriptionKey: "featureDescription.fileStorage", icon: "folder_shared" },
  { key: "dm_relay_enabled", labelKey: "feature.dmRelay", descriptionKey: "featureDescription.dmRelay", icon: "forum" },
  { key: "home_mailbox_enabled", labelKey: "feature.homeMailbox", descriptionKey: "featureDescription.homeMailbox", icon: "forward_to_inbox" }
];

export type ServerSettingsHooks = {
  sessionToken: () => string;
  baseUrl: () => string;
  translate: (key: string, params?: Record<string, unknown>) => string;
  setError: (message: string) => void;
  setStatusKey: (key: string) => void;
  canEditServerSettings: () => boolean;
  canCreateInvites: () => boolean;
  server: () => ServerSummary | null;
  setServer: (server: ServerSummary | null) => void;
  currentMember: () => Member | undefined;
  mergeMember: (member: Member) => void;
  localUserProfile: () => LocalUserProfile;
  setLocalUserProfile: (profile: LocalUserProfile) => void;
  appSettingsOpen: () => boolean;
  setAppSettingsOpen: (open: boolean) => void;
  stopMicrophoneTest: () => void;
  closeServerMenu: () => void;
  closeVoiceParticipantContextMenu: () => void;
  openServerDetails: () => void;
  setServerDetailsOpen: (open: boolean) => void;
  ensureSelectedRole: () => void;
  loadServerEmojiManagement: () => void;
  loadServerSoundboardManagement: () => void;
  clearServerEmojiUpload: () => void;
  cancelServerEmojiEdit: () => void;
  closeSoundboardEditor: () => void;
  setEmojiManagementError: (message: string) => void;
  memberDisplayName: (memberId: string) => string;
  refreshMemberMergeRequests: (promptIncoming: boolean) => void;
  memberMergeCodeServerID: () => string;
  setMemberMergeCode: (value: string) => void;
  setMemberMergeCodeExpiresAtMS: (value: number) => void;
  setMemberMergeCodeServerID: (value: string) => void;
  syncSavedServerSummary: (server: ServerSummary) => Promise<void>;
  showAppAlert: (message: string, options?: Record<string, unknown>) => Promise<void>;
  closeSettingsSelectMenu: () => void;
};

export class ServerSettingsController {
  // ---- settings dialog --------------------------------------------------------
  serverSettingsOpen = $state(false);
  serverSettingsTab = $state<"overview" | "emoji" | "soundboard" | "roles" | "members" | "audit">("overview");
  serverDraft = $state<ServerSummary | null>(null);
  serverPreviewLanguageId = $state("");
  serverIconCropSource = $state("");
  // ---- server profile ---------------------------------------------------------
  serverProfileSettingsOpen = $state(false);
  serverProfileDraft = $state<LocalUserProfile>({} as LocalUserProfile);
  serverProfileBaseline = $state<LocalUserProfile>({} as LocalUserProfile);
  serverProfileOverridesDraft = $state<ProfileOverrides>({ display_name: false, avatar: false, bio: false });
  serverProfileOverridesBaseline = $state<ProfileOverrides>({ display_name: false, avatar: false, bio: false });
  serverProfileSaving = $state(false);
  serverProfileSaveMessage = $state("");
  serverProfileAvatarCropSource = $state("");
  // ---- invites ----------------------------------------------------------------
  inviteDialogOpen = $state(false);
  serverInvites = $state<ServerInvite[]>([]);
  inviteExpiresInSeconds = $state(24 * 60 * 60);
  inviteMaxUses = $state(1);
  inviteActionBusy = $state(false);
  generatedInviteLink = $state("");
  copiedInviteId = $state("");
  private copiedInviteTimer: number | undefined;
  // ---- audit ------------------------------------------------------------------
  auditLogs = $state<AuditLog[]>([]);
  auditLogsLoading = $state(false);
  auditActionFilter = $state("");

  constructor(private hooks: ServerSettingsHooks) {}

  // ---- settings dialog --------------------------------------------------------

  openServerSettings(tab: typeof this.serverSettingsTab = "overview"): void {
    if (!this.hooks.canEditServerSettings()) {
      this.hooks.openServerDetails();
      return;
    }
    this.hooks.closeServerMenu();
    this.hooks.closeVoiceParticipantContextMenu();
    if (this.hooks.appSettingsOpen()) this.hooks.stopMicrophoneTest();
    this.hooks.setAppSettingsOpen(false);
    this.serverProfileSettingsOpen = false;
    const server = this.hooks.server();
    if (server) {
      this.serverDraft = { ...server };
    }
    this.hooks.ensureSelectedRole();
    this.serverSettingsTab = tab;
    this.serverSettingsOpen = true;
    this.hooks.setError("");
    if (tab === "audit") {
      void this.loadAuditLogs();
    } else if (tab === "emoji") {
      this.hooks.loadServerEmojiManagement();
    } else if (tab === "soundboard") {
      this.hooks.loadServerSoundboardManagement();
    }
  }

  closeServerSettings(): void {
    this.serverSettingsOpen = false;
    const server = this.hooks.server();
    this.serverDraft = server ? { ...server } : null;
    this.hooks.clearServerEmojiUpload();
    this.hooks.cancelServerEmojiEdit();
    this.hooks.closeSoundboardEditor();
    this.hooks.setEmojiManagementError("");
    this.hooks.setError("");
  }

  selectServerSettingsTab(tab: typeof this.serverSettingsTab): void {
    this.serverSettingsTab = tab;
    this.hooks.setError("");
    if (tab === "audit") {
      void this.loadAuditLogs();
    } else if (tab === "emoji") {
      this.hooks.loadServerEmojiManagement();
    } else if (tab === "soundboard") {
      this.hooks.loadServerSoundboardManagement();
    }
  }

  setServerFeature(key: ServerFeatureKey, event: Event): void {
    if (!this.serverDraft) return;
    const input = event.currentTarget as HTMLInputElement;
    this.serverDraft = { ...this.serverDraft, [key]: input.checked };
  }

  setServerEmojiMaxKB(value: number): void {
    if (!this.serverDraft) return;
    this.serverDraft = {
      ...this.serverDraft,
      emoji_max_kb: Math.min(8192, Math.max(1, Number.isFinite(value) ? value : 1024))
    };
  }

  setServerName(event: Event): void {
    if (!this.serverDraft) return;
    const input = event.currentTarget as HTMLInputElement;
    this.serverDraft = { ...this.serverDraft, name: input.value };
  }

  setServerDescription(event: Event): void {
    if (!this.serverDraft) return;
    const input = event.currentTarget as HTMLTextAreaElement;
    this.serverDraft = { ...this.serverDraft, description: input.value };
  }

  setServerVisibility(visibility: ServerSummary["visibility"]): void {
    if (!this.serverDraft) return;
    this.serverDraft = { ...this.serverDraft, visibility };
  }

  setServerDefaultLanguage(language: string): void {
    if (!this.serverDraft) return;
    this.serverDraft = { ...this.serverDraft, default_language: language };
    this.hooks.closeSettingsSelectMenu();
  }

  setServerPreviewLanguage(language: string): void {
    this.serverPreviewLanguageId = language;
    this.hooks.closeSettingsSelectMenu();
  }

  async selectServerIcon(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !this.serverDraft) return;
    if (!file.type.startsWith("image/") || file.size > 8 * 1024 * 1024) {
      this.hooks.setError(this.hooks.translate("settings.serverIconInvalid"));
      return;
    }
    this.releaseImageCropSource(this.serverIconCropSource);
    this.serverIconCropSource = URL.createObjectURL(file);
    this.hooks.setError("");
  }

  cancelServerIconCrop(): void {
    this.releaseImageCropSource(this.serverIconCropSource);
    this.serverIconCropSource = "";
  }

  applyServerIconCrop(dataURL: string): void {
    if (!this.serverDraft) return;
    this.serverDraft = { ...this.serverDraft, icon_data_url: dataURL };
    this.cancelServerIconCrop();
    this.hooks.setError("");
  }

  releaseImageCropSource(source: string): void {
    if (source.startsWith("blob:")) URL.revokeObjectURL(source);
  }

  clearServerIcon(): void {
    if (!this.serverDraft) return;
    this.serverDraft = { ...this.serverDraft, icon_data_url: "" };
  }

  sameServerSettings(left: ServerSummary, right: ServerSummary): boolean {
    return (
      left.name === right.name &&
      (left.icon_data_url ?? "") === (right.icon_data_url ?? "") &&
      (left.description ?? "") === (right.description ?? "") &&
      Boolean(left.screen_share_enabled) === Boolean(right.screen_share_enabled) &&
      Boolean(left.remote_control_enabled) === Boolean(right.remote_control_enabled) &&
      Boolean(left.accompaniment_enabled) === Boolean(right.accompaniment_enabled) &&
      Boolean(left.soundboard_enabled) === Boolean(right.soundboard_enabled) &&
      Boolean(left.emoji_enabled) === Boolean(right.emoji_enabled) &&
      Number(left.emoji_max_kb || 1024) === Number(right.emoji_max_kb || 1024) &&
      Boolean(left.file_storage_enabled) === Boolean(right.file_storage_enabled) &&
      Boolean(left.dm_relay_enabled) === Boolean(right.dm_relay_enabled) &&
      Boolean(left.home_mailbox_enabled) === Boolean(right.home_mailbox_enabled) &&
      left.visibility === right.visibility &&
      left.default_language === right.default_language
    );
  }

  async submitServerSettings(): Promise<void> {
    if (!this.serverDraft || !this.hooks.sessionToken() || !this.hooks.canEditServerSettings()) return;
    const name = this.serverDraft.name.trim();
    if (!name) return;
    this.hooks.setError("");
    try {
      const updated = await updateServer(this.hooks.baseUrl(), this.hooks.sessionToken(), { ...this.serverDraft, name });
      this.hooks.setServer(updated);
      this.serverDraft = { ...updated };
      this.hooks.setStatusKey("settings.saved");
      await this.hooks.syncSavedServerSummary(updated);
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.serverUpdateFailed"));
    }
  }

  // ---- server profile ---------------------------------------------------------

  sameProfileSettings(left: LocalUserProfile, right: LocalUserProfile): boolean {
    return (
      left.display_name === right.display_name &&
      (left.avatar_data_url ?? "") === (right.avatar_data_url ?? "") &&
      (left.avatar_sha256 ?? "") === (right.avatar_sha256 ?? "") &&
      normalizeAvatarColor(left.avatar_color, left.local_profile_id) === normalizeAvatarColor(right.avatar_color, right.local_profile_id) &&
      left.bio === right.bio
    );
  }

  sameProfileOverrides(left: ProfileOverrides, right: ProfileOverrides): boolean {
    return (
      left.display_name === right.display_name &&
      left.avatar === right.avatar &&
      left.bio === right.bio
    );
  }

  openServerProfileSettings(): void {
    const server = this.hooks.server();
    const currentMember = this.hooks.currentMember();
    if (!server || !currentMember || !this.hooks.sessionToken()) return;
    this.hooks.closeServerMenu();
    this.hooks.closeVoiceParticipantContextMenu();
    if (this.hooks.appSettingsOpen()) this.hooks.stopMicrophoneTest();
    this.hooks.setAppSettingsOpen(false);
    this.serverSettingsOpen = false;
    this.hooks.setServerDetailsOpen(false);
    const localProfile = loadLocalUserProfile(this.hooks.baseUrl());
    this.hooks.setLocalUserProfile(localProfile);
    const effective = effectiveProfileForServer(localProfile, currentMember);
    const overrides = profileOverrides(currentMember);
    this.serverProfileDraft = { ...effective };
    this.serverProfileBaseline = { ...effective };
    this.serverProfileOverridesDraft = { ...overrides };
    this.serverProfileOverridesBaseline = { ...overrides };
    this.serverProfileSaveMessage = "";
    if (this.hooks.memberMergeCodeServerID() !== server.server_id) {
      this.hooks.setMemberMergeCode("");
      this.hooks.setMemberMergeCodeExpiresAtMS(0);
      this.hooks.setMemberMergeCodeServerID("");
    }
    this.serverProfileSettingsOpen = true;
    this.hooks.setError("");
    this.hooks.refreshMemberMergeRequests(true);
  }

  closeServerProfileSettings(): void {
    this.closeServerProfileAvatarCrop();
    this.serverProfileSettingsOpen = false;
    this.serverProfileSaveMessage = "";
    this.hooks.setError("");
  }

  resetServerProfileSettings(): void {
    this.serverProfileDraft = { ...this.serverProfileBaseline };
    this.serverProfileOverridesDraft = { ...this.serverProfileOverridesBaseline };
    this.serverProfileSaveMessage = "";
    this.hooks.setError("");
  }

  setServerProfileOverride(field: keyof ProfileOverrides, enabled: boolean): void {
    this.serverProfileOverridesDraft = { ...this.serverProfileOverridesDraft, [field]: enabled };
    if (enabled) return;
    const localProfile = this.hooks.localUserProfile();
    if (field === "display_name") {
      this.serverProfileDraft = { ...this.serverProfileDraft, display_name: localProfile.display_name };
    } else if (field === "avatar") {
      this.serverProfileDraft = {
        ...this.serverProfileDraft,
        avatar_data_url: localProfile.avatar_data_url ?? "",
        avatar_sha256: localProfile.avatar_sha256 ?? "",
        avatar_color: localProfile.avatar_color ?? ""
      };
    } else {
      this.serverProfileDraft = { ...this.serverProfileDraft, bio: localProfile.bio };
    }
  }

  async saveServerProfileSettings(): Promise<void> {
    if (!this.hooks.sessionToken() || !this.hooks.currentMember() || this.serverProfileSaving) return;
    const localProfile = this.hooks.localUserProfile();
    const name = this.serverProfileOverridesDraft.display_name
      ? this.serverProfileDraft.display_name.trim()
      : localProfile.display_name;
    if (!name) return;
    this.serverProfileSaving = true;
    this.serverProfileSaveMessage = "";
    this.hooks.setError("");
    const effective: LocalUserProfile = {
      ...localProfile,
      display_name: name.slice(0, 64),
      avatar_data_url: this.serverProfileOverridesDraft.avatar
        ? this.serverProfileDraft.avatar_data_url ?? ""
        : localProfile.avatar_data_url ?? "",
      avatar_sha256: this.serverProfileOverridesDraft.avatar
        ? this.serverProfileDraft.avatar_sha256 ?? ""
        : localProfile.avatar_sha256 ?? "",
      avatar_color: this.serverProfileOverridesDraft.avatar
        ? this.serverProfileDraft.avatar_color ?? ""
        : localProfile.avatar_color ?? "",
      bio: (this.serverProfileOverridesDraft.bio ? this.serverProfileDraft.bio : localProfile.bio).trim().slice(0, 500),
      updated_at_ms: Date.now()
    };
    try {
      const updated = await updateServerProfile(this.hooks.baseUrl(), this.hooks.sessionToken(), effective, this.serverProfileOverridesDraft);
      this.hooks.mergeMember(updated);
      const persisted = effectiveProfileForServer(localProfile, updated);
      const persistedOverrides = profileOverrides(updated);
      this.serverProfileDraft = { ...persisted };
      this.serverProfileBaseline = { ...persisted };
      this.serverProfileOverridesDraft = { ...persistedOverrides };
      this.serverProfileOverridesBaseline = { ...persistedOverrides };
      this.serverProfileSaveMessage = this.hooks.translate("serverProfile.saved");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.memberUpdateFailed"));
    } finally {
      this.serverProfileSaving = false;
    }
  }

  async selectServerProfileAvatar(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      this.hooks.setError(this.hooks.translate("profile.avatarInvalid"));
      return;
    }
    this.releaseImageCropSource(this.serverProfileAvatarCropSource);
    this.serverProfileAvatarCropSource = URL.createObjectURL(file);
    this.hooks.setError("");
  }

  applyServerProfileAvatarCrop(dataURL: string): void {
    this.serverProfileDraft = { ...this.serverProfileDraft, avatar_data_url: dataURL, avatar_sha256: "" };
    this.closeServerProfileAvatarCrop();
    this.hooks.setError("");
  }

  closeServerProfileAvatarCrop(): void {
    this.releaseImageCropSource(this.serverProfileAvatarCropSource);
    this.serverProfileAvatarCropSource = "";
  }

  clearServerProfileAvatar(): void {
    this.serverProfileDraft = { ...this.serverProfileDraft, avatar_data_url: "", avatar_sha256: "" };
  }

  setServerProfileAvatarColor(color: string): void {
    const currentMember = this.hooks.currentMember();
    this.serverProfileDraft = {
      ...this.serverProfileDraft,
      avatar_color: normalizeAvatarColor(color, currentMember?.member_id || this.hooks.localUserProfile().local_profile_id)
    };
  }

  // ---- invites ----------------------------------------------------------------

  async openInviteDialog(): Promise<void> {
    if (!this.hooks.sessionToken() || !this.hooks.canCreateInvites()) return;
    this.hooks.closeServerMenu();
    this.inviteDialogOpen = true;
    this.generatedInviteLink = "";
    this.inviteActionBusy = true;
    try {
      this.serverInvites = await getServerInvites(this.hooks.baseUrl(), this.hooks.sessionToken());
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("invite.loadFailed"));
    } finally {
      this.inviteActionBusy = false;
    }
  }

  closeInviteDialog(): void {
    if (this.inviteActionBusy) return;
    this.inviteDialogOpen = false;
    this.generatedInviteLink = "";
  }

  closeGeneratedInviteDialog(): void {
    this.generatedInviteLink = "";
  }

  async createInviteFromDialog(): Promise<void> {
    if (!this.hooks.sessionToken() || !this.hooks.canCreateInvites() || this.inviteActionBusy) return;
    this.inviteActionBusy = true;
    this.hooks.setError("");
    try {
      const invite = await createServerInvite(this.hooks.baseUrl(), this.hooks.sessionToken(), {
        expires_in_seconds: this.inviteExpiresInSeconds,
        max_uses: this.inviteMaxUses
      });
      this.generatedInviteLink = `${this.hooks.baseUrl()}/invite/${encodeURIComponent(invite.token ?? "")}`;
      this.serverInvites = [invite, ...this.serverInvites.filter((item) => item.invite_id !== invite.invite_id)];
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("invite.createFailed"));
    } finally {
      this.inviteActionBusy = false;
    }
  }

  async revokeInvite(inviteID: string): Promise<void> {
    if (!this.hooks.sessionToken() || !this.hooks.canCreateInvites() || this.inviteActionBusy) return;
    this.inviteActionBusy = true;
    try {
      await deleteServerInvite(this.hooks.baseUrl(), this.hooks.sessionToken(), inviteID);
      this.serverInvites = this.serverInvites.filter((item) => item.invite_id !== inviteID);
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("invite.deleteFailed"));
    } finally {
      this.inviteActionBusy = false;
    }
  }

  inviteLink(invite: ServerInvite): string {
    return invite.token ? `${this.hooks.baseUrl()}/invite/${encodeURIComponent(invite.token)}` : "";
  }

  async copyInviteLink(link: string, inviteID: string): Promise<void> {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      this.copiedInviteId = inviteID;
      window.clearTimeout(this.copiedInviteTimer);
      this.copiedInviteTimer = window.setTimeout(() => (this.copiedInviteId = ""), 1400);
    } catch {
      await this.hooks.showAppAlert(this.hooks.translate("invite.copyFailed"), { title: this.hooks.translate("invite.title") });
    }
  }

  async copyGeneratedInviteLink(): Promise<void> {
    await this.copyInviteLink(this.generatedInviteLink, "generated");
  }

  inviteExpiryOptionLabel(seconds: number): string {
    if (seconds === 0) return this.hooks.translate("invite.expiryNever");
    if (seconds === 30 * 60) return this.hooks.translate("invite.expiry30Minutes");
    if (seconds === 24 * 60 * 60) return this.hooks.translate("invite.expiryOneDay");
    return this.hooks.translate("invite.expirySevenDays");
  }

  inviteStatusLabel(invite: ServerInvite): string {
    if (invite.use_count >= invite.max_uses) return this.hooks.translate("invite.exhausted");
    if (invite.expires_at_ms > 0 && invite.expires_at_ms <= Date.now()) return this.hooks.translate("invite.expired");
    if (invite.expires_at_ms === 0) return this.hooks.translate("invite.expiryNever");
    return this.auditTime(invite.expires_at_ms);
  }

  // ---- audit ------------------------------------------------------------------

  async loadAuditLogs(): Promise<void> {
    if (!this.hooks.sessionToken() || !this.hooks.canEditServerSettings() || this.auditLogsLoading) return;
    this.auditLogsLoading = true;
    this.hooks.setError("");
    try {
      this.auditLogs = await getAuditLogs(this.hooks.baseUrl(), this.hooks.sessionToken(), this.auditActionFilter.trim(), 80);
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.auditLoadFailed"));
      this.auditLogs = [];
    } finally {
      this.auditLogsLoading = false;
    }
  }

  auditActorName(log: AuditLog): string {
    return this.hooks.memberDisplayName(log.actor_member_id);
  }

  auditTime(createdAtMS: number): string {
    return new Date(createdAtMS).toLocaleString();
  }
}
