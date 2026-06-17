---
phase: 23-approval-gated-any-mcp-execution
plan: 01
subsystem: telegram-client
tags: [mcp, approval-gate, config, codec, security, injection-hardening]
dependency_graph:
  requires: []
  provides:
    - "clients/telegram/types.ts: AllowlistEntry, McpServerConfig, StoredProposal, ProposalAction"
    - "clients/telegram/config.ts: loadMcpConfig(), loadActionConfig(), ActionConfig"
    - "clients/telegram/push-codec.ts: encodeProposalCallbackData(), decodeProposalCallbackData()"
  affects:
    - "Downstream Phase 23 plans (proposal-store, proposal-engine, mcp-client, index wiring) consume these contracts"
tech_stack:
  added: []
  patterns:
    - "Fail-closed config load (missing file → [], malformed → [])"
    - "Default-destructive allowlist (entry.destructive ?? true)"
    - "${ENV} interpolation; secrets never inline, never logged"
    - "0600 permission gate refusal"
    - "Strict null-on-malformed codec (T-22-02), version-prefix routing"
key_files:
  created:
    - clients/telegram/tests/config-mcp.test.ts
  modified:
    - clients/telegram/types.ts
    - clients/telegram/config.ts
    - clients/telegram/push-codec.ts
    - clients/telegram/tests/push-codec.test.ts
decisions:
  - "D-05 config format: mcp.json-style keyed object under `mcpServers`, server name = key"
  - "loadActionConfig() as a sibling to loadClientConfig() rather than extending ClientConfig — keeps the reactive Q&A path free of any DeepSeek dependency"
  - "Unresolved ${VAR} substitutes '' (fail-closed) rather than leaking the literal token"
metrics:
  duration: ~10m
  completed: 2026-06-17
  tasks: 3
  files: 5
---

# Phase 23 Plan 01: Approval-Gated Execution Foundation Primitives Summary

Client-side contracts for approval-gated MCP execution: the shared proposal/server types, an `mcp-servers.json` loader with default-destructive allowlist + env-interpolated secrets, DeepSeek/cap envs, and a strict version-2 proposal callback_data codec.

## What Was Built

### Task 1 — Proposal + MCP config types (`types.ts`, commit d6d043e)
Four exported contracts, zero `src/` imports:
- `AllowlistEntry { name, destructive }` — D-08 user-classified destructive label.
- `McpServerConfig { name, transport, command?, args?, url?, env?, allowedTools }` — stdio/http server entry.
- `StoredProposal { id, serverName, tool, args, dueAt, maxTtlMs, createdAt, destructive, expectedConfirmValue }` — immutable pending proposal (D-07), with `expectedConfirmValue` for D-09 typed confirm.
- `type ProposalAction = 'approve' | 'edit' | 'reject' | 'snooze'`.

Each field documents the decision it serves (`args` IMMUTABLE → D-07; `destructive` → D-08; `expectedConfirmValue` → D-09).

### Task 2 — `loadMcpConfig()` + `loadActionConfig()` (`config.ts`, commit c22cc94)
- `loadMcpConfig(): McpServerConfig[]` reads `RECENSE_MCP_CONFIG_PATH` (default `~/.config/recense/mcp-servers.json`).
  - Missing file → `[]` (fail-closed: nothing configured = nothing proposable).
  - File mode more permissive than 0600 → `console.warn` + refuse (`[]`) (H-14).
  - Malformed JSON / missing `mcpServers` key → `[]`.
  - Allowlist parse: `entry.destructive` is a boolean only when explicitly set, else `true` (H-10 default-destructive). `destructiveHint`/`readOnlyHint` are never read (D-08 / H-11).
  - `${VAR}` interpolation on `env` values and `url` from `process.env`; unresolved → `''` (H-14); inline literals with no `${}` pass through verbatim.
- `loadActionConfig(): ActionConfig` reads `DEEPSEEK_API_KEY` (''), `DEEPSEEK_MODEL` (`deepseek-chat`), `DEEPSEEK_BASE_URL` (`https://api.deepseek.com/v1`), `RECENSE_PROPOSAL_DAILY_CAP` (10), `RECENSE_PROPOSAL_MAX_TTL_MS` (86400000), `RECENSE_PROPOSAL_STORE_PATH` (`~/.config/recense/pending-proposals.json`). The DeepSeek key is never passed to any `log()` call (H-13).
- 14 tests in `tests/config-mcp.test.ts`.

### Task 3 — v2 proposal codec (`push-codec.ts`, commit f01efe8)
- `encodeProposalCallbackData(proposalId, action)` → `2|{proposalId}|{code}` (41 bytes for a UUID, < 64).
- `decodeProposalCallbackData(data)` → `{ proposalId, action } | null`; strict: exactly 3 parts, `version === '2'`, non-empty proposalId, code in closed set `{a,e,r,s}` → `{approve,edit,reject,snooze}`.
- v1 `encodeCallbackData`/`decodeCallbackData` left untouched; v1 and v2 are mutually exclusive by version prefix (a v2 string returns null from v1 decode and vice-versa).
- 19 new tests added to `tests/push-codec.test.ts`.

## Threat Model Coverage

| Threat ID | Mitigation delivered |
|-----------|----------------------|
| T-23-01-A (allowlist tampering) | `entry.destructive ?? true` (H-10); server hints never read (H-11) — tests assert both |
| T-23-01-B (secret disclosure) | `${ENV}` interpolation only (H-14); 0600 refusal; DeepSeek key never logged (H-13) |
| T-23-01-C (callback_data tampering) | strict split/length/version/code validation → null on any malformed input (T-22-02) |

## Verification

- `npx tsc -p clients/telegram/tsconfig.json --noEmit` → clean.
- `npm test -- config-mcp` → 14/14 pass.
- `npm test -- push-codec` → 34/34 pass (15 v1 + 19 v2).
- `npm test -- import-boundary` → pass (zero `src/` imports).
- Full client suite `npm test -- clients/telegram` → 121/121 pass.

## Deviations from Plan

None — plan executed exactly as written.

## Acceptance Criteria

- Task 1: `grep -c` for the three interface exports returns 3; tsc clean; no `src/` imports. ✓
- Task 2: missing-file → []; destructive omitted → true; destructive:false honored; destructiveHint:false ignored; `${VAR}` interpolation; inline literal preserved; DeepSeek defaults; `DEEPSEEK_API_KEY` present (2×) and never an arg to `log(`. ✓
- Task 3: v2 round-trip all four actions; `Buffer.byteLength(...) < 64`; legacy v1 → null via `decodeProposalCallbackData`; v2 → null via v1 `decodeCallbackData`. ✓

## Known Stubs

None. All three primitives are fully implemented and tested; downstream Phase 23 plans (proposal-store, proposal-engine, mcp-client, index wiring) consume these contracts.

## Self-Check: PASSED

- FOUND: clients/telegram/types.ts (AllowlistEntry, McpServerConfig, StoredProposal, ProposalAction)
- FOUND: clients/telegram/config.ts (loadMcpConfig, loadActionConfig)
- FOUND: clients/telegram/push-codec.ts (encodeProposalCallbackData, decodeProposalCallbackData)
- FOUND: clients/telegram/tests/config-mcp.test.ts
- FOUND: commit d6d043e (Task 1)
- FOUND: commit c22cc94 (Task 2)
- FOUND: commit f01efe8 (Task 3)
