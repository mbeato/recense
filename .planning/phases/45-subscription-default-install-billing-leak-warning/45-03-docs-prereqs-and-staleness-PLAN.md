---
phase: 45-subscription-default-install-billing-leak-warning
plan: 03
type: execute
wave: 1
depends_on: []
files_modified:
  - README.md
  - docs/evals.md
autonomous: true
requirements: []
must_haves:
  truths:
    - "README Quickstart prereqs state: required = claude CLI logged into a Claude subscription + OpenAI API key; Anthropic API key = optional (direct-API mode only) (D-15, ROADMAP success criterion 1)"
    - "README names the ~/.claude/settings.json ANTHROPIC_API_KEY billing footgun in one line (D-15)"
    - "docs/evals.md notes the current default stack is headless Haiku/Sonnet so the stale granite/qwen references no longer read as current config, WITHOUT rewriting historical baseline numbers (D-16)"
  artifacts:
    - path: "README.md"
      provides: "subscription-first prereqs + footgun line"
      contains: "claude"
    - path: "docs/evals.md"
      provides: "default-stack staleness note"
      contains: "headless"
  key_links:
    - from: "README.md prereqs"
      to: "honesty constraint"
      via: "says 'no Anthropic API billing needed', never 'no keys needed' (OpenAI still required)"
      pattern: "OpenAI"
---

<objective>
Update the docs to match the new subscription-default reality: README prereqs + billing-footgun line (D-15), and a docs/evals.md staleness note on the stale local-stack references (D-16).

Purpose: A fresh reader following the README must end up on the subscription path with the right prereqs (ROADMAP success criterion 1's documentation half), and must be warned about the `~/.claude/settings.json` footgun. The evals doc must stop implying granite/qwen is the current default stack — without falsifying historical baselines.

Output: edited `README.md` (Quickstart prereqs + footgun line) and `docs/evals.md` (staleness note). Prose-only; no code.
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
<!-- Live-located edit sites (grep to confirm before editing). -->
README.md:66  → ## Quickstart
README.md:68  → ### Prerequisites   (the section to rework for D-15)
README.md:115-116 → example env block with ANTHROPIC_API_KEY / OPENAI_API_KEY (reframe Anthropic as optional)

docs/evals.md:256  → "# Recorded 2026-06-12: ~$2 ... (API config); local stack ~25 min" (stale stack context)
docs/evals.md:272-273 → table rows "recense (local: granite4.1:8b + qwen3.6:35b-a3b) ..." (HISTORICAL BASELINE — do NOT rewrite the numbers; add a staleness note nearby)
NOTE: docs/evals.md:392-394 judge-validation rows that name qwen3.6 are also historical evidence — leave untouched.
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: README Quickstart prereqs + billing footgun line (D-15)</name>
  <files>README.md</files>
  <read_first>
    - README.md (the Quickstart section ~:66 and Prerequisites ~:68, plus the example env block ~:115-116 — grep "Prerequisites", "Quickstart", "ANTHROPIC_API_KEY" to confirm live lines)
    - .planning/phases/45-subscription-default-install-billing-leak-warning/45-CONTEXT.md (D-15 + the "Honesty constraints" block)
  </read_first>
  <action>
    In README.md's Quickstart Prerequisites section, restructure the required vs optional prereqs to: REQUIRED — (1) the `claude` CLI installed and logged into a Claude subscription (the default sleep-pass billing path), and (2) an OpenAI API key (still required — used for embeddings; the subscription covers Anthropic only). OPTIONAL — an Anthropic API key, "only needed if you choose direct-API mode instead of subscription billing." Reframe the example env block (~:115-116) so ANTHROPIC_API_KEY is shown as optional/commented for direct-API mode while OPENAI_API_KEY remains required. Add one footgun line (near the prereqs or the install/billing note) naming the exact hazard: if `ANTHROPIC_API_KEY` is present in the `env` block of `~/.claude/settings.json`, `claude -p` will bill the direct API even on a subscription — remove it from that env block. HONESTY CONSTRAINTS (load-bearing, CLAUDE.md + CONTEXT D copy rule): write "no Anthropic API billing needed," NEVER "no keys needed" (OpenAI key is still required); do NOT describe any env-strip as preventing API billing — the warning is the safeguard. recense detects + warns only; do not imply recense edits ~/.claude/settings.json.
  </action>
  <verify>
    <automated>grep -qi "claude" README.md && grep -qi "OpenAI" README.md && grep -qi "settings.json" README.md && grep -ic "no keys needed" README.md | grep -q '^0$' && echo OK</automated>
  </verify>
  <acceptance_criteria>
    - README Prerequisites lists the `claude` CLI logged into a subscription AND an OpenAI API key as REQUIRED
    - README marks the Anthropic API key as OPTIONAL / direct-API-mode-only
    - README contains a single line naming the `~/.claude/settings.json` `ANTHROPIC_API_KEY` direct-API billing footgun
    - `grep -ic "no keys needed" README.md` returns 0 (forbidden phrasing absent)
    - README does NOT claim any env-strip prevents API billing, and does NOT say recense edits ~/.claude/settings.json
  </acceptance_criteria>
  <done>README prereqs are subscription-first with OpenAI still required and Anthropic optional; the settings.json footgun is named in one line; honesty constraints satisfied.</done>
</task>

<task type="auto">
  <name>Task 2: docs/evals.md default-stack staleness note (D-16)</name>
  <files>docs/evals.md</files>
  <read_first>
    - docs/evals.md (grep "granite\|qwen3\|local stack" — the stale-stack lines at ~:256 and the table rows ~:272-273; and the judge-validation rows ~:392-394 which are ALSO historical and must stay)
    - .planning/phases/45-subscription-default-install-billing-leak-warning/45-CONTEXT.md (D-16: "Do not rewrite historical baseline numbers")
  </read_first>
  <action>
    Add a short staleness note in docs/evals.md (near the granite/qwen references around :256/:272-273) clarifying that the CURRENT default sleep-pass stack is headless Haiku/Sonnet on the Max subscription (extract → claude-haiku-4-5, judge → claude-sonnet-4-6, via `claude -p`), and that the `granite4.1:8b + qwen3.6:35b-a3b` references are HISTORICAL local-stack baselines from the dated runs, not the current configuration. DO NOT edit, recompute, or rewrite any historical baseline numbers, percentages, dates, or commit hashes in the table rows (D-16 explicit) — the note is additive context only. Leave the judge-validation rows (~:392-394) untouched. Keep it factual; no inflated claims.
  </action>
  <verify>
    <automated>grep -qi "headless" docs/evals.md && grep -qi "claude-haiku-4-5\|claude-sonnet-4-6\|Haiku/Sonnet" docs/evals.md && grep -q "granite4.1:8b + qwen3.6:35b-a3b" docs/evals.md && echo OK</automated>
  </verify>
  <acceptance_criteria>
    - docs/evals.md contains an additive note stating the current default stack is headless Haiku/Sonnet on subscription
    - The existing `granite4.1:8b + qwen3.6:35b-a3b` historical baseline rows STILL EXIST with their original numbers/dates/commits intact (the note is additive, nothing rewritten)
    - `git diff docs/evals.md` shows only additions (a new note) — no modified digits inside the historical baseline table rows
  </acceptance_criteria>
  <done>Staleness note added marking headless Haiku/Sonnet as the current default; granite/qwen references reframed as historical; no historical numbers altered.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| docs → reader | published copy must not make a false safety claim about API billing (honesty constraint is the live threat surface for this docs plan) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-45-04 | Repudiation/Misrepresentation | README billing/prereq copy | mitigate | Enforce honesty constraints: "no Anthropic API billing needed" never "no keys needed"; never claim env-strip prevents billing; never imply recense edits settings.json. Acceptance grep blocks the forbidden phrase. |
| T-45-SC | Tampering | npm installs | accept | Docs-only plan; no installs; audit table N/A. |
</threat_model>

<verification>
- README grep gates pass; "no keys needed" absent.
- docs/evals.md historical numbers unchanged (git diff shows additions only).
</verification>

<success_criteria>
- D-15/D-16 satisfied: subscription-first prereqs + named footgun in README; staleness note in evals.md without falsifying history.
</success_criteria>

<output>
Create `.planning/phases/45-subscription-default-install-billing-leak-warning/45-03-SUMMARY.md` when done. Quote the exact footgun line added to README and the staleness note added to evals.md.
</output>
