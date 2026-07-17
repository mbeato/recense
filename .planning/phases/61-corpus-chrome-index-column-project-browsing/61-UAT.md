---
status: resolved
phase: 61-corpus-chrome-index-column-project-browsing
source: [61-04-PLAN.md checkpoint:human-verify, 61-09-PLAN.md checkpoint:human-verify, 61-14-PLAN.md checkpoint:human-verify, 61-16-PLAN.md checkpoint:human-verify]
started: 2026-07-14T19:20:00Z
updated: 2026-07-17T00:00:00Z
---

## Current Test

[all gaps resolved — round-4 closure (61-17/61-18) founder-approved 2026-07-17]

## Tests

Round 1 (61-04 checkpoint) produced GAP-1..GAP-4, closed by plans 61-05..61-08.
Round 2 (61-09 checkpoint re-run) results below.

### 1. GAP-1 re-test — docked sidebar
expected: Index reads as a docked rail, no longer a bolted-on drawer
result: issue — dock mechanics work but it "still feels awkward as a drawer just sitting there"; founder direction: keep it closed by default

### 2. GAP-2 re-test — row design
expected: Rows read as intentionally designed
result: issue — the curved (rounded) bottom border on project labels reads as AI slop; founder: "NEVER DO IT AGAIN"

### 3. GAP-3 re-test — focus/unfocus
expected: Focus + unfocus both feel right
result: issue — focus animation is good, but unfocus snaps instead of playing the same animation in inverse

### 4. GAP-4 re-test — schemas nested
expected: Schemas have a purposeful, legible place under their project
result: issue — nesting is fine ("don't hate the schemas") but it's not clear what they are at first glance; some have raw UUID titles; section label "Schemas" may need to read as one-off docs

## Summary

total: 4
passed: 4
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

### GAP-1: Index drawer overlay paradigm is wrong
status: resolved
truth: "The index is a docked full-height sidebar; the graph reflows beside it instead of being overlaid."
founder_direction: (round 1) Replace the overlay drawer with a docked full-height sidebar; graph reflows beside it.
resolution: Closed by 61-05 (docked rail + reflow). Residual founder discomfort captured as GAP-6 (default-closed).

### GAP-2: Project rows need real design refinement (keep structure)
status: resolved
truth: "Project rows keep chevron + doc-count structure but look intentionally designed — spacing, alignment, hover/active states — not default file-explorer pills."
founder_direction: (round 1) Keep chevron/count structure; refine detailing token-only.
resolution: Closed by 61-06 (rhythm/alignment/hover pass). Residual defect captured as GAP-5 (rounded row corners).

### GAP-3: No discoverable unfocus affordance — active row toggles
status: resolved
truth: "The focused project's index row shows a clear active state, and clicking it again exits focus; Esc and canvas-click keep working."
founder_direction: (round 1) Active row state + click-to-unfocus toggle.
resolution: Closed by 61-07 (syncCorpusFocus two-way sync + active row). New sibling defect captured as GAP-7 (unfocus animation).

### GAP-4: Schemas integrated into the tree, not free-floating peers
status: resolved
truth: "Schemas are nested under their related project in the index tree and graph grouping instead of rendering as free-floating peer nodes."
founder_direction: (round 1) Nest schemas under their related project in tree and graph.
resolution: Closed by 61-08 (schema→project resolution + ownerScope). Residual legibility defect captured as GAP-8.

### GAP-5: Rounded corners on project rows are AI slop — remove
status: resolved
truth: "Project rows have no curved/rounded borders — row hover/active surfaces are square-edged (or full-bleed) within the rail."
founder_direction: The curved bottom border on the project labels is AI slop — remove it and NEVER use rounded row corners in the index again (durable design rule, recorded in memory). Keep the hover/active background treatment otherwise.
scope_hint: src/viz/css/styles.css (.index-row border-radius: 6px at ~line 1439; check .index-entry and any other row-surface radius)

### GAP-6: Index rail defaults to closed
status: resolved
truth: "The corpus view opens with the index rail closed; the graph gets the full canvas by default and the rail opens only on explicit user action (left-edge handle), then docks/reflows as built."
founder_direction: The docked rail still feels awkward "just sitting there" when it opens on its own — keep it closed by default. Opening stays explicit; existing dock/reflow behavior unchanged once opened.
scope_hint: src/viz/modules/index.js (opens by default when the corpus view opens — see header comment and openSidebar wiring; session-scoped state note at ~line 53)

### GAP-7: Unfocus must animate as the inverse of focus
status: resolved
truth: "Exiting project focus (active-row toggle, Esc, canvas click) plays the same zoom/frame animation as focusing, in reverse — same duration/easing — instead of snapping."
founder_direction: Focus animation is right; unfocus needs the identical animation inverted (animated zoom back out to the full visible set).
scope_hint: src/viz/modules/corpus.js focusCorpusProject(null) branch — calls reassertPaint()+fitAndClamp() (snap) instead of an animated zoomToFit(CORPUS_FOCUS_TRANSITION_MS, ...) over the full visible set

### GAP-8: Nested schemas are illegible — unclear what they are, UUID titles leak
status: resolved
truth: "A schema row under a project is immediately legible: a human-readable title (never a raw UUID) and a presentation that makes clear what these docs are at first glance."
founder_direction: Nesting is right, but it's not obvious what schemas are at first glance and some render raw UUID titles. Consider renaming the section/label away from "Schemas" toward something that reads as one-off docs — founder is not sure of the final label; planner should propose options (checkpoint the label choice if needed).
scope_hint: src/viz/server.ts (/index schema titles — derive human-readable titles, no UUIDs), src/viz/modules/index.js (schema row presentation/label), possibly styles.css

### GAP-9: Closed-rail corpus view feels bare; docked/on-top index drawer still feels wrong — detach as a floating panel
status: superseded
truth: "The corpus index reads as a free-floating panel (own chrome/header, draggable, visually separate from the graph — akin to the collapsed tray-app node view), not a rail docked into the layout or a drawer overlaid flush on the canvas; the closed corpus view no longer feels bare."
founder_direction: (round-2 61-14 re-run, new item — not a GAP-1..8 regression) Verbatim: "maybe it would be good similar to the collapsed tray app node view as like a separate window kinda cause it also feels bare without the index drawer but having on top of the corpus graph still feels wrong." Clarified: the index should become a detached floating panel — still inside the viz page, but a free-floating window-like panel (own chrome/header, draggable) visually separate from the graph, similar in spirit to the collapsed tray-app node view. Not docked into the layout (current 61-05/61-13 behavior), not overlaid flush on the canvas either. Problem statement: the corpus feels bare with the rail closed (GAP-6), but the docked/on-top drawer on the corpus graph feels wrong.
scope_hint: src/viz/modules/index.js (panel mount/positioning — currently docks/reflows the canvas; needs a detached floating-panel treatment), src/viz/css/styles.css (panel chrome — header/border/drag affordance, floating vs. docked layout), possibly apps/tray (reference for the "collapsed tray-app node view" panel pattern the founder is pointing at). This is a STRUCTURAL/architectural change (new panel paradigm, not a feel-value tune) — Rule 4, needs its own plan, not hand-patched at a checkpoint.
emerged_at: 61-14-PLAN.md round-2 closing sign-off (2026-07-14) — GAP-5..8 all confirmed resolved on the live install; this is a new item the founder raised while re-verifying GAP-6, not a regression of GAP-1..8.
superseded_by: GAP-10. Plan 61-16 built the free-floating draggable window this gap called for, but at the live-install sign-off (Task 3) the founder rejected the floating-over-canvas paradigm itself in favor of a docked left panel outside the graph. GAP-9's "own chrome/draggable/no-longer-bare" truths carry forward into GAP-10's docked-panel requirement; only the floating/overlay positioning is superseded.

### GAP-10: Floating panel still overlays the graph — must be a docked left panel outside the canvas, attached to the main window
status: resolved
truth: "The corpus index is a docked LEFT PANEL that lives outside the graph canvas, attached to the main app window (side-by-side layout, not an overlay) — the graph canvas reflows to sit beside the panel rather than extending underneath/behind it."
founder_direction: (round-3 61-16 Task 3 live-install sign-off, 2026-07-16) Verbatim: "index on top of graph is still out of place needs to be outside the window as a left panel but still attached to the main window." Clarified: the 61-16 floating-window build (GAP-9's resolution) still reads as sitting on top of / over the graph, which is rejected — the founder wants the index OUTSIDE the graph viewport entirely, as a left-side panel/column attached to the main app window, with the graph reflowing beside it. This REVERSES the 61-16 "graph keeps full canvas, no reflow" premise: the graph must now cede width to the panel again, but as a genuine side-by-side dock (not a re-run of the pre-GAP-9 docked-rail-over-bare-view complaint — the founder's GAP-6/round-2 "feels bare" concern about the rail was about default-closed presentation, not about docking as a layout strategy). This is a STRUCTURAL/architectural change (reflow-layout reversal, not a feel-value tune) — Rule 4, needs its own plan; NOT hand-patched at the 61-16 checkpoint.
scope_hint: src/viz/css/styles.css (#index-panel positioning — revert/rework the floating offset+max-height+border-radius chrome from 61-16 into a docked-left-column layout; reinstate a canvas reflow rule, e.g. `#corpus-graph` left-offset or flex/grid sibling layout, scoped to whatever "attached to the main window" turns out to mean structurally), src/viz/modules/index.js (openSidebar/hidePanel — the 61-16 removal of `.index-docked` class + `refitCorpus()` calls likely needs to be reinstated or replaced with an equivalent reflow trigger; the drag-by-header behavior from 61-16 may no longer apply to a fixed docked panel — open question for planning, not decided here).
emerged_at: 61-16-PLAN.md Task 3 checkpoint:human-verify (2026-07-16) — founder reported issues rather than approving; captured per the plan's Rule 4 (structural feel changes get their own follow-up plan, not hand-patched at the checkpoint). Tasks 1-2 of 61-16 (the floating-window CSS/JS build) remain merged as-is; GAP-10's follow-up plan will rework that same surface area, not start from scratch.

## Notes

- Round 1: Checkpoint plan 61-04 remained incomplete (scope allowed only the four CORPUS_* tunables; feedback was structural). The four provisional constants were not tuned and remain at shipped values: CORPUS_FOCUS_DIM_OPACITY=0.18, CORPUS_HOVER_DIM_OPACITY=0.30, CORPUS_LABEL_ZOOM_THRESHOLD=1.2, CORPUS_FOCUS_TRANSITION_MS=500.
- Round 2 (61-09 checkpoint): ran on the live install after gap plans 61-05..61-08 merged. GAP-1..4 core truths hold; four new structural gaps (GAP-5..GAP-8) captured per the checkpoint's no-hand-patching rule. No feel constants were tuned in round 2 either (feedback again structural).
- Round 2 re-run (61-14 checkpoint, 2026-07-14): after gap plans 61-10..61-13 merged, GAP-5, GAP-6, GAP-7, GAP-8 all founder-confirmed RESOLVED on the live install; GAP-1..4 and D1-D4 confirmed NO REGRESSION. No feel tuning requested — the four CORPUS_* constants are ratcheted at their current shipped values (CORPUS_FOCUS_DIM_OPACITY=0.18, CORPUS_HOVER_DIM_OPACITY=0.30, CORPUS_LABEL_ZOOM_THRESHOLD=1.2, CORPUS_FOCUS_TRANSITION_MS=500) as founder-approved. 61-09 (and the 61-04 sign-off it supersedes) is now CLOSED — 61-14-SUMMARY.md is the closing record. One new structural item, GAP-9, was raised by the founder during this re-run (detached floating index panel) — captured above, requires its own plan (round-3 closure), not a regression of GAP-1..8.
- Round 3 (61-16 Task 3 checkpoint, 2026-07-16): plan 61-16 built the GAP-9 floating-window paradigm (Tasks 1-2 merged, `0537ea9`/`8a1c636`). At the live-install sign-off the founder rejected the floating-over-canvas result and asked for a docked left panel outside the graph instead — captured as GAP-10 (supersedes GAP-9's positioning direction; GAP-9 marked `superseded`). 61-16 is CLOSED with its executable work (Tasks 1-2) intact; the checkpoint (Task 3) resolved to "issues reported, new gap captured" rather than founder approval. Phase 61 requires a round-4 follow-up plan to close GAP-10 before the phase can be considered fully signed off.
- Round 4 (61-18 Task 3 checkpoint, 2026-07-17): after regression plans 61-17 (GAP-7 animated-clamp deferral, GAP-8 shared humanTitle UUID guard on /graph) and 61-18 (GAP-10 docked left column with body.index-docked reflow, drag machinery removed) merged and built, the founder verified the live install and APPROVED — docked left panel outside the graph with reflow, no regressions across GAP-1..8/D1-D4. GAP-5..8 and GAP-10 are flipped to resolved; 61-VERIFICATION.md re-run passed 13/13. Phase 61 fully signed off.
