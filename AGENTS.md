<!-- fuurma-hub-start -->
## Fuurma Hub Context

This repo is one project inside the Fuurma portfolio workspace. The planner hub is the source of truth for cross-project priorities, reusable stack decisions, ports, deploy/auth notes, and agent handoffs.

Before meaningful work, read:
1. Current sprint / next work: `/Users/sergi/Projects/newProjectsPlanner/WORK.md`
2. This project's state page: `/Users/sergi/Projects/newProjectsPlanner/projects/fuurma-matchmaking.md`
3. Standard stack playbook: `/Users/sergi/Projects/newProjectsPlanner/tech-stack/STACK-STANDARDS.md`
4. Agent skills/context: `/Users/sergi/Projects/newProjectsPlanner/tech-stack/AGENT-CONTEXT.md`
5. Official docs index: `/Users/sergi/Projects/newProjectsPlanner/tech-stack/OFFICIAL-DOCS.md`

Use the deeper hub docs when relevant:
- Auth/OAuth: `/Users/sergi/Projects/newProjectsPlanner/tech-stack/AUTH-OAUTH.md`
- Forms: `/Users/sergi/Projects/newProjectsPlanner/tech-stack/TANSTACK-FORM.md`
- Deploy/launch: `/Users/sergi/Projects/newProjectsPlanner/tech-stack/SHIP-KIT.md`
- Ports: `/Users/sergi/Projects/newProjectsPlanner/tech-stack/PORTS.md`
- Secrets/accounts: `/Users/sergi/Projects/newProjectsPlanner/tech-stack/ACCOUNTS-SECRETS.md`

Operational rules:
- Run `git status --short --branch` before editing and protect dirty user/agent work.
- Product repo code/tests are the immediate truth; when they disagree with the hub, update the hub after verifying.
- After reading the hub pointers, keep reading this file's repo-local instructions; they are the authority for this codebase.
- Use `pnpm@10.30.2` unless this repo explicitly documents a different toolchain.
- When you learn a reusable pattern, fix, or project-state change, update `/Users/sergi/Projects/newProjectsPlanner` so the next agent starts stronger.
<!-- fuurma-hub-end -->

# fuurma-matchmaking — Agent entrypoint

Shared Cloudflare Worker for quick matchmaking and WebSocket room relay for the Fuurma games (`tic-tac-toe` and `uno-chess`).

## Stack

- **Runtime**: Cloudflare Workers (`compatibility_date: 2026-07-10`, `nodejs_compat`)
- **Durable Objects**: `MatchmakingQueues` (global queue state) and `GameRoomDO` (per-room WebSocket relay)
- **Language**: TypeScript (strict) via `wrangler`
- **Testing**: Vitest + `@cloudflare/vitest-pool-workers`
- **Lint/Format**: Biome

## Commands

```bash
pnpm install
pnpm dev                 # wrangler dev — local dev server
pnpm deploy              # wrangler deploy
pnpm deploy:check        # wrangler deploy --dry-run
pnpm test                # vitest run
pnpm lint                # biome check
pnpm run check           # tsc --noEmit
```

## Key files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main Worker fetch handler + `MatchmakingQueues` Durable Object |
| `src/room.ts` | `GameRoomDO` — WebSocket relay/room logic |
| `src/room.test.ts` | Durable Object tests |
| `wrangler.jsonc` | Worker config, Durable Object bindings, migrations |

## API surface

- `GET /` — service health
- `POST /api/matchmaking/{game}/join` — join queue
- `GET /api/matchmaking/{game}/poll?ticket={ticket}` — poll for match
- `POST /api/matchmaking/{game}/leave` — leave queue
- `GET /api/matchmaking/{game}/health` — queue health
- `GET /room/{roomId}` — WebSocket upgrade to `GameRoomDO`

Local default: `http://127.0.0.1:8787`. `uno-chess` and `tic-tac-toe` assume `127.0.0.1:8787/api/matchmaking/{game}` for local dev.

## Deploy notes

- Durable Object migrations in `wrangler.jsonc` must be applied before `wrangler deploy`.
- No Convex or auth; the Worker is stateless except for Durable Object storage.
- Games consume this service; do not change matchmaking room IDs or the `/room/` path without checking `tic-tac-toe` and `uno-chess`.
