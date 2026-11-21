package mediarelay

import (
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"

	"github.com/echovoice/echovoice/services/ev-server/internal/config"
)

// The TURN relay is the only place where an EchoVoice server carries media, so
// this measures the number the user actually asks about: how many megabit per
// second one relayed peer connection can push, and how many relayed peers fit
// before the port range runs out. Signalling limits never cap this.
func TestEmbeddedTURNRelayThroughputAndCapacity(t *testing.T) {
	if testing.Short() {
		t.Skip("throughput measurement takes about a second")
	}
	relayMinPort, relayMaxPort := availableUDPPortRange(t)
	cfg := config.Defaults()
	cfg.RTC.TURN.ListenHost = "127.0.0.1"
	cfg.RTC.TURN.PublicHost = "127.0.0.1"
	cfg.RTC.TURN.Port = 0
	cfg.RTC.TURN.RelayMinPort = relayMinPort
	cfg.RTC.TURN.RelayMaxPort = relayMaxPort
	cfg.RTC.TURN.TCPEnabled = false
	cfg.RTC.TURN.AuthSecret = "turn-throughput-test-secret"

	server, err := Start(cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()

	username, credential, err := turn.GenerateLongTermTURNRESTCredentials(
		cfg.RTC.TURN.AuthSecret,
		"throughput-device",
		time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	clientA, allocationA := allocateTURNClient(t, server.UDPAddress(), cfg.RTC.TURN.Realm, username, credential)
	defer clientA.Close()
	defer allocationA.Close()
	clientB, allocationB := allocateTURNClient(t, server.UDPAddress(), cfg.RTC.TURN.Realm, username, credential)
	defer clientB.Close()
	defer allocationB.Close()

	// TURN only forwards once both sides hold a permission, and a permission is
	// created by sending. Write in both directions, then drain A until B's
	// datagram arrives: only then is the measurement below pure relay
	// throughput instead of handshake.
	if _, err := allocationA.WriteTo([]byte("warmup-a"), allocationB.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	if _, err := allocationB.WriteTo([]byte("warmup-b"), allocationA.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	if err := allocationA.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	warmup := make([]byte, 64)
	for {
		n, _, err := allocationA.ReadFrom(warmup)
		if err != nil {
			t.Fatalf("relay did not pass the warmup datagram: %v", err)
		}
		if string(warmup[:n]) == "warmup-b" {
			break
		}
	}

	const payloadBytes = 1200 // close to a large media packet
	payload := make([]byte, payloadBytes)
	var delivered int64
	var wg sync.WaitGroup
	stop := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		buffer := make([]byte, 2048)
		if err := allocationB.SetReadDeadline(time.Time{}); err != nil {
			return
		}
		for {
			select {
			case <-stop:
				return
			default:
			}
			if err := allocationB.SetReadDeadline(time.Now().Add(200 * time.Millisecond)); err != nil {
				return
			}
			n, _, err := allocationB.ReadFrom(buffer)
			if err != nil {
				if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
					select {
					case <-stop:
						return
					default:
						continue
					}
				}
				return
			}
			atomic.AddInt64(&delivered, int64(n))
		}
	}()

	deadline := time.Now().Add(1 * time.Second)
	var sent int64
	for time.Now().Before(deadline) {
		if _, err := allocationA.WriteTo(payload, allocationB.LocalAddr()); err != nil {
			t.Fatalf("relay write failed: %v", err)
		}
		sent += payloadBytes
	}
	close(stop)
	wg.Wait()

	received := atomic.LoadInt64(&delivered)
	const elapsedSeconds = 1.0
	t.Logf(
		"one relayed pair delivered %.1f MB in 1s (%.0f Mbit/s); the sender handed %.1f MB to the relay, so %.1f%% survived the loopback copy",
		float64(received)/(1<<20),
		float64(received)*8/elapsedSeconds/1e6,
		float64(sent)/(1<<20),
		float64(received)*100/float64(sent),
	)
	if received == 0 {
		t.Fatal("the relay delivered nothing at all")
	}

	// Capacity is the port range, not bandwidth: one allocation per relayed
	// peer, and the range above only had 16 ports. Everything past it has to
	// fail cleanly rather than hang the caller.
	allocationLimit := relayMaxPort - relayMinPort + 1
	extra := make([]*turn.Client, 0, allocationLimit)
	defer func() {
		for _, client := range extra {
			client.Close()
		}
	}()
	for index := 0; index < allocationLimit; index++ {
		conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		client, err := turn.NewClient(&turn.ClientConfig{
			Conn:           conn,
			STUNServerAddr: server.UDPAddress(),
			TURNServerAddr: server.UDPAddress(),
			Username:       username,
			Password:       credential,
			Realm:          cfg.RTC.TURN.Realm,
			LoggerFactory:  logging.NewDefaultLoggerFactory(),
		})
		if err != nil {
			conn.Close()
			t.Fatal(err)
		}
		if err := client.Listen(); err != nil {
			client.Close()
			t.Fatal(err)
		}
		if _, err := client.Allocate(); err != nil {
			// The two clients above already hold two of the sixteen ports.
			client.Close()
			t.Logf("allocation %d was refused after the port range filled: %v", index, err)
			break
		}
		extra = append(extra, client)
	}
	if len(extra) == 0 {
		t.Fatal("the relay refused every additional allocation, so the range above was not usable")
	}
	t.Logf(
		"port range %d-%d accepted %d further allocations on top of the measurement pair",
		relayMinPort,
		relayMaxPort,
		len(extra),
	)
}
