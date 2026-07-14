---
phase: 60-settings-stats-depth
plan: 07
subsystem: ui
tags: [svg, viz, charts, responsive, resize, gap-closure]

# Dependency graph
requires:
  - phase: 60-02
    provides: charts.js SVG primitives (line/bar/axis/legend/attachHover) + CR-01 hover coordinate conversion
  - phase: 60-03
    provides: Usage tab chart suite (burn chart, per-feature/per-model splits)
  - phase: 60-04
    provides: Brain Health tab chart suite (node growth, kind mix, recon/tombstone, judge activity, episodes)
provides:
  - True responsive chart rendering on both Usage and Brain Health tabs — 1 internal SVG unit == 1 rendered pixel at any window width, closing founder UAT GAP-1
  - measureChartWidth() helper deriving usable chart width from the tab container's clientWidth minus .chart-card's padding/border
  - Debounced (200ms) window-resize re-render of the active tab from a per-tab cached payload, no re-fetch, "as of" stamp untouched
affects: [phase-60-close, 60-08]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Measured-width SVG rendering: viewBox width set equal to an explicit px width attribute (not width:100%), so preserveAspectRatio=none never stretches — the invariant holds by construction rather than by CSS-layout coincidence"
    - "Per-tab last-fetched-payload cache read by a debounced resize handler for pure re-layout re-renders (no network, no data-freshness change)"

key-files:
  created: []
  modified:
    - src/viz/modules/stats-dashboard.js

key-decisions:
  - "createChartSvg sets an explicit pixel width attribute (String(width)) equal to the viewBox width, instead of keeping width:100% and relying on CSS layout to match the JS-computed measurement — removes any dependency on box-model math matching browser layout exactly"
  - "charts.js was left untouched — its CR-01 hover coordinate conversion (vb.width / rect.width) already degrades correctly to scaleX~=1 once viewBox width equals rendered width, per the plan's own interface note"
  - "Resize handler re-renders only the currently-active tab from cache; the inactive tab is left stale until its own next open/switch (matches the plan's 'only while isOpen' + 'CURRENT tab' scoping)"

patterns-established: []

requirements-completed: [GAP-1, D-05, D-06, D-07]

# Metrics
duration: 18min
completed: 2026-07-13
---

# Phase 60 Plan 07: Responsive Chart Rendering (GAP-1 Closure) Summary

**Replaced the fixed 760-unit viewBox-stretch rendering with true measured-width SVG rendering plus a debounced window-resize re-render backed by a per-tab data cache, on both Usage and Brain Health tabs.**

## Performance

- **Duration:** 18 min
- **Started:** 2026-07-13 (worktree agent spawn)
- **Completed:** 2026-07-13
- **Tasks:** 2/2
- **Files modified:** 1

## Accomplishments
- Every chart (burn, per-feature/per-model splits, node growth, kind mix, reconsolidations, tombstones, judge activity, episodes) now renders its SVG at the chart card's real measured pixel width — `viewBox` width and the SVG's `width` attribute are the same JS value by construction, so `preserveAspectRatio="none"` never stretches text or strokes regardless of window width
- Widening/narrowing the window re-renders the currently-active tab from cached data 200ms after resize settles, with no network re-fetch and no change to the "as of" stamp
- CR-01 (nearest-point hover) and CR-04 (cost-event marker tooltips) both continue to resolve correctly — `charts.js` was not modified; its existing `vb.width / rect.width` conversion degrades to ~1 automatically once viewBox width equals rendered width

## Task Commits

Each task was committed atomically:

1. **Task 1: Thread a measured chart width through every render function** - `8d25cd7` (feat)
2. **Task 2: Debounced resize re-render with a per-tab data cache** - `ddc69c4` (feat)

## Files Created/Modified
- `src/viz/modules/stats-dashboard.js` - removed the fixed `CHART_W = 760` constant; added `measureChartWidth(container)` (subtracts `.chart-card`'s 16px padding + 1px border, each side, floored at 320px); `createChartSvg` now sets an explicit pixel `width` equal to `viewBox` width; threaded `chartW` through `renderBurnChart`, `renderSplitBarChart`, `renderFeatureSplit`/`renderModelSplit`, `buildLineChartSvg`, `buildBarChartSvg`, and all six Brain Health chart render functions (including every `legend({x: chartW - N})` call site); added `lastUsageData`/`lastHealthData` per-tab cache set inside `load()`; added a single debounced (200ms) `window.addEventListener('resize', ...)` handler that re-renders only the active tab from cached data, with no fetch and no `stampAsOf()` call

## Decisions Made
- Set the SVG's `width` attribute to an explicit pixel value (matching `viewBox` width) rather than keeping `width:100%` — this makes the "viewBox width == rendered pixel width" invariant hold by definition, not by relying on the JS-computed measurement matching the browser's CSS box-model layout exactly.
- Left `charts.js` completely untouched, per the plan's own interface note — the CR-01 hover conversion already handles true-width rendering correctly since `scaleX = vb.width / rect.width` collapses to ~1.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- GAP-1 (responsive charts) is closed at the code level; automated verification (tsc + the three named viz test suites) is green.
- Sibling gap-closure plan 60-08 (Usage tab redesign, GAP-2) is being executed concurrently in its own worktree against `src/viz/server.ts` and `tests/viz-stats-routes.test.ts` — no file overlap with this plan.
- Outstanding: a founder live visual walkthrough (widen/narrow the window, confirm no stretch, confirm resize re-render) is still the authoritative acceptance signal for GAP-1 and should be folded into the phase's HUMAN-UAT re-verification pass.

---
*Phase: 60-settings-stats-depth*
*Completed: 2026-07-13*

## Self-Check: PASSED

- FOUND: `src/viz/modules/stats-dashboard.js`
- FOUND: `.planning/phases/60-settings-stats-depth/60-07-SUMMARY.md`
- FOUND commit: `8d25cd7` (Task 1)
- FOUND commit: `ddc69c4` (Task 2)
- FOUND commit: `cd14357` (this summary)
