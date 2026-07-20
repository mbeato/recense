# Phase 38: Stored Reflections / Derived Insights - Pattern Map

**Mapped:** 2026-06-21
**Files analyzed:** 11 (3 new, 8 modified)
**Analogs found:** 11 / 11 (every new/modified file has a strong in-repo analog)

This phase adds an offline sleep-pass "reflection" step: a new `InsightReflector` deriver
synthesizes one higher-order `type='insight'` node per qualifying stale schema cluster
(judge-tier `provider.generate()`, `origin='inferred'`, confidence-capped, non-strengthening,
decaying), surfaced at recall in place of the raw N-member neighborhood. Every mechanism it
needs already exists in a Phase-18/27/28 analog — this is a "compose existing patterns" phase,
not a novel-architecture phase. The dominant risk is NOT new algorithms; it is keeping the
self-confirmation / lifecycle-exempt / wipe-and-rebuild invariants intact while wiring a
*generative* step (the LLM call) into the otherwise-deterministic deriver mold.

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/consolidation/insight-reflector.ts` *(new)* | service / deriver | event-driven (Phase-C pass) + transform | `src/consolidation/corpus-promoter.ts` (selection + write shape) + `src/consolidation/schema-relations.ts` (deriver mold) | exact (two-analog composite) |
| `src/reader/insight-generator.ts` *(new, or fold into reflector)* | service / generator | transform (LLM synthesis) | `src/reader/doc-generator.ts` `generateDocForSchema` (L391-435) | exact |
| `src/db/schema.ts` *(modify)* | config / DDL | — | its own v11/v12 migration blocks (L348-463) + `node_doc` sidecar (L146-156) | exact |
| `src/lib/types.ts` *(modify)* | model / types | — | `NodeType` (L21), `EdgeKind` (L27), `UpsertNodeDocParams`/`NodeDocRow` (L160-176) | exact |
| `src/db/semantic-store.ts` *(modify, additive)* | model / store | CRUD | `upsertNodeDoc` (L603-610) + `getNodeDoc` (L616-619) sidecar primitive pair | exact |
| `src/recall/index.ts` *(modify)* | controller | request-response | Case-B reverse-`abstracts` lookup (L267-281) + neighborhood assembly (L283-348) + typed-path augment-with-fallback (L172-241) | exact |
| `src/lib/config.ts` *(modify)* | config | — | `schemaRelSimilarityThreshold`/`schemaClusterCutHeight` (L690-691), `rankStrengthWeight` dark-default (L671) | exact |
| `src/consolidation/consolidator.ts` *(modify)* | service / orchestrator | event-driven | Phase-C sequence (L833-846) + deriver DI fields (L174-216) | exact |
| `src/consolidation/run-sleep-pass.ts` *(modify)* | config / wiring | — | `SchemaRelationDeriver`/`CorpusPromoter` construction (L410-441) | exact |
| `src/strength/decay.ts` *(no change expected — verify only)* | service | — | `strengthen` origin-guard (L151-153), AND-gated sweep (L189-226) | exact (reused as-is) |
| `scripts/eval/replay-ku-harness.cjs` *(modify — add token measurement)* | test / harness | batch | the harness's own sweep-mode + meta-output convention (header L1-31) | exact |

---

## Pattern Assignments

### `src/consolidation/insight-reflector.ts` (new — deriver, event-driven + transform)

This is the load-bearing new file. It is a **composite** of two analogs: the
`CorpusPromoter` (selection gate + per-schema member/centroid reuse + lifecycle-exempt
single-writer node creation) and the `SchemaRelationDeriver` (the Phase-A-async /
Phase-B-sync-transaction deriver mold + `NoopX` DI default). The ONE new wrinkle vs both
analogs: an `await provider.generate()` per qualifying-stale cluster in Phase A
(async-before-sync — the generate MUST happen before the write transaction opens).

**Primary analog — class shell, DI fields, `NoopX` default** (`corpus-promoter.ts:122-152`):
```typescript
export class CorpusPromoter {
  private readonly db: Database.Database;
  private readonly store: SemanticStore;
  private readonly clock: Clock;
  private readonly opts: Required<CorpusPromoterOpts>;
  // Prepared statements — compiled once in constructor (T-01-SQL)
  private readonly stmtGetSchemaNodes: Database.Statement;
  private readonly stmtGetClusterableNodes: Database.Statement;
  private readonly stmtGetSchemaMembersWithValues: Database.Statement;
  // ...
}
// NoopCorpusPromoter — test/legacy DI default, satisfies the Consolidator contract (L108-112):
export class NoopCorpusPromoter {
  async promote(): Promise<PromoteResult> { return { promoted: [], containment: 0, reference: 0, tombstoned: 0 }; }
}
```
`InsightReflector` needs the SAME shape + a `NoopInsightReflector` whose `reflect()` returns
an empty result — the Consolidator DI contract requires a Noop default (see consolidator
field defaults at `consolidator.ts:205-206`).

**Selection gate — REUSE VERBATIM** (`corpus-promoter.ts:154-176`, D-03 here):
```typescript
// D-37 firewall: inferred content cannot launder into derivation
this.stmtGetClusterableNodes = db.prepare(
  "SELECT id, embedding FROM node " +
  "WHERE tombstoned = 0 AND origin != 'inferred' " +
  "AND type IN ('fact','entity') AND embedding IS NOT NULL"
);
// mass + noise-fraction member query (mass = COUNT(DISTINCT gated abstracts members))
this.stmtGetSchemaMembersWithValues = db.prepare(
  "SELECT e.dst as id, n.value as value FROM edge e " +
  "JOIN node n ON n.id = e.dst " +
  "WHERE e.src = ? AND e.kind = 'abstracts' " +
  "AND n.type IN ('fact','entity') AND n.tombstoned = 0 AND n.origin != 'inferred'"
);
```
The mass gate + `isNoiseMember` token-shape filter (`corpus-promoter.ts:86-98`, `NOISE_PATTERNS`)
is copied as-is: D-03 requires the SAME mass floor + noise filter so we never synthesize an
insight for "Git commit hashes" / "Output file paths" (the "mass ≠ importance" live lesson).

**Deriver mold — Phase A (async reads) → Phase B (sync `.immediate()` txn, NO await inside)**
(`schema-relations.ts:252-376`, the structural contract D-07 mirrors):
```typescript
async deriveSchemaRelations(): Promise<void> {
  // ── Phase A: collect centroids from observed members (async-free reads) ──
  const schemaNodes = this.stmtGetSchemaNodes.all() as SchemaNodeRow[];
  // ... per-schema centroid math (Pitfall 5: byteOffset decode) ...
  // ── Phase B: sync write inside ONE transaction — NO await inside (T-02-ASYNC) ──
  this.db.transaction(() => {
    this.stmtDeleteSchemaRelEdges.run();   // D-04 wipe-from-scratch
    for (const { src, dst, sim } of pairs) {
      this.store.upsertEdge({ src, dst, rel: 'schema_rel', w: sim, kind: 'schema_rel', last_access: nowMs });
    }
  }).immediate(); // M-5 write-lock discipline — avoid SQLITE_BUSY_SNAPSHOT (WR-02)
}
```
**LANDMINE for the reflector:** unlike both analogs (which are LLM-free), the reflector's
`provider.generate()` is async and MUST run in Phase A, collecting the synthesized
`{schemaId, insightText, citedMemberIds}` payloads into an array, THEN open the Phase-B
`.immediate()` transaction to write nodes/edges. Never `await` inside `db.transaction()`
(T-02-ASYNC — the single hardest invariant to preserve here).

**Insight node write — lifecycle-exempt single-writer** (`corpus-promoter.ts:443-475`, the
eager-stub block; D-01/D-04 route insight writes through this exact shape, swapping `type:'doc'`
→ `type:'insight'`):
```typescript
const docId = newId();
this.store.upsertNode({
  id: docId,
  type: 'doc',          // → 'insight' for the reflector
  value: '',            // → the synthesized insight string
  origin: 'inferred',   // → strengthen() no-ops on this (self-confirmation free, D-43)
  s: 0,                 // lifecycle-exempt: no Hebbian contribution
  c: 1.0,               // → CAP at config.reflectConfidenceCeiling (~0.6) for insight, NOT 1.0
  last_access: now,
});
this.stmtFtsDelete.run(docId);   // FTS suppression — body must not pollute BM25 (Pitfall 7)
this.store.upsertNodeDoc({       // → upsertNodeInsight sidecar (or reuse node_doc) for generated_at
  node_id: docId, slug: info.id, generated_at: now, updated_at: now,
});
this.store.upsertNodeScope({ node_id: docId, scope: info.id, updated_at: now });
```
**Critical deltas vs the doc stub** (D-01/D-04): (a) `type:'insight'` not `'doc'`;
(b) `c` capped at `reflectConfidenceCeiling` (~0.6, NOT 1.0 — must sit below typical schema
confidence); (c) `s` may need to be >0 so the insight *decays* (the doc stub uses `s=0`
lifecycle-exempt; D-04 says insights "decay" and "never strengthen" — confirm with planner
whether `s>0`+decay or `s=0`+explicit-tombstone is the chosen eviction mechanism; D-06's
"decay (s drops)" language implies `s>0`); (d) the `derived_from` edge (D-02) replaces the
doc's `cites` edges.

**`derived_from` edge write** (D-02) — mirror the `cites`-per-fact loop (`doc-writer.ts:180-189`)
but `kind:'derived_from'`, `src=insightId`, `dst ∈ {anchor schemaId} ∪ {member fact/entity ids}`:
```typescript
for (const factId of uniqueCitedIds) {
  store.upsertEdge({ src: effectiveDocId, dst: factId, rel: 'cites', kind: 'cites', w: 1.0, last_access: now });
}
// → reflector: rel: 'derived_from', kind: 'derived_from', dst = schemaId AND each cited member id
```

**Staleness predicate** (D-03/D-06) — the doc model: regenerate only when a member changed
since `generated_at`. The doc sidecar comment (`schema.ts:147-149`) is the canonical model:
> generated_at is a DEDICATED column — NOT node.last_access — so the staleness predicate
> (node.last_access > doc.generated_at) cannot be corrupted when the doc node is accessed.

The reflector's stale predicate: an insight is stale iff any of its `derived_from` members has
`last_access`/tombstone-time `> insight.generated_at`. Found via the `getInEdges` walk (D-02).

**Idempotent wipe-and-rebuild caution (deviation from analogs):** the two analogs wipe their
ENTIRE derived cache every pass (`DELETE FROM edge WHERE kind='schema_rel'`). The reflector
CANNOT blindly wipe-all-insights every pass — that would force regenerating every insight
(an LLM call) on every Phase C, defeating D-03's staleness gate (the whole cost-control
posture). Instead: regenerate (fill-in-place, mirroring `doc-writer.ts:131-139` stable-edge
fill-in-place) ONLY stale/new qualifying clusters; tombstone insights whose cluster dissolved
(D-06 hysteresis). This is the one place the reflector deliberately departs from the pure
wipe-and-rebuild deriver template — call it out in the plan.

---

### `src/reader/insight-generator.ts` (new — generator, transform) — OR fold into reflector

**Analog (exact):** `src/reader/doc-generator.ts` `generateDocForSchema` (L391-435).

The judge-tier generate + empty-output guard + citation-verify path D-04 reuses for synthesis:
```typescript
export async function generateDocForSchema(deps, params, opts = {}): Promise<GenerateDocResult> {
  const { db, store, provider } = deps;
  const facts = await gatherFactsForSchema({ db, store, provider }, { schemaId, centroid, schemaLabel }, ...);
  const factBlock = facts.map(f => `[${f.id}] ${f.value}`).join('\n');
  const prompt = buildSchemaDocPrompt(params.schemaLabel, factBlock, siblingDocs);
  // D-04: judge-tier — provider.generateConfig is set to judgeConfig (run-sleep-pass.ts:393)
  const md = await provider.generate(prompt, { maxTokens: 4000 });   // → far fewer maxTokens for a one-line insight
  if (md.trim().length === 0) throw new Error('doc generation returned empty output ... not persisting');
  const verified = verifyCitations(db, md);   // citation-verify + canonicalize (T-27-04 invented-citation guard)
  return { markdown: verified.canonicalMarkdown, citedFactIds: verified.uniqueVerified, citationCount, invented, tombstoned, linkedDocRefs };
}
```
**Insight-specific deltas:** (a) the prompt is "summarize this schema cluster into ONE reusable
insight" (thesis-from-cluster framing per the `<specifics>`: *schema = generalization,
abstracted facts = evidence, insight = the higher-order conclusion answering "what does X
amount to" in one line*), not a long-form deep-dive; (b) `maxTokens` is small (a sentence or
two, not 4000); (c) the citation-verify loop is the SAME `verifyCitations` shape — it tells you
which member ids the insight actually drew on, which become the `derived_from` edge targets
(D-02) and the staleness-dependency set (D-06). (d) **self-confirmation by construction**
(D-04 SC3): this path is READ-ONLY over members — like `generateDocForSchema` it MUST NOT call
`strengthen`/`setEmbedding`/`tombstone` on the facts it summarizes (the T-27-05 guard,
`doc-generator.ts:16-17`). Prove with the RED-under-injection sentinel (Phase-28 convention).

**Tier wiring** (`run-sleep-pass.ts:393`): the corpus generator's provider is constructed with
`generateConfig: judgeConfig` — insight synthesis is quality-sensitive, so it reuses the same
judge-tier head, NOT the bulk-extraction Haiku head.

---

### `src/db/schema.ts` (modify — DDL CHECK constraints + sidecar)

**Analog (exact):** this file's own v11 (`L348-429`) and v12 (`L431-463`) migration blocks.

**D-01 — add `'insight'` to `node.type` CHECK** (current at `schema.ts:41`):
```sql
type TEXT NOT NULL CHECK(type IN ('entity','fact','schema','doc'))   -- += 'insight'
```
**D-02 — add `'derived_from'` to `edge.kind` CHECK** (current at `schema.ts:63`):
```sql
kind TEXT NOT NULL CHECK(kind IN ('relation','abstracts','schema_rel','cites','doc_link','doc_containment','doc_reference'))  -- += 'derived_from'
```
SQLite cannot ALTER a CHECK constraint → a versioned table-recreation migration is required.
Copy the v12 edge-migration block VERBATIM as the template (`schema.ts:440-463`):
```typescript
const edgeDdl = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='edge'")
  .get() as { sql: string } | undefined)?.sql ?? '';
if (!edgeDdl.includes("'derived_from'")) {     // idempotent guard
  db.pragma('foreign_keys = OFF');             // MUST be outside a transaction (SQLite requirement)
  db.exec(`
    BEGIN;
    CREATE TABLE edge_vNEW ( ... kind ... CHECK(kind IN (..., 'derived_from')) ... );
    INSERT INTO edge_vNEW SELECT * FROM edge;
    DROP TABLE edge;
    ALTER TABLE edge_vNEW RENAME TO edge;
    COMMIT;
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edge_dst ON edge(dst);`);
  db.pragma('foreign_keys = ON');
}
```
Do the SAME for the `node` table (`node.type` recreation — template at `schema.ts:368-411`).
Bump `SCHEMA_VERSION` (downgrade-guarded at `schema.ts:474-475`).

**Sidecar (D-01 staleness model)** — `node_doc` is the template (`schema.ts:146-156`):
```sql
CREATE TABLE IF NOT EXISTS node_doc (
  node_id      TEXT    PRIMARY KEY REFERENCES node(id),
  slug         TEXT    NOT NULL,
  generated_at INTEGER NOT NULL,   -- set once on first generate, updated on regen
  updated_at   INTEGER NOT NULL
);
```
Planner's call (per D-01 / Claude's Discretion): EITHER reuse `node_doc`'s `generated_at`
shape, OR add a small `node_insight(node_id, anchor_schema_id, generated_at, updated_at)`
sidecar carrying the anchor schema id. The `anchor_schema_id` is the one field `node_doc.slug`
doesn't cleanly carry (slug is project-scope semantics) — leaning toward a dedicated
`node_insight` table. Add its index (mirror `idx_node_doc_slug`, `schema.ts:469-472`).

---

### `src/lib/types.ts` (modify — types)

**Analog (exact):** the existing union extensions in this file.

**D-01:** `NodeType` (`types.ts:21`): `'entity' | 'fact' | 'schema' | 'doc'` → `+ 'insight'`.
Also update the inline `node.type` CHECK comment-mirror.
**D-02:** `EdgeKind` (`types.ts:27`): append `| 'derived_from'`.
**Sidecar param/row types** — mirror `UpsertNodeDocParams` / `NodeDocRow` (`types.ts:160-176`)
if a `node_insight` table is added:
```typescript
export interface UpsertNodeDocParams { node_id: string; slug: string; generated_at: number; updated_at: number; }
export interface NodeDocRow { node_id: string; slug: string; generated_at: number; updated_at: number; }
// → UpsertNodeInsightParams / NodeInsightRow with anchor_schema_id replacing slug
```

---

### `src/db/semantic-store.ts` (modify — additive store primitives)

**Analog (exact):** the `upsertNodeDoc` / `getNodeDoc` sidecar primitive pair (`L603-619`).

If a `node_insight` sidecar is added, add the matching owned primitives — single-writer
discipline (CONSOL-03): no raw SQL on the sidecar outside SemanticStore.
```typescript
upsertNodeDoc(params: UpsertNodeDocParams): void { this.stmtUpsertNodeDoc.run({ ... }); }
getNodeDoc(nodeId: string): NodeDocRow | undefined { return this.stmtGetNodeDoc.get(nodeId) as ...; }
// → upsertNodeInsight / getNodeInsight, prepared-stmt-in-constructor (T-01-SQL)
```
`upsertNode`, `upsertEdge`, `tombstone`, `getInEdges`, `getOutEdges`, `getNode` are reused
**as-is, no change** — they already accept the new `type`/`kind` values once the CHECK
constraints widen. Confirm `upsertEdge`'s `kind: EdgeKind` param (`L402`) compiles once
`EdgeKind` includes `'derived_from'`. The in-edge walk D-02/D-06 needs is exactly
`getInEdges(nodeId)` (`L445-447`).

---

### `src/recall/index.ts` (modify — controller, request-response; LLM-free)

**Analog (exact, three patterns in this file):**

1. **In-edge schema/insight resolution** — Case-B reverse-`abstracts` lookup (`L267-281`) is
the exact in-edge-walk template D-05 mirrors; the insight lookup is its sibling on the
RESOLVED schema:
```typescript
// existing Case-B: member → schema via incoming abstracts
const inEdges = this.store.getInEdges(bestMatch.id);
for (const inEdge of inEdges) {
  if (inEdge.kind !== 'abstracts') continue;
  const srcNode = this.store.getNode(inEdge.src);
  if (!srcNode || srcNode.tombstoned === 1 || srcNode.type !== 'schema') continue;
  schemaNode = { id: srcNode.id, value: srcNode.value };
  break;
}
// → D-05 insight lookup: once schemaNode is resolved, getInEdges(schemaNode.id) filtered to
//   kind='derived_from', src.type='insight', src not tombstoned, AND insight not stale
//   (generated_at freshness check via the node_insight sidecar). If a live non-stale insight
//   matches the query → return it IN PLACE OF the neighborhood (the compose-token win).
```

2. **Augment-with-fallback control flow** — the typed-path branch (`L172-241`, Phase 37 D-06)
is the EXACT shape D-05 mirrors: try the cheaper precomputed path; on hit, build the small
payload and `return` immediately; on miss, *fall through* to the existing assembly. D-05
inserts the insight check at this same junction (CONTEXT says "fold into L156-183, before
neighborhood assembly"):
```typescript
if (matchedPredicate !== null) {
  const typedFrontier = typedReach(...);
  if (typedFrontier.length > 0) {
    // ... build small payload ...
    return { inference, episodeId, origin: 'inferred' };   // D-06: typed path OR neighborhood, NEVER both
  }
  // fall through to existing neighborhood assembly
}
```
**INVARIANT (`L310`, must hold for the insight path too):** `no upsertNode/upsertEdge/
tombstone/strengthen here (D-43)` — the ONLY write recall ever makes is the `origin:'inferred'`
episode append. The insight surfacing path is a pure read + freshness-flag check; no synthesis.

3. **Neighborhood assembly = the fallback** (`L283-348`): the `getOutEdges(schemaNode.id)`
filtered to `kind==='abstracts'`, bounded by `recallNeighborhoodBudget` (=20). When no live
non-stale matching insight exists, this path runs unchanged. **One mode OR the other per
query** (D-05) — never insight *plus* full neighborhood (that re-bloats the payload).

---

### `src/lib/config.ts` (modify — config knobs)

**Analog (exact):** `schemaRelSimilarityThreshold` / `schemaClusterCutHeight` (L690-691) for the
threshold knobs; `rankStrengthWeight` (L671) for the **dark-default / prove-before-activate**
posture (D-05).
```typescript
schemaRelSimilarityThreshold: 0.8,  // start conservative; tune against real recense.db (D-01)
schemaClusterCutHeight: 0.35,
rankStrengthWeight: 0,              // D-04: dark default — ships w=0; no behavior change at merge
```
Add (with the field declaration in the `EngineConfig` interface near L331/L429/L465 + the
default in `DEFAULT_CONFIG` near L663-691):
- `reflectConfidenceCeiling` (suggested **0.6 — verify with founder**; must sit below typical
  schema confidence).
- insight mass floor + hysteresis high/low (reuse Phase-28 `highMass:10`/`lowMass:7` from
  `run-sleep-pass.ts:419-420` as starting points — verify against live brain).
- recall insight match/freshness threshold.
- **insight-surfacing activation flag — ship DARK (off / w=0) by default** (D-05, mirroring
  `rankStrengthWeight:0`); the eval flips it on only after proving the compose-token win.

---

### `src/consolidation/consolidator.ts` (modify — orchestrator, event-driven)

**Analog (exact):** the existing Phase-C sequence + deriver DI fields, all in this file.

**D-07 insertion point** — between `corpusPromoter.promote()` (L845) and
`runEvictionSweep()` (L846):
```typescript
await this.inducer.induceSchemas();
await this.deriver.deriveSchemaRelations();
await this.corpusPromoter.promote();
// ← D-07: await this.insightReflector.reflect();   (reuses per-schema centroids/members above)
this.strength.runEvictionSweep();   // runs LAST so a dissolved-cluster tombstoned insight is swept this pass
```
**DI field + constructor param** — mirror the `deriver`/`corpusPromoter` fields exactly
(`L174-175`, `L205-206`, `L215-216`), defaulting to a `NoopInsightReflector`:
```typescript
private readonly deriver: SchemaRelationDeriver | NoopSchemaRelationDeriver;
private readonly corpusPromoter: CorpusPromoter | NoopCorpusPromoter;
// → private readonly insightReflector: InsightReflector | NoopInsightReflector;
// constructor default (L205-206 pattern):
corpusPromoter: CorpusPromoter | NoopCorpusPromoter = new NoopCorpusPromoter(),
// → insightReflector: InsightReflector | NoopInsightReflector = new NoopInsightReflector(),
```

---

### `src/consolidation/run-sleep-pass.ts` (modify — wiring)

**Analog (exact):** the `SchemaRelationDeriver` + `CorpusPromoter` construction block (L410-441).

The reflector needs the JUDGE-TIER provider (unlike the LLM-free deriver/promoter). Construct it
with the same provider whose `generateConfig` is `judgeConfig` (the corpus generator's provider,
wired at `run-sleep-pass.ts:393`), then pass it as the new Consolidator arg:
```typescript
const deriver = new SchemaRelationDeriver(db, store, config, realClock);       // LLM-free
const corpusPromoter = new CorpusPromoter(db, store, realClock, { highMass: 10, lowMass: 7, ... });
// → const insightReflector = new InsightReflector(db, store, <judge-tier provider>, config, realClock, { ...mass/ceiling opts });
const consolidator = new Consolidator(db, episodes, store, strength, retriever,
  activeConsolidatorProvider, inducer, config, realClock, sink, log,
  deriver, corpusPromoter /* , insightReflector */);
```

---

### `scripts/eval/replay-ku-harness.cjs` (modify — token measurement)

**Analog (exact):** the harness's own sweep-mode + meta-output convention (header L1-31).

REFLECT-02's bar is a **measured compose-token reduction with no quality regression**
(D-05, mirroring Phase 35 D-07). The harness already does "consolidate once per case, sweep
retrieve+answer+score per weight" (header L17-19) and writes results with meta (embedder model,
cache id, date, commit). Add: **record payload/compose tokens** (not just answer correctness) so
the insight-on vs insight-off delta is the load-bearing number. The no-regression bar is the
same small-tolerance band as Phase 35. `scripts/eval/longmemeval-harness.cjs` is the LongMemEval
sibling. Mirror the existing "load-bearing output" convention (header L21-24: the harness already
emits judge-engagement counters — add a token-count field alongside).

---

## Shared Patterns

### Self-confirmation guard (load-bearing, D-04 SC3 / CLAUDE.md correctness invariant)
**Source:** `src/strength/decay.ts:151-153`
**Apply to:** the reflector + the insight generator (reused, NOT reimplemented)
```typescript
strengthen(nodeId: string, claimOrigin: Origin): void {
  // T-03-SELFCONF: inferred output must never strengthen a fact (CLAUDE.md correctness guard)
  if (claimOrigin === 'inferred') return;
  // ...
}
```
Holds by construction here: (a) insight nodes are `origin='inferred'` → `strengthen()` already
no-ops on them; (b) synthesis is read-only over members — it never calls `strengthen()` on the
facts it summarizes. **Prove with a RED-under-injection sentinel test** (Phase-28 convention):
assert that running the reflector leaves every source fact/entity's `s`, `c`, edges, and
tombstone state byte-identical (the CORPUS-05 blocking-test pattern at `corpus-promoter.ts:28-29`).

### Eviction (reused as-is, no new path — D-06)
**Source:** `src/strength/decay.ts:189-226`
**Apply to:** insights ride the existing AND-gated sweep
```typescript
if (row.tombstoned === 1 &&
    effectiveS < this.config.evictionSThreshold &&
    (nowMs - row.last_access) > EVICTION_TOMBSTONE_AGE_MS) {
  // FK-safe per-node delete: edges → node_scope → node_temporal → node
}
```
Insights are `origin='inferred'` → never evidence → this never deletes an evidence-backed fact.
**Note:** the sweep's FK-safe child-wipe (`decay.ts:204-216`) deletes `node_scope` + `node_temporal`
but NOT a `node_insight` sidecar. If a `node_insight` table is added (REFERENCES node(id)), the
sweep's per-node child-wipe MUST add a `DELETE FROM node_insight WHERE node_id = ?` step, or the
eviction transaction throws `SQLITE_CONSTRAINT_FOREIGNKEY` — same class of bug as the FK-01/FK-02
fixes documented in `schema-relations.ts:196-210`. **This is the single easiest-to-miss FK landmine
in the phase.** (Reusing `node_doc` instead of a new sidecar sidesteps it, since `node_doc` FK rows
"are harmless" per `schema.ts:150` — tombstone doesn't auto-delete them; verify the same holds for
the hard-delete sweep path.)

### Wipe-and-rebuild idempotency (deriver doctrine — partially applies)
**Source:** `src/consolidation/schema-relations.ts:355-376`, `corpus-promoter.ts:478-482`
**Apply to:** the reflector's `derived_from`-edge rebuild for regenerated insights — but NOT a
blind wipe-all-insights (see the reflector caution above; staleness-gated regen is the
cost-control posture, D-03).

### `.immediate()` write-lock discipline (M-5 / WR-02)
**Source:** every Phase-B transaction (`schema-relations.ts:375`, `corpus-promoter.ts:522`,
`doc-writer.ts:210`, `decay.ts:217`)
**Apply to:** the reflector's Phase-B write transaction
```typescript
this.db.transaction(() => { /* ... sync writes only, NO await ... */ }).immediate();
```
A DEFERRED txn can hit `SQLITE_BUSY_SNAPSHOT` when the viz server holds a concurrent SHARED read
lock — always `.immediate()`.

### Clock + prepared-statement + Pitfall-5 discipline (all derivers)
**Source:** `schema-relations.ts:26-29` (the header invariant list)
**Apply to:** the reflector — all time via `this.clock.nowMs()` (never `Date.now()`); all SQL via
prepared statements compiled once in the constructor (T-01-SQL); `Float32Array` decoded with
`byteOffset + byteLength/4` (Pitfall 5) if it recomputes any centroid (D-07 says it reuses the
promoter's centroids, so it ideally does NOT recompute).

---

## No Analog Found

None. Every new/modified file maps to a concrete in-repo analog. The only genuinely *new*
behavior — a `provider.generate()` call inside the otherwise-deterministic deriver Phase A —
composes the `generateDocForSchema` generate+verify pattern (`reader/doc-generator.ts:391-435`)
into the `SchemaRelationDeriver` async-before-sync mold (`schema-relations.ts:252-376`). Both
halves exist; the phase wires them together.

---

## Metadata

**Analog search scope:** `src/consolidation/`, `src/reader/`, `src/recall/`, `src/strength/`,
`src/db/`, `src/lib/`, `src/model/`, `scripts/eval/`
**Files scanned (read):** schema-relations.ts, corpus-promoter.ts, doc-writer.ts, recall/index.ts,
strength/decay.ts, db/semantic-store.ts, db/schema.ts, lib/types.ts, lib/config.ts (grep),
consolidator.ts (Phase C + DI), run-sleep-pass.ts (wiring), reader/doc-generator.ts,
model/provider.ts (grep), schema-induction.ts (grep), replay-ku-harness.cjs (header)
**Pattern extraction date:** 2026-06-21
