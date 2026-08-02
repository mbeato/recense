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
