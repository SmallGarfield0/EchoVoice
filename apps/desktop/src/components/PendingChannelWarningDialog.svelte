<script lang="ts">
  import type { ChannelsController } from "../lib/channels.svelte";
  import type { Channel } from "../lib/types";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type Props = {
    t: Translate;
    channels: ChannelsController;
    onFlushAliases: () => void;
  };

  let {
    t,
    channels,
    onFlushAliases
  }: Props = $props();

  function flush() {
    onFlushAliases();
  }

  function cancel() {
    channels.cancelChannelWarning();
    flush();
  }

  async function accept() {
    await channels.acceptChannelWarning();
    flush();
  }

  let warningChannel = $derived<Channel | undefined>(
    channels.channels.find((channel) => channel.channel_id === channels.pendingChannelWarning?.channelId)
  );
  let title = $derived(
    t("channel.warningTitle", { name: warningChannel ? channels.channelNameForDisplay(warningChannel) : "" })
  );
  let description = $derived(warningChannel ? channels.channelWarningForDisplay(warningChannel) : "");
</script>

{#if channels.pendingChannelWarning}
<div class="dialog-backdrop channel-warning-backdrop" role="presentation">
  <dialog class="channel-warning-dialog" open aria-label={title}>
    <span class="material-symbols-rounded app-icon channel-warning-icon" aria-hidden="true">warning</span>
    <h2>{title}</h2>
    <p>{description}</p>
    <div>
      <button type="button" onclick={cancel}>{t("common.no")}</button>
      <button class="primary" type="button" onclick={() => void accept()}>{t("common.yes")}</button>
    </div>
  </dialog>
</div>
{/if}
