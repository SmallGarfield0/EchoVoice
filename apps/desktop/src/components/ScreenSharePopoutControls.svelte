<script lang="ts">
  // Native screen-share popout volume/close controls. Volume state lives in
  // AudioDevicesController; popout window handling in ScreenShareTransportController.
  import type { AudioDevicesController } from "../lib/audio-devices.svelte";
  import type { ScreenShareTransportController } from "../lib/screen-share-transport.svelte";
  import type { ScreenShareSession } from "../lib/types";

  let {
    t,
    audio,
    transport,
    focusedScreenShare
  }: {
    t: (key: string, params?: Record<string, string | number>) => string;
    audio: AudioDevicesController;
    transport: ScreenShareTransportController;
    focusedScreenShare: ScreenShareSession | undefined;
  } = $props();

  const memberVolumeLimitPercent = $derived(audio.memberVolumeLimitPercent);
  const screenShareVolumePercents = $derived(audio.screenShareVolumePercents);
  const screenShareVolumePercent = (targetMemberId: string, values = screenShareVolumePercents) =>
    audio.screenShareVolumePercent(targetMemberId, values);
  const voiceRangeProgress = (value: number, maximum: number) => audio.voiceRangeProgress(value, maximum);
  const changeScreenShareVolume = (targetMemberId: string, event: Event) =>
    audio.changeScreenShareVolume(targetMemberId, event);
  const closeScreenSharePopoutWindow = () => transport.closeScreenSharePopoutWindow();
</script>

<div
  class="screen-share-popout-controls"
  role="toolbar"
  tabindex="-1"
  aria-label={t("screenShare.viewerTitle")}
  data-screen-share-popout-no-drag
  onmousedown={(event) => { event.stopPropagation(); }}
  ondblclick={(event) => { event.stopPropagation(); }}
>
  <span class="material-symbols-rounded app-icon screen-share-popout-volume-icon" aria-hidden="true">
    {audio.screenShareVolumeIcon(screenShareVolumePercent(focusedScreenShare?.owner_member_id ?? "", screenShareVolumePercents))}
  </span>
  <input
    class="screen-share-popout-volume-slider"
    type="range"
    min="0"
    max={memberVolumeLimitPercent}
    step="5"
    value={screenShareVolumePercent(focusedScreenShare?.owner_member_id ?? "", screenShareVolumePercents)}
    style={`--voice-range-progress: ${voiceRangeProgress(screenShareVolumePercent(focusedScreenShare?.owner_member_id ?? "", screenShareVolumePercents), memberVolumeLimitPercent)};`}
    aria-label={t("screenShare.volume")}
    disabled={!focusedScreenShare}
    oninput={(event) => focusedScreenShare && changeScreenShareVolume(focusedScreenShare.owner_member_id, event)}
  />
  <output class="screen-share-popout-volume-value">
    {screenShareVolumePercent(focusedScreenShare?.owner_member_id ?? "", screenShareVolumePercents)}%
  </output>
  <button class="screen-share-focus-control-button" class:active={transport.diagnosticsOpen}
    type="button" data-screen-share-diagnostics-toggle aria-label={t("screenShare.diagnostics")} data-tooltip={t("screenShare.diagnostics")}
    aria-pressed={transport.diagnosticsOpen} onclick={() => transport.toggleDiagnostics()}>
    <span class="material-symbols-rounded app-icon" aria-hidden="true">monitoring</span>
  </button>
  <button
    class="screen-share-popout-close"
    type="button"
    aria-label={t("app.close")}
    onmousedown={(event) => { event.stopPropagation(); }}
    onclick={() => void closeScreenSharePopoutWindow()}
  >
    <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
  </button>
</div>
