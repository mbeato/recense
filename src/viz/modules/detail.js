/**
 * @module detail
 * brain-memory viz — node detail panel module (Plan 15-06, Task 1)
 *
 * initDetail(ctx) implements:
 *   - ctx.selectNode(node)  — XSS-safe detail panel with slide-in and camera focus (D-15)
 *   - ctx.closeDetail()     — hide panel + backdrop, clear selection ring
 *   - Escape / backdrop / close-button dismiss handlers
 *   - textContent-only population (T-10-12: never innerHTML with node values)
 *   - Wikilink connection spans, clickable → ctx.selectNode(neighbor)
 *   - Selection ring (THREE.RingGeometry child of node.__mesh)
 *   - Camera focus on select via ctx.Graph.cameraPosition (gently, not a jump)
 *   - Cross-window focus subscriber (quick-260612-swc): listens on
 *     BroadcastChannel('recense-viz') for {type:'focus-node', id} from the
 *     adjacent detail window and focusNode()s the node (reveal + camera +
 *     amber pulse) — never via selectNode, so no detail-sentinel loop
 *
 * Threat model:
 *   T-10-12: all node values reach the DOM via textContent; innerHTML only used
 *            to clear own container structure (never with user data).
 */

import { MAX_FAN_OUT, PULSE_MS } from './constants.js';

// Focus-dim opacity for nodes outside the selected neighborhood
const FOCUS_DIM_OPACITY = 0.05;

/**
 * Shell-compact context (quick-260612-sdk): the tray popover loads the page
 * with ?shell=1 AND is ≤500px in its smaller dimension. There, the in-page
 * overlay would cover and clip the tiny window — node clicks route to the
 * adjacent detail BrowserWindow via sentinel navigation instead (the shell
 * intercepts /__recense/detail by exact pathname and prevents the nav).
 * Evaluated at click time; same size heuristic as stats.js COMPACT_VIEW,
 * deliberately defined locally (do NOT import stats.js).
 */
function shellCompact() {
  return new URLSearchParams(location.search).has('shell')
    && Math.min(window.innerWidth, window.innerHeight) <= 500;
}

export function initDetail(ctx) {
  // ── DOM refs ───────────────────────────────────────────────────────────────
  const detailEl   = document.getElementById('detail');
  const backdropEl = document.getElementById('backdrop');
  const titleEl    = document.getElementById('detail-title');
  const metaEl     = document.getElementById('detail-meta');
  const bodyEl     = document.getElementById('detail-body');
  const connsEl    = document.getElementById('detail-conns');
  const connsMoreEl = document.getElementById('detail-conns-more');
  const closeBtn   = document.querySelector('[aria-label="Close node detail"]');

  // ── State ──────────────────────────────────────────────────────────────────
  let selectedNode  = null;
  let selectionRing = null;
  let dimmedNodes   = [];   // nodes whose opacity we lowered for focus mode

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Return the connection records of `node`: [{edge, nb, rel, outgoing}].
   * Direction matters for traversal display ("rel →" vs "← rel").
   */
  function getConnections(node) {
    const edges = (ctx.adj && ctx.adj.get(node.id)) || [];
    const out = [];
    for (const e of edges) {
      const sid = typeof e.source === 'object' ? e.source.id : e.source;
      const tid = typeof e.target === 'object' ? e.target.id : e.target;
      const outgoing = sid === node.id;
      const nb = ctx.idMap && ctx.idMap.get(outgoing ? tid : sid);
      if (nb) out.push({ edge: e, nb, rel: e.rel || e.kind || 'linked', outgoing });
    }
    return out;
  }

  /** Return neighbor nodes of `node` from the adjacency map. */
  function getNeighbors(node) {
    return getConnections(node).map(c => c.nb);
  }

  /**
   * Micro-recall ripple (interaction feedback): the selected node flares and
   * warm pulses sweep its edges, lightly activating each neighbor. Composes
   * trace.js primitives (ctx.activate / ctx.spawnPulse) — does not touch the
   * locked applyTrace semantics. Interaction-triggered, so D-04 (idle
   * no-fake-firing) does not apply.
   */
  function ripple(node) {
    if (!ctx.activate || !ctx.spawnPulse) return;
    ctx.activate(node, 1.0);
    const conns = getConnections(node).slice(0, MAX_FAN_OUT);
    conns.forEach(({ nb }, i) => {
      setTimeout(() => {
        ctx.spawnPulse(node, nb);
        setTimeout(() => ctx.activate(nb, 0.55), PULSE_MS * 0.6);
      }, i * 40);
    });
  }

  /**
   * Click shockwave: an expanding additive shell from the selected node, so
   * every click — even on an unconnected fact — lands with physical feedback.
   * Animated via the stats master rAF loop (registerTick); cleans itself up.
   */
  const shocks = [];
  let shockGeo = null;
  function shockwave(node) {
    if (!ctx.THREE || !ctx.pulseGroup || !node.__mesh) return;
    if (!shockGeo) shockGeo = new ctx.THREE.SphereGeometry(1, 16, 16);
    const mat = new ctx.THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: ctx.THREE.AdditiveBlending,
      side: ctx.THREE.BackSide,
    });
    const mesh = new ctx.THREE.Mesh(shockGeo, mat);
    mesh.position.set(node.x || 0, node.y || 0, node.z || 0);
    ctx.pulseGroup.add(mesh);
    shocks.push({ mesh, t0: performance.now(), r0: node.__baseR || 2 });
  }

  if (typeof ctx.registerTick === 'function') {
    ctx.registerTick((now) => {
      for (let i = shocks.length - 1; i >= 0; i--) {
        const s = shocks[i];
        const t = (now - s.t0) / 650;
        if (t >= 1) {
          ctx.pulseGroup.remove(s.mesh);
          s.mesh.material.dispose();
          shocks.splice(i, 1);
          continue;
        }
        s.mesh.scale.setScalar(s.r0 * (1 + t * 14));
        s.mesh.material.opacity = 0.35 * (1 - t) * (1 - t);
      }
    });
  }

  /**
   * Focus mode: dim every node outside the selected neighborhood so the
   * clicked constellation stands alone. Opacity-only (restored on deselect);
   * never touches visibility, so LOD state is unaffected.
   */
  function applyFocusDim(node) {
    clearFocusDim();
    const keep = new Set([node.id]);
    for (const nb of getNeighbors(node)) keep.add(nb.id);
    for (const n of (ctx.allNodes || [])) {
      if (keep.has(n.id) || !n.__mat) continue;
      n.__mat.opacity = FOCUS_DIM_OPACITY;
      dimmedNodes.push(n);
    }
  }

  /** Restore opacity of all focus-dimmed nodes. */
  function clearFocusDim() {
    for (const n of dimmedNodes) {
      if (n.__mat && n.__baseOp !== undefined) n.__mat.opacity = n.__baseOp;
    }
    dimmedNodes = [];
  }

  /** Remove the selection ring from the previous node. */
  function clearSelection() {
    if (selectionRing && selectedNode && selectedNode.__mesh) {
      selectedNode.__mesh.remove(selectionRing);
    }
    selectionRing = null;
    selectedNode  = null;
    ctx.selectedId = null;  // read by graph.js for schema collapse-on-reclick
  }

  /**
   * Populate the detail panel with node data.
   * CRITICAL: all node values use textContent — never innerHTML (T-10-12).
   */
  function populateDetail(node) {
    // Title — textContent only
    titleEl.textContent = (node.value || '').slice(0, 120);

    // Metadata rows — createElement for every field (no template literals with node data)
    metaEl.innerHTML = ''; // safe: clears own DOM structure, not user data
    const fields = [
      ['type',       node.tombstoned ? 'tombstone' : (node.type || '—')],
      ['strength',   typeof node.s === 'number' ? node.s.toFixed(3) : '—'],
      ['confidence', typeof node.c === 'number' ? node.c.toFixed(3) : '—'],
      ['origin',     node.origin || '—'],
    ];
    if (node.tombstoned) {
      fields.push(['tombstone', String(node.tombstoned)]);
    }
    for (const [key, val] of fields) {
      const row  = document.createElement('div');
      row.className = 'meta-row';
      const k = document.createElement('span'); k.className = 'meta-key'; k.textContent = key;
      const v = document.createElement('span'); v.className = 'meta-val'; v.textContent = val;
      row.appendChild(k); row.appendChild(v);
      metaEl.appendChild(row);
    }

    // Body — textContent only
    bodyEl.textContent = node.value || '';

    // Connections grouped by relation — createElement + textContent throughout
    // (never innerHTML with neighbor values, T-10-12). Each row is a traversal
    // hop: click flies the camera to the neighbor, selects it, ripples again.
    connsEl.innerHTML = ''; // safe: clearing own structure
    connsMoreEl.textContent = '';
    const conns = getConnections(node);

    // Honest empty state for unconsolidated memories (most early-graph facts):
    // say why there is nothing to traverse instead of showing a blank section.
    if (!conns.length) {
      const empty = document.createElement('div');
      empty.className = 'conn-empty';
      empty.textContent = 'no connections yet — this memory hasn’t been linked into the graph by consolidation';
      connsEl.appendChild(empty);
      return;
    }

    const shown = conns.slice(0, MAX_FAN_OUT);
    const overflow = conns.length - shown.length;

    // Group by "rel + direction" so e.g. "abstracts →" and "← abstracts" are distinct
    const groups = new Map();
    for (const c of shown) {
      const label = c.outgoing ? c.rel + ' →' : '← ' + c.rel;
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(c);
    }

    for (const [label, members] of groups) {
      const groupEl = document.createElement('div');
      groupEl.className = 'conn-group';
      const relEl = document.createElement('span');
      relEl.className = 'conn-rel';
      relEl.textContent = label + ' (' + members.length + ')';
      groupEl.appendChild(relEl);
      for (const { nb } of members) {
        const span = document.createElement('span');
        span.className = 'conn-link';
        span.setAttribute('tabindex', '0');
        span.textContent = '[[' + (nb.value || nb.id || '').slice(0, 40) + ']]';
        span.addEventListener('click', () => selectNode(nb));
        span.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectNode(nb); }
        });
        groupEl.appendChild(span);
      }
      connsEl.appendChild(groupEl);
    }
    if (overflow > 0) {
      connsMoreEl.textContent = '+' + overflow + ' more';
    }
  }

  /** Show the detail panel with slide-in animation (D-15). */
  function showPanel() {
    // Step 1: make block (overrides CSS display:none) before adding transition class
    detailEl.style.display = 'block';
    // Step 2: force reflow so the transition fires from the translateX(16px)/opacity:0 state
    void detailEl.offsetWidth;
    // Step 3: add panel-open — CSS transitions opacity and transform
    detailEl.classList.add('panel-open');
    // NOTE: the #backdrop overlay is intentionally NOT shown — it would swallow
    // pointer events and block orbit/pan while a node is focused. Empty-space
    // dismiss is handled by Graph.onBackgroundClick (graph.js), which
    // distinguishes clicks from drags.
  }

  /** Hide the detail panel. */
  function hidePanel() {
    detailEl.classList.remove('panel-open');
    backdropEl.style.display = 'none';
    // After the CSS transition completes (0.22s), clear the inline display override
    const cleanup = () => {
      if (!detailEl.classList.contains('panel-open')) {
        detailEl.style.display = '';
      }
    };
    setTimeout(cleanup, 260);
  }

  /** Gently move the camera to frame the selected node (D-15, smooth not a jump). */
  function focusCamera(node) {
    if (!ctx.Graph || typeof ctx.Graph.cameraPosition !== 'function') return;
    const x = node.x || 0;
    const y = node.y || 0;
    const z = node.z || 0;
    // Offset camera ~280 units from the node (visible without too much zoom)
    ctx.Graph.cameraPosition(
      { x: x + 220, y: y + 80, z: z + 220 },
      { x, y, z },
      800  // 800ms smooth transition
    );
  }

  /**
   * Focus a node without selecting it (quick-260612-swc): reveal it through
   * the LOD if hidden (trace semantics — the next trace's fade-back may
   * re-hide it), fly the camera, fire an amber activation pulse, and hold
   * full framerate for the motion (markAnimating, NOT markActive — ambient
   * rotation must not stop; 260612-r9m precedent).
   *
   * Deliberately does NOT call selectNode: in shell-compact mode selectNode
   * navigates to the /__recense/detail sentinel, which would reload the
   * detail window and loop (detail window → focus → sentinel → reload).
   * focusNode avoids the loop by construction.
   */
  function focusNode(node) {
    if (ctx.nodeVisible && !ctx.nodeVisible(node)) {
      ctx.traceNodes.add(node.id);
      ctx.revealTrace([node], []);
    }
    focusCamera(node);
    if (ctx.activate) ctx.activate(node, 1.0);
    if (ctx.markAnimating) ctx.markAnimating(800 + 1800);
  }

  // ── Public API: selectNode ─────────────────────────────────────────────────

  function selectNode(node) {
    // 1. Clear previous selection
    clearSelection();
    if (!node) return;

    selectedNode = node;
    ctx.selectedId = node.id;  // read by graph.js for schema collapse-on-reclick

    // 2. Add selection ring as child of the node mesh (tracks position automatically)
    if (node.__mesh && node.__baseR && ctx.THREE) {
      // Unit radii: the ring is a child of the node mesh, whose scale IS the
      // node radius (D-05 shared unit geometry) — sizing the geometry by
      // __baseR too would square the radius (giant hoop on schema nodes).
      const ringGeo = new ctx.THREE.RingGeometry(1.4, 1.7, 32);
      const ringMat = new ctx.THREE.MeshBasicMaterial({
        color: 0xd9a05c,
        transparent: true,
        opacity: 0.6,
        side: ctx.THREE.DoubleSide,
        depthWrite: false,
      });
      selectionRing = new ctx.THREE.Mesh(ringGeo, ringMat);
      node.__mesh.add(selectionRing);
    }

    // 3+4. Detail surface — shell-compact routes to the adjacent window via
    // sentinel navigation (intercepted, never actually navigates); otherwise
    // the in-page overlay populates and slides in exactly as before.
    const compact = shellCompact();
    if (compact) {
      location.href = '/__recense/detail?id=' + encodeURIComponent(node.id);
    } else {
      // 3. Populate detail content (XSS-safe)
      populateDetail(node);

      // 4. Show panel with slide-in (D-15)
      showPanel();
    }

    // 5. Gently focus camera on the selected node (D-15)
    focusCamera(node);

    // 6. Interaction impact: shockwave + micro-recall ripple + focus dim.
    // The shockwave fires unconditionally so orphan facts still land a hit.
    // Focus dim is skipped in shell-compact: closeDetail is never invoked in
    // the popover, so the dim would stick with no dismiss path.
    shockwave(node);
    ripple(node);
    if (!compact) applyFocusDim(node);

    // 7. Reset idle timer so the camera focus is not overridden immediately
    if (typeof ctx.markActive === 'function') ctx.markActive();
  }

  // ── Public API: closeDetail ────────────────────────────────────────────────

  function closeDetail() {
    clearSelection();
    clearFocusDim();
    hidePanel();
  }

  // ── Event wiring ───────────────────────────────────────────────────────────

  // Close button
  if (closeBtn) {
    closeBtn.addEventListener('click', closeDetail);
  }

  // Backdrop tap-to-dismiss
  if (backdropEl) {
    backdropEl.addEventListener('click', closeDetail);
  }

  // Escape key dismiss
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && detailEl.style.display !== '' && detailEl.style.display !== 'none') {
      closeDetail();
    }
  });

  // Cross-window focus subscriber (quick-260612-swc). app.js only runs
  // initDetail in normal viz mode — the ?detail= branch loads detail-page.js
  // and never reaches here, so no mode check is needed. Unknown ids are
  // ignored silently (the two windows' graph payloads can drift between
  // sleep passes).
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('recense-viz');
    channel.addEventListener('message', e => {
      if (!e.data || e.data.type !== 'focus-node') return;
      const node = ctx.idMap && ctx.idMap.get(e.data.id);
      if (node) focusNode(node);
    });
  }

  // ── Expose on ctx ──────────────────────────────────────────────────────────
  ctx.selectNode  = selectNode;
  ctx.closeDetail = closeDetail;
}
