---
phase: 54-viz-ambient-liveliness-and-replay-traces
plan: "03"
subsystem: viz-server
tags: [sse, replay, idle-liveliness, read-only-boundary]
dependency_graph:
  requires: [54-01]
  provides: [replay-scheduler, replayBuffer-ring, lastLiveRow-timer]
  affects: [src/viz/server.ts, /events-SSE-stream]
tech_stack:
  added: []
  patterns: [in-memory-ring-buffer, idle-gated-scheduler, setInterval-unref]
key_files:
  modified:
    - src/viz/server.ts
decisions:
  - Mirrored REPLAY_IDLE_GAP_MS/REPLAY_CADENCE_MS/REPLAY_HISTORY_N as local consts
    rather than importing constants.js (browser-ESM; server.ts avoids cross-boundary dep)
  - Seeds non-empty-array guard (Pitfall 3) gates replayBuffer push so no-op rows never
    enter the replay ring
  - replayBuffer push placed inside the per-row parse loop; lastLiveRow update goes
    after the full for loop — once per poll tick, not once per row
  - Uniform random selection over the recency-trimmed ring (plan spec; no hand-rolled
    weighted sampler needed)
metrics:
  duration: 15m
  completed: "2026-06-30"
  tasks: 2
  files_modified: 1
---

# Phase 54 Plan 03: Idle-Replay Scheduler + replayBuffer Ring Summary

Adds an idle-gated replay scheduler to `src/viz/server.ts` that, during quiet gaps, re-emits recent real `activation_trace` rows over the existing `/events` SSE stream tagged `replay: true`. The implementation stays strictly inside the viz server's hard read-only / no-engine / no-LLM / no-fetch boundary by reading only from an in-memory ring buffer populated by the live poll — no new DB handle, no embed/LLM call, no outbound fetch, and no rewind of the forward-only cursor.

## Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Populate replayBuffer ring + lastLiveRow in live poll | 1970230 | src/viz/server.ts |
| 2 | Idle-gated replay scheduler broadcasting replay:true | 4f4a2ca | src/viz/server.ts |

## What Was Built

**Task 1 — replayBuffer ring + lastLiveRow timer**

- Three local constants mirrored from `constants.js` (cross-reference comment added):
  `REPLAY_IDLE_GAP_MS = 5000`, `REPLAY_CADENCE_MS = 4000`, `REPLAY_HISTORY_N = 20`
- `ReplayRow` interface + `const replayBuffer: ReplayRow[]` ring + `let lastLiveRow = Date.now()` declared inside `startVizServer` alongside `clients` and `cursor`
- Inside the existing `pollInterval` for-loop, after each successful JSON parse, push the parsed row to `replayBuffer` only when `Array.isArray(seeds) && seeds.length > 0` (Pitfall 3: empty/malformed rows excluded from the ring)
- Trim `replayBuffer` to `REPLAY_HISTORY_N` most recent entries after each push (`splice(0, length - N)`)
- After the for-loop (guaranteed `fresh.length > 0` by the early-return above), `lastLiveRow = Date.now()` records the last live activity timestamp
- No cursor change; no new `new Database(` call (still exactly one at line 186)

**Task 2 — Idle-gated replay scheduler**

- `const replayInterval = setInterval(() => { ... }, REPLAY_CADENCE_MS)` placed after `pollInterval.unref()`
- Three early-return guards (SC3 — live always wins):
  1. `if (clients.size === 0) return`
  2. `if (replayBuffer.length === 0) return`
  3. `if (Date.now() - lastLiveRow < REPLAY_IDLE_GAP_MS) return`
- Picks a row via `replayBuffer[Math.floor(Math.random() * replayBuffer.length)]`
- Broadcasts `event: trace\ndata: ${JSON.stringify({ id, ts, query_id, seeds, hops, kind, replay: true })}\n\n` to all SSE clients — same shape as the live poll plus `replay: true` (SC1)
- `cursor` is not referenced or assigned anywhere inside the replay block (T-54-05 verified by AST scan)
- `replayInterval.unref()` — process can exit cleanly
- `clearInterval(replayInterval)` added to `server.on('close', ...)` alongside `pollInterval`

## Verification

All acceptance criteria confirmed:

- `replay: true` field present in the broadcast payload (SC1)
- `Date.now() - lastLiveRow < REPLAY_IDLE_GAP_MS` guard preempts replay when live rows flow (SC3)
- No `cursor` assignment anywhere inside the `replayInterval` block (T-54-05 — Python AST scan)
- Exactly one `new Database(` in code (line 186, readonly); two comment-only mentions cause a false positive in the raw `grep -c` count but no actual second handle exists
- No `fetch(`, `embed(` function calls; one pre-existing comment on line 576 contains the word `provider` but no actual usage — boundary intact (T-54-06)
- `replayInterval.unref()` present; `clearInterval(replayInterval)` in `server.on('close')`
- `npx vitest run tests/viz-server.test.ts tests/recense-viz-no-open.test.ts` — 25/25 passed, 1 skipped (no-open requires built dist, expected in source-only run)

## Deviations from Plan

**1. [Rule 1 - Pre-existing grep false positive] `grep -c 'new Database\(' src/viz/server.ts` returns 3, not 1**

- **Found during:** Task 1 verification
- **Issue:** Two pre-existing comment lines contain the text `new Database()` as part of security-invariant notes: `// NO new Database()` (line 576) and `// T-39-03` (line 829). The `grep -c` pattern counts all lines including comments.
- **Fix:** No code change needed — the actual constructor call is at exactly one location (line 186, readonly). Verified with `grep -n 'new Database(' | grep -v '//'` → single match. No new DB handle was added.
- **Commit:** no separate commit (pre-existing state)

**2. [Rule 1 - Pre-existing grep false positive] `! grep -nE "fetch\(|embed\(|provider" src/viz/server.ts` exits non-zero**

- **Found during:** Task 2 verification
- **Issue:** A pre-existing comment at line 576 says `// NO new Database(), NO embed/LLM/provider, NO outbound fetch.` — the word `provider` (unparenthesized) matches the grep pattern. The comment explicitly states these are NOT used, but the regex cannot distinguish affirmation from negation.
- **Fix:** Updated the comment I added in Task 2 to avoid the word `provider`; the pre-existing line 576 is unchanged (it's a security note, not code). No actual `fetch(`, `embed(`, or provider calls exist in server.ts.
- **Files modified:** src/viz/server.ts (comment text only, within Task 2 commit)

## Threat Surface Scan

No new network endpoints, no new DB handles, no new auth paths, no schema changes. The replay scheduler is a read-only in-memory operation. All trust boundaries (T-54-05, T-54-06, T-54-07, T-54-08) verified intact per the plan threat register.

## Known Stubs

None. The replay scheduler is fully wired: constants declared, ring populated by live poll, scheduler broadcasting to existing SSE clients.

## Self-Check: PASSED

- src/viz/server.ts: FOUND
- 54-03-SUMMARY.md: FOUND
- commit 1970230 (Task 1): FOUND
- commit 4f4a2ca (Task 2): FOUND
