---
phase: 60-settings-stats-depth
verified: 2026-07-14T14:10:00Z
status: passed
score: 15/15 must-haves verified (automated); founder sign-off complete (8/8 UAT, 4/4 gaps closed)
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: 15/15 (automated); 1 outstanding human sign-off item
  gaps_closed:
    - "Founder live-install visual walkthrough (60-06 Task 2, 8 steps) — performed 2026-07-13/14, 60-HUMAN-UAT.md now status: passed, 8/8, sign-off 'not bad' 2026-07-14"
    - "GAP-1: charts stretched instead of rendering responsively — closed by 60-07 (measured-width rendering + debounced resize re-render)"
    - "GAP-2: Usage tab was chart-first and low-value — closed by 60-08 (data layer: /stats/usage summary + lever_deltas) + 60-09 (redesign: stat tiles, vs-typical framing, levers card, collapsed breakdown)"
    - "GAP-3: scrollbar styled per-container only — closed by 60-10 (one global *-scoped rule set)"
    - "GAP-4: tabs read as 'AI slop' — closed by 60-10 (chart mark specs: 2px lines, strokeless rounded bars, directLabel) + 60-11 (full de-box redesign: makeSection idiom, hero + supporting figures, quiet borderless tables, small-multiples Brain Health, one-line sleep readout) + round-3 polish commit 9de9e70 (segmented mono tab switch, brighter section heads)"
  gaps_remaining: []
  regressions: []
---

# Phase 60: Settings Stats Depth — usage + brain-health Verification Report

**Phase Goal:** The settings surface grows two real dashboards replacing the bare usage readout. (1) Cost/usage: daily token burn, per-feature split (extract/judge/corpus_gen/schema_abstract), per-model, retail-$ equivalent, and before/after savings framing — all from token_usage_ledger, rendered live. (2) Brain-health: node growth over time, kind mix, reconsolidations + tombstones per day, judge activity (fires, escalation rate), episodes pending vs consolidated, last sleep-pass time/duration/status. LLM-free queries only (online-path constraint); charts in the scene's design language per Phase 59 conventions.

**Verified:** 2026-07-14T14:10:00Z
**Status:** passed
**Re-verification:** Yes — final pass after founder UAT sign-off and two rounds of gap closure

## Re-verification 2026-07-14

The previous verification (2026-07-11, HEAD `0c4627e`) found all 15 automated truths verified but routed to `human_needed` because the founder's live-install visual walkthrough had not actually been performed (60-06-SUMMARY.md admitted it was auto-approved via `--chain` mode). Since then:

1. **Founder walkthrough performed and passed.** `60-HUMAN-UAT.md` frontmatter: `status: passed`, 8/8 tests passed, updated 2026-07-14T23:50:00Z, sign-off note "rest looks fine" (2026-07-14 re-walk) / "not bad" (final, after round-3 polish). All 8 original UAT steps (rail entry, Usage tab content, range pills/refresh, Brain Health tab, design-language conformance, close behavior, palette entry, compact/tray LOD) resolved to pass.

2. **Two rounds of gap closure landed during/after the walkthrough**, each independently re-verified against live source in this pass (not taken on SUMMARY claim):
   - **GAP-1 (charts non-responsive)** — closed by plan 60-07. Verified: `stats-dashboard.js:78` `measureChartWidth` reads real `container.clientWidth`; `stats-dashboard.js:252` `window.addEventListener('resize', ...)` triggers a debounced re-render.
   - **GAP-2 (Usage tab low-value, chart-first)** — closed by plans 60-08 (data layer) + 60-09 (redesign). Verified: `server.ts:527-1673` — `summary` and `lever_deltas` fields present in the `/stats/usage` response, computed from real prepared-statement SQL aggregates (not static), comments explicitly marked `Phase 60-08 GAP-2a/2b/2c`.
   - **GAP-3 (per-container scrollbar)** — closed by plan 60-10. Verified: `styles.css:31-41` — single global `*`-scoped rule set (`scrollbar-width`/`scrollbar-color` + full `::-webkit-scrollbar*` block); no remaining per-container duplicate blocks found.
   - **GAP-4 (AI-slop visual design)** — closed by plans 60-10 (mark-spec foundation) + 60-11 (de-box redesign) + round-3 polish commit `9de9e70`. Verified directly against live code:
     - `charts.js:173-236` — `line()` defaults to `strokeWidth: 2` with an optional `areaFill`/`baselineY` opt building a ~10%-opacity area wash; `bar()` renders a strokeless (fill-only, no `stroke` attribute) `<path>` with rounded top corners (SVG arc commands) and a square baseline; `directLabel()` exported at `charts.js:247` for selective endpoint labeling.
     - `stats-dashboard.js` — `grep -nE "chart-card|makeCard|TREND_ARROW"` returns **zero matches** (fully retired); `makeSection(titleText)` defined at line 492 and used at 9 call sites (lines 294, 602, 642, 778, 816, 848, 884, 925, 964) — 3 Usage + 6 Brain Health sections; `stats-hero-value` className present at line 378 confirming the hero-figure pattern.
     - `grep -Ec "▲|▼|→" stats-dashboard.js` returns `0` — glyph ban holds file-wide, including former marker-tooltip and code-comment occurrences, not just the deleted `TREND_ARROW` map.
     - `legend(` call count is exactly 5 in `stats-dashboard.js` — matches the locked static guard (single-series charts dropped their legends; true multi-series charts — kind mix, judge activity, episodes — kept theirs).
     - `styles.css` — no `.chart-card` rule remains; `#stats-tabs`/`.stats-tab` segmented mono tab-switch styling present (round-3 commit `9de9e70`, "segmented mono tab switch + brighter section heads (founder re-walk)").
   - **Entry-point move (quick task 260714-g0s, not a UAT gap but landed in this window)** — verified: `index.html:119` `#rail-stats` button exists in the HUD rail with a histogram icon; `hud.js:32` looks it up via `getElementById('rail-stats')` and wires it to `ctx.openStatsDashboard()`; `settings.js` — `appendFullUsageReadout`/the in-panel link are gone (only a historical doc-comment references the old link), `appendUsageLines` per-toggle lines retained (4 call sites, D-09 unchanged).

3. **Regression check.** Full test suite: `npx vitest run` → **2683 passed, 3 skipped** (180 test files passed, 1 skipped), matching the claimed count exactly. `npx tsc --noEmit` → clean, exit 0. Targeted re-run of the six viz-specific test files (`viz-stats-routes`, `viz-charts-geometry`, `viz-frontend-static`, `viz-activity-palette-invariants`, `viz-settings-panel`, `viz-hud-palette`) → 160/160 passed. No regressions found relative to the 2026-07-11 baseline (2672→2683 passed reflects the new tests added by 60-07 through 60-11, all green).

**Conclusion:** The sole outstanding item from the previous verification — the founder's human sign-off — is closed and recorded in `60-HUMAN-UAT.md`. All four UAT-surfaced gaps (responsive charts, Usage tab redesign, global scrollbar, AI-slop visual overhaul) are independently re-verified as closed in live source, not taken on SUMMARY claim. No new gaps introduced. Status moves from `human_needed` to `passed`.

### Deferred Info Items (unchanged from initial pass, non-blocking)

The 8 Info-severity anti-pattern findings from the original 60-REVIEW.md pass (IN-01 through IN-08, cosmetic/dead-code items explicitly out of `--fix` scope) remain open by design. Two of them are now superseded by the round-2 redesign rather than merely dormant: IN-02 (`.chart-card-primary` inert class) — `chart-card-primary` was fully removed in 60-11 Task 1 per that plan's key-decisions, so this finding is now moot rather than merely low-impact. The remaining Info items were not targeted by any gap-closure plan and are unaffected.

---

## Original Verification (2026-07-11, preserved below)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `GET /stats/usage` returns windowed daily/weekly burn, per-feature/per-model splits, retail-$, cost-event before/after deltas | VERIFIED | `src/viz/server.ts:1476` handler; prepared statements at ~488-527; 13 tests in `tests/viz-stats-routes.test.ts` seed data and assert bucket/feature/model/retail/delta shape; all pass |
| 2 | `GET /stats/brain-health` returns all six D-14 metric groups + derived last-sleep-pass, honestly labeled | VERIFIED | `src/viz/server.ts:1559` handler; node-growth (event set corrected post-review to only node-minting types), kind_mix, reconsolidations/tombstones per day, judge_activity (escalation_rate now `null` — honest unavailability), episodes, last_sleep_pass (`status: 'unknown'`/`'none'`, never fabricated) |
| 3 | COST_EVENTS single-sourced from constants.js, server never re-declares the literal | VERIFIED | `grep -nE "COST_EVENTS\s*=\s*\["` on server.ts returns no match; `parseCostEvents()` (server.ts:121) reads constants.js source text at startup, mirrors `parseSchedulerScalars` |
| 4 | Hand-rolled inline-SVG chart helpers (line/bar/axis/legend/hover), zero new dependency, textContent-only labels | VERIFIED | `src/viz/modules/charts.js` — `createElementNS` present, no `innerHTML`; `tests/viz-charts-geometry.test.ts` (13 assertions) green; `package.json` diff shows no new deps across the phase |
| 5 | No amber-family hue anywhere in dashboard code | VERIFIED | `grep -niE "ffb866\|accent-amber"` on `stats-dashboard.js`/`charts.js`/new `constants.js` additions returns no match; matches found in `constants.js` are pre-existing tokens (`HOT`, `recall_seed`, `accent-amber-*`) unrelated to this phase's additions |
| 6 | Full-window takeover (`#stats-view`) replaces the 3D brain like the corpus view, glass-free (D-14 invariant untouched) | VERIFIED | `styles.css:1479-1490` — `position:fixed; z-index:6; background:var(--surface-index-panel)`, no `backdrop-filter` in the block; `tests/viz-activity-palette-invariants.test.ts` (D-14-C allow-list, which excludes `#stats-view`) passes |
| 7 | Usage tab renders burn chart (focal) + cost-event markers w/ before-after deltas + per-feature/per-model splits + honestly-labeled retail-$ | VERIFIED | `stats-dashboard.js` — `RETAIL_LABEL` verbatim `'API-retail equivalent (subscription-billed: $0 marginal)'`; `renderBurnChart`/`renderFeatureSplit`/`renderModelSplit` consume `data.buckets`/`data.by_feature`/`data.by_model`/`data.cost_event_deltas` (not hardcoded) |
| 8 | Every chart carries Y+X axis and top-right legend (D-06 full-polish) | VERIFIED | `grep -c "axis("` = 18, `grep -c "legend("` = 11 in `stats-dashboard.js`, both well above the plans' cumulative thresholds (≥9) |
| 9 | Range switcher (7d/30d/90d/all-time) re-fetches; all-time renders weekly buckets | VERIFIED | `stats-dashboard.js:176` fetch includes `window=` param; server `bucket_granularity` switches daily↔weekly; weekly GROUP BY key fixed to a real Monday-start ISO date (60-03 deviation, verified in server.ts) so `fmtDate()` doesn't produce `Invalid Date` |
| 10 | Refresh (on open + button) re-fetches, stamps `as of {HH:MM:SS}`, no SSE/timer | VERIFIED | `grep -n "as of"` matches; no `EventSource`/`setInterval` polling found in `stats-dashboard.js` |
| 11 | Brain Health tab renders all six metric groups in Phase-57 identity hues, amber-free, with D-13 approximation caption and honest last-sleep-pass status | VERIFIED | `NODE_GROWTH_CAPTION` verbatim; `renderJudgeActivityChart`/`renderEpisodesChart`/`renderLastSleepPassTile` present; `KIND_COLOR`/`TYPE_COLOR` imported and used; status render path has no `'ok'`/`'success'` literal |
| 12 | Empty ledger / empty brain / fetch failure render honest empty/error copy, not a broken chart | VERIFIED | All four copy strings (`no usage recorded yet`, `could not load usage stats`, `No brain activity yet`, `could not load brain-health stats`) present verbatim in `stats-dashboard.js` |
| 13 | Settings panel's 30d/all-time readout replaced by a single `View usage stats →` link; per-toggle usage lines retained (D-04) | SUPERSEDED (see re-verification) | Original phase-60 delivery had a settings-panel link; quick task 260714-g0s later moved the entry point to `#rail-stats` in the HUD rail and removed the settings-panel link entirely — see Re-verification section above. Per-toggle usage lines (D-09) are unaffected and remain |
| 14 | ⌘K palette command `Open stats` opens the takeover | VERIFIED | `palette.js:105` — `{ id:'open-stats', label:'Open stats', ... run: c => c.openStatsDashboard() }` |
| 15 | Nothing leaks into the compact/tray popover LOD | VERIFIED | `#stats-view { display: none; }` present inside the `@media (max-width: 500px)` compact-hide block (`styles.css:550`) |

**Score:** 15/15 automated truths verified (truth 13 superseded by a later, founder-directed entry-point change that is itself verified in the re-verification section above). The founder's live-install look-and-feel sign-off, previously the outstanding item, is now complete (`60-HUMAN-UAT.md`, 8/8, "not bad").

### Code Review Fix Verification (60-REVIEW.md, 11 Critical+Warning findings claimed fixed)

All 11 fixes were independently re-verified against HEAD (`0c4627e`) in the initial pass, not taken on SUMMARY/REVIEW claim:

| ID | Claim | Verified in code |
|----|-------|-------------------|
| CR-01 | Hover converts screen px → viewBox units | `charts.js:327-328` — `scaleX = vb.width / rect.width`, `xPixel = (ev.clientX - rect.left) * scaleX` — CONFIRMED |
| CR-02 | Node-growth counts only node-minting event types | `server.ts:540-542` — event set is `schema_emitted, extend, unrelated, contradict_append_new, contradict_oscillation`; `confirm` excluded — CONFIRMED |
| CR-03 | `escalation_rate` returns `null`, not fabricated 1.0 | `server.ts:1587` — `const escalationRate: number | null = null;` with explanatory comment; client (`stats-dashboard.js:709,719`) renders fires-only when null — CONFIRMED |
| CR-04 | Marker tooltip takes precedence over chart hover | `charts.js:320` — `if (ev.target.closest('.chart-marker')) return;` — CONFIRMED |
| WR-01 | `flyToNode` closes stats takeover first | `palette.js:129` — `if (ctx.isStatsDashboardOpen() ...) ctx.closeStatsDashboard();` — CONFIRMED |
| WR-02 | `setOtherViewsHidden(false)` respects corpus-open state | `stats-dashboard.js:96` — `const corpusOpen = !!(ctx.isCorpusOpen && ctx.isCorpusOpen());` gates the restore — CONFIRMED |
| WR-03 | Out-of-window cost markers skipped | `stats-dashboard.js:313` — `if (buckets.length && m.date < buckets[0].date) continue;` — CONFIRMED |
| WR-04 | Daily buckets zero-filled across calendar span | `server.ts:1501-1507` comment + zero-fill logic present — CONFIRMED |
| WR-05 | Tombstone set includes merge events + approximation caption | `server.ts` tombstone stmt includes `entity_merge`/`fact_merge`; `EVENT_COUNT_CAPTION` present in `stats-dashboard.js` — CONFIRMED |
| WR-06 | `.settings-usage-link` CSS rule exists | `styles.css:1184-1192` — CONFIRMED (later superseded by the rail-entry move; rule may since be removed, non-blocking — link's *replacement* is verified above) |
| WR-07 | Settings overrides use replace semantics (not merge) | `server.ts:1391-1397` — `overrides: newOverrides ?? current.overrides` with explanatory comment on one-way-ratchet fix — CONFIRMED |

All 11 fix commits (`7ff8b87`..`a35e6ba`) present in `git log`. No claim taken on trust — every fix independently grepped/read at HEAD.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/viz/server.ts` | `/stats/usage` + `/stats/brain-health` routes, prepared statements, `parseCostEvents`, `summary` + `lever_deltas` fields | VERIFIED | Both handlers present, wired, tested; `summary`/`lever_deltas` confirmed live at lines 527-1673 |
| `src/viz/modules/constants.js` | `COST_EVENTS`, `NEUTRAL_SERIES_RAMP`, `chart-card` token | VERIFIED | All three present, amber-free |
| `src/viz/modules/charts.js` | SVG chart helper module; line/bar mark-spec (2px round-join, strokeless rounded bars), `directLabel` | VERIFIED | `createElementNS`-based, no chart lib, no innerHTML; mark-spec update confirmed live at lines 173-260 |
| `src/viz/modules/stats-dashboard.js` | Full takeover shell + both tabs, de-boxed (`makeSection`, hero + supporting figures, quiet tables) | VERIFIED | `chart-card`/`makeCard`/`TREND_ARROW` fully retired (zero matches); `makeSection` used at 9 call sites; `stats-hero-value` present |
| `src/viz/index.html` | `#stats-view` host markup; `#rail-stats` entry button | VERIFIED | Tabs, range pills, refresh, as-of, close all present; `#rail-stats` present in `#hud-rail` |
| `src/viz/css/styles.css` | Flat surface + compact-hide; single global scrollbar; segmented mono tab switch; no `.chart-card` rules | VERIFIED | No backdrop-filter on `#stats-view` block; compact-hidden; global scrollbar at lines 31-41; `#stats-tabs`/`.stats-tab` segmented styling present; zero `.chart-card` rules remain |
| `src/viz/modules/settings.js` | Usage link removed (moved to rail); per-toggle lines kept | VERIFIED | Old link fully removed (only a historical doc-comment mentions it); `appendUsageLines` retained (4 call sites) |
| `src/viz/modules/hud.js` | `#rail-stats` wiring to `ctx.openStatsDashboard()` | VERIFIED | `hud.js:32` looks up `#rail-stats`, wired |
| `src/viz/modules/palette.js` | `open-stats` command | VERIFIED | Present, self-hides when stats already open |
| `tests/viz-stats-routes.test.ts` | Route contract tests | VERIFIED | 13 tests green |
| `tests/viz-charts-geometry.test.ts` | Chart helper + mark-spec tests | VERIFIED | 18/18 green (5 new mark-spec assertions from 60-10) |
| `tests/viz-frontend-static.test.ts` | De-box redesign static guards | VERIFIED | New `describe('Phase 60 GAP-4 de-box redesign')` block, 5 assertions, green |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `stats-dashboard.js` | `/stats/usage` | `fetch` on open/range-change/refresh | WIRED | Confirmed at line 176 |
| `stats-dashboard.js` | `/stats/brain-health` | `fetch` on tab activation/refresh | WIRED | Confirmed at line 186 |
| `app.js` | `initStatsDashboard(ctx)` | init call after `initSettings(ctx)` | WIRED | Confirmed at line 257 |
| `hud.js` `#rail-stats` | `ctx.openStatsDashboard` | click handler | WIRED | Confirmed at `hud.js:32`, replaces the retired settings-panel link |
| `palette.js` `open-stats` | `ctx.openStatsDashboard` | `run(c)` | WIRED | Confirmed |
| `server.ts` `/stats/*` | `parseCostEvents(constants.js)` | startup source-parse | WIRED | Single-source per D-11, no re-declared literal |
| window `resize` event | `renderUsageTab`/`renderHealthTab` | debounced handler re-rendering active tab from cached data | WIRED | Confirmed at `stats-dashboard.js:252`, container `clientWidth` read at line 78 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `renderUsageTab` | `data.buckets`/`by_feature`/`by_model`/`retail_usd`/`cost_event_deltas`/`summary`/`lever_deltas` | `GET /stats/usage` response | SQL aggregates over `token_usage_ledger` with real `db.prepare` GROUP BY queries (not static returns); `summary`/`lever_deltas` confirmed as real prepared statements, not hardcoded | FLOWING |
| `renderHealthTab` | `data.node_growth`/`kind_mix`/etc. | `GET /stats/brain-health` response | SQL aggregates over `consolidation_event`/`node`/`episode` (verified query text) | FLOWING |
| Rail button / palette command | n/a (navigation only) | n/a | n/a | N/A |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Route contract (seeded + empty DB + guards) | `npx vitest run tests/viz-stats-routes.test.ts` | 13/13 pass | PASS |
| Chart geometry + mark-spec helpers | `npx vitest run tests/viz-charts-geometry.test.ts` | 18/18 pass | PASS |
| De-box redesign static guards | `npx vitest run tests/viz-frontend-static.test.ts` | pass | PASS |
| Full viz surface (frontend static + palette invariants + settings panel + hud palette) | `npx vitest run tests/viz-stats-routes.test.ts tests/viz-charts-geometry.test.ts tests/viz-frontend-static.test.ts tests/viz-activity-palette-invariants.test.ts tests/viz-settings-panel.test.ts tests/viz-hud-palette.test.ts` | 160/160 pass | PASS |
| Full repo suite | `npx vitest run` | 2683 passed, 3 skipped, 180 files passed / 1 skipped | PASS |
| Typecheck | `npx tsc --noEmit` | clean, exit 0 | PASS |
| Founder live-install visual walkthrough | `60-HUMAN-UAT.md` | 8/8 passed, "not bad" (2026-07-14) | PASS |

### Requirements Coverage

Phase 60 has no formal REQUIREMENTS.md IDs mapped (ROADMAP says "TBD"). Plans instead track CONTEXT.md decision IDs D-01 through D-15, plus GAP-1 through GAP-4(a-f) from the two UAT gap-closure rounds.

| Decision | Description | Status | Evidence |
|----------|-------------|--------|----------|
| D-01 | Phase 59 HUD language, hard dependency | SATISFIED | `#stats-view` uses `--surface-index-panel`/HUD tokens; Phase 59 landed before Phase 60 per ROADMAP |
| D-02 | Full-window takeover, not a side panel | SATISFIED | `#stats-view` replaces `#graph`/`#corpus-graph` per corpus.js precedent |
| D-03 | Two tabs (Usage / Brain Health) | SATISFIED | Both tabs present and switchable via segmented `#stats-tabs` |
| D-04 | Settings readout replaced by an entry point | SATISFIED (revised) | Originally a settings-panel link; quick task 260714-g0s moved the entry point to `#rail-stats` per founder decision — verified wired |
| D-05 | Hand-rolled SVG, no chart library, no new deps | SATISFIED | `charts.js` confirmed, `package.json` unchanged |
| D-06 | Full analytics polish (axes, legends, hover, range scrubbing) | SATISFIED | Legend count now selective (5, per GAP-4d) — single-series charts drop legends by design, hover/range switcher unaffected |
| D-07 | Nearest-point hover | SATISFIED | `attachHover`/`nearestPointIndex` present and coordinate-fixed (CR-01), unaffected by mark-spec/de-box changes |
| D-08 | Series colors reuse Phase-57 identity hues; amber exclusive to live activation | SATISFIED | No amber in dashboard code |
| D-09 | Retail-$ = summed `total_cost_usd`, honestly labeled | SATISFIED (revised) | Format changed to 2 decimals per GAP-4b founder decision (documented in 60-11 key-decisions), label wording preserved |
| D-10 | Before/after savings from live event-marker deltas | SATISFIED | `lever_deltas` (60-08) surfaces this as a visible quiet table (GAP-2c/GAP-4e), not just hover |
| D-11 | `COST_EVENTS` single-source in constants.js | SATISFIED | `parseCostEvents` confirmed, no server re-declaration |
| D-12 | Default 30d window, daily buckets, range switcher, weekly all-time | SATISFIED | Confirmed |
| D-13 | Node growth derived from `consolidation_event`, approximation disclosed | SATISFIED | Event set corrected (CR-02); caption present |
| D-14 | All six brain-health metric groups must-have | SATISFIED | All six present, now small-multiples with shared `HEALTH_CHART_H` |
| D-15 | Refresh = on open + manual button, "as of" timestamp, no SSE | SATISFIED | Confirmed |
| GAP-1 | Responsive chart re-render | SATISFIED | Verified in re-verification section |
| GAP-2 | Usage tab redesign (stat tiles → hero, vs-typical, levers, collapsed breakdown) | SATISFIED | Verified in re-verification section |
| GAP-3 | Global styled scrollbar | SATISFIED | Verified in re-verification section |
| GAP-4 | De-box visual overhaul | SATISFIED | Verified in re-verification section |

No orphaned decision IDs found.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/viz/modules/charts.js` | 16-20 area | Docstring claims "never hard-codes a color" but builders have dead hard-coded hex defaults (IN-01) | Info | Cosmetic — all in-repo callers pass explicit colors; dead code only |
| `src/viz/server.ts` | ~121-134 | `parseCostEvents` regex fails soft on entry-format drift (IN-03) | Info | Would only trigger on a future hand-edit of constants.js introducing an apostrophe in a label |
| `src/viz/modules/stats-dashboard.js` | ~144-150 area | Range pills stay clickable on Brain-Health tab with no effect (IN-04) | Info | Minor UX confusion, not a correctness bug |
| `src/viz/modules/stats-dashboard.js` | ~433-441 area | `renderFeatureSplit` silently drops `'unknown'`-tagged ledger rows from the per-feature split (IN-05) | Info | Split total could under-sum the headline in an edge case |
| `src/viz/modules/stats-dashboard.js` | ~122-124 area | Stacked Escape handlers can close two overlays on one keypress (IN-06) | Info | Minor UX edge case |
| `tests/viz-charts-geometry.test.ts` | 91-95 area | Amber-ban guard only matches specific literals, not a hue heuristic (IN-07) | Info | Test-only gap, current source is clean |
| `src/viz/modules/app.js` | 257-259 | Wiring comment misattributes ordering constraint (IN-08) | Info | Comment-only, no functional impact |

IN-02 (`.chart-card-primary` inert class) is now moot — the class was fully removed by 60-11 Task 1, not merely left dormant. All remaining Info findings were explicitly out of `--fix` scope per 60-REVIEW.md and remain open by design (Info severity, not Warning/Critical). None block phase goal achievement. `grep -rniE "TBD|FIXME|XXX"` across all Phase-60-modified files (server.ts, constants.js, charts.js, stats-dashboard.js, index.html, styles.css, settings.js, hud.js, palette.js) returns no match.

### Human Verification Required

None. The founder's live-install visual walkthrough (previously the sole outstanding item) is complete — `60-HUMAN-UAT.md` frontmatter `status: passed`, 8/8, final sign-off "not bad" (2026-07-14).

### Gaps Summary

No gaps remain. All 15 automated truths from the original pass are verified against live source (truth 13 revised by a founder-directed entry-point change, itself verified). All 11 code-review fix commits remain confirmed at HEAD. All 4 UAT-surfaced gaps (responsive charts, Usage tab redesign, global scrollbar, AI-slop visual overhaul) are independently re-verified as closed in live source code — not taken on SUMMARY claim — including direct inspection of `charts.js` mark-spec functions, `stats-dashboard.js` retirement of `chart-card`/`makeCard`/`TREND_ARROW`, and `styles.css` global scrollbar/segmented-tab rules. The full test suite (2683 passed, 3 skipped) and `tsc --noEmit` are clean. The founder performed and signed off on the full UAT walkthrough across 2026-07-13/14, closing the one item that previously blocked `passed` status.

---

_Verified: 2026-07-14T14:10:00Z_
_Verifier: Claude (gsd-verifier)_
_Initial verification: 2026-07-11T21:37:43Z_
