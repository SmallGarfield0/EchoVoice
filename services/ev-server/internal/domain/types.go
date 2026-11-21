package domain

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
)

type Server struct {
	ServerID             string `json:"server_id"`
	Name                 string `json:"name"`
	IconSHA256           string `json:"icon_sha256,omitempty"`
	IconDataURL          string `json:"icon_data_url,omitempty"`
	Description          string `json:"description"`
	ScreenShareEnabled   bool   `json:"screen_share_enabled"`
	RemoteControlEnabled bool   `json:"remote_control_enabled"`
	AccompanimentEnabled bool   `json:"accompaniment_enabled"`
	SoundboardEnabled    bool   `json:"soundboard_enabled"`
	EmojiEnabled         bool   `json:"emoji_enabled"`
	EmojiMaxKB           int    `json:"emoji_max_kb"`
	FileStorageEnabled   bool   `json:"file_storage_enabled"`
	DMRelayEnabled       bool   `json:"dm_relay_enabled"`
	HomeMailboxEnabled   bool   `json:"home_mailbox_enabled"`
	Visibility           string `json:"visibility"`
	DefaultLanguage      string `json:"default_language"`
	CreatedAtMS          int64  `json:"created_at_ms"`
}

type Member struct {
	MemberID           string           `json:"member_id"`
	DisplayName        string           `json:"display_name"`
	AvatarSHA256       string           `json:"avatar_sha256,omitempty"`
	AvatarDataURL      string           `json:"avatar_data_url,omitempty"`
	AvatarColor        string           `json:"avatar_color,omitempty"`
	Bio                string           `json:"bio"`
	LocalProfileID     string           `json:"local_profile_id"`
	RoleIDs            []string         `json:"role_ids"`
	IsOwner            bool             `json:"is_owner"`
	IsBanned           bool             `json:"is_banned"`
	LastSeenAtMS       int64            `json:"last_seen_at_ms"`
	ProfileUpdatedAtMS int64            `json:"profile_updated_at_ms"`
	ProfileOverrides   ProfileOverrides `json:"profile_overrides"`
	Online             bool             `json:"online"`
	LinkedDevices      int              `json:"linked_devices"`
}

type ProfileOverrides struct {
	DisplayName bool `json:"display_name"`
	Avatar      bool `json:"avatar"`
	Bio         bool `json:"bio"`
}

type MemberMergeCode struct {
	TargetMemberID string `json:"target_member_id"`
	CodeHash       string `json:"-"`
	ExpiresAtMS    int64  `json:"expires_at_ms"`
	CreatedAtMS    int64  `json:"created_at_ms"`
}

type MemberMergeRequestStatus string

const (
	MemberMergePending   MemberMergeRequestStatus = "pending"
	MemberMergeAccepted  MemberMergeRequestStatus = "accepted"
	MemberMergeRejected  MemberMergeRequestStatus = "rejected"
	MemberMergeExpired   MemberMergeRequestStatus = "expired"
	MemberMergeCancelled MemberMergeRequestStatus = "cancelled"
)

type MemberMergeRequest struct {
	RequestID         string                   `json:"request_id"`
	TargetMemberID    string                   `json:"target_member_id"`
	RequesterMemberID string                   `json:"requester_member_id"`
	Status            MemberMergeRequestStatus `json:"status"`
	CreatedAtMS       int64                    `json:"created_at_ms"`
	ExpiresAtMS       int64                    `json:"expires_at_ms"`
	ResolvedAtMS      int64                    `json:"resolved_at_ms,omitempty"`
	Requester         Member                   `json:"requester"`
	Target            Member                   `json:"target"`
}

type Permission string

const (
	PermissionAdministrator            Permission = "administrator"
	PermissionViewMembers              Permission = "view_members"
	PermissionViewChannels             Permission = "view_channels"
	PermissionSendMessages             Permission = "send_messages"
	PermissionEditServer               Permission = "edit_server_settings"
	PermissionManageRoles              Permission = "manage_roles"
	PermissionManageChannels           Permission = "manage_channels"
	PermissionManageChannelPermissions Permission = "manage_channel_permissions"
	PermissionManageMembers            Permission = "manage_members"
	PermissionManageMessages           Permission = "manage_messages"
	PermissionReadMessageHistory       Permission = "read_message_history"
	PermissionConnectVoice             Permission = "connect_voice"
	PermissionSpeak                    Permission = "speak"
	PermissionMuteMembers              Permission = "mute_members"
	PermissionDeafenMembers            Permission = "deafen_members"
	PermissionMoveMembers              Permission = "move_members"
	PermissionShareScreen              Permission = "share_screen"
	PermissionRequestControl           Permission = "request_remote_control"
	PermissionAcceptControl            Permission = "accept_remote_control"
	PermissionPlayAccompaniment        Permission = "play_accompaniment"
	PermissionPlaySoundboard           Permission = "play_soundboard"
	PermissionManageServerSoundboard   Permission = "manage_server_soundboard"
	PermissionSendEmoji                Permission = "send_emoji"
	PermissionManageServerEmoji        Permission = "manage_server_emoji"
	PermissionCreateInvites            Permission = "create_invites"
	PermissionViewFiles                Permission = "view_files"
	PermissionUploadFiles              Permission = "upload_files"
	PermissionDownloadFiles            Permission = "download_files"
	PermissionManageFiles              Permission = "manage_files"
)

var AllPermissions = []Permission{
	PermissionAdministrator,
	PermissionViewMembers,
	PermissionViewChannels,
	PermissionSendMessages,
	PermissionEditServer,
	PermissionManageRoles,
	PermissionManageChannels,
	PermissionManageChannelPermissions,
	PermissionManageMembers,
	PermissionManageMessages,
	PermissionReadMessageHistory,
	PermissionConnectVoice,
	PermissionSpeak,
	PermissionMuteMembers,
	PermissionDeafenMembers,
	PermissionMoveMembers,
	PermissionShareScreen,
	PermissionRequestControl,
	PermissionAcceptControl,
	PermissionPlayAccompaniment,
	PermissionPlaySoundboard,
	PermissionManageServerSoundboard,
	PermissionSendEmoji,
	PermissionManageServerEmoji,
	PermissionCreateInvites,
	PermissionViewFiles,
	PermissionUploadFiles,
	PermissionDownloadFiles,
	PermissionManageFiles,
}

const EveryoneRoleID = "everyone"

type ServerRole struct {
	RoleID            string              `json:"role_id"`
	Name              string              `json:"name"`
	Color             string              `json:"color"`
	GradientColor     string              `json:"gradient_color,omitempty"`
	IconDataURL       string              `json:"icon_data_url,omitempty"`
	DisplaySeparately bool                `json:"display_separately"`
	Position          int                 `json:"position"`
	IsEveryone        bool                `json:"is_everyone"`
	MemberCount       int                 `json:"member_count"`
	Permissions       map[Permission]bool `json:"permissions"`
}

type RoleOrderItem struct {
	RoleID string `json:"role_id"`
}

type ChannelType string

const (
	ChannelTypeText           ChannelType = "text"
	ChannelTypeVoice          ChannelType = "voice"
	ChannelTypeCategory       ChannelType = "category"
	ChannelTypeTemporaryVoice ChannelType = "temporary_voice"
)

type Channel struct {
	ChannelID            string                         `json:"channel_id"`
	ParentID             string                         `json:"parent_id,omitempty"`
	Type                 ChannelType                    `json:"type"`
	Name                 string                         `json:"name"`
	Topic                string                         `json:"topic,omitempty"`
	Visibility           string                         `json:"visibility"`
	WarningText          string                         `json:"warning_text,omitempty"`
	Bitrate              int                            `json:"bitrate"`
	UserLimit            int                            `json:"user_limit"`
	PermissionSynced     bool                           `json:"permission_synced"`
	Position             int                            `json:"position"`
	DefaultLanguage      string                         `json:"default_language,omitempty"`
	Localizations        map[string]ChannelLocalization `json:"localizations,omitempty"`
	EffectivePermissions map[Permission]bool            `json:"effective_permissions,omitempty"`
}

type ChannelLocalization struct {
	Name        string `json:"name,omitempty"`
	Topic       string `json:"topic,omitempty"`
	WarningText string `json:"warning_text,omitempty"`
}

type ServerInvite struct {
	InviteID        string `json:"invite_id"`
	Token           string `json:"token,omitempty"`
	TokenHash       string `json:"-"`
	CreatorMemberID string `json:"creator_member_id"`
	ExpiresAtMS     int64  `json:"expires_at_ms"`
	MaxUses         int    `json:"max_uses"`
	UseCount        int    `json:"use_count"`
	CreatedAtMS     int64  `json:"created_at_ms"`
}

type ChannelOrderItem struct {
	ChannelID string `json:"channel_id"`
	ParentID  string `json:"parent_id,omitempty"`
}

type ChannelPermissionOverrideTarget string

const (
	OverrideTargetRole   ChannelPermissionOverrideTarget = "role"
	OverrideTargetMember ChannelPermissionOverrideTarget = "member"
)

type ChannelPermissionOverride struct {
	OverrideID string                          `json:"override_id"`
	ChannelID  string                          `json:"channel_id"`
	TargetType ChannelPermissionOverrideTarget `json:"target_type"`
	TargetID   string                          `json:"target_id"`
	Allows     map[Permission]bool             `json:"allows"`
	Denies     map[Permission]bool             `json:"denies"`
}

type Message struct {
	MessageID        string `json:"message_id"`
	ChannelID        string `json:"channel_id"`
	AuthorID         string `json:"author_id"`
	Content          string `json:"content"`
	ReplyToMessageID string `json:"reply_to_message_id,omitempty"`
	CreatedAtMS      int64  `json:"created_at_ms"`
	EditedAtMS       int64  `json:"edited_at_ms,omitempty"`
	DeletedAtMS      int64  `json:"deleted_at_ms,omitempty"`
}

type ContentAsset struct {
	SHA256       string `json:"sha256"`
	SizeBytes    int64  `json:"size_bytes"`
	MimeType     string `json:"mime_type"`
	OriginalName string `json:"original_name"`
	StoragePath  string `json:"storage_path,omitempty"`
	CreatedAtMS  int64  `json:"created_at_ms"`
}

type SoundboardItem struct {
	ItemID           string  `json:"item_id"`
	Name             string  `json:"name"`
	AssetSHA256      string  `json:"asset_sha256"`
	IconEmoji        string  `json:"icon_emoji,omitempty"`
	IconAssetSHA256  string  `json:"icon_asset_sha256,omitempty"`
	StartMS          int64   `json:"start_ms"`
	EndMS            int64   `json:"end_ms"`
	BaseVolume       float64 `json:"base_volume"`
	UploaderMemberID string  `json:"uploader_member_id"`
	SizeBytes        int64   `json:"size_bytes"`
	MimeType         string  `json:"mime_type"`
	CreatedAtMS      int64   `json:"created_at_ms"`
	UpdatedAtMS      int64   `json:"updated_at_ms"`
}

type SoundboardPlayback struct {
	PlaybackID   string  `json:"playback_id"`
	ChannelID    string  `json:"channel_id"`
	MemberID     string  `json:"member_id"`
	ItemID       string  `json:"item_id,omitempty"`
	Name         string  `json:"name"`
	AssetSHA256  string  `json:"asset_sha256"`
	StartMS      int64   `json:"start_ms"`
	EndMS        int64   `json:"end_ms"`
	SizeBytes    int64   `json:"size_bytes"`
	MimeType     string  `json:"mime_type"`
	BaseVolume   float64 `json:"base_volume"`
	SenderVolume float64 `json:"sender_volume"`
	Volume       float64 `json:"volume"`
	PlayAtMS     int64   `json:"play_at_ms"`
}

type CustomEmoji struct {
	EmojiID          string `json:"emoji_id"`
	Shortcode        string `json:"shortcode"`
	AssetSHA256      string `json:"asset_sha256"`
	PreviewSHA256    string `json:"preview_sha256,omitempty"`
	UploaderMemberID string `json:"uploader_member_id"`
	SizeBytes        int64  `json:"size_bytes"`
	MimeType         string `json:"mime_type"`
	IsGIF            bool   `json:"is_gif"`
	CreatedAtMS      int64  `json:"created_at_ms"`
	UpdatedAtMS      int64  `json:"updated_at_ms"`
}

type ChannelFileEntryType string

const (
	ChannelFileEntryDirectory ChannelFileEntryType = "directory"
	ChannelFileEntryFile      ChannelFileEntryType = "file"
)

type ChannelFileEntry struct {
	EntryID       string               `json:"entry_id"`
	ChannelID     string               `json:"channel_id"`
	ParentID      string               `json:"parent_id,omitempty"`
	Type          ChannelFileEntryType `json:"type"`
	Name          string               `json:"name"`
	AssetSHA256   string               `json:"asset_sha256,omitempty"`
	OwnerMemberID string               `json:"owner_member_id"`
	SizeBytes     int64                `json:"size_bytes"`
	MimeType      string               `json:"mime_type,omitempty"`
	CreatedAtMS   int64                `json:"created_at_ms"`
	UpdatedAtMS   int64                `json:"updated_at_ms"`
}

type AuditLog struct {
	AuditID       string            `json:"audit_id"`
	ActorMemberID string            `json:"actor_member_id"`
	Action        string            `json:"action"`
	TargetType    string            `json:"target_type"`
	TargetID      string            `json:"target_id"`
	Details       map[string]string `json:"details"`
	CreatedAtMS   int64             `json:"created_at_ms"`
}

type VoiceState struct {
	ParticipantID  string `json:"participant_id"`
	ChannelID      string `json:"channel_id"`
	MemberID       string `json:"member_id"`
	DeviceID       string `json:"device_id"`
	Mode           string `json:"mode"`
	JoinedAtMS     int64  `json:"joined_at_ms"`
	MicMuted       bool   `json:"mic_muted"`
	AudioDeafened  bool   `json:"audio_deafened"`
	ServerMuted    bool   `json:"server_muted"`
	ServerDeafened bool   `json:"server_deafened"`
	IsSpeaking     bool   `json:"is_speaking"`
}

type VoiceDurationStats struct {
	MemberID              string `json:"member_id"`
	ComparedMemberID      string `json:"compared_member_id,omitempty"`
	TotalVoiceDurationMS  int64  `json:"total_voice_duration_ms"`
	SharedVoiceDurationMS int64  `json:"shared_voice_duration_ms"`
	MemberActive          bool   `json:"member_active"`
	SharedActive          bool   `json:"shared_active"`
	MeasuredAtMS          int64  `json:"measured_at_ms"`
}

func VoiceParticipantID(memberID string, deviceID string) string {
	digest := sha256.Sum256([]byte(memberID + "\x00" + deviceID))
	return "vp_" + base64.RawURLEncoding.EncodeToString(digest[:18])
}

type ScreenShareSession struct {
	ShareID              string   `json:"share_id"`
	ChannelID            string   `json:"channel_id"`
	OwnerMemberID        string   `json:"owner_member_id"`
	OwnerParticipantID   string   `json:"owner_participant_id"`
	RemoteControlAllowed bool     `json:"remote_control_allowed"`
	ViewerMemberIDs      []string `json:"viewer_member_ids"`
	StartedAtMS          int64    `json:"started_at_ms"`
}

type AccompanimentSession struct {
	SessionID     string `json:"session_id"`
	ChannelID     string `json:"channel_id"`
	OwnerMemberID string `json:"owner_member_id"`
	SourceName    string `json:"source_name"`
	StartedAtMS   int64  `json:"started_at_ms"`
}

type RemoteControlStatus string

const (
	RemoteControlPending  RemoteControlStatus = "pending"
	RemoteControlActive   RemoteControlStatus = "active"
	RemoteControlRejected RemoteControlStatus = "rejected"
	RemoteControlRevoked  RemoteControlStatus = "revoked"
)

type RemoteControlSession struct {
	ControlID               string              `json:"control_id"`
	ShareID                 string              `json:"share_id"`
	ChannelID               string              `json:"channel_id"`
	OwnerMemberID           string              `json:"owner_member_id"`
	OwnerParticipantID      string              `json:"owner_participant_id"`
	ControllerMemberID      string              `json:"controller_member_id"`
	ControllerParticipantID string              `json:"controller_participant_id"`
	Status                  RemoteControlStatus `json:"status"`
	RequestedAtMS           int64               `json:"requested_at_ms"`
	UpdatedAtMS             int64               `json:"updated_at_ms"`
	ExpiresAtMS             int64               `json:"expires_at_ms,omitempty"`
	LeaseUntilMS            int64               `json:"lease_until_ms,omitempty"`
	GrantGeneration         uint64              `json:"grant_generation,omitempty"`
	TransportState          string              `json:"transport_state,omitempty"`
	RespectUntilMS          int64               `json:"respect_until_ms,omitempty"`
	EndReason               string              `json:"end_reason,omitempty"`
}

type RemoteControlInputEvent struct {
	Type      string   `json:"type"`
	X         float64  `json:"x"`
	Y         float64  `json:"y"`
	Button    int      `json:"button"`
	Buttons   int      `json:"buttons"`
	Pressed   bool     `json:"pressed"`
	DeltaX    float64  `json:"delta_x"`
	DeltaY    float64  `json:"delta_y"`
	Code      string   `json:"code"`
	Key       string   `json:"key"`
	Repeat    bool     `json:"repeat"`
	Modifiers []string `json:"modifiers"`
}

type RemoteControlInput struct {
	ControlID               string                  `json:"control_id"`
	Sequence                uint64                  `json:"sequence"`
	ControllerMemberID      string                  `json:"controller_member_id,omitempty"`
	ControllerParticipantID string                  `json:"controller_participant_id,omitempty"`
	Event                   RemoteControlInputEvent `json:"event"`
}

type RTCSignal struct {
	ChannelID           string          `json:"channel_id"`
	FromMemberID        string          `json:"from_member_id"`
	FromParticipantID   string          `json:"from_participant_id"`
	TargetMemberID      string          `json:"target_member_id,omitempty"`
	TargetParticipantID string          `json:"target_participant_id,omitempty"`
	SignalType          string          `json:"signal_type"`
	Data                json.RawMessage `json:"data"`
}

type ConnectRequest struct {
	ServerPassword string       `json:"server_password"`
	InviteToken    string       `json:"invite_token"`
	Profile        ProfileInput `json:"profile"`
}

type ProfileInput struct {
	DisplayName        string `json:"display_name"`
	AvatarSHA256       string `json:"avatar_sha256"`
	AvatarDataURL      string `json:"avatar_data_url"`
	AvatarColor        string `json:"avatar_color"`
	Bio                string `json:"bio"`
	LocalProfileID     string `json:"local_profile_id"`
	ProfileUpdatedAtMS int64  `json:"profile_updated_at_ms"`
	ClientVersion      string `json:"client_version"`
}

type MemberIdentityLink struct {
	PrimaryMemberID   string `json:"primary_member_id"`
	DuplicateMemberID string `json:"duplicate_member_id"`
}

type ConnectResponse struct {
	ServerID                   string `json:"server_id"`
	MemberID                   string `json:"member_id"`
	AccessKey                  string `json:"access_key,omitempty"`
	SessionToken               string `json:"session_token"`
	IsOwner                    bool   `json:"is_owner"`
	PublicServerVersion        string `json:"public_server_version"`
	ServerCompatibilityVersion string `json:"server_compatibility_version"`
	MinimumClientVersion       string `json:"minimum_client_version"`
	ClientUpdateRequired       bool   `json:"client_update_required"`
}

type SessionRefreshRequest struct {
	ServerID      string `json:"server_id"`
	MemberID      string `json:"member_id"`
	AccessKey     string `json:"access_key"`
	DeviceID      string `json:"device_id"`
	ClientVersion string `json:"client_version"`
}

type RTCIceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type RTCConfig struct {
	IceServers []RTCIceServer `json:"ice_servers"`
}

type SessionRefreshResponse struct {
	ServerID                   string `json:"server_id"`
	MemberID                   string `json:"member_id"`
	SessionToken               string `json:"session_token"`
	IsOwner                    bool   `json:"is_owner"`
	PublicServerVersion        string `json:"public_server_version"`
	ServerCompatibilityVersion string `json:"server_compatibility_version"`
	MinimumClientVersion       string `json:"minimum_client_version"`
	ClientUpdateRequired       bool   `json:"client_update_required"`
}

type APIError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
