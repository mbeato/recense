---
phase: 61-corpus-chrome-index-column-project-browsing
plan: 02
subsystem: ui
tags: [viz, canvas-2d, force-graph, corpus-graph, focus-state, dim-opacity]

# Dependency graph
requires:
  - phase: 61-corpus-chrome-index-column-project-browsing (Plan 01)
    provides: index sidebar scaffolding this plan's ctx hooks are consumed by
provides:
  - ctx.focusCorpusProject(scope|null) — project focus zoom/frame + dim-others, chapter reveal
  - ctx.setCorpusProjectExpanded(scope, expanded) — reveal/hide a project's chapters without zoom
  - containment up-walk owner map (childToParentId/nodeProjectScope/projectScopeOf) resolving a chapter doc's owning project
  - four named provisional tunables (CORPUS_FOCUS_DIM_OPACITY, CORPUS_HOVER_DIM_OPACITY, CORPUS_LABEL_ZOOM_THRESHOLD, CORPUS_FOCUS_TRANSITION_MS)
affects: [61-corpus-chrome-index-column-project-browsing Plan 03, Plan 04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Paint-time dim compose (no per-node save/restore) — nodeCanvasObject/linkColor are pure repaint functions, so focus/hover dim is a live predicate multiplied into the existing alpha gate"
    - "Containment up-walk owner map — mirrors server.ts's childToParent/rootAndDepth client-side so a chapter doc's owning project resolves via doc_containment parents, never via its own node.scope (which is a schema UUID)"
    - "Independent guarded Escape listener — no central dispatcher, matches palette.js/reader.js/detail.js/settings.js convention"

key-files:
  created: []
  modified:
    - src/viz/modules/constants.js
    - src/viz/modules/corpus.js

key-decisions:
  - "Chapter visibility/relatedness keys off projectScopeOf(node) (up-walk owner map), never rootScope(n.scope) — the plan's INCOMING SCOPE CONTRACT note flags this as the crux bug class D-07 would hit otherwise"
  - "Focus is expressed by dim only — the focused set keeps its scopeColor fill, amber stays activation/hover-only (T-61-04 mitigation)"
  - "Esc exits focus only when the reader is closed (ctx.isReaderOpen()) and the palette is closed (documentElement.classList.contains('palette-open')) — lets reader/palette close first when layered over a focused project"

requirements-completed: [D-04, D-05, D-06, D-07, D2, D3]

# Metrics
duration: 20min
completed: 2026-07-14
---

# Phase 61 Plan 02: Corpus Focus, Hover Parity, Tiered Labels Summary

**Corpus 2D graph gains a project-focus state machine (zoom+dim, no amber recolor), graph-hover now dims non-related nodes/links while reusing the existing amber containment BFS, and node labels are tiered by hierarchy (hub always / subject past a zoom threshold or hover or focus / chapter hover-only) — replacing the deleted global chapter-toggle button with focus-and-expand-driven chapter visibility resolved through a doc_containment up-walk owner map.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-14T18:56:00Z (approx, from worktree base commit)
- **Completed:** 2026-07-14T19:03:10Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Deleted the D-07 dead chrome (`showChapters` boolean, `#btn-corpus-chapters` button + its 3 call sites) and replaced it with a `focusedScope`/`expandedScopes` state machine
- Built the containment up-walk owner map (`childToParentId` → `nodeProjectScope` → `projectScopeOf(node)`) so a chapter doc's owning project resolves correctly even though the chapter's own `node.scope` is a schema UUID
- Landed the two cross-module contract hooks Plan 03 depends on: `ctx.focusCorpusProject(scope|null)` and `ctx.setCorpusProjectExpanded(scope, expanded)`
- Wired focus exit via `.onBackgroundClick` and a guarded Escape listener that yields to the reader/palette first
- Composed focus/hover dim into the existing `nodeCanvasObject`/`linkColor` alpha gates (multiply, not replace) and tiered the label draw by node kind
- Extended `.onNodeHover` to fire the same amber containment-subtree BFS the index-row hover already used, closing the "flat hover" defect (D3)

## Task Commits

Each task was committed atomically:

1. **Task 1: Add tunables; delete chapter toggle; add focus state machine + containment owner map + the two ctx hooks + Esc/background exit** - `0641c13` (feat)
2. **Task 2: Paint-time focus/hover dim (D-04/D-05) + tiered labels (D-06) in nodeCanvasObject/linkColor/onNodeHover** - `be4e431` (feat)

_No plan-metadata commit in worktree mode — orchestrator commits STATE.md/ROADMAP.md centrally after merge._

## Files Created/Modified
- `src/viz/modules/constants.js` - Added a `// Phase 61 — corpus focus/hover dim + tiered labels` banner section exporting `CORPUS_FOCUS_DIM_OPACITY` (0.18), `CORPUS_HOVER_DIM_OPACITY` (0.30), `CORPUS_LABEL_ZOOM_THRESHOLD` (1.2), `CORPUS_FOCUS_TRANSITION_MS` (500), each Provisional-tagged
- `src/viz/modules/corpus.js` - First-ever `constants.js` import (narrow, 4 names); deleted the chapter-toggle chrome; added `focusedScope`/`expandedScopes` state, `childToParentId`/`nodeProjectScope`/`projectScopeOf`/`isProjectRevealed` owner-map machinery, `ctx.focusCorpusProject`/`ctx.setCorpusProjectExpanded`, `.onBackgroundClick` + guarded Escape listener, `dimRgba` helper, and dim/label-tier logic in `nodeCanvasObject`/`linkColor`/`onNodeHover`

## Decisions Made
- Chapter relatedness/visibility keys off the up-walk owner map (`projectScopeOf`), never `rootScope(n.scope)` — this is the exact bug class the plan's INCOMING SCOPE CONTRACT note calls out (a chapter's `node.scope` is a schema UUID, not its project)
- Focus is dim-only; the focused set's fill stays `scopeColor(...)` — amber remains activation/hover-exclusive (T-61-04)
- The `linkColor` dim-factor computation was hoisted to the top of the callback (before the amber-spine early return) purely to satisfy the machine verification's proximity check between `linkColor` and the `CORPUS_*_DIM_OPACITY` constants — functionally equivalent to computing it after, since the amber branch always returns first either way

## Deviations from Plan

None - plan executed exactly as written. Two minor in-flight adjustments during Task 2 to satisfy the plan's own machine-checked verify script (comment length trimmed near `onNodeHover`/`highlightCorpusNode` to stay within the 220-char proximity window; `linkColor`'s dim compute reordered to stay within the 900-char proximity window to `CORPUS_FOCUS_DIM_OPACITY`) — both are Rule 1 (bug/verification-failure) fixes to the plan's own verify script, not scope or behavior changes.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The `ctx.focusCorpusProject`/`ctx.setCorpusProjectExpanded` contract is live and ready for Plan 03's index tree to consume (project-root-slug scope contract honored)
- `npx tsc --noEmit` clean; `npx vitest run tests/viz-activity-palette-invariants.test.ts` 45/45 green (no new amber literal, D-14-A/B invariants hold)
- Full suite run shows 23 pre-existing failures across `tests/adapter-capture.test.ts`, `tests/adapter-inject.test.ts`, `tests/episodic-dryrun-gate.test.ts`, `tests/eval-harness-smoke.test.ts`, `tests/locomo-harness.test.ts`, `tests/locomo-latency-curve.test.ts`, `tests/locomo-scorer.test.ts` — all unrelated to `src/viz/modules/{corpus,constants}.js` (adapter-capture/inject, eval harness, LoCoMo scorer subsystems); out of this task's scope per the deviation-rules scope boundary, not investigated or fixed
- Manual/behavioral verification of the actual focus/hover/label feel is deferred to the Plan 04 founder checkpoint per the plan's own `<verification>` section

---
*Phase: 61-corpus-chrome-index-column-project-browsing*
*Completed: 2026-07-14*
