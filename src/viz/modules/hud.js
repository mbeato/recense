/**
 * @module hud
 * brain-memory viz — receding chrome HUD module (Plan 15-06, Task 2)
 *
 * initHud(ctx) implements:
 *   - ctx.logEvent(cat, msg)    — append timestamped entry to the event log
 *   - ctx.setSSEStatus(live)    — update the slim SSE dot/label (D-13)
 *   - Window error + unhandledrejection handlers with _lastErrMsg dedupe +
 *     visible toast/badge surfacing (D-14: errors never silent without devtools)
 *   - EventSource('/events') wiring: onopen/onerror → status + log;
 *     SSE 'trace' event → ctx.applyTrace(seeds) (D-102 SSE half)
 *   - Event-log toggle (hidden by default, btn-log reveals it) (D-14)
 *   - Tombstone toggle (btn-tombstones) re-applies graphData + updates node count
 *   - Toast element for visible error surfacing
 *
 * Security: logEvent uses textContent for log lines; node data is never injected
 * into innerHTML. Toast text set via textContent.
 */

export function initHud(ctx) {
  // ── DOM refs ───────────────────────────────────────────────────────────────
  const sseDotEl   = document.getElementById('sse-dot');
  const sseLabelEl = document.getElementById('sse-label');
  const ncountEl   = document.getElementById('ncount');
  const logEl      = document.getElementById('log');
  const btnLog     = document.getElementById('btn-log');
  const btnTomb    = document.getElementById('btn-tombstones');

  // ── Toast element (created once, reused) ───────────────────────────────────
  const toastEl = document.createElement('div');
  toastEl.className = 'toast';
  document.body.appendChild(toastEl);
  let toastTimer = null;

  function showToast(msg) {
    toastEl.textContent = msg.slice(0, 120); // textContent, never innerHTML
    toastEl.classList.add('toast-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('toast-visible'), 4500);
  }

  // ── State ──────────────────────────────────────────────────────────────────
  const evts = [];
  let _lastErrMsg = '';
  let showTombstones = false;

  // ── ctx.logEvent ───────────────────────────────────────────────────────────
  function logEvent(cat, msg) {
    const t = new Date().toISOString().slice(11, 23);
    evts.push({ t, cat, msg });
    if (logEl) {
      logEl.textContent = evts.slice(-40).map(e => `${e.t} [${e.cat}] ${e.msg}`).join('\n');
      logEl.scrollTop = logEl.scrollHeight;
    }
  }
  ctx.logEvent = logEvent;

  // ── ctx.setSSEStatus ───────────────────────────────────────────────────────
  function setSSEStatus(live) {
    if (sseDotEl)   sseDotEl.style.background = live ? '#5dd6a0' : '#ffd166';
    if (sseLabelEl) {
      sseLabelEl.style.color = live ? '#5dd6a0' : '#ffd166';
      sseLabelEl.textContent = live ? 'live'    : 'reconnecting…';
    }
  }
  ctx.setSSEStatus = setSSEStatus;

  // ── Error surfacing without devtools (D-14, Error Surfacing pattern) ───────
  window.addEventListener('error', ev => {
    const file = ev.filename ? ' @ ' + ev.filename.split('/').pop() + ':' + ev.lineno : '';
    const m = (ev.message || 'error') + file;
    if (m === _lastErrMsg) return; // deduplicate per-frame repeats
    _lastErrMsg = m;
    try { logEvent('error', m); } catch (_) {}
    showToast(m);
  });

  window.addEventListener('unhandledrejection', ev => {
    const m = 'promise: ' + ((ev.reason && ev.reason.message) || String(ev.reason));
    if (m === _lastErrMsg) return;
    _lastErrMsg = m;
    try { logEvent('error', m); } catch (_) {}
    showToast(m);
  });

  // ── Event log toggle (D-14: demoted, hidden by default) ───────────────────
  if (btnLog) {
    btnLog.addEventListener('click', () => {
      if (!logEl) return;
      const isHidden = logEl.style.display === '' || logEl.style.display === 'none';
      logEl.style.display = isHidden ? 'block' : 'none';
    });
  }

  // ── Tombstone toggle ───────────────────────────────────────────────────────
  // Exposes ctx.showTombstones so getVisibleNodes (set by app.js) can read it.
  ctx.showTombstones = false;

  if (btnTomb) {
    btnTomb.addEventListener('click', () => {
      showTombstones = !showTombstones;
      ctx.showTombstones = showTombstones;
      btnTomb.textContent = showTombstones ? 'Hide tombstones' : 'Show tombstones';

      // Re-apply graph data respecting tombstone state
      const allLinks = ctx.allLinks || [];
      let visibleNodes;
      if (typeof ctx.getVisibleNodes === 'function') {
        // app.js sets getVisibleNodes to read ctx.showTombstones
        visibleNodes = ctx.getVisibleNodes();
      } else {
        // Fallback: direct filter if getVisibleNodes not yet set
        visibleNodes = (ctx.allNodes || []).filter(n => showTombstones || !n.tombstoned);
      }

      if (ctx.Graph && typeof ctx.Graph.graphData === 'function') {
        ctx.Graph.graphData({ nodes: visibleNodes, links: allLinks });
      }
      if (ncountEl) ncountEl.textContent = String(visibleNodes.length);
      logEvent('hud', showTombstones ? 'tombstones shown' : 'tombstones hidden');
    });
  }

  // ── SSE EventSource('/events') wiring (D-102 SSE half) ────────────────────
  const es = new EventSource('/events');

  es.onopen = () => {
    setSSEStatus(true);
    logEvent('sse', 'connected');
  };

  es.onerror = () => {
    setSSEStatus(false);
    logEvent('sse', 'error/retry');
  };

  es.addEventListener('trace', ev => {
    let row;
    try {
      row = JSON.parse(ev.data);
    } catch (e) {
      logEvent('sse', 'bad trace payload: ' + String(e));
      return;
    }
    logEvent('sse-trace', '#' + row.id + ' seeds=[' + (row.seeds || []).join(',') + ']');
    if (typeof ctx.applyTrace === 'function') {
      ctx.applyTrace(row.seeds || []);
    }
  });

  // ── Initialize node count display ─────────────────────────────────────────
  function refreshNodeCount() {
    if (!ncountEl) return;
    const nodes = ctx.allNodes || [];
    ncountEl.textContent = String(nodes.filter(n => !n.tombstoned).length || nodes.length);
  }
  // Call after a brief delay to allow app.js to populate ctx.allNodes
  setTimeout(refreshNodeCount, 200);
}
