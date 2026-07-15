---
phase: 61-corpus-chrome-index-column-project-browsing
plan: 10
subsystem: ui
tags: [css, viz, index-rail, design-guard]

# Dependency graph
requires:
  - phase: 61 (earlier plans, GAP-2)
    provides: .index-row / .index-entry row structure and hover/active background treatment
provides:
  - Square-edged (no border-radius) .index-row and .index-entry row surfaces
  - Durable in-code design-rule comment banning rounded row corners on the index rail
affects: [61-14 (founder re-verification checkpoint), any future index-rail row-surface CSS work]

# Tech tracking
tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified: [src/viz/css/styles.css]

key-decisions:
  - "Removed border-radius: 6px from .index-entry and .index-row only — .index-collapse (icon button) and .index-search-input (text input) were explicitly left untouched per plan scope."
  - "recense remember durable-rule write attempted 3x, all failed on 'Lock held by another process (sleep pass running?)' — the in-code CSS comment above .index-row is the load-bearing durable rule per plan's best-effort fallback instruction."

patterns-established:
  - "Index-rail row surfaces (.index-row/.index-entry) are permanently square-edged/full-bleed within the rail — border-radius is banned on these two selectors (GAP-5, founder-locked)."

requirements-completed: ["GAP-5"]

# Metrics
duration: ~10min
completed: 2026-07-14
---

# Phase 61 Plan 10: Remove Rounded Row Corners (GAP-5) Summary

**Removed `border-radius: 6px` from `.index-row` and `.index-entry` so project/doc rows render square-edged within the index rail, with a durable founder-locked no-rounded-rows comment guarding recurrence.**

## Performance

- **Duration:** ~10 min
- **Completed:** 2026-07-14
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- `.index-entry` and `.index-row` no longer have any `border-radius` declaration — hover/active backgrounds now render square-edged/full-bleed within the index rail.
- A durable design-rule comment was added directly above the `.index-row` block (extending the existing GAP-2 comment) stating verbatim that index-rail row surfaces are NEVER rounded, founder-locked GAP-5 "NEVER DO IT AGAIN."
- Hover/active background treatment, transitions, and the active-row `box-shadow: inset 2px 0 0 var(--text-mauve-rest)` left accent bar were left completely untouched — verified present post-edit.
- `.index-collapse` and `.index-search-input` (not row surfaces) retain their `border-radius: 6px` — confirmed untouched.

## Task Commits

Each task was committed atomically:

1. **Task 1: Remove row-surface border-radius (.index-row + .index-entry) and record the durable no-rounded-rows rule** - `385b695` (fix)

## Files Created/Modified
- `src/viz/css/styles.css` - Removed `border-radius: 6px` from `.index-entry` (~line 1419) and `.index-row` (~line 1439); added a durable no-rounded-rows design-rule comment above `.index-row`.

## Decisions Made
- Scope held strictly to the two row-surface selectors named in the plan; `.index-collapse` and `.index-search-input` radius left alone (out of GAP-5 scope, confirmed by grep post-edit).
- `recense remember` cross-project memory write was attempted per plan step 6 but failed all 3 attempts with "Lock held by another process (sleep pass running?)" — a live sleep pass was running concurrently on the shared brain.db. Per the plan's explicit best-effort fallback, this is noted here rather than blocking the task; the in-code CSS comment is the load-bearing durable rule and does not depend on the memory write succeeding.

## Deviations from Plan

None — plan executed exactly as written. The `recense remember` step (6) is documented above as a best-effort attempt that failed on a lock contention, which the plan explicitly anticipated ("best-effort; if the CLI is unavailable, note it in the SUMMARY").

## Issues Encountered
- `recense remember` CLI invocation failed 3 consecutive times with a lock-held error (a concurrent sleep pass holds the write lock on the shared brain.db). This does not block the plan's done criteria — the plan explicitly treats the in-code comment as the load-bearing durable rule. No retry loop was run beyond 3 attempts to avoid stalling the wave.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- GAP-5 is closed at the source level (CSS + durable comment); behavioral confirmation (rows read square-edged, hover/active still legible) is deferred to the 61-14 founder checkpoint per the plan's verification section.
- Follow-up (optional, non-blocking): re-run `recense remember` for the cross-project memory entry once no sleep pass is active, to get the belt-and-suspenders memory record in addition to the in-code comment.

---
*Phase: 61-corpus-chrome-index-column-project-browsing*
*Completed: 2026-07-14*
