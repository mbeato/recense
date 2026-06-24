---
phase: 42-token-and-cost-efficiency-audit
plan: "02"
subsystem: eval-harness
tags: [cost, token-efficiency, progressive-disclosure, a-b-harness, COST-04]
depends_on: []
provides:
  - "COST-04 progressive-disclosure A/B harness (LLM-free, $0)"
  - "Measured verdict: challenger-wins-top-k at TOP_K=5 (52.82% reduction)"
affects: []
tech_stack:
  added: []
  patterns:
    - "LLM-free harness: DB readonly + real CLI spawn + chars/4 proxy"
    - "Two-policy bracket: oracle (best-case) + fixed-top-K (realistic)"
    - "D-10 decline path documented in source and result envelope"
key_files:
  created:
    - scripts/eval/42-progressive-disclosure-harness.cjs
    - scripts/eval/results/42-progressive-disclosure-PENDING.json
  modified: []
decisions:
  - "challenger-wins-top-k at TOP_K=5 with important simulation caveats (see below)"
  - "Adopt decision deferred: fidelity gap between recency-proxy simulation and semantic retrieval means the win requires a higher-fidelity follow-on before building the real MCP tool"
metrics:
  duration: "~12 min"
  completed: "2026-06-24"
  tasks_completed: 2
  files_changed: 2
---

# Phase 42 Plan 02: Progressive-Disclosure A/B Harness Summary

COST-04 progressive-disclosure A/B harness built and run LLM-free ($0) against 10,603 live nodes.

## What Was Built

`scripts/eval/42-progressive-disclosure-harness.cjs` — A/B harness comparing:
- **Incumbent**: recense's one-shot bounded SessionStart inject ("schema-prior compression") via real `session-start-cli` spawn
- **Challenger**: simulated two-step progressive disclosure (thin-index glosses → on-demand detail expansion)

Two expansion bracket policies per D-09:
- **Oracle** (best case): expand only 1 of TOP_K nodes — assumes the agent drills into exactly the 1 fact it needs
- **Fixed-top-K** (realistic): expand all TOP_K nodes retrieved in step 1

## COST-04 Verdict: challenger-wins-top-k at TOP_K=5

| Arm | Tokens | vs Incumbent |
|-----|--------|-------------|
| Incumbent (recense one-shot inject) | 496 | — |
| Challenger oracle (expand 1/5) | 149 | -69.96% |
| Challenger fixed-top-5 (expand all 5) | 234 | -52.82% |

**Verdict: `challenger-wins-top-k`**

At TOP_K=10 (sensitivity run): challenger still wins but narrowly at -8.87% on the fixed-top-10 axis.

## Adopt / Decline Call (D-10, D-09)

**DECISION: Decline pending a higher-fidelity follow-on run.**

The measured win is real in the simulation but rests on two fidelity gaps:

1. **Selection proxy mismatch.** The challenger simulation selects TOP_K nodes by `last_access DESC` (recency proxy). The real progressive-disclosure mechanism would select by semantic relevance — the same nodes recense's retrieval engine selects for the inject. A fair comparison requires the challenger to receive the SAME candidate set the incumbent retrieves, not a recency sample.

2. **Short node values in the sample.** The 5 most-recently-accessed nodes had an average of ~92 chars / ~23 tokens each. Recense's real inject draws from semantically ranked candidates, which can be longer (the incumbent used 496 tokens across a budget of 500). If the detail payloads were drawn from the same candidate set, topk_expansion_tokens could easily exceed the incumbent.

**What the numbers do establish:**
- The two-step mechanism is structurally sound at TOKEN counts: thin-index overhead (~119 tok for 5 glosses) is modest, and detail-on-demand caps total cost if the agent only needs 1 hit.
- If recense's budget-capped inject (500 tok ceiling) and progressive disclosure draw from the same candidate set, the realistic case decision hinges on: how many nodes does the agent typically need to expand? At expansion_count=1, challenger wins; at expansion_count≥7 (given current node sizes), challenger likely loses.

**Next step (if warranted):** A higher-fidelity simulation that feeds the challenger the SAME candidate rows the session-start-cli injects, then measures thin-index + full-detail-of-all vs incumbent. If that wins on fixed-top-K, build the real `memory_search` + `memory_expand` MCP tool (D-09).

## Execution Details

- Harness is LLM-free ($0): readonly DB + real session-start-cli spawn + chars/4 proxy
- No engine, MCP, or session-start-cli source file was modified (D-09 harness-only)
- T-26-03 no-secret guard: no credentials written to result JSON or console
- D-10: `incumbent-wins-decline-documented` path is present in source and tested

## Deviations from Plan

None — plan executed as written. Both tasks completed in the expected order. The measured verdict was `challenger-wins-top-k` rather than `incumbent-wins-decline-documented`, but D-10 explicitly treats either outcome as valid. The adopt/decline framing above is the honest interpretation.

## Self-Check: PASSED

| Check | Result |
|-------|--------|
| `scripts/eval/42-progressive-disclosure-harness.cjs` exists | FOUND |
| `scripts/eval/results/42-progressive-disclosure-PENDING.json` exists | FOUND |
| Task 1 commit `7ad0f6c` exists | FOUND |
| Task 2 commit `a414d57` exists | FOUND |
| `git status --porcelain src/` clean | PASS |
| No API keys in result JSON | PASS |
