---
phase: 21-engine-surfacing-api
plan: "04"
subsystem: test/sentinel
tags: [sentinel, integration-test, surf-03, d-43, d-05, d-07, d-08, sc2, sc3, phase-22-gate]
dependency_graph:
  requires:
    - phase: 21-03
      provides: GET /v1/surface + POST /v1/surface/seen routes (routes under test)
    - phase: 21-02
      provides: SurfaceStore.rank() — the ranking engine exercised by these tests
    - phase: 21-01
      provides: surfaced_event DDL + UNIQUE idempotency key
  provides:
    - D-43 self-confirmation sentinel (SURF-03 / SC3 Phase 22 blocking gate)
    - GET /v1/surface ranking integration proof (P0 before lower-tier)
    - D-05 idempotency proof (double-POST → 1 row, last-writer-wins)
    - D-07 exclusion proof (dismissed → absent from GET)
    - D-08 grep guard (SC2 — zero surfaced_event refs in consolidation source)
  affects: [phase-22-push-notify]
tech_stack:
  added: []
  patterns:
    - serve-cli-test-harness (temp DB + hermetic RECENSE_LOCK_PATH + free port)
    - before-after-db-snapshot (open seedDb, read baseline, close, call API, reopen checkDb)
    - in-process-fs-grep (D-08 check via fs.readdirSync + readFileSync — no shell-out)
key_files:
  created:
    - tests/surface-sentinel.test.ts
  modified: []
key-decisions:
  - "Both TDD tasks committed in one atomic commit (same file) — RED/GREEN conceptual phases collapsed since 21-03 implementation is already in place"
  - "action_type 'travel' invalid — CHECK constraint allows only 7 values; fixed to 'flight' (Rule 1 auto-fix)"
  - "D-08 check uses in-process fs.readdirSync/readFileSync over src/consolidation/*.ts — guards vacuity with expect(tsFiles.length).toBeGreaterThan(0)"
requirements-completed: [SURF-03]
duration: ~8min
completed: "2026-06-16"
---

# Phase 21 Plan 04: D-43 Self-Confirmation Sentinel Summary

D-43 self-confirmation sentinel (SURF-03 / SC3 Phase 22 hard gate) proven green: node.s and node.c are byte-identical before and after a full GET /v1/surface + POST /v1/surface/seen cycle, plus ranking order (P0 first), D-05 idempotency (1 row per occurrence key), D-07 exclusion (dismissed items absent), input validation (400/404), and D-08 grep guard (zero surfaced_event refs in consolidation source) — 7 tests, all green.

## Performance

- **Duration:** ~8 min
- **Completed:** 2026-06-16
- **Tasks:** 2 (Task 1: sentinel; Task 2: integration + D-08 guard — single file, single commit)
- **Files created:** 1

## Accomplishments

### Task 1 — D-43 self-confirmation sentinel (commit: 2bf6ec2)

Created `tests/surface-sentinel.test.ts`:

**`describe('D-43 self-confirmation sentinel')`** — 1 test:
- Seeds `sentinel-node` with `s=0.42, c=0.65` and `node_temporal` due 1h from now via `SemanticStore`
- Captures `before = SELECT s, c FROM node WHERE id = 'sentinel-node'`
- GET `/v1/surface` → 200; asserts sentinel-node present at tier=0 (P0)
- POST `/v1/surface/seen` with `occurrence_due_at = sentinelItem.due_at, outcome: 'seen'` → 200
- Reopens a fresh Database, reads `after = SELECT s, c FROM node WHERE id = 'sentinel-node'`
- `expect(after.s).toBe(before.s)` and `expect(after.c).toBe(before.c)` — SURF-03 / SC3 blocking gate assertions

### Task 2 — Endpoint integration (same commit: 2bf6ec2)

Added 6 more tests across 3 describe blocks:

**`describe('GET /v1/surface ranking')`** — 1 test:
- Seeds P0 item (2h → tier=0) + two lower-tier items (3d, 5d → tier=1)
- Asserts P0 index < both lower-tier indices

**`describe('POST /v1/surface/seen idempotency + exclusion')`** — 4 tests:
- D-05: Two POSTs with same `(node_id, occurrence_due_at)` → `COUNT(*) == 1`; outcome reflects second call ('completed')
- D-07: POST outcome='dismissed' → subsequent GET does not include dismissed item
- Validation: outcome='banana' → 400 bad_request
- Validation: unknown node_id → 404 not_found

**`describe('D-08 operational isolation')`** — 1 test (SC2):
- `fs.readdirSync('src/consolidation').filter(f => f.endsWith('.ts'))` → guards vacuity → reads each file → asserts no file contains 'surfaced_event'

**Verification results:**
- `npx vitest run tests/surface-sentinel.test.ts -t "D-43"` — 1/1 passed (gate met)
- `npx vitest run tests/surface-sentinel.test.ts` — 7/7 passed
- D-08 shell verify: `grep -rn "surfaced_event" src/ | grep -iE "sleep|consolidat" | grep -c . | grep -qx 0` → D08-OK
- `npx tsc --noEmit` — clean

## Task Commits

1. **Task 1 + Task 2 (sentinel + integration):** `2bf6ec2` — `feat(21-04): D-43 self-confirmation sentinel + endpoint integration (SURF-03)`

Both tasks target the same file (`tests/surface-sentinel.test.ts`) and were committed atomically.

## Files Created/Modified

- `tests/surface-sentinel.test.ts` — 7 tests across 4 describe blocks: D-43 sentinel, GET ranking, POST idempotency+exclusion, D-08 grep guard

## Decisions Made

- Both TDD tasks committed in one atomic commit since they create the same file — Task 1 (sentinel test) and Task 2 (integration tests) are intra-file additions
- D-08 check uses in-process `fs.readdirSync`/`readFileSync` (no shell-out) with a vacuity guard (`tsFiles.length > 0`) so the test can't vacuously pass if the directory moves
- `sentinelItem!.due_at` is the `occurrence_due_at` for the POST body — SurfaceItem.due_at and the occurrence_due_at field are the same ISO string

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Invalid action_type 'travel' fails CHECK constraint**
- **Found during:** Task 2 test execution (first run)
- **Issue:** `node_temporal.action_type` has a CHECK constraint allowing only 7 values: `deadline, flight, appointment, receipt, payment, meeting, other`. Used `'travel'` for the lower-tier ranking test item.
- **Fix:** Changed `action_type: 'travel'` to `action_type: 'flight'` in the ranking test
- **Files modified:** `tests/surface-sentinel.test.ts`
- **Commit:** 2bf6ec2 (included in the single task commit)

## Known Pre-Existing Failures

17 tests across 4 files — identical to those documented in 21-03-SUMMARY.md, zero causal relationship with this plan:
- `tests/adapter-capture.test.ts` (8 failures)
- `tests/adapter-inject.test.ts` (5 failures)
- `tests/episodic-dryrun-gate.test.ts` (1 failure)
- `tests/eval-harness-smoke.test.ts` (3 failures)

## Threat Flags

No new security surface introduced. All mitigations confirmed in place:
- T-21-SC3: D-43 sentinel green — surfacing+seen provably leave belief fields unchanged; gate met
- T-21-11: D-08 grep guard green — zero surfaced_event refs in consolidation source (SC2)
- T-21-12: D-05 idempotency test proves doubly-posted occurrence key collapses to one row

## Known Stubs

None. The sentinel and all integration assertions exercise live HTTP paths against a real SQLite DB.

## Self-Check: PASSED

- [x] `tests/surface-sentinel.test.ts` created (7 tests, all passing)
- [x] Commit 2bf6ec2 exists
- [x] `npx vitest run tests/surface-sentinel.test.ts -t "D-43"` — 1/1 green (D-43 gate met)
- [x] `npx vitest run tests/surface-sentinel.test.ts` — 7/7 green
- [x] D-08 shell verify returns D08-OK
- [x] `npx tsc --noEmit` — clean (exit 0)
- [x] Phase 22 hard gate satisfied: D-43 sentinel passes, SURF-03 met
