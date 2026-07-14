---
status: diagnosed
phase: 61-corpus-chrome-index-column-project-browsing
source: [61-04-PLAN.md checkpoint:human-verify, 61-09-PLAN.md checkpoint:human-verify]
started: 2026-07-14T19:20:00Z
updated: 2026-07-14T21:30:00Z
---

## Current Test

[round-2 checkpoint feedback (61-09) captured — awaiting gap closure]

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
passed: 0
issues: 4
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
status: failed
truth: "Project rows have no curved/rounded borders — row hover/active surfaces are square-edged (or full-bleed) within the rail."
founder_direction: The curved bottom border on the project labels is AI slop — remove it and NEVER use rounded row corners in the index again (durable design rule, recorded in memory). Keep the hover/active background treatment otherwise.
scope_hint: src/viz/css/styles.css (.index-row border-radius: 6px at ~line 1439; check .index-entry and any other row-surface radius)

### GAP-6: Index rail defaults to closed
status: failed
truth: "The corpus view opens with the index rail closed; the graph gets the full canvas by default and the rail opens only on explicit user action (left-edge handle), then docks/reflows as built."
founder_direction: The docked rail still feels awkward "just sitting there" when it opens on its own — keep it closed by default. Opening stays explicit; existing dock/reflow behavior unchanged once opened.
scope_hint: src/viz/modules/index.js (opens by default when the corpus view opens — see header comment and openSidebar wiring; session-scoped state note at ~line 53)

### GAP-7: Unfocus must animate as the inverse of focus
status: failed
truth: "Exiting project focus (active-row toggle, Esc, canvas click) plays the same zoom/frame animation as focusing, in reverse — same duration/easing — instead of snapping."
founder_direction: Focus animation is right; unfocus needs the identical animation inverted (animated zoom back out to the full visible set).
scope_hint: src/viz/modules/corpus.js focusCorpusProject(null) branch — calls reassertPaint()+fitAndClamp() (snap) instead of an animated zoomToFit(CORPUS_FOCUS_TRANSITION_MS, ...) over the full visible set

### GAP-8: Nested schemas are illegible — unclear what they are, UUID titles leak
status: failed
truth: "A schema row under a project is immediately legible: a human-readable title (never a raw UUID) and a presentation that makes clear what these docs are at first glance."
founder_direction: Nesting is right, but it's not obvious what schemas are at first glance and some render raw UUID titles. Consider renaming the section/label away from "Schemas" toward something that reads as one-off docs — founder is not sure of the final label; planner should propose options (checkpoint the label choice if needed).
scope_hint: src/viz/server.ts (/index schema titles — derive human-readable titles, no UUIDs), src/viz/modules/index.js (schema row presentation/label), possibly styles.css

## Notes

- Round 1: Checkpoint plan 61-04 remained incomplete (scope allowed only the four CORPUS_* tunables; feedback was structural). The four provisional constants were not tuned and remain at shipped values: CORPUS_FOCUS_DIM_OPACITY=0.18, CORPUS_HOVER_DIM_OPACITY=0.30, CORPUS_LABEL_ZOOM_THRESHOLD=1.2, CORPUS_FOCUS_TRANSITION_MS=500.
- Round 2 (this update): 61-09 checkpoint ran on the live install after gap plans 61-05..61-08 merged. GAP-1..4 core truths hold; four new structural gaps (GAP-5..GAP-8) captured per the checkpoint's no-hand-patching rule. No feel constants were tuned in round 2 either (feedback again structural).
- 61-09 (and the 61-04 sign-off it supersedes) remains open — re-run the live-install sign-off after GAP-5..GAP-8 close.
