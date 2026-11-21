package ws

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/echovoice/echovoice/services/ev-server/internal/auth"
	"nhooyr.io/websocket"
)

func TestServerPingKeepsSessionAliveWithoutClientMessages(t *testing.T) {
	hub := NewHub()
	hub.pingInterval = 10 * time.Millisecond
	hub.pingTimeout = 200 * time.Millisecond
	sessions := auth.NewSessionStore(100 * time.Millisecond)
	token, err := sessions.Create("server", "member", "device")
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	identity := ClientIdentity{
		ServerID:     "server",
		MemberID:     "member",
		DeviceID:     "device",
		SessionToken: token,
	}
	var keepAliveCalls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		hub.ServeHTTP(w, req, identity, nil, nil, func(received ClientIdentity) bool {
			if received != identity {
				t.Errorf("unexpected keep-alive identity: %+v", received)
				return false
			}
			keepAliveCalls.Add(1)
			return sessions.Touch(received.SessionToken)
		})
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatalf("dial event socket: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	conn.CloseRead(context.Background())

	time.Sleep(350 * time.Millisecond)
	if keepAliveCalls.Load() < 5 {
		t.Fatalf("server ping did not renew the session repeatedly; calls=%d", keepAliveCalls.Load())
	}
	if _, ok := sessions.Authenticate(token); !ok {
		t.Fatal("session expired while its event socket remained active")
	}
}

func TestRTCSignalUsesPriorityQueueWhenNormalQueueIsFull(t *testing.T) {
	hub := NewHub()
	sub := &client{
		identity: ClientIdentity{ServerID: "server", MemberID: "member", DeviceID: "device"},
		send:     make(chan Event, 1),
		priority: make(chan Event, 1),
	}
	if !hub.register(sub) {
		t.Fatal("first client registration should report online transition")
	}
	sub.send <- Event{Type: "member.presence.updated"}

	if !hub.SendToDevice("server", "member", "device", Event{Type: "rtc.signal"}) {
		t.Fatal("RTC signal should be accepted while the normal event queue is full")
	}
	select {
	case event := <-sub.priority:
		if event.Type != "rtc.signal" {
			t.Fatalf("unexpected priority event: %+v", event)
		}
	default:
		t.Fatal("RTC signal was not placed in the priority queue")
	}
}

func TestOverlappingDeviceSocketsDoNotReportOfflineUntilLastSocketCloses(t *testing.T) {
	hub := NewHub()
	identity := ClientIdentity{ServerID: "server", MemberID: "member", DeviceID: "device"}
	first := &client{identity: identity, send: make(chan Event, 1), priority: make(chan Event, 1)}
	second := &client{identity: identity, send: make(chan Event, 1), priority: make(chan Event, 1)}

	if !hub.register(first) {
		t.Fatal("first socket should report an online transition")
	}
	if hub.register(second) {
		t.Fatal("overlapping socket for the same device must not report a second online transition")
	}
	if hub.unregister(first) {
		t.Fatal("closing one overlapping socket must not report the device offline")
	}
	if !hub.IsDeviceOnline(identity.ServerID, identity.MemberID, identity.DeviceID) {
		t.Fatal("device should remain online through the replacement socket")
	}
	if !hub.unregister(second) {
		t.Fatal("closing the final socket should report the device offline")
	}
}

func TestHubOptionsReplaceTheLibraryDefaults(t *testing.T) {
	hub := NewHub(WithReadLimit(4<<20), WithQueueDepths(16, 32))
	if hub.readLimitBytes != 4<<20 {
		t.Fatalf("read limit = %d, want %d", hub.readLimitBytes, 4<<20)
	}
	if hub.sendQueueDepth != 16 || hub.priorityQueueDepth != 32 {
		t.Fatalf("queue depths = %d/%d, want 16/32", hub.sendQueueDepth, hub.priorityQueueDepth)
	}
	// Options must not be able to erase the safety net by accident.
	plain := NewHub()
	if plain.readLimitBytes != readLimitBytes {
		t.Fatalf("default read limit = %d, want %d", plain.readLimitBytes, readLimitBytes)
	}
	zeroed := NewHub(WithReadLimit(0), WithQueueDepths(0, 0))
	if zeroed.readLimitBytes != readLimitBytes || zeroed.sendQueueDepth != sendQueueDepth {
		t.Fatal("a zero option must keep the default instead of disabling the queue")
	}
}
