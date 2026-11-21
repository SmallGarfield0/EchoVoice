export type ServerSummary = {
  server_id: string;
  name: string;
  icon_sha256?: string;
  icon_data_url?: string;
  description: string;
  screen_share_enabled: boolean;
  remote_control_enabled: boolean;
  accompaniment_enabled: boolean;
  soundboard_enabled: boolean;
  emoji_enabled: boolean;
  emoji_max_kb: number;
  file_storage_enabled: boolean;
  dm_relay_enabled: boolean;
  home_mailbox_enabled: boolean;
  visibility: "public" | "private";
  default_language: string;
  created_at_ms: number;
  public_server_version?: string;
  server_compatibility_version?: string;
  // Legacy field returned by early development servers.
  server_version?: string;
  minimum_client_version?: string;
};

export type Permission =
  | "administrator"
  | "view_members"
  | "view_channels"
  | "send_messages"
  | "edit_server_settings"
  | "manage_roles"
  | "manage_channels"
  | "manage_channel_permissions"
  | "manage_members"
  | "manage_messages"
  | "read_message_history"
  | "connect_voice"
  | "speak"
  | "mute_members"
  | "deafen_members"
  | "move_members"
  | "share_screen"
  | "request_remote_control"
  | "accept_remote_control"
  | "play_accompaniment"
  | "play_soundboard"
  | "manage_server_soundboard"
  | "send_emoji"
  | "manage_server_emoji"
  | "create_invites"
  | "view_files"
  | "upload_files"
  | "download_files"
  | "manage_files";

export type ServerRole = {
  role_id: string;
  name: string;
  color: string;
  gradient_color?: string;
  icon_data_url?: string;
  display_separately: boolean;
  position: number;
  is_everyone: boolean;
  member_count: number;
  permissions: Record<Permission, boolean>;
};

export type Member = {
  member_id: string;
  display_name: string;
  avatar_sha256?: string;
  avatar_data_url?: string;
  avatar_color?: string;
  bio: string;
  local_profile_id: string;
  role_ids: string[];
  is_owner: boolean;
  is_banned: boolean;
  last_seen_at_ms: number;
  profile_updated_at_ms: number;
  profile_overrides?: ProfileOverrides;
  online: boolean;
  linked_devices: number;
};

export type ProfileOverrides = {
  display_name: boolean;
  avatar: boolean;
  bio: boolean;
};

export type MemberMergeRequestStatus = "pending" | "accepted" | "rejected" | "expired" | "cancelled";

export type MemberMergeRequest = {
  request_id: string;
  target_member_id: string;
  requester_member_id: string;
  status: MemberMergeRequestStatus;
  created_at_ms: number;
  expires_at_ms: number;
  resolved_at_ms?: number;
  requester: Member;
  target: Member;
};

export type MemberMergeCode = {
  code: string;
  expires_at_ms: number;
};

export type MemberMergeRequestList = {
  incoming: MemberMergeRequest[];
  outgoing: MemberMergeRequest[];
};

export type MemberMergeResolution = {
  request: MemberMergeRequest;
  member?: Member;
};

export type Channel = {
  channel_id: string;
  parent_id?: string;
  type: "text" | "voice" | "category" | "temporary_voice";
  name: string;
  topic?: string;
  visibility: "default" | "warning";
  warning_text?: string;
  bitrate: number;
  user_limit: number;
  permission_synced: boolean;
  position: number;
  default_language?: string;
  localizations?: Record<string, ChannelLocalization>;
  effective_permissions?: Partial<Record<Permission, boolean>>;
};

export type ChannelLocalization = {
  name?: string;
  topic?: string;
  warning_text?: string;
};

export type ServerInvite = {
  invite_id: string;
  token?: string;
  creator_member_id: string;
  expires_at_ms: number;
  max_uses: number;
  use_count: number;
  created_at_ms: number;
};

export type RoleOrderItem = {
  role_id: string;
};

export type LocalUserProfile = {
  local_profile_id: string;
  display_name: string;
  avatar_data_url?: string;
  avatar_sha256?: string;
  avatar_color?: string;
  bio: string;
  updated_at_ms: number;
};

export type ChannelOrderItem = {
  channel_id: string;
  parent_id?: string;
};

export type Message = {
  message_id: string;
  channel_id: string;
  author_id: string;
  content: string;
  reply_to_message_id?: string;
  created_at_ms: number;
  edited_at_ms?: number;
  deleted_at_ms?: number;
};

export type ContentAsset = {
  sha256: string;
  size_bytes: number;
  mime_type: string;
  original_name: string;
  created_at_ms: number;
};

export type SoundboardItem = {
  item_id: string;
  name: string;
  asset_sha256: string;
  icon_emoji?: string;
  icon_asset_sha256?: string;
  start_ms: number;
  end_ms: number;
  base_volume: number;
  uploader_member_id: string;
  size_bytes: number;
  mime_type: string;
  created_at_ms: number;
  updated_at_ms: number;
};

export type SoundboardPlayback = {
  playback_id: string;
  channel_id: string;
  member_id: string;
  item_id?: string;
  name: string;
  asset_sha256: string;
  start_ms: number;
  end_ms: number;
  size_bytes: number;
  mime_type: string;
  base_volume: number;
  sender_volume: number;
  volume: number;
  play_at_ms: number;
};

export type CustomEmoji = {
  emoji_id: string;
  shortcode: string;
  asset_sha256: string;
  preview_sha256?: string;
  uploader_member_id: string;
  size_bytes: number;
  mime_type: string;
  is_gif: boolean;
  created_at_ms: number;
  updated_at_ms: number;
};

export type ChannelFileEntry = {
  entry_id: string;
  channel_id: string;
  parent_id?: string;
  type: "directory" | "file";
  name: string;
  asset_sha256?: string;
  owner_member_id: string;
  size_bytes: number;
  mime_type?: string;
  created_at_ms: number;
  updated_at_ms: number;
};

export type AuditLog = {
  audit_id: string;
  actor_member_id: string;
  action: string;
  target_type: string;
  target_id: string;
  details: Record<string, string>;
  created_at_ms: number;
};

export type ChannelPermissionOverride = {
  override_id: string;
  channel_id: string;
  target_type: "role" | "member";
  target_id: string;
  allows: Record<Permission, boolean>;
  denies: Record<Permission, boolean>;
};

export type VoiceState = {
  participant_id: string;
  channel_id: string;
  member_id: string;
  device_id: string;
  mode: "primary" | "listener";
  joined_at_ms: number;
  mic_muted: boolean;
  audio_deafened: boolean;
  server_muted: boolean;
  server_deafened: boolean;
  is_speaking: boolean;
};

export type VoiceKickMode = "notify" | "silent";

export type VoiceDurationStats = {
  member_id: string;
  compared_member_id?: string;
  total_voice_duration_ms: number;
  shared_voice_duration_ms: number;
  member_active: boolean;
  shared_active: boolean;
  measured_at_ms: number;
};

export type ScreenShareSession = {
  share_id: string;
  channel_id: string;
  owner_member_id: string;
  owner_participant_id: string;
  remote_control_allowed: boolean;
  viewer_member_ids?: string[];
  started_at_ms: number;
};

export type AccompanimentSession = {
  session_id: string;
  channel_id: string;
  owner_member_id: string;
  source_name: string;
  started_at_ms: number;
};

export type RemoteControlStatus = "pending" | "active" | "rejected" | "revoked";

export type RemoteControlSession = {
  control_id: string;
  share_id: string;
  channel_id: string;
  owner_member_id: string;
  owner_participant_id: string;
  controller_member_id: string;
  controller_participant_id: string;
  status: RemoteControlStatus;
  requested_at_ms: number;
  updated_at_ms: number;
  expires_at_ms?: number;
  lease_until_ms?: number;
  grant_generation?: number;
  transport_state?: string;
  respect_until_ms?: number;
  end_reason?: string;
};

export type RemoteControlInputEvent =
  | { type: "pointer_move"; x: number; y: number; buttons: number }
  | { type: "pointer_button"; x: number; y: number; button: number; buttons: number; pressed: boolean }
  | { type: "wheel"; x: number; y: number; delta_x: number; delta_y: number }
  | { type: "release_all" }
  | {
      type: "key";
      code: string;
      key: string;
      pressed: boolean;
      repeat: boolean;
      modifiers: Array<"Alt" | "Control" | "Meta" | "Shift">;
    };

export type RemoteControlInput = {
  control_id: string;
  sequence: number;
  controller_member_id?: string;
  controller_participant_id?: string;
  event: RemoteControlInputEvent;
};

export type DesktopCaptureSource = {
  sourceId: string;
  kind: "screen" | "window";
  name: string;
  appName?: string;
  processId?: number;
  x: number;
  y: number;
  width: number;
  height: number;
  isPrimary: boolean;
  isCurrentApp: boolean;
  thumbnailDataUrl?: string;
};

export type DesktopCaptureSources = {
  backend: string;
  sources: DesktopCaptureSource[];
  warnings: string[];
};

export type DesktopAudioProcessSource = {
  sourceId: string;
  processId: number;
  name: string;
  appName?: string;
  iconDataUrl?: string;
  active: boolean;
};

export type DesktopAudioProcessSources = {
  backend: string;
  sources: DesktopAudioProcessSource[];
  warnings: string[];
};

export type DesktopMediaCapabilities = {
  platform: "windows" | "macos" | "linux" | "web" | "unknown";
  runtime: "tauri" | "web";
  sourceEnumeration: boolean;
  thumbnails: boolean;
  nativeScreenShareSender: boolean;
  webCaptureFallback: boolean;
  supportedFrameRates: number[];
  configuredHardwareProfiles?: { width: number; height: number; frameRates: number[] }[];
  maxNativeFrameRate: number;
  hardwareH264Encoder: boolean;
  remoteControlHost: boolean;
  remoteControlSourceKinds: Array<"screen" | "window">;
  supportedSourceKinds: Array<"screen" | "window" | "application" | "browser-tab" | "game">;
  videoBackends: string[];
  audioBackends: string[];
  notes: string[];
};

export type NativeScreenShareStartRequest = {
  serverId: string;
  channelId: string;
  shareId: string;
  ownerMemberId: string;
  sourceId: string;
  sourceKind: "screen" | "window";
  sourceProcessId?: number;
  sourceX: number;
  sourceY: number;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  frameRate: number;
  targetBitrateBps?: number;
  contentMode: import("./screenShareSettings").ScreenShareContentMode;
  captureCursor: boolean;
  previewEnabled: boolean;
  includeAudio: boolean;
  remoteControlAllowed: boolean;
  iceServers: RTCIceServer[];
};

export type NativeScreenShareSenderSession = {
  sessionId: string;
  shareId: string;
  sourceId: string;
  width: number;
  height: number;
  frameRate: number;
  audioEnabled: boolean;
  phase: "starting" | "running" | "stopping" | "stopped" | "failed" | string;
};

export type NativeScreenShareSenderStatus = {
  sessionId: string;
  shareId: string;
  phase: "starting" | "running" | "stopping" | "stopped" | "failed" | string;
  backend: string;
  pipeline?: import("./screenShareNativeMetrics").NativePipelineCounters;
  pipelineMetrics?: ReturnType<typeof import("./screenShareNativeMetrics").nativePublisherMetrics>;
  viewerMemberIds: string[];
  /** Media path per viewer member id: "direct", "relay" or "unknown". */
  viewerPaths?: Record<string, string>;
  /**
   * Encode each viewer is served from: "high" (the shared full-quality encode)
   * or "low" (the reduced-tier encode). A viewer on "low" costs only its own
   * picture quality, not everybody else's.
   */
  viewerLayers?: Record<string, string>;
  targetBitrateBps: number;
  effectiveBitrateBps: number;
  receiverEstimatedBitrateBps?: number;
  capturedFrames: number;
  forwardedFrames: number;
  encodedFrames: number;
  droppedFrames: number;
  throttledFrames: number;
  encoderBackpressureDrops: number;
  viewerBackpressureDrops: number;
  audioQueueDrops?: number;
  startedAtMs: number;
  lastFrameAtMs: number;
  previewEnabled: boolean;
  previewDataUrl?: string;
  previewUpdatedAtMs: number;
  appliedAnswerCount: number;
  appliedIceCandidateCount: number;
  ignoredViewerSignalCount: number;
  nativePeerConnectionState: string;
  nativeIceConnectionState: string;
  nativeIceGatheringState: string;
  sampleWriteCount: number;
  sampleWriteErrorCount: number;
  lastSampleWriteError?: string;
  lastError?: string;
};

export type NativeScreenShareOutboundSignal = {
  memberId: string;
  signalType: RTCSignal["signal_type"];
  data: unknown;
};

export type VoiceNoiseSuppressionMode = "off" | "light" | "standard" | "strong";

export type NativeVoiceStartRequest = {
  serverId: string;
  channelId: string;
  memberId: string;
  muted: boolean;
  deafened: boolean;
  inputGainPercent: number;
  outputVolumePercent: number;
  inputDeviceId: string;
  outputDeviceId: string;
  noiseSuppressionMode: VoiceNoiseSuppressionMode;
  iceServers: RTCIceServer[];
};

export type NativeAudioDevice = {
  id: string;
  name: string;
  isDefault: boolean;
};

export type NativeAudioDevices = {
  inputs: NativeAudioDevice[];
  outputs: NativeAudioDevice[];
};

export type NativeMicrophoneTestStatus = {
  sessionId: string;
  active: boolean;
  inputLevel: number;
  lastError?: string;
};

export type NativeVoiceSession = {
  sessionId: string;
  channelId: string;
  memberId: string;
  backend: string;
};

export type NativeVoiceStatus = {
  sessionId: string;
  channelId: string;
  phase: string;
  backend: string;
  playbackBackend: string;
  microphoneAvailable: boolean;
  microphoneError?: string;
  muted: boolean;
  deafened: boolean;
  speaking: boolean;
  inputLevel: number;
  noiseSuppressionMode: VoiceNoiseSuppressionMode;
  peerCount: number;
  roundTripTimeMs?: number;
  capturedFrames: number;
  encodedPackets: number;
  receivedPackets: number;
  decodedFrames: number;
  playedFrames: number;
  droppedFrames: number;
  lastCaptureAtMs: number;
  lastReceiveAtMs: number;
  accompanimentActive: boolean;
  accompanimentProcessId?: number;
  accompanimentPackets: number;
  lastError?: string;
};

export type NativeVoiceOutboundSignal = {
  memberId: string;
  signalType: "offer" | "answer" | "ice-candidate";
  data: unknown;
};

export type RTCSignal = {
  channel_id: string;
  from_member_id: string;
  from_participant_id: string;
  target_member_id?: string;
  target_participant_id?: string;
  signal_type:
    | "offer"
    | "answer"
    | "ice-candidate"
    | "screen-share-watch"
    | "screen-share-unwatch"
    | "screen-share-offer"
    | "screen-share-answer"
    | "screen-share-ice-candidate"
    | "screen-share-path-hint"
    | "screen-share-restart-ice";
  data: unknown;
};

export type RTCIceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

export type RTCConfig = {
  ice_servers: RTCIceServer[];
};

export type ConnectResponse = {
  server_id: string;
  member_id: string;
  access_key?: string;
  session_token: string;
  is_owner: boolean;
  public_server_version?: string;
  server_compatibility_version?: string;
  server_version?: string;
  minimum_client_version?: string;
  client_update_required?: boolean;
};

export type SessionRefreshResponse = {
  server_id: string;
  member_id: string;
  session_token: string;
  is_owner: boolean;
  public_server_version?: string;
  server_compatibility_version?: string;
  server_version?: string;
  minimum_client_version?: string;
  client_update_required?: boolean;
};

export type StoredCredential = {
  baseUrl: string;
  server_id: string;
  member_id: string;
  access_key: string;
};

export type StoredServer = {
  server_id: string;
  name: string;
  icon_data_url?: string;
  base_url: string;
  member_id: string;
  last_connected_at_ms: number;
};

export type ServerEvent =
  | { type: "server.updated"; payload: ServerSummary }
  | { type: "channel.created"; payload: Channel }
  | { type: "channel.updated"; payload: Channel }
  | { type: "channel.deleted"; payload: Channel }
  | { type: "channels.reordered"; payload: { channels: Channel[] } }
  | { type: "member.joined"; payload: Member }
  | { type: "member.updated"; payload: Member }
  | { type: "member.presence.updated"; payload: Member }
  | { type: "member.identity_linked"; payload: { member: Member; previous_member_id: string } }
  | { type: "member.merge.requested"; payload: MemberMergeRequest }
  | { type: "member.merge.resolved"; payload: MemberMergeRequest }
  | { type: "member.left"; payload: Member }
  | { type: "message.created"; payload: Message }
  | { type: "message.updated"; payload: Message }
  | { type: "message.deleted"; payload: Message }
  | { type: "file.created"; payload: ChannelFileEntry }
  | { type: "file.updated"; payload: ChannelFileEntry }
  | { type: "file.deleted"; payload: ChannelFileEntry }
  | { type: "channel.permission_override.updated"; payload: ChannelPermissionOverride }
  | { type: "channel.permission_override.deleted"; payload: ChannelPermissionOverride }
  | { type: "role.created"; payload: ServerRole }
  | { type: "role.updated"; payload: ServerRole }
  | { type: "role.deleted"; payload: ServerRole }
  | { type: "roles.reordered"; payload: { roles: ServerRole[] } }
  | { type: "voice.states.snapshot"; payload: { voice_states: VoiceState[] } }
  | { type: "voice.state.updated"; payload: VoiceState }
  | { type: "voice.speaking.updated"; payload: VoiceState }
  | { type: "voice.state.deleted"; payload: VoiceState }
  | { type: "voice.device.displaced"; payload: VoiceState }
  | { type: "voice.device.kicked"; payload: VoiceState }
  | { type: "voice.device.kicked.silent"; payload: VoiceState }
  | { type: "screen_share.started"; payload: ScreenShareSession }
  | { type: "screen_share.updated"; payload: ScreenShareSession }
  | { type: "screen_share.ended"; payload: ScreenShareSession }
  | { type: "accompaniment.started"; payload: AccompanimentSession }
  | { type: "accompaniment.ended"; payload: AccompanimentSession }
  | { type: "soundboard.item.created"; payload: SoundboardItem }
  | { type: "soundboard.item.updated"; payload: SoundboardItem }
  | { type: "soundboard.item.deleted"; payload: SoundboardItem }
  | { type: "soundboard.played"; payload: SoundboardPlayback }
  | { type: "emoji.created"; payload: CustomEmoji }
  | { type: "emoji.updated"; payload: CustomEmoji }
  | { type: "emoji.deleted"; payload: CustomEmoji }
  | { type: "remote_control.requested"; payload: RemoteControlSession }
  | { type: "remote_control.approved"; payload: RemoteControlSession }
  | { type: "remote_control.rejected"; payload: RemoteControlSession }
  | { type: "remote_control.revoked"; payload: RemoteControlSession }
  | { type: "remote_control.suspended"; payload: RemoteControlSession }
  | { type: "remote_control.input"; payload: RemoteControlInput }
  | { type: "rtc.signal"; payload: RTCSignal }
  | { type: string; payload: unknown };
