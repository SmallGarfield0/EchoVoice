<script lang="ts">
  import type { ServerRailController } from "../lib/server-rail.svelte";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  let {
    t,
    serverRail
  }: {
    t: Translate;
    serverRail: ServerRailController;
  } = $props();
</script>

{#if serverRail.serverContextMenu}
  <div class="server-context-menu" role="menu" style={serverRail.serverContextMenuStyle()}>
    <button class="danger" type="button" role="menuitem" disabled={serverRail.leaveBusy} onclick={() => void serverRail.leaveFromContextMenu()}>
      <span class="material-symbols-rounded app-icon" aria-hidden="true">logout</span>
      <span>{t("server.leave")}</span>
    </button>
    <div class="server-context-menu-separator"></div>
    <button class="danger" type="button" role="menuitem" disabled={serverRail.leaveBusy} onclick={() => void serverRail.removeFromContextMenu()}>
      <span class="material-symbols-rounded app-icon" aria-hidden="true">delete</span>
      <span>{t("server.removeFromDevice")}</span>
    </button>
  </div>
{/if}
