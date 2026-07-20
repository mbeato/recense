---
phase: 27-reader-layer
plan: "05"
subsystem: reader-corpus
tags: [corpus-graph, doc-link-edges, viz-server, expanded-only, flat-2d-graph, vendored-force-graph, fk-safe, tdd]
dependency_graph:
  requires: [v11-schema, node-doc-sidecar, doc-link-kind-in-schema, generate-doc-cli, writeDoc, READER-03]
  provides: [doc-link-edges, corpus-graph-endpoint, flat-2d-corpus-graph, corpus-full-window-toggle, doc-node-reader-entry, READER-04]
  affects:
    - src/reader/doc-generator.ts
    - src/consolidation/doc-writer.ts
    - src/viz/server.ts
    - src/viz/modules/corpus.js
    - src/viz/modules/reader.js
    - src/viz/modules/app.js
    - src/viz/index.html
    - src/viz/css/styles.css
    - src/viz/vendor/force-graph.min.js
tech_stack:
  added:
    - "force-graph@1.43.5 (vendored — 2D canvas sibling of 3d-force-graph, same author, no THREE dep)"
  patterns:
    - doc-link-in-set-guard
    - corpus-graph-type-filter
    - slug-in-corpus-node-response
    - expanded-only-css-gate
    - flat-2d-corpus-separate-instance
    - full-window-hide-show-toggle
    - lazy-init-corpus-on-first-open
    - d08-doc-node-click-reader-open
key_files:
  created:
    - tests/doc-link-edges.test.ts
    - tests/viz-corpus-graph.test.ts
    - src/viz/modules/corpus.js
  modified:
    - src/reader/doc-generator.ts
    - src/consolidation/doc-writer.ts
    - src/viz/server.ts
    - src/viz/modules/reader.js
    - src/viz/modules/app.js
    - src/viz/index.html
    - src/viz/css/styles.css
  vendored:
    - src/viz/vendor/force-graph.min.js
decisions:
  - "linkedDocRefs returned by generateDoc contains all recense://doc/<id> refs from prose (no in-set guard in generator — that's writeDoc's job)"
  - "/graph?type=doc JOINs node_doc to expose slug field alongside standard NodeRecord fields (D-08 click resolution without extra server endpoint)"
  - "CSS expanded-only gate mirrors the search/topic-wrap pattern: #btn-corpus { display:none } / .mode-window #btn-corpus { display:inline-flex }"
  - "doc_link edges are written inside the same IMMEDIATE transaction as cites edges (atomic, T-27-15)"
  - "stmtDocNodes and stmtDocLinks compiled once at server startup (compile-once pattern)"
  - "DESIGN CHANGE (founder-directed, post-738aa66): the corpus view is a SEPARATE flat 2D Obsidian-style graph (vendored force-graph) on its own #corpus-graph container — NOT a data-swap into the 3D brain. Toggling Corpus hides #graph + shows #corpus-graph full-window; toggling Brain restores the 3D brain untouched (no rebuild, no density regression)"
  - "force-graph vendored as a file (net-zero npm deps, same posture as 3d-force-graph) — 2D canvas, no THREE dependency, exposes window.ForceGraph"
  - "corpus.js owns #btn-corpus entirely (moved out of reader.js); lazy-inits the 2D instance on first Corpus open"
  - "D-08 doc-node click: corpus.js openDocReader() resolves slug from nodeSlugs map (built during buildCorpusGraph), then navigates to /?doc=slug&reader=1"
metrics:
  duration: "~175 min (incl. flat-2D redesign + zoom/in-place-reader fixes + sibling-doc emission)"
  completed: "2026-06-18"
  tasks_completed: 3
  files_changed: 13
  checkpoint_task: "Task 3 (human-verify corpus graph) — flat-2D redesign rebuilt; founder to reload-confirm on 7819"
---

# Phase 27 Plan 05: Doc→Doc Corpus Graph Summary

**One-liner:** doc_link edges from in-prose recense://doc refs (FK-safe in-set guard) + /graph?type=doc corpus endpoint with slug in node data + a SEPARATE flat 2D Obsidian-style corpus graph (vendored force-graph) toggled full-window by the expanded-only #btn-corpus (D-07) + doc-node click → reader open (D-08).

## What Was Built

### Task 1: doc_link edge creation from recense://doc/<id> refs (TDD — RED→GREEN)

**src/reader/doc-generator.ts:**
- `GenerateDocResult` gains `linkedDocRefs: string[]` — unique target doc ids parsed from `recense://doc/<id>` refs in the generated markdown.
- Parse uses the same DOC_LINK id shape as reader.js: `[a-z0-9-]+`.
- All doc refs from prose are returned (no in-set guard in the generator — writeDoc is responsible for filtering).
- Parse runs on the CANONICALIZED markdown (after fact-ref rewriting) using `DOC_REF = /recense:\/\/doc\/([a-z0-9-]+)/g`.

**src/consolidation/doc-writer.ts:**
- `WriteDocParams` gains optional `linkedDocRefs?: string[]`.
- Before the transaction: `stmtCheckLiveDoc` prepared (same connection, safe within txWrite).
- Inside the IMMEDIATE transaction (step 6, after cites-edge loop): for each unique `linkedDocRef`, check `node WHERE id=? AND type='doc' AND tombstoned=0`. If the row exists → `store.upsertEdge({ src:docId, dst:targetDocId, rel:'doc_link', kind:'doc_link', w:1.0, last_access:now })`. Dangling / tombstoned refs silently skipped (T-27-15 in-set guard).
- All writes remain inside the single IMMEDIATE transaction (atomic, single-writer invariant).

**tests/doc-link-edges.test.ts (9 tests, all pass):**
- (a) `generateDoc` returns `linkedDocRefs` from `recense://doc/<id>` refs in prose
- (b) `writeDoc` creates `doc_link` edges to existing doc nodes
- (c) Dangling ref (no live node) is skipped, FK-clean
- (d) `PRAGMA foreign_key_check` empty after doc_link edge creation
- (e) Duplicate `linkedDocRefs` deduped to one edge per unique target
- (f) Tombstoned target doc node is skipped
- (g) End-to-end: `generateDoc` + `writeDoc` produces exactly the expected doc_link edges
- Source assertions: `doc_link` in `doc-writer.ts`; `recense://doc/` + `linkedDocRefs` in `doc-generator.ts`

### Task 2: GET /graph?type=doc corpus endpoint (data layer — UNCHANGED, founder-verified correct)

**src/viz/server.ts** (commit `738aa66`, data layer kept verbatim):
- Two new prepared statements compiled once at startup:
  - `stmtDocNodes`: `SELECT n.id, n.type, n.value, n.s, n.c, n.origin, n.tombstoned, nd.slug FROM node n JOIN node_doc nd ON nd.node_id=n.id WHERE n.type='doc' AND n.tombstoned=0` — includes `slug` field for D-08 client-side resolution.
  - `stmtDocLinks`: `SELECT src, dst, rel, w, kind FROM edge WHERE kind='doc_link'`.
- `/graph` handler extended: if `?type=doc`, uses `stmtDocNodes`/`stmtDocLinks`; otherwise uses existing `stmtNodes`/`stmtEdges` (full graph unchanged). Maps `src/dst → source/target`.
- The founder independently verified the endpoint returns doc-only nodes + doc_link edges correctly. **This data layer stays.**

### Task 2b: Flat 2D Obsidian-style corpus RENDERING (founder-directed redesign, replaces the 3D-data-swap)

After founder verification, the corpus RENDERING direction changed: instead of swapping `/graph?type=doc` data into the existing 3D `ForceGraph3D` brain instance, the corpus is now a COMPLETELY SEPARATE flat 2D Obsidian-style graph (clean circles + labels + links, 2D pan/zoom). The data layer (Task 1 + the endpoint + D-08 click→url) is unchanged.

**Vendored renderer (`src/viz/vendor/force-graph.min.js`, committed `f5a46e0`):**
- `force-graph@1.43.5` — the 2D canvas sibling of the already-vendored `3d-force-graph.min.js` (same author, Vasco Asturiano; same API family). Pure 2D canvas, NO THREE dependency, exposes global `window.ForceGraph`. Vendored as a file → net-zero npm deps (same posture as the existing 3D bundle). 161737 bytes, SHA-256 `af9324ce…`.

**src/viz/modules/corpus.js (NEW):**
- `initCorpus(ctx)` owns the `#btn-corpus` toggle entirely (moved out of reader.js).
- Lazy-init: the 2D `ForceGraph()` instance is built only on the first Corpus open (`buildCorpusGraph()` fetches `/graph?type=doc`, builds `nodeSlugs` map, mounts on the `#corpus-graph` container).
- **Full-window toggle:** `showCorpus()` adds `.open` to `#corpus-graph` AND sets `#graph` (the 3D brain) `visibility:hidden` — the flat corpus REPLACES the brain. `showBrain()` reverses it (pure hide/show — the 3D brain instance is never rebuilt or re-tuned, no density regression).
- **Flat graph paint (`nodeCanvasObject`):** muted rose circle (`#9c7080`) + faint rose ring + slug/title label (`#c8bcd0`) below each node. AMBER (`#ffb866`) is used ONLY for the hovered node (activation-only palette rule). Links muted mauve (`rgba(130,105,140,0.35)`). Background `#170f1d` (matches the viz). Node radius is a flat Obsidian-legibility constant (NODE_R=5) — does NOT import the brain's nodeRadius/BRAIN_SCALE.
- Pan/zoom/drag are force-graph defaults; `zoomToFit` nudged after layout.
- **D-08:** `onNodeClick` → `openDocReader(node.id)` resolves the slug from `nodeSlugs` and navigates to `/?doc=<slug>&reader=1`.

**src/viz/modules/app.js:**
- Injects `./vendor/force-graph.min.js` as a dynamic `<script>` (same pattern as `3d-force-graph.min.js`), non-fatal on failure (corpus.js no-ops if `window.ForceGraph` absent).
- Calls `initCorpus(ctx)` after `initReader(ctx)`.

**src/viz/modules/reader.js:**
- REMOVED the 3D-data-swap corpus code (`swapToCorpus`/`swapToBrain`/`openDocReader`, the `#btn-corpus` capture). reader.js now owns only the prose reader + fact-ref→atom focus. A short comment points to corpus.js for the corpus graph.

**src/viz/index.html:**
- `#btn-corpus` button (unchanged from `738aa66`).
- NEW `#corpus-graph` full-window container div after `#graph`.

**src/viz/css/styles.css:**
- `#btn-corpus { display:none }` / `.mode-window #btn-corpus { display:inline-flex }` — expanded-only gate (D-07, unchanged).
- NEW `#corpus-graph { position:fixed; inset:0; z-index:5; display:none; background:#170f1d }` + `#corpus-graph.open { display:block }` — full-window host shown only when active.

**tests/viz-corpus-graph.test.ts (14 tests, all pass):**
- Endpoint tests (5): /graph?type=doc returns only doc nodes + only doc_link edges; /graph (no filter) returns everything; empty corpus → `{nodes:[],links:[]}`.
- Source assertions (9): type='doc' + kind='doc_link' in server.ts; corpus.js owns btn-corpus + `/graph?type=doc` + `window.ForceGraph` + `#corpus-graph` + D-08 url; corpus.js does NOT contain `ctx.Graph.graphData` (regression guard against the 3D-swap approach); reader.js no longer references `swapToCorpus`/`getElementById('btn-corpus')`; app.js injects force-graph + calls initCorpus; index.html has btn-corpus + corpus-graph; styles.css has the gate + corpus container; vendored force-graph.min.js exists, non-empty, exposes ForceGraph.

### Task 3: Human-verify checkpoint — flat-2D redesign rebuilt; ready for founder reload-confirm

Per coordinator direction, no NEW human-verify checkpoint is opened. The flat-2D corpus was rebuilt, `npm run build` is clean, and a viz server is running on **port 7819** against `/tmp/corpus-verify.db` (a WAL-safe fixture seeded with 2 doc nodes — tonos + synthetic vtx — joined by a doc_link edge). The founder reload-confirms the flat graph there:
- `/graph?type=doc` on 7819 returns 2 doc nodes (tonos, vtx) + 1 doc_link edge (verified).
- `./vendor/force-graph.min.js`, `./modules/corpus.js`, and the `#corpus-graph` container all serve correctly (verified).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] stmtDocNodes JOINs node_doc to expose slug**
- **Found during:** Task 2 implementation
- **Issue:** The plan says "clicking a doc node in the corpus graph opens its reader (D-08)". Without the slug in the corpus node data, the client has no way to resolve `node.id → slug` without a new server endpoint.
- **Fix:** Extended `stmtDocNodes` to `JOIN node_doc` and include `nd.slug`. No new endpoint needed.
- **Files modified:** `src/viz/server.ts`
- **Commit:** `738aa66`

### Founder-Directed Design Change

**2. [Founder direction] Corpus view = separate flat 2D graph, NOT a 3D-brain data-swap**
- **Found during:** Task 3 founder verification of `738aa66`
- **Direction:** The 3D-data-swap approach (swapping `/graph?type=doc` into the `ForceGraph3D` brain) was replaced by a COMPLETELY SEPARATE flat 2D Obsidian-style graph (clean circles + labels + links, 2D pan/zoom) on its own container. The data layer (Task 1 doc_link edges + `/graph?type=doc` endpoint + slug-in-node + D-08 click→url) was confirmed correct and kept verbatim.
- **Implementation:** Vendored `force-graph@1.43.5` (2D canvas, no THREE dep, net-zero npm deps, committed `f5a46e0` outside this session under the main session's authority); NEW `corpus.js` module owns a separate 2D `ForceGraph()` instance on `#corpus-graph`; full-window hide/show toggle (3D brain hidden, not rebuilt — no density regression); removed the 3D-swap code from reader.js.
- **Files modified:** `src/viz/modules/corpus.js` (new), `src/viz/modules/app.js`, `src/viz/modules/reader.js`, `src/viz/index.html`, `src/viz/css/styles.css`, `tests/viz-corpus-graph.test.ts`; vendored `src/viz/vendor/force-graph.min.js`.
- **Note:** This founder direction was relayed via the coordinator. The vendoring step (untrusted-code integration) was performed and committed (`f5a46e0`) outside this executor session by the main session under direct founder authority — this executor only wrote application code loading the already-committed, independently-verified file.

**3. [Founder fixes after flat-graph test] Corpus zoom clamp + reader-in-place (no brain detour) — commit `bb2c676`**
- **Found during:** Task 3 founder test of the flat corpus graph
- **Fix A (zoom over-zoom):** `zoomToFit` framed a tiny graph (2-node fixture) so each node filled the screen. Added `MAX_ZOOM = 2.5` clamp applied via `.zoom(k, 0)` after the fit settles, and moved the primary fit trigger to `onEngineStop` (settled layout) with a fallback timeout. A small corpus now reads as small circles with breathing room.
- **Fix B (brain detour on doc-node click):** the doc-node click used `window.location.href = /?doc=<slug>&reader=1`, which reloaded the page into BRAIN mode then opened the reader — the founder saw it "pan back to the brain" first. Now the reader opens IN PLACE over the corpus: `reader.js` exports `ctx.openReader(slug, {from})` (re-targets the slug + shows the `#reader` overlay with no navigation); `corpus.js` `onNodeClick` calls it with `from:'corpus'`. Closing the reader (×/Escape/toggle) when `from:'corpus'` returns to the corpus (`ctx.returnToCorpus`) — the brain is never shown. Brain graph-focus/dimming is skipped unless `from==='brain'`. The 27-03 hero path (`from:'brain'`, deep-link `?reader=1`) is unchanged. The inline fact-ref→atom click still explicitly drops to the brain (via `ctx.showBrainFromCorpus` + `from='brain'`) — that deliberate hero interaction is preserved.
- **Files modified:** `src/viz/modules/corpus.js`, `src/viz/modules/reader.js`, `tests/viz-corpus-graph.test.ts`.

**4. [Founder fixes round 2 + Rule 2 upstream gap] Instant fit + doc-ref clicks + sibling-doc emission — commit `f29bab3`**
- **Found during:** founder test of the flat corpus + a coordinator-flagged production hole
- **Fix A (zoom rubberband):** the previous `fitAndClamp` animated `zoomToFit(400,...)` TO the over-zoomed fit then snapped back via a `setTimeout(450)` — the founder saw nodes balloon then rubberband. Now `fitAndClamp` does `zoomToFit(0, 40)` + clamp `.zoom(MAX_ZOOM, 0)` ALL at 0ms, so the first paint is already framed (no overshoot, no rubberband). Applied in `onEngineStop` + fallback timeout.
- **Fix B (dead doc-ref clicks + brain detour):** in-prose `recense://doc/<id>` refs rendered as `.doc-ref[data-doc]` had NO click handler. Now `reader.js` `wireFactLinks` wires `.doc-ref` clicks → `ctx.openReader(null, {from: openFrom, docId})` (opens the referenced doc IN PLACE, preserving corpus/brain context). `reader.js` gained a `docQuery()` helper that routes `/doc`, `/doc/meta`, `/doc/staleness` fetches through `?id=` when the doc was opened by node id; `currentSlug` is now mutable and `currentDocId` tracks id-addressed opens. `server.ts` extends all three read routes to accept `?id=<docNodeId>` resolved exact-or-unique-prefix → slug (read-only, T-27-11); unknown/ambiguous → 404 (no generate-on-miss); `/doc/meta` now returns the resolved `slug`. Re-wiring runs after each in-place render (new doc's refs are live).
- **Rule 2 — upstream sibling-doc emission (the production hole):** the generator was fed ONLY the target slug's facts and a fact-citation-only prompt — it NEVER emitted `recense://doc/<id>` sibling refs, so `doc_link` edges never formed organically (the corpus graph would be permanently edgeless in production; Task 1's parsing + the doc-ref click were downstream of refs nothing produced). Fixed: `doc-gather.ts` `gatherSiblingDocs(db, slug)` returns `{id, slug, title(first H1)}` for every other live doc; `doc-generator.ts` `buildDocPrompt()` (factored out for testability) adds a RELATED DOCS block listing them (omitted when none). Generated doc-refs are resolved exact-or-unique-prefix against LIVE doc nodes and CANONICALIZED in the prose to full ids (unknown/ambiguous dropped, like invented fact-refs) — so prose, `doc_link` edges, and the reader's `?id=` click all agree on full ids even when the model truncates doc ids.
- **Files modified:** `src/reader/doc-generator.ts`, `src/reader/doc-gather.ts`, `src/viz/server.ts`, `src/viz/modules/corpus.js`, `src/viz/modules/reader.js`, `tests/doc-gather.test.ts`, `tests/doc-generator.test.ts`, `tests/doc-link-edges.test.ts`, `tests/reader-render.test.ts`, `tests/viz-doc-route.test.ts`.
- **Net effect — the chain is now real end-to-end:** generate doc B while doc A exists → B's prompt lists A → B's prose links to A → resolved+canonicalized → `doc_link` edge B→A → corpus graph shows the edge → clicking the edge's node (or the in-prose doc-ref) opens A. A full LIVE cross-link demo needs 2+ real generated docs (a live gen under the founder's authorization, separate); the mechanism is unit-proven here without live generation.

## Known Stubs

None. Data layer (Tasks 1+2) + flat-2D rendering (Task 2b) + founder fixes (instant fit, doc-ref clicks, sibling-doc emission) complete. The corpus graph now self-populates edges across docs. Task 3 is ready for founder reload-confirm on 7819 (no new checkpoint opened, per direction).

## Deferred / Out-of-Scope Note

`tests/recense-dispatch.test.ts` shows an intermittent failure under FULL-SUITE parallelism (a CLI-subprocess test sensitive to concurrent load) but PASSES in isolation. It does not reference any file changed in this plan (verified by grep) — a pre-existing test-runner flake, out of scope per the executor SCOPE BOUNDARY. Logged, not chased.

## Threat Flags

None beyond the plan's `<threat_model>`:
- **T-27-15** (dangling FK): in-set guard in `writeDoc` verifies target doc is live before creating the `doc_link` edge; test asserts `PRAGMA foreign_key_check` empty.
- **T-27-16** (XSS in corpus graph): doc node labels in the flat 2D graph are drawn via canvas `fillText(slug)` (canvas text, not DOM/innerHTML) — no HTML injection surface. After Fix B the slug is passed to `ctx.openReader(slug, {from:'corpus'})` (in-place reader open, no navigation) — still no DOM-injection sink.
- **T-27-17** (corpus button in tray): CSS gate `#btn-corpus { display:none }` / `.mode-window #btn-corpus { display:inline-flex }` — tray/popover NEVER sees the button. Test asserts the rule exists.
- **Vendored-dependency note:** `force-graph@1.43.5` is a vendored file (net-zero npm deps), the 2D sibling of the already-trusted `3d-force-graph.min.js` from the same author. Independently verified: 161737 bytes, valid UMD, exposes `ForceGraph`, no THREE dependency, only benign embedded URLs (author github + W3C namespaces).

## Self-Check: PASSED

- `src/reader/doc-generator.ts` — FOUND: `recense://doc/` parse + `linkedDocRefs` return
- `src/consolidation/doc-writer.ts` — FOUND: `doc_link` edge creation, `linkedDocRefs` in params
- `src/viz/server.ts` — FOUND: `stmtDocNodes`, `stmtDocLinks`, `?type=doc` handler (data layer unchanged)
- `src/viz/modules/corpus.js` — FOUND (NEW): flat 2D `ForceGraph()` instance, `#corpus-graph` container, `window.ForceGraph`, full-window hide/show toggle, `/graph?type=doc` fetch, D-08 click→url
- `src/viz/modules/reader.js` — FOUND: 3D-swap corpus code REMOVED (no `swapToCorpus`, no `btn-corpus` capture)
- `src/viz/modules/app.js` — FOUND: `./vendor/force-graph.min.js` injection + `initCorpus(ctx)`
- `src/viz/index.html` — FOUND: `#btn-corpus` button + `#corpus-graph` container
- `src/viz/css/styles.css` — FOUND: expanded-only `#btn-corpus` gate + `#corpus-graph` full-window host
- `src/viz/vendor/force-graph.min.js` — FOUND (vendored `f5a46e0`): 161737 bytes, UMD, exposes ForceGraph
- `tests/doc-link-edges.test.ts` — FOUND: 9 tests pass
- `tests/viz-corpus-graph.test.ts` — FOUND: 14 tests pass (5 endpoint + 9 source/wiring)
- `npx vitest run tests/doc-link-edges.test.ts tests/viz-corpus-graph.test.ts` — 23/23 pass
- `npx tsc --noEmit` — clean
- `npm run build` — clean (dist ships corpus.js + force-graph.min.js + corpus-graph container + initCorpus)
- Self-check on dist: corpus.js, vendor/force-graph.min.js, corpus-graph div, initCorpus all present in dist/
- Live self-check: viz server on 7819 against /tmp/corpus-verify.db serves /graph?type=doc (2 docs + 1 doc_link), force-graph.min.js, corpus.js, and the corpus-graph container correctly
- Commits: `971c69b` (Task 1), `738aa66` (Task 2 endpoint), `f5a46e0` (vendor force-graph), `11e4ba3` (flat-2D rendering), `bb2c676` (zoom clamp + reader-in-place), `f29bab3` (instant fit + doc-ref clicks + sibling-doc emission)
- After all fixes: 114 reader/doc/corpus tests pass (sibling-doc, ?id= exact/prefix/404, doc-ref wiring, RELATED-DOCS prompt-block tests added); tsc clean; dist rebuilt; server on 7819 verified — `/doc?id=892c1045` resolves the tonos doc by prefix, `/doc/meta?id=` returns its slug, unknown id → 404
- Full-suite note: 1 unrelated flake in `tests/recense-dispatch.test.ts` (passes in isolation; touches none of this plan's files) — pre-existing parallelism flake, out of scope
