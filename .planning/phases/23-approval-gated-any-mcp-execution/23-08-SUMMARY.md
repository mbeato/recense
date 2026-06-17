---
phase: 23-approval-gated-any-mcp-execution
plan: "08"
subsystem: clients/telegram
tags: [deepseek, smoke-test, proposal-engine, a1-a2-validation, client-01]
dependency_graph:
  requires: ["23-07"]
  provides: ["deepseek-smoke script for A1/A2 model-string validation"]
  affects: []
tech_stack:
  added: []
  patterns: ["smoke script reusing proposal-engine functions", "env-config with masked API key"]
key_files:
  created:
    - clients/telegram/scripts/deepseek-smoke.ts
  modified: []
decisions:
  - "Reused callDeepSeek/buildProposalPrompt/validateProposal directly from proposal-engine.ts — no HTTP reimplementation"
  - "Fixed synthetic fixtures (no live memory/MCP) so the script is purely a model-string + json_object validator"
  - "Partial-PASS exit-0: JSON parsed but validateProposal {tool:null} counts as A1/A2 validated (API reachable, json_object works)"
  - "FAIL exit-1: HTTP error (4xx/5xx) OR response does not parse as JSON"
metrics:
  duration: "~5 minutes"
  completed: "2026-06-16"
  tasks_completed: 1
  tasks_total: 2
  files_created: 1
  files_modified: 0
---

# Phase 23 Plan 08: Live DeepSeek Smoke Test — Summary

One-shot smoke script that validates the DeepSeek model string + json_object mode
(RESEARCH Assumptions A1/A2) by calling callDeepSeek/buildProposalPrompt/validateProposal
from proposal-engine.ts with synthetic fixed fixtures.

## Tasks

### Task 1: Live DeepSeek smoke script — COMPLETE

**Commit:** `398f5fa`
**File:** `clients/telegram/scripts/deepseek-smoke.ts`

The script:
- Reads `DEEPSEEK_API_KEY` (never logged, exits 1 if missing), `DEEPSEEK_MODEL` (default `deepseek-chat`), `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com/v1`)
- Builds a synthetic P0 `SurfaceItem` + two-tool `McpToolDescriptor[]` allowlist + two synthetic search results — no live memory or MCP connection required
- Calls `buildProposalPrompt` then `callDeepSeek` exactly once
- Prints: raw JSON response, whether it parsed, and whether `validateProposal` accepts it
- Exits non-zero on any HTTP error (wrong model string or base URL surfaces clearly)
- Prints cost note: `~$0.27/1M input + ~$1.10/1M output; ~$0.0003 per smoke call`
- Zero `src/` imports (CLIENT-01); `npx tsc -p clients/telegram/tsconfig.json --noEmit` exits 0

### Task 2: End-to-End Acceptance Gate — PENDING (checkpoint:human-verify)

Task 2 is a blocking human-verify checkpoint requiring the founder to run against a live
MCP server + DeepSeek key. It has NOT been executed.

**Verification steps (8 checks the founder must complete):**

1. Configure `~/.config/recense/mcp-servers.json` (0600) with ONE real MCP server and ONE
   allowlisted tool — include one tool labeled `destructive: true`. Set `DEEPSEEK_API_KEY`
   and `RECENSE_PROACTIVE_ENABLED=true`.

2. Run `node clients/telegram/dist/scripts/deepseek-smoke.js` (after
   `tsc -p clients/telegram/tsconfig.json`). Confirm it returns valid JSON and
   `validateProposal` accepts a sensible `{tool, args}` — this validates
   DEEPSEEK_MODEL/BASE_URL (A1/A2). Cost ~$0.01–$0.05.

3. Trigger a real P0 surfaced item. Confirm a Telegram approval card arrives rendered
   from the serialized `{tool, args}` (NOT prose), piercing quiet hours if applicable.

4. Tap Approve on the NON-destructive tool — confirm the MCP tool executes and a result
   message arrives; confirm a `source:'hitl'` execute episode appears (check `/v1/add`
   ingest / sleep-pass log).

5. Trigger/approve the DESTRUCTIVE tool — confirm the bot demands the typed confirmation
   value from the payload; type a WRONG value (aborts), then the correct value (executes).

6. Tap Edit on a fresh proposal — reply with a JSON patch — confirm a NEW card appears
   and requires a NEW Approve tap.

7. Confirm an expired proposal (let a P0 deadline pass) refuses execution with the
   "expired" message.

8. Spot-check that no `node.s`/`node.c` belief row was strengthened by any of the above
   (D-43): only `hitl` episodes were written.

**Resume signal:** Type "approved" once all eight checks pass, or describe failures
(which step, observed vs expected) for gap closure.

## Deviations from Plan

None. Task 1 executed exactly as specified. Task 2 is correctly left as a pending
checkpoint — no live DeepSeek call was made by the executor.

## Threat Flags

None. The smoke script introduces no new network endpoints or auth paths beyond what
proposal-engine.ts already exposes. The key is read from env and never logged.

## Self-Check

- [x] `clients/telegram/scripts/deepseek-smoke.ts` exists at the correct worktree path
- [x] `npx tsc -p clients/telegram/tsconfig.json --noEmit` exits 0
- [x] Commit `398f5fa` exists and contains only the smoke script (1 file, 220 insertions)
- [x] No `src/` imports in the script (CLIENT-01 compliant)
- [x] Task 2 NOT executed; no live DeepSeek call made; STATE.md/ROADMAP.md not modified

## Self-Check: PASSED
