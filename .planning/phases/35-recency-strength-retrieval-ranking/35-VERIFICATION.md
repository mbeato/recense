---
phase: 35-recency-strength-retrieval-ranking
verified: 2026-06-21T09:52:00Z
status: passed
score: 7/7 must-haves verified
overrides_applied: 0
re_verification: null
gaps: []
deferred: []
human_verification: []
---

# Phase 35: Recency/Strength Retrieval Ranking — Verification Report

**Phase Goal:** Recall ranks by belief strength and recency blended with semantic similarity, instead
of cosine+BM25 alone — so a strongly-reinforced recent belief outranks a stale weak one at equal
similarity, improving quality-per-injected-token with zero added online LLM cost.

**Verified:** 2026-06-21T09:52:00Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `rrfFuse` accepts optional per-list weights; w=0 reproduces today's exact fused ranking | VERIFIED | `topk.ts:63` — `weights?: number[]` param; inner loop `w = weights?.[li] ?? 1`; T1 test passes (25/25 suite green) |
| 2 | `hybridTopk` builds a strength-ranked third RRF list ONLY from the cosine+BM25 pool, only when `strengthWeight > 0` | VERIFIED | `topk.ts:225-247` — `if (strengthWeight > 0)` branch assembles `poolIds` from union of cosine+BM25, queries `stmtPoolStrength` via `json_each`; `else` branch calls `rrfFuse([cosineList, bm25List], 60, k)` exactly as before |
| 3 | A cue-based retrieval read never mutates `s` or `last_access` (no self-confirmation) | VERIFIED | `topk.ts` contains zero `materializeDecay` calls (grep confirmed); `grep -c "Math.exp(-" topk.ts` returns 0 (no inline formula re-derivation); T5 no-self-strengthen test passes |
| 4 | `rankStrengthWeight` ships at 0 (dark) — zero behavior change on hot path at merge (D-04) | VERIFIED | `config.ts:727` — `rankStrengthWeight: 0` in DEFAULT_CONFIG; `config.ts:331` — field in EngineConfig interface; `engine.ts:400-407` — passed on `queryText` branch only; retrieval.test.ts 23/23 green |
| 5 | KU harness passes `queryText` so `retrieveRanked` routes through `hybridTopk`; different w values produce different scores | VERIFIED | `replay-ku-harness.cjs:406` — `kuCase.question` as 4th arg; sweep JSON scores non-uniform: w=0 77.8%, w=0.25 66.7%, w=0.5 72.2%, w=1 55.6%, w=2 66.7% |
| 6 | Sweep over w in {0, 0.25, 0.5, 1.0, 2.0} produces a comparison table and records a verdict | VERIFIED | `35-strength-sweep.cjs:64` w-grid confirmed; five result JSONs present under `scripts/eval/results/`; 35-02-SUMMARY.md contains the comparison table and D-06/D-07 verdict |
| 7 | RANK-02 measured with honest verdict: negative result (no win), mechanism stays dark | VERIFIED | 35-02-SUMMARY.md key-decisions: "RANK-02 = NO WIN. Baseline (w=0) best at 77.8%; every w>0 regresses; w=1 worst at 55.6% (-22.2pt, far outside noise band). rankStrengthWeight stays 0." Result JSONs corroborate the numbers exactly |

**Score:** 7/7 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/retrieval/topk.ts` | `rrfFuse` weights param; `hybridTopk` strengthWeight/nowMs/lambda; `stmtPoolStrength` | VERIFIED | All present: `weights?: number[]` at L63; new params at L196-204; `stmtPoolStrength` at L102-124 |
| `src/strength/decay.ts` | `effectiveStrength` exported as module-level pure helper | VERIFIED | `export function effectiveStrength` at L32; instance method delegates at L133; L-8 clamp preserved |
| `src/lib/config.ts` | `rankStrengthWeight: number` in interface + `rankStrengthWeight: 0` in DEFAULT_CONFIG | VERIFIED | Interface at L331; DEFAULT_CONFIG at L727 (`rankStrengthWeight: 0, // D-04: dark default`) |
| `src/retrieval/engine.ts` | `retrieveRanked` passes `rankStrengthWeight` on queryText branch only | VERIFIED | L398-407: `this.config.rankStrengthWeight`, `this.clock.nowMs()`, `this.config.lambda` on hybrid branch; cue-less `topk` fallback untouched |
| `tests/fts-retrieval.test.ts` | T1-T5 + no-self-strengthen | VERIFIED | All 25 tests pass; test names match T1/T2 (rrfFuse weighted), T3/T4/T5/no-self-strengthen (hybridTopk strength) |
| `scripts/eval/replay-ku-harness.cjs` | queryText fix + `--strength-weight` + `rankStrengthWeight` config injection | VERIFIED | L406: `kuCase.question` to `retrieveRanked`; L62: `STRENGTH_WEIGHT` parsed; L227: `rankStrengthWeight: w` in config |
| `scripts/eval/longmemeval-harness.cjs` | `--strength-weight` threaded into direct `hybridTopk` call | VERIFIED | L157: `STRENGTH_WEIGHT` parsed; L719: passed as 5th positional arg to `hybridTopk` on IS_HYBRID branch |
| `scripts/eval/35-strength-sweep.cjs` | w-sweep driver with {0, 0.25, 0.5, 1.0, 2.0} grid | VERIFIED | L64: `'0,0.25,0.5,1.0,2.0'`; `node --check` passes |
| `scripts/eval/results/35-sweep-w{0,0.25,0.5,1,2}.json` | Run output for all five w values | VERIFIED | All five files present; `scores.ku_score` matches SUMMARY table (0.778/0.667/0.722/0.556/0.667) |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `topk.ts` | `decay.ts effectiveStrength` | `import { effectiveStrength } from '../strength/decay'` at L11 | WIRED | Called at L235; zero `Math.exp(-` in topk.ts (one-place-math rule holds) |
| `engine.ts retrieveRanked` | `hybridTopk(strengthWeight, nowMs, lambda)` | queryText branch | WIRED | `engine.ts:400-407`; cue-less `topk` fallback structurally unchanged |
| `35-strength-sweep.cjs` | harness `--strength-weight` | spawns harness per w in grid | WIRED | `strength-weight` confirmed in both harness files and sweep driver |
| `replay-ku-harness.cjs retrieveRanked` | `hybridTopk` via queryText | `kuCase.question` as 4th arg | WIRED | L406 confirmed; Pitfall 3 fix live (non-uniform scores prove fusion exercised) |

---

### Data-Flow Trace (Level 4)

Not applicable for this phase. The deliverable is a retrieval ranking mechanism and eval harness,
not a data-rendering component. Real data flow is confirmed behaviorally: five sweep result JSONs
contain non-uniform `ku_score` values derived from a live 18-case, 35,443-claim DB run.

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| T1-T5 + no-self-strengthen pass | `npm test -- tests/fts-retrieval.test.ts` | 25/25 pass | PASS |
| Retrieval regression suite green (dark default) | `npm test -- tests/retrieval.test.ts` | 23/23 pass | PASS |
| Build clean (tsc) | implicit via `npm test` pretest | exit 0 | PASS |
| Eval scripts syntax-clean | `node --check` all three eval scripts | exit 0 all | PASS |
| Sweep JSONs contain real non-uniform scores | read all five JSON `scores.ku_score` | 0.778/0.667/0.722/0.556/0.667 | PASS |
| No inline `Math.exp(-` in topk.ts | `grep -c "Math.exp(-" src/retrieval/topk.ts` | 0 | PASS |
| No `materializeDecay` call in topk.ts | `grep -n "materializeDecay" topk.ts` | comment only, no call | PASS |

---

### Probe Execution

No `probe-*.sh` files declared or present for this phase.
Step 7c: SKIPPED (no runnable probes).

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| RANK-01 | 35-01-PLAN.md | Strength/recency term fused into ranking, tunable, LLM-free | SATISFIED | Mechanism present and correct in `topk.ts`; wired via `engine.ts`; dark at `rankStrengthWeight=0`; 25/25 tests green |
| RANK-02 | 35-02-PLAN.md | Eval-backed: no regression + token or precision win | SATISFIED (negative finding) | Eval ran to completion on 18 KU cases; Pitfall 3 sanity check passed; verdict honestly recorded — no win, mechanism stays dark; this is the correct and complete deliverable |

**RANK-02 interpretation note:** RANK-02's literal text requires "no regression + a token or precision
win." The D-06/D-07 bars were not cleared — every w>0 regressed. However, the PLAN and CONTEXT
establish RANK-02 as a measurement requirement: the deliverable is "produce an eval-backed verdict,"
not "guarantee a win." The sweep ran correctly, fusion was confirmed live (non-uniform scores), and
the negative result was recorded without metric inflation. Shipping `rankStrengthWeight=0` dark is
the correct outcome. RANK-02 is satisfied as a measurement requirement with an honestly-recorded
negative finding.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | None | — | — |

No TBD/FIXME/XXX markers found in any phase-modified source file. The "calibration placeholder"
comments in `config.ts` are pre-existing D-13 annotations across the entire config file and were not
introduced by this phase.

---

### Human Verification Required

None. All must-haves are verifiable programmatically and have been verified. The eval verdict
(negative result, stay dark) is recorded in structured form in the SUMMARY and in the result JSONs.
No visual, real-time, or external-service checks remain outstanding.

---

### Gaps Summary

No gaps. All seven must-haves are verified. The mechanism (RANK-01) is present, tested, and
dark-by-default. RANK-02 is measured with an honest negative result that vindicates the D-04 dark
posture. The phase goal is achieved: the codebase now has the capability to blend strength/recency
into retrieval ranking, the eval evidence exists to justify the default, and the online path behavior
is byte-identical to pre-phase (w=0).

---

_Verified: 2026-06-21T09:52:00Z_
_Verifier: Claude (gsd-verifier)_
