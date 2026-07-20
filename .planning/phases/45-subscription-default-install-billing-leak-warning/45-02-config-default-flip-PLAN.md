---
phase: 45-subscription-default-install-billing-leak-warning
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - src/lib/config.ts
  - tests/sleep-pass-provider.test.ts
autonomous: true
requirements: []
must_haves:
  truths:
    - "DEFAULT_CONFIG.modelProvider is 'claude-headless' so a fresh install uses subscription billing by default (D-01, ROADMAP success criterion 1)"
    - "The config doc comment reflects subscription-as-default, not the stale 'opt-in via env ONLY, default unchanged' / 'ZERO behavior change' claims (D-02)"
    - "Every test/code path that assumed the 'anthropic' default is reconciled and the full provider-resolution suite passes (D-03)"
  artifacts:
    - path: "src/lib/config.ts"
      provides: "DEFAULT_CONFIG.modelProvider = 'claude-headless' + updated comment"
      contains: "claude-headless"
    - path: "tests/sleep-pass-provider.test.ts"
      provides: "reconciled assertions for the new default"
  key_links:
    - from: "src/lib/config.ts DEFAULT_CONFIG.modelProvider"
      to: "resolveModelId / resolveProviderOverlay"
      via: "resolved-by-default branch (claudeHeadlessModel for extract/judge already correct)"
      pattern: "modelProvider:\\s*'claude-headless'"
---

<objective>
Flip the in-code sleep-pass default from direct-API to subscription billing (D-01), fix the now-stale comment (D-02), and reconcile the test fallout by grep-not-guess (D-03).

Purpose: This is the load-bearing behavior change of the phase — ROADMAP success criterion 1 ("a fresh recense init defaults to subscription billing"). The per-role headless models already resolve correctly; only the default constant and its documentation/test fallout change.

Output: `config.ts` default = `'claude-headless'` with truthful comment; reconciled `tests/sleep-pass-provider.test.ts`; green full test suite.
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
<!-- Live-verified line numbers (grep before editing — planning docs drift). -->
config.ts:757  →  modelProvider: 'anthropic',            // the default to flip → 'claude-headless'
config.ts:766-767 → claudeHeadlessModel/claudeHeadlessJudgeModel already correct — DO NOT TOUCH
config.ts:131  →  comment "Default 'anthropic' = ZERO behavior change."  (stale)
config.ts:136  →  comment "opt-in via env ONLY, default unchanged."       (stale)

sleep-pass-provider.test.ts:21  → expect(overlay.modelProvider).toBe('anthropic');   (the canonical break — unset env → DEFAULT_CONFIG default)
sleep-pass-provider.test.ts lines that set RECENSE_MODEL_PROVIDER='anthropic' explicitly (e.g. :83/:87, :148/:151) do NOT depend on the default — verify, don't blindly edit.

resolveModelId (src/model/anthropic-client.ts) already branches on 'claude-headless' → no change needed there.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Flip the default and update the stale comment (D-01, D-02)</name>
  <files>src/lib/config.ts</files>
  <read_first>
    - src/lib/config.ts (grep `modelProvider:` to confirm the live default line — PATTERNS says :757; grep `ZERO behavior change` and `opt-in via env ONLY` to confirm the comment lines — PATTERNS says :131/:136; live source wins per CLAUDE.md)
    - .planning/phases/45-subscription-default-install-billing-leak-warning/45-PATTERNS.md (the config.ts section, "DEFAULT_CONFIG default to flip" + "Stale comment to update")
  </read_first>
  <action>
    In src/lib/config.ts change the DEFAULT_CONFIG `modelProvider` value from `'anthropic'` to `'claude-headless'` (the single default-constant line, ~:757). Do NOT touch the type union at ~:139, and do NOT touch `claudeHeadlessModel`/`claudeHeadlessJudgeModel` at ~:766-767 — those are already correct (extract→claude-haiku-4-5, judge→claude-sonnet-4-6 resolve correctly under the headless provider). Update the two stale comment lines: replace "Default 'anthropic' = ZERO behavior change." (~:131) and the clause "opt-in via env ONLY, default unchanged" (~:136) so they state the new reality: `'claude-headless'` is now the subscription-billed DEFAULT (spike 003 / QUICK-260617-qat) — `claude -p` on the founder's Max subscription; direct-API ('anthropic') is now opt-in via RECENSE_MODEL_PROVIDER. HONESTY CONSTRAINT (CLAUDE.md / D copy rule): the comment may say subscription covers Anthropic billing for the sleep pass; it must NOT claim "no keys needed" (OpenAI key is still required for embeddings) and must NOT describe any env-strip as preventing API billing.
  </action>
  <verify>
    <automated>grep -nE "modelProvider:\s*'claude-headless'" src/lib/config.ts && grep -c "opt-in via env ONLY, default unchanged" src/lib/config.ts | grep -q '^0$' && echo OK</automated>
  </verify>
  <acceptance_criteria>
    - `grep -nE "modelProvider:\s*'claude-headless'" src/lib/config.ts` matches the DEFAULT_CONFIG line
    - `grep -c "opt-in via env ONLY, default unchanged" src/lib/config.ts` returns 0 (stale clause gone)
    - `grep -c "ZERO behavior change" src/lib/config.ts` returns 0 (stale clause gone)
    - The type union line (modelProvider: 'anthropic' | 'vertex' | ...) is UNCHANGED
    - claudeHeadlessModel / claudeHeadlessJudgeModel values are UNCHANGED
    - The updated comment contains no "no keys needed" phrasing and no claim that an env-strip prevents API billing
  </acceptance_criteria>
  <done>DEFAULT_CONFIG.modelProvider === 'claude-headless'; both stale comment clauses replaced with truthful subscription-default copy; per-role models untouched.</done>
</task>

<task type="auto">
  <name>Task 2: Grep-and-reconcile the 'anthropic'-default fallout (D-03)</name>
  <files>tests/sleep-pass-provider.test.ts</files>
  <read_first>
    - tests/sleep-pass-provider.test.ts (lines 1-30 — the "unset env → DEFAULT_CONFIG provider" test at :17-24 whose :21 hard-asserts toBe('anthropic'); and the explicit-set tests at :81-87 / :148-165 / :223-226 that set RECENSE_MODEL_PROVIDER='anthropic' themselves)
    - .planning/phases/45-subscription-default-install-billing-leak-warning/45-PATTERNS.md ("Fallout to fix (D-03 — grep, don't guess)" list)
  </read_first>
  <action>
    First, grep the whole repo for stale-default assumptions before editing: run `grep -rn "toBe('anthropic')\|=== 'anthropic'\|default.*anthropic\|anthropic.*default" src tests` and triage each hit. Reconcile ONLY assertions that depend on the DEFAULT (unset/unknown env → DEFAULT_CONFIG.modelProvider). The canonical break is tests/sleep-pass-provider.test.ts:21 (`expect(overlay.modelProvider).toBe('anthropic');` inside the "unset env → DEFAULT_CONFIG provider" test): change the literal to `'claude-headless'` (or assert it equals DEFAULT_CONFIG.modelProvider only). Also fix the test-suite comment at ~:9 ("unknown value → falls back to DEFAULT_CONFIG.modelProvider (fail safe)") if it names 'anthropic' as the fallback. Do NOT change the tests at :83/:87, :148/:151, :158/:165, :223/:226 — they explicitly SET RECENSE_MODEL_PROVIDER='anthropic' and assert the explicitly-set value, so they are independent of the default; verify each by reading the test body. For src/adapter/backfill-subjects-cli.ts:85, the comment already says "(claude-headless)" — leave as-is. Do NOT touch the doctor API-key check (handled in 45-06 under D-11). After edits, run the full vitest suite to catch any other path that silently assumed the old default.
  </action>
  <verify>
    <automated>npx vitest run tests/sleep-pass-provider.test.ts && npx vitest run 2>&1 | tail -5</automated>
  </verify>
  <acceptance_criteria>
    - `npx vitest run tests/sleep-pass-provider.test.ts` exits 0
    - The "unset env → DEFAULT_CONFIG provider" test asserts 'claude-headless' (or only `=== DEFAULT_CONFIG.modelProvider`), not 'anthropic'
    - Tests that explicitly set RECENSE_MODEL_PROVIDER='anthropic' are UNCHANGED and still pass
    - Full `npx vitest run` reports no NEW failures attributable to the default flip (any remaining failures must be unrelated/pre-existing and named in the SUMMARY)
    - No edit was made to src/adapter/recense-doctor.ts in this plan (D-11 is 45-06's job)
  </acceptance_criteria>
  <done>Provider-resolution suite green under the new default; only default-dependent assertions changed; explicit-provider tests untouched; full suite confirms no other stale-default path.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| (none new) | This plan changes an in-process default constant + a test + comments; no new input, file, or network boundary is introduced. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-45-03 | Information Disclosure | config.ts comment copy | mitigate | Comment must not claim "no keys needed" or that an env-strip prevents API billing (honesty constraint). Acceptance grep + review enforces truthful copy. |
| T-45-SC | Tampering | npm installs | accept | No package installs in this plan; audit table N/A. |
</threat_model>

<verification>
- `npx vitest run tests/sleep-pass-provider.test.ts` exits 0.
- `npx vitest run` full suite reports no new failures from the flip.
- `npx tsc --noEmit` clean.
</verification>

<success_criteria>
- D-01/D-02/D-03 satisfied: default flipped, comment truthful, fallout reconciled by grep.
- ROADMAP success criterion 1 (in-code half): a fresh config resolves to subscription billing by default.
</success_criteria>

<output>
Create `.planning/phases/45-subscription-default-install-billing-leak-warning/45-02-SUMMARY.md` when done. List every file the grep triage touched and every stale-default hit deliberately left unchanged (with reason).
</output>
