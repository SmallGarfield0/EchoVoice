package serverruntime

import (
	"context"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/echovoice/echovoice/services/ev-server/internal/config"
	"github.com/echovoice/echovoice/services/ev-server/internal/webassets"
)

func TestWebClientServesAssetsAndSPAFallback(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte("<main>EchoVoice</main>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "assets", "app.js"), []byte("export {};"), 0o600); err != nil {
		t.Fatal(err)
	}
	api := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"ok"}`)
	})
	handler, err := withWebClient(api, config.WebConfig{Enabled: true, Root: root})
	if err != nil {
		t.Fatal(err)
	}

	spa := httptest.NewRecorder()
	handler.ServeHTTP(spa, httptest.NewRequest(http.MethodGet, "/channels/example", nil))
	if spa.Code != http.StatusOK || spa.Body.String() != "<main>EchoVoice</main>" {
		t.Fatalf("unexpected SPA response: status=%d body=%q", spa.Code, spa.Body.String())
	}
	if spa.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("Web security headers were not applied")
	}

	asset := httptest.NewRecorder()
	handler.ServeHTTP(asset, httptest.NewRequest(http.MethodGet, "/assets/app.js", nil))
	if asset.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("unexpected asset cache header: %q", asset.Header().Get("Cache-Control"))
	}

	apiResponse := httptest.NewRecorder()
	handler.ServeHTTP(apiResponse, httptest.NewRequest(http.MethodGet, "/api/v1/server", nil))
	if apiResponse.Body.String() != `{"status":"ok"}` {
		t.Fatalf("API request was handled by Web fallback: %q", apiResponse.Body.String())
	}
}

func TestWebClientRequiresIndex(t *testing.T) {
	_, err := withWebClient(http.NotFoundHandler(), config.WebConfig{Enabled: true, Root: t.TempDir()})
	if err == nil {
		t.Fatal("expected missing index.html to fail")
	}
}

func TestWebClientUsesTheEmbeddedBundleWhenWebRootIsEmpty(t *testing.T) {
	// A single ev-server.exe is supposed to be a complete deployment, so an empty
	// web.root must resolve to the bundle compiled into the binary.
	previous := embeddedWebClient
	t.Cleanup(func() { embeddedWebClient = previous })
	embeddedWebClient = func() fs.FS {
		return fstest.MapFS{
			"index.html": &fstest.MapFile{Data: []byte("<main>bundled</main>")},
		}
	}
	handler, err := withWebClient(http.NotFoundHandler(), config.WebConfig{Enabled: true, Root: ""})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
	if recorder.Code != http.StatusOK || recorder.Body.String() != "<main>bundled</main>" {
		t.Fatalf("unexpected embedded response: status=%d body=%q", recorder.Code, recorder.Body.String())
	}
}

func TestWebClientRejectsAnEmptyRootWithoutAnEmbeddedBundle(t *testing.T) {
	if webassets.HasIndex() {
		t.Skip("this build bundles a Web client, so the missing-bundle path cannot be exercised")
	}
	_, err := withWebClient(http.NotFoundHandler(), config.WebConfig{Enabled: true, Root: ""})
	if err == nil {
		t.Fatal("an empty web.root without a bundled client must fail loudly")
	}
	if !strings.Contains(err.Error(), "web.root") || !strings.Contains(err.Error(), "embedded") {
		t.Fatalf("the error must point at both sources, got %q", err)
	}
}

func TestPublicStatusPageWhenWebClientIsDisabled(t *testing.T) {
	api := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		http.Error(w, "api fallback", http.StatusNotFound)
	})
	startedAt := time.Now().UTC().Add(-90 * time.Minute)
	handler := withPublicStatusPage(api, publicStatusInfo{
		ServerName: "Public <EchoVoice>",
		StartedAt:  startedAt,
		TLS:        true,
	})

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	body := response.Body.String()
	if response.Code != http.StatusOK {
		t.Fatalf("unexpected status page response: %d", response.Code)
	}
	for _, expected := range []string{
		"EchoServer Running",
		"Public &lt;EchoVoice&gt;",
		"0.1.x",
		startedAt.Format(time.RFC3339),
		"1h30m",
		"HTTPS",
		"EchoVoice API v1",
		"/healthz",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("status page is missing %q: %s", expected, body)
		}
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Content-Security-Policy") == "" {
		t.Fatalf("status page security headers are incomplete: %+v", response.Header())
	}

	unknown := httptest.NewRecorder()
	handler.ServeHTTP(unknown, httptest.NewRequest(http.MethodGet, "/not-a-public-status-route", nil))
	if unknown.Code != http.StatusNotFound || !strings.Contains(unknown.Body.String(), "api fallback") {
		t.Fatalf("non-root route did not reach the API handler: status=%d body=%q", unknown.Code, unknown.Body.String())
	}
}

func TestServerUsesPublicStatusPageWhenWebHostingIsDisabled(t *testing.T) {
	cfg := config.Defaults()
	cfg.Server.Name = "EchoVoice Status Integration"
	cfg.Server.Host = "127.0.0.1"
	cfg.Server.Port = "0"
	cfg.Web.Enabled = false
	server, err := New(cfg, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		_, _ = io.WriteString(w, "api:"+req.URL.Path)
	}))
	if err != nil {
		t.Fatal(err)
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve() }()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
		<-serveDone
	})

	response, err := http.Get("http://" + server.Address() + "/")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "EchoServer Running") {
		t.Fatalf("server root did not expose the public status page: status=%d body=%q", response.StatusCode, body)
	}
}
