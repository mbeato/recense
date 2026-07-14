---
phase: 60-settings-stats-depth
plan: 11
subsystem: ui
tags: [css, svg, charts, stats-dashboard, design-system, de-box]

# Dependency graph
requires:
  - phase: 60-settings-stats-depth (plan 10)
    provides: Global scrollbar rule set + charts.js mark-spec contract (line areaFill/baselineY, bar rounded-top, directLabel) this plan's redesign consumes
provides:
  - De-boxed Usage tab (hero + supporting row + integrated signed deltas + quiet borderless tables) replacing the five-equal-tile "AI slop" layout
  - De-boxed Brain Health tab (consistent-height small-multiples sections, one-line honest sleep-pass readout) replacing per-chart bordered cards
  - makeSection() section-header idiom (10px uppercase + hairline divider) replacing makeCard() everywhere in stats-dashboard.js
  - Static test guards locking the redesign (chart-card/makeCard retirement, glyph ban, legend( == 5, section/hero/sleep-readout CSS presence, single global scrollbar)
affects: [any future stats-dashboard.js work — the section idiom (makeSection) and hero/supporting/delta/quiet-table CSS classes are now the load-bearing pattern for this surface]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "makeSection(titleText) — borderless div.stats-section + 10px uppercase div.stats-section-head with a hairline bottom divider; the sole structural idiom for both Usage and Brain Health tabs, replacing the retired makeCard() bordered-card helper"
    - "Hero + supporting figures — exactly one .stats-hero (~44px mono) per tab with its signed trend delta (.stats-delta, real minus glyph, no directional arrow glyphs) inline in the value row; remaining stats become a hairline-separated .stats-supporting-row of quiet label/value/context items"
    - "Quiet borderless data tables — 10px uppercase muted column headers + hairline row separators, no outer border/box; one emphasized mono/green cell per row (.stats-levers-pct.positive) for the single most important value"
    - "Single-series charts drop their legend() call entirely (section header names the series); true multi-series charts keep theirs — enforced by an exact legend( count == 5 static guard"
    - "Small-multiples chart height — all six Brain Health charts share one HEALTH_CHART_H constant (= BAR_H) instead of node-growth's previous taller BURN_H"

key-files:
  created: []
  modified:
    - src/viz/modules/stats-dashboard.js
    - src/viz/css/styles.css
    - tests/viz-frontend-static.test.ts

key-decisions:
  - "Retail-\$ formatting changed from 4 decimals to 2 (toFixed(2)) per the GAP-4b founder decision — this supersedes the earlier UI-SPEC 4-decimal spec, documented inline with a code comment at the call site"
  - "today_vs_typical_pct context (no longer homed on a 'today' supporting tile, since today became the hero) was placed as a compact muted context line on the hero itself, alongside the 'vs prior 7d'/'no prior baseline' qualifier, joined with a middle-dot separator when both are present; week_vs_typical_pct stays on the 'this week' supporting item"
  - "The two literal → glyphs in the cost-event marker tooltip ('before/day → after/day') and three pre-existing → glyphs in code comments were rewritten to plain 'to'/'-to-' text — the plan's glyph-ban acceptance criterion (grep -Ec \"▲|▼|→\") is a blunt whole-file regex with no context exception, so all matches (not just the deleted TREND_ARROW map) had to be eliminated to pass; the marker tooltip's directional meaning is unchanged, just spelled out"
  - "chart-card-primary (Task 1's mechanical rename target: stats-section-primary) was fully removed in Task 2 rather than kept as inert scaffolding — it had no CSS rule (IN-02, confirmed via grep before removal) and existed only to special-case node-growth's height, which GAP-4f's small-multiples requirement retires anyway"
  - "Kept .stats-headline-tile/-value/-label CSS through Task 1 (still referenced by the not-yet-rewritten sleep-pass tile) and removed it in Task 2 once renderLastSleepPassTile was rewritten to .stats-sleep-readout, leaving zero dangling references in either direction"

requirements-completed: [GAP-4a, GAP-4b, GAP-4c, GAP-4d, GAP-4e, GAP-4f]

# Metrics
duration: 13min
completed: 2026-07-14
---

# Phase 60 Plan 11: De-box Usage + Brain Health Tabs Summary

**Replaced the uniform bordered-card "AI slop" layout on both stats tabs with a recessive section-header idiom — one hero figure per tab, quiet hairline-separated supporting rows, signed-text trend deltas (no glyphs), borderless quiet tables, small-multiples Brain Health sections, and a one-line honest sleep-pass readout.**

## Performance

- **Duration:** ~13 min
- **Started:** 2026-07-14T12:47:00-04:00
- **Completed:** 2026-07-14T12:59:09-04:00
- **Tasks:** 3 completed
- **Files modified:** 3

## Accomplishments
- GAP-4a (de-box): `.chart-card` retired everywhere in stats-dashboard.js and styles.css; `makeSection(titleText)` (borderless section + 10px uppercase hairline-divided header) replaces `makeCard()` across all 9 former call sites (3 Usage, 6 Brain Health)
- GAP-4b (hero + supporting): Usage tab now leads with exactly one hero figure — today's tokens at ~44px JetBrains Mono — over a quiet hairline-separated supporting row (this week / 30d / avg-day / retail-$); retail-$ moved from a tile label to a muted footnote and switched from 4 to 2 decimals
- GAP-4c (integrated deltas): `TREND_ARROW`/`renderFraming` prose block deleted; the trend now renders as plain signed text (`+18%` / real-minus `−12%`) inline on the hero, colored green when usage is down (positive signal) and neutral mauve otherwise — zero ▲▼→ glyphs anywhere in the file (verified against the pre-existing marker-tooltip and code-comment arrows too, not just the deleted trend map)
- GAP-4d (mark specs): burn chart drops its single-series legend (adds a 10%-opacity area wash + one endpoint `directLabel` instead); node-growth/reconsolidations/tombstones drop theirs too (section header names the series); kind-mix/judge-activity/episodes (true multi-series) keep theirs — `legend(` call count goes from 9 to exactly 5 (3 real + 2 code-comment mentions), locked by a static guard; Brain Health bar width cap tightened from 56px to 24px
- GAP-4e (quiet tables): levers + breakdown restyled as borderless quiet tables (10px uppercase muted headers, hairline row separators, no outer box); `%-saved` is the one mono/green-when-positive emphasized cell per lever row
- GAP-4f (Brain Health sections): all six charts now share one height constant (`HEALTH_CHART_H`, small-multiples feel) instead of node-growth's previous taller `BURN_H`; last-sleep-pass rewritten from a `stats-headline-tile` card into a single `.stats-sleep-readout` line (label + mono value + honest status color)
- GAP-1/CR-01/CR-04 preserved: `measureChartWidth` now reads the de-boxed container's `clientWidth` directly (no more chart-card padding/border subtraction); resize re-render, nearest-point hover, and marker-hover tooltip precedence are all untouched
- Task 3 static guards lock the redesign in `tests/viz-frontend-static.test.ts`: zero `chart-card`/`makeCard`, zero trend glyphs, `legend(` == 5 (with rationale comment), `stats-section-head`/`stats-hero-value`/`stats-sleep-readout` present in CSS with zero `.chart-card` rule, exactly one global scrollbar rule set (cross-checks 60-10's GAP-3)

## Task Commits

Each task was committed atomically:

1. **Task 1: De-box the Usage tab — hero + supporting row + integrated deltas + quiet tables (GAP-4 a,b,c,e)** - `c457d33` (feat) — also performed the mechanical `makeCard`→`makeSection` rename + `chart-card-primary`/`stats-headline-tile` className conversion across all 9 call sites (3 Usage + 6 Brain Health), staging Brain Health for Task 2
2. **Task 2: De-box the Brain Health tab — section idiom, small-multiples, one-line sleep readout (GAP-4 a,d,f)** - `d7ef6c2` (feat)
3. **Task 3: Lock the redesign with honest static guards + document invalidated legend counts** - `8c790d8` (test)

**Plan metadata:** committed with this SUMMARY.

## Files Created/Modified
- `src/viz/modules/stats-dashboard.js` - `makeSection()` replaces `makeCard()`; `renderUsageHero`/`renderSupportingRow` replace `renderStatTileRow`/`renderFraming`/`TREND_ARROW`; `renderLeversSection`/`renderUsageBreakdown` restyled as quiet tables under section headers; `renderBurnChart` drops its legend, adds area-wash + endpoint `directLabel`; `measureChartWidth` drops the chart-card padding/border subtraction; all six Brain Health chart functions share `HEALTH_CHART_H`, drop single-series legends (kind mix/judge/episodes keep theirs), and cap bar width at 24px; `renderLastSleepPassTile` rewritten into `.stats-sleep-readout`
- `src/viz/css/styles.css` - `.chart-card*`/`.stats-tile-row`/`.stats-framing` retired; new `.stats-section*`/`.stats-hero*`/`.stats-supporting*`/`.stats-delta`/`.stats-footnote`/`.stats-sleep-readout*` rules added; `.stats-levers-pct` emphasis class added; dead `.stats-headline-tile/-value/-label` rules removed once the sleep-pass tile no longer used them; every new rule uses an existing `var(--token)` (no new HUD_CSS_TOKENS entry needed)
- `tests/viz-frontend-static.test.ts` - New `describe('Phase 60 GAP-4 de-box redesign')` block with 5 assertions locking the redesign invariants

## Decisions Made
See `key-decisions` in frontmatter above (retail-$ 2-decimal supersession, hero/today_vs_typical_pct placement, whole-file glyph-ban cleanup beyond just TREND_ARROW, chart-card-primary full removal vs. mechanical rename, headline-tile CSS lifecycle across the two tasks).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Eliminated all remaining ▲▼→ glyph matches, not just the deleted TREND_ARROW map**
- **Found during:** Task 1 verification (acceptance criteria grep gate `grep -Ec "▲|▼|→" src/viz/modules/stats-dashboard.js` == 0)
- **Issue:** The plan's glyph-ban acceptance criterion is a blunt whole-file regex with no comment/string exception. Three pre-existing `→` occurrences (two in unrelated code comments — "Identity-hue → CSS hex string", "display:none→block"/"opacity 0→1" — and one in the cost-event marker tooltip's "before/day → after/day" delta text) plus my own new comments describing the ban (which literally typed the banned glyphs) all matched, even though only the deleted `TREND_ARROW` map was the plan's actual target.
- **Fix:** Reworded the two unrelated code comments to plain ASCII ("to" instead of "→"), reworded my own explanatory comments to describe the ban without typing the glyphs, and changed the marker tooltip's rendered text from "X/day → Y/day" to "X/day to Y/day" (same meaning, spelled out, still textContent-only).
- **Files modified:** src/viz/modules/stats-dashboard.js
- **Verification:** `grep -Ec "▲|▼|→" src/viz/modules/stats-dashboard.js` returns 0
- **Committed in:** c457d33 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug-class grep-gate cleanup)
**Impact on plan:** Necessary to satisfy the plan's own machine-checked acceptance criteria; no visual/functional regression (marker tooltip meaning unchanged, just de-glyphed) and no scope creep beyond the plan's explicit design-bar mandate ("no glyph arrows ▲▼→" applies file-wide, not just to the trend indicator).

## Issues Encountered
None beyond the deviation above.

## User Setup Required
None - no external service configuration required; presentation-only change, `/stats/*` payload shape untouched.

## Next Phase Readiness
- The six-point GAP-4 design contract (a)–(f) is fully delivered and locked by static guards; `npx tsc --noEmit` clean and the named verification test files (`viz-activity-palette-invariants`, `viz-charts-geometry`, `viz-frontend-static`) all pass, as does the full suite modulo the 23 pre-existing eval-harness/adapter/locomo environment failures noted as out-of-scope (zero viz-* failures)
- Manual founder re-walk (visual verification of the de-boxed layout, hero prominence, delta coloring, small-multiples rhythm) remains out-of-band per the plan's own `<verification>` block — this is a presentation-only change that machine checks can verify structurally but not aesthetically
- No blockers for any future stats-dashboard.js work; `makeSection`/hero/supporting/quiet-table CSS classes are now the established idiom for this surface

## Self-Check: PASSED

All modified files exist on disk and match the committed diffs (`src/viz/modules/stats-dashboard.js`, `src/viz/css/styles.css`, `tests/viz-frontend-static.test.ts`); all 3 task commits (`c457d33`, `d7ef6c2`, `8c790d8`) verified present in `git log`.

---
*Phase: 60-settings-stats-depth*
*Completed: 2026-07-14*
