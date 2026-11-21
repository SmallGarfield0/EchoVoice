package mediarelay

import (
	"fmt"
	"net"
	"strconv"

	"github.com/pion/logging"
	"github.com/pion/turn/v4"

	"github.com/echovoice/echovoice/services/ev-server/internal/config"
)

type Server struct {
	turn       *turn.Server
	udpAddress string
	// publicIP is the address clients are told to send relay traffic to. It is
	// worth logging: a name that resolves to a private or proxied address starts
	// cleanly and only fails once a viewer asks for the relay.
	publicIP string
}

func Start(cfg config.Config) (*Server, error) {
	if !cfg.RTC.TURN.Enabled {
		return &Server{}, nil
	}
	publicIP, err := resolveIPv4(cfg.TURNPublicHost())
	if err != nil {
		return nil, err
	}
	address := net.JoinHostPort(cfg.RTC.TURN.ListenHost, strconv.Itoa(cfg.RTC.TURN.Port))
	udpListener, err := net.ListenPacket("udp4", address)
	if err != nil {
		return nil, fmt.Errorf("listen TURN UDP on %s: %w", address, err)
	}
	listeners := []turn.ListenerConfig{}
	var tcpListener net.Listener
	if cfg.RTC.TURN.TCPEnabled {
		tcpListener, err = net.Listen("tcp4", address)
		if err != nil {
			_ = udpListener.Close()
			return nil, fmt.Errorf("listen TURN TCP on %s: %w", address, err)
		}
		listeners = append(listeners, turn.ListenerConfig{
			Listener:              tcpListener,
			RelayAddressGenerator: relayGenerator(cfg, publicIP),
		})
	}
	loggerFactory := logging.NewDefaultLoggerFactory()
	relay, err := turn.NewServer(turn.ServerConfig{
		Realm:         cfg.RTC.TURN.Realm,
		LoggerFactory: loggerFactory,
		AuthHandler: turn.LongTermTURNRESTAuthHandler(
			cfg.RTC.TURN.AuthSecret,
			loggerFactory.NewLogger("turn-auth"),
		),
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn:            udpListener,
			RelayAddressGenerator: relayGenerator(cfg, publicIP),
		}},
		ListenerConfigs: listeners,
	})
	if err != nil {
		_ = udpListener.Close()
		if tcpListener != nil {
			_ = tcpListener.Close()
		}
		return nil, fmt.Errorf("start TURN server: %w", err)
	}
	return &Server{turn: relay, udpAddress: udpListener.LocalAddr().String(), publicIP: publicIP.String()}, nil
}

func (s *Server) UDPAddress() string {
	if s == nil {
		return ""
	}
	return s.udpAddress
}

// PublicIP is the relay address advertised to clients.
func (s *Server) PublicIP() string {
	if s == nil {
		return ""
	}
	return s.publicIP
}

func (s *Server) Close() error {
	if s == nil || s.turn == nil {
		return nil
	}
	return s.turn.Close()
}

func relayGenerator(cfg config.Config, publicIP net.IP) turn.RelayAddressGenerator {
	return &turn.RelayAddressGeneratorPortRange{
		RelayAddress: publicIP,
		Address:      cfg.RTC.TURN.ListenHost,
		MinPort:      uint16(cfg.RTC.TURN.RelayMinPort),
		MaxPort:      uint16(cfg.RTC.TURN.RelayMaxPort),
		MaxRetries:   16,
	}
}

func resolveIPv4(host string) (net.IP, error) {
	if host == "" {
		return nil, fmt.Errorf("rtc.turn.public_host or server.public_url is required")
	}
	if parsed := net.ParseIP(host); parsed != nil {
		if ipv4 := parsed.To4(); ipv4 != nil {
			return ipv4, nil
		}
		return nil, fmt.Errorf("TURN public host %q is not an IPv4 address", host)
	}
	addresses, err := net.LookupIP(host)
	if err != nil {
		return nil, fmt.Errorf("resolve TURN public host %q: %w", host, err)
	}
	for _, address := range addresses {
		if ipv4 := address.To4(); ipv4 != nil {
			return ipv4, nil
		}
	}
	return nil, fmt.Errorf("TURN public host %q has no IPv4 address", host)
}
