# Fuurma Matchmaking — Architecture

The Cloudflare Worker routes per-game matchmaking requests to a `MatchmakingQueues` Durable Object and room WebSocket upgrades to a `GameRoomDO` keyed by room ID. Durable Object storage owns queue, match, and room slot state; game clients keep game rules and turn state themselves.

```mermaid
flowchart LR
  CLIENT[Game clients for tic-tac-toe and Uno Chess] -->|join poll leave health| WORKER[Cloudflare Worker]
  WORKER -->|per-game namespace| QUEUES[MatchmakingQueues Durable Object]
  QUEUES -->|queue and match records| QSTORE[(Queue Durable Object storage)]
  QUEUES -->|waiting ticket or matched room ID and role| CLIENT
  CLIENT -->|GET room ID with WebSocket upgrade| WORKER
  WORKER -->|room ID namespace| ROOM[GameRoomDO]
  ROOM <-->|hello and game message relay| CLIENT
  ROOM -->|slots reconnect credentials alarms| RSTORE[(Room Durable Object storage)]
```

## Modules

- `src/index.ts` — Worker HTTP routing and per-game matchmaking queue Durable Object
- `src/room.ts` — per-room WebSocket relay, reconnect lifecycle, and persistent slots
- `src/utils.ts` — validation, sanitization, CORS, JSON responses, and event logging
- `wrangler.jsonc` — Worker entry point, Durable Object bindings, and migrations
- `src/index.test.ts`, `src/room.test.ts` — queue and room behavior tests
