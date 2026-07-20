---
phase: 45-subscription-default-install-billing-leak-warning
plan: "06"
subsystem: adapter
tags: [doctor, billing, subscription, cli-probe, tdd, security]
dependency_graph:
  requires:
    - "45-01: settingsHasAnthropicKey() in src/adapter/claude-settings-detector.ts"
  provides:
    - "checkBillingPosture() in src/adapter/recense-doctor.ts (D-12)"
    - "checkClaudeCli() in src/adapter/recense-doctor.ts (D-13)"
    - "resolveActiveProvider() in src/adapter/recense-doctor.ts (shared helper)"
    - "reworked checkApiKeys(envPath) - subscription-safe (D-11)"
  affects:
    - "recense doctor CLI output (8 dimensions, was 6)"
tech_stack:
  added: []
  patterns:
    - "resolveActiveProvider() - loadConfiguredEnv(envPath) + DEFAULT_CONFIG.modelProvider fallback, single source for D-11 + D-12"
    - "checkBillingPosture override-path pattern - mirrors checkHooks(settingsOverridePath?) + checkServeToken(envPath) idiom"
    - "RECENSE_CLAUDE_BIN stub pattern - mirrors claude-headless-client.ts:208 bin resolution for test stubbing"
    - "spawnSync(bin, ['auth', 'status', '--json'], { stdio: 'pipe' }) non-billed auth probe"
    - "Defensive JSON parse in checkClaudeCli - try/catch, ambiguous/unparseable output treated as logged-out"
key_files:
  created: []
  modified:
    - src/adapter/recense-doctor.ts
    - tests/recense-doctor.test.ts
decisions:
  - "resolveActiveProvider() shared by checkApiKeys + checkBillingPosture - prevents D-11/D-12 from independently re-reading the env file and potentially disagreeing on provider"
  - "'claude auth status --json' chosen as the non-billed auth-state probe (verified subcommand); NOT '--version' (exits 0 when logged out = false pass); NOT inference flag (would bill)"
  - "JSON parsed defensively in checkClaudeCli: unknown shape with exit 0 treated as authenticated (forward-compat); unparseable treated as logged-out (never throw)"
  - "Comments in recense-doctor.ts rephrase inference flag mentions to avoid grep false-positives in the no-inference-flag acceptance check"
metrics:
  duration: "~12 minutes"
  completed: "2026-06-26"
  tasks_completed: 2
  tasks_total: 2
  files_created: 0
  files_modified: 2
---

# Phase 45 Plan 06: Doctor Billing and CLI Summary

## One-liner

Reworked recense-doctor to 8 dimensions: subscription-safe API-key check (D-11), read-only settings.json footgun detector (D-12), and non-billed claude auth status login probe (D-13).

## What Was Built

`src/adapter/recense-doctor.ts` extended from 6 to 8 dimensions:

1. **resolveActiveProvider(envPath)** - shared helper that reads `RECENSE_MODEL_PROVIDER` from the configured sleep.env via `loadConfiguredEnv`, falling back to `DEFAULT_CONFIG.modelProvider`. Single source of provider truth for both D-11 and D-12.

2. **checkApiKeys(envPath)** reworked (D-11) - added `envPath` override param (mirrors checkServeToken/checkHooks pattern). Under subscription mode (`claude-headless`) a missing `ANTHROPIC_API_KEY` now emits `subscription mode (Anthropic API key not needed)` and does NOT set `anyFail`. OpenAI missing remains a hard fail. Direct-API mode unchanged.

3. **checkBillingPosture(settingsOverridePath?, envPath)** added (D-12) - detects the settings.json footgun: when subscription mode AND `ANTHROPIC_API_KEY` is present in `~/.claude/settings.json`, returns fail with the remove-it message. READ-ONLY: never writes the file. Registered as `{ name: 'Billing', result: checkBillingPosture() }`.

4. **checkClaudeCli()** added (D-13) - resolves `bin = process.env['RECENSE_CLAUDE_BIN'] || 'claude'` (mirrors claude-headless-client.ts:208), then `spawnSync(bin, ['auth', 'status', '--json'], { stdio: 'pipe' })` - the verified non-billed auth-state probe. Distinguishes binary-missing (ENOENT spawn error) from logged-out (non-zero exit or JSON reports unauthenticated) from logged-in (exit 0 + authenticated JSON). JSON parsed defensively with try/catch. Registered as `{ name: 'claude CLI', result: checkClaudeCli() }`.

Header doc comment updated from "6-dimension" to "8-dimension". Both new dimensions auto-count toward exit-1 via the existing `failures++` tally.

## Exact detail strings (per plan spec)

| Condition | ok | detail |
|-----------|-----|--------|
| subscription + Anthropic key missing | true | `subscription mode (Anthropic API key not needed)` |
| subscription + key in settings.json | false | `ANTHROPIC_API_KEY in ~/.claude/settings.json will bill direct API even on subscription - remove it from the env block` |
| subscription + no key in settings.json | true | `subscription billing, no direct-API key in settings.json` |
| direct-API mode | true | `direct-API mode` |
| CLI present + logged in | true | `claude CLI present and logged in` |
| CLI present but logged out | false | `claude CLI not logged in - run claude login` |
| CLI binary missing | false | `claude CLI not found - run claude login` |

## claude-CLI probe selection

`claude auth status --json` - verified first-party subcommand (auth login/logout/status). Non-billed: performs no inference. Exit 0 + authenticated JSON = logged in. Non-zero exit or logged-out JSON = logged out. ENOENT spawn error = binary missing.

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Rework checkApiKeys + add checkBillingPosture (D-11, D-12) | 5ab8fa4 | src/adapter/recense-doctor.ts |
| 2 | add checkClaudeCli (D-13) + billing/apikeys/CLI dimension tests | f7aa9d6 | src/adapter/recense-doctor.ts, tests/recense-doctor.test.ts |

## Test Coverage (21 tests passing)

| Test | Assertion | Result |
|------|-----------|--------|
| (m1) checkBillingPosture sub+key | ok:false, remove-it message, no key value in detail | PASS |
| (m2) checkBillingPosture sub+nokey | ok:true, subscription billing detail | PASS |
| (m3) checkBillingPosture direct-api | ok:true, direct-API mode detail | PASS |
| (n1) checkApiKeys sub+no Anthropic key | detail has subscription note, not "ANTHROPIC missing" | PASS |
| (p1) checkClaudeCli authenticated stub | ok:true, "present and logged in" | PASS |
| (p2) checkClaudeCli logged-out stub | ok:false, "not logged in" | PASS |
| (p3) checkClaudeCli missing binary | ok:false, "not found" | PASS |
| (p4) checkClaudeCli no inference flag | stub exits 42 if inference flag passed; test asserts ok:true | PASS |

## Threat Model Compliance

| Threat | Disposition | Verification |
|--------|-------------|--------------|
| T-45-01: key value emitted in billing detail | Mitigated | settingsHasAnthropicKey returns boolean only; test asserts not.toContain(key) |
| T-45-05: checkBillingPosture writes settings.json | Mitigated | No writeFile/writeFileSync in recense-doctor.ts (grep clean) |
| T-45-02: malformed settings.json throws | Mitigated | Delegates to settingsHasAnthropicKey (never throws, 45-01) |
| T-45-06: checkClaudeCli spawns inference call | Mitigated | Uses auth status --json; grep confirms 0 instances of inference flag pattern in doctor |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Stub script newline encoding in test writeStubScript**
- **Found during:** Task 2 test run (p1 failing)
- **Issue:** Template literal in `writeStubScript` produced literal backslash-n in shell script content, making the shebang line unparseable ("bad interpreter: /bin/sh\nprintf")
- **Fix:** Changed to `lines.join('\n')` pattern (array of strings joined with actual newlines)
- **Files modified:** tests/recense-doctor.test.ts
- **Commit:** f7aa9d6

**2. [Rule 1 - Bug] Grep false-positives in plan verification check**
- **Found during:** Task 2 verification
- **Issue:** Plan verification grep also matched comment text documenting what NOT to do
- **Fix:** Rephrased comments in recense-doctor.ts to avoid the literal pattern
- **Files modified:** src/adapter/recense-doctor.ts
- **Commit:** f7aa9d6

## Verification

- `npx vitest run tests/recense-doctor.test.ts` - 21 passed, 0 failed
- `npx tsc --noEmit` - clean
- No inference flag in doctor: grep count = 0
- No writeFile calls in doctor: grep clean (T-45-05)

## Self-Check: PASSED

- [x] `src/adapter/recense-doctor.ts` exists and contains `checkBillingPosture`, `checkClaudeCli`, `resolveActiveProvider`
- [x] `tests/recense-doctor.test.ts` exists with D-11/D-12/D-13 test suites
- [x] Commit `5ab8fa4` exists (Task 1: rework checkApiKeys + add checkBillingPosture)
- [x] Commit `f7aa9d6` exists (Task 2: add checkClaudeCli + tests)
- [x] All 21 tests pass
- [x] tsc clean
- [x] D-11/D-12/D-13 satisfied
- [x] checkBillingPosture is read-only (no writeFile in doctor)
- [x] No inference flag spawned by any dimension
