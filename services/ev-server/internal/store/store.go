package store

import "github.com/echovoice/echovoice/services/ev-server/internal/domain"

type Store interface {
	Close() error
	Server() domain.Server
	UpdateServer(input domain.Server) domain.Server
	UpsertMember(profile domain.ProfileInput) (domain.Member, string, bool, error)
	Authenticate(serverID string, memberID string, accessKey string) (domain.Member, bool)
	Members() []domain.Member
	UpdateMember(memberID string, input domain.Member) (domain.Member, error)
	TouchMember(memberID string, lastSeenAtMS int64) (domain.Member, error)
	RemoveMember(memberID string) (domain.Member, error)
	LinkMembers(primaryMemberID string, duplicateMemberID string) (domain.Member, domain.Member, error)
	SaveMemberMergeCode(input domain.MemberMergeCode) error
	CreateMemberMergeRequestFromCode(input domain.MemberMergeRequest, codeHash string, nowMS int64) (domain.MemberMergeRequest, error)
	MemberMergeRequests(memberID string, nowMS int64) []domain.MemberMergeRequest
	MemberMergeRequest(requestID string, nowMS int64) (domain.MemberMergeRequest, error)
	ResolveMemberMergeRequest(requestID string, targetMemberID string, status domain.MemberMergeRequestStatus, resolvedAtMS int64) (domain.MemberMergeRequest, error)
	ClaimOwner(memberID string) (domain.Member, error)
	Roles() []domain.ServerRole
	CreateRole(input domain.ServerRole) (domain.ServerRole, error)
	UpdateRole(roleID string, input domain.ServerRole) (domain.ServerRole, error)
	DeleteRole(roleID string) (domain.ServerRole, error)
	ReorderRoles(items []domain.RoleOrderItem) ([]domain.ServerRole, error)
	SetMemberRoles(memberID string, roleIDs []string) (domain.Member, error)
	MemberHasPermission(memberID string, permission domain.Permission) bool
	MemberHasChannelPermission(memberID string, channelID string, permission domain.Permission) bool
	Channels() []domain.Channel
	CreateChannel(input domain.Channel) (domain.Channel, error)
	UpdateChannel(channelID string, input domain.Channel) (domain.Channel, error)
	ReorderChannels(items []domain.ChannelOrderItem) ([]domain.Channel, error)
	DeleteChannel(channelID string) (domain.Channel, error)
	ChannelPermissionOverrides(channelID string) []domain.ChannelPermissionOverride
	SetChannelPermissionOverride(input domain.ChannelPermissionOverride) (domain.ChannelPermissionOverride, error)
	DeleteChannelPermissionOverride(channelID string, overrideID string) (domain.ChannelPermissionOverride, error)
	Messages(channelID string, beforeMS int64, limit int) []domain.Message
	Message(channelID string, messageID string) (domain.Message, error)
	MessagesAround(channelID string, messageID string, beforeLimit int, afterLimit int) ([]domain.Message, error)
	SearchMessages(channelID string, query string, limit int) []domain.Message
	CreateMessage(channelID string, authorID string, content string, replyToMessageID string) (domain.Message, error)
	UpdateMessage(channelID string, messageID string, authorID string, content string) (domain.Message, error)
	DeleteMessage(channelID string, messageID string, actorID string, canManage bool) (domain.Message, error)
	ContentAsset(sha256 string) (domain.ContentAsset, error)
	UpsertContentAsset(input domain.ContentAsset) (domain.ContentAsset, error)
	LinkChannelMessageImage(channelID string, assetSHA256 string) error
	ChannelHasMessageImage(channelID string, assetSHA256 string) bool
	SoundboardItems() []domain.SoundboardItem
	SoundboardItem(itemID string) (domain.SoundboardItem, error)
	CreateSoundboardItem(input domain.SoundboardItem) (domain.SoundboardItem, error)
	UpdateSoundboardItem(itemID string, input domain.SoundboardItem) (domain.SoundboardItem, error)
	DeleteSoundboardItem(itemID string) (domain.SoundboardItem, error)
	CustomEmojis() []domain.CustomEmoji
	CustomEmoji(emojiID string) (domain.CustomEmoji, error)
	CreateCustomEmoji(input domain.CustomEmoji) (domain.CustomEmoji, error)
	UpdateCustomEmoji(emojiID string, shortcode string) (domain.CustomEmoji, error)
	DeleteCustomEmoji(emojiID string) (domain.CustomEmoji, error)
	FileEntries(channelID string, parentID string) []domain.ChannelFileEntry
	FileEntry(channelID string, entryID string) (domain.ChannelFileEntry, error)
	CreateFileEntry(input domain.ChannelFileEntry) (domain.ChannelFileEntry, error)
	UpdateFileEntry(channelID string, entryID string, input domain.ChannelFileEntry) (domain.ChannelFileEntry, error)
	DeleteFileEntry(channelID string, entryID string) (domain.ChannelFileEntry, error)
	CreateAuditLog(input domain.AuditLog) (domain.AuditLog, error)
	AuditLogs(action string, limit int) []domain.AuditLog
	Invites() []domain.ServerInvite
	CreateInvite(input domain.ServerInvite) (domain.ServerInvite, error)
	ConsumeInvite(token string, nowMS int64) (domain.ServerInvite, error)
	DeleteInvite(inviteID string) (domain.ServerInvite, error)
	VoiceStates() []domain.VoiceState
	VoiceDurationStats(memberID string, comparedMemberID string) (domain.VoiceDurationStats, error)
	JoinVoiceChannel(channelID string, memberID string, deviceID string, mode string) (domain.VoiceState, error)
	UpdateVoiceState(participantID string, input domain.VoiceState) (domain.VoiceState, error)
	ManageVoiceState(participantID string, input domain.VoiceState) (domain.VoiceState, error)
	LeaveVoiceChannel(participantID string) (domain.VoiceState, bool, error)
	LeaveMemberVoiceChannels(memberID string) ([]domain.VoiceState, error)
	ScreenShareSessions() []domain.ScreenShareSession
	StartScreenShareSession(input domain.ScreenShareSession) (domain.ScreenShareSession, error)
	SetScreenShareViewer(shareID string, memberID string, watching bool) (domain.ScreenShareSession, error)
	RemoveScreenShareViewerFromAll(memberID string) []domain.ScreenShareSession
	EndScreenShareSession(shareID string, actorMemberID string, canManage bool) (domain.ScreenShareSession, error)
	AccompanimentSessions() []domain.AccompanimentSession
	StartAccompanimentSession(input domain.AccompanimentSession) (domain.AccompanimentSession, error)
	EndAccompanimentSession(sessionID string, actorMemberID string, canManage bool) (domain.AccompanimentSession, error)
}

func defaultEveryonePermissions() map[domain.Permission]bool {
	return map[domain.Permission]bool{
		domain.PermissionViewMembers:        true,
		domain.PermissionViewChannels:       true,
		domain.PermissionSendMessages:       true,
		domain.PermissionReadMessageHistory: true,
		domain.PermissionConnectVoice:       true,
		domain.PermissionSpeak:              true,
		domain.PermissionShareScreen:        true,
		domain.PermissionPlayAccompaniment:  true,
		domain.PermissionPlaySoundboard:     true,
		domain.PermissionSendEmoji:          true,
		domain.PermissionViewFiles:          true,
		domain.PermissionUploadFiles:        true,
		domain.PermissionDownloadFiles:      true,
	}
}

func applyGlobalProfile(member *domain.Member, profile domain.ProfileInput) {
	if !member.ProfileOverrides.DisplayName {
		member.DisplayName = nonEmpty(profile.DisplayName, member.DisplayName)
	}
	if !member.ProfileOverrides.Avatar {
		member.AvatarSHA256 = profile.AvatarSHA256
		member.AvatarDataURL = profile.AvatarDataURL
		member.AvatarColor = nonEmpty(profile.AvatarColor, member.AvatarColor)
	}
	if !member.ProfileOverrides.Bio {
		member.Bio = profile.Bio
	}
	member.ProfileUpdatedAtMS = profile.ProfileUpdatedAtMS
}
