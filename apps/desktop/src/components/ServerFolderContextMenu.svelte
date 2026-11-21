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

{#if serverRail.folderContextMenu}
  <div class="server-folder-context-menu" role="menu" style={serverRail.folderContextMenuStyle()}>
    <button type="button" role="menuitem" onclick={() => void serverRail.renameFolderFromContextMenu()}>
      <span class="material-symbols-rounded app-icon" aria-hidden="true">edit</span>
      <span>{t("server.folderRename")}</span>
    </button>
    <button type="button" role="menuitem" onclick={() => serverRail.ungroupFolderFromContextMenu()}>
      <span class="material-symbols-rounded app-icon" aria-hidden="true">folder_off</span>
      <span>{t("server.folderUngroup")}</span>
    </button>
  </div>
{/if}
