# EchoVoice Server Events v1

Phase 1 exposes a development WebSocket event stream at:

```text
GET /api/v1/events?session_token=...
```

The current implementation requires a valid short-lived session token, then broadcasts JSON events to all connected clients. It does not yet enforce per-channel subscription filtering.

| Event | Direction | Purpose |
| --- | --- | --- |
| `server.updated` | server -> client | Server settings changed |
| `channel.created` | server -> client | Channel created |
| `channel.updated` | server -> client | Channel updated |
| `channel.deleted` | server -> client | Channel deleted |
| `channel.permission_override.updated` | server -> client | Channel permission override created or updated |
| `channel.permission_override.deleted` | server -> client | Channel permission override deleted |
| `member.joined` | server -> client | Member joined |
| `member.updated` | server -> client | Member updated |
| `member.left` | server -> client | Member left |
| `message.created` | server -> client | Message created |
| `message.updated` | server -> client | Message updated |
| `message.deleted` | server -> client | Message deleted |
| `voice.state.updated` | server -> client | Voice state changed |
| `voice.state.deleted` | server -> client | Member left voice |
| `role.created` | server -> client | Server role created |
| `role.updated` | server -> client | Server role changed |
| `role.deleted` | server -> client | Server role deleted |
| `rtc.signal` | bidirectional | WebRTC signaling |
| `friend.requested` | server -> client | Friend request arrived |
| `dm.envelope.received` | server -> client | Encrypted DM envelope arrived |
| `private_call.signal` | bidirectional | Private call signaling |

## `rtc.signal` Payload

## `voice.state.updated` Payload

Voice state payloads include the member's current voice channel and local audio status:

```json
{
  "channel_id": "channel-id",
  "member_id": "member-id",
  "joined_at_ms": 1760000000000,
  "mic_muted": false,
  "audio_deafened": false,
  "is_speaking": false
}
```

When `audio_deafened` is `true`, `mic_muted` is also treated as `true`. When either muted flag is true, `is_speaking` is forced to false.

`rtc.signal` is forwarded only between members currently joined to the same voice channel.

```json
{
  "channel_id": "channel-id",
  "from_member_id": "sender-member-id",
  "target_member_id": "optional-target-member-id",
  "signal_type": "offer | answer | ice-candidate",
  "data": {}
}
```

When `target_member_id` is omitted, EV Server broadcasts the signal to other members in the same voice channel. When it is present, EV Server validates that the target member is also in that voice channel before forwarding.
