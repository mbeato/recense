---
status: diagnosed
phase: 61-corpus-chrome-index-column-project-browsing
source: [61-04-PLAN.md checkpoint:human-verify]
started: 2026-07-14T19:20:00Z
updated: 2026-07-14T19:20:00Z
---

## Current Test

[checkpoint feedback captured — awaiting gap closure]

## Tests

### 1. D1 — index reads as glass + navigable tree
expected: Index column reads as glass and as a navigable collapsible tree; feels at home on the page
result: issue — tree works, but the drawer still feels awkward on the page

### 2. D2 — project focus browsing is the primary path
expected: Click project name → zoom + dim; clear path back out of focus
result: issue — focus works, but there is no clear/discoverable way to unfocus a project after selecting one (Esc/canvas-click exist but are invisible)

### 3. Index project rows — visual quality
expected: Project rows look intentional and original
result: issue — clickable project labels read as generic "AI slop" design (default-looking chevron + count pills)

### 4. Schemas in corpus view
expected: Schemas have a purposeful place in the corpus view
result: issue — schemas feel out of place / useless as free-floating peers

## Summary

total: 4
passed: 0
issues: 4
pending: 0
skipped: 0
blocked: 0

## Gaps

### GAP-1: Index drawer overlay paradigm is wrong
status: failed
truth: "The index is a docked full-height sidebar; the graph reflows beside it instead of being overlaid."
founder_direction: The floating panel over the graph feels bolted-on. Replace the overlay drawer with a docked full-height sidebar (Obsidian/VS-Code style) — the corpus graph canvas resizes/reflows to sit beside it, not underneath it. Collapse should return the full canvas width.
scope_hint: src/viz/modules/index.js, src/viz/css/styles.css, corpus canvas sizing in src/viz/modules/corpus.js

### GAP-2: Project rows need real design refinement (keep structure)
status: failed
truth: "Project rows keep chevron + doc-count structure but look intentionally designed — spacing, alignment, hover/active states — not default file-explorer pills."
founder_direction: Keep the chevron/count structure; the problem is default-looking detailing. Refine typography, spacing, alignment, and interaction states so rows read as designed, consistent with the Phase-59 token vocabulary (token-only, no raw color literals).
scope_hint: src/viz/css/styles.css (.index-row/.index-chevron/.index-count), src/viz/modules/index.js

### GAP-3: No discoverable unfocus affordance — active row toggles
status: failed
truth: "The focused project's index row shows a clear active state, and clicking it again exits focus; Esc and canvas-click keep working."
founder_direction: Make the focused project's row visibly active in the index; clicking the active row unfocuses (toggle). No extra chrome on the graph.
scope_hint: src/viz/modules/index.js (row active state + toggle wiring), src/viz/modules/corpus.js (focus-state sync back to index), styles.css active-state class

### GAP-4: Schemas integrated into the tree, not free-floating peers
status: failed
truth: "Schemas are nested under their related project in the index tree and graph grouping instead of rendering as free-floating peer nodes."
founder_direction: Stop rendering schemas as standalone peers in the corpus view; nest each under its related project (index tree row children and graph containment/ownership), so they only appear in that project's context.
scope_hint: src/viz/modules/corpus.js (owner map / containment), src/viz/modules/index.js (tree nesting)

## Notes

- Checkpoint plan 61-04 remains incomplete: its scope allows only the four CORPUS_* tunables, and none of these gaps are tunable. The four provisional constants were not tuned (feedback did not concern feel values) and remain at shipped values: CORPUS_FOCUS_DIM_OPACITY=0.18, CORPUS_HOVER_DIM_OPACITY=0.30, CORPUS_LABEL_ZOOM_THRESHOLD=1.2, CORPUS_FOCUS_TRANSITION_MS=500.
- Re-run the 61-04 live-install sign-off after gap closure.
