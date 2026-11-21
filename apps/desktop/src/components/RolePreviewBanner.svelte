<script lang="ts">
  // Role preview banner. Role state lives in PermissionsController.
  import type { PermissionsController } from "../lib/permissions.svelte";

  let {
    t,
    permissionsController
  }: {
    t: (key: string, params?: Record<string, string | number>) => string;
    permissionsController: PermissionsController;
  } = $props();

  const rolePreviewId = $derived(permissionsController.rolePreviewId);
  const previewRole = $derived(permissionsController.roleById(rolePreviewId));
  const stopRolePreview = () => permissionsController.stopRolePreview();
</script>

{#if rolePreviewId && previewRole}
  <div class="role-preview-banner">
    <span class="material-symbols-rounded app-icon" aria-hidden="true">visibility</span>
    <span>{t("roles.previewingAs", { role: previewRole?.name ?? "" })}</span>
    <button type="button" onclick={stopRolePreview}>{t("roles.exitPreview")}</button>
  </div>
{/if}
