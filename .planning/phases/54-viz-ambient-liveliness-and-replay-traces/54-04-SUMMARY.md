---
phase: 54-viz-ambient-liveliness-and-replay-traces
plan: "04"
subsystem: viz-guards
tags: [vitest, source-text-guards, sc1, sc3, sc5, replay, twinkle, constants]

dependency_graph:
  requires: [54-01, 54-02, 54-03]
  provides: [SC1-machine-guard, SC3-machine-guard, SC5-machine-guard]
  affects: [tests/viz-ambient-liveliness.test.ts]

tech_stack:
  added: []
  patterns:
    - source-text-guard (readFileSync + stripComments pattern from viz-layout-guards.test.ts)
    - compound-expression guard (a * GAIN, 1 + a * GAIN)
    - block-extraction cursor guard (replayInterval = setInterval block)

key_files:
  created: []
  modified:
    - tests/viz-ambient-liveliness.test.ts

decisions:
  - Augmented (not rewrote) the existing 18-test file from Plan 54-02; all original tests preserved
  - Used block-extraction (marker-to-marker slice) instead of whole-file count for cursor= guard, per plan directive
  - Added compound `a * GAIN` guards alongside existing name-only guards — tests different invariant (usage vs presence)
  - Added three new describe groups at end of file to avoid modifying existing group structure

metrics:
  duration: "~15 min"
  completed: "2026-06-30"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 1
---

# Phase 54 Plan 04: SC1+SC5/Server Guards + Compound Source-Text Assertions Summary

Added SC1/SC3/SC5 machine guards for server.ts and missing compound source-text assertions to `tests/viz-ambient-liveliness.test.ts`, growing the suite from 18 to 43 tests with no regressions in the full 2515-test suite.

## What Was Built

The existing `tests/viz-ambient-liveliness.test.ts` (from Plan 54-02) had zero server.ts coverage. This plan adds:

**New helpers:**
- `readConstantsJs()` — reads `src/viz/modules/constants.js` as text
- `readServer()` — reads `src/viz/server.ts` as text

**SC5/constants group (11 tests):**
- All 10 Phase 54 constants asserted exported from constants.js via regex (`export const <NAME>\s*=`)
- `REPLAY_DIM` numeric value parsed and asserted `< 1` (SC3 honesty invariant)

**SC2/SC3/SC1 compound source-text guards (7 tests):**
- `1 + a * ACT_SCALE_GAIN` — confirms the scale gain drives computation (not just imported)
- `a * ACT_BRIGHTEN_GAIN` — compound opacity usage expression
- `a * ACT_HAZE_LERP` — compound haze lerp usage expression
- Replay branch contains `traceEdgesFromHops` call (not `ctx.adj` traversal)
- Replay branch contains `* REPLAY_DIM` compound expression
- `ctx.registerTick(twinkleTick)` source-text guard
- `twinkleTick` body (fn definition to registration) contains no `spawnPulse(` call

**SC1+SC5/server group (7 tests):**
- `replay: true` present in stripped server.ts (client payload marker)
- `replayBuffer` declared (ring buffer exists)
- Exactly one `new Database(` in stripped source (single read-only handle)
- No `fetch(` in non-comment lines (no outbound calls)
- No `embed(` in non-comment lines (no LLM embed)
- No `provider` token in non-comment lines (no LLM provider)
- Zero `cursor =` / `cursor=` assignments inside the `replayInterval = setInterval(` ... `}, REPLAY_CADENCE_MS)` block (forward-only cursor invariant)

## Verification Results

| Gate | Result |
|------|--------|
| `npx vitest run tests/viz-ambient-liveliness.test.ts` | 43/43 passed |
| `npx vitest run tests/trace-honest-recall.test.ts tests/viz-layout-guards.test.ts` | 82/82 passed |
| `npm run build` (tsc strict) | exit 0 |
| `npx vitest run` (full suite) | 2515 passed, 4 skipped, 0 failed |

## Deviations from Plan

**1. [Rule 3 - Blocking] Worktree base was far behind main**
- **Found during:** Initial setup
- **Issue:** Worktree branch was based on commit `f779bfb` (Phase 45), not `d294d82` (Phase 54 wave-2 merge). Phase 54 source files (trace.js, constants.js, server.ts) and the existing test file were absent.
- **Fix:** Ran `git reset --hard d294d82ffd6d851f80ba059819a29aff422146e7` per the `<worktree_branch_check>` directive. All Phase 54 source files became available.
- **Files modified:** (worktree git state only, no source changes)
- **Commit:** n/a (reset, no commit)

No additional deviations. Plan executed as written after the worktree base correction.

## Known Stubs

None. This plan is a test-only file. No data stubs or placeholders.

## Threat Flags

None. Read-only test file; no new network endpoints, auth paths, or trust boundary changes.

## Self-Check: PASSED

- `tests/viz-ambient-liveliness.test.ts` exists in worktree: FOUND
- Task 1 commit `3bb3147` exists: FOUND
- Full suite exit 0: CONFIRMED (2515 passed, 4 skipped, 0 failed)
- tsc exit 0: CONFIRMED
