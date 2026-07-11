---
phase: 60-settings-stats-depth
plan: 02
subsystem: ui
tags: [svg, charts, vanilla-js, viz, design-tokens]

# Dependency graph
requires:
  - phase: 59-hud-integration
    provides: HUD_CSS_TOKENS glass/radius/motion recipe + emitHudTokens() pattern this phase's chart-card token slots into
  - phase: 57-viz-activity-palette-redesign
    provides: KIND_COLOR/TYPE_COLOR luminance-equalized identity-hue palette + amber-exclusivity invariant (D-03(b))
provides:
  - COST_EVENTS array (dated cost-lever markers) + NEUTRAL_SERIES_RAMP (4-step non-activity chart color ramp) + chart-card CSS token in constants.js
  - src/viz/modules/charts.js — pure geometry helpers (niceTicks/linearScale/nearestPointIndex/fmtDate/fmtTokens) + SVG builders (line/bar/axis/legend/attachHover)
affects: [60-03, 60-04, 60-05, 60-06]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Hand-rolled inline-SVG chart primitives via createElementNS + setAttribute, textContent-only labels (T-44-19), zero chart library"
    - "Pure data-to-data geometry functions kept document-free so they unit-test in plain Node (mirrors reader.js's renderMarkdown precedent)"

key-files:
  created:
    - src/viz/modules/charts.js
    - tests/viz-charts-geometry.test.ts
  modified:
    - src/viz/modules/constants.js
    - tests/viz-frontend-static.test.ts

key-decisions:
  - "COST_EVENTS Phase-42 consolSkipThreshold marker date resolved from git history (commit e82afcb, 2026-06-25) instead of leaving a TBD placeholder"
  - "charts.js SVG builders take pre-scaled pixel-space points/rects from the caller (line/bar/axis/attachHover) rather than embedding scaling logic themselves — keeps the module a pure data-to-DOM transform layer, with niceTicks/linearScale as the separately-testable scaling primitives"
  - "fmtTokens re-implemented verbatim in charts.js rather than imported, since settings.js's fmtTokens is a private closure function, not exported"

patterns-established:
  - "Pattern: SVG_NS = 'http://www.w3.org/2000/svg' constant + createSvgNode(tag, attrs) internal helper for every builder in charts.js"
  - "Pattern: attachHover(svg, points, opts) returns {detach()} for lifecycle cleanup, mirroring reader.js's {stop,done,update} API-object convention for stateful DOM widgets"

requirements-completed: [D-05, D-06, D-07, D-08, D-11]

# Metrics
duration: 9min
completed: 2026-07-11
---

# Phase 60 Plan 02: Chart Foundations Summary

**Hand-rolled inline-SVG chart helper module (niceTicks/linearScale/nearestPointIndex + line/bar/axis/legend/hover builders via createElementNS) plus the COST_EVENTS + NEUTRAL_SERIES_RAMP shared constants — zero chart library, zero new dependency.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-07-11T20:13:36Z
- **Completed:** 2026-07-11T20:21:54Z
- **Tasks:** 2 completed
- **Files modified:** 4 (2 created, 2 modified)

## Accomplishments
- `COST_EVENTS`, `NEUTRAL_SERIES_RAMP`, and a `chart-card` `HUD_CSS_TOKENS` entry added to `constants.js`, amber-free, matching the file's existing JSDoc + section-banner convention
- `src/viz/modules/charts.js` created: 5 pure geometry/format helpers (document-free, Node-testable) + 5 SVG-DOM builders (`line`, `bar`, `axis`, `legend`, `attachHover`), all built via `createElementNS`/`setAttribute`, all dynamic text set via `.textContent`
- `tests/viz-charts-geometry.test.ts` created and run through a real RED→GREEN TDD cycle (13 assertions, all passing)

## Task Commits

Each task was committed atomically:

1. **Task 1: constants.js — COST_EVENTS, NEUTRAL_SERIES_RAMP, chart-card token** - `32c6802` (feat)
2. **Task 2: charts.js — hand-rolled inline-SVG chart helpers** - `c67fdf7` (test, RED) → `c1a36f3` (feat, GREEN)

**Plan metadata:** committed with this SUMMARY.md (see final commit)

## Files Created/Modified
- `src/viz/modules/constants.js` - Added `COST_EVENTS` array, `NEUTRAL_SERIES_RAMP` (4-step aubergine ramp), and `HUD_CSS_TOKENS['chart-card']`
- `src/viz/modules/charts.js` - New module: `niceTicks`, `linearScale`, `nearestPointIndex`, `fmtDate`, `fmtTokens` (pure); `line`, `bar`, `axis`, `legend`, `attachHover` (SVG builders); `SVG_NS` export
- `tests/viz-charts-geometry.test.ts` - New Node-side unit tests for the pure helpers + source-grep guards (no innerHTML, no amber literal, createElementNS present)
- `tests/viz-frontend-static.test.ts` - One-line exemption added to the existing external-URL security guard for the literal SVG XML namespace string (see Deviations)

## Decisions Made
- Resolved the Phase-42 `consolSkipThreshold` marker's exact date from git history (`e82afcb`, 2026-06-25) rather than leaving the plan's suggested `2026-06-XX` placeholder — the plan explicitly allowed either an exact date or an honest month label, and the exact commit date was findable.
- Kept `charts.js`'s SVG builders as pure "pixel-space data in → SVGElement out" functions (no embedded scale-fitting logic) so `niceTicks`/`linearScale` remain the single, independently-tested source of scaling behavior; downstream dashboard plans (60-03..06) compose them explicitly per chart.
- Re-implemented `fmtTokens`'s 1.2M/34.5k/plain thresholds verbatim in `charts.js` instead of importing from `settings.js`, since the existing implementation is a private function inside `settings.js`'s `initSettings` closure, not exported.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Security-guard false positive on the SVG XML namespace literal**
- **Found during:** Task 2 (charts.js implementation), full-suite verification pass
- **Issue:** `tests/viz-frontend-static.test.ts`'s "no external http(s) URLs across the corpus" guard flagged `charts.js`'s required `SVG_NS = 'http://www.w3.org/2000/svg'` constant as an external URL. This is the standard W3C XML namespace identifier required by `document.createElementNS()` — a string literal, never fetched over the network — and it was the first `http://` literal to appear anywhere in the module corpus, so the existing regex had no reason to exempt it before.
- **Fix:** Added a one-line, narrowly-scoped filter excluding exactly `'http://www.w3.org/2000/svg'` from the matched-URL list, with a comment explaining why. The CDN/phone-home guard is otherwise untouched — any other external URL still fails the test.
- **Files modified:** `tests/viz-frontend-static.test.ts`
- **Verification:** `npx vitest run tests/viz-frontend-static.test.ts` passes (all other security assertions in the same describe block still run and pass).
- **Committed in:** `c1a36f3` (part of Task 2's GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** The fix is a narrowly-scoped test exemption, not a weakening of the security guard's actual intent (CDN/phone-home prevention). No scope creep.

## Issues Encountered
None beyond the deviation above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `COST_EVENTS`, `NEUTRAL_SERIES_RAMP`, and `charts.js`'s full builder set are ready for 60-03..06 to import and wire against live `/stats/*` data.
- No blockers. The full existing test suite was run; the only failures (23 tests across 7 files: `adapter-capture`, `adapter-inject`, `episodic-dryrun-gate`, `eval-harness-smoke`, `locomo-harness`, `locomo-latency-curve`, `locomo-scorer`) are pre-existing CLI/subprocess/eval-harness tests unrelated to this plan's files — confirmed out of scope per the deviation rules' scope boundary, not touched.

## Self-Check: PASSED

- FOUND: src/viz/modules/charts.js
- FOUND: tests/viz-charts-geometry.test.ts
- FOUND: .planning/phases/60-settings-stats-depth/60-02-SUMMARY.md
- FOUND commit: 32c6802
- FOUND commit: c67fdf7
- FOUND commit: c1a36f3
