---
phase: 59-hud-integration-visible-but-belong
plan: 06
subsystem: ui
tags: [viz, hud, glass-css, camera, three.js, force-graph, checkpoint]

# Dependency graph
requires:
  - phase: 59-hud-integration-visible-but-belong (01-05)
    provides: Liquid-Glass panel language, chip/rail/topics-rail DOM footprint, vanilla ⌘K palette, auto-recede opacity driver
provides:
  - Founder-approved D-15 closing checkpoint on the live recense viz install (glass + rails + palette + recede judged together)
  - 4-icon HUD rail (reader icon removed; reader reachable via corpus + palette only)
  - Palette-only glass transparency tier (glass-bg-palette 0.42 alpha, glass-blur-palette 8px)
  - Root-cause fix for idle-rotation wedge after node focus/unfocus (vendored 3d-force-graph lookAt synthesis bug)
affects: [viz-camera, viz-hud, future-phase-61-corpus-chrome]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "camera.js reads the real controls.target for settle checks rather than the vendor's synthesized fixed-distance lookAt read accessor"
    - "Palette-only CSS glass tier (glass-bg-palette/glass-blur-palette) added alongside the shared focused-tier tokens for surfaces needing more scene-through transparency"

key-files:
  created:
    - tests/viz-idle-drift-camera-flight.test.ts (extended with real-camera.js settle-path regression test)
  modified:
    - src/viz/index.html (reader icon removed from rail)
    - src/viz/modules/reader.js (null-guarded #btn-reader lookup)
    - src/viz/css/styles.css (palette glass tier)
    - src/viz/modules/constants.js (glass-bg-palette/glass-blur-palette tokens)
    - src/viz/modules/stats.js (idle drift gated on isCameraInFlight)
    - src/viz/modules/camera.js (settle check reads controls.target instead of synthetic lookAt)
    - .planning/phases/59-hud-integration-visible-but-belong/59-EVIDENCE.md
    - .planning/debug/idle-drift-camera-flight-wedge.md (moved to resolved/)

key-decisions:
  - "Founder judged the D-15 checkpoint live on the packed app install with no screenshots/recording attached — the evidence record is the live tuning cycle (feedback + 4 fix commits + automated-gate results), documented honestly rather than inventing media links"
  - "Standalone reader-open icon dropped from the HUD rail entirely (rail 5 -> 4 icons); reader stays reachable via corpus view + ⌘K palette command"
  - "Palette gets its own more-transparent glass tier instead of repositioning — founder chose transparency over layout change"
  - "HUD_IDLE_TIMEOUT_MS and RECEDE_GHOST_OPACITY ratchet-locked at their provisional defaults (4000ms / 0.12) — no live complaints on either"

patterns-established:
  - "Vendor library read/write asymmetry check: when a library's no-arg accessor synthesizes a derived value instead of returning the underlying live property, read the live property directly rather than trusting the accessor's approximation for equality/settle checks"

requirements-completed: [D-15]

# Metrics
duration: multi-session checkpoint cycle (automated gate 2026-07-06 00:06 UTC -> founder approval 2026-07-07)
completed: 2026-07-07
---

# Phase 59 Plan 06: Founder D-15 Checkpoint Summary

**Founder approved the combined glass/rails/palette/recede feel live on the packed app; the checkpoint cycle also found and fixed the real root cause of an idle-rotation wedge (vendored 3d-force-graph's lookAt-read/write asymmetry) that a first attempted fix had only papered over.**

## Performance

- **Automated gate:** 2026-07-06 00:06 UTC (Task 1, commit b60af3b)
- **Checkpoint fix cycle:** 2026-07-06 07:57 - 20:15 UTC (4 fix commits, 861da79 -> 064a4a6)
- **Founder approval:** 2026-07-07 (Task 2 resolution)
- **Tasks:** 2/2 completed
- **Files modified:** 8 (across the checkpoint cycle: index.html, reader.js, styles.css, constants.js, stats.js, camera.js, EVIDENCE.md, debug session file)

## Accomplishments

- Full vitest suite (2640+ tests) and both phase-specific test files confirmed green before the qualitative gate; both D-15 anti-slop machine checks (glass confined to D-12 selector list, zero emoji in chrome) confirmed PASS
- Founder judged the complete HUD integration — glass panel language, chip/rail/topics-rail footprint, ⌘K palette, auto-recede — together on the live `recense viz` install and approved it
- Checkpoint-driven live tuning produced 4 fix commits: reader icon removed from the rail, palette given its own more-transparent glass tier, and a two-stage fix for an idle-rotation wedge (the first attempt was a correct-but-insufficient gate; the second found and fixed the actual root cause in the vendored 3d-force-graph library's `cameraPosition()` read accessor)
- D-15 evidence record finalized in 59-EVIDENCE.md with the actual ratcheted constant values and an honest account of what was and wasn't captured as media

## Task Commits

1. **Task 1: Pre-checkpoint automated gate** - `b60af3b` (docs) — full suite green (2640 passed/3 skipped), phase-specific tests 55/55, both anti-slop machine checks PASS, evidence scaffold created
2. **Task 2: Founder D-15 checkpoint** - resolved via 4 live fix commits during the checkpoint cycle:
   - `861da79` (fix) — remove reader icon from HUD rail (founder: standalone reader chrome useless; rail now 4 icons)
   - `1f2cb10` (fix) — increase palette glass transparency (glass-bg-palette 0.42 alpha + glass-blur-palette 8px, palette-only tokens)
   - `fd8f224` (fix) — gate idle drift on `isCameraInFlight()` (first attempt — correct gate, but the underlying flag it waits on didn't reliably clear)
   - `064a4a6` (fix) — read the real gaze target (`controls.target`) instead of the vendor's synthesized fixed-distance lookAt, fixing the actual root cause of the wedge

**Plan metadata:** this commit (docs: finalize D-15 evidence + resolve debug session + complete checkpoint plan)

## Files Created/Modified

- `.planning/phases/59-hud-integration-visible-but-belong/59-EVIDENCE.md` - Finalized D-15 evidence record: automated-gate results, checkpoint cycle narrative, anti-slop checklist PASS/PASS, actual ratcheted constant values, honest no-media-attached note, founder approval
- `.planning/debug/idle-drift-camera-flight-wedge.md` - Moved to `.planning/debug/resolved/`, frontmatter status `awaiting_human_verify` -> `resolved`, updated timestamp, next_action note appended confirming founder's live retest passed
- `src/viz/index.html` - Reader icon dropped from `#hud-rail` (5 icons -> 4)
- `src/viz/modules/reader.js` - `#btn-reader` lookup made optional (null-guarded)
- `src/viz/css/styles.css` / `src/viz/modules/constants.js` - Palette-only glass tier tokens (`glass-bg-palette`, `glass-blur-palette`)
- `src/viz/modules/stats.js` - `updateIdleDrift` gated on `!ctx.isCameraInFlight()`
- `src/viz/modules/camera.js` - Settle-check tick reads `ctx.Graph.controls().target` instead of the vendor's synthetic `cur.lookAt`
- `tests/viz-idle-drift-camera-flight.test.ts` - Extended with a real-`camera.js` settle-path regression test (vendor-faithful read/write asymmetry mock), confirmed red pre-fix / green post-fix

## Decisions Made

- No screenshots or screen recording were attached to the D-15 evidence record — the founder judged the checkpoint live on the packed app and approved verbally; the evidence record documents this honestly (the tuning cycle + fix commits + automated-gate results ARE the evidence) rather than fabricating media links, per the plan's own "do not invent screenshot paths" guardrail
- `HUD_IDLE_TIMEOUT_MS` (4000ms) and `RECEDE_GHOST_OPACITY` (0.12) ratchet-locked unchanged from their provisional defaults — no founder complaints raised on either during the live session
- Reader icon removed entirely from the rail rather than kept as a redundant entry point, since the corpus view and palette command already cover it

## Deviations from Plan

### Auto-fixed / Checkpoint-found Issues

**1. [Checkpoint ratchet — founder-directed] Reader icon removed from HUD rail**
- **Found during:** Task 2 live checkpoint
- **Issue:** Founder judged the standalone reader-open rail icon as useless chrome given the corpus + palette entry points already exist
- **Fix:** Dropped `#btn-reader` from `#hud-rail`; made `reader.js`'s lookup null-guarded
- **Files modified:** `src/viz/index.html`, `src/viz/modules/reader.js`
- **Committed in:** `861da79`

**2. [Checkpoint ratchet — founder-directed] Palette glass transparency increased**
- **Found during:** Task 2 live checkpoint
- **Issue:** Shared focused-tier glass (0.90 alpha / 14px blur) covered the scene too heavily for the centered ⌘K palette overlay
- **Fix:** Added palette-only `glass-bg-palette` (0.42 alpha) and `glass-blur-palette` (8px) tokens; founder chose transparency over repositioning
- **Files modified:** `src/viz/css/styles.css`, `src/viz/modules/constants.js`
- **Committed in:** `1f2cb10`

**3. [Rule 1 - Bug, checkpoint-found] Idle rotation didn't resume after node unfocus (first attempt — insufficient)**
- **Found during:** Task 2 live checkpoint (founder retest)
- **Issue:** `stats.js`'s idle camera drift gated only on `ctx.isIdle()`, never on `ctx.isCameraInFlight()`; a still-in-flight programmatic camera move outlasted the idle timeout and the two writers (drift + camera.js's damp tick) fought every frame
- **Fix:** Gated `updateIdleDrift` on `!ctx.isCameraInFlight()`
- **Files modified:** `src/viz/modules/stats.js`, `tests/viz-idle-drift-camera-flight.test.ts` (new)
- **Committed in:** `fd8f224`
- **Note:** This fix was necessary but not sufficient — see item 4

**4. [Rule 1 - Bug, checkpoint-found] Idle rotation still wedged after fix 3 — real root cause**
- **Found during:** Task 2 live checkpoint (founder retested on a fresh launch after fix 3 — still reproduced)
- **Issue:** The vendored `3d-force-graph.min.js`'s no-arg `Graph.cameraPosition()` read accessor synthesizes its `lookAt` field as a fixed-length-1000 point along the camera's facing direction, not the real `controls.target`. Actual flight targets sit at different true distances (node-focus ~321 units, recenter ~1012 units), so `camera.js`'s settle check could never converge and `isCameraInFlight()` never cleared on its own — fix 3's gate was correct but waited forever on a flag that structurally could never clear
- **Fix:** `camera.js`'s tick now reads the real gaze point from `ctx.Graph.controls().target` directly instead of the synthetic `cur.lookAt`, falling back to `cur.lookAt` only when `controls`/`target` is unavailable
- **Files modified:** `src/viz/modules/camera.js`, `tests/viz-idle-drift-camera-flight.test.ts` (extended)
- **Verification:** New regression test confirmed red against pre-fix `camera.js` (wedge reproduced after 320 simulated frames) and green after the fix; full suite green (2643 passed, 3 skipped); `tsc --noEmit` clean; build refreshed
- **Committed in:** `064a4a6`
- **Founder retest:** confirmed fixed on a fresh app launch (focus a node, unfocus, wait past idle timeout — rotation resumes without a manual drag)

---

**Total deviations:** 4 (2 founder-directed checkpoint ratchets, 2 checkpoint-found bugs — the second bug fix superseded the first, which was a necessary but incomplete intermediate step)
**Impact on plan:** All four changes were legitimate outcomes of the D-15 checkpoint's own design (live tuning + evidence capture); no scope creep beyond what the checkpoint task explicitly authorizes ("tune live... these values are then locked").

## Issues Encountered

The idle-rotation wedge required two fix attempts across the checkpoint cycle: the first (`fd8f224`) correctly identified that idle drift needed to respect in-flight camera state but didn't investigate why `isCameraInFlight()` itself never cleared. The founder's insistence on retesting on a fresh launch (rather than accepting the first fix at face value) surfaced that the underlying flag was structurally broken — traced to a vendor-library read/write asymmetry (`Graph.cameraPosition()`'s no-arg read synthesizes an approximate lookAt rather than returning the real `controls.target` the write path sets). Root cause confirmed by reading the vendored bundle's source directly rather than inferring from behavior alone.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 59 (HUD Integration) is complete: all 6 plans executed, D-15 closing checkpoint approved
- Full vitest suite green (2643+ tests including the new camera-settle regression test); `tsc --noEmit` clean; build refreshed
- Test re-confirmation for this plan's closing bookkeeping: `npx vitest run tests/viz-activity-palette-invariants.test.ts tests/viz-hud-palette.test.ts tests/viz-idle-drift-camera-flight.test.ts` — 3 files, 58 tests, all passed
- Roadmap Phase 61 (corpus chrome — index column + project browsing) was separately queued from checkpoint feedback (commit `0b3978c`, orchestrator-owned, not part of this plan)
- No open blockers from this plan; debug session `idle-drift-camera-flight-wedge.md` fully resolved and archived

## Self-Check

- FOUND: .planning/phases/59-hud-integration-visible-but-belong/59-EVIDENCE.md (finalized)
- FOUND: .planning/debug/resolved/idle-drift-camera-flight-wedge.md
- MISSING (expected): .planning/debug/idle-drift-camera-flight-wedge.md (moved, not missing)
- Commits verified: b60af3b, 861da79, 1f2cb10, fd8f224, 064a4a6 all present in `git log --oneline`
- Test re-run: `npx vitest run tests/viz-activity-palette-invariants.test.ts tests/viz-hud-palette.test.ts tests/viz-idle-drift-camera-flight.test.ts` -> 3 files, 58 tests, all PASS

## Self-Check: PASSED

---
*Phase: 59-hud-integration-visible-but-belong*
*Completed: 2026-07-07*
