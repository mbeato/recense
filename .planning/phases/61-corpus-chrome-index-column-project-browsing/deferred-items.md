# Deferred Items — Phase 61

Out-of-scope discoveries logged here per the executor scope-boundary rule (not fixed).

## 61-08

**Full-suite pre-existing failures (unrelated to this plan's files).** Running the full `npx
vitest run` suite after 61-08's changes shows 23 failures across 7 test files, none of which
touch `src/viz/server.ts`, `src/viz/modules/corpus.js`, or `tests/viz-index-route.test.ts`
(the only files this plan modified):

- `tests/adapter-capture.test.ts` (8 failures)
- `tests/adapter-inject.test.ts` (5 failures)
- `tests/episodic-dryrun-gate.test.ts` (1 failure)
- `tests/eval-harness-smoke.test.ts` (3 failures)
- `tests/locomo-harness.test.ts` (2 failures)
- `tests/locomo-latency-curve.test.ts` (1 failure)
- `tests/locomo-scorer.test.ts` (3 failures)

These are CLI-subprocess / eval-harness tests unrelated to the viz corpus surface this plan
touches. `npx tsc --noEmit`, `tests/viz-index-route.test.ts` (20/20), and
`tests/viz-corpus-graph.test.ts` (27/27) — the plan's own verification targets — all pass
clean. Out of scope for 61-08; not investigated or fixed.

## 61-17

**Same pre-existing full-suite failures re-confirmed.** `npx vitest run` (full suite) after
61-17's changes shows the identical 23 failures across the identical 7 test files listed above
(adapter-capture, adapter-inject, episodic-dryrun-gate, eval-harness-smoke, locomo-harness,
locomo-latency-curve, locomo-scorer). Confirmed unrelated: none of these files reference
`src/viz/server.ts` or `src/viz/modules/corpus.js` (grep check), and the failures trace to a
missing `dist/cli.js` build artifact in this worktree, not to any GAP-7/GAP-8 change. The
plan's own verification targets all pass clean: `npx tsc --noEmit` clean,
`tests/viz-corpus-graph.test.ts` 40/40, `tests/viz-index-route.test.ts` 20/20. Out of scope for
61-17; not investigated or fixed.
