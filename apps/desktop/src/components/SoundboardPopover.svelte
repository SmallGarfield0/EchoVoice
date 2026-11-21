<script lang="ts">
  import { formatSoundboardPosition, soundboardVolumeMaximumPercent, soundboardVolumeMinimumPercent, type LocalSoundboardItem } from "../lib/soundboard";
  import type { SoundboardController, SoundboardEditorTarget } from "../lib/soundboard.svelte";
  import type { ServerSummary, SoundboardItem, StoredServer } from "../lib/types";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type Props = {
    t: Translate;
    soundboard: SoundboardController;
    server: ServerSummary | null;
    baseUrl: string;
    savedServers: StoredServer[];
    canManageServerSoundboard: boolean;
    tab: "server" | "local";
    onTabChange: (tab: "server" | "local") => void;
    sourceServerID: string;
    onSourceServerIDChange: (serverID: string) => void;
    serverInitials: (name: string) => string;
    emojiObjectURL: (sha256: string) => string;
    formatFileSize: (bytes: number) => string;
    voiceRangeProgress: (value: number, max: number) => number;
    setPopoverElement: (element: HTMLDivElement | null) => void;
    setServerInputElement: (element: HTMLInputElement | null) => void;
    setLocalInputElement: (element: HTMLInputElement | null) => void;
    onClose: () => void;
    onKeydown: (event: KeyboardEvent) => void;
    onUploadServer: (event: Event) => void;
    onImportLocal: (event: Event) => void;
    onPlayServer: (item: SoundboardItem, originServerID?: string) => void;
    onPlayLocal: (item: LocalSoundboardItem) => void;
    onDeleteServer: (item: SoundboardItem) => void;
    onDeleteLocal: (item: LocalSoundboardItem) => void;
    onOpenEditor: (target: SoundboardEditorTarget) => void;
    onPlaybackVolume: (event: Event) => void;
    onListeningVolume: (event: Event) => void;
  };

  let {
    t,
    soundboard,
    server,
    baseUrl,
    savedServers,
    canManageServerSoundboard,
    tab,
    onTabChange,
    sourceServerID,
    onSourceServerIDChange,
    serverInitials,
    emojiObjectURL,
    formatFileSize,
    voiceRangeProgress,
    setPopoverElement,
    setServerInputElement,
    setLocalInputElement,
    onClose,
    onKeydown,
    onUploadServer,
    onImportLocal,
    onPlayServer,
    onPlayLocal,
    onDeleteServer,
    onDeleteLocal,
    onOpenEditor,
    onPlaybackVolume,
    onListeningVolume
  }: Props = $props();

  let popoverElement = $state<HTMLDivElement | null>(null);
  let serverInputElement = $state<HTMLInputElement | null>(null);
  let localInputElement = $state<HTMLInputElement | null>(null);

  $effect(() => {
    setPopoverElement(popoverElement);
    return () => setPopoverElement(null);
  });
  $effect(() => {
    setServerInputElement(serverInputElement);
    return () => setServerInputElement(null);
  });
  $effect(() => {
    setLocalInputElement(localInputElement);
    return () => setLocalInputElement(null);
  });

  let sourceLibraries = $derived.by(() => {
    // Track the same dependencies the old App-side `$:` block tracked.
    baseUrl;
    savedServers;
    server;
    sourceServerID;
    soundboard.items;
    soundboard.serverLibraries;
    return soundboard.sourceLibraries();
  });
  let activeSourceLibrary = $derived(
    sourceLibraries.find((library) => (
      library.serverID === (sourceServerID || server?.server_id)
    )) ?? sourceLibraries[0]
  );
</script>

{#if soundboard.popoverOpen}
<div
  bind:this={popoverElement}
  class="soundboard-popover"
  style={soundboard.popoverStyle}
  role="dialog"
  tabindex="-1"
  aria-label={t("soundboard.title")}
  onpointerdown={(event) => event.stopPropagation()}
  onkeydown={(event) => onKeydown(event)}
>
  <header>
    <div>
      <h2>{t("soundboard.title")}</h2>
      <small>{t("soundboard.chooseSound")}</small>
    </div>
    <button type="button" data-label={t("app.close")} aria-label={t("app.close")} onclick={onClose}>
      <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
    </button>
  </header>

  <div class="soundboard-toolbar">
    <div class="soundboard-tabs" role="tablist" aria-label={t("soundboard.libraryType")}>
      <button type="button" role="tab" aria-selected={tab === "server"} class:active={tab === "server"} onclick={() => {
        onTabChange("server");
        onSourceServerIDChange(sourceServerID || (server?.server_id ?? ""));
      }}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">dns</span>
        <span>{t("soundboard.serverTab")}</span>
      </button>
      <button type="button" role="tab" aria-selected={tab === "local"} class:active={tab === "local"} onclick={() => onTabChange("local")}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">computer</span>
        <span>{t("soundboard.localTab")}</span>
      </button>
    </div>

    <input bind:this={serverInputElement} class="visually-hidden" type="file" accept="audio/*" onchange={(event) => onUploadServer(event)} />
    <input bind:this={localInputElement} class="visually-hidden" type="file" accept="audio/*" onchange={(event) => onImportLocal(event)} />
    {#if tab === "server"}
      <button
        class="soundboard-add-button"
        type="button"
        disabled={!canManageServerSoundboard || Boolean(soundboard.actionBusyId) || sourceServerID !== server?.server_id}
        data-label={!canManageServerSoundboard ? t("soundboard.managePermissionRequired") : t("soundboard.uploadServer")}
        aria-label={!canManageServerSoundboard ? t("soundboard.managePermissionRequired") : t("soundboard.uploadServer")}
        onclick={() => serverInputElement?.click()}
      >
        <span class="material-symbols-rounded app-icon" aria-hidden="true">upload</span>
      </button>
    {:else}
      <button class="soundboard-add-button" type="button" disabled={Boolean(soundboard.actionBusyId)} data-label={t("soundboard.addLocal")} aria-label={t("soundboard.addLocal")} onclick={() => localInputElement?.click()}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">add</span>
      </button>
    {/if}
  </div>

  <section class="soundboard-volume-controls" aria-label={t("soundboard.personalVolumeTitle")}>
    <label class="voice-volume-slider soundboard-volume-control">
      <span>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">volume_up</span>
        <span>{t("soundboard.playbackVolume")}</span>
        <strong>{soundboard.playbackVolumePercent}%</strong>
      </span>
      <input
        type="range"
        min={soundboardVolumeMinimumPercent}
        max={soundboardVolumeMaximumPercent}
        step="5"
        value={soundboard.playbackVolumePercent}
        style={`--voice-range-progress: ${voiceRangeProgress(soundboard.playbackVolumePercent, soundboardVolumeMaximumPercent)};`}
        aria-label={t("soundboard.playbackVolume")}
        oninput={(event) => onPlaybackVolume(event)}
      />
      <small>{t("soundboard.playbackVolumeDescription")}</small>
    </label>
    <label class="voice-volume-slider soundboard-volume-control">
      <span>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">headphones</span>
        <span>{t("soundboard.listeningVolume")}</span>
        <strong>{soundboard.listeningVolumePercent}%</strong>
      </span>
      <input
        type="range"
        min="0"
        max={soundboardVolumeMaximumPercent}
        step="5"
        value={soundboard.listeningVolumePercent}
        style={`--voice-range-progress: ${voiceRangeProgress(soundboard.listeningVolumePercent, soundboardVolumeMaximumPercent)};`}
        aria-label={t("soundboard.listeningVolume")}
        oninput={(event) => onListeningVolume(event)}
      />
      <small>{t("soundboard.listeningVolumeDescription")}</small>
    </label>
  </section>

  <div class="soundboard-library" class:local={tab === "local"} role="tabpanel">
    {#if tab === "server"}
      <nav class="soundboard-source-rail" aria-label={t("soundboard.serverSources")}>
        {#each sourceLibraries as library (library.serverID)}
          <button
            type="button"
            class:active={sourceServerID === library.serverID}
            data-label={library.serverName}
            aria-label={library.serverName}
            aria-pressed={sourceServerID === library.serverID}
            onclick={() => onSourceServerIDChange(library.serverID)}
          >
            {#if library.serverIconDataURL}
              <img src={library.serverIconDataURL} alt="" />
            {:else}
              <span>{serverInitials(library.serverName)}</span>
            {/if}
          </button>
        {/each}
      </nav>
    {/if}

    <div class="soundboard-list">
      {#if tab === "server"}
        {@const source = activeSourceLibrary}
        {#if !source || source.items.length === 0}
          <div class="soundboard-empty">
            <span class="material-symbols-rounded app-icon" aria-hidden="true">graphic_eq</span>
            <span>{t("soundboard.serverEmpty")}</span>
          </div>
        {:else}
          <div class="soundboard-section-heading">
            <strong>{source.serverName}</strong>
            <span>{t("soundboard.soundCount", { count: source.items.length })}</span>
          </div>
          <div class="soundboard-grid">
          {#each source.items as item (item.item_id)}
            <article class="soundboard-item">
              <button class="soundboard-play-button" type="button" disabled={Boolean(soundboard.actionBusyId)} aria-label={t("soundboard.playNamed", { name: item.name })} onclick={() => void onPlayServer(item, source.serverID)}>
                <span class="soundboard-item-icon" aria-hidden="true">
                  {#if item.icon_asset_sha256 && emojiObjectURL(item.icon_asset_sha256)}
                    <img src={emojiObjectURL(item.icon_asset_sha256)} alt="" />
                  {:else if item.icon_emoji}
                    <span>{item.icon_emoji}</span>
                  {:else}
                    <span class="material-symbols-rounded app-icon">graphic_eq</span>
                  {/if}
                  <span class="soundboard-play-overlay material-symbols-rounded app-icon">play_arrow</span>
                </span>
                <span class="soundboard-item-copy">
                  <strong>{item.name}</strong>
                  <small>{item.end_ms ? `${formatSoundboardPosition(item.start_ms)}–${formatSoundboardPosition(item.end_ms)}` : formatFileSize(item.size_bytes)}</small>
                </span>
              </button>
              {#if canManageServerSoundboard && source.serverID === server?.server_id}
                <button class="soundboard-edit-button" type="button" disabled={Boolean(soundboard.actionBusyId)} data-label={t("soundboard.edit")} aria-label={t("soundboard.edit")} onclick={() => onOpenEditor({ kind: "server", item })}>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">edit</span>
                </button>
                <button class="soundboard-delete-button" type="button" disabled={Boolean(soundboard.actionBusyId)} data-label={t("soundboard.delete")} aria-label={t("soundboard.delete")} onclick={() => void onDeleteServer(item)}>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">delete</span>
                </button>
              {/if}
            </article>
          {/each}
          </div>
        {/if}
      {:else if soundboard.localItems.length === 0}
        <div class="soundboard-empty">
          <span class="material-symbols-rounded app-icon" aria-hidden="true">audio_file</span>
          <span>{t("soundboard.localEmpty")}</span>
        </div>
      {:else}
        <div class="soundboard-section-heading">
          <strong>{t("soundboard.localTab")}</strong>
          <span>{t("soundboard.soundCount", { count: soundboard.localItems.length })}</span>
        </div>
        <div class="soundboard-grid">
        {#each soundboard.localItems as item (item.local_id)}
          <article class="soundboard-item">
            <button class="soundboard-play-button" type="button" disabled={Boolean(soundboard.actionBusyId)} aria-label={t("soundboard.playNamed", { name: item.name })} onclick={() => void onPlayLocal(item)}>
              <span class="soundboard-item-icon" aria-hidden="true">
                {#if item.icon_asset_sha256 && emojiObjectURL(item.icon_asset_sha256)}
                  <img src={emojiObjectURL(item.icon_asset_sha256)} alt="" />
                {:else if item.icon_emoji}
                  <span>{item.icon_emoji}</span>
                {:else}
                  <span class="material-symbols-rounded app-icon">graphic_eq</span>
                {/if}
                <span class="soundboard-play-overlay material-symbols-rounded app-icon">play_arrow</span>
              </span>
              <span class="soundboard-item-copy">
                <strong>{item.name}</strong>
                <small>{item.end_ms ? `${formatSoundboardPosition(item.start_ms)}–${formatSoundboardPosition(item.end_ms)}` : formatFileSize(item.size_bytes)}</small>
              </span>
            </button>
            <button class="soundboard-edit-button" type="button" disabled={Boolean(soundboard.actionBusyId)} data-label={t("soundboard.edit")} aria-label={t("soundboard.edit")} onclick={() => onOpenEditor({ kind: "local", item })}>
              <span class="material-symbols-rounded app-icon" aria-hidden="true">edit</span>
            </button>
            <button class="soundboard-delete-button" type="button" disabled={Boolean(soundboard.actionBusyId)} data-label={t("soundboard.delete")} aria-label={t("soundboard.delete")} onclick={() => onDeleteLocal(item)}>
              <span class="material-symbols-rounded app-icon" aria-hidden="true">delete</span>
            </button>
          </article>
        {/each}
        </div>
      {/if}
    </div>
  </div>
</div>
{/if}
