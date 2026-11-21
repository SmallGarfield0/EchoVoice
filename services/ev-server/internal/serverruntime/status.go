package serverruntime

import (
	"bytes"
	"html/template"
	"net/http"
	"strings"
	"time"

	"github.com/echovoice/echovoice/services/ev-server/internal/buildinfo"
)

type publicStatusInfo struct {
	ServerName string
	StartedAt  time.Time
	TLS        bool
}

type publicStatusPageData struct {
	ServerName    string
	ServerVersion string
	StartedAt     string
	Uptime        string
	ServerTime    string
	Transport     string
	WebClient     string
	APIVersion    string
	HealthCheck   string
}

var publicStatusTemplate = template.Must(template.New("ev-server-status").Parse(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>EchoServer Running</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #050607; color: #f4f7f9; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 24px; background: #050607; }
    main { width: min(620px, 100%); border: 1px solid #30353a; border-radius: 8px; overflow: hidden; background: #101214; box-shadow: 0 24px 70px rgba(0, 0, 0, .48); }
    header { display: flex; align-items: center; gap: 14px; padding: 22px 24px; border-bottom: 1px solid #292d31; }
    .status { width: 12px; height: 12px; flex: 0 0 auto; border-radius: 50%; background: #69d99a; box-shadow: 0 0 0 5px rgba(105, 217, 154, .12); }
    h1, p { margin: 0; }
    h1 { font-size: 21px; letter-spacing: 0; }
    header p { margin-top: 4px; color: #9ba6ae; font-size: 13px; }
    dl { display: grid; grid-template-columns: minmax(130px, .7fr) minmax(0, 1.3fr); margin: 0; padding: 10px 24px; }
    dt, dd { min-width: 0; margin: 0; padding: 11px 0; border-bottom: 1px solid #24282c; font-size: 13px; }
    dt { color: #8f9aa2; }
    dd { color: #e7edf1; overflow-wrap: anywhere; }
    dl > :nth-last-child(-n+2) { border-bottom: 0; }
    footer { padding: 16px 24px; border-top: 1px solid #292d31; color: #8f9aa2; font-size: 12px; }
    a { color: #9bd8ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    @media (max-width: 520px) { dl { grid-template-columns: 1fr; } dt { padding-bottom: 3px; border-bottom: 0; } dd { padding-top: 0; } dl > :nth-last-child(-n+2) { border-bottom: 0; } }
  </style>
</head>
<body>
  <main>
    <header>
      <span class="status" aria-hidden="true"></span>
      <div><h1>EchoServer Running</h1><p>{{.ServerName}}</p></div>
    </header>
    <dl>
      <dt>Status</dt><dd>Running</dd>
      <dt>Server version</dt><dd>{{.ServerVersion}}</dd>
      <dt>Started at</dt><dd><time datetime="{{.StartedAt}}">{{.StartedAt}}</time></dd>
      <dt>Uptime</dt><dd>{{.Uptime}}</dd>
      <dt>Server time</dt><dd><time datetime="{{.ServerTime}}">{{.ServerTime}}</time></dd>
      <dt>Transport</dt><dd>{{.Transport}}</dd>
      <dt>API</dt><dd>{{.APIVersion}}</dd>
      <dt>Web client hosting</dt><dd>{{.WebClient}}</dd>
      <dt>Health check</dt><dd><a href="{{.HealthCheck}}">{{.HealthCheck}}</a></dd>
    </dl>
    <footer>This endpoint intentionally exposes operational status only. Add this server URL in an EchoVoice client to connect.</footer>
  </main>
</body>
</html>`))

func withPublicStatusPage(next http.Handler, info publicStatusInfo) http.Handler {
	startedAt := info.StartedAt.UTC()
	if startedAt.IsZero() {
		startedAt = time.Now().UTC()
	}
	serverName := strings.TrimSpace(info.ServerName)
	if serverName == "" {
		serverName = "EchoVoice Server"
	}
	status := withWebSecurityHeaders(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method != http.MethodGet && req.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		now := time.Now().UTC()
		uptime := now.Sub(startedAt)
		if uptime < 0 {
			uptime = 0
		}
		transport := "HTTP"
		if info.TLS {
			transport = "HTTPS"
		}
		data := publicStatusPageData{
			ServerName:    serverName,
			ServerVersion: buildinfo.PublicVersion(),
			StartedAt:     startedAt.Format(time.RFC3339),
			Uptime:        uptime.Truncate(time.Second).String(),
			ServerTime:    now.Format(time.RFC3339),
			Transport:     transport,
			WebClient:     "Disabled",
			APIVersion:    "EchoVoice API v1",
			HealthCheck:   "/healthz",
		}
		var body bytes.Buffer
		if err := publicStatusTemplate.Execute(&body, data); err != nil {
			http.Error(w, "unable to render server status", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		if req.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		_, _ = w.Write(body.Bytes())
	}))

	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path == "/" {
			status.ServeHTTP(w, req)
			return
		}
		next.ServeHTTP(w, req)
	})
}
