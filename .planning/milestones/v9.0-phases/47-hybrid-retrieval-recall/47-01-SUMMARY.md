---
phase: 47-hybrid-retrieval-recall
plan: 01
subsystem: retrieval
tags: [hybrid-retrieval, bm25, rrf-fusion, config-knob, regression-test]
requirements: [RETR-01, RETR-02]
depends_on: []
provides: [bm25FusionWeight config scalar, w=0 isolation proof, doc-gather preservation proof]
affects: [src/retrieval/topk.ts, src/retrieval/engine.ts, src/lib/config.ts]
tech_stack:
  added: []
  patterns: [dark-knob convention (D-02), weighted-RRF with bm25FusionWeight parameter]
key_files:
  created:
    - tests/hybrid-fusion-weight.test.ts
  modified:
    - src/lib/config.ts
    - src/retrieval/topk.ts
    - src/retrieval/engine.ts
decisions:
  - "bm25FusionWeight appended as the last hybridTopk parameter (after lambda?) to preserve all existing positional callers"
  - "DEFAULT_CONFIG default is 0 (dark) per D-02 isolation convention; hybridTopk default is 1 (preserves doc-gather byte-identity)"
  - "weights=[1, bm25FusionWeight] in the else-branch rrfFuse call; strengthWeight>0 branch untouched (out of scope)"
metrics:
  duration: ~10 min
  completed: 2026-06-28
  tasks_completed: 2
  tasks_total: 2
  files_changed: 4
---

# Phase 47 Plan 01: bm25FusionWeight Config Knob Summary

**One-liner:** Weighted-RRF BM25 fusion weight exposed as `bm25FusionWeight` config scalar (default 0, dark) with `[1, bm25FusionWeight]` threaded into the existing `rrfFuse` call; w=0 isolation and doc-gather preservation proved by regression test.

## What Was Built

Three surgical edits + one test file implementing the D-02 dark-knob convention:

1. **`src/lib/config.ts`** — Added `bm25FusionWeight: number` to `EngineConfig` interface (after `rankStrengthWeight`) with Phase 47 RETR-02 JSDoc. Added `bm25FusionWeight: 0` to `DEFAULT_CONFIG` (dark default with inline comment citing D-02).

2. **`src/retrieval/topk.ts`** — Appended `bm25FusionWeight = 1` as the final parameter to `hybridTopk` (after `lambda?`). In the `else` branch (strengthWeight=0 path), changed weightless `rrfFuse([cosineList, bm25List], 60, k)` to `rrfFuse([cosineList, bm25List], 60, k, [1, bm25FusionWeight])`. Default=1 keeps all direct callers (doc-gather) byte-identical.

3. **`src/retrieval/engine.ts`** — In `retrieveRanked`'s hybrid branch, appended `this.config.bm25FusionWeight` as the final argument to the `hybridTopk` call.

4. **`tests/hybrid-fusion-weight.test.ts`** — Three test cases: (A) byte-identical w=0 isolation gate, (B) param-default-1 preservation, (C) knob-is-live proof. Uses real FTS5 seeding with a 4-node brain where cosine and BM25 rankings diverge.

## Verification

- `npm run build` (tsc): clean, no type errors
- `npx vitest run tests/hybrid-fusion-weight.test.ts`: 3/3 passed
- `npm test` (full suite): 2394 passed | 3 skipped — zero new failures

## Deviations from Plan

None — plan executed exactly as written. Three surgical edits matched PATTERNS.md line numbers precisely; doc-gather callers (lines 87, 249, 465 of doc-gather.ts) left untouched.

## Key Decisions

1. `bm25FusionWeight` appended as the final `hybridTopk` parameter (position after `lambda?`) — preserves all existing positional callers without argument index shifts. Coordinates with engine.ts which passes it as the 8th positional arg.

2. Two defaults: config DEFAULT is 0 (dark, engine-path isolation); hybridTopk parameter DEFAULT is 1 (preserves doc-gather behavior). Both behaviors needed simultaneously; the asymmetry is intentional and proven by Tests A+B.

3. Test C's assertion uses `new Set(w1Ids)` to avoid asserting BM25 node order (nodeC vs nodeD BM25 rank depends on SQLite FTS5 scoring of "salmon" in short documents). The invariant that both BM25 hits beat both cosine leaders is proven by RRF math.

## Threat Surface Scan

No new security-relevant surface introduced. The `ftsQueryFromText` sanitizer path (line 457 topk.ts) and the try/catch FTS-absent fallback (lines 459-465) are untouched per T-47-01. The new `bm25FusionWeight` parameter is a numeric config scalar with no cross-trust-boundary flow.

## Self-Check: PASSED

- `src/lib/config.ts` contains `bm25FusionWeight` — confirmed (2 edit sites)
- `src/retrieval/topk.ts` signature ends with `bm25FusionWeight = 1` — confirmed
- `src/retrieval/engine.ts` passes `this.config.bm25FusionWeight` — confirmed
- `tests/hybrid-fusion-weight.test.ts` exists — confirmed (created)
- Commits: eb91259 (feat), 72d3b1b (test) — both verified in git log
