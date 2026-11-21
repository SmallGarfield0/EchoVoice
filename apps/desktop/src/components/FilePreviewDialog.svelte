<script lang="ts">
  import FileMediaPreview from "./FileMediaPreview.svelte";
  import type { ChannelFilesController } from "../lib/channel-files.svelte";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type Props = {
    t: Translate;
    channelFiles: ChannelFilesController;
    memberAvatarStyle: (memberId: string) => string;
    memberAvatarDataURL: (memberId: string) => string;
    memberInitials: (memberId: string) => string;
    memberDisplayName: (memberId: string) => string;
  };

  let {
    t,
    channelFiles,
    memberAvatarStyle,
    memberAvatarDataURL,
    memberInitials,
    memberDisplayName
  }: Props = $props();

  let entry = $derived(channelFiles.filePreviewEntry);
</script>

{#if entry}
  <div class="dialog-backdrop file-preview-backdrop" role="presentation" onmousedown={(event) => {
    if (event.target === event.currentTarget) channelFiles.closeFilePreview();
  }}>
    <div
      class="file-preview-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="file-preview-title"
      tabindex="-1"
      onkeydown={(event) => channelFiles.handleFilePreviewKeydown(event)}
    >
      <header>
        <span class="material-symbols-rounded app-icon file-preview-kind-icon" aria-hidden="true">{channelFiles.fileEntryIcon(entry)}</span>
        <div class="file-preview-heading">
          <h2 id="file-preview-title">{entry.name}</h2>
          <span>
            {channelFiles.formatFileSize(entry.size_bytes)}
            {#if entry.mime_type} - {entry.mime_type}{/if}
          </span>
        </div>
        <div class="file-preview-owner">
          <span class="avatar member-avatar" style={memberAvatarStyle(entry.owner_member_id)}>
            {#if memberAvatarDataURL(entry.owner_member_id)}
              <img src={memberAvatarDataURL(entry.owner_member_id)} alt="" />
            {:else}
              {memberInitials(entry.owner_member_id)}
            {/if}
          </span>
          <span>{t("files.owner", { name: memberDisplayName(entry.owner_member_id) })}</span>
        </div>
        <button class="file-preview-close" type="button" data-tooltip={t("app.close")} aria-label={t("app.close")} onclick={() => channelFiles.closeFilePreview()}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
        </button>
      </header>

      <div class="file-preview-content">
        {#if channelFiles.filePreviewLoading}
          <div class="file-preview-state">
            <span class="material-symbols-rounded app-icon spinning" aria-hidden="true">progress_activity</span>
            <span>{t("files.previewLoading")}</span>
          </div>
        {:else if channelFiles.filePreviewError}
          <div class="file-preview-state error">
            <span class="material-symbols-rounded app-icon" aria-hidden="true">error</span>
            <span>{channelFiles.filePreviewError}</span>
          </div>
        {:else if channelFiles.filePreviewKind === "image" && channelFiles.filePreviewObjectURL}
          <img class="file-preview-image" src={channelFiles.filePreviewObjectURL} alt={entry.name} />
        {:else if channelFiles.filePreviewKind === "video" && channelFiles.filePreviewObjectURL}
          <FileMediaPreview
            src={channelFiles.filePreviewObjectURL}
            kind="video"
            playLabel={t("files.play")}
            pauseLabel={t("files.pause")}
            volumeLabel={t("files.volume")}
          />
        {:else if channelFiles.filePreviewKind === "audio" && channelFiles.filePreviewObjectURL}
          <FileMediaPreview
            src={channelFiles.filePreviewObjectURL}
            kind="audio"
            playLabel={t("files.play")}
            pauseLabel={t("files.pause")}
            volumeLabel={t("files.volume")}
          />
        {:else if channelFiles.filePreviewKind === "pdf" && channelFiles.filePreviewObjectURL}
          <iframe class="file-preview-pdf" src={channelFiles.filePreviewObjectURL} title={entry.name}></iframe>
        {:else if channelFiles.filePreviewKind === "text"}
          <div class="file-preview-text-wrap">
            <pre class="file-preview-text">{channelFiles.filePreviewText}</pre>
            {#if channelFiles.filePreviewTextTruncated}<p>{t("files.previewTruncated")}</p>{/if}
          </div>
        {:else if channelFiles.filePreviewKind === "document" && channelFiles.filePreviewDocument?.contentAvailable}
          <div class="file-preview-text-wrap file-document-preview">
            <div class="file-document-summary">
              <strong>{channelFiles.filePreviewDocument.format}</strong>
              <span>{t("files.documentExtractedText")}</span>
            </div>
            <pre class="file-preview-text">{channelFiles.filePreviewDocument.text}</pre>
            {#if channelFiles.filePreviewDocument.truncated}<p>{t("files.previewTruncated")}</p>{/if}
          </div>
        {:else if (channelFiles.filePreviewKind === "archive" || channelFiles.filePreviewKind === "document") && channelFiles.filePreviewArchive}
          <div class="file-archive-preview">
            <div class="file-archive-summary">
              <strong>{channelFiles.filePreviewArchive.format}</strong>
              <span>{t("files.archiveEntryCount", { count: channelFiles.filePreviewArchive.entries.length })}</span>
              {#if channelFiles.filePreviewArchive.truncated}<span>{t("files.previewTruncated")}</span>{/if}
            </div>
            {#if channelFiles.filePreviewArchive.manifestAvailable && channelFiles.filePreviewArchive.entries.length > 0}
              <div class="file-archive-list" role="list">
                {#each channelFiles.filePreviewArchive.entries as archiveEntry}
                  <div class="file-archive-entry" role="listitem">
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">{archiveEntry.directory ? "folder" : "draft"}</span>
                    <span>{archiveEntry.name}</span>
                    <small>{archiveEntry.directory ? t("files.folder") : channelFiles.formatFileSize(archiveEntry.sizeBytes)}</small>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="file-preview-state">
                <span class="material-symbols-rounded app-icon" aria-hidden="true">info</span>
                <span>{t("files.previewMetadataOnly")}</span>
              </div>
            {/if}
          </div>
        {:else}
          <div class="file-preview-state">
            <span class="material-symbols-rounded app-icon" aria-hidden="true">draft</span>
            <span>{t("files.previewMetadataOnly")}</span>
          </div>
        {/if}
      </div>

      <footer>
        <div class="file-preview-sha">
          <span>SHA256</span>
          <code>{entry.asset_sha256 ?? "-"}</code>
        </div>
        <button type="button" onclick={() => void channelFiles.downloadCurrentFilePreview()}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">download</span>
          <span>{t("files.download")}</span>
        </button>
      </footer>
    </div>
  </div>
{/if}
