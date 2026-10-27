# `@fuurma/online-client`

Shared Tier-1 online client SDK for fuurma turn-based games. Transport and
protocol only: the room socket state machine, reconnect credentials,
matchmaking HTTP, guest identity, room codes/invite links, error mapping,
and presence. Games own all game semantics (frame schemas, authority
model, timers, rematch, UI).

Tier 1 is the drop-in layer: `RoomSocket` keeps the existing `RoomClient`
method surface (`connect` / `send` / `close` / `setMessageHandler` /
`setStatusHandler` / `reconnectNow`) plus G's `closeForReconnect` and
`setSlotToken`. Tier 2 (`createClient` / `Seat`) is a later step and is
deliberately not in this package yet.

## Rules

- No Zod, no React, no DOM/window references. The socket, storage, and
  fetch are injected; URL helpers take plain strings.
- Erasable TypeScript only (`import type`, no enums/namespaces/parameter
  properties) so the sources typecheck under both games' strict flags.
- No wire-frame changes. Frames go verbatim; there is no `protocol`
  envelope, no heartbeat, no outbound caps (the server owns 64 KiB).
- Storage prefixes are configurable: pass each game's existing prefixes
  so persisted reconnect/slot tokens survive the swap.

## Use

```ts
import { MatchmakingClient, RoomSocket, createIdentity } from "@fuurma/online-client"

const identity = createIdentity({
  storageKeys: { guestId: "tictactoe:guestId", displayName: "tictactoe:displayName" },
  randomName: () => "Crimson Fox",
})

const socket = new RoomSocket({
  wsUrl: buildRoomWsUrl(roomId, baseUrl),
  game: "tictactoe",
  guestId: identity.guestId(),
  displayName: identity.displayName(),
  tokenPrefix: "tictactoe:room-token:",
  slotTokenPrefix: "tictactoe:room-slot-token:",
})
```

Close semantics: `close()` is the voluntary departure (`1000/"client
closing"`, credentials forgotten); `closeForReconnect()` recycles under
`4000/"reconnecting"` so the peer reads `disconnect`, not `closed`.

## Tests

- `client/test/unit` (vitest project `online-client`, node env): merged
  T `room.test.ts` cases (F37/F151/F253/F460/F746/F748, MM-01) + G
  `room`/`roomClient`/`reconnectTeardown` cases (slotToken persistence,
  denied/absent storage, 4000-vs-1000 signatures) minus
  heartbeat/rate-limit/oversized-frame cases, plus matchmaking,
  identity, room-code, and presence tests.
- `client/test/contract` (vitest project `worker`): the injectable
  socket/fetch pointed at the real DO — credential round-trip,
  slotToken-gated room, recycle-vs-leave peer reason.
