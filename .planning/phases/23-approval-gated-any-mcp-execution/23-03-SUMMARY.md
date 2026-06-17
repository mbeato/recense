---
phase: 23-approval-gated-any-mcp-execution
plan: 03
subsystem: clients/telegram
tags: [mcp, approval-gate, proposal-store, hitl, audit-episode, security]
dependency_graph:
  requires:
    - "clients/telegram/types.ts: StoredProposal (Plan 01)"
    - "clients/telegram/config.ts: ActionConfig.proposalStorePath (Plan 01)"
  provides:
    - "clients/telegram/proposal-store.ts: putProposal/getProposal/loadExecutable/tryReserveProposalSlot — immutable 0600 store"
    - "clients/telegram/memory-client.ts: hitlEpisode() — source:hitl audit episode writer"
  affects:
    - "Downstream plans (proposal-engine, index wiring) consume these two primitives"
tech_stack:
  added: []
  patterns:
    - "state.ts atomic 0600 tmp->rename pattern replicated exactly in proposal-store.ts"
    - "Deep-copy (JSON round-trip) on both put and get — immutable payload guarantee (D-07)"
    - "Cleanup-on-read: expired entries pruned from disk during getProposal/loadExecutable"
    - "TDD: RED commit -> GREEN commit per task"
key_files:
  created:
    - clients/telegram/proposal-store.ts
    - clients/telegram/tests/proposal-store.test.ts
    - clients/telegram/tests/memory-client-hitl.test.ts
  modified:
    - clients/telegram/memory-client.ts
decisions:
  - "loadExecutable is the expiry enforcement point; getProposal returns the raw entry (pre-cleanup snapshot) so callers can inspect expired proposals for audit purposes without executing them"
  - "tryReserveProposalSlot counts proposals GENERATED (called at DeepSeek-call time), not proposals sent — prevents cap bypass via repeat sends of the same proposal"
  - "hitlEpisode content omits the serve token, DeepSeek key, and MCP credentials — only the tool name, args, serverName, truncated result, and isError flag appear in the episode body (H-13)"
metrics:
  duration: ~20m
  completed: 2026-06-17
  tasks: 3
  files: 4
  commits: 5
---

# Phase 23 Plan 03: Proposal Store + HITL Episode Writer Summary

Immutable pending-proposal persistence with expiry and restart-surviving daily cap (D-07, H-05, H-15), plus the `source:'hitl'` audit-episode writer that records every approval-gate decision to `/v1/add` without leaking secrets (H-12, H-13, D-43).

## What Was Built

### Task 1 + 2 — `proposal-store.ts` (commits b6711c8 -> 6ad2663)

New module `clients/telegram/proposal-store.ts` exporting:

- **`putProposal(p, storePath)`** — stores the proposal as a deep-copy (JSON round-trip), replacing any existing entry with the same id. Atomic 0600 tmp->rename write (state.ts pattern, WR-01).
- **`getProposal(id, storePath)`** — reads the pre-cleanup snapshot for the given id (returns the entry even if expired, for audit inspection). Expired entries are pruned from the persisted store as a side-effect. Returns a deep-copy to prevent TOCTOU mutations (D-07). Returns `null` for unknown ids.
- **`isExpired(p, now)`** — dual-anchor expiry: `now > Date.parse(p.dueAt)` OR `now > Date.parse(p.createdAt) + p.maxTtlMs`.
- **`loadExecutable(id, storePath, now)`** — the execute-path enforcement point (H-05): returns `{status:'ok', proposal}` | `{status:'expired'}` | `{status:'missing'}`. On expired, prunes the entry from disk. Never re-queries the engine (D-07, grep-verified zero `v1/search` or `search(` tokens).
- **`removeProposal(id, storePath)`** — explicit removal (approve/execute path).
- **`tryReserveProposalSlot(dailyCap, storePath, now)`** — persisted daily-cap (H-15): counts proposals GENERATED (not sent), resets on local date rollover, survives restart via same 0600 file. Returns `false` at cap, `true` and increments otherwise.
- **`getCapState(storePath)`** — cap inspection for tests and monitoring.

**Store document format:** `{ proposals: StoredProposal[]; cap: { date: string; count: number } }` — single file, single write primitive.

**26 tests** covering: put/get round-trip, immutability isolation, expiry by dueAt, expiry by maxTtlMs, loadExecutable ok/expired/missing, 0600 file mode, cap enforcement to the limit, date rollover reset, and restart survival.

### Task 3 — `memory-client.ts` extension (commits 60aa7f1 -> eaae634)

Extended `MemoryClient` interface and `createMemoryClient` factory with:

- **`hitlEpisode(entry: HitlEpisodeEntry)`** — builds a `[hitl] decision=… | server=… | tool=… | args=… | isError=… | result=…` plain-text content string and POSTs `{ content, origin: 'hitl:{decision}' }` to `/v1/add` via the existing `postJson` path.
  - The serve Bearer token, DeepSeek API key, and MCP server credentials are **never** serialized into `content` (H-13/T-13-05).
  - This is an episodic-only write: the client has no `node.s`/`node.c` write path (D-43).
  - Result field is truncated at 200 chars to bound episode size.

**16 tests** covering: POST target /v1/add, origin matching `^hitl:` for all five decision types, content containing tool name and arg value, token exclusion from content, auth header round-trip, and non-2xx rejection.

## Threat Model Coverage

| Threat ID | Mitigation delivered |
|-----------|----------------------|
| T-23-03-A (TOCTOU) | Immutable stored `{tool,args}` (deep-copy on put+get); no engine re-query at execute; loadExecutable enforces expiry (D-07, H-05, H-06) |
| T-23-03-B (Approval fatigue) | Persisted daily cap counts generated proposals, resets daily, survives restart (H-15) |
| T-23-03-C (Secret disclosure) | hitlEpisode content construction never includes token, DeepSeek key, or MCP secrets (H-13) |
| T-23-03-D (Missing audit trail) | Every decision type (approve/edit/reject/snooze/execute) is writable via hitlEpisode (H-12) |
| T-23-03-E (D-43 violation) | Client has no node-write path; /v1/add is episodic-only (D-43) — sleep pass mediates |

## Verification

- `npm test -- --reporter=verbose proposal-store` -> 26/26 pass
- `npm test -- --reporter=verbose memory-client-hitl` -> 16/16 pass
- `npx tsc -p clients/telegram/tsconfig.json --noEmit` -> clean
- `grep -c 'v1/search|search(' clients/telegram/proposal-store.ts` -> 0
- Full telegram suite -> 135/135 pass

## Deviations from Plan

None — plan executed exactly as written. The verify commands in the PLAN specify `cd /Users/vtx/brain-memory` which runs from the main repo; tests were correctly run from the worktree directory where the new files exist.

## Known Stubs

None. Both primitives are fully implemented and tested. Downstream plans (proposal-engine, index wiring) consume these functions directly.

## Threat Flags

None. No new network endpoints, auth paths, or schema changes beyond what the plan specified.

## Self-Check: PASSED

- FOUND: clients/telegram/proposal-store.ts (putProposal, getProposal, loadExecutable, tryReserveProposalSlot, getCapState)
- FOUND: clients/telegram/tests/proposal-store.test.ts (26 tests)
- FOUND: clients/telegram/tests/memory-client-hitl.test.ts (16 tests)
- FOUND: clients/telegram/memory-client.ts (hitlEpisode, HitlEpisodeEntry)
- FOUND: commit b6711c8 (RED proposal-store tests)
- FOUND: commit 6ad2663 (GREEN proposal-store implementation)
- FOUND: commit 60aa7f1 (RED hitlEpisode tests)
- FOUND: commit eaae634 (GREEN hitlEpisode implementation)
- grep -c check: 0 matches for v1/search|search( in proposal-store.ts
- 26/26 proposal-store tests pass
- 16/16 memory-client-hitl tests pass
- TypeScript: clean
