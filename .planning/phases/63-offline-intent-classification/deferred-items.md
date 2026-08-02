# Deferred Items — Phase 63

## Pre-existing full-suite failures observed during 63-02 execution (out of scope)

`npx vitest run` (full suite) shows 23 pre-existing failures across 7 subprocess-spawning CLI
test files, all `expect(result.status).toBe(0)` assertions against a `spawnSync`/`execSync`
child process exiting 1 instead of 0:

- `tests/adapter-capture.test.ts` (6 tests)
- `tests/adapter-inject.test.ts` (5 tests)
- `tests/episodic-dryrun-gate.test.ts` (1 test)
- `tests/eval-harness-smoke.test.ts` (3 tests)
- `tests/locomo-harness.test.ts` (2 tests)
- `tests/locomo-latency-curve.test.ts` (1 test)
- `tests/locomo-scorer.test.ts` (3 tests)

None of these files import `src/source/extraction-prompts.ts` or `src/model/claim-extractor.ts`
(the only files 63-02 touches), and none are in 63-02's `files_modified`. Failure signature
(child process exit 1 uniformly) is consistent with a missing/stale build artifact or
environment setup gap in this specific worktree, not a regression introduced by this plan.
The three plan-scoped test files (`tests/extraction-prompts-intent.test.ts`,
`tests/extraction-prompts-temporal.test.ts`, `tests/no-ats-domain-table.test.ts`) all pass
(27/27), and `npm run typecheck` is clean. Out of scope per the executor scope-boundary rule
— not fixed here.
