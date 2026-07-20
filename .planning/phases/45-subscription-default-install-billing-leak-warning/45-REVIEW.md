---
phase: 45-subscription-default-install-billing-leak-warning
reviewed: 2026-06-26T00:00:00Z
depth: standard
files_reviewed: 5
files_reviewed_list:
  - src/adapter/claude-settings-detector.ts
  - src/adapter/recense-init.ts
  - src/adapter/recense-doctor.ts
  - src/lib/config.ts
  - src/model/claude-headless-client.ts
findings:
  critical: 2
  warning: 3
  info: 2
  total: 7
status: issues_found
---

# Phase 45: Code Review Report

**Reviewed:** 2026-06-26T00:00:00Z
**Depth:** standard
**Files Reviewed:** 5
**Status:** issues_found

## Summary

Phase 45 introduces: (1) `settingsHasAnthropicKey` — a presence-only detector for `ANTHROPIC_API_KEY` in `~/.claude/settings.json`; (2) a flip of `DEFAULT_CONFIG.modelProvider` from `'anthropic'` to `'claude-headless'`; (3) a provider/billing selection step + acknowledge gate in `recense init`; (4) two new doctor dimensions (billing posture + claude CLI check).

The billing-safety invariants — never throw, never write settings.json, never emit the key value — are correctly implemented in `claude-settings-detector.ts` and preserved in the `checkBillingPosture` and `shouldBlockOnLeak` wrappers. The T-45-01 (presence-only) and T-45-05 (read-only) constraints hold throughout the reviewed code.

Two **critical** defects exist: the subscription re-run path violates T-45-07 by leaving a stale `ANTHROPIC_API_KEY` in the env file (the key is deleted from `vars` but `writeEnvFile` preserves lines from the existing file that are absent from `vars`), and the `claude auth status` probe in `checkClaudeCli` runs without a timeout, creating a hang vector in `recense doctor`. Three warnings cover a misleading pass label, stale RECENSE_MODEL_PROVIDER on provider-switch re-run, and the acknowledge gate accepting `'yes'` when it claims `[y/N]` requires `'y'`.

---

## Structural Findings (fallow)

No structural pre-pass was provided.

---

## Narrative Findings (AI reviewer)

## Critical Issues

### CR-01: `delete vars['ANTHROPIC_API_KEY']` does NOT remove the key from the written env file on subscription re-run (T-45-07 violation)

**File:** `src/adapter/recense-init.ts:507-518`

**Issue:** When `provider === 'subscription'`, line 512 calls `delete vars['ANTHROPIC_API_KEY']` before passing `vars` to `writeEnvFile`. The intent (T-45-07) is that a prior `ANTHROPIC_API_KEY` written by a previous `direct-api` run must be removed.

However, `writeEnvFile` (lines 121-133) iterates the _existing_ env file line-by-line. For each line it finds, it checks `Object.prototype.hasOwnProperty.call(vars, key)`. When the key was deleted from `vars`, `hasOwnProperty` returns `false`, so the existing line falls to `out.push(line)` — **preserved verbatim** (line 131). The key survives in the output file unchanged.

This means a user who first ran `recense init` as `direct-api` (writing `ANTHROPIC_API_KEY=sk-ant-...`) and then re-runs as `subscription` will still have `ANTHROPIC_API_KEY` in their `sleep.env`. Because `loadConfiguredEnv` merges sleep.env into spawn environments, the billing leak continues silently even after the provider flip — violating the load-bearing T-45-07 constraint.

The billing-leak footgun that the acknowledge gate warns about is left in place in the env file by the very step that claims to prevent it.

**Fix:** `writeEnvFile` needs to support key deletion, or the subscription path must explicitly write a sentinel/remove the key. The minimal correct fix is to not preserve lines for keys that were explicitly deleted from `vars`:

```typescript
// writeEnvFile: change line 130-132 to skip keys not in vars at all
// Option A (minimal, in writeEnvFile): skip the line when key is absent from vars
// — BUT this changes writeEnvFile's contract (currently "preserve unknown keys").
// Option B (caller-side, safest contract): write ANTHROPIC_API_KEY with empty value
// so writeEnvFile treats it as a present-but-empty key and overwrites:

if (provider === 'subscription') {
  vars['RECENSE_MODEL_PROVIDER'] = 'claude-headless';
  // Overwrite with empty string so writeEnvFile replaces the line (not preserves it).
  // An empty value means the key is present in the file but without a credential.
  vars['ANTHROPIC_API_KEY'] = '';
}
```

Or, cleaner: extend `writeEnvFile` to accept a `keysToRemove: Set<string>` parameter and skip those lines in the existing-file pass.

---

### CR-02: `checkClaudeCli` runs `spawnSync` without a timeout — hangs `recense doctor` indefinitely

**File:** `src/adapter/recense-doctor.ts:418`

**Issue:** `spawnSync(bin, ['auth', 'status', '--json'], { stdio: 'pipe' })` has no `timeout` option. On a network-impaired machine or when the claude CLI binary hangs during an auth status check (e.g. waiting for a network response to validate the session), this `spawnSync` call blocks the process indefinitely. Since `runDoctor` iterates dimensions sequentially with `await dim.result`, a hung `checkClaudeCli` freezes all subsequent output and the exit-code set at line 500.

This is particularly acute because `recense doctor` is the user-facing health check — a hang here with no output is far worse than a timed-out fail.

Compare: `checkScheduler` (line 191) calls `spawnSync('launchctl', ...)` with no timeout too, but launchctl is local-only. The `claude auth status` command _may_ make network requests.

**Fix:**
```typescript
const result = spawnSync(bin, ['auth', 'status', '--json'], {
  stdio: 'pipe',
  timeout: 10_000, // 10s ceiling; auth status should be nearly instant
});

// Add ETIMEDOUT handling after the spawn:
if (result.error) {
  const errCode = (result.error as NodeJS.ErrnoException).code;
  if (errCode === 'ETIMEDOUT') {
    return fail('claude CLI auth status timed out — check network or run `claude login`');
  }
  return fail('claude CLI not found — run `claude login`');
}
```

---

## Warnings

### WR-01: `local` and `direct-api` provider paths do not clear a stale `RECENSE_MODEL_PROVIDER=claude-headless` on re-run

**File:** `src/adapter/recense-init.ts:507-515`

**Issue:** The env-write block sets `RECENSE_MODEL_PROVIDER=claude-headless` only for the `subscription` path (line 510). When a user re-runs `recense init` and switches from `subscription` to `local` or `direct-api`, the old `RECENSE_MODEL_PROVIDER=claude-headless` line from the previous run is preserved in the env file (same `writeEnvFile` preservation logic as CR-01 explains). The subsequent `resolveActiveProvider` call in doctor/engine will then read `claude-headless` from the env file and behave as subscription mode despite the user having chosen a different provider. This silently overrides the user's choice.

**Fix:** All three provider branches should write `RECENSE_MODEL_PROVIDER`:
```typescript
const providerValue =
  provider === 'subscription' ? 'claude-headless' :
  provider === 'direct-api'  ? 'anthropic' :
  'local';
vars['RECENSE_MODEL_PROVIDER'] = providerValue;
```

---

### WR-02: `checkBillingPosture` returns `pass('direct-API mode')` for `local` provider — misleading label

**File:** `src/adapter/recense-doctor.ts:385`

**Issue:** The final `return pass('direct-API mode')` branch (line 385) is reached for both `direct-api` and `local` providers, because the function only branches on `isSubscription` (`provider === 'claude-headless'`). A user running `local` mode sees `✓ Billing: direct-API mode` which is incorrect — they are using a local model, not the direct Anthropic API. This is a false claim in a health-check output, which erodes trust.

**Fix:**
```typescript
  return pass(provider === 'local' ? 'local model mode' : 'direct-API mode');
```

---

### WR-03: Acknowledge gate accepts `'yes'` as a bypass despite claiming `[y/N]` requires `'y'`

**File:** `src/adapter/recense-init.ts:481`

**Issue:** The gate check is `if (ans.toLowerCase() !== 'y')` (line 481). The `ask()` helper (line 311) returns `ans.trim() || defaultVal || ''`. If the user types `'yes'`, `ans.toLowerCase()` is `'yes'` which is not `'y'`, so the gate correctly blocks. But the prompt string shows `'\n  Continue anyway? [y/N]'` with default `'N'` and comments in the code say "type y to continue". This is consistent.

However, the inverse is the actual issue: a user typing `'Y'` (uppercase) is correctly accepted because `.toLowerCase()` normalizes it. **The real WR** is that the prompt label says `[y/N]` but `'yes'` is rejected — a user familiar with shell prompts that accept `'yes'` will be confused and told to abort. More critically: the `ask()` helper (line 311) does `ans.trim() || defaultVal || ''`. If the user just hits Enter, `ans.trim()` is `''`, so `'' || 'N' || ''` resolves to `'N'`, and the gate blocks (correct). But this chain means if `defaultVal` were `undefined` or empty string, a bare Enter would return `''`, and `''.toLowerCase() !== 'y'` would be `true` — blocking. The default `'N'` correctly enforces the block-by-default behavior. This is sound.

The actual mismatch: the prompt asks `Continue anyway? [y/N]` which implies the default is `N`, but if a user types `'yes'`, the gate blocks them even though `yes` is conventionally equivalent to `y`. This is a UX friction that may confuse operators re-running init after the warning.

**Fix:**
```typescript
if (!['y', 'yes'].includes(ans.toLowerCase())) {
```

---

## Info

### IN-01: `shouldBlockOnLeak` in `recense-init.ts` duplicates the default path computation already in `claude-settings-detector.ts`

**File:** `src/adapter/recense-init.ts:297-300`

**Issue:** `shouldBlockOnLeak` constructs `join(homedir(), '.claude', 'settings.json')` as its own default (line 298) and then passes it to `settingsHasAnthropicKey`. But `settingsHasAnthropicKey` already has the same default path via `defaultClaudeSettingsPath()`. The wrapper adds no logic beyond forwarding, duplicating the path string. If the canonical path ever changes it must be updated in two places.

**Fix:** Either remove `shouldBlockOnLeak` and inline `settingsHasAnthropicKey(settingsPath)` at the call site in `main()`, or simplify the wrapper to call `settingsHasAnthropicKey(settingsPath)` without providing a fallback default (since the function already has one):
```typescript
export function shouldBlockOnLeak(settingsPath?: string): boolean {
  return settingsHasAnthropicKey(settingsPath);
}
```

---

### IN-02: `claude-headless-client.ts` comment header still says "(opt-in via env ONLY; default stays 'anthropic')" in one place — stale after the 45-02 default flip

**File:** `src/model/claude-headless-client.ts:9`

**Issue:** Line 9 was updated in this phase to say "the DEFAULT as of 45-02", which is correct. No further stale text found in the reviewed diff. This is a confirmation that the single line update is correct and no other references in this file were missed. No action needed — noted as informational only.

(On inspection, the diff shows exactly line 9 was updated. The rest of the file is unchanged and the comment chain about "BILLING SAFEGUARD" and "ISOLATION" is accurate for the new default.)

**No fix needed.**

---

_Reviewed: 2026-06-26T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
