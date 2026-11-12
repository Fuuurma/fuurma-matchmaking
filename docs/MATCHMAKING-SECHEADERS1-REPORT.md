# MATCHMAKING-SECHEADERS1 — security headers on worker responses

Slice: MATCHMAKING-SECHEADERS1 (WORK.md work:384). Landed fuurma-matchmaking@fd352a1
(+ report commit) on origin/main, branch fleet/matchmaking-secheaders1.

## What changed

The live-site probe (2026-11-12) found `x-frame-options` missing on production
responses. The standard security header set is now stamped at the worker
response layer:

- `src/utils.ts` — new `SECURITY_HEADERS` const: `Content-Security-Policy`
  (`default-src 'none'; frame-ancestors 'none'`), `X-Content-Type-Options:
  nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Strict-Transport-Security`, `Permissions-Policy`. `corsHeaders()` spreads
  it, so every constructed response (jsonResponse, OPTIONS 204, room DO
  errors, the wsUrl rewrite) carries the set. New `withSecurityHeaders()`
  stamps any missing header at the edge.
- `src/index.ts` — the default fetch wraps routing in `withSecurityHeaders`
  and catches unexpected throws into the same JSON 500 shape the DO uses.
- `src/room.ts` — the 101 WebSocket upgrade sets `SECURITY_HEADERS` at
  construction: it cannot be rebuilt at the edge without losing the socket.

## Why rebuild instead of mutate

Durable Object passthrough responses (`stub.fetch`) carry **immutable**
headers in workerd — `headers.set` throws `TypeError: Can't modify immutable
headers` (verified in vitest-pool-workers). `withSecurityHeaders` therefore
rebuilds the `Response` only when a header is missing, and returns 101 /
webSocket-bearing responses untouched.

## Evidence

- `curl -sSI` against `pnpm dev` (wrangler dev, 127.0.0.1:8787): all six
  headers present on `GET /`, `GET /api/matchmaking/tictactoe/health`,
  `POST .../join` waiting + matched (wsUrl rewrite path), unknown-path 404,
  `OPTIONS` 204, `/room/x` error, and the `101 Switching Protocols` upgrade.
- Tests: `src/index.test.ts` "security headers" describe pins the set on
  every response shape through `worker.fetch`; `src/utils.test.ts` covers
  the rebuild/identity/passthrough branches of `withSecurityHeaders`.
- Gates: `pnpm test` 242 passed + 1 expected fail; `pnpm lint` (biome) clean;
  `pnpm run check` (tsc --noEmit) clean.

## Notes

- Ledger F41 had triaged the missing X-Frame-Options as a false positive
  (CSP `frame-ancestors 'none'` already denied framing). This slice lands
  the header anyway per the 2026-11-12 probe — defense in depth for agents
  that ignore CSP, plus the rest of the standard set.
- Production picks the headers up on the next `wrangler deploy` (owner-gated).
