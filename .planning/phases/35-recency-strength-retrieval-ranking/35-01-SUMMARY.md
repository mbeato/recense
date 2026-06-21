---
phase: 35-recency-strength-retrieval-ranking
plan: 01
subsystem: retrieval
tags: [rrfFuse, hybridTopk, effectiveStrength, RRF, strength-ranking, dark-default]

# Dependency graph
requires:
  - phase: 26-retrieval-embedding-fix
    provides: cosine+BM25 hybrid retrieval via rrfFuse + hybridTopk
  - phase: decay
    provides: effectiveStrength pure computation in StrengthDecayManager
provides:
  - rrfFuse with optional per-list weights (backward compatible, omit = all weights 1)
  - hybridTopk strength-ranked third RRF list, pool-only (D-02), tombstone-excluded (D-10), pure effective_s
  - rankStrengthWeight config knob (default 0, dark) in EngineConfig + DEFAULT_CONFIG
  - retrieveRanked threads rankStrengthWeight into hybridTopk on the cue-based branch only (D-08)
  - effectiveStrength exported as module-level pure helper from decay.ts (one-place-math rule)
affects:
  - 35-02 (eval sweep — RANK-02 measurement consumes this mechanism)
  - any future phase touching hybridTopk or retrieveRanked

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "TDD RED/GREEN for each behavior-adding task"
    - "rrfFuse per-list weights via optional weights?: number[] param (index-based, defaults to 1)"
    - "json_each prepared statement for pool-scoped bulk DB lookup (mirrors stmtLatestSupportTs pattern)"
    - "module-level pure helper delegated-to by instance method (one-place-math invariant)"

key-files:
  created: []
  modified:
    - src/retrieval/topk.ts
    - src/strength/decay.ts
    - src/lib/config.ts
    - src/retrieval/engine.ts
    - tests/fts-retrieval.test.ts

key-decisions:
  - "T2 test weight changed from w=0.5 to w=2.0 — w=0.5 is mathematically insufficient to overcome a rank-0 cosine lead with k=60 (0.5/61 < 1/61 - 1/62 = ~0.00026 difference); w=2.0 gives 2/61+1/62 vs 1/61+2/62 → high_strength wins. Math comment added to test."
  - "effectiveStrength exported as module-level function; instance method delegates to it — keeps existing engine.ts:246 caller working without change"
  - "stmtPoolStrength uses json_each(?) with JSON.stringify(poolIds) — exact same pattern as stmtLatestSupportTs in engine.ts"
  - "materializeDecay is a write-path method and MUST NOT be called from the retrieval path (Pitfall 4 / D-43 self-confirmation guard)"

patterns-established:
  - "Pool-scoped strength lookup: assemble pool first from cosine+BM25, then json_each for s/last_access — never query all nodes for ranking"
  - "Dark-default: new ranking knobs ship at weight 0 (rrfFuse, hybridTopk, rankStrengthWeight all default to no-op)"
  - "cosineScoreMap output map preserved verbatim — the strength list only changes ORDER, never the returned cosine score"

requirements-completed: [RANK-01]

# Metrics
duration: 7min
completed: 2026-06-21
---

# Phase 35 Plan 01: Strength-Fusion Mechanism (RANK-01) Summary

**LLM-free strength/recency term fused into cue-based RRF ranking via a pool-only, tombstone-excluded third weighted list — dark by default (w=0) so merge is byte-identical to today's ranking**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-06-21T02:00:31Z
- **Completed:** 2026-06-21T02:07:10Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments

- Extended `rrfFuse` with optional `weights?: number[]` param — backward compatible, omitted/1 = current behavior; closes the mechanical gap to add a weighted third list
- Built strength-list assembly in `hybridTopk`: pool-only (D-02) via `json_each` prepared statement, pure `effectiveStrength` (no inline math re-derivation), tombstone-excluded (D-10 inherited from source queries), no write-back (D-43 self-confirmation guard)
- Added `rankStrengthWeight: 0` to EngineConfig interface and DEFAULT_CONFIG; wired through `retrieveRanked` on the `queryText` branch only (D-08)
- Exported `effectiveStrength` as module-level pure helper from decay.ts — instance method delegates to it; `topk.ts` contains zero `Math.exp(-` expressions (one-place-math rule)
- Full test coverage: T1 (w=0 regression), T2 (weighted reorder), T3 (D-02 pool enforcement), T4 (hybridTopk w=0 regression), T5 (D-10 tombstone exclusion), no-self-strengthen; all pass

## Task Commits

1. **Task 1: Extend rrfFuse with optional per-list weight + T1/T2 tests** - `34d5ba3` (feat)
2. **Task 2: Strength-list assembly in hybridTopk + effectiveStrength module export + T3/T4/T5/no-self-strengthen** - `df47658` (feat)
3. **Task 3: Add rankStrengthWeight knob + wire through retrieveRanked** - `daa5548` (feat)

## Files Created/Modified

- `src/retrieval/topk.ts` — rrfFuse weights param; hybridTopk strengthWeight/nowMs/lambda params + stmtPoolStrength; imports effectiveStrength from decay.ts
- `src/strength/decay.ts` — effectiveStrength exported as module-level pure helper; instance method delegates to it
- `src/lib/config.ts` — rankStrengthWeight: number in EngineConfig interface + rankStrengthWeight: 0 in DEFAULT_CONFIG
- `src/retrieval/engine.ts` — retrieveRanked passes rankStrengthWeight/nowMs/lambda to hybridTopk on the queryText branch only
- `tests/fts-retrieval.test.ts` — T1/T2 (rrfFuse weighted), T3/T4/T5/no-self-strengthen (hybridTopk strength); all 25 tests pass

## Decisions Made

- **T2 test weight changed from w=0.5 to w=2.0** (Rule 1 - Bug fix during RED/GREEN): w=0.5 is mathematically insufficient to flip the order with k=60 — the cosine rank-0 advantage (~1/61) exceeds a half-weight rank-0 strength bonus (0.5/61) minus rank-1 cosine (1/62). w=2.0 gives high_strength = 1/62 + 2/61 ≈ 0.0489 vs low_strength = 1/61 + 2/62 ≈ 0.0480 — correct flip. Math comment added to test.
- **effectiveStrength as module-level function**: enables import into topk.ts without a StrengthDecayManager instance; instance method delegates so existing engine.ts callers are unchanged
- **stmtPoolStrength SQL**: `SELECT id, s, last_access FROM node WHERE id IN (SELECT value FROM json_each(?))` — mirrors stmtLatestSupportTs pattern exactly

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] T2 test weight corrected from w=0.5 to w=2.0**
- **Found during:** Task 1 (GREEN phase)
- **Issue:** The test used w=0.5 but the math shows this weight is insufficient to overcome the rank-0 cosine advantage with k=60. Test failed with expected 'high_strength' received 'low_strength'.
- **Fix:** Changed test weight to w=2.0 and added a math comment explaining why (high_strength = 1/62 + 2/61 > 1/61 + 2/62 = low_strength). The implementation is correct; the test's chosen weight was wrong.
- **Files modified:** tests/fts-retrieval.test.ts
- **Verification:** T2 passes with w=2.0; T1 still passes
- **Committed in:** 34d5ba3 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 — bug in test weight math)
**Impact on plan:** Minor fix to the test's chosen weight value. The mechanism and dark-default invariant are unchanged. No scope creep.

## Issues Encountered

None — implementation matched the research/plan exactly. The json_each pattern, effectiveStrength sharing, and cosineScoreMap preservation all worked as designed.

## Threat Surface Scan

No new threat surface introduced beyond what the plan's threat model covers:
- T-35-01 (Tampering): enforced — `grep -n "materializeDecay" topk.ts` shows only a comment (no call); `grep -c "Math.exp(-" topk.ts` returns 0; no-self-strengthen test passes
- T-35-02 (SQLi): enforced — stmtPoolStrength uses parameterized json_each; pool ids are internal UUIDs from scan results
- T-35-03 (Info disclosure): enforced — D-02 pool-only constraint active; T3 test confirms off-pool high-strength node does not appear

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- RANK-01 mechanism merged and dark by default — ready for Phase 35 Plan 02 (eval sweep + KU harness queryText fix + RANK-02 measurement)
- `rankStrengthWeight` can be raised from 0 to the eval-winning value after Plan 02 confirms a win
- KU harness still calls `retrieveRanked` without queryText (routes through pure cosine) — Plan 02 Task 1 must fix this before the sweep can measure the strength fusion effect

---
*Phase: 35-recency-strength-retrieval-ranking*
*Completed: 2026-06-21*
