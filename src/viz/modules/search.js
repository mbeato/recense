/**
 * @module search
 * brain-memory viz — in-app node search module (Plan 19-01, VIZ-07)
 *
 * initSearch(ctx) implements:
 *   - Full-window-only search affordance (gated by .mode-window CSS; graceful
 *     no-op when #search-wrap / #search-input are absent — popover/detail-page)
 *   - GET /search?q= fetch on Enter keypress (BM25, LLM-free, user-initiated D-04)
 *   - Matched nodes glow amber via ctx.activate (Three.js materials only — never HTML)
 *   - Non-matched nodes dim to FOCUS_DIM_OPACITY (0.05) via detail.js pattern
 *   - Camera flies to rank-1 match via ctx.Graph.cameraPosition (800ms smooth)
 *   - #search-count shows "1 match" / "N matches" via textContent (T-10-12)
 *   - No-match/error toasts via ctx.showToast (exposed from hud.js)
 *   - Keyboard nav: ↓/Tab advance, ↑/Shift-Tab retreat, Enter re-fly, Escape clear
 *   - Mutual exclusion with detail.js topic-region (Contract A↔B): closeDetail()
 *     called before search state is applied; ctx.clearSearch exposed for reverse
 *   - ctx.clearSearch exposed for detail.js to call on schema-region activation
 *
 * Security:
 *   T-10-12: result count set via textContent; never innerHTML with user data.
 *   T-19-06: matched-node amber glow is a Three.js material change, not DOM injection.
 *
 * Palette invariants:
 *   HOT amber (#ffb866) appears ONLY on Three.js node materials via ctx.activate.
 *   HTML chrome (input/button/count) stays muted — never apply HOT to HTML elements.
 *   No cyan/teal in any new glow or color assignment.
 */

// Focus-dim opacity — mirrors detail.js FOCUS_DIM_OPACITY (0.05) exactly.
const FOCUS_DIM_OPACITY = 0.05;

export function initSearch(ctx) {
  // ── DOM refs ──────────────────────────────────────────────────────────────
  const wrapEl   = document.getElementById('search-wrap');
  const inputEl  = document.getElementById('search-input');
  const clearBtn = document.getElementById('search-clear');
  const countEl  = document.getElementById('search-count');

  // Graceful no-op: popover / detail-page mode has no search DOM (D-03 / CSS gate).
  if (!wrapEl || !inputEl) return;

  // ── State ─────────────────────────────────────────────────────────────────
  let matchIds   = [];  // BM25-ranked node IDs from last successful fetch
  let cursor     = 0;   // 0 = no keyboard nav; 1..matchIds.length = current match
  let dimmedNodes = []; // nodes whose opacity was lowered — tracked for restore

  // ── Focus-dim helpers (mirrors detail.js applyFocusDim / clearFocusDim) ──

  /** Dim all nodes except those in keepIds set. Restores previous dim first. */
  function applySearchDim(keepIds) {
    clearSearchDim();
    const keep = new Set(keepIds);
    for (const n of (ctx.allNodes || [])) {
      if (keep.has(n.id) || !n.__mat) continue;
      n.__mat.opacity = FOCUS_DIM_OPACITY;
      dimmedNodes.push(n);
    }
  }

  /** Restore all dimmed nodes to their base opacity. */
  function clearSearchDim() {
    for (const n of dimmedNodes) {
      if (n.__mat && n.__baseOp !== undefined) n.__mat.opacity = n.__baseOp;
    }
    dimmedNodes = [];
  }

  // ── Camera fly-to helper (mirrors detail.js focusCamera) ─────────────────

  /** Fly the camera to frame the given node (smooth 800ms transition). */
  function flyToNode(node) {
    if (!ctx.Graph || typeof ctx.Graph.cameraPosition !== 'function') return;
    const x = node.x || 0, y = node.y || 0, z = node.z || 0;
    ctx.Graph.cameraPosition(
      { x: x + 220, y: y + 80, z: z + 220 },
      { x, y, z },
      800
    );
  }

  // ── Glow helper (mirrors trace.js activate pattern) ───────────────────────

  /** Apply HOT amber glow to matched nodes via ctx.activate (Three.js only). */
  function glowMatches(nodes) {
    for (const n of nodes) {
      if (ctx.activate) ctx.activate(n, 1.0);
    }
  }

  // ── Clear / reset search state ────────────────────────────────────────────

  /** Clear all search state: restore dim, hide count, reset cursor. Camera stays. */
  function clearSearch() {
    clearSearchDim();
    matchIds = [];
    cursor = 0;
    if (countEl) countEl.textContent = '';
    if (clearBtn) clearBtn.style.display = 'none';
    if (inputEl) inputEl.value = '';
  }

  // ── Submit handler ────────────────────────────────────────────────────────

  async function doSearch() {
    const value = inputEl.value.trim();
    // Minimum 2 chars — do nothing for shorter queries (no fetch, no toast).
    if (value.length < 2) return;

    let ids;
    try {
      const resp = await fetch('/search?q=' + encodeURIComponent(value));
      if (!resp.ok) throw new Error('status ' + resp.status);
      ids = await resp.json();
    } catch (_) {
      if (ctx.showToast) ctx.showToast('search unavailable — try again');
      return;
    }

    // Atomically replace previous state (dim-restore first, then apply new).
    clearSearchDim();
    matchIds = [];
    cursor = 0;

    // Mutual exclusion with topic-region (Contract A↔B): close detail/region first.
    if (ctx.closeDetail) ctx.closeDetail();

    if (!ids || ids.length === 0) {
      if (ctx.showToast) ctx.showToast('no matches');
      if (countEl) countEl.textContent = '';
      return;
    }

    // Resolve node objects (some IDs may not be in the loaded graph — skip safely).
    const matchNodes = [];
    for (const id of ids) {
      const node = ctx.idMap && ctx.idMap.get(id);
      if (node) matchNodes.push(node);
    }

    if (matchNodes.length === 0) {
      if (ctx.showToast) ctx.showToast('no matches');
      if (countEl) countEl.textContent = '';
      return;
    }

    matchIds = matchNodes.map(n => n.id);
    cursor = 0;

    // Dim all non-matching nodes; glow all matching nodes (amber HOT via activate).
    applySearchDim(new Set(matchIds));
    glowMatches(matchNodes);

    // Fly to rank-1 match.
    flyToNode(matchNodes[0]);

    // Update result count via textContent (T-10-12 — never innerHTML).
    if (countEl) {
      countEl.textContent = matchIds.length === 1
        ? '1 match'
        : `${matchIds.length} matches`;
    }

    // Reset idle timer so fly-to isn't overridden immediately.
    if (ctx.markActive) ctx.markActive();
  }

  // ── Keyboard navigation helpers ───────────────────────────────────────────

  /** Re-fly to the node at position `cursor` (1-indexed). */
  function flyToCursor() {
    if (cursor < 1 || cursor > matchIds.length) return;
    const id = matchIds[cursor - 1];
    const node = ctx.idMap && ctx.idMap.get(id);
    if (node) flyToNode(node);
  }

  // ── Input event: toggle × clear button visibility ─────────────────────────
  inputEl.addEventListener('input', () => {
    if (clearBtn) {
      clearBtn.style.display = inputEl.value ? 'flex' : 'none';
    }
  });

  // ── Keydown: Enter submit + ↓↑/Tab/Shift-Tab nav + Escape clear ──────────
  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      if (cursor > 0 && matchIds.length > 0) {
        // Re-fly to current keyboard-nav position (no re-fetch).
        flyToCursor();
      } else {
        doSearch();
      }
      return;
    }

    if (e.key === 'Escape') {
      clearSearch();
      return;
    }

    // ↓ / Tab: advance cursor (wrap). Only when results are active.
    if ((e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) && matchIds.length > 0) {
      e.preventDefault(); // don't shift focus on Tab
      cursor = cursor < matchIds.length ? cursor + 1 : 1;
      flyToCursor();
      return;
    }

    // ↑ / Shift-Tab: retreat cursor (wrap). Only when results are active.
    if ((e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) && matchIds.length > 0) {
      e.preventDefault(); // don't shift focus on Shift-Tab
      cursor = cursor > 1 ? cursor - 1 : matchIds.length;
      flyToCursor();
      return;
    }
  });

  // ── × clear button click ──────────────────────────────────────────────────
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      clearSearch();
      inputEl.focus();
    });
  }

  // ── ctx exposure ──────────────────────────────────────────────────────────
  ctx.clearSearch = clearSearch;
}
