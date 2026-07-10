# Fuurma Matchmaking

Shared Cloudflare Worker + Durable Object for matchmaking across all Fuurma games.

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

Matched:
```json
{
  "status": "matched",
  "match": {
    "roomId": "...",
    "role": "host" | "guest",
    "host": { "peerId": "...", "displayName": "...", "guestId": "..." },
    "guest": { "peerId": "...", "displayName": "...", "guestId": "..." }
  }
}
```

### GET `/api/matchmaking/:game/poll?ticket=...`

Poll for a match if you received a waiting ticket.

### POST `/api/matchmaking/:game/leave`

Leave the queue.

**Body:**
```json
{ "ticket": "..." }
```

### GET `/api/matchmaking/:game/health`

Health check + queue stats.

## Games supported

- `tictactoe`
- `unochess`

## Deploy

```bash
pnpm install
pnpm run deploy:check
pnpm run deploy
```

Live URL: `https://fuurma-matchmaking.sergiformatjer1999.workers.dev`

## Env

None required for basic operation.
