<script lang="ts">
  import type { ScreenShareSetupController } from "../lib/screen-share-setup.svelte";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type Props = {
    t: Translate;
    screenShareSetup: ScreenShareSetupController;
  };

  let { t, screenShareSetup }: Props = $props();
</script>

{#if screenShareSetup.sourceDialogOpen}
<div class="screen-share-picker-overlay" role="presentation">
  <dialog
    class="screen-share-picker-window"
    open
    aria-modal="true"
    aria-label={t("screenShare.source")}
  >
    <header class="screen-share-picker-header">
      <div>
        <p>{t("screenShare.source")}</p>
        <span>{screenShareSetup.sourceDialogStatus()}</span>
      </div>
      <button
        type="button"
        data-tooltip={t("screenShare.refreshSources")}
        aria-label={t("screenShare.refreshSources")}
        disabled={screenShareSetup.desktopCaptureSourcesLoading}
        onclick={() => void screenShareSetup.refreshDesktopCaptureSources()}
      >
        <span class="material-symbols-rounded app-icon" aria-hidden="true">refresh</span>
      </button>
    </header>
    {#if screenShareSetup.desktopCaptureSourcesLoading}
      <div class="screen-share-picker-state">
        <span class="material-symbols-rounded app-icon" aria-hidden="true">hourglass_empty</span>
        <span>{t("screenShare.sourcesLoading")}</span>
      </div>
    {:else if screenShareSetup.desktopCaptureSources.length > 0}
      <section class="screen-share-picker-groups" aria-label={t("screenShare.source")}>
        {#if screenShareSetup.desktopCaptureScreenSources.length > 0}
          <section class="screen-share-picker-group" aria-label={t("screenShare.sourceScreens")}>
            <h3>{t("screenShare.sourceScreens")}</h3>
            <div class="screen-share-picker-grid">
              {#each screenShareSetup.desktopCaptureScreenSources as source}
                <button
                  type="button"
                  class:active={screenShareSetup.selectedDesktopCaptureSourceId === source.sourceId}
                  onclick={() => screenShareSetup.selectDesktopCaptureSource(source)}
                  ondblclick={() => void screenShareSetup.confirmDesktopCaptureSourceSelection()}
                >
                  <span class="screen-share-picker-preview">
                    {#if source.thumbnailDataUrl}
                      <img src={source.thumbnailDataUrl} alt="" />
                    {:else}
                      <span class="material-symbols-rounded app-icon" aria-hidden="true">{screenShareSetup.desktopCaptureSourceIcon(source)}</span>
                    {/if}
                  </span>
                  <span class="screen-share-picker-source-name">{source.name}</span>
                  <span class="screen-share-picker-source-meta">{screenShareSetup.desktopCaptureSourceMeta(source)}</span>
                </button>
              {/each}
            </div>
          </section>
        {/if}
        {#if screenShareSetup.desktopCaptureWindowSources.length > 0}
          <section class="screen-share-picker-group" aria-label={t("screenShare.sourceWindows")}>
            <h3>{t("screenShare.sourceWindows")}</h3>
            <div class="screen-share-picker-grid">
              {#each screenShareSetup.desktopCaptureWindowSources as source}
                <button
                  type="button"
                  class:active={screenShareSetup.selectedDesktopCaptureSourceId === source.sourceId}
                  onclick={() => screenShareSetup.selectDesktopCaptureSource(source)}
                  ondblclick={() => void screenShareSetup.confirmDesktopCaptureSourceSelection()}
                >
                  <span class="screen-share-picker-preview">
                    {#if source.thumbnailDataUrl}
                      <img src={source.thumbnailDataUrl} alt="" />
                    {:else}
                      <span class="material-symbols-rounded app-icon" aria-hidden="true">{screenShareSetup.desktopCaptureSourceIcon(source)}</span>
                    {/if}
                  </span>
                  <span class="screen-share-picker-source-name">{source.name}</span>
                  <span class="screen-share-picker-source-meta">{screenShareSetup.desktopCaptureSourceMeta(source)}</span>
                </button>
              {/each}
            </div>
          </section>
        {/if}
      </section>
    {:else}
      <div class="screen-share-picker-state">
        <span class="material-symbols-rounded app-icon" aria-hidden="true">desktop_windows</span>
        <span>{screenShareSetup.desktopCaptureSourceError || t("screenShare.sourcesEmpty")}</span>
      </div>
    {/if}
    <footer class="screen-share-picker-actions">
      <button type="button" onclick={() => screenShareSetup.closeSourceDialog()}>
        <span>{t("common.cancel")}</span>
      </button>
      <button
        type="button"
        class="primary"
        aria-label={screenShareSetup.desktopNativeScreenShareUnavailable() ? t("error.screenShareNativeSenderUnavailable") : t("screenShare.useSelectedSource")}
        disabled={!screenShareSetup.selectedDesktopCaptureSource || screenShareSetup.desktopCaptureSourcesLoading}
        onclick={() => void screenShareSetup.confirmDesktopCaptureSourceSelection()}
      >
        <span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>
        <span>{t("screenShare.useSelectedSource")}</span>
      </button>
    </footer>
  </dialog>
</div>
{/if}
