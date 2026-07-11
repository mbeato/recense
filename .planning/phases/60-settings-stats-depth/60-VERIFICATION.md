---
phase: 60-settings-stats-depth
verified: 2026-07-11T21:37:43Z
status: human_needed
score: 15/15 must-haves verified (automated); 1 outstanding human sign-off item
overrides_applied: 0
human_verification:
  - test: "Founder live-install visual walkthrough (60-06 Task 2, 8 steps)"
    expected: "Both tabs render against real data, read as Phase-59-native (flat surface, no glass), are amber-free, cost-event marker hover shows before/after deltas, range pills rescope charts (all-time → weekly), refresh updates the 'as of' stamp, Brain Health identity hues are correct, last-sleep-pass status reads honestly, nothing leaks into the compact/tray popover LOD"
    why_human: "Visual appearance, hover-interaction feel, and color-identity correctness on a live install cannot be verified by static analysis; 60-06-SUMMARY.md explicitly records this checkpoint as auto-approved via --chain auto-mode, not an actual human walkthrough — the 8-step checklist was never executed by the founder"
---

# Phase 60: Settings Stats Depth — usage + brain-health Verification Report

**Phase Goal:** The settings surface grows two real dashboards replacing the bare usage readout. (1) Cost/usage: daily token burn, per-feature split (extract/judge/corpus_gen/schema_abstract), per-model, retail-$ equivalent, and before/after savings framing — all from token_usage_ledger, rendered live. (2) Brain-health: node growth over time, kind mix, reconsolidations + tombstones per day, judge activity (fires, escalation rate), episodes pending vs consolidated, last sleep-pass time/duration/status. LLM-free queries only (online-path constraint); charts in the scene's design language per Phase 59 conventions.

**Verified:** 2026-07-11T21:37:43Z
**Status:** human_needed
**Re-verification:** No — initial verification

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
| 13 | Settings panel's 30d/all-time readout replaced by a single `View usage stats →` link; per-toggle usage lines retained (D-04) | VERIFIED | `settings.js` — `appendFullUsageReadout` deleted (no match), `appendUsageLines` retained (3 call sites), `.settings-usage-link` styled in `styles.css:1184-1192` |
| 14 | ⌘K palette command `Open stats` opens the takeover | VERIFIED | `palette.js:105` — `{ id:'open-stats', label:'Open stats', ... run: c => c.openStatsDashboard() }` |
| 15 | Nothing leaks into the compact/tray popover LOD | VERIFIED | `#stats-view { display: none; }` present inside the `@media (max-width: 500px)` compact-hide block (`styles.css:550`) |

**Score:** 15/15 automated truths verified. One additional truth — the founder's live-install look-and-feel sign-off — is a Step-8 human-verification item (see below), not a failed truth; it was deliberately deferred, not skipped silently.

### Code Review Fix Verification (60-REVIEW.md, 11 Critical+Warning findings claimed fixed)

All 11 fixes were independently re-verified against HEAD (`0c4627e`), not taken on SUMMARY/REVIEW claim:

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
| WR-06 | `.settings-usage-link` CSS rule exists | `styles.css:1184-1192` — CONFIRMED |
| WR-07 | Settings overrides use replace semantics (not merge) | `server.ts:1391-1397` — `overrides: newOverrides ?? current.overrides` with explanatory comment on one-way-ratchet fix — CONFIRMED |

All 11 fix commits (`7ff8b87`..`a35e6ba`) present in `git log`. No claim taken on trust — every fix independently grepped/read at HEAD.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/viz/server.ts` | `/stats/usage` + `/stats/brain-health` routes, prepared statements, `parseCostEvents` | VERIFIED | Both handlers present, wired, tested |
| `src/viz/modules/constants.js` | `COST_EVENTS`, `NEUTRAL_SERIES_RAMP`, `chart-card` token | VERIFIED | All three present, amber-free |
| `src/viz/modules/charts.js` | SVG chart helper module | VERIFIED | `createElementNS`-based, no chart lib, no innerHTML |
| `src/viz/modules/stats-dashboard.js` | Full takeover shell + both tabs | VERIFIED | 800+ lines; both tabs render from live fetch data |
| `src/viz/index.html` | `#stats-view` host markup | VERIFIED | Tabs, range pills, refresh, as-of, close all present |
| `src/viz/css/styles.css` | Flat surface + compact-hide | VERIFIED | No backdrop-filter on `#stats-view` block; compact-hidden |
| `src/viz/modules/settings.js` | D-04 link replacement | VERIFIED | Link present, old readout removed, per-toggle lines kept |
| `src/viz/modules/palette.js` | `open-stats` command | VERIFIED | Present, self-hides when stats already open |
| `tests/viz-stats-routes.test.ts` | Route contract tests | VERIFIED | 13 tests green |
| `tests/viz-charts-geometry.test.ts` | Chart helper tests | VERIFIED | 13 assertions green |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `stats-dashboard.js` | `/stats/usage` | `fetch` on open/range-change/refresh | WIRED | Confirmed at line 176 |
| `stats-dashboard.js` | `/stats/brain-health` | `fetch` on tab activation/refresh | WIRED | Confirmed at line 186 |
| `app.js` | `initStatsDashboard(ctx)` | init call after `initSettings(ctx)` | WIRED | Confirmed at line 257 |
| `settings.js` link | `ctx.openStatsDashboard` | click handler | WIRED | Confirmed, `typeof`-guarded |
| `palette.js` `open-stats` | `ctx.openStatsDashboard` | `run(c)` | WIRED | Confirmed |
| `server.ts` `/stats/*` | `parseCostEvents(constants.js)` | startup source-parse | WIRED | Single-source per D-11, no re-declared literal |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|---------------------|--------|
| `renderUsageTab` | `data.buckets`/`by_feature`/`by_model`/`retail_usd`/`cost_event_deltas` | `GET /stats/usage` response | SQL aggregates over `token_usage_ledger` with real `db.prepare` GROUP BY queries (not static returns) | FLOWING |
| `renderHealthTab` | `data.node_growth`/`kind_mix`/etc. | `GET /stats/brain-health` response | SQL aggregates over `consolidation_event`/`node`/`episode` (verified query text) | FLOWING |
| Settings link / palette command | n/a (navigation only) | n/a | n/a | N/A |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Route contract (seeded + empty DB + guards) | `npx vitest run tests/viz-stats-routes.test.ts` | 13/13 pass | PASS |
| Chart geometry helpers | `npx vitest run tests/viz-charts-geometry.test.ts` | pass | PASS |
| Full viz surface (frontend static + palette invariants + settings panel + hud palette) | `npx vitest run tests/viz-frontend-static.test.ts tests/viz-activity-palette-invariants.test.ts tests/viz-settings-panel.test.ts tests/viz-hud-palette.test.ts` | pass | PASS |
| Full repo suite | `npx vitest run` | 2672 passed, 3 skipped, 180 files passed / 1 skipped | PASS |
| Typecheck | `npx tsc --noEmit` | clean, exit 0 | PASS |
| Live server route smoke (visual/behavioral) | `recense viz` + curl `/stats/usage`, `/stats/brain-health` | Per 60-06-SUMMARY.md: 200 with real data on all checked routes | PASS (documented in SUMMARY, consistent with route-level test coverage — not independently re-run in this verification pass since it requires a live server process) |

### Requirements Coverage

Phase 60 has no formal REQUIREMENTS.md IDs mapped (ROADMAP says "TBD"). Plans instead track CONTEXT.md decision IDs D-01 through D-15.

| Decision | Description | Status | Evidence |
|----------|-------------|--------|----------|
| D-01 | Phase 59 HUD language, hard dependency | SATISFIED | `#stats-view` uses `--surface-index-panel`/HUD tokens; Phase 59 landed before Phase 60 per ROADMAP |
| D-02 | Full-window takeover, not a side panel | SATISFIED | `#stats-view` replaces `#graph`/`#corpus-graph` per corpus.js precedent |
| D-03 | Two tabs (Usage / Brain Health) | SATISFIED | Both tabs present and switchable |
| D-04 | Settings readout replaced by a link | SATISFIED | Verified above |
| D-05 | Hand-rolled SVG, no chart library, no new deps | SATISFIED | `charts.js` confirmed, `package.json` unchanged |
| D-06 | Full analytics polish (axes, legends, hover, range scrubbing) | SATISFIED | axis(18)/legend(11) call sites, hover wired, range switcher present |
| D-07 | Nearest-point hover | SATISFIED | `attachHover`/`nearestPointIndex` present and coordinate-fixed (CR-01) |
| D-08 | Series colors reuse Phase-57 identity hues; amber exclusive to live activation | SATISFIED | No amber in dashboard code; `KIND_COLOR`/`TYPE_COLOR` used |
| D-09 | Retail-$ = summed `total_cost_usd`, honestly labeled | SATISFIED | `RETAIL_LABEL` verbatim, `toFixed(4)` |
| D-10 | Before/after savings from live event-marker deltas | SATISFIED | `cost_event_deltas` computed server-side over real buckets; out-of-window markers now skipped (WR-03) |
| D-11 | `COST_EVENTS` single-source in constants.js | SATISFIED | `parseCostEvents` confirmed, no server re-declaration |
| D-12 | Default 30d window, daily buckets, range switcher, weekly all-time | SATISFIED | Confirmed; weekly bucket date-key bug fixed (60-03 deviation) |
| D-13 | Node growth derived from `consolidation_event`, approximation disclosed | SATISFIED | Event set corrected (CR-02); `approximate:true` + caption present |
| D-14 | All six brain-health metric groups must-have | SATISFIED | All six present and rendering |
| D-15 | Refresh = on open + manual button, "as of" timestamp, no SSE | SATISFIED | Confirmed, no `EventSource`/polling timer |

No orphaned decision IDs found — REQUIREMENTS.md has no Phase 60 mapping to cross-reference, and every D-01..D-15 decision maps to at least one plan's `requirements` frontmatter.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/viz/modules/charts.js` | 16-20, 173, 193, 228, 281, 304 | Docstring claims "never hard-codes a color" but builders have dead hard-coded hex defaults (IN-01) | Info | Cosmetic — all in-repo callers pass explicit colors; dead code only |
| `src/viz/modules/stats-dashboard.js` | 360, 536 | `.chart-card-primary` class set in JS, no CSS rule (IN-02) | Info | Inert class, no visual regression |
| `src/viz/server.ts` | 121-134 | `parseCostEvents` regex fails soft on entry-format drift (IN-03) | Info | Would only trigger on a future hand-edit of constants.js introducing an apostrophe in a label |
| `src/viz/modules/stats-dashboard.js` | 144-150 | Range pills stay clickable on Brain-Health tab with no effect (IN-04) | Info | Minor UX confusion, not a correctness bug |
| `src/viz/modules/stats-dashboard.js` | 433-441 | `renderFeatureSplit` silently drops `'unknown'`-tagged ledger rows from the per-feature split (IN-05) | Info | Split total could under-sum the headline in an edge case |
| `src/viz/modules/stats-dashboard.js` | 122-124 | Stacked Escape handlers can close two overlays on one keypress (IN-06) | Info | Minor UX edge case |
| `tests/viz-charts-geometry.test.ts` | 91-95 | Amber-ban guard only matches specific literals, not a hue heuristic (IN-07) | Info | Test-only gap, current source is clean |
| `src/viz/modules/app.js` | 257-259 | Wiring comment misattributes ordering constraint (IN-08) | Info | Comment-only, no functional impact |

All 8 Info findings were explicitly out of `--fix` scope per 60-REVIEW.md and remain open by design (Info severity, not Warning/Critical). None block phase goal achievement. No unresolved `TBD`/`FIXME`/`XXX` debt markers found in any Phase-60-modified file (`grep -rn "TBD\|FIXME\|XXX"` across the key-files lists returns no match).

### Human Verification Required

### 1. Founder live-install visual walkthrough

**Test:** Follow the 8-step checklist preserved verbatim in `60-06-SUMMARY.md` — start `recense viz`, open settings → `View usage stats →`, confirm Usage tab (focal burn chart, cost-event markers + before/after delta on hover, per-feature/per-model splits, retail-$ headline copy), switch range pills (confirm all-time weekly buckets), click refresh (confirm `as of` stamp updates), switch to Brain Health (confirm all six metric groups in identity hues, node-growth caption, honest last-sleep-pass status), confirm no amber/no glass anywhere, Escape/× closes back to the brain, also open via ⌘K → `Open stats`, confirm nothing leaks into compact/tray popover LOD.

**Expected:** Both dashboards render correctly against real data, read as visually native to the Phase-59 HUD language, and match every honest-labeling and color-identity requirement in the UI-SPEC.

**Why human:** This is a visual/interaction quality check (chart legibility, color correctness, hover feel, glass-vs-flat surface distinction) that cannot be verified by static code analysis. Critically, `60-06-SUMMARY.md` itself is explicit that this checkpoint was **auto-approved via `--chain` auto-mode** and the founder has **not yet performed the walkthrough** — this is not a borderline case where grep-based verification is merely "uncertain," it is a documented, acknowledged gap in the phase's own closing summary.

### Gaps Summary

No automated must-have failed. All 15 derived observable truths (roadmap goal + the 6 plans' frontmatter must_haves + CONTEXT.md D-01..D-15) are verified against live source code, not SUMMARY claims — including independent re-verification of all 11 code-review fix commits at HEAD. The full test suite (2672 tests) and `tsc --noEmit` are clean.

The single outstanding item is the founder's live-install visual sign-off (60-06 Task 2), which the phase's own SUMMARY.md honestly records as not yet performed (auto-approved procedurally under `--chain` mode rather than substituted with a real walkthrough). Per the task brief, this routes to `human_needed` rather than `passed` — it is a legitimate, disclosed gap in an otherwise goal-achieving phase, not a fabricated pass.

---

_Verified: 2026-07-11T21:37:43Z_
_Verifier: Claude (gsd-verifier)_
