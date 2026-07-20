# Phase 47: Hybrid Retrieval Recall - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-28
**Phase:** 47-hybrid-retrieval-recall
**Areas discussed:** Fusion method, Anti-regression guard, Held-out tuning, Ship posture & scope

---

## Fusion method

| Option | Description | Selected |
|--------|-------------|----------|
| RRF, weighted | Keep `rrfFuse(k=60)`; BM25-list weight = single tunable scalar, cosine fixed 1.0. Already implemented, score-scale agnostic, net-zero new path. | ✓ |
| z-score weighted blend | Normalize cosine + BM25 to z-scores, blend by α. Uses raw magnitudes but adds normalization + pool-dependent failure mode. | |
| Build both, pick on held-out | Implement both methods, let held-out decide. More eval surface. | |

**User's choice:** RRF ("rrf")
**Notes:** Lowest-risk; fusion machinery already exists from Phase 17. Scalar = BM25-list weight; `w=0` reproduces pure cosine.

---

## Anti-regression guard

| Option | Description | Selected |
|--------|-------------|----------|
| Temporal sort + per-cat gate | Fusion runs with LEVER 2 temporal annotation ON; held-out per-category no-regression is the hard gate. No new mechanism. | ✓ |
| Conservative weight ceiling | Cap BM25 weight low so it can only rescue, never override. Hand-picked guess. | |
| Stale-entity filter only | Rely on existing B2 + tombstone filtering, no temporal sort. Weakest — wouldn't have caught the fact-level Hawaii/Paris case. | |

**User's choice:** Temporal sort + per-cat gate
**Notes:** The 9ea5eabc failure was stale-over-current ordering; recency reorder + the temporal-reasoning category catch it. Per-category no-regression on held-out test is the structural defense.

---

## Held-out tuning

| Option | Description | Selected |
|--------|-------------|----------|
| Split LoCoMo tune/test | Deterministic tune/test split; grid-sweep weight on tune, lock argmax (R@5 s.t. no per-cat regression), report on test only. | ✓ |
| Full-set sweep, report full-set | Sweep + report on all of LoCoMo. Optimistic, in-sample only. | |
| Cross-validation (k-fold) | k-fold CV over conversations. Most robust but k× runtime. | |

**User's choice:** Split ("split")
**Notes:** R@K sweep is LLM-free (retrieved ids vs gold ids), so the grid is cheap; only answer-gen is billed and isn't needed for tuning.

---

## Ship posture & scope

| Option | Description | Selected |
|--------|-------------|----------|
| Enable in responder now | Pass `queryText` through `responder → retrieveRanked`; product QA path uses hybrid fusion immediately with held-out weight default; `w=0` knob fallback. | ✓ |
| Ship dark, enable after Phase 50 | Implement + prove but leave responder on pure cosine until gates lock. Safer, delays the win. | |
| Eval-arm only | Only wire fusion into the LoCoMo harness; don't touch responder. Smallest blast radius, under-delivers RETR-01. | |

**User's choice:** Enable in responder ("enable in responder")
**Notes:** The phase's point is lifting live recall; held-out + per-category gate de-risks the 9ea5eabc repeat. Strength list (`rankStrengthWeight`) stays dark/out of scope — RETR is BM25+dense only.

---

## Claude's Discretion

- Config-knob name + placement beside `bm25CandidateK` / `rankStrengthWeight` / `rankedRetrievalFloor` in `config.ts`.
- Exact tune/test partition strategy + grid points for the weight sweep.
- Whether the responder passes the raw bounded question or the LEVER-3-rewritten `queryForEmbed` as `queryText` (both user-derived; pick what measures better).

## Deferred Ideas

- z-score / score-normalized weighted fusion (RRF chosen instead).
- Strength-ranked third RRF list (`rankStrengthWeight`) — stays dark at 0.
- Reranker over fused top-k (research showed it hurt; measure first).
- DEO-style negation-aware query rewrite.
- Answerer-V2 / abstention prompt (uncommitted harness diff) — separate answer-quality concern.
