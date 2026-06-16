---
phase: 21-engine-surfacing-api
plan: "02"
subsystem: db/ranking
tags: [ranking, sqlite, tdd, surf-01, d-01, d-02, d-03, d-07, d-09, d-10, d-43]
dependency_graph:
  requires: [21-01]
  provides: [SurfaceStore, hybrid-ranking, surf-01-core]
  affects: [21-03, 21-04]
tech_stack:
  added: []
  patterns: [prepared-statement-in-constructor, synchronous-sqlite, tdd-red-green, read-only-by-construction]
key_files:
  created:
    - src/db/surface-store.ts
    - tests/surface-store.test.ts
  modified: []
decisions:
  - "SurfaceItem denormalized with value + action_type for cheap rendering (no extra JOIN at display time)"
  - "Recurring exemption handled at SQL level via OR nt.recurrence_rule IS NOT NULL (D-10 in the WHERE clause)"
  - "isExcluded() helper is a pure function — no DB I/O inside the per-row exclusion check"
  - "P0 items also sorted by score DESC (consistent sort everywhere, planners intent)"
  - "noUncheckedIndexedAccess TS strict mode requires items[n]! assertions in tests (applied inline)"
metrics:
  duration: "~7 minutes"
  completed: "2026-06-16"
  tasks_completed: 2
  files_changed: 2
---

# Phase 21 Plan 02: LLM-free SurfaceStore Hybrid Ranking Summary

LLM-free synchronous ranking engine with P0 tier bypass, weighted proximity/salience blend, D-10 past-event guard (recurring-exempt), D-07 surfaced_event exclusion, and D-09 rolling-24h cap — proven by 14 unit tests, provably write-free (D-43).

## What Was Built

### Task 1 — RED: failing ranking behavior tests (commit: 3f3921b)

Created `tests/surface-store.test.ts` (vitest, 14 tests against `SurfaceStore` that did not exist yet):

Tests intentionally cover every branch of the ranking spec:

1. **Tier gate** — P0 (tier=0, <24h) before lower (tier=1, >24h) regardless of score
2. **Blend by salience** — equal proximity; higher node.s ranks first
3. **Blend by proximity** — equal salience; sooner due_at ranks first (higher proximity term)
4. **D-10 past-event guard** — one-off >3h past excluded; within 3h grace included
5. **Recurring exemption** — `recurrence_rule IS NOT NULL` bypasses the past-event guard
6. **D-07 dismissed** — excluded
7. **D-07 completed** — excluded
8. **D-07 snoozed future** — excluded (snooze_until > now)
9. **D-07 snoozed past** — included again (snooze expired)
10. **D-07 surfaced** — excluded (already shown this occurrence)
11. **D-07 seen** — excluded (already shown this occurrence)
12. **D-09 cap** — capUsed=5, maxNonP0=5 → lower capped; P0 bypasses unconditionally
13. **Tombstoned** — tombstoned=1 never appears
14. **Novelty seam** — score = W_PROX*proximity + W_SAL*salience exactly (W_NOV=0)

RED verified: `npx vitest run tests/surface-store.test.ts` failed with "Cannot find module '../src/db/surface-store'" before Task 2.

### Task 2 — GREEN: SurfaceStore implementation (commit: b98c06e)

Created `src/db/surface-store.ts`:

**Exports:** `SurfaceItem`, `SurfaceOpts`, `SurfaceStore`

**SurfaceItem shape:** `{ node_id, value, due_at, action_type, tier: 0|1, score }` — value and action_type denormalized from node/node_temporal for cheap rendering.

**Constructor:** Prepares three statements (all T-01-SQL bound params, never interpolated):
- `stmtEligible`: `node_temporal JOIN node WHERE tombstoned=0 AND (due_at >= @pastCutoff OR recurrence_rule IS NOT NULL)` — D-10 guard with recurring exemption baked into the SQL `OR` clause
- `stmtCountCapWindow`: `COUNT(*) FROM surfaced_event WHERE created_at >= @windowStart AND outcome NOT IN ('completed','dismissed')` — D-09 rolling cap usage
- `stmtSurfacedEvent`: `SELECT outcome, snooze_until WHERE node_id = @node_id AND occurrence_due_at = @occurrence_due_at` — D-07 per-occurrence exclusion lookup

**rank(opts):**
1. Compute `pastCutoff = ISO(nowMs - gracePeriodMs)`
2. Pull eligible rows (one query, full JOIN result)
3. Count `capUsed` in rolling window
4. For each row: D-07 exclusion check → compute `score = 0.5*proximity + 0.5*salience + 0*novelty` → tier gate → push to p0 or lower
5. Sort p0 and lower by `score DESC`
6. `allowed = max(0, maxNonP0 - capUsed)` → return `[...p0, ...lower.slice(0, allowed)]`

**D-43 guard:** Zero INSERT/UPDATE/DELETE in implementation. Grep-verified.

**Verification results:**
- `npx vitest run tests/surface-store.test.ts` — 14/14 passed
- `grep -nE "INSERT|UPDATE|DELETE" src/db/surface-store.ts` → empty (D43-READONLY-OK)
- `grep -nE "async|await" src/db/surface-store.ts` → empty (synchronous, LLM-free)
- `npx tsc --noEmit` — clean

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TypeScript strict noUncheckedIndexedAccess errors in test file**
- **Found during:** Task 2 (TSC check after GREEN)
- **Issue:** `tsconfig.json` has `noUncheckedIndexedAccess: true`, so `items[0]` returns `SurfaceItem | undefined`. Array index accesses `items[0].node_id` / `items[0].score` / `items[0].tier` produced TS2532 errors.
- **Fix:** Added non-null assertions `items[0]!` at 4 sites in the test file (tier gate, blend-by-salience, blend-by-proximity, novelty seam). Already-safe `p0!.tier` and `lower!.tier` patterns were correct; the fixes were for direct index accesses.
- **Files modified:** `tests/surface-store.test.ts`
- **Commit:** b98c06e (included with GREEN implementation)

## Known Pre-Existing Failures

4 test files were failing before and after this plan (zero causal relationship — none import `surface-store`):
- `tests/adapter-capture.test.ts` (8 failures)
- `tests/adapter-inject.test.ts` (5 failures)
- `tests/episodic-dryrun-gate.test.ts` (1 failure)
- `tests/eval-harness-smoke.test.ts` (3 failures)

Logged to deferred-items, not fixed (out of scope per deviation rules).

## Threat Flags

No new security surface introduced beyond what the plan's threat model covers. All T-21-D43, T-21-04, T-21-05, T-21-06 mitigations confirmed in place:
- D-43: rank() is read-only by construction (grep-asserted: zero INSERT/UPDATE/DELETE)
- T-21-04: SurfaceItem exposes only the 6 specified fields (no raw c or internal fields)
- T-21-05: D-09 cap bounds lower-tier output; eligible query hits idx_node_temporal_due_at
- T-21-06: T-01-SQL — all filter values are named bound parameters

## Known Stubs

None. `SurfaceStore.rank()` is fully wired and exercised by the 14-test suite.

## Self-Check: PASSED

- [x] `src/db/surface-store.ts` created (exports SurfaceStore, SurfaceItem, SurfaceOpts)
- [x] `tests/surface-store.test.ts` created (14 tests, all passing)
- [x] Commit 3f3921b exists (RED — failing tests)
- [x] Commit b98c06e exists (GREEN — implementation + type fixes)
- [x] `npx vitest run tests/surface-store.test.ts` — 14/14 green
- [x] D-43 grep clean — zero INSERT/UPDATE/DELETE in surface-store.ts
- [x] `npx tsc --noEmit` — clean
- [x] SURF-01 ranking core delivered with all spec constraints proven by unit tests
