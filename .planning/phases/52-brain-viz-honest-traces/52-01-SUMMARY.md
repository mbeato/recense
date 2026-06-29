---
phase: 52-brain-viz-honest-traces
plan: "01"
subsystem: viz-schema
tags: [schema-migration, activation-trace, kind-column, seeds-union, tdd]
dependency_graph:
  requires: []
  provides: [activation_trace.kind, ActivationTraceInput.kind, ActivationTraceInput.seeds-union]
  affects: [src/db/schema.ts, src/viz/activation-sink.ts]
tech_stack:
  added: []
  patterns: [additive-column-alter-idiom, pragma-table-info-guard, tdd-red-green]
key_files:
  created: []
  modified:
    - src/db/schema.ts
    - src/viz/activation-sink.ts
    - tests/activation-sink.test.ts
decisions:
  - "kind column nullable (no DEFAULT) — additive and reversible; NULL treated as back-compat recall"
  - "seeds union is type-only widening; JSON.stringify is already shape-agnostic so no SQL change needed"
  - "kind bound as a param (trace.kind ?? null) — never string-interpolated, extends T-10-02"
metrics:
  duration: "4 minutes"
  completed: "2026-06-29"
  tasks_completed: 2
  files_changed: 3
---

# Phase 52 Plan 01: Schema kind column + sink threading Summary

**One-liner:** Nullable `kind TEXT` column on `activation_trace` via PRAGMA-guarded ALTER migration (v14→v15), threaded through `SQLiteActivationTraceSink` with a 5-param INSERT bound param; `ActivationTraceInput.seeds` widened to back-compat union `Array<string | {node_id, score}>`.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add nullable kind column to activation_trace (D-09) | 33080e8 | src/db/schema.ts, tests/activation-sink.test.ts |
| 2 (RED) | Failing tests for kind round-trip + seeds union | fd2216a | tests/activation-sink.test.ts |
| 2 (GREEN) | Thread kind + widen seeds through sink | 22aba89 | src/viz/activation-sink.ts, tests/activation-sink.test.ts |

## What Was Built

**Task 1 — Schema migration (D-09):**
- `SCHEMA_VERSION` bumped 14 → 15
- `activation_trace` DDL: `kind TEXT` added (nullable, no DEFAULT) — fresh DBs get it from CREATE TABLE
- v15 migration block: `PRAGMA table_info(activation_trace)`-guarded `ALTER TABLE activation_trace ADD COLUMN kind TEXT` for existing pre-52 DBs
- Uses a separate `atCols` Set built from `table_info(activation_trace)` — not reusing the episode `cols` Set
- v15 comment block documents that NULL = back-compat recall; ingestion rows carry `new_node/reconsolidation/oscillation/consolidation-neutral`
- Tests updated: SCHEMA_VERSION 14→15 assertions, kind-column PRAGMA check, pre-52 migration test, idempotent ALTER guard test

**Task 2 — Sink + type widening (TDD):**
- `ActivationTraceInput.seeds` widened: `string[]` → `Array<string | { node_id: string; score: number | null }>` (type-only; JSON.stringify already handles both shapes)
- `ActivationTraceInput.kind?: string | null` added
- Prepared INSERT updated: `INSERT INTO activation_trace (ts, query_id, seeds, hops, kind) VALUES (?, ?, ?, ?, ?)` — 4→5 params
- `emit()` binds `trace.kind ?? null` as 5th param (written as SQL NULL when omitted)
- `evict` prepared statement and RING_CAP unchanged

## Verification

- `npx vitest run tests/activation-sink.test.ts`: 27 passed (was 16 before this plan)
- `npx tsc --noEmit`: clean

## TDD Gate Compliance

RED commit: `fd2216a` (test(52-01): add failing tests — 2 failures on kind round-trip)
GREEN commit: `22aba89` (feat(52-01): thread kind + widen seeds — 27/27 pass)
No REFACTOR needed (implementation was minimal and clean).

## Deviations from Plan

**[Rule 1 - Bug] TypeScript errors in test file after GREEN phase**
- **Found during:** Task 2 GREEN phase post-commit tsc check
- **Issue:** `as const` tuple is `readonly` and cannot cast to mutable union array; array index access without optional chaining
- **Fix:** Changed `as const` + cast to an explicit `ActivationTraceInput['seeds']` typed variable; changed `traces[0].kind` to `traces[0]?.kind` for optional chaining
- **Files modified:** tests/activation-sink.test.ts
- **Commit:** Included in 22aba89 (same GREEN commit, fixed before push)

## Known Stubs

None. The `kind` column is properly wired from emit() through the INSERT to the DB; seeds union is a type widening with no placeholder data.

## Threat Flags

None. The new `kind` bound param extends the existing T-10-02 coverage (T-52-01 in the plan's threat register); no new trust boundaries introduced.

## Self-Check: PASSED
