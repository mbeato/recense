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
 *
 * Threat model:
 *   T-10-12: all node values reach the DOM via textContent; innerHTML only used
 *            to clear own container structure (never with user data).
 */

import { MAX_FAN_OUT } from './constants.js';

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

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Return neighbor nodes of `node` from the adjacency map. */
  function getNeighbors(node) {
    const edges = (ctx.adj && ctx.adj.get(node.id)) || [];
    return edges.map(e => {
      const sid = typeof e.source === 'object' ? e.source.id : e.source;
      const tid = typeof e.target === 'object' ? e.target.id : e.target;
      const nbId = sid === node.id ? tid : sid;
      return ctx.idMap && ctx.idMap.get(nbId);
    }).filter(Boolean);
  }

  /** Remove the selection ring from the previous node. */
  function clearSelection() {
    if (selectionRing && selectedNode && selectedNode.__mesh) {
      selectedNode.__mesh.remove(selectionRing);
    }
    selectionRing = null;
    selectedNode  = null;
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

    // Wikilink connections — createElement + textContent (never innerHTML with neighbor values)
    connsEl.innerHTML = ''; // safe: clearing own structure
    connsMoreEl.textContent = '';
    const neighbors = getNeighbors(node);
    const shown = neighbors.slice(0, MAX_FAN_OUT);
    const overflow = neighbors.length - shown.length;
    for (const nb of shown) {
      const span = document.createElement('span');
      span.className = 'conn-link';
      span.setAttribute('tabindex', '0');
      span.textContent = '[[' + (nb.value || nb.id || '').slice(0, 40) + ']]';
      span.addEventListener('click', () => selectNode(nb));
      span.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectNode(nb); }
      });
      connsEl.appendChild(span);
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
    backdropEl.style.display = 'block';
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

  // ── Public API: selectNode ─────────────────────────────────────────────────

  function selectNode(node) {
    // 1. Clear previous selection
    clearSelection();
    if (!node) return;

    selectedNode = node;

    // 2. Add selection ring as child of the node mesh (tracks position automatically)
    if (node.__mesh && node.__baseR && ctx.THREE) {
      const r = node.__baseR;
      const ringGeo = new ctx.THREE.RingGeometry(r * 1.4, r * 1.7, 32);
      const ringMat = new ctx.THREE.MeshBasicMaterial({
        color: 0xd9a05c,
        transparent: true,
        opacity: 0.9,
        side: ctx.THREE.DoubleSide,
        depthWrite: false,
      });
      selectionRing = new ctx.THREE.Mesh(ringGeo, ringMat);
      node.__mesh.add(selectionRing);
    }

    // 3. Populate detail content (XSS-safe)
    populateDetail(node);

    // 4. Show panel with slide-in (D-15)
    showPanel();

    // 5. Gently focus camera on the selected node (D-15)
    focusCamera(node);

    // 6. Reset idle timer so the camera focus is not overridden immediately
    if (typeof ctx.markActive === 'function') ctx.markActive();
  }

  // ── Public API: closeDetail ────────────────────────────────────────────────

  function closeDetail() {
    clearSelection();
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

  // ── Expose on ctx ──────────────────────────────────────────────────────────
  ctx.selectNode  = selectNode;
  ctx.closeDetail = closeDetail;
}
