package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/echovoice/echovoice/services/ev-server/internal/adminconsole"
	"github.com/echovoice/echovoice/services/ev-server/internal/api"
	"github.com/echovoice/echovoice/services/ev-server/internal/auth"
	"github.com/echovoice/echovoice/services/ev-server/internal/buildinfo"
	"github.com/echovoice/echovoice/services/ev-server/internal/config"
	"github.com/echovoice/echovoice/services/ev-server/internal/mediarelay"
	"github.com/echovoice/echovoice/services/ev-server/internal/serverruntime"
	"github.com/echovoice/echovoice/services/ev-server/internal/store"
	"github.com/echovoice/echovoice/services/ev-server/internal/webassets"
	"github.com/echovoice/echovoice/services/ev-server/internal/ws"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		log.Printf("EchoVoice server stopped: %v", err)
		pauseAfterStartupError()
		os.Exit(1)
	}
}

func runQuickstart(pathArg, publicURL, password, certFile, keyFile string, force, serveWeb bool) error {
	path, err := config.ResolvePath(pathArg)
	if err != nil {
		return err
	}
	if !force {
		if _, statErr := os.Stat(path); statErr == nil {
			return fmt.Errorf("configuration already exists: %s (pass -force to rewrite it)", path)
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return fmt.Errorf("inspect config %q: %w", path, statErr)
		}
	}
	// The Web client is only served from the binary when the binary actually
	// contains one; a developer build falls back to "bring your own web.root".
	serveEmbeddedWeb := serveWeb && webassets.HasIndex()
	cfg, err := config.Quickstart(config.QuickstartOptions{
		PublicURL: publicURL,
		Password:  password,
		CertFile:  certFile,
		KeyFile:   keyFile,
		ServeWeb:  serveEmbeddedWeb,
	})
	if err != nil {
		return err
	}
	if err := config.Save(path, cfg); err != nil {
		return err
	}
	log.Printf("Wrote configuration: %s", path)
	log.Printf("Server URL: %s", cfg.PublicURL())
	if serveEmbeddedWeb {
		log.Printf("Web client: served from this binary, open %s in a browser", cfg.PublicURL())
	} else if serveWeb {
		log.Printf("Web client: not bundled in this build; set web.root to the built client directory to serve it")
	}
	for _, candidate := range []string{cfg.Server.TLS.CertFile, cfg.Server.TLS.KeyFile} {
		if _, statErr := os.Stat(candidate); statErr != nil {
			log.Printf("TLS file missing: %s (HTTPS cannot start until it exists)", candidate)
		}
	}
	for _, candidate := range []string{cfg.Server.TLS.CertFile, cfg.Server.TLS.KeyFile} {
		if _, statErr := os.Stat(candidate); statErr != nil {
			log.Printf("Next: put %s and %s here, then run `ev-server` (or `ev-server -check-config` first)", cfg.Server.TLS.CertFile, cfg.Server.TLS.KeyFile)
			return nil
		}
	}
	log.Printf("Next: run `ev-server` (or `ev-server -check-config` first)")
	return nil
}

func run(arguments []string) error {
	flags := flag.NewFlagSet("ev-server", flag.ContinueOnError)
	configPath := flags.String("config", "", "path to ev-server.yaml")
	checkConfig := flags.Bool("check-config", false, "validate configuration, TLS certificate, and Web files, then exit")
	quickstart := flags.Bool("quickstart", false, "write a ready-to-run configuration from the flags below, then exit")
	publicURL := flags.String("public-url", "", "public https URL this server is reachable at (quickstart)")
	password := flags.String("password", "", "server password used by every client (quickstart)")
	certFile := flags.String("cert", "./cert.pem", "TLS certificate path (quickstart)")
	keyFile := flags.String("key", "./key.pem", "TLS private key path (quickstart)")
	force := flags.Bool("force", false, "overwrite an existing configuration (quickstart)")
	noWeb := flags.Bool("no-web", false, "do not serve the Web client (quickstart)")
	if err := flags.Parse(arguments); err != nil {
		return err
	}

	if *quickstart {
		return runQuickstart(*configPath, *publicURL, *password, *certFile, *keyFile, *force, !*noWeb)
	}

	loaded, err := config.LoadOrCreate(*configPath)
	if err != nil {
		return err
	}
	cfg := loaded.Config
	if loaded.Created {
		log.Printf("Created default configuration: %s", loaded.Path)
		log.Printf("Next: set server.password, then run `ev-server -check-config` to validate before starting.")
		if webassets.HasIndex() {
			log.Printf("This binary bundles the Web client: set `web.enabled: true` and `web.root: \"\"` to serve it without a web/ directory.")
		}
	} else if loaded.Upgraded {
		log.Printf("Added the settings this version expects to %s", loaded.Path)
		log.Printf("Review the lines marked `# added by ev-server` and adjust the ones that matter for this deployment.")
	}
	if err := serverruntime.Validate(cfg); err != nil {
		return err
	}
	if *checkConfig {
		log.Printf("Configuration is valid: %s", loaded.Path)
		log.Printf("Server URL: %s", cfg.PublicURL())
		return nil
	}

	appStore, err := store.Open(cfg.Storage.Driver, cfg.Storage.SQLitePath, cfg.Server.Name)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := appStore.Close(); closeErr != nil {
			log.Printf("close server storage: %v", closeErr)
		}
	}()
	hub := ws.NewHub(
		ws.WithReadLimit(cfg.WebSocketReadLimitBytes()),
		ws.WithQueueDepths(cfg.WebSocket.SendQueue, cfg.WebSocket.PriorityQueue),
	)
	sessions := auth.NewSessionStore(60 * time.Minute)
	router := api.NewRouter(cfg, appStore, hub, sessions)
	relayServer, err := mediarelay.Start(cfg)
	if err != nil {
		return err
	}
	defer relayServer.Close()
	server, err := serverruntime.New(cfg, router)
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	console := adminconsole.New(appStore, hub, os.Stdout)
	go console.Run(ctx, os.Stdin)

	protocol := "HTTP"
	if server.TLS() {
		protocol = "HTTPS"
	}
	log.Printf("EchoVoice Server %s started with %s", buildinfo.Version, protocol)
	log.Printf("Configuration: %s", loaded.Path)
	log.Printf("Server URL: %s", server.PublicURL())
	if cfg.RTC.TURN.Enabled {
		log.Printf(
			"Realtime relay: TURN UDP/TCP %s:%d (%s), media ports %d-%d/UDP",
			cfg.TURNPublicHost(),
			cfg.RTC.TURN.Port,
			relayServer.PublicIP(),
			cfg.RTC.TURN.RelayMinPort,
			cfg.RTC.TURN.RelayMaxPort,
		)
		log.Printf("Clients must reach that address on TCP/UDP %d and the whole relay range; the relay range is also where viewers connect.", cfg.RTC.TURN.Port)
	}
	log.Printf("Realtime disconnect grace: %d seconds", cfg.Realtime.DisconnectGraceSeconds)
	if cfg.Web.Enabled {
		log.Printf("Web client URL: %s", server.PublicURL())
	} else {
		log.Printf("Add the Server URL in the EchoVoice desktop client")
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- server.Serve()
	}()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("serve %s: %w", server.PublicURL(), err)
		}
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shut down server: %w", err)
		}
	}
	return nil
}
