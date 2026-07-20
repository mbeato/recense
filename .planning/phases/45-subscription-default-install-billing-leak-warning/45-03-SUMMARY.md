---
phase: 45-subscription-default-install-billing-leak-warning
plan: "03"
subsystem: docs
tags: [readme, docs, evals, subscription, billing, claude-headless]

requires: []
provides:
  - README Quickstart prereqs restructured: claude CLI + subscription REQUIRED, OpenAI key REQUIRED, Anthropic key OPTIONAL
  - README billing footgun line naming ~/.claude/settings.json ANTHROPIC_API_KEY hazard
  - docs/evals.md staleness note marking headless Haiku/Sonnet as current default stack
affects:
  - 45-05-init-subscription-path
  - 45-06-doctor-billing-and-cli

tech-stack:
  added: []
  patterns:
    - "Honesty constraint pattern: no Anthropic API billing needed (never no keys needed); no env-strip safety claim; recense warns, does not edit"

key-files:
  created: []
  modified:
    - README.md
    - docs/evals.md

key-decisions:
  - "Footgun line placed as blockquote near prereqs (most visible for a fresh reader)"
  - "BYO-keys env block rearranged: OPENAI_API_KEY first/uncommented, ANTHROPIC_API_KEY commented as optional-only"
  - "Staleness note in evals.md placed before the Recorded results table"
  - "Staleness note is additive only -- no historical numbers modified (diff shows +2 insertions)"

requirements-completed: []

duration: 8min
completed: 2026-06-26
---

# Phase 45 Plan 03: Docs Prereqs and Staleness Summary

**README subscription-first prereqs + ~/.claude/settings.json billing footgun warning; evals.md staleness note marking headless Haiku/Sonnet as current default (granite/qwen rows preserved as historical baselines)**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-06-26T19:32:00Z
- **Completed:** 2026-06-26T19:40:08Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Restructured README Prerequisites into Required (claude CLI on subscription + OpenAI key) / Optional (Anthropic key for direct-API mode) with correct copy honesty
- Added billing footgun blockquote naming the exact ~/.claude/settings.json ANTHROPIC_API_KEY env-block hazard
- Reframed BYO-keys env block so OPENAI_API_KEY is the uncommented required key and ANTHROPIC_API_KEY is commented as optional/direct-API-only
- Added additive staleness note in docs/evals.md before the Recorded results table, naming claude-haiku-4-5 (extract) and claude-sonnet-4-6 (judge) via claude -p as current default; historical granite/qwen table rows untouched

## Task Commits

1. **Task 1: README Quickstart prereqs + billing footgun line (D-15)** - fc21087 (docs)
2. **Task 2: docs/evals.md default-stack staleness note (D-16)** - 8232a82 (docs)

## Files Created/Modified

- README.md - Prerequisites restructured (Required/Optional blocks), billing footgun blockquote added, BYO-keys env block reordered
- docs/evals.md - Staleness note added before Recorded results table (additions only; no historical numbers changed)

## Exact text added

README.md footgun line (near Prerequisites):

  Billing footgun: if ANTHROPIC_API_KEY is present in the env block of ~/.claude/settings.json,
  claude -p will bill the Anthropic API directly even on a subscription plan. Remove it from
  that env block to stay on subscription billing. recense doctor will warn you if it detects this.

docs/evals.md staleness note (before Recorded results table):

  Note on the local-stack rows below: the granite4.1:8b + qwen3.6:35b-a3b entries are
  historical baselines from 2026-06-12/13 runs using a local Ollama stack. The current default
  sleep-pass stack (as of 2026-06-17) is headless Haiku/Sonnet on a Claude subscription --
  extract via claude-haiku-4-5, judge via claude-sonnet-4-6, both through claude -p. Local model
  results are preserved as-is for longitudinal comparison; no numbers were recomputed.

## Decisions Made

- Footgun line placed as blockquote immediately after the Optional prereqs list
- BYO-keys env block: OPENAI_API_KEY first and uncommented (required), ANTHROPIC_API_KEY commented with Optional/direct-API-mode-only label
- Staleness note placed as blockquote before the Recorded results header, table rows untouched
- Did not alter "local stack ~25 min, $0 LLM cost" comment in run code block (historical timing note, still accurate)

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None.

## Next Phase Readiness

- D-15 and D-16 satisfied; ROADMAP success criterion 1 (documentation half) is met
- Plans 45-01, 45-02, 45-05, 45-06 can proceed; these docs are the reference copy for the copy/behavior they describe

## Known Stubs

None.

## Threat Flags

None. T-45-04 mitigated: forbidden phrase "no keys needed" absent from README, no env-strip safety claim, no implication recense edits settings.json.

## Self-Check: PASSED

- README.md modified: FOUND (fc21087)
- docs/evals.md modified: FOUND (8232a82)
- "no keys needed" absent from README: grep -ic returns 0 -- PASS
- granite4.1:8b + qwen3.6:35b-a3b still in evals.md: PASS (rows preserved)
- evals.md diff shows additions only: PASS (+2 lines, 0 modifications)

---
*Phase: 45-subscription-default-install-billing-leak-warning*
*Completed: 2026-06-26*
