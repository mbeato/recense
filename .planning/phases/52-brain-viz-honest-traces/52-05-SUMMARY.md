---
phase: 52-brain-viz-honest-traces
plan: "05"
subsystem: adapter/viz-bridge
tags: [viz, remember, bridge, tdd, activation-trace]
dependency_graph:
  requires: [52-01]
  provides: [remember-viz-bridge, D-08-zero-duplicate, WARN-1-cross-seam]
  affects: [src/adapter/remember-cli.ts, src/viz/activation-sink.ts]
tech_stack:
  added: []
  patterns: [fire-and-forget-try-catch, switchable-sink-pattern, tdd-red-green]
key_files:
  created:
    - src/adapter/remember-viz-bridge.ts
    - tests/remember-viz-bridge.test.ts
  modified:
    - src/adapter/remember-cli.ts
decisions:
  - "MID_SCORE=0.5 for reconsolidation hop (D-07: no fabricated magnitude — actual PE is inside the transaction)"
  - "rememberTraceInput returns full ActivationTraceInput including query_id=newId() — pure except for ID generation"
  - "bridgeRememberToViz calls traceSink.refresh() after construction to mirror ambient-recall.ts precedent"
metrics:
  duration: "3m 7s"
  completed: "2026-06-29T21:55:12Z"
  tasks_completed: 2
  files_changed: 3
---

# Phase 52 Plan 05: Remember-Viz Bridge Summary

Bridge the synchronous `recense remember` result onto the activation_trace SSE stream: action→kind mapping with WARN-1 cross-seam shape lock, fire-and-forget try/catch safety, and D-08 #2 zero-duplicate guarantee.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (TDD RED) | Failing tests — pure mapper + WARN-1 + fire-and-forget | 69e2e8e | tests/remember-viz-bridge.test.ts |
| 1 (TDD GREEN) | remember-viz-bridge.ts — pure mapper + bridge | 3bc6bb6 | src/adapter/remember-viz-bridge.ts |
| 2 (TDD GREEN) | Wire bridge into remember-cli + D-08 #2 data-layer tests | 4abf4d0 | src/adapter/remember-cli.ts |

## What Was Built

### src/adapter/remember-viz-bridge.ts (new)

**`rememberTraceInput(result: RememberResult): ActivationTraceInput`** — pure action→kind mapper:
- `insert` → `{ kind: 'new_node', seeds: [newNodeId], hops: [] }`
- `reconcile` → `{ kind: 'reconsolidation', seeds: [supersededNodeId], hops: [{node_id:newNodeId, score:0.5, hop:1}] }`
- `oscillation` → `{ kind: 'oscillation', seeds: [newNodeId], hops: [] }`

WARN-1 cross-seam contract (pinned by unit test): the reconcile shape exactly matches what Plan 03's `applyTrace` reconsolidation branch consumes — `seeds[0]` = existing node (flashed magenta), `hops[0].node_id` = arriving candidate (green blip merging in).

**`bridgeRememberToViz(db, clock, result): void`** — fire-and-forget:
- Constructs `SwitchableActivationTraceSink(db, clock)`, calls `refresh()`
- Returns immediately if flag is off (Noop, zero writes)
- Emits one row on success
- Entire body in try/catch swallow (T-52-11: sink failure never surfaces to remember path)

### src/adapter/remember-cli.ts (modified)

Added import `{ bridgeRememberToViz }` and one call site placed after `runRemember` result, before output writes, while `db` is still open. Called inside the existing try block; bridge's own try/catch means no error propagation.

### tests/remember-viz-bridge.test.ts (new, 11 tests)

- 4 pure-mapper tests: each action maps to correct kind/seeds/hops
- 1 WARN-1 cross-seam assertion: reconcile shape exactly matches Plan 03 consumer contract
- 2 fire-and-forget safety tests: closed DB and flag-off paths do not throw
- 4 data-layer tests (D-08 #2): DB row counts verified per action + flag state

## Verification

```
npx vitest run tests/remember-viz-bridge.test.ts -> 11/11 passed
npx tsc --noEmit -> clean
tests/remember-cli.test.ts -> 8/8 passed (no regression)
```

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None.

## Threat Flags

No new network endpoints, auth paths, file access patterns, or schema changes introduced.
The bridge reads a pre-existing meta flag and writes to an existing activation_trace table.
T-52-11 (Tampering) and T-52-12 (DoS) mitigations applied as specified in the threat register.

## Self-Check: PASSED

- src/adapter/remember-viz-bridge.ts: EXISTS
- tests/remember-viz-bridge.test.ts: EXISTS
- src/adapter/remember-cli.ts modified: bridgeRememberToViz found at import + call site
- Commits: 69e2e8e (RED test), 3bc6bb6 (GREEN bridge), 4abf4d0 (GREEN wire) — all present
