---
phase: 60-settings-stats-depth
plan: 10
subsystem: ui
tags: [css, svg, charts, scrollbar, design-system, stats-dashboard]

# Dependency graph
requires:
  - phase: 60-settings-stats-depth (plans 07-09)
    provides: Usage tab data layer + redesign (stat tiles, levers card, collapsed breakdown) that this plan's chart contract will be re-skinned to consume
provides:
  - One global `*`-scoped muted-mauve scrollbar rule set in styles.css, replacing four per-container duplicates (GAP-3)
  - Updated charts.js mark-spec contract: line() 2px round-join stroke with optional 10% area wash, bar() strokeless rounded-top path, directLabel() endpoint direct-label primitive (GAP-4d foundation)
affects: [60-11 (de-box redesign — consumes the scrollbar rule and charts.js mark-spec contract shipped here)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Global scrollbar skin via a single `*`-scoped rule set (scrollbar-width/scrollbar-color + ::-webkit-scrollbar*) instead of per-container duplication"
    - "SVG mark-spec builders (line/bar) stay backward-compatible via optional opts (areaFill) so existing call sites in stats-dashboard.js need zero edits"
    - "Source-grep test assertions for DOM-building functions (createSvgNode/document.createElementNS) when the test suite has no jsdom dependency — extractFunction() helper isolates one exported function's source text for regex assertions, mirroring the existing innerHTML/amber-ban guards"

key-files:
  created: []
  modified:
    - src/viz/css/styles.css
    - src/viz/modules/charts.js
    - tests/viz-charts-geometry.test.ts

key-decisions:
  - "Global scrollbar rule placed at the top of styles.css immediately after the html/body reset block (not injected via constants.js/emitHudTokens) — it is a plain var()-token CSS rule, no runtime value needed"
  - "line()'s areaFill area polygon is built from points[0].x/last point.x down to opts.baselineY (defaults to points[0].y when omitted) and wrapped in a <g> only when areaFill is passed — omitting areaFill returns the bare polyline unchanged, preserving every existing call site's return-type assumption"
  - "bar()'s rounded-top path uses two SVG arc (A) commands for the top-left/top-right corners only; bottom corners stay square per the GAP-4d spec (baseline square, data-end rounded)"
  - "directLabel() is a spec-only addition in this plan — no call site wires it yet; 60-11 (de-box redesign) is the consumer per its `<interfaces>` block"

requirements-completed: [GAP-3, GAP-4d]

# Metrics
duration: 6min
completed: 2026-07-14
---

# Phase 60 Plan 10: Global Scrollbar + Chart Mark-Spec Foundation Summary

**Consolidated four duplicated per-container scrollbars into one global `*`-scoped muted-mauve rule set, and updated charts.js's line/bar SVG builders to the GAP-4d mark spec (2px round-join lines with optional 10% area wash, strokeless 4px-rounded-top bars) plus a new exported `directLabel()` endpoint-label primitive.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-07-14T12:43:00-04:00
- **Completed:** 2026-07-14T12:45:25-04:00
- **Tasks:** 2 completed
- **Files modified:** 3

## Accomplishments
- GAP-3 closed: one global scrollbar rule set (`* { scrollbar-width: thin; scrollbar-color: var(--scrollbar-thumb) transparent; } *::-webkit-scrollbar*`) applies document-wide, including `#stats-view` and any future scroll surface; the four duplicated per-container blocks (`.detail-page #detail`, `#reader`, `#settings-panel`, `.index-content`) are gone
- GAP-4(d) foundation laid in charts.js: `line()` now defaults to a 2px round-join/cap stroke and accepts an optional `areaFill` opt that renders a ~10%-opacity filled area behind the stroke (back-compat preserved — omitting `areaFill` returns the bare polyline exactly as before)
- `bar()` now renders each mark as a strokeless, 4px-rounded-top SVG `<path>` (corner radius clamped to `min(4, width/2, height)`) instead of a `<rect>` with a 1px stroke
- New exported `directLabel(point, text, opts)` primitive: builds a recessive `<text>` node at a point, textContent-set only (T-44-19), for selective endpoint/extreme labeling — not per-point
- `axis()` gridColor and `attachHover()`'s CR-01 viewBox pixel-conversion logic were left untouched, as required
- All 7 existing `stats-dashboard.js` call sites into `line()`/`bar()` (lines 593, 761, 800, 830, 866, 915, 949) pass only `{ color }` — fully compatible with the new signatures, zero call-site edits needed

## Task Commits

Each task was committed atomically:

1. **Task 1: Consolidate the styled scrollbar into one global rule set (GAP-3)** - `87dd863` (feat)
2. **Task 2: Update line/bar mark specs + add endpoint direct-label + area wash (GAP-4d)** - `339aadb` (test, RED) → `9ad1617` (feat, GREEN)

**Plan metadata:** committed with this SUMMARY.

_TDD task 2 followed the RED→GREEN cycle: `339aadb` added 5 failing mark-spec assertions (line stroke-width default, area-wash fill-opacity, bar strokeless rounded-top path, corner-radius clamp, directLabel export) against the pre-change charts.js, confirmed failing (5 failed / 13 passed), then `9ad1617` implemented the charts.js changes and all 18 tests in the file went green. No REFACTOR commit needed — implementation was already minimal._

## Files Created/Modified
- `src/viz/css/styles.css` - Added one global `*`-scoped scrollbar rule set near the top (after the html/body reset block); removed the four per-container scrollbar blocks (`.detail-page #detail`, `#reader`, `#settings-panel`, `.index-content`)
- `src/viz/modules/charts.js` - `line()` default strokeWidth 2 + optional `areaFill`/`baselineY` opts building a `<g>` with a 10%-opacity `<polygon>` area behind the stroke; `bar()` rewritten from `<rect>`+stroke to a strokeless rounded-top `<path>`; new exported `directLabel()` function
- `tests/viz-charts-geometry.test.ts` - Added an `extractFunction()` source-slice helper plus 3 new `describe` blocks (line mark spec, bar mark spec, directLabel) with 5 new assertions; existing geometry/source-guard tests untouched

## Decisions Made
- Test assertions for the new DOM-building code (`line`/`bar`/`directLabel`, all touching `document.createElementNS`) are source-grep-based rather than executed-DOM assertions, because the vitest suite runs in a plain `'node'` environment with no jsdom dependency (net-zero-new-deps invariant) — this mirrors the pre-existing `innerHTML`/amber-ban source guards already in the same test file, and matches the plan's own acceptance criteria (which are themselves bash `grep` commands)
- Global scrollbar rule inserted at the top of `styles.css` (right after the `html, body` reset block) rather than scoped to `html`/`body` selectors specifically, using the universal `*` selector per the plan's explicit spec — this guarantees every current and future scroll surface inherits it without needing a new per-container rule

## Deviations from Plan

None - plan executed exactly as written. Both tasks' acceptance criteria (grep-based checks) all pass verbatim; `tsc --noEmit` is clean; the three named verification test files (`viz-charts-geometry.test.ts`, `viz-activity-palette-invariants.test.ts`, `viz-frontend-static.test.ts`) all pass (110/110 tests green across the three files, 18/18 in the geometry file specifically).

## TDD Gate Compliance

Task 2 (`tdd="true"`) gate sequence verified in git log:
- RED gate: `339aadb` `test(60-10): add failing mark-spec assertions...` — confirmed 5 failing / 13 passing before implementation
- GREEN gate: `9ad1617` `feat(60-10): implement line/bar mark specs...` — confirmed 18/18 passing after implementation
- REFACTOR gate: not needed — no refactor commit; implementation was minimal on first pass

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The global scrollbar rule and the charts.js line/bar/directLabel mark-spec contract are the two "contract" surfaces 60-11 (de-box redesign) consumes per this plan's objective — both are shippable and verified independently of 60-11's visual overhaul work
- `directLabel()` has no call site yet; 60-11 is the intended first consumer (selective endpoint/extreme labels per GAP-4(d) locked decision (d) — never a value on every point)
- No blockers for 60-11

## Self-Check: PASSED

All created/modified files exist on disk (`src/viz/css/styles.css`, `src/viz/modules/charts.js`, `tests/viz-charts-geometry.test.ts`, this SUMMARY.md); all 3 task commits (`87dd863`, `339aadb`, `9ad1617`) verified present in `git log`.

---
*Phase: 60-settings-stats-depth*
*Completed: 2026-07-14*
