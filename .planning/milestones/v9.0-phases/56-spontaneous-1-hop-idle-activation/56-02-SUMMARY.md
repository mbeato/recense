---
phase: 56-spontaneous-1-hop-idle-activation
plan: 02
subsystem: viz
tags: [typescript, sse, viz, retrieval-engine, idle-activation]

# Dependency graph
requires:
  - phase: 56-01
    provides: "src/retrieval/honest-trace.ts — buildHonestOneHopTrace pure helper + HonestTraceReader dependency-injected interface, the single source of truth for the honest 1-hop filter"
provides:
  - "src/viz/server.ts — server-authoritative SPONT_* constants, a read-only eligible-seed pool (live nodes with >=1 real PRED_SET semantic out-edge), pickSpontaneousSeeds pure sampler, and a gated/unref'd/torn-down spontaneousInterval that broadcasts SSE kind:'spontaneous' honest 1-hop traces during genuine idle gaps"
affects: [56-04-spontaneous-guard-tests, viz-client-rendering]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Idle-gated setInterval emitter mirroring the Phase-54 replay scheduler shape exactly (gate order, .unref(), teardown clearInterval) so a third activity layer slots into the existing live > replay > spontaneous > twinkle hierarchy without a new architectural pattern"
    - "Second HonestTraceReader instance wired over the SAME readonly db handle (two prepared SELECTs) rather than sharing SemanticStore, keeping the emitter provably read-only/writer-free"

key-files:
  created: []
  modified:
    - src/viz/server.ts

key-decisions:
  - "pickSpontaneousSeeds placed at module level (not nested in startVizServer) so it is independently importable/testable per the plan's explicit 'pure exported (for the guard test) helper' requirement"
  - "Seed score set to a fixed 0 passthrough placeholder — buildHonestOneHopTrace always emits hop score:null regardless, so the seed score value has no observable effect on the wire payload"

requirements-completed: [SPONT-01, SPONT-03, SPONT-04]

# Metrics
duration: ~15min
completed: 2026-07-01
---

# Phase 56 Plan 02: Spontaneous idle SSE emitter Summary

**Read-only, idle-gated `setInterval` in `src/viz/server.ts` that broadcasts SSE `kind:'spontaneous'` honest 1-hop traces (via the shared `buildHonestOneHopTrace` helper) over real PRED_SET semantic edges of live nodes, only when the replay buffer is empty and the shared idle gap has elapsed.**

## Performance

- **Duration:** ~15 min
- **Tasks:** 2 completed
- **Files modified:** 1

## Accomplishments
- Server-authoritative `SPONT_CADENCE_MS`/`SPONT_SEED_COUNT`/`SPONT_HOP_TOPN`/`SPONT_POOL_REFRESH_MS` constants added next to the Phase-54 `REPLAY_*` block, reusing `REPLAY_IDLE_GAP_MS` as the single shared idle signal (no duplicate idle constant).
- Read-only eligible-seed pool: one bounded `SELECT DISTINCT` over live (non-tombstoned) nodes with a real `PRED_SET`+`kind='relation'` out-edge, cached and rebuilt lazily at most once per `SPONT_POOL_REFRESH_MS` — guarantees no dud/empty tick.
- Exported pure `pickSpontaneousSeeds(pool, count, rng)` — deterministic, injectable-rng, distinct-id sampling, directly testable by the Plan 04 guard suite.
- Spontaneous `setInterval` mirrors the replay scheduler's exact gate order (`clients.size===0` → `replayBuffer.length!==0` → idle-gap check), calls `buildHonestOneHopTrace` against a second `HonestTraceReader` wired over the SAME readonly `db` handle (no new `Database()`), broadcasts `event: trace` with `{ seeds, hops, kind: 'spontaneous' }`, and is `.unref()`'d with `clearInterval(spontaneousInterval)` added to the server `'close'` teardown.
- Zero new writes: grep for `INSERT|UPDATE|DELETE|.run(` shows no new statement introduced; `tsc --noEmit` clean; full suite 2550 passed / 3 skipped (unchanged from the 56-01 baseline); `viz-ambient-liveliness.test.ts` 43/43 green (replay/twinkle layers not regressed).

## Task Commits

Each task was committed atomically:

1. **Task 1: Server-authoritative SPONT constants + eligible-seed pool + pickSpontaneousSeeds** - `04b9180` (feat)
2. **Task 2: Spontaneous SSE emitter interval (gated, read-only, unref'd, torn down)** - `0313c9d` (feat)

_Note: no plan-metadata commit — `.planning/` is gitignored in this repo, so STATE.md/SUMMARY.md updates are on-disk only and are not committed to git (matches 56-01 precedent)._

## Files Created/Modified
- `src/viz/server.ts` - SPONT_* constants, `pickSpontaneousSeeds` (exported), eligible-seed pool builder (`refreshSpontaneousPool`), a second read-only `HonestTraceReader` over the existing readonly `db` handle, the gated/unref'd `spontaneousInterval` emitter, and its `clearInterval` in the server `'close'` teardown.

## Decisions Made

- **`pickSpontaneousSeeds` kept at module scope, not nested inside `startVizServer`.** The plan explicitly calls it a "pure exported (for the guard test) helper" — module scope makes it importable in isolation by the Plan 04 guard tests without instantiating a server/DB.
- **Seed `score` set to a fixed `0` placeholder.** `buildHonestOneHopTrace` always emits `score: null` on hops regardless of the seed score value passed in (per its own contract, WR-02), so the placeholder has zero observable effect on the wire payload — kept for type-shape compatibility with `{ node_id, score }`.

## Deviations from Plan

None - plan executed exactly as written. Both tasks matched the plan's `<action>` and `<interfaces>` sections verbatim (same gate order, same prepared-SELECT shapes, same teardown placement as the Phase-54 replay precedent).

## Issues Encountered

None.

## Known Stubs

None.

## Threat Flags

None — the plan's own `<threat_model>` T-56-02..05 mitigations were all verified directly: `db` stays `readonly: true` and no second `new Database()` was opened (grep confirms only the original open-line + comments); the reader uses only prepared `.all`/`.get` SELECTs (no `.run(`); the pool query is a single bounded DISTINCT, cached and rebuilt at most once per `SPONT_POOL_REFRESH_MS`; `spontaneousInterval.unref()` + `clearInterval(spontaneousInterval)` on `server.on('close', ...)` mirror the replay-interval leak-prevention precedent exactly.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Plan 03 (client render branch for `kind:'spontaneous'`) already landed on this branch ahead of this plan and consumes exactly the wire shape this plan emits (`score:null` hops carrying real `src`) — no client-side follow-up needed.
- Plan 04 (guard tests) can now import `pickSpontaneousSeeds` directly from `src/viz/server.ts` and assert on the grep-verifiable invariants (no new Database, no write, `.unref()` + teardown, `kind:'spontaneous'` tag) documented above.
- No blockers.

---
*Phase: 56-spontaneous-1-hop-idle-activation*
*Completed: 2026-07-01*

## Self-Check: PASSED

- `src/viz/server.ts` — FOUND
- `.planning/phases/56-spontaneous-1-hop-idle-activation/56-02-SUMMARY.md` — FOUND
- `04b9180` — FOUND (in git log)
- `0313c9d` — FOUND (in git log)
