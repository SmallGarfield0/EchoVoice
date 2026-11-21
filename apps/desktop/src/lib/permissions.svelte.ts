// Roles and channel permission overrides.
//
// Owns the server role registry (CRUD, draft editing, drag reorder, preview),
// the role/permission query helpers, and the channel permission override
// editor (targets, per-target allow/deny matrix, save/reload). Member
// management, identity merge, and the role member-assignment actions stay in
// the workspace component (members domain) and reach this state through
// hooks.
//
// Hot-path discipline: event handlers read this state directly; the
// component's legacy `$` aliases (kept fresh by the realtimeSyncTick bump)
// feed templates only.

import { tick } from "svelte";
import {
  createRole,
  deleteRole as deleteRemoteRole,
  deleteMember,
  getChannelPermissionOverrides,
  getRoles,
  linkMemberIdentity,
  reorderRoles,
  replaceMemberRoles,
  setChannelPermissionOverride,
  deleteChannelPermissionOverride,
  updateMember,
  updateRole
} from "./api";
import { avatarStyleVariables } from "./avatar";
import { hasEffectivePermission, roleAllowsPermission } from "./permissions";
import type {
  Channel,
  ChannelPermissionOverride,
  LocalUserProfile,
  Member,
  Permission,
  ServerRole
} from "./types";

/** A role or member target shown in the channel permission editor. */
export type ChannelPermissionTarget = {
  targetType: "role" | "member";
  targetId: string;
};

/** Grouped permission listing used by the role and channel editors. */
export type PermissionGroup = {
  key: string;
  labelKey: string;
  permissions: Permission[];
};

export type PermissionsHooks = {
  memberId: () => string;
  sessionToken: () => string;
  baseUrl: () => string;
  translate: (key: string, params?: Record<string, unknown>) => string;
  setError: (message: string) => void;
  setStatusKey: (key: string) => void;
  canManageRoles: () => boolean;
  canManageChannelPermissions: () => boolean;
  canManageMembers: () => boolean;
  isOwner: () => boolean;
  currentMember: () => Member | undefined;
  localUserProfile: () => LocalUserProfile;
  members: () => Member[];
  setMembers: (members: Member[]) => void;
  memberById: (memberId: string) => Member | undefined;
  mergeMember: (member: Member) => void;
  removeMember: (member: Member) => void;
  flushAliases: () => void;
  channels: () => Channel[];
  channelDraft: () => Channel | null;
  setChannelDraft: (draft: Channel | null) => void;
  channelSettingsSaving: () => boolean;
  closeServerSettings: () => void;
  showAppConfirm: (message: string, options?: Record<string, unknown>) => Promise<boolean>;
  readFileAsDataURL: (file: File) => Promise<string>;
  roleIconInputElement: () => HTMLInputElement | null;
  setRoleIconInputElement: (element: HTMLInputElement | null) => void;
  channelPermissionTargetPickerElement: () => HTMLDivElement | null;
  setChannelPermissionTargetPickerElement: (element: HTMLDivElement | null) => void;
  channelPermissionTargetMenuElement: () => HTMLDivElement | null;
  setChannelPermissionTargetMenuElement: (element: HTMLDivElement | null) => void;
  permissionKeys: () => Permission[];
  channelOverridePermissionKeys: () => Permission[];
  permissionGroups: () => PermissionGroup[];
};

export class PermissionsController {
  // ---- role registry ---------------------------------------------------------
  roles = $state<ServerRole[]>([]);
  selectedRoleId = $state("everyone");
  roleDraft = $state<ServerRole | null>(null);
  roleUpdating = $state(false);
  roleCreating = $state(false);
  roleDeleting = $state(false);
  // ---- role drag reorder ------------------------------------------------------
  draggedRoleId = $state("");
  dragOverRoleId = $state("");
  roleDragPlacement = $state<"before" | "after">("before");
  // ---- role settings UI -------------------------------------------------------
  roleSettingsSection = $state<"display" | "permissions" | "members">("display");
  rolePermissionSearch = $state("");
  roleMemberSearch = $state("");
  rolePreviewId = $state("");
  roleMemberUpdatingId = $state("");
  // ---- channel permission editor ----------------------------------------------
  selectedPermissionChannelId = $state("");
  channelPermissionOverrides = $state<ChannelPermissionOverride[]>([]);
  channelPermissionDraftOverrides = $state<ChannelPermissionOverride[]>([]);
  channelPermissionLoadedChannelId = $state("");
  channelPermissionLoading = $state(false);
  channelPermissionTargetType = $state<"role" | "member">("role");
  channelPermissionTargetId = $state("everyone");
  channelPermissionTargets = $state<ChannelPermissionTarget[]>([]);
  channelPermissionTargetPickerOpen = $state(false);
  channelPermissionTargetMenuStyle = $state("");
  channelPermissionSearch = $state("");
  // ---- member management & identity linking -----------------------------------
  memberEditingId = $state("");
  memberBanDraft = $state(false);
  memberUpdating = $state(false);
  memberRoleMenuId = $state("");
  memberRoleMenuSearch = $state("");
  identityMemberPickerOpen = $state<"primary" | "duplicate" | null>(null);
  identityMemberPickerSearch = $state("");
  identityLinkPrimaryMemberId = $state("");
  identityLinkDuplicateMemberId = $state("");
  identityLinkBusy = $state(false);

  constructor(private hooks: PermissionsHooks) {}

  permissionsWithDefault(enabled: boolean): Record<Permission, boolean> {
    return Object.fromEntries(this.hooks.permissionKeys().map((permission) => [permission, enabled])) as Record<Permission, boolean>;
  }

  // ---- role queries -----------------------------------------------------------

  sortRoles(roleList: ServerRole[]): ServerRole[] {
    return [...roleList].sort((left, right) => {
      if (left.is_everyone && !right.is_everyone) return 1;
      if (!left.is_everyone && right.is_everyone) return -1;
      return right.position - left.position || left.name.localeCompare(right.name) || left.role_id.localeCompare(right.role_id);
    });
  }

  roleById(roleId: string): ServerRole | undefined {
    return this.roles.find((role) => role.role_id === roleId);
  }

  roleAllows(role: ServerRole | undefined, permission: Permission): boolean {
    return roleAllowsPermission(role, permission);
  }

  roleNamesForMember(member: Member): string[] {
    return (member.role_ids ?? [])
      .map((roleId) => this.roleById(roleId)?.name)
      .filter((name): name is string => Boolean(name));
  }

  memberTopRole(member: Member): ServerRole | undefined {
    return this.sortRoles(this.roles).find((role) => !role.is_everyone && member.role_ids.includes(role.role_id));
  }

  memberRoleLabel(member: Member): string {
    if (member.is_owner) return this.hooks.translate("member.owner");
    const names = this.roleNamesForMember(member);
    return names.length > 0 ? names.join(", ") : this.hooks.translate("roles.noRoles");
  }

  roleTextStyle(role: ServerRole | undefined): string {
    if (!role) return "";
    if (role.gradient_color) {
      return `background: linear-gradient(90deg, ${role.color || "#9bdcff"}, ${role.gradient_color}); color: transparent; -webkit-background-clip: text; background-clip: text;`;
    }
    return role.color ? `color: ${role.color};` : "";
  }

  cloneRole(role: ServerRole): ServerRole {
    return {
      ...role,
      permissions: { ...this.permissionsWithDefault(false), ...(role.permissions ?? {}) }
    };
  }

  highestDisplayedRole(member: Member, roleList = this.roles): ServerRole | undefined {
    return this.sortRoles(roleList).find((role) => role.display_separately && !role.is_everyone && member.role_ids.includes(role.role_id));
  }

  assignableRoles(): ServerRole[] {
    return this.roles.filter((role) => !role.is_everyone);
  }

  roleMemberCount(role: ServerRole): number {
    if (role.is_everyone) return this.hooks.members().length;
    return this.hooks.members().filter((member) => member.role_ids.includes(role.role_id)).length;
  }

  filteredRolePermissionGroups(): PermissionGroup[] {
    const query = this.rolePermissionSearch.trim().toLocaleLowerCase();
    if (!query) return this.hooks.permissionGroups();
    return this.hooks.permissionGroups()
      .map((group) => ({
        ...group,
        permissions: group.permissions.filter((permission) => {
          const haystack = `${this.permissionLabel(permission)} ${this.permissionDescription(permission)} ${permission}`.toLocaleLowerCase();
          return haystack.includes(query);
        })
      }))
      .filter((group) => group.permissions.length > 0);
  }

  filteredMembersForRole(): Member[] {
    if (!this.roleDraft) return [];
    const query = this.roleMemberSearch.trim().toLocaleLowerCase();
    return this.hooks.members().filter((member) => {
      if (!query) return true;
      return member.display_name.toLocaleLowerCase().includes(query) || member.member_id.toLocaleLowerCase().includes(query);
    });
  }

  permissionLabel(permission: Permission): string {
    return this.hooks.translate(`permission.${permission}`);
  }

  permissionDescription(permission: Permission): string {
    return this.hooks.translate(`permissionDescription.${permission}`);
  }

  // ---- role registry mutations ------------------------------------------------

  ensureSelectedRole(): void {
    const next = this.roleById(this.selectedRoleId) ?? this.roles.find((role) => role.is_everyone) ?? this.roles[0];
    this.selectedRoleId = next?.role_id ?? "everyone";
    this.roleDraft = next ? this.cloneRole(next) : null;
  }

  selectRole(roleId: string): void {
    const role = this.roleById(roleId);
    if (!role) return;
    this.selectedRoleId = role.role_id;
    this.roleDraft = this.cloneRole(role);
    this.rolePermissionSearch = "";
    this.roleMemberSearch = "";
    this.hooks.setError("");
  }

  mergeRole(role: ServerRole): void {
    if (!role?.role_id) return;
    const exists = this.roles.some((item) => item.role_id === role.role_id);
    this.roles = this.sortRoles(exists ? this.roles.map((item) => (item.role_id === role.role_id ? role : item)) : [...this.roles, role]);
    if (!this.roleById(this.selectedRoleId)) {
      this.ensureSelectedRole();
      return;
    }
    if (this.selectedRoleId === role.role_id && !this.roleSettingsDirty()) {
      this.roleDraft = this.cloneRole(role);
    }
  }

  roleSettingsDirty(): boolean {
    const selected = this.roleById(this.selectedRoleId);
    return Boolean(this.roleDraft && selected && !this.sameRoleSettings(this.roleDraft, selected));
  }

  removeRole(role: ServerRole): void {
    if (!role?.role_id) return;
    this.roles = this.roles.filter((item) => item.role_id !== role.role_id);
    this.hooks.setMembers(this.hooks.members().map((member) => ({
      ...member,
      role_ids: (member.role_ids ?? []).filter((roleId) => roleId !== role.role_id)
    })));
    if (this.selectedRoleId === role.role_id) {
      this.ensureSelectedRole();
    }
    if (this.rolePreviewId === role.role_id) {
      this.rolePreviewId = "";
    }
  }

  // ---- role draft editing ------------------------------------------------------

  setRoleDraftName(event: Event): void {
    if (!this.roleDraft || this.roleDraft.is_everyone) return;
    const input = event.currentTarget as HTMLInputElement;
    this.roleDraft = { ...this.roleDraft, name: input.value };
  }

  setRoleDraftColor(event: Event): void {
    if (!this.roleDraft || this.roleDraft.is_everyone) return;
    const input = event.currentTarget as HTMLInputElement;
    this.roleDraft = { ...this.roleDraft, color: input.value };
  }

  setRoleDraftGradientEnabled(event: Event): void {
    if (!this.roleDraft || this.roleDraft.is_everyone) return;
    const input = event.currentTarget as HTMLInputElement;
    this.roleDraft = {
      ...this.roleDraft,
      gradient_color: input.checked ? this.roleDraft.gradient_color || "#5aaef2" : ""
    };
  }

  setRoleDraftGradientColor(event: Event): void {
    if (!this.roleDraft || this.roleDraft.is_everyone) return;
    const input = event.currentTarget as HTMLInputElement;
    this.roleDraft = { ...this.roleDraft, gradient_color: input.value };
  }

  setRoleDraftDisplaySeparately(event: Event): void {
    if (!this.roleDraft || this.roleDraft.is_everyone) return;
    const input = event.currentTarget as HTMLInputElement;
    this.roleDraft = { ...this.roleDraft, display_separately: input.checked };
  }

  async selectRoleIcon(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !this.roleDraft || this.roleDraft.is_everyone) return;
    if (!file.type.startsWith("image/") || file.size > 256 * 1024) {
      this.hooks.setError(this.hooks.translate("roles.iconInvalid"));
      return;
    }
    try {
      this.roleDraft = { ...this.roleDraft, icon_data_url: await this.hooks.readFileAsDataURL(file) };
      this.hooks.setError("");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("roles.iconInvalid"));
    }
  }

  clearRoleIcon(): void {
    if (!this.roleDraft || this.roleDraft.is_everyone) return;
    this.roleDraft = { ...this.roleDraft, icon_data_url: "" };
  }

  setRoleDraftPermission(permission: Permission, event: Event): void {
    if (!this.roleDraft || !this.hooks.canManageRoles()) return;
    const input = event.currentTarget as HTMLInputElement;
    const permissions = { ...this.roleDraft.permissions, [permission]: input.checked };
    if (input.checked && permission === "download_files") permissions.view_files = true;
    if (input.checked && permission === "manage_files") {
      permissions.view_files = true;
      permissions.upload_files = true;
      permissions.download_files = true;
    }
    if (!input.checked && permission === "view_files") {
      permissions.download_files = false;
      permissions.manage_files = false;
    }
    if (!input.checked && (permission === "upload_files" || permission === "download_files")) {
      permissions.manage_files = false;
    }
    this.roleDraft = {
      ...this.roleDraft,
      permissions
    };
  }

  sameRoleSettings(left: ServerRole, right: ServerRole): boolean {
    return (
      left.name === right.name &&
      left.color === right.color &&
      (left.gradient_color ?? "") === (right.gradient_color ?? "") &&
      (left.icon_data_url ?? "") === (right.icon_data_url ?? "") &&
      Boolean(left.display_separately) === Boolean(right.display_separately) &&
      left.position === right.position &&
      this.hooks.permissionKeys().every((permission) => Boolean(left.permissions?.[permission]) === Boolean(right.permissions?.[permission]))
    );
  }

  resetRoleSettings(): void {
    const selected = this.roleById(this.selectedRoleId);
    if (selected) {
      this.roleDraft = this.cloneRole(selected);
    }
  }

  // ---- role CRUD ---------------------------------------------------------------

  async createServerRole(): Promise<void> {
    if (!this.hooks.sessionToken() || !this.hooks.canManageRoles() || this.roleCreating) return;
    this.roleCreating = true;
    this.hooks.setError("");
    try {
      const role = await createRole(this.hooks.baseUrl(), this.hooks.sessionToken(), {
        name: this.hooks.translate("roles.newRole"),
        color: "#9bdcff",
        gradient_color: "",
        icon_data_url: "",
        display_separately: false,
        permissions: this.permissionsWithDefault(false)
      });
      this.mergeRole(role);
      this.selectRole(role.role_id);
      this.hooks.setStatusKey("roles.saved");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.roleUpdateFailed"));
    } finally {
      this.roleCreating = false;
    }
  }

  async submitRoleSettings(): Promise<void> {
    if (!this.roleDraft || !this.hooks.sessionToken() || !this.hooks.canManageRoles() || this.roleUpdating) return;
    if (!this.roleDraft.is_everyone && !this.roleDraft.name.trim()) return;
    this.roleUpdating = true;
    this.hooks.setError("");
    try {
      const updated = await updateRole(this.hooks.baseUrl(), this.hooks.sessionToken(), this.roleDraft.role_id, {
        name: this.roleDraft.name.trim(),
        color: this.roleDraft.color,
        gradient_color: this.roleDraft.gradient_color ?? "",
        icon_data_url: this.roleDraft.icon_data_url ?? "",
        display_separately: this.roleDraft.display_separately,
        position: this.roleDraft.position,
        permissions: this.roleDraft.permissions
      });
      this.mergeRole(updated);
      this.roleDraft = this.cloneRole(updated);
      this.hooks.setStatusKey("roles.saved");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.roleUpdateFailed"));
    } finally {
      this.roleUpdating = false;
    }
  }

  async deleteSelectedRole(): Promise<void> {
    if (!this.roleDraft || this.roleDraft.is_everyone || !this.hooks.sessionToken() || !this.hooks.canManageRoles() || this.roleDeleting) return;
    if (!(await this.hooks.showAppConfirm(this.hooks.translate("roles.deleteConfirm", { name: this.roleDraft.name }), {
      title: this.hooks.translate("roles.delete"),
      confirmLabel: this.hooks.translate("roles.delete"),
      danger: true
    }))) return;
    this.roleDeleting = true;
    this.hooks.setError("");
    try {
      const removed = await deleteRemoteRole(this.hooks.baseUrl(), this.hooks.sessionToken(), this.roleDraft.role_id);
      this.removeRole(removed);
      this.hooks.setStatusKey("roles.deleted");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.roleDeleteFailed"));
    } finally {
      this.roleDeleting = false;
    }
  }

  // ---- role drag reorder -------------------------------------------------------

  startRoleDrag(role: ServerRole, event: DragEvent): void {
    if (!this.hooks.canManageRoles() || role.is_everyone) return;
    this.draggedRoleId = role.role_id;
    this.dragOverRoleId = "";
    this.roleDragPlacement = "before";
    event.dataTransfer?.setData("text/plain", role.role_id);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
    }
  }

  overRoleDropTarget(role: ServerRole, event: DragEvent): void {
    if (!this.draggedRoleId || this.draggedRoleId === role.role_id || role.is_everyone) return;
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "move";
    }
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    this.roleDragPlacement = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    this.dragOverRoleId = role.role_id;
  }

  endRoleDrag(): void {
    this.draggedRoleId = "";
    this.dragOverRoleId = "";
    this.roleDragPlacement = "before";
  }

  async dropRoleOn(target: ServerRole): Promise<void> {
    if (!this.hooks.sessionToken() || !this.hooks.canManageRoles() || !this.draggedRoleId || this.draggedRoleId === target.role_id || target.is_everyone) {
      this.endRoleDrag();
      return;
    }
    const source = this.roleById(this.draggedRoleId);
    if (!source || source.is_everyone) {
      this.endRoleDrag();
      return;
    }
    const ordered = this.assignableRoles();
    const withoutSource = ordered.filter((role) => role.role_id !== source.role_id);
    const targetIndex = withoutSource.findIndex((role) => role.role_id === target.role_id);
    if (targetIndex < 0) {
      this.endRoleDrag();
      return;
    }
    withoutSource.splice(this.roleDragPlacement === "after" ? targetIndex + 1 : targetIndex, 0, source);
    await this.persistRoleOrder(withoutSource);
    this.endRoleDrag();
  }

  async persistRoleOrder(ordered: ServerRole[]): Promise<void> {
    this.hooks.setError("");
    try {
      this.roles = this.sortRoles(await reorderRoles(this.hooks.baseUrl(), this.hooks.sessionToken(), ordered.map((role) => ({ role_id: role.role_id }))));
      this.ensureSelectedRole();
      this.hooks.setStatusKey("roles.saved");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.roleUpdateFailed"));
      this.roles = this.sortRoles(await getRoles(this.hooks.baseUrl(), this.hooks.sessionToken()));
      this.ensureSelectedRole();
    }
  }

  // ---- role preview ------------------------------------------------------------

  startRolePreview(roleId: string): void {
    const role = this.roleById(roleId);
    if (!role || (!this.hooks.isOwner() && !hasEffectivePermission("administrator", false, this.hooks.currentMember(), this.roles))) return;
    this.rolePreviewId = roleId;
    this.hooks.closeServerSettings();
  }

  stopRolePreview(): void {
    this.rolePreviewId = "";
  }

  // ---- channel permission overrides ---------------------------------------------

  channelPermissionGroups(): PermissionGroup[] {
    const channel = this.hooks.channels().find((item) => item.channel_id === this.selectedPermissionChannelId);
    const textPermissions = new Set<Permission>([
      "view_channels",
      "manage_channels",
      "manage_channel_permissions",
      "send_messages",
      "manage_messages",
      "read_message_history",
      "view_files",
      "upload_files",
      "download_files",
      "manage_files"
    ]);
    const voicePermissions = new Set<Permission>([
      ...textPermissions,
      "connect_voice",
      "speak",
      "mute_members",
      "deafen_members",
      "move_members",
      "share_screen",
      "request_remote_control",
      "accept_remote_control",
      "play_accompaniment"
    ]);
    const allowed = channel?.type === "text" ? textPermissions : channel?.type === "voice" || channel?.type === "temporary_voice" ? voicePermissions : new Set(this.hooks.channelOverridePermissionKeys());
    return this.hooks.permissionGroups()
      .map((group) => ({
        ...group,
        permissions: group.permissions.filter((permission) => allowed.has(permission))
      }))
      .filter((group) => group.permissions.length > 0);
  }

  channelPermissionOverrideKey(override: Pick<ChannelPermissionOverride, "target_type" | "target_id">): string {
    return `${override.target_type}:${override.target_id}`;
  }

  cloneChannelPermissionOverrides(overrides: ChannelPermissionOverride[]): ChannelPermissionOverride[] {
    return overrides.map((override) => ({
      ...override,
      allows: { ...this.permissionsWithDefault(false), ...(override.allows ?? {}) },
      denies: { ...this.permissionsWithDefault(false), ...(override.denies ?? {}) }
    }));
  }

  sameChannelPermissionOverrideValues(
    left: Pick<ChannelPermissionOverride, "target_type" | "target_id" | "allows" | "denies">,
    right: Pick<ChannelPermissionOverride, "target_type" | "target_id" | "allows" | "denies">
  ): boolean {
    return left.target_type === right.target_type &&
      left.target_id === right.target_id &&
      this.hooks.permissionKeys().every((permission) =>
        Boolean(left.allows?.[permission]) === Boolean(right.allows?.[permission]) &&
        Boolean(left.denies?.[permission]) === Boolean(right.denies?.[permission])
      );
  }

  sameChannelPermissionOverrides(left: ChannelPermissionOverride[], right: ChannelPermissionOverride[]): boolean {
    if (left.length !== right.length) return false;
    const rightByTarget = new Map(right.map((override) => [this.channelPermissionOverrideKey(override), override]));
    return left.every((override) => {
      const other = rightByTarget.get(this.channelPermissionOverrideKey(override));
      return Boolean(other && this.sameChannelPermissionOverrideValues(override, other));
    });
  }

  async loadChannelPermissionOverrides(force = false): Promise<void> {
    if (!this.hooks.sessionToken() || !this.selectedPermissionChannelId || !this.hooks.canManageChannelPermissions()) {
      this.channelPermissionOverrides = [];
      this.channelPermissionDraftOverrides = [];
      this.channelPermissionLoadedChannelId = "";
      return;
    }
    if (!force && this.channelPermissionLoadedChannelId === this.selectedPermissionChannelId) return;
    const requestChannelId = this.selectedPermissionChannelId;
    const requestSessionToken = this.hooks.sessionToken();
    this.channelPermissionLoading = true;
    this.hooks.setError("");
    try {
      const loaded = this.cloneChannelPermissionOverrides(
        await getChannelPermissionOverrides(this.hooks.baseUrl(), requestSessionToken, requestChannelId)
      );
      if (requestChannelId !== this.selectedPermissionChannelId || requestSessionToken !== this.hooks.sessionToken()) return;
      this.channelPermissionOverrides = loaded;
      this.channelPermissionDraftOverrides = this.cloneChannelPermissionOverrides(loaded);
      this.channelPermissionLoadedChannelId = requestChannelId;
      this.rebuildChannelPermissionTargets();
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.channelPermissionLoadFailed"));
    } finally {
      this.channelPermissionLoading = false;
    }
  }

  mergeChannelPermissionOverride(override: ChannelPermissionOverride): void {
    if (!override?.override_id) return;
    const draftWasDirty = !this.sameChannelPermissionOverrides(this.channelPermissionDraftOverrides, this.channelPermissionOverrides);
    const normalized = this.cloneChannelPermissionOverrides([override])[0];
    const key = this.channelPermissionOverrideKey(normalized);
    const exists = this.channelPermissionOverrides.some((item) =>
      item.override_id === normalized.override_id || this.channelPermissionOverrideKey(item) === key
    );
    this.channelPermissionOverrides = exists
      ? this.channelPermissionOverrides.map((item) =>
          item.override_id === normalized.override_id || this.channelPermissionOverrideKey(item) === key ? normalized : item
        )
      : [...this.channelPermissionOverrides, normalized];
    if (!draftWasDirty && !this.hooks.channelSettingsSaving()) {
      this.channelPermissionDraftOverrides = this.cloneChannelPermissionOverrides(this.channelPermissionOverrides);
      this.rebuildChannelPermissionTargets();
    }
  }

  removeChannelPermissionOverride(override: ChannelPermissionOverride): void {
    if (!override?.override_id) return;
    const draftWasDirty = !this.sameChannelPermissionOverrides(this.channelPermissionDraftOverrides, this.channelPermissionOverrides);
    this.channelPermissionOverrides = this.channelPermissionOverrides.filter((item) =>
      item.override_id !== override.override_id && this.channelPermissionOverrideKey(item) !== this.channelPermissionOverrideKey(override)
    );
    if (!draftWasDirty && !this.hooks.channelSettingsSaving()) {
      this.channelPermissionDraftOverrides = this.cloneChannelPermissionOverrides(this.channelPermissionOverrides);
      this.rebuildChannelPermissionTargets();
    }
  }

  channelPermissionOverrideFor(targetType: "role" | "member", targetId: string): ChannelPermissionOverride | undefined {
    return this.channelPermissionDraftOverrides.find((override) => override.target_type === targetType && override.target_id === targetId);
  }

  savedChannelPermissionOverrideFor(targetType: "role" | "member", targetId: string): ChannelPermissionOverride | undefined {
    return this.channelPermissionOverrides.find((override) => override.target_type === targetType && override.target_id === targetId);
  }

  channelPermissionState(targetType: "role" | "member", targetId: string, permission: Permission): "inherit" | "allow" | "deny" {
    const override = this.channelPermissionOverrideFor(targetType, targetId);
    if (override?.allows?.[permission]) return "allow";
    if (override?.denies?.[permission]) return "deny";
    return "inherit";
  }

  filteredChannelPermissionRoles(): ServerRole[] {
    const query = this.channelPermissionSearch.trim().toLocaleLowerCase();
    return this.roles.filter(
      (role) =>
        !this.channelPermissionTargets.some((target) => target.targetType === "role" && target.targetId === role.role_id) &&
        (!query || role.name.toLocaleLowerCase().includes(query))
    );
  }

  filteredChannelPermissionMembers(): Member[] {
    const query = this.channelPermissionSearch.trim().toLocaleLowerCase();
    return this.hooks.members().filter(
      (member) =>
        !this.channelPermissionTargets.some((target) => target.targetType === "member" && target.targetId === member.member_id) &&
        (!query || member.display_name.toLocaleLowerCase().includes(query))
    );
  }

  rebuildChannelPermissionTargets(): void {
    const everyoneRole = this.roles.find((role) => role.is_everyone);
    const next: ChannelPermissionTarget[] = everyoneRole
      ? [{ targetType: "role", targetId: everyoneRole.role_id }]
      : [];
    for (const override of this.channelPermissionDraftOverrides) {
      if (!next.some((target) => target.targetType === override.target_type && target.targetId === override.target_id)) {
        next.push({ targetType: override.target_type, targetId: override.target_id });
      }
    }
    this.channelPermissionTargets = next;
    if (!next.some((target) => target.targetType === this.channelPermissionTargetType && target.targetId === this.channelPermissionTargetId)) {
      this.channelPermissionTargetType = next[0]?.targetType ?? "role";
      this.channelPermissionTargetId = next[0]?.targetId ?? "";
    }
  }

  ensureChannelPermissionTarget(targetType: "role" | "member", targetId: string): void {
    if (!targetId || this.channelPermissionTargets.some((target) => target.targetType === targetType && target.targetId === targetId)) return;
    this.channelPermissionTargets = [...this.channelPermissionTargets, { targetType, targetId }];
  }

  addChannelPermissionTarget(targetType: "role" | "member", targetId: string): void {
    if (!this.channelPermissionOverrideFor(targetType, targetId)) {
      this.channelPermissionDraftOverrides = [
        ...this.channelPermissionDraftOverrides,
        {
          override_id: "",
          channel_id: this.selectedPermissionChannelId,
          target_type: targetType,
          target_id: targetId,
          allows: this.permissionsWithDefault(false),
          denies: this.permissionsWithDefault(false)
        }
      ];
      this.markChannelPermissionsUnsynced();
    }
    this.ensureChannelPermissionTarget(targetType, targetId);
    this.selectChannelPermissionTarget(targetType, targetId);
    this.channelPermissionTargetPickerOpen = false;
    this.channelPermissionTargetMenuStyle = "";
    this.channelPermissionSearch = "";
  }

  removeSelectedChannelPermissionTarget(): void {
    const targetType = this.channelPermissionTargetType;
    const targetId = this.channelPermissionTargetId;
    const role = targetType === "role" ? this.roleById(targetId) : undefined;
    if (!targetId || role?.is_everyone) return;
    this.channelPermissionDraftOverrides = this.channelPermissionDraftOverrides.filter(
      (override) => override.target_type !== targetType || override.target_id !== targetId
    );
    this.channelPermissionTargets = this.channelPermissionTargets.filter(
      (target) => target.targetType !== targetType || target.targetId !== targetId
    );
    this.markChannelPermissionsUnsynced();
    const next = this.channelPermissionTargets[0];
    this.channelPermissionTargetType = next?.targetType ?? "role";
    this.channelPermissionTargetId = next?.targetId ?? "";
  }

  selectChannelPermissionTarget(type: "role" | "member", id: string): void {
    this.channelPermissionTargetType = type;
    this.channelPermissionTargetId = id;
  }

  async toggleChannelPermissionTargetPicker(): Promise<void> {
    if (this.channelPermissionTargetPickerOpen) {
      this.closeChannelPermissionTargetPicker();
      return;
    }
    this.channelPermissionTargetPickerOpen = true;
    await tick();
    this.updateChannelPermissionTargetMenuPosition();
  }

  closeChannelPermissionTargetPicker(): void {
    this.channelPermissionTargetPickerOpen = false;
    this.channelPermissionTargetMenuStyle = "";
  }

  updateChannelPermissionTargetMenuPosition(): void {
    const anchor = this.hooks.channelPermissionTargetPickerElement();
    if (!anchor || !this.channelPermissionTargetPickerOpen) return;
    const anchorRect = anchor.getBoundingClientRect();
    const viewportPadding = 12;
    const width = Math.min(300, window.innerWidth - viewportPadding * 2);
    const measuredHeight = Math.min(this.hooks.channelPermissionTargetMenuElement()?.scrollHeight ?? 340, 340);
    const roomBelow = window.innerHeight - anchorRect.bottom - viewportPadding;
    const top = roomBelow >= measuredHeight + 6
      ? anchorRect.bottom + 6
      : Math.max(viewportPadding, anchorRect.top - measuredHeight - 6);
    const left = Math.min(
      Math.max(viewportPadding, anchorRect.right - width),
      window.innerWidth - width - viewportPadding
    );
    this.channelPermissionTargetMenuStyle = `left: ${Math.round(left)}px; top: ${Math.round(top)}px; width: ${Math.round(width)}px;`;
  }

  selectedChannelPermissionTargetName(): string {
    if (this.channelPermissionTargetType === "role") return this.roleById(this.channelPermissionTargetId)?.name ?? "";
    return this.hooks.memberById(this.channelPermissionTargetId)?.display_name ?? "";
  }

  channelPermissionTargetName(target: ChannelPermissionTarget): string {
    if (target.targetType === "role") return this.roleById(target.targetId)?.name ?? target.targetId;
    return this.hooks.memberById(target.targetId)?.display_name ?? target.targetId;
  }

  selectedChannelPermissionTargetIsEveryone(): boolean {
    return this.channelPermissionTargetType === "role" && Boolean(this.roleById(this.channelPermissionTargetId)?.is_everyone);
  }

  hasAnyPermissionOverrideValue(permissions: Record<Permission, boolean>): boolean {
    return this.hooks.permissionKeys().some((permission) => Boolean(permissions[permission]));
  }

  markChannelPermissionsUnsynced(): void {
    const draft = this.hooks.channelDraft();
    if (!draft?.parent_id) return;
    const persistedChannel = this.hooks.channels().find((channel) => channel.channel_id === draft.channel_id);
    const shouldRemainSynced = Boolean(
      persistedChannel?.permission_synced &&
        this.sameChannelPermissionOverrides(this.channelPermissionDraftOverrides, this.channelPermissionOverrides)
    );
    if (draft.permission_synced !== shouldRemainSynced) {
      this.hooks.setChannelDraft({ ...draft, permission_synced: shouldRemainSynced });
    }
  }

  setChannelPermissionState(
    targetType: "role" | "member",
    targetId: string,
    permission: Permission,
    state: "inherit" | "allow" | "deny"
  ): void {
    if (!this.selectedPermissionChannelId || !this.hooks.canManageChannelPermissions()) return;
    const existing = this.channelPermissionOverrideFor(targetType, targetId);
    const allows = { ...this.permissionsWithDefault(false), ...(existing?.allows ?? {}) };
    const denies = { ...this.permissionsWithDefault(false), ...(existing?.denies ?? {}) };
    const setState = (key: Permission, next: "inherit" | "allow" | "deny") => {
      allows[key] = next === "allow";
      denies[key] = next === "deny";
    };
    setState(permission, state);
    if (state === "allow" && permission === "download_files") setState("view_files", "allow");
    if (state === "allow" && permission === "manage_files") {
      setState("view_files", "allow");
      setState("upload_files", "allow");
      setState("download_files", "allow");
    }
    if (state === "deny" && permission === "view_files") {
      setState("download_files", "deny");
      setState("manage_files", "deny");
    }
    if (state === "deny" && (permission === "upload_files" || permission === "download_files")) {
      setState("manage_files", "deny");
    }
    this.hooks.setError("");
    const nextOverride: ChannelPermissionOverride = {
      override_id: existing?.override_id ?? "",
      channel_id: this.selectedPermissionChannelId,
      target_type: targetType,
      target_id: targetId,
      allows,
      denies
    };
    const saved = this.savedChannelPermissionOverrideFor(targetType, targetId);
    const isEveryone = targetType === "role" && Boolean(this.roleById(targetId)?.is_everyone);
    const isEmpty = !this.hasAnyPermissionOverrideValue(allows) && !this.hasAnyPermissionOverrideValue(denies);
    if (isEveryone && !saved && isEmpty) {
      this.channelPermissionDraftOverrides = this.channelPermissionDraftOverrides.filter(
        (override) => override.target_type !== targetType || override.target_id !== targetId
      );
    } else {
      this.channelPermissionDraftOverrides = [
        ...this.channelPermissionDraftOverrides.filter(
          (override) => override.target_type !== targetType || override.target_id !== targetId
        ),
        nextOverride
      ];
    }
    this.ensureChannelPermissionTarget(targetType, targetId);
    this.markChannelPermissionsUnsynced();
  }

  async saveChannelPermissionChanges(): Promise<void> {
    if (!this.hooks.sessionToken() || !this.selectedPermissionChannelId || !this.hooks.canManageChannelPermissions()) return;
    const channelId = this.selectedPermissionChannelId;
    const saved = this.cloneChannelPermissionOverrides(this.channelPermissionOverrides);
    const draft = this.cloneChannelPermissionOverrides(this.channelPermissionDraftOverrides);
    const savedByTarget = new Map(saved.map((override) => [this.channelPermissionOverrideKey(override), override]));
    const draftByTarget = new Map(draft.map((override) => [this.channelPermissionOverrideKey(override), override]));
    try {
      for (const override of saved) {
        if (!draftByTarget.has(this.channelPermissionOverrideKey(override))) {
          await deleteChannelPermissionOverride(this.hooks.baseUrl(), this.hooks.sessionToken(), channelId, override.override_id);
        }
      }
      for (const override of draft) {
        const previous = savedByTarget.get(this.channelPermissionOverrideKey(override));
        if (previous && this.sameChannelPermissionOverrideValues(override, previous)) continue;
        await setChannelPermissionOverride(this.hooks.baseUrl(), this.hooks.sessionToken(), channelId, {
          override_id: previous?.override_id || override.override_id || undefined,
          target_type: override.target_type,
          target_id: override.target_id,
          allows: override.allows,
          denies: override.denies
        });
      }
      const refreshed = this.cloneChannelPermissionOverrides(
        await getChannelPermissionOverrides(this.hooks.baseUrl(), this.hooks.sessionToken(), channelId)
      );
      if (this.selectedPermissionChannelId !== channelId) return;
      this.channelPermissionOverrides = refreshed;
      this.channelPermissionDraftOverrides = this.cloneChannelPermissionOverrides(refreshed);
      this.channelPermissionLoadedChannelId = channelId;
      this.rebuildChannelPermissionTargets();
    } catch (caught) {
      try {
        const refreshed = this.cloneChannelPermissionOverrides(
          await getChannelPermissionOverrides(this.hooks.baseUrl(), this.hooks.sessionToken(), channelId)
        );
        if (this.selectedPermissionChannelId === channelId) this.channelPermissionOverrides = refreshed;
      } catch {
        // Preserve the local draft so the user can retry after a transient failure.
      }
      throw caught;
    }
  }

  // ---- member management & identity linking -----------------------------------

  memberById(memberId: string): Member | undefined {
    return this.hooks.memberById(memberId);
  }

  memberDisplayName(memberId: string): string {
    return this.memberById(memberId)?.display_name ?? memberId;
  }

  memberInitials(memberId: string): string {
    return this.memberDisplayName(memberId).slice(0, 2).toUpperCase();
  }

  memberAvatarDataURL(memberId: string): string {
    return this.memberById(memberId)?.avatar_data_url ?? "";
  }

  memberAvatarStyle(memberId: string): string {
    const member = this.memberById(memberId);
    const localProfile = this.hooks.localUserProfile();
    const isCurrentUser = memberId === this.hooks.memberId() || memberId === localProfile.local_profile_id;
    const color = member?.avatar_color ?? (isCurrentUser ? localProfile.avatar_color : "");
    return avatarStyleVariables(color, memberId || localProfile.local_profile_id);
  }

  channelAllowsPermission(
    channel: Channel | undefined,
    permission: Permission,
    owner: boolean,
    member: Member | undefined,
    availableRoles: ServerRole[],
    previewRoleId: string
  ): boolean {
    if (!channel) return false;
    if (!previewRoleId) {
      if (owner || member?.is_owner) return true;
      const effective = channel.effective_permissions?.[permission];
      if (typeof effective === "boolean") return effective;
    }
    return hasEffectivePermission(permission, owner, member, availableRoles, previewRoleId);
  }

  filteredAssignableRolesForMemberMenu(): ServerRole[] {
    const query = this.memberRoleMenuSearch.trim().toLocaleLowerCase();
    return this.assignableRoles().filter((role) => !query || role.name.toLocaleLowerCase().includes(query));
  }

  toggleMemberRoleMenu(memberIdValue: string): void {
    this.memberRoleMenuId = this.memberRoleMenuId === memberIdValue ? "" : memberIdValue;
    this.memberRoleMenuSearch = "";
    this.identityMemberPickerOpen = null;
    this.hooks.flushAliases();
  }

  memberAssignedRoleLabel(member: Member): string {
    const assigned = this.assignableRoles().filter((role) => member.role_ids.includes(role.role_id));
    if (assigned.length === 0) return this.hooks.translate("roles.noRoles");
    if (assigned.length === 1) return assigned[0].name;
    return this.hooks.translate("roles.assignedCount", { count: assigned.length });
  }

  async setMemberRoleAssignment(member: Member, roleId: string, enabled: boolean): Promise<void> {
    if (!this.hooks.sessionToken() || !this.hooks.canManageRoles() || member.is_owner) return;
    const existing = new Set(member.role_ids ?? []);
    if (enabled) existing.add(roleId);
    else existing.delete(roleId);
    const previous = member.role_ids ?? [];
    const next = Array.from(existing);
    this.hooks.mergeMember({ ...member, role_ids: next });
    this.roleMemberUpdatingId = member.member_id;
    this.hooks.flushAliases();
    try {
      const updated = await replaceMemberRoles(this.hooks.baseUrl(), this.hooks.sessionToken(), member.member_id, next);
      this.hooks.mergeMember(updated);
    } catch (caught) {
      this.hooks.mergeMember({ ...member, role_ids: previous });
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.memberUpdateFailed"));
    } finally {
      this.roleMemberUpdatingId = "";
      this.hooks.flushAliases();
    }
  }

  toggleIdentityMemberPicker(kind: "primary" | "duplicate"): void {
    this.identityMemberPickerOpen = this.identityMemberPickerOpen === kind ? null : kind;
    this.identityMemberPickerSearch = "";
    this.memberRoleMenuId = "";
    this.hooks.flushAliases();
  }

  filteredIdentityPickerMembers(kind: "primary" | "duplicate"): Member[] {
    const query = this.identityMemberPickerSearch.trim().toLocaleLowerCase();
    return this.hooks.members().filter((member) => {
      if (kind === "duplicate" && member.member_id === this.identityLinkPrimaryMemberId) return false;
      if (kind === "primary" && member.member_id === this.identityLinkDuplicateMemberId) return false;
      if (!query) return true;
      return member.display_name.toLocaleLowerCase().includes(query) || member.member_id.toLocaleLowerCase().includes(query);
    });
  }

  selectIdentityMember(kind: "primary" | "duplicate", selectedMemberId: string): void {
    if (kind === "primary") {
      this.identityLinkPrimaryMemberId = selectedMemberId;
      if (this.identityLinkDuplicateMemberId === selectedMemberId) this.identityLinkDuplicateMemberId = "";
    } else {
      this.identityLinkDuplicateMemberId = selectedMemberId === this.identityLinkPrimaryMemberId ? "" : selectedMemberId;
    }
    this.identityMemberPickerOpen = null;
    this.identityMemberPickerSearch = "";
    this.hooks.flushAliases();
  }

  selectedIdentityMemberName(kind: "primary" | "duplicate"): string {
    const selectedId = kind === "primary" ? this.identityLinkPrimaryMemberId : this.identityLinkDuplicateMemberId;
    return this.memberById(selectedId)?.display_name ?? this.hooks.translate("members.selectMember");
  }

  async linkSelectedMemberIdentities(): Promise<void> {
    if (
      !this.hooks.sessionToken() ||
      !this.hooks.canManageMembers() ||
      this.identityLinkBusy ||
      !this.identityLinkPrimaryMemberId ||
      !this.identityLinkDuplicateMemberId ||
      this.identityLinkPrimaryMemberId === this.identityLinkDuplicateMemberId
    ) return;
    const primary = this.memberById(this.identityLinkPrimaryMemberId);
    const duplicate = this.memberById(this.identityLinkDuplicateMemberId);
    if (!primary || !duplicate) return;
    if (!(await this.hooks.showAppConfirm(this.hooks.translate("members.linkConfirm", { primary: primary.display_name, duplicate: duplicate.display_name }), {
      title: this.hooks.translate("members.linkIdentity"),
      confirmLabel: this.hooks.translate("members.linkIdentity"),
      danger: true
    }))) return;
    this.identityLinkBusy = true;
    this.hooks.setError("");
    try {
      const linked = await linkMemberIdentity(this.hooks.baseUrl(), this.hooks.sessionToken(), primary.member_id, duplicate.member_id);
      this.hooks.setMembers(this.hooks.members().filter((member) => member.member_id !== duplicate.member_id));
      this.hooks.mergeMember(linked);
      this.identityLinkPrimaryMemberId = "";
      this.identityLinkDuplicateMemberId = "";
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("members.linkFailed"));
    } finally {
      this.identityLinkBusy = false;
    }
  }

  beginEditMember(member: Member): void {
    this.memberEditingId = member.member_id;
    this.memberBanDraft = Boolean(member.is_banned);
    this.hooks.setError("");
    this.hooks.flushAliases();
  }

  cancelEditMember(): void {
    this.memberEditingId = "";
    this.memberBanDraft = false;
    this.hooks.flushAliases();
  }

  async saveMemberChanges(member: Member): Promise<void> {
    if (!this.hooks.sessionToken() || !this.hooks.canManageMembers() || this.memberUpdating) return;
    this.memberUpdating = true;
    this.hooks.setError("");
    try {
      const updated = await updateMember(this.hooks.baseUrl(), this.hooks.sessionToken(), member.member_id, {
        is_banned: this.memberBanDraft
      });
      this.hooks.mergeMember(updated);
      this.cancelEditMember();
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.memberUpdateFailed"));
    } finally {
      this.memberUpdating = false;
    }
  }

  async removeManagedMember(member: Member): Promise<void> {
    if (!this.hooks.sessionToken() || !this.hooks.canManageMembers() || this.memberUpdating) return;
    if (!(await this.hooks.showAppConfirm(this.hooks.translate("members.removeConfirm", { name: member.display_name }), {
      title: this.hooks.translate("members.remove"),
      confirmLabel: this.hooks.translate("members.remove"),
      danger: true
    }))) return;
    this.memberUpdating = true;
    this.hooks.setError("");
    try {
      const removed = await deleteMember(this.hooks.baseUrl(), this.hooks.sessionToken(), member.member_id);
      this.hooks.removeMember(removed);
      this.cancelEditMember();
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.memberUpdateFailed"));
    } finally {
      this.memberUpdating = false;
    }
  }
}
