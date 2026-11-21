<script lang="ts">
  // Custom desktop window titlebar. Window controls call storage directly and
  // keep the maximized state local to this component.
  import { onMount } from "svelte";
  import type { ChannelsController } from "../lib/channels.svelte";
  import type { WorkspaceController } from "../lib/workspace.svelte";
  import {
    closeDesktopWindow,
    isDesktopWindowMaximized,
    minimizeDesktopWindow,
    startDraggingDesktopWindow,
    toggleMaximizeDesktopWindow
  } from "../lib/storage";

  let {
    t,
    workspace,
    channelsController,
    appIconURL,
    realtimeSyncTick
  }: {
    t: (key: string, params?: Record<string, string | number>) => string;
    workspace: WorkspaceController;
    channelsController: ChannelsController;
    appIconURL: string;
    realtimeSyncTick: number;
  } = $props();

  let desktopWindowMaximized = $state(false);
  const server = $derived.by(() => { realtimeSyncTick; return workspace.server; });
  const selectedChannel = $derived(
    channelsController.channels.find((channel) => channel.channel_id === channelsController.selectedChannelId)
  );
  const selectedChannelName = $derived(
    selectedChannel ? channelsController.channelNameForDisplay(selectedChannel) : ""
  );

  onMount(() => {
    void isDesktopWindowMaximized().then((maximized) => (desktopWindowMaximized = maximized));
    const sync = () => {
      void isDesktopWindowMaximized().then((maximized) => (desktopWindowMaximized = maximized));
    };
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
  });

  function startDesktopWindowDrag(event: MouseEvent) {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    if (event.detail >= 2) {
      void toggleDesktopWindowSize();
      return;
    }
    void startDraggingDesktopWindow();
  }

  async function toggleDesktopWindowSize() {
    desktopWindowMaximized = await toggleMaximizeDesktopWindow();
  }
</script>

<header
  class="desktop-titlebar"
  role="toolbar"
  tabindex="-1"
  aria-label={t("app.windowControls")}
  data-tauri-drag-region
  onmousedown={startDesktopWindowDrag}
>
  <div class="desktop-titlebar-brand" data-tauri-drag-region>
    <span class="desktop-titlebar-mark"><img src={appIconURL} alt="" /></span>
    <strong>EchoVoice</strong>
  </div>
  <div class="desktop-titlebar-context" data-tauri-drag-region>
    <span>{server?.name ?? "EchoVoice"}</span>
    {#if selectedChannel}
      <span class="desktop-titlebar-separator">/</span>
      <span>{selectedChannelName}</span>
    {/if}
  </div>
  <div class="desktop-window-controls">
    <button type="button" title={t("app.minimize")} aria-label={t("app.minimize")} onmousedown={(event) => { event.stopPropagation(); }} ondblclick={(event) => { event.stopPropagation(); }} onclick={() => void minimizeDesktopWindow()}>
      <span class="material-symbols-rounded app-icon desktop-window-icon desktop-window-minimize-icon" aria-hidden="true">remove</span>
    </button>
    <button type="button" title={desktopWindowMaximized ? t("app.restore") : t("app.maximize")} aria-label={desktopWindowMaximized ? t("app.restore") : t("app.maximize")} onmousedown={(event) => { event.stopPropagation(); }} ondblclick={(event) => { event.stopPropagation(); }} onclick={() => void toggleDesktopWindowSize()}>
      <span
        class="material-symbols-rounded app-icon desktop-window-icon"
        class:desktop-window-restore-icon={desktopWindowMaximized}
        class:desktop-window-maximize-icon={!desktopWindowMaximized}
        aria-hidden="true"
      >{desktopWindowMaximized ? "filter_none" : "crop_square"}</span>
    </button>
    <button class="desktop-window-close" type="button" title={t("app.close")} aria-label={t("app.close")} onmousedown={(event) => { event.stopPropagation(); }} ondblclick={(event) => { event.stopPropagation(); }} onclick={() => void closeDesktopWindow()}>
      <span class="material-symbols-rounded app-icon desktop-window-icon desktop-window-close-icon" aria-hidden="true">close</span>
    </button>
  </div>
</header>
