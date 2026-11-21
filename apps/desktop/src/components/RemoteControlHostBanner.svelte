<script lang="ts">
  // Hosted remote-control banner. Session data and decisions come from
  // RemoteControlController; only the permission flag stays App-provided.
  import type { PermissionsController } from "../lib/permissions.svelte";
  import type { RemoteControlController } from "../lib/remote-control.svelte";
  import type { WorkspaceController } from "../lib/workspace.svelte";
  import type { RemoteControlSession } from "../lib/types";

  let {
    t,
    workspace,
    permissionsController,
    remoteControl,
    canHostRemoteControl,
    realtimeSyncTick
  }: {
    t: (key: string, params?: Record<string, string | number>) => string;
    workspace: WorkspaceController;
    permissionsController: PermissionsController;
    remoteControl: RemoteControlController;
    canHostRemoteControl: boolean;
    realtimeSyncTick: number;
  } = $props();

  const hostedRemoteControl = $derived.by(() => {
    realtimeSyncTick;
    return remoteControl.sessions.find(
      (control) => control.owner_member_id === workspace.memberId && control.status === "active"
    );
  });
  const hostedPendingRemoteControl = $derived.by(() => {
    realtimeSyncTick;
    return remoteControl.sessions.find(
      (control) => control.owner_member_id === workspace.memberId && control.status === "pending"
    );
  });
  const remoteControlBusyId = $derived(remoteControl.busyId);
  const memberDisplayName = (id: string) => permissionsController.memberDisplayName(id);
  const remoteControlIsSuspended = (control: RemoteControlSession | undefined) => remoteControl.isSuspended(control);
  const remoteControlRespectSeconds = (control: RemoteControlSession | undefined) => remoteControl.respectSeconds(control);
  const decideRemoteControl = (control: RemoteControlSession, action: "approve" | "reject") => remoteControl.decide(control, action);
  const revokeRemoteControl = (control: RemoteControlSession) => remoteControl.revoke(control);
</script>

{#if !workspace.screenSharePopoutMode && hostedRemoteControl}
  <aside class="remote-control-host-banner" role="status" aria-live="polite" data-remote-control-host-active>
    <span class="remote-control-host-banner-icon material-symbols-rounded app-icon" aria-hidden="true">
      {remoteControlIsSuspended(hostedRemoteControl) ? "front_hand" : "keyboard_external_input"}
    </span>
    <div>
      <strong>{t("remoteControl.hostActive", { name: memberDisplayName(hostedRemoteControl.controller_member_id) })}</strong>
      <span>
        {remoteControlIsSuspended(hostedRemoteControl)
          ? t("remoteControl.suspendedSeconds", { seconds: remoteControlRespectSeconds(hostedRemoteControl) })
          : t("remoteControl.hostActiveDescription")}
      </span>
    </div>
    <button
      type="button"
      disabled={Boolean(remoteControlBusyId)}
      onclick={() => void revokeRemoteControl(hostedRemoteControl)}
    >
      <span class="material-symbols-rounded app-icon" aria-hidden="true">link_off</span>
      <span>{t("remoteControl.revoke")}</span>
    </button>
  </aside>
{:else if !workspace.screenSharePopoutMode && hostedPendingRemoteControl}
  <aside class="remote-control-host-banner request" role="alert" data-remote-control-host-request>
    <span class="remote-control-host-banner-icon material-symbols-rounded app-icon" aria-hidden="true">person_alert</span>
    <div>
      <strong>{t("remoteControl.hostRequest", { name: memberDisplayName(hostedPendingRemoteControl.controller_member_id) })}</strong>
      <span>{t("remoteControl.hostRequestDescription")}</span>
    </div>
    <div class="remote-control-host-banner-actions">
      <button
        class="approve"
        type="button"
        disabled={Boolean(remoteControlBusyId) || !canHostRemoteControl}
        onclick={() => void decideRemoteControl(hostedPendingRemoteControl, "approve")}
      >
        <span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>
        <span>{t("remoteControl.approve")}</span>
      </button>
      <button
        type="button"
        disabled={Boolean(remoteControlBusyId)}
        onclick={() => void decideRemoteControl(hostedPendingRemoteControl, "reject")}
      >
        <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
        <span>{t("remoteControl.reject")}</span>
      </button>
    </div>
  </aside>
{/if}
