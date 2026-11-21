package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func writeTestConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ev-server.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	return path
}

// The reported deployment: a file written by an older version, with no rtc,
// realtime or websocket section at all. It started fine because defaults are
// layered underneath, but the file said nothing about the relay that was running.
const legacyConfig = `server:
  name: EchoVoice Server
  host: 0.0.0.0
  port: "17878"
  public_url: "https://qm.starecho.net:17878"
  password: ""
  tls:
    enabled: true
    cert_file: "./data/starecho.net_full.crt"
    key_file: "./data/starecho.net_private.key"
    reload_interval_seconds: 60
storage:
  driver: sqlite
  sqlite_path: ./data/echovoice.db
  content_path: ./data/content
  max_channel_file_mb: 512
  max_soundboard_kb: 2048
  max_emoji_kb: 8192
relay:
  dm_relay_enabled: false
  private_voice_relay_enabled: false
  home_mailbox_enabled: false
  max_envelope_kb: 512
web:
  enabled: false
  root: ./web
`

func TestUpgradeFileAddsSectionsAnOlderVersionNeverWrote(t *testing.T) {
	path := writeTestConfig(t, legacyConfig)
	upgraded, err := UpgradeFile(path)
	if err != nil {
		t.Fatalf("upgrade config: %v", err)
	}
	if !upgraded {
		t.Fatal("a file without rtc/websocket/realtime sections must be upgraded")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read upgraded config: %v", err)
	}
	text := string(data)
	for _, want := range []string{"rtc:", "websocket:", "realtime:", "max_message_kb: 1024", "relay_min_port: 49160", "relay_max_port: 49460"} {
		if !strings.Contains(text, want) {
			t.Errorf("upgraded config is missing %q:\n%s", want, text)
		}
	}
	// The relay subtree must live under rtc:, not next to it.
	if !strings.Contains(text, "  turn:\n") {
		t.Errorf("turn settings must be nested under rtc:\n%s", text)
	}
	// Values the operator already chose must survive verbatim.
	if !strings.Contains(text, `public_url: "https://qm.starecho.net:17878"`) {
		t.Errorf("existing values must not be rewritten:\n%s", text)
	}
	if !strings.Contains(text, "max_envelope_kb: 512") {
		t.Errorf("existing sections must not be rewritten:\n%s", text)
	}

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load upgraded config: %v", err)
	}
	if !cfg.RTC.TURN.Enabled {
		t.Error("the written file must describe the relay that defaults already enabled")
	}
	if cfg.RTC.TURN.RelayMaxPort != 49460 {
		t.Errorf("relay_max_port = %d, want 49460", cfg.RTC.TURN.RelayMaxPort)
	}
	if cfg.WebSocket.MaxMessageKB != 1024 {
		t.Errorf("websocket.max_message_kb = %d, want 1024", cfg.WebSocket.MaxMessageKB)
	}
}

func TestUpgradeFileIsIdempotent(t *testing.T) {
	path := writeTestConfig(t, legacyConfig)
	if _, err := UpgradeFile(path); err != nil {
		t.Fatalf("first upgrade: %v", err)
	}
	first, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	upgraded, err := UpgradeFile(path)
	if err != nil {
		t.Fatalf("second upgrade: %v", err)
	}
	if upgraded {
		t.Error("a complete file must not be rewritten again")
	}
	second, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if string(first) != string(second) {
		t.Error("the second pass changed the file")
	}
}

func TestUpgradeFileKeepsCommentsAndUnknownSettings(t *testing.T) {
	body := `# Deployment notes: this box sits behind the office firewall.
server:
  host: 0.0.0.0
  port: "17878"
  public_url: "https://voice.example.com"
  password: "secret"
  tls:
    enabled: true
    cert_file: "./data/cert.pem"
    key_file: "./data/key.pem"
  # Certificates are renewed by certbot, do not touch.
  my_own_guard: 1440
rtc:
  turn:
    enabled: false
`
	path := writeTestConfig(t, body)
	if _, err := UpgradeFile(path); err != nil {
		t.Fatalf("upgrade config: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	text := string(data)
	if !strings.Contains(text, "# Deployment notes: this box sits behind the office firewall.") {
		t.Error("leading comments must survive")
	}
	if !strings.Contains(text, "# Certificates are renewed by certbot, do not touch.") {
		t.Error("inline comments must survive")
	}
	if !strings.Contains(text, "my_own_guard: 1440") {
		t.Error("settings this binary does not know must survive untouched")
	}
	// An existing turn block keeps its own values and only gains the missing keys.
	if !strings.Contains(text, "enabled: false") {
		t.Error("an explicit value must not be overwritten by the default")
	}
	if !strings.Contains(text, "relay_max_port: 49460") {
		t.Errorf("missing keys inside an existing section must be added:\n%s", text)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("load upgraded config: %v", err)
	}
	if cfg.RTC.TURN.Enabled {
		t.Error("upgrade must not switch an explicitly disabled relay back on")
	}
}

func TestUpgradeFileKeepsATrailingCommentAtTheEnd(t *testing.T) {
	body := `server:
  host: 0.0.0.0
  port: "17878"
  password: ""
web:
  enabled: false
# Remember: renew the certificate every 90 days.
`
	path := writeTestConfig(t, body)
	if _, err := UpgradeFile(path); err != nil {
		t.Fatalf("upgrade config: %v", err)
	}
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(text), "\n"), "\n")
	if last := lines[len(lines)-1]; last != "# Remember: renew the certificate every 90 days." {
		t.Errorf("a trailing comment must stay at the end, got %q:\n%s", last, text)
	}
	if !strings.Contains(string(text), "# added by ev-server: rtc") {
		t.Errorf("missing sections must still be added:\n%s", text)
	}
}

func TestUpgradeFileLeavesACompleteFileAlone(t *testing.T) {
	full, err := yaml.Marshal(Defaults())
	if err != nil {
		t.Fatalf("render defaults: %v", err)
	}
	path := writeTestConfig(t, string(full))
	upgraded, err := UpgradeFile(path)
	if err != nil {
		t.Fatalf("upgrade config: %v", err)
	}
	if upgraded {
		t.Error("a file that already lists every key must not be touched")
	}
}

// A server that starts on a file written by an older release has to end up with a
// file that describes what is actually running, and has to keep starting when that
// rewrite is impossible.
func TestLoadOrCreateUpgradesAnExistingFileOnce(t *testing.T) {
	path := writeTestConfig(t, legacyConfig)
	first, err := LoadOrCreate(path)
	if err != nil {
		t.Fatalf("load and create: %v", err)
	}
	if !first.Upgraded {
		t.Fatal("loading an old file must report the upgrade so startup can mention it")
	}
	if !first.Config.RTC.TURN.Enabled {
		t.Error("the relay runs from the defaults even before the file lists it")
	}
	second, err := LoadOrCreate(path)
	if err != nil {
		t.Fatalf("load and create again: %v", err)
	}
	if second.Upgraded {
		t.Error("the second start must not rewrite an already complete file")
	}
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if !strings.Contains(string(text), "# added by ev-server: rtc") {
		t.Errorf("the added sections must be marked for review:\n%s", text)
	}
}

func TestUpgradeFileLeavesABrokenFileAlone(t *testing.T) {
	broken := "server:\n  port: [unclosed\n"
	path := writeTestConfig(t, broken)
	if _, err := UpgradeFile(path); err == nil {
		t.Fatal("an unparsable file must be reported, not rewritten")
	}
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if string(text) != broken {
		t.Errorf("a file that cannot be parsed must be left byte-identical:\n%s", text)
	}
}
