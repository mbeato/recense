---
phase: 45-subscription-default-install-billing-leak-warning
plan: "01"
subsystem: adapter
tags: [settings, detector, security, tdd]
dependency_graph:
  requires: []
  provides:
    - "settingsHasAnthropicKey() in src/adapter/claude-settings-detector.ts"
  affects:
    - "Wave 2: 45-05 (recense-init acknowledge gate D-07)"
    - "Wave 2: 45-06 (recense-doctor billing dimension D-12)"
tech_stack:
  added: []
  patterns:
    - "existsSync guard + try/catch JSON.parse -- mirrors settings-loader.ts loadSettingsFile exactly"
    - "level-by-level narrowing (parsed -> .env -> .ANTHROPIC_API_KEY -> non-empty string)"
    - "presence-only boolean return -- key value never crosses the function boundary"
key_files:
  created:
    - src/adapter/claude-settings-detector.ts
    - tests/claude-settings-detector.test.ts
  modified: []
decisions:
  - "Separate default path function (defaultClaudeSettingsPath) keeps the export signature clean and enables testing via path override -- same pattern as settings-loader.ts defaultSettingsPath"
  - "Level-by-level narrowing chosen over type guard -- simpler for a single field read; avoids importing/duplicating SettingsFile shape from config.ts"
metrics:
  duration: "~2 minutes"
  completed: "2026-06-26"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 0
---

# Phase 45 Plan 01: Settings Key Detector Summary

## One-liner

Presence-only boolean reader for `~/.claude/settings.json` `env.ANTHROPIC_API_KEY` using existsSync guard + try/catch level-by-level narrowing, never-throws on four inputs.

## What Was Built

`src/adapter/claude-settings-detector.ts` exports `settingsHasAnthropicKey(settingsPath?)` -- a single reader that answers "is ANTHROPIC_API_KEY set and non-empty in the Claude Code settings file?" for two planned Wave 2 consumers (recense-init D-07 gate, recense-doctor D-12 dimension).

## Exported API

```typescript
// Import path for Wave 2 consumers
import { settingsHasAnthropicKey } from './claude-settings-detector';

// Signature
export function settingsHasAnthropicKey(
  settingsPath: string = join(homedir(), '.claude', 'settings.json'),
): boolean
```

**Default path:** `~/.claude/settings.json` (Claude Code's own settings -- NOT `~/.config/recense/settings.json`)

**Return:** `true` if `settings.env.ANTHROPIC_API_KEY` is a non-empty string; `false` for all other cases (key absent, empty string, no env block, missing file, malformed JSON).

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Write four-outcome detector tests (RED) | 0d0bc9d | tests/claude-settings-detector.test.ts |
| 2 | Implement settingsHasAnthropicKey detector (GREEN) | 83e9677 | src/adapter/claude-settings-detector.ts |

## Threat Model Compliance

| Threat | Disposition | Verification |
|--------|-------------|--------------|
| T-45-01: Information Disclosure (key value emitted) | Mitigated | Function returns boolean only; no console/log/return of key value; grep clean |
| T-45-02: DoS via adversarial malformed JSON | Mitigated | existsSync guard + try/catch; malformed-JSON test asserts not.toThrow() + returns false |

## Contract Tests (6/6 passing)

| Case | Input | Expected | Result |
|------|-------|----------|--------|
| (a) key-present | `{"env":{"ANTHROPIC_API_KEY":"sk-ant-api03-xxx"}}` | true | PASS |
| (b) key-absent | `{"env":{"OTHER_KEY":"value"}}` | false | PASS |
| (b2) no env block | `{"hooks":{}}` | false | PASS |
| (c) empty-string | `{"env":{"ANTHROPIC_API_KEY":""}}` | false | PASS |
| (d) missing-file | non-existent path | false, no throw | PASS |
| (e) malformed-JSON | `{not valid json` | false, no throw | PASS |

## Verification

- `npx vitest run tests/claude-settings-detector.test.ts` -- 6 passed, 0 failed
- `npx tsc --noEmit` -- clean (no new type errors)
- Presence-only grep -- no console./process.stdout/process.stderr in implementation code

## Deviations from Plan

None -- plan executed exactly as written. TDD RED/GREEN cycle followed: RED commit `0d0bc9d`, GREEN commit `83e9677`.

## Self-Check: PASSED

- [x] `tests/claude-settings-detector.test.ts` exists
- [x] `src/adapter/claude-settings-detector.ts` exists
- [x] Commit `0d0bc9d` exists (RED)
- [x] Commit `83e9677` exists (GREEN)
- [x] All 6 tests pass
- [x] tsc clean
- [x] D-14 satisfied: one exported reader, four outcomes correct, never throws, presence-only
