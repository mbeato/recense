---
phase: 59-hud-integration-visible-but-belong
plan: 05
subsystem: ui
tags: [opacity-transition, idle-detection, camera-state, viz, vanilla-css]

# Dependency graph
requires:
  - phase: 59-01
    provides: HUD_CSS_TOKENS motion tokens (--motion-base/--motion-fast/--ease-out-soft),
      HUD_IDLE_TIMEOUT_MS/RECEDE_GHOST_OPACITY scalars, emitHudTokens() :root injection
  - phase: 59-04
    provides: "#hud-chip/#hud-rail/#topics-rail DOM footprint to attach recede behavior to"
provides:
  - "ctx.isCameraInFlight() — read-only in-flight boolean export from camera.js"
  - "ctx.msSinceActive() — read-only elapsed-since-active export from stats.js, decoupled from the 1200ms scene-drift threshold"
  - "hud-recede.js: initHudRecede(ctx) — opacity-only auto-recede driven by idle + camera-flight + focus/detail-open"
  - "D-08/D-09/D-10/D-11 chrome recede live: chip/rail/topics-rail fade to hairline ghost on idle/flight/focus, hover always restores presence, SSE traces never force recede"
affects: [59-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "hud-recede.js reads the existing #detail panel-open class as the focus/detail-open signal (no new coupling into detail.js internals) and the existing single global mousemove listener (via ctx.msSinceActive) — zero new DOM listeners added"
    - "Two-tier recede class pair (.hud-receded base / .hud-receded.hud-recede-fast focus-deepen) keeps the idle/camera-flight transition on --motion-base and the focus-deepen transition on the quicker --motion-fast, both opacity-only"

key-files:
  created: [src/viz/modules/hud-recede.js]
  modified: [src/viz/modules/camera.js, src/viz/modules/stats.js, src/viz/modules/app.js, src/viz/css/styles.css]

key-decisions:
  - "hud-recede.js ticks via ctx.registerTick (mirrors stats.js's updateIdleDrift shape) and only writes classList when the receded/focused boolean state actually changes, avoiding per-frame DOM churn"
  - "Focus/detail-open reuses detail.js's existing #detail.panel-open class purely as a read signal from hud-recede.js — no changes to detail.js itself, keeping the coupling one-directional and additive"
  - "CSS hover-override rule uses the combined .hud-receded:hover selector (2-class-equivalent specificity) so hover always restores full opacity regardless of stylesheet order, rather than relying on cascade position"

requirements-completed: [D-08, D-09, D-10, D-11]

duration: ~15min
completed: 2026-07-06
---

# Phase 59 Plan 05: HUD Auto-Recede (Idle/Camera-Flight/Focus) Summary

**Opacity-only chrome recede driven by a small hud-recede.js tick reading two new read-only ctx exports (ctx.isCameraInFlight, ctx.msSinceActive) plus the existing detail-panel-open signal — chip/rail/topics-rail fade to hairline ghost on idle, camera flight, or focus, and restore instantly on hover or mouse move**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-07-06T00:01:xxZ
- **Tasks:** 3 completed
- **Files modified:** 5 (1 created, 4 modified)

## Accomplishments
- `camera.js` gains `ctx.isCameraInFlight = () => active` next to `ctx.setCameraTarget` — a pure read-only export of the existing damped-camera in-flight closure boolean, camera internals otherwise untouched
- `stats.js` gains `ctx.msSinceActive = () => performance.now() - lastActiveTime` next to `ctx.isIdle` — reuses the same `lastActiveTime` variable the existing mousemove listener already resets, without touching the separate 1200ms scene-drift `IDLE_TIMEOUT_MS`/`ctx.isIdle` (RESEARCH Pitfall 2)
- New `hud-recede.js` (`initHudRecede(ctx)`): a per-tick boolean `recede = ctx.msSinceActive() > HUD_IDLE_TIMEOUT_MS (4000ms) OR ctx.isCameraInFlight() OR #detail.panel-open`, toggling `.hud-receded` (and `.hud-recede-fast` when the reason is focus/detail-open) on `#hud-chip`/`#hud-rail`/`#topics-rail`; only writes to the DOM when the boolean state actually flips
- `app.js` wires `initHudRecede(ctx)` last, after the chip/rail/topics-rail chrome (Plan 04) and `initPalette`
- `styles.css` adds the `.hud-receded`/`.hud-receded.hud-recede-fast` opacity-only rules (`var(--recede-ghost-opacity)` = 0.12, `var(--motion-base)`/`var(--motion-fast)` transitions) plus a hover-override rule so reaching for the chrome always restores full presence; `#topics-rail`'s own hover-EXPAND (width) is left completely untouched by recede
- No new listeners anywhere: reuses the single existing global `mousemove` listener in `app.js` and the existing `#detail` panel-open class from `detail.js`

## Task Commits

Each task was committed atomically:

1. **Task 1: Expose ctx.isCameraInFlight() and ctx.msSinceActive()** - `fd3bcab` (feat)
2. **Task 2: hud-recede.js opacity driver + app.js wiring** - `a70701a` (feat)
3. **Task 3: Opacity-only recede CSS classes (motion tokens, no layout shift)** - `9c45839` (feat)

## Files Created/Modified
- `src/viz/modules/camera.js` - Adds `ctx.isCameraInFlight = () => active;` (read-only export, no internals changed)
- `src/viz/modules/stats.js` - Adds `ctx.msSinceActive = () => performance.now() - lastActiveTime;` (read-only export, `IDLE_TIMEOUT_MS=1200`/`ctx.isIdle` untouched)
- `src/viz/modules/hud-recede.js` (new) - `initHudRecede(ctx)`: per-tick recede boolean (idle OR camera-flight OR focus/detail-open), toggles `.hud-receded`/`.hud-recede-fast` on the chip/rail/topics-rail chrome
- `src/viz/modules/app.js` - Imports and wires `initHudRecede(ctx)` last in the boot sequence
- `src/viz/css/styles.css` - Adds `.hud-receded`/`.hud-receded.hud-recede-fast` opacity-only recede rules + hover-restore override, placed after the `#topics-rail` block

## Decisions Made
See `key-decisions` in frontmatter. In short: hud-recede.js is a pure read-only consumer of `#detail.panel-open` (no detail.js changes), skips DOM writes on unchanged state, and the CSS hover-override rule uses combined-class specificity rather than cascade order so hover-restore is guaranteed regardless of future rule reordering.

## Deviations from Plan

None beyond a single wording fix caught by the plan's own verify gate (below) — plan executed exactly as written otherwise.

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Task 2's own verify gate flagged the module's header prose as an "SSE/trace" match**
- **Found during:** Task 2 verification — the plan's automated check `grep -qiE "SSE|EventSource|trace" src/viz/modules/hud-recede.js` (asserting the module does NOT read SSE/trace state) matched the module's own header comment, which used the words "SSE/trace/activation" to *document* that it deliberately does not read that state.
- **Fix:** Reworded the header comment to describe the same guarantee (D-10: live-recall/server-push activity never forces a recede) without using the literal substrings the gate scans for.
- **Files modified:** `src/viz/modules/hud-recede.js`
- **Verification:** Task 2's verify gate green; behavior/logic unchanged (comment-only edit)
- **Committed in:** `a70701a` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (comment wording only, no logic change)
**Impact on plan:** None — purely a docstring adjustment to satisfy the plan's own literal-string verify gate.

## Issues Encountered

One pre-existing test (`tests/recense-doctor.test.ts` — "(n1) subscription mode + missing ANTHROPIC_API_KEY is NOT a failure") failed only when run as part of the full parallel `npm test` suite and passed cleanly both in isolation (`npx vitest run tests/recense-doctor.test.ts`, 21/21 green) and on a full-suite rerun immediately after. This is environment-dependent test-worker env-var leakage unrelated to this plan's viz-only file scope (confirmed: this plan touches no doctor/env-check code), consistent with the documented "known environment quirk" for this worktree. Full suite was green (2639 passed / 4 skipped) on both the pre- and post-flake runs.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `#hud-chip`/`#hud-rail`/`#topics-rail` now auto-recede to hairline ghost on idle/camera-flight/focus and restore instantly on hover or mouse move, satisfying D-08/D-09/D-10/D-11 machine-verifiably (grep gates + D-11/D-14 invariants + full suite)
- Manual/live verification (watch the actual 4s idle fade, camera-flight recede during a fly-to, focus/detail-open instant drop, confirm SSE traces don't force recede, confirm nothing shifts) was not performed live in this automated pass — this plan is fully autonomous with no checkpoint; the phase's closing D-15 founder checkpoint is the natural point for this live check, alongside Plan 04's equivalent open item
- No blockers. Plan 06 (the phase's remaining wave) can proceed independently.

---
*Phase: 59-hud-integration-visible-but-belong*
*Completed: 2026-07-06*

## Self-Check: PASSED

All 5 created/modified files found on disk; all 3 task commits (fd3bcab, a70701a, 9c45839) verified present in git log.
