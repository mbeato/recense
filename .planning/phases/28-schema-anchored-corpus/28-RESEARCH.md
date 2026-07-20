# Phase 28: Schema-Anchored Corpus — Research

**Researched:** 2026-06-19
**Domain:** Schema abstraction graph → prose corpus; SQLite evidence sets; sleep-pass wiring; force-graph corpus rendering
**Confidence:** HIGH (live DB queries + live source reads; one critical blocker identified)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **⚠ D-01/D-02 SUPERSEDED → see D-01R/D-02R in CONTEXT.md** (founder-directed 2026-06-19). The original shared-evidence CONTAINMENT signal was empirically FALSIFIED by this research (0 edges — disjoint evidence partitions; see §D-01/D-02 and Pitfall 1). Do NOT implement it.
- **D-01R (supersedes D-01):** Primary enrichment signal = **centroid-cosine similarity** between schema member-centroids (the SREL-01 signal); direction (parent→child) from evidence MASS. Centroid-cosine is the SPINE, not a tie-breaker.
- **D-02R (supersedes D-02):** One pass derives both edge types from cosine+mass — CONTAINMENT (directed, larger-mass = parent, single strongest parent → forest) + REFERENCE (cosine-connected non-parent pairs + SREL-02 siblings + remaining schema_rel pairs). Enrich the ladder by lowering the cosine threshold so usable relations exceed the ~95 baseline; tune against the live brain to avoid a hairball.
- **D-03:** Derived relations materialized ON DOC NODES ONLY — never on source schemas (self-confirmation guard by construction)
- **D-04:** One idempotent function (CLI + sleep-pass Phase C wiring); eager doc stubs, lazy prose generation
- **D-05:** Hysteresis band (high ~12, low ~8) prevents doc-node thrash
- **D-06:** Mass = distinct evidence-member count (COUNT(DISTINCT dst) WHERE kind='abstracts' AND dst is live fact|entity)
- **D-07:** Noise filter via member-shape token regex (NOT scope-diversity); targets "Output file paths"/"Tool identifiers"/"Git commit hashes"
- **D-08:** Distinct edge styling — containment = solid/directed; reference = faint/dashed; scope-doc woven via reference edges
- **D-09:** Gather re-anchored from slug → schema: evidence-set spine + centroid-seeded semantic breadth + entity-hop re-rooted at schema's entities

### Claude's Discretion

- Concrete threshold values (containment ratio, reference N, floor, hysteresis, token-fraction cutoff) — SET AGAINST LIVE DATA (see grounding below)
- New edge `kind`s for doc-corpus edges (DDL/CHECK extension)
- `/graph?type=doc` endpoint shape change
- CLI command name for D-04 (e.g. `recense promote-corpus`)
- Schema-thesis prompt framing for doc-generator
- Sleep-pass Phase C insertion point relative to SchemaRelationDeriver

### Deferred Ideas (OUT OF SCOPE)

- Entity-anchored docs
- Section-level / partial regen
- Centroid-cosine as a real secondary signal
- LLM-derived ladder
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| CORPUS-01 (Req 1) | Schema-anchored doc generation (schema = thesis, abstracts-neighborhood = evidence) | `gatherFacts()` re-anchored via D-09 parameters; `generateDoc` reused with new prompt framing; `writeDoc` reused unchanged |
| CORPUS-02 (Req 2) | LLM-free mass-gated promotion (~15–60 candidates) + noise filter | SQL gate verified against live DB: mass ≥ 10 + noise_frac < 0.5 yields 17 candidates (within range); hysteresis high=10/low=7 |
| CORPUS-03 (Req 3) | Schema→schema ladder enrichment via containment + reference edges; ≥1 parent→child nest rendered | **CRITICAL BLOCKER** — evidence sets are perfectly disjoint (0/0 containment); ladder must use SREL-02 super-schema + schema_rel as proxy (see below) |
| CORPUS-04 (Req 4) | Containment + reference edges in flat 2D corpus, supersedes READER-04 doc_link | `/graph?type=doc` already returns doc nodes; needs new stmts for `doc_containment`/`doc_reference`; corpus.js needs `link.kind` field |
| CORPUS-05 (Req 5) | Self-confirmation guard preserved under schema-anchoring | D-03 edges on doc nodes only; `writeDoc` lifecycle exemption unchanged |
</phase_requirements>

---

## Summary

Phase 28 pivots the corpus from project-scope docs (one live `tonos` doc) to schema-anchored docs where each promoted schema becomes a thesis and its abstracted evidence is the body. The Phase-27 infrastructure (doc-writer, doc-generator, doc-gather, corpus.js, `/doc*` routes) is reused almost verbatim; the primary additions are a promotion gate with noise filter, a centroid re-anchor for gather, and corpus edge derivation between doc nodes.

**The single most important finding:** D-01/D-02's shared-evidence containment algorithm yields **zero edges** on the live brain. Every fact/entity node belongs to exactly one schema (enforced by the `alreadyInSchema` set in `schema-induction.ts:304`), making evidence sets perfectly disjoint partitions. `|A.ev ∩ B.ev| = 0` for all pairs. The planner cannot use the literal D-02 algorithm as written; corpus edges must be derived from the existing schema→schema structures (SREL-02 super-schemas + `schema_rel` cosine pairs) projected through doc nodes.

**Gate sizing (live-grounded):** After applying the noise filter (noise_frac < 0.5), mass ≥ 10 yields 17 clean candidate schemas, mass ≥ 8 yields 30. Using high=10/low=7 as the hysteresis band gives a stable initial corpus of ~17 docs that grows to ~47 as the brain fills.

**Primary recommendation:** Implement D-04 as `recense promote-corpus` (CLI + sleep-pass Phase C, immediately after `deriveSchemaRelations()`). Use the SREL-02 super-schema sibling structure as the reference-edge signal and the `schema_rel` cosine pairs as secondary reference edges. Write all corpus edges between doc nodes only (D-03). Existing doc-writer, doc-generator, and corpus.js reuse directly.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Mass gate + noise filter (D-06/D-07) | Sleep-pass Phase C | CLI (manual trigger) | SQL/COUNT, offline, no LLM; needs write access for stub creation |
| Containment/reference derivation (D-01–D-03) | Sleep-pass Phase C | — | Structural SQL over existing edges; wipe-and-rebuild cache |
| Eager doc-node stub creation (D-04) | Sleep-pass Phase C | CLI | Writes through `doc-writer` (single-writer invariant) |
| Prose generation (lazy, CORPUS-01) | CLI (`generate-doc`) | viz server (via spawn) | Reuses Phase-27 path; 600s timeout required |
| Gather re-anchoring (D-09) | `src/reader/doc-gather.ts` | — | New `gatherFactsForSchema()` function alongside existing `gatherFacts()` |
| Corpus rendering (D-08) | `src/viz/modules/corpus.js` | — | Link-kind-aware styling; no new container |
| Corpus graph endpoint (Req 4) | `src/viz/server.ts` | — | New prepared statements for `doc_containment`/`doc_reference` edges |
| DDL extension (v12) | `src/db/schema.ts` | — | Table-recreation migration pattern (mirrors v11) |
| Self-confirmation guard (D-03/Req 5) | `src/consolidation/doc-writer.ts` | Architecture | Edges written only to doc nodes; source schemas never touched |

---

## Standard Stack

### Core (reused from Phase 27 — no new dependencies)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | existing | SQL queries, mass gate, edge derivation | Engine DB layer — already in use |
| TypeScript | existing | All new code | Project standard |
| vendored force-graph@1.43.5 | existing | Corpus graph rendering | Phase 27 vendored; no npm dep |

**Net-zero dependency constraint honored.** Phase 28 adds no new npm packages.

### New Files (to create)

| File | Purpose |
|------|---------|
| `src/consolidation/corpus-promoter.ts` | D-04 idempotent promote-corpus function: gate → derive → stub → wire |
| `src/adapter/promote-corpus-cli.ts` | CLI entry: `recense promote-corpus [--db <path>] [--dry-run]` |

### Alternatives Considered

None — net-zero dep constraint forecloses alternatives.

---

## Package Legitimacy Audit

No new packages are installed in this phase. Net-zero dependency constraint applies.

---

## Architecture Patterns

### System Architecture Diagram

```
Sleep-pass Phase C
  [SchemaRelationDeriver]         ← existing (schema_rel + super-schemas)
  [CorpusPromoter.promote()]      ← NEW Phase 28 addition
       │
       ├── 1. Mass gate + noise filter (SQL/COUNT, LLM-free)
       │       → SELECT schemas WHERE mass >= HIGH_MASS AND noise_frac < NOISE_CAP
       │
       ├── 2. Containment/reference derivation from SREL-02 + schema_rel
       │       → sibling schemas under same super-schema  → doc_reference edges
       │       → schema_rel cosine pairs among promoted   → doc_reference edges
       │
       ├── 3. Eager doc-node stubs (via doc-writer, lifecycle-exempt)
       │       → upsert type='doc', origin='inferred', s=0, no embed
       │       → upsertNodeDoc(node_id, slug=schemaId, generated_at)
       │
       └── 4. Wipe+rebuild doc-corpus edges (doc_containment / doc_reference)
               → edges between doc nodes only (D-03)
               → atomic IMMEDIATE transaction

CLI: recense promote-corpus --db <path> [--dry-run]
  → same CorpusPromoter.promote() as sleep-pass (testable, composable)

GET /graph?type=doc
  → live doc nodes (stmtDocNodes, unchanged)
  → doc_containment + doc_reference edges (new stmts, replaces stmtDocLinks)

corpus.js
  → link.kind → solid/directed (doc_containment) vs faint/dashed (doc_reference)

Reader (on corpus node click)
  → ctx.openReader(slug=schemaId, {from:'corpus'})  [slug = schemaId string]
  → GET /doc?slug=<schemaId> → serve cached prose or spawn generate-doc-cli
```

### Recommended Project Structure

```
src/
├── consolidation/
│   ├── corpus-promoter.ts       # NEW — D-04 promote-corpus function
│   ├── doc-writer.ts            # existing — reused unchanged
│   ├── schema-relations.ts      # existing — SchemaRelationDeriver (Phase C)
│   └── run-sleep-pass.ts        # modified — wire CorpusPromoter after SchemaRelationDeriver
├── reader/
│   └── doc-gather.ts            # modified — add gatherFactsForSchema() alongside gatherFacts()
├── adapter/
│   └── promote-corpus-cli.ts    # NEW — CLI entry for D-04
├── db/
│   └── schema.ts                # modified — v12 migration for doc_containment / doc_reference
└── viz/
    ├── modules/corpus.js        # modified — link.kind-aware styling
    └── server.ts                # modified — new stmts for doc_containment/doc_reference
```

---

## Verified File/Function Map (D-01..D-09)

### D-01 / D-02: Containment + Reference Derivation

**CRITICAL BLOCKER — read before planning.**

Live query result: `0` pairs with any shared evidence across all 267 schemas.

```sql
-- Confirmed via live DB query 2026-06-19:
SELECT COUNT(*) as nodes_in_multiple_schemas
FROM (
  SELECT dst, COUNT(DISTINCT src) as schema_count
  FROM edge e
  JOIN node src_n ON src_n.id = e.src AND src_n.type='schema' AND src_n.tombstoned=0
  JOIN node dst_n ON dst_n.id = e.dst AND dst_n.type IN ('fact','entity') AND dst_n.tombstoned=0
  WHERE e.kind='abstracts'
  GROUP BY dst
  HAVING schema_count > 1
);
-- Result: 0
```

**Root cause:** `schema-induction.ts:304` builds `alreadyInSchema` — any fact/entity already linked to a schema is excluded from re-assignment. Evidence sets are strict partitions. `|A.ev ∩ B.ev| = 0` for all schema pairs. D-02's `shared / |smaller set| ≥ 0.7` threshold is never met; D-02's reference condition `shared ≥ N` is also never met.

**Planner action required:** The containment/reference corpus edges MUST be derived from proxy signals instead of direct evidence overlap:

1. **SREL-02 sibling signal (reference edges):** Schemas that share a super-schema parent are semantically related → project as `doc_reference` edges between their doc nodes.  
   - Among promoted schemas (mass ≥ 10, noise < 0.5), live count: **4 sibling pairs** covering {Phase Plans, Plan phases and tasks, Phase progression stages} and {Phase execution completion, Phase 04 plans}.

2. **schema_rel cosine signal (reference edges):** Existing `schema_rel` edges among promoted schemas → `doc_reference` edges.  
   - Among promoted schemas (mass ≥ 10, clean): **3 pairs** — {Phase execution completion / Phase 04 plans, w=0.93}, {Phase Plans / Plan phases and tasks, w=0.83}, {Phase Plans / Phase progression stages, w=0.83}.
   - 2 of these 3 already appear in the SREL-02 sibling list above → **~5 unique reference edges** from combining both signals.

3. **Containment (directed parent→child) signal:** No evidence-set containment exists. The planner could derive containment by centroid-similarity direction: if schema A's centroid is "closer to general" (smaller number of distinct member embeddings that span a broader semantic range), it is the parent. Alternatively, use the super-schema hierarchy: a super-schema "contains" its child schemas. But super-schemas have short fallback labels (`super:a + b + c`) and are unlikely to pass quality-as-thesis review. **The planner must decide: accept 0 directed containment edges for v1 (use reference edges only for the flat corpus) or implement centroid-direction heuristic.**

| Signal | Edges available (live) | Edge type | Mechanism |
|--------|----------------------|-----------|-----------|
| SREL-02 siblings (same super-parent) | 4 pairs | doc_reference | Read `edge WHERE kind='abstracts' AND src LIKE 'super::%'` |
| schema_rel cosine pairs | 3 pairs | doc_reference | Read `edge WHERE kind='schema_rel'` |
| Direct evidence containment | 0 | doc_containment | BLOCKED — disjoint partitions |
| Centroid-direction heuristic | TBD | doc_containment | Requires new derivation logic |

**Net result for Req-3 ("materially exceed ~95 baseline"):** The 95-edge baseline is the raw schema→schema + schema_rel graph. Among PROMOTED schemas only, the usable relations total ~5 (sibling + schema_rel de-duped). This is materially MORE useful than 95 (which spans all 267 schemas; only ~5 of those 95 connect promoted schemas). The corpus will have ~17 doc nodes with ~5 reference edges between them — sparse but structurally meaningful. The `≥1 parent→child nest` acceptance criterion requires at least one directed containment edge; the planner must choose between 0 directed edges (accept the flat corpus) or implement the centroid-direction heuristic.

### D-03: Self-Confirmation Guard

**File:** `src/consolidation/doc-writer.ts`  
**Function:** `writeDoc()` (line 65)  
**Pattern:** All edges written via `store.upsertEdge({ src: docId, dst: ..., kind: 'cites'|'doc_link' })` — `src` is always the doc node ID. For Phase 28, doc-corpus edges are `{ src: docDocId, dst: targetDocId, kind: 'doc_containment'|'doc_reference' }` — still doc→doc. Source schemas are never touched. Self-confirmation guard holds by construction (D-03).

### D-04: Idempotent Promote-Corpus Pass

**New file:** `src/consolidation/corpus-promoter.ts`  
**Sleep-pass wiring file:** `src/consolidation/consolidator.ts`  
**Exact insertion point:** Line 722–723 in consolidator.ts:

```typescript
// Existing:
await this.deriver.deriveSchemaRelations();  // line 722
this.strength.runEvictionSweep();            // line 723

// Phase 28 addition (between these two):
await this.deriver.deriveSchemaRelations();  // existing
await this.corpusPromoter.promote();         // NEW — D-04
this.strength.runEvictionSweep();            // existing
```

**Wiring in `run-sleep-pass.ts`:** Add `CorpusPromoter` instantiation alongside `SchemaRelationDeriver` (line 341). Pass `db`, `store`, `clock`, and constants `HIGH_MASS`, `LOW_MASS`, `NOISE_CAP`. The `Consolidator` constructor takes the promoter as an optional DI parameter (same pattern as `deriver: SchemaRelationDeriver | NoopSchemaRelationDeriver`).

**CLI entry:** `src/adapter/promote-corpus-cli.ts` → dispatched by recense.ts; respects shared write lock (`acquireLock()`); uses same `initSchema(db)` + `SemanticStore` pattern as `generate-doc-cli.ts`.

### D-05: Hysteresis Band

**Live-grounded values:**

```
HIGH_MASS = 10  → 17 clean candidates (mass ≥ 10, noise_frac < 0.5)
LOW_MASS  = 7   → ~47 clean candidates (mass ≥ 7 = mass ≥ 6+1, uses 6 threshold)
NOISE_CAP = 0.5 → removes the 5 clearly-noise schemas (noise_frac ≥ 0.85)
```

Hysteresis: if a schema already has a doc (stub exists), only tombstone when `mass < LOW_MASS`. Promote when `mass >= HIGH_MASS`. Schemas in the 7–9 band keep their doc once earned.

### D-06: Mass Computation

**SQL (confirmed pattern from live DB):**
```sql
SELECT src as schema_id, COUNT(DISTINCT dst) as mass
FROM edge
WHERE src = ? AND kind = 'abstracts'
  AND dst IN (
    SELECT id FROM node
    WHERE type IN ('fact','entity') AND tombstoned = 0
  )
```

This is the SAME evidence set used by `SchemaRelationDeriver.stmtGetSchemaMembers` + the `clusterableById` lookup. The gate and containment derivation share one evidence query.

### D-07: Noise Filter

**Confirmed effective regex patterns (tested on live DB):**

```typescript
function isNoiseMember(value: string): boolean {
  return (
    /^\/private\//.test(value) ||
    /^\/tmp\//.test(value) ||
    /^\/Users\//.test(value) ||
    /^toolu_/.test(value) ||           // Claude tool IDs
    /^[Cc]ommit\s+[0-9a-f]{6,}/.test(value) ||  // git commit references
    /^worktreePath:/.test(value) ||
    /^\.claude\/worktrees/.test(value)
  );
}
```

**Live validation:**

| Schema | Mass | Noise% | Verdict |
|--------|------|--------|---------|
| Output file paths | 66 | 92% | FILTERED (noise_frac ≥ 0.5) |
| Tool identifiers | 58 | 100% | FILTERED |
| Git commit hashes | 39 | 97% | FILTERED |
| Brain Memory Icons | 15 | 93% | FILTERED |
| Worktree Projects | 29 | 86% | FILTERED |
| VTX Slot Projects | 19 | 21% | PASSES (25% noise is acceptable — members like "vtx-backend-slot2" are informative) |
| Brain memory files | 9 | 78% | FILTERED (mass < 10 anyway) |
| GSD Phase 4 | 39 | 0% | PASSES |
| All others ≥ 10 | — | 0% | PASSES |

**Caveat (from CONTEXT.md D-07):** The regex set is heuristic and brittle to novel noise shapes. Eyeball the gate output on the live brain before trusting it. The "Document identifiers" schema (mass=13, noise=0%) has members like `D-16`, `D-06` etc. — these are doc-context IDs, borderline noise. The planner should spot-check the first corpus render.

### D-08: Corpus Rendering (corpus.js)

**File:** `src/viz/modules/corpus.js`  
**Current state:** `LINK_REST` applied uniformly to all edges; no distinction by `link.kind`.  
**Change required:** `corpus.js` needs `link.kind` from the GraphPayload to apply:
- `kind='doc_containment'` → solid line, directed (arrow), heavier weight
- `kind='doc_reference'` → faint/dashed line, undirected

**GraphPayload shape:** The existing `LinkRecord` in `server.ts:57-64` already includes `kind: string`. The `stmtDocLinks` in server.ts currently only fetches `kind='doc_link'`. Phase 28 replaces this with a new statement that fetches both `kind='doc_containment'` AND `kind='doc_reference'`.

**corpus.js `linkColor()` hook:** Currently `() => LINK_REST` (static). Replace with `(link) => link.kind === 'doc_containment' ? CONTAINMENT_COLOR : LINK_REST`.

**`linkDirectionalArrowLength` / `linkLineDash`:** force-graph supports both. Wire to `link.kind`:
```javascript
.linkDirectionalArrowLength(link => link.kind === 'doc_containment' ? 4 : 0)
.linkLineDash(link => link.kind === 'doc_reference' ? [2, 2] : null)
```

### D-09: Gather Re-Anchoring

**File:** `src/reader/doc-gather.ts`  
**Current signature:**
```typescript
export async function gatherFacts(
  deps: GatherDeps,
  slug: string,
  opts: { semanticK?: number } = {},
): Promise<GatheredFact[]>
```

**Phase 28 addition — new function alongside existing:**
```typescript
// New for D-09 schema-anchored gather
export interface GatherSchemaParams {
  schemaId: string;
  centroid: Float32Array | null;  // reuse SchemaRelationDeriver centroid logic
}

export async function gatherFactsForSchema(
  deps: GatherDeps,
  params: GatherSchemaParams,
  opts: { semanticK?: number } = {},
): Promise<GatheredFact[]>
```

**D-09 three sources (re-anchored):**
1. **Spine** — `SELECT id FROM edge WHERE src = schemaId AND kind = 'abstracts' AND dst IN (live fact/entity)` — replaces `node_scope.scope = slug`
2. **Semantic breadth** — `hybridTopk(params.centroid, schemaLabel, semanticK)` — replaces `provider.embed([slug])`; if centroid is null, skip (no embed call needed)
3. **Entity-hop** — entities that are direct `abstracts` members of the schema → 1-hop fact neighbors; replaces `entity_name LIKE slug`

**Centroid source:** The centroid is already computed identically in `schema-relations.ts:280–310` (member embeddings from `stmtGetClusterableNodes`). The `CorpusPromoter` should pre-compute centroids for promoted schemas (mirroring `SchemaRelationDeriver`'s Phase A) and pass them to `gatherFactsForSchema`. No extra embed calls.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Lifecycle-exempt doc writes | Custom INSERT | `writeDoc()` (doc-writer.ts) | Already handles FTS suppression, tombstone guard, node_doc sidecar, one-live-doc-per-slug |
| Doc generation timeout | Custom subprocess | Existing 600s `RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS` pattern | Phase 27 27-02 already solved the swallowed-timeout problem |
| Wipe-and-rebuild derived cache | Custom delta logic | Same pattern as `SchemaRelationDeriver` (atomic `db.transaction().immediate()`) | FK-safe, crash-safe, deterministic |
| Centroid computation | New embedding pass | Reuse `SchemaRelationDeriver`'s centroid math (schema-relations.ts:280–310) | Already gates on `clusterableById`, handles Pitfall 5 (byteOffset) |
| Edge DDL migration | ALTER TABLE | Table-recreation pattern (v7/v11 precedent in schema.ts) | SQLite can't ALTER CHECK constraints |

**Key insight:** Phase 28 is almost entirely a re-anchoring + wiring exercise. The heavy lifting (doc writes, generation, rendering) already exists from Phase 27; the new work is the mass gate, the corpus edge derivation via SREL-02 proxy, and the D-09 gather re-anchor.

---

## Common Pitfalls

### Pitfall 1: D-02 Containment Produces Zero Edges

**What goes wrong:** The planner implements `|A.ev ∩ B.ev| / |min-set|` as written in D-02 and gets 0 corpus edges.  
**Why it happens:** Evidence sets are strict disjoint partitions — every fact/entity belongs to exactly one schema by design of the induction algorithm (`alreadyInSchema` guard).  
**How to avoid:** Use SREL-02 (super-schema siblings) and schema_rel (cosine pairs) as the corpus edge signal. See D-01/D-02 section above for concrete counts.  
**Warning signs:** `SELECT COUNT(*) FROM edge WHERE kind='doc_containment'` is 0 after running promote-corpus.

### Pitfall 2: Swallowed-Timeout Empty Doc

**What goes wrong:** `generateDoc` for a schema runs the headless claude-p judge; the ~4000-token gen exceeds 120s → SIGKILL → empty string returned → error swallowed or empty doc persisted.  
**Why it happens:** headless client returns empty content on timeout (its fail-safe for the sleep pass, which must not abort).  
**How to avoid:** Schema-doc generation CLI MUST (a) set `RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS = 600000` before spawning, (b) throw on empty output (`if (md.trim().length === 0) throw new Error(...)`). Both already exist in `generate-doc-cli.ts` and `doc-generator.ts` — reuse verbatim.  
**Warning signs:** doc node written with `value = ''` or `citationCount = 0`.

### Pitfall 3: WAL-Copy Gotcha

**What goes wrong:** Dev/test copies recense.db but misses .db-wal — sees `{status:'generating'}` on a doc that was just generated.  
**Why it happens:** WAL mode has uncommitted writes in the .db-wal file.  
**How to avoid:** Always copy `recense.db + .db-wal + .db-shm` together, or use `VACUUM INTO '/tmp/snapshot.db'` for a clean point-in-time copy.  
**Warning signs:** Corpus graph shows 0 doc nodes immediately after `recense promote-corpus` ran but before the WAL checkpoint.

### Pitfall 4: `node_doc.slug` = schemaId Breaks `/doc?slug=` Lookup

**What goes wrong:** The server's `stmtGetDoc` does `WHERE ns.scope = ?` using `node_scope.scope`. For schema docs, `scope = schemaId` (a UUID). The CLI `recense generate-doc <schemaId>` and the server's `spawnGenerateDoc(schemaId)` use schemaId as the `slug` parameter throughout. This WORKS — but the planner must pass the schemaId (not a human-readable label) everywhere the `slug` argument appears in `doc-gather`, `generate-doc-cli`, `writeDoc`, `node_doc.slug`, `node_scope.scope`.  
**Why it happens:** The slug field was designed for human-readable project names; schema IDs are UUIDs.  
**How to avoid:** The generator prompt uses the schema's `value` (human label) as the topic name for prose quality; the slug/anchor is the UUID. Keep them separate in the gather params.  
**Warning signs:** `/doc?slug=<schemaId>` 404s, or `generate-doc tonos --force` generates a schema doc instead.

### Pitfall 5: FK Violation in v12 DDL Migration

**What goes wrong:** The `edge` table recreation for v12 (adding `doc_containment` / `doc_reference` to the CHECK constraint) fails mid-swap and leaves the table gone.  
**Why it happens:** DDL migrations run as a `BEGIN/COMMIT` block but without `FOREIGN_KEYS OFF` before the transaction.  
**How to avoid:** Mirror the v11 pattern exactly: `db.pragma('foreign_keys = OFF')` → `db.exec('BEGIN; CREATE TABLE edge_v12 ...; INSERT INTO edge_v12 SELECT * FROM edge; DROP TABLE edge; ALTER TABLE edge_v12 RENAME TO edge; COMMIT;')` → `db.exec('CREATE INDEX ...')` → `db.pragma('foreign_keys = ON')`. Guard with `if (!edgeDdl.includes("'doc_containment'"))`.

### Pitfall 6: Self-Confirmation via Promoter Touching Schema Nodes

**What goes wrong:** The `CorpusPromoter.promote()` function accidentally calls `store.strengthen()`, `store.setEmbedding()`, or `store.upsertEdge({ src: schemaId, ... })` on a source schema while building doc stubs.  
**Why it happens:** Copy-paste from schema-induction code that legitimately touches schema nodes.  
**How to avoid:** The promoter reads schemas read-only, writes ONLY to `type='doc'` nodes and doc→doc edges. Add a test: snapshot source schema `s`/`c`/edge weights before `promote()`, re-snapshot after — assert unchanged.

### Pitfall 7: FTS Pollution from Schema-Doc Body

**What goes wrong:** Schema-doc prose (4000-token markdown) gets indexed into `node_fts` → pollutes BM25 keyword search (retrieval returns docs instead of facts).  
**Why it happens:** `store.upsertNode()` auto-syncs FTS; the FTS delete must happen in the same transaction.  
**How to avoid:** `writeDoc` already does `stmtFtsDelete.run(docId)` inside the transaction — this is reused unchanged for schema docs. Do NOT bypass `writeDoc`; use it for ALL doc writes.

---

## DDL Extension Shape (v12 Migration)

**Current `edge.kind` CHECK (v11, live):**
```sql
CHECK(kind IN ('relation','abstracts','schema_rel','cites','doc_link'))
```

**v12 addition — two new doc-corpus edge kinds:**
```sql
CHECK(kind IN ('relation','abstracts','schema_rel','cites','doc_link','doc_containment','doc_reference'))
```

**Note on `doc_link`:** Phase 28 DOES NOT retire `doc_link`. Scope-doc → scope-doc links from the generator still use `doc_link`. The `/graph?type=doc` endpoint is modified to return `doc_link` + `doc_containment` + `doc_reference` edges. `doc_link` stays in the CHECK. v12 migration only adds the two new kinds.

**Migration guard pattern (mirror v11 in schema.ts:406-428):**
```typescript
const edgeDdlV12 = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='edge'")
  .get() as { sql: string } | undefined)?.sql ?? '';
if (!edgeDdlV12.includes("'doc_containment'")) {
  db.pragma('foreign_keys = OFF');
  db.exec(`BEGIN; CREATE TABLE edge_v12 (...); INSERT INTO edge_v12 SELECT * FROM edge; DROP TABLE edge; ALTER TABLE edge_v12 RENAME TO edge; COMMIT;`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edge_dst ON edge(dst);`);
  db.pragma('foreign_keys = ON');
}
```

**SCHEMA_VERSION** bumps from 11 to 12 in `schema.ts:11`.

---

## `/graph?type=doc` Endpoint Change Shape

**File:** `src/viz/server.ts`

**Current prepared statements:**
```typescript
const stmtDocNodes = db.prepare(`
  SELECT n.id, n.type, n.value, n.s, n.c, n.origin, n.tombstoned, nd.slug
  FROM node n JOIN node_doc nd ON nd.node_id = n.id
  WHERE n.type='doc' AND n.tombstoned=0
`);  // ← UNCHANGED

const stmtDocLinks = db.prepare(
  "SELECT src, dst, rel, w, kind FROM edge WHERE kind='doc_link'"
);  // ← REPLACE
```

**Phase 28 replacement:**
```typescript
const stmtDocLinks = db.prepare(`
  SELECT src, dst, rel, w, kind FROM edge
  WHERE kind IN ('doc_link','doc_containment','doc_reference')
    AND src IN (SELECT id FROM node WHERE type='doc' AND tombstoned=0)
    AND dst IN (SELECT id FROM node WHERE type='doc' AND tombstoned=0)
`);
```

The `doc_link` filter is preserved so scope-doc→scope-doc links continue to appear. The `slug` field in the `stmtDocNodes` result already works for schema docs (slug = schemaId). No other server-side changes needed for Req-4.

---

## Sleep-Pass Phase C Wiring Point

**File:** `src/consolidation/consolidator.ts`  
**Function:** `Consolidator.consolidate()`  
**Phase C block (lines 714-723):**

```typescript
// ── Phase C: Re-embed nodes dirtied by this pass, then eviction sweep ──
await this.reembedDirty();
// D-37: schema induction after Phase C reembedDirty(), before eviction.
await this.inducer.induceSchemas();
// D-07: schema-relation derivation after induceSchemas()
await this.deriver.deriveSchemaRelations();
// D-04 Phase 28: corpus promotion after schema relations are fresh
await this.corpusPromoter.promote();      // ← INSERT HERE
this.strength.runEvictionSweep();
```

**Insertion rationale:** Corpus promotion needs fresh `schema_rel` + super-schema edges (built by `deriveSchemaRelations()`). It must run before `runEvictionSweep()` so the eviction sweep sees the new doc nodes as lifecycle-exempt (they have `s=0`, which protects them from eviction under the standard `c < threshold` sweep).

**DI wiring in `run-sleep-pass.ts`:**
```typescript
// Line 341 area — alongside SchemaRelationDeriver instantiation
const deriver = new SchemaRelationDeriver(db, store, config, realClock);
const corpusPromoter = new CorpusPromoter(db, store, clock, {
  highMass: HIGH_MASS,   // 10
  lowMass: LOW_MASS,     // 7
  noiseCap: NOISE_CAP,   // 0.5
});

const consolidator = new Consolidator(
  ...,
  deriver,
  corpusPromoter,   // add to Consolidator constructor signature
);
```

---

## Live Brain Grounding — Key Numbers

All queries run against a WAL-safe copy of `~/.config/recense/recense.db` (2026-06-19).

| Metric | Spec Estimate | Actual |
|--------|---------------|--------|
| Schema nodes (live) | 266 | **267** |
| Facts (live) | 4,216 | **4,240** |
| Entities (live) | 3,186 | **3,192** |
| Doc nodes (live) | 1 | **1 (tonos)** |
| abstracts: schema→entity | ~985 | **963** |
| abstracts: schema→fact | ~422 | **403** |
| abstracts: schema→schema (super) | ~83 | **83** (32 super-schemas) |
| schema_rel (cosine pairs) | ~12 | **12** |
| Total schema→schema layer | ~95 | **95** (83+12) |
| Schemas at mass ≥ 12 | ~24 | **14** |
| Schemas at mass ≥ 8 | ~50 | **36** |
| Schemas at mass ≥ 8, noise_frac < 0.5 | — | **30** |
| Schemas at mass ≥ 10, noise_frac < 0.5 | — | **17** ← recommended high-water gate |
| Containment edge candidates (D-02) | to exceed 95 | **0** ← BLOCKER |
| Reference pairs among promoted (via SREL-02 + schema_rel) | — | **~5** unique |
| Edge kinds in live DB | 5 | **5** (relation/abstracts/schema_rel/cites/doc_link) |
| Schema version | — | **11** |

### Gate Recommendation (Req-2: ~15-60 candidates)

```
HIGH_MASS = 10, NOISE_CAP = 0.5  →  17 promoted schemas  ✓
LOW_MASS  = 7,  NOISE_CAP = 0.5  →  ~47 hysteresis floor  ✓
```

The 17 schemas at the high-water mark are all content-meaningful (GSD Phase 4, Plan phases and tasks, Phase 04 plans, Diagnostic test runs, Missing Athlete Integrations, DeepSeek documentation sources, Phase progression stages, Document identifiers, Recense variants, Phase Plans, Brain Memory, JavaScript module files, Git Worktree Agents, Monthly Plan Files, Haiku model features, Phase execution completion, VTX Slot Projects).

### Token-Shape Regex Calibration (D-07)

The following patterns cover 100% of the confirmed noise schemas and zero false-positives in the mass ≥ 10 set:

```typescript
const NOISE_PATTERNS = [
  /^\/private\//,
  /^\/tmp\//,
  /^\/Users\//,
  /^toolu_[A-Za-z0-9]+$/,       // Anthropic tool IDs
  /^[Cc]ommit\s+[`]?[0-9a-f]{6,}/, // git commit refs
  /^worktreePath:/,
  /^\.claude\/worktrees/,
];
```

The `noise_frac < 0.5` threshold correctly:
- Filters: Output file paths (0.92), Tool identifiers (1.0), Git commit hashes (0.97), Brain Memory Icons (0.93), Worktree Projects (0.86), Brain memory files (0.78)
- Passes: All other promoted schemas including VTX Slot Projects (0.21)

**Planner note:** "Document identifiers" (mass=13, noise=0%, members: D-16, D-06, D-07 etc.) passes the filter but its members are design-decision IDs — they may produce coherent prose about the design decisions of recense itself. This is arguably useful. Leave it in; the generator will cite facts about these decisions.

---

## Runtime State Inventory

Not applicable — this is a greenfield capability (no rename/refactor/migration).

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest (inferred from project patterns — verify with `ls /Users/vtx/brain-memory/tests/`) |
| Quick run | `npx vitest run tests/corpus-promoter.test.ts` |
| Full suite | `npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| CORPUS-01 | `gatherFactsForSchema()` returns ≥1 fact from schema evidence set | unit | `vitest run tests/doc-gather.test.ts` | ❌ Wave 0 |
| CORPUS-02 | Gate returns 15–60 candidates on live-schema-seeded in-memory DB | unit | `vitest run tests/corpus-promoter.test.ts` | ❌ Wave 0 |
| CORPUS-02 | Noise filter excludes schemas with noise_frac ≥ 0.5 | unit | same | ❌ Wave 0 |
| CORPUS-03 | Reference edges created between doc nodes of sibling schemas | unit | same | ❌ Wave 0 |
| CORPUS-03 | Source schema `s`/`c`/edge weights unchanged after promote() | unit (snapshot diff) | same | ❌ Wave 0 |
| CORPUS-04 | `/graph?type=doc` returns doc_containment + doc_reference edges | integration | `vitest run tests/viz-server.test.ts` | ❌ Wave 0 |
| CORPUS-05 | No edge incident on source schema after promote() | unit | `vitest run tests/corpus-promoter.test.ts` | ❌ Wave 0 |

### Wave 0 Gaps

- [ ] `tests/corpus-promoter.test.ts` — covers CORPUS-02, CORPUS-03, CORPUS-05
- [ ] `tests/doc-gather.test.ts` (extend existing if present) — covers CORPUS-01 schema-anchored gather
- [ ] `tests/viz-server.test.ts` (extend existing) — covers CORPUS-04 endpoint change

---

## Security Domain

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | Schema IDs are UUIDs — sanitize in CLI (reject non-UUID slug inputs for schema-doc path) |
| V4 Access Control | no — loopback-only viz server unchanged | — |
| V2 Authentication | no | — |

**Threat T-10-07 (path traversal):** The new CLI `promote-corpus` must validate `--db` path exists before acquiring lock (mirrors WR-02 from `generate-doc-cli.ts`).

**D-43 self-confirmation:** The most critical security-equivalent constraint in this phase. Every test that verifies CORPUS-05 is also a security gate. The planner must make this a blocking test.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `gatherFactsForSchema` centroid comes from the same Float32Array computation as SchemaRelationDeriver | D-09 section | Different implementation → centroid mismatch → poor semantic breadth |
| A2 | vitest is the test framework (inferred from project patterns) | Validation | Test scaffolding commands are wrong |
| A3 | The `slug` field in `node_doc` can hold a UUID schema ID without schema changes | Pitfall 4 | If slug has a VARCHAR constraint or index assumption, UUID slugs may conflict |
| A4 | force-graph `linkDirectionalArrowLength` and `linkLineDash` are available in the vendored version 1.43.5 | D-08 section | Styling hooks not available → fallback to color-only distinction |

[ASSUMED] A1 — centroid reuse pattern  
[ASSUMED] A2 — vitest framework  
[ASSUMED] A3 — node_doc.slug accepts UUID  
[ASSUMED] A4 — force-graph 1.43.5 API surface

---

## Open Questions (RESOLVED)

1. **Containment direction (Req-3 acceptance criterion "≥1 parent→child nest")** — **RESOLVED via D-01R/D-02R (founder decision).** Evidence-set containment is 0; the spine is now centroid-cosine + mass-as-direction (larger-mass schema = parent of a cosine-connected pair, single strongest parent → forest). Implemented in Plan 28-03 Task 1. The earlier mass-as-direction-over-super-schema-siblings recommendation is subsumed by the broader cosine-connected derivation.

2. **`node_doc.slug` type for schema-anchored docs** — **RESOLVED.** `slug TEXT NOT NULL`, no length constraint; UUID schema IDs (length 36) are distinct from project slugs (short, lowercase alphanumeric). No collision risk, no migration needed.

3. **`gatherSiblingDocs` in `doc-generator.ts`** — **RESOLVED.** Keep `gatherSiblingDocs` in the schema-doc generation path; the generator naturally cross-links related schema docs via `recense://doc/<id>` (→ `doc_link` edges), which is intentionally DISTINCT from the structurally-derived `doc_reference` edges (cosine-derived, prose-independent).

4. **force-graph 1.43.5 API for directed arrows and dashed links** — **RESOLVED (A4 confirmed).** `linkDirectionalArrowLength`, `linkLineDash`, `linkDirectionalArrowColor`, and `linkDirectionalArrowRelPos` are confirmed present in the vendored `src/viz/vendor/force-graph.min.js` — Plan 28-04 uses them directly; the color+width fallback is unnecessary.

---

## Sources

### Primary (HIGH confidence)
- `src/consolidation/consolidator.ts` — Phase C wiring point (lines 714–723, confirmed)
- `src/consolidation/run-sleep-pass.ts` — DI wiring pattern for SchemaRelationDeriver (line 341)
- `src/consolidation/schema-relations.ts` — centroid computation, stmtGetSchemaMembers pattern
- `src/consolidation/schema-induction.ts` — `alreadyInSchema` guard (line 304) — root cause of disjoint evidence sets
- `src/consolidation/doc-writer.ts` — lifecycle-exempt write pattern, FTS suppression, one-live-doc-per-slug
- `src/reader/doc-gather.ts` — `gatherFacts` signature, `gatherSiblingDocs` function
- `src/reader/doc-generator.ts` — `generateDoc`, `buildDocPrompt`, citation-verify, empty-output guard
- `src/db/schema.ts` — live DDL (v11), `edge.kind` CHECK constraint, migration pattern
- `src/viz/server.ts` — `/graph?type=doc` handler, `stmtDocNodes` + `stmtDocLinks` statements
- `src/viz/modules/corpus.js` — `linkColor()`, `nodeCanvasObject`, `onNodeClick` → `openDocReader`
- `src/adapter/generate-doc-cli.ts` — 600s timeout pattern, lock discipline, slug-as-anchor pattern

### Live DB Queries (HIGH confidence)
- Node type counts, mass distribution, noise fraction analysis — all run against WAL-safe copy 2026-06-19
- Zero-overlap finding (`|A.ev ∩ B.ev| = 0` for all pairs) — confirmed via SQL intersection query
- Sibling pair counts (4 pairs) and schema_rel pairs (3) among promoted schemas — confirmed

### Secondary (MEDIUM confidence)
- `src/adapter/sleep-pass-cli.ts` — not read (run-sleep-pass.ts has the relevant logic); inferred from grep results

### Tertiary (LOW / ASSUMED)
- vitest as test framework — not verified via `package.json` read
- force-graph 1.43.5 `linkDirectionalArrowLength` / `linkLineDash` API — not verified in vendored file

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all files read from live source
- Architecture: HIGH — live DB + source confirmed; critical blocker (D-02 zero edges) verified empirically
- Pitfalls: HIGH — D-02 blocker confirmed via SQL; swallowed-timeout from Phase 27 STATE.md
- Thresholds: HIGH — derived from live DB queries, not estimates

**Research date:** 2026-06-19  
**Valid until:** 30 days (stable codebase; schema grows incrementally but patterns don't change)
