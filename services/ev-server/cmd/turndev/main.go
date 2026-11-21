// Development-only TURN server used to exercise the relay path locally.
//
// Not part of the product: it exists so the screen-share browser harness can be
// run against a real relay (the app itself always uses the TURN server embedded
// in ev-server). Delete it once the relay path has its own automated coverage.
package main

import (
	"log"
	"net"
	"os"
	"os/signal"
	"strconv"
	"syscall"

	"github.com/pion/turn/v4"
)

func main() {
	listenHost := envOr("TURN_DEV_LISTEN_HOST", "127.0.0.1")
	publicIP := net.ParseIP(envOr("TURN_DEV_PUBLIC_IP", "127.0.0.1"))
	port := envInt("TURN_DEV_PORT", 3478)
	minPort := envInt("TURN_DEV_RELAY_MIN", 49160)
	maxPort := envInt("TURN_DEV_RELAY_MAX", 49460)
	username := envOr("TURN_DEV_USER", "ev")
	password := envOr("TURN_DEV_PASSWORD", "evpass")

	address := net.JoinHostPort(listenHost, strconv.Itoa(port))
	packetConn, err := net.ListenPacket("udp4", address)
	if err != nil {
		log.Fatalf("listen %s: %v", address, err)
	}

	server, err := turn.NewServer(turn.ServerConfig{
		Realm: "echovoice",
		AuthHandler: func(gotUser, realm string, srcAddr net.Addr) ([]byte, bool) {
			if gotUser != username {
				return nil, false
			}
			return turn.GenerateAuthKey(username, realm, password), true
		},
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn: packetConn,
			RelayAddressGenerator: &turn.RelayAddressGeneratorPortRange{
				RelayAddress: publicIP,
				Address:      listenHost,
				MinPort:      uint16(minPort),
				MaxPort:      uint16(maxPort),
			},
		}},
	})
	if err != nil {
		log.Fatalf("start turn server: %v", err)
	}

	log.Printf("dev turn listening on udp %s, relay %d-%d, user %q", address, minPort, maxPort, username)

	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt, syscall.SIGTERM)
	<-interrupt
	if err := server.Close(); err != nil {
		log.Printf("close turn server: %v", err)
	}
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	raw := os.Getenv(key)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		log.Fatalf("%s must be an integer: %v", key, err)
	}
	return value
}
