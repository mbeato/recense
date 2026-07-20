---
phase: 60-settings-stats-depth
plan: 04
subsystem: ui
tags: [svg-charts, vanilla-js, viz, stats-dashboard, brain-health]

requires:
  - phase: 60-01
    provides: "GET /stats/brain-health (node growth, kind mix, reconsolidations/tombstones per day, judge activity, episodes, derived last_sleep_pass) — 60-01-SUMMARY.md"
  - phase: 60-02
    provides: "charts.js (line/bar/axis/legend/attachHover + niceTicks/linearScale) and constants.js's KIND_COLOR/TYPE_COLOR identity-hue palette — 60-02-SUMMARY.md"
  - phase: 60-03
    provides: "stats-dashboard.js shell (tab/range/refresh state, #stats-health-tab placeholder container, chart-card/makeCard DOM shape) — 60-03-SUMMARY.md"
provides:
  - "Brain Health tab fully live in src/viz/modules/stats-dashboard.js: node growth (focal), kind mix, reconsolidations/day, tombstones/day, judge activity, episodes pending/consolidated, and an honest last-sleep-pass tile"
affects: [60-05, 60-06]

tech-stack:
  added: []
  patterns:
    - "axis()/legend() called at each chart's own distinct source line (not hidden inside a shared render closure) so every chart's axis/legend coverage stays independently grep-verifiable — mirrors 60-03's renderFeatureSplit/renderModelSplit precedent; pure geometry (buildLineChartSvg/buildBarChartSvg) is shared, axis/legend/hover wiring is not"

key-files:
  created: []
  modified:
    - src/viz/modules/stats-dashboard.js

key-decisions:
  - "judge_activity chart rendered as a two-bar fires-vs-escalated comparison instead of the plan's sketched dual-line time chart — the live GET /stats/brain-health response (60-01) returns judge_activity as aggregate {fires, escalation_rate} scalars, not a dated per-day series, so there is no date axis to plot; escalated count is derived honestly from escalation_rate (fires * rate) and the rate itself is surfaced in the legend label, with no fabricated dates"
  - "kind_mix consumed as the server's actual object shape ({entity,fact,schema,doc,insight}: count) rather than the plan interfaces block's array-of-{type,count} sketch — confirmed against the live server.ts route handler (CLAUDE.md: live code over planning docs)"
  - "Brain-Health tab always fetches on every tab activation (not just the very first) — simpler than adding a load-once cache, and the plan's own trigger language ('first activation and on refresh') is satisfied either way; token-guarded against superseded in-flight fetches via the existing loadToken counter"
  - "Range-switcher pills are not wired to Brain-Health fetches — GET /stats/brain-health ignores query parameters entirely and returns full-history data, so re-fetching on a range-pill click while on the Health tab would be a no-op against the real route; pills stay usage-tab-only in effect"
  - "Last-sleep-pass freshness threshold (healthy vs. stale tile color) set to a fixed 24h window (Claude's Discretion — no per-user sleepFrequencyHours is threaded through this fetch); does not affect the copy, only the --text-stat/--error-text color choice"

requirements-completed: [D-03, D-06, D-07, D-08, D-13, D-14, D-15]

duration: ~15min
completed: 2026-07-11
---

# Phase 60 Plan 04: Brain Health Tab Summary

**Completes the stats takeover's second dashboard: the Brain Health tab renders all six D-14 metric groups (node growth, kind mix, reconsolidations/tombstones per day, judge activity, episode backlog, last sleep-pass) from a single `GET /stats/brain-health` fetch, in Phase-57 identity hues, with an axis+legend on every chart and an honest never-fabricated last-sleep-pass readout.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-07-11
- **Tasks:** 2 completed
- **Files modified:** 1

## Accomplishments
- `GET /stats/brain-health` is now fetched from `stats-dashboard.js`, routed through the existing `load()`/`setTab()` plumbing (60-03) alongside the Usage tab's own fetch, sharing the same "as of" timestamp stamp and `loadToken` supersession guard
- Node growth renders as the tab's focal chart (largest card, top of tab) in `KIND_COLOR.new_node`, with the verbatim D-13 approximation caption and D-07 nearest-point hover
- Kind mix renders as a 5-series grouped bar (fact/entity/schema/doc/insight) in their locked `TYPE_COLOR`/`KIND_COLOR` identity hues, always legending all five kinds regardless of individual zero counts
- Reconsolidations/day and tombstones/day render as line charts in `KIND_COLOR.reconsolidation`/`KIND_COLOR.oscillation` with D-07 hover
- Judge activity renders as a fires-vs-escalated comparison bar (see Decisions Made — the live route returns aggregate totals, not a per-day series) and episodes pending-vs-consolidated as a paired bar, both with their own axis+legend
- The last-sleep-pass tile (not a chart, no axis/legend) reads `status`/`ts`/`duration_ms` and renders a locally-computed relative time + duration, or `no sleep pass has run yet` when no pass has ever run — never a fabricated success literal
- Empty-brain state (`No brain activity yet` / body copy) and fetch-error state (`could not load brain-health stats`) replace the chart suite rather than rendering a broken/empty chart shell
- Every one of the seven new chart cards (node-growth, kind-mix, recon, tombstone, judge-activity, episodes — last-sleep-pass is a readout, not a chart) calls `axis()` and `legend()` at its own distinct source line; total in-file `axis(` call sites: 18, `legend(` call sites: 11 — both comfortably above the plan's cumulative Usage+Brain-Health thresholds

## Task Commits

Each task was committed atomically:

1. **Task 1: Brain-Health fetch + node growth / kind mix / recon+tombstone charts** - `e2cdddb` (feat)
2. **Task 2: Judge activity, episode backlog, last-sleep-pass tile** - `41568e5` (feat)

## Files Created/Modified
- `src/viz/modules/stats-dashboard.js` - Added `fetchBrainHealth()`, re-routed `load()`/`setTab()` to fetch Brain Health on tab activation + refresh, and the full render path: `isBrainHealthEmpty()`, `buildLineChartSvg()`/`buildBarChartSvg()` pure-geometry helpers, `renderNodeGrowthChart()`, `renderKindMixChart()`, `renderReconChart()`, `renderTombstoneChart()`, `renderJudgeActivityChart()`, `renderEpisodesChart()`, `renderLastSleepPassTile()` (+ `relativeTimeFromMs()`/`formatDurationMs()` helpers), and `renderHealthTab()` orchestrating all seven cards plus the empty/error states

## Decisions Made
See `key-decisions` in frontmatter above (judge-activity chart shape, kind_mix object shape, fetch-on-every-activation, range pills not wired to Brain Health, 24h staleness threshold).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Plan's judge-activity dual-line chart assumed a time-series shape the live route doesn't return**
- **Found during:** Task 2 (judge activity, episode backlog, last-sleep-pass tile) — read_first review of `server.ts`'s actual `/stats/brain-health` handler before implementing
- **Issue:** The plan's `<action>` text describes a "judge-activity chart showing fires (count, solid cyan) with escalation rate rendered as a dashed secondary line ... axis Y (min 0) + X (MMM-D)" — implying a dated per-day series. The actual 60-01-shipped route returns `judge_activity: { fires, escalation_rate }` as two aggregate running totals (see `src/viz/server.ts` lines ~1542-1544), with no date dimension anywhere in the payload. Building the plan's literal dual-line chart would require either fabricating dates or silently rendering `NaN`/garbled X-axis labels.
- **Fix:** Rendered a two-bar comparison instead — `fires` (cyan) vs. `escalated` (derived as `fires * escalation_rate`, slate), both in count units so they sit on one honest Y-axis, with the escalation percentage disclosed in the legend label. Still carries its own `axis()`+`legend()` call site per the plan's acceptance criteria, still reads `escalation_rate` (satisfying the "escalation" grep requirement), never fabricates a date.
- **Files modified:** `src/viz/modules/stats-dashboard.js`
- **Verification:** `npx tsc --noEmit` clean; `npx vitest run tests/viz-frontend-static.test.ts` (46/46 pass); `grep -n "escalation" src/viz/modules/stats-dashboard.js` matches.
- **Committed in:** `41568e5` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — plan/live-API shape mismatch)
**Impact on plan:** Necessary — the plan's literal chart shape is not constructible from the shipped `/stats/brain-health` contract without inventing data. The fix stays within this plan's own file, preserves every acceptance criterion (axis/legend call sites, escalation-rate surfaced, no amber), and does not touch the 60-01 route (out of this plan's `files_modified` scope).

## Issues Encountered
- Two of my own source comments briefly tripped the plan's own acceptance-criteria greps as false positives (a comment using the literal word "amber" while explaining the amber-exclusivity invariant; a comment quoting `'ok'`/`'success'` while explaining that no such literal appears in the render path). Both were rephrased to avoid the literal substrings before committing — no functional change, caught and fixed pre-commit via the same grep commands listed in each task's `<acceptance_criteria>`.

## User Setup Required

None — no external service configuration required.

## Known Stubs

None. Every chart card and the last-sleep-pass tile render from live `/stats/brain-health` response fields; no hardcoded/placeholder data reaches the DOM.

## Next Phase Readiness
- Both stats-dashboard tabs (Usage from 60-03, Brain Health from this plan) are fully live against real ledger/consolidation-event/episode data — the phase is functionally complete pending navigation wiring
- 60-05 (settings-panel entry point + ⌘K palette command) can call `ctx.openStatsDashboard('health')` directly; no further work needed in `stats-dashboard.js` itself for that wiring
- No blockers

---
*Phase: 60-settings-stats-depth*
*Completed: 2026-07-11*
