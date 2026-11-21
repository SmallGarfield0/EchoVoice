package mediarelay

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"

	"github.com/echovoice/echovoice/services/ev-server/internal/config"
)

func TestEmbeddedTURNAllocatesUDPRelay(t *testing.T) {
	server, realm, username, credential := startLoopbackTURN(t)
	clientA, allocationA := allocateTURNClient(t, server.UDPAddress(), realm, username, credential)
	defer clientA.Close()
	defer allocationA.Close()
	clientB, allocationB := allocateTURNClient(t, server.UDPAddress(), realm, username, credential)
	defer clientB.Close()
	defer allocationB.Close()

	assertRelayTraffic(t, allocationA, allocationB)
}

// The browser regression starts the same TURN stack as ev-server, on loopback with
// ephemeral ports and temporary credentials. No separate deployed server is needed.
func TestBrowserRelayFixture(t *testing.T) {
	dir := os.Getenv("EV_BROWSER_TURN_FIXTURE_DIR")
	if dir == "" {
		t.Skip("started by screen-share-relay-network.mjs")
	}
	server, _, username, credential := startLoopbackTURN(t)
	encoded, err := json.Marshal(map[string]string{
		"address": server.UDPAddress(), "username": username, "credential": credential,
	})
	if err != nil {
		t.Fatal(err)
	}
	temp := filepath.Join(dir, "turn.tmp")
	if err := os.WriteFile(temp, encoded, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(temp, filepath.Join(dir, "turn.json")); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(4 * time.Minute); time.Now().Before(deadline); {
		if _, err := os.Stat(filepath.Join(dir, "stop")); err == nil {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("browser did not stop the TURN fixture")
}

func startLoopbackTURN(t *testing.T) (*Server, string, string, string) {
	t.Helper()
	relayMinPort, relayMaxPort := availableUDPPortRange(t)
	cfg := config.Defaults()
	cfg.RTC.TURN.ListenHost = "127.0.0.1"
	cfg.RTC.TURN.PublicHost = "127.0.0.1"
	cfg.RTC.TURN.Port = 0
	cfg.RTC.TURN.RelayMinPort = relayMinPort
	cfg.RTC.TURN.RelayMaxPort = relayMaxPort
	cfg.RTC.TURN.TCPEnabled = false
	cfg.RTC.TURN.AuthSecret = "turn-integration-test-secret"

	server, err := Start(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close() })

	username, credential, err := turn.GenerateLongTermTURNRESTCredentials(
		cfg.RTC.TURN.AuthSecret,
		"test-device",
		5*time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	return server, cfg.RTC.TURN.Realm, username, credential
}

func assertRelayTraffic(t *testing.T, allocationA, allocationB net.PacketConn) {
	t.Helper()
	if _, err := allocationA.WriteTo([]byte("permission-a"), allocationB.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	if _, err := allocationB.WriteTo([]byte("permission-b"), allocationA.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	if err := allocationA.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	warmup := make([]byte, 64)
	if _, _, err := allocationA.ReadFrom(warmup); err != nil {
		t.Fatalf("TURN relay did not pass permission warmup: %v", err)
	}

	payload := []byte("echovoice-turn-media-path")
	if _, err := allocationA.WriteTo(payload, allocationB.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	if err := allocationB.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	// The permission warmup above crosses the relay in both directions, so B may
	// legitimately see A's earlier warmup datagram first. Keep reading until the
	// media payload arrives instead of assuming it is next in line (that
	// assumption is what made this test fail under load).
	received := make([]byte, 128)
	for {
		n, _, err := allocationB.ReadFrom(received)
		if err != nil {
			t.Fatalf("TURN relay did not pass media payload: %v", err)
		}
		if string(received[:n]) == string(payload) {
			break
		}
	}
}

func allocateTURNClient(
	t *testing.T,
	address string,
	realm string,
	username string,
	credential string,
) (*turn.Client, net.PacketConn) {
	t.Helper()
	conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	client, err := turn.NewClient(&turn.ClientConfig{
		Conn:           conn,
		STUNServerAddr: address,
		TURNServerAddr: address,
		Username:       username,
		Password:       credential,
		Realm:          realm,
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
	allocation, err := client.Allocate()
	if err != nil {
		client.Close()
		t.Fatal(err)
	}
	return client, allocation
}

func availableUDPPortRange(t *testing.T) (int, int) {
	t.Helper()
	const portCount = 16
	for attempt := 0; attempt < 100; attempt++ {
		first, err := net.ListenPacket("udp4", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		port := first.LocalAddr().(*net.UDPAddr).Port
		if port > 65535-portCount {
			first.Close()
			continue
		}
		listeners := []net.PacketConn{first}
		available := true
		for offset := 1; offset < portCount; offset++ {
			listener, listenErr := net.ListenPacket("udp4", net.JoinHostPort("127.0.0.1", fmt.Sprintf("%d", port+offset)))
			if listenErr != nil {
				available = false
				break
			}
			listeners = append(listeners, listener)
		}
		for _, listener := range listeners {
			listener.Close()
		}
		if available {
			return port, port + portCount - 1
		}
	}
	t.Fatal("failed to reserve consecutive UDP relay ports")
	return 0, 0
}
