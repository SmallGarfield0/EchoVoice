# EchoVoice 打包、部署与更新文档

本文档适用于当前仓库版本，覆盖 Web 客户端、桌面客户端和 EV Server 的构建、部署、安装、更新与回滚。

## 1. 部署架构与安全约束

EchoVoice 支持两种客户端连接策略：

- **桌面客户端（Tauri）**：可以连接 `http://` 或 `https://` EV Server。本机开发可继续使用 `http://127.0.0.1:17878`。
- **Web 客户端**：正式构建只允许添加 `https://` EV Server，并自动使用 `wss://` 建立事件连接。HTTP 地址会在发起网络请求前被拒绝。
- **Web 页面本身**：必须运行在浏览器安全上下文中。除浏览器认可的本机开发地址外，通过 HTTP 部署时客户端会显示 HTTPS 阻止页且不会初始化连接。
- **EV Server Web 托管**：EV Server 可以直接提供 HTTPS、API、WSS 和 Web 静态文件，不需要额外部署 Caddy、Nginx 或 Docker。
- **强制规则**：配置 `web.enabled: true` 时，EV Server 必须同时配置 `server.tls.enabled: true`、证书和私钥，否则服务器拒绝启动。

推荐生产结构：

```text
浏览器 / 桌面客户端
          |
          | HTTPS + WSS
          v
EV Server :17878
  |- /                 Web 客户端
  |- /api/v1/*         REST API
  |- /api/v1/events    WebSocket 事件
  `- data/             SQLite 与内容文件
```

## 2. 构建环境

在仓库根目录执行后续命令。推荐环境：

- Node.js 22 或更高版本，附带 npm。
- Go 1.25 或与 `services/ev-server/go.mod` 一致的版本。
- Rust 1.87 或与根目录 `Cargo.toml` 一致的版本。
- Tauri 桌面构建需要在目标操作系统上执行，不建议跨系统生成桌面安装包。

首次获取源码后安装前端依赖：

```powershell
npm --prefix apps/desktop ci
```

若 `package-lock.json` 尚未生成或正在开发依赖本身，使用：

```powershell
npm --prefix apps/desktop install
```

## 3. 打包 Web 客户端

### 3.1 验证并构建

```powershell
npm --prefix apps/desktop run test:server-url
npm --prefix apps/desktop run build
```

构建产物位于：

```text
apps/desktop/dist/
```

该目录是纯静态文件。正式构建中的 Web 客户端只接受 HTTPS EV Server。

### 3.2 准备 EV Server 的 Web 目录

Windows PowerShell：

```powershell
New-Item -ItemType Directory -Force C:\EchoVoice\web | Out-Null
Copy-Item apps\desktop\dist\* C:\EchoVoice\web -Recurse -Force
```

Linux：

```bash
sudo install -d -m 0755 /opt/echovoice/web
sudo cp -a apps/desktop/dist/. /opt/echovoice/web/
```

EV Server 会对带内容哈希的 `assets/` 文件使用长期缓存，对 `index.html` 使用 `no-cache`，更新 Web 客户端后浏览器会获取新入口文件。

## 4. 打包桌面客户端

### 4.1 Windows 构建环境

安装以下组件：

1. Node.js 与 npm。
2. Rust MSVC 工具链：`rustup default stable-msvc`。
3. Visual Studio 2022 Build Tools，勾选“使用 C++ 的桌面开发”和 Windows SDK。
4. Microsoft Edge WebView2 Runtime。
5. 构建 MSI 时启用 Windows 的 VBSCRIPT 可选功能；若出现 `failed to run light.exe`，在“启用或关闭 Windows 功能”中检查该组件。

验证前端后构建安装包：

```powershell
npm --prefix apps/desktop run build
npm run tauri:build
```

主要产物位于根目录 Cargo target：

```text
target/release/echovoice-desktop.exe
target/release/bundle/msi/
target/release/bundle/nsis/
```

优先向用户分发 `msi` 或 `nsis` 安装包，而不是单独分发 `echovoice-desktop.exe`。

### 4.2 Linux 构建环境（Debian/Ubuntu）

```bash
sudo apt update
sudo apt install -y build-essential curl wget file pkg-config libssl-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
  libasound2-dev libxdo-dev
```

安装 Node.js、Rust 后执行：

```bash
npm --prefix apps/desktop ci
npm --prefix apps/desktop run build
npm run tauri:build
```

根据当前 Tauri 打包目标，产物位于 `target/release/bundle/` 下的 `deb`、`rpm` 或 `appimage` 目录。不同 Linux 发行版的 WebKitGTK 包名可能不同，应使用该发行版的 Tauri 2 系统依赖包。

### 4.3 macOS 构建环境

安装 Xcode Command Line Tools、Node.js 和 Rust，然后执行：

```bash
npm --prefix apps/desktop ci
npm --prefix apps/desktop run build
npm run tauri:build
```

产物通常位于 `target/release/bundle/dmg/` 和 `target/release/bundle/macos/`。对外分发前还需要使用 Apple Developer ID 完成签名和公证；未签名应用只适合本机开发测试。

## 5. 打包 EV Server

EV Server 使用纯 Go SQLite 实现，可以生成单文件程序。由于当前工作目录可能不包含完整 Git 元数据，构建命令统一使用 `-buildvcs=false`。

### 5.1 一条命令同时构建 Windows 和 Linux

推荐从仓库根目录执行：

```powershell
npm run server:build
```

该命令会依次执行 Go 交叉编译，并生成：

```text
services/ev-server/bin/ev-server-windows-amd64.exe
services/ev-server/bin/ev-server-linux-amd64
```

构建脚本固定使用 `CGO_ENABLED=0`、`GOARCH=amd64`、`-trimpath` 和精简发布符号。Windows、Linux 和 macOS 构建机都可以执行这条命令，但必须先让 `go` 命令可从当前终端的 PATH 中访问。

### 5.2 运行测试

Windows PowerShell：

```powershell
Push-Location services\ev-server
go test ./...
Pop-Location
```

Linux：

```bash
cd services/ev-server
go test ./...
cd ../..
```

### 5.3 只构建 Windows amd64

```powershell
Push-Location services\ev-server
New-Item -ItemType Directory -Force bin | Out-Null
$env:CGO_ENABLED = "0"
$env:GOOS = "windows"
$env:GOARCH = "amd64"
go build -buildvcs=false -trimpath -ldflags "-s -w" -o bin\ev-server-windows-amd64.exe ./cmd/ev-server
Remove-Item Env:CGO_ENABLED, Env:GOOS, Env:GOARCH
Pop-Location
```

产物：`services/ev-server/bin/ev-server-windows-amd64.exe`。

### 5.4 只构建 Linux amd64

在 Linux 执行：

```bash
cd services/ev-server
mkdir -p bin
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
  go build -buildvcs=false -trimpath -ldflags="-s -w" \
  -o bin/ev-server-linux-amd64 ./cmd/ev-server
cd ../..
```

产物：`services/ev-server/bin/ev-server-linux-amd64`。

ARM64 服务器将 `GOARCH=amd64` 改为 `GOARCH=arm64`，并相应修改输出文件名。发布前应在目标架构运行一次 `--check-config` 和 `/healthz` 检查。

### 5.5 零参数启动

EV Server 发布程序可以直接运行，不要求附带 `--config`：

```powershell
.\ev-server-windows-amd64.exe
```

```bash
./ev-server-linux-amd64
```

程序默认以可执行文件所在目录作为服务器根目录，并在首次启动时自动生成：

```text
ev-server.yaml
data/echovoice.db
data/content/
```

生成的配置使用 `0.0.0.0:17878`、HTTP并关闭 Web 托管，可以立即供本机或局域网内的桌面客户端连接。内置 TURN 默认启用，本机测试会回退到 `127.0.0.1`；公网部署必须配置正确的 `server.public_url` 或 `rtc.turn.public_host`。`0.0.0.0` 表示监听全部网络接口，不是客户端应填写的连接地址；本机仍使用 `http://127.0.0.1:17878`，其他设备使用服务器实际的局域网地址。对公网开放前必须配置服务器密码、HTTPS 证书和防火墙规则。

通过 `go run ./cmd/ev-server` 开发运行时，根目录保持为当前工作目录，不会把配置写入 Go 临时编译目录。

## 6. SSL 证书要求

EV Server 直接读取 PEM 格式证书，不负责自动申请证书。生产证书需要满足：

1. 域名的 A/AAAA 记录指向服务器公网地址。
2. 证书的 SAN 包含访问 EV Server 使用的完整域名。
3. `cert_file` 使用包含中间证书链的文件，例如 `fullchain.pem`。
4. `key_file` 使用与证书匹配的未加密 PEM 私钥，例如 `privkey.pem`。
5. 证书必须由浏览器信任的 CA 签发。自签名证书只适合受控测试设备。
6. 私钥只允许 EV Server 运行账号读取。不要将证书私钥提交到 Git。

EV Server 会按 `reload_interval_seconds` 检查文件修改时间。证书续期后原子替换证书和私钥文件，新 TLS 连接会自动使用新证书；若新文件暂时无效，服务器继续使用上一个有效证书并重试加载。

## 7. EV Server 配置

首次直接运行 EV Server 会自动生成 `ev-server.yaml`，通常只需编辑该文件。也可以复制生产示例配置并按实际环境修改：

```powershell
Copy-Item services\ev-server\configs\ev-server.example.yaml C:\EchoVoice\ev-server.yaml
```

### 7.0 旧配置会被自动补齐

升级 EV Server 后直接用旧版 `ev-server.yaml` 启动时，程序会把这一版认识、但文件里没有的配置项**追加**到文件中，并在每条前面加一行注释：

```yaml
# added by ev-server: rtc
rtc:
  turn:
    enabled: true
    ...
```

- 已有配置项、注释、空行和程序不认识的键都原样保留，不会被重排或覆盖。
- 启动日志会提示 `Added the settings this version expects to ...` 和 `Review the lines marked \`# added by ev-server\``；第二次启动不会再改动文件。
- 写入前会先用新内容解析一遍，解析失败就不写，因此配置文件有语法错误时不会被动坏（服务仍按内置默认值 + 原文件启动）。
- 空值默认项（例如 `public_host: ""`）不会写进文件，避免暗示「空值是推荐配置」。需要公网中继时请按 7.4 手动补 `rtc.turn.public_host`。
- 补齐只影响磁盘上的文件内容，「运行时有默认值」在补齐前就已经成立——所以旧配置一直能正常启动，只是看不出服务器实际用了哪些参数。

配置项缺失不等于功能关闭：`rtc`、`realtime`、`websocket` 段缺失时对应功能按默认值启用。升级后建议执行一次 `ev-server -check-config`，再按日志提示检查新增的段落。

生产配置示例：

```yaml
server:
  name: My EchoVoice Server
  host: 0.0.0.0
  port: 17878
  public_url: https://voice.example.com:17878
  password: "请设置高强度服务器密码"
  tls:
    enabled: true
    cert_file: ./certs/fullchain.pem
    key_file: ./certs/privkey.pem
    reload_interval_seconds: 60

web:
  enabled: true
  root: ./web

storage:
  driver: sqlite
  sqlite_path: ./data/echovoice.db
  content_path: ./data/content
  max_channel_file_mb: 512
  max_soundboard_kb: 2048
  max_emoji_kb: 8192

relay:
  dm_relay_enabled: false
  private_voice_relay_enabled: false
  home_mailbox_enabled: false
  max_envelope_kb: 512

rtc:
  stun_urls: []
  turn:
    enabled: true
    listen_host: 0.0.0.0
    port: 3478
    public_host: voice.example.com
    realm: echovoice
    relay_min_port: 49160
    relay_max_port: 49460
    tcp_enabled: true
```

所有相对路径均以 `ev-server.yaml` 所在目录为基准。`public_url` 是用户实际访问的外部 URL；启用 TLS 时必须以 `https://` 开头。

### 7.1 `web` 配置说明

`web.enabled` 只控制 **EV Server 是否托管 Web 客户端的 HTML、JavaScript、CSS 和图片等静态文件**。它不控制 API、WSS、语音信令或屏幕共享信令，也不决定浏览器是否可以连接当前 EV Server。

```yaml
web:
  enabled: true
  root: ./web
```

字段含义：

- `enabled: true`：EV Server 会从 `root` 提供 Web 客户端。访问 `server.public_url` 即可打开 EchoVoice Web 页面，同时 `/api/` 和 `/healthz` 仍由 EV Server API 处理。
- `enabled: false`：EV Server 不提供 Web 客户端，只提供 API、WSS 和其他服务端能力。直接访问服务器根地址会显示 `EchoServer Running` 只读状态页；Web 客户端可以部署在其他 HTTPS 静态服务器上，然后跨域连接当前 EV Server。
- `root`：Web 构建产物目录。仅在 `enabled: true` 时使用，目录中必须直接存在 `index.html`。相对路径以 `ev-server.yaml` 所在目录为基准。**留空表示使用编译进 `ev-server.exe` 的内置 Web 客户端**，此时不需要服务器上有 `web` 目录（见 7.1.1）。

配置组合与结果：

| `web.enabled` | `server.tls.enabled` | 结果 |
| --- | --- | --- |
| `false` | `false` | EV Server 提供 HTTP API，适合本机开发和桌面客户端；正式 Web 客户端不能连接。 |
| `false` | `true` | EV Server 提供 HTTPS/WSS API和只读状态页，但不托管 Web 客户端；独立部署的 Web 客户端可以连接。 |
| `true` | `true` | EV Server 同时提供 Web 页面、HTTPS API 和 WSS，适合一体化部署。 |
| `true` | `false` | 无效配置，EV Server 会拒绝启动并提示 `web.enabled requires server.tls.enabled`。 |

需要注意：

1. Web 客户端能否连接，取决于目标 EV Server 是否提供浏览器信任的 HTTPS/WSS，而不是 `web.enabled`。
2. 正式 Web 客户端只接受 `https://` EV Server 地址。即使 Web 页面部署在其他服务器上，也不能连接明文 `http://` EV Server。
3. 桌面客户端可以连接 HTTP 或 HTTPS EV Server，因此只部署桌面客户端时可以保持 `web.enabled: false`。
4. 设置 `web.enabled: true` 前，必须把 `apps/desktop/dist/` 中的全部文件部署到 `web.root`，而不是只复制 `index.html`。若使用内置客户端（`root` 留空），跳过这一步。

#### 7.1.1 单文件部署（`web.root` 留空）

release 构建会把 Web 客户端编译进 `ev-server.exe`：`scripts/build-ev-server.mjs` 在 `go build` 前把 `apps/desktop/dist` 复制进 `internal/webassets/dist`，构建结束后清理工作区。这样服务器上不需要 `web` 目录：

```yaml
server:
  public_url: https://voice.example.com:17899
  port: "17899"
  tls:
    enabled: true
    cert_file: ./cert.pem
    key_file: ./key.pem
web:
  enabled: true
  root: ""
```

要点：

1. 首次启动会自动生成 `ev-server.yaml`，并打印下一步提示；二进制内含 Web 客户端时还会提示「设置 `web.enabled: true` 与 `web.root: ""`」。
2. 证书和私钥仍然是独立文件。`web.enabled` 强制要求 `server.tls.enabled`，而 HTTPS 需要证书，所以「单文件」指的是应用文件只剩一个 exe，不是连证书都不用。
3. 用 `ev-server.exe -check-config` 在正式启动前自检；它会同时验证证书与 Web 文件来源。
4. 从源码直接 `go build`（没有内置客户端）却把 `root` 留空时，启动会明确报错 `web is enabled with an empty web.root, but this binary has no embedded Web client`，把 `web.root` 指向目录即可恢复。
5. 访问 `server.public_url` 即得到 Web 页面；`/api/`、`/healthz`、WSS 与语音/屏幕共享信令不受影响。

##### 三步完成配置（`-quickstart`）

不用手写 YAML：

```powershell
# 1. 只把 exe 放到目录里，然后生成配置（把 URL 换成你的公网地址）
.\ev-server.exe -quickstart -public-url https://voice.example.com:17878 -password "你的服务器密码"

# 2. 把 cert.pem 与 key.pem 放到同一目录（证书不在 exe 内，这是 HTTPS 本身的文件）
# 3. 自检后启动
.\ev-server.exe -check-config
.\ev-server.exe
```

`-quickstart` 会写入一份**可以直接启动**的配置：`server.public_url`、`server.password`、`server.port`（从 URL 的端口推断）、`server.tls.enabled` 与证书路径、`web.enabled: true` + `web.root: ""`（用内置客户端）、`rtc.turn.public_host`（从 URL 的主机名推断）。它还会：

- 缺少证书时提示 `TLS file missing: ./cert.pem`，并告诉你把文件放哪里；
- 已存在配置时拒绝覆盖，除非加 `-force`；
- 只在二进制真的内置了 Web 客户端时才打开 `web.enabled`，开发构建会提示改用 `web.root`；
- 可用 `-no-web` 只提供 API，或 `-cert` / `-key` 指定证书路径。

对应的 `ev-server.yaml` 关键片段：

```yaml
server:
  public_url: https://voice.example.com:17878
  port: "17878"
  password: 你的服务器密码
  tls:
    enabled: true
    cert_file: ./cert.pem
    key_file: ./key.pem
rtc:
  turn:
    public_host: voice.example.com
web:
  enabled: true
  root: ""
```

#### 一体化部署

由 EV Server 同时托管页面和 API：

```yaml
server:
  public_url: https://voice.example.com:17878
  tls:
    enabled: true
    cert_file: ./certs/fullchain.pem
    key_file: ./certs/privkey.pem

web:
  enabled: true
  root: ./web
```

将 `apps/desktop/dist/` 的全部内容复制到 `./web/`，用户访问 `https://voice.example.com:17878` 即可打开 Web 客户端。

#### Web 客户端独立部署

Web 构建产物由独立的 HTTPS 静态服务器提供，EV Server 只提供 API 和 WSS：

```yaml
server:
  public_url: https://voice.example.com:17878
  tls:
    enabled: true
    cert_file: ./certs/fullchain.pem
    key_file: ./certs/privkey.pem

web:
  enabled: false
  root: ./web
```

例如 Web 页面部署在 `https://app.example.com`，用户打开该页面后，在添加服务器窗口输入 `https://voice.example.com:17878`。此模式不要求 EV Server 的 `web.root` 中存在 `index.html`，但 Web 页面地址和 EV Server 地址都必须使用有效 HTTPS 证书。

### 7.2 公网语音、屏幕共享与内置 TURN

语音和屏幕共享的媒体优先通过 WebRTC 点对点传输；当双方处于不同 NAT、运营商网络或企业防火墙后时，会自动使用 EV Server 内置 TURN 中继。信令连接成功只代表成员状态可以同步，并不代表媒体一定可以直连。公网部署若未正确开放 TURN，常见现象是成员能互相看到、发言状态会变化，但听不到声音或屏幕共享一直黑屏。

字段含义：

- `enabled`：是否启动内置 TURN。公网服务器应保持 `true`。
- `listen_host`：TURN 监听地址。服务器部署使用 `0.0.0.0`。
- `port`：TURN 控制端口，同时监听 UDP；`tcp_enabled: true` 时也监听同端口 TCP。
- `public_host`：客户端可访问的公网 IPv4 地址或能解析到公网 IPv4 的域名。留空时优先从 `server.public_url` 提取域名；本机配置无法得到公网域名时回退到 `127.0.0.1`，仅适合本机测试。
- `realm`：TURN 认证域。保持稳定即可，不是公开密码。
- `relay_min_port`、`relay_max_port`：实际媒体中继使用的 UDP 端口范围。范围越大，可同时承载的中继会话越多。
- `tcp_enabled`：为无法使用 UDP 的网络提供 TURN over TCP 回退。媒体流畅度通常不如 UDP，但生产环境建议开启。

客户端在认证后从 `/api/v1/rtc-config` 获取短期 TURN 凭证。凭证由 EV Server 在内存中生成，不需要也不应在 YAML 中保存固定 TURN 密码。修改 TURN 配置后必须重启 EV Server。

`realtime.disconnect_grace_seconds` 默认为 `60`。它用于容忍公网拥塞、笔记本休眠/唤醒、浏览器后台标签页挂起造成的短时 WSS 断开，避免控制连接短暂抖动时立即清除语音、屏幕共享和在线状态；不建议在公网部署中设置得低于 `10`。客户端在宽限期耗尽后会自动重新加入原语音频道。客户端屏幕共享的“自动码率”会采用适合自建 TURN 的保守值，手动选择高码率仍需确认 VPS 双向带宽足够。

公网防火墙和云平台安全组至少放行：

| 用途 | 协议 | 默认端口 |
| --- | --- | --- |
| HTTPS API、WSS、Web 页面 | TCP | `17878` |
| TURN/STUN | UDP | `3478` |
| TURN TCP 回退 | TCP | `3478` |
| TURN 媒体中继 | UDP | `49160-49460` |

如果 EV Server 位于路由器或云 NAT 后，还要将这些端口按相同端口号转发到 EV Server 主机，并把 `public_host` 设置为外部公网 IPv4/域名。TURN 域名必须直接解析到 EV Server 公网地址，不能只经过不代理 TURN/UDP 的 CDN 或普通 HTTPS 反向代理。只开放 `17878/TCP` 会导致页面、频道和成员列表正常，但跨公网语音与屏幕共享失败。TLS 证书只用于 HTTPS/WSS；当前 TURN UDP/TCP 使用短期认证，不需要为 `3478` 单独配置证书。

可用环境变量覆盖主要配置：

```text
EV_CONFIG_FILE
EV_SERVER_NAME, EV_HOST, EV_PORT, EV_PUBLIC_URL, EV_SERVER_PASSWORD
EV_TLS_ENABLED, EV_TLS_CERT_FILE, EV_TLS_KEY_FILE, EV_TLS_RELOAD_INTERVAL_SECONDS
EV_WEB_ENABLED, EV_WEB_ROOT
EV_SQLITE_PATH, EV_CONTENT_PATH
EV_TURN_ENABLED, EV_TURN_LISTEN_HOST, EV_TURN_PORT, EV_TURN_PUBLIC_HOST
EV_TURN_REALM, EV_TURN_RELAY_MIN_PORT, EV_TURN_RELAY_MAX_PORT, EV_TURN_TCP_ENABLED
EV_REALTIME_DISCONNECT_GRACE_SECONDS
```

环境变量适合临时覆盖，长期生产配置优先写入 YAML。不要把包含密码的配置公开分发。

## 8. 部署前检查

目录示例：

```text
EchoVoice/
|- ev-server.exe 或 ev-server
|- ev-server.yaml
|- certs/
|  |- fullchain.pem
|  `- privkey.pem
|- web/
|  `- index.html
|- data/
`- logs/
```

检查配置、证书和 Web 入口文件，但不启动监听端口：

Windows：

```powershell
Set-Location C:\EchoVoice
.\ev-server.exe --check-config
```

Linux：

```bash
cd /opt/echovoice
./ev-server --check-config
```

只有看到 `configuration is valid` 后才继续部署。

生产示例 `configs/ev-server.example.yaml` 默认启用 HTTPS 和 Web 托管，因此在证书文件或 `web/index.html` 尚未部署时拒绝启动是预期行为。本机仅测试 EV Server 时，可以使用 `configs/ev-server.local.example.yaml`，该配置关闭 TLS 和 Web 托管，只允许本机 HTTP 连接。

## 9. Windows 部署 EV Server

1. 将程序、配置、证书和 Web 文件放入 `C:\EchoVoice`。
2. 创建 `data` 与 `logs` 目录。
3. 限制私钥 ACL，只保留运行账号和 SYSTEM 的读取权限。
4. 放行所配置的 TCP 端口。

```powershell
New-Item -ItemType Directory -Force C:\EchoVoice\data, C:\EchoVoice\logs | Out-Null
New-NetFirewallRule -DisplayName "EchoVoice EV Server HTTPS" -Direction Inbound -Protocol TCP -LocalPort 17878 -Action Allow
```

可以直接双击 `.exe` 启动，也可以从 PowerShell 或 Windows Terminal 前台启动并观察日志：

```powershell
Set-Location C:\EchoVoice
.\ev-server.exe
```

首次启动会在程序同目录生成配置和数据文件。启动成功后窗口保持运行，并输出 `Server URL`；该地址就是桌面客户端添加服务器时填写的地址。Windows 双击产生的独立控制台如果遇到配置、证书、Web 目录或端口错误，会显示原因并等待按下 Enter 后才关闭。PowerShell、VSCode 终端和计划任务仍使用正常退出码，便于脚本和服务管理器检测失败。

生产环境可通过 Windows 任务计划程序设置“系统启动时”运行：

- 程序：`C:\EchoVoice\ev-server.exe`
- 参数：留空
- 起始于：`C:\EchoVoice`
- 选择“无论用户是否登录都运行”和“如果任务失败则重新启动”。

启动后检查：

```powershell
curl.exe https://voice.example.com:17878/healthz
```

预期返回：`{"status":"ok"}`。

## 10. Linux 部署 EV Server

创建专用账号和目录：

```bash
sudo useradd --system --home /opt/echovoice --shell /usr/sbin/nologin echovoice
sudo install -d -o echovoice -g echovoice -m 0750 /opt/echovoice
sudo install -d -o echovoice -g echovoice -m 0750 /opt/echovoice/{data,web,certs}
sudo install -o echovoice -g echovoice -m 0750 services/ev-server/bin/ev-server-linux-amd64 /opt/echovoice/ev-server
sudo install -o echovoice -g echovoice -m 0640 ev-server.yaml /opt/echovoice/ev-server.yaml
sudo chmod 0600 /opt/echovoice/certs/privkey.pem
```

创建 `/etc/systemd/system/echovoice.service`：

```ini
[Unit]
Description=EchoVoice EV Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=echovoice
Group=echovoice
WorkingDirectory=/opt/echovoice
ExecStart=/opt/echovoice/ev-server
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/echovoice/data

[Install]
WantedBy=multi-user.target
```

若证书由另一个账号续期，必须保证 `echovoice` 账号仍能读取证书文件。随后启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now echovoice
sudo systemctl status echovoice
sudo journalctl -u echovoice -f
```

使用系统防火墙和云平台安全组放行 TCP `17878`、TCP/UDP `3478` 及 UDP `49160-49460` 后检查：

```bash
curl --fail --show-error https://voice.example.com:17878/healthz
```

## 11. 同一台 VPS 部署多个 EV Server

可以在一台 VPS 上同时运行多个 EV Server。每个进程只要使用不同的监听端口和独立的数据目录，就可以共享同一份 EV Server 可执行文件。当前版本已经支持通过 `--config` 为每个进程指定配置文件；配置文件中的相对路径以该配置文件所在目录为基准。

多个实例是彼此独立的服务器，不会自动共享成员、频道、角色、消息、文件或服务器所有者。若需要两个完全独立的社区，应当使用这种多实例方式。

### 11.1 必须隔离的配置

每个实例必须具有：

1. 不同的 `server.port`。相同 IP 上的两个进程不能监听同一个端口。
2. 与端口和域名一致的 `server.public_url`。
3. 不同的 `storage.sqlite_path`。禁止多个 EV Server 同时打开同一个 SQLite 数据库。
4. 不同的 `storage.content_path`。不要让不同服务器共用附件、表情或声音板写入目录。
5. 不同的配置文件、systemd 实例或 Windows 计划任务。
6. 不同的 `rtc.turn.port`。同一 IP 上的两个 TURN 服务不能监听同一个 UDP/TCP 端口。
7. 互不重叠的 `rtc.turn.relay_min_port` 至 `relay_max_port`。媒体端口池重叠会造成随机启动或中继失败。

以下资源可以按需共享：

- EV Server 可执行文件可以共享，它只会读取指定实例的配置。
- `web.root` 可以指向同一份只读 Web 构建目录；更新这个共享目录会同时更新所有实例提供的 Web 页面。
- TLS 证书只有在证书 SAN 覆盖所有访问域名时才可以共享。使用不同子域名时，也可以分别配置证书。

有两种受支持的启动布局：

- **推荐：共享一个二进制**。每个进程使用 `--config /path/to/instance/ev-server.yaml`，便于统一更新程序。
- **零参数启动：每个实例一个程序目录**。分别复制可执行文件，让每个目录包含自己的 `ev-server.yaml` 和 `data`，再直接启动各目录中的程序。首次生成的配置都使用 `17878`，因此必须先停止进程、修改成不同端口后再同时启动。

不要对同一路径下的同一份可执行文件重复使用零参数启动；两个进程会读取同一份配置并争用端口和数据库。实例数量还应根据 VPS 的 CPU、内存、磁盘和并发语音/屏幕共享负载规划，而不只是根据可用端口决定。

推荐使用不同子域名和不同端口，例如：

```text
https://voice-a.example.com:17878
https://voice-b.example.com:17879
```

两个子域名的 A/AAAA 记录都可以指向同一台 VPS。防火墙和云平台安全组需要同时放行 TCP `17878`、`17879`，TURN TCP/UDP `3478`、`3479`，以及两个实例各自的 UDP 媒体端口池。只修改 DNS 无法让两个进程共用同一个端口；若不部署额外的反向代理，就必须保留不同端口。

### 11.2 两个实例的配置示例

实例 A 的配置文件：

```yaml
server:
  name: EchoVoice Community A
  host: 0.0.0.0
  port: 17878
  public_url: https://voice-a.example.com:17878
  password: "请为实例 A 设置独立密码"
  tls:
    enabled: true
    cert_file: /etc/letsencrypt/live/voice-a.example.com/fullchain.pem
    key_file: /etc/letsencrypt/live/voice-a.example.com/privkey.pem
    reload_interval_seconds: 60

web:
  enabled: true
  root: /opt/echovoice/web

storage:
  driver: sqlite
  sqlite_path: /var/lib/echovoice/alpha/echovoice.db
  content_path: /var/lib/echovoice/alpha/content
  max_channel_file_mb: 512
  max_soundboard_kb: 2048
  max_emoji_kb: 8192

rtc:
  turn:
    enabled: true
    listen_host: 0.0.0.0
    port: 3478
    public_host: voice-a.example.com
    realm: echovoice-alpha
    relay_min_port: 49160
    relay_max_port: 49460
    tcp_enabled: true
```

实例 B 的配置文件：

```yaml
server:
  name: EchoVoice Community B
  host: 0.0.0.0
  port: 17879
  public_url: https://voice-b.example.com:17879
  password: "请为实例 B 设置独立密码"
  tls:
    enabled: true
    cert_file: /etc/letsencrypt/live/voice-b.example.com/fullchain.pem
    key_file: /etc/letsencrypt/live/voice-b.example.com/privkey.pem
    reload_interval_seconds: 60

web:
  enabled: true
  root: /opt/echovoice/web

storage:
  driver: sqlite
  sqlite_path: /var/lib/echovoice/beta/echovoice.db
  content_path: /var/lib/echovoice/beta/content
  max_channel_file_mb: 512
  max_soundboard_kb: 2048
  max_emoji_kb: 8192

rtc:
  turn:
    enabled: true
    listen_host: 0.0.0.0
    port: 3479
    public_host: voice-b.example.com
    realm: echovoice-beta
    relay_min_port: 49201
    relay_max_port: 49241
    tcp_enabled: true
```

其他未写出的配置项继续使用 EV Server 默认值，也可以根据第 7 节的完整示例补充。正式启动前分别检查两份配置：

```bash
/opt/echovoice/bin/ev-server --config /etc/echovoice/alpha/ev-server.yaml --check-config
/opt/echovoice/bin/ev-server --config /etc/echovoice/beta/ev-server.yaml --check-config
```

### 11.3 Windows 多实例部署

推荐目录：

```text
C:\EchoVoice\
|- bin\ev-server.exe
|- web\
|- certs\
|- instances\
   |- alpha\
   |  |- ev-server.yaml
   |  `- data\
   `- beta\
      |- ev-server.yaml
      `- data\
```

Windows 配置中的实例数据可使用相对路径：

```yaml
storage:
  driver: sqlite
  sqlite_path: ./data/echovoice.db
  content_path: ./data/content
```

因为相对路径以各自的 `ev-server.yaml` 为基准，实例 A 和实例 B 会自动写入各自的 `data`。共享 Web 目录和证书目录建议填写绝对路径，例如 `C:/EchoVoice/web` 和 `C:/EchoVoice/certs/fullchain.pem`。

在两个 PowerShell 窗口中分别做前台测试：

```powershell
C:\EchoVoice\bin\ev-server.exe --config C:\EchoVoice\instances\alpha\ev-server.yaml
```

```powershell
C:\EchoVoice\bin\ev-server.exe --config C:\EchoVoice\instances\beta\ev-server.yaml
```

生产环境创建两个 Windows 计划任务：

| 计划任务 | 程序 | 参数 |
| --- | --- | --- |
| `EchoVoice Alpha` | `C:\EchoVoice\bin\ev-server.exe` | `--config C:\EchoVoice\instances\alpha\ev-server.yaml` |
| `EchoVoice Beta` | `C:\EchoVoice\bin\ev-server.exe` | `--config C:\EchoVoice\instances\beta\ev-server.yaml` |

两个任务都选择“无论用户是否登录都运行”和“如果任务失败则重新启动”。放行端口并验证：

```powershell
New-NetFirewallRule -DisplayName "EchoVoice Alpha HTTPS" -Direction Inbound -Protocol TCP -LocalPort 17878 -Action Allow
New-NetFirewallRule -DisplayName "EchoVoice Beta HTTPS" -Direction Inbound -Protocol TCP -LocalPort 17879 -Action Allow
curl.exe https://voice-a.example.com:17878/healthz
curl.exe https://voice-b.example.com:17879/healthz
```

### 11.4 Linux systemd 多实例部署

共享一个程序和 Web 构建，为每个实例创建独立配置及数据目录：

```bash
sudo install -d -o root -g root -m 0755 /opt/echovoice/bin /opt/echovoice/web
sudo install -d -o root -g echovoice -m 0750 /etc/echovoice/alpha /etc/echovoice/beta
sudo install -d -o echovoice -g echovoice -m 0750 /var/lib/echovoice/alpha/content /var/lib/echovoice/beta/content
sudo install -o root -g root -m 0755 ev-server-linux-amd64 /opt/echovoice/bin/ev-server
sudo install -o root -g echovoice -m 0640 alpha.yaml /etc/echovoice/alpha/ev-server.yaml
sudo install -o root -g echovoice -m 0640 beta.yaml /etc/echovoice/beta/ev-server.yaml
```

创建 systemd 模板 `/etc/systemd/system/echovoice@.service`：

```ini
[Unit]
Description=EchoVoice EV Server (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=echovoice
Group=echovoice
WorkingDirectory=/var/lib/echovoice/%i
ExecStart=/opt/echovoice/bin/ev-server --config /etc/echovoice/%i/ev-server.yaml
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/echovoice/%i

[Install]
WantedBy=multi-user.target
```

验证配置并启动两个实例：

```bash
sudo -u echovoice /opt/echovoice/bin/ev-server --config /etc/echovoice/alpha/ev-server.yaml --check-config
sudo -u echovoice /opt/echovoice/bin/ev-server --config /etc/echovoice/beta/ev-server.yaml --check-config
sudo systemctl daemon-reload
sudo systemctl enable --now echovoice@alpha echovoice@beta
sudo systemctl status echovoice@alpha echovoice@beta
sudo journalctl -u echovoice@alpha -u echovoice@beta -f
```

如果证书位于 `/etc/letsencrypt`，必须保证 `echovoice` 用户能够读取实际证书和私钥目标文件。随后放行两个 API 端口、两个 TURN TCP/UDP 端口和两段 TURN 媒体 UDP 端口，并分别访问 `/healthz`。

### 11.5 多实例更新、备份与排错

- 更新共享二进制前，先对每一份配置执行 `--check-config`，再停止所有实例并替换程序。
- 每个实例必须单独停止后备份自己的配置、SQLite 数据库和内容目录。不要在进程运行时复制数据库。
- 如果共享 `web.root`，替换 Web 构建会同时影响所有实例；若需要分批发布，为每个实例配置不同 Web 目录。
- 出现 `bind: address already in use` 或 Windows 套接字占用错误时，检查两个配置是否使用了相同端口。
- 频道和消息正常但公网语音/屏幕共享失败时，检查每个实例的 `turn.port`、媒体 UDP 端口池、防火墙和 `public_host`，不要只检查 API 端口。
- 出现数据串到另一服务器的现象时，立即停止实例并检查 `sqlite_path` 和 `content_path` 是否误用了同一路径。
- 服务器启动日志会输出实际读取的 `Configuration` 和 `Server URL`，可据此确认进程是否加载了正确实例。

## 12. Web 客户端部署与使用

Web 客户端支持一体化托管和独立静态托管。两种模式都要求用户最终连接的 EV Server 启用有效 HTTPS，区别只在于页面文件由谁提供。

### 12.1 由 EV Server 托管 Web 客户端

配置 `web.enabled: true`，将 `apps/desktop/dist/` 的全部内容复制到 `web.root`，然后启动 EV Server。用户直接访问：

```text
https://voice.example.com:17878
```

此时同一个地址同时提供 Web 页面、API 和 WSS。EV Server 启动时会检查 `web.root/index.html`；文件缺失时会拒绝启动并输出具体错误。

### 12.2 独立托管 Web 客户端

如果 `apps/desktop/dist/` 已部署到其他 HTTPS 静态服务器，可以保持：

```yaml
web:
  enabled: false
  root: ./web
```

用户先访问独立 Web 页面，例如：

```text
https://app.example.com
```

然后在添加服务器窗口输入 EV Server 地址：

```text
https://voice.example.com:17878
```

`web.enabled: false` 不会关闭 EV Server 的 API 或 WSS。EV Server API 已支持 Web 客户端跨域请求，因此页面域名与 EV Server 域名可以不同。

直接访问 `https://voice.example.com:17878/` 时会显示 `EchoServer Running` 状态页，用于确认地址、TLS 和服务进程正常。状态页仅公开服务器名称、启动时间、运行时长、服务器时间、传输协议、API 版本、Web 托管状态和健康检查入口，不公开配置路径、操作系统信息、成员数据、存储状态或凭证。

### 12.3 浏览器连接要求

浏览器地址栏必须显示有效 HTTPS。进入 Web 客户端后：

1. 点击服务器栏的添加入口。
2. 输入 `https://voice.example.com:17878`。
3. 输入服务器密码并连接。

Web 客户端会明确提示浏览器安全限制。以下地址会被拒绝：

```text
http://voice.example.com:17878
http://192.0.2.10:17878
```

即使 Web 页面本身使用 HTTPS，也不能连接明文 EV Server。HTTPS EV Server 的事件通道会自动变为 WSS。

## 13. 桌面客户端安装

### Windows

1. 运行 `target/release/bundle/msi/` 或 `nsis/` 中的安装包。
2. 若应用未签名，Windows 可能显示信誉警告；正式发布应使用代码签名证书签名安装包。
3. 启动 EchoVoice，通过添加服务器入口输入 HTTP 或 HTTPS EV Server 地址。

### Linux

- Debian/Ubuntu 安装 `.deb`：`sudo apt install ./EchoVoice_*.deb`。
- AppImage：添加执行权限后运行，`chmod +x EchoVoice_*.AppImage`。
- RPM 系安装 `.rpm`：`sudo rpm -i EchoVoice-*.rpm`。

### macOS

打开 `.dmg` 并将 EchoVoice 放入 Applications。正式分发版本应完成签名和 Apple 公证。

## 14. 更新流程

### 14.1 更新前备份

先停止 EV Server，再备份以下内容，避免复制 SQLite 时遗漏 WAL 数据：

```text
ev-server.yaml
data/echovoice.db
data/content/
certs/
```

Linux：

```bash
sudo systemctl stop echovoice
sudo tar -C /opt -czf /var/backups/echovoice-$(date +%Y%m%d-%H%M%S).tar.gz echovoice
```

Windows：先在任务计划程序中停止 EchoVoice 任务，然后将 `C:\EchoVoice` 复制或压缩到带日期的备份目录。

### 14.2 更新 EV Server

1. 在构建机运行 Go 测试并生成新二进制。
2. 停止旧 EV Server。
3. 保留 `ev-server.yaml`、`data`、`certs`，只替换程序文件。
4. 运行新程序的 `--check-config`。
5. 启动服务并检查 `/healthz`、服务器连接、文字和语音频道。

Linux 替换示例：

```bash
sudo systemctl stop echovoice
sudo install -o echovoice -g echovoice -m 0750 ev-server-linux-amd64 /opt/echovoice/ev-server
sudo -u echovoice /opt/echovoice/ev-server --check-config
sudo systemctl start echovoice
```

### 14.3 更新 Web 客户端

1. 重新运行 `npm --prefix apps/desktop run build`。
2. 将整个 `apps/desktop/dist/` 替换到部署目录的 `web/`。
3. 不要混合保留两次构建的 `index.html` 和 `assets`。
4. 重启 EV Server 不是必需条件；替换完成后刷新浏览器即可。

建议先复制到同级 `web.next`，确认包含 `index.html` 后再将目录切换为 `web`，避免用户在复制中途读取到不完整构建。

### 14.4 更新桌面客户端

1. 在每个目标系统重新运行 `npm run tauri:build`。
2. 提高 `apps/desktop/src-tauri/tauri.conf.json` 和应用包版本后再发布。
3. 用户关闭旧客户端并运行新安装包覆盖安装。
4. 当前版本尚未配置自动更新服务，因此每次发布需要分发新安装包。

### 14.5 推荐更新顺序

```text
备份 -> EV Server -> Web 客户端 -> 桌面客户端 -> 功能验收
```

服务端和客户端包含协议改动时，应在维护窗口内更新，并保留上一版程序与 Web 目录用于回滚。

## 15. 回滚

若更新失败：

1. 停止 EV Server。
2. 恢复上一版 EV Server 程序和上一版完整 Web 目录。
3. 如果新版本修改了持久化数据且无法向后兼容，恢复更新前的整个 `data` 备份。
4. 运行 `--check-config` 后重新启动。
5. 使用 `/healthz`、Web 登录、频道加载、消息和语音连接完成回归检查。

不要在 EV Server 运行期间直接覆盖 SQLite 数据库。

## 16. 常见问题

### `web.enabled requires server.tls.enabled`

启用了 Web 托管但未启用 TLS。配置证书并设置 `server.tls.enabled: true`，不能通过关闭校验继续使用生产 Web。

### Web 客户端提示只能连接 HTTPS

这是正式 Web 构建的强制安全策略。给目标 EV Server 配置受信任证书，并使用 `https://域名:端口`。

### 浏览器提示证书无效

检查证书域名 SAN、有效期、中间证书链、系统时间和私钥是否匹配。公网部署不要使用自签名证书。

### `web.root ... does not contain index.html`

先构建 Web 客户端，再将 `apps/desktop/dist` 的全部内容部署到 `web.root` 指向的目录。

### Windows EV Server 启动失败

新版 EV Server 在双击启动失败时会保留窗口并等待 Enter。也可以打开 PowerShell，进入程序目录后执行：

```powershell
.\ev-server-windows-amd64.exe --check-config
.\ev-server-windows-amd64.exe
```

默认会读取程序同目录的 `ev-server.yaml`。常见原因是生产配置中的证书不存在、尚未部署 `web/index.html`，或者端口已被其他 EV Server 占用。服务器会在打开 SQLite 前检查证书和 Web 文件，因此配置检查失败不会创建新的 `data`。

### 地址可以打开但 WebSocket 失败

确认使用同一个 HTTPS 地址访问 API，并检查 `https://域名:端口/api/v1/events` 对应的 WSS 连接未被本机防火墙或网络策略阻断。

### 局域网语音正常，但公网听不到声音或屏幕共享黑屏

确认启动日志包含 `Realtime relay: TURN UDP/TCP ...`，并核对 `rtc.turn.public_host` 可从客户端网络解析到 EV Server 的公网 IPv4。防火墙和云安全组必须同时开放 TURN UDP/TCP 端口及完整的媒体 UDP 端口池。只开放 HTTPS 端口不会承载 WebRTC 媒体中继。多实例部署还要确认 TURN 端口和媒体端口范围没有重叠。修改后重启 EV Server，再重新进入语音频道建立新的 ICE 会话。

### 端口占用或拒绝访问

确认没有旧 EV Server 进程占用端口。Linux 使用低于 1024 的端口还需要额外系统权限，推荐直接使用 17878 并在防火墙放行。

## 17. 官方参考

- [Tauri 2 构建前置依赖](https://v2.tauri.app/start/prerequisites/)
- [Tauri 2 Windows 安装包](https://v2.tauri.app/distribute/windows-installer/)
- [Go `net/http` TLS 与 HTTP Server](https://pkg.go.dev/net/http)
- [Go `crypto/tls` 证书链说明](https://pkg.go.dev/crypto/tls)
