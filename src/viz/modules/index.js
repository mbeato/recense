/**
 * @module index
 * recense viz — browsable text index of the live doc corpus (WIKI-01, 39-02).
 *
 * The index is a LEFT SIDEBAR docked over the flat 2D corpus graph — the index list and the
 * corpus graph are two views of the same doc set, shown side by side (founder direction). There
 * is NO dedicated toolbar button: the sidebar opens by default when the corpus view opens
 * (corpus.js calls ctx.openIndexSidebar), and closes when the corpus returns to the brain
 * (ctx.closeIndexSidebar). A ◀ collapse control hides it for more graph room; a slim reopen
 * handle on the left edge brings it back.
 *
 * The list is grouped into two sections:
 *   - Projects: human-scoped docs (e.g. 'tonos')
 *   - Schemas: schema-anchored docs (UUID-scoped, labeled by human schema name)
 *
 * Interactions:
 *   - Row hover → cross-highlight the matching node + its neighbours in the corpus graph
 *     (ctx.highlightCorpusNode).
 *   - Row click → open that doc's reader IN PLACE over the corpus (ctx.openReader from:'corpus').
 *
 * Security (T-39-08): all DB-sourced strings (label, slug) set via .textContent only;
 * slug used in navigation passed through encodeURIComponent. No innerHTML with user data.
 */

// ── Icon SVGs (inline — net-zero deps, no icon lib) ─────────────────────────────────
const ICON_CHEVRON_LEFT = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;
const ICON_CHEVRON_RIGHT = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

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
  let contentEl = null;
  let reopenHandle = null;

  // ── Static sidebar chrome: header (title + collapse) + scrollable content ────────────
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

    contentEl = document.createElement('div');
    contentEl.className = 'index-content';

    container.appendChild(header);
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

  /** Build the index list content: fetch /index, render Projects + Schemas into contentEl. */
  async function buildIndexPanel() {
    ensureChrome();
    const stale = contentEl.querySelector('.index-status');
    if (stale) stale.remove();

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
    statusEl.remove();

    // Build one <a> row for an index entry (shared by flat + tree rendering).
    function makeEntryAnchor(entry) {
      const a = document.createElement('a');
      a.className = 'index-entry doc-ref';
      a.setAttribute('href', '#');
      a.textContent = entry.label || entry.slug; // textContent — T-39-08
      // Hover → cross-highlight the matching node + its containment subtree in the corpus graph.
      a.addEventListener('mouseenter', () => {
        if (typeof ctx.highlightCorpusNode === 'function') ctx.highlightCorpusNode(entry.slug);
      });
      a.addEventListener('mouseleave', () => {
        if (typeof ctx.highlightCorpusNode === 'function') ctx.highlightCorpusNode(null);
      });
      // Click → open that doc's reader IN PLACE over the corpus (D-08, reuse corpus path).
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        if (typeof ctx.openReader === 'function') ctx.openReader(entry.slug, { from: 'corpus' });
        else window.location.href = '/?doc=' + encodeURIComponent(entry.slug) + '&reader=1';
      });
      return a;
    }

    // Create a labeled section with an empty <ul>, return the <ul> to append rows into.
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

    // Nested tree section (Projects + Schemas) — children indented under their doc_containment
    // parent. The server partitions each doc into the section of its tree ROOT's type (hybrid:
    // a project's chapter docs land in Projects nested under it). Roots are entries whose parentId
    // is null or points outside this section's set. Siblings sorted by label.
    function renderTreeSection(title, entries) {
      if (!entries || entries.length === 0) return;
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
      const emit = (entry, depth) => {
        if (seen.has(entry.id)) return; // defensive: never loop on malformed data
        seen.add(entry.id);
        const li = document.createElement('li');
        const a = makeEntryAnchor(entry);
        a.style.paddingLeft = (8 + depth * 14) + 'px'; // indent by containment depth
        li.appendChild(a);
        list.appendChild(li);
        for (const k of (children.get(entry.id) || []).slice().sort(byLabel)) emit(k, depth + 1);
      };
      for (const r of roots.slice().sort(byLabel)) emit(r, 0);
    }

    renderTreeSection('Projects', data.projects);
    renderTreeSection('Schemas', data.schemas);
  }

  // ── Build-once preparation ──────────────────────────────────────────────────
  let preparePromise = null;
  function prepareIndex() {
    if (preparePromise) return preparePromise;
    const p = (async () => {
      ensureChrome();
      contentEl.querySelectorAll('.index-section').forEach(s => s.remove());
      await buildIndexPanel();
      const hasError = contentEl.querySelector('.index-status');
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
    container.style.display = 'flex';
    // Two rAFs so display:flex paints before the opacity transition (fade-in).
    requestAnimationFrame(() => requestAnimationFrame(() => container.classList.add('shown')));
    prepareIndex();
  }

  // Internal: fade the panel out, then optionally reveal the reopen handle.
  function hidePanel(showHandleAfter) {
    isSidebarOpen = false;
    if (typeof ctx.highlightCorpusNode === 'function') ctx.highlightCorpusNode(null);
    container.classList.remove('shown');
    const onEnd = (ev) => {
      if (ev && ev.target !== container) return;
      if (!isSidebarOpen) container.style.display = 'none';
      container.removeEventListener('transitionend', onEnd);
    };
    container.addEventListener('transitionend', onEnd);
    setTimeout(() => { if (!isSidebarOpen) container.style.display = 'none'; }, 450);
    showReopenHandle(showHandleAfter);
  }

  // User collapsed the sidebar for more graph room — leave the corpus open, show reopen handle.
  function collapseSidebar() { hidePanel(true); }

  // Corpus returned to the brain — close fully, no reopen handle over the 3D view.
  function closeIndexSidebar() { hidePanel(false); }

  // ── ctx hooks ────────────────────────────────────────────────────────────────
  // corpus.js drives the lifecycle: openIndexSidebar on corpus enter, closeIndexSidebar on leave.
  ctx.openIndexSidebar = openSidebar;
  ctx.closeIndexSidebar = closeIndexSidebar;
  ctx.openIndex = openSidebar; // programmatic opener (kept for parity)

  // Eagerly prepare the list shortly after init so the first open is instant.
  setTimeout(() => { prepareIndex(); }, 1200);
}
