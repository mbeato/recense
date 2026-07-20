---
phase: 61-corpus-chrome-index-column-project-browsing
plan: 06
subsystem: ui
tags: [css, viz, corpus-graph, index-sidebar, design-tokens]

# Dependency graph
requires:
  - phase: 61-01
    provides: Glass reskin of #index-panel + tree-row CSS class scaffolding (.index-row/.index-entry/.index-chevron/.index-count)
  - phase: 61-05
    provides: Docked full-height sidebar layout (rail width/context the rows now sit in)
provides:
  - Refined .index-row/.index-chevron/.index-count/.index-entry typography, spacing, alignment and hover states (token-only)
  - Project rows and leaf-doc rows now share the same 5px vertical rhythm (equal row height)
  - Project name visually distinguished from leaf docs via font-weight, without touching structure or color
affects: [61-07, 61-09]

# Tech tracking
tech-stack:
  added: []
  patterns: ["Row-height parity enforced by matching v-padding across sibling row classes (.index-row / .index-entry) rather than a shared base class"]

key-files:
  created: []
  modified:
    - src/viz/css/styles.css

key-decisions:
  - "Used var(--text-data-value) (not var(--text-stat)) for the count badge — the plan flagged both as candidates and asked for the quieter of the two; text-data-value reads as a neutral readout rather than a stat-highlight color"
  - "Left .index-row:hover untouched structurally (background/color unchanged) per the plan's explicit instruction to leave headroom for GAP-3's .active state to out-rank it"

patterns-established:
  - "When two sibling row classes (folder-row vs leaf-row) need visual parity, align on the shared vertical-padding value rather than introducing a new shared selector — keeps each class's diff minimal and avoids selector-specificity churn"

requirements-completed: ["GAP-2"]

# Metrics
duration: 10min
completed: 2026-07-14
---

# Phase 61 Plan 06: Project-Row Design Refinement (GAP-2 Closure) Summary

**CSS-only refinement of the corpus index's project rows — aligned row height with leaf docs, trimmed the chevron hit box, weight-distinguished project names, and quieted the count badge — all token-routed, zero raw color literals, zero amber.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-07-14T21:09:00Z
- **Completed:** 2026-07-14T21:19:00Z
- **Tasks:** 1 completed
- **Files modified:** 1

## Accomplishments
- `.index-row` now carries the same 5px vertical padding as `.index-entry`, so project (folder) rows and leaf doc rows render at identical heights instead of two different row rhythms.
- Chevron hit box trimmed from 18px to 14px (toward the UI-SPEC ~11-12px glyph target) and kept vertically centered on the row baseline via the parent's `align-items:center`; `flex-shrink:0` added so it never compresses under long project names.
- Added `.index-row .index-entry { font-weight: 500; }` so the project name reads as a heavier "folder" than its leaf docs, with zero color change and zero structural HTML change (leaf `.index-entry` rows outside `.index-row` are unaffected).
- Count badge switched from `var(--text-stat)` to the quieter `var(--text-data-value)` and given `padding: 0 var(--radius-xs)` breathing room so it reads as a terse readout, not a loud pill.
- `.index-row` and `.index-chevron` transitions now reference `var(--motion-fast)` instead of a hardcoded `0.12s` literal, for consistency with the rest of the token vocabulary.
- Left `.index-row:hover` background/color and the chevron/count hover idiom untouched per the plan's instruction — no `.active` state added (explicitly reserved for GAP-3 / 61-07).
- `npx vitest run tests/viz-activity-palette-invariants.test.ts` — 45/45 passed (D-14-A raw-literal-ban and D-14-B amber-exclusivity locks both green).
- `npx tsc --noEmit` — clean, no new errors.
- Manual grep of the touched CSS blocks (`grep -nE '#[0-9a-fA-F]{3,8}|rgba?\('`) confirms zero raw color literals were introduced.

## Task Commits

Each task was committed atomically:

1. **Task 1: Refine project-row typography, spacing and alignment (token-only)** - `6fc7f87` (fix)

**Plan metadata:** committed separately (SUMMARY.md commit)

## Files Created/Modified
- `src/viz/css/styles.css` - Refined `.index-row`, `.index-chevron`, `.index-count` declarations and added `.index-row .index-entry` weight rule; no selector removed, no structural markup implied.

## Decisions Made
- Used `var(--text-data-value)` over `var(--text-stat)` for the count badge — plan offered both as candidates and asked for "the quieter of the two"; `text-data-value` (a neutral data-readout color) reads quieter than `text-stat` (a stat-highlight green) against the rail background.
- Did not add any `.active` styling or hover-strength change beyond swapping the hardcoded `0.12s` transition literal for `var(--motion-fast)` (same value, token-routed) — GAP-3's active/toggle state is explicitly out of scope per the plan.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- GAP-2 (default-looking row detailing) is closed: rows keep the chevron + count structure but now share consistent vertical rhythm, a tighter chevron hit box, weight-distinguished project names, and a quieter count readout — all token-routed, invariants suite green (45/45), tsc clean.
- Behavioral confirmation ("rows read as designed" visual judgment) is deferred to the closing founder checkpoint (61-09) per the plan's `<verification>` section — no blocker for 61-07 (GAP-3 active-state work touches the same `.index-row` block and can proceed on top of this).
- Explicit headroom left for 61-07's `.active` state: `.index-row:hover` was not strengthened, so an active-state rule can still visually out-rank hover.

---
*Phase: 61-corpus-chrome-index-column-project-browsing*
*Completed: 2026-07-14*

## Self-Check: PASSED

- FOUND: src/viz/css/styles.css
- FOUND: .planning/phases/61-corpus-chrome-index-column-project-browsing/61-06-SUMMARY.md
- FOUND: 6fc7f87 (Task 1 commit)
