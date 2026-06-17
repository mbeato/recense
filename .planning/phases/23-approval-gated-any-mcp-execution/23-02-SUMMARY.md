---
phase: 23-approval-gated-any-mcp-execution
plan: 02
subsystem: clients/telegram
tags: [mcp, security, t-sec-02, act-02, act-03]
requires:
  - "clients/telegram/types.ts: McpServerConfig (Plan 01)"
  - "@modelcontextprotocol/sdk ^1.29.0 (already installed)"
provides:
  - "clients/telegram/mcp-client.ts: listServerTools / callServerTool / extractToolOutput + McpConnection seam"
  - "data-only tool-output extraction (text + isError) with no LLM re-feed path (T-SEC-02)"
affects:
  - "future proposal-engine.ts / index.ts wiring (consume listServerTools/callServerTool/extractToolOutput)"
tech-stack:
  added: []
  patterns:
    - "injectable connection factory seam (mirrors MockTelegramTransport) — no real subprocess in unit tests"
    - "close() in finally on every path (lazy connect-per-call lifecycle)"
key-files:
  created:
    - clients/telegram/mcp-client.ts
    - clients/telegram/tests/mcp-client.test.ts
  modified: []
decisions:
  - "Reuse McpServerConfig.env as StreamableHTTP request headers for the http transport (already env-interpolated by config.ts loadMcpConfig) — net-zero, keeps Authorization out of inline config (H-14)"
  - "Named the args param `toolArguments` (not `toolArgs`) so the SDK call uses the `arguments` key with zero `args:` token anywhere (Pitfall #1 + acceptance grep)"
  - "extractToolOutput tolerates a missing content array (legacy/empty SDK result branch) → empty text, isError false"
metrics:
  duration: ~25m (resumed after a transient 529 interruption)
  completed: 2026-06-16
  tasks: 2
  files: 2
  commits: 3
---

# Phase 23 Plan 02: MCP Client Wrapper Summary

A net-zero-dependency MCP client seam (`clients/telegram/mcp-client.ts`) that connects to a user-configured server over stdio or StreamableHTTP, lists tools, executes one tool by name with the SDK's `arguments` key, extracts the result as opaque text, and always closes the connection in a finally — encoding the v1.29.0 SDK gotchas and the T-SEC-02 data-only rule in one testable place.

## What Was Built

**Task 1 — wrapper (connect / listTools / callTool / close):** `ab53ad1`
- `listServerTools(cfg, factory?)` and `callServerTool(cfg, name, toolArguments, factory?)` over an injectable `McpConnection` factory seam. The default factory builds the real stdio (`command`+`args`+`env`+`stderr:'pipe'`) or `StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.env } })` transport behind the SDK `Client`.
- callTool invokes the SDK with the `arguments` key (Pitfall #1); `.js` import extensions matching `serve-cli.ts`/`mcp-cli.ts`.
- `close()` runs in `finally` on every path — even when `connect`/`listTools`/`callTool` throw (Pitfall #4, T-23-02-D — no leaked subprocess).
- Server hint annotations (`destructiveHint`/`readOnlyHint`) and the tool-list-change notification callback are never read/registered (D-08 / H-11 / T-23-02-B/C). 15s request-timeout bound (Risk 3).

**Task 2 — data-only extraction + isError (T-SEC-02):** RED `56182d2` → GREEN `d6d424c`
- `extractToolOutput(result) → { text, isError }`: keeps only `type:'text'` content (joined with `\n`); image/audio/resource dropped, never interpreted. `isError = result.isError === true` is a distinct failure signal that still preserves the text for the audit episode (Pitfall #2, T-23-02-E).
- `mcp-client.ts` imports no proposal-engine / DeepSeek / OpenAI module — tool output structurally cannot be re-fed to an LLM (T-SEC-02), guarded by a static-source test plus the existing CLIENT-01 import-boundary scan.
- `tests/mcp-client.test.ts`: 10 cases via a scripted `MockMcpConnection` (no real subprocess) — `arguments`-key capture, close-in-finally on call/connect throw, text-only extraction, image-drop, isError-preserve, empty-content, and the no-LLM-import guard.

## Verification

- `npm test -- --reporter=verbose mcp-client` → 10/10 green.
- `npx tsc -p clients/telegram/tsconfig.json --noEmit` → exit 0.
- Full client suite `vitest run clients/telegram` → 131/131 across 9 files (import-boundary guard included).
- Acceptance greps: `arguments:` ≥1 (=2); no `args:` token; `list_changed|destructiveHint|readOnlyHint` =0; `finally` ≥1 (=5); `.js` SDK imports =3.

## Deviations from Plan

### Auto-fixed / clarified

**1. [Rule 3 - Blocking] Worktree was pruned mid-execution after a transient 529.**
- **Found during:** startup, post-interruption resume.
- **Issue:** `git worktree list` showed no worktree; cwd resolved to the main repo on branch `main` at the expected base `c413f92`. Committing on `main` is prohibited by the protected-branch guard.
- **Fix:** Created the expected per-agent branch `worktree-agent-a0bb4ece2ad900611` from `c413f92` (non-destructive — `main` stays at `c413f92`) and did all work + commits there. No `git update-ref` / force-rewind used. The orchestrator can merge this branch.

**2. [Design] http transport headers sourced from `cfg.env`.**
- `McpServerConfig` has no dedicated http-header field; `config.ts` already `${ENV}`-interpolates `env` for any transport. Reused `cfg.env` as `requestInit.headers` so Authorization stays in env, never inline (H-14). Documented in the module.

No bugs found in the 23-01 foundation. No architectural changes required.

## Known Stubs

None. The wrapper is fully wired; consumers (proposal-engine / index) arrive in later plans.

## Self-Check: PASSED

- FOUND: clients/telegram/mcp-client.ts
- FOUND: clients/telegram/tests/mcp-client.test.ts
- FOUND commit ab53ad1 (feat: wrapper)
- FOUND commit 56182d2 (test: RED)
- FOUND commit d6d424c (feat: extractToolOutput GREEN)
