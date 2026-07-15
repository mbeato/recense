---
phase: 61-corpus-chrome-index-column-project-browsing
plan: 13
subsystem: ui
tags: [viz, corpus, index-sidebar, frontend-static]

# Dependency graph
requires:
  - phase: 61-11
    provides: index rail dock/reflow split (body.index-docked, openSidebar/hidePanel)
  - phase: 61-12
    provides: prior GAP closure wave (index sidebar polish)
provides:
  - "ctx.showIndexHandle() hook — reveals the #index-reopen handle on corpus entry without docking the rail"
  - "corpus.js goToCorpus default-closed rail entry (calls showIndexHandle instead of openIndexSidebar)"
affects: [61-14]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Handle-reveal vs dock-open as two distinct ctx hooks (showIndexHandle vs openIndexSidebar) — presentation state separated from panel-visibility state"

key-files:
  created: []
  modified:
    - src/viz/modules/index.js
    - src/viz/modules/corpus.js
    - src/viz/index.html

key-decisions:
  - "ctx.openIndexSidebar left exported but no longer auto-invoked by goToCorpus — kept as a latent hook (still wired to the reopen-handle click via openSidebar) rather than deleted, per plan instruction."

patterns-established: []

requirements-completed: ["GAP-6"]

# Metrics
duration: 6min
completed: 2026-07-14
---

# Phase 61 Plan 13: Default-Closed Index Rail Summary

**Corpus view now opens with the graph on the full canvas and only the left-edge reopen handle shown; the rail docks/reflows only after an explicit handle click.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-07-14T20:47:00Z
- **Completed:** 2026-07-14T20:53:00Z
- **Tasks:** 1
- **Files modified:** 3

## Accomplishments
- `corpus.js` `goToCorpus` no longer auto-docks the index rail; it now calls `ctx.showIndexHandle()`, which reveals only the slim left-edge reopen handle
- `index.js` adds the `ctx.showIndexHandle` hook: sets `isSidebarOpen = false`, calls `showReopenHandle(true)`, and `prepareIndex()` (preloads `/index` so the first real open is instant) — does not touch `container.style.display`, `body.index-docked`, or call `refitCorpus`
- Dock path (reopen-handle click → `openSidebar`) and the brain-return close path (`goToBrain` → `ctx.closeIndexSidebar()`) are unchanged
- Updated stale "opens by default" doc comments in `index.js` module header and `index.html` to describe the new default-closed behavior

## Task Commits

Each task was committed atomically:

1. **Task 1: Default-closed rail — show the reopen handle on corpus open instead of auto-docking (index.js + corpus.js + index.html)** - `694f08a` (feat)

_Note: single-task plan, one commit._

## Files Created/Modified
- `src/viz/modules/index.js` - Added `ctx.showIndexHandle` hook (handle-only reveal, no dock); updated module doc comment
- `src/viz/modules/corpus.js` - `goToCorpus` calls `ctx.showIndexHandle()` instead of `ctx.openIndexSidebar()`; updated adjacent comment
- `src/viz/index.html` - Updated `#index-panel` host comment to describe default-closed behavior

## Decisions Made
- `ctx.openIndexSidebar` is left exported (still the reopen-handle's click target via `openSidebar`) but is no longer auto-invoked on corpus entry — it's now a latent hook, not dead code, per plan instruction not to delete it.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- GAP-6 closed at the source-assertion/tsc/frontend-static-suite level. Behavioral verification (corpus opens closed with full-width graph + handle; handle click docks/reflows; brain return hides both) deferred to the 61-14 founder checkpoint per plan's `<verification>` section.

---
*Phase: 61-corpus-chrome-index-column-project-browsing*
*Completed: 2026-07-14*
