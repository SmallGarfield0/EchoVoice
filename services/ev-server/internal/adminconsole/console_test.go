package adminconsole

import (
	"bytes"
	"strings"
	"testing"

	"github.com/echovoice/echovoice/services/ev-server/internal/domain"
	"github.com/echovoice/echovoice/services/ev-server/internal/store"
	"github.com/echovoice/echovoice/services/ev-server/internal/ws"
)

func TestOwnerAndMemberLinkCommands(t *testing.T) {
	appStore := store.NewMemoryStore("Console Test")
	first, _, _, err := appStore.UpsertMember(domain.ProfileInput{
		DisplayName:        "First",
		LocalProfileID:     "device-first",
		ProfileUpdatedAtMS: 1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	second, secondKey, _, err := appStore.UpsertMember(domain.ProfileInput{
		DisplayName:        "Second",
		LocalProfileID:     "device-second",
		ProfileUpdatedAtMS: 2000,
	})
	if err != nil {
		t.Fatal(err)
	}

	var output bytes.Buffer
	console := New(appStore, ws.NewHub(), &output)
	console.Execute("owner set " + second.MemberID)
	console.Execute("member link " + first.MemberID + " " + second.MemberID)

	linked, ok := appStore.Authenticate(appStore.Server().ServerID, first.MemberID, secondKey)
	if !ok {
		t.Fatal("expected the linked device key to authenticate the retained member")
	}
	if !linked.IsOwner || linked.DisplayName != "First" || linked.LinkedDevices != 2 {
		t.Fatalf("unexpected linked member: %+v", linked)
	}
	resolved, ok := appStore.Authenticate(appStore.Server().ServerID, second.MemberID, secondKey)
	if !ok || resolved.MemberID != first.MemberID {
		t.Fatalf("expected an offline linked device to resolve to %s, ok=%t member=%+v", first.MemberID, ok, resolved)
	}
	if got := output.String(); !strings.Contains(got, "owner updated") || !strings.Contains(got, "members linked") {
		t.Fatalf("expected command confirmations, got %q", got)
	}
}
