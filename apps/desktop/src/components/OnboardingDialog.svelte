<script lang="ts">
  import { avatarColorPalette, avatarStyleVariables, normalizeAvatarColor } from "../lib/avatar";
  import type { LanguagePack } from "../lib/i18n";
  import type { LocalUserProfile } from "../lib/types";

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
    appIconURL: string;
    appContentIconURL: string;
    onboardingStep: number;
    profileDraft: LocalUserProfile;
    profileSaving: boolean;
    error: string;
    settingsSelectMenuOpen: SettingsSelectMenu | null;
    onToggleSettingsSelectMenu: (menu: SettingsSelectMenu) => void;
    languagePack: LanguagePack;
    selectedLanguageId: string;
    languageOptions: () => LanguagePack[];
    onSelectLanguage: (languageId: string) => void;
    onSelectProfileAvatar: (event: Event) => void;
    onClearProfileAvatar: () => void;
    onSetProfileAvatarColor: (color: string) => void;
    nativeDesktopRuntime: boolean;
    audioInputDevicesLoading: boolean;
    audioInputDevices: AudioDeviceOption[];
    audioOutputDevices: AudioDeviceOption[];
    selectedAudioInputDeviceId: string;
    selectedAudioOutputDeviceId: string;
    selectedAudioInputLabel: () => string;
    selectedAudioOutputLabel: () => string;
    onSelectAudioInputDevice: (deviceId: string) => void;
    onSelectAudioOutputDevice: (deviceId: string) => void;
    onRefreshAudioInputDevices: (requestPermission?: boolean) => void;
    onCompleteInitialOnboarding: () => void;
    onReturnInitialOnboarding: () => void;
    onAdvanceInitialOnboarding: () => void;
  };

  let {
    t,
    open,
    appIconURL,
    appContentIconURL,
    onboardingStep,
    profileDraft = $bindable(),
    profileSaving,
    error,
    settingsSelectMenuOpen,
    onToggleSettingsSelectMenu,
    languagePack,
    selectedLanguageId,
    languageOptions,
    onSelectLanguage,
    onSelectProfileAvatar,
    onClearProfileAvatar,
    onSetProfileAvatarColor,
    nativeDesktopRuntime,
    audioInputDevicesLoading,
    audioInputDevices,
    audioOutputDevices,
    selectedAudioInputDeviceId,
    selectedAudioOutputDeviceId,
    selectedAudioInputLabel,
    selectedAudioOutputLabel,
    onSelectAudioInputDevice,
    onSelectAudioOutputDevice,
    onRefreshAudioInputDevices,
    onCompleteInitialOnboarding,
    onReturnInitialOnboarding,
    onAdvanceInitialOnboarding
  }: Props = $props();

  function updateDraft(patch: Partial<LocalUserProfile>) {
    profileDraft = { ...profileDraft, ...patch };
  }
</script>

{#if open}
<div class="dialog-backdrop onboarding-backdrop" role="presentation">
  <dialog class="onboarding-dialog" open aria-labelledby="onboarding-title" aria-describedby="onboarding-description">
    <header>
      <span class="onboarding-mark"><img src={appIconURL} alt="" /></span>
      <div>
        <p class="eyebrow">EchoVoice</p>
        <h2 id="onboarding-title">
          {onboardingStep === 0 ? t("onboarding.welcomeTitle") : onboardingStep === 1 ? t("onboarding.profileTitle") : t("onboarding.audioTitle")}
        </h2>
      </div>
      <span class="onboarding-progress" aria-label={t("onboarding.step", { current: onboardingStep + 1, total: 3 })}>
        {onboardingStep + 1} / 3
      </span>
    </header>

    <div class="onboarding-body">
      {#if onboardingStep === 0}
        <section class="onboarding-intro">
          <img src={appContentIconURL} alt="" />
          <div class="onboarding-language-picker">
            <span class="field-label">{t("onboarding.chooseLanguage")}</span>
            <div class="settings-custom-select" class:open={settingsSelectMenuOpen === "language"}>
              <button class="settings-select-trigger" type="button" aria-haspopup="listbox" aria-expanded={settingsSelectMenuOpen === "language"} onclick={() => onToggleSettingsSelectMenu("language")}>
                <span>{languagePack.name}</span>
                <span class="material-symbols-rounded app-icon" aria-hidden="true">expand_more</span>
              </button>
              {#if settingsSelectMenuOpen === "language"}
                <div class="settings-select-options" role="listbox" aria-label={t("onboarding.chooseLanguage")}>
                  {#each languageOptions() as language}
                    <button type="button" role="option" class:active={language.id === selectedLanguageId} aria-selected={language.id === selectedLanguageId} onclick={() => onSelectLanguage(language.id)}>
                      <span>{language.name}</span>
                      {#if language.id === selectedLanguageId}<span class="material-symbols-rounded app-icon" aria-hidden="true">check</span>{/if}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
          <p id="onboarding-description">{t("onboarding.welcomeDescription")}</p>
          <div class="onboarding-feature-list">
            <div><span class="material-symbols-rounded app-icon" aria-hidden="true">person</span><span>{t("onboarding.profileFeature")}</span></div>
            <div><span class="material-symbols-rounded app-icon" aria-hidden="true">graphic_eq</span><span>{t("onboarding.audioFeature")}</span></div>
            <div><span class="material-symbols-rounded app-icon" aria-hidden="true">settings</span><span>{t("onboarding.settingsFeature")}</span></div>
          </div>
        </section>
      {:else if onboardingStep === 1}
        <section class="onboarding-profile" id="onboarding-description">
          <p>{t("onboarding.profileDescription")}</p>
          <div class="profile-settings-grid">
            <div class="profile-avatar-editor">
              <div class="profile-avatar-preview" style={avatarStyleVariables(profileDraft.avatar_color, profileDraft.local_profile_id)}>
                {#if profileDraft.avatar_data_url}
                  <img src={profileDraft.avatar_data_url} alt="" />
                {:else}
                  <span>{profileDraft.display_name.slice(0, 2).toUpperCase() || "EV"}</span>
                {/if}
              </div>
              <input class="visually-hidden" type="file" accept="image/*" onchange={onSelectProfileAvatar} />
              <div class="profile-avatar-actions">
                <button type="button" onclick={(event) => (event.currentTarget.closest(".profile-avatar-editor")?.querySelector("input") as HTMLInputElement | null)?.click()}>{t("profile.changeAvatar")}</button>
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
          {#if error}<p class="error">{error}</p>{/if}
        </section>
      {:else}
        <section class="onboarding-audio" id="onboarding-description">
          <p>{t("onboarding.audioDescription")}</p>
          <div class="onboarding-audio-grid">
            <div class="onboarding-device-card">
              <span class="material-symbols-rounded app-icon" aria-hidden="true">mic</span>
              <div class="settings-select-field">
                <span>{t("voice.microphoneInput")}</span>
                <div class="settings-custom-select" class:open={settingsSelectMenuOpen === "audio-input"}>
                  <button class="settings-select-trigger" type="button" disabled={audioInputDevicesLoading} aria-haspopup="listbox" aria-expanded={settingsSelectMenuOpen === "audio-input"} onclick={() => onToggleSettingsSelectMenu("audio-input")}>
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
            </div>

            <div class="onboarding-device-card">
              <span class="material-symbols-rounded app-icon" aria-hidden="true">headphones</span>
              <div class="settings-select-field">
                <span>{t("voice.audioOutput")}</span>
                <div class="settings-custom-select" class:open={settingsSelectMenuOpen === "audio-output"}>
                  <button class="settings-select-trigger" type="button" disabled={audioInputDevicesLoading} aria-haspopup="listbox" aria-expanded={settingsSelectMenuOpen === "audio-output"} onclick={() => onToggleSettingsSelectMenu("audio-output")}>
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
            </div>
          </div>
          <button class="onboarding-refresh-devices" type="button" disabled={audioInputDevicesLoading} onclick={() => void onRefreshAudioInputDevices()}>
            <span class="material-symbols-rounded app-icon" aria-hidden="true">refresh</span>
            <span>{audioInputDevicesLoading ? t("onboarding.loadingDevices") : t("voice.refreshDevices")}</span>
          </button>
          {#if !nativeDesktopRuntime}
            <p class="onboarding-web-audio-note"><span class="material-symbols-rounded app-icon" aria-hidden="true">privacy_tip</span>{t("onboarding.webPermissionNote")}</p>
          {/if}
        </section>
      {/if}
    </div>

    <footer>
      <button class="onboarding-skip" type="button" onclick={onCompleteInitialOnboarding}>{t("onboarding.later")}</button>
      <div>
        {#if onboardingStep > 0}<button type="button" onclick={onReturnInitialOnboarding}>{t("common.back")}</button>{/if}
        <button class="primary" type="button" disabled={onboardingStep === 1 && (!profileDraft.display_name.trim() || profileSaving)} onclick={() => void onAdvanceInitialOnboarding()}>
          <span>{onboardingStep === 2 ? t("onboarding.finish") : onboardingStep === 1 && profileSaving ? t("profile.saving") : t("onboarding.continue")}</span>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">{onboardingStep === 2 ? "check" : "arrow_forward"}</span>
        </button>
      </div>
    </footer>
  </dialog>
</div>
{/if}
