<script lang="ts">
  import { maximumAccompanimentSendVolumePercent, type AccompanimentController } from "../lib/accompaniment.svelte";
  import { accompanimentSourceDisplayName } from "../lib/accompaniment";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type Props = {
    t: Translate;
    accompaniment: AccompanimentController;
    nativeDesktopRuntime: boolean;
    formatFileSize: (bytes: number) => string;
    voiceRangeProgress: (value: number, max: number) => number;
    setWebAccompanimentFileInput: (element: HTMLInputElement | null) => void;
  };

  let {
    t,
    accompaniment,
    nativeDesktopRuntime,
    formatFileSize,
    voiceRangeProgress,
    setWebAccompanimentFileInput
  }: Props = $props();

  let fileInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    setWebAccompanimentFileInput(fileInput);
    return () => setWebAccompanimentFileInput(null);
  });
</script>

{#if accompaniment.dialogOpen}
<div class="screen-share-config-overlay" role="presentation" onmousedown={(event) => {
  if (event.target === event.currentTarget) accompaniment.closeDialog();
}}>
  <dialog class="accompaniment-picker-dialog" open aria-modal="true" aria-label={t("accompaniment.selectSource")}>
    <header>
      <div>
        <p class="section-label">{t("accompaniment.title")}</p>
        <h2>{nativeDesktopRuntime ? t("accompaniment.selectProcess") : t("accompaniment.selectFile")}</h2>
      </div>
      <button type="button" aria-label={t("app.close")} onclick={() => accompaniment.closeDialog()}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
      </button>
    </header>
    <p class="accompaniment-picker-description">
      {nativeDesktopRuntime ? t("accompaniment.selectProcessDescription") : t("accompaniment.selectFileDescription")}
    </p>
    {#if nativeDesktopRuntime}
      {#if accompaniment.sourcesLoading}
        <div class="screen-share-picker-state">
          <span class="material-symbols-rounded app-icon" aria-hidden="true">hourglass_empty</span>
          <span>{t("accompaniment.sourcesLoading")}</span>
        </div>
      {:else if accompaniment.sourceError}
        <div class="screen-share-picker-state error">
          <span class="material-symbols-rounded app-icon" aria-hidden="true">error</span>
          <span>{accompaniment.sourceError}</span>
        </div>
      {:else if accompaniment.processSources.length === 0}
        <div class="screen-share-picker-state">
          <span class="material-symbols-rounded app-icon" aria-hidden="true">music_off</span>
          <span>{t("accompaniment.noProcesses")}</span>
        </div>
      {:else}
        <div class="accompaniment-process-grid">
          {#each accompaniment.processSources as source (source.sourceId)}
            <button
              type="button"
              class:active={accompaniment.selectedSourceID === source.sourceId}
              onclick={() => accompaniment.selectSource(source)}
              ondblclick={() => void accompaniment.startFromDialog()}
            >
              <span class="accompaniment-process-preview">
                {#if source.iconDataUrl}
                  <img src={source.iconDataUrl} alt="" draggable="false" />
                {:else}
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">audio_file</span>
                {/if}
              </span>
              <span class="accompaniment-process-copy">
                <strong>{accompanimentSourceDisplayName(source)}</strong>
                {#if source.appName}
                  <small>{source.appName}</small>
                {/if}
              </span>
              {#if accompaniment.selectedSourceID === source.sourceId}
                <span class="material-symbols-rounded app-icon accompaniment-process-check" aria-hidden="true">check_circle</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    {:else}
      <input
        bind:this={fileInput}
        class="visually-hidden web-accompaniment-file-input"
        type="file"
        accept="audio/*"
        onchange={(event) => accompaniment.handleFileChange(event)}
      />
      <div class="web-accompaniment-file-panel">
        <button
          type="button"
          class="web-accompaniment-file-picker"
          class:selected={Boolean(accompaniment.selectedWebFile)}
          onclick={() => accompaniment.openFilePicker()}
        >
          <span class="web-accompaniment-file-icon">
            <span class="material-symbols-rounded app-icon" aria-hidden="true">
              {accompaniment.selectedWebFile ? "audio_file" : "library_music"}
            </span>
          </span>
          <span class="web-accompaniment-file-copy">
            <strong>{accompaniment.selectedWebFile?.name ?? t("accompaniment.chooseFile")}</strong>
            <small>
              {accompaniment.selectedWebFile
                ? `${formatFileSize(accompaniment.selectedWebFile.size)} · ${accompaniment.selectedWebFile.type || t("accompaniment.audioFile")}`
                : t("accompaniment.chooseFileHint")}
            </small>
          </span>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">folder_open</span>
        </button>
        {#if accompaniment.sourceError}
          <p class="web-accompaniment-file-error">
            <span class="material-symbols-rounded app-icon" aria-hidden="true">error</span>
            <span>{accompaniment.sourceError}</span>
          </p>
        {/if}
      </div>
    {/if}
    <div class="accompaniment-send-volume-setting">
      <div>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">volume_up</span>
        <span>
          <strong>{t("accompaniment.sendVolume")}</strong>
          <small>{t("accompaniment.sendVolumeDescription")}</small>
        </span>
        <b>{accompaniment.sendVolumePercent}%</b>
      </div>
      <input
        type="range"
        min="0"
        max={maximumAccompanimentSendVolumePercent}
        step="5"
        value={accompaniment.sendVolumePercent}
        style={`--voice-range-progress: ${voiceRangeProgress(accompaniment.sendVolumePercent, maximumAccompanimentSendVolumePercent)};`}
        aria-label={t("accompaniment.sendVolume")}
        oninput={(event) => accompaniment.changeSendVolume(event)}
      />
    </div>
    <footer>
      <button type="button" disabled={accompaniment.actionBusy} onclick={() => accompaniment.closeDialog()}>{t("common.cancel")}</button>
      <button class="primary" type="button" disabled={accompaniment.actionBusy || (nativeDesktopRuntime ? !accompaniment.selectedSource : !accompaniment.selectedWebFile)} onclick={() => void accompaniment.startFromDialog()}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">music_note</span>
        <span>{accompaniment.actionBusy ? t("status.connecting") : t("accompaniment.start")}</span>
      </button>
    </footer>
  </dialog>
</div>
{/if}
