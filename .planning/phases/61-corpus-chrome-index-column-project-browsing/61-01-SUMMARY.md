---
phase: 61-corpus-chrome-index-column-project-browsing
plan: 01
subsystem: ui
tags: [css, design-tokens, glass-chrome, viz]

# Dependency graph
requires:
  - phase: 59-hud-integration
    provides: Phase-59 glass/token vocabulary (glass-bg-focused/ambient, glass-blur-md/sm, glass-specular, radius-lg/sm) and the D-14 CSS-invariants machine-lock in tests/viz-activity-palette-invariants.test.ts
provides:
  - "#index-panel reskinned to focused-tier glass (matches #detail)"
  - "#index-reopen reskinned to ambient-tier glass (matches #hud-rail)"
  - ".index-panel/.index-reopen added to the D-12 backdrop-filter ALLOWED_SELECTORS allow-list"
  - ".index-row/.index-chevron/.index-count tree-row CSS classes for the D-01 collapsible tree render"
affects: [61-corpus-chrome-index-column-project-browsing plan 03 (tree render consumes .index-row/.index-chevron/.index-count)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Glass-tier reskin follows the verbatim #detail (focused) / #hud-rail (ambient) recipe: background + backdrop-filter + -webkit-backdrop-filter + box-shadow:var(--glass-specular), all token-routed."
    - "New chrome elements added to ALLOWED_SELECTORS strictly two-at-a-time, never touching existing entries (D-12 allow-list discipline)."

key-files:
  created: []
  modified:
    - src/viz/css/styles.css
    - tests/viz-activity-palette-invariants.test.ts

key-decisions:
  - "Added -webkit-backdrop-filter alongside backdrop-filter on #index-panel/#index-reopen per plan action text, even though no other glass selector in styles.css (#detail, #hud-rail) currently carries the -webkit- prefix — plan instruction was explicit and unambiguous, followed as written."
  - "Left the unrelated #stats-view var(--surface-index-panel) reference untouched (Phase 60 deliberately-flat surface, explicitly excluded from the D-14-C allow-list) — out of this plan's surgical-diff scope."

patterns-established:
  - ".index-count uses margin-left:auto (not a fixed 8px) for auto-push-to-row-end, per plan's explicit either/or guidance."

requirements-completed: [D-02, D-08, D1]

# Metrics
duration: 5min
completed: 2026-07-14
---

# Phase 61 Plan 01: Corpus Index Chrome Glass Reskin Summary

**Reskinned #index-panel/#index-reopen into Phase-59 focused/ambient glass tiers and added .index-row/.index-chevron/.index-count tree-row classes for the Plan-03 collapsible tree, with zero new raw color literals and the D-14 invariants suite green (45/45).**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-07-14T18:54:21Z
- **Completed:** 2026-07-14T18:58:00Z
- **Tasks:** 2 completed
- **Files modified:** 2

## Accomplishments
- `#index-panel` now carries the same focused-tier glass recipe as `#detail`: `var(--glass-bg-focused)` background, `backdrop-filter: blur(var(--glass-blur-md))`, `box-shadow: var(--glass-specular)` — no longer a near-opaque flat slab.
- `#index-reopen` now carries the same ambient-tier glass recipe as `#hud-rail`: `var(--glass-bg-ambient)` background, `backdrop-filter: blur(var(--glass-blur-sm))`, `border-radius: var(--radius-sm)` token-routed.
- `ALLOWED_SELECTORS` in the D-14-C invariants test extended with exactly `#index-panel` and `#index-reopen` — no other entries touched, `#tooltip` glass-free assertion still passes.
- Three new token-only CSS classes (`.index-row`, `.index-chevron` + `.expanded` rotation state, `.index-count`) added for the Plan-03 tree render, reusing the existing `.index-entry:hover` hover idiom.
- Zero raw color literals introduced; zero new amber; existing `.index-entry` block left byte-identical (leaf doc rows unaffected).

## Task Commits

Each task was committed atomically:

1. **Task 1: Glass-reskin #index-panel + #index-reopen and extend the backdrop-filter allow-list** - `e5445b3` (feat)
2. **Task 2: Add collapsible tree-row CSS classes (chevron + row + count badge)** - `560a462` (feat)

**Plan metadata:** committed by orchestrator after wave completion (worktree mode — this agent does not write STATE.md/ROADMAP.md)

## Files Created/Modified
- `src/viz/css/styles.css` - `#index-panel`/`#index-reopen` glass-tier reskin (Task 1); new `.index-row`/`.index-chevron`/`.index-count` tree-row classes (Task 2)
- `tests/viz-activity-palette-invariants.test.ts` - `ALLOWED_SELECTORS` extended with `#index-panel`, `#index-reopen`

## Decisions Made
- Followed the plan's explicit instruction to add both `backdrop-filter` and `-webkit-backdrop-filter` on the two new selectors, even though the existing `#detail`/`#hud-rail` recipes being copied from omit the `-webkit-` prefix in this codebase. The plan text was unambiguous ("add `backdrop-filter: blur(...)` and `-webkit-backdrop-filter: blur(...)`"), so no deviation flag was needed — just noted here for future-plan awareness that the vendor-prefixed rule is now a first for this file.
- Used `margin-left: auto` for `.index-count` row-end push (plan explicitly offered this as an acceptable alternative to a fixed `8px`).

## Deviations from Plan

None — plan executed exactly as written. Both tasks' acceptance criteria were met on the first pass with no auto-fixes required.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `.index-row`/`.index-chevron`/`.index-count` classes exist and are verified token-only, ready for Plan 03's D-01 collapsible tree render to consume directly.
- D-14 invariants suite (45/45) and full `viz-*` regression suite (385/385 across 23 files) both green — no newly-failing viz test.
- `#index-panel`/`#index-reopen` now visually match the Phase-59 glass vocabulary; the "flat slab" half of founder defect D1 is closed (the "wall-of-text" half is Plan 03's scope).

---
*Phase: 61-corpus-chrome-index-column-project-browsing*
*Completed: 2026-07-14*
