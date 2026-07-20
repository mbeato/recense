---
phase: 61-corpus-chrome-index-column-project-browsing
plan: 08
subsystem: ui
tags: [viz, corpus, sqlite, better-sqlite3, read-only-projection]

# Dependency graph
requires:
  - phase: 61-05
    provides: Docked full-height sidebar the corpus canvas reflows beside (index tree render surface)
provides:
  - Read-only server-side schema→project resolution (abstracts + node_scope, D-37-gated) nesting resolved schema-rooted trees under their project in /index
  - ownerScope field on /graph?type=doc schema-anchored doc nodes
  - corpus.js owner map preference pass consuming ownerScope so resolved schema nodes group/dim/reveal with their project
affects: [61-09]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Read-only derived-field resolution computed fresh per request from an existing compile-once prepared statement (no caching, no new Database) — mirrors an existing engine-side query (corpus-promoter.ts stmtGetSchemasInScope) reversed and grouped for a different consumer"
    - "Client owner map: prefer a server-provided authoritative field (ownerScope) over a client-side structural fallback (containment up-walk) only when the server value is itself recognized/valid"

key-files:
  created: []
  modified:
    - src/viz/server.ts
    - src/viz/modules/corpus.js
    - tests/viz-index-route.test.ts

key-decisions:
  - "Dominant-scope tiebreak: when a schema's gated abstracts members span multiple project scopes, pick the scope with the MOST members; ties break alphabetically — deterministic, no silent misattribution"
  - "Resolution only applies to tree ROOTS (rows with no existing doc_containment parent) — a schema nested under something else via containment already has a parent and is left alone"
  - "Both the schema→scope resolution AND a matching project doc must exist for nesting; either miss falls back to the unchanged schemas[] section"

requirements-completed: [GAP-4]

# Metrics
duration: ~20min
completed: 2026-07-14
---

# Phase 61 Plan 08: Schema→Project Resolution (GAP-4) Summary

**Read-only schema→project resolution (D-37-gated abstracts + node_scope) nests resolved schema-rooted trees under their owning project in both /index and the corpus graph's owner map, closing the "schemas render as useless free-floating peers" gap.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-14T17:09:00-04:00
- **Completed:** 2026-07-14T17:14:26-04:00
- **Tasks:** 2 completed
- **Files modified:** 3

## Accomplishments
- A schema whose D-37-gated `abstracts` members carry a project's `node_scope` now nests under that project in `/index` (parentId set, moved out of `schemas[]`) — no `doc_containment` edge required, since the promoter's project-landing edges don't exist yet in live data
- `/graph?type=doc` exposes `ownerScope` on schema-anchored doc nodes so the graph's focus/dim/reveal owner map treats a resolved schema as belonging to its project, not as an isolated cluster
- Unresolvable schemas (no gated project member, or resolved scope has no matching project doc) keep today's free-floating behavior exactly — no regression

## Task Commits

Each task was committed atomically (TDD: test → feat):

1. **Task 1: Resolve schema→project read-only and nest resolved schemas in /index + emit ownerScope in /graph (server.ts)**
   - `2781e5c` (test) — RED: failing nesting + fallback + ownerScope assertions
   - `46f4a9e` (feat) — GREEN: `stmtSchemaProjectScopes` + `resolveSchemaToProject()`, `/index` nesting, `/graph?type=doc` ownerScope
2. **Task 2: Group schema nodes under their project in the corpus graph owner map (corpus.js)** - `d232c14` (feat)

_No refactor commit needed — GREEN implementation matched the plan's design cleanly._

## Files Created/Modified
- `src/viz/server.ts` - New compile-once `stmtSchemaProjectScopes` (mirrors corpus-promoter.ts's `stmtGetSchemasInScope`, D-37 firewall verbatim) + `resolveSchemaToProject()` helper; `/index` handler nests resolved schema-rooted trees under their project; `/graph?type=doc` attaches `ownerScope` to each doc node
- `src/viz/modules/corpus.js` - `buildCorpusGraph` owner-map preference pass: prefers `node.ownerScope` over the containment up-walk fallback when it names a recognized project scope
- `tests/viz-index-route.test.ts` - New GAP-4 fixtures (resolvable + global-only-scoped schema) and a new `describe` block covering nesting, fallback, and `/graph` `ownerScope` assertions (5 new tests, all passing)

## Decisions Made
- Dominant-scope tiebreak (max members, alphabetical) for schemas whose gated members span multiple projects — see frontmatter `key-decisions`
- Resolution scoped to tree roots only, so it composes cleanly with the existing `doc_containment`-derived nesting instead of overriding it
- Both lookups (scope resolution + matching project doc) must hit; either miss is a silent, safe fallback to the pre-GAP-4 behavior

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Missing plan file copied into worktree from the main checkout**
- **Found during:** Plan load (before Task 1)
- **Issue:** `.planning/phases/61-corpus-chrome-index-column-project-browsing/61-08-PLAN.md` did not exist in this worktree (or any git commit) — the planner had authored it only as an untracked file in the main repo checkout at `/Users/vtx/brain-memory`, and the parallel-executor worktree was branched before that file existed / was never synced into it.
- **Fix:** Read the untracked plan file from the main checkout and wrote an identical copy into this worktree's `.planning/phases/.../61-08-PLAN.md` so execution could proceed. No plan content was invented or altered.
- **Files modified:** `.planning/phases/61-corpus-chrome-index-column-project-browsing/61-08-PLAN.md` (added to this worktree; not committed — planning artifacts outside `SUMMARY.md`/`deferred-items.md` are not this executor's commit responsibility in worktree mode, and the orchestrator/planner owns the canonical copy in the main checkout)
- **Verification:** Plan content read back matches the source verbatim; all subsequent task work executed against it successfully
- **Committed in:** Not committed (see above) — flagging here for orchestrator visibility

---

**Total deviations:** 1 auto-fixed (1 blocking — missing plan artifact)
**Impact on plan:** Blocking-only; no scope creep. All task work otherwise followed the plan as written with no architectural changes.

## Issues Encountered
- Running the full `npx vitest run` suite (not part of this plan's own verification target) surfaced 23 pre-existing failures across 7 unrelated test files (CLI-subprocess/eval-harness tests — `adapter-capture`, `adapter-inject`, `episodic-dryrun-gate`, `eval-harness-smoke`, `locomo-harness`, `locomo-latency-curve`, `locomo-scorer`). None touch this plan's files (`src/viz/server.ts`, `src/viz/modules/corpus.js`, `tests/viz-index-route.test.ts`). Logged to `deferred-items.md`, not investigated or fixed (out of scope per the executor scope-boundary rule).

## Known Stubs
None.

## Threat Flags
None — this plan's `<threat_model>` (T-61-14/15/16) already covers the new read-only SQL surface and ownerScope field; no additional surface introduced beyond what was scoped.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- GAP-4 closure ready for the 61-09 founder live-install checkpoint (behavioral verification deferred there per plan `<verification>`)
- Automated verification complete: `tests/viz-index-route.test.ts` 20/20, `tests/viz-corpus-graph.test.ts` 27/27, `npx tsc --noEmit` clean
- Note (flagged in-plan, discretionary, for 61-09): a nested schema still renders its chapters flat when its project expands (no per-schema collapse in the index) — acceptable for the "nested under their project" truth; out of scope for this gap

## Self-Check: PASSED

- FOUND: src/viz/server.ts (modified, present on disk)
- FOUND: src/viz/modules/corpus.js (modified, present on disk)
- FOUND: tests/viz-index-route.test.ts (modified, present on disk)
- FOUND: commit 2781e5c in `git log --oneline`
- FOUND: commit 46f4a9e in `git log --oneline`
- FOUND: commit d232c14 in `git log --oneline`

---
*Phase: 61-corpus-chrome-index-column-project-browsing*
*Completed: 2026-07-14*
