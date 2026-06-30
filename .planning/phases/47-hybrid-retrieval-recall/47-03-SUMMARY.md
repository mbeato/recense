---
phase: 47-hybrid-retrieval-recall
plan: 03
subsystem: responder/retrieval
tags: [hybrid-retrieval, bm25, fusion, lever1, responder, config]

# Dependency graph
requires:
  - phase: 47-01
    provides: "bm25FusionWeight knob + hybridTopk/retrieveRanked 4th-arg routing (dark default 0)"
  - phase: 47-02
    provides: "held-out sweep result: w* = 0 (null result, gate-validated)"
provides:
  - "queryForEmbed threaded as 4th arg to facts-first retrieveRanked (LEVER 1 ON, mechanism live)"
  - "bm25FusionWeight=0 with held-out null result comment (w* documented, not invented)"
  - "WR-01 test updated to assert hybrid posture (4 args) not legacy 3-arg pure-cosine guard"
affects: [live-product-QA-path, responder, config, retrieval-engine]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Thread user-derived queryForEmbed (not LLM output) as queryText to retrieveRanked — satisfies T-04-03-I"
    - "Dark/neutral fusion: hybrid(0) ≡ cosine byte-identical; w=0 is instant pure-cosine fallback"

key-files:
  modified:
    - src/responder/index.ts
    - src/lib/config.ts
    - tests/responder.test.ts

key-decisions:
  - "Ship LEVER 1 ON with w=0: mechanism live, weight neutral per Plan 02 null result (w*=0 — no positive weight passed D-04 per-category no-regression gate)"
  - "WR-01 test updated to assert new 4-arg hybrid posture rather than re-pin the old 3-arg pure-cosine guard"
  - "No invented non-zero weight — the held-out null result is honestly recorded in both code and tests"

requirements-completed: [RETR-01, RETR-04]

# Metrics
duration: ~15m
completed: 2026-06-29
---

# Phase 47 Plan 03 Summary

**Ship LEVER 1 hybrid fusion ON the live product QA path: mechanism threaded, weight neutral (w*=0 from Plan 02 null result — hybrid(0) ≡ pure cosine byte-identical).**

## What was done

Plan 02 concluded `w* = 0` (null result) — no positive BM25 fusion weight passed the held-out per-category no-regression gate on LoCoMo TUNE R@5. The explicit GATE clause in this plan applies: thread `queryForEmbed` (mechanism ON) but keep `DEFAULT_CONFIG.bm25FusionWeight = 0` (weight neutral). Do not invent a non-zero weight.

### Task 1: Thread queryForEmbed into the responder facts-first retrieveRanked call

- Added `queryForEmbed` as the 4th arg to `this.retrieval.retrieveRanked(cueVec, this.config.rankedRetrievalK, this.config.rankedRetrievalFloor, queryForEmbed)` in `src/responder/index.ts` respond() facts-first branch
- Replaced the "LEVER 1 (BM25/hybrid) intentionally absent on the answer path" comment block with updated text documenting:
  - LEVER 1 is ON via `config.bm25FusionWeight` (w=0 = instant pure-cosine fallback)
  - Plan 02 null result: w*=0, hybrid(0) ≡ cosine byte-identical (Plan 01 isolation test)
  - D-04 per-category gate as the structural regression guard against the 9ea5eabc stale-fact failure
  - T-04-03-I compliance: queryForEmbed is user-derived (boundedQuery or LEVER-3 rewrite), never LLM output
- Updated JSDoc in respond() to reflect 4-arg retrieveRanked signature
- `npm run build` clean

**Commit:** `881aced`

### Task 2: Update bm25FusionWeight default comment and fix WR-01 test

- Updated `DEFAULT_CONFIG.bm25FusionWeight = 0` inline comment in `src/lib/config.ts` to cite D-05 held-out selection: `// Phase 47 D-05: w* = 0 (held-out LoCoMo sweep null result — R@5 max at w=0, no positive weight passes per-category no-regression gate); set 0 to use pure cosine`
- Value remains 0 — the null result is documented, not overridden
- Updated WR-01 test in `tests/responder.test.ts`: the old assertion guarded against LEVER 1 being ON (3 args). Now asserts 4 args (cueVec, k, floor, queryForEmbed) with the 4th being a string — documents the new hybrid posture while keeping the user-derived-query contract explicit
- `npm run build` clean; `npm test` green: 2441 passed, 4 skipped, 0 failed

**Commit:** `7631ac4`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated WR-01 test to match new 4-arg retrieveRanked call**
- **Found during:** Task 2 — `npm test` failed with "expected [ …(4) ] to have a length of 3 but got 4"
- **Issue:** WR-01 was an explicit guard asserting LEVER 1 OFF (3 args). Plan 47-03 turns LEVER 1 ON.
- **Fix:** Updated test description and assertions to assert 4 args with 4th being a string (queryForEmbed). The test now guards the new hybrid posture rather than the old pure-cosine guard.
- **Files modified:** `tests/responder.test.ts`
- **Commit:** `7631ac4`

## Honest null-result record

This plan ships the **mechanism** (LEVER 1 threading) but **not an improved weight** — because Plan 02 found none. `bm25FusionWeight = 0` means the live QA path is byte-identical to pre-47 pure cosine. The retrieval infrastructure (hybridTopk, rrfFuse, node_fts, ftsQueryFromText) is fully wired; a future plan can set a non-zero weight once a sweep finds a positive signal on larger/balanced data.

## Threat Surface Scan

- T-47-02 (self-confirmation): queryForEmbed is `boundedQuery` or its LEVER-3 declarative rewrite — user/question-derived, never LLM answer output. No new LLM call introduced. Self-confirmation invariant untouched.
- T-47-01 (FTS MATCH injection): sanitizer path via `ftsQueryFromText` unchanged from Plan 01.
- No new trust boundaries introduced.

## Self-Check: PASSED

- `src/responder/index.ts` retrieveRanked call has 4 args ending in `queryForEmbed`: verified in diff
- `src/lib/config.ts` bm25FusionWeight == 0 with held-out null result comment: verified
- `npm run build` clean: confirmed
- `npm test` green (2441 passed): confirmed
- No new LLM call in retrieval path: verified (only the pre-existing LEVER-3 rewrite remains)
- SCHEMA_VERSION unchanged, net-zero new deps: confirmed
- Commits `881aced` and `7631ac4` exist: verified
