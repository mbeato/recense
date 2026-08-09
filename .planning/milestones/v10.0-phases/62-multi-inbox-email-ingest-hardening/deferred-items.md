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

## 62-30: flaky absolute wall-clock assertion in tests/strip-hidden.test.ts (WR-02 report shape)

**Found during:** 62-30 Task 3 full-suite verification (`npx vitest run`, all files in parallel).

**Issue:** `tests/strip-hidden.test.ts > stripHiddenContent — WR-02: the
62-VERIFICATION.md adversarial shape must not be quadratic > the report shape
growth from 128 KB to 256 KB stays polynomial (t256/max(t128,1) <= 8)` failed
once under full-suite parallel load (`9.83 <= 8` assertion, actual ratio 9.83)
and passed immediately when re-run in isolation (`npx vitest run
tests/strip-hidden.test.ts -t "128 KB to 256 KB"`). This is an absolute
wall-clock growth-ratio assertion — the exact WR-07 flakiness pattern this
plan's Task 3 closed for `tests/gmail-hidden-content.test.ts` and
`tests/html-parser-conformance.test.ts` — but `tests/strip-hidden.test.ts` is
not in 62-30-PLAN.md's `files_modified` and this specific assertion (128 KB vs
256 KB growth ratio, unrelated to CR-02's `<`-run family) is not named in
WR-07's finding.

**Scope check:** Not caused by this plan's changes (this describe block and
assertion are untouched by 62-30); reproducibly passes in isolation, only
flakes under full-suite parallel CPU contention.

**Not fixed:** Per scope boundary, out-of-scope flakiness in a file this plan
does not own is not auto-fixed.

**Action needed (future):** Apply the same calibration-relative treatment
WR-07/62-30 Task 3 established to this assertion (and audit
`tests/strip-hidden.test.ts`'s other absolute-threshold cost-bound tests for
the same risk) in a future plan that owns that file.
