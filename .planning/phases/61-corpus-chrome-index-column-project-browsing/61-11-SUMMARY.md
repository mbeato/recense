---
phase: 61-corpus-chrome-index-column-project-browsing
plan: 11
subsystem: ui
tags: [viz, force-graph, corpus, animation, gap-closure]

# Dependency graph
requires:
  - phase: 61 (prior plans in wave 1)
    provides: focusCorpusProject animated set branch (CORPUS_FOCUS_TRANSITION_MS idiom)
provides:
  - Animated unfocus (zoom-out) in focusCorpusProject(null), mirroring the existing focus animation
affects: [corpus viz, index sidebar row toggle, Esc-to-unfocus, canvas background click]

# Tech tracking
tech-stack:
  added: []
  patterns: [reuse existing zoomToFit + MAX_ZOOM clamp idiom for both focus and unfocus]

key-files:
  created: []
  modified: [src/viz/modules/corpus.js]

key-decisions:
  - "Unfocus branch mirrors the set branch's zoomToFit(CORPUS_FOCUS_TRANSITION_MS, 40, filter) + MAX_ZOOM clamp idiom exactly, using isNodeVisible as the full-visible-set filter instead of the project-scope filter."
  - "fitAndClamp() (the 0ms instant snap) is left untouched and still used by refitCorpus/onBeforeReveal/setCorpusProjectExpanded — only the null branch of focusCorpusProject stops calling it."

patterns-established:
  - "Focus/unfocus are treated as symmetric camera moves: same duration, same easing, same clamp guard, only the node filter differs (project scope vs full visible set)."

requirements-completed: ["GAP-7"]

# Metrics
duration: 10min
completed: 2026-07-15
---

# Phase 61 Plan 11: Animate Corpus Unfocus as Inverse of Focus (GAP-7) Summary

**Unfocus (active-row toggle, Esc, canvas click) now animates a zoom-out over the full visible set at `CORPUS_FOCUS_TRANSITION_MS`, mirroring the focus animation instead of snapping.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-07-15T00:35:00Z
- **Completed:** 2026-07-15T00:40:42Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- `focusCorpusProject(null)` no longer calls `fitAndClamp()` (the 0ms instant snap); it now calls `CorpusGraph.zoomToFit(CORPUS_FOCUS_TRANSITION_MS, 40, isNodeVisible)` followed by the same `MAX_ZOOM` clamp tail used by the focus (set) branch.
- Focus and unfocus are now symmetric camera moves — same duration/easing, only the node filter differs (project-scope filter for focus, full-visible-set filter for unfocus).
- Updated the `focusCorpusProject` doc comment to describe the animated unfocus behavior and cite GAP-7.

## Task Commits

Each task was committed atomically:

1. **Task 1: Animate the unfocus branch as the inverse of focus (corpus.js focusCorpusProject null branch)** - `8e58fba` (feat)

**Plan metadata:** committed alongside this SUMMARY (worktree mode — orchestrator handles final metadata commit after merge)

## Files Created/Modified
- `src/viz/modules/corpus.js` - `focusCorpusProject(null)` branch now animates a zoom-out (`CorpusGraph.zoomToFit(CORPUS_FOCUS_TRANSITION_MS, 40, isNodeVisible)` + `MAX_ZOOM` clamp) instead of calling `fitAndClamp()`'s instant snap.

## Decisions Made
- Kept `fitAndClamp()` unchanged and still in use by `refitCorpus`, `onBeforeReveal`, and `setCorpusProjectExpanded` — those callers intentionally want the 0ms instant frame (first paint / re-fit on resize), only the interactive unfocus gesture gets the animated treatment.
- Reused the exact `try/catch` + `MAX_ZOOM` clamp idiom from the set branch rather than introducing a new helper, per the plan's constraint to reuse the existing pattern with no new abstractions for a single call site.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- GAP-7 closed; automated source assertion and full corpus-graph test suite (27/27) pass; `tsc --noEmit` clean.
- Behavioral verification (camera glide feel, same speed/easing as focus) deferred to the 61-14 founder checkpoint per the plan's verification section.

---
*Phase: 61-corpus-chrome-index-column-project-browsing*
*Completed: 2026-07-15*
