---
phase: 48-correctness-hardening
plan: 02
subsystem: testing
tags: [vitest, better-sqlite3, sqlite, correctness, hardening, regression-tests]

# Dependency graph
requires:
  - phase: 48-correctness-hardening
    provides: "live guards at consolidator.ts:1079-1082, schema.ts:607-623, consolidator.ts:507,953-969"
provides:
  - "HARD-01 labeled regression test on the C-2 no-strengthen guard (consolidation.test.ts)"
  - "HARD-02 new regression test proving Phase-B write runs .immediate() (consolidation.test.ts)"
  - "HARD-03 labeled regression test on the M-9 downgrade-throw guard (schema.test.ts)"
affects: ["48-03", "50-verification-regression-gates"]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "better-sqlite3 transaction spy: wrap db.transaction to return a plain JS function with own .immediate() property (Proxy and Object.defineProperty fail on native Transaction objects)"

key-files:
  created: []
  modified:
    - tests/consolidation.test.ts
    - tests/schema.test.ts

key-decisions:
  - "Plain JS wrapper function (not Proxy) is the only reliable way to intercept .immediate() on better-sqlite3 Transaction objects — native Transaction has non-configurable properties that block direct assignment and Object.defineProperty; a Proxy's get trap also failed (likely V8 native object fast path bypasses it); plain function with .immediate as own writable property works cleanly"
  - "HARD-01 C-2 guard audited airtight: D-17 fast path sets episodeRole:episode.role at line 730, flowing through applyDecision's single gate at line 1082 — no second strengthen path exists"
  - "HARD-03 M-9 guard audited airtight: schema.ts:607-623 reads stored version first, throws when stored > SCHEMA_VERSION, stamps only on fresh/upgrade"
  - "HARD-02 M-5 guard audited airtight: both Phase-B write transactions (markSkipped line 507, per-episode graph write lines 953-969) chain .immediate()"

patterns-established:
  - "better-sqlite3 transaction spy: origTransaction(fn) returns native Transaction; wrap in plain function with own-property .immediate that delegates to txn.immediate.apply(txn, args)"

requirements-completed: [HARD-01, HARD-02, HARD-03]

# Metrics
duration: 25min
completed: 2026-06-28
---

# Phase 48 Plan 02: Correctness Hardening (HARD-01/02/03) Summary

**Three ARCH-REVIEW guards locked behind requirement-labeled regression tests: C-2 no-strengthen (HARD-01 labeled), M-9 downgrade-throw (HARD-03 labeled), M-5 IMMEDIATE-mode write (HARD-02 new test using plain-function spy on db.transaction)**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-06-28T22:30:00Z
- **Completed:** 2026-06-28T22:55:00Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Audited all three HARD-0X guards against live code and confirmed each is airtight
- Added `HARD-01 (C-2)` label to the existing C-2 no-strengthen test (consolidation.test.ts) with an explicit note that the D-17 exact-match fast path is structurally covered via `episodeRole` threading at line 730
- Added `HARD-03 (M-9)` label to the existing M-9 downgrade-throw test (schema.test.ts)
- Wrote new `HARD-02 (M-5)` regression test in consolidation.test.ts asserting Phase-B write runs `.immediate()` using a plain-function spy (the only reliable technique for native better-sqlite3 Transaction objects)
- Full suite green: 2387 passed / 4 skipped — no regressions

## Task Commits

1. **Task 1: Audit + label HARD-01 and HARD-03** - `e3a2d9b` (test)
2. **Task 2: Audit HARD-02 + write M-5 IMMEDIATE-mode test** - `8752c5d` (test)

## Files Created/Modified

- `tests/consolidation.test.ts` — HARD-01 label added to C-2 comment block; new HARD-02 test added in SEAM-02/D-49 describe block
- `tests/schema.test.ts` — HARD-03 label added before the M-9 downgrade-throw test

## Audit Verdicts

### HARD-01 (C-2) — AIRTIGHT

The D-17 normalized-exact-match fast path (`consolidator.ts:715-736`) sets `episodeRole: episode.role` in the `ClaimDecision` struct at line 730. This decision flows into `applyDecision()`, which is the ONLY site that calls `this.strength.strengthen()`. The single gate at line 1082 (`if (decision.episodeRole !== 'assistant')`) structurally blocks strengthen for ALL confirm decisions, regardless of whether they arrived via D-17 fast path or the judge path. No second strengthen path exists for the `confirm` case. The C-2 guard is airtight.

ARCH-REVIEW note: assistant claims may still extend/append (by design) — only `strengthen` is gated. The existing test exercises exactly the D-17 fast path (`generateScript` with exact-match content, `judgeScript: []`).

### HARD-03 (M-9) — AIRTIGHT

`schema.ts:607-623` reads the stored `schema_version` before stamping. Line 612 parses the stored value. Lines 613-618 throw `'newer than this binary'` when `stored > SCHEMA_VERSION`. Lines 619-623 stamp only on fresh DB or upgrade. The guard is read-first, fail-closed on downgrade.

### HARD-02 (M-5) — AIRTIGHT

Both Phase-B write transactions are `.immediate()`:
- `markSkipped` at line 507: `this.db.transaction(() => this.episodes.markConsolidated(episodeId)).immediate()`
- Per-episode graph write at lines 953-969: `this.db.transaction(() => { ...decisions + triples + markConsolidated... }).immediate()`

No Phase-B write transaction uses `.deferred()` or direct call.

## Decisions Made

**Plain wrapper function over Proxy for the HARD-02 spy:** better-sqlite3's native `Transaction` objects have non-configurable properties. Direct assignment to `txn.immediate` fails at runtime ("Cannot assign to read only property"). `Object.defineProperty` also fails ("Cannot redefine property"). JavaScript `Proxy`'s `get` trap was tried but `immediateCallCount` remained 0 — likely because V8's native function property access bypasses the Proxy `get` trap for non-configurable properties. The working solution: wrap `origTransaction(fn)` in a plain JS `function wrappedTxn(...){}` with `wrappedTxn.immediate` as an explicitly-assigned own property that delegates to `txn.immediate.apply(txn, args)`. Own properties on plain functions are always readable without native interception.

## Deviations from Plan

None — plan executed exactly as written. No production code was changed. The spy technique adaptation (plain wrapper instead of Proxy) is an implementation detail that does not change the test's assertion or its structural correctness.

## Issues Encountered

- better-sqlite3 Transaction objects have non-configurable native properties that resist all standard spy techniques (direct assignment, Object.defineProperty, Proxy). Resolved by using a plain-function wrapper pattern that does not require modifying the native transaction object at all (see Decisions Made above).

## User Setup Required

None — no external service configuration required.

## Known Stubs

None.

## Threat Flags

None — this plan adds no new network endpoints, auth paths, file access patterns, or schema changes.

## Next Phase Readiness

- HARD-01, HARD-02, HARD-03 all closed with requirement-labeled regression tests
- HARD-04 (L-2: embedding model stamp) is in plan 48-03 (separate plan/worktree)
- Phase 50 (Verification + Regression Gates) depends on all of Phase 48 completing

---
*Phase: 48-correctness-hardening*
*Completed: 2026-06-28*
