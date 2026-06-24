---
phase: 40-competitive-benchmark-baseline
verified: 2026-06-23T00:00:00Z
status: passed
score: 8/8 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: none
  previous_score: n/a
---

# Phase 40: Competitive Benchmark Baseline — Verification Report

**Phase Goal:** Stand up an apples-to-apples competitive benchmark and record honest baselines on all three axes (accuracy / latency / token), so "at or above competitors" becomes a falsifiable target. Add LOCOMO alongside LongMemEval + KU replay; pin competitor numbers with sources AND methodology.
**Verified:** 2026-06-23
**Status:** PASSED
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | LOCOMO runs reproducibly via committed scripts (BENCH-01) | VERIFIED | `--dry-run`/`--probe`/`--run` gates at `locomo-harness.cjs:73-98`; dry-run exits 0 (zero-API); harness/scorer/latency/live-latency all git-tracked |
| 2 | LOCOMO accuracy score produced alongside existing harness (BENCH-01) | VERIFIED | `locomo-d41d5c8.json` has `scores.headline=0.8604`, `by_category`, `rAtK{r5,r10}`; LongMemEval + KU harnesses untouched |
| 3 | Test scaffolds pass (BENCH-01) | VERIFIED | `npx vitest run` 3 files / 12 tests all pass |
| 4 | Baseline records accuracy J + R@5/R@10 (BENCH-02) | VERIFIED | `40-BASELINE.md` §1: J=86.0%, R@5=77.3%, R@10=82.2% — match result JSON exactly |
| 5 | Baseline records latency p50/p95 live + synthetic (BENCH-02) | VERIFIED | §2: live brain ~11.3k nodes 45/46 ms; synthetic curve 1k→20k matches `locomo-latency-curve-d41d5c8.json` byte-for-byte |
| 6 | Baseline records token cost, subscription vs direct-API $ separated (BENCH-02) | VERIFIED | §3: subscription (~285 tok/QA, retail-equiv) kept distinct from direct-API $ (gpt-4o-mini scorer ~$0.08 + embeddings); instrumentation gap honestly flagged |
| 7 | SUT freeze (true v7.0, d41d5c8, excludes 39.2 corpus machinery) documented + config snapshot captured (BENCH-02) | VERIFIED | §intro + §4: `sut_commit: d41d5c8`, 15-knob D-10 config snapshot present in result JSON `meta.sut_config`; v7.0 tag exists (3252785) |
| 8 | Competitor numbers cited with source AND methodology caveat; no inflated/misread figures (BENCH-03) | VERIFIED | `40-COMPETITOR-TARGETS.md`: every figure has Source + Methodology note; Zep 84% marked DO-NOT-CITE (corrected 58.44%); MemPalace 96.6% = raw embedder not architecture; mem0 66.88% primary |

**Score:** 8/8 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `scripts/eval/locomo-harness.cjs` | --run/--probe/--dry-run gates, retrieval-only latency, R@K | VERIFIED | Committed; gates at L73-98; dry-run green |
| `scripts/eval/locomo-scorer.cjs` | mem0 Appendix-A lenient judge, cat-5 excluded | VERIFIED | Committed; verbatim "be generous / same topic = CORRECT" prompt L145-152; denominator excludes category 5 |
| `scripts/eval/latency-curve.cjs` | synthetic p50/p95 vs N | VERIFIED | Committed; produces the matching curve JSON |
| `scripts/eval/live-latency.cjs` | live-brain read-only topk p50/p95 (D-06a) | VERIFIED | Committed; new tool for live latency |
| `tests/locomo-*.test.ts` (3) | cat-5 + R@K + curve scaffolds | VERIFIED | All committed; 12 tests pass |
| `scripts/eval/results/locomo-d41d5c8.json` | headline J + config snapshot | VERIFIED (local, gitignored) | Present; J=0.8604, 1,540 Q, sut_commit + 15-knob config |
| `40-BASELINE.md` (BENCH-02) | all 3 axes + repro commands | VERIFIED | Committed; numbers trace to committed scripts + result file |
| `40-COMPETITOR-TARGETS.md` (BENCH-03) | cited + methodology-understood | VERIFIED | Committed; reliability table + per-number caveats |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `40-BASELINE.md` | `locomo-d41d5c8.json` | headline J + config snapshot | WIRED | J=86.0%, R@K, by-category, sut_commit, 15-knob config all match the result JSON |
| `40-BASELINE.md` §2 | `locomo-latency-curve-d41d5c8.json` | synthetic curve table | WIRED | Curve values byte-for-byte identical |
| harness `--run` gate | paid full run | explicit-flag refusal | WIRED | L78-98 refuse full run absent explicit flag (cost guard) |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Harness dry-run gate (zero-API, reproducible) | `node scripts/eval/locomo-harness.cjs --dry-run` | exit 0, 1 conv processed | PASS |
| Test suites | `npx vitest run tests/locomo-*.test.ts` | 12/12 pass | PASS |
| Result JSON integrity | node read of `locomo-d41d5c8.json` | scores + meta.sut_config (15 knobs) + sut_commit present | PASS |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| BENCH-01 | LOCOMO harness runs reproducibly on recense | SATISFIED | Gated harness committed; dry-run green; 12 tests pass; produces accuracy JSON |
| BENCH-02 | baseline accuracy/latency/token recorded | SATISFIED | `40-BASELINE.md` records all 3 axes + SUT freeze + D-10 config; numbers trace to committed scripts/result files |
| BENCH-03 | competitor targets cited AND methodology-understood; no inflated figures | SATISFIED | `40-COMPETITOR-TARGETS.md` cites every figure with source + methodology note; baseline frames J=86% as lenient-judge relative-only, explicitly forbids the "beats mem0 by 19 pts" claim |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | — | No TBD/FIXME/XXX in phase-modified scripts | — | Clean |

### Honesty Check (founder no-inflated-metrics hard-rule)

PASS — this is the most scrutinized aspect of the phase and it holds up:

- The baseline's headline J=86.0% is framed in a prominent "Read this before quoting any accuracy number" block: 322/474 (68%) hedged non-answers judged CORRECT; the score is "a same-topic-acceptance score under a deliberately generous judge," **relative-only**.
- The mem0 comparison is explicitly labeled "suggestive, NOT a clean head-to-head win" and the doc states verbatim: **"Do NOT claim 'recense beats mem0 by 19 points.'"** Grep for overclaim phrases (beats/crush/SOTA/best-in-class) found only that prohibition, never an actual claim.
- Multi-hop 95.4% is self-flagged as a judge-leniency artifact ("Do not cite multi-hop strength as a finding").
- R@5/R@10 is correctly identified as the trustworthy memory-quality signal, distinct from the lenient J.
- SUT freeze documented: true v7.0 (d41d5c8) built in an isolated worktree, deliberately excluding Phase 39.2 corpus machinery that had crept into runConsolidation at HEAD. v7.0 tag verified present.
- Competitor doc applies the same skepticism outward: Zep 84% DO-NOT-CITE (denominator-inflation, corrected 58.44%), MemPalace 96.6% = raw embedder not architecture, claude-mem ~10x = no accuracy benchmark.
- Instrumentation gap (`--run` does not tally consolidation tokens; per-write cost is an estimate) is honestly disclosed and carried to Phase 41.

### Human Verification Required

None. All claims are corroborated by committed code, passing tests, and the result/curve JSON files. The single un-reproducible item (exact full-run wall-clock + the operator `/usage` budget confirmation in 40-05 Task 1) is an operator-gated event documented in the SUMMARY; it does not affect any recorded metric and needs no re-verification.

### Gaps Summary

No gaps. All 8 must-haves verified, all 3 requirements SATISFIED, all key links WIRED, tests pass, dry-run green, no anti-patterns, and the honesty bar (the riskiest part of this phase) is cleared — the baseline document refuses to overclaim and the competitor doc is rigorously caveated. Minor notes (informational, not gaps): result/curve files are gitignored local-only by design (per `.gitignore`); the ROADMAP success criterion says "~7000-node brain" while the live brain measured ~11.3k nodes — the brain simply grew, the latency was correctly measured on the actual live brain and sits on the synthetic curve as expected.

---

_Verified: 2026-06-23_
_Verifier: Claude (gsd-verifier)_
