# Corpus as a Permanent 3D Plane + Pull-Back Transition — Design

**Date:** 2026-06-20
**Status:** Approved (founder, 2026-06-20)
**Origin:** Founder-directed during the Phase 34 (Visual Polish Pass) 34-03 checkpoint. The corpus↔brain view change was deferred out of Phase 34 as structural; this spec is that follow-up. Supersedes `.planning/todos/pending/corpus-brain-3d-transition.md`.

## Problem

Toggling between the 3D brain (`#graph`) and the flat 2D corpus doc-graph (`#corpus-graph`) currently **insta-pops** — `showCorpus`/`showBrain` flip `container.classList` + `brainEl.style.visibility`. The two views are separate renderers (3D `ForceGraph3D` + THREE vs. a 2D-canvas `force-graph` instance). The founder wants the corpus to **live inside the 3D scene as a flat plane**, revealed by a real **camera pull-back to a map**: the brain recedes into the distance while the corpus map resolves in front, and diving back into the cloud returns to the brain.

## Goals

1. The corpus is a **permanent flat constellation inside the brain's THREE scene** — nodes, edges, and always-on labels on a horizontal plane.
2. Switching views is a **real 3D camera move** (`Graph.cameraPosition`), not a DOM swap: pull back + tilt to frame the map; dive back into the cloud for the brain.
3. Preserve corpus behavior: data source, loading/empty/error states, and click→reader.
4. **Net-zero (or better) runtime deps** — reuse the already-loaded THREE; **remove** the vendored `force-graph` library and the `#corpus-graph` canvas.
5. Honor the founder-locked guards: amber only on hover/activation; the 3D brain density anchor is untouched.

## Non-Goals

- Free-orbit of the corpus map (founder chose top-down-ish framing; pan/zoom yes, free rotate no while in corpus mode).
- Changing corpus data/semantics, the reader, or the brain rendering.
- Bi-directional layout animation of individual nodes morphing between brain and corpus (out of scope; the transition is camera-only).

## Architecture & Module Boundary

New module `src/viz/modules/corpus3d.js` replaces the 2D rendering currently in `src/viz/modules/corpus.js`:

- Owns one `THREE.Group` (`corpusGroup`) added to `ctx.Graph.scene()`, holding the corpus nodes, edges, and label sprites laid on a `y=0` horizontal plane.
- Exposes the same context hooks the rest of the viz already calls: the `#btn-corpus` toggle, `ctx.returnToCorpus` (reader-close re-entry), and `ctx.showBrainFromCorpus` (inline fact-ref click) — re-pointed at the new camera-mode transitions instead of DOM swaps.
- The `#btn-corpus` toggle drives a **mode** (`brain` ⇄ `corpus`): it animates the camera and shows/hides `corpusGroup`; it no longer hides `#graph` or shows `#corpus-graph`.

**Removed:**
- `#corpus-graph` canvas element (from `index.html`).
- The vendored `src/viz/vendor/force-graph.min.js` and its injection in `app.js` (a **net dependency reduction** — improves the net-zero guard).
- The 2D force-graph rendering path in `corpus.js` (module is replaced by `corpus3d.js`; or `corpus.js` is rewritten in place — implementation plan decides, but the public init entry point stays stable).

**Preserved:**
- Data fetch (`GET /graph?type=doc`) returning doc nodes (`slug`, `label`) + `doc_link` edges.
- Loading / empty / error states, including the control-flow fixes from commit `fa0e206` (error not overwritten by empty; status visible; no overlay accumulation).
- Click→reader via `openDocReader(id)` → `/?doc=<slug>&reader=1`.

## Layout

Doc-node 2D positions come from a **lightweight plain-JS force layout** (net-zero, no d3 import), reusing the force shapes already prototyped in `corpus.js`:
- charge (mild repulsion), link distance, a centering pull, and a collision radius for label-spacing.
- Settle synchronously over ~200 ticks (small corpora settle near-instantly), then map each node's `(x, y)` onto the floor plane as `(x, 0, z=y)`, centered on the origin.

If layout quality proves inadequate, the fallback is to run the vendored `force-graph` headlessly only to read settled `x/y` — but the intent is to drop that dependency, so the plain-JS layout is the primary path.

## Rendering (THREE)

- **Nodes:** flat circle meshes (or sprites) lying on the plane, muted rose, constant radius (doc corpora are small — Obsidian-style legibility, not brain `BRAIN_SCALE` sizing).
- **Edges:** `THREE.LineSegments` between node positions for `doc_link`, muted slate/mauve.
- **Labels:** always-on **canvas-texture sprites** — one small canvas texture per slug/label — **billboarded** (face the camera) so they stay readable at the top-down-ish tilt. Muted slate/mauve text, brightened on hover. This is the most novel piece (no existing label infra to reuse; the brain uses unlabeled `nodeThreeObject` meshes).
- **Hover:** raycast `corpusGroup` against the pointer; brighten the hovered node + label. Amber is permitted here (hover/activation per the palette guard).

## Camera Transition

Uses the proven `ctx.Graph.cameraPosition(pos, lookAt, ms)` API (already used in `graph.js` for brain framing and `detail.js` for node focus) and `ctx.Graph.controls()` / autoRotate (toggled in `stats.js`).

- **Enter corpus** (`showCorpus`):
  1. Disable autoRotate; set `controls().enableRotate = false` (keep pan/zoom).
  2. Show `corpusGroup` (lazy-built on first entry).
  3. `cameraPosition(pullBackTiltPos, planeCenter, ~800ms)` — camera pulls back and tilts down to frame the map; the brain shrinks into the fog (stays visible — the spatial payoff).
  4. Update the `#btn-corpus` glyph/aria to the brain-return state (existing ICON_BOOK/ICON_BRAIN swap is preserved).
- **Enter brain** (`showBrain`):
  1. `cameraPosition(brainHome, center, ~800ms)` — camera dives back into the cloud.
  2. After the move, hide `corpusGroup`; restore `enableRotate = true` and autoRotate-on-idle.
- Framing positions computed relative to `BRAIN_SCALE`. `returnToCorpus` re-frames the map (camera back to the corpus framing) without a full rebuild.

The corpus plane is lazy-built on first corpus open and kept hidden (`visible = false`) in brain mode, so the brain view never shows it; the camera move provides the reveal. (A purer "always physically in-scene, revealed only by geometry" variant exists but is not required for the effect and risks fog/clutter — deferred.)

## Interaction & States

- **Click** a corpus node → resolve its slug → `openDocReader(id)` (reuse existing navigation). Raycast determines the clicked node.
- **States:** loading / empty / error are rendered as a **centered DOM overlay** over the canvas (reusing the existing state strings and the `fa0e206` control-flow fixes), because a fetch can fail or be empty before any THREE objects exist. Loading shows during fetch; empty shows "No docs yet" + the `recense generate-doc <slug>` hint; error shows "Failed to load corpus" and is not overwritten by the empty branch.

## Guards (founder-locked) — must hold

- **Net-zero (or better) deps:** no new runtime deps; `force-graph` vendored lib removed. THREE already present.
- **Amber only on hover/activation:** rest-state node/edge/label colors stay muted rose/slate/mauve.
- **3D brain density anchor untouched:** `brain.js`, `haze.js`, `graph.js` brain rendering paths unchanged (the only `graph.js`/scene touch is adding `corpusGroup` to the existing scene and reusing `cameraPosition`/`controls`).

## Risks

- **Label legibility** at the tilt angle — mitigated by billboarding + a zoom/pan floor that keeps the map at a readable scale.
- **Raycast accuracy** on small node sprites — size the pickable target generously.
- **Fog graying the plane** if placed too far from origin — tune plane distance to sit within the brain fog's near range (`THREE.Fog(BG, BRAIN_SCALE*1.8, BRAIN_SCALE*4.2)`).
- **Camera framing math** relative to `BRAIN_SCALE` — derive empirically and expose constants for tuning.
- **Existing tests:** the ~14 corpus unit tests assume the 2D `force-graph` instance and will need reworking to the new module (test the layout/data/state logic, not the THREE render).

## Testing

- **Founder-visual** verification (consistent with the rest of this viz work): pull-back feel, map readability, hover, click→reader, return paths, brain density unchanged.
- **Unit tests** reworked for `corpus3d.js`: data→layout mapping, state transitions (loading/empty/error, incl. the `fa0e206` fixes), slug resolution for click→reader. THREE rendering itself is visual-verified, not unit-tested.

## Open Defaults (baked in unless changed)

- Lazy-build `corpusGroup` on first corpus open; hidden in brain mode.
- Top-down-locked camera in corpus mode (pan/zoom allowed, free orbit disabled).
- ~800ms ease for both transitions.
- Drop the 2D `force-graph` dependency (confirmed by founder).
