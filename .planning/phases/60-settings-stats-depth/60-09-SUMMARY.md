---
phase: 60-settings-stats-depth
plan: 09
subsystem: ui
tags: [viz, stats-dashboard, usage-tab, gap-closure, subscription-framing]

# Dependency graph
requires:
  - phase: 60-07
    provides: measureChartWidth()/createChartSvg() responsive-render infra and the per-tab resize-cache re-render path the redesigned tab reuses unchanged
  - phase: 60-08
    provides: GET /stats/usage `summary` (today/week/30d tokens, avg/day, retail-$, vs-typical framing, trend, heaviest day) and `lever_deltas` (one entry per COST_EVENT, full-span stable)
provides:
  - "Redesigned Usage tab: five-tile Display-28px stat row (today/week/30d/avg-day/retail-$) leading the tab"
  - "Subscription-limit framing block: today/week vs-typical share, trend arrow vs prior 7d, heaviest day — 'vs your typical' honest labeling, no fabricated quota"
  - "Visible 'Cost levers' card: one row per COST_EVENT with label/date/before-avg/after-avg/%-saved, replacing hover-only delta discovery"
  - "Collapsed 'Usage breakdown' card: per-feature + per-model splits folded into one compact swatch-labeled table pair, replacing the two former full chart cards"
  - "renderUsageTab final order: stat-tile row -> framing -> levers card -> burn chart (demoted) -> collapsed breakdown"
affects: [60-close, 60-HUMAN-UAT.md GAP-2 re-verification]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Table-based compact presentation for low-cardinality series data (per-feature/per-model swatch rows) instead of a second SVG chart card — trivially responsive, no chartW-driven geometry needed"
    - "'vs your typical' baseline framing computed entirely server-side (60-08); client only formats/labels, never computes a ratio or fabricates a number"

key-files:
  created: []
  modified:
    - src/viz/modules/stats-dashboard.js
    - src/viz/css/styles.css

key-decisions:
  - "Removed renderHeadline (single retail-$ tile) entirely, replaced by renderStatTileRow (5 tiles) — no dual-headline transition state was kept, since the plan's own interface note said 'REPLACE'"
  - "Trend-pct display uses Math.abs(trend_pct) paired with the directional arrow (▲/▼/→) rather than showing a signed negative number next to a down-arrow, which would read as redundant/confusing"
  - "'down' trend direction (usage shrinking) maps to --text-stat (green) as the positive signal; 'up'/'flat' stay neutral --text-body-mauve — never amber, per D-08/UI-SPEC Color contract"
  - "Collapsed breakdown built as two compact swatch-labeled tables (not a single stacked bar) — trivially responsive without needing the 60-07 measured-width path, per the plan's own 'prefer a simple table' guidance"
  - "renderSplitBarChart (the shared per-feature/per-model SVG bar-chart builder) was deleted as dead code once its only two callers were removed — kept buildBarChartSvg/buildLineChartSvg untouched since Brain Health charts still use them"

patterns-established: []

requirements-completed: [GAP-2a, GAP-2b, GAP-2c, GAP-2d, D-08, D-09, D-14]

# Metrics
duration: 15min
completed: 2026-07-13
---

# Phase 60 Plan 09: Usage Tab Redesign — Stat Tiles, Framing, Levers Card, Collapsed Breakdown Summary

**Rebuilt the Usage tab client-side to lead with a five-tile Display-28px stat row + "vs your typical" subscription framing, surface a visible Cost-levers table (one row per COST_EVENT), and collapse the per-feature/per-model split into one compact card — burn chart demoted below, all consuming the `summary`/`lever_deltas` fields shipped by 60-08.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-07-13T20:08:00-04:00 (worktree agent spawn)
- **Completed:** 2026-07-13T20:11:20-04:00
- **Tasks:** 3/3
- **Files modified:** 2

## Accomplishments
- Usage tab now opens with a five-tile stat row (today/this-week/30d tokens, avg tokens/day, retail-$) reusing the `.stats-headline-tile` Display-28px treatment verbatim, plus a "vs your typical" framing block (today/week share, trend arrow vs prior 7d, heaviest day this week) — no fabricated quota number, no amber, textContent-only
- A visible "Cost levers" card lists one row per `COST_EVENT` (label, date, before-avg/day, after-avg/day, %-saved) sourced from the new `lever_deltas` field — the burn-chart's dashed markers and their before/after hover tooltip are untouched, the card supplements rather than replaces them
- Per-feature and per-model splits collapsed from two full SVG chart cards into one compact "Usage breakdown" card (two swatch-labeled tables), keeping `FEATURE_ORDER`/`NEUTRAL_SERIES_RAMP` coloring
- Final `renderUsageTab` order: stat-tile row → framing → levers card → burn chart (demoted) → collapsed breakdown
- All new CSS (`.stats-tile-row`, `.stats-framing`, `.stats-levers-*`, `.stats-breakdown-*`) is flat with no `backdrop-filter` — D-14 invariant test (`viz-activity-palette-invariants.test.ts`) stays green

## Task Commits

Each task was committed atomically:

1. **Task 1: Stat-tile row + subscription-limit framing on top** - `decb0d2` (feat)
2. **Task 2: Visible levers card (one row per COST_EVENT)** - `e44cf60` (feat)
3. **Task 3: Collapse per-feature + per-model into one compact presentation + CSS** - `abf0ee3` (feat)

## Files Created/Modified
- `src/viz/modules/stats-dashboard.js` - Removed `renderHeadline`/`renderSplitBarChart`/`renderFeatureSplit`/`renderModelSplit`; added `renderStatTileRow`, `renderFraming`, `renderLeversCard`, `renderUsageBreakdown`; reordered `renderUsageTab` to tiles → framing → levers → burn → breakdown
- `src/viz/css/styles.css` - Added `.stats-tile-row`, `.stats-framing`/`.stats-framing-row`, `.stats-levers-table`/`.stats-levers-row`/`.stats-levers-head`/`.stats-levers-cell`, `.stats-breakdown-group-title`/`.stats-breakdown-table`/`.stats-breakdown-row`/`.stats-breakdown-swatch`/`.stats-breakdown-label`/`.stats-breakdown-value` — all flat surfaces reusing existing tokens, no backdrop-filter

## Decisions Made
- Deleted `renderHeadline` outright (not kept as a fallback) since the plan explicitly says "Replace" and the five-tile row fully subsumes its retail-$/token readout
- Trend display shows the magnitude (`Math.abs`) next to a directional arrow rather than a signed percentage, avoiding a confusing "-15% ▼" double-negative read
- Built the collapsed breakdown as two compact tables rather than a single stacked SVG bar — simpler, trivially responsive, and matches the plan's stated preference for "a table is trivially responsive"
- Removed the now-orphaned `renderSplitBarChart` helper (only caller was the two removed split functions) rather than leaving it as dead code

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed a stale comment that referenced the just-removed `renderFeatureSplit`/`renderModelSplit` function names**
- **Found during:** Task 3 verification (the acceptance-criteria grep `renderModelSplit|renderFeatureSplit` returns no match)
- **Issue:** A doc-comment on `buildLineChartSvg` referenced the two removed function names as a design precedent, which would have made the "two-card split is gone" grep check fail even though the functions themselves were correctly deleted
- **Fix:** Reworded the comment to describe the same rationale (axis/legend called at each chart's own source line) without naming the removed functions
- **Files modified:** `src/viz/modules/stats-dashboard.js`
- **Verification:** `grep -E "renderModelSplit|renderFeatureSplit" src/viz/modules/stats-dashboard.js` returns no match; `npx tsc --noEmit` clean; named test suites green
- **Committed in:** `abf0ee3` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — a stale comment, not a functional bug)
**Impact on plan:** Cosmetic-only fix caught by the plan's own acceptance-criteria grep; no scope creep.

## Issues Encountered
None beyond the deviation above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- GAP-2 (a)(b)(c)(d) is closed at the code level: `npx tsc --noEmit` clean, and `tests/viz-frontend-static.test.ts` + `tests/viz-charts-geometry.test.ts` + `tests/viz-activity-palette-invariants.test.ts` + `tests/viz-settings-panel.test.ts` all green (126/126 passed across those 4 files)
- Full-suite run at close: 2644 passed / 9 skipped / 23 failed — all 23 failures are the same pre-existing eval-harness/adapter/locomo worktree-environment artifacts noted in 60-08's SUMMARY (`adapter-capture`, `adapter-inject`, `episodic-dryrun-gate`, `eval-harness-smoke`, `locomo-harness`, `locomo-latency-curve`, `locomo-scorer`), none touching `src/viz/modules/stats-dashboard.js` or `src/viz/css/styles.css`
- Sibling gap-closure plan 60-07 (responsive chart rendering, GAP-1) and 60-08 (server `summary`/`lever_deltas` fields) were already landed on this worktree's base commit — this plan is the client-side redesign consuming both
- Outstanding: a founder live visual walkthrough of the redesigned Usage tab (tile row, framing copy, levers table, collapsed breakdown) is still the authoritative acceptance signal for GAP-2 and should be folded into the phase's HUMAN-UAT re-verification pass alongside GAP-1

---
*Phase: 60-settings-stats-depth*
*Completed: 2026-07-13*

## Self-Check: PASSED

- FOUND: `src/viz/modules/stats-dashboard.js`
- FOUND: `src/viz/css/styles.css`
- FOUND: `.planning/phases/60-settings-stats-depth/60-09-SUMMARY.md`
- FOUND commit: `decb0d2` (Task 1)
- FOUND commit: `e44cf60` (Task 2)
- FOUND commit: `abf0ee3` (Task 3)
- FOUND commit: `9f9301b` (this summary)
