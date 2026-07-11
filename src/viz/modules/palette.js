/**
 * @module palette
 * recense viz — ⌘K command palette (Phase 59 Plan 03 / D-03..D-07).
 *
 * initPalette(ctx) implements:
 *   - ⌘K (or Ctrl-K) opens a single-input palette with Nodes / Topics / Commands
 *     sections; Escape closes it. Gated behind .mode-window (RESEARCH Pitfall 7 —
 *     the tray's compact popover never even arms the shortcut).
 *   - Nodes section: ctx.searchNodes (debounced PALETTE_DEBOUNCE_MS, server BM25,
 *     capped PALETTE_CAP_NODES).
 *   - Topics section: ctx.listTopics (client-side fuzzy match, capped
 *     PALETTE_CAP_TOPICS).
 *   - Commands section: a static, extensible registry (client-side fuzzy match,
 *     capped PALETTE_CAP_COMMANDS), filtered by the current view (D-06) before
 *     matching so commands adapt per view.
 *   - Select-and-go (D-05): node/topic picks route through flyToNode() — the
 *     D-06 view-switch wrapper that returns to brain BEFORE ctx.selectNode ever
 *     fires, so the damped camera never animates on a hidden canvas. Command
 *     picks call run(ctx) immediately. No preview-on-arrow, no auto-open detail.
 *   - ctx.openPalette exposed so the rail magnifier (Plan 04) can invoke it.
 *
 * Security:
 *   T-10-12 / T-44-19: every result row (node labels, topic names, command
 *   labels) reaches the DOM via textContent/createElement only — never innerHTML.
 *
 * Palette invariants:
 *   HOT amber appears ONLY on Three.js node materials via ctx.activate — this
 *   module introduces NO new amber fill/background/text anywhere in chrome.
 */

import {
  PALETTE_DEBOUNCE_MS, PALETTE_CAP_NODES, PALETTE_CAP_TOPICS, PALETTE_CAP_COMMANDS,
} from './constants.js';

// ── Pure matcher (unit-tested — tests/viz-hud-palette.test.ts) ──────────────

/**
 * Subsequence fuzzy score: every character of `query` must appear in
 * `candidate`, in order (case-insensitive). Contiguous runs and earlier first-
 * match positions score higher. Empty query matches everything (score 1).
 * A non-subsequence returns 0 (falsy).
 */
export function fuzzyScore(query, candidate) {
  const q = String(query || '').toLowerCase();
  const c = String(candidate || '').toLowerCase();
  if (q.length === 0) return 1;   // empty query matches everything

  let qi = 0;
  let score = 0;
  let prevMatchIndex = -1;
  let firstMatchIndex = -1;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      if (firstMatchIndex === -1) firstMatchIndex = ci;
      score += (prevMatchIndex !== -1 && ci === prevMatchIndex + 1) ? 3 : 1;
      prevMatchIndex = ci;
      qi++;
    }
  }
  if (qi < q.length) return 0;   // not a full subsequence — no match

  return score + Math.max(0, 10 - firstMatchIndex);   // earlier-match bonus
}

/** Score + sort (desc) + cap one section's candidate list against `query`.
 *  `getLabel(item)` extracts the string to match against; defaults to String(item). */
export function filterSection(query, items, cap, getLabel) {
  const label = getLabel || (x => String(x));
  const scored = [];
  for (const item of (items || [])) {
    const score = fuzzyScore(query, label(item));
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, cap).map(s => s.item);
}

export function initPalette(ctx) {
  // ── DOM refs ──────────────────────────────────────────────────────────────
  const panel     = document.getElementById('palette');
  const backdrop  = document.getElementById('palette-backdrop');
  const inputEl   = document.getElementById('palette-input');
  const resultsEl = document.getElementById('palette-results');
  const emptyEl   = document.getElementById('palette-empty');
  if (!panel || !inputEl || !resultsEl) return;   // graceful no-op

  // ── Command registry (D-02/D-04) ────────────────────────────────────────────
  // { id, label, run(ctx), visibleIn? } — visibleIn is an optional view-name
  // array ('brain'|'corpus'|'reader'|'stats'); entries without it show in every view.
  const commands = [
    { id: 'toggle-tombstones', label: 'Toggle tombstones',
      run: c => { if (c.toggleTombstones) c.toggleTombstones(); } },
    { id: 'show-log', label: 'Show event log',
      run: c => { if (c.toggleLog) c.toggleLog(); } },
    { id: 'open-settings', label: 'Open settings',
      run: () => { const btn = document.getElementById('btn-settings'); if (btn) btn.click(); } },
    { id: 'open-reader', label: 'Open reader',
      run: c => { if (c.openReader) c.openReader(); } },
    { id: 'open-corpus', label: 'Open corpus view', visibleIn: ['brain', 'reader'],
      run: c => { if (c.openCorpus) c.openCorpus(); } },
    { id: 'recenter', label: 'Recenter view', visibleIn: ['brain'],
      run: c => { if (c.recenter) c.recenter(220); } },
    // Phase 60 D-04/UI-SPEC — opens the stats takeover on its default (Usage) tab.
    // visibleIn omits 'stats' so the command self-hides while the dashboard is open.
    { id: 'open-stats', label: 'Open stats', visibleIn: ['brain', 'reader', 'corpus'],
      run: c => { if (c.openStatsDashboard) c.openStatsDashboard(); } },
  ];

  // ── View detection (D-06) — pure read of EXISTING state, no new coupling ───
  function readerIsOpen() {
    return (ctx.isReaderOpen && ctx.isReaderOpen())
      || document.documentElement.classList.contains('reader-open');
  }
  function currentView() {
    if (ctx.isStatsDashboardOpen && ctx.isStatsDashboardOpen()) return 'stats';
    if (ctx.isCorpusOpen && ctx.isCorpusOpen()) return 'corpus';
    if (readerIsOpen()) return 'reader';
    return 'brain';
  }

  // ── D-06 view-switch wrapper — the load-bearing half of D-06 ───────────────
  // Order matters: reader.js's hide() re-asserts CORPUS when the reader was
  // opened from corpus (Fix B) — closing the reader FIRST, then checking
  // isCorpusOpen(), always lands on brain. Checking corpus first and reader
  // second would let the reader-close undo the corpus->brain switch.
  function flyToNode(target) {
    // Stats takeover covers the whole window (#stats-view z:6, #graph hidden) —
    // close it first so the damped camera never animates on a hidden canvas (D-06).
    if (ctx.isStatsDashboardOpen && ctx.isStatsDashboardOpen() && ctx.closeStatsDashboard) ctx.closeStatsDashboard();
    if (readerIsOpen() && ctx.closeReader) ctx.closeReader();
    if (ctx.isCorpusOpen && ctx.isCorpusOpen() && ctx.showBrainFromCorpus) ctx.showBrainFromCorpus();
    if (ctx.selectNode) ctx.selectNode(target);
  }

  // ── State ───────────────────────────────────────────────────────────────────
  const state = { open: false };
  let debounceId = null;
  let searchSeq = 0;   // guards palette-side render against out-of-order resolves
  let nodeResults = [];
  let topicResults = [];
  let commandResults = [];

  // ── Open / close (settings.js show/hide shape) ──────────────────────────────
  function open() {
    panel.classList.add('open');
    if (backdrop) backdrop.classList.add('open');
    document.documentElement.classList.add('palette-open');
    state.open = true;
    inputEl.value = '';
    onQueryChange('');
    inputEl.focus();
  }
  function close() {
    panel.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
    document.documentElement.classList.remove('palette-open');
    state.open = false;
  }
  ctx.openPalette = open;

  // ── Render (textContent/createElement only — T-10-12) ──────────────────────
  function makeRow(text, onPick) {
    const row = document.createElement('div');
    row.className = 'palette-row';
    row.setAttribute('role', 'option');
    row.textContent = text;
    row.addEventListener('click', onPick);
    return row;
  }
  function addSection(heading, items, toRow) {
    if (!items.length) return;
    const h = document.createElement('div');
    h.className = 'palette-section-heading';
    h.textContent = heading;
    resultsEl.appendChild(h);
    for (const item of items) resultsEl.appendChild(toRow(item));
  }

  function pickNode(node) { close(); flyToNode(node); }
  function pickCommand(cmd) { close(); cmd.run(ctx); }

  function render() {
    resultsEl.textContent = '';
    addSection('Nodes', nodeResults, node =>
      makeRow((node.value || node.id || '').slice(0, 80), () => pickNode(node)));
    addSection('Topics', topicResults, t =>
      makeRow((t.node.value || t.node.id || '').slice(0, 60), () => pickNode(t.node)));
    addSection('Commands', commandResults, cmd =>
      makeRow(cmd.label, () => pickCommand(cmd)));

    const total = nodeResults.length + topicResults.length + commandResults.length;
    if (emptyEl) emptyEl.style.display = total === 0 ? 'block' : 'none';
    resultsEl.style.display = total === 0 ? 'none' : 'block';
  }

  // ── Query pipeline ───────────────────────────────────────────────────────────
  // Topics/Commands are cheap client-side matches — update immediately on every
  // keystroke. Nodes hits the server /search route — debounced (PALETTE_DEBOUNCE_MS,
  // reusing search.js's DEBOUNCE_MS value verbatim) with a local sequence guard so
  // an out-of-order stale resolve never clobbers a newer, already-rendered result.
  function onQueryChange(query) {
    const view = currentView();
    const visibleCommands = commands.filter(c => !c.visibleIn || c.visibleIn.includes(view));
    topicResults = filterSection(
      query, ctx.listTopics ? ctx.listTopics() : [], PALETTE_CAP_TOPICS,
      t => t.node.value || t.node.id || '',
    );
    commandResults = filterSection(query, visibleCommands, PALETTE_CAP_COMMANDS, c => c.label);
    render();

    if (debounceId) clearTimeout(debounceId);
    if (!query) { nodeResults = []; render(); return; }
    debounceId = setTimeout(() => {
      const mySeq = ++searchSeq;
      if (!ctx.searchNodes) return;
      ctx.searchNodes(query).then(nodes => {
        if (mySeq !== searchSeq) return;   // superseded by a newer keystroke
        nodeResults = nodes.slice(0, PALETTE_CAP_NODES);
        render();
      });
    }, PALETTE_DEBOUNCE_MS);
  }

  inputEl.addEventListener('input', () => onQueryChange(inputEl.value.trim()));

  // ── Keyboard: ⌘K/Ctrl-K toggles open, Escape closes (guarded independent
  // listener — no central dispatcher, coexists with reader.js/detail.js/
  // settings.js's own guarded listeners; RESEARCH Pitfall 3) ──────────────────
  document.addEventListener('keydown', ev => {
    if (!document.documentElement.classList.contains('mode-window')) return;   // popover never arms ⌘K
    const key = (ev.key || '').toLowerCase();
    if ((ev.metaKey || ev.ctrlKey) && key === 'k') {
      ev.preventDefault();
      if (state.open) close(); else open();
      return;
    }
    if (ev.key === 'Escape' && state.open) close();
  });

  if (backdrop) backdrop.addEventListener('click', () => close());
}
