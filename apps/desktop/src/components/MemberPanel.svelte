<script lang="ts">
  // Right-hand member list. Controller-based wiring: member data and view
  // models come from WorkspaceController / VoiceStageController /
  // PermissionsController; only the App-owned context-menu entry points and the
  // search-input DOM ref remain as props.
  import type { AudioDevicesController } from "../lib/audio-devices.svelte";
  import type { ChannelsController } from "../lib/channels.svelte";
  import type { PermissionsController } from "../lib/permissions.svelte";
  import type { VoiceStageController } from "../lib/voice-stage.svelte";
  import type { VoiceStateController } from "../lib/voice-state.svelte";
  import type { ScreenShareController } from "../lib/screen-share.svelte";
  import type { WorkspaceController } from "../lib/workspace.svelte";
  import type { Member, VoiceState } from "../lib/types";

  let {
    t,
    workspace,
    voiceStage,
    voiceState,
    permissionsController,
    channelsController,
    screenShare,
    audio,
    openMemberContextMenu,
    handleMemberContextMenuKeydown,
    setMemberSearchInputElement,
    realtimeSyncTick
  }: {
    t: (key: string, params?: Record<string, string | number>) => string;
    workspace: WorkspaceController;
    voiceStage: VoiceStageController;
    voiceState: VoiceStateController;
    permissionsController: PermissionsController;
    channelsController: ChannelsController;
    screenShare: ScreenShareController;
    audio: AudioDevicesController;
    openMemberContextMenu: (member: Member, event: MouseEvent) => void;
    handleMemberContextMenuKeydown: (member: Member, event: KeyboardEvent) => void;
    setMemberSearchInputElement: (element: HTMLInputElement | null) => void;
    realtimeSyncTick: number;
  } = $props();

  const memberAccessFilterChannelId = $derived(voiceStage.memberAccessFilterChannelId);
  const memberAccessFilterLoading = $derived(voiceStage.memberAccessFilterLoading);
  const memberSearchOpen = $derived(voiceStage.memberSearchOpen);
  const memberSearchQuery = $derived(voiceStage.memberSearchQuery);
  const members = $derived.by(() => { realtimeSyncTick; return workspace.members; });
  const roles = $derived(permissionsController.roles);
  const voiceStates = $derived(voiceState.voiceStates);

  const voiceStatesByMember = $derived(voiceStage.buildPrimaryVoiceStatesByMember(voiceStates));
  const screenSharingMemberIds = $derived(new Set(screenShare.sessions.map((share) => share.owner_member_id)));
  const memberPanelMembers = $derived.by(() => { realtimeSyncTick; return voiceStage.filterMemberPanelMembers(
    members,
    memberAccessFilterChannelId,
    voiceStage.memberAccessFilterMemberIds,
    memberSearchQuery
  ); });
  const memberGroups = $derived.by(() => { realtimeSyncTick; return voiceStage.buildMemberGroups(memberPanelMembers, roles); });

  const channelDisplayName = (channelId: string) => channelsController.channelDisplayName(channelId);
  const clearMemberAccessFilter = () => voiceStage.clearMemberAccessFilter();
  const toggleMemberSearch = () => voiceStage.toggleMemberSearch();
  const onSearchInput = (value: string) => {
    voiceStage.memberSearchQuery = value;
  };
  const roleTextStyle = (role: Parameters<PermissionsController["roleTextStyle"]>[0]) => permissionsController.roleTextStyle(role);
  const isVoiceStateSpeaking = (state: VoiceState | undefined) => audio.isVoiceStateSpeaking(state);
  const memberAvatarStyle = (id: string) => permissionsController.memberAvatarStyle(id);
  const memberTopRole = (member: Member) => permissionsController.memberTopRole(member);
  const hasVoiceRestriction = (state: VoiceState | undefined) => audio.hasVoiceRestriction(state);
  const voiceRestrictionIcon = (state: VoiceState | undefined) => audio.voiceRestrictionIcon(state);
  const voiceStateLabel = (state: VoiceState | undefined) => audio.voiceStateLabel(state);
  const memberRoleLabel = (member: Member) => permissionsController.memberRoleLabel(member);
</script>

<aside class="member-panel">
  <header class="member-panel-header">
    <div class="member-panel-heading">
      <p class="section-label">
        {memberAccessFilterChannelId
          ? t("members.accessibleTo", { name: channelDisplayName(memberAccessFilterChannelId) })
          : t("members.title")}
      </p>
      {#if memberAccessFilterLoading}
        <span class="material-symbols-rounded app-icon spinning" aria-hidden="true">progress_activity</span>
      {/if}
    </div>
    <div class="member-panel-actions">
      {#if memberAccessFilterChannelId}
        <button type="button" title={t("members.clearAccessFilter")} aria-label={t("members.clearAccessFilter")} onclick={clearMemberAccessFilter}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
        </button>
      {/if}
      <button type="button" class:active={memberSearchOpen} title={t("members.search")} aria-label={t("members.search")} aria-expanded={memberSearchOpen} onclick={() => void toggleMemberSearch()}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">search</span>
      </button>
    </div>
  </header>
  {#if memberSearchOpen}
    <label class="member-search-field">
      <span class="material-symbols-rounded app-icon" aria-hidden="true">search</span>
      <input bind:this={setMemberSearchInputElement} value={memberSearchQuery} oninput={(event) => onSearchInput(event.currentTarget.value)} placeholder={t("members.searchPlaceholder")} autocomplete="off" />
      {#if memberSearchQuery}
        <button type="button" title={t("members.clearSearch")} aria-label={t("members.clearSearch")} onclick={() => onSearchInput("")}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
        </button>
      {/if}
    </label>
  {/if}
  {#if !memberAccessFilterLoading && memberGroups.length === 0}
    <p class="member-panel-empty">{t(memberSearchQuery ? "members.searchEmpty" : "members.accessEmpty")}</p>
  {/if}
  {#each memberGroups as group}
    <section class="member-group">
      <p class="member-group-label" style={roleTextStyle(group.role)}>{group.label} - {group.members.length}</p>
      {#each group.members as member}
        {@const memberVoiceStateValue = voiceStatesByMember.get(member.member_id)}
        <div
          class="member-row"
          class:speaking={isVoiceStateSpeaking(memberVoiceStateValue)}
          class:offline={!member.online}
          role="button"
          tabindex="0"
          data-member-context-id={member.member_id}
          aria-label={member.display_name}
          oncontextmenu={(event) => openMemberContextMenu(member, event)}
          onkeydown={(event) => handleMemberContextMenuKeydown(member, event)}
        >
          <div class="avatar member-avatar" style={memberAvatarStyle(member.member_id)}>
            {#if member.avatar_data_url}
              <img src={member.avatar_data_url} alt="" />
            {:else}
              <span class="avatar-initials">{member.display_name.slice(0, 2).toUpperCase()}</span>
            {/if}
            <span class:online={member.online} class="member-presence-dot"></span>
          </div>
          <div class="member-detail">
            <p style={roleTextStyle(memberTopRole(member))}>{member.display_name}</p>
            {#if memberVoiceStateValue}
              <span class="member-voice-status">
                {#if hasVoiceRestriction(memberVoiceStateValue)}
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">
                    {voiceRestrictionIcon(memberVoiceStateValue)}
                  </span>
                {/if}
                <span>
                  {t("voice.inChannel", { name: channelDisplayName(memberVoiceStateValue.channel_id) })}
                  - {voiceStateLabel(memberVoiceStateValue)}
                </span>
              </span>
            {/if}
            {#if screenSharingMemberIds.has(member.member_id)}
              <span class="member-screen-share-status">
                <span class="material-symbols-rounded app-icon" aria-hidden="true">screen_share</span>
                <span>{t("screenShare.title")}</span>
              </span>
            {/if}
            <span>{memberRoleLabel(member)}</span>
            {#if member.is_banned}
              <span class="member-banned">{t("members.banned")}</span>
            {/if}
          </div>
        </div>
      {/each}
    </section>
  {/each}
</aside>
