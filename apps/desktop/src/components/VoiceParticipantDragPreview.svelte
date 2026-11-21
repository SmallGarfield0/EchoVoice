<script lang="ts">
  import type { VoiceState } from "../lib/types";

  type Props = {
    voiceParticipantDragMemberId: string;
    voiceParticipantDragParticipantId: string;
    draggedVoiceState: VoiceState | undefined;
    previewStyle: string;
    isVoiceStateSpeaking: (state: VoiceState | undefined) => boolean;
    memberAvatarStyle: (memberId: string) => string;
    memberAvatarDataURL: (memberId: string) => string;
    memberInitials: (memberId: string) => string;
    memberDisplayName: (memberId: string) => string;
    selectedVoiceParticipantIds: Set<string>;
    hasVoiceRestriction: (state: VoiceState | undefined) => boolean;
    voiceRestrictionIcon: (state: VoiceState | undefined) => string;
  };

  let {
    voiceParticipantDragMemberId,
    voiceParticipantDragParticipantId,
    draggedVoiceState,
    previewStyle,
    isVoiceStateSpeaking,
    memberAvatarStyle,
    memberAvatarDataURL,
    memberInitials,
    memberDisplayName,
    selectedVoiceParticipantIds,
    hasVoiceRestriction,
    voiceRestrictionIcon
  }: Props = $props();
</script>

{#if voiceParticipantDragMemberId}
  <div
    class="voice-participant-drag-preview"
    class:speaking={isVoiceStateSpeaking(draggedVoiceState)}
    style={previewStyle}
    aria-hidden="true"
  >
    <span class="avatar member-avatar voice-participant-avatar" style={memberAvatarStyle(voiceParticipantDragMemberId)}>{#if memberAvatarDataURL(voiceParticipantDragMemberId)}<img src={memberAvatarDataURL(voiceParticipantDragMemberId)} alt="" />{:else}{memberInitials(voiceParticipantDragMemberId)}{/if}</span>
    <span>{memberDisplayName(voiceParticipantDragMemberId)}</span>
    {#if selectedVoiceParticipantIds.has(voiceParticipantDragParticipantId) && selectedVoiceParticipantIds.size > 1}
      <span class="voice-participant-drag-count">+{selectedVoiceParticipantIds.size - 1}</span>
    {/if}
    {#if hasVoiceRestriction(draggedVoiceState)}
      <span class="material-symbols-rounded app-icon" aria-hidden="true">{voiceRestrictionIcon(draggedVoiceState)}</span>
    {/if}
  </div>
{/if}
