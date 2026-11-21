<script lang="ts">
  import { buildChannelTree, categoryChannels as getCategoryChannels, type ChannelTree } from "../lib/channelList";
  import type { ChannelsController } from "../lib/channels.svelte";
  import type { Channel } from "../lib/types";
  import CustomSelect from "./CustomSelect.svelte";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type Props = {
    t: Translate;
    channels: ChannelsController;
    error: string;
    onFlushAliases: () => void;
  };

  let {
    t,
    channels,
    error,
    onFlushAliases
  }: Props = $props();

  function flush() {
    onFlushAliases();
  }

  function closeDialog() {
    channels.closeChannelDialog();
    flush();
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    await channels.submitChannel();
    flush();
  }

  let channelTree = $derived<ChannelTree>(buildChannelTree(channels.channels));
  let categoryChannelEntries = $derived<Channel[]>(getCategoryChannels(channelTree));
</script>

{#if channels.channelDialogOpen}
<div class="dialog-backdrop" role="presentation">
  <section class="connect-dialog" aria-label={t("channel.create")}>
    <header>
      <h2>{t("channel.create")}</h2>
      <button type="button" onclick={closeDialog}>{t("app.close")}</button>
    </header>

    <form class="connection-form" onsubmit={(event) => void submit(event)}>
      <label>
        {t("channel.name")}
        <input value={channels.channelName} oninput={(event) => (channels.channelName = event.currentTarget.value)} />
      </label>
      <div class="settings-select-field connection-custom-select">
        <span>{t("channel.type")}</span>
        <CustomSelect
          value={channels.channelType}
          options={[
            { value: "text", label: t("channel.text") },
            { value: "voice", label: t("channel.voice") },
            { value: "category", label: t("channel.category") }
          ]}
          ariaLabel={t("channel.type")}
          onValueChange={(value) => (channels.channelType = value as "text" | "voice" | "category")}
        />
      </div>
      {#if channels.channelType !== "category"}
        <div class="settings-select-field connection-custom-select">
          <span>{t("channel.parent")}</span>
          <CustomSelect
            value={channels.channelParentId}
            options={[
              { value: "", label: t("channel.uncategorized") },
              ...categoryChannelEntries.map((category) => ({ value: category.channel_id, label: category.name }))
            ]}
            ariaLabel={t("channel.parent")}
            onValueChange={(value) => (channels.channelParentId = value)}
          />
        </div>
      {/if}
      <button type="submit">{t("channel.create")}</button>
      {#if error}
        <p class="error">{error}</p>
      {/if}
    </form>
  </section>
</div>
{/if}
