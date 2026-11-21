package auth

import (
	"net/http"
	"strings"
	"sync"
	"time"
)

type Session struct {
	ServerID  string
	MemberID  string
	DeviceID  string
	ExpiresAt time.Time
}

type SessionStore struct {
	mu       sync.RWMutex
	ttl      time.Duration
	sessions map[string]Session
}

func NewSessionStore(ttl time.Duration) *SessionStore {
	return &SessionStore{
		ttl:      ttl,
		sessions: make(map[string]Session),
	}
}

func (s *SessionStore) Create(serverID string, memberID string, deviceID string) (string, error) {
	token, err := NewToken("sess")
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[token] = Session{
		ServerID:  serverID,
		MemberID:  memberID,
		DeviceID:  deviceID,
		ExpiresAt: time.Now().Add(s.ttl),
	}
	return token, nil
}

func (s *SessionStore) RevokeDevice(serverID string, memberID string, deviceID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for token, session := range s.sessions {
		if session.ServerID == serverID && session.MemberID == memberID && session.DeviceID == deviceID {
			delete(s.sessions, token)
		}
	}
}

func (s *SessionStore) Authenticate(token string) (Session, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[token]
	if !ok {
		return Session{}, false
	}
	if time.Now().After(session.ExpiresAt) {
		delete(s.sessions, token)
		return Session{}, false
	}
	session.ExpiresAt = time.Now().Add(s.ttl)
	s.sessions[token] = session
	return session, true
}

func (s *SessionStore) Touch(token string) bool {
	if token == "" {
		return false
	}
	_, ok := s.Authenticate(token)
	return ok
}

func (s *SessionStore) RevokeMember(serverID string, memberID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for token, session := range s.sessions {
		if session.ServerID == serverID && session.MemberID == memberID {
			delete(s.sessions, token)
		}
	}
}

func SessionTokenFromRequest(req *http.Request) string {
	header := req.Header.Get("Authorization")
	if strings.HasPrefix(header, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	}
	return strings.TrimSpace(req.URL.Query().Get("session_token"))
}
