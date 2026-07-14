/**
 * tests/viz-charts-geometry.test.ts
 *
 * Phase 60 Plan 02 (D-05/D-06/D-07) — unit tests for the pure geometry
 * helpers exported by src/viz/modules/charts.js (niceTicks, linearScale,
 * nearestPointIndex). These are plain data→data functions with zero
 * `document` reference, so they import and run in plain Node — no jsdom
 * needed (vitest.config.ts environment stays 'node').
 *
 * Also carries the static source-grep guards (T-44-19 / D-08 amber-ban)
 * mirroring the style of tests/viz-activity-palette-invariants.test.ts.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
// @ts-ignore — browser ESM, no type declarations; exercised directly in node
import { niceTicks, linearScale, nearestPointIndex } from '../src/viz/modules/charts.js';

const ROOT = path.resolve(__dirname, '..');

function readChartsJs(): string {
  return fs.readFileSync(path.resolve(ROOT, 'src/viz/modules/charts.js'), 'utf8');
}

/**
 * Extract one `export function <name>(...)` body's source text (up to the
 * next top-level `export function`, or EOF) — charts.js's SVG builders touch
 * `document.createElementNS`, which isn't available in this suite's plain
 * 'node' vitest environment (no jsdom dependency — net-zero-deps invariant),
 * so mark-spec assertions are source-level, mirroring the existing
 * innerHTML/amber-ban source guards below.
 */
function extractFunction(src: string, name: string): string {
  const startMarker = `export function ${name}(`;
  const start = src.indexOf(startMarker);
  if (start === -1) throw new Error(`export function ${name} not found in charts.js`);
  const rest = src.slice(start);
  const nextExport = rest.indexOf('\nexport function ', startMarker.length);
  return nextExport === -1 ? rest : rest.slice(0, nextExport);
}

describe('niceTicks', () => {
  it('always starts at 0 (Y min always 0)', () => {
    expect(niceTicks(0, 42)[0]).toBe(0);
    expect(niceTicks(0, 1234)[0]).toBe(0);
    expect(niceTicks(0, 0.5)[0]).toBe(0);
  });

  it('covers max with a sane ~4-5 step count', () => {
    const ticks = niceTicks(0, 42);
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(42);
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks.length).toBeLessThanOrEqual(7);
  });

  it('handles a zero/degenerate max without throwing', () => {
    expect(niceTicks(0, 0)).toEqual([0]);
  });
});

describe('linearScale', () => {
  it('maps domain endpoints to range endpoints exactly', () => {
    const scale = linearScale([0, 100], [0, 500]);
    expect(scale(0)).toBe(0);
    expect(scale(100)).toBe(500);
  });

  it('maps a midpoint linearly', () => {
    const scale = linearScale([0, 100], [0, 500]);
    expect(scale(50)).toBe(250);
  });

  it('handles inverted pixel ranges (e.g. Y-axis where 0 is at the bottom)', () => {
    const scale = linearScale([0, 10], [200, 0]);
    expect(scale(0)).toBe(200);
    expect(scale(10)).toBe(0);
  });
});

describe('nearestPointIndex', () => {
  const points = [{ x: 0 }, { x: 10 }, { x: 20 }, { x: 30 }];

  it('picks the exact index on an exact match', () => {
    expect(nearestPointIndex(points, 20)).toBe(2);
  });

  it('picks the closest index between two points', () => {
    expect(nearestPointIndex(points, 12)).toBe(1);
    expect(nearestPointIndex(points, 17)).toBe(2);
  });

  it('picks the nearest endpoint when the pixel is out of range', () => {
    expect(nearestPointIndex(points, -50)).toBe(0);
    expect(nearestPointIndex(points, 500)).toBe(3);
  });

  it('returns -1 for an empty series', () => {
    expect(nearestPointIndex([], 10)).toBe(-1);
  });
});

describe('line() mark spec (GAP-4d)', () => {
  it('defaults strokeWidth to 2 (2px round-join stroke)', () => {
    const fn = extractFunction(readChartsJs(), 'line');
    expect(/strokeWidth\s*=\s*2\b/.test(fn)).toBe(true);
    expect(/stroke-linejoin['"]?:\s*['"]round['"]/.test(fn)).toBe(true);
    expect(/stroke-linecap['"]?:\s*['"]round['"]/.test(fn)).toBe(true);
  });

  it('supports an optional areaFill rendering a ~10% fill-opacity wash', () => {
    const fn = extractFunction(readChartsJs(), 'line');
    expect(/areaFill/.test(fn)).toBe(true);
    expect(/fill-opacity['"]?:\s*0\.1\b/.test(fn)).toBe(true);
  });
});

describe('bar() mark spec (GAP-4d)', () => {
  it('builds a rounded-top path with NO stroke around the mark', () => {
    const fn = extractFunction(readChartsJs(), 'bar');
    expect(/createSvgNode\(['"]path['"]/.test(fn)).toBe(true);
    expect(/\bstroke\b/.test(fn)).toBe(false);
  });

  it('clamps the corner radius to min(4, width/2, height)', () => {
    const fn = extractFunction(readChartsJs(), 'bar');
    expect(/Math\.min\(\s*4/.test(fn)).toBe(true);
  });
});

describe('directLabel() endpoint direct-label primitive', () => {
  it('is exported exactly once, builds a text node, and sets textContent only', () => {
    const src = readChartsJs();
    expect((src.match(/export function directLabel/g) || []).length).toBe(1);
    const fn = extractFunction(src, 'directLabel');
    expect(/createSvgNode\(['"]text['"]/.test(fn)).toBe(true);
    expect(/\.textContent\s*=/.test(fn)).toBe(true);
  });
});

describe('charts.js source guards', () => {
  it('never uses innerHTML anywhere (T-44-19)', () => {
    const src = readChartsJs();
    expect(/innerHTML/.test(src)).toBe(false);
  });

  it('never contains an amber-family literal (D-08 amber-exclusivity)', () => {
    const src = readChartsJs();
    expect(/ffb866/i.test(src)).toBe(false);
    expect(/accent-amber/i.test(src)).toBe(false);
  });

  it('builds SVG nodes via createElementNS', () => {
    const src = readChartsJs();
    expect(/createElementNS/.test(src)).toBe(true);
  });
});
