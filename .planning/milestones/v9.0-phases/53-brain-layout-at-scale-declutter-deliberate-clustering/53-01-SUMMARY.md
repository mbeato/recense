---
phase: 53-brain-layout-at-scale-declutter-deliberate-clustering
plan: "01"
subsystem: viz
tags: [seeding, layout, determinism, clustering, settle, constants]
dependency_graph:
  requires: []
  provides: [seedNodePositions-exported, SETTLE_BUDGET_MS, wall-clock-settle]
  affects: [src/viz/modules/graph.js, src/viz/modules/constants.js]
tech_stack:
  added: []
  patterns: [_hashIndex-deterministic-seeding, three-pass-node-placement, cluster-centroid-bias]
key_files:
  created:
    - tests/viz-seed-determinism.test.ts
  modified:
    - src/viz/modules/constants.js
    - src/viz/modules/graph.js
decisions:
  - CLUSTER_RADIUS = 0.12 * BRAIN_SCALE (55.2 world units) as initial cluster bias; tune at founder checkpoint
  - invRotMat computed as rotMat.clone().invert() for world-to-local conversion in member placement
  - placeInHull() internal helper (8-retry continuous sampling; voxel-centre fallback on persistent miss)
  - Use vi.hoisted() to set globalThis.window before static import of graph.js in test
metrics:
  duration_seconds: 1026
  completed_date: "2026-06-30"
  tasks_completed: 3
  tasks_total: 3
  files_changed: 3
---

# Phase 53 Plan 01: Kill gridlines, start clustered, bounded settle — Summary

**One-liner:** Continuous in-hull seeding with schema-centroid bias + deterministic _hashIndex + wall-clock SETTLE_BUDGET_MS settle replacing cooldownTicks(12).

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add SETTLE_BUDGET_MS tunable to constants.js | 0073fc8 | src/viz/modules/constants.js |
| 2 | Rewrite seedNodePositions() — continuous, clustered, deterministic | 539c796 | src/viz/modules/graph.js, tests/viz-seed-determinism.test.ts |
| 3 | Replace cooldownTicks(12) with wall-clock SETTLE_BUDGET_MS settle | 2fbae1a | src/viz/modules/graph.js |

## What Was Built

### Task 1 — SETTLE_BUDGET_MS constant
- Added `export const SETTLE_BUDGET_MS = 250` to `constants.js` in the adaptive-density band (after HAZE_DENSE_SCALE).
- JSDoc documents it replaces cooldownTicks(12), bounds settle by wall-clock regardless of node count (D-03), and is tunable at the founder visual checkpoint.
- BRAIN_SCALE = 460 and all other constants untouched.

### Task 2 — seedNodePositions() rewrite
- Added `export` to `function seedNodePositions` (additive; no signature change).
- Kept null-brainVol fallback branch (Math.random scatter) byte-identical.
- Rewrote the brainVol branch with three-pass deterministic placement:
  - **Pass 1 (schema hubs):** Pick voxel deterministically via `_hashIndex(i, occupied.length)`, then apply continuous full-cell jitter `+/-(1/R)` in local space using `_hashIndex(key*3+N, 1<<20)` — eliminates the voxel-centre snap that produced lattice lines (D-04).
  - **Pass 2 (members):** Bias toward hub's seeded world position with deterministic offset within `CLUSTER_RADIUS = 0.12 * BRAIN_SCALE`; validate with brainOccupied via `invRotMat` world-to-local conversion; falls back to placeInHull on persistent miss (D-01/D-02).
  - **Pass 3 (haze):** Same continuous in-hull placement as Pass 1.
  - No Math.random anywhere in the brainVol branch; all randomness from `_hashIndex` (D-08).
- Added `tests/viz-seed-determinism.test.ts` with 5 tests: determinism, finite coords, clustering (per-axis CLUSTER_RADIUS bound), haze placement, null-fallback.

### Task 3 — Wall-clock settle
- Added `SETTLE_BUDGET_MS` to the constants import in graph.js.
- Replaced `Graph.cooldownTicks(12)` with `Graph.cooldownTicks(0)` (sim runs freely).
- Replaced `setTimeout(revealSettled, 200)` with `setTimeout(revealSettled, SETTLE_BUDGET_MS)`.
- `revealSettled()` body (fx/fy/fz pin + `opacity 0.35s ease` fade) byte-unchanged (D-07/Phase 52 no-regress).
- `Graph.onEngineStop(revealSettled)` fallback retained.

## Verification

- `npm test -- tests/viz-seed-determinism.test.ts`: 5/5 PASS
- `npm test -- tests/viz-haze-activation.test.ts tests/remember-viz-bridge.test.ts tests/sleep-pass-viz-lighting.test.ts`: 27/27 PASS (Phase 52 no-regress)
- Source greps: no `cooldownTicks(12)` in code, no `Math.random` in brainVol code path, `SETTLE_BUDGET_MS` imported+used, `revealSettled()` body unchanged, `BRAIN_SCALE = 460` intact.

## Deviations from Plan

None — plan executed exactly as written. The `placeInHull` internal helper and `CLUSTER_RADIUS` local const are implementation details that match the plan action spec. No architectural changes; no new dependencies; no external packages.

## Known Stubs

None. All three tasks produce working code with no placeholder values or hardcoded stubs.

## Threat Flags

None. No new network endpoints, auth paths, file access patterns, or schema changes. The plan's threat model covers all surface: T-53-01 (tampering — accept, pure geometry), T-53-02 (DoS — mitigated, SETTLE_BUDGET_MS hard-bounds the settle).

## Self-Check: PASSED

| Item | Result |
|------|--------|
| src/viz/modules/constants.js exists | FOUND |
| src/viz/modules/graph.js exists | FOUND |
| tests/viz-seed-determinism.test.ts exists | FOUND |
| 53-01-SUMMARY.md exists | FOUND |
| commit 0073fc8 (Task 1) exists | FOUND |
| commit 539c796 (Task 2) exists | FOUND |
| commit 2fbae1a (Task 3) exists | FOUND |
