<script lang="ts">
  import SoundboardRangeEditor from "./SoundboardRangeEditor.svelte";
  import { parseSoundboardPosition, soundboardVolumeMaximumPercent, soundboardVolumeMinimumPercent } from "../lib/soundboard";
  import type { SoundboardController } from "../lib/soundboard.svelte";
  import type { EmojiController } from "../lib/emoji.svelte";

  type Translate = (key: string, values?: Record<string, string | number>) => string;

  type Props = {
    t: Translate;
    soundboard: SoundboardController;
    emoji: EmojiController;
    editorName: string;
    onEditorNameChange: (name: string) => void;
    onEditorDurationChange: (durationMS: number) => void;
    emojiObjectURL: (sha256: string) => string;
    voiceRangeProgress: (value: number, max: number) => number;
    onClose: () => void;
    onRangeChange: (startMS: number, endMS: number) => void;
    onBaseVolume: (event: Event) => void;
    onClearIcon: () => void;
    onOpenIconPicker: (event: MouseEvent) => void;
    onSave: () => void;
    onTogglePreview: () => void;
  };

  let {
    t,
    soundboard,
    emoji,
    editorName,
    onEditorNameChange,
    onEditorDurationChange,
    emojiObjectURL,
    voiceRangeProgress,
    onClose,
    onRangeChange,
    onBaseVolume,
    onClearIcon,
    onOpenIconPicker,
    onSave,
    onTogglePreview
  }: Props = $props();
</script>

{#if soundboard.editorTarget}
<div class="screen-share-config-overlay soundboard-editor-overlay" role="presentation" onmousedown={(event) => {
  if (event.target === event.currentTarget) onClose();
}}>
  <dialog class="soundboard-editor-dialog" open aria-modal="true" aria-label={t("soundboard.editTitle")}>
    <header>
      <div><p class="section-label">{t("soundboard.title")}</p><h2>{t("soundboard.editTitle")}</h2></div>
      <button type="button" aria-label={t("app.close")} onclick={onClose}><span class="material-symbols-rounded app-icon" aria-hidden="true">close</span></button>
    </header>
    <div class="soundboard-editor-body">
      <label class="soundboard-editor-field">
        <span>{t("soundboard.name")}</span>
        <input value={editorName} oninput={(event) => onEditorNameChange((event.currentTarget as HTMLInputElement).value)} maxlength="48" autocomplete="off" />
      </label>
      <SoundboardRangeEditor
        source={soundboard.editorAudioURL}
        startMS={parseSoundboardPosition(soundboard.editorStart) ?? 0}
        endMS={parseSoundboardPosition(soundboard.editorEnd) ?? 0}
        title={t("soundboard.waveformTitle")}
        description={t("soundboard.waveformDescription")}
        startLabel={t("soundboard.startPosition")}
        endLabel={t("soundboard.endPosition")}
        loadingLabel={soundboard.editorAudioLoading ? t("soundboard.waveformLoading") : t("soundboard.waveformPreparing")}
        unavailableLabel={t("soundboard.waveformUnavailable")}
        onRangeChange={(startMS, endMS) => onRangeChange(startMS, endMS)}
        onDurationChange={(durationMS) => onEditorDurationChange(durationMS)}
      />
      <section class="soundboard-editor-volume">
        <label class="voice-volume-slider soundboard-editor-volume-slider">
          <span>
            <span class="material-symbols-rounded app-icon" aria-hidden="true">graphic_eq</span>
            <span>{t("soundboard.baseVolume")}</span>
            <strong>{soundboard.editorBaseVolumePercent}%</strong>
          </span>
          <input
            type="range"
            min={soundboardVolumeMinimumPercent}
            max={soundboardVolumeMaximumPercent}
            step="5"
            value={soundboard.editorBaseVolumePercent}
            style={`--voice-range-progress: ${voiceRangeProgress(soundboard.editorBaseVolumePercent, soundboardVolumeMaximumPercent)};`}
            aria-label={t("soundboard.baseVolume")}
            oninput={(event) => onBaseVolume(event)}
          />
          <small>{t("soundboard.baseVolumeDescription")}</small>
        </label>
        <button
          type="button"
          class:active={soundboard.editorPreviewing}
          disabled={!soundboard.editorAudioURL || soundboard.editorAudioLoading}
          data-soundboard-editor-preview
          aria-label={t(soundboard.editorPreviewing ? "soundboard.stopPreview" : "soundboard.preview")}
          onclick={onTogglePreview}
        >
          <span class="material-symbols-rounded app-icon" aria-hidden="true">{soundboard.editorPreviewing ? "stop" : "play_arrow"}</span>
          <span>{t(soundboard.editorPreviewing ? "soundboard.stopPreview" : "soundboard.preview")}</span>
        </button>
      </section>
      <section class="soundboard-icon-editor">
        <header>
          <div><strong>{t("soundboard.icon")}</strong><small>{t("soundboard.iconDescription")}</small></div>
          <button type="button" class="soundboard-icon-clear" disabled={!soundboard.editorIconEmoji && !soundboard.editorIconAssetSHA256} onclick={onClearIcon}>
            <span class="material-symbols-rounded app-icon" aria-hidden="true">ink_eraser</span>
            <span>{t("soundboard.clearIcon")}</span>
          </button>
        </header>
        <button
          type="button"
          class="soundboard-icon-picker-trigger"
          aria-haspopup="dialog"
          aria-expanded={emoji.pickerOpen && emoji.pickerPurpose === "soundboard"}
          onclick={(event) => void onOpenIconPicker(event)}
        >
          <span class="soundboard-icon-picker-preview" aria-hidden="true">
            {#if soundboard.editorIconAssetSHA256 && emojiObjectURL(soundboard.editorIconAssetSHA256)}
              <img src={emojiObjectURL(soundboard.editorIconAssetSHA256)} alt="" />
            {:else if soundboard.editorIconEmoji}
              <span>{soundboard.editorIconEmoji}</span>
            {:else}
              <span class="material-symbols-rounded app-icon">add_reaction</span>
            {/if}
          </span>
          <span><strong>{t("soundboard.chooseIcon")}</strong><small>{t("soundboard.chooseIconDescription")}</small></span>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">chevron_right</span>
        </button>
      </section>
      {#if soundboard.editorError}<p class="soundboard-editor-error" role="alert">{soundboard.editorError}</p>{/if}
    </div>
    <footer>
      <button class="soundboard-editor-cancel" type="button" disabled={soundboard.actionBusyId === "editor-save"} onclick={onClose}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span><span>{t("common.cancel")}</span>
      </button>
      <button class="primary soundboard-editor-save" type="button" disabled={soundboard.actionBusyId === "editor-save" || !soundboard.editorAudioURL} onclick={onSave}>
        <span class="material-symbols-rounded app-icon" aria-hidden="true">save</span><span>{t("common.save")}</span>
      </button>
    </footer>
  </dialog>
</div>
{/if}
