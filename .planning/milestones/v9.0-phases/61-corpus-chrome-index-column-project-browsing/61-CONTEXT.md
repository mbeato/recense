# Phase 61: Corpus Chrome — index column + project browsing - Context

**Gathered:** 2026-07-14
**Status:** Ready for planning

<domain>
## Phase Boundary

The corpus view's chrome catches up to the Phase 59 HUD language and actually works for
browsing: the index/sidebar column is restructured from a wall of text into a navigable
collapsible tree in the glass/token vocabulary, and project-level browsing becomes a real
focus flow — click a project, the graph zooms/dims to that project's docs, click away to
return. Reader entry stays doc-click-from-corpus (the rail reader icon was removed at the
59 checkpoint).

**Founder defects captured on the live install (this discussion):**
- **D1 — index column:** indented but reads as "a huge thing of text — not really easy to
  navigate."
- **D2 — project click:** the click action itself "feels okay" — the broken part is the
  overall browsing experience, not the click.
- **D3 — graph:** "lots of clutter, all the labels on top of each other… very busy"
  (but not hated); the amber hover highlight "feels flat."
- **D4 — reader round-trip:** works as expected — NO defect, do not rework.

**In scope:**
- Index column structural redesign (collapsible tree) + glass reskin per 59 conventions.
- Project focus flow (index-row click → graph focus; dim-others; click-away/Esc exit).
- Graph hover parity (subtree highlight + dim, matching index-row hover).
- Tiered label visibility to kill the at-rest label pile-up.
- Deleting the pre-59 `#btn-corpus-chapters` inline-styled button (chapters become
  focus-driven) and glassing the `#index-reopen` handle.

**Out of scope (hard):**
- Everything LOCKED by 57/58/59: activity palette, amber-exclusivity, motion tokens,
  glass recipe, damped camera internals, ⌘K palette structure, node presentation.
- Reader internals and the reader round-trip flow (D4: works — don't touch).
- Corpus↔brain 3D fly-through (`corpus-brain-3d-transition.md` stays pending).
- Hull mesh quality (3D brain work, stays pending).
- Engine/server mechanics — viz server read-only; presentation layer only. (New/changed
  read-only endpoints or payload fields for the index tree are fine if needed; no write
  paths, no LLM.)
- Stats dashboards (Phase 60 — shipped) and tray compact popover.

</domain>

<decisions>
## Implementation Decisions

### Index column redesign
- **D-01: Collapsible tree (Obsidian/VS-Code style).** Projects render as collapsed
  folder rows by default — chevron + name + doc count. Expanding shows that project's
  docs inline (chapters nested one level deeper). Projects and Schemas sections remain.
  You only ever see the docs you opened — fixes the wall-of-text defect.
- **D-02: Glass material, like rails/palette.** The index panel joins the Phase-59 D-14
  backdrop-filter allow-list: blur + hairline specular + aubergine tint. It reads as the
  same instrument as the chip/rails/palette, not a flat near-opaque slab.
- **D-03: Project name-click = focus in graph.** Chevron handles expand/collapse; clicking
  the project NAME row focuses that project in the graph (zoom to cluster, brighten its
  nodes, dim the rest) AND expands its tree row. Doc rows keep click→reader (unchanged).
  The old row-click→hub-doc-reader behavior is replaced.

### Project browsing / focus model
- **D-04: Focus = dim others + click-away exit.** While a project is focused, non-related
  nodes fade to low opacity (still visible as context — the recede language). Exit via
  empty-canvas click, Esc, or clicking another project. No extra chrome (no back button).
- **D-05: Graph hover gets subtree + dim parity.** Hovering a node directly in the graph
  highlights the node + its containment subtree in amber (same as index-row hover does
  today) AND gently dims non-related nodes for depth. One consistent hover language across
  index and graph — fixes the "flat" highlight defect.
- **D-06: Labels tiered by hierarchy.** Project hub labels always visible; subject-doc
  labels appear past a zoom threshold or when their project is focused/hovered; chapter
  labels only on direct hover. The at-rest view reads as a clean project map — fixes the
  overlapping-labels defect.

### Leftover chrome cleanup
- **D-07: Chapter toggle deleted — chapters are focus-driven.** The inline-styled
  `#btn-corpus-chapters` fixed button is removed entirely. Chapter docs render in the
  graph only when their project is focused (or its tree row expanded) and hide again on
  unfocus. Zero chrome; chapters appear exactly when browsing that project.
- **D-08: `#index-reopen` handle gets the glass/token treatment** so nothing in corpus
  view is off-vocabulary. (Founder chose only this extra cleanup — keep the diff
  surgical otherwise; loading/empty overlays untouched.)

### Claude's Discretion
- Index typography (Phase-58 vendored mono is the expected face per 59 conventions),
  count-badge styling, scope-tint dots on project rows, row spacing/density.
- Filter behavior in the collapsed tree (filtering should auto-expand matching branches;
  exact mechanics are the planner's).
- Zoom threshold for subject labels, dim opacities (focus + hover), focus-transition
  timings — all named tunable constants in the shared constants module, tuned at the
  closing founder checkpoint per the 54/56/57/58/59 pattern.
- Esc-key coexistence with reader/palette (one owner for the shortcut map, per 59).
- Whether tree expand state persists across corpus open/close within a session.
- How focus interacts with the reader round-trip (suggest: focus persists when the
  reader closes back to corpus — but planner decides; D4 flow itself must not regress).
- Whether the index tree needs a server payload change (e.g. counts per project) —
  read-only endpoint additions are acceptable.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase contract & carried decisions (read first)
- `.planning/ROADMAP.md` (Phase 61 entry, ~line 1262) — goal statement + the two founder
  verdicts from the 59 D-15 checkpoint this phase answers.
- `.planning/phases/59-hud-integration-visible-but-belong/59-CONTEXT.md` — the glass
  recipe (D-12), token discipline / D-14 CSS scan lock, motion tokens (D-11), diegetic
  split, palette conventions this phase's chrome must conform to.
- `.planning/phases/57-viz-activity-palette-redesign/57-CONTEXT.md` — LOCKED palette:
  amber-exclusivity, muted band, shared constants module discipline.

### Code to change
- `src/viz/modules/index.js` — the index sidebar (tree rendering, filter, hover→highlight,
  click→reader). The collapsible-tree restructure (D-01) and row-click focus (D-03) land
  here. Keep the T-39-08 textContent-only discipline.
- `src/viz/modules/corpus.js` — the 2D graph: focus/dim state (D-04), hover subtree parity
  (D-05, extend `onNodeHover` to reuse the `highlightCorpusNode` BFS), tiered labels
  (D-06, `nodeCanvasObject`), chapter visibility → focus-driven (D-07, replaces
  `showChapters` + the `#btn-corpus-chapters` button), `projectScopes`/`rootScope`
  helpers, `ctx.highlightCorpusNode` / `ctx.refitCorpus` hooks.
- `src/viz/css/styles.css` (~lines 1242–1417) — the index sidebar + reopen-handle block:
  glass reskin (D-02, D-08). All colors already tokenized by 59 D-14; the D-14 invariants
  scan must keep passing, and joining the backdrop-filter allow-list must be reflected
  wherever that allow-list is enforced (check the Phase-59 invariants test).
- `src/viz/modules/constants.js` — home for new named tunables (dim opacities, zoom
  threshold, focus timings) per the Phase-57 single-source rule.

### Consume, don't modify
- `src/viz/modules/reader.js` — reader round-trip works (D4); `ctx.openReader`/
  `ctx.returnToCorpus` contract stays as-is.
- `src/viz/modules/transition.js` — brain⇄corpus transition controller; corpus focus
  moves are 2D-canvas zoom (force-graph `centerAt`/`zoom`), not this controller.
- Phase-59 invariants test file — the CSS token/amber locks extend over any new CSS.

### Project guards (load-bearing)
- `CLAUDE.md` (project) — viz is decorative chrome; engine untouched; viz server
  read-only/LLM-free; net-zero new runtime deps; amber = activation only.

No SPEC.md exists for this phase; requirements are the founder defects + decisions above.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ctx.highlightCorpusNode(slug)` in corpus.js already does the containment-subtree BFS +
  amber repaint — D-05 graph-hover parity is a reuse of this logic keyed off
  `onNodeHover`, and D-04 focus dimming is the same repaint trick with an inverse set.
- The `nodeVisibility`/`linkVisibility` re-assert pattern (used by the chapter toggle)
  is exactly the mechanism for focus-driven chapter visibility (D-07) — positions stay
  pinned, toggling is instant.
- `projectScopes` + `rootScope()` already map nodes→project; the focus set for a project
  is derivable client-side with zero server change.
- force-graph's `zoomToFit(ms, px, nodeFilter)` (already used in `fitAndClamp`) can frame
  a focused project's nodes; `MAX_ZOOM` clamp pattern carries over.
- Index hover→highlight and click→reader wiring in index.js survives — the tree
  restructure changes rendering, not the ctx contract.
- 59's glass tokens/CSS custom properties are all in place — D-02 is applying the
  existing recipe, not inventing one.

### Established Patterns
- Named tunable constants + closing founder checkpoint on the live install (54–59) —
  every feel value here follows it.
- textContent-only for DB-sourced strings (T-39-08 / T-44-19) — tree rows are
  server-sourced labels.
- Amber activation-only, machine-locked by the 59 D-14 CSS scan — dim/focus styling must
  come from opacity/luminance, never a new warm hue.
- Opacity-only transitions for chrome (transition.js lesson) — the index glass fade and
  focus dimming follow it.
- Net-zero deps: chevrons are inline SVG like the existing icons.

### Integration Points
- index.js ↔ corpus.js talk through ctx hooks (`openCorpus`, `highlightCorpusNode`,
  `refitCorpus`) — D-03 focus needs one new hook (e.g. `focusCorpusProject(scope|null)`).
- Esc currently closes reader/palette — focus-exit Esc must join the existing shortcut
  ownership without stealing those.
- The corpus split layout (`.index-docked` + `--index-width`) reflows the canvas; focus
  framing must account for the offset (existing `refitCorpus` precedent).
- Compact/tray LOD: corpus chrome is full-window-only; verify nothing new leaks into the
  compact popover.

</code_context>

<specifics>
## Specific Ideas

- The index should feel like Obsidian's file explorer: collapsed folders with counts,
  expand-in-place, quiet type — "you only ever see the docs you opened."
- Browsing register: click a project and the graph "comes to you" — zoom + brighten +
  dim-others, exit by clicking away. No modes, no back buttons, no extra chrome.
- The hover/focus depth cue is dimming (recede language), not stronger highlights —
  amber stays exactly as warm as it is; everything else gets quieter around it.
- Founder tone on the graph: "don't hate it, it's just very busy" — this is a declutter
  pass, not a re-layout; clustering/forces stay as they are.

</specifics>

<deferred>
## Deferred Ideas

- None new from this discussion — scope stayed within the corpus chrome.

### Reviewed Todos (not folded)
- `corpus-brain-3d-transition.md` — corpus↔brain camera fly-through: structural
  transition work; reviewed and not folded for the third phase running; stays pending.
- `viz-search-and-hull-quality.md` (hull half) — 3D brain hull mesh rendering; unrelated
  to corpus chrome; stays pending.
- `content-hardening-deferred.md` — engine-side hardening; keyword-match noise.
- `2026-06-23-cache-constant-judge-extraction-prompt-prefix-via-system-pro.md` —
  engine-side token optimization; unrelated.

</deferred>

---

*Phase: 61-corpus-chrome-index-column-project-browsing*
*Context gathered: 2026-07-14*
