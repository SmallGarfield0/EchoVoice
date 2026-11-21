package ws

import (
	"context"
	"net/http"
	"sync"
	"time"

	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
)

type Event struct {
	Type    string `json:"type"`
	Payload any    `json:"payload"`
}

const (
	// One megabyte is far more than any legal signalling message (an SDP with
	// every codec and a full candidate list is a few KiB) while still refusing
	// to buffer an unbounded body from a client that is trying to hurt us.
	readLimitBytes = 1 << 20
	// Signalling bursts arrive faster than a slow consumer drains them: a fresh
	// screen-share viewer produces an offer, an answer and a dozen candidates
	// back to back. The queues drop on overflow, so they have to be deep enough
	// that a normal burst is never the thing that loses an offer.
	sendQueueDepth     = 1024
	priorityQueueDepth = 2048
)

// Option tunes a Hub. The defaults match what a normal deployment wants; the
// values are configurable because a busy server on fast hardware can push far
// more negotiation traffic than a laptop does.
type Option func(*Hub)

// WithReadLimit sets the per-message read limit. -1 disables the cap.
func WithReadLimit(bytes int64) Option {
	return func(h *Hub) {
		if bytes != 0 {
			h.readLimitBytes = bytes
		}
	}
}

// WithQueueDepths sets how many events may wait for one client before the hub
// starts dropping them.
func WithQueueDepths(send int, priority int) Option {
	return func(h *Hub) {
		if send > 0 {
			h.sendQueueDepth = send
		}
		if priority > 0 {
			h.priorityQueueDepth = priority
		}
	}
}

type ClientIdentity struct {
	ServerID     string
	MemberID     string
	DeviceID     string
	SessionToken string
}

type InboundHandler func(identity ClientIdentity, event Event)
type PresenceHandler func(identity ClientIdentity, online bool)
type KeepAliveHandler func(identity ClientIdentity) bool

type Hub struct {
	mu           sync.Mutex
	clients      map[*client]struct{}
	pingInterval time.Duration
	pingTimeout  time.Duration

	readLimitBytes     int64
	sendQueueDepth     int
	priorityQueueDepth int
}

type client struct {
	identity ClientIdentity
	send     chan Event
	priority chan Event
}

func NewHub(options ...Option) *Hub {
	hub := &Hub{
		clients:            make(map[*client]struct{}),
		pingInterval:       20 * time.Second,
		pingTimeout:        15 * time.Second,
		readLimitBytes:     readLimitBytes,
		sendQueueDepth:     sendQueueDepth,
		priorityQueueDepth: priorityQueueDepth,
	}
	for _, option := range options {
		option(hub)
	}
	return hub
}

func (h *Hub) ServeHTTP(
	w http.ResponseWriter,
	req *http.Request,
	identity ClientIdentity,
	handleInbound InboundHandler,
	handlePresence PresenceHandler,
	handleKeepAlive KeepAliveHandler,
) {
	conn, err := websocket.Accept(w, req, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	// nhooyr.io/websocket closes the socket with StatusMessageTooBig as soon as
	// one message exceeds its 32 KiB default, and nothing here ever sets a limit.
	// Screen-share renegotiation carries a full SDP per offer, so a browse that
	// happens to bundle enough of them would kill the signalling socket in the
	// middle of a negotiation and the viewer would never see the offer at all.
	conn.SetReadLimit(h.readLimitBytes)
	defer conn.Close(websocket.StatusNormalClosure, "")

	ctx := req.Context()
	sub := &client{
		identity: identity,
		send:     make(chan Event, h.sendQueueDepth),
		priority: make(chan Event, h.priorityQueueDepth),
	}
	if h.register(sub) && handlePresence != nil {
		handlePresence(identity, true)
	}
	defer func() {
		if h.unregister(sub) && handlePresence != nil {
			handlePresence(identity, false)
		}
	}()

	errc := make(chan error, 1)
	go func() {
		for {
			var event Event
			if err := wsjson.Read(ctx, conn, &event); err != nil {
				errc <- err
				return
			}
			if handleInbound != nil && event.Type != "" {
				handleInbound(identity, event)
			}
		}
	}()

	pingTicker := time.NewTicker(h.pingInterval)
	defer pingTicker.Stop()
	for {
		// Drain latency-sensitive RTC signaling and voice activity without ever
		// making producers wait on a slow client. Neither should sit behind
		// presence, audit, or other workspace updates.
		select {
		case event, ok := <-sub.priority:
			if !ok || !writeEvent(ctx, conn, event) {
				return
			}
			continue
		default:
		}
		select {
		case <-ctx.Done():
			return
		case <-errc:
			return
		case <-pingTicker.C:
			pingCtx, cancel := context.WithTimeout(ctx, h.pingTimeout)
			err := conn.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}
			if handleKeepAlive != nil && !handleKeepAlive(identity) {
				return
			}
		case event, ok := <-sub.priority:
			if !ok || !writeEvent(ctx, conn, event) {
				return
			}
		case event, ok := <-sub.send:
			if !ok || !writeEvent(ctx, conn, event) {
				return
			}
		}
	}
}

func writeEvent(ctx context.Context, conn *websocket.Conn, event Event) bool {
	writeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	err := wsjson.Write(writeCtx, conn, event)
	cancel()
	return err == nil
}

func enqueueClientEvent(sub *client, event Event) bool {
	queue := sub.send
	if event.Type == "rtc.signal" || event.Type == "voice.speaking.updated" {
		queue = sub.priority
	}
	select {
	case queue <- event:
		return true
	default:
		return false
	}
}

func (h *Hub) Broadcast(event Event) {
	h.mu.Lock()
	defer h.mu.Unlock()

	for sub := range h.clients {
		enqueueClientEvent(sub, event)
	}
}

func (h *Hub) BroadcastExcept(serverID string, exceptMemberID string, event Event) {
	h.mu.Lock()
	defer h.mu.Unlock()

	for sub := range h.clients {
		if sub.identity.ServerID != serverID || sub.identity.MemberID == exceptMemberID {
			continue
		}
		enqueueClientEvent(sub, event)
	}
}

func (h *Hub) SendToMember(serverID string, memberID string, event Event) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	delivered := false
	for sub := range h.clients {
		if sub.identity.ServerID != serverID || sub.identity.MemberID != memberID {
			continue
		}
		delivered = enqueueClientEvent(sub, event) || delivered
	}
	return delivered
}

func (h *Hub) SendToDevice(serverID string, memberID string, deviceID string, event Event) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	delivered := false
	for sub := range h.clients {
		if sub.identity.ServerID != serverID || sub.identity.MemberID != memberID || sub.identity.DeviceID != deviceID {
			continue
		}
		delivered = enqueueClientEvent(sub, event) || delivered
	}
	return delivered
}

func (h *Hub) IsMemberOnline(serverID string, memberID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for sub := range h.clients {
		if sub.identity.ServerID == serverID && sub.identity.MemberID == memberID {
			return true
		}
	}
	return false
}

func (h *Hub) IsDeviceOnline(serverID string, memberID string, deviceID string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for sub := range h.clients {
		if sub.identity.ServerID == serverID && sub.identity.MemberID == memberID && sub.identity.DeviceID == deviceID {
			return true
		}
	}
	return false
}

func (h *Hub) DisconnectMember(serverID string, memberID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for sub := range h.clients {
		if sub.identity.ServerID == serverID && sub.identity.MemberID == memberID {
			close(sub.send)
			close(sub.priority)
			delete(h.clients, sub)
		}
	}
}

func (h *Hub) register(sub *client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	wasOnline := false
	for existing := range h.clients {
		if existing.identity == sub.identity {
			wasOnline = true
			break
		}
	}
	h.clients[sub] = struct{}{}
	return !wasOnline
}

func (h *Hub) unregister(sub *client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[sub]; !ok {
		return false
	}
	delete(h.clients, sub)
	close(sub.send)
	close(sub.priority)
	for existing := range h.clients {
		if existing.identity == sub.identity {
			return false
		}
	}
	return true
}
