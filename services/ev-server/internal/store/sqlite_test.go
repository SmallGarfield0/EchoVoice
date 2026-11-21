package store

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/echovoice/echovoice/services/ev-server/internal/domain"
)

func TestDefaultEveryoneMediaPermissions(t *testing.T) {
	t.Run("memory", func(t *testing.T) {
		assertDefaultEveryoneMediaPermissions(t, NewMemoryStore("EchoVoice Test").Roles())
	})

	t.Run("sqlite", func(t *testing.T) {
		appStore, err := OpenSQLite(filepath.Join(t.TempDir(), "echovoice.db"), "EchoVoice Test")
		if err != nil {
			t.Fatalf("open sqlite: %v", err)
		}
		defer appStore.Close()
		assertDefaultEveryoneMediaPermissions(t, appStore.Roles())
	})
}

func assertDefaultEveryoneMediaPermissions(t *testing.T, roles []domain.ServerRole) {
	t.Helper()
	for _, role := range roles {
		if !role.IsEveryone {
			continue
		}
		for _, permission := range []domain.Permission{
			domain.PermissionPlayAccompaniment,
			domain.PermissionPlaySoundboard,
			domain.PermissionSendEmoji,
		} {
			if !role.Permissions[permission] {
				t.Fatalf("expected %s to be enabled for @everyone", permission)
			}
		}
		return
	}
	t.Fatal("@everyone role was not created")
}

func TestSQLiteMigratesLegacyCustomEmojiShortcodes(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "echovoice.db")
	appStore, err := OpenSQLite(dbPath, "EchoVoice Test")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	for index, item := range []struct {
		id        string
		shortcode string
	}{
		{id: "emoji-valid", shortcode: "33nma_4rux47"},
		{id: "emoji-legacy-one", shortcode: "33NMA_4RUX47_8E_CPO8"},
		{id: "emoji-legacy-two", shortcode: "33NMA_4RUX47-more"},
	} {
		if _, err := appStore.db.Exec(
			`INSERT INTO custom_emojis (
			 emoji_uuid, shortcode, asset_sha256, size_bytes, mime_type, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			item.id,
			item.shortcode,
			strings.Repeat(string(rune('a'+index)), 64),
			index+1,
			"image/png",
			index+1,
			index+1,
		); err != nil {
			t.Fatalf("insert legacy custom emoji: %v", err)
		}
	}
	if err := appStore.Close(); err != nil {
		t.Fatalf("close sqlite: %v", err)
	}

	reopened, err := OpenSQLite(dbPath, "EchoVoice Test")
	if err != nil {
		t.Fatalf("reopen sqlite: %v", err)
	}
	defer reopened.Close()
	shortcodes := make(map[string]string)
	for _, emoji := range reopened.CustomEmojis() {
		shortcodes[emoji.EmojiID] = emoji.Shortcode
	}
	expected := map[string]string{
		"emoji-valid":      "33nma_4rux47",
		"emoji-legacy-one": "33nma_4rux_2",
		"emoji-legacy-two": "33nma_4rux_3",
	}
	if len(shortcodes) != len(expected) {
		t.Fatalf("expected all custom emoji records after migration, got %+v", shortcodes)
	}
	for emojiID, expectedShortcode := range expected {
		if shortcodes[emojiID] != expectedShortcode {
			t.Fatalf("expected %s to migrate to %q, got %q", emojiID, expectedShortcode, shortcodes[emojiID])
		}
	}
}

func TestSQLiteChannelFileOwnerPersists(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "echovoice.db")
	appStore, err := OpenSQLite(dbPath, "EchoVoice Test")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	member, _, _, err := appStore.UpsertMember(domain.ProfileInput{
		DisplayName:    "File Owner",
		LocalProfileID: "file-owner-device",
	})
	if err != nil {
		t.Fatalf("create member: %v", err)
	}
	sha := strings.Repeat("a", 64)
	if _, err := appStore.UpsertContentAsset(domain.ContentAsset{
		SHA256:       sha,
		SizeBytes:    12,
		MimeType:     "text/plain",
		OriginalName: "persistent.txt",
		StoragePath:  filepath.Join(t.TempDir(), sha),
	}); err != nil {
		t.Fatalf("create content asset: %v", err)
	}
	var channel domain.Channel
	for _, candidate := range appStore.Channels() {
		if candidate.Type == domain.ChannelTypeText {
			channel = candidate
			break
		}
	}
	entry, err := appStore.CreateFileEntry(domain.ChannelFileEntry{
		ChannelID:     channel.ChannelID,
		Type:          domain.ChannelFileEntryFile,
		Name:          "persistent.txt",
		AssetSHA256:   sha,
		OwnerMemberID: member.MemberID,
		SizeBytes:     12,
		MimeType:      "text/plain",
	})
	if err != nil {
		t.Fatalf("create file entry: %v", err)
	}
	if err := appStore.Close(); err != nil {
		t.Fatalf("close sqlite: %v", err)
	}

	reopened, err := OpenSQLite(dbPath, "EchoVoice Test")
	if err != nil {
		t.Fatalf("reopen sqlite: %v", err)
	}
	defer reopened.Close()
	persisted, err := reopened.FileEntry(channel.ChannelID, entry.EntryID)
	if err != nil {
		t.Fatalf("read persisted file entry: %v", err)
	}
	if persisted.OwnerMemberID != member.MemberID || persisted.AssetSHA256 != sha {
		t.Fatalf("file owner or content reference did not persist: %+v", persisted)
	}
}

func TestSQLiteSoundboardBaseVolumePersists(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "echovoice.db")
	appStore, err := OpenSQLite(dbPath, "EchoVoice Test")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sha := strings.Repeat("b", 64)
	if _, err := appStore.UpsertContentAsset(domain.ContentAsset{
		SHA256:       sha,
		SizeBytes:    128,
		MimeType:     "audio/wave",
		OriginalName: "volume.wav",
		StoragePath:  filepath.Join(t.TempDir(), sha),
	}); err != nil {
		t.Fatalf("create soundboard content asset: %v", err)
	}
	created, err := appStore.CreateSoundboardItem(domain.SoundboardItem{
		Name:        "Volume",
		AssetSHA256: sha,
		SizeBytes:   128,
		MimeType:    "audio/wave",
		BaseVolume:  1,
	})
	if err != nil {
		t.Fatalf("create soundboard item: %v", err)
	}
	updated, err := appStore.UpdateSoundboardItem(created.ItemID, domain.SoundboardItem{
		Name:       created.Name,
		StartMS:    100,
		EndMS:      900,
		BaseVolume: 1.6,
	})
	if err != nil {
		t.Fatalf("update soundboard item: %v", err)
	}
	if updated.BaseVolume != 1.6 {
		t.Fatalf("base volume was not updated: %+v", updated)
	}
	if err := appStore.Close(); err != nil {
		t.Fatalf("close sqlite: %v", err)
	}

	reopened, err := OpenSQLite(dbPath, "EchoVoice Test")
	if err != nil {
		t.Fatalf("reopen sqlite: %v", err)
	}
	defer reopened.Close()
	persisted, err := reopened.SoundboardItem(created.ItemID)
	if err != nil {
		t.Fatalf("read persisted soundboard item: %v", err)
	}
	if persisted.BaseVolume != 1.6 || persisted.StartMS != 100 || persisted.EndMS != 900 {
		t.Fatalf("soundboard volume or range did not persist: %+v", persisted)
	}
}

func TestSQLiteInvitesRetainCopyableToken(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "echovoice.db")
	store, err := OpenSQLite(dbPath, "EchoVoice Test")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	created, err := store.CreateInvite(domain.ServerInvite{
		InviteID:        "invite-test",
		Token:           "invite-copyable-token",
		TokenHash:       "invite-copyable-token-hash",
		CreatorMemberID: "member-test",
		MaxUses:         3,
		CreatedAtMS:     time.Now().UnixMilli(),
	})
	if err != nil {
		t.Fatalf("create invite: %v", err)
	}
	if created.Token == "" {
		t.Fatal("created invite token is empty")
	}
	if err := store.Close(); err != nil {
		t.Fatalf("close sqlite: %v", err)
	}

	reopened, err := OpenSQLite(dbPath, "EchoVoice Test")
	if err != nil {
		t.Fatalf("reopen sqlite: %v", err)
	}
	defer reopened.Close()
	invites := reopened.Invites()
	if len(invites) != 1 || invites[0].Token != created.Token {
		t.Fatalf("expected persisted invite token %q, got %+v", created.Token, invites)
	}
}

func TestSQLiteVoiceDurationsPersistAndDeduplicateDevices(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "echovoice.db")
	store, err := OpenSQLite(dbPath, "EchoVoice Test")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}

	first, _, _, err := store.UpsertMember(domain.ProfileInput{DisplayName: "First", LocalProfileID: "first-device"})
	if err != nil {
		t.Fatalf("create first member: %v", err)
	}
	second, _, _, err := store.UpsertMember(domain.ProfileInput{DisplayName: "Second", LocalProfileID: "second-device"})
	if err != nil {
		t.Fatalf("create second member: %v", err)
	}
	var firstChannel domain.Channel
	for _, channel := range store.Channels() {
		if channel.Type == domain.ChannelTypeVoice {
			firstChannel = channel
			break
		}
	}
	secondChannel, err := store.CreateChannel(domain.Channel{Type: domain.ChannelTypeVoice, Name: "Second voice"})
	if err != nil {
		t.Fatalf("create second voice channel: %v", err)
	}
	firstPrimary, err := store.JoinVoiceChannel(firstChannel.ChannelID, first.MemberID, "first-primary", "primary")
	if err != nil {
		t.Fatalf("join first primary device: %v", err)
	}
	if _, err := store.JoinVoiceChannel(firstChannel.ChannelID, first.MemberID, "first-listener", "listener"); err != nil {
		t.Fatalf("join first listener device: %v", err)
	}
	secondState, err := store.JoinVoiceChannel(firstChannel.ChannelID, second.MemberID, "second-primary", "primary")
	if err != nil {
		t.Fatalf("join second member: %v", err)
	}

	store.voiceStatsCheckpointMS = time.Now().Add(-5 * time.Second).UnixMilli()
	initial, err := store.VoiceDurationStats(first.MemberID, second.MemberID)
	if err != nil {
		t.Fatalf("read initial voice duration: %v", err)
	}
	if initial.TotalVoiceDurationMS < 5000 || initial.TotalVoiceDurationMS > 5500 {
		t.Fatalf("expected one deduplicated member interval around 5 seconds, got %dms", initial.TotalVoiceDurationMS)
	}
	if initial.SharedVoiceDurationMS < 5000 || initial.SharedVoiceDurationMS > 5500 {
		t.Fatalf("expected shared interval around 5 seconds, got %dms", initial.SharedVoiceDurationMS)
	}
	if !initial.MemberActive || !initial.SharedActive {
		t.Fatalf("expected both member and pair to be active, got %+v", initial)
	}

	store.voiceStatsCheckpointMS = time.Now().Add(-3 * time.Second).UnixMilli()
	if _, err := store.ManageVoiceState(secondState.ParticipantID, domain.VoiceState{ChannelID: secondChannel.ChannelID}); err != nil {
		t.Fatalf("move second member: %v", err)
	}
	afterMove, err := store.VoiceDurationStats(first.MemberID, second.MemberID)
	if err != nil {
		t.Fatalf("read duration after move: %v", err)
	}
	if afterMove.SharedVoiceDurationMS < initial.SharedVoiceDurationMS+3000 {
		t.Fatalf("expected shared duration to settle before move: before=%d after=%d", initial.SharedVoiceDurationMS, afterMove.SharedVoiceDurationMS)
	}
	if afterMove.SharedActive {
		t.Fatalf("members in different channels must not remain jointly active: %+v", afterMove)
	}

	sharedAfterMove := afterMove.SharedVoiceDurationMS
	store.voiceStatsCheckpointMS = time.Now().Add(-2 * time.Second).UnixMilli()
	separate, err := store.VoiceDurationStats(first.MemberID, second.MemberID)
	if err != nil {
		t.Fatalf("read separate duration: %v", err)
	}
	if separate.SharedVoiceDurationMS != sharedAfterMove {
		t.Fatalf("different channels must not add shared time: before=%d after=%d", sharedAfterMove, separate.SharedVoiceDurationMS)
	}
	if !separate.MemberActive {
		t.Fatalf("first member should still be active: %+v", separate)
	}
	if _, left, err := store.LeaveVoiceChannel(firstPrimary.ParticipantID); err != nil || !left {
		t.Fatalf("leave first primary device: left=%t err=%v", left, err)
	}
	if stats, err := store.VoiceDurationStats(first.MemberID, second.MemberID); err != nil || !stats.MemberActive {
		t.Fatalf("listener device should keep member active: stats=%+v err=%v", stats, err)
	}

	persisted, err := store.VoiceDurationStats(first.MemberID, second.MemberID)
	if err != nil {
		t.Fatalf("read persisted baseline: %v", err)
	}
	store.voiceStatsCheckpointMS = time.Now().Add(-2 * time.Second).UnixMilli()
	if err := store.Close(); err != nil {
		t.Fatalf("close sqlite: %v", err)
	}
	reopened, err := OpenSQLite(dbPath, "EchoVoice Test")
	if err != nil {
		t.Fatalf("reopen sqlite: %v", err)
	}
	defer reopened.db.Close()
	restored, err := reopened.VoiceDurationStats(first.MemberID, second.MemberID)
	if err != nil {
		t.Fatalf("read restored voice duration: %v", err)
	}
	if restored.TotalVoiceDurationMS < persisted.TotalVoiceDurationMS+2000 || restored.SharedVoiceDurationMS != persisted.SharedVoiceDurationMS {
		t.Fatalf("voice durations did not settle and persist on close: before=%+v after=%+v", persisted, restored)
	}
	if restored.MemberActive || restored.SharedActive {
		t.Fatalf("runtime voice presence must be cleared on restart: %+v", restored)
	}
}

func TestSQLiteVoiceDurationsMergeWithLinkedMemberIdentity(t *testing.T) {
	store, err := OpenSQLite(filepath.Join(t.TempDir(), "echovoice.db"), "EchoVoice Test")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer store.db.Close()
	primary, _, _, err := store.UpsertMember(domain.ProfileInput{DisplayName: "Primary", LocalProfileID: "primary-device"})
	if err != nil {
		t.Fatalf("create primary member: %v", err)
	}
	duplicate, _, _, err := store.UpsertMember(domain.ProfileInput{DisplayName: "Duplicate", LocalProfileID: "duplicate-device"})
	if err != nil {
		t.Fatalf("create duplicate member: %v", err)
	}
	peer, _, _, err := store.UpsertMember(domain.ProfileInput{DisplayName: "Peer", LocalProfileID: "peer-device"})
	if err != nil {
		t.Fatalf("create peer member: %v", err)
	}
	primaryPeer, _ := canonicalVoiceMemberPair(primary.MemberID, peer.MemberID)
	duplicatePeer, _ := canonicalVoiceMemberPair(duplicate.MemberID, peer.MemberID)
	primaryDuplicate, _ := canonicalVoiceMemberPair(primary.MemberID, duplicate.MemberID)
	if _, err := store.db.Exec(
		`INSERT INTO voice_member_durations (member_uuid, total_duration_ms) VALUES (?, 1000), (?, 2000)`,
		primary.MemberID,
		duplicate.MemberID,
	); err != nil {
		t.Fatalf("seed member durations: %v", err)
	}
	for pair, durationMS := range map[voiceMemberPair]int64{
		primaryPeer:      3000,
		duplicatePeer:    4000,
		primaryDuplicate: 5000,
	} {
		if _, err := store.db.Exec(
			`INSERT INTO voice_pair_durations (member_a_uuid, member_b_uuid, shared_duration_ms) VALUES (?, ?, ?)`,
			pair.First,
			pair.Second,
			durationMS,
		); err != nil {
			t.Fatalf("seed pair duration: %v", err)
		}
	}
	if _, _, err := store.LinkMembers(primary.MemberID, duplicate.MemberID); err != nil {
		t.Fatalf("link member identities: %v", err)
	}
	stats, err := store.VoiceDurationStats(primary.MemberID, peer.MemberID)
	if err != nil {
		t.Fatalf("read merged duration: %v", err)
	}
	if stats.TotalVoiceDurationMS != 3000 || stats.SharedVoiceDurationMS != 7000 {
		t.Fatalf("unexpected merged voice durations: %+v", stats)
	}
	var removedPairs int
	if err := store.db.QueryRow(
		`SELECT COUNT(*) FROM voice_pair_durations WHERE member_a_uuid = ? OR member_b_uuid = ?`,
		duplicate.MemberID,
		duplicate.MemberID,
	).Scan(&removedPairs); err != nil {
		t.Fatalf("count duplicate pairs: %v", err)
	}
	if removedPairs != 0 {
		t.Fatalf("duplicate member voice pairs remain after linking: %d", removedPairs)
	}
}

func TestSQLiteVoiceStateLifecycle(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "echovoice.db")
	store, err := OpenSQLite(dbPath, "EchoVoice Test")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	defer store.db.Close()

	member, _, _, err := store.UpsertMember(domain.ProfileInput{DisplayName: "Member"})
	if err != nil {
		t.Fatalf("upsert member: %v", err)
	}

	var voiceChannel domain.Channel
	var textChannel domain.Channel
	for _, channel := range store.Channels() {
		if channel.Type == domain.ChannelTypeVoice {
			voiceChannel = channel
		}
		if channel.Type == domain.ChannelTypeText {
			textChannel = channel
		}
	}
	if voiceChannel.ChannelID == "" || textChannel.ChannelID == "" {
		t.Fatalf("expected default text and voice channels")
	}

	if _, err := store.JoinVoiceChannel(textChannel.ChannelID, member.MemberID, "device-a", "primary"); err != ErrInvalidVoiceChannel {
		t.Fatalf("expected ErrInvalidVoiceChannel for text channel, got %v", err)
	}

	state, err := store.JoinVoiceChannel(voiceChannel.ChannelID, member.MemberID, "device-a", "primary")
	if err != nil {
		t.Fatalf("join voice channel: %v", err)
	}
	if state.ChannelID != voiceChannel.ChannelID || state.MemberID != member.MemberID {
		t.Fatalf("unexpected voice state: %+v", state)
	}

	states := store.VoiceStates()
	if len(states) != 1 || states[0].MemberID != member.MemberID {
		t.Fatalf("expected one voice state, got %+v", states)
	}

	left, ok, err := store.LeaveVoiceChannel(state.ParticipantID)
	if err != nil {
		t.Fatalf("leave voice channel: %v", err)
	}
	if !ok || left.MemberID != member.MemberID || left.ChannelID != voiceChannel.ChannelID {
		t.Fatalf("unexpected left voice state: ok=%v state=%+v", ok, left)
	}
	if states = store.VoiceStates(); len(states) != 0 {
		t.Fatalf("expected empty voice states after leave, got %+v", states)
	}
}

func TestSQLiteVoiceStatesAreClearedOnOpen(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "echovoice.db")
	store, err := OpenSQLite(dbPath, "EchoVoice Test")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}

	member, _, _, err := store.UpsertMember(domain.ProfileInput{DisplayName: "Member"})
	if err != nil {
		t.Fatalf("upsert member: %v", err)
	}
	var voiceChannel domain.Channel
	for _, channel := range store.Channels() {
		if channel.Type == domain.ChannelTypeVoice {
			voiceChannel = channel
			break
		}
	}
	if voiceChannel.ChannelID == "" {
		t.Fatalf("expected default voice channel")
	}
	if _, err := store.JoinVoiceChannel(voiceChannel.ChannelID, member.MemberID, "device-a", "primary"); err != nil {
		t.Fatalf("join voice channel: %v", err)
	}
	if err := store.db.Close(); err != nil {
		t.Fatalf("close sqlite: %v", err)
	}

	reopened, err := OpenSQLite(dbPath, "EchoVoice Test")
	if err != nil {
		t.Fatalf("reopen sqlite: %v", err)
	}
	defer reopened.db.Close()
	if states := reopened.VoiceStates(); len(states) != 0 {
		t.Fatalf("expected voice states to be cleared on open, got %+v", states)
	}
}

func TestSQLiteMemberLinkPersistsDeviceCredentialsAndRetainedProfile(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "echovoice.db")
	store, err := OpenSQLite(dbPath, "EchoVoice Test")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}

	primary, _, _, err := store.UpsertMember(domain.ProfileInput{
		DisplayName:        "Primary",
		AvatarColor:        "#7db5e8",
		LocalProfileID:     "device-primary",
		ProfileUpdatedAtMS: 1000,
	})
	if err != nil {
		t.Fatalf("upsert primary: %v", err)
	}
	duplicate, duplicateKey, _, err := store.UpsertMember(domain.ProfileInput{
		DisplayName:        "Newest profile",
		AvatarColor:        "#76c7a1",
		Bio:                "from another device",
		LocalProfileID:     "device-secondary",
		ProfileUpdatedAtMS: 2000,
	})
	if err != nil {
		t.Fatalf("upsert duplicate: %v", err)
	}
	linked, _, err := store.LinkMembers(primary.MemberID, duplicate.MemberID)
	if err != nil {
		t.Fatalf("link members: %v", err)
	}
	if linked.DisplayName != "Primary" || linked.AvatarColor != "#7db5e8" || linked.Bio != "" || linked.LinkedDevices != 2 {
		t.Fatalf("unexpected canonical member after link: %+v", linked)
	}
	if _, ok := store.Authenticate(store.Server().ServerID, primary.MemberID, duplicateKey); !ok {
		t.Fatal("expected migrated device credential to authenticate canonical member")
	}
	if err := store.db.Close(); err != nil {
		t.Fatalf("close sqlite: %v", err)
	}

	reopened, err := OpenSQLite(dbPath, "EchoVoice Test")
	if err != nil {
		t.Fatalf("reopen sqlite: %v", err)
	}
	defer reopened.db.Close()
	member, ok := reopened.Authenticate(reopened.Server().ServerID, primary.MemberID, duplicateKey)
	if !ok || member.LinkedDevices != 2 || member.DisplayName != "Primary" || member.AvatarColor != "#7db5e8" {
		t.Fatalf("expected linked identity to survive restart, ok=%t member=%+v", ok, member)
	}
	member, ok = reopened.Authenticate(reopened.Server().ServerID, duplicate.MemberID, duplicateKey)
	if !ok || member.MemberID != primary.MemberID {
		t.Fatalf("expected stale member id to resolve after restart, ok=%t member=%+v", ok, member)
	}
}

func TestSQLiteMemberMergeCodeIsConsumedAtomicallyAndRequestPersists(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "echovoice.db")
	appStore, err := OpenSQLite(dbPath, "EchoVoice Test")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	target, _, _, err := appStore.UpsertMember(domain.ProfileInput{
		DisplayName:    "Target",
		LocalProfileID: "merge-target",
	})
	if err != nil {
		t.Fatalf("upsert target: %v", err)
	}
	requester, _, _, err := appStore.UpsertMember(domain.ProfileInput{
		DisplayName:    "Requester",
		LocalProfileID: "merge-requester",
	})
	if err != nil {
		t.Fatalf("upsert requester: %v", err)
	}
	now := time.Now().UnixMilli()
	if err = appStore.SaveMemberMergeCode(domain.MemberMergeCode{
		TargetMemberID: target.MemberID,
		CodeHash:       "test-merge-code-hash",
		CreatedAtMS:    now,
		ExpiresAtMS:    now + 60_000,
	}); err != nil {
		t.Fatalf("save merge code: %v", err)
	}
	request, err := appStore.CreateMemberMergeRequestFromCode(domain.MemberMergeRequest{
		RequestID:         "merge-request-persisted",
		RequesterMemberID: requester.MemberID,
		CreatedAtMS:       now,
		ExpiresAtMS:       now + 120_000,
	}, "test-merge-code-hash", now)
	if err != nil {
		t.Fatalf("consume merge code: %v", err)
	}
	if request.TargetMemberID != target.MemberID || request.Requester.DisplayName != "Requester" {
		t.Fatalf("unexpected merge request: %+v", request)
	}
	if _, err = appStore.CreateMemberMergeRequestFromCode(domain.MemberMergeRequest{
		RequestID:         "merge-request-reused",
		RequesterMemberID: requester.MemberID,
		CreatedAtMS:       now,
		ExpiresAtMS:       now + 120_000,
	}, "test-merge-code-hash", now); !errors.Is(err, ErrMemberMergeCodeInvalid) {
		t.Fatalf("expected consumed code to be invalid, got %v", err)
	}
	if err = appStore.db.Close(); err != nil {
		t.Fatalf("close sqlite: %v", err)
	}

	reopened, err := OpenSQLite(dbPath, "EchoVoice Test")
	if err != nil {
		t.Fatalf("reopen sqlite: %v", err)
	}
	defer reopened.db.Close()
	requests := reopened.MemberMergeRequests(target.MemberID, now)
	if len(requests) != 1 || requests[0].RequestID != request.RequestID || requests[0].Requester.DisplayName != "Requester" {
		t.Fatalf("expected pending merge request after restart, got %+v", requests)
	}
	resolved, err := reopened.ResolveMemberMergeRequest(request.RequestID, target.MemberID, domain.MemberMergeRejected, now+1)
	if err != nil {
		t.Fatalf("reject merge request: %v", err)
	}
	if resolved.Status != domain.MemberMergeRejected || len(reopened.MemberMergeRequests(target.MemberID, now+1)) != 0 {
		t.Fatalf("expected rejected request to leave pending list, got %+v", resolved)
	}
}
