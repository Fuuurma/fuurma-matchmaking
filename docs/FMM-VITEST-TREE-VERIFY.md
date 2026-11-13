# FMM vitest-tree dev-advisory rows — verified stale

Slice: WORK.md auto-intake 2026-11-13 00:47 "bump dev-advisory chains:
vitest tree - nanoid, source-map-js, vite, vitest-mocker" (source:
`stream/mechanical/2026-11-12-dep-audit-fuurma-matchmaking-worker.md`).

## Verdict

Already landed at origin/main **26ca3a8** — no change required.
Commit 2b3099f (FMM-DEV-ADVISORIES) plus the `vite: 8.3.8` pnpm override
cleared the whole audit before these rows were queued.

## Fresh verification (this lane)

- Baseline check: `pnpm audit --json` against the a2ef5c8 lockfile
  reproduces all **38** advisories from the audit doc — method validated.
- `pnpm audit --json` and `pnpm audit --prod --json` at 26ca3a8:
  **0 advisories** (0 critical/high/moderate/low).

Resolved versions vs patched floors:

- nanoid 3.3.20 (>= 3.3.18, GHSA-2v37-7h3g-55p8)
- source-map-js 1.2.2 (>= 1.2.2, GHSA-68fv-2mgg-jv7q)
- vite 8.3.8 (>= 8.1.6, all 5 vite GHSAs)
- @vitest/mocker 4.1.12 (>= 4.1.12, both GHSAs)
- vitest 4.1.12 (>= 4.1.11, GHSA-82fw-gwwq-j7x9)
- postcss 8.5.32 (>= 8.5.23, GHSA-fxqj-rqcc-2cmp)

## Collateral: cloudflare vitest-pool-workers row also stale

The sibling row (sharp/undici/zod via the pool-workers tree) is cleared
by the same state — the package was renamed to
`@cloudflare/vitest-plugin` ^1.8.1, whose miniflare
5.20261110.2-beta carries sharp 0.35.5, undici 7.30.1, and the plugin
pins zod 4.6.6. `pnpm audit` = 0 covers those rows too.

## Gates at 26ca3a8 (re-run this lane)

- `pnpm test` (vitest run): 10 files, 242 passed + 1 expected fail.
- `pnpm run check` (tsc --noEmit): 0 errors.
- `pnpm lint` (biome check): clean, 26 files.
