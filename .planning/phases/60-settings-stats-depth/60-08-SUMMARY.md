---
phase: 60-settings-stats-depth
plan: 08
subsystem: api
tags: [viz-server, better-sqlite3, sql-aggregates, stats-dashboard, token-usage-ledger]

# Dependency graph
requires:
  - phase: 44
    provides: token_usage_ledger schema + the stmtUsage30d/stmtUsageAllTime/stmtUsageByModel prepared-statement pattern this plan mirrors
  - phase: 60 (earlier plans in this phase)
    provides: the /stats/usage route (window pill, daily/weekly buckets, cost_event_deltas) this plan extends additively
provides:
  - "GET /stats/usage summary object: today/week/30d token totals, avg tokens/day, 30d retail-$, today/week-vs-typical framing, trend vs prior 7d, heaviest day in the trailing 7d"
  - "GET /stats/usage lever_deltas array: one entry per COST_EVENT with before_avg/after_avg/pct_saved computed over the FULL ledger calendar span, stable across the range pill"
  - "New read-only prepared statements: stmtTokensSince, stmtTokensBetween, stmtHeaviestDaySince, stmtUsageDailyBucketsAll"
affects: [60-07 (Usage tab frontend redesign consumes these fields for the stat-tile row and levers card)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Fixed-period summary aggregates computed unconditionally alongside a windowed response, using the same compiled-once/read-only/bound-cutoff prepared-statement discipline as the existing route"
    - "Window-independent deltas computed by zero-filling the FULL ledger calendar span (not just the request window) so before/after averages divide by calendar days and stay stable regardless of the range pill"

key-files:
  created: []
  modified:
    - src/viz/server.ts
    - tests/viz-stats-routes.test.ts

key-decisions:
  - "summary is computed unconditionally (independent of the window query param) since the founder's stat-tile row and framing are fixed today/week/30d periods, not scoped to the chart range"
  - "lever_deltas is a new, separate field from the existing windowed cost_event_deltas — the windowed field still feeds the burn-chart marker hover (CR-04) and was left untouched; the new field answers the 'did this lever work?' card with a full-span-stable number"
  - "No fabricated quota_remaining/remaining_tokens field — all summary framing is 'vs your typical' baselines derived from the ledger itself, per the project's subscription cost-model honesty constraint"

requirements-completed: [GAP-2a, GAP-2b, GAP-2c, D-09, D-10, D-11, D-12]

# Metrics
duration: 5min
completed: 2026-07-13
---

# Phase 60 Plan 08: Usage Tab Data Layer — Summary Aggregates + Lever Deltas Summary

**GET /stats/usage now additively returns a `summary` (today/week/30d tokens, avg/day, 30d retail-$, subscription-limit framing) and a window-independent `lever_deltas` card feed — all LLM-free read-only SQL over `token_usage_ledger`.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-07-13T23:57:28Z (worktree base)
- **Completed:** 2026-07-13T20:02:27-04:00
- **Tasks:** 3
- **Files modified:** 2

## Accomplishments
- Added `summary` object to `GET /stats/usage`: today/week/30d token totals, avg tokens/day, 30d retail-$, today-vs-typical / week-vs-typical share, trend vs prior 7d period, and heaviest day in the trailing 7d — computed unconditionally via 3 new read-only bound prepared statements
- Added `lever_deltas` array: one entry per `COST_EVENT` (from `parseCostEvents`/`constants.js`) with before/after avg tokens-per-calendar-day and %-saved, computed over the FULL ledger span so the "levers" card stays stable regardless of the range pill — left the existing windowed `cost_event_deltas` (burn-chart hover) untouched
- Extended `tests/viz-stats-routes.test.ts`: empty-ledger case now asserts a fully-zeroed `summary` + `lever_deltas: []`; new seeded-fixture test spans a `COST_EVENTS` marker date and asserts summary sums/avg/trend plus one numeric `lever_deltas` entry per cost event

## Task Commits

Each task was committed atomically:

1. **Task 1: Summary aggregates — stat tiles + subscription-limit framing** - `6f89ba1` (feat)
2. **Task 2: Full-ledger lever_deltas for the visible levers card** - `d540c59` (feat)
3. **Task 3: Extend route-contract tests for summary + lever_deltas** - `3abae85` (test)

_Note: Task 3's commit also carries a 2-line bug fix discovered while writing the seeded test (see Deviations)._

## Files Created/Modified
- `src/viz/server.ts` - New prepared statements (`stmtTokensSince`, `stmtTokensBetween`, `stmtHeaviestDaySince`, `stmtUsageDailyBucketsAll`); `summary` and `lever_deltas` computation added to the `/stats/usage` handler
- `tests/viz-stats-routes.test.ts` - Extended empty-ledger assertions; added a seeded-fixture test for `summary` + `lever_deltas`

## Decisions Made
- `summary` fields are computed unconditionally alongside the windowed response (not gated by the `window` param) since the stat-tile row and framing represent fixed today/week/30d periods per the founder's locked GAP-2 decision
- `lever_deltas` is additive and separate from `cost_event_deltas` — the windowed field is explicitly preserved for the burn-chart hover per the plan's "DO NOT REMOVE" instruction

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a `Date.UTC()` off-by-one month in both new date-derived cutoffs**
- **Found during:** Task 3 (writing the seeded-fixture test — `today_tokens` came back `0` instead of the expected `150`)
- **Issue:** `Date.UTC(year, month, day)` takes a 0-indexed month, but both the `summary.today_tokens` cutoff and the `lever_deltas` full-span zero-fill start date spread the raw 1-indexed ISO-string month (`'2026-07-13'.split('-')` → `[2026, 7, 13]`) directly into `Date.UTC(...)`, landing one calendar month in the future — silently zeroing "today" whenever `now`'s local day precedes the shifted UTC midnight.
- **Fix:** Destructure year/month/day and pass `month - 1` to `Date.UTC()` at both call sites.
- **Files modified:** `src/viz/server.ts` (2 sites: the `summary.today_tokens` cutoff, the `lever_deltas` full-ledger-span fill start)
- **Verification:** `npx vitest run tests/viz-stats-routes.test.ts` — the seeded test's `today_tokens` assertion now passes; `npx tsc --noEmit` clean
- **Committed in:** `3abae85` (Task 3 commit, bundled with the test that caught it)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Necessary correctness fix caught by the plan's own required seeded-fixture test; no scope creep, no architectural change.

## Issues Encountered
None beyond the deviation above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The Usage tab frontend redesign (parallel sibling plan 60-07, `src/viz/modules/stats-dashboard.js` / `charts.js`) can now consume `summary` for the stat-tile row (GAP-2a) and `lever_deltas` for the visible levers card (GAP-2c); no server work remains for those two founder decisions.
- `npx vitest run` at close: 2644 passed / 9 skipped / 23 failed — all 23 failures are pre-existing eval-harness/adapter/locomo worktree-environment artifacts unrelated to this plan's files (confirmed via `FAIL` listing: `adapter-capture`, `adapter-inject`, `episodic-dryrun-gate`, `eval-harness-smoke`, `locomo-harness`, `locomo-latency-curve`, `locomo-scorer`); `tests/viz-stats-routes.test.ts` and `tests/viz-settings-routes.test.ts` are fully green (33/33).

---
*Phase: 60-settings-stats-depth*
*Completed: 2026-07-13*

## Self-Check: PASSED

All modified/created files verified present (`src/viz/server.ts`, `tests/viz-stats-routes.test.ts`,
`.planning/phases/60-settings-stats-depth/60-08-SUMMARY.md`); all 4 task/metadata commits
(`6f89ba1`, `d540c59`, `3abae85`, `3d9b4ef`) verified present in `git log`.
