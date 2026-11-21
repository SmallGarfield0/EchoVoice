package config

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLoadYAMLAndResolvePaths(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ev-server.yaml")
	data := []byte(`server:
  name: Production EchoVoice
  host: 0.0.0.0
  port: 443
  public_url: https://voice.example.com
  tls:
    enabled: true
    cert_file: ./certs/fullchain.pem
    key_file: ./certs/privkey.pem
    reload_interval_seconds: 30
web:
  enabled: true
  root: ./web
storage:
  driver: sqlite
  sqlite_path: ./data/server.db
  content_path: ./data/content
  max_channel_file_mb: 256
  max_soundboard_kb: 1024
  max_emoji_kb: 4096
`)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Name != "Production EchoVoice" || cfg.PublicURL() != "https://voice.example.com" {
		t.Fatalf("unexpected server config: %+v", cfg.Server)
	}
	if cfg.Server.TLS.CertFile != filepath.Join(dir, "certs", "fullchain.pem") {
		t.Fatalf("certificate path was not resolved relative to config: %q", cfg.Server.TLS.CertFile)
	}
	if cfg.Web.Root != filepath.Join(dir, "web") {
		t.Fatalf("Web root was not resolved relative to config: %q", cfg.Web.Root)
	}
}

func TestLoadOrCreateWritesRunnableDefaultConfig(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ev-server.yaml")

	loaded, err := LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	if !loaded.Created {
		t.Fatal("expected a missing configuration to be generated")
	}
	if loaded.Path != path {
		t.Fatalf("unexpected resolved config path: %q", loaded.Path)
	}
	if loaded.Config.Server.TLS.Enabled || loaded.Config.Web.Enabled {
		t.Fatal("generated configuration must start in plain HTTP mode")
	}
	if loaded.Config.Server.Host != "0.0.0.0" {
		t.Fatalf("generated configuration must listen on all interfaces, got %q", loaded.Config.Server.Host)
	}
	if loaded.Config.Storage.SQLitePath != filepath.Join(dir, "data", "echovoice.db") {
		t.Fatalf("generated storage path is outside the server root: %q", loaded.Config.Storage.SQLitePath)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("generated configuration is missing: %v", err)
	}

	loadedAgain, err := LoadOrCreate(path)
	if err != nil {
		t.Fatal(err)
	}
	if loadedAgain.Created {
		t.Fatal("existing configuration was unexpectedly replaced")
	}
}

func TestGoRunExecutableDetection(t *testing.T) {
	goRunPath := filepath.Join(os.TempDir(), "go-build123", "b001", "exe", "ev-server")
	if !isGoRunExecutable(goRunPath) {
		t.Fatalf("go run executable was not detected: %q", goRunPath)
	}
	if isGoRunExecutable(filepath.Join(t.TempDir(), "ev-server")) {
		t.Fatal("regular executable was detected as go run")
	}
}

func TestWebHostingRequiresTLS(t *testing.T) {
	cfg := Defaults()
	cfg.Web.Enabled = true
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected Web hosting without TLS to fail validation")
	}
}

func TestWebHostingAllowsAnEmptyRootForTheEmbeddedClient(t *testing.T) {
	cfg := Defaults()
	cfg.Web.Enabled = true
	cfg.Web.Root = ""
	cfg.Server.TLS.Enabled = true
	cfg.Server.TLS.CertFile = "cert.pem"
	cfg.Server.TLS.KeyFile = "key.pem"
	if err := cfg.Validate(); err != nil {
		t.Fatalf("an empty web.root asks for the bundled client and must be accepted here, got %v", err)
	}
}

func TestPublicURLUsesConfiguredProtocol(t *testing.T) {
	cfg := Defaults()
	cfg.Server.Host = "0.0.0.0"
	cfg.Server.TLS.Enabled = true
	cfg.Server.TLS.CertFile = "cert.pem"
	cfg.Server.TLS.KeyFile = "key.pem"
	if got := cfg.PublicURL(); got != "https://localhost:17878" {
		t.Fatalf("unexpected inferred public URL: %q", got)
	}
}

func TestQuickstartFillsTheAnswersAUserMustGive(t *testing.T) {
	cfg, err := Quickstart(QuickstartOptions{
		PublicURL: "https://voice.example.com:17878",
		Password:  "s3cret",
		ServeWeb:  true,
	})
	if err != nil {
		t.Fatalf("quickstart rejected a complete answer set: %v", err)
	}
	if cfg.Server.PublicURL != "https://voice.example.com:17878" {
		t.Fatalf("public URL was not stored: %q", cfg.Server.PublicURL)
	}
	if cfg.Server.Port != "17878" {
		t.Fatalf("the listen port must follow the public URL, got %q", cfg.Server.Port)
	}
	if cfg.Server.Password != "s3cret" {
		t.Fatalf("password was not stored")
	}
	if !cfg.Server.TLS.Enabled || cfg.Server.TLS.CertFile != "./cert.pem" || cfg.Server.TLS.KeyFile != "./key.pem" {
		t.Fatalf("TLS should be on with the documented default file names, got %+v", cfg.Server.TLS)
	}
	if !cfg.Web.Enabled || cfg.Web.Root != "" {
		t.Fatalf("Web hosting should use the bundled client, got %+v", cfg.Web)
	}
	if cfg.RTC.TURN.PublicHost != "voice.example.com" {
		t.Fatalf("TURN public host must come from the public URL, got %q", cfg.RTC.TURN.PublicHost)
	}
}

func TestQuickstartRejectsAnswersThatCannotStart(t *testing.T) {
	cases := []struct {
		name string
		opts QuickstartOptions
	}{
		{name: "no url", opts: QuickstartOptions{Password: "s3cret"}},
		{name: "plain http", opts: QuickstartOptions{PublicURL: "http://voice.example.com", Password: "s3cret"}},
		{name: "no password", opts: QuickstartOptions{PublicURL: "https://voice.example.com"}},
	}
	for _, testCase := range cases {
		if _, err := Quickstart(testCase.opts); err == nil {
			t.Fatalf("%s: expected quickstart to refuse", testCase.name)
		}
	}
}

func TestSavedQuickstartConfigLoadsBackTheSame(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "ev-server.yaml")
	cfg, err := Quickstart(QuickstartOptions{
		PublicURL: "https://voice.example.com:17878",
		Password:  "s3cret",
		ServeWeb:  true,
	})
	if err != nil {
		t.Fatalf("quickstart failed: %v", err)
	}
	if err := Save(path, cfg); err != nil {
		t.Fatalf("save failed: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat saved config: %v", err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("a config with a password must stay owner-only, got %v", info.Mode().Perm())
	}
	reloaded, err := Load(path)
	if err != nil {
		t.Fatalf("reload failed: %v", err)
	}
	if reloaded.Server.PublicURL != cfg.Server.PublicURL || reloaded.Web.Enabled != cfg.Web.Enabled {
		t.Fatalf("round trip changed the configuration: %+v vs %+v", reloaded, cfg)
	}
}

func TestWebSocketSettingsAreConfigurableAndDefaultToGenerousValues(t *testing.T) {
	cfg := Defaults()
	if cfg.WebSocketReadLimitBytes() != 1024*1024 {
		t.Fatalf("default read limit = %d, want 1 MiB", cfg.WebSocketReadLimitBytes())
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("defaults must validate: %v", err)
	}

	unlimited := Defaults()
	unlimited.WebSocket.MaxMessageKB = -1
	if unlimited.WebSocketReadLimitBytes() != -1 {
		t.Fatalf("read limit = %d, want -1 for unlimited", unlimited.WebSocketReadLimitBytes())
	}
	if err := unlimited.Validate(); err != nil {
		t.Fatalf("unlimited read limit must validate: %v", err)
	}

	bad := Defaults()
	bad.WebSocket.MaxMessageKB = 0
	if err := bad.Validate(); err == nil {
		t.Fatal("zero kilobytes is ambiguous and must be rejected")
	}
	emptyQueue := Defaults()
	emptyQueue.WebSocket.SendQueue = 0
	if err := emptyQueue.Validate(); err == nil {
		t.Fatal("a zero-depth queue would drop every event and must be rejected")
	}
}
