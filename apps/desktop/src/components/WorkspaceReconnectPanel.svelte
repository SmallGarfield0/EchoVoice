<script lang="ts">
  // Reconnect panel: controller-based wiring. App-owned reconnect/credential
  // entry points are passed in; everything else reads WorkspaceController.
  import type { WorkspaceController } from "../lib/workspace.svelte";

  let {
    workspace,
    t,
    retryWorkspaceConnection,
    openWorkspaceCredentialDialog,
    realtimeSyncTick
  }: {
    workspace: WorkspaceController;
    t: (key: string, params?: Record<string, string | number>) => string;
    retryWorkspaceConnection: () => Promise<void>;
    openWorkspaceCredentialDialog: () => void;
    realtimeSyncTick: number;
  } = $props();

  const activeSavedServerValue = $derived.by(() => { realtimeSyncTick; return workspace.activeSavedServerValue; });
  const activeServerId = $derived.by(() => { realtimeSyncTick; return workspace.activeServerId; });
  const workspaceConnectionError = $derived.by(() => { realtimeSyncTick; return workspace.workspaceConnectionError; });
  const workspaceReconnectBusy = $derived.by(() => { realtimeSyncTick; return workspace.workspaceReconnectBusy; });
  const workspaceReconnectRequired = $derived.by(() => { realtimeSyncTick; return workspace.workspaceReconnectRequired; });

  function serverInitials(name: string) {
    return name.trim().slice(0, 2).toUpperCase() || "EV";
  }
</script>

{#if activeServerId && workspaceReconnectRequired}
  <section class="workspace-reconnect-panel" aria-live="polite" aria-busy={workspaceReconnectBusy}>
    <div class="workspace-reconnect-content">
      <div class="workspace-reconnect-server-mark">
        {#if activeSavedServerValue?.icon_data_url}
          <img src={activeSavedServerValue.icon_data_url} alt="" />
        {:else}
          {serverInitials(activeSavedServerValue?.name ?? "EchoVoice")}
        {/if}
      </div>
      <div class="workspace-reconnect-copy">
        <p class="eyebrow">{activeSavedServerValue?.name ?? "EchoVoice"}</p>
        <h1>{workspaceReconnectBusy ? t("workspace.reconnectingTitle") : t("workspace.connectionFailedTitle")}</h1>
        <p>{workspaceReconnectBusy ? t("workspace.reconnectingDescription") : t("workspace.connectionFailedDescription")}</p>
        {#if workspaceConnectionError}
          <p class="workspace-reconnect-error">
            <span class="material-symbols-rounded app-icon" aria-hidden="true">error</span>
            <span>{workspaceConnectionError}</span>
          </p>
        {/if}
        {#if activeSavedServerValue?.base_url}
          <code>{activeSavedServerValue.base_url}</code>
        {/if}
      </div>
      <div class="workspace-reconnect-actions">
        <button class="primary" type="button" disabled={workspaceReconnectBusy} onclick={() => void retryWorkspaceConnection()}>
          <span class="material-symbols-rounded app-icon" class:spinning={workspaceReconnectBusy} aria-hidden="true">
            {workspaceReconnectBusy ? "progress_activity" : "refresh"}
          </span>
          <span>{workspaceReconnectBusy ? t("workspace.reconnecting") : t("workspace.retry")}</span>
        </button>
        <button type="button" disabled={workspaceReconnectBusy} onclick={openWorkspaceCredentialDialog}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">key</span>
          <span>{t("workspace.updateConnection")}</span>
        </button>
      </div>
    </div>
  </section>
{/if}
