---
phase: 60-settings-stats-depth
plan: 03
subsystem: ui
tags: [svg-charts, vanilla-js, viz, stats-dashboard, cost-dashboard]

requires:
  - phase: 60-01
    provides: "GET /stats/usage?window= (windowed daily/weekly buckets, per-feature/per-model totals, retail-$, cost_event_deltas) — 60-01-SUMMARY.md"
  - phase: 60-02
    provides: "charts.js (line/bar/axis/legend/attachHover + niceTicks/linearScale/fmtDate/fmtTokens) and constants.js's COST_EVENTS/NEUTRAL_SERIES_RAMP/chart-card token — 60-02-SUMMARY.md"
provides:
  - "#stats-view full-window takeover host (index.html) — Usage/Brain Health tabs, 7d/30d/90d/all-time range pills, refresh + as-of stamp, close — glass-free flat surface (D-14 invariant untouched)"
  - "src/viz/modules/stats-dashboard.js — initStatsDashboard(ctx): open/close plumbing replacing the 3D brain/corpus, ctx.openStatsDashboard/closeStatsDashboard/isStatsDashboardOpen, tab/range/refresh state, complete Usage tab (burn chart + cost-event markers + per-feature/per-model splits + retail-$ headline)"
  - "app.js wiring: initStatsDashboard(ctx) live after initSettings(ctx)"
affects: [60-04, 60-05, 60-06]

tech-stack:
  added: []
  patterns:
    - "Responsive inline SVG via a fixed internal viewBox coordinate system + width:100% (no DOM measurement needed at render time) — new pattern for chart cards, not used elsewhere in the viz frontend yet"
    - "Load-token guard (loadToken counter) on the async fetch→render cycle to discard a superseded response when the user switches range/refresh mid-flight — mirrors reader.js's loadToken cross-node clobber guard"

key-files:
  created:
    - src/viz/modules/stats-dashboard.js
  modified:
    - src/viz/index.html
    - src/viz/css/styles.css
    - src/viz/modules/app.js
    - src/viz/server.ts

key-decisions:
  - "#stats-view CSS block placed at the very end of styles.css (after every other backdrop-filter declaration in the file) rather than near its structural sibling #corpus-graph — keeps the block itself trivially inspectable as backdrop-filter-free without depending on the file's overall backdrop-filter usage order"
  - "Other-view hiding (D-02) uses inline style.visibility (not the classed opacity-fade system #corpus-graph's own transition.js owns) — avoids fighting transition.js's internal state machine for the brain⇄corpus camera move; #stats-view has no camera choreography of its own, so a simple hide/show is correct and sufficient"
  - "Cost-event markers (D-10/D-11) render only against daily buckets — the client can't precisely align a specific COST_EVENTS date to a weekly bucket boundary, so all-time view intentionally omits markers rather than mis-positioning them (documented scope-narrowing, consistent with the UI-SPEC's own Claude's-Discretion precedent for D-06 time-range scrubbing)"
  - "renderSplitBarChart() returns its <svg> instead of appending its own legend internally — lets renderFeatureSplit/renderModelSplit each call legend() at their own call site, producing 3 distinct axis()/legend() call sites in source (burn + per-feature + per-model) while keeping the geometry/axis code DRY"

patterns-established:
  - "Pattern: chart-card DOM = .chart-card > .chart-card-head > .chart-card-title, then an <svg viewBox=...> appended directly to the card — Brain Health tab (60-04) should reuse makeCard()/createChartSvg()'s shape rather than inventing new card markup"

requirements-completed: [D-01, D-02, D-03, D-06, D-07, D-08, D-09, D-10, D-12, D-15]

duration: ~35min
completed: 2026-07-11
---

# Phase 60 Plan 03: Stats Dashboard Shell + Usage Tab Summary

**Full-window `#stats-view` takeover (glass-free, D-14-safe) replacing the 3D brain/corpus, with a live Usage tab rendering real `/stats/usage` ledger data — daily/weekly burn line (focal chart), dated cost-event markers with before/after deltas, per-feature and per-model bar splits, and an honestly-labelled retail-$ headline — every chart carrying a Y/X axis and a top-right legend via the hand-rolled `charts.js` SVG primitives.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-07-11T20:35:00Z (approx.)
- **Completed:** 2026-07-11T20:46:00Z
- **Tasks:** 3 completed
- **Files modified:** 5 (1 created, 4 modified)

## Accomplishments
- `#stats-view` full-window takeover host live in `index.html`, styled as a near-opaque flat surface (`var(--surface-index-panel)`, z-index:6, above `#corpus-graph`) with zero `backdrop-filter` anywhere on the new surface or its chart cards — the D-14-C backdrop-filter allow-list test stays green untouched
- `stats-dashboard.js` (436 lines) implements the full open/close/tab/range/refresh lifecycle mirroring the reader.js/settings.js/corpus.js precedents, and exposes `ctx.openStatsDashboard`/`closeStatsDashboard`/`isStatsDashboardOpen`, wired into `app.js` right after `initSettings(ctx)`
- The Usage tab renders from real `GET /stats/usage?window=` data: retail-$ headline (`toFixed(4)`, verbatim D-09 copy), the focal daily/weekly burn line chart with dashed cost-event markers (hover reveals the server-computed before/after avg-daily-burn delta via the shared `#tooltip`), and per-feature/per-model bar splits — every one of the three charts carries its own Y-axis (min 0, nice ticks), X-axis, and top-right legend
- Empty ledger and fetch-failure states render the exact UI-SPEC copy (`no usage recorded yet` / `could not load usage stats`) instead of a broken chart shell; the Brain Health tab renders a placeholder only (60-04's responsibility) and this module never fetches `/stats/brain-health`

## Task Commits

Each task was committed atomically:

1. **Task 1: #stats-view markup + flat-surface CSS (no glass)** - `a1ce0fc` (feat)
2. **Task 2: stats-dashboard.js shell + app.js wiring** - `56019ec` (feat)
3. **Task 3: Usage tab rendering — burn + cost markers + splits + retail-$** - `3997b75` (feat, includes the server.ts weekly-bucket deviation below)

## Files Created/Modified
- `src/viz/modules/stats-dashboard.js` - New module: `initStatsDashboard(ctx)` — open/close/HUD-hide, tab state, range switcher, refresh+as-of stamp, `/stats/usage` fetch, full Usage tab chart suite (headline, burn chart, cost-event markers, per-feature/per-model splits), Brain Health placeholder
- `src/viz/index.html` - `#stats-view` host markup: tabs, range pills, refresh button, as-of span, close button, `#stats-usage-tab`/`#stats-health-tab` containers, sibling of `#corpus-graph`
- `src/viz/css/styles.css` - `#stats-view` full-window surface + header/tab/range-pill/chart-card/headline-tile/empty-error-state rules (all flat, no backdrop-filter); `#stats-view` added to the compact-hide `@media` block
- `src/viz/modules/app.js` - `import { initStatsDashboard }` + `initStatsDashboard(ctx)` call after `initSettings(ctx)`, before `initPalette(ctx)`
- `src/viz/server.ts` - (deviation, see below) `GET /stats/usage`'s weekly-bucket query now groups by a real Monday-start ISO-week date instead of a `%Y-%W` week-number string

## Decisions Made
- Placed the `#stats-view` CSS rule block at the very end of `styles.css` so it sits after every pre-existing `backdrop-filter` declaration in the file — keeps a simple "does this block declare backdrop-filter" check trivially correct without depending on relative ordering against unrelated panels
- Used inline `style.visibility` (not `#corpus-graph`'s classed opacity/`transition.js` camera-move system) to hide the brain/corpus while the takeover is open — `#stats-view` has no 3D camera choreography of its own, so a plain hide/show is correct and avoids fighting `transition.js`'s internal state machine
- Cost-event markers render only when `bucket_granularity === 'daily'` — the client cannot precisely align a specific `COST_EVENTS` date onto a weekly bucket boundary, so all-time view omits markers rather than mis-positioning them (a documented scope-narrowing default, consistent with the UI-SPEC's own precedent for D-06 time-range interactions)
- `renderSplitBarChart()` returns its `<svg>` rather than appending its own legend, so `renderFeatureSplit`/`renderModelSplit` each call `legend()` at their own call site — keeps the shared bar-chart geometry DRY while giving each of the three Usage charts (burn, per-feature, per-model) its own textually-distinct `axis()`/`legend()` call site

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `GET /stats/usage`'s weekly-bucket query grouped by a week-number, not a real date**
- **Found during:** Task 3 (Usage tab rendering — building the burn chart's X-axis/hover for `window=all`)
- **Issue:** `src/viz/server.ts`'s `stmtUsageWeeklyBuckets` (shipped by the parallel 60-01 plan) grouped rows by `strftime('%Y-%W', ts/1000, 'unixepoch')`, producing keys like `'2026-27'` — an ISO week *number*, not a parseable calendar date. `charts.js`'s `fmtDate()` (and this plan's own X-axis/hover code) calls `new Date(d)` on every bucket's `date` field; a `'2026-27'` string parses to `Invalid Date`, so every chart in the `all-time` range would render `NaN`/garbled X-axis labels and hover text — directly breaking this plan's own D-12 must-have ("all-time renders weekly buckets"). The UI-SPEC's Chart Construction Contract also explicitly expects the weekly tick to label "the bucket start date," which a week-number string cannot do.
- **Fix:** Changed the weekly bucket's `GROUP BY` key to a real Monday-start ISO-week date: `date(ts/1000,'unixepoch','-' || ((CAST(strftime('%w',ts/1000,'unixepoch') AS INTEGER)+6)%7) || ' days')` — same query shape (single `ts` cutoff bind, same three selected columns), just a different date expression for the GROUP BY key, consistent with the block's own comment ("a different GROUP BY key, no new query shape").
- **Files modified:** `src/viz/server.ts`
- **Verification:** Manually verified the SQLite date-modifier arithmetic against three reference dates spanning a full week (Mon/Wed/Sun all resolve to the same Monday); `npx vitest run tests/viz-stats-routes.test.ts` — 13/13 still pass (the existing weekly-bucket test only asserts `bucket_granularity==='weekly'` and `buckets.length>0`, not the exact date string, so it did not need updating); `npx tsc --noEmit` clean.
- **Committed in:** `3997b75` (Task 3 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix, touching a file outside this plan's declared `files_modified`)
**Impact on plan:** Necessary for the D-12 "all-time" range to render correct, non-garbled chart labels/hover text — without it, the range switcher's weekly-bucket path would be functionally broken for every consumer of `/stats/usage`, not just this plan. Narrowly scoped: only the weekly-bucket `GROUP BY` expression changed; the daily-bucket query, `by_feature`/`by_model` queries, and `cost_event_deltas` computation are untouched. No test file needed modification since the existing coverage didn't assert the specific date format.

## Issues Encountered
- The plan's own acceptance-criteria `awk` one-liner for the D-14 no-backdrop-filter check (`awk '/#stats-view/{f=1} f&&/backdrop-filter/{print}'`) has a structural false-positive: it sets its flag on ANY line containing the substring `#stats-view` (including the required compact-hide `@media` block entry, which necessarily appears before several pre-existing, unrelated `backdrop-filter` declarations elsewhere in the file). The load-bearing automated check — `tests/viz-activity-palette-invariants.test.ts`'s "D-14-C: backdrop-filter allow-list" suite, which parses actual CSS rule blocks by selector rather than doing a raw substring/line scan — passed cleanly (91/91 across both required test files) and correctly confirms `#stats-view`'s own rule block declares no `backdrop-filter`. Documented here rather than restructuring unrelated pre-existing CSS block ordering to chase a coarse grep heuristic.

## User Setup Required

None - no external service configuration required.

## Known Stubs

- **Brain Health tab** (`#stats-health-tab`): renders a static "Brain Health — coming soon" placeholder only. This is intentional and explicitly scoped to 60-04 by this plan's own task text ("Leave the Brain Health tab container populated with a placeholder that 60-04 replaces... it must not fetch /stats/brain-health yet"). No `fetch('/stats/brain-health'` call exists anywhere in `stats-dashboard.js` (verified by grep).

## Next Phase Readiness
- `ctx.openStatsDashboard(tab)`/`closeStatsDashboard()`/`isStatsDashboardOpen()` are live and ready for 60-05's navigation entry points (settings-panel link + ⌘K palette command) to call directly
- The Usage tab is fully functional against real ledger data (headline, burn+markers, per-feature/per-model splits) — ready for a live founder checkpoint
- 60-04 (Brain Health tab) can reuse this plan's tab/range/refresh plumbing (already wired) and mirror the `.chart-card`/`.chart-card-head`/`.chart-card-title` DOM shape established here (note: `makeCard()`/`createChartSvg()` are private closures inside `stats-dashboard.js`, not exported — 60-04 either extends this same file or re-implements the small shape). It only needs to replace `renderHealthTab()`'s placeholder body and add its own `/stats/brain-health` fetch
- No blockers

---
*Phase: 60-settings-stats-depth*
*Completed: 2026-07-11*

## Self-Check: PASSED

- FOUND: src/viz/modules/stats-dashboard.js
- FOUND: src/viz/index.html
- FOUND: src/viz/css/styles.css
- FOUND: src/viz/modules/app.js
- FOUND: src/viz/server.ts
- FOUND: .planning/phases/60-settings-stats-depth/60-03-SUMMARY.md
- FOUND commit: a1ce0fc
- FOUND commit: 56019ec
- FOUND commit: 3997b75
