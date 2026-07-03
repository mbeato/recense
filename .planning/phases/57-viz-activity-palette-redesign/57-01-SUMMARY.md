---
phase: 57-viz-activity-palette-redesign
plan: 01
subsystem: viz-server
tags: [viz, constants, shared-source-of-truth, WR-01, D-10, D-12, invariants-test]
dependency_graph:
  requires: []
  provides:
    - constants.js-sole-authored-scheduler-scalars
    - server.ts-source-parse-derivation
    - viz-activity-palette-invariants-test-file
  affects:
    - src/viz/modules/constants.js
    - src/viz/server.ts
    - tests/viz-activity-palette-invariants.test.ts
tech_stack:
  added: []
  patterns:
    - "sync fs.readFileSync + export-const regex source-parse at startVizServer init (fail-fast on missing name)"
key_files:
  created:
    - tests/viz-activity-palette-invariants.test.ts
  modified:
    - src/viz/modules/constants.js
    - src/viz/server.ts
decisions:
  - "parseSchedulerScalars() reads modules/constants.js once, synchronously, inside startVizServer (not at module scope) — matches the plan's 'at startVizServer init' framing and avoids a file read when the module is only imported for pickSpontaneousSeeds (as some existing tests do)."
  - "Exported parseSchedulerScalars() from server.ts (mirroring the existing pickSpontaneousSeeds export-for-testing convention) so Test C could exercise the REAL parse mechanism against the real file, rather than re-implementing a duplicate regex in the test."
metrics:
  duration_min: 25
  completed: 2026-07-03
  tasks: 3
  files_touched: 3
---

# Phase 57 Plan 01: Single Shared Source of Truth for Viz Scheduler Constants Summary

Killed the WR-01 client/server mirror-drift class by making `constants.js` the sole authored home of all seven viz scheduler scalars, having `server.ts` derive them via a fail-fast source-parse at `startVizServer` init, and seeding the dedicated `tests/viz-activity-palette-invariants.test.ts` (D-12) that locks the anti-duplication + single-source + runtime-sync invariants for every later Phase-57 plan to extend.

## What Was Built

**Task 1 — `constants.js` becomes the sole authored home (commit `307a02e`):**
Added `SPONT_SEED_COUNT = 2` and `SPONT_POOL_REFRESH_MS = 60000` as JSDoc'd named exports in the Phase-56 layer block (they previously lived ONLY in `server.ts`'s hand-mirrored block). Removed the obsolete "keep in sync with server.ts — server is the authoritative copy" language from the comments on `REPLAY_CADENCE_MS`, `REPLAY_HISTORY_N`, `SPONT_CADENCE_MS`, and `SPONT_HOP_TOPN`, replacing it with language stating constants.js is now the single authored source consumed by the server via source-parse. No numeric values changed — pure relocation.

**Task 2 — `server.ts` derives scalars from `constants.js` (commit `6d5f6a2`):**
Deleted the hand-mirrored `const` block (the literal WR-01 bug — `SPONT_HOP_TOPN` had already drifted 6 vs 3 between the two copies). Added `parseSchedulerScalars(modulesRoot)`, a small helper that reads `constants.js`'s source text once via `fs.readFileSync` and extracts each of the seven named scalars with the established `/export\s+const\s+NAME\s*=\s*([\d.]+)/` regex convention (same pattern `viz-ambient-liveliness.test.ts` already used for source-parse assertions), throwing a clear error if any name is absent (fail-fast, not silent-zero — satisfies threat T-57-01's "corruption surfaces immediately" mitigation). Called at the top of `startVizServer`, destructuring all seven scalars into local bindings that the existing `setInterval`/`pickSpontaneousSeeds` call sites consume completely unchanged (no scheduler restructuring, matching D-10's explicit scope boundary).

**Task 3 — dedicated invariants file, D-12 seed (commit `6a17509`):**
Created `tests/viz-activity-palette-invariants.test.ts` following the `viz-ambient-liveliness.test.ts` / `spontaneous-idle-activation.test.ts` header + source-parse-harness conventions (file header explicitly names both as its mirrors). Implements:
- **Test A** (anti-duplication lock): for each of the seven scalar names, asserts `server.ts`'s comment-stripped source contains no `const NAME = <number>` literal re-declaration.
- **Test B** (single-source presence): for each scalar name, asserts `constants.js` declares it exactly once as `export const NAME =`.
- **Test C** (runtime sync, red-if-drift guard): imports the REAL `parseSchedulerScalars()` from `server.ts`, calls it against the real `constants.js` file, and asserts the returned `REPLAY_CADENCE_MS`/`SPONT_HOP_TOPN` values equal what a direct regex parse of `constants.js`'s own export finds — proving the parse mechanism itself never silently drifts from the single authored source.
- A static check confirming `server.ts` contains a `readFileSync` call resolving `modules/constants.js`.

The file ends with a commented "Future Phase-57 invariant groups" section header block (luminance-band membership, dim floors, SC3 motion ordering) for later plans to extend into, per D-12's "one dedicated invariants test file" mandate.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test C's original design compared two source-parses of `server.ts`, which no longer has any literal to parse**
- **Found during:** Task 3, first test run
- **Issue:** The plan's Test C spec ("parse both source texts with the shared regex, assert equal") assumed `server.ts` still had a literal `export const NAME = ...` to regex-match — but Task 2 deliberately removed that literal entirely (that's the whole point of D-10). Running the naive version produced 2 failing tests (`match` was `null` against `server.ts`).
- **Fix:** Exported `parseSchedulerScalars()` from `server.ts` (mirroring the existing `pickSpontaneousSeeds` export-for-testing convention) and rewrote Test C to call the REAL parse mechanism against the real `constants.js` file, comparing its output to a direct regex-parse of `constants.js`'s own export. This is a stronger, more meaningful "runtime sync" guard than the originally-sketched shape — it protects against the parse mechanism itself silently regressing (e.g., a future regex edit that mis-extracts a value), rather than a comparison that would now be structurally impossible to construct.
- **Files modified:** `src/viz/server.ts` (added `export` keyword), `tests/viz-activity-palette-invariants.test.ts`
- **Commit:** `6a17509`

None of the plan's acceptance criteria required a different mechanism — this is a same-spirit reinterpretation forced by Task 2's own success (server.ts no longer has anything to regex-parse), not a deviation in intent.

### TDD Note (Task 3, tdd="true")

Task 3 is tagged `tdd="true"` but tests behavior that Tasks 1 and 2 (earlier in the SAME plan) already implemented — there was no separate `<implementation>` step for this task, only `<action>` (write the test file). Writing the tests therefore passed on first run rather than failing (a genuine RED phase would require the D-10 mechanism to not yet exist, but it already did by the time Task 3 ran). This is expected given the task's actual role (a regression lock seeded onto already-correct code, not driving new implementation) and is documented here per the fail-fast investigation instinct rather than silently treated as a normal TDD RED/GREEN pair. The negative check specified in the plan's acceptance criteria (temporarily re-adding a literal makes Test A fail) was performed manually and confirmed, then reverted — see Self-Check below.

## Verification

- `npx tsc --noEmit -p tsconfig.json` — clean (exit 0) after both Task 2 and Task 3
- `npx vitest run tests/viz-activity-palette-invariants.test.ts` — 17/17 passing
- `npx vitest run tests/spontaneous-idle-activation.test.ts tests/viz-server.test.ts tests/viz-ambient-liveliness.test.ts` — 88/88 passing (no regression)
- Full suite (`npm test`) — 171 files passed / 1 skipped, 2574 tests passed / 4 skipped — matches the plan's "stays green (2558 tests)" expectation (actual count 2574, slightly higher due to the 17 new tests plus intervening test additions from other work; no failures)
- Manual negative check: temporarily injecting `const REPLAY_CADENCE_MS = 9999;` at module scope in `server.ts` made Test A fail (`expected ... not to match`) while all 16 other tests stayed green; reverted immediately after confirming, restored file verified byte-identical to the pre-injection state via diff

## Known Stubs

None — no stubs introduced.

## Threat Flags

None — this plan only relocates/derives existing scheduler scalars and adds tests; no new network endpoints, auth paths, file-access patterns, or schema changes. The threat model's own T-57-01/T-57-02 entries (source-parse tampering/DoS, both `accept`-dispositioned) are the only relevant surface and were satisfied as designed (fail-fast on missing name; one-time small local read at init, no per-request I/O).

## Self-Check: PASSED

All created/modified files verified present (`src/viz/modules/constants.js`, `src/viz/server.ts`, `tests/viz-activity-palette-invariants.test.ts`); all 4 commits (`307a02e`, `6d5f6a2`, `6a17509`, `995372a`) verified present in git log.
