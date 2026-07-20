# Phase 38: Stored Reflections / Derived Insights - Context

**Gathered:** 2026-06-21
**Status:** Ready for planning

> **Mode note:** Gathered in `--auto` mode — every decision below is a
> recommended default chosen by Claude from the codebase map + prior-phase
> patterns (28, 35, 37), grounded in the engine invariants. The founder should
> skim `<decisions>` before planning; anything marked **(verify with founder)**
> is a deliberate posture choice (e.g. confidence-ceiling value, activation
> default) that the planner/eval will pin against the live brain.

<domain>
## Phase Boundary

The offline sleep pass **periodically reflects over schema clusters** and stores
higher-order **derived-insight nodes** — first-class, `origin='inferred'`,
`training_eligible=0`, confidence-capped, decaying, **non-strengthening** — so
online **recall can return one precomputed insight** in place of (or ahead of)
the raw N-member-fact dump, **measurably reducing compose-time tokens with no
quality regression**. This turns "reasons over schemas to handle novel
situations" into a durable, materialized *engine mechanism* rather than a
recall-time-only effect.

**In scope:**
- A new offline reflection step in sleep-pass **Phase C** that synthesizes an
  insight per qualifying schema cluster (REFLECT-01).
- Insight nodes as first-class, inferred, non-strengthening, confidence-capped,
  decaying, **regenerable/evictable like docs** (REFLECT-01).
- Recall surfacing a relevant live insight in place of the raw member
  neighborhood, LLM-free, with a measured compose-token win on the existing
  replay harness (REFLECT-02).
- **Invalidation:** a falsified/tombstoned underlying member flags its dependent
  insight stale so recall stops surfacing it (no stale-insight self-confirmation),
  and the insight is regenerated next pass or evicted when its cluster dissolves
  (REFLECT-01 SC3).

**Out of scope (new capabilities → their own phases):**
- Multi-hop / cross-schema "reasoning chains" beyond a single insight per
  cluster (chaining is a future lever, like Phase 37's multi-hop predicate item).
- Rendering insights in the reader/corpus UI or the 3D brain (insights are a
  *recall* artifact, not reader prose — see D-01; viz changes are out of scope).
- Online (recall-time) synthesis of any kind — all LLM cost stays offline.
- Multi-tenant / cross-account reflection.
- Any new external/npm runtime dependency (net-zero).

**Engine invariants (do NOT violate):** all LLM/embedding cost stays in the
offline sleep pass; the online recall path stays LLM-free and fast; graph is
source of truth, vector is derived cache; **never strengthen a fact (or an
insight) from inferred output** (D-43 self-confirmation guard); never resurface
a tombstoned node; never delete an evidence-backed fact via decay; net-zero new
runtime deps.

</domain>

<decisions>
## Implementation Decisions

### Insight node representation & dependency edges (REFLECT-01)

- **D-01: New `type='insight'` node — NOT a reuse of `type='doc'`.** Insights are
  a short, recall-time payload consumed by the compose path; docs are long-form
  reader prose (slug-keyed, one-live-per-slug, rendered in `/doc` + the corpus
  graph). Conflating them would pollute the reader/corpus surfaces with recall
  artifacts and force slug semantics onto schema-anchored insights. **Reuse the
  doc *lifecycle mechanics* (lifecycle-exempt single-writer, `generated_at`
  staleness, regenerable, evictable) — not the node type.** Add `'insight'` to
  the `node.type` CHECK constraint (mirrors how Phase 27 added `'doc'`).
  - *Source:* doc lifecycle at `db/schema.ts:151-156` (`node_doc` sidecar,
    `generated_at`), `doc-writer.ts` single-writer pattern. Insight gets an
    analogous `node_insight` sidecar (or reuses `node_doc`'s `generated_at`
    shape — planner's call) to carry its generation timestamp + anchor schema id.

- **D-02: One new edge kind `derived_from` (insight → {anchor schema, member
  facts/entities}).** This single kind serves BOTH lookups as in-edge walks
  (the pattern recall already uses):
  - **Recall discovery:** from a resolved schema, `getInEdges(schemaId)` filtered
    to `kind='derived_from'`, `src.type='insight'` → the insight (mirrors the
    Case-B reverse `abstracts` lookup at `recall/index.ts:167-170`).
  - **Invalidation:** from a tombstoned/changed member, `getInEdges(memberId)`
    filtered to `kind='derived_from'` → every dependent insight (see D-06).
  - *Rejected:* reusing `cites` (entangles insight invalidation with doc
    citation, conflates reader and recall dependency semantics). Add
    `'derived_from'` to the `edge.kind` CHECK (mirrors Phase 27 `cites`/`doc_link`).

### Reflection scope, cadence & selection gate (REFLECT-01)

- **D-03: Reuse the Phase-28 mass gate + member-shape noise filter; generate
  only when stale; run every Phase C but *act* only on qualifying stale/new
  clusters.** Synthesize an insight only for schemas above a member-mass floor
  (`mass = COUNT(DISTINCT abstracts members)`, Phase 28 D-06) AND passing the
  D-07 member-shape token-noise filter (so we never synthesize an insight for
  "Git commit hashes" / "Output file paths"). Regenerate only when **stale** — a
  member was added/changed/tombstoned since the insight's `generated_at` (mirror
  the doc staleness predicate). This bounds the dominant sleep-pass cost (Haiku
  extraction is already the cost driver; reflection adds one `generate` per
  *stale qualifying* cluster, not per-cluster-per-pass).
  - *Contrast with docs (load-bearing):* doc prose is generated **lazily** on
    first reader open; insight prose is generated **eagerly in the sleep pass**,
    because the online recall path is LLM-free and cannot synthesize at
    compose-time. Eager-but-staleness-gated is the cost-control posture.

### Insight synthesis: LLM call, confidence ceiling, self-confirmation (REFLECT-01)

- **D-04: One offline `provider.generate()` call per qualifying stale cluster,
  judge/generate-tier, written via the single-writer pattern.** Synthesize a
  short higher-order insight from the cluster's live member facts/entities (the
  `abstracts` evidence set). Store `type='insight'`, `origin='inferred'`,
  `training_eligible=0`, confidence **capped at a fixed ceiling**
  (`reflectConfidenceCeiling`, new config knob, **suggested 0.6 — verify with
  founder**, must sit below typical schema confidence), subject to decay. All
  writes via `SemanticStore` primitives inside one `db.transaction().immediate()`
  (mirror `doc-writer.ts`).
  - **Self-confirmation holds by construction:** (a) insight nodes are
    `origin='inferred'`, so `strengthen()` already no-ops on them
    (`strength/decay.ts:151-153`, D-43); (b) synthesis is **read-only over
    members** — it never calls `strengthen()` on the facts it summarizes, so an
    insight can never reinforce its own evidence. This is the SC3 / CLAUDE.md
    correctness invariant and must be proven with a sentinel test
    (RED-under-injection, the Phase-28 convention).
  - *Model tier:* reuse the existing offline transport (headless Haiku/Sonnet via
    `claude -p`); planner picks the tier — likely the doc-generator's judge tier,
    since insight synthesis is a quality-sensitive generation, not bulk extraction.

### Recall surfacing — augment-with-fallback (REFLECT-02)

- **D-05: Augment-with-fallback, mirroring Phase 37 D-06.** When recall resolves
  a schema (Case A/B) AND a **live, non-stale** insight exists for it AND it
  matches the query, return the **insight node in place of the raw
  abstracts-member dump** — that is the compose-token win (one precomputed string
  vs ~K member facts). Otherwise fall back to today's schema-neighborhood
  assembly (`abstracts` members, K=20 at `recall/index.ts:190-230`), unchanged.
  One mode OR the other per query — never insight *plus* full neighborhood (that
  would re-bloat the payload and erase the win).
  - **Online stays LLM-free:** insight selection reuses the already-computed query
    embedding + the schema resolution; freshness is a flag check; no synthesis at
    recall time.
  - **Tunable + prove-before-activate (mirror Phase 35 D-04):** gate surfacing
    behind a tunable knob; the phase **passes only by demonstrating** a decisive
    compose-token reduction with no quality regression on the existing replay
    harness. Whether the activated default ships on or dark is a founder call
    after the eval **(verify with founder)**.
  - **Measurement:** reuse the KU / LongMemEval replay harness (Phase 35
    `scripts/eval/`); record **payload/compose tokens** (not just answer
    correctness) — the win is a measured *reduction*, the no-regression bar is the
    same small-tolerance band as Phase 35 D-07.

### Invalidation when a member is falsified/tombstoned (REFLECT-01 SC3)

- **D-06: Freshness-gate + regen — not hard cascade-tombstone; a falsified member
  stops surfacing immediately.** Two cases, one mechanism:
  - **Normal churn (member changed/tombstoned):** the member's change/tombstone
    timestamp > insight `generated_at` ⇒ insight is **stale** (found via the
    `derived_from` in-edge walk, D-02). A stale insight is **excluded from
    recall** (recall gates on freshness) and **queued for regen** next Phase C.
  - **Falsified/contradicted member (PE-gated tombstone-reconcile, UPDATE path):**
    the contradicted member is tombstoned, which flags every dependent insight
    stale via the *same* predicate — so recall stops surfacing the insight
    immediately (no stale-insight self-confirmation, SC3). It regenerates from the
    survivors next pass, or is tombstoned + evicted if its cluster no longer
    qualifies (D-03 gate fails).
  - **Eviction "like docs":** insights decay (s drops; they never strengthen, so
    nothing re-lifts them) but are **not** auto-tombstoned by decay alone — they
    are explicitly tombstoned on cluster-dissolution / sustained staleness
    (mirror Phase 28 D-05 hysteresis to avoid pass-to-pass thrash), then collected
    by the standard AND-gated sweep (`strength/decay.ts:189-226`,
    `tombstoned=1 AND low effective_s AND age>30d`). This never deletes an
    evidence-backed fact — insights are inferred, never evidence.

### Architecture / placement (Claude handles — confirmed by the map)

- **D-07: Run reflection as one idempotent `InsightReflector` deriver in Phase C,
  after `corpusPromoter.promote()` (`consolidator.ts:845`) and before
  `runEvictionSweep()` (`consolidator.ts:846`).** Structural sibling of
  `SchemaRelationDeriver` (Phase 18) and the Phase-28 corpus promoter: it reuses
  the per-schema centroids/members those passes already compute, so it adds no new
  embed calls for cluster selection. Eviction runs last so a newly-tombstoned
  dissolved-cluster insight is collected in the same pass.

### Claude's Discretion (route to research/planner)

- Concrete values: `reflectConfidenceCeiling` (suggested 0.6), the mass floor +
  hysteresis high/low for insight promotion/demotion (reuse Phase 28's gate
  constants as starting points), the recall match/freshness threshold, the
  surfacing-activation default — all pinned against the live brain by the
  planner/eval.
- The insight synthesis prompt shape (thesis-from-cluster framing; reuse the
  doc-generator judge-tier path with a "summarize this schema cluster into one
  reusable insight" framing) — spot-check quality per Phase-27/28 convention.
- Whether the generation-timestamp sidecar reuses `node_doc` or adds a small
  `node_insight` table (carrying anchor schema id) — DDL detail.
- The exact recall integration point in `recall/index.ts` (insight lookup folds
  into the Case-A/B schema resolution at L156-183, before neighborhood assembly).
- The eval grid (token-budget sweep / top-k) on the existing harness.

### Reviewed Todos
None folded. The three `todo.match-phase` hits
(`corpus-brain-3d-transition.md`, `content-hardening-deferred.md`,
`viz-search-and-hull-quality.md`) matched only on generic keyword noise
("phase"/"pass"/"quality") and are viz/corpus items unrelated to offline
reflection — folding them would be scope creep. Listed under Deferred.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

*(ROADMAP.md has no `Canonical refs:` line for Phase 38; the refs below were
accumulated from the codebase scout + the directly-analogous prior phases.)*

### Phase contract (READ FIRST)
- `.planning/ROADMAP.md` §"Phase 38: Stored Reflections / Derived Insights" —
  goal, REFLECT-01/02, the three success criteria the plan must satisfy.

### Closest precedents (reuse the patterns, do not rebuild)
- `.planning/phases/18-*/` + `src/consolidation/schema-relations.ts` —
  `SchemaRelationDeriver` (Phase 18): the offline derived-cache deriver pattern
  D-07 mirrors (Phase-A pure reads → Phase-B atomic wipe/rebuild, idempotent,
  reuses per-schema centroids/members). **Entry `deriveSchemaRelations()` ~L151.**
- `.planning/phases/28-schema-anchored-corpus/28-CONTEXT.md` — the
  mass-gate (D-06), member-shape noise filter (D-07), hysteresis (D-05),
  read-only-over-evidence self-confirmation-by-construction (D-03), eager-stub /
  lazy-gen posture, and the RED-under-injection sentinel convention. D-01/D-03/
  D-06 here lean directly on it.
- `.planning/phases/35-recency-strength-retrieval-ranking/35-CONTEXT.md` — the
  dark-default / prove-before-activate posture (D-04) + the eval-harness
  measurement bar (D-05/D-06/D-07) that D-05 here adopts.
- `.planning/phases/37-typed-predicate-edges-build/37-CONTEXT.md` — the
  augment-with-fallback recall shape (D-06) that D-05 here mirrors, and the
  self-confirmation guard framing for inferred-only minting (D-08).

### Live engine — integration points (re-verify; source may have moved)
- `src/consolidation/consolidator.ts` — `consolidate()` ~L452; **Phase C at
  L833-846** (the `induceSchemas → deriveSchemaRelations → corpusPromoter.promote
  → runEvictionSweep` sequence). D-07 inserts the reflector between L845 and L846.
- `src/consolidation/schema-induction.ts` — schema nodes (`type='schema'`,
  `origin='inferred'`) + `abstracts` edges; `stmtGetSchemaMembers` (L195-196) is
  the member-evidence query reflection reads.
- `src/consolidation/doc-writer.ts` — lifecycle-exempt single-writer for
  inferred nodes (D-01/D-04 route insight writes through this pattern); stable-edge
  fill-in-place invariant (L134-139).
- `src/consolidation/corpus-generator.ts` / `doc-generator.ts` — the
  judge-tier generation + citation-verify path D-04 reuses for synthesis.
- `src/recall/index.ts` — recall: online query embed (L144), topk (L148),
  Case-A/B schema resolution (L156-183), 1-hop neighborhood assembly (L190-230),
  compose (L234-246), ephemeral-as-fact append (L256-259). D-05 folds insight
  lookup into L156-183 before neighborhood assembly.
- `src/strength/decay.ts` — self-confirmation guard `strengthen()` (L151-153,
  D-43), `effectiveStrength()` (L93), AND-gated eviction sweep (L189-226). D-04
  and D-06 depend on all three.
- `src/db/semantic-store.ts` — `tombstone()` (L123-125), `upsertNode`/`upsertEdge`,
  `getInEdges`/`getOutEdges` (the in-edge walks D-02 uses).
- `src/db/schema.ts` — `node.type` + `edge.kind` CHECK constraints (D-01 adds
  `'insight'`, D-02 adds `'derived_from'`); `node_doc` sidecar L151-156 (D-01's
  staleness-timestamp model).
- `src/lib/types.ts` — `Origin` (L7), `EdgeKind` (L27), `Node`/`Edge` row shapes
  (L33-68). D-01/D-02 extend these.
- `src/model/provider.ts` — `ModelProvider` seam (`generate`/`embed`/`judge`,
  L36-66); D-04's synthesis call goes through `provider.generate()`.
- `src/lib/config.ts` — where `reflectConfidenceCeiling` + the
  mass/hysteresis/threshold knobs land (sibling to `rankStrengthWeight`,
  `consolSkipThreshold`).

### Eval harness (REFLECT-02 success bar)
- `scripts/eval/replay-ku-harness.cjs`, `scripts/eval/longmemeval-harness.cjs`,
  `scripts/eval/longmemeval-scorer.cjs`, `docs/evals.md` — the existing
  extraction-replay + LongMemEval harness D-05 reuses to prove the compose-token
  win with no quality regression.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`SchemaRelationDeriver` (`schema-relations.ts`)** — the Phase-C deriver
  template (idempotent, reuses per-schema centroids/members); `InsightReflector`
  (D-07) is its structural sibling.
- **Phase-28 mass gate + noise filter** (`corpus-promoter.ts`) — the
  `mass = COUNT(DISTINCT abstracts members)` selection + member-shape token
  penalty D-03 reuses verbatim to pick reflect-worthy clusters.
- **doc lifecycle** (`doc-writer.ts`, `node_doc` sidecar, `generated_at`
  staleness) — the regenerable/evictable/single-writer mechanics D-01/D-06 reuse
  (without reusing the `doc` node type).
- **`strengthen()` origin-guard** (`decay.ts:151-153`) — already no-ops on
  `origin='inferred'`, so insight non-strengthening is free; the member-side guard
  (D-04) is "never call strengthen during synthesis."
- **AND-gated eviction sweep** (`decay.ts:189-226`) — insights ride the existing
  `tombstoned=1 AND low-s AND age>30d` sweep; no new eviction path.
- **`provider.generate()`** (`model/provider.ts`) — the offline synthesis call.
- **Recall Case-A/B schema resolution + `getInEdges`** — D-05 insight lookup and
  D-06 invalidation are both in-edge walks over the same primitives.

### Established Patterns
- **Derived caches are wipe-and-rebuildable, LLM-free for *selection*,
  zero-inferred-signal-back** (SREL-01 / D-37). Reflection adds an LLM
  *synthesis* step but keeps selection deterministic and the write read-only over
  evidence.
- **Self-confirmation is load-bearing and proven by a RED-under-injection
  sentinel** (Phase 28). The new insight path needs the same test.
- **All LLM cost offline; online path LLM-free** — synthesis is Phase C, recall
  surfacing is a flag+lookup.
- **Dark-default + eval-proven activation** (Phase 35 D-04) for any hot-path
  behavior change.

### Integration Points
- Sleep-pass Phase C → insert `InsightReflector` between `corpusPromoter.promote()`
  and `runEvictionSweep()` (`consolidator.ts:845-846`).
- `recall/index.ts:156-183` → fold insight lookup into schema resolution, ahead
  of neighborhood assembly.
- `db/schema.ts` → `node.type` += `'insight'`, `edge.kind` += `'derived_from'`.
- `config.ts` → `reflectConfidenceCeiling` + mass/hysteresis/threshold knobs.
- UPDATE/tombstone path (`decay.ts`/`semantic-store.ts`) → tombstoning a member
  flags dependent insights stale via the `derived_from` in-edge walk.

</code_context>

<specifics>
## Specific Ideas

- The win is a **measured token reduction**: an insight replacing a ~K-member
  neighborhood should shrink the compose payload from ~K facts to one string —
  the harness must record payload/compose tokens, not just answer correctness
  (echoes Phase 37's "measure the reduction, not just correctness").
- Faithfulness framing the synthesis prompt should carry: **the schema is the
  generalization; its abstracted facts/entities are the evidence; the insight is
  the higher-order conclusion that answers "what does X amount to" in one line**
  — reasoning over a schema cluster, materialized.
- "Mass ≠ importance" still bites (Phase 28's live lesson): the highest-mass
  clusters are dogfooding artifacts — D-03's noise filter must run so the first
  insights aren't summaries of "Git commit hashes."

</specifics>

<deferred>
## Deferred Ideas

- **Multi-cluster / cross-schema reasoning chains** (insights that chain ≥2
  schemas) — v1 is one insight per cluster; chaining is a future lever (parallels
  Phase 37's deferred multi-hop predicate chaining).
- **Rendering insights in the reader/corpus or 3D brain** — insights are a recall
  artifact, not reader prose; a future phase could surface them in the UI.
- **Insight-of-insights (recursive higher-order reflection)** — reflecting over
  the insight layer itself; out of scope for v1.

### Reviewed Todos (not folded)
- `corpus-brain-3d-transition.md` (score 0.6) — viz brain↔corpus transition;
  matched on "phase"/"pass" noise, unrelated to reflection.
- `content-hardening-deferred.md` (score 0.4) — content hardening; matched on
  "phase" only.
- `viz-search-and-hull-quality.md` (score 0.4) — viz search + hull quality;
  matched on "phase"/"quality" noise.

All three are viz/content items, not offline-reflection scope — reviewed and
left for their own surfaces.

</deferred>

---

*Phase: 38-stored-reflections-derived-insights*
*Context gathered: 2026-06-21*
