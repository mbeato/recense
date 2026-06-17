---
phase: 23-approval-gated-any-mcp-execution
plan: 06
subsystem: telegram-client
tags: [telegram, mcp, approval-gate, typed-confirm, hitl, proposal-store]

# Dependency graph
requires:
  - phase: 23-05
    provides: runPushTick with proposal generation, pendingTypedConfirm map setup, handleProposalAction skeleton
  - phase: 23-03
    provides: proposal-store (loadExecutable, removeProposal, putProposal)
  - phase: 23-02
    provides: mcp-client (callServerTool, extractToolOutput)
  - phase: 23-01
    provides: decodeProposalCallbackData, encodeProposalCallbackData (push-codec v2)
provides:
  - v2 callback routing in runClientTick callback drain (version-prefix check before decodeCallbackData)
  - handleProposalAction: reject/snooze/approve (non-destructive + destructive) with full audit trail
  - executeStoredProposal shared helper: expiry re-check + allowlist re-check + callTool + audit + removeProposal
  - typed-confirm state machine: pendingTypedConfirm Map + intercept in respond loop (BEFORE ask())
  - ApprovalTestHooks interface for injectable storePath/mcpConfigs/connectionFactory
  - 29 passing tests: typed-confirm.test.ts (6) + approval-handler.test.ts (10) + callback-query.test.ts (13 unchanged)
affects:
  - 23-07 (Edit path will extend handleProposalAction)
  - 23-08 (final integration)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Double load pattern: loadExecutable called at approve time (destructive check) + again at execute time (expiry/TOCTOU safety)"
    - "pendingTypedConfirm Map: module-level in-memory state for typed-confirm; process-lifetime only (restart = re-tap Approve)"
    - "Lazy approval config getters: getApprovalStorePath() + getApprovalMcpConfigs() — no I/O overhead on idle ticks"
    - "executeStoredProposal shared helper: DRY across direct approve and typed-confirm paths"
    - "Version-prefix routing: data.startsWith('2|') before decodeCallbackData to keep v1/v2 mutually exclusive"

key-files:
  created:
    - clients/telegram/tests/typed-confirm.test.ts
    - clients/telegram/tests/approval-handler.test.ts
  modified:
    - clients/telegram/index.ts

key-decisions:
  - "answerCallbackQuery stays in outer drain loop, not inside handleProposalAction — matches v1 pattern; no double-ack risk"
  - "executeStoredProposal shared between direct approve and typed-confirm paths to prevent security-check drift"
  - "pendingTypedConfirm keyed by String(chatId) — chatId === fromId in private Telegram chats"
  - "Double loadExecutable is intentional: first load at approve time gets proposal.destructive; second load at execute time re-checks expiry (TOCTOU safety)"
  - "Edit action stubbed in handleProposalAction — sends 'not yet supported' message; Plan 07 implements fully"

patterns-established:
  - "ApprovalTestHooks: injectable storePath/mcpConfigs/connectionFactory mirrors ProposalTestHooks pattern for testable runClientTick v2 path"
  - "_clearPendingTypedConfirm() test helper drains module-level state between tests"

requirements-completed: [ACT-01, ACT-02, ACT-03]

# Metrics
duration: 7min
completed: 2026-06-16
---

# Phase 23 Plan 06: Approval-Handler Summary

**Hard HITL approval gate wired: v2 callback routing, reject/snooze/approve (expiry+allowlist re-check+immutable payload), and destructive-tool typed-confirm state machine with full hitlEpisode audit on every decision**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-06-16T22:40:00Z
- **Completed:** 2026-06-16T22:47:00Z
- **Tasks:** 3 (TDD: 3 x RED/GREEN)
- **Files modified:** 3 (index.ts + 2 new test files)

## Accomplishments

- v2 proposal callbacks route correctly in the callback drain (version-prefix check before decodeCallbackData; v1 path unchanged)
- handleProposalAction covers all four actions: reject (audit+remove), snooze (audit), approve-non-destructive (executeStoredProposal), approve-destructive (typed-confirm prompt + register pendingTypedConfirm)
- executeStoredProposal enforces all execution-time security checks: expiry (H-05), allowlist re-check (H-04), immutable payload (H-06), Pitfall #2 (transport throw AND isError=true both write failure episodes)
- typed-confirm intercept in the respond loop fires BEFORE memoryClient.ask() — preventing confirmation values from routing as Q&A queries (Pitfall #3)
- answerCallbackQuery always fires on every v2 branch (Pitfall #1)

## Task Commits

1. **Task 1: v2 callback routing + Reject/Snooze + Approve->execute** - `6b417f1` (feat)
2. **Task 2 RED: failing typed-confirm tests** - `f5112aa` (test)
3. **Task 2 GREEN: wire typed-confirm intercept** - `188f38d` (feat)
4. **Task 3: approval-handler integration tests** - `dfc28cc` (test)

## Files Created/Modified

- `clients/telegram/index.ts` — v2 routing + handleProposalAction + executeStoredProposal + pendingTypedConfirm state machine + ApprovalTestHooks
- `clients/telegram/tests/typed-confirm.test.ts` — 6 tests: destructive approve (no execute), correct typed value (execute), wrong value (abort), Q&A regression, non-destructive direct, handleProposalAction direct call
- `clients/telegram/tests/approval-handler.test.ts` — 10 tests: expired, allowlist-revoked, reject, snooze, execute-success, execute-isError, execute-throw, answerCallbackQuery invariant, direct handleProposalAction calls

## Decisions Made

- answerCallbackQuery lives in the outer callback drain loop (not inside handleProposalAction) — mirrors Phase-22 v1 pattern exactly; no risk of double-ack or missed ack
- Shared `executeStoredProposal` helper used by both direct approve and typed-confirm confirm path to keep security checks DRY and non-diverging
- Edit action stubbed with "not yet supported" message — intentional per plan (Plan 07 implements the full edit flow)

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

**1. Edit action in handleProposalAction (intentional, Plan 07)**
- **File:** `clients/telegram/index.ts` (handleProposalAction, `action === 'edit'` branch)
- **Stub:** Sends "Edit is not yet supported. Tap Approve or Reject."
- **Reason:** Plan explicitly defers Edit to Plan 07. The stub prevents silent failure when the Edit button is tapped.
- **Resolving plan:** 23-07

## Threat Model Status

All five threats in the plan's threat model are addressed:

| Threat | Status | How Mitigated |
|--------|--------|--------------|
| T-23-06-A TOCTOU (approve stale action) | Mitigated | loadExecutable expiry check at execute time in executeStoredProposal |
| T-23-06-B Post-propose allowlist change | Mitigated | allowlist re-check (serverCfg.allowedTools.some) inside executeStoredProposal |
| T-23-06-C Fat-finger destructive approve | Mitigated | pendingTypedConfirm + expectedConfirmValue from stored payload |
| T-23-06-D Typed-confirm swallowed as Q&A | Mitigated | pendingConfirm check runs BEFORE memoryClient.ask() in respond loop |
| T-23-06-E Masked execution failure | Mitigated | both transport throw and result.isError===true write failure episode |

No new threat surface introduced beyond what the plan's threat model covers.

## Issues Encountered

None.

## Next Phase Readiness

- Plan 07 (Edit path) can extend `handleProposalAction`'s edit branch stub directly
- Plan 08 (final integration) can wire `runClientTick` with `approvalHooks` in production `main()`
- All Phase-22 callback-query tests remain green (13/13)

---
*Phase: 23-approval-gated-any-mcp-execution*
*Completed: 2026-06-16*
