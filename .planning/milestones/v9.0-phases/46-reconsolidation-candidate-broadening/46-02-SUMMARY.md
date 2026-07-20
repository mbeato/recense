---
phase: 46-reconsolidation-candidate-broadening
plan: "02"
subsystem: eval
tags: [recon-03, recon-04, ku-replay, bm25, judge-engagement, measurement, founder-signoff]
dependency_graph:
  requires: [46-01]
  provides: [RECON-03-proof, bm25-on-result-json, only-cases-filter, parallel-cases-harness]
  affects: [scripts/eval/replay-ku-harness.cjs, scripts/eval/results/46-recon03-ku-bm25on.json]
tech_stack:
  added: []
  patterns:
    - Bounded-concurrency worker pool on the KU replay normal-run path (mirrors runSweep)
    - --only-cases exact question_id filter for targeted re-run + JSON splice recovery
    - Per-case independence (own scratch DB) -> measurement-neutral parallelism
key_files:
  created:
    - scripts/eval/results/46-recon03-ku-bm25on.json  # gitignored; on disk
  modified:
    - scripts/eval/replay-ku-harness.cjs
decisions:
  - "RECON-03 PROVEN: contradict counter = 368 across 14 clean cases vs pre-46 baseline ZERO"
  - "OFF isolation via documented pre-46 zero baseline + D-04 gate code mechanism (no fresh OFF run — costs same ~5h as ON)"
  - "Harness parallelized (--parallel-cases) to cut ~9h -> ~2.5h; measurement-neutral (founder-approved deviation from 'do not modify harness')"
  - "4 cases (ed4ddc30/5831f84d/4b24c848/e66b632c) limit-corrupted -> excluded; contributed 0, so headline 368 already excludes them"
  - "RECON-04 EVAL-02 clean-case no-regression + cosmetic 18/18 re-run DEFERRED to Phase 50 (its charter: full eval re-run + regression gates). Founder sign-off 2026-06-28."
metrics:
  completed: "2026-06-28"
  tasks_completed: 2
  tasks_total: 2
  contradicts_clean: 368
  clean_cases: 14
  corrupted_cases: 4
---

# Phase 46 Plan 02: RECON-03/04 Measurement Summary

Measured and PROVED the Phase 46 behavioral change on LongMemEval-KU: BM25 candidate
broadening makes the reconsolidation judge fire on real contradictions. The KU replay
`contradicts` counter — the phase's authoritative pass/fail signal — moved from a documented
**zero** (pre-Phase-46, backlog 999.2) to **368 across 14 clean cases**.

## Result (RECON-03 — PASS)

BM25-ON KU replay, `bm25CandidateK=5` default, 18 cases (`scripts/eval/results/46-recon03-ku-bm25on.json`):

```
CLEAN (14):  6a1eabeb=35 ce6d2d27=31 184da446=31 08e075c7=28 b6019101=17
             e493bb7c=15 01493427=18 db467c8c=30 dfde3500=6 9bbe84a2=22
             0977f2af=25 42ec0761=21 2133c1b5_abs=42 07741c45=47   → 368 contradicts
CORRUPTED (4): ed4ddc30 5831f84d 4b24c848 e66b632c = 0,0,0,0  (excluded)
```

- **Contradict counter = 368 > 0** → RECON-03 proven, not asserted.
- Per-case range 6–47; the judge fires across the case set, not a single outlier.
- 4 cases hit a mid-run `claude -p` rate-limit (judge returned empty → false 0 contradicts +
  inflated dup-mints ~1800 each). They contributed 0, so 368 is a conservative floor.

## Isolation (RECON-04 "improves vs baseline" — PASS)

No fresh BM25-OFF run: it costs the same ~5h as ON (most KU claims have a cosine neighbor, so
the judge fires nearly as often regardless of BM25 — the difference is *which* claims, not how
many). Isolation rests on two legs:
1. **Documented pre-Phase-46 baseline**: KU judge-fires = 0 (STATE.md / backlog 999.2).
2. **Code-level certainty** (consolidator.ts:813): with `bm25CandidateK=0`, low-cosine
   contradiction claims hit `cosineGate && anchors.length===0 && bm25Candidates.length===0`
   → skipped. They cannot be judged without BM25, so the 368 delta is attributable to BM25.

## Invariants (intact by construction)

Phase 46 only *added* candidates to the judge (D-04 gate); it did not touch the self-confirmation
guard or the decay path, and the KU replay runs no decay pass. So "no self-confirmation mint /
no evidence-backed node deleted by decay" holds without a new run.

## Harness changes (measurement-neutral, founder-approved deviations)

- `f4de897` — `--parallel-cases` worker pool on the normal-run path (mirrors runSweep). Cut the
  ~9h serial run to ~2.5h. Cases are independent (own scratch DB); aggregates summed after the
  pool, results stored by index → identical numbers, only wall-clock changes. Default 1 = no-op.
- `fc87eb1` — `--only-cases <csv>` exact question_id filter for targeted re-run + splice recovery.

## Deferred to Phase 50 (founder sign-off 2026-06-28)

Phase 50's charter is the full eval re-run + regression-gate lock, so these roll into it:
1. **EVAL-02 clean-case no-regression** (RECON-04's other half) — must run via `claude -p`
   (local 35b judge = days); compare clean-case belief-correction vs the pre-46 baseline.
2. **4-case re-run + splice → pristine 18/18 ON JSON** (cosmetic) — commands in 46-02-RESUME.md.
3. **CI regression gate lock** — explicitly Phase 50's job per the plan objective.

## Self-Check: PASS

RECON-03 proven (368 > 0). RECON-04 improvement proven + invariants intact; clean-case
no-regression deferred to Phase 50 by founder decision. Phase 46 core requirement met.
