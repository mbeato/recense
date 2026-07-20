---
phase: 45-subscription-default-install-billing-leak-warning
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - src/adapter/claude-settings-detector.ts
  - tests/claude-settings-detector.test.ts
autonomous: true
requirements: []
must_haves:
  truths:
    - "A single exported reader reports whether ANTHROPIC_API_KEY is set in ~/.claude/settings.json's env block (D-14)"
    - "The reader never throws for any of the four inputs: key-present, key-absent, missing-file, malformed-JSON (D-14, security threat T-45-02)"
    - "The reader reports presence only and never returns, logs, or echoes the key VALUE (security threat T-45-01)"
  artifacts:
    - path: "src/adapter/claude-settings-detector.ts"
      provides: "settingsHasAnthropicKey() — single reader consumed by init gate (D-07) and doctor billing dimension (D-12)"
      exports: ["settingsHasAnthropicKey"]
    - path: "tests/claude-settings-detector.test.ts"
      provides: "four-outcome contract tests (present/absent/missing-file/malformed)"
  key_links:
    - from: "src/adapter/claude-settings-detector.ts"
      to: "~/.claude/settings.json env.ANTHROPIC_API_KEY"
      via: "existsSync guard → try JSON.parse catch → defensive level-by-level narrowing"
      pattern: "settings\\.env\\.ANTHROPIC_API_KEY|env\\?\\.\\['ANTHROPIC_API_KEY'\\]"
---

<objective>
Create the shared `~/.claude/settings.json` `ANTHROPIC_API_KEY` detector (D-14): one reader, two consumers (init acknowledge-gate D-07, doctor billing dimension D-12).

Purpose: This is the keystone dependency for Wave 2. Both `recense init` and `recense doctor` need to ask the same question — "is ANTHROPIC_API_KEY set in the Claude Code settings file?" — and they must agree. Building it once, here, lets Wave 2 plans depend on it instead of each re-deriving a fragile JSON read.

Output: `src/adapter/claude-settings-detector.ts` exporting `settingsHasAnthropicKey(settingsPath?)` returning a boolean, plus its test.
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

<interfaces>
<!-- Canonical analog: the repo's safe user-owned JSON reader. Mirror this posture exactly. -->
From src/adapter/settings-loader.ts (loadSettingsFile, the exact-match analog):
```typescript
export function loadSettingsFile(path: string = defaultSettingsPath()): SettingsFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isSettingsFileShape(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
```

The ~/.claude/settings.json path idiom (used at recense-init.ts and recense-doctor.ts):
```typescript
const settingsPath = join(homedir(), '.claude', 'settings.json');
```
Note: this is a DIFFERENT file than settings-loader.ts's own ~/.config/recense/settings.json. Do not reuse loadSettingsFile/defaultSettingsPath — they target the wrong file. Write a fresh reader pointed at ~/.claude/settings.json.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Write four-outcome detector tests (RED)</name>
  <files>tests/claude-settings-detector.test.ts</files>
  <read_first>
    - tests/recense-doctor.test.ts (the temp-settings.json test idiom — write variants to tmpdir() via mkdirSync/writeFileSync, pass the override path; see the checkHooks tests around :147-205 per PATTERNS.md)
    - src/adapter/settings-loader.ts (the analog reader being mirrored, lines :52-63)
  </read_first>
  <behavior>
    - key present: settings.json with `{"env":{"ANTHROPIC_API_KEY":"sk-ant-xxx"}}` → returns true
    - key absent: settings.json with `{"env":{}}` or `{"env":{"OTHER":"x"}}` or no env block → returns false
    - empty-string key: `{"env":{"ANTHROPIC_API_KEY":""}}` → returns false (non-empty required per D-14 "set & non-empty")
    - missing file: path that does not exist → returns false (no throw)
    - malformed JSON: file containing `{not valid json` → returns false (no throw)
    - the test NEVER asserts on the key VALUE — only the boolean (presence-only contract, security T-45-01)
  </behavior>
  <action>
    Create the test file at tests/claude-settings-detector.test.ts importing `settingsHasAnthropicKey` from `../src/adapter/claude-settings-detector`. Use vitest (describe/it/expect), mkdirSync({recursive:true}) + writeFileSync to tmpdir() subdirs to create each settings.json variant, and pass the file path as the override param. Cover all five cases in the behavior block. The malformed case must assert the call does not throw (wrap in expect(() => ...).not.toThrow() or assert it returns false). Run the test now and confirm it FAILS because the module/function does not exist yet (RED).
  </action>
  <verify>
    <automated>npx vitest run tests/claude-settings-detector.test.ts 2>&1 | grep -qi "cannot find module\|failed\|is not a function" && echo "RED confirmed"</automated>
  </verify>
  <acceptance_criteria>
    - tests/claude-settings-detector.test.ts exists and imports settingsHasAnthropicKey from ../src/adapter/claude-settings-detector
    - Test file contains all five cases: present, absent, empty-string, missing-file, malformed-JSON
    - `npx vitest run tests/claude-settings-detector.test.ts` FAILS (module/function not yet defined) — RED state confirmed
    - No test asserts on the literal key value string
  </acceptance_criteria>
  <done>Failing test file committed describing the four-outcome contract; vitest reports failure because the implementation is absent.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Implement settingsHasAnthropicKey detector (GREEN)</name>
  <files>src/adapter/claude-settings-detector.ts</files>
  <read_first>
    - src/adapter/settings-loader.ts:52-63 (loadSettingsFile — the exact safe-read posture to mirror: existsSync guard → try JSON.parse catch → neutral return)
    - src/adapter/recense-init.ts (the `join(homedir(), '.claude', 'settings.json')` path idiom — grep for it to confirm live line)
    - tests/claude-settings-detector.test.ts (the contract written in Task 1)
  </read_first>
  <action>
    Create src/adapter/claude-settings-detector.ts exporting `settingsHasAnthropicKey(settingsPath: string = join(homedir(), '.claude', 'settings.json')): boolean`. Implementation posture mirrors settings-loader.ts:loadSettingsFile exactly: `if (!existsSync(settingsPath)) return false;` then `try { const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')); ... } catch { return false; }`. Inside the try, defensively narrow each level (the file is user-owned and arbitrary): read `parsed.env`, guard it is a non-null object, read `env.ANTHROPIC_API_KEY`, and return `typeof key === 'string' && key.length > 0`. Import `existsSync`/`readFileSync` from 'node:fs', `homedir` from 'node:os', `join` from 'node:path'. SECURITY (T-45-01): the function returns a boolean and MUST NOT return, log, console.*, or otherwise emit the key value anywhere. Add a top-of-file doc comment stating: single reader for ~/.claude/settings.json env.ANTHROPIC_API_KEY presence; consumed by recense-init acknowledge gate (D-07) and recense-doctor billing dimension (D-12); presence-only, never echoes the value; never throws.
  </action>
  <verify>
    <automated>npx vitest run tests/claude-settings-detector.test.ts</automated>
  </verify>
  <acceptance_criteria>
    - src/adapter/claude-settings-detector.ts exports `settingsHasAnthropicKey` with a default path param of `join(homedir(), '.claude', 'settings.json')`
    - `npx vitest run tests/claude-settings-detector.test.ts` exits 0 (all four-outcome cases pass) — GREEN
    - `grep -nE 'console\.|process\.stdout|process\.stderr|return.*ANTHROPIC_API_KEY\]' src/adapter/claude-settings-detector.ts` returns NO line that emits the key value (presence-only, T-45-01)
    - `npx tsc --noEmit` reports no new type errors for this file
  </acceptance_criteria>
  <done>Detector implemented; all five contract cases pass; no path throws; the key value is never emitted.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| filesystem → recense | `~/.claude/settings.json` is user-owned, arbitrary, possibly malformed/adversarial content crosses into the detector |
| detector → callers | the boolean result crosses into init (gate) and doctor (dimension); the key value must NOT cross |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-45-01 | Information Disclosure | settingsHasAnthropicKey return/logging | mitigate | Return a boolean only; the function body never logs/returns/echoes the ANTHROPIC_API_KEY value. Acceptance grep enforces no value emission. |
| T-45-02 | Denial of Service | JSON.parse on adversarial settings.json | mitigate | existsSync guard + try/parse/catch → return false; all four inputs (present/absent/missing/malformed) return cleanly, never throw. Test asserts not-throw on malformed. |
| T-45-SC | Tampering | npm installs | accept | No new package-manager installs in this plan (node builtins only); RESEARCH/audit table N/A. |
</threat_model>

<verification>
- `npx vitest run tests/claude-settings-detector.test.ts` exits 0.
- `npx tsc --noEmit` clean for the new file.
- Manual grep confirms presence-only posture (no key-value emission).
</verification>

<success_criteria>
- D-14 satisfied: one exported reader, four outcomes correct, never throws, presence-only.
- Wave 2 plans (45-05 init, 45-06 doctor) can import `settingsHasAnthropicKey` from `src/adapter/claude-settings-detector`.
</success_criteria>

<output>
Create `.planning/phases/45-subscription-default-install-billing-leak-warning/45-01-SUMMARY.md` when done. Record the exact exported signature and import path so Wave 2 executors consume it without re-deriving.
</output>
