---
phase: 59-hud-integration-visible-but-belong
plan: 07
subsystem: viz
tags: [viz, hud, css-tokens, detail-page, regression-test, gap-closure]

# Dependency graph
requires:
  - phase: 59-hud-integration-visible-but-belong (Plan 01)
    provides: emitHudTokens() / css-tokens.js :root token injection
provides:
  - "emitHudTokens() reachable on both viz boot paths (graph-boot and /?detail=<id>)"
  - "Regression test locking detail-page boot-path token-injection reachability"
affects: [viz-detail-page, viz-hud-tokens]

# Tech tracking
tech-stack:
  added: []
  patterns: []

key-files:
  created:
    - tests/viz-detail-page-token-injection.test.ts
  modified:
    - src/viz/modules/app.js

key-decisions:
  - "Single emitHudTokens() call site relocated to immediately after window.THREE = THREE; and before the DETAIL_ID branch — no import change, no reorder of the Spike-001 THREE load-order"

patterns-established: []

requirements-completed: [D-12]

# Metrics
duration: 10min
completed: 2026-07-08
---

# Phase 59 Plan 07: CR-01 Detail-Page Token-Injection Gap Closure Summary

**Relocated the single `emitHudTokens()` call in app.js to run before the `DETAIL_ID` boot-path branch splits, and added a regression test that machine-locks the fix so CR-01 cannot silently regress.**

## Performance

- **Duration:** ~10 min
- **Completed:** 2026-07-08T02:41:26Z
- **Tasks:** 2 completed
- **Files modified:** 2 (1 modified, 1 created)

## Accomplishments
- The `/?detail=<id>` tray-detail boot path now injects the `<style id="hud-tokens">` `:root` token block (previously only reached on the graph-boot path), so the shipped detail window renders themed instead of as an unstyled white page.
- Added `tests/viz-detail-page-token-injection.test.ts`: a source-order reachability lock (Block A) plus a functional stub-driven check (Block B) that the injected element actually carries a resolved custom property.

## Task Commits

1. **Task 1: Relocate emitHudTokens() ahead of the DETAIL_ID branch in app.js** - `9979ab7` (fix)
2. **Task 2: Regression test locking emitHudTokens reachability on the detail-page boot path** - `415b0c5` (test)

## Files Created/Modified
- `src/viz/modules/app.js` - Single `emitHudTokens()` call moved from inside the graph-boot else-arm to immediately after `window.THREE = THREE;`, ahead of the `DETAIL_ID` branch split. Spike-001 THREE load-order left untouched.
- `tests/viz-detail-page-token-injection.test.ts` - New regression test: Block A asserts exactly one `emitHudTokens()` call and that its source index precedes `DETAIL_ID !== null`; Block B stubs `globalThis.document`, dynamically imports `css-tokens.js`, calls `emitHudTokens()`, and asserts the appended element has `id === 'hud-tokens'` with `textContent` containing `:root {` and `--glass-bg-ambient:`. Stub torn down in `afterAll` (no global left clobbered).

## Decisions Made
- Followed the plan's fix option exactly: relocate the call rather than duplicate it, keeping a single call site. No architectural changes required.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

CR-01 is closed. `emitHudTokens()` now runs unconditionally before the `DETAIL_ID` branch, so both viz boot paths inject the HUD token block. The regression test fails if the call site ever moves back inside the else-arm or after the branch, locking this against silent regression. `npx tsc --noEmit -p .` clean; full suite green (2645 passed / 4 skipped, up from 2642/4 pre-plan — the 3 new tests all pass).

## Self-Check: PASSED

- FOUND: src/viz/modules/app.js
- FOUND: tests/viz-detail-page-token-injection.test.ts
- FOUND: .planning/phases/59-hud-integration-visible-but-belong/59-07-SUMMARY.md
- FOUND: 9979ab7 (Task 1 commit)
- FOUND: 415b0c5 (Task 2 commit)
- FOUND: fa48261 (SUMMARY commit)

---
*Phase: 59-hud-integration-visible-but-belong*
*Completed: 2026-07-08*
