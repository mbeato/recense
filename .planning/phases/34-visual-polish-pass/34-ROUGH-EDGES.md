# Phase 34 — Rough-Edges Inventory (founder-pointed, 2026-06-20)

Founder-walked list of the specific rough edges to resolve. Captured verbatim-in-intent
from the founder; classified by surface and by kind (BUG / POLISH / RESEARCH).
Consumed by `/gsd-ui-phase 34` and `/gsd-plan-phase 34` — these are the concrete
checklist items behind the ROADMAP success criteria.

**Founder-locked guards (apply to every item):** palette muted rose/slate/mauve at rest,
amber for activation/hover ONLY (ref 27-04 violation); 3D brain density anchor no-regress;
net-zero new runtime deps; polish only (no structural/composition redesign) — EXCEPT B1,
which is a functional bug fix.

---

## Surface: Brain viz / HUD

### B1 — [BUG] Fact-node click incomplete (schemas fine, facts sometimes dead) — ✅ RESOLVED 2026-06-20
- **Resolution (founder-approved):** fixed in the `haze-activation-regression` debug session
  (commit `ae812c5`, branch `fix/haze-activation-and-click`) together with the prompt-activation
  regression and the focus-unhaze regression — all four facets of the 260619-mbr InstancedMesh
  change. True root cause was NOT a missing `selectNode` call (the hypothesis below) but an
  `onBackgroundClick` teardown race: a haze click reads as an fg3d background click, which closed
  the detail a frame after the haze handler opened it. Fix: `ctx._hazeClickConsumed` suppression
  flag + standalone selection ring for haze + raycast proximity fallback + focus-unhaze promotion.
  Full session record: `.planning/debug/resolved/haze-activation-regression.md`. Suite 1923 green.
- **Symptom:** clicking schema nodes focuses + hops correctly; clicking *fact* nodes
  sometimes opens NO detail tab and does NOT highlight the node — it focuses somewhat,
  but pieces are missing.
- **Root-cause hypothesis (from grep):** two click paths in `src/viz/modules/graph.js` —
  the regular `onNodeClick` (~L448–469) calls `ctx.selectNode(node)` for all nodes, but
  the instanced/haze raycast path (~L776) is a separate handler. The ~6k "haze" fact/entity
  nodes (InstancedMesh from quick-task 260619-mbr) are picked via instanceId on that second
  path, which likely skips the highlight + `selectNode`/detail steps the regular path runs.
- **Action:** confirm via `/gsd-debug` (repro: click a haze fact node vs a regular fact node
  vs a schema), then route the instanced click path through the same select/highlight/detail
  steps. This is a **fix-with-repro task**, not a CSS change.
- **Note:** decide at plan time whether this rides in Phase 34 as a dedicated bug task or
  splits into its own `/gsd-debug` session (founder's call).

### B2 — [POLISH] Expanded-window HUD feels clunky / chrome in the way
- Node count is fine. But some buttons, the topics chips, and the search box feel out of
  place and almost *in the way* of the viz in the expanded window overlay.
- **Action:** reposition / declutter the HUD chrome in expanded mode — spacing, placement,
  and out-of-the-way framing so controls don't crowd the graph. (Surface: `hud.js`,
  `search.js`, `topics.js`, `index.html` + `css/styles.css`.)

### B3 — [POLISH] Topics must be hidden in corpus view
- Topic chips stay visible when the corpus 2D view is open; they should be hidden.
- **Action:** `corpus.js` `showCorpus()` hides topics; `showBrain()` restores them (mirror
  the existing graph hide/show toggle).

---

## Surface: Corpus 2D graph

### C1 — [POLISH] Corpus toggle → book icon, relocated to the button cluster
- Replace the current expanded-only `#btn-corpus` text toggle with a **book icon button**,
  positioned **between the collapse and recenter buttons**.
- **Action:** move + restyle `#btn-corpus` into the collapse/recenter control cluster;
  book glyph; keep the expanded-only gate behavior intact.

### C2 — [RESEARCH + POLISH] Corpus framing: nodes flung too far, screen mostly blank
- Doc nodes get spaced out really far — most of the screen ends up blank.
- **RESEARCH:** how do similar 2D node views (Obsidian graph view, other `force-graph`
  apps) properly frame & space a small/medium graph? Look at: `zoomToFit` on settle,
  d3 `forceManyBody` charge strength, `linkDistance`, centering force, and bounded/clamped
  layout so the graph fills the viewport instead of dispersing.
- **Action:** tune the force params + add zoom-to-fit framing so the corpus reads as a
  contained graph, not a sparse scatter. (Surface: `corpus.js`.)

---

## Surface: Reader

### R1 — [POLISH] Close button must be sticky
- The reader close button (`#reader-close`) scrolls away with the content; it needs to be
  **sticky** so it stays reachable while scrolling long docs.
- **Action:** sticky/pinned positioning for `#reader-close` (and/or the reader header) in
  `css/styles.css`; keep the existing muted-mauve/slate styling.

---

## Surface coverage check (vs ROADMAP success criteria)

- **Reader:** R1
- **Corpus 2D graph:** C1, C2
- **Detail panel / page:** (no founder-flagged item yet — UI-phase to audit spacing/state
  coverage; B1's fix restores detail-open for haze facts which exercises this surface)
- **Brain HUD / controls:** B1 (bug), B2, B3

All four surfaces represented. Two axes hold: spacing/alignment (B2, C1, C2) and
states/transitions (B1 interaction completeness, R1 sticky-on-scroll, B3 mode-state visibility).
