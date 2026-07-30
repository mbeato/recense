---
phase: quick-260729-s8a
plan: "01"
subsystem: infra
tags: [sqlite, lockfile, cli, sleep-pass, dedup, vacuum]

# Dependency graph
requires:
  - phase: n/a (quick task)
    provides: existing lockfile.ts, recall-cli.ts retry pattern, run-sleep-pass.ts hygiene block, semantic-store meta table
provides:
  - "remember-cli acquires the write lock with a bounded (~10min) retry budget instead of fast-failing in 0.11s"
  - "graph-hygiene VACUUM+dedup gated to run at most once per RECENSE_HYGIENE_INTERVAL_HOURS (default 20h), persisted in meta"
  - "dist/ rebuilt and programmatically verified to carry both fixes"
affects: [any future sleep-pass / lockfile / remember-cli work]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "call-site retry budget: pass explicit (attempts, delayMs) to acquireLockWithRetry rather than changing its shared defaults"
    - "stamp-before-work interval gate persisted in the existing meta table (key: graph_hygiene_last_run_ms), same pattern as other meta-key precedents (schema_version, embedding_dims, etc.)"

key-files:
  created: [tests/graph-hygiene-gate.test.ts]
  modified: [src/adapter/remember-cli.ts, src/consolidation/run-sleep-pass.ts, tests/lockfile.test.ts, tests/remember-cli.test.ts]

key-decisions:
  - "REMEMBER_LOCK_ATTEMPTS=300 x REMEMBER_LOCK_DELAY_MS=2000 = 600s worst-case wait, covering the measured 486s hygiene hold with headroom while staying well under the 15min ceiling"
  - "Shared acquireLockWithRetry defaults (8 attempts x 150ms) left untouched — recall-cli and watcher-cli want a short interactive/polling budget; only remember-cli passes an explicit larger budget at its call site"
  - "GRAPH_HYGIENE_DEFAULT_INTERVAL_HOURS=20 (not 24) so pass-timing drift never skips a whole extra day"
  - "Hygiene interval gate stamps meta.graph_hygiene_last_run_ms BEFORE running the VACUUM/dedup, so a slow-failing 316MB VACUUM defers by one interval instead of retrying on every turn"

patterns-established:
  - "Rate-limiter-not-scheduler framing: RECENSE_HYGIENE_INTERVAL_HOURS only gates whether a spawned-every-turn pass does the expensive work, it does not change spawn cadence"

requirements-completed: [QUICK-S8A]

# Metrics
duration: ~16min
completed: 2026-07-29
---

# Quick Task 260729-s8a: Retry remember lock + gate graph hygiene Summary

**remember-cli now rides out a multi-minute lock hold (300 attempts x 2s) instead of fast-failing in 0.11s, and graph hygiene's 486s VACUUM+dedup is gated to run at most once per 20h (persisted in `meta`), fixing the daily write-lock collisions between `recense remember` and the per-turn sleep pass.**

## Performance

- **Duration:** ~16 min
- **Started:** 2026-07-29T20:19:00-04:00 (approx, first commit at 20:19)
- **Completed:** 2026-07-29T20:35:00-04:00 (approx)
- **Tasks:** 3/3 completed
- **Files modified:** 4 source/test files modified, 1 test file created (dist/ rebuilt but gitignored, not tracked)

## Accomplishments
- `remember-cli.ts` imports `acquireLockWithRetry` (shared helper already used by `recall-cli.ts`) and awaits it with an explicit call-site budget (`REMEMBER_LOCK_ATTEMPTS=300`, `REMEMBER_LOCK_DELAY_MS=2000`), so a curated write now survives the measured 486s graph-hygiene lock hold instead of exiting immediately.
- `runGraphHygiene` in `run-sleep-pass.ts` is now gated behind a meta-persisted last-run timestamp (`meta.graph_hygiene_last_run_ms`), defaulting to a 20-hour interval and overridable via `RECENSE_HYGIENE_INTERVAL_HOURS` (0 = every pass, the debug escape hatch). Stamped before the work runs so a mid-run failure defers to the next window rather than retrying every turn.
- `dist/` rebuilt via `npm run build`; a `node -e` require-based probe (not grep, since tsc preserves comments) confirmed both fixes are present in the compiled artifacts the Stop hook and launchd job actually execute.
- Full `npm test` run: **2716 passed / 3 skipped**, zero failures (see Issues Encountered for the baseline-count note).

## Task Commits

Each task was committed atomically:

1. **Task 1: Give remember-cli a retry budget that outlives a multi-minute pass** - `b817e69` (fix)
2. **Task 2: Gate runGraphHygiene behind a meta-persisted interval** - `e85c8a1` (fix)
3. **Task 3: Rebuild dist and prove the compiled output carries both fixes** - no commit (dist/ is gitignored; build + verification only, no source changes)

**Plan metadata:** committed separately by the orchestrator (SUMMARY.md/STATE.md not committed by this executor per constraints).

## Files Created/Modified
- `src/adapter/remember-cli.ts` - Replaced fast-fail `acquireLock()` with awaited `acquireLockWithRetry(REMEMBER_LOCK_ATTEMPTS, REMEMBER_LOCK_DELAY_MS)`; added the two exported constants + waited-ms `fileLog` diagnostic; updated the exhaustion stderr message to name the budget.
- `src/consolidation/run-sleep-pass.ts` - Exported `runGraphHygiene` (was module-private) with a new `env` parameter; added `GRAPH_HYGIENE_META_KEY`, `GRAPH_HYGIENE_DEFAULT_INTERVAL_HOURS`/`_MS` constants and `resolveHygieneIntervalMs()`; implemented the stamp-before-work interval gate at the top of `runGraphHygiene`; updated the `runConsolidation` call site to pass `env`.
- `tests/lockfile.test.ts` - Added `describe('acquireLockWithRetry')` with 3 tests: rides out a transient hold, terminates when held across the whole budget, and confirms the unspecified-args default stays small (<2s) against a held lock.
- `tests/remember-cli.test.ts` - Added 2 tests asserting `REMEMBER_LOCK_ATTEMPTS * REMEMBER_LOCK_DELAY_MS` is `>= 8min` and `<= 15min` / finite.
- `tests/graph-hygiene-gate.test.ts` (new) - 10 tests covering: first-call runs, second-call-in-window skips, post-interval re-run, `RECENSE_HYGIENE_INTERVAL_HOURS=0` escape hatch, `=1` boundary behavior at +30min/+90min, and 5 unit tests for `resolveHygieneIntervalMs` (default/0/negative/unparseable/positive).

## Decisions Made
- Budget numbers (300 x 2000ms) chosen to give ~600s worst case, comfortably above the measured 486s hold with margin, while staying under the plan's 15min hard ceiling.
- Left `src/adapter/lockfile.ts` completely untouched — confirmed via `git diff --stat src/adapter/lockfile.ts` returning empty, satisfying the plan's `done` gate and T-s8a-03 threat mitigation.
- Did not touch `RECENSE_SLEEP_DEDUP` or its condition — confirmed via `git diff` showing both mentions as unchanged context lines, not additions/removals.

## Deviations from Plan

None - plan executed exactly as written. Task 3 correctly produced no git-trackable diff since `dist/` is gitignored by design (per `<execution_mode>` context, this quick task's whole purpose was to get the rebuilt dist into place locally for the hooks/launchd job to pick up, not to commit it).

## Issues Encountered
- The plan's verification step 5 references a baseline of "2383 passed / 3 skipped" from STATE.md ("Suite at v8.0 close"). The actual full-suite run after this task's changes shows **2716 passed / 3 skipped** — a delta of 333 beyond what Tasks 1/2 added (15 new tests). This is expected drift: the current branch (`plan/phase-51-wasm-simd-kernel`) sits well past v8.0, on top of substantial unrelated milestone v9/v10 work (visible in recent commit history: v10.0 roadmap/requirements/domain-research, action-proposals work, etc.) that added tests independent of this quick task. No regressions were introduced — all 2716 tests passed, zero failures, zero new skips.

## User Setup Required

None - no external service configuration required. The rebuilt `dist/` is already in place at `/Users/vtx/brain-memory/dist/`; the Claude Code Stop hook and the `com.recense.sleep-pass` launchd job will pick up both fixes on their next invocation with no further action needed.

## Next Phase Readiness
- Both root causes of the live `recense remember` lock-contention issue are fixed and verified in the compiled artifacts that actually run.
- `src/adapter/lockfile.ts` and `RECENSE_SLEEP_DEDUP`/`sleep.env` are unmodified, so no other lock consumer (recall-cli, watcher-cli) or the dark-default dedup toggle is affected.
- No blockers for follow-on work.

---
*Phase: quick-260729-s8a*
*Completed: 2026-07-29*

## Self-Check: PASSED

All 6 created/modified files verified present on disk; both task commits (`b817e69`, `e85c8a1`) verified present in `git log`.
