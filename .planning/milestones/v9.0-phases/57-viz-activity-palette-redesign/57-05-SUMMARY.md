---
phase: 57-viz-activity-palette-redesign
plan: 05
subsystem: viz-client
tags: [viz, bloom, tone-mapping, exposure, D-13, D-14, UnrealBloomPass]

# Dependency graph
requires:
  - phase: 57-viz-activity-palette-redesign (57-02, 57-03)
    provides: luminance-equalized, founder-approved KIND_COLOR identity palette (LOCKED band Y in [170,228]/255) that this plan's bloom recalibration is measured against
provides:
  - Recalibrated provisional UnrealBloomPass strength/threshold sized to the D-02 LOCKED luminance band, using the same Rec.709 luminance formula as the invariants test
  - Documented D-13 renderer exposure/tone-mapping calibration surface in graph.js (left at THREE default for this plan, knob located for Stage-2)
affects: [57-06, 57-07]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Bloom threshold sized via the same Rec.709 dot-product the D-02 invariants test uses (LuminosityHighPassShader.js's luminance() chunk matches 0.2126/0.7152/0.0722 exactly) — luminance-band math and bloom-gate math are directly comparable, not independently guessed."

key-files:
  created: []
  modified:
    - src/viz/modules/effects.js
    - src/viz/modules/graph.js

key-decisions:
  - "Threshold eased 0.75 -> 0.72 (not raised) after computing that the new palette's HOT amber (0xffb866, Y≈0.758) sat only ~0.008 above the old 0.75 gate — razor-thin margin likely to flicker under real opacity/blend variance during activation. Lowering slightly to 0.72 gives HOT/replay/spontaneous (Y≈0.75-0.88) real headroom while still keeping the LOCKED band's floor (oscillation, Y≈0.675) and resting TYPE_COLOR tissue (Y≈0.44-0.48) safely non-bloom on either side."
  - "Strength eased 0.7 -> 0.6 since more identity hues now sit near the same luminance neighborhood as HOT than before the redesign; a lighter strength keeps per-event glow restrained rather than washing out once several hues can cross the (lowered) gate."
  - "Radius left unchanged at 0.4 — halo spread has no luminance-driven reason to change; kept surgical."
  - "Renderer tone-mapping/exposure left at THREE default (NoToneMapping, exposure=1) rather than adding an explicit ACESFilmic/exposure setter — introducing a global tone-mapping curve is a bigger, unverified behavioral change than this plan's evidence warrants; documented the decision and the exact knob location (Graph.renderer().toneMapping / .toneMappingExposure) at the scene.background color-management comment site in graph.js so the founder can turn it on at the Stage-2 checkpoint (57-07) if bloom + motion-profile tuning together still needs it."

patterns-established:
  - "PROVISIONAL / Stage-2 (57-07) inline comment convention on bloom composer args, matching the existing constants.js PROVISIONAL/LOCKED JSDoc convention from 57-02/57-03."

requirements-completed: [VIZ-PAL-06]

# Metrics
duration: ~20min
completed: 2026-07-03
---

# Phase 57 Plan 05: Bloom + Exposure Calibration Surface Summary

**Recalibrated UnrealBloomPass threshold/strength (0.75/0.7 -> 0.72/0.6) against the D-02 luminance-banded identity palette using the bloom shader's own Rec.709 formula, and documented (without changing) the renderer exposure/tone-mapping knob in graph.js for the Stage-2 founder tune.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-07-03T17:29:26Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Bloom composer (`effects.js`) recalibrated with provisional threshold/strength values computed directly from the LOCKED D-02 luminance band, not guessed — `LuminosityHighPassShader.js`'s `luminance()` chunk is byte-for-byte the same Rec.709 dot product (0.2126/0.7152/0.0722) as the invariants test's metric, so the two are directly comparable
- Identified and fixed a razor-thin margin bug class before it shipped: under the OLD threshold (0.75), the new-palette HOT amber luminance (Y≈0.758) sat only ~0.008 above the gate — an easy flicker/regression waiting to happen once real opacity/blend variance during activation is in play
- Single global composer preserved (`Graph.postProcessingComposer()`, no second `EffectComposer`); `ctx.bloomPass` remains a live `UnrealBloomPass` reference for `stats.js` adaptive quality
- Renderer exposure/tone-mapping (D-13's other calibration lever) documented at the `graph.js` scene-background color-management comment site — left at THREE's default (`NoToneMapping`, exposure=1) since the bloom recalibration plus the existing luminance-banded palette already give the founder a workable baseline to tune live at Stage 2, and the knob is now clearly located for that session
- `npx tsc --noEmit` clean; full `npm test` — 171 files / 2582 tests passed, 1 file / 4 tests skipped (identical counts to the 57-02 baseline — no regressions)

## Task Commits

Each task was committed atomically:

1. **Task 1: Provisional bloom recalibration in effects.js (D-13/D-14)** - `9db3dbc` (feat)
2. **Task 2: Renderer tone-mapping/exposure hook (D-13, if needed)** - `57050ed` (docs)

## Files Created/Modified

- `src/viz/modules/effects.js` - `UnrealBloomPass` threshold `0.75 -> 0.72`, strength `0.7 -> 0.6` (radius unchanged at `0.4`); corrected the stale `HOT = 0xffe08a, luminance ≈ 0.88` comment to the actual current `HOT` value (`0xffb866`, Y≈0.758); all three constructor args now carry inline PROVISIONAL/Stage-2 (57-07) comments plus the luminance-band reasoning
- `src/viz/modules/graph.js` - Added a comment block at the `Graph.scene().background` site documenting the D-13 exposure/tone-mapping calibration surface: left at THREE default for this plan, with the exact `Graph.renderer().toneMapping` / `.toneMappingExposure` knob location recorded for Stage-2. No behavior change; `BG_COLOR`, hull material, `TYPE_COLOR`, and additive trace blending untouched.

## Decisions Made

See `key-decisions` in frontmatter — summarized: threshold eased down (not up) based on a direct Rec.709 luminance computation showing the old gate left HOT amber with almost no margin under the new palette; strength eased to keep the wider in-band bloom set restrained; radius left untouched (no luminance-driven reason to touch it); renderer tone-mapping/exposure deliberately left at default rather than introducing an unverified global tone-mapping curve, with the knob documented for the Stage-2 founder session instead.

## Deviations from Plan

None — plan executed exactly as written. Task 2 took the plan's explicitly-offered "document default, don't set" branch rather than adding an explicit tone-mapping/exposure setter; this is a discretion the plan itself grants ("If the OutputPass default tone-mapping is sufficient and no explicit exposure setter is needed, add a short comment...").

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Bloom composer and renderer exposure calibration surfaces are both provisioned and clearly marked PROVISIONAL/Stage-2 for the founder's closing tuning session (57-07), alongside the motion-profile work landing in parallel plans (57-04, 57-06)
- Single global composer (D-14) and all locked surfaces (`BG_COLOR`, hull material, `TYPE_COLOR`, additive blending) remain untouched and verified via grep/diff
- No blockers for 57-06 or 57-07

## Threat Flags

None — this plan only changes three numeric `UnrealBloomPass` constructor arguments and adds documentation comments (`src/viz/modules/effects.js`, `src/viz/modules/graph.js`). No new network endpoints, auth paths, file-access patterns, or schema changes. Matches the plan's own threat register (T-57-06 double-composer/selective-bloom regression: mitigated — single composer verified via grep; T-57-SC: n/a, no package installs).

## Known Stubs

None — no stubs introduced.

## Self-Check: PASSED

- `src/viz/modules/effects.js` - FOUND, `new UnrealBloomPass` args `0.6, 0.4, 0.72` present, `ctx.bloomPass =` retained
- `src/viz/modules/graph.js` - FOUND, exposure/tone-mapping comment present at the scene.background site
- Commit `9db3dbc` - FOUND in git log
- Commit `57050ed` - FOUND in git log
- `npx tsc --noEmit` - clean (verified this session)
- `npm test` - 171 passed / 1 skipped, 2582 tests passed / 4 skipped (verified this session)

---
*Phase: 57-viz-activity-palette-redesign*
*Completed: 2026-07-03*
