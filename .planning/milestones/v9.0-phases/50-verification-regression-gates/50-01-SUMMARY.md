---
phase: 50-verification-regression-gates
plan: "01"
subsystem: eval/gate
tags: [gate, regression, deterministic, LLM-free, GATE-01, GATE-02, GATE-03]
dependency_graph:
  requires: []
  provides:
    - scripts/eval/gate-runner.cjs
    - scripts/eval/results/gate-baseline.json
    - npm scripts: gate / gate:baseline / gate:accuracy
  affects:
    - Phase 51 (consumer of npm run gate via D-02)
    - Plan 50-02 (gate:accuracy script pre-wired, target runner deferred)
    - Plan 50-03 (re-records fresh baseline via npm run gate:baseline)
tech_stack:
  added: []
  patterns:
    - CommonJS mode-guard (mirrors locomo-harness.cjs lines 84-98)
    - Fail-closed JSON reads (readJsonSafe + requireKey with nested key path)
    - execSync harness spawning with stdio:inherit
    - gitignore negation via /* glob to allow individual file exception
key_files:
  created:
    - scripts/eval/gate-runner.cjs
    - scripts/eval/results/gate-baseline.json
  modified:
    - package.json
    - .gitignore
decisions:
  - "Override flags (--locomo/--latency/--injection) skip harness execution; comparator is testable against committed result JSONs without API keys"
  - "Baseline read happens before harness execution in --run mode (fail fast on missing baseline)"
  - "contradicts axis always reads frozen JSON (46-recon03-ku-bm25on.json) — never re-runs consolidation (D-06 LLM-free)"
  - ".gitignore changed from trailing-slash form (scripts/eval/results/) to glob form (scripts/eval/results/*) to allow !gate-baseline.json negation exception"
  - "gate-baseline.json seeded from committed result files with honest provenance note; Plan 50-03 re-records fresh numbers"
metrics:
  duration_minutes: 15
  completed_date: "2026-06-30"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 2
---

# Phase 50 Plan 01: Cheap Deterministic Regression Gate Summary

**One-liner:** LLM-free floor/ceiling regression gate over locomo R@5/R@10, latency p50/p95, injected_tokens, and binary judge-fire assertion with fail-closed contract and explicit re-baseline path.

## What Was Built

`scripts/eval/gate-runner.cjs` — a CommonJS gate runner that:
- Refuses to run without `--run` or `--update-baseline` (mode-guard, T-40-03 pattern from locomo-harness.cjs)
- Reads the committed baseline JSON first and fails immediately if missing (fail-closed, T-50-01)
- Collects axis values from harness output or provided override paths
- Compares all axes vs floor/ceiling thresholds from `baseline.thresholds`
- Accumulates a `failures[]` array, prints one `GATE FAIL: <axis> <actual> vs <bound>` line per breach, exits 1 if any failures
- Prints `GATE PASS` and exits 0 when all axes pass
- `--update-baseline` writes a fresh baseline JSON with `meta.recorded_from` provenance and computed thresholds; only measured values allowed (T-50-02)

`scripts/eval/results/gate-baseline.json` — committed v9.0-final baseline schema:
- Seeded from committed result files (locomo-d41d5c8.json, 41-latency-after.json, 46-recon03-ku-bm25on.json) plus injection-efficiency-PENDING.json
- Honest provenance note in meta: pre-Plan-50-03 seed values; Plan 50-03 re-records via `npm run gate:baseline`
- Thresholds: locomo_r5_floor 0.75, locomo_r10_floor 0.80, lat_p95_ceiling_ms 20, injected_tokens_ceiling 470, contradicts_floor 1

`package.json` — three new scripts: `gate`, `gate:baseline`, `gate:accuracy` (all with `npm run build &&` prefix per eval:* convention).

## Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Write cheap deterministic gate runner | 7e70587 | scripts/eval/gate-runner.cjs |
| 2 | Add gate npm scripts + committed baseline schema | 5deb04b | package.json, scripts/eval/results/gate-baseline.json, .gitignore |

## Verification Results

All acceptance criteria verified:
- `node -c scripts/eval/gate-runner.cjs` → SYNTAX OK
- No-flags invocation → prints Usage and exits non-zero (mode-guard)
- `--run --baseline /no/such/baseline.json` → GATE FAIL (fail-closed)
- `--contradicts` JSON with `total_contradicts: 0` → GATE FAIL: total_contradicts 0 < floor 1
- `--locomo` with r5=0.773 vs floor 1.1 → GATE FAIL: locomo_r5 0.7727... < floor 1.1
- All committed result JSONs vs committed baseline thresholds → GATE PASS
- npm scripts: gate / gate:baseline / gate:accuracy all present
- baseline JSON: contradicts_floor === 1, meta.recorded_from present

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocker] .gitignore blocking gate-baseline.json commit**
- **Found during:** Task 2 staging
- **Issue:** `.gitignore` had `scripts/eval/results/` (trailing slash form), which ignores the directory and blocks negation rules. `git add scripts/eval/results/gate-baseline.json` failed.
- **Fix:** Changed to `scripts/eval/results/*` (content-glob form) and added `!scripts/eval/results/gate-baseline.json` negation. Previously-tracked result files remain ignored; only gate-baseline.json is newly allowed.
- **Files modified:** `.gitignore`
- **Commit:** 5deb04b

## Known Stubs

None. The gate-baseline.json contains real measured values seeded from committed result files. No placeholder scores. The `injected_tokens: 427` value is from `injection-efficiency-PENDING.json` (recorded 2026-06-14 at commit a87e799), which was untracked at time of seed; `meta.note` documents this and directs re-recording via Plan 50-03.

## Threat Surface Scan

No new network endpoints, auth paths, or trust-boundary changes introduced. The gate reads only local filesystem files (committed JSONs). The `--update-baseline` path writes only to the provided `--baseline` path (default: `scripts/eval/results/gate-baseline.json`). No new dependencies added (T-50-SC: net-zero invariant satisfied).

## Self-Check: PASSED

- scripts/eval/gate-runner.cjs: EXISTS (308 lines, 7e70587)
- scripts/eval/results/gate-baseline.json: EXISTS (committed, 5deb04b)
- package.json gate scripts: EXISTS (node -e require validation passed)
- git log d30d756..HEAD --oneline: 2 commits (7e70587, 5deb04b)
