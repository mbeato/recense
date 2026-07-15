---
phase: 61-corpus-chrome-index-column-project-browsing
plan: 15
subsystem: viz-corpus-index
tags: [predicate-unification, focus-state, single-writer, null-guards]
requires:
  - "61-08 (GAP-4 ownerScope preference pass in corpus.js)"
  - "61-12 (GAP-8 human-title label resolution in server.ts)"
provides:
  - "server-shipped recognized-project root-scope set (projectScopes) on GET /graph?type=doc"
  - "null-safe isProjectRevealed + label predicate in corpus.js"
  - "syncCorpusFocus as the single writer of index.js's activeScope"
  - "filter auto-expand notifies corpus.js for tree-root ancestors (WR-06)"
affects:
  - "src/viz/server.ts"
  - "src/viz/modules/corpus.js"
  - "src/viz/modules/index.js"
tech-stack:
  added: []
  patterns:
    - "Single source of truth shipped server->client instead of hand-derived divergent client sets"
    - "Single-writer state (activeScope) enforced by removing local writes at all but one call site"
key-files:
  created: []
  modified:
    - "src/viz/server.ts"
    - "src/viz/modules/corpus.js"
    - "src/viz/modules/index.js"
    - "tests/viz-corpus-graph.test.ts"
decisions:
  - "projectScopes computed once in the type=doc branch only (not the default full-brain /graph branch) — matches the plan's explicit scope boundary"
  - "Client gates on Array.isArray(data.projectScopes) presence, never .size, so an empty-but-present set is honored over the fallback derivation"
metrics:
  duration: "~35min"
  completed: "2026-07-15"
---

# Phase 61 Plan 15: Predicate-Drift Gap Closure (WR-01/WR-03/WR-04) Summary

Unified three independently hand-written "what is a recognized project" / "who owns focus
state" definitions across `server.ts`, `corpus.js`, and `index.js` into one server-shipped
source of truth plus a single state writer, closing the WR-01/WR-03/WR-04 predicate-drift
defects confirmed in `61-REVIEW.md` / `61-VERIFICATION.md`.

## What Was Built

**Task 1 (WR-03) — server-shipped recognized-project set.** The `GET /graph?type=doc`
branch in `src/viz/server.ts` now computes a `projectScopes: string[]` set — the root scope
of every doc node whose slug is NOT a UUID (mirroring the `/index` handler's own
recognized-project rule verbatim) — and attaches it to the response object (type=doc branch
only, never the default full-brain `/graph`). `src/viz/modules/corpus.js`'s
`buildCorpusGraph` now consumes `data.projectScopes` as the PRIMARY source (gated on
`Array.isArray` presence, not `.size`), falling back to the old subject-doc-only derivation
only when the field is absent. A hub-only project (hub doc + UUID chapter, no colon-slug
subject doc) is now a member of the recognized set, so its index-row click reaches
`focusCorpusProject` instead of being silently rejected.

**Task 2 (WR-01, WR-05) — null guards + no reveal-time camera snap.** `isProjectRevealed`
now returns `false` immediately when a node's owning scope is `null`, BEFORE the equality
check — a scope-less doc can no longer match `null === focusedScope` when nothing is
focused, so it stays hidden at rest (matches the already-correct `isRelated` guard pattern in
the same file). The subject-doc label predicate got the same `focusedScope !== null` gate.
`setCorpusProjectExpanded` no longer calls `fitAndClamp()` — expanding/collapsing a project's
chevron is now a pure paint-time visibility change on the pinned layout, matching its own
"WITHOUT zooming" doc comment; the camera only moves via `focusCorpusProject`'s animated zoom.

**Task 3 (WR-04, WR-06) — single-writer activeScope + filter auto-expand notify.** Removed
the two local `activeScope = ...` assignments from `index.js`'s project-row click handler.
`activeScope` is now written in exactly two places: its declaration and inside
`ctx.syncCorpusFocus`. Because `corpus.js`'s `focusCorpusProject` calls `syncCorpusFocus` only
when the focus actually took (recognized scope), a click on a non-focusable row now leaves
`activeScope` untouched — the row can never phantom-paint `.active`/`aria-current`.
`computeVisible`'s filter-driven ancestor force-expand now also calls
`ctx.setCorpusProjectExpanded(entry.slug, true)` for a NEWLY-expanded tree-root ancestor, so a
filter match reveals its project's chapters in the graph, not just the tree. Clearing the
filter still cannot collapse rows (`expandedIds` remains union-only).

## Deviations from Plan

### Auto-fixed Issues

None — Rules 1-3 were not triggered; the plan's interfaces section was accurate and the
implementation followed the specified action blocks directly.

### Acceptance-criteria clarification (not a deviation, documented for the verifier)

Task 3's literal acceptance grep `grep -n "activeScope =" src/viz/modules/index.js` returns
**four** lines, not two, because the naive substring pattern also matches the comparison
operator `===` (e.g. `activeScope === scope` contains `activeScope =` as a substring). The
semantic requirement — "activeScope is assigned in exactly two places" — IS satisfied: a
grep excluding the comparison case (`grep -n "activeScope = [^=]"`) returns exactly the
declaration (`let activeScope = null`) and the `ctx.syncCorpusFocus` write, matching intent.
The added source-assertion test in `tests/viz-corpus-graph.test.ts` uses the assignment-only
pattern and passes. No code change was needed; this is a note on the plan's grep wording.

## Verification

- `npx vitest run tests/viz-corpus-graph.test.ts` — 38/38 green (16 pre-existing + 22 new:
  2 behavior + 2 source assertions for Task 1; 3 source assertions for Task 2; 4 source
  assertions for Task 3).
- `npx vitest run tests/viz-index-route.test.ts` — 20/20 green (no regression).
- `npx vitest run tests/viz-activity-palette-invariants.test.ts` — 45/45 green (no CSS
  touched by this plan).
- `npx tsc --noEmit` — clean.
- `grep -c "new Database" src/viz/server.ts` — 6 total occurrences but only 1 is an actual
  call (`new Database(dbPath, { readonly: true })` at the module's DB-open site); the other 5
  are comments referencing the invariant by name. Read-only invariant holds (unchanged by
  this plan).
- Full-suite `npx vitest run`: 172 files passed / 7 failed (23 individual test failures) —
  all 7 failing files (`adapter-capture`, `adapter-inject`, `episodic-dryrun-gate`,
  `eval-harness-smoke`, `locomo-harness`, `locomo-latency-curve`, `locomo-scorer`) are
  CLI-subprocess/eval-harness tests unrelated to this plan's files, and were already logged
  as pre-existing in `deferred-items.md` under plan 61-08. Reconfirmed unchanged by this
  plan's diff; not investigated further (out of scope, Rule 3 exclusion — no new failures
  introduced by this plan).

## Known Stubs

None.

## Threat Flags

None — the only new surface (`projectScopes` field on `/graph?type=doc`) was already
disposed `accept` in the plan's own threat model (T-61-15-01): it ships root-scope slugs
already present in the same payload's `node.scope`/`node.slug` fields, on a loopback-only
endpoint. No new DOM string rendering, no new db.prepare/writes, no schema change.

## Self-Check

- FOUND: `/Users/vtx/brain-memory/.claude/worktrees/agent-a1f2bd21b4d93266e/src/viz/server.ts`
- FOUND: `/Users/vtx/brain-memory/.claude/worktrees/agent-a1f2bd21b4d93266e/src/viz/modules/corpus.js`
- FOUND: `/Users/vtx/brain-memory/.claude/worktrees/agent-a1f2bd21b4d93266e/src/viz/modules/index.js`
- FOUND: `/Users/vtx/brain-memory/.claude/worktrees/agent-a1f2bd21b4d93266e/tests/viz-corpus-graph.test.ts`
- Commits verified present in `git log --oneline`: `55fd9e9`, `4036753`, `f1a2782`.

## Self-Check: PASSED
