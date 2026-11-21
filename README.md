# EchoVoice

<img src="icon.png" width="96" align="right" alt="EchoVoice">

[English](README.en-US.md) · **简体中文**

EchoVoice（简称 EV）是一个**桌面优先、可自建**的开源语音协作软件：用 Discord 的信息结构（服务器 / 频道 / 角色 / 成员）装下 TeamSpeak 的自建部署方式——自己开一台服务器，客户端用地址加密码直连，不需要注册中心账号。

- 桌面客户端：Tauri 2 + Svelte 5 + Rust，不自带 Chromium，安装包小、常驻内存低。
- 服务端：单个 Go 可执行文件，数据落 SQLite，双击即可开一个社区。
- 媒体：语音与屏幕共享走 WebRTC 点对点，服务端只做信令与鉴权，不转发媒体流量；服务端内建 STUN/TURN，跨公网 NAT 也能通，无需额外部署 coturn。
- 许可：AGPL-3.0-or-later。

## 功能概览

| 模块 | 状态 | 说明 |
| --- | --- | --- |
| 服务器 / 文件夹 / 邀请 | 已实现 | 多服务器列表、文件夹归类、邀请码 |
| 频道 | 已实现 | 分类 + 文字 / 语音频道、频道级语言与本地化名称 |
| 角色与权限 | 已实现 | Discord 式角色层级、频道级权限覆盖、权限预览 |
| 成员管理 | 已实现 | 踢出、拖拽移动、服务端静音 / 聋听、多设备合并为同一成员 |
| 文字聊天 | 已实现 | 编辑、删除、分页、未读与已读状态、附件 |
| 语音 | 已实现 | Opus 收发、静音 / 聋听、说话指示、设备选择、防爆音 |
| 屏幕共享 | 已实现 | Windows 原生与浏览器发送端、自适应码率与分层编码、按需观看、独立浮窗、路径诊断 |
| 远程控制 | 已实现（默认关闭） | 对方明确批准后生效，仅在其窗口内有效，本地输入优先中断 |
| 伴奏 / 一起听歌 | 已实现（Windows，默认关闭） | 按进程采集系统音频，带进程图标与独立音量 |
| 声音板 | 已实现（默认关闭） | 服务器共享 / 本地音板、波形区间、独立基础音量与播放音量 |
| 表情 | 已实现（默认关闭） | 服务器 GIF / 静态表情、本地表情包，超大素材需二次确认 |
| 频道文件 | 已实现（默认关闭） | SHA-256 内容寻址，跨服务器去重缓存 |
| 好友 / 私聊 | 未实现 | 仅有配置项与数据表占位 |
| 移动端（Android / iOS / HarmonyOS） | 未实现 | 有意后置，仅做架构预留 |

界面文案内置 `en-US` / `zh-CN`，并支持导入自定义语言包；频道可以按语言包提供本地化名称与话题。

## 技术架构

```text
┌──────────────────────────────┐
│ EchoVoice Desktop            │  Tauri 2 + Svelte 5 + Rust
└──────────────┬───────────────┘
               │ REST + WebSocket（鉴权、事件、WebRTC 信令）
               │ WebRTC（语音 / 屏幕共享，点对点，必要时经 TURN 中继）
┌──────────────▼───────────────┐
│ EV Server（Go，自建）         │  鉴权 / 权限 / 频道 / 消息
│                              │  WebSocket 事件 / 媒体信令
│                              │  内建 STUN + TURN / SQLite
│                              │  内嵌 Web 客户端 / TLS 热重载
└──────────────────────────────┘
```

三层职责：

- **桌面客户端**（`apps/desktop`）：Tauri 2 壳 + Svelte 5 UI。界面拆成 `components/*.svelte`，业务状态与状态机拆成 `lib/*.svelte.ts` 控制器（workspace、channels、messages、composer、voice-state、realtime、screen-share-transport、permissions 等），`App.svelte` 只做装配。
- **Rust 共享核心**（`crates/` 与 `apps/desktop/src-tauri`）：`ev-core`（身份、权限、状态）、`ev-media`（语音参与者状态）、`ev-protocol`（类型与事件）、`ev-crypto`、`ev-net`、`ev-store`；`src-tauri` 负责 Windows 原生采集与编码、系统钥匙串、窗口生命周期。
- **自建服务端**（`services/ev-server`）：Go 单二进制，`REST /api/v1/*` + WebSocket 事件 + SQLite（`modernc.org/sqlite`，纯 Go 无 CGO）+ Pion TURN。release 构建用 `go:embed` 把 Web 客户端打进可执行文件，部署时不需要额外的 `web/` 目录。

媒体链路刻意不做 SFU：服务端只转发 SDP / candidate 等信令，音视频在参与者之间直连；打洞失败时自动落到内建 TURN 中继。屏幕共享在此基础上做了自适应编码——按观看者分层、按背压降码率并在估算收敛后回升、中继轮换与 ICE 重启、直连 / 中继路径分类与链路诊断。

## 仓库结构

```text
apps/desktop              Tauri + Svelte 桌面客户端
crates/                   Rust 共享核心：ev-core / ev-crypto / ev-media / ev-net / ev-protocol / ev-store
services/ev-server        Go 服务端
packages/ev_protocol      REST OpenAPI 与 WebSocket 事件契约
docs/                     架构、开发、部署文档
infra/                    Docker 与 compose 编排
scripts/                  构建、缓存清理等服务端脚本
sound/                    内置提示音素材
```

## 快速开始

环境要求：Rust 1.87+、Node.js 22+；构建服务端另需 Go 1.25+。

```bash
npm install --prefix apps/desktop   # 安装桌面端依赖
npm run tauri:dev                   # 起 Vite + Tauri 开发窗口
npm run desktop:dev                 # 只起 Vite，在浏览器里调试 UI
```

服务端本地开发：

```bash
cd services/ev-server
go run ./cmd/ev-server
```

首次启动会在可执行文件旁生成 `ev-server.yaml` 与 `data/`，并打印访问地址；配置键随版本自动补齐，不会覆盖已修改的值。常用默认值：端口 `17878`、SQLite 路径 `./data/echovoice.db`、TURN 端口 `3478`。

## 构建与打包

```bash
npm run tauri:build      # 桌面安装包
npm run server:build     # 服务端单文件（Windows / Linux）
npm run tauri:icons      # 替换根目录 icon.png 后重新生成图标
npm run cache:prune      # 清理本地构建缓存
```

`server:build` 产物位于 `services/ev-server/bin/`：`ev-server-windows-amd64.exe`、`ev-server-linux-amd64`。

## 质量门

```powershell
npm --prefix apps/desktop run build
npm --prefix apps/desktop run test:workspace-browser     # 需要浏览器
npm --prefix apps/desktop run test:screen-share-browser
npm --prefix apps/desktop run test:desktop-popout         # 会短暂打开原生窗口
cd services/ev-server; go test ./...
cargo test; cargo fmt --all -- --check
```

桌面端 `scripts/*.test.ts` 下还有数十个纯逻辑套件，可用 `node --experimental-strip-types` 单独运行。`test:desktop-popout` 会短暂打开隔离的原生窗口；当 Cargo 需要替换 `target/debug/echovoice-desktop.exe` 时，请先关闭正在运行的开发客户端。

## 文档

| 文档 | 内容 |
| --- | --- |
| [项目设计文档](docs/architecture/EchoVoice项目设计文档.md) | 权限模型、数据表、API、UI 约束 |
| [部署文档](docs/deployment/EchoVoice部署文档.md) | Web / 桌面 / 服务端打包、HTTPS、安装、升级、备份回滚 |
| [开发测试启动命令](docs/development/开发测试启动命令.md) | 本地开发与测试命令速查 |
| [屏幕共享排障](docs/development/screen-share-troubleshooting.md) | 黑屏、卡顿、中继、音频不同步的定位方法 |
| [语言包](docs/development/language-packs.md) | 自定义语言包格式与制作方式 |
| [第三方声明](THIRD_PARTY_NOTICES.md) | 第三方组件与素材 |

## 参与贡献

工程约定写在 [AGENTS.md](AGENTS.md) 中，对提交代码是硬性要求，主要几条：

- 界面文案必须走 i18n，新增文案同时补齐 `en-US` 与 `zh-CN`。
- 不使用原生 `alert` / `confirm` / `prompt`、原生 `select`、数字输入框上下箭头和 `title` 气泡，统一使用项目自有组件。
- 所有可滚动区域继承 `app.css` 的全局滚动条主题；对话框、菜单、浮层不得撑大页面产生全局滚动条。
- 服务端权威状态与本地偏好分离，本地偏好使用 `ev.*` 命名空间；限额必须同时落实在 UI、持久化加载与后端边界。
- 先跑最窄的测试，再跑受影响包的构建；前端交互改动需要浏览器自动化用例覆盖。

## 许可

本项目以 [AGPL-3.0-or-later](LICENSE) 发布。第三方组件与素材声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
