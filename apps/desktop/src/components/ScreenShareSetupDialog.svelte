<script lang="ts">
  import type { ScreenShareSetupController } from "../lib/screen-share-setup.svelte";
  import type { RemoteControlController } from "../lib/remote-control.svelte";
  import type { ServerSummary } from "../lib/types";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type Props = {
    t: Translate;
    screenShareSetup: ScreenShareSetupController;
    remoteControl: RemoteControlController;
    server: ServerSummary | null;
    screenShareActionBusy: boolean;
    screenShareAudioAvailable: boolean;
    currentMemberActiveScreenShare: boolean;
    isTauriRuntime: () => boolean;
    setResolutionButton: (element: HTMLButtonElement | null) => void;
    setFrameRateButton: (element: HTMLButtonElement | null) => void;
    setBitrateButton: (element: HTMLButtonElement | null) => void;
    setContentModeButton: (element: HTMLButtonElement | null) => void;
  };

  let {
    t,
    screenShareSetup,
    remoteControl,
    server,
    screenShareActionBusy,
    screenShareAudioAvailable,
    currentMemberActiveScreenShare,
    isTauriRuntime,
    setResolutionButton,
    setFrameRateButton,
    setBitrateButton,
    setContentModeButton
  }: Props = $props();

  let resolutionButton = $state<HTMLButtonElement | null>(null);
  let frameRateButton = $state<HTMLButtonElement | null>(null);
  let bitrateButton = $state<HTMLButtonElement | null>(null);
  let contentModeButton = $state<HTMLButtonElement | null>(null);

  // The setup controller keeps these DOM refs for menu positioning. The
  // workspace component owns the backing variables because controller hooks
  // read them lazily; this component only writes them back through setters.
  $effect(() => {
    setResolutionButton(resolutionButton);
    return () => setResolutionButton(null);
  });
  $effect(() => {
    setFrameRateButton(frameRateButton);
    return () => setFrameRateButton(null);
  });
  $effect(() => {
    setBitrateButton(bitrateButton);
    return () => setBitrateButton(null);
  });
  $effect(() => {
    setContentModeButton(contentModeButton);
    return () => setContentModeButton(null);
  });
</script>

{#if screenShareSetup.setupOpen && !currentMemberActiveScreenShare}
<div class="screen-share-config-overlay" role="presentation">
  <dialog class="screen-share-config-dialog" open aria-label={t("screenShare.configureTitle")}>
    <header>
      <div>
        <p class="section-label">{t("screenShare.title")}</p>
        <h2>{t("screenShare.configureTitle")}</h2>
      </div>
      <button type="button" title={t("app.close")} aria-label={t("app.close")} onclick={() => screenShareSetup.closeSetup()}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
      </button>
    </header>

    <div class="screen-share-config-body">
      <section class="screen-share-source-configuration">
        <button class="screen-share-source-button" type="button" disabled={screenShareActionBusy} onclick={() => screenShareSetup.openSourceStep()}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">select_window</span>
          <span>
            <strong>{screenShareSetup.configurationSourceReady ? t("screenShare.changeSource") : t("screenShare.chooseSource")}</strong>
            <small>{screenShareSetup.configurationSourceReady ? screenShareSetup.selectedDesktopCaptureSource?.name ?? t("screenShare.browserSelectedSource") : t("screenShare.chooseSourceDescription")}</small>
          </span>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">chevron_right</span>
        </button>
        {#if screenShareSetup.webAudioMissing}
          <p class="screen-share-source-required warning" role="status">
            <span class="material-symbols-rounded app-icon" aria-hidden="true">warning</span>
            <span>{t("screenShare.webAudioNotCaptured")}</span>
          </p>
        {:else if !screenShareSetup.configurationSourceReady}
          <p class="screen-share-source-required">
            <span class="material-symbols-rounded app-icon" aria-hidden="true">info</span>
            <span>{t("screenShare.sourceRequiredBeforeStart")}</span>
          </p>
        {/if}
      </section>

      <section class="screen-share-config-options">
        <div class="screen-share-audio-option">
          <button class="screen-share-option-switch" type="button" role="switch" aria-checked={screenShareSetup.audioEnabled} aria-describedby="screen-share-audio-tooltip" disabled={!screenShareAudioAvailable || screenShareActionBusy} onclick={() => screenShareSetup.toggleAudio()}>
            <span class="screen-share-option-label">
              <span class="material-symbols-rounded app-icon" aria-hidden="true">volume_up</span>
              <span class="screen-share-audio-label">
                <span>{t("screenShare.shareAudio")}</span>
                <span class="material-symbols-rounded app-icon screen-share-audio-help-icon" aria-hidden="true">info</span>
              </span>
            </span>
            <span class="screen-share-switch-track" aria-hidden="true"><span class="screen-share-switch-thumb"></span></span>
          </button>
          <span
            id="screen-share-audio-tooltip"
            class="screen-share-audio-tooltip"
            class:warning={!isTauriRuntime()}
            role="tooltip"
          >
            {#if !screenShareAudioAvailable}
              {t("screenShare.audioUnavailable")}
            {:else if isTauriRuntime()}
              {t("screenShare.nativeAudioFiltered")}
            {:else if screenShareSetup.audioEnabled && screenShareSetup.pendingWebAudioTrackAvailable === false}
              {t("screenShare.webAudioNotCaptured")}
            {:else}
              {t("screenShare.webAudioEchoWarning")}
            {/if}
          </span>
        </div>
        <button class="screen-share-option-switch" type="button" role="switch" aria-checked={screenShareSetup.captureCursor} disabled={screenShareActionBusy} onclick={() => screenShareSetup.toggleCursorCapture()}>
          <span class="screen-share-option-label"><span class="material-symbols-rounded app-icon" aria-hidden="true">mouse</span><span>{t("screenShare.captureCursor")}</span></span>
          <span class="screen-share-switch-track" aria-hidden="true"><span class="screen-share-switch-thumb"></span></span>
        </button>
        {#if !isTauriRuntime()}
          <button class="screen-share-option-switch" type="button" role="switch" data-screen-share-adaptive
            aria-checked={screenShareSetup.bitrateOption === "auto" && (screenShareSetup.adaptiveWebQuality || screenShareSetup.contentMode === "smart")}
            disabled={screenShareActionBusy || screenShareSetup.bitrateOption !== "auto" || screenShareSetup.contentMode === "smart"}
            onclick={() => screenShareSetup.toggleAdaptiveWebQuality()}>
            <span class="screen-share-option-label"><span class="material-symbols-rounded app-icon" aria-hidden="true">tune</span><span>{t("screenShare.adaptPerViewer")}</span></span>
            <span class="screen-share-switch-track" aria-hidden="true"><span class="screen-share-switch-thumb"></span></span>
          </button>
        {/if}
        <div class="screen-share-remote-control-option">
          <button
            class="screen-share-option-switch"
            data-screen-share-remote-control
            type="button"
            role="switch"
            aria-checked={Boolean(screenShareSetup.remoteControlAvailableForSource(screenShareSetup.selectedDesktopCaptureSource) && screenShareSetup.remoteControlAllowed)}
            aria-describedby="screen-share-remote-control-tooltip"
            disabled={Boolean(remoteControl.screenShareRemoteControlUnavailableReason()) || screenShareActionBusy}
            onclick={() => {
              if (!remoteControl.screenShareRemoteControlUnavailableReason()) screenShareSetup.toggleRemoteControlAllowed();
            }}
          >
            <span class="screen-share-option-label"><span class="material-symbols-rounded app-icon" aria-hidden="true">keyboard_external_input</span><span>{t("screenShare.allowRemoteControl")}</span></span>
            <span class="screen-share-switch-track" aria-hidden="true"><span class="screen-share-switch-thumb"></span></span>
          </button>
          <span id="screen-share-remote-control-tooltip" class="screen-share-remote-control-tooltip" role="tooltip">
            {remoteControl.screenShareRemoteControlUnavailableReason() || t("remoteControl.localPriority")}
          </span>
          {#if !server?.remote_control_enabled}
            <span class="screen-share-remote-control-notice" role="status">
              <span class="material-symbols-rounded app-icon" aria-hidden="true">info</span>
              <span>{t("remoteControl.serverFeatureDisabled")}</span>
            </span>
          {/if}
        </div>
      </section>

      <section class="screen-share-quality-grid">
        <div class="screen-share-option-field">
          <span class="screen-share-option-label"><span class="material-symbols-rounded app-icon" aria-hidden="true">aspect_ratio</span><span>{t("screenShare.resolution")}</span></span>
          <div class="screen-share-select">
            <button bind:this={resolutionButton} type="button" disabled={screenShareActionBusy} aria-expanded={screenShareSetup.resolutionMenuOpen} onclick={() => screenShareSetup.toggleResolutionMenu()}>
              <span>{screenShareSetup.resolutionDisplayLabel}</span><span class="material-symbols-rounded app-icon" aria-hidden="true">expand_more</span>
            </button>
          </div>
        </div>
        <div class="screen-share-option-field">
          <span class="screen-share-option-label"><span class="material-symbols-rounded app-icon" aria-hidden="true">speed</span><span>{t("screenShare.frameRate")}</span></span>
          <div class="screen-share-select">
            <button bind:this={frameRateButton} type="button" disabled={screenShareActionBusy} aria-expanded={screenShareSetup.frameRateMenuOpen} onclick={() => screenShareSetup.toggleFrameRateMenu()}>
              <span>{t("screenShare.fpsValue", { fps: screenShareSetup.frameRate })}</span><span class="material-symbols-rounded app-icon" aria-hidden="true">expand_more</span>
            </button>
          </div>
        </div>
        <div class="screen-share-option-field">
          <span class="screen-share-option-label"><span class="material-symbols-rounded app-icon" aria-hidden="true">network_check</span><span>{t("screenShare.bitrate")}</span></span>
          <div class="screen-share-select">
            <button bind:this={bitrateButton} type="button" disabled={screenShareActionBusy} aria-expanded={screenShareSetup.bitrateMenuOpen} onclick={() => screenShareSetup.toggleBitrateMenu()}>
              <span>{screenShareSetup.bitrateLabel(screenShareSetup.bitrateOption)}</span><span class="material-symbols-rounded app-icon" aria-hidden="true">expand_more</span>
            </button>
          </div>
        </div>
        <div class="screen-share-option-field">
          <span class="screen-share-option-label"><span class="material-symbols-rounded app-icon" aria-hidden="true">tune</span><span>{t("screenShare.contentMode")}</span></span>
          <div class="screen-share-select">
            <button bind:this={contentModeButton} type="button" data-screen-share-content-mode disabled={screenShareActionBusy} aria-expanded={screenShareSetup.contentModeMenuOpen} onclick={() => screenShareSetup.toggleContentModeMenu()}>
              <span>{screenShareSetup.contentModeLabel(screenShareSetup.contentMode)}</span><span class="material-symbols-rounded app-icon" aria-hidden="true">expand_more</span>
            </button>
          </div>
        </div>
      </section>

      <div class="screen-share-effective-settings">
        <span class="material-symbols-rounded app-icon" aria-hidden="true">settings_input_component</span>
        <span>{screenShareSetup.actualSettingsLabel}</span>
      </div>
      {#if screenShareSetup.frameRateUnavailable}
        <p class="screen-share-source-required warning" role="status">{t("screenShare.frameRateUnavailable", { fps: screenShareSetup.frameRate })}</p>
      {:else if screenShareSetup.frameRate >= 90}
        <p class="screen-share-high-load-warning">{t("screenShare.highLoadWarning")}</p>
      {/if}
      {#if screenShareSetup.contentMode === "smart"}
        <p class="screen-share-high-load-warning">{t(isTauriRuntime() ? "screenShare.smartNativeHint" : "screenShare.smartWebHint")}</p>
      {/if}
    </div>

    <footer>
      <button type="button" onclick={() => screenShareSetup.closeSetup()}>{t("common.cancel")}</button>
      <button class="primary" type="button" disabled={screenShareActionBusy || !screenShareSetup.configurationSourceReady || screenShareSetup.frameRateUnavailable} onclick={() => void screenShareSetup.startFromSetup()}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">screen_share</span>
        <span>{screenShareActionBusy ? t("status.connecting") : t("screenShare.start")}</span>
      </button>
    </footer>
  </dialog>
</div>
{/if}
