/**
 * tests/viz-labels-selection.test.ts
 *
 * Phase 58 Plan 03 — unit test for labels.js's pure `selectTopSchemas(ctx, n)`
 * helper: given a synthetic ctx.schemaMembers map + schema nodes, asserts the
 * top-N-by-member-count selection returns exactly the N largest, descending.
 *
 * Mocks vendored troika's `Text` class minimally (a stub) so labels.js can be
 * imported in vitest/Node without a browser/WebGL context — the real
 * troika-three-text.esm.js imports from 'three', which isn't wired as an npm
 * dependency (mirrors lod.js's own THREE-avoidance note for the same reason).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/viz/vendor/troika/troika-three-text.esm.js', () => ({
  Text: class {
    material: Record<string, unknown> = {};
    position = { set: () => {} };
    quaternion = { copy: () => {} };
    sync() {}
  },
}));

// @ts-ignore — browser ESM, no type declarations; exercised directly in node
import { selectTopSchemas } from '../src/viz/modules/labels.js';

function makeCtx(schemas: Array<{ id: string; count: number }>) {
  const allNodes = schemas.map(s => ({ id: s.id, __cat: 'schema' }));
  const schemaMembers = new Map(
    schemas.map(s => [s.id, new Set(Array.from({ length: s.count }, (_, i) => `${s.id}-m${i}`))])
  );
  return { allNodes, schemaMembers };
}

describe('selectTopSchemas', () => {
  it('returns the N schemas with the largest member sets, in descending order', () => {
    const ctx = makeCtx([
      { id: 's1', count: 5 },
      { id: 's2', count: 20 },
      { id: 's3', count: 12 },
      { id: 's4', count: 1 },
      { id: 's5', count: 8 },
    ]);
    const top3 = selectTopSchemas(ctx, 3);
    expect(top3.map((n: { id: string }) => n.id)).toEqual(['s2', 's3', 's5']);
  });

  it('returns fewer than n when fewer schemas exist (never fabricates entries)', () => {
    const ctx = makeCtx([{ id: 'only', count: 2 }]);
    expect(selectTopSchemas(ctx, 30).map((n: { id: string }) => n.id)).toEqual(['only']);
  });

  it('filters out non-schema nodes', () => {
    const ctx = makeCtx([{ id: 's1', count: 10 }]);
    ctx.allNodes.push({ id: 'member-1', __cat: 'member' } as any);
    expect(selectTopSchemas(ctx, 30).map((n: { id: string }) => n.id)).toEqual(['s1']);
  });

  it('returns an empty array when ctx is missing required fields', () => {
    expect(selectTopSchemas({} as any, 30)).toEqual([]);
  });
});
