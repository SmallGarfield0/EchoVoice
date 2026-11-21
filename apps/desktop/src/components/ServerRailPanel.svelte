<script lang="ts">
  // Server rail: controller-based wiring. WorkspaceController supplies active
  // server/saved servers; ServerRailController owns drag, folders, tooltips and
  // context menus.
  import { avatarStyleVariables } from "../lib/avatar";
  import type { ServerRailFolderItem } from "../lib/serverRail";
  import type { ServerRailController } from "../lib/server-rail.svelte";
  import type { WorkspaceController } from "../lib/workspace.svelte";
  import type { StoredServer } from "../lib/types";

  let {
    serverRail,
    workspace,
    t,
    openConnectDialog,
    realtimeSyncTick,
    activeServerId
  }: {
    serverRail: ServerRailController;
    workspace: WorkspaceController;
    t: (key: string, params?: Record<string, string | number>) => string;
    openConnectDialog: () => void;
    realtimeSyncTick: number;
    activeServerId: string;
  } = $props();

  const localUserProfile = $derived.by(() => { realtimeSyncTick; return workspace.localUserProfile; });
  const serverRailSavedServersByID = $derived.by(() => {
    realtimeSyncTick;
    return new Map(workspace.savedServers.map((item) => [item.server_id, item]));
  });
  const currentMember = $derived.by(() => { realtimeSyncTick; return workspace.members.find((member) => member.member_id === workspace.memberId); });
  const currentUserDisplayNameValue = $derived(
    currentMember?.display_name || localUserProfile.display_name || workspace.displayName || "EchoVoice User"
  );

  const serverRailLayout = $derived(serverRail.layout);
  const serverRailDrag = $derived(serverRail.drag);
  const serverRailDropTarget = $derived(serverRail.dropTarget);
  const serverRailSuppressClickUntil = $derived(serverRail.suppressClickUntil);

  function activateSavedServer(savedServer: StoredServer, event: MouseEvent) {
    return workspace.activateSavedServer(savedServer, event);
  }
  const handleServerRailPointerCancel = (type: "server" | "folder", id: string, event: PointerEvent) => serverRail.handlePointerCancel(type, id, event);
  const handleServerRailPointerDown = (type: "server" | "folder", id: string, event: PointerEvent) => serverRail.handlePointerDown(type, id, event);
  const handleServerRailPointerMove = (type: "server" | "folder", id: string, event: PointerEvent) => serverRail.handlePointerMove(type, id, event);
  const handleServerRailPointerUp = (type: "server" | "folder", id: string, event: PointerEvent) => serverRail.handlePointerUp(type, id, event);
  const hideServerRailTooltip = (key = "") => serverRail.hideTooltip(key);
  const openServerContextMenu = (savedServer: StoredServer, event: MouseEvent) => serverRail.openServerContextMenu(savedServer, event);
  const openServerFolderContextMenu = (folder: ServerRailFolderItem, event: MouseEvent) => serverRail.openFolderContextMenu(folder, event);
  const serverRailFolderDisplayName = (folder: ServerRailFolderItem, serversByID = serverRailSavedServersByID) => serverRail.folderDisplayName(folder, serversByID);
  const showServerRailTooltip = (key: string, label: string, event: Event) => serverRail.showTooltip(key, label, event);
  const toggleServerRailFolder = (folder: ServerRailFolderItem) => serverRail.toggleFolder(folder);

  function serverInitials(name: string) {
    return name.trim().slice(0, 2).toUpperCase() || "EV";
  }
</script>

<aside class="server-rail">
  <button class="server-mark" class:has-avatar={Boolean(localUserProfile.avatar_data_url)} style={avatarStyleVariables(localUserProfile.avatar_color, localUserProfile.local_profile_id)} type="button" aria-label={currentUserDisplayNameValue} onclick={() => workspace.openAppSettings()}>
    {#if localUserProfile.avatar_data_url}
      <img src={localUserProfile.avatar_data_url} alt="" />
    {:else}
      <span>{serverInitials(currentUserDisplayNameValue)}</span>
    {/if}
  </button>
  <div class="server-rail-divider" aria-hidden="true"></div>
  <div
    class="server-rail-items"
    class:dragging={Boolean(serverRailDrag)}
    role="list"
    aria-label={t("server.list")}
    onscroll={() => hideServerRailTooltip()}
  >
    {#each serverRailLayout.items as railItem, railIndex (railItem.type === "server" ? `server:${railItem.server_id}` : `folder:${railItem.folder_id}`)}
      <div
        class="server-rail-drop-zone"
        role="separator"
        aria-orientation="horizontal"
        data-server-rail-top-drop-index={railIndex}
        class:active={serverRailDropTarget?.type === "top-level" && serverRailDropTarget.index === railIndex}
      ></div>
      {#if railItem.type === "server"}
        {@const savedServer = serverRailSavedServersByID.get(railItem.server_id)}
        {#if savedServer}
          <div
            class="server-button-wrap"
            role="listitem"
            class:active={activeServerId === savedServer.server_id}
            class:dragging={serverRailDrag?.type === "server" && serverRailDrag.id === savedServer.server_id}
            class:merge-target={serverRailDropTarget?.type === "merge" && serverRailDropTarget.serverId === savedServer.server_id}
            data-server-rail-server-id={savedServer.server_id}
            data-server-rail-item-index={railIndex}
          >
            <button
              class="server-button"
              class:active={activeServerId === savedServer.server_id}
              class:has-icon={Boolean(savedServer.icon_data_url)}
              type="button"
              aria-label={savedServer.name}
              ondragstart={(event) => { event.preventDefault(); }}
              onpointerdown={(event) => handleServerRailPointerDown("server", savedServer.server_id, event)}
              onpointermove={(event) => handleServerRailPointerMove("server", savedServer.server_id, event)}
              onpointerup={(event) => handleServerRailPointerUp("server", savedServer.server_id, event)}
              onpointercancel={(event) => handleServerRailPointerCancel("server", savedServer.server_id, event)}
              onpointerenter={(event) => showServerRailTooltip(`server:${savedServer.server_id}`, savedServer.name, event)}
              onclick={(event) => {
                if (Date.now() >= serverRailSuppressClickUntil) activateSavedServer(savedServer, event);
              }}
              onpointerleave={() => hideServerRailTooltip(`server:${savedServer.server_id}`)}
              onfocus={(event) => showServerRailTooltip(`server:${savedServer.server_id}`, savedServer.name, event)}
              onblur={() => hideServerRailTooltip(`server:${savedServer.server_id}`)}
              oncontextmenu={(event) => {
                hideServerRailTooltip();
                openServerContextMenu(savedServer, event);
              }}
            >
              {#if savedServer.icon_data_url}
                <img src={savedServer.icon_data_url} alt="" draggable="false" />
              {:else}
                {serverInitials(savedServer.name)}
              {/if}
            </button>
          </div>
        {/if}
      {:else}
        {@const folderDisplayName = serverRailFolderDisplayName(railItem, serverRailSavedServersByID)}
        <div
          class="server-folder"
          class:expanded={!railItem.collapsed}
          class:dragging={serverRailDrag?.type === "folder" && serverRailDrag.id === railItem.folder_id}
          data-server-rail-folder-id={railItem.folder_id}
          data-server-rail-item-index={railIndex}
        >
          <div
            class="server-button-wrap server-folder-wrap"
            role="group"
            class:folder-drop-target={serverRailDropTarget?.type === "folder" && serverRailDropTarget.folderId === railItem.folder_id}
          >
            <button
              class="server-folder-button"
              type="button"
              aria-label={folderDisplayName}
              aria-expanded={!railItem.collapsed}
              ondragstart={(event) => { event.preventDefault(); }}
              onpointerdown={(event) => handleServerRailPointerDown("folder", railItem.folder_id, event)}
              onpointermove={(event) => handleServerRailPointerMove("folder", railItem.folder_id, event)}
              onpointerup={(event) => handleServerRailPointerUp("folder", railItem.folder_id, event)}
              onpointercancel={(event) => handleServerRailPointerCancel("folder", railItem.folder_id, event)}
              onpointerenter={(event) => showServerRailTooltip(`folder:${railItem.folder_id}`, folderDisplayName, event)}
              onpointerleave={() => hideServerRailTooltip(`folder:${railItem.folder_id}`)}
              onfocus={(event) => showServerRailTooltip(`folder:${railItem.folder_id}`, folderDisplayName, event)}
              onblur={() => hideServerRailTooltip(`folder:${railItem.folder_id}`)}
              onclick={(event) => {
                hideServerRailTooltip();
                (event.currentTarget as HTMLButtonElement).blur();
                if (Date.now() >= serverRailSuppressClickUntil) toggleServerRailFolder(railItem);
              }}
              oncontextmenu={(event) => {
                hideServerRailTooltip();
                openServerFolderContextMenu(railItem, event);
              }}
            >
              <span class="server-folder-grid" aria-hidden="true">
                {#each railItem.server_ids.slice(0, 4) as childServerID}
                  {@const childServer = serverRailSavedServersByID.get(childServerID)}
                  {#if childServer?.icon_data_url}
                    <img src={childServer.icon_data_url} alt="" draggable="false" />
                  {:else}
                    <span>{serverInitials(childServer?.name ?? "EV").slice(0, 1)}</span>
                  {/if}
                {/each}
              </span>
            </button>
          </div>
          {#if !railItem.collapsed}
            <div class="server-folder-children">
              {#each railItem.server_ids as childServerID, childIndex (childServerID)}
                <div
                  class="server-folder-drop-zone"
                  role="separator"
                  aria-orientation="horizontal"
                  data-server-rail-folder-id={railItem.folder_id}
                  data-server-rail-folder-drop-index={childIndex}
                  class:active={serverRailDropTarget?.type === "folder" && serverRailDropTarget.folderId === railItem.folder_id && serverRailDropTarget.index === childIndex}
                ></div>
                {@const childServer = serverRailSavedServersByID.get(childServerID)}
                {#if childServer}
                  <div
                    class="server-button-wrap"
                    class:active={activeServerId === childServer.server_id}
                    class:dragging={serverRailDrag?.type === "server" && serverRailDrag.id === childServer.server_id}
                    data-server-rail-server-id={childServer.server_id}
                    data-server-rail-folder-id={railItem.folder_id}
                    data-server-rail-child-index={childIndex}
                  >
                    <button
                      class="server-button"
                      class:active={activeServerId === childServer.server_id}
                      class:has-icon={Boolean(childServer.icon_data_url)}
                      type="button"
                      aria-label={childServer.name}
                      ondragstart={(event) => { event.preventDefault(); }}
                      onpointerdown={(event) => handleServerRailPointerDown("server", childServer.server_id, event)}
                      onpointermove={(event) => handleServerRailPointerMove("server", childServer.server_id, event)}
                      onpointerup={(event) => handleServerRailPointerUp("server", childServer.server_id, event)}
                      onpointercancel={(event) => handleServerRailPointerCancel("server", childServer.server_id, event)}
                      onpointerenter={(event) => showServerRailTooltip(`server:${childServer.server_id}`, childServer.name, event)}
                      onpointerleave={() => hideServerRailTooltip(`server:${childServer.server_id}`)}
                      onfocus={(event) => showServerRailTooltip(`server:${childServer.server_id}`, childServer.name, event)}
                      onblur={() => hideServerRailTooltip(`server:${childServer.server_id}`)}
                      onclick={(event) => {
                        if (Date.now() >= serverRailSuppressClickUntil) activateSavedServer(childServer, event);
                      }}
                      oncontextmenu={(event) => {
                        hideServerRailTooltip();
                        openServerContextMenu(childServer, event);
                      }}
                    >
                      {#if childServer.icon_data_url}
                        <img src={childServer.icon_data_url} alt="" draggable="false" />
                      {:else}
                        {serverInitials(childServer.name)}
                      {/if}
                    </button>
                  </div>
                {/if}
              {/each}
              <div
                class="server-folder-drop-zone"
                role="separator"
                aria-orientation="horizontal"
                data-server-rail-folder-id={railItem.folder_id}
                data-server-rail-folder-drop-index={railItem.server_ids.length}
                class:active={serverRailDropTarget?.type === "folder" && serverRailDropTarget.folderId === railItem.folder_id && serverRailDropTarget.index === railItem.server_ids.length}
              ></div>
            </div>
          {/if}
        </div>
      {/if}
    {/each}
    <div
      class="server-rail-drop-zone"
      role="separator"
      aria-orientation="horizontal"
      data-server-rail-top-drop-index={serverRailLayout.items.length}
      class:active={serverRailDropTarget?.type === "top-level" && serverRailDropTarget.index === serverRailLayout.items.length}
    ></div>
  </div>
  <div class="rail-button-wrap">
    <button
      class="rail-button"
      type="button"
      aria-label={t("app.addServerTitle")}
      onpointerenter={(event) => showServerRailTooltip("add-server", t("app.addServerTitle"), event)}
      onpointerleave={() => hideServerRailTooltip("add-server")}
      onfocus={(event) => showServerRailTooltip("add-server", t("app.addServerTitle"), event)}
      onblur={() => hideServerRailTooltip("add-server")}
      onclick={() => {
        hideServerRailTooltip();
        openConnectDialog();
      }}
    >
      <span class="material-symbols-rounded app-icon" aria-hidden="true">add</span>
    </button>
  </div>
</aside>
