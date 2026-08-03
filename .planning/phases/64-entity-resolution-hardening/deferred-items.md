# Deferred Items — Phase 64

## Plan 64-01

**Pre-existing, out-of-scope test failures observed during full-suite run (`npx vitest run`):**

24 failures across 8 test files, none touching `src/consolidation/consolidator.ts` or intent
classification/resolution code:

- `tests/adapter-capture.test.ts` (6 failures) — stop-cli/turn-capture-cli subprocess tests
- `tests/adapter-inject.test.ts` (5 failures) — session-start-cli subprocess tests
- `tests/episodic-dryrun-gate.test.ts` (1 failure) — CLI flag test
- `tests/eval-harness-smoke.test.ts` (3 failures) — harness subprocess tests
- `tests/locomo-harness.test.ts` (2 failures) — harness subprocess tests
- `tests/locomo-latency-curve.test.ts` (1 failure) — latency-curve.cjs smoke test
- `tests/locomo-scorer.test.ts` (3 failures) — scorer subprocess tests
- `tests/strip-hidden.test.ts` (1 failure) — WR-02 quadratic-growth timing assertion
  (`t256/max(t128,1) <= 8`, observed 10.58 — a timing-sensitive perf gate, likely sandbox/host
  variance, not a correctness regression)

All are CLI-subprocess-spawning or timing/perf-sensitive tests. None import or exercise
`consolidator.ts`'s gmailSourced gate, `ClaimDecision`, or the new
`tests/intent-source-gate.test.ts` file. Last touched by unrelated commits (e.g. `eb402d3`,
well before Phase 64 work began). Per the executor scope-boundary rule, these are logged here
and NOT fixed — out of scope for 64-01.

The plan's own required verification set (typecheck + the 7 named consolidation/intent test
files) all pass green; see `64-01-SUMMARY.md`.

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

## Plan 64-03: pre-existing, out-of-scope test failures

Full-suite run (`npx vitest run`) at the close of 64-03 shows 24 failures across 7 files, same
CLI-subprocess/timing family as 64-01/64-02, none touching `src/consolidation/consolidator.ts`'s
resolution branch or `src/consolidation/entity-resolution.ts`:

- `tests/adapter-capture.test.ts` (8 failures)
- `tests/adapter-inject.test.ts` (5 failures)
- `tests/episodic-dryrun-gate.test.ts` (1 failure)
- `tests/eval-harness-smoke.test.ts` (3 failures)
- `tests/locomo-harness.test.ts` (2 failures)
- `tests/locomo-latency-curve.test.ts` (1 failure)
- `tests/locomo-scorer.test.ts` (3 failures) — plus a fourth intermittent case
  (`meta.sut_config has all 15 D-10 v7.0 knob keys`) observed once in this run's tally

Additionally, `tests/viz-stats-routes.test.ts` showed one failure
(`node_growth.points.length` expected 4, got 3) in the full-suite parallel run but **passed
14/14 in isolation** (`npx vitest run tests/viz-stats-routes.test.ts`) — a day-boundary/clock
timing flake under parallel execution, not a regression from this plan's changes (this plan
never touches viz routes, stats aggregation, or node-growth derivation).

Per the executor's scope-boundary rule, none of the above are fixed in this plan — logged here
instead. The plan's own required verification set (typecheck + the 9 named
consolidation/intent/resolution test files, 118 tests) all pass green; see `64-03-SUMMARY.md`.

## Plan 64-04: pre-existing, out-of-scope test failures

Full-suite run (`npx vitest run`) at the close of 64-04 shows 23 failures across the same 7
CLI-subprocess/timing files as 64-01/64-02/64-03, none touching
`tests/resolution-conservation.test.ts`, `tests/intent-conservation.test.ts`, or any
consolidation/resolution source file:

- `tests/adapter-capture.test.ts` (8 failures)
- `tests/adapter-inject.test.ts` (5 failures)
- `tests/episodic-dryrun-gate.test.ts` (1 failure)
- `tests/eval-harness-smoke.test.ts` (3 failures)
- `tests/locomo-harness.test.ts` (2 failures)
- `tests/locomo-latency-curve.test.ts` (1 failure)
- `tests/locomo-scorer.test.ts` (3 failures)

A second full-suite run in the same session additionally showed `tests/strip-hidden.test.ts`
fail twice on timing assertions (`completes under 1000ms`, `t256/max(t128,1) <= 8`) — confirmed
to **pass 340/340 in isolation** (`npx vitest run tests/strip-hidden.test.ts`), the same
parallel-load timing flake documented for `tests/viz-stats-routes.test.ts` in 64-03's entry
above. Neither `strip-hidden.test.ts` nor this plan's own files share any import or code path.

Per the executor's scope-boundary rule, none of the above are fixed in this plan — logged here
instead. `npm run typecheck` exits 0. The plan's own required verification set (typecheck + the
6 named conservation/resolution test files, 55 tests) all pass green; see `64-04-SUMMARY.md`.
