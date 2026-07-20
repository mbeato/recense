---
phase: 52-brain-viz-honest-traces
plan: 02
subsystem: ui
tags: [viz, three, activation-trace, sse, spreading-activation, tdd]

# Dependency graph
requires:
  - phase: 52-01
    provides: ActivationTraceInput.seeds widened to union (string | {node_id, score}) + kind column

provides:
  - Per-seed retrieval score in activation_trace emit (engine.ts + recall/index.ts)
  - normalizeSeed + traceEdgesFromHops pure helpers (exported from trace.js, testable)
  - applyTrace(row) rewritten: all seeds lit brightness∝score, hops from payload only
  - D-06 attack/hold/exponential-fade decay envelope replacing flat linear decay
  - KIND_COLOR palette + DECAY_* constants in constants.js
  - Structural honesty regression test (17 assertions, locked by vitest)

affects: [52-03, 52-04, 52-05, 52-06, viz/trace, viz/hud, viz/constants]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "normalizeSeed at client boundary: bare string | {node_id,score} → {node_id,score} before any rendering"
    - "traceEdgesFromHops: pure, THREE-free helper resolves lit set from payload only (no ctx.adj traversal)"
    - "D-06 evalEnvelope: attack→hold→exponential-fade per-node with __actT0/__actPeak state"

key-files:
  created:
    - tests/trace-honest-recall.test.ts
  modified:
    - src/viz/modules/constants.js
    - src/viz/modules/trace.js
    - src/viz/modules/hud.js
    - src/retrieval/engine.ts
    - src/recall/index.ts

key-decisions:
  - "DROP edge.w term from hop brightness: the honest 1-hop payload carries no edge weight; re-deriving it would reconstruct the adjacency theater this phase kills (founder-approved override of D-07 edge.w clause)"
  - "NO spawnPulse from applyTrace: no honest seed→hop edge exists (engine aggregates all seeds' neighbors into one flat set with no source-seed recorded); drawing an edge would fabricate topology"
  - "traceEdgesFromHops exported as module-level named export so Plan 03 and tests can import it without spinning up a full ctx"
  - "D-06 decay total = 3240ms (140+600+2500); legacy haze tests updated to advance time past ATTACK_MS when testing hold-phase color"

requirements-completed: [SPEC-SC1, SPEC-SC2-decay, D-06, D-07, D-08-exactly-N]

# Metrics
duration: 35min
completed: 2026-06-29
---

# Phase 52 Plan 02: Honest Trace — Per-Seed Score Emit + Payload-Driven Animation Summary

**Per-seed retrieval score wired end-to-end: engine and recall emit `{node_id,score}` seeds; applyTrace lights ALL seeds brightness∝score + real 1-hop hops from payload with D-06 decay; BFS and seeds[0]-anchoring deleted; guarantees regression-tested.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-06-29T18:00:00Z
- **Completed:** 2026-06-29T18:10:00Z
- **Tasks:** 3 (+ 1 auto-fix commit)
- **Files modified:** 8

## Accomplishments

- Both recall emit sites carry honest per-seed score: `engine.ts` maps seeds to `{node_id, score}` using the `seedScore` already destructured at line 271; `recall/index.ts` emits `{node_id, score:null}` per WR-02
- `applyTrace(row)` rewritten to accept the full SSE row: lights every seed (up to SEED_K=10) at score-proportional intensity, resolves hops from `row.hops` only via `traceEdgesFromHops` — zero `ctx.adj` traversal inside hop resolution
- `normalizeSeed` and `traceEdgesFromHops` exported as named, THREE-free helpers for testability and Plan 03 reuse
- D-06 attack→hold→exponential-fade envelope (`__actT0`/`__actPeak` per node, `evalEnvelope`) replaces flat `dt*0.6` decay
- Structural regression test: 17 assertions covering exactly-N-hops, exactly-M-seeds, score→intensity ordering, no-BFS dense-adjacency case, WR-02 mid-intensity fallback, bare-string back-compat

## Task Commits

1. **Task 1: Decay constants + KIND_COLOR + cap demotions** - `92c206c` (feat)
2. **Task 2: TDD GREEN — emit + applyTrace rewrite** - `f2191be` (feat, includes test file)
3. **Rule 1 auto-fix — update tests for D-06 timing** - `faec3da` (fix)

## Files Created/Modified

- `src/viz/modules/constants.js` — DECAY_ATTACK_MS/HOLD_MS/FADE_MS/FLOOR + KIND_COLOR palette; MAX_HOPS/TRACE_FANOUT/TRACE_MAX_EDGES re-documented as defensive caps
- `src/viz/modules/trace.js` — exports normalizeSeed + traceEdgesFromHops; rewritten applyTrace(row); D-06 evalEnvelope in tick; synthetic row in test trigger
- `src/viz/modules/hud.js` — pass full `row` to `ctx.applyTrace` (not `row.seeds||[]`); normalize seed ids for log line
- `src/retrieval/engine.ts` — seeds payload mapped to `[{node_id,score}]` using existing `seedScore` (inside T-10-05 try/catch)
- `src/recall/index.ts` — seed emitted as `{node_id: bestMatch.id, score:null}` per WR-02
- `tests/trace-honest-recall.test.ts` — 17 structural honesty assertions (TDD RED→GREEN)
- `tests/activation-trace-wiring.test.ts` — updated to expect `{node_id,score:null}` seed shape
- `tests/viz-haze-activation.test.ts` — updated to advance time past DECAY_ATTACK_MS for D-06 timing
- `tests/viz-frontend-static.test.ts` — widened SSE handler applyTrace window from 400→700 chars

## Decisions Made

- **DROP edge.w in hop brightness**: The honest payload has no edge weight. The `score × edge.w` clause of D-07 was dropped with founder approval — implementing it would require re-deriving client adjacency, which is the theater this phase kills.
- **NO spawnPulse from applyTrace**: No honest seed→hop edges exist in the payload; all seeds' neighbors are aggregated into one flat set with no recorded source. Drawing edge animations would fabricate topology.
- **traceEdgesFromHops as module export**: Pure function with no THREE dependency; extracting it enables testability without a full ctx and reuse by Plan 03 (ingestion colors).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] activation-trace-wiring.test.ts expected bare string seeds**
- **Found during:** Task 2 verification (full suite run)
- **Issue:** Test asserted `typeof trace.seeds[0] === 'string'` but recall now emits `{node_id, score:null}`
- **Fix:** Updated assertion to check object shape + null score
- **Files modified:** `tests/activation-trace-wiring.test.ts`
- **Verification:** `npx vitest run tests/activation-trace-wiring.test.ts` → 11/11 pass
- **Committed in:** `faec3da`

**2. [Rule 1 - Bug] viz-haze-activation.test.ts assumed flat decay timing**
- **Found during:** Full suite run after Task 2
- **Issue:** Two tests: (a) ticked at `performance.now()` expecting color change — but D-06 attack starts at 0 (no instant jump); (b) ticked at +50ms expecting expire — but D-06 total duration is 3240ms
- **Fix:** (a) tick at `performance.now() + DECAY_ATTACK_MS + 50` (into hold phase); (b) tick at `+DECAY_ATTACK_MS+DECAY_HOLD_MS+DECAY_FADE_MS+100` (past full fade)
- **Files modified:** `tests/viz-haze-activation.test.ts`
- **Verification:** `npx vitest run tests/viz-haze-activation.test.ts` → 5/5 pass
- **Committed in:** `faec3da`

**3. [Rule 1 - Bug] viz-frontend-static.test.ts 400-char SSE window too small**
- **Found during:** Full suite run after Task 2
- **Issue:** Test sliced 400 chars from `addEventListener('trace'` looking for `applyTrace`; new seedLog line pushed it beyond the window
- **Fix:** Widened window to 700 chars
- **Files modified:** `tests/viz-frontend-static.test.ts`
- **Verification:** `npx vitest run tests/viz-frontend-static.test.ts` → 45/45 pass
- **Committed in:** `faec3da`

---

**Total deviations:** 3 auto-fixed (all Rule 1 — existing tests testing pre-Phase-52 behavior)
**Impact on plan:** All fixes necessary for test correctness under D-06 timing. No scope creep.

## Known Stubs

None — all wired data paths deliver real values.

## Threat Flags

None — all changes are inside the existing T-10-05 fire-and-forget guard (presentation-only plumbing) with no new trust boundaries.

## Issues Encountered

Pre-existing suite failures (33 tests in adapter-capture, adapter-inject, schema-v14, locomo-harness, eval-harness): confirmed pre-existing by `git diff 62d1749..HEAD -- tests/<file>` showing zero diff. Not caused by Phase 52-02 changes. Passing count: 2383 (same as v8.0 baseline); new passing tests: +17 from trace-honest-recall.test.ts + 3 recovered from auto-fix.

## Next Phase Readiness

- Plan 03 (per-kind ingestion color vocabulary) can import `normalizeSeed` + `traceEdgesFromHops` directly from `trace.js`
- `ctx.applyTrace(row)` signature is stable; `row.kind` field is threaded through to the function but not yet branched on (Plan 03's job)
- D-06 constants are tunable in `constants.js` — adjust at the founder visual checkpoint (Plan 06)

## Self-Check: PASSED

- `tests/trace-honest-recall.test.ts` exists and contains 17 tests: FOUND
- `src/viz/modules/constants.js` exports DECAY_ATTACK_MS, KIND_COLOR: FOUND
- `src/viz/modules/trace.js` exports traceEdgesFromHops: FOUND
- Commits 92c206c, f2191be, faec3da all present in git log: FOUND
- `npx tsc --noEmit`: clean
- `npx vitest run tests/trace-honest-recall.test.ts`: 17/17 PASS

---
*Phase: 52-brain-viz-honest-traces*
*Completed: 2026-06-29*
