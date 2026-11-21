<!--
  EchoVoice workspace shell — the single-component application root.
  Layout of this file:
    1. <script>  Component logic: runtime flags, workspace/feature state,
        domain controller composition (lib/*.svelte.ts), actions, lifecycle.
    2. Markup    The app shell (server rail, channel sidebar, chat, member
        panel) plus every root-level overlay/menu/dialog.
    3. Styling   Intentionally NOT here; all styles live in src/styles/app.css.
  Maintenance rules (do not regress):
    - Extract logic into lib/*.svelte.ts controllers using the existing hooks
      pattern. This component keeps only shell state, template-bound DOM refs,
      controller wiring, and cross-domain side effects.
    - Hot paths (event handlers, WebRTC signaling) read controllers directly.
      The $: aliases keyed on realtimeSyncTick exist only for templates and lag
      up to one 100ms tick behind.
    - Never import App.svelte from a controller; inject side effects via hooks.
    - Keep user-facing strings in the i18n system; keep EchoVoice controls.
    - Split roadmap: docs/development/App.svelte-拆分计划.md
-->

<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import EmojiImageEditor from "./components/EmojiImageEditor.svelte";
  import ImageCropDialog from "./components/ImageCropDialog.svelte";
  import FileMediaPreview from "./components/FileMediaPreview.svelte";
  import AccompanimentDialog from "./components/AccompanimentDialog.svelte";
  import SoundboardPopover from "./components/SoundboardPopover.svelte";
  import SoundboardEditorDialog from "./components/SoundboardEditorDialog.svelte";
  import EmojiPickerPopover from "./components/EmojiPickerPopover.svelte";
  import EmojiDetailDialog from "./components/EmojiDetailDialog.svelte";
  import ScreenShareSetupDialog from "./components/ScreenShareSetupDialog.svelte";
  import ScreenShareOptionMenus from "./components/ScreenShareOptionMenus.svelte";
  import ScreenShareSourceDialog from "./components/ScreenShareSourceDialog.svelte";
  import PoppedOutScreenSharePanel from "./components/PoppedOutScreenSharePanel.svelte";
  import FilePreviewDialog from "./components/FilePreviewDialog.svelte";
  import FileDragPreview from "./components/FileDragPreview.svelte";
  import VoiceParticipantDragPreview from "./components/VoiceParticipantDragPreview.svelte";
  import VoiceParticipantContextMenu from "./components/VoiceParticipantContextMenu.svelte";
  import ServerRailPanel from "./components/ServerRailPanel.svelte";
  import ServerContextMenu from "./components/ServerContextMenu.svelte";
  import ServerFolderContextMenu from "./components/ServerFolderContextMenu.svelte";
  import HomeEmptyState from "./components/HomeEmptyState.svelte";
  import ChannelSidebar from "./components/ChannelSidebar.svelte";
  import ContentPanel from "./components/ContentPanel.svelte";
  import MemberPanel from "./components/MemberPanel.svelte";
  import UserStatusPanel from "./components/UserStatusPanel.svelte";
  import WorkspaceReconnectPanel from "./components/WorkspaceReconnectPanel.svelte";
  import DesktopTitleBar from "./components/DesktopTitleBar.svelte";
  import RemoteControlHostBanner from "./components/RemoteControlHostBanner.svelte";
  import ScreenSharePopoutResizeHandles from "./components/ScreenSharePopoutResizeHandles.svelte";
  import RolePreviewBanner from "./components/RolePreviewBanner.svelte";
  import ScreenSharePopoutControls from "./components/ScreenSharePopoutControls.svelte";
  import ServerProfileDialog from "./components/ServerProfileDialog.svelte";
  import ServerDetailsDialog from "./components/ServerDetailsDialog.svelte";
  import ServerSettingsDialog from "./components/ServerSettingsDialog.svelte";
  import ChannelSettingsDialog from "./components/ChannelSettingsDialog.svelte";
  import ChannelPermissionTargetPicker from "./components/ChannelPermissionTargetPicker.svelte";
  import AppSettingsDialog from "./components/AppSettingsDialog.svelte";
  import OnboardingDialog from "./components/OnboardingDialog.svelte";
  import EmojiAddDialog from "./components/EmojiAddDialog.svelte";
  import InviteDialog from "./components/InviteDialog.svelte";
  import GeneratedInviteDialog from "./components/GeneratedInviteDialog.svelte";
  import ConnectDialog from "./components/ConnectDialog.svelte";
  import PendingChannelWarningDialog from "./components/PendingChannelWarningDialog.svelte";
  import ChannelDialog from "./components/ChannelDialog.svelte";
  import {
    fetchChannelFileBlob,
    fetchMessageImageBlob,
    getChannelFileEntry,
  } from "./lib/api";
  import {
    messageAttachmentEntry,
    messageAttachmentIsInlineMedia,
    type MessageAttachmentReference,
    type MessageImageReference
  } from "./lib/message-attachments";
  import { type LocalSoundboardItem } from "./lib/soundboard";
  import { avatarStyleVariables } from "./lib/avatar";
  import { browserRTCConfiguration as buildBrowserRTCConfiguration } from "./lib/browserRTCConfiguration";
  import { serverURLValidationOptions, validateServerURL, type ServerURLValidationCode } from "./lib/server-url";
  import { type LocalEmojiItem } from "./lib/emoji";
  import { EmojiController, type EmojiPickerEntry } from "./lib/emoji.svelte";
  import {
    buildLanguageTemplate,
    builtInLanguages,
    defaultLanguage,
    parseLanguagePack,
    translate
  } from "./lib/i18n";
  import {
    buildChannelTree,
    categoryChannels as getCategoryChannels,
    type ChannelTree
  } from "./lib/channelList";
  import {
    loadCredential,
    hasLocalUserProfile,
    loadLocalUserProfile,
    loadServers,
    addNativeScreenShareSenderViewer,
    removeNativeScreenShareSenderViewer,
    isTauriRuntime,
    saveActiveServerId,
    saveCredential,
    saveServer,
  } from "./lib/storage";
  import type {
    AccompanimentSession,
    AuditLog,
    Channel,
    ChannelFileEntry,
    ChannelPermissionOverride,
    CustomEmoji,
    Member,
    MemberMergeRequest,
    LocalUserProfile,
    Message,
    Permission,
    RemoteControlSession,
    RTCSignal,
    RTCIceServer,
    ScreenShareSession,
    SoundboardItem,
    ServerRole,
    ServerSummary,
    StoredCredential,
    StoredServer,
    VoiceNoiseSuppressionMode,
    VoiceState
  } from "./lib/types";
  import type { LanguagePack } from "./lib/i18n";
  import { hasEffectivePermission } from "./lib/permissions";
  import { TabVisibilityMonitor } from "./lib/tab-visibility";
  import { RemoteVoiceMixer } from "./lib/remote-audio";
  import { VoiceStateController } from "./lib/voice-state.svelte";
  import { VoiceSessionController } from "./lib/voice-session.svelte";
  import { VoiceStageController } from "./lib/voice-stage.svelte";
  import { ChannelsController } from "./lib/channels.svelte";
  import { ChannelFilesController } from "./lib/channel-files.svelte";
  import { MessagesController } from "./lib/messages.svelte";
  import { PermissionsController } from "./lib/permissions.svelte";
  import { ServerSettingsController } from "./lib/server-settings.svelte";
  import { ScreenShareController } from "./lib/screen-share.svelte";
  import { RemoteControlController } from "./lib/remote-control.svelte";
  import { RealtimeController } from "./lib/realtime.svelte";
  import { ServerRailController } from "./lib/server-rail.svelte";
  import {
    SoundboardController,
    type SoundboardEditorTarget
  } from "./lib/soundboard.svelte";
  import { AccompanimentController } from "./lib/accompaniment.svelte";
  import { ScreenShareSetupController } from "./lib/screen-share-setup.svelte";
  import { ScreenShareTransportController } from "./lib/screen-share-transport.svelte";
  import { AudioDevicesController } from "./lib/audio-devices.svelte";
  import { NativeVoiceController } from "./lib/native-voice.svelte";
  import { ChatComposerController } from "./lib/composer.svelte";
  import { WorkspaceController } from "./lib/workspace.svelte";
  import { LayoutController, serverRailWidth } from "./lib/layout.svelte";
import {
  screenShareMemberIdForPeer as screenShareMemberIdForPeerOf,
  screenShareOwnerPeerId as screenShareOwnerPeerIdOf,
  screenSharePeerIdForIdentity as screenSharePeerIdForIdentityOf
} from "./lib/screenShareIdentities";
  // ---------------------------------------------------------------------------
  // Constants & runtime flags
  // Values that belong to a single domain should move with that domain into
  // its lib/* module; only app-shell-level constants stay here.
  // ---------------------------------------------------------------------------
  const defaultServerBaseUrl = "http://127.0.0.1:17878";
  const webServerURLPlaceholder = "https://voice.example.com:17878";
  const legacyDefaultServerBaseUrls = new Set(["http://127.0.0.1:7878", "http://localhost:7878"]);
  const voiceStageMemberDisplayModeStorageKey = "ev.voice.stageMemberDisplayMode";
  const maximumVoiceGainLimitPercent = 1000;
  const initialScreenSharePopoutId = new URLSearchParams(window.location.search).get("screenSharePopout") ?? "";
  const screenSharePopoutMode = Boolean(initialScreenSharePopoutId);
  const nativeDesktopRuntime = isTauriRuntime();
  const webDevelopmentRuntime = !nativeDesktopRuntime && import.meta.env.DEV;
  const insecureWebRuntime = !nativeDesktopRuntime && !window.isSecureContext;
  const customDesktopWindow = nativeDesktopRuntime && !screenSharePopoutMode;
  const appIconURL = new URL("../src-tauri/icons/32x32.png", import.meta.url).href;
  const appContentIconURL = new URL("./assets/icon_content.png", import.meta.url).href;
  const localUserProfileExistedAtStartup = hasLocalUserProfile();
  // ---------------------------------------------------------------------------
  // Component-local types & static UI configuration
  // Candidates for extraction: move each type beside the controller or feature
  // component that owns it (emoji, soundboard, dialog, screen share, ...).
  // ---------------------------------------------------------------------------
  type VoiceStageMemberDisplayMode = "cards" | "avatars";
  type AudioDeviceOption = { deviceId: string; label: string; isDefault?: boolean };
  type SettingsSelectMenu = "language" | "audio-input" | "audio-output" | "noise-suppression" | "server-language" | "server-preview-language" | "channel-default-language" | "channel-localization-language";
  const noiseSuppressionModes: VoiceNoiseSuppressionMode[] = ["off", "light", "standard", "strong"];
  type AppDialogKind = "alert" | "confirm" | "prompt";
  type AppDialogResult = boolean | string | null;
  type AppDialogProfileCard = {
    label: string;
    displayName: string;
    avatarDataUrl: string;
    avatarColor: string;
    bio: string;
    identityKey: string;
    updatedAt: string;
  };
  type AppDialogProfileComparison = {
    local: AppDialogProfileCard;
    server: AppDialogProfileCard;
  };
  type AppDialogState = {
    kind: AppDialogKind;
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    danger: boolean;
    profileComparison?: AppDialogProfileComparison;
    memberCard?: AppDialogProfileCard;
    dismissible: boolean;
  };
  type AppDialogOptions = {
    title?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    profileComparison?: AppDialogProfileComparison;
    memberCard?: AppDialogProfileCard;
    dismissible?: boolean;
  };
  // ---------------------------------------------------------------------------
  // Core workspace state
  // Identity, connection inputs, profile, server summary, and feature dialog
  // flags. Longer-term target: lib/workspace.svelte.ts.
  // ---------------------------------------------------------------------------
  let baseUrl = defaultServerBaseUrl;
  let connectBaseUrl = nativeDesktopRuntime || webDevelopmentRuntime ? defaultServerBaseUrl : "";
  let localUserProfile: LocalUserProfile = loadLocalUserProfile(defaultServerBaseUrl);
  let displayName = localUserProfile.display_name;
  let profileDraft: LocalUserProfile = { ...localUserProfile };
  let profileSaving = false;
  let profileSaveMessage = "";
  let profileSettingsDirty = false;
  let profileAvatarCropSource = "";
  // Server settings / profile / invites / audit state moved into
  // ServerSettingsController (lib/server-settings.svelte.ts, aliases below).
  let memberMergeCode = "";
  let memberMergeCodeServerID = "";
  let memberMergeCodeExpiresAtMS = 0;
  let memberMergeCodeInput = "";
  let memberMergeIncoming: MemberMergeRequest[] = [];
  let memberMergeOutgoing: MemberMergeRequest[] = [];
  let memberMergeGenerating = false;
  let memberMergeSubmitting = false;
  let memberMergeStatusMessage = "";
  let memberMergeCodeCopied = false;
  let memberMergeCodeCopiedTimer: number | undefined;
  let memberMergePrompting = false;
  let memberMergePromptRequestID = "";
  let memberMergePromptResolvedExternally = false;
  let connectPassword = "";
  let connectMode: "address" | "invite" = "address";
  let connectInviteLink = "";
  let connectBusy = false;
  let connectUseSavedCredential = true;
  let connectAttemptId = 0;
  let connectAbortController: AbortController | null = null;
  let memberId = "";
  let sessionToken = "";
  let isOwner = false;
  let server: ServerSummary | null = null;
  let serverReportedClientUpdateRequired = false;
  // channels / collapsedCategoryIds moved into ChannelsController (aliases
  // above); templates keep reading the same names.
  let channelTree: ChannelTree = buildChannelTree([]);
  let members: Member[] = [];
  let memberSearchOpen = false;
  let memberSearchQuery = "";
  let memberSearchInputElement: HTMLInputElement | null = null;
  let memberAccessFilterChannelId = "";
  let memberAccessFilterMemberIds = new Set<string>();
  let memberAccessFilterLoading = false;
  let messages: ClientMessage[] = [];
  // ---------------------------------------------------------------------------
  // Domain controllers (lib/*.svelte.ts) + legacy-reactive template aliases
  // Each controller owns one server-authoritative domain. Cross-domain side
  // effects are injected as lazy hooks below; controllers never import this
  // component. Aliases feed templates only — hot paths read controllers.
  // ---------------------------------------------------------------------------
  // Voice state management lives in lib/voice-state.svelte.ts. The component
  // keeps legacy-reactive aliases so templates and existing code keep the
  // same names; every mutation goes through the controller.
  const voiceState = new VoiceStateController({
    activeServerId: () => activeServerId,
    memberId: () => memberId,
    localProfileId: () => localUserProfile.local_profile_id,
    serverId: () => server?.server_id || activeServerId,
    serverName: () => server?.name || savedServers.find((item) => item.server_id === (server?.server_id || activeServerId))?.name || "EchoVoice",
    baseUrl: () => baseUrl,
    sessionToken: () => sessionToken,
    rtcIceServers: () => rtcIceServers,
    channels: () => channelsController.channels,
    channelNameForDisplay: (channel) => channelsController.channelNameForDisplay(channel),
    micMuted: () => audio.micMuted,
    audioDeafened: () => audio.audioDeafened,
    voiceInputUnavailable: () => audio.voiceInputUnavailable,
    isSpeaking: () => audio.isSpeaking,
    screenSharePopoutMode: () => screenSharePopoutMode,
    playUISound: (name) => audio.playUISound(name),
    setLocalSpeaking: (speaking) => audio.setLocalSpeaking(speaking),
    queueCurrentVoiceSpeakingState: (force) => realtime.queueCurrentVoiceSpeakingState(force),
    resetPendingSpeakingState: () => realtime.resetPendingSpeakingState(),
    bumpVoiceMoveSoundGeneration: () => (localVoiceMoveSoundGeneration += 1),
    closeVoiceEventSocket: () => realtime.closeVoiceEventSocket(),
    stopVoiceSession: (options) => nativeVoice.stopVoiceSession(options),
    scheduleVoiceAutoRejoin: (channelId) => realtime.scheduleVoiceAutoRejoin(channelId),
    clearVoiceRejoinArmed: () => realtime.clearVoiceRejoinArmed(),
    ensureCurrentVoiceTransport: (state, restart, forceInitiate) => nativeVoice.ensureCurrentVoiceTransport(state, restart, forceInitiate),
    ensureVoicePeer: (state, initiate) => nativeVoice.ensureVoicePeer(state, initiate),
    closePeerConnection: (participantId, memberIdValue) => nativeVoice.closePeerConnection(participantId, memberIdValue),
    applyManagedVoiceConstraints: (state) => audio.applyManagedVoiceConstraints(state),
    voiceTransportActive: () => nativeVoice.voiceTransportActive(),
    restartLocalVoiceTransportAfterMove: (state) => realtime.restartLocalVoiceTransportAfterMove(state),
    forgetSelectedVoiceParticipant: (participantId) => voiceStage.forgetSelectedVoiceParticipant(participantId)
  });
  // Legacy-reactive aliases for templates and UI helpers. Svelte's legacy
  // compiler does NOT track $state fields read through a non-reactive const
  // binding (like a controller instance), so a bare "$: alias = controller.field"
  // statement would only run once at mount and stay stale forever. To keep
  // these aliases fresh we re-evaluate them on every realtimeSyncTick bump
  // (a 100ms interval driven by a tracked component let). Hot paths (event
  // handlers, WebRTC signaling) must still read the controllers directly —
  // never these aliases — because the alias value can be up to one tick old.
  let realtimeSyncTick = 0;
  $: voiceStates = (realtimeSyncTick, voiceState.voiceStates);
  $: connectedVoiceStates = (realtimeSyncTick, voiceState.connectedVoiceStates);
  $: voiceConnectionContext = (realtimeSyncTick, voiceState.voiceConnectionContext);
  let rtcIceServers: RTCIceServer[] = [];
  // screenShareSessions moved into ScreenShareController (alias above).
  let accompanimentSessions: AccompanimentSession[] = [];
  // Roles and channel permission overrides moved into PermissionsController
  // (lib/permissions.svelte.ts, aliases below).
  // selectedChannelId moved into ChannelsController (alias above).
  // ---------------------------------------------------------------------------
  // Composer & chat-editor DOM refs
  // Composer/chat-editor state lives in ChatComposerController
  // (lib/composer.svelte.ts). Template aliases are declared after the
  // controller. These DOM refs stay owned by the component.
  // ---------------------------------------------------------------------------
  let messageListElement: HTMLDivElement | null = null;
  let composerEditorElement: HTMLDivElement | null = null;
  let composerInputShellElement: HTMLDivElement | null = null;
  let composerAttachmentInputElement: HTMLInputElement | null = null;
  let statusKey = "status.disconnected";
  let error = "";
  let connectError = "";
  let languagePack: LanguagePack = loadInitialLanguage();
  let selectedLanguageId = languagePack.id;
  let importedLanguagePack: LanguagePack | null = loadImportedLanguage();
  let storedCredential: StoredCredential | null = null;
  let savedServers: StoredServer[] = [];
  let serverRailSavedServersByID = new Map<string, StoredServer>();
  let storedServerWriteQueue: Promise<void> = Promise.resolve();
  let activeServerId = "";
  let activeSavedServerValue: StoredServer | undefined;
  let workspaceReconnectRequired = false;
  let workspaceReconnectBusy = false;
  let workspaceConnectionError = "";
  let connectDialogOpen = false;
  let onboardingOpen = false;
  let onboardingStep = 0;
  let appSettingsOpen = false;
  let settingsSelectMenuOpen: SettingsSelectMenu | null = null;
  // serverSettingsOpen / serverSettingsTab moved into ServerSettingsController
  // (aliases below). serverDetailsOpen / serverMenuOpen stay as dialog state.
  let serverDetailsOpen = false;
  let serverMenuOpen = false;
  // inviteDialogOpen / serverInvites / inviteExpiresInSeconds / inviteMaxUses
  // / inviteActionBusy / generatedInviteLink / copiedInviteId moved into
  // ServerSettingsController (aliases below).
  let appDialog: AppDialogState | null = null;
  let appDialogInputValue = "";
  let appDialogInputElement: HTMLInputElement | null = null;
  let appDialogConfirmElement: HTMLButtonElement | null = null;
  let appDialogResolver: ((result: AppDialogResult) => void) | null = null;
  // serverDraft / serverIconCropSource / serverPreviewLanguageId moved into
  // ServerSettingsController (aliases below).
  let serverSettingsDirty = false;
  // Channel editor dialog state moved into ChannelsController (aliases above).
  let channelTopicTextareaElement: HTMLTextAreaElement | null = null;
  // messageContextMenu / selectedMessageIds / messageSelectionAnchorId moved
  // into MessagesController (aliases below).
  // Voice participant selection, drag, context menu, and duration state moved
  // into VoiceStageController (lib/voice-stage.svelte.ts); template-bound
  // aliases are declared after the controller is constructed.
  // channelEditingId / channelName / channelType / channelParentId moved into
  // ChannelsController (aliases above).
  let localVoiceMoveSoundGeneration = 0;
  // Layout state (member panel width, user status panel height, resize) moved
  // into LayoutController (lib/layout.svelte.ts); the instance is assigned
  // after every controller it depends on is constructed.
  let layout: LayoutController;
  let suppressChannelClickUntil = 0;
  let roleIconInputElement: HTMLInputElement | null = null;
  let identityLinkPrimaryMemberId = "";
  let identityLinkDuplicateMemberId = "";
  let identityLinkBusy = false;
  let identityMemberPickerOpen: IdentityMemberPicker | null = null;
  let identityMemberPickerSearch = "";
  let memberRoleMenuId = "";
  let memberRoleMenuSearch = "";
  // Channel permission editor state moved into PermissionsController (aliases
  // below); the picker/menu elements stay as template-bound DOM refs.
  let channelPermissionTargetPickerElement: HTMLDivElement | null = null;
  let channelPermissionTargetMenuElement: HTMLDivElement | null = null;
  let memberEditingId = "";
  let memberBanDraft = false;
  let memberUpdating = false;
  // Message data layer (list, local queue, search, selection, context menu)
  // moved into MessagesController (lib/messages.svelte.ts, aliases below).
  // Reply/edit-editor state lives in ChatComposerController; only the
  // messageEditEditorElement DOM ref stays here.
  let messageEditEditorElement: HTMLDivElement | null = null;
  let voiceChannelTip: { x: number; y: number } | null = null;
  let voiceChannelTipTimer: number | undefined;
  let channelContentMode: "chat" | "files" | "voice" | "category" = "chat";
  let voiceStageMemberDisplayMode: VoiceStageMemberDisplayMode =
    localStorage.getItem(voiceStageMemberDisplayModeStorageKey) === "avatars" ? "avatars" : "cards";
  // File management state moved into ChannelFilesController (lib/
  // channel-files.svelte.ts, aliases below). fileInputElement stays as the
  // template-bound DOM ref and is passed to the controller through hooks.
  let fileInputElement: HTMLInputElement | null = null;
  // auditLogs / auditLogsLoading / auditActionFilter moved into
  // ServerSettingsController (aliases above). Unread/read state moved into
  // ChatComposerController (aliases declared after the controller).
  let selectedChannelLoadingId = "";
  let voiceActionBusy = false;
  let voiceManageBusyMemberId = "";
  let screenShareActionBusy = false;
  let accompanimentVolumePopoverAnchor: HTMLButtonElement | null = null;
  let accompanimentVolumePopoverElement: HTMLDivElement | null = null;
  let webAccompanimentFileInput: HTMLInputElement | null = null;
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Soundboard & emoji feature state
  // Both domains now live in lib/soundboard.svelte.ts and lib/emoji.svelte.ts.
  // Only template-bound DOM refs and the values the existing template writes
  // directly stay here; the controllers reach them through getter/setter hooks.
  // ---------------------------------------------------------------------------
  let soundboardTab: "server" | "local" = "server";
  let soundboardSourceServerID = "";
  let soundboardEditorName = "";
  let soundboardEditorDurationMS = 0;
  let soundboardPopoverAnchor: HTMLButtonElement | null = null;
  let soundboardPopoverElement: HTMLDivElement | null = null;
  let soundboardLocalInputElement: HTMLInputElement | null = null;
  let soundboardServerInputElement: HTMLInputElement | null = null;
  let serverSoundboardManagerInputElement: HTMLInputElement | null = null;
  // ---------------------------------------------------------------------------
  // Screen share setup / capture settings state
  // Setup dialog, source capture, quality menus, and desktop backend state now
  // live in ScreenShareSetupController (lib/screen-share-setup.svelte.ts,
  // aliases below). Only the template-bound quality-menu buttons stay here and
  // are injected back through getter hooks.
  // ---------------------------------------------------------------------------
  let screenShareResolutionButtonElement: HTMLButtonElement | null = null;
  let screenShareFrameRateButtonElement: HTMLButtonElement | null = null;
  let screenShareBitrateButtonElement: HTMLButtonElement | null = null;
  let screenShareContentModeButtonElement: HTMLButtonElement | null = null;
  // Watch state (watched ids, watch sessions, statuses, retry/reconnect
  // timers) moved into ScreenShareController. Transport-owned stats, viewer
  // panel, and WebRTC registries moved into ScreenShareTransportController;
  // template-bound aliases are declared after the controller below.
  // Remote control session lifecycle and input forwarding moved into
  // RemoteControlController (see lib/remote-control.svelte.ts and the $:
  // aliases below). hostedRemoteControl / hostedPendingRemoteControl remain
  // component-derived for the template.
  let nativeRemoteControlLocalInputUnlisten: (() => void) | null = null;
  let voiceConnectionNavigationBusy = false;
  // ---------------------------------------------------------------------------
  // Audio devices, volume preferences, and mic/headphone test state
  // Extraction targets: lib/audio-devices.svelte.ts and lib/audio-test.svelte.ts.
  // ---------------------------------------------------------------------------
  // voiceConnectionStatus / voicePeerCount / latency and level telemetry moved
  // into VoiceSessionController (see the $: aliases above).
  const audio = new AudioDevicesController({
    memberId: () => memberId,
    activeServerId: () => activeServerId,
    nativeDesktopRuntime: () => nativeDesktopRuntime,
    screenSharePopoutMode: () => screenSharePopoutMode,
    appSettingsOpen: () => appSettingsOpen,
    statusKey: () => statusKey,
    languageId: () => languagePack.id,
    voiceActionBusy: () => voiceActionBusy,
    setVoiceActionBusy: (busy) => (voiceActionBusy = busy),
    voiceState: () => voiceState,
    voiceSession: () => voiceSession,
    remoteVoiceMixer: () => remoteVoiceMixer,
    activeUISounds: () => activeUISounds,
    activeSoundboardAudio: () => soundboard.activeAudio,
    soundboardAudioContext: () => soundboard.audioContext,
    accompanimentSyncOutputDevice: (deviceId) => accompaniment.syncOutputDevice(deviceId),
    applySoundboardAudioGains: () => soundboard.applyAudioGains(),
    accompanimentApplyMonitorLevel: () => accompaniment.applyMonitorLevel(),
    currentVoiceState: () => voiceStage.currentVoiceState(),
    voiceStatesByMember: () => voiceStatesByMember,
    screenShareSessions: () => screenShareSessions,
    queueCurrentVoiceSpeakingState: (force) => realtime.queueCurrentVoiceSpeakingState(force),
    nativeVoiceSession: () => nativeVoice.nativeVoiceSession,
    nativeVoiceStatus: () => nativeVoice.nativeVoiceStatus,
    applyNativeVoiceStatus: (status) => nativeVoice.applyNativeVoiceStatus(status),
    clearNativeMicrophoneRecovery: (resetAttempts) => nativeVoice.clearNativeMicrophoneRecovery(resetAttempts),
    recoverNativeMicrophone: (sessionId) => nativeVoice.recoverNativeMicrophone(sessionId),
    scheduleNativeMicrophoneRecovery: (sessionId) => nativeVoice.scheduleNativeMicrophoneRecovery(sessionId),
    nativeVoiceCommandWasStaleOrMissing: (sessionId, caught) => nativeVoice.nativeVoiceCommandWasStaleOrMissing(sessionId, caught),
    startDesktopNativeVoiceSession: (channelId) => nativeVoice.startDesktopNativeVoiceSession(channelId),
    stopCurrentNativeVoiceSession: () => nativeVoice.stopCurrentNativeVoiceSession(),
    startVoiceSession: (channelId, retryMissingNativeSession, forceInitiatePeers) => nativeVoice.startVoiceSession(channelId, retryMissingNativeSession, forceInitiatePeers),
    setError: (message) => (error = message),
    translate: (key, params) => t(key, params),
    caughtMessage,
    showAppAlert,
    closeSettingsSelectMenu: () => (settingsSelectMenuOpen = null),
    clearCopiedInviteTimer: () => undefined,
    closeScreenShareViewerPanel: () => transport.closeScreenShareViewerPanel(),
    stopMediaStream: (stream) => transport.stopMediaStream(stream),
    flushAliases: () => {
      realtimeSyncTick += 1;
    },
    rawLocalVoiceStream: () => rawLocalVoiceStream,
    localVoiceStream: () => localVoiceStream,
    openLocalVoiceStream: () => voiceSession.openLocalVoiceStream(),
    attachLocalVoiceStream: (stream) => voiceSession.attachLocalVoiceStream(stream),
    stopLocalVoiceInput: () => voiceSession.stopLocalVoiceInput(),
    restartVoiceInput: () => voiceSession.restartVoiceInput(),
    replaceOutgoingAudioTrack: (track) => voiceSession.replaceOutgoingAudioTrack(track),
    applyWebNoiseGate: () => voiceSession.applyWebNoiseGate(),
    memberById: (memberIdValue) => permissionsController.memberById(memberIdValue),
    memberRoleLabel: (member) => permissionsController.memberRoleLabel(member)
  });
  // Legacy-reactive aliases for template-bound audio state. Hot paths read
  // `audio` directly; these refresh every realtimeSyncTick like the other
  // controller aliases in this component.
  $: micMuted = (realtimeSyncTick, audio.micMuted);
  $: audioDeafened = (realtimeSyncTick, audio.audioDeafened);
  $: isSpeaking = (realtimeSyncTick, audio.isSpeaking);
  $: voiceInputUnavailable = (realtimeSyncTick, audio.voiceInputUnavailable);
  $: audioInputDevices = (realtimeSyncTick, audio.audioInputDevices);
  $: audioOutputDevices = (realtimeSyncTick, audio.audioOutputDevices);
  $: selectedAudioInputDeviceId = (realtimeSyncTick, audio.selectedAudioInputDeviceId);
  $: selectedAudioOutputDeviceId = (realtimeSyncTick, audio.selectedAudioOutputDeviceId);
  $: audioInputDevicesLoading = (realtimeSyncTick, audio.audioInputDevicesLoading);
  $: microphoneGainLimitPercent = (realtimeSyncTick, audio.microphoneGainLimitPercent);
  $: memberVolumeLimitPercent = (realtimeSyncTick, audio.memberVolumeLimitPercent);
  $: microphoneGainPercent = (realtimeSyncTick, audio.microphoneGainPercent);
  $: noiseSuppressionMode = (realtimeSyncTick, audio.noiseSuppressionMode);
  $: outputVolumePercent = (realtimeSyncTick, audio.outputVolumePercent);
  $: screenShareVolumePercents = (realtimeSyncTick, audio.screenShareVolumePercents);
  $: screenShareVolumeMenuShareId = (realtimeSyncTick, audio.screenShareVolumeMenuShareId);
  $: voiceParticipantMenuVolumePercent = (realtimeSyncTick, audio.voiceParticipantMenuVolumePercent);
  $: voiceParticipantMenuMusicVolumePercent = (realtimeSyncTick, audio.voiceParticipantMenuMusicVolumePercent);
  $: microphoneTestBusy = (realtimeSyncTick, audio.microphoneTestBusy);
  $: microphoneTestActive = (realtimeSyncTick, audio.microphoneTestActive);
  $: microphoneTestLevel = (realtimeSyncTick, audio.microphoneTestLevel);
  $: headphoneTestBusy = (realtimeSyncTick, audio.headphoneTestBusy);
  // ---------------------------------------------------------------------------
  // Native (Tauri) voice session state
  // Status/signal polling, repair, and microphone recovery. Extraction target:
  // lib/native-voice.svelte.ts.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Desktop window state & screen-share DOM refs
  // Transport state (local capture, native sender, preview, signal queues,
  // polling) moved into ScreenShareTransportController (lib/
  // screen-share-transport.svelte.ts). The template-bound DOM refs below are
  // injected into that controller through getter/setter hooks.
  // ---------------------------------------------------------------------------
  let localScreenShareVideoElement: HTMLVideoElement | null = null;
  let focusedScreenShareVideoElement: HTMLVideoElement | null = null;
  let screenShareFocusElement: HTMLElement | null = null;
  // ---------------------------------------------------------------------------
  // Media/transport composition
  // RemoteVoiceMixer and TabVisibilityMonitor are shared infrastructure used by
  // the voice/screen-share controllers below; construction order matters here.
  // ---------------------------------------------------------------------------
  // remoteScreenShareStreams moved into ScreenShareController (alias above).
  const remoteVoiceMixer = new RemoteVoiceMixer({
    outputVolumePercent: () => audio.outputVolumePercent,
    audioDeafened: () => audio.audioDeafened,
    streamVolumePercent: (targetMemberId, scope) => scope === "screen-share"
      ? audio.screenShareVolumePercent(targetMemberId)
      : scope === "accompaniment"
        ? audio.memberMusicVolumePercent(targetMemberId)
        : audio.memberVolumePercent(targetMemberId),
    onPlaybackBlocked: (blocked) => (remoteAudioPlaybackBlocked = blocked),
    onPlaybackResumed: () => audio.applyRemoteAudioState(),
    onContextCreated: () => {
      void audio.applyAudioOutputDevice();
      audio.applyRemoteAudioState();
    },
    onElementCreated: (audioElement) => {
      void audio.setAudioElementSink(audioElement).catch(() => undefined);
    },
    reapplyVolume: (targetMemberId, scope) => {
      if (scope === "screen-share") audio.applyScreenShareVolume(targetMemberId);
      else if (scope === "accompaniment") audio.applyMemberMusicVolume(targetMemberId);
      else audio.applyMemberVolume(targetMemberId);
    }
  });
  const tabVisibility = new TabVisibilityMonitor({
    onHidden: () => {
      realtime.setLocalScreenSharePreviewRendering(false);
      voiceSession.clearHealthSamples();
    },
    onVisible: () => {
      realtime.setLocalScreenSharePreviewRendering(document.hasFocus());
      void realtime.recoverAfterBrowserReturn();
    },
    onResume: () => {
      voiceSession.clearHealthSamples();
      if (document.visibilityState === "visible") {
        void realtime.recoverAfterBrowserReturn();
      }
    },
    onPageShow: () => {
      voiceSession.clearHealthSamples();
      if (document.visibilityState === "visible") {
        void realtime.recoverAfterBrowserReturn();
      }
    }
  });
  // Accompaniment domain lives in lib/accompaniment.svelte.ts (aliases below).
  const accompaniment = new AccompanimentController({
    server: () => server,
    baseUrl: () => baseUrl,
    sessionToken: () => sessionToken,
    memberId: () => memberId,
    activeServerId: () => activeServerId,
    voiceConnectionContext: () => voiceConnectionContext,
    nativeDesktopRuntime: () => nativeDesktopRuntime,
    nativeVoiceSession: () => nativeVoice.nativeVoiceSession,
    currentVoiceState: () => voiceStage.currentVoiceState(),
    canPlayAccompaniment: () => canPlayAccompaniment,
    translate: (key, params) => t(key, params),
    setError: (message) => (error = message),
    caughtMessage,
    isHTTPStatus: (caught, status) => audio.isHTTPStatus(caught, status),
    nativeVoiceCommandWasStaleOrMissing: (sessionId, caught) => nativeVoice.nativeVoiceCommandWasStaleOrMissing(sessionId, caught),
    outputVolumePercent: () => audio.outputVolumePercent,
    audioDeafened: () => audio.audioDeafened,
    selectedAudioOutputDeviceId: () => audio.selectedAudioOutputDeviceId,
    closeSoundboardPopover,
    replaceOutgoingAccompanimentTrack: (track, stream) => voiceSession.replaceOutgoingAccompanimentTrack(track, stream),
    ensureDesktopMediaCapabilities: () => screenShareSetup.ensureDesktopMediaCapabilities(),
    volumePopoverAnchor: () => accompanimentVolumePopoverAnchor,
    setVolumePopoverAnchor: (anchor) => (accompanimentVolumePopoverAnchor = anchor),
    volumePopoverElement: () => accompanimentVolumePopoverElement,
    setVolumePopoverElement: (element) => (accompanimentVolumePopoverElement = element),
    webAccompanimentFileInput: () => webAccompanimentFileInput,
    flushAliases: () => {
      realtimeSyncTick += 1;
    }
  });
  $: accompanimentSessions = (realtimeSyncTick, accompaniment.sessions);
  $: accompanimentActionBusy = (realtimeSyncTick, accompaniment.actionBusy);
  $: accompanimentVolumePopoverOpen = (realtimeSyncTick, accompaniment.volumePopoverOpen);
  // Voice channel session (Web path) lives in lib/voice-session.svelte.ts.
  // Thin wrappers below keep the component's call sites unchanged; hot paths
  // read the controller directly, the $: aliases feed templates only. The
  // instantiation sits after remoteVoiceMixer/tabVisibility to avoid TDZ.
  const voiceSession = new VoiceSessionController({
    voiceState,
    remoteVoiceMixer,
    micMuted: () => audio.micMuted,
    audioDeafened: () => audio.audioDeafened,
    voiceInputUnavailable: () => audio.voiceInputUnavailable,
    isSpeaking: () => audio.isSpeaking,
    microphoneGainPercent: () => audio.microphoneGainPercent,
    noiseSuppressionMode: () => audio.noiseSuppressionMode,
    selectedAudioInputDeviceId: () => audio.selectedAudioInputDeviceId,
    clearSelectedAudioInputDeviceId: () => {
      audio.selectedAudioInputDeviceId = "";
      audio.saveSelectedAudioInputDeviceId("");
    },
    nativeDesktopRuntime: () => nativeDesktopRuntime,
    nativeVoiceSession: () => nativeVoice.nativeVoiceSession,
    nativeVoiceStatus: () => nativeVoice.nativeVoiceStatus,
    nativeSessionStarting: () => nativeVoice.nativeVoiceSessionStarts.active,
    rtcIceServers: () => rtcIceServers,
    accompanimentSessions: () => accompaniment.sessions,
    hiddenSinceMS: () => tabVisibility.hiddenSinceMS,
    documentHidden: () => document.visibilityState === "hidden",
    setMicMuted: (value) => (audio.micMuted = value),
    setAudioDeafened: (value) => (audio.audioDeafened = value),
    setVoiceInputUnavailable: (value) => (audio.voiceInputUnavailable = value),
    setLocalSpeaking: (value) => audio.setLocalSpeaking(value),
    setError: (message) => (error = message),
    reportMediaError: (caught, fallbackKey) => (error = caughtMessage(caught, t(fallbackKey))),
    translate: (key, params) => t(key, params),
    audioConstraints: (deviceId = audio.selectedAudioInputDeviceId) => audio.audioConstraints(deviceId),
    applyLocalAudioState: () => audio.applyLocalAudioState(),
    mergeCurrentVoiceFlags: () => audio.mergeCurrentVoiceFlags(),
    syncCurrentVoiceState: () => audio.syncCurrentVoiceState(),
    refreshAudioInputDevices: (requestPermission, reportError) => audio.refreshAudioInputDevices(requestPermission, reportError),
    applyNativeVoiceLatency: (roundTripTimeMs) => nativeVoice.applyNativeVoiceLatency(roundTripTimeMs),
    sendRTCSignal: (targetParticipantId, signalType, data) => nativeVoice.sendRTCSignal(targetParticipantId, signalType, data),
    attachRemoteScreenShare,
    attachRemoteAudio: (memberIdValue, stream, scope) => remoteVoiceMixer.attach(memberIdValue, stream, scope),
    applyMemberVolume: (targetMemberId) => audio.applyMemberVolume(targetMemberId),
    resumeVoiceAudioAfterBrowserReturn: () => realtime.resumeVoiceAudioAfterBrowserReturn(),
    stopVoiceSession: (options) => nativeVoice.stopVoiceSession(options),
    stopCurrentNativeVoiceSession: () => nativeVoice.stopCurrentNativeVoiceSession(),
    stopCurrentNativeScreenShareSender: () => screenShareSetup.stopNativeSender(),
    stopWebScreenShareSignalPolling: () => transport.stopWebScreenShareSignalPolling(),
    stopLocalScreenShareStream: (options) => transport.stopLocalScreenShareStream(options),
    closeScreenShareSetup: () => screenShareSetup.closeSetup(),
    closeAccompanimentVolumePopover: () => accompaniment.closeVolumePopover(),
    disposeWebAccompanimentPlayback: () => accompaniment.disposePlayback(),
    closeScreenShareViewerPanel: () => transport.closeScreenShareViewerPanel(),
    clearAllScreenShareWatchRetryTimers: () => screenShare.clearAllWatchRetryTimers(),
    clearAllScreenShareReconnectTimers: () => screenShare.clearAllReconnectTimers(),
    stopViewerScreenShareSignalPolling: () => transport.stopViewerScreenShareSignalPolling(),
    setRemoteAudioPlaybackBlocked: (blocked) => (remoteAudioPlaybackBlocked = blocked),
    webAccompanimentStream: () => accompaniment.webStream(),
    handleVoiceSignalDispatch: (signal) => nativeVoice.handleRTCSignal(signal)
  });
  $: voiceConnectionStatus = (realtimeSyncTick, voiceSession.connectionStatus);
  $: voiceInputLevel = (realtimeSyncTick, voiceSession.inputLevel);
  $: localVoiceStream = (realtimeSyncTick, voiceSession.localVoiceStream);
  $: rawLocalVoiceStream = (realtimeSyncTick, voiceSession.rawLocalVoiceStream);
  // Screen share session registry and watch lifecycle live in
  // lib/screen-share.svelte.ts; the WebRTC mesh, sender capture, and native
  // paths stay in this component and are reached through hooks.
  const screenShare = new ScreenShareController({
    memberId: () => memberId,
    sessionToken: () => sessionToken,
    baseUrl: () => baseUrl,
    eventSocket: () => realtime.eventSocket,
    currentVoiceState: () => voiceStage.currentVoiceState(),
    translate: (key, params) => t(key, params),
    setError: (message) => (error = message),
    prepareVoiceAudioPlayback: () => remoteVoiceMixer.preparePlayback(),
    openScreenShareViewer: (share) => transport.openScreenShareViewer(share),
    closeScreenShareViewerPanel: () => transport.closeScreenShareViewerPanel(),
    clearRemoteControlsForShare: (shareId) => remoteControl.clearForShare(shareId),
    releaseActiveRemoteControlCapture: () => remoteControl.releaseActiveCapture(),
    currentMemberRemoteControlForShare: (shareId, controls) => remoteControl.currentMemberForShare(shareId, controls),
    remoteControlCaptureControlId: () => remoteControl.captureControlId,
    screenShareVolumeMenuShareId: () => audio.screenShareVolumeMenuShareId,
    setScreenShareVolumeMenuShareId: (shareId) => (audio.screenShareVolumeMenuShareId = shareId),
    focusedScreenShareId: () => screenShare.focusedScreenShareId,
    setFocusedScreenShareId: (shareId) => (screenShare.focusedScreenShareId = shareId),
    poppedOutScreenShareIds: () => poppedOutScreenShareIds,
    setPoppedOutScreenShareIds: (ids) => (poppedOutScreenShareIds = ids),
    screenShareViewerPanelShareId: () => transport.screenShareViewerPanelShareId,
    syncViewerScreenShareSignalPolling: () => transport.syncViewerScreenShareSignalPolling(),
    stopWebScreenShareSignalPolling: () => transport.stopWebScreenShareSignalPolling(),
    closeAllScreenSharePeerConnections: () => transport.closeAllScreenSharePeerConnections(),
    closeScreenSharePeerConnection: (identity) => transport.closeScreenSharePeerConnection(identity),
    stopLocalScreenShareStream: (options) => transport.stopLocalScreenShareStream(options),
    stopCurrentNativeScreenShareSender: () => screenShareSetup.stopNativeSender(),
    clearScreenShareWatchers: () => screenShare.clearWatchers(),
    screenShareOwnerPeerId,
    screenSharePeerConnection: (peerId) => transport.screenSharePeerConnections.get(peerId),
    screenSharePeerConnectionForShare: (shareId) => transport.screenSharePeerConnectionForShare(shareId),
    screenShareMemberIdForPeer,
    enqueueScreenShareSignal: (signal) => realtime.enqueueScreenShareSignal(signal),
    handleRTCSignal: (signal) => nativeVoice.handleRTCSignal(signal),
    handleScreenShareOfferSignal: (signal) => transport.handleScreenShareOfferSignal(signal),
    handleScreenShareAnswerSignal: (signal) => transport.handleScreenShareAnswerSignal(signal),
    handleScreenShareIceCandidateSignal: (signal) => transport.handleScreenShareIceCandidateSignal(signal),
    handleScreenShareIceRestartSignal: (signal) => transport.handleScreenShareIceRestartSignal(signal),
    ensureFreshRTCConfig: () => workspace.ensureFreshRTCConfig(),
    rtcIceConfigFetchedAtMS: () => workspace.rtcIceConfigFetchedAt(),
    shouldHandleScreenShareMediaSignal: (fromMemberId) => transport.shouldHandleScreenShareMediaSignal(fromMemberId),
    addOutgoingScreenShareForMember: (targetMemberId, watchSessionId) =>
      transport.addOutgoingScreenShareForMember(targetMemberId, watchSessionId),
    syncNativeScreenShareViewersFromSession: (session) => realtime.syncNativeScreenShareViewersFromSession(session),
    applyNativeScreenShareSenderStatus: (status) => transport.applyNativeScreenShareSenderStatus(status),
    addNativeScreenShareSenderViewer: (sessionId, peerId, watchSessionId) =>
      addNativeScreenShareSenderViewer(sessionId, peerId, watchSessionId),
    removeNativeScreenShareSenderViewer: (sessionId, peerId, watchSessionId) =>
      removeNativeScreenShareSenderViewer(sessionId, peerId, watchSessionId),
    forwardNativeScreenShareSenderSignals: (sessionId) => transport.forwardNativeScreenShareSenderSignals(sessionId),
    scheduleNativeScreenShareSignalFlush: (sessionId) => transport.scheduleNativeScreenShareSignalFlush(sessionId),
    nativeScreenShareSenderSession: () => transport.nativeScreenShareSenderSession,
    nativeScreenShareAppliedAnswerMemberIds: () => transport.nativeScreenShareAppliedAnswerMemberIds,
    setNativeScreenShareAppliedAnswerMemberIds: (ids) => (transport.nativeScreenShareAppliedAnswerMemberIds = ids),
    nativeScreenShareRegisteredViewerIds: () => transport.nativeScreenShareRegisteredViewerIds,
    setNativeScreenShareRegisteredViewerIds: (ids) => (transport.nativeScreenShareRegisteredViewerIds = ids),
    screenShareWatcherSessionIds: () => screenShare.watcherSessionIds,
    screenShareWatchers: () => screenShare.watchers,
    addScreenShareWatcher: (peerId) => screenShare.watchers.add(peerId),
    removeScreenShareWatcher: (peerId) => screenShare.watchers.delete(peerId),
    voiceStatesByParticipant: () => voiceStatesByParticipant,
    voiceStatesByMember: () => voiceStatesByMember,
    currentMemberScreenShare: () => currentMemberScreenShare ??
      screenShare.sessions.find((item) => item.owner_member_id === memberId) ?? undefined,
    webOwnedShareReady: (shareId) => {
      const share = screenShare.sessions.find((item) => item.owner_member_id === memberId && item.share_id === shareId) ??
        currentMemberScreenShare;
      return Boolean(
        share?.share_id === shareId &&
        transport.localScreenShareStream?.getVideoTracks().some((track) => track.readyState === "live")
      );
    }
  });
  // Remote control session lifecycle and input forwarding live in
  // lib/remote-control.svelte.ts. Hooks reach back into component state lazily
  // (arrow closures), so construction order cannot throw TDZ errors.
  const remoteControl = new RemoteControlController({
    memberId: () => memberId,
    sessionToken: () => sessionToken,
    baseUrl: () => baseUrl,
    activeServerId: () => activeServerId,
    eventSocket: () => realtime.eventSocket,
    currentVoiceState: () => voiceStage.currentVoiceState(),
    translate: (key, params) => t(key, params),
    setError: (message) => (error = message),
    setStatusKey: (key) => (statusKey = key),
    serverRemoteControlEnabled: () => Boolean(server?.remote_control_enabled),
    canRequestRemoteControl: () => canRequestRemoteControl,
    canAcceptRemoteControl: () => canAcceptRemoteControl,
    canHostRemoteControl: () => canHostRemoteControl,
    isTauriRuntime: () => isTauriRuntime(),
    desktopMediaCapabilities: () => screenShareSetup.desktopMediaCapabilities,
    desktopMediaCapabilitiesLoading: () => screenShareSetup.desktopMediaCapabilitiesLoading,
    selectedDesktopCaptureSource: () => screenShareSetup.selectedDesktopCaptureSource,
    nativeScreenShareSenderSession: () => transport.nativeScreenShareSenderSession,
    screenShareSessions: () => screenShare.sessions,
    isWatchingScreenShare: (share) => screenShare.isWatchingScreenShare(share),
    openScreenShareViewer: (share) => transport.openScreenShareViewer(share),
    focusedScreenShareId: () => screenShare.focusedScreenShareId
  });
  $: screenShareSessions = (realtimeSyncTick, screenShare.sessions);
  $: remoteScreenShareStreams = (realtimeSyncTick, screenShare.remoteStreams);
  $: screenShareWatchingBusyIds = (realtimeSyncTick, screenShare.watchingBusyIds);
  $: remoteControlSessions = (realtimeSyncTick, remoteControl.sessions);
  $: remoteControlCaptureControlId = (realtimeSyncTick, remoteControl.captureControlId);
  // Screen share setup domain lives in lib/screen-share-setup.svelte.ts.
  // The controller owns setup/source/quality state and start/stop orchestration;
  // transport state/functions stay here and are injected as lazy hooks below.
  const screenShareSetup = new ScreenShareSetupController({
    server: () => server,
    baseUrl: () => baseUrl,
    sessionToken: () => sessionToken,
    memberId: () => memberId,
    currentVoiceState: () => voiceStage.currentVoiceState(),
    canStartScreenShareSession: () => canStartScreenShareSessionValue,
    canHostRemoteControl: () => canHostRemoteControl,
    isTauriRuntime: () => isTauriRuntime(),
    screenShareAudioAvailable: () => screenShareAudioAvailable,
    translate: (key, params) => t(key, params),
    setError: (message) => (error = message),
    setStatusKey: (key) => (statusKey = key),
    screenShareActionBusy: () => screenShareActionBusy,
    setScreenShareActionBusy: (busy) => (screenShareActionBusy = busy),
    clearStaleCurrentMemberScreenShare: () => transport.clearStaleCurrentMemberScreenShare(),
    closeVoiceNetworkDetails: () => audio.closeVoiceNetworkDetails(),
    closeScreenShareViewerPanel: () => transport.closeScreenShareViewerPanel(),
    screenShareClearWatchers: () => screenShare.clearWatchers(),
    mergeScreenShareSession: (session) => realtime.mergeScreenShareSession(session),
    removeScreenShareSession: (session) => screenShare.removeScreenShareSession(session),
    removeCurrentMemberScreenShareSession,
    currentMemberScreenShare: () => currentMemberScreenShare,
    screenShareWatchingBusyIds: () => screenShare.watchingBusyIds,
    setScreenShareWatchingBusyIds: (ids) => (screenShare.watchingBusyIds = ids),
    screenShareViewerPanelShareId: () => transport.screenShareViewerPanelShareId,
    remoteControlClearNativeHostId: () => remoteControl.clearNativeHostId(),
    pendingWebScreenShareStream: () => transport.pendingWebScreenShareStream,
    setPendingWebScreenShareStream: (stream) => (transport.pendingWebScreenShareStream = stream),
    applyWebScreenShareSenderSettings: () => transport.applyScreenShareSenderSettings(),
    setWebScreenShareAudioEnabled: (enabled) => transport.setOutgoingScreenShareAudioEnabled(enabled),
    setNativeScreenShareMaximumBitrate: (bitrateBps) => transport.setNativeScreenShareMaximumBitrate(bitrateBps),
    setNativeScreenShareFrameRate: (frameRate) => transport.setNativeScreenShareFrameRate(frameRate),
    nativeScreenShareSenderSession: () => transport.nativeScreenShareSenderSession,
    setNativeScreenShareSenderSession: (session) => (transport.nativeScreenShareSenderSession = session),
    setNativeScreenShareSenderStatus: (status) => (transport.nativeScreenShareSenderStatus = status),
    nativeScreenShareStatusRefreshError: () => transport.nativeScreenShareStatusRefreshError,
    setNativeScreenShareStatusRefreshError: (message) => (transport.nativeScreenShareStatusRefreshError = message),
    nativeScreenShareRegisteredViewerIds: () => transport.nativeScreenShareRegisteredViewerIds,
    setNativeScreenShareRegisteredViewerIds: (ids) => (transport.nativeScreenShareRegisteredViewerIds = ids),
    nativeScreenShareAppliedAnswerMemberIds: () => transport.nativeScreenShareAppliedAnswerMemberIds,
    setNativeScreenShareAppliedAnswerMemberIds: (ids) => (transport.nativeScreenShareAppliedAnswerMemberIds = ids),
    nativeScreenShareSignalDrainInFlight: () => transport.nativeScreenShareSignalDrainInFlight,
    setNativeScreenShareSignalDrainInFlight: (value) => (transport.nativeScreenShareSignalDrainInFlight = value),
    nativeScreenShareSignalDrainLastAtMS: () => transport.nativeScreenShareSignalDrainLastAtMS,
    setNativeScreenShareSignalDrainLastAtMS: (value) => (transport.nativeScreenShareSignalDrainLastAtMS = value),
    nativeScreenShareViewerSyncAtMS: () => transport.nativeScreenShareViewerSyncAtMS,
    setNativeScreenShareViewerSyncAtMS: (value) => (transport.nativeScreenShareViewerSyncAtMS = value),
    localScreenSharePreviewRenderingEnabled: () => transport.localScreenSharePreviewRenderingEnabled,
    rtcIceServers: () => rtcIceServers,
    openLocalScreenShareStream: (includeAudio) => transport.openLocalScreenShareStream(includeAudio),
    attachLocalScreenShareStream: (stream) => transport.attachLocalScreenShareStream(stream),
    stopLocalScreenShareStream: (options) => transport.stopLocalScreenShareStream(options),
    stopMediaStream: (stream) => transport.stopMediaStream(stream),
    flushPendingOwnedScreenShareWatchSignals: (shareId) => transport.flushPendingOwnedScreenShareWatchSignals(shareId),
    startWebScreenShareSignalPolling: (shareId) => transport.startWebScreenShareSignalPolling(shareId),
    stopWebScreenShareSignalPolling: () => transport.stopWebScreenShareSignalPolling(),
    startNativeScreenShareStatusPolling: () => transport.startNativeScreenShareStatusPolling(),
    stopNativeScreenShareStatusPolling: (options) => transport.stopNativeScreenShareStatusPolling(options),
    scheduleNativeScreenShareStatusProbeBurst: (sessionId) => transport.scheduleNativeScreenShareStatusProbeBurst(sessionId),
    scheduleNativeScreenShareSignalFlush: (sessionId) => transport.scheduleNativeScreenShareSignalFlush(sessionId),
    syncNativeScreenSharePreviewRendering: (sessionId) => realtime.syncNativeScreenSharePreviewRendering(sessionId),
    applyNativeScreenShareSenderStatus: (status) => transport.applyNativeScreenShareSenderStatus(status),
    nativeScreenShareSenderStatusFallback: (session, options) => transport.nativeScreenShareSenderStatusFallback(session, options),
    localScreenShareStream: () => transport.localScreenShareStream,
    webScreenShareSenderTelemetry: () => transport.webScreenShareSenderTelemetry,
    webScreenShareViewerPaths: () => transport.webScreenShareViewerPaths,
    webScreenShareSenderConfigurationErrors: () => transport.webScreenShareSenderConfigurationErrors,
    screenShareWatcherSessionIds: () => screenShare.watcherSessionIds,
    closeAllScreenSharePeerConnections: () => transport.closeAllScreenSharePeerConnections(),
    stopNativeLocalScreenSharePreview: (options) => realtime.stopNativeLocalScreenSharePreview(options),
    abortableRequestWithTimeout: (request, timeoutMS, message) => transport.abortableRequestWithTimeout(request, timeoutMS, message),
    promiseWithTimeout: (promise, timeoutMS, message) => transport.promiseWithTimeout(promise, timeoutMS, message),
    resolutionButton: () => screenShareResolutionButtonElement,
    frameRateButton: () => screenShareFrameRateButtonElement,
    bitrateButton: () => screenShareBitrateButtonElement,
    contentModeButton: () => screenShareContentModeButtonElement,
    flushAliases: () => {
      realtimeSyncTick += 1;
    }
  });
  $: selectedDesktopCaptureSource = (realtimeSyncTick, screenShareSetup.selectedDesktopCaptureSource);
  // Screen share transport (native sender, viewer panel, WebRTC mesh, popout
  // watch) lives in lib/screen-share-transport.svelte.ts. Cross-domain side
  // effects are injected as lazy hooks below; template-bound aliases follow the
  // constructor and refresh every realtimeSyncTick.
  const transport = new ScreenShareTransportController({
    memberId: () => memberId,
    sessionToken: () => sessionToken,
    baseUrl: () => baseUrl,
    currentVoiceState: () => voiceStage.currentVoiceState(),
    voiceConnectionContext: () => voiceConnectionContext,
    voiceState: () => voiceState,
    screenSharePopoutMode: () => screenSharePopoutMode,
    screenSharePopoutShareId: () => initialScreenSharePopoutId,
    nativeDesktopRuntime: () => nativeDesktopRuntime,
    isTauriRuntime: () => isTauriRuntime(),
    translate: (key, params) => t(key, params),
    setError: (message) => (error = message),
    showAppAlert: (message, options) => showAppAlert(message, options ?? {}),
    screenShare: () => screenShare,
    screenShareSetup: () => screenShareSetup,
    realtime: () => realtime,
    remoteControl: () => remoteControl,
    voiceSession: () => voiceSession,
    accompaniment: () => accompaniment,
    localScreenShareVideoElement: () => localScreenShareVideoElement,
    setLocalScreenShareVideoElement: (element) => (localScreenShareVideoElement = element),
    focusedScreenShareVideoElement: () => focusedScreenShareVideoElement,
    setFocusedScreenShareVideoElement: (element) => (focusedScreenShareVideoElement = element),
    screenShareFocusElement: () => screenShareFocusElement,
    setScreenShareFocusElement: (element) => (screenShareFocusElement = element),
    screenShareActionBusy: () => screenShareActionBusy,
    setScreenShareActionBusy: (busy) => (screenShareActionBusy = busy),
    currentMemberScreenShare: () => currentMemberScreenShare,
    currentMemberActiveScreenShare: () => currentMemberActiveScreenShare,
    focusedScreenShareId: () => screenShare.focusedScreenShareId,
    setFocusedScreenShareId: (shareId) => (screenShare.focusedScreenShareId = shareId),
    poppedOutScreenShareIds: () => poppedOutScreenShareIds,
    setPoppedOutScreenShareIds: (ids) => (poppedOutScreenShareIds = ids),
    screenShareVolumeMenuShareId: () => audio.screenShareVolumeMenuShareId,
    setScreenShareVolumeMenuShareId: (shareId) => (audio.screenShareVolumeMenuShareId = shareId),
    selectedChannelId: () => selectedChannelId,
    setSelectedChannelId: (channelId) => (channelsController.selectedChannelId = channelId),
    channelContentMode: () => channelContentMode,
    setChannelContentMode: (mode) => (channelContentMode = mode),
    memberDisplayName: (memberIdValue) => permissionsController.memberDisplayName(memberIdValue),
    screenShareViewerCount: (share) => screenShareViewerCount(share),
    closeCreateChannelMenu: () => channelsController.closeCreateChannelMenu(),
    closeMessageContextMenu: () => closeMessageContextMenu(),
    closeServerMenu: () => closeServerMenu(),
    clearReplyTarget: () => composer.clearReplyTarget(),
    clearMessageSearch: () => composer.clearMessageSearch(),
    clearFileView: () => channelFiles.clearFileView(),
    focusMemberAccessFilter: (channelId) => void voiceStage.focusMemberAccessFilter(channelId),
    releaseActiveRemoteControlCapture: () => remoteControl.releaseActiveCapture(),
    currentMemberRemoteControlForShare: (shareId) => remoteControl.currentMemberForShare(shareId),
    remoteControlCaptureControlId: () => remoteControl.captureControlId,
    stopCurrentScreenShareSession: () => screenShareSetup.stopCurrentSession(),
    removeCurrentMemberScreenShareSession: (session) => removeCurrentMemberScreenShareSession(session),
    refreshScreenShareSessions: () => realtime.refreshScreenShareSessions(),
    enqueueScreenShareSignal: (signal) => realtime.enqueueScreenShareSignal(signal),
    sendRTCSignal: (targetParticipantId, signalType, data) => nativeVoice.sendRTCSignal(targetParticipantId, signalType, data),
    browserRTCConfiguration: () => browserRTCConfiguration(),
    attachRemoteScreenShare: (peerId, memberIdValue, stream, track) => attachRemoteScreenShare(peerId, memberIdValue, stream, track),
    attachRemoteAudio: (memberIdValue, stream, scope) => remoteVoiceMixer.attach(memberIdValue, stream, scope),
    detachRemoteAudioForMember: (memberIdValue, scope) =>
      remoteVoiceMixer.detachForMember(memberIdValue, scope),
    screenShareOwnerPeerId: (share) => screenShareOwnerPeerId(share),
    screenShareMemberIdForPeer: (peerId) => screenShareMemberIdForPeer(peerId),
    screenSharePeerIdForIdentity: (identity) => screenSharePeerIdForIdentity(identity),
    ensureFreshRTCConfig: () => workspace.ensureFreshRTCConfig(),
    rtcIceConfigFetchedAtMS: () => workspace.rtcIceConfigFetchedAt(),
    flushAliases: () => {
      realtimeSyncTick += 1;
    }
  });
  // Legacy template aliases for transport-owned state. The Svelte legacy
  // compiler does not track $state reads through a non-reactive const binding,
  // so these refresh on realtimeSyncTick (100ms) like the other aliases.
  $: screenShareViewerPanelShareId = (realtimeSyncTick, transport.screenShareViewerPanelShareId);
  $: screenSharePopoutWatchStarted = (realtimeSyncTick, transport.screenSharePopoutWatchStarted);
  $: screenSharePopoutWatchBusy = (realtimeSyncTick, transport.screenSharePopoutWatchBusy);
  $: localScreenShareStream = (realtimeSyncTick, transport.localScreenShareStream);
  $: pendingWebScreenShareStream = (realtimeSyncTick, transport.pendingWebScreenShareStream);
  $: nativeScreenShareSenderSession = (realtimeSyncTick, transport.nativeScreenShareSenderSession);
  $: nativeScreenShareSenderStatus = (realtimeSyncTick, transport.nativeScreenShareSenderStatus);
  $: localScreenSharePreviewRenderingEnabled = (realtimeSyncTick, transport.localScreenSharePreviewRenderingEnabled);
  $: nativeLocalScreenSharePreviewStream = (realtimeSyncTick, transport.nativeLocalScreenSharePreviewStream);
  $: nativeLocalScreenSharePreviewStarting = (realtimeSyncTick, transport.nativeLocalScreenSharePreviewStarting);
  $: nativeLocalScreenSharePreviewError = (realtimeSyncTick, transport.nativeLocalScreenSharePreviewError);
  const screenSharePopoutDrag = (node: HTMLElement) => transport.screenSharePopoutDrag(node);
  // Server rail domain lives in lib/server-rail.svelte.ts; workspace-core
  // state stays here and is injected below.
  const serverRail = new ServerRailController({
    savedServers: () => savedServers, setSavedServers: (next) => (savedServers = next), savedServersByID: () => serverRailSavedServersByID,
    storedCredential: () => storedCredential, setStoredCredential: (credential) => (storedCredential = credential),
    storedServerWriteQueue: () => storedServerWriteQueue, setStoredServerWriteQueue: (queue) => (storedServerWriteQueue = queue),
    activeServerId: () => activeServerId, setActiveServerId: (serverId) => (activeServerId = serverId),
    server: () => server, baseUrl: () => baseUrl, sessionToken: () => sessionToken, memberId: () => memberId, isOwner: () => isOwner,
    voiceConnectionContext: () => voiceConnectionContext,
    translate: (key, params) => t(key, params),
    setError: (message) => (error = message),
    setStatusKey: (key) => (statusKey = key),
    setConnectDialogOpen: (open) => (connectDialogOpen = open),
    setConnectError: (message) => (connectError = message),
    showAppAlert, showAppConfirm, showAppPrompt,
    closeServerMenu, closeChannelContextMenu: () => channelsController.closeChannelContextMenu(), closeMessageContextMenu,
    reconnectSavedServer: (savedServer) => workspace.reconnectSavedServer(savedServer), reconnectToServer, clearActiveServerWorkspace, disconnectVoiceConnection: (context, reportFailure) => voiceStage.disconnectVoiceConnection(context, reportFailure),
    saveActiveServerId,
    loadServers, loadCredential,
    saveCredential, saveServer,
    normalizeDevelopmentBaseUrl
  });
  $: serverRailDrag = (realtimeSyncTick, serverRail.drag);
  $: serverRailDragX = (realtimeSyncTick, serverRail.dragX);
  $: serverRailDragY = (realtimeSyncTick, serverRail.dragY);
  $: serverRailTooltip = (realtimeSyncTick, serverRail.tooltip);
  $: {
    savedServers;
    serverRail.syncLayoutToSavedServers();
  }
  // Channel registry, selection, CRUD, warnings, context menu, panel width,
  // and display helpers live in lib/channels.svelte.ts. Hooks reach back into
  // component state lazily (arrow closures), so construction order is safe.
  const channelsController = new ChannelsController({
    memberId: () => memberId,
    sessionToken: () => sessionToken,
    baseUrl: () => baseUrl,
    activeServerId: () => activeServerId,
    serverId: () => server?.server_id ?? "",
    serverDefaultLanguage: () => server?.default_language ?? "",
    translate: (key, params) => t(key, params),
    setError: (message) => (error = message),
    canManageChannels: () => canManageChannels,
    canManageChannelPermissions: () => canManageChannelPermissions,
    flushAliases: () => {
      realtimeSyncTick += 1;
    },
    closeMessageContextMenu,
    closeServerMenu,
    clearReplyTarget: () => composer.clearReplyTarget(),
    clearMessageSearch: () => composer.clearMessageSearch(),
    clearMessageSelection,
    clearFileView: () => channelFiles.clearFileView(),
    setChannelContentMode: (mode) => (channelContentMode = mode as typeof channelContentMode),
    setMessages: (items) => (messagesController.messages = items as ClientMessage[]),
    setHasOlderMessages: (value) => (messagesController.hasOlderMessages = value),
    setCurrentChannelNewMessageCount: (value) => (messagesController.currentChannelNewMessageCount = value),
    setCurrentChannelNewMessageStartId: (value) => (messagesController.currentChannelNewMessageStartId = value),
    setEditingMessageId: (value) => (messagesController.editingMessageId = value),
    setEditingMessageDraft: (value) => (messagesController.editingMessageDraft = value),
    clearComposerAttachmentObjectURLs: () => composer.clearComposerAttachmentObjectURLs(),
    clearMessageAttachmentObjectURLs: () => composer.clearMessageAttachmentObjectURLs(),
    setComposerAttachments: (attachments) => (composer.composerAttachments = attachments as ChannelFileEntry[]),
    clearChannelUnread: (channelId) => composer.clearChannelUnread(channelId),
    focusMemberAccessFilter: (channelId) => voiceStage.focusMemberAccessFilter(channelId),
    selectedChannelLoadingId: () => selectedChannelLoadingId,
    setSelectedChannelLoadingId: (value) => (selectedChannelLoadingId = value),
    pendingLocalMessagesForChannel: (channelId) => composer.pendingLocalMessagesForChannel(channelId),
    prepareMessageEmojiAssets: (messages) => prepareMessageEmojiAssets(messages as ClientMessage[]),
    restoreChannelReadPosition: (channelId) => composer.restoreChannelReadPosition(channelId),
    showVoiceChannelTip,
    closeVoiceChannelTip,
    isJoinedVoiceChannel: (channelId) => voiceStage.isJoinedVoiceChannel(channelId),
    suppressChannelClickUntil: () => suppressChannelClickUntil,
    setSuppressChannelClickUntil: (value) => (suppressChannelClickUntil = value),
    channelDragActive: () => Boolean(channelsController.channelDrag.sourceId),
    clearChannelPointerPress: () => (channelsController.channelPointerPress = null),
    voiceActionBusy: () => voiceActionBusy,
    prepareVoiceAudioPlayback: () => remoteVoiceMixer.preparePlayback(),
    toggleVoiceChannel: (channel) => voiceStage.toggleVoiceChannel(channel),
    closeVoiceParticipantContextMenu: () => voiceStage.closeVoiceParticipantContextMenu(),
    voiceConnectionNavigationBusy: () => voiceConnectionNavigationBusy,
    setVoiceConnectionNavigationBusy: (value) => (voiceConnectionNavigationBusy = value),
    voiceConnectionContext: () => voiceState.voiceConnectionContext,
    savedServerByID: (serverID) => serverRail.savedServerByID(serverID),
    reconnectSavedServer: (savedServer) => workspace.reconnectSavedServer(savedServer),
    workspaceReconnectRequired: () => workspaceReconnectRequired,
    serverSummary: () => server,
    currentVoiceState: () => voiceStage.currentVoiceState(),
    stopVoiceSession: (options) => nativeVoice.stopVoiceSession(options),
    filterVoiceStates: (predicate) => (voiceState.voiceStates = voiceState.voiceStates.filter(predicate)),
    showAppConfirm,
    roles: () => permissionsController.roles,
    languageOptions: () => languageOptions(),
    languagePackId: () => languagePack.id,
    setSelectedPermissionChannelId: (value) => (permissionsController.selectedPermissionChannelId = value),
    setChannelPermissionOverrides: (overrides) => (permissionsController.channelPermissionOverrides = overrides as ChannelPermissionOverride[]),
    setChannelPermissionDraftOverrides: (overrides) => (permissionsController.channelPermissionDraftOverrides = overrides as ChannelPermissionOverride[]),
    setChannelPermissionLoadedChannelId: (value) => (permissionsController.channelPermissionLoadedChannelId = value),
    setChannelPermissionTargetType: (value) => (permissionsController.channelPermissionTargetType = value),
    setChannelPermissionTargetId: (value) => (permissionsController.channelPermissionTargetId = value),
    setChannelPermissionTargets: (targets) => (permissionsController.channelPermissionTargets = targets as typeof channelPermissionTargets),
    setChannelPermissionTargetPickerOpen: (open) => (permissionsController.channelPermissionTargetPickerOpen = open),
    setChannelPermissionTargetMenuStyle: (style) => (permissionsController.channelPermissionTargetMenuStyle = style),
    setChannelPermissionSearch: (value) => (permissionsController.channelPermissionSearch = value),
    loadChannelPermissionOverrides: () => void loadChannelPermissionOverrides(),
    saveChannelPermissionChanges,
    cloneChannelPermissionOverrides: (overrides) => permissionsController.cloneChannelPermissionOverrides(overrides),
    rebuildChannelPermissionTargets,
    channelPermissionLoadedChannelId: () => permissionsController.channelPermissionLoadedChannelId,
    selectedPermissionChannelId: () => permissionsController.selectedPermissionChannelId,
    channelPermissionOverrides: () => permissionsController.channelPermissionOverrides,
    channelTopicTextareaElement: () => channelTopicTextareaElement,
    setSettingsSelectMenuOpen: (value) => (settingsSelectMenuOpen = value as typeof settingsSelectMenuOpen),
    screenShareSessions: () => screenShare.sessions,
    accompanimentSessions: () => accompaniment.sessions,
    removeScreenShareSession: (session) => screenShare.removeScreenShareSession(session),
    removeAccompanimentSession: (session) => accompaniment.removeSession(session),
    filterRemoteControlByChannelIds: (ids) => remoteControl.filterByChannelIds(ids),
    memberPanelWidth: () => layout.memberPanelWidth,
    closeVoiceNetworkDetails: () => audio.closeVoiceNetworkDetails(),
    closeSoundboardPopover,
    adjustComposerHeight: () => composer.adjustComposerHeight(),
    soundboardPopoverOpen: () => soundboard.popoverOpen,
    updateSoundboardPopoverPosition: () => void updateSoundboardPopoverPosition(),
    serverPreviewLanguageId: () => serverPreviewLanguageId,
    languagePack: () => languagePack
  });
  // Aliases refresh every realtimeSyncTick (100ms) — the legacy compiler does
  // not track $state reads through a non-reactive const binding.
  $: channels = (realtimeSyncTick, channelsController.channels);
  $: selectedChannelId = (realtimeSyncTick, channelsController.selectedChannelId);
  $: channelSettingsOpen = (realtimeSyncTick, channelsController.channelSettingsOpen);
  $: channelDraft = (realtimeSyncTick, channelsController.channelDraft);
  $: channelSettingsSaving = (realtimeSyncTick, channelsController.channelSettingsSaving);
  $: channelSettingsDirty = (realtimeSyncTick, channelsController.channelSettingsDirty);
  $: channelDetailsDirty = (realtimeSyncTick, channelsController.channelDetailsDirty);
  $: channelPermissionsDirty = (realtimeSyncTick, channelsController.channelPermissionsDirty);
  $: channelEditingId = (realtimeSyncTick, channelsController.channelEditingId);
  $: channelName = (realtimeSyncTick, channelsController.channelName);
  $: channelType = (realtimeSyncTick, channelsController.channelType);
  $: channelParentId = (realtimeSyncTick, channelsController.channelParentId);
  $: channelPanelWidth = (realtimeSyncTick, channelsController.channelPanelWidth);
  $: channelPanelResizing = (realtimeSyncTick, channelsController.channelPanelResizing);
  // Channel file management lives in lib/channel-files.svelte.ts. Message
  // attachment previews stay in this component and reuse the preview helpers
  // through the hooks below.
  const channelFiles = new ChannelFilesController({
    memberId: () => memberId,
    sessionToken: () => sessionToken,
    baseUrl: () => baseUrl,
    translate: (key, params) => t(key, params),
    setError: (message) => (error = message),
    setStatusKey: (key) => (statusKey = key),
    selectedChannelId: () => selectedChannelId,
    channelContentMode: () => channelContentMode,
    setChannelContentMode: (mode) => (channelContentMode = mode as typeof channelContentMode),
    fileStorageAvailable: () => fileStorageAvailable,
    canViewFiles: () => canViewFiles,
    canUploadFiles: () => canUploadFiles,
    canDownloadFiles: () => canDownloadFiles,
    canManageFiles: () => canManageFiles,
    nativeDesktopRuntime: () => nativeDesktopRuntime,
    fileInputElement: () => fileInputElement,
    setFileInputElement: (element) => (fileInputElement = element),
    showAppConfirm,
    showAppPrompt,
    messageAttachmentEntries: () => composer.messageAttachmentEntries,
    setMessageAttachmentEntries: (entries) => (composer.messageAttachmentEntries = entries),
    composerAttachmentObjectURLs: () => composer.composerAttachmentObjectURLs
  });
  // Message data layer lives in lib/messages.svelte.ts. Composer, reply UI,
  // edit editor, and message scrolling stay here and are reached through hooks.
  const messagesController = new MessagesController({
    memberId: () => memberId,
    sessionToken: () => sessionToken,
    baseUrl: () => baseUrl,
    selectedChannelId: () => selectedChannelId,
    translate: (key, params) => t(key, params),
    setError: (message) => (error = message),
    setStatusKey: (key) => (statusKey = key),
    showAppConfirm,
    canManageMessages: () => canManageMessages,
    currentStorageServerId: () => workspace.currentStorageServerId(),
    prepareMessageEmojiAssets: (items) => void prepareMessageEmojiAssets(items as Array<Pick<Message, "content">>),
    scrollMessagesToBottom: () => void composer.scrollMessagesToBottom(),
    messageListElement: () => messageListElement,
    languagePackId: () => languagePack.id,
    emojiObjectURL: (sha256) => emoji.objectURL(sha256),
    closeCreateChannelMenu: () => channelsController.closeCreateChannelMenu(),
    closeChannelContextMenu: () => channelsController.closeChannelContextMenu(),
    closeVoiceParticipantContextMenu: () => voiceStage.closeVoiceParticipantContextMenu(),
    closeServerMenu,
    closeVoiceNetworkDetails: () => audio.closeVoiceNetworkDetails(),
    cancelEditMessage: () => composer.cancelEditMessage(),
    clearReplyTarget: () => composer.clearReplyTarget(),
    memberDisplayName: (memberIdValue) => permissionsController.memberDisplayName(memberIdValue),
    beginEditMessage: (message) => composer.beginEditMessage(message),
    deleteSelectedMessage: (message) => composer.deleteSelectedMessage(message)
  });
  $: messages = (realtimeSyncTick, messagesController.messages);
  $: hasOlderMessages = (realtimeSyncTick, messagesController.hasOlderMessages);
  $: editingMessageId = (realtimeSyncTick, messagesController.editingMessageId);
  $: editingMessageDraft = (realtimeSyncTick, messagesController.editingMessageDraft);
  $: messageActionBusyId = (realtimeSyncTick, messagesController.messageActionBusyId);
  $: messageSearchQuery = (realtimeSyncTick, messagesController.messageSearchQuery);
  $: currentChannelNewMessageCount = (realtimeSyncTick, messagesController.currentChannelNewMessageCount);
  $: currentChannelNewMessageStartId = (realtimeSyncTick, messagesController.currentChannelNewMessageStartId);
  $: selectedMessageIds = (realtimeSyncTick, messagesController.selectedMessageIds);
  $: messageSelectionAnchorId = (realtimeSyncTick, messagesController.messageSelectionAnchorId);
  $: messageContextMenu = (realtimeSyncTick, messagesController.messageContextMenu);
  // Roles and channel permission overrides live in lib/permissions.svelte.ts.
  const permissionsController = new PermissionsController({
    memberId: () => memberId,
    sessionToken: () => sessionToken,
    baseUrl: () => baseUrl,
    translate: (key, params) => t(key, params),
    setError: (message) => (error = message),
    setStatusKey: (key) => (statusKey = key),
    canManageRoles: () => canManageRoles,
    canManageChannelPermissions: () => canManageChannelPermissions,
    canManageMembers: () => canManageMembers,
    isOwner: () => isOwner,
    currentMember: () => currentMember,
    localUserProfile: () => localUserProfile,
    members: () => members,
    setMembers: (next) => (members = next),
    memberById: (memberIdValue) => members.find((member) => member.member_id === memberIdValue),
    mergeMember: (member) => realtime.mergeMember(member),
    removeMember: (member) => realtime.removeMember(member),
    flushAliases: () => {
      realtimeSyncTick += 1;
    },
    channels: () => channelsController.channels,
    channelDraft: () => channelsController.channelDraft,
    setChannelDraft: (draft) => (channelsController.channelDraft = draft),
    channelSettingsSaving: () => channelsController.channelSettingsSaving,
    closeServerSettings,
    showAppConfirm,
    readFileAsDataURL: (file) => workspace.readFileAsDataURL(file),
    roleIconInputElement: () => roleIconInputElement,
    setRoleIconInputElement: (element) => (roleIconInputElement = element),
    channelPermissionTargetPickerElement: () => channelPermissionTargetPickerElement,
    setChannelPermissionTargetPickerElement: (element) => (channelPermissionTargetPickerElement = element),
    channelPermissionTargetMenuElement: () => channelPermissionTargetMenuElement,
    setChannelPermissionTargetMenuElement: (element) => (channelPermissionTargetMenuElement = element),
    permissionKeys: () => permissionKeys,
    channelOverridePermissionKeys: () => channelOverridePermissionKeys,
    permissionGroups: () => permissionGroups
  });
  $: roles = (realtimeSyncTick, permissionsController.roles);
  $: selectedRoleId = (realtimeSyncTick, permissionsController.selectedRoleId);
  $: roleDraft = (realtimeSyncTick, permissionsController.roleDraft);
  $: rolePreviewId = (realtimeSyncTick, permissionsController.rolePreviewId);
  $: selectedPermissionChannelId = (realtimeSyncTick, permissionsController.selectedPermissionChannelId);
  $: channelPermissionOverrides = (realtimeSyncTick, permissionsController.channelPermissionOverrides);
  $: channelPermissionDraftOverrides = (realtimeSyncTick, permissionsController.channelPermissionDraftOverrides);
  $: channelPermissionLoadedChannelId = (realtimeSyncTick, permissionsController.channelPermissionLoadedChannelId);
  $: channelPermissionTargetType = (realtimeSyncTick, permissionsController.channelPermissionTargetType);
  $: channelPermissionTargetId = (realtimeSyncTick, permissionsController.channelPermissionTargetId);
  $: channelPermissionTargets = (realtimeSyncTick, permissionsController.channelPermissionTargets);
  $: channelPermissionTargetMenuStyle = (realtimeSyncTick, permissionsController.channelPermissionTargetMenuStyle);
  $: channelPermissionSearch = (realtimeSyncTick, permissionsController.channelPermissionSearch);
  $: memberEditingId = (realtimeSyncTick, permissionsController.memberEditingId);
  $: memberBanDraft = (realtimeSyncTick, permissionsController.memberBanDraft);
  $: memberUpdating = (realtimeSyncTick, permissionsController.memberUpdating);
  $: memberRoleMenuId = (realtimeSyncTick, permissionsController.memberRoleMenuId);
  $: memberRoleMenuSearch = (realtimeSyncTick, permissionsController.memberRoleMenuSearch);
  $: identityMemberPickerOpen = (realtimeSyncTick, permissionsController.identityMemberPickerOpen);
  $: identityMemberPickerSearch = (realtimeSyncTick, permissionsController.identityMemberPickerSearch);
  $: identityLinkPrimaryMemberId = (realtimeSyncTick, permissionsController.identityLinkPrimaryMemberId);
  $: identityLinkDuplicateMemberId = (realtimeSyncTick, permissionsController.identityLinkDuplicateMemberId);
  $: identityLinkBusy = (realtimeSyncTick, permissionsController.identityLinkBusy);
  // Server settings, server profile, invites, and audit log live in
  // lib/server-settings.svelte.ts.
  const serverSettingsController = new ServerSettingsController({
    sessionToken: () => sessionToken,
    baseUrl: () => baseUrl,
    translate: (key, params) => t(key, params),
    setError: (message) => (error = message),
    setStatusKey: (key) => (statusKey = key),
    canEditServerSettings: () => canEditServerSettings,
    canCreateInvites: () => canCreateInvites,
    server: () => server,
    setServer: (next) => (server = next),
    currentMember: () => currentMember,
    mergeMember: (member) => realtime.mergeMember(member),
    localUserProfile: () => localUserProfile,
    setLocalUserProfile: (profile) => (localUserProfile = profile),
    appSettingsOpen: () => appSettingsOpen,
    setAppSettingsOpen: (open) => (appSettingsOpen = open),
    stopMicrophoneTest: () => void audio.stopMicrophoneTest(),
    closeServerMenu,
    closeVoiceParticipantContextMenu: () => voiceStage.closeVoiceParticipantContextMenu(),
    openServerDetails,
    setServerDetailsOpen: (open) => (serverDetailsOpen = open),
    ensureSelectedRole,
    loadServerEmojiManagement: () => void loadServerEmojiManagement(),
    loadServerSoundboardManagement: () => void loadServerSoundboardManagement(),
    clearServerEmojiUpload,
    cancelServerEmojiEdit,
    closeSoundboardEditor,
    setEmojiManagementError: (message) => (emojiManagementError = message),
    memberDisplayName: (memberIdValue) => permissionsController.memberDisplayName(memberIdValue),
    refreshMemberMergeRequests: (prompt) => void workspace.refreshMemberMergeRequests(prompt),
    memberMergeCodeServerID: () => memberMergeCodeServerID,
    setMemberMergeCode: (value) => (memberMergeCode = value),
    setMemberMergeCodeExpiresAtMS: (value) => (memberMergeCodeExpiresAtMS = value),
    setMemberMergeCodeServerID: (value) => (memberMergeCodeServerID = value),
    syncSavedServerSummary: (summary) => serverRail.syncSavedServerSummary(summary),
    showAppAlert,
    closeSettingsSelectMenu: () => (settingsSelectMenuOpen = null)
  });
  $: serverSettingsOpen = (realtimeSyncTick, serverSettingsController.serverSettingsOpen);
  $: serverSettingsTab = (realtimeSyncTick, serverSettingsController.serverSettingsTab);
  $: serverDraft = (realtimeSyncTick, serverSettingsController.serverDraft);
  $: serverPreviewLanguageId = (realtimeSyncTick, serverSettingsController.serverPreviewLanguageId);
  $: serverIconCropSource = (realtimeSyncTick, serverSettingsController.serverIconCropSource);
  $: serverProfileSettingsOpen = (realtimeSyncTick, serverSettingsController.serverProfileSettingsOpen);
  $: serverProfileDraft = (realtimeSyncTick, serverSettingsController.serverProfileDraft);
  $: serverProfileBaseline = (realtimeSyncTick, serverSettingsController.serverProfileBaseline);
  $: serverProfileOverridesDraft = (realtimeSyncTick, serverSettingsController.serverProfileOverridesDraft);
  $: serverProfileOverridesBaseline = (realtimeSyncTick, serverSettingsController.serverProfileOverridesBaseline);
  $: serverProfileSaveMessage = (realtimeSyncTick, serverSettingsController.serverProfileSaveMessage);
  $: serverProfileAvatarCropSource = (realtimeSyncTick, serverSettingsController.serverProfileAvatarCropSource);
  $: serverInvites = (realtimeSyncTick, serverSettingsController.serverInvites);
  $: inviteExpiresInSeconds = (realtimeSyncTick, serverSettingsController.inviteExpiresInSeconds);
  $: inviteMaxUses = (realtimeSyncTick, serverSettingsController.inviteMaxUses);
  $: inviteActionBusy = (realtimeSyncTick, serverSettingsController.inviteActionBusy);
  $: copiedInviteId = (realtimeSyncTick, serverSettingsController.copiedInviteId);
  $: auditLogs = (realtimeSyncTick, serverSettingsController.auditLogs);
  $: auditLogsLoading = (realtimeSyncTick, serverSettingsController.auditLogsLoading);
  $: auditActionFilter = (realtimeSyncTick, serverSettingsController.auditActionFilter);
  // Soundboard domain lives in lib/soundboard.svelte.ts. Aliases feed templates
  // and the emoji picker; hot paths and mutations read/write the controller.
  const soundboard = new SoundboardController({
    server: () => server,
    baseUrl: () => baseUrl,
    sessionToken: () => sessionToken,
    savedServers: () => savedServers,
    currentVoiceState: () => voiceStage.currentVoiceState(),
    canPlaySoundboard: () => canPlaySoundboard,
    canManageServerSoundboard: () => canManageServerSoundboard,
    audioDeafened: () => audio.audioDeafened,
    selectedAudioOutputDeviceId: () => audio.selectedAudioOutputDeviceId,
    outputVolumePercent: () => audio.outputVolumePercent,
    accompanimentActionBusy: () => accompaniment.actionBusy,
    setAccompanimentDialogOpen: (open) => accompaniment.setDialogOpen(open),
    translate: (key, params) => t(key, params),
    setError: (message) => (error = message),
    customEmojis: () => emoji.customEmojis,
    serverEmojiLibraries: () => emoji.serverLibraries,
    openEmojiPicker: (anchor, purpose) => emoji.openPicker(anchor, purpose),
    closeEmojiPicker: () => emoji.closePicker(),
    emojiPickerPurpose: () => emoji.pickerPurpose,
    loadEmojiSourceSession: (serverID) => emoji.loadSourceSession(serverID),
    ensureEmojiAsset: (item, allowDownload, originServerID) => emoji.ensureAsset(item, allowDownload, originServerID),
    refreshSavedServerEmojiLibraries: () => emoji.refreshSavedLibraries(),
    setAudioElementSink: (audio) => audio.setAudioElementSink(audio),
    popoverAnchor: () => soundboardPopoverAnchor,
    popoverElement: () => soundboardPopoverElement,
    localInputElement: () => soundboardLocalInputElement,
    serverInputElement: () => soundboardServerInputElement,
    managerInputElement: () => serverSoundboardManagerInputElement,
    tab: () => soundboardTab,
    setTab: (value) => (soundboardTab = value),
    sourceServerID: () => soundboardSourceServerID,
    setSourceServerID: (value) => (soundboardSourceServerID = value),
    editorDurationMS: () => soundboardEditorDurationMS,
    setEditorDurationMS: (value) => (soundboardEditorDurationMS = value),
    editorName: () => soundboardEditorName,
    setEditorName: (value) => (soundboardEditorName = value)
  });
  $: soundboardEditorTarget = (realtimeSyncTick, soundboard.editorTarget);
  // Emoji domain lives in lib/emoji.svelte.ts (EmojiController). The existing
  // template still writes a few values directly and reads legacy aliases, so the
  // component keeps those bindings and routes every mutation through the
  // controller. Hot paths may also read the controller fields directly.
  let emojiSearchQuery = "";
  let emojiPickerHoveredEntry: EmojiPickerEntry | null = null;
  let emojiAutocompleteSelectedIndex = 0;
  let serverEmojiEditingShortcode = "";
  let emojiAddID = "";
  let emojiPickerAnchorElement: HTMLButtonElement | null = null;
  let emojiPickerElement: HTMLDivElement | null = null;
  let emojiPickerSearchInputElement: HTMLInputElement | null = null;
  let serverEmojiManagerInputElement: HTMLInputElement | null = null;
  let emojiAddInputElement: HTMLInputElement | null = null;
  let serverEmojiUploadErrorValue = "";
  const emoji = new EmojiController({
    server: () => server,
    baseUrl: () => baseUrl,
    sessionToken: () => sessionToken,
    savedServers: () => savedServers,
    localUserProfile: () => localUserProfile,
    canSendEmoji: () => canSendEmoji,
    canManageServerEmoji: () => canManageServerEmoji,
    translate: (key, params) => t(key, params),
    setError: (message) => (error = message),
    soundboardEditorTarget: () => soundboard.editorTarget,
    soundboardSelectDefaultIcon: (value) => selectSoundboardDefaultIcon(value),
    soundboardSelectCustomIcon: (item, originServerID) => selectSoundboardCustomIcon(item, originServerID),
    composerEditorElement: () => composerEditorElement,
    composerSelectionRange: () => composer.composerSelectionRange(),
    composerSelectionOffsets: () => composer.composerSelectionOffsets(),
    composerInputComposing: () => composer.composerInputComposing,
    composerInputShellElement: () => composerInputShellElement,
    replaceComposerRange: (start, end, content) => composer.replaceComposerRange(start, end, content),
    renderComposerEditor: (content) => composer.renderComposerEditor(content),
    renderMessageEditEditor: (content) => composer.renderMessageEditEditor(content),
    editingMessageId: () => editingMessageId,
    editingMessageDraft: () => editingMessageDraft,
    draft: () => composer.draft,
    selectedChannelId: () => selectedChannelId,
    canSendMessages: () => canSendMessages,
    showAppConfirm,
    showAppPrompt,
    formatFileSize: (bytes) => channelFiles.formatFileSize(bytes),
    pickerAnchor: () => emojiPickerAnchorElement,
    setPickerAnchor: (element) => (emojiPickerAnchorElement = element),
    pickerElement: () => emojiPickerElement,
    setPickerElement: (element) => (emojiPickerElement = element),
    pickerSearchInputElement: () => emojiPickerSearchInputElement,
    setPickerSearchInputElement: (element) => (emojiPickerSearchInputElement = element),
    serverManagerInputElement: () => serverEmojiManagerInputElement,
    setServerManagerInputElement: (element) => (serverEmojiManagerInputElement = element),
    addInputElement: () => emojiAddInputElement,
    setAddInputElement: (element) => (emojiAddInputElement = element),
    searchQuery: () => emojiSearchQuery,
    setSearchQuery: (value) => (emojiSearchQuery = value),
    hoveredEntry: () => emojiPickerHoveredEntry,
    setHoveredEntry: (entry) => (emojiPickerHoveredEntry = entry),
    serverEditingShortcode: () => serverEmojiEditingShortcode,
    setServerEditingShortcode: (value) => (serverEmojiEditingShortcode = value),
    addID: () => emojiAddID,
    setAddID: (value) => (emojiAddID = value),
    autocompleteSelectedIndex: () => emojiAutocompleteSelectedIndex,
    setAutocompleteSelectedIndex: (value) => (emojiAutocompleteSelectedIndex = value),
    flushAliases: () => {
      realtimeSyncTick += 1;
    }
  });
  // Chat composer, reply/edit editor, message scrolling, and per-channel
  // unread/read state live in lib/composer.svelte.ts. Hooks reach back into
  // component state lazily; DOM refs and permission aliases stay here.
  // Template aliases for composer $state fields are declared after this
  // constructor and refresh every realtimeSyncTick like the other aliases.
  const composer = new ChatComposerController({
    server: () => server,
    baseUrl: () => baseUrl,
    sessionToken: () => sessionToken,
    memberId: () => memberId,
    selectedChannelId: () => selectedChannelId,
    canSendMessages: () => canSendMessages,
    canManageMessages: () => canManageMessages,
    canDownloadFiles: () => canDownloadFiles,
    canUploadFiles: () => canUploadFiles,
    canViewFiles: () => canViewFiles,
    fileStorageAvailable: () => fileStorageAvailable,
    translate: (key, params) => t(key, params),
    setError: (message) => (error = message),
    setStatusKey: (key) => (statusKey = key),
    currentStorageServerId: () => workspace.currentStorageServerId(),
    showAppConfirm,
    messagesController: () => messagesController,
    channelFiles: () => channelFiles,
    emoji: () => emoji,
    messageListElement: () => messageListElement,
    composerEditorElement: () => composerEditorElement,
    composerInputShellElement: () => composerInputShellElement,
    composerAttachmentInputElement: () => composerAttachmentInputElement,
    messageEditEditorElement: () => messageEditEditorElement,
    setMessageEditEditorElement: (element) => (messageEditEditorElement = element),
    ensureMessageImagePreview,
    emojiAutocompleteSelectedIndex: () => emojiAutocompleteSelectedIndex,
    flushAliases: () => {
      realtimeSyncTick += 1;
    }
  });
  // Legacy template aliases for composer-owned $state. Svelte does not track
  // $state reads through a non-reactive const binding, so these refresh on
  // realtimeSyncTick like every other controller alias in this component.
  $: draft = (realtimeSyncTick, composer.draft);
  $: composerInputComposing = (realtimeSyncTick, composer.composerInputComposing);
  $: composerAttachments = (realtimeSyncTick, composer.composerAttachments);
  $: composerAttachmentObjectURLs = (realtimeSyncTick, composer.composerAttachmentObjectURLs);
  $: messageAttachmentObjectURLs = (realtimeSyncTick, composer.messageAttachmentObjectURLs);
  $: messageAttachmentEntries = (realtimeSyncTick, composer.messageAttachmentEntries);
  $: messageAttachmentLoadingIds = (realtimeSyncTick, composer.messageAttachmentLoadingIds);
  $: messageAttachmentErrorIds = (realtimeSyncTick, composer.messageAttachmentErrorIds);
  // Layout controller owns member panel width, user status panel height, and
  // the resize orchestration. Channel panel width stays in ChannelsController
  // and is proxied through `layout` so the shell has one layout surface.
  layout = new LayoutController({
    channelsController,
    screenShareSetup,
    adjustComposerHeight: () => composer.adjustComposerHeight(),
    closeServerMenu: () => closeServerMenu(),
    closeCreateChannelMenu: () => channelsController.closeCreateChannelMenu(),
    closeChannelContextMenu: () => channelsController.closeChannelContextMenu(),
    closeVoiceNetworkDetails: () => audio.closeVoiceNetworkDetails(),
    closeSoundboardPopover: () => closeSoundboardPopover(),
    soundboardPopoverOpen: () => soundboard.popoverOpen,
    updateSoundboardPopoverPosition: () => updateSoundboardPopoverPosition(),
    accompanimentVolumePopoverOpen: () => accompaniment.volumePopoverOpen,
    updateAccompanimentVolumePopoverPosition: () => updateAccompanimentVolumePopoverPosition(),
    emojiPickerOpen: () => emoji.pickerOpen,
    updateEmojiPickerPosition: () => updateEmojiPickerPosition(),
    channelPermissionTargetPickerOpen: () => permissionsController.channelPermissionTargetPickerOpen,
    updateChannelPermissionTargetMenuPosition: () => updateChannelPermissionTargetMenuPosition(),
    screenShareViewerPanelShareId: () => transport.screenShareViewerPanelShareId,
    updateScreenShareViewerPanelPosition: () => transport.updateScreenShareViewerPanelPosition()
  });
  $: memberPanelWidth = (realtimeSyncTick, layout.memberPanelWidth);
  $: memberPanelResizing = (realtimeSyncTick, layout.memberPanelResizing);
  $: userStatusPanelHeight = (realtimeSyncTick, layout.userStatusPanelHeight);
  // ---------------------------------------------------------------------------
  // Realtime domain lives in lib/realtime.svelte.ts. The controller owns the
  // workspace/voice sockets, heartbeats, recovery, refresh loops, server-event
  // dispatch, and the native local screen-share preview transport. All cross-
  // domain side effects are injected below as lazy hooks.
  // ---------------------------------------------------------------------------
  const realtime = new RealtimeController({
    activeServerId: () => activeServerId,
    memberId: () => memberId,
    baseUrl: () => baseUrl,
    sessionToken: () => sessionToken,
    server: () => server,
    setServer: (next) => (server = next),
    storedCredential: () => storedCredential,
    setStoredCredential: (credential) => (storedCredential = credential),
    localUserProfile: () => localUserProfile,
    setLocalUserProfile: (profile) => (localUserProfile = profile),
    setProfileDraft: (profile) => (profileDraft = { ...profile }),
    setDisplayName: (name) => (displayName = name),
    setMemberId: (next) => (memberId = next),
    setSessionToken: (token) => (sessionToken = token),
    setIsOwner: (owner) => (isOwner = owner),
    setServerReportedClientUpdateRequired: (value) => (serverReportedClientUpdateRequired = value),
    error: () => error,
    setError: (message) => (error = message),
    setStatusKey: (key) => (statusKey = key),
    translate: (key, params) => t(key, params),
    connectionFailureMessage: (caught, signal?) => workspace.connectionFailureMessage(caught, signal?),
    showWorkspaceReconnect,
    workspaceReconnectRequired: () => workspaceReconnectRequired,
    setWorkspaceReconnectRequired: (value) => (workspaceReconnectRequired = value),
    setWorkspaceReconnectBusy: (value) => (workspaceReconnectBusy = value),
    setWorkspaceConnectionError: (message) => (workspaceConnectionError = message),
    normalizeStoredCredential: (credential) => serverRail.normalizeStoredCredential(credential),
    reconnectToServer,
    savedServers: () => savedServers,
    setSavedServers: (servers) => (savedServers = servers),
    flushAliases: () => {
      realtimeSyncTick += 1;
    },
    voiceState: () => voiceState,
    currentVoiceState: () => voiceStage.currentVoiceState(),
    localVoiceStream: () => voiceSession.localVoiceStream,
    nativeVoiceSession: () => nativeVoice.nativeVoiceSession,
    micMuted: () => audio.micMuted,
    audioDeafened: () => audio.audioDeafened,
    voiceInputUnavailable: () => audio.voiceInputUnavailable,
    isSpeaking: () => audio.isSpeaking,
    voiceActionBusy: () => voiceActionBusy,
    voiceConnectionStatus: () => voiceSession.connectionStatus,
    ensureCurrentVoiceTransport: (state, restart, forceInitiate) => nativeVoice.ensureCurrentVoiceTransport(state, restart, forceInitiate),
    ensureVoicePeer: (targetState, initiate) => nativeVoice.ensureVoicePeer(targetState, initiate),
    connectVoicePeers: (channelId, forceInitiate) => nativeVoice.connectVoicePeers(channelId, forceInitiate),
    joinVoiceRoom: (channelId, options = {}) => voiceStage.joinVoiceRoom(channelId, options),
    applyMemberVolume: (targetMemberId) => audio.applyMemberVolume(targetMemberId),
    closePeerConnection: (participantIDToClose, memberIDToClose) => nativeVoice.closePeerConnection(participantIDToClose, memberIDToClose),
    voiceTransportActive: () => nativeVoice.voiceTransportActive(),
    resumeRemoteAudioPlayback: () => remoteVoiceMixer.resumeAll(),
    resumeSuspendedVoiceInputContexts: () => voiceSession.resumeSuspendedInputContexts(),
    playUISound: (name) => audio.playUISound(name),
    showAppAlert,
    bumpVoiceMoveSoundGeneration: () => (localVoiceMoveSoundGeneration += 1),
    voiceMoveSoundGeneration: () => localVoiceMoveSoundGeneration,
    enqueueVoiceSignal: (signal) => voiceSession.enqueueSignal(signal),
    screenShareSessions: () => screenShare.sessions,
    remoteControlSessions: () => remoteControl.sessions,
    focusedScreenShareId: () => screenShare.focusedScreenShareId,
    screenShareRefreshSessions: () => screenShare.refreshScreenShareSessions(),
    screenShareEnqueueSignal: (signal) => screenShare.enqueueSignal(signal),
    screenShareIsDuplicateMediaSignal: (signal) => screenShare.isDuplicateMediaSignal(signal),
    screenShareMergeSession: (session) => screenShare.mergeScreenShareSession(session),
    screenShareReplaceSessions: (sessions) => screenShare.replaceScreenShareSessions(sessions),
    screenShareRemoveSession: (session) => screenShare.removeScreenShareSession(session),
    screenShareWatcherSessionIds: () => screenShare.watcherSessionIds,
    syncViewerScreenShareSignalPolling: () => transport.syncViewerScreenShareSignalPolling(),
    flushPendingVoiceOutboundSignals: () => nativeVoice.flushPendingVoiceOutboundSignals(),
    flushPendingMessages: () => messagesController.flushPendingMessages(),
    refreshCurrentChannelMessages: () => messagesController.refreshCurrentChannelMessages(),
    recoverScreenShareWatchesAfterReconnect: () => transport.recoverScreenShareWatchesAfterReconnect(),
    remoteControlRefreshSessions: () => remoteControl.refreshSessions(),
    remoteControlHeartbeatActive: () => remoteControl.heartbeatActive(),
    remoteControlMergeSession: (control) => remoteControl.mergeSession(control),
    remoteControlHandleInput: (input) => remoteControl.handleInput(input),
    accompanimentRefreshSessions: () => accompaniment.refreshSessions(),
    accompanimentMergeSession: (session) => accompaniment.mergeSession(session),
    accompanimentRemoveSession: (session) => accompaniment.removeSession(session),
    accompanimentResumeAfterBrowserReturn: () => accompaniment.resumeAfterBrowserReturn(),
    channels: () => channelsController.channels,
    isVoiceChannel: (channel) => channelsController.isVoiceChannel(channel),
    mergeChannel: (channel) => channelsController.mergeChannel(channel),
    applyVisibleChannelSnapshot: (channelsValue) => channelsController.applyVisibleChannelSnapshot(channelsValue),
    removeChannel: (channel) => channelsController.removeChannel(channel),
    selectedChannelId: () => channelsController.selectedChannelId,
    members: () => members,
    setMembers: (next) => (members = next),
    mergeMessage: (message) => messagesController.mergeMessage(message),
    mergeMessages: (messagesValue) => messagesController.mergeMessages(messagesValue),
    removeMessage: (message) => messagesController.removeMessage(message),
    currentChannelNewMessageCount: () => messagesController.currentChannelNewMessageCount,
    setCurrentChannelNewMessageCount: (count) => (messagesController.currentChannelNewMessageCount = count),
    currentChannelNewMessageStartId: () => messagesController.currentChannelNewMessageStartId,
    setCurrentChannelNewMessageStartId: (messageId) => (messagesController.currentChannelNewMessageStartId = messageId),
    isMessageListNearBottom: () => composer.isMessageListNearBottom(),
    scrollMessagesToBottom: () => composer.scrollMessagesToBottom(),
    incrementUnread: (channelId) => composer.incrementUnread(channelId),
    mergeFileEntry: (entry) => channelFiles.mergeFileEntry(entry),
    removeFileEntry: (entry) => channelFiles.removeFileEntry(entry),
    selectedPermissionChannelId: () => permissionsController.selectedPermissionChannelId,
    mergeChannelPermissionOverride: (override) => permissionsController.mergeChannelPermissionOverride(override),
    removeChannelPermissionOverride: (override) => permissionsController.removeChannelPermissionOverride(override),
    mergeRole: (role) => permissionsController.mergeRole(role),
    removeRole: (role) => permissionsController.removeRole(role),
    sortRoles: (rolesValue) => permissionsController.sortRoles(rolesValue),
    replaceRoles: (rolesValue) => (permissionsController.roles = rolesValue),
    ensureSelectedRole: () => permissionsController.ensureSelectedRole(),
    channelContentMode: () => channelContentMode,
    clearFileView: () => channelFiles.clearFileView(),
    renderComposerEditor: (content) => composer.renderComposerEditor(content),
    composerDraft: () => composer.draft,
    serverSettingsOpen: () => serverSettingsController.serverSettingsOpen,
    serverSettingsTab: () => serverSettingsController.serverSettingsTab,
    serverSettingsDirty: () => serverSettingsDirty,
    setServerSettingsDraft: (draftValue) => (serverSettingsController.serverDraft = draftValue),
    syncSavedServerSummary: (summary) => serverRail.syncSavedServerSummary(summary),
    memberMergeIncoming: () => memberMergeIncoming,
    setMemberMergeIncoming: (requests) => (memberMergeIncoming = requests),
    memberMergeOutgoing: () => memberMergeOutgoing,
    setMemberMergeOutgoing: (requests) => (memberMergeOutgoing = requests),
    memberMergePromptRequestID: () => memberMergePromptRequestID,
    setMemberMergePromptResolvedExternally: (value) => (memberMergePromptResolvedExternally = value),
    appDialogHasMemberCard: () => Boolean(appDialog?.memberCard),
    settleAppDialog,
    mergeMemberMergeRequest: (items, request) => workspace.mergeMemberMergeRequest(items, request),
    processNextMemberMergePrompt: () => workspace.processNextMemberMergePrompt(),
    soundboardHandleServerDisabled: () => soundboard.handleServerSoundboardDisabled(),
    soundboardMergeItem: (item) => soundboard.mergeItem(item),
    soundboardRemoveItem: (item) => soundboard.removeItem(item),
    soundboardHandlePlayback: (playback) => soundboard.handlePlayback(playback),
    emojiHandleServerDisabled: () => emoji.handleServerEmojiDisabled(),
    emojiRefreshItems: (downloadLarge) => emoji.refreshItems(downloadLarge),
    emojiSyncCurrentLibrary: () => emoji.syncCurrentLibrary(),
    emojiMergeItem: (item) => emoji.mergeItem(item),
    emojiRemoveItem: (item) => emoji.removeItem(item),
    nativeDesktopRuntime: () => nativeDesktopRuntime,
    localScreenSharePreviewRenderingEnabled: () => transport.localScreenSharePreviewRenderingEnabled,
    setLocalScreenSharePreviewRenderingEnabled: (enabled) => (transport.localScreenSharePreviewRenderingEnabled = enabled),
    localScreenShareVideoElement: () => localScreenShareVideoElement,
    focusedScreenShareVideoElement: () => focusedScreenShareVideoElement,
    nativeScreenShareSenderSession: () => transport.nativeScreenShareSenderSession,
    nativeLocalScreenSharePreviewRequested: () => transport.nativeLocalScreenSharePreviewRequested,
    setNativeLocalScreenSharePreviewRequested: (value) => (transport.nativeLocalScreenSharePreviewRequested = value),
    nativeLocalScreenSharePreviewStarting: () => transport.nativeLocalScreenSharePreviewStarting,
    setNativeLocalScreenSharePreviewStarting: (value) => (transport.nativeLocalScreenSharePreviewStarting = value),
    nativeLocalScreenSharePreviewError: () => transport.nativeLocalScreenSharePreviewError,
    setNativeLocalScreenSharePreviewError: (message) => (transport.nativeLocalScreenSharePreviewError = message),
    nativeLocalScreenSharePreviewSessionId: () => transport.nativeLocalScreenSharePreviewSessionId,
    setNativeLocalScreenSharePreviewSessionId: (sessionId) => (transport.nativeLocalScreenSharePreviewSessionId = sessionId),
    nativeLocalScreenSharePreviewWatchSessionId: () => transport.nativeLocalScreenSharePreviewWatchSessionId,
    setNativeLocalScreenSharePreviewWatchSessionId: (watchSessionId) => (transport.nativeLocalScreenSharePreviewWatchSessionId = watchSessionId),
    nativeLocalScreenSharePreviewGeneration: () => transport.nativeLocalScreenSharePreviewGeneration,
    setNativeLocalScreenSharePreviewGeneration: (generation) => (transport.nativeLocalScreenSharePreviewGeneration = generation),
    nativeLocalScreenSharePreviewConnection: () => transport.nativeLocalScreenSharePreviewConnection,
    setNativeLocalScreenSharePreviewConnection: (connection) => (transport.nativeLocalScreenSharePreviewConnection = connection),
    nativeLocalScreenSharePreviewStream: () => transport.nativeLocalScreenSharePreviewStream,
    setNativeLocalScreenSharePreviewStream: (stream) => (transport.nativeLocalScreenSharePreviewStream = stream),
    pendingNativeLocalScreenSharePreviewCandidates: () => transport.pendingNativeLocalScreenSharePreviewCandidates,
    setPendingNativeLocalScreenSharePreviewCandidates: (candidates) => (transport.pendingNativeLocalScreenSharePreviewCandidates = candidates),
    nativeScreenSharePreviewSyncGeneration: () => transport.nativeScreenSharePreviewSyncGeneration,
    setNativeScreenSharePreviewSyncGeneration: (generation) => (transport.nativeScreenSharePreviewSyncGeneration = generation),
    nativeScreenSharePreviewSyncTail: () => transport.nativeScreenSharePreviewSyncTail,
    setNativeScreenSharePreviewSyncTail: (tail) => (transport.nativeScreenSharePreviewSyncTail = tail),
    nativeScreenShareStatusRefreshError: () => transport.nativeScreenShareStatusRefreshError,
    setNativeScreenShareStatusRefreshError: (message) => (transport.nativeScreenShareStatusRefreshError = message),
    nativeScreenShareSenderStatus: () => transport.nativeScreenShareSenderStatus,
    setNativeScreenShareSenderStatus: (status) => (transport.nativeScreenShareSenderStatus = status),
    nativeScreenShareRegisteredViewerIds: () => transport.nativeScreenShareRegisteredViewerIds,
    setNativeScreenShareRegisteredViewerIds: (ids) => (transport.nativeScreenShareRegisteredViewerIds = ids),
    nativeScreenShareAppliedAnswerMemberIds: () => transport.nativeScreenShareAppliedAnswerMemberIds,
    setNativeScreenShareAppliedAnswerMemberIds: (ids) => (transport.nativeScreenShareAppliedAnswerMemberIds = ids),
    applyNativeScreenShareSenderStatus: (value) => transport.applyNativeScreenShareSenderStatus(value),
    configureScreenShareReceiver: (receiver) => transport.configureScreenShareReceiver(receiver),
    browserRTCConfiguration,
    forwardNativeScreenShareSenderSignals: (sessionId) => transport.forwardNativeScreenShareSenderSignals(sessionId),
    scheduleNativeScreenShareSignalFlush: (sessionId) => transport.scheduleNativeScreenShareSignalFlush(sessionId),
    screenShareDataWatchSessionId: (data) => transport.screenShareDataWatchSessionId(data)
  });
  $: eventSocket = (realtimeSyncTick, realtime.eventSocket);
  $: eventConnectionStatus = (realtimeSyncTick, realtime.eventConnectionStatus);
  // Voice stage join/leave orchestration and member-panel view models live in
  // VoiceStageController. Constructed after the transport/audio controllers it
  // delegates to; hooks stay lazy until used.
  const voiceStage = new VoiceStageController({
    memberId: () => memberId,
    sessionToken: () => sessionToken,
    baseUrl: () => baseUrl,
    activeServerId: () => activeServerId,
    server: () => server,
    activeSavedServerValue: () => activeSavedServerValue,
    nativeDesktopRuntime: () => nativeDesktopRuntime,
    localUserProfile: () => localUserProfile,
    rtcIceServers: () => rtcIceServers,
    channels: () => channelsController.channels,
    members: () => members,
    roles: () => permissionsController.roles,
    languagePackId: () => languagePack.id,
    voiceStates: () => voiceStates,
    voiceStatesByMember: () => voiceStatesByMember,
    voiceConnectionContext: () => voiceConnectionContext,
    voiceState: () => voiceState,
    voiceSession: () => voiceSession,
    audio: () => audio,
    realtime: () => realtime,
    channelsController: () => channelsController,
    permissionsController: () => permissionsController,
    screenShareSetup: () => screenShareSetup,
    translate: (key, params) => t(key, params),
    setError: (message) => (error = message),
    showAppConfirm,
    abortableRequestWithTimeout: (request, timeoutMS, message) => transport.abortableRequestWithTimeout(request, timeoutMS, message),
    prepareVoiceAudioPlayback: () => remoteVoiceMixer.preparePlayback(),
    applyLocalVoiceFlags: (state) => audio.applyLocalVoiceFlags(state),
    syncCurrentVoiceState: () => audio.syncCurrentVoiceState(),
    startVoiceSession: (channelId, retryMissingNativeSession = true, forceInitiatePeers = false) => nativeVoice.startVoiceSession(channelId, retryMissingNativeSession, forceInitiatePeers),
    stopVoiceSession: (options) => nativeVoice.stopVoiceSession(options),
    closePeerConnection: (participantIDToClose, memberIDToClose) => nativeVoice.closePeerConnection(participantIDToClose, memberIDToClose),
    releaseLocalScreenShareTransport: (share?) => screenShareSetup.releaseLocalTransport(share?),
    playUISound: (name) => audio.playUISound(name),
    voiceActionBusy: () => voiceActionBusy,
    setVoiceActionBusy: (busy) => (voiceActionBusy = busy),
    memberSearchInputElement: () => memberSearchInputElement,
    flushAliases: () => {
      realtimeSyncTick += 1;
    },
    screenSharePopoutMode: () => screenSharePopoutMode,
    eventTargetElement,
    canMuteVoiceMembers: () => canMuteVoiceMembers,
    canDeafenVoiceMembers: () => canDeafenVoiceMembers,
    canMoveVoiceMembers: () => canMoveVoiceMembers,
    memberUpdating: () => memberUpdating,
    voiceManageBusyMemberId: () => voiceManageBusyMemberId,
    setVoiceManageBusyMemberId: (memberIdValue) => (voiceManageBusyMemberId = memberIdValue),
    canManageMembers: () => canManageMembers,
    setStatusKey: (key) => (statusKey = key),
    setMemberUpdating: (updating) => (memberUpdating = updating),
    closeCreateChannelMenu: () => channelsController.closeCreateChannelMenu(),
    closeChannelContextMenu: () => channelsController.closeChannelContextMenu(),
    closeMessageContextMenu,
    closeServerMenu,
    closeVoiceNetworkDetails: () => audio.closeVoiceNetworkDetails()
  });
  $: memberSearchOpen = (realtimeSyncTick, voiceStage.memberSearchOpen);
  $: memberSearchQuery = (realtimeSyncTick, voiceStage.memberSearchQuery);
  $: memberAccessFilterChannelId = (realtimeSyncTick, voiceStage.memberAccessFilterChannelId);
  $: memberAccessFilterMemberIds = (realtimeSyncTick, voiceStage.memberAccessFilterMemberIds);
  $: memberAccessFilterLoading = (realtimeSyncTick, voiceStage.memberAccessFilterLoading);
  $: voiceParticipantContextMenu = (realtimeSyncTick, voiceStage.voiceParticipantContextMenu);
  $: selectedVoiceParticipantIds = (realtimeSyncTick, voiceStage.selectedVoiceParticipantIds);
  $: voiceParticipantSelectionAnchorId = (realtimeSyncTick, voiceStage.voiceParticipantSelectionAnchorId);
  $: voiceParticipantDurationStats = (realtimeSyncTick, voiceStage.voiceParticipantDurationStats);
  $: voiceParticipantDurationLoading = (realtimeSyncTick, voiceStage.voiceParticipantDurationLoading);
  $: voiceParticipantDurationError = (realtimeSyncTick, voiceStage.voiceParticipantDurationError);
  $: voiceParticipantDragMemberId = (realtimeSyncTick, voiceStage.voiceParticipantDragMemberId);
  $: voiceParticipantDragParticipantId = (realtimeSyncTick, voiceStage.voiceParticipantDragParticipantId);
  $: voiceParticipantDragOverChannelId = (realtimeSyncTick, voiceStage.voiceParticipantDragOverChannelId);
  $: voiceParticipantDragX = (realtimeSyncTick, voiceStage.voiceParticipantDragX);
  $: voiceParticipantDragY = (realtimeSyncTick, voiceStage.voiceParticipantDragY);
  $: voiceParticipantPointerPress = (realtimeSyncTick, voiceStage.voiceParticipantPointerPress);
  // Native (Tauri) voice session transport and shared voice signaling live in
  // NativeVoiceController (lib/native-voice.svelte.ts). Constructed after the
  // controllers it orchestrates; hooks above stay lazy until used.
  const nativeVoice = new NativeVoiceController({
    memberId: () => memberId,
    activeServerId: () => activeServerId,
    baseUrl: () => baseUrl,
    sessionToken: () => sessionToken,
    nativeDesktopRuntime: () => nativeDesktopRuntime,
    voiceState: () => voiceState,
    voiceSession: () => voiceSession,
    realtime: () => realtime,
    transport: () => transport,
    screenShare: () => screenShare,
    screenShareSetup: () => screenShareSetup,
    accompaniment: () => accompaniment,
    audio: () => audio,
    channels: () => channelsController,
    messages: () => messagesController,
    channelFiles: () => channelFiles,
    composer: () => composer,
    channelContentMode: () => channelContentMode,
    setChannelContentMode: (mode) => (channelContentMode = mode),
    memberSearchOpen: () => memberSearchOpen,
    setMemberSearchOpen: (open) => (memberSearchOpen = open),
    memberSearchQuery: () => memberSearchQuery,
    setMemberSearchQuery: (query) => (memberSearchQuery = query),
    clearMemberAccessFilter: () => voiceStage.clearMemberAccessFilter(),
    screenShareActionBusy: () => screenShareActionBusy,
    setScreenShareActionBusy: (busy) => (screenShareActionBusy = busy),
    focusedScreenShareId: () => screenShare.focusedScreenShareId,
    setFocusedScreenShareId: (id) => (screenShare.focusedScreenShareId = id),
    poppedOutScreenShareIds: () => poppedOutScreenShareIds,
    setPoppedOutScreenShareIds: (ids) => (poppedOutScreenShareIds = ids),
    joinedVoiceChannelId: () => joinedVoiceChannelId,
    pendingVoiceOutboundSignals: () => pendingVoiceOutboundSignals,
    setPendingVoiceOutboundSignals: (signals) => (pendingVoiceOutboundSignals = signals),
    setError: (message) => (error = message),
    translate: (key, params) => t(key, params),
    caughtMessage,
    flushAliases: () => {
      realtimeSyncTick += 1;
    }
  });
  $: nativeVoiceSession = (realtimeSyncTick, nativeVoice.nativeVoiceSession);
  $: nativeVoiceStatus = (realtimeSyncTick, nativeVoice.nativeVoiceStatus);
  // Workspace domain (connection, loading, profile sync, onboarding, account
  // merge, app-settings orchestration) lives in lib/workspace.svelte.ts. State
  // remains component-owned; the controller reaches it through the accessors
  // below and every cross-domain side effect through the function hooks.
  const workspace = new WorkspaceController({
    get baseUrl() { return baseUrl; },
    set baseUrl(value) { baseUrl = value; },
    get connectBaseUrl() { return connectBaseUrl; },
    set connectBaseUrl(value) { connectBaseUrl = value; },
    get localUserProfile() { return localUserProfile; },
    set localUserProfile(value) { localUserProfile = value; },
    get displayName() { return displayName; },
    set displayName(value) { displayName = value; },
    get profileDraft() { return profileDraft; },
    set profileDraft(value) { profileDraft = value; },
    get profileSaving() { return profileSaving; },
    set profileSaving(value) { profileSaving = value; },
    get profileSaveMessage() { return profileSaveMessage; },
    set profileSaveMessage(value) { profileSaveMessage = value; },
    get profileSettingsDirty() { return profileSettingsDirty; },
    set profileSettingsDirty(value) { profileSettingsDirty = value; },
    get profileAvatarCropSource() { return profileAvatarCropSource; },
    set profileAvatarCropSource(value) { profileAvatarCropSource = value; },
    get memberMergeCode() { return memberMergeCode; },
    set memberMergeCode(value) { memberMergeCode = value; },
    get memberMergeCodeServerID() { return memberMergeCodeServerID; },
    set memberMergeCodeServerID(value) { memberMergeCodeServerID = value; },
    get memberMergeCodeExpiresAtMS() { return memberMergeCodeExpiresAtMS; },
    set memberMergeCodeExpiresAtMS(value) { memberMergeCodeExpiresAtMS = value; },
    get memberMergeCodeInput() { return memberMergeCodeInput; },
    set memberMergeCodeInput(value) { memberMergeCodeInput = value; },
    get memberMergeIncoming() { return memberMergeIncoming; },
    set memberMergeIncoming(value) { memberMergeIncoming = value; },
    get memberMergeOutgoing() { return memberMergeOutgoing; },
    set memberMergeOutgoing(value) { memberMergeOutgoing = value; },
    get memberMergeGenerating() { return memberMergeGenerating; },
    set memberMergeGenerating(value) { memberMergeGenerating = value; },
    get memberMergeSubmitting() { return memberMergeSubmitting; },
    set memberMergeSubmitting(value) { memberMergeSubmitting = value; },
    get memberMergeStatusMessage() { return memberMergeStatusMessage; },
    set memberMergeStatusMessage(value) { memberMergeStatusMessage = value; },
    get memberMergeCodeCopied() { return memberMergeCodeCopied; },
    set memberMergeCodeCopied(value) { memberMergeCodeCopied = value; },
    get memberMergeCodeCopiedTimer() { return memberMergeCodeCopiedTimer; },
    set memberMergeCodeCopiedTimer(value) { memberMergeCodeCopiedTimer = value; },
    get memberMergePrompting() { return memberMergePrompting; },
    set memberMergePrompting(value) { memberMergePrompting = value; },
    get memberMergePromptRequestID() { return memberMergePromptRequestID; },
    set memberMergePromptRequestID(value) { memberMergePromptRequestID = value; },
    get memberMergePromptResolvedExternally() { return memberMergePromptResolvedExternally; },
    set memberMergePromptResolvedExternally(value) { memberMergePromptResolvedExternally = value; },
    get connectPassword() { return connectPassword; },
    set connectPassword(value) { connectPassword = value; },
    get connectMode() { return connectMode; },
    set connectMode(value) { connectMode = value; },
    get connectInviteLink() { return connectInviteLink; },
    set connectInviteLink(value) { connectInviteLink = value; },
    get connectBusy() { return connectBusy; },
    set connectBusy(value) { connectBusy = value; },
    get connectUseSavedCredential() { return connectUseSavedCredential; },
    set connectUseSavedCredential(value) { connectUseSavedCredential = value; },
    get connectAttemptId() { return connectAttemptId; },
    set connectAttemptId(value) { connectAttemptId = value; },
    get connectAbortController() { return connectAbortController; },
    set connectAbortController(value) { connectAbortController = value; },
    get memberId() { return memberId; },
    set memberId(value) { memberId = value; },
    get sessionToken() { return sessionToken; },
    set sessionToken(value) { sessionToken = value; },
    get isOwner() { return isOwner; },
    set isOwner(value) { isOwner = value; },
    get server() { return server; },
    set server(value) { server = value; },
    get serverReportedClientUpdateRequired() { return serverReportedClientUpdateRequired; },
    set serverReportedClientUpdateRequired(value) { serverReportedClientUpdateRequired = value; },
    get storedCredential() { return storedCredential; },
    set storedCredential(value) { storedCredential = value; },
    get savedServers() { return savedServers; },
    set savedServers(value) { savedServers = value; },
    get storedServerWriteQueue() { return storedServerWriteQueue; },
    set storedServerWriteQueue(value) { storedServerWriteQueue = value; },
    get activeServerId() { return activeServerId; },
    set activeServerId(value) { activeServerId = value; },
    get activeSavedServerValue() { return activeSavedServerValue; },
    set activeSavedServerValue(value) { activeSavedServerValue = value; },
    get workspaceReconnectRequired() { return workspaceReconnectRequired; },
    set workspaceReconnectRequired(value) { workspaceReconnectRequired = value; },
    get workspaceReconnectBusy() { return workspaceReconnectBusy; },
    set workspaceReconnectBusy(value) { workspaceReconnectBusy = value; },
    get workspaceConnectionError() { return workspaceConnectionError; },
    set workspaceConnectionError(value) { workspaceConnectionError = value; },
    get connectDialogOpen() { return connectDialogOpen; },
    set connectDialogOpen(value) { connectDialogOpen = value; },
    get onboardingOpen() { return onboardingOpen; },
    set onboardingOpen(value) { onboardingOpen = value; },
    get onboardingStep() { return onboardingStep; },
    set onboardingStep(value) { onboardingStep = value; },
    get appSettingsOpen() { return appSettingsOpen; },
    set appSettingsOpen(value) { appSettingsOpen = value; },
    get settingsSelectMenuOpen() { return settingsSelectMenuOpen; },
    set settingsSelectMenuOpen(value) { settingsSelectMenuOpen = value; },
    get serverDetailsOpen() { return serverDetailsOpen; },
    set serverDetailsOpen(value) { serverDetailsOpen = value; },
    get error() { return error; },
    set error(value) { error = value; },
    get connectError() { return connectError; },
    set connectError(value) { connectError = value; },
    get statusKey() { return statusKey; },
    set statusKey(value) { statusKey = value; },
    get members() { return members; },
    set members(value) { members = value; },
    get rtcIceServers() { return rtcIceServers; },
    set rtcIceServers(value) { rtcIceServers = value; },
    get voiceConnectionContext() { return voiceConnectionContext; },
    set voiceConnectionContext(value) { voiceConnectionContext = value; },
    get realtimeSyncTick() { return realtimeSyncTick; },
    set realtimeSyncTick(value) { realtimeSyncTick = value; },
    bumpAliases: () => {
      realtimeSyncTick += 1;
    },
    t: (key, values) => t(key, values),
    caughtMessage,
    showAppConfirm,
    showAppAlert,
    appDialogOpen: () => Boolean(appDialog),
    showWorkspaceReconnect,
    clearActiveServerWorkspace,
    endRemoteControlsBeforeWorkspaceSwitch: (targetServerId) => remoteControl.endBeforeWorkspaceSwitch(targetServerId),
    closeEventSocket: () => realtime.closeEventSocket(),
    prepareVoiceConnectionForWorkspaceSwitch: (targetServerId) => realtime.prepareVoiceConnectionForWorkspaceSwitch(targetServerId),
    hideServerRailTooltip: (key) => serverRail.hideTooltip(key),
    ensureVoiceEventSocket: (forceDedicated = false) => realtime.ensureVoiceEventSocket(forceDedicated),
    connectEventSocket: () => realtime.connectEventSocket(),
    startVoiceStatesRefreshLoop: () => realtime.startVoiceStatesRefreshLoop(),
    normalizeStoredCredential: (credential) => serverRail.normalizeStoredCredential(credential),
    normalizeDevelopmentBaseUrl,
    validatedServerBaseUrl,
    saveActiveServerId,
    loadCredential,
    mergeMember: (member) => realtime.mergeMember(member),
    ensureSelectedRole,
    clearMemberAccessFilter: () => voiceStage.clearMemberAccessFilter(),
    sortRoles: (rolesValue) => permissionsController.sortRoles(rolesValue),
    resetRemoteControlClientState: () => remoteControl.resetClientState(),
    refreshAudioInputDevices: (requestPermission, reportError) => audio.refreshAudioInputDevices(requestPermission, reportError),
    initializeWebPermissions: () => audio.initializeWebPermissions(),
    stopMicrophoneTest: () => audio.stopMicrophoneTest(),
    closeCreateChannelMenu: () => channelsController.closeCreateChannelMenu(),
    closeServerMenu,
    closeVoiceParticipantContextMenu: () => voiceStage.closeVoiceParticipantContextMenu(),
    releaseImageCropSource: (source) => serverSettingsController.releaseImageCropSource(source),
    downloadTextFile,
    sameProfileSettings: (left, right) => serverSettingsController.sameProfileSettings(left, right),
    sameProfileOverrides: (left, right) => serverSettingsController.sameProfileOverrides(left, right),
    serverRail,
    channelsController,
    permissionsController,
    serverSettingsController,
    voiceState,
    screenShare,
    accompaniment,
    soundboard,
    emoji,
    composer,
    messagesController,
    remoteControl,
    tick,
    screenSharePopoutMode,
    nativeDesktopRuntime,
    localUserProfileExistedAtStartup,
  });
  $: customEmojis = (realtimeSyncTick, emoji.customEmojis);
  $: serverEmojiUploadID = (realtimeSyncTick, emoji.serverUploadID);
  $: emojiEditorFile = (realtimeSyncTick, emoji.editorFile);
  $: emojiEditorSourceURL = (realtimeSyncTick, emoji.editorSourceURL);
  $: emojiManagementError = (realtimeSyncTick, emoji.managementError);
  $: emojiDetailReference = (realtimeSyncTick, emoji.detailReference);
  $: emojiAutocompleteState = (realtimeSyncTick, emoji.autocompleteState);
  let remoteAudioPlaybackBlocked = false;
  const activeUISounds = new Set<HTMLAudioElement>();
  // ---------------------------------------------------------------------------
  // Realtime transport state
  // Workspace + voice event sockets, heartbeats, reconnect attempts, session
  // recovery, and the native local screen-share preview transport now live in
  // RealtimeController (lib/realtime.svelte.ts); see the construction above.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Permission & member/role derived state
  // Cached canXxx flags and current-member caches refreshed by $: statements.
  // The authoritative role data lives in PermissionsController.
  // ---------------------------------------------------------------------------
  let canEditServerSettings = false;
  let canSendMessages = false;
  let canManageRoles = false;
  let canManageChannels = false;
  let canManageChannelPermissions = false;
  let canManageMembers = false;
  let canManageMessages = false;
  let canShareScreen = false;
  let canRequestRemoteControl = false;
  let canAcceptRemoteControl = false;
  let currentUserDisplayNameValue = localUserProfile.display_name;
  let currentMember: Member | undefined;
  let selectedRole: ServerRole | undefined;
  let roleSettingsDirty = false;
  let settingsDirty = false;
  // ---------------------------------------------------------------------------
  // Remaining component-local types & static feature tables
  // Move each type/table beside its owning controller or lib module.
  // ---------------------------------------------------------------------------
  type ScreenShareViewItem = {
    share: ScreenShareSession;
    stream: MediaStream | null;
  };
  // MessageContextMenu / ClientMessage moved to lib/messages.svelte.ts.
  type PendingVoiceOutboundSignal = {
    channelId: string;
    targetParticipantId: string;
    signalType: RTCSignal["signal_type"];
    data: unknown;
  };
  import type { ClientMessage } from "./lib/messages.svelte";
  type IdentityMemberPicker = "primary" | "duplicate";
  // ChannelPermissionTarget moved to lib/permissions.svelte.ts.
  const permissionKeys: Permission[] = [
    "administrator",
    "view_members",
    "view_channels",
    "send_messages",
    "manage_messages",
    "read_message_history",
    "connect_voice",
    "speak",
    "mute_members",
    "deafen_members",
    "move_members",
    "edit_server_settings",
    "manage_roles",
    "manage_channels",
    "manage_channel_permissions",
    "manage_members",
    "share_screen",
    "request_remote_control",
    "accept_remote_control",
    "play_accompaniment",
    "play_soundboard",
    "manage_server_soundboard",
    "send_emoji",
    "manage_server_emoji",
    "create_invites",
    "view_files",
    "upload_files",
    "download_files",
    "manage_files"
  ];
  const channelOverridePermissionKeys: Permission[] = [
    "view_channels",
    "manage_channels",
    "manage_channel_permissions",
    "send_messages",
    "manage_messages",
    "read_message_history",
    "connect_voice",
    "speak",
    "mute_members",
    "deafen_members",
    "move_members",
    "share_screen",
    "request_remote_control",
    "accept_remote_control",
    "play_accompaniment",
    "play_soundboard",
    "send_emoji",
    "view_files",
    "upload_files",
    "download_files",
    "manage_files"
  ];
  const permissionGroups: { key: string; labelKey: string; permissions: Permission[] }[] = [
    {
      key: "general",
      labelKey: "permissions.groupGeneral",
      permissions: ["administrator", "view_members", "view_channels"]
    },
    {
      key: "messages",
      labelKey: "permissions.groupMessages",
      permissions: ["send_messages", "manage_messages", "read_message_history"]
    },
    {
      key: "voice",
      labelKey: "permissions.groupVoice",
      permissions: ["connect_voice", "speak", "mute_members", "deafen_members", "move_members", "share_screen", "request_remote_control", "accept_remote_control", "play_accompaniment", "play_soundboard"]
    },
    {
      key: "content",
      labelKey: "permissions.groupContent",
      permissions: ["send_emoji", "manage_server_emoji", "manage_server_soundboard", "view_files", "upload_files", "download_files", "manage_files"]
    },
    {
      key: "management",
      labelKey: "permissions.groupManagement",
      permissions: ["edit_server_settings", "manage_roles", "manage_channels", "manage_channel_permissions", "manage_members", "create_invites"]
    }
  ];
  // ---------------------------------------------------------------------------
  // WebRTC transport registries (voice + screen share)
  // Peer connections, transceivers, ICE queues, signal processing queues, and
  // retry timers. Hot-path only: never accessed through $: aliases.
  // ---------------------------------------------------------------------------
  let pendingVoiceOutboundSignals: PendingVoiceOutboundSignal[] = [];
  // screenShareWatchers / watcherSessionIds / pendingOwnedWatchSignals moved
  // into ScreenShareController; screen-share peer registries moved into
  // ScreenShareTransportController.
  // ===========================================================================
  // ACTIONS, EVENT HANDLERS, AND DOM HELPERS
  // The following ~15k lines are grouped by feature cluster. When extracting,
  // move one cluster at a time together with its state and types; keep thin
  // same-name wrappers in place until the template that calls them is moved.
  // ===========================================================================
  $: channelTree = buildChannelTree(channels);
  $: categoryChannelEntries = getCategoryChannels(channelTree);
  const messageContextMenuMessage = () =>
    messageContextMenu ? messages.find((message) => message.message_id === messageContextMenu?.messageId) : undefined;
  let languageOptions = () => builtInLanguages;
  let t = (key: string, values: Record<string, string | number> = {}) =>
    translate(languagePack, key, values);
  $: languageOptions = () => importedLanguagePack ? [...builtInLanguages, importedLanguagePack] : builtInLanguages;
  $: t = (key: string, values: Record<string, string | number> = {}) => translate(languagePack, key, values);

  function caughtMessage(caught: unknown, fallback: string) {
    if (caught instanceof Error && caught.message.trim()) return caught.message;
    if (typeof caught === "string" && caught.trim()) return caught.trim();
    if (caught && typeof caught === "object" && "message" in caught) {
      const message = String((caught as { message?: unknown }).message ?? "").trim();
      if (message) return message;
    }
    return fallback;
  }

  function openAppDialog(
    kind: AppDialogKind,
    message: string,
    initialValue = "",
    options: AppDialogOptions = {}
  ): Promise<AppDialogResult> {
    if (appDialogResolver) {
      const previousResolver = appDialogResolver;
      appDialogResolver = null;
      previousResolver(null);
    }
    appDialogInputValue = initialValue;
    appDialog = {
      kind,
      title: options.title ?? t(kind === "alert" ? "dialog.noticeTitle" : kind === "prompt" ? "dialog.inputTitle" : "dialog.confirmTitle"),
      message,
      confirmLabel: options.confirmLabel ?? t(kind === "alert" ? "common.ok" : "common.confirm"),
      cancelLabel: options.cancelLabel ?? t("common.cancel"),
      danger: Boolean(options.danger),
      profileComparison: options.profileComparison,
      memberCard: options.memberCard,
      dismissible: options.dismissible !== false
    };
    return new Promise((resolve) => {
      appDialogResolver = resolve;
      void tick().then(() => {
        const focusTarget = kind === "prompt" ? appDialogInputElement : appDialogConfirmElement;
        focusTarget?.focus();
        if (kind === "prompt") appDialogInputElement?.select();
      });
    });
  }

  async function showAppAlert(message: string, options: AppDialogOptions = {}) {
    await openAppDialog("alert", message, "", options);
  }

  async function showAppConfirm(message: string, options: AppDialogOptions = {}) {
    return (await openAppDialog("confirm", message, "", options)) === true;
  }

  async function showAppPrompt(message: string, initialValue = "", options: AppDialogOptions = {}) {
    const result = await openAppDialog("prompt", message, initialValue, options);
    return typeof result === "string" ? result : null;
  }

  function settleAppDialog(result: AppDialogResult) {
    const resolver = appDialogResolver;
    appDialogResolver = null;
    appDialog = null;
    appDialogInputElement = null;
    appDialogConfirmElement = null;
    resolver?.(result);
    void tick().then(processNextMemberMergePrompt);
  }

  function confirmAppDialog() {
    if (!appDialog) return;
    settleAppDialog(appDialog.kind === "prompt" ? appDialogInputValue : true);
  }

  function cancelAppDialog() {
    if (!appDialog) return;
    settleAppDialog(appDialog.kind === "confirm" ? false : null);
  }

  function handleAppDialogKeydown(event: KeyboardEvent) {
    if (!appDialog) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (appDialog.dismissible) cancelAppDialog();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      confirmAppDialog();
      return;
    }
    if (event.key !== "Tab") return;
    const dialog = event.currentTarget as HTMLElement;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])')
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
  let selectedChannel: Channel | undefined;
  let selectedChannelTitle = "";
  let fileStorageAvailable = false;
  let messageContextMenuValue: Message | undefined;
  let messageContextMenuSelectionValues: Message[] = [];
  let voiceParticipantContextMenuMemberValue: Member | undefined;
  let voiceParticipantContextMenuStateValue: VoiceState | undefined;
  let voiceParticipantContextMenuSelectionStates: VoiceState[] = [];
  let voiceParticipantContextMenuCanMove = false;
  let voiceParticipantContextMenuCanModerate = false;
  let voiceParticipantContextMenuCanManageMember = false;
  let voiceParticipantDragPreviewStyleValue = "";
  let currentVoiceStateValue: VoiceState | undefined;
  let currentMemberScreenShare: ScreenShareSession | undefined;
  let currentMemberActiveScreenShare = false;
  let canStartScreenShareSessionValue = false;
  let selectedVoiceStates: VoiceState[] = [];
  let selectedVoiceScreenShares: ScreenShareSession[] = [];
  let focusedScreenShare: ScreenShareSession | undefined;
  let focusedScreenShareId = "";
  let poppedOutScreenShareItems: ScreenShareViewItem[] = [];
  let poppedOutScreenShareIds = new Set<string>();
  let joinedVoiceChannelId = "";
  let voiceStatesByChannel = new Map<string, VoiceState[]>();
  let voiceDisplayStatesByChannel = new Map<string, VoiceState[]>();
  let voiceStatesByMember = new Map<string, VoiceState>();
  let voiceStatesByParticipant = new Map<string, VoiceState>();
  let canHostRemoteControl = false;
  let canMuteVoiceMembers = false;
  let canDeafenVoiceMembers = false;
  let canMoveVoiceMembers = false;
  let screenShareAudioAvailable = false;
  let focusedActiveRemoteControl: RemoteControlSession | undefined;
  let focusedMemberRemoteControl: RemoteControlSession | undefined;
  $: serverRailSavedServersByID = new Map(savedServers.map((item) => [item.server_id, item]));
  $: activeSavedServerValue = savedServers.find((item) => item.server_id === activeServerId);
  $: selectedChannel = channels.find((channel) => channel.channel_id === selectedChannelId);
  $: messageContextMenuValue = messageContextMenu
    ? messages.find((message) => message.message_id === messageContextMenu?.messageId)
    : undefined;
  $: messageContextMenuSelectionValues = messageContextMenu
    ? messages.filter((message) => selectedMessageIds.has(message.message_id))
    : [];
  $: voiceParticipantContextMenuMemberValue = voiceParticipantContextMenu
    ? members.find((member) => member.member_id === voiceParticipantContextMenu.memberId)
    : undefined;
  $: voiceParticipantContextMenuStateValue = voiceParticipantContextMenu
    ? (voiceParticipantContextMenu.participantId
        ? voiceStatesByParticipant.get(voiceParticipantContextMenu.participantId)
        : voiceStatesByMember.get(voiceParticipantContextMenu.memberId))
    : undefined;
  $: voiceParticipantContextMenuSelectionStates = voiceParticipantContextMenu
    ? voiceStates.filter((state) => selectedVoiceParticipantIds.has(state.participant_id))
    : [];
  $: voiceParticipantContextMenuCanMove = Boolean(
    voiceParticipantContextMenuSelectionStates.length > 0 &&
      voiceParticipantContextMenuSelectionStates.every(
        (state) => state.member_id === memberId || (canMoveVoiceMembers && voiceStage.canManageVoiceParticipant(state))
      )
  );
  $: voiceParticipantContextMenuCanModerate = Boolean(
    voiceParticipantContextMenuSelectionStates.length > 0 &&
      voiceParticipantContextMenuSelectionStates.every(
        (state) => state.member_id !== memberId && voiceStage.canManageVoiceParticipant(state)
      )
  );
  $: voiceParticipantContextMenuCanManageMember = Boolean(
    voiceParticipantContextMenuMemberValue &&
      canManageMembers &&
      (voiceParticipantContextMenuSelectionStates.length > 0
        ? voiceParticipantContextMenuSelectionStates.every((state) => state.member_id !== memberId)
        : voiceParticipantContextMenuMemberValue.member_id !== memberId)
  );
  $: voiceParticipantDragPreviewStyleValue = `left: ${voiceParticipantDragX + 14}px; top: ${voiceParticipantDragY + 14}px;`;
  $: selectedChannelTitle = (languagePack, serverPreviewLanguageId, selectedChannel
    ? channelsController.isVoiceChannel(selectedChannel) && channelContentMode !== "voice"
      ? t("channel.voiceChatFor", { name: channelsController.channelNameForDisplay(selectedChannel) })
      : channelsController.channelNameForDisplay(selectedChannel)
    : t("content.noChannel"));
  $: composerPlaceholder = (languagePack, serverPreviewLanguageId, selectedChannel
    ? t("composer.placeholderChannel", { name: channelsController.channelNameForDisplay(selectedChannel) })
    : t("composer.placeholder"));
  $: fileStorageAvailable =
    Boolean(server?.file_storage_enabled) && Boolean(selectedChannel) && selectedChannel?.type !== "category";
  $: if (channelContentMode === "files" && (!fileStorageAvailable || !canViewFiles)) {
    channelFiles.clearFileView();
  }
  $: currentVoiceStateValue = voiceConnectionContext?.state;
  $: accompanimentMemberIds = new Set(accompanimentSessions.map((session) => session.owner_member_id));
  $: currentMemberScreenShare = screenShareSessions.find(
    (share) => share.owner_participant_id === currentVoiceStateValue?.participant_id
  );
  $: canHostRemoteControl = (realtimeSyncTick,
    Boolean(
      isTauriRuntime() &&
        screenShareSetup.desktopMediaCapabilities?.remoteControlHost &&
        canAcceptRemoteControl
    )
  );
  $: screenShareAudioAvailable = (realtimeSyncTick,
    !isTauriRuntime() || Boolean(
      screenShareSetup.desktopMediaCapabilities?.audioBackends.includes("windows-process-loopback")
    )
  );
  // Controller-owned setup derivatives refresh here; see syncViewState().
  $: {
    realtimeSyncTick;
    screenShareAudioAvailable;
    pendingWebScreenShareStream;
    screenShareSetup.syncViewState(screenShareAudioAvailable);
  }
  $: currentMemberActiveScreenShare = Boolean(
    currentMemberScreenShare && transport.localScreenShareCaptureActive()
  );
  $: selectedVoiceStates = selectedChannelId ? voiceDisplayStatesByChannel.get(selectedChannelId) ?? [] : [];
  $: selectedVoiceScreenShares = selectedChannelId
    ? screenShareSessions.filter((share) => share.channel_id === selectedChannelId)
    : [];
  $: focusedScreenShareId = (realtimeSyncTick, screenShare.focusedScreenShareId);
  $: focusedScreenShare = focusedScreenShareId
    ? screenShareSessions.find((share) => share.share_id === focusedScreenShareId)
    : undefined;
  $: focusedActiveRemoteControl = focusedScreenShare
    ? remoteControl.activeForShare(focusedScreenShare.share_id, remoteControlSessions)
    : undefined;
  $: focusedMemberRemoteControl = focusedScreenShare
    ? remoteControl.currentMemberForShare(focusedScreenShare.share_id, remoteControlSessions)
    : undefined;
  $: poppedOutScreenShareItems = screenShareSessions
    .filter((share) => share.owner_member_id !== memberId && poppedOutScreenShareIds.has(share.share_id))
    .map((share) => ({ share, stream: remoteScreenShareStreams.get(share.owner_member_id) ?? null }));
  $: joinedVoiceChannelId = voiceConnectionContext?.serverId === activeServerId
    ? currentVoiceStateValue?.channel_id ?? ""
    : "";
  $: voiceStatesByChannel = voiceStage.buildVoiceStatesByChannel(voiceStates, members);
  $: voiceDisplayStatesByChannel = voiceStage.buildVoiceDisplayStatesByChannel(voiceStatesByChannel);
  $: voiceStatesByParticipant = new Map(voiceStates.map((state) => [state.participant_id, state]));
  $: voiceStatesByMember = voiceStage.buildPrimaryVoiceStatesByMember(voiceStates);
  $: memberPanelMembers = voiceStage.filterMemberPanelMembers(
    members,
    memberAccessFilterChannelId,
    memberAccessFilterMemberIds,
    memberSearchQuery
  );
  $: {
    realtimeSyncTick;
    languagePack;
    screenShareSetup.setActualSettingsLabel(screenShareSetup.computeActualSettingsLabel());
  }
  $: {
    realtimeSyncTick;
    transport.webScreenShareSenderTelemetry;
    transport.webScreenShareSenderConfigurationErrors;
    localScreenShareStream;
    languagePack;
    screenShareSetup.setPreviewMetaLabel(screenShareSetup.computePreviewMetaLabel());
  }
  $: currentMember = members.find((member) => member.member_id === memberId);
  $: currentUserDisplayNameValue =
    currentMember?.display_name || localUserProfile.display_name || displayName || "EchoVoice User";
  $: selectedRole = roles.find((role) => role.role_id === selectedRoleId);
  $: canEditServerSettings = hasEffectivePermission("edit_server_settings", isOwner, currentMember, roles, rolePreviewId);
  $: canSendMessages = hasEffectivePermission("send_messages", isOwner, currentMember, roles, rolePreviewId);
  $: canManageRoles = hasEffectivePermission("manage_roles", isOwner, currentMember, roles, rolePreviewId);
  $: canManageChannels = hasEffectivePermission("manage_channels", isOwner, currentMember, roles, rolePreviewId);
  $: canManageChannelPermissions =
    hasEffectivePermission("manage_channel_permissions", isOwner, currentMember, roles, rolePreviewId) || canManageChannels;
  $: canManageMembers = hasEffectivePermission("manage_members", isOwner, currentMember, roles, rolePreviewId);
  $: canMuteVoiceMembers = canManageMembers || hasEffectivePermission("mute_members", isOwner, currentMember, roles, rolePreviewId);
  $: canDeafenVoiceMembers = canManageMembers || hasEffectivePermission("deafen_members", isOwner, currentMember, roles, rolePreviewId);
  $: canMoveVoiceMembers = canManageMembers || hasEffectivePermission("move_members", isOwner, currentMember, roles, rolePreviewId);
  $: canManageMessages = hasEffectivePermission("manage_messages", isOwner, currentMember, roles, rolePreviewId);
  $: canShareScreen = hasEffectivePermission("share_screen", isOwner, currentMember, roles, rolePreviewId);
  $: canRequestRemoteControl = hasEffectivePermission("request_remote_control", isOwner, currentMember, roles, rolePreviewId);
  $: canAcceptRemoteControl = hasEffectivePermission("accept_remote_control", isOwner, currentMember, roles, rolePreviewId);
  $: canPlayAccompaniment = hasEffectivePermission("play_accompaniment", isOwner, currentMember, roles, rolePreviewId);
  $: canPlaySoundboard = hasEffectivePermission("play_soundboard", isOwner, currentMember, roles, rolePreviewId);
  $: canManageServerSoundboard = hasEffectivePermission("manage_server_soundboard", isOwner, currentMember, roles, rolePreviewId);
  $: canSendEmoji = hasEffectivePermission("send_emoji", isOwner, currentMember, roles, rolePreviewId);
  $: canManageServerEmoji = hasEffectivePermission("manage_server_emoji", isOwner, currentMember, roles, rolePreviewId);
  $: {
    languagePack;
    serverEmojiUploadErrorValue = emoji.uploadErrorFor(serverEmojiUploadID, customEmojis);
  }
  $: canCreateInvites = hasEffectivePermission("create_invites", isOwner, currentMember, roles, rolePreviewId);
  $: canViewFiles = permissionsController.channelAllowsPermission(selectedChannel, "view_files", isOwner, currentMember, roles, rolePreviewId);
  $: canUploadFiles = permissionsController.channelAllowsPermission(selectedChannel, "upload_files", isOwner, currentMember, roles, rolePreviewId);
  $: canDownloadFiles = permissionsController.channelAllowsPermission(selectedChannel, "download_files", isOwner, currentMember, roles, rolePreviewId);
  $: canManageFiles = permissionsController.channelAllowsPermission(selectedChannel, "manage_files", isOwner, currentMember, roles, rolePreviewId);
  $: if (!canManageChannels && channelsController.channelCreateMenuParentId !== null) {
    channelsController.channelCreateMenuParentId = null;
  }
  $: canStartScreenShareSessionValue = Boolean(
    server?.screen_share_enabled &&
      currentVoiceStateValue &&
      currentVoiceStateValue.mode === "primary" &&
      sessionToken &&
      canShareScreen &&
      !currentMemberActiveScreenShare &&
      !screenShareActionBusy
  );
  $: if (localScreenShareVideoElement && localScreenShareStream) {
    transport.attachScreenSharePreviewElement();
  }
  $: transport.reconcileLocalScreenShareCapture(currentMemberScreenShare);
  $: serverSettingsDirty = Boolean(
    serverSettingsOpen && server && serverDraft && !serverSettingsController.sameServerSettings(serverDraft, server)
  );
  $: roleSettingsDirty = Boolean(
    serverSettingsOpen && roleDraft && selectedRole && !permissionsController.sameRoleSettings(roleDraft, selectedRole)
  );
  $: channelsController.channelDetailsDirty = Boolean(
    channelSettingsOpen && channelDraft && !channelsController.sameChannelSettings(channelDraft, channels.find((channel) => channel.channel_id === channelDraft?.channel_id))
  );
  $: channelsController.channelPermissionsDirty = Boolean(
    channelSettingsOpen &&
      selectedPermissionChannelId &&
      !permissionsController.sameChannelPermissionOverrides(channelPermissionDraftOverrides, channelPermissionOverrides)
  );
  $: channelsController.channelSettingsDirty = channelDetailsDirty || channelPermissionsDirty;
  $: profileSettingsDirty = Boolean(
    appSettingsOpen && !serverSettingsController.sameProfileSettings(profileDraft, localUserProfile)
  );
  $: serverProfileSettingsDirty = Boolean(
    serverProfileSettingsOpen && (
      !serverSettingsController.sameProfileSettings(serverProfileDraft, serverProfileBaseline) ||
      !serverSettingsController.sameProfileOverrides(serverProfileOverridesDraft, serverProfileOverridesBaseline)
    )
  );
  $: if (profileSettingsDirty && profileSaveMessage) profileSaveMessage = "";
  $: if (serverProfileSettingsDirty && serverProfileSaveMessage) serverSettingsController.serverProfileSaveMessage = "";
  $: settingsDirty = serverSettingsDirty || roleSettingsDirty;
  $: if (
    screenSharePopoutMode &&
    sessionToken &&
    eventConnectionStatus === "connected" &&
    !screenSharePopoutWatchStarted &&
    !screenSharePopoutWatchBusy
  ) {
    void transport.startScreenSharePopoutWatch();
  }

  // ── Workspace connection, channel selection & messaging actions ─────────────

  function showVoiceChannelTip(event?: MouseEvent | KeyboardEvent) {
    const target = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const rect = target?.getBoundingClientRect();
    const fallbackX = serverRailWidth + channelPanelWidth - 14;
    const fallbackY = window.innerHeight / 2;
    voiceChannelTip = {
      x: rect ? rect.right - 8 : fallbackX,
      y: rect ? rect.top + rect.height / 2 : fallbackY
    };
    window.clearTimeout(voiceChannelTipTimer);
    voiceChannelTipTimer = window.setTimeout(closeVoiceChannelTip, 1600);
  }

  function closeVoiceChannelTip() {
    window.clearTimeout(voiceChannelTipTimer);
    voiceChannelTipTimer = undefined;
    voiceChannelTip = null;
  }

  function downloadFileEntryFromChannel(entry: ChannelFileEntry) {
    return (realtimeSyncTick += 1, channelFiles.downloadFileEntryFromChannel(entry));
  }

  async function ensureMessageAttachmentPreview(reference: MessageAttachmentReference) {
    if (
      !messageAttachmentIsInlineMedia(reference) ||
      composer.messageAttachmentObjectURLs.has(reference.entryId) ||
      composer.messageAttachmentLoadingIds.has(reference.entryId) ||
      !selectedChannelId ||
      !sessionToken ||
      !canDownloadFiles
    ) return;
    const channelId = selectedChannelId;
    const token = sessionToken;
    composer.messageAttachmentLoadingIds = new Set(composer.messageAttachmentLoadingIds).add(reference.entryId);
    const nextErrors = new Set(composer.messageAttachmentErrorIds);
    nextErrors.delete(reference.entryId);
    composer.messageAttachmentErrorIds = nextErrors;
    try {
      const blob = await fetchChannelFileBlob(baseUrl, channelId, token, reference.entryId);
      if (selectedChannelId !== channelId || sessionToken !== token) return;
      const objectURL = URL.createObjectURL(blob);
      const previous = composer.messageAttachmentObjectURLs.get(reference.entryId);
      if (previous) URL.revokeObjectURL(previous);
      composer.messageAttachmentObjectURLs = new Map(composer.messageAttachmentObjectURLs).set(reference.entryId, objectURL);
    } catch {
      if (selectedChannelId === channelId) {
        composer.messageAttachmentErrorIds = new Set(composer.messageAttachmentErrorIds).add(reference.entryId);
      }
    } finally {
      const nextLoading = new Set(composer.messageAttachmentLoadingIds);
      nextLoading.delete(reference.entryId);
      composer.messageAttachmentLoadingIds = nextLoading;
    }
  }

  function observeMessageAttachmentPreview(node: HTMLElement, reference: MessageAttachmentReference) {
    let currentReference = reference;
    let observer: IntersectionObserver | null = null;
    const load = () => void ensureMessageAttachmentPreview(currentReference);
    const observe = () => {
      observer?.disconnect();
      observer = null;
      if (
        !messageAttachmentIsInlineMedia(currentReference) ||
        composer.messageAttachmentObjectURLs.has(currentReference.entryId) ||
        composer.messageAttachmentLoadingIds.has(currentReference.entryId) ||
        composer.messageAttachmentErrorIds.has(currentReference.entryId)
      ) return;
      if (typeof IntersectionObserver === "undefined") {
        load();
        return;
      }
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer?.disconnect();
        observer = null;
        load();
      }, { root: messageListElement, rootMargin: "280px 0px" });
      observer.observe(node);
    };
    observe();
    return {
      update(nextReference: MessageAttachmentReference) {
        currentReference = nextReference;
        observe();
      },
      destroy() {
        observer?.disconnect();
      }
    };
  }

  async function ensureMessageImagePreview(reference: MessageImageReference) {
    const key = reference.assetSHA256;
    if (
      composer.messageAttachmentObjectURLs.has(key) ||
      composer.messageAttachmentLoadingIds.has(key) ||
      !selectedChannelId ||
      !sessionToken
    ) return;
    const channelId = selectedChannelId;
    const token = sessionToken;
    composer.messageAttachmentLoadingIds = new Set(composer.messageAttachmentLoadingIds).add(key);
    const nextErrors = new Set(composer.messageAttachmentErrorIds);
    nextErrors.delete(key);
    composer.messageAttachmentErrorIds = nextErrors;
    try {
      const blob = await fetchMessageImageBlob(baseUrl, channelId, token, key);
      if (selectedChannelId !== channelId || sessionToken !== token) return;
      const objectURL = URL.createObjectURL(blob);
      const previous = composer.messageAttachmentObjectURLs.get(key);
      if (previous) URL.revokeObjectURL(previous);
      composer.messageAttachmentObjectURLs = new Map(composer.messageAttachmentObjectURLs).set(key, objectURL);
      await tick();
      if (editingMessageId) composer.renderMessageEditEditor(editingMessageDraft);
    } catch {
      if (selectedChannelId === channelId) {
        composer.messageAttachmentErrorIds = new Set(composer.messageAttachmentErrorIds).add(key);
      }
    } finally {
      const nextLoading = new Set(composer.messageAttachmentLoadingIds);
      nextLoading.delete(key);
      composer.messageAttachmentLoadingIds = nextLoading;
    }
  }

  function observeMessageImagePreview(node: HTMLElement, reference: MessageImageReference) {
    let currentReference = reference;
    let observer: IntersectionObserver | null = null;
    const load = () => void ensureMessageImagePreview(currentReference);
    const observe = () => {
      observer?.disconnect();
      observer = null;
      const key = currentReference.assetSHA256;
      if (
        composer.messageAttachmentObjectURLs.has(key) ||
        composer.messageAttachmentLoadingIds.has(key) ||
        composer.messageAttachmentErrorIds.has(key)
      ) return;
      if (typeof IntersectionObserver === "undefined") {
        load();
        return;
      }
      observer = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer?.disconnect();
        observer = null;
        load();
      }, { root: messageListElement, rootMargin: "280px 0px" });
      observer.observe(node);
    };
    observe();
    return {
      update(nextReference: MessageImageReference) {
        currentReference = nextReference;
        observe();
      },
      destroy() {
        observer?.disconnect();
      }
    };
  }

  async function openMessageImagePreview(reference: MessageImageReference, authorId: string) {
    const key = reference.assetSHA256;
    if (!composer.messageAttachmentObjectURLs.has(key)) await ensureMessageImagePreview(reference);
    if (openCachedMediaFilePreview({
      entry_id: `message-image-${key}`,
      channel_id: selectedChannelId,
      type: "file",
      name: reference.name,
      asset_sha256: key,
      owner_member_id: authorId,
      size_bytes: reference.sizeBytes,
      mime_type: reference.mimeType,
      created_at_ms: 0,
      updated_at_ms: 0
    }, composer.messageAttachmentObjectURLs.get(key) ?? "")) {
      channelFiles.setPreviewMessageImageReference(reference);
    }
  }

  async function resolveMessageAttachmentEntry(reference: MessageAttachmentReference) {
    const channelId = selectedChannelId;
    const token = sessionToken;
    const fallback = messageAttachmentEntry(reference, channelId);
    const cached = composer.messageAttachmentEntries.get(reference.entryId);
    if (cached?.owner_member_id && cached.asset_sha256) return cached;
    if (!channelId || !token) return fallback;
    try {
      const entry = await getChannelFileEntry(baseUrl, channelId, token, reference.entryId);
      if (selectedChannelId !== channelId || sessionToken !== token) return null;
      composer.messageAttachmentEntries = new Map(composer.messageAttachmentEntries).set(reference.entryId, entry);
      return entry;
    } catch {
      return fallback;
    }
  }

  async function openMessageAttachmentPreview(reference: MessageAttachmentReference) {
    const entry = await resolveMessageAttachmentEntry(reference);
    if (!entry) return;
    if (openCachedMediaFilePreview(entry, composer.messageAttachmentObjectURLs.get(reference.entryId) ?? "")) return;
    await openFilePreview(entry);
  }

  async function downloadMessageAttachment(reference: MessageAttachmentReference) {
    await downloadFileEntryFromChannel(messageAttachmentEntry(reference, selectedChannelId));
  }
    function handleFileEntryPointerDown(entry: ChannelFileEntry, event: PointerEvent) {
    // Bump the sync tick so selection-dependent buttons update in the same
    // event flush instead of waiting for the 100ms interval.
    const result = channelFiles.handleFileEntryPointerDown(entry, event);
    realtimeSyncTick += 1;
    return result;
  }
    function clearFileDrag() {
    return (realtimeSyncTick += 1, channelFiles.clearFileDrag());
  }

  function openFilePreview(entry: ChannelFileEntry) {
    return (realtimeSyncTick += 1, channelFiles.openFilePreview(entry));
  }
    function closeFilePreview() {
    return (realtimeSyncTick += 1, channelFiles.closeFilePreview());
  }
    function openCachedMediaFilePreview(entry: ChannelFileEntry, objectURL: string) {
    return (realtimeSyncTick += 1, channelFiles.openCachedMediaFilePreview(entry, objectURL));
  }

  function auditTargetLabel(log: AuditLog) {
    if (log.details?.target_member_name) return log.details.target_member_name;
    if (log.details?.target_channel_name) return log.details.target_channel_name;
    if (log.details?.name) return log.details.name;
    if (log.target_id) return log.target_id;
    return t("audit.serverTarget");
  }

  function auditActionLabel(action: string) {
    const key = `audit.action.${action}`;
    const label = t(key);
    return label === key ? action : label;
  }

  function auditDetails(log: AuditLog) {
    if (log.action.startsWith("voice.")) {
      const details = log.details ?? {};
      const items = [
        details.target_member_name ? `${t("audit.targetMember")}: ${details.target_member_name}` : "",
        details.previous_channel_name ? `${t("audit.previousChannel")}: ${details.previous_channel_name}` : "",
        details.target_channel_name ? `${t("audit.targetChannel")}: ${details.target_channel_name}` : "",
        details.server_muted ? `${t("voice.serverMuted")}: ${details.server_muted}` : "",
        details.server_deafened ? `${t("voice.serverDeafened")}: ${details.server_deafened}` : ""
      ].filter(Boolean);
      return items.join(" / ");
    }
    const entries = Object.entries(log.details ?? {}).filter(([, value]) => value !== "");
    if (entries.length === 0) return "";
    return entries.map(([key, value]) => `${key}: ${value}`).join(" / ");
  }

  // ── Composer & message-list scroll/editing actions ──────────────────────────

  // ── Workspace lifecycle, profile sync & settings actions ────────────────────

  async function reconnectToServer(
    credential: StoredCredential | null = storedCredential,
    externalSignal?: AbortSignal
  ) { return workspace.reconnectToServer(credential, externalSignal); }

  function openServerDetails() {
    closeServerMenu();
    voiceStage.closeVoiceParticipantContextMenu();
    if (appSettingsOpen) void audio.stopMicrophoneTest();
    appSettingsOpen = false;
    serverSettingsController.serverProfileSettingsOpen = false;
    serverSettingsController.serverSettingsOpen = false;
    serverSettingsController.inviteDialogOpen = false;
    serverDetailsOpen = true;
    error = "";
  }
    function closeServerSettings() {
    return (realtimeSyncTick += 1, serverSettingsController.closeServerSettings());
  }
    function applyServerProfileAvatarCrop(dataURL: string) {
    return (realtimeSyncTick += 1, serverSettingsController.applyServerProfileAvatarCrop(dataURL));
  }
    function closeServerProfileAvatarCrop() {
    return (realtimeSyncTick += 1, serverSettingsController.closeServerProfileAvatarCrop());
  }
    function cancelServerIconCrop() {
    return (realtimeSyncTick += 1, serverSettingsController.cancelServerIconCrop());
  }
    function applyServerIconCrop(dataURL: string) {
    return (realtimeSyncTick += 1, serverSettingsController.applyServerIconCrop(dataURL));
  }

  function toggleServerMenu() {
    channelsController.closeCreateChannelMenu();
    channelsController.closeChannelContextMenu();
    serverMenuOpen = !serverMenuOpen;
  }

  function closeServerMenu() {
    serverMenuOpen = false;
  }

  function eventTargetElement(target: EventTarget | null) {
    if (target instanceof Element) return target;
    if (target instanceof Text) return target.parentElement;
    return null;
  }

  function handleGlobalPointerDown(event: PointerEvent) {
    remoteVoiceMixer.resumeAll();
    const target = eventTargetElement(event.target);
    if (!target) return;
    if (settingsSelectMenuOpen && !target.closest(".settings-custom-select")) {
      settingsSelectMenuOpen = null;
    }
    const screenShareOptionMenuOpen = screenShareSetup.anyOptionMenuOpen();
    if (screenShareOptionMenuOpen && !target.closest(".screen-share-select, .screen-share-floating-select-menu")) {
      screenShareSetup.closeOptionMenus();
    }
    if (screenShareVolumeMenuShareId && !target.closest(".screen-share-volume-control")) {
      audio.screenShareVolumeMenuShareId = "";
    }
    if (transport.screenSharePathMenuShareId && !target.closest(".screen-share-path-control")) {
      transport.screenSharePathMenuShareId = "";
    }
    if (
      screenShareViewerPanelShareId &&
      !target.closest(".screen-share-focus-viewers-control, .screen-share-viewer-toggle, .screen-share-viewer-popover")
    ) {
      transport.closeScreenShareViewerPanel();
    }
    if (soundboard.popoverOpen && !target.closest(".soundboard-popover, .soundboard-card, .soundboard-editor-dialog")) {
      closeSoundboardPopover();
    }
    if (
      accompanimentVolumePopoverOpen &&
      !target.closest(".accompaniment-card, .accompaniment-volume-popover")
    ) {
      closeAccompanimentVolumePopover();
    }
    if (emoji.pickerOpen && !target.closest(".emoji-picker-popover, .composer-emoji-button, .soundboard-icon-picker-trigger")) {
      closeEmojiPicker();
    }
    if (emojiAutocompleteState && !target.closest(".composer-input-shell")) {
      composer.hideEmojiAutocomplete();
    }
    if (selectedMessageIds.size > 0 && !target.closest(".message-row, .message-context-menu")) {
      clearMessageSelection();
    }
    if (voiceStage.selectedVoiceParticipantIds.size > 0 && !target.closest("[data-voice-participant-id], .voice-participant-context-menu")) {
      voiceStage.selectedVoiceParticipantIds = new Set<string>();
      voiceStage.voiceParticipantSelectionAnchorId = "";
    }
    if (target.closest(".server-actions, .server-context-menu, .server-folder-context-menu, .category-actions, .channel-context-menu, .message-context-menu, .voice-participant-context-menu, .voice-network-popover, .voice-latency-indicator, .screen-share-card, .accompaniment-card, .soundboard-card, .soundboard-popover, .soundboard-editor-dialog, .screen-share-config-dialog, .screen-share-picker-window, .screen-share-floating-select-menu, .screen-share-viewer-toggle, .screen-share-viewers-control, .screen-share-viewer-popover, .screen-share-volume-control, .member-role-menu-wrap, .identity-member-picker, .channel-permission-target-picker, .channel-permission-target-menu")) return;
    serverRail.closeServerContextMenu();
    serverRail.closeFolderContextMenu();
    closeServerMenu();
    channelsController.closeCreateChannelMenu();
    channelsController.closeChannelContextMenu();
    closeMessageContextMenu();
    voiceStage.closeVoiceParticipantContextMenu();
    audio.closeVoiceNetworkDetails();
    transport.closeScreenShareViewerPanel();
    screenShareSetup.closeSetup();
    memberRoleMenuId = "";
    identityMemberPickerOpen = null;
    closeChannelPermissionTargetPicker();
  }

  function handleGlobalKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || !accompanimentVolumePopoverOpen) return;
    event.preventDefault();
    event.stopPropagation();
    closeAccompanimentVolumePopover(true);
  }
    function clearMessageSelection() {
    return (realtimeSyncTick += 1, messagesController.clearMessageSelection());
  }
    function closeMessageContextMenu() {
    return (realtimeSyncTick += 1, messagesController.closeMessageContextMenu());
  }

  function handleGlobalContextMenu(event: MouseEvent) {
    event.preventDefault();
    if (screenSharePopoutMode) return;
    if (voiceStage.openVoiceParticipantContextMenuFromEvent(event)) return;
    const target = eventTargetElement(event.target);
    const memberElement = target?.closest<HTMLElement>("[data-member-context-id]");
    const targetMemberId = memberElement?.dataset.memberContextId ?? "";
    const member = permissionsController.memberById(targetMemberId);
    if (member) voiceStage.openMemberContextMenu(member, event);
  }

  // ── Voice-state mutation & remote-control transport wrappers ────────────────
  // Voice state manipulation moved to lib/voice-state.svelte.ts
  // (VoiceStateController). The component keeps the transport orchestration
  // below and routes every mutation through the controller.

  // Screen share signalling mixes up to three ids (member, participant, share).
  // The peer connection map is keyed by the owner's participant id, so a lookup
  // that silently misses is how a live connection gets orphaned. The rules live
  // in lib/screenShareIdentities.ts with unit tests; these are just bindings.
  const screenShareIdentityLookups = {
    hasConnection: (peerId: string) => transport.screenSharePeerConnections.has(peerId),
    participantIdForMember: (memberId: string) => voiceState.voiceStateByMember(memberId)?.participant_id,
    memberIdForParticipant: (participantId: string) => voiceState.voiceStateByParticipant(participantId)?.member_id,
    memberIdForOwnerParticipant: (participantId: string) =>
      screenShare.sessions.find((share) => share.owner_participant_id === participantId)?.owner_member_id,
    peerIdForMemberShare: (memberId: string) => {
      const ownedShare = screenShare.sessions.find((share) => share.owner_member_id === memberId);
      return ownedShare ? screenShareOwnerPeerId(ownedShare) : undefined;
    }
  };

  function screenShareOwnerPeerId(share: ScreenShareSession) {
    return screenShareOwnerPeerIdOf(share, screenShareIdentityLookups);
  }

  function screenShareMemberIdForPeer(peerId: string) {
    return screenShareMemberIdForPeerOf(peerId, screenShareIdentityLookups);
  }

  function browserRTCConfiguration(): RTCConfiguration {
    // Always the live list: `voiceConnectionContext.iceServers` is only a copy
    // taken when the voice connection was created, so once that copy carries an
    // expired TURN credential every new viewer connection inherits it.
    return buildBrowserRTCConfiguration(rtcIceServers);
  }

  function screenSharePeerIdForIdentity(identity: string) {
    // Hot signaling path: read the controller directly. The legacy $: aliases
    // can be up to one sync tick behind, which would drop a just-arrived offer.
    return screenSharePeerIdForIdentityOf(identity, screenShareIdentityLookups);
  }

  function removeCurrentMemberScreenShareSession(session: ScreenShareSession) {
    // Same semantics as screen_share.ended handling: the controller removes the
    // session and tears down every owned-share resource (peer connections,
    // signal polling, watchers, local capture).
    screenShare.removeScreenShareSession(session);
  }

  function screenShareViewerIds(share: ScreenShareSession | undefined) {
    if (!share) return [];
    return [...new Set(share.viewer_member_ids ?? [])].sort((left, right) =>
      permissionsController.memberDisplayName(left).localeCompare(permissionsController.memberDisplayName(right))
    );
  }

  function screenShareViewerCount(share: ScreenShareSession | undefined) {
    return screenShareViewerIds(share).length;
  }

  function screenShareViewerPanelTitle(share: ScreenShareSession | undefined) {
    return share ? t("screenShare.viewersTitle") : t("screenShare.viewerStatusTitle");
  }

  async function startNativeRemoteControlLocalInputEvents() {
    if (!isTauriRuntime() || nativeRemoteControlLocalInputUnlisten) return;
    try {
      const eventApi = await import("@tauri-apps/api/event");
      nativeRemoteControlLocalInputUnlisten = await eventApi.listen<{
        controlId: string;
        atMs: number;
        respectUntilMs: number;
      }>("remote-control-local-input", (event) => {
        void remoteControl.syncRespectWindow(event.payload.controlId, event.payload.respectUntilMs);
      });
    } catch {
      // The Web client cannot host remote control and does not expose Tauri events.
    }
  }

  function stopNativeRemoteControlLocalInputEvents() {
    nativeRemoteControlLocalInputUnlisten?.();
    nativeRemoteControlLocalInputUnlisten = null;
  }

  // ── Voice stage UI helpers, join/leave, and accompaniment actions ───────────

  // ── Soundboard wrappers ─────────────────────────────────────────────────────
  // Soundboard domain moved to lib/soundboard.svelte.ts (SoundboardController).
  // Same-name wrappers keep templates and cross-domain call sites unchanged.
  // State-mutating wrappers bump realtimeSyncTick so the legacy $: aliases
  // above flush in the same turn instead of waiting for the 100ms interval.

  function updateSoundboardPopoverPosition() {
    return (realtimeSyncTick += 1, soundboard.updatePopoverPosition());
  }

  function loadServerSoundboardManagement() {
    return (realtimeSyncTick += 1, soundboard.loadServerManagement());
  }

  function closeSoundboardPopover() {
    return (realtimeSyncTick += 1, soundboard.closePopover());
  }

  function closeSoundboardEditor() {
    return (realtimeSyncTick += 1, soundboard.closeEditor());
  }

  function selectSoundboardDefaultIcon(value: string) {
    return (realtimeSyncTick += 1, soundboard.selectDefaultIcon(value));
  }

  function selectSoundboardCustomIcon(emoji: CustomEmoji | LocalEmojiItem, originServerID = server?.server_id ?? "") {
    return (realtimeSyncTick += 1, soundboard.selectCustomIcon(emoji, originServerID));
  }

  // ── Emoji wrappers (implementation lives in EmojiController) ───────────────

  function handleMessageListKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("button[data-emoji-token]")
      : null;
    if (!target) return;
    event.preventDefault();
    target.click();
  }

  async function prepareMessageEmojiAssets(nextMessages: Array<Pick<Message, "content">>) {
    return (realtimeSyncTick += 1, emoji.prepareMessageAssets(nextMessages));
  }

  function updateEmojiPickerPosition() {
    return (realtimeSyncTick += 1, emoji.updatePickerPosition());
  }

  async function openEmojiPicker(anchor = emojiPickerAnchorElement, purpose: "composer" | "soundboard" = "composer") {
    return (realtimeSyncTick += 1, emoji.openPicker(anchor, purpose));
  }

  function closeEmojiPicker() {
    return (realtimeSyncTick += 1, emoji.closePicker());
  }

  async function loadServerEmojiManagement() {
    return (realtimeSyncTick += 1, emoji.loadServerManagement());
  }

  function resetEmojiAddDialog() {
    return (realtimeSyncTick += 1, emoji.resetAddDialog());
  }

  function clearServerEmojiUpload() {
    return (realtimeSyncTick += 1, emoji.clearServerUpload());
  }

  function closeEmojiEditor() {
    return (realtimeSyncTick += 1, emoji.closeEditor());
  }

  function cancelServerEmojiEdit() {
    return (realtimeSyncTick += 1, emoji.cancelServerEdit());
  }

  // ── Members, roles & permissions actions ────────────────────────────────────
    function ensureSelectedRole() {
    return (realtimeSyncTick += 1, permissionsController.ensureSelectedRole());
  }

  function filteredAssignableRolesForMemberMenu() {
    const query = memberRoleMenuSearch.trim().toLocaleLowerCase();
    return permissionsController.assignableRoles().filter((role) => !query || role.name.toLocaleLowerCase().includes(query));
  }

  function toggleMemberRoleMenu(memberIdValue: string) {
    memberRoleMenuId = memberRoleMenuId === memberIdValue ? "" : memberIdValue;
    memberRoleMenuSearch = "";
    identityMemberPickerOpen = null;
  }

  function memberAssignedRoleLabel(member: Member) {
    const assigned = permissionsController.assignableRoles().filter((role) => member.role_ids.includes(role.role_id));
    if (assigned.length === 0) return t("roles.noRoles");
    if (assigned.length === 1) return assigned[0].name;
    return t("roles.assignedCount", { count: assigned.length });
  }

  async function loadChannelPermissionOverrides(force = false) {
    return (realtimeSyncTick += 1, permissionsController.loadChannelPermissionOverrides(force));
  }
    function rebuildChannelPermissionTargets() {
    return (realtimeSyncTick += 1, permissionsController.rebuildChannelPermissionTargets());
  }
    function closeChannelPermissionTargetPicker() {
    return (realtimeSyncTick += 1, permissionsController.closeChannelPermissionTargetPicker());
  }
    function updateChannelPermissionTargetMenuPosition() {
    permissionsController.updateChannelPermissionTargetMenuPosition();
    realtimeSyncTick += 1;
  }

  async function saveChannelPermissionChanges() {
    return (realtimeSyncTick += 1, permissionsController.saveChannelPermissionChanges());
  }

  // ── Audio devices, volumes, voice moderation & latency actions ──────────────

  function updateAccompanimentVolumePopoverPosition() {
    return (realtimeSyncTick += 1, accompaniment.updateVolumePopoverPosition());
  }

  function closeAccompanimentVolumePopover(restoreFocus = false) {
    return (realtimeSyncTick += 1, accompaniment.closeVolumePopover(restoreFocus));
  }

  // ── Voice & screen-share WebRTC media actions (tracks, peer mesh, stats) ────

  // ── Native (Tauri) voice session actions ────────────────────────────────────
  // Voice level monitoring (analyser, rAF loop, speaking detection) moved
  // into VoiceSessionController.

  // ── Remote audio playback, mic/headphone tests & message formatting ─────────
  // Remote voice playback lives in lib/remote-audio.ts (RemoteVoiceMixer):
  // the AudioContext graph, gain/limiter/de-click chain, muted render anchors,
  // and per-member volume ramps are all owned by remoteVoiceMixer below.

  function attachRemoteScreenShare(
    remotePeerId: string,
    remoteMemberId: string,
    _stream: MediaStream,
    track: MediaStreamTrack
  ) {
    const share = screenShare.screenShareForMember(remoteMemberId);
    if (share) {
      transport.bindScreenSharePeerConnectionToShare(remotePeerId, share.share_id);
    }
    screenShare.setRemoteScreenShareStream(remoteMemberId, new MediaStream([track]));
    track.addEventListener(
      "ended",
      () => {
        const shareId = transport.screenShareIdForPeerConnection(remotePeerId);
        screenShare.removeRemoteScreenShareStream(remoteMemberId);
        screenShare.scheduleReconnect(shareId, 400);
      },
      { once: true }
    );
  }

  // ── Storage, server rail, layout & language actions ─────────────────────────

  // ── Server rail wrappers (implementation lives in ServerRailController) ─────

  function clearActiveServerWorkspace(preserveServerId = "") {
    const preserveVoiceConnection = Boolean(voiceConnectionContext);
    realtime.closeEventSocket();
    realtime.stopVoiceStatesRefreshLoop();
    if (preserveVoiceConnection) void realtime.ensureVoiceEventSocket(true);
    else nativeVoice.stopVoiceSession({ clearVoicePanel: true });
    transport.stopWebScreenShareSignalPolling();
    transport.stopLocalScreenShareStream();
    storedCredential = null;
    activeServerId = preserveServerId;
    saveActiveServerId(preserveServerId);
    memberId = "";
    sessionToken = "";
    isOwner = false;
    server = null;
    serverReportedClientUpdateRequired = false;
    channelsController.replaceChannels([]);
    members = [];
    messagesController.messages = [];
    voiceState.voiceStates = [];
    clearMessageSelection();
    voiceStage.selectedVoiceParticipantIds = new Set<string>();
    voiceStage.voiceParticipantSelectionAnchorId = "";
    screenShare.replaceScreenShareSessions([]);
    accompaniment.resetWorkspaceState();
    soundboard.resetWorkspaceState();
    emoji.resetWorkspaceState();
    serverRail.resetWorkspaceState();
    void remoteControl.resetClientState();
    permissionsController.roles = [];
    permissionsController.selectedRoleId = "everyone";
    permissionsController.roleDraft = null;
    permissionsController.rolePreviewId = "";
    composer.clearComposerAttachmentObjectURLs();
    composer.clearMessageAttachmentObjectURLs();
    selectedChannelId = "";
    voiceStage.clearMemberAccessFilter();
    memberSearchOpen = false;
    memberSearchQuery = "";
    serverSettingsController.serverSettingsOpen = false;
    serverDetailsOpen = false;
    serverSettingsController.serverProfileSettingsOpen = false;
    serverSettingsController.inviteDialogOpen = false;
    serverSettingsController.generatedInviteLink = "";
    channelSettingsOpen = false;
    workspaceReconnectRequired = false;
    workspaceReconnectBusy = false;
    workspaceConnectionError = "";
    statusKey = "status.disconnected";
  }

  function showWorkspaceReconnect(serverId: string, message: string) {
    clearActiveServerWorkspace(serverId);
    workspaceReconnectRequired = true;
    workspaceConnectionError = message || t("workspace.connectionFailedDescription");
  }

  async function retryWorkspaceConnection() {
    const savedServer = activeSavedServerValue;
    if (!savedServer || workspaceReconnectBusy) return;
    workspaceReconnectBusy = true;
    workspaceConnectionError = "";
    try {
      const credential = await loadCredential(savedServer.server_id);
      if (!credential) {
        connectBaseUrl = normalizeDevelopmentBaseUrl(savedServer.base_url);
        connectUseSavedCredential = false;
        await workspace.connectToServer();
        return;
      }
      await reconnectToServer(credential);
    } catch (caught) {
      showWorkspaceReconnect(savedServer.server_id, workspace.connectionFailureMessage(caught));
    } finally {
      connectUseSavedCredential = true;
      workspaceReconnectBusy = false;
    }
  }

  function openWorkspaceCredentialDialog() {
    const savedServer = activeSavedServerValue;
    if (!savedServer) return;
    connectBaseUrl = normalizeDevelopmentBaseUrl(savedServer.base_url);
    connectPassword = "";
    connectMode = "address";
    connectInviteLink = "";
    connectError = "";
    connectUseSavedCredential = false;
    connectDialogOpen = true;
  }

  function openConnectDialog() {
    connectBaseUrl = nativeDesktopRuntime || webDevelopmentRuntime ? defaultServerBaseUrl : "";
    connectPassword = "";
    connectMode = "address";
    connectInviteLink = "";
    connectError = "";
    connectUseSavedCredential = true;
    connectDialogOpen = true;
  }

  function closeConnectDialog() {
    connectAttemptId += 1;
    connectAbortController?.abort("cancelled");
    connectAbortController = null;
    connectBusy = false;
    connectDialogOpen = false;
    connectError = "";
    connectInviteLink = "";
    connectUseSavedCredential = true;
  }

  function normalizeDevelopmentBaseUrl(value: string) {
    const trimmed = value.trim().replace(/\/+$/, "");
    return legacyDefaultServerBaseUrls.has(trimmed) ? defaultServerBaseUrl : trimmed || defaultServerBaseUrl;
  }

  function validatedServerBaseUrl(value: string) {
    const normalized = value.trim() ? normalizeDevelopmentBaseUrl(value) : "";
    const validation = validateServerURL(normalized, serverURLValidationOptions({
      desktop: nativeDesktopRuntime,
      development: import.meta.env.DEV
    }));
    if (!validation.ok) {
      const errorKeys: Record<ServerURLValidationCode, string> = {
        empty: "error.serverUrlRequired",
        invalid: "error.serverUrlInvalid",
        unsupported_protocol: "error.serverUrlProtocol",
        web_https_required: "error.webHttpsRequired"
      };
      throw new Error(t(errorKeys[validation.code]));
    }
    return validation.url;
  }

  function setVoiceStageMemberDisplayMode(mode: VoiceStageMemberDisplayMode) {
    voiceStageMemberDisplayMode = mode;
    localStorage.setItem(voiceStageMemberDisplayModeStorageKey, mode);
  }

  function serverInitials(name: string) {
    return name.trim().slice(0, 2).toUpperCase() || "EV";
  }

  function loadImportedLanguage(): LanguagePack | null {
    const raw = localStorage.getItem("ev.language.imported");
    if (!raw) return null;
    try {
      return parseLanguagePack(raw);
    } catch {
      localStorage.removeItem("ev.language.imported");
      return null;
    }
  }

  function loadInitialLanguage(): LanguagePack {
    const imported = loadImportedLanguage();
    const selected = localStorage.getItem("ev.language.selected");
    if (imported && selected === imported.id) return imported;
    return builtInLanguages.find((language) => language.id === selected) ?? defaultLanguage;
  }

  function changeLanguage() {
    const next = languageOptions().find((language) => language.id === selectedLanguageId) ?? defaultLanguage;
    languagePack = next;
    localStorage.setItem("ev.language.selected", next.id);
  }

  async function importLanguageFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const imported = parseLanguagePack(await file.text());
      importedLanguagePack = imported;
      languagePack = imported;
      selectedLanguageId = imported.id;
      localStorage.setItem("ev.language.imported", JSON.stringify(imported));
      localStorage.setItem("ev.language.selected", imported.id);
      error = "";
      statusKey = "language.imported";
    } catch {
      error = t("language.importFailed");
    } finally {
      input.value = "";
    }
  }

  function exportLanguageTemplate() {
    downloadTextFile(
      "echovoice-language-template.json",
      JSON.stringify(buildLanguageTemplate(), null, 2),
      "application/json"
    );
  }

  function selectLanguage(languageId: string) {
    selectedLanguageId = languageId;
    settingsSelectMenuOpen = null;
    changeLanguage();
  }

  function toggleSettingsSelectMenu(menu: SettingsSelectMenu) {
    settingsSelectMenuOpen = settingsSelectMenuOpen === menu ? null : menu;
  }

  function downloadTextFile(fileName: string, content: string, type: string) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  // ── Dev-only diagnostic surface (workspace browser E2E harness) ─────────────
  if (import.meta.env.DEV) {
    // Diagnostic surface for the workspace browser E2E harness. DEV builds
    // only; production bundles never expose internal realtime state.
    (window as unknown as Record<string, unknown>).__evPageBootAtMS = Date.now();
    Object.defineProperty(window, "__evVoiceMediaSources", {
      configurable: true,
      get: () => remoteVoiceMixer.devMediaSources()
    });
    (window as unknown as Record<string, unknown>).__evRealtimeDebug = {
      connectedVoiceStates: () => connectedVoiceStates.map((item) => ({
        participant_id: item.participant_id,
        member_id: item.member_id,
        channel_id: item.channel_id,
        is_speaking: item.is_speaking
      })),
      peerCount: () => voiceSession.peerConnectionCount,
      peerStates: () => voiceSession.peerConnectionStates,
      context: () => voiceConnectionContext ? {
        channelId: voiceConnectionContext.channelId,
        participantId: voiceConnectionContext.state.participant_id,
        memberId: voiceConnectionContext.memberId
      } : null,
      screenShareSessionsCount: () => screenShareSessions.length,
      localScreenShareStreamPresent: () => Boolean(localScreenShareStream),
      focusedScreenShareId: () => screenShare.focusedScreenShareId,
      currentMemberScreenShareId: () => currentMemberScreenShare?.share_id ?? "",
      voiceConnectionStatus: () => voiceConnectionStatus,
      eventSocketState: () => realtime.eventSocket?.readyState ?? -1,
      voiceStatesCount: () => voiceStates.length,
      transportActive: () => nativeVoice.voiceTransportActive(),
      sessionTokenPresent: () => Boolean(sessionToken),
      memberIdPresent: () => Boolean(memberId),
      renderAnchorCount: () => remoteVoiceMixer.renderAnchorCount,
      remoteAudioContextState: () => remoteVoiceMixer.audioContextState,
      forceDropEventSocket: () => {
        // Simulates a network drop for E2E reconnect testing: closes the
        // workspace socket so the normal onclose reconnect path runs.
        realtime.eventSocket?.close();
      },
      inboundAudioBytes: async () => voiceSession.inboundAudioBytesTotal(),
    };
  }

  // ── Lifecycle: mount wiring and destroy teardown ────────────────────────────
  onMount(() => {
    if (insecureWebRuntime) return;
    // Keeps the controller-backed $: aliases fresh (see the alias block above).
    // Bumping a tracked component let forces the legacy compiler to re-run the
    // alias statements, which read the controllers' $state fields directly.
    const realtimeSyncTimer = window.setInterval(() => {
      realtimeSyncTick += 1;
    }, 100);
    realtime.setLocalScreenSharePreviewRendering(
      document.visibilityState === "visible" && document.hasFocus()
    );
    void serverRail.initializeStorage();
    workspace.openInitialOnboarding();
    if (!nativeDesktopRuntime && !screenSharePopoutMode) {
      void audio.initializeWebPermissions();
    }
    if (nativeDesktopRuntime && !screenSharePopoutMode) {
      void screenShareSetup.ensureDesktopMediaCapabilities();
    }
    document.addEventListener("contextmenu", handleGlobalContextMenu, true);
    if (!screenSharePopoutMode) {
      void startNativeRemoteControlLocalInputEvents();
      // Remote control heartbeat + respect-window clocks live in the controller.
      remoteControl.startTimers();
      document.addEventListener("pointerdown", handleGlobalPointerDown);
      document.addEventListener("keydown", handleGlobalKeyDown, true);
      window.addEventListener("resize", layout.handleLayoutResize);
    }
    realtime.attachWindowListeners();
    tabVisibility.start();
    return () => {
      window.clearInterval(realtimeSyncTimer);
      document.removeEventListener("contextmenu", handleGlobalContextMenu, true);
      if (!screenSharePopoutMode) {
        document.removeEventListener("pointerdown", handleGlobalPointerDown);
        document.removeEventListener("keydown", handleGlobalKeyDown, true);
        window.removeEventListener("resize", layout.handleLayoutResize);
      }
      realtime.detachWindowListeners();
      tabVisibility.stop();
    };
  });
  onDestroy(() => {
    connectAbortController?.abort("destroyed");
    closeEmojiEditor();
    resetEmojiAddDialog();
    closeServerProfileAvatarCrop();
    workspace.closeProfileAvatarCrop();
    cancelServerIconCrop();
    layout.finishChannelPanelResize();
    layout.finishMemberPanelResize();
    composer.dispose();
    document.body.classList.remove("server-rail-drag-active");
    clearFileDrag();
    closeFilePreview();
    channelsController.clearCategoryDragExpandTimer();
    closeVoiceChannelTip();
    voiceStage.stopVoiceParticipantDurationClock();
    remoteControl.releaseActiveCapture();
    realtime.dispose();
    void audio.stopMicrophoneTest();
    nativeVoice.stopVoiceSession();
    for (const timer of audio.nativeMemberVolumeSyncTimers.values()) window.clearTimeout(timer);
    audio.nativeMemberVolumeSyncTimers.clear();
    for (const timer of audio.nativeMemberMusicVolumeSyncTimers.values()) window.clearTimeout(timer);
    audio.nativeMemberMusicVolumeSyncTimers.clear();
    if (audio.microphonePopoverCloseTimer) window.clearTimeout(audio.microphonePopoverCloseTimer);
    for (const uiSound of activeUISounds) {
      uiSound.pause();
      uiSound.src = "";
    }
    activeUISounds.clear();
    soundboard.stopAllAudio();
    emoji.revokeObjectURLs();
    clearServerEmojiUpload();
    remoteVoiceMixer.dispose();
    transport.dispose();
    stopNativeRemoteControlLocalInputEvents();
    remoteControl.stop();
    void screenShareSetup.stopNativeSender();
  });

</script>

<!-- ── Pre-shell guards & desktop window chrome ──────────────────────────────── -->

{#if insecureWebRuntime}
  <main class="web-secure-context-required" role="alert">
    <span class="material-symbols-rounded app-icon" aria-hidden="true">lock</span>
    <h1>{t("app.webSecureContextRequiredTitle")}</h1>
    <p>{t("app.webSecureContextRequiredDescription")}</p>
  </main>
{/if}

{#if customDesktopWindow}

  <DesktopTitleBar
    t={t}
    workspace={workspace}
    channelsController={channelsController}
    appIconURL={appIconURL}
    realtimeSyncTick={realtimeSyncTick}
  />
{/if}

{#if !screenSharePopoutMode}

  <RemoteControlHostBanner
    t={t}
    workspace={workspace}
    permissionsController={permissionsController}
    remoteControl={remoteControl}
    canHostRemoteControl={canHostRemoteControl}
    realtimeSyncTick={realtimeSyncTick}
  />
{/if}

{#if nativeDesktopRuntime && screenSharePopoutMode}
  <ScreenSharePopoutResizeHandles transport={transport} />
{/if}

<!-- ── Main application shell ──────────────────────────────────────────────────
     Layout order: server rail → channel sidebar → user status panel →
     content panel (chat/files/voice) → member panel. Split targets are listed
     in docs/development/App.svelte-拆分计划.md; keep global class names while
     extracting components so app.css keeps working unchanged. -->

<main
  class="app-shell"
  class:screen-share-popout-mode={screenSharePopoutMode}
  class:native-desktop-window={customDesktopWindow}
  class:native-screen-share-popout-window={nativeDesktopRuntime && screenSharePopoutMode}
  class:no-server-selected={!activeServerId}
  class:workspace-reconnect-required={workspaceReconnectRequired}
  data-local-screen-share-preview-rendering={localScreenSharePreviewRenderingEnabled ? "enabled" : "paused"}
  style={`--channel-panel-width: ${channelPanelWidth}px; --member-panel-width: ${memberPanelWidth}px; --user-status-panel-height: ${userStatusPanelHeight}px;`}
  use:screenSharePopoutDrag
>
  {#if nativeDesktopRuntime && screenSharePopoutMode}
    <ScreenSharePopoutControls
      t={t}
      audio={audio}
      transport={transport}
      focusedScreenShare={focusedScreenShare}
    />
  {/if}

  <RolePreviewBanner
    t={t}
    permissionsController={permissionsController}
  />
  <!-- ── Server rail panel ─────────────────────────────────────────────────── -->

  <ServerRailPanel
    serverRail={serverRail}
    workspace={workspace}
    t={t}
    openConnectDialog={openConnectDialog}
    realtimeSyncTick={realtimeSyncTick}
    activeServerId={activeServerId}
  />
  {#if serverRailTooltip && !serverRailDrag}
    <span
      class="server-rail-tooltip"
      role="tooltip"
      style={`left: ${serverRailTooltip.left}px; top: ${serverRailTooltip.top}px;`}
    >{serverRailTooltip.label}</span>
  {/if}
  {#if serverRailDrag}
    <div
      class="server-rail-drag-preview"
      style={`left: ${Math.round(serverRailDragX + 14)}px; top: ${Math.round(serverRailDragY + 14)}px;`}
      aria-hidden="true"
    >
      {#if serverRailDrag.type === "server"}
        {@const draggedServer = serverRailSavedServersByID.get(serverRailDrag.id)}
        <span class="server-rail-drag-preview-icon" class:has-icon={Boolean(draggedServer?.icon_data_url)}>
          {#if draggedServer?.icon_data_url}
            <img src={draggedServer.icon_data_url} alt="" />
          {:else}
            {serverInitials(draggedServer?.name ?? "EV")}
          {/if}
        </span>
      {:else}
        <span class="material-symbols-rounded app-icon server-rail-drag-preview-folder" aria-hidden="true">folder</span>
      {/if}
      <strong>{serverRail.draggedLabel()}</strong>
    </div>
  {/if}

  {#if !activeServerId}
    <HomeEmptyState
      appContentIconURL={appContentIconURL}
    />
  {/if}

  <WorkspaceReconnectPanel
    workspace={workspace}
    t={t}
    retryWorkspaceConnection={retryWorkspaceConnection}
    openWorkspaceCredentialDialog={openWorkspaceCredentialDialog}
    realtimeSyncTick={realtimeSyncTick}
  />
  <!-- ── Channel sidebar panel ─────────────────────────────────────────────── -->

  <ChannelSidebar
    t={t}
    workspace={workspace}
    channelsController={channelsController}
    permissionsController={permissionsController}
    serverSettingsController={serverSettingsController}
    voiceState={voiceState}
    voiceStage={voiceStage}
    screenShare={screenShare}
    accompaniment={accompaniment}
    composer={composer}
    audio={audio}
    serverMenuOpen={serverMenuOpen}
    toggleServerMenu={toggleServerMenu}
    openServerDetails={openServerDetails}
    voiceActionBusy={voiceActionBusy}
    voiceChannelTip={voiceChannelTip}
    selectedVoiceParticipantIds={selectedVoiceParticipantIds}
    voiceParticipantDragOverChannelId={voiceParticipantDragOverChannelId}
    voiceParticipantPointerPress={voiceParticipantPointerPress}
    canDragVoiceParticipant={voiceStage.canDragVoiceParticipant}
    handleVoiceParticipantKeydown={voiceStage.handleVoiceParticipantKeydown}
    handleVoiceParticipantMouseDown={voiceStage.handleVoiceParticipantMouseDown}
    handleVoiceParticipantPointerCancel={voiceStage.handleVoiceParticipantPointerCancel}
    handleVoiceParticipantPointerDown={voiceStage.handleVoiceParticipantPointerDown}
    handleVoiceParticipantPointerMove={voiceStage.handleVoiceParticipantPointerMove}
    handleVoiceParticipantPointerUp={voiceStage.handleVoiceParticipantPointerUp}
    openVoiceParticipantContextMenu={voiceStage.openVoiceParticipantContextMenu}
    realtimeSyncTick={realtimeSyncTick}
  />
  <!-- ── User status / voice connection panel ──────────────────────────────── -->

  <UserStatusPanel
    t={t}
    workspace={workspace}
    voiceState={voiceState}
    voiceSession={voiceSession}
    voiceStage={voiceStage}
    audio={audio}
    screenShare={screenShare}
    screenShareSetup={screenShareSetup}
    transport={transport}
    accompaniment={accompaniment}
    soundboard={soundboard}
    nativeVoice={nativeVoice}
    channelsController={channelsController}
    permissionsController={permissionsController}
    remoteAudioPlaybackBlocked={remoteAudioPlaybackBlocked}
    prepareVoiceAudioPlayback={() => remoteVoiceMixer.preparePlayback()}
    screenShareActionBusy={screenShareActionBusy}
    voiceActionBusy={voiceActionBusy}
    voiceConnectionNavigationBusy={voiceConnectionNavigationBusy}
    set_accompanimentVolumePopoverAnchor={(value) => { accompanimentVolumePopoverAnchor = value; }}
    set_accompanimentVolumePopoverElement={(value) => { accompanimentVolumePopoverElement = value; }}
    set_soundboardPopoverAnchor={(value) => { soundboardPopoverAnchor = value; }}
    measureUserStatusPanel={layout.measureUserStatusPanel}
    realtimeSyncTick={realtimeSyncTick}
    currentVoiceStateValue={currentVoiceStateValue}
    voiceConnectionContext={voiceConnectionContext}
  />
  <button
    type="button"
    class="channel-panel-resizer"
    class:active={channelPanelResizing}
    aria-label={t("layout.resizeChannelPanel")}
    title={t("layout.resizeChannelPanel")}
    onpointerdown={layout.startChannelPanelResize}
    onkeydown={layout.handleChannelPanelResizeKeydown}
  ></button>
  <!-- ── Content panel (chat header, messages, composer, files, voice stage) ── -->  <ContentPanel
    workspace={workspace}
    serverRail={serverRail}
    serverSettingsController={serverSettingsController}
    channelsController={channelsController}
    permissionsController={permissionsController}
    messagesController={messagesController}
    channelFiles={channelFiles}
    composer={composer}
    voiceState={voiceState}
    voiceSession={voiceSession}
    voiceStage={voiceStage}
    screenShare={screenShare}
    screenShareSetup={screenShareSetup}
    transport={transport}
    realtime={realtime}
    remoteControl={remoteControl}
    accompaniment={accompaniment}
    soundboard={soundboard}
    emoji={emoji}
    audio={audio}
    nativeVoice={nativeVoice}
    t={t}
    accompanimentMemberIds={accompanimentMemberIds}
    canDownloadFiles={canDownloadFiles}
    canManageFiles={canManageFiles}
    canSendMessages={canSendMessages}
    canUploadFiles={canUploadFiles}
    canViewFiles={canViewFiles}
    channelContentMode={channelContentMode}
    composerPlaceholder={composerPlaceholder}
    currentMemberActiveScreenShare={currentMemberActiveScreenShare}
    downloadMessageAttachment={downloadMessageAttachment}
    emojiAutocompleteSelectedIndex={emojiAutocompleteSelectedIndex}
    ensureMessageAttachmentPreview={ensureMessageAttachmentPreview}
    ensureMessageImagePreview={ensureMessageImagePreview}
    error={error}
    fileStorageAvailable={fileStorageAvailable}
    focusedActiveRemoteControl={focusedActiveRemoteControl}
    focusedMemberRemoteControl={focusedMemberRemoteControl}
    focusedScreenShare={focusedScreenShare}
    focusedScreenShareId={focusedScreenShareId}
    handleFileEntryPointerDown={handleFileEntryPointerDown}
    handleMessageListKeydown={handleMessageListKeydown}
    handleVoiceParticipantKeydown={voiceStage.handleVoiceParticipantKeydown}
    handleVoiceParticipantMouseDown={voiceStage.handleVoiceParticipantMouseDown}
    handleVoiceParticipantPointerCancel={voiceStage.handleVoiceParticipantPointerCancel}
    handleVoiceParticipantPointerDown={voiceStage.handleVoiceParticipantPointerDown}
    handleVoiceParticipantPointerMove={voiceStage.handleVoiceParticipantPointerMove}
    handleVoiceParticipantPointerUp={voiceStage.handleVoiceParticipantPointerUp}
    memberId={memberId}
    memberPanelMembers={memberPanelMembers}
    members={members}
    bind:messageSearchQuery={messageSearchQuery}
    observeMessageAttachmentPreview={observeMessageAttachmentPreview}
    observeMessageImagePreview={observeMessageImagePreview}
    openMessageAttachmentPreview={openMessageAttachmentPreview}
    openMessageImagePreview={openMessageImagePreview}
    openVoiceParticipantContextMenu={voiceStage.openVoiceParticipantContextMenu}
    screenShareActionBusy={screenShareActionBusy}
    screenSharePopoutMode={screenSharePopoutMode}
    screenShareViewerCount={screenShareViewerCount}
    screenShareViewerIds={screenShareViewerIds}
    screenShareViewerPanelTitle={screenShareViewerPanelTitle}
    selectedChannelTitle={selectedChannelTitle}
    selectedVoiceParticipantIds={selectedVoiceParticipantIds}
    selectedVoiceScreenShares={selectedVoiceScreenShares}
    selectedVoiceStates={selectedVoiceStates}
    server={server}
    set_composerAttachmentInputElement={(element) => (composerAttachmentInputElement = element)}
    set_composerEditorElement={(element) => (composerEditorElement = element)}
    set_composerInputShellElement={(element) => (composerInputShellElement = element)}
    set_fileInputElement={(element) => (fileInputElement = element)}
    set_focusedScreenShareVideoElement={(element) => (focusedScreenShareVideoElement = element)}
    set_localScreenShareVideoElement={(element) => (localScreenShareVideoElement = element)}
    set_messageEditEditorElement={(element) => (messageEditEditorElement = element)}
    set_messageListElement={(element) => (messageListElement = element)}
    set_screenShareFocusElement={(element) => (screenShareFocusElement = element)}
    setVoiceStageMemberDisplayMode={setVoiceStageMemberDisplayMode}
    voiceActionBusy={voiceActionBusy}
    voiceParticipantPointerPress={voiceParticipantPointerPress}
    voiceStageMemberDisplayMode={voiceStageMemberDisplayMode}
    canHostRemoteControl={canHostRemoteControl}
  />
  {#if messageContextMenu && messageContextMenuValue}
    <div
    class="message-context-menu"
    role="menu"
    style={messagesController.messageContextMenuStyle(messageContextMenu)}
  >
      {#if messageContextMenuSelectionValues.length > 1}
        <div class="context-selection-summary">
          <span class="material-symbols-rounded app-icon" aria-hidden="true">done_all</span>
          <span>{t("messages.selectedCount", { count: messageContextMenuSelectionValues.length })}</span>
        </div>
      {/if}
      {#if messageContextMenuSelectionValues.some((message) => messagesController.canCopyMessage(message))}
        <button type="button" role="menuitem" onclick={messagesController.copyContextMenuMessage}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">content_copy</span>
          <span>{messageContextMenuSelectionValues.length > 1 ? t("messages.copySelected") : t("messages.copy")}</span>
        </button>
      {/if}
      {#if messageContextMenuSelectionValues.length === 1 && !messagesController.isLocalMessage(messageContextMenuValue) && !messageContextMenuValue.deleted_at_ms}
        <button type="button" role="menuitem" onclick={() => composer.replyContextMenuMessage()}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">reply</span>
          <span>{t("messages.reply")}</span>
        </button>
      {/if}
      {#if messageContextMenuSelectionValues.length === 1 && messagesController.canEditMessage(messageContextMenuValue)}
        <button type="button" role="menuitem" onclick={messagesController.editContextMenuMessage}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">edit</span>
          <span>{t("messages.edit")}</span>
        </button>
      {/if}
      {#if messageContextMenuSelectionValues.some((message) => messagesController.canDeleteMessage(message))}
        <button class="danger" type="button" role="menuitem" onclick={messagesController.deleteContextMenuMessage}>
          <span class="material-symbols-rounded app-icon" aria-hidden="true">delete</span>
          <span>{messageContextMenuSelectionValues.length > 1 ? t("messages.deleteSelected", { count: messageContextMenuSelectionValues.filter((message) => messagesController.canDeleteMessage(message)).length }) : t("messages.delete")}</span>
        </button>
      {/if}
    </div>
  {/if}
  <button
    type="button"
    class="member-panel-resizer"
    class:active={memberPanelResizing}
    aria-label={t("layout.resizeMemberPanel")}
    title={t("layout.resizeMemberPanel")}
    onpointerdown={layout.startMemberPanelResize}
    onkeydown={layout.handleMemberPanelResizeKeydown}
  ></button>
  <!-- ── Member panel ──────────────────────────────────────────────────────── -->

  <MemberPanel
    t={t}
    workspace={workspace}
    voiceStage={voiceStage}
    voiceState={voiceState}
    permissionsController={permissionsController}
    channelsController={channelsController}
    screenShare={screenShare}
    audio={audio}
    openMemberContextMenu={voiceStage.openMemberContextMenu}
    handleMemberContextMenuKeydown={voiceStage.handleMemberContextMenuKeydown}
    setMemberSearchInputElement={(value) => { memberSearchInputElement = value; }}
    realtimeSyncTick={realtimeSyncTick}
  />

</main>

<!-- ═══════════════════════════════════════════════════════════════════════════
     Root-level overlays, menus & dialogs
     These render after the shell so they can overlay it without affecting
     panel layout. Extract bottom-up (small menus first, chat later) and keep
     the original DOM/class names until styles move with the component.
     ════════════════════════════════════════════════════════════════════════ -->
<ServerContextMenu t={t} serverRail={serverRail} />
<ServerFolderContextMenu t={t} serverRail={serverRail} />

{#if appDialog}
  <div class="app-dialog-backdrop" role="presentation" onmousedown={(event) => { if (event.target !== event.currentTarget) return; const handler = (() => appDialog?.dismissible && cancelAppDialog()); if (handler) return handler(event); }}>
    <dialog
      class="app-dialog"
      class:danger={appDialog.danger}
      class:profile-comparison={Boolean(appDialog.profileComparison)}
      class:member-card-dialog={Boolean(appDialog.memberCard)}
      open
      aria-modal="true"
      aria-labelledby="app-dialog-title"
      aria-describedby="app-dialog-message"
      onkeydown={handleAppDialogKeydown}
    >
      <header>
        <span class="app-dialog-icon material-symbols-rounded app-icon" aria-hidden="true">
          {appDialog.danger ? "warning" : appDialog.kind === "prompt" ? "edit" : "info"}
        </span>
        <h2 id="app-dialog-title">{appDialog.title}</h2>
        {#if appDialog.dismissible}
          <button class="app-dialog-close" type="button" aria-label={t("app.close")} onclick={cancelAppDialog}>
            <span class="material-symbols-rounded app-icon" aria-hidden="true">close</span>
          </button>
        {:else}
          <span aria-hidden="true"></span>
        {/if}
      </header>
      <div class="app-dialog-body">
        {#if appDialog.kind === "prompt"}
          <label id="app-dialog-message">
            <span>{appDialog.message}</span>
            <input bind:this={appDialogInputElement} bind:value={appDialogInputValue} autocomplete="off" />
          </label>
        {:else if appDialog.profileComparison}
          <div id="app-dialog-message" class="profile-conflict-content">
            <p>{appDialog.message}</p>
            <div class="profile-conflict-cards">
              {#each [appDialog.profileComparison.local, appDialog.profileComparison.server] as profileCard (profileCard.label)}
                <article class="profile-conflict-card">
                  <span class="profile-conflict-label">{profileCard.label}</span>
                  <div class="profile-conflict-identity">
                    <span class="avatar member-avatar profile-conflict-avatar" style={avatarStyleVariables(profileCard.avatarColor, profileCard.identityKey)}>
                      {#if profileCard.avatarDataUrl}
                        <img src={profileCard.avatarDataUrl} alt="" />
                      {:else}
                        {serverInitials(profileCard.displayName)}
                      {/if}
                    </span>
                    <div>
                      <strong>{profileCard.displayName}</strong>
                      <small>{profileCard.updatedAt}</small>
                    </div>
                  </div>
                  <p class:empty={!profileCard.bio}>{profileCard.bio || t("profile.noBio")}</p>
                </article>
              {/each}
            </div>
          </div>
        {:else if appDialog.memberCard}
          <div id="app-dialog-message" class="member-merge-dialog-content">
            <p>{appDialog.message}</p>
            <article class="member-merge-requester-card">
              <span class="avatar member-avatar" style={avatarStyleVariables(appDialog.memberCard.avatarColor, appDialog.memberCard.identityKey)}>
                {#if appDialog.memberCard.avatarDataUrl}
                  <img src={appDialog.memberCard.avatarDataUrl} alt="" />
                {:else}
                  {serverInitials(appDialog.memberCard.displayName)}
                {/if}
              </span>
              <div>
                <span>{appDialog.memberCard.label}</span>
                <strong>{appDialog.memberCard.displayName}</strong>
                <small>{appDialog.memberCard.bio || t("profile.noBio")}</small>
              </div>
            </article>
            <small class="member-merge-request-time">{appDialog.memberCard.updatedAt}</small>
          </div>
        {:else}
          <p id="app-dialog-message">{appDialog.message}</p>
        {/if}
      </div>
      <footer>
        {#if appDialog.kind !== "alert"}
          <button type="button" onclick={cancelAppDialog}>{appDialog.cancelLabel}</button>
        {/if}
        <button
          class="app-dialog-confirm"
          class:danger={appDialog.danger}
          type="button"
          bind:this={appDialogConfirmElement}
          onclick={confirmAppDialog}
        >{appDialog.confirmLabel}</button>
      </footer>
    </dialog>
  </div>
{/if}

<!-- ── Media overlays: accompaniment, soundboard, emoji ──────────────────────── -->
<AccompanimentDialog
  t={t}
  accompaniment={accompaniment}
  nativeDesktopRuntime={nativeDesktopRuntime}
  formatFileSize={(bytes) => channelFiles.formatFileSize(bytes)}
  voiceRangeProgress={(value, maximum) => audio.voiceRangeProgress(value, maximum)}
  setWebAccompanimentFileInput={(element) => (webAccompanimentFileInput = element)}
/>
<SoundboardPopover
  t={t}
  soundboard={soundboard}
  server={server}
  baseUrl={baseUrl}
  savedServers={savedServers}
  canManageServerSoundboard={canManageServerSoundboard}
  tab={soundboardTab}
  onTabChange={(tab) => {
    soundboardTab = tab;
    realtimeSyncTick += 1;
  }}
  sourceServerID={soundboardSourceServerID}
  onSourceServerIDChange={(serverID) => {
    soundboardSourceServerID = serverID;
    realtimeSyncTick += 1;
  }}
  serverInitials={serverInitials}
  emojiObjectURL={(sha256) => emoji.objectURL(sha256)}
  formatFileSize={(bytes) => channelFiles.formatFileSize(bytes)}
  voiceRangeProgress={(value, maximum) => audio.voiceRangeProgress(value, maximum)}
  setPopoverElement={(element) => (soundboardPopoverElement = element)}
  setServerInputElement={(element) => (soundboardServerInputElement = element)}
  setLocalInputElement={(element) => (soundboardLocalInputElement = element)}
  onClose={closeSoundboardPopover}
  onKeydown={(event) => { soundboard.handlePopoverKeydown(event); realtimeSyncTick += 1; }}
  onUploadServer={(event) => { soundboard.uploadServer(event); realtimeSyncTick += 1; }}
  onImportLocal={(event) => { soundboard.importLocal(event); realtimeSyncTick += 1; }}
  onPlayServer={(item, originServerID) => { realtimeSyncTick += 1; return soundboard.playServer(item, originServerID); }}
  onPlayLocal={(item) => { realtimeSyncTick += 1; return soundboard.playLocal(item); }}
  onDeleteServer={(item) => { soundboard.deleteServerItem(item); realtimeSyncTick += 1; }}
  onDeleteLocal={(item) => { soundboard.deleteLocalItem(item); realtimeSyncTick += 1; }}
  onOpenEditor={(target) => { soundboard.openEditor(target); realtimeSyncTick += 1; }}
  onPlaybackVolume={(event) => { soundboard.changePlaybackVolume(event); realtimeSyncTick += 1; }}
  onListeningVolume={(event) => { soundboard.changeListeningVolume(event); realtimeSyncTick += 1; }}
/>
<SoundboardEditorDialog
  t={t}
  soundboard={soundboard}
  emoji={emoji}
  editorName={soundboardEditorName}
  onEditorNameChange={(name) => (soundboardEditorName = name)}
  onEditorDurationChange={(durationMS) => (soundboardEditorDurationMS = durationMS)}
  emojiObjectURL={(sha256) => emoji.objectURL(sha256)}
  voiceRangeProgress={(value, maximum) => audio.voiceRangeProgress(value, maximum)}
  onClose={closeSoundboardEditor}
  onRangeChange={(startMS, endMS) => { soundboard.updateEditorRange(startMS, endMS); realtimeSyncTick += 1; }}
  onBaseVolume={(event) => { soundboard.changeEditorBaseVolume(event); realtimeSyncTick += 1; }}
  onClearIcon={() => { soundboard.clearIcon(); realtimeSyncTick += 1; }}
  onOpenIconPicker={(event) => { soundboard.openIconPicker(event); realtimeSyncTick += 1; }}
  onSave={() => { soundboard.saveEditor(); realtimeSyncTick += 1; }}
  onTogglePreview={() => { soundboard.toggleEditorPreview(); realtimeSyncTick += 1; }}
/>
<EmojiPickerPopover
  t={t}
  emoji={emoji}
  server={server}
  savedServers={savedServers}
  canSendEmoji={canSendEmoji}
  soundboardEditorTarget={soundboardEditorTarget}
  searchQuery={emojiSearchQuery}
  onSearchQueryChange={(query) => (emojiSearchQuery = query)}
  hoveredEntry={emojiPickerHoveredEntry}
  onHoveredEntryChange={(entry) => (emojiPickerHoveredEntry = entry)}
  setPickerElement={(element) => (emojiPickerElement = element)}
  setPickerSearchInputElement={(element) => (emojiPickerSearchInputElement = element)}
  onKeydown={(event) => { emoji.handlePickerKeydown(event); realtimeSyncTick += 1; }}
  onCreatePack={() => { realtimeSyncTick += 1; return emoji.createPack(); }}
  onOpenAddDialog={() => { realtimeSyncTick += 1; return emoji.openAddDialog(); }}
  onSelectSection={(sectionID) => { emoji.selectPickerSection(sectionID); realtimeSyncTick += 1; }}
  onSelectEntry={(entry) => { realtimeSyncTick += 1; return emoji.selectPickerEntry(entry); }}
  onDeleteLocalEntry={(entry) => { realtimeSyncTick += 1; return emoji.deleteLocalEntry(entry); }}
/>
<EmojiDetailDialog
  t={t}
  emoji={emoji}
  reference={emojiDetailReference}
  formatFileSize={(bytes) => channelFiles.formatFileSize(bytes)}
  onClose={() => { emoji.closeDetail(); realtimeSyncTick += 1; }}
  onSave={() => { realtimeSyncTick += 1; return emoji.saveDetailToLocal(); }}
/>

<!-- ── Screen share overlays, option menus & popped-out viewers ──────────────── -->
<ScreenShareSetupDialog
  t={t}
  screenShareSetup={screenShareSetup}
  remoteControl={remoteControl}
  server={server}
  screenShareActionBusy={screenShareActionBusy}
  screenShareAudioAvailable={screenShareAudioAvailable}
  currentMemberActiveScreenShare={currentMemberActiveScreenShare}
  isTauriRuntime={isTauriRuntime}
  setResolutionButton={(element) => (screenShareResolutionButtonElement = element)}
  setFrameRateButton={(element) => (screenShareFrameRateButtonElement = element)}
  setBitrateButton={(element) => (screenShareBitrateButtonElement = element)}
  setContentModeButton={(element) => (screenShareContentModeButtonElement = element)}
/>
<ScreenShareOptionMenus t={t} screenShareSetup={screenShareSetup} />
<ScreenShareSourceDialog t={t} screenShareSetup={screenShareSetup} />
<PoppedOutScreenSharePanel
  t={t}
  screenShare={screenShare}
  transport={transport}
  items={poppedOutScreenShareItems}
  memberAvatarStyle={(id) => permissionsController.memberAvatarStyle(id)}
  memberAvatarDataURL={(id) => permissionsController.memberAvatarDataURL(id)}
  memberInitials={(id) => permissionsController.memberInitials(id)}
  memberDisplayName={(id) => permissionsController.memberDisplayName(id)}
  channelDisplayName={(channelId) => channelsController.channelDisplayName(channelId)}
/>
<FilePreviewDialog
  t={t}
  channelFiles={channelFiles}
  memberAvatarStyle={(id) => permissionsController.memberAvatarStyle(id)}
  memberAvatarDataURL={(id) => permissionsController.memberAvatarDataURL(id)}
  memberInitials={(id) => permissionsController.memberInitials(id)}
  memberDisplayName={(id) => permissionsController.memberDisplayName(id)}
/>
<FileDragPreview channelFiles={channelFiles} />
<VoiceParticipantDragPreview
  voiceParticipantDragMemberId={voiceParticipantDragMemberId}
  voiceParticipantDragParticipantId={voiceParticipantDragParticipantId}
  draggedVoiceState={voiceStatesByParticipant.get(voiceParticipantDragParticipantId)}
  previewStyle={voiceParticipantDragPreviewStyleValue}
  isVoiceStateSpeaking={(state) => audio.isVoiceStateSpeaking(state)}
  memberAvatarStyle={(id) => permissionsController.memberAvatarStyle(id)}
  memberAvatarDataURL={(id) => permissionsController.memberAvatarDataURL(id)}
  memberInitials={(id) => permissionsController.memberInitials(id)}
  memberDisplayName={(id) => permissionsController.memberDisplayName(id)}
  selectedVoiceParticipantIds={selectedVoiceParticipantIds}
  hasVoiceRestriction={(state) => audio.hasVoiceRestriction(state)}
  voiceRestrictionIcon={(state) => audio.voiceRestrictionIcon(state)}
/>

<!-- ── File & voice participant drag/context overlays ────────────────────────── -->
<VoiceParticipantContextMenu
  t={t}
  menu={voiceParticipantContextMenu}
  memberValue={voiceParticipantContextMenuMemberValue}
  stateValue={voiceParticipantContextMenuStateValue}
  selectionStates={voiceParticipantContextMenuSelectionStates}
  canMove={voiceParticipantContextMenuCanMove}
  canModerate={voiceParticipantContextMenuCanModerate}
  canManageMember={voiceParticipantContextMenuCanManageMember}
  memberId={memberId}
  channelsController={channelsController}
  memberAvatarStyle={(id) => permissionsController.memberAvatarStyle(id)}
  memberInitials={(id) => permissionsController.memberInitials(id)}
  durationLoading={voiceParticipantDurationLoading}
  durationError={voiceParticipantDurationError}
  durationStats={voiceParticipantDurationStats}
  loadDuration={voiceStage.loadVoiceParticipantDuration}
  displayedDuration={voiceStage.displayedVoiceDuration}
  formatDuration={voiceStage.formatVoiceDuration}
  volumePercent={voiceParticipantMenuVolumePercent}
  musicVolumePercent={voiceParticipantMenuMusicVolumePercent}
  memberVolumeLimitPercent={memberVolumeLimitPercent}
  voiceRangeProgress={(value, maximum) => audio.voiceRangeProgress(value, maximum)}
  accompanimentMemberIds={accompanimentMemberIds}
  resetMemberVolume={(targetMemberId) => audio.resetMemberVolume(targetMemberId)}
  resetMemberMusicVolume={(targetMemberId) => audio.resetMemberMusicVolume(targetMemberId)}
  changeMemberVolume={(targetMemberId, event) => audio.changeMemberVolume(targetMemberId, event)}
  changeMemberMusicVolume={(targetMemberId, event) => audio.changeMemberMusicVolume(targetMemberId, event)}
  canMuteVoiceMembers={canMuteVoiceMembers}
  canDeafenVoiceMembers={canDeafenVoiceMembers}
  canMoveVoiceMembers={canMoveVoiceMembers}
  selectedVoiceStatesAll={voiceStage.selectedVoiceStatesAll}
  voiceManageBusyMemberId={voiceManageBusyMemberId}
  manageVoiceParticipantFromMenu={voiceStage.manageVoiceParticipantFromMenu}
  selectedVoiceContextAllInChannel={voiceStage.selectedVoiceContextAllInChannel}
  moveVoiceParticipantsFromMenu={voiceStage.moveVoiceParticipantsFromMenu}
  kickVoiceParticipantFromMenu={voiceStage.kickVoiceParticipantFromMenu}
  memberUpdating={memberUpdating}
  banVoiceParticipantFromMenu={voiceStage.banVoiceParticipantFromMenu}
/>

<!-- ── Settings & identity dialogs (server profile/details/settings, channel) ─ -->
<ServerProfileDialog
  t={t}
  serverSettings={serverSettingsController}
  server={server}
  currentMember={currentMember}
  localUserProfile={localUserProfile}
  serverProfileSettingsDirty={serverProfileSettingsDirty}
  memberMergeCode={memberMergeCode}
  memberMergeCodeServerID={memberMergeCodeServerID}
  memberMergeCodeExpiresAtMS={memberMergeCodeExpiresAtMS}
  memberMergeCodeCopied={memberMergeCodeCopied}
  memberMergeGenerating={memberMergeGenerating}
  memberMergeCodeInput={memberMergeCodeInput}
  memberMergeSubmitting={memberMergeSubmitting}
  memberMergeOutgoing={memberMergeOutgoing}
  memberMergeStatusMessage={memberMergeStatusMessage}
  onGenerateAccountMergeCode={() => void workspace.generateAccountMergeCode()}
  onCopyAccountMergeCode={() => void workspace.copyAccountMergeCode()}
  onAccountMergeCodeInput={(event) => workspace.updateAccountMergeCodeInput(event)}
  onSubmitAccountMergeRequest={() => void workspace.submitAccountMergeRequest()}
  onFlushAliases={() => {
    realtimeSyncTick += 1;
  }}
/>
<ServerDetailsDialog
  t={t}
  open={serverDetailsOpen}
  server={server}
  members={members}
  channels={channels}
  languageOptions={languageOptions}
  serverInitials={serverInitials}
  auditTime={(createdAtMS) => serverSettingsController.auditTime(createdAtMS)}
  onClose={() => (serverDetailsOpen = false)}
/>
<ServerSettingsDialog
  t={t}
  serverSettings={serverSettingsController}
  permissions={permissionsController}
  emoji={emoji}
  soundboard={soundboard}
  server={server}
  baseUrl={baseUrl}
  members={members}
  channels={channels}
  memberId={memberId}
  isOwner={isOwner}
  currentMember={currentMember}
  currentUserDisplayNameValue={currentUserDisplayNameValue}
  canEditServerSettings={canEditServerSettings}
  canManageRoles={canManageRoles}
  canManageMembers={canManageMembers}
  canManageServerEmoji={canManageServerEmoji}
  canManageServerSoundboard={canManageServerSoundboard}
  serverSettingsDirty={serverSettingsDirty}
  roleSettingsDirty={roleSettingsDirty}
  settingsDirty={settingsDirty}
  error={error}
  settingsSelectMenuOpen={settingsSelectMenuOpen}
  onToggleSettingsSelectMenu={toggleSettingsSelectMenu}
  languageOptions={languageOptions}
  serverInitials={serverInitials}
  formatFileSize={(bytes) => channelFiles.formatFileSize(bytes)}
  memberDisplayName={(id) => permissionsController.memberDisplayName(id)}
  memberAvatarStyle={(id) => permissionsController.memberAvatarStyle(id)}
  memberRoleLabel={(member) => permissionsController.memberRoleLabel(member)}
  serverEmojiEditingShortcode={serverEmojiEditingShortcode}
  onServerEmojiEditingShortcodeChange={(value) => (serverEmojiEditingShortcode = value)}
  auditTargetLabel={auditTargetLabel}
  auditActionLabel={auditActionLabel}
  auditDetails={auditDetails}
  identityLinkPrimaryMemberId={identityLinkPrimaryMemberId}
  identityLinkDuplicateMemberId={identityLinkDuplicateMemberId}
  identityLinkBusy={identityLinkBusy}
  identityMemberPickerOpen={identityMemberPickerOpen}
  identityMemberPickerSearch={identityMemberPickerSearch}
  onIdentityMemberPickerSearchChange={(value) => (identityMemberPickerSearch = value)}
  onToggleIdentityMemberPicker={(kind) => permissionsController.toggleIdentityMemberPicker(kind)}
  filteredIdentityPickerMembers={(kind) => permissionsController.filteredIdentityPickerMembers(kind)}
  selectedIdentityMemberName={(kind) => permissionsController.selectedIdentityMemberName(kind)}
  onSelectIdentityMember={(kind, memberIdValue) => permissionsController.selectIdentityMember(kind, memberIdValue)}
  onLinkSelectedMemberIdentities={() => void permissionsController.linkSelectedMemberIdentities()}
  memberRoleMenuId={memberRoleMenuId}
  memberRoleMenuSearch={memberRoleMenuSearch}
  onMemberRoleMenuSearchChange={(value) => (memberRoleMenuSearch = value)}
  onToggleMemberRoleMenu={toggleMemberRoleMenu}
  memberAssignedRoleLabel={memberAssignedRoleLabel}
  filteredAssignableRolesForMemberMenu={filteredAssignableRolesForMemberMenu}
  onSetMemberRoleAssignment={(member, roleId, enabled) => void permissionsController.setMemberRoleAssignment(member, roleId, enabled)}
  memberEditingId={memberEditingId}
  memberBanDraft={memberBanDraft}
  onMemberBanDraftChange={(value) => (memberBanDraft = value)}
  memberUpdating={memberUpdating}
  onBeginEditMember={(member) => permissionsController.beginEditMember(member)}
  onCancelEditMember={() => permissionsController.cancelEditMember()}
  onSaveMemberChanges={(member) => void permissionsController.saveMemberChanges(member)}
  onRemoveManagedMember={(member) => void permissionsController.removeManagedMember(member)}
  setRoleIconInputElement={(element) => (roleIconInputElement = element)}
  setServerEmojiManagerInputElement={(element) => (serverEmojiManagerInputElement = element)}
  setServerSoundboardManagerInputElement={(element) => (serverSoundboardManagerInputElement = element)}
  onFlushAliases={() => {
    realtimeSyncTick += 1;
  }}
  onClearError={() => {
    error = "";
  }}
/>
<ChannelSettingsDialog
  t={t}
  channels={channelsController}
  permissions={permissionsController}
  members={members}
  canManageChannels={canManageChannels}
  canManageChannelPermissions={canManageChannelPermissions}
  settingsSelectMenuOpen={settingsSelectMenuOpen}
  onToggleSettingsSelectMenu={toggleSettingsSelectMenu}
  languageOptions={languageOptions}
  categoryChannelEntries={categoryChannelEntries}
  error={error}
  memberAvatarStyle={(id) => permissionsController.memberAvatarStyle(id)}
  setChannelTopicTextareaElement={(element) => (channelTopicTextareaElement = element)}
  setChannelPermissionTargetPickerElement={(element) => (channelPermissionTargetPickerElement = element)}
  setChannelPermissionTargetMenuElement={(element) => (channelPermissionTargetMenuElement = element)}
  onFlushAliases={() => {
    realtimeSyncTick += 1;
  }}
/>
<ChannelPermissionTargetPicker
  t={t}
  permissions={permissionsController}
  memberAvatarStyle={(id) => permissionsController.memberAvatarStyle(id)}
  setMenuElement={(element) => (channelPermissionTargetMenuElement = element)}
  onFlushAliases={() => {
    realtimeSyncTick += 1;
  }}
/>

<!-- ── App settings, onboarding & remaining small dialogs ────────────────────── -->
<AppSettingsDialog
  t={t}
  open={appSettingsOpen}
  bind:profileDraft={profileDraft}
    profileSaving={profileSaving}
    profileSaveMessage={profileSaveMessage}
    profileSettingsDirty={profileSettingsDirty}
    localUserProfile={localUserProfile}
    languagePack={languagePack}
    selectedLanguageId={selectedLanguageId}
    settingsSelectMenuOpen={settingsSelectMenuOpen}
    nativeDesktopRuntime={nativeDesktopRuntime}
    voiceInputUnavailable={voiceInputUnavailable}
    localVoiceStream={localVoiceStream}
    nativeVoiceStatus={nativeVoiceStatus}
    audioInputDevicesLoading={audioInputDevicesLoading}
    audioInputDevices={audioInputDevices}
    audioOutputDevices={audioOutputDevices}
    selectedAudioInputDeviceId={selectedAudioInputDeviceId}
    selectedAudioOutputDeviceId={selectedAudioOutputDeviceId}
    noiseSuppressionModes={noiseSuppressionModes}
    noiseSuppressionMode={noiseSuppressionMode}
    microphoneGainPercent={microphoneGainPercent}
    microphoneGainLimitPercent={microphoneGainLimitPercent}
    maximumVoiceGainLimitPercent={maximumVoiceGainLimitPercent}
    voiceInputLevel={voiceInputLevel}
    microphoneTestLevel={microphoneTestLevel}
    microphoneTestActive={microphoneTestActive}
    microphoneTestBusy={microphoneTestBusy}
    outputVolumePercent={outputVolumePercent}
    memberVolumeLimitPercent={memberVolumeLimitPercent}
    headphoneTestBusy={headphoneTestBusy}
    voiceRangeProgress={(value, maximum) => audio.voiceRangeProgress(value, maximum)}
    voiceInputStatusLabel={() => audio.voiceInputStatusLabel()}
    selectedAudioInputLabel={() => audio.selectedAudioInputLabel()}
    selectedAudioOutputLabel={() => audio.selectedAudioOutputLabel()}
    noiseSuppressionModeLabel={(mode) => audio.noiseSuppressionModeLabel(mode)}
    noiseSuppressionModeDescription={(mode) => audio.noiseSuppressionModeDescription(mode)}
    languageOptions={languageOptions}
    onClose={() => workspace.closeAppSettings()}
    onSelectProfileAvatar={(event) => workspace.selectProfileAvatar(event)}
    onClearProfileAvatar={() => workspace.clearProfileAvatar()}
    onSetProfileAvatarColor={(color) => workspace.setProfileAvatarColor(color)}
    onExportProfile={() => workspace.exportProfileFile()}
    onImportProfile={(event) => workspace.importProfileFile(event)}
    onResetProfile={() => workspace.resetProfileSettings()}
    onSaveProfile={() => void workspace.saveProfileSettings()}
    onToggleSettingsSelectMenu={toggleSettingsSelectMenu}
    onSelectLanguage={(languageId) => void selectLanguage(languageId)}
    onImportLanguage={importLanguageFile}
    onExportLanguage={exportLanguageTemplate}
    onSelectAudioInputDevice={(deviceId) => void audio.selectAudioInputDevice(deviceId)}
    onSelectAudioOutputDevice={(deviceId) => void audio.selectAudioOutputDevice(deviceId)}
    onSelectNoiseSuppressionMode={(mode) => void audio.selectNoiseSuppressionMode(mode)}
    onChangeMicrophoneGain={(event) => audio.changeMicrophoneGain(event)}
    onChangeMicrophoneGainLimit={(value) => audio.changeMicrophoneGainLimit(value)}
    onChangeOutputVolume={(event) => audio.changeOutputVolume(event)}
    onChangeMemberVolumeLimit={(value) => audio.changeMemberVolumeLimit(value)}
    onRunMicrophoneTest={() => void audio.runMicrophoneTest()}
    onRunHeadphoneTest={() => void audio.runHeadphoneTest()}
    onRefreshAudioInputDevices={(requestPermission) => audio.refreshAudioInputDevices(requestPermission ?? false)}
  />
<OnboardingDialog
  t={t}
  open={onboardingOpen}
  appIconURL={appIconURL}
    appContentIconURL={appContentIconURL}
    onboardingStep={onboardingStep}
    bind:profileDraft={profileDraft}
    profileSaving={profileSaving}
    error={error}
    settingsSelectMenuOpen={settingsSelectMenuOpen}
    onToggleSettingsSelectMenu={toggleSettingsSelectMenu}
    languagePack={languagePack}
    selectedLanguageId={selectedLanguageId}
    languageOptions={languageOptions}
    onSelectLanguage={(languageId) => void selectLanguage(languageId)}
    onSelectProfileAvatar={(event) => workspace.selectProfileAvatar(event)}
    onClearProfileAvatar={() => workspace.clearProfileAvatar()}
    onSetProfileAvatarColor={(color) => workspace.setProfileAvatarColor(color)}
    nativeDesktopRuntime={nativeDesktopRuntime}
    audioInputDevicesLoading={audioInputDevicesLoading}
    audioInputDevices={audioInputDevices}
    audioOutputDevices={audioOutputDevices}
    selectedAudioInputDeviceId={selectedAudioInputDeviceId}
    selectedAudioOutputDeviceId={selectedAudioOutputDeviceId}
    selectedAudioInputLabel={() => audio.selectedAudioInputLabel()}
    selectedAudioOutputLabel={() => audio.selectedAudioOutputLabel()}
    onSelectAudioInputDevice={(deviceId) => void audio.selectAudioInputDevice(deviceId)}
    onSelectAudioOutputDevice={(deviceId) => void audio.selectAudioOutputDevice(deviceId)}
    onRefreshAudioInputDevices={(requestPermission) => audio.refreshAudioInputDevices(requestPermission ?? false)}
    onCompleteInitialOnboarding={() => workspace.completeInitialOnboarding()}
    onReturnInitialOnboarding={() => workspace.returnInitialOnboarding()}
    onAdvanceInitialOnboarding={() => void workspace.advanceInitialOnboarding()}
  />
<EmojiAddDialog
  t={t}
  emoji={emoji}
  addID={emojiAddID}
  onAddIDChange={(value) => (emojiAddID = value)}
  serverInitials={serverInitials}
  setAddInputElement={(element) => (emojiAddInputElement = element)}
/>
<EmojiImageEditor
  file={emojiEditorFile}
  source={emojiEditorSourceURL}
  title={t("emoji.editorTitle")}
  description={t("emoji.editorDescription")}
  previewLabel={t("emoji.editorPreview")}
  zoomLabel={t("settings.cropZoom")}
  rotateLeftLabel={t("emoji.rotateLeft")}
  rotateRightLabel={t("emoji.rotateRight")}
  cancelLabel={t("common.cancel")}
  applyLabel={t("emoji.applyEdit")}
  useOriginalLabel={t("emoji.useOriginal")}
  gifNotice={t("emoji.gifEditNotice")}
  closeLabel={t("app.close")}
  processingLabel={t("emoji.processing")}
  invalidMessage={t("emoji.imageRequired")}
  onApply={(file) => { realtimeSyncTick += 1; return emoji.acceptEditorFile(file); }}
  onUseOriginal={(file) => { realtimeSyncTick += 1; return emoji.acceptEditorFile(file); }}
  onCancel={() => { emoji.cancelEditor(); realtimeSyncTick += 1; }}
/>
<ImageCropDialog
  source={serverProfileAvatarCropSource}
  eyebrow={server?.name ?? "EchoVoice"}
  title={t("serverProfile.cropAvatar")}
  description={t("profile.avatarCropDescription")}
  ariaLabel={t("serverProfile.cropAvatar")}
  cancelLabel={t("common.cancel")}
  applyLabel={t("settings.applyCrop")}
  busyLabel={t("profile.saving")}
  closeLabel={t("app.close")}
  zoomLabel={t("settings.cropZoom")}
  horizontalLabel={t("settings.cropHorizontal")}
  verticalLabel={t("settings.cropVertical")}
  invalidMessage={t("profile.avatarInvalid")}
  outputSize={256}
  maxOutputBytes={96 * 1024}
  roundPreview
  onApply={applyServerProfileAvatarCrop}
  onCancel={closeServerProfileAvatarCrop}
/>
<ImageCropDialog
  source={profileAvatarCropSource}
  eyebrow={t("appSettings.profile")}
  title={t("profile.cropAvatar")}
  description={t("profile.avatarCropDescription")}
  ariaLabel={t("profile.cropAvatar")}
  cancelLabel={t("common.cancel")}
  applyLabel={t("settings.applyCrop")}
  busyLabel={t("profile.saving")}
  closeLabel={t("app.close")}
  zoomLabel={t("settings.cropZoom")}
  horizontalLabel={t("settings.cropHorizontal")}
  verticalLabel={t("settings.cropVertical")}
  invalidMessage={t("profile.avatarInvalid")}
  outputSize={256}
  maxOutputBytes={96 * 1024}
  roundPreview
  onApply={(dataURL) => workspace.applyProfileAvatarCrop(dataURL)}
  onCancel={() => workspace.closeProfileAvatarCrop()}
/>
<ImageCropDialog
  source={serverIconCropSource}
  eyebrow={t("settings.serverProfile")}
  title={t("settings.cropServerIcon")}
  ariaLabel={t("settings.cropServerIcon")}
  cancelLabel={t("common.cancel")}
  applyLabel={t("settings.applyCrop")}
  busyLabel={t("settings.saving")}
  closeLabel={t("app.close")}
  zoomLabel={t("settings.cropZoom")}
  horizontalLabel={t("settings.cropHorizontal")}
  verticalLabel={t("settings.cropVertical")}
  invalidMessage={t("settings.serverIconInvalid")}
  outputSize={256}
  maxOutputBytes={128 * 1024}
  onApply={applyServerIconCrop}
  onCancel={cancelServerIconCrop}
/>
<InviteDialog
  t={t}
  serverSettings={serverSettingsController}
  onFlushAliases={() => {
    realtimeSyncTick += 1;
  }}
/>
<GeneratedInviteDialog
  t={t}
  serverSettings={serverSettingsController}
  onFlushAliases={() => {
    realtimeSyncTick += 1;
  }}
/>
<ConnectDialog
  t={t}
  open={connectDialogOpen}
  bind:connectMode={connectMode}
    bind:connectBaseUrl={connectBaseUrl}
    bind:connectPassword={connectPassword}
    bind:connectInviteLink={connectInviteLink}
    connectBusy={connectBusy}
    connectError={connectError}
    nativeDesktopRuntime={nativeDesktopRuntime}
    webDevelopmentRuntime={webDevelopmentRuntime}
    defaultServerBaseUrl={defaultServerBaseUrl}
    webServerURLPlaceholder={webServerURLPlaceholder}
    onConnect={() => workspace.connectToServer()}
    onClose={closeConnectDialog}
  />
<PendingChannelWarningDialog
  t={t}
  channels={channelsController}
  onFlushAliases={() => {
    realtimeSyncTick += 1;
  }}
/>
<ChannelDialog
  t={t}
  channels={channelsController}
  error={error}
  onFlushAliases={() => {
    realtimeSyncTick += 1;
  }}
/>
