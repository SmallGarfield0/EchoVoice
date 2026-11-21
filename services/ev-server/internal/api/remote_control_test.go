package api

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/echovoice/echovoice/services/ev-server/internal/domain"
)

func TestRemoteControlRegistryInputAuthorizationAndCleanup(t *testing.T) {
	registry := newRemoteControlRegistry()
	share := domain.ScreenShareSession{
		ShareID:              "share_test",
		ChannelID:            "channel_test",
		OwnerMemberID:        "owner_test",
		OwnerParticipantID:   "owner_participant_test",
		RemoteControlAllowed: true,
	}
	control, created, err := registry.request(share, "controller_test", "controller_participant_test")
	if err != nil || !created {
		t.Fatalf("request remote control: created=%t err=%v", created, err)
	}
	if control.OwnerParticipantID != share.OwnerParticipantID || control.ControllerParticipantID != "controller_participant_test" {
		t.Fatalf("expected participant-bound control session, got %+v", control)
	}
	if len(registry.list("another_participant", nil)) != 0 {
		t.Fatal("another device participant must not list this control session")
	}
	if _, err := registry.authorizeInput(control.ControlID, "controller_participant_test", 1); !errors.Is(err, errRemoteControlInvalidState) {
		t.Fatalf("expected pending session to reject input, got %v", err)
	}
	control, _, err = registry.approve(control.ControlID)
	if err != nil {
		t.Fatalf("approve remote control: %v", err)
	}
	if _, err := registry.authorizeInput(control.ControlID, "another_participant", 1); !errors.Is(err, errRemoteControlInvalidState) {
		t.Fatalf("expected another device participant to be rejected, got %v", err)
	}
	if _, err := registry.authorizeInput(control.ControlID, "controller_participant_test", 1); err != nil {
		t.Fatalf("authorize first input: %v", err)
	}
	if _, err := registry.authorizeInput(control.ControlID, "controller_participant_test", 1); !errors.Is(err, errRemoteControlSequence) {
		t.Fatalf("expected duplicate sequence to be rejected, got %v", err)
	}
	if _, err := registry.suspend(control.ControlID); err != nil {
		t.Fatalf("suspend remote control: %v", err)
	}
	if _, err := registry.authorizeInput(control.ControlID, "controller_participant_test", 2); !errors.Is(err, errRemoteControlRespect) {
		t.Fatalf("expected respect window to reject input, got %v", err)
	}
	revoked := registry.revokeForShare(share.ShareID, "screen_share_ended")
	if len(revoked) != 1 || revoked[0].Status != domain.RemoteControlRevoked {
		t.Fatalf("expected one revoked control session, got %+v", revoked)
	}
}

func TestRemoteControlRegistryExpiresPendingRequestsAndActiveLeases(t *testing.T) {
	registry := newRemoteControlRegistry()
	share := domain.ScreenShareSession{
		ShareID:            "share_expiry",
		ChannelID:          "channel_test",
		OwnerMemberID:      "owner_test",
		OwnerParticipantID: "owner_participant_test",
	}
	pending, _, err := registry.request(share, "controller_test", "controller_participant_test")
	if err != nil {
		t.Fatalf("request remote control: %v", err)
	}
	if pending.ExpiresAtMS <= pending.RequestedAtMS {
		t.Fatalf("pending request is missing its expiry: %+v", pending)
	}
	registry.mu.Lock()
	expiredPending := registry.sessions[pending.ControlID]
	expiredPending.ExpiresAtMS = time.Now().Add(-time.Second).UnixMilli()
	registry.sessions[pending.ControlID] = expiredPending
	registry.mu.Unlock()
	if listed := registry.list(share.OwnerParticipantID, nil); len(listed) != 0 {
		t.Fatalf("expired pending request remained visible: %+v", listed)
	}
	if ended, found := registry.get(pending.ControlID); !found || ended.Status != domain.RemoteControlRevoked || ended.EndReason != "request_expired" {
		t.Fatalf("pending request did not expire safely: found=%t session=%+v", found, ended)
	}

	active, _, err := registry.request(share, "controller_test", "controller_participant_test")
	if err != nil {
		t.Fatalf("request replacement control: %v", err)
	}
	active, _, err = registry.approve(active.ControlID)
	if err != nil {
		t.Fatalf("approve replacement control: %v", err)
	}
	if active.GrantGeneration == 0 || active.LeaseUntilMS <= active.UpdatedAtMS || active.TransportState != "websocket" {
		t.Fatalf("active control is missing production lease metadata: %+v", active)
	}
	if _, err := registry.heartbeat(active.ControlID, "another_participant"); !errors.Is(err, errRemoteControlInvalidState) {
		t.Fatalf("another participant renewed the lease: %v", err)
	}
	renewed, err := registry.heartbeat(active.ControlID, active.ControllerParticipantID)
	if err != nil || renewed.LeaseUntilMS <= time.Now().UnixMilli() {
		t.Fatalf("active controller could not renew lease: session=%+v err=%v", renewed, err)
	}
	registry.mu.Lock()
	expiredActive := registry.sessions[active.ControlID]
	expiredActive.LeaseUntilMS = time.Now().Add(-time.Second).UnixMilli()
	registry.sessions[active.ControlID] = expiredActive
	registry.mu.Unlock()
	if _, err := registry.authorizeInput(active.ControlID, active.ControllerParticipantID, 1); !errors.Is(err, errRemoteControlInvalidState) {
		t.Fatalf("expired active lease accepted input: %v", err)
	}
	if ended, found := registry.get(active.ControlID); !found || ended.Status != domain.RemoteControlRevoked || ended.EndReason != "lease_expired" {
		t.Fatalf("active lease did not expire safely: found=%t session=%+v", found, ended)
	}
}

func TestRemoteControlRegistryLimitsPendingAndRequestFloods(t *testing.T) {
	registry := newRemoteControlRegistry()
	share := domain.ScreenShareSession{
		ShareID:            "share_pending_limit",
		ChannelID:          "channel_test",
		OwnerMemberID:      "owner_test",
		OwnerParticipantID: "owner_participant_test",
	}
	for index := 0; index < remoteControlPendingShareLimit; index++ {
		if _, _, err := registry.request(share, "controller", "participant_"+string(rune('a'+index))); err != nil {
			t.Fatalf("request %d before pending limit: %v", index, err)
		}
	}
	if _, _, err := registry.request(share, "controller", "participant_overflow"); !errors.Is(err, errRemoteControlPendingLimit) {
		t.Fatalf("expected pending request limit, got %v", err)
	}

	floodRegistry := newRemoteControlRegistry()
	for index := 0; index < remoteControlRequestLimit; index++ {
		floodShare := share
		floodShare.ShareID = "share_flood_" + string(rune('a'+index))
		if _, _, err := floodRegistry.request(floodShare, "controller", "participant_flood"); err != nil {
			t.Fatalf("request %d before request limit: %v", index, err)
		}
	}
	overflowShare := share
	overflowShare.ShareID = "share_flood_overflow"
	if _, _, err := floodRegistry.request(overflowShare, "controller", "participant_flood"); !errors.Is(err, errRemoteControlRequestLimit) {
		t.Fatalf("expected request rate limit, got %v", err)
	}
}

func TestRemoteControlRegistryKeepsOneActiveControllerPerShare(t *testing.T) {
	registry := newRemoteControlRegistry()
	share := domain.ScreenShareSession{
		ShareID:              "share_single_controller",
		ChannelID:            "channel_test",
		OwnerMemberID:        "owner_test",
		OwnerParticipantID:   "owner_participant_test",
		RemoteControlAllowed: true,
	}
	first, _, err := registry.request(share, "controller_one", "participant_one")
	if err != nil {
		t.Fatalf("request first controller: %v", err)
	}
	second, _, err := registry.request(share, "controller_two", "participant_two")
	if err != nil {
		t.Fatalf("queue second controller: %v", err)
	}
	first, _, err = registry.approve(first.ControlID)
	if err != nil || first.Status != domain.RemoteControlActive {
		t.Fatalf("approve first controller: session=%+v err=%v", first, err)
	}
	visible := registry.list("watching_participant", map[string]struct{}{share.ShareID: {}})
	if len(visible) != 1 || visible[0].ControlID != first.ControlID {
		t.Fatalf("expected viewer to see the active controller, got %+v", visible)
	}
	if _, _, err := registry.approve(second.ControlID); !errors.Is(err, errRemoteControlOccupied) {
		t.Fatalf("expected second approval to be rejected while occupied, got %v", err)
	}
	if _, _, err := registry.request(share, "controller_three", "participant_three"); !errors.Is(err, errRemoteControlOccupied) {
		t.Fatalf("expected new requests to wait while occupied, got %v", err)
	}
	if _, err := registry.revoke(first.ControlID, "controller_finished"); err != nil {
		t.Fatalf("revoke first controller: %v", err)
	}
	second, _, err = registry.approve(second.ControlID)
	if err != nil || second.Status != domain.RemoteControlActive {
		t.Fatalf("expected queued controller to become active after release: session=%+v err=%v", second, err)
	}
}

func TestRemoteControlInputJSONPreservesRequiredZeroValues(t *testing.T) {
	event := domain.RemoteControlInputEvent{
		Type:      "pointer_button",
		X:         0,
		Y:         0,
		Button:    0,
		Buttons:   0,
		Pressed:   false,
		Modifiers: []string{},
	}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("marshal remote control input: %v", err)
	}
	encoded := string(raw)
	for _, field := range []string{`"x":0`, `"y":0`, `"button":0`, `"buttons":0`, `"pressed":false`, `"modifiers":[]`} {
		if !strings.Contains(encoded, field) {
			t.Fatalf("required remote control field %s was omitted from %s", field, encoded)
		}
	}
}

func TestValidateRemoteControlInputRejectsNonFiniteWheelDelta(t *testing.T) {
	input := domain.RemoteControlInput{
		ControlID: "control_test",
		Sequence:  1,
		Event: domain.RemoteControlInputEvent{
			Type:   "wheel",
			X:      0.5,
			Y:      0.5,
			DeltaY: math.NaN(),
		},
	}
	if err := validateRemoteControlInput(input); err == nil {
		t.Fatal("expected non-finite wheel delta to be rejected")
	}
}

func TestValidateRemoteControlInputAllowsReleaseAll(t *testing.T) {
	input := domain.RemoteControlInput{
		ControlID: "control_test",
		Sequence:  2,
		Event: domain.RemoteControlInputEvent{
			Type: "release_all",
		},
	}
	if err := validateRemoteControlInput(input); err != nil {
		t.Fatalf("expected release_all input to be accepted, got %v", err)
	}
}
