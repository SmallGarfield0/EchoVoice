<script lang="ts">
  import type { EmojiController } from "../lib/emoji.svelte";
  import type { EmojiReference } from "../lib/emoji";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type Props = {
    t: Translate;
    emoji: EmojiController;
    reference: EmojiReference | null;
    formatFileSize: (bytes: number) => string;
    onClose: () => void;
    onSave: () => void;
  };

  let {
    t,
    emoji,
    reference,
    formatFileSize,
    onClose,
    onSave
  }: Props = $props();
</script>

{#if reference}
  <div class="screen-share-config-overlay emoji-detail-overlay" role="presentation" onmousedown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <dialog class="emoji-detail-dialog" open aria-modal="true" aria-label={`:${reference.shortcode}:`}>
      <header>
        <strong>:{reference.shortcode}:</strong>
        <button type="button" title={t("app.close")} aria-label={t("app.close")} onclick={onClose}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
        </button>
      </header>
      <div class="emoji-detail-preview">
        {#if emoji.objectURL(reference.asset_sha256)}
          <img src={emoji.objectURL(reference.asset_sha256)} alt={`:${reference.shortcode}:`} />
        {/if}
      </div>
      <div class="emoji-detail-meta">
        <span>{formatFileSize(reference.size_bytes)}</span>
        <span>{reference.mime_type === "image/gif" ? "GIF" : reference.mime_type.replace("image/", "").toUpperCase()}</span>
      </div>
      <footer>
        <button type="button" onclick={onClose}>{t("common.cancel")}</button>
        <button class="primary" type="button" disabled={Boolean(emoji.actionBusyId)} onclick={onSave}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">bookmark_add</span>
          <span>{t("emoji.saveToLocal")}</span>
        </button>
      </footer>
    </dialog>
  </div>
{/if}
