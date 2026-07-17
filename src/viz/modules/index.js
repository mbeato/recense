/**
 * @module index
 * recense viz — browsable text index of the live doc corpus (WIKI-01, 39-02).
 *
 * The index is a DOCKED LEFT COLUMN outside the flat 2D corpus graph (GAP-10 closure — supersedes
 * the GAP-9 detached-floating-window paradigm): it lives at the window's left edge, attached to
 * the main app window, and #corpus-graph REFLOWS beside it (body.index-docked + ctx.refitCorpus)
 * so the graph never sits underneath. There is NO dedicated toolbar button. The panel starts
 * CLOSED (GAP-6, founder direction): entering the corpus shows only the left-edge reopen handle
 * (corpus.js calls ctx.showIndexHandle). The user opens it explicitly via the handle
 * (ctx.openIndexSidebar / openSidebar), which docks the column and reflows the graph beside it.
 * Returning to the brain hides the panel and the handle (ctx.closeIndexSidebar). A ◀ collapse
 * control hides an open panel for more graph room (undocking + re-expanding the graph); the slim
 * reopen handle on the left edge brings it back.
 *
 * Sections (both rendered as nested trees, server partitions docs by tree-root type):
 *   - Projects: human-scoped docs (e.g. 'tonos') + any schema chapters nested under a project
 *   - Notes: schema-anchored one-off docs (each derived from an induced concept), nested under
 *     their related project when resolvable (GAP-4/GAP-8); the payload key stays `schemas`
 *
 * A search/filter box filters the list by label substring (WIKI-01 re-verify — deep-research
 * verdict: at ~22 docs, search + the existing hierarchy beats auto-clustering, which is unstable
 * at this scale; clustered categories are a 100+-doc follow-up). Matching rows keep their
 * ancestors visible so tree context is preserved.
 *
 * Interactions:
 *   - Row hover → highlight the matching node + its containment subtree in the corpus graph.
 *   - Row click → open that doc's reader IN PLACE over the corpus (ctx.openReader from:'corpus').
 *
 * Security (T-39-08): all DB-sourced strings (label, slug) set via .textContent only;
 * slug used in navigation passed through encodeURIComponent. No innerHTML with user data.
 */

// ── Icon SVGs (inline — net-zero deps, no icon lib) ─────────────────────────────────
const ICON_CHEVRON_LEFT = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
const ICON_CHEVRON_RIGHT = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
// Per-row tree expand/collapse toggle (D-01) — same stroke recipe as ICON_CHEVRON_RIGHT above,
// smaller box; rotated 90deg via CSS (.index-chevron.expanded) rather than a second SVG asset.
const ICON_CHEVRON_TOGGLE = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

/**
 * Initialise the browsable doc index sidebar.
 * Lazy: /index is only fetched on the first open. No toolbar button — opened by corpus.js.
 *
 * @param {Object} ctx shared viz context
 */
export function initIndex(ctx) {
  const container = document.getElementById('index-panel');
  if (!container) return;

  let isSidebarOpen = false;
  let contentEl = null;       // scrollable host for the rendered sections (cleared on re-filter)
  let searchInput = null;
  let reopenHandle = null;
  let lastData = { projects: [], schemas: [] }; // cached /index payload for client-side filtering
  let currentFilter = '';
  // Project (tree-root) entry ids the user has expanded — in-memory only (D-01: persists across
  // corpus close/reopen within a session, resets on hard reload; never localStorage).
  const expandedIds = new Set();
  // Slug of the currently-focused project (GAP-3) — mirrors corpus.js's focusedScope, kept in
  // sync via ctx.syncCorpusFocus so the index's active row always matches graph focus state.
  let activeScope = null;

  // ── Static sidebar chrome: header (title + collapse) + search + scrollable content ──────
  function ensureChrome() {
    if (contentEl) return;
    const header = document.createElement('div');
    header.className = 'index-sidebar-header';

    const title = document.createElement('span');
    title.className = 'index-sidebar-title';
    title.textContent = 'Index'; // textContent — T-39-08
    header.appendChild(title);

    const collapse = document.createElement('button');
    collapse.type = 'button';
    collapse.className = 'index-collapse';
    collapse.setAttribute('aria-label', 'Collapse index');
    collapse.setAttribute('title', 'Collapse index');
    collapse.innerHTML = ICON_CHEVRON_LEFT;
    collapse.addEventListener('click', collapseSidebar);
    header.appendChild(collapse);

    const searchWrap = document.createElement('div');
    searchWrap.className = 'index-search';
    searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'index-search-input';
    searchInput.setAttribute('placeholder', 'Filter docs…');
    searchInput.setAttribute('aria-label', 'Filter docs');
    searchInput.setAttribute('autocomplete', 'off');
    searchInput.addEventListener('input', () => {
      currentFilter = searchInput.value.trim().toLowerCase();
      renderSections();
    });
    searchWrap.appendChild(searchInput);

    contentEl = document.createElement('div');
    contentEl.className = 'index-content';

    container.appendChild(header);
    container.appendChild(searchWrap);
    container.appendChild(contentEl);
  }

  // Slim left-edge handle to reopen the index after it's collapsed (shown only while collapsed).
  function ensureReopenHandle() {
    if (reopenHandle) return;
    reopenHandle = document.createElement('button');
    reopenHandle.type = 'button';
    reopenHandle.id = 'index-reopen';
    reopenHandle.setAttribute('aria-label', 'Show index');
    reopenHandle.setAttribute('title', 'Show index');
    reopenHandle.innerHTML = ICON_CHEVRON_RIGHT;
    reopenHandle.addEventListener('click', openSidebar);
    document.body.appendChild(reopenHandle);
  }

  // ── Row + section builders ───────────────────────────────────────────────────────────
  // Build one <a> row for an index entry (shared by both section trees).
  function makeEntryAnchor(entry) {
    const a = document.createElement('a');
    a.className = 'index-entry doc-ref';
    a.setAttribute('href', '#');
    a.textContent = entry.label || entry.slug; // textContent — T-39-08
    a.addEventListener('mouseenter', () => {
      if (typeof ctx.highlightCorpusNode === 'function') ctx.highlightCorpusNode(entry.slug);
    });
    a.addEventListener('mouseleave', () => {
      if (typeof ctx.highlightCorpusNode === 'function') ctx.highlightCorpusNode(null);
    });
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      if (typeof ctx.openReader === 'function') ctx.openReader(entry.slug, { from: 'corpus' });
      else window.location.href = '/?doc=' + encodeURIComponent(entry.slug) + '&reader=1';
    });
    return a;
  }

  function makeSection(title) {
    const section = document.createElement('div');
    section.className = 'index-section';
    const heading = document.createElement('div');
    heading.className = 'index-heading';
    heading.textContent = title; // textContent — T-39-08
    section.appendChild(heading);
    const list = document.createElement('ul');
    list.className = 'index-list';
    section.appendChild(list);
    contentEl.appendChild(section);
    return list;
  }

  // Compute the visible-id set for a filter: matching rows PLUS their ancestors (so a match keeps
  // its tree context). Returns null when there's no filter (everything visible).
  // While filtering, every ancestor pulled into `visible` is also force-expanded (added to
  // expandedIds) so its branch actually renders (D-01 filter auto-expand). expandedIds is only
  // ever UNIONED into here, never rebuilt from the filter set — clearing the filter must not
  // collapse rows the user separately/manually expanded.
  function computeVisible(entries, filter) {
    if (!filter) return null;
    const byId = new Map(entries.map(e => [e.id, e]));
    const visible = new Set();
    for (const e of entries) {
      if ((e.label || e.slug || '').toLowerCase().includes(filter)) {
        visible.add(e.id);
        let cur = e;
        while (cur && cur.parentId && byId.has(cur.parentId)) {
          const ancestorId = cur.parentId;
          const wasAlreadyExpanded = expandedIds.has(ancestorId);
          visible.add(ancestorId);
          expandedIds.add(ancestorId);
          // WR-06 (61-15): a filter-driven expansion must also reveal the chapters in the
          // GRAPH, not just the tree (D-07 tree↔graph parity) — but only for a NEWLY expanded
          // tree ROOT (its own parentId is null or not present in this section's byId map).
          // Non-root ancestors don't gate corpus reveal (only project roots do).
          if (!wasAlreadyExpanded) {
            const ancestorEntry = byId.get(ancestorId);
            const isRoot = !ancestorEntry.parentId || !byId.has(ancestorEntry.parentId);
            if (isRoot && typeof ctx.setCorpusProjectExpanded === 'function') {
              ctx.setCorpusProjectExpanded(ancestorEntry.slug, true);
            }
          }
          cur = byId.get(ancestorId);
        }
      }
    }
    return visible;
  }

  // Toggle a project (tree-root) entry's expanded state, notify corpus.js (D-07 chapter reveal),
  // and re-render the tree so the gated child rows actually appear/disappear.
  // scope is ALWAYS the project-root entry's slug (see SCOPE ARGUMENT note in the plan — the
  // /index Entry payload has no `scope` field on entries; reading it would be undefined and
  // would silently no-op the corpus hook).
  function setProjectExpanded(entry, expand) {
    const scope = entry.slug;
    if (expand) expandedIds.add(entry.id); else expandedIds.delete(entry.id);
    if (typeof ctx.setCorpusProjectExpanded === 'function') ctx.setCorpusProjectExpanded(scope, expand);
    renderSections();
  }

  // Build a collapsible project (tree-root-with-children) row: chevron + name + doc-count badge
  // (D-01). Chevron toggles expand/collapse only (own hit target, stopPropagation). The name
  // click both expands the row AND focuses the project in the graph in one click (D-03).
  function makeProjectRow(entry, count, expanded, depth, isActive) {
    const row = document.createElement('div');
    row.className = 'index-row' + (isActive ? ' active' : '');
    if (isActive) row.setAttribute('aria-current', 'true');
    row.style.paddingLeft = (8 + depth * 14) + 'px'; // indent by containment depth
    row.style.paddingRight = '8px';

    const chevron = document.createElement('button');
    chevron.type = 'button';
    chevron.className = 'index-chevron' + (expanded ? ' expanded' : '');
    chevron.setAttribute('aria-label', (expanded ? 'Collapse ' : 'Expand ') + (entry.label || entry.slug));
    chevron.innerHTML = ICON_CHEVRON_TOGGLE;
    chevron.addEventListener('click', (ev) => {
      ev.stopPropagation(); // never trigger the project name-click
      setProjectExpanded(entry, !expandedIds.has(entry.id));
    });
    row.appendChild(chevron);

    const a = document.createElement('a');
    a.className = 'index-entry doc-ref';
    a.setAttribute('href', '#');
    a.textContent = entry.label || entry.slug; // textContent — T-39-08
    a.addEventListener('mouseenter', () => {
      if (typeof ctx.highlightCorpusNode === 'function') ctx.highlightCorpusNode(entry.slug);
    });
    a.addEventListener('mouseleave', () => {
      if (typeof ctx.highlightCorpusNode === 'function') ctx.highlightCorpusNode(null);
    });
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      const scope = entry.slug; // project-root slug — see SCOPE ARGUMENT note (not a `.scope` field)
      // WR-04 (61-15): activeScope is no longer written here — ctx.syncCorpusFocus is the
      // single writer (set at its declaration + inside syncCorpusFocus only). corpus.js's
      // focusCorpusProject calls syncCorpusFocus ONLY when the focus actually takes (a
      // recognized scope), so a click on a row whose scope isn't focusable leaves activeScope
      // untouched and the row never paints .active/aria-current (GAP-3 phantom-active fix).
      if (activeScope === scope) {
        // Clicking the already-active row toggles focus OFF (GAP-3) — collapse stays
        // chevron-owned, so the row's expanded state is left untouched here.
        if (typeof ctx.focusCorpusProject === 'function') ctx.focusCorpusProject(null);
      } else {
        if (!expandedIds.has(entry.id)) setProjectExpanded(entry, true);
        if (typeof ctx.focusCorpusProject === 'function') ctx.focusCorpusProject(scope);
      }
      renderSections();
    });
    row.appendChild(a);

    const countEl = document.createElement('span');
    countEl.className = 'index-count';
    countEl.textContent = String(count); // textContent — T-39-08
    row.appendChild(countEl);

    return row;
  }

  // Nested tree section (Projects + Schemas) — children indented under their doc_containment
  // parent. Roots are entries whose parentId is null or points outside this section's set.
  // `visible` (or null) filters which rows render; siblings sorted by label.
  //
  // A root WITH children renders as a collapsible project row (chevron + name + count badge);
  // its child rows are only emitted (recursively) while expandedIds.has(root.id) — a collapsed
  // project renders zero child rows (not render-then-hide). A root with no children (a leaf doc)
  // renders as a plain .index-entry row, unchanged from before. Collapsibility applies only at
  // the root level — nested (non-root) entries under an expanded project render as plain rows.
  function renderTreeSection(title, entries, visible) {
    if (!entries || entries.length === 0) return false;
    const shown = entries.filter(e => visible === null || visible.has(e.id));
    if (shown.length === 0) return false;
    const byId = new Map();
    for (const e of entries) byId.set(e.id, e);
    const children = new Map();
    const roots = [];
    for (const e of entries) {
      if (e.parentId && byId.has(e.parentId)) {
        if (!children.has(e.parentId)) children.set(e.parentId, []);
        children.get(e.parentId).push(e);
      } else {
        roots.push(e);
      }
    }
    const byLabel = (a, b) => (a.label || a.slug).localeCompare(b.label || b.slug);
    const list = makeSection(title);
    const seen = new Set();

    // Recursive descendant-doc count for a project's count badge (not counting the root itself);
    // guards against malformed parentId cycles (T-61-08, same defensive posture as `seen` below).
    const countDescendants = (id, seenCount) => {
      let n = 0;
      for (const k of (children.get(id) || [])) {
        if (seenCount.has(k.id)) continue;
        seenCount.add(k.id);
        n += 1 + countDescendants(k.id, seenCount);
      }
      return n;
    };

    // Plain child/leaf row — existing behavior, unchanged.
    const emitLeaf = (entry, depth) => {
      if (seen.has(entry.id)) return;          // defensive: never loop on malformed data
      seen.add(entry.id);
      if (visible === null || visible.has(entry.id)) {
        const li = document.createElement('li');
        const a = makeEntryAnchor(entry);
        a.style.paddingLeft = (8 + depth * 14) + 'px'; // indent by containment depth
        li.appendChild(a);
        list.appendChild(li);
      }
      for (const k of (children.get(entry.id) || []).slice().sort(byLabel)) emitLeaf(k, depth + 1);
    };

    // Root-level entry: project row (has children) or plain leaf row (no children).
    const emit = (entry, depth) => {
      if (seen.has(entry.id)) return;
      const kids = children.get(entry.id) || [];
      if (kids.length === 0) { emitLeaf(entry, depth); return; }
      seen.add(entry.id);
      const expanded = expandedIds.has(entry.id);
      const count = countDescendants(entry.id, new Set([entry.id]));
      if (visible === null || visible.has(entry.id)) {
        const li = document.createElement('li');
        li.appendChild(makeProjectRow(entry, count, expanded, depth, activeScope === entry.slug));
        list.appendChild(li);
      }
      if (expanded) {
        for (const k of kids.slice().sort(byLabel)) emitLeaf(k, depth + 1);
      }
    };
    for (const r of roots.slice().sort(byLabel)) emit(r, 0);
    return true;
  }

  // Render both sections into contentEl applying the current filter.
  function renderSections() {
    if (!contentEl) return;
    while (contentEl.firstChild) contentEl.removeChild(contentEl.firstChild);
    const vP = computeVisible(lastData.projects || [], currentFilter);
    const vS = computeVisible(lastData.schemas || [], currentFilter);
    const anyP = renderTreeSection('Projects', lastData.projects || [], vP);
    const anyS = renderTreeSection('Notes', lastData.schemas || [], vS);
    if (!anyP && !anyS) {
      const empty = document.createElement('div');
      empty.className = 'index-status';
      empty.textContent = currentFilter ? 'No matching docs' : 'No docs yet';
      contentEl.appendChild(empty);
    }
  }

  /** Fetch /index, cache the payload, render the (filtered) sections. */
  async function buildIndexPanel() {
    ensureChrome();
    while (contentEl.firstChild) contentEl.removeChild(contentEl.firstChild);
    const statusEl = document.createElement('div');
    statusEl.className = 'index-status';
    statusEl.textContent = 'Loading index…';
    contentEl.appendChild(statusEl);

    let errored = false;
    let data = { projects: [], schemas: [] };
    try {
      const res = await fetch('/index');
      if (res.ok) data = await res.json();
      else errored = true;
    } catch (_) {
      errored = true;
    }

    if (errored) {
      statusEl.textContent = 'Failed to load index';
      return; // non-fatal; status stays visible
    }
    lastData = { projects: data.projects || [], schemas: data.schemas || [] };
    renderSections();
  }

  // ── Build-once preparation ──────────────────────────────────────────────────
  let preparePromise = null;
  function prepareIndex() {
    if (preparePromise) return preparePromise;
    const p = (async () => {
      ensureChrome();
      await buildIndexPanel();
      const hasError = contentEl.querySelector('.index-status') &&
        /Failed/.test(contentEl.querySelector('.index-status').textContent || '');
      return hasError ? 'error' : 'ready';
    })();
    preparePromise = p;
    p.then((res) => { if (res !== 'ready') preparePromise = null; }).catch(() => { preparePromise = null; });
    return p;
  }

  // ── Show / collapse / close (fade; non-destructive to corpus/brain) ──────────────────
  function showReopenHandle(show) {
    ensureReopenHandle();
    reopenHandle.classList.toggle('shown', show);
  }

  function openSidebar() {
    isSidebarOpen = true;
    showReopenHandle(false);
    document.body.classList.add('index-docked');
    container.style.display = 'flex';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        container.classList.add('shown');
      });
    });
    if (typeof ctx.refitCorpus === 'function') ctx.refitCorpus();
    prepareIndex();
  }

  function hidePanel(showHandleAfter) {
    isSidebarOpen = false;
    if (typeof ctx.highlightCorpusNode === 'function') ctx.highlightCorpusNode(null);
    container.classList.remove('shown');
    document.body.classList.remove('index-docked');
    if (typeof ctx.refitCorpus === 'function') ctx.refitCorpus();
    const onEnd = (ev) => {
      if (ev && ev.target !== container) return;
      if (!isSidebarOpen) container.style.display = 'none';
      container.removeEventListener('transitionend', onEnd);
    };
    container.addEventListener('transitionend', onEnd);
    setTimeout(() => { if (!isSidebarOpen) container.style.display = 'none'; }, 450);
    showReopenHandle(showHandleAfter);
  }

  // User collapsed the sidebar for more graph room — leave corpus open, show reopen handle.
  function collapseSidebar() { hidePanel(true); }
  // Corpus returned to the brain — close fully, no reopen handle over the 3D view.
  function closeIndexSidebar() { hidePanel(false); }

  // ── ctx hooks ────────────────────────────────────────────────────────────────
  ctx.openIndexSidebar = openSidebar;
  ctx.closeIndexSidebar = closeIndexSidebar;
  // GAP-6: reveal the left-edge reopen handle WITHOUT docking — the rail stays closed and the
  // graph keeps the full canvas until the user explicitly clicks the handle (→ openSidebar).
  // Preloads /index so that first open is instant.
  ctx.showIndexHandle = function showIndexHandle() {
    isSidebarOpen = false;
    showReopenHandle(true);
    prepareIndex();
  };
  // corpus.js calls this (guarded) whenever focusedScope changes (focus/switch/Esc/background-
  // click) so the index's active row stays in sync with graph focus in both directions (GAP-3).
  ctx.syncCorpusFocus = function syncCorpusFocus(scope) {
    activeScope = scope || null;
    renderSections();
  };

  setTimeout(() => { prepareIndex(); }, 1200);
}
