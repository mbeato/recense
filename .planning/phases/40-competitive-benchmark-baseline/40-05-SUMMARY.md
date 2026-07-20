---
phase: 40-competitive-benchmark-baseline
plan: 05
status: complete
requirement: BENCH-02
date: 2026-06-24
---

# Plan 40-05 Summary — Operator-Gated Baseline Run

Fired the D-01 cost probe (HARD GATE), ran the official LoCoMo-10 baseline against the frozen v7.0 SUT, measured live + synthetic latency, and wrote the BENCH-02 baseline document.

## What was delivered

- **`40-BASELINE.md`** — the BENCH-02 baseline on all three axes (accuracy J + R@K, latency p50/p95 live + synthetic curve, token/cost with subscription vs direct-$ separated), the D-10 v7.0 config snapshot, the mem0 66.88% comparator, and reproduction commands.
- **`scripts/eval/live-latency.cjs`** — new D-06a tool: read-only live-brain `topk` p50/p95 timer (no equivalent existed; `latency-curve.cjs` is synthetic-only).
- Result files (gitignored, local): `scripts/eval/results/locomo-d41d5c8.json`, `…/locomo-latency-curve-d41d5c8.json`.

## Headline numbers (v7.0, commit d41d5c8)

- **Accuracy:** J = 86.0% (lenient mem0 judge — see caveat); R@5 = 77.3%, R@10 = 82.2%; 1,540 scoreable Q (cat-5 excluded).
- **Latency:** live brain (~11.3k nodes) p50 = 45 ms / p95 = 46 ms; synthetic 1k→20k = 4 ms→87 ms p50. Retrieval-only, LLM-free.
- **Cost:** answer-gen ~285 tok/QA (subscription, retail-equiv); scorer + embeddings ~$0.2 direct-$; full run 7.37 hrs wall-clock.

## Tasks

| # | Task | Outcome |
|---|---|---|
| 1 | D-01 cost probe (HARD GATE) | Ran probe on conv[0]; measured answer-gen $0.08 retail-equiv; operator confirmed `/usage` and approved full run |
| 2 | Official baseline on v7.0 SUT | 10/10 conversations, 1,540 hypotheses, 0 errors; scored J=86.0%; live + synthetic latency captured |
| 3 | Write `40-BASELINE.md` | Written; passes automated content checks |

## Deviations / decisions (operator-gated)

1. **Answer-gen parallelization (`b3538f7`, perf fix).** The probe revealed per-QA `claude -p` answer calls were serial (~10–30 s cold-start each → ~10–20 hr full run). Wrapped the QA loop in the existing `runBoundedPool` (concurrency 6, `RECENSE_ANSWER_CONCURRENCY`-overridable). Answers stay subscription-billed; only wall-clock improved. Operator chose "keep claude -p, parallelize" over direct-API.
2. **SUT freeze = TRUE v7.0 (not HEAD).** Discovered Phase 39.2's corpus-promotion + doc-graph machinery had been wired into `runConsolidation` *after* the v7.0 tag — running from HEAD would have measured v7.0 + 39.2. Operator chose "build & run true v7.0": detached worktree at `d41d5c8`, symlinked deps, built the v7.0 engine, ran the Phase-40 harness against it (verified API-compatible: identical `runConsolidation` signature, all imports present). The core extract→node→`topk` path is unchanged between v7.0 and HEAD.
3. **LoCoMo dataset re-acquired.** `locomo10.json` (gitignored, CC BY-NC) was lost with the 40-01 worktree; re-cloned from `github.com/snap-research/locomo` and re-verified empirically (1,986 total / 446 cat-5 / 1,540 scoreable — matches 40-01).

## Anti-pattern / honesty notes (no-inflated-metrics)

- **J = 86.0% is NOT defensible as "we beat mem0 by 19 points."** The mem0 Appendix-A judge is deliberately lenient ("same topic = CORRECT"): 322/474 (68%) hedged non-answers judged CORRECT; multi-hop's 95.4% is a leniency artifact. The baseline records J with this caveat prominent and frames the mem0 gap as suggestive, not verified. **R@5/R@10 is the trustworthy memory-quality signal.**
- **Instrumentation gap:** `--run` does not tally subscription consolidation tokens (only `--probe` does) — the per-write cost in the baseline is an estimate, not a measured full-run total. Carry into Phase 41.
- **Candidate follow-up:** answer-gen drops counting/aggregation questions even when retrieval hits — a possible v8.0 retrieval/answer item *if* the data justifies it.

## Key files

- created: `.planning/phases/40-competitive-benchmark-baseline/40-BASELINE.md`
- created: `scripts/eval/live-latency.cjs`
- changed (prereq, separate commit `b3538f7`): `scripts/eval/locomo-harness.cjs`

## Self-Check: PASSED

- [x] D-01 probe ran + operator `/usage` confirmation before any full run
- [x] Official run on v7.0-tagged SUT (`d41d5c8`); config snapshot + sut_commit in result JSON
- [x] Live-brain p50/p95 recorded (retrieval-only)
- [x] `40-BASELINE.md` records J + R@5/R@10 + latency + token cost (subscription vs direct-$ separated); passes automated checks
