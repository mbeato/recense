---
phase: 61-corpus-chrome-index-column-project-browsing
plan: 18
subsystem: viz-corpus-index
tags: [docked-panel, gap-10, css-glass, reflow, checkpoint-pending]

requires:
  - phase: "61-17"
    provides: "GAP-7 animated-clamp fix + GAP-8 /graph UUID scrub (live, no-regression baseline for this plan's checkpoint)"
  - phase: "61-16"
    provides: "Detached floating #index-panel CSS/JS (GAP-9) — the substrate this plan reworked into a docked layout, per 61-16-SUMMARY.md's own next-steps note"
provides:
  - "#index-panel restyled from a rounded, bordered, glass floating window back to a docked full-height glass LEFT column flush to the window's left edge (styles.css)"
  - ".index-docked #corpus-graph reflow rule reinstated so the graph sits BESIDE the docked column"
  - "openSidebar/hidePanel toggle body.index-docked + call ctx.refitCorpus (guarded) so open/close reflows the canvas"
  - "GAP-9 header pointer-drag wiring, panelPos state, and the dead ctx.openIndex alias fully removed"
affects:
  - "src/viz/css/styles.css"
  - "src/viz/modules/index.js"
  - "src/viz/index.html"

tech-stack:
  added: []
  patterns:
    - "Docked-column + body-class reflow (body.index-docked toggled by index.js, consumed by both a CSS descendant selector and corpus.js's pre-existing ctx.refitCorpus hook) replaces the GAP-9 floating-window/no-reflow pattern"

key-files:
  created: []
  modified:
    - "src/viz/css/styles.css"
    - "src/viz/modules/index.js"
    - "src/viz/index.html"

key-decisions:
  - "Reworked the 61-16 floating-window CSS/JS in place rather than rebuilding from scratch, per 61-16-SUMMARY.md's own next-steps note and the plan's <interfaces> section — corpus.js's ctx.refitCorpus/sizeCorpusGraph/goToCorpus were left untouched since they already carried the (dormant) docked-reflow contract from before GAP-9"
  - "Task 3 (founder live-install sign-off) is a genuine checkpoint:human-verify that cannot be automated inside this isolated parallel worktree — the actual live install is the founder's running macOS tray app on the merged main branch, not this worktree checkout. Per checkpoints.md ('never present a checkpoint with broken verification environment'), the automatable prerequisite (npm run build) was run and confirmed clean in this worktree, but the founder-facing verification itself is deferred to post-merge, as instructed by the orchestrator's checkpoint protocol."

requirements-completed: []  # GAP-10 requires founder live-install sign-off (Task 3, unresolved) before it can be marked complete — see 61-UAT.md

duration: "~25min (Tasks 1-2, automated verification, and build check)"
completed: "2026-07-17"
---

# Phase 61 Plan 18: Docked Left Index Column (GAP-10) Summary — CHECKPOINT PENDING

**Reworked #index-panel from the GAP-9 detached floating window back into a docked full-height glass LEFT column flush to the window edge, with `.index-docked #corpus-graph` reflow reinstated so the corpus graph cedes width and sits beside the panel — the founder's twice-rejected floating-over-canvas layout is gone. Tasks 1-2 are complete and committed; Task 3 (founder live-install sign-off) is a blocking checkpoint that has NOT been resolved — no approval has been given or fabricated.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 2 of 3 completed (Task 3 is the pending checkpoint)
- **Files modified:** 3 (styles.css, index.js, index.html) + deferred-items.md (bookkeeping, no src/ change)

## Accomplishments

- `#index-panel` converted from the GAP-9 rounded/bordered/offset floating window (`top:56px; left:16px; max-width:60vw; max-height:calc(...); border-radius:var(--radius-lg); border: 1px solid ...`) to a docked full-height column (`top:0; left:0; bottom:0; width:var(--index-width); border-right: 1px solid var(--glass-border-focused)`) — flush to the window's left edge, no rounded-window chrome.
- `.index-docked #corpus-graph { left: var(--index-width); }` reflow rule reinstated (was removed in 61-16/GAP-9) so the graph visibly cedes width to the docked column instead of being covered by it.
- Header drag-grip cursor (`cursor: grab` / `.dragging` → `cursor: grabbing`) removed — the header is now a static title bar (title + collapse button only).
- `openSidebar()`/`hidePanel()` re-wired to toggle `document.body.classList.add/remove('index-docked')` and call the pre-existing `ctx.refitCorpus()` hook (guarded by `typeof` check) so opening/closing the panel actively resizes and re-fits the corpus graph canvas.
- GAP-9 drag machinery fully removed from `index.js`: the `dragStart` variable, all four `pointerdown`/`pointermove`/`pointerup`/`pointercancel` handlers, `setPointerCapture`/`releasePointerCapture`, the `dragging` class toggle, the clamp math, and the module-scoped `panelPos` state (and its apply-on-open block).
- Dead `ctx.openIndex` alias removed (zero callers per 61-REVIEW.md IN-02); `ctx.openIndexSidebar`/`ctx.closeIndexSidebar` unchanged.
- Module header comment (index.js) and the `#index-panel` host comment (index.html) both updated from the "floating panel, never reflows" description to the docked-left-column paradigm.
- All inner index behavior (collapsible tree, project name-click focus, active row, filter, hover highlight, Esc-exit via corpus.js, the reopen handle, GAP-6 default-closed) preserved untouched — `renderSections`/`makeProjectRow`/`computeVisible`/`syncCorpusFocus` were not modified.
- `npm run build` (tsc + viz-asset copy) runs clean in this worktree — the automatable prerequisite for the founder's live-install checkpoint is satisfied here; the actual founder verification happens post-merge on the running app.

## Task Commits

1. **Task 1: Rework #index-panel from floating window to docked left column + reinstate the canvas reflow (CSS)** — `0c43981` (feat)
2. **Task 2: Re-wire the dock reflow trigger and remove the floating drag machinery (JS)** — `c7fe10e` (feat)
3. **Task 3: Founder live-install sign-off on the docked left index panel (GAP-10)** — **NOT STARTED / PAUSED HERE.** This is a `checkpoint:human-verify` (`gate="blocking"`) requiring the founder's live macOS install verification. No approval has been given; none is fabricated. See "Next Phase Readiness" below.

**Bookkeeping commit (deferred-items.md re-confirmation):** `fbb5f7b` (docs)

## Files Created/Modified

- `src/viz/css/styles.css` — `#index-panel` docked-left-column geometry (top:0/left:0/bottom:0, edge-only `border-right`, no `border-radius`); `.index-docked #corpus-graph` reflow rule reinstated; drag-cursor rules removed; GAP-9 "DO NOT re-dock" comment replaced with a GAP-10 docked-paradigm note. GAP-5 square-edge block (`.index-row`/`.index-entry`) untouched — verified zero `border-radius` hits in that section.
- `src/viz/modules/index.js` — `openSidebar`/`hidePanel` toggle `body.index-docked` + guarded `ctx.refitCorpus()` calls; header pointer-drag wiring, `panelPos` state, and the dead `ctx.openIndex` alias removed; module header comment updated.
- `src/viz/index.html` — `#index-panel` host comment updated from the floating-panel description to the docked-left-column paradigm.

## Decisions Made

- Reworked the existing 61-16 floating-window CSS/JS in place (per the plan's `<interfaces>` section and 61-16-SUMMARY.md's own next-steps note) rather than rebuilding from scratch — `corpus.js`'s `ctx.refitCorpus`/`sizeCorpusGraph`/`goToCorpus` needed zero changes since they already carried the dormant docked-reflow contract from before GAP-9 and were simply re-wired live by index.js's class toggle.
- Task 3's founder live-install sign-off cannot be resolved inside this isolated parallel worktree — the founder's actual running macOS tray app lives on the merged main branch, not this worktree checkout. The automatable prerequisite (`npm run build`) was run and confirmed clean here so the merged build is ready for the founder to verify; the live-install verification itself is a genuine `checkpoint:human-verify` that must happen post-merge, per this plan's own explicit instruction ("do NOT auto-advance ... the index layout has been rejected twice this phase") and the orchestrator's checkpoint protocol.

## Deviations from Plan

None - Tasks 1 and 2 executed exactly as written; all acceptance criteria for both tasks verified via grep/vitest/tsc as specified in the plan (see Verification below). No Rule 1-4 deviations were triggered.

## Verification Results (Tasks 1-2)

- `npx vitest run tests/viz-activity-palette-invariants.test.ts` — 45/45 passed (D-14 raw-literal/amber/backdrop-filter invariants intact).
- `npx vitest run tests/viz-frontend-static.test.ts` — 52/52 passed.
- `npx vitest run tests/viz-frontend-static.test.ts tests/viz-index-route.test.ts tests/viz-corpus-graph.test.ts` — 112/112 passed.
- `npx tsc --noEmit` — clean.
- `npm run build` — clean (tsc + viz-asset copy to dist/src/viz/).
- `grep -n "index-docked #corpus-graph" src/viz/css/styles.css` — reflow rule present (line 1309).
- `grep -n "cursor: grab" src/viz/css/styles.css` — zero hits (drag-grip cursor removed).
- `grep -n "border-radius" src/viz/css/styles.css` scoped to the GAP-5 `.index-row`/`.index-entry` block — zero hits (square-edge rule preserved).
- `grep -n "index-docked" src/viz/modules/index.js` — class add/remove present in openSidebar/hidePanel.
- `grep -n "refitCorpus" src/viz/modules/index.js` — guarded calls present in both openSidebar and hidePanel.
- `grep -nE "pointer(down|move|up|cancel)|setPointerCapture|panelPos|classList.add\('dragging'\)|dragging" src/viz/modules/index.js` — zero hits (drag machinery fully removed).
- `grep -n "ctx.openIndex\b" src/viz/modules/index.js` — zero hits (dead alias removed); `ctx.openIndexSidebar` still present.
- `grep -n "collapse.addEventListener('click', collapseSidebar)" src/viz/modules/index.js` — present (collapse wiring intact).
- `grep -n "localStorage" src/viz/modules/index.js` — only a comment reference ("never localStorage"), no actual persistence added.
- Full `npx vitest run` suite: 23 pre-existing failures across 7 unrelated test files (adapter-capture, adapter-inject, episodic-dryrun-gate, eval-harness-smoke, locomo-harness, locomo-latency-curve, locomo-scorer) — traced to a missing `dist/cli.js` build artifact in this worktree, unrelated to any file this plan touched. Already logged under 61-08/61-17 in `deferred-items.md`; re-confirmed under a new 61-18 entry this plan. Out of scope, not fixed.

## Known Stubs

None.

## Threat Flags

None — this plan touches positioning/chrome + open/close wiring only, as scoped in the plan's threat model (T-61-18-01/02/03). No new DOM-rendering paths, no new trust boundaries.

## Issues Encountered

None during Tasks 1-2. Task 3 is intentionally unresolved — see Decisions Made.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

**Phase 61 is NOT yet fully signed off.** Task 3 (founder live-install sign-off) is a blocking `checkpoint:human-verify` and has not been presented to or resolved by the founder in this session. The orchestrator (after merging this worktree branch) must:

1. Rebuild the packed viz assets on the merged main branch (`npm run build`).
2. Present the docked-left-panel build to the founder using the plan's `<how-to-verify>` steps (open corpus view → confirm index CLOSED by default → click reopen handle → confirm docked LEFT PANEL with graph reflowing beside it, NOT floating on top → collapse → confirm graph re-expands → no-regression pass on GAP-1..8/D1-D4 → resize check).
3. Capture the founder's response: if approved, mark GAP-10 resolved and requirement `GAP-10` complete; if issues are reported, capture as new UAT gaps per the plan's own Rule 4 instruction ("Capture any remaining issues as new UAT gaps rather than hand-patching at the checkpoint") — do not hand-patch source in response to checkpoint feedback.

This SUMMARY.md documents Tasks 1-2 as complete and committed; it will need a follow-up update (or a superseding SUMMARY) once Task 3 is resolved, mirroring how `61-16-SUMMARY.md` was finalized in a continuation session after its own checkpoint resolution.

## Self-Check: PASSED

- FOUND: src/viz/css/styles.css
- FOUND: src/viz/modules/index.js
- FOUND: src/viz/index.html
- FOUND commit: 0c43981
- FOUND commit: c7fe10e
- FOUND commit: fbb5f7b

---
*Phase: 61-corpus-chrome-index-column-project-browsing*
*Status: CHECKPOINT PENDING (Task 3 of 3) — not yet complete*
