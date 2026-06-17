---
phase: 23-approval-gated-any-mcp-execution
plan: "05"
subsystem: clients/telegram
tags: [proposal-generation, push-tick, approval-gate, deepseek, mcp-client, hitl]
dependency_graph:
  requires: ["23-01", "23-02", "23-03", "23-04"]
  provides: ["runPushTick-proposal-path", "tryGenerateProposal", "renderProposalCard", "proposalKeyboard"]
  affects: ["clients/telegram/index.ts"]
tech_stack:
  added: []
  patterns: ["injectable-test-hooks", "proposal-generation-additive-branch", "send-then-mark-D02"]
key_files:
  created:
    - clients/telegram/tests/proposal-push.test.ts
  modified:
    - clients/telegram/index.ts
decisions:
  - "ProposalTestHooks interface injects actionConfig/mcpConfigs/connectionFactory/fetchImpl into runPushTick for deterministic testing without live network calls"
  - "tryGenerateProposal exported separately so tests can assert on its behavior via the runPushTick testHooks path"
  - "hasProposalConfig = mcpConfigs.length > 0 && deepseekApiKey !== '': gate prevents unnecessary DeepSeek calls when no config is present"
  - "Cap exhausted path falls directly to sendSurfacedItem without hitlEpisode (no proposal decision was made)"
  - "putProposal before sendMessage so the proposalId always exists in the store before the approval card reaches the user"
metrics:
  duration_seconds: 425
  completed_date: "2026-06-17"
  tasks_completed: 2
  files_changed: 2
---

# Phase 23 Plan 05: Proposal Generation Wired into runPushTick — Summary

Wires the proposal generation path (plans 01–04) into the `runPushTick` push tick as an additive branch on every P0 item: reserve a daily-cap slot → generate a confident {tool,args} proposal → store + send an approval card rendered from the serialized payload, or fall back to the Phase-22 plain notify if the proposal is null. Phase-22 guards (pushInFlight, proactiveEnabled, send-then-mark, quiet-hours-pierce) preserved exactly.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Proposal generation path in runPushTick (D-01/D-02/D-03) | bb528ae | clients/telegram/index.ts |
| 2 | Push-tick proposal-vs-fallback unit tests | 6f86637 | clients/telegram/tests/proposal-push.test.ts |

## What Was Built

**Task 1 — `clients/telegram/index.ts` extensions:**

- `renderProposalCard(proposal)`: plain-text card rendering tool name + serialized args + due date. DATA ONLY — never contains DeepSeek prose (T-23-05-A / ACT-01).
- `proposalKeyboard(proposalId)`: 4-button inline keyboard (Approve / Edit / Reject / Snooze) via `encodeProposalCallbackData` with v2 callback_data encoding.
- `ProposalTestHooks` interface: injectable `actionConfig`, `mcpConfigs`, `connectionFactory`, `fetchImpl` for deterministic unit testing.
- `tryGenerateProposal(memoryClient, item, actionConfig, mcpConfigs, connectionFactory?, fetchImpl?)`: full proposal flow in one bounded function — search → multi-server listServerTools → filterAllowlisted → buildProposalPrompt → callDeepSeek → validateProposal → StoredProposal. Returns `null` on any failure (MCP timeout, null tool, engine error, no servers).
- `runPushTick` P0 loop modified: `tryReserveProposalSlot` → `tryGenerateProposal` → `putProposal + sendMessage + surfaceSeen + hitlEpisode('propose')` on success, or `sendSurfacedItem + hitlEpisode('notify-fallback')` on failure. Cap-exhausted path degrades directly to plain notify. P1/digest path unchanged.

**Task 2 — `clients/telegram/tests/proposal-push.test.ts`:** 11 tests covering:
- Confident proposal → 4-button approval keyboard (Approve/Edit/Reject/Snooze), serialized payload text, v2 `2|` encoding on all buttons
- `{tool:null}` → Phase-22 plain notify (3-button Done/Dismiss/Snooze), v1 `1|` encoding
- Cap exhausted (dailyCap=0) → plain notify, zero DeepSeek fetch calls
- StoredProposal in store with `destructive=true`, `expectedConfirmValue='coach@example.com'` (D-09 typed confirm from `to` field)
- send-then-mark D-02 order in the proposal path: `sendMessage` fires before `surfaceSeen`
- `hitlEpisode` audit: `decision='propose'` (with tool+serverName) on success; `decision='notify-fallback'` on null
- P1 tier-1 item at digest hour: plain Phase-22 notify only, zero DeepSeek calls

## Deviations from Plan

None — plan executed exactly as written.

The `ProposalTestHooks` interface and the `testHooks` optional parameter on `runPushTick` are the named injection approach the plan calls "injected mock proposal engine / DeepSeek fetch returning scripted JSON". The parameter name `testHooks` is prefixed to make the testing-only nature clear without changing the production call sites.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. New code lives entirely within the existing `clients/telegram/` boundary. The `renderProposalCard` function adds a new card path at the Telegram push boundary — it is data-only (T-23-05-A confirmed by test asserting the card does not contain raw DeepSeek response fields).

## Known Stubs

None — all data flows are wired to real sources (stored `StoredProposal`, not placeholders).

## Self-Check: PASSED

- FOUND: clients/telegram/index.ts (modified)
- FOUND: clients/telegram/tests/proposal-push.test.ts (created)
- FOUND: .planning/phases/23-approval-gated-any-mcp-execution/23-05-SUMMARY.md
- FOUND: commit bb528ae (feat Task 1)
- FOUND: commit 6f86637 (test Task 2)
- TypeScript: clean (0 errors)
- Tests: 25/25 pass (11 new proposal-push + 14 push-timer preserved)
