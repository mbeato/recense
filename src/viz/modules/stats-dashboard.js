/**
 * @module stats-dashboard
 * recense viz — Phase 60 stats takeover (`#stats-view`): a full-window surface
 * that REPLACES the 3D brain (and the flat 2D corpus, if open) — same
 * structural tier as corpus.js's `#corpus-graph` toggle (D-01/D-02), mirroring
 * reader.js/settings.js's show()/hide()/fetch-on-open/Escape-to-close plumbing.
 *
 * Owns:
 *   - open/close plumbing + ctx exposure (ctx.openStatsDashboard/closeStatsDashboard/
 *     isStatsDashboardOpen), Escape-to-close
 *   - Usage / Brain Health tab state
 *   - 7d/30d/90d/all-time range switcher (D-12 — all-time re-fetches weekly buckets)
 *   - manual + on-open refresh with an "as of {HH:MM:SS}" stamp (D-15, no SSE/timer)
 *   - the Usage tab's empty/error state contract — the full chart suite (burn +
 *     cost-event markers + per-feature/per-model splits + retail-$ headline) is
 *     added in Task 3 of this plan. Brain Health tab (60-04) reads its own
 *     placeholder here and does NOT fetch /stats/brain-health from this module.
 *
 * SECURITY: every server-sourced value (token counts, dates, costs) is rendered via
 * `.textContent` only — T-44-19 discipline; SVG chart content (Task 3) goes through
 * charts.js's createElementNS builders, never innerHTML.
 */

export function initStatsDashboard(ctx) {
  const view = document.getElementById('stats-view');
  if (!view) return;

  const graphEl = document.getElementById('graph');
  const corpusEl = document.getElementById('corpus-graph');
  const hudChip = document.getElementById('hud-chip');
  const topicsRail = document.getElementById('topics-rail');

  const tabUsageBtn = document.getElementById('stats-tab-usage');
  const tabHealthBtn = document.getElementById('stats-tab-health');
  const usageTabEl = document.getElementById('stats-usage-tab');
  const healthTabEl = document.getElementById('stats-health-tab');
  const rangeButtons = Array.from(document.querySelectorAll('.stats-range-pill'));
  const refreshBtn = document.getElementById('stats-refresh');
  const asOfEl = document.getElementById('stats-as-of');
  const closeBtn = document.getElementById('stats-close');

  let isOpen = false;
  let currentTab = 'usage';
  let currentRange = '30d';
  let healthPlaceholderRendered = false;

  // ── Show / hide (D-02 — replaces the 3D brain / flat corpus, mirrors corpus.js's
  //    setTopicsSearchHidden HUD-hide behavior) ────────────────────────────────

  function setOtherViewsHidden(hidden) {
    if (graphEl) graphEl.style.visibility = hidden ? 'hidden' : '';
    if (corpusEl) corpusEl.style.visibility = hidden ? 'hidden' : '';
    if (hudChip) hudChip.style.display = hidden ? 'none' : '';
    if (topicsRail) topicsRail.style.display = hidden ? 'none' : '';
  }

  function show(tab) {
    if (!isOpen) {
      isOpen = true;
      if (typeof ctx.markActive === 'function') ctx.markActive();
      setOtherViewsHidden(true);
      view.classList.add('open');
      // Force a layout flush so the opacity transition (display:none→block +
      // opacity 0→1) actually animates rather than jumping straight to 1.
      void view.offsetHeight;
      view.classList.add('stats-in');
    }
    setTab(tab || currentTab);
    load();
  }

  function hide() {
    if (!isOpen) return;
    isOpen = false;
    view.classList.remove('stats-in');
    view.classList.remove('open');
    setOtherViewsHidden(false);
  }

  ctx.openStatsDashboard = function openStatsDashboard(tab) { show(tab || 'usage'); };
  ctx.closeStatsDashboard = function closeStatsDashboard() { hide(); };
  ctx.isStatsDashboardOpen = function isStatsDashboardOpen() { return isOpen; };

  if (closeBtn) closeBtn.addEventListener('click', () => hide());

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && isOpen) hide();
  });

  // ── Tabs ──────────────────────────────────────────────────────────────────

  function setTab(tab) {
    currentTab = tab === 'health' ? 'health' : 'usage';
    if (tabUsageBtn) tabUsageBtn.classList.toggle('active', currentTab === 'usage');
    if (tabHealthBtn) tabHealthBtn.classList.toggle('active', currentTab === 'health');
    if (usageTabEl) usageTabEl.classList.toggle('active', currentTab === 'usage');
    if (healthTabEl) healthTabEl.classList.toggle('active', currentTab === 'health');
    if (currentTab === 'health') renderHealthTab();
  }

  if (tabUsageBtn) tabUsageBtn.addEventListener('click', () => setTab('usage'));
  if (tabHealthBtn) tabHealthBtn.addEventListener('click', () => setTab('health'));

  // ── Range switcher (D-12 — 'all' re-fetches weekly-granularity buckets) ─────

  rangeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      currentRange = btn.dataset.range;
      rangeButtons.forEach((b) => b.classList.toggle('active', b === btn));
      load();
    });
  });

  // ── Refresh (D-15 — fires on open + manual click only, no SSE/timer) ────────

  if (refreshBtn) refreshBtn.addEventListener('click', () => load());

  function stampAsOf() {
    if (!asOfEl) return;
    const now = new Date();
    const two = (n) => String(n).padStart(2, '0');
    asOfEl.textContent = 'as of ' + two(now.getHours()) + ':' + two(now.getMinutes()) + ':' + two(now.getSeconds());
  }

  // ── Fetch /stats/usage (non-fatal, mirrors settings.js's fetchSettings/fetchUsage) ──

  async function fetchUsage(range) {
    try {
      const res = await fetch('/stats/usage?window=' + encodeURIComponent(range));
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  let loadToken = 0;

  async function load() {
    const range = currentRange;
    const token = ++loadToken;
    const data = await fetchUsage(range);
    if (token !== loadToken) return; // superseded by a later range switch/refresh
    stampAsOf();
    renderUsageTab(usageTabEl, data);
  }

  // ── Usage tab render (empty/error state contract — Task 3 fills in the chart suite) ──

  function renderUsageTab(container, data) {
    if (!container) return;
    container.textContent = '';

    if (!data) {
      const err = document.createElement('div');
      err.className = 'stats-error-state';
      err.textContent = 'could not load usage stats'; // textContent only — T-44-19
      container.appendChild(err);
      return;
    }

    const buckets = data.buckets || [];
    const totalTokens = buckets.reduce((sum, b) => sum + (b.tokens || 0), 0);
    if (buckets.length === 0 || totalTokens === 0) {
      const empty = document.createElement('div');
      empty.className = 'stats-empty-state';
      empty.textContent = 'no usage recorded yet'; // textContent only — T-44-19
      container.appendChild(empty);
      return;
    }

    // Task 3 (60-03) fills in the headline + burn/per-feature/per-model chart suite here.
  }

  // Placeholder only — 60-04 implements the full Brain Health tab; this module
  // never fetches /stats/brain-health (that fetch belongs to 60-04's own module code).
  function renderHealthTab() {
    if (healthPlaceholderRendered || !healthTabEl) return;
    healthPlaceholderRendered = true;
    healthTabEl.textContent = '';
    const placeholder = document.createElement('div');
    placeholder.className = 'stats-empty-state';
    placeholder.textContent = 'Brain Health — coming soon';
    healthTabEl.appendChild(placeholder);
  }
}
