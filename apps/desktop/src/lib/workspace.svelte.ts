// Workspace domain controller.
// Owns connection, workspace loading, profile sync, onboarding, account merge,
// and app-settings orchestration. State remains component-owned for now and is
// reached through lazy getter/setter hooks on a plain object; cross-domain
// side effects are injected below, so this controller never imports App.svelte.

import { connect, createMemberMergeRequest, generateMemberMergeCode, getChannels, getMemberMergeRequests, getMembers, getRemoteControlSessions, getRoles, getRTCConfig, getScreenShareSessions, getServer, getVoiceStates, refreshSession, resolveMemberMergeRequest, updateProfile } from "./api";
import { rtcIceServersNeedRefresh } from "./rtcIceServerFreshness";
import { exportLocalUserProfile, importLocalUserProfile, loadCollapsedCategoryIds, loadLocalUserProfile, loadPendingMessages, saveLocalUserProfile } from "./storage";
import { decideProfileSync, effectiveProfileForServer, mergeSyncableProfileFromMember } from "./profile-sync";
import { normalizeAvatarColor } from "./avatar";
import { parseServerInviteLink } from "./server-url";
import type { LocalUserProfile, Member, MemberMergeRequest, ServerSummary, StoredCredential, StoredServer } from "./types";

const serverConnectionTimeoutMS = 15_000;
const onboardingCompletionStorageKey = "ev.onboarding.completed.v1";

// Loose by design: the workspace component constructs this object with
// getters/setters for state and function references for cross-domain calls.
type WorkspaceHooks = any;

export class WorkspaceController {
  constructor(private hooks: WorkspaceHooks) {}
  private bumpAliases() { this.hooks.bumpAliases(); }

  /** When `rtcIceServers` was last fetched; 0 means "never, treat as stale". */
  private rtcIceConfigFetchedAtMS = 0;
  /** Shared in-flight refresh so a burst of viewers pays for one request. */
  private rtcIceConfigRefresh: Promise<void> | null = null;

  get baseUrl() { return this.hooks.baseUrl; }
  set baseUrl(value) { this.hooks.baseUrl = value; }

  get connectBaseUrl() { return this.hooks.connectBaseUrl; }
  set connectBaseUrl(value) { this.hooks.connectBaseUrl = value; }

  get localUserProfile() { return this.hooks.localUserProfile; }
  set localUserProfile(value) { this.hooks.localUserProfile = value; }

  get displayName() { return this.hooks.displayName; }
  set displayName(value) { this.hooks.displayName = value; }

  get profileDraft() { return this.hooks.profileDraft; }
  set profileDraft(value) { this.hooks.profileDraft = value; }

  get profileSaving() { return this.hooks.profileSaving; }
  set profileSaving(value) { this.hooks.profileSaving = value; }

  get profileSaveMessage() { return this.hooks.profileSaveMessage; }
  set profileSaveMessage(value) { this.hooks.profileSaveMessage = value; }

  get profileSettingsDirty() { return this.hooks.profileSettingsDirty; }
  set profileSettingsDirty(value) { this.hooks.profileSettingsDirty = value; }

  get profileAvatarCropSource() { return this.hooks.profileAvatarCropSource; }
  set profileAvatarCropSource(value) { this.hooks.profileAvatarCropSource = value; }

  get memberMergeCode() { return this.hooks.memberMergeCode; }
  set memberMergeCode(value) { this.hooks.memberMergeCode = value; }

  get memberMergeCodeServerID() { return this.hooks.memberMergeCodeServerID; }
  set memberMergeCodeServerID(value) { this.hooks.memberMergeCodeServerID = value; }

  get memberMergeCodeExpiresAtMS() { return this.hooks.memberMergeCodeExpiresAtMS; }
  set memberMergeCodeExpiresAtMS(value) { this.hooks.memberMergeCodeExpiresAtMS = value; }

  get memberMergeCodeInput() { return this.hooks.memberMergeCodeInput; }
  set memberMergeCodeInput(value) { this.hooks.memberMergeCodeInput = value; }

  get memberMergeIncoming() { return this.hooks.memberMergeIncoming; }
  set memberMergeIncoming(value) { this.hooks.memberMergeIncoming = value; }

  get memberMergeOutgoing() { return this.hooks.memberMergeOutgoing; }
  set memberMergeOutgoing(value) { this.hooks.memberMergeOutgoing = value; }

  get memberMergeGenerating() { return this.hooks.memberMergeGenerating; }
  set memberMergeGenerating(value) { this.hooks.memberMergeGenerating = value; }

  get memberMergeSubmitting() { return this.hooks.memberMergeSubmitting; }
  set memberMergeSubmitting(value) { this.hooks.memberMergeSubmitting = value; }

  get memberMergeStatusMessage() { return this.hooks.memberMergeStatusMessage; }
  set memberMergeStatusMessage(value) { this.hooks.memberMergeStatusMessage = value; }

  get memberMergeCodeCopied() { return this.hooks.memberMergeCodeCopied; }
  set memberMergeCodeCopied(value) { this.hooks.memberMergeCodeCopied = value; }

  get memberMergeCodeCopiedTimer() { return this.hooks.memberMergeCodeCopiedTimer; }
  set memberMergeCodeCopiedTimer(value) { this.hooks.memberMergeCodeCopiedTimer = value; }

  get memberMergePrompting() { return this.hooks.memberMergePrompting; }
  set memberMergePrompting(value) { this.hooks.memberMergePrompting = value; }

  get memberMergePromptRequestID() { return this.hooks.memberMergePromptRequestID; }
  set memberMergePromptRequestID(value) { this.hooks.memberMergePromptRequestID = value; }

  get memberMergePromptResolvedExternally() { return this.hooks.memberMergePromptResolvedExternally; }
  set memberMergePromptResolvedExternally(value) { this.hooks.memberMergePromptResolvedExternally = value; }

  get connectPassword() { return this.hooks.connectPassword; }
  set connectPassword(value) { this.hooks.connectPassword = value; }

  get connectMode() { return this.hooks.connectMode; }
  set connectMode(value) { this.hooks.connectMode = value; }

  get connectInviteLink() { return this.hooks.connectInviteLink; }
  set connectInviteLink(value) { this.hooks.connectInviteLink = value; }

  get connectBusy() { return this.hooks.connectBusy; }
  set connectBusy(value) { this.hooks.connectBusy = value; }

  get connectUseSavedCredential() { return this.hooks.connectUseSavedCredential; }
  set connectUseSavedCredential(value) { this.hooks.connectUseSavedCredential = value; }

  get connectAttemptId() { return this.hooks.connectAttemptId; }
  set connectAttemptId(value) { this.hooks.connectAttemptId = value; }

  get connectAbortController() { return this.hooks.connectAbortController; }
  set connectAbortController(value) { this.hooks.connectAbortController = value; }

  get memberId() { return this.hooks.memberId; }
  set memberId(value) { this.hooks.memberId = value; }

  get sessionToken() { return this.hooks.sessionToken; }
  set sessionToken(value) { this.hooks.sessionToken = value; }

  get isOwner() { return this.hooks.isOwner; }
  set isOwner(value) { this.hooks.isOwner = value; }

  get server() { return this.hooks.server; }
  set server(value) { this.hooks.server = value; }

  get serverReportedClientUpdateRequired() { return this.hooks.serverReportedClientUpdateRequired; }
  set serverReportedClientUpdateRequired(value) { this.hooks.serverReportedClientUpdateRequired = value; }

  get storedCredential() { return this.hooks.storedCredential; }
  set storedCredential(value) { this.hooks.storedCredential = value; }

  get savedServers() { return this.hooks.savedServers; }
  set savedServers(value) { this.hooks.savedServers = value; }

  get storedServerWriteQueue() { return this.hooks.storedServerWriteQueue; }
  set storedServerWriteQueue(value) { this.hooks.storedServerWriteQueue = value; }

  get activeServerId() { return this.hooks.activeServerId; }
  set activeServerId(value) { this.hooks.activeServerId = value; }

  get activeSavedServerValue() { return this.hooks.activeSavedServerValue; }
  set activeSavedServerValue(value) { this.hooks.activeSavedServerValue = value; }

  get workspaceReconnectRequired() { return this.hooks.workspaceReconnectRequired; }
  set workspaceReconnectRequired(value) { this.hooks.workspaceReconnectRequired = value; }

  get workspaceReconnectBusy() { return this.hooks.workspaceReconnectBusy; }
  set workspaceReconnectBusy(value) { this.hooks.workspaceReconnectBusy = value; }

  get workspaceConnectionError() { return this.hooks.workspaceConnectionError; }
  set workspaceConnectionError(value) { this.hooks.workspaceConnectionError = value; }

  get connectDialogOpen() { return this.hooks.connectDialogOpen; }
  set connectDialogOpen(value) { this.hooks.connectDialogOpen = value; }

  get onboardingOpen() { return this.hooks.onboardingOpen; }
  set onboardingOpen(value) { this.hooks.onboardingOpen = value; }

  get onboardingStep() { return this.hooks.onboardingStep; }
  set onboardingStep(value) { this.hooks.onboardingStep = value; }

  get appSettingsOpen() { return this.hooks.appSettingsOpen; }
  set appSettingsOpen(value) { this.hooks.appSettingsOpen = value; }

  get settingsSelectMenuOpen() { return this.hooks.settingsSelectMenuOpen; }
  set settingsSelectMenuOpen(value) { this.hooks.settingsSelectMenuOpen = value; }

  get serverDetailsOpen() { return this.hooks.serverDetailsOpen; }
  set serverDetailsOpen(value) { this.hooks.serverDetailsOpen = value; }

  get error() { return this.hooks.error; }
  set error(value) { this.hooks.error = value; }

  get connectError() { return this.hooks.connectError; }
  set connectError(value) { this.hooks.connectError = value; }

  get statusKey() { return this.hooks.statusKey; }
  set statusKey(value) { this.hooks.statusKey = value; }

  get members() { return this.hooks.members; }
  set members(value) { this.hooks.members = value; }

  get rtcIceServers() { return this.hooks.rtcIceServers; }
  set rtcIceServers(value) { this.hooks.rtcIceServers = value; }

  get voiceConnectionContext() { return this.hooks.voiceConnectionContext; }
  set voiceConnectionContext(value) { this.hooks.voiceConnectionContext = value; }

  get realtimeSyncTick() { return this.hooks.realtimeSyncTick; }
  set realtimeSyncTick(value) { this.hooks.realtimeSyncTick = value; }

  get t() { return this.hooks.t; }
  get caughtMessage() { return this.hooks.caughtMessage; }
  get showAppConfirm() { return this.hooks.showAppConfirm; }
  get showAppAlert() { return this.hooks.showAppAlert; }
  get showWorkspaceReconnect() { return this.hooks.showWorkspaceReconnect; }
  get clearActiveServerWorkspace() { return this.hooks.clearActiveServerWorkspace; }
  get endRemoteControlsBeforeWorkspaceSwitch() { return this.hooks.endRemoteControlsBeforeWorkspaceSwitch; }
  get closeEventSocket() { return this.hooks.closeEventSocket; }
  get prepareVoiceConnectionForWorkspaceSwitch() { return this.hooks.prepareVoiceConnectionForWorkspaceSwitch; }
  get hideServerRailTooltip() { return this.hooks.hideServerRailTooltip; }
  get ensureVoiceEventSocket() { return this.hooks.ensureVoiceEventSocket; }
  get connectEventSocket() { return this.hooks.connectEventSocket; }
  get startVoiceStatesRefreshLoop() { return this.hooks.startVoiceStatesRefreshLoop; }
  get normalizeStoredCredential() { return this.hooks.normalizeStoredCredential; }
  get normalizeDevelopmentBaseUrl() { return this.hooks.normalizeDevelopmentBaseUrl; }
  get validatedServerBaseUrl() { return this.hooks.validatedServerBaseUrl; }
  get saveActiveServerId() { return this.hooks.saveActiveServerId; }
  get loadCredential() { return this.hooks.loadCredential; }
  get mergeMember() { return this.hooks.mergeMember; }
  get ensureSelectedRole() { return this.hooks.ensureSelectedRole; }
  get clearMemberAccessFilter() { return this.hooks.clearMemberAccessFilter; }
  get sortRoles() { return this.hooks.sortRoles; }
  get resetRemoteControlClientState() { return this.hooks.resetRemoteControlClientState; }
  get refreshAudioInputDevices() { return this.hooks.refreshAudioInputDevices; }
  get initializeWebPermissions() { return this.hooks.initializeWebPermissions; }
  get stopMicrophoneTest() { return this.hooks.stopMicrophoneTest; }
  get closeCreateChannelMenu() { return this.hooks.closeCreateChannelMenu; }
  get closeServerMenu() { return this.hooks.closeServerMenu; }
  get closeVoiceParticipantContextMenu() { return this.hooks.closeVoiceParticipantContextMenu; }
  get releaseImageCropSource() { return this.hooks.releaseImageCropSource; }
  get downloadTextFile() { return this.hooks.downloadTextFile; }
  get sameProfileSettings() { return this.hooks.sameProfileSettings; }
  get sameProfileOverrides() { return this.hooks.sameProfileOverrides; }
  get serverRail() { return this.hooks.serverRail; }
  get channelsController() { return this.hooks.channelsController; }
  get permissionsController() { return this.hooks.permissionsController; }
  get serverSettingsController() { return this.hooks.serverSettingsController; }
  get voiceState() { return this.hooks.voiceState; }
  get screenShare() { return this.hooks.screenShare; }
  get accompaniment() { return this.hooks.accompaniment; }
  get soundboard() { return this.hooks.soundboard; }
  get emoji() { return this.hooks.emoji; }
  get composer() { return this.hooks.composer; }
  get messagesController() { return this.hooks.messagesController; }
  get remoteControl() { return this.hooks.remoteControl; }
  get tick() { return this.hooks.tick; }
  get screenSharePopoutMode() { return this.hooks.screenSharePopoutMode; }
  get nativeDesktopRuntime() { return this.hooks.nativeDesktopRuntime; }
  get localUserProfileExistedAtStartup() { return this.hooks.localUserProfileExistedAtStartup; }

  async connectToServer() {
    if (this.connectBusy) return;
    const attemptId = ++this.connectAttemptId;
    this.connectAbortController?.abort("superseded");
    const abortController = new AbortController();
    this.connectAbortController = abortController;
    const timeout = window.setTimeout(() => abortController.abort("timeout"), serverConnectionTimeoutMS);
    this.connectBusy = true;
    this.error = "";
    this.connectError = "";
    let requestedBaseUrl = "";
    let inviteToken = "";
    try {
      const connectionValue = this.connectMode === "invite" ? this.connectInviteLink : this.connectBaseUrl;
      const parsedInvite = parseServerInviteLink(connectionValue);
      if (this.connectMode === "invite" && !parsedInvite) {
        throw new Error(this.t("invite.invalidLink"));
      }
      inviteToken = parsedInvite?.token ?? "";
      requestedBaseUrl = this.validatedServerBaseUrl(parsedInvite?.baseUrl ?? this.connectBaseUrl);
    } catch (caught) {
      this.connectError = caught instanceof Error ? caught.message : this.t("error.connectionFailed");
      window.clearTimeout(timeout);
      if (attemptId === this.connectAttemptId) {
        this.connectAbortController = null;
        this.connectBusy = false;
      }
      return;
    }
    this.statusKey = "status.connecting";
    try {
      if (
        this.voiceConnectionContext &&
        !this.sameBaseUrl(this.voiceConnectionContext.baseUrl, requestedBaseUrl) &&
        !(await this.ensureVoiceEventSocket(true))
      ) {
        throw new Error(this.t("error.connectionFailed"));
      }
      const existingServer = this.savedServers.find((item) => this.sameBaseUrl(item.base_url, requestedBaseUrl));
      const switchingServer = Boolean(this.activeServerId && !this.sameBaseUrl(this.baseUrl, requestedBaseUrl));
      if (switchingServer) {
        await this.endRemoteControlsBeforeWorkspaceSwitch(existingServer?.server_id ?? "__new_server__");
        this.closeEventSocket();
      }
      if (existingServer && this.connectUseSavedCredential) {
        const credential = await this.loadCredential(existingServer.server_id);
        if (credential) {
          this.activeServerId = existingServer.server_id;
          this.saveActiveServerId(existingServer.server_id);
          await this.reconnectToServer(credential, abortController.signal);
          return;
        }
      }
      this.baseUrl = requestedBaseUrl;
      this.localUserProfile = loadLocalUserProfile(this.baseUrl);
      this.displayName = this.localUserProfile.display_name;
      const session = await connect({
        baseUrl: this.baseUrl,
        password: this.connectPassword,
        inviteToken,
        profile: this.localUserProfile,
        signal: abortController.signal
      });
      this.memberId = session.member_id;
      this.sessionToken = session.session_token;
      this.isOwner = session.is_owner;
      this.serverReportedClientUpdateRequired = Boolean(session.client_update_required);
      this.activeServerId = session.server_id;
      this.saveActiveServerId(session.server_id);
      await this.loadWorkspace(abortController.signal);
      if (session.access_key) {
        await this.serverRail.rememberConnectedServer(session, session.access_key);
      }
      this.connectEventSocket();
      this.startVoiceStatesRefreshLoop();
      this.workspaceReconnectRequired = false;
      this.workspaceConnectionError = "";
      this.connectUseSavedCredential = true;
      this.statusKey = session.is_owner ? "status.connectedOwner" : "status.connected";
      this.connectDialogOpen = false;
    } catch (caught) {
      if (attemptId !== this.connectAttemptId || abortController.signal.reason === "cancelled") return;
      const message = this.connectionFailureMessage(caught, abortController.signal);
      const selectedSavedServer = this.savedServers.find(
        (item) => item.server_id === this.activeServerId && this.sameBaseUrl(item.base_url, this.baseUrl)
      );
      if (selectedSavedServer) {
        this.showWorkspaceReconnect(selectedSavedServer.server_id, message);
      } else {
        this.clearActiveServerWorkspace();
      }
      if (this.connectDialogOpen) this.connectError = message;
      else if (!selectedSavedServer) this.error = message;
    } finally {
      window.clearTimeout(timeout);
      if (attemptId === this.connectAttemptId) {
        this.connectAbortController = null;
        this.connectBusy = false;
      }
    }
  }

  connectionFailureMessage(caught: unknown, signal?: AbortSignal) {
    if (signal?.aborted && signal.reason === "timeout") return this.t("error.connectionTimeout");
    return caught instanceof Error ? caught.message : this.t("error.connectionFailed");
  }

  async reconnectToServer(
    credential: StoredCredential | null = this.storedCredential,
    externalSignal?: AbortSignal
  ) {
    if (!credential) return;
    const ownedController = externalSignal ? null : new AbortController();
    const signal = externalSignal ?? ownedController?.signal;
    const timeout = ownedController
      ? window.setTimeout(() => ownedController.abort("timeout"), serverConnectionTimeoutMS)
      : 0;
    const attemptedServerId = credential.server_id;
    this.error = "";
    this.statusKey = "status.reconnecting";
    try {
      const normalizedCredential = this.normalizeStoredCredential(credential);
      this.storedCredential = normalizedCredential;
      this.baseUrl = this.validatedServerBaseUrl(normalizedCredential.baseUrl);
      const session = await refreshSession(
        normalizedCredential,
        loadLocalUserProfile(this.baseUrl).local_profile_id,
        signal
      );
      this.memberId = session.member_id;
      this.sessionToken = session.session_token;
      this.isOwner = session.is_owner;
      this.serverReportedClientUpdateRequired = Boolean(session.client_update_required);
      await this.loadWorkspace(signal);
      await this.serverRail.rememberConnectedServer(session, normalizedCredential.access_key);
      this.connectEventSocket();
      this.startVoiceStatesRefreshLoop();
      this.workspaceReconnectRequired = false;
      this.workspaceConnectionError = "";
      this.statusKey = session.is_owner ? "status.connectedOwner" : "status.connected";
      this.connectDialogOpen = false;
    } catch (caught) {
      if (externalSignal) throw caught;
      const message = this.connectionFailureMessage(caught, signal);
      const preserveServerId = this.savedServers.some((item) => item.server_id === attemptedServerId)
        ? attemptedServerId
        : "";
      if (preserveServerId) this.showWorkspaceReconnect(preserveServerId, message);
      else {
        this.clearActiveServerWorkspace();
        this.error = message;
      }
    } finally {
      if (timeout) window.clearTimeout(timeout);
    }
  }

  async reconnectSavedServer(savedServer: StoredServer) {
    if (!(await this.prepareVoiceConnectionForWorkspaceSwitch(savedServer.server_id))) {
      this.error = this.t("error.connectionFailed");
      return;
    }
    await this.endRemoteControlsBeforeWorkspaceSwitch(savedServer.server_id);
    this.closeEventSocket();
    this.activeServerId = savedServer.server_id;
    this.saveActiveServerId(savedServer.server_id);
    this.baseUrl = this.normalizeDevelopmentBaseUrl(savedServer.base_url);
    this.connectBaseUrl = this.baseUrl;
    this.connectPassword = "";
    this.connectDialogOpen = false;
    this.connectError = "";
    this.workspaceReconnectRequired = true;
    this.workspaceReconnectBusy = true;
    this.workspaceConnectionError = "";
    const credential = await this.loadCredential(savedServer.server_id);
    if (!credential) {
      this.connectUseSavedCredential = false;
      try {
        await this.connectToServer();
      } finally {
        this.connectUseSavedCredential = true;
        this.workspaceReconnectBusy = false;
      }
      return;
    }
    try {
      await this.reconnectToServer(credential);
    } finally {
      this.workspaceReconnectBusy = false;
    }
  }

  activateSavedServer(savedServer: StoredServer, event: MouseEvent) {
    this.hideServerRailTooltip();
    (event.currentTarget as HTMLButtonElement).blur();
    if (this.activeServerId === savedServer.server_id && this.sessionToken && this.server?.server_id === savedServer.server_id) {
      return;
    }
    void this.reconnectSavedServer(savedServer);
  }

  /**
   * Refreshes the cached ICE server list when the TURN credentials it carries
   * are close to their two hour lifetime. Peer connections are built from
   * whatever list is current, so a stale list means the relay answers an
   * allocation with a rejection: a viewer behind a symmetric NAT then stops
   * connecting at all, while direct paths keep working and hide the cause.
   *
   * Free in the common case - no request is made while the list is young.
   */
  /** When the ICE server list in use was fetched; 0 means "never". */
  rtcIceConfigFetchedAt(): number {
    return this.rtcIceConfigFetchedAtMS;
  }

  async ensureFreshRTCConfig(): Promise<void> {
    const token = this.sessionToken;
    if (!token) return;
    if (!rtcIceServersNeedRefresh(this.rtcIceConfigFetchedAtMS, Date.now())) return;
    if (this.rtcIceConfigRefresh) {
      await this.rtcIceConfigRefresh;
      return;
    }
    const refresh = (async () => {
      try {
        const loaded = await getRTCConfig(this.baseUrl, token);
        if (Array.isArray(loaded.ice_servers)) {
          this.rtcIceServers = loaded.ice_servers;
        }
        this.rtcIceConfigFetchedAtMS = Date.now();
      } catch (caught) {
        // Keep the previous list. An expired credential still works for direct
        // paths, so replacing it with nothing would only remove TURN from
        // everyone. Leaving the timestamp stale retries on the next request.
        console.warn("[EchoVoice] could not refresh the ICE server list", caught);
      }
    })();
    this.rtcIceConfigRefresh = refresh;
    try {
      await refresh;
    } finally {
      this.rtcIceConfigRefresh = null;
    }
  }

  async loadWorkspace(signal?: AbortSignal) {
    this.permissionsController.rolePreviewId = "";
    const token = this.sessionToken;
    const [
      loadedServer,
      loadedChannels,
      loadedMembers,
      loadedRoles,
      loadedVoiceStates,
      loadedScreenShareSessions,
      loadedAccompanimentSessions,
      loadedRemoteControlSessions,
      loadedRTCConfig
    ] = await Promise.all([
      getServer(this.baseUrl, signal),
      getChannels(this.baseUrl, token, signal),
      getMembers(this.baseUrl, token, signal),
      getRoles(this.baseUrl, token, signal),
      getVoiceStates(this.baseUrl, token, signal),
      getScreenShareSessions(this.baseUrl, token, signal),
      this.accompaniment.fetchSessions(token, signal),
      getRemoteControlSessions(this.baseUrl, token, signal),
      getRTCConfig(this.baseUrl, token, signal)
    ]);
    signal?.throwIfAborted();

    this.server = loadedServer;
    this.serverSettingsController.serverDraft = { ...loadedServer };
    await this.serverRail.syncSavedServerSummary(loadedServer);
    this.memberMergeIncoming = [];
    this.memberMergeOutgoing = [];
    if (this.memberMergeCodeServerID !== loadedServer.server_id) {
      this.memberMergeCode = "";
      this.memberMergeCodeExpiresAtMS = 0;
      this.memberMergeCodeServerID = "";
    }
    this.channelsController.replaceChannels(loadedChannels);
    this.channelsController.setCollapsedCategoryIds(
      new Set(loadCollapsedCategoryIds(loadedServer.server_id))
    );
    // Channel list renders through this.tick-driven aliases; flush them immediately
    // so the reload/workspace-switch flows show the list in the same frame as
    // the this.server summary (which is plain component state).
    this.realtimeSyncTick += 1;
    this.members = loadedMembers;
    this.permissionsController.roles = this.sortRoles(loadedRoles);
    this.ensureSelectedRole();
    this.rtcIceServers = loadedRTCConfig.ice_servers ?? [];
    this.rtcIceConfigFetchedAtMS = Date.now();
    if (this.voiceConnectionContext?.serverId === loadedServer.server_id) {
      this.voiceState.voiceConnectionContext = {
        ...this.voiceConnectionContext,
        serverName: loadedServer.name,
        baseUrl: this.baseUrl,
        sessionToken: token,
        memberId: this.memberId,
        iceServers: this.rtcIceServers.map((item) => ({ ...item, urls: [...item.urls] }))
      };
    }
    this.voiceState.replaceVoiceStates(loadedVoiceStates);
    this.screenShare.replaceScreenShareSessions(loadedScreenShareSessions);
    this.accompaniment.replaceSessions(loadedAccompanimentSessions);
    await this.resetRemoteControlClientState();
    if (loadedRemoteControlSessions.length > 0) {
      await Promise.allSettled(
        loadedRemoteControlSessions.map((control) =>
          updateRemoteControl(this.baseUrl, token, control.control_id, "revoke")
        )
      );
      signal?.throwIfAborted();
    }
    await this.soundboard.loadWorkspaceItems(loadedServer, token, signal);
    await this.emoji.loadWorkspaceItems(loadedServer, token, signal);
    this.soundboard.syncCurrentServerLibrary();
    this.realtimeSyncTick += 1;
    void this.soundboard.prepareIcons(this.soundboard.items, loadedServer.server_id);
    this.composer.loadWorkspaceReadState(loadedServer.server_id);
    this.messagesController.setPendingDrafts(loadPendingMessages(loadedServer.server_id));
    const loadedCurrentMember = loadedMembers.find((member) => member.member_id === this.memberId);
    if (loadedCurrentMember) {
      this.isOwner = loadedCurrentMember.is_owner;
      await this.synchronizeLocalProfile(loadedCurrentMember);
    }
    await this.refreshMemberMergeRequests(true);
    this.composer.clearComposerAttachmentObjectURLs();
    this.composer.clearMessageAttachmentObjectURLs();
    this.channelsController.selectedChannelId = "";
    this.clearMemberAccessFilter();
    this.messagesController.messages = [];
  }

  async synchronizeLocalProfile(serverMember: Member) {
    this.localUserProfile = loadLocalUserProfile(this.baseUrl);
    const decision = decideProfileSync(this.localUserProfile, serverMember);
    if (decision === "none") {
      this.displayName = this.localUserProfile.display_name;
      this.profileDraft = { ...this.localUserProfile };
      return;
    }
    if (decision === "upload") {
      try {
        const updated = await updateProfile(this.baseUrl, this.sessionToken, this.localUserProfile);
        this.mergeMember(updated);
        this.localUserProfile = {
          ...this.localUserProfile,
          updated_at_ms: updated.profile_updated_at_ms || this.localUserProfile.updated_at_ms
        };
        saveLocalUserProfile(this.localUserProfile);
      } catch {
        // Keep the newer local snapshot. The next this.server open retries automatically.
      }
    } else {
      const localEffectiveProfile = effectiveProfileForServer(this.localUserProfile, serverMember);
      const useServerProfile = await this.showAppConfirm(
        this.t("profile.serverNewerPrompt", {
          updatedAt: new Date(serverMember.profile_updated_at_ms).toLocaleString()
        }),
        {
          title: this.t("profile.syncConflictTitle"),
          confirmLabel: this.t("profile.useServerProfile"),
          cancelLabel: this.t("profile.keepLocalProfile"),
          profileComparison: {
            local: {
              label: this.t("profile.localProfile"),
              displayName: localEffectiveProfile.display_name,
              avatarDataUrl: localEffectiveProfile.avatar_data_url ?? "",
              avatarColor: localEffectiveProfile.avatar_color ?? "",
              bio: localEffectiveProfile.bio,
              identityKey: this.localUserProfile.local_profile_id,
              updatedAt: this.t("profile.updatedAt", {
                updatedAt: new Date(this.localUserProfile.updated_at_ms).toLocaleString()
              })
            },
            server: {
              label: this.t("profile.serverProfile"),
              displayName: serverMember.display_name,
              avatarDataUrl: serverMember.avatar_data_url ?? "",
              avatarColor: serverMember.avatar_color ?? "",
              bio: serverMember.bio ?? "",
              identityKey: serverMember.member_id,
              updatedAt: this.t("profile.updatedAt", {
                updatedAt: new Date(serverMember.profile_updated_at_ms).toLocaleString()
              })
            }
          }
        }
      );
      if (useServerProfile) {
        this.localUserProfile = mergeSyncableProfileFromMember(this.localUserProfile, serverMember);
        saveLocalUserProfile(this.localUserProfile);
      } else {
        try {
          const updated = await updateProfile(this.baseUrl, this.sessionToken, this.localUserProfile);
          this.mergeMember(updated);
          this.localUserProfile = {
            ...this.localUserProfile,
            updated_at_ms: updated.profile_updated_at_ms || Date.now()
          };
          saveLocalUserProfile(this.localUserProfile);
        } catch {
          // Retain the selected local snapshot and retry on the next connection.
        }
      }
    }
    this.displayName = this.localUserProfile.display_name;
    this.profileDraft = { ...this.localUserProfile };
  }

  currentStorageServerId() {
    return this.server?.server_id || this.activeServerId || this.storedCredential?.server_id || "";
  }

  openAppSettings() {
    this.closeCreateChannelMenu();
    this.closeServerMenu();
    this.closeVoiceParticipantContextMenu();
    this.serverSettingsController.serverSettingsOpen = false;
    this.serverDetailsOpen = false;
    this.serverSettingsController.serverProfileSettingsOpen = false;
    this.localUserProfile = loadLocalUserProfile(this.baseUrl);
    this.profileDraft = { ...this.localUserProfile };
    this.profileSaveMessage = "";
    this.appSettingsOpen = true;
    this.settingsSelectMenuOpen = null;
    this.error = "";
    void this.refreshAudioInputDevices();
  }

  openInitialOnboarding() {
    if (this.screenSharePopoutMode || localStorage.getItem(onboardingCompletionStorageKey) === "1") return;
    if (this.localUserProfileExistedAtStartup) {
      localStorage.setItem(onboardingCompletionStorageKey, "1");
      return;
    }
    this.profileDraft = { ...this.localUserProfile };
    this.profileSaveMessage = "";
    this.onboardingStep = 0;
    this.onboardingOpen = true;
    this.settingsSelectMenuOpen = null;
    if (this.nativeDesktopRuntime) void this.refreshAudioInputDevices();
    else void this.initializeWebPermissions();
  }

  completeInitialOnboarding() {
    localStorage.setItem(onboardingCompletionStorageKey, "1");
    this.onboardingOpen = false;
    this.settingsSelectMenuOpen = null;
  }

  async advanceInitialOnboarding() {
    if (this.onboardingStep === 0) {
      this.onboardingStep = 1;
      return;
    }
    if (this.onboardingStep === 1) {
      if (!this.profileDraft.display_name.trim() || this.profileSaving) return;
      await this.saveProfileSettings();
      this.onboardingStep = 2;
      void this.refreshAudioInputDevices();
      return;
    }
    this.completeInitialOnboarding();
  }

  returnInitialOnboarding() {
    this.onboardingStep = Math.max(0, this.onboardingStep - 1);
    this.settingsSelectMenuOpen = null;
  }

  closeAppSettings() {
    this.appSettingsOpen = false;
    this.settingsSelectMenuOpen = null;
    void this.stopMicrophoneTest();
    this.error = "";
  }

  async refreshMemberMergeRequests(promptIncoming = false) {
    if (!this.sessionToken || !this.server) return;
    const requestedToken = this.sessionToken;
    const requestedBaseUrl = this.baseUrl;
    const requestedServerID = this.server.server_id;
    try {
      const requests = await getMemberMergeRequests(requestedBaseUrl, requestedToken);
      if (
        this.sessionToken !== requestedToken ||
        this.baseUrl !== requestedBaseUrl ||
        this.server?.server_id !== requestedServerID
      ) return;
      this.memberMergeIncoming = requests.incoming;
      this.memberMergeOutgoing = requests.outgoing;
      if (promptIncoming) void this.processNextMemberMergePrompt();
    } catch {
      // Merge requests are recovered by the next realtime event or workspace refresh.
    }
  }

  mergeMemberMergeRequest(items: MemberMergeRequest[], request: MemberMergeRequest) {
    return [...items.filter((item) => item.request_id !== request.request_id), request]
      .sort((left, right) => left.created_at_ms - right.created_at_ms);
  }

  async processNextMemberMergePrompt() {
    // `appDialog` used to be a bare identifier here. This module is not the
    // component, so it resolved to nothing and threw a ReferenceError from
    // inside loadWorkspace: the workspace never finished loading, which then
    // looked like broken signalling everywhere else.
    if (this.memberMergePrompting || this.hooks.appDialogOpen?.() === true || !this.sessionToken) return;
    const request = this.memberMergeIncoming.find(
      (item) => item.status === "pending" && item.target_member_id === this.memberId
    );
    if (!request?.requester?.member_id) return;
    this.memberMergePrompting = true;
    this.memberMergePromptRequestID = request.request_id;
    this.memberMergePromptResolvedExternally = false;
    const accepted = await this.showAppConfirm(
      this.t("accountMerge.requestPrompt", { name: request.requester.display_name }),
      {
        title: this.t("accountMerge.requestTitle"),
        confirmLabel: this.t("accountMerge.accept"),
        cancelLabel: this.t("accountMerge.reject"),
        dismissible: false,
        memberCard: {
          label: this.t("accountMerge.requester"),
          displayName: request.requester.display_name,
          avatarDataUrl: request.requester.avatar_data_url ?? "",
          avatarColor: request.requester.avatar_color ?? "",
          bio: request.requester.bio ?? "",
          identityKey: request.requester.member_id,
          updatedAt: this.t("accountMerge.requestedAt", {
            time: new Date(request.created_at_ms).toLocaleString()
          })
        }
      }
    );
    try {
      if (this.memberMergePromptResolvedExternally || !this.sessionToken) return;
      const resolution = await resolveMemberMergeRequest(
        this.baseUrl,
        this.sessionToken,
        request.request_id,
        accepted ? "accept" : "reject"
      );
      if (resolution.member) this.mergeMember(resolution.member);
      this.memberMergeIncoming = this.memberMergeIncoming.filter((item) => item.request_id !== request.request_id);
      this.memberMergeStatusMessage = this.t(accepted ? "accountMerge.accepted" : "accountMerge.rejected");
    } catch (caught) {
      const message = this.memberMergeErrorMessage(caught);
      await this.showAppAlert(message, { title: this.t("accountMerge.title") });
    } finally {
      this.memberMergePrompting = false;
      this.memberMergePromptRequestID = "";
      this.memberMergePromptResolvedExternally = false;
      await this.refreshMemberMergeRequests(false);
      void this.tick().then(this.processNextMemberMergePrompt);
    }
  }

  async generateAccountMergeCode() {
    if (!this.sessionToken || !this.server || this.memberMergeGenerating) return;
    this.memberMergeGenerating = true;
    this.memberMergeStatusMessage = "";
    try {
      const generated = await generateMemberMergeCode(this.baseUrl, this.sessionToken);
      this.memberMergeCode = generated.code;
      this.memberMergeCodeExpiresAtMS = generated.expires_at_ms;
      this.memberMergeCodeServerID = this.server.server_id;
      this.memberMergeCodeCopied = false;
    } catch (caught) {
      this.memberMergeStatusMessage = this.memberMergeErrorMessage(caught);
    } finally {
      this.memberMergeGenerating = false;
    }
  }

  async copyAccountMergeCode() {
    if (!this.memberMergeCode) return;
    try {
      await navigator.clipboard.writeText(this.memberMergeCode);
      this.memberMergeCodeCopied = true;
      window.clearTimeout(this.memberMergeCodeCopiedTimer);
      this.memberMergeCodeCopiedTimer = window.setTimeout(() => (this.memberMergeCodeCopied = false), 1400);
    } catch {
      this.memberMergeStatusMessage = this.t("accountMerge.copyFailed");
    }
  }

  updateAccountMergeCodeInput(event: Event) {
    this.memberMergeCodeInput = (event.currentTarget as HTMLInputElement).value.replace(/\D/g, "").slice(0, 8);
  }

  async submitAccountMergeRequest() {
    if (!this.sessionToken || this.memberMergeSubmitting || this.memberMergeCodeInput.length !== 8) return;
    this.memberMergeSubmitting = true;
    this.memberMergeStatusMessage = "";
    try {
      const request = await createMemberMergeRequest(this.baseUrl, this.sessionToken, this.memberMergeCodeInput);
      this.memberMergeOutgoing = this.mergeMemberMergeRequest(this.memberMergeOutgoing, request);
      this.memberMergeCodeInput = "";
      this.memberMergeStatusMessage = this.t("accountMerge.requestSent");
    } catch (caught) {
      this.memberMergeStatusMessage = this.memberMergeErrorMessage(caught);
    } finally {
      this.memberMergeSubmitting = false;
    }
  }

  memberMergeErrorMessage(caught: unknown) {
    const code = caught && typeof caught === "object" && "code" in caught
      ? String((caught as { code?: unknown }).code ?? "")
      : "";
    if (code === "EV_MEMBER_MERGE_CODE_INVALID") return this.t("accountMerge.codeInvalid");
    if (code === "EV_MEMBER_MERGE_SAME") return this.t("accountMerge.sameAccount");
    if (code === "EV_MEMBER_MERGE_ALREADY_PENDING") return this.t("accountMerge.alreadyPending");
    if (code === "EV_MEMBER_MERGE_RATE_LIMITED" || code === "EV_MEMBER_MERGE_CODE_RATE_LIMITED") {
      return this.t("accountMerge.rateLimited");
    }
    if (code === "EV_MEMBER_MERGE_REQUEST_NOT_FOUND" || code === "EV_MEMBER_MERGE_REQUEST_INVALID") {
      return this.t("accountMerge.requestUnavailable");
    }
    return this.caughtMessage(caught, this.t("accountMerge.failed"));
  }

  resetProfileSettings() {
    this.profileDraft = { ...this.localUserProfile };
    this.profileSaveMessage = "";
    this.error = "";
  }

  async saveProfileSettings() {
    const name = this.profileDraft.display_name.trim();
    if (!name || this.profileSaving) return;
    this.profileSaving = true;
    this.error = "";
    this.profileSaveMessage = "";
    const next: LocalUserProfile = {
      ...this.profileDraft,
      local_profile_id: this.localUserProfile.local_profile_id,
      display_name: name.slice(0, 64),
      bio: this.profileDraft.bio.trim().slice(0, 500),
      updated_at_ms: Date.now()
    };
    saveLocalUserProfile(next);
    this.localUserProfile = next;
    this.displayName = next.display_name;
    try {
      if (this.sessionToken) {
        const updated = await updateProfile(this.baseUrl, this.sessionToken, next);
        this.mergeMember({
          ...updated,
          display_name: next.display_name,
          avatar_data_url: next.avatar_data_url ?? "",
          avatar_sha256: next.avatar_sha256 ?? "",
          avatar_color: next.avatar_color ?? "",
          bio: next.bio
        });
        this.localUserProfile = {
          ...next,
          updated_at_ms: updated.profile_updated_at_ms || next.updated_at_ms
        };
        saveLocalUserProfile(this.localUserProfile);
      }
      this.profileDraft = { ...this.localUserProfile };
      this.profileSaveMessage = this.t("profile.saved");
    } catch (caught) {
      this.error = caught instanceof Error ? caught.message : this.t("error.memberUpdateFailed");
    } finally {
      this.profileSaving = false;
    }
  }

  async selectProfileAvatar(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      this.error = this.t("profile.avatarInvalid");
      return;
    }
    this.releaseImageCropSource(this.profileAvatarCropSource);
    this.profileAvatarCropSource = URL.createObjectURL(file);
    this.error = "";
  }

  applyProfileAvatarCrop(dataURL: string) {
    this.profileDraft = { ...this.profileDraft, avatar_data_url: dataURL, avatar_sha256: "" };
    this.closeProfileAvatarCrop();
    this.error = "";
  }

  closeProfileAvatarCrop() {
    this.releaseImageCropSource(this.profileAvatarCropSource);
    this.profileAvatarCropSource = "";
  }

  clearProfileAvatar() {
    this.profileDraft = { ...this.profileDraft, avatar_data_url: "", avatar_sha256: "" };
  }

  setProfileAvatarColor(color: string) {
    this.profileDraft = {
      ...this.profileDraft,
      avatar_color: normalizeAvatarColor(color, this.profileDraft.local_profile_id)
    };
  }

  exportProfileFile() {
    this.downloadTextFile("EchoVoice-profile.json", exportLocalUserProfile(), "application/json");
  }

  async importProfileFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      this.localUserProfile = importLocalUserProfile(await file.text());
      this.profileDraft = { ...this.localUserProfile };
      await this.saveProfileSettings();
    } catch (caught) {
      this.error = caught instanceof Error ? caught.message : this.t("profile.importFailed");
    }
  }

  readFileAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error ?? new Error("Unable to read file"));
      reader.readAsDataURL(file);
    });
  }

  sameBaseUrl(left: string, right: string) {
    return this.normalizeBaseUrl(left) === this.normalizeBaseUrl(right);
  }

  normalizeBaseUrl(value: string) {
    return value.trim().replace(/\/+$/, "").toLowerCase();
  }
}
