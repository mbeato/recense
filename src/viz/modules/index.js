/**
 * @module index
 * recense viz — browsable text index of the live doc corpus (WIKI-01, 39-02).
 *
 * Provides `initIndex(ctx)` — the #btn-index toolbar button toggle that opens a
 * full-window textual index grouped into two sections:
 *   - Projects: human-scoped docs (e.g. 'tonos')
 *   - Schemas: schema-anchored docs (UUID-scoped, labeled by human schema name)
 *
 * Toggle behaviour (#btn-index, expanded-only per D-08):
 *   - First Index open: lazy-fetch /index, render Projects + Schemas, show #index-panel
 *     full-window, hide the 3D brain (#graph). Button reads "Brain".
 *   - Brain toggle: hide #index-panel, restore the 3D brain UNTOUCHED. Button reads "Index".
 *
 * Security (T-39-08): all DB-sourced strings (label, slug) set via .textContent only;
 * slug used in navigation passed through encodeURIComponent. No innerHTML with user data.
 *
 * Clones the initCorpus(ctx) shape from corpus.js — same toolbar-button + lazy-init pattern.
 */

// ── Button icon SVGs (inline — net-zero deps, no icon lib) ──────────────────────────
// LIST icon: shown when brain is active (button = "go to index").
const ICON_LIST = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`;
// BRAIN icon: shown when index is active (button = "go back to brain").
const ICON_BRAIN = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 16c-2 0-3-1.6-3-3.4 0-1.6 1-3 2.4-3.4C4.6 5.6 7.4 3 11 3c4.4 0 7.6 3.2 7.6 7 0 1 .4 1.6 1 2.2.8.8 1.2 1.6 1.2 2.6 0 1.6-1.4 3-3.2 3"/><path d="M17.6 17.8c.4 1.6-.6 3.2-2.4 3.2-1.4 0-2.4-1-2.4-2.4"/><path d="M7 10c1.2.4 1.8 1.4 1.8 2.6"/><path d="M12 8c1.4.6 2 1.8 2 3.4"/></svg>`;

/**
 * Initialise the browsable doc index + #btn-index toggle.
 * Lazy: /index is only fetched on the first Index open.
 *
 * @param {Object} ctx shared viz context
 */
export function initIndex(ctx) {
  const indexBtn = document.getElementById('btn-index');
  const container = document.getElementById('index-panel');
  const brainEl = document.getElementById('graph');
  const corpusEl = document.getElementById('corpus-graph');
  if (!indexBtn || !container) return;

  // Whether the index panel is currently the active full-window view.
  let isIndexOpen = false;

  /** Build the index panel content: fetch /index, render Projects + Schemas. */
  async function buildIndexPanel() {
    // Remove any previous status (retry after error)
    const stale = container.querySelector('.index-status');
    if (stale) stale.remove();

    const statusEl = document.createElement('div');
    statusEl.className = 'index-status';
    statusEl.textContent = 'Loading index…';
    container.appendChild(statusEl);

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
      return; // overlay stays visible; non-fatal
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
        a.addEventListener('click', (ev) => {
          ev.preventDefault();
          // D-08: click → open that doc in the reader
          window.location.href = '/?doc=' + encodeURIComponent(entry.slug) + '&reader=1';
        });
        li.appendChild(a);
        list.appendChild(li);
      }
      section.appendChild(list);
      container.appendChild(section);
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
      // Clear previous content on each build (handles retry after error)
      // Only clear if the panel has more than just a status overlay
      const sections = container.querySelectorAll('.index-section');
      sections.forEach(s => s.remove());
      await buildIndexPanel();
      const hasError = container.querySelector('.index-status');
      return hasError ? 'error' : 'ready';
    })();
    preparePromise = p;
    p.then((res) => { if (res !== 'ready') preparePromise = null; }).catch(() => { preparePromise = null; });
    return p;
  }

  function setIndexButton() {
    indexBtn.setAttribute('aria-label', 'Show brain');
    indexBtn.setAttribute('title', 'Show brain');
    indexBtn.innerHTML = ICON_BRAIN;
    indexBtn.classList.add('index-active');
  }
  function setBrainButton() {
    indexBtn.setAttribute('aria-label', 'Index');
    indexBtn.setAttribute('title', 'Index');
    indexBtn.innerHTML = ICON_LIST;
    indexBtn.classList.remove('index-active');
  }

  function goToIndex() {
    isIndexOpen = true;
    setIndexButton();
    // Hide brain and corpus (if corpus was open, hide it too)
    if (brainEl) brainEl.style.display = 'none';
    if (corpusEl) corpusEl.style.display = 'none';
    container.style.display = 'block';
    prepareIndex();
  }

  function goToBrain() {
    isIndexOpen = false;
    setBrainButton();
    container.style.display = 'none';
    // Restore brain — show it (untouched, no rebuild)
    if (brainEl) brainEl.style.display = '';
    // Don't restore corpus — that's corpus.js's responsibility
  }

  indexBtn.addEventListener('click', () => {
    if (isIndexOpen) goToBrain();
    else goToIndex();
  });

  // ── ctx hook ─────────────────────────────────────────────────────────────
  // Expose opener on ctx so other modules can trigger the index if needed.
  ctx.openIndex = function openIndex() { goToIndex(); };

  // Eagerly prepare the index shortly after init so the first open is instant.
  // Empty/error outcomes are swallowed here and retried on a real open.
  setTimeout(() => { prepareIndex(); }, 1200);
}
