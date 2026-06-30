---
phase: 50-verification-regression-gates
plan: 03
subsystem: testing
tags: [eval, regression-gate, locomo, eval-02, belief-correction, ku, provenance]

requires:
  - phase: 50-01
    provides: gate-runner.cjs --update-baseline + gate-baseline.json scaffold + npm scripts
provides:
  - Fresh v9.0-final cheap-axis gate baseline (latency/injection measured, R@K reused with provenance)
  - Fresh EVAL-02 n=13 belief-correction number (RECON-04 discharged, no regression)
  - Armed accuracy-tier floors (eval02/locomo_j/ku) so npm run gate:accuracy enforces, not SKIPs
affects: [50-04, phase-51, evals-docs]

tech-stack:
  added: []
  patterns:
    - "Cheap gate reads RECORDED R@K via --locomo override; fresh re-ingest is a deliberate (rare) action, not the default"
    - "accuracy_floor_provenance: explicit fresh-vs-reused anchor map per floor (no-inflated-metrics)"

key-files:
  created:
    - scripts/eval/results/correctness-v90final.json
  modified:
    - scripts/eval/results/gate-baseline.json
    - package.json
    - .gitignore

key-decisions:
  - "Reused recorded LoCoMo R@K (0.773/0.822) instead of a 3-4h re-ingest — Phase 47 shipped bm25FusionWeight=0 (null result), so retrieval is unchanged; consistent with D-13 (no multi-hour re-run)"
  - "Fixed GATE-01 defect: npm run gate / gate:baseline re-ingested all 10 LoCoMo conversations (Haiku, subscription-billed) every run, breaking the cheap/on-demand/$0 premise — now pass --locomo to read recorded R@K"
  - "eval02_floor anchored to the FRESH Task-2 run; locomo_j_floor and ku_floor anchored to REUSED recorded runs, marked as such in meta.accuracy_floor_provenance"

patterns-established:
  - "Floor convention: floor = recorded value − 0.05 epsilon, applied uniformly to cheap and accuracy axes"
  - "Honest provenance: recorded_from + accuracy_floor_provenance name each axis's source file + commit/date; reused numbers never presented as fresh"

requirements-completed: [GATE-02, GATE-03]

duration: ~90min (incl. one killed 3-4h re-ingest + investigation)
completed: 2026-06-30
---

# Phase 50 / Plan 03: Record genuine v9.0-final numbers + arm accuracy floors

**The v9.0-final gate baseline now holds honestly-measured numbers (fresh latency/injection + reused-with-provenance R@K), RECON-04 is discharged with a fresh 84.6% belief-correction (no regression), and all three accuracy-tier floors are armed so `npm run gate:accuracy` enforces rather than silently SKIPs.**

## Performance

- **Duration:** ~90 min (Task 1 ~5 min after a killed 3-4h re-ingest + root-cause investigation; Task 2 ~25 min EVAL-02; Task 3 ~5 min)
- **Tasks:** 3/3
- **Files modified:** 4 (1 created)

## Task Commits

1. **Deviation: gate scripts read recorded R@K** — `8d3f3bf` (fix)
2. **Task 1: record fresh v9.0-final cheap-axis baseline** — `8e544f3` (feat)
3. **Task 2: fresh EVAL-02 (n=13), discharge RECON-04** — `51bb7e2` (feat)
4. **Task 3: arm accuracy-tier floors (close GATE-02)** — `1105803` (feat)

## Accomplishments

- **Fresh cheap-axis baseline** (`gate-baseline.json`): latency p50/p95 = 20/20 ms and injected_tokens = 470 measured on the live 15.3k-node brain; R@5/R@10 = 0.773/0.822 reused from `locomo-d41d5c8.json`; total_contradicts = 368 frozen. `npm run gate` is GATE PASS.
- **RECON-04 discharged**: fresh EVAL-02 belief-correction = **84.6%** (post-46–48, commit 8e544f3) — identical to the pre-46 f779bfb baseline → no regression. Pre-46 PENDING run preserved as the delta reference.
- **Accuracy tier armed**: eval02_floor 0.796 / locomo_j_floor 0.8104 / ku_floor 0.339 written into `thresholds`; `gate-accuracy-runner.cjs` now enforces (PASS/FAIL) all three axes instead of `SKIP`.

## Deviations (significant)

1. **GATE-01 "cheap gate" was not cheap (fixed).** `runLocomoAxis()` spawns `locomo-harness --run --retrieval-only`, which **re-ingests all 10 LoCoMo conversations through the full consolidation pipeline** (Haiku extraction per turn, subscription-billed) — ~17-25 min/conversation, ~3-4h total — on *every* `npm run gate`. The plan conflated "LLM-free judge" (true: retrieval-only skips the answer judge) with "cheap/fast" (false: the ingest is the cost). Fix: point the `gate`/`gate:baseline` npm scripts at the recorded `locomo-d41d5c8.json` via the existing `--locomo` override; only latency+injection (live `.vindex`, seconds) run fresh.

2. **R@K re-run premise was wrong (reused instead).** The plan said "Phase 47 changed hybrid retrieval, so R@K MUST be re-recorded fresh." Phase 47 actually shipped `bm25FusionWeight = 0` — a documented **null result** (pure cosine, retrieval unchanged). The recorded R@K is therefore the v9.0-final R@K; a fresh ingest would reproduce it. Reuse is consistent with 50-03's own D-13 (no multi-hour re-run). Founder-approved.

3. **gitignore exception added.** 50-01 had broadened the ignore to `scripts/eval/results/*` (negating only `gate-baseline.json`), which would have ignored the `correctness-v90final.json` evidence artifact. Added `!scripts/eval/results/correctness-v90final.json` to keep the dated result of record tracked (matches the existing exception pattern).

## Self-Check: PASSED

- `node -e` floor verify: eval02_floor/locomo_j_floor/ku_floor numeric + provenance present — OK
- Cheap-axis floors + scores block unchanged after the accuracy-floor edit — OK
- gate-baseline.json valid JSON — OK
- `gate-accuracy-runner.cjs` SKIP guards key off exactly these three floor names (static confirm; paid harnesses not run) — OK
- `npm run gate` → GATE PASS, exit 0 — OK

## Notes for downstream (50-04)

- v9.0-final numbers to record in docs/evals.md: R@5 0.773 / R@10 0.822 (reused, Jun-24, pure-cosine), latency 20/20 ms (fresh), injected_tokens 470 (fresh), EVAL-02 84.6% (fresh, no regression vs pre-46 84.6%), contradicts 368 (frozen), KU 0.389=7/18 (reused), LoCoMo-J 0.8604 (reused). Carry honest fresh-vs-reused provenance for each.
