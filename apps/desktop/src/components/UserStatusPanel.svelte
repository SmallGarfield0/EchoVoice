<script lang="ts">
  // User status / voice connection panel: controller-based wiring. Audio,
  // voice session, screen share, accompaniment, soundboard and workspace state
  // are read directly from controllers; a few App-owned helpers (audio
  // playback unlock, busy flags, popover DOM setters, resize action) remain.
  import { hasEffectivePermission } from "../lib/permissions";
  import { maximumAccompanimentSendVolumePercent } from "../lib/accompaniment.svelte";
  import type { AccompanimentController } from "../lib/accompaniment.svelte";
  import type { AudioDevicesController } from "../lib/audio-devices.svelte";
  import type { ChannelsController } from "../lib/channels.svelte";
  import type { NativeVoiceController } from "../lib/native-voice.svelte";
  import type { PermissionsController } from "../lib/permissions.svelte";
  import type { ScreenShareController } from "../lib/screen-share.svelte";
  import type { ScreenShareSetupController } from "../lib/screen-share-setup.svelte";
  import type { ScreenShareTransportController } from "../lib/screen-share-transport.svelte";
  import type { SoundboardController } from "../lib/soundboard.svelte";
  import type { VoiceSessionController } from "../lib/voice-session.svelte";
  import type { VoiceStageController } from "../lib/voice-stage.svelte";
  import type { VoiceStateController, VoiceConnectionContext } from "../lib/voice-state.svelte";
  import type { WorkspaceController } from "../lib/workspace.svelte";
  import type { Member, ServerRole, VoiceNoiseSuppressionMode, VoiceState } from "../lib/types";

  let {
    t,
    workspace,
    voiceState,
    voiceSession,
    voiceStage,
    audio,
    screenShare,
    screenShareSetup,
    transport,
    accompaniment,
    soundboard,
    nativeVoice,
    channelsController,
    permissionsController,
    remoteAudioPlaybackBlocked,
    prepareVoiceAudioPlayback,
    screenShareActionBusy,
    voiceActionBusy,
    voiceConnectionNavigationBusy,
    set_accompanimentVolumePopoverAnchor,
    set_accompanimentVolumePopoverElement,
    set_soundboardPopoverAnchor,
    measureUserStatusPanel,
    realtimeSyncTick,
    currentVoiceStateValue,
    voiceConnectionContext
  }: {
    t: (key: string, params?: Record<string, string | number>) => string;
    workspace: WorkspaceController;
    voiceState: VoiceStateController;
    voiceSession: VoiceSessionController;
    voiceStage: VoiceStageController;
    audio: AudioDevicesController;
    screenShare: ScreenShareController;
    screenShareSetup: ScreenShareSetupController;
    transport: ScreenShareTransportController;
    accompaniment: AccompanimentController;
    soundboard: SoundboardController;
    nativeVoice: NativeVoiceController;
    channelsController: ChannelsController;
    permissionsController: PermissionsController;
    remoteAudioPlaybackBlocked: boolean;
    prepareVoiceAudioPlayback: () => void;
    screenShareActionBusy: boolean;
    voiceActionBusy: boolean;
    voiceConnectionNavigationBusy: boolean;
    set_accompanimentVolumePopoverAnchor: (element: HTMLButtonElement | null) => void;
    set_accompanimentVolumePopoverElement: (element: HTMLDivElement | null) => void;
    set_soundboardPopoverAnchor: (element: HTMLButtonElement | null) => void;
    measureUserStatusPanel: (node: HTMLElement) => { destroy: () => void };
    realtimeSyncTick: number;
    currentVoiceStateValue: VoiceState | undefined;
    voiceConnectionContext: VoiceConnectionContext | null;
  } = $props();

  let _accompanimentVolumePopoverAnchor = $state<HTMLButtonElement | undefined>(undefined);
  $effect(() => { set_accompanimentVolumePopoverAnchor?.(_accompanimentVolumePopoverAnchor ?? null); });
  let _accompanimentVolumePopoverElement = $state<HTMLDivElement | undefined>(undefined);
  $effect(() => { set_accompanimentVolumePopoverElement?.(_accompanimentVolumePopoverElement ?? null); });
  let _soundboardPopoverAnchor = $state<HTMLButtonElement | undefined>(undefined);
  $effect(() => { set_soundboardPopoverAnchor?.(_soundboardPopoverAnchor ?? null); });

  const server = $derived.by(() => { realtimeSyncTick; return workspace.server; });
  const activeServerId = $derived.by(() => { realtimeSyncTick; return workspace.activeServerId; });
  const memberId = $derived.by(() => { realtimeSyncTick; return workspace.memberId; });
  const sessionToken = $derived.by(() => { realtimeSyncTick; return workspace.sessionToken; });
  const localUserProfile = $derived.by(() => { realtimeSyncTick; return workspace.localUserProfile; });
  const nativeDesktopRuntime = $derived.by(() => { realtimeSyncTick; return workspace.nativeDesktopRuntime; });
  const members = $derived.by(() => { realtimeSyncTick; return workspace.members; });
  const roles = $derived(permissionsController.roles);
  const currentMember = $derived.by(() => { realtimeSyncTick; return members.find((member) => member.member_id === memberId); });
  const currentUserDisplayNameValue = $derived.by(() => {
    realtimeSyncTick;
    return currentMember?.display_name || localUserProfile.display_name || workspace.displayName || "EchoVoice User";
  });

  const micMuted = $derived(audio.micMuted);
  const audioDeafened = $derived(audio.audioDeafened);
  const microphoneGainLimitPercent = $derived(audio.microphoneGainLimitPercent);
  const microphoneGainPercent = $derived(audio.microphoneGainPercent);
  const microphonePopoverOpen = $derived(audio.microphonePopoverOpen);
  const noiseSuppressionMode = $derived(audio.noiseSuppressionMode);
  const outputVolumePercent = $derived(audio.outputVolumePercent);
  const screenShareSetupOpen = $derived(screenShareSetup.setupOpen);
  const nativeVoiceSession = $derived(nativeVoice.nativeVoiceSession);
  const voiceConnectionStatus = $derived(voiceSession.connectionStatus);
  const voiceInboundKbps = $derived(voiceSession.inboundKbps);
  const voiceJitterMS = $derived(voiceSession.jitterMS);
  const voiceLatencyFailureCount = $derived(voiceSession.latencyFailureCount);
  const voiceLatencyMS = $derived(voiceSession.latencyMS);
  const voiceLatencyMeasuredAtMS = $derived(voiceSession.latencyMeasuredAtMS);
  const voiceNetworkDetailsOpen = $derived(voiceSession.networkDetailsOpen);
  const voiceNetworkSampleSource = $derived(voiceSession.networkSampleSource);
  const voiceOutboundKbps = $derived(voiceSession.outboundKbps);
  const voicePacketLossLabel = $derived(voiceSession.packetLossLabel);
  const voicePeerCount = $derived(voiceSession.peerCount);
  const accompanimentActionBusy = $derived(accompaniment.actionBusy);
  const accompanimentDialogOpen = $derived(accompaniment.dialogOpen);
  const accompanimentSendVolumePercent = $derived(accompaniment.sendVolumePercent);
  const accompanimentVolumePopoverOpen = $derived(accompaniment.volumePopoverOpen);
  const accompanimentVolumePopoverStyle = $derived(accompaniment.volumePopoverStyle);
  const soundboardPopoverOpen = $derived(soundboard.popoverOpen);
  const soundboardItems = $derived(soundboard.items);
  const localSoundboardItems = $derived(soundboard.localItems);

  const canShareScreen = $derived.by(() => { realtimeSyncTick; return hasEffectivePermission("share_screen", workspace.isOwner, currentMember, roles, permissionsController.rolePreviewId); });
  const canPlayAccompaniment = $derived.by(() => { realtimeSyncTick; return hasEffectivePermission("play_accompaniment", workspace.isOwner, currentMember, roles, permissionsController.rolePreviewId); });
  const canPlaySoundboard = $derived.by(() => { realtimeSyncTick; return hasEffectivePermission("play_soundboard", workspace.isOwner, currentMember, roles, permissionsController.rolePreviewId); });

  const processAccompanimentAvailable = $derived.by(() => { realtimeSyncTick; return Boolean(
    nativeDesktopRuntime &&
      screenShareSetup.desktopMediaCapabilities?.audioBackends.includes("windows-process-loopback")
  ); });

  const currentVoiceChannelValue = $derived.by(() => {
    realtimeSyncTick;
    return currentVoiceStateValue && voiceConnectionContext?.serverId === activeServerId
      ? channelsController.channels.find((channel) => channel.channel_id === currentVoiceStateValue?.channel_id)
      : undefined;
  });
  const connectedVoiceServerLabelValue = $derived.by(() => { realtimeSyncTick; return voiceConnectionContext?.serverName ?? "EchoVoice"; });
  const connectedVoiceChannelLabelValue = $derived.by(() => {
    realtimeSyncTick;
    return currentVoiceChannelValue
      ? channelsController.channelNameForDisplay(currentVoiceChannelValue)
      : voiceConnectionContext?.channelName ?? currentVoiceStateValue?.channel_id ?? "";
  });
  const currentVoiceScreenShares = $derived.by(() => {
    realtimeSyncTick;
    return currentVoiceStateValue && voiceConnectionContext?.serverId === activeServerId
      ? screenShare.sessions.filter((share) => share.channel_id === currentVoiceStateValue?.channel_id)
      : [];
  });
  const currentVoiceAccompaniments = $derived.by(() => {
    realtimeSyncTick;
    return currentVoiceStateValue && voiceConnectionContext?.serverId === activeServerId
      ? accompaniment.sessions.filter((session) => session.channel_id === currentVoiceStateValue?.channel_id)
      : [];
  });
  const currentMemberScreenShare = $derived(
    screenShare.sessions.find((share) => share.owner_participant_id === currentVoiceStateValue?.participant_id)
  );
  const currentMemberActiveScreenShare = $derived(Boolean(
    currentMemberScreenShare && transport.localScreenShareCaptureActive()
  ));
  const currentMemberAccompaniment = $derived(
    voiceConnectionContext?.serverId === activeServerId
      ? accompaniment.sessions.find((session) => session.owner_member_id === voiceConnectionContext?.memberId)
      : undefined
  );

  const screenShareEntryDisabledValue = $derived(Boolean(
    !server?.screen_share_enabled ||
      !currentVoiceStateValue ||
      currentVoiceStateValue.mode === "listener" ||
      !sessionToken ||
      !canShareScreen ||
      currentMemberActiveScreenShare ||
      screenShareActionBusy
  ));

  const voiceLatencyQualityValue = $derived(audio.computeVoiceLatencyQuality(voiceLatencyMS));
  const voiceLatencyQualityClassValue = $derived(`latency-${voiceLatencyQualityValue}`);
  const voiceLatencyIconValue = $derived(audio.voiceLatencyIconForQuality(voiceLatencyQualityValue));
  const voiceLatencyLabelValue = $derived(
    voiceLatencyMS == null ? t("voice.latencyUnknown") : t("voice.latencyValue", { ms: voiceLatencyMS })
  );
  const voiceLatencyQualityLabelValue = $derived(audio.voiceLatencyQualityLabelForQuality(voiceLatencyQualityValue));
  const voiceLatencyTooltipValue = $derived(`${voiceLatencyQualityLabelValue} - ${t("voice.roundTrip")}: ${voiceLatencyLabelValue}`);
  const voiceLatencyMeasuredAtLabelValue = $derived(audio.formatVoiceLatencyMeasuredAt(voiceLatencyMeasuredAtMS));

  const noiseSuppressionModes: VoiceNoiseSuppressionMode[] = ["off", "light", "standard", "strong"];

  const changeAccompanimentSendVolume = (event: Event) => accompaniment.changeSendVolume(event);
  const changeMicrophoneGain = (event: Event) => audio.changeMicrophoneGain(event);
  const changeOutputVolume = (event: Event) => audio.changeOutputVolume(event);
  const formatKbps = (value: number | null) => audio.formatKbps(value);
  const handleScreenShareEntryClick = () => screenShareSetup.handleEntryClick();
  const handleScreenShareEntryPointerDown = (event: PointerEvent) => screenShareSetup.handleEntryPointerDown(event);
  const leaveCurrentVoiceChannel = () => voiceStage.leaveCurrentVoiceChannel();
  const memberAvatarStyle = (id: string) => permissionsController.memberAvatarStyle(id);
  const navigateToConnectedVoiceChannel = () => channelsController.navigateToConnectedVoiceChannel();
  const noiseSuppressionModeDescription = (mode: VoiceNoiseSuppressionMode) => audio.noiseSuppressionModeDescription(mode);
  const noiseSuppressionModeIcon = (mode: VoiceNoiseSuppressionMode) => audio.noiseSuppressionModeIcon(mode);
  const noiseSuppressionModeLabel = (mode: VoiceNoiseSuppressionMode) => audio.noiseSuppressionModeLabel(mode);
  const openAccompanimentDialog = () => accompaniment.openDialog();
  const openAppSettings = () => workspace.openAppSettings();
  const openMicrophonePopover = () => audio.openMicrophonePopover();
  const resetAccompanimentSendVolume = () => accompaniment.resetSendVolume();
  const scheduleMicrophonePopoverClose = () => audio.scheduleMicrophonePopoverClose();
  const screenShareVolumeIcon = (volume: number) => audio.screenShareVolumeIcon(volume);
  const selectNoiseSuppressionMode = (mode: VoiceNoiseSuppressionMode) => audio.selectNoiseSuppressionMode(mode);
  const stopCurrentAccompaniment = () => accompaniment.stopCurrent();
  const stopCurrentScreenShareSession = () => screenShareSetup.stopCurrentSession();
  const toggleAccompanimentVolumePopover = (event: MouseEvent) => accompaniment.toggleVolumePopover(event);
  const toggleAudioDeafened = () => audio.toggleAudioDeafened();
  const toggleMicMuted = () => audio.toggleMicMuted();
  const toggleSoundboardPopover = () => soundboard.togglePopover();
  const toggleVoiceNetworkDetails = () => audio.toggleVoiceNetworkDetails();
  const voiceRangeProgress = (value: number, maximum: number) => audio.voiceRangeProgress(value, maximum);
  const voiceStatusLabel = () => audio.voiceStatusLabel();
  const currentUserStatusLabel = () => audio.currentUserStatusLabel();

  function serverInitials(name: string) {
    return name.trim().slice(0, 2).toUpperCase() || "EV";
  }
</script>

<div class="user-status-panel" class:voice-active={Boolean(currentVoiceStateValue)} use:measureUserStatusPanel>
    {#if currentVoiceStateValue}
      <div class="voice-connection-card">
        <div class="voice-connection-row">
          <button
            type="button"
            class={`voice-latency-indicator ${voiceLatencyQualityClassValue}`}
            title={voiceLatencyTooltipValue}
            aria-label={voiceLatencyTooltipValue}
            aria-expanded={voiceNetworkDetailsOpen}
            onclick={toggleVoiceNetworkDetails}
          >
            <span class="material-symbols-rounded app-icon" aria-hidden="true">{voiceLatencyIconValue}</span>
          </button>
          <div class="voice-connection-detail">
            <p>{voiceStatusLabel()}</p>
            <button
              class="voice-connection-channel"
              type="button"
              disabled={voiceConnectionNavigationBusy}
              aria-label={t("voice.goToChannel", { server: connectedVoiceServerLabelValue, channel: connectedVoiceChannelLabelValue })}
              onclick={navigateToConnectedVoiceChannel}
            >
              <span>{connectedVoiceServerLabelValue} / {connectedVoiceChannelLabelValue}</span>
              <span class="material-symbols-rounded app-icon" class:loading={voiceConnectionNavigationBusy} aria-hidden="true">
                {voiceConnectionNavigationBusy ? "progress_activity" : "arrow_forward"}
              </span>
            </button>
          </div>
          <div class="voice-connection-actions">
            <button type="button" title={t("voice.disconnect")} aria-label={t("voice.disconnect")} disabled={voiceActionBusy} onclick={leaveCurrentVoiceChannel}>
              <span class="material-symbols-rounded app-icon" aria-hidden="true">call_end</span>
            </button>
          </div>
        </div>
        {#if remoteAudioPlaybackBlocked && !nativeDesktopRuntime}
          <button class="voice-audio-resume" type="button" onclick={prepareVoiceAudioPlayback}>
            <span class="material-symbols-rounded app-icon" aria-hidden="true">play_circle</span>
            <span>{t("voice.resumeAudio")}</span>
          </button>
        {/if}
        {#if voiceConnectionContext?.serverId === activeServerId}
        <div class="voice-media-action-row">
          <div class="screen-share-card compact" class:disabled={!server?.screen_share_enabled}>
            <button
              class="voice-media-action-button"
              class:active={screenShareSetupOpen || currentMemberActiveScreenShare}
              class:danger={currentMemberActiveScreenShare}
              type="button"
              disabled={currentMemberActiveScreenShare ? screenShareActionBusy : screenShareEntryDisabledValue}
              aria-label={currentMemberActiveScreenShare ? t("screenShare.stop") : t("screenShare.start")}
              aria-expanded={screenShareSetupOpen}
              onpointerdown={(event) => { event.stopPropagation(); const handler = (currentMemberActiveScreenShare ? undefined : handleScreenShareEntryPointerDown); if (handler) return handler(event); }}
              onclick={(event) => { event.stopPropagation(); const handler = (currentMemberActiveScreenShare ? () => void stopCurrentScreenShareSession() : handleScreenShareEntryClick); if (handler) return handler(event); }}
            >
              <span class="material-symbols-rounded app-icon" aria-hidden="true">{currentMemberActiveScreenShare ? "stop_screen_share" : "present_to_all"}</span>
              <span>{t("screenShare.title")}</span>
              {#if currentVoiceScreenShares.length > 0}
                <small>{currentVoiceScreenShares.length}</small>
              {/if}
            </button>
          </div>

          <div class="accompaniment-card compact" class:disabled={!server?.accompaniment_enabled}>
            <div class="accompaniment-action-group" class:playing={Boolean(currentMemberAccompaniment)}>
              <button
                class="voice-media-action-button"
                class:active={accompanimentDialogOpen || Boolean(currentMemberAccompaniment)}
                class:danger={Boolean(currentMemberAccompaniment)}
                type="button"
                disabled={currentMemberAccompaniment ? accompanimentActionBusy : currentVoiceStateValue.mode === "listener" || !server?.accompaniment_enabled || (nativeDesktopRuntime && (!processAccompanimentAvailable || !nativeVoiceSession)) || !canPlayAccompaniment || accompanimentActionBusy}
                aria-label={currentMemberAccompaniment ? t("accompaniment.stop") : t("accompaniment.start")}
                aria-expanded={accompanimentDialogOpen}
                onclick={currentMemberAccompaniment ? () => void stopCurrentAccompaniment() : () => void openAccompanimentDialog()}
              >
                <span class="material-symbols-rounded app-icon" aria-hidden="true">{currentMemberAccompaniment ? "music_off" : "library_music"}</span>
                <span>{t("accompaniment.title")}</span>
                {#if currentVoiceAccompaniments.length > 0}
                  <small>{currentVoiceAccompaniments.length}</small>
                {/if}
              </button>
              {#if currentMemberAccompaniment}
                <button
                  bind:this={_accompanimentVolumePopoverAnchor}
                  class="accompaniment-volume-button"
                  class:active={accompanimentVolumePopoverOpen}
                  type="button"
                  data-tooltip={t("accompaniment.sendVolume")}
                  aria-label={t("accompaniment.sendVolume")}
                  aria-expanded={accompanimentVolumePopoverOpen}
                  onclick={toggleAccompanimentVolumePopover}
                >
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">{screenShareVolumeIcon(accompanimentSendVolumePercent)}</span>
                </button>
              {/if}
            </div>
            {#if accompanimentVolumePopoverOpen && currentMemberAccompaniment}
              <div
                bind:this={_accompanimentVolumePopoverElement}
                class="accompaniment-volume-popover"
                style={accompanimentVolumePopoverStyle}
                role="dialog"
                tabindex="-1"
                aria-label={t("accompaniment.sendVolume")}
                use:portal
                onpointerdown={(event) => { event.stopPropagation(); }}
              >
                <div>
                  <span class="material-symbols-rounded app-icon" aria-hidden="true">music_note</span>
                  <span>{t("accompaniment.sendVolume")}</span>
                  <strong>{accompanimentSendVolumePercent}%</strong>
                  <button type="button" data-tooltip={t("voice.resetVolume")} aria-label={t("voice.resetVolume")} onclick={resetAccompanimentSendVolume}>
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">sync</span>
                  </button>
                </div>
                <input
                  type="range"
                  min="0"
                  max={maximumAccompanimentSendVolumePercent}
                  step="5"
                  value={accompanimentSendVolumePercent}
                  style={`--voice-range-progress: ${voiceRangeProgress(accompanimentSendVolumePercent, maximumAccompanimentSendVolumePercent)};`}
                  aria-label={t("accompaniment.sendVolume")}
                  oninput={changeAccompanimentSendVolume}
                />
                <p>{t("accompaniment.sendVolumeDescription")}</p>
              </div>
            {/if}
          </div>

          <div class="soundboard-card compact" class:disabled={!server?.soundboard_enabled}>
            <button
              bind:this={_soundboardPopoverAnchor}
              class="voice-media-action-button"
              class:active={soundboardPopoverOpen}
              type="button"
              disabled={!server?.soundboard_enabled || !currentVoiceStateValue || currentVoiceStateValue.mode === "listener" || !canPlaySoundboard}
              data-label={!server?.soundboard_enabled ? t("soundboard.disabled") : !canPlaySoundboard ? t("soundboard.permissionRequired") : t("soundboard.open")}
              aria-label={t("soundboard.open")}
              aria-expanded={soundboardPopoverOpen}
              onclick={(event) => { event.stopPropagation(); const handler = (() => void toggleSoundboardPopover()); if (handler) return handler(event); }}
            >
              <span class="material-symbols-rounded app-icon" aria-hidden="true">instant_mix</span>
              <span>{t("soundboard.title")}</span>
              {#if soundboardItems.length + localSoundboardItems.length > 0}
                <small>{soundboardItems.length + localSoundboardItems.length}</small>
              {/if}
            </button>
          </div>
        </div>
        {/if}
      </div>
    {/if}

    <div class="user-status-row">
      <div class="avatar member-avatar user-status-avatar" style={memberAvatarStyle(memberId || localUserProfile.local_profile_id)}>
        {#if currentMember?.avatar_data_url || localUserProfile.avatar_data_url}
          <img src={currentMember?.avatar_data_url || localUserProfile.avatar_data_url} alt="" />
        {:else}
          {serverInitials(currentUserDisplayNameValue)}
        {/if}
      </div>
      <div class="user-status-detail">
        <p>{currentUserDisplayNameValue}</p>
        {#if currentUserStatusLabel()}<span>{currentUserStatusLabel()}</span>{/if}
      </div>
      <div class="user-status-actions">
        <div
          class="user-status-volume-control"
          class:popover-open={microphonePopoverOpen}
          role="group"
          aria-label={t("voice.microphoneVolume")}
          onpointerenter={openMicrophonePopover}
          onpointerleave={scheduleMicrophonePopoverClose}
        >
          <button
            type="button"
            class:active={micMuted}
            aria-label={micMuted ? t("userStatus.unmuteMic") : t("userStatus.muteMic")}
            disabled={currentVoiceStateValue?.mode === "listener" || audioDeafened || currentVoiceStateValue?.server_muted || currentVoiceStateValue?.server_deafened}
            onclick={() => void toggleMicMuted()}
          >
            <span class="material-symbols-rounded app-icon" aria-hidden="true">{micMuted ? "mic_off" : "mic"}</span>
          </button>
          <div
            class="user-status-volume-popover microphone-popover"
            role="group"
            aria-label={t("voice.microphoneVolume")}
            onpointerenter={openMicrophonePopover}
            onpointerleave={scheduleMicrophonePopoverClose}
          >
            <div><span>{t("voice.microphoneVolume")}</span><strong>{microphoneGainPercent}%</strong></div>
            <input
              type="range"
              min="0"
              max={microphoneGainLimitPercent}
              step="5"
              value={microphoneGainPercent}
              style={`--voice-range-progress: ${voiceRangeProgress(microphoneGainPercent, microphoneGainLimitPercent)};`}
              aria-label={t("voice.microphoneVolume")}
              onpointerdown={(event) => { event.stopPropagation(); }}
              oninput={changeMicrophoneGain}
            />
            <section class="quick-noise-suppression" aria-label={t("voice.noiseSuppression")}>
              <span>{t("voice.noiseSuppression")}</span>
              <div role="radiogroup" aria-label={t("voice.noiseSuppression")}>
                {#each noiseSuppressionModes as mode}
                  <button
                    type="button"
                    class:active={noiseSuppressionMode === mode}
                    role="radio"
                    aria-checked={noiseSuppressionMode === mode}
                    aria-label={noiseSuppressionModeLabel(mode)}
                    data-tooltip={noiseSuppressionModeDescription(mode)}
                    onpointerdown={(event) => { event.stopPropagation(); }}
                    onclick={(event) => { event.stopPropagation(); const handler = (() => void selectNoiseSuppressionMode(mode)); if (handler) return handler(event); }}
                  >
                    <span class="material-symbols-rounded app-icon" aria-hidden="true">{noiseSuppressionModeIcon(mode)}</span>
                    <span>{noiseSuppressionModeLabel(mode)}</span>
                  </button>
                {/each}
              </div>
            </section>
          </div>
        </div>
        <div class="user-status-volume-control">
          <button
            type="button"
            class:active={audioDeafened}
            aria-label={audioDeafened ? t("userStatus.undeafen") : t("userStatus.deafen")}
            disabled={currentVoiceStateValue?.server_deafened}
            onclick={toggleAudioDeafened}
          >
            <span class="material-symbols-rounded app-icon" aria-hidden="true">{audioDeafened ? "headset_off" : "headphones"}</span>
          </button>
          <div class="user-status-volume-popover" role="group" aria-label={t("voice.outputVolume")}>
            <div><span>{t("voice.outputVolume")}</span><strong>{outputVolumePercent}%</strong></div>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={outputVolumePercent}
              style={`--voice-range-progress: ${outputVolumePercent}%;`}
              aria-label={t("voice.outputVolume")}
              onpointerdown={(event) => { event.stopPropagation(); }}
              oninput={changeOutputVolume}
            />
          </div>
        </div>
        <button type="button" title={t("appSettings.title")} onclick={openAppSettings}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">settings</span>
        </button>
      </div>
    </div>

    {#if currentVoiceStateValue && voiceNetworkDetailsOpen}
      <div class="voice-network-popover" role="dialog" aria-label={t("voice.networkDetails")}>
        <div>
          <span>{t("voice.networkQuality")}</span>
          <strong>{voiceLatencyQualityLabelValue}</strong>
        </div>
        <div>
          <span>{t("voice.roundTrip")}</span>
          <strong>{voiceLatencyLabelValue}</strong>
        </div>
        <div>
          <span>{t("voice.jitter")}</span>
          <strong>{voiceJitterMS == null ? "-" : t("voice.latencyValue", { ms: voiceJitterMS })}</strong>
        </div>
        <div>
          <span>{t("voice.packetLoss")}</span>
          <strong>{voicePacketLossLabel}</strong>
        </div>
        <div>
          <span>{t("voice.inboundBitrate")}</span>
          <strong>{formatKbps(voiceInboundKbps)}</strong>
        </div>
        <div>
          <span>{t("voice.outboundBitrate")}</span>
          <strong>{formatKbps(voiceOutboundKbps)}</strong>
        </div>
        <div>
          <span>{t("voice.sampleSource")}</span>
          <strong>{voiceNetworkSampleSource}</strong>
        </div>
        <div>
          <span>{t("voice.lastMeasured")}</span>
          <strong>{voiceLatencyMeasuredAtLabelValue}</strong>
        </div>
        <div>
          <span>{t("voice.peerConnections")}</span>
          <strong>{voicePeerCount}</strong>
        </div>
        <div>
          <span>{t("voice.connectionState")}</span>
          <strong>{voiceConnectionStatus}</strong>
        </div>
        <div>
          <span>{t("voice.failedMeasurements")}</span>
          <strong>{voiceLatencyFailureCount}</strong>
        </div>
      </div>
    {/if}
</div>
