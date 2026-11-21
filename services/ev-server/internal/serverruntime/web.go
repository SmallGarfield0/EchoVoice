package serverruntime

import (
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"

	"github.com/echovoice/echovoice/services/ev-server/internal/config"
	"github.com/echovoice/echovoice/services/ev-server/internal/webassets"
)

// embeddedWebClient is a seam so tests can exercise both the bundled and the
// directory-backed Web client without a release build.
var embeddedWebClient = webassets.FS

// webClientFilesystem resolves where the Web client comes from: an empty
// web.root means "the copy compiled into this binary", which is what makes a
// single ev-server.exe a complete deployment.
func webClientFilesystem(cfg config.WebConfig) (fs.FS, string, error) {
	if strings.TrimSpace(cfg.Root) == "" {
		root := embeddedWebClient()
		info, err := fs.Stat(root, "index.html")
		if err != nil || info.IsDir() {
			return nil, "", fmt.Errorf(
				"web is enabled with an empty web.root, but this binary has no embedded Web client: " +
					"set web.root to the built client directory, or use a release build that bundles it")
		}
		return root, "embedded", nil
	}
	return os.DirFS(cfg.Root), fmt.Sprintf("web.root %q", cfg.Root), nil
}

func withWebClient(api http.Handler, cfg config.WebConfig) (http.Handler, error) {
	if !cfg.Enabled {
		return api, nil
	}
	root, source, err := webClientFilesystem(cfg)
	if err != nil {
		return nil, err
	}
	indexInfo, err := fs.Stat(root, "index.html")
	if err != nil {
		return nil, fmt.Errorf("%s does not contain index.html: %w", source, err)
	}
	if indexInfo.IsDir() {
		return nil, fmt.Errorf("%s has a directory named index.html", source)
	}

	static := http.FileServer(http.FS(root))
	web := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodGet && req.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		requested := strings.TrimPrefix(path.Clean("/"+req.URL.Path), "/")
		if requested == "." || requested == "" {
			requested = "index.html"
		}
		info, statErr := fs.Stat(root, requested)
		if statErr == nil && !info.IsDir() {
			setWebCacheHeaders(w, requested)
			static.ServeHTTP(w, req)
			return
		}
		if statErr != nil && !errors.Is(statErr, fs.ErrNotExist) {
			http.Error(w, "unable to read Web client", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeFileFS(w, req, root, "index.html")
	})

	mux := http.NewServeMux()
	mux.Handle("/api", api)
	mux.Handle("/api/", api)
	mux.Handle("/healthz", api)
	mux.Handle("/", withWebSecurityHeaders(web))
	return mux, nil
}

func setWebCacheHeaders(w http.ResponseWriter, requested string) {
	if strings.HasPrefix(requested, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
}

func withWebSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; connect-src 'self' https: wss:; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, req)
	})
}
