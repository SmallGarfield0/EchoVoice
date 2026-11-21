<script lang="ts">
  import NumericInput from "./NumericInput.svelte";
  import { emojiAlias } from "../lib/emoji";
  import type { EmojiController } from "../lib/emoji.svelte";
  import { hasEffectivePermission } from "../lib/permissions";
  import type { PermissionsController } from "../lib/permissions.svelte";
  import { serverFeatures } from "../lib/server-settings.svelte";
  import type { ServerSettingsController } from "../lib/server-settings.svelte";
  import { formatSoundboardPosition } from "../lib/soundboard";
  import type { SoundboardController } from "../lib/soundboard.svelte";
  import type {
    AuditLog,
    Channel,
    Member,
    Permission,
    ServerRole,
    ServerSummary
  } from "../lib/types";

  type Translate = (key: string, values?: Record<string, string | number>) => string;
  type LanguageOption = { id: string; name: string };
  type IdentityMemberPicker = "primary" | "duplicate";
  type SettingsSelectMenu =
    | "language"
    | "audio-input"
    | "audio-output"
    | "noise-suppression"
    | "server-language"
    | "server-preview-language"
    | "channel-default-language"
    | "channel-localization-language";

  type Props = {
    t: Translate;
    serverSettings: ServerSettingsController;
    permissions: PermissionsController;
    emoji: EmojiController;
    soundboard: SoundboardController;
    server: ServerSummary | null;
    baseUrl: string;
    members: Member[];
    channels: Channel[];
    memberId: string;
    isOwner: boolean;
    currentMember: Member | undefined;
    currentUserDisplayNameValue: string;
    canEditServerSettings: boolean;
    canManageRoles: boolean;
    canManageMembers: boolean;
    canManageServerEmoji: boolean;
    canManageServerSoundboard: boolean;
    serverSettingsDirty: boolean;
    roleSettingsDirty: boolean;
    settingsDirty: boolean;
    error: string;
    settingsSelectMenuOpen: SettingsSelectMenu | null;
    onToggleSettingsSelectMenu: (menu: SettingsSelectMenu) => void;
    languageOptions: () => LanguageOption[];
    serverInitials: (name: string) => string;
    formatFileSize: (bytes: number) => string;
    memberDisplayName: (memberIdValue: string) => string;
    memberAvatarStyle: (memberIdValue: string) => string;
    memberRoleLabel: (member: Member) => string;
    serverEmojiEditingShortcode: string;
    onServerEmojiEditingShortcodeChange: (value: string) => void;
    auditTargetLabel: (log: AuditLog) => string;
    auditActionLabel: (action: string) => string;
    auditDetails: (log: AuditLog) => string;
    identityLinkPrimaryMemberId: string;
    identityLinkDuplicateMemberId: string;
    identityLinkBusy: boolean;
    identityMemberPickerOpen: IdentityMemberPicker | null;
    identityMemberPickerSearch: string;
    onIdentityMemberPickerSearchChange: (value: string) => void;
    onToggleIdentityMemberPicker: (kind: IdentityMemberPicker) => void;
    filteredIdentityPickerMembers: (kind: IdentityMemberPicker) => Member[];
    selectedIdentityMemberName: (kind: IdentityMemberPicker) => string;
    onSelectIdentityMember: (kind: IdentityMemberPicker, memberIdValue: string) => void;
    onLinkSelectedMemberIdentities: () => void;
    memberRoleMenuId: string;
    memberRoleMenuSearch: string;
    onMemberRoleMenuSearchChange: (value: string) => void;
    onToggleMemberRoleMenu: (memberIdValue: string) => void;
    memberAssignedRoleLabel: (member: Member) => string;
    filteredAssignableRolesForMemberMenu: () => ServerRole[];
    onSetMemberRoleAssignment: (member: Member, roleId: string, enabled: boolean) => void;
    memberEditingId: string;
    memberBanDraft: boolean;
    onMemberBanDraftChange: (value: boolean) => void;
    memberUpdating: boolean;
    onBeginEditMember: (member: Member) => void;
    onCancelEditMember: () => void;
    onSaveMemberChanges: (member: Member) => void;
    onRemoveManagedMember: (member: Member) => void;
    setRoleIconInputElement: (element: HTMLInputElement | null) => void;
    setServerEmojiManagerInputElement: (element: HTMLInputElement | null) => void;
    setServerSoundboardManagerInputElement: (element: HTMLInputElement | null) => void;
    onFlushAliases: () => void;
    onClearError: () => void;
  };

  let {
    t,
    serverSettings,
    permissions,
    emoji,
    soundboard,
    server,
    baseUrl,
    members,
    channels,
    memberId,
    isOwner,
    currentMember,
    currentUserDisplayNameValue,
    canEditServerSettings,
    canManageRoles,
    canManageMembers,
    canManageServerEmoji,
    canManageServerSoundboard,
    serverSettingsDirty,
    roleSettingsDirty,
    settingsDirty,
    error,
    settingsSelectMenuOpen,
    onToggleSettingsSelectMenu,
    languageOptions,
    serverInitials,
    formatFileSize,
    memberDisplayName,
    memberAvatarStyle,
    memberRoleLabel,
    serverEmojiEditingShortcode,
    onServerEmojiEditingShortcodeChange,
    auditTargetLabel,
    auditActionLabel,
    auditDetails,
    identityLinkPrimaryMemberId,
    identityLinkDuplicateMemberId,
    identityLinkBusy,
    identityMemberPickerOpen,
    identityMemberPickerSearch,
    onIdentityMemberPickerSearchChange,
    onToggleIdentityMemberPicker,
    filteredIdentityPickerMembers,
    selectedIdentityMemberName,
    onSelectIdentityMember,
    onLinkSelectedMemberIdentities,
    memberRoleMenuId,
    memberRoleMenuSearch,
    onMemberRoleMenuSearchChange,
    onToggleMemberRoleMenu,
    memberAssignedRoleLabel,
    filteredAssignableRolesForMemberMenu,
    onSetMemberRoleAssignment,
    memberEditingId,
    memberBanDraft,
    onMemberBanDraftChange,
    memberUpdating,
    onBeginEditMember,
    onCancelEditMember,
    onSaveMemberChanges,
    onRemoveManagedMember,
    setRoleIconInputElement,
    setServerEmojiManagerInputElement,
    setServerSoundboardManagerInputElement,
    onFlushAliases,
    onClearError
  }: Props = $props();

  let serverIconInput = $state<HTMLInputElement | null>(null);
  let roleIconInput = $state<HTMLInputElement | null>(null);
  let serverEmojiManagerInput = $state<HTMLInputElement | null>(null);
  let serverSoundboardManagerInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    setRoleIconInputElement(roleIconInput);
    return () => setRoleIconInputElement(null);
  });
  $effect(() => {
    setServerEmojiManagerInputElement(serverEmojiManagerInput);
    return () => setServerEmojiManagerInputElement(null);
  });
  $effect(() => {
    setServerSoundboardManagerInputElement(serverSoundboardManagerInput);
    return () => setServerSoundboardManagerInputElement(null);
  });

  let serverEmojiUploadError = $derived(emoji.uploadErrorFor(emoji.serverUploadID, emoji.customEmojis));

  function flush() {
    onFlushAliases();
  }

  function closeDialog() {
    serverSettings.closeServerSettings();
    flush();
  }

  function selectTab(tab: Parameters<ServerSettingsController["selectServerSettingsTab"]>[0]) {
    serverSettings.selectServerSettingsTab(tab);
    flush();
  }

  function permissionLabel(permission: Permission) {
    return t(`permission.${permission}`);
  }

  function permissionDescription(permission: Permission) {
    return t(`permissionDescription.${permission}`);
  }

  function canPreviewRole() {
    return isOwner || hasEffectivePermission("administrator", false, currentMember, permissions.roles);
  }

  function resetSettingsChanges() {
    if (serverSettingsDirty) {
      if (server) serverSettings.serverDraft = { ...server };
      onClearError();
      flush();
    }
    if (roleSettingsDirty) {
      permissions.resetRoleSettings();
      flush();
    }
  }

  async function saveSettingsChanges() {
    if (serverSettingsDirty) {
      await serverSettings.submitServerSettings();
      flush();
    }
    if (roleSettingsDirty) {
      await permissions.submitRoleSettings();
      flush();
    }
  }
</script>

{#if serverSettings.serverSettingsOpen}
<div class="settings-page" role="dialog" aria-modal="true" aria-label={t("settings.title")}>
  <header class="settings-page-header">
    <div>
      <p class="eyebrow">{server?.name ?? "EchoVoice"}</p>
      <h1>{t("settings.title")}</h1>
    </div>
    <button class="settings-close-button" type="button" title={t("app.close")} onclick={closeDialog}>
      <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
    </button>
  </header>

  <div class="settings-layout settings-page-body">
    <nav class="settings-nav" aria-label={t("settings.title")}>
      <button type="button" class:active={serverSettings.serverSettingsTab === "overview"} onclick={() => selectTab("overview")}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">tune</span>
        <span>{t("settings.tabOverview")}</span>
      </button>
      {#if canManageServerEmoji}
        <button type="button" class:active={serverSettings.serverSettingsTab === "emoji"} onclick={() => selectTab("emoji")}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">add_reaction</span>
          <span>{t("settings.tabEmoji")}</span>
        </button>
      {/if}
      {#if canManageServerSoundboard}
        <button type="button" class:active={serverSettings.serverSettingsTab === "soundboard"} onclick={() => selectTab("soundboard")}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">graphic_eq</span>
          <span>{t("settings.tabSoundboard")}</span>
        </button>
      {/if}
      <button type="button" class:active={serverSettings.serverSettingsTab === "roles"} onclick={() => selectTab("roles")}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">badge</span>
        <span>{t("settings.tabRoles")}</span>
      </button>
      <button type="button" class:active={serverSettings.serverSettingsTab === "members"} onclick={() => selectTab("members")}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">groups</span>
        <span>{t("settings.tabMembers")}</span>
      </button>
      <button type="button" class:active={serverSettings.serverSettingsTab === "audit"} onclick={() => selectTab("audit")}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">receipt_long</span>
        <span>{t("settings.tabAudit")}</span>
      </button>
    </nav>

    <form
      class="settings-panel"
      onsubmit={(event) => {
        event.preventDefault();
        void serverSettings.submitServerSettings();
        flush();
      }}
    >
      {#if serverSettings.serverSettingsTab === "overview"}
        <section class="settings-section">
          <p class="section-label">{t("settings.serverInfo")}</p>
          <div class="server-info-grid">
            <div>
              <span>{t("settings.serverId")}</span>
              <strong>{server?.server_id ?? "-"}</strong>
            </div>
            <div>
              <span>{t("settings.connection")}</span>
              <strong>{baseUrl}</strong>
            </div>
            <div>
              <span>{t("settings.memberCount")}</span>
              <strong>{members.length}</strong>
            </div>
            <div>
              <span>{t("settings.channelCount")}</span>
              <strong>{channels.length}</strong>
            </div>
          </div>
        </section>

        <section class="settings-section server-profile-settings">
          <p class="section-label">{t("settings.serverProfile")}</p>
          <div class="server-profile-editor">
            <div class="server-icon-editor">
              <div class="server-icon-preview">
                {#if serverSettings.serverDraft?.icon_data_url}
                  <img src={serverSettings.serverDraft.icon_data_url} alt="" />
                {:else}
                  <span>{serverInitials(serverSettings.serverDraft?.name ?? "EchoVoice")}</span>
                {/if}
              </div>
              <input
                bind:this={serverIconInput}
                class="visually-hidden"
                type="file"
                accept="image/*"
                disabled={!canEditServerSettings || !serverSettings.serverDraft}
                onchange={(event) => {
                  void serverSettings.selectServerIcon(event);
                  flush();
                }}
              />
              <div class="server-icon-actions">
                <button type="button" disabled={!canEditServerSettings || !serverSettings.serverDraft} onclick={() => serverIconInput?.click()}>{t("settings.changeServerIcon")}</button>
                <button type="button" disabled={!canEditServerSettings || !serverSettings.serverDraft?.icon_data_url} onclick={() => {
                  serverSettings.clearServerIcon();
                  flush();
                }}>{t("profile.removeAvatar")}</button>
              </div>
            </div>
            <div class="server-profile-fields">
              <label>
                {t("settings.serverName")}
                <input maxlength="64" value={serverSettings.serverDraft?.name ?? ""} disabled={!canEditServerSettings || !serverSettings.serverDraft} oninput={(event) => {
                  serverSettings.setServerName(event);
                  flush();
                }} />
              </label>
              <label>
                {t("settings.serverDescription")}
                <textarea maxlength="500" rows="5" value={serverSettings.serverDraft?.description ?? ""} disabled={!canEditServerSettings || !serverSettings.serverDraft} oninput={(event) => {
                  serverSettings.setServerDescription(event);
                  flush();
                }}></textarea>
                <small>{serverSettings.serverDraft?.description?.length ?? 0} / 500</small>
              </label>
            </div>
          </div>
          {#if !canEditServerSettings}
            <p class="status">{t("settings.ownerOnly")}</p>
          {/if}
        </section>

        <section class="settings-section server-access-settings">
          <p class="section-label">{t("settings.serverAccessAndLanguage")}</p>
          <div class="server-visibility-options" role="group" aria-label={t("settings.serverVisibility")}>
            <button type="button" class:active={serverSettings.serverDraft?.visibility === "public"} disabled={!canEditServerSettings || !serverSettings.serverDraft} onclick={() => {
              serverSettings.setServerVisibility("public");
              flush();
            }}>
              <span class="material-symbols-rounded app-icon" aria-hidden="true">public</span>
              <span><strong>{t("settings.serverPublic")}</strong><small>{t("settings.serverPublicDescription")}</small></span>
            </button>
            <button type="button" class:active={serverSettings.serverDraft?.visibility === "private"} disabled={!canEditServerSettings || !serverSettings.serverDraft} onclick={() => {
              serverSettings.setServerVisibility("private");
              flush();
            }}>
              <span class="material-symbols-rounded app-icon" aria-hidden="true">lock</span>
              <span><strong>{t("settings.serverPrivate")}</strong><small>{t("settings.serverPrivateDescription")}</small></span>
            </button>
          </div>
          <div class="server-language-settings-grid">
            <label class="settings-select-field">
              <span>{t("settings.serverDefaultLanguage")}</span>
              <div class="settings-custom-select" class:open={settingsSelectMenuOpen === "server-language"}>
                <button class="settings-select-trigger" type="button" disabled={!canEditServerSettings || !serverSettings.serverDraft} aria-haspopup="listbox" aria-expanded={settingsSelectMenuOpen === "server-language"} onclick={() => onToggleSettingsSelectMenu("server-language")}>
                  <span>{languageOptions().find((option) => option.id === serverSettings.serverDraft?.default_language)?.name ?? serverSettings.serverDraft?.default_language ?? "-"}</span>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">expand_more</span>
                </button>
                {#if settingsSelectMenuOpen === "server-language"}
                  <div class="settings-select-options" role="listbox" aria-label={t("settings.serverDefaultLanguage")}>
                    {#each languageOptions() as language}
                      <button type="button" role="option" class:active={serverSettings.serverDraft?.default_language === language.id} aria-selected={serverSettings.serverDraft?.default_language === language.id} onclick={() => {
                        serverSettings.setServerDefaultLanguage(language.id);
                        flush();
                      }}>
                        <span>{language.name}</span>
                        {#if serverSettings.serverDraft?.default_language === language.id}<span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>{/if}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            </label>
            <label class="settings-select-field">
              <span>{t("settings.previewServerLanguage")}</span>
              <div class="settings-custom-select" class:open={settingsSelectMenuOpen === "server-preview-language"}>
                <button class="settings-select-trigger" type="button" aria-haspopup="listbox" aria-expanded={settingsSelectMenuOpen === "server-preview-language"} onclick={() => onToggleSettingsSelectMenu("server-preview-language")}>
                  <span>{serverSettings.serverPreviewLanguageId ? languageOptions().find((option) => option.id === serverSettings.serverPreviewLanguageId)?.name ?? serverSettings.serverPreviewLanguageId : t("settings.followAppLanguage")}</span>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">expand_more</span>
                </button>
                {#if settingsSelectMenuOpen === "server-preview-language"}
                  <div class="settings-select-options" role="listbox" aria-label={t("settings.previewServerLanguage")}>
                    <button type="button" role="option" class:active={!serverSettings.serverPreviewLanguageId} aria-selected={!serverSettings.serverPreviewLanguageId} onclick={() => {
                      serverSettings.setServerPreviewLanguage("");
                      flush();
                    }}>
                      <span>{t("settings.followAppLanguage")}</span>
                      {#if !serverSettings.serverPreviewLanguageId}<span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>{/if}
                    </button>
                    {#each languageOptions() as language}
                      <button type="button" role="option" class:active={serverSettings.serverPreviewLanguageId === language.id} aria-selected={serverSettings.serverPreviewLanguageId === language.id} onclick={() => {
                        serverSettings.setServerPreviewLanguage(language.id);
                        flush();
                      }}>
                        <span>{language.name}</span>
                        {#if serverSettings.serverPreviewLanguageId === language.id}<span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>{/if}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            </label>
          </div>
        </section>

        <section class="settings-section">
          <p class="section-label">{t("settings.featureFlags")}</p>
          <div class="feature-grid">
            {#each serverFeatures as feature}
              <label class="server-feature-row">
                <span class="server-feature-icon material-symbols-rounded app-icon" aria-hidden="true">{feature.icon}</span>
                <span class="server-feature-copy">
                  <strong>{t(feature.labelKey)}</strong>
                  <small>{t(feature.descriptionKey)}</small>
                </span>
                <input
                  type="checkbox"
                  checked={Boolean(serverSettings.serverDraft?.[feature.key])}
                  disabled={!canEditServerSettings || !serverSettings.serverDraft}
                  onchange={(event) => {
                    serverSettings.setServerFeature(feature.key, event);
                    flush();
                  }}
                />
                <span class="switch-track" aria-hidden="true"><span></span></span>
              </label>
              {#if feature.key === "emoji_enabled" && serverSettings.serverDraft?.emoji_enabled}
                <label class="server-feature-limit-row">
                  <span>
                    <strong>{t("settings.emojiMaxSize")}</strong>
                    <small>{t("settings.emojiMaxSizeDescription")}</small>
                  </span>
                  <NumericInput
                    value={serverSettings.serverDraft.emoji_max_kb || 1024}
                    min={1}
                    max={8192}
                    step={1}
                    unit="KB"
                    disabled={!canEditServerSettings}
                    ariaLabel={t("settings.emojiMaxSize")}
                    decreaseLabel={t("app.decreaseValue", { name: t("settings.emojiMaxSize") })}
                    increaseLabel={t("app.increaseValue", { name: t("settings.emojiMaxSize") })}
                    onValueChange={(value) => {
                      serverSettings.setServerEmojiMaxKB(value);
                      flush();
                    }}
                  />
                </label>
              {/if}
            {/each}
          </div>
        </section>
      {:else if serverSettings.serverSettingsTab === "emoji"}
        <section class="settings-section wide-section server-emoji-manager" data-server-emoji-manager>
          <div class="settings-section-heading">
            <div>
              <p class="section-label">{t("emoji.manageTitle")}</p>
              <p class="status">{t("emoji.manageDescription")}</p>
            </div>
            <span class="server-emoji-count">{t("emoji.count", { count: emoji.customEmojis.length })}</span>
          </div>

          {#if !server?.emoji_enabled}
            <div class="server-emoji-disabled-state">
              <span class="material-symbols-rounded app-icon" aria-hidden="true">toggle_off</span>
              <div>
                <strong>{t("emoji.disabled")}</strong>
                <small>{t("emoji.enableBeforeManage")}</small>
              </div>
              <button type="button" onclick={() => selectTab("overview")}>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">tune</span>
                <span>{t("settings.tabOverview")}</span>
              </button>
            </div>
          {:else}
            <div class="server-emoji-upload-panel">
              <div class="server-emoji-upload-preview" class:empty={!emoji.serverUploadPreviewURL}>
                {#if emoji.serverUploadPreviewURL}
                  <img src={emoji.serverUploadPreviewURL} alt={emoji.serverUploadID ? emojiAlias(emoji.serverUploadID) : t("emoji.uploadPreview")} />
                {:else}
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">add_photo_alternate</span>
                  <small>{t("emoji.uploadPreview")}</small>
                {/if}
              </div>
              <div class="server-emoji-upload-fields">
                <div class="server-emoji-upload-heading">
                  <div>
                    <strong>{t("emoji.uploadServer")}</strong>
                    <small>{t("emoji.uploadDescription")}</small>
                  </div>
                  <input bind:this={serverEmojiManagerInput} class="visually-hidden" type="file" accept="image/png,image/jpeg,image/gif,image/webp" onchange={(event) => emoji.selectServerUploadFile(event)} />
                  <button type="button" disabled={Boolean(emoji.actionBusyId)} onclick={() => serverEmojiManagerInput?.click()}>
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">folder_open</span>
                    <span>{emoji.serverUploadFile ? t("emoji.changeFile") : t("emoji.chooseFile")}</span>
                  </button>
                </div>
                <label class="server-emoji-id-field">
                  <span>{t("emoji.idLabel")}</span>
                  <div>
                    <span aria-hidden="true">:</span>
                    <input
                      maxlength="12"
                      autocomplete="off"
                      spellcheck="false"
                      value={emoji.serverUploadID}
                      disabled={Boolean(emoji.actionBusyId)}
                      aria-invalid={Boolean(emoji.serverUploadID && serverEmojiUploadError)}
                      placeholder="echo_wave"
                      oninput={(event) => emoji.setServerUploadID(event)}
                    />
                    <span aria-hidden="true">:</span>
                  </div>
                  <small>{t("emoji.idRules")}</small>
                </label>
                {#if emoji.serverUploadID && serverEmojiUploadError}
                  <p class="server-emoji-field-error" role="status">{serverEmojiUploadError}</p>
                {/if}
                {#if emoji.serverUploadFile}
                  <div class="server-emoji-selected-file">
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">draft</span>
                    <span>{emoji.serverUploadFile.name}</span>
                    <small>{formatFileSize(emoji.serverUploadFile.size)}</small>
                  </div>
                {/if}
                <div class="server-emoji-upload-actions">
                  {#if emoji.serverUploadFile}
                    <button type="button" disabled={Boolean(emoji.actionBusyId)} onclick={() => emoji.clearServerUpload()}>{t("common.cancel")}</button>
                  {/if}
                  <button
                    class="primary"
                    type="button"
                    disabled={!emoji.serverUploadFile || Boolean(serverEmojiUploadError) || Boolean(emoji.actionBusyId)}
                    onclick={() => void emoji.submitServerUpload()}
                  >
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">upload</span>
                    <span>{emoji.actionBusyId === "server-upload" ? t("emoji.uploading") : t("emoji.uploadServer")}</span>
                  </button>
                </div>
              </div>
            </div>

            {#if emoji.managementError}
              <p class="server-emoji-management-error" role="alert">{emoji.managementError}</p>
            {/if}

            <div class="server-emoji-list" aria-label={t("emoji.manageTitle")}>
              {#if emoji.customEmojis.length === 0}
                <div class="server-emoji-list-empty">
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">add_reaction</span>
                  <span>{t("emoji.serverEmpty")}</span>
                </div>
              {:else}
                {#each emoji.customEmojis as serverEmoji (serverEmoji.emoji_id)}
                  <article class="server-emoji-row">
                    <span class="server-emoji-row-preview">
                      {#if emoji.objectURL(serverEmoji.asset_sha256)}
                        <img src={emoji.objectURL(serverEmoji.asset_sha256)} alt={emojiAlias(serverEmoji.shortcode)} />
                      {:else}
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">hourglass_empty</span>
                      {/if}
                    </span>
                    {#if emoji.editingID === serverEmoji.emoji_id}
                      <label class="server-emoji-inline-editor">
                        <span>{t("emoji.idLabel")}</span>
                        <span class="server-emoji-inline-input"><i aria-hidden="true">:</i><input maxlength="12" autocomplete="off" spellcheck="false" value={serverEmojiEditingShortcode} oninput={(event) => onServerEmojiEditingShortcodeChange((event.currentTarget as HTMLInputElement).value)} aria-label={t("emoji.idLabel")} /><i aria-hidden="true">:</i></span>
                      </label>
                      <span class="server-emoji-row-actions editing">
                        <button class="server-emoji-cancel" type="button" disabled={Boolean(emoji.actionBusyId)} data-tooltip={t("common.cancel")} aria-label={t("common.cancel")} onclick={() => emoji.cancelServerEdit()}>
                          <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
                        </button>
                        <button class="server-emoji-save" type="button" disabled={Boolean(emoji.actionBusyId)} data-tooltip={t("common.save")} aria-label={t("common.save")} onclick={() => void emoji.saveServerEdit(serverEmoji)}>
                          <span class="material-symbols-rounded app-icon" aria-hidden="true">save</span>
                        </button>
                      </span>
                    {:else}
                      <span class="server-emoji-row-copy">
                        <strong>{emojiAlias(serverEmoji.shortcode)}</strong>
                        <small>{t("emoji.uploadedBy", { name: memberDisplayName(serverEmoji.uploader_member_id) })} · {formatFileSize(serverEmoji.size_bytes)}{serverEmoji.is_gif ? " · GIF" : ""}</small>
                      </span>
                      <span class="server-emoji-row-actions">
                        <button class="server-emoji-edit" type="button" disabled={Boolean(emoji.actionBusyId)} data-tooltip={t("emoji.edit")} aria-label={t("emoji.edit")} onclick={() => emoji.startServerEdit(serverEmoji)}>
                          <span class="material-symbols-rounded app-icon" aria-hidden="true">edit</span>
                        </button>
                        <button class="server-emoji-delete" type="button" disabled={Boolean(emoji.actionBusyId)} data-tooltip={t("emoji.delete")} aria-label={t("emoji.delete")} onclick={() => void emoji.deleteServerItem(serverEmoji)}>
                          <span class="material-symbols-rounded app-icon" aria-hidden="true">delete</span>
                        </button>
                      </span>
                    {/if}
                  </article>
                {/each}
              {/if}
            </div>
          {/if}
        </section>
      {:else if serverSettings.serverSettingsTab === "soundboard"}
        <section class="settings-section wide-section server-soundboard-manager" data-server-soundboard-manager>
          <div class="settings-section-heading">
            <div>
              <p class="section-label">{t("soundboard.manageTitle")}</p>
              <p class="status">{t("soundboard.manageDescription")}</p>
            </div>
            <span class="server-emoji-count">{t("soundboard.soundCount", { count: soundboard.items.length })}</span>
          </div>

          {#if !server?.soundboard_enabled}
            <div class="server-emoji-disabled-state">
              <span class="material-symbols-rounded app-icon" aria-hidden="true">toggle_off</span>
              <div>
                <strong>{t("soundboard.disabled")}</strong>
                <small>{t("soundboard.enableBeforeManage")}</small>
              </div>
              <button type="button" onclick={() => selectTab("overview")}>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">tune</span>
                <span>{t("settings.tabOverview")}</span>
              </button>
            </div>
          {:else}
            <input bind:this={serverSoundboardManagerInput} class="visually-hidden" type="file" accept="audio/*" onchange={(event) => {
              void soundboard.uploadServer(event);
              flush();
            }} />
            <div class="server-soundboard-toolbar">
              <span>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">library_music</span>
                <span><strong>{t("soundboard.serverTab")}</strong><small>{t("soundboard.serverDescription")}</small></span>
              </span>
              <button type="button" disabled={Boolean(soundboard.actionBusyId)} onclick={() => serverSoundboardManagerInput?.click()}>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">upload</span>
                <span>{soundboard.actionBusyId === "server-upload" ? t("soundboard.uploading") : t("soundboard.uploadServer")}</span>
              </button>
            </div>

            <div class="server-soundboard-list" aria-label={t("soundboard.manageTitle")}>
              {#if soundboard.items.length === 0}
                <div class="server-emoji-list-empty">
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">graphic_eq</span>
                  <span>{t("soundboard.serverEmpty")}</span>
                </div>
              {:else}
                {#each soundboard.items as item (item.item_id)}
                  <article class="server-soundboard-row">
                    <span class="server-soundboard-row-icon" aria-hidden="true">
                      {#if item.icon_asset_sha256 && emoji.objectURL(item.icon_asset_sha256)}
                        <img src={emoji.objectURL(item.icon_asset_sha256)} alt="" />
                      {:else if item.icon_emoji}
                        <span>{item.icon_emoji}</span>
                      {:else}
                        <span class="material-symbols-rounded app-icon">graphic_eq</span>
                      {/if}
                    </span>
                    <span class="server-emoji-row-copy">
                      <strong>{item.name}</strong>
                      <small>{formatFileSize(item.size_bytes)} · {item.end_ms ? `${formatSoundboardPosition(item.start_ms)}–${formatSoundboardPosition(item.end_ms)}` : t("soundboard.fullAudio")}</small>
                    </span>
                    <span class="server-emoji-row-actions">
                      <button class="server-emoji-edit" type="button" disabled={Boolean(soundboard.actionBusyId)} data-tooltip={t("soundboard.edit")} aria-label={t("soundboard.edit")} onclick={() => {
                        soundboard.openEditor({ kind: "server", item });
                        flush();
                      }}>
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">edit</span>
                      </button>
                      <button class="server-emoji-delete" type="button" disabled={Boolean(soundboard.actionBusyId)} data-tooltip={t("soundboard.delete")} aria-label={t("soundboard.delete")} onclick={() => {
                        void soundboard.deleteServerItem(item);
                        flush();
                      }}>
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">delete</span>
                      </button>
                    </span>
                  </article>
                {/each}
              {/if}
            </div>
          {/if}
        </section>
      {:else if serverSettings.serverSettingsTab === "roles"}
        <section class="settings-section wide-section">
          <div class="settings-section-heading">
            <p class="section-label">{t("roles.title")}</p>
            <button type="button" disabled={!canManageRoles || permissions.roleCreating} onclick={() => {
              void permissions.createServerRole();
              flush();
            }}>
              <span class="material-symbols-rounded app-icon" aria-hidden="true">add</span>
              <span>{t("roles.create")}</span>
            </button>
          </div>
          <div class="role-editor">
            <nav class="role-list" aria-label={t("roles.title")}>
              {#each permissions.roles as role}
                <button
                  type="button"
                  class:active={permissions.selectedRoleId === role.role_id}
                  class:dragging={permissions.draggedRoleId === role.role_id}
                  class:drop-before={permissions.dragOverRoleId === role.role_id && permissions.roleDragPlacement === "before"}
                  class:drop-after={permissions.dragOverRoleId === role.role_id && permissions.roleDragPlacement === "after"}
                  draggable={canManageRoles && !role.is_everyone && !roleSettingsDirty}
                  onclick={() => {
                    permissions.selectRole(role.role_id);
                    flush();
                  }}
                  ondragstart={(event) => {
                    permissions.startRoleDrag(role, event);
                    flush();
                  }}
                  ondragover={(event) => {
                    event.preventDefault();
                    permissions.overRoleDropTarget(role, event);
                    flush();
                  }}
                  ondrop={(event) => {
                    event.preventDefault();
                    void permissions.dropRoleOn(role);
                    flush();
                  }}
                  ondragend={() => {
                    permissions.endRoleDrag();
                    flush();
                  }}
                >
                  <span class="role-color-dot" style={`--role-color: ${role.color || "#9bdcff"}`}></span>
                  {#if role.icon_data_url}<img class="role-list-icon" src={role.icon_data_url} alt="" />{/if}
                  <span class="role-list-name">{role.name}</span>
                  <span class="role-member-count">{permissions.roleMemberCount(role)}</span>
                </button>
              {/each}
            </nav>

            {#if permissions.roleDraft}
              <div class="role-detail">
                <header class="role-detail-header">
                  <div>
                    <div class="role-title-row">
                      {#if permissions.roleDraft.icon_data_url}
                        <img src={permissions.roleDraft.icon_data_url} alt="" />
                      {:else}
                        <span class="role-title-icon" style={`--role-color: ${permissions.roleDraft.color || "#9bdcff"}`}></span>
                      {/if}
                      <h2 style={permissions.roleTextStyle(permissions.roleDraft)}>{permissions.roleDraft.name}</h2>
                    </div>
                    <span>{permissions.roleDraft.is_everyone ? t("roles.everyoneHint") : t("roles.customHint")}</span>
                  </div>
                  <div class="role-header-actions">
                    {#if canPreviewRole()}
                      <button type="button" onclick={() => {
                        permissions.startRolePreview(permissions.roleDraft?.role_id ?? "");
                        flush();
                      }}>
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">visibility</span>
                        <span>{t("roles.viewAsRole")}</span>
                      </button>
                    {/if}
                    {#if !permissions.roleDraft.is_everyone}
                      <button class="danger-button" type="button" disabled={!canManageRoles || permissions.roleDeleting} onclick={() => {
                        void permissions.deleteSelectedRole();
                        flush();
                      }}>
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">delete</span>
                        <span>{t("roles.delete")}</span>
                      </button>
                    {/if}
                  </div>
                </header>

                <nav class="role-detail-tabs" aria-label={t("roles.title")}>
                  <button type="button" class:active={permissions.roleSettingsSection === "display"} onclick={() => (permissions.roleSettingsSection = "display")}>{t("roles.tabDisplay")}</button>
                  <button type="button" class:active={permissions.roleSettingsSection === "permissions"} onclick={() => (permissions.roleSettingsSection = "permissions")}>{t("roles.tabPermissions")}</button>
                  <button type="button" class:active={permissions.roleSettingsSection === "members"} onclick={() => (permissions.roleSettingsSection = "members")}>{t("roles.tabMembers")}</button>
                </nav>

                {#if permissions.roleSettingsSection === "display"}
                  <div class="role-display-settings">
                    <div class="role-fields">
                      <label>
                        {t("roles.name")}
                        <input maxlength="64" value={permissions.roleDraft.name} disabled={!canManageRoles || permissions.roleDraft.is_everyone} oninput={(event) => {
                        permissions.setRoleDraftName(event);
                        flush();
                      }} />
                      </label>
                      <label>
                        {t("roles.color")}
                        <input type="color" value={permissions.roleDraft.color || "#9bdcff"} disabled={!canManageRoles || permissions.roleDraft.is_everyone} oninput={(event) => {
                        permissions.setRoleDraftColor(event);
                        flush();
                      }} />
                      </label>
                    </div>

                    {#if !permissions.roleDraft.is_everyone}
                      <label class="permission-switch-row">
                        <span>
                          <strong>{t("roles.gradient")}</strong>
                          <small>{t("roles.gradientDescription")}</small>
                        </span>
                        <input type="checkbox" checked={Boolean(permissions.roleDraft.gradient_color)} disabled={!canManageRoles} onchange={(event) => {
                        permissions.setRoleDraftGradientEnabled(event);
                        flush();
                      }} />
                        <span class="switch-track" aria-hidden="true"><span></span></span>
                      </label>
                      {#if permissions.roleDraft.gradient_color}
                        <label class="role-gradient-color">
                          <span>{t("roles.gradientEndColor")}</span>
                          <input type="color" value={permissions.roleDraft.gradient_color} disabled={!canManageRoles} oninput={(event) => {
                          permissions.setRoleDraftGradientColor(event);
                          flush();
                        }} />
                        </label>
                      {/if}

                      <div class="role-icon-setting">
                        <div class="role-icon-preview" style={`--role-color: ${permissions.roleDraft.color || "#9bdcff"}`}>
                          {#if permissions.roleDraft.icon_data_url}<img src={permissions.roleDraft.icon_data_url} alt="" />{:else}<span class="material-symbols-rounded app-icon" aria-hidden="true">badge</span>{/if}
                        </div>
                        <div>
                          <strong>{t("roles.icon")}</strong>
                          <small>{t("roles.iconDescription")}</small>
                          <input bind:this={roleIconInput} class="visually-hidden" type="file" accept="image/*" onchange={(event) => {
                            void permissions.selectRoleIcon(event);
                            flush();
                          }} />
                          <div class="role-icon-actions">
                            <button type="button" disabled={!canManageRoles} onclick={() => roleIconInput?.click()}>{t("roles.changeIcon")}</button>
                            <button type="button" disabled={!canManageRoles || !permissions.roleDraft?.icon_data_url} onclick={() => {
                              permissions.clearRoleIcon();
                              flush();
                            }}>{t("profile.removeAvatar")}</button>
                          </div>
                        </div>
                      </div>

                      <label class="permission-switch-row">
                        <span>
                          <strong>{t("roles.displaySeparately")}</strong>
                          <small>{t("roles.displaySeparatelyDescription")}</small>
                        </span>
                        <input type="checkbox" checked={permissions.roleDraft.display_separately} disabled={!canManageRoles} onchange={(event) => {
                        permissions.setRoleDraftDisplaySeparately(event);
                        flush();
                      }} />
                        <span class="switch-track" aria-hidden="true"><span></span></span>
                      </label>
                    {/if}

                    <div class="role-preview-row">
                      <span>{t("roles.preview")}</span>
                      <strong style={permissions.roleTextStyle(permissions.roleDraft)}>{currentUserDisplayNameValue}</strong>
                    </div>
                  </div>
                {:else if permissions.roleSettingsSection === "permissions"}
                  <div class="role-permission-settings">
                    <label class="settings-search-field">
                      <span class="material-symbols-rounded app-icon" aria-hidden="true">search</span>
                      <input
                        value={permissions.rolePermissionSearch}
                        placeholder={t("roles.searchPermissions")}
                        oninput={(event) => (permissions.rolePermissionSearch = (event.currentTarget as HTMLInputElement).value)}
                      />
                    </label>
                    {#each permissions.filteredRolePermissionGroups() as group}
                      <section class="permission-group">
                        <p class="permission-group-label">{t(group.labelKey)}</p>
                        <div class="role-permission-list">
                          {#each group.permissions as permission}
                            <label class="permission-switch-row">
                              <span>
                                <strong>{permissionLabel(permission)}</strong>
                                <small>{permissionDescription(permission)}</small>
                              </span>
                              <input type="checkbox" checked={Boolean(permissions.roleDraft.permissions[permission])} disabled={!canManageRoles || permissions.roleUpdating} onchange={(event) => {
                              permissions.setRoleDraftPermission(permission, event);
                              flush();
                            }} />
                              <span class="switch-track" aria-hidden="true"><span></span></span>
                            </label>
                          {/each}
                        </div>
                      </section>
                    {/each}
                  </div>
                {:else}
                  <div class="role-member-settings">
                    <div class="role-member-heading">
                      <label class="settings-search-field">
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">search</span>
                        <input
                          value={permissions.roleMemberSearch}
                          placeholder={t("roles.searchMembers")}
                          oninput={(event) => (permissions.roleMemberSearch = (event.currentTarget as HTMLInputElement).value)}
                        />
                      </label>
                      <span>{t("roles.memberCount", { count: permissions.roleMemberCount(permissions.roleDraft) })}</span>
                    </div>
                    <div class="role-member-list">
                      {#each permissions.filteredMembersForRole() as member}
                        <div class="role-member-row">
                          <span class="avatar member-avatar" style={memberAvatarStyle(member.member_id)}>
                            {#if member.avatar_data_url}<img src={member.avatar_data_url} alt="" />{:else}{member.display_name.slice(0, 2).toUpperCase()}{/if}
                          </span>
                          <span>
                            <strong>{member.display_name}</strong>
                            <small>{member.is_owner ? t("member.owner") : memberRoleLabel(member)}</small>
                          </span>
                          <button
                            class="role-member-assignment"
                            class:selected={permissions.roleDraft.is_everyone || member.role_ids.includes(permissions.roleDraft.role_id)}
                            type="button"
                            title={permissions.roleDraft.is_everyone || member.role_ids.includes(permissions.roleDraft.role_id) ? t("roles.removeMember") : t("roles.addMember")}
                            aria-label={permissions.roleDraft.is_everyone || member.role_ids.includes(permissions.roleDraft.role_id) ? t("roles.removeMember") : t("roles.addMember")}
                            disabled={permissions.roleDraft.is_everyone || member.is_owner || !canManageRoles || permissions.roleMemberUpdatingId === member.member_id}
                            onclick={() => void onSetMemberRoleAssignment(member, permissions.roleDraft?.role_id ?? "", !member.role_ids.includes(permissions.roleDraft?.role_id ?? ""))}
                          >
                            <span class="material-symbols-rounded app-icon" aria-hidden="true">{permissions.roleDraft.is_everyone || member.role_ids.includes(permissions.roleDraft.role_id) ? "check_circle" : "circle"}</span>
                          </button>
                        </div>
                      {/each}
                    </div>
                  </div>
                {/if}
              </div>
            {:else}
              <p class="status">{t("roles.unavailable")}</p>
            {/if}
          </div>
          {#if !canManageRoles}
            <p class="status">{t("settings.ownerOnly")}</p>
          {/if}
        </section>
      {:else if serverSettings.serverSettingsTab === "members"}
        <section class="settings-section wide-section">
          <div class="settings-section-heading">
            <div>
              <p class="section-label">{t("members.title")}</p>
              <p class="status">{t("members.identityDescription")}</p>
            </div>
          </div>
          {#if canManageMembers && members.length > 1}
            <div class="member-identity-linker">
              <div class="identity-picker-field">
                <span>{t("members.primaryIdentity")}</span>
                <div class="identity-member-picker">
                  <button class="identity-picker-trigger" type="button" class:active={identityMemberPickerOpen === "primary"} onclick={() => onToggleIdentityMemberPicker("primary")}>
                    <span>{selectedIdentityMemberName("primary")}</span>
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">expand_more</span>
                  </button>
                  {#if identityMemberPickerOpen === "primary"}
                    <div class="identity-picker-menu">
                      <label class="settings-search-field">
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">search</span>
                        <input
                          value={identityMemberPickerSearch}
                          placeholder={t("members.searchMembers")}
                          oninput={(event) => onIdentityMemberPickerSearchChange((event.currentTarget as HTMLInputElement).value)}
                        />
                      </label>
                      <div class="identity-picker-options">
                        {#each filteredIdentityPickerMembers("primary") as member}
                          <button type="button" class:selected={identityLinkPrimaryMemberId === member.member_id} onclick={() => onSelectIdentityMember("primary", member.member_id)}>
                            <span class="avatar member-avatar" style={memberAvatarStyle(member.member_id)}>{#if member.avatar_data_url}<img src={member.avatar_data_url} alt="" />{:else}{member.display_name.slice(0, 2).toUpperCase()}{/if}</span>
                            <span><strong>{member.display_name}</strong><small>{t("members.linkedDevices", { count: member.linked_devices || 1 })}</small></span>
                            {#if identityLinkPrimaryMemberId === member.member_id}<span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>{/if}
                          </button>
                        {/each}
                      </div>
                    </div>
                  {/if}
                </div>
              </div>
              <span class="material-symbols-rounded app-icon" aria-hidden="true">arrow_forward</span>
              <div class="identity-picker-field">
                <span>{t("members.duplicateIdentity")}</span>
                <div class="identity-member-picker">
                  <button class="identity-picker-trigger" type="button" class:active={identityMemberPickerOpen === "duplicate"} disabled={!identityLinkPrimaryMemberId} onclick={() => onToggleIdentityMemberPicker("duplicate")}>
                    <span>{selectedIdentityMemberName("duplicate")}</span>
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">expand_more</span>
                  </button>
                  {#if identityMemberPickerOpen === "duplicate"}
                    <div class="identity-picker-menu">
                      <label class="settings-search-field">
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">search</span>
                        <input
                          value={identityMemberPickerSearch}
                          placeholder={t("members.searchMembers")}
                          oninput={(event) => onIdentityMemberPickerSearchChange((event.currentTarget as HTMLInputElement).value)}
                        />
                      </label>
                      <div class="identity-picker-options">
                        {#each filteredIdentityPickerMembers("duplicate") as member}
                          <button type="button" class:selected={identityLinkDuplicateMemberId === member.member_id} onclick={() => onSelectIdentityMember("duplicate", member.member_id)}>
                            <span class="avatar member-avatar" style={memberAvatarStyle(member.member_id)}>{#if member.avatar_data_url}<img src={member.avatar_data_url} alt="" />{:else}{member.display_name.slice(0, 2).toUpperCase()}{/if}</span>
                            <span><strong>{member.display_name}</strong><small>{t("members.linkedDevices", { count: member.linked_devices || 1 })}</small></span>
                            {#if identityLinkDuplicateMemberId === member.member_id}<span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>{/if}
                          </button>
                        {/each}
                      </div>
                    </div>
                  {/if}
                </div>
              </div>
              <button type="button" disabled={identityLinkBusy || !identityLinkPrimaryMemberId || !identityLinkDuplicateMemberId} onclick={() => void onLinkSelectedMemberIdentities()}>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">merge</span>
                <span>{t("members.linkIdentity")}</span>
              </button>
            </div>
          {/if}
          <div class="member-management-list">
            {#each members as member}
              <article class="member-management-row">
                <header>
                  <div class="avatar member-avatar" style={memberAvatarStyle(member.member_id)}>{#if member.avatar_data_url}<img src={member.avatar_data_url} alt="" />{:else}{member.display_name.slice(0, 2).toUpperCase()}{/if}</div>
                  <div class="member-management-summary">
                    <strong>{member.display_name}</strong>
                    <span>{memberRoleLabel(member)} · {t("members.linkedDevices", { count: member.linked_devices || 1 })}</span>
                  </div>
                  <div class="member-management-row-actions">
                    {#if member.is_banned}<span class="member-banned">{t("members.banned")}</span>{/if}
                    {#if canManageRoles && !member.is_owner}
                      <div class="member-role-menu-wrap">
                        <button class="member-role-trigger" type="button" class:active={memberRoleMenuId === member.member_id} disabled={permissions.roleMemberUpdatingId === member.member_id} onclick={() => onToggleMemberRoleMenu(member.member_id)}>
                          <span class="material-symbols-rounded app-icon" aria-hidden="true">badge</span>
                          <span>{memberAssignedRoleLabel(member)}</span>
                          <span class="material-symbols-rounded app-icon" aria-hidden="true">expand_more</span>
                        </button>
                        {#if memberRoleMenuId === member.member_id}
                          <div class="member-role-menu">
                            <label class="settings-search-field">
                              <span class="material-symbols-rounded app-icon" aria-hidden="true">search</span>
                              <input
                                value={memberRoleMenuSearch}
                                placeholder={t("roles.searchRoles")}
                                oninput={(event) => onMemberRoleMenuSearchChange((event.currentTarget as HTMLInputElement).value)}
                              />
                            </label>
                            <div class="member-role-menu-options">
                              {#if filteredAssignableRolesForMemberMenu().length === 0}<p>{t("roles.noRoles")}</p>{/if}
                              {#each filteredAssignableRolesForMemberMenu() as role}
                                {@const assigned = member.role_ids.includes(role.role_id)}
                                <button type="button" class:selected={assigned} disabled={permissions.roleMemberUpdatingId === member.member_id} onclick={() => void onSetMemberRoleAssignment(member, role.role_id, !assigned)}>
                                  <span class="role-color-dot" style={`--role-color: ${role.color || "#9bdcff"}`}></span>
                                  <span>{role.name}</span>
                                  <span class="role-menu-check material-symbols-rounded app-icon" aria-hidden="true">{assigned ? "check_circle" : "circle"}</span>
                                </button>
                              {/each}
                            </div>
                          </div>
                        {/if}
                      </div>
                    {/if}
                    {#if canManageMembers}
                      <button class="member-manage-icon" type="button" class:active={memberEditingId === member.member_id} disabled={member.is_owner} title={t("members.manage")} aria-label={t("members.manage")} onclick={() => memberEditingId === member.member_id ? onCancelEditMember() : onBeginEditMember(member)}>
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">manage_accounts</span>
                      </button>
                    {/if}
                  </div>
                </header>

                {#if memberEditingId === member.member_id}
                  <div class="member-management-editor">
                    <label class="permission-switch-row member-ban-toggle">
                      <span><strong>{t("members.banned")}</strong><small>{t("members.bannedDescription")}</small></span>
                      <input type="checkbox" checked={memberBanDraft} disabled={!canManageMembers || member.is_owner || memberUpdating} onchange={(event) => onMemberBanDraftChange((event.currentTarget as HTMLInputElement).checked)} />
                      <span class="switch-track" aria-hidden="true"><span></span></span>
                    </label>
                    <div class="member-management-actions">
                      <button type="button" onclick={onCancelEditMember}>
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
                        <span>{t("app.close")}</span>
                      </button>
                      <button type="button" disabled={!canManageMembers || memberUpdating} onclick={() => void onSaveMemberChanges(member)}>
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">save</span>
                        <span>{t("settings.save")}</span>
                      </button>
                      <button
                        class="danger-button"
                        type="button"
                        disabled={!canManageMembers || member.is_owner || member.member_id === memberId || memberUpdating}
                        onclick={() => void onRemoveManagedMember(member)}
                      >
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">person_remove</span>
                        <span>{t("members.remove")}</span>
                      </button>
                    </div>
                  </div>
                {/if}
              </article>
            {/each}
          </div>
          {#if !canManageMembers && !canManageRoles}
            <p class="status">{t("settings.ownerOnly")}</p>
          {/if}
        </section>
      {:else}
        <section class="settings-section wide-section">
          <div class="settings-section-heading">
            <div>
              <p class="section-label">{t("settings.auditLog")}</p>
              <p class="status">{t("settings.auditDescription")}</p>
            </div>
            <button type="button" disabled={serverSettings.auditLogsLoading || !canEditServerSettings} onclick={() => {
              void serverSettings.loadAuditLogs();
              flush();
            }}>
              <span class="material-symbols-rounded app-icon" aria-hidden="true">refresh</span>
              <span>{serverSettings.auditLogsLoading ? t("audit.loading") : t("audit.refresh")}</span>
            </button>
          </div>
          <div class="audit-filter">
            <label>
              <span>{t("audit.actionFilter")}</span>
              <input
                value={serverSettings.auditActionFilter}
                placeholder={t("audit.actionPlaceholder")}
                disabled={!canEditServerSettings}
                oninput={(event) => (serverSettings.auditActionFilter = (event.currentTarget as HTMLInputElement).value)}
              />
            </label>
            <button type="button" disabled={serverSettings.auditLogsLoading || !canEditServerSettings} onclick={() => {
              void serverSettings.loadAuditLogs();
              flush();
            }}>{t("audit.applyFilter")}</button>
          </div>
          {#if !canEditServerSettings}
            <p class="status">{t("settings.ownerOnly")}</p>
          {:else if serverSettings.auditLogsLoading}
            <p class="status">{t("audit.loading")}</p>
          {:else if serverSettings.auditLogs.length === 0}
            <p class="status">{t("audit.empty")}</p>
          {:else}
            <div class="audit-list">
              {#each serverSettings.auditLogs as log}
                <article class="audit-row">
                  <div class="audit-icon">
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">history</span>
                  </div>
                  <div class="audit-content">
                    <header>
                      <strong>{auditActionLabel(log.action)}</strong>
                      <time datetime={new Date(log.created_at_ms).toISOString()}>{serverSettings.auditTime(log.created_at_ms)}</time>
                    </header>
                    <p>{t("audit.actorTarget", { actor: serverSettings.auditActorName(log), target: auditTargetLabel(log) })}</p>
                    {#if auditDetails(log)}
                      <small>{auditDetails(log)}</small>
                    {/if}
                  </div>
                </article>
              {/each}
            </div>
          {/if}
        </section>
      {/if}

      {#if error}
        <p class="error">{error}</p>
      {/if}
    </form>
  </div>

  {#if settingsDirty}
    <div class="settings-unsaved-bar">
      <span>{t("settings.unsaved")}</span>
      <div class="settings-unsaved-actions">
        <button type="button" onclick={resetSettingsChanges}>{t("settings.reset")}</button>
        <button
          type="button"
          disabled={(serverSettingsDirty && (!canEditServerSettings || !serverSettings.serverDraft)) || (roleSettingsDirty && (!canManageRoles || permissions.roleUpdating))}
          onclick={() => void saveSettingsChanges()}
        >
          {t("settings.save")}
        </button>
      </div>
    </div>
  {/if}
</div>
{/if}
