<script lang="ts">
  import type { ServerSettingsController } from "../lib/server-settings.svelte";
  import type { ServerInvite } from "../lib/types";
  import NumericInput from "./NumericInput.svelte";

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

  function flush() {
    onFlushAliases();
  }

  function closeDialog() {
    serverSettings.closeInviteDialog();
    flush();
  }

  function setExpiry(seconds: number) {
    serverSettings.inviteExpiresInSeconds = seconds;
    flush();
  }

  function setMaxUses(value: number) {
    serverSettings.inviteMaxUses = value;
  }

  async function createInvite() {
    await serverSettings.createInviteFromDialog();
    flush();
  }

  async function revoke(invite: ServerInvite) {
    await serverSettings.revokeInvite(invite.invite_id);
    flush();
  }

  async function copyLink(invite: ServerInvite) {
    await serverSettings.copyInviteLink(serverSettings.inviteLink(invite), invite.invite_id);
  }
</script>

{#if serverSettings.inviteDialogOpen}
<div class="dialog-backdrop invite-dialog-backdrop" role="presentation" onmousedown={(event) => {
  if (event.target === event.currentTarget) closeDialog();
}}>
  <dialog class="invite-dialog" open aria-modal="true" aria-label={t("invite.title")}>
    <header>
      <div>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">person_add</span>
        <div>
          <h2>{t("invite.title")}</h2>
          <p>{t("invite.description")}</p>
        </div>
      </div>
      <button type="button" aria-label={t("app.close")} onclick={closeDialog}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
      </button>
    </header>
    <div class="invite-dialog-body">
      <section class="invite-create-panel">
        <span class="field-label">{t("invite.expiry")}</span>
        <div class="invite-expiry-options" role="radiogroup" aria-label={t("invite.expiry")}>
          {#each [30 * 60, 24 * 60 * 60, 7 * 24 * 60 * 60, 0] as expirySeconds}
            <button type="button" role="radio" class:active={serverSettings.inviteExpiresInSeconds === expirySeconds} aria-checked={serverSettings.inviteExpiresInSeconds === expirySeconds} disabled={serverSettings.inviteActionBusy} onclick={() => setExpiry(expirySeconds)}>
              {serverSettings.inviteExpiryOptionLabel(expirySeconds)}
            </button>
          {/each}
        </div>
        <span class="field-label">{t("invite.maxUses")}</span>
        <NumericInput
          value={serverSettings.inviteMaxUses}
          min={1}
          max={1000}
          step={1}
          disabled={serverSettings.inviteActionBusy}
          ariaLabel={t("invite.maxUses")}
          decreaseLabel={t("app.decreaseValue", { name: t("invite.maxUses") })}
          increaseLabel={t("app.increaseValue", { name: t("invite.maxUses") })}
          onValueChange={setMaxUses}
        />
        <button class="primary invite-create-button" type="button" disabled={serverSettings.inviteActionBusy} onclick={() => void createInvite()}>
          <span class="material-symbols-rounded app-icon" class:spinning={serverSettings.inviteActionBusy} aria-hidden="true">{serverSettings.inviteActionBusy ? "progress_activity" : "add_link"}</span>
          <span>{t("invite.create")}</span>
        </button>
      </section>
      <section class="invite-list-panel">
        <div class="invite-list-heading">
          <strong>{t("invite.activeInvites")}</strong>
          <span>{serverSettings.serverInvites.length}</span>
        </div>
        <div class="invite-list">
          {#if serverSettings.serverInvites.length === 0 && !serverSettings.inviteActionBusy}
            <p>{t("invite.empty")}</p>
          {/if}
          {#each serverSettings.serverInvites as invite (invite.invite_id)}
            <div class="invite-row">
              <span class="material-symbols-rounded app-icon" aria-hidden="true">link</span>
              <div>
                <strong>{t("invite.usage", { used: invite.use_count, maximum: invite.max_uses })}</strong>
                <small>{serverSettings.inviteStatusLabel(invite)}</small>
              </div>
              <div class="invite-row-actions">
                <button
                  type="button"
                  disabled={serverSettings.inviteActionBusy || !invite.token}
                  title={invite.token ? t("invite.copy") : t("invite.copyUnavailable")}
                  aria-label={invite.token ? t("invite.copy") : t("invite.copyUnavailable")}
                  onclick={() => void copyLink(invite)}
                >
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">{serverSettings.copiedInviteId === invite.invite_id ? "check" : "content_copy"}</span>
                </button>
                <button class="danger-icon-button" type="button" disabled={serverSettings.inviteActionBusy} aria-label={t("invite.revoke")} onclick={() => void revoke(invite)}>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">delete</span>
                </button>
              </div>
            </div>
          {/each}
        </div>
      </section>
    </div>
  </dialog>
</div>
{/if}
