---
phase: 21-engine-surfacing-api
plan: "01"
subsystem: db/schema
tags: [schema, sqlite, ddl, migration, surfacing, surf-02]
dependency_graph:
  requires: []
  provides: [surfaced_event-table, schema-v9]
  affects: [21-02, 21-03, 21-04]
tech_stack:
  added: []
  patterns: [create-table-if-not-exists, additive-migration, check-constraint, unique-constraint]
key_files:
  created:
    - tests/surfaced-event-schema.test.ts
  modified:
    - src/db/schema.ts
decisions:
  - "SCHEMA_VERSION bumped to 9 (additive; existing v8 DBs upgrade on first initSchema call)"
  - "surfaced_event uses INTEGER PRIMARY KEY AUTOINCREMENT (matches activation_trace precedent)"
  - "UNIQUE(node_id, occurrence_due_at) enforced at DDL level — idempotency guard at storage layer"
  - "outcome CHECK constraint at DDL level — defense-in-depth per T-21-01 threat mitigation"
  - "v9 migration adds two covering indexes: node_occ (exclusion query) + outcome (cap-window count)"
metrics:
  duration: "~8 minutes"
  completed: "2026-06-16"
  tasks_completed: 2
  files_changed: 2
---

# Phase 21 Plan 01: surfaced_event DDL + v9 Migration Summary

surfaced_event operational table at schema v9 — UNIQUE idempotency key, outcome CHECK enum, two covering indexes, proven by 6-assertion schema round-trip test.

## What Was Built

### Task 1 — surfaced_event DDL + v9 migration (commit: 26564e9)

Modified `src/db/schema.ts`:

- `SCHEMA_VERSION` bumped from `8` to `9`
- `surfaced_event` DDL added inside the main DDL template string after `node_temporal`, with:
  - `id INTEGER PRIMARY KEY AUTOINCREMENT`
  - `node_id TEXT NOT NULL REFERENCES node(id)`
  - `occurrence_due_at TEXT NOT NULL` (ISO-8601 UTC; the due_at at surface time)
  - `outcome TEXT NOT NULL DEFAULT 'surfaced' CHECK(outcome IN ('surfaced','seen','snoozed','completed','dismissed'))`
  - `snooze_until TEXT` (nullable; non-null when outcome='snoozed')
  - `created_at INTEGER NOT NULL` (epoch ms; immutable)
  - `updated_at INTEGER NOT NULL` (epoch ms; updated on every outcome change)
  - `UNIQUE(node_id, occurrence_due_at)` table-level constraint
- DDL comment marks it as SURF-02 operational/single-writer (sleep pass never touches it — D-08)
- v9 migration block added after v8 block, before the schema-version stamp:
  - `idx_surfaced_event_node_occ ON surfaced_event(node_id, occurrence_due_at)`
  - `idx_surfaced_event_outcome ON surfaced_event(outcome, snooze_until)`
- Schema-version stamp block untouched; stamps itself from `SCHEMA_VERSION = 9`

### Task 2 — Schema round-trip + migration idempotency test (commit: 2136da4)

Created `tests/surfaced-event-schema.test.ts` (6 vitest assertions, pure DB-layer):

1. `PRAGMA table_info(surfaced_event)` returns exactly 7 columns with expected names
2. `SELECT value FROM meta WHERE key='schema_version'` returns `'9'`
3. INSERT with `outcome='banana'` throws (CHECK constraint enforced)
4. Two INSERTs sharing `(node_id, occurrence_due_at)` — second throws (UNIQUE enforced)
5. Double `initSchema(db)` does not throw and table still present (idempotent migration)
6. Node seeded first lets `surfaced_event` row reference it (FK resolves)

## Verification

- `npx tsc --noEmit` — clean (zero errors)
- `npx vitest run tests/surfaced-event-schema.test.ts` — 6/6 passed
- `grep -rn "surfaced_event" src/sleep/` — zero matches (D-08 invariant confirmed)
- `grep -rn "surfaced_event" src/` (excluding schema.ts) — zero matches

## Deviations from Plan

None — plan executed exactly as written.

Note on TDD ordering: Task 2 is marked `tdd="true"` but Task 1 (implementation) was executed first per plan ordering. Both tasks are in the same plan; the schema was already green when the tests were written. This is the expected intra-plan sequence — Task 1 is the implementation wave and Task 2 is the verification wave.

## Threat Flags

No new security surface introduced beyond what the plan's threat model covers. T-21-01 (CHECK constraint) and T-21-02 (UNIQUE constraint) mitigations are in place at the DDL level.

## Known Stubs

None.

## Self-Check: PASSED

- [x] `src/db/schema.ts` modified: surfaced_event DDL at line 136, SCHEMA_VERSION=9 at line 11, v9 migration at lines 298-311
- [x] `tests/surfaced-event-schema.test.ts` created (170 lines)
- [x] Commit 26564e9 exists (Task 1)
- [x] Commit 2136da4 exists (Task 2)
