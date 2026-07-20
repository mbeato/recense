---
phase: 25-entity-dedup-prune
plan: "02"
subsystem: adapter/consolidation
tags: [dedup, cli, dry-run, entity-merge]
dependency_graph:
  requires: [25-01]
  provides: [dedup-entities-cli, recense-dispatcher-dedup]
  affects: [src/adapter/recense.ts, src/adapter/dedup-entities-cli.ts]
tech_stack:
  added: []
  patterns: [dry-run-default, lock-before-db, spawn-script-dispatch, require.main-guard]
key_files:
  created:
    - src/adapter/dedup-entities-cli.ts
    - tests/dedup-entities-cli.test.ts
  modified:
    - src/adapter/recense.ts
decisions:
  - "Dry-run default via --no-dry-run opt-out (not --dry-run opt-in) — both flags supported; real run requires explicit --no-dry-run"
  - "DB opened read-only for dry-run (no lock needed); lock acquired ONLY for mutating run (WR-02)"
  - "printDryRun exported from CLI for test-harness injection (avoids subprocess spawn)"
metrics:
  duration: ~15m
  completed: "2026-06-18"
  tasks_completed: 2
  files_changed: 3
---

# Phase 25 Plan 02: dedup-entities CLI adapter + dispatcher wiring Summary

**One-liner:** Opt-in `recense dedup-entities` CLI wrapping EntityDedup with write-nothing dry-run as default, dispatched via the recense spawn-script pattern.

## Tasks Completed

| Task | Description | Commit |
|------|-------------|--------|
| 1 | dedup-entities-cli.ts — dry-run default, --threshold, DB-path-before-lock | de4a9c4 |
| 2 | recense.ts dispatcher case + dedup-entities-cli.test.ts (3 tests, exits 0) | 72acd81 |

## What Was Built

**src/adapter/dedup-entities-cli.ts** (155 lines):
- Wraps the `EntityDedup` engine from Plan 25-01
- `--dry-run` is the DEFAULT: any invocation without `--no-dry-run` is a safe, write-nothing report
- `--no-dry-run` triggers the real mutating run (D-11 opt-in design)
- `--threshold <n>` overrides the 0.88 default (D-01)
- `--db <path>` or `RECENSE_DB` env resolves the DB path
- DB path validated BEFORE `acquireLock()` (WR-02 lock-leak prevention)
- Dry-run: opens DB read-only, calls `EntityDedup.run({ dryRun: true })`, prints cluster report via `process.stdout.write`
- Real run: acquires shared write lock, constructs full store stack, calls `EntityDedup.run({ dryRun: false })`
- `printDryRun()` helper exported for unit test injection
- `require.main === module` guard: no side effects when imported by tests

**src/adapter/recense.ts** (2 lines modified):
- `case 'dedup-entities': spawnScript('dedup-entities-cli.js', process.argv.slice(3)); break;`
- `dedup-entities` added to the default-case usage Commands string

**tests/dedup-entities-cli.test.ts** (3 tests, vitest exits 0):
- Test 1: dry-run returns 1 cluster / 1 duplicate; `tombstoned=0` in DB; edge unchanged; 0 consolidation_event rows
- Test 2: dry-run cluster report contains canonical value and cosine >= threshold
- Test 3: `printDryRun` writes expected header and summary line to stdout (stdout.write spy)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Edge kind CHECK constraint**
- **Found during:** Task 2 test run
- **Issue:** `insertEdge` helper used `kind='related'` but the schema has `CHECK(kind IN ('relation','abstracts','schema_rel'))`
- **Fix:** Changed test helper to use `kind='relation'`
- **Files modified:** tests/dedup-entities-cli.test.ts
- **Commit:** 72acd81

No other deviations. Plan executed as specified.

## Verification

- `npx tsc --noEmit` — clean (no errors in dedup-entities-cli.ts or recense.ts)
- `npx vitest run tests/dedup-entities-cli.test.ts` — 3/3 passed
- `grep -c "dedup-entities" src/adapter/recense.ts` returns 3 (comment, dispatch case, usage list)
- `grep -n "fallbackToDefault: false"` lines 75 and 105 (both before acquireLock at line 114)
- `grep -n "0.88"` line 69 (D-01 default threshold)
- NOT wired into run-sleep-pass.ts or sleep-pass-cli.ts (D-11 confirmed)

## Known Stubs

None. The dry-run path is intentionally write-nothing by design (not a stub).

## Threat Flags

None. No new network endpoints, auth paths, or schema changes. The CLI touches only the existing write-lock and DB-open patterns, both already in the threat model (T-25-07, T-25-08).

## Self-Check: PASSED

- src/adapter/dedup-entities-cli.ts: FOUND
- src/adapter/recense.ts: FOUND (modified)
- tests/dedup-entities-cli.test.ts: FOUND
- commit de4a9c4: FOUND
- commit 72acd81: FOUND
