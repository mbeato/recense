# Phase 60: Settings Stats Depth — Pattern Map

**Mapped:** 2026-07-11
**Files analyzed:** 6 (2 modified, 3-4 new modules, 1 shared-constants edit)
**Analogs found:** 6 / 6 (1 partial — no in-repo SVG-chart precedent, closest DOM-building analog substituted)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/viz/server.ts` (new `/stats/usage`, `/stats/brain-health` routes, or extended `/usage`) | route | request-response (read-only aggregate) | `src/viz/server.ts:416-441` (`stmtUsage30d`/`stmtUsageAllTime`) + `:1267-1311` (`GET /usage` handler) | exact |
| `src/viz/modules/stats-dashboard.js` (new — full-window takeover, name TBD; avoid colliding with existing `stats.js`) | component / provider | request-response (fetch on open) | `src/viz/modules/reader.js` (show/hide + documentElement class + fetch-on-open) | exact |
| `src/viz/modules/settings.js` (D-04 edit — replace readout block with link) | component | request-response | itself, `appendFullUsageReadout` block (lines 393-473) — edit in place | exact (self-edit) |
| `src/viz/modules/constants.js` (add `COST_EVENTS`, chart palette constants) | config | n/a (static data) | itself — `KIND_COLOR` / `HUD_CSS_TOKENS` blocks (lines 149-203, 673-801) | exact |
| SVG chart helper module (new, e.g. `src/viz/modules/charts.js`) | utility | transform (data → DOM/SVG) | no SVG-chart precedent in repo; closest DOM-building analog: `reader.js` `startGenProgress()` (lines 351-487, div-based bar/stepper builder) | partial — no analog |
| `src/viz/modules/palette.js` (append "Open usage stats" command) | provider (command registry) | event-driven | itself — `commands` array (lines 91-104), comment at line 90 anticipates this exact addition | exact |
| `src/viz/index.html` (new `#stats-dashboard` panel markup + tabs) | config (markup) | n/a | `#reader` / `#settings-panel` markup (lines 131-145) | exact |

## Pattern Assignments

### `src/viz/server.ts` — new stats routes (route, request-response)

**Analog:** `src/viz/server.ts:416-441` (prepared statements) + `:1267-1311` (handler)

**Prepared-statement pattern** (server.ts:416-441):
```typescript
// Compile /usage aggregate prepared statements once (44-05, D-09/D-10, T-44-18 read-only).
// Rolling-30d: WHERE ts > ? (caller passes Date.now() - 30d cutoff ms).
// All-time: no WHERE clause.
// Each row: feature_tag + per-token-column sums + total_cost_usd sum.
// GROUP BY feature_tag so each row maps 1:1 to a cost-bearing toggle in the panel (D-09).
const stmtUsage30d = db.prepare(`
  SELECT feature_tag,
         SUM(input_tokens)       AS input_tokens,
         SUM(output_tokens)      AS output_tokens,
         SUM(cache_write_tokens) AS cache_write_tokens,
         SUM(cache_read_tokens)  AS cache_read_tokens,
         SUM(total_cost_usd)     AS total_cost_usd
  FROM token_usage_ledger
  WHERE ts > ?
  GROUP BY feature_tag
`);
const stmtUsageAllTime = db.prepare(`
  SELECT feature_tag, SUM(input_tokens) AS input_tokens, ...
  FROM token_usage_ledger
  GROUP BY feature_tag
`);
```
New stats endpoints (daily-bucketed burn, per-model split, node growth from
`consolidation_event`, kind mix from `node`, judge escalation rate) compile as
additional `db.prepare(...)` calls in this same startup block, on the same
read-only `db` handle. Daily/weekly bucketing (D-12) can reuse the SQLite
idiom `strftime('%Y-%m-%d', ts/1000, 'unixepoch')` (or integer division on
`ts` ms) grouped alongside `feature_tag`/`event_type`/`model`.

**Handler pattern** (server.ts:1267-1311):
```typescript
// ── GET /usage (44-05, D-09/D-10) ────────────────────────────────────────
// Returns rolling-30d + all-time token totals broken down by feature_tag.
// Uses the read-only DB handle (T-44-18). Empty ledger → zeroed aggregates, not error.
if (url === '/usage') {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'text/plain' });
    res.end('method not allowed');
    return;
  }
  try {
    const cutoff30d = Date.now() - 30 * 86_400_000;
    const rows30d = stmtUsage30d.all(cutoff30d) as LedgerRow[];
    const rowsAll = stmtUsageAllTime.all() as LedgerRow[];
    const summarise = (rows: LedgerRow[]) => { /* zero-safe aggregate */ };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ window_days: 30, rolling_30d: summarise(rows30d), all_time: summarise(rowsAll) }));
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('internal error');
  }
  return;
}
```
New routes (`GET /stats/usage?window=7d|30d|90d|all`, `GET /stats/brain-health`)
copy this exact shape: `url === '/stats/...'` string match against
`(req.url ?? '/').split('?')[0]`, method guard → 405, try/catch → 500
`'internal error'` (never leak SQL/stack — T-44-17), empty-input → zeroed
aggregate object rather than an error (empty-DB / fresh-install requirement
from CONTEXT Claude's Discretion). Query params (`window`) parse via
`new URLSearchParams(req.url?.split('?')[1] ?? '')` (server.ts:809, 887, 933,
1004 — repeated idiom throughout this file).

**Route registration point:** insert new `if (url === '/stats/...')` blocks
directly after the existing `/usage` block (server.ts ~1311), before
`POST /doc/generate`. Same loopback/DNS-rebinding 403 guard at the top of the
`http.createServer` callback (server.ts:656-659) already covers every route —
no per-route guard duplication needed.

**Header comment block:** add each new endpoint's one-line summary to the
route list at the top of the file (server.ts:4-21) — every existing route is
documented there; this phase's routes should follow the same
`GET /path?params → {shape}` one-liner convention with a phase tag.

---

### `src/viz/modules/stats-dashboard.js` (new full-window takeover module)

**Analog:** `src/viz/modules/reader.js` (show/hide/open/close plumbing)

**Show/hide + documentElement-class pattern** (reader.js:140-186, mirrored simpler in settings.js:44-60):
```javascript
function show() {
  panel.classList.add('open');
  document.documentElement.classList.add('reader-open');
  if (!loaded) { load(); loaded = true; }
}

function hide() {
  panel.classList.remove('open');
  document.documentElement.classList.remove('reader-open');
  // ... provenance-specific return-to-underlying-view logic
}

ctx.closeReader = function closeReader() { hide(); };
ctx.isReaderOpen = function isReaderOpen() { return panel.classList.contains('open'); };
```
The new module exposes `ctx.openStatsDashboard()` / `ctx.closeStatsDashboard()`
/ `ctx.isStatsDashboardOpen()` following this exact naming/shape convention
(compare `ctx.openReader`/`ctx.closeReader`/`ctx.isReaderOpen`,
`ctx.openCorpus`/`ctx.isCorpusOpen`). Since D-02 makes this a route-level
takeover that **replaces the graph** (not an overlay panel like settings),
model `show()`/`hide()` on corpus.js's `goToCorpus()`/`goToBrain()` pattern
(hide `#corpus-graph`/3D canvas, show the new `#stats-dashboard` full-window
div) rather than reader.js's slide-in overlay — reader.js is the correct
analog for the *open/close plumbing and ctx exposure*, corpus.js for the
*graph-replacing full-window swap*.

**Non-fatal fetch-on-open pattern** (settings.js:69-101, mirrors reader.js `fetchMeta`):
```javascript
async function load() {
  if (!bodyEl) return;
  bodyEl.textContent = 'loading…';
  const [settingsData, usageData] = await Promise.all([fetchSettings(), fetchUsage()]);
  render(settingsData, usageData);
}

async function fetchSettings() {
  try {
    const res = await fetch('/settings');
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}
```
D-15 (refresh = on open + manual refresh button) extends this by re-invoking
the same `load()`/fetch pair from a refresh button's click handler and
stamping an "as of" `Date.now()` timestamp — no new pattern needed, same
non-fatal try/catch-return-null shape for every stats fetch.

**Escape-to-close** (reader.js:195-197, settings.js:62-65):
```javascript
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && panel.classList.contains('open')) hide();
});
```

**Two-tab structure (D-03):** no existing tab-switcher precedent in this
codebase — build as two sibling content divs toggled via a small
`currentTab` string + two header buttons calling
`classList.toggle('active', tab === name)`, styled with the Phase 59
`HUD_CSS_TOKENS` glass/radius tokens (constants.js:673-801). This is new UI,
not copied from an analog — flag to the planner as net-new interaction code.

**Security:** every dynamic value (dates, counts, dollar figures, feature
labels) MUST use `.textContent`, never `.innerHTML` with server data — see
T-44-19 in settings.js (comments on nearly every render line, e.g. lines
114, 132, 380-382, 431-432, 454-458, 468-469) and T-27-08/T-27-12 in
reader.js (lines 25-28, 561, 605, 615). The only `innerHTML` uses in this
codebase are (a) `renderMarkdown` pure-string output after `escapeHtml`
(reader.js:286) and (b) static hardcoded icon-SVG template literals
(corpus.js:30,34; index.js:30-31) — never with interpolated server data.

---

### `src/viz/modules/settings.js` (D-04 edit)

**Analog:** itself — replace `appendFullUsageReadout` (lines 393-473) call
site and body.

**Current block to remove/replace** (settings.js:255-256, 393-473):
```javascript
// ── Token usage readout (D-09 / D-10) ─────────────────────────────────────
appendFullUsageReadout(bodyEl, usageData);
```
Replace the call (and the now-dead `appendFullUsageReadout` function body,
lines 393-473, minus whatever `appendUsageLines` per-toggle lines D-09 still
needs — those stay, only the standalone 30d/all-time readout section goes)
with a single link row:
```javascript
const link = document.createElement('a');
link.className = 'settings-usage-link'; // new class, styled per Phase 59 tokens
link.href = '#';
link.textContent = 'View usage stats →'; // textContent — T-44-19
link.addEventListener('click', ev => {
  ev.preventDefault();
  if (typeof ctx.openStatsDashboard === 'function') ctx.openStatsDashboard();
});
bodyEl.appendChild(link);
```
Note `initSettings(_ctx)` currently takes `_ctx` (underscore-prefixed,
unused — settings.js:34). This edit requires renaming the param to `ctx` and
threading it through since `ctx.openStatsDashboard` is now needed inside
`render()`. `appendUsageLines` (per-toggle inline usage, lines 364-384) is
explicitly kept per CONTEXT (D-04 only removes the "30d/all-time number
block", not the per-toggle cost lines — those stay as the toggle-adjacent
context D-09 established).

---

### `src/viz/modules/constants.js` (COST_EVENTS + chart palette)

**Analog:** itself — `KIND_COLOR` (lines 145-203) for the array-of-tagged-
values shape, `HUD_CSS_TOKENS` (673-801) for the flat-object-with-inline-
rationale-comments convention.

**COST_EVENTS array (D-11):**
```javascript
/**
 * Dated cost-lever markers rendered on the daily-burn chart (D-10, D-11).
 * New events = one-line addition here — no code change elsewhere.
 * @type {{date: string, label: string}[]}
 */
export const COST_EVENTS = [
  { date: '2026-07-03', label: 'MAX_THINKING_TOKENS=0' },
  { date: '2026-06-XX', label: 'consolSkipThreshold tuned (Phase 42)' }, // exact date TBD from git history
];
```
Follows the `TYPE_COLOR`/`KIND_COLOR` convention of a plain exported const
object/array with a leading JSDoc `@type` and per-entry rationale comment —
same file, same section-header banner style (`// ===...=== \n// Section name`).

**Chart palette (D-08):** reuse `KIND_COLOR` entries directly for
activity-kind series (`reconsolidation` → magenta/rose-mauve `0xd9a0bd`,
`new_node` → sage-green `0x8fbf9e`, etc. — already luminance-equalized and
amber-excluded per Phase 57 D-02/D-04 invariants tested in
`tests/viz-activity-palette-invariants.test.ts`). Non-activity series
(tokens, models, features) need a **new** desaturated aubergine-family ramp
constant (e.g. `CHART_NEUTRAL_RAMP`), added beside `KIND_COLOR` following
the same locked-hue-with-comment convention — must NOT reuse or resemble
`accent-amber-*` tokens (HUD_CSS_TOKENS:741-745) per D-08's amber-exclusivity
rule.

---

### SVG chart helper module (new — no analog)

**Closest DOM-building analog:** `src/viz/modules/reader.js`
`startGenProgress()` (lines 351-487) — the only precedent in this codebase
for programmatically building small data-driven visual widgets
(step/progress bars) via `document.createElement` + `style.width` percentage
fills + `textContent`-only labels, updated on a tick/interval.

```javascript
// reader.js:383-386 — div-based fill-bar pattern (NOT SVG, but the closest
// "render a value as a filled bar" precedent in the repo):
const stepFill = document.createElement('div');
stepFill.className = 'doc-progress-step-fill';
stepTrack.appendChild(stepFill);
// ...
fill.style.width = (f * 100).toFixed(1) + '%';
```

No `createElementNS('http://www.w3.org/2000/svg', ...)` usage exists
anywhere in `src/viz/modules/*.js` — all existing inline `<svg>` in this
codebase are **static hardcoded icon strings** assigned via
`.innerHTML = ICON_X` (corpus.js:30,34; index.js:30-31; index.html:69,78,87,97),
never built from data. D-05's hand-rolled SVG chart helpers (bars, lines,
sparklines) are genuinely new code with no in-repo precedent to copy. When
building them:
- Use `document.createElementNS(SVG_NS, 'rect'|'line'|'path'|'circle')`
  (never `innerHTML` with interpolated coordinates from data — even though
  numeric coordinates are low-risk, keep the same textContent-only
  discipline the rest of the codebase enforces for anything DB-sourced;
  labels/tooltips on data points MUST use `.textContent`).
- Model the widget-builder shape (build-DOM-tree function returning an
  element, called fresh per render, no diffing) on `startGenProgress`'s
  return-an-API-object pattern (`{ stop, done, update }`) if the chart needs
  live updates (e.g. hover tooltip D-07) — otherwise a pure
  `data → SVGElement` function (mirroring the pure `renderMarkdown(md)` →
  string function in reader.js:69-97, which is unit-tested in Node with no
  DOM) is the cleaner fit for static-per-render charts.
- Styling goes through the design-token CSS per D-05 — reference
  `HUD_CSS_TOKENS`/`css-tokens.js`'s `emitHudTokens()` pattern
  (constants.js:669-671) for how JS-authored constants become CSS custom
  properties consumed by SVG `stroke`/`fill` via `var(--token-name)`.

---

### `src/viz/modules/palette.js` (append command)

**Analog:** itself — `commands` array (lines 91-104); the file's own comment
(line 90) explicitly anticipates this exact change: *"Extensible: Phase 60's
'Open usage stats' appends without structural change."*

```javascript
const commands = [
  // ...existing entries...
  { id: 'open-settings', label: 'Open settings',
    run: () => { const btn = document.getElementById('btn-settings'); if (btn) btn.click(); } },
  { id: 'open-reader', label: 'Open reader',
    run: c => { if (c.openReader) c.openReader(); } },
  // NEW — Phase 60:
  { id: 'open-stats', label: 'Open usage stats',
    run: c => { if (c.openStatsDashboard) c.openStatsDashboard(); } },
];
```
`visibleIn` is optional (omit to show in every view, matching `open-settings`/
`open-reader`). `currentView()` (palette.js:111-115) may need a `'stats'`
branch added alongside `'corpus'`/`'reader'`/`'brain'` if the dashboard
should be excluded from its own command list while open (mirrors how
`readerIsOpen()` gates the `open-reader` command's relevance) — Claude's
Discretion per CONTEXT.

---

## Shared Patterns

### Read-only DB handle + prepared-statement-once discipline
**Source:** `src/viz/server.ts` (opened `{ readonly: true }`, T-10-08; all
`db.prepare(...)` calls happen once at server-startup scope, not per-request)
**Apply to:** every new stats query in server.ts.

### Non-fatal fetch (never throw on network/parse failure)
**Source:** `src/viz/modules/settings.js:81-101`, `reader.js:495-516`
```javascript
async function fetchX() {
  try {
    const res = await fetch('/path');
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}
```
**Apply to:** every stats-dashboard fetch call (usage, brain-health, refresh).

### textContent-only for server-sourced values (T-44-19 / T-27-08/12)
**Source:** `src/viz/modules/settings.js` (near-every render line),
`src/viz/modules/reader.js:25-28`
**Apply to:** every dashboard number, date, label, tooltip string, axis tick.

### Loopback / DNS-rebinding guard (T-10-09, T-44-16)
**Source:** `src/viz/server.ts:656-659` (applies to the whole
`http.createServer` callback before any route dispatch)
**Apply to:** automatically covers new routes — no per-route action needed,
but confirm new routes are added *inside* the existing dispatch function,
not a separate server/listener.

### Error handling: catch → 500 'internal error', never leak details (T-44-17)
**Source:** `src/viz/server.ts:1156-1160`, `:1253-1256`, `:1306-1309`
```typescript
try {
  // ... query + JSON.stringify response
} catch {
  res.writeHead(500, { 'content-type': 'text/plain' });
  res.end('internal error');
}
```
**Apply to:** all new stats route handlers.

### Design tokens (Phase 59 glass/radius/motion + Phase 57 identity hues)
**Source:** `src/viz/modules/constants.js` `HUD_CSS_TOKENS` (673-801) and
`KIND_COLOR` (145-203)
**Apply to:** all new dashboard chrome (panel glass, tabs, buttons) and all
activity-kind chart series (D-08).

### Module wiring (app.js registration order)
**Source:** `src/viz/modules/app.js:23-40` (imports) and the `initX(ctx)`
call sequence around line 252-255
```javascript
import { initReader }  from './reader.js';
// ...
initReader(ctx);
initCorpus(ctx);
initSettings(ctx);
```
**Apply to:** the new stats-dashboard module — import + `initStatsDashboard(ctx)`
call inserted after `initSettings(ctx)` (so `ctx.openStatsDashboard` exists
before `initSettings` needs to reference it in the D-04 link — note: JS
function hoisting inside `initSettings`'s click handler makes call order here
non-critical since the reference is read lazily at click time, not at
`initSettings()` call time; still, keep it near `initSettings`/`initReader`
for readability). Also register import + init call in `palette.js`'s
existing wiring (palette.js already imported/init'd in app.js — only the
`commands` array changes, no new app.js wiring for that file).

## No Analog Found

| File/Concern | Role | Data Flow | Reason |
|---|---|---|---|
| SVG chart helpers (bars/lines/sparklines, hover tooltips, axis ticks, time-range scrubber) | utility | transform | No `createElementNS`/SVG-building code anywhere in the repo; only static hardcoded icon-SVG strings exist. Closest DOM-widget-builder precedent is reader.js's div-based progress bar (see above) — structurally similar (build tree, set textContent, style-driven fill) but not SVG and not chart-shaped. Net-new code. |
| Two-tab (Usage \| Brain Health) switcher UI | component | event-driven | No tab-pattern precedent exists in this codebase (settings/reader/corpus are all single-surface panels). Build from Phase 59 HUD tokens; simple `classList.toggle('active', ...)` state, no analog needed beyond that. |
| "Last sleep-pass time/duration/status" data source | n/a (data-source research) | n/a | No dedicated persisted record exists. Searched `meta` table usage (schema.ts:67-70, unused by any writer found), `src/adapter/sleep-pass-cli.ts`, `src/adapter/lockfile.ts` (mtime-based staleness only, not a history log), `src/adapter/recense-scheduler.ts` — none persist a queryable last-run timestamp/duration/status row. The nearest derivable proxies, consistent with D-13's "derive from existing tables, no new write path" spirit: `MAX(ts)` on `consolidation_event` (last consolidation activity) and/or `MAX(ts)` on `token_usage_ledger` WHERE `feature_tag IN ('extract','judge','schema_abstract','corpus_gen')` (last LLM call in a pass), with duration approximated as the span between a batch's first and last `ts`. No "status" (success/failure) signal is derivable from existing tables at all — flag this gap explicitly to the planner; it may need a Claude's-Discretion call to either (a) approximate status as "completed" whenever the derived last-activity timestamp is fresh, or (b) mark status as "unknown" honestly (consistent with the project's no-inflated-metrics/honest-labeling posture, D-13's "chart labels the approximation"). |

## Metadata

**Analog search scope:** `src/viz/server.ts`, `src/viz/modules/*.js`,
`src/viz/index.html`, `src/db/schema.ts`, `src/adapter/sleep-pass-cli.ts`,
`src/adapter/lockfile.ts`, `src/adapter/recense-scheduler.ts`,
`src/db/event-store.ts`, `src/consolidation/*.ts` (grep only, for
consolidation_event query precedent — none found).
**Files scanned:** ~20 (full reads: server.ts sections, schema.ts:1-200,
stats.js, reader.js, settings.js, constants.js, index.js, palette.js
excerpt; grep-only: app.js, corpus.js, event-store.ts, lockfile.ts,
sleep-pass-cli.ts, recense-scheduler.ts).
**Pattern extraction date:** 2026-07-11
