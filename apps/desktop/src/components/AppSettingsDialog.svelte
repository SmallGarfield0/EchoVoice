<script lang="ts">
  import { avatarColorPalette, avatarStyleVariables, normalizeAvatarColor } from "../lib/avatar";
  import type { LanguagePack } from "../lib/i18n";
  import type { LocalUserProfile, NativeVoiceStatus, VoiceNoiseSuppressionMode } from "../lib/types";
  import NumericInput from "./NumericInput.svelte";

  type Translate = (key: string, values?: Record<string, string | number>) => string;
  type AudioDeviceOption = { deviceId: string; label: string; isDefault?: boolean };
  type SettingsSelectMenu =
    | "language"
    | "audio-input"
    | "audio-output"
    | "noise-suppression"
    | "server-language"
    | "server-preview-language"
    | "channel-default-language"
    | "channel-localization-language";

  type Props = {
    t: Translate;
    open: boolean;
    profileDraft: LocalUserProfile;
    profileSaving: boolean;
    profileSaveMessage: string;
    profileSettingsDirty: boolean;
    localUserProfile: LocalUserProfile;
    languagePack: LanguagePack;
    selectedLanguageId: string;
    settingsSelectMenuOpen: SettingsSelectMenu | null;
    nativeDesktopRuntime: boolean;
    voiceInputUnavailable: boolean;
    localVoiceStream: MediaStream | null;
    nativeVoiceStatus: NativeVoiceStatus | null;
    audioInputDevicesLoading: boolean;
    audioInputDevices: AudioDeviceOption[];
    audioOutputDevices: AudioDeviceOption[];
    selectedAudioInputDeviceId: string;
    selectedAudioOutputDeviceId: string;
    noiseSuppressionModes: VoiceNoiseSuppressionMode[];
    noiseSuppressionMode: VoiceNoiseSuppressionMode;
    microphoneGainPercent: number;
    microphoneGainLimitPercent: number;
    maximumVoiceGainLimitPercent: number;
    voiceInputLevel: number;
    microphoneTestLevel: number;
    microphoneTestActive: boolean;
    microphoneTestBusy: boolean;
    outputVolumePercent: number;
    memberVolumeLimitPercent: number;
    headphoneTestBusy: boolean;
    voiceRangeProgress: (value: number, max: number) => number;
    voiceInputStatusLabel: () => string;
    selectedAudioInputLabel: () => string;
    selectedAudioOutputLabel: () => string;
    noiseSuppressionModeLabel: (mode: VoiceNoiseSuppressionMode) => string;
    noiseSuppressionModeDescription: (mode: VoiceNoiseSuppressionMode) => string;
    languageOptions: () => LanguagePack[];
    onClose: () => void;
    onSelectProfileAvatar: (event: Event) => void;
    onClearProfileAvatar: () => void;
    onSetProfileAvatarColor: (color: string) => void;
    onExportProfile: () => void;
    onImportProfile: (event: Event) => void;
    onResetProfile: () => void;
    onSaveProfile: () => void;
    onToggleSettingsSelectMenu: (menu: SettingsSelectMenu) => void;
    onSelectLanguage: (languageId: string) => void;
    onImportLanguage: (event: Event) => void;
    onExportLanguage: () => void;
    onSelectAudioInputDevice: (deviceId: string) => void;
    onSelectAudioOutputDevice: (deviceId: string) => void;
    onSelectNoiseSuppressionMode: (mode: VoiceNoiseSuppressionMode) => void;
    onChangeMicrophoneGain: (event: Event) => void;
    onChangeMicrophoneGainLimit: (value: number) => void;
    onChangeOutputVolume: (event: Event) => void;
    onChangeMemberVolumeLimit: (value: number) => void;
    onRunMicrophoneTest: () => void;
    onRunHeadphoneTest: () => void;
    onRefreshAudioInputDevices: (requestPermission?: boolean) => void;
  };

  let {
    t,
    open,
    profileDraft = $bindable(),
    profileSaving,
    profileSaveMessage,
    profileSettingsDirty,
    localUserProfile,
    languagePack,
    selectedLanguageId,
    settingsSelectMenuOpen,
    nativeDesktopRuntime,
    voiceInputUnavailable,
    localVoiceStream,
    nativeVoiceStatus,
    audioInputDevicesLoading,
    audioInputDevices,
    audioOutputDevices,
    selectedAudioInputDeviceId,
    selectedAudioOutputDeviceId,
    noiseSuppressionModes,
    noiseSuppressionMode,
    microphoneGainPercent,
    microphoneGainLimitPercent,
    maximumVoiceGainLimitPercent,
    voiceInputLevel,
    microphoneTestLevel,
    microphoneTestActive,
    microphoneTestBusy,
    outputVolumePercent,
    memberVolumeLimitPercent,
    headphoneTestBusy,
    voiceRangeProgress,
    voiceInputStatusLabel,
    selectedAudioInputLabel,
    selectedAudioOutputLabel,
    noiseSuppressionModeLabel,
    noiseSuppressionModeDescription,
    languageOptions,
    onClose,
    onSelectProfileAvatar,
    onClearProfileAvatar,
    onSetProfileAvatarColor,
    onExportProfile,
    onImportProfile,
    onResetProfile,
    onSaveProfile,
    onToggleSettingsSelectMenu,
    onSelectLanguage,
    onImportLanguage,
    onExportLanguage,
    onSelectAudioInputDevice,
    onSelectAudioOutputDevice,
    onSelectNoiseSuppressionMode,
    onChangeMicrophoneGain,
    onChangeMicrophoneGainLimit,
    onChangeOutputVolume,
    onChangeMemberVolumeLimit,
    onRunMicrophoneTest,
    onRunHeadphoneTest,
    onRefreshAudioInputDevices
  }: Props = $props();

  let profileAvatarInput = $state<HTMLInputElement | null>(null);
  let profileImportInput = $state<HTMLInputElement | null>(null);

  function updateDraft(patch: Partial<LocalUserProfile>) {
    profileDraft = { ...profileDraft, ...patch };
  }
</script>

{#if open}
<div class="settings-page" role="dialog" aria-modal="true" aria-label={t("appSettings.title")}>
  <header class="settings-page-header">
    <div>
      <p class="eyebrow">EchoVoice</p>
      <h1>{t("appSettings.title")}</h1>
    </div>
    <button class="settings-close-button" type="button" title={t("app.close")} onclick={onClose}>
      <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
    </button>
  </header>

  <div class="settings-panel settings-page-body">
    <section class="settings-section profile-settings-section">
      <div class="settings-section-heading">
        <div>
          <p class="section-label">{t("appSettings.profile")}</p>
          <p class="status">{t("profile.autoSyncDescription")}</p>
        </div>
      </div>

      <div class="profile-settings-grid">
        <div class="profile-avatar-editor">
          <div class="profile-avatar-preview" style={avatarStyleVariables(profileDraft.avatar_color, profileDraft.local_profile_id)}>
            {#if profileDraft.avatar_data_url}
              <img src={profileDraft.avatar_data_url} alt="" />
            {:else}
              <span>{profileDraft.display_name.slice(0, 2).toUpperCase() || "EV"}</span>
            {/if}
          </div>
          <input
            bind:this={profileAvatarInput}
            class="visually-hidden"
            type="file"
            accept="image/*"
            onchange={onSelectProfileAvatar}
          />
          <div class="profile-avatar-actions">
            <button type="button" onclick={() => profileAvatarInput?.click()}>{t("profile.changeAvatar")}</button>
            <button type="button" disabled={!profileDraft.avatar_data_url} onclick={onClearProfileAvatar}>{t("profile.removeAvatar")}</button>
          </div>
          {#if !profileDraft.avatar_data_url}
            <div class="profile-avatar-color-control">
              <span>{t("profile.avatarColor")}</span>
              <div class="profile-avatar-color-swatches" role="radiogroup" aria-label={t("profile.avatarColor")}>
                {#each avatarColorPalette as color}
                  <button
                    type="button"
                    role="radio"
                    class:selected={normalizeAvatarColor(profileDraft.avatar_color, profileDraft.local_profile_id) === color}
                    aria-checked={normalizeAvatarColor(profileDraft.avatar_color, profileDraft.local_profile_id) === color}
                    aria-label={color}
                    style={`--avatar-swatch-color: ${color};`}
                    onclick={() => onSetProfileAvatarColor(color)}
                  ></button>
                {/each}
              </div>
              <small>{t("profile.avatarColorDescription")}</small>
            </div>
          {/if}
        </div>

        <div class="profile-fields">
          <label>
            <span>{t("profile.displayName")}</span>
            <input value={profileDraft.display_name} maxlength="64" autocomplete="nickname" oninput={(event) => updateDraft({ display_name: event.currentTarget.value })} />
          </label>
          <label>
            <span>{t("profile.bio")}</span>
            <textarea value={profileDraft.bio} maxlength="500" rows="4" placeholder={t("profile.bioPlaceholder")} oninput={(event) => updateDraft({ bio: event.currentTarget.value })}></textarea>
            <small>{profileDraft.bio.length} / 500</small>
          </label>
        </div>
      </div>

      <div class="profile-device-row">
        <span class="material-symbols-rounded app-icon" aria-hidden="true">devices</span>
        <div>
          <strong>{t("profile.deviceIdentity")}</strong>
          <span>{localUserProfile.local_profile_id}</span>
        </div>
      </div>

      <div class="profile-transfer-actions">
        <input
          bind:this={profileImportInput}
          class="visually-hidden"
          type="file"
          accept="application/json"
          onchange={onImportProfile}
        />
        <button type="button" onclick={onExportProfile}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">download</span>
          <span>{t("profile.export")}</span>
        </button>
        <button type="button" onclick={() => profileImportInput?.click()}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">upload</span>
          <span>{t("profile.import")}</span>
        </button>
      </div>
      {#if profileSaveMessage}
        <p class="profile-save-message">{profileSaveMessage}</p>
      {/if}
    </section>

    <section class="settings-section">
      <p class="section-label">{t("appSettings.language")}</p>
      <div class="settings-select-field">
        <span>{t("language.select")}</span>
        <div class="settings-custom-select" class:open={settingsSelectMenuOpen === "language"}>
          <button
            class="settings-select-trigger"
            type="button"
            aria-haspopup="listbox"
            aria-expanded={settingsSelectMenuOpen === "language"}
            onclick={() => onToggleSettingsSelectMenu("language")}
          >
            <span>{languagePack.name}</span>
            <span class="material-symbols-rounded app-icon" aria-hidden="true">expand_more</span>
          </button>
          {#if settingsSelectMenuOpen === "language"}
            <div class="settings-select-options" role="listbox" aria-label={t("language.select")}>
              {#each languageOptions() as language}
                <button
                  type="button"
                  role="option"
                  class:active={language.id === selectedLanguageId}
                  aria-selected={language.id === selectedLanguageId}
                  onclick={() => onSelectLanguage(language.id)}
                >
                  <span>{language.name}</span>
                  {#if language.id === selectedLanguageId}<span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>{/if}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      </div>
      <div class="language-actions">
        <input
          id="language-import"
          class="visually-hidden"
          type="file"
          accept="application/json"
          onchange={onImportLanguage}
        />
        <label class="secondary-button" for="language-import">{t("language.import")}</label>
        <button class="secondary-button" type="button" onclick={onExportLanguage}>
          {t("language.export")}
        </button>
      </div>
    </section>

    <section class="settings-section">
      <p class="section-label">{t("appSettings.voice")}</p>
      <div class="voice-settings-grid">
        <div class="voice-settings-card">
          <div class="voice-settings-status">
            <span class="material-symbols-rounded app-icon" aria-hidden="true">
              {voiceInputUnavailable ? "mic_off" : (localVoiceStream || nativeVoiceStatus?.phase === "running") ? "mic" : "settings_voice"}
            </span>
            <div>
              <strong>{t("voice.microphoneInput")}</strong>
              <span>{voiceInputStatusLabel()}</span>
            </div>
          </div>

          <div class="settings-select-field">
            <span>{t("voice.inputDevice")}</span>
            <div class="settings-custom-select" class:open={settingsSelectMenuOpen === "audio-input"}>
              <button
                class="settings-select-trigger"
                type="button"
                disabled={audioInputDevicesLoading}
                aria-haspopup="listbox"
                aria-expanded={settingsSelectMenuOpen === "audio-input"}
                onclick={() => onToggleSettingsSelectMenu("audio-input")}
              >
                <span>{selectedAudioInputLabel()}</span>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">expand_more</span>
              </button>
              {#if settingsSelectMenuOpen === "audio-input"}
                <div class="settings-select-options" role="listbox" aria-label={t("voice.inputDevice")}>
                  <button type="button" role="option" class:active={!selectedAudioInputDeviceId} aria-selected={!selectedAudioInputDeviceId} onclick={() => void onSelectAudioInputDevice("")}>
                    <span>{nativeDesktopRuntime ? t("voice.systemDefaultMicrophone") : t("voice.defaultMicrophone")}</span>
                    {#if !selectedAudioInputDeviceId}<span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>{/if}
                  </button>
                  {#each audioInputDevices as device}
                    <button type="button" role="option" class:active={device.deviceId === selectedAudioInputDeviceId} aria-selected={device.deviceId === selectedAudioInputDeviceId} onclick={() => void onSelectAudioInputDevice(device.deviceId)}>
                      <span>{device.label}</span>
                      {#if device.deviceId === selectedAudioInputDeviceId}<span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>{/if}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>

          <div class="settings-select-field">
            <span>{t("voice.noiseSuppression")}</span>
            <div class="settings-custom-select" class:open={settingsSelectMenuOpen === "noise-suppression"}>
              <button
                class="settings-select-trigger"
                type="button"
                aria-haspopup="listbox"
                aria-expanded={settingsSelectMenuOpen === "noise-suppression"}
                onclick={() => onToggleSettingsSelectMenu("noise-suppression")}
              >
                <span>{noiseSuppressionModeLabel(noiseSuppressionMode)}</span>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">expand_more</span>
              </button>
              {#if settingsSelectMenuOpen === "noise-suppression"}
                <div class="settings-select-options noise-suppression-options" role="listbox" aria-label={t("voice.noiseSuppression")}>
                  {#each noiseSuppressionModes as mode}
                    <button
                      type="button"
                      role="option"
                      class:active={noiseSuppressionMode === mode}
                      aria-selected={noiseSuppressionMode === mode}
                      data-tooltip={noiseSuppressionModeDescription(mode)}
                      onclick={() => void onSelectNoiseSuppressionMode(mode)}
                    >
                      <span>{noiseSuppressionModeLabel(mode)}</span>
                      {#if noiseSuppressionMode === mode}<span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>{/if}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
            <small>{noiseSuppressionModeDescription(noiseSuppressionMode)}</small>
          </div>

          <label class="voice-volume-slider">
            <span>
              <span class="material-symbols-rounded app-icon" aria-hidden="true">mic</span>
              <span>{t("voice.microphoneVolume")}</span>
              <strong>{microphoneGainPercent}%</strong>
            </span>
            <input
              type="range"
              min="0"
              max={microphoneGainLimitPercent}
              step="5"
              value={microphoneGainPercent}
              style={`--voice-range-progress: ${voiceRangeProgress(microphoneGainPercent, microphoneGainLimitPercent)};`}
              aria-label={t("voice.microphoneVolume")}
              oninput={onChangeMicrophoneGain}
            />
            <small>{t("voice.microphoneVolumeDescription")}</small>
          </label>

          <label class="voice-gain-limit-setting">
            <span>
              <span class="material-symbols-rounded app-icon" aria-hidden="true">tune</span>
              <span>{t("voice.microphoneGainLimit")}</span>
            </span>
            <NumericInput
              value={microphoneGainLimitPercent}
              min={100}
              max={maximumVoiceGainLimitPercent}
              step={50}
              unit="%"
              ariaLabel={t("voice.microphoneGainLimit")}
              decreaseLabel={t("app.decreaseValue", { name: t("voice.microphoneGainLimit") })}
              increaseLabel={t("app.increaseValue", { name: t("voice.microphoneGainLimit") })}
              onValueChange={onChangeMicrophoneGainLimit}
            />
            <small>{t("voice.microphoneGainLimitDescription", { maximum: maximumVoiceGainLimitPercent })}</small>
          </label>

          <div class="voice-meter-row">
            <span>{t("voice.inputLevel")}</span>
            <div class="voice-meter" aria-label={t("voice.inputLevel")}>
              <span style={`width: ${Math.round(Math.max(voiceInputLevel, microphoneTestLevel) * 100)}%;`}></span>
            </div>
          </div>
          <button class="audio-device-test-button" class:active={microphoneTestActive} type="button" disabled={microphoneTestBusy} aria-pressed={microphoneTestActive} onclick={() => void onRunMicrophoneTest()}>
            <span class="material-symbols-rounded app-icon" class:spinning={microphoneTestBusy} aria-hidden="true">{microphoneTestBusy ? "progress_activity" : microphoneTestActive ? "stop_circle" : "graphic_eq"}</span>
            <span>{microphoneTestBusy ? t("voice.microphoneTesting") : microphoneTestActive ? t("voice.stopMicrophoneTest") : t("voice.testMicrophone")}</span>
          </button>
        </div>

        <div class="voice-settings-card">
          <div class="voice-settings-status">
            <span class="material-symbols-rounded app-icon" aria-hidden="true">speaker</span>
            <div>
              <strong>{t("voice.audioOutput")}</strong>
              <span>{selectedAudioOutputLabel()}</span>
            </div>
          </div>

          <div class="settings-select-field">
            <span>{t("voice.outputDevice")}</span>
            <div class="settings-custom-select" class:open={settingsSelectMenuOpen === "audio-output"}>
              <button
                class="settings-select-trigger"
                type="button"
                disabled={audioInputDevicesLoading}
                aria-haspopup="listbox"
                aria-expanded={settingsSelectMenuOpen === "audio-output"}
                onclick={() => onToggleSettingsSelectMenu("audio-output")}
              >
                <span>{selectedAudioOutputLabel()}</span>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">expand_more</span>
              </button>
              {#if settingsSelectMenuOpen === "audio-output"}
                <div class="settings-select-options" role="listbox" aria-label={t("voice.outputDevice")}>
                  <button type="button" role="option" class:active={!selectedAudioOutputDeviceId} aria-selected={!selectedAudioOutputDeviceId} onclick={() => void onSelectAudioOutputDevice("")}>
                    <span>{t("voice.systemDefaultOutput")}</span>
                    {#if !selectedAudioOutputDeviceId}<span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>{/if}
                  </button>
                  {#each audioOutputDevices as device}
                    <button type="button" role="option" class:active={device.deviceId === selectedAudioOutputDeviceId} aria-selected={device.deviceId === selectedAudioOutputDeviceId} onclick={() => void onSelectAudioOutputDevice(device.deviceId)}>
                      <span>{device.label}</span>
                      {#if device.deviceId === selectedAudioOutputDeviceId}<span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>{/if}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>

          <label class="voice-volume-slider">
            <span>
              <span class="material-symbols-rounded app-icon" aria-hidden="true">headphones</span>
              <span>{t("voice.outputVolume")}</span>
              <strong>{outputVolumePercent}%</strong>
            </span>
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              value={outputVolumePercent}
              style={`--voice-range-progress: ${outputVolumePercent}%;`}
              aria-label={t("voice.outputVolume")}
              oninput={onChangeOutputVolume}
            />
            <small>{t("voice.outputVolumeDescription")}</small>
          </label>

          <label class="voice-gain-limit-setting">
            <span>
              <span class="material-symbols-rounded app-icon" aria-hidden="true">group</span>
              <span>{t("voice.memberVolumeLimit")}</span>
            </span>
            <NumericInput
              value={memberVolumeLimitPercent}
              min={100}
              max={maximumVoiceGainLimitPercent}
              step={50}
              unit="%"
              ariaLabel={t("voice.memberVolumeLimit")}
              decreaseLabel={t("app.decreaseValue", { name: t("voice.memberVolumeLimit") })}
              increaseLabel={t("app.increaseValue", { name: t("voice.memberVolumeLimit") })}
              onValueChange={onChangeMemberVolumeLimit}
            />
            <small>{t("voice.memberVolumeLimitDescription", { maximum: maximumVoiceGainLimitPercent })}</small>
          </label>
          <button class="audio-device-test-button" type="button" disabled={headphoneTestBusy} onclick={() => void onRunHeadphoneTest()}>
            <span class="material-symbols-rounded app-icon" aria-hidden="true">spatial_audio</span>
            <span>{headphoneTestBusy ? t("voice.headphoneTesting") : t("voice.testHeadphones")}</span>
          </button>
        </div>
      </div>

      <div class="voice-settings-actions" class:single={nativeDesktopRuntime}>
        <button type="button" disabled={audioInputDevicesLoading} onclick={() => onRefreshAudioInputDevices()}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">refresh</span>
          <span>{t("voice.refreshDevices")}</span>
        </button>
        {#if !nativeDesktopRuntime}
          <button type="button" disabled={audioInputDevicesLoading} onclick={() => onRefreshAudioInputDevices(true)}>
            <span class="material-symbols-rounded app-icon" aria-hidden="true">privacy_tip</span>
            <span>{t("voice.requestMicrophone")}</span>
          </button>
        {/if}
      </div>
    </section>
  </div>

  {#if profileSettingsDirty}
    <div class="settings-unsaved-bar profile-unsaved-bar">
      <span>{t("settings.unsaved")}</span>
      <div class="settings-unsaved-actions">
        <button type="button" disabled={profileSaving} onclick={onResetProfile}>{t("settings.reset")}</button>
        <button type="button" disabled={profileSaving || !profileDraft.display_name.trim()} onclick={() => void onSaveProfile()}>
          {profileSaving ? t("profile.saving") : t("settings.save")}
        </button>
      </div>
    </div>
  {/if}
</div>
{/if}
