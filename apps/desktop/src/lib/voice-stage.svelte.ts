// Voice stage domain: join/leave orchestration, member search/access filter,
// and the pure view-model builders that turn voice states + members into the
// maps/groups the voice stage and member panel render.
//
// The controller owns the member-panel interaction state and the voice
// join/leave flows; it never imports App.svelte. WebRTC transport, audio
// device state, screen-share setup, and realtime bookkeeping are reached
// through hooks so their owning controllers stay independent.

import { tick } from "svelte";
import {
  getChannelAccessibleMemberIDs,
  getMemberVoiceDuration,
  joinVoiceChannel,
  kickVoiceState,
  leaveVoiceChannel,
  manageVoiceState,
  normalizeVoiceState,
  updateMember
} from "./api";
import type { AudioDevicesController } from "./audio-devices.svelte";
import type { ChannelsController } from "./channels.svelte";
import type { PermissionsController } from "./permissions.svelte";
import type { RealtimeController } from "./realtime.svelte";
import type { ScreenShareSetupController } from "./screen-share-setup.svelte";
import type { VoiceSessionController } from "./voice-session.svelte";
import type { VoiceStateController, VoiceConnectionContext } from "./voice-state.svelte";
import type {
  Channel,
  LocalUserProfile,
  Member,
  RTCIceServer,
  ServerRole,
  StoredServer,
  VoiceDurationStats,
  VoiceKickMode,
  VoiceState
} from "./types";

export type MemberGroup = {
  key: string;
  label: string;
  members: Member[];
  role?: ServerRole;
};

export type VoiceParticipantContextMenu = {
  memberId: string;
  participantId?: string;
  x: number;
  y: number;
};

export type VoiceParticipantPointerPress = {
  memberId: string;
  participantId: string;
  x: number;
  y: number;
  pointerId?: number;
  dragging: boolean;
};

export type VoiceStageHooks = {
  memberId: () => string;
  sessionToken: () => string;
  baseUrl: () => string;
  activeServerId: () => string;
  server: () => { server_id?: string; name: string } | null;
  activeSavedServerValue: () => StoredServer | undefined;
  nativeDesktopRuntime: () => boolean;
  localUserProfile: () => LocalUserProfile;
  rtcIceServers: () => RTCIceServer[];
  channels: () => Channel[];
  members: () => Member[];
  roles: () => ServerRole[];
  languagePackId: () => string;
  voiceStates: () => VoiceState[];
  voiceStatesByMember: () => Map<string, VoiceState>;
  voiceConnectionContext: () => VoiceConnectionContext | null;
  voiceState: VoiceStateController;
  voiceSession: VoiceSessionController;
  audio: AudioDevicesController;
  realtime: RealtimeController;
  channelsController: ChannelsController;
  permissionsController: PermissionsController;
  screenShareSetup: ScreenShareSetupController;
  translate: (key: string, params?: Record<string, string | number>) => string;
  setError: (message: string) => void;
  showAppConfirm: (message: string, options?: Record<string, unknown>) => Promise<boolean>;
  abortableRequestWithTimeout: <T>(request: (signal: AbortSignal) => Promise<T>, timeoutMS: number, message: string) => Promise<T>;
  prepareVoiceAudioPlayback: () => void;
  applyLocalVoiceFlags: (state: VoiceState) => VoiceState;
  syncCurrentVoiceState: () => Promise<void>;
  startVoiceSession: (channelId: string) => Promise<void>;
  stopVoiceSession: (options?: { clearVoicePanel?: boolean }) => void;
  closePeerConnection: (participantId: string, memberIdValue?: string) => void;
  releaseLocalScreenShareTransport: (share?: unknown) => void;
  playUISound: (name: "channel-join" | "channel-leave") => void;
  voiceActionBusy: () => boolean;
  setVoiceActionBusy: (busy: boolean) => void;
  memberSearchInputElement: () => HTMLInputElement | null;
  flushAliases: () => void;
  screenSharePopoutMode: () => boolean;
  eventTargetElement: (target: EventTarget | null) => HTMLElement | null;
  canMuteVoiceMembers: () => boolean;
  canDeafenVoiceMembers: () => boolean;
  canMoveVoiceMembers: () => boolean;
  memberUpdating: () => boolean;
  setMemberUpdating: (updating: boolean) => void;
  voiceManageBusyMemberId: () => string;
  setVoiceManageBusyMemberId: (memberId: string) => void;
  canManageMembers: () => boolean;
  setStatusKey: (key: string) => void;
  closeCreateChannelMenu: () => void;
  closeChannelContextMenu: () => void;
  closeMessageContextMenu: () => void;
  closeServerMenu: () => void;
  closeVoiceNetworkDetails: () => void;
};

export class VoiceStageController {
  memberSearchOpen = $state(false);
  memberSearchQuery = $state("");
  memberAccessFilterChannelId = $state("");
  memberAccessFilterMemberIds = $state<Set<string>>(new Set());
  memberAccessFilterLoading = $state(false);
  memberAccessFilterRequestId = 0;

  voiceParticipantContextMenu = $state<VoiceParticipantContextMenu | null>(null);
  selectedVoiceParticipantIds = $state<Set<string>>(new Set());
  voiceParticipantSelectionAnchorId = $state("");
  voiceParticipantDurationStats = $state<VoiceDurationStats | null>(null);
  voiceParticipantDurationLoading = $state(false);
  voiceParticipantDurationError = $state("");
  voiceParticipantDurationRequestId = 0;
  voiceParticipantDurationNowMS = Date.now();
  voiceParticipantDurationClock: number | undefined;
  voiceParticipantDragMemberId = $state("");
  voiceParticipantDragParticipantId = $state("");
  voiceParticipantDragOverChannelId = $state("");
  voiceParticipantDragX = $state(0);
  voiceParticipantDragY = $state(0);
  voiceParticipantPointerPress = $state<VoiceParticipantPointerPress | null>(null);
  voiceParticipantLastPointerDownId = "";
  voiceParticipantLastPointerDownAt = 0;
  private voiceParticipantDocumentPointerListenersAttached = false;
  private voiceParticipantDocumentMouseListenersAttached = false;
  private static readonly voiceParticipantDragBodyClass = "voice-participant-drag-active";

  constructor(private hooks: VoiceStageHooks) {}

  // ---- hot-path voice queries ------------------------------------------------

  currentVoiceState(): VoiceState | null {
    return this.hooks.voiceState().voiceConnectionContext?.state ?? null;
  }

  isJoinedVoiceChannel(channelId: string): boolean {
    const context = this.hooks.voiceState().voiceConnectionContext;
    return Boolean(
      context &&
      context.serverId === this.hooks.activeServerId() &&
      context.state?.channel_id === channelId
    );
  }

  isCurrentVoiceChannel(channelId: string): boolean {
    return this.currentVoiceState()?.channel_id === channelId;
  }

  memberVoiceStates(memberIdToFind: string): VoiceState[] {
    return this.hooks.voiceStates().filter((state) => state.member_id === memberIdToFind);
  }

  voiceListenerCount(memberIdToCount: string): number {
    return this.hooks.voiceStates().filter(
      (state) => state.member_id === memberIdToCount && state.mode === "listener"
    ).length;
  }

  memberVoiceState(id: string): VoiceState | undefined {
    return this.hooks.voiceStatesByMember().get(id);
  }

  // ---- pure view-model builders ----------------------------------------------

  buildVoiceStatesByChannel(states: VoiceState[], memberList: Member[]): Map<string, VoiceState[]> {
    const memberNames = new Map(memberList.map((member) => [member.member_id, member.display_name]));
    const byChannel = new Map<string, VoiceState[]>();
    for (const state of states) {
      const items = byChannel.get(state.channel_id) ?? [];
      items.push(state);
      byChannel.set(state.channel_id, items);
    }
    for (const [channelID, items] of byChannel.entries()) {
      byChannel.set(
        channelID,
        items.sort((left, right) =>
          (memberNames.get(left.member_id) ?? left.member_id).localeCompare(
            memberNames.get(right.member_id) ?? right.member_id
          )
        )
      );
    }
    return byChannel;
  }

  buildVoiceDisplayStatesByChannel(statesByChannel: Map<string, VoiceState[]>): Map<string, VoiceState[]> {
    const displayByChannel = new Map<string, VoiceState[]>();
    const representativeByMember = new Map<string, VoiceState>();
    for (const channelStates of statesByChannel.values()) {
      for (const state of channelStates) {
        const current = representativeByMember.get(state.member_id);
        if (!current || (current.mode === "listener" && state.mode === "primary")) {
          representativeByMember.set(state.member_id, state);
        }
      }
    }
    for (const [channelId, channelStates] of statesByChannel.entries()) {
      const displayStates: VoiceState[] = [];
      for (const state of channelStates) {
        if (representativeByMember.get(state.member_id)?.participant_id === state.participant_id) {
          displayStates.push(state);
        }
      }
      displayByChannel.set(channelId, displayStates);
    }
    return displayByChannel;
  }

  buildPrimaryVoiceStatesByMember(states: VoiceState[]): Map<string, VoiceState> {
    const byMember = new Map<string, VoiceState>();
    for (const state of states) {
      const existing = byMember.get(state.member_id);
      if (!existing || (existing.mode !== "primary" && state.mode === "primary")) {
        byMember.set(state.member_id, state);
      }
    }
    return byMember;
  }

  buildMemberGroups(memberList: Member[], roleList: ServerRole[]): MemberGroup[] {
    const sorted = [...memberList].sort((left, right) => left.display_name.localeCompare(right.display_name));
    const online = sorted.filter((member) => member.online);
    const offline = sorted.filter((member) => !member.online);
    const assigned = new Set<string>();
    const groups: MemberGroup[] = [];
    for (const role of this.hooks.permissionsController().sortRoles(roleList).filter((item) => !item.is_everyone && item.display_separately)) {
      const roleMembers = online.filter(
        (member) => !assigned.has(member.member_id) &&
          this.hooks.permissionsController().highestDisplayedRole(member, roleList)?.role_id === role.role_id
      );
      if (roleMembers.length === 0) continue;
      roleMembers.forEach((member) => assigned.add(member.member_id));
      groups.push({ key: `role:${role.role_id}`, label: role.name, members: roleMembers, role });
    }
    const remainingOnline = online.filter((member) => !assigned.has(member.member_id));
    if (remainingOnline.length > 0) {
      groups.push({ key: "online", label: this.hooks.translate("members.online"), members: remainingOnline });
    }
    if (offline.length > 0) {
      groups.push({ key: "offline", label: this.hooks.translate("members.offline"), members: offline });
    }
    return groups;
  }

  filterMemberPanelMembers(
    memberList: Member[],
    channelId: string,
    accessibleMemberIds: Set<string>,
    query: string
  ): Member[] {
    const normalizedQuery = query.trim().toLocaleLowerCase(this.hooks.languagePackId());
    const roles = this.hooks.roles();
    return memberList.filter((member) => {
      if (channelId && !accessibleMemberIds.has(member.member_id)) return false;
      if (!normalizedQuery) return true;
      const roleNames = roles
        .filter((role) => member.role_ids.includes(role.role_id))
        .map((role) => role.name)
        .join(" ");
      return `${member.display_name ?? ""} ${roleNames}`
        .toLocaleLowerCase(this.hooks.languagePackId())
        .includes(normalizedQuery);
    });
  }

  // ---- member access filter & search -----------------------------------------

  async focusMemberAccessFilter(channelId: string): Promise<void> {
    if (!channelId || !this.hooks.sessionToken()) {
      this.clearMemberAccessFilter();
      return;
    }
    const requestId = ++this.memberAccessFilterRequestId;
    this.memberAccessFilterChannelId = channelId;
    this.memberAccessFilterMemberIds = new Set<string>();
    this.memberAccessFilterLoading = true;
    try {
      const memberIDs = await getChannelAccessibleMemberIDs(
        this.hooks.baseUrl(),
        this.hooks.sessionToken(),
        channelId
      );
      if (requestId !== this.memberAccessFilterRequestId || this.memberAccessFilterChannelId !== channelId) return;
      this.memberAccessFilterMemberIds = new Set(memberIDs);
    } catch {
      if (requestId !== this.memberAccessFilterRequestId || this.memberAccessFilterChannelId !== channelId) return;
      // Older servers may not expose the access query; keep the channel visible
      // and retry on the next focus/reconnect.
      this.memberAccessFilterMemberIds = new Set(this.hooks.members().map((member) => member.member_id));
    } finally {
      if (requestId === this.memberAccessFilterRequestId) this.memberAccessFilterLoading = false;
    }
    this.hooks.flushAliases();
  }

  clearMemberAccessFilter(): void {
    this.memberAccessFilterRequestId += 1;
    this.memberAccessFilterChannelId = "";
    this.memberAccessFilterMemberIds = new Set<string>();
    this.memberAccessFilterLoading = false;
    this.hooks.flushAliases();
  }

  async toggleMemberSearch(): Promise<void> {
    this.memberSearchOpen = !this.memberSearchOpen;
    if (!this.memberSearchOpen) {
      this.memberSearchQuery = "";
      this.hooks.flushAliases();
      return;
    }
    await tick();
    this.hooks.memberSearchInputElement()?.focus();
    this.hooks.flushAliases();
  }

  // ---- join / leave orchestration --------------------------------------------

  async toggleVoiceChannel(channel: Channel): Promise<void> {
    if (
      !this.hooks.sessionToken() ||
      !this.hooks.channelsController().isVoiceChannel(channel) ||
      this.hooks.voiceActionBusy()
    ) return;
    if (this.isJoinedVoiceChannel(channel.channel_id)) return;
    await this.joinVoiceRoom(channel.channel_id);
  }

  async joinVoiceRoom(channelId: string, options: { silent?: boolean } = {}): Promise<void> {
    const sessionToken = this.hooks.sessionToken();
    if (!sessionToken || this.hooks.voiceActionBusy()) return;
    if (!this.hooks.nativeDesktopRuntime()) this.hooks.prepareVoiceAudioPlayback();
    this.hooks.setVoiceActionBusy(true);
    this.hooks.setError("");
    const joinServerId = this.hooks.server()?.server_id || this.hooks.activeServerId();
    const joinServerName = this.hooks.server()?.name || this.hooks.activeSavedServerValue()?.name || "EchoVoice";
    const joinBaseUrl = this.hooks.baseUrl();
    const joinSessionToken = sessionToken;
    const joinMemberId = this.hooks.memberId();
    const joinDeviceId = this.hooks.localUserProfile().local_profile_id;
    const joinIceServers = this.hooks.rtcIceServers().map((item) => ({ ...item, urls: [...item.urls] }));
    const joinChannelName = this.hooks.channels().find((channel) => channel.channel_id === channelId)?.name || channelId;
    const previousContext = this.hooks.voiceConnectionContext();
    const previousVoiceChannelId = previousContext?.channelId ?? "";
    try {
      if (previousContext && previousContext.serverId !== joinServerId) {
        await this.disconnectVoiceConnection(previousContext, false);
      }
      this.hooks.audio().isSpeaking = false;
      let state: VoiceState;
      try {
        state = await this.hooks.abortableRequestWithTimeout(
          (signal) => joinVoiceChannel(joinBaseUrl, channelId, joinSessionToken, { signal }),
          8000,
          this.hooks.translate("error.voiceJoinFailed")
        );
      } catch (caught) {
        if ((caught as Error & { code?: string })?.code !== "EV_VOICE_DEVICE_CONFLICT") throw caught;
        // Automatic rejoin never interrupts the user with takeover dialogs.
        if (options.silent) throw caught;
        const takeover = await this.hooks.showAppConfirm(this.hooks.translate("voice.deviceConflictTakeover"), {
          title: this.hooks.translate("voice.deviceConflictTitle"),
          confirmLabel: this.hooks.translate("voice.takeOverDevice")
        });
        if (takeover) {
          state = await this.hooks.abortableRequestWithTimeout(
            (signal) => joinVoiceChannel(joinBaseUrl, channelId, joinSessionToken, { takeover: true, signal }),
            8000,
            this.hooks.translate("error.voiceJoinFailed")
          );
        } else {
          const listen = await this.hooks.showAppConfirm(this.hooks.translate("voice.deviceConflictListen"), {
            title: this.hooks.translate("voice.deviceConflictTitle"),
            confirmLabel: this.hooks.translate("voice.joinListenOnly")
          });
          if (!listen) return;
          state = await this.hooks.abortableRequestWithTimeout(
            (signal) => joinVoiceChannel(joinBaseUrl, channelId, joinSessionToken, { mode: "listener", signal }),
            8000,
            this.hooks.translate("error.voiceJoinFailed")
          );
        }
      }
      if (state.mode === "listener") {
        this.hooks.audio().micMuted = true;
        this.hooks.audio().isSpeaking = false;
      }
      if (previousContext?.serverId === joinServerId && previousVoiceChannelId && previousVoiceChannelId !== state.channel_id) {
        this.hooks.voiceState().clearVoiceSpeakingStates(previousVoiceChannelId);
        this.hooks.stopVoiceSession();
      }
      const localState = this.hooks.applyLocalVoiceFlags(state);
      this.hooks.voiceState().voiceConnectionContext = {
        serverId: joinServerId,
        serverName: joinServerName,
        baseUrl: joinBaseUrl,
        sessionToken: joinSessionToken,
        memberId: joinMemberId,
        deviceId: state.device_id || joinDeviceId,
        channelId: state.channel_id,
        channelName: joinChannelName,
        iceServers: joinIceServers,
        syncSupported: true,
        state: localState
      };
      this.hooks.voiceSession().setConnectionStatus("connecting");
      this.hooks.voiceState().connectedVoiceStates = this.hooks.voiceState().sortVoiceStates([
        ...this.hooks.voiceStates().filter((item) => item.participant_id !== localState.participant_id),
        localState
      ]);
      this.hooks.voiceState().mergeVoiceState(localState);
      await this.hooks.syncCurrentVoiceState();
      if (!(await this.hooks.voiceState().refreshVoiceStates(true))) {
        await this.hooks.voiceState().refreshVoiceStates(true);
      }
      await this.hooks.startVoiceSession(state.channel_id);
      if (this.hooks.voiceSession().connectionStatus === "connected") this.hooks.playUISound("channel-join");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.voiceJoinFailed"));
    } finally {
      this.hooks.setVoiceActionBusy(false);
    }
  }

  async leaveCurrentVoiceChannel(): Promise<void> {
    const context = this.hooks.voiceConnectionContext();
    if (!context || this.hooks.voiceActionBusy()) return;
    this.hooks.setVoiceActionBusy(true);
    this.hooks.setError("");
    try {
      await this.disconnectVoiceConnection(context, true);
      this.hooks.playUISound("channel-leave");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.voiceLeaveFailed"));
    } finally {
      this.hooks.setVoiceActionBusy(false);
    }
  }

  async disconnectVoiceConnection(context: VoiceConnectionContext, reportFailure: boolean): Promise<void> {
    // Stop local media immediately; server cleanup retries independently.
    const activeShare = context.serverId === this.hooks.activeServerId() ? this.hooks.screenShareSetup().currentMemberShare() : undefined;
    void this.hooks.releaseLocalScreenShareTransport(activeShare);
    let removedState: VoiceState | null = null;
    let requestFailure: unknown = null;
    try {
      removedState = await this.hooks.abortableRequestWithTimeout(
        (signal) => leaveVoiceChannel(context.baseUrl, context.sessionToken, signal),
        5000,
        this.hooks.translate("error.voiceLeaveFailed")
      );
    } catch (caught) {
      requestFailure = caught;
      void this.retryVoiceLeave(context);
    }

    const leavingState = removedState?.participant_id ? removedState : context.state;
    this.hooks.voiceState().connectedVoiceStates = this.hooks.voiceState().connectedVoiceStates.filter(
      (item) => item.participant_id !== context.state.participant_id
    );
    if (context.serverId === this.hooks.activeServerId()) {
      this.hooks.voiceState().voiceStates = this.hooks.voiceState().voiceStates.filter(
        (item) => !(item.member_id === context.memberId && item.device_id === context.deviceId)
      );
    }
    this.hooks.voiceState().clearVoiceSpeakingStates(context.channelId);
    this.hooks.closePeerConnection(leavingState.participant_id, leavingState.member_id);
    this.hooks.stopVoiceSession({ clearVoicePanel: context.serverId === this.hooks.activeServerId() });
    this.hooks.voiceState().clearVoiceConnectionContext();
    this.hooks.realtime().clearVoiceRejoinArmed();
    if (context.serverId === this.hooks.activeServerId()) void this.hooks.voiceState().refreshVoiceStates();
    if (requestFailure && reportFailure) throw requestFailure;
  }

  async retryVoiceLeave(context: VoiceConnectionContext): Promise<void> {
    for (const delayMS of [500, 1500, 3500]) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMS));
      try {
        await this.hooks.abortableRequestWithTimeout(
          (signal) => leaveVoiceChannel(context.baseUrl, context.sessionToken, signal),
          4000,
          this.hooks.translate("error.voiceLeaveFailed")
        );
        return;
      } catch {
        // The event socket close remains a final server-side cleanup path.
      }
    }
  }

  // ---- voice participant selection / drag / context menu / duration ----------

  private voiceStatesByParticipant(): Map<string, VoiceState> {
    return new Map(this.hooks.voiceStates().map((state) => [state.participant_id, state]));
  }

  private voiceDisplayStatesByChannel(): Map<string, VoiceState[]> {
    return this.buildVoiceDisplayStatesByChannel(
      this.buildVoiceStatesByChannel(this.hooks.voiceStates(), this.hooks.members())
    );
  }

  private memberById(memberIdValue: string): Member | undefined {
    return this.hooks.members().find((member) => member.member_id === memberIdValue);
  }

  forgetSelectedVoiceParticipant(participantId: string): void {
    if (this.selectedVoiceParticipantIds.has(participantId)) {
      const next = new Set(this.selectedVoiceParticipantIds);
      next.delete(participantId);
      this.selectedVoiceParticipantIds = next;
    }
    if (this.voiceParticipantSelectionAnchorId === participantId) this.voiceParticipantSelectionAnchorId = "";
  }

  voiceParticipantSelectionOrder(): VoiceState[] {
    const ordered: VoiceState[] = [];
    const seen = new Set<string>();
    const channels = this.hooks.channels();
    const displayByChannel = this.voiceDisplayStatesByChannel();
    for (const channel of channels) {
      if (!this.hooks.channelsController().isVoiceChannel(channel)) continue;
      for (const state of displayByChannel.get(channel.channel_id) ?? []) {
        if (seen.has(state.participant_id)) continue;
        seen.add(state.participant_id);
        ordered.push(state);
      }
    }
    return ordered;
  }

  updateVoiceParticipantSelection(state: VoiceState, event: MouseEvent | PointerEvent): void {
    const toggle = event.ctrlKey || event.metaKey;
    if (event.shiftKey && this.voiceParticipantSelectionAnchorId) {
      const ordered = this.voiceParticipantSelectionOrder();
      const anchorIndex = ordered.findIndex((item) => item.participant_id === this.voiceParticipantSelectionAnchorId);
      const targetIndex = ordered.findIndex((item) => item.participant_id === state.participant_id);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const [start, end] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        const range = ordered.slice(start, end + 1).map((item) => item.participant_id);
        this.selectedVoiceParticipantIds = toggle
          ? new Set([...this.selectedVoiceParticipantIds, ...range])
          : new Set(range);
        return;
      }
    }
    if (toggle) {
      const next = new Set(this.selectedVoiceParticipantIds);
      if (next.has(state.participant_id)) next.delete(state.participant_id);
      else next.add(state.participant_id);
      this.selectedVoiceParticipantIds = next;
    } else if (!this.selectedVoiceParticipantIds.has(state.participant_id) || this.selectedVoiceParticipantIds.size <= 1) {
      this.selectedVoiceParticipantIds = new Set([state.participant_id]);
    }
    this.voiceParticipantSelectionAnchorId = state.participant_id;
  }

  prepareVoiceParticipantContextSelection(state: VoiceState, event?: MouseEvent): void {
    if (this.selectedVoiceParticipantIds.has(state.participant_id)) return;
    this.selectedVoiceParticipantIds = event && (event.ctrlKey || event.metaKey)
      ? new Set([...this.selectedVoiceParticipantIds, state.participant_id])
      : new Set([state.participant_id]);
    this.voiceParticipantSelectionAnchorId = state.participant_id;
  }

  openMemberContextMenuAt(member: Member, state: VoiceState | undefined, clientX: number, clientY: number): void {
    this.hooks.closeCreateChannelMenu();
    this.hooks.closeChannelContextMenu();
    this.hooks.closeMessageContextMenu();
    this.hooks.closeServerMenu();
    this.hooks.closeVoiceNetworkDetails();
    const menuWidth = 280;
    const menuHeight = Math.min(500, window.innerHeight - 16);
    this.voiceParticipantContextMenu = {
      memberId: member.member_id,
      participantId: state?.participant_id,
      x: Math.max(8, Math.min(clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(clientY, window.innerHeight - menuHeight - 8))
    };
    const audio = this.hooks.audio();
    audio.voiceParticipantMenuVolumePercent = audio.memberVolumePercent(member.member_id);
    audio.voiceParticipantMenuMusicVolumePercent = audio.memberMusicVolumePercent(member.member_id);
    this.voiceParticipantDurationStats = null;
    this.voiceParticipantDurationError = "";
    this.voiceParticipantDurationNowMS = Date.now();
    this.startVoiceParticipantDurationClock();
    void this.loadVoiceParticipantDuration(member.member_id);
  }

  openVoiceParticipantContextMenuAt(state: VoiceState, clientX: number, clientY: number, event?: MouseEvent): void {
    const member = this.memberById(state.member_id);
    if (!member) return;
    this.prepareVoiceParticipantContextSelection(state, event);
    this.openMemberContextMenuAt(member, state, clientX, clientY);
  }

  openVoiceParticipantContextMenu = (state: VoiceState, event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    this.openVoiceParticipantContextMenuAt(state, event.clientX, event.clientY, event);
  };

  openMemberContextMenu = (member: Member, event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const state = this.hooks.voiceStatesByMember().get(member.member_id);
    if (state) this.prepareVoiceParticipantContextSelection(state, event);
    else this.selectedVoiceParticipantIds = new Set<string>();
    this.openMemberContextMenuAt(member, state, event.clientX, event.clientY);
  };

  openVoiceParticipantContextMenuFromEvent(event: MouseEvent): boolean {
    const target = this.hooks.eventTargetElement(event.target);
    if (!target) return false;
    const participant = target.closest<HTMLElement>("[data-voice-participant-id]");
    const targetParticipantId = participant?.dataset.voiceParticipantId ?? "";
    if (!targetParticipantId) return false;
    const state = this.hooks.voiceState().voiceStateByParticipant(targetParticipantId);
    if (!state) return false;
    this.openVoiceParticipantContextMenu(state, event);
    return true;
  }

  handleVoiceParticipantKeydown = (state: VoiceState, event: KeyboardEvent): void => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const rect = event.currentTarget instanceof HTMLElement
      ? event.currentTarget.getBoundingClientRect()
      : { left: 0, top: 0, right: 0, height: 0 };
    this.prepareVoiceParticipantContextSelection(state);
    this.openVoiceParticipantContextMenuAt(state, rect.right + 6, rect.top + rect.height / 2);
  };

  handleMemberContextMenuKeydown = (member: Member, event: KeyboardEvent): void => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    const rect = event.currentTarget instanceof HTMLElement
      ? event.currentTarget.getBoundingClientRect()
      : { left: 0, top: 0, right: 0, height: 0 };
    const state = this.hooks.voiceStatesByMember().get(member.member_id);
    if (state) this.prepareVoiceParticipantContextSelection(state);
    else this.selectedVoiceParticipantIds = new Set<string>();
    this.openMemberContextMenuAt(
      member,
      state,
      rect.right + 6,
      rect.top + rect.height / 2
    );
  };

  closeVoiceParticipantContextMenu(): void {
    this.voiceParticipantDurationRequestId += 1;
    this.voiceParticipantDurationLoading = false;
    this.voiceParticipantDurationStats = null;
    this.voiceParticipantDurationError = "";
    this.stopVoiceParticipantDurationClock();
    this.voiceParticipantContextMenu = null;
  }

  loadVoiceParticipantDuration = async (targetMemberId: string): Promise<void> => {
    if (!this.hooks.sessionToken()) return;
    const requestId = ++this.voiceParticipantDurationRequestId;
    this.voiceParticipantDurationLoading = true;
    this.voiceParticipantDurationError = "";
    try {
      const stats = await getMemberVoiceDuration(this.hooks.baseUrl(), this.hooks.sessionToken(), targetMemberId);
      if (requestId !== this.voiceParticipantDurationRequestId || this.voiceParticipantContextMenu?.memberId !== targetMemberId) return;
      this.voiceParticipantDurationStats = stats;
      this.voiceParticipantDurationNowMS = Date.now();
    } catch (caught) {
      if (requestId !== this.voiceParticipantDurationRequestId) return;
      this.voiceParticipantDurationError = caught instanceof Error ? caught.message : this.hooks.translate("voice.durationLoadFailed");
    } finally {
      if (requestId === this.voiceParticipantDurationRequestId) this.voiceParticipantDurationLoading = false;
    }
  };

  startVoiceParticipantDurationClock(): void {
    this.stopVoiceParticipantDurationClock();
    this.voiceParticipantDurationClock = window.setInterval(() => {
      this.voiceParticipantDurationNowMS = Date.now();
    }, 1000);
  }

  stopVoiceParticipantDurationClock(): void {
    if (this.voiceParticipantDurationClock !== undefined) {
      window.clearInterval(this.voiceParticipantDurationClock);
      this.voiceParticipantDurationClock = undefined;
    }
  }

  displayedVoiceDuration = (kind: "total" | "shared"): number => {
    const stats = this.voiceParticipantDurationStats;
    if (!stats) return 0;
    const baseDuration = kind === "total" ? stats.total_voice_duration_ms : stats.shared_voice_duration_ms;
    const active = kind === "total" ? stats.member_active : stats.shared_active;
    return baseDuration + (active ? Math.max(0, this.voiceParticipantDurationNowMS - stats.measured_at_ms) : 0);
  };

  formatVoiceDuration = (durationMS: number): string => {
    let remainingSeconds = Math.max(0, Math.floor(durationMS / 1000));
    const days = Math.floor(remainingSeconds / 86400);
    remainingSeconds %= 86400;
    const hours = Math.floor(remainingSeconds / 3600);
    remainingSeconds %= 3600;
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    if (days > 0) {
      return [this.hooks.translate("voice.durationDays", { count: days }), this.hooks.translate("voice.durationHours", { count: hours })].join(" ");
    }
    if (hours > 0) {
      return [this.hooks.translate("voice.durationHours", { count: hours }), this.hooks.translate("voice.durationMinutes", { count: minutes })].join(" ");
    }
    if (minutes > 0) {
      return [this.hooks.translate("voice.durationMinutes", { count: minutes }), this.hooks.translate("voice.durationSeconds", { count: seconds })].join(" ");
    }
    return this.hooks.translate("voice.durationSeconds", { count: seconds });
  };

  manageVoiceParticipantFromMenu = async (patch: Partial<VoiceState>): Promise<void> => {
    const selected = this.selectedVoiceContextStates();
    this.closeVoiceParticipantContextMenu();
    for (const state of selected) {
      const member = this.memberById(state.member_id);
      if (!member || !this.canManageVoiceParticipant(state) || state.member_id === this.hooks.memberId()) continue;
      await this.updateManagedVoiceState(member, state, patch);
    }
  };

  selectedVoiceContextStates(): VoiceState[] {
    const menu = this.voiceParticipantContextMenu;
    const selected = menu
      ? this.hooks.voiceStates().filter((state) => this.selectedVoiceParticipantIds.has(state.participant_id))
      : [];
    const source = selected.length > 0
      ? selected
      : (() => {
          if (!menu) return [];
          const stateValue = menu.participantId
            ? this.voiceStatesByParticipant().get(menu.participantId)
            : this.hooks.voiceStatesByMember().get(menu.memberId);
          return stateValue ? [stateValue] : [];
        })();
    const seenMembers = new Set<string>();
    return source.filter((state) => {
      if (seenMembers.has(state.member_id)) return false;
      seenMembers.add(state.member_id);
      return true;
    });
  }

  selectedVoiceContextMembers(): Member[] {
    const selectedStates = this.selectedVoiceContextStates();
    const menu = this.voiceParticipantContextMenu;
    const menuMember = menu ? this.memberById(menu.memberId) : undefined;
    const selected = selectedStates.length > 0
      ? selectedStates.map((state) => this.memberById(state.member_id))
      : [menuMember];
    const seen = new Set<string>();
    return selected.filter((member): member is Member => {
      if (!member || seen.has(member.member_id)) return false;
      seen.add(member.member_id);
      return true;
    });
  }

  selectedVoiceStatesAll = (field: "server_muted" | "server_deafened"): boolean => {
    const selected = this.selectedVoiceContextStates().filter((state) => state.member_id !== this.hooks.memberId());
    return selected.length > 0 && selected.every((state) => Boolean(state[field]));
  };

  selectedVoiceContextAllInChannel = (channelId: string): boolean => {
    const selected = this.selectedVoiceContextStates();
    return selected.length > 0 && selected.every(
      (state) => this.memberVoiceStates(state.member_id).every((memberState) => memberState.channel_id === channelId)
    );
  };

  moveVoiceParticipantsFromMenu = async (channelId: string): Promise<void> => {
    const selected = this.selectedVoiceContextStates();
    this.closeVoiceParticipantContextMenu();
    for (const state of selected) {
      const member = this.memberById(state.member_id);
      if (!member || !this.canDragVoiceParticipant(state)) continue;
      if (this.memberVoiceStates(member.member_id).every((item) => item.channel_id === channelId)) continue;
      await this.moveVoiceMemberGroup(member, state, channelId);
    }
  };

  canManageVoiceParticipant(state: VoiceState | undefined): boolean {
    return Boolean(
      state &&
        (this.hooks.canMuteVoiceMembers() || this.hooks.canDeafenVoiceMembers() || this.hooks.canMoveVoiceMembers()) &&
        state.member_id !== this.hooks.memberId() &&
        this.memberById(state.member_id)
    );
  }

  canDragVoiceParticipant = (state: VoiceState | undefined): boolean => {
    return Boolean(state && (state.member_id === this.hooks.memberId() || this.canManageVoiceParticipant(state)));
  };

  clearVoiceParticipantDrag(): void {
    this.voiceParticipantDragMemberId = "";
    this.voiceParticipantDragParticipantId = "";
    this.voiceParticipantDragOverChannelId = "";
    this.voiceParticipantDragX = 0;
    this.voiceParticipantDragY = 0;
    document.body.classList.remove(VoiceStageController.voiceParticipantDragBodyClass);
    this.voiceParticipantPointerPress = null;
    this.detachVoiceParticipantDocumentPointerListeners();
    this.detachVoiceParticipantDocumentMouseListeners();
  }

  handleVoiceParticipantPointerDown = (state: VoiceState, event: PointerEvent): void => {
    this.voiceParticipantLastPointerDownId = state.participant_id;
    this.voiceParticipantLastPointerDownAt = performance.now();
    this.beginVoiceParticipantPointerPress(state, event, event.pointerId);
  };

  handleVoiceParticipantMouseDown = (state: VoiceState, event: MouseEvent): void => {
    if (this.voiceParticipantPointerPress) return;
    if (
      this.voiceParticipantLastPointerDownId === state.participant_id &&
      performance.now() - this.voiceParticipantLastPointerDownAt < 150
    ) return;
    this.beginVoiceParticipantPointerPress(state, event);
  };

  beginVoiceParticipantPointerPress(state: VoiceState, event: MouseEvent | PointerEvent, pointerId?: number): void {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, a, input, select, textarea")) return;
    this.updateVoiceParticipantSelection(state, event);
    event.preventDefault();
    this.closeVoiceParticipantContextMenu();
    if (!this.canDragVoiceParticipant(state)) return;
    this.voiceParticipantDragX = event.clientX;
    this.voiceParticipantDragY = event.clientY;
    this.voiceParticipantPointerPress = {
      memberId: state.member_id,
      participantId: state.participant_id,
      x: event.clientX,
      y: event.clientY,
      pointerId,
      dragging: false
    };
    this.voiceParticipantDragMemberId = state.member_id;
    this.voiceParticipantDragParticipantId = state.participant_id;
    this.attachVoiceParticipantDocumentPointerListeners();
    this.attachVoiceParticipantDocumentMouseListeners();
  }

  handleVoiceParticipantPointerMove = (state: VoiceState, event: PointerEvent): void => {
    if (this.voiceParticipantPointerPress?.pointerId !== event.pointerId) return;
    this.moveVoiceParticipantPointerPress(state, event.clientX, event.clientY, event);
  };

  moveVoiceParticipantPointerPress(
    state: VoiceState,
    clientX: number,
    clientY: number,
    event?: MouseEvent | PointerEvent
  ): void {
    const press = this.voiceParticipantPointerPress;
    if (!press || press.memberId !== state.member_id) return;
    const distance = Math.hypot(clientX - press.x, clientY - press.y);
    if (!press.dragging && distance < 5) return;
    event?.preventDefault();
    event?.stopPropagation();
    if (!press.dragging) {
      this.hooks.closeChannelContextMenu();
      this.hooks.closeMessageContextMenu();
      this.hooks.closeServerMenu();
      this.hooks.closeVoiceNetworkDetails();
      this.voiceParticipantPointerPress = { ...press, dragging: true };
      document.body.classList.add(VoiceStageController.voiceParticipantDragBodyClass);
    }
    this.voiceParticipantDragX = clientX;
    this.voiceParticipantDragY = clientY;
    this.updateVoiceParticipantDragTarget(clientX, clientY);
  }

  handleVoiceParticipantPointerUp = (state: VoiceState, event: PointerEvent): void => {
    if (this.voiceParticipantPointerPress?.pointerId !== event.pointerId) return;
    this.finishVoiceParticipantPointerPress(state, event.clientX, event.clientY, event);
  };

  finishVoiceParticipantPointerPress(
    state: VoiceState,
    clientX: number,
    clientY: number,
    event?: MouseEvent | PointerEvent
  ): void {
    const press = this.voiceParticipantPointerPress;
    if (!press || press.memberId !== state.member_id) return;
    if (!press.dragging) {
      this.clearVoiceParticipantDrag();
      return;
    }
    event?.preventDefault();
    event?.stopPropagation();
    void this.finishVoiceParticipantPointerDrop(clientX, clientY);
  }

  handleVoiceParticipantPointerCancel = (state: VoiceState, event: PointerEvent): void => {
    const press = this.voiceParticipantPointerPress;
    if (!press || press.memberId !== state.member_id || press.pointerId !== event.pointerId) return;
    this.clearVoiceParticipantDrag();
  };

  attachVoiceParticipantDocumentPointerListeners(): void {
    if (this.voiceParticipantDocumentPointerListenersAttached) return;
    document.addEventListener("pointermove", this.handleVoiceParticipantDocumentPointerMove, true);
    document.addEventListener("pointerup", this.handleVoiceParticipantDocumentPointerUp, true);
    document.addEventListener("pointercancel", this.handleVoiceParticipantDocumentPointerCancel, true);
    window.addEventListener("blur", this.handleVoiceParticipantDocumentPointerCancel, true);
    this.voiceParticipantDocumentPointerListenersAttached = true;
  }

  detachVoiceParticipantDocumentPointerListeners(): void {
    if (!this.voiceParticipantDocumentPointerListenersAttached) return;
    document.removeEventListener("pointermove", this.handleVoiceParticipantDocumentPointerMove, true);
    document.removeEventListener("pointerup", this.handleVoiceParticipantDocumentPointerUp, true);
    document.removeEventListener("pointercancel", this.handleVoiceParticipantDocumentPointerCancel, true);
    window.removeEventListener("blur", this.handleVoiceParticipantDocumentPointerCancel, true);
    this.voiceParticipantDocumentPointerListenersAttached = false;
  }

  attachVoiceParticipantDocumentMouseListeners(): void {
    if (this.voiceParticipantDocumentMouseListenersAttached) return;
    document.addEventListener("mousemove", this.handleVoiceParticipantDocumentMouseMove, true);
    document.addEventListener("mouseup", this.handleVoiceParticipantDocumentMouseUp, true);
    this.voiceParticipantDocumentMouseListenersAttached = true;
  }

  detachVoiceParticipantDocumentMouseListeners(): void {
    if (!this.voiceParticipantDocumentMouseListenersAttached) return;
    document.removeEventListener("mousemove", this.handleVoiceParticipantDocumentMouseMove, true);
    document.removeEventListener("mouseup", this.handleVoiceParticipantDocumentMouseUp, true);
    this.voiceParticipantDocumentMouseListenersAttached = false;
  }

  handleVoiceParticipantDocumentPointerMove = (event: PointerEvent): void => {
    const press = this.voiceParticipantPointerPress;
    if (!press || press.pointerId !== event.pointerId) return;
    const state = this.memberVoiceState(press.memberId);
    if (!state || !this.canDragVoiceParticipant(state)) {
      this.clearVoiceParticipantDrag();
      return;
    }
    this.handleVoiceParticipantPointerMove(state, event);
  };

  handleVoiceParticipantDocumentPointerUp = (event: PointerEvent): void => {
    const press = this.voiceParticipantPointerPress;
    if (!press || press.pointerId !== event.pointerId) return;
    const state = this.memberVoiceState(press.memberId);
    if (!state) {
      this.clearVoiceParticipantDrag();
      return;
    }
    this.handleVoiceParticipantPointerUp(state, event);
  };

  handleVoiceParticipantDocumentMouseMove = (event: MouseEvent): void => {
    const press = this.voiceParticipantPointerPress;
    if (!press) return;
    const state = this.memberVoiceState(press.memberId);
    if (!state || !this.canDragVoiceParticipant(state)) {
      this.clearVoiceParticipantDrag();
      return;
    }
    this.moveVoiceParticipantPointerPress(state, event.clientX, event.clientY, event);
  };

  handleVoiceParticipantDocumentMouseUp = (event: MouseEvent): void => {
    const press = this.voiceParticipantPointerPress;
    if (!press) return;
    const state = this.memberVoiceState(press.memberId);
    if (!state) {
      this.clearVoiceParticipantDrag();
      return;
    }
    this.finishVoiceParticipantPointerPress(state, event.clientX, event.clientY, event);
  };

  handleVoiceParticipantDocumentPointerCancel = (event?: PointerEvent | Event): void => {
    const pointerEvent = event instanceof PointerEvent ? event : undefined;
    const press = this.voiceParticipantPointerPress;
    if (pointerEvent && press && pointerEvent.pointerId !== press.pointerId) return;
    this.clearVoiceParticipantDrag();
  };

  updateVoiceParticipantDragTarget(clientX: number, clientY: number): void {
    const channel = this.voiceDropChannelFromPoint(clientX, clientY);
    const state = this.voiceParticipantDragParticipantId
      ? this.voiceStatesByParticipant().get(this.voiceParticipantDragParticipantId)
      : undefined;
    const dragStates = state ? this.voiceParticipantDragStates(state) : [];
    const allMembersAlreadyInTarget = Boolean(
      channel &&
      dragStates.length > 0 &&
      dragStates.every((item) => this.memberVoiceStates(item.member_id).every((memberState) => memberState.channel_id === channel.channel_id))
    );
    this.voiceParticipantDragOverChannelId =
      channel && dragStates.some((item) => this.canDragVoiceParticipant(item)) && !allMembersAlreadyInTarget
        ? channel.channel_id
        : "";
  }

  voiceParticipantDragStates(fallback: VoiceState): VoiceState[] {
    const selected = this.selectedVoiceParticipantIds.has(fallback.participant_id)
      ? this.hooks.voiceStates().filter((state) => this.selectedVoiceParticipantIds.has(state.participant_id))
      : [fallback];
    const seenMembers = new Set<string>();
    return selected.filter((state) => {
      if (seenMembers.has(state.member_id)) return false;
      seenMembers.add(state.member_id);
      return true;
    });
  }

  async finishVoiceParticipantPointerDrop(clientX: number, clientY: number): Promise<void> {
    this.updateVoiceParticipantDragTarget(clientX, clientY);
    const draggedMemberId = this.voiceParticipantDragMemberId;
    const draggedParticipantId = this.voiceParticipantDragParticipantId;
    const targetChannelId = this.voiceParticipantDragOverChannelId;
    this.clearVoiceParticipantDrag();
    if (!draggedMemberId || !draggedParticipantId || !targetChannelId) return;

    const state = this.voiceStatesByParticipant().get(draggedParticipantId);
    const channel = this.hooks.channels().find((item) => item.channel_id === targetChannelId);
    if (!state || !channel || !this.hooks.channelsController().isVoiceChannel(channel)) return;
    const dragStates = this.voiceParticipantDragStates(state);
    for (const selectedState of dragStates) {
      const selectedMember = this.memberById(selectedState.member_id);
      if (!selectedMember || !this.canDragVoiceParticipant(selectedState)) continue;
      if (this.memberVoiceStates(selectedState.member_id).every((item) => item.channel_id === channel.channel_id)) continue;
      await this.moveVoiceMemberGroup(selectedMember, selectedState, channel.channel_id);
    }
  }

  voiceDropChannelFromPoint(clientX: number, clientY: number): Channel | undefined {
    const element = document.elementFromPoint(clientX, clientY);
    const participant = element?.closest<HTMLElement>("[data-voice-participant-id]");
    const participantId = participant?.dataset.voiceParticipantId ?? "";
    const participantState = participantId ? this.voiceStatesByParticipant().get(participantId) : undefined;
    if (participantState) {
      return this.hooks.channels().find((item) => item.channel_id === participantState.channel_id && this.hooks.channelsController().isVoiceChannel(item));
    }

    const target = element?.closest<HTMLElement>("[data-channel-drop-target='true']");
    const channelId = target?.dataset.channelId ?? "";
    const channel = channelId ? this.hooks.channels().find((item) => item.channel_id === channelId) : undefined;
    return channel && this.hooks.channelsController().isVoiceChannel(channel) ? channel : undefined;
  }

  // ---- voice moderation / management actions ----------------------------------

  applyManagedVoiceStateResponse(state: VoiceState): void {
    state = normalizeVoiceState(state);
    const context = this.hooks.voiceConnectionContext();
    if (context?.serverId === this.hooks.activeServerId()) {
      this.hooks.realtime().handleConnectedVoiceStateUpdated(state);
      return;
    }
    this.hooks.voiceState().mergeVoiceState(state);
  }

  async moveVoiceMemberGroup(member: Member, current: VoiceState, channelId: string): Promise<void> {
    if (
      !this.hooks.sessionToken() ||
      !channelId ||
      this.memberVoiceStates(member.member_id).every((state) => state.channel_id === channelId) ||
      this.hooks.voiceManageBusyMemberId()
    ) return;
    if (member.member_id !== this.hooks.memberId()) {
      await this.updateManagedVoiceState(member, current, { channel_id: channelId });
      return;
    }
    this.hooks.setVoiceManageBusyMemberId(member.member_id);
    this.hooks.setError("");
    try {
      this.applyManagedVoiceStateResponse(
        await manageVoiceState(this.hooks.baseUrl(), this.hooks.sessionToken(), member.member_id, { channel_id: channelId })
      );
      await this.hooks.voiceState().refreshVoiceStates(true);
      this.hooks.setStatusKey("voice.managementUpdated");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.voiceManageFailed"));
    } finally {
      this.hooks.setVoiceManageBusyMemberId("");
    }
  }

  async updateManagedVoiceState(member: Member, current: VoiceState, patch: Partial<VoiceState>): Promise<void> {
    if (
      !this.hooks.sessionToken() ||
      !current ||
      !this.canManageVoiceParticipant(current) ||
      member.member_id === this.hooks.memberId() ||
      this.hooks.voiceManageBusyMemberId()
    ) return;
    this.hooks.setVoiceManageBusyMemberId(member.member_id);
    this.hooks.setError("");
    try {
      const updated = await manageVoiceState(this.hooks.baseUrl(), this.hooks.sessionToken(), member.member_id, {
        channel_id: patch.channel_id,
        server_muted: patch.server_muted ?? current.server_muted,
        server_deafened: patch.server_deafened ?? current.server_deafened
      });
      this.applyManagedVoiceStateResponse(updated);
      await this.hooks.voiceState().refreshVoiceStates(true);
      this.hooks.setStatusKey("voice.managementUpdated");
    } catch (caught) {
      this.hooks.setError(caught instanceof Error ? caught.message : this.hooks.translate("error.voiceManageFailed"));
    } finally {
      this.hooks.setVoiceManageBusyMemberId("");
    }
  }

  kickVoiceParticipantFromMenu = async (mode: VoiceKickMode): Promise<void> => {
    const selected = this.selectedVoiceContextStates().filter(
      (state) => state.member_id !== this.hooks.memberId() && this.canManageVoiceParticipant(state)
    );
    const selectedMembers = selected
      .map((state) => this.memberById(state.member_id))
      .filter((member): member is Member => Boolean(member));
    this.closeVoiceParticipantContextMenu();
    if (selectedMembers.length === 0 || !this.hooks.canMoveVoiceMembers() || this.hooks.voiceManageBusyMemberId()) return;
    const silent = mode === "silent";
    const confirmed = await this.hooks.showAppConfirm(
      selectedMembers.length === 1
        ? this.hooks.translate(silent ? "voice.kickSilentConfirm" : "voice.kickConfirm", { member: selectedMembers[0].display_name })
        : this.hooks.translate(silent ? "voice.kickSelectedSilentConfirm" : "voice.kickSelectedConfirm", { count: selectedMembers.length }), {
      title: selectedMembers.length === 1
        ? this.hooks.translate(silent ? "voice.kickSilent" : "voice.kickMember")
        : this.hooks.translate(silent ? "voice.kickSelectedSilent" : "voice.kickSelected", { count: selectedMembers.length }),
      confirmLabel: this.hooks.translate(silent ? "voice.kickSilent" : "voice.kickMember"),
      danger: true
    });
    if (!confirmed) return;
    let failed = 0;
    for (const member of selectedMembers) {
      this.hooks.setVoiceManageBusyMemberId(member.member_id);
      try {
        await kickVoiceState(this.hooks.baseUrl(), this.hooks.sessionToken(), member.member_id, mode);
        for (const memberState of this.memberVoiceStates(member.member_id)) {
          this.hooks.voiceState().removeVoiceState(memberState);
        }
      } catch {
        failed += 1;
      }
    }
    this.hooks.setVoiceManageBusyMemberId("");
    try {
      await this.hooks.voiceState().refreshVoiceStates(true);
    } catch {}
    if (failed > 0) this.hooks.setError(this.hooks.translate("voice.batchManageFailed", { count: failed }));
    else this.hooks.setStatusKey(silent ? "voice.memberKickedSilently" : "voice.memberKicked");
  };

  banVoiceParticipantFromMenu = async (): Promise<void> => {
    const selectedMembers = this.selectedVoiceContextMembers()
      .filter((member) => member.member_id !== this.hooks.memberId() && !member.is_banned);
    this.closeVoiceParticipantContextMenu();
    if (selectedMembers.length === 0 || !this.hooks.canManageMembers() || this.hooks.memberUpdating()) return;
    const confirmed = await this.hooks.showAppConfirm(
      selectedMembers.length === 1
        ? this.hooks.translate("members.banConfirm", { member: selectedMembers[0].display_name })
        : this.hooks.translate("members.banSelectedConfirm", { count: selectedMembers.length }), {
      title: selectedMembers.length === 1 ? this.hooks.translate("members.banMember") : this.hooks.translate("members.banSelected", { count: selectedMembers.length }),
      confirmLabel: this.hooks.translate("members.banMember"),
      danger: true
    });
    if (!confirmed) return;
    this.hooks.setMemberUpdating(true);
    let failed = 0;
    for (const member of selectedMembers) {
      try {
        this.hooks.realtime().mergeMember(
          await updateMember(this.hooks.baseUrl(), this.hooks.sessionToken(), member.member_id, { is_banned: true })
        );
      } catch {
        failed += 1;
      }
    }
    this.hooks.setMemberUpdating(false);
    if (failed > 0) this.hooks.setError(this.hooks.translate("members.batchUpdateFailed", { count: failed }));
    else this.hooks.setStatusKey("members.memberBanned");
  };
}
