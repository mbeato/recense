---
phase: 48-correctness-hardening
plan: "01"
subsystem: semantic-store
tags: [correctness, hardening, embedding, meta-guard, HARD-04]
dependency_graph:
  requires: []
  provides: [embedding_model_stamp_assert]
  affects: [src/db/semantic-store.ts, tests/store.test.ts]
tech_stack:
  added: []
  patterns: [getMeta/setMeta fail-closed mismatch guard]
key_files:
  created: []
  modified:
    - src/db/semantic-store.ts
    - tests/store.test.ts
decisions:
  - "Mirror existing embedding_dims guard shape verbatim (getMeta/setMeta/throw-on-mismatch) for embedding_model"
  - "Source model string from this.config.openaiEmbedModel — no signature change to setEmbedding"
  - "Fail-closed throw (not warn-and-continue) — matches established dims and schema_version guards"
metrics:
  duration: "~5 minutes"
  completed: "2026-06-27"
  tasks_completed: 2
  files_modified: 2
---

# Phase 48 Plan 01: HARD-04 Embedding Model Stamp/Assert Summary

**One-liner:** HARD-04 closed — `setEmbedding` now stamps+asserts `embedding_model` meta key mirroring the existing `embedding_dims` fail-closed guard, with three colocated regression tests.

## What Was Built

**Task 1 — Source change (`src/db/semantic-store.ts`):**

Inserted an 8-line `embedding_model` stamp/assert block in `setEmbedding` immediately after the existing `embedding_dims` block (lines 384-393) and before the `Buffer.from` call. The guard:

- Reads the model name from `this.config.openaiEmbedModel` (already a class field — no signature change).
- On first embed: `getMeta('embedding_model')` is null → `setMeta('embedding_model', model)`.
- Subsequent embed, same model: no throw (clean-case preserved).
- Subsequent embed, different model: throws `Error` matching `/embedding_model mismatch/` — fail closed, never warn-and-continue.

Labeled `// HARD-04 (L-2)` matching requirement convention.

**Task 2 — Regression tests (`tests/store.test.ts`):**

Added three tests inside the existing `describe('setEmbedding')` block after the existing L-2 dims tests (~line 224):

- **Test A (stamp):** `HARD-04 (L-2): first setEmbedding stamps embedding_model in meta` — asserts `getMeta('embedding_model') === 'test-model-v1'` after first embed.
- **Test B (mismatch fail-closed):** `HARD-04 (L-2): setEmbedding with mismatched model throws fail-closed` — storeA stamps model-a on db; storeB (model-b) on same db must throw `/embedding_model mismatch/`.
- **Test C (happy path):** `HARD-04 (L-2): setEmbedding with matching model succeeds (happy path)` — two writes on same model do NOT throw.

## Verification

- `grep -n "embedding_model" src/db/semantic-store.ts` — guard found at lines 395-403.
- `npm run build` — exits 0, tsc clean, no signature change.
- `npx vitest run tests/store.test.ts` — 49 passed (all 3 new HARD-04 tests green).
- `npm test` (full suite) — 2389 passed / 4 skipped, no new failures.

## Deviations from Plan

None — plan executed exactly as written. The exact code shape from 48-PATTERNS.md was used verbatim.

## Commits

| Task | Hash | Message |
|------|------|---------|
| 1 | 5b43b7c | feat(48-01): stamp and assert embedding_model in setEmbedding (HARD-04 L-2) |
| 2 | 923030c | test(48-01): add HARD-04 regression tests for embedding_model stamp/assert |

## Self-Check: PASSED

- `src/db/semantic-store.ts` — embedding_model guard present (verified via grep).
- `tests/store.test.ts` — three HARD-04 tests present after line 224.
- Commits 5b43b7c and 923030c exist in git log.
- Full suite green (2389 passed / 4 skipped).
