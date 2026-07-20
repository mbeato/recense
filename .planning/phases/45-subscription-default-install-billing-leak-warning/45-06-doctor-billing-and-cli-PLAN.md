---
phase: 45-subscription-default-install-billing-leak-warning
plan: 06
type: execute
wave: 2
depends_on:
  - 45-01-settings-key-detector
files_modified:
  - src/adapter/recense-doctor.ts
  - tests/recense-doctor.test.ts
autonomous: true
requirements: []
must_haves:
  truths:
    - "Under subscription mode a missing Anthropic API key is reported as ✓ 'subscription mode (Anthropic API key not needed)' and is NOT a failure; OpenAI remains a hard ✗ when missing; Direct-API mode is unchanged (D-11, ROADMAP success criterion 3)"
    - "A new standing billing-posture dimension fails with exit 1 when active provider is subscription AND ANTHROPIC_API_KEY is present in ~/.claude/settings.json, printing the remove-it-from-the-env-block message; subscription + no key passes (D-12, ROADMAP success criterion 2)"
    - "A new claude-CLI dimension verifies the claude binary is present AND logged in via `claude auth status --json` — a non-billed auth-state probe (NEVER `claude --version`, which passes even when logged out; NEVER `claude -p`); a logged-out/missing state → ✗ 'claude CLI not logged in — run claude login' (present-but-logged-out) or 'claude CLI not found — run claude login' (binary missing) (D-13, ROADMAP success criterion 3)"
    - "recense doctor never edits ~/.claude/settings.json (detect + warn only)"
  artifacts:
    - path: "src/adapter/recense-doctor.ts"
      provides: "checkBillingPosture + checkClaudeCli dimensions + reworked checkApiKeys, registered in dimensions[] (count toward exit-1)"
      contains: "checkBillingPosture"
    - path: "tests/recense-doctor.test.ts"
      provides: "billing-dimension (sub+key→fail, sub+nokey→pass, no-false-failure), reworked-apikeys, and claude-CLI-missing tests"
  key_links:
    - from: "src/adapter/recense-doctor.ts checkBillingPosture"
      to: "src/adapter/claude-settings-detector.ts settingsHasAnthropicKey"
      via: "import + call after resolving active provider"
      pattern: "settingsHasAnthropicKey"
    - from: "src/adapter/recense-doctor.ts checkClaudeCli"
      to: "claude CLI (non-billed probe)"
      via: "spawnSync(bin, [<non-billed flag>]) with bin = RECENSE_CLAUDE_BIN || 'claude'"
      pattern: "RECENSE_CLAUDE_BIN"
---

<objective>
Rework `recense doctor` for the subscription default (D-11/12/13): rework the API-key dimension so a missing Anthropic key is not a failure under subscription, add a standing billing-posture dimension that fails on the settings.json footgun, and add a non-billed claude-CLI login probe.

Purpose: ROADMAP success criteria 2 + 3 (doctor half) — doctor flags the footgun key as a failing dimension until resolved (never editing the file), verifies the claude CLI is present + logged in, and stops reporting a missing Anthropic key as a failure under subscription mode.

Output: edited `src/adapter/recense-doctor.ts` (two new exported dimensions + reworked checkApiKeys, registered in the dimensions[] array + updated header count), plus tests. Consumes `settingsHasAnthropicKey` from 45-01.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/45-subscription-default-install-billing-leak-warning/45-CONTEXT.md
@.planning/phases/45-subscription-default-install-billing-leak-warning/45-PATTERNS.md
@.planning/phases/45-subscription-default-install-billing-leak-warning/45-01-SUMMARY.md

<interfaces>
<!-- Dependency from 45-01 (confirm exact signature in 45-01-SUMMARY.md): -->
From src/adapter/claude-settings-detector.ts:
```typescript
export function settingsHasAnthropicKey(settingsPath?: string): boolean;
```

<!-- Live doctor structure (grep to confirm): -->
recense-doctor.ts:42-48 → interface CheckResult { ok; detail } + pass(detail) / fail(detail)
recense-doctor.ts:88  → export async function checkApiKeys(): Promise<CheckResult>   (hard-fails on missing ANTHROPIC — rework under D-11)
recense-doctor.ts:155 → export function checkScheduler(): CheckResult   (spawnSync(..., {stdio:'pipe'}) → status→pass/fail; analog for checkClaudeCli)
<!-- VERIFIED non-billed login-state probe: `claude auth status --json` exists (subcommands: login/logout/status; status supports --json/--text). It is non-billed (no inference, no `claude -p`) and reports auth state. Do NOT use `claude --version` — it exits 0 regardless of login state and would falsely pass a logged-out user (contradicts SC3 'present + logged in'). -->
recense-doctor.ts:190 → export function checkHooks(settingsOverridePath?): CheckResult   (existsSync→fail, try JSON.parse catch→fail; the override-path convention to copy)
recense-doctor.ts:281 → export function checkServeToken(envPath = sleepEnvPath()): CheckResult   (reads local env file + branches; analog for checkBillingPosture)
recense-doctor.ts:305 → interface DoctorDimension; :317 dimensions[] array; the loop tallies `failures` → process.exitCode = failures>0?1:0 (a returned ok:false auto-counts toward exit-1 — no special handling)
recense-doctor.ts:3 → header doc comment "6-dimension install health audit" (update the count for the new dimensions)

src/adapter/runtime-config.ts → sleepEnvPath() (:27), loadConfiguredEnv()/resolveExistingEnv() to read RECENSE_MODEL_PROVIDER from the env file
src/model/claude-headless-client.ts:208 → const bin = process.env['RECENSE_CLAUDE_BIN'] || 'claude';   (mirror so tests can stub the probe)
~/.claude/settings.json path: join(homedir(), '.claude', 'settings.json')
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Rework checkApiKeys + add checkBillingPosture (D-11, D-12)</name>
  <files>src/adapter/recense-doctor.ts</files>
  <read_first>
    - src/adapter/recense-doctor.ts (checkApiKeys ~:88-144 — the ANTHROPIC missing→anyFail branch ~:95-97 and the OpenAI branch ~:121-140; checkServeToken ~:281-301 as the read-local-state-and-branch analog; the dimensions[] array ~:317 and the failure tally ~:328-346; the header comment ~:3)
    - src/adapter/runtime-config.ts (sleepEnvPath / loadConfiguredEnv / resolveExistingEnv — to read RECENSE_MODEL_PROVIDER for the active provider)
    - src/adapter/claude-settings-detector.ts (settingsHasAnthropicKey from 45-01)
    - .planning/phases/45-subscription-default-install-billing-leak-warning/45-PATTERNS.md (the recense-doctor.ts section: dimension contract, checkServeToken analog for billing-posture, reworking checkApiKeys, registration + tally)
  </read_first>
  <action>
    Add a shared `resolveActiveProvider(envPath = sleepEnvPath()): string` helper (so D-11 and D-12 agree on one source): read RECENSE_MODEL_PROVIDER from the configured env file via loadConfiguredEnv/resolveExistingEnv, falling back to `DEFAULT_CONFIG.modelProvider` when unset. Treat 'claude-headless' as subscription mode.

    Rework checkApiKeys (D-11): give it an `envPath` override param — `checkApiKeys(envPath: string = sleepEnvPath()): Promise<CheckResult>` — consistent with checkServeToken/checkHooks, so the no-false-failure test can write a temp env file with RECENSE_MODEL_PROVIDER=claude-headless and pass its path to drive subscription mode; checkApiKeys reads the active provider via resolveActiveProvider(envPath). When the active provider is subscription ('claude-headless') and the Anthropic key is missing, emit `✓ subscription mode (Anthropic API key not needed)` and do NOT set anyFail — a missing Anthropic key is expected and is NOT a failure. Keep the OpenAI branch a hard fail when missing (embeddings still required). Under Direct-API mode, keep the current Anthropic behavior unchanged.

    Add `checkBillingPosture(settingsOverridePath?: string, envPath = sleepEnvPath()): CheckResult` (D-12), modeled on checkServeToken (read local state, branch). Accept an override path param for testing (mirror checkHooks). Logic: provider = resolveActiveProvider(envPath); keyPresent = settingsHasAnthropicKey(settingsOverridePath). If provider is subscription AND keyPresent → `fail('ANTHROPIC_API_KEY in ~/.claude/settings.json will bill direct API even on subscription — remove it from the env block')`. Else → `pass(...)` with a truthful detail (e.g. subscription + no key → "subscription billing, no direct-API key in settings.json"; direct-api → "direct-API mode"). Register `{ name: 'Billing', result: checkBillingPosture() }` in the dimensions[] array — a returned ok:false auto-counts toward the exit-1 failures tally (no special handling). Update the header doc comment's dimension count to match. SCOPE FENCE: checkBillingPosture is READ-ONLY — it must NEVER write to ~/.claude/settings.json. HONESTY: the message names the footgun and the fix (remove the key); it does not claim recense fixes it for you.
  </action>
  <verify>
    <automated>npx tsc --noEmit && grep -nq "checkBillingPosture" src/adapter/recense-doctor.ts && grep -nq "subscription mode (Anthropic API key not needed)" src/adapter/recense-doctor.ts && grep -nq "name: 'Billing'" src/adapter/recense-doctor.ts && echo OK</automated>
  </verify>
  <acceptance_criteria>
    - A `resolveActiveProvider` helper exists and is used by BOTH checkApiKeys and checkBillingPosture (single source of provider truth)
    - checkApiKeys signature is `checkApiKeys(envPath: string = sleepEnvPath()): Promise<CheckResult>` (envPath override added, mirroring checkServeToken/checkHooks) so the no-false-failure test drives subscription mode via a temp env file passed to it; `{ name: 'API keys', result: checkApiKeys() }` registration in dimensions[] still calls it with the default path
    - checkApiKeys under subscription + missing Anthropic key emits the exact string `✓`-style `subscription mode (Anthropic API key not needed)` and does NOT mark failure; OpenAI missing is still a hard fail; direct-api unchanged
    - checkBillingPosture returns fail with the exact message `ANTHROPIC_API_KEY in ~/.claude/settings.json will bill direct API even on subscription — remove it from the env block` when subscription + keyPresent; passes otherwise; takes a settings override path
    - `{ name: 'Billing', result: checkBillingPosture() }` is registered in dimensions[]; header dimension count updated
    - checkBillingPosture contains NO write to ~/.claude/settings.json; `npx tsc --noEmit` clean
  </acceptance_criteria>
  <done>checkApiKeys no longer fails on a missing Anthropic key under subscription; checkBillingPosture flags the footgun (exit-1 via the tally) read-only; both share resolveActiveProvider.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Non-billed claude-CLI probe + dimension tests (D-13)</name>
  <files>src/adapter/recense-doctor.ts, tests/recense-doctor.test.ts</files>
  <read_first>
    - src/adapter/recense-doctor.ts (checkScheduler ~:155-177 — the spawnSync(..., {stdio:'pipe'}) status→pass/fail analog; the dimensions[] array to append to)
    - src/model/claude-headless-client.ts:208 (the `process.env['RECENSE_CLAUDE_BIN'] || 'claude'` bin resolution to mirror)
    - tests/recense-doctor.test.ts (the temp-settings.json-to-tmpdir override-path test idiom ~:147-205; how RECENSE_CLAUDE_BIN can be pointed at a stub script)
    - .planning/phases/45-subscription-default-install-billing-leak-warning/45-PATTERNS.md (the D-13 claude-CLI probe guidance: cheap/non-billed, never claude -p)
  </read_first>
  <behavior>
    - checkClaudeCli: spawnSync(bin, ['auth', 'status', '--json'], {stdio:'pipe'}) with bin = process.env['RECENSE_CLAUDE_BIN'] || 'claude'. This is a NON-BILLED auth-STATE probe (verified to exist), not a presence-only probe. Interpret the result for actual login: authenticated → pass; not authenticated (non-zero exit OR JSON reporting a logged-out/unauthenticated state) → fail; spawn error / ENOENT (binary missing) → fail.
    - the probe MUST verify login state, not just presence — NEVER `claude --version` (exits 0 when logged out → false pass), NEVER `claude -p` (inference call, would bill). `claude auth status` performs no inference and does not bill.
    - The dimension distinguishes binary-missing (ENOENT → 'claude CLI not found — run `claude login`') from present-but-logged-out (auth status reports unauthenticated → 'claude CLI not logged in — run `claude login`').
    - checkBillingPosture tests (from Task 1): subscription + key-present temp settings.json → fail (ok:false); subscription + no key → pass; missing Anthropic key under subscription is NOT a checkApiKeys failure
    - claude-CLI-missing: pointing RECENSE_CLAUDE_BIN at a nonexistent/failing binary → checkClaudeCli fails
  </behavior>
  <action>
    Add `checkClaudeCli(): CheckResult` (D-13) modeled on checkScheduler: resolve `const bin = process.env['RECENSE_CLAUDE_BIN'] || 'claude';` (mirror claude-headless-client.ts:208 so tests can stub it), then `spawnSync(bin, ['auth', 'status', '--json'], { stdio: 'pipe' })` — the VERIFIED non-billed auth-STATE probe (NOT `claude --version`, which exits 0 even when logged out and would falsely pass; NOT `claude -p`, which bills). Interpret the result for actual login state: if spawn errored (result.error, e.g. ENOENT) → `fail('claude CLI not found — run \`claude login\`')`; else if status === 0 AND the JSON stdout reports an authenticated state → `pass('claude CLI present and logged in')`; else (non-zero status, or JSON reporting logged-out/unauthenticated) → `fail('claude CLI not logged in — run \`claude login\`')`. Parse the `--json` stdout defensively (try/catch; treat unparseable/ambiguous output as logged-out → fail, never throw). HONESTY: pass only claims 'logged in' because the probe actually checks auth state — do not claim login from a presence-only signal. Register `{ name: 'claude CLI', result: checkClaudeCli() }` in dimensions[] (auto-counts toward exit-1). Update the header dimension count.

    Tests (tests/recense-doctor.test.ts): mirror the existing temp-settings.json + override-path idiom. (a) checkBillingPosture: write a temp settings.json with ANTHROPIC_API_KEY present and a temp env file with RECENSE_MODEL_PROVIDER=claude-headless → assert ok:false with the remove-it message; settings without the key → ok:true; (b) checkApiKeys no-false-failure: subscription mode + missing Anthropic key → not a failure (assert the ✓ subscription detail / not anyFail); (c) checkClaudeCli: point RECENSE_CLAUDE_BIN at a stub script that prints an authenticated-state JSON and exits 0 → pass ('present and logged in'); point it at a stub that prints a logged-out JSON and/or exits non-zero → fail ('not logged in'); point it at a nonexistent binary → fail ('not found'). Assert the stub is invoked with `auth status` args (not `-p`). Confirm none of the doctor tests spawn `claude -p`.
  </action>
  <verify>
    <automated>npx vitest run tests/recense-doctor.test.ts && grep -nq "RECENSE_CLAUDE_BIN" src/adapter/recense-doctor.ts && grep -c "claude', \['-p'\|claude -p" src/adapter/recense-doctor.ts | grep -q '^0$' && echo OK</automated>
  </verify>
  <acceptance_criteria>
    - checkClaudeCli uses `process.env['RECENSE_CLAUDE_BIN'] || 'claude'` and spawns `auth status --json` (the non-billed auth-STATE probe) — NO `claude -p` / `-p` and NO `--version`-only presence check anywhere in the dimension
    - The probe verifies LOGIN STATE, not just presence: a logged-out auth-status result (non-zero exit OR JSON reporting unauthenticated) → fail (probe exits non-zero / reports logged-out when not authenticated, asserted by the logged-out stub test); a binary-missing spawn error → fail; an authenticated result → pass
    - Failure messages distinguish binary-missing ('claude CLI not found — run `claude login`') from logged-out ('claude CLI not logged in — run `claude login`'); the JSON is parsed defensively (unparseable → logged-out fail, never throw)
    - `{ name: 'claude CLI', result: checkClaudeCli() }` registered in dimensions[]; header count updated
    - `npx vitest run tests/recense-doctor.test.ts` exits 0 covering: billing sub+key→fail, sub+nokey→pass, apikeys no-false-failure under subscription, claude-CLI-missing→fail
    - No doctor test or dimension spawns `claude -p`
  </acceptance_criteria>
  <done>Non-billed claude-CLI dimension added and registered; billing + apikeys + CLI dimensions tested green per the PRD testing matrix; no inference call incurred.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| ~/.claude/settings.json → doctor | user-owned file read via the detector for the billing dimension (must not throw, must not be mutated) |
| doctor → claude CLI | spawns the claude binary; must use a non-billed probe and must not incur API/subscription token spend |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-45-01 | Information Disclosure | checkBillingPosture detail string | mitigate | Message reports presence only (via the detector boolean); never prints the ANTHROPIC_API_KEY value. |
| T-45-05 | Tampering | checkBillingPosture vs ~/.claude/settings.json | mitigate | Dimension is read-only (detect + warn); no write to settings.json. Acceptance grep + project constraint enforce. |
| T-45-02 | Denial of Service | detector read of malformed settings.json in doctor | mitigate | Delegates to settingsHasAnthropicKey (45-01) which never throws; dimension returns a clean pass/fail. |
| T-45-06 | (cost/spend) | checkClaudeCli probe | mitigate | Probe uses `claude auth status --json` (non-billed auth-state check), explicitly NOT `claude -p`; acceptance greps for absence of `-p`. |
| T-45-SC | Tampering | npm installs | accept | No new installs (reuses existing detector + spawnSync); audit table N/A. |
</threat_model>

<verification>
- `npx vitest run tests/recense-doctor.test.ts` exits 0 covering the full PRD doctor matrix.
- `npx tsc --noEmit` clean.
- No `claude -p` spawned by any dimension or test; settings.json never written.
</verification>

<success_criteria>
- D-11/D-12/D-13 satisfied. ROADMAP criteria 2+3 (doctor half): footgun key flagged as a failing dimension (read-only), claude CLI presence+login verified non-billed, missing Anthropic key not a failure under subscription.
</success_criteria>

<output>
Create `.planning/phases/45-subscription-default-install-billing-leak-warning/45-06-SUMMARY.md` when done. Record the new dimension count, the exact claude-CLI probe flag chosen (and why it does not bill), and the exact billing/apikeys detail strings.
</output>
