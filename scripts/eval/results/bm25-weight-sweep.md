# BM25 Fusion Weight Sweep — Held-Out Selection (Phase 47, Plan 02)

**Date:** 2026-06-29
**Harness:** `scripts/eval/locomo-harness.cjs` (hybrid arm: `buildRetrievalEngine` + `retrieveRanked(queryVec, TOP_K, 0, questionText)`, floor=0 — the same fusion+temporal path the responder uses, D-08)
**Mode:** `--retrieval-only` (LLM-free retrieval; consolidation builds each scratch brain once, D-06)
**Metric:** session-level R@K (a retrieved top-K node's `[Session N]` hits the gold evidence session). Category 5 (adversarial) excluded from scoring.
**Grid:** `bm25FusionWeight ∈ {0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0}` (cosine-list weight fixed at 1.0; w=0 reproduces pure cosine, byte-identical per Plan 01).

## Deterministic tune/test split (D-05)

Conversations sorted by `sample_id` ascending; even sorted-index → TUNE, odd → TEST. Disjoint 5/5:

- **TUNE:** conv-26, conv-41, conv-43, conv-47, conv-49
- **TEST:** conv-30, conv-42, conv-44, conv-48, conv-50

Selection happens on TUNE only; TEST is held out and used only to validate the locked choice.

---

## TUNE sweep (selection set)

Baseline **w=0 (pure cosine)**: OVERALL R@5 = **88.2%**, R@10 = 92.8%.

| weight | overall R@5 | overall R@10 | single-hop R@5/R@10 | multi-hop R@5/R@10 | temporal R@5/R@10 | open-domain R@5/R@10 |
|--------|:-----------:|:------------:|:-------------------:|:------------------:|:-----------------:|:--------------------:|
| **0**  | **88.2%** | 92.8% | **93.4% / 96.0%** | **89.2% / 95.5%** | **73.8% / 80.3%** | **88.1% / 92.4%** |
| 0.25   | 86.5% | 93.4% | 89.4% / 96.7% | 89.2% / 93.0% | 70.5% / 80.3% | 86.9% / 94.3% |
| 0.5    | 85.8% | 92.5% | 89.4% / 96.0% | 89.2% / 91.7% | 67.2% / 78.7% | 85.9% / 93.6% |
| 0.75   | 85.8% | 92.4% | 88.7% / 96.0% | 89.8% / 91.1% | 67.2% / 78.7% | 85.9% / 93.6% |
| 1.0    | 86.2% | 92.0% | 88.1% / 96.7% | 89.8% / 91.7% | 68.9% / 78.7% | 86.6% / 92.4% |
| 1.5    | 84.0% | 88.8% | 86.1% / 95.4% | 89.2% / 90.4% | 65.6% / 72.1% | 84.0% / 88.3% |
| 2.0    | 83.5% | 89.0% | 85.4% / 95.4% | 88.5% / 90.4% | 67.2% / 72.1% | 83.3% / 88.5% |

(N per category on TUNE: single-hop 151, multi-hop 157, temporal 61, open-domain 419; total 788 scored QA.)

### Selection: w* = 0 (null result)

Rule: `w* = argmax(R@5)` on TUNE **subject to** no per-category R@5 or R@10 falling below the w=0 value.

- **Unconstrained argmax(R@5) on TUNE is already w=0** (88.2% beats every positive weight: 86.5 / 85.8 / 85.8 / 86.2 / 84.0 / 83.5).
- Every positive weight **also** regresses per-category — notably single-hop R@5 (93.4% → ≤89.4%) and **temporal-reasoning R@5** (73.8% → ≤70.5%), the exact category (the 9ea5eabc failure mode) hybrid was meant to *fix*.
- No positive weight satisfies the constraint. **w\* = 0** is the honest null-result outcome (recorded plainly; no inflated metric).

---

## Held-out TEST (validation set) — full grid

Baseline **w=0 (pure cosine)**: OVERALL R@5 = **81.3%**, R@10 = 86.8%.

| weight | overall R@5 | overall R@10 | single-hop R@5/R@10 | multi-hop R@5/R@10 | temporal R@5/R@10 | open-domain R@5/R@10 |
|--------|:-----------:|:------------:|:-------------------:|:------------------:|:-----------------:|:--------------------:|
| **0**  | **81.3%** | 86.8% | **85.5% / 90.8%** | **85.4% / 92.1%** | **60.0% / 74.3%** | **80.1% / 84.6%** |
| 0.25   | 82.3% | 87.8% | 85.5% / 91.6% | 85.4% / 90.9% | 71.4% / 77.1% | 81.0% / 86.3% |
| 0.5    | 80.9% | 87.5% | 84.0% / 92.4% | 82.3% / 89.6% | 71.4% / 74.3% | 80.1% / 86.3% |
| 0.75   | 81.3% | 87.6% | 83.2% / 92.4% | 83.5% / 89.6% | 71.4% / 74.3% | 80.6% / 86.5% |
| 1.0    | 81.3% | 87.6% | 84.7% / 94.7% | 83.5% / 87.8% | 68.6% / 77.1% | 80.3% / 86.3% |
| 1.5    | 79.8% | 85.1% | 83.2% / 91.6% | 81.7% / 86.6% | 68.6% / 71.4% | 78.9% / 83.6% |
| 2.0    | 79.7% | 85.1% | 83.2% / 91.6% | 81.7% / 86.6% | 68.6% / 71.4% | 78.7% / 83.6% |

(N per category on TEST: single-hop 131, multi-hop 164, temporal 35, open-domain 422; total 752 scored QA.)

### Gate verdict for the locked w* = 0

The plan's D-04 gate: on held-out TEST, hybrid(w*) R@5 **and** R@10 ≥ cosine(w=0), no per-category regression.

- With **w\* = 0**, hybrid(0) ≡ cosine(0) (byte-identical, Plan 01) → R@5/R@10 equal the baseline, no category regresses. **Gate PASSES trivially.** Shipping w*=0 is correctness-neutral on the live path.

### What the held-out data additionally reveals (honest finding — NOT acted on)

The TEST split **disagrees with TUNE**:

- On TEST, **w=0.25 would have improved** overall R@5 (+1.0pt: 81.3 → 82.3), overall R@10 (+1.0pt: 86.8 → 87.8), and **temporal-reasoning R@5 by +11.4pt** (60.0 → 71.4) — the category hybrid was designed to help.
- But w=0.25 still trips the no-regression gate on TEST too: **multi-hop R@10 regresses** 92.1 → 90.9 (−1.2pt).
- And w=0.25 was **not** the TUNE winner. Selecting it because it looks good on TEST is test-set overfitting — the exact data leakage the tune/test split exists to prevent.

**Interpretation:** the two 5-conversation subsamples disagree on whether BM25 fusion helps (TUNE: hurts everything; TEST: w=0.25 helps overall + temporal but regresses multi-hop R@10). The hybrid signal is **real but not stable** at n=10 conversations. The disciplined, non-overfit decision is the conservative **w\* = 0 (ship dark)**. The promising temporal-reasoning signal on held-out data is a follow-up lead, not a ship-now result.

---

## Latency (RETR-04)

Hybrid `retrieveRanked` call (excludes embed + answer), held-out TEST split, measured per-QA:

| metric | value |
|--------|:-----:|
| p50 | **2 ms** |
| p95 | 3 ms |
| p99 | 4 ms |
| max | 7 ms |

(n=752 TEST QA, 20 error-path records excluded.)

**Caveat (flagged per plan):** these are measured on small per-conversation **scratch** brains (hundreds of nodes each), not the ~45 ms live-brain budget baseline (which reflects a much larger graph). The relevant conclusion: hybrid fusion adds only a BM25 FTS lookup + score blend per query — negligible incremental cost — and since **w\*=0 ships byte-identical to cosine**, the live-path retrieval latency is unchanged from baseline. RETR-04 holds.

---

## Summary

- **w\* = 0** — null result. On the selection (TUNE) split, pure cosine beats every positive BM25 fusion weight on R@5 and no positive weight passes the per-category no-regression gate.
- **Held-out TEST validates shipping w\*=0** (hybrid(0) ≡ cosine, gate passes trivially).
- **Honest caveat:** held-out TEST shows w=0.25 *would* have helped overall recall and temporal-reasoning — but it was not the TUNE winner and still regresses multi-hop R@10, so selecting it would be overfitting. The hybrid signal is real but unstable at n=10; **do not ship a positive weight on this evidence.**
- **Latency** within budget (live path unchanged under w*=0).
- **Implication for Plan 03:** ship `bm25FusionWeight = 0` (dark default stays) — the live QA path remains pure cosine. The temporal-reasoning signal is a documented follow-up lead (consider a larger LoCoMo / multi-split eval before revisiting).
