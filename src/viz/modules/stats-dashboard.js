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
 * `.textContent` only — T-44-19 discipline; SVG chart content goes through charts.js's
 * createElementNS builders, never innerHTML.
 */

import { line, bar, axis, legend, attachHover, SVG_NS, niceTicks, linearScale, fmtDate, fmtTokens } from './charts.js';
import { NEUTRAL_SERIES_RAMP, COST_EVENTS } from './constants.js';

const RETAIL_LABEL = 'API-retail equivalent (subscription-billed: $0 marginal)';
const FEATURE_ORDER = ['extract', 'judge', 'corpus_gen', 'schema_abstract'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Chart geometry: a fixed internal coordinate system, stretched to the container's
// actual width via a viewBox + width:100% SVG (no DOM measurement needed at render
// time — the same technique used for any responsive inline SVG).
const CHART_W = 760;
const BURN_H = 220;
const BAR_H = 170;
const MARGIN = { top: 12, right: 16, bottom: 28, left: 52 };

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

    renderHeadline(container, data, totalTokens);
    renderBurnChart(container, buckets, data.bucket_granularity, data.cost_event_deltas || []);
    renderFeatureSplit(container, data.by_feature || []);
    renderModelSplit(container, data.by_model || []);
  }

  // Headline retail-$ + total-tokens readout tile (D-09).
  function renderHeadline(container, data, totalTokens) {
    const tile = document.createElement('div');
    tile.className = 'chart-card stats-headline-tile';

    const valueEl = document.createElement('div');
    valueEl.className = 'stats-headline-value';
    const retailUsd = data.retail_usd || 0;
    // textContent only — T-44-19 (retailUsd/totalTokens are numbers from the server)
    valueEl.textContent = '$' + retailUsd.toFixed(4) + '  ·  ' + fmtTokens(totalTokens) + ' tokens';
    tile.appendChild(valueEl);

    const labelEl = document.createElement('div');
    labelEl.className = 'stats-headline-label';
    labelEl.textContent = RETAIL_LABEL; // static verbatim copy — D-09
    tile.appendChild(labelEl);

    container.appendChild(tile);
  }

  // ── SVG chart helpers (burn / per-feature / per-model — D-05/D-06/D-07) ─────

  function createChartSvg(width, height) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', String(height));
    svg.setAttribute('preserveAspectRatio', 'none');
    return svg;
  }

  function makeCard(titleText) {
    const card = document.createElement('div');
    card.className = 'chart-card';
    const head = document.createElement('div');
    head.className = 'chart-card-head';
    const title = document.createElement('span');
    title.className = 'chart-card-title';
    title.textContent = titleText; // textContent only — T-44-19
    head.appendChild(title);
    card.appendChild(head);
    return card;
  }

  // Both daily and weekly (Monday-start ISO week) bucket keys are real calendar
  // dates from the server — this guard only protects against an unexpected
  // non-date bucket key ever reaching the chart.
  function safeDateLabel(dateStr) {
    return DATE_RE.test(dateStr) ? fmtDate(dateStr) : dateStr;
  }

  function pickXTicks(buckets, xScale) {
    const n = buckets.length;
    if (n === 0) return [];
    const targetCount = 7;
    const stride = Math.max(1, Math.ceil(n / targetCount));
    const ticks = [];
    for (let i = 0; i < n; i += stride) {
      ticks.push({ x: xScale(i), label: safeDateLabel(buckets[i].date) });
    }
    return ticks;
  }

  // Cost-event markers (D-10/D-11): only meaningful against daily buckets, whose
  // date keys line up directly with COST_EVENTS' dates.
  function buildMarkers(buckets, granularity) {
    if (granularity !== 'daily') return [];
    const markers = [];
    for (const m of COST_EVENTS) {
      const idx = buckets.findIndex((b) => b.date >= m.date);
      if (idx === -1) continue;
      markers.push({ date: m.date, label: m.label, idx });
    }
    return markers;
  }

  function appendMarkers(svg, markers, xScale, deltas) {
    markers.forEach((m) => {
      const x = xScale(m.idx);
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'chart-marker');
      const markerLine = document.createElementNS(SVG_NS, 'line');
      markerLine.setAttribute('x1', String(x));
      markerLine.setAttribute('x2', String(x));
      markerLine.setAttribute('y1', String(MARGIN.top));
      markerLine.setAttribute('y2', String(BURN_H - MARGIN.bottom));
      markerLine.setAttribute('stroke', 'rgba(170,150,180,0.5)');
      markerLine.setAttribute('stroke-width', '1');
      markerLine.setAttribute('stroke-dasharray', '4,3');
      g.appendChild(markerLine);

      const delta = deltas.find((d) => d.date === m.date && d.label === m.label);
      const deltaText = delta
        ? m.label + ': ' + fmtTokens(delta.before_avg) + '/day → ' + fmtTokens(delta.after_avg) + '/day'
        : m.label;

      g.addEventListener('mouseenter', () => showMarkerTooltip(deltaText));
      g.addEventListener('mousemove', (ev) => moveMarkerTooltip(ev));
      g.addEventListener('mouseleave', hideMarkerTooltip);

      svg.appendChild(g);
    });
  }

  // Cost-event marker hover reuses the shared #tooltip element (D-10 — the nearest-
  // point hover mechanism's shared-tooltip convention, not a new tooltip type).
  function showMarkerTooltip(text) {
    const tooltip = document.getElementById('tooltip');
    if (!tooltip) return;
    tooltip.textContent = text; // textContent only — T-44-19
    tooltip.style.display = 'block';
  }
  function moveMarkerTooltip(ev) {
    const tooltip = document.getElementById('tooltip');
    if (!tooltip) return;
    tooltip.style.left = ev.clientX + 12 + 'px';
    tooltip.style.top = ev.clientY + 12 + 'px';
  }
  function hideMarkerTooltip() {
    const tooltip = document.getElementById('tooltip');
    if (tooltip) tooltip.style.display = 'none';
  }

  // Primary focal chart (D-06 — largest card, top of the tab): daily/weekly token
  // burn line, cost-event markers, D-07 nearest-point hover.
  function renderBurnChart(container, buckets, granularity, costEventDeltas) {
    const card = makeCard(granularity === 'weekly' ? 'Weekly token burn' : 'Daily token burn');
    card.classList.add('chart-card-primary');

    const svg = createChartSvg(CHART_W, BURN_H);
    const maxTokens = buckets.reduce((m, b) => Math.max(m, b.tokens || 0), 0);
    const ticks = niceTicks(0, maxTokens);
    const niceMax = ticks[ticks.length - 1] || 1;
    const yScale = linearScale([0, niceMax], [BURN_H - MARGIN.bottom, MARGIN.top]);
    const xScale = linearScale([0, Math.max(buckets.length - 1, 1)], [MARGIN.left, CHART_W - MARGIN.right]);

    const points = buckets.map((b, i) => ({
      x: xScale(i), y: yScale(b.tokens || 0), date: b.date, value: b.tokens || 0, formatValue: fmtTokens,
    }));

    svg.appendChild(axis({
      orientation: 'y', ticks, scale: yScale,
      chartLeft: MARGIN.left, chartRight: CHART_W - MARGIN.right, formatValue: fmtTokens,
    }));
    svg.appendChild(axis({
      orientation: 'x', xTicks: pickXTicks(buckets, xScale), chartBottom: BURN_H - MARGIN.bottom,
    }));
    svg.appendChild(line(points, { color: NEUTRAL_SERIES_RAMP[0] }));
    appendMarkers(svg, buildMarkers(buckets, granularity), xScale, costEventDeltas);
    svg.appendChild(legend([{ label: 'burn', color: NEUTRAL_SERIES_RAMP[0] }], { x: CHART_W - 90, y: MARGIN.top - 4 }));

    card.appendChild(svg);
    attachHover(svg, points, { chartTop: MARGIN.top, chartBottom: BURN_H - MARGIN.bottom, color: NEUTRAL_SERIES_RAMP[0] });
    container.appendChild(card);
  }

  // Shared bar-chart builder for the per-feature / per-model splits (D-08).
  function renderSplitBarChart(container, titleText, entries) {
    const card = makeCard(titleText);
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'stats-empty-state';
      empty.textContent = 'no usage recorded yet';
      card.appendChild(empty);
      container.appendChild(card);
      return;
    }

    const svg = createChartSvg(CHART_W, BAR_H);
    const maxTokens = entries.reduce((m, e) => Math.max(m, e.tokens), 0);
    const ticks = niceTicks(0, maxTokens);
    const niceMax = ticks[ticks.length - 1] || 1;
    const yScale = linearScale([0, niceMax], [BAR_H - MARGIN.bottom, MARGIN.top]);

    const innerW = CHART_W - MARGIN.left - MARGIN.right;
    const slot = innerW / entries.length;
    const barWidth = Math.min(48, slot * 0.5);

    const bars = entries.map((e, i) => {
      const cx = MARGIN.left + slot * (i + 0.5);
      const y = yScale(e.tokens);
      return { x: cx - barWidth / 2, y, width: barWidth, height: (BAR_H - MARGIN.bottom) - y };
    });
    const xTicks = entries.map((e, i) => ({ x: MARGIN.left + slot * (i + 0.5), label: e.label }));

    svg.appendChild(axis({
      orientation: 'y', ticks, scale: yScale,
      chartLeft: MARGIN.left, chartRight: CHART_W - MARGIN.right, formatValue: fmtTokens,
    }));
    svg.appendChild(axis({ orientation: 'x', xTicks, chartBottom: BAR_H - MARGIN.bottom }));

    entries.forEach((e, i) => {
      svg.appendChild(bar([bars[i]], { color: e.color }));
    });

    card.appendChild(svg);
    container.appendChild(card);
    return svg; // caller appends its own top-right legend (D-06 — one legend per chart card)
  }

  function renderFeatureSplit(container, byFeature) {
    const entries = [];
    FEATURE_ORDER.forEach((tag, i) => {
      const row = byFeature.find((r) => r.feature_tag === tag);
      if (!row) return; // no zero-padded placeholder series — Empty/Sparse State Contract
      const tokens = (row.input_tokens || 0) + (row.output_tokens || 0);
      entries.push({ label: tag, tokens, color: NEUTRAL_SERIES_RAMP[i % NEUTRAL_SERIES_RAMP.length] });
    });
    const svg = renderSplitBarChart(container, 'Per-feature split', entries);
    if (svg) {
      svg.appendChild(legend(
        entries.map((e) => ({ label: e.label, color: e.color })),
        { x: MARGIN.left, y: MARGIN.top - 4 },
      ));
    }
  }

  function renderModelSplit(container, byModel) {
    const entries = byModel.map((row, i) => ({
      label: row.model,
      tokens: (row.input_tokens || 0) + (row.output_tokens || 0),
      color: NEUTRAL_SERIES_RAMP[i % NEUTRAL_SERIES_RAMP.length],
    }));
    const svg = renderSplitBarChart(container, 'Per-model split', entries);
    if (svg) {
      svg.appendChild(legend(
        entries.map((e) => ({ label: e.label, color: e.color })),
        { x: MARGIN.left, y: MARGIN.top - 4 },
      ));
    }
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
