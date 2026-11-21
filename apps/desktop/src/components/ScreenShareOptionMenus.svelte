<script lang="ts">
  import type { ScreenShareSetupController } from "../lib/screen-share-setup.svelte";
  import {
    screenShareBitrateOptions,
    screenShareContentModes,
    screenShareResolutionOptions
  } from "../lib/screenShareSettings";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type Props = {
    t: Translate;
    screenShareSetup: ScreenShareSetupController;
  };

  let { t, screenShareSetup }: Props = $props();
</script>

{#if screenShareSetup.resolutionMenuOpen}
  <div
    class="screen-share-select-menu screen-share-floating-select-menu"
    role="listbox"
    style={screenShareSetup.resolutionMenuStyle}
  >
    {#each screenShareResolutionOptions as option}
      <button
        type="button"
        class:active={screenShareSetup.resolutionPreset === option}
        role="option"
        aria-selected={screenShareSetup.resolutionPreset === option}
        onmousedown={(event) => screenShareSetup.selectResolution(option, event)}
        onclick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <span class="material-symbols-rounded app-icon" aria-hidden="true">
          {screenShareSetup.resolutionPreset === option ? "check" : ""}
        </span>
        <span>{screenShareSetup.resolutionPresetLabel(option)}</span>
      </button>
    {/each}
  </div>
{/if}

{#if screenShareSetup.frameRateMenuOpen}
  <div class="screen-share-select-menu screen-share-floating-select-menu" role="listbox" style={screenShareSetup.frameRateMenuStyle}>
    {#each screenShareSetup.frameRateOptions as frameRate}
      <button
        type="button"
        class:active={screenShareSetup.frameRate === frameRate}
        role="option"
        aria-selected={screenShareSetup.frameRate === frameRate}
        onpointerdown={(event) => screenShareSetup.selectFrameRate(frameRate, event)}
        onclick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <span class="material-symbols-rounded app-icon" aria-hidden="true">{screenShareSetup.frameRate === frameRate ? "check" : ""}</span><span>{t("screenShare.fpsValue", { fps: frameRate })}</span>
      </button>
    {/each}
  </div>
{/if}

{#if screenShareSetup.bitrateMenuOpen}
  <div class="screen-share-select-menu screen-share-floating-select-menu" role="listbox" style={screenShareSetup.bitrateMenuStyle}>
    {#each screenShareBitrateOptions as option}
      <button
        type="button"
        class:active={screenShareSetup.bitrateOption === option}
        role="option"
        aria-selected={screenShareSetup.bitrateOption === option}
        onpointerdown={(event) => screenShareSetup.selectBitrate(option, event)}
        onclick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <span class="material-symbols-rounded app-icon" aria-hidden="true">{screenShareSetup.bitrateOption === option ? "check" : ""}</span><span>{screenShareSetup.bitrateLabel(option)}</span>
      </button>
    {/each}
  </div>
{/if}

{#if screenShareSetup.contentModeMenuOpen}
  <div class="screen-share-select-menu screen-share-floating-select-menu" role="listbox" style={screenShareSetup.contentModeMenuStyle}>
    {#each screenShareContentModes as mode}
      <button
        type="button"
        class:active={screenShareSetup.contentMode === mode}
        data-screen-share-content-option={mode}
        role="option"
        aria-selected={screenShareSetup.contentMode === mode}
        onpointerdown={(event) => screenShareSetup.selectContentMode(mode, event)}
        onclick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <span class="material-symbols-rounded app-icon" aria-hidden="true">{screenShareSetup.contentMode === mode ? "check" : ""}</span><span>{screenShareSetup.contentModeLabel(mode)}</span>
      </button>
    {/each}
  </div>
{/if}
