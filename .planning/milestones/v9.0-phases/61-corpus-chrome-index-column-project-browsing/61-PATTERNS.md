# Phase 61: Corpus Chrome — Pattern Map

**Mapped:** 2026-07-14
**Files analyzed:** 5 (all modifications — no new files)
**Analogs found:** 5 / 5 (self-analog: each file's own unmodified sections are the primary
pattern source; sibling modules supply the NEW patterns this phase introduces)

**Framework note:** vanilla JS/CSS canvas+DOM viz, no component framework, no shadcn. "Role"
below maps loosely (controller≈module-with-DOM+ctx-hooks, service≈pure-helper, config≈constants).

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/viz/modules/index.js` | component (DOM tree renderer + ctx hooks) | request-response (fetch `/index`, render, event-wire) | itself (existing tree/filter logic) + `src/viz/modules/settings.js`/`reader.js` (panel show/hide, glass-tier chrome) | exact (self) |
| `src/viz/modules/corpus.js` | component (canvas renderer + ctx hooks) | event-driven (hover/click/focus state → repaint) | itself (existing `highlightCorpusNode` BFS, `nodeVisibility` reassert pattern) + `src/viz/modules/detail.js` (`applyFocusDim`/`clearFocusDim`, 3D focus-dim precedent) | exact (self) + role-match (detail.js for focus-dim) |
| `src/viz/css/styles.css` (`#index-panel`, `#index-reopen`, tree rows) | config/style | transform (token → CSS var) | `#detail` (focused glass tier, styles.css:51-77) + `#hud-rail` (ambient glass tier, styles.css:195-213) | exact (both tiers already exist verbatim in this codebase) |
| `src/viz/modules/constants.js` | config | transform (named constant → `HUD_CSS_TOKENS`/tunable) | itself — `FOCUS_DIM_OPACITY`/`FOCUS_FOG_NEAR` (lines 647-657) is the exact precedent for the new `CORPUS_FOCUS_DIM_OPACITY`/`CORPUS_HOVER_DIM_OPACITY` block | exact (self, same file, adjacent section) |
| `tests/viz-activity-palette-invariants.test.ts` | test | transform (static assertion over parsed CSS/JS source) | itself — `ALLOWED_SELECTORS` set (line 457) | exact (self, one-line addition) |

No files are net-new. Every plan in this phase is a targeted edit to one of these 5 files.

---

## Pattern Assignments

### `src/viz/modules/index.js` (component, request-response)

**Analog:** itself (current flat-render `renderTreeSection`/`computeVisible`) — the tree DATA
SHAPE and filter-ancestor logic are reused unchanged; only the RENDER (flat→collapsible) and
row click-handler change.

**Imports pattern** (lines 29-31, unchanged — no new imports needed, net-zero deps):
```javascript
// ── Icon SVGs (inline — net-zero deps, no icon lib) ─────────────────────────────────
const ICON_CHEVRON_LEFT = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
const ICON_CHEVRON_RIGHT = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
```
Per UI-SPEC: reuse this EXACT stroke recipe for the new per-row expand chevron (11-12px box,
rotated via CSS `transform` between ▶/▼, not a second SVG asset).

**Core tree-building pattern to REUSE verbatim** (lines 156-192, `renderTreeSection`):
```javascript
function renderTreeSection(title, entries, visible) {
    if (!entries || entries.length === 0) return false;
    const shown = entries.filter(e => visible === null || visible.has(e.id));
    if (shown.length === 0) return false;
    const byId = new Map();
    for (const e of entries) byId.set(e.id, e);
    const children = new Map();
    const roots = [];
    for (const e of entries) {
      if (e.parentId && byId.has(e.parentId)) {
        if (!children.has(e.parentId)) children.set(e.parentId, []);
        children.get(e.parentId).push(e);
      } else {
        roots.push(e);
      }
    }
    const byLabel = (a, b) => (a.label || a.slug).localeCompare(b.label || b.slug);
    const list = makeSection(title);
    const seen = new Set();
    const emit = (entry, depth) => {
      if (seen.has(entry.id)) return;          // defensive: never loop on malformed data
      seen.add(entry.id);
      if (visible === null || visible.has(entry.id)) {
        const li = document.createElement('li');
        const a = makeEntryAnchor(entry);
        a.style.paddingLeft = (8 + depth * 14) + 'px'; // indent by containment depth
        li.appendChild(a);
        list.appendChild(li);
      }
      for (const k of (children.get(entry.id) || []).slice().sort(byLabel)) emit(k, depth + 1);
    };
    for (const r of roots.slice().sort(byLabel)) emit(r, 0);
    return true;
  }
```
This is the parent/child tree walk (`byId`, `children`, `roots`, `emit(entry, depth)`
recursion). D-01's collapsible restructure keeps this exact shape — the only change is gating
the `li.appendChild` / recursive `emit` call for non-root entries behind an `expanded` Set
(collapsed project → don't emit its children at all, or emit but `display:none` them — prefer
not-rendering per "you only ever see the docs you opened").

**Filter-ancestor pattern to REUSE + extend** (lines 142-154, `computeVisible`):
```javascript
function computeVisible(entries, filter) {
    if (!filter) return null;
    const byId = new Map(entries.map(e => [e.id, e]));
    const visible = new Set();
    for (const e of entries) {
      if ((e.label || e.slug || '').toLowerCase().includes(filter)) {
        visible.add(e.id);
        let cur = e;
        while (cur && cur.parentId && byId.has(cur.parentId)) { visible.add(cur.parentId); cur = byId.get(cur.parentId); }
      }
    }
    return visible;
  }
```
Extend: when `filter` is active, any ancestor added to `visible` here should ALSO be added to
the `expanded` Set (so `renderTreeSection` actually emits the matching branch). Clearing the
filter must NOT remove those same ids from `expanded` if the user separately toggled them —
keep `expanded` state independent of the filter-computed visibility set.

**Row anchor / hover / click pattern to REUSE, click behavior CHANGES per D-03**
(lines 107-124, `makeEntryAnchor`):
```javascript
function makeEntryAnchor(entry) {
    const a = document.createElement('a');
    a.className = 'index-entry doc-ref';
    a.setAttribute('href', '#');
    a.textContent = entry.label || entry.slug; // textContent — T-39-08
    a.addEventListener('mouseenter', () => {
      if (typeof ctx.highlightCorpusNode === 'function') ctx.highlightCorpusNode(entry.slug);
    });
    a.addEventListener('mouseleave', () => {
      if (typeof ctx.highlightCorpusNode === 'function') ctx.highlightCorpusNode(null);
    });
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (typeof ctx.openReader === 'function') ctx.openReader(entry.slug, { from: 'corpus' });
      else window.location.href = '/?doc=' + encodeURIComponent(entry.slug) + '&reader=1';
    });
    return a;
  }
```
Keep hover wiring as-is for ALL rows (project + doc). Keep click→`openReader` UNCHANGED for
LEAF/doc rows. For PROJECT (root) rows, D-03 replaces the click handler: call the new
`ctx.focusCorpusProject(scope)` hook instead of `ctx.openReader`, AND toggle that project's
`expanded` entry (one click does both — no separate two-step affordance). The chevron gets its
OWN click target (`ev.stopPropagation()` on the chevron's own listener) that ONLY toggles
`expanded`, never calling focus.

**Empty/loading/error status copy — UNCHANGED verbatim** (lines 205, 216, 230):
```javascript
empty.textContent = currentFilter ? 'No matching docs' : 'No docs yet';
statusEl.textContent = 'Loading index…';
statusEl.textContent = 'Failed to load index';
```

**ctx hook registration pattern** (lines 300-305) — add `ctx.focusCorpusProject` is owned by
`corpus.js`, NOT `index.js`; `index.js` only CALLS it (same relationship as the existing
`ctx.highlightCorpusNode` / `ctx.openReader` calls above — index.js never defines a corpus.js
hook, only consumes it):
```javascript
ctx.openIndexSidebar = openSidebar;
ctx.closeIndexSidebar = closeIndexSidebar;
ctx.openIndex = openSidebar;
```

---

### `src/viz/modules/corpus.js` (component, event-driven)

**Analog:** itself for the BFS-highlight/visibility-reassert mechanisms (reused, not
reimplemented); `src/viz/modules/detail.js` for the 3D focus-dim PRECEDENT (D-04's 2D dim is
the same idiom at a lighter opacity).

**highlightCorpusNode — REUSE VERBATIM for D-05 graph-hover parity** (lines 621-660):
```javascript
ctx.highlightCorpusNode = function highlightCorpusNode(slug) {
    if (!CorpusGraph) return;
    const next = new Set();
    if (slug) {
      let rootId = null;
      for (const id in nodeSlugs) { if (nodeSlugs[id] === slug) { rootId = id; break; } }
      if (rootId) {
        next.add(rootId);
        try {
          const links = ((CorpusGraph.graphData && CorpusGraph.graphData()) || {}).links || [];
          // BFS down the containment spine; the visited guard (next.has) also breaks any cycle.
          const queue = [rootId];
          while (queue.length) {
            const cur = queue.shift();
            for (const link of links) {
              if (link.kind !== 'doc_containment') continue;
              const s = typeof link.source === 'object' ? link.source.id : link.source;
              const t = typeof link.target === 'object' ? link.target.id : link.target;
              if (s === cur && !next.has(t)) { next.add(t); queue.push(t); }
            }
          }
        } catch (_) { /* ignore — fall back to single-node highlight */ }
      }
    }
    if (next.size === highlightSet.size && [...next].every(id => highlightSet.has(id))) return;
    highlightSet = next;
    try {
      if (typeof CorpusGraph.nodeCanvasObject === 'function') {
        CorpusGraph.nodeCanvasObject(CorpusGraph.nodeCanvasObject());
      }
    } catch (_) { /* non-fatal — highlight just won't repaint on this lib version */ }
  };
```
D-05 wires `.onNodeHover()` (line 339-342 below) to call `ctx.highlightCorpusNode(slug-of-hovered-node-or-null)`
in addition to its current `hoveredId`/cursor bookkeeping — do not duplicate the BFS.

**onNodeHover — CURRENT (extend, don't replace)** (lines 339-342):
```javascript
.onNodeHover((node) => {
        hoveredId = node ? node.id : null;
        container.style.cursor = node ? 'pointer' : '';
      })
```
D-05 also needs a NEW non-related-dim pass here (today this handler does nothing dim-related —
this is literally the "flat hover" defect D3 calls out). Reuse `nodeCanvasObject`'s existing
`canvasCtx.globalAlpha` idiom (already used for chapter dimming, lines 251-253) as the paint-time
gate: check a `dimSet`/`isDimmed(node)` predicate and multiply alpha by
`CORPUS_HOVER_DIM_OPACITY` (or `CORPUS_FOCUS_DIM_OPACITY` if a project is focused) when the node
is outside `highlightSet`/focused-project-set.

**nodeVisibility/linkVisibility reassert — REUSE VERBATIM for D-07 chapter visibility**
(lines 168-176, the deleted toggle's repaint trick — same 3-line reassert, new trigger):
```javascript
if (!CorpusGraph) return;
    try {
      // Re-assert the visibility + paint accessors so force-graph repaints the (static, pinned)
      // canvas with the new filter — same repaint trick used by highlightCorpusNode.
      if (typeof CorpusGraph.nodeVisibility === 'function') CorpusGraph.nodeVisibility(CorpusGraph.nodeVisibility());
      if (typeof CorpusGraph.linkVisibility === 'function') CorpusGraph.linkVisibility(CorpusGraph.linkVisibility());
      if (typeof CorpusGraph.nodeCanvasObject === 'function') CorpusGraph.nodeCanvasObject(CorpusGraph.nodeCanvasObject());
    } catch (_) { /* non-fatal */ }
    fitAndClamp();
```
D-07 deletes the `showChapters` boolean + `#btn-corpus-chapters` button (lines 126-176 region)
and replaces `isNodeVisible`'s `showChapters ||` condition with a focused-or-expanded-project
check (a `focusedScope`/`expandedProjectScopes` set instead of one global boolean) — the
REASSERT call sequence above is unchanged.

**isNodeVisible / isChapterNode — CURRENT gate to modify** (lines 131-133):
```javascript
let showChapters = false;
  const isChapterNode = (n) => UUID_RE.test((n && n.slug) || '');
  const isNodeVisible = (n) => showChapters || !isChapterNode(n);
```
Becomes (shape only — exact predicate is planner's call):
`const isNodeVisible = (n) => !isChapterNode(n) || isProjectFocusedOrExpanded(rootScope(n.scope))`.

**fitAndClamp — REUSE for D-04 focus camera framing** (lines 465-484):
```javascript
function fitAndClamp() {
    if (!CorpusGraph || !CorpusGraph.zoomToFit) return;
    try {
      CorpusGraph.zoomToFit(0, 40, (node) => isNodeVisible(node));
      if (typeof CorpusGraph.zoom === 'function' && CorpusGraph.zoom() > MAX_ZOOM) {
        CorpusGraph.zoom(MAX_ZOOM, 0);
      }
    } catch (_) { /* ignore */ }
  }
```
D-04's `focusCorpusProject(scope)` hook calls `CorpusGraph.zoomToFit(CORPUS_FOCUS_TRANSITION_MS,
40, node => rootScope(node.scope) === scope)` (animated, unlike the instant `fitAndClamp` used
at reveal) — same `zoomToFit(ms, padding, nodeFilter)` signature, animated instead of 0ms, and
re-clamp to `MAX_ZOOM` after per the existing snap-back guard.

**projectScopes / rootScope — REUSE VERBATIM, already the exact D-04 focus-set derivation**
(lines 66-87, 140, 220-223):
```javascript
function rootScope(scope) {
  return scope ? scope.split(':')[0] : scope;
}
```
`projectScopes` (built at line 220-223 from subject-doc scopes) is already the exact "is this a
real project" set D-04 needs — a project row's `scope` param to `focusCorpusProject` should be
validated against this set (ignore focus calls for a scope not in `projectScopes`).

**3D focus-dim PRECEDENT (role-match analog, `src/viz/modules/detail.js:219-265`)** — the save/dim/
restore idiom D-04's 2D dim should mirror (adapted: `n.__mat.opacity` → per-node
`nodeCanvasObject` alpha gate, since 2D canvas has no per-node material object to mutate
directly):
```javascript
function applyFocusDim(node) {
    clearFocusDim();
    const keep = new Set([node.id]);
    for (const nb of getNeighbors(node)) keep.add(nb.id);
    for (const n of (ctx.allNodes || [])) {
      if (keep.has(n.id) || !n.__mat) continue;
      n.__mat.opacity = FOCUS_DIM_OPACITY;
      dimmedNodes.push(n);
    }
  }
  function clearFocusDim() {
    for (const n of dimmedNodes) {
      if (n.__mat && n.__baseOp !== undefined) n.__mat.opacity = n.__baseOp;
    }
    dimmedNodes = [];
  }
```
2D equivalent: no per-node save/restore needed — `nodeCanvasObject`/`linkColor` are PURE
functions re-evaluated every repaint, so "dim" is just a live predicate
(`focusedScope && rootScope(node.scope) !== focusedScope`) checked at paint time, exactly like
the existing `isHover`/`isChapterDoc` checks already inline in `nodeCanvasObject` (lines 249,
252-253) — cheaper than the 3D save/restore because there's no persistent GPU material state.

**nodeCanvasObject — paint-time alpha gate, CURRENT pattern to extend for D-04/D-05/D-06**
(lines 248-278, the exact insertion point for all three):
```javascript
.nodeCanvasObject((node, canvasCtx, globalScale) => {
        const isHover = node.id === hoveredId || highlightSet.has(node.id);
        const r = NODE_R;
        const isChapterDoc = UUID_RE.test(node.slug || '');
        canvasCtx.globalAlpha = isChapterDoc ? 0.35 : 1.0;
        const baseColor = projectScopes.has(rootScope(node.scope)) ? scopeColor(rootScope(node.scope)) : REST_NODE;
        canvasCtx.beginPath();
        canvasCtx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
        canvasCtx.fillStyle = isHover ? HOVER_NODE : baseColor;
        canvasCtx.fill();
        canvasCtx.lineWidth = 1 / globalScale;
        canvasCtx.strokeStyle = isHover ? HOVER_NODE : REST_NODE_RING;
        canvasCtx.stroke();
        const label = nodeLabels[node.id] || nodeSlugs[node.id] || node.id;
        const fontSize = Math.max(10 / globalScale, 2.2);
        canvasCtx.font = `${fontSize}px system-ui, -apple-system, sans-serif`;
        canvasCtx.textAlign = 'center';
        canvasCtx.textBaseline = 'top';
        canvasCtx.fillStyle = isHover ? LABEL_COLOR_HOVER : LABEL_COLOR;
        canvasCtx.fillText(label, node.x, node.y + r + 1.5);
        canvasCtx.globalAlpha = 1.0;
      })
```
D-06 tiered labels: gate the `canvasCtx.fillText(label, ...)` call itself — project hubs
(`!slug.includes(':') && !UUID_RE.test(slug)`) always draw; subject docs draw only when
`globalScale >= CORPUS_LABEL_ZOOM_THRESHOLD || isHover || focusedScope === rootScope(node.scope)`;
chapter docs (`isChapterDoc`) draw ONLY when `isHover` (never at rest, never from focus alone —
per UI-SPEC "chapters appear exactly when browsing"). D-04/D-05 dim: multiply
`canvasCtx.globalAlpha` by the dim factor BEFORE the existing `isChapterDoc ? 0.35 : 1.0`
assignment (compose, don't replace — a dimmed chapter doc should be `0.35 * DIM_OPACITY`, not
just one or the other).

**Deletion target (D-07) — chapter toggle button + label sync, DELETE lines 126-176 wholesale**
(the whole `showChapters`/`chapterToggleBtn`/`syncChapterToggleLabel`/`setChapterToggleVisible`
block), plus its two call sites in `goToCorpus`/`goToBrain` (lines 560, 570):
```javascript
setChapterToggleVisible(true);   // goToCorpus — DELETE this call
setChapterToggleVisible(false);  // goToBrain — DELETE this call
```

**New ctx hook to ADD (D-03/D-04), matching the existing hook-registration style**
(lines 604-620, `ctx.openCorpus`/`ctx.isCorpusOpen`/`ctx.refitCorpus` — same section, same
"function name = property name" style, same guarded-call convention index.js already uses for
consuming hooks):
```javascript
ctx.openCorpus = function openCorpus() {
    if (!transition.isCorpus()) goToCorpus();
  };
  ctx.isCorpusOpen = function isCorpusOpen() {
    return transition.isCorpus();
  };
  ctx.refitCorpus = function refitCorpus() {
    sizeCorpusGraph();
    fitAndClamp();
  };
```
Add `ctx.focusCorpusProject = function focusCorpusProject(scope) { ... }` (accepts `null` to
exit focus, mirroring `highlightCorpusNode(null)`'s clear convention) in this same block.

---

### `src/viz/css/styles.css` (config/style, transform)

**Analog A — focused glass tier, REUSE VERBATIM recipe for `#index-panel`**
(`#detail`, lines 51-70; already used by `#settings-panel`/`#reader` per UI-SPEC rationale):
```css
#detail {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 10;
  display: none;
  width: 340px;
  max-height: calc(100vh - 40px);
  overflow-y: auto;
  background: var(--glass-bg-focused);
  border: 1px solid var(--glass-border-focused);
  border-radius: var(--radius-lg);
  padding: 14px 16px;
  backdrop-filter: blur(var(--glass-blur-md));
  box-shadow: var(--glass-specular);
  transform: translateX(16px);
  opacity: 0;
  transition: transform var(--motion-slow) var(--ease-out-soft),
              opacity  var(--motion-slow) var(--ease-out-soft);
}
```
Apply to `#index-panel` (current block: styles.css:1277-1295): swap
`background: var(--surface-index-panel)` → `var(--glass-bg-focused)`, add
`backdrop-filter: blur(var(--glass-blur-md))` + `box-shadow: var(--glass-specular)`, and add
`border: 1px solid var(--glass-border-focused)` (currently only has `border-right`) OR keep the
existing `border-right`-only treatment if the founder-locked docked-split look should stay
edge-only — flag as a checkpoint call, not a hard requirement. Keep existing
`opacity`/`transition`/`display:flex` structure unchanged (D-09/D-11: opacity-only transitions
for chrome, already followed here).

**Analog B — ambient glass tier, REUSE VERBATIM recipe for `#index-reopen`**
(`#hud-rail`, lines 195-213 — same species: small floating icon affordance):
```css
#hud-rail {
  position: fixed;
  top: 50%;
  right: 16px;
  transform: translateY(-50%);
  z-index: 70;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  margin: 0;
  background: var(--glass-bg-ambient);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  backdrop-filter: blur(var(--glass-blur-sm));
  box-shadow: var(--glass-specular);
  opacity: 0.55;
  transition: opacity var(--motion-base) var(--ease-out-soft);
}
#hud-rail:hover { opacity: 1; }
```
Apply to `#index-reopen` (current block: styles.css:1246-1268): add
`background: var(--glass-bg-ambient)` (replacing `var(--surface-btn-icon)`),
`backdrop-filter: blur(var(--glass-blur-sm))`, `box-shadow: var(--glass-specular)`; keep its
existing `border-radius: 7px` → align to `var(--radius-md)` (11px) per token discipline, or keep
7px as a deliberate small-affordance exception (UI-SPEC doesn't mandate radius-md explicitly —
`var(--radius-sm)` 7px already matches numerically, prefer that token over a literal).

**Current `.index-entry` row — base to extend, NOT replace** (lines 1401-1417):
```css
.index-entry {
  display: block;
  font-size: 13px;
  line-height: 1.35;
  color: var(--text-recede);
  text-decoration: none;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}
.index-entry:hover {
  color: var(--text-bright);
  background: var(--index-search-focus-bg);
}
```
New tree-row wrapper (chevron + name + count-badge as a flex row containing this `.index-entry`
or a sibling `.index-row` class) should reuse this exact hover-background/color-transition idiom
— do not invent a new hover treatment.

**D-14-A token requirement — every new color line must resolve through `var(--token)`.** New
tokens needed in `HUD_CSS_TOKENS` (constants.js) for: count-badge text color (reuse existing
`text-stat` #7fae93 or `text-data-value` #9aa4b0 — both already exist, prefer reuse over a new
key), chevron rest/hover color (reuse `text-recede`/`text-bright-mauve`, both exist).
**Zero new raw hex/rgba literals in styles.css** — the D-14-A `findRawColorLiteralLines` test
(tests/viz-activity-palette-invariants.test.ts:404) fails hard on any literal.

**No new amber usage anywhere in this phase's CSS** — D-14-B lock; amber stays confined to the
4 existing `AMBER_ALLOWED_KEYS`.

---

### `src/viz/modules/constants.js` (config, transform)

**Analog:** itself — `FOCUS_DIM_OPACITY`/`FOCUS_FOG_NEAR` (lines 647-657) is the exact 3D-era
precedent for a "named opacity constant with a doc comment citing the founder decision + a
Provisional/Claude's-Discretion tag":
```javascript
/** Focus-dim opacity for nodes outside the selected neighborhood (D-07 —
 *  moved from detail.js to join the named-constant discipline). Slightly
 *  stronger than the pre-D-07 value so the non-neighbor recede reads more
 *  decisively. Provisional — Claude's Discretion, ratcheted at Stage 2. */
export const FOCUS_DIM_OPACITY = 0.035;
```
Add a new `// Phase 61 — corpus focus/hover dim + tiered labels (D-04/D-05/D-06)` section
(same `// ====...====` banner style used at lines 627-629/659-661) with:
```javascript
export const CORPUS_FOCUS_DIM_OPACITY = 0.18;   // provisional per UI-SPEC range 0.15-0.20
export const CORPUS_HOVER_DIM_OPACITY = 0.30;   // provisional per UI-SPEC range 0.25-0.35
export const CORPUS_LABEL_ZOOM_THRESHOLD = 1.2; // provisional — tune against MAX_ZOOM=2.5 (corpus.js)
export const CORPUS_FOCUS_TRANSITION_MS = 500;  // provisional per UI-SPEC range 400-600ms
```
Import these into `corpus.js` the same way `detail.js` imports `FOCUS_DIM_OPACITY`/
`FOCUS_FOG_NEAR` (line 25): `import { FOCUS_DIM_OPACITY, FOCUS_FOG_NEAR, ... } from './constants.js';`
— `corpus.js` currently has NO import from `constants.js` (it deliberately keeps its own local
muted-palette constants per its file-header comment, lines 36-49) — this phase is the FIRST
time corpus.js imports from constants.js; keep the import narrow (only the 4 new tunables, not
the whole 3D palette) to preserve that documented independence.

**`HUD_CSS_TOKENS` — no new entries strictly required** (count-badge/chevron colors can reuse
existing keys per the CSS section above); only add a token if a genuinely new color is needed
(e.g. a distinct count-badge tint) — prefer reuse per the D-14 discipline banner (lines 699-703:
"Locked families only... no new saturated violet").

---

### `tests/viz-activity-palette-invariants.test.ts` (test, transform)

**Analog:** itself — this is a required, not optional, edit (UI-SPEC explicitly calls it out).

**Current allow-list to extend** (lines 457-466):
```typescript
const ALLOWED_SELECTORS = new Set([
      '#hud-chip',
      '#hud-rail',
      '#topics-rail',
      '#palette',
      '#detail',
      '#settings-panel',
      '#reader',
      '.toast',
    ]);
```
Add `'#index-panel'` and `'#index-reopen'` to this set — the moment `backdrop-filter` is added
to either selector's CSS block (per the D-02/D-08 glass reskin above), the existing
`'every rule block using backdrop-filter is in the D-12 selector allow-list'` test
(line 475-479) fails without this one-line addition. No other change to this test file is
needed — D-14-A/D-14-B assertions are satisfied automatically as long as all new colors route
through `var(--token)` per the styles.css guidance above.

---

## Shared Patterns

### Ctx-hook cross-module wiring
**Source:** `src/viz/modules/corpus.js:604-620` + `src/viz/modules/index.js:300-305`
**Apply to:** both files — new hooks follow the existing "owner module defines
`ctx.functionName = function functionName() {...}`; consumer module calls
`if (typeof ctx.functionName === 'function') ctx.functionName(...)`" convention, never a direct
cross-module import. `focusCorpusProject` is owned by corpus.js, called by index.js — same
relationship `highlightCorpusNode`/`openReader`/`refitCorpus` already have.
```javascript
// owner (corpus.js)
ctx.refitCorpus = function refitCorpus() { sizeCorpusGraph(); fitAndClamp(); };
// consumer (index.js)
if (typeof ctx.refitCorpus === 'function') ctx.refitCorpus();
```

### Esc-key ownership — NO central dispatcher (corrects CONTEXT.md's "one owner" phrasing)
**Source:** `src/viz/modules/palette.js:226-238` (comment is explicit about the actual pattern)
**Apply to:** the new focus-exit Esc handler in corpus.js
```javascript
// ── Keyboard: ⌘K/Ctrl-K toggles open, Escape closes (guarded independent
  // listener — no central dispatcher, coexists with reader.js/detail.js/
  // settings.js's own guarded listeners; RESEARCH Pitfall 3) ──────────────────
  document.addEventListener('keydown', ev => {
    ...
    if (ev.key === 'Escape' && state.open) close();
  });
```
The established codebase pattern (reader.js:195-196, settings.js:67-68, detail.js:730-731,
palette.js:237, detail-page.js:70, stats-dashboard.js:147) is INDEPENDENT guarded
`document.addEventListener('keydown', ...)` listeners per module, each checking its OWN
open/focused state before acting — NOT a single shortcut-dispatch table. corpus.js's new
focus-exit Esc handler should add its own guarded listener
(`if (ev.key === 'Escape' && focusedScope) exitFocus();`) following this exact idiom. Per the
UI-SPEC's stated precedence (reader/palette close first), place this listener registration
AFTER reader.js/palette.js's own (module init order in app.js), OR check `!isReaderOpen &&
!isPaletteOpen` inside the guard if reader/palette state is reachable — do not build a new
shared dispatcher module.

### Focus/dim state — save-nothing paint-time predicate (2D canvas, no per-node material)
**Source:** `src/viz/modules/corpus.js:248-278` (`nodeCanvasObject`, pure repaint function) vs.
`src/viz/modules/detail.js:219-265` (`applyFocusDim`/`clearFocusDim`, 3D save/restore — DO NOT
port the save/restore machinery, only the "what to dim" concept)
**Apply to:** D-04 (focus) and D-05 (hover-dim) in corpus.js
```javascript
// 3D (detail.js) — stateful save/restore because THREE materials persist:
n.__mat.opacity = FOCUS_DIM_OPACITY;   // ... later: n.__mat.opacity = n.__baseOp;

// 2D (corpus.js) — stateless: nodeCanvasObject is re-invoked every repaint,
// so "dim" is just an inline condition, reusing the EXISTING isHover/isChapterDoc
// alpha-gate already in the function body (lines 249-253):
const isHover = node.id === hoveredId || highlightSet.has(node.id);
canvasCtx.globalAlpha = isChapterDoc ? 0.35 : 1.0;   // ← compose the new dim factor HERE
```
Re-triggering repaint after a focus/hover state change reuses the existing
`CorpusGraph.nodeCanvasObject(CorpusGraph.nodeCanvasObject())` reassert idiom (corpus.js:656-658,
also used by the chapter-toggle at lines 171-173) — never call `.graphData()` again or rebuild
the instance.

### Glass reskin — two-tier system already fully tokenized
**Source:** `src/viz/css/styles.css:51-70` (focused tier, `#detail`) and `:195-213` (ambient
tier, `#hud-rail`); token values from `src/viz/modules/constants.js:673-698` (`HUD_CSS_TOKENS`)
**Apply to:** `#index-panel` (focused tier) and `#index-reopen` (ambient tier)
Both tiers already exist as CSS custom properties emitted by `emitHudTokens()`
(`src/viz/modules/css-tokens.js`) — this phase applies the existing recipe, invents nothing:
```css
/* focused tier */
background: var(--glass-bg-focused); backdrop-filter: blur(var(--glass-blur-md));
border: 1px solid var(--glass-border-focused); box-shadow: var(--glass-specular);
/* ambient tier */
background: var(--glass-bg-ambient); backdrop-filter: blur(var(--glass-blur-sm));
border: 1px solid var(--glass-border); box-shadow: var(--glass-specular);
```

### textContent-only for DB-sourced strings (T-39-08)
**Source:** `src/viz/modules/index.js:58, 111, 131` (title/label/heading all `.textContent`)
**Apply to:** all new tree-row rendering (project name, doc label, count-badge integer) — the
count badge is a NUMBER but still goes through `.textContent = String(count)`, never
`.innerHTML`, per the UI-SPEC's explicit T-39-08 callout.

### Server payload — no change needed for doc-count badges
**Finding:** `src/viz/server.ts:1267-1330` (`GET /index` handler) already returns each entry
with `parentId` and the full flat list per section — a project's doc count is
`entries.filter(e => descendsFrom(e, project.id)).length`, computable client-side in index.js
from the existing payload. No server-side change is required to satisfy D-01's count badge
unless the founder later wants a server-precomputed count (CONTEXT.md leaves this discretionary
but the reusable-client-derivation path should be preferred — net-zero payload change, one less
thing to keep in sync).

---

## No Analog Found

None — every file in scope has either a direct self-analog (unchanged portions of the same
file) or a strong same-codebase sibling analog (glass tiers, focus-dim precedent, Esc-listener
convention). This phase is a restructure/extension of existing, well-established local patterns,
not new architecture.

---

## Metadata

**Analog search scope:** `src/viz/modules/*.js`, `src/viz/css/styles.css`, `tests/viz-*.test.ts`
**Files scanned:** `index.js`, `corpus.js`, `constants.js`, `detail.js`, `palette.js`,
`reader.js`, `settings.js`, `css-tokens.js`, `styles.css`, `viz-activity-palette-invariants.test.ts`,
`server.ts` (`/index` handler only)
**Pattern extraction date:** 2026-07-14
