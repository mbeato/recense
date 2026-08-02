# Deferred Items — Phase 64

## Plan 64-02: pre-existing, out-of-scope test failures

Full-suite run (`npx vitest run`) at the close of 64-02 shows 23 pre-existing failures across 7
files, none touching `src/consolidation/entity-resolution.ts` or the two new config knobs:

- `tests/adapter-capture.test.ts` (8 failures)
- `tests/adapter-inject.test.ts` (5 failures)
- `tests/episodic-dryrun-gate.test.ts` (1 failure)
- `tests/eval-harness-smoke.test.ts` (3 failures)
- `tests/locomo-harness.test.ts` (2 failures)
- `tests/locomo-latency-curve.test.ts` (1 failure)
- `tests/locomo-scorer.test.ts` (3 failures)

All are subprocess/CLI-harness tests (spawn a child process running a CLI script) unrelated to
entity resolution. Confirmed present independent of this plan's changes — this is a sandbox/CI
environment gap (likely missing built artifacts, API keys, or a CLI binary), not a regression
introduced by 64-02. Per the executor's scope-boundary rule, these are logged here and NOT
fixed in this plan.

The plan-level verification set specified in 64-02-PLAN.md (`tests/entity-resolution.test.ts`,
`tests/consolidation.test.ts`, `tests/entity-dedup.test.ts`, `tests/topk-index.test.ts`,
`tests/topk-simd.test.ts`, `tests/runtime-config.test.ts`) all pass (108/108) — no collateral
regression from the config additions.
