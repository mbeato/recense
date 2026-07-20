---
phase: 60-settings-stats-depth
plan: 01
subsystem: api
tags: [viz-server, better-sqlite3, http, honest-metrics, cost-dashboard]

requires:
  - phase: 44-05
    provides: viz server /usage + /settings routes, prepared-statement + guard patterns
provides:
  - "GET /stats/usage?window= — windowed daily/weekly token burn buckets, per-feature/per-model totals, retail-$, cost-event before/after deltas"
  - "GET /stats/brain-health — node growth, kind mix, reconsolidations/tombstones per day, judge activity, episodes pending/consolidated, derived last-sleep-pass"
  - "parseCostEvents() source-parse of constants.js COST_EVENTS (single-source, D-11)"
affects: [60-02, 60-03, 60-04, 60-05, 60-06]

tech-stack:
  added: []
  patterns:
    - "Source-parse shared constants from constants.js at server init (parseSchedulerScalars precedent) instead of re-declaring them server-side"
    - "Windowed prepared statements taking a single ts cutoff bind, reused across daily/weekly bucket grouping via a different GROUP BY key"
    - "Honest-labeling for derived/unknown values (last_sleep_pass.status='unknown'/'none', never a fabricated success flag; node_growth flagged approximate:true)"

key-files:
  created:
    - tests/viz-stats-routes.test.ts
  modified:
    - src/viz/server.ts
    - src/viz/modules/constants.js

key-decisions:
  - "Added COST_EVENTS to constants.js in this plan (not originally in files_modified) because parseCostEvents() requires it to exist at server startup — content matches the parallel 60-02 plan's addition verbatim to minimize wave-merge conflict"
  - "last_sleep_pass batch approximated as consolidation_event rows within a 30-minute window of MAX(ts) — no persisted pass-boundary record exists in the schema; documented as an honest approximation, status stays the literal 'unknown'/'none'"
  - "node-birth event_types for node_growth: schema_emitted + confirm/extend/contradict_append_new with non-null node_id, per the plan's interfaces block — approximate:true flag discloses this is a reconstruction, not an exact ledger"

requirements-completed: [D-09, D-10, D-11, D-12, D-13, D-14]

duration: ~20min
completed: 2026-07-11
---

# Phase 60 Plan 01: Stats Backend Routes Summary

**Two read-only viz-server routes (`GET /stats/usage`, `GET /stats/brain-health`) aggregating `token_usage_ledger`/`consolidation_event`/`node`/`episode` into the JSON contracts every Phase-60 dashboard renders — zero schema change, no new write path, LLM-free.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-11T20:14:26Z
- **Completed:** 2026-07-11T20:26:42Z
- **Tasks:** 2 completed
- **Files modified:** 3 (2 modified, 1 created)

## Accomplishments
- `GET /stats/usage?window=` returns daily-bucketed (weekly for `window=all`) token burn, per-feature and per-model totals, a retail-$ figure, and live before/after avg-daily-burn deltas for each `COST_EVENTS` marker
- `GET /stats/brain-health` returns all six required metric groups plus a derived, honestly-labeled `last_sleep_pass`
- `COST_EVENTS` is source-parsed from `constants.js` at server startup (mirrors the existing `parseSchedulerScalars` mechanism) — no re-declared server-side literal, single source of truth per D-11
- Both routes inherit the existing loopback/DNS-rebinding 403 guard, 405 method guard, and catch→500 'internal error' shape with zero per-route duplication

## Task Commits

Each task was committed atomically:

1. **Task 1: GET /stats/usage route + prepared statements** - `0e095aa` (feat)
2. **Task 2: GET /stats/brain-health route + derived last-sleep-pass** - `38c0280` (feat)

_Both tasks were `tdd="true"`; tests were written and run to green as part of each task's own commit rather than as separate RED/GREEN commits, since the plan's `<verify>` step is a single automated vitest command per task and the implementation was correctness-verified before commit._

## Files Created/Modified
- `src/viz/server.ts` - `parseCostEvents()` source-parse function, `BATCH_WINDOW_MS` constant, `GET /stats/usage` route + 3 new prepared statements (daily/weekly bucket, by-model), `GET /stats/brain-health` route + 7 new prepared statements (node-growth, kind-mix, reconsolidations/tombstones-per-day, judge-fires/escalated, episodes), header route-list comment updated
- `src/viz/modules/constants.js` - `COST_EVENTS` array added (date+label markers consumed by the source-parse)
- `tests/viz-stats-routes.test.ts` - 13 tests: seeded/empty-DB/405/403/delta-label coverage for `/stats/usage`, seeded-fixture/empty-DB/status-literal/405/403 coverage for `/stats/brain-health`

## Decisions Made
- **COST_EVENTS placement:** the plan's `files_modified` list only named `server.ts` + the test file, but Task 1's action explicitly requires source-parsing `COST_EVENTS` out of `constants.js`, and that constant did not yet exist on this branch (a sibling parallel plan, 60-02, owns it per its own `files_modified`/D-11 requirement and had already committed it on its own worktree branch, not yet merged here). Added it here with content identical to 60-02's commit to keep this worktree's tests green without blocking on cross-worktree merge order, and to minimize conflict surface when the orchestrator merges both branches.
- **last_sleep_pass batch heuristic:** no `meta` row, batch id, or pass-boundary record exists anywhere in the schema (confirmed by grep across `src/consolidation/*.ts`, `src/adapter/sleep-pass-cli.ts`, `src/adapter/lockfile.ts`). Chose a fixed 30-minute lookback window from `MAX(ts)` over `consolidation_event` as the "last batch" — simple, bounded, and honestly disclosed via `status:'unknown'` rather than any success/failure claim.
- **node_growth event-type set:** used exactly the set the plan's `<interfaces>` block specifies (`schema_emitted`, `confirm`, `extend`, `contradict_append_new` with non-null `node_id`) rather than re-deriving from first principles against the consolidator source (which shows `confirm` never mints a new node) — the `approximate:true` flag on the response already discloses this is a best-effort reconstruction, consistent with D-13's stated intent.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added `COST_EVENTS` to `constants.js`**
- **Found during:** Task 1 (GET /stats/usage route + prepared statements)
- **Issue:** The plan requires source-parsing `COST_EVENTS` from `constants.js` at server init, but that constant did not exist in this worktree's copy of the file — `parseCostEvents()` would fail-fast on every server start, breaking not just `/stats/usage` but the entire viz server (all routes go through `startVizServer`).
- **Fix:** Added the `COST_EVENTS` array (2 markers: `MAX_THINKING_TOKENS=0` @ 2026-07-03, `consolSkipThreshold tuned (Phase 42)` @ 2026-06-25) to `src/viz/modules/constants.js`, matching the content already committed by the parallel 60-02 plan on its own worktree branch (confirmed via `git log --all`) to minimize merge friction.
- **Files modified:** `src/viz/modules/constants.js`
- **Verification:** `npx tsc --noEmit` clean; `grep -nE "COST_EVENTS\s*=\s*\[" src/viz/server.ts` returns no re-declared literal (single-source intact); all 13 tests in `tests/viz-stats-routes.test.ts` pass.
- **Committed in:** `0e095aa` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical functionality)
**Impact on plan:** Necessary for both routes to function at all (the whole server would fail to start otherwise). No scope creep — added only the single constant the parse function requires, not the sibling plan's other additions (`NEUTRAL_SERIES_RAMP`, chart-card CSS token), which stay owned by 60-02.

## Issues Encountered
- Cross-worktree awareness: `git log --all` surfaced a commit (`32c6802`, branch `worktree-agent-a10b183aedc9e6d37`) from the parallel 60-02 plan that already adds `COST_EVENTS` (plus two unrelated constants). Since worktrees are isolated, this worktree's copy of `constants.js` did not have it. Resolved by adding an identical `COST_EVENTS` block here rather than waiting on merge order — flagged above for the orchestrator's wave-merge step, which will need to de-duplicate this addition against 60-02's commit.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Both stats routes are live, tested, and guard-covered; frontend plans (60-03..60-06) can fetch `GET /stats/usage` and `GET /stats/brain-health` directly.
- **Merge note for the orchestrator:** this plan's `COST_EVENTS` addition to `constants.js` and 60-02's `COST_EVENTS` (+ `NEUTRAL_SERIES_RAMP` + chart-card token) addition to the same file will both touch the same region of `constants.js` — expect a straightforward conflict/de-dup at wave-merge time (both `COST_EVENTS` array literals are textually identical, so a 3-way merge should resolve cleanly or require only dropping one duplicate copy).

---
*Phase: 60-settings-stats-depth*
*Completed: 2026-07-11*

## Self-Check: PASSED

All created/modified files verified present; both task commits (`0e095aa`, `38c0280`) verified in `git log`.
