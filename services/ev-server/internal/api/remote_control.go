package api

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/echovoice/echovoice/services/ev-server/internal/auth"
	"github.com/echovoice/echovoice/services/ev-server/internal/domain"
	"github.com/echovoice/echovoice/services/ev-server/internal/ws"
)

var (
	errRemoteControlNotFound     = errors.New("remote control session not found")
	errRemoteControlInvalidState = errors.New("remote control session state does not allow this action")
	errRemoteControlOccupied     = errors.New("screen share already has an active controller")
	errRemoteControlRespect      = errors.New("remote control is suspended for local input")
	errRemoteControlRateLimited  = errors.New("remote control input rate exceeded")
	errRemoteControlSequence     = errors.New("remote control input sequence is stale")
	errRemoteControlRequestLimit = errors.New("remote control request rate exceeded")
	errRemoteControlPendingLimit = errors.New("too many pending remote control requests")
)

const (
	remoteControlRespectWindow     = 3 * time.Second
	remoteControlInputWindow       = time.Second
	remoteControlInputLimit        = 240
	remoteControlPendingTTL        = 60 * time.Second
	remoteControlLeaseTTL          = 10 * time.Second
	remoteControlRequestWindow     = time.Minute
	remoteControlRequestLimit      = 10
	remoteControlPendingShareLimit = 5
)

type remoteControlInputRate struct {
	windowStartedAt time.Time
	count           int
	lastSequence    uint64
}

type remoteControlRequestRate struct {
	windowStartedAt time.Time
	count           int
}

type remoteControlRegistry struct {
	mu       sync.Mutex
	sessions map[string]domain.RemoteControlSession
	rates    map[string]remoteControlInputRate
	requests map[string]remoteControlRequestRate
	expired  []domain.RemoteControlSession
}

func newRemoteControlRegistry() *remoteControlRegistry {
	return &remoteControlRegistry{
		sessions: make(map[string]domain.RemoteControlSession),
		rates:    make(map[string]remoteControlInputRate),
		requests: make(map[string]remoteControlRequestRate),
	}
}

func (r *remoteControlRegistry) list(
	participantID string,
	visibleShareIDs map[string]struct{},
) []domain.RemoteControlSession {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cleanupLocked(time.Now().UnixMilli())
	items := make([]domain.RemoteControlSession, 0)
	for _, session := range r.sessions {
		_, activeShareVisible := visibleShareIDs[session.ShareID]
		if session.OwnerParticipantID != participantID && session.ControllerParticipantID != participantID &&
			!(session.Status == domain.RemoteControlActive && activeShareVisible) {
			continue
		}
		if session.Status != domain.RemoteControlPending && session.Status != domain.RemoteControlActive {
			continue
		}
		items = append(items, session)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].RequestedAtMS < items[j].RequestedAtMS })
	return items
}

func (r *remoteControlRegistry) get(controlID string) (domain.RemoteControlSession, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cleanupLocked(time.Now().UnixMilli())
	session, ok := r.sessions[controlID]
	return session, ok
}

func (r *remoteControlRegistry) request(
	share domain.ScreenShareSession,
	controllerMemberID string,
	controllerParticipantID string,
) (domain.RemoteControlSession, bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now().UnixMilli()
	r.cleanupLocked(now)
	for _, session := range r.sessions {
		if session.ShareID == share.ShareID && session.ControllerParticipantID == controllerParticipantID &&
			(session.Status == domain.RemoteControlPending || session.Status == domain.RemoteControlActive) {
			return session, false, nil
		}
	}
	for _, session := range r.sessions {
		if session.ShareID == share.ShareID && session.Status == domain.RemoteControlActive {
			return domain.RemoteControlSession{}, false, errRemoteControlOccupied
		}
	}
	requestRate := r.requests[controllerParticipantID]
	nowTime := time.UnixMilli(now)
	if requestRate.windowStartedAt.IsZero() || nowTime.Sub(requestRate.windowStartedAt) >= remoteControlRequestWindow {
		requestRate.windowStartedAt = nowTime
		requestRate.count = 0
	}
	if requestRate.count >= remoteControlRequestLimit {
		return domain.RemoteControlSession{}, false, errRemoteControlRequestLimit
	}
	pendingCount := 0
	for _, session := range r.sessions {
		if session.ShareID == share.ShareID && session.Status == domain.RemoteControlPending {
			pendingCount++
		}
	}
	if pendingCount >= remoteControlPendingShareLimit {
		return domain.RemoteControlSession{}, false, errRemoteControlPendingLimit
	}
	controlID, err := auth.NewToken("ctl")
	if err != nil {
		return domain.RemoteControlSession{}, false, err
	}
	session := domain.RemoteControlSession{
		ControlID:               controlID,
		ShareID:                 share.ShareID,
		ChannelID:               share.ChannelID,
		OwnerMemberID:           share.OwnerMemberID,
		OwnerParticipantID:      share.OwnerParticipantID,
		ControllerMemberID:      controllerMemberID,
		ControllerParticipantID: controllerParticipantID,
		Status:                  domain.RemoteControlPending,
		RequestedAtMS:           now,
		UpdatedAtMS:             now,
		ExpiresAtMS:             now + remoteControlPendingTTL.Milliseconds(),
		TransportState:          "websocket",
	}
	r.sessions[controlID] = session
	requestRate.count++
	r.requests[controllerParticipantID] = requestRate
	return session, true, nil
}

func (r *remoteControlRegistry) approve(controlID string) (domain.RemoteControlSession, []domain.RemoteControlSession, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cleanupLocked(time.Now().UnixMilli())
	session, ok := r.sessions[controlID]
	if !ok {
		return domain.RemoteControlSession{}, nil, errRemoteControlNotFound
	}
	if session.Status == domain.RemoteControlActive {
		return session, nil, nil
	}
	if session.Status != domain.RemoteControlPending {
		return domain.RemoteControlSession{}, nil, errRemoteControlInvalidState
	}
	for id, other := range r.sessions {
		if id == controlID || other.ShareID != session.ShareID || other.Status != domain.RemoteControlActive {
			continue
		}
		return domain.RemoteControlSession{}, nil, errRemoteControlOccupied
	}
	now := time.Now().UnixMilli()
	session.Status = domain.RemoteControlActive
	session.UpdatedAtMS = now
	session.ExpiresAtMS = 0
	session.LeaseUntilMS = now + remoteControlLeaseTTL.Milliseconds()
	session.GrantGeneration++
	session.RespectUntilMS = 0
	r.sessions[controlID] = session
	return session, nil, nil
}

func (r *remoteControlRegistry) reject(controlID string) (domain.RemoteControlSession, error) {
	return r.end(controlID, domain.RemoteControlRejected, "owner_rejected", true)
}

func (r *remoteControlRegistry) revoke(controlID string, reason string) (domain.RemoteControlSession, error) {
	return r.end(controlID, domain.RemoteControlRevoked, reason, false)
}

func (r *remoteControlRegistry) end(
	controlID string,
	status domain.RemoteControlStatus,
	reason string,
	pendingOnly bool,
) (domain.RemoteControlSession, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	session, ok := r.sessions[controlID]
	if !ok {
		return domain.RemoteControlSession{}, errRemoteControlNotFound
	}
	if pendingOnly && session.Status != domain.RemoteControlPending {
		return domain.RemoteControlSession{}, errRemoteControlInvalidState
	}
	if !pendingOnly && session.Status != domain.RemoteControlPending && session.Status != domain.RemoteControlActive {
		return domain.RemoteControlSession{}, errRemoteControlInvalidState
	}
	session.Status = status
	session.EndReason = reason
	session.UpdatedAtMS = time.Now().UnixMilli()
	session.ExpiresAtMS = 0
	session.LeaseUntilMS = 0
	session.RespectUntilMS = 0
	r.sessions[controlID] = session
	delete(r.rates, controlID)
	return session, nil
}

func (r *remoteControlRegistry) suspend(controlID string) (domain.RemoteControlSession, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cleanupLocked(time.Now().UnixMilli())
	session, ok := r.sessions[controlID]
	if !ok {
		return domain.RemoteControlSession{}, errRemoteControlNotFound
	}
	if session.Status != domain.RemoteControlActive {
		return domain.RemoteControlSession{}, errRemoteControlInvalidState
	}
	now := time.Now()
	session.RespectUntilMS = now.Add(remoteControlRespectWindow).UnixMilli()
	session.UpdatedAtMS = now.UnixMilli()
	r.sessions[controlID] = session
	return session, nil
}

func (r *remoteControlRegistry) authorizeInput(
	controlID string,
	controllerParticipantID string,
	sequence uint64,
) (domain.RemoteControlSession, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.cleanupLocked(time.Now().UnixMilli())
	session, ok := r.sessions[controlID]
	if !ok {
		return domain.RemoteControlSession{}, errRemoteControlNotFound
	}
	if session.Status != domain.RemoteControlActive || session.ControllerParticipantID != controllerParticipantID {
		return domain.RemoteControlSession{}, errRemoteControlInvalidState
	}
	now := time.Now()
	if session.RespectUntilMS > now.UnixMilli() {
		return session, errRemoteControlRespect
	}
	rate := r.rates[controlID]
	if rate.windowStartedAt.IsZero() || now.Sub(rate.windowStartedAt) >= remoteControlInputWindow {
		rate.windowStartedAt = now
		rate.count = 0
	}
	if sequence == 0 || sequence <= rate.lastSequence {
		return session, errRemoteControlSequence
	}
	if rate.count >= remoteControlInputLimit {
		return session, errRemoteControlRateLimited
	}
	rate.count++
	rate.lastSequence = sequence
	r.rates[controlID] = rate
	return session, nil
}

func (r *remoteControlRegistry) heartbeat(
	controlID string,
	controllerParticipantID string,
) (domain.RemoteControlSession, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now().UnixMilli()
	r.cleanupLocked(now)
	session, ok := r.sessions[controlID]
	if !ok {
		return domain.RemoteControlSession{}, errRemoteControlNotFound
	}
	if session.Status != domain.RemoteControlActive || session.ControllerParticipantID != controllerParticipantID {
		return domain.RemoteControlSession{}, errRemoteControlInvalidState
	}
	session.LeaseUntilMS = now + remoteControlLeaseTTL.Milliseconds()
	session.UpdatedAtMS = now
	r.sessions[controlID] = session
	return session, nil
}

func (r *remoteControlRegistry) takeExpired() []domain.RemoteControlSession {
	r.mu.Lock()
	defer r.mu.Unlock()
	items := append([]domain.RemoteControlSession(nil), r.expired...)
	r.expired = r.expired[:0]
	return items
}

func (r *remoteControlRegistry) revokeForShare(shareID string, reason string) []domain.RemoteControlSession {
	return r.revokeMatching(func(session domain.RemoteControlSession) bool { return session.ShareID == shareID }, reason)
}

func (r *remoteControlRegistry) revokeForController(participantID string, reason string) []domain.RemoteControlSession {
	return r.revokeMatching(func(session domain.RemoteControlSession) bool {
		return session.ControllerParticipantID == participantID
	}, reason)
}

func (r *remoteControlRegistry) revokeForControllerMember(memberID string, reason string) []domain.RemoteControlSession {
	return r.revokeMatching(func(session domain.RemoteControlSession) bool {
		return session.ControllerMemberID == memberID
	}, reason)
}

func (r *remoteControlRegistry) revokeAll(reason string) []domain.RemoteControlSession {
	return r.revokeMatching(func(domain.RemoteControlSession) bool { return true }, reason)
}

func (r *remoteControlRegistry) revokeMatching(
	matches func(domain.RemoteControlSession) bool,
	reason string,
) []domain.RemoteControlSession {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now().UnixMilli()
	items := make([]domain.RemoteControlSession, 0)
	for id, session := range r.sessions {
		if !matches(session) || (session.Status != domain.RemoteControlPending && session.Status != domain.RemoteControlActive) {
			continue
		}
		session.Status = domain.RemoteControlRevoked
		session.EndReason = reason
		session.UpdatedAtMS = now
		session.ExpiresAtMS = 0
		session.LeaseUntilMS = 0
		session.RespectUntilMS = 0
		r.sessions[id] = session
		delete(r.rates, id)
		items = append(items, session)
	}
	return items
}

func (r *remoteControlRegistry) cleanupLocked(nowMS int64) {
	const terminalRetentionMS = int64(time.Minute / time.Millisecond)
	for id, session := range r.sessions {
		if session.Status == domain.RemoteControlPending && session.ExpiresAtMS > 0 && nowMS >= session.ExpiresAtMS {
			session.Status = domain.RemoteControlRevoked
			session.EndReason = "request_expired"
			session.UpdatedAtMS = nowMS
			session.ExpiresAtMS = 0
			r.sessions[id] = session
			r.expired = append(r.expired, session)
			delete(r.rates, id)
		}
		if session.Status == domain.RemoteControlActive && session.LeaseUntilMS > 0 && nowMS >= session.LeaseUntilMS {
			session.Status = domain.RemoteControlRevoked
			session.EndReason = "lease_expired"
			session.UpdatedAtMS = nowMS
			session.LeaseUntilMS = 0
			session.RespectUntilMS = 0
			r.sessions[id] = session
			r.expired = append(r.expired, session)
			delete(r.rates, id)
		}
		if session.Status != domain.RemoteControlRejected && session.Status != domain.RemoteControlRevoked {
			continue
		}
		if nowMS-session.UpdatedAtMS > terminalRetentionMS {
			delete(r.sessions, id)
			delete(r.rates, id)
		}
	}
	for participantID, requestRate := range r.requests {
		if requestRate.windowStartedAt.IsZero() || time.UnixMilli(nowMS).Sub(requestRate.windowStartedAt) >= remoteControlRequestWindow {
			delete(r.requests, participantID)
		}
	}
}

func (r *Router) remoteControlSessions(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	participantID := domain.VoiceParticipantID(session.MemberID, session.DeviceID)
	controls := r.remoteControls.list(
		participantID,
		r.remoteControlVisibleShareIDs(session.ServerID, session.MemberID, session.DeviceID),
	)
	r.publishRemoteControlExpirations()
	writeJSON(w, http.StatusOK, map[string]any{
		"remote_controls": nonNilSlice(controls),
	})
}

func (r *Router) requestRemoteControl(w http.ResponseWriter, req *http.Request, shareID string) {
	if req.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	if !r.store.Server().RemoteControlEnabled {
		writeError(w, http.StatusForbidden, "EV_REMOTE_CONTROL_DISABLED", "remote control is disabled")
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
	if !share.RemoteControlAllowed {
		writeError(w, http.StatusForbidden, "EV_REMOTE_CONTROL_NOT_ALLOWED", "screen share owner is not accepting control requests")
		return
	}
	if share.OwnerMemberID == session.MemberID {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "screen share owner cannot request control")
		return
	}
	if !r.store.MemberHasChannelPermission(session.MemberID, share.ChannelID, domain.PermissionRequestControl) {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "permission "+string(domain.PermissionRequestControl)+" is required")
		return
	}
	state, inVoice := r.voiceStateByDevice(session.MemberID, session.DeviceID)
	if !inVoice || state.ChannelID != share.ChannelID ||
		!r.hasScreenShareViewerSession(session.ServerID, share.ShareID, session.MemberID, session.DeviceID) {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "you must be watching this screen share to request control")
		return
	}
	ownerState, ownerInVoice := r.voiceStateByParticipant(share.OwnerParticipantID)
	if !ownerInVoice || ownerState.ChannelID != share.ChannelID {
		writeError(w, http.StatusConflict, "EV_REMOTE_CONTROL_UNAVAILABLE", "screen share owner is no longer in the voice channel")
		return
	}
	control, created, err := r.remoteControls.request(share, session.MemberID, state.ParticipantID)
	r.publishRemoteControlExpirations()
	if errors.Is(err, errRemoteControlOccupied) {
		writeError(w, http.StatusConflict, "EV_REMOTE_CONTROL_OCCUPIED", err.Error())
		return
	}
	if errors.Is(err, errRemoteControlPendingLimit) {
		writeError(w, http.StatusConflict, "EV_REMOTE_CONTROL_PENDING_LIMIT", err.Error())
		return
	}
	if errors.Is(err, errRemoteControlRequestLimit) {
		writeError(w, http.StatusTooManyRequests, "EV_REMOTE_CONTROL_REQUEST_LIMIT", err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	if created {
		r.recordRemoteControlAudit(session.MemberID, "remote_control.request", control)
		r.sendRemoteControlEvent("remote_control.requested", control)
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, control)
}

func (r *Router) remoteControlResource(w http.ResponseWriter, req *http.Request) {
	parts := strings.Split(strings.Trim(strings.TrimPrefix(req.URL.Path, "/api/v1/remote-controls/"), "/"), "/")
	if len(parts) == 2 && parts[1] == "respect" {
		r.remoteControlRespectResource(w, req, parts[0])
		return
	}
	if len(parts) == 2 && parts[1] == "heartbeat" {
		r.remoteControlHeartbeatResource(w, req, parts[0])
		return
	}
	if len(parts) != 1 || parts[0] == "" {
		writeError(w, http.StatusNotFound, "EV_NOT_FOUND", "route not found")
		return
	}
	if req.Method != http.MethodPatch {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	actorParticipantID := domain.VoiceParticipantID(session.MemberID, session.DeviceID)
	control, found := r.remoteControls.get(parts[0])
	r.publishRemoteControlExpirations()
	if !found {
		writeError(w, http.StatusNotFound, "EV_REMOTE_CONTROL_NOT_FOUND", "remote control session not found")
		return
	}
	var input struct {
		Action string `json:"action"`
	}
	if err := readJSON(req, &input); err != nil {
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", err.Error())
		return
	}
	input.Action = strings.TrimSpace(input.Action)
	var updated domain.RemoteControlSession
	var err error
	switch input.Action {
	case "approve":
		if actorParticipantID != control.OwnerParticipantID ||
			!r.store.MemberHasChannelPermission(session.MemberID, control.ChannelID, domain.PermissionAcceptControl) {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "only the screen share owner can approve control")
			return
		}
		share, exists := r.screenShareByID(control.ShareID)
		if !exists || !share.RemoteControlAllowed || !r.store.Server().RemoteControlEnabled ||
			share.OwnerParticipantID != control.OwnerParticipantID {
			writeError(w, http.StatusConflict, "EV_REMOTE_CONTROL_UNAVAILABLE", "screen share no longer accepts control")
			return
		}
		controllerState, controllerInVoice := r.voiceStateByParticipant(control.ControllerParticipantID)
		ownerState, ownerInVoice := r.voiceStateByParticipant(control.OwnerParticipantID)
		if !controllerInVoice || !ownerInVoice ||
			controllerState.ChannelID != control.ChannelID || ownerState.ChannelID != control.ChannelID ||
			!r.hasScreenShareViewerSession(session.ServerID, control.ShareID, controllerState.MemberID, controllerState.DeviceID) ||
			!r.store.MemberHasChannelPermission(control.ControllerMemberID, control.ChannelID, domain.PermissionRequestControl) {
			writeError(w, http.StatusConflict, "EV_REMOTE_CONTROL_UNAVAILABLE", "control requester is no longer watching this screen share")
			return
		}
		approved, revoked, approveErr := r.remoteControls.approve(control.ControlID)
		updated = approved
		err = approveErr
		for _, previous := range revoked {
			r.recordRemoteControlAudit(session.MemberID, "remote_control.revoke", previous)
			r.sendRemoteControlEvent("remote_control.revoked", previous)
		}
		if err == nil {
			r.recordRemoteControlAudit(session.MemberID, "remote_control.approve", updated)
			r.sendRemoteControlEvent("remote_control.approved", updated)
		}
	case "reject":
		if actorParticipantID != control.OwnerParticipantID {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "only the screen share owner can reject control")
			return
		}
		updated, err = r.remoteControls.reject(control.ControlID)
		if err == nil {
			r.recordRemoteControlAudit(session.MemberID, "remote_control.reject", updated)
			r.sendRemoteControlEvent("remote_control.rejected", updated)
		}
	case "revoke":
		if actorParticipantID != control.OwnerParticipantID && actorParticipantID != control.ControllerParticipantID &&
			!r.hasPermission(session.MemberID, domain.PermissionManageMembers) {
			writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "remote control session cannot be managed")
			return
		}
		reason := "revoked_by_member"
		if actorParticipantID != control.OwnerParticipantID && actorParticipantID != control.ControllerParticipantID {
			reason = "revoked_by_moderator"
		}
		updated, err = r.remoteControls.revoke(control.ControlID, reason)
		if err == nil {
			r.recordRemoteControlAudit(session.MemberID, "remote_control.revoke", updated)
			r.sendRemoteControlEvent("remote_control.revoked", updated)
		}
	default:
		writeError(w, http.StatusBadRequest, "EV_BAD_REQUEST", "remote control action is unsupported")
		return
	}
	if errors.Is(err, errRemoteControlNotFound) {
		writeError(w, http.StatusNotFound, "EV_REMOTE_CONTROL_NOT_FOUND", err.Error())
		return
	}
	if errors.Is(err, errRemoteControlInvalidState) {
		writeError(w, http.StatusConflict, "EV_REMOTE_CONTROL_STATE", err.Error())
		return
	}
	if errors.Is(err, errRemoteControlOccupied) {
		writeError(w, http.StatusConflict, "EV_REMOTE_CONTROL_OCCUPIED", err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (r *Router) remoteControlRespectResource(w http.ResponseWriter, req *http.Request, controlID string) {
	if req.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	actorParticipantID := domain.VoiceParticipantID(session.MemberID, session.DeviceID)
	control, found := r.remoteControls.get(controlID)
	r.publishRemoteControlExpirations()
	if !found {
		writeError(w, http.StatusNotFound, "EV_REMOTE_CONTROL_NOT_FOUND", "remote control session not found")
		return
	}
	if actorParticipantID != control.OwnerParticipantID {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "only the controlled member can suspend input")
		return
	}
	updated, err := r.remoteControls.suspend(controlID)
	if errors.Is(err, errRemoteControlInvalidState) {
		writeError(w, http.StatusConflict, "EV_REMOTE_CONTROL_STATE", err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	r.sendRemoteControlEvent("remote_control.suspended", updated)
	writeJSON(w, http.StatusOK, updated)
}

func (r *Router) remoteControlHeartbeatResource(w http.ResponseWriter, req *http.Request, controlID string) {
	if req.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "EV_METHOD_NOT_ALLOWED", "method not allowed")
		return
	}
	session, ok := r.requireSession(w, req)
	if !ok {
		return
	}
	participantID := domain.VoiceParticipantID(session.MemberID, session.DeviceID)
	control, found := r.remoteControls.get(controlID)
	r.publishRemoteControlExpirations()
	if !found {
		writeError(w, http.StatusNotFound, "EV_REMOTE_CONTROL_NOT_FOUND", "remote control session not found")
		return
	}
	if control.Status != domain.RemoteControlActive || participantID != control.ControllerParticipantID {
		writeError(w, http.StatusForbidden, "EV_PERMISSION_DENIED", "only the active controller can renew control")
		return
	}
	share, shareExists := r.screenShareByID(control.ShareID)
	controllerState, controllerInVoice := r.voiceStateByParticipant(control.ControllerParticipantID)
	ownerState, ownerInVoice := r.voiceStateByParticipant(control.OwnerParticipantID)
	if !shareExists || !share.RemoteControlAllowed || !r.store.Server().RemoteControlEnabled ||
		share.OwnerParticipantID != control.OwnerParticipantID || !controllerInVoice || !ownerInVoice ||
		controllerState.ChannelID != control.ChannelID || ownerState.ChannelID != control.ChannelID ||
		!r.hasScreenShareViewerSession(session.ServerID, control.ShareID, session.MemberID, session.DeviceID) ||
		!r.store.MemberHasChannelPermission(session.MemberID, control.ChannelID, domain.PermissionRequestControl) ||
		!r.store.MemberHasChannelPermission(control.OwnerMemberID, control.ChannelID, domain.PermissionAcceptControl) {
		if revoked, revokeErr := r.remoteControls.revoke(control.ControlID, "heartbeat_validation_failed"); revokeErr == nil {
			r.recordRemoteControlAudit(session.MemberID, "remote_control.revoke", revoked)
			r.sendRemoteControlEvent("remote_control.revoked", revoked)
		}
		writeError(w, http.StatusConflict, "EV_REMOTE_CONTROL_UNAVAILABLE", "remote control authorization is no longer valid")
		return
	}
	updated, err := r.remoteControls.heartbeat(controlID, participantID)
	if errors.Is(err, errRemoteControlNotFound) {
		writeError(w, http.StatusNotFound, "EV_REMOTE_CONTROL_NOT_FOUND", err.Error())
		return
	}
	if errors.Is(err, errRemoteControlInvalidState) {
		writeError(w, http.StatusConflict, "EV_REMOTE_CONTROL_STATE", err.Error())
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "EV_INTERNAL", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (r *Router) handleRemoteControlInput(identity ws.ClientIdentity, event ws.Event) {
	if !r.store.Server().RemoteControlEnabled {
		return
	}
	payload, err := json.Marshal(event.Payload)
	if err != nil || len(payload) > 4096 {
		return
	}
	var input domain.RemoteControlInput
	if err := json.Unmarshal(payload, &input); err != nil || validateRemoteControlInput(input) != nil {
		return
	}
	controllerParticipantID := domain.VoiceParticipantID(identity.MemberID, identity.DeviceID)
	control, err := r.remoteControls.authorizeInput(input.ControlID, controllerParticipantID, input.Sequence)
	r.publishRemoteControlExpirations()
	if err != nil {
		if errors.Is(err, errRemoteControlRespect) {
			r.hub.SendToDevice(identity.ServerID, identity.MemberID, identity.DeviceID, ws.Event{
				Type:    "remote_control.suspended",
				Payload: control,
			})
		}
		return
	}
	share, exists := r.screenShareByID(control.ShareID)
	if !exists || !share.RemoteControlAllowed || share.OwnerMemberID != control.OwnerMemberID ||
		share.OwnerParticipantID != control.OwnerParticipantID ||
		!r.hasScreenShareViewerSession(identity.ServerID, share.ShareID, identity.MemberID, identity.DeviceID) {
		if revoked, revokeErr := r.remoteControls.revoke(control.ControlID, "screen_share_unavailable"); revokeErr == nil {
			r.recordRemoteControlAudit(identity.MemberID, "remote_control.revoke", revoked)
			r.sendRemoteControlEvent("remote_control.revoked", revoked)
		}
		return
	}
	controllerState, controllerInVoice := r.voiceStateByParticipant(control.ControllerParticipantID)
	ownerState, ownerInVoice := r.voiceStateByParticipant(control.OwnerParticipantID)
	if !controllerInVoice || !ownerInVoice || controllerState.ChannelID != control.ChannelID || ownerState.ChannelID != control.ChannelID ||
		!r.store.MemberHasChannelPermission(identity.MemberID, control.ChannelID, domain.PermissionRequestControl) ||
		!r.store.MemberHasChannelPermission(control.OwnerMemberID, control.ChannelID, domain.PermissionAcceptControl) {
		if revoked, revokeErr := r.remoteControls.revoke(control.ControlID, "permission_changed"); revokeErr == nil {
			r.recordRemoteControlAudit(identity.MemberID, "remote_control.revoke", revoked)
			r.sendRemoteControlEvent("remote_control.revoked", revoked)
		}
		return
	}
	input.ControllerMemberID = identity.MemberID
	input.ControllerParticipantID = controllerParticipantID
	r.hub.SendToDevice(identity.ServerID, ownerState.MemberID, ownerState.DeviceID, ws.Event{
		Type:    "remote_control.input",
		Payload: input,
	})
}

func validateRemoteControlInput(input domain.RemoteControlInput) error {
	if strings.TrimSpace(input.ControlID) == "" || input.Sequence == 0 {
		return errors.New("remote control input identity is missing")
	}
	event := input.Event
	if len(event.Code) > 64 || len(event.Key) > 64 || len(event.Modifiers) > 8 {
		return errors.New("remote control input is too large")
	}
	for _, modifier := range event.Modifiers {
		if !matchesRemoteControlModifier(modifier) {
			return errors.New("remote control modifier is unsupported")
		}
	}
	switch event.Type {
	case "pointer_move", "pointer_button", "wheel":
		if math.IsNaN(event.X) || math.IsNaN(event.Y) || event.X < 0 || event.X > 1 || event.Y < 0 || event.Y > 1 {
			return errors.New("remote control pointer coordinate is invalid")
		}
		if event.Button < 0 || event.Button > 4 || event.Buttons < 0 || event.Buttons > 31 {
			return errors.New("remote control pointer button is invalid")
		}
		if math.IsNaN(event.DeltaX) || math.IsNaN(event.DeltaY) ||
			math.IsInf(event.DeltaX, 0) || math.IsInf(event.DeltaY, 0) ||
			math.Abs(event.DeltaX) > 10_000 || math.Abs(event.DeltaY) > 10_000 {
			return errors.New("remote control wheel delta is invalid")
		}
	case "key":
		if strings.TrimSpace(event.Code) == "" {
			return errors.New("remote control key code is required")
		}
	case "release_all":
		// The controlled client uses this when focus leaves the viewer so a
		// missed pointer-up or key-up cannot leave input pressed remotely.
	default:
		return errors.New("remote control input type is unsupported")
	}
	return nil
}

func matchesRemoteControlModifier(value string) bool {
	switch value {
	case "Alt", "Control", "Meta", "Shift":
		return true
	default:
		return false
	}
}

func containsMemberID(items []string, memberID string) bool {
	for _, item := range items {
		if item == memberID {
			return true
		}
	}
	return false
}

func (r *Router) sendRemoteControlEvent(eventType string, control domain.RemoteControlSession) {
	event := ws.Event{Type: eventType, Payload: control}
	serverID := r.store.Server().ServerID
	type recipient struct {
		memberID string
		deviceID string
	}
	recipients := make(map[string]recipient)
	addRecipient := func(memberID string, deviceID string) {
		if memberID == "" || deviceID == "" {
			return
		}
		recipients[memberID+"\x00"+deviceID] = recipient{memberID: memberID, deviceID: deviceID}
	}
	if ownerState, found := r.voiceStateByParticipant(control.OwnerParticipantID); found {
		addRecipient(ownerState.MemberID, ownerState.DeviceID)
	}
	if controllerState, found := r.voiceStateByParticipant(control.ControllerParticipantID); found {
		addRecipient(controllerState.MemberID, controllerState.DeviceID)
	}
	if eventType == "remote_control.approved" || eventType == "remote_control.revoked" || eventType == "remote_control.suspended" {
		for _, viewer := range r.remoteControlViewerSessions(serverID, control.ShareID) {
			addRecipient(viewer.MemberID, viewer.DeviceID)
		}
	}
	for _, target := range recipients {
		r.hub.SendToDevice(serverID, target.memberID, target.deviceID, event)
	}
}

func (r *Router) remoteControlVisibleShareIDs(serverID string, memberID string, deviceID string) map[string]struct{} {
	r.screenViewerMu.Lock()
	defer r.screenViewerMu.Unlock()
	shareIDs := make(map[string]struct{})
	for _, viewer := range r.screenViewerSessions {
		if viewer.ServerID == serverID && viewer.MemberID == memberID && viewer.DeviceID == deviceID {
			shareIDs[viewer.ShareID] = struct{}{}
		}
	}
	return shareIDs
}

func (r *Router) remoteControlViewerSessions(serverID string, shareID string) []screenShareViewerSession {
	r.screenViewerMu.Lock()
	defer r.screenViewerMu.Unlock()
	viewers := make([]screenShareViewerSession, 0)
	for _, viewer := range r.screenViewerSessions {
		if viewer.ServerID == serverID && viewer.ShareID == shareID {
			viewers = append(viewers, viewer)
		}
	}
	return viewers
}

func (r *Router) recordRemoteControlAudit(actorMemberID string, action string, control domain.RemoteControlSession) {
	r.recordAudit(actorMemberID, action, "remote_control", control.ControlID, map[string]string{
		"share_id":                  control.ShareID,
		"channel_id":                control.ChannelID,
		"channel_name":              r.channelAuditName(control.ChannelID),
		"owner_member_id":           control.OwnerMemberID,
		"owner_participant_id":      control.OwnerParticipantID,
		"controller_member_id":      control.ControllerMemberID,
		"controller_participant_id": control.ControllerParticipantID,
		"status":                    string(control.Status),
		"reason":                    control.EndReason,
	})
}

func (r *Router) publishRemoteControlExpirations() {
	for _, control := range r.remoteControls.takeExpired() {
		r.recordRemoteControlAudit(control.ControllerMemberID, "remote_control.expire", control)
		r.sendRemoteControlEvent("remote_control.revoked", control)
	}
}

func (r *Router) endRemoteControlsForShare(shareID string, actorMemberID string, reason string) {
	for _, control := range r.remoteControls.revokeForShare(shareID, reason) {
		r.recordRemoteControlAudit(actorMemberID, "remote_control.revoke", control)
		r.sendRemoteControlEvent("remote_control.revoked", control)
	}
}

func (r *Router) endRemoteControlsForController(participantID string, reason string) {
	for _, control := range r.remoteControls.revokeForController(participantID, reason) {
		r.recordRemoteControlAudit(control.ControllerMemberID, "remote_control.revoke", control)
		r.sendRemoteControlEvent("remote_control.revoked", control)
	}
}

func (r *Router) endRemoteControlsForControllerMember(memberID string, reason string) {
	for _, control := range r.remoteControls.revokeForControllerMember(memberID, reason) {
		r.recordRemoteControlAudit(control.ControllerMemberID, "remote_control.revoke", control)
		r.sendRemoteControlEvent("remote_control.revoked", control)
	}
}

func (r *Router) endAllRemoteControls(actorMemberID string, reason string) {
	for _, control := range r.remoteControls.revokeAll(reason) {
		r.recordRemoteControlAudit(actorMemberID, "remote_control.revoke", control)
		r.sendRemoteControlEvent("remote_control.revoked", control)
	}
}
