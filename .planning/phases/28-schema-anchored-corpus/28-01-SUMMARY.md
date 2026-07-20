---
phase: 28-schema-anchored-corpus
plan: 01
subsystem: schema-db
tags: [migration, schema, ddl, test-scaffold, wave-0]
dependency_graph:
  requires: []
  provides: [v12-edge-ddl, corpus-test-scaffolds]
  affects: [schema.ts, edge-kind-check, downstream-plans-28-02-03-04]
tech_stack:
  added: []
  patterns: [sqlite-table-recreation-migration, describe-skip-wave0-scaffold]
key_files:
  created:
    - tests/schema-v12-migration.test.ts
    - tests/corpus-promoter.test.ts
  modified:
    - src/db/schema.ts
    - tests/schema-v11-migration.test.ts
    - tests/schema.test.ts
    - tests/doc-gather.test.ts
    - tests/viz-corpus-graph.test.ts
    - tests/activation-sink.test.ts
    - tests/node-scope-schema.test.ts
    - tests/node-temporal-schema.test.ts
    - tests/surfaced-event-schema.test.ts
decisions:
  - "v12 edge.kind CHECK = 7 values: relation, abstracts, schema_rel, cites, doc_link, doc_containment, doc_reference"
  - "doc_link retained (not retired) — scope-doc cross-links still use it per RESEARCH §Note on doc_link"
  - "Migration guard reads live sqlite_master DDL: if (!edgeDdlV12.includes(\"'doc_containment'\")) — same pattern as v11"
  - "Wave-0 scaffolds use describe.skip / it.todo — zero failing tests, 34 pending todos downstream plans fulfill"
  - "Updated 7 test files to assert SCHEMA_VERSION=12 (Rule 1: version stamp tests were correct assertions, not over-specified)"
metrics:
  duration: "~12 minutes"
  completed: "2026-06-19"
  tasks_completed: 2
  files_modified: 9
---

# Phase 28 Plan 01: v12 Schema Migration + Wave-0 Scaffolds Summary

v12 migration extends edge.kind CHECK to permit `doc_containment` and `doc_reference`; SCHEMA_VERSION bumped 11→12; three Wave-0 test scaffolds created as failing targets for plans 28-02/03/04.

## Tasks Completed

| Task | Description | Commit | Key Files |
|------|-------------|--------|-----------|
| 1 | v12 edge-kind migration: add doc_containment + doc_reference to edge.kind CHECK, bump SCHEMA_VERSION 11→12 | `cfa8009` | src/db/schema.ts, tests/schema-v11-migration.test.ts, tests/schema.test.ts |
| 2 | v12 migration test (17 assertions) + three Wave-0 scaffolds; fix version stamps in suite (7 files) | `04166e5` | tests/schema-v12-migration.test.ts, tests/corpus-promoter.test.ts, tests/doc-gather.test.ts, tests/viz-corpus-graph.test.ts + 5 stamp fixes |

## What Was Built

### src/db/schema.ts (v12 migration)

- `SCHEMA_VERSION` bumped from 11 to 12.
- Canonical `edge` DDL CHECK (for fresh DBs) extended to include `doc_containment` and `doc_reference`.
- New v12 migration block added after the v11 edge block (lines ~431-465): reads live `sqlite_master` DDL, guards on `'doc_containment'` absence, runs `FOREIGN_KEYS OFF → BEGIN; CREATE edge_v12; INSERT SELECT; DROP; RENAME; COMMIT; → idx_edge_dst; FOREIGN_KEYS ON`. Idempotent re-runs are no-ops. Mirrors v11 pattern exactly per T-28-FK mitigation.
- `doc_link` remains in the CHECK (not retired).
- The existing version-stamp guard at the bottom handles 11→12 stamping automatically.

### tests/schema-v12-migration.test.ts (17 tests — GREEN)

Verifies:
- (a/b) Fresh DB: `doc_containment`, `doc_reference`, `doc_link` inserts succeed; bogus kind rejected.
- (c) Pre-v12 DB (v11-shaped): migration runs, new kinds succeed, seeded rows preserved.
- (d) `PRAGMA foreign_key_check` empty after migration (T-28-FK).
- (e) Idempotency: second `initSchema` is a no-op (no duplicate rows, no errors).
- (f) `meta.schema_version == '12'` after migration.
- Downgrade guard: stored > SCHEMA_VERSION still throws.

### Wave-0 Scaffolds (INTENTIONALLY FAILING TARGETS)

The plan notes explicitly that these scaffolds are expected to remain red until the downstream plans land. They are all `describe.skip` / `it.todo` so the full suite stays GREEN after this plan.

| File | Requirement | Downstream Plan |
|------|-------------|-----------------|
| `tests/corpus-promoter.test.ts` (new) | CORPUS-02 (mass gate + noise filter), CORPUS-03 (ladder enrichment), CORPUS-05 (self-confirmation guard D-43) | Plan 28-03 |
| `tests/doc-gather.test.ts` (extended) | CORPUS-01 (`gatherFactsForSchema` schema-anchored gather) | Plan 28-02 |
| `tests/viz-corpus-graph.test.ts` (extended) | CORPUS-04 (`doc_containment`/`doc_reference` corpus endpoint + renderer) | Plan 28-04 |

**The 34 `it.todo` entries in the Wave-0 scaffolds are the precise failing targets that plans 28-02, 28-03, 28-04 must make green.**

### Version Stamp Fixes (7 test files — Rule 1)

Seven other test files had hardcoded `toBe(11)` / `toBe('11')` assertions that broke when SCHEMA_VERSION bumped. Updated to 12: `activation-sink.test.ts`, `node-scope-schema.test.ts`, `node-temporal-schema.test.ts`, `surfaced-event-schema.test.ts`, `schema.test.ts`, `schema-v11-migration.test.ts`. The dist binary was rebuilt (`npm run build` → tsc clean) so `adapter-inject.test.ts`'s compiled-CLI tests could resolve the new version.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Version stamp assertions in 7 test files broke after SCHEMA_VERSION bump**
- **Found during:** Task 1 verification (first full `npx vitest run`)
- **Issue:** 5 test files (`activation-sink`, `node-scope-schema`, `node-temporal-schema`, `surfaced-event-schema`, `schema.test.ts`) plus the modified `schema-v11-migration.test.ts` and `schema.test.ts` had hardcoded `toBe(11)` / `toBe('11')` assertions. `adapter-inject.test.ts` failed because the compiled binary at `dist/` still reported version 11 (downgrade guard threw), causing CLI tests to see empty output.
- **Fix:** Updated all 7 test files to assert 12. Ran `npm run build` to rebuild the dist binary with the new SCHEMA_VERSION constant.
- **Files modified:** 7 test files + dist rebuild
- **Commit:** `04166e5`

**2. [Rule 1 - Bug] corpus-promoter.test.ts missing vitest imports**
- **Found during:** Task 2 verification
- **Issue:** The scaffold file had no import statement — `describe` and `it` were undefined at runtime.
- **Fix:** Added `import { describe, it } from 'vitest';`
- **Commit:** `04166e5`

**3. [Rule 1 - Bug] doc-gather.test.ts missing `it` import for Wave-0 stub**
- **Found during:** Task 2 verification
- **Issue:** The file imported `test` but not `it`; the new `describe.skip` block used `it.todo`.
- **Fix:** Added `it` to the existing vitest import line.
- **Commit:** `04166e5`

## Known Stubs

The Wave-0 scaffolds are intentional stubs by plan design. They are `describe.skip` blocks that reference:
- `CorpusPromoter` (not yet created — plan 28-03 creates `src/consolidation/corpus-promoter.ts`)
- `gatherFactsForSchema` (not yet exported — plan 28-02 adds it to `src/reader/doc-gather.ts`)
- `doc_containment`/`doc_reference` corpus endpoint behavior (not yet wired — plan 28-04)

These stubs do NOT prevent the plan's goal (DDL migration + test scaffolds) from being achieved. They are explicitly the Wave-0 deliverable.

## Threat Flags

No new network endpoints, auth paths, or file-access patterns introduced. The v12 migration follows the established table-recreation pattern and only extends an existing CHECK constraint.

## Self-Check: PASSED

- `src/db/schema.ts` exists with `SCHEMA_VERSION = 12` and `doc_containment` in CHECK: FOUND
- `tests/schema-v12-migration.test.ts` exists: FOUND
- `tests/corpus-promoter.test.ts` exists with CORPUS-02/03/05 describe blocks: FOUND
- `gatherFactsForSchema` in `tests/doc-gather.test.ts`: FOUND (4 occurrences)
- `doc_containment|doc_reference` in `tests/viz-corpus-graph.test.ts`: FOUND (12 occurrences)
- Commit `cfa8009` (Task 1): FOUND
- Commit `04166e5` (Task 2): FOUND
- Full suite result: 1703 passing, 34 todo, 0 failing
