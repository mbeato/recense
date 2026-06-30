---
phase: 50-verification-regression-gates
plan: 02
subsystem: testing
tags: [eval, gate, accuracy, locomo, belief-correction, ku, llm-gate, paid-tier]

# Dependency graph
requires:
  - phase: 50-verification-regression-gates
    provides: "gate-baseline.json accuracy floors (written by 50-03)"
provides:
  - "scripts/eval/gate-accuracy-runner.cjs — opt-in paid accuracy-tier gate (GATE-02 accuracy axes)"
  - "Mode-guarded, hard-key-guarded orchestrator for EVAL-02 + LoCoMo-J + KU accuracy harnesses"
affects: [50-03, 50-04, npm-gate-scripts]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Mode-guard pattern (locomo-harness.cjs) applied to accuracy runner — no-mode = usage + exit 1"
    - "Hard key-guard (correctness-harness.cjs lines 77-86) always required for --run, no dry-run escape"
    - "Static cost probe (--probe) for pre-run estimation without actual LLM spend"
    - "Floor comparison with SKIP notice for missing baseline keys (fail-closed, never fail-open)"

key-files:
  created:
    - scripts/eval/gate-accuracy-runner.cjs
  modified: []

key-decisions:
  - "Static cost probe in --probe mode (no live LLM call): honest estimate from known per-run token ranges vs. spawning a live probe sub-process that would require dataset files not guaranteed to be present"
  - "Fail-closed on missing baseline floor: SKIP notice (informational) rather than auto-pass or auto-fail, honoring the plan's explicit no-silent-skip requirement"
  - "D-03 separation enforced by assertion: gate-accuracy-runner.cjs never spawns or requires gate-runner.cjs"

patterns-established:
  - "Pattern: accuracy-gate orchestration — spawn sub-harnesses via spawnSync, read JSON output, compare vs baseline floors"

requirements-completed: [GATE-01, GATE-02]

# Metrics
duration: 15min
completed: 2026-06-30
---

# Phase 50 Plan 02: Verification + Regression Gates — Accuracy Tier Summary

**Opt-in paid accuracy-tier gate (`npm run gate:accuracy`) wrapping EVAL-02 belief-correction, LoCoMo-J headline, and KU finish-78 behind a hard key-guard and a static cost probe, comparing axes against baseline floors from gate-baseline.json.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-06-30T00:00:00Z
- **Completed:** 2026-06-30T00:15:00Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments

- Created `scripts/eval/gate-accuracy-runner.cjs` (305 lines, CommonJS strict mode)
- Mode-guard: no flags -> usage + exit 1, preventing accidental invocation (T-50-03)
- Hard key-guard: `--run` requires both ANTHROPIC_API_KEY and OPENAI_API_KEY, exits non-zero with clear error (T-50-04)
- `--probe`: static cost/token estimate for all three axes, exits 0 without touching any LLM
- `--run` orchestration: spawns correctness-harness, locomo-harness+scorer, replay-ku-harness; reads JSON output; compares against baseline accuracy floors
- Missing baseline floor -> explicit SKIP notice (not a pass, never fail-open)
- D-03 separation: file contains no spawn/require of gate-runner.cjs

## Task Commits

1. **Task 1: Write the opt-in accuracy-tier gate runner** - `cafcf61` (feat)

## Files Created/Modified

- `scripts/eval/gate-accuracy-runner.cjs` — Opt-in paid accuracy-tier gate orchestrating EVAL-02, LoCoMo-J, and KU axes with mode-guard, hard key-guard, cost probe, and floor comparison

## Decisions Made

- Static cost probe: the `--probe` mode prints static estimates rather than spawning a live sub-process probe, because dataset files (locomo10.json, eval cache) are not guaranteed present and the locomo-harness.cjs `--probe` already covers LoCoMo-J specifically. Honest token ranges derived from observed per-run costs.
- Fail-closed on absent baseline floor: the plan explicitly requires SKIP + notice (informational-only) rather than treating absence as pass or fail. This matches T-50-04 (never fail-open silently).
- spawnSync with stdio: inherit so sub-harness output streams directly to the user during long paid runs, same UX as running each harness directly.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

External API keys are required to run `--run` mode:
- `ANTHROPIC_API_KEY` — Haiku 4.5 (extract) + Sonnet 4.6 (judge) via claude -p subscription transport
- `OPENAI_API_KEY` — gpt-4o-mini (LoCoMo-J scoring) + text-embedding-3-small (KU)

Use `--probe` first to review the cost/token estimate before committing to a full run.

## Next Phase Readiness

- 50-03 writes accuracy floors into gate-baseline.json (`eval02_floor`, `locomo_j_floor`, `ku_floor`) — when present, the `--run` gate will enforce them instead of printing SKIP
- 50-01 (gate-runner.cjs) and 50-02 (gate-accuracy-runner.cjs) are fully independent (Wave 1 parallel execution)
- `npm run gate:accuracy` script still needs to be added to package.json (covered by whichever plan handles scripts)

## Self-Check: PASSED

- `scripts/eval/gate-accuracy-runner.cjs` exists: FOUND
- Commit cafcf61 exists: FOUND
- `node -c` syntax check: PASSED
- Mode-guard (no flags): exits 1, prints usage: VERIFIED
- Key-guard (`--run` without keys): exits non-zero with clear error: VERIFIED
- `--probe`: exits 0, prints cost estimate: VERIFIED
- No reference to gate-runner.cjs spawn/require: CONFIRMED

---
*Phase: 50-verification-regression-gates*
*Completed: 2026-06-30*
