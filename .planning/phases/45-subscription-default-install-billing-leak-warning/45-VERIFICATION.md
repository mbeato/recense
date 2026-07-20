---
phase: 45-subscription-default-install-billing-leak-warning
verified: 2026-06-26T16:18:00Z
status: passed
score: 10/10
overrides_applied: 0
---

# Phase 45: Subscription Default Install + Billing Leak Warning — Verification Report

**Phase Goal:** Make `claude -p` Max-subscription billing the DEFAULT for the sleep-pass and simplify the install flow around it, while surfacing the real direct-API billing footgun (warn-only) instead of a false safety guarantee.
**Verified:** 2026-06-26T16:18:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #  | Truth | Status | Evidence |
|----|-------|--------|----------|
| 1  | `DEFAULT_CONFIG.modelProvider === 'claude-headless'` — subscription billing is the in-code default | VERIFIED | `src/lib/config.ts:758`: `modelProvider: 'claude-headless'` |
| 2  | `settingsHasAnthropicKey` is presence-only, never throws, default path `~/.claude/settings.json` | VERIFIED | `src/adapter/claude-settings-detector.ts:41-67`: existsSync guard + try/catch; returns boolean only; all five contract tests pass (6/6 green) |
| 3  | `recense NEVER edits ~/.claude/settings.json` in the gate or doctor path — only the hooks step writes there | VERIFIED | `shouldBlockOnLeak`/`checkBillingPosture` contain no `writeFileSync` calls; `mergeSettingsHooks` writes only the `hooks` section, never the `env` block |
| 4  | Subscription path skips the Anthropic-key prompt, writes `RECENSE_MODEL_PROVIDER=claude-headless`, does NOT leave `ANTHROPIC_API_KEY` in sleep.env (T-45-07) | VERIFIED | `recense-init.ts:464-473`: Anthropic prompt inside `if (provider === 'direct-api')` only; lines 521-529: `vars['RECENSE_MODEL_PROVIDER']='claude-headless'`; `delete vars['ANTHROPIC_API_KEY']` + `removeKeys.push('ANTHROPIC_API_KEY')` passed to `writeEnvFile`; `writeEnvFile` actively drops removeKeys lines (lines 126-135) |
| 5  | When `ANTHROPIC_API_KEY` present in `~/.claude/settings.json`, init blocks on acknowledgement and `recense never edits that file` | VERIFIED | `recense-init.ts:480-496`: `if (provider === 'subscription') { if (shouldBlockOnLeak(settingsPath)) { ... ask for y/yes; process.exit(1) if not affirmed } }` — no write to settings.json in gate block; gate accepts `'y'` and `'yes'` (line 491) |
| 6  | `recense doctor` flags `ANTHROPIC_API_KEY` in `~/.claude/settings.json` as a failing dimension under subscription mode | VERIFIED | `recense-doctor.ts:363-386`: `checkBillingPosture` — returns `fail(...)` with exact message `'ANTHROPIC_API_KEY in ~/.claude/settings.json will bill direct API even on subscription — remove it from the env block'` when `isSubscription && keyPresent`; registered at line 478 |
| 7  | `recense doctor` does NOT report a missing Anthropic key as a failure under subscription mode | VERIFIED | `recense-doctor.ts:124-127`: `if (!anthropicKey) { if (isSubscription) { results.push('subscription mode (Anthropic API key not needed)'); } else { ... anyFail = true; } }` — missing key under subscription is a pass note only |
| 8  | `recense doctor` verifies the `claude` CLI is present AND logged in via a non-billed `auth status` probe (NEVER `claude -p`, NEVER `--version` only) | VERIFIED | `recense-doctor.ts:420`: `spawnSync(bin, ['auth', 'status', '--json'], { stdio: 'pipe', timeout: 5000 })` — non-billed auth-state probe; no `-p` flag; registered at line 479; stub test (p4) asserts args are not `-p` |
| 9  | `resolveActiveProvider` is the single shared source of provider truth for both `checkApiKeys` and `checkBillingPosture` | VERIFIED | `recense-doctor.ts:66-69`: `resolveActiveProvider` uses `loadConfiguredEnv(envPath)` + `DEFAULT_CONFIG.modelProvider` fallback; consumed at line 116 (`checkApiKeys`) and line 367 (`checkBillingPosture`) |
| 10 | 45-04-FINDING.md records D-17 empirical result: leak does NOT fire under `--setting-sources project` | VERIFIED | `45-04-FINDING.md`: two-condition reproduction (CONTROL: 401 with user settings; TREATMENT: no 401 with `--setting-sources project`); conclusion recorded; warn-only design rationale documented |

**Score:** 10/10 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/adapter/claude-settings-detector.ts` | `settingsHasAnthropicKey()` — single presence-only reader, 4 outcomes, never throws | VERIFIED | 67-line implementation; exports `settingsHasAnthropicKey(settingsPath?: string): boolean`; existsSync + try/catch guards all 4 inputs |
| `tests/claude-settings-detector.test.ts` | 5-outcome contract tests (present/absent/empty-string/missing-file/malformed) | VERIFIED | 6 tests all passing; covers all 5 cases; no test asserts key value |
| `src/lib/config.ts` | `DEFAULT_CONFIG.modelProvider = 'claude-headless'`; updated comment | VERIFIED | Line 758: `modelProvider: 'claude-headless'`; lines 131-134: truthful subscription-default comment; stale "ZERO behavior change" and "opt-in via env ONLY" phrases absent |
| `tests/sleep-pass-provider.test.ts` | Reconciled assertions for new default | VERIFIED | Line 21: asserts `'claude-headless'` (not `'anthropic'`); 22/22 tests passing |
| `src/adapter/recense-init.ts` | Provider step + subscription path + acknowledge gate + exported helpers | VERIFIED | `parseProviderChoice` (line 287), `shouldBlockOnLeak` (line 306) exported; subscription path writes `RECENSE_MODEL_PROVIDER=claude-headless`, actively removes `ANTHROPIC_API_KEY` via `removeKeys`; gate warns + requires y/yes; no settings.json edit |
| `tests/recense-init.test.ts` | Tests for provider-step, gate, subscription path | VERIFIED | 49/49 tests passing; `parseProviderChoice` tested (9 cases); `shouldBlockOnLeak` tested (5 cases including malformed-file + no-throw) |
| `src/adapter/recense-doctor.ts` | `checkBillingPosture` + `checkClaudeCli` + reworked `checkApiKeys`, registered in dimensions[] | VERIFIED | 8-dimension audit (header line 2); `checkBillingPosture` at line 363, `checkClaudeCli` at line 413, `checkApiKeys` reworked at line 115; all registered at lines 473-479 |
| `tests/recense-doctor.test.ts` | Billing, apikeys no-false-failure, claude-CLI tests | VERIFIED | 21/21 tests passing; covers sub+key→fail, sub+nokey→pass, no-false-failure, CLI-missing/logged-out/authenticated stubs, -p absence assertion |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `recense-init.ts (acknowledge gate)` | `claude-settings-detector.ts settingsHasAnthropicKey` | `import + shouldBlockOnLeak call on subscription path` | WIRED | Line 62: `import { settingsHasAnthropicKey } from './claude-settings-detector'`; line 309: `return settingsHasAnthropicKey(settingsPath)` |
| `recense-init.ts (subscription path)` | `~/.config/recense/sleep.env` | `vars['RECENSE_MODEL_PROVIDER'] = 'claude-headless' → writeEnvFile` | WIRED | Lines 524, 540: `vars['RECENSE_MODEL_PROVIDER']='claude-headless'`; `writeEnvFile(envPath, vars, removeKeys)` |
| `recense-doctor.ts checkBillingPosture` | `claude-settings-detector.ts settingsHasAnthropicKey` | `import + call after resolveActiveProvider` | WIRED | Line 45: `import { settingsHasAnthropicKey } from './claude-settings-detector'`; line 371: `settingsHasAnthropicKey(settingsOverridePath)` |
| `recense-doctor.ts checkClaudeCli` | `claude CLI (non-billed probe)` | `spawnSync(RECENSE_CLAUDE_BIN, ['auth', 'status', '--json'])` | WIRED | Line 415: `const bin = process.env['RECENSE_CLAUDE_BIN'] || 'claude'`; line 420: `spawnSync(bin, ['auth', 'status', '--json'], { stdio: 'pipe', timeout: 5000 })` |
| `recense-doctor.ts resolveActiveProvider` | `DEFAULT_CONFIG.modelProvider` (fallback) | `loadConfiguredEnv(envPath) + DEFAULT_CONFIG.modelProvider` | WIRED | Lines 67-68: reads `RECENSE_MODEL_PROVIDER` from env file; fallback is `DEFAULT_CONFIG.modelProvider` which is `'claude-headless'` |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Detector never throws on malformed JSON | `npx vitest run tests/claude-settings-detector.test.ts` | 6/6 pass | PASS |
| `DEFAULT_CONFIG.modelProvider` is `'claude-headless'` | `grep 'modelProvider:' src/lib/config.ts` (DEFAULT_CONFIG line) | `modelProvider: 'claude-headless'` at line 758 | PASS |
| All phase-modified test suites pass | `npx vitest run tests/claude-settings-detector.test.ts tests/sleep-pass-provider.test.ts tests/recense-init.test.ts tests/recense-doctor.test.ts` | All pass: 6+22+49+21 = 98 tests | PASS |
| TypeScript clean | `npx tsc --noEmit` | No errors | PASS |

### Code Review Findings (post-review state)

The 45-REVIEW.md identified 2 Critical + 3 Warning findings. All 5 were verified as fixed in the current codebase:

| Finding | Description | Fixed? | Evidence |
|---------|-------------|--------|---------|
| CR-01 | `ANTHROPIC_API_KEY` not removed from env on subscription re-run | FIXED | `writeEnvFile` now accepts `removeKeys` param (line 118); subscription path passes `['ANTHROPIC_API_KEY']` (line 529) |
| CR-02 | `checkClaudeCli` `spawnSync` has no timeout — hangs doctor | FIXED | `timeout: 5000` added to spawnSync call (line 420) |
| WR-01 | `direct-api`/`local` paths do not overwrite stale `RECENSE_MODEL_PROVIDER` | FIXED | All 3 paths write `RECENSE_MODEL_PROVIDER` (lines 524, 531, 535) |
| WR-02 | `checkBillingPosture` returns "direct-API mode" for local provider | FIXED | Line 385: `provider === 'local' ? 'local model mode' : 'direct-API mode'` |
| WR-03 | Gate rejects `'yes'` despite `[y/N]` conventional usage | FIXED | Line 491: `affirm !== 'y' && affirm !== 'yes'` |

### Anti-Patterns Found

No debt markers (TBD, FIXME, XXX, TODO, HACK, PLACEHOLDER) found in any phase-modified file. No stub implementations, no hardcoded empty returns in the implementation paths.

### Human Verification Required

None. All success criteria are mechanically verifiable:

- Default constant is a literal in config.ts (grep-verified)
- Detector behavior is covered by contract tests (vitest-verified)
- Gate logic is covered by unit tests driving real temp settings.json files (vitest-verified)
- Doctor dimensions are exercised with stub scripts (vitest-verified)
- No visual, real-time, or external-service behavior is introduced

## Gaps Summary

No gaps. All 10 observable truths are VERIFIED against the source code. The phase goal is achieved: subscription billing is the default, the install flow defaults to subscription without requiring an Anthropic API key, the billing footgun is surfaced with a warn-only gate (no file edits), and `recense doctor` correctly differentiates subscription from direct-API for the API-key and billing-posture dimensions.

---

_Verified: 2026-06-26T16:18:00Z_
_Verifier: Claude (gsd-verifier)_
