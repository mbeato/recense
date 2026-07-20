---
phase: 27-reader-layer
plan: "01"
subsystem: schema
tags: [schema, migration, types, store-primitives, tdd]
dependency_graph:
  requires: []
  provides: [v11-schema, node-doc-sidecar, NodeDocRow, upsertNodeDoc, getNodeDoc]
  affects: [src/db/schema.ts, src/lib/types.ts, src/db/semantic-store.ts]
tech_stack:
  added: []
  patterns: [table-recreation-migration, sidecar-table, write-once-generated-at, ON-CONFLICT-preserve-column]
key_files:
  created:
    - tests/schema-v11-migration.test.ts
    - tests/node-doc-store.test.ts
  modified:
    - src/db/schema.ts
    - src/lib/types.ts
    - src/db/semantic-store.ts
    - tests/activation-sink.test.ts
    - tests/node-scope-schema.test.ts
    - tests/node-temporal-schema.test.ts
    - tests/schema.test.ts
    - tests/surfaced-event-schema.test.ts
decisions:
  - "generated_at is a dedicated node_doc column (not node.last_access) so the staleness predicate cannot be corrupted by doc access events"
  - "ON CONFLICT(node_id) DO UPDATE SET slug=excluded.slug, updated_at=excluded.updated_at — explicitly omitting generated_at makes it write-once at the SQL layer"
  - "node/edge table recreations both wrapped in BEGIN/COMMIT for T-27-01 atomicity (mirrors v7 CR-02 pattern)"
  - "Migration guard checks live DDL string from sqlite_master before recreating — idempotent re-run safe (T-27-02)"
metrics:
  duration: "~25 min"
  completed: "2026-06-18"
  tasks_completed: 2
  files_changed: 10
---

# Phase 27 Plan 01: v11 Schema + NodeDoc Types + Store Primitives Summary

**One-liner:** SQLite schema v11 with doc/cites/doc_link CHECK extensions + node_doc sidecar + write-once generated_at primitive on SemanticStore.

## What Was Built

### Task 1: v11 schema migration

- `SCHEMA_VERSION` bumped from 10 to 11
- DDL const updated: `node.type` CHECK extended to include `'doc'`; `edge.kind` CHECK extended to include `'cites'` and `'doc_link'`
- New `node_doc` sidecar table added to DDL (mirrors `node_scope`/`node_temporal` precedent): `node_id TEXT PRIMARY KEY REFERENCES node(id)`, `slug TEXT NOT NULL`, `generated_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL`. The `generated_at` is a dedicated column — explicitly not `node.last_access` — so the READER-03 staleness predicate (`node.last_access > doc.generated_at`) cannot be corrupted when the doc node is accessed.
- v11 migration guard for `node` table: reads live DDL from `sqlite_master`, skips if `'doc'` already present, otherwise runs atomic `BEGIN; CREATE node_v11 / INSERT SELECT / DROP / RENAME; COMMIT` + re-creates `idx_node_dirty` and `node_fts`.
- v11 migration guard for `edge` table: same pattern, skips if `'cites'` already present, adds `'cites'` and `'doc_link'` to CHECK.
- `CREATE INDEX IF NOT EXISTS idx_node_doc_slug ON node_doc(slug)` added in the v11 migration block.
- 19 tests in `tests/schema-v11-migration.test.ts` all green.

### Task 2: NodeDoc types + store primitives

- `src/lib/types.ts`: `NodeType` union extended with `'doc'`; `EdgeKind` union extended with `'cites'` and `'doc_link'`; new `UpsertNodeDocParams` and `NodeDocRow` interfaces added (mirror `UpsertNodeScopeParams`/`NodeTemporalRow` pattern).
- `src/db/semantic-store.ts`: two new prepared statements (`stmtUpsertNodeDoc` with `ON CONFLICT DO UPDATE SET slug, updated_at` — deliberately omitting `generated_at` to make it write-once at the SQL layer; `stmtGetNodeDoc`). Public methods `upsertNodeDoc(params)` and `getNodeDoc(nodeId): NodeDocRow | undefined` exposed.
- 5 tests in `tests/node-doc-store.test.ts` all green.
- `npx tsc --noEmit` clean.
- Full suite: 108 test files passing, 1 skipped, 0 failures.

## Commits

| Hash | Description |
|------|-------------|
| `5c7cffb` | test(27-01): add failing v11 schema migration tests (RED) |
| `2e9eda7` | feat(27-01): v11 schema migration — node.type+'doc', edge.kind+'cites'/'doc_link', node_doc sidecar |
| `540e853` | test(27-01): add failing node-doc-store tests (RED) |
| `18d06b0` | feat(27-01): NodeDoc types + SemanticStore.upsertNodeDoc/getNodeDoc primitives |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated 5 existing tests that hardcoded SCHEMA_VERSION=10**
- **Found during:** Task 2 GREEN verification (full suite run)
- **Issue:** After bumping SCHEMA_VERSION from 10 to 11, 5 test files had hardcoded literal `toBe(10)` or `toBe('10')` assertions that failed
- **Fix:** Updated test descriptions and assertions to 11 in `activation-sink.test.ts`, `node-scope-schema.test.ts`, `node-temporal-schema.test.ts`, `schema.test.ts`, `surfaced-event-schema.test.ts`
- **Files modified:** 5 test files
- **Commit:** `18d06b0`

**2. [Rule 1 - Bug] Rebuilt dist after schema version bump**
- **Found during:** Task 2 GREEN verification
- **Issue:** The stale compiled CLI (`dist/src/adapter/session-start-cli.js`) had SCHEMA_VERSION=10 embedded; `adapter-inject.test.ts` tests (b) and (e) failed because the CLI checked `stored_version !== SCHEMA_VERSION` and returned empty context for freshly-created v11 DBs
- **Fix:** `npm run build` rebuilt the dist with SCHEMA_VERSION=11
- **Files modified:** dist/ (gitignored)
- **Commit:** `18d06b0` (included in the feat commit)

## Known Stubs

None. This plan adds pure schema + store primitives with no UI surface.

## Threat Flags

None. All threat register items from the plan's `<threat_model>` were addressed:
- **T-27-01** (atomicity): both node and edge table recreations wrapped in `BEGIN/COMMIT` inside a single `db.exec()` call.
- **T-27-02** (idempotency): migration guards check live DDL from `sqlite_master` before running; re-run is a no-op if the constraint already includes `'doc'`/`'cites'`.
- FK integrity verified via `PRAGMA foreign_key_check` (asserted empty in test suite after migration).

## Self-Check: PASSED

- `src/db/schema.ts` — FOUND, SCHEMA_VERSION=11 confirmed
- `src/lib/types.ts` — FOUND, NodeDocRow + UpsertNodeDocParams present
- `src/db/semantic-store.ts` — FOUND, upsertNodeDoc + getNodeDoc present
- `tests/schema-v11-migration.test.ts` — FOUND, 19 tests pass
- `tests/node-doc-store.test.ts` — FOUND, 5 tests pass
- Commits `5c7cffb`, `2e9eda7`, `540e853`, `18d06b0` — all verified in git log
