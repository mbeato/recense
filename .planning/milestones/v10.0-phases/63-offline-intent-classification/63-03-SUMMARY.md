---
phase: 63-offline-intent-classification
plan: 03
subsystem: test-infrastructure
tags: [regression-gate, llm-free, classify-03, sentinel]
dependency-graph:
  requires: [ambientRecall (src/adapter/ambient-recall.ts), RetrievalEngine (src/retrieval/engine.ts), createBrainHttpServer (src/adapter/serve-cli.ts)]
  provides: [findOnlineGenerationOffenders (tests/online-llm-free-sentinel.test.ts), CLASSIFY-03 regression lock]
  affects: [future Phase 66 /v1/proposals route (must extend this file)]
tech-stack:
  added: []
  patterns: [fail-if-called ModelProvider stub with embed-call counting, comment-stripped structural source scan]
key-files:
  created:
    - tests/online-llm-free-sentinel.test.ts
  modified: []
decisions:
  - "D-13 satisfied via both a dynamic stub (all three live online entrypoints) and a structural scan (planner-discretion variant), because the dynamic half only proves the paths these specific fixtures exercise."
metrics:
  duration: ~25min
  completed: 2026-08-02
---

# Phase 63 Plan 03: Online LLM-Free Regression Lock Summary

One new test file (`tests/online-llm-free-sentinel.test.ts`, 372 lines, zero source changes) locks CLASSIFY-03: SessionStart inject, retrieval, and `GET /v1/surface` are proven LLM-free both dynamically (fail-if-called provider stub) and structurally (comment-aware source scan), with non-vacuousness proven in both halves.

## What Was Built

**Task 1 — Dynamic fail-if-called sentinel (commit `b6424a3`).** A shared `makeLlmFreeProvider(embedFn)` helper returns a `ModelProvider` where `embed` delegates to `embedFn` and increments a live `embedCount` getter, while `generate`/`judge`/`judgeBatch` each throw `'<method> must not be called on an online path (CLASSIFY-03)'`. Three describe blocks exercise it:

1. **SessionStart inject** — seeds a node with a fixed embedding that clears `AMBIENT_FLOOR`, calls `ambientRecall(db, prompt, provider, config, clock)` in-process, and asserts the returned text is non-empty (proof the path ran to completion, not a short-circuit) AND `embedCount === 1`.
2. **Retrieval** — constructs `RetrievalEngine` with the exact same collaborator wiring `ambientRecall` uses (`SemanticStore`, `CandidateRetriever`, `StrengthDecayManager`, `AllocationGate`), calls `retrieveRanked` directly with a pre-computed vector (no provider passed to any collaborator), and asserts results are non-empty while a separately-instantiated provider's `embedCount` stays unchanged.
3. **`GET /v1/surface`** — mirrors `tests/surface-sentinel.test.ts`'s HTTP harness exactly (temp file DB, free port, hermetic `RECENSE_LOCK_PATH`, `node:http.request`) but injects `makeLlmFreeProvider(...)` as `opts.provider`; asserts `statusCode === 200`, a parseable `items` array, and `embedCount === 0`.

The file header docblock records the Phase 66 extension obligation (`/v1/proposals` must get a fourth block) and explicitly excludes `recense recall` (`LEARN-02`, user-initiated, expected to call `generate`).

**Task 2 — Non-vacuous structural scan (commit `01de808`).** A fourth describe block appends the structural half of D-13. `findOnlineGenerationOffenders(files)` is a pure, exported predicate that strips `/* */` block comments and `//` line comments before matching `.generate(`/`.judge(`/`.judgeBatch(`. It is run three ways: (a) over the real scan set (`src/adapter/ambient-recall.ts` + all `.ts` files under `src/retrieval/`) asserting `[]`; (b) over a synthetic planted-offender file asserting a non-empty result; (c) over synthetic comment-only occurrences (both `//` and `/* */` forms) asserting `[]`. `src/adapter/serve-cli.ts` is deliberately excluded from the scan set — it legitimately hosts non-online routes, and `/v1/surface` is already covered dynamically by Task 1.

## Verification

- `npx vitest run tests/online-llm-free-sentinel.test.ts` — 6/6 tests pass
- `npx tsc --noEmit -p tests/tsconfig.json` — clean, no errors attributed to the new file
- `git diff --stat src/` — empty (zero source changes from this plan, as the objective required)
- `git diff --exit-code package.json package-lock.json` — clean (T-63-03-SC, no installs)
- Sanity cross-check: ran the new file alongside its three analog neighbors (`ambient-recall.test.ts`, `surface-sentinel.test.ts`, `src-import-boundary.test.ts`) — 23/23 pass, no interference

## Deviations from Plan

None — plan executed exactly as written. The only implementation-detail choice made at planner discretion (per D-13/63-CONTEXT.md) was implementing both the dynamic AND structural variants of the guard, which the plan explicitly called for across its two tasks.

## Threat Model Coverage

- **T-63-03-A** (DoS via online-path generation calls) — mitigated: fail-if-called stub exercised through both live entrypoints; structural scan catches branches the fixtures don't exercise.
- **T-63-03-B** (future `/v1/proposals` online route) — transferred to Phase 66 via the file-header extension-point comment (unmitigable now — the route doesn't exist yet).
- **T-63-03-C** (vacuous guard) — mitigated: planted-offender test proves the structural predicate fires; positive completion assertions (non-empty text, exact embed counts) in the dynamic half prevent a short-circuiting path from passing as "LLM-free".
- **T-63-03-SC** (package-manager install tampering) — accepted, and verified clean: no installs occurred in this plan (`package.json`/`package-lock.json` diff-clean).

## Self-Check: PASSED

- FOUND: tests/online-llm-free-sentinel.test.ts
- FOUND: commit b6424a3 (Task 1)
- FOUND: commit 01de808 (Task 2)
