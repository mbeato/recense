---
phase: 61-corpus-chrome-index-column-project-browsing
plan: 05
subsystem: ui
tags: [css, viz, corpus-graph, index-sidebar, docked-layout]

# Dependency graph
requires:
  - phase: 61-01
    provides: index sidebar structure (#index-panel, tree rows, reopen handle)
  - phase: 61-02
    provides: index sidebar row/interaction behavior
  - phase: 61-03
    provides: initial .index-docked reflow plumbing (CSS rule + ctx.refitCorpus wiring)
provides:
  - Docked-rail visual/comment cleanup for #index-panel (no floating-overlay language remains)
  - Verified bidirectional canvas reflow (dock narrows canvas, collapse restores full width)
  - Clarifying comment on corpus.js sizeCorpusGraph documenting the clientWidth/index-docked relationship
affects: [61-06, 61-07, 61-08, 61-09]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Docked-sidebar CSS split via a body-level state class (.index-docked) offsetting a position:fixed sibling's `left`, paired with an explicit refit call after each class toggle"]

key-files:
  created: []
  modified:
    - src/viz/css/styles.css
    - src/viz/modules/corpus.js

key-decisions:
  - "Kept box-shadow: var(--glass-specular) on #index-panel — confirmed it's an inset specular highlight token (not an elevation drop-shadow), so it stays for glass-recipe parity with #detail/#hud-rail/#settings-panel/#reader per D-02"
  - "index.js openSidebar/hidePanel required no code changes — both already toggle .index-docked synchronously before the rAF-wrapped ctx.refitCorpus call in the correct order; verified by source read rather than assumed"

patterns-established:
  - "When documenting a docked-split layout, keep the comment on the position:fixed rail element pointing forward to the offset rule on the sibling, not just describing the rail in isolation"

requirements-completed: ["GAP-1"]

# Metrics
duration: 12min
completed: 2026-07-14
---

# Phase 61 Plan 05: Docked Index Rail (GAP-1 Closure) Summary

**Rewrote the stale #index-panel CSS comment that contradicted the already-shipped `.index-docked` reflow rule, and confirmed/documented that both CSS geometry and the JS dock/collapse toggle paths correctly produce a true docked-sidebar reflow (canvas narrows beside the rail when docked, returns to full width on collapse).**

## Performance

- **Duration:** 12 min
- **Started:** 2026-07-14T21:00:00Z
- **Completed:** 2026-07-14T21:12:00Z
- **Tasks:** 2 completed
- **Files modified:** 2

## Accomplishments
- `#index-panel`'s comment block no longer asserts "it does NOT reflow the canvas" — replaced with docked-rail language describing the actual `.index-docked #corpus-graph { left: var(--index-width) }` split, matching what 61-03 already shipped.
- Verified (not just asserted) that `#index-panel` geometry (full-height fixed rail, `border-right` divider, `box-shadow: var(--glass-specular)` inset highlight) needed no changes — the CSS was already correct, only the comment was stale.
- Verified `index.js` `openSidebar`/`hidePanel` already toggle `document.body.classList` `.index-docked` synchronously BEFORE the rAF-wrapped `ctx.refitCorpus()` call in both directions (dock via `openSidebar`, collapse/close via `hidePanel` → `collapseSidebar`/`closeIndexSidebar`) — so no code change was required there.
- Added a clarifying comment to `corpus.js` `sizeCorpusGraph` documenting that `container.clientWidth` intentionally reflects the `.index-docked` offset (narrower when docked, full width when collapsed).
- `npx vitest run tests/viz-activity-palette-invariants.test.ts` — 45/45 passed (D-14-A/B/C locks intact, no raw color literal introduced).
- `npx tsc --noEmit` — clean, no new errors.

## Task Commits

Each task was committed atomically:

1. **Task 1: Make #index-panel read as a flush docked rail and reflow the canvas both ways (CSS)** - `6547625` (fix)
2. **Task 2: Make the canvas reflow robust on dock AND collapse (index.js + corpus.js)** - `2f5c9aa` (docs)

**Plan metadata:** committed separately (SUMMARY.md commit)

## Files Created/Modified
- `src/viz/css/styles.css` - Replaced the stale "#index-panel overlays... does NOT reflow the canvas" comment with docked-rail/reflow-accurate language; no geometry, token, or selector changes.
- `src/viz/modules/corpus.js` - Added a one-line comment to `sizeCorpusGraph` explaining why `container.clientWidth` narrows/widens with `.index-docked`; no logic change.

## Decisions Made
- Left `#index-panel`'s `box-shadow: var(--glass-specular)` in place per the plan's explicit instruction (it's an inset specular highlight, not an elevation drop-shadow — removing it would break glass-recipe parity with the other D-02 surfaces).
- Did not modify `index.js` — read the current `openSidebar`/`hidePanel` implementations first and confirmed the class-toggle-then-rAF-refit ordering already satisfies the "reflow correctly in both directions" requirement, so no edit was made (avoids an unnecessary diff on already-correct code).

## Deviations from Plan

None - plan executed exactly as written. Task 2's `<action>` step 1/2 (index.js ordering) turned out to already be correct in the codebase; the plan itself anticipated this ("verify the ordering; if refit currently fires before the class add... move the refit") and the verification confirmed no fix was needed, so this is not a deviation — it's the plan's own conditional resolving to "no-op."

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- GAP-1 (floating-drawer paradigm gap) is closed: the index reads as a docked rail in both markup/CSS and the dock/collapse JS behavior, with automated verification (invariants suite, tsc) green.
- Behavioral confirmation (canvas visibly sits beside the rail, not underneath it) is deferred to the closing founder checkpoint (61-09) per the plan's `<verification>` section — no blocker for downstream plans 61-06 through 61-08, which touch the same index CSS/module for GAP-2 (row styling) and GAP-3 (active state).

---
*Phase: 61-corpus-chrome-index-column-project-browsing*
*Completed: 2026-07-14*

## Self-Check: PASSED

- FOUND: src/viz/css/styles.css
- FOUND: src/viz/modules/corpus.js
- FOUND: .planning/phases/61-corpus-chrome-index-column-project-browsing/61-05-SUMMARY.md
- FOUND: 6547625 (Task 1 commit)
- FOUND: 2f5c9aa (Task 2 commit)
- FOUND: aecb004 (SUMMARY.md commit)
