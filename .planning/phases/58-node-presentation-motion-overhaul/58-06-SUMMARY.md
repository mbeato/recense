---
phase: 58-node-presentation-motion-overhaul
plan: 06
subsystem: viz
tags: [three.js, camera, damping, interruptibility, registerTick]

# Dependency graph
requires:
  - phase: 58-node-presentation-motion-overhaul plan 02
    provides: haze impostor + ctx.hazeRayProxy (unrelated surface, same wave lineage)
  - phase: 58-node-presentation-motion-overhaul plan 03
    provides: labels.js's registerTick + THREE.MathUtils.damp convention this plan mirrors
  - phase: 58-node-presentation-motion-overhaul plan 04
    provides: detail.js's damped-fade registerTick pattern (activeMatcap Map) this plan's focus-timer sequencing sits alongside
provides:
  - "camera.js — one damped-target camera system: ctx.setCameraTarget(pos, lookAt) + a registerTick callback driving Graph.cameraPosition(dampedPos, dampedLookAt, 0) every frame (the verified synchronous ms=0 branch)"
  - "camera.js — exported pure stepCameraDamp({THREE, cur, targetPos, curLookAt, targetLookAt, dt}) helper for unit testing without a live Graph"
  - "detail.js focusCamera — D-06 orbit-then-dolly node focus with an anticipation pull-back, fully interruptible (clearFocusSequence on re-select AND deselect)"
  - "graph.js recenter — animated (#btn-recenter, unfocus) framing now routes through ctx.setCameraTarget; boot framing (ms===0) stays byte-identical since ctx.setCameraTarget does not exist yet at that point in the init chain"
  - "transition.js pullBackCamera/diveCamera — re-driven through ctx.setCameraTarget (D-08); all 4 patch-era lessons untouched"
  - "constants.js — CAM_POS_LAMBDA, CAM_LOOKAT_LAMBDA, FOCUS_ANTICIPATION_PCT, FOCUS_ORBIT_MS, FOCUS_DOLLY_MS (Phase-58 camera section, UNLOCKED feel constants)"
affects: [58-08 (Stage-2 motion founder checkpoint tunes these UNLOCKED feel constants live)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "One damped camera-target system: every camera-driving module (focus, recenter, transition) calls ctx.setCameraTarget(pos, lookAt) instead of Graph.cameraPosition(pos, lookAt, ms>0); a single registerTick callback in camera.js owns all the smoothing via THREE.MathUtils.damp and writes back through Graph.cameraPosition(dampedPos, dampedLookAt, 0) — the library's verified synchronous branch, so no two animators ever fight over camera.position in the same frame"
    - "Interruptible target grammar: setCameraTarget just reassigns module-scope target variables consumed by the next tick — calling it again mid-flight retargets smoothly by construction, no queue, no jump"
    - "Phase-gated multi-target sequencing (D-06 orbit-then-dolly): setTimeout-scheduled setCameraTarget calls issue successive targets (pull-back -> orbit -> dolly), with the timers themselves cancelable on re-entry/deselect so a new selection or a close interrupts the SEQUENCE, not just the underlying damp"
    - "Boot-vs-post-init camera call site: graph.js's recenter(0) executes synchronously inside initGraph(ctx), before camera.js's initCamera(ctx) runs later in app.js's init chain — so recenter must branch on ctx.setCameraTarget's existence (undefined at boot, present for every later animated call) rather than assuming it's always available"

key-files:
  created:
    - src/viz/modules/camera.js
    - tests/viz-camera-damp.test.ts
  modified:
    - src/viz/modules/app.js
    - src/viz/modules/constants.js
    - src/viz/modules/detail.js
    - src/viz/modules/graph.js
    - src/viz/modules/transition.js

key-decisions:
  - "CAM_LOOKAT_LAMBDA (8) set higher than CAM_POS_LAMBDA (4) to deliberately reproduce the old tween-based accessor's 'lookAt settles 3x faster than position' feel (RESEARCH Pitfall 4) — the old and new systems have genuinely different underlying math, so this is an explicit choice, not an automatic carry-over, and is called out for founder feedback at the Stage-2 checkpoint per the plan's interfaces section"
  - "graph.js recenter branches on `ms===0 || typeof ctx.setCameraTarget !== 'function'` rather than assuming ctx.setCameraTarget always exists — camera.js initializes AFTER initGraph in app.js's wiring order, so the boot-time recenter(0) call (which runs synchronously inside initGraph itself) predates camera.js's init. The animated branch (ms>0, called only from #btn-recenter/closeDetail, both well after full app boot) always has ctx.setCameraTarget available"
  - "D-06's orbit phase uses a simple midpoint-style interpolation (60% of the way from current position to the dolly target) for 'putting the node on-axis', rather than true spherical/axis-aligned orbit geometry — exact orbit shape is explicitly Claude's-Discretion per 58-CONTEXT.md (feel constants, UNLOCKED, tuned at Stage 2), and the plan's own verification for this task is a source-scan, not a geometry assertion"
  - "focusCamera's phase-timer sequence (focusTimers array + clearFocusSequence) is cancelled from BOTH a new focusCamera call AND clearSelection (not just re-selection) — a deselect mid-flight would otherwise let a stale orbit/dolly phase land its target after the panel has already closed, which the plan didn't explicitly call out but is a direct correctness consequence of the same interruptibility principle (Rule 2)"
  - "transition.js's pullBackCamera/diveCamera guard on `typeof ctx.setCameraTarget !== 'function'` rather than falling back to the old cameraPosition(...,DUR) call — the interfaces section confirms camera.js initializes synchronously during app.js's init chain, well before any user-triggered toCorpus()/toBrain() call, so ctx.setCameraTarget is guaranteed present by the time a transition ever fires; a DUR-based fallback would also violate the plan's own verify script (which scans for the absence of any 'cameraPosition(...,DUR)' pattern in the file, including in comments — see Issues Encountered)"

requirements-completed: [D-05, D-06, D-08]

# Metrics
duration: ~30min
completed: 2026-07-05
---

# Phase 58 Plan 06: Damped Interruptible Camera System Summary

**One damped-target camera system (camera.js, `ctx.setCameraTarget`) now drives every camera move in the app — node focus (orbit-then-dolly with anticipation pull-back), recenter/home framing, and the brain⇄corpus transition — replacing four scattered fixed-duration `Graph.cameraPosition(...,ms)` tweens with a single `registerTick`-driven damp loop, so interruptibility holds everywhere by construction.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-07-05T20:58Z (Task 1 commit)
- **Completed:** 2026-07-05T21:03Z (Task 3 commit)
- **Tasks:** 3/3 completed
- **Files modified:** 7 (2 created, 5 modified)

## Accomplishments

- `camera.js`: `initCamera(ctx)` seeds a module-scope damped target from the camera's boot position, exposes `ctx.setCameraTarget(pos, lookAt)` (calls `ctx.markActive()` to suppress stats.js idle drift — transition.js lesson 2), and registers a tick that damps toward the target via `THREE.MathUtils.damp` and writes back through `Graph.cameraPosition(dampedPos, dampedLookAt, 0)` — the verified synchronous branch, so it never re-enters 3d-force-graph's internal TWEEN group. Skips the per-frame write once settled within `CAM_SETTLE_EPS`.
- The damp-step math is exported standalone as `stepCameraDamp(...)`, unit-tested in `tests/viz-camera-damp.test.ts` for monotonic convergence, the Pitfall-4 gaze-settles-first asymmetry (`CAM_LOOKAT_LAMBDA > CAM_POS_LAMBDA`), and mid-flight interruptibility (a retarget redirects smoothly toward the new target with no discontinuity).
- `detail.js`'s `focusCamera` is now a three-phase D-06 sequence — anticipation pull-back (immediate) → orbit (after `FOCUS_ORBIT_MS`) → dolly-in to the unchanged `x+220/y+80/z+220` basis (after a further `FOCUS_DOLLY_MS`) — entirely through `ctx.setCameraTarget` calls. `clearFocusSequence()` cancels any pending phase timers on both re-selection and deselect.
- `graph.js`'s `recenter` migrates its animated path (`#btn-recenter`, `closeDetail`'s unfocus) to `ctx.setCameraTarget`, while the boot call (`ms===0`, which runs before `camera.js` has initialized) stays on the direct `Graph.cameraPosition` call — byte-identical framing at boot.
- `transition.js`'s `pullBackCamera`/`diveCamera` now call `ctx.setCameraTarget` instead of `Graph.cameraPosition(...,DUR)` — a two-line change; `homeCam` exact-home capture, `markActive()` calls, opacity-only fades, and prepared-before-reveal sequencing are all untouched.
- `search.js` verified to need zero edits: `pick()` reaches the camera only via `ctx.selectNode` → `detail.focusCamera`, so its fly-to is migrated for free by the Task 2 change.
- Five new named constants in `constants.js`'s "Phase 58 — camera" section: `CAM_POS_LAMBDA`, `CAM_LOOKAT_LAMBDA` (Task 1), `FOCUS_ANTICIPATION_PCT`, `FOCUS_ORBIT_MS`, `FOCUS_DOLLY_MS` (Task 2).

## Task Commits

Each task was committed atomically:

1. **Task 1: camera.js — one damped-target system, wired into app.js, with a convergence unit test** - `5287eb5` (feat)
2. **Task 2: Orbit-then-dolly node focus (D-06) + recenter migration** - `02ecf91` (feat)
3. **Task 3: Transition re-drive (D-08) + verify search fly-to needs no change** - `b4e8d70` (feat)

_No plan-metadata commit made in worktree mode — orchestrator commits SUMMARY.md/STATE.md/ROADMAP.md after merge._

## Files Created/Modified

- `src/viz/modules/camera.js` - New module: `initCamera(ctx)` + exported pure `stepCameraDamp(...)` helper
- `tests/viz-camera-damp.test.ts` - Unit tests: monotonic convergence, gaze-settles-first asymmetry, mid-flight interruptibility
- `src/viz/modules/app.js` - Imports `initCamera`, wires it after `initGraph`/before `initLabels`/`initDetail`; updated the "Ordered module wiring" doc-comment block
- `src/viz/modules/constants.js` - New "Phase 58 — camera" section: `CAM_POS_LAMBDA`, `CAM_LOOKAT_LAMBDA`, `FOCUS_ANTICIPATION_PCT`, `FOCUS_ORBIT_MS`, `FOCUS_DOLLY_MS`
- `src/viz/modules/detail.js` - `focusCamera` rewritten as a D-06 orbit-then-dolly phase sequence via `ctx.setCameraTarget`; `clearFocusSequence()` added and wired into both `focusCamera` (re-entry) and `clearSelection` (deselect)
- `src/viz/modules/graph.js` - `recenter(ms)` branches boot (direct `Graph.cameraPosition`) vs. animated (`ctx.setCameraTarget`, merging unspecified axes over the current camera position)
- `src/viz/modules/transition.js` - `pullBackCamera`/`diveCamera` migrated to `ctx.setCameraTarget`; all 4 lessons untouched

## Decisions Made

- `CAM_LOOKAT_LAMBDA` (8) > `CAM_POS_LAMBDA` (4) — reproduces the old tween accessor's "gaze settles 3x faster" feel (RESEARCH Pitfall 4); flagged in constants.js JSDoc and this summary for founder review at the Stage-2 checkpoint.
- `graph.js`'s `recenter` explicitly checks for `ctx.setCameraTarget`'s existence rather than assuming it — the boot-time call runs inside `initGraph`, before `camera.js` initializes later in `app.js`'s chain, so this branch is load-bearing, not defensive filler.
- D-06's orbit phase target uses a simple 60%-of-the-way interpolation rather than true axis-aligned orbit geometry — exact shape is Claude's Discretion per 58-CONTEXT.md, verified here by source-scan (not a geometry assertion), tuned at Stage 2.
- `clearFocusSequence()` is invoked from `clearSelection` (not just re-selection) so a deselect mid-flight can't let a stale phase timer land a target after the panel has closed.
- `transition.js` guards on `ctx.setCameraTarget`'s presence rather than keeping a `cameraPosition(...,DUR)` fallback — camera.js is guaranteed initialized before any user-triggered transition, and a fallback would also literally match (and fail) the plan's own verify regex.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Own explanatory comment in transition.js matched the plan's verify regex**
- **Found during:** Task 3, running the plan's own verify script after the edit
- **Issue:** The plan's verify command scans `transition.js` for the literal absence of the pattern `cameraPosition\([^)]*DUR\)`. My first draft of the migration comment read "...instead of a direct `Graph.cameraPosition(...,DUR)` tween" — that comment text itself matched the regex (a plain substring match, not code-aware), failing the verify check even though no actual `cameraPosition(...,DUR)` call remained in the code.
- **Fix:** Reworded the comment to "a direct fixed-duration Graph.cameraPosition tween" — same meaning, no literal substring match.
- **Files modified:** `src/viz/modules/transition.js`
- **Verification:** Re-ran the exact verify script from the plan; all five conditions now pass.
- **Committed in:** `b4e8d70` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — a documentation-only wording fix caught by the plan's own verify script)
**Impact on plan:** No behavior change; purely a comment wording adjustment so the plan's automated source-scan verify passes cleanly.

## Issues Encountered

None beyond the deviation above.

## Out-of-Scope Test Failures (logged, not fixed)

Running the full `npx vitest run` suite (2578 passed / 23 failed / 9 skipped) surfaces the identical 23 pre-existing failures across 7 files already logged in `.planning/phases/58-node-presentation-motion-overhaul/deferred-items.md` by Plan 02 (`adapter-capture`, `adapter-inject`, `episodic-dryrun-gate`, `eval-harness-smoke`, `locomo-harness`, `locomo-latency-curve`, `locomo-scorer` — all CLI-subprocess exit-code tests in unrelated engine surfaces). None touch `src/viz/modules/*`. Not re-logged here (same list, same root cause, already tracked). All 16 `tests/viz-*.test.ts` files (309 tests) pass green, including the new `tests/viz-camera-damp.test.ts`. `npx tsc --noEmit` is clean.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- The damped camera system is code-complete and unit/source-verified: `tests/viz-camera-damp.test.ts` passes (convergence, gaze-settles-first, interruptibility), all four migrated call sites (focus, recenter, transition pull-back/dive) route through `ctx.setCameraTarget`, and `search.js` needs zero edits (confirmed by source scan).
- **Live visual/motion verification is explicitly deferred to the Stage-2 founder checkpoint** per this plan's own `<verification>` section: does node focus actually read as an orbit-then-dolly with a noticeable anticipation beat? Does clicking node B mid-flight to node A retarget smoothly with no visible jump? Does the brain⇄corpus transition still feel like "brain recedes first" with no idle-drift fight after an idle period? None of this has been visually confirmed in this plan — it is unit/source-verified only.
- `ctx.setCameraTarget` is now part of the ctx surface any future plan touching camera motion should be aware of and route through, rather than calling `Graph.cameraPosition` with a nonzero `ms` directly.
- The five new UNLOCKED feel constants (`CAM_POS_LAMBDA`, `CAM_LOOKAT_LAMBDA`, `FOCUS_ANTICIPATION_PCT`, `FOCUS_ORBIT_MS`, `FOCUS_DOLLY_MS`) are the first things to tune at the Stage-2 checkpoint if the motion feels off (too snappy/sluggish, orbit too subtle/pronounced, etc.).

---
*Phase: 58-node-presentation-motion-overhaul*
*Completed: 2026-07-05*

## Self-Check: PASSED

- FOUND: src/viz/modules/camera.js
- FOUND: tests/viz-camera-damp.test.ts
- FOUND: src/viz/modules/app.js
- FOUND: src/viz/modules/constants.js
- FOUND: src/viz/modules/detail.js
- FOUND: src/viz/modules/graph.js
- FOUND: src/viz/modules/transition.js
- FOUND commit: 5287eb5
- FOUND commit: 02ecf91
- FOUND commit: b4e8d70
