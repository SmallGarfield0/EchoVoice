package serverruntime

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"time"

	"github.com/echovoice/echovoice/services/ev-server/internal/config"
)

type Server struct {
	HTTP      *http.Server
	listener  net.Listener
	publicURL string
	tls       bool
}

func Validate(cfg config.Config) error {
	if _, err := withWebClient(http.NotFoundHandler(), cfg.Web); err != nil {
		return err
	}
	if cfg.Server.TLS.Enabled {
		if _, err := newTLSConfig(cfg.Server.TLS); err != nil {
			return err
		}
	}
	return nil
}

func New(cfg config.Config, api http.Handler) (*Server, error) {
	handler, err := withWebClient(api, cfg.Web)
	if err != nil {
		return nil, err
	}
	if !cfg.Web.Enabled {
		handler = withPublicStatusPage(handler, publicStatusInfo{
			ServerName: cfg.Server.Name,
			StartedAt:  time.Now().UTC(),
			TLS:        cfg.Server.TLS.Enabled,
		})
	}
	listener, err := net.Listen("tcp", cfg.ListenAddress())
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", cfg.ListenAddress(), err)
	}

	if cfg.Server.TLS.Enabled {
		tlsConfig, tlsErr := newTLSConfig(cfg.Server.TLS)
		if tlsErr != nil {
			_ = listener.Close()
			return nil, tlsErr
		}
		listener = tls.NewListener(listener, tlsConfig)
	}

	return &Server{
		HTTP: &http.Server{
			Addr:              cfg.ListenAddress(),
			Handler:           handler,
			ReadHeaderTimeout: 10 * time.Second,
			IdleTimeout:       90 * time.Second,
		},
		listener:  listener,
		publicURL: cfg.PublicURL(),
		tls:       cfg.Server.TLS.Enabled,
	}, nil
}

func (s *Server) Serve() error {
	return s.HTTP.Serve(s.listener)
}

func (s *Server) Shutdown(ctx context.Context) error {
	return s.HTTP.Shutdown(ctx)
}

func (s *Server) PublicURL() string {
	return s.publicURL
}

func (s *Server) Address() string {
	return s.listener.Addr().String()
}

func (s *Server) TLS() bool {
	return s.tls
}
