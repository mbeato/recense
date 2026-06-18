# Requirements: brain-memory — v5.0 Foundational Memory Store + Reader Layer

**Defined:** 2026-06-17
**Core Value:** The memory learns and stays correct over time — forms generalizations the user never stated, and updates the right belief in place when a fact changes.

This milestone makes recense the **single foundational store** for the founder's knowledge (retiring the flat per-project MEMORY.md stores) and adds a **generated human-readable reader layer** over the brain. Derived from backlog 999.3/999.5/999.2/999.4; sequenced foundation → cleanup → retrieval → reader. Long-form human vault deep-dives are kept (reference); only dated recall-facts migrate.

## v1 Requirements

### Foundational Store (Phase 24 — ex-999.3; engine + importer code already landed, this is verify + migrate)

- [x] **SCOPE-01**: Consolidation completes a full FK-free sleep pass on the live DB, clears the dirty sentinel, and the hourly sleep-pass launchd agent is re-enabled — the clean-consolidation gate that unblocks the migration (verifies the schema-relations DELETE-side FK fix end-to-end). (NOTE: "dirty sentinel clears" is unmeetable — the sentinel is a permanent launchd TRIGGER, not clearable state; real signal = backlog≈0 + clean FK pass. Met 2026-06-18.)
- [x] **SCOPE-02**: Each consolidated fact carries single-tenant provenance — `node_scope` scope derived from its contributing episodes' `cwd` (single known project → that slug; multi-project or personal/unknown → `global`); retrieval stays GLOBAL (scope is attribution, not an isolation boundary). Verified live.
- [x] **SCOPE-03**: `recense import-memory` idempotently migrates `~/.claude/projects/*/memory` recall-facts into recense through the ingestion pipeline (`source='memory-import'`, stable `external_id`), skipping load-bearing policy bundles and MEMORY.md index files.
- [x] **SCOPE-04**: A verified end-to-end migration runs the consolidate→verify→retire flow — imported facts are confirmed retrievable with correct `[scope]` surfaced in recall output before any source file is retired (retirement human-confirmed; never delete a source before its facts are verified in recense). Retirement EXECUTED 2026-06-18 (quick-260617-w0u): 197 fact files moved (not deleted) to `~/.claude/projects-memory-archive-2026-06-18/`; 12 MEMORY.md indexes + 7 policy bundles + 2 live trackers kept in place.

### Entity Dedup / Prune (Phase 25 — ex-999.5; new build)

- [ ] **DEDUP-01**: A repeatable consolidation pass merges near-duplicate entity nodes (value + embedding similarity above threshold, origin-guarded) into a single canonical node.
- [ ] **DEDUP-02**: Merging rewires the duplicates' edges onto the canonical node and tombstones the duplicates without losing provenance — never deletes an evidence-backed fact.
- [ ] **DEDUP-03**: Entity fragmentation for a sample project (e.g. the 8+ near-duplicate "brain-memory" entities) measurably drops, with no regression to recall accuracy.

### Belief-Correction / Duplicate-Fact Fix (Phase 26 — ex-999.2; RE-SCOPED 2026-06-18 after diagnosis)

> Originally scoped as an embedder/cosine "retrieval fix." Three read-only ~$0 diagnoses falsified that premise — the real bug is in the consolidation judge + PE-resistance routing, not the embedder. See `.planning/phases/26-retrieval-embedding-fix/26-DIAGNOSIS-V{1,2,3}.md`.

- [x] **RETR-01** (DIAGNOSED 2026-06-18): The duplicate-fact / belief-correction-incomplete symptom is diagnosed. The original "sub-0.7 cosine / embedder" premise is falsified: contradicting and restated claims already cluster as candidates (cosine 0.3–0.97; the consolidation gate is `unrelatedSimilarityThreshold` 0.3, NOT the 0.7 `deletedSimilarityThreshold` which only gates the retrieval-forget path) yet a duplicate is minted anyway. Root cause is **post-retrieval — in the consolidation judge verdict and/or PE-resistance contradiction routing** (`consolidator.ts:485-622,896-902`; failure class documented at `config.ts:269-293`). NOT embedder-bound, NOT cosine-threshold-bound.
- [~] **RETR-02** (DEAD-END 2026-06-18): Isolation done — judge-replay (26-06) split the failure: judge-miss dominant (20/30), PE-routing exonerated (0 pe-escape). The judge-prompt fix (26-07, commit 98d3683) was built, validated on the judge-replay, and **failed** (net −1 on 29 deterministic local-35b temp-0 pairs: 2 improved / 3 regressed / 24 unchanged) → **REVERTED** (c3becc3). Root insight: the "judge-miss" metric **over-counts** — the flagged near-dup pairs are distinct-but-structurally-similar facts (different plan→decision mappings, per-task output paths, same-subject/different-attribute) where the judge is correct; they are NOT same-belief restatements minted as dups. The judge prompt is not the lever; PE-routing is fine. The real duplicate problem (exact-dup accumulation) is handled by RETR-03. The expensive full-KU run was deliberately not spent.
- [x] **RETR-03** (COMPLETE 2026-06-18): Fact-level dedup pass (`FactDedup`, Phase-25 entity-dedup analog) + opt-in `recense dedup-facts` CLI (--dry-run default). Live run collapsed **44 clusters / 50 nodes** on the live graph: losers tombstoned (never deleted), edges rewired, `PRAGMA foreign_key_check` empty, repeatable no-op, self-ingestion pollution excluded, no recall regression. Graph stays source of truth.

### Reader Layer (Phase 27 — ex-999.4; productize the validated slice)

- [ ] **READER-01**: A project doc generates from current facts as a `type='doc'` node — lifecycle-exempt (no recall-embedding, eviction, decay, `training_eligible`, or claim-extraction *from* it; writes routed through the single consolidator writer) — citing every substantive claim with an inline `recense://fact/<id>` ref, with no claim lacking a backing fact.
- [ ] **READER-02**: The reader UI serves the doc via a `/doc` route with a Reader/Brain toggle; clicking a fact-ref focuses its atom in the brain graph with selection preserved across the toggle (one system at two altitudes).
- [ ] **READER-03**: Citation staleness is detected (`node.last_access > doc.generatedAt`), tombstoned/changed cited facts are flagged with a `prev_value → value` diff, and the doc is regenerable from current facts.
- [x] **READER-04**: A doc→doc corpus graph (`doc_link` edges) is navigable and subsumes the per-project graph view (centering it on a project shows its docs alongside neighbors).

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
| SCOPE-01 | Phase 24 | Satisfied |
| SCOPE-02 | Phase 24 | Satisfied |
| SCOPE-03 | Phase 24 | Satisfied |
| SCOPE-04 | Phase 24 | Satisfied |
| DEDUP-01 | Phase 25 | Pending |
| DEDUP-02 | Phase 25 | Pending |
| DEDUP-03 | Phase 25 | Pending |
| RETR-01 | Phase 26 | Complete |
| RETR-02 | Phase 26 | Dead-end (reverted; documented) |
| RETR-03 | Phase 26 | Complete |
| READER-01 | Phase 27 | Pending |
| READER-02 | Phase 27 | Pending |
| READER-03 | Phase 27 | Pending |
| READER-04 | Phase 27 | Complete |

**Coverage:**
- v1 requirements: 14 total
- Mapped to phases: 14
- Unmapped: 0 ✓

---
*Requirements defined: 2026-06-17*
*Last updated: 2026-06-17 after initial v5.0 definition*
