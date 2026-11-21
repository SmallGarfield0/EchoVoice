<script lang="ts">
  import { avatarColorPalette, avatarStyleVariables, normalizeAvatarColor } from "../lib/avatar";
  import type { ServerSettingsController } from "../lib/server-settings.svelte";
  import type { LocalUserProfile, Member, MemberMergeRequest, ServerSummary } from "../lib/types";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type Props = {
    t: Translate;
    serverSettings: ServerSettingsController;
    server: ServerSummary | null;
    currentMember: Member | undefined;
    localUserProfile: LocalUserProfile;
    serverProfileSettingsDirty: boolean;
    memberMergeCode: string;
    memberMergeCodeServerID: string;
    memberMergeCodeExpiresAtMS: number;
    memberMergeCodeCopied: boolean;
    memberMergeGenerating: boolean;
    memberMergeCodeInput: string;
    memberMergeSubmitting: boolean;
    memberMergeOutgoing: MemberMergeRequest[];
    memberMergeStatusMessage: string;
    onGenerateAccountMergeCode: () => void;
    onCopyAccountMergeCode: () => void;
    onAccountMergeCodeInput: (event: Event) => void;
    onSubmitAccountMergeRequest: () => void;
    onFlushAliases: () => void;
  };

  let {
    t,
    serverSettings,
    server,
    currentMember,
    localUserProfile,
    serverProfileSettingsDirty,
    memberMergeCode,
    memberMergeCodeServerID,
    memberMergeCodeExpiresAtMS,
    memberMergeCodeCopied,
    memberMergeGenerating,
    memberMergeCodeInput,
    memberMergeSubmitting,
    memberMergeOutgoing,
    memberMergeStatusMessage,
    onGenerateAccountMergeCode,
    onCopyAccountMergeCode,
    onAccountMergeCodeInput,
    onSubmitAccountMergeRequest,
    onFlushAliases
  }: Props = $props();

  let avatarInput = $state<HTMLInputElement | null>(null);

  function flush() {
    onFlushAliases();
  }

  function closeDialog() {
    serverSettings.closeServerProfileSettings();
    flush();
  }

  function setOverride(field: "display_name" | "avatar" | "bio", enabled: boolean) {
    serverSettings.setServerProfileOverride(field, enabled);
    flush();
  }

  function updateDraft(patch: Partial<LocalUserProfile>) {
    serverSettings.serverProfileDraft = { ...serverSettings.serverProfileDraft, ...patch };
    flush();
  }

  function selectAvatar(event: Event) {
    void serverSettings.selectServerProfileAvatar(event);
    flush();
  }

  function clearAvatar() {
    serverSettings.clearServerProfileAvatar();
    flush();
  }

  function setAvatarColor(color: string) {
    serverSettings.setServerProfileAvatarColor(color);
    flush();
  }

  function resetProfile() {
    serverSettings.resetServerProfileSettings();
    flush();
  }

  function saveProfile() {
    void serverSettings.saveServerProfileSettings();
    flush();
  }
</script>

{#if serverSettings.serverProfileSettingsOpen && server && currentMember}
<div class="settings-page server-user-profile-page" role="dialog" aria-modal="true" aria-label={t("serverProfile.title")} data-server-profile-settings>
  <header class="settings-page-header">
    <div>
      <p class="eyebrow">{server.name}</p>
      <h1>{t("serverProfile.title")}</h1>
    </div>
    <button class="settings-close-button" type="button" aria-label={t("app.close")} onclick={closeDialog}>
      <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
    </button>
  </header>

  <div class="settings-panel settings-page-body server-user-profile-body">
    <section class="server-user-profile-intro">
      <div>
        <p class="section-label">{t("serverProfile.preview")}</p>
        <p class="status">{t("serverProfile.description")}</p>
      </div>
      <div class="server-user-profile-preview">
        <div class="profile-avatar-preview" style={avatarStyleVariables(serverSettings.serverProfileDraft.avatar_color, currentMember.member_id)}>
          {#if serverSettings.serverProfileDraft.avatar_data_url}
            <img src={serverSettings.serverProfileDraft.avatar_data_url} alt="" />
          {:else}
            <span>{serverSettings.serverProfileDraft.display_name.slice(0, 2).toUpperCase() || "EV"}</span>
          {/if}
        </div>
        <div>
          <strong>{serverSettings.serverProfileDraft.display_name || localUserProfile.display_name}</strong>
          <span>{server.name}</span>
          {#if serverSettings.serverProfileDraft.bio}<p>{serverSettings.serverProfileDraft.bio}</p>{/if}
        </div>
      </div>
    </section>

    <section class="server-profile-field" data-server-profile-field="display-name">
      <div class="server-profile-field-heading">
        <div>
          <strong>{t("serverProfile.displayName")}</strong>
          <small>{t("serverProfile.displayNameDescription")}</small>
        </div>
        <button
          class="server-profile-override-toggle"
          class:active={serverSettings.serverProfileOverridesDraft.display_name}
          type="button"
          role="switch"
          aria-checked={serverSettings.serverProfileOverridesDraft.display_name}
          onclick={() => setOverride("display_name", !serverSettings.serverProfileOverridesDraft.display_name)}
        >
          <span>{serverSettings.serverProfileOverridesDraft.display_name ? t("serverProfile.serverSpecific") : t("serverProfile.followGlobal")}</span>
          <span class="server-profile-toggle-track" aria-hidden="true"><span></span></span>
        </button>
      </div>
      <label>
        <span>{t("profile.displayName")}</span>
        <input
          value={serverSettings.serverProfileDraft.display_name}
          maxlength="64"
          autocomplete="nickname"
          disabled={!serverSettings.serverProfileOverridesDraft.display_name}
          oninput={(event) => updateDraft({ display_name: (event.currentTarget as HTMLInputElement).value })}
        />
      </label>
    </section>

    <section class="server-profile-field" data-server-profile-field="avatar">
      <div class="server-profile-field-heading">
        <div>
          <strong>{t("serverProfile.avatar")}</strong>
          <small>{t("serverProfile.avatarDescription")}</small>
        </div>
        <button
          class="server-profile-override-toggle"
          class:active={serverSettings.serverProfileOverridesDraft.avatar}
          type="button"
          role="switch"
          aria-checked={serverSettings.serverProfileOverridesDraft.avatar}
          onclick={() => setOverride("avatar", !serverSettings.serverProfileOverridesDraft.avatar)}
        >
          <span>{serverSettings.serverProfileOverridesDraft.avatar ? t("serverProfile.serverSpecific") : t("serverProfile.followGlobal")}</span>
          <span class="server-profile-toggle-track" aria-hidden="true"><span></span></span>
        </button>
      </div>
      <div class="server-profile-avatar-editor" class:disabled={!serverSettings.serverProfileOverridesDraft.avatar}>
        <div class="profile-avatar-preview" style={avatarStyleVariables(serverSettings.serverProfileDraft.avatar_color, currentMember.member_id)}>
          {#if serverSettings.serverProfileDraft.avatar_data_url}
            <img src={serverSettings.serverProfileDraft.avatar_data_url} alt="" />
          {:else}
            <span>{serverSettings.serverProfileDraft.display_name.slice(0, 2).toUpperCase() || "EV"}</span>
          {/if}
        </div>
        <div class="server-profile-avatar-controls">
          <input bind:this={avatarInput} class="visually-hidden" type="file" accept="image/*" onchange={selectAvatar} />
          <div class="profile-avatar-actions">
            <button type="button" disabled={!serverSettings.serverProfileOverridesDraft.avatar} onclick={() => avatarInput?.click()}>{t("profile.changeAvatar")}</button>
            <button type="button" disabled={!serverSettings.serverProfileOverridesDraft.avatar || !serverSettings.serverProfileDraft.avatar_data_url} onclick={clearAvatar}>{t("profile.removeAvatar")}</button>
          </div>
          {#if !serverSettings.serverProfileDraft.avatar_data_url}
            <div class="profile-avatar-color-control">
              <span>{t("profile.avatarColor")}</span>
              <div class="profile-avatar-color-swatches" role="radiogroup" aria-label={t("profile.avatarColor")}>
                {#each avatarColorPalette as color}
                  <button
                    type="button"
                    role="radio"
                    disabled={!serverSettings.serverProfileOverridesDraft.avatar}
                    class:selected={normalizeAvatarColor(serverSettings.serverProfileDraft.avatar_color, currentMember.member_id) === color}
                    aria-checked={normalizeAvatarColor(serverSettings.serverProfileDraft.avatar_color, currentMember.member_id) === color}
                    aria-label={color}
                    style={`--avatar-swatch-color: ${color};`}
                    onclick={() => setAvatarColor(color)}
                  ></button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </div>
    </section>

    <section class="server-profile-field" data-server-profile-field="bio">
      <div class="server-profile-field-heading">
        <div>
          <strong>{t("serverProfile.bio")}</strong>
          <small>{t("serverProfile.bioDescription")}</small>
        </div>
        <button
          class="server-profile-override-toggle"
          class:active={serverSettings.serverProfileOverridesDraft.bio}
          type="button"
          role="switch"
          aria-checked={serverSettings.serverProfileOverridesDraft.bio}
          onclick={() => setOverride("bio", !serverSettings.serverProfileOverridesDraft.bio)}
        >
          <span>{serverSettings.serverProfileOverridesDraft.bio ? t("serverProfile.serverSpecific") : t("serverProfile.followGlobal")}</span>
          <span class="server-profile-toggle-track" aria-hidden="true"><span></span></span>
        </button>
      </div>
      <label>
        <span>{t("profile.bio")}</span>
        <textarea
          value={serverSettings.serverProfileDraft.bio}
          maxlength="500"
          rows="5"
          placeholder={t("profile.bioPlaceholder")}
          disabled={!serverSettings.serverProfileOverridesDraft.bio}
          oninput={(event) => updateDraft({ bio: (event.currentTarget as HTMLTextAreaElement).value })}
        ></textarea>
        <small>{serverSettings.serverProfileDraft.bio.length} / 500</small>
      </label>
    </section>

    <div class="server-profile-sync-note">
      <span class="material-symbols-rounded app-icon" aria-hidden="true">sync</span>
      <span>{t("serverProfile.syncDescription")}</span>
    </div>

    <section class="server-account-merge" data-account-merge>
      <header>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">merge</span>
        <div>
          <h2>{t("accountMerge.title")}</h2>
          <p>{t("accountMerge.description")}</p>
        </div>
      </header>
      <div class="server-account-merge-warning">
        <span class="material-symbols-rounded app-icon" aria-hidden="true">verified_user</span>
        <span>{t("accountMerge.securityNote")}</span>
      </div>
      <div class="server-account-merge-columns">
        <div class="server-account-merge-column">
          <div>
            <strong>{t("accountMerge.keepAccount")}</strong>
            <small>{t("accountMerge.keepAccountDescription")}</small>
          </div>
          {#if memberMergeCode && memberMergeCodeServerID === server.server_id}
            <div class="member-merge-code-output">
              <code>{memberMergeCode}</code>
              <button type="button" aria-label={t("accountMerge.copyCode")} onclick={() => void onCopyAccountMergeCode()}>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">{memberMergeCodeCopied ? "check" : "content_copy"}</span>
              </button>
            </div>
            <small class="member-merge-expiry">
              {t("accountMerge.codeExpires", { time: new Date(memberMergeCodeExpiresAtMS).toLocaleString() })}
            </small>
          {/if}
          <button class="secondary member-merge-action" type="button" disabled={memberMergeGenerating} onclick={() => void onGenerateAccountMergeCode()}>
            <span class="material-symbols-rounded app-icon member-merge-button-icon" aria-hidden="true">pin</span>
            <span class="member-merge-button-label">{memberMergeGenerating ? t("accountMerge.generating") : memberMergeCode ? t("accountMerge.regenerateCode") : t("accountMerge.generateCode")}</span>
          </button>
        </div>

        <div class="server-account-merge-column">
          <div>
            <strong>{t("accountMerge.mergeThisAccount")}</strong>
            <small>{t("accountMerge.mergeThisAccountDescription")}</small>
          </div>
          <div class="member-merge-code-input-row">
            <input
              value={memberMergeCodeInput}
              inputmode="numeric"
              pattern="[0-9]*"
              maxlength="8"
              autocomplete="one-time-code"
              placeholder={t("accountMerge.codePlaceholder")}
              aria-label={t("accountMerge.codePlaceholder")}
              oninput={onAccountMergeCodeInput}
              onkeydown={(event) => {
                if (event.key === "Enter" && memberMergeCodeInput.length === 8) void onSubmitAccountMergeRequest();
              }}
            />
            <button
              class="primary member-merge-submit"
              type="button"
              disabled={memberMergeSubmitting || memberMergeCodeInput.length !== 8 || memberMergeOutgoing.length > 0}
              onclick={() => void onSubmitAccountMergeRequest()}
            >
              <span class="material-symbols-rounded app-icon member-merge-button-icon" aria-hidden="true">send</span>
              <span class="member-merge-button-label">{memberMergeSubmitting ? t("accountMerge.submitting") : t("accountMerge.submit")}</span>
            </button>
          </div>
          {#if memberMergeOutgoing.length > 0}
            <div class="member-merge-pending-status">
              <span class="material-symbols-rounded app-icon" aria-hidden="true">schedule</span>
              <span>{t("accountMerge.pendingTarget", { name: memberMergeOutgoing[0].target.display_name })}</span>
            </div>
          {/if}
        </div>
      </div>
      {#if memberMergeStatusMessage}
        <p class="member-merge-status" aria-live="polite">{memberMergeStatusMessage}</p>
      {/if}
    </section>
    {#if serverSettings.serverProfileSaveMessage}<p class="profile-save-message">{serverSettings.serverProfileSaveMessage}</p>{/if}
  </div>

  {#if serverProfileSettingsDirty}
    <div class="settings-unsaved-bar server-profile-unsaved-bar">
      <span>{t("settings.unsaved")}</span>
      <div class="settings-unsaved-actions">
        <button type="button" disabled={serverSettings.serverProfileSaving} onclick={resetProfile}>{t("settings.reset")}</button>
        <button
          type="button"
          disabled={serverSettings.serverProfileSaving || (serverSettings.serverProfileOverridesDraft.display_name && !serverSettings.serverProfileDraft.display_name.trim())}
          onclick={saveProfile}
        >
          {serverSettings.serverProfileSaving ? t("profile.saving") : t("settings.save")}
        </button>
      </div>
    </div>
  {/if}
</div>
{/if}
