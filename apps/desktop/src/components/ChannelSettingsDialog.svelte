<script lang="ts">
  import CustomSelect from "./CustomSelect.svelte";
  import NumericInput from "./NumericInput.svelte";
  import type { ChannelsController } from "../lib/channels.svelte";
  import { hasEffectivePermission } from "../lib/permissions";
  import type { PermissionsController } from "../lib/permissions.svelte";
  import type { Channel, Member, Permission } from "../lib/types";

  type Translate = (key: string, values?: Record<string, string | number>) => string;
  type LanguageOption = { id: string; name: string };
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
    channels: ChannelsController;
    permissions: PermissionsController;
    members: Member[];
    canManageChannels: boolean;
    canManageChannelPermissions: boolean;
    settingsSelectMenuOpen: SettingsSelectMenu | null;
    onToggleSettingsSelectMenu: (menu: SettingsSelectMenu) => void;
    languageOptions: () => LanguageOption[];
    categoryChannelEntries: Channel[];
    error: string;
    memberAvatarStyle: (memberIdValue: string) => string;
    setChannelTopicTextareaElement: (element: HTMLTextAreaElement | null) => void;
    setChannelPermissionTargetPickerElement: (element: HTMLDivElement | null) => void;
    setChannelPermissionTargetMenuElement: (element: HTMLDivElement | null) => void;
    onFlushAliases: () => void;
  };

  let {
    t,
    channels,
    permissions,
    members,
    canManageChannels,
    canManageChannelPermissions,
    settingsSelectMenuOpen,
    onToggleSettingsSelectMenu,
    languageOptions,
    categoryChannelEntries,
    error,
    memberAvatarStyle,
    setChannelTopicTextareaElement,
    setChannelPermissionTargetPickerElement,
    setChannelPermissionTargetMenuElement,
    onFlushAliases
  }: Props = $props();

  let channelTopicTextarea = $state<HTMLTextAreaElement | null>(null);
  let channelPermissionTargetPicker = $state<HTMLDivElement | null>(null);
  let channelPermissionTargetMenu = $state<HTMLDivElement | null>(null);

  $effect(() => {
    setChannelTopicTextareaElement(channelTopicTextarea);
    return () => setChannelTopicTextareaElement(null);
  });
  $effect(() => {
    setChannelPermissionTargetPickerElement(channelPermissionTargetPicker);
    return () => setChannelPermissionTargetPickerElement(null);
  });
  $effect(() => {
    setChannelPermissionTargetMenuElement(channelPermissionTargetMenu);
    return () => setChannelPermissionTargetMenuElement(null);
  });

  function flush() {
    onFlushAliases();
  }

  function closeDialog() {
    void channels.closeChannelSettings();
    flush();
  }

  function selectTab(tab: Parameters<ChannelsController["selectChannelSettingsTab"]>[0]) {
    void channels.selectChannelSettingsTab(tab);
    flush();
  }

  function updateDraft(patch: Partial<Channel>) {
    const draft = channels.channelDraft;
    if (!draft) return;
    channels.channelDraft = { ...draft, ...patch };
    flush();
  }

  function setDefaultLanguage(language: string) {
    channels.setChannelDefaultLanguage(language);
    flush();
  }

  function selectLocalizationLanguage(language: string) {
    channels.selectChannelLocalizationLanguage(language);
    flush();
  }

  function setLocalizationField(field: "name" | "topic" | "warning_text", value: string) {
    channels.setChannelLocalizationField(field, value);
    flush();
  }

  function setDraftParentId(value: string) {
    channels.setDraftParentId(value);
    flush();
  }

  function applyTopicMarkup(markup: string) {
    void channels.applyChannelTopicMarkup(markup);
    flush();
  }

  function setDraftVisibility(visibility: Channel["visibility"]) {
    channels.setChannelDraftVisibility(visibility);
    flush();
  }

  function setUserLimit(value: number) {
    channels.setChannelUserLimit(value);
    flush();
  }

  function deleteCurrentChannel() {
    const draft = channels.channelDraft;
    if (draft) void channels.deleteChannel(draft);
    flush();
  }

  function saveChannel() {
    void channels.saveChannelSettings();
    flush();
  }

  function resetChannel() {
    channels.resetChannelSettings();
    flush();
  }

  function togglePermissionTargetPicker() {
    void permissions.toggleChannelPermissionTargetPicker();
    flush();
  }

  function removePermissionTarget() {
    permissions.removeSelectedChannelPermissionTarget();
    flush();
  }

  function selectPermissionTarget(type: "role" | "member", id: string) {
    permissions.selectChannelPermissionTarget(type, id);
    flush();
  }

  function setPermissionState(type: "role" | "member", id: string, permission: Permission, state: "inherit" | "allow" | "deny") {
    permissions.setChannelPermissionState(type, id, permission, state);
    flush();
  }


  function memberById(memberIdValue: string) {
    return members.find((member) => member.member_id === memberIdValue);
  }

  function permissionLabel(permission: Permission) {
    return t(`permission.${permission}`);
  }

  function permissionDescription(permission: Permission) {
    return t(`permissionDescription.${permission}`);
  }

  function channelEffectivePermissionLabel(
    targetType: "role" | "member",
    targetId: string,
    permission: Permission
  ) {
    const state = permissions.channelPermissionState(targetType, targetId, permission);
    if (state === "allow") return t("permissions.effectiveAllow");
    if (state === "deny") return t("permissions.effectiveDeny");
    if (targetType === "role") {
      return permissions.roleAllows(permissions.roleById(targetId), permission)
        ? t("permissions.effectiveAllow")
        : t("permissions.effectiveDeny");
    }
    const member = memberById(targetId);
    return hasEffectivePermission(permission, Boolean(member?.is_owner), member, permissions.roles)
      ? t("permissions.effectiveAllow")
      : t("permissions.effectiveDeny");
  }
</script>

{#if channels.channelDraft}
  <div class="settings-page" role="dialog" aria-modal="true" aria-label={t("channel.settingsTitle", { name: channels.channelDraft.name })}>
    <header class="settings-page-header">
      <div>
        <p class="eyebrow">{channels.channelTypeLabel(channels.channelDraft)}</p>
        <h1>{channels.channelDraft.name}</h1>
      </div>
      <button class="settings-close-button" type="button" title={t("app.close")} onclick={closeDialog}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
      </button>
    </header>

    <div class="settings-layout settings-page-body">
      <nav class="settings-nav" aria-label={t("channel.settingsTitle", { name: channels.channelDraft.name })}>
        <button type="button" class:active={channels.channelSettingsTab === "overview"} onclick={() => selectTab("overview")}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">tune</span>
          <span>{t("channel.settingsOverview")}</span>
        </button>
        <button type="button" class:active={channels.channelSettingsTab === "permissions"} onclick={() => selectTab("permissions")}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">shield_person</span>
          <span>{t("channel.permissions")}</span>
        </button>
        <div class="settings-nav-separator"></div>
        <button class="settings-nav-danger" type="button" disabled={!canManageChannels} onclick={deleteCurrentChannel}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">delete</span>
          <span>{t(channels.channelDraft.type === "category" ? "channel.deleteCategory" : "channel.delete")}</span>
        </button>
      </nav>

      <div class="settings-panel channel-settings-panel">
        {#if channels.channelSettingsTab === "overview"}
          <section class="settings-section channel-settings-overview">
            <p class="section-label">{t("channel.general")}</p>
            <label>
              <span>{channels.channelDraft.type === "category" ? t("channel.categoryName") : t("channel.name")}</span>
              <input value={channels.channelDraft.name} maxlength="100" disabled={!canManageChannels} oninput={(event) => updateDraft({ name: (event.currentTarget as HTMLInputElement).value })} />
            </label>

            <label class="settings-select-field channel-language-field">
              <span>{t("channel.defaultLanguage")}</span>
              <div class="settings-custom-select" class:open={settingsSelectMenuOpen === "channel-default-language"}>
                <button class="settings-select-trigger" type="button" disabled={!canManageChannels} aria-haspopup="listbox" aria-expanded={settingsSelectMenuOpen === "channel-default-language"} onclick={() => onToggleSettingsSelectMenu("channel-default-language")}>
                  <span>{channels.channelDraft.default_language ? languageOptions().find((option) => option.id === channels.channelDraft.default_language)?.name ?? channels.channelDraft.default_language : t("channel.followServerLanguage")}</span>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">expand_more</span>
                </button>
                {#if settingsSelectMenuOpen === "channel-default-language"}
                  <div class="settings-select-options" role="listbox" aria-label={t("channel.defaultLanguage")}>
                    <button type="button" role="option" class:active={!channels.channelDraft.default_language} aria-selected={!channels.channelDraft.default_language} onclick={() => setDefaultLanguage("")}>
                      <span>{t("channel.followServerLanguage")}</span>
                      {#if !channels.channelDraft.default_language}<span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>{/if}
                    </button>
                    {#each languageOptions() as language}
                      <button type="button" role="option" class:active={channels.channelDraft.default_language === language.id} aria-selected={channels.channelDraft.default_language === language.id} onclick={() => setDefaultLanguage(language.id)}>
                        <span>{language.name}</span>
                        {#if channels.channelDraft.default_language === language.id}<span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>{/if}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
              <small>{t("channel.defaultLanguageDescription")}</small>
            </label>

            <div class="channel-localization-editor">
              <div class="channel-localization-heading">
                <div>
                  <strong>{t("channel.localizations")}</strong>
                  <small>{t("channel.localizationsDescription")}</small>
                </div>
                <div class="settings-custom-select" class:open={settingsSelectMenuOpen === "channel-localization-language"}>
                  <button class="settings-select-trigger" type="button" disabled={!canManageChannels} aria-haspopup="listbox" aria-expanded={settingsSelectMenuOpen === "channel-localization-language"} onclick={() => onToggleSettingsSelectMenu("channel-localization-language")}>
                    <span>{languageOptions().find((option) => option.id === channels.channelLocalizationLanguage)?.name ?? channels.channelLocalizationLanguage}</span>
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">expand_more</span>
                  </button>
                  {#if settingsSelectMenuOpen === "channel-localization-language"}
                    <div class="settings-select-options" role="listbox" aria-label={t("channel.localizations")}>
                      {#each languageOptions() as language}
                        <button type="button" role="option" class:active={channels.channelLocalizationLanguage === language.id} aria-selected={channels.channelLocalizationLanguage === language.id} onclick={() => selectLocalizationLanguage(language.id)}>
                          <span>{language.name}</span>
                          {#if channels.channelLocalizationLanguage === language.id}<span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>{/if}
                        </button>
                      {/each}
                    </div>
                  {/if}
                </div>
              </div>
              {#if channels.channelLocalizationLanguage === channels.effectiveChannelDefaultLanguage(channels.channelDraft)}
                <p class="status">{t("channel.localizationUsesBaseFields")}</p>
              {:else}
                <label>
                  <span>{t("channel.localizedName")}</span>
                  <input
                    maxlength="100"
                    disabled={!canManageChannels}
                    value={channels.channelDraft.localizations?.[channels.channelLocalizationLanguage]?.name ?? ""}
                    oninput={(event) => setLocalizationField("name", (event.currentTarget as HTMLInputElement).value)}
                  />
                </label>
                {#if channels.channelDraft.type !== "category"}
                  <label>
                    <span>{t("channel.localizedTopic")}</span>
                    <textarea
                      maxlength="2000"
                      rows="3"
                      disabled={!canManageChannels}
                      value={channels.channelDraft.localizations?.[channels.channelLocalizationLanguage]?.topic ?? ""}
                      oninput={(event) => setLocalizationField("topic", (event.currentTarget as HTMLTextAreaElement).value)}
                    ></textarea>
                  </label>
                  {#if channels.channelDraft.visibility === "warning"}
                    <label>
                      <span>{t("channel.localizedWarning")}</span>
                      <textarea
                        maxlength="1000"
                        rows="3"
                        disabled={!canManageChannels}
                        value={channels.channelDraft.localizations?.[channels.channelLocalizationLanguage]?.warning_text ?? ""}
                        oninput={(event) => setLocalizationField("warning_text", (event.currentTarget as HTMLTextAreaElement).value)}
                      ></textarea>
                    </label>
                  {/if}
                {/if}
              {/if}
            </div>

            {#if channels.channelDraft.type !== "category"}
              <div class="settings-select-field">
                <span>{t("channel.parent")}</span>
                <CustomSelect
                  value={channels.channelDraft.parent_id}
                  options={[
                    { value: "", label: t("channel.uncategorized") },
                    ...categoryChannelEntries.map((category) => ({ value: category.channel_id, label: category.name }))
                  ]}
                  ariaLabel={t("channel.parent")}
                  disabled={!canManageChannels}
                  onValueChange={setDraftParentId}
                />
              </div>

              <div class="channel-topic-field">
                <span>{t("channel.topic")}</span>
                <div class="channel-topic-toolbar" role="toolbar" aria-label={t("channel.topicFormatting")}>
                  <button type="button" title={t("channel.bold")} aria-label={t("channel.bold")} onclick={() => applyTopicMarkup("**")}>
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">format_bold</span>
                  </button>
                  <button type="button" title={t("channel.italic")} aria-label={t("channel.italic")} onclick={() => applyTopicMarkup("*")}>
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">format_italic</span>
                  </button>
                  <button type="button" title={t("channel.code")} aria-label={t("channel.code")} onclick={() => applyTopicMarkup("`")}>
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">code</span>
                  </button>
                </div>
                <textarea
                  bind:this={channelTopicTextarea}
                  value={channels.channelDraft.topic}
                  maxlength="2000"
                  rows="6"
                  disabled={!canManageChannels}
                  placeholder={t("channel.topicPlaceholder")}
                  oninput={(event) => updateDraft({ topic: (event.currentTarget as HTMLTextAreaElement).value })}
                ></textarea>
                <small>{channels.channelDraft.topic?.length ?? 0} / 2000</small>
              </div>

              <fieldset class="channel-visibility-field">
                <legend>{t("channel.contentVisibility")}</legend>
                <div class="channel-visibility-options">
                  <button type="button" class:active={channels.channelDraft.visibility === "default"} disabled={!canManageChannels} onclick={() => setDraftVisibility("default")}>
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">forum</span>
                    <span><strong>{t("channel.visibilityDefault")}</strong><small>{t("channel.visibilityDefaultDescription")}</small></span>
                  </button>
                  <button type="button" class:active={channels.channelDraft.visibility === "warning"} disabled={!canManageChannels} onclick={() => setDraftVisibility("warning")}>
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">warning</span>
                    <span><strong>{t("channel.visibilityWarning")}</strong><small>{t("channel.visibilityWarningDescription")}</small></span>
                  </button>
                </div>
              </fieldset>

              {#if channels.channelDraft.visibility === "warning"}
                <label>
                  <span>{t("channel.warningText")}</span>
                  <textarea
                    value={channels.channelDraft.warning_text}
                    maxlength="1000"
                    rows="4"
                    disabled={!canManageChannels}
                    placeholder={t("channel.warningPlaceholder")}
                    oninput={(event) => updateDraft({ warning_text: (event.currentTarget as HTMLTextAreaElement).value })}
                  ></textarea>
                </label>
              {/if}

              {#if channels.channelDraft.type === "voice"}
                <div class="voice-channel-detail-settings">
                  <label>
                    <span>{t("channel.bitrate")}</span>
                    <strong>{Math.round(channels.channelDraft.bitrate / 1000)} kbps</strong>
                    <input
                      type="range"
                      min="32000"
                      max="512000"
                      step="8000"
                      value={channels.channelDraft.bitrate}
                      disabled={!canManageChannels}
                      oninput={(event) => updateDraft({ bitrate: Number((event.currentTarget as HTMLInputElement).value) })}
                    />
                  </label>
                  <label>
                    <span>{t("channel.userLimit")}</span>
                    <NumericInput
                      value={channels.channelDraft.user_limit}
                      min={0}
                      max={1000}
                      step={1}
                      disabled={!canManageChannels}
                      ariaLabel={t("channel.userLimit")}
                      decreaseLabel={t("app.decreaseValue", { name: t("channel.userLimit") })}
                      increaseLabel={t("app.increaseValue", { name: t("channel.userLimit") })}
                      onValueChange={setUserLimit}
                    />
                    <small>{channels.channelDraft.user_limit === 0 ? t("channel.noUserLimit") : t("channel.userLimitDescription")}</small>
                  </label>
                </div>
              {/if}

              {#if channels.channelDraft.parent_id}
                <label class="permission-switch-row channel-sync-toggle">
                  <span><strong>{t("channel.syncPermissions")}</strong><small>{t("channel.syncPermissionsDescription")}</small></span>
                  <input
                    type="checkbox"
                    checked={channels.channelDraft.permission_synced}
                    disabled={!canManageChannelPermissions}
                    onchange={(event) => updateDraft({ permission_synced: (event.currentTarget as HTMLInputElement).checked })}
                  />
                  <span class="switch-track" aria-hidden="true"><span></span></span>
                </label>
              {/if}
            {/if}
          </section>
        {:else}
          <section class="settings-section wide-section channel-permission-settings">
            <div class="settings-section-heading">
              <div>
                <p class="section-label">{t("channel.permissions")}</p>
                <p class="status">{channels.channelDraft.permission_synced && channels.channelDraft.parent_id ? t("channel.permissionsSynced") : t("channel.permissionsDescription")}</p>
              </div>
            </div>
            {#if !canManageChannelPermissions}
              <p class="status">{t("settings.ownerOnly")}</p>
            {:else}
              <div class="channel-permission-editor">
                <aside class="channel-permission-targets">
                  <div class="channel-permission-target-heading">
                    <strong>{t("channel.permissionTargets")}</strong>
                    <div class="channel-permission-target-picker" bind:this={channelPermissionTargetPicker}>
                      <button type="button" title={t("channel.addPermissionTarget")} aria-label={t("channel.addPermissionTarget")} class:active={permissions.channelPermissionTargetPickerOpen} disabled={channels.channelSettingsSaving} onclick={togglePermissionTargetPicker}>
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">add</span>
                      </button>
                    </div>
                  </div>
                  {#each permissions.channelPermissionTargets as target}
                    <button type="button" class:active={permissions.channelPermissionTargetType === target.targetType && permissions.channelPermissionTargetId === target.targetId} onclick={() => selectPermissionTarget(target.targetType, target.targetId)}>
                      {#if target.targetType === "role"}
                        <span class="role-color-dot" style={`--role-color: ${permissions.roleById(target.targetId)?.color || "#9bdcff"}`}></span>
                      {:else}
                        {@const targetMember = memberById(target.targetId)}
                        <span class="avatar member-avatar" style={memberAvatarStyle(target.targetId)}>{#if targetMember?.avatar_data_url}<img src={targetMember.avatar_data_url} alt="" />{:else}{targetMember?.display_name.slice(0, 2).toUpperCase() ?? "?"}{/if}</span>
                      {/if}
                      <span>{permissions.channelPermissionTargetName(target)}</span>
                    </button>
                  {/each}
                </aside>
                <div class="channel-permission-detail">
                  <header>
                    <div><h2>{permissions.selectedChannelPermissionTargetName()}</h2><span>{permissions.channelPermissionTargetType === "role" ? t("settings.tabRoles") : t("members.title")}</span></div>
                    {#if permissions.channelPermissionTargetId && !permissions.selectedChannelPermissionTargetIsEveryone()}
                      <button class="channel-permission-target-remove" type="button" title={t("channel.removePermissionTarget")} aria-label={t("channel.removePermissionTarget")} disabled={channels.channelSettingsSaving} onclick={removePermissionTarget}>
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">delete</span>
                      </button>
                    {/if}
                  </header>
                  {#if permissions.channelPermissionLoading}
                    <p class="status">{t("channel.permissionsLoading")}</p>
                  {:else if permissions.channelPermissionTargetId}
                    {#each permissions.channelPermissionGroups() as group}
                      <section class="permission-group">
                        <p class="permission-group-label">{t(group.labelKey)}</p>
                        <div class="channel-permission-list">
                          {#each group.permissions as permission}
                            <div class="channel-permission-row">
                              <div>
                                <strong>{permissionLabel(permission)}</strong>
                                <small>{permissionDescription(permission)}</small>
                              </div>
                              <span class="channel-effective-permission">{channelEffectivePermissionLabel(permissions.channelPermissionTargetType, permissions.channelPermissionTargetId, permission)}</span>
                              <div class="permission-state-buttons" role="group" aria-label={permissionLabel(permission)}>
                                <button type="button" disabled={channels.channelSettingsSaving} class:deny={permissions.channelPermissionState(permissions.channelPermissionTargetType, permissions.channelPermissionTargetId, permission) === "deny"} title={t("permissions.deny")} aria-label={t("permissions.deny")} onclick={() => setPermissionState(permissions.channelPermissionTargetType, permissions.channelPermissionTargetId, permission, "deny")}>
                                  <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
                                </button>
                                <button type="button" disabled={channels.channelSettingsSaving} class:active={permissions.channelPermissionState(permissions.channelPermissionTargetType, permissions.channelPermissionTargetId, permission) === "inherit"} title={t("permissions.inherit")} aria-label={t("permissions.inherit")} onclick={() => setPermissionState(permissions.channelPermissionTargetType, permissions.channelPermissionTargetId, permission, "inherit")}>
                                  <span class="material-symbols-rounded app-icon" aria-hidden="true">remove</span>
                                </button>
                                <button type="button" disabled={channels.channelSettingsSaving} class:allow={permissions.channelPermissionState(permissions.channelPermissionTargetType, permissions.channelPermissionTargetId, permission) === "allow"} title={t("permissions.allow")} aria-label={t("permissions.allow")} onclick={() => setPermissionState(permissions.channelPermissionTargetType, permissions.channelPermissionTargetId, permission, "allow")}>
                                  <span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>
                                </button>
                              </div>
                            </div>
                          {/each}
                        </div>
                      </section>
                    {/each}
                  {/if}
                </div>
              </div>
            {/if}
          </section>
        {/if}
        {#if error}<p class="error">{error}</p>{/if}
      </div>
    </div>

    {#if channels.channelSettingsDirty}
      <div class="settings-unsaved-bar">
        <span>{t("settings.unsaved")}</span>
        <div class="settings-unsaved-actions">
          <button type="button" onclick={resetChannel}>{t("settings.reset")}</button>
          <button
            type="button"
            disabled={channels.channelSettingsSaving || (channels.channelDetailsDirty && (!canManageChannels || !channels.channelDraft.name.trim())) || (channels.channelPermissionsDirty && !canManageChannelPermissions)}
            onclick={saveChannel}
          >{t("settings.save")}</button>
        </div>
      </div>
    {/if}
  </div>
{/if}
