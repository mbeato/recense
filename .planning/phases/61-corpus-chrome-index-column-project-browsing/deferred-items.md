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
