package auth

import (
	"testing"
	"time"
)

func TestSessionActivityExtendsExpiration(t *testing.T) {
	store := NewSessionStore(80 * time.Millisecond)
	token, err := store.Create("server", "member", "device")
	if err != nil {
		t.Fatal(err)
	}

	time.Sleep(50 * time.Millisecond)
	if _, ok := store.Authenticate(token); !ok {
		t.Fatal("expected active session to authenticate")
	}
	time.Sleep(50 * time.Millisecond)
	if !store.Touch(token) {
		t.Fatal("expected recent authentication to extend the session")
	}
}

func TestExpiredSessionCannotBeRenewed(t *testing.T) {
	store := NewSessionStore(25 * time.Millisecond)
	token, err := store.Create("server", "member", "device")
	if err != nil {
		t.Fatal(err)
	}

	time.Sleep(40 * time.Millisecond)
	if store.Touch(token) {
		t.Fatal("expected expired session renewal to fail")
	}
	if _, ok := store.Authenticate(token); ok {
		t.Fatal("expected expired session to remain revoked")
	}
}
