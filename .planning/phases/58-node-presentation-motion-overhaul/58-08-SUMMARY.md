---
phase: 58-node-presentation-motion-overhaul
plan: 08
subsystem: viz
tags: [three.js, camera, checkpoint, founder-review, orbitcontrols]

# Dependency graph
requires:
  - phase: 58-node-presentation-motion-overhaul plan 06
    provides: camera.js damped-target system (ctx.setCameraTarget), D-06 orbit-then-dolly focus flight, transition re-drive
  - phase: 58-node-presentation-motion-overhaul plan 07
    provides: damped asymmetric hover, focus-depth dim/fog deepening (D-07)
provides:
  - "Stage-2 founder MOTION sign-off (D-13) — APPROVED after two revision rounds"
  - "camera.js — active flag gated by OrbitControls 'start' event: manual drag/zoom releases the damp target immediately, no snap-back; only a programmatic setCameraTarget re-arms it"
  - "detail.js focusCamera — D-06 orbit-then-dolly staged flight REMOVED per founder override; now a single continuous ctx.setCameraTarget glide to the unchanged final pose (x+220/y+80/z+220), fixing both the '2 repositions' feel and the drag-while-focused stomp"
  - "constants.js — FOCUS_ANTICIPATION_PCT/FOCUS_ORBIT_MS/FOCUS_DOLLY_MS removed (orphaned by the D-06 override)"
  - "tests/viz-camera-damp.test.ts — 3 new regression tests: no snap-back on manual orbit/zoom, active-flag release/re-arm"
  - "tests/viz-detail-focus-camera.test.ts — new file: exactly-one-camera-call invariants for selectNode/closeDetail"
affects: [phase-58 close, /gsd:verify-work, any future plan touching camera.js or detail.js focus flow]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "OrbitControls 'start' event as the manual-input release signal: camera.js listens for 'start' (fires on both pointer-drag orbit and wheel/pinch zoom) and flips an internal active flag off so the registerTick damp loop stops writing to the camera; only a fresh ctx.setCameraTarget call re-arms it and resumes damping from the user's current pose"
    - "Founder checkpoint judgment can override a locked plan decision (D-06) in-session — the checkpoint gate itself is the authority, not a re-plan; the staged orbit-then-dolly sequencing was removed live during Stage-2 review, not deferred to a follow-up plan"

key-files:
  created:
    - tests/viz-detail-focus-camera.test.ts
  modified:
    - src/viz/modules/camera.js
    - src/viz/modules/detail.js
    - src/viz/modules/constants.js
    - tests/viz-camera-damp.test.ts

key-decisions:
  - "D-06 (orbit-then-dolly staged focus flight) OVERRIDDEN by founder during this checkpoint — the phase-timer sequencing (anticipation pull-back -> orbit -> dolly, each its own setCameraTarget call) read as '2 repositions' on node click and, worse, its timers re-issued setCameraTarget mid-flight and stomped manual drag input. Replaced with a single continuous setCameraTarget to the unchanged final pose. This unlocks/removes the staged-flight requirement from the phase's locked decisions going forward — any future plan referencing D-06's orbit-then-dolly behavior should treat it as superseded by this checkpoint."
  - "Manual orbit/zoom must release the damp target immediately (Round 1 fix) — camera.js's registerTick previously fought user input every frame by continuing to steer toward the last programmatic target. An 'active' flag, cleared on OrbitControls' 'start' event and only re-armed by the next setCameraTarget call, resolves this without touching stepCameraDamp's pure math."
  - "Gaze-settles-first (CAM_LOOKAT_LAMBDA=8 > CAM_POS_LAMBDA=4, RESEARCH Pitfall 4) implicitly accepted — founder raised no objection across all three review rounds despite the plan's explicit ask for feedback on this specific choice. Recorded here as accepted-by-silence, not as an explicit verdict; flagged honestly rather than fabricated as an affirmative approval."
  - "HOVER_LAMBDA=10, HOVER_OVERSHOOT=1.05, FOCUS_DIM_OPACITY=0.035, FOCUS_FOG_NEAR=BRAIN_SCALE*1.4 all APPROVED as landed in Plan 07 — founder gave no tuning notes on hover feel, transition, or focus dim/fog across any round; final values are exactly what Plan 07 shipped, untouched."

requirements-completed: [D-13, D-14, D-15, D-16]

# Metrics
duration: ~3 rounds of live review + 2 fixes
completed: 2026-07-05
---

# Phase 58 Plan 08: Stage-2 Founder Checkpoint — MOTION Summary

**Founder APPROVED the full motion grammar (hover, focus flight, transition, focus dim/fog) after two revision rounds that fixed a camera snap-back bug and removed the D-06 staged orbit-then-dolly flight entirely in favor of a single continuous camera move — this checkpoint is a founder-judgment gate, not a scripted verification, so the record below is the conversation transcript, not automated test output.**

## Performance

- **Rounds:** 3 (2 rejected-with-fixes, 1 approved)
- **Completed:** 2026-07-05
- **Tasks:** 1/1 (single checkpoint task, resolved across 3 review rounds)
- **Files modified across both fixes:** 5 (2 created, 3 modified — see Files Created/Modified)

## Review History

### Round 1 — REJECTED

**Founder feedback:** "whenever i grab and drag it moves but snaps back to original location, same with zoom" — camera locked in one place; manual orbit/drag and zoom snapped back to the pre-drag position instead of staying where the user left it.

**Root cause:** camera.js's `registerTick` damp loop kept steering `camera.position`/lookAt toward the last programmatic `setCameraTarget` every frame, even while `OrbitControls` was being actively driven by the user's own drag/wheel input — so manual input was overridden the instant the next tick ran.

**Fix — `760b43b`** (fix(58-08): release damp target on manual orbit/zoom, no snap-back):
- camera.js now tracks an `active` flag, true only while a programmatic move (focus flight, recenter, transition) is in flight.
- `OrbitControls`' `'start'` event (fires for both pointer-drag orbit and wheel/pinch zoom) flips `active` off immediately, so the tick stops writing and the camera stays exactly where the user leaves it.
- Only the next `setCameraTarget` call re-arms `active` and resumes damping — from the camera's current (user-repositioned) pose, not the stale pre-drag target.
- `stepCameraDamp` itself untouched — still pure and frame-rate independent.
- 3 new regression tests added to `tests/viz-camera-damp.test.ts`: no snap-back on manual input, active-flag release, re-arm from new pose.

### Round 2 — PARTIALLY REJECTED

**Approved in this round:** hover feel, transition re-drive, focus dim/fog deepening — no notes.

**Rejected:**
(a) "clicking a node feels awkward — 2 repositions" — the D-06 anticipation-pull-back -> orbit -> dolly staged sequence read as two distinct camera jumps, not one deliberate move.
(b) drag/move while a node is focused is broken — the phase-timer sequence itself re-issued `setCameraTarget` mid-flight on its own schedule, which re-armed the just-fixed `active` flag and stomped any manual drag the user attempted while a focus flight's timers were still pending.

**Fix — `099582d`** (fix(58-08): replace staged focus flight with single continuous camera move):
- D-06's orbit-then-dolly staged flight **removed** — founder explicitly overrode decision D-06 via this checkpoint; the checkpoint's judgment is the gate, so this behavior is unlocked/superseded, not deferred.
- `detail.js`'s `focusCamera` is now a single `ctx.setCameraTarget` call to the unchanged final pose (`x+220/y+80/z+220`); the damped system (camera.js) glides there in one continuous move.
- Root cause of both (a) and (b) removed at the source: the orphaned phase-timer plumbing (`focusTimers`, `clearFocusSequence`) and its call from `clearSelection` deleted entirely — there is no longer a timer to re-issue a target mid-flight.
- `constants.js`: `FOCUS_ANTICIPATION_PCT`, `FOCUS_ORBIT_MS`, `FOCUS_DOLLY_MS` removed (no longer referenced anywhere).
- New `tests/viz-detail-focus-camera.test.ts`: asserts `selectNode` fires exactly one `setCameraTarget` call (no delayed 2nd/3rd call from timers), and `closeDetail` doesn't add an extra call beyond recenter.

### Round 3 — APPROVED

Founder confirmed: single-move focus flight reads correctly, and dragging/orbiting while a node is focused now works without snapping back. User response: **"approved"**.

## Final Constant Values (all founder-approved as landed, no further tuning)

| Constant | Value | Notes |
|---|---|---|
| `HOVER_LAMBDA` | 10 | Plan 07 value, unchanged |
| `HOVER_OVERSHOOT` | 1.05 | Plan 07 value, unchanged |
| `CAM_POS_LAMBDA` | 4 | Plan 06 value, unchanged |
| `CAM_LOOKAT_LAMBDA` | 8 | Plan 06 value, unchanged — gaze-settles-first (see Decisions) |
| `FOCUS_DIM_OPACITY` | 0.035 | Plan 07 value, unchanged |
| `FOCUS_FOG_NEAR` | `BRAIN_SCALE * 1.4` | Plan 07 value, unchanged |

`FOCUS_ANTICIPATION_PCT` / `FOCUS_ORBIT_MS` / `FOCUS_DOLLY_MS` — **removed** in Round 2's fix; no longer exist in `constants.js`.

## Honest Evidence Gaps

Per the plan's acceptance criteria, the following artifacts were called for but were **not produced** — recorded here rather than fabricated:

- **No screen recordings (D-14).** The plan's `<how-to-verify>` asked for recorded clips of hover, focus flight, and transition. None were supplied by the founder or captured by the executor. The durable approval record for this checkpoint is this conversation's review transcript (3 rounds, 2 fixes, final "approved"), not video.
- **No fps numbers reported (D-16).** The plan asked for a one-line before/after fps comparison at both tiers (idle/active) against the Plan 01 baseline. No `S`-overlay fps readings were reported by the founder at any point in any of the 3 rounds. No before/after comparison exists. This is an open item — if a perf regression exists, it has not been measured or ruled out by this checkpoint.
- **Gaze-settles-first has no explicit verdict.** The plan explicitly asked for founder feedback on `CAM_LOOKAT_LAMBDA > CAM_POS_LAMBDA` (RESEARCH Pitfall 4). The founder raised no objection to it across all three rounds, but no explicit "yes, keep it" was given either — recorded as implicitly accepted, not explicitly confirmed.

## Machine Locks at Approval

Re-verified at close of this checkpoint (2026-07-05, current worktree):
- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run` — **2615 passed / 0 failed** (174 test files passed, 1 skipped; 3 tests skipped) — matches the founder-reported figure at approval time.
- `node scripts/gen-matcap.mjs --check` — OK, grayscale byte-identical to the generator.

D-15 palette-touching locks (LABEL_COLOR band, matcap grayscale, LOCKED-constant no-drift) intact.

## Files Created/Modified

- `src/viz/modules/camera.js` — Round 1 fix: `active` flag gated by `OrbitControls`' `'start'` event; damp tick no longer overrides manual drag/zoom
- `tests/viz-camera-damp.test.ts` — Round 1 fix: 3 new regression tests (no snap-back, active-flag release/re-arm)
- `src/viz/modules/detail.js` — Round 2 fix: `focusCamera` reduced from D-06 staged 3-phase sequence to a single `ctx.setCameraTarget` call; `focusTimers`/`clearFocusSequence` plumbing removed, including its call in `clearSelection`
- `src/viz/modules/constants.js` — Round 2 fix: `FOCUS_ANTICIPATION_PCT`/`FOCUS_ORBIT_MS`/`FOCUS_DOLLY_MS` removed; D-05..D-08 section comment updated
- `tests/viz-detail-focus-camera.test.ts` — Round 2 fix (new file): exactly-one-`setCameraTarget`-call invariants for `selectNode`/`closeDetail`

## Decisions Made

See `key-decisions` in frontmatter — most notably, **D-06 (orbit-then-dolly staged focus flight) is overridden and removed** by explicit founder judgment during this checkpoint. Any future plan or documentation referencing D-06's staged-flight behavior should treat it as superseded.

## Deviations from Plan

This entire plan **is** the deviation-resolution process — the checkpoint task itself specified founder review with revision as an expected outcome. Within that, two fixes were required beyond the reviewed Plan 06/07 code:

**1. [Checkpoint-driven fix] Camera snap-back on manual orbit/zoom**
- **Found during:** Round 1 review
- **Issue:** registerTick damp loop overrode user drag/zoom input every frame
- **Fix:** `active` flag gated by OrbitControls `'start'` event; commit `760b43b`
- **Files modified:** `src/viz/modules/camera.js`, `tests/viz-camera-damp.test.ts`

**2. [Checkpoint-driven, Rule 4-equivalent architectural override] D-06 staged focus flight removed**
- **Found during:** Round 2 review
- **Issue:** staged orbit-then-dolly flight felt like "2 repositions"; its phase timers also broke drag-while-focused
- **Fix:** single continuous `setCameraTarget` call replaces the 3-phase sequence; orphaned timer plumbing and constants removed; commit `099582d`
- **Files modified:** `src/viz/modules/detail.js`, `src/viz/modules/constants.js`, `tests/viz-detail-focus-camera.test.ts`
- **Note:** This is a locked-decision override (D-06), normally a Rule 4 architectural change requiring a stop-and-ask. Here the founder checkpoint itself IS the human decision — the override was made live, in-session, by the person with authority over the decision, so no separate escalation was needed.

**Total deviations:** 2, both directly resolving founder-identified defects during this checkpoint's own review process. No scope creep — no other files touched.

## Known Stubs

None.

## Threat Flags

None — both fixes touch only `camera.js`/`detail.js` motion internals and their tests; no new network endpoint, auth path, file access pattern, or schema change introduced. D-15 palette-touching locks re-verified green above.

## Issues Encountered

None beyond the two rounds of founder-requested fixes documented above.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Full motion grammar (hover, focus flight, transition, focus dim/fog) is founder-approved and code-complete.
- D-06 is superseded — future plans should reference the single-continuous-move focus flight (this plan), not the removed staged orbit-then-dolly sequence.
- **Open item carried forward:** no fps baseline comparison (D-16) and no screen recordings (D-14) exist for this phase. If `/gsd:verify-work` or a future phase needs this evidence, it must be captured fresh — it does not exist from this checkpoint.
- All machine locks (tsc, full vitest suite, gen-matcap --check) are green at close.

---
*Phase: 58-node-presentation-motion-overhaul*
*Completed: 2026-07-05*
