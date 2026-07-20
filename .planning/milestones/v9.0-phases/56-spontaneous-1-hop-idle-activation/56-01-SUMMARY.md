---
phase: 56-spontaneous-1-hop-idle-activation
plan: 01
subsystem: retrieval
tags: [typescript, refactor, honest-trace, viz, retrieval-engine]

# Dependency graph
requires:
  - phase: 55-honest-1-hop-pathways-on-ambient-recall
    provides: "The honest 1-hop filter (kind==='relation' && PRED_SET.has(rel), weight-sort, liveness-before-slot, top-N, score:null hops) inlined in engine.buildAmbientTracePayload"
provides:
  - "src/retrieval/honest-trace.ts — buildHonestOneHopTrace pure helper + HonestTraceReader dependency-injected interface, the single source of truth for the honest 1-hop filter"
  - "engine.buildAmbientTracePayload re-pointed to the shared helper with zero behavior change"
affects: [56-02-spontaneous-emitter, viz-server]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Dependency-injected pure helper (HonestTraceReader interface) extracted from an engine method so two independent callers (engine ambient recall + future spontaneous emitter) share one filter implementation instead of each reimplementing it"

key-files:
  created:
    - src/retrieval/honest-trace.ts
    - tests/honest-trace.test.ts
  modified:
    - src/retrieval/engine.ts

key-decisions:
  - "HonestTraceReader.getNode widened to `{ tombstoned: number } | null | undefined` (not `| undefined` as the plan interface sketch specified) so SemanticStore (whose real getNode returns NodeRow | null) structurally satisfies the interface without an adapter shim"

patterns-established:
  - "Shared read-only trace-building helpers live in src/retrieval/ as standalone modules with a narrow reader interface, not as private engine methods, once more than one caller needs the identical filter"

requirements-completed: [SPONT-01]

# Metrics
duration: ~20min
completed: 2026-07-01
---

# Phase 56 Plan 01: Extract shared honest 1-hop trace builder Summary

**Extracted the Phase-55 honest 1-hop filter out of `RetrievalEngine.buildAmbientTracePayload` into a pure, dependency-injected `buildHonestOneHopTrace` helper in `src/retrieval/honest-trace.ts`, and re-pointed the engine to delegate to it — zero behavior change, verified by the full Phase-55 guard-test suite passing unchanged plus 6 new direct behavior tests.**

## Performance

- **Duration:** ~20 min
- **Tasks:** 2 completed
- **Files modified:** 3 (1 created source, 1 created test, 1 modified)

## Accomplishments
- `buildHonestOneHopTrace` + `HonestTraceReader` now the single source of truth for the honest 1-hop filter (kind==='relation' && PRED_SET.has(rel), weight-desc/dst-asc sort, liveness-before-slot, top-N, (src,dst) de-dup, score:null hops) — the future Phase-56 spontaneous emitter will import the same function, so it structurally cannot reimplement/drift from the honest filter.
- `engine.buildAmbientTracePayload` reduced from a 27-line inline loop to a 1-line delegating call; the duplicate filter logic no longer exists anywhere in engine.ts.
- Full Phase-55 no-drift proof: `activation-trace-wiring.test.ts`, `trace-honest-recall.test.ts`, `ambient-recall.test.ts` all pass with zero assertion changes.
- Full project test suite: 2550 passed / 3 skipped, tsc clean.

## Task Commits

Each task was committed atomically:

1. **Task 1: Create the shared honest 1-hop helper module** (TDD) —
   - `c4373be` (test) — RED: 6 failing behavior tests against the not-yet-existing module
   - `6abfb07` (feat) — GREEN: `honest-trace.ts` created, all 6 tests pass
2. **Task 2: Re-point engine.buildAmbientTracePayload to the shared helper** - `ebf6921` (fix)

_Note: no plan-metadata commit — `.planning/` is gitignored in this repo, so STATE.md/SUMMARY.md updates are on-disk only and are not committed to git._

## Files Created/Modified
- `src/retrieval/honest-trace.ts` - `buildHonestOneHopTrace` pure helper + `HonestTraceReader` interface; read-only, no DB writes/opens (grep-verified).
- `tests/honest-trace.test.ts` - 6 direct behavior tests against a fake in-memory reader (top-N truncation, tombstone-before-slot liveness, kind/PRED_SET exclusion, hop shape + seeds passthrough, dst-asc tiebreak, (src,dst) de-dup).
- `src/retrieval/engine.ts` - `buildAmbientTracePayload` now delegates to `buildHonestOneHopTrace(seeds, this.store, AMBIENT_HOP_TOPN)`; inline filter/sort/liveness loop deleted; `PRED_SET` import dropped (no longer used directly in this file); `AMBIENT_HOP_TOPN = 6` kept as the existing private module-level constant per Phase-55 D-01/D-02.

## Decisions Made

- **`HonestTraceReader.getNode` return type widened to include `null`.** The plan's interface sketch specified `{ tombstoned: number } | undefined`, but `SemanticStore.getNode` actually returns `NodeRow | null`. Passing `this.store` as the reader failed `tsc` under the sketch's signature. Widened to `| null | undefined` so the real store structurally satisfies the interface with no adapter/wrapper needed — matches the plan's own acceptance criterion ("structurally satisfied by SemanticStore"). Rule 1 (bug fix to make the delegation typecheck), not an architectural change.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Widened `HonestTraceReader.getNode` to accept `null`**
- **Found during:** Task 2
- **Issue:** The plan's interface spec (`getNode(id): { tombstoned: number } | undefined`) does not structurally match `SemanticStore.getNode(id): NodeRow | null` — `tsc` failed with `Type 'null' is not assignable to type '{ tombstoned: number; } | undefined'` when passing `this.store` to `buildHonestOneHopTrace`.
- **Fix:** Widened the interface's `getNode` return type to `{ tombstoned: number } | null | undefined`. Optional chaining (`?.tombstoned`) already handles both `null` and `undefined` identically, so this has no behavioral effect on the filter.
- **Files modified:** `src/retrieval/honest-trace.ts`
- **Verification:** `tsc --noEmit` clean; all tests pass.
- **Committed in:** `ebf6921` (part of Task 2 commit)

**2. [Rule 1 - Bug, incidental] Removed a stray NUL byte from the deleted inline code**
- **Found during:** Task 2
- **Issue:** While reading the exact bytes of the inline `buildAmbientTracePayload` body to extract it verbatim, discovered the de-dup key line in the pre-existing `engine.ts` code contained a literal NUL byte (`\x00`) instead of a space character inside the template literal (`` `${seed.node_id}\x00${edge.dst}` ``) — pre-existing corruption in HEAD, not introduced by this plan. Functionally harmless (any unique delimiter works as a Set key), but odd/corrupted-looking source.
- **Fix:** No separate fix needed — the new `honest-trace.ts` helper (written independently per the plan's `<action>` spec) already uses a normal space delimiter. Deleting the inline block and delegating to the helper resolved this as a natural side effect of the extraction.
- **Files modified:** `src/retrieval/engine.ts` (resolved via deletion, not a targeted edit)
- **Verification:** `python3` byte-scan confirmed zero NUL bytes remain in `engine.ts` after the edit.
- **Committed in:** `ebf6921` (part of Task 2 commit)

## Known Stubs

None.

## Threat Flags

None — pure in-process refactor, no new inputs/writers/DB handles (per the plan's own threat model; T-56-01a and T-56-01b mitigations both verified: grep for INSERT/UPDATE/DELETE/new Database in honest-trace.ts returns nothing, and the Phase-55 guard tests re-ran green).

## Self-Check: PASSED

- `src/retrieval/honest-trace.ts` — FOUND
- `tests/honest-trace.test.ts` — FOUND
- `c4373be` — FOUND (in git log)
- `6abfb07` — FOUND (in git log)
- `ebf6921` — FOUND (in git log)
