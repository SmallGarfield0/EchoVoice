package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"github.com/echovoice/echovoice/services/ev-server/internal/auth"
	"github.com/echovoice/echovoice/services/ev-server/internal/domain"
)

type SQLiteStore struct {
	db                     *sql.DB
	memberMergeMu          sync.Mutex
	voiceMu                sync.Mutex
	voiceStatsCheckpointMS int64
	voiceSpeaking          map[string]bool
	shareMu                sync.RWMutex
	screenShareSessions    map[string]domain.ScreenShareSession
	accompanimentSessions  map[string]domain.AccompanimentSession
}

func OpenSQLite(path string, serverName string) (*SQLiteStore, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("create sqlite directory: %w", err)
	}
	dsn := path + "?_pragma=busy_timeout%3d5000&_pragma=journal_mode%28WAL%29&_pragma=foreign_keys%281%29"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// The DSN applies these pragmas to every pooled connection. More than one
	// connection is required because some store reads intentionally nest queries.
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(4)
	store := &SQLiteStore{
		db:                     db,
		voiceStatsCheckpointMS: time.Now().UnixMilli(),
		voiceSpeaking:          make(map[string]bool),
		screenShareSessions:    make(map[string]domain.ScreenShareSession),
		accompanimentSessions:  make(map[string]domain.AccompanimentSession),
	}
	if err := store.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := store.ensureDefaults(serverName); err != nil {
		_ = db.Close()
		return nil, err
	}
	// Speaking is an ephemeral realtime signal. Never restore a stale speaking
	// indicator after a server restart.
	if _, err := db.Exec(`UPDATE voice_states SET is_speaking = 0 WHERE is_speaking != 0`); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("reset stale voice speaking states: %w", err)
	}
	return store, nil
}

func (s *SQLiteStore) Close() error {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	settleErr := s.settleVoiceDurationsLocked(time.Now().UnixMilli(), true)
	closeErr := s.db.Close()
	if settleErr != nil {
		return settleErr
	}
	return closeErr
}

func (s *SQLiteStore) migrate() error {
	if err := s.dropLegacyPermissionTables(); err != nil {
		return err
	}
	statements := []string{
		`CREATE TABLE IF NOT EXISTS server_settings (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			server_id TEXT NOT NULL,
			name TEXT NOT NULL,
			icon_sha256 TEXT NOT NULL DEFAULT '',
			icon_data_url TEXT NOT NULL DEFAULT '',
			description TEXT NOT NULL DEFAULT '',
			screen_share_enabled INTEGER NOT NULL DEFAULT 0,
			remote_control_enabled INTEGER NOT NULL DEFAULT 0,
			accompaniment_enabled INTEGER NOT NULL DEFAULT 0,
			soundboard_enabled INTEGER NOT NULL DEFAULT 0,
			emoji_enabled INTEGER NOT NULL DEFAULT 0,
			emoji_max_kb INTEGER NOT NULL DEFAULT 1024,
			file_storage_enabled INTEGER NOT NULL DEFAULT 0,
			dm_relay_enabled INTEGER NOT NULL DEFAULT 0,
			home_mailbox_enabled INTEGER NOT NULL DEFAULT 0,
			visibility TEXT NOT NULL DEFAULT 'public',
			default_language TEXT NOT NULL DEFAULT 'zh-CN',
			created_at INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS members (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			member_uuid TEXT NOT NULL UNIQUE,
			display_name TEXT NOT NULL,
			avatar_sha256 TEXT NOT NULL DEFAULT '',
			avatar_data_url TEXT NOT NULL DEFAULT '',
			avatar_color TEXT NOT NULL DEFAULT '',
			bio TEXT NOT NULL DEFAULT '',
			profile_updated_at INTEGER NOT NULL DEFAULT 0,
			profile_override_display_name INTEGER NOT NULL DEFAULT 0,
			profile_override_avatar INTEGER NOT NULL DEFAULT 0,
			profile_override_bio INTEGER NOT NULL DEFAULT 0,
			local_profile_id TEXT NOT NULL DEFAULT '',
			is_owner INTEGER NOT NULL DEFAULT 0,
			is_banned INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			last_seen_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS member_credentials (
			member_uuid TEXT NOT NULL PRIMARY KEY,
			access_key_hash TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			revoked_at INTEGER
		)`,
		`CREATE TABLE IF NOT EXISTS member_devices (
			local_profile_id TEXT NOT NULL PRIMARY KEY,
			member_uuid TEXT NOT NULL,
			access_key_hash TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			last_seen_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS roles (
			role_uuid TEXT NOT NULL PRIMARY KEY,
			name TEXT NOT NULL,
			color TEXT NOT NULL DEFAULT '',
			gradient_color TEXT NOT NULL DEFAULT '',
			icon_data_url TEXT NOT NULL DEFAULT '',
			display_separately INTEGER NOT NULL DEFAULT 0,
			position INTEGER NOT NULL DEFAULT 0,
			is_everyone INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS role_permissions (
			role_uuid TEXT NOT NULL,
			permission TEXT NOT NULL,
			allowed INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (role_uuid, permission)
		)`,
		`CREATE TABLE IF NOT EXISTS member_roles (
			member_uuid TEXT NOT NULL,
			role_uuid TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (member_uuid, role_uuid)
		)`,
		`CREATE TABLE IF NOT EXISTS channels (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			channel_uuid TEXT NOT NULL UNIQUE,
			parent_uuid TEXT NOT NULL DEFAULT '',
			type TEXT NOT NULL,
			name TEXT NOT NULL,
			topic TEXT NOT NULL DEFAULT '',
			visibility TEXT NOT NULL DEFAULT 'default',
			warning_text TEXT NOT NULL DEFAULT '',
			permission_synced INTEGER NOT NULL DEFAULT 0,
			position INTEGER NOT NULL DEFAULT 0,
			bitrate INTEGER NOT NULL DEFAULT 0,
			user_limit INTEGER NOT NULL DEFAULT 0,
			default_language TEXT NOT NULL DEFAULT '',
			localizations_json TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			message_uuid TEXT NOT NULL UNIQUE,
			channel_uuid TEXT NOT NULL,
			author_member_uuid TEXT NOT NULL,
			content TEXT NOT NULL,
			reply_to_message_uuid TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL,
			edited_at INTEGER NOT NULL DEFAULT 0,
			deleted_at INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS content_assets (
			sha256 TEXT NOT NULL PRIMARY KEY,
			size_bytes INTEGER NOT NULL,
			mime_type TEXT NOT NULL DEFAULT '',
			original_name TEXT NOT NULL DEFAULT '',
			storage_path TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS channel_message_images (
			channel_uuid TEXT NOT NULL,
			asset_sha256 TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (channel_uuid, asset_sha256)
		)`,
		`CREATE TABLE IF NOT EXISTS soundboard_items (
			item_uuid TEXT NOT NULL PRIMARY KEY,
			name TEXT NOT NULL COLLATE NOCASE UNIQUE,
			asset_sha256 TEXT NOT NULL,
			icon_emoji TEXT NOT NULL DEFAULT '',
			icon_asset_sha256 TEXT NOT NULL DEFAULT '',
			start_ms INTEGER NOT NULL DEFAULT 0,
			end_ms INTEGER NOT NULL DEFAULT 0,
			base_volume REAL NOT NULL DEFAULT 1,
			uploader_member_uuid TEXT NOT NULL DEFAULT '',
			size_bytes INTEGER NOT NULL DEFAULT 0,
			mime_type TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS custom_emojis (
			emoji_uuid TEXT NOT NULL PRIMARY KEY,
			shortcode TEXT NOT NULL COLLATE NOCASE UNIQUE,
			asset_sha256 TEXT NOT NULL,
			preview_sha256 TEXT NOT NULL DEFAULT '',
			uploader_member_uuid TEXT NOT NULL DEFAULT '',
			size_bytes INTEGER NOT NULL DEFAULT 0,
			mime_type TEXT NOT NULL DEFAULT '',
			is_gif INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS channel_file_entries (
			entry_uuid TEXT NOT NULL PRIMARY KEY,
			channel_uuid TEXT NOT NULL,
			parent_uuid TEXT NOT NULL DEFAULT '',
			type TEXT NOT NULL,
			name TEXT NOT NULL,
			asset_sha256 TEXT NOT NULL DEFAULT '',
			uploader_member_uuid TEXT NOT NULL DEFAULT '',
			size_bytes INTEGER NOT NULL DEFAULT 0,
			mime_type TEXT NOT NULL DEFAULT '',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS audit_logs (
			audit_uuid TEXT NOT NULL PRIMARY KEY,
			actor_member_uuid TEXT NOT NULL DEFAULT '',
			action TEXT NOT NULL,
			target_type TEXT NOT NULL DEFAULT '',
			target_uuid TEXT NOT NULL DEFAULT '',
			details TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS server_invites (
			invite_uuid TEXT NOT NULL PRIMARY KEY,
			token TEXT NOT NULL DEFAULT '',
			token_hash TEXT NOT NULL UNIQUE,
			creator_member_uuid TEXT NOT NULL,
			expires_at INTEGER NOT NULL DEFAULT 0,
			max_uses INTEGER NOT NULL DEFAULT 1,
			use_count INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS member_merge_codes (
			target_member_uuid TEXT NOT NULL PRIMARY KEY,
			code_hash TEXT NOT NULL UNIQUE,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS member_merge_requests (
			request_uuid TEXT NOT NULL PRIMARY KEY,
			target_member_uuid TEXT NOT NULL,
			requester_member_uuid TEXT NOT NULL,
			status TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			resolved_at INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE INDEX IF NOT EXISTS idx_member_merge_requests_target_status
			ON member_merge_requests(target_member_uuid, status, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_member_merge_requests_requester_status
			ON member_merge_requests(requester_member_uuid, status, created_at)`,
		`CREATE TABLE IF NOT EXISTS channel_permission_overrides (
			override_uuid TEXT NOT NULL PRIMARY KEY,
			channel_uuid TEXT NOT NULL,
			target_type TEXT NOT NULL,
			target_uuid TEXT NOT NULL,
			allow_permissions TEXT NOT NULL DEFAULT '{}',
			deny_permissions TEXT NOT NULL DEFAULT '{}',
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			UNIQUE (channel_uuid, target_type, target_uuid)
		)`,
		`CREATE TABLE IF NOT EXISTS voice_member_durations (
			member_uuid TEXT NOT NULL PRIMARY KEY,
			total_duration_ms INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS voice_pair_durations (
			member_a_uuid TEXT NOT NULL,
			member_b_uuid TEXT NOT NULL,
			shared_duration_ms INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY (member_a_uuid, member_b_uuid)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_voice_pair_durations_member_b ON voice_pair_durations(member_b_uuid)`,
		`DROP TABLE IF EXISTS voice_states`,
		`CREATE TABLE voice_states (
			participant_uuid TEXT NOT NULL PRIMARY KEY,
			member_uuid TEXT NOT NULL,
			device_uuid TEXT NOT NULL,
			mode TEXT NOT NULL DEFAULT 'primary',
			channel_uuid TEXT NOT NULL,
			joined_at INTEGER NOT NULL,
			mic_muted INTEGER NOT NULL DEFAULT 0,
			audio_deafened INTEGER NOT NULL DEFAULT 0,
			server_muted INTEGER NOT NULL DEFAULT 0,
			server_deafened INTEGER NOT NULL DEFAULT 0,
			is_speaking INTEGER NOT NULL DEFAULT 0,
			UNIQUE(member_uuid, device_uuid)
		)`,
	}
	for _, statement := range statements {
		if _, err := s.db.Exec(statement); err != nil {
			return fmt.Errorf("migrate sqlite: %w", err)
		}
	}
	if err := s.ensureColumn("members", "is_banned", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	for _, column := range []struct {
		table      string
		name       string
		definition string
	}{
		{"server_settings", "icon_data_url", "TEXT NOT NULL DEFAULT ''"},
		{"server_settings", "description", "TEXT NOT NULL DEFAULT ''"},
		{"server_settings", "emoji_max_kb", "INTEGER NOT NULL DEFAULT 1024"},
		{"server_settings", "visibility", "TEXT NOT NULL DEFAULT 'public'"},
		{"server_settings", "default_language", "TEXT NOT NULL DEFAULT 'zh-CN'"},
		{"server_settings", "created_at", "INTEGER NOT NULL DEFAULT 0"},
		{"members", "avatar_data_url", "TEXT NOT NULL DEFAULT ''"},
		{"members", "avatar_color", "TEXT NOT NULL DEFAULT ''"},
		{"members", "profile_updated_at", "INTEGER NOT NULL DEFAULT 0"},
		{"members", "profile_override_display_name", "INTEGER NOT NULL DEFAULT 0"},
		{"members", "profile_override_avatar", "INTEGER NOT NULL DEFAULT 0"},
		{"members", "profile_override_bio", "INTEGER NOT NULL DEFAULT 0"},
		{"roles", "gradient_color", "TEXT NOT NULL DEFAULT ''"},
		{"roles", "icon_data_url", "TEXT NOT NULL DEFAULT ''"},
		{"roles", "display_separately", "INTEGER NOT NULL DEFAULT 0"},
		{"channels", "visibility", "TEXT NOT NULL DEFAULT 'default'"},
		{"channels", "warning_text", "TEXT NOT NULL DEFAULT ''"},
		{"channels", "permission_synced", "INTEGER NOT NULL DEFAULT 0"},
		{"channels", "default_language", "TEXT NOT NULL DEFAULT ''"},
		{"channels", "localizations_json", "TEXT NOT NULL DEFAULT '{}'"},
		{"server_invites", "token", "TEXT NOT NULL DEFAULT ''"},
		{"soundboard_items", "icon_emoji", "TEXT NOT NULL DEFAULT ''"},
		{"soundboard_items", "icon_asset_sha256", "TEXT NOT NULL DEFAULT ''"},
		{"soundboard_items", "start_ms", "INTEGER NOT NULL DEFAULT 0"},
		{"soundboard_items", "end_ms", "INTEGER NOT NULL DEFAULT 0"},
		{"soundboard_items", "base_volume", "REAL NOT NULL DEFAULT 1"},
	} {
		if err := s.ensureColumn(column.table, column.name, column.definition); err != nil {
			return err
		}
	}
	if err := s.ensureColumn("messages", "deleted_at", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := s.ensureColumn("messages", "reply_to_message_uuid", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if err := s.ensureColumn("channel_file_entries", "uploader_member_uuid", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if err := s.ensureColumn("voice_states", "mic_muted", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := s.ensureColumn("voice_states", "audio_deafened", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := s.ensureColumn("voice_states", "server_muted", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := s.ensureColumn("voice_states", "server_deafened", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if err := s.ensureColumn("voice_states", "is_speaking", "INTEGER NOT NULL DEFAULT 0"); err != nil {
		return err
	}
	if _, err := s.db.Exec(
		`INSERT OR IGNORE INTO member_devices (local_profile_id, member_uuid, access_key_hash, created_at, last_seen_at)
		 SELECT m.local_profile_id, m.member_uuid, c.access_key_hash, c.created_at, m.last_seen_at
		 FROM members m JOIN member_credentials c ON c.member_uuid = m.member_uuid
		 WHERE m.local_profile_id != '' AND c.revoked_at IS NULL`,
	); err != nil {
		return fmt.Errorf("migrate member devices: %w", err)
	}
	if _, err := s.db.Exec(
		`UPDATE channels SET permission_synced = 1
		 WHERE parent_uuid != '' AND permission_synced = 0
		 AND NOT EXISTS (
		 SELECT 1 FROM channel_permission_overrides o WHERE o.channel_uuid = channels.channel_uuid
		 )`,
	); err != nil {
		return fmt.Errorf("migrate channel permission sync: %w", err)
	}
	if _, err := s.db.Exec(`UPDATE server_settings SET created_at = ? WHERE created_at <= 0`, time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("migrate server created time: %w", err)
	}
	if err := s.migrateCustomEmojiShortcodes(); err != nil {
		return err
	}
	return nil
}

func normalizeStoredEmojiShortcode(value string) string {
	value = strings.ToLower(strings.Trim(strings.TrimSpace(value), ":"))
	var normalized strings.Builder
	invalidRun := false
	for _, character := range value {
		valid := character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character == '_'
		if valid {
			normalized.WriteRune(character)
			invalidRun = false
		} else if normalized.Len() > 0 && !invalidRun {
			normalized.WriteByte('_')
			invalidRun = true
		}
		if normalized.Len() >= 12 {
			break
		}
	}
	return strings.Trim(normalized.String(), "_")
}

func isStoredEmojiShortcodeValid(value string) bool {
	if len(value) < 1 || len(value) > 12 {
		return false
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character == '_' {
			continue
		}
		return false
	}
	return true
}

func uniqueStoredEmojiShortcode(base string, used map[string]struct{}) string {
	if base == "" {
		base = "emoji"
	}
	if _, exists := used[base]; !exists {
		return base
	}
	for suffix := 2; ; suffix++ {
		suffixText := fmt.Sprintf("_%d", suffix)
		prefixLength := 12 - len(suffixText)
		if prefixLength < 1 {
			continue
		}
		prefix := strings.TrimRight(base[:min(len(base), prefixLength)], "_")
		if prefix == "" {
			prefix = "e"
		}
		candidate := prefix + suffixText
		if _, exists := used[candidate]; !exists {
			return candidate
		}
	}
}

func (s *SQLiteStore) migrateCustomEmojiShortcodes() error {
	rows, err := s.db.Query(`SELECT emoji_uuid, shortcode FROM custom_emojis ORDER BY created_at, emoji_uuid`)
	if err != nil {
		return fmt.Errorf("read custom emoji shortcodes: %w", err)
	}
	type storedEmojiShortcode struct {
		id        string
		shortcode string
		position  int
	}
	items := make([]storedEmojiShortcode, 0)
	for rows.Next() {
		var item storedEmojiShortcode
		item.position = len(items)
		if err := rows.Scan(&item.id, &item.shortcode); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan custom emoji shortcode: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close custom emoji shortcode rows: %w", err)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read custom emoji shortcodes: %w", err)
	}
	if len(items) == 0 {
		return nil
	}

	sort.SliceStable(items, func(left, right int) bool {
		leftValid := isStoredEmojiShortcodeValid(items[left].shortcode)
		rightValid := isStoredEmojiShortcodeValid(items[right].shortcode)
		if leftValid != rightValid {
			return leftValid
		}
		return items[left].position < items[right].position
	})
	used := make(map[string]struct{}, len(items))
	updates := make(map[string]string)
	for _, item := range items {
		base := normalizeStoredEmojiShortcode(item.shortcode)
		shortcode := uniqueStoredEmojiShortcode(base, used)
		used[shortcode] = struct{}{}
		if shortcode != item.shortcode {
			updates[item.id] = shortcode
		}
	}
	if len(updates) == 0 {
		return nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin custom emoji shortcode migration: %w", err)
	}
	defer tx.Rollback()
	for emojiID, shortcode := range updates {
		if _, err := tx.Exec(`UPDATE custom_emojis SET shortcode = ? WHERE emoji_uuid = ?`, shortcode, emojiID); err != nil {
			return fmt.Errorf("migrate custom emoji shortcode %s: %w", emojiID, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit custom emoji shortcode migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) dropLegacyPermissionTables() error {
	if _, err := s.db.Exec(`DROP TABLE IF EXISTS permission_groups`); err != nil {
		return fmt.Errorf("drop legacy permission_groups: %w", err)
	}
	if _, err := s.db.Exec(`DROP TABLE IF EXISTS permission_overrides`); err != nil {
		return fmt.Errorf("drop legacy permission_overrides: %w", err)
	}
	if s.tableHasColumn("members", "role") {
		if _, err := s.db.Exec(`ALTER TABLE members DROP COLUMN role`); err != nil {
			return fmt.Errorf("drop legacy members.role: %w", err)
		}
	}
	if s.tableHasColumn("role_permissions", "role") {
		if _, err := s.db.Exec(`DROP TABLE role_permissions`); err != nil {
			return fmt.Errorf("drop legacy role_permissions: %w", err)
		}
	}
	if s.tableHasColumn("member_roles", "role") {
		if _, err := s.db.Exec(`DROP TABLE member_roles`); err != nil {
			return fmt.Errorf("drop legacy member_roles: %w", err)
		}
	}
	return nil
}

func (s *SQLiteStore) tableHasColumn(table string, column string) bool {
	rows, err := s.db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return false
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name string
		var columnType string
		var notNull int
		var defaultValue sql.NullString
		var primaryKey int
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
			return false
		}
		if name == column {
			return true
		}
	}
	return false
}

func (s *SQLiteStore) ensureColumn(table string, column string, definition string) error {
	if s.tableHasColumn(table, column) {
		return nil
	}
	if _, err := s.db.Exec(`ALTER TABLE ` + table + ` ADD COLUMN ` + column + ` ` + definition); err != nil {
		return fmt.Errorf("add sqlite column %s.%s: %w", table, column, err)
	}
	return nil
}

func (s *SQLiteStore) ensureDefaults(serverName string) error {
	if err := s.ensureDefaultRoles(); err != nil {
		return err
	}

	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM server_settings`).Scan(&count); err != nil {
		return err
	}
	if count == 0 {
		serverID, err := auth.NewToken("srv")
		if err != nil {
			return err
		}
		if _, err := s.db.Exec(
			`INSERT INTO server_settings (id, server_id, name, created_at) VALUES (1, ?, ?, ?)`,
			serverID,
			serverName,
			time.Now().UnixMilli(),
		); err != nil {
			return err
		}
	}

	if err := s.db.QueryRow(`SELECT COUNT(*) FROM channels`).Scan(&count); err != nil {
		return err
	}
	if count == 0 {
		now := time.Now().UnixMilli()
		textID, err := auth.NewToken("ch")
		if err != nil {
			return err
		}
		voiceID, err := auth.NewToken("ch")
		if err != nil {
			return err
		}
		if _, err := s.db.Exec(
			`INSERT INTO channels (channel_uuid, type, name, position, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
			textID, domain.ChannelTypeText, "general", 1000, now, now,
			voiceID, domain.ChannelTypeVoice, "Voice", 2000, now, now,
		); err != nil {
			return err
		}
	}
	if _, err := s.db.Exec(`DELETE FROM voice_states`); err != nil {
		return err
	}
	return s.normalizeChannelPositions()
}

func (s *SQLiteStore) ensureDefaultRoles() error {
	now := time.Now().UnixMilli()
	if _, err := s.db.Exec(
		`INSERT OR IGNORE INTO roles (role_uuid, name, color, position, is_everyone, created_at, updated_at)
		 VALUES (?, '@everyone', '', 0, 1, ?, ?)`,
		domain.EveryoneRoleID,
		now,
		now,
	); err != nil {
		return err
	}
	defaults := defaultEveryonePermissions()
	for _, permission := range domain.AllPermissions {
		if _, err := s.db.Exec(
			`INSERT OR IGNORE INTO role_permissions (role_uuid, permission, allowed) VALUES (?, ?, ?)`,
			domain.EveryoneRoleID,
			permission,
			boolInt(defaults[permission]),
		); err != nil {
			return err
		}
	}
	return nil
}

func (s *SQLiteStore) Server() domain.Server {
	var server domain.Server
	var screenShare, remoteControl, accompaniment, soundboard, emoji, fileStorage, dmRelay, homeMailbox int
	err := s.db.QueryRow(
		`SELECT server_id, name, icon_sha256, icon_data_url, description, screen_share_enabled, remote_control_enabled,
		 accompaniment_enabled, soundboard_enabled, emoji_enabled, emoji_max_kb, file_storage_enabled,
		 dm_relay_enabled, home_mailbox_enabled, visibility, default_language, created_at FROM server_settings WHERE id = 1`,
	).Scan(
		&server.ServerID,
		&server.Name,
		&server.IconSHA256,
		&server.IconDataURL,
		&server.Description,
		&screenShare,
		&remoteControl,
		&accompaniment,
		&soundboard,
		&emoji,
		&server.EmojiMaxKB,
		&fileStorage,
		&dmRelay,
		&homeMailbox,
		&server.Visibility,
		&server.DefaultLanguage,
		&server.CreatedAtMS,
	)
	if err != nil {
		return domain.Server{Name: "EchoVoice Server"}
	}
	server.ScreenShareEnabled = screenShare != 0
	server.RemoteControlEnabled = remoteControl != 0
	server.AccompanimentEnabled = accompaniment != 0
	server.SoundboardEnabled = soundboard != 0
	server.EmojiEnabled = emoji != 0
	if server.EmojiMaxKB <= 0 {
		server.EmojiMaxKB = 1024
	}
	server.FileStorageEnabled = fileStorage != 0
	server.DMRelayEnabled = dmRelay != 0
	server.HomeMailboxEnabled = homeMailbox != 0
	if server.Visibility != "private" {
		server.Visibility = "public"
	}
	if strings.TrimSpace(server.DefaultLanguage) == "" {
		server.DefaultLanguage = "zh-CN"
	}
	return server
}

func (s *SQLiteStore) UpdateServer(input domain.Server) domain.Server {
	current := s.Server()
	emojiMaxKB := input.EmojiMaxKB
	if emojiMaxKB <= 0 {
		emojiMaxKB = current.EmojiMaxKB
	}
	_, _ = s.db.Exec(
		`UPDATE server_settings SET name = ?, icon_sha256 = ?, icon_data_url = ?, description = ?, screen_share_enabled = ?,
		 remote_control_enabled = ?, accompaniment_enabled = ?, soundboard_enabled = ?,
		 emoji_enabled = ?, emoji_max_kb = ?, file_storage_enabled = ?, dm_relay_enabled = ?, home_mailbox_enabled = ?,
		 visibility = ?, default_language = ?
		 WHERE id = 1`,
		nonEmpty(input.Name, current.Name),
		input.IconSHA256,
		input.IconDataURL,
		input.Description,
		boolInt(input.ScreenShareEnabled),
		boolInt(input.RemoteControlEnabled),
		boolInt(input.AccompanimentEnabled),
		boolInt(input.SoundboardEnabled),
		boolInt(input.EmojiEnabled),
		emojiMaxKB,
		boolInt(input.FileStorageEnabled),
		boolInt(input.DMRelayEnabled),
		boolInt(input.HomeMailboxEnabled),
		normalizeServerVisibility(input.Visibility),
		nonEmpty(strings.TrimSpace(input.DefaultLanguage), current.DefaultLanguage),
	)
	return s.Server()
}

func (s *SQLiteStore) UpsertMember(profile domain.ProfileInput) (domain.Member, string, bool, error) {
	accessKey, err := auth.NewToken("key")
	if err != nil {
		return domain.Member{}, "", false, err
	}
	now := time.Now().UnixMilli()
	if profile.ProfileUpdatedAtMS <= 0 {
		profile.ProfileUpdatedAtMS = now
	}
	if profile.LocalProfileID != "" {
		member, found, err := s.memberByLocalProfileID(profile.LocalProfileID)
		if err != nil {
			return domain.Member{}, "", false, err
		}
		if found {
			if member.IsBanned {
				return domain.Member{}, "", false, ErrForbidden
			}
			if profile.ProfileUpdatedAtMS > member.ProfileUpdatedAtMS {
				applyGlobalProfile(&member, profile)
			}
			member.LastSeenAtMS = now
			tx, err := s.db.Begin()
			if err != nil {
				return domain.Member{}, "", false, err
			}
			defer func() {
				if err != nil {
					_ = tx.Rollback()
				}
			}()
			if _, err = tx.Exec(
				`UPDATE members SET display_name = ?, avatar_sha256 = ?, avatar_data_url = ?, avatar_color = ?, bio = ?, profile_updated_at = ?, updated_at = ?, last_seen_at = ?
				 WHERE member_uuid = ?`,
				member.DisplayName,
				member.AvatarSHA256,
				member.AvatarDataURL,
				member.AvatarColor,
				member.Bio,
				member.ProfileUpdatedAtMS,
				now,
				now,
				member.MemberID,
			); err != nil {
				return domain.Member{}, "", false, err
			}
			if _, err = tx.Exec(
				`INSERT INTO member_credentials (member_uuid, access_key_hash, created_at, revoked_at)
				 VALUES (?, ?, ?, NULL)
				 ON CONFLICT(member_uuid) DO UPDATE SET access_key_hash = excluded.access_key_hash, revoked_at = NULL`,
				member.MemberID,
				auth.HashSecret(accessKey),
				now,
			); err != nil {
				return domain.Member{}, "", false, err
			}
			if profile.LocalProfileID != "" {
				if _, err = tx.Exec(
					`INSERT INTO member_devices (local_profile_id, member_uuid, access_key_hash, created_at, last_seen_at)
					 VALUES (?, ?, ?, ?, ?)
					 ON CONFLICT(local_profile_id) DO UPDATE SET member_uuid = excluded.member_uuid,
					 access_key_hash = excluded.access_key_hash, last_seen_at = excluded.last_seen_at`,
					profile.LocalProfileID,
					member.MemberID,
					auth.HashSecret(accessKey),
					now,
					now,
				); err != nil {
					return domain.Member{}, "", false, err
				}
			}
			if err = tx.Commit(); err != nil {
				return domain.Member{}, "", false, err
			}
			member.RoleIDs = s.memberRoleIDs(member.MemberID)
			return member, accessKey, member.IsOwner, nil
		}
	}

	memberID, err := auth.NewToken("mem")
	if err != nil {
		return domain.Member{}, "", false, err
	}
	var count int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM members`).Scan(&count); err != nil {
		return domain.Member{}, "", false, err
	}
	member := domain.Member{
		MemberID:           memberID,
		DisplayName:        profile.DisplayName,
		AvatarSHA256:       profile.AvatarSHA256,
		AvatarDataURL:      profile.AvatarDataURL,
		AvatarColor:        profile.AvatarColor,
		Bio:                profile.Bio,
		LocalProfileID:     profile.LocalProfileID,
		IsOwner:            count == 0,
		LastSeenAtMS:       now,
		ProfileUpdatedAtMS: profile.ProfileUpdatedAtMS,
	}
	tx, err := s.db.Begin()
	if err != nil {
		return domain.Member{}, "", false, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.Exec(
		`INSERT INTO members (member_uuid, display_name, avatar_sha256, avatar_data_url, avatar_color, bio, profile_updated_at, local_profile_id, is_owner, created_at, updated_at, last_seen_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		member.MemberID,
		member.DisplayName,
		member.AvatarSHA256,
		member.AvatarDataURL,
		member.AvatarColor,
		member.Bio,
		member.ProfileUpdatedAtMS,
		member.LocalProfileID,
		boolInt(member.IsOwner),
		now,
		now,
		now,
	); err != nil {
		return domain.Member{}, "", false, err
	}
	if _, err = tx.Exec(
		`INSERT INTO member_credentials (member_uuid, access_key_hash, created_at) VALUES (?, ?, ?)`,
		member.MemberID,
		auth.HashSecret(accessKey),
		now,
	); err != nil {
		return domain.Member{}, "", false, err
	}
	if profile.LocalProfileID != "" {
		if _, err = tx.Exec(
			`INSERT INTO member_devices (local_profile_id, member_uuid, access_key_hash, created_at, last_seen_at)
			 VALUES (?, ?, ?, ?, ?)`,
			profile.LocalProfileID,
			member.MemberID,
			auth.HashSecret(accessKey),
			now,
			now,
		); err != nil {
			return domain.Member{}, "", false, err
		}
	}
	if err = tx.Commit(); err != nil {
		return domain.Member{}, "", false, err
	}
	return member, accessKey, member.IsOwner, nil
}

func (s *SQLiteStore) Authenticate(serverID string, memberID string, accessKey string) (domain.Member, bool) {
	if serverID != s.Server().ServerID {
		return domain.Member{}, false
	}
	hash := auth.HashSecret(accessKey)
	member, found, err := s.member(memberID)
	if err != nil {
		return domain.Member{}, false
	}
	if found && !member.IsBanned {
		var matches int
		if err := s.db.QueryRow(
			`SELECT COUNT(*) FROM member_devices WHERE member_uuid = ? AND access_key_hash = ?`,
			memberID,
			hash,
		).Scan(&matches); err == nil && matches > 0 {
			return member, true
		}
		_, legacyHash, ok := s.memberWithCredential(memberID)
		if ok && legacyHash == hash {
			return member, true
		}
	}
	var canonicalMemberID string
	if err := s.db.QueryRow(
		`SELECT member_uuid FROM member_devices WHERE access_key_hash = ? LIMIT 1`,
		hash,
	).Scan(&canonicalMemberID); err != nil {
		return domain.Member{}, false
	}
	member, found, err = s.member(canonicalMemberID)
	return member, err == nil && found && !member.IsBanned
}

func (s *SQLiteStore) Members() []domain.Member {
	rows, err := s.db.Query(
		`SELECT member_uuid, display_name, avatar_sha256, avatar_data_url, avatar_color, bio, profile_updated_at,
		 profile_override_display_name, profile_override_avatar, profile_override_bio, local_profile_id, is_owner, is_banned, last_seen_at
		 FROM members ORDER BY display_name`,
	)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var members []domain.Member
	for rows.Next() {
		var member domain.Member
		var isOwner int
		var isBanned int
		var overrideDisplayName int
		var overrideAvatar int
		var overrideBio int
		if err := rows.Scan(
			&member.MemberID,
			&member.DisplayName,
			&member.AvatarSHA256,
			&member.AvatarDataURL,
			&member.AvatarColor,
			&member.Bio,
			&member.ProfileUpdatedAtMS,
			&overrideDisplayName,
			&overrideAvatar,
			&overrideBio,
			&member.LocalProfileID,
			&isOwner,
			&isBanned,
			&member.LastSeenAtMS,
		); err == nil {
			member.IsOwner = isOwner != 0
			member.IsBanned = isBanned != 0
			member.ProfileOverrides = domain.ProfileOverrides{
				DisplayName: overrideDisplayName != 0,
				Avatar:      overrideAvatar != 0,
				Bio:         overrideBio != 0,
			}
			member.RoleIDs = s.memberRoleIDs(member.MemberID)
			member.LinkedDevices = s.linkedDeviceCount(member.MemberID)
			members = append(members, member)
		}
	}
	return members
}

func (s *SQLiteStore) UpdateMember(memberID string, input domain.Member) (domain.Member, error) {
	member, found, err := s.member(memberID)
	if err != nil {
		return domain.Member{}, err
	}
	if !found {
		return domain.Member{}, ErrNotFound
	}
	if input.DisplayName != "" {
		member.DisplayName = input.DisplayName
	}
	member.AvatarSHA256 = input.AvatarSHA256
	member.AvatarDataURL = input.AvatarDataURL
	member.AvatarColor = input.AvatarColor
	member.Bio = input.Bio
	member.ProfileOverrides = input.ProfileOverrides
	if input.ProfileUpdatedAtMS > 0 {
		member.ProfileUpdatedAtMS = input.ProfileUpdatedAtMS
	}
	member.IsBanned = input.IsBanned
	now := time.Now().UnixMilli()
	tx, err := s.db.Begin()
	if err != nil {
		return domain.Member{}, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.Exec(
		`UPDATE members SET display_name = ?, avatar_sha256 = ?, avatar_data_url = ?, avatar_color = ?, bio = ?, profile_updated_at = ?,
		 profile_override_display_name = ?, profile_override_avatar = ?, profile_override_bio = ?, is_banned = ?, updated_at = ? WHERE member_uuid = ?`,
		member.DisplayName,
		member.AvatarSHA256,
		member.AvatarDataURL,
		member.AvatarColor,
		member.Bio,
		member.ProfileUpdatedAtMS,
		boolInt(member.ProfileOverrides.DisplayName),
		boolInt(member.ProfileOverrides.Avatar),
		boolInt(member.ProfileOverrides.Bio),
		boolInt(member.IsBanned),
		now,
		member.MemberID,
	); err != nil {
		return domain.Member{}, err
	}
	if member.IsBanned {
		if _, err = tx.Exec(`DELETE FROM member_credentials WHERE member_uuid = ?`, member.MemberID); err != nil {
			return domain.Member{}, err
		}
	}
	if err = tx.Commit(); err != nil {
		return domain.Member{}, err
	}
	member.RoleIDs = s.memberRoleIDs(member.MemberID)
	return member, nil
}

func (s *SQLiteStore) TouchMember(memberID string, lastSeenAtMS int64) (domain.Member, error) {
	if lastSeenAtMS <= 0 {
		lastSeenAtMS = time.Now().UnixMilli()
	}
	result, err := s.db.Exec(
		`UPDATE members SET last_seen_at = ?, updated_at = ? WHERE member_uuid = ?`,
		lastSeenAtMS,
		lastSeenAtMS,
		memberID,
	)
	if err != nil {
		return domain.Member{}, err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return domain.Member{}, ErrNotFound
	}
	member, found, err := s.member(memberID)
	if err != nil {
		return domain.Member{}, err
	}
	if !found {
		return domain.Member{}, ErrNotFound
	}
	return member, nil
}

func (s *SQLiteStore) RemoveMember(memberID string) (domain.Member, error) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	member, found, err := s.member(memberID)
	if err != nil {
		return domain.Member{}, err
	}
	if !found {
		return domain.Member{}, ErrNotFound
	}
	if err = s.settleVoiceDurationsLocked(time.Now().UnixMilli(), true); err != nil {
		return domain.Member{}, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return domain.Member{}, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	for _, statement := range []string{
		`DELETE FROM member_devices WHERE member_uuid = ?`,
		`DELETE FROM member_credentials WHERE member_uuid = ?`,
		`DELETE FROM member_roles WHERE member_uuid = ?`,
		`DELETE FROM voice_states WHERE member_uuid = ?`,
		`DELETE FROM voice_member_durations WHERE member_uuid = ?`,
		`DELETE FROM members WHERE member_uuid = ?`,
	} {
		if _, err = tx.Exec(statement, memberID); err != nil {
			return domain.Member{}, err
		}
	}
	if _, err = tx.Exec(
		`DELETE FROM voice_pair_durations WHERE member_a_uuid = ? OR member_b_uuid = ?`,
		memberID,
		memberID,
	); err != nil {
		return domain.Member{}, err
	}
	if err = tx.Commit(); err != nil {
		return domain.Member{}, err
	}
	return member, nil
}

func (s *SQLiteStore) LinkMembers(primaryMemberID string, duplicateMemberID string) (domain.Member, domain.Member, error) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	if primaryMemberID == duplicateMemberID {
		return domain.Member{}, domain.Member{}, ErrSameMember
	}
	primary, primaryFound, err := s.member(primaryMemberID)
	if err != nil {
		return domain.Member{}, domain.Member{}, err
	}
	duplicate, duplicateFound, err := s.member(duplicateMemberID)
	if err != nil {
		return domain.Member{}, domain.Member{}, err
	}
	if !primaryFound || !duplicateFound {
		return domain.Member{}, domain.Member{}, ErrNotFound
	}
	now := time.Now().UnixMilli()
	if err = s.settleVoiceDurationsLocked(now, true); err != nil {
		return domain.Member{}, domain.Member{}, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return domain.Member{}, domain.Member{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.Exec(
		`INSERT OR IGNORE INTO member_roles (member_uuid, role_uuid, created_at)
		 SELECT ?, role_uuid, ? FROM member_roles WHERE member_uuid = ?`,
		primaryMemberID,
		now,
		duplicateMemberID,
	); err != nil {
		return domain.Member{}, domain.Member{}, err
	}
	for _, statement := range []string{
		`UPDATE member_devices SET member_uuid = ? WHERE member_uuid = ?`,
		`UPDATE messages SET author_member_uuid = ? WHERE author_member_uuid = ?`,
		`UPDATE channel_file_entries SET uploader_member_uuid = ? WHERE uploader_member_uuid = ?`,
		`UPDATE audit_logs SET actor_member_uuid = ? WHERE actor_member_uuid = ?`,
	} {
		if _, err = tx.Exec(statement, primaryMemberID, duplicateMemberID); err != nil {
			return domain.Member{}, domain.Member{}, err
		}
	}
	if _, err = tx.Exec(
		`DELETE FROM channel_permission_overrides
		 WHERE target_type = ? AND target_uuid = ? AND channel_uuid IN (
		 SELECT channel_uuid FROM channel_permission_overrides WHERE target_type = ? AND target_uuid = ?
		 )`,
		domain.OverrideTargetMember,
		duplicateMemberID,
		domain.OverrideTargetMember,
		primaryMemberID,
	); err != nil {
		return domain.Member{}, domain.Member{}, err
	}
	if _, err = tx.Exec(
		`UPDATE channel_permission_overrides SET target_uuid = ? WHERE target_type = ? AND target_uuid = ?`,
		primaryMemberID,
		domain.OverrideTargetMember,
		duplicateMemberID,
	); err != nil {
		return domain.Member{}, domain.Member{}, err
	}
	var primaryVoiceCount int
	if err = tx.QueryRow(`SELECT COUNT(*) FROM voice_states WHERE member_uuid = ?`, primaryMemberID).Scan(&primaryVoiceCount); err != nil {
		return domain.Member{}, domain.Member{}, err
	}
	if primaryVoiceCount > 0 {
		if _, err = tx.Exec(`DELETE FROM voice_states WHERE member_uuid = ?`, duplicateMemberID); err != nil {
			return domain.Member{}, domain.Member{}, err
		}
	} else if _, err = tx.Exec(`UPDATE voice_states SET member_uuid = ? WHERE member_uuid = ?`, primaryMemberID, duplicateMemberID); err != nil {
		return domain.Member{}, domain.Member{}, err
	}
	if err = mergeSQLiteVoiceDurations(tx, primaryMemberID, duplicateMemberID); err != nil {
		return domain.Member{}, domain.Member{}, err
	}
	if duplicate.IsOwner {
		if _, err = tx.Exec(`UPDATE members SET is_owner = 0, updated_at = ?`, now); err != nil {
			return domain.Member{}, domain.Member{}, err
		}
		if _, err = tx.Exec(`UPDATE members SET is_owner = 1, updated_at = ? WHERE member_uuid = ?`, now, primaryMemberID); err != nil {
			return domain.Member{}, domain.Member{}, err
		}
	}
	for _, statement := range []string{
		`DELETE FROM member_credentials WHERE member_uuid = ?`,
		`DELETE FROM member_roles WHERE member_uuid = ?`,
		`DELETE FROM members WHERE member_uuid = ?`,
	} {
		if _, err = tx.Exec(statement, duplicateMemberID); err != nil {
			return domain.Member{}, domain.Member{}, err
		}
	}
	if _, err = tx.Exec(
		`UPDATE members SET last_seen_at = MAX(last_seen_at, ?), updated_at = ? WHERE member_uuid = ?`,
		duplicate.LastSeenAtMS,
		now,
		primaryMemberID,
	); err != nil {
		return domain.Member{}, domain.Member{}, err
	}
	if err = tx.Commit(); err != nil {
		return domain.Member{}, domain.Member{}, err
	}
	s.shareMu.Lock()
	for shareID, share := range s.screenShareSessions {
		if share.OwnerMemberID == duplicateMemberID {
			share.OwnerMemberID = primaryMemberID
		}
		viewerSet := make(map[string]bool, len(share.ViewerMemberIDs))
		viewers := make([]string, 0, len(share.ViewerMemberIDs))
		for _, viewerID := range share.ViewerMemberIDs {
			if viewerID == duplicateMemberID {
				viewerID = primaryMemberID
			}
			if !viewerSet[viewerID] {
				viewerSet[viewerID] = true
				viewers = append(viewers, viewerID)
			}
		}
		share.ViewerMemberIDs = viewers
		s.screenShareSessions[shareID] = share
	}
	s.shareMu.Unlock()
	linked, found, err := s.member(primaryMemberID)
	if err != nil {
		return domain.Member{}, domain.Member{}, err
	}
	if !found {
		return domain.Member{}, domain.Member{}, ErrNotFound
	}
	linked.IsOwner = linked.IsOwner || primary.IsOwner
	return linked, duplicate, nil
}

func (s *SQLiteStore) SaveMemberMergeCode(input domain.MemberMergeCode) error {
	if input.TargetMemberID == "" || input.CodeHash == "" || input.ExpiresAtMS <= input.CreatedAtMS {
		return ErrMemberMergeCodeInvalid
	}
	s.memberMergeMu.Lock()
	defer s.memberMergeMu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err = cleanupSQLiteMemberMerge(tx, time.Now().UnixMilli()); err != nil {
		return err
	}
	var banned int
	if err = tx.QueryRow(`SELECT is_banned FROM members WHERE member_uuid = ?`, input.TargetMemberID).Scan(&banned); errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	} else if banned != 0 {
		return ErrNotFound
	}
	if _, err = tx.Exec(`DELETE FROM member_merge_codes WHERE target_member_uuid = ?`, input.TargetMemberID); err != nil {
		return err
	}
	if _, err = tx.Exec(
		`INSERT INTO member_merge_codes (target_member_uuid, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?)`,
		input.TargetMemberID,
		input.CodeHash,
		input.ExpiresAtMS,
		input.CreatedAtMS,
	); err != nil {
		return ErrAlreadyExists
	}
	return tx.Commit()
}

func (s *SQLiteStore) CreateMemberMergeRequestFromCode(
	input domain.MemberMergeRequest,
	codeHash string,
	nowMS int64,
) (domain.MemberMergeRequest, error) {
	if input.RequestID == "" || input.RequesterMemberID == "" || codeHash == "" || input.ExpiresAtMS <= nowMS {
		return domain.MemberMergeRequest{}, ErrMemberMergeRequestInvalid
	}
	s.memberMergeMu.Lock()
	defer s.memberMergeMu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return domain.MemberMergeRequest{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if err = cleanupSQLiteMemberMerge(tx, nowMS); err != nil {
		return domain.MemberMergeRequest{}, err
	}
	var targetMemberID string
	if err = tx.QueryRow(
		`SELECT target_member_uuid FROM member_merge_codes WHERE code_hash = ? AND expires_at > ?`,
		codeHash,
		nowMS,
	).Scan(&targetMemberID); errors.Is(err, sql.ErrNoRows) {
		return domain.MemberMergeRequest{}, ErrMemberMergeCodeInvalid
	} else if err != nil {
		return domain.MemberMergeRequest{}, err
	}
	if targetMemberID == input.RequesterMemberID {
		return domain.MemberMergeRequest{}, ErrSameMember
	}
	var eligibleMembers int
	if err = tx.QueryRow(
		`SELECT COUNT(*) FROM members WHERE member_uuid IN (?, ?) AND is_banned = 0`,
		targetMemberID,
		input.RequesterMemberID,
	).Scan(&eligibleMembers); err != nil {
		return domain.MemberMergeRequest{}, err
	}
	if eligibleMembers != 2 {
		return domain.MemberMergeRequest{}, ErrNotFound
	}
	var existingRequestID string
	err = tx.QueryRow(
		`SELECT request_uuid FROM member_merge_requests
		 WHERE requester_member_uuid = ? AND status = ? AND expires_at > ? LIMIT 1`,
		input.RequesterMemberID,
		domain.MemberMergePending,
		nowMS,
	).Scan(&existingRequestID)
	if err == nil {
		return domain.MemberMergeRequest{}, ErrAlreadyExists
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return domain.MemberMergeRequest{}, err
	}
	result, err := tx.Exec(
		`DELETE FROM member_merge_codes WHERE target_member_uuid = ? AND code_hash = ? AND expires_at > ?`,
		targetMemberID,
		codeHash,
		nowMS,
	)
	if err != nil {
		return domain.MemberMergeRequest{}, err
	}
	if affected, affectedErr := result.RowsAffected(); affectedErr != nil || affected != 1 {
		return domain.MemberMergeRequest{}, ErrMemberMergeCodeInvalid
	}
	input.TargetMemberID = targetMemberID
	input.Status = domain.MemberMergePending
	if _, err = tx.Exec(
		`INSERT INTO member_merge_requests
		 (request_uuid, target_member_uuid, requester_member_uuid, status, created_at, expires_at, resolved_at)
		 VALUES (?, ?, ?, ?, ?, ?, 0)`,
		input.RequestID,
		input.TargetMemberID,
		input.RequesterMemberID,
		input.Status,
		input.CreatedAtMS,
		input.ExpiresAtMS,
	); err != nil {
		return domain.MemberMergeRequest{}, err
	}
	if err = tx.Commit(); err != nil {
		return domain.MemberMergeRequest{}, err
	}
	request, found, err := s.hydrateMemberMergeRequest(input)
	if err != nil {
		return domain.MemberMergeRequest{}, err
	}
	if !found {
		return domain.MemberMergeRequest{}, ErrNotFound
	}
	return request, nil
}

func (s *SQLiteStore) MemberMergeRequests(memberID string, nowMS int64) []domain.MemberMergeRequest {
	s.memberMergeMu.Lock()
	defer s.memberMergeMu.Unlock()
	if _, err := s.db.Exec(
		`UPDATE member_merge_requests SET status = ?, resolved_at = ?
		 WHERE status = ? AND expires_at <= ?`,
		domain.MemberMergeExpired,
		nowMS,
		domain.MemberMergePending,
		nowMS,
	); err != nil {
		return nil
	}
	rows, err := s.db.Query(
		`SELECT request_uuid, target_member_uuid, requester_member_uuid, status, created_at, expires_at, resolved_at
		 FROM member_merge_requests
		 WHERE status = ? AND expires_at > ? AND (target_member_uuid = ? OR requester_member_uuid = ?)
		 ORDER BY created_at, request_uuid`,
		domain.MemberMergePending,
		nowMS,
		memberID,
		memberID,
	)
	if err != nil {
		return nil
	}
	requests := make([]domain.MemberMergeRequest, 0)
	for rows.Next() {
		request, scanErr := scanMemberMergeRequest(rows)
		if scanErr != nil {
			_ = rows.Close()
			return nil
		}
		requests = append(requests, request)
	}
	if err = rows.Close(); err != nil {
		return nil
	}
	items := make([]domain.MemberMergeRequest, 0, len(requests))
	for _, request := range requests {
		item, found, hydrateErr := s.hydrateMemberMergeRequest(request)
		if hydrateErr != nil {
			return nil
		}
		if found {
			items = append(items, item)
		}
	}
	return items
}

func (s *SQLiteStore) MemberMergeRequest(requestID string, nowMS int64) (domain.MemberMergeRequest, error) {
	s.memberMergeMu.Lock()
	defer s.memberMergeMu.Unlock()
	request, err := scanMemberMergeRequest(s.db.QueryRow(
		`SELECT request_uuid, target_member_uuid, requester_member_uuid, status, created_at, expires_at, resolved_at
		 FROM member_merge_requests WHERE request_uuid = ? AND status = ? AND expires_at > ?`,
		requestID,
		domain.MemberMergePending,
		nowMS,
	))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.MemberMergeRequest{}, ErrMemberMergeRequestInvalid
	}
	if err != nil {
		return domain.MemberMergeRequest{}, err
	}
	request, found, err := s.hydrateMemberMergeRequest(request)
	if err != nil {
		return domain.MemberMergeRequest{}, err
	}
	if !found {
		return domain.MemberMergeRequest{}, ErrMemberMergeRequestInvalid
	}
	return request, nil
}

func (s *SQLiteStore) ResolveMemberMergeRequest(
	requestID string,
	targetMemberID string,
	status domain.MemberMergeRequestStatus,
	resolvedAtMS int64,
) (domain.MemberMergeRequest, error) {
	if status != domain.MemberMergeAccepted && status != domain.MemberMergeRejected {
		return domain.MemberMergeRequest{}, ErrMemberMergeRequestInvalid
	}
	s.memberMergeMu.Lock()
	defer s.memberMergeMu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return domain.MemberMergeRequest{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if err = cleanupSQLiteMemberMerge(tx, resolvedAtMS); err != nil {
		return domain.MemberMergeRequest{}, err
	}
	result, err := tx.Exec(
		`UPDATE member_merge_requests SET status = ?, resolved_at = ?
		 WHERE request_uuid = ? AND target_member_uuid = ? AND status = ? AND expires_at > ?`,
		status,
		resolvedAtMS,
		requestID,
		targetMemberID,
		domain.MemberMergePending,
		resolvedAtMS,
	)
	if err != nil {
		return domain.MemberMergeRequest{}, err
	}
	if affected, affectedErr := result.RowsAffected(); affectedErr != nil || affected != 1 {
		return domain.MemberMergeRequest{}, ErrMemberMergeRequestInvalid
	}
	request, err := scanMemberMergeRequest(tx.QueryRow(
		`SELECT request_uuid, target_member_uuid, requester_member_uuid, status, created_at, expires_at, resolved_at
		 FROM member_merge_requests WHERE request_uuid = ?`,
		requestID,
	))
	if err != nil {
		return domain.MemberMergeRequest{}, err
	}
	if status == domain.MemberMergeAccepted {
		if _, err = tx.Exec(
			`UPDATE member_merge_requests SET status = ?, resolved_at = ?
			 WHERE request_uuid != ? AND status = ? AND (
			 target_member_uuid IN (?, ?) OR requester_member_uuid IN (?, ?))`,
			domain.MemberMergeCancelled,
			resolvedAtMS,
			requestID,
			domain.MemberMergePending,
			request.TargetMemberID,
			request.RequesterMemberID,
			request.TargetMemberID,
			request.RequesterMemberID,
		); err != nil {
			return domain.MemberMergeRequest{}, err
		}
		if _, err = tx.Exec(
			`DELETE FROM member_merge_codes WHERE target_member_uuid IN (?, ?)`,
			request.TargetMemberID,
			request.RequesterMemberID,
		); err != nil {
			return domain.MemberMergeRequest{}, err
		}
	}
	if err = tx.Commit(); err != nil {
		return domain.MemberMergeRequest{}, err
	}
	request, _, err = s.hydrateMemberMergeRequest(request)
	return request, err
}

type memberMergeRowScanner interface {
	Scan(dest ...any) error
}

func scanMemberMergeRequest(scanner memberMergeRowScanner) (domain.MemberMergeRequest, error) {
	var request domain.MemberMergeRequest
	err := scanner.Scan(
		&request.RequestID,
		&request.TargetMemberID,
		&request.RequesterMemberID,
		&request.Status,
		&request.CreatedAtMS,
		&request.ExpiresAtMS,
		&request.ResolvedAtMS,
	)
	return request, err
}

func cleanupSQLiteMemberMerge(tx *sql.Tx, nowMS int64) error {
	if _, err := tx.Exec(`DELETE FROM member_merge_codes WHERE expires_at <= ?`, nowMS); err != nil {
		return err
	}
	_, err := tx.Exec(
		`UPDATE member_merge_requests SET status = ?, resolved_at = ? WHERE status = ? AND expires_at <= ?`,
		domain.MemberMergeExpired,
		nowMS,
		domain.MemberMergePending,
		nowMS,
	)
	return err
}

func (s *SQLiteStore) hydrateMemberMergeRequest(request domain.MemberMergeRequest) (domain.MemberMergeRequest, bool, error) {
	requester, requesterFound, err := s.member(request.RequesterMemberID)
	if err != nil {
		return domain.MemberMergeRequest{}, false, err
	}
	target, targetFound, err := s.member(request.TargetMemberID)
	if err != nil {
		return domain.MemberMergeRequest{}, false, err
	}
	if !requesterFound || !targetFound {
		return request, false, nil
	}
	request.Requester = requester
	request.Target = target
	return request, true, nil
}

func (s *SQLiteStore) ClaimOwner(memberID string) (domain.Member, error) {
	var exists int
	if err := s.db.QueryRow(`SELECT 1 FROM members WHERE member_uuid = ?`, memberID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
		return domain.Member{}, ErrNotFound
	} else if err != nil {
		return domain.Member{}, err
	}

	now := time.Now().UnixMilli()
	tx, err := s.db.Begin()
	if err != nil {
		return domain.Member{}, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.Exec(`UPDATE members SET is_owner = 0, updated_at = ? WHERE member_uuid != ?`, now, memberID); err != nil {
		return domain.Member{}, err
	}
	if _, err = tx.Exec(`UPDATE members SET is_owner = 1, updated_at = ? WHERE member_uuid = ?`, now, memberID); err != nil {
		return domain.Member{}, err
	}
	if err = tx.Commit(); err != nil {
		return domain.Member{}, err
	}
	for _, member := range s.Members() {
		if member.MemberID == memberID {
			return member, nil
		}
	}
	return domain.Member{}, ErrNotFound
}

func (s *SQLiteStore) Roles() []domain.ServerRole {
	rows, err := s.db.Query(
		`SELECT role_uuid, name, color, gradient_color, icon_data_url, display_separately, position, is_everyone
		 FROM roles ORDER BY position, role_uuid`,
	)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var roles []domain.ServerRole
	for rows.Next() {
		var role domain.ServerRole
		var isEveryone int
		var displaySeparately int
		if err := rows.Scan(
			&role.RoleID,
			&role.Name,
			&role.Color,
			&role.GradientColor,
			&role.IconDataURL,
			&displaySeparately,
			&role.Position,
			&isEveryone,
		); err == nil {
			role.IsEveryone = isEveryone != 0
			role.DisplaySeparately = displaySeparately != 0
			role.MemberCount = s.roleMemberCount(role)
			role.Permissions = s.rolePermissions(role.RoleID)
			roles = append(roles, role)
		}
	}
	return roles
}

func (s *SQLiteStore) CreateRole(input domain.ServerRole) (domain.ServerRole, error) {
	roleID, err := auth.NewToken("role")
	if err != nil {
		return domain.ServerRole{}, err
	}
	if input.Position <= 0 {
		_ = s.db.QueryRow(`SELECT COALESCE(MAX(position), 0) + 1000 FROM roles`).Scan(&input.Position)
	}
	now := time.Now().UnixMilli()
	input.RoleID = roleID
	input.IsEveryone = false
	if input.Name == "" {
		input.Name = "New Role"
	}
	input.Permissions = normalizedPermissions(input.Permissions)

	tx, err := s.db.Begin()
	if err != nil {
		return domain.ServerRole{}, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.Exec(
		`INSERT INTO roles (role_uuid, name, color, gradient_color, icon_data_url, display_separately, position, is_everyone, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
		input.RoleID,
		input.Name,
		input.Color,
		input.GradientColor,
		input.IconDataURL,
		boolInt(input.DisplaySeparately),
		input.Position,
		now,
		now,
	); err != nil {
		return domain.ServerRole{}, err
	}
	if err = s.replaceRolePermissions(tx, input.RoleID, input.Permissions); err != nil {
		return domain.ServerRole{}, err
	}
	if err = tx.Commit(); err != nil {
		return domain.ServerRole{}, err
	}
	return input, nil
}

func (s *SQLiteStore) UpdateRole(roleID string, input domain.ServerRole) (domain.ServerRole, error) {
	role, err := s.role(roleID)
	if err != nil {
		return domain.ServerRole{}, err
	}
	if !role.IsEveryone {
		if input.Name != "" {
			role.Name = input.Name
		}
		role.Color = input.Color
		role.GradientColor = input.GradientColor
		role.IconDataURL = input.IconDataURL
		role.DisplaySeparately = input.DisplaySeparately
		if input.Position > 0 {
			role.Position = input.Position
		}
	}
	role.Permissions = normalizedPermissions(input.Permissions)

	tx, err := s.db.Begin()
	if err != nil {
		return domain.ServerRole{}, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.Exec(
		`UPDATE roles SET name = ?, color = ?, gradient_color = ?, icon_data_url = ?, display_separately = ?, position = ?, updated_at = ? WHERE role_uuid = ?`,
		role.Name,
		role.Color,
		role.GradientColor,
		role.IconDataURL,
		boolInt(role.DisplaySeparately),
		role.Position,
		time.Now().UnixMilli(),
		role.RoleID,
	); err != nil {
		return domain.ServerRole{}, err
	}
	if err = s.replaceRolePermissions(tx, role.RoleID, role.Permissions); err != nil {
		return domain.ServerRole{}, err
	}
	if err = tx.Commit(); err != nil {
		return domain.ServerRole{}, err
	}
	return role, nil
}

func (s *SQLiteStore) ReorderRoles(items []domain.RoleOrderItem) ([]domain.ServerRole, error) {
	roles := s.Roles()
	customCount := 0
	customByID := make(map[string]domain.ServerRole, len(roles))
	for _, role := range roles {
		if role.IsEveryone {
			continue
		}
		customCount++
		customByID[role.RoleID] = role
	}
	if len(items) != customCount {
		return nil, ErrInvalidRoleOrder
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	seen := make(map[string]bool, len(items))
	now := time.Now().UnixMilli()
	for index, item := range items {
		if _, ok := customByID[item.RoleID]; !ok || seen[item.RoleID] {
			return nil, ErrInvalidRoleOrder
		}
		seen[item.RoleID] = true
		position := (len(items) - index) * 1000
		if _, err = tx.Exec(`UPDATE roles SET position = ?, updated_at = ? WHERE role_uuid = ?`, position, now, item.RoleID); err != nil {
			return nil, err
		}
	}
	if len(seen) != customCount {
		return nil, ErrInvalidRoleOrder
	}
	if _, err = tx.Exec(`UPDATE roles SET position = 0, updated_at = ? WHERE role_uuid = ?`, now, domain.EveryoneRoleID); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return s.Roles(), nil
}

func (s *SQLiteStore) DeleteRole(roleID string) (domain.ServerRole, error) {
	role, err := s.role(roleID)
	if err != nil {
		return domain.ServerRole{}, err
	}
	if role.IsEveryone {
		return domain.ServerRole{}, ErrNotFound
	}
	tx, err := s.db.Begin()
	if err != nil {
		return domain.ServerRole{}, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.Exec(`DELETE FROM member_roles WHERE role_uuid = ?`, roleID); err != nil {
		return domain.ServerRole{}, err
	}
	if _, err = tx.Exec(`DELETE FROM role_permissions WHERE role_uuid = ?`, roleID); err != nil {
		return domain.ServerRole{}, err
	}
	if _, err = tx.Exec(`DELETE FROM roles WHERE role_uuid = ?`, roleID); err != nil {
		return domain.ServerRole{}, err
	}
	if err = tx.Commit(); err != nil {
		return domain.ServerRole{}, err
	}
	return role, nil
}

func (s *SQLiteStore) SetMemberRoles(memberID string, roleIDs []string) (domain.Member, error) {
	member, found, err := s.member(memberID)
	if err != nil {
		return domain.Member{}, err
	}
	if !found {
		return domain.Member{}, ErrNotFound
	}
	now := time.Now().UnixMilli()
	tx, err := s.db.Begin()
	if err != nil {
		return domain.Member{}, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.Exec(`DELETE FROM member_roles WHERE member_uuid = ?`, memberID); err != nil {
		return domain.Member{}, err
	}
	seen := make(map[string]bool, len(roleIDs))
	for _, roleID := range roleIDs {
		role, err := s.role(roleID)
		if errors.Is(err, ErrNotFound) || role.IsEveryone || seen[roleID] {
			continue
		}
		if err != nil {
			return domain.Member{}, err
		}
		if _, err = tx.Exec(
			`INSERT INTO member_roles (member_uuid, role_uuid, created_at) VALUES (?, ?, ?)`,
			memberID,
			roleID,
			now,
		); err != nil {
			return domain.Member{}, err
		}
		seen[roleID] = true
	}
	if err = tx.Commit(); err != nil {
		return domain.Member{}, err
	}
	member.RoleIDs = s.memberRoleIDs(member.MemberID)
	return member, nil
}

func (s *SQLiteStore) MemberHasPermission(memberID string, permission domain.Permission) bool {
	member, found, err := s.member(memberID)
	if err != nil || !found {
		return false
	}
	if member.IsBanned {
		return false
	}
	if member.IsOwner {
		return true
	}
	if s.roleAllows(domain.EveryoneRoleID, domain.PermissionAdministrator) || s.roleAllows(domain.EveryoneRoleID, permission) {
		return true
	}
	for _, roleID := range member.RoleIDs {
		if s.roleAllows(roleID, domain.PermissionAdministrator) || s.roleAllows(roleID, permission) {
			return true
		}
	}
	return false
}

func (s *SQLiteStore) MemberHasChannelPermission(memberID string, channelID string, permission domain.Permission) bool {
	member, found, err := s.member(memberID)
	if err != nil || !found || member.IsBanned {
		return false
	}
	if member.IsOwner {
		return true
	}
	if s.MemberHasPermission(memberID, domain.PermissionAdministrator) {
		return true
	}
	allowed := s.MemberHasPermission(memberID, permission)
	channel, err := s.channel(channelID)
	if err != nil {
		return false
	}
	if channel.ParentID != "" && channel.PermissionSynced {
		allowed = applyChannelOverrides(allowed, member, s.ChannelPermissionOverrides(channel.ParentID), permission)
	}
	return applyChannelOverrides(allowed, member, s.ChannelPermissionOverrides(channelID), permission)
}

func applyChannelOverrides(
	allowed bool,
	member domain.Member,
	overrides []domain.ChannelPermissionOverride,
	permission domain.Permission,
) bool {
	overrideMap := make(map[string]domain.ChannelPermissionOverride, len(overrides))
	for _, override := range overrides {
		overrideMap[override.OverrideID] = override
	}
	if override, ok := overrideForTarget(overrideMap, domain.OverrideTargetRole, domain.EveryoneRoleID); ok {
		allowed = applyPermissionOverride(allowed, override, permission)
	}
	for _, roleID := range member.RoleIDs {
		if override, ok := overrideForTarget(overrideMap, domain.OverrideTargetRole, roleID); ok {
			allowed = applyPermissionOverride(allowed, override, permission)
		}
	}
	if override, ok := overrideForTarget(overrideMap, domain.OverrideTargetMember, member.MemberID); ok {
		allowed = applyPermissionOverride(allowed, override, permission)
	}
	return allowed
}

func (s *SQLiteStore) Channels() []domain.Channel {
	rows, err := s.db.Query(
		`SELECT channel_uuid, parent_uuid, type, name, topic, visibility, warning_text, bitrate, user_limit,
		 permission_synced, position, default_language, localizations_json FROM channels ORDER BY position, channel_uuid`,
	)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var channels []domain.Channel
	for rows.Next() {
		var channel domain.Channel
		var kind string
		var permissionSynced int
		var localizationsJSON string
		if err := rows.Scan(
			&channel.ChannelID,
			&channel.ParentID,
			&kind,
			&channel.Name,
			&channel.Topic,
			&channel.Visibility,
			&channel.WarningText,
			&channel.Bitrate,
			&channel.UserLimit,
			&permissionSynced,
			&channel.Position,
			&channel.DefaultLanguage,
			&localizationsJSON,
		); err == nil {
			channel.Type = domain.ChannelType(kind)
			channel.PermissionSynced = permissionSynced != 0
			channel.Localizations = decodeChannelLocalizations(localizationsJSON)
			channels = append(channels, channel)
		}
	}
	sort.Slice(channels, func(i, j int) bool {
		if channels[i].Position != channels[j].Position {
			return channels[i].Position < channels[j].Position
		}
		return channels[i].ChannelID < channels[j].ChannelID
	})
	return channels
}

func (s *SQLiteStore) CreateChannel(input domain.Channel) (domain.Channel, error) {
	channelID, err := auth.NewToken("ch")
	if err != nil {
		return domain.Channel{}, err
	}
	var position int
	_ = s.db.QueryRow(`SELECT COALESCE(MAX(position), 0) + 1000 FROM channels WHERE parent_uuid = ?`, input.ParentID).Scan(&position)
	now := time.Now().UnixMilli()
	input.ChannelID = channelID
	input.Position = position
	if input.Visibility == "" {
		input.Visibility = "default"
	}
	if input.Type == domain.ChannelTypeVoice && input.Bitrate <= 0 {
		input.Bitrate = 64000
	}
	if input.ParentID != "" {
		input.PermissionSynced = true
	}
	_, err = s.db.Exec(
		`INSERT INTO channels (channel_uuid, parent_uuid, type, name, topic, visibility, warning_text, bitrate, user_limit,
		 permission_synced, position, default_language, localizations_json, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		input.ChannelID,
		input.ParentID,
		input.Type,
		input.Name,
		input.Topic,
		input.Visibility,
		input.WarningText,
		input.Bitrate,
		input.UserLimit,
		boolInt(input.PermissionSynced),
		input.Position,
		strings.TrimSpace(input.DefaultLanguage),
		encodeChannelLocalizations(input.Localizations),
		now,
		now,
	)
	if err != nil {
		return domain.Channel{}, err
	}
	return input, nil
}

func (s *SQLiteStore) UpdateChannel(channelID string, input domain.Channel) (domain.Channel, error) {
	channel, err := s.channel(channelID)
	if err != nil {
		return domain.Channel{}, err
	}
	if input.Name != "" {
		channel.Name = input.Name
	}
	channel.ParentID = input.ParentID
	channel.Topic = input.Topic
	channel.Visibility = input.Visibility
	channel.WarningText = input.WarningText
	channel.Bitrate = input.Bitrate
	channel.UserLimit = input.UserLimit
	channel.PermissionSynced = input.PermissionSynced
	channel.Position = input.Position
	channel.DefaultLanguage = strings.TrimSpace(input.DefaultLanguage)
	channel.Localizations = normalizeChannelLocalizations(input.Localizations)
	_, err = s.db.Exec(
		`UPDATE channels SET parent_uuid = ?, name = ?, topic = ?, visibility = ?, warning_text = ?, bitrate = ?,
		 user_limit = ?, permission_synced = ?, position = ?, default_language = ?, localizations_json = ?, updated_at = ? WHERE channel_uuid = ?`,
		channel.ParentID,
		channel.Name,
		channel.Topic,
		channel.Visibility,
		channel.WarningText,
		channel.Bitrate,
		channel.UserLimit,
		boolInt(channel.PermissionSynced),
		channel.Position,
		channel.DefaultLanguage,
		encodeChannelLocalizations(channel.Localizations),
		time.Now().UnixMilli(),
		channelID,
	)
	if err != nil {
		return domain.Channel{}, err
	}
	return channel, nil
}

func (s *SQLiteStore) ReorderChannels(items []domain.ChannelOrderItem) ([]domain.Channel, error) {
	existing := s.Channels()
	if len(items) != len(existing) {
		return nil, ErrInvalidChannelOrder
	}

	byID := make(map[string]domain.Channel, len(existing))
	categoryIDs := make(map[string]bool)
	for _, channel := range existing {
		byID[channel.ChannelID] = channel
		if channel.Type == domain.ChannelTypeCategory {
			categoryIDs[channel.ChannelID] = true
		}
	}

	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.Prepare(`UPDATE channels SET parent_uuid = ?, permission_synced = ?, position = ?, updated_at = ? WHERE channel_uuid = ?`)
	if err != nil {
		return nil, err
	}
	defer stmt.Close()

	seen := make(map[string]bool, len(items))
	nextPositionByParent := make(map[string]int)
	now := time.Now().UnixMilli()
	for _, item := range items {
		channel, ok := byID[item.ChannelID]
		if !ok || seen[item.ChannelID] {
			return nil, ErrInvalidChannelOrder
		}
		seen[item.ChannelID] = true

		parentID := item.ParentID
		if channel.Type == domain.ChannelTypeCategory {
			if parentID != "" {
				return nil, ErrInvalidChannelOrder
			}
			parentID = ""
		} else if parentID != "" && !categoryIDs[parentID] {
			return nil, ErrInvalidChannelOrder
		}

		nextPositionByParent[parentID] += 1000
		permissionSynced := channel.PermissionSynced
		if channel.ParentID != parentID {
			permissionSynced = parentID != ""
		}
		if _, err = stmt.Exec(parentID, boolInt(permissionSynced), nextPositionByParent[parentID], now, channel.ChannelID); err != nil {
			return nil, err
		}
	}
	if len(seen) != len(existing) {
		return nil, ErrInvalidChannelOrder
	}

	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return s.Channels(), nil
}

func (s *SQLiteStore) DeleteChannel(channelID string) (domain.Channel, error) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	channel, err := s.channel(channelID)
	if err != nil {
		return domain.Channel{}, err
	}
	if err = s.settleVoiceDurationsLocked(time.Now().UnixMilli(), true); err != nil {
		return domain.Channel{}, err
	}
	existing := s.Channels()
	tx, err := s.db.Begin()
	if err != nil {
		return domain.Channel{}, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.Exec(
		`DELETE FROM voice_states WHERE channel_uuid = ?`,
		channelID,
	); err != nil {
		return domain.Channel{}, err
	}
	if _, err = tx.Exec(
		`DELETE FROM messages WHERE channel_uuid = ?`,
		channelID,
	); err != nil {
		return domain.Channel{}, err
	}
	if _, err = tx.Exec(
		`DELETE FROM channel_message_images WHERE channel_uuid = ?`,
		channelID,
	); err != nil {
		return domain.Channel{}, err
	}
	if _, err = tx.Exec(
		`DELETE FROM channel_file_entries WHERE channel_uuid = ?`,
		channelID,
	); err != nil {
		return domain.Channel{}, err
	}
	if _, err = tx.Exec(
		`DELETE FROM channel_permission_overrides WHERE channel_uuid = ?`,
		channelID,
	); err != nil {
		return domain.Channel{}, err
	}
	if _, err = tx.Exec(
		`DELETE FROM channels WHERE channel_uuid = ?`,
		channelID,
	); err != nil {
		return domain.Channel{}, err
	}
	if channel.Type == domain.ChannelTypeCategory {
		topLevel := make([]domain.Channel, 0)
		children := make([]domain.Channel, 0)
		for _, item := range existing {
			if item.ParentID == channelID {
				children = append(children, item)
			}
		}
		for _, item := range existing {
			if item.ChannelID == channelID {
				topLevel = append(topLevel, children...)
				continue
			}
			if item.ParentID == "" || item.Type == domain.ChannelTypeCategory {
				topLevel = append(topLevel, item)
			}
		}
		stmt, err := tx.Prepare(`UPDATE channels SET parent_uuid = '', position = ?, updated_at = ? WHERE channel_uuid = ?`)
		if err != nil {
			return domain.Channel{}, err
		}
		defer stmt.Close()
		now := time.Now().UnixMilli()
		for index, item := range topLevel {
			if item.ChannelID == channelID {
				continue
			}
			if _, err = stmt.Exec((index+1)*1000, now, item.ChannelID); err != nil {
				return domain.Channel{}, err
			}
		}
	}
	if err = tx.Commit(); err != nil {
		return domain.Channel{}, err
	}
	return channel, nil
}

func (s *SQLiteStore) ChannelPermissionOverrides(channelID string) []domain.ChannelPermissionOverride {
	rows, err := s.db.Query(
		`SELECT override_uuid, channel_uuid, target_type, target_uuid, allow_permissions, deny_permissions
		 FROM channel_permission_overrides WHERE channel_uuid = ? ORDER BY target_type, target_uuid`,
		channelID,
	)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var overrides []domain.ChannelPermissionOverride
	for rows.Next() {
		var override domain.ChannelPermissionOverride
		var targetType string
		var allowsRaw string
		var deniesRaw string
		if err := rows.Scan(
			&override.OverrideID,
			&override.ChannelID,
			&targetType,
			&override.TargetID,
			&allowsRaw,
			&deniesRaw,
		); err == nil {
			override.TargetType = domain.ChannelPermissionOverrideTarget(targetType)
			override.Allows = decodePermissionMap(allowsRaw)
			override.Denies = decodePermissionMap(deniesRaw)
			overrides = append(overrides, override)
		}
	}
	return overrides
}

func (s *SQLiteStore) SetChannelPermissionOverride(
	input domain.ChannelPermissionOverride,
) (domain.ChannelPermissionOverride, error) {
	if !s.channelExists(input.ChannelID) {
		return domain.ChannelPermissionOverride{}, ErrNotFound
	}
	if input.TargetType != domain.OverrideTargetRole && input.TargetType != domain.OverrideTargetMember {
		return domain.ChannelPermissionOverride{}, ErrNotFound
	}
	if input.TargetID == "" {
		return domain.ChannelPermissionOverride{}, ErrNotFound
	}
	if input.TargetType == domain.OverrideTargetRole {
		if _, err := s.role(input.TargetID); err != nil {
			return domain.ChannelPermissionOverride{}, err
		}
	}
	if input.TargetType == domain.OverrideTargetMember {
		if _, found, err := s.member(input.TargetID); err != nil {
			return domain.ChannelPermissionOverride{}, err
		} else if !found {
			return domain.ChannelPermissionOverride{}, ErrNotFound
		}
	}
	if input.OverrideID == "" {
		for _, override := range s.ChannelPermissionOverrides(input.ChannelID) {
			if override.TargetType == input.TargetType && override.TargetID == input.TargetID {
				input.OverrideID = override.OverrideID
				break
			}
		}
	}
	if input.OverrideID == "" {
		overrideID, err := auth.NewToken("ovr")
		if err != nil {
			return domain.ChannelPermissionOverride{}, err
		}
		input.OverrideID = overrideID
	}
	input.Allows = normalizedPermissions(input.Allows)
	input.Denies = normalizedPermissions(input.Denies)
	now := time.Now().UnixMilli()
	_, err := s.db.Exec(
		`INSERT INTO channel_permission_overrides
		 (override_uuid, channel_uuid, target_type, target_uuid, allow_permissions, deny_permissions, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(channel_uuid, target_type, target_uuid)
		 DO UPDATE SET allow_permissions = excluded.allow_permissions,
		 deny_permissions = excluded.deny_permissions,
		 updated_at = excluded.updated_at`,
		input.OverrideID,
		input.ChannelID,
		input.TargetType,
		input.TargetID,
		encodePermissionMap(input.Allows),
		encodePermissionMap(input.Denies),
		now,
		now,
	)
	if err != nil {
		return domain.ChannelPermissionOverride{}, err
	}
	if channel, channelErr := s.channel(input.ChannelID); channelErr == nil && channel.ParentID != "" && channel.PermissionSynced {
		_, _ = s.db.Exec(`UPDATE channels SET permission_synced = 0, updated_at = ? WHERE channel_uuid = ?`, now, input.ChannelID)
	}
	for _, override := range s.ChannelPermissionOverrides(input.ChannelID) {
		if override.TargetType == input.TargetType && override.TargetID == input.TargetID {
			return override, nil
		}
	}
	return cloneChannelPermissionOverride(input), nil
}

func (s *SQLiteStore) DeleteChannelPermissionOverride(
	channelID string,
	overrideID string,
) (domain.ChannelPermissionOverride, error) {
	var override domain.ChannelPermissionOverride
	var targetType string
	var allowsRaw string
	var deniesRaw string
	err := s.db.QueryRow(
		`SELECT override_uuid, channel_uuid, target_type, target_uuid, allow_permissions, deny_permissions
		 FROM channel_permission_overrides WHERE channel_uuid = ? AND override_uuid = ?`,
		channelID,
		overrideID,
	).Scan(
		&override.OverrideID,
		&override.ChannelID,
		&targetType,
		&override.TargetID,
		&allowsRaw,
		&deniesRaw,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ChannelPermissionOverride{}, ErrNotFound
	}
	if err != nil {
		return domain.ChannelPermissionOverride{}, err
	}
	override.TargetType = domain.ChannelPermissionOverrideTarget(targetType)
	override.Allows = decodePermissionMap(allowsRaw)
	override.Denies = decodePermissionMap(deniesRaw)
	if _, err := s.db.Exec(
		`DELETE FROM channel_permission_overrides WHERE channel_uuid = ? AND override_uuid = ?`,
		channelID,
		overrideID,
	); err != nil {
		return domain.ChannelPermissionOverride{}, err
	}
	return override, nil
}

func (s *SQLiteStore) Messages(channelID string, beforeMS int64, limit int) []domain.Message {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	rows, err := s.db.Query(
		`SELECT message_uuid, channel_uuid, author_member_uuid, content, reply_to_message_uuid, created_at, edited_at, deleted_at
		 FROM (
		   SELECT message_uuid, channel_uuid, author_member_uuid, content, reply_to_message_uuid, created_at, edited_at, deleted_at
		   FROM messages
		   WHERE channel_uuid = ? AND deleted_at = 0 AND (? = 0 OR created_at < ?)
		   ORDER BY created_at DESC
		   LIMIT ?
		 ) ORDER BY created_at`,
		channelID,
		beforeMS,
		beforeMS,
		limit,
	)
	if err != nil {
		return nil
	}
	defer rows.Close()

	messages := []domain.Message{}
	for rows.Next() {
		var message domain.Message
		if err := rows.Scan(
			&message.MessageID,
			&message.ChannelID,
			&message.AuthorID,
			&message.Content,
			&message.ReplyToMessageID,
			&message.CreatedAtMS,
			&message.EditedAtMS,
			&message.DeletedAtMS,
		); err == nil {
			messages = append(messages, message)
		}
	}
	return messages
}

func (s *SQLiteStore) Message(channelID string, messageID string) (domain.Message, error) {
	message, err := s.message(messageID)
	if err != nil {
		return domain.Message{}, err
	}
	if message.ChannelID != channelID {
		return domain.Message{}, ErrNotFound
	}
	return message, nil
}

func (s *SQLiteStore) MessagesAround(
	channelID string,
	messageID string,
	beforeLimit int,
	afterLimit int,
) ([]domain.Message, error) {
	target, err := s.Message(channelID, messageID)
	if err != nil {
		return nil, err
	}
	if beforeLimit <= 0 || beforeLimit > 50 {
		beforeLimit = 25
	}
	if afterLimit <= 0 || afterLimit > 50 {
		afterLimit = 25
	}

	beforeRows, err := s.db.Query(
		`SELECT message_uuid, channel_uuid, author_member_uuid, content, reply_to_message_uuid, created_at, edited_at, deleted_at
		 FROM messages
		 WHERE channel_uuid = ? AND deleted_at = 0 AND created_at < ?
		 ORDER BY created_at DESC
		 LIMIT ?`,
		channelID,
		target.CreatedAtMS,
		beforeLimit,
	)
	if err != nil {
		return nil, err
	}
	before := scanMessages(beforeRows)
	for i, j := 0, len(before)-1; i < j; i, j = i+1, j-1 {
		before[i], before[j] = before[j], before[i]
	}

	afterRows, err := s.db.Query(
		`SELECT message_uuid, channel_uuid, author_member_uuid, content, reply_to_message_uuid, created_at, edited_at, deleted_at
		 FROM messages
		 WHERE channel_uuid = ? AND deleted_at = 0 AND created_at > ?
		 ORDER BY created_at ASC
		 LIMIT ?`,
		channelID,
		target.CreatedAtMS,
		afterLimit,
	)
	if err != nil {
		return nil, err
	}
	after := scanMessages(afterRows)
	return append(append(before, target), after...), nil
}

func (s *SQLiteStore) SearchMessages(channelID string, query string, limit int) []domain.Message {
	query = strings.TrimSpace(query)
	if query == "" {
		return []domain.Message{}
	}
	if limit <= 0 || limit > 50 {
		limit = 25
	}
	rows, err := s.db.Query(
		`SELECT message_uuid, channel_uuid, author_member_uuid, content, reply_to_message_uuid, created_at, edited_at, deleted_at
		 FROM messages
		 WHERE channel_uuid = ? AND deleted_at = 0 AND LOWER(content) LIKE LOWER(?)
		 ORDER BY created_at DESC
		 LIMIT ?`,
		channelID,
		"%"+query+"%",
		limit,
	)
	if err != nil {
		return nil
	}
	return scanMessages(rows)
}

func (s *SQLiteStore) CreateMessage(
	channelID string,
	authorID string,
	content string,
	replyToMessageID string,
) (domain.Message, error) {
	if !s.channelExists(channelID) {
		return domain.Message{}, ErrNotFound
	}
	if replyToMessageID != "" {
		replyToMessage, err := s.message(replyToMessageID)
		if err != nil {
			return domain.Message{}, err
		}
		if replyToMessage.ChannelID != channelID {
			return domain.Message{}, ErrNotFound
		}
	}
	messageID, err := auth.NewToken("msg")
	if err != nil {
		return domain.Message{}, err
	}
	message := domain.Message{
		MessageID:        messageID,
		ChannelID:        channelID,
		AuthorID:         authorID,
		Content:          content,
		ReplyToMessageID: replyToMessageID,
		CreatedAtMS:      time.Now().UnixMilli(),
	}
	_, err = s.db.Exec(
		`INSERT INTO messages (message_uuid, channel_uuid, author_member_uuid, content, reply_to_message_uuid, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		message.MessageID,
		message.ChannelID,
		message.AuthorID,
		message.Content,
		message.ReplyToMessageID,
		message.CreatedAtMS,
	)
	if err != nil {
		return domain.Message{}, err
	}
	return message, nil
}

func (s *SQLiteStore) UpdateMessage(
	channelID string,
	messageID string,
	authorID string,
	content string,
) (domain.Message, error) {
	message, err := s.message(messageID)
	if err != nil {
		return domain.Message{}, err
	}
	if message.ChannelID != channelID {
		return domain.Message{}, ErrNotFound
	}
	if message.AuthorID != authorID {
		return domain.Message{}, ErrForbidden
	}
	message.Content = content
	message.EditedAtMS = time.Now().UnixMilli()
	_, err = s.db.Exec(
		`UPDATE messages SET content = ?, edited_at = ? WHERE message_uuid = ? AND deleted_at = 0`,
		message.Content,
		message.EditedAtMS,
		message.MessageID,
	)
	if err != nil {
		return domain.Message{}, err
	}
	return message, nil
}

func (s *SQLiteStore) DeleteMessage(
	channelID string,
	messageID string,
	actorID string,
	canManage bool,
) (domain.Message, error) {
	message, err := s.message(messageID)
	if err != nil {
		return domain.Message{}, err
	}
	if message.ChannelID != channelID {
		return domain.Message{}, ErrNotFound
	}
	if message.AuthorID != actorID && !canManage {
		return domain.Message{}, ErrForbidden
	}
	message.DeletedAtMS = time.Now().UnixMilli()
	_, err = s.db.Exec(
		`UPDATE messages SET deleted_at = ? WHERE message_uuid = ? AND deleted_at = 0`,
		message.DeletedAtMS,
		message.MessageID,
	)
	if err != nil {
		return domain.Message{}, err
	}
	return message, nil
}

func (s *SQLiteStore) ContentAsset(sha256 string) (domain.ContentAsset, error) {
	var asset domain.ContentAsset
	err := s.db.QueryRow(
		`SELECT sha256, size_bytes, mime_type, original_name, storage_path, created_at
		 FROM content_assets WHERE sha256 = ?`,
		sha256,
	).Scan(
		&asset.SHA256,
		&asset.SizeBytes,
		&asset.MimeType,
		&asset.OriginalName,
		&asset.StoragePath,
		&asset.CreatedAtMS,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ContentAsset{}, ErrNotFound
	}
	if err != nil {
		return domain.ContentAsset{}, err
	}
	return asset, nil
}

func (s *SQLiteStore) UpsertContentAsset(input domain.ContentAsset) (domain.ContentAsset, error) {
	if input.SHA256 == "" {
		return domain.ContentAsset{}, ErrNotFound
	}
	if existing, err := s.ContentAsset(input.SHA256); err == nil {
		return existing, nil
	}
	if input.CreatedAtMS == 0 {
		input.CreatedAtMS = time.Now().UnixMilli()
	}
	_, err := s.db.Exec(
		`INSERT INTO content_assets (sha256, size_bytes, mime_type, original_name, storage_path, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)
		 ON CONFLICT(sha256) DO NOTHING`,
		input.SHA256,
		input.SizeBytes,
		input.MimeType,
		input.OriginalName,
		input.StoragePath,
		input.CreatedAtMS,
	)
	if err != nil {
		return domain.ContentAsset{}, err
	}
	return s.ContentAsset(input.SHA256)
}

func (s *SQLiteStore) LinkChannelMessageImage(channelID string, assetSHA256 string) error {
	if _, err := s.channel(channelID); err != nil {
		return err
	}
	if _, err := s.ContentAsset(assetSHA256); err != nil {
		return err
	}
	_, err := s.db.Exec(
		`INSERT OR IGNORE INTO channel_message_images (channel_uuid, asset_sha256, created_at) VALUES (?, ?, ?)`,
		channelID,
		assetSHA256,
		time.Now().UnixMilli(),
	)
	return err
}

func (s *SQLiteStore) ChannelHasMessageImage(channelID string, assetSHA256 string) bool {
	var found int
	err := s.db.QueryRow(
		`SELECT 1 FROM channel_message_images WHERE channel_uuid = ? AND asset_sha256 = ?`,
		channelID,
		assetSHA256,
	).Scan(&found)
	return err == nil && found == 1
}

func (s *SQLiteStore) SoundboardItems() []domain.SoundboardItem {
	rows, err := s.db.Query(
		`SELECT item_uuid, name, asset_sha256, icon_emoji, icon_asset_sha256, start_ms, end_ms, base_volume,
		        uploader_member_uuid, size_bytes, mime_type, created_at, updated_at
		 FROM soundboard_items ORDER BY lower(name), item_uuid`,
	)
	if err != nil {
		return nil
	}
	defer rows.Close()
	items := []domain.SoundboardItem{}
	for rows.Next() {
		var item domain.SoundboardItem
		if err := rows.Scan(
			&item.ItemID,
			&item.Name,
			&item.AssetSHA256,
			&item.IconEmoji,
			&item.IconAssetSHA256,
			&item.StartMS,
			&item.EndMS,
			&item.BaseVolume,
			&item.UploaderMemberID,
			&item.SizeBytes,
			&item.MimeType,
			&item.CreatedAtMS,
			&item.UpdatedAtMS,
		); err == nil {
			items = append(items, item)
		}
	}
	return items
}

func (s *SQLiteStore) SoundboardItem(itemID string) (domain.SoundboardItem, error) {
	var item domain.SoundboardItem
	err := s.db.QueryRow(
		`SELECT item_uuid, name, asset_sha256, icon_emoji, icon_asset_sha256, start_ms, end_ms, base_volume,
		        uploader_member_uuid, size_bytes, mime_type, created_at, updated_at
		 FROM soundboard_items WHERE item_uuid = ?`,
		itemID,
	).Scan(
		&item.ItemID,
		&item.Name,
		&item.AssetSHA256,
		&item.IconEmoji,
		&item.IconAssetSHA256,
		&item.StartMS,
		&item.EndMS,
		&item.BaseVolume,
		&item.UploaderMemberID,
		&item.SizeBytes,
		&item.MimeType,
		&item.CreatedAtMS,
		&item.UpdatedAtMS,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.SoundboardItem{}, ErrNotFound
	}
	if err != nil {
		return domain.SoundboardItem{}, err
	}
	return item, nil
}

func (s *SQLiteStore) CreateSoundboardItem(input domain.SoundboardItem) (domain.SoundboardItem, error) {
	if _, err := s.ContentAsset(input.AssetSHA256); err != nil {
		return domain.SoundboardItem{}, err
	}
	itemID, err := auth.NewToken("snd")
	if err != nil {
		return domain.SoundboardItem{}, err
	}
	now := time.Now().UnixMilli()
	if input.BaseVolume <= 0 {
		input.BaseVolume = 1
	}
	_, err = s.db.Exec(
		`INSERT INTO soundboard_items (
		 item_uuid, name, asset_sha256, base_volume, uploader_member_uuid, size_bytes, mime_type, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		itemID,
		input.Name,
		input.AssetSHA256,
		input.BaseVolume,
		input.UploaderMemberID,
		input.SizeBytes,
		input.MimeType,
		now,
		now,
	)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique constraint") {
			return domain.SoundboardItem{}, ErrAlreadyExists
		}
		return domain.SoundboardItem{}, err
	}
	return s.SoundboardItem(itemID)
}

func (s *SQLiteStore) UpdateSoundboardItem(itemID string, input domain.SoundboardItem) (domain.SoundboardItem, error) {
	result, err := s.db.Exec(
		`UPDATE soundboard_items
		 SET name = ?, icon_emoji = ?, icon_asset_sha256 = ?, start_ms = ?, end_ms = ?, base_volume = ?, updated_at = ?
		 WHERE item_uuid = ?`,
		input.Name,
		input.IconEmoji,
		input.IconAssetSHA256,
		input.StartMS,
		input.EndMS,
		input.BaseVolume,
		time.Now().UnixMilli(),
		itemID,
	)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique constraint") {
			return domain.SoundboardItem{}, ErrAlreadyExists
		}
		return domain.SoundboardItem{}, err
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		return domain.SoundboardItem{}, ErrNotFound
	}
	return s.SoundboardItem(itemID)
}

func (s *SQLiteStore) DeleteSoundboardItem(itemID string) (domain.SoundboardItem, error) {
	item, err := s.SoundboardItem(itemID)
	if err != nil {
		return domain.SoundboardItem{}, err
	}
	result, err := s.db.Exec(`DELETE FROM soundboard_items WHERE item_uuid = ?`, itemID)
	if err != nil {
		return domain.SoundboardItem{}, err
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		return domain.SoundboardItem{}, ErrNotFound
	}
	return item, nil
}

func (s *SQLiteStore) CustomEmojis() []domain.CustomEmoji {
	rows, err := s.db.Query(
		`SELECT emoji_uuid, shortcode, asset_sha256, preview_sha256, uploader_member_uuid,
		        size_bytes, mime_type, is_gif, created_at, updated_at
		 FROM custom_emojis ORDER BY lower(shortcode), emoji_uuid`,
	)
	if err != nil {
		return nil
	}
	defer rows.Close()
	emojis := []domain.CustomEmoji{}
	for rows.Next() {
		var emoji domain.CustomEmoji
		var isGIF int
		if err := rows.Scan(
			&emoji.EmojiID,
			&emoji.Shortcode,
			&emoji.AssetSHA256,
			&emoji.PreviewSHA256,
			&emoji.UploaderMemberID,
			&emoji.SizeBytes,
			&emoji.MimeType,
			&isGIF,
			&emoji.CreatedAtMS,
			&emoji.UpdatedAtMS,
		); err == nil {
			emoji.IsGIF = isGIF != 0
			emojis = append(emojis, emoji)
		}
	}
	return emojis
}

func (s *SQLiteStore) CustomEmoji(emojiID string) (domain.CustomEmoji, error) {
	var emoji domain.CustomEmoji
	var isGIF int
	err := s.db.QueryRow(
		`SELECT emoji_uuid, shortcode, asset_sha256, preview_sha256, uploader_member_uuid,
		        size_bytes, mime_type, is_gif, created_at, updated_at
		 FROM custom_emojis WHERE emoji_uuid = ?`,
		emojiID,
	).Scan(
		&emoji.EmojiID,
		&emoji.Shortcode,
		&emoji.AssetSHA256,
		&emoji.PreviewSHA256,
		&emoji.UploaderMemberID,
		&emoji.SizeBytes,
		&emoji.MimeType,
		&isGIF,
		&emoji.CreatedAtMS,
		&emoji.UpdatedAtMS,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.CustomEmoji{}, ErrNotFound
	}
	if err != nil {
		return domain.CustomEmoji{}, err
	}
	emoji.IsGIF = isGIF != 0
	return emoji, nil
}

func (s *SQLiteStore) CreateCustomEmoji(input domain.CustomEmoji) (domain.CustomEmoji, error) {
	if _, err := s.ContentAsset(input.AssetSHA256); err != nil {
		return domain.CustomEmoji{}, err
	}
	emojiID, err := auth.NewToken("emo")
	if err != nil {
		return domain.CustomEmoji{}, err
	}
	now := time.Now().UnixMilli()
	_, err = s.db.Exec(
		`INSERT INTO custom_emojis (
		 emoji_uuid, shortcode, asset_sha256, preview_sha256, uploader_member_uuid,
		 size_bytes, mime_type, is_gif, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		emojiID,
		input.Shortcode,
		input.AssetSHA256,
		input.PreviewSHA256,
		input.UploaderMemberID,
		input.SizeBytes,
		input.MimeType,
		boolInt(input.IsGIF),
		now,
		now,
	)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique constraint") {
			return domain.CustomEmoji{}, ErrAlreadyExists
		}
		return domain.CustomEmoji{}, err
	}
	return s.CustomEmoji(emojiID)
}

func (s *SQLiteStore) UpdateCustomEmoji(emojiID string, shortcode string) (domain.CustomEmoji, error) {
	result, err := s.db.Exec(
		`UPDATE custom_emojis SET shortcode = ?, updated_at = ? WHERE emoji_uuid = ?`,
		shortcode,
		time.Now().UnixMilli(),
		emojiID,
	)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique constraint") {
			return domain.CustomEmoji{}, ErrAlreadyExists
		}
		return domain.CustomEmoji{}, err
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		return domain.CustomEmoji{}, ErrNotFound
	}
	return s.CustomEmoji(emojiID)
}

func (s *SQLiteStore) DeleteCustomEmoji(emojiID string) (domain.CustomEmoji, error) {
	emoji, err := s.CustomEmoji(emojiID)
	if err != nil {
		return domain.CustomEmoji{}, err
	}
	result, err := s.db.Exec(`DELETE FROM custom_emojis WHERE emoji_uuid = ?`, emojiID)
	if err != nil {
		return domain.CustomEmoji{}, err
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		return domain.CustomEmoji{}, ErrNotFound
	}
	return emoji, nil
}

func (s *SQLiteStore) FileEntries(channelID string, parentID string) []domain.ChannelFileEntry {
	rows, err := s.db.Query(
		`SELECT entry_uuid, channel_uuid, parent_uuid, type, name, asset_sha256, uploader_member_uuid, size_bytes, mime_type, created_at, updated_at
		 FROM channel_file_entries
		 WHERE channel_uuid = ? AND parent_uuid = ?
		 ORDER BY CASE WHEN type = 'directory' THEN 0 ELSE 1 END, lower(name), entry_uuid`,
		channelID,
		parentID,
	)
	if err != nil {
		return nil
	}
	defer rows.Close()

	return scanFileEntries(rows)
}

func (s *SQLiteStore) FileEntry(channelID string, entryID string) (domain.ChannelFileEntry, error) {
	entry, err := s.fileEntry(entryID)
	if err != nil {
		return domain.ChannelFileEntry{}, err
	}
	if entry.ChannelID != channelID {
		return domain.ChannelFileEntry{}, ErrNotFound
	}
	return entry, nil
}

func (s *SQLiteStore) CreateFileEntry(input domain.ChannelFileEntry) (domain.ChannelFileEntry, error) {
	if _, err := s.channel(input.ChannelID); err != nil {
		return domain.ChannelFileEntry{}, err
	}
	if err := s.validateFileParent(input.ChannelID, input.ParentID, ""); err != nil {
		return domain.ChannelFileEntry{}, err
	}
	entryID, err := auth.NewToken("file")
	if err != nil {
		return domain.ChannelFileEntry{}, err
	}
	now := time.Now().UnixMilli()
	input.EntryID = entryID
	if input.Type == "" {
		input.Type = domain.ChannelFileEntryFile
	}
	input.CreatedAtMS = now
	input.UpdatedAtMS = now
	_, err = s.db.Exec(
		`INSERT INTO channel_file_entries (
			entry_uuid, channel_uuid, parent_uuid, type, name, asset_sha256, uploader_member_uuid, size_bytes, mime_type, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		input.EntryID,
		input.ChannelID,
		input.ParentID,
		string(input.Type),
		input.Name,
		input.AssetSHA256,
		input.OwnerMemberID,
		input.SizeBytes,
		input.MimeType,
		input.CreatedAtMS,
		input.UpdatedAtMS,
	)
	if err != nil {
		return domain.ChannelFileEntry{}, err
	}
	return input, nil
}

func (s *SQLiteStore) UpdateFileEntry(channelID string, entryID string, input domain.ChannelFileEntry) (domain.ChannelFileEntry, error) {
	entry, err := s.FileEntry(channelID, entryID)
	if err != nil {
		return domain.ChannelFileEntry{}, err
	}
	if input.ParentID != entry.ParentID {
		if err := s.validateFileParent(channelID, input.ParentID, entryID); err != nil {
			return domain.ChannelFileEntry{}, err
		}
		entry.ParentID = input.ParentID
	}
	if strings.TrimSpace(input.Name) != "" {
		entry.Name = input.Name
	}
	entry.UpdatedAtMS = time.Now().UnixMilli()
	_, err = s.db.Exec(
		`UPDATE channel_file_entries SET parent_uuid = ?, name = ?, updated_at = ? WHERE channel_uuid = ? AND entry_uuid = ?`,
		entry.ParentID,
		entry.Name,
		entry.UpdatedAtMS,
		channelID,
		entryID,
	)
	if err != nil {
		return domain.ChannelFileEntry{}, err
	}
	return entry, nil
}

func (s *SQLiteStore) DeleteFileEntry(channelID string, entryID string) (domain.ChannelFileEntry, error) {
	entry, err := s.FileEntry(channelID, entryID)
	if err != nil {
		return domain.ChannelFileEntry{}, err
	}
	_, err = s.db.Exec(
		`WITH RECURSIVE descendants(entry_uuid) AS (
			SELECT entry_uuid FROM channel_file_entries WHERE channel_uuid = ? AND entry_uuid = ?
			UNION ALL
			SELECT child.entry_uuid
			FROM channel_file_entries child
			INNER JOIN descendants parent ON child.parent_uuid = parent.entry_uuid
			WHERE child.channel_uuid = ?
		)
		DELETE FROM channel_file_entries WHERE entry_uuid IN (SELECT entry_uuid FROM descendants)`,
		channelID,
		entryID,
		channelID,
	)
	if err != nil {
		return domain.ChannelFileEntry{}, err
	}
	return entry, nil
}

func (s *SQLiteStore) fileEntry(entryID string) (domain.ChannelFileEntry, error) {
	var entry domain.ChannelFileEntry
	var entryType string
	err := s.db.QueryRow(
		`SELECT entry_uuid, channel_uuid, parent_uuid, type, name, asset_sha256, uploader_member_uuid, size_bytes, mime_type, created_at, updated_at
		 FROM channel_file_entries WHERE entry_uuid = ?`,
		entryID,
	).Scan(
		&entry.EntryID,
		&entry.ChannelID,
		&entry.ParentID,
		&entryType,
		&entry.Name,
		&entry.AssetSHA256,
		&entry.OwnerMemberID,
		&entry.SizeBytes,
		&entry.MimeType,
		&entry.CreatedAtMS,
		&entry.UpdatedAtMS,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ChannelFileEntry{}, ErrNotFound
	}
	if err != nil {
		return domain.ChannelFileEntry{}, err
	}
	entry.Type = domain.ChannelFileEntryType(entryType)
	return entry, nil
}

func (s *SQLiteStore) validateFileParent(channelID string, parentID string, movingEntryID string) error {
	if parentID == "" {
		return nil
	}
	if parentID == movingEntryID {
		return ErrInvalidChannelOrder
	}
	parent, err := s.fileEntry(parentID)
	if err != nil {
		return err
	}
	if parent.ChannelID != channelID || parent.Type != domain.ChannelFileEntryDirectory {
		return ErrNotFound
	}
	for parent.ParentID != "" {
		if parent.ParentID == movingEntryID {
			return ErrInvalidChannelOrder
		}
		parent, err = s.fileEntry(parent.ParentID)
		if err != nil {
			return err
		}
	}
	return nil
}

func scanFileEntries(rows *sql.Rows) []domain.ChannelFileEntry {
	items := []domain.ChannelFileEntry{}
	for rows.Next() {
		var entry domain.ChannelFileEntry
		var entryType string
		if err := rows.Scan(
			&entry.EntryID,
			&entry.ChannelID,
			&entry.ParentID,
			&entryType,
			&entry.Name,
			&entry.AssetSHA256,
			&entry.OwnerMemberID,
			&entry.SizeBytes,
			&entry.MimeType,
			&entry.CreatedAtMS,
			&entry.UpdatedAtMS,
		); err == nil {
			entry.Type = domain.ChannelFileEntryType(entryType)
			items = append(items, entry)
		}
	}
	return items
}

func (s *SQLiteStore) CreateAuditLog(input domain.AuditLog) (domain.AuditLog, error) {
	auditID, err := auth.NewToken("audit")
	if err != nil {
		return domain.AuditLog{}, err
	}
	if input.Details == nil {
		input.Details = map[string]string{}
	}
	input.AuditID = auditID
	if input.CreatedAtMS == 0 {
		input.CreatedAtMS = time.Now().UnixMilli()
	}
	details, err := json.Marshal(input.Details)
	if err != nil {
		return domain.AuditLog{}, err
	}
	_, err = s.db.Exec(
		`INSERT INTO audit_logs (audit_uuid, actor_member_uuid, action, target_type, target_uuid, details, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		input.AuditID,
		input.ActorMemberID,
		input.Action,
		input.TargetType,
		input.TargetID,
		string(details),
		input.CreatedAtMS,
	)
	if err != nil {
		return domain.AuditLog{}, err
	}
	return input, nil
}

func (s *SQLiteStore) AuditLogs(action string, limit int) []domain.AuditLog {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	var rows *sql.Rows
	var err error
	if strings.TrimSpace(action) != "" {
		rows, err = s.db.Query(
			`SELECT audit_uuid, actor_member_uuid, action, target_type, target_uuid, details, created_at
			 FROM audit_logs WHERE action = ? ORDER BY created_at DESC, audit_uuid DESC LIMIT ?`,
			action,
			limit,
		)
	} else {
		rows, err = s.db.Query(
			`SELECT audit_uuid, actor_member_uuid, action, target_type, target_uuid, details, created_at
			 FROM audit_logs ORDER BY created_at DESC, audit_uuid DESC LIMIT ?`,
			limit,
		)
	}
	if err != nil {
		return nil
	}
	defer rows.Close()

	items := []domain.AuditLog{}
	for rows.Next() {
		var item domain.AuditLog
		var details string
		if err := rows.Scan(
			&item.AuditID,
			&item.ActorMemberID,
			&item.Action,
			&item.TargetType,
			&item.TargetID,
			&details,
			&item.CreatedAtMS,
		); err != nil {
			continue
		}
		item.Details = map[string]string{}
		_ = json.Unmarshal([]byte(details), &item.Details)
		items = append(items, item)
	}
	return items
}

func (s *SQLiteStore) Invites() []domain.ServerInvite {
	rows, err := s.db.Query(
		`SELECT invite_uuid, token, creator_member_uuid, expires_at, max_uses, use_count, created_at
		 FROM server_invites ORDER BY created_at DESC, invite_uuid DESC`,
	)
	if err != nil {
		return nil
	}
	defer rows.Close()
	items := []domain.ServerInvite{}
	for rows.Next() {
		var invite domain.ServerInvite
		if rows.Scan(
			&invite.InviteID,
			&invite.Token,
			&invite.CreatorMemberID,
			&invite.ExpiresAtMS,
			&invite.MaxUses,
			&invite.UseCount,
			&invite.CreatedAtMS,
		) == nil {
			items = append(items, invite)
		}
	}
	return items
}

func (s *SQLiteStore) CreateInvite(input domain.ServerInvite) (domain.ServerInvite, error) {
	if input.InviteID == "" || input.TokenHash == "" {
		return domain.ServerInvite{}, ErrInviteInvalid
	}
	if input.MaxUses <= 0 {
		input.MaxUses = 1
	}
	_, err := s.db.Exec(
		`INSERT INTO server_invites (invite_uuid, token, token_hash, creator_member_uuid, expires_at, max_uses, use_count, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
		input.InviteID,
		input.Token,
		input.TokenHash,
		input.CreatorMemberID,
		input.ExpiresAtMS,
		input.MaxUses,
		input.CreatedAtMS,
	)
	if err != nil {
		return domain.ServerInvite{}, err
	}
	return input, nil
}

func (s *SQLiteStore) ConsumeInvite(token string, nowMS int64) (domain.ServerInvite, error) {
	tokenHash := auth.HashSecret(strings.TrimSpace(token))
	result, err := s.db.Exec(
		`UPDATE server_invites SET use_count = use_count + 1
		 WHERE token_hash = ? AND (expires_at = 0 OR expires_at > ?) AND use_count < max_uses`,
		tokenHash,
		nowMS,
	)
	if err != nil {
		return domain.ServerInvite{}, err
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil || rowsAffected != 1 {
		return domain.ServerInvite{}, ErrInviteInvalid
	}
	var invite domain.ServerInvite
	err = s.db.QueryRow(
		`SELECT invite_uuid, token, creator_member_uuid, expires_at, max_uses, use_count, created_at
		 FROM server_invites WHERE token_hash = ?`,
		tokenHash,
	).Scan(
		&invite.InviteID,
		&invite.Token,
		&invite.CreatorMemberID,
		&invite.ExpiresAtMS,
		&invite.MaxUses,
		&invite.UseCount,
		&invite.CreatedAtMS,
	)
	if err != nil {
		return domain.ServerInvite{}, err
	}
	return invite, nil
}

func (s *SQLiteStore) DeleteInvite(inviteID string) (domain.ServerInvite, error) {
	var invite domain.ServerInvite
	err := s.db.QueryRow(
		`SELECT invite_uuid, token, creator_member_uuid, expires_at, max_uses, use_count, created_at
		 FROM server_invites WHERE invite_uuid = ?`,
		inviteID,
	).Scan(
		&invite.InviteID,
		&invite.Token,
		&invite.CreatorMemberID,
		&invite.ExpiresAtMS,
		&invite.MaxUses,
		&invite.UseCount,
		&invite.CreatedAtMS,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ServerInvite{}, ErrNotFound
	}
	if err != nil {
		return domain.ServerInvite{}, err
	}
	if _, err = s.db.Exec(`DELETE FROM server_invites WHERE invite_uuid = ?`, inviteID); err != nil {
		return domain.ServerInvite{}, err
	}
	return invite, nil
}

func (s *SQLiteStore) VoiceStates() []domain.VoiceState {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	_ = s.settleVoiceDurationsLocked(time.Now().UnixMilli(), false)
	states, _ := s.voiceStatesLocked()
	return states
}

func (s *SQLiteStore) VoiceDurationStats(memberID string, comparedMemberID string) (domain.VoiceDurationStats, error) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	memberFound, err := s.memberExists(memberID)
	if err != nil {
		return domain.VoiceDurationStats{}, err
	}
	comparedMemberFound := true
	if comparedMemberID != "" {
		comparedMemberFound, err = s.memberExists(comparedMemberID)
		if err != nil {
			return domain.VoiceDurationStats{}, err
		}
	}
	if !memberFound || !comparedMemberFound {
		return domain.VoiceDurationStats{}, ErrNotFound
	}
	now := time.Now().UnixMilli()
	if err = s.settleVoiceDurationsLocked(now, true); err != nil {
		return domain.VoiceDurationStats{}, err
	}
	states, err := s.voiceStatesLocked()
	if err != nil {
		return domain.VoiceDurationStats{}, err
	}
	members, pairs := voiceDurationTopology(states)
	stats := domain.VoiceDurationStats{
		MemberID:         memberID,
		ComparedMemberID: comparedMemberID,
		MemberActive:     hasVoiceDurationMember(members, memberID),
		MeasuredAtMS:     now,
	}
	if err := s.db.QueryRow(
		`SELECT total_duration_ms FROM voice_member_durations WHERE member_uuid = ?`,
		memberID,
	).Scan(&stats.TotalVoiceDurationMS); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return domain.VoiceDurationStats{}, err
	}
	if pair, ok := canonicalVoiceMemberPair(memberID, comparedMemberID); ok {
		if err := s.db.QueryRow(
			`SELECT shared_duration_ms FROM voice_pair_durations WHERE member_a_uuid = ? AND member_b_uuid = ?`,
			pair.First,
			pair.Second,
		).Scan(&stats.SharedVoiceDurationMS); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return domain.VoiceDurationStats{}, err
		}
		_, stats.SharedActive = pairs[pair]
	}
	return stats, nil
}

func (s *SQLiteStore) memberExists(memberID string) (bool, error) {
	var found int
	err := s.db.QueryRow(`SELECT 1 FROM members WHERE member_uuid = ?`, memberID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *SQLiteStore) settleVoiceDurationsLocked(nowMS int64, force bool) error {
	if s.voiceStatsCheckpointMS <= 0 || nowMS < s.voiceStatsCheckpointMS {
		s.voiceStatsCheckpointMS = nowMS
		return nil
	}
	deltaMS := nowMS - s.voiceStatsCheckpointMS
	if deltaMS <= 0 || (!force && deltaMS < voiceDurationCheckpointIntervalMS) {
		return nil
	}
	states, err := s.voiceStatesLocked()
	if err != nil {
		return err
	}
	members, pairs := voiceDurationTopology(states)
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for memberID := range members {
		if _, err = tx.Exec(
			`INSERT INTO voice_member_durations (member_uuid, total_duration_ms) VALUES (?, ?)
			 ON CONFLICT(member_uuid) DO UPDATE SET total_duration_ms = total_duration_ms + excluded.total_duration_ms`,
			memberID,
			deltaMS,
		); err != nil {
			return err
		}
	}
	for pair := range pairs {
		if _, err = tx.Exec(
			`INSERT INTO voice_pair_durations (member_a_uuid, member_b_uuid, shared_duration_ms) VALUES (?, ?, ?)
			 ON CONFLICT(member_a_uuid, member_b_uuid) DO UPDATE SET shared_duration_ms = shared_duration_ms + excluded.shared_duration_ms`,
			pair.First,
			pair.Second,
			deltaMS,
		); err != nil {
			return err
		}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	s.voiceStatsCheckpointMS = nowMS
	return nil
}

func mergeSQLiteVoiceDurations(tx *sql.Tx, primaryMemberID string, duplicateMemberID string) error {
	var duplicateTotalMS int64
	if err := tx.QueryRow(
		`SELECT total_duration_ms FROM voice_member_durations WHERE member_uuid = ?`,
		duplicateMemberID,
	).Scan(&duplicateTotalMS); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if duplicateTotalMS > 0 {
		if _, err := tx.Exec(
			`INSERT INTO voice_member_durations (member_uuid, total_duration_ms) VALUES (?, ?)
			 ON CONFLICT(member_uuid) DO UPDATE SET total_duration_ms = total_duration_ms + excluded.total_duration_ms`,
			primaryMemberID,
			duplicateTotalMS,
		); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`DELETE FROM voice_member_durations WHERE member_uuid = ?`, duplicateMemberID); err != nil {
		return err
	}

	type storedPair struct {
		first      string
		second     string
		durationMS int64
	}
	rows, err := tx.Query(
		`SELECT member_a_uuid, member_b_uuid, shared_duration_ms
		 FROM voice_pair_durations WHERE member_a_uuid = ? OR member_b_uuid = ?`,
		duplicateMemberID,
		duplicateMemberID,
	)
	if err != nil {
		return err
	}
	pairs := make([]storedPair, 0)
	for rows.Next() {
		var pair storedPair
		if err := rows.Scan(&pair.first, &pair.second, &pair.durationMS); err != nil {
			_ = rows.Close()
			return err
		}
		pairs = append(pairs, pair)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`DELETE FROM voice_pair_durations WHERE member_a_uuid = ? OR member_b_uuid = ?`,
		duplicateMemberID,
		duplicateMemberID,
	); err != nil {
		return err
	}
	for _, stored := range pairs {
		otherMemberID := stored.first
		if otherMemberID == duplicateMemberID {
			otherMemberID = stored.second
		}
		pair, ok := canonicalVoiceMemberPair(primaryMemberID, otherMemberID)
		if !ok {
			continue
		}
		if _, err := tx.Exec(
			`INSERT INTO voice_pair_durations (member_a_uuid, member_b_uuid, shared_duration_ms) VALUES (?, ?, ?)
			 ON CONFLICT(member_a_uuid, member_b_uuid) DO UPDATE SET shared_duration_ms = shared_duration_ms + excluded.shared_duration_ms`,
			pair.First,
			pair.Second,
			stored.durationMS,
		); err != nil {
			return err
		}
	}
	return nil
}

func (s *SQLiteStore) voiceStatesLocked() ([]domain.VoiceState, error) {
	rows, err := s.db.Query(
		`SELECT participant_uuid, member_uuid, device_uuid, mode, channel_uuid, joined_at, mic_muted, audio_deafened, server_muted, server_deafened, is_speaking
		 FROM voice_states ORDER BY channel_uuid, member_uuid, device_uuid`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var states []domain.VoiceState
	for rows.Next() {
		var state domain.VoiceState
		var micMuted int
		var audioDeafened int
		var serverMuted int
		var serverDeafened int
		var isSpeaking int
		if err := rows.Scan(&state.ParticipantID, &state.MemberID, &state.DeviceID, &state.Mode, &state.ChannelID, &state.JoinedAtMS, &micMuted, &audioDeafened, &serverMuted, &serverDeafened, &isSpeaking); err == nil {
			state.MicMuted = micMuted != 0
			state.AudioDeafened = audioDeafened != 0
			state.ServerMuted = serverMuted != 0
			state.ServerDeafened = serverDeafened != 0
			state.IsSpeaking = s.voiceSpeaking[state.ParticipantID]
			states = append(states, state)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return states, nil
}

func (s *SQLiteStore) JoinVoiceChannel(channelID string, memberID string, deviceID string, mode string) (domain.VoiceState, error) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	var kind string
	err := s.db.QueryRow(`SELECT type FROM channels WHERE channel_uuid = ?`, channelID).Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.VoiceState{}, ErrNotFound
	}
	if err != nil {
		return domain.VoiceState{}, err
	}
	channelType := domain.ChannelType(kind)
	if channelType != domain.ChannelTypeVoice && channelType != domain.ChannelTypeTemporaryVoice {
		return domain.VoiceState{}, ErrInvalidVoiceChannel
	}

	var exists int
	err = s.db.QueryRow(`SELECT 1 FROM members WHERE member_uuid = ?`, memberID).Scan(&exists)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.VoiceState{}, ErrNotFound
	}
	if err != nil {
		return domain.VoiceState{}, err
	}

	if mode != "listener" {
		mode = "primary"
	}
	now := time.Now().UnixMilli()
	if err = s.settleVoiceDurationsLocked(now, true); err != nil {
		return domain.VoiceState{}, err
	}
	state := domain.VoiceState{
		ParticipantID: domain.VoiceParticipantID(memberID, deviceID),
		ChannelID:     channelID,
		MemberID:      memberID,
		DeviceID:      deviceID,
		Mode:          mode,
		JoinedAtMS:    now,
		MicMuted:      mode == "listener",
	}
	_, err = s.db.Exec(
		`INSERT INTO voice_states (participant_uuid, member_uuid, device_uuid, mode, channel_uuid, joined_at, mic_muted, audio_deafened, server_muted, server_deafened, is_speaking) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)
		 ON CONFLICT(member_uuid, device_uuid) DO UPDATE SET
		   participant_uuid = excluded.participant_uuid,
		   mode = excluded.mode,
		   channel_uuid = excluded.channel_uuid,
		   joined_at = excluded.joined_at,
		   mic_muted = excluded.mic_muted,
		   audio_deafened = 0,
		   server_muted = 0,
		   server_deafened = 0,
		   is_speaking = 0`,
		state.ParticipantID,
		state.MemberID,
		state.DeviceID,
		state.Mode,
		state.ChannelID,
		state.JoinedAtMS,
		boolInt(state.MicMuted),
	)
	if err != nil {
		return domain.VoiceState{}, err
	}
	s.voiceSpeaking[state.ParticipantID] = false
	return state, nil
}

func (s *SQLiteStore) UpdateVoiceState(participantID string, input domain.VoiceState) (domain.VoiceState, error) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	state, err := s.voiceState(participantID)
	if err != nil {
		return domain.VoiceState{}, err
	}
	previousMicMuted := state.MicMuted
	previousAudioDeafened := state.AudioDeafened
	state.MicMuted = state.Mode == "listener" || input.MicMuted || input.AudioDeafened || state.ServerMuted || state.ServerDeafened
	state.AudioDeafened = input.AudioDeafened
	state.IsSpeaking = input.IsSpeaking && !state.MicMuted && !state.AudioDeafened && !state.ServerMuted && !state.ServerDeafened
	if state.ServerDeafened {
		state.ServerMuted = true
	}
	if state.MicMuted != previousMicMuted || state.AudioDeafened != previousAudioDeafened {
		if _, err = s.db.Exec(
			`UPDATE voice_states SET mic_muted = ?, audio_deafened = ? WHERE participant_uuid = ?`,
			boolInt(state.MicMuted),
			boolInt(state.AudioDeafened),
			state.ParticipantID,
		); err != nil {
			return domain.VoiceState{}, err
		}
	}
	s.voiceSpeaking[state.ParticipantID] = state.IsSpeaking
	return state, nil
}

func (s *SQLiteStore) ManageVoiceState(participantID string, input domain.VoiceState) (domain.VoiceState, error) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	state, err := s.voiceState(participantID)
	if err != nil {
		return domain.VoiceState{}, err
	}
	if input.ChannelID != "" && input.ChannelID != state.ChannelID {
		var kind string
		err := s.db.QueryRow(`SELECT type FROM channels WHERE channel_uuid = ?`, input.ChannelID).Scan(&kind)
		if errors.Is(err, sql.ErrNoRows) {
			return domain.VoiceState{}, ErrNotFound
		}
		if err != nil {
			return domain.VoiceState{}, err
		}
		channelType := domain.ChannelType(kind)
		if channelType != domain.ChannelTypeVoice && channelType != domain.ChannelTypeTemporaryVoice {
			return domain.VoiceState{}, ErrInvalidVoiceChannel
		}
		now := time.Now().UnixMilli()
		if err = s.settleVoiceDurationsLocked(now, true); err != nil {
			return domain.VoiceState{}, err
		}
		state.ChannelID = input.ChannelID
		state.JoinedAtMS = now
		state.IsSpeaking = false
		s.voiceSpeaking[state.ParticipantID] = false
	}
	state.ServerMuted = input.ServerMuted || input.ServerDeafened
	state.ServerDeafened = input.ServerDeafened
	state.MicMuted = state.MicMuted || state.ServerMuted || state.ServerDeafened
	if state.ServerDeafened {
		state.AudioDeafened = true
	}
	state.IsSpeaking = state.IsSpeaking && !state.MicMuted && !state.AudioDeafened && !state.ServerMuted && !state.ServerDeafened
	_, err = s.db.Exec(
		`UPDATE voice_states
		 SET channel_uuid = ?, joined_at = ?, mic_muted = ?, audio_deafened = ?, server_muted = ?, server_deafened = ?, is_speaking = 0
		 WHERE participant_uuid = ?`,
		state.ChannelID,
		state.JoinedAtMS,
		boolInt(state.MicMuted),
		boolInt(state.AudioDeafened),
		boolInt(state.ServerMuted),
		boolInt(state.ServerDeafened),
		state.ParticipantID,
	)
	if err != nil {
		return domain.VoiceState{}, err
	}
	s.voiceSpeaking[state.ParticipantID] = state.IsSpeaking
	return state, nil
}

func (s *SQLiteStore) LeaveVoiceChannel(participantID string) (domain.VoiceState, bool, error) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	state, err := s.voiceState(participantID)
	if errors.Is(err, ErrNotFound) {
		return domain.VoiceState{}, false, nil
	}
	if err != nil {
		return domain.VoiceState{}, false, err
	}
	if err = s.settleVoiceDurationsLocked(time.Now().UnixMilli(), true); err != nil {
		return domain.VoiceState{}, false, err
	}
	if _, err = s.db.Exec(`DELETE FROM voice_states WHERE participant_uuid = ?`, participantID); err != nil {
		return domain.VoiceState{}, false, err
	}
	delete(s.voiceSpeaking, participantID)
	return state, true, nil
}

func (s *SQLiteStore) LeaveMemberVoiceChannels(memberID string) ([]domain.VoiceState, error) {
	s.voiceMu.Lock()
	defer s.voiceMu.Unlock()
	if err := s.settleVoiceDurationsLocked(time.Now().UnixMilli(), true); err != nil {
		return nil, err
	}
	states := []domain.VoiceState{}
	voiceStates, err := s.voiceStatesLocked()
	if err != nil {
		return nil, err
	}
	for _, state := range voiceStates {
		if state.MemberID == memberID {
			states = append(states, state)
		}
	}
	if _, err := s.db.Exec(`DELETE FROM voice_states WHERE member_uuid = ?`, memberID); err != nil {
		return nil, err
	}
	for _, state := range states {
		delete(s.voiceSpeaking, state.ParticipantID)
	}
	return states, nil
}

func (s *SQLiteStore) ScreenShareSessions() []domain.ScreenShareSession {
	s.shareMu.RLock()
	defer s.shareMu.RUnlock()

	items := make([]domain.ScreenShareSession, 0, len(s.screenShareSessions))
	for _, session := range s.screenShareSessions {
		items = append(items, session)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].ChannelID != items[j].ChannelID {
			return items[i].ChannelID < items[j].ChannelID
		}
		if items[i].StartedAtMS != items[j].StartedAtMS {
			return items[i].StartedAtMS < items[j].StartedAtMS
		}
		return items[i].ShareID < items[j].ShareID
	})
	return items
}

func (s *SQLiteStore) StartScreenShareSession(input domain.ScreenShareSession) (domain.ScreenShareSession, error) {
	channel, err := s.channel(input.ChannelID)
	if err != nil {
		return domain.ScreenShareSession{}, err
	}
	if channel.Type != domain.ChannelTypeVoice && channel.Type != domain.ChannelTypeTemporaryVoice {
		return domain.ScreenShareSession{}, ErrInvalidVoiceChannel
	}
	if _, found, err := s.member(input.OwnerMemberID); err != nil {
		return domain.ScreenShareSession{}, err
	} else if !found {
		return domain.ScreenShareSession{}, ErrNotFound
	}

	s.shareMu.Lock()
	defer s.shareMu.Unlock()
	for shareID, session := range s.screenShareSessions {
		if session.OwnerMemberID == input.OwnerMemberID {
			delete(s.screenShareSessions, shareID)
		}
	}
	shareID, err := auth.NewToken("share")
	if err != nil {
		return domain.ScreenShareSession{}, err
	}
	input.ShareID = shareID
	if input.StartedAtMS == 0 {
		input.StartedAtMS = time.Now().UnixMilli()
	}
	if input.ViewerMemberIDs == nil {
		input.ViewerMemberIDs = []string{}
	}
	s.screenShareSessions[input.ShareID] = input
	return input, nil
}

func (s *SQLiteStore) SetScreenShareViewer(
	shareID string,
	memberID string,
	watching bool,
) (domain.ScreenShareSession, error) {
	s.shareMu.Lock()
	defer s.shareMu.Unlock()

	session, ok := s.screenShareSessions[shareID]
	if !ok {
		return domain.ScreenShareSession{}, ErrNotFound
	}
	viewers := map[string]struct{}{}
	for _, viewerID := range session.ViewerMemberIDs {
		if viewerID != "" {
			viewers[viewerID] = struct{}{}
		}
	}
	if watching {
		viewers[memberID] = struct{}{}
	} else {
		delete(viewers, memberID)
	}
	session.ViewerMemberIDs = sortedStringKeys(viewers)
	s.screenShareSessions[shareID] = session
	return session, nil
}

func (s *SQLiteStore) RemoveScreenShareViewerFromAll(memberID string) []domain.ScreenShareSession {
	s.shareMu.Lock()
	defer s.shareMu.Unlock()

	updated := []domain.ScreenShareSession{}
	for shareID, session := range s.screenShareSessions {
		viewers := map[string]struct{}{}
		changed := false
		for _, viewerID := range session.ViewerMemberIDs {
			if viewerID == "" {
				continue
			}
			if viewerID == memberID {
				changed = true
				continue
			}
			viewers[viewerID] = struct{}{}
		}
		if !changed {
			continue
		}
		session.ViewerMemberIDs = sortedStringKeys(viewers)
		s.screenShareSessions[shareID] = session
		updated = append(updated, session)
	}
	return updated
}

func (s *SQLiteStore) EndScreenShareSession(
	shareID string,
	actorMemberID string,
	canManage bool,
) (domain.ScreenShareSession, error) {
	s.shareMu.Lock()
	defer s.shareMu.Unlock()

	session, ok := s.screenShareSessions[shareID]
	if !ok {
		return domain.ScreenShareSession{}, ErrNotFound
	}
	if session.OwnerMemberID != actorMemberID && !canManage {
		return domain.ScreenShareSession{}, ErrForbidden
	}
	delete(s.screenShareSessions, shareID)
	return session, nil
}

func (s *SQLiteStore) AccompanimentSessions() []domain.AccompanimentSession {
	s.shareMu.RLock()
	defer s.shareMu.RUnlock()

	items := make([]domain.AccompanimentSession, 0, len(s.accompanimentSessions))
	for _, session := range s.accompanimentSessions {
		items = append(items, session)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].ChannelID != items[j].ChannelID {
			return items[i].ChannelID < items[j].ChannelID
		}
		if items[i].StartedAtMS != items[j].StartedAtMS {
			return items[i].StartedAtMS < items[j].StartedAtMS
		}
		return items[i].SessionID < items[j].SessionID
	})
	return items
}

func (s *SQLiteStore) StartAccompanimentSession(input domain.AccompanimentSession) (domain.AccompanimentSession, error) {
	channel, err := s.channel(input.ChannelID)
	if err != nil {
		return domain.AccompanimentSession{}, err
	}
	if channel.Type != domain.ChannelTypeVoice && channel.Type != domain.ChannelTypeTemporaryVoice {
		return domain.AccompanimentSession{}, ErrInvalidVoiceChannel
	}
	if _, found, err := s.member(input.OwnerMemberID); err != nil {
		return domain.AccompanimentSession{}, err
	} else if !found {
		return domain.AccompanimentSession{}, ErrNotFound
	}

	s.shareMu.Lock()
	defer s.shareMu.Unlock()
	for _, session := range s.accompanimentSessions {
		if session.OwnerMemberID == input.OwnerMemberID {
			return domain.AccompanimentSession{}, ErrAccompanimentActive
		}
	}
	sessionID, err := auth.NewToken("acc")
	if err != nil {
		return domain.AccompanimentSession{}, err
	}
	input.SessionID = sessionID
	if input.StartedAtMS == 0 {
		input.StartedAtMS = time.Now().UnixMilli()
	}
	s.accompanimentSessions[input.SessionID] = input
	return input, nil
}

func (s *SQLiteStore) EndAccompanimentSession(
	sessionID string,
	actorMemberID string,
	canManage bool,
) (domain.AccompanimentSession, error) {
	s.shareMu.Lock()
	defer s.shareMu.Unlock()

	session, ok := s.accompanimentSessions[sessionID]
	if !ok {
		return domain.AccompanimentSession{}, ErrNotFound
	}
	if session.OwnerMemberID != actorMemberID && !canManage {
		return domain.AccompanimentSession{}, ErrForbidden
	}
	delete(s.accompanimentSessions, sessionID)
	return session, nil
}

func (s *SQLiteStore) voiceState(participantID string) (domain.VoiceState, error) {
	var state domain.VoiceState
	var micMuted int
	var audioDeafened int
	var serverMuted int
	var serverDeafened int
	var isSpeaking int
	err := s.db.QueryRow(
		`SELECT participant_uuid, member_uuid, device_uuid, mode, channel_uuid, joined_at, mic_muted, audio_deafened, server_muted, server_deafened, is_speaking
		 FROM voice_states WHERE participant_uuid = ?`,
		participantID,
	).Scan(&state.ParticipantID, &state.MemberID, &state.DeviceID, &state.Mode, &state.ChannelID, &state.JoinedAtMS, &micMuted, &audioDeafened, &serverMuted, &serverDeafened, &isSpeaking)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.VoiceState{}, ErrNotFound
	}
	if err != nil {
		return domain.VoiceState{}, err
	}
	state.MicMuted = micMuted != 0
	state.AudioDeafened = audioDeafened != 0
	state.ServerMuted = serverMuted != 0
	state.ServerDeafened = serverDeafened != 0
	state.IsSpeaking = s.voiceSpeaking[state.ParticipantID]
	return state, nil
}

func (s *SQLiteStore) memberByLocalProfileID(localProfileID string) (domain.Member, bool, error) {
	var linkedMemberID string
	if err := s.db.QueryRow(
		`SELECT member_uuid FROM member_devices WHERE local_profile_id = ?`,
		localProfileID,
	).Scan(&linkedMemberID); err == nil {
		return s.member(linkedMemberID)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return domain.Member{}, false, err
	}
	var member domain.Member
	var isOwner int
	var isBanned int
	var overrideDisplayName int
	var overrideAvatar int
	var overrideBio int
	err := s.db.QueryRow(
		`SELECT member_uuid, display_name, avatar_sha256, avatar_data_url, avatar_color, bio, profile_updated_at,
		 profile_override_display_name, profile_override_avatar, profile_override_bio, local_profile_id, is_owner, is_banned, last_seen_at
		 FROM members WHERE local_profile_id = ? ORDER BY is_owner DESC, id LIMIT 1`,
		localProfileID,
	).Scan(
		&member.MemberID,
		&member.DisplayName,
		&member.AvatarSHA256,
		&member.AvatarDataURL,
		&member.AvatarColor,
		&member.Bio,
		&member.ProfileUpdatedAtMS,
		&overrideDisplayName,
		&overrideAvatar,
		&overrideBio,
		&member.LocalProfileID,
		&isOwner,
		&isBanned,
		&member.LastSeenAtMS,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Member{}, false, nil
	}
	if err != nil {
		return domain.Member{}, false, err
	}
	member.IsOwner = isOwner != 0
	member.IsBanned = isBanned != 0
	member.ProfileOverrides = domain.ProfileOverrides{DisplayName: overrideDisplayName != 0, Avatar: overrideAvatar != 0, Bio: overrideBio != 0}
	member.RoleIDs = s.memberRoleIDs(member.MemberID)
	member.LinkedDevices = s.linkedDeviceCount(member.MemberID)
	return member, true, nil
}

func (s *SQLiteStore) memberWithCredential(memberID string) (domain.Member, string, bool) {
	var member domain.Member
	var isOwner int
	var isBanned int
	var overrideDisplayName int
	var overrideAvatar int
	var overrideBio int
	var hash string
	err := s.db.QueryRow(
		`SELECT m.member_uuid, m.display_name, m.avatar_sha256, m.avatar_data_url, m.avatar_color, m.bio, m.profile_updated_at,
		 m.profile_override_display_name, m.profile_override_avatar, m.profile_override_bio, m.local_profile_id,
		 m.is_owner, m.is_banned, m.last_seen_at, c.access_key_hash
		 FROM members m JOIN member_credentials c ON c.member_uuid = m.member_uuid
		 WHERE m.member_uuid = ? AND c.revoked_at IS NULL`,
		memberID,
	).Scan(
		&member.MemberID,
		&member.DisplayName,
		&member.AvatarSHA256,
		&member.AvatarDataURL,
		&member.AvatarColor,
		&member.Bio,
		&member.ProfileUpdatedAtMS,
		&overrideDisplayName,
		&overrideAvatar,
		&overrideBio,
		&member.LocalProfileID,
		&isOwner,
		&isBanned,
		&member.LastSeenAtMS,
		&hash,
	)
	if err != nil {
		return domain.Member{}, "", false
	}
	member.IsOwner = isOwner != 0
	member.IsBanned = isBanned != 0
	member.ProfileOverrides = domain.ProfileOverrides{DisplayName: overrideDisplayName != 0, Avatar: overrideAvatar != 0, Bio: overrideBio != 0}
	member.RoleIDs = s.memberRoleIDs(member.MemberID)
	member.LinkedDevices = s.linkedDeviceCount(member.MemberID)
	return member, hash, true
}

func (s *SQLiteStore) member(memberID string) (domain.Member, bool, error) {
	var member domain.Member
	var isOwner int
	var isBanned int
	var overrideDisplayName int
	var overrideAvatar int
	var overrideBio int
	err := s.db.QueryRow(
		`SELECT member_uuid, display_name, avatar_sha256, avatar_data_url, avatar_color, bio, profile_updated_at,
		 profile_override_display_name, profile_override_avatar, profile_override_bio, local_profile_id, is_owner, is_banned, last_seen_at
		 FROM members WHERE member_uuid = ?`,
		memberID,
	).Scan(
		&member.MemberID,
		&member.DisplayName,
		&member.AvatarSHA256,
		&member.AvatarDataURL,
		&member.AvatarColor,
		&member.Bio,
		&member.ProfileUpdatedAtMS,
		&overrideDisplayName,
		&overrideAvatar,
		&overrideBio,
		&member.LocalProfileID,
		&isOwner,
		&isBanned,
		&member.LastSeenAtMS,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Member{}, false, nil
	}
	if err != nil {
		return domain.Member{}, false, err
	}
	member.IsOwner = isOwner != 0
	member.IsBanned = isBanned != 0
	member.ProfileOverrides = domain.ProfileOverrides{DisplayName: overrideDisplayName != 0, Avatar: overrideAvatar != 0, Bio: overrideBio != 0}
	member.RoleIDs = s.memberRoleIDs(member.MemberID)
	member.LinkedDevices = s.linkedDeviceCount(member.MemberID)
	return member, true, nil
}

func (s *SQLiteStore) memberRoleIDs(memberID string) []string {
	rows, err := s.db.Query(`SELECT role_uuid FROM member_roles WHERE member_uuid = ? ORDER BY role_uuid`, memberID)
	if err != nil {
		return nil
	}
	defer rows.Close()

	var roleIDs []string
	for rows.Next() {
		var roleID string
		if err := rows.Scan(&roleID); err == nil {
			roleIDs = append(roleIDs, roleID)
		}
	}
	return roleIDs
}

func (s *SQLiteStore) role(roleID string) (domain.ServerRole, error) {
	var role domain.ServerRole
	var isEveryone int
	var displaySeparately int
	err := s.db.QueryRow(
		`SELECT role_uuid, name, color, gradient_color, icon_data_url, display_separately, position, is_everyone
		 FROM roles WHERE role_uuid = ?`,
		roleID,
	).Scan(
		&role.RoleID,
		&role.Name,
		&role.Color,
		&role.GradientColor,
		&role.IconDataURL,
		&displaySeparately,
		&role.Position,
		&isEveryone,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ServerRole{}, ErrNotFound
	}
	if err != nil {
		return domain.ServerRole{}, err
	}
	role.IsEveryone = isEveryone != 0
	role.DisplaySeparately = displaySeparately != 0
	role.MemberCount = s.roleMemberCount(role)
	role.Permissions = s.rolePermissions(role.RoleID)
	return role, nil
}

func (s *SQLiteStore) rolePermissions(roleID string) map[domain.Permission]bool {
	permissions := normalizedPermissions(nil)
	rows, err := s.db.Query(`SELECT permission, allowed FROM role_permissions WHERE role_uuid = ?`, roleID)
	if err != nil {
		return permissions
	}
	defer rows.Close()

	for rows.Next() {
		var permission string
		var allowed int
		if err := rows.Scan(&permission, &allowed); err == nil {
			permissions[domain.Permission(permission)] = allowed != 0
		}
	}
	return permissions
}

func (s *SQLiteStore) roleAllows(roleID string, permission domain.Permission) bool {
	var allowed int
	err := s.db.QueryRow(
		`SELECT allowed FROM role_permissions WHERE role_uuid = ? AND permission = ?`,
		roleID,
		permission,
	).Scan(&allowed)
	return err == nil && allowed != 0
}

func (s *SQLiteStore) replaceRolePermissions(tx *sql.Tx, roleID string, permissions map[domain.Permission]bool) error {
	if _, err := tx.Exec(`DELETE FROM role_permissions WHERE role_uuid = ?`, roleID); err != nil {
		return err
	}
	permissions = normalizedPermissions(permissions)
	for _, permission := range domain.AllPermissions {
		if _, err := tx.Exec(
			`INSERT INTO role_permissions (role_uuid, permission, allowed) VALUES (?, ?, ?)`,
			roleID,
			permission,
			boolInt(permissions[permission]),
		); err != nil {
			return err
		}
	}
	return nil
}

func (s *SQLiteStore) channelExists(channelID string) bool {
	var exists int
	err := s.db.QueryRow(`SELECT 1 FROM channels WHERE channel_uuid = ?`, channelID).Scan(&exists)
	return err == nil
}

func (s *SQLiteStore) channel(channelID string) (domain.Channel, error) {
	var channel domain.Channel
	var kind string
	var permissionSynced int
	row := s.db.QueryRow(
		`SELECT channel_uuid, parent_uuid, type, name, topic, visibility, warning_text, bitrate, user_limit,
		 permission_synced, position, default_language, localizations_json
		 FROM channels WHERE channel_uuid = ?`,
		channelID,
	)
	var localizationsJSON string
	err := row.Scan(
		&channel.ChannelID,
		&channel.ParentID,
		&kind,
		&channel.Name,
		&channel.Topic,
		&channel.Visibility,
		&channel.WarningText,
		&channel.Bitrate,
		&channel.UserLimit,
		&permissionSynced,
		&channel.Position,
		&channel.DefaultLanguage,
		&localizationsJSON,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Channel{}, ErrNotFound
	}
	if err != nil {
		return domain.Channel{}, err
	}
	channel.Type = domain.ChannelType(kind)
	channel.PermissionSynced = permissionSynced != 0
	channel.Localizations = decodeChannelLocalizations(localizationsJSON)
	return channel, nil
}

func (s *SQLiteStore) linkedDeviceCount(memberID string) int {
	var count int
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM member_devices WHERE member_uuid = ?`, memberID).Scan(&count)
	return count
}

func (s *SQLiteStore) roleMemberCount(role domain.ServerRole) int {
	var count int
	if role.IsEveryone {
		_ = s.db.QueryRow(`SELECT COUNT(*) FROM members`).Scan(&count)
		return count
	}
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM member_roles WHERE role_uuid = ?`, role.RoleID).Scan(&count)
	return count
}

func (s *SQLiteStore) message(messageID string) (domain.Message, error) {
	var message domain.Message
	err := s.db.QueryRow(
		`SELECT message_uuid, channel_uuid, author_member_uuid, content, reply_to_message_uuid, created_at, edited_at, deleted_at
		 FROM messages WHERE message_uuid = ? AND deleted_at = 0`,
		messageID,
	).Scan(
		&message.MessageID,
		&message.ChannelID,
		&message.AuthorID,
		&message.Content,
		&message.ReplyToMessageID,
		&message.CreatedAtMS,
		&message.EditedAtMS,
		&message.DeletedAtMS,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.Message{}, ErrNotFound
	}
	if err != nil {
		return domain.Message{}, err
	}
	return message, nil
}

func scanMessages(rows *sql.Rows) []domain.Message {
	defer rows.Close()
	messages := []domain.Message{}
	for rows.Next() {
		var message domain.Message
		if err := rows.Scan(
			&message.MessageID,
			&message.ChannelID,
			&message.AuthorID,
			&message.Content,
			&message.ReplyToMessageID,
			&message.CreatedAtMS,
			&message.EditedAtMS,
			&message.DeletedAtMS,
		); err == nil {
			messages = append(messages, message)
		}
	}
	return messages
}

func encodePermissionMap(permissions map[domain.Permission]bool) string {
	normalized := normalizedPermissions(permissions)
	raw := make(map[string]bool, len(normalized))
	for _, permission := range domain.AllPermissions {
		raw[string(permission)] = normalized[permission]
	}
	payload, err := json.Marshal(raw)
	if err != nil {
		return "{}"
	}
	return string(payload)
}

func normalizeChannelLocalizations(input map[string]domain.ChannelLocalization) map[string]domain.ChannelLocalization {
	normalized := make(map[string]domain.ChannelLocalization)
	for language, localization := range input {
		language = strings.TrimSpace(language)
		localization.Name = strings.TrimSpace(localization.Name)
		localization.Topic = strings.TrimSpace(localization.Topic)
		localization.WarningText = strings.TrimSpace(localization.WarningText)
		if language == "" || (localization.Name == "" && localization.Topic == "" && localization.WarningText == "") {
			continue
		}
		normalized[language] = localization
	}
	return normalized
}

func encodeChannelLocalizations(input map[string]domain.ChannelLocalization) string {
	raw, err := json.Marshal(normalizeChannelLocalizations(input))
	if err != nil {
		return "{}"
	}
	return string(raw)
}

func decodeChannelLocalizations(raw string) map[string]domain.ChannelLocalization {
	localizations := make(map[string]domain.ChannelLocalization)
	if json.Unmarshal([]byte(raw), &localizations) != nil {
		return map[string]domain.ChannelLocalization{}
	}
	return normalizeChannelLocalizations(localizations)
}

func decodePermissionMap(raw string) map[domain.Permission]bool {
	var decoded map[string]bool
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return normalizedPermissions(nil)
	}
	permissions := make(map[domain.Permission]bool, len(decoded))
	for permission, allowed := range decoded {
		permissions[domain.Permission(permission)] = allowed
	}
	return normalizedPermissions(permissions)
}

func (s *SQLiteStore) normalizeChannelPositions() error {
	rows, err := s.db.Query(`SELECT channel_uuid, parent_uuid, type, position FROM channels ORDER BY position, channel_uuid`)
	if err != nil {
		return err
	}
	defer rows.Close()

	type channelPosition struct {
		channelID string
		parentID  string
		kind      domain.ChannelType
		position  int
	}
	var items []channelPosition
	categoryIDs := make(map[string]bool)
	for rows.Next() {
		var item channelPosition
		var kind string
		if err := rows.Scan(&item.channelID, &item.parentID, &kind, &item.position); err != nil {
			return err
		}
		item.kind = domain.ChannelType(kind)
		if item.kind == domain.ChannelTypeCategory {
			categoryIDs[item.channelID] = true
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	groups := make(map[string][]channelPosition)
	for _, item := range items {
		groupID := ""
		if item.kind != domain.ChannelTypeCategory && item.parentID != "" && categoryIDs[item.parentID] {
			groupID = item.parentID
		}
		groups[groupID] = append(groups[groupID], item)
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	for parentID, group := range groups {
		sort.Slice(group, func(i, j int) bool {
			if group[i].position != group[j].position {
				return group[i].position < group[j].position
			}
			return group[i].channelID < group[j].channelID
		})
		for index, item := range group {
			position := (index + 1) * 1000
			normalizedParentID := parentID
			if item.kind == domain.ChannelTypeCategory {
				normalizedParentID = ""
			}
			if _, err = tx.Exec(
				`UPDATE channels SET parent_uuid = ?, position = ? WHERE channel_uuid = ?`,
				normalizedParentID,
				position,
				item.channelID,
			); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func nonEmpty(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func normalizeServerVisibility(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "private") {
		return "private"
	}
	return "public"
}

var _ Store = (*SQLiteStore)(nil)
