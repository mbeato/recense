# Requirements: brain-memory — v5.0 Foundational Memory Store + Reader Layer

**Defined:** 2026-06-17
**Core Value:** The memory learns and stays correct over time — forms generalizations the user never stated, and updates the right belief in place when a fact changes.

This milestone makes recense the **single foundational store** for the founder's knowledge (retiring the flat per-project MEMORY.md stores) and adds a **generated human-readable reader layer** over the brain. Derived from backlog 999.3/999.5/999.2/999.4; sequenced foundation → cleanup → retrieval → reader. Long-form human vault deep-dives are kept (reference); only dated recall-facts migrate.

## v1 Requirements

### Foundational Store (Phase 24 — ex-999.3; engine + importer code already landed, this is verify + migrate)

- [ ] **SCOPE-01**: Consolidation completes a full FK-free sleep pass on the live DB, clears the dirty sentinel, and the hourly sleep-pass launchd agent is re-enabled — the clean-consolidation gate that unblocks the migration (verifies the schema-relations DELETE-side FK fix end-to-end).
- [ ] **SCOPE-02**: Each consolidated fact carries single-tenant provenance — `node_scope` scope derived from its contributing episodes' `cwd` (single known project → that slug; multi-project or personal/unknown → `global`); retrieval stays GLOBAL (scope is attribution, not an isolation boundary). Verified live.
- [ ] **SCOPE-03**: `recense import-memory` idempotently migrates `~/.claude/projects/*/memory` recall-facts into recense through the ingestion pipeline (`source='memory-import'`, stable `external_id`), skipping load-bearing policy bundles and MEMORY.md index files.
- [ ] **SCOPE-04**: A verified end-to-end migration runs the consolidate→verify→retire flow — imported facts are confirmed retrievable with correct `[scope]` surfaced in recall output before any source file is retired (retirement human-confirmed; never delete a source before its facts are verified in recense).

### Entity Dedup / Prune (Phase 25 — ex-999.5; new build)

- [ ] **DEDUP-01**: A repeatable consolidation pass merges near-duplicate entity nodes (value + embedding similarity above threshold, origin-guarded) into a single canonical node.
- [ ] **DEDUP-02**: Merging rewires the duplicates' edges onto the canonical node and tombstones the duplicates without losing provenance — never deletes an evidence-backed fact.
- [ ] **DEDUP-03**: Entity fragmentation for a sample project (e.g. the 8+ near-duplicate "brain-memory" entities) measurably drops, with no regression to recall accuracy.

### Retrieval-Embedding Fix (Phase 26 — ex-999.2; new build, ~$3–5 API)

- [ ] **RETR-01**: The sub-0.7 cosine retrieval weakness is diagnosed and fixed — apply the embedder's query-instruction prefix and/or swap to a stronger embedding model (`text-embedding-3-large` / Qwen3 query-prefix).
- [ ] **RETR-02**: The fix is validated via the cached extraction-replay harness (no re-extraction) showing improved retrieval/KU on EVAL-01 with no regression to belief-correction.
- [ ] **RETR-03**: Any embedder change re-embeds stored node texts and rebuilds the derived vector cache consistently — the graph stays the source of truth, the vector store a derived cache.

### Reader Layer (Phase 27 — ex-999.4; productize the validated slice)

- [ ] **READER-01**: A project doc generates from current facts as a `type='doc'` node — lifecycle-exempt (no recall-embedding, eviction, decay, `training_eligible`, or claim-extraction *from* it; writes routed through the single consolidator writer) — citing every substantive claim with an inline `recense://fact/<id>` ref, with no claim lacking a backing fact.
- [ ] **READER-02**: The reader UI serves the doc via a `/doc` route with a Reader/Brain toggle; clicking a fact-ref focuses its atom in the brain graph with selection preserved across the toggle (one system at two altitudes).
- [ ] **READER-03**: Citation staleness is detected (`node.last_access > doc.generatedAt`), tombstoned/changed cited facts are flagged with a `prev_value → value` diff, and the doc is regenerable from current facts.
- [ ] **READER-04**: A doc→doc corpus graph (`doc_link` edges) is navigable and subsumes the per-project graph view (centering it on a project shows its docs alongside neighbors).

## v2 Requirements

Deferred — tracked, not in this roadmap.

### Reader / Recall polish

- **READER-05**: Section-level (vs whole-doc) regeneration for reconciliation.
- **READER-06**: Scheduled automatic doc regen triggered when a cited fact's `last_access` advances (reverse `cites`-edge lookup marks dependents dirty).
- **SCOPE-05**: Soft current-cwd recall relevance boost (the recall hook already has cwd) — revisit only if cross-project bleed proves real; no hard filtering.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Multi-tenant namespaces / per-tenant isolation | Engine stays single-tenant (reaffirmed); `scope` is provenance only. Namespace multi-tenancy is SEED-003, behind a real trigger. |
| Hard project-scoped retrieval filtering | Global recall is *wanted* (personal facts + learned patterns must surface everywhere); D-S6 defers even the soft boost. |
| ANN vector index (HNSW/sqlite-vec) | Brute-force cosine is exact and sub-ms at ~5k nodes; deferred until measured latency hurts. |
| Doc editing in the reader | Read-only; docs are generated from facts. Editing would fork the source of truth. |
| Migrating `~/vault` deep-dives or policy bundles | Human-reference long-form (kept) and load-bearing deterministic config (voice profile, no-inflated-metrics, etc.) — never risk dropping a load-bearing rule into probabilistic retrieval. |
| Model weight training / LoRA | Learning lives in the memory substrate, not the model; parametric learning is a later seam. |

## Traceability

Each requirement maps to exactly one phase. Filled at definition; roadmapper validates coverage.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SCOPE-01 | Phase 24 | Pending |
| SCOPE-02 | Phase 24 | Pending |
| SCOPE-03 | Phase 24 | Pending |
| SCOPE-04 | Phase 24 | Pending |
| DEDUP-01 | Phase 25 | Pending |
| DEDUP-02 | Phase 25 | Pending |
| DEDUP-03 | Phase 25 | Pending |
| RETR-01 | Phase 26 | Pending |
| RETR-02 | Phase 26 | Pending |
| RETR-03 | Phase 26 | Pending |
| READER-01 | Phase 27 | Pending |
| READER-02 | Phase 27 | Pending |
| READER-03 | Phase 27 | Pending |
| READER-04 | Phase 27 | Pending |

**Coverage:**
- v1 requirements: 14 total
- Mapped to phases: 14
- Unmapped: 0 ✓

---
*Requirements defined: 2026-06-17*
*Last updated: 2026-06-17 after initial v5.0 definition*
