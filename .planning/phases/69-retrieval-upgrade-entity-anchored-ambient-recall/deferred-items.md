# Phase 69 — Deferred Items (out-of-scope discoveries)

## From 69-01 execution (2026-08-03)

**Pre-existing, out-of-scope test failures — NOT caused by 69-01's changes.**

Running the full `npx vitest run` suite after 69-01's three tasks shows 24-25 failing tests
across 8 files, all unrelated to `REQUIREMENTS.md`, `src/lib/config.ts`, or the new
`src/retrieval/entity-anchor.ts` / `tests/entity-anchor.test.ts`:

- `tests/adapter-capture.test.ts` (8 tests)
- `tests/adapter-inject.test.ts` (5 tests)
- `tests/drift-05-harness-smoke.test.ts` (1 test)
- `tests/episodic-dryrun-gate.test.ts` (1 test)
- `tests/eval-harness-smoke.test.ts` (3 tests)
- `tests/locomo-harness.test.ts` (2 tests)
- `tests/locomo-latency-curve.test.ts` (1 test)
- `tests/locomo-scorer.test.ts` (3 tests)

Root cause (verified): all of the above spawn the **compiled** CLI via `spawnSync(process.execPath,
[join(DIST_DIR, '<cli>.js')], ...)`, and `dist/` does not exist in this worktree (`ls dist/`
→ no such file or directory). This worktree was reset to the phase's base commit at agent
startup (`worktree_branch_check`), which does not run `npm run build`; `dist/` is gitignored
build output, not tracked state. This is an environment/build-state gap, not a code defect —
out of scope per the executor's scope-boundary rule (only auto-fix issues directly caused by
the current task's changes). Left unfixed here; whichever plan/runner next needs the CLI tests
green should run `npm run build` first.

- `tests/strip-hidden.test.ts` — 1 perf-timing case (`T2 growth from 16k to 64k ... stays
  linear`) failed on this run. This is the KNOWN FLAKE called out in this executor's own launch
  instructions ("tests/strip-hidden.test.ts, 2 perf cases — isolate to confirm if sole
  failure"). Not investigated further per that guidance; it is a timing-sensitive perf
  assertion, not a correctness regression, and unrelated to 69-01's files.

**Verification performed for 69-01's own scope:** `npm run typecheck` clean;
`npx vitest run tests/entity-anchor.test.ts` — 13/13 passed; `git diff --stat` (relative to the
plan's base commit) touches exactly the four declared files
(`.planning/REQUIREMENTS.md`, `src/lib/config.ts`, `src/retrieval/entity-anchor.ts`,
`tests/entity-anchor.test.ts`).

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
