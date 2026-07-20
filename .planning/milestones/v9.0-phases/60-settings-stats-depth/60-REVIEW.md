---
phase: 60-settings-stats-depth
reviewed: 2026-07-11T00:00:00Z
depth: standard
files_reviewed: 13
files_reviewed_list:
  - src/viz/css/styles.css
  - src/viz/index.html
  - src/viz/modules/app.js
  - src/viz/modules/charts.js
  - src/viz/modules/constants.js
  - src/viz/modules/palette.js
  - src/viz/modules/settings.js
  - src/viz/modules/stats-dashboard.js
  - src/viz/server.ts
  - tests/viz-charts-geometry.test.ts
  - tests/viz-frontend-static.test.ts
  - tests/viz-settings-panel.test.ts
  - tests/viz-stats-routes.test.ts
findings:
  critical: 4
  warning: 7
  info: 8
  total: 19
status: issues_found
---

# Phase 60: Code Review Report

**Reviewed:** 2026-07-11
**Depth:** standard
**Files Reviewed:** 13
**Status:** issues_found

## Summary

Phase 60 adds two read-only stats dashboards (Usage / Brain Health) as a full-window takeover, backed by two new server routes. The **security invariants hold**: both new routes use prepared statements on the read-only DB handle, inherit the loopback bind + Host-header DNS-rebinding guard, return generic `'internal error'` with no SQL/stack leakage, add zero runtime dependencies, add no DB write paths, and every server-sourced value (including SVG `<text>` nodes) reaches the DOM via `textContent`/`setAttribute` only. No amber-family color appears in any dashboard surface (markers use the hairline family; series use `NEUTRAL_SERIES_RAMP` and non-amber `KIND_COLOR` identities).

The defects are in **metric correctness and chart interaction**, not security. Two Brain Health metrics are structurally wrong against the engine's actual event semantics (node growth counts non-births and misses the most common birth path; judge escalation rate is always 100% in production and the test fixture masks it). Two chart-interaction bugs make the D-07 hover and D-10/D-11 marker tooltips misbehave in every real rendering. Several view-state interactions (stats × corpus × palette) clobber each other.

## Critical Issues

### CR-01: Hover crosshair compares screen pixels against viewBox coordinates — nearest-point hover is wrong at every real width

**File:** `src/viz/modules/charts.js:316-327` (with `src/viz/modules/stats-dashboard.js:255-261`)
**Issue:** `createChartSvg` renders every chart with `viewBox="0 0 760 H"`, `width="100%"`, `preserveAspectRatio="none"` — the SVG is horizontally stretched to the card width (typically 900–1600px). `attachHover.onMove` computes `xPixel = ev.clientX - rect.left` in **screen pixels** and passes it to `nearestPointIndex(points, xPixel)` where `points[].x` are in **viewBox units** (52–744). The two coordinate systems only coincide at exactly 760px rendered width. At 1344px rendered width, hovering the cursor at 30% of the chart selects the data point at ~53% — the crosshair/dot/tooltip consistently jump right of the cursor and the right ~40% of the data is unreachable except at the far edge. `tests/viz-charts-geometry.test.ts` only tests `nearestPointIndex` with already-matched coordinates, so this never surfaces.
**Fix:**
```js
function onMove(ev) {
  const rect = svg.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;                       // 0 0 760 H
  const scaleX = rect.width > 0 ? vb.width / rect.width : 1;
  const xPixel = (ev.clientX - rect.left) * scaleX;     // → viewBox units
  const idx = nearestPointIndex(points, xPixel);
  ...
}
```

**Outcome:** fixed — 7ff8b87. attachHover.onMove now converts clientX into viewBox units via `vb.width / rect.width` before nearestPointIndex.

### CR-02: Node-growth query counts `confirm` events (no node created) and omits `unrelated` (the standalone new-node branch) — the focal chart misrepresents growth

**File:** `src/viz/server.ts:533-540` (`stmtNodeGrowthDaily`)
**Issue:** The event set `('schema_emitted', 'confirm', 'extend', 'contradict_append_new')` does not match the engine's actual node-creation semantics in `src/consolidation/consolidator.ts`:
- `confirm` (consolidator.ts:1077-1097) **creates no node** — it strengthens the existing candidate and emits with `node_id = bestCandidateId` (the existing node). Every re-statement of an already-known fact is counted as a node birth, inflating cumulative growth by the (typically large) confirm volume.
- `unrelated` (consolidator.ts:1155-1173) **creates a brand-new standalone node** — the most common birth path for genuinely new facts — and is excluded, so real growth is undercounted.
- `contradict_oscillation` (consolidator.ts:1211-1229) also mints a new node and is excluded.

The `approximate: true` flag and the D-13 caption ("approximate where older events were pruned") cover event pruning, not a systematically wrong event set. The seeded test fixture (viz-stats-routes.test.ts:362-365) only uses the three "safe" types and never seeds `confirm`/`unrelated`, so the miscount is untested.
**Fix:** Count events that mint a node, exclude those that don't:
```sql
WHERE node_id IS NOT NULL
  AND event_type IN ('schema_emitted', 'extend', 'unrelated',
                     'contradict_append_new', 'contradict_oscillation')
```
(Decide explicitly whether `contradict_reconcile` / `contradict_force_destabilize` replacements count as births — they mint a node but tombstone one; net-zero is defensible, but document the choice.)

**Outcome:** fixed — a57d5c3. Event set corrected to the node-minting events (`schema_emitted`, `extend`, `unrelated`, `contradict_append_new`, `contradict_oscillation`); `confirm` excluded. Documented choice: `contradict_reconcile` and force-reconcile `contradict_force_destabilize` are excluded as net-zero (mint + tombstone). Fixture now seeds `confirm` (must not count) and `unrelated` (must count).

### CR-03: `judge_activity.escalation_rate` is structurally always 1.0 (or 0) in production — the metric cannot measure what it claims

**File:** `src/viz/server.ts:558-563, 1541-1544`
**Issue:** `escalation_rate = COUNT(feature_tag='judge' AND model=claudeHeadlessJudgeModel) / COUNT(feature_tag='judge')`. But `feature_tag` for judge calls is derived from the model name (`src/model/claude-headless-client.ts:110-114`: Haiku→`'extract'`, Sonnet→`'judge'`) — there is **no** `setHeadlessFeature('judge')` bracket anywhere (grep confirms only `corpus_gen` and `schema_abstract` brackets exist). Consequences:
- Default config (`twoTierJudge: false`, config.ts:789): every judge row is Sonnet = `claudeHeadlessJudgeModel` → escalated ≡ fires → rate ≡ 1.0. The chart always renders "escalated (100%)".
- With `twoTierJudge: true`: cheap Haiku judge calls are ledgered as `feature_tag='extract'` (also silently polluting the Usage tab's extract split), so `fires` counts only the escalated Sonnet calls → rate is still 1.0.

The test fixture (viz-stats-routes.test.ts:375-377) inserts a `('judge', 'claude-haiku-4-5')` row that **cannot occur in production**, manufacturing the 2/3 rate the assertion checks — the test masks the defect.
**Fix:** Either (a) add a `setHeadlessFeature('judge')` bracket around the judge phase so cheap-judge Haiku rows are tagged `'judge'` (also fixing the extract-split pollution), or (b) drop the escalated bar and render only honest fires until the ledger can distinguish tiers. Update the test fixture to production-realistic rows.

**Outcome:** fixed — 6d42c56. Verified against live engine source: no `setHeadlessFeature('judge')` bracket exists, so every `feature_tag='judge'` row is Sonnet by construction — the ledger cannot measure escalation. Server now reports `escalation_rate: null` (honest unavailability, per the no-fabricated-metrics posture); client renders only the fires bar when the rate is null (escalated bar returns automatically if a real numeric rate ever ships). Impossible ('judge','claude-haiku-4-5') fixture row replaced with production-realistic all-Sonnet rows.

### CR-04: Cost-event marker tooltip is clobbered by the chart hover handler — the D-10/D-11 before/after delta can never be read

**File:** `src/viz/modules/stats-dashboard.js:309-335` (with `src/viz/modules/charts.js:329-336`)
**Issue:** `appendMarkers` attaches `mouseenter`/`mousemove` on the marker `<g>` to show the delta text in the shared `#tooltip`, and `attachHover` attaches a `mousemove` listener on the parent `<svg>` that rewrites `tooltip.textContent` with the nearest-point "{date} — {value}" text. Both fire for the same pointer event (the marker's handler at the `<g>`, then the svg's during bubble), so the svg handler overwrites the marker's delta text on every single mousemove. The marker delta — the load-bearing half of D-10/D-11 (before/after avg-daily-burn) — flashes for at most one frame and is effectively unreadable. Additionally the hover target is a 1px-wide dashed line, which is nearly impossible to hit.
**Fix:** In `attachHover.onMove`, skip when the event originates inside a marker group (`if (ev.target.closest && ev.target.closest('.chart-marker')) return;`), and widen the marker hit area (e.g. an invisible 8px-wide `<rect>` inside the marker `<g>` with `pointer-events: all`).

**Outcome:** fixed — f5dba26. attachHover.onMove skips events originating inside `.chart-marker` (marker owns the shared tooltip while hovered); each marker gains an invisible 8px-wide `pointer-events:all` hit rect.

## Warnings

### WR-01: Palette `flyToNode` never closes the stats takeover — node pick while stats is open animates a hidden canvas

**File:** `src/viz/modules/palette.js:127-130`
**Issue:** `flyToNode` closes the reader and corpus before `ctx.selectNode`, "so the damped camera never animates on a hidden canvas" (D-06) — but it does not check `ctx.isStatsDashboardOpen`/call `ctx.closeStatsDashboard`. ⌘K works in stats view (`currentView()` returns `'stats'` and the Nodes/Topics sections still populate); picking a node leaves `#stats-view` covering the window (z:6) with `#graph` at `visibility:hidden`, while the detail panel (z:10) opens on top — exactly the hidden-canvas camera flight D-06 exists to prevent. No module in the repo calls `ctx.closeStatsDashboard` (grep confirms).
**Fix:**
```js
function flyToNode(target) {
  if (ctx.isStatsDashboardOpen && ctx.isStatsDashboardOpen() && ctx.closeStatsDashboard) ctx.closeStatsDashboard();
  if (readerIsOpen() && ctx.closeReader) ctx.closeReader();
  ...
}
```

**Outcome:** fixed — e6bd0c9. `flyToNode` closes the stats takeover (via `ctx.closeStatsDashboard`) before the reader/corpus closes and the camera flight.

### WR-02: `setOtherViewsHidden(false)` unconditionally restores `#hud-chip`/`#topics-rail`, clobbering corpus view's hidden state

**File:** `src/viz/modules/stats-dashboard.js:86-91, 108-114`
**Issue:** The stats takeover can be opened over the corpus view (palette `open-stats` has `visibleIn: ['brain','reader','corpus']`). Corpus view hides `#hud-chip`/`#topics-rail` via `setTopicsSearchHidden(true)` (corpus.js:550-554) and keeps them hidden while corpus is open. Closing stats calls `setOtherViewsHidden(false)` which sets `hudChip.style.display = ''` and `topicsRail.style.display = ''` unconditionally — re-showing the brain chip and topics rail over the corpus view + index sidebar, violating the corpus B3 layout rule. Same shared-mutable-DOM-state class of bug on the same two elements the two modules both write.
**Fix:** On hide, only restore chip/rail when the corpus is not open:
```js
const corpusOpen = ctx.isCorpusOpen && ctx.isCorpusOpen();
if (hudChip) hudChip.style.display = (hidden || corpusOpen) ? 'none' : '';
if (topicsRail) topicsRail.style.display = (hidden || corpusOpen) ? 'none' : '';
```

**Outcome:** fixed — 88d467e. `setOtherViewsHidden(false)` only restores `#hud-chip`/`#topics-rail` when `ctx.isCorpusOpen()` is false.

### WR-03: Cost-event markers older than the selected window render at the first bucket with a fabricated `before_avg = 0`

**File:** `src/viz/modules/stats-dashboard.js:298-307` (with `src/viz/server.ts:1483-1494`)
**Issue:** `buildMarkers` places a marker at `buckets.findIndex(b => b.date >= m.date)`. For a window that starts after the event date (e.g. today, both COST_EVENTS — 2026-06-25 and 2026-07-03 — precede a 7d window), every such marker resolves to index 0: two overlapping dashed lines at the left edge, visually claiming the events happened on the window's first day. The server-side delta for that window has `before` empty → `before_avg: 0`, so the tooltip reads "0/day → N/day" — a fabricated collapse. Events should either be skipped when `m.date < buckets[0].date` or the delta computed over an unwindowed query.
**Fix:** In `buildMarkers`, skip out-of-window events:
```js
if (buckets.length && m.date < buckets[0].date) continue;
```

**Outcome:** fixed — e8302a6. `buildMarkers` skips events with `m.date < buckets[0].date` — out-of-window markers no longer render at bucket 0 with a fabricated before_avg.

### WR-04: Zero-usage days are absent from daily buckets — the x-axis distorts time and "avg daily burn" is per-active-day, not per-day

**File:** `src/viz/server.ts:488-496, 1483-1494` (with `src/viz/modules/stats-dashboard.js:367`)
**Issue:** `stmtUsageDailyBuckets` groups only rows that exist; days with no ledger writes produce no bucket. The client scales x by array index (`linearScale([0, buckets.length-1], ...)`), so a 30d window with 12 active days renders 12 evenly spaced points — gaps compress and the burn line's slope misrepresents time. The D-10/D-11 `before_avg`/`after_avg` divide by `rows.length` (active days only), so a lever that reduced usage to zero on most days *raises* the after-average instead of lowering it — the delta is biased against exactly the levers it exists to showcase.
**Fix:** Zero-fill the date range server-side (generate the calendar span from cutoff→today, defaulting missing dates to `{tokens: 0, cost_usd: 0}`) before returning buckets; deltas then divide by calendar days.

**Outcome:** fixed — d711598. Daily buckets are zero-filled server-side across the calendar span (cutoff→now); before/after deltas now divide by calendar days. Weekly (window=all) unfilled (cutoff=0 has no start); empty-ledger `[]` contract preserved.

### WR-05: Tombstones/day overcounts `contradict_force_destabilize` and misses merge tombstones

**File:** `src/viz/server.ts:551-557`
**Issue:** The tombstone event set counts every `contradict_force_destabilize` row, but that event type has two variants (consolidator.ts:1306-1352): the oscillation variant appends a coexisting node and **does not tombstone**; only the force-reconcile variant does. Meanwhile `entity_merge`/`fact_merge` (dedup passes, sink.ts:64-65) tombstone loser nodes and are not counted, and `contradict_oscillation` in the reconsolidations chart similarly counts append-new coexistence events as "reconsolidations." The per-day chart both over- and under-counts with no caption acknowledging it (the D-13 approximation caption is only on node growth).
**Fix:** Either refine the sets (exclude oscillation-variant destabilize is not distinguishable from the event row alone — so at minimum add the merge events and an approximation caption to these charts), or persist a `tombstoned` flag in the event payload going forward.

**Outcome:** fixed — caa619e. `entity_merge`/`fact_merge` added to the tombstone set; recon and tombstone charts both carry an approximation caption (the force-destabilize oscillation variant is not distinguishable from the event row alone — documented in the prepared-statement comment). Fixture seeds an `entity_merge` row.

### WR-06: `.settings-usage-link` has no CSS rule — default browser blue/underlined anchor on the dark panel

**File:** `src/viz/modules/settings.js:259-267` (missing rule in `src/viz/css/styles.css`)
**Issue:** The D-04 "View usage stats →" link is created with `className = 'settings-usage-link'` and a comment claiming "styled per Phase 59 tokens", but no selector for that class exists anywhere in styles.css (grep confirms). The `<a href="#">` renders with user-agent defaults: blue/purple underlined text on the aubergine panel — off-palette against the design system the rest of this phase machine-enforces, and low-contrast in dark mode.
**Fix:** Add a rule using existing tokens, e.g.:
```css
.settings-usage-link {
  display: inline-block;
  margin: 8px 0;
  font-size: 12.5px;
  color: var(--text-bright-mauve);
  text-decoration: none;
  border-bottom: 1px dotted var(--banner-border);
}
.settings-usage-link:hover { color: var(--text-bright); }
```

**Outcome:** fixed — ea2ddd8. `.settings-usage-link` rule added using existing tokens (`--text-bright-mauve`, `--banner-border`, `--text-bright` on hover).

### WR-07: Settings save can never remove an override — reverting to the preset default silently keeps the stale value, and "(modified)" sticks forever

**File:** `src/viz/modules/settings.js:287-301` (with `src/viz/server.ts:1369-1374`)
**Issue:** Two halves combine into a one-way ratchet. Client: `save()` omits a key from `newOverrides` when its value equals the preset default (`presetDefaults[field.key] !== val` check). Server: POST /settings merges `{ ...current.overrides, ...newOverrides }`, so an omitted key **retains its old override**. Net effect: once a toggle is overridden (e.g. `schemaInductionEnabled: false`), flipping it back to the preset default and saving sends nothing for that key, the server keeps the old override, and the re-render from the returned effective config flips the toggle back — the user's revert is silently discarded. Additionally, all five number fields are absent from `PRESET_DEFAULTS`, so `presetDefaults[key] === undefined` is always true and every save writes all number fields as overrides — `hasOverrides` is permanently non-empty after the first save and the header shows "(modified)" forever. Pre-existing (44-06) but in-scope and directly load-bearing for this panel's correctness.
**Fix:** Send explicit removals — e.g. client sends the full desired overrides object and the server *replaces* rather than merges (`overrides: newOverrides ?? current.overrides`), or client sends `null` for keys to clear and the server deletes them.

**Outcome:** fixed — a35e6ba. Server POST /settings now REPLACES stored overrides with the posted set (requests without an overrides key leave them untouched); client save() compares number fields against real engine defaults (DEFAULT_THRESHOLDS + corpusGenMax 25) so reverted fields are omitted and genuinely cleared, and "(modified)" no longer sticks forever. viz-settings-routes.test.ts updated to assert replace semantics + no-overrides-key preservation.

## Info

_Info findings below were not in the fix scope (`--fix` covers Critical + Warning only) and remain open._

### IN-01: charts.js docstring claims "this module never hard-codes a color" but every builder has a hard-coded hex default

**File:** `src/viz/modules/charts.js:16-20, 173, 193, 228, 281, 304`
**Issue:** `line`/`bar`/`axis`/`legend`/`attachHover` default to `'#a99db3'`, `'#9a90a4'`, `'#8b8098'`, `'rgba(140,150,165,0.08)'`. All in-repo callers pass explicit colors so the defaults are dead, but the module contract and the code disagree — a future caller relying on the docstring gets an unaudited literal.
**Fix:** Remove the defaults (make `color` required) or fix the docstring.

### IN-02: `.chart-card-primary` class is set in JS but has no CSS rule

**File:** `src/viz/modules/stats-dashboard.js:360, 536` (missing in styles.css)
**Issue:** The D-06 "largest card" distinction comes only from `BURN_H` vs `BAR_H` geometry; the class is inert. Dead code or missing style.
**Fix:** Add the intended rule or drop the class.

### IN-03: `parseCostEvents` fails soft on entry-format drift despite documenting fail-fast

**File:** `src/viz/server.ts:121-134`
**Issue:** A missing `COST_EVENTS` array throws, but the per-entry regex (`{ date: '...', label: '...' }`, single quotes, fixed property order, no apostrophes in labels) silently yields fewer/zero entries if the literal is ever reformatted — e.g. a label containing `'` drops that marker with no error, diverging server deltas from the client's natively imported `COST_EVENTS`.
**Fix:** Throw when `entries.length` doesn't match the number of `{` blocks in the array body, or count `date:` occurrences and compare.

### IN-04: Range pills stay active and clickable on the Brain Health tab but have no effect

**File:** `src/viz/modules/stats-dashboard.js:144-150, 188-201`
**Issue:** `/stats/brain-health` takes no range; clicking a pill on the Health tab re-highlights and re-fetches but changes nothing — the highlighted range then silently applies when switching back to Usage.
**Fix:** Disable/dim `#stats-range` while `currentTab === 'health'`.

### IN-05: `renderFeatureSplit` silently drops feature tags outside `FEATURE_ORDER`

**File:** `src/viz/modules/stats-dashboard.js:433-441` (with `src/viz/modules/stats-dashboard.js:28`)
**Issue:** Ledger rows tagged `'unknown'` (possible per claude-headless-client.ts:113) appear in the headline total but vanish from the per-feature split, making the split's bars not sum to the headline with no visual cue.
**Fix:** Append an "other" bar when unmatched rows carry nonzero tokens.

### IN-06: Stacked Escape handlers close multiple overlays on one keypress

**File:** `src/viz/modules/stats-dashboard.js:122-124` (with settings.js:66-68, palette.js:234)
**Issue:** Stats, settings, and palette each register independent document-level Escape listeners with no open-order awareness — with stats open under an open settings panel (the D-04 link flow leaves settings open), one Escape closes both at once.
**Fix:** Guard each handler on being the topmost open surface, or accept and document the behavior.

### IN-07: The amber-ban source guard only matches `ffb866`/`accent-amber` — sanctioned amber hex values would pass

**File:** `tests/viz-charts-geometry.test.ts:91-95`
**Issue:** A hard-coded `#d9a05c` (accent-amber-solid's raw value) or `#c8a94a` in charts.js would not trip the guard. The current source is clean, but the machine check is weaker than the D-08 invariant it claims to enforce.
**Fix:** Add the raw amber-family literals (and ideally an R≈G>B warm-hue heuristic like viz-activity-palette-invariants.test.ts uses) to the guard.

### IN-08: app.js wiring comment misattributes the ordering constraint

**File:** `src/viz/modules/app.js:257-259`
**Issue:** The comment says initStatsDashboard runs "after initSettings so ctx.openStatsDashboard is ready" — but `ctx.openStatsDashboard` is defined by `initStatsDashboard` itself; settings.js reads it lazily at click time. The only real constraint is initStatsDashboard-before-initPalette.
**Fix:** Correct the comment.

---

_Reviewed: 2026-07-11_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_

## Fix Outcome Summary

All 4 Critical and 7 Warning findings fixed (11/11), one atomic commit each (`fix(60): <id> ...`, 7ff8b87..a35e6ba). Verification: `npx tsc --noEmit` clean; `viz-stats-routes` / `viz-charts-geometry` / `viz-frontend-static` / `viz-settings-panel` / `viz-hud-palette` / `viz-activity-palette-invariants` all green (149 tests), plus `viz-server` / `viz-settings-routes` / `viz-index-route` regression-checked green. Info findings (IN-01..IN-08) remain open.

_Fixed: 2026-07-11_
_Fixer: Claude (gsd-code-fixer)_
