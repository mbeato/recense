import { describe, it, expect } from 'vitest';
import { layoutCorpus } from '../src/viz/modules/corpus-layout.js';

const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
const links = [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }];

describe('layoutCorpus', () => {
  it('returns one finite {x,z} per node, centered near origin', () => {
    const pos = layoutCorpus(nodes, links);
    expect(pos.size).toBe(4);
    for (const id of ['a', 'b', 'c', 'd']) {
      const p = pos.get(id);
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
    }
    const cx = [...pos.values()].reduce((s, p) => s + p.x, 0) / pos.size;
    const cz = [...pos.values()].reduce((s, p) => s + p.z, 0) / pos.size;
    expect(Math.abs(cx)).toBeLessThan(1e-6);
    expect(Math.abs(cz)).toBeLessThan(1e-6);
  });

  it('is deterministic (no Math.random) — same input, same output', () => {
    const a = layoutCorpus(nodes, links);
    const b = layoutCorpus(nodes, links);
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(a.get(id)).toEqual(b.get(id));
    }
  });

  it('pulls linked nodes closer than unlinked on average', () => {
    const pos = layoutCorpus(nodes, links);
    const d = (i: string, j: string) =>
      Math.hypot(pos.get(i).x - pos.get(j).x, pos.get(i).z - pos.get(j).z);
    const linked = (d('a', 'b') + d('a', 'c')) / 2;
    const unlinked = d('b', 'd');
    expect(linked).toBeLessThan(unlinked);
  });

  it('handles a single node and zero links without throwing', () => {
    const pos = layoutCorpus([{ id: 'solo' }], []);
    expect(pos.get('solo')).toEqual({ x: 0, z: 0 });
  });
});
