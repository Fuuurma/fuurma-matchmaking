# Fuurma Matchmaking

Shared Cloudflare Worker + two Durable Objects for matchmaking and per-room
WebSocket relay across all Fuurma games. Replaces PeerJS P2P for turn-based
play (see [`migrations/2026-07-games-do-websocket-migration.md`](https://github.com/Fuuurma/hub/blob/main/migrations/2026-07-games-do-websocket-migration.md)).

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

`ticket` and `roomId` are 128-bit opaque locators rendered as 32 hex
characters. Treat both as opaque strings: they carry no timestamp, counter or
structure to parse, and a `poll` or `leave` presenting anything other than the
exact ticket that was issued is rejected with `400`.

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

To reclaim an existing slot after a disconnect, the `hello` must also carry the
private `reconnectToken` that player's `welcome` returned. `guestId` alone is
refused, because the opponent learns that id:
```json
{ "type": "hello", "guestId": "guest:abc", "reconnectToken": "<32 hex chars>" }
```

Server → client after `hello`:
```json
{ "type": "welcome", "role": "host" | "guest", "reconnectToken": "<32 hex chars>", "opponent": { "guestId": "...", "displayName": "..." } | null }
```

`reconnectToken` is 128 bits of private credential, one per player per room.
It is returned only to the player it belongs to and is never relayed to the
opponent. Treat it like a session secret: keep it per room, and discard it
when the room is over.

Server → client when the other side arrives:
```json
{ "type": "peer-joined", "opponent": { "guestId": "...", "displayName": "..." } }
```

Server → client when the other side disconnects:
```json
{ "type": "peer-left", "reason": "disconnect" | "closed" | "expired" }
```

`disconnect` is transient and retains the player slot for 30 seconds. A
reconnect that presents both the same `guestId` **and** that player's
`reconnectToken` receives `welcome` and the remaining peer receives:

```json
{ "type": "peer-reconnected", "opponent": { "guestId": "guest:abc", "displayName": "Guest-1234" } }
```

`closed` and `expired` are final room lifecycle events.

Application messages (`move`, `rematch-request`, `rematch-accept`, `resign`,
`ping`) are relayed verbatim to the other socket. `ping` → `pong`.

**Reconnect:** a new WebSocket presenting the same `guestId` and
`reconnectToken` within 30s of a disconnect reattaches to the same slot and is
told `welcome` again with the opponent info still present. The other client
receives `peer-reconnected`. A `hello` carrying the `guestId` without the
credential is rejected with `reconnect credential required`. A slot persisted
by a build from before this contract existed has no credential yet; it is
minted once, on an uncontested `hello`, and required from then on.

Join requests are bounded and rate-limited per client address. The Worker
rejects malformed JSON, oversized identifiers, invalid leave tickets, and
cross-game room access.

## Games supported

- `tictactoe`
- `uno-chess`

## Deploy

```bash
pnpm install
pnpm exec wrangler types --check
pnpm run check
pnpm run lint
pnpm run test
pnpm run deploy:check
pnpm run deploy
```

Preview URL: `https://fuurma-matchmaking.sergiformatjer1999.workers.dev`

Pull requests and pushes to `main` run the same type-generation, type-check,
lint, test, and deployment-preflight gates in GitHub Actions. Use
`pnpm exec wrangler check startup` locally when changing startup imports; the
command is currently alpha and writes a CPU profile artifact.

## Env

None required for basic operation.
