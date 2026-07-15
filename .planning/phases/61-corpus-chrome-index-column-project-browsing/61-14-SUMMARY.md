---
phase: 61-corpus-chrome-index-column-project-browsing
plan: 14
subsystem: ui
tags: [viz, corpus, index-rail, founder-checkpoint, css-tokens]

# Dependency graph
requires:
  - phase: 61-10..61-13
    provides: "GAP-5..8 structural closures (square rows, default-closed rail, animated unfocus, legible schema titles)"
provides:
  - "Founder round-2 live-install sign-off: GAP-5..8 confirmed resolved, GAP-1..4/D1-D4 confirmed no regression"
  - "Closes the still-open 61-09 checkpoint (which itself superseded the 61-04 checkpoint)"
  - "GAP-9 captured in 61-UAT.md — detached floating index panel, new round-3 item"
affects: [61-corpus-chrome-index-column-project-browsing round-3 planning]

# Tech tracking
tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - .planning/phases/61-corpus-chrome-index-column-project-browsing/61-UAT.md

key-decisions:
  - "The four CORPUS_* feel constants ratchet at their round-1 shipped values (no change) — founder felt no tuning was needed."
  - "GAP-9 (detached floating index panel) is a structural/architectural change, not a feel-value tune — captured as a new UAT gap for its own plan rather than hand-patched at this checkpoint."

patterns-established: []

requirements-completed: ["GAP-5", "GAP-6", "GAP-7", "GAP-8"]

# Metrics
duration: ~15min
completed: 2026-07-14
---

# Phase 61 Plan 14: Round-2 Closing Founder Sign-Off Summary

**Founder confirmed GAP-5..8 resolved and GAP-1..4/D1-D4 no-regression on the live install with zero feel-constant tuning; one new structural item (GAP-9, detached floating index panel) was raised and captured for round-3.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-07-14T21:45:00Z
- **Completed:** 2026-07-14T22:15:00Z
- **Tasks:** 1 (checkpoint:human-verify)
- **Files modified:** 1 (`61-UAT.md`)

## Accomplishments

- Founder live-install verification confirmed all four round-2 gaps resolved:
  - **GAP-5** (square rows): no rounded corners on project/doc rows, hover/active surfaces square-edged.
  - **GAP-6** (default-closed rail): corpus opens with the index rail closed, graph gets full canvas, rail opens only via the left-edge handle.
  - **GAP-7** (animated unfocus): exiting focus via active-row toggle, Esc, or canvas click all animate the zoom-out — same duration/easing as focus-in, no snap.
  - **GAP-8** (legible schema rows): schema titles are human-readable (no raw UUIDs); nested-schema section reads clearly under its chosen label ("Notes").
- Founder re-confirmed GAP-1..4 (docked rail reflow, intentionally-designed rows, active-row toggle sync, schemas nested under project) and D1-D4 (glass navigable tree, project focus browsing, declutter, reader round-trip incl. Esc-close-reader-while-focused) all still hold — no regression from the GAP-5..8 closure work.
- No feel-constant tuning was requested — the four `CORPUS_*` constants remain at their round-1 shipped values, now founder-approved as final rather than provisional:
  - `CORPUS_FOCUS_DIM_OPACITY = 0.18`
  - `CORPUS_HOVER_DIM_OPACITY = 0.30`
  - `CORPUS_LABEL_ZOOM_THRESHOLD = 1.2`
  - `CORPUS_FOCUS_TRANSITION_MS = 500`
- Verification note: the founder's first pass hit stale packed-app assets (the checkpoint required `npm run build` before the live install reflected the round-2 closure work) — resolved by the orchestrator rebuilding dist before the founder re-checked.
- **This SUMMARY closes the still-open 61-09 checkpoint** (which itself superseded the 61-04 checkpoint) — 61-09/61-04 need not be executed separately; their D1-D4 and GAP-1..4 truths are now confirmed current as of this re-run.
- **New item — GAP-9 captured, not resolved here:** the founder raised, unprompted while re-verifying GAP-6, that the closed-rail corpus view "feels bare without the index drawer but having it on top of the corpus graph still feels wrong." Clarified direction: the index should become a **detached floating panel** — own chrome/header, draggable, visually separate from the graph (similar in spirit to the collapsed tray-app node view), rather than docked into the layout or overlaid flush on the canvas. This is a structural/architectural change (new panel paradigm), so per the plan's no-hand-patching rule it was captured as GAP-9 in `61-UAT.md` for a future round-3 plan instead of being edited in at this checkpoint.

## Task Commits

1. **Task 1: Founder round-2 live-install sign-off** — the task itself is the checkpoint (no code commit); its outcome (GAP-9 capture) was committed separately below.

**Deviation commit:** `f4c336e` — `docs(61-14): capture GAP-9 (detached floating index panel) from round-2 sign-off` (UAT gap capture, Rule 4 — architectural item, not hand-patched)

**Plan metadata:** (this commit, following)

## Files Created/Modified

- `.planning/phases/61-corpus-chrome-index-column-project-browsing/61-UAT.md` — appended GAP-9 (status: failed, verbatim founder quote, clarified direction, scope hints, emergence note); updated Notes section to record the round-2 re-run resolution of GAP-5..8 and closure of the 61-09/61-04 sign-off chain; bumped frontmatter `source`/`updated`.

## Decisions Made

- The four `CORPUS_*` constants stay at their round-1 shipped values — the founder found no tuning necessary, so these are now locked as founder-approved rather than provisional (per the plan's "Provisional — tuned at the closing founder checkpoint" doc comments in `constants.js`, which remain unmodified since no edit was needed).
- GAP-9 is treated as a **new structural gap**, not a GAP-1..8 regression — it is a fresh request (detached floating panel) that emerged from live interaction with the now-closed rail, not a defect in the GAP-5..8 closures themselves. Captured for round-3 planning rather than hand-patched, per the checkpoint's Rule 4 (architectural changes require their own plan).

## Deviations from Plan

**1. [Rule 2 — Auto-add missing critical functionality] GAP-9 UAT capture**
- **Found during:** Task 1 (founder live-install verification)
- **Issue:** Founder raised a new structural request (detached floating index panel) not covered by GAP-1..8; the plan's protocol requires capturing structural feedback as a new UAT gap rather than hand-patching.
- **Fix:** Appended GAP-9 to `61-UAT.md` `## Gaps` section with status/truth/founder_direction/scope_hint/emerged_at fields matching the existing GAP-1..8 format; updated frontmatter `source` and `updated`, and the `## Notes` section to record the round-2 sign-off outcome.
- **Files modified:** `.planning/phases/61-corpus-chrome-index-column-project-browsing/61-UAT.md`
- **Verification:** Reviewed against the existing GAP-5..8 entry format for consistency.
- **Committed in:** `f4c336e`

---

**Total deviations:** 1 (documentation capture only — no code, no logic, no constant changes)
**Impact on plan:** None on scope; GAP-9 is explicitly deferred to a future plan per the checkpoint's own no-hand-patching rule.

## Issues Encountered

- The founder's first live-install attempt served stale packed-app assets (pre-round-2-closure). The orchestrator ran `npm run build` before the founder re-verified; all subsequent checks passed against the fresh build. No code change was required — this was a build/serve staleness issue, not a defect in the round-2 closure plans.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- GAP-5..8 fully closed and founder-verified; GAP-1..4 and D1-D4 confirmed stable across three founder checkpoints (61-04 baseline, 61-09 round-1 re-run, 61-14 round-2 re-run).
- The `CORPUS_*` feel constants are final at their shipped values — no outstanding tuning debt.
- **GAP-9 is the sole open item** for this phase's next round: detach the index panel from the docked-rail/on-top-overlay paradigm into a free-floating, draggable panel with its own chrome, modeled on the tray app's collapsed node view. This needs its own plan (`61-15` or a new phase) — it is an architectural change (Rule 4), not a checkpoint-tunable feel value.
- Automated verification green at close: `npx tsc --noEmit` clean; `tests/viz-activity-palette-invariants.test.ts`, `tests/viz-index-route.test.ts`, `tests/viz-corpus-graph.test.ts`, `tests/viz-frontend-static.test.ts` — 144/144 passed.

## Self-Check

- FOUND: `.planning/phases/61-corpus-chrome-index-column-project-browsing/61-UAT.md` (GAP-9 present)
- FOUND: commit `f4c336e` in `git log`

## Self-Check: PASSED

---
*Phase: 61-corpus-chrome-index-column-project-browsing*
*Completed: 2026-07-14*
