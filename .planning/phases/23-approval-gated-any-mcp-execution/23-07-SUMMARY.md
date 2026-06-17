---
phase: 23-approval-gated-any-mcp-execution
plan: 07
subsystem: telegram-client
tags: [telegram, mcp, approval-gate, edit-path, hitl, proposal-store, T-SEC-04, D-06]

# Dependency graph
requires:
  - phase: 23-06
    provides: handleProposalAction with Edit stub, pendingTypedConfirm pattern to mirror, runClientTick respond loop intercept seam
  - phase: 23-04
    provides: parsePatch, validateEditedArgs, deriveConfirmValue in proposal-engine.ts
  - phase: 23-03
    provides: proposal-store (getProposal, putProposal, removeProposal, loadExecutable)
  - phase: 23-01
    provides: encodeProposalCallbackData, decodeProposalCallbackData (push-codec v2)
provides:
  - pendingEdit Map + _clearPendingEdit export: second text-intercept state machine (D-06)
  - handleProposalAction edit branch: expiry check + prompt + pending-edit registration + edit-requested audit
  - pending-edit intercept in runClientTick respond loop: fires BEFORE ask() (T-23-07-C)
  - handleEditPatch: parsePatch -> merge -> listServerTools+filterAllowlisted -> validateEditedArgs -> fresh proposal -> new card
  - edit-path.test.ts: 10 tests covering all D-06/T-SEC-04 invariants
affects:
  - 23-08 (final integration — Edit now fully functional)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "pendingEdit Map: mirrors pendingTypedConfirm pattern; text-intercept BEFORE ask(); entry consumed on first match"
    - "handleEditPatch: 8-step flow — parse -> load original -> merge -> listTools -> filter -> validateEditedArgs -> fresh proposal -> send card"
    - "putProposal(fresh) BEFORE removeProposal(old): no dangling button window (T-23-05-C pattern)"
    - "Double intercept order: typed-confirm checked first, pending-edit second — mutually exclusive in practice"

key-files:
  created:
    - clients/telegram/tests/edit-path.test.ts
  modified:
    - clients/telegram/index.ts

key-decisions:
  - "listServerTools called at patch-time (not cached) — ensures allowlist re-check uses live tool descriptors (T-SEC-04)"
  - "MCP connect/list failure on edit -> reject safely (D-02-style degradation); never silently execute unvalidated args"
  - "Original proposal destructive flag preserved in fresh proposal — user's allowlist classification is immutable"
  - "pendingEdit intercept ordered AFTER typed-confirm in respond loop — mutually exclusive (sender has at most one open text state)"
  - "EDIT_TTL_MS = 5 minutes (matches typed-confirm TTL) — bounded window for patch reply"

requirements-completed: [ACT-01, ACT-03]

# Metrics
duration: 10min
completed: 2026-06-17
---

# Phase 23 Plan 07: Edit Path Summary

**D-06 Edit flow wired: Edit tap prompts for a patch, parses it as untrusted input, re-validates against schema + per-server allowlist (T-SEC-04), and stores a fresh proposal requiring a NEW Approve tap — the original approval is never reused**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-06-17T02:57:47Z
- **Completed:** 2026-06-17T03:07:00Z
- **Tasks:** 2 (both TDD: RED/GREEN)
- **Files modified:** 2 (index.ts + 1 new test file)

## Accomplishments

- `pendingEdit` Map added with `_clearPendingEdit()` export; mirrors `pendingTypedConfirm` pattern exactly
- `handleProposalAction` edit branch: `loadExecutable` expiry check before registering state (no state on expired proposals); sends patch prompt; audits `edit-requested` episode with tool + serverName
- Pending-edit intercept in `runClientTick` respond loop fires BEFORE `ask()` (T-23-07-C: edit reply not routed as Q&A)
- `handleEditPatch` full implementation: strict `parsePatch` null-on-malformed; `getProposal` original base; shallow merge; `listServerTools` + `filterAllowlisted` for live descriptor resolution; `validateEditedArgs` schema + allowlist re-check (T-SEC-04); fresh `StoredProposal` with new `randomUUID` id; `putProposal(fresh)` then `removeProposal(old)` (no dangling button window); fresh approval card sent; `edit-applied` audit episode
- All D-06 invariants enforced: edited args are untrusted, schema + allowlist re-checked, original approval never reused, execution only via Approve gate

## Task Commits

1. **Task 1 GREEN: Edit button prompt + pending-edit state machine** - `581ab3b` (feat)
2. **Task 2 RED: failing tests for handleEditPatch** - `cec760e` (test)
3. **Task 2 GREEN: handleEditPatch full implementation + test fix** - `7f69b91` (feat)

## Files Created/Modified

- `clients/telegram/index.ts` — pendingEdit Map + _clearPendingEdit + handleProposalAction edit branch + pending-edit intercept in runClientTick + handleEditPatch implementation + new imports (parsePatch, validateEditedArgs, getProposal)
- `clients/telegram/tests/edit-path.test.ts` — 10 tests: T1-T8 state-machine behavioral tests + 2 direct handleProposalAction call tests

## Decisions Made

- `listServerTools` called at patch-time (not propose-time cached) to get fresh descriptors for `validateEditedArgs` — ensures an allowlist config change between propose and edit takes effect
- MCP list failure during edit results in `edit-rejected` episode + user message; never silently proceeds with unvalidated args
- `pendingEdit` intercept sits AFTER `pendingTypedConfirm` in the respond loop — if a sender somehow had both open (impossible in practice), typed-confirm takes semantic priority

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test assertion used wrong field name for MockTelegramTransport sent entries**
- **Found during:** Task 2 GREEN (tests T3 and T8 failed)
- **Issue:** Tests checked `s.keyboard` but `MockTelegramTransport.sent` records `replyMarkup` (matching the `sendMessage` parameter name)
- **Fix:** Changed `cardMsg?.keyboard` to `cardMsg?.replyMarkup` in T3 and T8 assertions
- **Files modified:** `clients/telegram/tests/edit-path.test.ts`
- **Commit:** `7f69b91`

## Known Stubs

None — the Edit stub from Plan 06 is fully replaced. All four proposal actions (Approve, Edit, Reject, Snooze) are now implemented.

## Threat Model Status

All four threats in the plan's threat model are addressed:

| Threat | Status | How Mitigated |
|--------|--------|--------------|
| T-SEC-04 edit-path arg injection | Mitigated | validateEditedArgs re-checks inputSchema + per-server allowlist; parsePatch null-on-malformed |
| T-23-07-B edited proposal executes on old approval | Mitigated | fresh proposal with new UUID id; old id removed; Approve required on new card (D-06) |
| T-23-07-C edit reply swallowed as Q&A | Mitigated | pendingEdit intercept before respond loop (mirrors Pitfall #3 from typed-confirm) |
| T-23-07-D unaudited edit | Mitigated | edit-requested + edit-applied + edit-rejected episodes written on every branch (H-12) |

## Self-Check

- [x] `clients/telegram/index.ts` modified — grep -c "pendingEdit" = 8 (meets >=2 requirement)
- [x] `clients/telegram/tests/edit-path.test.ts` created — 10 tests all pass
- [x] TypeScript compiles clean (npx tsc -p clients/telegram/tsconfig.json --noEmit exits 0)
- [x] Full test suite: 1420+ passing, 0 failures
- [x] Commits: 581ab3b (feat T1) + cec760e (test T2 RED) + 7f69b91 (feat T2 GREEN)
