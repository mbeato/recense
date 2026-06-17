---
phase: 23-approval-gated-any-mcp-execution
plan: 10
subsystem: clients/telegram
tags: [gap-closure, surfaceSeen, dedup, proposal-lifecycle, ACT-01]
dependency_graph:
  requires: [23-08]
  provides: [GAP-02-closed]
  affects: [clients/telegram/index.ts, clients/telegram/types.ts]
tech_stack:
  added: []
  patterns: [TDD-red-green, try-catch-no-throw discipline, occurrence-identity-pair]
key_files:
  created: []
  modified:
    - clients/telegram/types.ts
    - clients/telegram/index.ts
    - clients/telegram/tests/proposal-engine.test.ts
    - clients/telegram/tests/approval-handler.test.ts
    - clients/telegram/tests/proposal-store.test.ts
    - clients/telegram/tests/typed-confirm.test.ts
    - clients/telegram/tests/edit-path.test.ts
decisions:
  - "surfaceSeen on execute-success only (isError===false); failed execute stays non-terminal — item may legitimately re-surface for retry"
  - "reject branch: getProposal before removeProposal; null-safe (proposal already gone skips surfaceSeen, hitlEpisode still written)"
  - "nodeId made required field (not optional) — every proposal must carry occurrence identity at propose time; handleEditPatch carries it through unchanged (occurrence identity is stable across edits)"
metrics:
  duration_minutes: 10
  completed: 2026-06-17T16:31:09Z
  tasks_completed: 2
  tasks_total: 2
  tests_before: 256
  tests_after: 261
  tests_added: 5
---

# Phase 23 Plan 10: GAP-02 Terminal surfaceSeen on execute/reject Summary

StoredProposal now carries `nodeId` (the surfaced item's node_id), and on a terminal decision the client records a `surfaceSeen` outcome for the occurrence `(nodeId, dueAt)` so `GET /v1/surface` excludes it on the next push tick — daily cap becomes a backstop, not the only brake.

## What Was Built

**Task 1 — StoredProposal.nodeId field**
- `clients/telegram/types.ts`: Added required `nodeId: string` to `StoredProposal`, placed next to `dueAt` so the occurrence-identity pair `(nodeId, dueAt)` is co-located. JSDoc explains the GAP-02 / ACT-01 purpose.
- `clients/telegram/index.ts` `tryGenerateProposal` (line 742): `nodeId: item.node_id` set in the immutable StoredProposal literal alongside existing `dueAt: new Date(item.due_at).toISOString()`.
- `clients/telegram/index.ts` `handleEditPatch` (fresh proposal, line ~971): `nodeId: original.nodeId` carried through — occurrence identity is stable across user edits (D-06 edit path creates a new proposal id but the same surface occurrence).
- All test fixtures updated: `approval-handler.test.ts`, `proposal-store.test.ts`, `typed-confirm.test.ts`, `edit-path.test.ts`.

**Task 2 — Terminal surfaceSeen calls**
- `executeStoredProposal`: after `isError === false` only, calls `memoryClient.surfaceSeen({ node_id: proposal.nodeId, occurrence_due_at: proposal.dueAt, outcome: 'completed' })` in a try/catch (mirrors existing hitlEpisode error discipline). A one-line comment explains why isError===true is non-terminal.
- `handleProposalAction` reject branch: loads the proposal via `getProposal(proposalId, storePath)` (returns regardless of expiry). If non-null, calls `surfaceSeen({ outcome: 'dismissed' })` in a try/catch. Then proceeds with the existing `removeProposal` + `hitlEpisode({decision:'reject'})`. If null (already gone) — skips surfaceSeen, keeps current behavior.
- Snooze branch: unchanged (re-offer is deferred per CONTEXT.md; snooze is non-terminal).

## Tests Added (5 new, 256 → 261)

| Test | File | Assertion |
|------|------|-----------|
| `returned StoredProposal.nodeId equals item.node_id (GAP-02)` | proposal-engine.test.ts | tryGenerateProposal returns proposal with nodeId === item.node_id |
| `successful execute records surfaceSeen({outcome:"completed"})` | approval-handler.test.ts | node_id + occurrence_due_at match; exactly 1 completed call |
| `reject records surfaceSeen({outcome:"dismissed"})` | approval-handler.test.ts | node_id + occurrence_due_at match; no callTool |
| `failed execute (isError=true) does NOT record surfaceSeen({outcome:"completed"})` | approval-handler.test.ts | zero completed calls when tool returns isError=true |
| `reject for missing proposal does not throw and records no surfaceSeen` | approval-handler.test.ts | no throw, no surfaceSeen, hitlEpisode(reject) still written |

## Deviations from Plan

None — plan executed exactly as written. All acceptance criteria verified:
- `nodeId` in types.ts ✓
- `nodeId: item.node_id` in tryGenerateProposal ✓
- `nodeId: original.nodeId` in handleEditPatch ✓
- `outcome: 'completed'` guarded by `isError === false` ✓
- `outcome: 'dismissed'` in reject branch ✓
- `getProposal` in reject branch before removeProposal ✓
- Snooze branch unchanged ✓
- CLIENT-01 boundary: zero src/ imports added ✓
- tsc clean ✓
- 261/261 tests ✓

## Known Stubs

None. Both surfaceSeen calls wire to the real `memoryClient.surfaceSeen` which POSTs to `POST /v1/surface/seen`.

## Threat Flags

None. No new network endpoints or auth paths introduced. surfaceSeen already existed for the plain-notify path — this plan adds calls at two new decision points (execute-success, reject) using the same existing method.

## Self-Check

- [x] `clients/telegram/types.ts` modified (nodeId field added)
- [x] `clients/telegram/index.ts` modified (tryGenerateProposal, handleEditPatch, executeStoredProposal, handleProposalAction reject)
- [x] Commits exist: 3dd9201 (RED T1), 25f9ae5 (GREEN T1), 4beaedd (RED T2), e6e832f (GREEN T2)
- [x] tsc --noEmit: exit 0
- [x] npx vitest run clients/telegram: 261/261

## Self-Check: PASSED
