---
phase: 42-token-and-cost-efficiency-audit
plan: "04"
subsystem: eval-harness
tags: [cost-efficiency, deferred-run, COST-01, COST-02, runbook, ku-gate, no-regression]
dependency_graph:
  requires: [42-01, 42-03]
  provides: [deferred-run-runbook, cost-probe-gate-documented]
  affects:
    - .planning/phases/42-token-and-cost-efficiency-audit/42-DEFERRED-RUN-RUNBOOK.md
tech_stack:
  added: []
  patterns: [deferred-run-documentation, cost-probe-gate, D-06-defer-the-run]
key_files:
  created:
    - .planning/phases/42-token-and-cost-efficiency-audit/42-DEFERRED-RUN-RUNBOOK.md
  modified: []
decisions:
  - "Cost-probe gate decision: defer-to-reset (D-06 honored; weekly subscription limit nearly exhausted 2026-06-24)"
  - "Cheap KU run deferred alongside the expensive battery per 2026-06-24 build-only steer (extended D-06 scope)"
  - "Baseline KU reference: 35-sweep-w0.json scores.ku_score=0.222 (4/18, consolSkipThreshold=0.2)"
  - "D-05 noise band applied in STEP 2 (KU filter) and STEP 4 (LOCOMO/LongMemEval confirm)"
metrics:
  duration: "~5 min"
  completed_date: "2026-06-24"
  tasks_completed: 2
  files_changed: 1
---

# Phase 42 Plan 04: Deferred-Run Runbook Summary

One-liner: runnable four-step deferred-run runbook written (cost-probe hard gate → cheap KU-replay filter → write-side token breakdown → LOCOMO/LongMemEval-S no-regression confirm) with D-05 noise-band accept/reject rule, blocking cost-probe checkpoint documented as defer-to-reset.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Write the deferred-run runbook | d910e9b | `.planning/phases/42-token-and-cost-efficiency-audit/42-DEFERRED-RUN-RUNBOOK.md` (new, 4 ordered steps) |
| 2 | Cost-probe gate checkpoint (documented; decision: defer-to-reset) | (this SUMMARY) | — |

## Cost-Probe Gate Decision

**Decision: defer-to-reset** (Phase-40 D-01, Phase-42 D-06, founder 2026-06-24 build-only steer).

The deferred run battery is NOT executed in this phase. All runs (cheap KU-replay accuracy
validation + full write-side token breakdown + LOCOMO / LongMemEval-S no-regression confirm)
are scheduled for the next weekly subscription reset, after the founder reviews the projected
cost in STEP 1 of the runbook.

**Projected cost (order-of-magnitude, for cost-probe STEP 1 review):**

| Component | Projected tokens | Retail-$ (API-list equiv.) | Cash (subscription) |
|-----------|-----------------|---------------------------|---------------------|
| Write-side breakdown (STEP 3) | ~consol_tokens × 0.12 × N_ep | ~$0.01–0.10 | ≈ $0 |
| KU replay at consolSkipThreshold=0.5 (STEP 2) | embed (18 cases) + judge tokens | ~$0.01–0.05 | ≈ $0 (OpenAI embeds: ~$0.005) |
| LOCOMO-10 confirm (STEP 4a+b) | ~285 tok/QA × 1,540 QA (answer-gen) + gpt-4o-mini judge | ~$0.08 retail (sub) + ~$0.08 direct-API | ~$0 sub + ~$0.08 direct |
| LongMemEval-S confirm (STEP 4c) | 500 Q × embed + answer + judge | ~$0.10–0.30 direct-API | ~$0.10–0.30 direct |

**Subscription marginal ≈ $0** for all headless steps. Direct-API costs (OPENAI_API_KEY for
embeddings and gpt-4o-mini judge) are the actual cash spend — estimated ~$0.20–0.50 total for
the full battery. The cost-probe in STEP 1 of the runbook measures the actual per-episode write
cost before committing to the full run.

## What Was Built

### `.planning/phases/42-token-and-cost-efficiency-audit/42-DEFERRED-RUN-RUNBOOK.md` (new, 281 lines)

Four-step ordered runbook for the deferred reset-window run battery:

- **STEP 1 — Cost-probe HARD GATE:** `cost-benefit-harness.cjs --sample 1` with headless providers
  active. Gives per-episode write-ledger measurement; founder multiplies by skip-adjusted N to
  project total battery cost. Gate covers STEP 2–4 including the cheap KU run. Do not proceed
  until founder approves.

- **STEP 2 — Cheap KU-replay inner-loop accuracy validation:** real run of `replay-ku-harness.cjs`
  at consolSkipThreshold=0.5 using `--config-override-key`/`--config-override-value` flags (built
  in 42-01; always `--dry-run` in 42-01, real run here). Near-$0 but not zero (OPENAI_API_KEY
  for text-embedding-3-small + judge headless tokens). D-05 gate: ku_score must stay within ≤1pt
  of baseline 22.2% (4/18 correct from `35-sweep-w0.json`). Candidates that fail are demoted
  before STEP 3/4 run.

- **STEP 3 — Full write-side token breakdown:** `42-lever-sweep-harness.cjs` at consolSkipThreshold=0.5
  with headless providers active (`measured:true`). Single `--out` flag; per-lever auxiliary files
  land in `path.dirname(--out)` automatically. Records Haiku-extract / Sonnet-judge breakdown —
  the COST-01 deferred deliverable.

- **STEP 4 — Final no-regression confirm:** `locomo-harness.cjs --run` + `locomo-scorer.cjs` +
  `longmemeval-harness.cjs --eval`. Frozen v7.0 baseline (40-BASELINE.md, commit d41d5c8):
  J=86.0%, R@5=77.3%, R@10=82.2%. D-05 accept/reject: ≤1pt noise band on all metrics.

**Key constraints honored:**
- No `--out-dir` flag referenced anywhere in the runbook (the harness has none; grep -c = 0).
- All harness commands are single-line for copy-paste safety (CLAUDE.md hygiene).
- Scratch-DB isolation (VACUUM INTO) and live-db read-only constraint documented in Preconditions.
- No run executed in this plan — documentation only.

## Acceptance Criteria Verification

| Criterion | Status |
|-----------|--------|
| Runbook documents all 4 ordered steps: cost-probe → KU filter → write-side → confirm | PASS |
| STEP 1 states cost-probe is a hard gate covering STEP 2–4 (including the cheap KU run) | PASS |
| STEP 2 cites exact `replay-ku-harness.cjs` REAL-run command (NO `--dry-run`) with `--config-override-key`/`--config-override-value` | PASS |
| STEP 2 notes near-$0-but-not-zero cost (OPENAI_API_KEY embeddings + judge/headless) | PASS |
| STEP 2 states D-05 noise-band gate that demotes failing candidates | PASS |
| STEP 3 cites exact `42-lever-sweep-harness.cjs` invocation with headless providers active | PASS |
| STEP 3 uses single `--out` flag; no directory flag present (grep -c 'out-dir' == 0) | PASS |
| STEP 4 cites LOCOMO + LongMemEval-S commands, v7.0 frozen baseline, D-05 accept/reject | PASS |
| Scratch-DB isolation stated; commands are single-line copy-paste-safe | PASS |
| No run executed (runbook is documentation only) | PASS |
| min_lines ≥ 70 | PASS (281 lines) |

## Deviations from Plan

None — plan executed exactly as written.

The checkpoint task (Task 2) decision recorded as `defer-to-reset` (first option, Phase-40 D-01
and D-06 honored). The deferred run battery — including the cheap KU-replay accuracy validation
— is gated behind the cost-probe in STEP 1 of the runbook.

## Self-Check: PASSED

- `.planning/phases/42-token-and-cost-efficiency-audit/42-DEFERRED-RUN-RUNBOOK.md`: EXISTS (281 lines)
- Task 1 commit `d910e9b`: EXISTS (`git log --oneline -1` verified)
- `grep -c 'out-dir' 42-DEFERRED-RUN-RUNBOOK.md` == 0: CONFIRMED
- All 6 automated verification checks: PASS (exit=0)
- No founder WIP files touched or staged
