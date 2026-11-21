# Protocol Schemas

Schema source of truth is currently split between:

- `crates/ev-protocol` for Rust protocol models.
- `packages/ev_protocol/openapi/ev-server.v1.yaml` for HTTP API shape.
- `packages/ev_protocol/events/server-events.v1.md` for WebSocket event names.

Later phases should generate client and server DTOs from a single schema source.
