---
phase: 25-entity-dedup-prune
plan: "01"
subsystem: consolidation
tags: [entity-dedup, edge-rewire, tombstone, fk-safety, tdd]
dependency_graph:
  requires: []
  provides: [EntityDedup-class, entity_merge-event-type, deleteEdge-store-primitive, getEdgesForNode-store-primitive]
  affects: [src/consolidation/entity-dedup.ts, src/consolidation/sink.ts, src/db/semantic-store.ts]
tech_stack:
  added: []
  patterns: [union-find-clustering, precision-first-two-stage-matching, fk-safe-delete-before-upsert, immediate-transaction-mode]
key_files:
  created:
    - src/consolidation/entity-dedup.ts
    - tests/entity-dedup.test.ts
  modified:
    - src/consolidation/sink.ts
    - src/db/semantic-store.ts
decisions:
  - "D-01: Two-stage precision-first matching — normalizeValue blocking then cosineSimF32 >= 0.88"
  - "D-02: Deterministic stable-id iteration → second run = no-op"
  - "D-03: Transitive union-find clustering within a run"
  - "D-04: Origin guard — skip prev_value (mid-reconciliation) + cross-origin non-identical"
  - "D-05: Canonical = highest edge-degree → highest c → earliest last_access → lex id"
  - "D-07: Edge rewire with PK-collision max(w) merge and self-loop drop"
  - "D-08: PRAGMA foreign_key_check asserted inside transaction → throw/rollback if non-empty"
  - "D-09: Duplicates tombstoned via store.tombstone(), never deleted"
  - "D-10: entity_merge consolidation_event emitted per duplicate with cosine as magnitude"
  - "CONSOL-03: All node/edge writes route through SemanticStore primitives — no raw SQL writes in entity-dedup.ts"
metrics:
  duration: "~25 minutes"
  completed: "2026-06-18"
  tasks_completed: 2
  files_modified: 4
---

# Phase 25 Plan 01: Entity Dedup Engine Summary

**One-liner:** LLM-free entity dedup engine with cosine-gated two-stage clustering, union-find transitive closure, FK-safe delete-before-upsert edge rewire, and tombstone-not-delete — all 12 behavior tests green.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Extend sink event union + add store rewire helpers | d9d0def | src/consolidation/sink.ts, src/db/semantic-store.ts |
| 2 (RED) | Failing entity-dedup test suite | bfb0e18 | tests/entity-dedup.test.ts |
| 2 (GREEN) | EntityDedup class implementation + all tests green | 0739d58 | src/consolidation/entity-dedup.ts, tests/entity-dedup.test.ts |

## What Was Built

### Task 1: sink.ts + semantic-store.ts additions

- `'entity_merge'` added to `ConsolidationEventType` union in `sink.ts` (after `'schema_falsified'`)
- `deleteEdge(src, dst, rel): void` — bound-param prepared statement `DELETE FROM edge WHERE src = ? AND dst = ? AND rel = ?` on `SemanticStore`; declared as `private readonly stmtDeleteEdge`
- `getEdgesForNode(nodeId): EdgeRow[]` — bound-param prepared statement `SELECT src, dst, rel, w, last_access, kind FROM edge WHERE src = ? OR dst = ?` on `SemanticStore`; declared as `private readonly stmtGetAllEdgesForNode`

Both follow the exact constructor-compiled prepared-statement pattern of existing SemanticStore methods. No string interpolation anywhere (T-01-SQL).

### Task 2: EntityDedup class (src/consolidation/entity-dedup.ts, 455 lines)

**Constructor:** `(db, store, sink, clock, config)` — compiles two read-side prepared statements (`stmtLiveEntities`, `stmtNodeDegree`).

**Public API:** `run({ threshold, dryRun }): DedupResult` returning `{ clusters, mergedClusters, tombstoned }`.

**Algorithm phases:**
- Phase A (in-memory, before any transaction):
  1. Snapshot `node WHERE type='entity' AND tombstoned=0 ORDER BY id` (deterministic — D-02)
  2. Stage-1 blocking: bucket by `normalizeValue(node.value)` (D-01)
  3. Origin guard filter: exclude `prev_value !== null` nodes from eligible set (D-04)
  4. Stage-2 cosine confirmation: `cosineSimF32 >= threshold` per pair within bucket (D-01)
  5. Cross-origin non-identical guard: skip pairs crossing `asserted_by_user↔inferred` boundary with different values (D-04)
  6. Union-find transitive closure → cluster groups (D-03)
  7. Canonical selection per cluster: highest edge degree → highest c → earliest last_access → lex id (D-05)
  8. Pre-read sidecar state (`getNodeScope`, `getNodeTemporal`) before transaction
- Phase B (one `db.transaction(() => { ... }).immediate()` per cluster — M-5, T-02-ASYNC):
  1. Edge rewire: `store.deleteEdge(old)` FIRST then `store.upsertEdge(canonical)` — FK-safe order (T-FK-01, D-08); PK collision → `max(w)` / latest `last_access` (D-07); self-loops dropped (D-07)
  2. Sidecar inheritance if canonical has none (D-06)
  3. `PRAGMA foreign_key_check` assertion → throw/rollback if non-empty (D-08)
  4. `store.tombstone(dup)` per duplicate — never raw DELETE (D-09)
  5. `sink.emit({ event_type: 'entity_merge', ... })` per duplicate — sync, inside transaction (T-05-SINK-TX, D-10)

**Dry-run:** returns computed clusters with zero DB writes.

### Test Suite (tests/entity-dedup.test.ts, 12 tests)

| Test | Behavior | Decision |
|------|----------|----------|
| 1 | Repeatability: second run returns 0 merges | D-02 / DEDUP-01 |
| 2 | Edge inheritance: leaf edge rewired to canonical | DEDUP-02 |
| 3 | PK collision: max(w) + latest last_access survives | D-07 |
| 4 | Self-loop drop: dup→can becomes can→can, dropped | D-07 |
| 5 | Tombstone-not-delete: dup row exists with tombstoned=1 | D-09 |
| 6 | FK clean: PRAGMA foreign_key_check empty post-merge | D-08 |
| 7 | Origin guard: prev_value node not merged | D-04 |
| 7b | Origin guard: cross-origin non-identical not merged | D-04 |
| 8 | Provenance: entity_merge event with node_id/candidate_id | D-10 |
| 9 | Canonical selection: highest-degree node wins, keeps id | D-05 |
| 10 | Transitive cluster: A~B + B~C → one canonical for {A,B,C} | D-03 |
| bonus | Dry-run: no DB writes, no events emitted | D-11 |

All 12 tests pass with vitest; `npx tsc --noEmit` is clean.

## FK Invariant Holds

The edge-rewire follows the exact T-FK-01 lesson from consolidator.ts:
1. `store.deleteEdge(oldSrc, oldDst, rel)` — remove the old edge from `edge` table
2. `store.upsertEdge({ src: newSrc, dst: newDst, ... })` — insert canonical-pointing edge

This ensures no FK window where `edge.src` or `edge.dst` references a non-existent node id. The `PRAGMA foreign_key_check` assertion inside every transaction provides the final safety net.

No `await` appears inside any `db.transaction` callback (T-02-ASYNC). All graph writes go through `SemanticStore` primitives — `grep -nE "DELETE FROM node|INSERT INTO node|UPDATE node|INSERT INTO edge|DELETE FROM edge" entity-dedup.ts` returns nothing (CONSOL-03).

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written.

### Minor Design Note: Test Canon Node ID

The initial test design assumed hardcoded `'canonical'` and `'duplicate'` node IDs would map to canonical/duplicate respectively. Canonical selection depends on edge degree at runtime. The tests were corrected (still in RED → GREEN commit) to give the intended canonical node more edges before running the pass — consistent with D-05 semantics. This is a test design clarification, not a plan deviation.

## Known Stubs

None — all behavior is implemented and wired to real data.

## Threat Flags

None — this plan adds no new network endpoints, no auth paths, no external file access, and no trust-boundary crossing. The only mutation surface is the local SQLite graph (single-tenant, offline pass). All threat mitigations from the plan's threat register are implemented and tested (T-25-01 through T-25-05).

## Self-Check: PASSED

- [x] `src/consolidation/entity-dedup.ts` exists (455 lines, contains `export class EntityDedup` and `run(`)
- [x] `tests/entity-dedup.test.ts` exists (12 tests, all passing)
- [x] `src/consolidation/sink.ts` contains `entity_merge` in ConsolidationEventType union
- [x] `src/db/semantic-store.ts` contains `deleteEdge` and `getEdgesForNode` public methods
- [x] Commit d9d0def exists (Task 1)
- [x] Commit bfb0e18 exists (RED tests)
- [x] Commit 0739d58 exists (GREEN implementation)
- [x] `npx tsc --noEmit` clean
- [x] `npx vitest run tests/entity-dedup.test.ts` exits 0 (12 tests pass)
