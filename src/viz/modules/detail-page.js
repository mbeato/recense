/**
 * @module detail-page
 * brain-memory viz — lean detail-only render path (quick-260612-sdk).
 *
 * Rendered when the page is loaded as /?detail=<nodeId> — the adjacent
 * frameless detail window opened by the tray shell next to the compact
 * popover. Skips ALL 3D/graph init (app.js branches before the UMD
 * injection); fetches /graph once and renders the overlay's field set
 * into the existing #detail panel from index.html.
 *
 * Connection links are clickable (quick-260612-swc): clicking a
 * [[connection]] re-renders the page in place for that node from the
 * cached /graph payload (no refetch, no navigation), updates ?detail= via
 * history.replaceState, and publishes {type:'focus-node', id} on
 * BroadcastChannel('recense-viz') so the popover viz — same origin, same
 * Electron session — flies its camera to the node with an amber pulse.
 * Zero shell involvement; with no listener the postMessage is a no-op.
 *
 * Threat model:
 *   T-Q-01 (= T-10-12): every node/neighbor value reaches the DOM via
 *   textContent; innerHTML is used only to clear own container structure.
 *
 * Shell signal: Esc navigates to the relative sentinel
 * /__recense/detail-close — the shell intercepts it by exact pathname and
 * hides the window. In a plain browser nobody reaches ?detail= pages, and
 * a stray navigation just 404s harmlessly.
 */

import { MAX_FAN_OUT } from './constants.js';

export async function renderDetailPage(nodeId) {
  // Detail mode: no 3D scene — hide the canvas host, mark the body so the
  // .detail-page CSS block re-lays-out the panel as the whole surface.
  const graphEl = document.getElementById('graph');
  if (graphEl) graphEl.style.display = 'none';
  document.body.classList.add('detail-page');

  const detailEl    = document.getElementById('detail');
  const titleEl     = document.getElementById('detail-title');
  const metaEl      = document.getElementById('detail-meta');
  const bodyEl      = document.getElementById('detail-body');
  const connsEl     = document.getElementById('detail-conns');
  const connsMoreEl = document.getElementById('detail-conns-more');

  function show() {
    detailEl.style.display = 'block';
    detailEl.classList.add('panel-open');
  }

  // Esc → shell close sentinel (relative path; exact-pathname intercepted).
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') location.href = '/__recense/detail-close';
  });

  // Cross-window focus channel (quick-260612-swc): same-origin renderers in
  // the same Electron session share BroadcastChannel — zero shell involvement.
  // Guarded so a plain browser without the API (or with no listener) is a no-op.
  const channel = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('recense-viz')
    : null;

  // ── Fetch graph data — honest error states, never a silent blank window ──
  let data = null;
  try {
    const r = await fetch('/graph');
    if (!r.ok) throw new Error('GET /graph → ' + r.status);
    data = await r.json();
  } catch (_) {
    titleEl.textContent = 'failed to load memory';
    show();
    return;
  }

  const nodes = (data && data.nodes) || [];
  const links = (data && data.links) || [];

  /** @type {Map<string, Object>} node.id → node object */
  const idMap = new Map();
  for (const n of nodes) idMap.set(n.id, n);

  /**
   * Render the page for one node from the cached payload. Called once for
   * the initial node and again on every conn-link click (in-place traversal,
   * no refetch / no navigation). Registers NO listeners on document/window —
   * those live in the one-time setup above so they never accumulate.
   */
  function renderNode(id) {
    const node = idMap.get(id);
    if (!node) {
      titleEl.textContent = 'memory not found';
      show();
      return;
    }

    // ── Populate — mirrors detail.js populateDetail, textContent only ──────
    titleEl.textContent = (node.value || '').slice(0, 120);

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
      const row = document.createElement('div');
      row.className = 'meta-row';
      const k = document.createElement('span'); k.className = 'meta-key'; k.textContent = key;
      const v = document.createElement('span'); v.className = 'meta-val'; v.textContent = val;
      row.appendChild(k); row.appendChild(v);
      metaEl.appendChild(row);
    }

    bodyEl.textContent = node.value || '';

    // ── Connections built client-side from links (both directions) ─────────
    const conns = [];
    for (const l of links) {
      const sid = typeof l.source === 'object' ? l.source.id : l.source;
      const tid = typeof l.target === 'object' ? l.target.id : l.target;
      if (sid !== node.id && tid !== node.id) continue;
      const outgoing = sid === node.id;
      const nb = idMap.get(outgoing ? tid : sid);
      if (nb) conns.push({ nb, rel: l.rel || l.kind || 'linked', outgoing });
    }

    connsEl.innerHTML = ''; // safe: clearing own structure
    connsMoreEl.textContent = '';

    if (!conns.length) {
      const empty = document.createElement('div');
      empty.className = 'conn-empty';
      empty.textContent = 'no connections yet — this memory hasn’t been linked into the graph by consolidation';
      connsEl.appendChild(empty);
      show();
      return;
    }

    const shown = conns.slice(0, MAX_FAN_OUT);
    const overflow = conns.length - shown.length;

    // Group by "rel + direction" — "abstracts →" vs "← abstracts" are distinct
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
        // Clickable traversal (quick-260612-swc): re-render in place from the
        // cached payload, keep the URL honest, focus the node in the popover.
        const span = document.createElement('span');
        span.className = 'conn-link';
        span.setAttribute('tabindex', '0');
        span.textContent = '[[' + (nb.value || nb.id || '').slice(0, 40) + ']]';
        const go = () => {
          renderNode(nb.id);
          const u = new URL(location.href);
          u.searchParams.set('detail', nb.id);
          history.replaceState(null, '', u);
          if (channel) channel.postMessage({ type: 'focus-node', id: nb.id });
        };
        span.addEventListener('click', go);
        span.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
        });
        groupEl.appendChild(span);
      }
      connsEl.appendChild(groupEl);
    }
    if (overflow > 0) {
      connsMoreEl.textContent = '+' + overflow + ' more';
    }

    show();
  }

  renderNode(nodeId);
}
