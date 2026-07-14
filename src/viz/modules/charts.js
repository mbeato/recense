/**
 * @module charts
 * Phase 60 (D-05) — hand-rolled inline-SVG chart primitives for the stats
 * dashboards (Usage / Brain Health tabs). Zero chart library, zero new
 * runtime dependency; every SVG node is built via
 * `document.createElementNS(SVG_NS, ...)`, and any `<text>` content is set
 * through `.textContent` only — never dynamic-markup assignment of any kind
 * (T-44-19 discipline, even for numeric labels).
 *
 * The geometry helpers (niceTicks, linearScale, nearestPointIndex, fmtDate,
 * fmtTokens) are PURE data→data functions with no `document` reference, so
 * they import and unit-test in plain Node (mirrors reader.js's
 * renderMarkdown pure-function precedent) — see
 * tests/viz-charts-geometry.test.ts.
 *
 * Series colors are always caller-supplied (KIND_COLOR/TYPE_COLOR for
 * activity-kind series, NEUTRAL_SERIES_RAMP for non-activity series, both
 * from ./constants.js) — this module never hard-codes a color, and never an
 * amber-family value (D-08 amber-exclusivity, machine-checked by
 * tests/viz-charts-geometry.test.ts's source-grep guard).
 *
 * No dynamic-markup DOM assignment of any kind is used anywhere in this
 * file (the string T-44-19 forbids is deliberately absent even from these
 * comments so the phase's source-grep guard stays a true zero-match check).
 */

export const SVG_NS = 'http://www.w3.org/2000/svg';

// ============================================================================
// Pure geometry helpers (no DOM — unit-tested in Node)
// ============================================================================

/**
 * "Nice" round number close to `value` (Heckbert's algorithm), used to pick
 * both the chart's rounded max and its tick step.
 * @param {number} value
 * @param {boolean} round - round to nearest nice fraction vs. round up
 * @returns {number}
 */
function niceNumber(value, round) {
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / Math.pow(10, exponent);
  let niceFraction;
  if (round) {
    if (fraction < 1.5) niceFraction = 1;
    else if (fraction < 3) niceFraction = 2;
    else if (fraction < 7) niceFraction = 5;
    else niceFraction = 10;
  } else {
    if (fraction <= 1) niceFraction = 1;
    else if (fraction <= 2) niceFraction = 2;
    else if (fraction <= 5) niceFraction = 5;
    else niceFraction = 10;
  }
  return niceFraction * Math.pow(10, exponent);
}

/**
 * Ascending Y-axis tick values, always starting at 0 (UI-SPEC "Y-axis min
 * always 0"), covering `max` with a "nice" step (~4-5 ticks).
 * @param {number} min - unused (Y min is always 0 per contract); kept in the
 *   signature for call-site clarity / future non-zero-baseline charts.
 * @param {number} max
 * @param {number} [count=5] - target tick count
 * @returns {number[]}
 */
export function niceTicks(min, max, count = 5) {
  if (!(max > 0)) return [0];
  const range = niceNumber(max, false);
  const step = niceNumber(range / Math.max(1, count - 1), true);
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= niceMax + step / 2; v += step) {
    ticks.push(Math.round(v / step) * step);
  }
  return ticks;
}

/**
 * Linear value→pixel scale. `domain`/`range` are `[min, max]` pairs; range
 * endpoints may be inverted (e.g. a Y-axis where value 0 maps to the bottom
 * pixel, a larger pixel value).
 * @param {[number, number]} domain
 * @param {[number, number]} range
 * @returns {(v: number) => number}
 */
export function linearScale(domain, range) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return function scale(v) {
    if (span === 0) return r0;
    const t = (v - d0) / span;
    return r0 + t * (r1 - r0);
  };
}

/**
 * Index of the data point whose pixel-space `x` is closest to `xPixel` — the
 * D-07 nearest-point hover core. Pure/no-DOM so it is independently testable.
 * @param {{x: number}[]} points
 * @param {number} xPixel
 * @returns {number} index, or -1 for an empty series
 */
export function nearestPointIndex(points, xPixel) {
  if (!points || points.length === 0) return -1;
  let best = 0;
  let bestDist = Math.abs(points[0].x - xPixel);
  for (let i = 1; i < points.length; i++) {
    const d = Math.abs(points[i].x - xPixel);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "MMM D" date formatter (e.g. "Jul 8") — UI-SPEC X-axis tick / hover-tooltip
 * format. Accepts a 'YYYY-MM-DD' string, epoch ms, or a Date; reads UTC
 * fields so a date-only string never shifts a day under a local timezone.
 * @param {string | number | Date} d
 * @returns {string}
 */
export function fmtDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  return MONTH_LABELS[date.getUTCMonth()] + ' ' + date.getUTCDate();
}

/**
 * Human-readable token count: 1.2M, 34.5k, or plain number — re-implements
 * settings.js's fmtTokens() thresholds verbatim (not exported there) so
 * chart axis ticks and headline numbers format identically across the app.
 * @param {number} n
 * @returns {string}
 */
export function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

// ============================================================================
// SVG builders (createElementNS — DOM required, called at render time only)
// ============================================================================

/**
 * Create one SVG element with attributes set via setAttribute (never
 * dynamic markup).
 * @param {string} tag
 * @param {Record<string, string | number>} [attrs]
 * @returns {SVGElement}
 */
function createSvgNode(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const key of Object.keys(attrs)) {
    el.setAttribute(key, String(attrs[key]));
  }
  return el;
}

/**
 * Line series: 2px round-join/cap stroke, no fill under the line by default
 * (GAP-4d mark spec). Passing `areaFill` additionally renders a ~10%-opacity
 * filled area from the points down to `opts.baselineY`, BEHIND the stroke.
 * @param {{x: number, y: number}[]} points - pixel-space points, already scaled
 * @param {{color?: string, strokeWidth?: number, dashed?: boolean, areaFill?: string, baselineY?: number}} [opts]
 * @returns {SVGPolylineElement | SVGGElement}
 */
export function line(points, opts = {}) {
  const { color = '#a99db3', strokeWidth = 2, dashed = false, areaFill, baselineY } = opts;
  const attrs = {
    points: points.map(p => `${p.x},${p.y}`).join(' '),
    fill: 'none',
    stroke: color,
    'stroke-width': strokeWidth,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
  };
  if (dashed) attrs['stroke-dasharray'] = '4,3';
  const stroke = createSvgNode('polyline', attrs);
  if (!areaFill || !points.length) return stroke;

  const baseline = baselineY != null ? baselineY : points[0].y;
  const areaPoints = [
    { x: points[0].x, y: baseline },
    ...points,
    { x: points[points.length - 1].x, y: baseline },
  ];
  const area = createSvgNode('polygon', {
    points: areaPoints.map(p => `${p.x},${p.y}`).join(' '),
    fill: areaFill,
    'fill-opacity': 0.1,
    stroke: 'none',
  });
  const g = createSvgNode('g', { class: 'chart-line-series' });
  g.appendChild(area);
  g.appendChild(stroke);
  return g;
}

/**
 * Bar series: strokeless fill at 0.75 alpha, rendered as a rounded-top path
 * (4px radius on the two data-end/top corners, square baseline corners) —
 * GAP-4d mark spec, no stroke around the mark.
 * @param {{x: number, y: number, width: number, height: number}[]} bars - pixel-space rects
 * @param {{color?: string, fillAlpha?: number}} [opts]
 * @returns {SVGGElement}
 */
export function bar(bars, opts = {}) {
  const { color = '#a99db3', fillAlpha = 0.75 } = opts;
  const g = createSvgNode('g', { class: 'chart-bar-series' });
  bars.forEach(b => {
    const r = Math.min(4, b.width / 2, b.height);
    const { x, y, width: w, height: h } = b;
    const d = [
      `M ${x} ${y + h}`,
      `L ${x} ${y + r}`,
      `A ${r} ${r} 0 0 1 ${x + r} ${y}`,
      `L ${x + w - r} ${y}`,
      `A ${r} ${r} 0 0 1 ${x + w} ${y + r}`,
      `L ${x + w} ${y + h}`,
      'Z',
    ].join(' ');
    const path = createSvgNode('path', {
      d,
      fill: color,
      'fill-opacity': fillAlpha,
    });
    g.appendChild(path);
  });
  return g;
}

/**
 * Endpoint direct-label — a small recessive `<text>` node positioned at one
 * point (endpoint/extreme), used for selective direct labels (GAP-4d: never
 * a value on every point). textContent-set only (T-44-19), even numeric.
 * @param {{x: number, y: number}} point
 * @param {string | number} text
 * @param {{dx?: number, dy?: number, anchor?: string, color?: string}} [opts]
 * @returns {SVGTextElement}
 */
export function directLabel(point, text, opts = {}) {
  const { dx = 0, dy = -6, anchor = 'middle', color = '#9a90a4' } = opts;
  const label = createSvgNode('text', {
    x: point.x + dx,
    y: point.y + dy,
    'text-anchor': anchor,
    fill: color,
    'font-size': 10,
  });
  label.textContent = String(text);
  return label;
}

/**
 * One chart axis — Y (value, with horizontal gridlines) or X (time, "MMM D"
 * labels, no vertical gridlines — UI-SPEC "Gridlines: Horizontal only").
 * @param {Object} opts
 * @param {'x' | 'y'} opts.orientation
 * @param {number[]} [opts.ticks] - Y: tick values (from niceTicks)
 * @param {(v: number) => number} [opts.scale] - Y: value→pixel scale
 * @param {number} [opts.chartLeft]
 * @param {number} [opts.chartRight]
 * @param {(v: number) => string} [opts.formatValue] - Y: tick label formatter
 * @param {{x: number, label: string}[]} [opts.xTicks] - X: pixel+label pairs, pre-strided by the caller
 * @param {number} [opts.chartBottom]
 * @param {string} [opts.gridColor] - defaults to --section-divider-faint
 * @param {string} [opts.textColor]
 * @returns {SVGGElement}
 */
export function axis(opts) {
  const { orientation, gridColor = 'rgba(140,150,165,0.08)', textColor = '#9a90a4' } = opts;
  const g = createSvgNode('g', { class: 'chart-axis chart-axis--' + orientation });

  if (orientation === 'y') {
    const { ticks = [], scale, chartLeft = 0, chartRight = 0, formatValue } = opts;
    ticks.forEach(v => {
      const py = scale(v);
      g.appendChild(createSvgNode('line', {
        x1: chartLeft, x2: chartRight, y1: py, y2: py,
        stroke: gridColor, 'stroke-width': 1,
      }));
      const label = createSvgNode('text', {
        x: chartLeft - 6, y: py,
        'text-anchor': 'end', 'dominant-baseline': 'middle',
        fill: textColor, 'font-size': 10,
      });
      label.textContent = formatValue ? formatValue(v) : String(v);
      g.appendChild(label);
    });
  } else {
    const { xTicks = [], chartBottom = 0 } = opts;
    xTicks.forEach(t => {
      const label = createSvgNode('text', {
        x: t.x, y: chartBottom + 16,
        'text-anchor': 'middle',
        fill: textColor, 'font-size': 10,
      });
      label.textContent = t.label;
      g.appendChild(label);
    });
  }
  return g;
}

/**
 * Legend row: 8x8 swatch + 13px label per series, laid out left→right
 * starting at (opts.x, opts.y).
 * @param {{label: string, color: string}[]} series
 * @param {{x?: number, y?: number, gap?: number}} [opts]
 * @returns {SVGGElement}
 */
export function legend(series, opts = {}) {
  const { x = 0, y = 0, gap = 16 } = opts;
  const SWATCH = 8;
  const g = createSvgNode('g', { class: 'chart-legend' });
  let cx = x;
  series.forEach(s => {
    g.appendChild(createSvgNode('rect', {
      x: cx, y, width: SWATCH, height: SWATCH, rx: 2,
      fill: s.color,
    }));
    const label = createSvgNode('text', {
      x: cx + SWATCH + 4, y: y + SWATCH - 1,
      fill: '#9a90a4', 'font-size': 13,
    });
    label.textContent = s.label;
    g.appendChild(label);
    // No DOM layout pass available before the caller inserts this into the
    // document, so item width is a size-driven estimate (Label 10px metric
    // isn't used here — Body 13px average glyph width), not a measured one.
    cx += SWATCH + 4 + s.label.length * 6.5 + gap;
  });
  return g;
}

/**
 * Attach nearest-point hover to a chart: vertical crosshair + 4px dot at the
 * closest data point, plus the shared `#tooltip` element updated with
 * "{MMM D} — {value}" (D-07). Hover only brightens geometry (opacity/stroke)
 * — no box-shadow/filter glow (UI-SPEC "Hover state — NO glow").
 * @param {SVGSVGElement} svg
 * @param {{x: number, y: number, date: string | number, value: number, formatValue?: (v: number) => string}[]} points - pixel-space points
 * @param {{chartTop: number, chartBottom: number, color?: string}} opts
 * @returns {{detach: () => void}}
 */
export function attachHover(svg, points, opts) {
  const { chartTop, chartBottom, color = '#8b8098' } = opts;
  if (!points.length) return { detach() {} };

  const crosshair = createSvgNode('line', {
    x1: 0, x2: 0, y1: chartTop, y2: chartBottom,
    stroke: 'var(--glass-border-focused)', 'stroke-width': 1,
    visibility: 'hidden',
  });
  const dot = createSvgNode('circle', { r: 4, fill: color, visibility: 'hidden' });
  svg.appendChild(crosshair);
  svg.appendChild(dot);

  function onMove(ev) {
    // Cost-event markers own the shared #tooltip while hovered (D-10/D-11 delta
    // text) — skip the generic nearest-point handler so it doesn't overwrite the
    // marker's tooltip on every bubbled mousemove.
    if (ev.target && ev.target.closest && ev.target.closest('.chart-marker')) return;
    const rect = svg.getBoundingClientRect();
    // The chart renders with viewBox="0 0 760 H" + width:100% (stretched to the
    // card width), so cursor position must be converted from screen pixels into
    // viewBox units before comparing against points[].x — the two coordinate
    // systems only coincide at exactly 760px rendered width.
    const vb = svg.viewBox.baseVal;
    const scaleX = rect.width > 0 ? vb.width / rect.width : 1;
    const xPixel = (ev.clientX - rect.left) * scaleX;
    const idx = nearestPointIndex(points, xPixel);
    if (idx < 0) return;
    const p = points[idx];
    crosshair.setAttribute('x1', String(p.x));
    crosshair.setAttribute('x2', String(p.x));
    crosshair.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', String(p.x));
    dot.setAttribute('cy', String(p.y));
    dot.setAttribute('visibility', 'visible');

    const tooltip = document.getElementById('tooltip');
    if (tooltip) {
      const valueLabel = p.formatValue ? p.formatValue(p.value) : String(p.value);
      tooltip.textContent = fmtDate(p.date) + ' — ' + valueLabel; // textContent only — T-44-19
      tooltip.style.left = ev.clientX + 12 + 'px';
      tooltip.style.top = ev.clientY + 12 + 'px';
      tooltip.style.display = 'block';
    }
  }

  function onLeave() {
    crosshair.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
    const tooltip = document.getElementById('tooltip');
    if (tooltip) tooltip.style.display = 'none';
  }

  svg.addEventListener('mousemove', onMove);
  svg.addEventListener('mouseleave', onLeave);

  return {
    detach() {
      svg.removeEventListener('mousemove', onMove);
      svg.removeEventListener('mouseleave', onLeave);
      crosshair.remove();
      dot.remove();
    },
  };
}
