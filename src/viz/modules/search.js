/**
 * @module search
 * brain-memory viz — in-app incremental node search (Plan 19-01 / VIZ-07,
 * exploration revision: broad → narrow).
 *
 * initSearch(ctx) implements:
 *   - Full-window-only search affordance (gated by .mode-window CSS; graceful
 *     no-op when #search-wrap / #search-input are absent — popover/detail-page)
 *   - INCREMENTAL GET /search?q= as you type (debounced; BM25, LLM-free,
 *     user-initiated D-04) — candidates surface without knowing exact terms
 *   - A clickable candidate LIST (#search-results): scrub it (hover / ↓↑) to
 *     "peek" each node (amber glow in space), click / Enter to dive in via
 *     ctx.selectNode (fly + detail panel + traversable connection links).
 *   - #search-count shows "1 match" / "N matches" via textContent (T-10-12)
 *   - No-match / error states via the count line + ctx.showToast on fetch fail
 *   - ctx.clearSearch exposed for detail.js topic-region mutual exclusion
 *
 * Why no full-graph dim on each keystroke: dimming every node (O(allNodes)) on
 * every debounced input was heavy and visually jumpy. The candidate list is the
 * persistent "where are my matches" view; picking one routes through selectNode,
 * which applies the neighbourhood focus-dim exactly once.
 *
 * Security:
 *   T-10-12: result rows + count set via textContent; never innerHTML with user data.
 *   T-19-06: peek glow is a Three.js material change (ctx.activate), not DOM injection.
 *
 * Palette invariants:
 *   HOT amber (#ffb866) appears ONLY on Three.js node materials via ctx.activate.
 *   HTML chrome stays muted (amber only as a focus/hover border tint). No cyan.
 */

const DEBOUNCE_MS = 200;
const MAX_ROWS    = 20;   // server already caps SEARCH_LIMIT=20; mirror it client-side

export function initSearch(ctx) {
  // ── DOM refs ──────────────────────────────────────────────────────────────
  const wrapEl    = document.getElementById('search-wrap');
  const inputEl   = document.getElementById('search-input');
  const clearBtn  = document.getElementById('search-clear');
  const countEl   = document.getElementById('search-count');
  const resultsEl = document.getElementById('search-results');

  // Graceful no-op: popover / detail-page mode has no search DOM (D-03 / CSS gate).
  if (!wrapEl || !inputEl) return;

  // ── State ─────────────────────────────────────────────────────────────────
  let matchNodes = [];   // resolved node objects from the last successful fetch
  let active     = -1;   // index of keyboard-highlighted row (-1 = none)
  let debounceId = null;
  let seq        = 0;    // request sequence guard (drop stale responses)

  // ── Peek: light one node so the user sees where a candidate sits in space ──
  function peek(node) {
    if (node && ctx.activate) ctx.activate(node, 1.0);
  }

  // ── Render the candidate list (textContent only — T-10-12) ────────────────
  function renderResults() {
    if (!resultsEl) return;
    resultsEl.textContent = '';
    matchNodes.slice(0, MAX_ROWS).forEach((node, i) => {
      const row = document.createElement('div');
      row.className = 'result-row';
      row.setAttribute('role', 'option');
      if (i === active) row.classList.add('result-active');

      const kind = document.createElement('span');
      kind.className = 'result-kind';
      kind.textContent = node.tombstoned ? 'tomb' : (node.type || '·');
      row.appendChild(kind);

      const label = document.createElement('span');
      label.textContent = (node.value || node.id || '').slice(0, 80);
      row.appendChild(label);

      row.addEventListener('mouseenter', () => { active = i; markActiveRow(); peek(node); });
      row.addEventListener('click', () => pick(i));
      resultsEl.appendChild(row);
    });
  }

  /** Cheap highlight sync without re-rendering rows. */
  function markActiveRow() {
    if (!resultsEl) return;
    const rows = resultsEl.children;
    for (let i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('result-active', i === active);
    }
    if (active >= 0 && rows[active]) rows[active].scrollIntoView({ block: 'nearest' });
  }

  /** Dive into a candidate: full selection (camera + detail + connections). */
  function pick(i) {
    const node = matchNodes[i];
    if (!node || !ctx.selectNode) return;
    active = i;
    markActiveRow();
    ctx.selectNode(node);   // flies camera, opens detail w/ traversable links, ripples
    if (ctx.markActive) ctx.markActive();
  }

  // ── Incremental fetch (debounced) ─────────────────────────────────────────
  async function runSearch() {
    const value = inputEl.value.trim();
    if (value.length < 2) { resetResults(); return; }

    const mySeq = ++seq;
    let ids;
    try {
      const resp = await fetch('/search?q=' + encodeURIComponent(value));
      if (!resp.ok) throw new Error('status ' + resp.status);
      ids = await resp.json();
    } catch (_) {
      if (mySeq === seq && ctx.showToast) ctx.showToast('search unavailable — try again');
      return;
    }
    if (mySeq !== seq) return;  // a newer keystroke superseded this response

    matchNodes = [];
    active = -1;
    for (const id of (ids || [])) {
      const node = ctx.idMap && ctx.idMap.get(id);
      if (node) matchNodes.push(node);
    }

    if (countEl) {
      countEl.textContent = matchNodes.length === 0 ? 'no matches'
        : matchNodes.length === 1 ? '1 match'
        : `${matchNodes.length} matches`;
    }
    renderResults();
  }

  /** Clear the candidate list + count but keep the typed query. */
  function resetResults() {
    matchNodes = [];
    active = -1;
    if (resultsEl) resultsEl.textContent = '';
    if (countEl) countEl.textContent = '';
  }

  /** Full clear: query, list, count, × button. Camera/selection untouched. */
  function clearSearch() {
    if (debounceId) { clearTimeout(debounceId); debounceId = null; }
    seq++;                         // invalidate any in-flight response
    resetResults();
    if (inputEl) inputEl.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
  }

  // ── Input: debounced incremental search + × visibility ────────────────────
  inputEl.addEventListener('input', () => {
    if (clearBtn) clearBtn.style.display = inputEl.value ? 'flex' : 'none';
    if (debounceId) clearTimeout(debounceId);
    debounceId = setTimeout(runSearch, DEBOUNCE_MS);
  });

  // ── Keyboard: ↓/↑ scrub (peek), Enter dive, Escape clear ──────────────────
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') { clearSearch(); return; }

    if (e.key === 'ArrowDown' && matchNodes.length) {
      e.preventDefault();
      active = active < Math.min(matchNodes.length, MAX_ROWS) - 1 ? active + 1 : 0;
      markActiveRow(); peek(matchNodes[active]);
      return;
    }
    if (e.key === 'ArrowUp' && matchNodes.length) {
      e.preventDefault();
      active = active > 0 ? active - 1 : Math.min(matchNodes.length, MAX_ROWS) - 1;
      markActiveRow(); peek(matchNodes[active]);
      return;
    }
    if (e.key === 'Enter' && matchNodes.length) {
      e.preventDefault();
      pick(active >= 0 ? active : 0);   // dive into highlighted, else rank-1
      return;
    }
  });

  // ── × clear button ────────────────────────────────────────────────────────
  if (clearBtn) {
    clearBtn.addEventListener('click', () => { clearSearch(); inputEl.focus(); });
  }

  // ── ctx exposure (detail.js calls this for topic-region mutual exclusion) ──
  ctx.clearSearch = clearSearch;
}
