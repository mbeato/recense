---
phase: 39-reader-wiki-parity-index-and-backlinks
reviewed: 2026-06-21T00:00:00Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - src/viz/server.ts
  - src/viz/modules/index.js
  - src/viz/modules/corpus.js
  - src/viz/modules/detail.js
  - src/viz/modules/reader.js
  - src/viz/modules/app.js
  - src/viz/index.html
  - src/viz/css/styles.css
  - tests/doc-backlinks.test.ts
  - tests/viz-index-route.test.ts
findings:
  critical: 0
  warning: 4
  info: 4
  total: 8
status: issues_found
---

# Phase 39: Code Review Report

**Reviewed:** 2026-06-21
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

Reviewed the Phase 39 reader wiki-parity work: the new `/doc/backlinks` (WIKI-02) and `/index` (WIKI-01) server routes plus the `index.js` sidebar, corpus cross-highlight hooks, and the doc-/atom-backlinks rendering in `reader.js` and `detail.js`.

The load-bearing invariants hold:
- **Read-only DB:** `server.ts` opens exactly one `new Database(dbPath, { readonly: true })` (line 137). Both new routes reuse statements compiled once at construction (`stmtDocBacklinks`, `stmtCitingDocs`, `stmtDocNodes`, `stmtDocLinks`) — no in-handler `db.prepare`, no `new Database`, no LLM/embed/write/spawn on the read paths. T-39-07/T-27-11 preserved.
- **XSS:** all DB-sourced strings (`label`, `slug`, headings) reach the DOM via `.textContent`; the only `innerHTML` writes are inline SVG icon constants and `renderMarkdown` output (escaped). Slugs/ids in navigation pass through `encodeURIComponent`. T-39-08/T-10-12 preserved.
- **Palette:** new `#index-*` and `.backlinks-*` CSS is muted rose/slate/mauve at rest (`#9a8aa4`, `#c8bcd0`, `rgba(139,112,144,...)`); amber (`#ffb866`/`HOVER_NODE`) appears only in hover/activation paths (`corpus.js` containment-spine highlight). No amber as structural rest-state chrome.
- **Cycle safety:** both BFS/tree walks are guarded — `index.js` `emit` uses a `seen` set, `corpus.js` `highlightCorpusNode` BFS uses `next.has(t)`, and `server.ts` `rootAndDepth` uses a `seen` set with a `break` on revisit.

The defects below are correctness/quality issues, none security or data-loss.

## Warnings

### WR-01: Stale "Cited by" backlinks section persists across node selections (wrong attribution)

**File:** `src/viz/modules/detail.js:313-367` (gate at 315; early-return at 332; removal at 335)
**Issue:** `fetchAtomBacklinks` is the ONLY code that removes the prior `.backlinks-section`, and it does so *after* the `if (docs.length === 0) return;` early return and only when called. Two paths leave a stale section attached to `detailEl`:
1. Selecting a `doc` or `schema` node never calls `fetchAtomBacklinks` (gate on line 315 excludes both), so a "Cited by" section from a previously-selected fact stays in the panel.
2. Selecting a fact/entity with zero citing docs returns at line 332 *before* the removal on line 335, so the previous fact's "Cited by" list persists.

Neither `clearSelection()` nor `populateDetail()` removes `.backlinks-section` (they only clear `metaEl`/`connsEl`). Result: the panel shows citing docs that belong to a *different* atom — incorrect information attribution.
**Fix:** Remove any prior section unconditionally before the early returns — e.g. clear it at the top of `populateDetail` alongside the `metaEl.innerHTML = ''` reset:
```js
// in populateDetail, before the fetchAtomBacklinks gate:
const priorBL = detailEl.querySelector('.backlinks-section');
if (priorBL) priorBL.remove();
```
and drop the in-`fetchAtomBacklinks` removal (or keep it, but move it before the `docs.length === 0` check).

### WR-02: `/doc/backlinks` and `/index` accept any HTTP method despite documented GET-only contract

**File:** `src/viz/server.ts:684` (`/doc/backlinks`), `src/viz/server.ts:753` (`/index`)
**Issue:** Both handlers are documented as GET-only (WIKI-03: "Both paths are GET-only, read-only"; `/index` comment "GET-only, read-only, no params") but neither checks `req.method`. A `POST`/`PUT`/`DELETE` to these URLs runs the SELECT and returns 200. By contrast the sibling write route `/doc/generate` correctly gates on `req.method === 'POST'` (line 820). The routes are read-only so this is not a data-integrity risk, but it diverges from the stated contract and from the route-guard pattern used elsewhere.
**Fix:** Add a method guard at the top of each handler:
```js
if (url === '/index' && req.method !== 'GET') {
  res.writeHead(405, { 'content-type': 'text/plain' }); res.end('method not allowed'); return;
}
```
(or fold the method into the `if` condition). Same for `/doc/backlinks`.

### WR-03: `localeCompare` on a possibly-undefined label can throw and 500 the `/index` route

**File:** `src/viz/server.ts:806-807`
**Issue:** `projects.sort((a, b) => a.label.localeCompare(b.label))` calls `.localeCompare` directly on `a.label`. The label comes from `COALESCE(NULLIF(sch.value, ''), nd.slug)` — `nd.slug` is NOT NULL in the seeded schema, so in practice it is always a string. But if a `node_doc` row ever has a NULL/empty slug (or the JOIN shape changes), `a.label` is `null` and `.localeCompare` throws `TypeError`, caught by the outer `try` and returned as a generic 500 — taking down the whole index instead of degrading gracefully. The client-side comparator in `index.js:175` already defends with `(a.label || a.slug)`; the server should match.
**Fix:** Defend the server comparator:
```js
const byLabel = (a, b) => (a.label || a.slug || '').localeCompare(b.label || b.slug || '');
projects.sort(byLabel);
schemas.sort(byLabel);
```

### WR-04: Backlinks "Referenced by" / "Cited by" lists are not de-duplicated by target doc

**File:** `src/viz/server.ts:243-265` (`stmtDocBacklinks`, `stmtCitingDocs`); rendered `src/viz/modules/reader.js:432`, `src/viz/modules/detail.js:347`
**Issue:** A single source doc can link to the same destination via more than one wiki-meaningful edge kind (e.g. both a `doc_containment` parent edge AND a `doc_reference` cross-link, which the corpus graph explicitly models as distinct edges — see `corpus.js` link styling). `stmtDocBacklinks` returns one row per edge with no `GROUP BY`/`DISTINCT`, so the same doc renders as two identical "Referenced by" rows (same `label`, same `srcId`, differing only in `kind`). The atom view's `stmtCitingDocs` has the same exposure if a doc carries duplicate `cites` edges to one fact. The renderers iterate rows 1:1 with no de-dup, producing visible duplicate entries.
**Fix:** Either de-dup in SQL (`SELECT ... GROUP BY e.src` keeping one representative `kind`, or `MIN(e.kind)`), or de-dup in the renderer by `srcId` before building the `<li>` list. Given the dom layer should not assume DB shape, prefer the SQL `GROUP BY e.src`.

## Info

### IN-01: Over-broad atom-backlinks gate fetches for all non-doc/non-schema node types

**File:** `src/viz/modules/detail.js:315`
**Issue:** `if (node.type === 'fact' || (node.type !== 'doc' && node.type !== 'schema'))` — the first clause is redundant (a `fact` already satisfies the second), and the second clause fires for `entity`, tombstones, and any unknown/undefined type, issuing a `/doc/backlinks?fact=` request for each. This is read-only and the empty result renders nothing, but it produces needless fetches on node types that are never cited as facts.
**Fix:** Collapse to the intended atom set, e.g. `if (node.type === 'fact' || node.type === 'entity')`, or document that "atom" deliberately means "anything that isn't a doc/schema".

### IN-02: Eager `/index` fetch fires on every page load even if the corpus is never opened

**File:** `src/viz/modules/index.js:291`
**Issue:** `setTimeout(() => { prepareIndex(); }, 1200)` eagerly fetches `/index` and builds the sidebar chrome 1.2s after init, regardless of whether the user ever opens the corpus view. The corpus view does the same for `/graph?type=doc` (`corpus.js:473`), so this mirrors an established pattern, but it means a network round-trip and DOM construction for a sidebar that may never be shown.
**Fix:** Acceptable if intentional (warms the first-open). If not, defer `prepareIndex()` to the first `openSidebar()` call (which already invokes it on line 264).

### IN-03: Redundant `ensureChrome()` call

**File:** `src/viz/modules/index.js:242-243`
**Issue:** `prepareIndex` calls `ensureChrome()` then `buildIndexPanel()`, and `buildIndexPanel()` calls `ensureChrome()` again on line 212. `ensureChrome` is idempotent (guards on `if (contentEl) return`), so this is harmless, just dead duplication.
**Fix:** Drop the `ensureChrome()` on line 242 and rely on the one inside `buildIndexPanel`.

### IN-04: `ctx.openIndex` exposed but never referenced

**File:** `src/viz/modules/index.js:289`
**Issue:** `ctx.openIndex = openSidebar;` is set alongside `ctx.openIndexSidebar` (line 287), but no module calls `ctx.openIndex` (the corpus toggle uses `ctx.openIndexSidebar`/`ctx.closeIndexSidebar`, and the dedicated `#btn-index` was removed per the corpus.js comments). Dead export.
**Fix:** Remove `ctx.openIndex` unless a future toolbar button is planned; if kept, add a comment noting it is reserved.

---

_Reviewed: 2026-06-21_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
