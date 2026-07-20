# Phase 27: Reader Layer - Pattern Map

**Mapped:** 2026-06-18
**Files analyzed:** 9 new/modified files
**Analogs found:** 9 / 9

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/db/schema.ts` | migration/config | batch (DDL) | `src/db/schema.ts` v7/v8/v9/v10 migrations | exact (self-reference) |
| `src/lib/types.ts` | model | N/A | `src/lib/types.ts` existing types | exact (self-reference) |
| `src/reader/doc-generator.ts` (new) | service | request-response | `scripts/reader-slice/generate.ts` + `src/model/claim-extractor.ts` | exact |
| `src/reader/doc-gather.ts` (new) | service | CRUD | `scripts/reader-slice/gather.ts` + `src/retrieval/topk.ts:hybridTopk` | role-match |
| `src/consolidation/doc-writer.ts` (new) | service | CRUD | `src/consolidation/consolidator.ts` (upsertNode / Phase B write path) | role-match |
| `src/viz/server.ts` | controller | request-response | `src/viz/server.ts` `/doc` + `/graph` routes | exact (self-reference) |
| `src/viz/modules/reader.js` | component | event-driven | `src/viz/modules/reader.js` (untracked slice) | exact (promote in-place) |
| `src/viz/modules/detail.js` | component | event-driven | `src/viz/modules/detail.js` (existing) | exact (add stale diff) |
| `src/viz/css/styles.css` | config | N/A | `src/viz/css/styles.css` `.fact-ref` / `#reader` existing rules | exact (extend) |

---

## Pattern Assignments

### `src/db/schema.ts` — v11 migration (migration, batch)

**Analog:** `src/db/schema.ts` v7 edge-recreation migration (lines 269–300) and v10 `node_scope` migration (lines 325–334).

**Why v7 is the right template for `node.type` / `edge.kind` CHECK extension:** both changes require table recreation (SQLite cannot ALTER a CHECK constraint). v7 shows the full guard+swap+index pattern.

**DDL additions needed in the `DDL` const (lines 41 and 63):**
```sql
-- line 41: change CHECK from ('entity','fact','schema') to:
CHECK(type IN ('entity','fact','schema','doc'))

-- line 63: change CHECK from ('relation','abstracts','schema_rel') to:
CHECK(kind IN ('relation','abstracts','schema_rel','cites','doc_link'))
```

**Also needed — new `node_doc` sidecar table** (mirrors `node_scope`/`node_temporal` precedent, line 140):
```sql
-- READER-01: doc metadata sidecar (1:1 with type='doc' nodes).
-- generated_at is a DEDICATED column (not node.last_access) — the doc's own
-- last_access can advance, corrupting the `node.last_access > doc.generated_at`
-- staleness predicate (CONTEXT D, "Claude's Discretion" §generatedAt).
-- Single writer: doc-writer path only.
CREATE TABLE IF NOT EXISTS node_doc (
  node_id      TEXT    PRIMARY KEY REFERENCES node(id),
  slug         TEXT    NOT NULL,      -- project slug (matches node_scope.scope)
  generated_at INTEGER NOT NULL,      -- epoch ms; set once on first generate, updated on regen
  updated_at   INTEGER NOT NULL       -- epoch ms; always updated
);
CREATE INDEX IF NOT EXISTS idx_node_doc_slug ON node_doc(slug);
```

**v11 migration guard pattern** (copy from v7, lines 272–299):
```typescript
// v11 migration: extend node.type CHECK to include 'doc';
//   extend edge.kind CHECK to include 'cites' and 'doc_link'.
// SQLite cannot ALTER a CHECK constraint — table recreation required for both.
// Guard: check whether the existing DDL already includes 'doc' — idempotent re-run safe.
const nodeDdl = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='node'")
  .get() as { sql: string } | undefined)?.sql ?? '';
if (!nodeDdl.includes("'doc'")) {
  db.pragma('foreign_keys = OFF');
  db.exec(`
    BEGIN;
    CREATE TABLE node_v11 ( ... ); -- full DDL with 'doc' in CHECK
    INSERT INTO node_v11 SELECT * FROM node;
    DROP TABLE node;
    ALTER TABLE node_v11 RENAME TO node;
    COMMIT;
  `);
  // Re-create all node indexes (idx_node_dirty, node_fts)
  db.pragma('foreign_keys = ON');
}
// Same pattern for edge if 'cites' not yet in DDL
```

**`SCHEMA_VERSION` bump:** line 11. Increment from `10` to `11`.

**Version stamp guard** (lines 337–352): unchanged pattern — will throw if a stale binary tries to run against v11 DB.

---

### `src/lib/types.ts` — new types (model, N/A)

**Analog:** `src/lib/types.ts` existing `NodeRow`, `EdgeRow`, `UpsertNodeScopeParams` (lines 33, 65, 145).

**`NodeType` union** (line 21): add `'doc'` — change to:
```typescript
export type NodeType = 'entity' | 'fact' | 'schema' | 'doc';
```

**`EdgeKind` union** (line 27): add `'cites'` and `'doc_link'`:
```typescript
export type EdgeKind = 'relation' | 'abstracts' | 'schema_rel' | 'cites' | 'doc_link';
```

**New `NodeDocRow` interface** (mirror `NodeTemporalRow` pattern, line 132):
```typescript
export interface NodeDocRow {
  node_id: string;
  slug: string;
  generated_at: number;   // epoch ms — NOT node.last_access (CONTEXT D)
  updated_at: number;
}

export interface UpsertNodeDocParams {
  node_id: string;
  slug: string;
  generated_at: number;
  updated_at: number;
}
```

---

### `src/reader/doc-generator.ts` (new, service, request-response)

**Primary analog:** `scripts/reader-slice/generate.ts` (lines 1–114) — the full generate+verify loop. This file is the product version: receives gathered facts, calls `provider.generate`, writes to DB instead of to filesystem.

**Secondary analog:** `src/model/claim-extractor.ts:399` — the `provider.generate(prompt, { maxTokens })` call pattern (inverted: facts → doc, not doc → facts).

**Imports pattern** (from `generate.ts` lines 16–19, adapted for product):
```typescript
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../lib/config';
import { DefaultModelProvider } from '../model/provider';
import type { NodeRow } from '../lib/types';
```

**Model config pattern** (D-04 — judge-tier env model, NOT a new var):
The slice used `config.anthropicModel` directly (`generate.ts` line 47). Product must use the judge-tier config slot. From `src/model/provider.ts:91–103`:
```typescript
// D-04: doc generation uses the judge-tier model (same env var as the consolidator judge).
// No docModel/genModel var — the judge slot is the single strong-model source of truth.
const provider = new DefaultModelProvider({
  generateConfig: judgeConfig,  // judge-tier config for generation
  judgeConfig: judgeConfig,
  embedConfig: embedConfig,
});
```

**Generation prompt pattern** (from `generate.ts` lines 30–45 — reuse verbatim, this is the validated prompt that produced 19/19 resolve):
```typescript
const prompt = `You are generating a human-readable PROJECT DEEP-DIVE from a set of atomic memory facts.

You are given FACTS about "${slug}". Each line is: [<uuid>] <fact text>

FACTS:
${factBlock}

Write a structured markdown deep-dive about "${slug}". Use only the sections the facts can support (e.g. One-liner, Infrastructure, Pipelines/Operations, State, Open questions).

HARD RULES:
1. Every substantive claim MUST cite the fact id(s) it draws from, inline, as a markdown link: [the cited phrase](recense://fact/<uuid>). Use the exact uuid from the bracket.
2. Use ONLY the provided facts. Do NOT add any outside knowledge or invent details. If you cannot cite it from a fact above, do not write it.
3. If facts conflict, note the conflict and cite both.
4. Prefer specific, interview-defensible detail over generic prose.

Output ONLY the markdown deep-dive, no preamble.`;
```

**generate call pattern** (from `generate.ts` line 57):
```typescript
const md = await provider.generate(prompt, { maxTokens: 4000 });
```

**Citation verify loop** (from `generate.ts` lines 63–93 — reuse verbatim, this is the integrity check):
```typescript
const citedIds = [...md.matchAll(/recense:\/\/fact\/([0-9a-f-]{36})/g)].map(m => m[1]!);
const uniqueCited = [...new Set(citedIds)];
// For each id: db.prepare('SELECT id, tombstoned, last_access, prev_value FROM node WHERE id=?').get(id)
// → invented = no row; tombstoned = row.tombstoned === 1
```

**`cites` edge creation** (after verify): for each `recense://fact/<id>` in the generated doc:
```typescript
// One edge row per unique cited fact (kind='cites', doc node → fact node)
store.upsertEdge({ src: docNodeId, dst: factId, rel: 'cites', kind: 'cites', w: 1.0, last_access: now });
```

---

### `src/reader/doc-gather.ts` (new, service, CRUD)

**Primary analog:** `scripts/reader-slice/gather.ts` (lines 1–79) — the lexical∪entity gather. Product replaces the lexical-only path with `node_scope` + `hybridTopk` (D-01).

**Secondary analog:** `src/retrieval/topk.ts:hybridTopk` (lines 181–211) — the BM25+cosine fusion.

**Scope query pattern** (replaces `gather.ts` lines 26–31 lexical query):
```typescript
// D-01: primary gather = node_scope.scope = '<slug>' (project-attributed facts)
const scopedFacts = db.prepare(`
  SELECT n.id, n.value, n.c, n.origin, n.last_access
  FROM node_scope ns
  JOIN node n ON n.id = ns.node_id
  WHERE ns.scope = ? AND n.type = 'fact' AND n.tombstoned = 0
  ORDER BY n.s DESC
`).all(slug) as Row[];
```

**Semantic gather pattern** (D-01 breadth beyond literal name matches):
```typescript
// D-01: semantic gather = embed the project query + hybridTopk
// Uses the live SemanticStore.hybridTopk via the retrieval seam
const queryVec = await provider.embed([slug]);  // one embed call
const semanticHits = store.hybridTopk(queryVec[0]!, slug, 60);
// Filter to type='fact', tombstoned=0; union with scopedFacts
```

**Entity-linked hop** (from `gather.ts` lines 33–51 — may remain as augmentation):
```typescript
// Entity-linked: entities matching slug → 1-hop fact neighbors
const entityIds = db.prepare(
  `SELECT id FROM node WHERE type='entity' AND tombstoned=0 AND lower(value) LIKE ?`
).all(`%${slug}%`) as Array<{ id: string }>;
// Then neighbor query using edge JOIN (gather.ts lines 44–51)
```

**Union + dedup pattern** (from `gather.ts` lines 55–62 — reuse verbatim):
```typescript
const byId = new Map<string, Row & { via: string }>();
for (const r of scopedFacts) byId.set(r.id, { ...r, via: 'scope' });
for (const r of semanticHits) { /* upsert with via='semantic' */ }
for (const r of linkedFacts)  { /* upsert with via='linked' */ }
```

---

### `src/consolidation/doc-writer.ts` (new, service, CRUD)

**Analog:** `src/consolidation/consolidator.ts` — the single-writer invariant (CONSOL-03). Doc writes must go through `SemanticStore.upsertNode` (the only code path that writes `node.value`) and must explicitly skip lifecycle phases A and C.

**Lifecycle-exemption pattern** (from SPEC §3 + CONTEXT "Claude's Discretion"):
The doc node skips: recall-embed (no `upsertNodeTemporal`), eviction, decay, `training_eligible` (force 0), claim-extraction FROM the doc. Only Phase B (synchronous DB write) applies.

**upsertNode call pattern** (from `src/db/semantic-store.ts:227–249`). For a doc node:
```typescript
store.upsertNode({
  id: docId,
  type: 'doc',                          // new type after v11 migration
  value: markdownBody,
  origin: 'inferred',                   // generated, not user-asserted
  s: 0,                                 // no Hebbian decay (lifecycle exempt)
  c: 1.0,                               // generated content — high conf
  tombstoned: false,
  last_access: now,
  // training_eligible will be forced to 0 because origin='inferred'
});
// Then upsert node_doc sidecar:
store.upsertNodeDoc({ node_id: docId, slug, generated_at: now, updated_at: now });
// Then upsert node_scope:
store.upsertNodeScope({ node_id: docId, scope: slug, updated_at: now });
```

**Transaction pattern** (from `src/db/semantic-store.ts:205` rawTx pattern): wrap docNode + node_doc + node_scope + cites-edge writes in a single `db.transaction().immediate()` call to maintain single-writer atomicity.

**FTS suppression:** `upsertNode` auto-syncs FTS (semantic-store line 252–256). For doc nodes we may want to suppress FTS indexing (the doc markdown body pollutes keyword search). Guard: if `type === 'doc'`, run `stmtFtsDelete.run(id)` and skip `stmtFtsInsert` in the transaction.

---

### `src/viz/server.ts` — product `/doc` route + generate/regenerate endpoint (controller, request-response)

**Analog:** existing `src/viz/server.ts` (the file itself). The `/doc` route (lines 333–352) reads from a file; product replaces file-source with DB lookup. The `/graph` route (lines 210–233) is the pattern for the new JSON-returning endpoints.

**Existing `/doc` route to replace** (lines 333–352):
```typescript
// Current: reads from scripts/reader-slice/out/<term>.md (file)
// Product: reads from node WHERE type='doc' AND node_scope.scope = term
if (url === '/doc') {
  const rawTerm = new URLSearchParams(req.url?.split('?')[1] ?? '').get('term') ?? '';
  const term = rawTerm.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 64);
  // DB lookup pattern mirrors /graph:
  const docNode = stmtGetDoc.get(term);  // prepared: SELECT n.id, n.value, nd.generated_at ...
  if (!docNode) { res.writeHead(404, ...); return; }
  // Trigger lazy generation if no doc exists (D-02/D-03 lazy-generate-on-first-access)
  // ... async generate path here, with progress/streaming
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(docNode.value);
}
```

**New `/doc/generate` endpoint** (POST, mirrors `/graph` JSON pattern):
```typescript
// POST /doc/generate?slug=<slug> — triggers doc generation, returns {nodeId, citationCount}
// Security: same Host-header guard (lines 202–207); loopback-only
// Uses DocGenerator service (src/reader/doc-generator.ts)
// Response: { nodeId, slug, generated_at, citationCount, invented, tombstoned }
```

**Staleness check endpoint** (GET, mirrors `/search` pattern):
```typescript
// GET /doc/staleness?id=<docNodeId> — returns stale ref list for banner + inline markers
// Prepared stmt: SELECT ce.dst as factId, n.last_access, n.prev_value, n.prev_ts, n.tombstoned
//   FROM edge ce JOIN node n ON n.id = ce.dst
//   WHERE ce.src = ? AND ce.kind = 'cites'
// Compare each n.last_access against node_doc.generated_at for the doc node
```

**Corpus graph filter** (extend `/graph` for doc-type + doc_link edges):
```typescript
// Option (from CONTEXT D): extend GET /graph?type=doc to return only doc nodes + doc_link edges
// Lower-risk than nodeIds filter for READER-04 corpus view (server-side type filter)
// Prepared stmt additions:
const stmtDocNodes = db.prepare("SELECT id, type, value, s, c, origin, tombstoned FROM node WHERE type='doc'");
const stmtDocLinks = db.prepare("SELECT src, dst, rel, w, kind FROM edge WHERE kind='doc_link'");
```

**Prepared statement compile-once pattern** (lines 127–147): all new stmts compiled at server init alongside existing `stmtNodes`/`stmtEdges`/`stmtSearch`/`stmtTrace`.

---

### `src/viz/modules/reader.js` — promote slice + add staleness diff + corpus toggle (component, event-driven)

**Analog:** `src/viz/modules/reader.js` (untracked slice, lines 1–124). This file IS the analog — promote and extend it in-place. The slice's `renderMarkdown`, `FACT_LINK`/`DOC_LINK` regexes, `escapeHtml`, `renderInline`, and `wireFactLinks` patterns are all reusable verbatim.

**FACT_LINK / DOC_LINK regex** (lines 13–14 — reuse verbatim):
```javascript
const FACT_LINK = /\[([^\]]+)\]\(recense:\/\/fact\/([0-9a-f-]{36})\)/g;
const DOC_LINK  = /\[([^\]]+)\]\(recense:\/\/doc\/([a-z0-9-]+)\)/g;
```

**renderMarkdown** (lines 38–66 — reuse verbatim, pure function):
```javascript
export function renderMarkdown(md) { /* ... headings/hr/lists/paragraphs → HTML */ }
```

**wireFactLinks** (lines 109–123 — reuse; extend to mark stale refs):
```javascript
// Existing pattern (lines 111–122):
body.querySelectorAll('a.fact-ref[data-fact]').forEach(a => {
  const id = a.getAttribute('data-fact');
  const node = ctx.idMap && ctx.idMap.get(id);
  if (!node) { a.classList.add('fact-missing'); missing++; return; }
  a.addEventListener('click', ev => {
    ev.preventDefault();
    hide();
    if (ctx.selectNode) ctx.selectNode(node);
  });
});
// Product extension: also mark stale refs using staleness payload from /doc/staleness
// a.classList.add('fact-stale') for refs where last_access > generated_at
// a.dataset.prevValue = ... for diff in atom panel (detail.js)
```

**Toggle pattern** (lines 77–92 — the show/hide cycle):
```javascript
// Slice: btn-reader toggles reader panel open/closed
// Product: same pattern; btn toggle label becomes 'Brain' ↔ 'Reader'
// READER-02 corpus-graph toggle: a SECOND button (btn-corpus, expanded-only)
//   swaps graph data via ctx.Graph.graphData({nodes: docNodes, links: docLinks})
//   from pre-fetched /graph?type=doc response
btn.addEventListener('click', () => (panel.classList.contains('open') ? hide() : show()));
```

**Lazy load pattern** (lines 94–107 — reuse; change endpoint):
```javascript
// Slice fetches /doc?term=<term> (file-backed)
// Product fetches /doc?slug=<slug> (DB-backed, lazy-generates on first access)
// Loading state: body.textContent = 'loading…' (D-03: progress bar replaces this)
const md = await fetch('/doc?slug=' + encodeURIComponent(slug)).then(r => {
  if (!r.ok) throw new Error('GET /doc → ' + r.status);
  return r.text();
});
body.innerHTML = renderMarkdown(md);
```

**Staleness banner** (new, D-10):
```javascript
// After wireFactLinks(), fetch /doc/staleness?id=<docNodeId>
// If staleCount > 0, prepend a banner to reader-body:
// <div class="staleness-banner">N cited facts changed since this was written
//   <button class="btn-regen">regenerate</button></div>
// btn-regen click → POST /doc/generate?slug=<slug> → reload
```

---

### `src/viz/modules/detail.js` — stale diff in atom panel (component, event-driven)

**Analog:** `src/viz/modules/detail.js` `populateDetail` function (lines 185–220). Add `prev_value → value` diff display when the node has `prev_value` AND the context includes a staleness signal from the reader.

**`populateDetail` pattern** (lines 185–210 — the field list to extend):
```javascript
// Existing fields (lines 192–198):
const fields = [
  ['type',       node.tombstoned ? 'tombstone' : (node.type || '—')],
  ['strength',   typeof node.s === 'number' ? node.s.toFixed(3) : '—'],
  ['confidence', typeof node.c === 'number' ? node.c.toFixed(3) : '—'],
  ['origin',     node.origin || '—'],
];
// Product extension: add prev_value → value diff when node is stale (from reader context)
if (node.prev_value && ctx.staleFactIds && ctx.staleFactIds.has(node.id)) {
  // createElement + textContent (T-10-12 — never innerHTML with node values)
  const diffRow = document.createElement('div');
  diffRow.className = 'meta-row meta-diff';
  // Show: "was: <prev_value>"  (one-deep history, SPEC §3 prev_value/prev_ts)
  const kEl = document.createElement('span'); kEl.className = 'meta-key'; kEl.textContent = 'was';
  const vEl = document.createElement('span'); vEl.className = 'meta-val'; vEl.textContent = node.prev_value;
  diffRow.appendChild(kEl); diffRow.appendChild(vEl);
  metaEl.appendChild(diffRow);
}
```

**XSS constraint** (line 184 comment): ALL node values via `textContent` — never `innerHTML` with user/node data. This is a hard invariant. The diff display is no exception.

**`ctx.staleFactIds` passing pattern:** reader.js sets `ctx.staleFactIds = new Set(staleIds)` after fetching `/doc/staleness`, then calls `ctx.selectNode(node)` which calls `populateDetail`. No new panel is needed.

---

### `src/viz/css/styles.css` — staleness markers + corpus toggle button (config, N/A)

**Analog:** `src/viz/css/styles.css` existing `.fact-ref` and `#reader` rules (lines 562–614).

**Existing fact-ref CSS** (lines 604–613 — patterns to extend):
```css
.fact-ref { /* amber underline */ }
.fact-ref:hover { background: rgba(217, 160, 92, 0.14); border-bottom-color: #d9a05c; }
.fact-ref.fact-missing { border-bottom-color: rgba(150, 90, 90, 0.6); opacity: 0.7; cursor: default; }
.doc-ref { color: #9c7080; text-decoration: none; border-bottom: 1px dotted rgba(156, 112, 128, 0.6); }
```

**New classes to add (extend the fact-ref block):**
```css
/* Stale ref: cited fact has changed since doc was generated (D-10 inline marker) */
.fact-ref.fact-stale {
  border-bottom-color: rgba(217, 130, 60, 0.8);
  background: rgba(217, 130, 60, 0.07);
}
.fact-ref.fact-tombstoned {
  border-bottom-color: rgba(150, 60, 60, 0.7);
  text-decoration: line-through;
  opacity: 0.6;
  cursor: default;
}

/* Staleness banner (D-10 top-of-doc summary) */
.staleness-banner {
  background: rgba(217, 130, 60, 0.09);
  border-left: 2px solid rgba(217, 160, 92, 0.5);
  padding: 8px 12px;
  margin-bottom: 16px;
  font-size: 12px;
  color: #b09070;
  display: flex;
  align-items: center;
  gap: 10px;
}

/* prev_value diff row in the atom panel (detail.js D-10) */
.meta-diff .meta-key { color: #8b7090; }
.meta-diff .meta-val { color: #a08090; font-style: italic; }
```

**Corpus graph button** (expanded-only per D-07 — CSS gate already exists):
```css
/* btn-corpus: only shows in .mode-window (expanded Brain Window), never in .mode-popover */
#btn-corpus { display: none; }
.mode-window #btn-corpus { display: inline-flex; }
```

---

## Shared Patterns

### Single-Writer Invariant
**Source:** `src/consolidation/consolidator.ts` header comment (lines 1–30) + `src/db/semantic-store.ts:196–258`
**Apply to:** `src/consolidation/doc-writer.ts`
All doc node writes route exclusively through `SemanticStore.upsertNode` + `upsertNodeDoc` + `upsertNodeScope` + `upsertEdge`. No raw SQL on node/edge tables in the doc-writer. Wrap all writes in a single `db.transaction().immediate()` call.

### Prepared Statement Compile-Once
**Source:** `src/viz/server.ts` lines 127–147
**Apply to:** `src/viz/server.ts` (new doc stmts), `src/consolidation/doc-writer.ts`, `src/reader/doc-gather.ts`
All SQLite prepared statements compiled once at construction/startup, never inside request handlers or per-call loops.

### Path-Traversal Guard
**Source:** `src/viz/server.ts` lines 102–110 (`safeVendorPath`)
**Apply to:** `src/viz/server.ts` (new `/doc` DB route no longer reads files, so DOC_ROOT and the file-read guard can be removed)

### Host-Header Loopback Guard
**Source:** `src/viz/server.ts` lines 200–207
**Apply to:** All new routes in `src/viz/server.ts` — inherited automatically (guard applies before any URL dispatch).

### T-10-12 DOM Safety (textContent-only)
**Source:** `src/viz/modules/detail.js` line 184 comment + `populateDetail` lines 185–216
**Apply to:** `src/viz/modules/reader.js` staleness banner (use `textContent` for node values; only static structure HTML in `innerHTML`), `src/viz/modules/detail.js` diff row.

### Migration Guard Pattern
**Source:** `src/db/schema.ts` v7 migration (lines 272–299)
**Apply to:** v11 migration in `src/db/schema.ts`. Guard with DDL string inspection before table recreation; wrap in explicit `BEGIN/COMMIT`; `PRAGMA foreign_keys OFF` before and `ON` after; re-create all affected indexes.

### Judge-Tier Model Config (D-04)
**Source:** `src/model/provider.ts:82–103` (three-head constructor) + `DEFAULT_CONFIG` from `src/lib/config`
**Apply to:** `src/reader/doc-generator.ts`
Doc generation uses `judgeConfig` for the `generateConfig` head — no new env var. Pattern: `new DefaultModelProvider({ generateConfig: judgeConfig, judgeConfig, embedConfig })`.

---

## No Analog Found

None. All files have direct analogs in the codebase.

---

## Metadata

**Analog search scope:** `src/db/`, `src/lib/`, `src/model/`, `src/consolidation/`, `src/retrieval/`, `src/viz/`, `scripts/reader-slice/`
**Files scanned:** 13 source files read directly
**Pattern extraction date:** 2026-06-18
