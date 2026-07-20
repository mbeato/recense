# Phase 49: Scale + Data-Model Spike - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-28
**Phase:** 49-scale-data-model-spike
**Mode:** `--auto` (recommended option auto-selected per area; no interactive prompts)
**Areas discussed:** Synthetic corpus construction, ANN dependency handling, Crossover metric & go/no-go, SCALE-02 deliverable depth, Output format

---

## Synthetic corpus construction (SCALE-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Scale up real live-brain embeddings | Perturb/replicate real `node.embedding` BLOBs (jitter + renormalize) to 10–50k; anchor on unmodified live brain | ✓ |
| Embed synthetic text | Generate text, embed via real embedder | |
| Random normalized Float32 | Synthetic random unit vectors | |

**Auto-selected:** Scale up real live-brain embeddings.
**Notes:** HNSW recall is distribution-sensitive — random vectors would yield a misleadingly easy recall result. Real embedding distribution is the load-bearing variable.

---

## ANN dependency handling (SCALE-01)

| Option | Description | Selected |
|--------|-------------|----------|
| devDependency, bench-only | vectorlite/HNSW loaded only in the bench harness; production deps untouched | ✓ |
| Integrate behind CandidateRetriever seam | Wire ANN into the production retrieval path now | |

**Auto-selected:** devDependency, bench-only.
**Notes:** Honors the "measure not adopt" requirement framing and the `topk.ts` seam doctrine. Phase 41 found sqlite-vec unloadable on this machine — if vectorlite also fails, fall back to a pure-JS HNSW or record `unmeasured-here`; never fabricate.

---

## Crossover metric & go/no-go (SCALE-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Full metric sweep + gated go/no-go | recall@5/@10 vs exact + p50/p95 + build/mem at {11.3k,25k,50k}; ANN "go" only if exact p95 breaks the hot-path budget AND HNSW holds recall@10 ≥ 0.95 | ✓ |
| Latency-only crossover | Compare query latency only | |

**Auto-selected:** Full metric sweep + gated go/no-go.
**Notes:** k=5/10 matches the eval suite (LoCoMo R@5/R@10). Phase 40/41 warm baseline ≈45/46 ms is the felt-path budget reference. If exact stays within budget across the sweep, honest outcome is no-go/defer.

---

## SCALE-02 deliverable depth

| Option | Description | Selected |
|--------|-------------|----------|
| Written recommendation only | Migration cost via schema-delta inspection; no code | ✓ |
| Build throwaway migration PoC | Prototype the bi-temporal/supersedes schema | |

**Auto-selected:** Written recommendation only.
**Notes:** Requirement is "written recommendation … with migration cost." Estimate the delta over current `prev_value`/`prev_ts`/`tombstoned` columns; preserve correctness invariants (no decay-delete of evidence-backed facts; graph is source of truth).

---

## Output format

| Option | Description | Selected |
|--------|-------------|----------|
| Single 49-SPIKE-FINDINGS.md (41 precedent) | Frontmatter + two sections; raw JSON gitignored under scripts/eval/results/ | ✓ |
| Two separate docs under docs/ | Split SCALE-01 and SCALE-02 into separate published docs | |

**Auto-selected:** Single 49-SPIKE-FINDINGS.md following the Phase 41 precedent.

---

## Claude's Discretion

- Synthetic-scale rungs beyond {11.3k, 25k, 50k}, HNSW build params (M / ef_construction / ef_search) to sweep, and jitter magnitude for corpus scale-up — measurement-tuning details left to researcher/planner.

## Deferred Ideas

- Actual ANN adoption / schema migration — a separate future phase regardless of this spike's outcome.

### Reviewed todos (not folded)
- "Cache constant judge/extraction prompt prefix via --system-prompt" (score 0.6, keyword "model") — write-path cost work, unrelated.
- "content-hardening-deferred" (score 0.6) — content-quality work, unrelated.
- "corpus-brain-3d-transition" (score 0.6) — viz concern, unrelated.
