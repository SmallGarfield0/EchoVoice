<script lang="ts">
  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type ConnectMode = "address" | "invite";

  type Props = {
    t: Translate;
    open: boolean;
    connectMode: ConnectMode;
    connectBaseUrl: string;
    connectPassword: string;
    connectInviteLink: string;
    connectBusy: boolean;
    connectError: string;
    nativeDesktopRuntime: boolean;
    webDevelopmentRuntime: boolean;
    defaultServerBaseUrl: string;
    webServerURLPlaceholder: string;
    onConnect: () => void;
    onClose: () => void;
  };

  let {
    t,
    open,
    connectMode = $bindable("address" as ConnectMode),
    connectBaseUrl = $bindable(""),
    connectPassword = $bindable(""),
    connectInviteLink = $bindable(""),
    connectBusy,
    connectError,
    nativeDesktopRuntime,
    webDevelopmentRuntime,
    defaultServerBaseUrl,
    webServerURLPlaceholder,
    onConnect,
    onClose
  }: Props = $props();
</script>

{#if open}
<div class="dialog-backdrop" role="presentation">
  <section class="connect-dialog" aria-label={t("app.addServerTitle")}>
    <header>
      <h2>{t("app.addServerTitle")}</h2>
      <button type="button" onclick={onClose}>{t("app.close")}</button>
    </header>

    <div class="connection-form">
      <div class="connect-mode-tabs" role="tablist" aria-label={t("invite.connectMode")}>
        <button type="button" role="tab" class:active={connectMode === "address"} aria-selected={connectMode === "address"} disabled={connectBusy} onclick={() => (connectMode = "address")}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">dns</span>
          <span>{t("invite.addressTab")}</span>
        </button>
        <button type="button" role="tab" class:active={connectMode === "invite"} aria-selected={connectMode === "invite"} disabled={connectBusy} onclick={() => (connectMode = "invite")}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">link</span>
          <span>{t("invite.linkTab")}</span>
        </button>
      </div>
      {#if !nativeDesktopRuntime}
        <div class="web-https-notice" id="web-server-https-notice">
          <span class="material-symbols-rounded app-icon" aria-hidden="true">{webDevelopmentRuntime ? "science" : "lock"}</span>
          <div>
            <strong>{t(webDevelopmentRuntime ? "form.webDevelopmentTitle" : "form.webHttpsOnlyTitle")}</strong>
            <span>{t(webDevelopmentRuntime ? "form.webDevelopmentDescription" : "form.webHttpsOnlyDescription")}</span>
          </div>
        </div>
      {/if}
      {#if connectMode === "address"}
        <label>
          {t("form.server")}
          <input
            bind:value={connectBaseUrl}
            disabled={connectBusy}
            placeholder={nativeDesktopRuntime || webDevelopmentRuntime ? defaultServerBaseUrl : webServerURLPlaceholder}
            aria-describedby={nativeDesktopRuntime ? undefined : "web-server-https-notice"}
            autocomplete="url"
            spellcheck="false"
          />
          <small>{t("invite.addressAcceptsLink")}</small>
        </label>
        <label>
          {t("form.password")}
          <input bind:value={connectPassword} type="password" autocomplete="current-password" placeholder={t("form.passwordOptional")} disabled={connectBusy} />
        </label>
      {:else}
        <label>
          {t("invite.link")}
          <input bind:value={connectInviteLink} disabled={connectBusy} placeholder="https://voice.example.com/invite/..." autocomplete="url" spellcheck="false" />
        </label>
      {/if}
      <button class="connection-submit-button" type="button" disabled={connectBusy} aria-busy={connectBusy} onclick={() => void onConnect()}>
        {#if connectBusy}
          <span class="material-symbols-rounded app-icon connection-spinner" aria-hidden="true">progress_activity</span>
        {/if}
        <span>{connectBusy ? t("status.connecting") : t("form.connect")}</span>
      </button>
      {#if connectError}
        <p class="error">{connectError}</p>
      {/if}
    </div>
  </section>
</div>
{/if}
