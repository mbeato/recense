/**
 * @module corpus
 * recense viz — flat 2D Obsidian-style doc→doc corpus graph (READER-04).
 *
 * This is a SEPARATE renderer from the 3D anatomical brain (graph.js). It uses the
 * vendored 2D `force-graph` library (window.ForceGraph, injected by app.js) on its own
 * `#corpus-graph` container — it does NOT swap data into the ForceGraph3D brain instance.
 *
 * Toggle behaviour (#btn-corpus, expanded-only per D-07):
 *   - First Corpus open: lazy-init the 2D ForceGraph instance, fetch /graph?type=doc,
 *     show #corpus-graph full-window, hide the 3D brain (#graph). Button reads "Brain".
 *   - Brain toggle: hide #corpus-graph, restore the 3D brain UNTOUCHED (no rebuild,
 *     no density regression — pure hide/show). Button reads "Corpus".
 *
 * Flat graph spec:
 *   - nodes = doc nodes (circle + visible slug/title label), links = doc_link edges.
 *   - 2D force-directed, pan/zoom/drag (force-graph defaults).
 *   - Palette: muted rose/slate/mauve at rest; AMBER is ACTIVATION-ONLY (hover highlight).
 *   - Dark background matching the viz (#170f1d).
 *   - Click a doc node → navigate to /?doc=<slug>&reader=1 (D-08).
 *
 * No absolute brain sizing (nodeRadius/BRAIN_SCALE) imported — this flat view sizes for
 * Obsidian-style legibility independently of the 3,500-node density anchor.
 */

import { createTransition } from './transition.js';

// ── Button icon SVGs (inline — net-zero deps, no icon lib) ──────────────────────────
// BOOK icon: shown when brain is active (button = "go to corpus").
const ICON_BOOK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
// BRAIN icon: shown when corpus is active (button = "go back to brain").
// Side-view (sagittal) brain cross-section — cerebrum in profile facing left, a couple
// of internal gyri folds, and a small cerebellum/brainstem nub at the lower-back (right).
const ICON_BRAIN = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16c-2 0-3-1.6-3-3.4 0-1.6 1-3 2.4-3.4C4.6 5.6 7.4 3 11 3c4.4 0 7.6 3.2 7.6 7 0 1 .4 1.6 1 2.2.8.8 1.2 1.6 1.2 2.6 0 1.6-1.4 3-3.2 3"/><path d="M17.6 17.8c.4 1.6-.6 3.2-2.4 3.2-1.4 0-2.4-1-2.4-2.4"/><path d="M7 10c1.2.4 1.8 1.4 1.8 2.6"/><path d="M12 8c1.4.6 2 1.8 2 3.4"/></svg>`;

// Muted palette (founder-locked) — kept local so corpus.js has no dependency on the
// brain's THREE-oriented numeric color constants. Hex strings for canvas fillStyle.
const REST_NODE = '#9c7080';    // dusty rose — fallback for docs with no scope
const REST_NODE_RING = 'rgba(156,112,128,0.55)'; // faint rose ring
const HOVER_NODE = '#ffb866';   // warm amber — ACTIVATION ONLY (hover/selected)
const LINK_REST = 'rgba(130,105,140,0.35)'; // muted mauve — doc_link + doc_reference base
// Containment spine: slightly stronger slate/mauve (still muted — NOT amber).
// Heavier and more opaque than LINK_REST so the parent→child hierarchy reads clearly.
const CONTAINMENT_COLOR = 'rgba(110,90,130,0.70)'; // stronger slate/mauve spine
// D-14: cross-project reference edge — muted cool blue, distinct from the mauve/slate band.
const CROSS_PROJECT_REF = 'rgba(140,170,200,0.55)'; // muted cool blue — cross-project bridges
const LABEL_COLOR = '#c8bcd0';  // muted slate/mauve label text
const LABEL_COLOR_HOVER = '#e7dfec'; // brightened on hover
const BG = '#170f1d';           // deep warm aubergine — matches the viz background

// D-16/D-17: scope → hue assignment (generative rotation within the muted rose/slate/mauve band).
// Palette constraints (founder-locked Phase 15): saturation low (~28%), lightness mid (~52%),
// hue rotated. Amber (#ffb866 ~ hue 33) is reserved for activation/hover ONLY — auto-tints
// must NOT produce amber. Starting at hue 300 (mauve/rose) with step 53 (prime-ish to avoid
// early collisions), the first 8 scopes land at: 300, 353, 46, 99, 152, 205, 258, 311.
// Hue 46 is the closest to amber territory (20-50 range). At SCOPE_SAT=28% / SCOPE_LIGHT=52%
// this yields a desaturated olive-beige — not amber. The founder-locked amber is fully
// saturated at ~47% (hsl(33,93%,72%)) and cannot be confused with a muted 28% tint.
// Scopes 3+ rotate further into blue-green-purple space, well away from amber.
const SCOPE_HUE_START = 300;   // start near mauve/rose
const SCOPE_HUE_STEP = 53;     // rotation step — prime-ish to avoid repeats at low N
const SCOPE_SAT = 28;           // % saturation — muted (founder-locked band)
const SCOPE_LIGHT = 52;         // % lightness — mid, not garish
const scopeColorCache = new Map(); // scope string → hsl string

// D-16: return the muted scope tint for a given scope string.
// Null/empty scope → falls back to REST_NODE (the legacy uniform rose).
function scopeColor(scope) {
  if (!scope) return REST_NODE;
  if (scopeColorCache.has(scope)) return scopeColorCache.get(scope);
  const idx = scopeColorCache.size;
  const hue = (SCOPE_HUE_START + idx * SCOPE_HUE_STEP) % 360;
  const color = `hsl(${hue}, ${SCOPE_SAT}%, ${SCOPE_LIGHT}%)`;
  scopeColorCache.set(scope, color);
  return color;
}

// D-13: UUID schema-chapter docs — detect by slug pattern.
// Schema-chapter slugs are the schema node id (UUIDs); hub and subject slugs are plain strings.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Node circle radius in graph-space units (sizing for Obsidian-style legibility,
// NOT the brain's nodeRadius/BRAIN_SCALE). Constant size — doc corpora are small.
const NODE_R = 5;

// Max zoom ceiling after zoomToFit (Fix A). With very few nodes (e.g. a 2-node
// corpus) zoomToFit frames them so tightly each fills the viewport. Clamp so a
// small graph reads as small circles with room around them, not blown up.
const MAX_ZOOM = 2.5;

/**
 * Initialise the flat 2D corpus graph + #btn-corpus toggle.
 * Lazy: the ForceGraph instance is only built on the first Corpus open.
 *
 * @param {Object} ctx shared viz context (provides Graph = the 3D brain instance,
 *   used only to read nothing — corpus is independent; we hide/show #graph directly).
 */
export function initCorpus(ctx) {
  const corpusBtn = document.getElementById('btn-corpus');
  const container = document.getElementById('corpus-graph');
  const brainEl = document.getElementById('graph');
  if (!corpusBtn || !container) return;

  // The lazily-built 2D ForceGraph instance (null until first open).
  let CorpusGraph = null;
  // nodeId → slug map for D-08 click resolution (built from /graph?type=doc).
  let nodeSlugs = {};
  let nodeLabels = {};
  // Currently-hovered node (for amber activation highlight on direct graph hover).
  let hoveredId = null;
  // Set of node ids highlighted from a sidebar-row hover (the row's doc + its graph neighbours).
  // Separate from hoveredId so sidebar-driven multi-node highlight and direct graph hover coexist.
  let highlightSet = new Set();

  // Chapter (UUID schema-chapter) docs are HIDDEN by default to keep the index readable.
  // Founder override of D-13 (2026-06-23): the all-shown-dimmed default was too cluttered —
  // ~160 hazed chapters drowned the hub→subject skeleton in mist. A toggle (off by default)
  // reveals them. Chapters stay in the (pinned) force layout so their positions are stable when
  // shown; nodeVisibility/linkVisibility just skip painting them — instant toggle, no re-settle.
  let showChapters = false;
  const isChapterNode = (n) => UUID_RE.test((n && n.slug) || '');
  const isNodeVisible = (n) => showChapters || !isChapterNode(n);

  // Chapter-visibility toggle button — created once, hidden until the corpus view is open.
  let chapterToggleBtn = document.getElementById('btn-corpus-chapters');
  if (!chapterToggleBtn) {
    chapterToggleBtn = document.createElement('button');
    chapterToggleBtn.id = 'btn-corpus-chapters';
    chapterToggleBtn.type = 'button';
    chapterToggleBtn.style.cssText = [
      // right:54px clears the top-right button column (collapse/corpus/recenter, right:12px ~30px
      // wide, ends ~42px) so the toggle docks to its LEFT instead of rendering beneath it.
      'position:fixed', 'top:12px', 'right:54px', 'z-index:40', 'display:none',
      'padding:6px 10px', 'font:12px system-ui,-apple-system,sans-serif',
      'color:#c8bcd0', 'background:rgba(40,28,50,0.85)',
      'border:1px solid rgba(156,112,128,0.45)', 'border-radius:6px', 'cursor:pointer',
    ].join(';');
    document.body.appendChild(chapterToggleBtn);
  }
  function syncChapterToggleLabel() {
    chapterToggleBtn.textContent = showChapters ? 'Hide chapter docs' : 'Show chapter docs';
    chapterToggleBtn.setAttribute('aria-pressed', String(showChapters));
  }
  function setChapterToggleVisible(v) { chapterToggleBtn.style.display = v ? 'block' : 'none'; }
  syncChapterToggleLabel();
  chapterToggleBtn.addEventListener('click', () => {
    showChapters = !showChapters;
    syncChapterToggleLabel();
    if (!CorpusGraph) return;
    try {
      // Re-assert the visibility + paint accessors so force-graph repaints the (static, pinned)
      // canvas with the new filter — same repaint trick used by highlightCorpusNode.
      if (typeof CorpusGraph.nodeVisibility === 'function') CorpusGraph.nodeVisibility(CorpusGraph.nodeVisibility());
      if (typeof CorpusGraph.linkVisibility === 'function') CorpusGraph.linkVisibility(CorpusGraph.linkVisibility());
      if (typeof CorpusGraph.nodeCanvasObject === 'function') CorpusGraph.nodeCanvasObject(CorpusGraph.nodeCanvasObject());
    } catch (_) { /* non-fatal */ }
    fitAndClamp();
  });

  /** Build the 2D ForceGraph instance once and fetch its data. */
  async function buildCorpusGraph() {
    const ForceGraph = window.ForceGraph;
    if (typeof ForceGraph !== 'function') return null;

    // CR-02 fix: remove any stale status div first so repeated empty/error opens don't
    // accumulate overlays (CorpusGraph stays null on those paths, so each click re-runs this).
    const stale = container.querySelector('.corpus-status');
    if (stale) stale.remove();

    // Loading indicator — shown immediately while fetch + graph init runs. The caller
    // (showCorpus) has already opened the container, so this renders in a VISIBLE surface.
    const statusEl = document.createElement('div');
    statusEl.className = 'corpus-status';
    statusEl.textContent = 'Loading corpus…';
    container.appendChild(statusEl);

    // CR-01 fix: distinguish error from empty. A thrown fetch OR a non-ok response is an
    // ERROR — without this flag the error path falls through to the empty-state check below,
    // which overwrites 'Failed to load corpus' with 'No docs yet'.
    let errored = false;
    let data = { nodes: [], links: [] };
    try {
      const res = await fetch('/graph?type=doc');
      if (res.ok) data = await res.json();
      else errored = true;
    } catch (_) {
      errored = true;
    }

    // CR-01 fix: surface the error BEFORE the empty-state check so it can't be overwritten.
    if (errored) {
      statusEl.textContent = 'Failed to load corpus';
      return null; // bail — error overlay stays visible; corpus view is already open
    }

    // Build the nodeId → slug map (slug is included in /graph?type=doc node records
    // via the node_doc JOIN, so D-08 click→reader resolution works client-side).
    nodeSlugs = {};
    nodeLabels = {};
    for (const node of (data.nodes || [])) {
      if (node.slug) nodeSlugs[node.id] = node.slug;
      // BUG-1 fix (28-04): display the human schema label (server resolves it via the schema
      // node JOIN: COALESCE(schema.value, slug)). For schema-anchored docs the slug is a UUID,
      // so without this the node renders as a UUID. Click resolution still uses nodeSlugs.
      nodeLabels[node.id] = node.label || node.slug || node.id;
    }

    // Empty state: no docs in corpus yet (fetch succeeded but returned zero nodes).
    if ((data.nodes || []).length === 0) {
      statusEl.innerHTML =
        'No docs yet<br><code>recense generate-doc &lt;slug&gt;</code>';
      return null; // bail — no graph to build; statusEl stays as the empty state
    }
    // Data present: remove loading overlay before first graph paint.
    statusEl.remove();

    const G = ForceGraph()(container)
      .backgroundColor(BG)
      .graphData({ nodes: data.nodes || [], links: data.links || [] })
      // Custom canvas paint: scope-tinted circle + ring + slug label (Obsidian-style).
      // Amber is reserved for the hovered node only (activation-only palette rule, D-17).
      // D-13: UUID schema-chapter docs are dimmed (alpha 0.35) but remain visible.
      // D-16: node fill uses scopeColor(node.scope) — each project gets a distinct muted tint.
      .nodeCanvasObject((node, canvasCtx, globalScale) => {
        const isHover = node.id === hoveredId || highlightSet.has(node.id);
        const r = NODE_R;
        // D-13: dim UUID schema-chapter docs (visible but faded/desaturated — NOT hidden).
        const isChapterDoc = UUID_RE.test(node.slug || '');
        canvasCtx.globalAlpha = isChapterDoc ? 0.35 : 1.0;
        // D-16: scope-keyed tint; hover stays amber (activation-only).
        const baseColor = scopeColor(node.scope);
        // Circle fill
        canvasCtx.beginPath();
        canvasCtx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
        canvasCtx.fillStyle = isHover ? HOVER_NODE : baseColor;
        canvasCtx.fill();
        // Faint ring
        canvasCtx.lineWidth = 1 / globalScale;
        canvasCtx.strokeStyle = isHover ? HOVER_NODE : REST_NODE_RING;
        canvasCtx.stroke();
        // Label: the slug/title, drawn below the node. Scale font with zoom for
        // legibility but cap so it doesn't explode when zoomed in.
        const label = nodeLabels[node.id] || nodeSlugs[node.id] || node.id;
        const fontSize = Math.max(10 / globalScale, 2.2);
        canvasCtx.font = `${fontSize}px system-ui, -apple-system, sans-serif`;
        canvasCtx.textAlign = 'center';
        canvasCtx.textBaseline = 'top';
        canvasCtx.fillStyle = isHover ? LABEL_COLOR_HOVER : LABEL_COLOR;
        canvasCtx.fillText(label, node.x, node.y + r + 1.5);
        // Restore globalAlpha after painting this node (chapter dimming must not bleed).
        canvasCtx.globalAlpha = 1.0;
      })
      // Pointer area covers the circle (label is decorative, not a click target).
      .nodePointerAreaPaint((node, color, canvasCtx) => {
        canvasCtx.fillStyle = color;
        canvasCtx.beginPath();
        canvasCtx.arc(node.x, node.y, NODE_R + 2, 0, 2 * Math.PI, false);
        canvasCtx.fill();
      })
      // Founder override (2026-06-23): hide chapter docs by default to declutter. Hiding via
      // nodeVisibility/linkVisibility (not graphData removal) keeps positions pinned so toggling
      // is instant. A link is visible only when BOTH endpoints are visible.
      .nodeVisibility((node) => isNodeVisible(node))
      .linkVisibility((link) => {
        const s = typeof link.source === 'object' ? link.source : null;
        const t = typeof link.target === 'object' ? link.target : null;
        if (!s || !t) return true; // pre-layout (string ids) — default visible
        return isNodeVisible(s) && isNodeVisible(t);
      })
      // D-08 / D-14: link-kind-aware styling (CORPUS-04).
      // doc_containment      = solid directed spine (heavier, arrow at child, no dash).
      // doc_reference        = faint dashed undirected cross-link (no arrow).
      //   same-project ref   = short dash [2,2] in LINK_REST (muted mauve).
      //   cross-project ref  = longer dash [4,3] in CROSS_PROJECT_REF (cool blue) — D-14.
      // doc_link             = faint mauve solid (existing treatment, no arrow, no dash).
      .linkColor(link => {
        const isContain = link.kind === 'doc_containment';
        const isRef = link.kind === 'doc_reference';
        // Sidebar-row highlight: amber only the CONTAINMENT links whose both endpoints are in
        // the highlight set — i.e. the spine of the hovered node's subtree. Loose doc_link /
        // doc_reference edges stay muted even if both ends happen to be highlighted.
        if (highlightSet.size && isContain) {
          const s = typeof link.source === 'object' ? link.source.id : link.source;
          const t = typeof link.target === 'object' ? link.target.id : link.target;
          if (highlightSet.has(s) && highlightSet.has(t)) return HOVER_NODE;
        }
        if (isContain) return CONTAINMENT_COLOR;
        if (isRef) {
          // D-14: cross-project reference — src.scope !== dst.scope.
          // Guard for the pre-layout string form (force-graph mutates source/target to
          // node objects after layout init; before that they are string ids with no scope).
          const srcScope = (typeof link.source === 'object' ? link.source.scope : null);
          const dstScope = (typeof link.target === 'object' ? link.target.scope : null);
          const isCrossProject = srcScope && dstScope && srcScope !== dstScope;
          return isCrossProject ? CROSS_PROJECT_REF : LINK_REST;
        }
        return LINK_REST; // doc_link
      })
      .linkWidth(link => link.kind === 'doc_containment' ? 2 : 1)
      .linkDirectionalArrowLength(link => link.kind === 'doc_containment' ? 4 : 0)
      .linkDirectionalArrowRelPos(1)
      // D-14: cross-project references use a longer dash to visually distinguish cross-boundary
      // edges from same-project references (which use the existing short [2,2] dash).
      .linkLineDash(link => {
        if (link.kind === 'doc_reference') {
          const srcScope = (typeof link.source === 'object' ? link.source.scope : null);
          const dstScope = (typeof link.target === 'object' ? link.target.scope : null);
          const isCrossProject = srcScope && dstScope && srcScope !== dstScope;
          return isCrossProject ? [4, 3] : [2, 2]; // longer dash for cross-project bridges
        }
        return null; // containment and doc_link: solid
      })
      .onNodeHover((node) => {
        hoveredId = node ? node.id : null;
        container.style.cursor = node ? 'pointer' : '';
      })
      // D-08: click a doc node → open its reader IN PLACE over the corpus.
      .onNodeClick((node) => {
        if (node && node.id) openDocReader(node.id);
      });

    // C2 (34-03 fix): compact corpus clustering — light repulsion + centering + collide.
    // Problem: charge=-80 with few/unconnected nodes scatters them to canvas edges (nothing
    // pulls them back without links), then fitAndClamp zooms out to fit the spread.
    // Round 2 (founder): the tight -20/k=0.08 cluster was a touch too close to read labels.
    // Loosen modestly — charge -35, centering k 0.05 — and add a small collision force so
    // node+label footprints don't overlap. Still a contained cluster, just legible spacing.
    // All forces are plain JS objects implementing the d3-force protocol (no d3 import).
    try {
      const charge = G.d3Force('charge');
      if (charge && typeof charge.strength === 'function') charge.strength(-35);
      const link = G.d3Force('link');
      if (link && typeof link.distance === 'function') link.distance(40);
      // Inline centering force — gently pulls each node toward the canvas centre.
      const cx = (container.clientWidth || window.innerWidth) / 2;
      const cy = (container.clientHeight || window.innerHeight) / 2;
      let _cNodes = [];
      const centerForce = Object.assign(
        function(alpha) {
          const k = 0.05 * alpha; // round 2: softer pull (was 0.08) — looser, still centred
          for (const n of _cNodes) {
            if (n.fx == null) n.vx = (n.vx || 0) + (cx - n.x) * k;
            if (n.fy == null) n.vy = (n.vy || 0) + (cy - n.y) * k;
          }
        },
        { initialize(nodes) { _cNodes = nodes; } }
      );
      G.d3Force('center', centerForce);
      // Inline collision force — single-pass separation so node+label footprints don't
      // overlap. COLLIDE_R covers the circle plus enough room for the label below it.
      const COLLIDE_R = NODE_R * 4; // ~20 units — circle + label breathing room
      let _kNodes = [];
      const collideForce = Object.assign(
        function() {
          for (let i = 0; i < _kNodes.length; i++) {
            const a = _kNodes[i];
            for (let j = i + 1; j < _kNodes.length; j++) {
              const b = _kNodes[j];
              let dx = b.x - a.x, dy = b.y - a.y;
              let d = Math.sqrt(dx * dx + dy * dy) || 0.01;
              const min = COLLIDE_R * 2;
              if (d < min) {
                const push = (min - d) / d * 0.5;
                dx *= push; dy *= push;
                if (a.fx == null) { a.x -= dx; a.y -= dy; }
                if (b.fx == null) { b.x += dx; b.y += dy; }
              }
            }
          }
        },
        { initialize(nodes) { _kNodes = nodes; } }
      );
      G.d3Force('collide', collideForce);

      // D-15: Hub-anchored clustering — each project hub (slug without ':' and not a UUID)
      // acts as a soft gravity anchor for its scope's nodes. Strategy: after the layout
      // settles, the hub's pinned position (fx/fy) is set; subject nodes feel a gentle
      // per-scope attractive pull toward their hub's position (separate forceX/forceY per
      // scope). This pools each project's subjects around their hub while leaving hubs free
      // to find natural positions relative to each other during the settling phase.
      // We register a single 'hubAnchor' force that reads hub positions from the live node
      // set and pulls same-scope non-hub nodes toward the hub centroid each tick.
      let _aNodes = [];
      const hubAnchorForce = Object.assign(
        function(alpha) {
          // Build hub position map per scope (hubs = slug without ':' and not UUID).
          const hubPos = {};
          for (const n of _aNodes) {
            const slug = n.slug || '';
            const isHub = slug && !slug.includes(':') && !UUID_RE.test(slug);
            if (isHub && n.scope) {
              hubPos[n.scope] = { x: n.x || 0, y: n.y || 0 };
            }
          }
          // Pull same-scope non-hub nodes gently toward their hub.
          const k = 0.04 * alpha;
          for (const n of _aNodes) {
            if (n.fx != null) continue; // pinned — skip
            const slug = n.slug || '';
            const isHub = slug && !slug.includes(':') && !UUID_RE.test(slug);
            if (isHub) continue; // hub anchors itself
            const hub = n.scope && hubPos[n.scope];
            if (!hub) continue;
            n.vx = (n.vx || 0) + (hub.x - (n.x || 0)) * k;
            n.vy = (n.vy || 0) + (hub.y - (n.y || 0)) * k;
          }
        },
        { initialize(nodes) { _aNodes = nodes; } }
      );
      G.d3Force('hubAnchor', hubAnchorForce);
    } catch (_) { /* non-fatal if force-graph doesn't expose d3Force */ }

    return G;
  }

  /**
   * Open the reader for a doc node IN PLACE over the corpus (D-08, Fix B).
   * Resolves the slug from nodeSlugs (built during buildCorpusGraph) and calls the
   * reader's in-place opener (ctx.openReader) with from:'corpus' — the #reader overlay
   * slides in over the still-mounted #corpus-graph; NO page navigation, no brain detour.
   * Closing the reader returns to the corpus (reader.js calls ctx.returnToCorpus).
   */
  function openDocReader(docNodeId) {
    const slug = nodeSlugs[docNodeId];
    if (!slug) return;
    if (typeof ctx.openReader === 'function') {
      ctx.openReader(slug, { from: 'corpus' });
    }
  }

  /** Resize the corpus graph to fill its container (force-graph needs explicit size). */
  function sizeCorpusGraph() {
    if (!CorpusGraph) return;
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    CorpusGraph.width(w).height(h);
  }

  /**
   * Fit the corpus graph to the viewport and clamp the zoom to MAX_ZOOM (Fix A).
   * Both steps are INSTANT (0ms): zoomToFit(0,...) sets the fit without animating, then
   * the clamp snaps the zoom ceiling immediately — so the FIRST paint is already correctly
   * framed. Animating the fit (e.g. zoomToFit(400,...)) would balloon a tiny graph past
   * MAX_ZOOM and then rubberband back; doing it all at 0ms avoids that overshoot entirely.
   */
  function fitAndClamp() {
    if (!CorpusGraph || !CorpusGraph.zoomToFit) return;
    try {
      // Instant fit — no animation, so we never render the over-zoomed intermediate frame.
      // Frame only the VISIBLE nodes (chapters may be hidden) so the skeleton fills the view.
      CorpusGraph.zoomToFit(0, 40, (node) => isNodeVisible(node));
      // Immediately clamp the zoom ceiling (also 0ms). For a small graph zoomToFit lands
      // above MAX_ZOOM; this snaps it down before the next frame, no rubberband.
      if (typeof CorpusGraph.zoom === 'function' && CorpusGraph.zoom() > MAX_ZOOM) {
        CorpusGraph.zoom(MAX_ZOOM, 0);
      }
    } catch (_) { /* ignore */ }
  }

  // ── Build-once preparation ──────────────────────────────────────────────────
  // Fetch + settle + PIN (d3 fx/fy) + fit so the corpus is a STATIC, instantly-frameable
  // map BEFORE it is ever revealed. Fitting a live, still-cooling sim was the root of the
  // drift/rubberband; a pinned layout frames identically on the first open and every cached
  // one after. Resolves 'ready' | 'empty' | 'error'. Memoized on success; a non-ready
  // outcome is NOT cached, so the next open retries (docs may appear / a fetch may recover).
  let preparePromise = null;
  function prepareCorpus() {
    if (preparePromise) return preparePromise;
    const p = (async () => {
      if (!CorpusGraph) {
        CorpusGraph = await buildCorpusGraph();
        if (!CorpusGraph) {
          // buildCorpusGraph already set the loading→empty/error status overlay.
          const txt = container.querySelector('.corpus-status');
          return txt && /Failed/.test(txt.textContent || '') ? 'error' : 'empty';
        }
        sizeCorpusGraph();
        // Wait for the force layout to settle, then PIN it so it can never drift again.
        await new Promise((resolve) => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          if (typeof CorpusGraph.onEngineStop === 'function') CorpusGraph.onEngineStop(finish);
          setTimeout(finish, 800); // fallback: instant-settle / no onEngineStop
        });
        try {
          const gd = CorpusGraph.graphData && CorpusGraph.graphData();
          if (gd && gd.nodes) gd.nodes.forEach((n) => { n.fx = n.x; n.fy = n.y; });
        } catch (_) { /* ignore */ }
        // No fit here — fitting happens at reveal (onBeforeReveal) when the container is
        // display:block with real dimensions; a hidden/eager-built fit would mis-frame.
      }
      // else: already prepared (built + pinned) — reveal re-fits the frozen layout.
      return 'ready';
    })();
    preparePromise = p;
    p.then((res) => { if (res !== 'ready') preparePromise = null; }).catch(() => { preparePromise = null; });
    return p;
  }

  // ── Transition controller: owns the brain⇄corpus camera move + crossfade ─────
  // onBeforeReveal fits the pinned graph at reveal time, when the container is display:block
  // (real rect) — fitting a hidden/eager-prepared graph would mis-frame it.
  const transition = createTransition(ctx, {
    brainEl,
    corpusEl: container,
    onBeforeReveal: () => { sizeCorpusGraph(); fitAndClamp(); },
  });

  function setCorpusButton() {
    corpusBtn.setAttribute('aria-label', 'Show brain');
    corpusBtn.setAttribute('title', 'Show brain');
    corpusBtn.innerHTML = ICON_BRAIN;
    corpusBtn.classList.add('corpus-active');
  }
  function setBrainButton() {
    corpusBtn.setAttribute('aria-label', 'Corpus graph');
    corpusBtn.setAttribute('title', 'Corpus');
    corpusBtn.innerHTML = ICON_BOOK;
    corpusBtn.classList.remove('corpus-active');
  }
  // B3 + 39-02 re-verify: the brain HUD — the top-left status #panel (which contains topics +
  // search) — is hidden in corpus view so it doesn't overlap the index sidebar that now docks
  // top-left; restored in brain view. The bottom-left .legend is separate and stays.
  function setTopicsSearchHidden(hidden) {
    const panel = document.getElementById('panel');
    const topicWrap = document.getElementById('topic-wrap');
    const searchWrap = document.getElementById('search-wrap');
    if (panel) panel.style.display = hidden ? 'none' : '';
    if (topicWrap) topicWrap.style.display = hidden ? 'none' : '';
    if (searchWrap) searchWrap.style.display = hidden ? 'none' : '';
  }

  function goToCorpus() {
    setCorpusButton();
    setTopicsSearchHidden(true);
    setChapterToggleVisible(true);
    // Open the index sidebar BEFORE the reveal so the corpus offsets (left:var(--index-width))
    // and frames into the remaining width — a true split, not an overlay (founder polish, 39).
    // The dedicated #btn-index was removed; corpus IS the index entry point now.
    if (typeof ctx.openIndexSidebar === 'function') ctx.openIndexSidebar();
    transition.toCorpus(prepareCorpus());
  }
  function goToBrain() {
    setBrainButton();
    setTopicsSearchHidden(false);
    setChapterToggleVisible(false);
    // The index sidebar (if open) docks over the corpus — close it before the brain returns
    // so it doesn't linger over the 3D brain (39-02 re-verify: sidebar-over-corpus model).
    if (typeof ctx.closeIndexSidebar === 'function') ctx.closeIndexSidebar();
    transition.toBrain();
  }

  corpusBtn.addEventListener('click', () => {
    if (transition.isCorpus()) goToBrain();
    else goToCorpus();
  });

  // Keep the corpus canvas sized to the window when it's the active view.
  window.addEventListener('resize', () => {
    if (transition.isCorpus()) sizeCorpusGraph();
  });

  // ── ctx hooks for reader.js in-place open/close (Fix B) ─────────────────────
  // returnToCorpus(): reader.js calls this when a from:'corpus' reader closes. The corpus
  // stayed mounted underneath the overlay and the camera never left corpus framing, so we
  // re-assert the corpus-shown state with NO camera move (idempotent).
  ctx.returnToCorpus = function returnToCorpus() {
    setCorpusButton();
    setTopicsSearchHidden(true);
    setChapterToggleVisible(true);
    transition.assertCorpus();
  };

  // showBrainFromCorpus(): reader.js calls this when an inline fact-ref is clicked while the
  // reader was opened over the corpus — the hero interaction deliberately drops to the brain.
  ctx.showBrainFromCorpus = function showBrainFromCorpus() {
    goToBrain();
  };

  // ── ctx hooks for the index sidebar (index.js, 39-02 re-verify) ─────────────
  // The index list docks as a left sidebar OVER this corpus graph. index.js needs to (a) open
  // the corpus when the sidebar opens from the brain view, (b) know if the corpus is already
  // open, and (c) cross-highlight the node matching a hovered sidebar row.
  ctx.openCorpus = function openCorpus() {
    if (!transition.isCorpus()) goToCorpus();
  };
  ctx.isCorpusOpen = function isCorpusOpen() {
    return transition.isCorpus();
  };
  // refitCorpus(): re-size the canvas to its (possibly offset) container and re-frame. Called by
  // index.js after the sidebar docks/undocks so the graph frames into the remaining width (split
  // layout, founder polish). No-op if the graph isn't built yet; fitAndClamp guards the zoom.
  ctx.refitCorpus = function refitCorpus() {
    sizeCorpusGraph();
    fitAndClamp();
  };
  // highlightCorpusNode(slug|null): amber-highlight the doc node whose slug matches AND its
  // CONTAINMENT SUBTREE — every doc it contains, recursively, down the doc_containment spine
  // (source=parent → target=child). doc_link / doc_reference neighbours stay muted (founder
  // direction: highlight the hierarchy a node contains, not every loose reference). A leaf
  // (e.g. the tonos project doc, which contains nothing) highlights just itself. Clears on null.
  // Non-fatal if the graph isn't built yet. Re-asserting the nodeCanvasObject accessor flags
  // force-graph to repaint the (otherwise static, pinned) canvas without moving the camera.
  ctx.highlightCorpusNode = function highlightCorpusNode(slug) {
    if (!CorpusGraph) return;
    const next = new Set();
    if (slug) {
      let rootId = null;
      for (const id in nodeSlugs) { if (nodeSlugs[id] === slug) { rootId = id; break; } }
      if (rootId) {
        next.add(rootId);
        try {
          const links = ((CorpusGraph.graphData && CorpusGraph.graphData()) || {}).links || [];
          // BFS down the containment spine; the visited guard (next.has) also breaks any cycle.
          const queue = [rootId];
          while (queue.length) {
            const cur = queue.shift();
            for (const link of links) {
              if (link.kind !== 'doc_containment') continue;
              const s = typeof link.source === 'object' ? link.source.id : link.source;
              const t = typeof link.target === 'object' ? link.target.id : link.target;
              if (s === cur && !next.has(t)) { next.add(t); queue.push(t); }
            }
          }
        } catch (_) { /* ignore — fall back to single-node highlight */ }
      }
    }
    // Skip the repaint if the set is unchanged (avoids thrashing on repeated mouse moves).
    if (next.size === highlightSet.size && [...next].every(id => highlightSet.has(id))) return;
    highlightSet = next;
    try {
      if (typeof CorpusGraph.nodeCanvasObject === 'function') {
        CorpusGraph.nodeCanvasObject(CorpusGraph.nodeCanvasObject());
      }
    } catch (_) { /* non-fatal — highlight just won't repaint on this lib version */ }
  };

  // Eagerly prepare the corpus shortly after init (independent of the brain load) so the
  // FIRST open is instant-ready like cached opens — no build/settle delay or empty gap after
  // the brain recedes. Builds in the hidden container (sized to the window via fallback); the
  // fit is deferred to reveal. Empty/error outcomes are swallowed here and retried on a real open.
  setTimeout(() => { prepareCorpus(); }, 1200);
}
