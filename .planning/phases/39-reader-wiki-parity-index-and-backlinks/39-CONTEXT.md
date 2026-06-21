# Phase 39: Reader Wiki-Parity — Browsable Index + Surfaced Backlinks - Context

**Gathered:** 2026-06-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Close the two reader-layer ergonomics where recense trails Karpathy's LLM Wiki pattern (the `research-wiki` standard): a **browsable INDEX** (WIKI-01) and **surfaced backlinks / "what links here"** (WIKI-02). Both are presentation-layer parity over data that already exists — they reuse the live doc nodes (`stmtDocNodes`) and the reverse-edge lookup (`getInEdges` / `idx_edge_dst`). **No engine change** (WIKI-03): no new node/edge types, no write-path mutation, the read-only server posture (T-27-11) is preserved. The diff is reader/viz + server routes only.

**Explicitly out of scope:** Markdown export (LLM-Wiki gap #3) is deferred — recall + reader replace grep, and the queryable-DB-vs-portable-files trade is a deliberate divergence, not a deficiency. No new capabilities — this clarifies HOW to present two browsing affordances, not WHETHER to add features.

</domain>

<decisions>
## Implementation Decisions

### Index form (WIKI-01)
- **D-01:** The index is a **live `/index` server route**, NOT a generated doc node. It runs the already-compiled `stmtDocNodes` query at request time and renders the result. Rationale: always fresh, **zero LLM cost**, **zero write-path** (cleanest WIKI-03 fit), and strictly cheaper than what the viz already does. The generated-doc-node alternative was rejected because it would add a write-path mutation, an LLM regen cost, and a node that can go stale — all WIKI-03 tension.
- **D-02:** The index is a **read-only projection** — it is not a doc node, is not itself citable, and does not appear in the corpus graph. The existing flat 2D corpus graph remains the *visual* index; `/index` is the *textual* entry point. Self-confirmation guard untouched (read-only).

### Index layout (WIKI-01)
- **D-03:** Docs are **grouped by scope**, not a flat list. Two sections: **Projects** (human-scoped docs, e.g. `tonos`) and **Schemas** (the schema-anchored docs whose scope is a UUID). Rationale grounded in live data: of the 23 live doc nodes, only **1** (`tonos`) has a human-readable scope — the other **22 are schema-anchored with UUID scopes**. A flat list would read as 22 loose UUID-ish rows.
- **D-04:** Each schema-anchored doc is labeled via the existing **`COALESCE(NULLIF(sch.value,''), nd.slug)`** resolution (already in `stmtDocNodes`) so the UUID-scoped docs show their human schema label, not the raw UUID.

### Backlinks scope (WIKI-02)
- **D-05:** "Referenced by" = **doc→doc incoming links PLUS citing facts**. Two cases:
  - **Doc view:** other docs that link here — incoming `doc_link` / `doc_reference` (/ `doc_containment`) edges from other live doc nodes (41 such edges exist live). Reuses the corpus edge set.
  - **Atom/fact view:** which docs cite this fact — the **reverse `cites` edge** lookup (the same reverse walk the Phase 27 staleness path already does). Covers the "doc **or atom**" clause in success criterion #2.
- **D-06:** "All incoming edges" (`getInEdges`, any kind) was **rejected** — it mixes engine edges (`derived_from`, schema membership) into a browsing surface and reads as noise. Backlinks are filtered to the wiki-meaningful edge kinds above.

### Backlinks UI (WIKI-02)
- **D-07:** Backlinks render as a **"Referenced by" section appended at the end of the doc body** in the reader, styled like the existing **staleness banner** (muted rose/slate — see palette refs). No new layout region; reads top-to-bottom like a wiki. (Side-panel and atom-panel-only variants rejected — section-at-end is the minimal, wiki-faithful placement.)

### Index entry point (WIKI-01)
- **D-08:** The index is reached via an **`#btn-index` toolbar button**, sibling to the existing **`#btn-corpus`** button — same pattern, discoverable, consistent. (Route-only and "button + every-doc back-link" variants rejected; the toolbar button alone matches the corpus precedent.)

### Claude's Discretion
- Exact module placement (new `modules/index.js` vs folding into an existing module), the precise server response shape for `/index`, and CSS class naming are implementation details for the planner/executor — follow the corpus.js / staleness-banner precedents.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase definition
- `.planning/ROADMAP.md` §"Phase 39: Reader Wiki-Parity" (lines ~499–510) — goal, WIKI-01/02/03 requirements, success criteria, the "Markdown export deferred" boundary.

### The standard this phase measures against
- `~/.claude/skills/research-wiki/SKILL.md` — Karpathy's LLM Wiki pattern (the `research-wiki` standard). Load-bearing rules for this phase: **"Index last / Unindexed content doesn't compound"** (motivates WIKI-01) and cross-reference/backlink discipline (motivates WIKI-02). recense already meets-or-beats this standard on every *mechanism* dimension; these are the two *browsing affordances* it lacks.

### Reader/viz code to reuse (presentation-layer parity — data already exists)
- `src/viz/server.ts:153-160` — `stmtDocNodes` (the exact query the `/index` route reuses; returns live doc nodes + slug + COALESCE label).
- `src/viz/server.ts:164-169` — `stmtDocLinks` (doc→doc edge set for backlinks).
- `src/viz/server.ts:474-540` — `/doc?slug=` route pattern (read-only route precedent, T-27-11).
- `src/viz/server.ts:587+` — `/doc/staleness` route + reverse-`cites` walk (the precedent for the atom-backlinks reverse lookup, D-05).
- `src/db/semantic-store.ts:519` — `getInEdges(nodeId)` signature (reverse-edge lookup; `idx_edge_dst`-backed).
- `src/viz/modules/corpus.js` — `#btn-corpus` toolbar-button + lazy-init pattern (precedent for `#btn-index`, D-08).
- `src/viz/modules/reader.js` — reader render path; `fetchStaleness()` + `.staleness-banner` precedent for the "Referenced by" section (D-07).
- `src/viz/modules/detail.js` — atom/fact detail panel (where atom backlinks may surface).

### Locked prior decisions that bind this phase
- Corpus view is a **flat 2D Obsidian-style graph**, separate from the 3D brain — recense memory `corpus-graph-flat-obsidian` (locked 2026-06-18). The `/index` text route does NOT touch the brain or the corpus graph.
- Palette: **muted rose/slate/mauve at rest, amber/activation hover-only**. Phase 27 staleness re-toned `.fact-stale` to the rose `.doc-ref` family (commit `fcaa1e9`) — the "Referenced by" section follows the same muted palette, NOT amber.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`stmtDocNodes`** (`server.ts:153`): already returns every live doc node with slug + COALESCE'd human label + scope — the entire data layer for the `/index` route. Compiled once at server boot.
- **`stmtDocLinks`** (`server.ts:164`): live doc→doc edges (doc_link/doc_reference/doc_containment), already dangling-edge-guarded — the data layer for doc-view backlinks.
- **`getInEdges(nodeId)`** (`semantic-store.ts:519`): reverse-edge lookup backed by `idx_edge_dst` — the primitive for "what links here."
- **Staleness banner** (`reader.js` `fetchStaleness` + `.staleness-banner` CSS): the visual + fetch precedent the "Referenced by" section copies.
- **`#btn-corpus`** (`corpus.js`): toolbar-button + lazy-init pattern to clone for `#btn-index`.

### Established Patterns
- **Read-only server (T-27-11):** all `/doc*` routes are GET, read-only, no write-path. `/index` and any backlinks route MUST preserve this — it's the WIKI-03 guarantee.
- **Prepared-statement-once:** routes compile their SQL once at server construction (`stmtDocNodes`, `stmtDocLinks`, `stmtGetDoc`). New routes follow suit.
- **Muted palette discipline:** new reader chrome uses the rose/slate/mauve family; amber is activation-only (founder-locked).

### Integration Points
- New `/index` GET route in `server.ts` (sibling to `/doc`, `/graph`).
- New backlinks data: either extend `/doc/meta` or add a `/doc/backlinks?slug=` route (read-only) — planner's call.
- New `#btn-index` in the viz toolbar (`index.html` + a module).
- "Referenced by" render hook in `reader.js` after the doc body renders.

### Scale (live brain, measured 2026-06-21 from ~/.config/recense/recense.db)
- **23 live doc nodes** / 8,806 total nodes. 41 doc→doc edges (30 doc_link, 8 doc_containment, 3 doc_reference). The `/index` query is sub-millisecond over 23 rows — ~400× smaller than the all-nodes payload `/graph` already ships every page load. Cost is noise-floor; zero LLM.

</code_context>

<specifics>
## Specific Ideas

- The founder warmed to the **live index** specifically after confirming it's the *cheaper* and *cleaner* option (not a compromise): zero LLM, zero write-path, strictly less work than the existing `/graph` load.
- "Referenced by" should read like a wiki backlink list (Obsidian "what links here"), at the **bottom** of the doc — not a heavyweight panel.

</specifics>

<deferred>
## Deferred Ideas

- **Markdown export of docs** (LLM-Wiki gap #3) — explicitly deferred at the roadmap level; recall + reader replace grep, queryable-DB-vs-portable-files is a deliberate divergence. Not this phase, not currently roadmapped.
- **Index as a real doc node** (in the corpus graph, citable, regenerable) — rejected for v7.0 on WIKI-03 grounds. If a future need arises for the index to be itself a first-class corpus citizen, that's a separate phase with its own write-path justification.

</deferred>

---

*Phase: 39-reader-wiki-parity-index-and-backlinks*
*Context gathered: 2026-06-21*
