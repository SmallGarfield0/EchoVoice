package config

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

const defaultConfigFile = "ev-server.yaml"

type LoadResult struct {
	Config  Config
	Path    string
	Created bool
	// Upgraded reports that the file on disk was missing keys this binary knows
	// about and they were written back, so the file describes the running
	// configuration instead of only the subset someone typed by hand.
	Upgraded bool
}

type Config struct {
	Server    ServerConfig    `yaml:"server"`
	Storage   StorageConfig   `yaml:"storage"`
	Relay     RelayConfig     `yaml:"relay"`
	RTC       RTCConfig       `yaml:"rtc"`
	Realtime  RealtimeConfig  `yaml:"realtime"`
	WebSocket WebSocketConfig `yaml:"websocket"`
	Web       WebConfig       `yaml:"web"`
}

// WebSocketConfig tunes the signalling socket. None of these limit media
// bandwidth: voice and screen share travel peer to peer (or through the TURN
// relay) and never pass through this connection. The only thing that can eat
// server bandwidth is a relayed peer connection, and the ceiling there is the
// TURN relay port range in rtc.turn.
type WebSocketConfig struct {
	// MaxMessageKB caps one inbound signalling message. A full SDP with every
	// codec and candidate is a few KB, so the cap only exists to stop a client
	// from buffering an unbounded body; -1 removes it entirely.
	MaxMessageKB int `yaml:"max_message_kb"`
	// SendQueue and PriorityQueue are how many events may be queued for one
	// client before the hub starts dropping. A burst of negotiation messages
	// (offer, answer, a dozen candidates) is normal, so these have to be deep.
	SendQueue     int `yaml:"send_queue"`
	PriorityQueue int `yaml:"priority_queue"`
}

type RealtimeConfig struct {
	DisconnectGraceSeconds int `yaml:"disconnect_grace_seconds"`
}

type RTCConfig struct {
	STUNURLs []string   `yaml:"stun_urls"`
	TURN     TURNConfig `yaml:"turn"`
}

type TURNConfig struct {
	Enabled      bool   `yaml:"enabled"`
	ListenHost   string `yaml:"listen_host"`
	Port         int    `yaml:"port"`
	PublicHost   string `yaml:"public_host"`
	Realm        string `yaml:"realm"`
	RelayMinPort int    `yaml:"relay_min_port"`
	RelayMaxPort int    `yaml:"relay_max_port"`
	TCPEnabled   bool   `yaml:"tcp_enabled"`
	AuthSecret   string `yaml:"-"`
}

type ServerConfig struct {
	Name      string    `yaml:"name"`
	Host      string    `yaml:"host"`
	Port      string    `yaml:"port"`
	PublicURL string    `yaml:"public_url"`
	Password  string    `yaml:"password"`
	TLS       TLSConfig `yaml:"tls"`
}

type TLSConfig struct {
	Enabled               bool   `yaml:"enabled"`
	CertFile              string `yaml:"cert_file"`
	KeyFile               string `yaml:"key_file"`
	ReloadIntervalSeconds int    `yaml:"reload_interval_seconds"`
}

type WebConfig struct {
	Enabled bool   `yaml:"enabled"`
	Root    string `yaml:"root"`
}

type StorageConfig struct {
	Driver           string `yaml:"driver"`
	SQLitePath       string `yaml:"sqlite_path"`
	ContentPath      string `yaml:"content_path"`
	MaxChannelFileMB int    `yaml:"max_channel_file_mb"`
	MaxSoundboardKB  int    `yaml:"max_soundboard_kb"`
	MaxEmojiKB       int    `yaml:"max_emoji_kb"`
}

type RelayConfig struct {
	DMRelayEnabled           bool `yaml:"dm_relay_enabled"`
	PrivateVoiceRelayEnabled bool `yaml:"private_voice_relay_enabled"`
	HomeMailboxEnabled       bool `yaml:"home_mailbox_enabled"`
	MaxEnvelopeKB            int  `yaml:"max_envelope_kb"`
}

func Defaults() Config {
	return Config{
		Server: ServerConfig{
			Name: "EchoVoice Server",
			Host: "0.0.0.0",
			Port: "17878",
			TLS: TLSConfig{
				ReloadIntervalSeconds: 60,
			},
		},
		Storage: StorageConfig{
			Driver:           "sqlite",
			SQLitePath:       "./data/echovoice.db",
			ContentPath:      "./data/content",
			MaxChannelFileMB: 512,
			MaxSoundboardKB:  2048,
			MaxEmojiKB:       8192,
		},
		Relay: RelayConfig{
			MaxEnvelopeKB: 512,
		},
		RTC: RTCConfig{
			TURN: TURNConfig{
				Enabled:    true,
				ListenHost: "0.0.0.0",
				Port:       3478,
				Realm:      "echovoice",
				// Every relayed peer connection takes one port, and a screen
				// share allocates one per viewer on each side, so the old
				// 41-port range ran out after roughly twenty relayed
				// participants and every later allocation failed. The range is
				// the ceiling on relayed users, not on bandwidth.
				RelayMinPort: 49160,
				RelayMaxPort: 49460,
				TCPEnabled:   true,
			},
		},
		Realtime: RealtimeConfig{
			// 60s tolerates laptop sleep, network switches, and background-tab
			// suspension in browsers without immediately clearing voice
			// membership. Clients auto-rejoin anyway when the grace expires.
			DisconnectGraceSeconds: 60,
		},
		WebSocket: WebSocketConfig{
			// The library default is 32 KiB, which a screen-share renegotiation
			// can exceed (it carries a whole SDP per offer and the socket dies
			// with status 1009 mid-negotiation). One megabyte is far above any
			// legal message and still refuses to buffer an unbounded body.
			MaxMessageKB:  1024,
			SendQueue:     1024,
			PriorityQueue: 2048,
		},
		Web: WebConfig{
			Root: "./web",
		},
	}
}

// LoadOrCreate resolves the production executable's directory as the default
// server root. During go run it uses the current working directory instead.
func LoadOrCreate(path string) (LoadResult, error) {
	resolvedPath, err := resolveConfigFilePath(path)
	if err != nil {
		return LoadResult{}, err
	}
	created, err := writeDefaultConfigIfMissing(resolvedPath)
	if err != nil {
		return LoadResult{}, err
	}
	upgraded := false
	if !created {
		// An existing file keeps working without this step, because defaults are
		// layered underneath it. Writing the missing keys back is what makes the
		// file describe the server that is actually running (see UpgradeFile).
		upgraded, err = UpgradeFile(resolvedPath)
		if err != nil {
			// A configuration that only fails to gain documentation must still
			// start: the merge below is what the server actually runs on.
			upgraded = false
		}
	}
	cfg, err := Load(resolvedPath)
	if err != nil {
		return LoadResult{}, err
	}
	return LoadResult{Config: cfg, Path: resolvedPath, Created: created, Upgraded: upgraded}, nil
}

// Load reads YAML first and then applies EV_* environment variable overrides.
// With an empty path it uses EV_CONFIG_FILE, or ev-server.yaml when that file exists.
func Load(path string) (Config, error) {
	cfg := Defaults()
	requestedPath := strings.TrimSpace(path)
	if requestedPath == "" {
		requestedPath = strings.TrimSpace(os.Getenv("EV_CONFIG_FILE"))
	}
	explicitPath := requestedPath != ""
	if requestedPath == "" {
		requestedPath = defaultConfigFile
	}

	if data, err := os.ReadFile(requestedPath); err == nil {
		if err := yaml.Unmarshal(data, &cfg); err != nil {
			return Config{}, fmt.Errorf("parse config %q: %w", requestedPath, err)
		}
		absolutePath, err := filepath.Abs(requestedPath)
		if err != nil {
			return Config{}, fmt.Errorf("resolve config path %q: %w", requestedPath, err)
		}
		cfg.resolveRelativePaths(filepath.Dir(absolutePath))
	} else if explicitPath || !errors.Is(err, os.ErrNotExist) {
		return Config{}, fmt.Errorf("read config %q: %w", requestedPath, err)
	}

	cfg.applyEnvironment()
	cfg.ensureRuntimeSecrets()
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// ResolvePath reports the configuration file a start with the same argument
// would use, without creating anything.
func ResolvePath(path string) (string, error) {
	return resolveConfigFilePath(path)
}

func resolveConfigFilePath(path string) (string, error) {
	requestedPath := strings.TrimSpace(path)
	if requestedPath == "" {
		requestedPath = strings.TrimSpace(os.Getenv("EV_CONFIG_FILE"))
	}
	if requestedPath != "" {
		absolutePath, err := filepath.Abs(requestedPath)
		if err != nil {
			return "", fmt.Errorf("resolve config path %q: %w", requestedPath, err)
		}
		return absolutePath, nil
	}

	executablePath, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve EV Server executable path: %w", err)
	}
	root := filepath.Dir(executablePath)
	if isGoRunExecutable(executablePath) {
		root, err = os.Getwd()
		if err != nil {
			return "", fmt.Errorf("resolve EV Server working directory: %w", err)
		}
	}
	return filepath.Join(root, defaultConfigFile), nil
}

func isGoRunExecutable(executablePath string) bool {
	tempDir := filepath.Clean(os.TempDir()) + string(filepath.Separator)
	cleaned := filepath.Clean(executablePath)
	return strings.HasPrefix(strings.ToLower(cleaned), strings.ToLower(tempDir)) &&
		strings.Contains(strings.ToLower(cleaned), "go-build")
}

func writeDefaultConfigIfMissing(path string) (bool, error) {
	if _, err := os.Stat(path); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("inspect config %q: %w", path, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, fmt.Errorf("create config directory %q: %w", filepath.Dir(path), err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("create default config %q: %w", path, err)
	}
	encoder := yaml.NewEncoder(file)
	encoder.SetIndent(2)
	encodeErr := encoder.Encode(Defaults())
	closeEncoderErr := encoder.Close()
	closeFileErr := file.Close()
	if encodeErr != nil {
		_ = os.Remove(path)
		return false, fmt.Errorf("write default config %q: %w", path, encodeErr)
	}
	if closeEncoderErr != nil {
		return false, fmt.Errorf("finish default config %q: %w", path, closeEncoderErr)
	}
	if closeFileErr != nil {
		return false, fmt.Errorf("close default config %q: %w", path, closeFileErr)
	}
	return true, nil
}

// QuickstartOptions is the small set of answers a fresh deployment actually
// needs. Everything else already has a working default.
type QuickstartOptions struct {
	PublicURL string
	Password  string
	CertFile  string
	KeyFile   string
	ServeWeb  bool
	WebRoot   string
}

// Quickstart turns those answers into a configuration that a plain start can
// consume without further editing: HTTPS on, the Web client served (embedded by
// default), and the TURN public host taken from the public URL so relay
// candidates do not advertise a loopback address.
func Quickstart(opts QuickstartOptions) (Config, error) {
	cfg := Defaults()
	publicURL := strings.TrimSpace(opts.PublicURL)
	if publicURL == "" {
		return Config{}, fmt.Errorf("quickstart needs -public-url, for example https://voice.example.com:17878")
	}
	password := strings.TrimSpace(opts.Password)
	if password == "" {
		return Config{}, fmt.Errorf("quickstart needs -password")
	}
	parsed, err := url.Parse(publicURL)
	if err != nil {
		return Config{}, fmt.Errorf("parse public URL %q: %w", publicURL, err)
	}
	if parsed.Scheme != "https" || strings.TrimSpace(parsed.Host) == "" {
		return Config{}, fmt.Errorf("quickstart needs an https public URL, got %q: Web clients only accept https", publicURL)
	}
	cfg.Server.PublicURL = publicURL
	cfg.Server.Password = password
	if port := parsed.Port(); port != "" {
		cfg.Server.Port = port
	}
	certFile := strings.TrimSpace(opts.CertFile)
	if certFile == "" {
		certFile = "./cert.pem"
	}
	keyFile := strings.TrimSpace(opts.KeyFile)
	if keyFile == "" {
		keyFile = "./key.pem"
	}
	cfg.Server.TLS.Enabled = true
	cfg.Server.TLS.CertFile = certFile
	cfg.Server.TLS.KeyFile = keyFile
	cfg.Web.Enabled = opts.ServeWeb
	cfg.Web.Root = strings.TrimSpace(opts.WebRoot)
	if !cfg.Web.Enabled {
		cfg.Web.Root = ""
	}
	if cfg.RTC.TURN.Enabled && strings.TrimSpace(cfg.RTC.TURN.PublicHost) == "" {
		cfg.RTC.TURN.PublicHost = parsed.Hostname()
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// Save writes the configuration to path with owner-only permissions.
func Save(path string, cfg Config) error {
	if strings.TrimSpace(path) == "" {
		return fmt.Errorf("configuration path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create config directory %q: %w", filepath.Dir(path), err)
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("create config %q: %w", path, err)
	}
	encoder := yaml.NewEncoder(file)
	encoder.SetIndent(2)
	encodeErr := encoder.Encode(cfg)
	closeEncoderErr := encoder.Close()
	closeFileErr := file.Close()
	if encodeErr != nil {
		return fmt.Errorf("write config %q: %w", path, encodeErr)
	}
	if closeEncoderErr != nil {
		return fmt.Errorf("finish config %q: %w", path, closeEncoderErr)
	}
	if closeFileErr != nil {
		return fmt.Errorf("close config %q: %w", path, closeFileErr)
	}
	return nil
}

func (c Config) Validate() error {
	if strings.TrimSpace(c.Server.Name) == "" {
		return errors.New("server.name must not be empty")
	}
	port, err := strconv.Atoi(c.Server.Port)
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("server.port must be between 1 and 65535, got %q", c.Server.Port)
	}
	if c.Storage.Driver != "sqlite" {
		return fmt.Errorf("storage.driver %q is not supported", c.Storage.Driver)
	}
	if c.Server.TLS.ReloadIntervalSeconds < 1 {
		return errors.New("server.tls.reload_interval_seconds must be at least 1")
	}
	if c.Server.TLS.Enabled {
		if strings.TrimSpace(c.Server.TLS.CertFile) == "" || strings.TrimSpace(c.Server.TLS.KeyFile) == "" {
			return errors.New("server.tls.cert_file and server.tls.key_file are required when TLS is enabled")
		}
	}
	if c.Web.Enabled {
		if !c.Server.TLS.Enabled {
			return errors.New("web.enabled requires server.tls.enabled because Web deployment must use HTTPS")
		}
		// An empty web.root means "serve the Web client bundled into this
		// binary", which is what makes a single ev-server.exe a complete
		// deployment. Only the binary knows whether it carries that bundle, so
		// the Web layer owns the check and reports which source is missing.
	}
	if c.Server.PublicURL != "" {
		parsed, err := url.Parse(c.Server.PublicURL)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return fmt.Errorf("server.public_url must be an absolute http or https URL, got %q", c.Server.PublicURL)
		}
		if c.Server.TLS.Enabled && parsed.Scheme != "https" {
			return errors.New("server.public_url must use https when TLS is enabled")
		}
	}
	if c.RTC.TURN.Enabled {
		if c.RTC.TURN.Port < 1 || c.RTC.TURN.Port > 65535 {
			return errors.New("rtc.turn.port must be between 1 and 65535")
		}
		if c.RTC.TURN.RelayMinPort < 1 || c.RTC.TURN.RelayMaxPort > 65535 || c.RTC.TURN.RelayMinPort > c.RTC.TURN.RelayMaxPort {
			return errors.New("rtc.turn relay port range is invalid")
		}
		if strings.TrimSpace(c.RTC.TURN.ListenHost) == "" || strings.TrimSpace(c.RTC.TURN.Realm) == "" {
			return errors.New("rtc.turn.listen_host and rtc.turn.realm are required")
		}
	}
	if c.Realtime.DisconnectGraceSeconds < 1 {
		return errors.New("realtime.disconnect_grace_seconds must be at least 1")
	}
	if c.WebSocket.MaxMessageKB != -1 && c.WebSocket.MaxMessageKB < 1 {
		return errors.New("websocket.max_message_kb must be a positive number of kilobytes, or -1 to disable the cap")
	}
	if c.WebSocket.SendQueue < 1 || c.WebSocket.PriorityQueue < 1 {
		return errors.New("websocket send and priority queue depths must be at least 1")
	}
	return nil
}

// WebSocketReadLimitBytes is the per-message cap handed to the signalling
// socket; -1 means unlimited.
func (c Config) WebSocketReadLimitBytes() int64 {
	if c.WebSocket.MaxMessageKB < 0 {
		return -1
	}
	return int64(c.WebSocket.MaxMessageKB) * 1024
}

func (c Config) TURNPublicHost() string {
	if host := strings.TrimSpace(c.RTC.TURN.PublicHost); host != "" {
		return host
	}
	if parsed, err := url.Parse(c.PublicURL()); err == nil {
		if host := parsed.Hostname(); host != "" && host != "localhost" {
			return host
		}
	}
	return "127.0.0.1"
}

func (c Config) ListenAddress() string {
	return fmt.Sprintf("%s:%s", c.Server.Host, c.Server.Port)
}

func (c Config) PublicURL() string {
	if c.Server.PublicURL != "" {
		return strings.TrimRight(c.Server.PublicURL, "/")
	}
	scheme := "http"
	if c.Server.TLS.Enabled {
		scheme = "https"
	}
	host := c.Server.Host
	if host == "0.0.0.0" || host == "::" || host == "" {
		host = "localhost"
	}
	return fmt.Sprintf("%s://%s:%s", scheme, host, c.Server.Port)
}

// HTTPAddress remains available for existing callers.
func (c Config) HTTPAddress() string {
	return c.ListenAddress()
}

func (c *Config) resolveRelativePaths(baseDir string) {
	c.Storage.SQLitePath = resolvePath(baseDir, c.Storage.SQLitePath)
	c.Storage.ContentPath = resolvePath(baseDir, c.Storage.ContentPath)
	c.Server.TLS.CertFile = resolvePath(baseDir, c.Server.TLS.CertFile)
	c.Server.TLS.KeyFile = resolvePath(baseDir, c.Server.TLS.KeyFile)
	c.Web.Root = resolvePath(baseDir, c.Web.Root)
}

func resolvePath(baseDir string, value string) string {
	if value == "" || filepath.IsAbs(value) {
		return value
	}
	return filepath.Clean(filepath.Join(baseDir, value))
}

func (c *Config) applyEnvironment() {
	c.Server.Name = envOr("EV_SERVER_NAME", c.Server.Name)
	c.Server.Host = envOr("EV_HOST", c.Server.Host)
	c.Server.Port = envOr("EV_PORT", c.Server.Port)
	c.Server.PublicURL = envOr("EV_PUBLIC_URL", c.Server.PublicURL)
	if value, ok := os.LookupEnv("EV_SERVER_PASSWORD"); ok {
		c.Server.Password = value
	}
	c.Server.TLS.Enabled = envBool("EV_TLS_ENABLED", c.Server.TLS.Enabled)
	c.Server.TLS.CertFile = envOr("EV_TLS_CERT_FILE", c.Server.TLS.CertFile)
	c.Server.TLS.KeyFile = envOr("EV_TLS_KEY_FILE", c.Server.TLS.KeyFile)
	c.Server.TLS.ReloadIntervalSeconds = envInt("EV_TLS_RELOAD_INTERVAL_SECONDS", c.Server.TLS.ReloadIntervalSeconds)
	c.Web.Enabled = envBool("EV_WEB_ENABLED", c.Web.Enabled)
	c.Web.Root = envOr("EV_WEB_ROOT", c.Web.Root)
	c.Storage.Driver = envOr("EV_STORAGE_DRIVER", c.Storage.Driver)
	c.Storage.SQLitePath = envOr("EV_SQLITE_PATH", c.Storage.SQLitePath)
	c.Storage.ContentPath = envOr("EV_CONTENT_PATH", c.Storage.ContentPath)
	c.Storage.MaxChannelFileMB = envInt("EV_MAX_CHANNEL_FILE_MB", c.Storage.MaxChannelFileMB)
	c.Storage.MaxSoundboardKB = envInt("EV_MAX_SOUNDBOARD_KB", c.Storage.MaxSoundboardKB)
	c.Storage.MaxEmojiKB = envInt("EV_MAX_EMOJI_KB", c.Storage.MaxEmojiKB)
	c.Relay.DMRelayEnabled = envBool("EV_DM_RELAY_ENABLED", c.Relay.DMRelayEnabled)
	c.Relay.PrivateVoiceRelayEnabled = envBool("EV_PRIVATE_VOICE_RELAY_ENABLED", c.Relay.PrivateVoiceRelayEnabled)
	c.Relay.HomeMailboxEnabled = envBool("EV_HOME_MAILBOX_ENABLED", c.Relay.HomeMailboxEnabled)
	c.Relay.MaxEnvelopeKB = envInt("EV_MAX_RELAY_ENVELOPE_KB", c.Relay.MaxEnvelopeKB)
	c.RTC.TURN.Enabled = envBool("EV_TURN_ENABLED", c.RTC.TURN.Enabled)
	c.RTC.TURN.ListenHost = envOr("EV_TURN_LISTEN_HOST", c.RTC.TURN.ListenHost)
	c.RTC.TURN.Port = envInt("EV_TURN_PORT", c.RTC.TURN.Port)
	c.RTC.TURN.PublicHost = envOr("EV_TURN_PUBLIC_HOST", c.RTC.TURN.PublicHost)
	c.RTC.TURN.Realm = envOr("EV_TURN_REALM", c.RTC.TURN.Realm)
	c.RTC.TURN.RelayMinPort = envInt("EV_TURN_RELAY_MIN_PORT", c.RTC.TURN.RelayMinPort)
	c.RTC.TURN.RelayMaxPort = envInt("EV_TURN_RELAY_MAX_PORT", c.RTC.TURN.RelayMaxPort)
	c.RTC.TURN.TCPEnabled = envBool("EV_TURN_TCP_ENABLED", c.RTC.TURN.TCPEnabled)
	c.Realtime.DisconnectGraceSeconds = envInt(
		"EV_REALTIME_DISCONNECT_GRACE_SECONDS",
		c.Realtime.DisconnectGraceSeconds,
	)
	c.WebSocket.MaxMessageKB = envInt("EV_WS_MAX_MESSAGE_KB", c.WebSocket.MaxMessageKB)
	c.WebSocket.SendQueue = envInt("EV_WS_SEND_QUEUE", c.WebSocket.SendQueue)
	c.WebSocket.PriorityQueue = envInt("EV_WS_PRIORITY_QUEUE", c.WebSocket.PriorityQueue)
}

func (c *Config) ensureRuntimeSecrets() {
	if !c.RTC.TURN.Enabled || c.RTC.TURN.AuthSecret != "" {
		return
	}
	secret, err := randomSecret(32)
	if err == nil {
		c.RTC.TURN.AuthSecret = secret
	}
}

func envOr(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func envBool(key string, fallback bool) bool {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func randomSecret(size int) (string, error) {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}
