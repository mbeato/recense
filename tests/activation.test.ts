import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../src/lib/config';
import {
  spreadParamsFromConfig, normalizeSeeds, prepareSeeds, spreadActivation,
  type SpreadReader, type SpreadEdgeRow, type SpreadParams,
} from '../src/retrieval/activation';

/** In-memory reader over a fixed edge list; everything live unless listed dead. */
function makeReader(edges: SpreadEdgeRow[], dead: string[] = []): SpreadReader {
  const deadSet = new Set(dead);
  return {
    edgesTouching(ids) {
      const s = new Set(ids);
      return edges.filter(e => s.has(e.src) || s.has(e.dst));
    },
    liveIds(ids) { return new Set(ids.filter(id => !deadSet.has(id))); },
  };
}
const rel = (src: string, dst: string, rl = 'depends_on', kind = 'relation', w = 0.1): SpreadEdgeRow => ({ src, dst, rel: rl, kind, w });

const P: SpreadParams = spreadParamsFromConfig({ ...DEFAULT_CONFIG, dbPath: ':memory:' } as never, 3);

describe('normalizeSeeds / prepareSeeds', () => {
  it('normalizes total seed mass to 1', () => {
    const s = normalizeSeeds(new Map([['a', 2], ['b', 2]]));
    expect(s.get('a')).toBeCloseTo(0.5);
  });
  it('weights by score, penalizes support fan, down-weights docs, then normalizes', () => {
    const s = prepareSeeds(
      [{ id: 'a', score: 0.8 }, { id: 'b', score: 0.8 }, { id: 'd', score: 0.8, type: 'doc' }],
      new Map([['b', 4]]),   // b is supported by 4 episodes → specificity 1/4; a and d are orphans → 1
      0.05,
    );
    expect(s.get('a')! / s.get('b')!).toBeCloseTo(4);
    expect(s.get('a')! / s.get('d')!).toBeCloseTo(1 / 0.05);
    let sum = 0; for (const v of s.values()) sum += v;
    expect(sum).toBeCloseTo(1);
  });
});

describe('spreadActivation', () => {
  it('returns empty when hops=0 or no seeds', () => {
    expect(spreadActivation(makeReader([rel('a', 'b')]), new Map(), P).size).toBe(0);
    expect(spreadActivation(makeReader([rel('a', 'b')]), new Map([['a', 1]]), { ...P, hops: 0 }).size).toBe(0);
  });

  it('reaches a 2-hop terminal with a correct provenance path and decaying activation', () => {
    const r = makeReader([rel('A', 'B'), rel('B', 'C')]);
    const out = spreadActivation(r, new Map([['A', 1]]), P);
    const b = out.get('B')!; const c = out.get('C')!;
    expect(b.activation).toBeCloseTo(0.5);        // 1 × damping, single eligible edge = full share
    expect(c.activation).toBeCloseTo(0.25);       // second hop halves again
    expect(c.hopDepth).toBe(2);
    expect(c.paths[0]).toEqual([{ src: 'A', rel: 'depends_on', dst: 'B', dir: 'fwd' }, { src: 'B', rel: 'depends_on', dst: 'C', dir: 'fwd' }]);
    expect(out.has('A')).toBe(false);             // seeds are never in the output
  });

  it('accumulates convergent evidence from two seeds and keeps both paths', () => {
    const r = makeReader([rel('S1', 'X'), rel('S2', 'X')]);
    const one = spreadActivation(r, new Map([['S1', 1]]), P).get('X')!;
    const two = spreadActivation(r, new Map([['S1', 1], ['S2', 1]]), P).get('X')!;
    expect(two.activation).toBeCloseTo(one.activation); // seed mass is normalized: 2×(0.5×0.5) = 0.5
    expect(two.paths.length).toBe(2);
    const r3 = makeReader([rel('S1', 'X'), rel('S1', 'Y')]);
    const split = spreadActivation(r3, new Map([['S1', 1]]), P).get('X')!;
    expect(two.activation).toBeGreaterThan(split.activation); // convergence beats fan-out
  });

  it('row-normalizes: a hub splits its mass across its fan', () => {
    const edges = [rel('S', 'H'), rel('S', 'Q'), rel('Q', 'Qn')];
    for (let i = 0; i < 20; i++) edges.push(rel('H', `Hn${i}`));
    const out = spreadActivation(makeReader(edges), new Map([['S', 1]]), { ...P, activationFloor: 0 });
    expect(out.get('Qn')!.activation).toBeGreaterThan(out.get('Hn0')!.activation * 10);
  });

  it('traverses reverse edges at the rev weight and skips zero-weight kinds', () => {
    const r = makeReader([
      { src: 'B', dst: 'A', rel: 'uses', kind: 'relation', w: 0.1 },          // A reachable via rev (0.8)
      { src: 'A', dst: 'D', rel: 'doc_containment', kind: 'doc_containment', w: 0.1 },
    ]);
    const out = spreadActivation(r, new Map([['A', 1]]), { ...P, hops: 1 });
    expect(out.get('B')!.activation).toBeCloseTo(0.5);  // sole eligible edge → full damped share
    expect(out.get('B')!.paths[0]).toEqual([{ src: 'A', rel: 'uses', dst: 'B', dir: 'rev' }]); // walk order, stored B→A
    expect(out.has('D')).toBe(false);
  });

  it('never walks back along its own path (cycle guard) and never re-activates a seed', () => {
    const r = makeReader([rel('A', 'B'), rel('B', 'A'), rel('B', 'C'), rel('C', 'B')]);
    const out = spreadActivation(r, new Map([['A', 1]]), P);
    expect(out.has('A')).toBe(false);
    // B's mass at hop 2 must not have bounced A→B→A→B; C exists via A→B→C only
    expect(out.get('C')!.paths[0]).toEqual([{ src: 'A', rel: 'depends_on', dst: 'B', dir: 'fwd' }, { src: 'B', rel: 'depends_on', dst: 'C', dir: 'fwd' }]);
  });

  it('drops sub-floor transfers and prunes the frontier after aggregation', () => {
    const edges: SpreadEdgeRow[] = [];
    for (let i = 0; i < 100; i++) edges.push(rel('S', `n${i}`));   // each share = 0.5/100 = 0.005 < floor
    const out = spreadActivation(makeReader(edges), new Map([['S', 1]]), P);
    expect(out.size).toBe(0);
    const capped = spreadActivation(makeReader(edges), new Map([['S', 1]]), { ...P, activationFloor: 0.001, frontierCap: 10 });
    expect(capped.size).toBe(100);                                  // all get booked (floor passes)…
    // …but only 10 propagate further; with no second-hop edges this just checks the cap didn't crash
  });

  it('skips tombstoned targets and is deterministic', () => {
    const r = makeReader([rel('A', 'B'), rel('A', 'Z')], ['Z']);
    const out = spreadActivation(r, new Map([['A', 1]]), P);
    expect(out.has('Z')).toBe(false);
    const a = JSON.stringify([...spreadActivation(r, new Map([['A', 1]]), P).entries()]);
    const b = JSON.stringify([...spreadActivation(r, new Map([['A', 1]]), P).entries()]);
    expect(a).toBe(b);
  });
});
