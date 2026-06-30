---
phase: 47-hybrid-retrieval-recall
plan: 02
subsystem: testing
tags: [locomo, retrieval, bm25, rrf, fts5, eval-harness, hybrid-fusion]

# Dependency graph
requires:
  - phase: 47-01
    provides: "config-exposed bm25FusionWeight knob threaded into hybridTopk/retrieveRanked (dark default 0)"
provides:
  - "LoCoMo harness hybrid arm (buildRetrievalEngine + retrieveRanked, floor=0) exercising the responder's real fusion+temporal path"
  - "retrieval-only mode (--retrieval-only) for LLM-free sweeps"
  - "deterministic tune/test split (--split) + in-harness per-category R@K + per-weight --sweep"
  - "held-out bm25FusionWeight selection: w* = 0 (null result, gate-validated)"
affects: [47-03, plan-03-shipping, hybrid-retrieval, locomo-eval]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Faithful eval arm: measure the responder's actual retrieveRanked path, not a bare CandidateRetriever.topk (D-08)"
    - "Consolidate-once / sweep-many: build each scratch brain once (LLM), sweep weights LLM-free over it (D-06)"
    - "Held-out hyperparameter selection: lock w* on TUNE only, validate on disjoint TEST"

key-files:
  created:
    - scripts/eval/results/bm25-weight-sweep.md
  modified:
    - scripts/eval/locomo-harness.cjs

key-decisions:
  - "w* = 0 (null result): pure cosine beats every positive BM25 fusion weight on TUNE R@5; no positive weight passes the per-category no-regression gate"
  - "Ship dark — Plan 03 keeps bm25FusionWeight=0 (live QA path stays pure cosine); the hybrid path is built but not enabled"
  - "Held-out temporal-reasoning signal (+11pt R@5 at w=0.25, n=35) recorded as a follow-up lead, NOT acted on (would be test-set overfitting + split-unstable)"

patterns-established:
  - "In-harness per-category R@K aggregation as the D-04 gate hook (replaces post-hoc JSONL aggregation)"
  - "Per-weight sweep over a once-built scratch brain keeps tuning LLM-free"

requirements-completed: [RETR-02, RETR-03, RETR-04]

# Metrics
duration: ~4h (dominated by 10 conversation consolidations: ~2h TUNE + ~2h TEST)
completed: 2026-06-29
---

# Phase 47: Hybrid Retrieval Recall — Plan 02 Summary

**Held-out sweep selects `w* = 0`: BM25 lexical fusion does not beat pure dense cosine on LoCoMo recall — ship hybrid dark.**

## Outcome (the number Plan 03 consumes)

- **`w* = 0`** — null result, gate-validated. Plan 03 should keep `DEFAULT_CONFIG.bm25FusionWeight = 0` (the dark default); the live QA retrieval path stays pure cosine.

## What was tested

Holding the cosine + temporal-sort + strength + stale-exclusion pipeline fixed, vary one knob — the RRF weight of the BM25 lexical ranked-list (`bm25FusionWeight`) — and measure session-level R@5/R@10 on LoCoMo. Grid: `{0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0}`. Selection on a deterministic 5/5 tune/test split; LLM-free retrieval (consolidate each scratch brain once, sweep weights over it).

## Gate verdict (D-04)

- **TUNE:** `argmax(R@5)` is **w=0** outright (88.2%). Every positive weight lowers overall R@5 **and** regresses single-hop + temporal-reasoning R@5. No positive weight passes the no-regression constraint → **w\* = 0**.
- **Held-out TEST validates w\*=0:** hybrid(0) ≡ cosine(0) (byte-identical, Plan 01), so R@5/R@10 ≥ cosine with no regression — gate passes trivially. Shipping w*=0 is correctness-neutral on the live path.
- **Honest twist (documented, not acted on):** on held-out TEST, w=0.25 *would* have improved overall R@5 (+1.0pt) and temporal-reasoning R@5 (+11.4pt: 60.0→71.4) — but it was not the TUNE winner, still regresses multi-hop R@10, and rests on n=35 (~4 QA). The TUNE/TEST splits disagree on whether hybrid helps → the signal is real-but-unstable at n=10 conversations. Selecting it would be test-set overfitting.

## Latency (RETR-04)

Hybrid `retrieveRanked` p50 = **2 ms**, p95 = 3 ms on per-conversation scratch brains (far under the ~45 ms live-brain budget). Caveat: scratch brains are small; since w*=0 ships byte-identical to cosine, live-path latency is unchanged from baseline. RETR-04 holds.

## Task Commits

1. **Task 1: Instrument the harness (hybrid arm, retrieval-only, tune/test split, per-category R@K, per-weight sweep)** — `32767fe` (feat). Answerer-V2 region (~lines 515-545) byte-unchanged (grep gate == 0).
2. **Task 2: Run the held-out sweep, lock w*, record gate + latency** — `73b4bb5` (feat). Wrote `scripts/eval/results/bm25-weight-sweep.md` with all measured numbers; human-verified `w*=0` at the blocking checkpoint.

## Files Created/Modified

- `scripts/eval/locomo-harness.cjs` — added hybrid arm via `buildRetrievalEngine` + `retrieveRanked(queryVec, TOP_K, 0, questionText)`, `--retrieval-only`, `--split tune|test|all`, in-harness per-category R@K, `--sweep` over a once-built brain.
- `scripts/eval/results/bm25-weight-sweep.md` — recorded TUNE sweep table, w* selection + constraint check, held-out TEST per-category table (cosine vs hybrid), p50/p95.

## Follow-up lead (not in scope)

If temporal-reasoning recall becomes a priority, re-test BM25 fusion against a **larger / temporal-weighted eval** before abandoning it — the n=10 LoCoMo split is underpowered for an effect this size, and the held-out temporal signal points in the theory-predicted direction (BM25 nails exact date/name tokens that dense cosine smears). Logged to recense.

## Self-Check: PASSED

- Harness exercises the responder's real fusion+temporal path (D-08). ✓
- Sweep LLM-free; tuned on TUNE, reported on TEST (D-05/D-06). ✓
- w* selected as argmax(R@5) under zero per-category regression → w*=0 (D-04). ✓
- Held-out gate satisfied (hybrid(0) ≡ cosine) or honest null recorded. ✓
- Retrieval p50 within budget (RETR-04). ✓
- bm25-weight-sweep.md records all measured numbers (no inflation). ✓
