<script lang="ts">
  // Channel sidebar: controller-based wiring. Channel registry/actions come
  // from ChannelsController, member/role display from PermissionsController,
  // unread labels from ChatComposerController, and voice display maps from
  // VoiceStageController. App-owned voice-participant drag/context helpers and
  // a few template-bound values remain as props.
  import { buildChannelTree, childChannels as getChildChannels } from "../lib/channelList";
  import { hasEffectivePermission } from "../lib/permissions";
  import { clientVersion, evaluateVersionCompatibility, minimumServerVersion } from "../lib/version";
  import type { AccompanimentController } from "../lib/accompaniment.svelte";
  import type { AudioDevicesController } from "../lib/audio-devices.svelte";
  import type { ChannelsController, ChannelContextMenuState, ChannelDropLine } from "../lib/channels.svelte";
  import type { ChatComposerController } from "../lib/composer.svelte";
  import type { PermissionsController } from "../lib/permissions.svelte";
  import type { ScreenShareController } from "../lib/screen-share.svelte";
  import type { ServerSettingsController } from "../lib/server-settings.svelte";
  import type { VoiceStageController } from "../lib/voice-stage.svelte";
  import type { VoiceStateController } from "../lib/voice-state.svelte";
  import type { WorkspaceController } from "../lib/workspace.svelte";
  import type { Channel, Member, ServerRole, VoiceState } from "../lib/types";

  let {
    t,
    workspace,
    channelsController,
    permissionsController,
    serverSettingsController,
    voiceState,
    voiceStage,
    screenShare,
    accompaniment,
    composer,
    audio,
    serverMenuOpen,
    toggleServerMenu,
    openServerDetails,
    voiceActionBusy,
    voiceChannelTip,
    selectedVoiceParticipantIds,
    voiceParticipantDragOverChannelId,
    voiceParticipantPointerPress,
    canDragVoiceParticipant,
    handleVoiceParticipantKeydown,
    handleVoiceParticipantMouseDown,
    handleVoiceParticipantPointerCancel,
    handleVoiceParticipantPointerDown,
    handleVoiceParticipantPointerMove,
    handleVoiceParticipantPointerUp,
    openVoiceParticipantContextMenu,
    realtimeSyncTick
  }: {
    t: (key: string, params?: Record<string, string | number>) => string;
    workspace: WorkspaceController;
    channelsController: ChannelsController;
    permissionsController: PermissionsController;
    serverSettingsController: ServerSettingsController;
    voiceState: VoiceStateController;
    voiceStage: VoiceStageController;
    screenShare: ScreenShareController;
    accompaniment: AccompanimentController;
    composer: ChatComposerController;
    audio: AudioDevicesController;
    serverMenuOpen: boolean;
    toggleServerMenu: () => void;
    openServerDetails: () => void;
    voiceActionBusy: boolean;
    voiceChannelTip: { x: number; y: number } | null;
    selectedVoiceParticipantIds: Set<string>;
    voiceParticipantDragOverChannelId: string;
    voiceParticipantPointerPress: { memberId: string; participantId: string; x: number; y: number; pointerId?: number; dragging: boolean } | null;
    canDragVoiceParticipant: (state: VoiceState | undefined) => boolean;
    handleVoiceParticipantKeydown: (state: VoiceState, event: KeyboardEvent) => void;
    handleVoiceParticipantMouseDown: (state: VoiceState, event: MouseEvent) => void;
    handleVoiceParticipantPointerCancel: (state: VoiceState, event: PointerEvent) => void;
    handleVoiceParticipantPointerDown: (state: VoiceState, event: PointerEvent) => void;
    handleVoiceParticipantPointerMove: (state: VoiceState, event: PointerEvent) => void;
    handleVoiceParticipantPointerUp: (state: VoiceState, event: PointerEvent) => void;
    openVoiceParticipantContextMenu: (state: VoiceState, event: MouseEvent) => void;
    realtimeSyncTick: number;
  } = $props();

  const channels = $derived(channelsController.channels);
  const channelTree = $derived(buildChannelTree(channels));
  const collapsedCategoryIds = $derived(channelsController.collapsedCategoryIds);
  const selectedChannelId = $derived(channelsController.selectedChannelId);
  const channelContextMenu = $derived(channelsController.channelContextMenu);
  const channelCreateMenuParentId = $derived(channelsController.channelCreateMenuParentId);
  const channelDrag = $derived(channelsController.channelDrag);

  const server = $derived.by(() => { realtimeSyncTick; return workspace.server; });
  const sessionToken = $derived.by(() => { realtimeSyncTick; return workspace.sessionToken; });
  const error = $derived.by(() => { realtimeSyncTick; return workspace.error; });
  const members = $derived.by(() => { realtimeSyncTick; return workspace.members; });
  const roles = $derived(permissionsController.roles);
  const currentMember = $derived.by(() => { realtimeSyncTick; return members.find((member) => member.member_id === workspace.memberId); });
  const currentVoiceStateValue = $derived(voiceState.voiceConnectionContext?.state);
  const voiceConnectionContext = $derived(voiceState.voiceConnectionContext);

  const canEditServerSettings = $derived.by(() => { realtimeSyncTick; return hasEffectivePermission("edit_server_settings", workspace.isOwner, currentMember, roles, permissionsController.rolePreviewId); });
  const canViewChannels = $derived.by(() => { realtimeSyncTick; return hasEffectivePermission("view_channels", workspace.isOwner, currentMember, roles, permissionsController.rolePreviewId); });
  const canManageChannels = $derived.by(() => { realtimeSyncTick; return hasEffectivePermission("manage_channels", workspace.isOwner, currentMember, roles, permissionsController.rolePreviewId); });
  const canCreateInvites = $derived.by(() => { realtimeSyncTick; return hasEffectivePermission("create_invites", workspace.isOwner, currentMember, roles, permissionsController.rolePreviewId); });

  const visibleTopLevelChannelEntries = $derived(canViewChannels ? channelTree.topLevel : []);
  const joinedVoiceChannelId = $derived.by(() => {
    realtimeSyncTick;
    return voiceConnectionContext?.serverId === workspace.activeServerId
      ? currentVoiceStateValue?.channel_id ?? ""
      : "";
  });
  const voiceStatesByChannel = $derived.by(() => { realtimeSyncTick; return voiceStage.buildVoiceStatesByChannel(voiceState.voiceStates, members); });
  const voiceDisplayStatesByChannel = $derived(voiceStage.buildVoiceDisplayStatesByChannel(voiceStatesByChannel));
  const screenSharingMemberIds = $derived(new Set(screenShare.sessions.map((share) => share.owner_member_id)));
  const accompanimentMemberIds = $derived(new Set(accompaniment.sessions.map((session) => session.owner_member_id)));
  const unreadLabelsByChannel = $derived(composer.buildUnreadLabels());
  const categoryUnreadLabelsByChannel = $derived(composer.buildCategoryUnreadLabels(channelTree));
  const versionCompatibility = $derived.by(() => { realtimeSyncTick; return evaluateVersionCompatibility({
    serverVersion: server?.server_compatibility_version ?? server?.server_version,
    minimumClientVersion: server?.minimum_client_version,
    clientVersion,
    minimumServerVersion,
    clientUpdateRequired: workspace.serverReportedClientUpdateRequired
  }); });

  const categoryChildCount = (categoryId: string) => getChildChannels(channelTree, categoryId).length;
  const channelContextMenuChannel = () => channelsController.contextMenuChannel();
  const channelContextMenuStyle = (menu: ChannelContextMenuState) => channelsController.channelContextMenuStyle(menu);
  const channelContextEditLabelKey = (channel: Channel | undefined) => channelsController.channelContextEditLabelKey(channel);
  const channelContextDeleteLabelKey = (channel: Channel | undefined) => channelsController.channelContextDeleteLabelKey(channel);
  const channelDropLineStyle = (line: ChannelDropLine) => channelsController.channelDropLineStyle(line);
  const channelIcon = (channel: Channel) => channelsController.channelIcon(channel);
  const channelNameForDisplay = (channel: Channel) => channelsController.channelNameForDisplay(channel);
  const deleteContextMenuChannel = () => channelsController.deleteContextMenuChannel();
  const focusCategoryChannel = (category: Channel) => channelsController.focusCategoryChannel(category);
  const handleCategoryHeadingKeydown = (category: Channel, event: KeyboardEvent) => channelsController.handleCategoryHeadingKeydown(category, event);
  const handleChannelClick = (channel: Channel, event?: MouseEvent | KeyboardEvent) => channelsController.handleChannelClick(channel, event);
  const handleChannelDoubleClick = (channel: Channel) => channelsController.handleChannelDoubleClick(channel);
  const handleChannelRowPointerCancel = (channel: Channel, event: PointerEvent) => channelsController.handleChannelRowPointerCancel(channel, event);
  const handleChannelRowPointerDown = (channel: Channel, event: PointerEvent) => channelsController.handleChannelRowPointerDown(channel, event);
  const handleChannelRowPointerMove = (channel: Channel, event: PointerEvent) => channelsController.handleChannelRowPointerMove(channel, event);
  const handleChannelRowPointerUp = (channel: Channel, event: PointerEvent) => channelsController.handleChannelRowPointerUp(channel, event);
  const hasVoiceRestriction = (state: VoiceState | undefined) => audio.hasVoiceRestriction(state);
  const isChannelDragging = (channelId: string) => channelsController.isChannelDragging(channelId);
  const isVoiceChannel = (channel: Channel) => channelsController.isVoiceChannel(channel);
  const isVoiceStateSpeaking = (state: VoiceState | undefined) => audio.isVoiceStateSpeaking(state);
  const memberAvatarDataURL = (id: string) => permissionsController.memberAvatarDataURL(id);
  const memberAvatarStyle = (id: string) => permissionsController.memberAvatarStyle(id);
  const memberDisplayName = (id: string) => permissionsController.memberDisplayName(id);
  const memberInitials = (id: string) => permissionsController.memberInitials(id);
  const openChannelContextMenu = (channel: Channel, event: MouseEvent) => channelsController.openChannelContextMenu(channel, event);
  const openContextMenuChannelEditor = () => channelsController.openContextMenuChannelEditor();
  const openCreateChannel = (type: Channel["type"], parentId = "") => channelsController.openCreateChannel(type, parentId);
  const openInviteDialog = () => serverSettingsController.openInviteDialog();
  const openServerProfileSettings = () => serverSettingsController.openServerProfileSettings();
  const openServerSettings = () => serverSettingsController.openServerSettings();
  const selectChannel = (channelId: string) => channelsController.selectChannel(channelId);
  const toggleCategoryCollapsed = (categoryId: string) => channelsController.toggleCategoryCollapsed(categoryId);
  const toggleCreateChannelMenu = (parentId = "") => channelsController.toggleCreateChannelMenu(parentId);
  const voiceListenerCount = (memberIdToCount: string) => voiceStage.voiceListenerCount(memberIdToCount);
  const voiceStateLabel = (state: VoiceState | undefined) => audio.voiceStateLabel(state);
</script>

<section class="channel-panel" class:voice-active={Boolean(currentVoiceStateValue)}>
  <div class="server-summary">
    <div class="server-summary-heading">
      <p class="eyebrow">{server?.name ?? "EchoVoice"}</p>
      {#if server}
        <div class="server-actions">
          <button type="button" title={t("server.actions")} aria-label={t("server.actions")} onclick={toggleServerMenu}>
            <span class="material-symbols-rounded app-icon" aria-hidden="true">more_horiz</span>
          </button>
          {#if serverMenuOpen}
            <div class="server-action-menu">
              <button type="button" onclick={openServerProfileSettings}>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">account_circle</span>
                <span>{t("serverProfile.title")}</span>
              </button>
              {#if canEditServerSettings}
                <button type="button" onclick={() => openServerSettings()}>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">settings</span>
                  <span>{t("settings.title")}</span>
                </button>
              {/if}
              <button type="button" onclick={openServerDetails}>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">info</span>
                <span>{t("server.details")}</span>
              </button>
              {#if canCreateInvites}
                <button type="button" onclick={() => void openInviteDialog()}>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">person_add</span>
                  <span>{t("invite.create")}</span>
                </button>
              {/if}
              {#if sessionToken && canManageChannels}
                <div class="server-action-menu-separator"></div>
                <button type="button" onclick={() => openCreateChannel("text")}>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">tag</span>
                  <span>{t("channel.createText")}</span>
                </button>
                <button type="button" onclick={() => openCreateChannel("voice")}>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">mic</span>
                  <span>{t("channel.createVoice")}</span>
                </button>
                <button type="button" onclick={() => openCreateChannel("category")}>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">create_new_folder</span>
                  <span>{t("channel.createCategory")}</span>
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    </div>
    {#if server && versionCompatibility.serverVersionUnknown}
      <div class="server-version-warning" data-version-state="unknown" role="status">
        <span class="material-symbols-rounded app-icon" aria-hidden="true">warning</span>
        <span>{t("server.versionUnknown")}</span>
      </div>
    {:else if server && versionCompatibility.serverOutdated}
      <div class="server-version-warning" data-version-state="server-outdated" role="status">
        <span class="material-symbols-rounded app-icon" aria-hidden="true">warning</span>
        <span>{t("server.versionOutdated", { version: server.server_compatibility_version ?? server.server_version ?? "-", minimum: minimumServerVersion })}</span>
      </div>
    {/if}
    {#if server && versionCompatibility.clientOutdated}
      <div class="server-version-warning critical" data-version-state="client-outdated" role="status">
        <span class="material-symbols-rounded app-icon" aria-hidden="true">error</span>
        <span>{t("server.clientOutdated", { version: clientVersion, minimum: server.minimum_client_version ?? "-" })}</span>
      </div>
    {/if}
    {#if error}
      <p class="error app-error">{error}</p>
    {/if}
  </div>

  <div
    class="channel-list"
    role="list"
  >
    {#if visibleTopLevelChannelEntries.length === 0}
      <p class="empty-category">{t("channel.empty")}</p>
    {/if}

    {#each visibleTopLevelChannelEntries as entry (entry.channel_id)}
      {#if entry.type === "category"}
        <div
          class="category-heading"
          role="button"
          tabindex="0"
          aria-expanded={!collapsedCategoryIds.has(entry.channel_id)}
          aria-label={channelNameForDisplay(entry)}
          data-channel-drop-target="true"
          data-channel-id={entry.channel_id}
          class:dragging={isChannelDragging(entry.channel_id)}
          class:drag-enabled={canManageChannels}
          class:active={selectedChannelId === entry.channel_id}
          onpointerdown={(event) => handleChannelRowPointerDown(entry, event)}
          onpointermove={(event) => handleChannelRowPointerMove(entry, event)}
          onpointerup={(event) => handleChannelRowPointerUp(entry, event)}
          onpointercancel={(event) => handleChannelRowPointerCancel(entry, event)}
          onclick={() => focusCategoryChannel(entry)}
          oncontextmenu={(event) => openChannelContextMenu(entry, event)}
          onkeydown={(event) => handleCategoryHeadingKeydown(entry, event)}
        >
          <button
            class="category-collapse-button"
            type="button"
            title={collapsedCategoryIds.has(entry.channel_id) ? t("channel.expandCategory") : t("channel.collapseCategory")}
            aria-label={collapsedCategoryIds.has(entry.channel_id) ? t("channel.expandCategory") : t("channel.collapseCategory")}
            onclick={(event) => { event.stopPropagation(); const handler = (() => toggleCategoryCollapsed(entry.channel_id)); if (handler) return handler(event); }}
          >
            <span class="material-symbols-rounded app-icon category-toggle-icon" aria-hidden="true">
              {collapsedCategoryIds.has(entry.channel_id) ? "chevron_right" : "expand_more"}
            </span>
          </button>
          <p class="section-label">{channelNameForDisplay(entry)}</p>
          {#if categoryUnreadLabelsByChannel.get(entry.channel_id)}
            <span class="channel-unread-badge category-unread-badge">{categoryUnreadLabelsByChannel.get(entry.channel_id)}</span>
          {/if}
          {#if sessionToken && canManageChannels}
            <div class="category-actions" class:menu-open={channelCreateMenuParentId === entry.channel_id}>
              <button
                type="button"
                title={t("channel.create")}
                onclick={() => toggleCreateChannelMenu(entry.channel_id)}
              >
                <span class="material-symbols-rounded app-icon" aria-hidden="true">add</span>
              </button>
              {#if canManageChannels && channelCreateMenuParentId === entry.channel_id}
                <div class="channel-create-menu">
                  <button type="button" onclick={() => openCreateChannel("text", entry.channel_id)}>
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">tag</span>
                    <span>{t("channel.createText")}</span>
                  </button>
                  <button type="button" onclick={() => openCreateChannel("voice", entry.channel_id)}>
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">mic</span>
                    <span>{t("channel.createVoice")}</span>
                  </button>
                </div>
              {/if}
            </div>
          {/if}
        </div>

        {#if !collapsedCategoryIds.has(entry.channel_id)}
          {#if categoryChildCount(entry.channel_id) === 0}
            <p class="empty-category nested-empty-category">{t("channel.emptyCategory")}</p>
          {/if}
          {#each channelTree.childrenByParentId.get(entry.channel_id) ?? [] as channel (channel.channel_id)}
            <div
              class="channel-row nested"
              role="button"
              tabindex="0"
              aria-label={channelNameForDisplay(channel)}
              data-channel-drop-target="true"
              data-channel-id={channel.channel_id}
              class:dragging={isChannelDragging(channel.channel_id)}
              class:drag-enabled={canManageChannels}
              class:voice-drop-target={voiceParticipantDragOverChannelId === channel.channel_id}
              onpointerdown={(event) => handleChannelRowPointerDown(channel, event)}
              onpointermove={(event) => handleChannelRowPointerMove(channel, event)}
              onpointerup={(event) => handleChannelRowPointerUp(channel, event)}
              onpointercancel={(event) => handleChannelRowPointerCancel(channel, event)}
              oncontextmenu={(event) => openChannelContextMenu(channel, event)}
              onclick={(event) => handleChannelClick(channel, event)}
              ondblclick={() => handleChannelDoubleClick(channel)}
              onkeydown={(event) => {
                if (event.key === "Enter" || event.key === " ") handleChannelClick(channel, event);
              }}
            >
              <div
                class="channel-main"
                class:active={selectedChannelId === channel.channel_id}
                class:voice-joined={joinedVoiceChannelId === channel.channel_id}
                title={isVoiceChannel(channel) ? (joinedVoiceChannelId === channel.channel_id ? t("voice.leave") : t("voice.join")) : channelNameForDisplay(channel)}
                aria-disabled={isVoiceChannel(channel) && voiceActionBusy}
              >
                <span class="material-symbols-rounded channel-type-icon" aria-hidden="true">{channelIcon(channel)}</span>
                <span class="channel-name">{channelNameForDisplay(channel)}</span>
                {#if unreadLabelsByChannel.get(channel.channel_id)}
                  <span class="channel-unread-badge">{unreadLabelsByChannel.get(channel.channel_id)}</span>
                {/if}
              </div>
              {#if isVoiceChannel(channel)}
                <button class="channel-message-action" type="button" title={t("channel.openChat")} aria-label={t("channel.openChat")} onclick={(event) => { event.stopPropagation(); const handler = (() => selectChannel(channel.channel_id)); if (handler) return handler(event); }}>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">chat</span>
                </button>
              {/if}
            </div>
            {#if isVoiceChannel(channel)}
              {#each voiceDisplayStatesByChannel.get(channel.channel_id) ?? [] as state (state.participant_id)}
                <div
                  class="voice-participant nested"
                  role="button"
                  tabindex="0"
                  data-voice-member-id={state.member_id}
                  data-voice-participant-id={state.participant_id}
                  title={canDragVoiceParticipant(state) ? `${memberDisplayName(state.member_id)} - ${t("voice.dragMoveMember")}` : memberDisplayName(state.member_id)}
                  class:draggable={canDragVoiceParticipant(state)}
                  class:dragging={Boolean(voiceParticipantPointerPress?.dragging) && selectedVoiceParticipantIds.has(state.participant_id)}
                  class:selected={selectedVoiceParticipantIds.has(state.participant_id)}
                  class:speaking={isVoiceStateSpeaking(state)}
                  onpointerdown={(event) => handleVoiceParticipantPointerDown(state, event)}
                  onpointermove={(event) => handleVoiceParticipantPointerMove(state, event)}
                  onpointerup={(event) => handleVoiceParticipantPointerUp(state, event)}
                  onpointercancel={(event) => handleVoiceParticipantPointerCancel(state, event)}
                  onmousedown={(event) => handleVoiceParticipantMouseDown(state, event)}
                  oncontextmenu={(event) => openVoiceParticipantContextMenu(state, event)}
                  onkeydown={(event) => handleVoiceParticipantKeydown(state, event)}
                >
                  <span class="avatar member-avatar voice-participant-avatar" style={memberAvatarStyle(state.member_id)}>{#if memberAvatarDataURL(state.member_id)}<img src={memberAvatarDataURL(state.member_id)} alt="" />{:else}{memberInitials(state.member_id)}{/if}</span>
                  <span class="voice-participant-name">{memberDisplayName(state.member_id)}</span>
                  {#if hasVoiceRestriction(state) || screenSharingMemberIds.has(state.member_id) || accompanimentMemberIds.has(state.member_id)}
                    <span class="voice-state-icons" aria-label={voiceStateLabel(state)} title={voiceStateLabel(state)}>
                      {#if state.mic_muted || state.server_muted}
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">mic_off</span>
                      {/if}
                      {#if state.audio_deafened || state.server_deafened}
                        <span class="material-symbols-rounded app-icon" aria-hidden="true">headset_off</span>
                      {/if}
                      {#if screenSharingMemberIds.has(state.member_id)}
                        <span class="material-symbols-rounded app-icon screen-share-member-indicator" aria-label={t("screenShare.title")}>screen_share</span>
                      {/if}
                      {#if accompanimentMemberIds.has(state.member_id)}
                        <span class="material-symbols-rounded app-icon accompaniment-indicator" aria-label={t("accompaniment.title")}>music_note</span>
                      {/if}
                    </span>
                  {/if}
                </div>
                {#if voiceListenerCount(state.member_id) > 0}
                  <div class="voice-listener-summary nested" aria-label={t("voice.extraListeningDevices", { count: voiceListenerCount(state.member_id) })}>
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">headphones</span>
                    <span>{t("voice.extraListeningDevices", { count: voiceListenerCount(state.member_id) })}</span>
                  </div>
                {/if}
              {/each}
            {/if}
          {/each}
        {/if}
      {:else}
        <div
          class="channel-row"
          role="button"
          tabindex="0"
          aria-label={channelNameForDisplay(entry)}
          data-channel-drop-target="true"
          data-channel-id={entry.channel_id}
          class:dragging={isChannelDragging(entry.channel_id)}
          class:drag-enabled={canManageChannels}
          class:voice-drop-target={voiceParticipantDragOverChannelId === entry.channel_id}
          onpointerdown={(event) => handleChannelRowPointerDown(entry, event)}
          onpointermove={(event) => handleChannelRowPointerMove(entry, event)}
          onpointerup={(event) => handleChannelRowPointerUp(entry, event)}
          onpointercancel={(event) => handleChannelRowPointerCancel(entry, event)}
          oncontextmenu={(event) => openChannelContextMenu(entry, event)}
          onclick={(event) => handleChannelClick(entry, event)}
          ondblclick={() => handleChannelDoubleClick(entry)}
          onkeydown={(event) => {
            if (event.key === "Enter" || event.key === " ") handleChannelClick(entry, event);
          }}
        >
          <div
            class="channel-main"
            class:active={selectedChannelId === entry.channel_id}
            class:voice-joined={joinedVoiceChannelId === entry.channel_id}
            title={isVoiceChannel(entry) ? (joinedVoiceChannelId === entry.channel_id ? t("voice.leave") : t("voice.join")) : channelNameForDisplay(entry)}
            aria-disabled={isVoiceChannel(entry) && voiceActionBusy}
          >
            <span class="material-symbols-rounded channel-type-icon" aria-hidden="true">{channelIcon(entry)}</span>
            <span class="channel-name">{channelNameForDisplay(entry)}</span>
            {#if unreadLabelsByChannel.get(entry.channel_id)}
              <span class="channel-unread-badge">{unreadLabelsByChannel.get(entry.channel_id)}</span>
            {/if}
          </div>
          {#if isVoiceChannel(entry)}
            <button class="channel-message-action" type="button" title={t("channel.openChat")} aria-label={t("channel.openChat")} onclick={(event) => { event.stopPropagation(); const handler = (() => selectChannel(entry.channel_id)); if (handler) return handler(event); }}>
              <span class="material-symbols-rounded app-icon" aria-hidden="true">chat</span>
            </button>
          {/if}
        </div>
        {#if isVoiceChannel(entry)}
          {#each voiceDisplayStatesByChannel.get(entry.channel_id) ?? [] as state (state.participant_id)}
            <div
              class="voice-participant"
              role="button"
              tabindex="0"
              data-voice-member-id={state.member_id}
              data-voice-participant-id={state.participant_id}
              title={canDragVoiceParticipant(state) ? `${memberDisplayName(state.member_id)} - ${t("voice.dragMoveMember")}` : memberDisplayName(state.member_id)}
              class:draggable={canDragVoiceParticipant(state)}
              class:dragging={Boolean(voiceParticipantPointerPress?.dragging) && selectedVoiceParticipantIds.has(state.participant_id)}
              class:selected={selectedVoiceParticipantIds.has(state.participant_id)}
              class:speaking={isVoiceStateSpeaking(state)}
              onpointerdown={(event) => handleVoiceParticipantPointerDown(state, event)}
              onpointermove={(event) => handleVoiceParticipantPointerMove(state, event)}
              onpointerup={(event) => handleVoiceParticipantPointerUp(state, event)}
              onpointercancel={(event) => handleVoiceParticipantPointerCancel(state, event)}
              onmousedown={(event) => handleVoiceParticipantMouseDown(state, event)}
              oncontextmenu={(event) => openVoiceParticipantContextMenu(state, event)}
              onkeydown={(event) => handleVoiceParticipantKeydown(state, event)}
            >
              <span class="avatar member-avatar voice-participant-avatar" style={memberAvatarStyle(state.member_id)}>{#if memberAvatarDataURL(state.member_id)}<img src={memberAvatarDataURL(state.member_id)} alt="" />{:else}{memberInitials(state.member_id)}{/if}</span>
              <span class="voice-participant-name">{memberDisplayName(state.member_id)}</span>
              {#if hasVoiceRestriction(state) || screenSharingMemberIds.has(state.member_id) || accompanimentMemberIds.has(state.member_id)}
                <span class="voice-state-icons" aria-label={voiceStateLabel(state)} title={voiceStateLabel(state)}>
                  {#if state.mic_muted || state.server_muted}
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">mic_off</span>
                  {/if}
                  {#if state.audio_deafened || state.server_deafened}
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">headset_off</span>
                  {/if}
                  {#if screenSharingMemberIds.has(state.member_id)}
                    <span class="material-symbols-rounded app-icon screen-share-member-indicator" aria-label={t("screenShare.title")}>screen_share</span>
                  {/if}
                  {#if accompanimentMemberIds.has(state.member_id)}
                    <span class="material-symbols-rounded app-icon accompaniment-indicator" aria-label={t("accompaniment.title")}>music_note</span>
                  {/if}
                </span>
              {/if}
            </div>
            {#if voiceListenerCount(state.member_id) > 0}
              <div class="voice-listener-summary" aria-label={t("voice.extraListeningDevices", { count: voiceListenerCount(state.member_id) })}>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">headphones</span>
                <span>{t("voice.extraListeningDevices", { count: voiceListenerCount(state.member_id) })}</span>
              </div>
            {/if}
          {/each}
        {/if}
      {/if}
    {/each}
  </div>

  {#if channelContextMenu && channelContextMenuChannel()}
    <div
      class="channel-context-menu"
      role="menu"
      style={channelContextMenuStyle(channelContextMenu)}
    >
      <button type="button" role="menuitem" onclick={openContextMenuChannelEditor}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">settings</span>
        <span>{t(channelContextEditLabelKey(channelContextMenuChannel()))}</span>
      </button>
      <button class="danger" type="button" role="menuitem" onclick={deleteContextMenuChannel}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">delete</span>
        <span>{t(channelContextDeleteLabelKey(channelContextMenuChannel()))}</span>
      </button>
    </div>
  {/if}

  {#if channelDrag.line}
    <div
      class="channel-insert-line-overlay"
      data-testid="channel-insert-line"
      style={channelDropLineStyle(channelDrag.line)}
    >
      <span></span>
    </div>
  {/if}

  {#if voiceChannelTip}
    <div
      class="voice-channel-tip"
      style={`left: ${voiceChannelTip.x}px; top: ${voiceChannelTip.y}px;`}
    >
      <span class="material-symbols-rounded app-icon" aria-hidden="true">touch_app</span>
      <span>{t("voice.doubleClickTip")}</span>
    </div>
  {/if}
</section>
