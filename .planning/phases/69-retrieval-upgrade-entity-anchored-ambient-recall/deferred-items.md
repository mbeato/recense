# Deferred Items — Phase 69

## 69-02: Pre-existing test failures (out of scope, not touched)

`npx vitest run` (full suite) shows 24 failing tests across 8 files, all pre-existing and
unrelated to 69-02's files (`src/retrieval/honest-trace.ts`, `src/retrieval/engine.ts`,
`src/viz/server.ts`, `tests/honest-trace.test.ts`, `tests/retrieval-anchor-union.test.ts`):

- `tests/adapter-capture.test.ts` (8 failures)
- `tests/adapter-inject.test.ts` (5 failures)
- `tests/drift-05-harness-smoke.test.ts` (1 failure)
- `tests/episodic-dryrun-gate.test.ts` (1 failure)
- `tests/eval-harness-smoke.test.ts` (3 failures)
- `tests/locomo-harness.test.ts` (2 failures)
- `tests/locomo-latency-curve.test.ts` (1 failure)
- `tests/locomo-scorer.test.ts` (3 failures)

Root cause: all of these spawn a compiled CLI via `spawnSync(... join(DIST_DIR, '*.js'))`, and
this worktree has no `dist/` directory at all (`ls dist/` → "No such file or directory") — a
missing build artifact, not a code regression. None of these test files reference
`src/retrieval/engine.ts`, `src/retrieval/honest-trace.ts`, or `src/viz/server.ts`. Confirmed
out of scope per the Scope Boundary rule (only auto-fix issues directly caused by the current
task's changes). Not fixed here — flagging for the orchestrator / a build step ahead of the
next verification pass.
