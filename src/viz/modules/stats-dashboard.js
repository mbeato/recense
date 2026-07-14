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

import { line, bar, axis, legend, directLabel, attachHover, SVG_NS, niceTicks, linearScale, fmtDate, fmtTokens } from './charts.js';
import { NEUTRAL_SERIES_RAMP, COST_EVENTS, KIND_COLOR, TYPE_COLOR } from './constants.js';

const RETAIL_LABEL = 'API-retail equivalent (subscription-billed: $0 marginal)';
const FEATURE_ORDER = ['extract', 'judge', 'corpus_gen', 'schema_abstract'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Brain-Health copy (D-13, UI-SPEC Copywriting Contract, verbatim).
const NODE_GROWTH_CAPTION = 'Derived from event history — approximate where older events were pruned.';
// Recon/tombstone charts: event rows cannot distinguish every variant (e.g. the
// oscillation variant of contradict_force_destabilize appends a coexisting node
// and does not tombstone), so both per-day counts are honest approximations.
const EVENT_COUNT_CAPTION = 'Derived from event history — approximate: event rows do not distinguish every variant.';

// Identity-hue to CSS hex string (KIND_COLOR/TYPE_COLOR are 0xRRGGBB numbers; charts.js's
// SVG builders take CSS color strings) — D-08: only these two locked palettes feed
// Brain-Health series colors, never a hand-picked hex literal (never the forbidden
// live-activation warm hue either — see UI-SPEC Chart Series Color Contract).
function hex(n) {
  return '#' + n.toString(16).padStart(6, '0');
}

// Kind-mix bar order + identity hues (60-UI-SPEC "Brain Health tab" color table) — always
// all five series so the legend never drops a kind, even at count 0 (Empty/Sparse Contract
// governs the whole-chart empty state, not per-series padding within this fixed taxonomy).
const KIND_MIX_SERIES = [
  { key: 'fact', label: 'fact', color: hex(TYPE_COLOR.fact) },
  { key: 'entity', label: 'entity', color: hex(TYPE_COLOR.entity) },
  { key: 'schema', label: 'schema', color: hex(TYPE_COLOR.schema) },
  { key: 'doc', label: 'doc', color: hex(KIND_COLOR.replay) },
  { key: 'insight', label: 'insight', color: hex(KIND_COLOR.spontaneous) },
];

// Chart geometry: heights stay fixed, but width is measured at render time
// (GAP-1 — true responsive re-render, not a viewBox stretched to fit via
// preserveAspectRatio). See measureChartWidth() below.
const BURN_H = 220;
const BAR_H = 170;
const MARGIN = { top: 12, right: 16, bottom: 28, left: 52 };

const CHART_W_MIN = 320; // floor so a narrow window never yields a degenerate width

// Measures the real pixel width available to a chart's SVG (GAP-1: charts
// render at their true rendered width, so viewBox width == rendered pixel
// width and preserveAspectRatio="none" no longer stretches text/strokes).
// Phase 60-11 (GAP-4a de-box): the SVG now sits directly under a borderless
// .stats-section on the flat #stats-view surface — no card padding/border to
// subtract, so the tab container's clientWidth IS the usable width.
function measureChartWidth(container) {
  if (!container) return CHART_W_MIN;
  return Math.max(CHART_W_MIN, container.clientWidth);
}

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

  // ── Show / hide (D-02 — replaces the 3D brain / flat corpus, mirrors corpus.js's
  //    setTopicsSearchHidden HUD-hide behavior) ────────────────────────────────

  function setOtherViewsHidden(hidden) {
    if (graphEl) graphEl.style.visibility = hidden ? 'hidden' : '';
    if (corpusEl) corpusEl.style.visibility = hidden ? 'hidden' : '';
    // Corpus view keeps #hud-chip/#topics-rail hidden while it is open (B3 layout
    // rule, corpus.js setTopicsSearchHidden) — restoring them here on stats close
    // would clobber that shared DOM state, so only re-show when corpus is closed.
    const corpusOpen = !!(ctx.isCorpusOpen && ctx.isCorpusOpen());
    if (hudChip) hudChip.style.display = (hidden || corpusOpen) ? 'none' : '';
    if (topicsRail) topicsRail.style.display = (hidden || corpusOpen) ? 'none' : '';
  }

  function show(tab) {
    if (!isOpen) {
      isOpen = true;
      if (typeof ctx.markActive === 'function') ctx.markActive();
      setOtherViewsHidden(true);
      view.classList.add('open');
      // Force a layout flush so the opacity transition (display:none to block +
      // opacity 0 to 1) actually animates rather than jumping straight to 1.
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
  }

  // Tab click fetches fresh data for the tab it switches to — this is the "first
  // activation" trigger for Brain Health (D-14); show()'s own load() call below
  // handles the initial-open case, so these two triggers never double-fetch.
  if (tabUsageBtn) tabUsageBtn.addEventListener('click', () => { setTab('usage'); load(); });
  if (tabHealthBtn) tabHealthBtn.addEventListener('click', () => { setTab('health'); load(); });

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

  // ── Fetch /stats/usage + /stats/brain-health (non-fatal, mirrors settings.js's
  //    fetchSettings/fetchUsage try/catch-return-null pattern) ──────────────────

  async function fetchUsage(range) {
    try {
      const res = await fetch('/stats/usage?window=' + encodeURIComponent(range));
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  async function fetchBrainHealth() {
    try {
      const res = await fetch('/stats/brain-health');
      if (!res.ok) return null;
      return await res.json();
    } catch (_) {
      return null;
    }
  }

  let loadToken = 0;

  // Per-tab cache of the last successfully-fetched payload (GAP-1 Task 2) — read
  // by the resize handler below so a resize re-render never re-fetches and never
  // moves the "as of" stamp (resize is a pure re-layout, not a data refresh).
  let lastUsageData = null;
  let lastHealthData = null;

  async function load() {
    const token = ++loadToken;
    if (currentTab === 'health') {
      const data = await fetchBrainHealth();
      if (token !== loadToken) return; // superseded by a later tab switch/refresh
      lastHealthData = data;
      stampAsOf();
      renderHealthTab(healthTabEl, data);
    } else {
      const data = await fetchUsage(currentRange);
      if (token !== loadToken) return; // superseded by a later range switch/refresh
      lastUsageData = data;
      stampAsOf();
      renderUsageTab(usageTabEl, data);
    }
  }

  // ── Debounced resize re-render (GAP-1 Task 2) — re-renders the CURRENT tab from
  //    its cached data at the freshly-measured width; no re-fetch, no "as of" stamp
  //    change. No-op while closed or before the active tab has cached data. ──────

  let resizeTimer = null;

  function handleResize() {
    if (!isOpen) return;
    if (currentTab === 'health') {
      if (lastHealthData == null) return;
      renderHealthTab(healthTabEl, lastHealthData);
    } else {
      if (lastUsageData == null) return;
      renderUsageTab(usageTabEl, lastUsageData);
    }
  }

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(handleResize, 200);
  });

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

    const chartW = measureChartWidth(container);
    renderUsageHero(container, data.summary);
    renderLeversSection(container, data.lever_deltas || []);
    renderBurnChart(container, buckets, data.bucket_granularity, data.cost_event_deltas || [], chartW);
    renderUsageBreakdown(container, data.by_feature || [], data.by_model || []);
  }

  // Quiet borderless "Cost levers" table (GAP-2c/GAP-4e) — one row per
  // COST_EVENT (label, date, before/after avg tokens-per-day, %-saved),
  // pulling the savings story out of hover-only discovery. The burn-chart's
  // dashed markers + appendMarkers hover tooltip (D-10/D-11) are untouched —
  // this table supplements them.
  function renderLeversSection(container, leverDeltas) {
    const section = makeSection('Cost levers');
    const list = leverDeltas || [];

    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'stats-empty-state';
      empty.textContent = 'no cost levers recorded yet'; // textContent only — T-44-19
      section.appendChild(empty);
      container.appendChild(section);
      return;
    }

    const table = document.createElement('div');
    table.className = 'stats-levers-table';

    const header = document.createElement('div');
    header.className = 'stats-levers-row stats-levers-head';
    ['label', 'date', 'before avg/day', 'after avg/day', '% saved'].forEach((h) => {
      const cell = document.createElement('div');
      cell.className = 'stats-levers-cell';
      cell.textContent = h; // textContent only — T-44-19
      header.appendChild(cell);
    });
    table.appendChild(header);

    list.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'stats-levers-row';

      const labelCell = document.createElement('div');
      labelCell.className = 'stats-levers-cell';
      labelCell.textContent = entry.label; // textContent only — T-44-19
      row.appendChild(labelCell);

      const dateCell = document.createElement('div');
      dateCell.className = 'stats-levers-cell';
      dateCell.textContent = safeDateLabel(entry.date); // textContent only — T-44-19
      row.appendChild(dateCell);

      const beforeCell = document.createElement('div');
      beforeCell.className = 'stats-levers-cell';
      beforeCell.textContent = fmtTokens(Math.round(entry.before_avg)) + '/day'; // textContent only — T-44-19
      row.appendChild(beforeCell);

      const afterCell = document.createElement('div');
      afterCell.className = 'stats-levers-cell';
      afterCell.textContent = fmtTokens(Math.round(entry.after_avg)) + '/day'; // textContent only — T-44-19
      row.appendChild(afterCell);

      const pctCell = document.createElement('div');
      pctCell.className = 'stats-levers-cell stats-levers-pct';
      const pct = entry.pct_saved;
      // textContent only — T-44-19; server-computed pct_saved, no client math
      if (pct == null) {
        pctCell.textContent = '—';
      } else if (pct >= 0) {
        pctCell.textContent = Math.round(pct) + '% saved';
        pctCell.classList.add('positive');
      } else {
        pctCell.textContent = Math.round(Math.abs(pct)) + '% more';
      }
      row.appendChild(pctCell);

      table.appendChild(row);
    });

    section.appendChild(table);
    container.appendChild(section);
  }

  // Hero + supporting row (GAP-2a/GAP-4a-c) — exactly ONE hero figure
  // (today's tokens, ~44px JetBrains Mono) with its signed trend delta
  // integrated directly into the figure (no separate "vs your typical" prose
  // block, no directional trend glyphs); a quiet hairline-separated
  // supporting row carries this-week / 30d / avg-day / retail-$. Guards for
  // a missing `summary` (older cached payload / fetch failure) by rendering
  // nothing.
  function renderUsageHero(container, summary) {
    if (!summary) return;

    const hero = document.createElement('div');
    hero.className = 'stats-hero';

    const valueRow = document.createElement('div');
    valueRow.className = 'stats-hero-value';
    const value = document.createElement('span');
    value.textContent = fmtTokens(summary.today_tokens || 0); // textContent only — T-44-19
    valueRow.appendChild(value);

    const trendPct = summary.trend_pct;
    if (trendPct != null) {
      const delta = document.createElement('span');
      delta.className = 'stats-delta';
      const sign = trendPct >= 0 ? '+' : '−'; // real minus glyph, plain signed text — no directional glyphs
      delta.textContent = sign + Math.round(Math.abs(trendPct)) + '%'; // textContent only — T-44-19
      // down-usage is the POSITIVE signal (green); up/flat stays neutral mauve
      delta.style.color = summary.trend_direction === 'down' ? 'var(--text-stat)' : 'var(--text-mauve-rest)';
      valueRow.appendChild(delta);
    }
    hero.appendChild(valueRow);

    const label = document.createElement('div');
    label.className = 'stats-hero-label';
    label.textContent = 'today'; // textContent only — T-44-19
    hero.appendChild(label);

    // Honest, skip-when-null context line — never a fabricated baseline.
    const contextParts = [trendPct != null ? 'vs prior 7d' : 'no prior baseline'];
    if (summary.today_vs_typical_pct != null) {
      contextParts.push(Math.round(summary.today_vs_typical_pct) + '% of typical day');
    }
    const footnote = document.createElement('div');
    footnote.className = 'stats-footnote';
    footnote.textContent = contextParts.join(' · '); // textContent only — T-44-19
    hero.appendChild(footnote);

    container.appendChild(hero);
    renderSupportingRow(container, summary);
  }

  function renderSupportingRow(container, summary) {
    const row = document.createElement('div');
    row.className = 'stats-supporting-row';

    const items = [
      {
        value: fmtTokens(summary.week_tokens || 0),
        label: 'this week',
        context: summary.week_vs_typical_pct != null
          ? Math.round(summary.week_vs_typical_pct) + '% of typical week'
          : null,
      },
      { value: fmtTokens(summary.month_tokens || 0), label: 'last 30 days', context: null },
      { value: fmtTokens(Math.round(summary.avg_tokens_per_day || 0)), label: 'avg tokens/day', context: null },
      // GAP-4b: 2-decimal retail-$ supersedes the earlier UI-SPEC 4-decimal spec (founder call).
      { value: '$' + (summary.retail_usd_30d || 0).toFixed(2), label: 'retail-$ (30d)', context: null },
    ];

    items.forEach((item) => {
      const el = document.createElement('div');
      el.className = 'stats-supporting-item';

      const valueEl = document.createElement('div');
      valueEl.className = 'stats-supporting-value';
      valueEl.textContent = item.value; // textContent only — T-44-19
      el.appendChild(valueEl);

      const labelEl = document.createElement('div');
      labelEl.className = 'stats-supporting-label';
      labelEl.textContent = item.label; // textContent only — T-44-19
      el.appendChild(labelEl);

      if (item.context) {
        const contextEl = document.createElement('div');
        contextEl.className = 'stats-supporting-context';
        contextEl.textContent = item.context; // textContent only — T-44-19
        el.appendChild(contextEl);
      }

      row.appendChild(el);
    });

    container.appendChild(row);

    // D-09 verbatim label, relocated from a tile label to a muted footnote (GAP-4b).
    const retailFootnote = document.createElement('div');
    retailFootnote.className = 'stats-footnote';
    retailFootnote.textContent = RETAIL_LABEL; // textContent only — T-44-19, D-09 verbatim
    container.appendChild(retailFootnote);

    if (summary.heaviest_day) {
      const heaviest = document.createElement('div');
      heaviest.className = 'stats-footnote';
      // textContent only — T-44-19
      heaviest.textContent = 'heaviest day: ' + safeDateLabel(summary.heaviest_day.date) + ' (' + fmtTokens(summary.heaviest_day.tokens) + ')';
      container.appendChild(heaviest);
    }
  }

  // ── SVG chart helpers (burn / per-feature / per-model — D-05/D-06/D-07) ─────

  function createChartSvg(width, height) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    // viewBox width == the width attribute (measured chart width, GAP-1) so
    // 1 internal unit == 1 rendered pixel and preserveAspectRatio="none"
    // never stretches text/strokes, at any window width.
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    svg.setAttribute('preserveAspectRatio', 'none');
    return svg;
  }

  // De-boxed section idiom (GAP-4a) — the old bordered-card helper's
  // replacement: a plain div.stats-section whose only chrome is a 10px uppercase
  // letter-spaced muted header with a hairline bottom divider. No border,
  // no background, no card padding — content sits directly on the flat
  // #stats-view surface.
  function makeSection(titleText) {
    const section = document.createElement('div');
    section.className = 'stats-section';
    const head = document.createElement('div');
    head.className = 'stats-section-head';
    head.textContent = titleText; // textContent only — T-44-19
    section.appendChild(head);
    return section;
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
      // Skip events older than the window — findIndex would otherwise resolve
      // them all to bucket 0, visually claiming they happened on the window's
      // first day (with a fabricated before_avg of 0 in the tooltip).
      if (buckets.length && m.date < buckets[0].date) continue;
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

      // Invisible 8px-wide hit target — the 1px dashed line alone is nearly
      // impossible to hover; pointer-events="all" makes the transparent rect
      // hoverable so the D-10/D-11 delta tooltip is actually reachable.
      const hitRect = document.createElementNS(SVG_NS, 'rect');
      hitRect.setAttribute('x', String(x - 4));
      hitRect.setAttribute('y', String(MARGIN.top));
      hitRect.setAttribute('width', '8');
      hitRect.setAttribute('height', String((BURN_H - MARGIN.bottom) - MARGIN.top));
      hitRect.setAttribute('fill', 'none');
      hitRect.setAttribute('pointer-events', 'all');
      g.appendChild(hitRect);

      const delta = deltas.find((d) => d.date === m.date && d.label === m.label);
      const deltaText = delta
        ? m.label + ': ' + fmtTokens(delta.before_avg) + '/day to ' + fmtTokens(delta.after_avg) + '/day'
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

  // Focal chart (top of the tab, under the hero/supporting figures):
  // daily/weekly token burn line, cost-event markers, D-07 nearest-point
  // hover. GAP-4d: no legend — the section header names the single series;
  // a 10%-wash area fill + a selective endpoint direct-label replace it.
  function renderBurnChart(container, buckets, granularity, costEventDeltas, chartW) {
    const section = makeSection(granularity === 'weekly' ? 'Weekly token burn' : 'Daily token burn');

    const svg = createChartSvg(chartW, BURN_H);
    const maxTokens = buckets.reduce((m, b) => Math.max(m, b.tokens || 0), 0);
    const ticks = niceTicks(0, maxTokens);
    const niceMax = ticks[ticks.length - 1] || 1;
    const yScale = linearScale([0, niceMax], [BURN_H - MARGIN.bottom, MARGIN.top]);
    const xScale = linearScale([0, Math.max(buckets.length - 1, 1)], [MARGIN.left, chartW - MARGIN.right]);

    const points = buckets.map((b, i) => ({
      x: xScale(i), y: yScale(b.tokens || 0), date: b.date, value: b.tokens || 0, formatValue: fmtTokens,
    }));

    svg.appendChild(axis({
      orientation: 'y', ticks, scale: yScale,
      chartLeft: MARGIN.left, chartRight: chartW - MARGIN.right, formatValue: fmtTokens,
    }));
    svg.appendChild(axis({
      orientation: 'x', xTicks: pickXTicks(buckets, xScale), chartBottom: BURN_H - MARGIN.bottom,
    }));
    svg.appendChild(line(points, {
      color: NEUTRAL_SERIES_RAMP[0], areaFill: NEUTRAL_SERIES_RAMP[0], baselineY: BURN_H - MARGIN.bottom,
    }));
    appendMarkers(svg, buildMarkers(buckets, granularity), xScale, costEventDeltas);
    if (points.length) {
      const last = points[points.length - 1];
      svg.appendChild(directLabel(last, fmtTokens(last.value), { color: NEUTRAL_SERIES_RAMP[0] }));
    }

    section.appendChild(svg);
    attachHover(svg, points, { chartTop: MARGIN.top, chartBottom: BURN_H - MARGIN.bottom, color: NEUTRAL_SERIES_RAMP[0] });
    container.appendChild(section);
  }

  // Collapsed per-feature + per-model presentation (GAP-2d) — ONE compact
  // section (two small swatch-labeled quiet tables) replacing the former two
  // full chart cards, which the founder called low-value near-static noise. A
  // table is trivially responsive (no chartW-driven geometry needed) and
  // keeps FEATURE_ORDER + NEUTRAL_SERIES_RAMP coloring (D-08, non-amber).
  function renderUsageBreakdown(container, byFeature, byModel) {
    const section = makeSection('Usage breakdown');

    const featureEntries = [];
    FEATURE_ORDER.forEach((tag, i) => {
      const row = byFeature.find((r) => r.feature_tag === tag);
      if (!row) return; // no zero-padded placeholder series — Empty/Sparse State Contract
      const tokens = (row.input_tokens || 0) + (row.output_tokens || 0);
      featureEntries.push({ label: tag, tokens, color: NEUTRAL_SERIES_RAMP[i % NEUTRAL_SERIES_RAMP.length] });
    });

    const modelEntries = (byModel || []).map((row, i) => ({
      label: row.model,
      tokens: (row.input_tokens || 0) + (row.output_tokens || 0),
      color: NEUTRAL_SERIES_RAMP[i % NEUTRAL_SERIES_RAMP.length],
    }));

    if (featureEntries.length === 0 && modelEntries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'stats-empty-state';
      empty.textContent = 'no usage recorded yet'; // textContent only — T-44-19
      section.appendChild(empty);
      container.appendChild(section);
      return;
    }

    function appendGroup(titleText, entries) {
      if (entries.length === 0) return;
      const heading = document.createElement('div');
      heading.className = 'stats-breakdown-group-title';
      heading.textContent = titleText; // textContent only — T-44-19
      section.appendChild(heading);

      const table = document.createElement('div');
      table.className = 'stats-breakdown-table';
      entries.forEach((e) => {
        const row = document.createElement('div');
        row.className = 'stats-breakdown-row';

        const swatch = document.createElement('span');
        swatch.className = 'stats-breakdown-swatch';
        swatch.style.background = e.color;
        row.appendChild(swatch);

        const labelEl = document.createElement('span');
        labelEl.className = 'stats-breakdown-label';
        labelEl.textContent = e.label; // textContent only — T-44-19
        row.appendChild(labelEl);

        const valueEl = document.createElement('span');
        valueEl.className = 'stats-breakdown-value';
        valueEl.textContent = fmtTokens(e.tokens); // textContent only — T-44-19
        row.appendChild(valueEl);

        table.appendChild(row);
      });
      section.appendChild(table);
    }

    appendGroup('per feature', featureEntries);
    appendGroup('per model', modelEntries);

    container.appendChild(section);
  }

  // ── Brain Health tab (D-13/D-14) ─────────────────────────────────────────────
  // node growth, kind mix, reconsolidations/tombstones per day, judge activity,
  // episode backlog, and an honest last-sleep-pass readout — all from a single
  // /stats/brain-health fetch (routed through load() above).

  // A truly fresh brain: no growth events, no nodes of any kind, no recon/tombstone
  // days, no episodes, no judge fires. Any one real signal takes the tab out of the
  // empty state (per-chart "no X yet" copy then covers a partially-empty brain).
  function isBrainHealthEmpty(data) {
    const growthPoints = (data.node_growth && data.node_growth.points) || [];
    const kindMix = data.kind_mix || {};
    const kindMixTotal = Object.values(kindMix).reduce((sum, n) => sum + (n || 0), 0);
    const reconDays = (data.reconsolidations_per_day || []).length;
    const tombDays = (data.tombstones_per_day || []).length;
    const episodesTotal = ((data.episodes && data.episodes.pending) || 0)
      + ((data.episodes && data.episodes.consolidated) || 0);
    const judgeFires = (data.judge_activity && data.judge_activity.fires) || 0;
    return growthPoints.length === 0 && kindMixTotal === 0 && reconDays === 0
      && tombDays === 0 && episodesTotal === 0 && judgeFires === 0;
  }

  // Pure geometry for a {date,count}[] time series — no axis()/legend() call inside
  // (each chart calls those itself, at its own source line, so every chart's
  // axis/legend stays independently grep-verifiable rather than hidden inside
  // a shared closure).
  function buildLineChartSvg(points, height, chartW) {
    const svg = createChartSvg(chartW, height);
    const maxVal = points.reduce((m, p) => Math.max(m, p.count || 0), 0);
    const ticks = niceTicks(0, maxVal);
    const niceMax = ticks[ticks.length - 1] || 1;
    const yScale = linearScale([0, niceMax], [height - MARGIN.bottom, MARGIN.top]);
    const xScale = linearScale([0, Math.max(points.length - 1, 1)], [MARGIN.left, chartW - MARGIN.right]);
    const pxPoints = points.map((p, i) => ({
      x: xScale(i), y: yScale(p.count || 0), date: p.date, value: p.count || 0,
      formatValue: (v) => String(v),
    }));
    return { svg, ticks, yScale, xScale, pxPoints };
  }

  // Pure geometry for a small labeled-category bar chart (kind-mix / judge-activity /
  // episodes) — same axis/legend-at-call-site discipline as buildLineChartSvg above.
  function buildBarChartSvg(entries, height, chartW) {
    const svg = createChartSvg(chartW, height);
    const maxVal = entries.reduce((m, e) => Math.max(m, e.tokens), 0);
    const ticks = niceTicks(0, maxVal);
    const niceMax = ticks[ticks.length - 1] || 1;
    const yScale = linearScale([0, niceMax], [height - MARGIN.bottom, MARGIN.top]);
    const innerW = chartW - MARGIN.left - MARGIN.right;
    const slot = innerW / entries.length;
    const barWidth = Math.min(56, slot * 0.5);
    const bars = entries.map((e, i) => {
      const cx = MARGIN.left + slot * (i + 0.5);
      const y = yScale(e.tokens);
      return { x: cx - barWidth / 2, y, width: barWidth, height: (height - MARGIN.bottom) - y };
    });
    const xTicks = entries.map((e, i) => ({ x: MARGIN.left + slot * (i + 0.5), label: e.label }));
    return { svg, ticks, yScale, bars, xTicks };
  }

  function renderChartEmpty(container, card, text) {
    const empty = document.createElement('div');
    empty.className = 'stats-empty-state';
    empty.textContent = text; // textContent only — T-44-19
    card.appendChild(empty);
    container.appendChild(card);
  }

  // Focal chart (D-06 — largest card, top of the tab): cumulative node growth,
  // KIND_COLOR.new_node, D-13 approximation caption, D-07 nearest-point hover.
  function renderNodeGrowthChart(container, nodeGrowth, chartW) {
    const card = makeSection('Node growth');
    card.classList.add('stats-section-primary');
    const points = (nodeGrowth && nodeGrowth.points) || [];

    if (points.length === 0) {
      renderChartEmpty(container, card, 'no node growth recorded yet');
      return;
    }

    const { svg, ticks, yScale, xScale, pxPoints } = buildLineChartSvg(points, BURN_H, chartW);
    const color = hex(KIND_COLOR.new_node);

    svg.appendChild(axis({
      orientation: 'y', ticks, scale: yScale,
      chartLeft: MARGIN.left, chartRight: chartW - MARGIN.right, formatValue: (v) => String(v),
    }));
    svg.appendChild(axis({
      orientation: 'x', xTicks: pickXTicks(points, xScale), chartBottom: BURN_H - MARGIN.bottom,
    }));
    svg.appendChild(line(pxPoints, { color }));
    svg.appendChild(legend([{ label: 'nodes', color }], { x: chartW - 90, y: MARGIN.top - 4 }));

    card.appendChild(svg);
    attachHover(svg, pxPoints, { chartTop: MARGIN.top, chartBottom: BURN_H - MARGIN.bottom, color });

    if (nodeGrowth && nodeGrowth.approximate) {
      const caption = document.createElement('div');
      caption.textContent = NODE_GROWTH_CAPTION; // textContent only — T-44-19, D-13 verbatim
      caption.style.fontSize = '10px';
      caption.style.color = 'var(--text-recede)';
      caption.style.marginTop = '8px';
      card.appendChild(caption);
    }

    container.appendChild(card);
  }

  // Kind-mix grouped bar (fact/entity/schema/doc/insight) — always all five series
  // (fixed taxonomy, not a variable feature/model list) so the legend never drops one.
  function renderKindMixChart(container, kindMix, chartW) {
    const card = makeSection('Kind mix');
    const entries = KIND_MIX_SERIES.map((s) => ({
      label: s.label, tokens: (kindMix && kindMix[s.key]) || 0, color: s.color,
    }));
    const total = entries.reduce((sum, e) => sum + e.tokens, 0);

    if (total === 0) {
      renderChartEmpty(container, card, 'no nodes recorded yet');
      return;
    }

    const { svg, ticks, yScale, bars, xTicks } = buildBarChartSvg(entries, BAR_H, chartW);

    svg.appendChild(axis({
      orientation: 'y', ticks, scale: yScale,
      chartLeft: MARGIN.left, chartRight: chartW - MARGIN.right, formatValue: (v) => String(v),
    }));
    svg.appendChild(axis({ orientation: 'x', xTicks, chartBottom: BAR_H - MARGIN.bottom }));
    entries.forEach((e, i) => svg.appendChild(bar([bars[i]], { color: e.color })));
    svg.appendChild(legend(
      entries.map((e) => ({ label: e.label, color: e.color })),
      { x: MARGIN.left, y: MARGIN.top - 4 },
    ));

    card.appendChild(svg);
    container.appendChild(card);
  }

  // Reconsolidations/day line — KIND_COLOR.reconsolidation (rose-mauve), D-07 hover.
  function renderReconChart(container, points, chartW) {
    const card = makeSection('Reconsolidations / day');
    const list = points || [];

    if (list.length === 0) {
      renderChartEmpty(container, card, 'no reconsolidations recorded yet');
      return;
    }

    const { svg, ticks, yScale, xScale, pxPoints } = buildLineChartSvg(list, BAR_H, chartW);
    const color = hex(KIND_COLOR.reconsolidation);

    svg.appendChild(axis({
      orientation: 'y', ticks, scale: yScale,
      chartLeft: MARGIN.left, chartRight: chartW - MARGIN.right, formatValue: (v) => String(v),
    }));
    svg.appendChild(axis({
      orientation: 'x', xTicks: pickXTicks(list, xScale), chartBottom: BAR_H - MARGIN.bottom,
    }));
    svg.appendChild(line(pxPoints, { color }));
    svg.appendChild(legend([{ label: 'reconsolidations', color }], { x: chartW - 140, y: MARGIN.top - 4 }));

    card.appendChild(svg);
    attachHover(svg, pxPoints, { chartTop: MARGIN.top, chartBottom: BAR_H - MARGIN.bottom, color });

    const caption = document.createElement('div');
    caption.textContent = EVENT_COUNT_CAPTION; // textContent only — T-44-19
    caption.style.fontSize = '10px';
    caption.style.color = 'var(--text-recede)';
    caption.style.marginTop = '8px';
    card.appendChild(caption);

    container.appendChild(card);
  }

  // Tombstones/day line — KIND_COLOR.oscillation (coral), D-07 hover.
  function renderTombstoneChart(container, points, chartW) {
    const card = makeSection('Tombstones / day');
    const list = points || [];

    if (list.length === 0) {
      renderChartEmpty(container, card, 'no tombstones recorded yet');
      return;
    }

    const { svg, ticks, yScale, xScale, pxPoints } = buildLineChartSvg(list, BAR_H, chartW);
    const color = hex(KIND_COLOR.oscillation);

    svg.appendChild(axis({
      orientation: 'y', ticks, scale: yScale,
      chartLeft: MARGIN.left, chartRight: chartW - MARGIN.right, formatValue: (v) => String(v),
    }));
    svg.appendChild(axis({
      orientation: 'x', xTicks: pickXTicks(list, xScale), chartBottom: BAR_H - MARGIN.bottom,
    }));
    svg.appendChild(line(pxPoints, { color }));
    svg.appendChild(legend([{ label: 'tombstones', color }], { x: chartW - 110, y: MARGIN.top - 4 }));

    card.appendChild(svg);
    attachHover(svg, pxPoints, { chartTop: MARGIN.top, chartBottom: BAR_H - MARGIN.bottom, color });

    const caption = document.createElement('div');
    caption.textContent = EVENT_COUNT_CAPTION; // textContent only — T-44-19
    caption.style.fontSize = '10px';
    caption.style.color = 'var(--text-recede)';
    caption.style.marginTop = '8px';
    card.appendChild(caption);

    container.appendChild(card);
  }

  // Judge-activity bar — fires (KIND_COLOR.recall_hop, cyan). The server reports
  // escalation_rate: null (unavailable) because the ledger cannot distinguish
  // escalated judge calls (feature_tag='judge' rows are Sonnet by construction —
  // see server.ts's stmtJudgeFires comment); rendering a bar from that would
  // fabricate a metric. If the server ever ships a real numeric rate, the second
  // "escalated" bar (KIND_COLOR.neutral, slate) renders again with its honest
  // percentage in the legend label.
  function renderJudgeActivityChart(container, judgeActivity, chartW) {
    const card = makeSection('Judge activity');
    const fires = (judgeActivity && judgeActivity.fires) || 0;
    const escalationRate = judgeActivity ? judgeActivity.escalation_rate : null;

    if (fires === 0) {
      renderChartEmpty(container, card, 'no judge activity recorded yet');
      return;
    }

    const entries = [
      { label: 'fires', tokens: fires, color: hex(KIND_COLOR.recall_hop) },
    ];
    if (typeof escalationRate === 'number') {
      const escalated = Math.round(fires * escalationRate);
      const pct = Math.round(escalationRate * 100);
      entries.push({ label: 'escalated (' + pct + '%)', tokens: escalated, color: hex(KIND_COLOR.neutral) });
    }

    const { svg, ticks, yScale, bars, xTicks } = buildBarChartSvg(entries, BAR_H, chartW);

    svg.appendChild(axis({
      orientation: 'y', ticks, scale: yScale,
      chartLeft: MARGIN.left, chartRight: chartW - MARGIN.right, formatValue: (v) => String(v),
    }));
    svg.appendChild(axis({ orientation: 'x', xTicks, chartBottom: BAR_H - MARGIN.bottom }));
    entries.forEach((e, i) => svg.appendChild(bar([bars[i]], { color: e.color })));
    svg.appendChild(legend(
      entries.map((e) => ({ label: e.label, color: e.color })),
      { x: MARGIN.left, y: MARGIN.top - 4 },
    ));

    card.appendChild(svg);
    container.appendChild(card);
  }

  // Episodes pending-vs-consolidated paired bar — pending KIND_COLOR.neutral,
  // consolidated KIND_COLOR.new_node.
  function renderEpisodesChart(container, episodes, chartW) {
    const card = makeSection('Episodes pending vs. consolidated');
    const pending = (episodes && episodes.pending) || 0;
    const consolidated = (episodes && episodes.consolidated) || 0;

    if (pending === 0 && consolidated === 0) {
      renderChartEmpty(container, card, 'no episodes recorded yet');
      return;
    }

    const entries = [
      { label: 'pending', tokens: pending, color: hex(KIND_COLOR.neutral) },
      { label: 'consolidated', tokens: consolidated, color: hex(KIND_COLOR.new_node) },
    ];

    const { svg, ticks, yScale, bars, xTicks } = buildBarChartSvg(entries, BAR_H, chartW);

    svg.appendChild(axis({
      orientation: 'y', ticks, scale: yScale,
      chartLeft: MARGIN.left, chartRight: chartW - MARGIN.right, formatValue: (v) => String(v),
    }));
    svg.appendChild(axis({ orientation: 'x', xTicks, chartBottom: BAR_H - MARGIN.bottom }));
    entries.forEach((e, i) => svg.appendChild(bar([bars[i]], { color: e.color })));
    svg.appendChild(legend(
      entries.map((e) => ({ label: e.label, color: e.color })),
      { x: MARGIN.left, y: MARGIN.top - 4 },
    ));

    card.appendChild(svg);
    container.appendChild(card);
  }

  // "{n}m ago" / "{n}h ago" / "{n}d ago" relative-time formatter for the last-sleep-
  // pass tile — computed locally from the server's raw ts (epoch ms).
  function relativeTimeFromMs(ts) {
    const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return diffMin + 'm ago';
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + 'h ago';
    const diffDay = Math.floor(diffHr / 24);
    return diffDay + 'd ago';
  }

  // "{n}s" / "{n}m {n}s" / "{n}h {n}m" duration formatter for the last-sleep-pass tile.
  function formatDurationMs(ms) {
    if (ms == null || ms < 0) return '0s';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return sec + 's';
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    if (min < 60) return remSec > 0 ? min + 'm ' + remSec + 's' : min + 'm';
    const hr = Math.floor(min / 60);
    const remMin = min % 60;
    return remMin > 0 ? hr + 'h ' + remMin + 'm' : hr + 'h';
  }

  // Freshness window for the last-sleep-pass tile's healthy/stale color (Claude's
  // Discretion default — no per-user sleepFrequencyHours signal is threaded through
  // this fetch; 24h comfortably covers the settings.js default of 1h between passes
  // while not flagging a merely-quiet brain as broken).
  const SLEEP_PASS_STALE_MS = 24 * 60 * 60 * 1000;

  // Last-sleep-pass readout tile (D-14, NOT a chart — no axis()/legend()). Reads
  // status/ts/duration_ms from the server; the server only ever sends an honest
  // 'unknown' (a pass happened, batch boundary approximated) or 'none' (never
  // happened) — this tile never fabricates a healthy status word of its own.
  function renderLastSleepPassTile(container, lastSleepPass) {
    const tile = document.createElement('div');
    tile.className = 'stats-headline-tile';

    const readout = document.createElement('div');
    readout.className = 'stats-headline-label';
    readout.style.fontSize = '13px';

    const status = lastSleepPass && lastSleepPass.status;
    const ts = lastSleepPass && lastSleepPass.ts;
    const durationMs = lastSleepPass && lastSleepPass.duration_ms;

    if (status === 'none' || ts == null) {
      readout.textContent = 'no sleep pass has run yet'; // textContent only — T-44-19, verbatim
      readout.style.color = 'var(--error-text)';
    } else {
      const stale = (Date.now() - ts) > SLEEP_PASS_STALE_MS;
      // textContent only — T-44-19; verbatim copy shape, relative time + duration derived locally
      readout.textContent = 'last sleep pass: ' + relativeTimeFromMs(ts) + ' (' + formatDurationMs(durationMs) + ')';
      readout.style.color = stale ? 'var(--error-text)' : 'var(--text-stat)';
    }

    tile.appendChild(readout);
    container.appendChild(tile);
  }

  function renderHealthTab(container, data) {
    if (!container) return;
    container.textContent = '';

    if (!data) {
      const err = document.createElement('div');
      err.className = 'stats-error-state';
      err.textContent = 'could not load brain-health stats'; // textContent only — T-44-19
      container.appendChild(err);
      return;
    }

    if (isBrainHealthEmpty(data)) {
      const empty = document.createElement('div');
      empty.className = 'stats-empty-state';
      const heading = document.createElement('div');
      heading.textContent = 'No brain activity yet'; // textContent only — T-44-19
      const body = document.createElement('div');
      body.textContent = 'Metrics appear after the first sleep pass consolidates episodes into the brain.';
      empty.appendChild(heading);
      empty.appendChild(body);
      container.appendChild(empty);
      return;
    }

    const chartW = measureChartWidth(container);
    renderNodeGrowthChart(container, data.node_growth, chartW);
    renderKindMixChart(container, data.kind_mix, chartW);
    renderReconChart(container, data.reconsolidations_per_day, chartW);
    renderTombstoneChart(container, data.tombstones_per_day, chartW);
    renderJudgeActivityChart(container, data.judge_activity, chartW);
    renderEpisodesChart(container, data.episodes, chartW);
    renderLastSleepPassTile(container, data.last_sleep_pass);
  }
}
