---
phase: 61-corpus-chrome-index-column-project-browsing
plan: 07
subsystem: ui
tags: [viz, corpus-index, focus-state, css-tokens, gap-closure]

# Dependency graph
requires:
  - phase: 61-06
    provides: index-row visual refinement (hover idiom, vertical rhythm) that the active state extends
  - phase: 61-08
    provides: (parallel wave-3 plan) no direct code dependency, listed as depends_on for sequencing
provides:
  - Two-way focus/active sync between the index sidebar and the corpus graph
  - Click-to-toggle-unfocus on the already-active project row
  - A visible, non-amber active-row state (token-routed)
affects: [61-09-founder-checkpoint, viz-corpus-index]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ctx-hook cross-module sync: index.js owns ctx.syncCorpusFocus, corpus.js calls it (guarded) on every real focusedScope change"
    - "HUD_CSS_TOKENS key -> emitHudTokens() -> var(--token) in styles.css, zero raw literals"

key-files:
  created: []
  modified:
    - src/viz/modules/index.js
    - src/viz/modules/corpus.js
    - src/viz/css/styles.css
    - src/viz/modules/constants.js

key-decisions:
  - "Toggle-off does not collapse the row (collapse stays chevron-owned) — only clears activeScope and calls focusCorpusProject(null)"
  - "Sync notify skipped on the ignored-unrecognized-scope early-return path in focusCorpusProject (nothing changed, no ping-pong)"
  - "Active-row marker: box-shadow inset 2px left accent bar (var(--text-mauve-rest)) + var(--index-row-active-bg) (0.22 mauve, stronger than the 0.12 hover tint) + var(--text-bright) text"

patterns-established:
  - "Active-row read: .index-row.active + .index-row.active:hover pinned to the same background so hover never erases the active state"

requirements-completed: ["GAP-3"]

# Metrics
duration: 20min
completed: 2026-07-14
---

# Phase 61 Plan 07: Corpus Index Active-Project Focus Sync Summary

**Focused project's index row now shows a token-routed active state and toggles focus off on re-click, with corpus.js pushing every focus change (set/clear/Esc/background-click) back into the index via a new `ctx.syncCorpusFocus` hook.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-07-14T21:00:00Z (approx)
- **Completed:** 2026-07-14T21:21:00Z
- **Tasks:** 2/2 completed
- **Files modified:** 4

## Accomplishments
- Two-way ctx-hook sync closes GAP-3: the graph-focus state and the index active-row state can never drift apart, regardless of which direction focus changed from (row click, canvas-click, Esc).
- Click-to-toggle-unfocus gives the founder-requested discoverable exit from focus without adding graph chrome or a back button.
- Active state is a strict token extension of the existing hover idiom (stronger mauve + left accent bar), zero amber, out-ranks hover.

## Task Commits

1. **Task 1: Active-project tracking, click-to-toggle-unfocus, and focus-state sync (index.js + corpus.js)** - `87c10c2` (feat)
2. **Task 2: Active-row visual state (styles.css + constants.js token)** - `29fe2de` (feat)

**Plan metadata:** (this commit, docs)

## Files Created/Modified
- `src/viz/modules/index.js` - module-scoped `activeScope`; name-click toggles focus off when clicking the already-active row (else focuses + tracks new active scope); `makeProjectRow` renders `.active` class + `aria-current="true"`; registers `ctx.syncCorpusFocus` to receive focus-change notifications from corpus.js
- `src/viz/modules/corpus.js` - `ctx.focusCorpusProject` now calls `ctx.syncCorpusFocus(focusedScope)` on both the clear branch and the set branch (guarded, skipped on the ignored-unrecognized-scope no-op path); `onBackgroundClick` and the Esc listener already route through `focusCorpusProject(null)` so they get the notify for free
- `src/viz/css/styles.css` - added `.index-row.active` / `.index-row.active:hover` (stronger mauve background, brighter text, inset left accent bar), placed after the existing `.index-row:hover` rule so it out-ranks hover
- `src/viz/modules/constants.js` - added `HUD_CSS_TOKENS['index-row-active-bg']` (`rgba(139, 112, 144, 0.22)`), auto-emitted as a `:root` var by the existing `emitHudTokens()` — no new emission code needed

## Decisions Made
- Toggle-off leaves the row's expanded/collapsed state untouched — collapse remains exclusively chevron-owned, matching the plan's explicit guardrail.
- The sync notify is skipped only on the truly-no-op path (an unrecognized scope passed to `focusCorpusProject`, where `focusedScope` never changes) to avoid any risk of a notify ping-pong; every real state transition (clear, set) notifies.
- Active-row marker chosen as `box-shadow: inset 2px 0 0 var(--text-mauve-rest)` (one of the two plan-offered options) rather than `border-left`, since `box-shadow` doesn't perturb layout/box-sizing on a flex row with existing padding.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- GAP-3 code changes are done and machine-verified (tsc clean, grep gates pass, `tests/viz-activity-palette-invariants.test.ts` 45/45 green).
- Behavioral verification (does the active state read clearly, does toggle/Esc/canvas-click actually feel right) is explicitly deferred to the 61-09 founder checkpoint per the plan's `<verification>` section — this plan only covers the automated/source-level gates.
- No blockers for 61-08 (parallel wave-3 plan) or 61-09 (founder checkpoint, which should now exercise the toggle behavior live).

---
*Phase: 61-corpus-chrome-index-column-project-browsing*
*Completed: 2026-07-14*

## Self-Check: PASSED

- FOUND: src/viz/modules/index.js
- FOUND: src/viz/modules/corpus.js
- FOUND: src/viz/css/styles.css
- FOUND: src/viz/modules/constants.js
- FOUND commit: 87c10c2 (Task 1)
- FOUND commit: 29fe2de (Task 2)
