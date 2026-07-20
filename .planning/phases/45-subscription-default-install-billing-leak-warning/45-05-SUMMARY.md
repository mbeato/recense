---
phase: 45-subscription-default-install-billing-leak-warning
plan: "05"
subsystem: adapter
tags: [init, wizard, subscription, billing, provider-step, acknowledge-gate, tdd]
dependency_graph:
  requires:
    - "settingsHasAnthropicKey() from src/adapter/claude-settings-detector.ts (45-01)"
  provides:
    - "parseProviderChoice() in src/adapter/recense-init.ts"
    - "shouldBlockOnLeak() in src/adapter/recense-init.ts"
    - "provider/billing step in recense init wizard (D-04)"
    - "subscription path: skips Anthropic key, writes RECENSE_MODEL_PROVIDER=claude-headless (D-05/D-06)"
    - "acknowledge gate on subscription path when settings.json key detected (D-07)"
  affects:
    - "45-06 (recense-doctor billing dimension D-12 -- init half complete)"
tech_stack:
  added: []
  patterns:
    - "ask() readline idiom with bracket-default -- Subscription pre-selected via '[1]' default"
    - "parseProviderChoice() pure exported helper -- empty/1/s -> subscription, 2/d -> direct-api, 3/l -> local"
    - "shouldBlockOnLeak() delegates to settingsHasAnthropicKey (presence-only, never throws)"
    - "vars['RECENSE_MODEL_PROVIDER'] = 'claude-headless' set via writeEnvFile on subscription path"
    - "delete vars['ANTHROPIC_API_KEY'] on subscription path to prevent re-write of stale key"
    - "sleepEnvPath() from runtime-config.ts used instead of inlined join"
key_files:
  created: []
  modified:
    - src/adapter/recense-init.ts
    - tests/recense-init.test.ts
decisions:
  - "shouldBlockOnLeak() delegates entirely to settingsHasAnthropicKey rather than re-implementing the read -- single reader, two consumers (D-14 pattern)"
  - "Gate fires ONLY on subscription path -- direct-api and local paths bypass it"
  - "hookSettingsPath rename to avoid shadowing settingsPath local in the acknowledge gate block"
  - "delete vars['ANTHROPIC_API_KEY'] on subscription path so writeEnvFile does not re-write a prior-run key"
  - "Warning copy names the ~/.claude/settings.json env block specifically and instructs removal -- no claim that recense handles it"
metrics:
  duration: "~3 minutes"
  completed: "2026-06-26"
  tasks_completed: 2
  tasks_total: 2
  files_created: 0
  files_modified: 2
---

# Phase 45 Plan 05: Init Subscription Path Summary

## One-liner

Provider/billing step added to recense init wizard with Subscription pre-selected (D-04), skipping Anthropic key prompt and writing RECENSE_MODEL_PROVIDER=claude-headless (D-05/06), plus an acknowledge gate that warns on detected settings.json footgun key without editing the file (D-07).

## What Was Built

`src/adapter/recense-init.ts` restructured around the subscription-default install (D-04..D-10):

1. **Provider step** (before Anthropic key prompt): a plain `ask()` readline prompt offering three billing modes with Subscription pre-selected as `[1]`. Uses the bracket-default idiom already established in the wizard.

2. **Exported `parseProviderChoice(raw: string)`**: pure helper mapping raw input to `'subscription' | 'direct-api' | 'local'`. Empty/1/s/subscription -> subscription (safe default for any unrecognized input too).

3. **Subscription path branching**: `promptAndValidateKey(anthropic)` is entirely skipped (D-05); `vars['RECENSE_MODEL_PROVIDER'] = 'claude-headless'` is set and any prior `ANTHROPIC_API_KEY` is deleted from vars before writeEnvFile (D-06, T-45-07).

4. **Exported `shouldBlockOnLeak(settingsPath?)`**: pure gate helper that delegates to `settingsHasAnthropicKey()` from 45-01. Returns true iff the footgun key is detected; never throws; never reads the key value (T-45-01/T-45-02).

5. **Acknowledge gate** (subscription path only): if `shouldBlockOnLeak()` returns true, prints a billing warning naming the `~/.claude/settings.json` env-block footgun and instructs the user to remove `ANTHROPIC_API_KEY` from that block. Requires `y` to continue; `process.exit(1)` otherwise. Zero file edits (T-45-05).

6. **OpenAI key prompt**: unchanged, runs on all paths (D-10 -- embeddings; subscription covers Anthropic only).

## Exported API

```typescript
// Provider choice parser -- testable pure helper (D-04)
export function parseProviderChoice(raw: string): 'subscription' | 'direct-api' | 'local';

// Acknowledge gate -- delegates to settingsHasAnthropicKey (D-07)
export function shouldBlockOnLeak(
  settingsPath?: string  // defaults to ~/.claude/settings.json
): boolean;
```

## Warning Copy Used

```
WARNING: ANTHROPIC_API_KEY found in ~/.claude/settings.json (env block).
Claude Code injects this key into every process it runs, including the
recense sleep pass. That key will cause direct-API billing even though
recense is configured to use your subscription (claude -p).
To stop the billing leak, remove ANTHROPIC_API_KEY from the `env` block
in ~/.claude/settings.json. recense will NOT edit that file.

Continue anyway? [y/N]:
```

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Provider step + subscription path + sleep.env write | a3a3b67 | src/adapter/recense-init.ts |
| 2 | parseProviderChoice + shouldBlockOnLeak tests | f45896a | tests/recense-init.test.ts |

## Threat Model Compliance

| Threat | Disposition | Verification |
|--------|-------------|--------------|
| T-45-01: Information Disclosure (key value in warning) | Mitigated | Warning calls settingsHasAnthropicKey (boolean only); key value never crosses function boundary or console output |
| T-45-05: Tampering -- gate writes settings.json | Mitigated | Gate is read-only; writeFileSync/mergeSettingsHooks absent from gate block; acceptance check clean |
| T-45-02: DoS via malformed settings.json at gate | Mitigated | shouldBlockOnLeak delegates to settingsHasAnthropicKey (45-01) which never throws; malformed-JSON test passes |
| T-45-07: ANTHROPIC_API_KEY leaked into sleep.env on subscription path | Mitigated | delete vars['ANTHROPIC_API_KEY'] before writeEnvFile on subscription branch |

## Tests (48 total -- was 39 before this plan)

| Suite | Cases | Coverage |
|-------|-------|----------|
| `parseProviderChoice` | 14 | empty, 1/s/subscription, 2/d/direct/direct-api, 3/l/local, unrecognized, whitespace |
| `shouldBlockOnLeak` | 6 | key-present, key-absent, no-env-block, empty-string, missing-file, malformed-JSON |

All 48 tests pass.

## Verification

- `npx vitest run tests/recense-init.test.ts` -- 48 passed, 0 failed
- `npx tsc --noEmit` -- clean
- `grep -nE "RECENSE_MODEL_PROVIDER.*claude-headless"` in recense-init.ts -- 3 matches
- Gate code: zero writeFileSync/mergeSettingsHooks calls in the acknowledge gate block
- No "no keys needed" copy in wizard text

## Deviations from Plan

None -- plan executed exactly as written. D-04..D-10 all satisfied.

## Self-Check: PASSED

- [x] src/adapter/recense-init.ts modified with provider step + exported helpers
- [x] tests/recense-init.test.ts updated with 20 new tests (48 total)
- [x] Commit a3a3b67 exists (Task 1)
- [x] Commit f45896a exists (Task 2)
- [x] All 48 tests pass
- [x] tsc clean
- [x] D-04..D-10 satisfied
- [x] T-45-01/T-45-02/T-45-05/T-45-07 mitigated
