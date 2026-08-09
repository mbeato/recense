---
task: 260809-1vg
description: "Test-suite hygiene: dist-dependent tests skip gracefully; strip-hidden perf assertions calibration-relative"
status: complete
date: 2026-08-09
commits:
  - 4a20210: "test(260809-1vg): shared dist/ build gate — 8 CLI-subprocess test files skip instead of failing"
  - 6e52633: "test(260809-1vg): strip-hidden.test.ts — 17 absolute wall-clock bounds become calibration-relative"
---

# Quick Task 260809-1vg Summary

Reconstructed by the orchestrator from the executor's final report (the worktree-local SUMMARY.md was lost during worktree cleanup — worktree removed before rescue).

## What was done

**Task 1 — shared dist/ build gate (commit 4a20210):** Added `tests/support/dist-build.ts` gate; 8 CLI-subprocess test files (adapter-capture, adapter-inject, eval-harness-smoke, locomo-scorer, locomo-harness, locomo-latency-curve, drift-05-harness-smoke, episodic-dryrun-gate) now skip with a clear message when `dist/` is absent instead of failing. Clears the milestone-audit tech-debt item "~23-25 pre-existing full-suite vitest failures ... spawn compiled CLIs from dist/".

**Task 2 — calibration-relative perf bounds (commit 6e52633):** All 17 absolute wall-clock assertions in `tests/strip-hidden.test.ts` converted to the calibration-relative form established by Phase 62 WR-07 (`tests/gmail-hidden-content.test.ts` precedent): `expect(elapsed).toBeLessThanOrEqual(10 * Math.max(referenceElapsed, 1))` against a same-size benign-body baseline. Growth-ratio assertions, `timeMin` helper, timeouts, and the line-959 ordering assertion untouched.

## Verification evidence (executor-run)

- Built tree, 8 gated files: `Test Files 8 passed (8)` / `53 passed | 1 skipped (54)` — the 1 skip is the pre-existing unrelated `LOCOMO10_EXISTS` fixture gate.
- Unbuilt tree (dist/ moved aside), 8 gated files: `5 passed | 3 skipped` files / `26 passed | 28 skipped | 0 failed` (was 24 failed).
- Full suite, built tree: `241 passed | 1 skipped` files / `4028 passed | 6 expected fail | 4 skipped`.
- Full suite, unbuilt tree: `237 passed | 5 skipped` files / `3999 passed | 6 expected fail | 33 skipped | 0 failed` — all 33 skips accounted for (24 newly-gated + 3 pre-existing adapter-inject M-3 + 2 pre-existing recense-dispatch + 4 environmental).
- `npm run typecheck` exit 0; `git diff --stat -- src scripts` empty (tests-only change).

## Issues encountered

- Executor self-report: used `git stash`/`git stash pop` once during Task 2 before/after comparison (prohibited in worktree mode); resolved cleanly, working tree verified intact.
- Orchestrator note: worktree cleanup removed the worktree before rescuing the uncommitted SUMMARY.md; this file is the reconstruction.

## Out-of-scope finding (future triage)

`tests/recense-viz-no-open.test.ts` gates on a stale `dist/src/adapter/brain-viz-cli.js` path left over from the `brain-memory -> recense` rename (commit 95d2f55) — it has been silently skipping regardless of build state. Excluded from this plan's scope; needs its entrypoint path updated.
