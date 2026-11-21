<script lang="ts">
  import { serverFeatures } from "../lib/server-settings.svelte";
  import type { Channel, Member, ServerSummary } from "../lib/types";
  import { publicVersionSeries } from "../lib/version";

  type Translate = (key: string, values?: Record<string, string | number>) => string;
  type LanguageOption = { id: string; name: string };

  type Props = {
    t: Translate;
    open: boolean;
    server: ServerSummary | null;
    members: Member[];
    channels: Channel[];
    languageOptions: () => LanguageOption[];
    serverInitials: (name: string) => string;
    auditTime: (createdAtMS: number) => string;
    onClose: () => void;
  };

  let {
    t,
    open,
    server,
    members,
    channels,
    languageOptions,
    serverInitials,
    auditTime,
    onClose
  }: Props = $props();
</script>

{#if open && server}
<div class="settings-page server-details-page" role="dialog" aria-modal="true" aria-label={t("server.details")}>
  <header class="settings-page-header">
    <div>
      <p class="eyebrow">{server.name}</p>
      <h1>{t("server.details")}</h1>
    </div>
    <button class="settings-close-button" type="button" aria-label={t("app.close")} onclick={onClose}>
      <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
    </button>
  </header>
  <div class="server-details-body">
    <section class="server-details-identity">
      <div class="server-icon-preview">
        {#if server.icon_data_url}<img src={server.icon_data_url} alt="" />{:else}<span>{serverInitials(server.name)}</span>{/if}
      </div>
      <div>
        <h2>{server.name}</h2>
        <p>{server.description || t("server.noDescription")}</p>
      </div>
    </section>
    <section class="settings-section">
      <p class="section-label">{t("settings.serverInfo")}</p>
      <div class="server-info-grid">
        <div><span>{t("settings.serverId")}</span><strong>{server.server_id}</strong></div>
        <div data-server-version-public><span>{t("settings.serverVersionPublic")}</span><strong>{server.public_server_version ?? publicVersionSeries(server.server_version) ?? t("settings.serverVersionUnavailable")}</strong></div>
        <div><span>{t("settings.serverVisibility")}</span><strong>{t(server.visibility === "private" ? "settings.serverPrivate" : "settings.serverPublic")}</strong></div>
        <div><span>{t("settings.serverCreatedAt")}</span><strong>{auditTime(server.created_at_ms)}</strong></div>
        <div><span>{t("settings.memberCount")}</span><strong>{members.length}</strong></div>
        <div><span>{t("settings.channelCount")}</span><strong>{channels.length}</strong></div>
        <div><span>{t("settings.serverDefaultLanguage")}</span><strong>{languageOptions().find((option) => option.id === server.default_language)?.name ?? server.default_language}</strong></div>
      </div>
    </section>
    <section class="settings-section">
      <p class="section-label">{t("settings.featureFlags")}</p>
      <div class="server-detail-feature-list">
        {#each serverFeatures as feature}
          <div class:enabled={Boolean(server[feature.key])}>
            <span class="material-symbols-rounded app-icon" aria-hidden="true">{feature.icon}</span>
            <span><strong>{t(feature.labelKey)}</strong><small>{t(feature.descriptionKey)}</small></span>
            <span class="material-symbols-rounded app-icon" aria-hidden="true">{server[feature.key] ? "check_circle" : "cancel"}</span>
          </div>
        {/each}
      </div>
    </section>
  </div>
</div>
{/if}
