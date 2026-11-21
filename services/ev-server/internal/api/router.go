package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pion/turn/v4"

	"github.com/echovoice/echovoice/services/ev-server/internal/auth"
	"github.com/echovoice/echovoice/services/ev-server/internal/buildinfo"
	"github.com/echovoice/echovoice/services/ev-server/internal/config"
	"github.com/echovoice/echovoice/services/ev-server/internal/domain"
	"github.com/echovoice/echovoice/services/ev-server/internal/store"
	"github.com/echovoice/echovoice/services/ev-server/internal/ws"
)

var errUploadedFileTooLarge = errors.New("uploaded file exceeds size limit")
var errUnsupportedAssetType = errors.New("uploaded file type is not supported")

var emojiShortcodePattern = regexp.MustCompile(`^[a-z0-9_]{1,12}$`)
var messageEmojiPattern = regexp.MustCompile(`<:ev:([a-z0-9_]{1,12}):([a-fA-F0-9]{64}):([0-9]{1,10}):(png|gif|webp|jpg)>`)
var messageImagePattern = regexp.MustCompile(`<:image:([a-fA-F0-9]{64}):([0-9]{1,12}):(png|gif|webp|jpg|avif):([A-Za-z0-9_.!~*%()-]+)>`)
var languageIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
var avatarColorPattern = regexp.MustCompile(`^#[0-9a-f]{6}$`)
var memberMergeCodePattern = regexp.MustCompile(`^[0-9]{8}$`)

type Router struct {
	cfg                   config.Config
	store                 store.Store
	hub                   *ws.Hub
	sessions              *auth.SessionStore
	mux                   *http.ServeMux
	messageRateMu         sync.Mutex
	messageRecentSends    map[string][]time.Time
	soundboardRateMu      sync.Mutex
	soundboardLastPlayed  map[string]time.Time
	memberMergeMu         sync.Mutex
	memberMergeAttempts   map[string][]time.Time
	memberMergeGenerated  map[string]time.Time
	memberMergeResolveMu  sync.Mutex
	screenSignalMu        sync.Mutex
	screenSignals         map[string][]domain.RTCSignal
	screenViewerMu        sync.Mutex
	screenViewerSessions  map[string]screenShareViewerSession
	remoteControls        *remoteControlRegistry
	presenceMu            sync.Mutex
	presenceOfflineTimers map[string]*time.Timer
	presenceOfflineGrace  time.Duration
}

type serverSummaryResponse struct {
	domain.Server
	PublicServerVersion        string `json:"public_server_version"`
	ServerCompatibilityVersion string `json:"server_compatibility_version"`
	MinimumClientVersion       string `json:"minimum_client_version"`
}

type screenShareViewerSession struct {
	ServerID       string
	ShareID        string
	MemberID       string
	DeviceID       string
	WatchSessionID string
}

func screenShareViewerSessionKey(serverID string, shareID string, memberID string, deviceID string) string {
	return strings.Join([]string{serverID, shareID, memberID, deviceID}, "\x00")
}

const (
	maxMessageContentLength    = 4000
	maxMessageImagesPerMessage = 10
	maxMessageImageBytes       = 25 * 1024 * 1024
	maxProfileNameLength       = 64
	maxProfileBioLength        = 500
	maxServerDescriptionLength = 1000
	maxInlineImageLength       = 768 * 1024
	messageRateWindow          = 5 * time.Second
	maxMessagesPerRateWindow   = 5
	memberMergeCodeLifetime    = 10 * time.Minute
	memberMergeRequestLifetime = 24 * time.Hour
	memberMergeAttemptWindow   = 10 * time.Minute
	memberMergeGenerateDelay   = 5 * time.Second
	maxMemberMergeAttempts     = 5
)

func NewRouter(cfg config.Config, appStore store.Store, hub *ws.Hub, sessions *auth.SessionStore) http.Handler {
	disconnectGraceSeconds := cfg.Realtime.DisconnectGraceSeconds
	if disconnectGraceSeconds < 1 {
		disconnectGraceSeconds = 60
	}
	router := &Router{
		cfg:                   cfg,
		store:                 appStore,
		hub:                   hub,
		sessions:              sessions,
		mux:                   http.NewServeMux(),
		messageRecentSends:    make(map[string][]time.Time),
		soundboardLastPlayed:  make(map[string]time.Time),
		memberMergeAttempts:   make(map[string][]time.Time),
		memberMergeGenerated:  make(map[string]time.Time),
		screenSignals:         make(map[string][]domain.RTCSignal),
		screenViewerSessions:  make(map[string]screenShareViewerSession),
		remoteControls:        newRemoteControlRegistry(),
		presenceOfflineTimers: make(map[string]*time.Timer),
		presenceOfflineGrace:  time.Duration(disconnectGraceSeconds) * time.Second,
	}
	router.routes()
	return withCORS(router.mux)
}

func (r *Router) routes() {
	r.mux.HandleFunc("GET /healthz", r.health)
	r.mux.HandleFunc("POST /api/v1/connect", r.connect)
	r.mux.HandleFunc("POST /api/v1/session/refresh", r.refreshSession)
	r.mux.HandleFunc("GET /api/v1/profile", r.profile)
	r.mux.HandleFunc("PATCH /api/v1/profile", r.profile)
	r.mux.HandleFunc("POST /api/v1/profile/merge-code", r.generateMemberMergeCode)
	r.mux.HandleFunc("GET /api/v1/profile/merge-requests", r.memberMergeRequests)
	r.mux.HandleFunc("POST /api/v1/profile/merge-requests", r.memberMergeRequests)
	r.mux.HandleFunc("PATCH /api/v1/profile/merge-requests/", r.memberMergeRequestResource)
	r.mux.HandleFunc("DELETE /api/v1/membership", r.leaveMembership)
	r.mux.HandleFunc("GET /api/v1/events", r.events)
	r.mux.HandleFunc("GET /api/v1/server", r.getServer)
	r.mux.HandleFunc("GET /api/v1/rtc-config", r.rtcConfig)
	r.mux.HandleFunc("PATCH /api/v1/server", r.patchServer)
	r.mux.HandleFunc("GET /api/v1/audit-logs", r.auditLogs)
	r.mux.HandleFunc("GET /api/v1/audit/logs", r.auditLogs)
	r.mux.HandleFunc("GET /api/v1/invites", r.invites)
	r.mux.HandleFunc("POST /api/v1/invites", r.invites)
	r.mux.HandleFunc("DELETE /api/v1/invites/", r.inviteResource)
	r.mux.HandleFunc("POST /api/v1/assets", r.uploadContentAsset)
	r.mux.HandleFunc("GET /api/v1/assets/", r.contentAssetResource)
	r.mux.HandleFunc("HEAD /api/v1/assets/", r.contentAssetResource)
	r.mux.HandleFunc("GET /api/v1/soundboard", r.soundboardItems)
	r.mux.HandleFunc("POST /api/v1/soundboard", r.soundboardItems)
	r.mux.HandleFunc("POST /api/v1/soundboard/play", r.playSoundboard)
	r.mux.HandleFunc("PATCH /api/v1/soundboard/", r.soundboardItemResource)
	r.mux.HandleFunc("DELETE /api/v1/soundboard/", r.soundboardItemResource)
	r.mux.HandleFunc("GET /api/v1/emojis", r.customEmojiItems)
	r.mux.HandleFunc("POST /api/v1/emojis", r.customEmojiItems)
	r.mux.HandleFunc("PATCH /api/v1/emojis/", r.customEmojiResource)
	r.mux.HandleFunc("DELETE /api/v1/emojis/", r.customEmojiResource)
	r.mux.HandleFunc("GET /api/v1/members", r.members)
	r.mux.HandleFunc("GET /api/v1/members/", r.memberSubroutes)
	r.mux.HandleFunc("POST /api/v1/members/", r.memberSubroutes)
	r.mux.HandleFunc("PATCH /api/v1/members/", r.memberSubroutes)
	r.mux.HandleFunc("DELETE /api/v1/members/", r.memberSubroutes)
	r.mux.HandleFunc("GET /api/v1/roles", r.roles)
	r.mux.HandleFunc("POST /api/v1/roles", r.createRole)
	r.mux.HandleFunc("PUT /api/v1/roles/order", r.reorderRoles)
	r.mux.HandleFunc("PATCH /api/v1/roles/", r.roleSubroutes)
	r.mux.HandleFunc("DELETE /api/v1/roles/", r.roleSubroutes)
	r.mux.HandleFunc("GET /api/v1/voice-states", r.voiceStates)
	r.mux.HandleFunc("PATCH /api/v1/voice-states/", r.managedVoiceStateResource)
	r.mux.HandleFunc("DELETE /api/v1/voice-states/", r.managedVoiceStateResource)
	r.mux.HandleFunc("PATCH /api/v1/voice-state", r.voiceStateResource)
	r.mux.HandleFunc("DELETE /api/v1/voice-state", r.voiceStateResource)
	r.mux.HandleFunc("GET /api/v1/screen-shares", r.screenShareSessions)
	r.mux.HandleFunc("GET /api/v1/screen-shares/", r.screenShareResource)
	r.mux.HandleFunc("POST /api/v1/screen-shares/", r.screenShareResource)
	r.mux.HandleFunc("DELETE /api/v1/screen-shares/", r.screenShareResource)
	r.mux.HandleFunc("GET /api/v1/accompaniments", r.accompanimentSessions)
	r.mux.HandleFunc("DELETE /api/v1/accompaniments/", r.accompanimentResource)
	r.mux.HandleFunc("GET /api/v1/remote-controls", r.remoteControlSessions)
	r.mux.HandleFunc("PATCH /api/v1/remote-controls/", r.remoteControlResource)
	r.mux.HandleFunc("POST /api/v1/remote-controls/", r.remoteControlResource)
	r.mux.HandleFunc("GET /api/v1/channels", r.channels)
	r.mux.HandleFunc("POST /api/v1/channels", r.createChannel)
	r.mux.HandleFunc("PUT /api/v1/channels/order", r.reorderChannels)
	r.mux.HandleFunc("GET /api/v1/channels/", r.channelSubroutes)
	r.mux.HandleFunc("POST /api/v1/channels/", r.channelSubroutes)
	r.mux.HandleFunc("PATCH /api/v1/channels/", r.channelSubroutes)
	r.mux.HandleFunc("DELETE /api/v1/channels/", r.channelSubroutes)
}

func (r *Router) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (r *Router) connect(w http.ResponseWriter, req *http.Request) {
	var input domain.ConnectRequest
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}

	serverSettings := r.store.Server()
	requiresInvite := serverSettings.Visibility == "private" && len(r.store.Members()) > 0
	if requiresInvite {
		if strings.TrimSpace(input.InviteToken) == "" {
			writeError(w, http.StatusUnauthorized, "EV_INVITE_INVALID", "invite is invalid, expired, or exhausted")
			return
		}
	} else if r.cfg.Server.Password != "" && input.ServerPassword != r.cfg.Server.Password {
		writeError(w, http.StatusUnauthorized, "EV_AUTH_SERVER_PASSWORD_INVALID", "server password is invalid")
		return
	}

	if input.Profile.DisplayName == "" {
		input.Profile.DisplayName = "EchoVoice User"
	}
	input.Profile.DisplayName = strings.TrimSpace(input.Profile.DisplayName)
	input.Profile.Bio = strings.TrimSpace(input.Profile.Bio)
	input.Profile.AvatarColor = strings.ToLower(strings.TrimSpace(input.Profile.AvatarColor))
	if input.Profile.ProfileUpdatedAtMS <= 0 {
		input.Profile.ProfileUpdatedAtMS = time.Now().UnixMilli()
	}
	if len([]rune(input.Profile.DisplayName)) > maxProfileNameLength || len([]rune(input.Profile.Bio)) > maxProfileBioLength {
		writeError(w, http.StatusBadRequest, "EV_PROFILE_INVALID", "profile name or bio is too long")
		return
	}
	if !validInlineImage(input.Profile.AvatarDataURL) {
		writeError(w, http.StatusBadRequest, "EV_PROFILE_AVATAR_INVALID", "avatar must be a supported inline image")
		return
	}
	if !validAvatarColor(input.Profile.AvatarColor) {
		writeError(w, http.StatusBadRequest, "EV_PROFILE_AVATAR_COLOR_INVALID", "avatar color must use #RRGGBB format")
		return
	}
	if requiresInvite {
		if _, err := r.store.ConsumeInvite(strings.TrimSpace(input.InviteToken), time.Now().UnixMilli()); err != nil {
			writeError(w, http.StatusUnauthorized, "EV_INVITE_INVALID", "invite is invalid, expired, or exhausted")
			return
		}
	}

	member, accessKey, isOwner, err := r.store.UpsertMember(input.Profile)
	if errors.Is(err, store.ErrForbidden) {
		writeError(w, http.StatusForbidden, "EV_MEMBER_BANNED", "member is banned")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	serverID := r.store.Server().ServerID
	deviceID := strings.TrimSpace(input.Profile.LocalProfileID)
	if deviceID == "" {
		writeError(w, http.StatusBadRequest, "EV_DEVICE_ID_REQUIRED", "local profile id is required")
		return
	}
	sessionToken, err := r.sessions.Create(serverID, member.MemberID, deviceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	r.hub.Broadcast(ws.Event{Type: "member.joined", Payload: member})

	writeJSON(w, http.StatusOK, domain.ConnectResponse{
		ServerID:                   serverID,
		MemberID:                   member.MemberID,
		AccessKey:                  accessKey,
		SessionToken:               sessionToken,
		IsOwner:                    isOwner,
		PublicServerVersion:        buildinfo.PublicVersion(),
		ServerCompatibilityVersion: buildinfo.CompatibilityVersion,
		MinimumClientVersion:       buildinfo.MinimumClientVersion,
		ClientUpdateRequired:       buildinfo.IsVersionOlder(input.Profile.ClientVersion, buildinfo.MinimumClientVersion),
	})
}

func (r *Router) invites(w http.ResponseWriter, req *http.Request) {
	session, ok := r.requirePermission(w, req, domain.PermissionCreateInvites)
	if !ok {
		return
	}
	if req.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{"invites": nonNilSlice(r.store.Invites())})
		return
	}
	if req.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	var input struct {
		ExpiresInSeconds int64 `json:"expires_in_seconds"`
		MaxUses          int   `json:"max_uses"`
	}
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	if input.ExpiresInSeconds < 0 || input.ExpiresInSeconds > 365*24*60*60 {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "invite expiry must be between zero and one year")
		return
	}
	if input.MaxUses <= 0 || input.MaxUses > 1000 {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "invite max uses must be between 1 and 1000")
		return
	}
	inviteID, err := auth.NewToken("inv")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	token, err := auth.NewToken("invite")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	now := time.Now().UnixMilli()
	expiresAt := int64(0)
	if input.ExpiresInSeconds > 0 {
		expiresAt = now + input.ExpiresInSeconds*1000
	}
	invite, err := r.store.CreateInvite(domain.ServerInvite{
		InviteID:        inviteID,
		Token:           token,
		TokenHash:       auth.HashSecret(token),
		CreatorMemberID: session.MemberID,
		ExpiresAtMS:     expiresAt,
		MaxUses:         input.MaxUses,
		CreatedAtMS:     now,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	log.Printf("admin action=invite.create actor_member_id=%s invite_id=%s max_uses=%d expires_at=%d", session.MemberID, invite.InviteID, invite.MaxUses, invite.ExpiresAtMS)
	r.recordAudit(session.MemberID, "invite.create", "invite", invite.InviteID, map[string]string{
		"max_uses":      strconv.Itoa(invite.MaxUses),
		"expires_at_ms": strconv.FormatInt(invite.ExpiresAtMS, 10),
	})
	writeJSON(w, http.StatusCreated, invite)
}

func (r *Router) inviteResource(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	session, ok := r.requirePermission(w, req, domain.PermissionCreateInvites)
	if !ok {
		return
	}
	inviteID := strings.Trim(strings.TrimPrefix(req.URL.Path, "/api/v1/invites/"), "/")
	if inviteID == "" || strings.Contains(inviteID, "/") {
		writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "invite not found")
		return
	}
	invite, err := r.store.DeleteInvite(inviteID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "invite not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	log.Printf("admin action=invite.delete actor_member_id=%s invite_id=%s", session.MemberID, invite.InviteID)
	r.recordAudit(session.MemberID, "invite.delete", "invite", invite.InviteID, nil)
	writeJSON(w, http.StatusOK, invite)
}

func (r *Router) refreshSession(w http.ResponseWriter, req *http.Request) {
	var input domain.SessionRefreshRequest
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}

	member, ok := r.store.Authenticate(input.ServerID, input.MemberID, input.AccessKey)
	if !ok {
		writeError(w, http.StatusUnauthorized, "EV_AUTH_INVALID_KEY", "member key is invalid")
		return
	}
	deviceID := strings.TrimSpace(input.DeviceID)
	if deviceID == "" {
		deviceID = member.LocalProfileID
		if deviceID == "" {
			deviceID = "device-" + member.MemberID
		}
	}
	sessionToken, err := r.sessions.Create(input.ServerID, member.MemberID, deviceID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}

	writeJSON(w, http.StatusOK, domain.SessionRefreshResponse{
		ServerID:                   input.ServerID,
		MemberID:                   member.MemberID,
		SessionToken:               sessionToken,
		IsOwner:                    member.IsOwner,
		PublicServerVersion:        buildinfo.PublicVersion(),
		ServerCompatibilityVersion: buildinfo.CompatibilityVersion,
		MinimumClientVersion:       buildinfo.MinimumClientVersion,
		ClientUpdateRequired:       buildinfo.IsVersionOlder(input.ClientVersion, buildinfo.MinimumClientVersion),
	})
}

func (r *Router) profile(w http.ResponseWriter, req *http.Request) {
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	member, found := r.memberByID(session.MemberID)
	if !found {
		writeError(w, http.StatusNotFound, "EV_MEMBER_NOT_FOUND", "member not found")
		return
	}
	if req.Method == http.MethodGet {
		member.Online = r.hub.IsMemberOnline(session.ServerID, member.MemberID)
		writeJSON(w, http.StatusOK, member)
		return
	}
	var input struct {
		DisplayName      string                   `json:"display_name"`
		AvatarSHA256     string                   `json:"avatar_sha256"`
		AvatarDataURL    string                   `json:"avatar_data_url"`
		AvatarColor      *string                  `json:"avatar_color"`
		Bio              string                   `json:"bio"`
		Scope            string                   `json:"scope"`
		ProfileOverrides *domain.ProfileOverrides `json:"profile_overrides"`
	}
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	input.Bio = strings.TrimSpace(input.Bio)
	if input.DisplayName == "" || len([]rune(input.DisplayName)) > maxProfileNameLength {
		writeError(w, http.StatusBadRequest, "EV_PROFILE_NAME_INVALID", "display name must be between 1 and 64 characters")
		return
	}
	if len([]rune(input.Bio)) > maxProfileBioLength {
		writeError(w, http.StatusBadRequest, "EV_PROFILE_BIO_TOO_LONG", "profile bio exceeds 500 characters")
		return
	}
	if !validInlineImage(input.AvatarDataURL) {
		writeError(w, http.StatusBadRequest, "EV_PROFILE_AVATAR_INVALID", "avatar must be a supported inline image")
		return
	}
	avatarColor := member.AvatarColor
	if input.AvatarColor != nil {
		color := strings.ToLower(strings.TrimSpace(*input.AvatarColor))
		if !validAvatarColor(color) {
			writeError(w, http.StatusBadRequest, "EV_PROFILE_AVATAR_COLOR_INVALID", "avatar color must use #RRGGBB format")
			return
		}
		avatarColor = color
	}
	scope := strings.ToLower(strings.TrimSpace(input.Scope))
	if scope == "" {
		scope = "global"
	}
	if scope != "global" && scope != "server" {
		writeError(w, http.StatusBadRequest, "EV_PROFILE_SCOPE_INVALID", "profile scope must be global or server")
		return
	}
	if scope == "server" {
		if input.ProfileOverrides == nil {
			writeError(w, http.StatusBadRequest, "EV_PROFILE_OVERRIDES_REQUIRED", "server profile overrides are required")
			return
		}
		member.DisplayName = input.DisplayName
		member.AvatarSHA256 = strings.TrimSpace(input.AvatarSHA256)
		member.AvatarDataURL = input.AvatarDataURL
		member.AvatarColor = avatarColor
		member.Bio = input.Bio
		member.ProfileOverrides = *input.ProfileOverrides
	} else {
		if !member.ProfileOverrides.DisplayName {
			member.DisplayName = input.DisplayName
		}
		if !member.ProfileOverrides.Avatar {
			member.AvatarSHA256 = strings.TrimSpace(input.AvatarSHA256)
			member.AvatarDataURL = input.AvatarDataURL
			member.AvatarColor = avatarColor
		}
		if !member.ProfileOverrides.Bio {
			member.Bio = input.Bio
		}
	}
	member.ProfileUpdatedAtMS = time.Now().UnixMilli()
	updated, err := r.store.UpdateMember(member.MemberID, member)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	updated.Online = true
	action := "profile.update"
	if scope == "server" {
		action = "profile.server.update"
	}
	r.recordAudit(session.MemberID, action, "member", member.MemberID, map[string]string{"display_name": member.DisplayName})
	r.hub.Broadcast(ws.Event{Type: "member.updated", Payload: updated})
	writeJSON(w, http.StatusOK, updated)
}

func (r *Router) generateMemberMergeCode(w http.ResponseWriter, req *http.Request) {
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	if retryAfter, allowed := r.reserveMemberMergeCodeGeneration(session.ServerID, session.MemberID); !allowed {
		w.Header().Set("Retry-After", strconv.Itoa(int((retryAfter+time.Second-1)/time.Second)))
		writeError(w, http.StatusTooManyRequests, "EV_MEMBER_MERGE_CODE_RATE_LIMITED", "wait before generating another merge code")
		return
	}
	now := time.Now()
	for attempt := 0; attempt < 8; attempt++ {
		code, err := numericMemberMergeCode()
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		expiresAt := now.Add(memberMergeCodeLifetime).UnixMilli()
		err = r.store.SaveMemberMergeCode(domain.MemberMergeCode{
			TargetMemberID: session.MemberID,
			CodeHash:       auth.HashSecret(code),
			ExpiresAtMS:    expiresAt,
			CreatedAtMS:    now.UnixMilli(),
		})
		if errors.Is(err, store.ErrAlreadyExists) {
			continue
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"code": code, "expires_at_ms": expiresAt})
		return
	}
	writeError(w, http.StatusServiceUnavailable, "EV_MEMBER_MERGE_CODE_UNAVAILABLE", "could not allocate a merge code")
}

func (r *Router) memberMergeRequests(w http.ResponseWriter, req *http.Request) {
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	if req.Method == http.MethodGet {
		incoming := make([]domain.MemberMergeRequest, 0)
		outgoing := make([]domain.MemberMergeRequest, 0)
		for _, request := range r.store.MemberMergeRequests(session.MemberID, time.Now().UnixMilli()) {
			if request.TargetMemberID == session.MemberID {
				incoming = append(incoming, request)
			} else if request.RequesterMemberID == session.MemberID {
				outgoing = append(outgoing, request)
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"incoming": incoming, "outgoing": outgoing})
		return
	}
	if req.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	var input struct {
		Code string `json:"code"`
	}
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	input.Code = strings.TrimSpace(input.Code)
	if retryAfter, allowed := r.reserveMemberMergeCodeAttempt(session.ServerID, session.MemberID); !allowed {
		w.Header().Set("Retry-After", strconv.Itoa(int((retryAfter+time.Second-1)/time.Second)))
		writeError(w, http.StatusTooManyRequests, "EV_MEMBER_MERGE_RATE_LIMITED", "too many merge code attempts")
		return
	}
	if !memberMergeCodePattern.MatchString(input.Code) {
		writeError(w, http.StatusBadRequest, "EV_MEMBER_MERGE_CODE_INVALID", "merge code must contain exactly 8 digits")
		return
	}
	requestID, err := auth.NewToken("merge")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	now := time.Now()
	request, err := r.store.CreateMemberMergeRequestFromCode(domain.MemberMergeRequest{
		RequestID:         requestID,
		RequesterMemberID: session.MemberID,
		CreatedAtMS:       now.UnixMilli(),
		ExpiresAtMS:       now.Add(memberMergeRequestLifetime).UnixMilli(),
	}, auth.HashSecret(input.Code), now.UnixMilli())
	if errors.Is(err, store.ErrMemberMergeCodeInvalid) {
		writeError(w, http.StatusBadRequest, "EV_MEMBER_MERGE_CODE_INVALID", "merge code is invalid or expired")
		return
	}
	if errors.Is(err, store.ErrSameMember) {
		writeError(w, http.StatusBadRequest, "EV_MEMBER_MERGE_SAME", "an account cannot be merged into itself")
		return
	}
	if errors.Is(err, store.ErrAlreadyExists) {
		writeError(w, http.StatusConflict, "EV_MEMBER_MERGE_ALREADY_PENDING", "this account already has a pending merge request")
		return
	}
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_MEMBER_NOT_FOUND", "member not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	r.recordAudit(session.MemberID, "member.merge.request", "member", request.TargetMemberID, map[string]string{
		"request_id": request.RequestID,
	})
	r.hub.SendToMember(session.ServerID, request.TargetMemberID, ws.Event{
		Type:    "member.merge.requested",
		Payload: request,
	})
	writeJSON(w, http.StatusCreated, request)
}

func (r *Router) memberMergeRequestResource(w http.ResponseWriter, req *http.Request) {
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	requestID := strings.Trim(strings.TrimPrefix(req.URL.Path, "/api/v1/profile/merge-requests/"), "/")
	if requestID == "" || strings.Contains(requestID, "/") {
		writeError(w, http.StatusNotFound, "EV_MEMBER_MERGE_REQUEST_NOT_FOUND", "merge request not found")
		return
	}
	var input struct {
		Action string `json:"action"`
	}
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	input.Action = strings.ToLower(strings.TrimSpace(input.Action))
	if input.Action != "accept" && input.Action != "reject" {
		writeError(w, http.StatusBadRequest, "EV_MEMBER_MERGE_ACTION_INVALID", "merge action must be accept or reject")
		return
	}
	r.memberMergeResolveMu.Lock()
	defer r.memberMergeResolveMu.Unlock()
	now := time.Now().UnixMilli()
	request, err := r.store.MemberMergeRequest(requestID, now)
	if errors.Is(err, store.ErrMemberMergeRequestInvalid) {
		writeError(w, http.StatusNotFound, "EV_MEMBER_MERGE_REQUEST_NOT_FOUND", "merge request not found or expired")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	if request.TargetMemberID != session.MemberID {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "only the destination account can resolve this merge request")
		return
	}
	status := domain.MemberMergeRejected
	if input.Action == "accept" {
		status = domain.MemberMergeAccepted
	}
	if status == domain.MemberMergeRejected {
		resolved, resolveErr := r.store.ResolveMemberMergeRequest(request.RequestID, session.MemberID, status, now)
		if resolveErr != nil {
			writeError(w, http.StatusConflict, "EV_MEMBER_MERGE_REQUEST_INVALID", resolveErr.Error())
			return
		}
		r.recordAudit(session.MemberID, "member.merge.reject", "member", request.RequesterMemberID, map[string]string{
			"request_id": request.RequestID,
		})
		event := ws.Event{Type: "member.merge.resolved", Payload: resolved}
		r.hub.SendToMember(session.ServerID, request.TargetMemberID, event)
		r.hub.SendToMember(session.ServerID, request.RequesterMemberID, event)
		writeJSON(w, http.StatusOK, map[string]any{"request": resolved})
		return
	}
	r.disconnectMemberRealtime(request.TargetMemberID, session.MemberID, "member_self_merge")
	r.disconnectMemberRealtime(request.RequesterMemberID, session.MemberID, "member_self_merge")
	linked, removed, err := r.store.LinkMembers(request.TargetMemberID, request.RequesterMemberID)
	if errors.Is(err, store.ErrSameMember) || errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "EV_MEMBER_MERGE_REQUEST_INVALID", "one of the accounts can no longer be merged")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	resolved, resolveErr := r.store.ResolveMemberMergeRequest(request.RequestID, session.MemberID, status, now)
	if resolveErr != nil {
		log.Printf("member merge resolve warning request_id=%s error=%v", request.RequestID, resolveErr)
		resolved = request
		resolved.Status = status
		resolved.ResolvedAtMS = now
	}
	resolved.Requester = request.Requester
	resolved.Target = linked
	r.recordAudit(session.MemberID, "member.identity.self_merge", "member", linked.MemberID, map[string]string{
		"request_id":       request.RequestID,
		"merged_member_id": removed.MemberID,
		"linked_devices":   strconv.Itoa(linked.LinkedDevices),
	})
	r.hub.SendToMember(session.ServerID, removed.MemberID, ws.Event{
		Type:    "member.identity_linked",
		Payload: map[string]any{"member": linked, "previous_member_id": removed.MemberID},
	})
	resolvedEvent := ws.Event{Type: "member.merge.resolved", Payload: resolved}
	r.hub.SendToMember(session.ServerID, request.TargetMemberID, resolvedEvent)
	r.hub.SendToMember(session.ServerID, removed.MemberID, resolvedEvent)
	r.hub.Broadcast(ws.Event{Type: "member.left", Payload: removed})
	r.hub.Broadcast(ws.Event{Type: "member.updated", Payload: linked})
	r.sessions.RevokeMember(session.ServerID, removed.MemberID)
	writeJSON(w, http.StatusOK, map[string]any{"request": resolved, "member": linked})
}

func numericMemberMergeCode() (string, error) {
	value, err := rand.Int(rand.Reader, big.NewInt(100000000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%08d", value.Int64()), nil
}

func (r *Router) reserveMemberMergeCodeGeneration(serverID string, memberID string) (time.Duration, bool) {
	key := serverID + "\x00" + memberID
	now := time.Now()
	r.memberMergeMu.Lock()
	defer r.memberMergeMu.Unlock()
	if last := r.memberMergeGenerated[key]; !last.IsZero() {
		remaining := memberMergeGenerateDelay - now.Sub(last)
		if remaining > 0 {
			return remaining, false
		}
	}
	r.memberMergeGenerated[key] = now
	return 0, true
}

func (r *Router) reserveMemberMergeCodeAttempt(serverID string, memberID string) (time.Duration, bool) {
	key := serverID + "\x00" + memberID
	now := time.Now()
	cutoff := now.Add(-memberMergeAttemptWindow)
	r.memberMergeMu.Lock()
	defer r.memberMergeMu.Unlock()
	recent := r.memberMergeAttempts[key][:0]
	for _, attempt := range r.memberMergeAttempts[key] {
		if attempt.After(cutoff) {
			recent = append(recent, attempt)
		}
	}
	if len(recent) >= maxMemberMergeAttempts {
		r.memberMergeAttempts[key] = recent
		return memberMergeAttemptWindow - now.Sub(recent[0]), false
	}
	r.memberMergeAttempts[key] = append(recent, now)
	return 0, true
}

func (r *Router) leaveMembership(w http.ResponseWriter, req *http.Request) {
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	member, found := r.memberByID(session.MemberID)
	if !found {
		writeError(w, http.StatusNotFound, "EV_MEMBER_NOT_FOUND", "member not found")
		return
	}
	if member.IsOwner && len(r.store.Members()) > 1 {
		writeError(w, http.StatusConflict, "EV_OWNER_TRANSFER_REQUIRED", "transfer server ownership before leaving")
		return
	}
	r.disconnectMemberRealtime(member.MemberID, member.MemberID, "member_left_server")
	removed, err := r.store.RemoveMember(member.MemberID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	r.recordAudit(member.MemberID, "member.leave", "member", member.MemberID, map[string]string{"display_name": member.DisplayName})
	r.hub.Broadcast(ws.Event{Type: "member.left", Payload: removed})
	r.sessions.RevokeMember(session.ServerID, member.MemberID)
	writeJSON(w, http.StatusOK, removed)
}

func (r *Router) linkMemberIdentity(w http.ResponseWriter, req *http.Request, primaryMemberID string) {
	session, ok := r.requirePermission(w, req, domain.PermissionManageMembers)
	if !ok {
		return
	}
	var input struct {
		DuplicateMemberID string `json:"duplicate_member_id"`
	}
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	input.DuplicateMemberID = strings.TrimSpace(input.DuplicateMemberID)
	primary, primaryFound := r.memberByID(primaryMemberID)
	duplicate, duplicateFound := r.memberByID(input.DuplicateMemberID)
	if !primaryFound || !duplicateFound {
		writeError(w, http.StatusNotFound, "EV_MEMBER_NOT_FOUND", "member not found")
		return
	}
	actor, actorFound := r.memberByID(session.MemberID)
	if !actorFound || (!actor.IsOwner && (!r.actorCanManageMember(session.MemberID, primary) || !r.actorCanManageMember(session.MemberID, duplicate))) {
		writeError(w, http.StatusForbidden, "EV_ROLE_HIERARCHY_DENIED", "both members must be below your highest role")
		return
	}
	r.disconnectMemberRealtime(primary.MemberID, session.MemberID, "member_identity_linked")
	r.disconnectMemberRealtime(duplicate.MemberID, session.MemberID, "member_identity_linked")
	linked, removed, err := r.store.LinkMembers(primary.MemberID, duplicate.MemberID)
	if errors.Is(err, store.ErrSameMember) {
		writeError(w, http.StatusBadRequest, "EV_MEMBER_LINK_SAME", "members must be different")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	r.recordAudit(session.MemberID, "member.identity.link", "member", linked.MemberID, map[string]string{
		"duplicate_member_id": removed.MemberID,
		"linked_devices":      strconv.Itoa(linked.LinkedDevices),
	})
	r.hub.SendToMember(session.ServerID, removed.MemberID, ws.Event{
		Type:    "member.identity_linked",
		Payload: map[string]any{"member": linked, "previous_member_id": removed.MemberID},
	})
	r.hub.Broadcast(ws.Event{Type: "member.left", Payload: removed})
	r.hub.Broadcast(ws.Event{Type: "member.updated", Payload: linked})
	r.sessions.RevokeMember(session.ServerID, removed.MemberID)
	writeJSON(w, http.StatusOK, linked)
}

func (r *Router) events(w http.ResponseWriter, req *http.Request) {
	session, ok := r.authenticate(req)
	if !ok {
		writeError(w, http.StatusUnauthorized, "EV_AUTH_SESSION_INVALID", "session token is invalid")
		return
	}
	r.hub.ServeHTTP(w, req, ws.ClientIdentity{
		ServerID:     session.ServerID,
		MemberID:     session.MemberID,
		DeviceID:     session.DeviceID,
		SessionToken: auth.SessionTokenFromRequest(req),
	}, r.handleClientEvent, r.handlePresence, r.handleSessionKeepAlive)
}

func (r *Router) getServer(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, serverSummaryResponse{
		Server:                     r.store.Server(),
		PublicServerVersion:        buildinfo.PublicVersion(),
		ServerCompatibilityVersion: buildinfo.CompatibilityVersion,
		MinimumClientVersion:       buildinfo.MinimumClientVersion,
	})
}

func (r *Router) rtcConfig(w http.ResponseWriter, req *http.Request) {
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	iceServers := make([]domain.RTCIceServer, 0, len(r.cfg.RTC.STUNURLs)+1)
	for _, rawURL := range r.cfg.RTC.STUNURLs {
		if value := strings.TrimSpace(rawURL); value != "" {
			iceServers = append(iceServers, domain.RTCIceServer{URLs: []string{value}})
		}
	}
	if r.cfg.RTC.TURN.Enabled {
		username, credential, err := turn.GenerateLongTermTURNRESTCredentials(
			r.cfg.RTC.TURN.AuthSecret,
			session.MemberID+"."+shortLogID(session.DeviceID),
			2*time.Hour,
		)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_RTC_CONFIG_FAILED", err.Error())
			return
		}
		hostPort := net.JoinHostPort(r.cfg.TURNPublicHost(), strconv.Itoa(r.cfg.RTC.TURN.Port))
		urls := []string{"stun:" + hostPort, "turn:" + hostPort + "?transport=udp"}
		if r.cfg.RTC.TURN.TCPEnabled {
			urls = append(urls, "turn:"+hostPort+"?transport=tcp")
		}
		iceServers = append(iceServers, domain.RTCIceServer{
			URLs:       urls,
			Username:   username,
			Credential: credential,
		})
	}
	writeJSON(w, http.StatusOK, domain.RTCConfig{IceServers: iceServers})
}

func (r *Router) patchServer(w http.ResponseWriter, req *http.Request) {
	session, ok := r.requirePermission(w, req, domain.PermissionEditServer)
	if !ok {
		return
	}
	var input domain.Server
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Description = strings.TrimSpace(input.Description)
	currentServer := r.store.Server()
	input.Visibility = strings.TrimSpace(input.Visibility)
	if input.Visibility == "" {
		input.Visibility = currentServer.Visibility
	}
	input.DefaultLanguage = strings.TrimSpace(input.DefaultLanguage)
	if input.DefaultLanguage == "" {
		input.DefaultLanguage = currentServer.DefaultLanguage
	}
	if input.Name == "" || len([]rune(input.Name)) > 100 {
		writeError(w, http.StatusBadRequest, "EV_SERVER_NAME_INVALID", "server name must be between 1 and 100 characters")
		return
	}
	if len([]rune(input.Description)) > maxServerDescriptionLength {
		writeError(w, http.StatusBadRequest, "EV_SERVER_DESCRIPTION_TOO_LONG", "server description exceeds 1000 characters")
		return
	}
	if !validInlineImage(input.IconDataURL) {
		writeError(w, http.StatusBadRequest, "EV_SERVER_ICON_INVALID", "server icon must be a supported inline image")
		return
	}
	if (input.Visibility != "public" && input.Visibility != "private") || !validLanguageID(input.DefaultLanguage, false) {
		writeError(w, http.StatusBadRequest, "EV_SERVER_SETTINGS_INVALID", "server visibility or default language is invalid")
		return
	}
	remoteControlWasEnabled := r.store.Server().RemoteControlEnabled
	server := r.store.UpdateServer(input)
	if remoteControlWasEnabled && !server.RemoteControlEnabled {
		r.endAllRemoteControls(session.MemberID, "service_disabled")
	}
	log.Printf("admin action=server.update actor_member_id=%s server_id=%s name=%q", session.MemberID, server.ServerID, server.Name)
	r.recordAudit(session.MemberID, "server.update", "server", server.ServerID, map[string]string{"name": server.Name})
	r.hub.Broadcast(ws.Event{Type: "server.updated", Payload: server})
	writeJSON(w, http.StatusOK, server)
}

func (r *Router) auditLogs(w http.ResponseWriter, req *http.Request) {
	if _, ok := r.requirePermission(w, req, domain.PermissionEditServer); !ok {
		return
	}
	action := strings.TrimSpace(req.URL.Query().Get("action"))
	limit, _ := strconv.Atoi(req.URL.Query().Get("limit"))
	writeJSON(w, http.StatusOK, map[string]any{"audit_logs": nonNilSlice(r.store.AuditLogs(action, limit))})
}

func (r *Router) members(w http.ResponseWriter, req *http.Request) {
	if _, ok := r.requirePermission(w, req, domain.PermissionViewMembers); !ok {
		return
	}
	members := r.store.Members()
	serverID := r.store.Server().ServerID
	for index := range members {
		members[index].Online = r.hub.IsMemberOnline(serverID, members[index].MemberID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"members": nonNilSlice(members)})
}

func (r *Router) memberSubroutes(w http.ResponseWriter, req *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(req.URL.Path, "/api/v1/members/"), "/"), "/")
	if len(parts) == 2 && parts[0] != "" && parts[1] == "voice-duration" {
		if req.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
			return
		}
		r.memberVoiceDuration(w, req, parts[0])
		return
	}
	if len(parts) == 1 && parts[0] != "" {
		r.memberResource(w, req, parts[0])
		return
	}
	if len(parts) == 2 && parts[0] != "" && parts[1] == "link" {
		if req.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
			return
		}
		r.linkMemberIdentity(w, req, parts[0])
		return
	}
	if len(parts) != 2 || parts[0] == "" || parts[1] != "roles" {
		writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "route not found")
		return
	}
	if req.Method != http.MethodPatch {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	r.memberRolesResource(w, req, parts[0])
}

func (r *Router) memberVoiceDuration(w http.ResponseWriter, req *http.Request, memberID string) {
	session, ok := r.requirePermission(w, req, domain.PermissionViewMembers)
	if !ok {
		return
	}
	if _, found := r.memberByID(memberID); !found {
		writeError(w, http.StatusNotFound, "EV_MEMBER_NOT_FOUND", "member not found")
		return
	}
	stats, err := r.store.VoiceDurationStats(memberID, session.MemberID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_MEMBER_NOT_FOUND", "member not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, stats)
}

func (r *Router) memberResource(w http.ResponseWriter, req *http.Request, memberID string) {
	session, ok := r.requirePermission(w, req, domain.PermissionManageMembers)
	if !ok {
		return
	}
	target, found := r.memberByID(memberID)
	if !found {
		writeError(w, http.StatusNotFound, "EV_MEMBER_NOT_FOUND", "member not found")
		return
	}
	if !r.actorCanManageMember(session.MemberID, target) {
		writeError(w, http.StatusForbidden, "EV_ROLE_HIERARCHY_DENIED", "target member is above your highest role")
		return
	}

	switch req.Method {
	case http.MethodPatch:
		var input struct {
			IsBanned bool `json:"is_banned"`
		}
		if err := readJSON(req, &input); err != nil {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
			return
		}
		target.IsBanned = input.IsBanned
		if target.MemberID == session.MemberID && target.IsBanned {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "you cannot ban yourself")
			return
		}
		member, err := r.store.UpdateMember(memberID, target)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_MEMBER_NOT_FOUND", "member not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		log.Printf("admin action=member.update actor_member_id=%s target_member_id=%s banned=%t", session.MemberID, member.MemberID, member.IsBanned)
		r.recordAudit(session.MemberID, "member.update", "member", member.MemberID, map[string]string{
			"is_banned": strconv.FormatBool(member.IsBanned),
		})
		if member.IsBanned {
			r.disconnectMemberRealtime(member.MemberID, session.MemberID, "member_banned")
			r.sessions.RevokeMember(session.ServerID, member.MemberID)
			r.hub.DisconnectMember(session.ServerID, member.MemberID)
		}
		r.hub.Broadcast(ws.Event{Type: "member.updated", Payload: member})
		writeJSON(w, http.StatusOK, member)
	case http.MethodDelete:
		if memberID == session.MemberID {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "you cannot remove yourself")
			return
		}
		r.disconnectMemberRealtime(memberID, session.MemberID, "member_removed")
		member, err := r.store.RemoveMember(memberID)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_MEMBER_NOT_FOUND", "member not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		log.Printf("admin action=member.remove actor_member_id=%s target_member_id=%s", session.MemberID, member.MemberID)
		r.recordAudit(session.MemberID, "member.remove", "member", member.MemberID, map[string]string{"display_name": member.DisplayName})
		r.hub.Broadcast(ws.Event{Type: "member.left", Payload: member})
		r.sessions.RevokeMember(session.ServerID, member.MemberID)
		r.hub.DisconnectMember(session.ServerID, member.MemberID)
		writeJSON(w, http.StatusOK, member)
	default:
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
	}
}

func (r *Router) memberRolesResource(w http.ResponseWriter, req *http.Request, memberID string) {
	session, ok := r.requirePermission(w, req, domain.PermissionManageRoles)
	if !ok {
		return
	}
	var input struct {
		RoleIDs []string `json:"role_ids"`
	}
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	target, found := r.memberByID(memberID)
	if !found {
		writeError(w, http.StatusNotFound, "EV_MEMBER_NOT_FOUND", "member not found")
		return
	}
	if !r.actorCanManageMember(session.MemberID, target) {
		writeError(w, http.StatusForbidden, "EV_ROLE_HIERARCHY_DENIED", "target member is above your highest role")
		return
	}
	if !r.actorCanAssignRoles(session.MemberID, input.RoleIDs) {
		writeError(w, http.StatusForbidden, "EV_ROLE_HIERARCHY_DENIED", "one or more roles are above your highest role")
		return
	}
	member, err := r.store.SetMemberRoles(memberID, input.RoleIDs)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_MEMBER_NOT_FOUND", "member not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	log.Printf("admin action=member.roles.update actor_member_id=%s target_member_id=%s role_ids=%v", session.MemberID, member.MemberID, member.RoleIDs)
	r.recordAudit(session.MemberID, "member.roles.update", "member", member.MemberID, map[string]string{"role_ids": strings.Join(member.RoleIDs, ",")})
	r.hub.Broadcast(ws.Event{Type: "member.updated", Payload: member})
	r.broadcastVisibleChannels()
	writeJSON(w, http.StatusOK, member)
}

func (r *Router) roles(w http.ResponseWriter, req *http.Request) {
	if _, ok := r.requireSession(w, req); !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": nonNilSlice(r.store.Roles())})
}

func (r *Router) reorderRoles(w http.ResponseWriter, req *http.Request) {
	session, ok := r.requirePermission(w, req, domain.PermissionManageRoles)
	if !ok {
		return
	}
	var input struct {
		Items []domain.RoleOrderItem `json:"items"`
	}
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	for _, item := range input.Items {
		if !r.actorCanManageRole(session.MemberID, item.RoleID) {
			writeError(w, http.StatusForbidden, "EV_ROLE_HIERARCHY_DENIED", "one or more roles are above your highest role")
			return
		}
	}
	roles, err := r.store.ReorderRoles(input.Items)
	if errors.Is(err, store.ErrInvalidRoleOrder) {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "role order is invalid")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	r.recordAudit(session.MemberID, "role.reorder", "role", "", map[string]string{"role_count": strconv.Itoa(len(input.Items))})
	r.hub.Broadcast(ws.Event{Type: "roles.reordered", Payload: map[string]any{"roles": roles}})
	writeJSON(w, http.StatusOK, map[string]any{"roles": roles})
}

func (r *Router) createRole(w http.ResponseWriter, req *http.Request) {
	session, ok := r.requirePermission(w, req, domain.PermissionManageRoles)
	if !ok {
		return
	}
	var input domain.ServerRole
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "role name is required")
		return
	}
	if len([]rune(input.Name)) > 100 || !validInlineImage(input.IconDataURL) {
		writeError(w, http.StatusBadRequest, "EV_ROLE_INVALID", "role name or icon is invalid")
		return
	}
	if !r.actorCanCreateRole(session.MemberID, &input) {
		writeError(w, http.StatusForbidden, "EV_ROLE_HIERARCHY_DENIED", "new role must be below your highest role")
		return
	}
	role, err := r.store.CreateRole(input)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	log.Printf("admin action=role.create actor_member_id=%s role_id=%s name=%q", session.MemberID, role.RoleID, role.Name)
	r.recordAudit(session.MemberID, "role.create", "role", role.RoleID, map[string]string{"name": role.Name})
	r.hub.Broadcast(ws.Event{Type: "role.created", Payload: role})
	writeJSON(w, http.StatusCreated, role)
}

func (r *Router) roleSubroutes(w http.ResponseWriter, req *http.Request) {
	roleID := strings.Trim(strings.TrimPrefix(req.URL.Path, "/api/v1/roles/"), "/")
	if roleID == "" || strings.Contains(roleID, "/") {
		writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "route not found")
		return
	}
	switch req.Method {
	case http.MethodPatch:
		r.roleResource(w, req, roleID)
	case http.MethodDelete:
		r.deleteRole(w, req, roleID)
	default:
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
	}
}

func (r *Router) roleResource(w http.ResponseWriter, req *http.Request, roleID string) {
	session, ok := r.requirePermission(w, req, domain.PermissionManageRoles)
	if !ok {
		return
	}
	var input domain.ServerRole
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if len([]rune(input.Name)) > 100 || !validInlineImage(input.IconDataURL) {
		writeError(w, http.StatusBadRequest, "EV_ROLE_INVALID", "role name or icon is invalid")
		return
	}
	if !r.actorCanManageRole(session.MemberID, roleID) {
		writeError(w, http.StatusForbidden, "EV_ROLE_HIERARCHY_DENIED", "role is above your highest role")
		return
	}
	if !r.actorCanPlaceRole(session.MemberID, input.Position) {
		writeError(w, http.StatusForbidden, "EV_ROLE_HIERARCHY_DENIED", "role position must be below your highest role")
		return
	}
	role, err := r.store.UpdateRole(roleID, input)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_ROLE_NOT_FOUND", "role not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	log.Printf("admin action=role.update actor_member_id=%s role_id=%s name=%q", session.MemberID, role.RoleID, role.Name)
	r.recordAudit(session.MemberID, "role.update", "role", role.RoleID, map[string]string{"name": role.Name})
	r.hub.Broadcast(ws.Event{Type: "role.updated", Payload: role})
	r.broadcastVisibleChannels()
	writeJSON(w, http.StatusOK, role)
}

func (r *Router) deleteRole(w http.ResponseWriter, req *http.Request, roleID string) {
	session, ok := r.requirePermission(w, req, domain.PermissionManageRoles)
	if !ok {
		return
	}
	if !r.actorCanManageRole(session.MemberID, roleID) {
		writeError(w, http.StatusForbidden, "EV_ROLE_HIERARCHY_DENIED", "role is above your highest role")
		return
	}
	role, err := r.store.DeleteRole(roleID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_ROLE_NOT_FOUND", "role not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	log.Printf("admin action=role.delete actor_member_id=%s role_id=%s name=%q", session.MemberID, role.RoleID, role.Name)
	r.recordAudit(session.MemberID, "role.delete", "role", role.RoleID, map[string]string{"name": role.Name})
	r.hub.Broadcast(ws.Event{Type: "role.deleted", Payload: role})
	r.broadcastVisibleChannels()
	writeJSON(w, http.StatusOK, role)
}

func (r *Router) channels(w http.ResponseWriter, req *http.Request) {
	session, ok := r.requirePermission(w, req, domain.PermissionViewChannels)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": nonNilSlice(r.visibleChannels(session.MemberID))})
}

func (r *Router) reorderChannels(w http.ResponseWriter, req *http.Request) {
	session, ok := r.requirePermission(w, req, domain.PermissionManageChannels)
	if !ok {
		return
	}

	var input struct {
		Items []domain.ChannelOrderItem `json:"items"`
	}
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	for index := range input.Items {
		input.Items[index].ChannelID = strings.TrimSpace(input.Items[index].ChannelID)
		input.Items[index].ParentID = strings.TrimSpace(input.Items[index].ParentID)
	}

	channels, err := r.store.ReorderChannels(input.Items)
	if errors.Is(err, store.ErrInvalidChannelOrder) {
		log.Printf("admin action=channel.reorder.failed actor_member_id=%s reason=invalid_order item_count=%d", session.MemberID, len(input.Items))
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "channel order is invalid")
		return
	}
	if err != nil {
		log.Printf("admin action=channel.reorder.failed actor_member_id=%s reason=internal error=%q", session.MemberID, err.Error())
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}

	log.Printf("admin action=channel.reorder actor_member_id=%s channel_count=%d", session.MemberID, len(channels))
	r.recordAudit(session.MemberID, "channel.reorder", "channel", "", map[string]string{"channel_count": strconv.Itoa(len(channels))})
	payload := map[string]any{"channels": channels}
	r.broadcastVisibleChannels()
	writeJSON(w, http.StatusOK, payload)
}

func (r *Router) createChannel(w http.ResponseWriter, req *http.Request) {
	session, ok := r.requirePermission(w, req, domain.PermissionManageChannels)
	if !ok {
		return
	}
	var input domain.Channel
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	if input.Type == "" {
		input.Type = domain.ChannelTypeText
	}
	if !validChannelType(input.Type) {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "channel type is invalid")
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if input.Name == "" {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "channel name is required")
		return
	}
	input.DefaultLanguage = strings.TrimSpace(input.DefaultLanguage)
	if !validLanguageID(input.DefaultLanguage, true) || !validChannelLocalizations(input.Localizations) {
		writeError(w, http.StatusBadRequest, "EV_CHANNEL_LOCALIZATION_INVALID", "channel language settings are invalid")
		return
	}
	if input.Type == domain.ChannelTypeCategory {
		input.ParentID = ""
		input.Topic = ""
		input.Visibility = "default"
		input.WarningText = ""
		input.Bitrate = 0
		input.UserLimit = 0
		input.PermissionSynced = false
	} else {
		input.ParentID = strings.TrimSpace(input.ParentID)
		if input.ParentID != "" && !r.validCategoryParent("", input.ParentID) {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "channel parent is invalid")
			return
		}
	}
	if input.Visibility == "" {
		input.Visibility = "default"
	}
	if !validChannelVisibility(input.Visibility) {
		writeError(w, http.StatusBadRequest, "EV_CHANNEL_VISIBILITY_INVALID", "channel visibility is invalid")
		return
	}
	input.WarningText = strings.TrimSpace(input.WarningText)
	if input.Visibility == "warning" && input.WarningText == "" {
		writeError(w, http.StatusBadRequest, "EV_CHANNEL_WARNING_REQUIRED", "warning channels require warning text")
		return
	}
	if input.Bitrate < 0 || input.Bitrate > 512000 || input.UserLimit < 0 || input.UserLimit > 1000 {
		writeError(w, http.StatusBadRequest, "EV_CHANNEL_VOICE_SETTINGS_INVALID", "voice bitrate or user limit is invalid")
		return
	}
	channel, err := r.store.CreateChannel(input)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	log.Printf("admin action=channel.create actor_member_id=%s channel_id=%s type=%s name=%q", session.MemberID, channel.ChannelID, channel.Type, channel.Name)
	r.recordAudit(session.MemberID, "channel.create", "channel", channel.ChannelID, map[string]string{
		"name":      channel.Name,
		"type":      string(channel.Type),
		"parent_id": channel.ParentID,
	})
	r.broadcastVisibleChannels()
	writeJSON(w, http.StatusCreated, channel)
}

func (r *Router) channelSubroutes(w http.ResponseWriter, req *http.Request) {
	path := strings.TrimPrefix(req.URL.Path, "/api/v1/channels/")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) == 1 && parts[0] != "" {
		r.channelResource(w, req, parts[0])
		return
	}
	if len(parts) < 2 || len(parts) > 4 {
		writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "route not found")
		return
	}

	channelID := parts[0]
	switch parts[1] {
	case "messages":
		if len(parts) == 2 {
			r.channelMessages(w, req, channelID)
			return
		}
		if len(parts) == 4 {
			if parts[3] == "context" {
				r.channelMessageContext(w, req, channelID, parts[2])
				return
			}
			writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "route not found")
			return
		}
		r.channelMessageResource(w, req, channelID, parts[2])
	case "permission-overrides":
		if len(parts) == 2 {
			r.channelPermissionOverrides(w, req, channelID)
			return
		}
		r.channelPermissionOverrideResource(w, req, channelID, parts[2])
	case "accessible-members":
		if len(parts) != 2 {
			writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "route not found")
			return
		}
		r.channelAccessibleMembers(w, req, channelID)
	case "files":
		if len(parts) == 2 {
			r.channelFiles(w, req, channelID)
			return
		}
		r.channelFileResource(w, req, channelID, parts[2])
	case "message-images":
		if len(parts) == 2 {
			r.channelMessageImages(w, req, channelID)
			return
		}
		if len(parts) == 3 {
			r.channelMessageImageResource(w, req, channelID, parts[2])
			return
		}
		writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "route not found")
	case "voice-state":
		if len(parts) != 2 {
			writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "route not found")
			return
		}
		r.joinVoiceChannel(w, req, channelID)
	case "screen-share":
		if len(parts) != 2 {
			writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "route not found")
			return
		}
		r.startScreenShareSession(w, req, channelID)
	case "accompaniment":
		if len(parts) != 2 {
			writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "route not found")
			return
		}
		r.startAccompanimentSession(w, req, channelID)
	default:
		writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "route not found")
	}
}

func (r *Router) channelAccessibleMembers(w http.ResponseWriter, req *http.Request, channelID string) {
	if req.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	if _, ok := r.requirePermission(w, req, domain.PermissionViewMembers); !ok {
		return
	}
	if _, ok := r.requireChannelPermission(w, req, channelID, domain.PermissionViewChannels); !ok {
		return
	}
	memberIDs := make([]string, 0)
	for _, member := range r.store.Members() {
		if r.store.MemberHasChannelPermission(member.MemberID, channelID, domain.PermissionViewChannels) {
			memberIDs = append(memberIDs, member.MemberID)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"member_ids": memberIDs})
}

func (r *Router) channelMessages(w http.ResponseWriter, req *http.Request, channelID string) {
	switch req.Method {
	case http.MethodGet:
		if _, ok := r.requireChannelPermission(w, req, channelID, domain.PermissionViewChannels); !ok {
			return
		}
		if _, ok := r.requireChannelPermission(w, req, channelID, domain.PermissionReadMessageHistory); !ok {
			return
		}
		query := strings.TrimSpace(req.URL.Query().Get("q"))
		if query == "" {
			query = strings.TrimSpace(req.URL.Query().Get("search"))
		}
		beforeMS, _ := strconv.ParseInt(req.URL.Query().Get("before_ms"), 10, 64)
		limit, _ := strconv.Atoi(req.URL.Query().Get("limit"))
		if query != "" {
			writeJSON(w, http.StatusOK, map[string]any{"messages": nonNilSlice(r.store.SearchMessages(channelID, query, limit))})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"messages": nonNilSlice(r.store.Messages(channelID, beforeMS, limit))})
	case http.MethodPost:
		session, ok := r.requireChannelPermission(w, req, channelID, domain.PermissionSendMessages)
		if !ok {
			return
		}
		var input struct {
			AuthorID         string `json:"author_id"`
			Content          string `json:"content"`
			ReplyToMessageID string `json:"reply_to_message_id"`
		}
		if err := readJSON(req, &input); err != nil {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
			return
		}
		content := strings.TrimSpace(input.Content)
		if content == "" {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "message content is required")
			return
		}
		if len([]rune(content)) > maxMessageContentLength {
			writeError(w, http.StatusRequestEntityTooLarge, "EV_MESSAGE_TOO_LONG", "message content exceeds length limit")
			return
		}
		if !r.validateMessageEmojis(w, session.MemberID, channelID, content) {
			return
		}
		if !r.validateMessageImages(w, channelID, content) {
			return
		}
		if !r.allowMessageSend(session.MemberID) {
			writeError(w, http.StatusTooManyRequests, "EV_MESSAGE_RATE_LIMITED", "messages are being sent too quickly")
			return
		}
		message, err := r.store.CreateMessage(channelID, session.MemberID, content, input.ReplyToMessageID)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_MESSAGE_REPLY_NOT_FOUND", "channel or reply message not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		r.broadcastChannelEvent(channelID, "message.created", message)
		writeJSON(w, http.StatusCreated, message)
	default:
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
	}
}

func (r *Router) channelMessageResource(w http.ResponseWriter, req *http.Request, channelID string, messageID string) {
	session, ok := r.requireChannelPermission(w, req, channelID, domain.PermissionViewChannels)
	if !ok {
		return
	}
	canManage := r.store.MemberHasChannelPermission(session.MemberID, channelID, domain.PermissionManageMessages)
	switch req.Method {
	case http.MethodGet:
		message, err := r.store.Message(channelID, messageID)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_MESSAGE_NOT_FOUND", "message not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, message)
	case http.MethodPatch:
		if !r.store.MemberHasChannelPermission(session.MemberID, channelID, domain.PermissionSendMessages) {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission send_messages is required")
			return
		}
		var input struct {
			Content string `json:"content"`
		}
		if err := readJSON(req, &input); err != nil {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
			return
		}
		input.Content = strings.TrimSpace(input.Content)
		if input.Content == "" {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "message content is required")
			return
		}
		if len([]rune(input.Content)) > maxMessageContentLength {
			writeError(w, http.StatusRequestEntityTooLarge, "EV_MESSAGE_TOO_LONG", "message content exceeds length limit")
			return
		}
		if !r.validateMessageEmojis(w, session.MemberID, channelID, input.Content) {
			return
		}
		if !r.validateMessageImages(w, channelID, input.Content) {
			return
		}
		message, err := r.store.UpdateMessage(channelID, messageID, session.MemberID, input.Content)
		if errors.Is(err, store.ErrForbidden) {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "message cannot be edited")
			return
		}
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_MESSAGE_NOT_FOUND", "message not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		r.broadcastChannelEvent(channelID, "message.updated", message)
		writeJSON(w, http.StatusOK, message)
	case http.MethodDelete:
		message, err := r.store.DeleteMessage(channelID, messageID, session.MemberID, canManage)
		if errors.Is(err, store.ErrForbidden) {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "message cannot be deleted")
			return
		}
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_MESSAGE_NOT_FOUND", "message not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		r.broadcastChannelEvent(channelID, "message.deleted", message)
		writeJSON(w, http.StatusOK, message)
	default:
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
	}
}

func (r *Router) channelMessageContext(w http.ResponseWriter, req *http.Request, channelID string, messageID string) {
	if req.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	if _, ok := r.requireChannelPermission(w, req, channelID, domain.PermissionViewChannels); !ok {
		return
	}
	if _, ok := r.requireChannelPermission(w, req, channelID, domain.PermissionReadMessageHistory); !ok {
		return
	}
	beforeLimit, _ := strconv.Atoi(req.URL.Query().Get("before"))
	afterLimit, _ := strconv.Atoi(req.URL.Query().Get("after"))
	messages, err := r.store.MessagesAround(channelID, messageID, beforeLimit, afterLimit)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_MESSAGE_NOT_FOUND", "message not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": nonNilSlice(messages)})
}

func (r *Router) channelMessageImages(w http.ResponseWriter, req *http.Request, channelID string) {
	if req.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	session, ok := r.requireChannelPermission(w, req, channelID, domain.PermissionSendMessages)
	if !ok {
		return
	}
	if !r.store.MemberHasChannelPermission(session.MemberID, channelID, domain.PermissionViewChannels) {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission view_channels is required")
		return
	}
	req.Body = http.MaxBytesReader(w, req.Body, maxMessageImageBytes+(1<<20))
	if err := req.ParseMultipartForm(4 << 20); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "request body too large") {
			writeError(w, http.StatusRequestEntityTooLarge, "EV_MESSAGE_IMAGE_TOO_LARGE", "message image exceeds size limit")
			return
		}
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "invalid message image upload")
		return
	}
	if req.MultipartForm != nil {
		defer req.MultipartForm.RemoveAll()
	}
	uploaded, header, err := req.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "image file is required")
		return
	}
	defer uploaded.Close()
	name := cleanFileEntryName(header.Filename)
	if name == "" {
		name = "message-image"
	}
	asset, err := r.saveContentAsset(
		uploaded,
		name,
		header.Header.Get("Content-Type"),
		maxMessageImageBytes,
		isSupportedMessageImageMIME,
	)
	if errors.Is(err, errUploadedFileTooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, "EV_MESSAGE_IMAGE_TOO_LARGE", "message image exceeds size limit")
		return
	}
	if errors.Is(err, errUnsupportedAssetType) {
		writeError(w, http.StatusUnsupportedMediaType, "EV_MESSAGE_IMAGE_TYPE_UNSUPPORTED", "message image type is not supported")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	if err := r.store.LinkChannelMessageImage(channelID, asset.SHA256); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_CHANNEL_NOT_FOUND", "channel not found")
			return
		}
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	w.Header().Set("X-EchoVoice-Content-SHA256", asset.SHA256)
	writeJSON(w, http.StatusCreated, publicContentAsset(asset))
}

func (r *Router) channelMessageImageResource(w http.ResponseWriter, req *http.Request, channelID string, rawSHA string) {
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	session, ok := r.requireChannelPermission(w, req, channelID, domain.PermissionViewChannels)
	if !ok {
		return
	}
	if !r.store.MemberHasChannelPermission(session.MemberID, channelID, domain.PermissionReadMessageHistory) {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission read_message_history is required")
		return
	}
	sha := normalizeAssetSHA256(rawSHA)
	if sha == "" {
		writeError(w, http.StatusBadRequest, "EV_ASSET_SHA256_INVALID", "asset sha256 is invalid")
		return
	}
	if !r.store.ChannelHasMessageImage(channelID, sha) {
		writeError(w, http.StatusNotFound, "EV_MESSAGE_IMAGE_NOT_FOUND", "message image not found")
		return
	}
	asset, err := r.store.ContentAsset(sha)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_MESSAGE_IMAGE_NOT_FOUND", "message image not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	if !isSupportedMessageImageMIME(asset.MimeType) {
		writeError(w, http.StatusUnsupportedMediaType, "EV_MESSAGE_IMAGE_TYPE_UNSUPPORTED", "message image type is not supported")
		return
	}
	path := asset.StoragePath
	if path == "" {
		path = r.contentObjectPath(asset.SHA256)
	}
	if _, err := os.Stat(path); err != nil {
		writeError(w, http.StatusNotFound, "EV_MESSAGE_IMAGE_NOT_FOUND", "message image not found")
		return
	}
	w.Header().Set("Content-Type", asset.MimeType)
	w.Header().Set("Content-Length", strconv.FormatInt(asset.SizeBytes, 10))
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": asset.OriginalName}))
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, req, path)
}

func (r *Router) channelFiles(w http.ResponseWriter, req *http.Request, channelID string) {
	if !r.ensureFileStorageEnabled(w) {
		return
	}
	if !r.ensureFileCapableChannel(w, channelID) {
		return
	}
	switch req.Method {
	case http.MethodGet:
		session, ok := r.requireChannelFilePermission(w, req, channelID, domain.PermissionViewFiles)
		if !ok {
			return
		}
		parentID := strings.TrimSpace(req.URL.Query().Get("parent_id"))
		entries := r.store.FileEntries(channelID, parentID)
		if !r.memberHasChannelFilePermission(session.MemberID, channelID, domain.PermissionDownloadFiles) {
			for index := range entries {
				entries[index].AssetSHA256 = ""
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"entries": nonNilSlice(entries)})
	case http.MethodPost:
		if strings.Contains(req.Header.Get("Content-Type"), "multipart/form-data") {
			session, ok := r.requireChannelFilePermission(w, req, channelID, domain.PermissionUploadFiles)
			if !ok {
				return
			}
			r.uploadChannelFile(w, req, channelID, session.MemberID)
			return
		}
		var input struct {
			Type        string `json:"type"`
			Name        string `json:"name"`
			ParentID    string `json:"parent_id"`
			AssetSHA256 string `json:"asset_sha256"`
			SizeBytes   int64  `json:"size_bytes"`
		}
		if err := readJSON(req, &input); err != nil {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
			return
		}
		switch input.Type {
		case string(domain.ChannelFileEntryDirectory):
			session, ok := r.requireChannelFilePermission(w, req, channelID, domain.PermissionManageFiles)
			if !ok {
				return
			}
			name := cleanFileEntryName(input.Name)
			if name == "" {
				writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "file name is required")
				return
			}
			entry, ok := r.createChannelFileEntry(w, domain.ChannelFileEntry{
				ChannelID:     channelID,
				ParentID:      strings.TrimSpace(input.ParentID),
				Type:          domain.ChannelFileEntryDirectory,
				Name:          name,
				OwnerMemberID: session.MemberID,
			})
			if !ok {
				return
			}
			r.recordAudit(session.MemberID, "file.directory.create", "file_entry", entry.EntryID, map[string]string{
				"channel_id": channelID,
				"name":       entry.Name,
				"parent_id":  entry.ParentID,
			})
			r.broadcastFileEvent(channelID, "file.created", entry)
			writeJSON(w, http.StatusCreated, entry)
		case string(domain.ChannelFileEntryFile):
			session, ok := r.requireChannelFilePermission(w, req, channelID, domain.PermissionUploadFiles)
			if !ok {
				return
			}
			r.linkCachedChannelFile(w, channelID, session.MemberID, input.Name, input.ParentID, input.AssetSHA256, input.SizeBytes)
		default:
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "file entry type must be directory or file")
		}
	default:
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
	}
}

func (r *Router) uploadChannelFile(w http.ResponseWriter, req *http.Request, channelID string, uploaderMemberID string) {
	req.Body = http.MaxBytesReader(w, req.Body, r.maxChannelFileBytes()+(1<<20))
	if err := req.ParseMultipartForm(32 << 20); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "request body too large") {
			writeError(w, http.StatusRequestEntityTooLarge, "EV_FILE_TOO_LARGE", "file exceeds size limit")
			return
		}
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	if req.MultipartForm != nil {
		defer req.MultipartForm.RemoveAll()
	}
	uploaded, header, err := req.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "file is required")
		return
	}
	defer uploaded.Close()

	name := cleanFileEntryName(header.Filename)
	if name == "" {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "file name is required")
		return
	}
	asset, err := r.saveContentAsset(
		uploaded,
		name,
		header.Header.Get("Content-Type"),
		r.maxChannelFileBytes(),
		nil,
	)
	if errors.Is(err, errUploadedFileTooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, "EV_FILE_TOO_LARGE", "file exceeds size limit")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	expectedSHA := strings.TrimSpace(req.FormValue("expected_sha256"))
	if expectedSHA != "" && normalizeAssetSHA256(expectedSHA) == "" {
		writeError(w, http.StatusBadRequest, "EV_FILE_SHA256_INVALID", "expected sha256 is invalid")
		return
	}
	if expectedSHA != "" && normalizeAssetSHA256(expectedSHA) != asset.SHA256 {
		writeError(w, http.StatusUnprocessableEntity, "EV_FILE_SHA256_MISMATCH", "uploaded file sha256 does not match the expected value")
		return
	}
	parentID := r.channelFileUploadParent(uploaderMemberID, channelID, req.FormValue("parent_id"))
	entry, ok := r.createChannelFileEntry(w, domain.ChannelFileEntry{
		ChannelID:     channelID,
		ParentID:      parentID,
		Type:          domain.ChannelFileEntryFile,
		Name:          name,
		AssetSHA256:   asset.SHA256,
		OwnerMemberID: uploaderMemberID,
		SizeBytes:     asset.SizeBytes,
		MimeType:      asset.MimeType,
	})
	if !ok {
		return
	}
	r.recordAudit(uploaderMemberID, "file.upload", "file_entry", entry.EntryID, map[string]string{
		"channel_id": channelID,
		"name":       entry.Name,
		"parent_id":  entry.ParentID,
		"sha256":     entry.AssetSHA256,
		"size_bytes": strconv.FormatInt(entry.SizeBytes, 10),
		"cache_hit":  "false",
	})
	r.broadcastFileEvent(channelID, "file.created", entry)
	writeJSON(w, http.StatusCreated, entry)
}

func (r *Router) linkCachedChannelFile(
	w http.ResponseWriter,
	channelID string,
	ownerMemberID string,
	name string,
	parentID string,
	assetSHA256 string,
	sizeBytes int64,
) {
	name = cleanFileEntryName(name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "file name is required")
		return
	}
	assetSHA256 = normalizeAssetSHA256(assetSHA256)
	if assetSHA256 == "" {
		writeError(w, http.StatusBadRequest, "EV_FILE_SHA256_INVALID", "asset sha256 is invalid")
		return
	}
	asset, err := r.store.ContentAsset(assetSHA256)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_FILE_ASSET_NOT_FOUND", "file asset is not cached")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	if sizeBytes < 0 || (sizeBytes > 0 && sizeBytes != asset.SizeBytes) {
		writeError(w, http.StatusConflict, "EV_FILE_ASSET_MISMATCH", "cached file size does not match")
		return
	}
	path := asset.StoragePath
	if path == "" {
		path = r.contentObjectPath(asset.SHA256)
	}
	if _, err := os.Stat(path); err != nil {
		writeError(w, http.StatusNotFound, "EV_FILE_ASSET_NOT_FOUND", "file asset is not cached")
		return
	}
	entry, ok := r.createChannelFileEntry(w, domain.ChannelFileEntry{
		ChannelID:     channelID,
		ParentID:      r.channelFileUploadParent(ownerMemberID, channelID, parentID),
		Type:          domain.ChannelFileEntryFile,
		Name:          name,
		AssetSHA256:   asset.SHA256,
		OwnerMemberID: ownerMemberID,
		SizeBytes:     asset.SizeBytes,
		MimeType:      asset.MimeType,
	})
	if !ok {
		return
	}
	r.recordAudit(ownerMemberID, "file.upload", "file_entry", entry.EntryID, map[string]string{
		"channel_id": channelID,
		"name":       entry.Name,
		"parent_id":  entry.ParentID,
		"sha256":     entry.AssetSHA256,
		"size_bytes": strconv.FormatInt(entry.SizeBytes, 10),
		"cache_hit":  "true",
	})
	r.broadcastFileEvent(channelID, "file.created", entry)
	w.Header().Set("X-EchoVoice-Content-Deduplicated", "true")
	writeJSON(w, http.StatusCreated, entry)
}

func (r *Router) createChannelFileEntry(w http.ResponseWriter, input domain.ChannelFileEntry) (domain.ChannelFileEntry, bool) {
	entry, err := r.store.CreateFileEntry(input)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_FILE_PARENT_NOT_FOUND", "parent directory not found")
		return domain.ChannelFileEntry{}, false
	}
	if errors.Is(err, store.ErrInvalidChannelOrder) {
		writeError(w, http.StatusBadRequest, "EV_FILE_INVALID_PARENT", "invalid parent directory")
		return domain.ChannelFileEntry{}, false
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return domain.ChannelFileEntry{}, false
	}
	return entry, true
}

func (r *Router) channelFileResource(w http.ResponseWriter, req *http.Request, channelID string, entryID string) {
	if !r.ensureFileStorageEnabled(w) {
		return
	}
	if !r.ensureFileCapableChannel(w, channelID) {
		return
	}
	switch req.Method {
	case http.MethodGet:
		if _, ok := r.requireChannelFilePermission(w, req, channelID, domain.PermissionDownloadFiles); !ok {
			return
		}
		if req.URL.Query().Get("metadata") == "1" {
			entry, err := r.store.FileEntry(channelID, entryID)
			if errors.Is(err, store.ErrNotFound) {
				writeError(w, http.StatusNotFound, "EV_FILE_NOT_FOUND", "file entry not found")
				return
			}
			if err != nil {
				writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
				return
			}
			writeJSON(w, http.StatusOK, entry)
			return
		}
		r.downloadChannelFile(w, req, channelID, entryID)
	case http.MethodPatch:
		session, ok := r.requireSession(w, req)
		if !ok {
			return
		}
		entry, err := r.store.FileEntry(channelID, entryID)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_FILE_NOT_FOUND", "file entry not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		if !r.canManageFileEntry(session.MemberID, channelID, entry) {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "file entry cannot be managed")
			return
		}
		var input struct {
			Name     string `json:"name"`
			ParentID string `json:"parent_id"`
		}
		if err := readJSON(req, &input); err != nil {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
			return
		}
		name := cleanFileEntryName(input.Name)
		if name == "" {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "file name is required")
			return
		}
		parentID := strings.TrimSpace(input.ParentID)
		if !r.memberHasChannelFilePermission(session.MemberID, channelID, domain.PermissionViewFiles) {
			parentID = ""
		}
		updated, err := r.store.UpdateFileEntry(channelID, entryID, domain.ChannelFileEntry{
			Name:     name,
			ParentID: parentID,
		})
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_FILE_PARENT_NOT_FOUND", "parent directory not found")
			return
		}
		if errors.Is(err, store.ErrInvalidChannelOrder) {
			writeError(w, http.StatusBadRequest, "EV_FILE_INVALID_PARENT", "invalid parent directory")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		r.recordAudit(session.MemberID, "file.update", "file_entry", updated.EntryID, map[string]string{
			"channel_id":      channelID,
			"name":            updated.Name,
			"parent_id":       updated.ParentID,
			"previous_name":   entry.Name,
			"previous_parent": entry.ParentID,
		})
		r.broadcastFileEvent(channelID, "file.updated", updated)
		writeJSON(w, http.StatusOK, updated)
	case http.MethodDelete:
		session, ok := r.requireSession(w, req)
		if !ok {
			return
		}
		entry, err := r.store.FileEntry(channelID, entryID)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_FILE_NOT_FOUND", "file entry not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		if !r.canManageFileEntry(session.MemberID, channelID, entry) {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "file entry cannot be managed")
			return
		}
		deleted, err := r.store.DeleteFileEntry(channelID, entryID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		r.recordAudit(session.MemberID, "file.delete", "file_entry", deleted.EntryID, map[string]string{
			"channel_id": channelID,
			"name":       deleted.Name,
			"type":       string(deleted.Type),
		})
		r.broadcastFileEvent(channelID, "file.deleted", deleted)
		writeJSON(w, http.StatusOK, deleted)
	default:
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
	}
}

func (r *Router) downloadChannelFile(w http.ResponseWriter, req *http.Request, channelID string, entryID string) {
	entry, err := r.store.FileEntry(channelID, entryID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_FILE_NOT_FOUND", "file entry not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	if entry.Type != domain.ChannelFileEntryFile {
		writeError(w, http.StatusBadRequest, "EV_FILE_NOT_DOWNLOADABLE", "directory cannot be downloaded")
		return
	}
	asset, err := r.store.ContentAsset(entry.AssetSHA256)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_FILE_ASSET_NOT_FOUND", "file asset not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	path := asset.StoragePath
	if path == "" {
		path = r.contentObjectPath(asset.SHA256)
	}
	if _, err := os.Stat(path); err != nil {
		writeError(w, http.StatusNotFound, "EV_FILE_ASSET_NOT_FOUND", "file asset not found")
		return
	}
	w.Header().Set("Content-Type", nonEmptyString(asset.MimeType, "application/octet-stream"))
	w.Header().Set("Content-Length", strconv.FormatInt(asset.SizeBytes, 10))
	disposition := "attachment"
	if req.URL.Query().Get("disposition") == "inline" {
		disposition = "inline"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": entry.Name}))
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, req, path)
}

func (r *Router) uploadContentAsset(w http.ResponseWriter, req *http.Request) {
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	maxUploadBytes := r.maxPurposeAssetBytes()
	req.Body = http.MaxBytesReader(w, req.Body, maxUploadBytes+(1<<20))
	if err := req.ParseMultipartForm(1 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "invalid asset upload")
		return
	}
	if req.MultipartForm != nil {
		defer req.MultipartForm.RemoveAll()
	}
	purpose := strings.TrimSpace(req.FormValue("purpose"))
	maxBytes := int64(0)
	var accepts func(string) bool
	switch purpose {
	case "soundboard":
		if !r.store.Server().SoundboardEnabled {
			writeError(w, http.StatusForbidden, "EV_SOUNDBOARD_DISABLED", "soundboard is disabled")
			return
		}
		if !r.hasPermission(session.MemberID, domain.PermissionPlaySoundboard) {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission "+string(domain.PermissionPlaySoundboard)+" is required")
			return
		}
		maxBytes = r.maxSoundboardBytes()
		accepts = isSupportedSoundboardMIME
	case "emoji":
		if !r.store.Server().EmojiEnabled {
			writeError(w, http.StatusForbidden, "EV_EMOJI_DISABLED", "custom emoji is disabled")
			return
		}
		if !r.hasPermission(session.MemberID, domain.PermissionSendEmoji) {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission "+string(domain.PermissionSendEmoji)+" is required")
			return
		}
		maxBytes = r.maxEmojiBytes()
		accepts = isSupportedEmojiMIME
	default:
		writeError(w, http.StatusBadRequest, "EV_ASSET_PURPOSE_INVALID", "asset purpose must be soundboard or emoji")
		return
	}
	uploaded, header, err := req.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "file is required")
		return
	}
	defer uploaded.Close()
	name := cleanFileEntryName(header.Filename)
	if name == "" {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "file name is required")
		return
	}
	asset, err := r.saveContentAsset(uploaded, name, header.Header.Get("Content-Type"), maxBytes, accepts)
	if errors.Is(err, errUploadedFileTooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, "EV_ASSET_TOO_LARGE", "asset exceeds size limit")
		return
	}
	if errors.Is(err, errUnsupportedAssetType) {
		writeError(w, http.StatusUnsupportedMediaType, "EV_ASSET_TYPE_UNSUPPORTED", "asset file type is not supported")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	r.recordAudit(session.MemberID, "asset.upload", "content_asset", asset.SHA256, map[string]string{
		"purpose":    purpose,
		"name":       asset.OriginalName,
		"mime_type":  asset.MimeType,
		"size_bytes": strconv.FormatInt(asset.SizeBytes, 10),
	})
	writeJSON(w, http.StatusCreated, publicContentAsset(asset))
}

func (r *Router) contentAssetResource(w http.ResponseWriter, req *http.Request) {
	if _, ok := r.requireSession(w, req); !ok {
		return
	}
	sha := normalizeAssetSHA256(strings.Trim(strings.TrimPrefix(req.URL.Path, "/api/v1/assets/"), "/"))
	if sha == "" {
		writeError(w, http.StatusBadRequest, "EV_ASSET_SHA256_INVALID", "asset sha256 is invalid")
		return
	}
	asset, err := r.store.ContentAsset(sha)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_ASSET_NOT_FOUND", "asset not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	path := asset.StoragePath
	if path == "" {
		path = r.contentObjectPath(asset.SHA256)
	}
	if _, err := os.Stat(path); err != nil {
		writeError(w, http.StatusNotFound, "EV_ASSET_NOT_FOUND", "asset content not found")
		return
	}
	etag := `"` + asset.SHA256 + `"`
	w.Header().Set("Content-Type", nonEmptyString(asset.MimeType, "application/octet-stream"))
	w.Header().Set("Content-Length", strconv.FormatInt(asset.SizeBytes, 10))
	w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": asset.OriginalName}))
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("ETag", etag)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if req.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	if req.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	http.ServeFile(w, req, path)
}

func (r *Router) soundboardItems(w http.ResponseWriter, req *http.Request) {
	if !r.store.Server().SoundboardEnabled {
		writeError(w, http.StatusForbidden, "EV_SOUNDBOARD_DISABLED", "soundboard is disabled")
		return
	}
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	if req.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{"items": nonNilSlice(r.store.SoundboardItems())})
		return
	}
	if !r.hasPermission(session.MemberID, domain.PermissionManageServerSoundboard) {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission "+string(domain.PermissionManageServerSoundboard)+" is required")
		return
	}
	req.Body = http.MaxBytesReader(w, req.Body, r.maxSoundboardBytes()+(1<<20))
	if err := req.ParseMultipartForm(1 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "invalid soundboard upload")
		return
	}
	if req.MultipartForm != nil {
		defer req.MultipartForm.RemoveAll()
	}
	uploaded, header, err := req.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "soundboard file is required")
		return
	}
	defer uploaded.Close()
	name := strings.TrimSpace(req.FormValue("name"))
	if name == "" {
		name = strings.TrimSuffix(cleanFileEntryName(header.Filename), filepath.Ext(header.Filename))
	}
	if name == "" || len([]rune(name)) > 48 {
		writeError(w, http.StatusBadRequest, "EV_SOUNDBOARD_NAME_INVALID", "soundboard name must be between 1 and 48 characters")
		return
	}
	asset, err := r.saveContentAsset(
		uploaded,
		cleanFileEntryName(header.Filename),
		header.Header.Get("Content-Type"),
		r.maxSoundboardBytes(),
		isSupportedSoundboardMIME,
	)
	if errors.Is(err, errUploadedFileTooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, "EV_ASSET_TOO_LARGE", "soundboard file exceeds size limit")
		return
	}
	if errors.Is(err, errUnsupportedAssetType) {
		writeError(w, http.StatusUnsupportedMediaType, "EV_ASSET_TYPE_UNSUPPORTED", "soundboard file type is not supported")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	item, err := r.store.CreateSoundboardItem(domain.SoundboardItem{
		Name:             name,
		AssetSHA256:      asset.SHA256,
		UploaderMemberID: session.MemberID,
		SizeBytes:        asset.SizeBytes,
		MimeType:         asset.MimeType,
		BaseVolume:       1,
	})
	if errors.Is(err, store.ErrAlreadyExists) {
		writeError(w, http.StatusConflict, "EV_SOUNDBOARD_NAME_CONFLICT", "soundboard name already exists")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	r.recordAudit(session.MemberID, "soundboard.item.create", "soundboard_item", item.ItemID, map[string]string{
		"name":       item.Name,
		"sha256":     item.AssetSHA256,
		"size_bytes": strconv.FormatInt(item.SizeBytes, 10),
	})
	r.hub.Broadcast(ws.Event{Type: "soundboard.item.created", Payload: item})
	writeJSON(w, http.StatusCreated, item)
}

func (r *Router) soundboardItemResource(w http.ResponseWriter, req *http.Request) {
	if !r.store.Server().SoundboardEnabled {
		writeError(w, http.StatusForbidden, "EV_SOUNDBOARD_DISABLED", "soundboard is disabled")
		return
	}
	session, ok := r.requirePermission(w, req, domain.PermissionManageServerSoundboard)
	if !ok {
		return
	}
	itemID := strings.Trim(strings.TrimPrefix(req.URL.Path, "/api/v1/soundboard/"), "/")
	if itemID == "" || strings.Contains(itemID, "/") {
		writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "route not found")
		return
	}
	if req.Method == http.MethodPatch {
		var input struct {
			Name            string   `json:"name"`
			IconEmoji       string   `json:"icon_emoji"`
			IconAssetSHA256 string   `json:"icon_asset_sha256"`
			StartMS         int64    `json:"start_ms"`
			EndMS           int64    `json:"end_ms"`
			BaseVolume      *float64 `json:"base_volume"`
		}
		if err := readJSON(req, &input); err != nil {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
			return
		}
		input.Name = strings.TrimSpace(input.Name)
		input.IconEmoji = strings.TrimSpace(input.IconEmoji)
		input.IconAssetSHA256 = normalizeAssetSHA256(input.IconAssetSHA256)
		baseVolume := 1.0
		if current, err := r.store.SoundboardItem(itemID); err == nil && current.BaseVolume > 0 {
			baseVolume = current.BaseVolume
		}
		if input.BaseVolume != nil {
			baseVolume = *input.BaseVolume
		}
		if input.Name == "" || len([]rune(input.Name)) > 48 {
			writeError(w, http.StatusBadRequest, "EV_SOUNDBOARD_NAME_INVALID", "soundboard name must be between 1 and 48 characters")
			return
		}
		if len([]rune(input.IconEmoji)) > 16 {
			writeError(w, http.StatusBadRequest, "EV_SOUNDBOARD_ICON_INVALID", "soundboard icon is too long")
			return
		}
		if input.IconAssetSHA256 != "" {
			validCustomEmoji := false
			for _, emoji := range r.store.CustomEmojis() {
				if emoji.AssetSHA256 == input.IconAssetSHA256 {
					validCustomEmoji = true
					break
				}
			}
			if !validCustomEmoji {
				writeError(w, http.StatusBadRequest, "EV_SOUNDBOARD_ICON_INVALID", "soundboard custom icon must exist on this server")
				return
			}
		}
		if input.StartMS < 0 || input.EndMS < 0 || input.StartMS > 86_400_000 || input.EndMS > 86_400_000 || (input.EndMS > 0 && input.EndMS <= input.StartMS) {
			writeError(w, http.StatusBadRequest, "EV_SOUNDBOARD_RANGE_INVALID", "soundboard playback range is invalid")
			return
		}
		if baseVolume < 0.05 || baseVolume > 2 {
			writeError(w, http.StatusBadRequest, "EV_SOUNDBOARD_VOLUME_INVALID", "soundboard base volume must be between 0.05 and 2")
			return
		}
		item, err := r.store.UpdateSoundboardItem(itemID, domain.SoundboardItem{
			Name:            input.Name,
			IconEmoji:       input.IconEmoji,
			IconAssetSHA256: input.IconAssetSHA256,
			StartMS:         input.StartMS,
			EndMS:           input.EndMS,
			BaseVolume:      baseVolume,
		})
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_SOUNDBOARD_NOT_FOUND", "soundboard item not found")
			return
		}
		if errors.Is(err, store.ErrAlreadyExists) {
			writeError(w, http.StatusConflict, "EV_SOUNDBOARD_NAME_CONFLICT", "soundboard name already exists")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		r.recordAudit(session.MemberID, "soundboard.item.update", "soundboard_item", item.ItemID, map[string]string{
			"name":        item.Name,
			"start_ms":    strconv.FormatInt(item.StartMS, 10),
			"end_ms":      strconv.FormatInt(item.EndMS, 10),
			"base_volume": strconv.FormatFloat(item.BaseVolume, 'f', 2, 64),
		})
		r.hub.Broadcast(ws.Event{Type: "soundboard.item.updated", Payload: item})
		writeJSON(w, http.StatusOK, item)
		return
	}
	item, err := r.store.DeleteSoundboardItem(itemID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_SOUNDBOARD_NOT_FOUND", "soundboard item not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	r.recordAudit(session.MemberID, "soundboard.item.delete", "soundboard_item", item.ItemID, map[string]string{
		"name":   item.Name,
		"sha256": item.AssetSHA256,
	})
	r.hub.Broadcast(ws.Event{Type: "soundboard.item.deleted", Payload: item})
	writeJSON(w, http.StatusOK, item)
}

func (r *Router) customEmojiItems(w http.ResponseWriter, req *http.Request) {
	if !r.store.Server().EmojiEnabled {
		writeError(w, http.StatusForbidden, "EV_EMOJI_DISABLED", "custom emoji is disabled")
		return
	}
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	if req.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, map[string]any{"emojis": nonNilSlice(r.store.CustomEmojis())})
		return
	}
	if !r.hasPermission(session.MemberID, domain.PermissionManageServerEmoji) {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission "+string(domain.PermissionManageServerEmoji)+" is required")
		return
	}
	req.Body = http.MaxBytesReader(w, req.Body, r.maxEmojiBytes()+(1<<20))
	if err := req.ParseMultipartForm(1 << 20); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "invalid emoji upload")
		return
	}
	if req.MultipartForm != nil {
		defer req.MultipartForm.RemoveAll()
	}
	uploaded, header, err := req.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "emoji file is required")
		return
	}
	defer uploaded.Close()
	shortcode := strings.Trim(strings.TrimSpace(req.FormValue("shortcode")), ":")
	if !emojiShortcodePattern.MatchString(shortcode) {
		writeError(w, http.StatusBadRequest, "EV_EMOJI_SHORTCODE_INVALID", "emoji id must contain 1 to 12 lowercase letters, numbers, or underscores")
		return
	}
	asset, err := r.saveContentAsset(
		uploaded,
		cleanFileEntryName(header.Filename),
		header.Header.Get("Content-Type"),
		r.maxEmojiBytes(),
		isSupportedEmojiMIME,
	)
	if errors.Is(err, errUploadedFileTooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, "EV_ASSET_TOO_LARGE", "emoji file exceeds the server limit")
		return
	}
	if errors.Is(err, errUnsupportedAssetType) {
		writeError(w, http.StatusUnsupportedMediaType, "EV_ASSET_TYPE_UNSUPPORTED", "emoji file type is not supported")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	emoji, err := r.store.CreateCustomEmoji(domain.CustomEmoji{
		Shortcode:        shortcode,
		AssetSHA256:      asset.SHA256,
		UploaderMemberID: session.MemberID,
		SizeBytes:        asset.SizeBytes,
		MimeType:         asset.MimeType,
		IsGIF:            asset.MimeType == "image/gif",
	})
	if errors.Is(err, store.ErrAlreadyExists) {
		writeError(w, http.StatusConflict, "EV_EMOJI_SHORTCODE_CONFLICT", "emoji shortcode already exists")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	r.recordAudit(session.MemberID, "emoji.create", "custom_emoji", emoji.EmojiID, map[string]string{
		"shortcode":  emoji.Shortcode,
		"sha256":     emoji.AssetSHA256,
		"size_bytes": strconv.FormatInt(emoji.SizeBytes, 10),
		"mime_type":  emoji.MimeType,
	})
	r.hub.Broadcast(ws.Event{Type: "emoji.created", Payload: emoji})
	writeJSON(w, http.StatusCreated, emoji)
}

func (r *Router) customEmojiResource(w http.ResponseWriter, req *http.Request) {
	if !r.store.Server().EmojiEnabled {
		writeError(w, http.StatusForbidden, "EV_EMOJI_DISABLED", "custom emoji is disabled")
		return
	}
	session, ok := r.requirePermission(w, req, domain.PermissionManageServerEmoji)
	if !ok {
		return
	}
	emojiID := strings.Trim(strings.TrimPrefix(req.URL.Path, "/api/v1/emojis/"), "/")
	if emojiID == "" || strings.Contains(emojiID, "/") {
		writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "route not found")
		return
	}
	if req.Method == http.MethodPatch {
		var input struct {
			Shortcode string `json:"shortcode"`
		}
		if err := readJSON(req, &input); err != nil {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "invalid emoji update")
			return
		}
		shortcode := strings.Trim(strings.TrimSpace(input.Shortcode), ":")
		if !emojiShortcodePattern.MatchString(shortcode) {
			writeError(w, http.StatusBadRequest, "EV_EMOJI_SHORTCODE_INVALID", "emoji id must contain 1 to 12 lowercase letters, numbers, or underscores")
			return
		}
		previous, err := r.store.CustomEmoji(emojiID)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_EMOJI_NOT_FOUND", "emoji not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		emoji, err := r.store.UpdateCustomEmoji(emojiID, shortcode)
		if errors.Is(err, store.ErrAlreadyExists) {
			writeError(w, http.StatusConflict, "EV_EMOJI_SHORTCODE_CONFLICT", "emoji shortcode already exists")
			return
		}
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_EMOJI_NOT_FOUND", "emoji not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		r.recordAudit(session.MemberID, "emoji.update", "custom_emoji", emoji.EmojiID, map[string]string{
			"shortcode":          emoji.Shortcode,
			"previous_shortcode": previous.Shortcode,
			"sha256":             emoji.AssetSHA256,
		})
		r.hub.Broadcast(ws.Event{Type: "emoji.updated", Payload: emoji})
		writeJSON(w, http.StatusOK, emoji)
		return
	}
	emoji, err := r.store.DeleteCustomEmoji(emojiID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_EMOJI_NOT_FOUND", "emoji not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	r.recordAudit(session.MemberID, "emoji.delete", "custom_emoji", emoji.EmojiID, map[string]string{
		"shortcode": emoji.Shortcode,
		"sha256":    emoji.AssetSHA256,
	})
	r.hub.Broadcast(ws.Event{Type: "emoji.deleted", Payload: emoji})
	writeJSON(w, http.StatusOK, emoji)
}

func (r *Router) validateMessageEmojis(w http.ResponseWriter, memberID string, channelID string, content string) bool {
	matches := messageEmojiPattern.FindAllStringSubmatch(content, -1)
	if len(matches) == 0 {
		return true
	}
	if !r.store.Server().EmojiEnabled {
		writeError(w, http.StatusForbidden, "EV_EMOJI_DISABLED", "custom emoji is disabled")
		return false
	}
	if !r.store.MemberHasChannelPermission(memberID, channelID, domain.PermissionSendEmoji) {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission "+string(domain.PermissionSendEmoji)+" is required")
		return false
	}
	if len(matches) > 20 {
		writeError(w, http.StatusBadRequest, "EV_EMOJI_LIMIT_EXCEEDED", "a message can contain at most 20 custom emoji")
		return false
	}
	for _, match := range matches {
		sha := normalizeAssetSHA256(match[2])
		sizeBytes, err := strconv.ParseInt(match[3], 10, 64)
		mimeType := emojiMIMEFromToken(match[4])
		asset, assetErr := r.store.ContentAsset(sha)
		if err != nil || sha == "" || mimeType == "" || errors.Is(assetErr, store.ErrNotFound) {
			writeError(w, http.StatusBadRequest, "EV_EMOJI_ASSET_INVALID", "emoji asset is invalid or unavailable")
			return false
		}
		if assetErr != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", assetErr.Error())
			return false
		}
		if asset.SizeBytes != sizeBytes || asset.MimeType != mimeType || sizeBytes > r.maxEmojiBytes() || !isSupportedEmojiMIME(asset.MimeType) {
			writeError(w, http.StatusBadRequest, "EV_EMOJI_ASSET_MISMATCH", "emoji metadata does not match the stored asset")
			return false
		}
	}
	return true
}

func (r *Router) validateMessageImages(w http.ResponseWriter, channelID string, content string) bool {
	matches := messageImagePattern.FindAllStringSubmatch(content, -1)
	if len(matches) == 0 {
		return true
	}
	if len(matches) > maxMessageImagesPerMessage {
		writeError(w, http.StatusBadRequest, "EV_MESSAGE_IMAGE_LIMIT_EXCEEDED", "a message can contain at most 10 images")
		return false
	}
	for _, match := range matches {
		sha := normalizeAssetSHA256(match[1])
		sizeBytes, sizeErr := strconv.ParseInt(match[2], 10, 64)
		mimeType := messageImageMIMEFromToken(match[3])
		if sha == "" || sizeErr != nil || sizeBytes <= 0 || sizeBytes > maxMessageImageBytes || mimeType == "" {
			writeError(w, http.StatusBadRequest, "EV_MESSAGE_IMAGE_INVALID", "message image metadata is invalid")
			return false
		}
		if !r.store.ChannelHasMessageImage(channelID, sha) {
			writeError(w, http.StatusBadRequest, "EV_MESSAGE_IMAGE_NOT_FOUND", "message image is not available in this channel")
			return false
		}
		asset, err := r.store.ContentAsset(sha)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusBadRequest, "EV_MESSAGE_IMAGE_NOT_FOUND", "message image is unavailable")
			return false
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return false
		}
		if asset.SizeBytes != sizeBytes || asset.MimeType != mimeType || !isSupportedMessageImageMIME(asset.MimeType) {
			writeError(w, http.StatusBadRequest, "EV_MESSAGE_IMAGE_MISMATCH", "message image metadata does not match the stored asset")
			return false
		}
	}
	return true
}

func messageImageMIMEFromToken(value string) string {
	switch value {
	case "png":
		return "image/png"
	case "gif":
		return "image/gif"
	case "webp":
		return "image/webp"
	case "jpg":
		return "image/jpeg"
	case "avif":
		return "image/avif"
	default:
		return ""
	}
}

func emojiMIMEFromToken(value string) string {
	switch value {
	case "png":
		return "image/png"
	case "gif":
		return "image/gif"
	case "webp":
		return "image/webp"
	case "jpg":
		return "image/jpeg"
	default:
		return ""
	}
}

func (r *Router) playSoundboard(w http.ResponseWriter, req *http.Request) {
	if !r.store.Server().SoundboardEnabled {
		writeError(w, http.StatusForbidden, "EV_SOUNDBOARD_DISABLED", "soundboard is disabled")
		return
	}
	var input struct {
		ChannelID   string  `json:"channel_id"`
		ItemID      string  `json:"item_id"`
		AssetSHA256 string  `json:"asset_sha256"`
		Name        string  `json:"name"`
		Volume      float64 `json:"volume"`
		StartMS     int64   `json:"start_ms"`
		EndMS       int64   `json:"end_ms"`
		BaseVolume  float64 `json:"base_volume"`
	}
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	input.ChannelID = strings.TrimSpace(input.ChannelID)
	session, ok := r.requireChannelPermission(w, req, input.ChannelID, domain.PermissionPlaySoundboard)
	if !ok {
		return
	}
	voiceState, inVoice := r.voiceStateByDevice(session.MemberID, session.DeviceID)
	if !inVoice || voiceState.ChannelID != input.ChannelID {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "you must be in the voice channel to play a soundboard item")
		return
	}
	if voiceState.Mode == "listener" {
		writeError(w, http.StatusForbidden, "EV_VOICE_LISTEN_ONLY", "listen-only devices cannot play soundboard items")
		return
	}
	playback := domain.SoundboardPlayback{
		ChannelID:    input.ChannelID,
		MemberID:     session.MemberID,
		ItemID:       strings.TrimSpace(input.ItemID),
		Name:         strings.TrimSpace(input.Name),
		SenderVolume: input.Volume,
	}
	if playback.ItemID != "" {
		item, err := r.store.SoundboardItem(playback.ItemID)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_SOUNDBOARD_NOT_FOUND", "soundboard item not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		playback.Name = item.Name
		playback.AssetSHA256 = item.AssetSHA256
		playback.SizeBytes = item.SizeBytes
		playback.MimeType = item.MimeType
		playback.StartMS = item.StartMS
		playback.EndMS = item.EndMS
		playback.BaseVolume = item.BaseVolume
	} else {
		playback.AssetSHA256 = normalizeAssetSHA256(input.AssetSHA256)
		asset, err := r.store.ContentAsset(playback.AssetSHA256)
		if playback.AssetSHA256 == "" || errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_ASSET_NOT_FOUND", "soundboard asset not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		if !isSupportedSoundboardMIME(asset.MimeType) {
			writeError(w, http.StatusUnsupportedMediaType, "EV_ASSET_TYPE_UNSUPPORTED", "soundboard file type is not supported")
			return
		}
		playback.SizeBytes = asset.SizeBytes
		playback.MimeType = asset.MimeType
		if playback.Name == "" {
			playback.Name = strings.TrimSuffix(asset.OriginalName, filepath.Ext(asset.OriginalName))
		}
		playback.StartMS = input.StartMS
		playback.EndMS = input.EndMS
		playback.BaseVolume = input.BaseVolume
	}
	if playback.Name == "" || len([]rune(playback.Name)) > 48 {
		writeError(w, http.StatusBadRequest, "EV_SOUNDBOARD_NAME_INVALID", "soundboard name must be between 1 and 48 characters")
		return
	}
	if playback.StartMS < 0 || playback.EndMS < 0 || playback.StartMS > 86_400_000 || playback.EndMS > 86_400_000 || (playback.EndMS > 0 && playback.EndMS <= playback.StartMS) {
		writeError(w, http.StatusBadRequest, "EV_SOUNDBOARD_RANGE_INVALID", "soundboard playback range is invalid")
		return
	}
	if playback.BaseVolume <= 0 {
		playback.BaseVolume = 1
	}
	if playback.SenderVolume <= 0 {
		playback.SenderVolume = 1
	}
	if playback.BaseVolume < 0.05 || playback.BaseVolume > 2 || playback.SenderVolume < 0.05 || playback.SenderVolume > 2 {
		writeError(w, http.StatusBadRequest, "EV_SOUNDBOARD_VOLUME_INVALID", "soundboard base and sender volumes must be between 0.05 and 2")
		return
	}
	playback.Volume = playback.BaseVolume * playback.SenderVolume
	if !r.allowSoundboardPlayback(session.MemberID) {
		writeError(w, http.StatusTooManyRequests, "EV_SOUNDBOARD_RATE_LIMITED", "soundboard playback is cooling down")
		return
	}
	playbackID, err := auth.NewToken("play")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	playback.PlaybackID = playbackID
	playback.PlayAtMS = time.Now().Add(250 * time.Millisecond).UnixMilli()
	r.recordAudit(session.MemberID, "soundboard.play", "soundboard_playback", playback.PlaybackID, map[string]string{
		"channel_id":    playback.ChannelID,
		"item_id":       playback.ItemID,
		"name":          playback.Name,
		"sha256":        playback.AssetSHA256,
		"volume":        strconv.FormatFloat(playback.Volume, 'f', 2, 64),
		"base_volume":   strconv.FormatFloat(playback.BaseVolume, 'f', 2, 64),
		"sender_volume": strconv.FormatFloat(playback.SenderVolume, 'f', 2, 64),
	})
	r.broadcastChannelEvent(playback.ChannelID, "soundboard.played", playback)
	writeJSON(w, http.StatusCreated, playback)
}

func (r *Router) allowSoundboardPlayback(memberID string) bool {
	r.soundboardRateMu.Lock()
	defer r.soundboardRateMu.Unlock()
	now := time.Now()
	if previous := r.soundboardLastPlayed[memberID]; !previous.IsZero() && now.Sub(previous) < 750*time.Millisecond {
		return false
	}
	r.soundboardLastPlayed[memberID] = now
	return true
}

func (r *Router) saveContentAsset(
	reader io.Reader,
	originalName string,
	contentType string,
	maxBytes int64,
	accepts func(string) bool,
) (domain.ContentAsset, error) {
	contentRoot := r.contentRootPath()
	if err := os.MkdirAll(contentRoot, 0o755); err != nil {
		return domain.ContentAsset{}, err
	}
	temp, err := os.CreateTemp(contentRoot, "upload-*")
	if err != nil {
		return domain.ContentAsset{}, err
	}
	tempPath := temp.Name()
	defer func() {
		_ = temp.Close()
	}()

	if maxBytes <= 0 {
		return domain.ContentAsset{}, errUploadedFileTooLarge
	}
	hasher := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(temp, hasher), io.LimitReader(reader, maxBytes+1))
	if copyErr != nil {
		_ = os.Remove(tempPath)
		return domain.ContentAsset{}, copyErr
	}
	if written > maxBytes {
		_ = os.Remove(tempPath)
		return domain.ContentAsset{}, errUploadedFileTooLarge
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempPath)
		return domain.ContentAsset{}, err
	}

	detectedMIME, err := detectUploadedAssetMIME(tempPath, contentType, originalName)
	if err != nil {
		_ = os.Remove(tempPath)
		return domain.ContentAsset{}, err
	}
	if accepts != nil && !accepts(detectedMIME) {
		_ = os.Remove(tempPath)
		return domain.ContentAsset{}, errUnsupportedAssetType
	}

	sha := hex.EncodeToString(hasher.Sum(nil))
	objectPath := r.contentObjectPath(sha)
	if err := os.MkdirAll(filepath.Dir(objectPath), 0o755); err != nil {
		_ = os.Remove(tempPath)
		return domain.ContentAsset{}, err
	}
	if _, err := os.Stat(objectPath); err == nil {
		_ = os.Remove(tempPath)
	} else if err := os.Rename(tempPath, objectPath); err != nil {
		// Another upload with the same content may win the content-addressed rename.
		if _, statErr := os.Stat(objectPath); statErr != nil {
			_ = os.Remove(tempPath)
			return domain.ContentAsset{}, err
		}
		_ = os.Remove(tempPath)
	}

	return r.store.UpsertContentAsset(domain.ContentAsset{
		SHA256:       sha,
		SizeBytes:    written,
		MimeType:     detectedMIME,
		OriginalName: originalName,
		StoragePath:  objectPath,
		CreatedAtMS:  time.Now().UnixMilli(),
	})
}

func detectUploadedAssetMIME(path string, declared string, originalName string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	buffer := make([]byte, 512)
	count, err := file.Read(buffer)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	detected := http.DetectContentType(buffer[:count])
	if detected == "application/octet-stream" {
		if parsed, _, parseErr := mime.ParseMediaType(strings.TrimSpace(declared)); parseErr == nil && parsed != "" {
			detected = parsed
		} else if byExtension := mime.TypeByExtension(filepath.Ext(originalName)); byExtension != "" {
			detected, _, _ = mime.ParseMediaType(byExtension)
		}
	}
	return strings.ToLower(strings.TrimSpace(detected)), nil
}

func isSupportedSoundboardMIME(value string) bool {
	switch value {
	case "audio/aac", "audio/flac", "audio/m4a", "audio/mp4", "audio/mpeg", "audio/ogg", "audio/opus", "audio/wav", "audio/wave", "audio/webm", "audio/x-m4a", "audio/x-wav":
		return true
	default:
		return false
	}
}

func isSupportedEmojiMIME(value string) bool {
	switch value {
	case "image/gif", "image/jpeg", "image/png", "image/webp":
		return true
	default:
		return false
	}
}

func isSupportedMessageImageMIME(value string) bool {
	switch value {
	case "image/avif", "image/gif", "image/jpeg", "image/png", "image/webp":
		return true
	default:
		return false
	}
}

func publicContentAsset(asset domain.ContentAsset) domain.ContentAsset {
	asset.StoragePath = ""
	return asset
}

func normalizeAssetSHA256(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if len(value) != sha256.Size*2 {
		return ""
	}
	if _, err := hex.DecodeString(value); err != nil {
		return ""
	}
	return value
}

func (r *Router) ensureFileStorageEnabled(w http.ResponseWriter) bool {
	if r.store.Server().FileStorageEnabled {
		return true
	}
	writeError(w, http.StatusForbidden, "EV_FILE_STORAGE_DISABLED", "file storage is disabled")
	return false
}

func (r *Router) ensureScreenShareEnabled(w http.ResponseWriter) bool {
	if r.store.Server().ScreenShareEnabled {
		return true
	}
	writeError(w, http.StatusForbidden, "EV_SCREEN_SHARE_DISABLED", "screen sharing is disabled")
	return false
}

func (r *Router) ensureAccompanimentEnabled(w http.ResponseWriter) bool {
	if r.store.Server().AccompanimentEnabled {
		return true
	}
	writeError(w, http.StatusForbidden, "EV_ACCOMPANIMENT_DISABLED", "music playback is disabled")
	return false
}

func (r *Router) ensureFileCapableChannel(w http.ResponseWriter, channelID string) bool {
	channel, found := r.channelByID(channelID)
	if !found {
		writeError(w, http.StatusNotFound, "EV_CHANNEL_NOT_FOUND", "channel not found")
		return false
	}
	if channel.Type == domain.ChannelTypeCategory {
		writeError(w, http.StatusBadRequest, "EV_INVALID_CHANNEL", "category does not have file storage")
		return false
	}
	return true
}

func (r *Router) canManageFileEntry(memberID string, channelID string, entry domain.ChannelFileEntry) bool {
	if !r.store.MemberHasChannelPermission(memberID, channelID, domain.PermissionViewChannels) {
		return false
	}
	if entry.Type == domain.ChannelFileEntryFile && entry.OwnerMemberID == memberID {
		return true
	}
	return r.memberHasChannelFilePermission(memberID, channelID, domain.PermissionManageFiles)
}

func (r *Router) channelFileUploadParent(memberID string, channelID string, requestedParentID string) string {
	if !r.memberHasChannelFilePermission(memberID, channelID, domain.PermissionViewFiles) {
		return ""
	}
	return strings.TrimSpace(requestedParentID)
}

func (r *Router) memberHasChannelFilePermission(memberID string, channelID string, permission domain.Permission) bool {
	if !r.store.MemberHasChannelPermission(memberID, channelID, domain.PermissionViewChannels) {
		return false
	}
	permissions := []domain.Permission{permission}
	switch permission {
	case domain.PermissionViewFiles:
		permissions = append(permissions, domain.PermissionDownloadFiles, domain.PermissionManageFiles)
	case domain.PermissionUploadFiles, domain.PermissionDownloadFiles:
		permissions = append(permissions, domain.PermissionManageFiles)
	}
	for _, candidate := range permissions {
		if r.store.MemberHasChannelPermission(memberID, channelID, candidate) {
			return true
		}
	}
	return false
}

func (r *Router) contentRootPath() string {
	if strings.TrimSpace(r.cfg.Storage.ContentPath) != "" {
		return r.cfg.Storage.ContentPath
	}
	return "./data/content"
}

func (r *Router) contentObjectPath(sha string) string {
	prefix := "xx"
	if len(sha) >= 2 {
		prefix = sha[:2]
	}
	return filepath.Join(r.contentRootPath(), prefix, sha)
}

func (r *Router) maxChannelFileBytes() int64 {
	if r.cfg.Storage.MaxChannelFileMB > 0 {
		return int64(r.cfg.Storage.MaxChannelFileMB) * 1024 * 1024
	}
	return 512 * 1024 * 1024
}

func (r *Router) maxSoundboardBytes() int64 {
	if r.cfg.Storage.MaxSoundboardKB > 0 {
		return int64(r.cfg.Storage.MaxSoundboardKB) * 1024
	}
	return 2 * 1024 * 1024
}

func (r *Router) maxEmojiBytes() int64 {
	serverLimitKB := r.store.Server().EmojiMaxKB
	if serverLimitKB <= 0 {
		serverLimitKB = 1024
	}
	if r.cfg.Storage.MaxEmojiKB > 0 && serverLimitKB > r.cfg.Storage.MaxEmojiKB {
		serverLimitKB = r.cfg.Storage.MaxEmojiKB
	}
	return int64(serverLimitKB) * 1024
}

func (r *Router) maxPurposeAssetBytes() int64 {
	soundboard := r.maxSoundboardBytes()
	emoji := r.maxEmojiBytes()
	if soundboard > emoji {
		return soundboard
	}
	return emoji
}

func cleanFileEntryName(name string) string {
	name = strings.ReplaceAll(strings.TrimSpace(name), "\\", "/")
	name = filepath.Base(name)
	if name == "." || name == ".." || name == "/" {
		return ""
	}
	return strings.TrimSpace(name)
}

func nonEmptyString(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func (r *Router) channelPermissionOverrides(w http.ResponseWriter, req *http.Request, channelID string) {
	session, ok := r.requireAnyChannelPermission(
		w,
		req,
		channelID,
		domain.PermissionManageChannelPermissions,
		domain.PermissionManageChannels,
	)
	if !ok {
		return
	}
	switch req.Method {
	case http.MethodGet:
		writeJSON(w, http.StatusOK, map[string]any{"permission_overrides": nonNilSlice(r.store.ChannelPermissionOverrides(channelID))})
	case http.MethodPost:
		var input domain.ChannelPermissionOverride
		if err := readJSON(req, &input); err != nil {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
			return
		}
		input.ChannelID = channelID
		if input.TargetType == domain.OverrideTargetRole && !r.actorCanManageRole(session.MemberID, input.TargetID) && input.TargetID != domain.EveryoneRoleID {
			writeError(w, http.StatusForbidden, "EV_ROLE_HIERARCHY_DENIED", "role is above your highest role")
			return
		}
		override, err := r.store.SetChannelPermissionOverride(input)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "override target not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		log.Printf("admin action=channel.permission_override.set actor_member_id=%s channel_id=%s target_type=%s target_id=%s", session.MemberID, override.ChannelID, override.TargetType, override.TargetID)
		r.recordAudit(session.MemberID, "channel.permission_override.set", "channel", override.ChannelID, map[string]string{
			"override_id": override.OverrideID,
			"target_type": string(override.TargetType),
			"target_id":   override.TargetID,
		})
		r.broadcastChannelPermissionEvent(channelID, "channel.permission_override.updated", override)
		r.broadcastVisibleChannels()
		writeJSON(w, http.StatusOK, override)
	default:
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
	}
}

func (r *Router) channelPermissionOverrideResource(
	w http.ResponseWriter,
	req *http.Request,
	channelID string,
	overrideID string,
) {
	session, ok := r.requireAnyChannelPermission(
		w,
		req,
		channelID,
		domain.PermissionManageChannelPermissions,
		domain.PermissionManageChannels,
	)
	if !ok {
		return
	}
	if req.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	override, err := r.store.DeleteChannelPermissionOverride(channelID, overrideID)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "override not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	log.Printf("admin action=channel.permission_override.delete actor_member_id=%s channel_id=%s override_id=%s", session.MemberID, channelID, override.OverrideID)
	r.recordAudit(session.MemberID, "channel.permission_override.delete", "channel", channelID, map[string]string{
		"override_id": override.OverrideID,
		"target_type": string(override.TargetType),
		"target_id":   override.TargetID,
	})
	r.broadcastChannelPermissionEvent(channelID, "channel.permission_override.deleted", override)
	r.broadcastVisibleChannels()
	writeJSON(w, http.StatusOK, override)
}

func (r *Router) voiceStates(w http.ResponseWriter, req *http.Request) {
	session, ok := r.requirePermission(w, req, domain.PermissionViewChannels)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"voice_states": nonNilSlice(r.visibleVoiceStates(session.MemberID, session.DeviceID))})
}

func (r *Router) joinVoiceChannel(w http.ResponseWriter, req *http.Request, channelID string) {
	if req.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	session, ok := r.requireChannelPermission(w, req, channelID, domain.PermissionConnectVoice)
	if !ok {
		return
	}
	var input struct {
		Mode     string `json:"mode"`
		Takeover bool   `json:"takeover"`
	}
	if err := readJSON(req, &input); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	if input.Mode != "listener" {
		input.Mode = "primary"
	}
	previousState, previousStateFound := r.voiceStateByDevice(session.MemberID, session.DeviceID)
	if input.Mode == "primary" {
		if active, found := r.primaryVoiceStateByMember(session.MemberID); found && active.DeviceID != session.DeviceID {
			if !input.Takeover {
				writeError(w, http.StatusConflict, "EV_VOICE_DEVICE_CONFLICT", "another device is already active in voice")
				return
			}
			if removed, left, leaveErr := r.store.LeaveVoiceChannel(active.ParticipantID); leaveErr == nil && left {
				r.endMemberScreenShareSessions(session.MemberID, session.MemberID, "voice_device_displaced")
				r.endMemberAccompanimentSessions(session.MemberID, session.MemberID, "voice_device_displaced")
				r.removeScreenShareViewerDevice(session.ServerID, session.MemberID, active.DeviceID, "controller_device_displaced")
				r.hub.SendToDevice(session.ServerID, session.MemberID, active.DeviceID, ws.Event{Type: "voice.device.displaced", Payload: removed})
				r.broadcastVoiceState("voice.state.deleted", removed)
			}
		}
	}
	state, err := r.store.JoinVoiceChannel(channelID, session.MemberID, session.DeviceID, input.Mode)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_CHANNEL_NOT_FOUND", "voice channel not found")
		return
	}
	if errors.Is(err, store.ErrInvalidVoiceChannel) {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "channel is not a voice channel")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	log.Printf("voice action=voice.join member_id=%s device_id=%s channel_id=%s mode=%s", session.MemberID, shortLogID(session.DeviceID), state.ChannelID, state.Mode)
	if previousStateFound && previousState.ChannelID != state.ChannelID {
		r.endMemberScreenShareSessions(session.MemberID, session.MemberID, "voice_channel_changed")
		r.endMemberAccompanimentSessions(session.MemberID, session.MemberID, "voice_channel_changed")
		r.removeScreenShareViewerDevice(session.ServerID, session.MemberID, session.DeviceID, "controller_changed_channel")
	}
	r.broadcastVoiceState("voice.state.updated", state)
	writeJSON(w, http.StatusOK, state)
}

func (r *Router) voiceStateResource(w http.ResponseWriter, req *http.Request) {
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	switch req.Method {
	case http.MethodPatch:
		var input struct {
			MicMuted      bool `json:"mic_muted"`
			AudioDeafened bool `json:"audio_deafened"`
			IsSpeaking    bool `json:"is_speaking"`
		}
		if err := readJSON(req, &input); err != nil {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
			return
		}
		current, currentFound := r.voiceStateByDevice(session.MemberID, session.DeviceID)
		if !currentFound {
			writeError(w, http.StatusNotFound, "EV_VOICE_STATE_NOT_FOUND", "voice state not found")
			return
		}
		if current.Mode == "listener" && (!input.MicMuted || input.IsSpeaking) {
			writeError(w, http.StatusForbidden, "EV_VOICE_LISTEN_ONLY", "listen-only devices cannot enable a microphone")
			return
		}
		if input.IsSpeaking && !r.store.MemberHasChannelPermission(session.MemberID, current.ChannelID, domain.PermissionSpeak) {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission speak is required")
			return
		}
		state, err := r.store.UpdateVoiceState(current.ParticipantID, domain.VoiceState{
			MicMuted:      input.MicMuted,
			AudioDeafened: input.AudioDeafened,
			IsSpeaking:    input.IsSpeaking,
		})
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_VOICE_STATE_NOT_FOUND", "voice state not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		controlsChanged := state.MicMuted != current.MicMuted || state.AudioDeafened != current.AudioDeafened
		speakingChanged := state.IsSpeaking != current.IsSpeaking
		if controlsChanged {
			r.broadcastVoiceState("voice.state.updated", state)
			if state.IsSpeaking {
				r.broadcastVoiceSpeakingState(state)
			}
		} else if speakingChanged {
			r.broadcastVoiceSpeakingState(state)
		}
		writeJSON(w, http.StatusOK, state)
	case http.MethodDelete:
		current, found := r.voiceStateByDevice(session.MemberID, session.DeviceID)
		if !found {
			writeJSON(w, http.StatusOK, domain.VoiceState{})
			return
		}
		state, left, err := r.store.LeaveVoiceChannel(current.ParticipantID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		if left {
			log.Printf("voice action=voice.leave member_id=%s channel_id=%s", session.MemberID, state.ChannelID)
			if state.Mode != "listener" {
				r.endMemberScreenShareSessions(session.MemberID, session.MemberID, "voice_left")
				r.endMemberAccompanimentSessions(session.MemberID, session.MemberID, "voice_left")
			}
			r.removeScreenShareViewerDevice(session.ServerID, session.MemberID, session.DeviceID, "controller_left_voice")
			r.sendVisibleChannelsToMember(session.MemberID)
			r.broadcastVoiceState("voice.state.deleted", state)
		}
		writeJSON(w, http.StatusOK, state)
	default:
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
	}
}

func (r *Router) managedVoiceStateResource(w http.ResponseWriter, req *http.Request) {
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	resourceID := strings.Trim(strings.TrimPrefix(req.URL.Path, "/api/v1/voice-states/"), "/")
	if resourceID == "" || strings.Contains(resourceID, "/") {
		writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "route not found")
		return
	}
	previousState, previousStateFound := r.voiceStateByParticipant(resourceID)
	if !previousStateFound {
		previousState, previousStateFound = r.primaryVoiceStateByMember(resourceID)
	}
	if !previousStateFound {
		states := r.voiceStatesForMember(resourceID)
		if len(states) > 0 {
			previousState = states[0]
			previousStateFound = true
		}
	}
	if !previousStateFound {
		writeError(w, http.StatusNotFound, "EV_VOICE_STATE_NOT_FOUND", "voice state not found")
		return
	}
	memberID := previousState.MemberID
	memberStates := r.voiceStatesForMember(memberID)
	target, found := r.memberByID(memberID)
	if !found {
		writeError(w, http.StatusNotFound, "EV_MEMBER_NOT_FOUND", "member not found")
		return
	}
	isSelf := memberID == session.MemberID
	if !isSelf && !r.actorCanManageMember(session.MemberID, target) {
		writeError(w, http.StatusForbidden, "EV_ROLE_HIERARCHY_DENIED", "target member is above your highest role")
		return
	}
	if req.Method == http.MethodDelete {
		kickMode := strings.ToLower(strings.TrimSpace(req.URL.Query().Get("mode")))
		if kickMode == "" {
			kickMode = "notify"
		}
		if kickMode != "notify" && kickMode != "silent" {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "voice kick mode must be notify or silent")
			return
		}
		if isSelf {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "use the current device leave action to leave voice")
			return
		}
		if !r.hasPermission(session.MemberID, domain.PermissionMoveMembers) && !r.hasPermission(session.MemberID, domain.PermissionManageMembers) {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission move_members is required")
			return
		}
		removedStates, err := r.store.LeaveMemberVoiceChannels(memberID)
		if err != nil || len(removedStates) == 0 {
			writeError(w, http.StatusNotFound, "EV_VOICE_STATE_NOT_FOUND", "voice state not found")
			return
		}
		removed := voiceStateMatchingParticipant(removedStates, previousState.ParticipantID)
		r.endMemberScreenShareSessions(memberID, session.MemberID, "voice_member_kicked")
		r.endMemberAccompanimentSessions(memberID, session.MemberID, "voice_member_kicked")
		r.removeScreenShareViewerFromAll(memberID)
		r.recordAudit(session.MemberID, "voice.member.kick", "member", memberID, map[string]string{
			"channel_id":     removed.ChannelID,
			"participant_id": removed.ParticipantID,
			"device_count":   strconv.Itoa(len(removedStates)),
			"mode":           kickMode,
		})
		log.Printf("admin action=voice.kick actor_member_id=%s target_member_id=%s channel_id=%s device_count=%d mode=%s", session.MemberID, memberID, removed.ChannelID, len(removedStates), kickMode)
		kickEventType := "voice.device.kicked"
		if kickMode == "silent" {
			kickEventType = "voice.device.kicked.silent"
		}
		for _, state := range removedStates {
			r.hub.SendToDevice(session.ServerID, memberID, state.DeviceID, ws.Event{Type: kickEventType, Payload: state})
			r.broadcastVoiceState("voice.state.deleted", state)
		}
		r.sendVisibleChannelsToMember(memberID)
		writeJSON(w, http.StatusOK, removed)
		return
	}
	if req.Method != http.MethodPatch {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	var input struct {
		ChannelID      string `json:"channel_id"`
		ServerMuted    *bool  `json:"server_muted"`
		ServerDeafened *bool  `json:"server_deafened"`
	}
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	input.ChannelID = strings.TrimSpace(input.ChannelID)
	if input.ChannelID != "" {
		channel, channelFound := r.channelByID(input.ChannelID)
		if !channelFound {
			writeError(w, http.StatusNotFound, "EV_CHANNEL_NOT_FOUND", "voice channel not found")
			return
		}
		if channel.Type != domain.ChannelTypeVoice && channel.Type != domain.ChannelTypeTemporaryVoice {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "channel is not a voice channel")
			return
		}
	}
	hasChannelMove := false
	hasMuteChange := false
	hasDeafenChange := false
	for _, state := range memberStates {
		hasChannelMove = hasChannelMove || (input.ChannelID != "" && input.ChannelID != state.ChannelID)
		desiredDeafened := state.ServerDeafened
		if input.ServerDeafened != nil {
			desiredDeafened = *input.ServerDeafened
		}
		desiredMuted := state.ServerMuted
		if input.ServerMuted != nil {
			desiredMuted = *input.ServerMuted
		}
		desiredMuted = desiredMuted || desiredDeafened
		hasMuteChange = hasMuteChange || desiredMuted != state.ServerMuted
		hasDeafenChange = hasDeafenChange || desiredDeafened != state.ServerDeafened
	}
	if isSelf {
		if !hasChannelMove || input.ServerMuted != nil || input.ServerDeafened != nil {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "you may only move your own linked voice devices")
			return
		}
		if !r.store.MemberHasChannelPermission(memberID, input.ChannelID, domain.PermissionConnectVoice) {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission connect_voice is required")
			return
		}
	}
	requiredPermissions := []domain.Permission{}
	if !isSelf && hasChannelMove {
		requiredPermissions = append(requiredPermissions, domain.PermissionMoveMembers)
	}
	if !isSelf && hasMuteChange {
		requiredPermissions = append(requiredPermissions, domain.PermissionMuteMembers)
	}
	if !isSelf && hasDeafenChange {
		requiredPermissions = append(requiredPermissions, domain.PermissionDeafenMembers)
	}
	for _, permission := range requiredPermissions {
		if !r.hasPermission(session.MemberID, permission) && !r.hasPermission(session.MemberID, domain.PermissionManageMembers) {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission "+string(permission)+" is required")
			return
		}
	}
	updatedStates := make([]domain.VoiceState, 0, len(memberStates))
	for _, current := range memberStates {
		serverMuted := current.ServerMuted
		if input.ServerMuted != nil {
			serverMuted = *input.ServerMuted
		}
		serverDeafened := current.ServerDeafened
		if input.ServerDeafened != nil {
			serverDeafened = *input.ServerDeafened
		}
		state, err := r.store.ManageVoiceState(current.ParticipantID, domain.VoiceState{
			ChannelID:      input.ChannelID,
			ServerMuted:    serverMuted || serverDeafened,
			ServerDeafened: serverDeafened,
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		updatedStates = append(updatedStates, state)
	}
	state := voiceStateMatchingParticipant(updatedStates, previousState.ParticipantID)
	log.Printf("admin action=voice.manage actor_member_id=%s target_member_id=%s channel_id=%s server_muted=%t server_deafened=%t device_count=%d", session.MemberID, state.MemberID, state.ChannelID, state.ServerMuted, state.ServerDeafened, len(updatedStates))
	if !isSelf {
		r.recordVoiceManagementAudit(session.MemberID, target, previousState, previousStateFound, state)
	}
	if hasChannelMove {
		r.endMemberScreenShareSessions(memberID, session.MemberID, "voice_member_moved")
		r.endMemberAccompanimentSessions(memberID, session.MemberID, "voice_member_moved")
		r.removeScreenShareViewerFromAll(memberID)
		r.sendVisibleChannelsToMember(memberID)
		r.sendVoiceStateSnapshotsToMember(memberID)
	}
	for _, updated := range updatedStates {
		r.broadcastVoiceState("voice.state.updated", updated)
	}
	writeJSON(w, http.StatusOK, state)
}

func (r *Router) screenShareSessions(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	items := []domain.ScreenShareSession{}
	for _, share := range r.store.ScreenShareSessions() {
		if r.store.MemberHasChannelPermission(session.MemberID, share.ChannelID, domain.PermissionViewChannels) {
			items = append(items, share)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"screen_shares": nonNilSlice(items)})
}

func (r *Router) accompanimentSessions(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	items := []domain.AccompanimentSession{}
	for _, accompaniment := range r.store.AccompanimentSessions() {
		if r.store.MemberHasChannelPermission(session.MemberID, accompaniment.ChannelID, domain.PermissionViewChannels) {
			items = append(items, accompaniment)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"accompaniments": nonNilSlice(items)})
}

func (r *Router) startAccompanimentSession(w http.ResponseWriter, req *http.Request, channelID string) {
	if req.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	if !r.ensureAccompanimentEnabled(w) {
		return
	}
	session, ok := r.requireChannelPermission(w, req, channelID, domain.PermissionPlayAccompaniment)
	if !ok {
		return
	}
	currentVoice, inVoice := r.voiceStateByDevice(session.MemberID, session.DeviceID)
	if !inVoice || currentVoice.ChannelID != channelID {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "you must be in the voice channel to play music")
		return
	}
	if currentVoice.Mode == "listener" {
		writeError(w, http.StatusForbidden, "EV_VOICE_LISTEN_ONLY", "listen-only devices cannot play music")
		return
	}
	var input struct {
		SourceName string `json:"source_name"`
	}
	if err := readJSON(req, &input); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	input.SourceName = strings.TrimSpace(input.SourceName)
	if input.SourceName == "" {
		input.SourceName = "Desktop audio"
	}
	if len([]rune(input.SourceName)) > 120 {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "music source name is too long")
		return
	}
	accompaniment, err := r.store.StartAccompanimentSession(domain.AccompanimentSession{
		ChannelID:     channelID,
		OwnerMemberID: session.MemberID,
		SourceName:    input.SourceName,
	})
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_CHANNEL_NOT_FOUND", "voice channel or member not found")
		return
	}
	if errors.Is(err, store.ErrInvalidVoiceChannel) {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "channel is not a voice channel")
		return
	}
	if errors.Is(err, store.ErrAccompanimentActive) {
		writeError(w, http.StatusConflict, "EV_ACCOMPANIMENT_ACTIVE", "member is already playing music")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	r.recordAudit(session.MemberID, "accompaniment.start", "accompaniment", accompaniment.SessionID, map[string]string{
		"channel_id":   accompaniment.ChannelID,
		"channel_name": r.channelAuditName(accompaniment.ChannelID),
		"source_name":  accompaniment.SourceName,
	})
	r.broadcastChannelEvent(accompaniment.ChannelID, "accompaniment.started", accompaniment)
	writeJSON(w, http.StatusCreated, accompaniment)
}

func (r *Router) accompanimentResource(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	sessionID := strings.Trim(strings.TrimPrefix(req.URL.Path, "/api/v1/accompaniments/"), "/")
	if sessionID == "" || strings.Contains(sessionID, "/") {
		writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "route not found")
		return
	}
	accompaniment, err := r.store.EndAccompanimentSession(
		sessionID,
		session.MemberID,
		r.hasPermission(session.MemberID, domain.PermissionManageMembers),
	)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_ACCOMPANIMENT_NOT_FOUND", "music playback session not found")
		return
	}
	if errors.Is(err, store.ErrForbidden) {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "music playback session cannot be managed")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	r.recordAudit(session.MemberID, "accompaniment.end", "accompaniment", accompaniment.SessionID, map[string]string{
		"channel_id":      accompaniment.ChannelID,
		"channel_name":    r.channelAuditName(accompaniment.ChannelID),
		"owner_member_id": accompaniment.OwnerMemberID,
		"source_name":     accompaniment.SourceName,
	})
	r.broadcastChannelEvent(accompaniment.ChannelID, "accompaniment.ended", accompaniment)
	writeJSON(w, http.StatusOK, accompaniment)
}

func (r *Router) startScreenShareSession(w http.ResponseWriter, req *http.Request, channelID string) {
	if req.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	if !r.ensureScreenShareEnabled(w) {
		return
	}
	session, ok := r.requireChannelPermission(w, req, channelID, domain.PermissionShareScreen)
	if !ok {
		return
	}
	currentVoice, inVoice := r.voiceStateByDevice(session.MemberID, session.DeviceID)
	if !inVoice || currentVoice.ChannelID != channelID {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "you must be in the voice channel to share your screen")
		return
	}
	if currentVoice.Mode == "listener" {
		writeError(w, http.StatusForbidden, "EV_VOICE_LISTEN_ONLY", "listen-only devices cannot share a screen")
		return
	}
	var input struct {
		RemoteControlAllowed bool `json:"remote_control_allowed"`
	}
	if err := readJSON(req, &input); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	if input.RemoteControlAllowed {
		if !r.store.Server().RemoteControlEnabled {
			writeError(w, http.StatusForbidden, "EV_REMOTE_CONTROL_DISABLED", "remote control is disabled")
			return
		}
		if !r.store.MemberHasChannelPermission(session.MemberID, channelID, domain.PermissionAcceptControl) {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission "+string(domain.PermissionAcceptControl)+" is required")
			return
		}
	}
	share, err := r.store.StartScreenShareSession(domain.ScreenShareSession{
		ChannelID:            channelID,
		OwnerMemberID:        session.MemberID,
		OwnerParticipantID:   currentVoice.ParticipantID,
		RemoteControlAllowed: input.RemoteControlAllowed,
	})
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_CHANNEL_NOT_FOUND", "voice channel not found")
		return
	}
	if errors.Is(err, store.ErrInvalidVoiceChannel) {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "channel is not a voice channel")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	r.recordAudit(session.MemberID, "screen_share.start", "screen_share", share.ShareID, map[string]string{
		"channel_id":             share.ChannelID,
		"channel_name":           r.channelAuditName(share.ChannelID),
		"remote_control_allowed": strconv.FormatBool(share.RemoteControlAllowed),
	})
	log.Printf("media action=screen_share.start member_id=%s device_id=%s channel_id=%s share_id=%s", session.MemberID, shortLogID(session.DeviceID), share.ChannelID, share.ShareID)
	r.broadcastChannelEvent(share.ChannelID, "screen_share.started", share)
	writeJSON(w, http.StatusCreated, share)
}

func (r *Router) screenShareResource(w http.ResponseWriter, req *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(req.URL.Path, "/api/v1/screen-shares/"), "/"), "/")
	if len(parts) == 2 && parts[1] == "viewer" {
		r.screenShareViewerResource(w, req, parts[0])
		return
	}
	if len(parts) == 2 && parts[1] == "signal" {
		r.screenShareSignalResource(w, req, parts[0])
		return
	}
	if len(parts) == 2 && parts[1] == "signals" {
		r.screenShareSignalsResource(w, req, parts[0])
		return
	}
	if len(parts) == 2 && parts[1] == "control-requests" {
		r.requestRemoteControl(w, req, parts[0])
		return
	}
	if req.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	if len(parts) != 1 || parts[0] == "" {
		writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "route not found")
		return
	}
	shareID := parts[0]
	share, err := r.store.EndScreenShareSession(
		shareID,
		session.MemberID,
		r.hasPermission(session.MemberID, domain.PermissionManageMembers),
	)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_SCREEN_SHARE_NOT_FOUND", "screen share session not found")
		return
	}
	if errors.Is(err, store.ErrForbidden) {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "screen share session cannot be managed")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	r.recordAudit(session.MemberID, "screen_share.end", "screen_share", share.ShareID, map[string]string{
		"channel_id":      share.ChannelID,
		"channel_name":    r.channelAuditName(share.ChannelID),
		"owner_member_id": share.OwnerMemberID,
	})
	log.Printf("media action=screen_share.end actor_member_id=%s owner_member_id=%s channel_id=%s share_id=%s reason=user_request", session.MemberID, share.OwnerMemberID, share.ChannelID, share.ShareID)
	r.discardScreenShareSignals(share.ShareID)
	r.clearScreenShareViewerSessions(share.ShareID)
	r.endRemoteControlsForShare(share.ShareID, session.MemberID, "screen_share_ended")
	r.broadcastChannelEvent(share.ChannelID, "screen_share.ended", share)
	writeJSON(w, http.StatusOK, share)
}

func (r *Router) screenShareViewerResource(w http.ResponseWriter, req *http.Request, shareID string) {
	if req.Method != http.MethodPost && req.Method != http.MethodDelete {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	share, found := r.screenShareByID(shareID)
	if !found {
		writeError(w, http.StatusNotFound, "EV_SCREEN_SHARE_NOT_FOUND", "screen share session not found")
		return
	}
	if share.OwnerMemberID == session.MemberID {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "screen share owner cannot watch themselves")
		return
	}
	if !r.store.MemberHasChannelPermission(session.MemberID, share.ChannelID, domain.PermissionViewChannels) {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission "+string(domain.PermissionViewChannels)+" is required")
		return
	}
	state, ok := r.voiceStateByDevice(session.MemberID, session.DeviceID)
	if !ok || state.ChannelID != share.ChannelID {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "you must be in the voice channel to watch this screen share")
		return
	}
	watching := req.Method == http.MethodPost
	watchSessionID := ""
	var input struct {
		WatchSessionID string `json:"watch_session_id"`
	}
	if err := readJSON(req, &input); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	watchSessionID = strings.TrimSpace(input.WatchSessionID)
	if len(watchSessionID) > 160 {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "watch session id is too long")
		return
	}
	updated, changed, ignored, err := r.setScreenShareViewerSession(
		share,
		session.ServerID,
		session.MemberID,
		session.DeviceID,
		watchSessionID,
		watching,
	)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "EV_SCREEN_SHARE_NOT_FOUND", "screen share session not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	log.Printf(
		"rtc action=screen_share.viewer.http share_id=%s viewer_member_id=%s device_id=%s watch_session_id=%s watching=%t changed=%t ignored=%t viewer_count=%d",
		shareID,
		session.MemberID,
		session.DeviceID,
		watchSessionID,
		watching,
		changed,
		ignored,
		len(updated.ViewerMemberIDs),
	)
	if changed {
		r.broadcastChannelEvent(updated.ChannelID, "screen_share.updated", updated)
	}
	if !ignored {
		r.sendScreenShareViewerSignal(session, updated, watching, watchSessionID)
	}
	if !watching && !ignored {
		r.endRemoteControlsForController(state.ParticipantID, "controller_stopped_watching")
	}
	writeJSON(w, http.StatusOK, updated)
}

func (r *Router) setScreenShareViewerSession(
	share domain.ScreenShareSession,
	serverID string,
	memberID string,
	deviceID string,
	watchSessionID string,
	watching bool,
) (domain.ScreenShareSession, bool, bool, error) {
	r.screenViewerMu.Lock()
	defer r.screenViewerMu.Unlock()

	key := screenShareViewerSessionKey(serverID, share.ShareID, memberID, deviceID)
	existing, exists := r.screenViewerSessions[key]
	if watching {
		if exists && existing.WatchSessionID == watchSessionID {
			return share, false, true, nil
		}
		memberAlreadyWatching := r.hasScreenShareViewerSessionLocked(serverID, share.ShareID, memberID, "")
		r.screenViewerSessions[key] = screenShareViewerSession{
			ServerID:       serverID,
			ShareID:        share.ShareID,
			MemberID:       memberID,
			DeviceID:       deviceID,
			WatchSessionID: watchSessionID,
		}
		if memberAlreadyWatching || containsMemberID(share.ViewerMemberIDs, memberID) {
			return share, false, false, nil
		}
		updated, err := r.store.SetScreenShareViewer(share.ShareID, memberID, true)
		if err != nil {
			if exists {
				r.screenViewerSessions[key] = existing
			} else {
				delete(r.screenViewerSessions, key)
			}
			return domain.ScreenShareSession{}, false, false, err
		}
		return updated, true, false, nil
	}

	if exists && existing.WatchSessionID != watchSessionID {
		return share, false, true, nil
	}
	if exists {
		delete(r.screenViewerSessions, key)
	}
	if r.hasScreenShareViewerSessionLocked(serverID, share.ShareID, memberID, "") {
		return share, false, false, nil
	}
	if !containsMemberID(share.ViewerMemberIDs, memberID) {
		return share, false, !exists, nil
	}
	updated, err := r.store.SetScreenShareViewer(share.ShareID, memberID, false)
	if err != nil {
		if exists {
			r.screenViewerSessions[key] = existing
		}
		return domain.ScreenShareSession{}, false, false, err
	}
	return updated, true, false, nil
}

func (r *Router) hasScreenShareViewerSessionLocked(serverID string, shareID string, memberID string, exceptDeviceID string) bool {
	for _, viewer := range r.screenViewerSessions {
		if viewer.ServerID == serverID && viewer.ShareID == shareID && viewer.MemberID == memberID && viewer.DeviceID != exceptDeviceID {
			return true
		}
	}
	return false
}

func (r *Router) hasScreenShareViewerSession(serverID string, shareID string, memberID string, deviceID string) bool {
	r.screenViewerMu.Lock()
	defer r.screenViewerMu.Unlock()
	_, found := r.screenViewerSessions[screenShareViewerSessionKey(serverID, shareID, memberID, deviceID)]
	return found
}

func (r *Router) drainCurrentViewerScreenShareSignals(
	serverID string,
	shareID string,
	memberID string,
	deviceID string,
	targetParticipantID string,
	watchSessionID string,
) ([]domain.RTCSignal, bool) {
	r.screenViewerMu.Lock()
	defer r.screenViewerMu.Unlock()
	viewer, ok := r.screenViewerSessions[screenShareViewerSessionKey(serverID, shareID, memberID, deviceID)]
	if !ok || viewer.WatchSessionID != watchSessionID {
		return nil, false
	}
	return r.drainScreenShareSignals(serverID, memberID, targetParticipantID, shareID, watchSessionID), true
}

func (r *Router) clearScreenShareViewerSessions(shareID string) {
	if shareID == "" {
		return
	}
	r.screenViewerMu.Lock()
	defer r.screenViewerMu.Unlock()
	for key, viewer := range r.screenViewerSessions {
		if viewer.ShareID == shareID {
			delete(r.screenViewerSessions, key)
		}
	}
}

func (r *Router) clearMemberScreenShareViewerSessions(memberID string) {
	if memberID == "" {
		return
	}
	r.screenViewerMu.Lock()
	defer r.screenViewerMu.Unlock()
	for key, viewer := range r.screenViewerSessions {
		if viewer.MemberID == memberID {
			delete(r.screenViewerSessions, key)
		}
	}
}

func (r *Router) clearDeviceScreenShareViewerSessions(serverID string, memberID string, deviceID string) []string {
	if serverID == "" || memberID == "" || deviceID == "" {
		return nil
	}
	r.screenViewerMu.Lock()
	defer r.screenViewerMu.Unlock()
	removedShareIDs := make(map[string]struct{})
	for key, viewer := range r.screenViewerSessions {
		if viewer.ServerID == serverID && viewer.MemberID == memberID && viewer.DeviceID == deviceID {
			removedShareIDs[viewer.ShareID] = struct{}{}
			delete(r.screenViewerSessions, key)
		}
	}
	lastViewerShareIDs := make([]string, 0, len(removedShareIDs))
	for shareID := range removedShareIDs {
		if !r.hasScreenShareViewerSessionLocked(serverID, shareID, memberID, "") {
			lastViewerShareIDs = append(lastViewerShareIDs, shareID)
		}
	}
	return lastViewerShareIDs
}

type screenShareSignalRequest struct {
	TargetMemberID      string          `json:"target_member_id"`
	TargetParticipantID string          `json:"target_participant_id"`
	SignalType          string          `json:"signal_type"`
	Data                json.RawMessage `json:"data"`
}

func (r *Router) screenShareSignalResource(w http.ResponseWriter, req *http.Request, shareID string) {
	if req.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	share, found := r.screenShareByID(shareID)
	if !found {
		writeError(w, http.StatusNotFound, "EV_SCREEN_SHARE_NOT_FOUND", "screen share session not found")
		return
	}
	var input screenShareSignalRequest
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	if input.SignalType != "screen-share-offer" && input.SignalType != "screen-share-answer" && input.SignalType != "screen-share-ice-candidate" {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "screen share signal type is unsupported")
		return
	}
	if !r.store.MemberHasChannelPermission(session.MemberID, share.ChannelID, domain.PermissionViewChannels) {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission "+string(domain.PermissionViewChannels)+" is required")
		return
	}
	senderState, ok := r.voiceStateByDevice(session.MemberID, session.DeviceID)
	if !ok || senderState.ChannelID != share.ChannelID {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "you must be in the voice channel to send screen share signal")
		return
	}
	isOwner := session.MemberID == share.OwnerMemberID && senderState.ParticipantID == share.OwnerParticipantID
	if session.MemberID == share.OwnerMemberID && !isOwner {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "only the sharing device can send owner screen share signals")
		return
	}
	if isOwner && input.SignalType == "screen-share-answer" {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "screen share owner cannot send an answer")
		return
	}
	if !isOwner {
		if !containsMemberID(share.ViewerMemberIDs, session.MemberID) {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "only an active viewer can send viewer screen share signals")
			return
		}
		if input.SignalType == "screen-share-offer" {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "screen share viewer cannot send an offer")
			return
		}
	}

	var targetState domain.VoiceState
	if isOwner {
		if input.TargetParticipantID != "" {
			targetState, ok = r.voiceStateByParticipant(input.TargetParticipantID)
		} else {
			targetState, ok = r.voiceStateByMember(input.TargetMemberID)
		}
		if !ok || targetState.ChannelID != share.ChannelID || targetState.MemberID == share.OwnerMemberID ||
			!containsMemberID(share.ViewerMemberIDs, targetState.MemberID) ||
			(input.TargetMemberID != "" && input.TargetMemberID != targetState.MemberID) {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "screen share signal target must be an active viewer")
			return
		}
	} else {
		if (input.TargetMemberID != "" && input.TargetMemberID != share.OwnerMemberID) ||
			(input.TargetParticipantID != "" && input.TargetParticipantID != share.OwnerParticipantID) {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "screen share viewer signal target must be the owner")
			return
		}
		targetState, ok = r.voiceStateByParticipant(share.OwnerParticipantID)
	}
	if !ok || targetState.ChannelID != share.ChannelID {
		log.Printf(
			"rtc action=screen_share.signal.http_drop from_member_id=%s target_member_id=%s channel_id=%s type=%s share_id=%s reason=target_not_in_channel",
			session.MemberID,
			input.TargetMemberID,
			share.ChannelID,
			input.SignalType,
			share.ShareID,
		)
		writeJSON(w, http.StatusOK, map[string]any{"delivered": false})
		return
	}
	data, err := screenShareSignalDataWithShareID(input.Data, share.ShareID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	signal := domain.RTCSignal{
		ChannelID:           share.ChannelID,
		FromMemberID:        session.MemberID,
		FromParticipantID:   senderState.ParticipantID,
		TargetMemberID:      targetState.MemberID,
		TargetParticipantID: targetState.ParticipantID,
		SignalType:          input.SignalType,
		Data:                data,
	}
	delivered := r.hub.SendToDevice(session.ServerID, targetState.MemberID, targetState.DeviceID, ws.Event{Type: "rtc.signal", Payload: signal})
	queued := !delivered
	if queued {
		r.enqueueScreenShareSignal(session.ServerID, targetState.MemberID, signal)
	}
	if shouldLogScreenShareSignal(signal.SignalType) {
		log.Printf(
			"rtc action=screen_share.signal.http_forward from_member_id=%s target_member_id=%s channel_id=%s type=%s share_id=%s delivered=%t queued=%t",
			signal.FromMemberID,
			signal.TargetMemberID,
			signal.ChannelID,
			signal.SignalType,
			share.ShareID,
			delivered,
			queued,
		)
	}
	writeJSON(w, http.StatusOK, map[string]any{"delivered": delivered, "queued": queued})
}

func (r *Router) screenShareSignalsResource(w http.ResponseWriter, req *http.Request, shareID string) {
	if req.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	share, found := r.screenShareByID(shareID)
	if !found {
		writeError(w, http.StatusNotFound, "EV_SCREEN_SHARE_NOT_FOUND", "screen share session not found")
		return
	}
	state, ok := r.voiceStateByDevice(session.MemberID, session.DeviceID)
	if !ok || state.ChannelID != share.ChannelID {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "screen share participant must be in the voice channel")
		return
	}
	isOwner := share.OwnerMemberID == session.MemberID && state.ParticipantID == share.OwnerParticipantID
	isViewer := containsMemberID(share.ViewerMemberIDs, session.MemberID)
	if !isOwner && !isViewer {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "only the screen share owner or an active viewer can drain signals")
		return
	}
	watchSessionID := strings.TrimSpace(req.URL.Query().Get("watch_session_id"))
	if len(watchSessionID) > 160 {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "watch session id is too long")
		return
	}
	var signals []domain.RTCSignal
	if !isOwner && watchSessionID != "" {
		var current bool
		signals, current = r.drainCurrentViewerScreenShareSignals(
			session.ServerID,
			share.ShareID,
			session.MemberID,
			session.DeviceID,
			state.ParticipantID,
			watchSessionID,
		)
		if !current {
			writeJSON(w, http.StatusOK, map[string]any{"signals": []domain.RTCSignal{}})
			return
		}
	} else {
		signals = r.drainScreenShareSignals(
			session.ServerID,
			session.MemberID,
			state.ParticipantID,
			share.ShareID,
			watchSessionID,
		)
	}
	if signals == nil {
		signals = []domain.RTCSignal{}
	}
	if len(signals) > 0 {
		log.Printf(
			"rtc action=screen_share.signal.http_drain target_member_id=%s share_id=%s count=%d",
			session.MemberID,
			share.ShareID,
			len(signals),
		)
	}
	writeJSON(w, http.StatusOK, map[string]any{"signals": signals})
}

func (r *Router) sendScreenShareViewerSignal(
	session auth.Session,
	share domain.ScreenShareSession,
	watching bool,
	watchSessionID string,
) {
	signalType := "screen-share-unwatch"
	if watching {
		signalType = "screen-share-watch"
	}
	dataPayload := map[string]string{"share_id": share.ShareID}
	if watchSessionID != "" {
		dataPayload["watch_session_id"] = watchSessionID
	}
	data, err := json.Marshal(dataPayload)
	if err != nil {
		return
	}
	ownerState, found := r.voiceStateByParticipant(share.OwnerParticipantID)
	if !found {
		return
	}
	signal := domain.RTCSignal{
		ChannelID:           share.ChannelID,
		FromMemberID:        session.MemberID,
		FromParticipantID:   domain.VoiceParticipantID(session.MemberID, session.DeviceID),
		TargetMemberID:      share.OwnerMemberID,
		TargetParticipantID: share.OwnerParticipantID,
		SignalType:          signalType,
		Data:                data,
	}
	delivered := r.hub.SendToDevice(session.ServerID, share.OwnerMemberID, ownerState.DeviceID, ws.Event{
		Type:    "rtc.signal",
		Payload: signal,
	})
	queued := !delivered
	if queued {
		r.enqueueScreenShareSignal(session.ServerID, share.OwnerMemberID, signal)
	}
	log.Printf(
		"rtc action=screen_share.viewer.synthetic_signal share_id=%s from_member_id=%s target_member_id=%s type=%s delivered=%t queued=%t",
		share.ShareID,
		session.MemberID,
		share.OwnerMemberID,
		signalType,
		delivered,
		queued,
	)
}

func (r *Router) endMemberScreenShareSessions(ownerMemberID string, actorMemberID string, reason string) {
	for _, share := range r.store.ScreenShareSessions() {
		if share.OwnerMemberID != ownerMemberID {
			continue
		}
		ended, err := r.store.EndScreenShareSession(share.ShareID, actorMemberID, true)
		if err != nil {
			continue
		}
		r.recordAudit(actorMemberID, "screen_share.end", "screen_share", ended.ShareID, map[string]string{
			"channel_id":      ended.ChannelID,
			"channel_name":    r.channelAuditName(ended.ChannelID),
			"owner_member_id": ended.OwnerMemberID,
			"reason":          reason,
		})
		log.Printf("media action=screen_share.end actor_member_id=%s owner_member_id=%s channel_id=%s share_id=%s reason=%s", actorMemberID, ended.OwnerMemberID, ended.ChannelID, ended.ShareID, reason)
		r.discardScreenShareSignals(ended.ShareID)
		r.clearScreenShareViewerSessions(ended.ShareID)
		r.endRemoteControlsForShare(ended.ShareID, actorMemberID, reason)
		r.broadcastChannelEvent(ended.ChannelID, "screen_share.ended", ended)
	}
}

func (r *Router) endMemberAccompanimentSessions(ownerMemberID string, actorMemberID string, reason string) {
	for _, accompaniment := range r.store.AccompanimentSessions() {
		if accompaniment.OwnerMemberID != ownerMemberID {
			continue
		}
		ended, err := r.store.EndAccompanimentSession(accompaniment.SessionID, actorMemberID, true)
		if err != nil {
			continue
		}
		r.recordAudit(actorMemberID, "accompaniment.end", "accompaniment", ended.SessionID, map[string]string{
			"channel_id":      ended.ChannelID,
			"channel_name":    r.channelAuditName(ended.ChannelID),
			"owner_member_id": ended.OwnerMemberID,
			"source_name":     ended.SourceName,
			"reason":          reason,
		})
		r.broadcastChannelEvent(ended.ChannelID, "accompaniment.ended", ended)
	}
}

func (r *Router) removeScreenShareViewerFromAll(memberID string) {
	r.endRemoteControlsForControllerMember(memberID, "controller_left_voice")
	r.clearMemberScreenShareViewerSessions(memberID)
	for _, share := range r.store.RemoveScreenShareViewerFromAll(memberID) {
		r.broadcastChannelEvent(share.ChannelID, "screen_share.updated", share)
	}
}

func (r *Router) removeScreenShareViewerDevice(serverID string, memberID string, deviceID string, reason string) {
	participantID := domain.VoiceParticipantID(memberID, deviceID)
	r.endRemoteControlsForController(participantID, reason)
	for _, shareID := range r.clearDeviceScreenShareViewerSessions(serverID, memberID, deviceID) {
		updated, err := r.store.SetScreenShareViewer(shareID, memberID, false)
		if err == nil {
			r.broadcastChannelEvent(updated.ChannelID, "screen_share.updated", updated)
		}
	}
}

func (r *Router) channelResource(w http.ResponseWriter, req *http.Request, channelID string) {
	switch req.Method {
	case http.MethodPatch:
		session, ok := r.requireChannelPermission(w, req, channelID, domain.PermissionManageChannels)
		if !ok {
			return
		}
		var input struct {
			Name             *string                                `json:"name"`
			Topic            *string                                `json:"topic"`
			ParentID         *string                                `json:"parent_id"`
			Position         *int                                   `json:"position"`
			Visibility       *string                                `json:"visibility"`
			WarningText      *string                                `json:"warning_text"`
			Bitrate          *int                                   `json:"bitrate"`
			UserLimit        *int                                   `json:"user_limit"`
			PermissionSynced *bool                                  `json:"permission_synced"`
			DefaultLanguage  *string                                `json:"default_language"`
			Localizations    *map[string]domain.ChannelLocalization `json:"localizations"`
		}
		if err := readJSON(req, &input); err != nil {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
			return
		}
		channel, found := r.channelByID(channelID)
		if !found {
			writeError(w, http.StatusNotFound, "EV_CHANNEL_NOT_FOUND", "channel not found")
			return
		}
		if input.Name != nil {
			channel.Name = strings.TrimSpace(*input.Name)
			if channel.Name == "" {
				writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "channel name is required")
				return
			}
		}
		if input.Topic != nil {
			channel.Topic = *input.Topic
		}
		if input.ParentID != nil {
			channel.ParentID = strings.TrimSpace(*input.ParentID)
		}
		if input.Position != nil {
			if *input.Position < 0 {
				writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "channel position is invalid")
				return
			}
			channel.Position = *input.Position
		}
		if input.Visibility != nil {
			channel.Visibility = strings.TrimSpace(*input.Visibility)
			if !validChannelVisibility(channel.Visibility) {
				writeError(w, http.StatusBadRequest, "EV_CHANNEL_VISIBILITY_INVALID", "channel visibility is invalid")
				return
			}
		}
		if input.WarningText != nil {
			channel.WarningText = strings.TrimSpace(*input.WarningText)
		}
		if input.Bitrate != nil {
			channel.Bitrate = *input.Bitrate
		}
		if input.UserLimit != nil {
			channel.UserLimit = *input.UserLimit
		}
		if input.PermissionSynced != nil {
			channel.PermissionSynced = *input.PermissionSynced
		}
		if input.DefaultLanguage != nil {
			channel.DefaultLanguage = strings.TrimSpace(*input.DefaultLanguage)
		}
		if input.Localizations != nil {
			channel.Localizations = *input.Localizations
		}
		if !validLanguageID(channel.DefaultLanguage, true) || !validChannelLocalizations(channel.Localizations) {
			writeError(w, http.StatusBadRequest, "EV_CHANNEL_LOCALIZATION_INVALID", "channel language settings are invalid")
			return
		}
		if channel.Type == domain.ChannelTypeCategory {
			channel.ParentID = ""
			channel.Topic = ""
			channel.Visibility = "default"
			channel.WarningText = ""
			channel.Bitrate = 0
			channel.UserLimit = 0
			channel.PermissionSynced = false
		} else if channel.ParentID != "" && !r.validCategoryParent(channelID, channel.ParentID) {
			writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "channel parent is invalid")
			return
		}
		if channel.Visibility == "warning" && channel.WarningText == "" {
			writeError(w, http.StatusBadRequest, "EV_CHANNEL_WARNING_REQUIRED", "warning channels require warning text")
			return
		}
		if channel.Bitrate < 0 || channel.Bitrate > 512000 || channel.UserLimit < 0 || channel.UserLimit > 1000 {
			writeError(w, http.StatusBadRequest, "EV_CHANNEL_VOICE_SETTINGS_INVALID", "voice bitrate or user limit is invalid")
			return
		}
		channel, err := r.store.UpdateChannel(channelID, channel)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_CHANNEL_NOT_FOUND", "channel not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		if channel.PermissionSynced && channel.ParentID != "" {
			for _, override := range r.store.ChannelPermissionOverrides(channel.ChannelID) {
				removed, deleteErr := r.store.DeleteChannelPermissionOverride(channel.ChannelID, override.OverrideID)
				if deleteErr == nil {
					r.broadcastChannelPermissionEvent(channel.ChannelID, "channel.permission_override.deleted", removed)
				}
			}
		}
		log.Printf("admin action=channel.update actor_member_id=%s channel_id=%s type=%s name=%q parent_id=%s position=%d", session.MemberID, channel.ChannelID, channel.Type, channel.Name, channel.ParentID, channel.Position)
		r.recordAudit(session.MemberID, "channel.update", "channel", channel.ChannelID, map[string]string{
			"name":      channel.Name,
			"type":      string(channel.Type),
			"parent_id": channel.ParentID,
			"position":  strconv.Itoa(channel.Position),
		})
		r.broadcastVisibleChannels()
		writeJSON(w, http.StatusOK, channel)
	case http.MethodDelete:
		session, ok := r.requireChannelPermission(w, req, channelID, domain.PermissionManageChannels)
		if !ok {
			return
		}
		channel, err := r.store.DeleteChannel(channelID)
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "EV_CHANNEL_NOT_FOUND", "channel not found")
			return
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
			return
		}
		log.Printf("admin action=channel.delete actor_member_id=%s channel_id=%s type=%s name=%q", session.MemberID, channel.ChannelID, channel.Type, channel.Name)
		r.recordAudit(session.MemberID, "channel.delete", "channel", channel.ChannelID, map[string]string{
			"name": channel.Name,
			"type": string(channel.Type),
		})
		r.broadcastVisibleChannels()
		writeJSON(w, http.StatusOK, channel)
	default:
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
	}
}

func (r *Router) authenticate(req *http.Request) (auth.Session, bool) {
	token := auth.SessionTokenFromRequest(req)
	if token == "" {
		return auth.Session{}, false
	}
	session, ok := r.sessions.Authenticate(token)
	if !ok || session.ServerID != r.store.Server().ServerID {
		return auth.Session{}, false
	}
	return session, true
}

func (r *Router) requireSession(w http.ResponseWriter, req *http.Request) (auth.Session, bool) {
	session, ok := r.authenticate(req)
	if !ok {
		writeError(w, http.StatusUnauthorized, "EV_AUTH_SESSION_INVALID", "session token is invalid")
		return auth.Session{}, false
	}
	return session, true
}

func (r *Router) requirePermission(w http.ResponseWriter, req *http.Request, permission domain.Permission) (auth.Session, bool) {
	session, ok := r.requireSession(w, req)
	if !ok {
		return auth.Session{}, false
	}
	if !r.hasPermission(session.MemberID, permission) {
		log.Printf("permission denied method=%s path=%s actor_member_id=%s permission=%s", req.Method, req.URL.Path, session.MemberID, permission)
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission "+string(permission)+" is required")
		return auth.Session{}, false
	}
	return session, true
}

func (r *Router) requireChannelPermission(
	w http.ResponseWriter,
	req *http.Request,
	channelID string,
	permission domain.Permission,
) (auth.Session, bool) {
	session, ok := r.requireSession(w, req)
	if !ok {
		return auth.Session{}, false
	}
	if !r.store.MemberHasChannelPermission(session.MemberID, channelID, permission) {
		log.Printf("permission denied method=%s path=%s actor_member_id=%s channel_id=%s permission=%s", req.Method, req.URL.Path, session.MemberID, channelID, permission)
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission "+string(permission)+" is required")
		return auth.Session{}, false
	}
	return session, true
}

func (r *Router) requireAnyChannelPermission(
	w http.ResponseWriter,
	req *http.Request,
	channelID string,
	permissions ...domain.Permission,
) (auth.Session, bool) {
	session, ok := r.requireSession(w, req)
	if !ok {
		return auth.Session{}, false
	}
	for _, permission := range permissions {
		if r.store.MemberHasChannelPermission(session.MemberID, channelID, permission) {
			return session, true
		}
	}
	labels := make([]string, 0, len(permissions))
	for _, permission := range permissions {
		labels = append(labels, string(permission))
	}
	log.Printf("permission denied method=%s path=%s actor_member_id=%s channel_id=%s permissions=%s", req.Method, req.URL.Path, session.MemberID, channelID, strings.Join(labels, ","))
	writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "one of permissions "+strings.Join(labels, ", ")+" is required")
	return auth.Session{}, false
}

func (r *Router) requireChannelFilePermission(
	w http.ResponseWriter,
	req *http.Request,
	channelID string,
	permission domain.Permission,
) (auth.Session, bool) {
	session, ok := r.requireSession(w, req)
	if !ok {
		return auth.Session{}, false
	}
	if r.memberHasChannelFilePermission(session.MemberID, channelID, permission) {
		return session, true
	}
	log.Printf(
		"permission denied method=%s path=%s actor_member_id=%s channel_id=%s permission=%s",
		req.Method,
		req.URL.Path,
		session.MemberID,
		channelID,
		permission,
	)
	writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission "+string(permission)+" is required")
	return auth.Session{}, false
}

func (r *Router) hasPermission(memberID string, permission domain.Permission) bool {
	return r.store.MemberHasPermission(memberID, permission)
}

func (r *Router) recordAudit(actorMemberID string, action string, targetType string, targetID string, details map[string]string) {
	if strings.TrimSpace(action) == "" {
		return
	}
	if details == nil {
		details = map[string]string{}
	}
	if _, err := r.store.CreateAuditLog(domain.AuditLog{
		ActorMemberID: actorMemberID,
		Action:        action,
		TargetType:    targetType,
		TargetID:      targetID,
		Details:       details,
	}); err != nil {
		log.Printf("audit action=%s actor_member_id=%s target_type=%s target_id=%s error=%q", action, actorMemberID, targetType, targetID, err.Error())
	}
}

func (r *Router) recordVoiceManagementAudit(
	actorMemberID string,
	target domain.Member,
	previousState domain.VoiceState,
	previousStateFound bool,
	state domain.VoiceState,
) {
	details := map[string]string{
		"target_member_id":    state.MemberID,
		"target_member_name":  nonEmptyString(target.DisplayName, state.MemberID),
		"target_channel_id":   state.ChannelID,
		"target_channel_name": r.channelAuditName(state.ChannelID),
		"server_muted":        strconv.FormatBool(state.ServerMuted),
		"server_deafened":     strconv.FormatBool(state.ServerDeafened),
	}
	if previousStateFound {
		details["previous_channel_id"] = previousState.ChannelID
		details["previous_channel_name"] = r.channelAuditName(previousState.ChannelID)
	}

	if previousStateFound && previousState.ChannelID != state.ChannelID {
		r.recordAudit(actorMemberID, "voice.member.move", "member", state.MemberID, cloneStringMap(details))
	}
	if previousStateFound && previousState.ServerDeafened != state.ServerDeafened {
		action := "voice.server_deafen"
		if !state.ServerDeafened {
			action = "voice.server_undeafen"
		}
		r.recordAudit(actorMemberID, action, "member", state.MemberID, cloneStringMap(details))
	}
	if previousStateFound && previousState.ServerMuted != state.ServerMuted && previousState.ServerDeafened == state.ServerDeafened {
		action := "voice.server_mute"
		if !state.ServerMuted {
			action = "voice.server_unmute"
		}
		r.recordAudit(actorMemberID, action, "member", state.MemberID, cloneStringMap(details))
	}
}

func (r *Router) channelAuditName(channelID string) string {
	channel, found := r.channelByID(channelID)
	if !found {
		return channelID
	}
	return nonEmptyString(channel.Name, channelID)
}

func cloneStringMap(source map[string]string) map[string]string {
	clone := make(map[string]string, len(source))
	for key, value := range source {
		clone[key] = value
	}
	return clone
}

func (r *Router) allowMessageSend(memberID string) bool {
	r.messageRateMu.Lock()
	defer r.messageRateMu.Unlock()

	now := time.Now()
	windowStart := now.Add(-messageRateWindow)
	recent := r.messageRecentSends[memberID]
	kept := make([]time.Time, 0, len(recent)+1)
	for _, sentAt := range recent {
		if sentAt.After(windowStart) {
			kept = append(kept, sentAt)
		}
	}
	if len(kept) >= maxMessagesPerRateWindow {
		r.messageRecentSends[memberID] = kept
		return false
	}
	kept = append(kept, now)
	r.messageRecentSends[memberID] = kept
	return true
}

func (r *Router) memberByID(memberID string) (domain.Member, bool) {
	for _, member := range r.store.Members() {
		if member.MemberID == memberID {
			return member, true
		}
	}
	return domain.Member{}, false
}

func (r *Router) handlePresence(identity ws.ClientIdentity, online bool) {
	key := identity.ServerID + ":" + identity.MemberID + ":" + identity.DeviceID
	r.presenceMu.Lock()
	if timer := r.presenceOfflineTimers[key]; timer != nil {
		timer.Stop()
		delete(r.presenceOfflineTimers, key)
	}
	if !online {
		r.presenceOfflineTimers[key] = time.AfterFunc(r.presenceOfflineGrace, func() {
			if r.hub.IsDeviceOnline(identity.ServerID, identity.MemberID, identity.DeviceID) {
				return
			}
			r.presenceMu.Lock()
			delete(r.presenceOfflineTimers, key)
			r.presenceMu.Unlock()
			if state, found := r.voiceStateByDevice(identity.MemberID, identity.DeviceID); found {
				if removed, left, leaveErr := r.store.LeaveVoiceChannel(state.ParticipantID); leaveErr == nil && left {
					if removed.Mode != "listener" {
						r.endMemberScreenShareSessions(identity.MemberID, identity.MemberID, "device_disconnected")
						r.endMemberAccompanimentSessions(identity.MemberID, identity.MemberID, "device_disconnected")
					}
					r.removeScreenShareViewerDevice(identity.ServerID, identity.MemberID, identity.DeviceID, "controller_device_disconnected")
					r.broadcastVoiceState("voice.state.deleted", removed)
					log.Printf("voice action=voice.disconnect_cleanup member_id=%s device_id=%s channel_id=%s", identity.MemberID, shortLogID(identity.DeviceID), removed.ChannelID)
				}
			}
			member, err := r.store.TouchMember(identity.MemberID, time.Now().UnixMilli())
			if err != nil {
				return
			}
			member.Online = r.hub.IsMemberOnline(identity.ServerID, identity.MemberID)
			r.hub.Broadcast(ws.Event{Type: "member.presence.updated", Payload: member})
		})
		r.presenceMu.Unlock()
		return
	}
	r.presenceMu.Unlock()
	member, err := r.store.TouchMember(identity.MemberID, time.Now().UnixMilli())
	if err != nil {
		return
	}
	_ = member
}

func (r *Router) roleByID(roleID string) (domain.ServerRole, bool) {
	for _, role := range r.store.Roles() {
		if role.RoleID == roleID {
			return role, true
		}
	}
	return domain.ServerRole{}, false
}

func (r *Router) highestRolePosition(member domain.Member) int {
	if member.IsOwner {
		return int(^uint(0) >> 1)
	}
	highest := 0
	for _, roleID := range member.RoleIDs {
		role, ok := r.roleByID(roleID)
		if ok && role.Position > highest {
			highest = role.Position
		}
	}
	return highest
}

func (r *Router) actorCanCreateRole(actorID string, input *domain.ServerRole) bool {
	actor, found := r.memberByID(actorID)
	if !found {
		return false
	}
	if actor.IsOwner {
		return true
	}
	highest := r.highestRolePosition(actor)
	if highest <= 1 {
		return false
	}
	if input.Position <= 0 || input.Position >= highest {
		input.Position = highest - 1
	}
	return input.Position > 0 && input.Position < highest
}

func (r *Router) actorCanManageRole(actorID string, roleID string) bool {
	actor, found := r.memberByID(actorID)
	if !found {
		return false
	}
	role, found := r.roleByID(roleID)
	if !found {
		return false
	}
	if actor.IsOwner {
		return true
	}
	if role.IsEveryone {
		return false
	}
	return role.Position < r.highestRolePosition(actor)
}

func (r *Router) actorCanPlaceRole(actorID string, position int) bool {
	if position <= 0 {
		return true
	}
	actor, found := r.memberByID(actorID)
	if !found {
		return false
	}
	return actor.IsOwner || position < r.highestRolePosition(actor)
}

func (r *Router) actorCanAssignRoles(actorID string, roleIDs []string) bool {
	actor, found := r.memberByID(actorID)
	if !found {
		return false
	}
	if actor.IsOwner {
		return true
	}
	highest := r.highestRolePosition(actor)
	for _, roleID := range roleIDs {
		role, found := r.roleByID(roleID)
		if !found || role.IsEveryone {
			continue
		}
		if role.Position >= highest {
			return false
		}
	}
	return true
}

func (r *Router) actorCanManageMember(actorID string, target domain.Member) bool {
	actor, found := r.memberByID(actorID)
	if !found {
		return false
	}
	if actor.IsOwner {
		return true
	}
	if target.IsOwner || target.MemberID == actorID {
		return false
	}
	return r.highestRolePosition(target) < r.highestRolePosition(actor)
}

func (r *Router) channelByID(channelID string) (domain.Channel, bool) {
	for _, channel := range r.store.Channels() {
		if channel.ChannelID == channelID {
			return channel, true
		}
	}
	return domain.Channel{}, false
}

func (r *Router) visibleChannels(memberID string) []domain.Channel {
	channels := r.store.Channels()
	temporaryIDs := r.temporaryVoiceChannelIDs(memberID, channels)
	visibleIDs := make(map[string]bool, len(channels))
	for _, channel := range channels {
		if r.store.MemberHasChannelPermission(memberID, channel.ChannelID, domain.PermissionViewChannels) || temporaryIDs[channel.ChannelID] {
			visibleIDs[channel.ChannelID] = true
		}
	}
	visible := make([]domain.Channel, 0, len(visibleIDs))
	for _, channel := range channels {
		if !visibleIDs[channel.ChannelID] {
			continue
		}
		if channel.ParentID != "" && !visibleIDs[channel.ParentID] {
			channel.ParentID = ""
		}
		channel.EffectivePermissions = make(map[domain.Permission]bool, len(domain.AllPermissions))
		for _, permission := range domain.AllPermissions {
			if permission == domain.PermissionViewFiles || permission == domain.PermissionUploadFiles ||
				permission == domain.PermissionDownloadFiles || permission == domain.PermissionManageFiles {
				channel.EffectivePermissions[permission] = r.memberHasChannelFilePermission(memberID, channel.ChannelID, permission)
				continue
			}
			channel.EffectivePermissions[permission] = r.store.MemberHasChannelPermission(memberID, channel.ChannelID, permission)
		}
		visible = append(visible, channel)
	}
	return visible
}

// A moderator may move a member into a channel they cannot join themselves. While
// the member remains there, expose only that channel and its category ancestry so
// the client can represent the server-authoritative voice state without granting
// any additional channel permission.
func (r *Router) temporaryVoiceChannelIDs(memberID string, channels []domain.Channel) map[string]bool {
	channelsByID := make(map[string]domain.Channel, len(channels))
	for _, channel := range channels {
		channelsByID[channel.ChannelID] = channel
	}
	visibleIDs := make(map[string]bool)
	for _, state := range r.store.VoiceStates() {
		if state.MemberID != memberID {
			continue
		}
		channelID := state.ChannelID
		for channelID != "" && !visibleIDs[channelID] {
			visibleIDs[channelID] = true
			channel, found := channelsByID[channelID]
			if !found {
				break
			}
			channelID = channel.ParentID
		}
	}
	return visibleIDs
}

func (r *Router) memberCanSeeChannelMetadata(memberID string, channelID string) bool {
	if r.store.MemberHasChannelPermission(memberID, channelID, domain.PermissionViewChannels) {
		return true
	}
	return r.temporaryVoiceChannelIDs(memberID, r.store.Channels())[channelID]
}

func (r *Router) memberHasVoiceStateInChannel(memberID string, channelID string) bool {
	for _, state := range r.store.VoiceStates() {
		if state.MemberID == memberID && state.ChannelID == channelID {
			return true
		}
	}
	return false
}

func (r *Router) visibleVoiceStates(memberID string, deviceID string) []domain.VoiceState {
	states := r.store.VoiceStates()
	joinedChannelID := ""
	for _, state := range states {
		if state.MemberID == memberID && state.DeviceID == deviceID {
			joinedChannelID = state.ChannelID
			break
		}
	}
	visible := make([]domain.VoiceState, 0, len(states))
	for _, state := range states {
		if state.MemberID == memberID || state.ChannelID == joinedChannelID || r.store.MemberHasChannelPermission(memberID, state.ChannelID, domain.PermissionViewChannels) {
			if joinedChannelID == "" || state.ChannelID != joinedChannelID {
				state.IsSpeaking = false
			}
			visible = append(visible, state)
		}
	}
	return visible
}

func (r *Router) broadcastVisibleChannels() {
	for _, member := range r.store.Members() {
		r.sendVisibleChannelsToMember(member.MemberID)
	}
}

func (r *Router) sendVisibleChannelsToMember(memberID string) {
	r.hub.SendToMember(r.store.Server().ServerID, memberID, ws.Event{
		Type: "channels.reordered",
		Payload: map[string]any{
			"channels": nonNilSlice(r.visibleChannels(memberID)),
		},
	})
}

func (r *Router) sendVoiceStateSnapshotsToMember(memberID string) {
	serverID := r.store.Server().ServerID
	for _, memberState := range r.voiceStatesForMember(memberID) {
		r.hub.SendToDevice(serverID, memberID, memberState.DeviceID, ws.Event{
			Type: "voice.states.snapshot",
			Payload: map[string]any{
				"voice_states": nonNilSlice(r.visibleVoiceStates(memberID, memberState.DeviceID)),
			},
		})
	}
}

func (r *Router) broadcastChannelEvent(channelID string, eventType string, payload any) {
	serverID := r.store.Server().ServerID
	for _, member := range r.store.Members() {
		if r.memberCanSeeChannelMetadata(member.MemberID, channelID) {
			r.hub.SendToMember(serverID, member.MemberID, ws.Event{Type: eventType, Payload: payload})
		}
	}
}

func (r *Router) broadcastFileEvent(channelID string, eventType string, payload any) {
	serverID := r.store.Server().ServerID
	for _, member := range r.store.Members() {
		if r.memberHasChannelFilePermission(member.MemberID, channelID, domain.PermissionViewFiles) {
			memberPayload := payload
			if entry, ok := payload.(domain.ChannelFileEntry); ok &&
				!r.memberHasChannelFilePermission(member.MemberID, channelID, domain.PermissionDownloadFiles) {
				entry.AssetSHA256 = ""
				memberPayload = entry
			}
			r.hub.SendToMember(serverID, member.MemberID, ws.Event{Type: eventType, Payload: memberPayload})
		}
	}
}

func (r *Router) broadcastChannelPermissionEvent(channelID string, eventType string, payload any) {
	serverID := r.store.Server().ServerID
	for _, member := range r.store.Members() {
		canManage := r.store.MemberHasChannelPermission(member.MemberID, channelID, domain.PermissionManageChannelPermissions) ||
			r.store.MemberHasChannelPermission(member.MemberID, channelID, domain.PermissionManageChannels)
		if canManage {
			r.hub.SendToMember(serverID, member.MemberID, ws.Event{Type: eventType, Payload: payload})
		}
	}
}

func (r *Router) broadcastVoiceState(eventType string, state domain.VoiceState) {
	serverID := r.store.Server().ServerID
	state.IsSpeaking = false
	for _, member := range r.store.Members() {
		if member.MemberID != state.MemberID &&
			!r.store.MemberHasChannelPermission(member.MemberID, state.ChannelID, domain.PermissionViewChannels) &&
			!r.memberHasVoiceStateInChannel(member.MemberID, state.ChannelID) {
			continue
		}
		r.hub.SendToMember(serverID, member.MemberID, ws.Event{Type: eventType, Payload: state})
	}
}

func (r *Router) broadcastVoiceSpeakingState(state domain.VoiceState) {
	serverID := r.store.Server().ServerID
	for _, listener := range r.store.VoiceStates() {
		if listener.ChannelID != state.ChannelID {
			continue
		}
		r.hub.SendToDevice(
			serverID,
			listener.MemberID,
			listener.DeviceID,
			ws.Event{Type: "voice.speaking.updated", Payload: state},
		)
	}
}

func (r *Router) handleClientEvent(identity ws.ClientIdentity, event ws.Event) {
	if !r.sessions.Touch(identity.SessionToken) {
		return
	}
	if event.Type == "presence.heartbeat" {
		member, err := r.store.TouchMember(identity.MemberID, time.Now().UnixMilli())
		if err == nil {
			member.Online = true
			r.hub.Broadcast(ws.Event{Type: "member.presence.updated", Payload: member})
		}
		return
	}
	if event.Type == "remote_control.input" {
		r.handleRemoteControlInput(identity, event)
		return
	}
	if event.Type == "voice.speaking.update" {
		r.handleVoiceSpeakingUpdate(identity, event)
		return
	}
	if event.Type != "rtc.signal" {
		return
	}
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		return
	}
	var signal domain.RTCSignal
	if err := json.Unmarshal(payload, &signal); err != nil {
		return
	}
	if signal.ChannelID == "" || signal.SignalType == "" {
		return
	}
	state, ok := r.voiceStateByDevice(identity.MemberID, identity.DeviceID)
	if !ok || state.ChannelID != signal.ChannelID {
		return
	}
	signal.FromMemberID = identity.MemberID
	signal.FromParticipantID = state.ParticipantID
	if strings.HasPrefix(signal.SignalType, "screen-share-") && shouldLogScreenShareSignal(signal.SignalType) {
		log.Printf(
			"rtc action=screen_share.signal from_member_id=%s target_member_id=%s channel_id=%s type=%s share_id=%s",
			signal.FromMemberID,
			signal.TargetMemberID,
			signal.ChannelID,
			signal.SignalType,
			screenShareSignalShareID(signal),
		)
	}
	r.updateScreenShareViewerFromSignal(signal)
	forwarded := ws.Event{Type: "rtc.signal", Payload: signal}
	if signal.TargetParticipantID != "" || signal.TargetMemberID != "" {
		var targetState domain.VoiceState
		var ok bool
		if signal.TargetParticipantID != "" {
			targetState, ok = r.voiceStateByParticipant(signal.TargetParticipantID)
		} else {
			targetState, ok = r.voiceStateByMember(signal.TargetMemberID)
		}
		if !ok || targetState.ChannelID != signal.ChannelID {
			if strings.HasPrefix(signal.SignalType, "screen-share-") && shouldLogScreenShareSignal(signal.SignalType) {
				log.Printf(
					"rtc action=screen_share.signal.drop from_member_id=%s target_member_id=%s channel_id=%s type=%s share_id=%s reason=target_not_in_channel",
					signal.FromMemberID,
					signal.TargetMemberID,
					signal.ChannelID,
					signal.SignalType,
					screenShareSignalShareID(signal),
				)
			}
			return
		}
		signal.TargetMemberID = targetState.MemberID
		signal.TargetParticipantID = targetState.ParticipantID
		forwarded = ws.Event{Type: "rtc.signal", Payload: signal}
		delivered := r.hub.SendToDevice(identity.ServerID, targetState.MemberID, targetState.DeviceID, forwarded)
		queued := false
		if strings.HasPrefix(signal.SignalType, "screen-share-") && !delivered {
			r.enqueueScreenShareSignal(identity.ServerID, targetState.MemberID, signal)
			queued = true
		}
		if strings.HasPrefix(signal.SignalType, "screen-share-") && shouldLogScreenShareSignal(signal.SignalType) {
			log.Printf(
				"rtc action=screen_share.signal.forward from_member_id=%s target_member_id=%s channel_id=%s type=%s share_id=%s delivered=%t queued=%t",
				signal.FromMemberID,
				signal.TargetMemberID,
				signal.ChannelID,
				signal.SignalType,
				screenShareSignalShareID(signal),
				delivered,
				queued,
			)
		}
		return
	}
	for _, state := range r.store.VoiceStates() {
		if state.ChannelID == signal.ChannelID && state.ParticipantID != signal.FromParticipantID {
			copySignal := signal
			copySignal.TargetMemberID = state.MemberID
			copySignal.TargetParticipantID = state.ParticipantID
			r.hub.SendToDevice(identity.ServerID, state.MemberID, state.DeviceID, ws.Event{Type: "rtc.signal", Payload: copySignal})
		}
	}
}

func (r *Router) handleSessionKeepAlive(identity ws.ClientIdentity) bool {
	return r.sessions.Touch(identity.SessionToken)
}

func (r *Router) handleVoiceSpeakingUpdate(identity ws.ClientIdentity, event ws.Event) {
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		return
	}
	var input struct {
		IsSpeaking bool `json:"is_speaking"`
	}
	if err := json.Unmarshal(payload, &input); err != nil {
		return
	}
	current, found := r.voiceStateByDevice(identity.MemberID, identity.DeviceID)
	if !found {
		return
	}
	requestedSpeaking := input.IsSpeaking && r.store.MemberHasChannelPermission(
		identity.MemberID,
		current.ChannelID,
		domain.PermissionSpeak,
	)
	updated, err := r.store.UpdateVoiceState(current.ParticipantID, domain.VoiceState{
		MicMuted:      current.MicMuted,
		AudioDeafened: current.AudioDeafened,
		IsSpeaking:    requestedSpeaking,
	})
	if err != nil || updated.IsSpeaking == current.IsSpeaking {
		return
	}
	r.broadcastVoiceSpeakingState(updated)
}

func (r *Router) updateScreenShareViewerFromSignal(signal domain.RTCSignal) {
	watching := false
	switch signal.SignalType {
	case "screen-share-watch":
		watching = true
	case "screen-share-unwatch":
		watching = false
	default:
		return
	}
	shareID := screenShareSignalShareID(signal)
	if shareID == "" {
		return
	}
	share, found := r.screenShareByID(shareID)
	if !found || share.ChannelID != signal.ChannelID || share.OwnerMemberID == signal.FromMemberID {
		return
	}
	if signal.TargetMemberID != "" && signal.TargetMemberID != share.OwnerMemberID {
		return
	}
	updated, err := r.store.SetScreenShareViewer(shareID, signal.FromMemberID, watching)
	if err != nil {
		return
	}
	log.Printf(
		"rtc action=screen_share.viewer.update share_id=%s viewer_member_id=%s watching=%t viewer_count=%d",
		shareID,
		signal.FromMemberID,
		watching,
		len(updated.ViewerMemberIDs),
	)
	r.broadcastChannelEvent(updated.ChannelID, "screen_share.updated", updated)
	if !watching {
		r.endRemoteControlsForController(signal.FromParticipantID, "controller_stopped_watching")
	}
}

func screenShareSignalDataWithShareID(data json.RawMessage, shareID string) (json.RawMessage, error) {
	payload := map[string]json.RawMessage{}
	if len(data) > 0 && string(data) != "null" {
		if err := json.Unmarshal(data, &payload); err != nil {
			return nil, err
		}
	}
	if rawShareID, ok := payload["share_id"]; ok {
		var existing string
		if err := json.Unmarshal(rawShareID, &existing); err != nil {
			return nil, err
		}
		if existing != "" && existing != shareID {
			return nil, errors.New("screen share signal share_id does not match route")
		}
	}
	rawShareID, err := json.Marshal(shareID)
	if err != nil {
		return nil, err
	}
	payload["share_id"] = rawShareID
	return json.Marshal(payload)
}

func screenShareSignalQueueKey(serverID string, memberID string) string {
	return serverID + ":" + memberID
}

func (r *Router) enqueueScreenShareSignal(serverID string, targetMemberID string, signal domain.RTCSignal) {
	if serverID == "" || targetMemberID == "" {
		return
	}
	r.screenSignalMu.Lock()
	defer r.screenSignalMu.Unlock()
	key := screenShareSignalQueueKey(serverID, targetMemberID)
	r.screenSignals[key] = append(r.screenSignals[key], signal)
	if len(r.screenSignals[key]) > 128 {
		r.screenSignals[key] = r.screenSignals[key][len(r.screenSignals[key])-128:]
	}
}

func (r *Router) drainScreenShareSignals(serverID string, targetMemberID string, targetParticipantID string, shareID string, watchSessionID string) []domain.RTCSignal {
	if serverID == "" || targetMemberID == "" || targetParticipantID == "" || shareID == "" {
		return nil
	}
	r.screenSignalMu.Lock()
	defer r.screenSignalMu.Unlock()
	key := screenShareSignalQueueKey(serverID, targetMemberID)
	items := r.screenSignals[key]
	if len(items) == 0 {
		return nil
	}
	drained := []domain.RTCSignal{}
	remaining := make([]domain.RTCSignal, 0, len(items))
	for _, signal := range items {
		if screenShareSignalShareID(signal) == shareID &&
			(signal.TargetParticipantID == "" || signal.TargetParticipantID == targetParticipantID) {
			signalWatchSessionID := screenShareSignalWatchSessionID(signal)
			if watchSessionID == "" || signalWatchSessionID == "" || signalWatchSessionID == watchSessionID {
				drained = append(drained, signal)
			}
			// Signals for an older watch generation must not survive to poison a later drain.
			continue
		}
		remaining = append(remaining, signal)
	}
	if len(remaining) == 0 {
		delete(r.screenSignals, key)
	} else {
		r.screenSignals[key] = remaining
	}
	return drained
}

func screenShareSignalShareID(signal domain.RTCSignal) string {
	var payload struct {
		ShareID string `json:"share_id"`
	}
	if err := json.Unmarshal(signal.Data, &payload); err != nil {
		return ""
	}
	return strings.TrimSpace(payload.ShareID)
}

func screenShareSignalWatchSessionID(signal domain.RTCSignal) string {
	var payload struct {
		WatchSessionID string `json:"watch_session_id"`
	}
	if err := json.Unmarshal(signal.Data, &payload); err != nil {
		return ""
	}
	return strings.TrimSpace(payload.WatchSessionID)
}

func shouldLogScreenShareSignal(signalType string) bool {
	return signalType != "screen-share-ice-candidate"
}

func (r *Router) discardScreenShareSignals(shareID string) {
	if shareID == "" {
		return
	}
	r.screenSignalMu.Lock()
	defer r.screenSignalMu.Unlock()
	for key, items := range r.screenSignals {
		remaining := items[:0]
		for _, signal := range items {
			if screenShareSignalShareID(signal) != shareID {
				remaining = append(remaining, signal)
			}
		}
		if len(remaining) == 0 {
			delete(r.screenSignals, key)
			continue
		}
		r.screenSignals[key] = remaining
	}
}

func (r *Router) screenShareByID(shareID string) (domain.ScreenShareSession, bool) {
	for _, share := range r.store.ScreenShareSessions() {
		if share.ShareID == shareID {
			return share, true
		}
	}
	return domain.ScreenShareSession{}, false
}

func (r *Router) voiceStateByMember(memberID string) (domain.VoiceState, bool) {
	for _, state := range r.voiceStatesForMember(memberID) {
		if state.MemberID == memberID && state.Mode != "listener" {
			return state, true
		}
	}
	return domain.VoiceState{}, false
}

func (r *Router) voiceStatesForMember(memberID string) []domain.VoiceState {
	states := []domain.VoiceState{}
	for _, state := range r.store.VoiceStates() {
		if state.MemberID == memberID {
			states = append(states, state)
		}
	}
	return states
}

func voiceStateMatchingParticipant(states []domain.VoiceState, participantID string) domain.VoiceState {
	for _, state := range states {
		if state.ParticipantID == participantID {
			return state
		}
	}
	if len(states) > 0 {
		return states[0]
	}
	return domain.VoiceState{}
}

func (r *Router) primaryVoiceStateByMember(memberID string) (domain.VoiceState, bool) {
	return r.voiceStateByMember(memberID)
}

func (r *Router) voiceStateByDevice(memberID string, deviceID string) (domain.VoiceState, bool) {
	for _, state := range r.store.VoiceStates() {
		if state.MemberID == memberID && state.DeviceID == deviceID {
			return state, true
		}
	}
	return domain.VoiceState{}, false
}

func (r *Router) voiceStateByParticipant(participantID string) (domain.VoiceState, bool) {
	for _, state := range r.store.VoiceStates() {
		if state.ParticipantID == participantID {
			return state, true
		}
	}
	return domain.VoiceState{}, false
}

func (r *Router) disconnectMemberRealtime(memberID string, actorMemberID string, reason string) {
	r.endMemberScreenShareSessions(memberID, actorMemberID, reason)
	r.endMemberAccompanimentSessions(memberID, actorMemberID, reason)
	r.removeScreenShareViewerFromAll(memberID)
	states, err := r.store.LeaveMemberVoiceChannels(memberID)
	if err != nil {
		return
	}
	for _, state := range states {
		r.broadcastVoiceState("voice.state.deleted", state)
	}
}

func shortLogID(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= 10 {
		return value
	}
	return value[:6] + "..." + value[len(value)-4:]
}

func stateChannelID(states []domain.VoiceState, memberID string) string {
	for _, state := range states {
		if state.MemberID == memberID {
			return state.ChannelID
		}
	}
	return ""
}

func (r *Router) validCategoryParent(channelID string, parentID string) bool {
	if parentID == "" || parentID == channelID {
		return false
	}
	parent, found := r.channelByID(parentID)
	return found && parent.Type == domain.ChannelTypeCategory
}

func validChannelType(channelType domain.ChannelType) bool {
	switch channelType {
	case domain.ChannelTypeText, domain.ChannelTypeVoice, domain.ChannelTypeCategory, domain.ChannelTypeTemporaryVoice:
		return true
	default:
		return false
	}
}

func validChannelVisibility(value string) bool {
	return value == "default" || value == "warning"
}

func validLanguageID(value string, allowEmpty bool) bool {
	if value == "" {
		return allowEmpty
	}
	return languageIDPattern.MatchString(value)
}

func validChannelLocalizations(localizations map[string]domain.ChannelLocalization) bool {
	if len(localizations) > 32 {
		return false
	}
	for language, localization := range localizations {
		if !validLanguageID(strings.TrimSpace(language), false) ||
			len([]rune(localization.Name)) > 100 ||
			len([]rune(localization.Topic)) > 2000 ||
			len([]rune(localization.WarningText)) > 1000 {
			return false
		}
	}
	return true
}

func validAvatarColor(value string) bool {
	return value == "" || avatarColorPattern.MatchString(value)
}

func validInlineImage(value string) bool {
	if value == "" {
		return true
	}
	if len(value) > maxInlineImageLength {
		return false
	}
	return strings.HasPrefix(value, "data:image/png;base64,") ||
		strings.HasPrefix(value, "data:image/jpeg;base64,") ||
		strings.HasPrefix(value, "data:image/webp;base64,") ||
		strings.HasPrefix(value, "data:image/gif;base64,")
}

func readJSON(req *http.Request, target any) error {
	defer req.Body.Close()
	return json.NewDecoder(req.Body).Decode(target)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, code string, message string) {
	writeJSON(w, status, domain.APIError{Code: code, Message: message})
}

func nonNilSlice[T any](items []T) []T {
	if items == nil {
		return []T{}
	}
	return items
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		if req.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, req)
	})
}
