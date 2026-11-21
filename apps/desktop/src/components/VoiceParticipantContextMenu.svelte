<script lang="ts">
  import type { ChannelsController } from "../lib/channels.svelte";
  import type { Member, VoiceDurationStats, VoiceKickMode, VoiceState } from "../lib/types";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type VoiceParticipantContextMenuState = {
    memberId: string;
    participantId?: string;
    x: number;
    y: number;
  };

  type Props = {
    t: Translate;
    menu: VoiceParticipantContextMenuState | null;
    memberValue: Member | undefined;
    stateValue: VoiceState | undefined;
    selectionStates: VoiceState[];
    canMove: boolean;
    canModerate: boolean;
    canManageMember: boolean;
    memberId: string;
    channelsController: ChannelsController;
    memberAvatarStyle: (memberId: string) => string;
    memberInitials: (memberId: string) => string;
    durationLoading: boolean;
    durationError: string;
    durationStats: VoiceDurationStats | null;
    loadDuration: (targetMemberId: string) => void;
    displayedDuration: (kind: "total" | "shared") => number;
    formatDuration: (durationMS: number) => string;
    volumePercent: number;
    musicVolumePercent: number;
    memberVolumeLimitPercent: number;
    voiceRangeProgress: (value: number, maximum: number) => number;
    accompanimentMemberIds: Set<string>;
    resetMemberVolume: (targetMemberId: string) => void;
    resetMemberMusicVolume: (targetMemberId: string) => void;
    changeMemberVolume: (targetMemberId: string, event: Event) => void;
    changeMemberMusicVolume: (targetMemberId: string, event: Event) => void;
    canMuteVoiceMembers: boolean;
    canDeafenVoiceMembers: boolean;
    canMoveVoiceMembers: boolean;
    selectedVoiceStatesAll: (field: "server_muted" | "server_deafened") => boolean;
    voiceManageBusyMemberId: string;
    manageVoiceParticipantFromMenu: (patch: Partial<VoiceState>) => Promise<void>;
    selectedVoiceContextAllInChannel: (channelId: string) => boolean;
    moveVoiceParticipantsFromMenu: (channelId: string) => Promise<void>;
    kickVoiceParticipantFromMenu: (mode: VoiceKickMode) => Promise<void>;
    memberUpdating: boolean;
    banVoiceParticipantFromMenu: () => Promise<void>;
  };

  let {
    t,
    menu,
    memberValue,
    stateValue,
    selectionStates,
    canMove,
    canModerate,
    canManageMember,
    memberId,
    channelsController,
    memberAvatarStyle,
    memberInitials,
    durationLoading,
    durationError,
    durationStats,
    loadDuration,
    displayedDuration,
    formatDuration,
    volumePercent,
    musicVolumePercent,
    memberVolumeLimitPercent,
    voiceRangeProgress,
    accompanimentMemberIds,
    resetMemberVolume,
    resetMemberMusicVolume,
    changeMemberVolume,
    changeMemberMusicVolume,
    canMuteVoiceMembers,
    canDeafenVoiceMembers,
    canMoveVoiceMembers,
    selectedVoiceStatesAll,
    voiceManageBusyMemberId,
    manageVoiceParticipantFromMenu,
    selectedVoiceContextAllInChannel,
    moveVoiceParticipantsFromMenu,
    kickVoiceParticipantFromMenu,
    memberUpdating,
    banVoiceParticipantFromMenu
  }: Props = $props();
</script>

{#if menu && memberValue}
<div
  class="voice-participant-context-menu"
  role="menu"
  style={`left: ${menu.x}px; top: ${menu.y}px;`}
>
  <div class="voice-participant-context-header">
    <span class="avatar member-avatar voice-participant-avatar" style={memberAvatarStyle(memberValue.member_id)}>{#if memberValue.avatar_data_url}<img src={memberValue.avatar_data_url} alt="" />{:else}{memberInitials(memberValue.member_id)}{/if}</span>
    <div>
      <strong>{memberValue.display_name}</strong>
      <span>
        {#if stateValue}
          {t("voice.inChannel", { name: channelsController.channelDisplayName(stateValue.channel_id) })}
        {:else}
          {memberValue.online ? t("members.online") : t("members.offline")}
        {/if}
      </span>
    </div>
  </div>
  {#if selectionStates.length > 1}
    <div class="context-selection-summary voice-selection-summary">
      <span class="material-symbols-rounded app-icon" aria-hidden="true">group</span>
      <span>{t("voice.selectedCount", { count: selectionStates.length })}</span>
    </div>
  {/if}
  {#if selectionStates.length <= 1}
  <div class="voice-participant-duration" aria-live="polite">
    <div class="voice-participant-duration-title">
      <span class="material-symbols-rounded app-icon" aria-hidden="true">timer</span>
      <strong>{t("voice.durationTitle")}</strong>
    </div>
    {#if durationLoading}
      <div class="voice-participant-duration-loading">
        <span class="material-symbols-rounded app-icon" aria-hidden="true">progress_activity</span>
        <span>{t("voice.durationLoading")}</span>
      </div>
    {:else if durationError}
      <button
        class="voice-participant-duration-retry"
        type="button"
        onclick={() => loadDuration(memberValue.member_id)}
      >
        <span class="material-symbols-rounded app-icon" aria-hidden="true">refresh</span>
        <span>{t("voice.durationRetry")}</span>
      </button>
    {:else if durationStats}
      <div class="voice-participant-duration-row">
        <span>{t("voice.serverVoiceDuration")}</span>
        <strong>{formatDuration(displayedDuration("total"))}</strong>
      </div>
      {#if memberValue.member_id !== memberId}
        <div class="voice-participant-duration-row">
          <span>{t("voice.sharedVoiceDuration")}</span>
          <strong>{formatDuration(displayedDuration("shared"))}</strong>
        </div>
      {/if}
    {/if}
  </div>
  {/if}
  {#if selectionStates.length === 1 && stateValue && stateValue.member_id !== memberId}
    <div class="voice-participant-volume-control">
      <div>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">volume_up</span>
        <span>{t("voice.memberVolume")}</span>
        <strong>{volumePercent}%</strong>
        <button
          type="button"
          title={t("voice.resetVolume")}
          aria-label={t("voice.resetVolume")}
          onclick={() => resetMemberVolume(stateValue.member_id)}
        >
          <span class="material-symbols-rounded app-icon" aria-hidden="true">sync</span>
        </button>
      </div>
      <input
        type="range"
        min="0"
        max={memberVolumeLimitPercent}
        step="5"
        value={volumePercent}
        style={`--voice-range-progress: ${voiceRangeProgress(volumePercent, memberVolumeLimitPercent)};`}
        aria-label={t("voice.memberVolume")}
        onpointerdown={(event) => event.stopPropagation()}
        oninput={(event) => changeMemberVolume(stateValue.member_id, event)}
      />
    </div>
    {#if accompanimentMemberIds.has(stateValue.member_id)}
      <div class="voice-participant-volume-control music">
        <div>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">music_note</span>
          <span>{t("accompaniment.memberVolume")}</span>
          <strong>{musicVolumePercent}%</strong>
          <button
            type="button"
            data-tooltip={t("voice.resetVolume")}
            aria-label={t("voice.resetVolume")}
            onclick={() => resetMemberMusicVolume(stateValue.member_id)}
          >
            <span class="material-symbols-rounded app-icon" aria-hidden="true">sync</span>
          </button>
        </div>
        <input
          type="range"
          min="0"
          max={memberVolumeLimitPercent}
          step="5"
          value={musicVolumePercent}
          style={`--voice-range-progress: ${voiceRangeProgress(musicVolumePercent, memberVolumeLimitPercent)};`}
          aria-label={t("accompaniment.memberVolume")}
          onpointerdown={(event) => event.stopPropagation()}
          oninput={(event) => changeMemberMusicVolume(stateValue.member_id, event)}
        />
        <p>{t("accompaniment.memberVolumeDescription")}</p>
      </div>
    {/if}
  {/if}
  {#if canModerate && stateValue}
    {#if canMuteVoiceMembers}
    <button
      type="button"
      role="menuitem"
      class:active={selectedVoiceStatesAll("server_muted")}
      disabled={Boolean(voiceManageBusyMemberId)}
      onclick={() => void manageVoiceParticipantFromMenu({
        server_muted: !selectedVoiceStatesAll("server_muted")
      })}
    >
      <span class="material-symbols-rounded app-icon" aria-hidden="true">mic_off</span>
      <span>{selectedVoiceStatesAll("server_muted") ? t("voice.adminUnmute") : t("voice.adminMute")}</span>
    </button>
    {/if}
    {#if canDeafenVoiceMembers}
    <button
      type="button"
      role="menuitem"
      class:active={selectedVoiceStatesAll("server_deafened")}
      disabled={Boolean(voiceManageBusyMemberId)}
      onclick={() => void manageVoiceParticipantFromMenu({
        server_deafened: !selectedVoiceStatesAll("server_deafened")
      })}
    >
      <span class="material-symbols-rounded app-icon" aria-hidden="true">headset_off</span>
      <span>{selectedVoiceStatesAll("server_deafened") ? t("voice.adminUndeafen") : t("voice.adminDeafen")}</span>
    </button>
    {/if}
  {/if}
  {#if canMove && stateValue}
    <div class="voice-participant-context-submenu" role="none">
      <button type="button" role="menuitem" disabled={Boolean(voiceManageBusyMemberId)}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">swap_horiz</span>
        <span>{selectionStates.length > 1 ? t("voice.moveSelected") : t("voice.moveMember")}</span>
        <span class="material-symbols-rounded app-icon submenu-arrow" aria-hidden="true">chevron_right</span>
      </button>
      <div class="voice-participant-context-submenu-panel" role="menu">
        {#each channelsController.voiceChannels() as channel}
          <button
            type="button"
            role="menuitem"
            class:active={selectedVoiceContextAllInChannel(channel.channel_id)}
            disabled={Boolean(voiceManageBusyMemberId) || selectedVoiceContextAllInChannel(channel.channel_id)}
            onclick={() => void moveVoiceParticipantsFromMenu(channel.channel_id)}
          >
            <span class="material-symbols-rounded app-icon" aria-hidden="true">settings_voice</span>
            <span>{channelsController.channelNameForDisplay(channel)}</span>
          </button>
        {/each}
      </div>
    </div>
  {/if}
  {#if canModerate && canMoveVoiceMembers}
    <div class="voice-participant-context-separator"></div>
    <div class="voice-participant-context-submenu voice-participant-kick-submenu" role="none">
      <button type="button" role="menuitem" class="danger" disabled={Boolean(voiceManageBusyMemberId)}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">logout</span>
        <span>{selectionStates.length > 1 ? t("voice.kickSelected", { count: selectionStates.length }) : t("voice.kickMember")}</span>
        <span class="material-symbols-rounded app-icon submenu-arrow" aria-hidden="true">chevron_right</span>
      </button>
      <div class="voice-participant-context-submenu-panel" role="menu">
        <button
          type="button"
          role="menuitem"
          class="danger"
          data-voice-kick-mode="notify"
          disabled={Boolean(voiceManageBusyMemberId)}
          onclick={() => void kickVoiceParticipantFromMenu("notify")}
        >
          <span class="material-symbols-rounded app-icon" aria-hidden="true">notification_important</span>
          <span>{selectionStates.length > 1 ? t("voice.kickSelectedNotify", { count: selectionStates.length }) : t("voice.kickNotify")}</span>
        </button>
        <button
          type="button"
          role="menuitem"
          class="danger"
          data-voice-kick-mode="silent"
          disabled={Boolean(voiceManageBusyMemberId)}
          onclick={() => void kickVoiceParticipantFromMenu("silent")}
        >
          <span class="material-symbols-rounded app-icon" aria-hidden="true">notifications_off</span>
          <span>{selectionStates.length > 1 ? t("voice.kickSelectedSilent", { count: selectionStates.length }) : t("voice.kickSilent")}</span>
        </button>
      </div>
    </div>
  {/if}
  {#if canManageMember}
    <div class="voice-participant-context-separator"></div>
    <button
      type="button"
      role="menuitem"
      class="danger"
      disabled={memberUpdating || (selectionStates.length === 1 && memberValue.is_banned)}
      onclick={() => void banVoiceParticipantFromMenu()}
    >
      <span class="material-symbols-rounded app-icon" aria-hidden="true">block</span>
      <span>{selectionStates.length > 1 ? t("members.banSelected", { count: selectionStates.length }) : t("members.banMember")}</span>
    </button>
  {/if}
</div>
{/if}
