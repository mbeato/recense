# Deferred Items — Phase 58

Out-of-scope discoveries logged per the executor's scope-boundary rule (not fixed,
not investigated further in this plan).

## 58-02: Pre-existing unrelated test failures at full-suite run

Running the full `npx vitest run` suite after 58-02's changes (graph.js haze
impostor swap, constants.js additive Phase-58 section, 3 THREE-mock test file
updates) surfaces 23 failing tests across 7 files, none of which touch the viz
module or any file this plan modified:

- `tests/adapter-capture.test.ts`
- `tests/adapter-inject.test.ts`
- `tests/episodic-dryrun-gate.test.ts`
- `tests/eval-harness-smoke.test.ts`
- `tests/locomo-harness.test.ts`
- `tests/locomo-latency-curve.test.ts`
- `tests/locomo-scorer.test.ts`

These are CLI-subprocess exit-code assertions (adapter/episodic/eval/locomo
harness scripts) — unrelated engine/CLI surfaces, not the `src/viz/modules/*`
files this plan touches. Scoped verification for this plan
(`tests/viz-haze-activation.test.ts`, `tests/viz-haze-selection.test.ts`,
plus the two other tests that import `graph.js`:
`tests/viz-seed-determinism.test.ts`, `tests/viz-layout-guards.test.ts`) all
pass green. Not investigated further here — out of this plan's scope per the
executor scope-boundary rule.
