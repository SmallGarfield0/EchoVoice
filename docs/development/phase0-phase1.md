# Phase 0 / Phase 1 Development

## Prerequisites

Required now:

- Rust 1.87+
- Node.js 22+
- npm 10+

Required before running the server:

- Go 1.25+

If `go` is not visible in the current shell after installation, restart the IDE/Codex shell. In the current local environment Go was found at:

```text
D:\Environment\bin\go.exe
```

## Rust Core

```powershell
cargo check
cargo test
```

## EV Server

The Go service is scaffolded in `services/ev-server`.

```powershell
cd services/ev-server
go run ./cmd/ev-server
```

Equivalent command when PATH has not refreshed:

```powershell
& 'D:\Environment\bin\go.exe' run ./cmd/ev-server
```

Default address:

```text
http://127.0.0.1:17878
```

WebSocket event stream:

```text
ws://127.0.0.1:17878/api/v1/events?session_token=...
```

Authenticated REST endpoints use:

```text
Authorization: Bearer <session_token>
```

Phase 1 permission points currently implemented:

- `administrator`
- `view_members`
- `view_channels`
- `send_messages`
- `connect_voice`
- `speak`
- `read_message_history`
- `mute_members`
- `deafen_members`
- `move_members`
- `edit_server_settings`
- `manage_roles`
- `manage_channels`
- `manage_channel_permissions`
- `manage_members`
- `manage_messages`
- `share_screen`
- `request_remote_control`
- `accept_remote_control`

The server owner is a special member flag and bypasses permission checks. It is not a role. The only built-in role is `@everyone`; custom roles are created through `/api/v1/roles`, assigned through `/api/v1/members/{member_id}/roles`, and merged with `@everyone` for effective permissions. Role hierarchy is enforced server-side: non-owner members can manage only members and roles below their highest role.

Environment variables:

```text
EV_SERVER_NAME=EchoVoice Server
EV_HOST=127.0.0.1
EV_PORT=17878
EV_SERVER_PASSWORD=
EV_STORAGE_DRIVER=sqlite
EV_SQLITE_PATH=./data/echovoice.db
EV_DM_RELAY_ENABLED=false
EV_PRIVATE_VOICE_RELAY_ENABLED=false
EV_HOME_MAILBOX_ENABLED=false
```

Storage modes:

- `sqlite`: default, stores server settings, members, credentials, roles, member role assignments, channels, channel permission overrides, messages, and current voice states in `EV_SQLITE_PATH`.
- `memory`: development-only in-memory store; all data is lost when EV Server stops.

## Desktop Client

From the repository root:

```powershell
npm run desktop:dev
npm run tauri:dev
```

The root `tauri` script also forwards extra arguments to the desktop app:

```powershell
npm run tauri info
npm run tauri dev
```

Equivalent commands inside the desktop app directory:

```powershell
cd apps/desktop
npm install
npm run dev
```

Vite dev URL:

```text
http://127.0.0.1:7173/
```

Tauri dev mode uses `apps/desktop/scripts/tauri-dev-server.mjs` as its `beforeDevCommand`. If `7173` is already serving Vite, it reuses the existing server instead of starting a second one. If Windows reports `EACCES` for this port, the port is reserved or blocked by the OS; set `EV_DESKTOP_DEV_PORT` to another free local port before running `npm run desktop:dev` or `npm run tauri:dev`.

If Vite reports `Outdated Optimize Dep` or Tauri shows `Failed to fetch dynamically imported module` after dependency changes:

```powershell
npm run desktop:clean
npm run desktop:dev
npm run tauri:dev
```

Close the old Tauri window before reopening it, because the old window may still hold a stale optimized dependency URL.

Language pack format:

```text
docs/development/language-packs.md
```

Tauri dev mode:

```powershell
npm run tauri dev
```

Credential storage:

- Tauri runtime stores server credentials in the OS keyring via Rust commands.
- Tauri runtime stores the non-sensitive server list in the app data directory.
- Plain Vite/browser development falls back to `localStorage` so UI iteration still works without a Tauri shell.

## Phase 1 Manual Check

1. Start EV Server.
2. Start the desktop Vite dev server or Tauri dev mode.
3. Click `+` in the server rail and connect to `http://127.0.0.1:17878`.
4. First connected user should become owner.
5. The client should load server info, channels, members, and messages.
6. Send a message to the default text channel. The desktop client sends the current `session_token` as `Authorization: Bearer ...`.
7. Open a second client or browser tab and confirm new messages arrive through WebSocket events.
8. As owner, create a category, then create text and voice channels either at root level or under that category.
9. Drag channels/categories in the channel list and confirm `channel.updated` reorders root channels, categories, and category children.
10. Drag a text or voice channel onto a category, then edit it and move it back to no category.
11. Confirm the new channel appears through the `channel.created` event.
12. Open a voice channel's message button and confirm messages use the voice channel's own message stream.
13. Rename that channel and confirm other clients receive `channel.updated`.
14. Delete that channel and confirm other clients receive `channel.deleted`.
15. Open server settings from the server summary area, edit the server name, toggle feature flags, and save.
16. Confirm the server settings page shows server ID, connection URL, member count, and channel count.
17. Confirm the app keeps the channel tree on the left and the member list on the right while editing server settings in the center panel.
18. In server settings, open Roles, create a custom role, drag it in the role list, grant `manage_channels`, assign it to a non-owner member, and confirm other clients receive `role.created` / `role.updated` / `member.updated`.
19. In server settings, open Channels, select a channel, deny `send_messages` for `@everyone`, then allow it for a custom role and confirm the API enforces the override.
20. In server settings, open Members, rename a non-owner member, toggle banned state, assign roles, and remove a member.
21. Edit and delete a message, then reload older messages from the message list.
22. Confirm EV Server logs `admin action=channel.create`, `admin action=channel.update`, `admin action=channel.delete`, `admin action=role.create`, `admin action=member.roles.update`, and `admin action=channel.permission_override.set` in the terminal.
23. Confirm a non-owner member receives `403` when calling `POST /api/v1/channels`, `PATCH /api/v1/channels/{id}`, `DELETE /api/v1/channels/{id}`, `POST /api/v1/roles`, or `PATCH /api/v1/members/{id}/roles` without the required role permissions.
24. Restart EV Server and reconnect with the saved local development credential.
25. The previous message should still be visible when using the default SQLite store.
26. Unauthenticated requests to `/api/v1/channels` and `/api/v1/events` should return `401`.
