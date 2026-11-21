<script lang="ts">
  import type { ServerSettingsController } from "../lib/server-settings.svelte";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type Props = {
    t: Translate;
    serverSettings: ServerSettingsController;
    onFlushAliases: () => void;
  };

  let {
    t,
    serverSettings,
    onFlushAliases
  }: Props = $props();

  function closeDialog() {
    serverSettings.closeGeneratedInviteDialog();
    onFlushAliases();
  }

  async function copyLink() {
    await serverSettings.copyGeneratedInviteLink();
  }
</script>

{#if serverSettings.generatedInviteLink}
<div class="dialog-backdrop generated-invite-dialog-backdrop" role="presentation" onmousedown={(event) => {
  if (event.target === event.currentTarget) closeDialog();
}}>
  <dialog class="generated-invite-dialog" open aria-modal="true" aria-label={t("invite.generatedTitle")}>
    <header>
      <span class="material-symbols-rounded app-icon" aria-hidden="true">link</span>
      <div>
        <h2>{t("invite.generatedTitle")}</h2>
        <p>{t("invite.generatedDescription")}</p>
      </div>
      <button type="button" title={t("app.close")} aria-label={t("app.close")} onclick={closeDialog}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
      </button>
    </header>
    <div class="generated-invite-dialog-body">
      <div class="generated-invite-link">
        <code>{serverSettings.generatedInviteLink}</code>
        <button type="button" aria-label={t("invite.copy")} onclick={() => void copyLink()}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">{serverSettings.copiedInviteId === "generated" ? "check" : "content_copy"}</span>
        </button>
      </div>
      <button class="primary generated-invite-copy-button" type="button" onclick={() => void copyLink()}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">{serverSettings.copiedInviteId === "generated" ? "check" : "content_copy"}</span>
        <span>{serverSettings.copiedInviteId === "generated" ? t("invite.copied") : t("invite.copy")}</span>
      </button>
    </div>
  </dialog>
</div>
{/if}
