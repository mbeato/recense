---
phase: 26-retrieval-embedding-fix
plan: "07"
subsystem: consolidation
tags: [judge, judge-miss, belief-correction, reconsolidation, restatement]

requires:
  - phase: 26-retrieval-embedding-fix
    provides: "26-06 judge-replay verdict: judge-miss dominant (20/30), pe-escape=0; fix target = src/model/judge.ts"

provides:
  - "src/model/judge.ts — updated RELATION_GUIDANCE + JUDGE_PROMPT_PREFIX + JUDGE_BATCH_PROMPT_PREFIX so same-belief restatements route to confirm/contradict instead of unrelated/extend"

affects: [26-08-harness-validation]

tech-stack:
  added: []
  patterns:
    - "RELATION_GUIDANCE const extracted from prompt so both single and batch prompts share identical classification text"
    - "Unit tests capture live prompt via AnthropicJudge.forTest mock client to verify guidance injection"

key-files:
  modified:
    - src/model/judge.ts
    - tests/judge.test.ts

key-decisions:
  - "Fix target confirmed as judge prompt (path A) — 26-06 verdict: judge-miss=20, pe-escape=0; src/lib/config.ts and update-decision.ts UNCHANGED (D-02 isolate-driven)"
  - "RELATION_GUIDANCE const extracted: defines confirm/extend/contradict/unrelated boundaries with key decision rules; injected into both JUDGE_PROMPT_PREFIX and JUDGE_BATCH_PROMPT_PREFIX"
  - "extend boundary clarified: only genuinely additive new dimension absent from candidate; update/qualification of same assertion = contradict"
  - "confirm boundary clarified: same core belief in different words qualifies; meaning/intent judged, not word-for-word match"
  - "unrelated boundary clarified: different specific instances of shared schema (different plan files, sessions, entities) = unrelated even with high structural similarity"
  - "contradicted_ids candidate-set filter (T-UE6-02), order-swap consistency check (chooseConsistentVerdict), and SAFE_VERDICT fallback all preserved unchanged"
  - "Paid validation harness (replay-ku-harness.cjs) DEFERRED to orchestrator checkpoint — cost-gated (D-03)"

requirements-completed: []

duration: 30min
completed: 2026-06-18
---

# Phase 26 Plan 07: Judge-Miss Fix Summary

**Minimal edit to `src/model/judge.ts` prompt so same-belief restatements classify as confirm/contradict instead of unrelated/extend; all guards preserved; 89 unit tests pass**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-06-18
- **Completed:** 2026-06-18
- **Tasks:** 1 (Task 2 is a human-verify checkpoint, deferred)
- **Files modified:** 2

## Accomplishments

- `src/model/judge.ts`: added `RELATION_GUIDANCE` const with clarified classification boundaries; injected into both `JUDGE_PROMPT_PREFIX` (single-claim) and `JUDGE_BATCH_PROMPT_PREFIX` (batch). The three key fixes:
  1. `confirm` — explicitly covers paraphrases and restatements (same meaning, different words)
  2. `contradict` — covers updates, corrections, qualifications, and supersessions of the same subject-predicate (previously falling into `extend`)
  3. `extend` — narrowed to genuinely additive new dimensions absent from the candidate (not requalifications)
  4. `unrelated` — clarified that structural similarity is insufficient; different specific instances of a shared schema (different plan files, sessions, entities) remain `unrelated`
- `tests/judge.test.ts`: new `26-07 judge-miss fix` describe block (7 tests):
  - Prompt captures via `AnthropicJudge.forTest` mock verify guidance text is present in single-claim and batch prompts
  - Confirms `confirm` verdict parses correctly → no new mint (routes to strengthen)
  - Confirms `contradict` verdict with both orderings agreeing → `chooseConsistentVerdict` returns `contradict` (routes to reconcile/tombstone + prev_value)
  - Regression guard: `unrelated` verdict parses correctly with no `contradicted_ids` → consolidator does NOT tombstone (T-26-12 over-tombstoning guard)

## Task Commits

1. **Task 1: Apply the 26-06-implicated fix** — see commit below

## Files Created/Modified

- `/Users/vtx/brain-memory/src/model/judge.ts` — RELATION_GUIDANCE const + updated JUDGE_PROMPT_PREFIX + JUDGE_BATCH_PROMPT_PREFIX (prompt text only; all parsing/validation/guard code unchanged)
- `/Users/vtx/brain-memory/tests/judge.test.ts` — new describe block `26-07 judge-miss fix: prompt contains updated relation guidance` (7 new tests)

## Decisions Made

- **Path A (judge prompt) confirmed** by 26-06 verdict (judge-miss=20, pe-escape=0). `src/lib/config.ts` and `src/consolidation/update-decision.ts` UNCHANGED per D-02 isolate-driven constraint.
- **RELATION_GUIDANCE extracted as a const**: avoids the two prompt strings drifting apart; both single and batch prompts always inject the same classification guidance.
- **Key decision rules appended to guidance**: four numbered rules (same-subject+same-assertion → confirm; same-subject+updated → contradict; same-subject+additive → extend; different-subject → unrelated) make the boundary explicit and model-actionable.

## Deviations from Plan

None. Plan executed exactly as written (path A only, surgical prompt edit, guards preserved).

## DEFERRED: Paid Validation Harness (Task 2 — Checkpoint)

The replay-ku-harness.cjs validation run (EVAL-02 belief-correction >= 84.6%, duplicate-mint count reduction, over-tombstoning spot-check) is DEFERRED to the orchestrator's blocking human-verify checkpoint per the plan.

Cost gate: default = free local judge stack (D-03); headless/API = opt-in with $ quote + `--setting-sources project`.

Run command when approved:
```
npm run build && node scripts/eval/replay-ku-harness.cjs --out scripts/eval/results/replay-ku-after-fix.json
```
(RECENSE_ENABLE_JUDGE_BATCH must remain unset — per-claim validated baseline, batching regressed 84.6%→53.8%)

## Known Stubs

None. The prompt change is wired directly into the live judge path (`JUDGE_PROMPT_PREFIX`, `JUDGE_BATCH_PROMPT_PREFIX`). No placeholder text, no hardcoded empty values.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes. The edit is prompt-text-only within existing seams. T-26-12 (over-tombstoning) mitigated by regression unit test. T-26-15 (batching regression) mitigated: `RECENSE_ENABLE_JUDGE_BATCH` remains OFF.

## Self-Check: PASSED

- [x] `src/model/judge.ts` modified (RELATION_GUIDANCE + prompt update)
- [x] `src/lib/config.ts` UNCHANGED (confirmed: 0 diff lines)
- [x] `unrelatedSimilarityThreshold` value unchanged (confirmed: 0 grep hits in diff)
- [x] `src/consolidation/` tombstone/prev_value logic unchanged (confirmed: 0 diff lines)
- [x] `npm run build` clean
- [x] `npx vitest run tests/judge.test.ts tests/update-decision.test.ts` — 89 tests passed
- [x] New tests: restatement-confirm parses correctly (no mint path), contradict both-agree (reconcile path), distinct-pair-unrelated (no over-tombstoning, T-26-12)
- [x] SUMMARY.md created

## VALIDATION + REVERT — 2026-06-18 (orchestrator): RETR-02 is a DEAD-END

The Task-1 fix (commit 98d3683) was validated on the 26-06 judge-replay (30 surfaced pairs) and **failed**:

| run | judge-miss | correct |
|---|---|---|
| claude-headless BEFORE | 20 | 10 |
| claude-headless AFTER (fix) | 19 | 11 |
| local 35b temp-0 BEFORE | 18 | 12 |
| local 35b temp-0 AFTER (fix) | 20 | 10 |

Pair-aligned (29 common pairs, deterministic local 35b): **2 improved, 3 regressed, 24 unchanged → net −1.** claude-headless added noise (non-deterministic, no temp-0); local 35b at temp-0 confirmed the fix is a wash / slightly net-negative.

**Root insight (hand-labeled the 18 baseline "miss" pairs):** the "judge-miss=20" metric **over-counts**. The flagged pairs are NOT same-belief restatements being minted as dups — they are distinct-but-structurally-similar facts where the judge's `unrelated`/`extend` is **correct**: `24.x-PLAN.md → decision D-xx` mappings (different plan files / different decisions), per-task command-output paths (also self-ingestion pollution the filter missed), and same-subject/different-attribute pairs ("serve returns HTTP 000" vs "serve requires Bearer token"). 24/29 stayed put under a substantial prompt rewrite because the judge already holds a firm (usually correct) view.

**Disposition: REVERTED.** `git revert 98d3683` → commit **c3becc3** restored the empirically-validated `judge.ts`; rebuilt; 59 judge tests green. The broadened `contradict` definition was also an over-tombstoning hazard ([[judge-must-be-empirically-validated]]) — another reason not to ship it.

**RETR-02 outcome:** the judge prompt is NOT the lever, and PE-routing was exonerated (0 pe-escape in 26-06). The real duplicate problem is exact-dup accumulation, handled by RETR-03 (26-08). The expensive full-KU harness run was deliberately NOT spent — the cheap proxy already showed the fix doesn't help. RETR-02 is a documented dead-end, not a silent failure.

---
*Phase: 26-retrieval-embedding-fix*
*Completed: 2026-06-18 (Task 1 reverted; RETR-02 dead-end documented)*
