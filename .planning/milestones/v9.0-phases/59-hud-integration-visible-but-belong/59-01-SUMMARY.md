---
phase: 59-hud-integration-visible-but-belong
plan: 01
subsystem: ui
tags: [css-custom-properties, design-tokens, viz, three.js, jetbrains-mono, vanilla-css]

# Dependency graph
requires: []
provides:
  - HUD_CSS_TOKENS + palette/idle scalar exports in constants.js (single authored source)
  - emitHudTokens() runtime :root CSS-custom-property injection (css-tokens.js)
  - JetBrains Mono HUD @font-face wired in styles.css
  - D-11 motion-token + D-10 single-source machine-checked invariants
affects: [59-02, 59-03, 59-04, 59-05, 59-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "constants.js stays runtime-behaviour-free; css-tokens.js is the sole JS→CSS consumer via native ESM import (mirrors server.ts's parseSchedulerScalars regex-parse pattern, but no regex needed since constants.js is already plain JS)"
    - "Runtime <style id=\"hud-tokens\"> :root injection at boot, guarded against double-injection, so styles.css can consume var(--glass-*)/var(--radius-*)/var(--motion-*) once Plan 02 migrates literals"

key-files:
  created: [src/viz/modules/css-tokens.js]
  modified: [src/viz/modules/constants.js, src/viz/css/styles.css, src/viz/modules/app.js, tests/viz-activity-palette-invariants.test.ts]

key-decisions:
  - "HUD_CSS_TOKENS values reproduced verbatim from 59-UI-SPEC.md's Glass Construction Recipe / Radius Tokens / Motion Tokens tables — no independent tuning"
  - "emitHudTokens() called immediately before initStats(ctx) in app.js's boot sequence per the plan's explicit ordering requirement"
  - "D-10 single-source lock scans styles.css for --glass-/--radius-/--motion-/--ease- DECLARATIONS only (not var(--...) usages), so Plan 02's migration to var() references will not trip this test"

requirements-completed: [D-11, D-14]

duration: 20min
completed: 2026-07-06
---

# Phase 59 Plan 01: HUD Token Vocabulary + Runtime CSS Emission Summary

**HUD_CSS_TOKENS single-source object in constants.js + emitHudTokens() runtime `:root` injector + vendored JetBrains Mono @font-face, locked by D-11/D-10 invariant tests**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-07-06T02:50:56Z
- **Tasks:** 3 completed
- **Files modified:** 5 (1 created, 4 modified)

## Accomplishments
- `HUD_CSS_TOKENS` (glass/radius/motion recipe) + `HUD_IDLE_TIMEOUT_MS`/`RECEDE_GHOST_OPACITY`/`PALETTE_*` scalars exported from `constants.js` as the single authored home for every downstream Phase-59 CSS plan
- New `css-tokens.js` module's `emitHudTokens()` builds a `:root { --key: value; ... }` string from `HUD_CSS_TOKENS` and injects a double-injection-guarded `<style id="hud-tokens">` into `document.head`
- Vendored `JetBrains Mono HUD` wired as a real `@font-face` at the top of `styles.css` (zero CDN, matches `labels.js`'s existing vendored-font discipline)
- `app.js` calls `emitHudTokens()` immediately before `initStats(ctx)` so the `:root` vars exist before any styled DOM renders
- D-11 (motion-token values) + D-10 (single-source rule) invariants added to the existing `tests/viz-activity-palette-invariants.test.ts` harness — 38/38 tests green, all prior D-10/D-02/D-06/D-15 locks unbroken

## Task Commits

Each task was committed atomically:

1. **Task 1: Define HUD design tokens + scalars in constants.js** - `cac079f` (feat)
2. **Task 2: css-tokens.js emission module + @font-face + app.js boot wiring** - `cc18dc4` (feat)
3. **Task 3: D-11 motion-token + D-10 single-source invariants** - `8ebc69c` (test)

_This plan's Task 3 (tdd="true") locks an invariant against implementation already built in Tasks 1-2 of this same plan (there was no separate production-code GREEN step to run — the test file was the only file this task touched), so it landed as a single test commit rather than a RED→GREEN pair._

## Files Created/Modified
- `src/viz/modules/constants.js` - Adds `HUD_CSS_TOKENS` object + `HUD_IDLE_TIMEOUT_MS`, `RECEDE_GHOST_OPACITY`, `PALETTE_DEBOUNCE_MS`, `PALETTE_CAP_NODES`, `PALETTE_CAP_TOPICS`, `PALETTE_CAP_COMMANDS`, `PALETTE_Z_INDEX`, `PALETTE_BACKDROP_Z_INDEX` scalar exports; no runtime behaviour added (header ban respected)
- `src/viz/modules/css-tokens.js` (new) - `emitHudTokens()`: imports `HUD_CSS_TOKENS` from `constants.js`, builds the `:root` var-block string, injects a guarded `<style id="hud-tokens">`
- `src/viz/css/styles.css` - Adds the `@font-face` rule for `'JetBrains Mono HUD'` at the top of the file (`src: url('../vendor/fonts/JetBrainsMono-Regular.ttf') format('truetype')`)
- `src/viz/modules/app.js` - Imports `emitHudTokens` from `./css-tokens.js`; calls it as the first boot action, immediately before `initStats(ctx)`
- `tests/viz-activity-palette-invariants.test.ts` - Adds `readCssTokensJs()`/`readStylesCss()` readers plus `describe('D-11 shared motion tokens', ...)` and `describe('D-10 HUD token single source', ...)` blocks

## Decisions Made
None beyond what's captured in `key-decisions` above — plan executed exactly as written against the UI-SPEC's pinned values.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Plan 02's exhaustive 89-literal CSS migration can now consume `var(--glass-*)`, `var(--radius-*)`, `var(--motion-*)` freely — the emission pipeline is proven end-to-end and the D-10 single-source test already guards against re-introducing a hardcoded literal during that migration
- `JetBrains Mono HUD` is available as a CSS font-family for any downstream plan's instrument-panel typography (chip counter, palette input, rail state)
- No blockers

---
*Phase: 59-hud-integration-visible-but-belong*
*Completed: 2026-07-06*

## Self-Check: PASSED

All created/modified files found on disk; all 3 task commits (cac079f, cc18dc4, 8ebc69c) verified present in git log.
