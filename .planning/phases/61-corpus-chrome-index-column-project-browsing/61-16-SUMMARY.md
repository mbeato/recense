---
phase: 61-corpus-chrome-index-column-project-browsing
plan: 16
subsystem: viz-corpus-index
tags: [floating-panel, gap-9, css-glass, pointer-drag, checkpoint-issues]
requires:
  - "61-14 (round-2 GAP-5..8 closure; GAP-9 raised at that sign-off)"
provides:
  - "#index-panel restyled from docked full-height rail to a rounded, bordered, glass floating window (styles.css)"
  - "header pointerdown/pointermove/pointerup drag wiring with viewport clamp + in-memory panelPos (index.js)"
  - "openSidebar/hidePanel no longer toggle .index-docked or call refitCorpus — graph keeps full canvas"
affects:
  - "src/viz/css/styles.css"
  - "src/viz/modules/index.js"
tech-stack:
  added: []
  patterns:
    - "Floating-window glass chrome reused from the #detail focused-glass recipe (border-radius + full border + backdrop-filter) instead of the edge-only docked-rail border"
    - "Native Pointer Events drag (setPointerCapture) mirroring graph.js's existing idiom — net-zero deps"
key-files:
  created: []
  modified:
    - "src/viz/css/styles.css"
    - "src/viz/modules/index.js"
decisions:
  - "Task 3 checkpoint resolved as 'issues reported' rather than approval — founder rejected the floating-over-canvas paradigm itself, not a tuning detail, so per the plan's Rule 4 the feedback is captured as a new UAT gap (GAP-10) instead of hand-patched at the checkpoint"
  - "GAP-9 marked superseded (not re-opened as failed) — its 'own chrome, draggable, no-longer-bare' truths are preserved and carry forward into GAP-10; only the floating/overlay positioning strategy is superseded by the docked-left-panel direction"
  - "Tasks 1-2's floating-window CSS/JS build is left merged as-is (no revert) — it is the substrate the GAP-10 follow-up plan will rework into a docked layout, not a false start"
requirements-completed: []  # GAP-9 superseded by GAP-10, not completed — founder rejected the floating-panel result at Task 3 sign-off; see Decisions Made
metrics:
  duration: "~5min (Tasks 1-2 executed in a prior session; this continuation only resolved the Task 3 checkpoint)"
  completed: "2026-07-16"
---

# Phase 61 Plan 16: Floating Index Panel (GAP-9) Summary

Built the GAP-9 detached floating index panel (rounded glass window, grab-cursor draggable header, no canvas reflow) exactly as specified, but the founder's live-install sign-off rejected the floating-over-the-graph paradigm itself and asked for a docked left panel outside the canvas instead — captured as GAP-10, not hand-patched.

## Performance

- **Duration:** ~5 min (continuation session; Tasks 1-2 were executed and committed in a prior session)
- **Completed:** 2026-07-16
- **Tasks:** 3 (2 auto tasks executed + verified; 1 checkpoint resolved to "issues reported")
- **Files modified:** 2 (styles.css, index.js) + 61-UAT.md (gap tracking, this continuation)

## Accomplishments
- `#index-panel` converted from a full-height docked rail to a rounded, bordered, glass floating window (reusing the `#detail` focused-glass recipe), with the `.index-docked #corpus-graph` reflow rule removed so the graph always keeps the full canvas.
- Header made a functional drag grip: native Pointer Events (`pointerdown`/`pointermove`/`pointerup` + `setPointerCapture`) drag the panel, clamped to stay on-screen, ignoring clicks on `.index-collapse` so the close button still works. Position persists in a module-scoped `panelPos` (in-memory only, no `localStorage`).
- `openSidebar()`/`hidePanel()` no longer toggle `.index-docked` or call `ctx.refitCorpus()` — opening/closing the panel is now a pure opacity fade with zero canvas re-fit.
- Founder live-install sign-off (Task 3) surfaced a rejection of the floating-over-canvas result itself ("index on top of graph is still out of place needs to be outside the window as a left panel but still attached to the main window") — recorded as GAP-10 in `61-UAT.md` per the plan's Rule 4, instead of hand-patched at the checkpoint.

## Task Commits

Each task was committed atomically:

1. **Task 1: Restyle #index-panel from docked rail to a floating window; stop the canvas reflow (CSS)** - `0537ea9` (feat)
2. **Task 2: Mount the panel as a floating window and make the header draggable (JS)** - `8a1c636` (feat)
3. **Task 3: Founder live-install sign-off (checkpoint)** - resolved this continuation session: issues reported, not approved. Captured as GAP-10 in `61-UAT.md`.

**Plan metadata:** (this commit) — docs: record GAP-10, close plan 61-16

## Files Created/Modified
- `src/viz/css/styles.css` - `#index-panel` floating-window chrome (offset position, bounded height, full rounded border, grab-cursor header); `.index-docked #corpus-graph` reflow rule removed.
- `src/viz/modules/index.js` - header pointer-drag wiring, in-memory `panelPos`, `openSidebar`/`hidePanel` reflow calls removed.
- `.planning/phases/61-corpus-chrome-index-column-project-browsing/61-UAT.md` - GAP-9 marked `superseded`; GAP-10 added with founder's verbatim feedback and the docked-left-panel direction (this continuation, no src/ changes).

## Decisions Made
- Task 3 checkpoint resolved as "issues reported" per the plan's own instruction (Rule 4: structural feel changes get their own follow-up plan, not hand-patched at the checkpoint). The founder's feedback — "outside the window as a left panel but still attached to the main window" — is a rejection of the floating/overlay paradigm itself (a structural reversal of the "no canvas reflow" premise this very plan built), not a positioning tweak that could be resolved inline.
- GAP-9 is marked `superseded` rather than reopened as `failed`: its underlying truths (own chrome, draggable, no-longer-bare) are not wrong — they carry forward — only the "floating over the graph" positioning strategy is superseded by GAP-10's docked-left-panel requirement.
- No revert of Tasks 1-2's floating-window build. The CSS/JS from this plan (glass chrome, drag wiring, panelPos) is left merged; it is the substrate a GAP-10 follow-up plan will rework into a docked side-by-side layout, not a false start to be thrown away.

## Deviations from Plan

None - Tasks 1-2 executed exactly as written (verified via prior-session commits `0537ea9`/`8a1c636`, both tagged `feat(61-16)`). Task 3 followed the plan's own checkpoint resolution rule for founder-reported issues: capture as a new UAT gap, do not hand-patch source in response to the checkpoint.

## Issues Encountered

The founder's live-install sign-off (Task 3) did not approve — see `<user_response>` context. This is not a plan-execution problem; it is the exact scenario the plan's Task 3 `<action>` anticipates ("Capture any issues ... as new UAT gaps rather than hand-patching at the checkpoint"). Resolved by recording GAP-10 in `61-UAT.md` with the founder's verbatim quote, the docked-left-panel interpretation, and scope hints for the follow-up plan. No `src/` files were touched in this continuation.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 61 is NOT yet fully signed off. GAP-10 is open and requires a round-4 follow-up plan: rework `#index-panel` from the floating-window paradigm (this plan) into a docked left panel/column that lives outside the graph canvas but is attached to the main app window, with the graph canvas reflowing to sit beside it (reversing this plan's "no reflow" premise). The follow-up plan should treat Tasks 1-2's floating-window CSS/JS as the surface to rework, not a from-scratch build — see GAP-10's `scope_hint` in `61-UAT.md` for the specific rules likely needing rework (`.index-docked` class removal, `refitCorpus()` calls, drag wiring's continued relevance to a fixed docked panel).

---
*Phase: 61-corpus-chrome-index-column-project-browsing*
*Completed: 2026-07-16*
