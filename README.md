# Fuurma Matchmaking

Shared Cloudflare Worker + two Durable Objects for matchmaking and per-room
WebSocket relay across all Fuurma games. Replaces PeerJS P2P for turn-based
play (see [`migrations/2026-07-games-do-websocket-migration.md`](https://github.com/Fuuurma/hub/blob/main/migrations/2026-07-games-do-websocket-migration.md)).

## Architecture

- `MatchmakingQueues` DO — per-game queue, pairs a joiner with the longest-waiting
  player still polling, returns `roomId` + `wsUrl` + a per-player `slotToken`.
- `GameRoomDO` — one DO instance per `roomId`. Accepts up to two WebSocket
  connections, fans out messages, persists slot state through hibernation,
  and grants a 30s reconnect grace via `setAlarm`.

## API

All JSON responses carry CORS and security headers. A request body for `join` and
`leave` is capped at 8 KiB.

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

`peerId` is 1-128 characters and required. `guestId` is 1-64 characters (one is
generated when absent). `displayName` is at most 256 UTF-8 bytes and is
sanitised to 20 characters.

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

Matched (the joiner gets this straight away when someone is waiting):
```json
{
  "status": "matched",
  "match": {
    "roomId": "...",
    "role": "host" | "guest",
    "game": "tictactoe",
    "createdAt": 1767225600000,
    "host": { "peerId": "...", "displayName": "...", "guestId": "..." },
    "guest": { "peerId": "...", "displayName": "...", "guestId": "..." },
    "wsUrl": "wss://fuurma-matchmaking.sergiformatjer1999.workers.dev/room/..."
  },
  "slotToken": "<32 hex chars>"
}
```

`slotToken` sits at the top level, next to `match`, and is that player's private
capability for the room: send it as `hello.slotToken`. Each player gets only
their own token, in their own `matched` response (the joiner's from `join`, the
host's from `poll`). The opponent's token is never disclosed. A record that
pre-dates slot tokens answers without `slotToken`. `wsUrl` carries no `?game=`;
append it yourself.

A match is announced only once the room has acknowledged the allocation. If that
handoff fails the joiner receives `waiting` with a ticket instead, and each
`poll` retries it.

**Repeat joins supersede.** A `join` whose `peerId` or `guestId` already has a
queue entry deletes that entry and issues a fresh `ticket` and `roomId`, so a
page refresh that lost its ticket simply starts again. The old ticket polls as
`404`. Nothing about the old entry is disclosed: `peerId` and `guestId` are
visible to every opponent, so they are not credentials. The queue holds at most
one entry per `guestId`.

Errors: `400` malformed body or field, `413` body over 8 KiB, `429` with
`Retry-After` (more than 20 joins per minute from one address, or three live
entries from one address in this game), `503` with `Retry-After` when the queue
is full (100 entries) or when the Worker could not reach its Durable Object
(`{"error":"temporarily unavailable"}`).

### GET `/api/matchmaking/:game/poll?ticket=...`

Poll for a match if you received a waiting ticket. Same response shapes as
`/join`. `404 {"error":"ticket not found"}` means the ticket is no longer queued
and has no match: it expired (30 s without polling, 10 minutes in total), was
left, was superseded by a repeat join, or its match was cancelled. Join again.

A queued player is paired only if it was seen (joined or polled) in the last 10
seconds, so keep polling at least every few seconds. A match record is kept for
90 seconds, and about 15 seconds after the ticket first collected `matched`
(so a retried poll still gets its answer).

### POST `/api/matchmaking/:game/leave`

Leave the queue.

**Body:**
```json
{ "ticket": "..." }
```

Answers `200 {"status":"left"}` for any well-formed ticket. Leaving a ticket that
is already matched also releases the room: a peer already seated there receives
`peer-left` with reason `closed`, and the room stops expecting the leaver.

### GET `/api/matchmaking/:game/health`

Health check + queue stats:
```json
{ "ok": true, "game": "tictactoe", "waiting": 1, "matches": 2, "players": 5 }
```

`waiting` is the number of queued players. `matches` is the number of distinct
rooms matched recently (a match is one room, not one per ticket). `players` is
`waiting + 2 * matches`. These are "recent" figures, not live games: a match
drops out after its record expires.

### GET `/room/:roomId`

WebSocket upgrade endpoint. Opens a relay connection to the `GameRoomDO` for
the given `roomId`. Optional `?game=tictactoe|gambit-deck` query param selects
the game namespace (defaults to `tictactoe`). A room is pinned to the game of its
first seated connection (`409` for another game). At most two sockets, counting ones that
have not said hello, may be open (`429`).

**Wire protocol** (JSON text frames; server is a relay, not a validator):

Client → server (first frame must be `hello`, within 10 seconds):
```json
{
  "type": "hello",
  "guestId": "guest:abc",
  "displayName": "Guest-1234",
  "role": "host" | "guest",
  "slotToken": "<32 hex chars>",
  "reconnectToken": "<32 hex chars>"
}
```

Only `type` and `guestId` (1-64 characters) are required.

- `role` is optional. Without it seats are first-come (first hello is `host`).
  With it the hello asks for exactly that seat: if a different `guestId` already
  holds it in an open room, the hello is refused with `error` code `role-taken`
  (see below) before `welcome`, and the seated player is told nothing. In a
  matchmade room the allocation decides the role and the hint is ignored.
- `slotToken` is the capability from the `matched` response. A matchmade room
  refuses a first hello whose `guestId` was not allocated, or that does not
  present its matching token (`join capability required`). Rooms that never received an
  allocation (invite links) have open claim semantics: any unseen `guestId` gets a
  free seat.
- `reconnectToken` is only for reclaiming a seat, below.

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

The reason follows from how the other socket closed. Only the exact close
signature `(1000, "client closing")` yields `closed`; any other close code or
reason, including `(4000, "reconnecting")` and a dropped connection, yields
`disconnect`. A clean leave must therefore close with exactly that code and reason.

`disconnect` is transient and retains the player slot for 30 seconds. A
reconnect that presents both the same `guestId` **and** that player's
`reconnectToken` receives `welcome` and the remaining peer receives:

```json
{ "type": "peer-reconnected", "opponent": { "guestId": "guest:abc", "displayName": "Guest-1234" } }
```

`closed` and `expired` are final room lifecycle events. `closed` is also sent
when the opponent cancels its matchmaking ticket after the match. `expired`
means the grace ran out, or a matchmade seat was not claimed within 60 seconds.

Server → client when a frame is refused or a hello fails:
```json
{ "type": "error", "code": "invalid" | "unknown" | "role-taken", "message": "..." }
```

- `invalid`: the frame was not accepted: not JSON, not an object, no string
  `type`, a binary frame (`expected string frame`), a frame over the size cap, a
  reserved `type`, a frame before `hello`, a bad `hello` field, a missing
  `slotToken` (`join capability required`) or `reconnectToken`
  (`reconnect credential required`). Most hello failures then close the socket
  with 1008.
- `unknown`: the room cannot take this caller: `room full`, or the `guestId` is
  `already connected from another tab` (closed with 1013).
- `role-taken`: the hello named a `role` that another `guestId` holds in this open
  room. Message `That room code is already in use`; the socket is closed with 1008.

Frames are limited to 64 KiB (UTF-8 bytes). A larger frame is dropped, the sender
gets `error` code `invalid`, and the opponent receives nothing.

Application messages (`move`, `rematch-request`, `rematch-accept`, `resign`, and
any other `type` a game defines) are relayed verbatim to the other authenticated
socket. The server's own types are reserved and refused from clients with `error`
`invalid`: `hello` after the handshake, `ping`, `welcome`, `peer-joined`,
`peer-reconnected`, `peer-left`, `player_left`, `error`, `room_closed`,
`host_migrated`. `ping` is answered with `pong` and not relayed; the literal text
frame `ping` is answered by the platform without waking the room.

**Reconnect:** a new WebSocket presenting the same `guestId` and
`reconnectToken` within 30s of a disconnect reattaches to the same slot and is
told `welcome` again with the opponent info still present. The other client
receives `peer-reconnected`. A `hello` carrying the `guestId` without the
credential is rejected with `reconnect credential required`. A slot persisted
by a build from before this contract existed has no credential to check, so it is
retired instead of handed to the first claimant: that `hello` gets `error`
`invalid` (`legacy slot expired — rejoin as a new player`) and the player rejoins
as a new one.

Join requests are bounded and rate-limited per client address. The Worker
rejects malformed JSON, oversized identifiers, invalid leave tickets, and
cross-game room access.

## Games supported

- `tictactoe`
- `gambit-deck`

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
