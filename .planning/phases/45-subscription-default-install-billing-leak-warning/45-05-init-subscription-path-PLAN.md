---
phase: 45-subscription-default-install-billing-leak-warning
plan: 05
type: execute
wave: 2
depends_on:
  - 45-01-settings-key-detector
files_modified:
  - src/adapter/recense-init.ts
  - tests/recense-init.test.ts
autonomous: true
requirements: []
must_haves:
  truths:
    - "recense init shows a provider step with Subscription (claude -p) pre-selected as the default; Direct API and Local are the other options (D-04)"
    - "On the subscription path, init does NOT prompt for or require an Anthropic API key (D-05); the OpenAI key prompt + live validation still runs on every path (D-10)"
    - "On the subscription path, init writes RECENSE_MODEL_PROVIDER=claude-headless into ~/.config/recense/sleep.env and does NOT write ANTHROPIC_API_KEY (D-06)"
    - "On the subscription path, if ANTHROPIC_API_KEY is detected in ~/.claude/settings.json, init prints the billing warning and requires 'y' to continue — with NO edits to settings.json (D-07)"
    - "The Direct-API path still prompts + live-validates the Anthropic key (D-08); the Local path is unchanged (D-09)"
  artifacts:
    - path: "src/adapter/recense-init.ts"
      provides: "provider step + subscription path + acknowledge gate, factored into exported testable helpers"
      contains: "RECENSE_MODEL_PROVIDER"
    - path: "tests/recense-init.test.ts"
      provides: "tests for provider-step default, subscription-path key skip + env write, and acknowledge-gate triggering only on detected key"
  key_links:
    - from: "src/adapter/recense-init.ts (acknowledge gate)"
      to: "src/adapter/claude-settings-detector.ts settingsHasAnthropicKey"
      via: "import + call on the subscription path"
      pattern: "settingsHasAnthropicKey"
    - from: "src/adapter/recense-init.ts (subscription path)"
      to: "~/.config/recense/sleep.env"
      via: "vars['RECENSE_MODEL_PROVIDER'] = 'claude-headless' → writeEnvFile"
      pattern: "RECENSE_MODEL_PROVIDER.*claude-headless"
---

<objective>
Restructure `recense init` around the subscription default (D-04..D-10): add a provider step with Subscription pre-selected, skip the Anthropic-key prompt on the subscription path, write `RECENSE_MODEL_PROVIDER=claude-headless` to sleep.env, and add an acknowledge-gate that warns (no edits) when `ANTHROPIC_API_KEY` is detected in `~/.claude/settings.json`.

Purpose: ROADMAP success criteria 1 + 2 (init half) — a fresh install defaults to subscription billing and produces a working sleep-pass without an Anthropic key, and blocks on acknowledgement when the settings.json footgun key is present, never editing that file.

Output: edited `src/adapter/recense-init.ts` with new logic in EXPORTED testable helpers (per the wizard's testability convention), plus tests in `tests/recense-init.test.ts`. Consumes `settingsHasAnthropicKey` from 45-01.
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
export function settingsHasAnthropicKey(settingsPath?: string): boolean; // true iff env.ANTHROPIC_API_KEY set & non-empty
```

<!-- Live wizard spine (grep to confirm — planning line numbers drifted from PATTERNS): -->
recense-init.ts ask(rl, question, defaultVal?) — plain readline prompt with [bracket] default; NO select-prompt lib exists. Reuse this idiom for the provider step.
Existing default-preselected y/N example to mirror: const seedAnswer = await ask(rl, '\nSeed from your MEMORY.md now? [y/N]', 'N');
Wizard spine (in main()): DB path → promptAndValidateKey('ANTHROPIC_API_KEY', ..., 'anthropic') → promptAndValidateKey('OPENAI_API_KEY', ..., 'openai') → captureNodeBin → build `vars` record → writeEnvFile(envPath, vars) → scheduler → mergeSettingsHooks → optional seed.
vars build today: vars['RECENSE_NODE_BIN'], vars['RECENSE_DB'], if(anthropicKey) vars['ANTHROPIC_API_KEY'], if(openaiKey) vars['OPENAI_API_KEY']; then writeEnvFile(envPath, vars).
sleep.env path: prefer sleepEnvPath() from src/adapter/runtime-config.ts:27 over re-deriving join(homedir(),'.config','recense','sleep.env').
~/.claude/settings.json path used at the hooks step: join(homedir(), '.claude', 'settings.json').
Testability convention (recense-init.ts:19-21,59): all side-effect logic lives in "// ── Exported testable helpers ──" pure functions; main() is never run in tests. tests/recense-init.test.ts imports exported helpers and mocks @anthropic-ai/sdk / openai via vi.hoisted + vi.mock.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Provider step + subscription-path key-skip + sleep.env write (D-04/05/06/08/09/10)</name>
  <files>src/adapter/recense-init.ts</files>
  <read_first>
    - src/adapter/recense-init.ts (the full main() wizard spine + the `ask()` helper + `promptAndValidateKey` + the `vars` build + `writeEnvFile` call — grep "ask(rl", "promptAndValidateKey", "writeEnvFile", "RECENSE_SLEEP_ENV" for live lines)
    - src/adapter/runtime-config.ts:27 (sleepEnvPath() — use this instead of re-deriving the path, per PATTERNS)
    - .planning/phases/45-subscription-default-install-billing-leak-warning/45-PATTERNS.md (the recense-init.ts section: choice-prompt affordance, wizard spine to splice into, how sleep.env is written, testability convention)
  </read_first>
  <action>
    Add a provider/billing step to the init wizard, spliced BEFORE the Anthropic-key prompt so it can gate it (D-04). Implement the choice with the existing `ask()` readline helper + bracket-default idiom (NO new prompt lib): a prompt offering Subscription (claude -p) / Direct API / Local with Subscription as the pre-selected default (e.g. `[1]` or `[S]`). Factor the choice parsing into an EXPORTED pure helper (e.g. `parseProviderChoice(raw: string): 'subscription' | 'direct-api' | 'local'`) so it is unit-testable per the wizard convention; default/empty input → 'subscription'.

    Branch the wizard on the choice:
    - Subscription (D-05): SKIP the `promptAndValidateKey(... 'anthropic')` call entirely — do not prompt for or require the Anthropic key.
    - Direct API (D-08): keep the existing `promptAndValidateKey(... 'anthropic')` prompt + live validation UNCHANGED.
    - Local (D-09): existing behavior unchanged.
    - All paths (D-10): keep the OpenAI `promptAndValidateKey(... 'openai')` prompt + live validation — still required (embeddings; subscription covers Anthropic only).

    sleep.env write (D-06): on the Subscription path, set `vars['RECENSE_MODEL_PROVIDER'] = 'claude-headless'` and do NOT set `vars['ANTHROPIC_API_KEY']`. Use `sleepEnvPath()` from runtime-config.ts for the env path rather than re-deriving the join. `writeEnvFile` already preserves existing keys and updates in place — this is the single correct insertion point. Do not change the Direct-API/Local vars behavior beyond adding the provider key on subscription.

    HONESTY (CLAUDE.md / CONTEXT copy rule): any provider-step copy says subscription covers Anthropic billing — never "no keys needed" (OpenAI still required).
  </action>
  <verify>
    <automated>npx tsc --noEmit && grep -nE "RECENSE_MODEL_PROVIDER.*claude-headless" src/adapter/recense-init.ts && grep -nq "parseProviderChoice" src/adapter/recense-init.ts && echo OK</automated>
  </verify>
  <acceptance_criteria>
    - recense-init.ts has a provider step (via `ask()`, no new prompt lib) defaulting to subscription, with an exported `parseProviderChoice`-style helper whose empty/default input returns the subscription option
    - On the subscription branch, `promptAndValidateKey(... 'anthropic')` is NOT called and `vars['ANTHROPIC_API_KEY']` is NOT set
    - On the subscription branch, `vars['RECENSE_MODEL_PROVIDER'] = 'claude-headless'` is set and the env path is obtained via `sleepEnvPath()`
    - The OpenAI prompt + validation runs on every path; the Direct-API anthropic prompt + validation is unchanged on the direct-api path
    - `npx tsc --noEmit` clean; no "no keys needed" copy in the new wizard text
  </acceptance_criteria>
  <done>Provider step added with subscription default; subscription path skips the Anthropic key and writes RECENSE_MODEL_PROVIDER=claude-headless via sleepEnvPath(); direct-api/local/OpenAI behavior preserved.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Acknowledge gate + tests (D-07)</name>
  <files>src/adapter/recense-init.ts, tests/recense-init.test.ts</files>
  <read_first>
    - src/adapter/recense-init.ts (the `promptAndValidateKey` skip-confirm idiom — a single ask/askSecret read + `.toLowerCase()` compare — to mirror for the y/N gate; and the subscription branch added in Task 1)
    - src/adapter/claude-settings-detector.ts (the settingsHasAnthropicKey signature from 45-01)
    - tests/recense-init.test.ts (the exported-helper import + vi.hoisted/vi.mock pattern for @anthropic-ai/sdk and openai — mirror it for the new gate helper; PATTERNS :40-47)
    - tests/recense-doctor.test.ts (the temp-settings.json-to-tmpdir override-path idiom for driving the detector with a controlled file)
  </read_first>
  <behavior>
    - acknowledge gate helper (e.g. `shouldBlockOnLeak(settingsPath)`): returns true iff settingsHasAnthropicKey(settingsPath) is true (gate triggers ONLY when the key is detected)
    - key absent / missing file / malformed settings.json → gate does NOT trigger (false) → subscription path proceeds with no prompt
    - the gate is the ONLY new place settingsHasAnthropicKey is consumed in init; the warning copy names the ~/.claude/settings.json ANTHROPIC_API_KEY direct-API footgun and instructs removing it from the env block
    - NO edits to ~/.claude/settings.json (detect + warn only)
  </behavior>
  <action>
    On the Subscription path (from Task 1), after the provider choice, call the detector and add the acknowledge gate (D-07): import `settingsHasAnthropicKey` from `./claude-settings-detector` (recense-init.ts lives in src/adapter/, so the correct relative path is ./claude-settings-detector — matches 45-01's module). Factor the gate decision into an EXPORTED pure helper so it is testable without running main() — e.g. `shouldBlockOnLeak(settingsPath = join(homedir(),'.claude','settings.json')): boolean` returning the detector result. In main(), if the gate helper returns true: print the billing warning (to stdout) naming the footgun and instructing the user to remove ANTHROPIC_API_KEY from the `env` block of `~/.claude/settings.json`, then `const ans = await ask(rl, '...continue anyway? [y/N]', 'N')` and `if (ans.toLowerCase() !== 'y') process.exit(1)`. CRITICAL (honesty + scope fence): do NOT edit ~/.claude/settings.json; do NOT print the key value; the warning is the safeguard, do not claim the strip fixes billing.

    Tests (tests/recense-init.test.ts): add cases driving the exported gate helper with a temp settings.json written to tmpdir() (mirror the doctor test idiom) — key-present → gate true; key-absent/no-file/malformed → gate false. Add a test asserting `parseProviderChoice` (from Task 1) returns subscription for empty/default input and the right option for explicit inputs. Mock SDKs via the existing vi.hoisted/vi.mock pattern as the file already does.
  </action>
  <verify>
    <automated>npx vitest run tests/recense-init.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - recense-init.ts imports settingsHasAnthropicKey from the 45-01 module and the acknowledge gate is reached ONLY on the subscription path
    - An exported gate helper returns true iff the key is detected; key-absent/missing/malformed → false (verified by tests against temp settings.json)
    - The gate prints a warning naming the ~/.claude/settings.json footgun and requires 'y' to continue (else process.exit(1)); no settings.json edit occurs
    - `npx vitest run tests/recense-init.test.ts` exits 0 including the new gate + parseProviderChoice tests
    - `grep -n "writeFileSync\|writeFile\|mergeSettingsHooks" ` around the new gate code shows the gate does NOT write to ~/.claude/settings.json
  </acceptance_criteria>
  <done>Acknowledge gate triggers only when the detector reports the key; warns + requires y (no file edits); gate and provider-choice helpers unit-tested green.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| ~/.claude/settings.json → init | user-owned file read via the detector to drive the acknowledge gate (must not throw, must not be mutated) |
| init → ~/.config/recense/sleep.env | init writes RECENSE_MODEL_PROVIDER; must not write a stale/leaked Anthropic key on the subscription path |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-45-01 | Information Disclosure | acknowledge-gate warning output | mitigate | Warning reports presence only via the detector boolean; never prints the ANTHROPIC_API_KEY value. |
| T-45-05 | Tampering | acknowledge gate / subscription path vs ~/.claude/settings.json | mitigate | Gate is read-only (detect + warn); no writeFileSync/mergeSettingsHooks against settings.json in the gate. Acceptance grep + project constraint enforce. |
| T-45-02 | Denial of Service | detector read of malformed settings.json during init | mitigate | Gate delegates to settingsHasAnthropicKey (45-01) which never throws on missing/malformed; gate returns false → init proceeds. |
| T-45-07 | Information Disclosure | sleep.env on subscription path | mitigate | Subscription branch does NOT set vars['ANTHROPIC_API_KEY']; only RECENSE_MODEL_PROVIDER is written. Acceptance checks. |
| T-45-SC | Tampering | npm installs | accept | No new installs (reuses existing detector + mocked SDKs); audit table N/A. |
</threat_model>

<verification>
- `npx vitest run tests/recense-init.test.ts` exits 0.
- `npx tsc --noEmit` clean.
- Subscription path writes RECENSE_MODEL_PROVIDER=claude-headless, no ANTHROPIC_API_KEY; gate triggers only on detected key; settings.json never written.
</verification>

<success_criteria>
- D-04..D-10 satisfied. ROADMAP criteria 1+2 (init half): subscription-default, Anthropic-key-free working install; acknowledge gate on the detected footgun key with no file edits.
</success_criteria>

<output>
Create `.planning/phases/45-subscription-default-install-billing-leak-warning/45-05-SUMMARY.md` when done. Record the exported helper names (parseProviderChoice, the gate helper) and the exact warning copy used.
</output>
