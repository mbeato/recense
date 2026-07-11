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
