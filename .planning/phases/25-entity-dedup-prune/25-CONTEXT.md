# Phase 25: Entity Dedup / Prune - Context

**Gathered:** 2026-06-18
**Status:** Ready for planning
**Mode:** `--auto` (decisions auto-selected from recommended options; review before planning)

<domain>
## Phase Boundary

A repeatable, **LLM-free, offline** consolidation pass that finds near-duplicate
**entity** nodes (e.g. the 8+ "brain-memory" fragments, the "tonos" / "Tonos daily
eval pipeline" split surfaced by the reader slice), merges each cluster into a
single **canonical** node, **rewires all edges** onto the canonical, and
**tombstones** (never deletes) the duplicates while preserving provenance — so
retrieval and doc generation are no longer muddied by fragments.

**In scope:** entity-type nodes only; value-similarity + embedding-cosine matching;
canonical selection; edge rewiring with collision handling; tombstone + provenance
audit; repeatability (second run = no-op); `PRAGMA foreign_key_check` stays empty.

**Out of scope (own phases / deferred):** fact-node or schema-node merging (entities
only this phase); the sub-0.7 cosine *retrieval* weakness (Phase 26); changing the
embedder (Phase 26); any reader/doc work (Phase 27); wiring dedup into the automatic
hourly sleep pass (kept manual/opt-in this phase — see D-13).

</domain>

<decisions>
## Implementation Decisions

These were auto-selected (recommended option per gray area). They are HOW-to-implement
choices within the fixed phase boundary, not new scope. Planner/researcher may refine
thresholds and mechanics against live source — flag any that conflict with the engine
invariants.

### Cluster matching — how candidates form + merge threshold (→ DEDUP-01)
- **D-01:** Two-stage, **precision-first**. Stage 1 = cheap **blocking** by normalized
  value (lowercase, trim, collapse internal whitespace/punct — reuse
  `src/consolidation/normalize.ts`) to form coarse candidate buckets over
  `type='entity' AND tombstoned=0` nodes. Stage 2 = confirm each candidate pair with
  **embedding cosine ≥ a conservative MERGE threshold deliberately higher than
  retrieval's 0.7** (start **0.88**, configurable) — a false merge corrupts the graph
  irreversibly-in-feel, so bias hard toward *not* merging on doubt.
- **D-02:** **Deterministic** iteration (stable sort by id) so the pass is repeatable:
  a second run finds no live duplicates and is a no-op (DEDUP-01 repeatability criterion).
- **D-03:** Clustering is **transitive within a run** (A~B, B~C → one canonical for
  {A,B,C}), computed against the pre-pass snapshot so ordering can't change the result.

### Origin guard — never collapse genuinely distinct beliefs (→ DEDUP-01)
- **D-04:** Do **not** merge when the merge would collapse distinct beliefs: skip pairs
  that are not lexically near-identical AND cross an `asserted_by_user` vs `inferred`
  origin boundary; never merge a node that carries an active `prev_value`/contradiction
  chain into another (it's mid-reconciliation). When unsure, leave separate.

### Canonical selection — which node survives (→ DEDUP-02)
- **D-05:** Canonical = highest **edge degree** (most-referenced identity is preserved),
  tie-break → highest confidence `c` → earliest `last_access` (most established) →
  lexicographic `id` (determinism). The canonical **keeps its own `id`** so existing
  references stay stable.
- **D-06:** `node_scope` sidecar: canonical keeps its own scope; if it has none, inherit
  a duplicate's. Same rule for `node_temporal` if present.

### Edge rewiring + PK-collision handling (→ DEDUP-02, FK-clean)
- **D-07:** Rewire **every** edge whose `src` or `dst` is a duplicate → canonical `id`.
  On `(src,dst,rel)` PK collision with an existing canonical edge, **merge**: keep
  `max(w)`, latest `last_access`, preserve `kind`. **Drop self-loops** (`src==dst`)
  the merge would create.
- **D-08:** Do the rewire as delete-old-edge + `upsertEdge`-canonical inside **one
  transaction**, in FK-safe order, then assert `PRAGMA foreign_key_check` returns empty
  before commit. **This is the load-bearing guard** — it is exactly the failure mode of
  the T-FK-01 bug (an `edge.src` pointing at a non-existent node id). See canonical refs.

### Provenance + pass packaging / safety (→ DEDUP-02, DEDUP-03)
- **D-09:** Duplicates are **tombstoned via `store.tombstone()`**, never deleted
  (engine invariant: never delete an evidence-backed fact). Tombstone already clears
  `training_eligible` and removes the node from FTS.
- **D-10:** Each merge writes a **`consolidation_event`** row (`event_type='entity_merge'`,
  `node_id`=canonical, `candidate_id`=duplicate, `payload`=cluster + threshold + cosine)
  for an auditable, reversible merge trail — provenance preserved per DEDUP-02.
- **D-11:** The pass ships as a **separate, manual, opt-in CLI subcommand**
  (e.g. `recense dedup-entities`) with a **`--dry-run` report mode** (clusters it *would*
  merge, counts, sample) as the default-first experience. It is **NOT** wired into the
  automatic hourly sleep pass this phase — structural destructive change, mirrors the
  "gated live-write needs a real off-switch" lesson.
- **D-12:** **LLM-free, ~$0** — reuse already-stored node embeddings and the existing
  cosine helper (`src/retrieval/`); no new API calls, no new runtime dependency.
- **D-13:** DEDUP-03 verification: measure distinct live "brain-memory" entity count
  before (8+) and after (target 1 canonical), and run a **sample recall query set**
  pre/post to confirm no observable recall-accuracy regression. Capture both in a written
  verification artifact.

### Claude's Discretion
- Exact MERGE cosine value (0.88 starting point), blocking-key normalization specifics,
  and whether stage-1 blocking also seeds candidate pairs from FTS/embedding nearest-
  neighbors (vs normalized-value buckets only) — planner/researcher tune against the live
  DB, holding the precision-first principle (D-01) fixed.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

ROADMAP.md lists no explicit `Canonical refs:` for Phase 25; the load-bearing refs are
the live source files the pass touches plus the FK lesson that governs edge rewiring.

### Data model (what the pass reads/writes)
- `src/db/schema.ts` — `node` table (`type`, `value`, `value_hash`, `embedding`,
  `origin`, `c`, `last_access`, `prev_value`, `tombstoned`), `edge` table
  (`src`/`dst` FK→`node(id)`, PK `(src,dst,rel)`, `w`, `kind`), `consolidation_event`
  audit table, and the `node_scope` / `node_temporal` sidecars (FK→node, NOT
  auto-deleted on tombstone — pass must handle them).
- `src/db/semantic-store.ts` — `tombstone(id)` (sets tombstoned, clears
  training_eligible, removes from FTS), `upsertEdge(...)` (ON CONFLICT updates
  w/last_access/kind), `getNode`, contradiction helpers. The single-writer store.
- `src/lib/types.ts` — `NodeType` (`'entity'|'fact'|'schema'`), `EdgeKind`, `NodeRow`,
  `EdgeRow`, `Origin`.

### Matching primitives to reuse
- `src/consolidation/normalize.ts` — value normalization for stage-1 blocking.
- `src/retrieval/engine.ts` / `src/retrieval/topk.ts` — existing cosine helper and the
  `type='entity'` enumeration pattern (engine.ts:149).

### FK-safety lesson (load-bearing for D-08)
- `src/consolidation/consolidator.ts` — the T-FK-01 fix (commit `67eee74`): a judge
  `best_candidate_id` used as `edge.src` without filtering against the candidate id set
  caused `FOREIGN KEY constraint failed`. Edge rewiring in this phase must hold the same
  invariant: never write an edge referencing a non-existent / about-to-be-tombstoned id.
- `.planning/STATE.md` "Phase 25 — Context" — fragmentation observations (8+
  brain-memory, tonos split, max edge degree ~15) and the four required behaviors.

### Where the pass plugs in
- `src/consolidation/run-sleep-pass.ts` + `src/adapter/sleep-pass-cli.ts` — the offline
  pass harness/CLI pattern to mirror for the new opt-in `dedup-entities` subcommand
  (manual, NOT auto-wired — D-11).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `tombstone(id)` and `upsertEdge(...)` in `semantic-store.ts` cover the destructive
  half of the merge — no new store primitives strictly required (a small batched
  edge-rewire + node-degree query is the likely addition).
- `normalize.ts` (blocking key) and the retrieval cosine helper (confirmation) cover
  matching with zero new deps.
- `consolidation_event` already exists as a generic audit table — `entity_merge` is a
  new `event_type`, no schema change.

### Established Patterns
- Offline passes run single-writer through the consolidator/sleep-pass path; this pass
  must respect that (no concurrent writer; run while the hourly agent is idle, or share
  its lock).
- Sidecars (`node_scope`, `node_temporal`) are FK→node and are NOT cascade-deleted on
  tombstone — the consolidator already "must update or ignore stale rows." Same
  obligation here (D-06).
- Tombstone (not delete) + `prev_value` carry is the engine's universal supersede idiom.

### Integration Points
- New CLI subcommand alongside existing `recense` adapters (`import-memory-cli.ts`,
  `sleep-pass-cli.ts`) — same arg-parsing/bootstrapping shape.
- The viz reads `tombstoned=0` nodes, so merged-away duplicates vanish from the brain
  window automatically once tombstoned.

</code_context>

<specifics>
## Specific Ideas

- Concrete success target (DEDUP-03): the distinct live entity count for "brain-memory"
  drops from **8+ → 1** canonical node, verified on the live DB, with a pre/post sample
  recall set showing no accuracy regression.
- Repeatability is a hard acceptance gate, not a nice-to-have: run the pass twice; the
  second run must report zero merges.

</specifics>

<deferred>
## Deferred Ideas

- **Fact/schema-node deduplication** — this phase is entities only; fact-level
  near-duplicate collapse (if needed) is its own future scope.
- **Auto-wiring dedup into the hourly sleep pass** — intentionally deferred (D-11);
  revisit only after the manual pass is proven safe and repeatable on the live DB.

### Reviewed Todos (not folded)
- `content-hardening-deferred.md` (todo match score 0.6) — **reviewed, NOT folded.**
  The 0.6 was a spurious "phase/brain" keyword match; its actual content (transcript
  per-speaker handling, Obsidian PDF ingestion) is ingestion/content work, off-domain
  for entity dedup. Stays deferred where it is.
- `viz-search-and-hull-quality.md` (score 0.2) — below fold floor and unrelated (viz).

</deferred>

---

*Phase: 25-entity-dedup-prune*
*Context gathered: 2026-06-18*
