# Deferred Items — Phase 63

Out-of-scope discoveries found during plan execution, not fixed (per scope-boundary rule).

## Plan 01 (2026-08-02)

**23 pre-existing test failures across 7 files** — unrelated to `src/model/claim-extractor.ts` /
`tests/claim-extractor-intent.test.ts` (the only files this plan touched). Root cause: these
tests spawn compiled CLI binaries from `dist/` (e.g. `tests/adapter-capture.test.ts` spawns
`dist/turn-capture-cli.js` via `spawnSync`), and `dist/` does not exist in this fresh worktree
(no `npm run build` has run). Confirmed unrelated by inspecting the spawn target and the
absence of `dist/`.

Files affected: `tests/adapter-capture.test.ts`, `tests/adapter-inject.test.ts`,
`tests/episodic-dryrun-gate.test.ts`, `tests/eval-harness-smoke.test.ts`,
`tests/locomo-harness.test.ts`, `tests/locomo-latency-curve.test.ts`, `tests/locomo-scorer.test.ts`.

Not fixed — out of scope for this plan (no `dist/` build step is part of 63-01's task list).
Both plan-scoped test files (`tests/claim-extractor-intent.test.ts`,
`tests/claim-extractor-temporal.test.ts`) pass; full-suite pass count otherwise unaffected
(3352 passed / 6 expected-fail / 9 skipped besides the 23 pre-existing dist-dependent failures).
