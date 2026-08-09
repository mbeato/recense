# Deferred Items — Phase 68 Plan 02

Logged during execution per the executor's scope-boundary rule (out-of-scope discoveries
are logged, not fixed).

## Pre-existing repo-root test failures (unrelated to clients/telegram)

A full-repo `npx vitest run` (run after Plan 02's tasks, for due diligence beyond the
plan's own `clients/telegram/tests` verification scope) shows 25 failing tests across 9
files, none of which touch `clients/telegram/`:

- `tests/adapter-capture.test.ts` (8 cases)
- `tests/adapter-inject.test.ts` (5 cases)
- `tests/drift-05-harness-smoke.test.ts` (1 case)
- `tests/episodic-dryrun-gate.test.ts` (1 case)
- `tests/eval-harness-smoke.test.ts` (3 cases)
- `tests/locomo-harness.test.ts` (2 cases)
- `tests/locomo-latency-curve.test.ts` (1 case)
- `tests/locomo-scorer.test.ts` (3 cases)
- `tests/strip-hidden.test.ts` (1 case — the documented KNOWN FLAKE, machine-load-sensitive
  quadratic-growth perf assertion; re-run in isolation before treating as a regression)

All failures are in CLI-harness/subprocess-spawning tests (`result.status` expected 0,
got 1) unrelated to any file this plan touched (`belief-bridge.ts`, `config.ts`,
`index.ts`, `state.ts`, `push-codec.ts`, `belief-render.ts`). `git diff --name-only`
against the plan's base commit confirms none of the failing test files or their
production counterparts were modified by Plan 02. Not fixed — out of scope per the
executor's scope-boundary rule.

`npx vitest run clients/telegram/tests` (the plan's actual verification target) is
fully green: 20 files, 339 tests passed.
