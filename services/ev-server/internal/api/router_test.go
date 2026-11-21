package api_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/echovoice/echovoice/services/ev-server/internal/api"
	"github.com/echovoice/echovoice/services/ev-server/internal/auth"
	"github.com/echovoice/echovoice/services/ev-server/internal/buildinfo"
	"github.com/echovoice/echovoice/services/ev-server/internal/config"
	"github.com/echovoice/echovoice/services/ev-server/internal/domain"
	"github.com/echovoice/echovoice/services/ev-server/internal/store"
	"github.com/echovoice/echovoice/services/ev-server/internal/ws"
	"nhooyr.io/websocket"
	"nhooyr.io/websocket/wsjson"
)

func TestVersionCompatibilityIsReported(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	outdated := connectProfile(t, server.URL, domain.ProfileInput{
		DisplayName:    "Outdated client",
		LocalProfileID: "outdated-client-device",
		ClientVersion:  "0.0.9",
	})
	if outdated.PublicServerVersion != buildinfo.PublicVersion() ||
		outdated.ServerCompatibilityVersion != buildinfo.CompatibilityVersion ||
		outdated.MinimumClientVersion != buildinfo.MinimumClientVersion {
		t.Fatalf("unexpected connect version metadata: %+v", outdated)
	}
	if !outdated.ClientUpdateRequired {
		t.Fatalf("expected outdated client to require an update: %+v", outdated)
	}

	summary := requestJSON[struct {
		PublicServerVersion        string `json:"public_server_version"`
		ServerCompatibilityVersion string `json:"server_compatibility_version"`
		MinimumClientVersion       string `json:"minimum_client_version"`
	}](t, http.MethodGet, server.URL+"/api/v1/server", "", nil, http.StatusOK)
	if summary.PublicServerVersion != buildinfo.PublicVersion() ||
		summary.ServerCompatibilityVersion != buildinfo.CompatibilityVersion ||
		summary.MinimumClientVersion != buildinfo.MinimumClientVersion {
		t.Fatalf("unexpected server summary version metadata: %+v", summary)
	}

	refreshed := requestJSON[domain.SessionRefreshResponse](
		t,
		http.MethodPost,
		server.URL+"/api/v1/session/refresh",
		"",
		domain.SessionRefreshRequest{
			ServerID:      outdated.ServerID,
			MemberID:      outdated.MemberID,
			AccessKey:     outdated.AccessKey,
			ClientVersion: buildinfo.MinimumClientVersion,
		},
		http.StatusOK,
	)
	if refreshed.ClientUpdateRequired ||
		refreshed.PublicServerVersion != buildinfo.PublicVersion() ||
		refreshed.ServerCompatibilityVersion != buildinfo.CompatibilityVersion {
		t.Fatalf("unexpected refreshed version metadata: %+v", refreshed)
	}
}

func TestOwnerCanManageChannels(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	channel := requestJSON[domain.Channel](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels",
		owner.SessionToken,
		map[string]string{"type": "text", "name": "planning"},
		http.StatusCreated,
	)
	if channel.ChannelID == "" || channel.Name != "planning" {
		t.Fatalf("unexpected created channel: %+v", channel)
	}

	updated := requestJSON[domain.Channel](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/channels/"+channel.ChannelID,
		owner.SessionToken,
		map[string]string{"name": "roadmap"},
		http.StatusOK,
	)
	if updated.Name != "roadmap" {
		t.Fatalf("expected updated channel name roadmap, got %q", updated.Name)
	}

	deleted := requestJSON[domain.Channel](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/channels/"+channel.ChannelID,
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	if deleted.ChannelID != channel.ChannelID {
		t.Fatalf("expected deleted channel %s, got %s", channel.ChannelID, deleted.ChannelID)
	}
}

func TestRTCConfigReturnsTemporaryTURNCredentials(t *testing.T) {
	cfg := config.Config{
		RTC: config.RTCConfig{
			STUNURLs: []string{"stun:stun.example.com:3478"},
			TURN: config.TURNConfig{
				Enabled:    true,
				PublicHost: "relay.example.com",
				Port:       3478,
				TCPEnabled: true,
				AuthSecret: "rtc-config-test-secret",
			},
		},
	}
	server := newTestServerWithConfig(t, cfg)
	defer server.Close()

	member := connectMember(t, server.URL, "RTC User")
	result := requestJSON[domain.RTCConfig](
		t,
		http.MethodGet,
		server.URL+"/api/v1/rtc-config",
		member.SessionToken,
		nil,
		http.StatusOK,
	)
	if len(result.IceServers) != 2 {
		t.Fatalf("expected STUN and TURN entries, got %+v", result.IceServers)
	}
	turnServer := result.IceServers[1]
	joinedURLs := strings.Join(turnServer.URLs, " ")
	if !strings.Contains(joinedURLs, "turn:relay.example.com:3478?transport=udp") ||
		!strings.Contains(joinedURLs, "turn:relay.example.com:3478?transport=tcp") {
		t.Fatalf("expected UDP and TCP TURN URLs, got %+v", turnServer.URLs)
	}
	if turnServer.Username == "" || turnServer.Credential == "" {
		t.Fatalf("expected temporary TURN credentials, got %+v", turnServer)
	}
}

func TestContentAssetsAreValidatedDeduplicatedAndDownloadable(t *testing.T) {
	appStore := store.NewMemoryStore("EchoVoice Test")
	settings := appStore.Server()
	settings.SoundboardEnabled = true
	settings.EmojiEnabled = true
	settings.EmojiMaxKB = 1
	appStore.UpdateServer(settings)
	server := httptest.NewServer(api.NewRouter(
		config.Config{Storage: config.StorageConfig{
			ContentPath:     t.TempDir(),
			MaxSoundboardKB: 64,
			MaxEmojiKB:      64,
		}},
		appStore,
		ws.NewHub(),
		auth.NewSessionStore(time.Hour),
	))
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	wave := []byte("RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x40\x1f\x00\x00\x80\x3e\x00\x00\x02\x00\x10\x00data\x00\x00\x00\x00")
	asset := uploadMultipartAsset(t, server.URL, owner.SessionToken, "soundboard", "tone.wav", "audio/wav", wave, http.StatusCreated)
	expectedSHA := sha256.Sum256(wave)
	if asset.SHA256 != fmt.Sprintf("%x", expectedSHA) || asset.SizeBytes != int64(len(wave)) || asset.StoragePath != "" {
		t.Fatalf("unexpected public content asset: %+v", asset)
	}
	duplicate := uploadMultipartAsset(t, server.URL, owner.SessionToken, "soundboard", "tone-copy.wav", "audio/wav", wave, http.StatusCreated)
	if duplicate.SHA256 != asset.SHA256 {
		t.Fatalf("expected duplicate upload to reuse sha256 %s, got %s", asset.SHA256, duplicate.SHA256)
	}

	req, err := http.NewRequest(http.MethodGet, server.URL+"/api/v1/assets/"+asset.SHA256, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+owner.SessionToken)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	downloaded, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || !bytes.Equal(downloaded, wave) {
		t.Fatalf("unexpected asset download status=%d bytes=%d", response.StatusCode, len(downloaded))
	}
	if response.Header.Get("ETag") != `"`+asset.SHA256+`"` || !strings.Contains(response.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("expected immutable sha256 cache headers, got ETag=%q Cache-Control=%q", response.Header.Get("ETag"), response.Header.Get("Cache-Control"))
	}

	png := append([]byte{0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a}, bytes.Repeat([]byte{0}, 64)...)
	emoji := uploadMultipartAsset(t, server.URL, owner.SessionToken, "emoji", "wave.png", "image/png", png, http.StatusCreated)
	if emoji.MimeType != "image/png" {
		t.Fatalf("expected detected PNG mime type, got %q", emoji.MimeType)
	}
	uploadMultipartAsset(t, server.URL, owner.SessionToken, "emoji", "too-large.png", "image/png", append(png, bytes.Repeat([]byte{0}, 1024)...), http.StatusRequestEntityTooLarge)
	uploadMultipartAsset(t, server.URL, owner.SessionToken, "emoji", "unsafe.svg", "image/svg+xml", []byte("<svg></svg>"), http.StatusUnsupportedMediaType)

	member := connectMember(t, server.URL, "Member")
	uploadMultipartAsset(t, server.URL, member.SessionToken, "soundboard", "member-default.wav", "audio/wav", wave, http.StatusCreated)
	setEveryonePermission(t, server.URL, owner.SessionToken, domain.PermissionPlaySoundboard, false)
	uploadMultipartAsset(t, server.URL, member.SessionToken, "soundboard", "blocked.wav", "audio/wav", wave, http.StatusForbidden)
}

func TestChannelFilesUseGlobalCacheAndIndependentPermissions(t *testing.T) {
	contentRoot := t.TempDir()
	appStore := store.NewMemoryStore("EchoVoice Test")
	settings := appStore.Server()
	settings.FileStorageEnabled = true
	appStore.UpdateServer(settings)
	server := httptest.NewServer(api.NewRouter(
		config.Config{Storage: config.StorageConfig{ContentPath: contentRoot, MaxChannelFileMB: 8}},
		appStore,
		ws.NewHub(),
		auth.NewSessionStore(time.Hour),
	))
	defer server.Close()

	owner := connectMember(t, server.URL, "File Owner")
	member := connectMember(t, server.URL, "File Member")
	intruder := connectMember(t, server.URL, "File Intruder")
	channelA := requestJSON[domain.Channel](t, http.MethodPost, server.URL+"/api/v1/channels", owner.SessionToken, map[string]string{"type": "text", "name": "files-a"}, http.StatusCreated)
	channelB := requestJSON[domain.Channel](t, http.MethodPost, server.URL+"/api/v1/channels", owner.SessionToken, map[string]string{"type": "text", "name": "files-b"}, http.StatusCreated)
	content := []byte("same bytes across two channel roots")
	first := uploadChannelFileForTest(t, server.URL, member.SessionToken, channelA.ChannelID, "first.txt", "text/plain", content, "", http.StatusCreated)
	if first.OwnerMemberID != member.MemberID {
		t.Fatalf("expected uploader to own file, got %+v", first)
	}

	linked := requestJSON[domain.ChannelFileEntry](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+channelB.ChannelID+"/files",
		member.SessionToken,
		map[string]any{
			"type":         "file",
			"name":         "linked.txt",
			"asset_sha256": first.AssetSHA256,
			"size_bytes":   len(content),
		},
		http.StatusCreated,
	)
	if linked.EntryID == first.EntryID || linked.AssetSHA256 != first.AssetSHA256 {
		t.Fatalf("expected a distinct entry referencing the same asset: first=%+v linked=%+v", first, linked)
	}
	requestJSON[map[string]any](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/channels/"+channelB.ChannelID+"/files/"+linked.EntryID,
		intruder.SessionToken,
		map[string]any{"name": "stolen.txt", "parent_id": ""},
		http.StatusForbidden,
	)
	regularFiles := 0
	if err := filepath.WalkDir(contentRoot, func(_ string, entry os.DirEntry, err error) error {
		if err == nil && entry.Type().IsRegular() {
			regularFiles++
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if regularFiles != 1 {
		t.Fatalf("expected one content-addressed object, got %d", regularFiles)
	}
	setEveryonePermission(t, server.URL, owner.SessionToken, domain.PermissionDownloadFiles, false)
	listOnly := requestJSON[struct {
		Entries []domain.ChannelFileEntry `json:"entries"`
	}](t, http.MethodGet, server.URL+"/api/v1/channels/"+channelB.ChannelID+"/files", member.SessionToken, nil, http.StatusOK)
	if len(listOnly.Entries) != 1 || listOnly.Entries[0].AssetSHA256 != "" {
		t.Fatalf("expected list-only response to hide content hash, got %+v", listOnly.Entries)
	}
	setEveryonePermission(t, server.URL, owner.SessionToken, domain.PermissionDownloadFiles, true)

	directory := requestJSON[domain.ChannelFileEntry](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+channelB.ChannelID+"/files",
		owner.SessionToken,
		map[string]any{"type": "directory", "name": "private-folder"},
		http.StatusCreated,
	)
	setEveryonePermission(t, server.URL, owner.SessionToken, domain.PermissionViewFiles, false)
	setEveryonePermission(t, server.URL, owner.SessionToken, domain.PermissionDownloadFiles, false)
	setEveryonePermission(t, server.URL, owner.SessionToken, domain.PermissionManageFiles, false)
	setEveryonePermission(t, server.URL, owner.SessionToken, domain.PermissionUploadFiles, true)

	requestJSON[map[string]any](t, http.MethodGet, server.URL+"/api/v1/channels/"+channelB.ChannelID+"/files", member.SessionToken, nil, http.StatusForbidden)
	rootOnly := requestJSON[domain.ChannelFileEntry](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+channelB.ChannelID+"/files",
		member.SessionToken,
		map[string]any{
			"type":         "file",
			"name":         "root-only.txt",
			"parent_id":    directory.EntryID,
			"asset_sha256": first.AssetSHA256,
			"size_bytes":   len(content),
		},
		http.StatusCreated,
	)
	if rootOnly.ParentID != "" {
		t.Fatalf("expected upload-only member file in root, got parent %q", rootOnly.ParentID)
	}
	requestJSON[map[string]any](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+channelB.ChannelID+"/files",
		member.SessionToken,
		map[string]any{"type": "directory", "name": "forbidden"},
		http.StatusForbidden,
	)
	renamed := requestJSON[domain.ChannelFileEntry](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/channels/"+channelB.ChannelID+"/files/"+rootOnly.EntryID,
		member.SessionToken,
		map[string]any{"name": "owned.txt", "parent_id": ""},
		http.StatusOK,
	)
	if renamed.Name != "owned.txt" {
		t.Fatalf("expected owner rename, got %+v", renamed)
	}
	requestJSON[map[string]any](t, http.MethodGet, server.URL+"/api/v1/channels/"+channelB.ChannelID+"/files/"+rootOnly.EntryID, member.SessionToken, nil, http.StatusForbidden)

	setEveryonePermission(t, server.URL, owner.SessionToken, domain.PermissionUploadFiles, false)
	setEveryonePermission(t, server.URL, owner.SessionToken, domain.PermissionDownloadFiles, true)
	metadata := requestJSON[domain.ChannelFileEntry](
		t,
		http.MethodGet,
		server.URL+"/api/v1/channels/"+channelB.ChannelID+"/files/"+rootOnly.EntryID+"?metadata=1",
		member.SessionToken,
		nil,
		http.StatusOK,
	)
	if metadata.OwnerMemberID != member.MemberID || metadata.AssetSHA256 != first.AssetSHA256 {
		t.Fatalf("expected downloadable file metadata to include owner and sha256, got %+v", metadata)
	}
	listing := requestJSON[struct {
		Entries []domain.ChannelFileEntry `json:"entries"`
	}](t, http.MethodGet, server.URL+"/api/v1/channels/"+channelB.ChannelID+"/files", member.SessionToken, nil, http.StatusOK)
	if len(listing.Entries) == 0 {
		t.Fatal("expected download permission to imply file-list access")
	}
	response, err := http.NewRequest(http.MethodGet, server.URL+"/api/v1/channels/"+channelB.ChannelID+"/files/"+rootOnly.EntryID, nil)
	if err != nil {
		t.Fatal(err)
	}
	response.Header.Set("Authorization", "Bearer "+member.SessionToken)
	download, err := http.DefaultClient.Do(response)
	if err != nil {
		t.Fatal(err)
	}
	defer download.Body.Close()
	if download.StatusCode != http.StatusOK {
		t.Fatalf("expected download permission to fetch file, got %d", download.StatusCode)
	}
}

func TestMessageImagesAreChannelScopedAndExcludedFromFileStorage(t *testing.T) {
	contentRoot := t.TempDir()
	appStore := store.NewMemoryStore("EchoVoice Test")
	settings := appStore.Server()
	settings.FileStorageEnabled = true
	appStore.UpdateServer(settings)
	server := httptest.NewServer(api.NewRouter(
		config.Config{Storage: config.StorageConfig{ContentPath: contentRoot, MaxChannelFileMB: 8}},
		appStore,
		ws.NewHub(),
		auth.NewSessionStore(time.Hour),
	))
	defer server.Close()

	owner := connectMember(t, server.URL, "Image Owner")
	member := connectMember(t, server.URL, "Image Member")
	channelA := requestJSON[domain.Channel](t, http.MethodPost, server.URL+"/api/v1/channels", owner.SessionToken, map[string]string{"type": "text", "name": "images-a"}, http.StatusCreated)
	channelB := requestJSON[domain.Channel](t, http.MethodPost, server.URL+"/api/v1/channels", owner.SessionToken, map[string]string{"type": "text", "name": "images-b"}, http.StatusCreated)
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0x2a}, 128)...)
	first := uploadMessageImageForTest(t, server.URL, member.SessionToken, channelA.ChannelID, "pasted.png", "image/png", png, http.StatusCreated)
	duplicate := uploadMessageImageForTest(t, server.URL, member.SessionToken, channelA.ChannelID, "same.png", "image/png", png, http.StatusCreated)
	if first.SHA256 == "" || duplicate.SHA256 != first.SHA256 {
		t.Fatalf("expected duplicate message images to share one asset: first=%+v duplicate=%+v", first, duplicate)
	}

	listing := requestJSON[struct {
		Entries []domain.ChannelFileEntry `json:"entries"`
	}](t, http.MethodGet, server.URL+"/api/v1/channels/"+channelA.ChannelID+"/files", member.SessionToken, nil, http.StatusOK)
	if len(listing.Entries) != 0 {
		t.Fatalf("message images must not appear in the channel file list: %+v", listing.Entries)
	}

	requestMessageImage(t, server.URL, member.SessionToken, channelA.ChannelID, first.SHA256, http.StatusOK, png)
	requestMessageImage(t, server.URL, member.SessionToken, channelB.ChannelID, first.SHA256, http.StatusNotFound, nil)
	linkedAcrossChannels := uploadMessageImageForTest(t, server.URL, member.SessionToken, channelB.ChannelID, "same-again.png", "image/png", png, http.StatusCreated)
	if linkedAcrossChannels.SHA256 != first.SHA256 {
		t.Fatalf("expected cross-channel upload to reuse cached content: %+v", linkedAcrossChannels)
	}
	requestMessageImage(t, server.URL, member.SessionToken, channelB.ChannelID, first.SHA256, http.StatusOK, png)

	token := fmt.Sprintf("<:image:%s:%d:png:pasted.png>", first.SHA256, first.SizeBytes)
	message := requestJSON[domain.Message](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+channelA.ChannelID+"/messages",
		member.SessionToken,
		map[string]string{"content": "caption\n" + token},
		http.StatusCreated,
	)
	if message.Content != "caption\n"+token {
		t.Fatalf("unexpected message image content: %q", message.Content)
	}
	requestJSON[map[string]any](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+channelA.ChannelID+"/messages",
		member.SessionToken,
		map[string]string{"content": fmt.Sprintf("<:image:%s:%d:png:pasted.png>", first.SHA256, first.SizeBytes+1)},
		http.StatusBadRequest,
	)

	regularFiles := 0
	if err := filepath.WalkDir(contentRoot, func(_ string, entry os.DirEntry, err error) error {
		if err == nil && entry.Type().IsRegular() {
			regularFiles++
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if regularFiles != 1 {
		t.Fatalf("expected one content-addressed image object, got %d", regularFiles)
	}

	setEveryonePermission(t, server.URL, owner.SessionToken, domain.PermissionSendMessages, false)
	uploadMessageImageForTest(t, server.URL, member.SessionToken, channelA.ChannelID, "blocked.png", "image/png", png, http.StatusForbidden)
}

func TestSoundboardServerItemsPlaybackPermissionsAndAudit(t *testing.T) {
	appStore := store.NewMemoryStore("EchoVoice Test")
	settings := appStore.Server()
	settings.SoundboardEnabled = true
	appStore.UpdateServer(settings)
	server := httptest.NewServer(api.NewRouter(
		config.Config{Storage: config.StorageConfig{ContentPath: t.TempDir(), MaxSoundboardKB: 64}},
		appStore,
		ws.NewHub(),
		auth.NewSessionStore(time.Hour),
	))
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")
	wave := []byte("RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x40\x1f\x00\x00\x80\x3e\x00\x00\x02\x00\x10\x00data\x00\x00\x00\x00")
	item := uploadServerSoundboardItem(t, server.URL, owner.SessionToken, "Alert", "alert.wav", wave, http.StatusCreated)
	if item.ItemID == "" || item.Name != "Alert" || item.AssetSHA256 == "" {
		t.Fatalf("unexpected soundboard item: %+v", item)
	}
	items := requestJSON[struct {
		Items []domain.SoundboardItem `json:"items"`
	}](t, http.MethodGet, server.URL+"/api/v1/soundboard", owner.SessionToken, nil, http.StatusOK).Items
	if len(items) != 1 || items[0].ItemID != item.ItemID {
		t.Fatalf("expected uploaded soundboard item, got %+v", items)
	}
	item = requestJSON[domain.SoundboardItem](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/soundboard/"+item.ItemID,
		owner.SessionToken,
		map[string]any{"name": "Alert clip", "icon_emoji": "🔔", "start_ms": 250, "end_ms": 1000, "base_volume": 0.8},
		http.StatusOK,
	)
	if item.Name != "Alert clip" || item.IconEmoji != "🔔" || item.StartMS != 250 || item.EndMS != 1000 || item.BaseVolume != 0.8 {
		t.Fatalf("soundboard metadata update was not persisted: %+v", item)
	}
	uploadServerSoundboardItem(t, server.URL, owner.SessionToken, "alert clip", "duplicate.wav", wave, http.StatusConflict)
	uploadServerSoundboardItem(t, server.URL, member.SessionToken, "Blocked", "blocked.wav", wave, http.StatusForbidden)

	voiceChannel := firstChannelOfType(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice)
	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	playback := requestJSON[domain.SoundboardPlayback](
		t,
		http.MethodPost,
		server.URL+"/api/v1/soundboard/play",
		owner.SessionToken,
		map[string]any{"channel_id": voiceChannel.ChannelID, "item_id": item.ItemID, "volume": 1.25},
		http.StatusCreated,
	)
	if playback.PlaybackID == "" || playback.ChannelID != voiceChannel.ChannelID || playback.AssetSHA256 != item.AssetSHA256 || playback.BaseVolume != 0.8 || playback.SenderVolume != 1.25 || playback.Volume != 1 || playback.StartMS != 250 || playback.EndMS != 1000 {
		t.Fatalf("unexpected soundboard playback: %+v", playback)
	}
	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/soundboard/play",
		owner.SessionToken,
		map[string]any{"channel_id": voiceChannel.ChannelID, "item_id": item.ItemID},
		http.StatusTooManyRequests,
	)
	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/soundboard/play",
		member.SessionToken,
		map[string]any{"channel_id": voiceChannel.ChannelID, "item_id": item.ItemID},
		http.StatusForbidden,
	)

	logs := requestJSON[struct {
		AuditLogs []domain.AuditLog `json:"audit_logs"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/audit-logs?action=soundboard.play",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).AuditLogs
	if len(logs) != 1 || logs[0].TargetID != playback.PlaybackID || logs[0].Details["sha256"] != item.AssetSHA256 {
		t.Fatalf("expected soundboard playback audit, got %+v", logs)
	}
	deleted := requestJSON[domain.SoundboardItem](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/soundboard/"+item.ItemID,
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	if deleted.ItemID != item.ItemID {
		t.Fatalf("unexpected deleted soundboard item: %+v", deleted)
	}
}

func TestCustomEmojiCRUDMessageValidationAndAudit(t *testing.T) {
	appStore := store.NewMemoryStore("EchoVoice Test")
	settings := appStore.Server()
	settings.EmojiEnabled = true
	settings.EmojiMaxKB = 2048
	appStore.UpdateServer(settings)
	server := httptest.NewServer(api.NewRouter(
		config.Config{Storage: config.StorageConfig{ContentPath: t.TempDir(), MaxEmojiKB: 4096}},
		appStore,
		ws.NewHub(),
		auth.NewSessionStore(time.Hour),
	))
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")
	gif := append([]byte("GIF89a"), bytes.Repeat([]byte{0}, 96)...)
	emoji := uploadServerEmoji(t, server.URL, owner.SessionToken, "echo_wave", "wave.gif", "image/gif", gif, http.StatusCreated)
	if emoji.EmojiID == "" || emoji.Shortcode != "echo_wave" || emoji.AssetSHA256 == "" || !emoji.IsGIF || emoji.MimeType != "image/gif" {
		t.Fatalf("unexpected custom emoji: %+v", emoji)
	}
	emojis := requestJSON[struct {
		Emojis []domain.CustomEmoji `json:"emojis"`
	}](t, http.MethodGet, server.URL+"/api/v1/emojis", owner.SessionToken, nil, http.StatusOK).Emojis
	if len(emojis) != 1 || emojis[0].EmojiID != emoji.EmojiID {
		t.Fatalf("expected uploaded custom emoji, got %+v", emojis)
	}
	uploadServerEmoji(t, server.URL, owner.SessionToken, "echo_wave", "duplicate.gif", "image/gif", gif, http.StatusConflict)
	uploadServerEmoji(t, server.URL, owner.SessionToken, "ECHO_WAVE", "uppercase.gif", "image/gif", gif, http.StatusBadRequest)
	uploadServerEmoji(t, server.URL, owner.SessionToken, "emoji_id_long", "long.gif", "image/gif", gif, http.StatusBadRequest)
	uploadServerEmoji(t, server.URL, owner.SessionToken, "", "missing.gif", "image/gif", gif, http.StatusBadRequest)
	uploadServerEmoji(t, server.URL, member.SessionToken, "blocked", "blocked.gif", "image/gif", gif, http.StatusForbidden)
	updated := requestJSON[domain.CustomEmoji](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/emojis/"+emoji.EmojiID,
		owner.SessionToken,
		map[string]any{"shortcode": "echo_hello"},
		http.StatusOK,
	)
	if updated.EmojiID != emoji.EmojiID || updated.Shortcode != "echo_hello" || updated.AssetSHA256 != emoji.AssetSHA256 || updated.UpdatedAtMS < emoji.UpdatedAtMS {
		t.Fatalf("unexpected updated custom emoji: %+v", updated)
	}
	requestJSON[domain.APIError](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/emojis/"+emoji.EmojiID,
		member.SessionToken,
		map[string]any{"shortcode": "blocked"},
		http.StatusForbidden,
	)
	emoji = updated

	textChannel := firstChannelOfType(t, server.URL, owner.SessionToken, domain.ChannelTypeText)
	token := fmt.Sprintf("<:ev:%s:%s:%d:gif>", emoji.Shortcode, emoji.AssetSHA256, emoji.SizeBytes)
	message := requestJSON[domain.Message](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/messages",
		owner.SessionToken,
		map[string]any{"content": "hello " + token + " world"},
		http.StatusCreated,
	)
	if message.Content != "hello "+token+" world" {
		t.Fatalf("expected emoji token to remain lossless, got %q", message.Content)
	}
	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/messages",
		owner.SessionToken,
		map[string]any{"content": fmt.Sprintf("<:ev:%s:%s:%d:gif>", emoji.Shortcode, emoji.AssetSHA256, emoji.SizeBytes+1)},
		http.StatusBadRequest,
	)
	requestJSON[domain.Message](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/messages",
		member.SessionToken,
		map[string]any{"content": token},
		http.StatusCreated,
	)
	setEveryonePermission(t, server.URL, owner.SessionToken, domain.PermissionSendEmoji, false)
	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/messages",
		member.SessionToken,
		map[string]any{"content": "blocked " + token},
		http.StatusForbidden,
	)

	logs := requestJSON[struct {
		AuditLogs []domain.AuditLog `json:"audit_logs"`
	}](t, http.MethodGet, server.URL+"/api/v1/audit-logs?action=emoji.create", owner.SessionToken, nil, http.StatusOK).AuditLogs
	if len(logs) != 1 || logs[0].TargetID != emoji.EmojiID || logs[0].Details["sha256"] != emoji.AssetSHA256 {
		t.Fatalf("expected emoji create audit, got %+v", logs)
	}
	shortID := uploadServerEmoji(t, server.URL, owner.SessionToken, "x", "short.gif", "image/gif", gif, http.StatusCreated)
	if shortID.Shortcode != "x" {
		t.Fatalf("expected one-character lowercase emoji id to be accepted, got %+v", shortID)
	}
	deleted := requestJSON[domain.CustomEmoji](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/emojis/"+emoji.EmojiID,
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	if deleted.EmojiID != emoji.EmojiID {
		t.Fatalf("unexpected deleted custom emoji: %+v", deleted)
	}
}

func TestMemberCannotManageChannelsWithoutRole(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	_ = connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")

	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels",
		member.SessionToken,
		map[string]string{"type": "text", "name": "blocked"},
		http.StatusForbidden,
	)
}

func TestPrivateServerInviteIsRequiredAndLimitedByUseCount(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	settings := requestJSON[domain.Server](t, http.MethodGet, server.URL+"/api/v1/server", "", nil, http.StatusOK)
	settings.Visibility = "private"
	requestJSON[domain.Server](t, http.MethodPatch, server.URL+"/api/v1/server", owner.SessionToken, settings, http.StatusOK)

	profile := domain.ProfileInput{DisplayName: "Invited", LocalProfileID: "invited-local", ClientVersion: "test"}
	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/connect",
		"",
		map[string]any{"profile": profile},
		http.StatusUnauthorized,
	)

	invite := requestJSON[domain.ServerInvite](
		t,
		http.MethodPost,
		server.URL+"/api/v1/invites",
		owner.SessionToken,
		map[string]any{"expires_in_seconds": 3600, "max_uses": 1},
		http.StatusCreated,
	)
	if invite.Token == "" || invite.MaxUses != 1 {
		t.Fatalf("expected one-use invite token, got %+v", invite)
	}
	inviteList := requestJSON[struct {
		Invites []domain.ServerInvite `json:"invites"`
	}](t, http.MethodGet, server.URL+"/api/v1/invites", owner.SessionToken, nil, http.StatusOK)
	if len(inviteList.Invites) != 1 || inviteList.Invites[0].Token != invite.Token {
		t.Fatalf("expected active invite list to retain its copyable token, got %+v", inviteList.Invites)
	}
	joined := requestJSON[domain.ConnectResponse](
		t,
		http.MethodPost,
		server.URL+"/api/v1/connect",
		"",
		map[string]any{"profile": profile, "invite_token": invite.Token},
		http.StatusOK,
	)
	if joined.MemberID == "" || joined.IsOwner {
		t.Fatalf("expected invited non-owner member, got %+v", joined)
	}
	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/connect",
		"",
		map[string]any{
			"profile":      domain.ProfileInput{DisplayName: "Second", LocalProfileID: "second-local", ClientVersion: "test"},
			"invite_token": invite.Token,
		},
		http.StatusUnauthorized,
	)
}

func TestAccessibleChannelMembersFollowViewPermissionOverrides(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	visibleMember := connectMember(t, server.URL, "Visible")
	hiddenMember := connectMember(t, server.URL, "Hidden")
	channel := firstChannelOfType(t, server.URL, owner.SessionToken, domain.ChannelTypeText)

	requestJSON[domain.ChannelPermissionOverride](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+channel.ChannelID+"/permission-overrides",
		owner.SessionToken,
		domain.ChannelPermissionOverride{
			TargetType: domain.OverrideTargetMember,
			TargetID:   hiddenMember.MemberID,
			Denies: map[domain.Permission]bool{
				domain.PermissionViewChannels: true,
			},
		},
		http.StatusOK,
	)

	result := requestJSON[struct {
		MemberIDs []string `json:"member_ids"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/channels/"+channel.ChannelID+"/accessible-members",
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	memberSet := make(map[string]bool, len(result.MemberIDs))
	for _, memberID := range result.MemberIDs {
		memberSet[memberID] = true
	}
	if !memberSet[owner.MemberID] || !memberSet[visibleMember.MemberID] || memberSet[hiddenMember.MemberID] {
		t.Fatalf("unexpected accessible members: %+v", result.MemberIDs)
	}
}

func TestCORSAllowsChannelReorderPut(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	req, err := http.NewRequest(http.MethodOptions, server.URL+"/api/v1/channels/order", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", "http://127.0.0.1:5173")
	req.Header.Set("Access-Control-Request-Method", http.MethodPut)
	req.Header.Set("Access-Control-Request-Headers", "authorization,content-type")

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusNoContent {
		t.Fatalf("expected CORS preflight status 204, got %d", res.StatusCode)
	}
	if got, want := res.Header.Get("Access-Control-Allow-Methods"), "GET, POST, PUT, PATCH, DELETE, OPTIONS"; got != want {
		t.Fatalf("expected allowed methods %q, got %q", want, got)
	}
}

func TestOwnerCanMoveChannelIntoAndOutOfCategory(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	category := requestJSON[domain.Channel](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels",
		owner.SessionToken,
		map[string]string{"type": "category", "name": "Project"},
		http.StatusCreated,
	)
	channel := requestJSON[domain.Channel](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels",
		owner.SessionToken,
		map[string]string{"type": "text", "name": "notes"},
		http.StatusCreated,
	)

	moved := requestJSON[domain.Channel](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/channels/"+channel.ChannelID,
		owner.SessionToken,
		map[string]any{"parent_id": category.ChannelID, "position": 8},
		http.StatusOK,
	)
	if moved.ParentID != category.ChannelID || moved.Position != 8 {
		t.Fatalf("expected moved channel under category at position 8, got %+v", moved)
	}

	uncategorized := requestJSON[domain.Channel](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/channels/"+channel.ChannelID,
		owner.SessionToken,
		map[string]any{"parent_id": "", "position": 2},
		http.StatusOK,
	)
	if uncategorized.ParentID != "" || uncategorized.Position != 2 {
		t.Fatalf("expected uncategorized channel at position 2, got %+v", uncategorized)
	}
}

func TestDeletingCategoryKeepsChildrenUncategorized(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	category := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeCategory, "Project", "")
	textChannel := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeText, "notes", category.ChannelID)
	voiceChannel := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice, "standup", category.ChannelID)

	deleted := requestJSON[domain.Channel](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/channels/"+category.ChannelID,
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	if deleted.ChannelID != category.ChannelID {
		t.Fatalf("expected deleted category %s, got %s", category.ChannelID, deleted.ChannelID)
	}

	channels := listChannels(t, server.URL, owner.SessionToken)
	if findChannel(t, channels, textChannel.ChannelID).ParentID != "" {
		t.Fatalf("expected text channel to move to top level, got %+v", findChannel(t, channels, textChannel.ChannelID))
	}
	if findChannel(t, channels, voiceChannel.ChannelID).ParentID != "" {
		t.Fatalf("expected voice channel to move to top level, got %+v", findChannel(t, channels, voiceChannel.ChannelID))
	}
	for _, channel := range channels {
		if channel.ChannelID == category.ChannelID {
			t.Fatalf("expected deleted category to be absent, got %+v", channel)
		}
		if channel.ParentID == category.ChannelID {
			t.Fatalf("expected no channel to reference deleted category, got %+v", channel)
		}
	}
}

func TestEmptyMessageListReturnsArray(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	channel := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeText, "empty", "")
	payload := requestJSON[map[string]json.RawMessage](
		t,
		http.MethodGet,
		server.URL+"/api/v1/channels/"+channel.ChannelID+"/messages",
		owner.SessionToken,
		nil,
		http.StatusOK,
	)

	if got := string(bytes.TrimSpace(payload["messages"])); got != "[]" {
		t.Fatalf("expected empty messages array, got %s", got)
	}
}

func TestOwnerCanReorderChannelsAtomically(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	general := firstChannelOfType(t, server.URL, owner.SessionToken, domain.ChannelTypeText)
	voice := firstChannelOfType(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice)
	categoryA := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeCategory, "Project A", "")
	alpha := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeText, "alpha", "")
	categoryB := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeCategory, "Project B", "")
	beta := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeText, "beta", "")

	reordered := requestJSON[struct {
		Channels []domain.Channel `json:"channels"`
	}](
		t,
		http.MethodPut,
		server.URL+"/api/v1/channels/order",
		owner.SessionToken,
		map[string][]domain.ChannelOrderItem{
			"items": {
				{ChannelID: categoryA.ChannelID},
				{ChannelID: alpha.ChannelID, ParentID: categoryA.ChannelID},
				{ChannelID: beta.ChannelID, ParentID: categoryA.ChannelID},
				{ChannelID: categoryB.ChannelID},
				{ChannelID: voice.ChannelID, ParentID: categoryB.ChannelID},
				{ChannelID: general.ChannelID},
			},
		},
		http.StatusOK,
	).Channels

	assertChannelOrder(t, reordered, categoryA.ChannelID, "", 1000)
	assertChannelOrder(t, reordered, categoryB.ChannelID, "", 2000)
	assertChannelOrder(t, reordered, general.ChannelID, "", 3000)
	assertChannelOrder(t, reordered, alpha.ChannelID, categoryA.ChannelID, 1000)
	assertChannelOrder(t, reordered, beta.ChannelID, categoryA.ChannelID, 2000)
	assertChannelOrder(t, reordered, voice.ChannelID, categoryB.ChannelID, 1000)

	requestJSON[domain.APIError](
		t,
		http.MethodPut,
		server.URL+"/api/v1/channels/order",
		owner.SessionToken,
		map[string][]domain.ChannelOrderItem{
			"items": {
				{ChannelID: categoryA.ChannelID},
				{ChannelID: categoryA.ChannelID},
			},
		},
		http.StatusBadRequest,
	)

	afterRejectedOrder := listChannels(t, server.URL, owner.SessionToken)
	assertChannelOrder(t, afterRejectedOrder, alpha.ChannelID, categoryA.ChannelID, 1000)
	assertChannelOrder(t, afterRejectedOrder, voice.ChannelID, categoryB.ChannelID, 1000)
}

func TestOwnerCanSaveDetailedChannelSettings(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	category := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeCategory, "Project", "")
	textChannel := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeText, "announcements", category.ChannelID)
	voiceChannel := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice, "meeting", category.ChannelID)

	updatedText := requestJSON[domain.Channel](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID,
		owner.SessionToken,
		map[string]any{
			"name":              "rules",
			"parent_id":         category.ChannelID,
			"topic":             "**Read before posting**",
			"visibility":        "warning",
			"warning_text":      "This channel may contain sensitive material.",
			"permission_synced": true,
			"default_language":  "en-US",
			"localizations": map[string]domain.ChannelLocalization{
				"zh-CN": {Name: "规则", Topic: "发言前请阅读", WarningText: "此频道可能包含敏感内容。"},
			},
		},
		http.StatusOK,
	)
	if updatedText.Name != "rules" || updatedText.Topic != "**Read before posting**" || updatedText.Visibility != "warning" || updatedText.WarningText == "" || !updatedText.PermissionSynced || updatedText.DefaultLanguage != "en-US" || updatedText.Localizations["zh-CN"].Name != "规则" {
		t.Fatalf("unexpected detailed text channel: %+v", updatedText)
	}
	persistedText := findChannel(t, listChannels(t, server.URL, owner.SessionToken), updatedText.ChannelID)
	if persistedText.DefaultLanguage != "en-US" || persistedText.Localizations["zh-CN"].Topic != "发言前请阅读" {
		t.Fatalf("channel localization was not persisted: %+v", persistedText)
	}

	updatedVoice := requestJSON[domain.Channel](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID,
		owner.SessionToken,
		map[string]any{
			"name":              "studio",
			"parent_id":         category.ChannelID,
			"topic":             "Recording room",
			"visibility":        "default",
			"bitrate":           256000,
			"user_limit":        12,
			"permission_synced": true,
		},
		http.StatusOK,
	)
	if updatedVoice.Name != "studio" || updatedVoice.Topic != "Recording room" || updatedVoice.Bitrate != 256000 || updatedVoice.UserLimit != 12 || !updatedVoice.PermissionSynced {
		t.Fatalf("unexpected detailed voice channel: %+v", updatedVoice)
	}
}

func TestRoleOrderKeepsEveryoneAtBottom(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	first := createRole(t, server.URL, owner.SessionToken, "First", nil)
	second := createRole(t, server.URL, owner.SessionToken, "Second", nil)
	ordered := requestJSON[struct {
		Roles []domain.ServerRole `json:"roles"`
	}](
		t,
		http.MethodPut,
		server.URL+"/api/v1/roles/order",
		owner.SessionToken,
		map[string][]domain.RoleOrderItem{"items": {{RoleID: second.RoleID}, {RoleID: first.RoleID}}},
		http.StatusOK,
	).Roles

	positions := make(map[string]int, len(ordered))
	for _, role := range ordered {
		positions[role.RoleID] = role.Position
	}
	if positions[second.RoleID] != 2000 || positions[first.RoleID] != 1000 || positions[domain.EveryoneRoleID] != 0 {
		t.Fatalf("unexpected role positions after reorder: %+v", positions)
	}

	requestJSON[domain.APIError](
		t,
		http.MethodPut,
		server.URL+"/api/v1/roles/order",
		owner.SessionToken,
		map[string][]domain.RoleOrderItem{"items": {{RoleID: second.RoleID}, {RoleID: domain.EveryoneRoleID}}},
		http.StatusBadRequest,
	)
}

func TestOwnerCanCreateRoleAndAssignChannelPermission(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")

	role := createRole(t, server.URL, owner.SessionToken, "Channel Manager", map[domain.Permission]bool{
		domain.PermissionManageChannels: true,
	})
	updatedMember := assignRoles(t, server.URL, owner.SessionToken, member.MemberID, []string{role.RoleID})
	if len(updatedMember.RoleIDs) != 1 || updatedMember.RoleIDs[0] != role.RoleID {
		t.Fatalf("expected member role assignment, got %+v", updatedMember)
	}

	channel := requestJSON[domain.Channel](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels",
		member.SessionToken,
		map[string]string{"type": "text", "name": "member-created"},
		http.StatusCreated,
	)
	if channel.Name != "member-created" {
		t.Fatalf("expected assigned member to create channel, got %+v", channel)
	}
}

func TestMemberCannotSetMemberRoles(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	_ = connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")

	requestJSON[domain.APIError](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/members/"+member.MemberID+"/roles",
		member.SessionToken,
		map[string][]string{"role_ids": []string{"role_fake"}},
		http.StatusForbidden,
	)
}

func TestConnectReusesLocalProfileMember(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	reconnected := connectMember(t, server.URL, "Owner")

	if reconnected.MemberID != owner.MemberID {
		t.Fatalf("expected reconnect to reuse member id %s, got %s", owner.MemberID, reconnected.MemberID)
	}
	if !reconnected.IsOwner {
		t.Fatalf("expected owner flag to be preserved, got %+v", reconnected)
	}
}

func TestConnectSynchronizesNewestDeviceProfile(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	first := connectProfile(t, server.URL, domain.ProfileInput{
		DisplayName:        "Original",
		AvatarColor:        "#7db5e8",
		Bio:                "first revision",
		LocalProfileID:     "device-a",
		ProfileUpdatedAtMS: 1000,
	})
	newer := connectProfile(t, server.URL, domain.ProfileInput{
		DisplayName:        "Updated locally",
		AvatarColor:        "#76c7a1",
		Bio:                "newest revision",
		LocalProfileID:     "device-a",
		ProfileUpdatedAtMS: 2000,
	})
	if newer.MemberID != first.MemberID {
		t.Fatalf("expected the device to keep member id %s, got %s", first.MemberID, newer.MemberID)
	}

	stale := connectProfile(t, server.URL, domain.ProfileInput{
		DisplayName:        "Stale local copy",
		AvatarColor:        "#d79ac8",
		Bio:                "must not overwrite",
		LocalProfileID:     "device-a",
		ProfileUpdatedAtMS: 1500,
	})
	profile := requestJSON[domain.Member](
		t,
		http.MethodGet,
		server.URL+"/api/v1/profile",
		stale.SessionToken,
		nil,
		http.StatusOK,
	)
	if profile.DisplayName != "Updated locally" || profile.AvatarColor != "#76c7a1" || profile.Bio != "newest revision" || profile.ProfileUpdatedAtMS != 2000 {
		t.Fatalf("expected canonical server profile to keep the newest revision, got %+v", profile)
	}
	updated := requestJSON[domain.Member](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/profile",
		stale.SessionToken,
		map[string]string{
			"display_name":    "Updated locally",
			"avatar_data_url": "",
			"avatar_sha256":   "",
			"avatar_color":    "#8da7e8",
			"bio":             "newest revision",
		},
		http.StatusOK,
	)
	if updated.AvatarColor != "#8da7e8" {
		t.Fatalf("expected profile avatar color to update, got %+v", updated)
	}
	requestJSON[domain.APIError](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/profile",
		stale.SessionToken,
		map[string]string{"display_name": "Updated locally", "avatar_color": "blue"},
		http.StatusBadRequest,
	)
}

func TestServerProfileOverridesExcludeFieldsFromGlobalSync(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	connected := connectProfile(t, server.URL, domain.ProfileInput{
		DisplayName:        "Global name",
		AvatarColor:        "#7db5e8",
		Bio:                "Global bio",
		LocalProfileID:     "server-profile-device",
		ProfileUpdatedAtMS: 1000,
	})
	personalized := requestJSON[domain.Member](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/profile",
		connected.SessionToken,
		map[string]any{
			"scope":           "server",
			"display_name":    "Server nickname",
			"avatar_data_url": "",
			"avatar_sha256":   "",
			"avatar_color":    "#76c7a1",
			"bio":             "Server bio",
			"profile_overrides": map[string]bool{
				"display_name": true,
				"avatar":       false,
				"bio":          true,
			},
		},
		http.StatusOK,
	)
	if personalized.DisplayName != "Server nickname" || personalized.Bio != "Server bio" || !personalized.ProfileOverrides.DisplayName || !personalized.ProfileOverrides.Bio || personalized.ProfileOverrides.Avatar {
		t.Fatalf("expected server profile overrides to be persisted, got %+v", personalized)
	}

	reconnected := connectProfile(t, server.URL, domain.ProfileInput{
		DisplayName:        "New global name",
		AvatarColor:        "#d79ac8",
		Bio:                "New global bio",
		LocalProfileID:     "server-profile-device",
		ProfileUpdatedAtMS: personalized.ProfileUpdatedAtMS + 1000,
	})
	profile := requestJSON[domain.Member](t, http.MethodGet, server.URL+"/api/v1/profile", reconnected.SessionToken, nil, http.StatusOK)
	if profile.DisplayName != "Server nickname" || profile.Bio != "Server bio" || profile.AvatarColor != "#d79ac8" {
		t.Fatalf("expected only non-overridden avatar to follow global profile, got %+v", profile)
	}

	updated := requestJSON[domain.Member](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/profile",
		reconnected.SessionToken,
		map[string]any{
			"scope":           "global",
			"display_name":    "Latest global name",
			"avatar_data_url": "",
			"avatar_sha256":   "",
			"avatar_color":    "#8da7e8",
			"bio":             "Latest global bio",
		},
		http.StatusOK,
	)
	if updated.DisplayName != "Server nickname" || updated.Bio != "Server bio" || updated.AvatarColor != "#8da7e8" {
		t.Fatalf("expected global update to preserve server overrides, got %+v", updated)
	}
}

func TestLinkedDeviceCredentialAuthenticatesCanonicalMember(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectProfile(t, server.URL, domain.ProfileInput{
		DisplayName:        "Existing account",
		LocalProfileID:     "device-primary",
		ProfileUpdatedAtMS: 1000,
	})
	duplicate := connectProfile(t, server.URL, domain.ProfileInput{
		DisplayName:        "New device account",
		LocalProfileID:     "device-secondary",
		ProfileUpdatedAtMS: 2000,
	})
	linked := requestJSON[domain.Member](
		t,
		http.MethodPost,
		server.URL+"/api/v1/members/"+owner.MemberID+"/link",
		owner.SessionToken,
		map[string]string{"duplicate_member_id": duplicate.MemberID},
		http.StatusOK,
	)
	if linked.MemberID != owner.MemberID || linked.LinkedDevices != 2 {
		t.Fatalf("expected canonical member %s with two devices, got %+v", owner.MemberID, linked)
	}
	if linked.DisplayName != "Existing account" {
		t.Fatalf("expected the explicitly retained member profile to remain canonical, got %+v", linked)
	}

	refreshed := requestJSON[domain.SessionRefreshResponse](
		t,
		http.MethodPost,
		server.URL+"/api/v1/session/refresh",
		"",
		domain.SessionRefreshRequest{
			ServerID:  duplicate.ServerID,
			MemberID:  owner.MemberID,
			AccessKey: duplicate.AccessKey,
		},
		http.StatusOK,
	)
	if refreshed.MemberID != owner.MemberID {
		t.Fatalf("expected linked device to authenticate as %s, got %+v", owner.MemberID, refreshed)
	}
	updated := requestJSON[domain.Member](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/profile",
		refreshed.SessionToken,
		map[string]string{"display_name": "Edited on linked device", "bio": "synchronized automatically"},
		http.StatusOK,
	)
	if updated.MemberID != owner.MemberID || updated.DisplayName != "Edited on linked device" {
		t.Fatalf("expected the linked device to update the canonical profile, got %+v", updated)
	}

	offlineMigration := requestJSON[domain.SessionRefreshResponse](
		t,
		http.MethodPost,
		server.URL+"/api/v1/session/refresh",
		"",
		domain.SessionRefreshRequest{
			ServerID:  duplicate.ServerID,
			MemberID:  duplicate.MemberID,
			AccessKey: duplicate.AccessKey,
		},
		http.StatusOK,
	)
	if offlineMigration.MemberID != owner.MemberID {
		t.Fatalf("expected stale member id to resolve to canonical member %s, got %+v", owner.MemberID, offlineMigration)
	}
}

func TestMembersCanConfirmAccountMergeWithoutAdministratorPermission(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	target := connectProfile(t, server.URL, domain.ProfileInput{
		DisplayName:    "Account to keep",
		Bio:            "canonical profile",
		LocalProfileID: "merge-target-device",
	})
	requester := connectProfile(t, server.URL, domain.ProfileInput{
		DisplayName:    "Account to merge",
		Bio:            "must not replace canonical profile",
		LocalProfileID: "merge-requester-device",
	})
	intruder := connectMember(t, server.URL, "Unrelated member")

	socketCtx, cancelSocket := context.WithTimeout(context.Background(), 3*time.Second)
	targetConn, _, err := websocket.Dial(socketCtx, eventSocketURL(server.URL, target.SessionToken), nil)
	cancelSocket()
	if err != nil {
		t.Fatalf("connect merge target event socket: %v", err)
	}
	defer targetConn.Close(websocket.StatusNormalClosure, "")

	generated := requestJSON[struct {
		Code        string `json:"code"`
		ExpiresAtMS int64  `json:"expires_at_ms"`
	}](t, http.MethodPost, server.URL+"/api/v1/profile/merge-code", target.SessionToken, nil, http.StatusCreated)
	if len(generated.Code) != 8 || strings.Trim(generated.Code, "0123456789") != "" || generated.ExpiresAtMS <= time.Now().UnixMilli() {
		t.Fatalf("expected an expiring 8-digit merge code, got %+v", generated)
	}

	request := requestJSON[domain.MemberMergeRequest](
		t,
		http.MethodPost,
		server.URL+"/api/v1/profile/merge-requests",
		requester.SessionToken,
		map[string]string{"code": generated.Code},
		http.StatusCreated,
	)
	if request.TargetMemberID != target.MemberID || request.RequesterMemberID != requester.MemberID || request.Requester.DisplayName != "Account to merge" {
		t.Fatalf("unexpected merge request: %+v", request)
	}

	readCtx, cancelRead := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancelRead()
	for {
		var event struct {
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := wsjson.Read(readCtx, targetConn, &event); err != nil {
			t.Fatalf("read member.merge.requested event: %v", err)
		}
		if event.Type != "member.merge.requested" {
			continue
		}
		var realtimeRequest domain.MemberMergeRequest
		if err := json.Unmarshal(event.Payload, &realtimeRequest); err != nil {
			t.Fatalf("decode member.merge.requested event: %v", err)
		}
		if realtimeRequest.RequestID != request.RequestID || realtimeRequest.Requester.MemberID != requester.MemberID {
			t.Fatalf("unexpected realtime merge request: %+v", realtimeRequest)
		}
		break
	}

	requests := requestJSON[struct {
		Incoming []domain.MemberMergeRequest `json:"incoming"`
		Outgoing []domain.MemberMergeRequest `json:"outgoing"`
	}](t, http.MethodGet, server.URL+"/api/v1/profile/merge-requests", target.SessionToken, nil, http.StatusOK)
	if len(requests.Incoming) != 1 || len(requests.Outgoing) != 0 || requests.Incoming[0].RequestID != request.RequestID {
		t.Fatalf("expected target pending request list, got %+v", requests)
	}

	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/profile/merge-requests",
		intruder.SessionToken,
		map[string]string{"code": generated.Code},
		http.StatusBadRequest,
	)
	requestJSON[domain.APIError](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/profile/merge-requests/"+request.RequestID,
		intruder.SessionToken,
		map[string]string{"action": "accept"},
		http.StatusForbidden,
	)

	accepted := requestJSON[struct {
		Request domain.MemberMergeRequest `json:"request"`
		Member  domain.Member             `json:"member"`
	}](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/profile/merge-requests/"+request.RequestID,
		target.SessionToken,
		map[string]string{"action": "accept"},
		http.StatusOK,
	)
	if accepted.Request.Status != domain.MemberMergeAccepted || accepted.Member.MemberID != target.MemberID || accepted.Member.LinkedDevices != 2 {
		t.Fatalf("expected accepted merge into retained member, got %+v", accepted)
	}
	if accepted.Member.DisplayName != "Account to keep" || accepted.Member.Bio != "canonical profile" {
		t.Fatalf("expected retained profile to remain canonical, got %+v", accepted.Member)
	}
	members := listMembers(t, server.URL, target.SessionToken)
	for _, member := range members {
		if member.MemberID == requester.MemberID {
			t.Fatalf("expected merged member to be removed, got %+v", members)
		}
	}
	refreshed := requestJSON[domain.SessionRefreshResponse](
		t,
		http.MethodPost,
		server.URL+"/api/v1/session/refresh",
		"",
		domain.SessionRefreshRequest{
			ServerID:  requester.ServerID,
			MemberID:  requester.MemberID,
			AccessKey: requester.AccessKey,
			DeviceID:  "merge-requester-device",
		},
		http.StatusOK,
	)
	if refreshed.MemberID != target.MemberID {
		t.Fatalf("expected merged device credential to resolve to retained member, got %+v", refreshed)
	}
}

func TestMemberAccountMergeCanBeRejectedAndInvalidCodesAreRateLimited(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	target := connectProfile(t, server.URL, domain.ProfileInput{DisplayName: "Keep", LocalProfileID: "reject-target"})
	requester := connectProfile(t, server.URL, domain.ProfileInput{DisplayName: "Request", LocalProfileID: "reject-requester"})
	generated := requestJSON[struct {
		Code string `json:"code"`
	}](t, http.MethodPost, server.URL+"/api/v1/profile/merge-code", target.SessionToken, nil, http.StatusCreated)
	request := requestJSON[domain.MemberMergeRequest](
		t,
		http.MethodPost,
		server.URL+"/api/v1/profile/merge-requests",
		requester.SessionToken,
		map[string]string{"code": generated.Code},
		http.StatusCreated,
	)
	rejected := requestJSON[struct {
		Request domain.MemberMergeRequest `json:"request"`
	}](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/profile/merge-requests/"+request.RequestID,
		target.SessionToken,
		map[string]string{"action": "reject"},
		http.StatusOK,
	)
	if rejected.Request.Status != domain.MemberMergeRejected || len(listMembers(t, server.URL, target.SessionToken)) != 2 {
		t.Fatalf("expected rejection to retain both members, got %+v", rejected)
	}

	rateLimitedMember := connectMember(t, server.URL, "Rate limited member")
	for attempt := 0; attempt < 5; attempt++ {
		requestJSON[domain.APIError](
			t,
			http.MethodPost,
			server.URL+"/api/v1/profile/merge-requests",
			rateLimitedMember.SessionToken,
			map[string]string{"code": "00000000"},
			http.StatusBadRequest,
		)
	}
	limited := requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/profile/merge-requests",
		rateLimitedMember.SessionToken,
		map[string]string{"code": "00000000"},
		http.StatusTooManyRequests,
	)
	if limited.Code != "EV_MEMBER_MERGE_RATE_LIMITED" {
		t.Fatalf("expected merge rate-limit error, got %+v", limited)
	}
}

func TestLinkedDevicesRequireTakeoverOrListenOnlyForVoice(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	primary := connectProfile(t, server.URL, domain.ProfileInput{
		DisplayName:    "Linked account",
		LocalProfileID: "device-primary",
	})
	secondary := connectProfile(t, server.URL, domain.ProfileInput{
		DisplayName:    "Temporary device",
		LocalProfileID: "device-secondary",
	})
	requestJSON[domain.Member](
		t,
		http.MethodPost,
		server.URL+"/api/v1/members/"+primary.MemberID+"/link",
		primary.SessionToken,
		map[string]string{"duplicate_member_id": secondary.MemberID},
		http.StatusOK,
	)
	secondarySession := requestJSON[domain.SessionRefreshResponse](
		t,
		http.MethodPost,
		server.URL+"/api/v1/session/refresh",
		"",
		domain.SessionRefreshRequest{
			ServerID:  secondary.ServerID,
			MemberID:  primary.MemberID,
			AccessKey: secondary.AccessKey,
			DeviceID:  "device-secondary",
		},
		http.StatusOK,
	)
	voiceChannel := firstChannelOfType(t, server.URL, primary.SessionToken, domain.ChannelTypeVoice)
	primaryState := requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		primary.SessionToken,
		nil,
		http.StatusOK,
	)

	conflict := requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		secondarySession.SessionToken,
		map[string]any{"mode": "primary"},
		http.StatusConflict,
	)
	if conflict.Code != "EV_VOICE_DEVICE_CONFLICT" {
		t.Fatalf("expected voice device conflict, got %+v", conflict)
	}
	listener := requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		secondarySession.SessionToken,
		map[string]any{"mode": "listener"},
		http.StatusOK,
	)
	if listener.Mode != "listener" || !listener.MicMuted || listener.DeviceID != "device-secondary" {
		t.Fatalf("expected a muted listener device, got %+v", listener)
	}
	targetChannel := createChannel(t, server.URL, primary.SessionToken, domain.ChannelTypeVoice, "Linked devices", "")
	requestJSON[domain.VoiceState](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/voice-states/"+primary.MemberID,
		primary.SessionToken,
		map[string]any{"channel_id": targetChannel.ChannelID},
		http.StatusOK,
	)
	movedStates := requestJSON[struct {
		VoiceStates []domain.VoiceState `json:"voice_states"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/voice-states",
		primary.SessionToken,
		nil,
		http.StatusOK,
	).VoiceStates
	movedDeviceCount := 0
	movedListenerCount := 0
	for _, state := range movedStates {
		if state.MemberID != primary.MemberID {
			continue
		}
		movedDeviceCount++
		if state.ChannelID != targetChannel.ChannelID {
			t.Fatalf("expected all linked voice devices in %s, got %+v", targetChannel.ChannelID, movedStates)
		}
		if state.Mode == "listener" {
			movedListenerCount++
		}
	}
	if movedDeviceCount != 2 || movedListenerCount != 1 {
		t.Fatalf("expected one primary and one listener to move together, got %+v", movedStates)
	}
	requestJSON[domain.VoiceState](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/voice-states/"+primary.MemberID,
		primary.SessionToken,
		map[string]any{"channel_id": voiceChannel.ChannelID},
		http.StatusOK,
	)
	requestJSON[domain.APIError](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/voice-state",
		secondarySession.SessionToken,
		map[string]any{"mic_muted": false, "is_speaking": true},
		http.StatusForbidden,
	)

	takenOver := requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		secondarySession.SessionToken,
		map[string]any{"mode": "primary", "takeover": true},
		http.StatusOK,
	)
	if takenOver.Mode != "primary" || takenOver.DeviceID != "device-secondary" || takenOver.ParticipantID == primaryState.ParticipantID {
		t.Fatalf("expected secondary device to take over, got %+v", takenOver)
	}
	states := requestJSON[struct {
		VoiceStates []domain.VoiceState `json:"voice_states"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/voice-states",
		secondarySession.SessionToken,
		nil,
		http.StatusOK,
	).VoiceStates
	primaryCount := 0
	for _, state := range states {
		if state.MemberID == primary.MemberID && state.Mode == "primary" {
			primaryCount++
		}
	}
	if primaryCount != 1 {
		t.Fatalf("expected exactly one primary device, got %+v", states)
	}
}

func TestMemberCanLeaveAndOwnerMustTransferFirst(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")
	requestJSON[domain.APIError](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/membership",
		owner.SessionToken,
		nil,
		http.StatusConflict,
	)
	left := requestJSON[domain.Member](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/membership",
		member.SessionToken,
		nil,
		http.StatusOK,
	)
	if left.MemberID != member.MemberID {
		t.Fatalf("expected member %s to leave, got %+v", member.MemberID, left)
	}
	for _, remaining := range listMembers(t, server.URL, owner.SessionToken) {
		if remaining.MemberID == member.MemberID {
			t.Fatalf("expected left member to be removed, got %+v", remaining)
		}
	}
	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/session/refresh",
		"",
		domain.SessionRefreshRequest{
			ServerID:  member.ServerID,
			MemberID:  member.MemberID,
			AccessKey: member.AccessKey,
		},
		http.StatusUnauthorized,
	)
}

func TestPresenceHeartbeatBroadcastsOnlineState(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ownerConn, _, err := websocket.Dial(ctx, eventSocketURL(server.URL, owner.SessionToken), nil)
	if err != nil {
		t.Fatalf("connect owner event socket: %v", err)
	}
	defer ownerConn.Close(websocket.StatusNormalClosure, "")
	memberConn, _, err := websocket.Dial(ctx, eventSocketURL(server.URL, member.SessionToken), nil)
	if err != nil {
		t.Fatalf("connect member event socket: %v", err)
	}
	defer memberConn.Close(websocket.StatusNormalClosure, "")

	if err := wsjson.Write(ctx, memberConn, ws.Event{Type: "presence.heartbeat", Payload: map[string]int64{"at_ms": time.Now().UnixMilli()}}); err != nil {
		t.Fatalf("send presence heartbeat: %v", err)
	}
	var event struct {
		Type    string        `json:"type"`
		Payload domain.Member `json:"payload"`
	}
	if err := wsjson.Read(ctx, ownerConn, &event); err != nil {
		t.Fatalf("read presence event: %v", err)
	}
	if event.Type != "member.presence.updated" || event.Payload.MemberID != member.MemberID || !event.Payload.Online {
		t.Fatalf("unexpected presence event: %+v", event)
	}
}

func TestClosingEventSocketRemovesDeviceVoiceState(t *testing.T) {
	server := newTestServerWithConfig(t, config.Config{
		Realtime: config.RealtimeConfig{DisconnectGraceSeconds: 1},
	})
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	voiceChannel := requestJSON[domain.Channel](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels",
		owner.SessionToken,
		map[string]string{"type": "voice", "name": "Voice"},
		http.StatusCreated,
	)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	conn, _, err := websocket.Dial(ctx, eventSocketURL(server.URL, owner.SessionToken), nil)
	cancel()
	if err != nil {
		t.Fatalf("connect event socket: %v", err)
	}
	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	if err := conn.Close(websocket.StatusNormalClosure, "browser closed"); err != nil {
		t.Fatalf("close event socket: %v", err)
	}

	eventuallyWithin(t, 6*time.Second, func() bool {
		result := requestJSON[struct {
			VoiceStates []domain.VoiceState `json:"voice_states"`
		}](t, http.MethodGet, server.URL+"/api/v1/voice-states", owner.SessionToken, nil, http.StatusOK)
		return len(result.VoiceStates) == 0
	})
}

func TestMemberVoiceDurationEndpointReturnsTotalAndSharedTime(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")
	voiceChannel := firstChannelOfType(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice)
	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		member.SessionToken,
		nil,
		http.StatusOK,
	)
	time.Sleep(15 * time.Millisecond)

	stats := requestJSON[domain.VoiceDurationStats](
		t,
		http.MethodGet,
		server.URL+"/api/v1/members/"+member.MemberID+"/voice-duration",
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	if stats.MemberID != member.MemberID || stats.ComparedMemberID != owner.MemberID {
		t.Fatalf("unexpected voice duration members: %+v", stats)
	}
	if stats.TotalVoiceDurationMS <= 0 || stats.SharedVoiceDurationMS <= 0 {
		t.Fatalf("expected positive total and shared voice durations: %+v", stats)
	}
	if !stats.MemberActive || !stats.SharedActive {
		t.Fatalf("expected active target and shared voice session: %+v", stats)
	}

	requestJSON[domain.APIError](
		t,
		http.MethodGet,
		server.URL+"/api/v1/members/missing/voice-duration",
		owner.SessionToken,
		nil,
		http.StatusNotFound,
	)
}

func TestMemberCanJoinAndLeaveVoiceChannel(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	_ = connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")
	voiceChannel := firstChannelOfType(t, server.URL, member.SessionToken, domain.ChannelTypeVoice)

	state := requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		member.SessionToken,
		nil,
		http.StatusOK,
	)
	if state.ChannelID != voiceChannel.ChannelID || state.MemberID != member.MemberID {
		t.Fatalf("unexpected voice state: %+v", state)
	}

	states := requestJSON[struct {
		VoiceStates []domain.VoiceState `json:"voice_states"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/voice-states",
		member.SessionToken,
		nil,
		http.StatusOK,
	).VoiceStates
	if len(states) != 1 || states[0].MemberID != member.MemberID {
		t.Fatalf("expected one voice state for member, got %+v", states)
	}
	if states[0].MicMuted || states[0].AudioDeafened {
		t.Fatalf("expected fresh voice state to be unmuted, got %+v", states[0])
	}

	updated := requestJSON[domain.VoiceState](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/voice-state",
		member.SessionToken,
		map[string]bool{
			"mic_muted":      false,
			"audio_deafened": false,
			"is_speaking":    true,
		},
		http.StatusOK,
	)
	if updated.MicMuted || updated.AudioDeafened || !updated.IsSpeaking {
		t.Fatalf("expected speaking state to be active, got %+v", updated)
	}

	updated = requestJSON[domain.VoiceState](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/voice-state",
		member.SessionToken,
		map[string]bool{
			"mic_muted":      false,
			"audio_deafened": true,
			"is_speaking":    true,
		},
		http.StatusOK,
	)
	if !updated.MicMuted || !updated.AudioDeafened || updated.IsSpeaking {
		t.Fatalf("expected deafened state to also be mic-muted and not speaking, got %+v", updated)
	}

	states = requestJSON[struct {
		VoiceStates []domain.VoiceState `json:"voice_states"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/voice-states",
		member.SessionToken,
		nil,
		http.StatusOK,
	).VoiceStates
	if len(states) != 1 || !states[0].MicMuted || !states[0].AudioDeafened || states[0].IsSpeaking {
		t.Fatalf("expected updated voice state in list, got %+v", states)
	}

	left := requestJSON[domain.VoiceState](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/voice-state",
		member.SessionToken,
		nil,
		http.StatusOK,
	)
	if left.MemberID != member.MemberID || left.ChannelID != voiceChannel.ChannelID {
		t.Fatalf("unexpected left voice state: %+v", left)
	}
}

func TestSpeakingStateIsVisibleOnlyToDevicesInTheSameVoiceChannel(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	observer := connectMember(t, server.URL, "Observer")
	speaker := connectMember(t, server.URL, "Speaker")
	listener := connectMember(t, server.URL, "Listener")
	voiceChannel := firstChannelOfType(t, server.URL, speaker.SessionToken, domain.ChannelTypeVoice)

	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		speaker.SessionToken,
		nil,
		http.StatusOK,
	)
	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		listener.SessionToken,
		nil,
		http.StatusOK,
	)

	observerSocketCtx, cancelObserverSocket := context.WithTimeout(context.Background(), time.Second)
	observerConn, _, err := websocket.Dial(observerSocketCtx, eventSocketURL(server.URL, observer.SessionToken), nil)
	cancelObserverSocket()
	if err != nil {
		t.Fatalf("connect observer event socket: %v", err)
	}
	defer observerConn.Close(websocket.StatusNormalClosure, "")

	listenerSocketCtx, cancelListenerSocket := context.WithTimeout(context.Background(), time.Second)
	listenerConn, _, err := websocket.Dial(listenerSocketCtx, eventSocketURL(server.URL, listener.SessionToken), nil)
	cancelListenerSocket()
	if err != nil {
		t.Fatalf("connect listener event socket: %v", err)
	}
	defer listenerConn.Close(websocket.StatusNormalClosure, "")

	speakerSocketCtx, cancelSpeakerSocket := context.WithTimeout(context.Background(), time.Second)
	speakerConn, _, err := websocket.Dial(speakerSocketCtx, eventSocketURL(server.URL, speaker.SessionToken), nil)
	cancelSpeakerSocket()
	if err != nil {
		t.Fatalf("connect speaker event socket: %v", err)
	}
	defer speakerConn.Close(websocket.StatusNormalClosure, "")

	updated := requestJSON[domain.VoiceState](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/voice-state",
		speaker.SessionToken,
		map[string]bool{
			"mic_muted":      false,
			"audio_deafened": false,
			"is_speaking":    true,
		},
		http.StatusOK,
	)
	if !updated.IsSpeaking {
		t.Fatalf("expected speaker state to be active, got %+v", updated)
	}

	listenerReadCtx, cancelListenerRead := context.WithTimeout(context.Background(), time.Second)
	var listenerEvent struct {
		Type    string            `json:"type"`
		Payload domain.VoiceState `json:"payload"`
	}
	err = wsjson.Read(listenerReadCtx, listenerConn, &listenerEvent)
	cancelListenerRead()
	if err != nil {
		t.Fatalf("read same-channel speaking event: %v", err)
	}
	if listenerEvent.Type != "voice.speaking.updated" || listenerEvent.Payload.ParticipantID != updated.ParticipantID || !listenerEvent.Payload.IsSpeaking {
		t.Fatalf("unexpected same-channel speaking event: %+v", listenerEvent)
	}

	observerReadCtx, cancelObserverRead := context.WithTimeout(context.Background(), 200*time.Millisecond)
	var observerEvent ws.Event
	err = wsjson.Read(observerReadCtx, observerConn, &observerEvent)
	cancelObserverRead()
	if err == nil {
		t.Fatalf("speaking event leaked outside voice channel: %+v", observerEvent)
	}
	if observerReadCtx.Err() != context.DeadlineExceeded {
		t.Fatalf("read observer event socket: %v", err)
	}

	listenerStates := requestJSON[struct {
		VoiceStates []domain.VoiceState `json:"voice_states"`
	}](t, http.MethodGet, server.URL+"/api/v1/voice-states", listener.SessionToken, nil, http.StatusOK).VoiceStates
	if state, found := voiceStateForParticipant(listenerStates, updated.ParticipantID); !found || !state.IsSpeaking {
		t.Fatalf("same-channel query did not include speaking state: %+v", listenerStates)
	}

	observerStates := requestJSON[struct {
		VoiceStates []domain.VoiceState `json:"voice_states"`
	}](t, http.MethodGet, server.URL+"/api/v1/voice-states", observer.SessionToken, nil, http.StatusOK).VoiceStates
	for _, state := range observerStates {
		if state.IsSpeaking {
			t.Fatalf("channel-external query leaked speaking state: %+v", observerStates)
		}
	}

	writeSpeakingCtx, cancelWriteSpeaking := context.WithTimeout(context.Background(), time.Second)
	err = wsjson.Write(writeSpeakingCtx, speakerConn, ws.Event{
		Type:    "voice.speaking.update",
		Payload: map[string]bool{"is_speaking": false},
	})
	cancelWriteSpeaking()
	if err != nil {
		t.Fatalf("send speaking update through event socket: %v", err)
	}
	listenerReadCtx, cancelListenerRead = context.WithTimeout(context.Background(), time.Second)
	err = wsjson.Read(listenerReadCtx, listenerConn, &listenerEvent)
	cancelListenerRead()
	if err != nil {
		t.Fatalf("read event-socket speaking update: %v", err)
	}
	if listenerEvent.Type != "voice.speaking.updated" || listenerEvent.Payload.ParticipantID != updated.ParticipantID || listenerEvent.Payload.IsSpeaking {
		t.Fatalf("unexpected event-socket speaking update: %+v", listenerEvent)
	}

	requestJSON[domain.VoiceState](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/voice-state",
		listener.SessionToken,
		nil,
		http.StatusOK,
	)
	listenerStates = requestJSON[struct {
		VoiceStates []domain.VoiceState `json:"voice_states"`
	}](t, http.MethodGet, server.URL+"/api/v1/voice-states", listener.SessionToken, nil, http.StatusOK).VoiceStates
	for _, state := range listenerStates {
		if state.IsSpeaking {
			t.Fatalf("device that left voice still received speaking state: %+v", listenerStates)
		}
	}
}

func voiceStateForParticipant(states []domain.VoiceState, participantID string) (domain.VoiceState, bool) {
	for _, state := range states {
		if state.ParticipantID == participantID {
			return state, true
		}
	}
	return domain.VoiceState{}, false
}

func TestMemberCannotJoinTextChannelAsVoice(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	_ = connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")
	textChannel := firstChannelOfType(t, server.URL, member.SessionToken, domain.ChannelTypeText)

	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/voice-state",
		member.SessionToken,
		nil,
		http.StatusBadRequest,
	)
}

func TestEveryoneRoleControlsSendMessages(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")
	textChannel := firstChannelOfType(t, server.URL, member.SessionToken, domain.ChannelTypeText)

	everyone := updateRole(t, server.URL, owner.SessionToken, domain.EveryoneRoleID, "@everyone", map[domain.Permission]bool{
		domain.PermissionViewMembers:  true,
		domain.PermissionViewChannels: true,
		domain.PermissionSendMessages: false,
		domain.PermissionConnectVoice: true,
	})
	if everyone.Permissions[domain.PermissionSendMessages] {
		t.Fatalf("expected send_messages to be disabled, got %+v", everyone)
	}

	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/messages",
		member.SessionToken,
		map[string]string{"content": "blocked"},
		http.StatusForbidden,
	)

	everyone = updateRole(t, server.URL, owner.SessionToken, domain.EveryoneRoleID, "@everyone", map[domain.Permission]bool{
		domain.PermissionViewMembers:  true,
		domain.PermissionViewChannels: true,
		domain.PermissionSendMessages: true,
		domain.PermissionConnectVoice: true,
	})
	if !everyone.Permissions[domain.PermissionSendMessages] {
		t.Fatalf("expected send_messages to be enabled, got %+v", everyone)
	}

	message := requestJSON[domain.Message](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/messages",
		member.SessionToken,
		map[string]string{"content": "allowed"},
		http.StatusCreated,
	)
	if message.Content != "allowed" || message.AuthorID != member.MemberID {
		t.Fatalf("unexpected created message: %+v", message)
	}
}

func TestRoleCanGrantAndRevokeEditServerSettings(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")
	role := createRole(t, server.URL, owner.SessionToken, "Server Editor", map[domain.Permission]bool{
		domain.PermissionEditServer: true,
	})
	assignRoles(t, server.URL, owner.SessionToken, member.MemberID, []string{role.RoleID})

	currentServer := requestJSON[domain.Server](
		t,
		http.MethodGet,
		server.URL+"/api/v1/server",
		"",
		nil,
		http.StatusOK,
	)
	currentServer.Name = "Member Edited"
	requestJSON[domain.Server](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/server",
		member.SessionToken,
		currentServer,
		http.StatusOK,
	)

	updateRole(t, server.URL, owner.SessionToken, role.RoleID, role.Name, map[domain.Permission]bool{
		domain.PermissionEditServer: false,
	})

	currentServer.Name = "Blocked"
	requestJSON[domain.APIError](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/server",
		member.SessionToken,
		currentServer,
		http.StatusForbidden,
	)
}

func TestRoleHierarchyBlocksManagingHigherRoles(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")
	lowRole := createRole(t, server.URL, owner.SessionToken, "Low", map[domain.Permission]bool{
		domain.PermissionSendMessages: true,
	})
	managerRole := createRole(t, server.URL, owner.SessionToken, "Role Manager", map[domain.Permission]bool{
		domain.PermissionManageRoles: true,
	})
	highRole := createRole(t, server.URL, owner.SessionToken, "High", map[domain.Permission]bool{
		domain.PermissionAdministrator: true,
	})
	assignRoles(t, server.URL, owner.SessionToken, member.MemberID, []string{managerRole.RoleID})

	requestJSON[domain.APIError](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/roles/"+highRole.RoleID,
		member.SessionToken,
		domain.ServerRole{Name: "Blocked", Position: highRole.Position, Permissions: highRole.Permissions},
		http.StatusForbidden,
	)

	updated := requestJSON[domain.ServerRole](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/roles/"+lowRole.RoleID,
		member.SessionToken,
		domain.ServerRole{Name: "Managed Low", Position: lowRole.Position, Permissions: lowRole.Permissions},
		http.StatusOK,
	)
	if updated.Name != "Managed Low" {
		t.Fatalf("expected lower role update, got %+v", updated)
	}
}

func TestChannelPermissionOverrideCanDenyEveryoneAndAllowRole(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")
	textChannel := firstChannelOfType(t, server.URL, owner.SessionToken, domain.ChannelTypeText)

	requestJSON[domain.ChannelPermissionOverride](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/permission-overrides",
		owner.SessionToken,
		domain.ChannelPermissionOverride{
			TargetType: domain.OverrideTargetRole,
			TargetID:   domain.EveryoneRoleID,
			Denies: map[domain.Permission]bool{
				domain.PermissionSendMessages: true,
			},
		},
		http.StatusOK,
	)
	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/messages",
		member.SessionToken,
		map[string]string{"content": "blocked"},
		http.StatusForbidden,
	)

	speakerRole := createRole(t, server.URL, owner.SessionToken, "Speaker", nil)
	assignRoles(t, server.URL, owner.SessionToken, member.MemberID, []string{speakerRole.RoleID})
	requestJSON[domain.ChannelPermissionOverride](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/permission-overrides",
		owner.SessionToken,
		domain.ChannelPermissionOverride{
			TargetType: domain.OverrideTargetRole,
			TargetID:   speakerRole.RoleID,
			Allows: map[domain.Permission]bool{
				domain.PermissionSendMessages: true,
			},
		},
		http.StatusOK,
	)
	message := requestJSON[domain.Message](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/messages",
		member.SessionToken,
		map[string]string{"content": "allowed"},
		http.StatusCreated,
	)
	if message.Content != "allowed" {
		t.Fatalf("expected allowed message, got %+v", message)
	}
}

func TestHiddenVoiceChannelDoesNotLeakChannelOrVoiceState(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	observer := connectMember(t, server.URL, "Observer")
	hiddenMember := connectMember(t, server.URL, "Hidden Member")
	hiddenVoice := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice, "hidden-voice", "")
	hiddenRole := createRole(t, server.URL, owner.SessionToken, "Hidden Voice", nil)
	assignRoles(t, server.URL, owner.SessionToken, hiddenMember.MemberID, []string{hiddenRole.RoleID})

	requestJSON[domain.ChannelPermissionOverride](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+hiddenVoice.ChannelID+"/permission-overrides",
		owner.SessionToken,
		domain.ChannelPermissionOverride{
			TargetType: domain.OverrideTargetRole,
			TargetID:   domain.EveryoneRoleID,
			Denies: map[domain.Permission]bool{
				domain.PermissionViewChannels: true,
			},
		},
		http.StatusOK,
	)
	requestJSON[domain.ChannelPermissionOverride](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+hiddenVoice.ChannelID+"/permission-overrides",
		owner.SessionToken,
		domain.ChannelPermissionOverride{
			TargetType: domain.OverrideTargetRole,
			TargetID:   hiddenRole.RoleID,
			Allows: map[domain.Permission]bool{
				domain.PermissionViewChannels: true,
				domain.PermissionConnectVoice: true,
			},
		},
		http.StatusOK,
	)
	socketCtx, cancelSocket := context.WithTimeout(context.Background(), 3*time.Second)
	ownerConn, _, err := websocket.Dial(socketCtx, eventSocketURL(server.URL, owner.SessionToken), nil)
	if err != nil {
		cancelSocket()
		t.Fatalf("connect owner event socket: %v", err)
	}
	observerConn, _, err := websocket.Dial(socketCtx, eventSocketURL(server.URL, observer.SessionToken), nil)
	cancelSocket()
	if err != nil {
		ownerConn.Close(websocket.StatusNormalClosure, "")
		t.Fatalf("connect observer event socket: %v", err)
	}
	defer ownerConn.Close(websocket.StatusNormalClosure, "")
	defer observerConn.Close(websocket.StatusNormalClosure, "")

	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+hiddenVoice.ChannelID+"/voice-state",
		hiddenMember.SessionToken,
		nil,
		http.StatusOK,
	)

	ownerReadCtx, cancelOwnerRead := context.WithTimeout(context.Background(), time.Second)
	var ownerEvent struct {
		Type    string            `json:"type"`
		Payload domain.VoiceState `json:"payload"`
	}
	err = wsjson.Read(ownerReadCtx, ownerConn, &ownerEvent)
	cancelOwnerRead()
	if err != nil {
		t.Fatalf("read owner hidden voice event: %v", err)
	}
	if ownerEvent.Type != "voice.state.updated" || ownerEvent.Payload.ChannelID != hiddenVoice.ChannelID || ownerEvent.Payload.MemberID != hiddenMember.MemberID {
		t.Fatalf("owner received unexpected hidden voice event: %+v", ownerEvent)
	}

	observerReadCtx, cancelObserverRead := context.WithTimeout(context.Background(), 250*time.Millisecond)
	var observerEvent ws.Event
	err = wsjson.Read(observerReadCtx, observerConn, &observerEvent)
	cancelObserverRead()
	if err == nil {
		t.Fatalf("hidden voice realtime event leaked to observer: %+v", observerEvent)
	}
	if observerReadCtx.Err() != context.DeadlineExceeded {
		t.Fatalf("read observer event socket: %v", err)
	}

	visibleChannels := requestJSON[struct {
		Channels []domain.Channel `json:"channels"`
	}](t, http.MethodGet, server.URL+"/api/v1/channels", observer.SessionToken, nil, http.StatusOK).Channels
	for _, channel := range visibleChannels {
		if channel.ChannelID == hiddenVoice.ChannelID {
			t.Fatalf("hidden channel leaked to observer: %+v", channel)
		}
	}
	visibleStates := requestJSON[struct {
		VoiceStates []domain.VoiceState `json:"voice_states"`
	}](t, http.MethodGet, server.URL+"/api/v1/voice-states", observer.SessionToken, nil, http.StatusOK).VoiceStates
	for _, state := range visibleStates {
		if state.ChannelID == hiddenVoice.ChannelID || state.MemberID == hiddenMember.MemberID {
			t.Fatalf("hidden voice state leaked to observer: %+v", state)
		}
	}

	ownerStates := requestJSON[struct {
		VoiceStates []domain.VoiceState `json:"voice_states"`
	}](t, http.MethodGet, server.URL+"/api/v1/voice-states", owner.SessionToken, nil, http.StatusOK).VoiceStates
	if len(ownerStates) == 0 || ownerStates[0].MemberID != hiddenMember.MemberID {
		t.Fatalf("owner should see hidden voice state, got %+v", ownerStates)
	}
}

func TestModeratorMoveTemporarilyExposesOnlyTheJoinedPrivateVoiceChannel(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	movedMember := connectMember(t, server.URL, "Moved Member")
	privateMember := connectMember(t, server.URL, "Private Member")
	sourceVoice := firstChannelOfType(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice)
	category := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeCategory, "Private", "")
	privateVoice := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice, "private-voice", category.ChannelID)
	privateSibling := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice, "private-sibling", category.ChannelID)
	privateRole := createRole(t, server.URL, owner.SessionToken, "Private Voice", nil)
	assignRoles(t, server.URL, owner.SessionToken, privateMember.MemberID, []string{privateRole.RoleID})

	requestJSON[domain.ChannelPermissionOverride](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+category.ChannelID+"/permission-overrides",
		owner.SessionToken,
		domain.ChannelPermissionOverride{
			TargetType: domain.OverrideTargetRole,
			TargetID:   domain.EveryoneRoleID,
			Denies: map[domain.Permission]bool{
				domain.PermissionViewChannels: true,
				domain.PermissionConnectVoice: true,
			},
		},
		http.StatusOK,
	)
	requestJSON[domain.ChannelPermissionOverride](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+category.ChannelID+"/permission-overrides",
		owner.SessionToken,
		domain.ChannelPermissionOverride{
			TargetType: domain.OverrideTargetRole,
			TargetID:   privateRole.RoleID,
			Allows: map[domain.Permission]bool{
				domain.PermissionViewChannels: true,
				domain.PermissionConnectVoice: true,
			},
		},
		http.StatusOK,
	)
	privateState := requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+privateVoice.ChannelID+"/voice-state",
		privateMember.SessionToken,
		nil,
		http.StatusOK,
	)
	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+sourceVoice.ChannelID+"/voice-state",
		movedMember.SessionToken,
		nil,
		http.StatusOK,
	)

	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+privateVoice.ChannelID+"/voice-state",
		movedMember.SessionToken,
		nil,
		http.StatusForbidden,
	)
	requestJSON[domain.APIError](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/voice-states/"+movedMember.MemberID,
		movedMember.SessionToken,
		map[string]string{"channel_id": privateVoice.ChannelID},
		http.StatusForbidden,
	)

	socketCtx, cancelSocket := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancelSocket()
	movedConn, _, err := websocket.Dial(socketCtx, eventSocketURL(server.URL, movedMember.SessionToken), nil)
	if err != nil {
		t.Fatalf("connect moved member event socket: %v", err)
	}
	defer movedConn.Close(websocket.StatusNormalClosure, "")
	privateConn, _, err := websocket.Dial(socketCtx, eventSocketURL(server.URL, privateMember.SessionToken), nil)
	if err != nil {
		t.Fatalf("connect private member event socket: %v", err)
	}
	defer privateConn.Close(websocket.StatusNormalClosure, "")

	writeRTCSignal(t, socketCtx, movedConn, domain.RTCSignal{
		ChannelID:           privateVoice.ChannelID,
		TargetMemberID:      privateMember.MemberID,
		TargetParticipantID: privateState.ParticipantID,
		SignalType:          "offer",
		Data:                mustRawJSON(t, map[string]string{"sdp": "forged"}),
	})
	forgedReadCtx, cancelForgedRead := context.WithTimeout(context.Background(), 250*time.Millisecond)
	var forgedEvent ws.Event
	err = wsjson.Read(forgedReadCtx, privateConn, &forgedEvent)
	cancelForgedRead()
	if err == nil {
		t.Fatalf("out-of-channel RTC signal reached the private member: %+v", forgedEvent)
	}
	if forgedReadCtx.Err() != context.DeadlineExceeded {
		t.Fatalf("read forged RTC result: %v", err)
	}

	moved := requestJSON[domain.VoiceState](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/voice-states/"+movedMember.MemberID,
		owner.SessionToken,
		map[string]string{"channel_id": privateVoice.ChannelID},
		http.StatusOK,
	)
	if moved.ChannelID != privateVoice.ChannelID {
		t.Fatalf("moderator move did not enter the private voice channel: %+v", moved)
	}

	var channelSnapshot []domain.Channel
	var voiceSnapshot []domain.VoiceState
	for attempt := 0; attempt < 5 && (channelSnapshot == nil || voiceSnapshot == nil); attempt++ {
		var event struct {
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := wsjson.Read(socketCtx, movedConn, &event); err != nil {
			t.Fatalf("read moved member synchronization event: %v", err)
		}
		switch event.Type {
		case "channels.reordered":
			var payload struct {
				Channels []domain.Channel `json:"channels"`
			}
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				t.Fatalf("decode temporary channel snapshot: %v", err)
			}
			channelSnapshot = payload.Channels
		case "voice.states.snapshot":
			var payload struct {
				VoiceStates []domain.VoiceState `json:"voice_states"`
			}
			if err := json.Unmarshal(event.Payload, &payload); err != nil {
				t.Fatalf("decode immediate voice snapshot: %v", err)
			}
			voiceSnapshot = payload.VoiceStates
		}
	}
	if channelSnapshot == nil || voiceSnapshot == nil {
		t.Fatalf("move did not push channel and voice snapshots: channels=%+v voice=%+v", channelSnapshot, voiceSnapshot)
	}
	visibleByID := make(map[string]domain.Channel, len(channelSnapshot))
	for _, channel := range channelSnapshot {
		visibleByID[channel.ChannelID] = channel
	}
	if _, found := visibleByID[category.ChannelID]; !found {
		t.Fatalf("private channel category was not temporarily visible: %+v", channelSnapshot)
	}
	temporaryChannel, found := visibleByID[privateVoice.ChannelID]
	if !found || temporaryChannel.ParentID != category.ChannelID {
		t.Fatalf("private voice channel was not temporarily visible under its category: %+v", channelSnapshot)
	}
	if temporaryChannel.EffectivePermissions[domain.PermissionViewChannels] || temporaryChannel.EffectivePermissions[domain.PermissionConnectVoice] {
		t.Fatalf("temporary metadata visibility granted real channel permissions: %+v", temporaryChannel.EffectivePermissions)
	}
	if _, found := visibleByID[privateSibling.ChannelID]; found {
		t.Fatalf("a sibling private channel leaked through temporary visibility: %+v", channelSnapshot)
	}
	voiceMembers := make(map[string]bool)
	for _, state := range voiceSnapshot {
		if state.ChannelID == privateVoice.ChannelID {
			voiceMembers[state.MemberID] = true
		}
	}
	if !voiceMembers[movedMember.MemberID] || !voiceMembers[privateMember.MemberID] {
		t.Fatalf("moved member did not immediately receive all private-channel peers: %+v", voiceSnapshot)
	}

	requestJSON[domain.APIError](
		t,
		http.MethodGet,
		server.URL+"/api/v1/channels/"+privateVoice.ChannelID+"/messages",
		movedMember.SessionToken,
		nil,
		http.StatusForbidden,
	)
	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+privateVoice.ChannelID+"/voice-state",
		movedMember.SessionToken,
		nil,
		http.StatusForbidden,
	)

	requestJSON[domain.VoiceState](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/voice-state",
		movedMember.SessionToken,
		nil,
		http.StatusOK,
	)
	channelsAfterLeave := requestJSON[struct {
		Channels []domain.Channel `json:"channels"`
	}](t, http.MethodGet, server.URL+"/api/v1/channels", movedMember.SessionToken, nil, http.StatusOK).Channels
	for _, channel := range channelsAfterLeave {
		if channel.ChannelID == privateVoice.ChannelID || channel.ChannelID == category.ChannelID {
			t.Fatalf("temporary private channel visibility survived leaving voice: %+v", channelsAfterLeave)
		}
	}
}

func TestCategoryPermissionOverridesApplyToTextAndVoiceChildren(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")
	category := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeCategory, "Private", "")
	textChannel := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeText, "private-chat", category.ChannelID)
	voiceChannel := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice, "private-voice", category.ChannelID)

	requestJSON[domain.ChannelPermissionOverride](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+category.ChannelID+"/permission-overrides",
		owner.SessionToken,
		domain.ChannelPermissionOverride{
			TargetType: domain.OverrideTargetRole,
			TargetID:   domain.EveryoneRoleID,
			Denies: map[domain.Permission]bool{
				domain.PermissionSendMessages: true,
				domain.PermissionConnectVoice: true,
			},
		},
		http.StatusOK,
	)
	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/messages",
		member.SessionToken,
		map[string]string{"content": "blocked"},
		http.StatusForbidden,
	)
	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		member.SessionToken,
		nil,
		http.StatusForbidden,
	)

	requestJSON[domain.ChannelPermissionOverride](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/permission-overrides",
		owner.SessionToken,
		domain.ChannelPermissionOverride{
			TargetType: domain.OverrideTargetMember,
			TargetID:   member.MemberID,
			Allows: map[domain.Permission]bool{
				domain.PermissionSendMessages: true,
			},
		},
		http.StatusOK,
	)
	requestJSON[domain.ChannelPermissionOverride](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/permission-overrides",
		owner.SessionToken,
		domain.ChannelPermissionOverride{
			TargetType: domain.OverrideTargetMember,
			TargetID:   member.MemberID,
			Allows: map[domain.Permission]bool{
				domain.PermissionConnectVoice: true,
			},
		},
		http.StatusOK,
	)

	message := requestJSON[domain.Message](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/messages",
		member.SessionToken,
		map[string]string{"content": "allowed"},
		http.StatusCreated,
	)
	if message.Content != "allowed" {
		t.Fatalf("expected child text channel override to allow message, got %+v", message)
	}
	state := requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		member.SessionToken,
		nil,
		http.StatusOK,
	)
	if state.ChannelID != voiceChannel.ChannelID || state.MemberID != member.MemberID {
		t.Fatalf("expected child voice channel override to allow join, got %+v", state)
	}
}

func TestVoiceManagementRequiresPermissionAndWritesAudit(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	target := connectMember(t, server.URL, "Target")
	outsider := connectMember(t, server.URL, "Outsider")
	listenerDevice := connectProfile(t, server.URL, domain.ProfileInput{
		DisplayName:    "Target listener device",
		LocalProfileID: "target-listener-device",
	})
	requestJSON[domain.Member](
		t,
		http.MethodPost,
		server.URL+"/api/v1/members/"+target.MemberID+"/link",
		owner.SessionToken,
		map[string]string{"duplicate_member_id": listenerDevice.MemberID},
		http.StatusOK,
	)
	listenerSession := requestJSON[domain.SessionRefreshResponse](
		t,
		http.MethodPost,
		server.URL+"/api/v1/session/refresh",
		"",
		domain.SessionRefreshRequest{
			ServerID:  listenerDevice.ServerID,
			MemberID:  target.MemberID,
			AccessKey: listenerDevice.AccessKey,
			DeviceID:  "target-listener-device",
		},
		http.StatusOK,
	)
	sourceChannel := firstChannelOfType(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice)
	targetChannel := createChannel(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice, "Stage", "")

	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+sourceChannel.ChannelID+"/voice-state",
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+sourceChannel.ChannelID+"/voice-state",
		listenerSession.SessionToken,
		map[string]any{"mode": "listener"},
		http.StatusOK,
	)
	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+sourceChannel.ChannelID+"/voice-state",
		target.SessionToken,
		nil,
		http.StatusOK,
	)

	requestJSON[domain.APIError](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/voice-states/"+target.MemberID,
		outsider.SessionToken,
		map[string]any{
			"channel_id":      targetChannel.ChannelID,
			"server_muted":    true,
			"server_deafened": false,
		},
		http.StatusForbidden,
	)
	requestJSON[domain.APIError](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/voice-states/"+owner.MemberID,
		owner.SessionToken,
		map[string]any{
			"channel_id":      sourceChannel.ChannelID,
			"server_muted":    true,
			"server_deafened": false,
		},
		http.StatusForbidden,
	)

	moved := requestJSON[domain.VoiceState](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/voice-states/"+target.MemberID,
		owner.SessionToken,
		map[string]any{
			"channel_id":      targetChannel.ChannelID,
			"server_muted":    true,
			"server_deafened": false,
		},
		http.StatusOK,
	)
	if moved.ChannelID != targetChannel.ChannelID || !moved.ServerMuted || moved.ServerDeafened {
		t.Fatalf("expected moved server-muted voice state, got %+v", moved)
	}
	movedTargetStates := requestJSON[struct {
		VoiceStates []domain.VoiceState `json:"voice_states"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/voice-states",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).VoiceStates
	targetDeviceCount := 0
	for _, state := range movedTargetStates {
		if state.MemberID != target.MemberID {
			continue
		}
		targetDeviceCount++
		if state.ChannelID != targetChannel.ChannelID || !state.ServerMuted {
			t.Fatalf("expected every target device to be moved and muted, got %+v", movedTargetStates)
		}
	}
	if targetDeviceCount != 2 {
		t.Fatalf("expected both target devices after move, got %+v", movedTargetStates)
	}

	moveLogs := requestJSON[struct {
		AuditLogs []domain.AuditLog `json:"audit_logs"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/audit-logs?action=voice.member.move",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).AuditLogs
	if len(moveLogs) == 0 || moveLogs[0].ActorMemberID != owner.MemberID || moveLogs[0].TargetID != target.MemberID {
		t.Fatalf("expected move audit log, got %+v", moveLogs)
	}
	if moveLogs[0].Details["target_member_name"] != "Target" ||
		moveLogs[0].Details["previous_channel_id"] != sourceChannel.ChannelID ||
		moveLogs[0].Details["target_channel_id"] != targetChannel.ChannelID ||
		moveLogs[0].Details["target_channel_name"] != "Stage" {
		t.Fatalf("expected detailed move audit log, got %+v", moveLogs[0])
	}

	muteLogs := requestJSON[struct {
		AuditLogs []domain.AuditLog `json:"audit_logs"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/audit-logs?action=voice.server_mute",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).AuditLogs
	if len(muteLogs) == 0 || muteLogs[0].Details["server_muted"] != "true" {
		t.Fatalf("expected server mute audit log, got %+v", muteLogs)
	}

	deafened := requestJSON[domain.VoiceState](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/voice-states/"+target.MemberID,
		owner.SessionToken,
		map[string]any{
			"channel_id":      targetChannel.ChannelID,
			"server_muted":    true,
			"server_deafened": true,
		},
		http.StatusOK,
	)
	if !deafened.ServerMuted || !deafened.ServerDeafened {
		t.Fatalf("expected server deafened voice state, got %+v", deafened)
	}
	deafenLogs := requestJSON[struct {
		AuditLogs []domain.AuditLog `json:"audit_logs"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/audit-logs?action=voice.server_deafen",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).AuditLogs
	if len(deafenLogs) == 0 || deafenLogs[0].Details["server_deafened"] != "true" {
		t.Fatalf("expected server deafen audit log, got %+v", deafenLogs)
	}

	kicked := requestJSON[domain.VoiceState](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/voice-states/"+deafened.ParticipantID,
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	if kicked.ParticipantID != deafened.ParticipantID || kicked.MemberID != target.MemberID {
		t.Fatalf("expected target voice participant to be kicked, got %+v", kicked)
	}
	remainingStates := requestJSON[struct {
		VoiceStates []domain.VoiceState `json:"voice_states"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/voice-states",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).VoiceStates
	for _, state := range remainingStates {
		if state.MemberID == target.MemberID {
			t.Fatalf("expected kick to remove every linked voice device, got %+v", remainingStates)
		}
	}
	kickLogs := requestJSON[struct {
		AuditLogs []domain.AuditLog `json:"audit_logs"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/audit-logs?action=voice.member.kick",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).AuditLogs
	if len(kickLogs) == 0 || kickLogs[0].TargetID != target.MemberID || kickLogs[0].Details["participant_id"] != deafened.ParticipantID {
		t.Fatalf("expected voice kick audit log, got %+v", kickLogs)
	}
	if kickLogs[0].Details["device_count"] != "2" {
		t.Fatalf("expected kick audit to include both linked devices, got %+v", kickLogs[0])
	}
	if kickLogs[0].Details["mode"] != "notify" {
		t.Fatalf("expected default kick audit mode to be notify, got %+v", kickLogs[0])
	}
}

func TestVoiceKickModesEmitExpectedDeviceEvents(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	target := connectMember(t, server.URL, "Target")
	voiceChannel := firstChannelOfType(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice)

	socketCtx, cancelSocket := context.WithTimeout(context.Background(), 3*time.Second)
	targetConn, _, err := websocket.Dial(socketCtx, eventSocketURL(server.URL, target.SessionToken), nil)
	cancelSocket()
	if err != nil {
		t.Fatalf("connect target event socket: %v", err)
	}
	defer targetConn.Close(websocket.StatusNormalClosure, "")

	readVoiceEvent := func(expectedType string) domain.VoiceState {
		t.Helper()
		readCtx, cancelRead := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancelRead()
		for {
			var event struct {
				Type    string          `json:"type"`
				Payload json.RawMessage `json:"payload"`
			}
			if err := wsjson.Read(readCtx, targetConn, &event); err != nil {
				t.Fatalf("read %s event: %v", expectedType, err)
			}
			if event.Type != expectedType {
				continue
			}
			var state domain.VoiceState
			if err := json.Unmarshal(event.Payload, &state); err != nil {
				t.Fatalf("decode %s event: %v", expectedType, err)
			}
			return state
		}
	}

	notifiedState := requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		target.SessionToken,
		nil,
		http.StatusOK,
	)
	requestJSON[domain.VoiceState](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/voice-states/"+notifiedState.ParticipantID,
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	if eventState := readVoiceEvent("voice.device.kicked"); eventState.ParticipantID != notifiedState.ParticipantID {
		t.Fatalf("default kick targeted the wrong voice state: %+v", eventState)
	}

	silentState := requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		target.SessionToken,
		nil,
		http.StatusOK,
	)
	requestJSON[domain.VoiceState](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/voice-states/"+silentState.ParticipantID+"?mode=silent",
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	if eventState := readVoiceEvent("voice.device.kicked.silent"); eventState.ParticipantID != silentState.ParticipantID {
		t.Fatalf("silent kick targeted the wrong voice state: %+v", eventState)
	}

	invalidModeState := requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		target.SessionToken,
		nil,
		http.StatusOK,
	)
	requestJSON[map[string]any](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/voice-states/"+invalidModeState.ParticipantID+"?mode=unknown",
		owner.SessionToken,
		nil,
		http.StatusBadRequest,
	)
	remainingStates := requestJSON[struct {
		VoiceStates []domain.VoiceState `json:"voice_states"`
	}](t, http.MethodGet, server.URL+"/api/v1/voice-states", owner.SessionToken, nil, http.StatusOK).VoiceStates
	if _, found := voiceStateForParticipant(remainingStates, invalidModeState.ParticipantID); !found {
		t.Fatalf("invalid kick mode removed the target voice state: %+v", remainingStates)
	}

	kickLogs := requestJSON[struct {
		AuditLogs []domain.AuditLog `json:"audit_logs"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/audit-logs?action=voice.member.kick",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).AuditLogs
	modes := map[string]bool{}
	for _, log := range kickLogs {
		modes[log.Details["mode"]] = true
	}
	if !modes["notify"] || !modes["silent"] {
		t.Fatalf("expected notify and silent kick audit modes, got %+v", kickLogs)
	}
}

func TestBanningMemberDisconnectsRealtimeStateAndRevokesSession(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	target := connectMember(t, server.URL, "Target")
	voiceChannel := firstChannelOfType(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice)
	joined := requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		target.SessionToken,
		nil,
		http.StatusOK,
	)

	updated := requestJSON[domain.Member](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/members/"+target.MemberID,
		owner.SessionToken,
		map[string]bool{"is_banned": true},
		http.StatusOK,
	)
	if !updated.IsBanned {
		t.Fatalf("expected member to be banned, got %+v", updated)
	}
	states := requestJSON[struct {
		VoiceStates []domain.VoiceState `json:"voice_states"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/voice-states",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).VoiceStates
	for _, state := range states {
		if state.ParticipantID == joined.ParticipantID || state.MemberID == target.MemberID {
			t.Fatalf("expected banned member voice state to be removed, got %+v", states)
		}
	}
	requestJSON[domain.APIError](
		t,
		http.MethodGet,
		server.URL+"/api/v1/members",
		target.SessionToken,
		nil,
		http.StatusUnauthorized,
	)
}

func TestScreenShareSessionRequiresFeaturePermissionAndVoiceState(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")
	voiceChannel := firstChannelOfType(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice)

	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/screen-share",
		owner.SessionToken,
		map[string]bool{"remote_control_allowed": false},
		http.StatusForbidden,
	)

	currentServer := requestJSON[domain.Server](
		t,
		http.MethodGet,
		server.URL+"/api/v1/server",
		"",
		nil,
		http.StatusOK,
	)
	currentServer.ScreenShareEnabled = true
	currentServer.RemoteControlEnabled = true
	requestJSON[domain.Server](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/server",
		owner.SessionToken,
		currentServer,
		http.StatusOK,
	)

	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/screen-share",
		owner.SessionToken,
		map[string]bool{"remote_control_allowed": false},
		http.StatusForbidden,
	)
	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	share := requestJSON[domain.ScreenShareSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/screen-share",
		owner.SessionToken,
		map[string]bool{"remote_control_allowed": true},
		http.StatusCreated,
	)
	if share.ShareID == "" || share.OwnerMemberID != owner.MemberID || share.ChannelID != voiceChannel.ChannelID || !share.RemoteControlAllowed {
		t.Fatalf("unexpected screen share session: %+v", share)
	}

	shares := requestJSON[struct {
		ScreenShares []domain.ScreenShareSession `json:"screen_shares"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/screen-shares",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).ScreenShares
	if len(shares) != 1 || shares[0].ShareID != share.ShareID {
		t.Fatalf("expected one screen share session, got %+v", shares)
	}

	requestJSON[domain.APIError](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/screen-shares/"+share.ShareID,
		member.SessionToken,
		nil,
		http.StatusForbidden,
	)
	ended := requestJSON[domain.ScreenShareSession](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/screen-shares/"+share.ShareID,
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	if ended.ShareID != share.ShareID {
		t.Fatalf("unexpected ended screen share: %+v", ended)
	}

	startLogs := requestJSON[struct {
		AuditLogs []domain.AuditLog `json:"audit_logs"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/audit-logs?action=screen_share.start",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).AuditLogs
	if len(startLogs) == 0 || startLogs[0].TargetID != share.ShareID || startLogs[0].Details["channel_id"] != voiceChannel.ChannelID {
		t.Fatalf("expected screen share start audit log, got %+v", startLogs)
	}

	share = requestJSON[domain.ScreenShareSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/screen-share",
		owner.SessionToken,
		map[string]bool{"remote_control_allowed": false},
		http.StatusCreated,
	)
	requestJSON[domain.VoiceState](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/voice-state",
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	shares = requestJSON[struct {
		ScreenShares []domain.ScreenShareSession `json:"screen_shares"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/screen-shares",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).ScreenShares
	if len(shares) != 0 {
		t.Fatalf("expected screen share to end when owner leaves voice, got %+v", shares)
	}
}

func TestAccompanimentSessionRequiresFeaturePermissionAndVoiceState(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")
	voiceChannel := firstChannelOfType(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice)
	endpoint := server.URL + "/api/v1/channels/" + voiceChannel.ChannelID + "/accompaniment"

	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		endpoint,
		owner.SessionToken,
		map[string]string{"source_name": "Music Player"},
		http.StatusForbidden,
	)

	currentServer := requestJSON[domain.Server](
		t,
		http.MethodGet,
		server.URL+"/api/v1/server",
		"",
		nil,
		http.StatusOK,
	)
	currentServer.AccompanimentEnabled = true
	requestJSON[domain.Server](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/server",
		owner.SessionToken,
		currentServer,
		http.StatusOK,
	)

	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		endpoint,
		owner.SessionToken,
		map[string]string{"source_name": "Music Player"},
		http.StatusForbidden,
	)
	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		member.SessionToken,
		nil,
		http.StatusOK,
	)
	memberAccompaniment := requestJSON[domain.AccompanimentSession](
		t,
		http.MethodPost,
		endpoint,
		member.SessionToken,
		map[string]string{"source_name": "Music Player"},
		http.StatusCreated,
	)
	requestJSON[domain.AccompanimentSession](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/accompaniments/"+memberAccompaniment.SessionID,
		member.SessionToken,
		nil,
		http.StatusOK,
	)
	setEveryonePermission(t, server.URL, owner.SessionToken, domain.PermissionPlayAccompaniment, false)
	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		endpoint,
		member.SessionToken,
		map[string]string{"source_name": "Blocked Player"},
		http.StatusForbidden,
	)
	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		owner.SessionToken,
		nil,
		http.StatusOK,
	)

	accompaniment := requestJSON[domain.AccompanimentSession](
		t,
		http.MethodPost,
		endpoint,
		owner.SessionToken,
		map[string]string{"source_name": "Music Player"},
		http.StatusCreated,
	)
	if accompaniment.SessionID == "" || accompaniment.OwnerMemberID != owner.MemberID || accompaniment.ChannelID != voiceChannel.ChannelID || accompaniment.SourceName != "Music Player" {
		t.Fatalf("unexpected accompaniment session: %+v", accompaniment)
	}
	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		endpoint,
		owner.SessionToken,
		map[string]string{"source_name": "Second Player"},
		http.StatusConflict,
	)

	items := requestJSON[struct {
		Accompaniments []domain.AccompanimentSession `json:"accompaniments"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/accompaniments",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).Accompaniments
	if len(items) != 1 || items[0].SessionID != accompaniment.SessionID {
		t.Fatalf("expected one accompaniment session, got %+v", items)
	}

	requestJSON[domain.APIError](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/accompaniments/"+accompaniment.SessionID,
		member.SessionToken,
		nil,
		http.StatusForbidden,
	)
	ended := requestJSON[domain.AccompanimentSession](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/accompaniments/"+accompaniment.SessionID,
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	if ended.SessionID != accompaniment.SessionID {
		t.Fatalf("unexpected ended accompaniment session: %+v", ended)
	}

	for _, action := range []string{"accompaniment.start", "accompaniment.end"} {
		logs := requestJSON[struct {
			AuditLogs []domain.AuditLog `json:"audit_logs"`
		}](
			t,
			http.MethodGet,
			server.URL+"/api/v1/audit-logs?action="+action,
			owner.SessionToken,
			nil,
			http.StatusOK,
		).AuditLogs
		if len(logs) == 0 || logs[0].TargetID != accompaniment.SessionID || logs[0].Details["channel_id"] != voiceChannel.ChannelID {
			t.Fatalf("expected %s audit log, got %+v", action, logs)
		}
	}

	automatic := requestJSON[domain.AccompanimentSession](
		t,
		http.MethodPost,
		endpoint,
		owner.SessionToken,
		map[string]string{"source_name": "Automatic cleanup"},
		http.StatusCreated,
	)
	requestJSON[domain.VoiceState](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/voice-state",
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	items = requestJSON[struct {
		Accompaniments []domain.AccompanimentSession `json:"accompaniments"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/accompaniments",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).Accompaniments
	if len(items) != 0 {
		t.Fatalf("expected accompaniment to end when owner leaves voice, got %+v", items)
	}
	endLogs := requestJSON[struct {
		AuditLogs []domain.AuditLog `json:"audit_logs"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/audit-logs?action=accompaniment.end",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).AuditLogs
	if len(endLogs) == 0 || endLogs[0].TargetID != automatic.SessionID || endLogs[0].Details["reason"] != "voice_left" {
		t.Fatalf("expected automatic accompaniment cleanup audit log, got %+v", endLogs)
	}
}

func TestScreenShareViewerListTracksWatchSignals(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")
	voiceChannel := firstChannelOfType(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice)

	currentServer := requestJSON[domain.Server](
		t,
		http.MethodGet,
		server.URL+"/api/v1/server",
		"",
		nil,
		http.StatusOK,
	)
	currentServer.ScreenShareEnabled = true
	requestJSON[domain.Server](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/server",
		owner.SessionToken,
		currentServer,
		http.StatusOK,
	)
	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		member.SessionToken,
		nil,
		http.StatusOK,
	)
	share := requestJSON[domain.ScreenShareSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/screen-share",
		owner.SessionToken,
		map[string]bool{"remote_control_allowed": false},
		http.StatusCreated,
	)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, eventSocketURL(server.URL, member.SessionToken), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	writeRTCSignal(t, ctx, conn, domain.RTCSignal{
		ChannelID:      voiceChannel.ChannelID,
		TargetMemberID: owner.MemberID,
		SignalType:     "screen-share-watch",
		Data:           mustRawJSON(t, map[string]string{"share_id": share.ShareID}),
	})
	eventually(t, func() bool {
		share := screenShareByID(t, server.URL, owner.SessionToken, share.ShareID)
		return containsString(share.ViewerMemberIDs, member.MemberID)
	})

	writeRTCSignal(t, ctx, conn, domain.RTCSignal{
		ChannelID:      voiceChannel.ChannelID,
		TargetMemberID: owner.MemberID,
		SignalType:     "screen-share-unwatch",
		Data:           mustRawJSON(t, map[string]string{"share_id": share.ShareID}),
	})
	eventually(t, func() bool {
		share := screenShareByID(t, server.URL, owner.SessionToken, share.ShareID)
		return !containsString(share.ViewerMemberIDs, member.MemberID)
	})

	ownerConn, _, err := websocket.Dial(ctx, eventSocketURL(server.URL, owner.SessionToken), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ownerConn.Close(websocket.StatusNormalClosure, "")
	time.Sleep(20 * time.Millisecond)
	const watchSessionID = "watch_browser_reload_2"
	requestJSON[domain.ScreenShareSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/viewer",
		member.SessionToken,
		map[string]string{"watch_session_id": watchSessionID},
		http.StatusOK,
	)

	var forwarded domain.RTCSignal
	for attempt := 0; attempt < 3; attempt++ {
		var event struct {
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := wsjson.Read(ctx, ownerConn, &event); err != nil {
			t.Fatalf("read screen share viewer signal: %v", err)
		}
		if event.Type != "rtc.signal" {
			continue
		}
		if err := json.Unmarshal(event.Payload, &forwarded); err != nil {
			t.Fatalf("decode screen share viewer signal: %v", err)
		}
		break
	}
	if forwarded.SignalType != "screen-share-watch" {
		t.Fatalf("expected screen-share-watch signal, got %+v", forwarded)
	}
	var signalData map[string]string
	if err := json.Unmarshal(forwarded.Data, &signalData); err != nil {
		t.Fatalf("decode screen share watch data: %v", err)
	}
	if signalData["watch_session_id"] != watchSessionID {
		t.Fatalf("expected watch session %q, got %+v", watchSessionID, signalData)
	}

	requestJSON[domain.ScreenShareSession](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/viewer",
		member.SessionToken,
		map[string]string{"watch_session_id": watchSessionID},
		http.StatusOK,
	)
	forwarded = domain.RTCSignal{}
	for attempt := 0; attempt < 3; attempt++ {
		var event struct {
			Type    string          `json:"type"`
			Payload json.RawMessage `json:"payload"`
		}
		if err := wsjson.Read(ctx, ownerConn, &event); err != nil {
			t.Fatalf("read screen share unwatch signal: %v", err)
		}
		if event.Type != "rtc.signal" {
			continue
		}
		if err := json.Unmarshal(event.Payload, &forwarded); err != nil {
			t.Fatalf("decode screen share unwatch signal: %v", err)
		}
		break
	}
	if forwarded.SignalType != "screen-share-unwatch" {
		t.Fatalf("expected screen-share-unwatch signal, got %+v", forwarded)
	}
	signalData = map[string]string{}
	if err := json.Unmarshal(forwarded.Data, &signalData); err != nil {
		t.Fatalf("decode screen share unwatch data: %v", err)
	}
	if signalData["watch_session_id"] != watchSessionID {
		t.Fatalf("expected unwatch session %q, got %+v", watchSessionID, signalData)
	}

	const previousWatchSessionID = "watch_previous"
	const currentWatchSessionID = "watch_current"
	requestJSON[domain.ScreenShareSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/viewer",
		member.SessionToken,
		map[string]string{"watch_session_id": previousWatchSessionID},
		http.StatusOK,
	)
	requestJSON[domain.ScreenShareSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/viewer",
		member.SessionToken,
		map[string]string{"watch_session_id": currentWatchSessionID},
		http.StatusOK,
	)
	requestJSON[domain.ScreenShareSession](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/viewer",
		member.SessionToken,
		map[string]string{"watch_session_id": previousWatchSessionID},
		http.StatusOK,
	)
	updatedShare := screenShareByID(t, server.URL, owner.SessionToken, share.ShareID)
	if !containsString(updatedShare.ViewerMemberIDs, member.MemberID) {
		t.Fatalf("expected a stale unwatch request to preserve the current viewer session, got %+v", updatedShare)
	}
	requestJSON[domain.ScreenShareSession](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/viewer",
		member.SessionToken,
		map[string]string{"watch_session_id": currentWatchSessionID},
		http.StatusOK,
	)
	updatedShare = screenShareByID(t, server.URL, owner.SessionToken, share.ShareID)
	if containsString(updatedShare.ViewerMemberIDs, member.MemberID) {
		t.Fatalf("expected the current unwatch request to remove the viewer, got %+v", updatedShare)
	}
}

func TestScreenShareSignalHTTPFallbackForwardsViewerAnswer(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")
	voiceChannel := firstChannelOfType(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice)

	currentServer := requestJSON[domain.Server](
		t,
		http.MethodGet,
		server.URL+"/api/v1/server",
		"",
		nil,
		http.StatusOK,
	)
	currentServer.ScreenShareEnabled = true
	requestJSON[domain.Server](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/server",
		owner.SessionToken,
		currentServer,
		http.StatusOK,
	)
	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	requestJSON[domain.VoiceState](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
		member.SessionToken,
		nil,
		http.StatusOK,
	)
	share := requestJSON[domain.ScreenShareSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/screen-share",
		owner.SessionToken,
		map[string]bool{"remote_control_allowed": false},
		http.StatusCreated,
	)
	requestJSON[domain.ScreenShareSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/viewer",
		member.SessionToken,
		map[string]string{"watch_session_id": "watch-http-answer"},
		http.StatusOK,
	)
	requestJSON[struct {
		Signals []domain.RTCSignal `json:"signals"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/signals",
		owner.SessionToken,
		nil,
		http.StatusOK,
	)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, eventSocketURL(server.URL, owner.SessionToken), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	response := requestJSON[map[string]bool](
		t,
		http.MethodPost,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/signal",
		member.SessionToken,
		map[string]any{
			"target_member_id": owner.MemberID,
			"signal_type":      "screen-share-answer",
			"data": map[string]any{
				"share_id": share.ShareID,
				"description": map[string]any{
					"type": "answer",
					"sdp":  "v=0\r\n",
				},
			},
		},
		http.StatusOK,
	)
	if !response["delivered"] {
		t.Fatalf("expected delivered response")
	}
	if response["queued"] {
		t.Fatalf("did not expect a successfully delivered signal to be queued")
	}

	var event ws.Event
	if err := wsjson.Read(ctx, conn, &event); err != nil {
		t.Fatalf("read forwarded signal: %v", err)
	}
	if event.Type != "rtc.signal" {
		t.Fatalf("expected rtc.signal event, got %s", event.Type)
	}
	payload, err := json.Marshal(event.Payload)
	if err != nil {
		t.Fatalf("marshal forwarded signal: %v", err)
	}
	var signal domain.RTCSignal
	if err := json.Unmarshal(payload, &signal); err != nil {
		t.Fatalf("decode forwarded signal: %v", err)
	}
	if signal.FromMemberID != member.MemberID ||
		signal.TargetMemberID != owner.MemberID ||
		signal.ChannelID != voiceChannel.ChannelID ||
		signal.SignalType != "screen-share-answer" ||
		screenShareRawShareID(t, signal.Data) != share.ShareID {
		t.Fatalf("unexpected forwarded signal: %+v", signal)
	}

	drained := requestJSON[struct {
		Signals []domain.RTCSignal `json:"signals"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/signals",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).Signals
	if len(drained) != 0 {
		t.Fatalf("expected delivered signal queue to be empty, got %+v", drained)
	}

	if err := conn.Close(websocket.StatusNormalClosure, "test fallback"); err != nil {
		t.Fatalf("close owner event socket: %v", err)
	}
	time.Sleep(20 * time.Millisecond)
	response = requestJSON[map[string]bool](
		t,
		http.MethodPost,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/signal",
		member.SessionToken,
		map[string]any{
			"target_member_id": owner.MemberID,
			"signal_type":      "screen-share-ice-candidate",
			"data": map[string]any{
				"share_id": share.ShareID,
				"candidate": map[string]any{
					"candidate": "candidate:1 1 UDP 1 127.0.0.1 5000 typ host",
				},
			},
		},
		http.StatusOK,
	)
	if response["delivered"] || !response["queued"] {
		t.Fatalf("expected offline owner signal to use queue fallback, got %+v", response)
	}

	drained = requestJSON[struct {
		Signals []domain.RTCSignal `json:"signals"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/signals",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).Signals
	if len(drained) != 1 || drained[0].SignalType != "screen-share-ice-candidate" {
		t.Fatalf("expected queued fallback signal, got %+v", drained)
	}

	requestJSON[domain.ScreenShareSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/viewer",
		member.SessionToken,
		map[string]string{"watch_session_id": "watch-fallback"},
		http.StatusOK,
	)
	requestJSON[struct {
		Signals []domain.RTCSignal `json:"signals"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/signals",
		owner.SessionToken,
		nil,
		http.StatusOK,
	)

	ownerConn, _, err := websocket.Dial(ctx, eventSocketURL(server.URL, owner.SessionToken), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ownerConn.Close(websocket.StatusNormalClosure, "")
	writeRTCSignal(t, ctx, ownerConn, domain.RTCSignal{
		ChannelID:      voiceChannel.ChannelID,
		TargetMemberID: member.MemberID,
		SignalType:     "screen-share-offer",
		Data: mustRawJSON(t, map[string]any{
			"share_id":         share.ShareID,
			"watch_session_id": "watch-fallback",
			"description": map[string]string{
				"type": "offer",
				"sdp":  "v=0\r\n",
			},
		}),
	})
	time.Sleep(20 * time.Millisecond)
	viewerSignals := requestJSON[struct {
		Signals []domain.RTCSignal `json:"signals"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/signals",
		member.SessionToken,
		nil,
		http.StatusOK,
	).Signals
	if len(viewerSignals) != 1 || viewerSignals[0].SignalType != "screen-share-offer" {
		t.Fatalf("expected viewer to drain queued offer, got %+v", viewerSignals)
	}

	viewerCtx, viewerCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer viewerCancel()
	viewerConn, _, err := websocket.Dial(viewerCtx, eventSocketURL(server.URL, member.SessionToken), nil)
	if err != nil {
		t.Fatal(err)
	}
	ownerResponse := requestJSON[map[string]bool](
		t,
		http.MethodPost,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/signal",
		owner.SessionToken,
		map[string]any{
			"target_member_id": member.MemberID,
			"signal_type":      "screen-share-offer",
			"data": map[string]any{
				"share_id":         share.ShareID,
				"watch_session_id": "watch-fallback",
				"description": map[string]string{
					"type": "offer",
					"sdp":  "v=0\r\n",
				},
			},
		},
		http.StatusOK,
	)
	if !ownerResponse["delivered"] || ownerResponse["queued"] {
		t.Fatalf("expected owner offer to be delivered to viewer, got %+v", ownerResponse)
	}
	var viewerEvent ws.Event
	if err := wsjson.Read(viewerCtx, viewerConn, &viewerEvent); err != nil {
		t.Fatalf("read owner HTTP offer at viewer: %v", err)
	}
	viewerPayload, err := json.Marshal(viewerEvent.Payload)
	if err != nil {
		t.Fatalf("marshal owner HTTP offer: %v", err)
	}
	var ownerSignal domain.RTCSignal
	if err := json.Unmarshal(viewerPayload, &ownerSignal); err != nil {
		t.Fatalf("decode owner HTTP offer: %v", err)
	}
	if ownerSignal.FromMemberID != owner.MemberID || ownerSignal.TargetMemberID != member.MemberID ||
		ownerSignal.SignalType != "screen-share-offer" || screenShareRawShareID(t, ownerSignal.Data) != share.ShareID {
		t.Fatalf("unexpected owner HTTP signal: %+v", ownerSignal)
	}
	if err := viewerConn.Close(websocket.StatusNormalClosure, "test owner fallback"); err != nil {
		t.Fatalf("close viewer event socket: %v", err)
	}
	time.Sleep(20 * time.Millisecond)
	ownerResponse = requestJSON[map[string]bool](
		t,
		http.MethodPost,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/signal",
		owner.SessionToken,
		map[string]any{
			"target_member_id": member.MemberID,
			"signal_type":      "screen-share-ice-candidate",
			"data": map[string]any{
				"share_id":         share.ShareID,
				"watch_session_id": "watch-fallback",
				"candidate": map[string]any{
					"candidate": "candidate:2 1 UDP 1 203.0.113.10 5001 typ relay",
				},
			},
		},
		http.StatusOK,
	)
	if ownerResponse["delivered"] || !ownerResponse["queued"] {
		t.Fatalf("expected offline viewer owner signal to use queue fallback, got %+v", ownerResponse)
	}
	viewerSignals = requestJSON[struct {
		Signals []domain.RTCSignal `json:"signals"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/signals?watch_session_id=watch-fallback",
		member.SessionToken,
		nil,
		http.StatusOK,
	).Signals
	if len(viewerSignals) != 1 || viewerSignals[0].SignalType != "screen-share-ice-candidate" {
		t.Fatalf("expected viewer to drain queued owner candidate, got %+v", viewerSignals)
	}

	queueOwnerOffer := func(watchSessionID string) {
		response := requestJSON[map[string]bool](
			t,
			http.MethodPost,
			server.URL+"/api/v1/screen-shares/"+share.ShareID+"/signal",
			owner.SessionToken,
			map[string]any{
				"target_member_id": member.MemberID,
				"signal_type":      "screen-share-offer",
				"data": map[string]any{
					"share_id":         share.ShareID,
					"watch_session_id": watchSessionID,
					"description": map[string]string{
						"type": "offer",
						"sdp":  "v=0\r\na=" + watchSessionID + "\r\n",
					},
				},
			},
			http.StatusOK,
		)
		if response["delivered"] || !response["queued"] {
			t.Fatalf("expected offline viewer offer to use queue fallback, got %+v", response)
		}
	}

	queueOwnerOffer("watch-fallback")
	requestJSON[domain.ScreenShareSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/viewer",
		member.SessionToken,
		map[string]string{"watch_session_id": "watch-current"},
		http.StatusOK,
	)
	queueOwnerOffer("watch-current")

	viewerSignals = requestJSON[struct {
		Signals []domain.RTCSignal `json:"signals"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/signals?watch_session_id=watch-current",
		member.SessionToken,
		nil,
		http.StatusOK,
	).Signals
	var currentSignalData struct {
		WatchSessionID string `json:"watch_session_id"`
	}
	if len(viewerSignals) == 1 {
		if err := json.Unmarshal(viewerSignals[0].Data, &currentSignalData); err != nil {
			t.Fatalf("decode current viewer signal: %v", err)
		}
	}
	if len(viewerSignals) != 1 || currentSignalData.WatchSessionID != "watch-current" {
		t.Fatalf("expected only the current watch generation, got %+v", viewerSignals)
	}

	staleSignals := requestJSON[struct {
		Signals []domain.RTCSignal `json:"signals"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/signals?watch_session_id=watch-fallback",
		member.SessionToken,
		nil,
		http.StatusOK,
	).Signals
	if len(staleSignals) != 0 {
		t.Fatalf("expected stale watch generation to remain inaccessible, got %+v", staleSignals)
	}
}

func TestRemoteControlRequestApprovalRespectAndRevoke(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	controller := connectMember(t, server.URL, "Controller")
	voiceChannel := firstChannelOfType(t, server.URL, owner.SessionToken, domain.ChannelTypeVoice)

	currentServer := requestJSON[domain.Server](
		t,
		http.MethodGet,
		server.URL+"/api/v1/server",
		"",
		nil,
		http.StatusOK,
	)
	currentServer.ScreenShareEnabled = true
	currentServer.RemoteControlEnabled = true
	requestJSON[domain.Server](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/server",
		owner.SessionToken,
		currentServer,
		http.StatusOK,
	)
	role := requestJSON[domain.ServerRole](
		t,
		http.MethodPost,
		server.URL+"/api/v1/roles",
		owner.SessionToken,
		map[string]any{
			"name":  "Controller",
			"color": "#8ecbff",
			"permissions": map[domain.Permission]bool{
				domain.PermissionRequestControl: true,
			},
		},
		http.StatusCreated,
	)
	requestJSON[domain.Member](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/members/"+controller.MemberID+"/roles",
		owner.SessionToken,
		map[string]any{"role_ids": []string{role.RoleID}},
		http.StatusOK,
	)
	for _, member := range []domain.ConnectResponse{owner, controller} {
		requestJSON[domain.VoiceState](
			t,
			http.MethodPost,
			server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
			member.SessionToken,
			nil,
			http.StatusOK,
		)
	}
	ownerSecondary := requestJSON[domain.SessionRefreshResponse](
		t,
		http.MethodPost,
		server.URL+"/api/v1/session/refresh",
		"",
		domain.SessionRefreshRequest{
			ServerID:  owner.ServerID,
			MemberID:  owner.MemberID,
			AccessKey: owner.AccessKey,
			DeviceID:  "remote-control-owner-secondary",
		},
		http.StatusOK,
	)
	controllerSecondary := requestJSON[domain.SessionRefreshResponse](
		t,
		http.MethodPost,
		server.URL+"/api/v1/session/refresh",
		"",
		domain.SessionRefreshRequest{
			ServerID:  controller.ServerID,
			MemberID:  controller.MemberID,
			AccessKey: controller.AccessKey,
			DeviceID:  "remote-control-controller-secondary",
		},
		http.StatusOK,
	)
	for _, token := range []string{ownerSecondary.SessionToken, controllerSecondary.SessionToken} {
		requestJSON[domain.VoiceState](
			t,
			http.MethodPost,
			server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/voice-state",
			token,
			map[string]any{"mode": "listener"},
			http.StatusOK,
		)
	}
	share := requestJSON[domain.ScreenShareSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels/"+voiceChannel.ChannelID+"/screen-share",
		owner.SessionToken,
		map[string]bool{"remote_control_allowed": true},
		http.StatusCreated,
	)

	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/control-requests",
		controller.SessionToken,
		nil,
		http.StatusForbidden,
	)
	requestJSON[domain.ScreenShareSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/viewer",
		controller.SessionToken,
		map[string]string{"watch_session_id": "remote_control_test"},
		http.StatusOK,
	)
	requestJSON[domain.ScreenShareSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/viewer",
		controllerSecondary.SessionToken,
		map[string]string{"watch_session_id": "remote_control_secondary_test"},
		http.StatusOK,
	)
	control := requestJSON[domain.RemoteControlSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/control-requests",
		controller.SessionToken,
		nil,
		http.StatusCreated,
	)
	if control.Status != domain.RemoteControlPending || control.ControllerMemberID != controller.MemberID ||
		control.OwnerParticipantID == "" || control.ControllerParticipantID == "" {
		t.Fatalf("unexpected pending remote control session: %+v", control)
	}
	requestJSON[domain.APIError](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/remote-controls/"+control.ControlID,
		ownerSecondary.SessionToken,
		map[string]string{"action": "approve"},
		http.StatusForbidden,
	)
	secondaryOwnerControls := requestJSON[struct {
		RemoteControls []domain.RemoteControlSession `json:"remote_controls"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/remote-controls",
		ownerSecondary.SessionToken,
		nil,
		http.StatusOK,
	).RemoteControls
	if len(secondaryOwnerControls) != 0 {
		t.Fatalf("expected another owner device to have no control sessions, got %+v", secondaryOwnerControls)
	}
	control = requestJSON[domain.RemoteControlSession](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/remote-controls/"+control.ControlID,
		owner.SessionToken,
		map[string]string{"action": "approve"},
		http.StatusOK,
	)
	if control.Status != domain.RemoteControlActive {
		t.Fatalf("expected active remote control session, got %+v", control)
	}
	if control.GrantGeneration == 0 || control.LeaseUntilMS <= control.UpdatedAtMS || control.TransportState != "websocket" {
		t.Fatalf("expected active control lease metadata, got %+v", control)
	}
	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/remote-controls/"+control.ControlID+"/heartbeat",
		controllerSecondary.SessionToken,
		nil,
		http.StatusForbidden,
	)
	control = requestJSON[domain.RemoteControlSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/remote-controls/"+control.ControlID+"/heartbeat",
		controller.SessionToken,
		nil,
		http.StatusOK,
	)
	if control.LeaseUntilMS <= time.Now().UnixMilli() {
		t.Fatalf("expected controller heartbeat to renew the lease, got %+v", control)
	}
	visibleToWaitingViewer := requestJSON[struct {
		RemoteControls []domain.RemoteControlSession `json:"remote_controls"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/remote-controls",
		controllerSecondary.SessionToken,
		nil,
		http.StatusOK,
	).RemoteControls
	if len(visibleToWaitingViewer) != 1 || visibleToWaitingViewer[0].ControlID != control.ControlID ||
		visibleToWaitingViewer[0].Status != domain.RemoteControlActive {
		t.Fatalf("expected another viewer to see the active controller, got %+v", visibleToWaitingViewer)
	}
	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/control-requests",
		controllerSecondary.SessionToken,
		nil,
		http.StatusConflict,
	)
	requestJSON[domain.APIError](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/remote-controls/"+control.ControlID,
		controllerSecondary.SessionToken,
		map[string]string{"action": "revoke"},
		http.StatusForbidden,
	)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ownerConn, _, err := websocket.Dial(ctx, eventSocketURL(server.URL, owner.SessionToken), nil)
	if err != nil {
		t.Fatalf("connect owner event socket: %v", err)
	}
	defer ownerConn.Close(websocket.StatusNormalClosure, "")
	controllerConn, _, err := websocket.Dial(ctx, eventSocketURL(server.URL, controller.SessionToken), nil)
	if err != nil {
		t.Fatalf("connect controller event socket: %v", err)
	}
	defer controllerConn.Close(websocket.StatusNormalClosure, "")
	controllerSecondaryConn, _, err := websocket.Dial(ctx, eventSocketURL(server.URL, controllerSecondary.SessionToken), nil)
	if err != nil {
		t.Fatalf("connect secondary controller event socket: %v", err)
	}
	defer controllerSecondaryConn.Close(websocket.StatusNormalClosure, "")

	remoteInput := domain.RemoteControlInput{
		ControlID: control.ControlID,
		Sequence:  1,
		Event: domain.RemoteControlInputEvent{
			Type:    "pointer_move",
			X:       0.25,
			Y:       0.75,
			Buttons: 0,
		},
	}
	if err := wsjson.Write(ctx, controllerSecondaryConn, ws.Event{Type: "remote_control.input", Payload: remoteInput}); err != nil {
		t.Fatalf("send remote control input from secondary device: %v", err)
	}
	if err := wsjson.Write(ctx, controllerConn, ws.Event{Type: "remote_control.input", Payload: remoteInput}); err != nil {
		t.Fatalf("send remote control input: %v", err)
	}
	var forwarded struct {
		Type    string                    `json:"type"`
		Payload domain.RemoteControlInput `json:"payload"`
	}
	if err := wsjson.Read(ctx, ownerConn, &forwarded); err != nil {
		t.Fatalf("read forwarded remote control input: %v", err)
	}
	if forwarded.Type != "remote_control.input" ||
		forwarded.Payload.ControlID != control.ControlID ||
		forwarded.Payload.ControllerMemberID != controller.MemberID ||
		forwarded.Payload.ControllerParticipantID != control.ControllerParticipantID ||
		forwarded.Payload.Sequence != remoteInput.Sequence {
		t.Fatalf("unexpected forwarded remote control input: %+v", forwarded)
	}
	releaseInput := domain.RemoteControlInput{
		ControlID: control.ControlID,
		Sequence:  2,
		Event: domain.RemoteControlInputEvent{
			Type: "release_all",
		},
	}
	if err := wsjson.Write(ctx, controllerConn, ws.Event{Type: "remote_control.input", Payload: releaseInput}); err != nil {
		t.Fatalf("send remote control release-all input: %v", err)
	}
	if err := wsjson.Read(ctx, ownerConn, &forwarded); err != nil {
		t.Fatalf("read forwarded remote control release-all input: %v", err)
	}
	if forwarded.Type != "remote_control.input" || forwarded.Payload.Event.Type != "release_all" ||
		forwarded.Payload.Sequence != releaseInput.Sequence {
		t.Fatalf("unexpected forwarded remote control release-all input: %+v", forwarded)
	}

	respectStartedAt := time.Now()
	control = requestJSON[domain.RemoteControlSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/remote-controls/"+control.ControlID+"/respect",
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	if control.RespectUntilMS <= time.Now().UnixMilli() {
		t.Fatalf("expected active respect window, got %+v", control)
	}
	respectDuration := time.UnixMilli(control.RespectUntilMS).Sub(respectStartedAt)
	if respectDuration < 2800*time.Millisecond || respectDuration > 3200*time.Millisecond {
		t.Fatalf("expected a three second respect window, got %s", respectDuration)
	}
	control = requestJSON[domain.RemoteControlSession](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/remote-controls/"+control.ControlID,
		controller.SessionToken,
		map[string]string{"action": "revoke"},
		http.StatusOK,
	)
	if control.Status != domain.RemoteControlRevoked {
		t.Fatalf("expected revoked remote control session, got %+v", control)
	}
	control = requestJSON[domain.RemoteControlSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/control-requests",
		controller.SessionToken,
		nil,
		http.StatusCreated,
	)
	requestJSON[domain.RemoteControlSession](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/remote-controls/"+control.ControlID,
		owner.SessionToken,
		map[string]string{"action": "approve"},
		http.StatusOK,
	)
	requestJSON[domain.ScreenShareSession](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/viewer",
		controller.SessionToken,
		map[string]string{"watch_session_id": "remote_control_test"},
		http.StatusOK,
	)
	remaining := requestJSON[struct {
		RemoteControls []domain.RemoteControlSession `json:"remote_controls"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/remote-controls",
		controller.SessionToken,
		nil,
		http.StatusOK,
	).RemoteControls
	if len(remaining) != 0 {
		t.Fatalf("expected stopping screen share playback to revoke control, got %+v", remaining)
	}
	secondaryControl := requestJSON[domain.RemoteControlSession](
		t,
		http.MethodPost,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/control-requests",
		controllerSecondary.SessionToken,
		nil,
		http.StatusCreated,
	)
	if secondaryControl.ControllerParticipantID == control.ControllerParticipantID {
		t.Fatalf("expected the second device to receive an independent participant binding: %+v", secondaryControl)
	}
	requestJSON[domain.ScreenShareSession](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/screen-shares/"+share.ShareID+"/viewer",
		controllerSecondary.SessionToken,
		map[string]string{"watch_session_id": "remote_control_secondary_test"},
		http.StatusOK,
	)

	logs := requestJSON[struct {
		AuditLogs []domain.AuditLog `json:"audit_logs"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/audit-logs?action=remote_control.approve",
		owner.SessionToken,
		nil,
		http.StatusOK,
	).AuditLogs
	if len(logs) != 2 || logs[0].Details["controller_member_id"] != controller.MemberID ||
		logs[1].Details["controller_member_id"] != controller.MemberID {
		t.Fatalf("expected remote control approval audit, got %+v", logs)
	}
}

func TestOwnerCanUpdateBanAndRemoveMember(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")

	updated := requestJSON[domain.Member](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/members/"+member.MemberID,
		owner.SessionToken,
		map[string]any{"is_banned": true},
		http.StatusOK,
	)
	if updated.DisplayName != "Member" || !updated.IsBanned {
		t.Fatalf("expected profile-preserving banned member, got %+v", updated)
	}
	requestJSON[domain.APIError](
		t,
		http.MethodPost,
		server.URL+"/api/v1/connect",
		"",
		map[string]any{
			"profile": map[string]string{
				"display_name":     "Member",
				"local_profile_id": "Member-local",
				"client_version":   "test",
			},
		},
		http.StatusForbidden,
	)

	removed := requestJSON[domain.Member](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/members/"+member.MemberID,
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	if removed.MemberID != member.MemberID {
		t.Fatalf("expected removed member, got %+v", removed)
	}
}

func TestMessageEditDeleteAndPagination(t *testing.T) {
	server := newTestServer(t)
	defer server.Close()

	owner := connectMember(t, server.URL, "Owner")
	member := connectMember(t, server.URL, "Member")
	textChannel := firstChannelOfType(t, server.URL, owner.SessionToken, domain.ChannelTypeText)
	otherChannel := requestJSON[domain.Channel](
		t,
		http.MethodPost,
		server.URL+"/api/v1/channels",
		owner.SessionToken,
		map[string]string{"type": "text", "name": "other"},
		http.StatusCreated,
	)

	first := createMessage(t, server.URL, member.SessionToken, textChannel.ChannelID, "one")
	second := createMessage(t, server.URL, member.SessionToken, textChannel.ChannelID, "two")
	third := createMessage(t, server.URL, member.SessionToken, textChannel.ChannelID, "three")

	edited := requestJSON[domain.Message](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/messages/"+first.MessageID,
		member.SessionToken,
		map[string]string{"content": "one edited"},
		http.StatusOK,
	)
	if edited.Content != "one edited" || edited.EditedAtMS == 0 {
		t.Fatalf("expected edited message, got %+v", edited)
	}
	requestJSON[domain.APIError](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/messages/"+first.MessageID,
		owner.SessionToken,
		map[string]string{"content": "owner must not edit another member's message"},
		http.StatusForbidden,
	)
	unchanged := requestJSON[domain.Message](
		t,
		http.MethodGet,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/messages/"+first.MessageID,
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	if unchanged.Content != "one edited" {
		t.Fatalf("expected another member's message to remain unchanged, got %+v", unchanged)
	}
	requestJSON[domain.APIError](
		t,
		http.MethodPatch,
		server.URL+"/api/v1/channels/"+otherChannel.ChannelID+"/messages/"+first.MessageID,
		member.SessionToken,
		map[string]string{"content": "wrong channel"},
		http.StatusNotFound,
	)

	page := requestJSON[struct {
		Messages []domain.Message `json:"messages"`
	}](
		t,
		http.MethodGet,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/messages?limit=2",
		member.SessionToken,
		nil,
		http.StatusOK,
	).Messages
	if len(page) != 2 || page[0].MessageID != second.MessageID || page[1].MessageID != third.MessageID {
		t.Fatalf("expected newest page in chronological order, got %+v", page)
	}

	deleted := requestJSON[domain.Message](
		t,
		http.MethodDelete,
		server.URL+"/api/v1/channels/"+textChannel.ChannelID+"/messages/"+second.MessageID,
		owner.SessionToken,
		nil,
		http.StatusOK,
	)
	if deleted.DeletedAtMS == 0 {
		t.Fatalf("expected deleted timestamp, got %+v", deleted)
	}
}

func createRole(
	t *testing.T,
	baseURL string,
	sessionToken string,
	name string,
	permissions map[domain.Permission]bool,
) domain.ServerRole {
	t.Helper()
	return requestJSON[domain.ServerRole](
		t,
		http.MethodPost,
		baseURL+"/api/v1/roles",
		sessionToken,
		domain.ServerRole{Name: name, Permissions: permissions},
		http.StatusCreated,
	)
}

func createMessage(
	t *testing.T,
	baseURL string,
	sessionToken string,
	channelID string,
	content string,
) domain.Message {
	t.Helper()
	return requestJSON[domain.Message](
		t,
		http.MethodPost,
		baseURL+"/api/v1/channels/"+channelID+"/messages",
		sessionToken,
		map[string]string{"content": content},
		http.StatusCreated,
	)
}

func updateRole(
	t *testing.T,
	baseURL string,
	sessionToken string,
	roleID string,
	name string,
	permissions map[domain.Permission]bool,
) domain.ServerRole {
	t.Helper()
	return requestJSON[domain.ServerRole](
		t,
		http.MethodPatch,
		baseURL+"/api/v1/roles/"+roleID,
		sessionToken,
		domain.ServerRole{Name: name, Permissions: permissions},
		http.StatusOK,
	)
}

func setEveryonePermission(
	t *testing.T,
	baseURL string,
	sessionToken string,
	permission domain.Permission,
	allowed bool,
) domain.ServerRole {
	t.Helper()
	roles := requestJSON[struct {
		Roles []domain.ServerRole `json:"roles"`
	}](t, http.MethodGet, baseURL+"/api/v1/roles", sessionToken, nil, http.StatusOK).Roles
	for _, role := range roles {
		if role.RoleID != domain.EveryoneRoleID {
			continue
		}
		permissions := make(map[domain.Permission]bool, len(role.Permissions))
		for current, enabled := range role.Permissions {
			permissions[current] = enabled
		}
		permissions[permission] = allowed
		return updateRole(t, baseURL, sessionToken, role.RoleID, role.Name, permissions)
	}
	t.Fatal("expected @everyone role")
	return domain.ServerRole{}
}

func assignRoles(
	t *testing.T,
	baseURL string,
	sessionToken string,
	memberID string,
	roleIDs []string,
) domain.Member {
	t.Helper()
	return requestJSON[domain.Member](
		t,
		http.MethodPatch,
		baseURL+"/api/v1/members/"+memberID+"/roles",
		sessionToken,
		map[string][]string{"role_ids": roleIDs},
		http.StatusOK,
	)
}

func listMembers(t *testing.T, baseURL string, sessionToken string) []domain.Member {
	t.Helper()
	return requestJSON[struct {
		Members []domain.Member `json:"members"`
	}](
		t,
		http.MethodGet,
		baseURL+"/api/v1/members",
		sessionToken,
		nil,
		http.StatusOK,
	).Members
}

func findMember(t *testing.T, members []domain.Member, memberID string) domain.Member {
	t.Helper()
	for _, member := range members {
		if member.MemberID == memberID {
			return member
		}
	}
	t.Fatalf("expected member %s", memberID)
	return domain.Member{}
}

func firstChannelOfType(t *testing.T, baseURL string, sessionToken string, channelType domain.ChannelType) domain.Channel {
	t.Helper()
	channels := listChannels(t, baseURL, sessionToken)
	for _, channel := range channels {
		if channel.Type == channelType {
			return channel
		}
	}
	t.Fatalf("expected channel type %s", channelType)
	return domain.Channel{}
}

func findChannel(t *testing.T, channels []domain.Channel, channelID string) domain.Channel {
	t.Helper()
	for _, channel := range channels {
		if channel.ChannelID == channelID {
			return channel
		}
	}
	t.Fatalf("expected channel %s", channelID)
	return domain.Channel{}
}

func createChannel(
	t *testing.T,
	baseURL string,
	sessionToken string,
	channelType domain.ChannelType,
	name string,
	parentID string,
) domain.Channel {
	t.Helper()
	return requestJSON[domain.Channel](
		t,
		http.MethodPost,
		baseURL+"/api/v1/channels",
		sessionToken,
		domain.Channel{Type: channelType, Name: name, ParentID: parentID},
		http.StatusCreated,
	)
}

func listChannels(t *testing.T, baseURL string, sessionToken string) []domain.Channel {
	t.Helper()
	return requestJSON[struct {
		Channels []domain.Channel `json:"channels"`
	}](
		t,
		http.MethodGet,
		baseURL+"/api/v1/channels",
		sessionToken,
		nil,
		http.StatusOK,
	).Channels
}

func assertChannelOrder(t *testing.T, channels []domain.Channel, channelID string, parentID string, position int) {
	t.Helper()
	for _, channel := range channels {
		if channel.ChannelID != channelID {
			continue
		}
		if channel.ParentID != parentID || channel.Position != position {
			t.Fatalf("expected channel %s parent=%q position=%d, got parent=%q position=%d", channelID, parentID, position, channel.ParentID, channel.Position)
		}
		return
	}
	t.Fatalf("expected channel %s", channelID)
}

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	return newTestServerWithConfig(t, config.Config{})
}

func newTestServerWithConfig(t *testing.T, cfg config.Config) *httptest.Server {
	t.Helper()
	appStore := store.NewMemoryStore("EchoVoice Test")
	handler := api.NewRouter(
		cfg,
		appStore,
		ws.NewHub(),
		auth.NewSessionStore(time.Hour),
	)
	return httptest.NewServer(handler)
}

func connectMember(t *testing.T, baseURL string, name string) domain.ConnectResponse {
	t.Helper()
	return connectProfile(t, baseURL, domain.ProfileInput{
		DisplayName:    name,
		LocalProfileID: name + "-local",
		ClientVersion:  "test",
	})
}

func connectProfile(t *testing.T, baseURL string, profile domain.ProfileInput) domain.ConnectResponse {
	t.Helper()
	if profile.ClientVersion == "" {
		profile.ClientVersion = "test"
	}
	return requestJSON[domain.ConnectResponse](
		t,
		http.MethodPost,
		baseURL+"/api/v1/connect",
		"",
		map[string]any{"profile": profile},
		http.StatusOK,
	)
}

func uploadMultipartAsset(
	t *testing.T,
	baseURL string,
	sessionToken string,
	purpose string,
	fileName string,
	contentType string,
	content []byte,
	expectedStatus int,
) domain.ContentAsset {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	if err := writer.WriteField("purpose", purpose); err != nil {
		t.Fatal(err)
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, fileName))
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/v1/assets", body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != expectedStatus {
		raw, _ := io.ReadAll(response.Body)
		t.Fatalf("expected asset upload status %d, got %d: %s", expectedStatus, response.StatusCode, raw)
	}
	if expectedStatus < 200 || expectedStatus >= 300 {
		return domain.ContentAsset{}
	}
	var asset domain.ContentAsset
	if err := json.NewDecoder(response.Body).Decode(&asset); err != nil {
		t.Fatal(err)
	}
	return asset
}

func uploadChannelFileForTest(
	t *testing.T,
	baseURL string,
	sessionToken string,
	channelID string,
	fileName string,
	contentType string,
	content []byte,
	parentID string,
	expectedStatus int,
) domain.ChannelFileEntry {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	if parentID != "" {
		if err := writer.WriteField("parent_id", parentID); err != nil {
			t.Fatal(err)
		}
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, fileName))
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/v1/channels/"+channelID+"/files", body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != expectedStatus {
		raw, _ := io.ReadAll(response.Body)
		t.Fatalf("expected channel file upload status %d, got %d: %s", expectedStatus, response.StatusCode, raw)
	}
	if expectedStatus < 200 || expectedStatus >= 300 {
		return domain.ChannelFileEntry{}
	}
	var entry domain.ChannelFileEntry
	if err := json.NewDecoder(response.Body).Decode(&entry); err != nil {
		t.Fatal(err)
	}
	return entry
}

func uploadMessageImageForTest(
	t *testing.T,
	baseURL string,
	sessionToken string,
	channelID string,
	fileName string,
	contentType string,
	content []byte,
	expectedStatus int,
) domain.ContentAsset {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, fileName))
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/v1/channels/"+channelID+"/message-images", body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != expectedStatus {
		raw, _ := io.ReadAll(response.Body)
		t.Fatalf("expected message image upload status %d, got %d: %s", expectedStatus, response.StatusCode, raw)
	}
	if expectedStatus < 200 || expectedStatus >= 300 {
		return domain.ContentAsset{}
	}
	var asset domain.ContentAsset
	if err := json.NewDecoder(response.Body).Decode(&asset); err != nil {
		t.Fatal(err)
	}
	return asset
}

func requestMessageImage(
	t *testing.T,
	baseURL string,
	sessionToken string,
	channelID string,
	assetSHA256 string,
	expectedStatus int,
	expectedContent []byte,
) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, baseURL+"/api/v1/channels/"+channelID+"/message-images/"+assetSHA256, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != expectedStatus {
		raw, _ := io.ReadAll(response.Body)
		t.Fatalf("expected message image status %d, got %d: %s", expectedStatus, response.StatusCode, raw)
	}
	if expectedStatus != http.StatusOK {
		return
	}
	actual, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, expectedContent) {
		t.Fatalf("message image body mismatch: got %d bytes, want %d", len(actual), len(expectedContent))
	}
}

func uploadServerSoundboardItem(
	t *testing.T,
	baseURL string,
	sessionToken string,
	name string,
	fileName string,
	content []byte,
	expectedStatus int,
) domain.SoundboardItem {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	if err := writer.WriteField("name", name); err != nil {
		t.Fatal(err)
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, fileName))
	header.Set("Content-Type", "audio/wav")
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/v1/soundboard", body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != expectedStatus {
		raw, _ := io.ReadAll(response.Body)
		t.Fatalf("expected soundboard upload status %d, got %d: %s", expectedStatus, response.StatusCode, raw)
	}
	if expectedStatus < 200 || expectedStatus >= 300 {
		return domain.SoundboardItem{}
	}
	var item domain.SoundboardItem
	if err := json.NewDecoder(response.Body).Decode(&item); err != nil {
		t.Fatal(err)
	}
	return item
}

func uploadServerEmoji(
	t *testing.T,
	baseURL string,
	sessionToken string,
	shortcode string,
	fileName string,
	contentType string,
	content []byte,
	expectedStatus int,
) domain.CustomEmoji {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	if err := writer.WriteField("shortcode", shortcode); err != nil {
		t.Fatal(err)
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, fileName))
	header.Set("Content-Type", contentType)
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPost, baseURL+"/api/v1/emojis", body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != expectedStatus {
		raw, _ := io.ReadAll(response.Body)
		t.Fatalf("expected emoji upload status %d, got %d: %s", expectedStatus, response.StatusCode, raw)
	}
	if expectedStatus < 200 || expectedStatus >= 300 {
		return domain.CustomEmoji{}
	}
	var emoji domain.CustomEmoji
	if err := json.NewDecoder(response.Body).Decode(&emoji); err != nil {
		t.Fatal(err)
	}
	return emoji
}

func requestJSON[T any](
	t *testing.T,
	method string,
	url string,
	sessionToken string,
	body any,
	expectedStatus int,
) T {
	t.Helper()

	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		payload, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request body: %v", err)
		}
		reader = bytes.NewReader(payload)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatalf("create request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if sessionToken != "" {
		req.Header.Set("Authorization", "Bearer "+sessionToken)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("send request: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != expectedStatus {
		t.Fatalf("expected status %d, got %d", expectedStatus, resp.StatusCode)
	}

	var output T
	if err := json.NewDecoder(resp.Body).Decode(&output); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return output
}

func eventSocketURL(baseURL string, sessionToken string) string {
	return strings.Replace(baseURL, "http", "ws", 1) + "/api/v1/events?session_token=" + sessionToken
}

func writeRTCSignal(t *testing.T, ctx context.Context, conn *websocket.Conn, signal domain.RTCSignal) {
	t.Helper()
	if err := wsjson.Write(ctx, conn, ws.Event{Type: "rtc.signal", Payload: signal}); err != nil {
		t.Fatalf("write rtc signal: %v", err)
	}
}

func mustRawJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal raw json: %v", err)
	}
	return raw
}

func screenShareRawShareID(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var payload struct {
		ShareID string `json:"share_id"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("decode screen share signal data: %v", err)
	}
	return payload.ShareID
}

func screenShareByID(t *testing.T, baseURL string, sessionToken string, shareID string) domain.ScreenShareSession {
	t.Helper()
	shares := requestJSON[struct {
		ScreenShares []domain.ScreenShareSession `json:"screen_shares"`
	}](
		t,
		http.MethodGet,
		baseURL+"/api/v1/screen-shares",
		sessionToken,
		nil,
		http.StatusOK,
	).ScreenShares
	for _, share := range shares {
		if share.ShareID == shareID {
			return share
		}
	}
	t.Fatalf("expected screen share %s, got %+v", shareID, shares)
	return domain.ScreenShareSession{}
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}

func eventually(t *testing.T, condition func() bool) {
	t.Helper()
	eventuallyWithin(t, 2*time.Second, condition)
}

func eventuallyWithin(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !condition() {
		t.Fatal("condition was not met before deadline")
	}
}
