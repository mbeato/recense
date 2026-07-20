# Phase 41: Vector Index + Hot-Path Latency - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-23
**Phase:** 41-vector-index-and-hot-path-latency
**Areas discussed:** Index tech & accuracy posture, New native dependency, Index freshness / rebuild contract, Index scope, PERF-02 target/margin, Spike measurement basis, PERF-03 accuracy bar & datasets, ANN seam shape

---

## Index tech & accuracy posture

| Option | Description | Selected |
|--------|-------------|----------|
| Exact (sqlite-vec linear) | Exact cosine in C/SIMD; identical results → PERF-03 free | |
| Approximate (HNSW) | True O(log N) ANN; only pays off at 50K+; accuracy risk | |
| Exact now, ANN seam later | Ship exact, design swappable seam for HNSW later | ✓ |

**User's choice:** Exact now, ANN seam later
**Notes:** Builder pushback up front — at 7K nodes HNSW is premature; dominant cost is row marshaling + Float32Array allocation, not the math. Exact sidesteps the PERF-03 hard gate by construction. The seam already exists in code (`topk.ts:7`).

---

## New native dependency

| Option | Description | Selected |
|--------|-------------|----------|
| Zero-dep JS index first | In-memory contiguous-buffer exact scan; no new dep; IS the derived index | |
| Add sqlite-vec now | Commit to the loadable extension up front; breaks net-zero streak | |
| Spike to decide | Measure JS cache vs sqlite-vec on the live brain before committing | ✓ |

**User's choice:** Spike to decide
**Notes:** Aligns with the founder's measured-not-on-faith / baseline-first discipline. The zero-dep in-memory/persisted flat-buffer cache itself satisfies PERF-01.

---

## Spike go/no-go rule (follow-up to dependency)

| Option | Description | Selected |
|--------|-------------|----------|
| Prefer zero-dep unless it fails the bar | Ship JS if it clears PERF-02 with margin; add sqlite-vec only if it can't | ✓ |
| Prefer zero-dep unless sqlite-vec dramatically faster | Adopt sqlite-vec even if JS passes, if ≥3–5× faster | |
| Fastest wins, deps be damned | Pick fastest regardless of dependency cost | |

**User's choice:** Prefer zero-dep unless it fails the bar
**Notes:** Protects the net-zero-deps streak unless the numbers force the dep.

---

## Index freshness / rebuild contract

| Option | Description | Selected |
|--------|-------------|----------|
| Rebuild at end of sleep pass; may lag until then | Refresh when sleep pass finishes; frozen between (online never writes embeddings) | ✓ |
| Incremental upsert as embeddings written | Entry-by-entry mid-pass; more moving parts, no online benefit | |
| Lazy rebuild on staleness detection | Reader rebuilds if stale; pushes cost onto the cold hot path | |

**User's choice:** Rebuild at end of sleep pass; may lag until then
**Notes:** Consequence surfaced — requires the index to be persisted so cold processes (SessionStart, recall-cli) read a ready index rather than rebuild. All build cost stays offline.

---

## Index scope

| Option | Description | Selected |
|--------|-------------|----------|
| Online hot path only | Recall + inject + tombstoned scan; consolidator stays brute-force | ✓ |
| Shared primitive (online + offline) | Swap everywhere; must solve mid-pass freshness for the consolidator | |
| Online recall only, defer tombstoned scan | Leave both consolidator and tombstoned scan on brute-force | |

**User's choice:** Online hot path only
**Notes:** Avoids the mid-pass staleness trap — the consolidator queries embeddings before the end-of-pass index exists, and it isn't latency-critical.

---

## PERF-02 target / margin

| Option | Description | Selected |
|--------|-------------|----------|
| Relative to baseline + report felt number | Gate = p50/p95 below Phase 40 baseline; report cold inject wall-clock; no hard SLA | ✓ |
| Hard ms SLA | Commit a concrete ceiling now (e.g. inject p95 < 150ms) | |
| Relative gate + felt sanity ceiling | Relative gate + cold inject in a ~100–200ms "feels instant" band | |

**User's choice:** Relative to baseline + report felt number
**Notes:** Baseline numbers not yet in hand — a hard SLA would be guessing. Cold SessionStart-inject wall-clock is the headline felt number since the hook blocks the user.

---

## Spike measurement basis

| Option | Description | Selected |
|--------|-------------|----------|
| Cold end-to-end wall-clock (primary) | Spawn + load + scan; warm as secondary | |
| Warm scan-only (in-process) | Just retrieval scan time; hides cold-start cost | |
| Both, weighted to the live surfaces | Cold for hook/CLI, warm for serve/MCP | ✓ |

**User's choice:** Both, weighted to the live surfaces
**Notes:** Cold measurement is what exposes whether an in-memory cache must be persisted to actually help.

---

## PERF-03 accuracy bar & datasets

| Option | Description | Selected |
|--------|-------------|----------|
| Top-k set identical (± tie reorder), all 3 harnesses | Require returned set to match brute-force; LongMemEval-S + KU + LOCOMO | ✓ |
| Recall@k within ε | Allow a small recall tolerance | |
| End-to-end QA score only | Gate solely on LLM-judge QA accuracy | |

**User's choice:** Top-k set identical (± tie reorder), all three harnesses
**Notes:** Cheap to assert given exactness — a direct index-vs-brute-force equivalence check plus the full eval re-run.

---

## ANN seam shape

| Option | Description | Selected |
|--------|-------------|----------|
| Keep it implicit — stable signature only | Keep CandidateRetriever signatures stable, index behind them | ✓ |
| Formalize a VectorIndex interface | Extract explicit build/query/persist interface now | |
| Planner's discretion | Leave to planner/researcher based on spike outcome | |

**User's choice:** Keep it implicit — stable signature only
**Notes:** Simplicity-first; no speculative abstraction for a single current implementation. The existing seam comment already anticipates this.

---

## Claude's Discretion

- Exact persistence artifact (sqlite-vec `vec0` on-disk vs serialized flat-buffer sidecar) — decided by the spike.
- Whether the online tombstoned 'deleted' scan needs the index or its set is small enough to leave as-is.
- Exact spike instrumentation harness (reuse Phase 40 latency tooling / `instrumentTopkResults`).
- Float sum-order tie differences between C/SIMD and JS cosine — treated as no-regression under the "± tie reorder" allowance.

## Deferred Ideas

- Approximate ANN / HNSW (hnswlib) — deferred until N grows past where exact-linear hurts (50K+); drops in behind the implicit seam.
- Indexing the offline consolidator's `topk` — out of scope; revisit only if offline consolidation latency becomes a concern.
