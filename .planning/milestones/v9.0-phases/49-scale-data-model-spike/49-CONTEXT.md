# Phase 49: Scale + Data-Model Spike - Context

**Gathered:** 2026-06-28
**Status:** Ready for planning

<domain>
## Phase Boundary

A **measurement + written-decision spike** — no production code ships, no mechanism is adopted. It produces two evidence-backed written answers to currently-open architecture decisions:

1. **SCALE-01** — A scripted crossover measurement of the existing exact flat-buffer cosine index (`src/retrieval/topk.ts`) vs an approximate ANN (vectorlite/HNSW) over recense's real node scale (~10–50k synthetic + the live brain), identifying the recall/latency crossover point and producing a written **go/no-go** on adopting ANN.
2. **SCALE-02** — A written **recommendation** on whether the reconsolidation model should add Zep-style bi-temporal validity intervals and/or DCPM-style doubly-linked supersedes chains vs the current tombstone approach, with the better-sqlite3 **migration cost** estimated.

A **"defer" outcome on either question is an explicit valid result.** The point is to measure and decide, not to adopt. This spike is independent — depends on nothing, runs in parallel with 46/47/48.

</domain>

<decisions>
## Implementation Decisions

*(Auto-mode: recommended option selected for each gray area; rationale captured inline.)*

### Synthetic corpus construction (SCALE-01)
- **D-01:** Build the 10–50k-node sweep corpus by **scaling up the real live-brain embeddings** — perturb/replicate the ~10–11k live `node.embedding` BLOBs (small Gaussian jitter + renormalize) up to the target counts, and **anchor the sweep on the unmodified live brain** as the real-distribution baseline. Rejected: embedding synthetic text (slow + API cost) and random normalized Float32 vectors (HNSW recall is distribution-sensitive — random vectors would give a misleadingly easy recall result). The real embedding distribution is the load-bearing variable for ANN recall.

### ANN dependency handling (SCALE-01)
- **D-02:** Bring HNSW in as a **devDependency loaded only inside the bench harness** — the production dependency tree stays untouched. This honors the requirement's explicit "measure, not adopt" framing and the existing `topk.ts` doctrine ("swap to sqlite-vec/HNSW only when measured latency hurts"). Rejected: integrating behind the `CandidateRetriever` seam now (premature adoption).
- **D-02b:** Phase 41 recorded that **sqlite-vec was not loadable on this machine**. If vectorlite likewise fails to load, that is a recordable result: fall back to a pure-JS HNSW (e.g. `hnswlib-node`) for the recall/latency comparison, OR record the candidate as `unmeasured-here` and report the measurement as blocked — never fabricate numbers. Researcher should confirm vectorlite's npm-loadability early.

### Crossover metric & go/no-go gate (SCALE-01)
- **D-03:** Measure, at node scales **{~11.3k live, 25k, 50k}** (optionally 100k if cheap): **recall@5 and recall@10 vs the exact brute-force top-k as ground truth**, **query latency p50/p95**, index **build time**, and **memory footprint**. Reuse k=5/10 to match the eval suite (LoCoMo R@5/R@10).
- **D-04:** **Go/no-go gate:** ANN is a "go" only if the **exact index's p95 measurably exceeds the hot-path latency budget** (the Phase 40/41 warm baseline ≈ 45/46 ms over ~11.3k nodes is the felt-path reference) at realistic near-term scale, **AND** HNSW holds **recall@10 ≥ 0.95** vs exact at that scale. If exact latency stays within budget across the sweep, the honest outcome is **no-go / defer** — exact wins on simplicity + zero-dep + byte-exact correctness.

### SCALE-02 deliverable depth
- **D-05:** SCALE-02 is a **written recommendation only — no migration code**. Estimate the better-sqlite3 migration cost by inspecting the **schema delta**: the current model carries reconsolidation state in `node.prev_value`, `node.prev_ts`, `node.tombstoned` (+ `pending_contradictions`) — see `src/db/schema.ts:40-55`. Quantify what columns/tables/indexes/backfill a bi-temporal validity-interval model and/or a doubly-linked supersedes chain would add on top of that, and which existing correctness invariants (decay never deletes evidence-backed facts; graph is source of truth) it must preserve. Rejected: building a throwaway migration PoC (out of scope for a written-decision spike).

### Output format
- **D-06:** Emit a **single `49-SPIKE-FINDINGS.md`** in the phase dir, following the **Phase 41 precedent** (`.planning/phases/41-vector-index-and-hot-path-latency/41-SPIKE-FINDINGS.md`): YAML frontmatter (phase, requirement, sut_commit, date, harness, results path), then two top-level sections — SCALE-01 (measured tables + go/no-go) and SCALE-02 (recommendation + migration-cost estimate). Raw bench JSON lands under `scripts/eval/results/` (gitignored, local-only), same as Phase 41.

### Claude's Discretion
- Exact synthetic-scale rungs beyond {11.3k, 25k, 50k}, HNSW build parameters (M / ef_construction / ef_search) to sweep, and the precise jitter magnitude for corpus scale-up are left to the researcher/planner — these are measurement-tuning details, not user-facing decisions.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements & roadmap
- `.planning/REQUIREMENTS.md` §SCALE-01, §SCALE-02 — the two requirements this phase discharges, including the explicit "measure not adopt" and "out-of-scope until exact-index latency measurably hurts" framing (lines 38–39, 51).
- `.planning/ROADMAP.md` §"Phase 49: Scale + Data-Model Spike" (≈line 820) — goal + success criteria; the "defer is valid" clause.

### SCALE-01 — vector index (direct precedent + reusable assets)
- `.planning/phases/41-vector-index-and-hot-path-latency/41-SPIKE-FINDINGS.md` — the prior exact-index spike: format precedent, the warm/cold methodology, the live-brain node counts (~10,192 embedded / ~11.3k total), and the note that sqlite-vec was unloadable. **Read first.**
- `src/retrieval/topk.ts` — the exact flat-buffer (`RVIX` sidecar) index being benchmarked; documents the derived-cache doctrine and the explicit ANN seam.
- `src/retrieval/engine.ts` — the retrieval path that consumes top-k (cosine floor, hybrid BM25+cosine RRF, tombstone Pass-2).
- `scripts/eval/41-index-spike.cjs`, `scripts/eval/41-latency-after.cjs`, `scripts/eval/41-topk-equivalence.cjs` — existing bench harnesses to fork/extend for the crossover sweep.

### SCALE-02 — reconsolidation / data model
- `src/db/schema.ts:40-75` — current `node`/`edge` schema; the tombstone-reconsolidation columns (`prev_value`, `prev_ts`, `tombstoned`, `pending_contradictions`) that the migration-cost estimate is measured against.
- `src/db/semantic-store.ts` — single-writer embedding/setEmbedding doctrine; relevant to any schema-migration cost.
- `CLAUDE.md` §Constraints — the correctness invariants any new data model must preserve (never delete evidence-backed facts via decay; graph is source of truth, vector is derived cache; tombstone-always was the v1 update-model choice).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`scripts/eval/41-index-spike.cjs` + siblings**: Phase 41's read-only, live-brain bench harness already measures p50/p95 over the real DB and does top-k equivalence checks — the crossover sweep is an extension of this, not a greenfield build.
- **`src/retrieval/topk.ts`**: the exact brute-force scan + the persisted `RVIX` flat-`Float32Array` sidecar — this IS the brute-force baseline arm of the comparison; reuse its `cosineSimF32` / norm-precompute logic for ground-truth recall.
- **Live `recense.db`**: ~10–11k embedded nodes is the real anchor scale; embeddings are 1536-dim Float32 BLOBs in `node.embedding`.

### Established Patterns
- **Spike-findings doctrine (Phase 41)**: frontmatter + measured tables + raw JSON gitignored under `scripts/eval/results/`; report `unmeasured-here` honestly when a candidate won't load rather than fabricating.
- **Derived-cache / seam doctrine**: the vector index is a rebuildable derived cache; ANN adoption is gated behind a measured-latency trigger, not adopted speculatively.
- **Tombstone-always reconsolidation (v1)**: current belief-update model never hard-deletes; SCALE-02 weighs bi-temporal/supersedes against this baseline.

### Integration Points
- This spike **does not integrate** into production paths — bench harness is standalone (devDependency-isolated ANN), findings doc is the deliverable. The only artifacts that touch the repo are: the bench script(s) under `scripts/eval/`, the `49-SPIKE-FINDINGS.md`, and (if recommended later) a follow-up phase to adopt — not this one.

</code_context>

<specifics>
## Specific Ideas

- Mirror the Phase 41 spike's honesty discipline: two embed conditions / `unmeasured-here` recording / gitignored raw results.
- SCALE-02 should explicitly name the external prior art it weighs: **Zep** (bi-temporal validity intervals) and **DCPM** (doubly-linked supersedes chains), against recense's current **tombstone-always** model.

</specifics>

<deferred>
## Deferred Ideas

- **Actual ANN adoption / schema migration** — even if SCALE-01 returns "go" or SCALE-02 recommends bi-temporal, *building* it is a separate future phase. This phase only measures and recommends.

### Reviewed Todos (not folded)
Three pending todos matched on keyword score 0.6 but are **spurious matches** unrelated to a vector-scale / data-model spike — reviewed and **not folded**:
- *"Cache constant judge/extraction prompt prefix via --system-prompt"* — matched on "model"; it's a write-path cost optimization, no relation to vector scale or reconsolidation data model.
- *"content-hardening-deferred"* — matched on "phase/brain"; unrelated content-quality work.
- *"corpus-brain-3d-transition"* — matched on "phase/brain"; a viz concern.

</deferred>

---

*Phase: 49-scale-data-model-spike*
*Context gathered: 2026-06-28*
