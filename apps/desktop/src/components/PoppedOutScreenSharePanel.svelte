<script lang="ts">
  import type { ScreenShareController } from "../lib/screen-share.svelte";
  import type { ScreenShareTransportController } from "../lib/screen-share-transport.svelte";
  import type { ScreenShareSession } from "../lib/types";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type ScreenShareViewItem = {
    share: ScreenShareSession;
    stream: MediaStream | null;
  };

  type Props = {
    t: Translate;
    screenShare: ScreenShareController;
    transport: ScreenShareTransportController;
    items: ScreenShareViewItem[];
    memberAvatarStyle: (memberId: string) => string;
    memberAvatarDataURL: (memberId: string) => string;
    memberInitials: (memberId: string) => string;
    memberDisplayName: (memberId: string) => string;
    channelDisplayName: (channelId: string) => string;
  };

  let {
    t,
    screenShare,
    transport,
    items,
    memberAvatarStyle,
    memberAvatarDataURL,
    memberInitials,
    memberDisplayName,
    channelDisplayName
  }: Props = $props();

  function screenShareVideo(node: HTMLVideoElement, stream: MediaStream) {
    return transport.screenShareVideo(node, stream);
  }
</script>

{#if items.length > 0}
<section class="screen-share-popout-stack" aria-label={t("screenShare.viewerTitle")}>
  {#each items as item (item.share.share_id)}
    <article class="screen-share-viewer-card popout">
      <header>
        <span class="avatar member-avatar voice-participant-avatar" style={memberAvatarStyle(item.share.owner_member_id)}>{#if memberAvatarDataURL(item.share.owner_member_id)}<img src={memberAvatarDataURL(item.share.owner_member_id)} alt="" />{:else}{memberInitials(item.share.owner_member_id)}{/if}</span>
        <div>
          <strong>{memberDisplayName(item.share.owner_member_id)}</strong>
          <span>{channelDisplayName(item.share.channel_id)}</span>
        </div>
        <button
          type="button"
          aria-label={t("app.close")}
          onclick={() => transport.closePoppedOutScreenShare(item.share)}
        >
          <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
        </button>
      </header>
      {#if item.stream}
        <div class="screen-share-video-frame">
          <video
            use:screenShareVideo={item.stream}
            draggable="false"
            autoplay
            playsinline
            onclick={() => transport.openFocusedScreenShare(item.share)}
          ></video>
          <div class="screen-share-video-status compact">
            {screenShare.watchStatusLabel(item.share)}
          </div>
        </div>
      {:else}
        <div class="screen-share-viewer-waiting">
          <span class="material-symbols-rounded app-icon" aria-hidden="true">refresh</span>
          <span>{screenShare.watchStatusLabel(item.share)}</span>
        </div>
      {/if}
    </article>
  {/each}
</section>
{/if}
