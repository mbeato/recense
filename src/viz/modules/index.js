/**
 * @module index
 * recense viz — browsable text index of the live doc corpus (WIKI-01, 39-02).
 *
 * Provides `initIndex(ctx)` — the #btn-index toolbar toggle that opens a LEFT SIDEBAR
 * docked over the flat 2D corpus graph (the index list + corpus graph are two views of
 * the same doc set, shown side by side — founder direction, 39-02 re-verify). The list
 * is grouped into two sections:
 *   - Projects: human-scoped docs (e.g. 'tonos')
 *   - Schemas: schema-anchored docs (UUID-scoped, labeled by human schema name)
 *
 * Toggle behaviour (#btn-index, expanded-only per D-08):
 *   - Open: ensure the corpus graph is open (ctx.openCorpus — that hides the topics/search
 *     overlay too), then fade the sidebar in over the corpus. Lazy-fetch /index on first open.
 *   - Close: fade the sidebar out. The corpus graph is left UNTOUCHED (not forced back to
 *     the brain). Returning to the brain via #btn-corpus closes the sidebar (ctx.closeIndexSidebar).
 *   - Row hover → cross-highlight the matching node in the corpus graph (ctx.highlightCorpusNode).
 *   - Row click → open that doc's reader IN PLACE over the corpus (ctx.openReader from:'corpus').
 *
 * Security (T-39-08): all DB-sourced strings (label, slug) set via .textContent only;
 * slug used in navigation passed through encodeURIComponent. No innerHTML with user data.
 */

// ── Button icon SVG (inline — net-zero deps, no icon lib) ───────────────────────────
// LIST icon: the #btn-index button always shows the list glyph; the .index-active class
// (brightened) signals the sidebar is open. (No brain-icon swap — #btn-corpus owns the brain.)
const ICON_LIST = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;
// CHEVRON-LEFT icon for the in-sidebar collapse control.
const ICON_CHEVRON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`;

/**
 * Initialise the browsable doc index sidebar + #btn-index toggle.
 * Lazy: /index is only fetched on the first Index open.
 *
 * @param {Object} ctx shared viz context
 */
export function initIndex(ctx) {
  const indexBtn = document.getElementById('btn-index');
  const container = document.getElementById('index-panel');
  if (!indexBtn || !container) return;

  // Whether the index sidebar is currently shown.
  let isSidebarOpen = false;
  // The scrollable content host inside the sidebar (built once below).
  let contentEl = null;

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
    collapse.setAttribute('aria-label', 'Close index');
    collapse.setAttribute('title', 'Close index');
    collapse.innerHTML = ICON_CHEVRON;
    collapse.addEventListener('click', closeSidebar);
    header.appendChild(collapse);

    contentEl = document.createElement('div');
    contentEl.className = 'index-content';

    container.appendChild(header);
    container.appendChild(contentEl);
  }

  /** Build the index list content: fetch /index, render Projects + Schemas into contentEl. */
  async function buildIndexPanel() {
    ensureChrome();
    // Remove any previous status (retry after error)
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

    // Helper: render one labeled section (Projects or Schemas)
    function renderSection(title, entries) {
      if (!entries || entries.length === 0) return;
      const section = document.createElement('div');
      section.className = 'index-section';

      const heading = document.createElement('div');
      heading.className = 'index-heading';
      heading.textContent = title; // textContent — T-39-08
      section.appendChild(heading);

      const list = document.createElement('ul');
      list.className = 'index-list';

      for (const entry of entries) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.className = 'index-entry doc-ref';
        a.setAttribute('href', '#');
        a.textContent = entry.label || entry.slug; // textContent — T-39-08
        // Hover → cross-highlight the matching node in the corpus graph (non-fatal if absent).
        a.addEventListener('mouseenter', () => {
          if (typeof ctx.highlightCorpusNode === 'function') ctx.highlightCorpusNode(entry.slug);
        });
        a.addEventListener('mouseleave', () => {
          if (typeof ctx.highlightCorpusNode === 'function') ctx.highlightCorpusNode(null);
        });
        // Click → open that doc's reader IN PLACE over the corpus (D-08, reuse corpus path).
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          if (typeof ctx.openReader === 'function') {
            ctx.openReader(entry.slug, { from: 'corpus' });
          } else {
            window.location.href = '/?doc=' + encodeURIComponent(entry.slug) + '&reader=1';
          }
        });
        li.appendChild(a);
        list.appendChild(li);
      }
      section.appendChild(list);
      contentEl.appendChild(section);
    }

    renderSection('Projects', data.projects);
    renderSection('Schemas', data.schemas);
  }

  // ── Build-once preparation ──────────────────────────────────────────────────
  // Fetch and render once; cached on success; retried on error/empty.
  let preparePromise = null;
  function prepareIndex() {
    if (preparePromise) return preparePromise;
    const p = (async () => {
      ensureChrome();
      // Clear previous sections on each build (handles retry after error)
      contentEl.querySelectorAll('.index-section').forEach(s => s.remove());
      await buildIndexPanel();
      const hasError = contentEl.querySelector('.index-status');
      return hasError ? 'error' : 'ready';
    })();
    preparePromise = p;
    p.then((res) => { if (res !== 'ready') preparePromise = null; }).catch(() => { preparePromise = null; });
    return p;
  }

  // ── Open / close the sidebar (fade, non-destructive to corpus/brain) ─────────────────
  function openSidebar() {
    isSidebarOpen = true;
    indexBtn.classList.add('index-active');
    indexBtn.setAttribute('aria-label', 'Hide index');
    indexBtn.setAttribute('title', 'Hide index');
    // Ensure the corpus graph is the active view underneath (it also hides topics/search).
    if (typeof ctx.openCorpus === 'function' &&
        !(typeof ctx.isCorpusOpen === 'function' && ctx.isCorpusOpen())) {
      ctx.openCorpus();
    }
    container.style.display = 'flex';
    // Two rAFs so the display:flex paints before the opacity transition kicks in (fade-in).
    requestAnimationFrame(() => requestAnimationFrame(() => container.classList.add('shown')));
    prepareIndex();
  }

  function closeSidebar() {
    if (!isSidebarOpen) return;
    isSidebarOpen = false;
    indexBtn.classList.remove('index-active');
    indexBtn.setAttribute('aria-label', 'Index');
    indexBtn.setAttribute('title', 'Index');
    if (typeof ctx.highlightCorpusNode === 'function') ctx.highlightCorpusNode(null);
    container.classList.remove('shown');
    const onEnd = (ev) => {
      if (ev && ev.target !== container) return;
      if (!isSidebarOpen) container.style.display = 'none';
      container.removeEventListener('transitionend', onEnd);
    };
    container.addEventListener('transitionend', onEnd);
    // Fallback in case transitionend doesn't fire (e.g. reduced-motion / 0ms).
    setTimeout(() => { if (!isSidebarOpen) container.style.display = 'none'; }, 450);
    // Leave the corpus graph as-is — do NOT force back to the brain.
  }

  indexBtn.innerHTML = ICON_LIST;
  indexBtn.addEventListener('click', () => {
    if (isSidebarOpen) closeSidebar();
    else openSidebar();
  });

  // ── ctx hooks ────────────────────────────────────────────────────────────────
  // openIndex(): programmatic opener. closeIndexSidebar(): corpus.js calls this when the
  // user returns to the brain so the sidebar doesn't linger over the 3D brain.
  ctx.openIndex = openSidebar;
  ctx.closeIndexSidebar = closeSidebar;

  // Eagerly prepare the list shortly after init so the first open is instant.
  // Empty/error outcomes are swallowed here and retried on a real open.
  setTimeout(() => { prepareIndex(); }, 1200);
}
