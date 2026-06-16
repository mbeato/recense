---
phase: 22-notify-only-proactive-push
plan: "01"
subsystem: clients/telegram
tags: [telegram, push, callback_query, inline-keyboards, codec, tdd, gate]
dependency_graph:
  requires: [21-04]  # D-43 sentinel (SURF-03) delivered in Phase 21 Plan 04
  provides: [transport-extension, push-codec]
  affects: [clients/telegram/transport.ts, clients/telegram/push-codec.ts]
tech_stack:
  added: []
  patterns: [tdd-red-green, interface-first, compact-encoding, strict-input-validation]
key_files:
  created:
    - clients/telegram/push-codec.ts
    - clients/telegram/tests/push-codec.test.ts
    - clients/telegram/tests/transport-extension.test.ts
  modified:
    - clients/telegram/transport.ts
decisions:
  - "D-43 sentinel gates plan entry; 7/7 sentinel tests green before any push code written"
  - "Pipe-delimited compact encoding 1|uuid|epochSec|code (~51 bytes) vs ISO-8601 overflow (71 bytes)"
  - "digits-only regex guard on epoch field prevents parseInt partial-parse of ISO date strings"
  - "replyMarkup omitted from MockTelegramTransport.sent entry when undefined (not set to undefined explicitly)"
metrics:
  duration: "4m"
  completed: "2026-06-16"
  tasks_completed: 3
  tasks_total: 3
  files_created: 3
  files_modified: 1
---

# Phase 22 Plan 01: Transport + Codec Foundation Summary

**One-liner:** Telegram transport extended with callback_query, inline-keyboard types, and `answerCallbackQuery`; push-codec encodes (node_id, due_at, outcome) in 51-byte pipe-delimited format, decodes with strict validation.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | D-43 self-confirmation sentinel hard gate | 4e3a69e | — (gate verification only) |
| 2 | Extend TelegramTransport (RED) | 8816e5c | clients/telegram/tests/transport-extension.test.ts |
| 2 | Extend TelegramTransport (GREEN) | be3173d | clients/telegram/transport.ts |
| 3 | push-codec.ts RED | dfe8e7f | clients/telegram/tests/push-codec.test.ts |
| 3 | push-codec.ts GREEN | ac1ef5e | clients/telegram/push-codec.ts |

## Verification Results

- `npx vitest run tests/surface-sentinel.test.ts`: 7/7 tests green (D-43 gate cleared)
- `npx vitest run clients/telegram/tests/`: 57/57 tests green (all 4 test files)
- `grep -n "import" clients/telegram/transport.ts clients/telegram/push-codec.ts`: no `src/` imports (CLIENT-01 satisfied)
- `encodeCallbackData(UUID_V4, dueAt, 'c').length`: 51 bytes (within 64-byte limit)

## What Was Built

**`clients/telegram/transport.ts`** (modified — 75 lines added, 7 changed):
- `CallbackQuery` interface: `{ id, from, data?, message? }`
- `InlineKeyboardButton` interface: `{ text, callback_data }`
- `InlineKeyboardMarkup` interface: `{ inline_keyboard: InlineKeyboardButton[][] }`
- `TelegramUpdate.callback_query?` field (alongside existing `message?`)
- `TelegramTransport` interface: `sendMessage` gains optional `replyMarkup?`, new `answerCallbackQuery`
- `DefaultTelegramTransport.sendMessage`: includes `reply_markup` in body only when provided
- `DefaultTelegramTransport.answerCallbackQuery`: POST `/answerCallbackQuery`, same 10s-timeout+throw pattern
- `MockTelegramTransport.sent[]`: entries carry optional `replyMarkup` for test assertions
- `MockTelegramTransport.answeredCallbacks[]`: records all `answerCallbackQuery` calls

**`clients/telegram/push-codec.ts`** (created — 102 lines):
- `encodeCallbackData(nodeId, dueAt, 'c'|'d'|'s')`: returns `1|{uuid}|{epochSec}|{code}` (~51 bytes)
- `decodeCallbackData(data)`: strict parse — version check, digits-only epoch, closed outcome map, returns null on any deviation
- A1 mitigation: `new Date(dueAt).toISOString()` at encode normalizes to `.000Z` form; decode reconstructs the same form — idempotency key round-trips exactly

**Test files** (created):
- `clients/telegram/tests/transport-extension.test.ts`: 13 tests covering new transport interface and mock behavior
- `clients/telegram/tests/push-codec.test.ts`: 23 tests covering 64-byte constraint, round-trip, outcome mapping, malformed-null cases

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] parseInt partially parses ISO-8601 date strings**
- **Found during:** Task 3 GREEN phase (push-codec implementation)
- **Issue:** `parseInt('2026-06-20T14:00:00.000Z', 10)` returns `2026` (partial parse) — `Number.isFinite(2026)` is true, so the validation passed when it should return null
- **Fix:** Added `/^\d+$/.test(epochStr)` guard before `parseInt` — rejects any epoch field containing non-digit characters
- **Files modified:** `clients/telegram/push-codec.ts`
- **Commit:** ac1ef5e (folded into GREEN commit)

## TDD Gate Compliance

Both TDD tasks followed the RED/GREEN cycle:

**Task 2 (transport extension):**
- RED: `8816e5c` — `test(22-01): add failing tests for transport extension` (8 tests failing)
- GREEN: `be3173d` — `feat(22-01): extend TelegramTransport...` (all 37 tests pass)

**Task 3 (push-codec):**
- RED: `dfe8e7f` — `test(22-01): add failing tests for push-codec...` (module-not-found, 0 tests run)
- GREEN: `ac1ef5e` — `feat(22-01): implement push-codec.ts...` (all 21 tests pass + 1 bug fix)

## Threat Surface Scan

No new network endpoints introduced. No new auth paths. Changes are client-only (zero `src/` imports). `decodeCallbackData` strict-validation mitigates T-22-02 (attacker-influenceable `callback_data` → null, caller skips surfaceSeen). Bot token stays in URL base per T-22-03. No threat flags beyond the plan's threat model.

## Known Stubs

None. Both `transport.ts` and `push-codec.ts` are fully wired implementations. Plan 02 and 03 will consume these contracts.

## Self-Check: PASSED

Files created/modified:
- `clients/telegram/transport.ts`: FOUND
- `clients/telegram/push-codec.ts`: FOUND
- `clients/telegram/tests/push-codec.test.ts`: FOUND
- `clients/telegram/tests/transport-extension.test.ts`: FOUND

Commits:
- 4e3a69e: FOUND (chore: D-43 gate)
- 8816e5c: FOUND (test: transport RED)
- be3173d: FOUND (feat: transport GREEN)
- dfe8e7f: FOUND (test: push-codec RED)
- ac1ef5e: FOUND (feat: push-codec GREEN)
