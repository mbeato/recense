---
phase: 62-multi-inbox-email-ingest-hardening
plan: 08
subsystem: db-schema
tags: [migration, index-cleanup, gap-closure, WR-01]
dependency-graph:
  requires: [62-05]
  provides: [WR-01-closed]
  affects: [src/db/schema.ts, tests/schema.test.ts]
tech-stack:
  added: []
  patterns:
    - "In-place unversioned migration edit: DROP INDEX IF EXISTS inside an existing numbered
      migration block, mirroring the v5 dead-index cleanup precedent, when the migration runner
      is not version-gated (initSchema executes every block unconditionally on every call)."
key-files:
  created: []
  modified:
    - src/db/schema.ts
    - tests/schema.test.ts
decisions:
  - "Drop the index IN PLACE inside the existing v16 block, no SCHEMA_VERSION bump. Grounded in
    a source read of initSchema: no per-version gate exists, migrations are idempotent by their
    own guards (IF NOT EXISTS / IF EXISTS / PRAGMA table_info checks), and meta.schema_version is
    read only at the very end for the M-9 downgrade guard + stamp — it never gates which DDL runs.
    This mirrors the v5 migration's own DROP INDEX IF EXISTS precedent for idx_node_eviction and
    idx_activation_trace_ts."
metrics:
  duration: "~20 min"
  completed: 2026-07-30
---

# Phase 62 Plan 08: Drop dead idx_episode_event_ts Summary

Dropped `idx_episode_event_ts` in place inside the v16 migration block (no `SCHEMA_VERSION` bump), closing `62-REVIEW.md` WR-01 — the index shipped dead in the same migration whose own comment predicted exactly this outcome once 62-05 landed replay ordering in application code instead of SQL.

## What Was Built

**Task 1 — `src/db/schema.ts`:** Replaced the `CREATE INDEX IF NOT EXISTS idx_episode_event_ts ON episode(consolidated, event_ts)` statement in the v16 block with `DROP INDEX IF EXISTS idx_episode_event_ts;`, in the same `db.exec` template-literal position, immediately after the `event_ts` `ALTER TABLE` guard. Rewrote the preceding comment to record the decision (names WR-01, states the 62-05 in-memory-ordering fact, cites the v5 dead-index precedent, and notes the index should be re-added if a future change adds a SQL-level `ORDER BY`/`WHERE` on `event_ts`) instead of leaving the old "SPECULATIVE: ... should be dropped" prediction text in place. `SCHEMA_VERSION` stays `16`; the `event_ts` column DDL, its `ALTER TABLE` guard, and the `// v16:` naming comment at line 11 are all untouched.

**Task 2 — `tests/schema.test.ts`:** Extended the existing dead-index test (`idx_node_eviction`, `idx_activation_trace_ts`, L-7) to also assert `idx_episode_event_ts` is absent from a fresh in-memory DB, renamed to name all three and cite WR-01, with a one-line comment stating `event_ts` is ordered in application code by `orderEpisodesForConsolidation`, never in SQL. Added a second test in the same `describe` proving the migration path for the founder's already-migrated live database: run `initSchema(db)` once, manually re-create the index with a raw `CREATE INDEX IF NOT EXISTS` to simulate a DB migrated by the previous build, run `initSchema(db)` a second time, and assert the index is gone — with no version bump involved anywhere in the flow.

## Migration Mechanism Decision (grounded in source read)

`initSchema` has no per-version gate. Every migration block from v2 through v16 executes unconditionally on every call; each is made idempotent by its own guard (`CREATE ... IF NOT EXISTS`, `DROP ... IF EXISTS`, or a `PRAGMA table_info` column check), never by a stored-version comparison. `meta.schema_version` is read only at the very end (`src/db/schema.ts:649-665`) to throw on downgrade (M-9) and to stamp on fresh/upgrade — it never gates which DDL runs. Therefore replacing the `CREATE INDEX` with `DROP INDEX IF EXISTS` inside the v16 block executes against the founder's already-at-v16 live database on the very next `initSchema` call, with no version change required. This mirrors the v5 migration precedent already in the file (`DROP INDEX IF EXISTS idx_node_eviction; DROP INDEX IF EXISTS idx_activation_trace_ts;`), which runs unconditionally inside a numbered block the same way.

## Orphan-Check Grep Output (verbatim)

**`grep -rn "idx_episode_event_ts" src/ tests/`:**
```
tests/schema.test.ts:55:  it('does NOT create dead indexes idx_node_eviction, idx_activation_trace_ts (L-7), or idx_episode_event_ts (WR-01)', () => {
tests/schema.test.ts:75:      expect(episodeIndexes).not.toContain('idx_episode_event_ts');
tests/schema.test.ts:81:  it('removes idx_episode_event_ts from an already-migrated v16 DB on the next initSchema call, without a version bump (WR-01)', () => {
tests/schema.test.ts:86:      db.exec('CREATE INDEX IF NOT EXISTS idx_episode_event_ts ON episode(consolidated, event_ts)');
tests/schema.test.ts:93:      expect(episodeIndexes).not.toContain('idx_episode_event_ts');
src/db/schema.ts:280:  // idx_episode_event_ts: dropped (WR-01). Plan 62-05 landed the replay ordering entirely in
src/db/schema.ts:287:    DROP INDEX IF EXISTS idx_episode_event_ts;
```
Every hit is either the new `DROP` statement + its comment in `src/db/schema.ts`, or the two new assertions plus the simulated `CREATE` in `tests/schema.test.ts`. No orphaned reference.

**`grep -rniE "(order[[:space:]]+by|where).*event_ts" src/`:**
```
src/db/schema.ts:285:  // a SQL-level ORDER BY/WHERE on event_ts, re-add this index at that point.
src/consolidation/episode-order.ts:17: *   1. Collect the indices of rows where `event_ts !== null && event_ts !== undefined`.
```
Both hits are comment lines (`//` and `*` respectively after leading whitespace). Zero executable SQL matches — the gate passes.

**`grep -rn "ANALYZE" src/ tests/`:** no output (exit 1 / zero matches). No optimizer statistics depend on the dropped index.

## Untouched Confirmation

- `event_ts` column DDL (`src/db/schema.ts:38-40`) and its `ALTER TABLE` guard (`:276-278`): unchanged.
- `EpisodicStore.listUnconsolidated`'s SQL (`ORDER BY hard_keep DESC, salience DESC`): unchanged — `git diff --exit-code src/db/episode-store.ts` exits 0.
- `orderEpisodesForConsolidation` / `src/consolidation/episode-order.ts`: unchanged — `git diff --exit-code src/consolidation/episode-order.ts` exits 0.
- `SCHEMA_VERSION` stays `16` (`grep -n "export const SCHEMA_VERSION" src/db/schema.ts` → `= 16`).
- `grep -c "SPECULATIVE" src/db/schema.ts` returns `0` — the old prediction text is gone.

## Test Counts

- Plan's four targeted test files (Task 1 verify): 4 files / 110 tests passed.
- Task 2's six targeted test files: 6 files / 123 tests passed.
- `npx tsc --noEmit`: exit 0.
- Full suite (`npx vitest run`): **2879 passed / 4 skipped / 0 failed** (192 files passed, 1 skipped). Plan cited a pre-plan baseline of 2858 passed / 3 skipped / 0 failed captured at plan-writing time; this worktree's base branch already carries additional test/skip counts from other 62-wave work merged ahead of this plan (net +21 passed / +1 skipped from the cited figure, entirely additive — no failures, and this plan itself adds exactly 2 new passing tests to that delta). Zero test failures at any point.

## Deviations from Plan

None — plan executed exactly as written. Both tasks' acceptance criteria were verified via source-level grep/read before commit, matching every criterion listed in `62-08-PLAN.md`.

## Threat Flags

None — this plan closes a warning-severity finding (WR-01) with schema/test edits only, no new network endpoints, auth paths, file access patterns, or trust-boundary schema changes.

## Self-Check: PASSED

- FOUND: src/db/schema.ts
- FOUND: tests/schema.test.ts
- FOUND: .planning/phases/62-multi-inbox-email-ingest-hardening/62-08-SUMMARY.md
- FOUND commit: 0cebf73 (fix(62-08): drop dead idx_episode_event_ts in v16 migration block)
- FOUND commit: d3e73e2 (test(62-08): lock absence of idx_episode_event_ts on fresh + already-migrated DBs)
- FOUND commit: 9d62517 (docs(62-08): record 62-08 plan summary)
