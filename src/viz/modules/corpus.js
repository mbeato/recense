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

// ── Button icon SVGs (inline — net-zero deps, no icon lib) ──────────────────────────
// BOOK icon: shown when brain is active (button = "go to corpus").
const ICON_BOOK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
// BRAIN icon: shown when corpus is active (button = "go back to brain").
// Simple stylised brain outline — two lobes separated by a centre indent.
const ICON_BRAIN = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2C7 2 5 4 5 6.5c0 1-.4 1.9-1 2.5C3.1 10 2 11.4 2 13c0 2.2 1.8 4 4 4h1"/><path d="M14.5 2C17 2 19 4 19 6.5c0 1 .4 1.9 1 2.5.9 1 2 2.4 2 4 0 2.2-1.8 4-4 4h-1"/><path d="M12 22v-5"/><path d="M9 17h6"/><path d="M12 2v4"/></svg>`;

// Muted palette (founder-locked) — kept local so corpus.js has no dependency on the
// brain's THREE-oriented numeric color constants. Hex strings for canvas fillStyle.
const REST_NODE = '#9c7080';    // dusty rose — doc nodes at rest (muted)
const REST_NODE_RING = 'rgba(156,112,128,0.55)'; // faint rose ring
const HOVER_NODE = '#ffb866';   // warm amber — ACTIVATION ONLY (hover/selected)
const LINK_REST = 'rgba(130,105,140,0.35)'; // muted mauve — doc_link + doc_reference base
// Containment spine: slightly stronger slate/mauve (still muted — NOT amber).
// Heavier and more opaque than LINK_REST so the parent→child hierarchy reads clearly.
const CONTAINMENT_COLOR = 'rgba(110,90,130,0.70)'; // stronger slate/mauve spine
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
  let nodeLabels = {};
  // Currently-hovered node (for amber activation highlight).
  let hoveredId = null;

  /** Build the 2D ForceGraph instance once and fetch its data. */
  async function buildCorpusGraph() {
    const ForceGraph = window.ForceGraph;
    if (typeof ForceGraph !== 'function') return null;

    // Loading indicator — shown immediately while fetch + graph init runs.
    const statusEl = document.createElement('div');
    statusEl.className = 'corpus-status';
    statusEl.textContent = 'Loading corpus…';
    container.appendChild(statusEl);

    let data = { nodes: [], links: [] };
    try {
      const res = await fetch('/graph?type=doc');
      if (res.ok) data = await res.json();
    } catch (_) {
      if (statusEl) statusEl.textContent = 'Failed to load corpus';
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

    // Empty state: no docs in corpus yet.
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
        const label = nodeLabels[node.id] || nodeSlugs[node.id] || node.id;
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
      // D-08: link-kind-aware styling (CORPUS-04).
      // doc_containment = solid directed spine (heavier, arrow at child, no dash).
      // doc_reference   = faint dashed undirected cross-link (no arrow).
      // doc_link        = faint mauve solid (existing treatment, no arrow, no dash).
      .linkColor(link => link.kind === 'doc_containment' ? CONTAINMENT_COLOR : LINK_REST)
      .linkWidth(link => link.kind === 'doc_containment' ? 2 : 1)
      .linkDirectionalArrowLength(link => link.kind === 'doc_containment' ? 4 : 0)
      .linkDirectionalArrowRelPos(1)
      .linkLineDash(link => link.kind === 'doc_reference' ? [2, 2] : null)
      .onNodeHover((node) => {
        hoveredId = node ? node.id : null;
        container.style.cursor = node ? 'pointer' : '';
      })
      // D-08: click a doc node → open its reader IN PLACE over the corpus.
      .onNodeClick((node) => {
        if (node && node.id) openDocReader(node.id);
      });

    // C2: tune force params for compact corpus framing (net-zero deps — tuning internal
    // d3-force references held by the force-graph instance, no import needed).
    try {
      const charge = G.d3Force('charge');
      if (charge && typeof charge.strength === 'function') charge.strength(-80);
      const link = G.d3Force('link');
      if (link && typeof link.distance === 'function') link.distance(50);
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
      CorpusGraph.zoomToFit(0, 40);
      // Immediately clamp the zoom ceiling (also 0ms). For a small graph zoomToFit lands
      // above MAX_ZOOM; this snaps it down before the next frame, no rubberband.
      if (typeof CorpusGraph.zoom === 'function' && CorpusGraph.zoom() > MAX_ZOOM) {
        CorpusGraph.zoom(MAX_ZOOM, 0);
      }
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
    // B3: hide topics/search in corpus view (mode-state visibility).
    const topicWrap = document.getElementById('topic-wrap');
    const searchWrap = document.getElementById('search-wrap');
    if (topicWrap) topicWrap.style.display = 'none';
    if (searchWrap) searchWrap.style.display = 'none';
    sizeCorpusGraph();
    corpusActive = true;
    // C1: icon button — aria-label/title + glyph swap (corpus active → show brain icon).
    corpusBtn.setAttribute('aria-label', 'Show brain');
    corpusBtn.setAttribute('title', 'Show brain');
    corpusBtn.innerHTML = ICON_BRAIN;
    corpusBtn.classList.add('corpus-active');
    // Fallback fit on a fixed timeout in case onEngineStop already fired before the
    // corpus was shown (e.g. a tiny graph settles instantly), or never fires.
    setTimeout(() => { if (corpusActive) fitAndClamp(); }, 350);
  }

  function showBrain() {
    container.classList.remove('open');
    if (brainEl) brainEl.style.visibility = '';
    // B3: restore topics/search when returning to brain view.
    const topicWrap = document.getElementById('topic-wrap');
    const searchWrap = document.getElementById('search-wrap');
    if (topicWrap) topicWrap.style.display = '';
    if (searchWrap) searchWrap.style.display = '';
    corpusActive = false;
    // C1: icon button — aria-label/title + glyph swap (brain active → restore book icon).
    corpusBtn.setAttribute('aria-label', 'Corpus graph');
    corpusBtn.setAttribute('title', 'Corpus');
    corpusBtn.innerHTML = ICON_BOOK;
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
    // B3: keep topics/search hidden when reader closes back to corpus.
    const topicWrap = document.getElementById('topic-wrap');
    const searchWrap = document.getElementById('search-wrap');
    if (topicWrap) topicWrap.style.display = 'none';
    if (searchWrap) searchWrap.style.display = 'none';
    corpusActive = true;
    // C1: icon button — aria-label/title + glyph swap (corpus active → show brain icon).
    corpusBtn.setAttribute('aria-label', 'Show brain');
    corpusBtn.setAttribute('title', 'Show brain');
    corpusBtn.innerHTML = ICON_BRAIN;
    corpusBtn.classList.add('corpus-active');
  };

  // showBrainFromCorpus(): reader.js calls this when an inline fact-ref is clicked
  // while the reader was opened over the corpus — the explicit hero interaction
  // deliberately drops to the brain (atom focus). Restore the 3D brain view.
  ctx.showBrainFromCorpus = function showBrainFromCorpus() {
    showBrain();
  };
}
