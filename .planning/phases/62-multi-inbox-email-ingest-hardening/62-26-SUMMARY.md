---
phase: 62-multi-inbox-email-ingest-hardening
plan: 26
subsystem: testing
tags: [parse5, html-conformance, devDependency, package-legitimacy-gate, differential-testing]

# Dependency graph
requires:
  - phase: 62-multi-inbox-email-ingest-hardening
    provides: "62-21's htmlparser2 vs parse5 measured bake-off and legitimacy evidence for parse5@7.3.0; 62-23's tests/tsconfig.json project boundary and the compile-time src/-import ban"
provides:
  - "parse5@7.3.0 exact-pinned in devDependencies, absent from dependencies and from src/"
  - "Proof that parse5 is importable and typed from the tests/ project (no @types/parse5 needed, no TS7016)"
  - "Evidence that parse5 opens <style/> as a real style element (node names: style, #text, span) — the CR-01 htmlparser2-vs-parse5 divergence 62-28's oracle will build on"
affects: ["62-28"]

# Tech tracking
tech-stack:
  added: ["parse5@7.3.0 (devDependency only)"]
  patterns: ["Throwaway typecheck/import probes under tests/ are written, run, then deleted before commit — never left in the tree"]

key-files:
  created: []
  modified: ["package.json", "package-lock.json"]

key-decisions:
  - "Reused 62-21's exact legitimacy evidence for parse5@7.3.0 rather than re-fabricating it, per operator's own instruction in the resume signal"
  - "Version pinned at 7.3.0, not the current latest 8.0.1, because 8.x is ESM-only and 7.3.0 ships dual CJS/ESM exports plus is the exact version 62-21 already measured"

patterns-established:
  - "devDependency-only package additions for test infrastructure go through the same blocking-human legitimacy gate as production dependencies, with fallback-policy [ASSUMED] treatment when no audit table exists"

requirements-completed: [EMAIL-03]

# Metrics
duration: 15min
completed: 2026-08-02
---

# Phase 62 Plan 26: parse5 devDependency for independent HTML ground truth Summary

**Added parse5@7.3.0 as an exact-pinned devDependency (never a runtime dependency), proven importable and typed from the tests/ project, giving 62-28 an HTML-layer oracle that production's htmlparser2 does not share.**

## Performance

- **Duration:** ~15 min (this session; Task 1's checkpoint wait occurred in a prior session)
- **Completed:** 2026-08-02T12:53:00Z
- **Tasks:** 2 (Task 1 checkpoint resolved by operator in a prior session; Task 2 executed and committed in this session)
- **Files modified:** 2 (`package.json`, `package-lock.json`)

## Accomplishments
- Resolved the blocking-human package-legitimacy gate for `parse5@7.3.0` with the operator's verbatim `approved` reply
- Installed `parse5@7.3.0` as an exact-pinned devDependency, confirmed absent from `dependencies` and from any file under `src/`
- Proved parse5 is importable and typed from the `tests/` tsconfig project via a throwaway probe, then deleted the probe
- Captured the exact divergence evidence 62-28 depends on: parse5 treats `<style/>` as a real (non-void) style element

## Task Commits

Each task was committed atomically:

1. **Task 1: Package legitimacy gate — parse5@7.3.0** — no code commit (checkpoint resolution; recorded below)
2. **Task 2: Install parse5@7.3.0 as exact-pinned devDependency, prove reachable and typed from tests project** - `c4857e4` (feat)

**Plan metadata:** pending (orchestrator-owned STATE.md/ROADMAP.md updates are out of scope for this executor per instructions)

## Package Legitimacy Audit (Task 1)

`parse5` was `[ASSUMED]` under the fallback policy — no `## Package Legitimacy Audit` table exists for Phase 62. This required a blocking human verification before any install, independent of `workflow.auto_advance`.

> **Operator reply: `approved`.** Authorized `npm install --save-exact --save-dev parse5@7.3.0` as a devDependency-only addition for exclusive use by 62-28's HTML ground-truth oracle. Scope: devDependency only — never `dependencies`, never imported from `src/`.

Four legitimacy facts checked before the install (verified in a prior session, re-confirmed read-only in this session):

| # | Fact | Observed value |
|---|------|-----------------|
| 1 | Repository | `git://github.com/inikulin/parse5.git` (`npm view parse5 --json` -> `.repository.url`) — matches `inikulin/parse5` |
| 2 | Weekly downloads | 140,715,662 for the week 2026-07-25 -> 2026-07-31 (`api.npmjs.org/downloads/point/last-week/parse5`) |
| 3 | Version 7.3.0 exists | `npm view parse5@7.3.0 --json` -> `version: "7.3.0"`; `dist.tarball` resolves |
| 4 | Not deprecated | `deprecated` field empty/absent on the package and on the `7.3.0` version object (latest is `8.0.1`) |

Additional read-only checks: OSV advisory query for `parse5@7.3.0` returned `{}` (no known advisories). `grep -n '"parse5"' package-lock.json` returned zero matches before install — parse5 was not present as a direct or transitive dependency, so this is a wholly new addition to the dependency graph. Evidence is consistent with `62-21-SUMMARY.md` lines 74-76 for the same package/version. No anomalies found. `node -e "..."` pre-install gate-precondition check exited 0 before the reply was requested (parse5 absent from both `dependencies` and `devDependencies` at gate time).

## Package.json diff (Task 2)

```diff
--- a/package.json
+++ b/package.json
@@ -74,6 +74,7 @@
     "@types/better-sqlite3": "^7.6.13",
     "@types/node": "^25.9.1",
     "hnswlib-node": "^3.0.0",
+    "parse5": "7.3.0",
     "tsx": "^4.22.4",
     "typescript": "^6.0.3",
     "vectorlite": "^0.2.0",
```

One line inserted into `devDependencies`, alphabetically between `hnswlib-node` and `tsx`, exact-pinned with no `^`/`~`. The `dependencies` block is untouched.

## Assertion outputs (proving parse5 is dev-only and absent from src/)

```
$ node -e "const p=require('./package.json');process.exit(p.devDependencies.parse5==='7.3.0'?0:1)"
exit 0

$ node -e "const p=require('./package.json');process.exit(p.dependencies&&p.dependencies.parse5?1:0)"
exit 0

$ grep -rn "parse5" src/ | wc -l
0
```

## Throwaway probe (Task 2)

Written at `tests/parse5-probe.test.ts` (not committed), imported `parse5`, called `parseFragment('<style/>.legal{display:none}</style>ok<span class="legal">P</span>')`, and printed the resulting top-level node names:

```
PROBE_NODE_NAMES: ["style","#text","span"]
```

This confirms parse5 treats `<style/>` as a real, non-void style element: the CSS content is consumed as the `style` element's own content (not shown as a separate child, since parse5 exposes style/script content as raw text within the element's own subtree in this fragment API), and `ok` plus the `<span>` are correctly parsed as *siblings* of `style`, not descendants — exactly the shape htmlparser2 gets wrong per 62-21's findings. This is the fact 62-28's oracle depends on.

Verification run before deletion:
- `npx vitest run tests/parse5-probe.test.ts --reporter=verbose` — 1 passed, printed the node names above
- `npm run typecheck` (`tsc --noEmit -p tsconfig.json && tsc --noEmit -p tests/tsconfig.json`) — exit 0, no output, no `TS7016`
- `npm run build` — exit 0, `dist/` produced, viz assets copied
- `npx vitest run` (full suite) — 199 test files passed, 1 skipped (200 total); 3287 tests passed, 4 expected fail, 4 skipped (3295 total)

Probe deleted after verification. `git status --porcelain` after deletion showed only `package.json` and `package-lock.json` modified.

## Files Created/Modified
- `package.json` - Added `"parse5": "7.3.0"` to `devDependencies`, exact pin, alphabetically placed
- `package-lock.json` - Locked resolution for the new devDependency and its transitive tree

## Decisions Made
- Reused 62-21's exact legitimacy evidence (repository, download magnitude, version existence, deprecation status) for the same package/version rather than re-fabricating it, since the operator's resume instructions explicitly required recording it verbatim
- Kept the version at `7.3.0` per the plan's explicit instruction not to "upgrade while we're here" — `8.0.1` (current latest) is ESM-only and was already rejected as a candidate in 62-21 for that reason

## Deviations from Plan

None - plan executed exactly as written. Task 1's checkpoint was resolved by the operator between agent sessions with an `approved` reply; this session recorded that resolution and executed Task 2 exactly per its `<action>` block.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `parse5@7.3.0` is available, typed, and importable from `tests/`, unblocking 62-28's HTML-layer differential oracle
- The net-zero-new-runtime-dependency invariant is intact and asserted (not assumed): `dependencies` untouched, `src/` grep-clean, root `tsconfig.json`'s `include` (`["src","scripts"]`) does not cover `tests/`, so a hypothetical `src/` import of parse5 would fail to compile under the root project
- No blockers for 62-28

---
*Phase: 62-multi-inbox-email-ingest-hardening*
*Completed: 2026-08-02*

## Self-Check: PASSED

- SUMMARY.md exists on disk: FOUND
- Commit `c4857e4` (feat: parse5 devDependency install) present in git log: FOUND
- Commit `6e46ce0` (docs: this SUMMARY) present in git log: FOUND
- `package.json` devDependencies.parse5 === "7.3.0": confirmed
- `grep -rn "parse5" src/` returns 0 matches: confirmed
- `git status --short` clean: confirmed
