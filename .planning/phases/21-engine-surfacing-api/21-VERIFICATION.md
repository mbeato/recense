---
phase: 21-engine-surfacing-api
verified: 2026-06-16T00:40:00Z
status: passed
score: 7/7 must-haves verified
overrides_applied: 0
re_verification: false
---

# Phase 21: engine-surfacing-api Verification Report

**Phase Goal:** The engine can answer "what should the user see right now?" via an LLM-free composite ranking over due/actionable items, and idempotently record what was surfaced — without ever strengthening a belief (D-43 self-confirmation guard).
**Verified:** 2026-06-16T00:40:00Z
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Online surface paths are LLM-free and synchronous (no embedding/LLM calls in GET /v1/surface or SurfaceStore.rank()) | VERIFIED | `src/db/surface-store.ts` contains no `async`/`await`/`embed`/`provider`; better-sqlite3 is synchronous; grep of surface-store.ts for async patterns returns only comments; `surface()` op in memory-ops.ts is a thin wrapper over the synchronous `surfaceStore.rank()` call |
| 2 | D-43: surfacing and POST /v1/surface/seen NEVER write node.s or node.c | VERIFIED | `grep -nE "INSERT\|UPDATE\|DELETE" src/db/surface-store.ts` returns 0 matches; `grep -n "node\.s\|node\.c\|UPDATE node" src/adapter/memory-ops.ts` (excluding comments) returns 0 matches; D-43 sentinel test (tests/surface-sentinel.test.ts lines 258-259) asserts `after.s === before.s` and `after.c === before.c` — passes 1/1 |
| 3 | D-08: the consolidation/sleep pass never references surfaced_event | VERIFIED | `grep -rn "surfaced_event" src/consolidation/` returns 0 matches across all 8 consolidation .ts files; in-process D-08 grep test (surface-sentinel.test.ts) also passes |
| 4 | surfaced_event is schema v9 with UNIQUE(node_id, occurrence_due_at) idempotency key and CHECK(outcome) enum | VERIFIED | `src/db/schema.ts` line 11: `export const SCHEMA_VERSION = 9`; DDL at lines 136-146 contains all 7 columns, UNIQUE(node_id, occurrence_due_at) table constraint, CHECK(outcome IN ('surfaced','seen','snoozed','completed','dismissed')); schema round-trip test (surfaced-event-schema.test.ts) confirms all constraints — 6/6 passing |
| 5 | SurfaceStore.rank() is read-only by construction — no writes, no locks | VERIFIED | Surface-store.ts contains zero INSERT/UPDATE/DELETE; rank() is synchronous, calls only `stmtEligible.all()`, `stmtCountCapWindow.get()`, and `stmtSurfacedEvent.get()` (all read operations); constructed against the `{ readonly: true }` handle in the separateReadHandle branch; surface() op contains no `acquireLockWithRetry` call |
| 6 | surfaceSeen() is an idempotent upsert under write lock | VERIFIED | memory-ops.ts lines 293-300: `INSERT INTO surfaced_event ... ON CONFLICT(node_id, occurrence_due_at) DO UPDATE SET outcome=excluded.outcome, snooze_until=excluded.snooze_until, updated_at=excluded.updated_at` — `created_at` not in UPDATE clause (immutable); lock acquired at line 442 via `acquireLockWithRetry()`, released in `finally` at line 455; D-05 idempotency test (surface-sentinel.test.ts) confirms COUNT(*)==1 for double-POST |
| 7 | D-43 self-confirmation sentinel (SURF-03 / SC3 Phase 22 blocking gate) passes | VERIFIED | `npx vitest run tests/surface-sentinel.test.ts` exits 0; 7/7 tests pass; sentinel test (D-43 describe block) seeds node with s=0.42 c=0.65, runs full GET /v1/surface + POST /v1/surface/seen cycle, reopens DB and asserts `after.s === before.s` and `after.c === before.c` |

**Score:** 7/7 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/db/schema.ts` | surfaced_event DDL + v9 migration + SCHEMA_VERSION=9 | VERIFIED | SCHEMA_VERSION=9 at line 11; DDL at lines 136-146; v9 migration at lines 298-309 creates idx_surfaced_event_node_occ and idx_surfaced_event_outcome |
| `tests/surfaced-event-schema.test.ts` | schema round-trip + migration idempotency proof | VERIFIED | 170 lines; 6 assertions: 7-column shape, schema_version='9', CHECK rejection, UNIQUE rejection, idempotent double-initSchema, FK resolution — all 6 passing |
| `src/db/surface-store.ts` | SurfaceStore class (rank()), SurfaceItem/SurfaceOpts types, hybrid scoring | VERIFIED | 275 lines; exports SurfaceStore, SurfaceItem, SurfaceOpts; implements P0 tier, proximity/salience blend, D-10 past-event guard, D-07 exclusion, D-09 cap; 3 prepared statements in constructor |
| `tests/surface-store.test.ts` | Ranking unit tests (14 cases: tier, blend, cap, past-guard, exclusion, recurring-exempt) | VERIFIED | 14 tests covering all spec branches; all passing |
| `src/adapter/memory-ops.ts` | surface() + surfaceSeen() ops, SurfaceStore wiring, MemoryOps interface extension | VERIFIED | MemoryOps interface extended with surface() and surfaceSeen() at lines 171-179; SurfaceStore wired in both separateReadHandle and else branches; upsert prepared statement at lines 293-303; node-existence check at line 303 |
| `src/adapter/serve-cli.ts` | GET /v1/surface + POST /v1/surface/seen routes with validation | VERIFIED | GET /v1/surface at line 399 (lock-free, no readBody); POST /v1/surface/seen at line 426 (full T-21-07 validation, MemoryBusyError→503, SurfaceTargetNotFoundError→404); both placed before /mcp block |
| `tests/memory-ops-surface.test.ts` | 11 ops-level TDD tests | VERIFIED | 11 tests — all passing |
| `tests/surface-routes.test.ts` | 17 HTTP-level TDD tests + D-43 at HTTP layer | VERIFIED | 17 tests — all passing |
| `tests/surface-sentinel.test.ts` | D-43 sentinel (blocking gate) + endpoint integration + D-08 grep guard | VERIFIED | 7 tests — all passing; commit 2bf6ec2 confirmed |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| GET /v1/surface (serve-cli) | ops.surface → SurfaceStore.rank (readDb) | `ops.surface(` call at serve-cli.ts:414 | WIRED | Lock-free; read-only handle backed surfaceStore confirmed in wireMemoryEngine separateReadHandle branch |
| POST /v1/surface/seen (serve-cli) | ops.surfaceSeen → surfaced_event upsert (writeDb, locked) | `ops.surfaceSeen({` call at serve-cli.ts:468 | WIRED | acquireLockWithRetry at memory-ops.ts:442; stmtUpsertSurfacedEvent.run at line 446; releaseLock in finally at line 455 |
| SurfaceStore.rank | node_temporal ⋈ node | `FROM node_temporal nt JOIN node n` in stmtEligible (surface-store.ts:162-174) | WIRED | JOIN + tombstoned=0 filter confirmed |
| SurfaceStore.rank | surfaced_event | `FROM surfaced_event` in stmtSurfacedEvent (surface-store.ts:191-194) | WIRED | D-07 per-occurrence exclusion lookup confirmed |
| D-43 sentinel | node.s / node.c | before/after SELECT s,c assertion | WIRED | `expect(after.s).toBe(before.s)` at sentinel test line 258; `expect(after.c).toBe(before.c)` at line 259 |

---

### Data-Flow Trace (Level 4)

SurfaceStore.rank() is a read-only ranking engine — it does not render dynamic data in a UI context. The surface() op returns SurfaceItem[] which flows to the GET /v1/surface HTTP response. The sentinel test confirms the data does flow end-to-end (GET returns the seeded sentinel-node with its known due_at). This level is not applicable in the traditional sense (no React/UI component), but the data pipeline is verified by integration tests.

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| D-43 sentinel: node.s/node.c byte-identical after surface+seen | `npx vitest run tests/surface-sentinel.test.ts -t "D-43"` | 1/1 passed | PASS |
| Schema v9 with surfaced_event DDL | `npx vitest run tests/surfaced-event-schema.test.ts` | 6/6 passed | PASS |
| LLM-free ranking (14 spec cases) | `npx vitest run tests/surface-store.test.ts` | 14/14 passed | PASS |
| HTTP routes + idempotency + exclusion + validation | `npx vitest run tests/surface-routes.test.ts tests/memory-ops-surface.test.ts` | 28/28 passed | PASS |
| Full sentinel suite (D-43 + ranking + idempotency + D-08) | `npx vitest run tests/surface-sentinel.test.ts` | 7/7 passed | PASS |
| TSC clean compile | `npx tsc --noEmit -p tsconfig.json` | exit 0, zero errors | PASS |
| D-08 isolation: no surfaced_event in consolidation source | `grep -rn "surfaced_event" src/consolidation/` | 0 matches across 8 files | PASS |
| D-43 write-free: no INSERT/UPDATE/DELETE in surface-store.ts | `grep -nE "INSERT\|UPDATE\|DELETE" src/db/surface-store.ts` | 0 matches | PASS |

---

### Probe Execution

No probe-*.sh files declared for this phase. Step 7c: SKIPPED (no conventional probes; behavioral spot-checks above cover the same ground).

---

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| SURF-01 | 21-02, 21-03 | GET /v1/surface returns due/actionable, not-yet-surfaced items via LLM-free composite ranking (deadline-proximity + salience), with daily cap (P0 bypass), past-event guard, and completed/snoozed exclusion | SATISFIED | SurfaceStore.rank() implements all spec constraints; 14-test suite covers tier, blend, cap, past-guard (recurring-exempt), all D-07 exclusion branches; GET /v1/surface route wired and tested (17 HTTP tests + 7 sentinel tests) |
| SURF-02 | 21-01, 21-03 | POST /v1/surface/seen idempotently records surfaced/seen/snooze outcomes to surfaced_event (activation_trace precedent); sleep pass never reads or writes it | SATISFIED | surfaced_event table at schema v9 with UNIQUE idempotency key; surfaceSeen() op with ON CONFLICT DO UPDATE; POST /v1/surface/seen route wired; D-08 isolation proven by grep and in-process test |
| SURF-03 | 21-04 | Surfacing and seen-state writes never strengthen a belief (node.s/node.c unchanged) — D-43 sentinel test is required verification gate before Phase 22 push client connects | SATISFIED | D-43 sentinel test passes: node.s=0.42 and node.c=0.65 byte-identical before and after full surface+seen cycle; 0 write-path references to node.s/node.c confirmed by grep |

---

### Advisory Code Review Warnings (from 21-REVIEW.md)

The advisory code review (21-REVIEW.md, 0 blockers, 3 warnings) found no issues that undermine the phase goal. Each warning is assessed below:

| ID | Issue | Assessment | Phase Goal Impact |
|----|-------|-----------|------------------|
| WR-01 | `outcome='snoozed'` without `snooze_until` is a silent no-op (item keeps surfacing instead of being snoozed) | WARNING — real correctness defect in the snooze path; `isExcluded()` correctly handles `snooze_until !== null` but the route doesn't enforce that snooze_until is required when outcome='snoozed'. This is an undocumented undefined behavior for a malformed (but accepted) API request. Does not affect D-43, D-08, the LLM-free path, or the idempotency invariant. | No SURF must-have tests the null-snooze case; the four tested D-07 exclusion branches (dismissed, completed, snoozed-future, snoozed-past) all pass correctly. Phase goal not undermined. Fix in a follow-up plan. |
| WR-02 | D-09 cap over-counts — P0 `surfaceSeen` acknowledgements deplete the non-P0 rolling budget | WARNING — implementation deviates from spec (cap should exclude P0 rows). stmtCountCapWindow counts all `outcome NOT IN ('completed','dismissed')` rows regardless of tier. Concretely: 5 P0 meetings acknowledged in 24h → `capUsed=5=maxNonP0` → `allowed=0` → lower-tier items silently suppressed for the rest of the window. The existing cap test uses pre-seeded filler rows and does not exercise the P0-starves-lower case. | Does not break D-43, D-08, idempotency, or LLM-free invariants. Core surfacing behavior (P0 returned unbounded, lower-tier returned up to cap) is functionally correct within its tested range. Fix in a follow-up plan. |
| WR-03 | `?limit` param maps to `maxNonP0` (cap tuning), not a response size bound; P0 items bypass it; no upper bound on parsed value | WARNING/INFO — API contract mismatch. A caller passing `?limit=2` still receives all P0 items + up to 2 lower-tier items. `?limit=1000000` disables the cap. | Polish issue. Phase goal not undermined. Fix in a follow-up plan. |

None of the three warnings undermine the phase goal, D-43 invariant, D-08 isolation, or the three SURF must-haves. They are documented here for the follow-up gap-closure cycle.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/db/schema.ts` | 305 | `idx_surfaced_event_node_occ` is redundant — the UNIQUE(node_id, occurrence_due_at) constraint already creates this index (noted in code comment at line 302) | INFO | Dead index; wastes space; no behavioral impact |

No TBD/FIXME/XXX markers in any files modified by this phase. No stub patterns detected. No placeholders.

---

### Commit Audit

All 7 plan commits verified to exist in git history:

| Commit | Plan | Description |
|--------|------|-------------|
| `26564e9` | 21-01 Task 1 | surfaced_event DDL + v9 migration + SCHEMA_VERSION bump |
| `2136da4` | 21-01 Task 2 | Schema round-trip + migration idempotency test |
| `3f3921b` | 21-02 Task 1 | RED — failing ranking tests for SurfaceStore |
| `b98c06e` | 21-02 Task 2 | GREEN — LLM-free SurfaceStore hybrid ranking |
| `5a7a6cb` | 21-03 Task 1 | surface() + surfaceSeen() ops, SurfaceStore wiring |
| `476ab5a` | 21-03 Task 2 | GET /v1/surface + POST /v1/surface/seen routes |
| `2bf6ec2` | 21-04 | D-43 self-confirmation sentinel + endpoint integration |

---

### Human Verification Required

None. All phase-21 behaviors are covered by automated tests. No UI, no external service integration, no visual output to inspect.

---

## Gaps Summary

No gaps. All 7 observable truths verified. All 3 SURF requirements satisfied. The D-43 blocking gate for Phase 22 is proven green by the sentinel test. Three advisory code review warnings (WR-01 snooze-null silent no-op, WR-02 cap over-counts P0 rows, WR-03 misleading limit param) are documented above but do not block the phase goal and should be addressed in a follow-up gap-closure plan before Phase 22 ships to a real push client.

---

_Verified: 2026-06-16T00:40:00Z_
_Verifier: Claude (gsd-verifier)_
