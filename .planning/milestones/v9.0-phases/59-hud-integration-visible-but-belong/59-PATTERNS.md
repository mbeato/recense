# Phase 59: HUD Integration — Pattern Map

**Mapped:** 2026-07-05
**Files analyzed:** 13 (3 new, 8 modified, 1 test file extended, `index.html`/`styles.css` counted separately below)
**Analogs found:** 13 / 13 (all files have a strong in-repo analog — this phase is a reskin/consolidation of existing working modules, not new-subsystem construction)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `src/viz/modules/palette.js` (NEW) | component/provider (vanilla ESM module, DOM-owning) | request-response (BM25 fetch) + event-driven (keyboard/click) | `src/viz/modules/search.js` (fetch/debounce/render shape) + `src/viz/modules/settings.js` (show/hide/Escape shape) | exact (composite of two proven modules) |
| `src/viz/modules/hud-recede.js` (NEW, or folded into `hud.js`) | utility/provider (opacity-state driver) | event-driven (idle timer + camera-flight polling) | `src/viz/modules/stats.js` (`updateIdleDrift`, idle-gated per-frame behavior) | role-match |
| `src/viz/modules/constants.js` (MODIFY — extend) | config | transform (pure named exports, no runtime behavior) | itself — existing `IDLE_FPS`/`CAM_POS_LAMBDA`-style named-export convention | exact |
| `src/viz/modules/hud.js` (MODIFY) | controller (SSE/log/tombstone wiring) | event-driven (SSE) + request-response (none new) | itself — re-homing existing logic, no analog needed outside itself | exact |
| `src/viz/modules/search.js` (MODIFY — strip DOM, keep fetch) | service (fetch/debounce logic) | request-response | itself (being refactored, not replaced) | exact |
| `src/viz/modules/topics.js` (MODIFY — factor shared helper) | service (in-memory list builder) | CRUD (read-only, in-memory) | itself | exact |
| `src/viz/modules/settings.js` (MODIFY — CSS classes only) | controller (panel show/hide) | request-response (`/settings`, `/usage` fetch) | itself; also the canonical show/hide/Escape precedent for `palette.js`/`reader.js` | exact |
| `src/viz/modules/camera.js` (MODIFY — add `ctx.isCameraInFlight()`) | service (camera state) | event-driven | itself | exact |
| `src/viz/modules/stats.js` (MODIFY — add `ctx.msSinceActive()`) | service (idle/activity state) | event-driven | itself | exact |
| `src/viz/index.html` (MODIFY — DOM restructure) | template/markup | request-response (static) | itself (existing `#panel`/`#detail`/`#settings-panel`/`#reader` blocks are the precedent for the new chip/rails/palette blocks) | exact |
| `src/viz/css/styles.css` (MODIFY — full token migration + glass reskin) | config/style | transform | itself (`#panel`, `#detail` existing glass-ish rules are the formalization target) | exact |
| `tests/viz-activity-palette-invariants.test.ts` (MODIFY — extend) | test | batch (source-parse assertions) | itself — existing D-10 `describe` block is the template for new D-14/D-11 blocks | exact |
| `apps/tray/src/popover.ts` (READ-ONLY REFERENCE — icon style source) | component | request-response | n/a — reference only, not modified this phase | n/a |

## Pattern Assignments

### `src/viz/modules/palette.js` (NEW — component/provider, request-response + event-driven)

**Analog 1 (fetch/debounce/render/keyboard):** `src/viz/modules/search.js`
**Analog 2 (show/hide/open-state/Escape):** `src/viz/modules/settings.js`

**Header/JSDoc convention to copy** (`search.js` lines 1-30):
```javascript
/**
 * @module search
 * recense viz — in-app incremental node search (Plan 19-01 / VIZ-07, ...)
 *
 * initSearch(ctx) implements:
 *   - ...bullet list of ctx fields exposed...
 *
 * Security:
 *   T-10-12: result rows + count set via textContent; never innerHTML with user data.
 *
 * Palette invariants:
 *   HOT amber (#ffb866) appears ONLY on Three.js node materials via ctx.activate.
 *   HTML chrome stays muted (amber only as a focus/hover border tint). No cyan.
 */
```
`palette.js` should carry the same shape: module doc comment, bullet list of `ctx` fields it exposes/consumes, an explicit Security note (textContent-only), and an explicit palette-invariant note (no amber fill/background).

**Fetch + debounce + sequence-guard pattern to copy VERBATIM** (`search.js` lines 32-33, 102-132):
```javascript
const DEBOUNCE_MS = 200;
const MAX_ROWS    = 20;   // server already caps SEARCH_LIMIT=20; mirror it client-side

async function runSearch() {
  const value = inputEl.value.trim();
  if (value.length < 2) { resetResults(); return; }

  const mySeq = ++seq;
  let ids;
  try {
    const resp = await fetch('/search?q=' + encodeURIComponent(value));
    if (!resp.ok) throw new Error('status ' + resp.status);
    ids = await resp.json();
  } catch (_) {
    if (mySeq === seq && ctx.showToast) ctx.showToast('search unavailable — try again');
    return;
  }
  if (mySeq !== seq) return;  // a newer keystroke superseded this response
  // ... resolve ids via ctx.idMap, matchNodes = []
}
```
The sequence-guard (`mySeq === seq`) is the one non-obvious correctness detail — copy it exactly, do not reimplement. `PALETTE_CAP_NODES = 8` (per UI-SPEC) replaces `MAX_ROWS` for display purposes but the fetch/debounce/guard shape is identical.

**Render pattern (textContent-only, `createElement` fragments)** (`search.js` lines 58-80):
```javascript
function renderResults() {
  if (!resultsEl) return;
  resultsEl.textContent = '';
  matchNodes.slice(0, MAX_ROWS).forEach((node, i) => {
    const row = document.createElement('div');
    row.className = 'result-row';
    row.setAttribute('role', 'option');
    const label = document.createElement('span');
    label.textContent = (node.value || node.id || '').slice(0, 80);
    row.appendChild(label);
    row.addEventListener('click', () => pick(i));
    resultsEl.appendChild(row);
  });
}
```

**Show/hide/open-state pattern to copy** (`settings.js` lines 34-65):
```javascript
export function initSettings(_ctx) {
  const panel = document.getElementById('settings-panel');
  if (!panel) return;   // graceful no-op — copy this guard shape for palette.js too

  let loaded = false;

  function show() {
    panel.classList.add('open');
    document.documentElement.classList.add('settings-panel-open');
    if (!loaded) { load(); loaded = true; }
  }
  function hide() {
    panel.classList.remove('open');
    document.documentElement.classList.remove('settings-panel-open');
  }

  if (btn) btn.addEventListener('click', () =>
    panel.classList.contains('open') ? hide() : show()
  );
  if (closeBtn) closeBtn.addEventListener('click', () => hide());

  // Escape closes the panel when open (mirrors reader.js) — GUARDED by own state,
  // coexists safely with reader.js:166 and detail.js:731's independent listeners.
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && panel.classList.contains('open')) hide();
  });
}
```
For `palette.js`, add the `⌘K` binding alongside the Escape guard, following the exact independent-listener shape (`reader.js:165-166`, `detail.js:729-731`, `settings.js:62-65` — three existing, safely-coexisting examples). Do NOT build a central keyboard dispatcher (RESEARCH Pitfall 3).

**Topics-section reuse** (`topics.js` lines 34-49, region-highlight call):
```javascript
function memberCount(schema) { /* count abstracts-edges */ }
const schemas = (ctx.allNodes || [])
  .filter(n => n.type === 'schema' && !n.tombstoned)
  .map(n => ({ node: n, count: memberCount(n) }))
  .sort((a, b) => b.count - a.count || (a.node.value || '').localeCompare(b.node.value || ''));
// selection:
row.addEventListener('click', () => {
  if (ctx.selectNode) ctx.selectNode(node);   // region glow + detail — DO NOT reimplement
  if (ctx.markActive) ctx.markActive();
});
```
`palette.js`'s Topics section should call this same `ctx.selectNode(schemaNode)` entry point — never compute region membership client-side (SC2 honesty invariant, per RESEARCH "Don't Hand-Roll").

**Command registry shape (no direct analog — small addition):** a static array `[{ id, label, run(ctx) }]` calling into `settings.js`'s `show()`, `reader.js`'s `show()`, `hud.js`'s log-toggle/tombstone-toggle logic, `graph.js`'s recenter, `corpus.js`'s open — all already-exported/callable entry points per RESEARCH's module wiring map (`app.js` lines 232-246).

---

### `src/viz/modules/hud-recede.js` (NEW, or folded into `hud.js`) — utility, event-driven

**Analog:** `src/viz/modules/stats.js` (idle-gated per-frame behavior)

**Idle-gated tick pattern to copy** (`stats.js` lines 189-217, `updateIdleDrift`):
```javascript
function updateIdleDrift(now) {
  if (!ctx.isIdle()) { lastDriftNow = null; return; }
  // ... only acts while idle; resets cleanly when activity resumes
}
```
`hud-recede.js` mirrors this shape but reads a NEW, HUD-owned elapsed-time export instead of `ctx.isIdle()` directly (RESEARCH Pitfall 2 — do not reuse the 1.2s scene-drift threshold for chrome recede).

**stats.js addition needed** (new `ctx.msSinceActive()` export, additive next to existing `ctx.isIdle`, `stats.js` line 70):
```javascript
// EXISTING:
ctx.isIdle = () => (performance.now() - lastActiveTime) > IDLE_TIMEOUT_MS;
// NEW (additive, same lastActiveTime var, no change to IDLE_TIMEOUT_MS/1200):
ctx.msSinceActive = () => performance.now() - lastActiveTime;
```

**camera.js addition needed** (new `ctx.isCameraInFlight()` export, additive next to existing `active` closure var, `camera.js` lines 106-113):
```javascript
// EXISTING closure var, never exposed on ctx:
let active = false;
ctx.setCameraTarget = (pos, lookAt) => { targetPos = pos; targetLookAt = lookAt; active = true; ... };
// NEW (one line, additive):
ctx.isCameraInFlight = () => active;
```

**Opacity-only transition precedent** (`styles.css` lines 110-121, `#panel` existing recede/reveal):
```css
#panel {
  opacity: 0.45;
  transition: opacity 0.2s ease;
}
#panel:hover,
#panel.panel-open {
  opacity: 1;
}
```
This existing rule is the DIRECT precedent for D-09's "opacity-only, no layout shift" — the chip/rails/topics-rail should extend this exact idiom (swap the hardcoded `0.2s ease` for the new `--motion-base`/`--ease-out-soft` tokens), not invent a new transition mechanism.

---

### `src/viz/modules/constants.js` (MODIFY — extend, config)

**Analog:** itself — existing named-export + JSDoc convention

**Convention to copy** (lines 1-8, plus scattered examples like lines 345-355):
```javascript
/**
 * @module constants
 * recense viz — shared palette, sizing, timing constants and ctx contract.
 *
 * Every downstream module (graph/lod/trace/effects/detail/hud/stats/app)
 * imports from here. This file is the source-of-truth for the ctx contract
 * that plans 03–07 implement against — do NOT add runtime behaviour here.
 */

/** Target fps during ambient idle (all-day display, fan-friendly) */
export const IDLE_FPS = 24;

/** Below this per-axis delta (world units), pos/lookAt are considered settled ... */
export const DEGRADE_FPS = 45;
```
New tokens (`HUD_IDLE_TIMEOUT_MS`, `RECEDE_GHOST_OPACITY`, `PALETTE_DEBOUNCE_MS`, motion timing constants, glass color/blur/radius tokens) follow the identical `/** one-line JSDoc */ export const NAME = value;` shape. **CRITICAL (RESEARCH Pitfall 5):** the CSS-var emission FUNCTION must NOT live in this file — put it in a separate small module/boot script that `import`s from `constants.js`, mirroring how `server.ts`'s `parseSchedulerScalars()` lives outside `constants.js` even though it reads from it.

---

### `src/viz/modules/hud.js` (MODIFY — re-home SSE/log/tombstone logic)

**Analog:** itself (existing file, logic survives, only DOM homes change)

**Security discipline to preserve** (file header, lines 16-18, and `showToast`, lines 35-40):
```javascript
// Security: logEvent uses textContent for log lines; node data is never injected
// into innerHTML. Toast text set via textContent.
function showToast(msg) {
  toastEl.textContent = msg.slice(0, 120); // textContent, never innerHTML
  ...
}
```
Keep `ctx.logEvent`, `ctx.setSSEStatus`, `ctx.showToast`, the tombstone-toggle closure state (lines 96-127), and the SSE `EventSource('/events')` wiring (lines 129-158) verbatim — only their button-click triggers move from `#btn-log`/`#btn-tombstones` DOM elements to `palette.js` command-registry calls (`ctx.toggleTombstones()`/`ctx.toggleLog()`-shaped exports, or direct function calls if `hud.js` exposes them on `ctx`).

---

### `src/viz/index.html` (MODIFY — DOM restructure)

**Analog:** itself — existing `#panel`/`#detail`/`#settings-panel`/`#reader` block conventions

**Existing block shape to copy for new chip/rails/palette markup** (lines 36-70, 111-131):
```html
<!-- Control strip / status surface — styled to recede by default (D-13) -->
<div id="panel">
  <div class="row status-row">
    <span id="sse-dot"></span>
    <span id="sse-label" class="lbl">connecting…</span>
    ...
  </div>
</div>

<!-- Settings panel (44-06): in-app cost-controls surface -->
<div id="settings-panel">
  <div id="settings-head">
    <span id="settings-kicker">settings ·</span>
    <button id="settings-close" type="button" aria-label="Close settings" title="Close settings">×</button>
  </div>
  <div id="settings-body"></div>
</div>
```
New elements (`#hud-chip`, `#hud-rail`, `#topics-rail`, `#palette`, `#palette-backdrop`) follow this exact "container div with a `-head`/`-body` or `-row` sub-structure, comment above stating the phase/decision it implements" convention. The existing inline-SVG icon buttons (`#btn-corpus` lines 82-88, `#btn-recenter` lines 98-106) are the exact template for the 5 rail icons — same `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"` attributes, same `aria-label`+`title` pairing.

**Deleted-block precedent:** `#search-wrap` (lines 51-62), `#topic-wrap` (lines 63-67), `#btn-tombstones`/`#btn-log` (lines 45, 48) are removed; their surviving logic (fetch, region-highlight, log-toggle) is re-homed into `palette.js`/`hud.js` per the module-file mappings above — this mirrors the "State of the Art" table in RESEARCH.md exactly.

---

### `src/viz/css/styles.css` (MODIFY — full token migration + glass reskin)

**Analog:** itself — `#panel`'s existing glass idiom is the formalization target (already ~80% of the recipe)

**Existing glass idiom to formalize into tokens, NOT replace** (lines 99-113):
```css
#panel {
  background: rgba(26, 18, 32, 0.66);
  border: 1px solid rgba(170, 150, 180, 0.12);
  border-radius: 11px;
  padding: 7px 12px;
  backdrop-filter: blur(12px);
  opacity: 0.45;
  transition: opacity 0.2s ease;
}
```
Becomes (token-migrated, UI-SPEC's Glass Construction Recipe values):
```css
#panel /* → new #hud-chip / #hud-rail selectors */ {
  background: var(--glass-bg-ambient);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  backdrop-filter: blur(var(--glass-blur-sm));
  box-shadow: var(--glass-specular);
  transition: opacity var(--motion-base) var(--ease-out-soft);
}
```

**Existing tooltip anti-blur comment — MUST be preserved as a documented exception, not silently deleted** (lines 63-76):
```css
#tooltip {
  /* Solid near-opaque backing for guaranteed contrast over nodes/field. Contrast
     comes from OPACITY, not a frosted blur (the blur was the glassmorphism slop) —
     a clean dark card, hairline border, no backdrop-filter. */
  background: rgba(20, 14, 26, 0.93);
  border: 1px solid rgba(140, 150, 165, 0.16);
  border-radius: 7px;
  padding: 5px 9px;
}
```
Per UI-SPEC's "Tooltip exception" row: token-migrate the literals (`background: var(--glass-bg-focused)` at the SAME 0.93 alpha value, `border-radius: var(--radius-sm)`) but add ZERO `backdrop-filter` and ZERO `--glass-specular`. Keep the explanatory comment (update its wording to note the phase-59 exception explicitly, per Pitfall 1 resolution in UI-SPEC) rather than deleting it.

**Three box-shadow removals** (lines 571, 869, 1203 — all `2px 0 24-28px rgba(0, 0, 0, 0.35)` on `#reader`/`#settings-panel`/`#index-panel`): replace with hairline-border-only definition (`border: 1px solid var(--glass-border-focused)`), per D-12/anti-slop item 9. Do NOT replace with a softer drop-shadow.

**Compact-mode gating precedent to extend** (lines 420-448):
```css
@media (max-width: 500px), (max-height: 500px) {
  #panel { display: none; }
  #btn-recenter { display: flex; }   /* stays visible — explicit exception pattern */
  #hull-credit { font-size: 8px; bottom: 4px; right: 6px; opacity: 0.55; }
}
```
New chip/rails/palette element IDs MUST be added to this block's hide-list (or nested as descendants of an already-hidden container) — RESEARCH Pitfall 7. Follow the exact "most things hidden, named exceptions stay visible" shape already used for `#btn-recenter`/`#hull-credit`.

**One existing CSS custom property precedent** (line 1190):
```css
:root { --index-width: 270px; }
```
This is the ONLY existing `--var` in the file — the new token block (glass/radius/motion/color tokens) extends this exact `:root { --token-name: value; }` emission shape, just with many more entries, either boot-injected or written directly (planner's discretion per RESEARCH Open Question 1).

---

### `tests/viz-activity-palette-invariants.test.ts` (MODIFY — extend)

**Analog:** itself — existing `describe('D-10 shared source of truth', ...)` block is the template

**Source-parse harness pattern to copy verbatim** (lines 30-41):
```typescript
function readConstantsJs(): string {
  return fs.readFileSync(path.resolve(ROOT, 'src/viz/modules/constants.js'), 'utf8');
}
function readServer(): string {
  return fs.readFileSync(path.resolve(ROOT, 'src/viz/server.ts'), 'utf8');
}
/** Strip JSDoc inner lines and standalone comment lines before token assertions. */
function stripComments(src: string): string {
  return src.split('\n').filter(line => !/^\s*(\*|\/\/)/.test(line)).join('\n');
}
```
Add a `readStylesCss()` sibling reader for the D-14 CSS-literal scan. New `describe('D-14 ...')`/`describe('D-11 ...')` blocks follow the exact `describe/it/expect` + regex-based assertion shape of the existing `Test A`/`Test B`/`Test C` sub-blocks (lines 59-90) — e.g. a regex scanning for `#[0-9a-fA-F]{3,8}` or `rgba?\(` outside the `:root { }` token block, with an explicit allow-list array for the sanctioned amber hover-tint exceptions (RESEARCH Pitfall 6 — do NOT write a blanket amber-ban regex, it will fail against current, unmodified `styles.css`).

---

## Shared Patterns

### textContent-only rendering (security discipline)
**Source:** `src/viz/modules/search.js` (header comment + `renderResults()`), `src/viz/modules/topics.js` (header comment + `render()`), `src/viz/modules/hud.js` (`showToast`)
**Apply to:** `palette.js`'s Nodes/Topics/Commands rendering — every server/user-sourced string (node labels, topic names, search results, command labels) via `textContent` or `createElement`+`Text` nodes, NEVER `innerHTML`.
```javascript
resultsEl.textContent = '';           // clear — safe
label.textContent = node.value;       // set — safe
// NEVER: resultsEl.innerHTML = ...
```

### Guarded, independent `Escape` keydown listeners (no central dispatcher)
**Source:** `src/viz/modules/reader.js:165-166`, `src/viz/modules/detail.js:729-731`, `src/viz/modules/settings.js:62-65`
**Apply to:** `palette.js` (add its own guarded `Escape` + `⌘K` listener; do not refactor the others)
```javascript
document.addEventListener('keydown', ev => {
  if (ev.key === 'Escape' && panel.classList.contains('open')) hide();
});
```

### Opacity-only transitions (no layout shift)
**Source:** `src/viz/css/styles.css:99-121` (`#panel` opacity/hover reveal), referenced by RESEARCH as "the transition.js opacity-only lesson"
**Apply to:** `hud-recede.js`'s CSS classes for chip/rails/topics-rail — only `opacity` and `transition-timing-function`/`duration` properties, never `top`/`left`/`width`/`height`.

### Idle-state gating via `ctx.markActive()` / elapsed-time (no new mousemove listener)
**Source:** `src/viz/modules/app.js:257-264` (existing global mousemove → `ctx.markActive()`), `src/viz/modules/stats.js:56-61,70` (`lastActiveTime`, `ctx.isIdle`)
**Apply to:** `hud-recede.js` — reuse the EXISTING mousemove listener's side effect via a NEW `ctx.msSinceActive()` export from `stats.js`; do not add a second `mousemove` listener.

### Named tunable constants in `constants.js`, no runtime behavior colocated
**Source:** `src/viz/modules/constants.js:1-8` (header ban on runtime behavior), and the pervasive `/** one-line JSDoc */ export const NAME = value;` shape throughout the file
**Apply to:** All new HUD_IDLE_TIMEOUT_MS / RECEDE_GHOST_OPACITY / PALETTE_* / glass-recipe / motion-token constants.

### Inline SVG icon shape (vendor-everything, no icon fonts)
**Source:** `src/viz/index.html:82-88` (`#btn-corpus`), `src/viz/index.html:98-106` (`#btn-recenter`), `apps/tray/src/popover.ts` (per UI-SPEC, same stroke style)
**Apply to:** All 5 new rail icons (reader, settings, corpus, recenter, search magnifier)
```html
<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <!-- path data -->
</svg>
```

### Region-highlight / node-select via existing engine-served entry point (never client-approximated)
**Source:** `src/viz/modules/topics.js:70-73`, `src/viz/modules/search.js:93-100` (`ctx.selectNode`)
**Apply to:** `palette.js`'s Nodes and Topics sections — both route selection through `ctx.selectNode(node)`, never compute a region/connection set client-side.

## No Analog Found

None. Every file this phase touches has a working, closely-analogous existing pattern in the same codebase (this phase is explicitly a reskin/consolidation phase per RESEARCH.md's framing — "the work is consolidation, reskinning, and exposing 2-3 small pieces of previously-internal state, not building new subsystems").

The only genuinely-new logic (the ~20-30 line fuzzy/subsequence matcher for Commands+Topics, and the palette's command registry array) has no direct in-repo analog but is explicitly scoped in RESEARCH.md's "Don't Hand-Roll" table as a small, standard, independently-derivable algorithm — not something requiring a borrowed pattern.

## Metadata

**Analog search scope:** `src/viz/modules/*.js` (all 17 files), `src/viz/index.html`, `src/viz/css/styles.css`, `apps/tray/src/popover.ts`, `tests/viz-activity-palette-invariants.test.ts`
**Files scanned:** 17 JS modules + index.html + styles.css (1,343 lines, 3 targeted ranges read) + 1 test file + 1 tray reference file = 21
**Pattern extraction date:** 2026-07-05
