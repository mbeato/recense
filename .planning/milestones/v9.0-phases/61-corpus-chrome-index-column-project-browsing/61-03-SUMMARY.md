---
phase: 61-corpus-chrome-index-column-project-browsing
plan: 03
subsystem: ui
tags: [vanilla-js, dom, corpus-viz, index-sidebar, tree-view]

# Dependency graph
requires:
  - phase: 61-01
    provides: ".index-row / .index-chevron / .index-count CSS (glass-reskinned #index-panel / #index-reopen)"
  - phase: 61-02
    provides: "ctx.focusCorpusProject and ctx.setCorpusProjectExpanded hooks on corpus.js (focus state machine, dim-others painting)"
provides:
  - "Collapsible index tree: projects render collapsed by default (chevron + name + doc-count badge), children gated behind an in-memory expandedIds Set"
  - "Project-name click wired to ctx.focusCorpusProject(scope) + auto-expand (D-03); chevron wired to ctx.setCorpusProjectExpanded(scope, expanded) as an independent stopPropagation'd hit target"
  - "Filter auto-expand: matched ancestors are unioned into expandedIds while a filter is active, without collapsing manually-expanded rows on clear"
affects: [61-04]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Cross-module ctx-hook consumption (index.js calls corpus.js-owned hooks via typeof === 'function' guard, never a direct import) — same idiom as the existing highlightCorpusNode/openReader/refitCorpus calls"
    - "Root-only tree collapsibility: renderTreeSection gates chevron+count treatment strictly at tree-root entries (those with children); nested descendants under an expanded root still render via the original flat emitLeaf walk — collapsibility is per-project, not per-intermediate-node"

key-files:
  created: []
  modified:
    - src/viz/modules/index.js

key-decisions:
  - "Full re-render on every expand/collapse toggle (setProjectExpanded calls renderSections()) instead of surgical DOM patching — simpler, and the tree is small enough (~dozens of rows) that a full rebuild is imperceptible; matches the file's existing re-render-on-filter pattern"
  - "Doc-count badge computed client-side as a recursive descendant count over the existing children map (with its own cycle-guard Set, mirroring the pre-existing `seen` guard) — no server payload change needed per the plan's PATTERNS.md note that /index already returns everything needed"
  - "Rephrased two explanatory comments to avoid the literal substring 'entry.scope' (originally used to warn against it) after discovering the plan's own verify grep (`! grep -q \"entry\\.scope\"`) matches comments too, not just code — kept the warning's intent while satisfying the automated check"

patterns-established:
  - "Project (tree-root-with-children) rows use a three-part flex .index-row wrapper (chevron button, name anchor, count badge) rather than the plain .index-entry anchor used by leaf/child rows — same hover/textContent discipline as the existing anchor builder, just structurally split"

requirements-completed: [D-01, D-03, D1, D2]

# Metrics
duration: ~20min
completed: 2026-07-14
---

# Phase 61 Plan 03: Collapsible Index Tree + Project-Focus Click Wiring Summary

**Index sidebar restructured from a flat wall-of-text into a collapsible Obsidian-style tree (chevron + count badge, gated child emission) with project-name clicks wired to focus the corpus graph via `entry.slug` as scope**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-14T18:54:00Z (approx, per STATE.md session start)
- **Completed:** 2026-07-14T19:13:26Z
- **Tasks:** 2 (implemented as one integrated edit — see Deviations)
- **Files modified:** 1

## Accomplishments
- Projects render collapsed by default (chevron ▶ + name + doc-count badge); doc rows are not emitted at all until expanded (fixes the D1 "huge thing of text" defect)
- Project-name click both expands the row AND calls `ctx.focusCorpusProject(scope)` in one click (D-03); chevron is an independent hit target (`ev.stopPropagation()`) that only toggles expand/collapse via `ctx.setCorpusProjectExpanded(scope, expanded)` — never triggers focus
- Both hooks are called with the project-root row's `entry.slug` as scope (the only field the `/index` payload actually carries) — the load-bearing D2 wiring the phase's central deliverable depends on
- Leaf doc rows are unchanged: still `ctx.openReader(slug, {from:'corpus'})`; hover on every row still calls `ctx.highlightCorpusNode`
- Filter auto-expand: typing in the filter force-expands any collapsed ancestor of a match (unioned into `expandedIds`); clearing the filter does not collapse rows the user separately expanded
- All rendered strings (project name, doc label, count integer) go through `.textContent` only — no `.innerHTML` with DB-sourced data (T-39-08)

## Task Commits

Both tasks were implemented as a single integrated edit (see Deviations) and committed together:

1. **Task 1 + Task 2: Collapsible tree render + project-click wiring** - `3b15b01` (feat)

## Files Created/Modified
- `src/viz/modules/index.js` - Added `expandedIds` Set, `ICON_CHEVRON_TOGGLE` constant, `setProjectExpanded`/`makeProjectRow` helpers, rewrote `renderTreeSection` to gate root-level child emission behind expansion state, extended `computeVisible` to force-expand filter-matched ancestors

## Decisions Made
- Full re-render (`renderSections()`) on every expand/collapse toggle rather than surgical DOM add/remove — the plan explicitly allowed either ("re-render (or surgically add/remove the child rows)"); chosen for simplicity and because the tree is small
- Doc-count badge is a client-side recursive descendant count over the existing parent/child map, not a server-side precomputed field — matches the plan's PATTERNS.md guidance that no server change is needed
- Two comments originally containing the literal string `entry.scope` (used to explain what NOT to write) were reworded, after the automated verify grep for Task 2 (`! grep -q "entry\.scope"`) flagged them as a false positive — the semantic warning is preserved without the literal substring

## Deviations from Plan

None — plan executed exactly as written, functionally. One process note: Task 1 (render restructure) and Task 2 (click wiring + filter auto-expand) were implemented and committed as a single atomic edit rather than two sequential commits, because the plan's own Task 1 action text already specifies chevron/count-badge rows with "the project click behavior added in Task 2" wired into the same `makeProjectRow`/`renderTreeSection` functions — splitting the diff into two commits would have required either a non-functional intermediate state (chevron with no toggle handler) or artificial back-editing. Both tasks' acceptance criteria are met in the one commit; verification for both was run and passed independently.

## Issues Encountered
- The Task 2 automated verify command (`! grep -q "entry\.scope"`) matches the whole file including comments, not just code. Two explanatory comments that used the literal string `entry.scope` to document what to avoid tripped this false positive. Reworded both comments (see Decisions) — no functional change, verify now passes clean.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Index-side D2/D3 browsing flow is fully wired: `npx tsc --noEmit` clean, both automated verify greps (`RENDER_OK`, `WIRE_OK`) pass, and the existing `tests/viz-activity-palette-invariants.test.ts` suite (45 tests) stays green (no CSS/constants touched by this plan).
- Behavioral verification (visual collapse/expand, graph focus, chevron non-propagation, reader round-trip) is deferred to the Plan 04 founder checkpoint per this plan's `<verification>` section — no blockers identified for that gate.

---
*Phase: 61-corpus-chrome-index-column-project-browsing*
*Completed: 2026-07-14*

## Self-Check: PASSED

- FOUND: src/viz/modules/index.js
- FOUND: .planning/phases/61-corpus-chrome-index-column-project-browsing/61-03-SUMMARY.md
- FOUND commit: 3b15b01 (feat)
- FOUND commit: b730332 (docs: summary)
