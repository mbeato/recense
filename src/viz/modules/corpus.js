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

// Muted palette (founder-locked) — kept local so corpus.js has no dependency on the
// brain's THREE-oriented numeric color constants. Hex strings for canvas fillStyle.
const REST_NODE = '#9c7080';    // dusty rose — doc nodes at rest (muted)
const REST_NODE_RING = 'rgba(156,112,128,0.55)'; // faint rose ring
const HOVER_NODE = '#ffb866';   // warm amber — ACTIVATION ONLY (hover/selected)
const LINK_REST = 'rgba(130,105,140,0.35)'; // muted mauve doc_link edges
const LABEL_COLOR = '#c8bcd0';  // muted slate/mauve label text
const LABEL_COLOR_HOVER = '#e7dfec'; // brightened on hover
const BG = '#170f1d';           // deep warm aubergine — matches the viz background

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

  // Whether the corpus graph is currently shown.
  let corpusActive = false;
  // The lazily-built 2D ForceGraph instance (null until first open).
  let CorpusGraph = null;
  // nodeId → slug map for D-08 click resolution (built from /graph?type=doc).
  let nodeSlugs = {};
  // Currently-hovered node (for amber activation highlight).
  let hoveredId = null;

  /** Build the 2D ForceGraph instance once and fetch its data. */
  async function buildCorpusGraph() {
    const ForceGraph = window.ForceGraph;
    if (typeof ForceGraph !== 'function') return null;

    let data = { nodes: [], links: [] };
    try {
      const res = await fetch('/graph?type=doc');
      if (res.ok) data = await res.json();
    } catch (_) {
      // Non-fatal: an empty corpus graph still renders (just no nodes).
    }

    // Build the nodeId → slug map (slug is included in /graph?type=doc node records
    // via the node_doc JOIN, so D-08 click→reader resolution works client-side).
    nodeSlugs = {};
    for (const node of (data.nodes || [])) {
      if (node.slug) nodeSlugs[node.id] = node.slug;
    }

    const G = ForceGraph()(container)
      .backgroundColor(BG)
      .graphData({ nodes: data.nodes || [], links: data.links || [] })
      // Custom canvas paint: muted rose circle + ring + slug label (Obsidian-style).
      // Amber is reserved for the hovered node only (activation-only palette rule).
      .nodeCanvasObject((node, canvasCtx, globalScale) => {
        const isHover = node.id === hoveredId;
        const r = NODE_R;
        // Circle fill
        canvasCtx.beginPath();
        canvasCtx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
        canvasCtx.fillStyle = isHover ? HOVER_NODE : REST_NODE;
        canvasCtx.fill();
        // Faint ring
        canvasCtx.lineWidth = 1 / globalScale;
        canvasCtx.strokeStyle = isHover ? HOVER_NODE : REST_NODE_RING;
        canvasCtx.stroke();
        // Label: the slug/title, drawn below the node. Scale font with zoom for
        // legibility but cap so it doesn't explode when zoomed in.
        const label = nodeSlugs[node.id] || node.id;
        const fontSize = Math.max(10 / globalScale, 2.2);
        canvasCtx.font = `${fontSize}px system-ui, -apple-system, sans-serif`;
        canvasCtx.textAlign = 'center';
        canvasCtx.textBaseline = 'top';
        canvasCtx.fillStyle = isHover ? LABEL_COLOR_HOVER : LABEL_COLOR;
        canvasCtx.fillText(label, node.x, node.y + r + 1.5);
      })
      // Pointer area covers the circle (label is decorative, not a click target).
      .nodePointerAreaPaint((node, color, canvasCtx) => {
        canvasCtx.fillStyle = color;
        canvasCtx.beginPath();
        canvasCtx.arc(node.x, node.y, NODE_R + 2, 0, 2 * Math.PI, false);
        canvasCtx.fill();
      })
      .linkColor(() => LINK_REST)
      .linkWidth(1)
      .onNodeHover((node) => {
        hoveredId = node ? node.id : null;
        container.style.cursor = node ? 'pointer' : '';
      })
      // D-08: click a doc node → open its reader IN PLACE over the corpus.
      .onNodeClick((node) => {
        if (node && node.id) openDocReader(node.id);
      });

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
   * Fit the corpus graph to the viewport, then clamp the zoom to MAX_ZOOM (Fix A).
   * zoomToFit frames a tiny graph (e.g. 2 nodes) so tightly each node fills the
   * screen; the clamp keeps a small corpus reading as small circles with breathing room.
   */
  function fitAndClamp() {
    if (!CorpusGraph || !CorpusGraph.zoomToFit) return;
    try {
      CorpusGraph.zoomToFit(400, 40);
      // After the fit animation, clamp the zoom ceiling. The fit is animated (400ms),
      // so check/clamp slightly after it settles.
      setTimeout(() => {
        try {
          if (typeof CorpusGraph.zoom === 'function' && CorpusGraph.zoom() > MAX_ZOOM) {
            CorpusGraph.zoom(MAX_ZOOM, 0);
          }
        } catch (_) { /* ignore */ }
      }, 450);
    } catch (_) { /* ignore */ }
  }

  async function showCorpus() {
    // Lazy-init on first open.
    if (!CorpusGraph) {
      CorpusGraph = await buildCorpusGraph();
      if (!CorpusGraph) return; // force-graph not available — bail (brain stays shown)
      // Fit when the force layout settles (settled positions → correct framing).
      // onEngineStop fires once the simulation cools; this is the primary fit trigger.
      if (typeof CorpusGraph.onEngineStop === 'function') {
        CorpusGraph.onEngineStop(() => {
          if (corpusActive) fitAndClamp();
        });
      }
    }
    // Show the flat corpus, hide the 3D brain (pure visibility — brain untouched).
    container.classList.add('open');
    if (brainEl) brainEl.style.visibility = 'hidden';
    sizeCorpusGraph();
    corpusActive = true;
    corpusBtn.textContent = 'Brain';
    corpusBtn.classList.add('corpus-active');
    // Fallback fit on a fixed timeout in case onEngineStop already fired before the
    // corpus was shown (e.g. a tiny graph settles instantly), or never fires.
    setTimeout(() => { if (corpusActive) fitAndClamp(); }, 350);
  }

  function showBrain() {
    container.classList.remove('open');
    if (brainEl) brainEl.style.visibility = '';
    corpusActive = false;
    corpusBtn.textContent = 'Corpus';
    corpusBtn.classList.remove('corpus-active');
  }

  corpusBtn.addEventListener('click', () => {
    if (corpusActive) showBrain();
    else showCorpus();
  });

  // Keep the corpus canvas sized to the window when it's the active view.
  window.addEventListener('resize', () => {
    if (corpusActive) sizeCorpusGraph();
  });

  // ── ctx hooks for reader.js in-place open/close (Fix B) ─────────────────────
  // returnToCorpus(): reader.js calls this when a from:'corpus' reader closes. The
  // corpus stayed mounted underneath the overlay, so there is nothing to rebuild —
  // we just confirm the corpus is shown and the brain stays hidden (idempotent).
  ctx.returnToCorpus = function returnToCorpus() {
    container.classList.add('open');
    if (brainEl) brainEl.style.visibility = 'hidden';
    corpusActive = true;
    corpusBtn.textContent = 'Brain';
    corpusBtn.classList.add('corpus-active');
  };

  // showBrainFromCorpus(): reader.js calls this when an inline fact-ref is clicked
  // while the reader was opened over the corpus — the explicit hero interaction
  // deliberately drops to the brain (atom focus). Restore the 3D brain view.
  ctx.showBrainFromCorpus = function showBrainFromCorpus() {
    showBrain();
  };
}
