---
phase: 52-brain-viz-honest-traces
plan: "04"
subsystem: viz/consolidation
tags: [sse, kind, consolidation-cascade, event-type, brain-viz]
dependency_graph:
  requires: [52-01]
  provides: [SSE-kind-field, cascade-kind-emit]
  affects: [src/viz/server.ts, src/consolidation/run-sleep-pass.ts]
tech_stack:
  added: []
  patterns: [closed-switch-default, shape-transparent-passthrough, fire-and-forget-try-catch]
key_files:
  created: []
  modified:
    - src/viz/server.ts
    - src/consolidation/run-sleep-pass.ts
    - tests/viz-server.test.ts
    - tests/sleep-pass-viz-lighting.test.ts
decisions:
  - "consolidationKind uses a closed switch with default='consolidate' so future event_type additions never produce null kind (T-52-10)"
  - "kind is emitted inside the existing try/catch so a mapper error can never perturb a consolidation pass (T-52-09)"
  - "seeds passthrough is shape-transparent — server never indexes into seed elements; dual-shape contract is explicit via comment (D-07-seedshape)"
metrics:
  duration: "~10 min"
  completed: "2026-06-29"
  tasks_completed: 2
  tasks_total: 2
  files_changed: 4
---

# Phase 52 Plan 04: Kind Through the Backend Summary

SSE trace payload ships `kind` + shape-transparent dual seeds; sleep-pass cascade derives `kind` from each node's `consolidation_event.event_type` via a pure closed-switch mapper and emits it on every step.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Ship kind in SSE trace payload + verbatim dual-shape seeds (server.ts) | 994ff98 | src/viz/server.ts, tests/viz-server.test.ts |
| 2 | Map event_type→kind in the cascade; emit kind (run-sleep-pass.ts) | 253ca54 | src/consolidation/run-sleep-pass.ts, tests/sleep-pass-viz-lighting.test.ts |

## What Was Built

**Task 1 — server.ts SSE payload:**
- Added `kind` to `stmtTrace` SELECT (`SELECT id, ts, query_id, seeds, hops, kind FROM activation_trace ...`)
- Updated row type annotation to include `kind: string | null`
- Included `kind: row.kind ?? null` in the `event: trace` JSON payload
- Added D-07-seedshape comment making the dual-shape passthrough contract explicit
- Extended `SseTracePayload` test interface with `kind` field; added 2 new SSE tests (null kind for recall rows; string kind for ingestion rows with `[{node_id, score}]` seeds)

**Task 2 — run-sleep-pass.ts cascade:**
- Exported pure `consolidationKind(event_type)` mapper: `unrelated`→`new_node`, `contradict_reconcile`→`reconsolidation`, `contradict_oscillation`→`oscillation`, all others→`consolidate`
- Extended cascade query to `SELECT node_id, event_type FROM consolidation_event ...`
- Added `kind: consolidationKind(op.event_type)` to each `traceSink.emit()` call
- Kind mapping inside the existing try/catch — no new throw path can affect consolidation (T-52-09)
- Updated `recordEvent` test helper to accept optional `event_type` (default `'confirm'`)
- Added `traceKinds()` helper + 8 new tests: unit assertions on all 3 hero types + neutral family + unknown; integration tests verifying cascade writes correct kinds to activation_trace and no null kinds appear from cascade emits (D-03)

## Verification

- `npx vitest run tests/sleep-pass-viz-lighting.test.ts tests/viz-server.test.ts` — 37 tests passed (12 sleep-pass + 25 viz-server)
- `npx tsc --noEmit` — clean

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

None — no new network endpoints or trust boundaries introduced. Kind field is derived from a closed switch over the known ConsolidationEventType enum with a `'consolidate'` default; written as a bound param (T-52-10 / T-52-09 mitigated).

## Self-Check: PASSED

- [x] src/viz/server.ts modified — kind in SELECT and payload
- [x] src/consolidation/run-sleep-pass.ts modified — consolidationKind() + cascade emit
- [x] tests/viz-server.test.ts modified — SseTracePayload interface + 2 new kind tests
- [x] tests/sleep-pass-viz-lighting.test.ts modified — recordEvent updated, traceKinds() added, 8 new tests
- [x] Commit 994ff98 exists (Task 1)
- [x] Commit 253ca54 exists (Task 2)
- [x] 37 tests green, tsc clean
