---
phase: 45-subscription-default-install-billing-leak-warning
plan: 04
type: execute
wave: 1
depends_on: []
files_modified:
  - .planning/phases/45-subscription-default-install-billing-leak-warning/45-04-FINDING.md
autonomous: false
requirements: []
must_haves:
  truths:
    - "It is empirically determined whether the billing leak STILL FIRES with the current --setting-sources project + env-strip in place — by reproduction and observation, not speculation (D-17)"
    - "The finding is recorded with the observed billing/auth path, regardless of outcome; the warn-only deliverable ships either way (D-17)"
    - "No transport hardening is committed — this plan only OBSERVES and RECORDS (D-17, scope fence / deferred ideas)"
  artifacts:
    - path: ".planning/phases/45-subscription-default-install-billing-leak-warning/45-04-FINDING.md"
      provides: "the recorded empirical observation of the billing-leak reproduction"
  key_links:
    - from: "~/.claude/settings.json env.ANTHROPIC_API_KEY"
      to: "claude -p billing/auth path"
      via: "--setting-sources project + childEnv delete of ANTHROPIC_API_KEY in claude-headless-client"
      pattern: "delete childEnv\\['ANTHROPIC_API_KEY'\\]"
---

<objective>
Scientifically resolve the phase's open item (D-17): empirically confirm whether the direct-API billing leak STILL FIRES when `ANTHROPIC_API_KEY` is set in `~/.claude/settings.json`'s env block, given the current `--setting-sources project` + spawn-env `delete ANTHROPIC_API_KEY` safeguards in `src/model/claude-headless-client.ts`.

Purpose: The warn-only design (gate in init, dimension in doctor) ships REGARDLESS of the outcome — it is the safeguard. This investigation determines whether the env-strip is, in practice, a FALSE leak-fix (settings.json re-injects → still bills direct API) or whether some transport flag genuinely suppresses the re-injection. If it genuinely suppresses, that is a bonus real fix to NOTE — but transport hardening is explicitly NOT a committed deliverable of this phase.

Output: a recorded FINDING document under the phase directory capturing the reproduction method, the observed billing/auth path, and the conclusion. NO production code change.
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

<interfaces>
<!-- Read-only context for the reproduction. Do NOT modify these files. -->
src/model/claude-headless-client.ts:11-14  → BILLING SAFEGUARD doc comment (settings.json env-injects the key; spawn env DELETES ANTHROPIC_API_KEY)
src/model/claude-headless-client.ts:139 / :179 → '--setting-sources', 'project' (the self-ingestion guard)
src/model/claude-headless-client.ts:224 / :325 → delete childEnv['ANTHROPIC_API_KEY'] (the env-strip)
The claude -p --output-format json envelope reports per-call `usage` / `total_cost_usd` (CLAUDE.md) — this is the observable billing signal.
</interfaces>
</context>

<tasks>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 1: Reproduce and observe the billing/auth path (D-17)</name>
  <files>.planning/phases/45-subscription-default-install-billing-leak-warning/45-04-FINDING.md</files>
  <read_first>
    - src/model/claude-headless-client.ts:11-14, :139, :179, :224, :325 (the env-strip + --setting-sources project safeguards under test — READ ONLY, do not edit)
    - .planning/phases/45-subscription-default-install-billing-leak-warning/45-CONTEXT.md (the D-17 open-item block + the scope fence + the deferred "transport hardening" item)
    - .planning/STATE.md (Phase 24 "Consolidation stack" note: the prior "billing-leak closed" claim that D-17 is testing)
  </read_first>
  <action>
    OBSERVE-ONLY scientific reproduction — write NO production code. Determine the actual billing/auth path that `claude -p` takes when ANTHROPIC_API_KEY is present in ~/.claude/settings.json's env block under the current `--setting-sources project` + childEnv `delete ANTHROPIC_API_KEY` safeguards. The observable signal is the `claude -p --output-format json` envelope's `usage` / `total_cost_usd` (subscription call vs direct-API spend) plus whatever auth/billing indicator the claude CLI exposes (e.g. a `/status`-style or login-state read). Prepare a SAFE reproduction plan and present it at this checkpoint BEFORE running anything that could bill. SCOPE FENCE (load-bearing): MUST NOT edit ~/.claude/settings.json (detect+warn only) — to observe the key-present case, use the founder's existing state or a throwaway COPY via a temp HOME / RECENSE_CLAUDE_BIN, never mutate the real file; MUST NOT print or record the literal ANTHROPIC_API_KEY value (presence-only, T-45-01); MUST NOT implement transport hardening (deferred) — observe and record only. After founder approval, run the observation and write `.planning/phases/45-subscription-default-install-billing-leak-warning/45-04-FINDING.md` recording (a) the exact reproduction method, (b) whether the leak STILL FIRES (settings.json key → direct-API bill) or `--setting-sources project` + env-strip genuinely suppresses it, (c) the conclusion, and (d) the explicit statement that the warn-only design ships regardless and transport hardening remains deferred.
  </action>
  <what-built>
    Nothing is built — this is a scientific reproduction/observation task. The agent prepares a SAFE, OBSERVE-ONLY reproduction plan and records the actual billing/auth path that `claude -p` takes when ANTHROPIC_API_KEY is present in ~/.claude/settings.json's env block under the current --setting-sources project + childEnv env-strip. The observable signal is the `claude -p --output-format json` envelope's `usage` / `total_cost_usd` (a real, subscription-billed call shows subscription billing; a direct-API call shows API spend) AND whatever auth/billing indicators the claude CLI exposes (e.g. /status, login state, or a deliberately-scoped low-cost probe).

    SAFETY / SCOPE FENCE (load-bearing):
    - This task MUST NOT edit ~/.claude/settings.json (recense detect+warn only). If observing the "key present" case requires the key to be present, OBSERVE the founder's existing state or use a throwaway COPY of settings via RECENSE_CLAUDE_BIN / a temp HOME — never mutate the real file.
    - This task MUST NOT print or paste the actual ANTHROPIC_API_KEY value anywhere in the finding (presence-only, T-45-01).
    - This task MUST NOT implement transport hardening (deferred). It observes and records only.
    - Any reproduction that would incur real API spend requires explicit founder approval at this checkpoint BEFORE running.
  </what-built>
  <how-to-verify>
    1. The agent presents its OBSERVE-ONLY reproduction plan: how it will determine the billing/auth path (which probe, whether it touches a real key, expected cost, how it reads the `--output-format json` usage/total_cost_usd envelope), and confirms it will not edit ~/.claude/settings.json or print the key value.
    2. Founder approves the probe (and any cost) or supplies the observation directly (e.g. "I checked /status, it billed the subscription / it billed the API").
    3. The agent runs the approved observation, captures the billing/auth path, and writes `.planning/phases/45-subscription-default-install-billing-leak-warning/45-04-FINDING.md` recording: (a) the exact reproduction method, (b) the observed outcome — does the leak STILL FIRE (settings.json key → direct-API bill) or does --setting-sources project + env-strip genuinely suppress it, (c) the conclusion, and (d) the explicit statement that the warn-only design ships regardless and transport hardening remains deferred.
    4. Founder confirms the FINDING accurately reflects what was observed.
  </how-to-verify>
  <verify>
    <human-check>FINDING.md records the observed billing/auth path + leak-still-fires yes/no; founder confirms it matches what was observed; `grep -c sk-ant FINDING.md` is 0; `git diff -- ~/.claude/settings.json` is empty; no src/ file modified.</human-check>
  </verify>
  <acceptance_criteria>
    - .planning/phases/45-subscription-default-install-billing-leak-warning/45-04-FINDING.md exists and records: reproduction method, observed billing/auth path, leak-still-fires yes/no, and the "warn-only ships regardless; hardening deferred" conclusion
    - The FINDING does NOT contain the literal ANTHROPIC_API_KEY value (grep the file for `sk-ant` → 0 matches)
    - `git diff -- ~/.claude/settings.json` is empty (the real settings file was not mutated) OR the finding documents that only a throwaway copy/temp-HOME was used
    - No production source file under src/ was modified by this plan
  </acceptance_criteria>
  <done>FINDING.md records the empirical billing/auth observation and leak-still-fires conclusion; founder confirmed; no settings.json mutation, no key value recorded, no src/ change.</done>
  <resume-signal>Type "approved" once the FINDING.md accurately records the observed billing/auth path, or describe what to re-observe.</resume-signal>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| ~/.claude/settings.json → claude -p | the very leak under investigation: a user-owned key in the env block may re-inject into the spawned claude -p auth/billing path |
| investigation → records | the observed result crosses into a recorded finding; the key value must NOT cross |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-45-01 | Information Disclosure | FINDING.md / probe output | mitigate | Never print/record the ANTHROPIC_API_KEY value; finding is presence/path only. Acceptance greps the finding for `sk-ant` → 0. |
| T-45-05 | Tampering | ~/.claude/settings.json during reproduction | mitigate | Observe-only: use founder's existing state or a throwaway copy via temp HOME / RECENSE_CLAUDE_BIN; never edit the real file. Acceptance checks the real file is unmutated. |
| T-45-06 | (cost/spend) | claude -p probe incurring real API spend | mitigate | Blocking human checkpoint approves the probe and any cost BEFORE it runs; prefer a non-billed/low-cost observation. |
| T-45-SC | Tampering | npm installs | accept | No installs; observe-only; audit table N/A. |
</threat_model>

<verification>
- 45-04-FINDING.md exists with the observed billing/auth path and conclusion.
- No src/ file modified; ~/.claude/settings.json unmutated; no key value recorded.
</verification>

<success_criteria>
- D-17 satisfied: the leak question is answered empirically (reproduce + observe), recorded, and the warn-only design's independence from the outcome is stated. Transport hardening remains deferred (not built here).
</success_criteria>

<output>
Create `.planning/phases/45-subscription-default-install-billing-leak-warning/45-04-SUMMARY.md` when done. Summarize the finding's conclusion (leak still fires: yes/no) and confirm no code/settings were changed.
</output>
