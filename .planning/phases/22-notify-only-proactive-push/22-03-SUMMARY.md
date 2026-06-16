---
phase: 22-notify-only-proactive-push
plan: "03"
subsystem: clients/telegram
tags: [proactive-push, push-timer, callback-query, launchd, tdd]
dependency_graph:
  requires: ["22-01", "22-02"]
  provides: ["runPushTick", "isInQuietHours", "callback_query-drain", "ThrottleInterval"]
  affects: ["clients/telegram/index.ts", "clients/telegram/types.ts"]
tech_stack:
  added: []
  patterns:
    - "Split push timer (D-01): separate setInterval for push vs reactive Q&A, single getUpdates consumer"
    - "isInQuietHours with midnight-crossing OR logic (start > end case)"
    - "D-02 send-then-mark: sendMessage before surfaceSeen (at-least-once)"
    - "D-06 never-empty-digest: zero P1 items at digest hour → send nothing"
    - "callback_query drain in runClientTick: log+continue per error, answerCallbackQuery unconditional"
    - "CollectedCallbackQuery in FetchResult (from fetchMessages to runClientTick)"
key_files:
  created:
    - clients/telegram/tests/push-timer.test.ts
    - clients/telegram/tests/callback-query.test.ts
  modified:
    - clients/telegram/index.ts
    - clients/telegram/types.ts
    - clients/telegram/tests/telegram-client.test.ts
    - scripts/com.recense.telegram-client.plist.template
decisions:
  - "Implemented Task 2 (callback_query draining) in same commit as Task 1 GREEN to avoid two partial edits to index.ts"
  - "Exported isInQuietHours for direct boundary testing (midnight-crossing)"
  - "CollectedCallbackQuery in types.ts to pass callback queries from fetchMessages to runClientTick without a second getUpdates call"
  - "sendSurfacedItem iterates allowlist per item (single-tenant: one entry); surfaceSeen called per-item not per-user for clarity"
metrics:
  duration: "9m"
  completed_date: "2026-06-16"
  tasks: 3
  files: 6
---

# Phase 22 Plan 03: Integration — Push Timer + Callback Query + launchd Guard

**One-liner:** Proactive push loop wired end-to-end: P0-immediate / P1-digest split timer, inline-keyboard buttons, callback_query drain with unconditional answerCallbackQuery, and ThrottleInterval=30 launchd crash-loop guard.

## What Was Built

### Task 1: runPushTick, isInQuietHours, send-then-mark, main() push timer

`clients/telegram/index.ts` now exports:

- **`isInQuietHours(hour, start, end): boolean`** — handles midnight-crossing (start > end → OR logic). Unit-tested at boundary values including 22→7 (hour 23 and 3 quiet, 12 not).
- **`runPushTick(config, transport, memoryClient): Promise<void>`** — the separate push timer (D-01). D-11 gate is its first statement. `pushInFlight` guard mirrors `tickInFlight`. P0 (tier=0) always sends (pierces quiet hours, D-05). P1 (tier=1) held to `digestHour` outside quiet hours with never-empty-digest (D-06/D-07). All pushes use send-then-mark (D-02): `sendMessage` before `surfaceSeen(outcome:'surfaced')`. Dedup is server-side via `surfaced_event` — no in-memory set (D-03).
- `buildButtonMarkup(item)` builds one row of Done/Dismiss/Snooze inline keyboard buttons using `encodeCallbackData` from `push-codec.ts` (A1 normalized `dueIso` via `new Date(item.due_at).toISOString()`). Each button's `callback_data` is ≤ 51 bytes.
- `sendSurfacedItem(transport, memoryClient, config, chatId, item)` — D-02 helper: `sendMessage` first, then `surfaceSeen`.
- `main()` starts a second `setInterval(() => runPushTick(...), config.pushPollMs)` guarded by `if (config.proactiveEnabled)` — separate from the reactive Q&A `setInterval` (D-01 split-timer).

`clients/telegram/types.ts` extended:
- `CollectedCallbackQuery { id, data, fromId }` — collected by `fetchMessages`, passed to `runClientTick` without a second `getUpdates` call.
- `FetchResult.callbackQueries: CollectedCallbackQuery[]` — alongside `messages` and `commitTo`.

### Task 2: callback_query draining in runClientTick

`fetchMessages` now collects `u.callback_query` items in the same update loop that processes messages. The `update_id` cursor already covers all update types — no cursor change.

`runClientTick` adds a drain loop after the message respond loop (before cursor commit):
- Builds `allow = new Set(config.allowlist)` for per-callback_query allowlist check.
- Unlisted sender → `log + answerCallbackQuery + continue` (T-22-01).
- Malformed/absent `callback_data` → `decodeCallbackData(cq.data ?? '')` returns null → `log + answerCallbackQuery + continue` (T-22-02).
- Valid decoded: computes `snooze_until = now + config.snoozeDurationMs` iff `outcome === 'snoozed'` (D-09), calls `surfaceSeen`, catches errors with `log + continue` (NOT D-04 — idempotent upsert).
- `answerCallbackQuery` is called unconditionally on every branch (Pitfall 1 — spinner clear).
- Cursor advance is never blocked by callback errors (unlike D-04 message errors).

### Task 3: launchd ThrottleInterval

`scripts/com.recense.telegram-client.plist.template` now contains `<key>ThrottleInterval</key><integer>30</integer>` between `RunAtLoad` and `StandardOutPath`. Caps launchd respawn rate to 1/30s (default 10s). No `RECENSE_NODE_BIN` ABI pin added (client has no native deps). `plutil -lint` reports OK.

**Deploy note:** Re-run `scripts/setup-telegram-client.sh` then `launchctl unload ~/.config/recense/... && launchctl load ...` to apply the ThrottleInterval to the running agent.

## Test Results

All 93 telegram client tests pass (`npx vitest run clients/telegram/tests/`):

| Test file | Tests |
|-----------|-------|
| push-timer.test.ts (new) | 14 |
| callback-query.test.ts (new) | 13 |
| telegram-client.test.ts | 30 |
| memory-client-surface.test.ts | 13 |
| push-codec.test.ts | 8 |
| transport-extension.test.ts | 8 |
| import-boundary.test.ts | 7 |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Existing telegram-client.test.ts missed proactive fields and inline transport stubs**
- **Found during:** Task 1 GREEN implementation
- **Issue:** `makeConfig` in `telegram-client.test.ts` returned an object missing the six proactive `ClientConfig` fields added by Plan 22-02. Two inline transport stubs (`pagedTransport`, `staleTransport`) were missing `answerCallbackQuery`. One assertion used `toEqual` on the full `FetchResult` object which would fail after `callbackQueries` was added.
- **Fix:** Added proactive field defaults to `makeConfig`, added `answerCallbackQuery` stubs, changed `toEqual` to `toMatchObject`.
- **Files modified:** `clients/telegram/tests/telegram-client.test.ts`
- **Commit:** `5b855a7`

**2. [Procedural] Task 2 callback_query implementation included in Task 1 GREEN commit**
- **What happened:** Both Task 1 (runPushTick) and Task 2 (callback_query drain) modify `index.ts`. Rather than make two passes over the same file, both were implemented in the same GREEN commit. Task 2's test file was then written after the implementation was already in place (skipping the TDD RED phase for Task 2).
- **Impact:** Zero — all tests pass, implementation is correct and complete. The deviation is procedural (TDD gate order) not functional.
- **Test coverage:** `callback-query.test.ts` covers all 13 required scenarios including the 404-cursor-advance check and snoozed snooze_until timing.

## Threat Model Coverage

All T-22 mitigations from the plan's `<threat_model>` are implemented:

| Threat ID | Implementation |
|-----------|---------------|
| T-22-01 Tampering (callback_query allowlist) | `allow.has(fromId)` check before `surfaceSeen` in drain loop |
| T-22-02 Tampering (decodeCallbackData) | `decodeCallbackData` returns null on malformed data; only closed enum outcomes POSTed |
| T-22-03 Information Disclosure | File-only `log()`; push text is `[action_type] value\nDue: due_at` (plain data) |
| T-22-04 DoS (callback error + push volume) | Per-item catch+continue, cursor never blocked on callback error; P1 bounded by engine cap |
| T-22-07 Faithfulness D-43 | Push loop only GETs /v1/surface and POSTs /v1/surface/seen; never writes node.s/node.c |
| T-22-DoS-launchd | ThrottleInterval=30 in plist template |

## Known Stubs

None — all push paths are wired to real mock server endpoints in tests. The `renderText` function produces real item data from `item.action_type`, `item.value`, and `item.due_at`.

## Self-Check: PASSED
