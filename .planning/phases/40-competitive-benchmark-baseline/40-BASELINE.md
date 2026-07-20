---
phase: 40-competitive-benchmark-baseline
artifact: BASELINE
requirement: BENCH-02
sut_commit: d41d5c8
sut_tag: v7.0
judge_model: gpt-4o-mini
date: 2026-06-24
---

# LoCoMo-10 Baseline — recense v7.0 (BENCH-02)

The frozen v7.0 accuracy / latency / token baseline that gates v8.0 Phases 41–44.
Every recense number below is reproducible from a committed script + a local result file.
**SUT = the true v7.0 engine** (commit `d41d5c8`, the `v7.0` tag = "archive v7.0 milestone, Phases 35–39.1"), built and run in an isolated worktree. This deliberately **excludes Phase 39.2's corpus-promotion + doc-graph machinery**, which had been wired into `runConsolidation` after the v7.0 tag — running from `HEAD` would have measured v7.0 + 39.2, not v7.0. The core extract→node→`topk` path is identical between v7.0 and HEAD; only the corpus-doc layer differs.

---

## ⚠️ Read this before quoting any accuracy number

The headline **J score uses the verbatim mem0 Appendix-A LLM judge** (gpt-4o-mini, temp 0, max_tokens 10, single user message), whose prompt **explicitly instructs the judge to "be generous — same topic = CORRECT."** This is mem0's own published protocol (arXiv 2504.19413) — used so our J is comparable to mem0's published 66.88% on the *same* lenient basis.

**The judge is very lenient, by design:**
- **322 of 474 (68%) hedged / "I cannot determine …" non-answers were judged CORRECT** — they stay on-topic, so the judge passes them.
- **234 of 1,325 (18%) CORRECT answers had a retrieval session-miss** (the evidence session was not in top-5), i.e. judged correct without verified retrieval.

**Therefore J = 86.0% is NOT "86% of answers are factually correct."** It is a same-topic-acceptance score under a deliberately generous judge. It is only meaningful as a **relative** number against other systems scored with the **identical** judge — and even then the comparison to mem0 is **confounded** (see Comparison below). The judge-independent retrieval metric (R@K) is the more honest signal of memory quality.

---

## 1. Accuracy (BENCH-02 headline + diagnostics)

**Source:** `scripts/eval/results/locomo-d41d5c8.json` · 1,540 scoreable questions (category-5 adversarial excluded, 0 leaked) · judge `gpt-4o-mini`.

| Metric | Value | Notes |
|---|---|---|
| **Headline J (overall)** | **86.0%** | lenient mem0 Appendix-A judge — see warning above |
| R@5 (retrieval diagnostic) | 77.3% | session-level hit; **not** the headline |
| R@10 (retrieval diagnostic) | 82.2% | session-level hit |
| Questions scored | 1,540 | cat-5 excluded (matches 40-01 empirical count) |
| Judge parse failures | 30 / 1,540 (~2%) | counted as WRONG (deflates slightly) |

**By category (J / R@5):**

| Category | n | J | R@5 |
|---|---|---|---|
| multi-hop (cat 1) | 282 | **95.4%** | 83.3% |
| temporal (cat 2) | 321 | 90.3% | 78.2% |
| open-domain (cat 3) | 96 | 80.2% | 59.4% |
| single-hop (cat 4) | 841 | 81.9% | 76.9% |

> The multi-hop=95.4% result is an **artifact of judge leniency**, not evidence that recense excels at multi-hop. Multi-hop is the hardest LoCoMo category in the literature; the high score here is driven by on-topic-but-hedged answers being accepted (samples: *"there is no specific information about what Caroline researched"* → CORRECT). Do not cite multi-hop strength as a finding.

## 2. Latency (retrieval-only, K=10, LLM-free online path)

**D-06a — live brain** (`scripts/eval/live-latency.cjs`, read-only over the live `recense.db`):

| Nodes (embedded) | p50 | p95 | samples |
|---|---|---|---|
| ~11,315 (10,509 active) | **45 ms** | **46 ms** | 100 |

**D-06b — synthetic curve** (`scripts/eval/results/locomo-latency-curve-d41d5c8.json`, scratch DBs, never touches the live brain):

| N nodes | p50 | p95 |
|---|---|---|
| 1,000 | 4 ms | 6 ms |
| 2,000 | 7 ms | 9 ms |
| 5,000 | 21 ms | 23 ms |
| 9,000 | 38 ms | 40 ms |
| 15,000 | 65 ms | 71 ms |
| 20,000 | 87 ms | 107 ms |

Retrieval is an O(N) brute-force cosine scan; latency scales ~linearly with node count. The live brain (~11.3k nodes, 45 ms) sits on this curve between the 9k and 15k synthetic points. This is the **online** path — LLM-free; all LLM cost is offline (consolidation).

## 3. Token / cost (D-02 — subscription tokens kept SEPARATE from direct-API $)

**Subscription-billed (Haiku/Sonnet via `claude -p`, retail-$ translation only — marginal cash cost ~$0 against the Max plan):**
- **Per-recall (answer-gen):** measured in the D-01 probe = 43,319 tokens / 152 QA ≈ **285 tokens/QA** (29,087 in / 14,232 out) ≈ $0.08 retail-equiv per conversation → **~$0.81 retail-equiv** across all 1,540 answers.
- **Per-write (consolidation = Haiku extract + Sonnet judge):** **not instrumented in `--run`** (only `--probe` tallies tokens — see Instrumentation gap). Reference from `cost-benefit-probe.json`: ~$0.02 retail-equiv per episode-session → ~272 LoCoMo sessions ≈ **~$5 retail-equiv (rough; LoCoMo sessions are larger than the cost-benefit episodes).**

**Direct-API $ (real cash):**
- gpt-4o-mini scorer: 1,540 judgments × ~300 in / ~10 out ≈ **~$0.08**.
- OpenAI `text-embedding-3-small`: question + node embeddings ≈ **~$0.10–0.30**.

**Wall-clock (operational fact):** full 10-conversation run = **7.37 hrs** (consolidation-dominated, sequential per conversation; answer-gen pooled at concurrency 6). The probe-stage harness change `perf(40): pool per-QA answer-gen` (commit `b3538f7`) cut answer-gen from a ~10–20 hr projection.

> **Instrumentation gap (carry into Phase 41):** `--run` mode does not tally subscription consolidation tokens; only `--probe` does. The per-write cost above is an estimate, not a measured full-run total. If exact write-cost is needed, add a token ledger to `--run` or re-probe the median conversation.

## 4. SUT config snapshot (D-10) — frozen v7.0

`sut_commit: d41d5c8` · `engine_version: 0.1.0` · 15 knobs (from result `meta.sut_config`):

```json
{
  "openaiEmbedModel": "text-embedding-3-small", "embeddingDimensions": 1536,
  "claudeHeadlessExtractModel": "claude-haiku-4-5", "claudeHeadlessJudgeModel": "claude-sonnet-4-6",
  "consolSkipThreshold": 0.2, "consolSkipThresholdAssistant": 0.5,
  "rankStrengthWeight": 0, "rankedRetrievalK": 10, "rankedRetrievalFloor": 0.3,
  "candidateK": 5, "entityAnchorK": 5, "typedAnchorPoolK": 20,
  "injectionTokenBudget": 500, "insightSurfacingEnabled": false, "predicateGlossThreshold": 0.35
}
```

## 5. Comparison to competitors (BENCH-03 — cited, methodology-understood)

Primary comparator: **mem0 = 66.88% J** on LoCoMo (cited in `40-COMPETITOR-TARGETS.md`).

recense v7.0 scored **J = 86.0%** with mem0's *same* gpt-4o-mini Appendix-A judge. **This is suggestive, NOT a clean head-to-head win**, because:
1. **Answer-gen pipeline differs.** Our harness retrieves nodes and answers with Haiku; mem0's answer-generation setup differs. Our verbose on-topic Haiku answers may exploit the lenient "same-topic=CORRECT" judge *harder* than mem0's, inflating the gap.
2. **Judge leniency dominates the absolute level** (68% of non-answers accepted) — the level says more about the judge than the systems.
3. **Noise floor** (per `40-COMPETITOR-TARGETS.md`): differences **< 5–7 points are not interpretable**; corrupted-key + lenient-judge noise is large.

**Defensible claim:** *"On LoCoMo-10 under mem0's published Appendix-A judge, recense v7.0 scored 86.0% J (mem0 published 66.88%), but the absolute level reflects a deliberately lenient judge and our answer-gen pipeline differs from mem0's — treat the gap as encouraging, not a verified ranking."* **Do NOT claim "recense beats mem0 by 19 points."**

Also from `40-COMPETITOR-TARGETS.md`: Zep ~84% is denominator-inflated (corrected ~58.44%); MemPalace 96.6% is a raw embedder result, not an architecture. recense's retrieval-only latency definition differs from mem0's answer-gen-inclusive 91% latency claim.

## 6. Reproduction

```
# SUT: true v7.0 (corpus machinery excluded). Build in an isolated worktree:
git worktree add --detach /tmp/recense-v7 v7.0
cd /tmp/recense-v7 && ln -s <main>/node_modules node_modules && npx tsc
cp <main>/scripts/eval/locomo-*.cjs <main>/scripts/eval/latency-curve.cjs <main>/scripts/eval/live-latency.cjs scripts/eval/
cp <main>/scripts/eval/locomo10.json scripts/eval/   # CC BY-NC, gitignored; from github.com/snap-research/locomo
set -a; . ~/.config/recense/sleep.env; set +a

# Accuracy:
node scripts/eval/locomo-harness.cjs --run   --eval scripts/eval/locomo10.json --out scripts/eval/results/locomo-hypotheses.jsonl
node scripts/eval/locomo-scorer.cjs  --in scripts/eval/results/locomo-hypotheses.jsonl --out scripts/eval/results/locomo-d41d5c8.json

# Latency:
node scripts/eval/live-latency.cjs                                                 # D-06a live brain p50/p95
node scripts/eval/latency-curve.cjs --out scripts/eval/results/latency-curve-N.json # D-06b synthetic curve
```

Result files (gitignored, local-only per `.gitignore`): `scripts/eval/results/locomo-d41d5c8.json`, `scripts/eval/results/locomo-latency-curve-d41d5c8.json`.

## 7. Headline summary

| Axis | v7.0 baseline | Honest read |
|---|---|---|
| Accuracy (J, lenient judge) | **86.0%** | inflated by judge leniency; relative-only |
| Retrieval R@5 / R@10 | 77.3% / 82.2% | the trustworthy memory-quality signal |
| Live-brain latency (p50/p95, ~11.3k nodes) | **45 / 46 ms** | retrieval-only, LLM-free |
| Per-recall answer tokens | ~285 tok/QA (subscription) | measured (probe) |
| mem0 comparator | 66.88% J | same judge; gap suggestive, not verified |

**Candidate follow-up for v8.0:** answer-gen drops counting/aggregation questions even when retrieval hits (facts present, model won't tally) — a possible Phase-41 retrieval/answer item, *if* the by-category data justifies it over other gaps.
