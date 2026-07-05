---
phase: 58-node-presentation-motion-overhaul
plan: 07
subsystem: viz
tags: [three.js, hover, damping, registerTick, fog, focus-dim]

# Dependency graph
requires:
  - phase: 58-node-presentation-motion-overhaul plan 04
    provides: matcap damped-fade registerTick pattern (activeMatcap Map) this plan's hover-settling Set mirrors
  - phase: 58-node-presentation-motion-overhaul plan 06
    provides: camera.js's damped-target registerTick system and constants.js's Phase-58 section conventions this plan stays consistent with
provides:
  - "graph.js — damped asymmetric hover: node.__hoverTarget + a registerTick callback damping mesh.scale toward baseR*__hoverTarget via THREE.MathUtils.damp(HOVER_LAMBDA), grow-leg overshoot to HOVER_SCALE*HOVER_OVERSHOOT, shrink-leg no overshoot"
  - "constants.js — HOVER_LAMBDA, HOVER_OVERSHOOT, FOCUS_DIM_OPACITY (moved from detail.js, tuned), FOCUS_FOG_NEAR"
  - "detail.js — applyFocusDim/clearFocusDim now also tighten/restore Graph.scene().fog.near (D-07)"
affects: [58-08 (Stage-2 motion founder checkpoint tunes these UNLOCKED feel constants live)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Damped hover-scale settling Set (node -> implicit state via node.__hoverTarget/__hoverOvershot), pruned once within epsilon of the true resting target — mirrors detail.js's activeMatcap Map / stats.js's updateIdleDrift dt-clamp shape, applied to node scale instead of camera position or a fade uniform"
    - "Asymmetric overshoot via a target swap, not a second lambda: the grow leg's tick first chases an overshoot peak (HOVER_SCALE*HOVER_OVERSHOOT), then swaps its damp target down to the true HOVER_SCALE once close to the peak — the swap-while-still-elevated IS the one-oscillation settle-back. The shrink leg always damps straight to 1."
    - "Fog near-plane save/restore idiom (D-07) mirrors the existing haze _hazeDimmed save/restore in the same functions: applyFocusDim saves ctx._fogBaseNear once and tightens fog.near to FOCUS_FOG_NEAR; clearFocusDim restores it"

key-files:
  created: []
  modified:
    - src/viz/modules/graph.js
    - src/viz/modules/detail.js
    - src/viz/modules/constants.js

key-decisions:
  - "Single HOVER_LAMBDA drives both grow and shrink legs — the plan's asymmetry requirement (overshoot in, none out) is satisfied entirely by which damp target is used each tick (overshoot peak vs. true target vs. 1), not by a second lambda constant. Keeps the feel-constant surface smaller and the two legs mathematically consistent (same convergence rate, different destination)."
  - "Overshoot-to-settle transition trigger is proximity-based (current >= overshoot - 0.01), not time-based (e.g. a fixed ms gate) — mirrors the exponential-damp convergence already used everywhere else in this phase (camera.js, matcap fade) rather than introducing a new timer-based sequencing primitive for a single-node scale animation."
  - "FOCUS_DIM_OPACITY tuned from 0.05 to 0.035 (D-07 provisional value) when moved into constants.js — a modest strengthening of the non-neighbor recede, left as Claude's Discretion per the plan and flagged for Stage-2 founder tuning alongside FOCUS_FOG_NEAR."
  - "Fog restore reads back a saved ctx._fogBaseNear rather than hardcoding BRAIN_SCALE*1.8 in clearFocusDim — mirrors the existing hazeMat._baseOpacity save/restore idiom exactly (save the actual resting value once, restore that value, not a re-derived constant), so if graph.js's fog setup literal ever changes, clearFocusDim tracks it automatically."

requirements-completed: [HOVER-DAMP, D-07]

# Metrics
duration: ~15min
completed: 2026-07-05
---

# Phase 58 Plan 07: Damped Asymmetric Hover + Focus Depth Deepening Summary

**Hover scale now grows with a slight overshoot and settles, shrinks back down clean — frame-rate-independent via THREE.MathUtils.damp in a registerTick callback — and node focus now reads deeper: a slightly stronger non-neighbor dim plus a tightened fog near-plane, both fully restored on deselect.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-07-05 (Task 1 commit)
- **Completed:** 2026-07-05 (Task 2 commit)
- **Tasks:** 2/2 completed
- **Files modified:** 3 (graph.js, detail.js, constants.js)

## Accomplishments

- `graph.js`'s `onNodeHover` no longer snap-writes `mesh.scale.setScalar(baseR * HOVER_SCALE)`/`setScalar(baseR)`. Hover-enter/leave now only set `node.__hoverTarget` (via a new `setHoverTarget` helper), and a single `registerTick` callback damps every hovering/settling node's mesh scale toward `baseR * __hoverTarget` using `THREE.MathUtils.damp(current, stepTarget, HOVER_LAMBDA, dt)`, with the same clamped-dt shape as `stats.js`'s `updateIdleDrift`.
- Asymmetry: the grow leg first chases an overshoot peak (`HOVER_SCALE * HOVER_OVERSHOOT` ≈ 1.89), then swaps its damp target down to the true `HOVER_SCALE` once the current scale is close to that peak — producing exactly one oscillation before settling. The shrink leg (hover-leave) always damps straight to 1 with no overshoot.
- The tick tracks only the small `_hoverSettling` Set (hovering + still-settling nodes), pruning a node once it's within `0.002` of its fully-resolved target (and, for the grow leg, only after the overshoot phase has completed) — cost stays proportional to active hover state, not `O(allNodes)`.
- `HOVER_LAMBDA` (10) and `HOVER_OVERSHOOT` (1.05) added to `constants.js`'s new "Phase 58 — hover damp + focus depth" section; `HOVER_SCALE` (1.8) retained unchanged as the grow target.
- `detail.js`'s `FOCUS_DIM_OPACITY` (previously a local const) moved into `constants.js` to join the named-constant discipline, tuned from `0.05` to `0.035` (D-07, provisional — a slightly stronger non-neighbor recede).
- New `FOCUS_FOG_NEAR` constant (`BRAIN_SCALE * 1.4`, vs. the resting `BRAIN_SCALE * 1.8`). `applyFocusDim` now saves the scene fog's current `near` value once (`ctx._fogBaseNear`) and tightens it to `FOCUS_FOG_NEAR`; `clearFocusDim` restores it from the saved value — the exact same save/restore idiom already used for the haze material's `_hazeDimmed`/`_baseOpacity` pair in the same two functions.
- The keep-set / haze-dim bookkeeping in `applyFocusDim`/`clearFocusDim` is otherwise byte-for-byte unchanged; the git diff is limited to the dim-value move + the fog save/restore lines, per the plan's own scope constraint.

## Task Commits

Each task was committed atomically:

1. **Task 1: Damped asymmetric hover (target scale + registerTick damp)** - `77f39d6` (feat)
2. **Task 2: Focus depth deepening — stronger non-neighbor dim + tightened fog near-plane (D-07)** - `e2ea423` (feat)

_No plan-metadata commit made in worktree mode — orchestrator commits SUMMARY.md/STATE.md/ROADMAP.md after merge._

## Files Created/Modified

- `src/viz/modules/graph.js` - `onNodeHover` rewritten to set `__hoverTarget` instead of snapping scale; new `setHoverTarget` helper + `_hoverSettling` Set + `registerTick` damp callback (grow-overshoot / shrink-clean asymmetry); import list gains `HOVER_LAMBDA`, `HOVER_OVERSHOOT`
- `src/viz/modules/detail.js` - `FOCUS_DIM_OPACITY` local const removed, imported from `constants.js` instead (with `FOCUS_FOG_NEAR`); `applyFocusDim`/`clearFocusDim` gain fog near-plane save/tighten/restore
- `src/viz/modules/constants.js` - New "Phase 58 — hover damp + focus depth" section: `HOVER_LAMBDA`, `HOVER_OVERSHOOT`, `FOCUS_DIM_OPACITY` (moved + tuned), `FOCUS_FOG_NEAR`

## Decisions Made

- One `HOVER_LAMBDA` for both hover legs — the overshoot/no-overshoot asymmetry comes entirely from which target the tick chases each frame (overshoot peak vs. true target vs. 1), not from a second lambda constant.
- Overshoot→settle phase switch triggers on proximity to the overshoot peak (exponential-damp convergence check), consistent with every other damped system in this phase rather than introducing a timer-based sequencing primitive for a single scale animation.
- `FOCUS_DIM_OPACITY` tuned 0.05 → 0.035 as part of the move into `constants.js` (D-07 provisional, flagged for Stage-2 founder tuning).
- Fog restore reads back a saved `ctx._fogBaseNear` (captured once, mirroring the haze `_baseOpacity` idiom) rather than hardcoding `BRAIN_SCALE * 1.8` in the restore path.

## Deviations from Plan

None — plan executed exactly as written. Both tasks' verify scripts (source-scan) pass; no test-mock or import-chain breakage was introduced (this plan touches only existing, already-imported surface — no new module-scope THREE constructors, unlike Plans 04/06).

## Issues Encountered

Full `npx vitest run`: 165 files passed / 7 failed (23 tests) / 2 skipped — the identical pre-existing CLI-subprocess exit-code failures already logged in `deferred-items.md` by Plan 02 (`adapter-capture`, `adapter-inject`, `episodic-dryrun-gate`, `eval-harness-smoke`, `locomo-harness`, `locomo-latency-curve`, `locomo-scorer`), none touching `src/viz/modules/*`. All 16 `tests/viz-*.test.ts` files (309 tests) pass green. `npx tsc --noEmit` is clean (no output, exit 0).

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- The damped hover and focus-depth deepening are code-complete and source-verified: both plan verify scripts pass, and the full `tests/viz-*.test.ts` suite (309 tests) is green.
- **Live visual/motion verification is explicitly deferred to the Stage-2 founder checkpoint** per this plan's own `<verification>` section: does hover actually read as a subtle grow-overshoot-settle vs. a clean shrink? Does the focus dim + fog tightening read as a legible "focus pull" without feeling like a jarring darken? None of this has been visually confirmed in this plan — it is unit/source-verified only.
- `HOVER_LAMBDA`, `HOVER_OVERSHOOT`, `FOCUS_DIM_OPACITY`, `FOCUS_FOG_NEAR` are the next UNLOCKED feel constants to tune at Stage 2 if the hover feels too snappy/sluggish or the focus dim/fog reads too subtle/strong.

---
*Phase: 58-node-presentation-motion-overhaul*
*Completed: 2026-07-05*

## Self-Check: PASSED

- FOUND: src/viz/modules/graph.js
- FOUND: src/viz/modules/detail.js
- FOUND: src/viz/modules/constants.js
- FOUND commit: 77f39d6
- FOUND commit: e2ea423
