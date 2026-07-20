---
phase: 50-verification-regression-gates
plan: 04
subsystem: testing
tags: [docs, evals, provenance, judge-fire, gate-03, recon-04]

requires:
  - phase: 50-03
    provides: fresh v9.0-final cheap-axis baseline + fresh EVAL-02 + armed accuracy floors
provides:
  - docs/evals.md v9.0-final results-of-record section with honest fresh-vs-reused provenance
  - Judge-fire validation evidence (368 contradicts vs pre-46 zero) recorded with methodology
  - Deferred-check discharge mapping (RECON-04, pristine KU, PERF-03(b))
affects: [readme-benchmark, v9.0-close, gate-03]

tech-stack:
  added: []
  patterns:
    - "Release-of-record section: per-axis fresh|reused tag + source commit/date + before/after delta"

key-files:
  created: []
  modified:
    - docs/evals.md

key-decisions:
  - "Recorded R@5/R@10 and LoCoMo-J as REUSED (not fresh) — matches 50-03's actual deviation (Phase 47 w=0 null result), corrects the plan's fresh-R@K framing to stay honest"
  - "Marginal write-cost NOT re-measured this phase — stated explicitly (EVAL-04 write ledger still pending)"

patterns-established:
  - "no-inflated-metrics applied to our OWN old runs: every reused number carries source commit+date and a 'reused, not a fresh re-run' label"

requirements-completed: [GATE-03]

duration: ~20min
completed: 2026-06-30
---

# Phase 50 / Plan 04: v9.0-final results of record in docs/evals.md

**`docs/evals.md` now carries a v9.0-final results-of-record section with honest fresh-vs-reused provenance per axis, the 368-contradicts judge-fire evidence, before/after deltas vs v8.0-final, and the three deferred-check discharges — GATE-03 documentation complete.**

## Performance

- **Duration:** ~20 min
- **Tasks:** 1/1
- **Files modified:** 1 (docs/evals.md)

## Task Commits

1. **Task 1: record v9.0-final numbers + provenance + judge-fire evidence** — `26492bd` (docs)

## Accomplishments

- Added a top-level **v9.0-final results-of-record** section (after the intro, surgical — no existing EVAL-01..EVAL-04 section restructured) recording per-axis:
  - **Fresh** (this phase, shipped Haiku/Sonnet stack): EVAL-02 84.6% (8e544f3), latency 20/20 ms, injected_tokens 470.
  - **Reused** (cited source commit + date, marked not-fresh): R@5/R@10 77.3/82.2% (d41d5c8, Jun-24), LoCoMo-J 86.0% (d41d5c8), KU 7/18 (f4de897, Jun-28), judge-fire 368 (f4de897).
- Recorded the **judge-fire validation evidence** (D-08): 368 contradicts across 14 clean cases vs pre-46 zero, with methodology (`queryJudgeEngagement()` over `consolidation_event` `contradict_*` rows, cite 46-02-SUMMARY.md), per-case range 6–47, the 4-case rate-limit conservative-floor note, and the binary `>0` gate form (D-06).
- Documented **before/after deltas** vs the v8.0-final baseline for each axis.
- Added the **deferred-check discharge** table: RECON-04 → fresh EVAL-02; pristine KU re-run (D-15) → reused 46-recon03; PERF-03(b) 3-harness (D-16) → correctness + KU + latency. Noted the gate is on-demand (`npm run gate` / `gate:accuracy`), NOT a CI merge-block (D-01).

## Deviation

- The plan framed LoCoMo R@K as a **fresh** v9.0-final axis. Per the 50-03 deviation (Phase 47 shipped `bm25FusionWeight=0`, a null result → retrieval unchanged), R@K and LoCoMo-J were **reused**, not re-run. Recorded them honestly as reused with provenance — the no-inflated-metrics rule overrides the plan's fresh framing.

## Self-Check: PASSED

- Plan verify grep: `v9.0-final` + `368` + `f4de897` + `RECON-04` + `reused` all present — OK
- Every reused number labeled with source commit + date and "reused, not a fresh re-run" — OK
- Judge-fire evidence + methodology + before/after deltas + 3-deferred-check discharge present — OK
- Surgical: only docs/evals.md changed; no unrelated section restructured — OK
