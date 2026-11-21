# EchoVoice

<img src="icon.png" width="96" align="right" alt="EchoVoice">

**English** · [简体中文](README.md)

EchoVoice is a desktop-first, self-hosted voice collaboration app. It pairs Discord's information model (servers, channels, roles, members) with TeamSpeak's deployment model: run your own server, and let clients connect with an address plus a password — no central account required.

- Desktop client: Tauri 2 + Svelte 5 + Rust. No bundled Chromium, small installers, low idle memory.
- Server: a single Go binary with SQLite persistence; double-click to start a community.
- Media: voice and screen sharing run over peer-to-peer WebRTC. The server only carries signaling and authorization, never media. Built-in STUN/TURN handles NAT traversal, so no extra coturn deployment is needed.
- License: AGPL-3.0-or-later.

## Features

| Area | Status | Notes |
| --- | --- | --- |
| Servers, folders, invites | Implemented | Multiple servers, folder grouping, invite codes |
| Channels | Implemented | Categories plus text and voice channels, per-channel language and localized names |
| Roles and permissions | Implemented | Discord-style role hierarchy, channel permission overrides, permission preview |
| Member management | Implemented | Kick, drag to move, server mute/deafen, merge multi-device members |
| Text chat | Implemented | Edit, delete, pagination, read state, attachments |
| Voice | Implemented | Opus send/receive, mute/deafen, speaking indicator, device selection, de-click |
| Screen sharing | Implemented | Windows native and browser senders, adaptive bitrate and layered encoding, on-demand viewing, popout window, path diagnostics |
| Remote control | Implemented (off by default) | Requires explicit approval, only inside the approved window, local input always preempts |
| Accompaniment playback | Implemented (Windows, off by default) | Captures per-process system audio with process icons and independent volume |
| Soundboard | Implemented (off by default) | Server and local boards, waveform ranges, separate base and playback volume |
| Emoji | Implemented (off by default) | Server GIF/static emoji, local emoji packs, confirmation for oversized assets |
| Channel files | Implemented (off by default) | SHA-256 content addressing with cross-server dedup cache |
| Friends / direct messages | Not implemented | Config flags and table placeholders only |
| Mobile clients | Not implemented | Intentionally deferred; architecture leaves room for reuse |

UI strings ship in `en-US` and `zh-CN`, and custom language packs can be imported. Channels can expose localized names and topics per language pack.

## Architecture

```text
┌──────────────────────────────┐
│ EchoVoice Desktop            │  Tauri 2 + Svelte 5 + Rust
└──────────────┬───────────────┘
               │ REST + WebSocket (auth, events, WebRTC signaling)
               │ WebRTC (voice / screen share, peer to peer, TURN when needed)
┌──────────────▼───────────────┐
│ EV Server (Go, self-hosted)  │  auth / permissions / channels / messages
│                              │  WebSocket events / media signaling
│                              │  built-in STUN + TURN / SQLite
│                              │  embedded web client / TLS hot reload
└──────────────────────────────┘
```

Three layers:

- **Desktop client** (`apps/desktop`): a Tauri 2 shell around a Svelte 5 UI. Views live in `components/*.svelte`, state machines in `lib/*.svelte.ts` controllers (workspace, channels, messages, composer, voice-state, realtime, screen-share-transport, permissions), and `App.svelte` only wires them together.
- **Rust shared core** (`crates/` and `apps/desktop/src-tauri`): `ev-core` (identity, permissions, state), `ev-media` (voice participant state), `ev-protocol` (types and events), `ev-crypto`, `ev-net`, `ev-store`; `src-tauri` owns Windows capture/encoding, the OS keychain, and window lifecycle.
- **Self-hosted server** (`services/ev-server`): a single Go binary exposing `REST /api/v1/*` and WebSocket events, backed by SQLite (`modernc.org/sqlite`, pure Go, no CGO) and Pion TURN. Release builds embed the web client with `go:embed`, so no separate `web/` directory is required.

The media path deliberately avoids an SFU: the server forwards only SDP/candidates, and audio/video flows directly between participants, falling back to the built-in TURN relay when hole punching fails. Screen sharing adds adaptive encoding on top: per-viewer layers, bitrate backoff with recovery, relay rotation and ICE restart, and direct/relay path classification with link diagnostics.

## Repository layout

```text
apps/desktop              Tauri + Svelte desktop client
crates/                   Rust shared core: ev-core / ev-crypto / ev-media / ev-net / ev-protocol / ev-store
services/ev-server        Go EV Server
packages/ev_protocol      REST OpenAPI and WebSocket event contracts
docs/                     Architecture, development, and deployment docs
infra/                    Docker and compose files
scripts/                  Server build and cache-maintenance scripts
sound/                    Bundled notification sounds
```

## Getting started

Prerequisites: Rust 1.87+, Node.js 22+; building the server also needs Go 1.25+.

```bash
npm install --prefix apps/desktop   # install desktop dependencies
npm run tauri:dev                   # Vite + Tauri development window
npm run desktop:dev                 # Vite only, for debugging the UI in a browser
```

Running the server locally:

```bash
cd services/ev-server
go run ./cmd/ev-server
```

On first launch the server creates `ev-server.yaml` and `data/` next to the executable and prints its URL. Missing config keys are added on upgrade without overwriting values you changed. Defaults include port `17878`, SQLite at `./data/echovoice.db`, and TURN on `3478`.

## Building and packaging

```bash
npm run tauri:build      # desktop installers
npm run server:build     # single-file server for Windows and Linux
npm run tauri:icons      # regenerate icons after replacing icon.png
npm run cache:prune      # prune local build caches
```

`server:build` writes `services/ev-server/bin/ev-server-windows-amd64.exe` and `services/ev-server/bin/ev-server-linux-amd64`.

## Verification

```powershell
npm --prefix apps/desktop run build
npm --prefix apps/desktop run test:workspace-browser     # needs a browser
npm --prefix apps/desktop run test:screen-share-browser
npm --prefix apps/desktop run test:desktop-popout         # briefly opens a native window
cd services/ev-server; go test ./...
cargo test; cargo fmt --all -- --check
```

Several dozen pure-logic suites under `apps/desktop/scripts/*.test.ts` can be run individually with `node --experimental-strip-types`. `test:desktop-popout` opens an isolated native window briefly; close a running development client before Cargo needs to replace `target/debug/echovoice-desktop.exe`.

## Documentation

| Document | Contents |
| --- | --- |
| [Design document](docs/architecture/EchoVoice项目设计文档.md) | Permission model, tables, API, UI constraints |
| [Deployment guide](docs/deployment/EchoVoice部署文档.md) | Web/desktop/server packaging, HTTPS, install, update, backup and rollback |
| [Development commands](docs/development/开发测试启动命令.md) | Local development and test command reference |
| [Screen share troubleshooting](docs/development/screen-share-troubleshooting.md) | Black frames, stutter, relay and audio-sync diagnosis |
| [Language packs](docs/development/language-packs.md) | Language pack format and authoring |
| [Third-party notices](THIRD_PARTY_NOTICES.md) | Bundled components and assets |

## Contributing

The project conventions in [AGENTS.md](AGENTS.md) are mandatory for contributed code:

- All user-facing strings go through i18n, with both `en-US` and `zh-CN` entries added together.
- Do not ship native `alert` / `confirm` / `prompt`, native `select`, number-input spinners, or `title` tooltips; use the project's own components.
- Every scrollable region inherits the global scrollbar theme from `app.css`; dialogs, menus, and popovers must not create page-level scrollbars.
- Keep server-authoritative state separate from local preferences; local preferences use the `ev.*` namespace, and every limit is enforced in the UI, the persistence loader, and the backend boundary.
- Run the narrowest relevant tests first, then the affected package build; frontend interaction changes need browser automation coverage.

## License

Released under [AGPL-3.0-or-later](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for third-party components and assets.
