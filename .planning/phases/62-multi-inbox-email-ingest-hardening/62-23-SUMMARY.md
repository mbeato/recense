---
phase: 62-multi-inbox-email-ingest-hardening
plan: 23
subsystem: infra
tags: [typescript, tsconfig, import-boundary, css-tree, htmlparser2, regression-test, T-62-17-08]

# Dependency graph
requires:
  - phase: 62 (plan 17)
    provides: "T-62-17-08's original prose invariant and threat-register row, which this plan makes real"
  - phase: 62 (plan 21)
    provides: "htmlparser2@10.0.0 as the adopted HTML parser — the guard's ban list must not report it"
provides:
  - "A tests-scoped tsconfig.json (tests/tsconfig.json) so the tests-only css-tree ambient declaration is invisible to src/'s own typecheck"
  - "A shipped, non-vacuous regression test (tests/src-import-boundary.test.ts) locking T-62-17-08"
  - "Corrected doc comments in src/types/css-tree-tokenizer.d.ts and tests/support/css-tree-ambient.d.ts describing enforcement that now actually exists"
affects: [62-22, 62-24]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-tsconfig split (root src+scripts / tests/tsconfig.json extends+noEmit) mirroring the existing clients/telegram/tsconfig.json precedent, to scope test-only ambient declarations out of the production typecheck"
    - "Exported offender-predicate function shared between the real src/ walk and a synthetic non-vacuousness check in the same test file, matching the repo's existing tests/strip-hidden.test.ts raw-slice-guard pattern"

key-files:
  created:
    - tests/tsconfig.json
    - tests/src-import-boundary.test.ts
  modified:
    - tsconfig.json
    - package.json
    - src/types/css-tree-tokenizer.d.ts
    - tests/support/css-tree-ambient.d.ts

key-decisions:
  - "tests/tsconfig.json's include is [\"../src\", \".\", \"../scripts\"], not just the tests tree alone — found live: narrowing it to only the tests tree broke typecheck, because src/source/strip-hidden.ts is pulled transitively into the tests-project program (some test file imports it) but its own ambient css-tree/tokenizer declaration (src/types/css-tree-tokenizer.d.ts) isn't a root file of that narrower project, so TS7016 fired against a src/ file inside the tests-project compile. Mirroring the full src+tests coverage in the tests project (while root project drops tests/) is what makes both projects type-check cleanly without regressing the isolation invariant, which is enforced by the root project's narrower include, not the tests project's."

requirements-completed: [EMAIL-03]

# Metrics
duration: ~25min
completed: 2026-08-01
---

# Phase 62 Plan 23: Enforce the T-62-17-08 src/ Import Isolation Guard Summary

**Split tsconfig.json into a src-only root project and a new tests/tsconfig.json, closing the WR-10 gap where a program-global css-tree ambient declaration silently let src/ compile against both the bare css-tree parser and the test-only liveness oracle — now proven by a probe (fails then passes on removal) and locked by a shipped, non-vacuous regression test.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-08-01
- **Tasks:** 2 (1 auto, 1 auto+tdd)
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments

- Narrowed root `tsconfig.json`'s `include` from `["src", "tests", "scripts"]` to `["src", "scripts"]` — `src/`'s own typecheck no longer sees `tests/support/css-tree-ambient.d.ts`'s program-global `declare module 'css-tree'`.
- Created `tests/tsconfig.json` (extends root, `noEmit: true`) as the tests project. Its `include` is `["../src", ".", "../scripts"]`, not just the tests tree — discovered live that a narrower `["."]` broke typecheck, because `src/source/strip-hidden.ts` is pulled transitively into the tests-project compile (a test file imports it) and needs its own ambient `css-tree/tokenizer` declaration visible in that project too.
- Added `"typecheck": "tsc --noEmit -p tsconfig.json && tsc --noEmit -p tests/tsconfig.json"` to `package.json`, leaving `build`/`pretest`/`test` unchanged.
- Rewrote the false enforcement paragraph in `src/types/css-tree-tokenizer.d.ts:9-16` (WR-10's exact citation) and the stale "scoped to `tests/` only" claim in `tests/support/css-tree-ambient.d.ts` to describe the enforcement that now exists, with a dated note of when it became true.
- Proved by construction: a probe at `src/source/__probe_wr10.ts` importing `{ parse, walk, ident }` from bare `css-tree` plus `liveHidingSelectors` from `tests/support/css-liveness-oracle` fails `tsc --noEmit -p tsconfig.json` with TS7016 on both imports; deleting the probe restores exit 0. Verbatim output below.
- Shipped `tests/src-import-boundary.test.ts` via TDD: RED committed a stub predicate that trivially passes the real-walk assertion but fails the non-vacuousness check (synthetic offenders planted, none detected); GREEN implemented the real ban-list predicate (bare `css-tree` import, any `tests/support/` import), explicitly permitting `css-tree/tokenizer` and `htmlparser2`.
- `npm run build` still emits `dist/src/**` unchanged; `dist/tests` is no longer emitted (verified: directory absent after build).
- Full suite green after each task: 198 test files / 3249 tests passed, 1 skipped, 5 expected-fail (unchanged count from before this plan, plus the 4 new `src-import-boundary.test.ts` tests replacing the RED stub's 3-passing/1-failing state).

## Task Commits

1. **Task 1: Scope the test-only ambient declarations out of the src/ program, and correct the documentation that claimed they already were** — `62ede24` (feat)
2. **Task 2: Ship the boundary as a non-vacuous regression test** — RED `fc8c2ee` (test), GREEN `d83660d` (feat)

**Plan metadata:** this SUMMARY commit is that step (worktree mode — orchestrator handles STATE.md/ROADMAP.md centrally after merge).

## WR-10 Probe — Verbatim Output

Before deletion (`src/source/__probe_wr10.ts` present, importing both the bare `css-tree` parser and the test-only oracle):

```
$ npx tsc --noEmit -p tsconfig.json
src/source/__probe_wr10.ts(1,36): error TS7016: Could not find a declaration file for module 'css-tree'. '/Users/vtx/brain-memory/.claude/worktrees/agent-a983ff7306961e1ca/node_modules/css-tree/cjs/index.cjs' implicitly has an 'any' type.
  Try `npm i --save-dev @types/css-tree` if it exists or add a new declaration (.d.ts) file containing `declare module 'css-tree';`
tests/support/css-liveness-oracle.ts(29,36): error TS7016: Could not find a declaration file for module 'css-tree'. '/Users/vtx/brain-memory/.claude/worktrees/agent-a983ff7306961e1ca/node_modules/css-tree/cjs/index.cjs' implicitly has an 'any' type.
  Try `npm i --save-dev @types/css-tree` if it exists or add a new declaration (.d.ts) file containing `declare module 'css-tree';`
$ echo $?
2
```

After deletion (`rm src/source/__probe_wr10.ts`):

```
$ npx tsc --noEmit -p tsconfig.json
$ echo $?
0
```

`git status --short` was clean (no probe artifact) both before staging Task 1's commit and immediately after the probe run/delete cycle.

## dist/ Listing — src Preserved, tests Absent

```
$ npm run build && ls dist/
scripts
src
$ test -f dist/src/source/strip-hidden.js && echo "dist/src path preserved"
dist/src path preserved
$ test -d dist/tests && echo EXISTS || echo "dist/tests absent"
dist/tests absent
```

## The Shipped Ban List (`tests/src-import-boundary.test.ts`)

- **Banned:** bare `css-tree` import (`from 'css-tree'` / `require('css-tree')` — exact specifier, no subpath).
- **Banned:** any import/require specifier traversing into `tests/support/`.
- **Explicitly permitted (asserted, not just absent from the ban list):** `css-tree/tokenizer` (the adopted, typed subpath — `src/types/css-tree-tokenizer.d.ts`) and `htmlparser2` (the adopted HTML parser, 62-21-SUMMARY.md). Both have dedicated test cases asserting zero offenders on a synthetic file importing them.

## Files Created/Modified

- `tsconfig.json` — `include` narrowed to `["src", "scripts"]`.
- `tests/tsconfig.json` (new) — extends root, `noEmit: true`, `include: ["../src", ".", "../scripts"]`.
- `package.json` — added `"typecheck"` script running both projects.
- `src/types/css-tree-tokenizer.d.ts` — rewrote the false "fails to compile" claim to describe the enforcement that now exists (root include narrowing + the shipped test), citing WR-10.
- `tests/support/css-tree-ambient.d.ts` — corrected the "scoped to `tests/` only" doc comment: was aspirational since 62-17, is now true, with the date and mechanism named.
- `tests/src-import-boundary.test.ts` (new) — the shipped, non-vacuous regression lock; exports `findBoundaryOffenders` as the single code path used by both the real `src/` walk and the synthetic non-vacuousness check.

## Decisions Made

- **`tests/tsconfig.json`'s `include` covers `../src` too, not just the tests tree** — see `key-decisions` in frontmatter. The plan's own action text flagged this as unverified ("adjust the relative form to whatever actually resolves — verify by running it, do not assume"); running it surfaced that a tests-tree-only include breaks typecheck because `strip-hidden.ts` is transitively compiled inside the tests project without its own ambient declaration in scope. This does not weaken the isolation invariant — that invariant is about the ROOT (`src`-only) project never seeing the tests-only ambient declaration, which the root project's own narrower `include` still guarantees regardless of what the tests project additionally includes.
- **TDD split for Task 2**: RED committed the test file with `findBoundaryOffenders` as a stub always returning `[]` — the real-walk assertion passed trivially (nothing to catch), but the non-vacuousness assertion (synthetic planted offenders) correctly failed, proving the guard's own test-of-itself is load-bearing before the predicate existed. GREEN then implemented the real regex-based predicate.

## Deviations from Plan

None (Rule 1-3 sense) — the `tests/tsconfig.json` include-path correction was explicitly anticipated and required by the plan's own action text ("verify by running it, do not assume"), not an unplanned deviation.

## Issues Encountered

- Initial `tests/tsconfig.json` with `include: ["."]` (tests tree only, mirroring `clients/telegram/tsconfig.json`'s single-tree pattern) passed when run standalone but failed when chained via `npm run typecheck`'s `&&` — traced to `tsc -p tests/tsconfig.json` alone also failing, with TS7016 errors attributed to `src/source/strip-hidden.ts` (a src/ file pulled transitively into the tests project's program by a test file's import, without its own ambient `css-tree/tokenizer` declaration in scope). Fixed by including `../src` in `tests/tsconfig.json` (see Decisions Made above). Confirmed resolved: `npm run typecheck` exits 0, full suite green.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Invariant T-62-17-08 is now enforced by the build (compile-time, via the two-project split) and locked by a shipped, non-vacuous test (`tests/src-import-boundary.test.ts`) — a future `src/` file reaching for the bare `css-tree` parser or the test-only oracle fails both `tsc --noEmit -p tsconfig.json` and `npx vitest run`.
- `npm run build` unaffected: `dist/src/source/strip-hidden.js` present at the same path 62-22/62-24 depend on; `dist/tests` no longer emitted.
- Frozen EMAIL-01/02/04 surface: 0 commits touched anything outside this plan's declared `files_modified` — verified via `git diff --stat b06e521..HEAD`, which shows exactly `tsconfig.json`, `tests/tsconfig.json`, `package.json`, `src/types/css-tree-tokenizer.d.ts`, `tests/support/css-tree-ambient.d.ts`, `tests/src-import-boundary.test.ts`. No files declared for plan 62-22 (`src/source/strip-hidden.ts`, `src/source/gmail-adapter.ts`, `tests/strip-hidden.test.ts`, `tests/gmail-hidden-content.test.ts`) were touched.

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-08-01*
