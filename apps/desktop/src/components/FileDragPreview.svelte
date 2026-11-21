<script lang="ts">
  import type { ChannelFilesController } from "../lib/channel-files.svelte";

  type Props = {
    channelFiles: ChannelFilesController;
  };

  let { channelFiles }: Props = $props();
</script>

{#if channelFiles.filePointerPress?.dragging}
  {@const draggedFiles = channelFiles.selectedFileEntries()}
  {@const firstDraggedFile = draggedFiles[0]}
  {#if firstDraggedFile}
    <div
      class="file-drag-preview"
      style={`left: ${Math.round(channelFiles.fileDragX + 14)}px; top: ${Math.round(channelFiles.fileDragY + 14)}px;`}
      aria-hidden="true"
    >
      <span class="material-symbols-rounded app-icon">{channelFiles.fileEntryIcon(firstDraggedFile)}</span>
      <span>{firstDraggedFile.name}</span>
      {#if draggedFiles.length > 1}<strong>{draggedFiles.length}</strong>{/if}
    </div>
  {/if}
{/if}
