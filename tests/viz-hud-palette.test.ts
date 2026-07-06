/**
 * tests/viz-hud-palette.test.ts
 *
 * Phase 59 Plan 03 — unit tests for palette.js's pure fuzzy/subsequence matcher
 * (fuzzyScore/filterSection). No DOM: these are the two exported pure functions,
 * exercised directly in node (mirrors tests/reader-render.test.ts's renderMarkdown
 * pure-function pattern).
 */
import { describe, it, expect } from 'vitest';
// @ts-ignore — browser ESM, no type declarations; exercised directly in node
import { fuzzyScore, filterSection } from '../src/viz/modules/palette.js';

describe('fuzzyScore — subsequence fuzzy matcher', () => {
  it('matches a non-contiguous subsequence', () => {
    expect(fuzzyScore('stg', 'settings')).toBeGreaterThan(0);
  });

  it('scores a contiguous/earlier match higher than a scattered one', () => {
    expect(fuzzyScore('set', 'settings')).toBeGreaterThan(fuzzyScore('stg', 'settings'));
  });

  it('returns falsy for a non-subsequence', () => {
    expect(fuzzyScore('xyz', 'settings')).toBeFalsy();
  });

  it('empty query matches everything (truthy score)', () => {
    expect(fuzzyScore('', 'settings')).toBeGreaterThan(0);
    expect(fuzzyScore('', 'anything at all')).toBeGreaterThan(0);
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('SET', 'settings')).toBeGreaterThan(0);
  });
});

describe('filterSection — score + sort + cap', () => {
  const items = ['settings', 'reader', 'recenter', 'corpus', 'search'];

  it('drops non-matching items', () => {
    const result = filterSection('xyz', items, 10);
    expect(result).toEqual([]);
  });

  it('empty query returns all candidates (matches everything)', () => {
    const result = filterSection('', items, 10);
    expect(result).toHaveLength(items.length);
  });

  it('caps the result count', () => {
    const result = filterSection('e', items, 2);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  it('sorts higher-scoring matches first', () => {
    const result = filterSection('re', items, 10);
    // 'reader'/'recenter' start with 're' (contiguous+earliest) — should rank
    // ahead of 'search' (scattered 'r'...'e' match, if it matches at all).
    expect(result[0] === 'reader' || result[0] === 'recenter').toBe(true);
  });

  it('supports a getLabel extractor for non-string items', () => {
    const objs = [{ label: 'Open settings' }, { label: 'Recenter view' }];
    const result = filterSection('recent', objs, 10, o => o.label);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('Recenter view');
  });
});
