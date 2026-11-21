<script lang="ts">
  import { emojiAlias } from "../lib/emoji";
  import type { EmojiController } from "../lib/emoji.svelte";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type Props = {
    t: Translate;
    emoji: EmojiController;
    addID: string;
    onAddIDChange: (value: string) => void;
    serverInitials: (name: string) => string;
    setAddInputElement: (element: HTMLInputElement | null) => void;
  };

  let {
    t,
    emoji,
    addID,
    onAddIDChange,
    serverInitials,
    setAddInputElement
  }: Props = $props();

  let addInput = $state<HTMLInputElement | null>(null);

  $effect(() => {
    setAddInputElement(addInput);
    return () => setAddInputElement(null);
  });

  function closeDialog() {
    emoji.closeAddDialog();
  }

  function selectTarget(targetKey: string) {
    emoji.selectAddTarget(targetKey);
  }

  function selectFiles(event: Event) {
    emoji.selectAddFiles(event);
  }

  async function submitUpload() {
    await emoji.submitQuickServerUpload();
  }
</script>

{#if emoji.addDialogOpen}
<div class="screen-share-config-overlay emoji-add-overlay" role="presentation" onmousedown={(event) => {
  if (event.target === event.currentTarget) closeDialog();
}}>
  <dialog class="emoji-add-dialog" open aria-modal="true" aria-label={t("emoji.addTitle")}>
    <header>
      <div>
        <h2>{t("emoji.addTitle")}</h2>
        <p>{t("emoji.addDescription")}</p>
      </div>
      <button type="button" aria-label={t("app.close")} onclick={closeDialog}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
      </button>
    </header>

    <div class="emoji-add-body">
      <section class="emoji-add-destinations" aria-label={t("emoji.addDestination")}>
        <h3>{t("emoji.addDestination")}</h3>
        <button
          type="button"
          class:active={emoji.addTargetKey === "local"}
          aria-pressed={emoji.addTargetKey === "local"}
          onclick={() => selectTarget("local")}
        >
          <span class="emoji-add-target-icon local" aria-hidden="true"><span class="material-symbols-rounded app-icon">inventory_2</span></span>
          <span><strong>{t("emoji.localTab")}</strong><small>{t("emoji.addLocalDescription")}</small></span>
          {#if emoji.addTargetKey === "local"}<span class="material-symbols-rounded app-icon emoji-add-selected" aria-hidden="true">check_circle</span>{/if}
        </button>

        {#each emoji.addTargets as target (target.serverID)}
          <button
            type="button"
            class:active={emoji.addTargetKey === `server:${target.serverID}`}
            aria-pressed={emoji.addTargetKey === `server:${target.serverID}`}
            onclick={() => selectTarget(`server:${target.serverID}`)}
          >
            <span class="emoji-add-target-icon server" class:has-image={Boolean(target.serverIconDataURL)}>
              {#if target.serverIconDataURL}<img src={target.serverIconDataURL} alt="" />{:else}{serverInitials(target.serverName)}{/if}
            </span>
            <span><strong>{target.serverName}</strong><small>{t("emoji.addServerDescription")}</small></span>
            {#if emoji.addTargetKey === `server:${target.serverID}`}<span class="material-symbols-rounded app-icon emoji-add-selected" aria-hidden="true">check_circle</span>{/if}
          </button>
        {/each}

        {#if emoji.addTargetsLoading}
          <div class="emoji-add-target-status"><span class="material-symbols-rounded app-icon spin" aria-hidden="true">progress_activity</span><span>{t("emoji.loadingDestinations")}</span></div>
        {:else if emoji.addTargets.length === 0}
          <div class="emoji-add-target-status"><span class="material-symbols-rounded app-icon" aria-hidden="true">lock</span><span>{t("emoji.noServerDestinations")}</span></div>
        {/if}
      </section>

      <section class="emoji-add-file-panel">
        <input
          bind:this={addInput}
          class="visually-hidden"
          type="file"
          multiple={emoji.addTargetKey === "local"}
          accept="image/png,image/jpeg,image/gif,image/webp"
          onchange={selectFiles}
        />
        {#if emoji.addPreviewURL && emoji.addTargetKey !== "local"}
          <div class="emoji-add-file-preview"><img src={emoji.addPreviewURL} alt={addID ? emojiAlias(addID) : t("emoji.uploadPreview")} /></div>
          <label class="server-emoji-id-field emoji-add-id-field">
            <span>{t("emoji.idLabel")}</span>
            <div>
              <span aria-hidden="true">:</span>
              <input
                maxlength="12"
                autocomplete="off"
                spellcheck="false"
                value={addID}
                placeholder="echo_wave"
                oninput={(event) => {
                  onAddIDChange(event.currentTarget.value);
                  emoji.clearAddError();
                }}
              />
              <span aria-hidden="true">:</span>
            </div>
            <small>{t("emoji.idRules")}</small>
          </label>
        {:else}
          <button class="emoji-add-choose-file" type="button" disabled={Boolean(emoji.actionBusyId)} onclick={() => addInput?.click()}>
            <span class="material-symbols-rounded app-icon" aria-hidden="true">add_photo_alternate</span>
            <span>{t("emoji.chooseFile")}</span>
          </button>
        {/if}
        {#if emoji.addError}<p class="emoji-add-error" role="alert">{emoji.addError}</p>{/if}
      </section>
    </div>

    <footer>
      <button class="emoji-add-cancel" type="button" disabled={Boolean(emoji.actionBusyId)} onclick={closeDialog}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
        <span>{t("common.cancel")}</span>
      </button>
      {#if emoji.addPreviewURL && emoji.addTargetKey !== "local"}
        <button class="primary" type="button" disabled={!addID || Boolean(emoji.actionBusyId)} onclick={() => void submitUpload()}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">upload</span>
          <span>{emoji.actionBusyId === "quick-server-upload" ? t("emoji.uploading") : t("emoji.addToServer")}</span>
        </button>
      {/if}
    </footer>
  </dialog>
</div>
{/if}
