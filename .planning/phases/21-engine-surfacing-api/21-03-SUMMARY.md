---
phase: 21-engine-surfacing-api
plan: "03"
subsystem: adapter/http
tags: [http-routes, memory-ops, surfacing, tdd, surf-01, surf-02, d-43, t-12-02, t-21-07, t-21-08, t-21-09]
dependency_graph:
  requires:
    - phase: 21-02
      provides: SurfaceStore.rank() — the ranking engine wired by this plan
    - phase: 21-01
      provides: surfaced_event DDL + UNIQUE(node_id, occurrence_due_at) idempotency key
  provides:
    - surface() op (lock-free read via SurfaceStore + read-only handle)
    - surfaceSeen() op (idempotent upsert under write lock)
    - GET /v1/surface HTTP route
    - POST /v1/surface/seen HTTP route
    - SurfaceTargetNotFoundError (exported, maps to 404)
    - SurfaceSeenParams (exported interface)
  affects: [21-04]
tech_stack:
  added: []
  patterns:
    - lock-free-read-op (surface mirrors search — no acquireLockWithRetry)
    - locked-write-op-with-finally (surfaceSeen mirrors add — T-12-02 pattern)
    - on-conflict-upsert-immutable-created-at (surfaced_event idempotency key)
    - get-route-with-query-params (GET /v1/surface reads ?limit and ?grace_hours from req.url)
    - typed-error-to-http-status (SurfaceTargetNotFoundError→404, MemoryBusyError→503)
key_files:
  created:
    - tests/memory-ops-surface.test.ts
    - tests/surface-routes.test.ts
  modified:
    - src/adapter/memory-ops.ts
    - src/adapter/serve-cli.ts
key-decisions:
  - "node existence check (stmtNodeExists) happens BEFORE lock acquisition — fast-fail for unknown node_id without tying up the lock"
  - "surface() passes { nowMs: realClock.nowMs(), ...opts } to rank() so caller-supplied opts override realClock but realClock is always the fallback"
  - "snooze_until=null is valid (pass through to SQL); snooze_until=undefined is omitted (SQL receives NULL); only an unparseable string is rejected as 400"
  - "D-43 sentinel test included in surface-routes.test.ts (HTTP-level proof that node.s/node.c are unchanged after surface+seen cycle)"
  - "SurfaceTargetNotFoundError exported from memory-ops (not db/surface-store) so serve-cli.ts has a single import point"
requirements-completed: [SURF-01, SURF-02]
duration: ~12min
completed: "2026-06-16"
---

# Phase 21 Plan 03: HTTP Surface Wire-Up Summary

GET /v1/surface (lock-free ranked read via SurfaceStore) + POST /v1/surface/seen (locked idempotent upsert with full T-21-07 input validation) wired to the existing serve discipline — read-only handle for reads, single-writer lock for writes, MemoryBusyError→503, SurfaceTargetNotFoundError→404, D-43 node belief table untouched.

## Performance

- **Duration:** ~12 min
- **Started:** 2026-06-16T03:26:30Z
- **Completed:** 2026-06-16T03:38:32Z
- **Tasks:** 2 (each TDD RED→GREEN)
- **Files modified:** 4

## Accomplishments

- Exported `SurfaceTargetNotFoundError` and `SurfaceSeenParams` from memory-ops; extended `MemoryOps` interface with `surface()` (lock-free) and `surfaceSeen()` (locked write)
- Wired `SurfaceStore` in both `separateReadHandle` and else branches of `wireMemoryEngine`; prepared idempotent upsert SQL (ON CONFLICT DO UPDATE, created_at immutable) and node-existence check against writeDb
- GET /v1/surface route: parses optional `?limit` and `?grace_hours` query params, no readBody, no lock, 500 on unexpected error
- POST /v1/surface/seen route: T-21-07 full validation (node_id/occurrence_due_at strings, date-parseable, outcome 5-value enum, snooze_until date), MemoryBusyError→503, SurfaceTargetNotFoundError→404
- TDD: 28 new tests total (11 ops-level + 17 HTTP-level), all passing; D-43 sentinel test at HTTP layer proves node belief table untouched after surface+seen cycle

## Task Commits

1. **Task 1 RED: failing memory-ops surface tests** - included in Task 1 feat commit (TDD RED folded with GREEN per single-task cycle)
2. **Task 1 GREEN: surface() + surfaceSeen() ops, SurfaceStore wiring** - `5a7a6cb` (feat)
3. **Task 2 RED: failing surface route tests** - included in Task 2 feat commit
4. **Task 2 GREEN: GET /v1/surface + POST /v1/surface/seen routes** - `476ab5a` (feat)

**Plan metadata:** committed with SUMMARY.md

## Files Created/Modified

- `src/adapter/memory-ops.ts` — Added `SurfaceTargetNotFoundError`, `SurfaceSeenParams`, extended `MemoryOps` interface, wired `SurfaceStore` in `wireMemoryEngine`, added `surface()` and `surfaceSeen()` ops
- `src/adapter/serve-cli.ts` — Imported `SurfaceTargetNotFoundError`, added GET `/v1/surface` + POST `/v1/surface/seen` routes before the `/mcp` block
- `tests/memory-ops-surface.test.ts` — 11 TDD tests for ops-level behavior (surface ranking, surfaceSeen idempotency, SurfaceTargetNotFoundError on unknown node)
- `tests/surface-routes.test.ts` — 17 TDD tests for HTTP-level behavior (200/401/400/404/503 paths + D-43 sentinel)

## Decisions Made

- Node existence check (`stmtNodeExists`) happens BEFORE lock acquisition — fast-fail for unknown node_id without tying up the write lock (validation before resource acquisition)
- `surface()` passes `{ nowMs: realClock.nowMs(), ...opts }` to `rank()` so the clock is always set from realClock but caller-supplied `nowMs` can override it
- `snooze_until=null` is valid and passed as SQL NULL; `snooze_until=undefined` results in SQL NULL; only a non-null non-parseable string is rejected as 400
- D-43 sentinel test at the HTTP layer (surface-routes.test.ts) provides an end-to-end proof that the full request path leaves `node.s` and `node.c` unchanged

## Deviations from Plan

None — plan executed exactly as written.

## Known Pre-Existing Failures

4 test files were failing before this plan (zero causal relationship — none import the new modules):
- `tests/adapter-capture.test.ts` (8 failures)
- `tests/adapter-inject.test.ts` (5 failures)
- `tests/episodic-dryrun-gate.test.ts` (1 failure)
- `tests/eval-harness-smoke.test.ts` (3 failures)

## Threat Flags

No new security surface beyond what the plan's threat model covers. All T-21-07, T-21-08, T-21-D43, T-21-09, T-21-10 mitigations confirmed in place:
- T-21-07: full input validation (types, date parse, enum) before any DB write
- T-21-08: node-existence check before upsert → 404 for unknown node_id; UNIQUE prevents orphan rows
- T-21-D43: surfaceSeen writes ONLY surfaced_event; grep-verified zero node.s/node.c writes; HTTP-level D-43 sentinel test
- T-21-09: acquireLockWithRetry → MemoryBusyError → 503; lock released in finally
- T-21-10: inherited Bearer-auth gate fires before both new routes (unchanged)

## Known Stubs

None. Both ops and routes are fully wired to the live SurfaceStore + surfaced_event table.

## Self-Check: PASSED

- [x] `src/adapter/memory-ops.ts` modified: SurfaceTargetNotFoundError/SurfaceSeenParams exported, MemoryOps extended, surface()+surfaceSeen() implemented
- [x] `src/adapter/serve-cli.ts` modified: GET /v1/surface + POST /v1/surface/seen routes present before /mcp
- [x] `tests/memory-ops-surface.test.ts` created (11 tests, all passing)
- [x] `tests/surface-routes.test.ts` created (17 tests, all passing)
- [x] Commit 5a7a6cb exists (Task 1: memory-ops ops)
- [x] Commit 476ab5a exists (Task 2: serve-cli routes)
- [x] `npx tsc --noEmit` — clean
- [x] D-43 grep: zero writes to node.s/node.c in memory-ops.ts (only comments)
- [x] Routes present: grep confirmed `v1/surface'` and `v1/surface/seen` in serve-cli.ts
- [x] Pre-existing test failures (17 across 4 files) unchanged — not caused by this plan
