---
phase: 63-offline-intent-classification
plan: 05
subsystem: testing
tags: [typescript, vitest, cross-stage-conservation, sqlite, sentinel-tests]

# Dependency graph
requires:
  - phase: 63-offline-intent-classification (plan 01)
    provides: INTENT_STATUSES/INTENT_CONFIDENCES vocabulary constants, CLAIM_ARRAY_SCHEMA enum, toIntentStatus/toIntentConfidence coercers
  - phase: 63-offline-intent-classification (plan 02)
    provides: GMAIL_INTENT_CLASSIFICATION_BLOCK interpolated into both gmail prompt variants
  - phase: 63-offline-intent-classification (plan 04)
    provides: claimIntentStatus/claimIntentEntity/claimIntentConfidence threading through all four ClaimDecision fill sites
provides:
  - tests/intent-conservation.test.ts — cross-stage vocabulary parity (prompt <-> schema <-> parser) + zero-database-delta inertness proof (D-08), driven entirely off exported constants
affects: [64 (entity resolution reads claimIntentEntity, this file's parity guard protects the vocabulary it depends on), 65 (confidence -> PE magnitude mapping), 66 (action_proposal — this file's Task 2 header comment names the exact review-blocking update it requires)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dynamic sqlite_master table enumeration for inertness proofs: snapshotDb() never hardcodes a table list, so a future schema migration is automatically covered by the D-08 conservation test without editing this file."
    - "Stable-column snapshot with count-only fallback: comparing two independently-seeded DB instances byte-for-byte is impossible when node ids are randomly generated (newId()) per run — snapshotDb() records COUNT(*) plus the sorted contents of a stable text column (value/content) where one exists, and falls back to count-only elsewhere, so the comparison is exact where it can be and still meaningful where random ids would otherwise cause false positives."

key-files:
  created: [tests/intent-conservation.test.ts]
  modified: []

key-decisions:
  - "Task 2's auto-unrelated consolidation path (zero-vector embed, empty seeded DB) was chosen over the fast-path/judge-escalated paths used in 63-04's tests — it is the simplest path that still exercises the full per-episode consolidate() loop and applyDecision write, keeping the inertness proof independent of judge-script scripting correctness."
  - "snapshotDb() intentionally does NOT include node ids, edge src/dst, or any random-per-run identifier in its comparison — those differ between run A and run B by construction (newId() is random) even when the pipeline is genuinely inert. Comparing them would produce false failures unrelated to D-08."
  - "The near-miss parser test hand-picks adversarial string shapes (wrong case, trailing space, plural, 'other'/'unknown'/'pending') rather than deriving them from INTENT_STATUSES with a suffix loop — these are the shapes a real model could plausibly emit, which is the actual threat this assertion guards against."

patterns-established:
  - "Task 2's describe-block header comment names the exact future change (Phase 66's action_proposal table) that is allowed to update this file's assertions, and states explicitly that any other loosening is review-blocking — a repudiation-guard pattern (T-63-05-C) other inertness-conservation tests in the codebase can reuse."

requirements-completed: [CLASSIFY-01, CLASSIFY-02, CLASSIFY-04]

# Metrics
duration: ~25min
completed: 2026-08-02
---

# Phase 63 Plan 05: Cross-Stage Vocabulary Parity + Inertness Conservation Summary

**One new test file (`tests/intent-conservation.test.ts`, 14 tests, zero source changes) proves the four-state intent vocabulary is identical from prompt text through JSON schema enum through parser coercion, and that a full consolidation pass carrying classification produces a database indistinguishable from one without it.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-08-02T21:12:05Z
- **Tasks:** 2 completed
- **Files modified:** 1 created

## Accomplishments

- **Task 1 (vocabulary parity):** every member of `INTENT_STATUSES`/`INTENT_CONFIDENCES` asserted present verbatim in `promptForSource('gmail')` under both `RECENSE_ENABLE_EPISODIC_EMAIL` unset and `'on'`; `CLAIM_ARRAY_SCHEMA.items.properties.intent_status/intent_confidence.enum` sorted-deep-equals the constants; every constant member round-trips through `toIntentStatus`/`toIntentConfidence` unchanged, six hand-picked near-miss strings (wrong case, trailing space, plural, `'other'`, `'unknown'`, `'pending'`) all coerce to `undefined`; `INTENT_STATUSES.size === 4` / `INTENT_CONFIDENCES.size === 3` tripwire; `'ghosted'` proven absent from the gmail prompt as a non-vacuousness check on the "prompt contains every member" assertions.
- **Task 2 (D-08 inertness):** two full `Consolidator.consolidate()` passes over independently-constructed, identically-seeded in-memory SQLite databases (same `FakeClock`, same gmail episode content, same zero-vector embed fn) — the only difference being run A's scripted extraction JSON carries `intent_status`/`intent_entity`/`intent_confidence` and run B's does not — produce byte-identical `snapshotDb()` output. `snapshotDb()` dynamically enumerates every table in `sqlite_master` (never a hardcoded list) and records `COUNT(*)` plus the sorted contents of a stable text column (`value` for node/node_fts, `content` for episode) where one exists. A second assertion enumerates `PRAGMA table_info` across every table and asserts zero column names contain `intent`; a third asserts the concatenated `sqlite_master.sql` text (covering indexes and views too) contains no `intent` substring.
- Zero source changes (`git diff --stat src/` clean, per the plan's explicit scope).

## Task Commits

Both tasks landed together in a single commit — the plan specified one output file (`tests/intent-conservation.test.ts`) built incrementally across the two tasks, and both were authored in one Write pass since Task 2 depends on constants/helpers already imported for Task 1:

1. **Task 1 + Task 2: cross-stage vocabulary parity + zero-DB-delta inertness conservation** - `bb94a9c` (test)

## Files Created/Modified

- `tests/intent-conservation.test.ts` (created) — two top-level `describe` blocks: `vocabulary parity across the classification pipeline` (Task 1, 9 tests) and `classification is inert — zero database delta (D-08)` (Task 2, 3 tests, plus the 2 env-case prompt-coverage tests counted above bring Task 1 to 9 total; overall file: 14 tests).

## Decisions Made

- Chose the auto-unrelated consolidation path (empty seeded DB, zero-vector embed) for Task 2's harness rather than the fast-path or judge-escalated paths 63-04 exercises — this keeps the inertness proof independent of judge-script scripting correctness while still running the full per-episode `consolidate()` loop and the real `applyDecision` write path.
- `snapshotDb()` deliberately excludes node ids, edge endpoints, and any other `newId()`-derived random identifier from its comparison. These differ between the two independently-run passes by construction (random per run) even when the pipeline is genuinely inert; including them would produce false failures unrelated to D-08. The helper falls back to count-only for any table lacking a `value`/`content` column (this covers FTS5 shadow tables, `edge`, `meta`, `consolidation_event`, etc.) — verified by manual read of `src/db/schema.ts`'s DDL and the FTS5 virtual-table definition (`node_id UNINDEXED, value` — the `value` column IS present on `node_fts` itself, so it participates in the stable-column comparison; only its `*_data`/`*_idx`/`*_docsize`/`*_config` shadow tables fall back to count-only).
- Near-miss parser test values are hand-picked adversarial strings rather than programmatically derived from `INTENT_STATUSES` — the plan asked for "a generated set of near-miss values (wrong case, trailing space, plural, `'other'`, `'unknown'`, `'pending'`)"; hand-picking each shape directly (rather than looping a suffix onto real members) keeps every near-miss independently readable and matches the specific adversarial categories named in the plan.

## Deviations from Plan

None — plan executed exactly as written. Both tasks' acceptance criteria verified directly (see Self-Check below).

## Issues Encountered

None.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

The vocabulary-parity guard protects Phase 64's consumption of `claimIntentEntity` (a future one-sided edit to the prompt or schema without touching the other will now fail this suite). The D-08 inertness proof is the explicit gate Phase 66 must consciously break when `action_proposal` lands — the describe-block header comment names that exact future change as the one allowed update, everything else as review-blocking. No blockers for Phase 63 close.

## Self-Check: PASSED

- FOUND: tests/intent-conservation.test.ts
- FOUND: bb94a9c (Task 1 + Task 2 commit)
- `grep -c "INTENT_STATUSES" tests/intent-conservation.test.ts` = 11 (>= 4 required)
- No four-element status literal array (`'applied'...'interviewing'...'rejected'...'offer'`) found anywhere in the file
- `npx vitest run tests/intent-conservation.test.ts` = 14 passed
- `npx vitest run tests/intent-conservation.test.ts tests/consolidation-intent.test.ts` = 23 passed
- `git diff --stat src/` = clean (zero source changes)
- `npm run typecheck` exits 0
- `npm test` = 205 test files passed / 1 skipped, 3425 tests passed / 6 expected fail / 4 skipped
- `git diff --exit-code package.json package-lock.json` = clean

---
*Phase: 63-offline-intent-classification*
*Completed: 2026-08-02*
