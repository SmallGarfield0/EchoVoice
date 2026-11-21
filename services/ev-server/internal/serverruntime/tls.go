package serverruntime

import (
	"crypto/tls"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/echovoice/echovoice/services/ev-server/internal/config"
)

type certificateReloader struct {
	mu            sync.RWMutex
	certFile      string
	keyFile       string
	certificate   *tls.Certificate
	certModified  time.Time
	keyModified   time.Time
	nextCheck     time.Time
	checkInterval time.Duration
}

func newTLSConfig(cfg config.TLSConfig) (*tls.Config, error) {
	reloader := &certificateReloader{
		certFile:      cfg.CertFile,
		keyFile:       cfg.KeyFile,
		checkInterval: time.Duration(cfg.ReloadIntervalSeconds) * time.Second,
	}
	if err := reloader.reload(true); err != nil {
		return nil, err
	}
	return &tls.Config{
		MinVersion:     tls.VersionTLS12,
		GetCertificate: reloader.getCertificate,
		NextProtos:     []string{"h2", "http/1.1"},
	}, nil
}

func (r *certificateReloader) getCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	if err := r.reload(false); err != nil {
		// Keep serving the last valid certificate when an in-place renewal is incomplete.
		r.mu.RLock()
		certificate := r.certificate
		r.mu.RUnlock()
		if certificate != nil {
			return certificate, nil
		}
		return nil, err
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.certificate, nil
}

func (r *certificateReloader) reload(force bool) error {
	now := time.Now()
	r.mu.RLock()
	nextCheck := r.nextCheck
	r.mu.RUnlock()
	if !force && now.Before(nextCheck) {
		return nil
	}

	certInfo, err := os.Stat(r.certFile)
	if err != nil {
		return fmt.Errorf("read TLS certificate %q: %w", r.certFile, err)
	}
	keyInfo, err := os.Stat(r.keyFile)
	if err != nil {
		return fmt.Errorf("read TLS private key %q: %w", r.keyFile, err)
	}

	r.mu.RLock()
	unchanged := r.certificate != nil && certInfo.ModTime().Equal(r.certModified) && keyInfo.ModTime().Equal(r.keyModified)
	r.mu.RUnlock()
	if unchanged && !force {
		r.mu.Lock()
		r.nextCheck = now.Add(r.checkInterval)
		r.mu.Unlock()
		return nil
	}

	certificate, err := tls.LoadX509KeyPair(r.certFile, r.keyFile)
	if err != nil {
		return fmt.Errorf("load TLS certificate and key: %w", err)
	}
	r.mu.Lock()
	r.certificate = &certificate
	r.certModified = certInfo.ModTime()
	r.keyModified = keyInfo.ModTime()
	r.nextCheck = now.Add(r.checkInterval)
	r.mu.Unlock()
	return nil
}
