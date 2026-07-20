# Phase 39: Reader Wiki-Parity — Browsable Index + Surfaced Backlinks - Pattern Map

**Mapped:** 2026-06-21
**Files analyzed:** 5 new/modified surfaces
**Analogs found:** 5 / 5

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/viz/server.ts` (add `/index` route) | route | request-response | `src/viz/server.ts:474-540` `/doc` route | exact — same server, same read-only pattern |
| `src/viz/server.ts` (add `/doc/backlinks` route) | route | request-response | `src/viz/server.ts:587-643` `/doc/staleness` route | exact — same slug param, stmtGetDoc lookup, getInEdges primitive |
| `src/viz/modules/index.js` (new) | component | request-response | `src/viz/modules/corpus.js` | role-match — same toolbar-button + lazy-init + fetch pattern |
| `src/viz/modules/reader.js` (add "Referenced by" section) | component | request-response | `src/viz/modules/reader.js:344-405` `fetchStaleness` | exact — same append-to-body pattern, same banner DOM recipe |
| `src/viz/index.html` (add `#btn-index` button) | config | — | `src/viz/index.html:73-82` `#btn-corpus` button | exact — clone the button markup |

---

## Pattern Assignments

### `src/viz/server.ts` — new `/index` GET route

**Analog:** `src/viz/server.ts:474-540` (`/doc` route) for the route skeleton; `src/viz/server.ts:153-160` for the data source.

**Prepared-statement-once pattern** (lines 153-169 — compile at server construction, not per-request):
```typescript
const stmtDocNodes = db.prepare(`
  SELECT n.id, n.type, n.value, n.s, n.c, n.origin, n.tombstoned, nd.slug,
         COALESCE(NULLIF(sch.value, ''), nd.slug) AS label
  FROM node n
  JOIN node_doc nd ON nd.node_id = n.id
  LEFT JOIN node sch ON sch.id = nd.slug AND sch.type = 'schema' AND sch.tombstoned = 0
  WHERE n.type='doc' AND n.tombstoned=0
`);
// Reuse stmtDocNodes — do NOT re-prepare inside the route handler.
```

**Route skeleton pattern** (lines 474-537 — GET, read-only, no side effects):
```typescript
if (url === '/doc') {
  const params = new URLSearchParams(req.url?.split('?')[1] ?? '');
  // ... sanitize input ...
  try {
    // ... stmtGetDoc.get(slug) ...
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(row.value);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('internal error');
  }
  return;
}
```

**`/index` implementation note:** No input params needed (returns all doc nodes). Call `stmtDocNodes.all()`, group rows by scope type (UUID vs. human-readable), return JSON. Follow the same try/catch + `res.writeHead` + `res.end` shape.

**Error handling pattern** (consistent across all routes):
```typescript
} catch (err) {
  res.writeHead(500, { 'content-type': 'text/plain' });
  res.end('internal error');
}
return;
```

---

### `src/viz/server.ts` — new `/doc/backlinks?slug=` GET route

**Analog:** `src/viz/server.ts:587-643` (`/doc/staleness` route) — identical slug-resolution preamble + stmtGetDoc lookup; `src/db/semantic-store.ts:519-521` for `getInEdges`.

**Slug-resolution preamble** (lines 587-608 — copy verbatim for any `?slug=` route):
```typescript
if (url === '/doc/backlinks') {
  const params = new URLSearchParams(req.url?.split('?')[1] ?? '');
  const rawId = params.get('id') ?? '';
  let slug: string;
  if (rawId) {
    const resolvedSlug = resolveDocSlugById(rawId);
    if (!resolvedSlug) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no live doc for id' }));
      return;
    }
    slug = resolvedSlug;
  } else {
    const rawSlug = params.get('slug') ?? '';
    slug = rawSlug.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64);
    if (!slug) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad slug');
      return;
    }
  }
  // ...
}
```

**Reverse-edge walk pattern** (lines 619-635 `/doc/staleness` — adapt for backlinks):
The staleness route walks `stmtCitedFacts.all(docRow.id)` and classifies rows. The backlinks route instead calls `getInEdges(docRow.id)` and filters to wiki-meaningful kinds (`doc_link`, `doc_reference`, `doc_containment`). Same try/catch and JSON response shape.

**`getInEdges` signature** (`src/db/semantic-store.ts:519`):
```typescript
getInEdges(nodeId: string): Array<{ src: string; w: number; kind: string }>
// Backed by: this.stmtGetInEdges = db.prepare('SELECT src, w, kind FROM edge WHERE dst = ?')
// (semantic-store.ts:207-208)
```

**Backlinks filtering (D-06):** Filter the `getInEdges` result to `kind IN ('doc_link','doc_reference','doc_containment')` — same set as `stmtDocLinks`. Then resolve each `src` node id to its label/slug (reuse the `stmtDocNodes` result or a targeted lookup). Return JSON: `{ backlinks: [{ srcId, slug, label, kind }] }`.

**Read-only constraint (T-27-11, WIKI-03):** Route is GET only. No `stmtGetDoc` or `getInEdges` call ever writes. No write-path mutation permitted.

---

### `src/viz/modules/index.js` (new module)

**Analog:** `src/viz/modules/corpus.js` (entire file) — identical init function shape, toolbar-button toggle pattern, lazy-init, and ctx hook pattern.

**Module skeleton** (corpus.js lines 65-69 — copy the export function signature):
```javascript
export function initIndex(ctx) {
  const indexBtn = document.getElementById('btn-index');
  const container = document.getElementById('index-panel');  // new container element
  if (!indexBtn || !container) return;

  let loaded = false;
  // ...
}
```

**Lazy-init + fetch pattern** (corpus.js lines 79-134 — adapt for `/index` fetch):
```javascript
async function buildIndexPanel() {
  // Show loading indicator
  const statusEl = document.createElement('div');
  statusEl.className = 'index-status';
  statusEl.textContent = 'Loading index…';
  container.appendChild(statusEl);

  let errored = false;
  let data = { projects: [], schemas: [] };
  try {
    const res = await fetch('/index');
    if (res.ok) data = await res.json();
    else errored = true;
  } catch (_) { errored = true; }

  if (errored) { statusEl.textContent = 'Failed to load index'; return; }
  statusEl.remove();
  // ... render grouped list ...
}
```

**Toggle button pattern** (corpus.js lines 337-371):
```javascript
function setIndexButton() {
  indexBtn.setAttribute('aria-label', 'Show brain');
  indexBtn.setAttribute('title', 'Show brain');
  // ... update icon ...
  indexBtn.classList.add('index-active');
}
function setBrainButton() {
  indexBtn.setAttribute('aria-label', 'Index');
  indexBtn.setAttribute('title', 'Index');
  // ... update icon ...
  indexBtn.classList.remove('index-active');
}

indexBtn.addEventListener('click', () => {
  if (isIndexOpen) goToBrain();
  else goToIndex();
});
```

**ctx hook pattern** (corpus.js lines 382-393 — expose opener on ctx):
```javascript
// corpus.js precedent:
ctx.returnToCorpus = function returnToCorpus() { ... };

// index.js equivalent: expose openIndex if other modules need to trigger it
ctx.openIndex = function openIndex() { goToIndex(); };
```

**Icon pattern (inline SVG, no icon lib):** corpus.js lines 30-34 define `ICON_BOOK` and `ICON_BRAIN` as inline SVG strings. `index.js` defines its own icon pair (e.g. list-icon for index, brain-icon for brain return) the same way.

**Eager prepare pattern** (corpus.js line 398):
```javascript
// Eagerly prepare after init so first open is instant
setTimeout(() => { prepareIndex(); }, 1200);
```

**app.js wiring** (lines 32-33 and 232-233):
```javascript
// Add to imports:
import { initIndex } from './index.js';
// Add after initCorpus:
initIndex(ctx);   // READER-WP: browsable text index (#btn-index full-window toggle)
```

---

### `src/viz/modules/reader.js` — add "Referenced by" section

**Analog:** `src/viz/modules/reader.js:344-405` (`fetchStaleness` function) — identical structure: async fetch after render, DOM construction via `createElement`/`textContent`, append to `body`, non-fatal on error.

**Fetch-after-render hook pattern** (reader.js lines 244-249 — where to call the new hook):
```javascript
body.innerHTML = renderMarkdown(md);
wireFactLinks();
await fetchStaleness();   // existing
await fetchBacklinks();   // NEW — append "Referenced by" after staleness banner
await fetchMeta();
```

**DOM construction pattern** (reader.js lines 382-401 — copy the banner recipe):
```javascript
async function fetchBacklinks() {
  try {
    const res = await fetch('/doc/backlinks?' + docQuery());
    if (!res.ok) return; // non-fatal
    const data = await res.json();
    const links = Array.isArray(data.backlinks) ? data.backlinks : [];
    if (links.length === 0) return;

    const section = document.createElement('div');
    section.className = 'backlinks-section';  // new CSS class, muted rose/slate palette

    const heading = document.createElement('div');
    heading.className = 'backlinks-heading';
    heading.textContent = 'Referenced by';   // textContent only — T-10-12

    const list = document.createElement('ul');
    list.className = 'backlinks-list';
    for (const bl of links) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.className = 'doc-ref';
      a.setAttribute('data-doc', bl.srcId);
      a.setAttribute('href', '#');
      a.textContent = bl.label || bl.slug;  // textContent only — T-10-12/T-27-08
      a.addEventListener('click', ev => {
        ev.preventDefault();
        ctx.openReader(null, { from: openFrom, docId: bl.srcId });
      });
      li.appendChild(a);
      list.appendChild(li);
    }
    section.appendChild(heading);
    section.appendChild(list);
    body.appendChild(section);   // APPEND (not prepend) — staleness banner is at top
  } catch (_) {
    // non-fatal
  }
}
```

**Security pattern** (reader.js lines 22-24, T-10-12/T-27-08): all user-supplied strings (slugs, labels) set via `textContent`, never `innerHTML`. The `doc-ref` click handler reuses the existing `ctx.openReader` path (already wired in `wireFactLinks`).

**Palette rule (founder-locked):** "Referenced by" section uses muted rose/slate/mauve — NOT amber. Amber is activation-only. Copy `.staleness-banner` CSS rules (`styles.css:690-701`) as the style baseline.

---

### `src/viz/index.html` — add `#btn-index` toolbar button

**Analog:** `src/viz/index.html:73-82` (`#btn-corpus` button) — copy markup verbatim, change id and icon SVG.

**Button markup pattern** (lines 73-82):
```html
<!-- Index toggle — icon-only fixed button, sibling to #btn-corpus (D-08 / WIKI-01).
     Expanded Brain Window ONLY — hidden in popover/tray (same CSS gate as #btn-corpus). -->
<button id="btn-index" type="button" aria-label="Index" title="Index">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <!-- list icon (3 horizontal lines) — executor picks final SVG path -->
    <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/>
    <line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/>
    <line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
  </svg>
</button>
```

**CSS pattern** (styles.css lines 758-788 — clone `#btn-corpus` rules, substitute `#btn-index`):
```css
#btn-index { display: none; }
.mode-window #btn-index {
  position: fixed;
  top: 82px;    /* below #btn-corpus (46px + 30px + 6px gap) — or adjust cascade */
  right: 12px;
  width: 30px;
  height: 30px;
  /* ... identical to #btn-corpus rules ... */
}
.mode-window #btn-index:hover { opacity: 1; }
.mode-window #btn-index.index-active { opacity: 1; color: #c8bcd0; }
```

Also add an `#index-panel` container (sibling to `#corpus-graph`) using the same fixed/full-bleed CSS pattern as `#corpus-graph` (styles.css lines 796+).

---

## Shared Patterns

### Read-only route skeleton (T-27-11, WIKI-03)
**Source:** `src/viz/server.ts:474-537` and `:587-643`
**Apply to:** `/index` route and `/doc/backlinks` route

All new routes are GET-only. Pattern: parse `req.url`, sanitize params (`rawSlug.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64)`), call compiled prepared statements, `res.writeHead(200, { 'content-type': 'application/json' })`, `res.end(JSON.stringify(...))`, catch any error with `res.writeHead(500)` + `res.end('internal error')`, always `return` after handling.

### Prepared-statement-once
**Source:** `src/viz/server.ts:141-169` (all `stmt*` variables compiled at server construction time)
**Apply to:** `/index` route (reuses `stmtDocNodes`), `/doc/backlinks` route (needs `stmtGetDoc` + the `getInEdges` call on the SemanticStore instance)

Never re-prepare inside the route handler. All statements compile once in the outer server closure.

### Muted rose/slate/mauve palette (founder-locked)
**Source:** `src/viz/css/styles.css:690-716` (`.staleness-banner`, `.btn-regen`)
**Apply to:** "Referenced by" section CSS, `#btn-index` active state, `#index-panel` background

Key values: `rgba(139, 112, 144, 0.09)` fill, `rgba(139, 112, 144, 0.4)` border-left, `#9a8aa4` text, `#c8bcd0` label. Amber (`#ffb866`) is NEVER used for structural chrome — activation-only.

### textContent-only DOM (T-10-12 / T-27-08)
**Source:** `src/viz/modules/reader.js:362-401` (`fetchStaleness` DOM construction), `src/viz/modules/detail.js:216-259` (`populateDetail`)
**Apply to:** backlinks list rendering, index panel rendering

All user-supplied data (slugs, labels, node values) set via `.textContent` or `a.textContent`. `innerHTML` is only ever used to clear own container structure (`container.innerHTML = ''`), never with user data. No template literals with node values.

### Toolbar button lazy-init guard
**Source:** `src/viz/modules/corpus.js:65-69` and `294-326`
**Apply to:** `src/viz/modules/index.js`

Check `if (!btn || !container) return` at function top. The build-once `preparePromise` pattern memoizes on success but retries on error/empty (non-ready outcome sets `preparePromise = null`).

### Non-fatal async fetch
**Source:** `src/viz/modules/reader.js:344-405` (`fetchStaleness`)
**Apply to:** `fetchBacklinks()` in reader.js

Pattern: `try { const res = await fetch(url); if (!res.ok) return; /* process */ } catch (_) { /* silent */ }`. Backlinks and index data are enhancements — their fetch failure must not break the primary doc render.

---

## No Analog Found

All surfaces have close analogs. No files require falling back to RESEARCH.md patterns.

---

## Metadata

**Analog search scope:** `src/viz/server.ts`, `src/viz/modules/`, `src/viz/index.html`, `src/viz/css/styles.css`, `src/db/semantic-store.ts`
**Files scanned:** 8
**Pattern extraction date:** 2026-06-21
