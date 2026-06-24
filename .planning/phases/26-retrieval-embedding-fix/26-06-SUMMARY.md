---
phase: 26-retrieval-embedding-fix
plan: "06"
subsystem: eval
tags: [judge, pe-routing, near-dup, replay, consolidation]

requires:
  - phase: 26-retrieval-embedding-fix
    provides: "V3 diagnosis surfacing ~30 near-dup fact pairs (cosine 0.7–0.97) that cleared the 0.3 candidate gate but were minted as separate nodes"

provides:
  - "scripts/eval/judge-replay-isolate.cjs — cost-gated judge-replay probe over surfaced near-dup pairs; splits failure into judge-miss vs pe-escape buckets; names 26-07 fix target"

affects: [26-07-fix]

tech-stack:
  added: []
  patterns:
    - "Eval scripts follow diagnose-claim-path-v3.cjs: readonly DB open, stored-vector NN scan reuse, dist/ module requires, arg parsing via argv.indexOf"
    - "Pollution exclusion pattern: POLLUTION_RE regex drops SUBCHECK_OK / exit code 0 / completed with status before judging (D-05)"

key-files:
  created:
    - scripts/eval/judge-replay-isolate.cjs

key-decisions:
  - "Script is built + automated-verify-passing; real ~30-pair judge run DEFERRED to orchestrator cost checkpoint"
  - "Free local judge stack is the default per D-03 (resolveProviderOverlay default); no API calls in automated verify"
  - "Resistance computed inline (pure math: effectiveStrengthInline * c) — avoids StrengthDecayManager instantiation which requires a writable DB handle"
  - "Judge instantiated via AnthropicJudge(judgeConfig) directly — matches the seam the consolidator uses"

requirements-completed: [RETR-02]

duration: 25min
completed: 2026-06-18
---

# Phase 26 Plan 06: Judge-Replay Isolate Summary

**judge-replay-isolate.cjs built and syntax-verified; runs AnthropicJudge over V3 near-dup pairs with pollution filter, recomputes routeContradiction per pair, and outputs judge-miss vs pe-escape bucket counts + 26-07 fix target to JSON**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-06-18T~10:00Z
- **Completed:** 2026-06-18T~10:25Z
- **Tasks:** 1 built (real judge run DEFERRED — see below)
- **Files modified:** 1

## Accomplishments

- `scripts/eval/judge-replay-isolate.cjs` created: opens live DB read-only, runs V3 NN scan (stored vectors, no re-embed), applies pollution exclusion, invokes `AnthropicJudge` per pair, recomputes `routeContradiction(magnitude, resistance, DEFAULT_CONFIG)`, classifies each pair into `judge-miss` / `pe-escape` / `correct`, and writes verdict JSON with dominant failure path + fix target.
- All five acceptance criteria pass: `node -c` syntax OK; `readonly: true` present; `routeContradiction` present; `judge-miss`/`pe-escape` bucket labels present; `SUBCHECK_OK`/`exit code`/`pollut` exclusion present.
- No src/ files modified; no DB writes; no npm installs.

## Task Commits

1. **Task 1: Build judge-replay-isolate.cjs** — see final commit hash below

**Plan metadata:** see final commit

## Files Created/Modified

- `/Users/vtx/brain-memory/scripts/eval/judge-replay-isolate.cjs` — Judge-replay probe: readonly DB open, NN scan, pollution filter, AnthropicJudge per pair, routeContradiction recompute, bucket tabulation, JSON output to `scripts/eval/results/judge-replay-isolate.json`

## Decisions Made

- **Inline effectiveStrength** rather than instantiating `StrengthDecayManager`: the decay function is pure math (`s * exp(-lambda * deltaDays)`). Instantiating the manager would require a DB handle (it has a writable prepare statement internally); the inline is correct and avoids that coupling.
- **Direct `AnthropicJudge(judgeConfig)` constructor**: matches how `DefaultModelProvider` wires the judge internally. Cheaper than instantiating the full provider stack which also boots an extractor.
- **`resolveProviderOverlay(process.env, 'RECENSE_JUDGE_PROVIDER')` default = `local`**: per D-03, free local 35b stack is the default. Headless/API is opt-in via `RECENSE_JUDGE_PROVIDER=claude-headless` and explicitly warned about the self-ingestion loop.

## Deviations from Plan

### Pre-existing Issue (out of scope, logged)

**`npm run build` fails on `src/consolidation/fact-dedup.ts:418`** — `'fact_merge'` is not assignable to `ConsolidationEventType`. This is a pre-existing type error in an untracked file from prior work; it predates this plan and is NOT caused by `judge-replay-isolate.cjs`. The dist/ modules used by the script (judge.js, update-decision.js, config.js, run-sleep-pass.js, topk.js) are all present and up to date from the last successful build. The acceptance criteria's `node -c` and all grep checks pass; `npm run build` failure is pre-existing scope-boundary noise.

Logged to deferred items rather than fixed — fixing `fact-dedup.ts` type error is outside 26-06 scope.

---

**Total deviations:** 0 auto-fixed (pre-existing build error logged but out of scope)

## DEFERRED: Real Judge Run

**The real ~30-pair judge run is DEFERRED to the orchestrator's cost checkpoint.**

Per hard constraints: the script is built and automated-verify-passing. The actual judge invocation over live pairs incurs cost (local 35b latency or API billing for headless). The orchestrator must:

1. Approve the judge stack (local-free or headless-gated with $ quote)
2. If headless: run under `--setting-sources project` (D-03, [[claude-headless-self-ingestion-loop]])
3. Execute: `node scripts/eval/judge-replay-isolate.cjs [--dry-run for sanity first]`
4. Read `scripts/eval/results/judge-replay-isolate.json` for the dominant failure path (judge-miss vs pe-escape) → that drives the 26-07 fix

The `--dry-run` flag performs the NN scan + pollution filter with zero judge calls, useful for confirming pair selection before the paid run.

## Issues Encountered

- Pre-existing `npm run build` failure on `fact-dedup.ts` (untracked file from prior work) — does not affect this script; dist modules are all present.

## Real Judge Run — COMPLETED 2026-06-18 (orchestrator)

Cost checkpoint resolved: **claude-headless** Sonnet judge (Max subscription, keys stripped → $0 API; `--setting-sources project` → no self-ingestion loop). 30 pairs judged over the live DB (read-only, mtime unchanged).

**Verdict (`scripts/eval/results/judge-replay-isolate.json`):**

| bucket | count |
|--------|-------|
| judge-miss | **20 (dominant)** |
| pe-escape | 0 |
| correct | 10 |
| error/unknown | 0 |

- Candidate pairs: 151 total → 14 pollution-excluded → 137 clean → top 30 judged.
- High-similarity restatements (cos 0.97 / 0.94 / 0.91 / 0.91) all returned `unrelated` → judge-miss.
- `extend` mis-classifications dominate the 0.72–0.82 band; several `confirm` / `contradict→reconcile` were correct.

**DOMINANT FAILURE PATH: judge-miss.** PE-routing is exonerated (0 pe-escape).

**26-07 FIX TARGET: `src/model/judge.ts`** (prompt / classification) — the judge mis-classifies same-belief restatements as `unrelated`/`extend` when they should be `confirm` (identical belief, strengthen) or `contradict` (changed belief, reconcile). Do **NOT** touch the PE-routing constants in `src/lib/config.ts` (0 pe-escape) and do **NOT** touch `unrelatedSimilarityThreshold` (cosine lever, falsified D-01).

## Next Phase Readiness

- Verdict produced; 26-07 is unblocked and must edit `src/model/judge.ts` only (plus its test), preserving the contradicted_ids candidate-set filter + order-swap consistency check (no over-tombstoning).

---

## Self-Check: PASSED

- [x] `scripts/eval/judge-replay-isolate.cjs` exists
- [x] `node -c scripts/eval/judge-replay-isolate.cjs` → SYNTAX OK
- [x] `grep -c "readonly: true"` = 1
- [x] `grep -c "routeContradiction"` = 5
- [x] `grep -Eic "judge.?miss|pe.?escape"` = 18
- [x] `grep -Eic "SUBCHECK_OK|exit code|self.?ingest|pollut"` = 19
- [x] No src/ changes from this plan

---
*Phase: 26-retrieval-embedding-fix*
*Completed: 2026-06-18*
