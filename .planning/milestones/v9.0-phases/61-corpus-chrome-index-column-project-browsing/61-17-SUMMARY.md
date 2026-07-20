---
phase: 61-corpus-chrome-index-column-project-browsing
plan: 17
subsystem: ui
tags: [viz, corpus-graph, force-graph, humanTitle, gap-closure]

# Dependency graph
requires:
  - phase: 61 (plans 08, 12, 15, 16)
    provides: the /graph?type=doc endpoint, the /index humanTitle() UUID guard, and
      focusCorpusProject's animated focus/unfocus (D-04/D-07 contract)
provides:
  - GAP-7 fix — focusCorpusProject's MAX_ZOOM clamp is deferred until after the animated
    zoomToFit transition completes, in both the focus and null-clear branches
  - GAP-8 fix — /graph?type=doc doc-node labels pass through the same humanTitle() UUID
    guard as /index, via one shared hoisted helper
affects: [61-18 (docked left panel, depends on this plan's fixes being live for founder sign-off)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Deferred post-animation state read via setTimeout(..., TRANSITION_MS) instead of a
      synchronous same-tick read after an animated force-graph call"
    - "Single shared derivation helper (humanTitle) hoisted above two call sites to prevent
      guard-set != ship-set drift between /index and /graph"

key-files:
  created: []
  modified:
    - src/viz/modules/corpus.js
    - src/viz/server.ts
    - tests/viz-corpus-graph.test.ts

key-decisions:
  - "Deferred clamp uses its own try/catch inside the setTimeout callback (not the outer try),
    so a missing zoom() API after the timer fires stays non-fatal independent of the
    zoomToFit() call's own try/catch"
  - "humanTitle()/UUID_RE hoisted to enclose both /graph and /index handlers rather than
    exported/duplicated, closing the guard-set≠ship-set drift class (WR-04/IN-06) for this pair"

requirements-completed: ["GAP-7", "GAP-8"]

duration: 25min
completed: 2026-07-17
---

# Phase 61 Plan 17: Corpus GAP-7/GAP-8 Regression Fixes Summary

**Deferred the corpus focus/unfocus MAX_ZOOM clamp past the 500ms animation, and shared the /index humanTitle() UUID guard onto /graph?type=doc so no corpus node ever hovers with a raw UUID label.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-07-17T12:58:17Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- `focusCorpusProject` (both the scoped-focus and null-clear branches) now schedules its
  `MAX_ZOOM` clamp check inside `setTimeout(..., CORPUS_FOCUS_TRANSITION_MS)`, reading the
  zoom level only after the animated `zoomToFit` transition finishes — a small project
  cluster can no longer overshoot `MAX_ZOOM` unclamped, and the 500ms unfocus animation is
  never interrupted by an instant same-tick snap.
- A single `humanTitle()` + `UUID_RE` derivation is now hoisted above `stmtDocNodes` in
  `server.ts`, enclosing both the `/graph?type=doc` and `/index` handlers. The `/graph`
  doc-node mapping overrides `label` with `humanTitle(n)`, so a schema-anchored doc whose
  backing schema node is empty or missing (COALESCE falls back to the raw UUID slug) now
  resolves to its markdown H1 title on hover, exactly as `/index` already did.
- Both fixes are locked by new tests: a source assertion proving no same-tick clamp remains
  in `focusCorpusProject`, and a runtime `/graph?type=doc` request against an orphan
  schema-anchored doc fixture proving the label is never a UUID.

## Task Commits

Each task was committed atomically:

1. **Task 1: Defer the MAX_ZOOM clamp until the focus/unfocus animation completes (GAP-7)** - `fc92576` (fix)
2. **Task 2: Apply the humanTitle UUID guard to the /graph?type=doc node label (GAP-8)** - `e58ffbd` (fix)

## Files Created/Modified
- `src/viz/modules/corpus.js` - `focusCorpusProject` clamp deferred via `setTimeout(..., CORPUS_FOCUS_TRANSITION_MS)` in both branches; `fitAndClamp()` (instant-fit path) left untouched
- `src/viz/server.ts` - hoisted shared `humanTitle()`/`UUID_RE` above `stmtDocNodes`; `/graph?type=doc` doc-node mapping now overrides `label`; removed the now-duplicated local copy inside `/index`
- `tests/viz-corpus-graph.test.ts` - added a GAP-7 source assertion (deferred-clamp / no same-tick clamp) and a GAP-8 runtime assertion (orphan schema-anchored doc fixture)

## Decisions Made
- Kept each deferred clamp's `zoomToFit()` call and the `setTimeout(...)` scheduling it inside the SAME outer `try/catch` (as before), but wrapped the clamp body itself in its own `try/catch` inside the timer callback — a missing/changed `zoom()` API surfaces independently of the (already-fired) `zoomToFit` call.
- Left `graphSchemaSlugRe` (the schema-slug-format test used for `ownerScope` resolution) untouched and separate from the hoisted `UUID_RE` — same regex literal, different concern (per plan: out of scope to consolidate further, that's IN-06's corpus.js third copy, not touched here).

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None. The full `npx vitest run` suite shows 23 pre-existing failures across 7 unrelated files (`adapter-capture.test.ts`, `adapter-inject.test.ts`, `episodic-dryrun-gate.test.ts`, `eval-harness-smoke.test.ts`, `locomo-harness.test.ts`, `locomo-latency-curve.test.ts`, `locomo-scorer.test.ts`) — traced to a missing `dist/cli.js` build artifact in this worktree, unrelated to any file this plan touched (grep-confirmed no reference to `src/viz/server.ts` or `src/viz/modules/corpus.js`). Already logged in `deferred-items.md` under 61-08 and re-confirmed here under 61-17; not investigated or fixed (out of scope).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Both round-4 regressions (WR-01/GAP-7, WR-04/GAP-8) from `61-REVIEW.md` / `61-VERIFICATION.md` are closed and locked by new assertions. `tests/viz-corpus-graph.test.ts` (40/40) and `tests/viz-index-route.test.ts` (20/20) pass clean; `npx tsc --noEmit` clean. Ready for plan 61-18's founder sign-off on the live install — the corpus surface these fixes touch (focus/unfocus zoom animation, node hover labels) should now verify fully fixed alongside the GAP-10 docked left panel rework.

## Self-Check: PASSED

- FOUND: src/viz/modules/corpus.js
- FOUND: src/viz/server.ts
- FOUND: tests/viz-corpus-graph.test.ts
- FOUND: .planning/phases/61-corpus-chrome-index-column-project-browsing/61-17-SUMMARY.md
- FOUND commit: fc92576 (Task 1)
- FOUND commit: e58ffbd (Task 2)
- FOUND commit: 2d464a1 (docs: SUMMARY)

---
*Phase: 61-corpus-chrome-index-column-project-browsing*
*Completed: 2026-07-17*
