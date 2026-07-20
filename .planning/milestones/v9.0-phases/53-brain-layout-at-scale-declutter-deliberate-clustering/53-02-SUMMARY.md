---
phase: 53-brain-layout-at-scale-declutter-deliberate-clustering
plan: "02"
subsystem: viz
tags: [lod, density, overview-cap, constants, scale]
dependency_graph:
  requires: [53-01]
  provides: [OVERVIEW_NODE_CAP, overview-cap-enforcement]
  affects: [src/viz/modules/constants.js, src/viz/modules/lod.js]
tech_stack:
  added: []
  patterns: [suppressedHaze-Set, schema-first-survive-ranking, nodeVisible-cap-guard]
key_files:
  created: []
  modified:
    - src/viz/modules/constants.js
    - src/viz/modules/lod.js
    - tests/viz-lod-density.test.ts
decisions:
  - Use suppressedHaze Set (not __cat mutation) to avoid breaking trace-reveal haze path and hazeOpacityScale lerp
  - Schema-first ranking keeps all schema super-nodes; haze fills remaining budget; surplus suppressed
  - nodeVisible haze branch now checks !suppressedHaze.has(n.id) as sole suppression signal
  - OVERVIEW_NODE_CAP placed in adaptive-density band of constants.js, after HAZE_DENSE_SCALE
metrics:
  duration_seconds: 516
  completed_date: "2026-06-30"
  tasks_completed: 2
  tasks_total: 2
  files_changed: 3
---

# Phase 53 Plan 02: Overview cap (OVERVIEW_NODE_CAP) — Summary

**One-liner:** OVERVIEW_NODE_CAP = 3000 constant + suppressedHaze Set in lod.js holds visible overview at ≤ cap with schema-first survive-ranking, leaving trace/hazeOpacityScale untouched.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | Failing test for OVERVIEW_NODE_CAP constant | 30018c2 | tests/viz-lod-density.test.ts |
| 1 (GREEN) | Add OVERVIEW_NODE_CAP tunable to constants.js | 5154799 | src/viz/modules/constants.js |
| 2 (RED) | Failing tests for overview cap enforcement | ccf5c73 | tests/viz-lod-density.test.ts |
| 2 (GREEN) | Apply overview cap in lod.js density adaptation | c17ef97 | src/viz/modules/lod.js, tests/viz-lod-density.test.ts |

## What Was Built

### Task 1 — OVERVIEW_NODE_CAP constant

- Appended `export const OVERVIEW_NODE_CAP = 3000` to `constants.js` in the adaptive-density band, after HAZE_DENSE_SCALE and before the force-settle timing section.
- JSDoc documents: caps total overview nodes (schema + haze) regardless of corpus size (D-05); long-tail haze suppressed beyond cap but still revealed on drill-in/trace; survive-ranking is largest-schema-first (D-06); tuned at founder visual checkpoint. Named tunable, not magic number.
- BRAIN_SCALE = 460, SETTLE_BUDGET_MS (53-01), and all density constants untouched.

### Task 2 — Overview cap in lod.js

- Added `OVERVIEW_NODE_CAP` to the `./constants.js` import list.
- After `overviewCount` is computed: build `suppressedHaze = new Set()`. When `overviewCount > OVERVIEW_NODE_CAP`, iterate haze nodes; admit `OVERVIEW_NODE_CAP - schemaCount` haze nodes, add remainder to `suppressedHaze`.
- `__cat` is never mutated — surplus haze keep `__cat = 'haze'` so the trace-reveal InstancedMesh path (`n.__cat === 'haze'` branch in `revealTrace`) and `hazeOpacityScale` computation remain completely unaffected.
- Updated `nodeVisible` haze branch: `if (n.__cat === 'haze') return !suppressedHaze.has(n.id)`.
- Published `ctx.suppressedHaze` for tests and future consumers.
- In-band (overviewCount ≤ cap): `suppressedHaze` stays empty, behavior identical to before.
- Added `visibleOverviewOf` test helper and 3 new cap test cases: over-cap visible count ≤ cap; all schema survive; under-cap no-op with zero suppression.
- Existing in-band, sparse, and dense assertions: all pass (8/8).

## Verification

- `npm test -- tests/viz-lod-density.test.ts`: 8/8 PASS (5 existing + 3 new cap cases)
- `npm test -- tests/viz-haze-activation.test.ts tests/remember-viz-bridge.test.ts tests/sleep-pass-viz-lighting.test.ts`: 27/27 PASS (Phase 52 no-regress)
- `npm test -- tests/viz-seed-determinism.test.ts`: 5/5 PASS (53-01 no-regress)
- Source greps: `OVERVIEW_NODE_CAP` exported in constants.js (outside comments), imported and referenced in lod.js density block; `BRAIN_SCALE = 460` and `SETTLE_BUDGET_MS` intact.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] suppressedHaze Set instead of __cat mutation**

- **Found during:** Task 2 GREEN
- **Issue:** The plan suggested demoting surplus haze via `__cat = 'suppressed'`. This would (a) break the `revealTrace` haze InstancedMesh path which checks `n.__cat === 'haze'`, (b) cause the existing dense test (6000 haze) to fail because `overviewOf` counts `__cat`, and (c) prevent trace-reveal of suppressed haze nodes.
- **Fix:** Used a `suppressedHaze = new Set<nodeId>()` instead. `__cat` stays 'haze' for all nodes. `nodeVisible` for haze checks `!suppressedHaze.has(n.id)`. This is cleaner and fully preserves all existing paths.
- **Test adjustment:** Cap tests updated to use `visibleOverviewOf` (counts `ctx.nodeVisible(n)`) instead of `overviewOf` (counts `__cat`), because `overviewOf` stays at the raw count when `__cat` is not mutated. The existing dense test (overviewOf=6000) remains unaffected.
- **Files modified:** src/viz/modules/lod.js, tests/viz-lod-density.test.ts
- **Commit:** c17ef97

## Known Stubs

None. All values are real, functional, and test-verified.

## Threat Flags

None. The cap is presentation-layer count math over an already-delivered client payload. No new network endpoints, auth paths, file access, or schema changes. T-53-03 and T-53-04 from the plan's threat model cover all surface.

## TDD Gate Compliance

Both tasks followed RED/GREEN cycle:
- Task 1: `test(53-02)` commit 30018c2 (RED) → `feat(53-02)` commit 5154799 (GREEN)
- Task 2: `test(53-02)` commit ccf5c73 (RED) → `feat(53-02)` commit c17ef97 (GREEN)

## Self-Check: PASSED

| Item | Result |
|------|--------|
| src/viz/modules/constants.js exists | FOUND |
| src/viz/modules/lod.js exists | FOUND |
| tests/viz-lod-density.test.ts exists | FOUND |
| OVERVIEW_NODE_CAP exported in constants.js | FOUND |
| OVERVIEW_NODE_CAP imported in lod.js | FOUND |
| suppressedHaze in lod.js | FOUND |
| commit 30018c2 (Task 1 RED) | FOUND |
| commit 5154799 (Task 1 GREEN) | FOUND |
| commit ccf5c73 (Task 2 RED) | FOUND |
| commit c17ef97 (Task 2 GREEN) | FOUND |
