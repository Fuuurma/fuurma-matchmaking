# Fuurma Matchmaking

Shared Cloudflare Worker + two Durable Objects for matchmaking and per-room
WebSocket relay across all Fuurma games. Replaces PeerJS P2P for turn-based
play (see [`migrations/2026-07-games-do-websocket-migration.md`](https://github.com/Fuuurma/newProjectsPlanner/blob/main/migrations/2026-07-games-do-websocket-migration.md)).

## Architecture

- `MatchmakingQueues` DO — per-game queue, pairs the first two players, returns
  `roomId` + `wsUrl`.
- `GameRoomDO` — one DO instance per `roomId`. Accepts up to two WebSocket
  connections, fans out messages, persists slot state through hibernation,
  and grants a 30s reconnect grace via `setAlarm`.

## API

### POST `/api/matchmaking/:game/join`

Join the matchmaking queue for a game.

**Body:**
```json
{
  "peerId": "my-peer-id",
  "displayName": "Guest-1234",
  "guestId": "guest:abc-123"
}
```

**Responses:**

Waiting:
```json
{
  "status": "waiting",
  "ticket": "...",
  "roomId": "..."
}
```

Matched (now includes `wsUrl`):
```json
{
  "status": "matched",
  "match": {
    "roomId": "...",
    "role": "host" | "guest",
    "host": { "peerId": "...", "displayName": "...", "guestId": "..." },
    "guest": { "peerId": "...", "displayName": "...", "guestId": "..." },
    "wsUrl": "wss://fuurma-matchmaking.sergiformatjer1999.workers.dev/room/..."
  }
}
```

### GET `/api/matchmaking/:game/poll?ticket=...`

Poll for a match if you received a waiting ticket. Same response shape as `/join`.

### POST `/api/matchmaking/:game/leave`

Leave the queue.

**Body:**
```json
{ "ticket": "..." }
```

### GET `/api/matchmaking/:game/health`

Health check + queue stats.

### GET `/room/:roomId`

WebSocket upgrade endpoint. Opens a relay connection to the `GameRoomDO` for
the given `roomId`. Optional `?game=tictactoe|uno-chess` query param selects
the game namespace (defaults to `tictactoe`).

**Wire protocol** (JSON text frames; server is a relay, not a validator):

Client → server (first frame must be `hello`):
```json
{ "type": "hello", "guestId": "guest:abc", "displayName": "Guest-1234" }
```

Server → client after `hello`:
```json
{ "type": "welcome", "role": "host" | "guest", "opponent": { "guestId": "...", "displayName": "..." } | null }
```

Server → client when the other side arrives:
```json
{ "type": "peer-joined", "opponent": { "guestId": "...", "displayName": "..." } }
```

Server → client when the other side disconnects:
```json
{ "type": "peer-left", "reason": "disconnect" | "closed" }
```

Application messages (`move`, `rematch-request`, `rematch-accept`, `resign`,
`ping`) are relayed verbatim to the other socket. `ping` → `pong`.

**Reconnect:** a new WebSocket presenting the same `guestId` within 30s of a
disconnect reattaches to the same slot and is told `welcome` again with the
opponent info still present.

## Games supported

- `tictactoe`
- `uno-chess`

## Deploy

```bash
pnpm install
pnpm run deploy:check
pnpm run deploy
```

Live URL: `https://fuurma-matchmaking.sergiformatjer1999.workers.dev`

## Env

None required for basic operation.
