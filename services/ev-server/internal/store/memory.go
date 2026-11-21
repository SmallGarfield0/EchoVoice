package store

import (
	"errors"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/echovoice/echovoice/services/ev-server/internal/auth"
	"github.com/echovoice/echovoice/services/ev-server/internal/domain"
)

var ErrNotFound = errors.New("not found")
var ErrInvalidVoiceChannel = errors.New("invalid voice channel")
var ErrForbidden = errors.New("forbidden")
var ErrInvalidChannelOrder = errors.New("invalid channel order")
var ErrInvalidRoleOrder = errors.New("invalid role order")
var ErrSameMember = errors.New("members must be different")
var ErrAccompanimentActive = errors.New("member is already playing music")
var ErrAlreadyExists = errors.New("already exists")
var ErrInviteInvalid = errors.New("invite is invalid or expired")
var ErrMemberMergeCodeInvalid = errors.New("member merge code is invalid or expired")
var ErrMemberMergeRequestInvalid = errors.New("member merge request is invalid or expired")

type MemoryStore struct {
	mu                         sync.RWMutex
	server                     domain.Server
	members                    map[string]domain.Member
	accessKeyHashes            map[string]string
	memberByDeviceID           map[string]string
	deviceAccessKeyHashes      map[string]string
	roles                      map[string]domain.ServerRole
	channels                   map[string]domain.Channel
	channelPermissionOverrides map[string]map[string]domain.ChannelPermissionOverride
	messages                   map[string][]domain.Message
	contentAssets              map[string]domain.ContentAsset
	channelMessageImages       map[string]map[string]struct{}
	soundboardItems            map[string]domain.SoundboardItem
	customEmojis               map[string]domain.CustomEmoji
	fileEntries                map[string]domain.ChannelFileEntry
	auditLogs                  []domain.AuditLog
	invites                    map[string]domain.ServerInvite
	memberMergeCodes           map[string]domain.MemberMergeCode
	memberMergeCodeTargets     map[string]string
	memberMergeRequests        map[string]domain.MemberMergeRequest
	voiceStates                map[string]domain.VoiceState
	voiceDurationByMember      map[string]int64
	voiceDurationByPair        map[voiceMemberPair]int64
	voiceStatsCheckpointMS     int64
	screenShareSessions        map[string]domain.ScreenShareSession
	accompanimentSessions      map[string]domain.AccompanimentSession
}

func NewMemoryStore(serverName string) *MemoryStore {
	serverID, _ := auth.NewToken("srv")
	textID, _ := auth.NewToken("ch")
	voiceID, _ := auth.NewToken("ch")

	now := time.Now().UnixMilli()
	return &MemoryStore{
		server: domain.Server{
			ServerID:        serverID,
			Name:            serverName,
			EmojiMaxKB:      1024,
			Visibility:      "public",
			DefaultLanguage: "zh-CN",
			CreatedAtMS:     now,
		},
		members:               make(map[string]domain.Member),
		accessKeyHashes:       make(map[string]string),
		memberByDeviceID:      make(map[string]string),
		deviceAccessKeyHashes: make(map[string]string),
		roles:                 defaultServerRoles(),
		channels: map[string]domain.Channel{
			textID: {
				ChannelID:  textID,
				Type:       domain.ChannelTypeText,
				Name:       "general",
				Visibility: "default",
				Position:   1000,
			},
			voiceID: {
				ChannelID:  voiceID,
				Type:       domain.ChannelTypeVoice,
				Name:       "Voice",
				Visibility: "default",
				Bitrate:    64000,
				Position:   2000,
			},
		},
		channelPermissionOverrides: make(map[string]map[string]domain.ChannelPermissionOverride),
		messages:                   make(map[string][]domain.Message),
		contentAssets:              make(map[string]domain.ContentAsset),
		channelMessageImages:       make(map[string]map[string]struct{}),
		soundboardItems:            make(map[string]domain.SoundboardItem),
		customEmojis:               make(map[string]domain.CustomEmoji),
		fileEntries:                make(map[string]domain.ChannelFileEntry),
		auditLogs:                  make([]domain.AuditLog, 0),
		invites:                    make(map[string]domain.ServerInvite),
		memberMergeCodes:           make(map[string]domain.MemberMergeCode),
		memberMergeCodeTargets:     make(map[string]string),
		memberMergeRequests:        make(map[string]domain.MemberMergeRequest),
		voiceStates:                make(map[string]domain.VoiceState),
		voiceDurationByMember:      make(map[string]int64),
		voiceDurationByPair:        make(map[voiceMemberPair]int64),
		voiceStatsCheckpointMS:     now,
		screenShareSessions:        make(map[string]domain.ScreenShareSession),
		accompanimentSessions:      make(map[string]domain.AccompanimentSession),
	}
}

func (s *MemoryStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.settleVoiceDurationsLocked(time.Now().UnixMilli(), true)
	return nil
}

func (s *MemoryStore) Server() domain.Server {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.server
}

func (s *MemoryStore) UpdateServer(input domain.Server) domain.Server {
	s.mu.Lock()
	defer s.mu.Unlock()
	input.ServerID = s.server.ServerID
	input.CreatedAtMS = s.server.CreatedAtMS
	input.Visibility = normalizeServerVisibility(input.Visibility)
	input.DefaultLanguage = nonEmpty(strings.TrimSpace(input.DefaultLanguage), s.server.DefaultLanguage)
	if input.EmojiMaxKB <= 0 {
		input.EmojiMaxKB = s.server.EmojiMaxKB
	}
	s.server = input
	return s.server
}

func (s *MemoryStore) UpsertMember(profile domain.ProfileInput) (domain.Member, string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	accessKey, err := auth.NewToken("key")
	if err != nil {
		return domain.Member{}, "", false, err
	}
	now := time.Now().UnixMilli()
	if profile.ProfileUpdatedAtMS <= 0 {
		profile.ProfileUpdatedAtMS = now
	}
	if profile.LocalProfileID != "" {
		memberID := s.memberByDeviceID[profile.LocalProfileID]
		if memberID == "" {
			for candidateID, existing := range s.members {
				if existing.LocalProfileID == profile.LocalProfileID {
					memberID = candidateID
					break
				}
			}
		}
		if existing, found := s.members[memberID]; found {
			if existing.IsBanned {
				return domain.Member{}, "", false, ErrForbidden
			}
			if profile.ProfileUpdatedAtMS > existing.ProfileUpdatedAtMS {
				applyGlobalProfile(&existing, profile)
			}
			existing.LastSeenAtMS = now
			s.members[memberID] = existing
			s.memberByDeviceID[profile.LocalProfileID] = memberID
			s.deviceAccessKeyHashes[deviceCredentialKey(memberID, profile.LocalProfileID)] = auth.HashSecret(accessKey)
			return cloneMember(existing), accessKey, existing.IsOwner, nil
		}
	}

	memberID, err := auth.NewToken("mem")
	if err != nil {
		return domain.Member{}, "", false, err
	}
	member := domain.Member{
		MemberID:           memberID,
		DisplayName:        profile.DisplayName,
		AvatarSHA256:       profile.AvatarSHA256,
		AvatarDataURL:      profile.AvatarDataURL,
		AvatarColor:        profile.AvatarColor,
		Bio:                profile.Bio,
		LocalProfileID:     profile.LocalProfileID,
		IsOwner:            len(s.members) == 0,
		LastSeenAtMS:       now,
		ProfileUpdatedAtMS: profile.ProfileUpdatedAtMS,
	}
	s.members[memberID] = member
	s.accessKeyHashes[memberID] = auth.HashSecret(accessKey)
	if profile.LocalProfileID != "" {
		s.memberByDeviceID[profile.LocalProfileID] = memberID
		s.deviceAccessKeyHashes[deviceCredentialKey(memberID, profile.LocalProfileID)] = auth.HashSecret(accessKey)
	}
	return cloneMember(member), accessKey, member.IsOwner, nil
}

func (s *MemoryStore) Authenticate(serverID string, memberID string, accessKey string) (domain.Member, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if serverID != s.server.ServerID {
		return domain.Member{}, false
	}
	hash := auth.HashSecret(accessKey)
	if member, ok := s.members[memberID]; ok && !member.IsBanned {
		if s.accessKeyHashes[memberID] == hash {
			member.LinkedDevices = s.linkedDeviceCountLocked(memberID)
			return cloneMember(member), true
		}
		for key, candidate := range s.deviceAccessKeyHashes {
			if strings.HasPrefix(key, memberID+"\x00") && candidate == hash {
				member.LinkedDevices = s.linkedDeviceCountLocked(memberID)
				return cloneMember(member), true
			}
		}
	}
	for key, candidate := range s.deviceAccessKeyHashes {
		if candidate != hash {
			continue
		}
		canonicalMemberID, _, ok := strings.Cut(key, "\x00")
		member, found := s.members[canonicalMemberID]
		if ok && found && !member.IsBanned {
			member.LinkedDevices = s.linkedDeviceCountLocked(canonicalMemberID)
			return cloneMember(member), true
		}
	}
	return domain.Member{}, false
}

func (s *MemoryStore) Members() []domain.Member {
	s.mu.RLock()
	defer s.mu.RUnlock()

	members := make([]domain.Member, 0, len(s.members))
	for _, member := range s.members {
		member.LinkedDevices = s.linkedDeviceCountLocked(member.MemberID)
		members = append(members, cloneMember(member))
	}
	sort.Slice(members, func(i, j int) bool {
		return members[i].DisplayName < members[j].DisplayName
	})
	return members
}

func (s *MemoryStore) UpdateMember(memberID string, input domain.Member) (domain.Member, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	member, ok := s.members[memberID]
	if !ok {
		return domain.Member{}, ErrNotFound
	}
	if input.DisplayName != "" {
		member.DisplayName = input.DisplayName
	}
	member.AvatarSHA256 = input.AvatarSHA256
	member.AvatarDataURL = input.AvatarDataURL
	member.AvatarColor = input.AvatarColor
	member.Bio = input.Bio
	member.ProfileOverrides = input.ProfileOverrides
	if input.ProfileUpdatedAtMS > 0 {
		member.ProfileUpdatedAtMS = input.ProfileUpdatedAtMS
	}
	member.IsBanned = input.IsBanned
	if member.IsBanned {
		delete(s.accessKeyHashes, memberID)
	}
	s.members[memberID] = member
	return cloneMember(member), nil
}

func (s *MemoryStore) TouchMember(memberID string, lastSeenAtMS int64) (domain.Member, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	member, ok := s.members[memberID]
	if !ok {
		return domain.Member{}, ErrNotFound
	}
	member.LastSeenAtMS = lastSeenAtMS
	s.members[memberID] = member
	member.LinkedDevices = s.linkedDeviceCountLocked(memberID)
	return cloneMember(member), nil
}

func (s *MemoryStore) RemoveMember(memberID string) (domain.Member, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	member, ok := s.members[memberID]
	if !ok {
		return domain.Member{}, ErrNotFound
	}
	s.settleVoiceDurationsLocked(time.Now().UnixMilli(), true)
	delete(s.members, memberID)
	delete(s.accessKeyHashes, memberID)
	for deviceID, linkedMemberID := range s.memberByDeviceID {
		if linkedMemberID == memberID {
			delete(s.memberByDeviceID, deviceID)
			delete(s.deviceAccessKeyHashes, deviceCredentialKey(memberID, deviceID))
		}
	}
	for participantID, state := range s.voiceStates {
		if state.MemberID == memberID {
			delete(s.voiceStates, participantID)
		}
	}
	delete(s.voiceDurationByMember, memberID)
	for pair := range s.voiceDurationByPair {
		if pair.First == memberID || pair.Second == memberID {
			delete(s.voiceDurationByPair, pair)
		}
	}
	return cloneMember(member), nil
}

func (s *MemoryStore) LinkMembers(primaryMemberID string, duplicateMemberID string) (domain.Member, domain.Member, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if primaryMemberID == duplicateMemberID {
		return domain.Member{}, domain.Member{}, ErrSameMember
	}
	primary, primaryOK := s.members[primaryMemberID]
	duplicate, duplicateOK := s.members[duplicateMemberID]
	if !primaryOK || !duplicateOK {
		return domain.Member{}, domain.Member{}, ErrNotFound
	}
	s.settleVoiceDurationsLocked(time.Now().UnixMilli(), true)
	roleSet := make(map[string]bool, len(primary.RoleIDs)+len(duplicate.RoleIDs))
	for _, roleID := range append(append([]string{}, primary.RoleIDs...), duplicate.RoleIDs...) {
		if role, ok := s.roles[roleID]; ok && !role.IsEveryone && !roleSet[roleID] {
			roleSet[roleID] = true
		}
	}
	mergedRoles := make([]string, 0, len(roleSet))
	for roleID := range roleSet {
		mergedRoles = append(mergedRoles, roleID)
	}
	sort.Strings(mergedRoles)
	primary.RoleIDs = mergedRoles
	primary.IsOwner = primary.IsOwner || duplicate.IsOwner
	primary.LastSeenAtMS = maxInt64(primary.LastSeenAtMS, duplicate.LastSeenAtMS)
	for deviceID, linkedMemberID := range s.memberByDeviceID {
		if linkedMemberID == duplicateMemberID {
			s.memberByDeviceID[deviceID] = primaryMemberID
			oldKey := deviceCredentialKey(duplicateMemberID, deviceID)
			if hash, ok := s.deviceAccessKeyHashes[oldKey]; ok {
				delete(s.deviceAccessKeyHashes, oldKey)
				s.deviceAccessKeyHashes[deviceCredentialKey(primaryMemberID, deviceID)] = hash
			}
		}
	}
	if duplicate.LocalProfileID != "" && s.memberByDeviceID[duplicate.LocalProfileID] == "" {
		s.memberByDeviceID[duplicate.LocalProfileID] = primaryMemberID
	}
	for channelID, channelMessages := range s.messages {
		for index := range channelMessages {
			if channelMessages[index].AuthorID == duplicateMemberID {
				channelMessages[index].AuthorID = primaryMemberID
			}
		}
		s.messages[channelID] = channelMessages
	}
	for entryID, entry := range s.fileEntries {
		if entry.OwnerMemberID == duplicateMemberID {
			entry.OwnerMemberID = primaryMemberID
			s.fileEntries[entryID] = entry
		}
	}
	for participantID, state := range s.voiceStates {
		if state.MemberID != duplicateMemberID {
			continue
		}
		delete(s.voiceStates, participantID)
		state.MemberID = primaryMemberID
		state.ParticipantID = domain.VoiceParticipantID(primaryMemberID, state.DeviceID)
		s.voiceStates[state.ParticipantID] = state
	}
	s.mergeVoiceDurationsLocked(primaryMemberID, duplicateMemberID)
	delete(s.members, duplicateMemberID)
	delete(s.accessKeyHashes, duplicateMemberID)
	s.members[primaryMemberID] = primary
	primary.LinkedDevices = s.linkedDeviceCountLocked(primaryMemberID)
	return cloneMember(primary), cloneMember(duplicate), nil
}

func (s *MemoryStore) SaveMemberMergeCode(input domain.MemberMergeCode) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupMemberMergeLocked(time.Now().UnixMilli())
	member, found := s.members[input.TargetMemberID]
	if !found || member.IsBanned {
		return ErrNotFound
	}
	if input.CodeHash == "" || input.ExpiresAtMS <= input.CreatedAtMS {
		return ErrMemberMergeCodeInvalid
	}
	if targetID := s.memberMergeCodeTargets[input.CodeHash]; targetID != "" && targetID != input.TargetMemberID {
		return ErrAlreadyExists
	}
	s.deleteMemberMergeCodeLocked(input.TargetMemberID)
	s.memberMergeCodes[input.TargetMemberID] = input
	s.memberMergeCodeTargets[input.CodeHash] = input.TargetMemberID
	return nil
}

func (s *MemoryStore) CreateMemberMergeRequestFromCode(
	input domain.MemberMergeRequest,
	codeHash string,
	nowMS int64,
) (domain.MemberMergeRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupMemberMergeLocked(nowMS)
	targetMemberID := s.memberMergeCodeTargets[codeHash]
	code, found := s.memberMergeCodes[targetMemberID]
	if !found || code.CodeHash != codeHash || code.ExpiresAtMS <= nowMS {
		return domain.MemberMergeRequest{}, ErrMemberMergeCodeInvalid
	}
	if targetMemberID == input.RequesterMemberID {
		return domain.MemberMergeRequest{}, ErrSameMember
	}
	target, targetFound := s.members[targetMemberID]
	requester, requesterFound := s.members[input.RequesterMemberID]
	if !targetFound || !requesterFound || target.IsBanned || requester.IsBanned {
		return domain.MemberMergeRequest{}, ErrNotFound
	}
	for _, existing := range s.memberMergeRequests {
		if existing.Status != domain.MemberMergePending || existing.ExpiresAtMS <= nowMS {
			continue
		}
		if existing.RequesterMemberID == input.RequesterMemberID {
			return domain.MemberMergeRequest{}, ErrAlreadyExists
		}
	}
	s.deleteMemberMergeCodeLocked(targetMemberID)
	input.TargetMemberID = targetMemberID
	input.Status = domain.MemberMergePending
	s.memberMergeRequests[input.RequestID] = input
	return s.cloneMemberMergeRequestLocked(input), nil
}

func (s *MemoryStore) MemberMergeRequests(memberID string, nowMS int64) []domain.MemberMergeRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupMemberMergeLocked(nowMS)
	items := make([]domain.MemberMergeRequest, 0)
	for _, request := range s.memberMergeRequests {
		if request.Status != domain.MemberMergePending || (request.TargetMemberID != memberID && request.RequesterMemberID != memberID) {
			continue
		}
		if _, found := s.members[request.TargetMemberID]; !found {
			continue
		}
		if _, found := s.members[request.RequesterMemberID]; !found {
			continue
		}
		items = append(items, s.cloneMemberMergeRequestLocked(request))
	}
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAtMS < items[j].CreatedAtMS })
	return items
}

func (s *MemoryStore) MemberMergeRequest(requestID string, nowMS int64) (domain.MemberMergeRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupMemberMergeLocked(nowMS)
	request, found := s.memberMergeRequests[requestID]
	if !found || request.Status != domain.MemberMergePending || request.ExpiresAtMS <= nowMS {
		return domain.MemberMergeRequest{}, ErrMemberMergeRequestInvalid
	}
	return s.cloneMemberMergeRequestLocked(request), nil
}

func (s *MemoryStore) ResolveMemberMergeRequest(
	requestID string,
	targetMemberID string,
	status domain.MemberMergeRequestStatus,
	resolvedAtMS int64,
) (domain.MemberMergeRequest, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanupMemberMergeLocked(resolvedAtMS)
	request, found := s.memberMergeRequests[requestID]
	if !found || request.Status != domain.MemberMergePending || request.TargetMemberID != targetMemberID || request.ExpiresAtMS <= resolvedAtMS {
		return domain.MemberMergeRequest{}, ErrMemberMergeRequestInvalid
	}
	if status != domain.MemberMergeAccepted && status != domain.MemberMergeRejected {
		return domain.MemberMergeRequest{}, ErrMemberMergeRequestInvalid
	}
	request.Status = status
	request.ResolvedAtMS = resolvedAtMS
	s.memberMergeRequests[requestID] = request
	if status == domain.MemberMergeAccepted {
		for id, other := range s.memberMergeRequests {
			if id == requestID || other.Status != domain.MemberMergePending {
				continue
			}
			if other.TargetMemberID == request.TargetMemberID || other.RequesterMemberID == request.TargetMemberID ||
				other.TargetMemberID == request.RequesterMemberID || other.RequesterMemberID == request.RequesterMemberID {
				other.Status = domain.MemberMergeCancelled
				other.ResolvedAtMS = resolvedAtMS
				s.memberMergeRequests[id] = other
			}
		}
		s.deleteMemberMergeCodeLocked(request.TargetMemberID)
		s.deleteMemberMergeCodeLocked(request.RequesterMemberID)
	}
	return s.cloneMemberMergeRequestLocked(request), nil
}

func (s *MemoryStore) cleanupMemberMergeLocked(nowMS int64) {
	for memberID, code := range s.memberMergeCodes {
		if code.ExpiresAtMS <= nowMS {
			s.deleteMemberMergeCodeLocked(memberID)
		}
	}
	for id, request := range s.memberMergeRequests {
		if request.Status == domain.MemberMergePending && request.ExpiresAtMS <= nowMS {
			request.Status = domain.MemberMergeExpired
			request.ResolvedAtMS = nowMS
			s.memberMergeRequests[id] = request
		}
	}
}

func (s *MemoryStore) deleteMemberMergeCodeLocked(memberID string) {
	if code, found := s.memberMergeCodes[memberID]; found {
		delete(s.memberMergeCodeTargets, code.CodeHash)
		delete(s.memberMergeCodes, memberID)
	}
}

func (s *MemoryStore) cloneMemberMergeRequestLocked(request domain.MemberMergeRequest) domain.MemberMergeRequest {
	if requester, found := s.members[request.RequesterMemberID]; found {
		request.Requester = cloneMember(requester)
	}
	if target, found := s.members[request.TargetMemberID]; found {
		request.Target = cloneMember(target)
	}
	return request
}

func (s *MemoryStore) ClaimOwner(memberID string) (domain.Member, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	member, ok := s.members[memberID]
	if !ok {
		return domain.Member{}, ErrNotFound
	}
	for id, item := range s.members {
		item.IsOwner = id == memberID
		s.members[id] = item
		if id == memberID {
			member = item
		}
	}
	return cloneMember(member), nil
}

func (s *MemoryStore) Roles() []domain.ServerRole {
	s.mu.RLock()
	defer s.mu.RUnlock()

	roles := make([]domain.ServerRole, 0, len(s.roles))
	for _, role := range s.roles {
		role.MemberCount = s.roleMemberCountLocked(role)
		roles = append(roles, cloneServerRole(role))
	}
	sort.Slice(roles, func(i, j int) bool {
		if roles[i].Position != roles[j].Position {
			return roles[i].Position < roles[j].Position
		}
		return roles[i].RoleID < roles[j].RoleID
	})
	return roles
}

func (s *MemoryStore) ReorderRoles(items []domain.RoleOrderItem) ([]domain.ServerRole, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(items) != len(s.roles)-1 {
		return nil, ErrInvalidRoleOrder
	}
	seen := make(map[string]bool, len(items))
	for index, item := range items {
		role, ok := s.roles[item.RoleID]
		if !ok || role.IsEveryone || seen[item.RoleID] {
			return nil, ErrInvalidRoleOrder
		}
		seen[item.RoleID] = true
		role.Position = (len(items) - index) * 1000
		s.roles[item.RoleID] = role
	}
	if len(seen) != len(s.roles)-1 {
		return nil, ErrInvalidRoleOrder
	}
	everyone := s.roles[domain.EveryoneRoleID]
	everyone.Position = 0
	s.roles[domain.EveryoneRoleID] = everyone
	roles := make([]domain.ServerRole, 0, len(s.roles))
	for _, role := range s.roles {
		role.MemberCount = s.roleMemberCountLocked(role)
		roles = append(roles, cloneServerRole(role))
	}
	sort.Slice(roles, func(i, j int) bool { return roles[i].Position < roles[j].Position })
	return roles, nil
}

func (s *MemoryStore) CreateRole(input domain.ServerRole) (domain.ServerRole, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	roleID, err := auth.NewToken("role")
	if err != nil {
		return domain.ServerRole{}, err
	}
	input.RoleID = roleID
	input.IsEveryone = false
	if input.Name == "" {
		input.Name = "New Role"
	}
	if input.Position <= 0 {
		input.Position = s.nextRolePosition()
	}
	input.Permissions = normalizedPermissions(input.Permissions)
	s.roles[roleID] = input
	return cloneServerRole(input), nil
}

func (s *MemoryStore) UpdateRole(roleID string, input domain.ServerRole) (domain.ServerRole, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	role, ok := s.roles[roleID]
	if !ok {
		return domain.ServerRole{}, ErrNotFound
	}
	if !role.IsEveryone && input.Name != "" {
		role.Name = input.Name
	}
	if !role.IsEveryone {
		role.Color = input.Color
		role.GradientColor = input.GradientColor
		role.IconDataURL = input.IconDataURL
		role.DisplaySeparately = input.DisplaySeparately
		if input.Position > 0 {
			role.Position = input.Position
		}
	}
	role.Permissions = normalizedPermissions(input.Permissions)
	s.roles[roleID] = role
	return cloneServerRole(role), nil
}

func (s *MemoryStore) DeleteRole(roleID string) (domain.ServerRole, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	role, ok := s.roles[roleID]
	if !ok || role.IsEveryone {
		return domain.ServerRole{}, ErrNotFound
	}
	delete(s.roles, roleID)
	for memberID, member := range s.members {
		member.RoleIDs = removeRoleID(member.RoleIDs, roleID)
		s.members[memberID] = member
	}
	return cloneServerRole(role), nil
}

func (s *MemoryStore) SetMemberRoles(memberID string, roleIDs []string) (domain.Member, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	member, ok := s.members[memberID]
	if !ok {
		return domain.Member{}, ErrNotFound
	}
	next := make([]string, 0, len(roleIDs))
	seen := make(map[string]bool, len(roleIDs))
	for _, roleID := range roleIDs {
		role, ok := s.roles[roleID]
		if !ok || role.IsEveryone || seen[roleID] {
			continue
		}
		next = append(next, roleID)
		seen[roleID] = true
	}
	member.RoleIDs = next
	s.members[memberID] = member
	return cloneMember(member), nil
}

func (s *MemoryStore) MemberHasPermission(memberID string, permission domain.Permission) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	return s.memberHasPermissionLocked(memberID, permission)
}

func (s *MemoryStore) MemberHasChannelPermission(memberID string, channelID string, permission domain.Permission) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	member, ok := s.members[memberID]
	if !ok || member.IsBanned {
		return false
	}
	if member.IsOwner {
		return true
	}
	if s.memberHasPermissionLocked(memberID, domain.PermissionAdministrator) {
		return true
	}

	allowed := s.memberHasPermissionLocked(memberID, permission)
	channel, ok := s.channels[channelID]
	if !ok {
		return false
	}
	if channel.ParentID != "" && channel.PermissionSynced {
		allowed = s.applyChannelOverridesLocked(allowed, member, channel.ParentID, permission)
	}
	return s.applyChannelOverridesLocked(allowed, member, channelID, permission)
}

func (s *MemoryStore) memberHasPermissionLocked(memberID string, permission domain.Permission) bool {
	member, ok := s.members[memberID]
	if !ok || member.IsBanned {
		return false
	}
	if member.IsOwner {
		return true
	}
	everyone, ok := s.roles[domain.EveryoneRoleID]
	if ok && (everyone.Permissions[domain.PermissionAdministrator] || everyone.Permissions[permission]) {
		return true
	}
	for _, roleID := range member.RoleIDs {
		role, ok := s.roles[roleID]
		if !ok {
			continue
		}
		if role.Permissions[domain.PermissionAdministrator] || role.Permissions[permission] {
			return true
		}
	}
	return false
}

func (s *MemoryStore) applyChannelOverridesLocked(
	allowed bool,
	member domain.Member,
	channelID string,
	permission domain.Permission,
) bool {
	overrides := s.channelPermissionOverrides[channelID]
	if len(overrides) == 0 {
		return allowed
	}
	if override, ok := overrideForTarget(overrides, domain.OverrideTargetRole, domain.EveryoneRoleID); ok {
		allowed = applyPermissionOverride(allowed, override, permission)
	}
	for _, roleID := range member.RoleIDs {
		if override, ok := overrideForTarget(overrides, domain.OverrideTargetRole, roleID); ok {
			allowed = applyPermissionOverride(allowed, override, permission)
		}
	}
	if override, ok := overrideForTarget(overrides, domain.OverrideTargetMember, member.MemberID); ok {
		allowed = applyPermissionOverride(allowed, override, permission)
	}
	return allowed
}

func (s *MemoryStore) Channels() []domain.Channel {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return sortedChannelsLocked(s.channels)
}

func sortedChannelsLocked(source map[string]domain.Channel) []domain.Channel {
	channels := make([]domain.Channel, 0, len(source))
	for _, channel := range source {
		channels = append(channels, channel)
	}
	sort.Slice(channels, func(i, j int) bool {
		if channels[i].Position != channels[j].Position {
			return channels[i].Position < channels[j].Position
		}
		return channels[i].ChannelID < channels[j].ChannelID
	})
	return channels
}

func (s *MemoryStore) CreateChannel(input domain.Channel) (domain.Channel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	channelID, err := auth.NewToken("ch")
	if err != nil {
		return domain.Channel{}, err
	}
	input.ChannelID = channelID
	if input.Visibility == "" {
		input.Visibility = "default"
	}
	if input.Type == domain.ChannelTypeVoice && input.Bitrate <= 0 {
		input.Bitrate = 64000
	}
	if input.ParentID != "" {
		input.PermissionSynced = true
	}
	input.DefaultLanguage = strings.TrimSpace(input.DefaultLanguage)
	input.Localizations = normalizeChannelLocalizations(input.Localizations)
	input.Position = s.nextChannelPosition(input.ParentID)
	s.channels[channelID] = input
	return input, nil
}

func (s *MemoryStore) UpdateChannel(channelID string, input domain.Channel) (domain.Channel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	channel, ok := s.channels[channelID]
	if !ok {
		return domain.Channel{}, ErrNotFound
	}
	if input.Name != "" {
		channel.Name = input.Name
	}
	channel.ParentID = input.ParentID
	channel.Topic = input.Topic
	channel.Visibility = input.Visibility
	channel.WarningText = input.WarningText
	channel.Bitrate = input.Bitrate
	channel.UserLimit = input.UserLimit
	channel.PermissionSynced = input.PermissionSynced
	channel.Position = input.Position
	channel.DefaultLanguage = strings.TrimSpace(input.DefaultLanguage)
	channel.Localizations = normalizeChannelLocalizations(input.Localizations)
	s.channels[channelID] = channel
	return channel, nil
}

func (s *MemoryStore) ReorderChannels(items []domain.ChannelOrderItem) ([]domain.Channel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if len(items) != len(s.channels) {
		return nil, ErrInvalidChannelOrder
	}

	categoryIDs := make(map[string]bool)
	for _, channel := range s.channels {
		if channel.Type == domain.ChannelTypeCategory {
			categoryIDs[channel.ChannelID] = true
		}
	}

	seen := make(map[string]bool, len(items))
	nextPositionByParent := make(map[string]int)
	ordered := make(map[string]domain.Channel, len(s.channels))
	for _, item := range items {
		channel, ok := s.channels[item.ChannelID]
		if !ok || seen[item.ChannelID] {
			return nil, ErrInvalidChannelOrder
		}
		seen[item.ChannelID] = true

		parentID := item.ParentID
		if channel.Type == domain.ChannelTypeCategory {
			if parentID != "" {
				return nil, ErrInvalidChannelOrder
			}
			parentID = ""
		} else if parentID != "" && !categoryIDs[parentID] {
			return nil, ErrInvalidChannelOrder
		}

		nextPositionByParent[parentID] += 1000
		if channel.ParentID != parentID {
			channel.PermissionSynced = parentID != ""
		}
		channel.ParentID = parentID
		channel.Position = nextPositionByParent[parentID]
		ordered[channel.ChannelID] = channel
	}

	if len(seen) != len(s.channels) {
		return nil, ErrInvalidChannelOrder
	}

	s.channels = ordered
	return sortedChannelsLocked(s.channels), nil
}

func (s *MemoryStore) DeleteChannel(channelID string) (domain.Channel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	channel, ok := s.channels[channelID]
	if !ok {
		return domain.Channel{}, ErrNotFound
	}
	s.settleVoiceDurationsLocked(time.Now().UnixMilli(), true)
	existing := sortedChannelsLocked(s.channels)
	delete(s.channels, channelID)
	delete(s.messages, channelID)
	delete(s.channelMessageImages, channelID)
	delete(s.channelPermissionOverrides, channelID)
	for entryID, entry := range s.fileEntries {
		if entry.ChannelID == channelID {
			delete(s.fileEntries, entryID)
		}
	}
	for participantID, state := range s.voiceStates {
		if state.ChannelID == channelID {
			delete(s.voiceStates, participantID)
		}
	}

	if channel.Type == domain.ChannelTypeCategory {
		topLevel := make([]domain.Channel, 0)
		children := make([]domain.Channel, 0)
		for _, item := range existing {
			if item.ParentID == channelID {
				children = append(children, item)
			}
		}
		for _, item := range existing {
			if item.ChannelID == channelID {
				topLevel = append(topLevel, children...)
				continue
			}
			if item.ParentID == "" || item.Type == domain.ChannelTypeCategory {
				topLevel = append(topLevel, item)
			}
		}
		for index, item := range topLevel {
			if item.ChannelID == channelID {
				continue
			}
			item.ParentID = ""
			item.Position = (index + 1) * 1000
			if _, ok := s.channels[item.ChannelID]; ok {
				s.channels[item.ChannelID] = item
			}
		}
	}
	return channel, nil
}

func (s *MemoryStore) ChannelPermissionOverrides(channelID string) []domain.ChannelPermissionOverride {
	s.mu.RLock()
	defer s.mu.RUnlock()

	overrides := s.channelPermissionOverrides[channelID]
	items := make([]domain.ChannelPermissionOverride, 0, len(overrides))
	for _, override := range overrides {
		items = append(items, cloneChannelPermissionOverride(override))
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].TargetType != items[j].TargetType {
			return items[i].TargetType < items[j].TargetType
		}
		return items[i].TargetID < items[j].TargetID
	})
	return items
}

func (s *MemoryStore) SetChannelPermissionOverride(
	input domain.ChannelPermissionOverride,
) (domain.ChannelPermissionOverride, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.channels[input.ChannelID]; !ok {
		return domain.ChannelPermissionOverride{}, ErrNotFound
	}
	if input.TargetType != domain.OverrideTargetRole && input.TargetType != domain.OverrideTargetMember {
		return domain.ChannelPermissionOverride{}, ErrNotFound
	}
	if input.TargetID == "" {
		return domain.ChannelPermissionOverride{}, ErrNotFound
	}
	if input.TargetType == domain.OverrideTargetRole {
		if _, ok := s.roles[input.TargetID]; !ok {
			return domain.ChannelPermissionOverride{}, ErrNotFound
		}
	}
	if input.TargetType == domain.OverrideTargetMember {
		if _, ok := s.members[input.TargetID]; !ok {
			return domain.ChannelPermissionOverride{}, ErrNotFound
		}
	}
	if input.OverrideID == "" {
		for _, override := range s.channelPermissionOverrides[input.ChannelID] {
			if override.TargetType == input.TargetType && override.TargetID == input.TargetID {
				input.OverrideID = override.OverrideID
				break
			}
		}
	}
	if input.OverrideID == "" {
		overrideID, err := auth.NewToken("ovr")
		if err != nil {
			return domain.ChannelPermissionOverride{}, err
		}
		input.OverrideID = overrideID
	}
	input.Allows = normalizedPermissions(input.Allows)
	input.Denies = normalizedPermissions(input.Denies)
	if s.channelPermissionOverrides[input.ChannelID] == nil {
		s.channelPermissionOverrides[input.ChannelID] = make(map[string]domain.ChannelPermissionOverride)
	}
	s.channelPermissionOverrides[input.ChannelID][input.OverrideID] = input
	channel := s.channels[input.ChannelID]
	if channel.ParentID != "" && channel.PermissionSynced {
		channel.PermissionSynced = false
		s.channels[input.ChannelID] = channel
	}
	return cloneChannelPermissionOverride(input), nil
}

func (s *MemoryStore) DeleteChannelPermissionOverride(
	channelID string,
	overrideID string,
) (domain.ChannelPermissionOverride, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	overrides := s.channelPermissionOverrides[channelID]
	override, ok := overrides[overrideID]
	if !ok {
		return domain.ChannelPermissionOverride{}, ErrNotFound
	}
	delete(overrides, overrideID)
	if len(overrides) == 0 {
		delete(s.channelPermissionOverrides, channelID)
	}
	return cloneChannelPermissionOverride(override), nil
}

func (s *MemoryStore) Messages(channelID string, beforeMS int64, limit int) []domain.Message {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if limit <= 0 || limit > 100 {
		limit = 50
	}
	source := s.messages[channelID]
	page := []domain.Message{}
	for i := len(source) - 1; i >= 0 && len(page) < limit; i-- {
		message := source[i]
		if message.DeletedAtMS != 0 {
			continue
		}
		if beforeMS > 0 && message.CreatedAtMS >= beforeMS {
			continue
		}
		page = append(page, message)
	}
	for i, j := 0, len(page)-1; i < j; i, j = i+1, j-1 {
		page[i], page[j] = page[j], page[i]
	}
	return page
}

func (s *MemoryStore) Message(channelID string, messageID string) (domain.Message, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	for _, message := range s.messages[channelID] {
		if message.MessageID == messageID && message.DeletedAtMS == 0 {
			return message, nil
		}
	}
	return domain.Message{}, ErrNotFound
}

func (s *MemoryStore) MessagesAround(
	channelID string,
	messageID string,
	beforeLimit int,
	afterLimit int,
) ([]domain.Message, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if beforeLimit <= 0 || beforeLimit > 50 {
		beforeLimit = 25
	}
	if afterLimit <= 0 || afterLimit > 50 {
		afterLimit = 25
	}
	source := s.messages[channelID]
	targetIndex := -1
	for index, message := range source {
		if message.MessageID == messageID && message.DeletedAtMS == 0 {
			targetIndex = index
			break
		}
	}
	if targetIndex < 0 {
		return nil, ErrNotFound
	}

	window := []domain.Message{}
	for index := targetIndex - 1; index >= 0 && len(window) < beforeLimit; index-- {
		message := source[index]
		if message.DeletedAtMS == 0 {
			window = append(window, message)
		}
	}
	for i, j := 0, len(window)-1; i < j; i, j = i+1, j-1 {
		window[i], window[j] = window[j], window[i]
	}
	window = append(window, source[targetIndex])
	for index := targetIndex + 1; index < len(source) && len(window) < beforeLimit+1+afterLimit; index++ {
		message := source[index]
		if message.DeletedAtMS == 0 {
			window = append(window, message)
		}
	}
	return window, nil
}

func (s *MemoryStore) SearchMessages(channelID string, query string, limit int) []domain.Message {
	s.mu.RLock()
	defer s.mu.RUnlock()

	query = strings.ToLower(strings.TrimSpace(query))
	if query == "" {
		return []domain.Message{}
	}
	if limit <= 0 || limit > 50 {
		limit = 25
	}
	source := s.messages[channelID]
	results := []domain.Message{}
	for index := len(source) - 1; index >= 0 && len(results) < limit; index-- {
		message := source[index]
		if message.DeletedAtMS == 0 && strings.Contains(strings.ToLower(message.Content), query) {
			results = append(results, message)
		}
	}
	return results
}

func (s *MemoryStore) CreateMessage(
	channelID string,
	authorID string,
	content string,
	replyToMessageID string,
) (domain.Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.channels[channelID]; !ok {
		return domain.Message{}, ErrNotFound
	}
	if replyToMessageID != "" {
		foundReply := false
		for _, message := range s.messages[channelID] {
			if message.MessageID == replyToMessageID && message.DeletedAtMS == 0 {
				foundReply = true
				break
			}
		}
		if !foundReply {
			return domain.Message{}, ErrNotFound
		}
	}
	messageID, err := auth.NewToken("msg")
	if err != nil {
		return domain.Message{}, err
	}
	message := domain.Message{
		MessageID:        messageID,
		ChannelID:        channelID,
		AuthorID:         authorID,
		Content:          content,
		ReplyToMessageID: replyToMessageID,
		CreatedAtMS:      time.Now().UnixMilli(),
	}
	s.messages[channelID] = append(s.messages[channelID], message)
	return message, nil
}

func (s *MemoryStore) UpdateMessage(
	channelID string,
	messageID string,
	authorID string,
	content string,
) (domain.Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	messages := s.messages[channelID]
	for index, message := range messages {
		if message.MessageID != messageID || message.DeletedAtMS != 0 {
			continue
		}
		if message.AuthorID != authorID {
			return domain.Message{}, ErrForbidden
		}
		message.Content = content
		message.EditedAtMS = time.Now().UnixMilli()
		s.messages[channelID][index] = message
		return message, nil
	}
	return domain.Message{}, ErrNotFound
}

func (s *MemoryStore) DeleteMessage(
	channelID string,
	messageID string,
	actorID string,
	canManage bool,
) (domain.Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	messages := s.messages[channelID]
	for index, message := range messages {
		if message.MessageID != messageID || message.DeletedAtMS != 0 {
			continue
		}
		if message.AuthorID != actorID && !canManage {
			return domain.Message{}, ErrForbidden
		}
		message.DeletedAtMS = time.Now().UnixMilli()
		s.messages[channelID][index] = message
		return message, nil
	}
	return domain.Message{}, ErrNotFound
}

func (s *MemoryStore) ContentAsset(sha256 string) (domain.ContentAsset, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	asset, ok := s.contentAssets[sha256]
	if !ok {
		return domain.ContentAsset{}, ErrNotFound
	}
	return asset, nil
}

func (s *MemoryStore) UpsertContentAsset(input domain.ContentAsset) (domain.ContentAsset, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if input.SHA256 == "" {
		return domain.ContentAsset{}, ErrNotFound
	}
	if existing, ok := s.contentAssets[input.SHA256]; ok {
		return existing, nil
	}
	if input.CreatedAtMS == 0 {
		input.CreatedAtMS = time.Now().UnixMilli()
	}
	s.contentAssets[input.SHA256] = input
	return input, nil
}

func (s *MemoryStore) LinkChannelMessageImage(channelID string, assetSHA256 string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.channels[channelID]; !ok {
		return ErrNotFound
	}
	if _, ok := s.contentAssets[assetSHA256]; !ok {
		return ErrNotFound
	}
	if s.channelMessageImages[channelID] == nil {
		s.channelMessageImages[channelID] = make(map[string]struct{})
	}
	s.channelMessageImages[channelID][assetSHA256] = struct{}{}
	return nil
}

func (s *MemoryStore) ChannelHasMessageImage(channelID string, assetSHA256 string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.channelMessageImages[channelID][assetSHA256]
	return ok
}

func (s *MemoryStore) SoundboardItems() []domain.SoundboardItem {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]domain.SoundboardItem, 0, len(s.soundboardItems))
	for _, item := range s.soundboardItems {
		items = append(items, item)
	}
	sort.Slice(items, func(i, j int) bool {
		left := strings.ToLower(items[i].Name)
		right := strings.ToLower(items[j].Name)
		if left != right {
			return left < right
		}
		return items[i].ItemID < items[j].ItemID
	})
	return items
}

func (s *MemoryStore) SoundboardItem(itemID string) (domain.SoundboardItem, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.soundboardItems[itemID]
	if !ok {
		return domain.SoundboardItem{}, ErrNotFound
	}
	return item, nil
}

func (s *MemoryStore) CreateSoundboardItem(input domain.SoundboardItem) (domain.SoundboardItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.contentAssets[input.AssetSHA256]; !ok {
		return domain.SoundboardItem{}, ErrNotFound
	}
	for _, existing := range s.soundboardItems {
		if strings.EqualFold(existing.Name, input.Name) {
			return domain.SoundboardItem{}, ErrAlreadyExists
		}
	}
	itemID, err := auth.NewToken("snd")
	if err != nil {
		return domain.SoundboardItem{}, err
	}
	now := time.Now().UnixMilli()
	if input.BaseVolume <= 0 {
		input.BaseVolume = 1
	}
	input.ItemID = itemID
	input.CreatedAtMS = now
	input.UpdatedAtMS = now
	s.soundboardItems[itemID] = input
	return input, nil
}

func (s *MemoryStore) UpdateSoundboardItem(itemID string, input domain.SoundboardItem) (domain.SoundboardItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.soundboardItems[itemID]
	if !ok {
		return domain.SoundboardItem{}, ErrNotFound
	}
	for _, existing := range s.soundboardItems {
		if existing.ItemID != itemID && strings.EqualFold(existing.Name, input.Name) {
			return domain.SoundboardItem{}, ErrAlreadyExists
		}
	}
	current.Name = input.Name
	current.IconEmoji = input.IconEmoji
	current.IconAssetSHA256 = input.IconAssetSHA256
	current.StartMS = input.StartMS
	current.EndMS = input.EndMS
	current.BaseVolume = input.BaseVolume
	current.UpdatedAtMS = time.Now().UnixMilli()
	s.soundboardItems[itemID] = current
	return current, nil
}

func (s *MemoryStore) DeleteSoundboardItem(itemID string) (domain.SoundboardItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	item, ok := s.soundboardItems[itemID]
	if !ok {
		return domain.SoundboardItem{}, ErrNotFound
	}
	delete(s.soundboardItems, itemID)
	return item, nil
}

func (s *MemoryStore) CustomEmojis() []domain.CustomEmoji {
	s.mu.RLock()
	defer s.mu.RUnlock()
	emojis := make([]domain.CustomEmoji, 0, len(s.customEmojis))
	for _, emoji := range s.customEmojis {
		emojis = append(emojis, emoji)
	}
	sort.Slice(emojis, func(i, j int) bool {
		left := strings.ToLower(emojis[i].Shortcode)
		right := strings.ToLower(emojis[j].Shortcode)
		if left != right {
			return left < right
		}
		return emojis[i].EmojiID < emojis[j].EmojiID
	})
	return emojis
}

func (s *MemoryStore) CustomEmoji(emojiID string) (domain.CustomEmoji, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	emoji, ok := s.customEmojis[emojiID]
	if !ok {
		return domain.CustomEmoji{}, ErrNotFound
	}
	return emoji, nil
}

func (s *MemoryStore) CreateCustomEmoji(input domain.CustomEmoji) (domain.CustomEmoji, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.contentAssets[input.AssetSHA256]; !ok {
		return domain.CustomEmoji{}, ErrNotFound
	}
	for _, existing := range s.customEmojis {
		if strings.EqualFold(existing.Shortcode, input.Shortcode) {
			return domain.CustomEmoji{}, ErrAlreadyExists
		}
	}
	emojiID, err := auth.NewToken("emo")
	if err != nil {
		return domain.CustomEmoji{}, err
	}
	now := time.Now().UnixMilli()
	input.EmojiID = emojiID
	input.CreatedAtMS = now
	input.UpdatedAtMS = now
	s.customEmojis[emojiID] = input
	return input, nil
}

func (s *MemoryStore) UpdateCustomEmoji(emojiID string, shortcode string) (domain.CustomEmoji, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	emoji, ok := s.customEmojis[emojiID]
	if !ok {
		return domain.CustomEmoji{}, ErrNotFound
	}
	for id, existing := range s.customEmojis {
		if id != emojiID && strings.EqualFold(existing.Shortcode, shortcode) {
			return domain.CustomEmoji{}, ErrAlreadyExists
		}
	}
	emoji.Shortcode = shortcode
	emoji.UpdatedAtMS = time.Now().UnixMilli()
	s.customEmojis[emojiID] = emoji
	return emoji, nil
}

func (s *MemoryStore) DeleteCustomEmoji(emojiID string) (domain.CustomEmoji, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	emoji, ok := s.customEmojis[emojiID]
	if !ok {
		return domain.CustomEmoji{}, ErrNotFound
	}
	delete(s.customEmojis, emojiID)
	return emoji, nil
}

func (s *MemoryStore) FileEntries(channelID string, parentID string) []domain.ChannelFileEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()

	items := make([]domain.ChannelFileEntry, 0)
	for _, entry := range s.fileEntries {
		if entry.ChannelID == channelID && entry.ParentID == parentID {
			items = append(items, entry)
		}
	}
	sortFileEntries(items)
	return items
}

func (s *MemoryStore) FileEntry(channelID string, entryID string) (domain.ChannelFileEntry, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	entry, ok := s.fileEntries[entryID]
	if !ok || entry.ChannelID != channelID {
		return domain.ChannelFileEntry{}, ErrNotFound
	}
	return entry, nil
}

func (s *MemoryStore) CreateFileEntry(input domain.ChannelFileEntry) (domain.ChannelFileEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, ok := s.channels[input.ChannelID]; !ok {
		return domain.ChannelFileEntry{}, ErrNotFound
	}
	if err := s.validateFileParentLocked(input.ChannelID, input.ParentID, ""); err != nil {
		return domain.ChannelFileEntry{}, err
	}
	entryID, err := auth.NewToken("file")
	if err != nil {
		return domain.ChannelFileEntry{}, err
	}
	now := time.Now().UnixMilli()
	input.EntryID = entryID
	if input.Type == "" {
		input.Type = domain.ChannelFileEntryFile
	}
	input.CreatedAtMS = now
	input.UpdatedAtMS = now
	s.fileEntries[entryID] = input
	return input, nil
}

func (s *MemoryStore) UpdateFileEntry(channelID string, entryID string, input domain.ChannelFileEntry) (domain.ChannelFileEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entry, ok := s.fileEntries[entryID]
	if !ok || entry.ChannelID != channelID {
		return domain.ChannelFileEntry{}, ErrNotFound
	}
	if input.ParentID != entry.ParentID {
		if err := s.validateFileParentLocked(channelID, input.ParentID, entryID); err != nil {
			return domain.ChannelFileEntry{}, err
		}
		entry.ParentID = input.ParentID
	}
	if strings.TrimSpace(input.Name) != "" {
		entry.Name = input.Name
	}
	entry.UpdatedAtMS = time.Now().UnixMilli()
	s.fileEntries[entryID] = entry
	return entry, nil
}

func (s *MemoryStore) DeleteFileEntry(channelID string, entryID string) (domain.ChannelFileEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entry, ok := s.fileEntries[entryID]
	if !ok || entry.ChannelID != channelID {
		return domain.ChannelFileEntry{}, ErrNotFound
	}
	s.deleteFileEntryTreeLocked(channelID, entryID)
	return entry, nil
}

func (s *MemoryStore) validateFileParentLocked(channelID string, parentID string, movingEntryID string) error {
	if parentID == "" {
		return nil
	}
	parent, ok := s.fileEntries[parentID]
	if !ok || parent.ChannelID != channelID || parent.Type != domain.ChannelFileEntryDirectory {
		return ErrNotFound
	}
	if movingEntryID == "" {
		return nil
	}
	if parentID == movingEntryID {
		return ErrInvalidChannelOrder
	}
	for parent.ParentID != "" {
		if parent.ParentID == movingEntryID {
			return ErrInvalidChannelOrder
		}
		next, ok := s.fileEntries[parent.ParentID]
		if !ok {
			return nil
		}
		parent = next
	}
	return nil
}

func (s *MemoryStore) deleteFileEntryTreeLocked(channelID string, entryID string) {
	for childID, child := range s.fileEntries {
		if child.ChannelID == channelID && child.ParentID == entryID {
			s.deleteFileEntryTreeLocked(channelID, childID)
		}
	}
	delete(s.fileEntries, entryID)
}

func sortFileEntries(items []domain.ChannelFileEntry) {
	sort.Slice(items, func(i, j int) bool {
		if items[i].Type != items[j].Type {
			return items[i].Type == domain.ChannelFileEntryDirectory
		}
		left := strings.ToLower(items[i].Name)
		right := strings.ToLower(items[j].Name)
		if left != right {
			return left < right
		}
		return items[i].EntryID < items[j].EntryID
	})
}

func (s *MemoryStore) CreateAuditLog(input domain.AuditLog) (domain.AuditLog, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	auditID, err := auth.NewToken("audit")
	if err != nil {
		return domain.AuditLog{}, err
	}
	if input.Details == nil {
		input.Details = map[string]string{}
	}
	input.AuditID = auditID
	if input.CreatedAtMS == 0 {
		input.CreatedAtMS = time.Now().UnixMilli()
	}
	s.auditLogs = append(s.auditLogs, input)
	return input, nil
}

func (s *MemoryStore) AuditLogs(action string, limit int) []domain.AuditLog {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if limit <= 0 || limit > 100 {
		limit = 50
	}
	capacity := limit
	if len(s.auditLogs) < capacity {
		capacity = len(s.auditLogs)
	}
	items := make([]domain.AuditLog, 0, capacity)
	for index := len(s.auditLogs) - 1; index >= 0 && len(items) < limit; index-- {
		log := cloneAuditLog(s.auditLogs[index])
		if action != "" && log.Action != action {
			continue
		}
		items = append(items, log)
	}
	return items
}

func cloneAuditLog(input domain.AuditLog) domain.AuditLog {
	if input.Details == nil {
		input.Details = map[string]string{}
		return input
	}
	details := make(map[string]string, len(input.Details))
	for key, value := range input.Details {
		details[key] = value
	}
	input.Details = details
	return input
}

func (s *MemoryStore) Invites() []domain.ServerInvite {
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := make([]domain.ServerInvite, 0, len(s.invites))
	for _, invite := range s.invites {
		invite.TokenHash = ""
		items = append(items, invite)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAtMS > items[j].CreatedAtMS })
	return items
}

func (s *MemoryStore) CreateInvite(input domain.ServerInvite) (domain.ServerInvite, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if input.InviteID == "" || input.TokenHash == "" {
		return domain.ServerInvite{}, ErrInviteInvalid
	}
	if input.MaxUses <= 0 {
		input.MaxUses = 1
	}
	s.invites[input.InviteID] = input
	return input, nil
}

func (s *MemoryStore) ConsumeInvite(token string, nowMS int64) (domain.ServerInvite, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tokenHash := auth.HashSecret(strings.TrimSpace(token))
	for inviteID, invite := range s.invites {
		if invite.TokenHash != tokenHash {
			continue
		}
		if (invite.ExpiresAtMS > 0 && invite.ExpiresAtMS <= nowMS) || invite.UseCount >= invite.MaxUses {
			return domain.ServerInvite{}, ErrInviteInvalid
		}
		invite.UseCount++
		s.invites[inviteID] = invite
		invite.TokenHash = ""
		return invite, nil
	}
	return domain.ServerInvite{}, ErrInviteInvalid
}

func (s *MemoryStore) DeleteInvite(inviteID string) (domain.ServerInvite, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	invite, found := s.invites[inviteID]
	if !found {
		return domain.ServerInvite{}, ErrNotFound
	}
	delete(s.invites, inviteID)
	invite.TokenHash = ""
	return invite, nil
}

func (s *MemoryStore) VoiceStates() []domain.VoiceState {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.settleVoiceDurationsLocked(time.Now().UnixMilli(), false)

	return sortedVoiceStates(s.voiceStates)
}

func (s *MemoryStore) VoiceDurationStats(memberID string, comparedMemberID string) (domain.VoiceDurationStats, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.members[memberID]; !ok {
		return domain.VoiceDurationStats{}, ErrNotFound
	}
	if comparedMemberID != "" {
		if _, ok := s.members[comparedMemberID]; !ok {
			return domain.VoiceDurationStats{}, ErrNotFound
		}
	}

	now := time.Now().UnixMilli()
	s.settleVoiceDurationsLocked(now, true)
	members, pairs := voiceDurationTopology(s.voiceStateSliceLocked())
	stats := domain.VoiceDurationStats{
		MemberID:             memberID,
		ComparedMemberID:     comparedMemberID,
		TotalVoiceDurationMS: s.voiceDurationByMember[memberID],
		MemberActive:         hasVoiceDurationMember(members, memberID),
		MeasuredAtMS:         now,
	}
	if pair, ok := canonicalVoiceMemberPair(memberID, comparedMemberID); ok {
		stats.SharedVoiceDurationMS = s.voiceDurationByPair[pair]
		_, stats.SharedActive = pairs[pair]
	}
	return stats, nil
}

func (s *MemoryStore) settleVoiceDurationsLocked(nowMS int64, force bool) {
	if s.voiceStatsCheckpointMS <= 0 || nowMS < s.voiceStatsCheckpointMS {
		s.voiceStatsCheckpointMS = nowMS
		return
	}
	deltaMS := nowMS - s.voiceStatsCheckpointMS
	if deltaMS <= 0 || (!force && deltaMS < voiceDurationCheckpointIntervalMS) {
		return
	}
	members, pairs := voiceDurationTopology(s.voiceStateSliceLocked())
	for memberID := range members {
		s.voiceDurationByMember[memberID] += deltaMS
	}
	for pair := range pairs {
		s.voiceDurationByPair[pair] += deltaMS
	}
	s.voiceStatsCheckpointMS = nowMS
}

func (s *MemoryStore) voiceStateSliceLocked() []domain.VoiceState {
	states := make([]domain.VoiceState, 0, len(s.voiceStates))
	for _, state := range s.voiceStates {
		states = append(states, state)
	}
	return states
}

func sortedVoiceStates(statesByID map[string]domain.VoiceState) []domain.VoiceState {
	states := make([]domain.VoiceState, 0, len(statesByID))
	for _, state := range statesByID {
		states = append(states, state)
	}

	sort.Slice(states, func(i, j int) bool {
		if states[i].ChannelID != states[j].ChannelID {
			return states[i].ChannelID < states[j].ChannelID
		}
		return states[i].ParticipantID < states[j].ParticipantID
	})
	return states
}

func hasVoiceDurationMember(members map[string]struct{}, memberID string) bool {
	_, ok := members[memberID]
	return ok
}

func (s *MemoryStore) mergeVoiceDurationsLocked(primaryMemberID string, duplicateMemberID string) {
	s.voiceDurationByMember[primaryMemberID] += s.voiceDurationByMember[duplicateMemberID]
	delete(s.voiceDurationByMember, duplicateMemberID)
	for pair, durationMS := range s.voiceDurationByPair {
		if pair.First != duplicateMemberID && pair.Second != duplicateMemberID {
			continue
		}
		delete(s.voiceDurationByPair, pair)
		otherMemberID := pair.First
		if otherMemberID == duplicateMemberID {
			otherMemberID = pair.Second
		}
		mergedPair, ok := canonicalVoiceMemberPair(primaryMemberID, otherMemberID)
		if ok {
			s.voiceDurationByPair[mergedPair] += durationMS
		}
	}
}

func (s *MemoryStore) JoinVoiceChannel(channelID string, memberID string, deviceID string, mode string) (domain.VoiceState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	channel, ok := s.channels[channelID]
	if !ok {
		return domain.VoiceState{}, ErrNotFound
	}
	if channel.Type != domain.ChannelTypeVoice && channel.Type != domain.ChannelTypeTemporaryVoice {
		return domain.VoiceState{}, ErrInvalidVoiceChannel
	}
	if _, ok := s.members[memberID]; !ok {
		return domain.VoiceState{}, ErrNotFound
	}
	if mode != "listener" {
		mode = "primary"
	}
	now := time.Now().UnixMilli()
	s.settleVoiceDurationsLocked(now, true)
	state := domain.VoiceState{
		ParticipantID: domain.VoiceParticipantID(memberID, deviceID),
		ChannelID:     channelID,
		MemberID:      memberID,
		DeviceID:      deviceID,
		Mode:          mode,
		JoinedAtMS:    now,
		MicMuted:      mode == "listener",
	}
	s.voiceStates[state.ParticipantID] = state
	return state, nil
}

func (s *MemoryStore) UpdateVoiceState(participantID string, input domain.VoiceState) (domain.VoiceState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, ok := s.voiceStates[participantID]
	if !ok {
		return domain.VoiceState{}, ErrNotFound
	}
	state.MicMuted = state.Mode == "listener" || input.MicMuted || input.AudioDeafened || state.ServerMuted || state.ServerDeafened
	state.AudioDeafened = input.AudioDeafened
	state.IsSpeaking = input.IsSpeaking && !state.MicMuted && !state.AudioDeafened && !state.ServerMuted && !state.ServerDeafened
	if state.ServerDeafened {
		state.ServerMuted = true
	}
	s.voiceStates[participantID] = state
	return state, nil
}

func (s *MemoryStore) ManageVoiceState(participantID string, input domain.VoiceState) (domain.VoiceState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, ok := s.voiceStates[participantID]
	if !ok {
		return domain.VoiceState{}, ErrNotFound
	}
	if input.ChannelID != "" && input.ChannelID != state.ChannelID {
		channel, ok := s.channels[input.ChannelID]
		if !ok {
			return domain.VoiceState{}, ErrNotFound
		}
		if channel.Type != domain.ChannelTypeVoice && channel.Type != domain.ChannelTypeTemporaryVoice {
			return domain.VoiceState{}, ErrInvalidVoiceChannel
		}
		now := time.Now().UnixMilli()
		s.settleVoiceDurationsLocked(now, true)
		state.ChannelID = input.ChannelID
		state.JoinedAtMS = now
		state.IsSpeaking = false
	}
	state.ServerMuted = input.ServerMuted || input.ServerDeafened
	state.ServerDeafened = input.ServerDeafened
	state.MicMuted = state.MicMuted || state.ServerMuted || state.ServerDeafened
	if state.ServerDeafened {
		state.AudioDeafened = true
	}
	state.IsSpeaking = state.IsSpeaking && !state.MicMuted && !state.AudioDeafened && !state.ServerMuted && !state.ServerDeafened
	s.voiceStates[participantID] = state
	return state, nil
}

func (s *MemoryStore) LeaveVoiceChannel(participantID string) (domain.VoiceState, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, ok := s.voiceStates[participantID]
	if !ok {
		return domain.VoiceState{}, false, nil
	}
	s.settleVoiceDurationsLocked(time.Now().UnixMilli(), true)
	delete(s.voiceStates, participantID)
	return state, true, nil
}

func (s *MemoryStore) LeaveMemberVoiceChannels(memberID string) ([]domain.VoiceState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.settleVoiceDurationsLocked(time.Now().UnixMilli(), true)
	states := []domain.VoiceState{}
	for participantID, state := range s.voiceStates {
		if state.MemberID == memberID {
			states = append(states, state)
			delete(s.voiceStates, participantID)
		}
	}
	return states, nil
}

func (s *MemoryStore) ScreenShareSessions() []domain.ScreenShareSession {
	s.mu.RLock()
	defer s.mu.RUnlock()

	items := make([]domain.ScreenShareSession, 0, len(s.screenShareSessions))
	for _, session := range s.screenShareSessions {
		items = append(items, session)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].ChannelID != items[j].ChannelID {
			return items[i].ChannelID < items[j].ChannelID
		}
		if items[i].StartedAtMS != items[j].StartedAtMS {
			return items[i].StartedAtMS < items[j].StartedAtMS
		}
		return items[i].ShareID < items[j].ShareID
	})
	return items
}

func (s *MemoryStore) StartScreenShareSession(input domain.ScreenShareSession) (domain.ScreenShareSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	channel, ok := s.channels[input.ChannelID]
	if !ok {
		return domain.ScreenShareSession{}, ErrNotFound
	}
	if channel.Type != domain.ChannelTypeVoice && channel.Type != domain.ChannelTypeTemporaryVoice {
		return domain.ScreenShareSession{}, ErrInvalidVoiceChannel
	}
	if _, ok := s.members[input.OwnerMemberID]; !ok {
		return domain.ScreenShareSession{}, ErrNotFound
	}
	for shareID, session := range s.screenShareSessions {
		if session.OwnerMemberID == input.OwnerMemberID {
			delete(s.screenShareSessions, shareID)
		}
	}
	shareID, err := auth.NewToken("share")
	if err != nil {
		return domain.ScreenShareSession{}, err
	}
	input.ShareID = shareID
	if input.StartedAtMS == 0 {
		input.StartedAtMS = time.Now().UnixMilli()
	}
	if input.ViewerMemberIDs == nil {
		input.ViewerMemberIDs = []string{}
	}
	s.screenShareSessions[input.ShareID] = input
	return input, nil
}

func (s *MemoryStore) SetScreenShareViewer(
	shareID string,
	memberID string,
	watching bool,
) (domain.ScreenShareSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.screenShareSessions[shareID]
	if !ok {
		return domain.ScreenShareSession{}, ErrNotFound
	}
	viewers := map[string]struct{}{}
	for _, viewerID := range session.ViewerMemberIDs {
		if viewerID != "" {
			viewers[viewerID] = struct{}{}
		}
	}
	if watching {
		viewers[memberID] = struct{}{}
	} else {
		delete(viewers, memberID)
	}
	session.ViewerMemberIDs = sortedStringKeys(viewers)
	s.screenShareSessions[shareID] = session
	return session, nil
}

func (s *MemoryStore) RemoveScreenShareViewerFromAll(memberID string) []domain.ScreenShareSession {
	s.mu.Lock()
	defer s.mu.Unlock()

	updated := []domain.ScreenShareSession{}
	for shareID, session := range s.screenShareSessions {
		viewers := map[string]struct{}{}
		changed := false
		for _, viewerID := range session.ViewerMemberIDs {
			if viewerID == "" {
				continue
			}
			if viewerID == memberID {
				changed = true
				continue
			}
			viewers[viewerID] = struct{}{}
		}
		if !changed {
			continue
		}
		session.ViewerMemberIDs = sortedStringKeys(viewers)
		s.screenShareSessions[shareID] = session
		updated = append(updated, session)
	}
	return updated
}

func (s *MemoryStore) EndScreenShareSession(
	shareID string,
	actorMemberID string,
	canManage bool,
) (domain.ScreenShareSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.screenShareSessions[shareID]
	if !ok {
		return domain.ScreenShareSession{}, ErrNotFound
	}
	if session.OwnerMemberID != actorMemberID && !canManage {
		return domain.ScreenShareSession{}, ErrForbidden
	}
	delete(s.screenShareSessions, shareID)
	return session, nil
}

func (s *MemoryStore) AccompanimentSessions() []domain.AccompanimentSession {
	s.mu.RLock()
	defer s.mu.RUnlock()

	items := make([]domain.AccompanimentSession, 0, len(s.accompanimentSessions))
	for _, session := range s.accompanimentSessions {
		items = append(items, session)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].ChannelID != items[j].ChannelID {
			return items[i].ChannelID < items[j].ChannelID
		}
		if items[i].StartedAtMS != items[j].StartedAtMS {
			return items[i].StartedAtMS < items[j].StartedAtMS
		}
		return items[i].SessionID < items[j].SessionID
	})
	return items
}

func (s *MemoryStore) StartAccompanimentSession(input domain.AccompanimentSession) (domain.AccompanimentSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	channel, ok := s.channels[input.ChannelID]
	if !ok {
		return domain.AccompanimentSession{}, ErrNotFound
	}
	if channel.Type != domain.ChannelTypeVoice && channel.Type != domain.ChannelTypeTemporaryVoice {
		return domain.AccompanimentSession{}, ErrInvalidVoiceChannel
	}
	if _, ok := s.members[input.OwnerMemberID]; !ok {
		return domain.AccompanimentSession{}, ErrNotFound
	}
	for _, session := range s.accompanimentSessions {
		if session.OwnerMemberID == input.OwnerMemberID {
			return domain.AccompanimentSession{}, ErrAccompanimentActive
		}
	}
	sessionID, err := auth.NewToken("acc")
	if err != nil {
		return domain.AccompanimentSession{}, err
	}
	input.SessionID = sessionID
	if input.StartedAtMS == 0 {
		input.StartedAtMS = time.Now().UnixMilli()
	}
	s.accompanimentSessions[input.SessionID] = input
	return input, nil
}

func (s *MemoryStore) EndAccompanimentSession(
	sessionID string,
	actorMemberID string,
	canManage bool,
) (domain.AccompanimentSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	session, ok := s.accompanimentSessions[sessionID]
	if !ok {
		return domain.AccompanimentSession{}, ErrNotFound
	}
	if session.OwnerMemberID != actorMemberID && !canManage {
		return domain.AccompanimentSession{}, ErrForbidden
	}
	delete(s.accompanimentSessions, sessionID)
	return session, nil
}

func (s *MemoryStore) nextChannelPosition(parentID string) int {
	maxPosition := 0
	for _, channel := range s.channels {
		if channel.ParentID == parentID && channel.Position > maxPosition {
			maxPosition = channel.Position
		}
	}
	return maxPosition + 1000
}

func (s *MemoryStore) nextRolePosition() int {
	maxPosition := 0
	for _, role := range s.roles {
		if role.Position > maxPosition {
			maxPosition = role.Position
		}
	}
	return maxPosition + 1000
}

func defaultServerRoles() map[string]domain.ServerRole {
	return map[string]domain.ServerRole{
		domain.EveryoneRoleID: {
			RoleID:      domain.EveryoneRoleID,
			Name:        "@everyone",
			Position:    0,
			IsEveryone:  true,
			Permissions: defaultEveryonePermissions(),
		},
	}
}

func deviceCredentialKey(memberID string, deviceID string) string {
	return memberID + "\x00" + deviceID
}

func (s *MemoryStore) linkedDeviceCountLocked(memberID string) int {
	count := 0
	for _, linkedMemberID := range s.memberByDeviceID {
		if linkedMemberID == memberID {
			count++
		}
	}
	return count
}

func (s *MemoryStore) roleMemberCountLocked(role domain.ServerRole) int {
	if role.IsEveryone {
		return len(s.members)
	}
	count := 0
	for _, member := range s.members {
		for _, roleID := range member.RoleIDs {
			if roleID == role.RoleID {
				count++
				break
			}
		}
	}
	return count
}

func maxInt64(left int64, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

func normalizedPermissions(input map[domain.Permission]bool) map[domain.Permission]bool {
	permissions := make(map[domain.Permission]bool, len(domain.AllPermissions))
	for _, permission := range domain.AllPermissions {
		permissions[permission] = input[permission]
	}
	return permissions
}

func cloneServerRole(role domain.ServerRole) domain.ServerRole {
	role.Permissions = normalizedPermissions(role.Permissions)
	return role
}

func cloneChannelPermissionOverride(
	override domain.ChannelPermissionOverride,
) domain.ChannelPermissionOverride {
	override.Allows = normalizedPermissions(override.Allows)
	override.Denies = normalizedPermissions(override.Denies)
	return override
}

func cloneMember(member domain.Member) domain.Member {
	member.RoleIDs = append([]string(nil), member.RoleIDs...)
	return member
}

func overrideForTarget(
	overrides map[string]domain.ChannelPermissionOverride,
	targetType domain.ChannelPermissionOverrideTarget,
	targetID string,
) (domain.ChannelPermissionOverride, bool) {
	for _, override := range overrides {
		if override.TargetType == targetType && override.TargetID == targetID {
			return override, true
		}
	}
	return domain.ChannelPermissionOverride{}, false
}

func applyPermissionOverride(
	allowed bool,
	override domain.ChannelPermissionOverride,
	permission domain.Permission,
) bool {
	if override.Denies[permission] {
		return false
	}
	if override.Allows[permission] {
		return true
	}
	return allowed
}

func removeRoleID(roleIDs []string, removed string) []string {
	next := make([]string, 0, len(roleIDs))
	for _, roleID := range roleIDs {
		if roleID != removed {
			next = append(next, roleID)
		}
	}
	return next
}

func sortedStringKeys(items map[string]struct{}) []string {
	keys := make([]string, 0, len(items))
	for key := range items {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
