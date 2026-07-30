# Deferred Items — Phase 62

Out-of-scope discoveries logged during execution, not fixed (per executor scope boundary).

## 62-07: Missing `dist/` build artifacts break CLI subprocess tests

**Found during:** 62-07 Task 2 full-suite verification.

**Issue:** `npx vitest run` (full suite) shows 23 failures across 7 test files:
`tests/adapter-capture.test.ts`, `tests/adapter-inject.test.ts`,
`tests/episodic-dryrun-gate.test.ts`, `tests/eval-harness-smoke.test.ts`,
`tests/locomo-harness.test.ts`, `tests/locomo-latency-curve.test.ts`,
`tests/locomo-scorer.test.ts`. All spawn compiled CLI binaries from
`dist/src/adapter/*.js` or similar via `spawnSync`/`execSync`; `dist/` does not
exist in this worktree, so every spawn exits 1 before touching application logic.

**Scope check:** None of these files import or reference `strip-hidden.ts` or
`stripHiddenContent`. This worktree simply never ran a build step (`tsc`/`npm run
build`) — pre-existing to this plan's work, not introduced by it.

**Not fixed:** Per scope boundary, out-of-scope failures in unrelated files are
not auto-fixed, and builds are not re-run speculatively to "resolve themselves."

**Action needed (future):** Run the project's build step before executing the
full suite in a fresh worktree, or make these tests skip gracefully when `dist/`
is absent.
