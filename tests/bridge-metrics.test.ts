import { describe, it, expect } from 'vitest';
import { scoreProbe, aggregate, percentile } from '../src/eval/bridge-metrics';

const edges = { has: (s: string, r: string, d: string) => `${s}|${r}|${d}` === 'seed|uses|bridge' || `${s}|${r}|${d}` === 'bridge|extends|term' };

describe('scoreProbe', () => {
  it('scores recall@k, MRR and bridge hit from a ranked list', () => {
    const s = scoreProbe(
      { rankedIds: ['x', 'bridge', 'y', 'term'], nodesExpanded: 12, latencyMs: 3 },
      'term', 'bridge', edges,
    );
    expect(s.terminal_at_5).toBe(1);
    expect(s.terminal_at_10).toBe(1);
    expect(s.bridge_at_10).toBe(1);
    expect(s.reciprocal_rank).toBeCloseTo(0.25);
    expect(s.path_valid).toBeNull();
  });
  it('gives zero recall and rr when the terminal is absent', () => {
    const s = scoreProbe({ rankedIds: ['a', 'b'], nodesExpanded: 2, latencyMs: 1 }, 'term', 'bridge', edges);
    expect(s.terminal_at_20).toBe(0);
    expect(s.reciprocal_rank).toBe(0);
    expect(s.bridge_at_10).toBe(0);
  });
  it('verifies a returned path against real edges', () => {
    const good = new Map([['term', [{ src: 'seed', rel: 'uses', dst: 'bridge' }, { src: 'bridge', rel: 'extends', dst: 'term' }]]]);
    const bad = new Map([['term', [{ src: 'seed', rel: 'uses', dst: 'term' }]]]);
    expect(scoreProbe({ rankedIds: ['term'], paths: good, nodesExpanded: 1, latencyMs: 1 }, 'term', 'bridge', edges).path_valid).toBe(true);
    expect(scoreProbe({ rankedIds: ['term'], paths: bad, nodesExpanded: 1, latencyMs: 1 }, 'term', 'bridge', edges).path_valid).toBe(false);
  });
  it('honors walk direction: a rev step is valid when the stored edge runs dst→src', () => {
    // walked term ← bridge ← seed, i.e. against both stored edges
    const rev = new Map([['seed', [{ src: 'term', rel: 'extends', dst: 'bridge', dir: 'rev' as const }, { src: 'bridge', rel: 'uses', dst: 'seed', dir: 'rev' as const }]]]);
    const wrongDir = new Map([['seed', [{ src: 'term', rel: 'extends', dst: 'bridge', dir: 'fwd' as const }]]]);
    expect(scoreProbe({ rankedIds: ['seed'], paths: rev, nodesExpanded: 1, latencyMs: 1 }, 'seed', 'bridge', edges).path_valid).toBe(true);
    expect(scoreProbe({ rankedIds: ['seed'], paths: wrongDir, nodesExpanded: 1, latencyMs: 1 }, 'seed', 'bridge', edges).path_valid).toBe(false);
  });
});

describe('aggregate / percentile', () => {
  it('averages hit flags and rr, and reports latency percentiles', () => {
    const base = { bridge_at_10: 0 as const, path_valid: null, nodes_expanded: 10 };
    const a = aggregate([
      { ...base, terminal_at_5: 1, terminal_at_10: 1, terminal_at_20: 1, reciprocal_rank: 1, latency_ms: 10 },
      { ...base, terminal_at_5: 0, terminal_at_10: 1, terminal_at_20: 1, reciprocal_rank: 0.1, latency_ms: 30 },
    ]);
    expect(a.n).toBe(2);
    expect(a.r5).toBe(0.5);
    expect(a.r10).toBe(1);
    expect(a.mrr).toBeCloseTo(0.55);
    expect(a.path_valid_rate).toBeNull();
    expect(a.latency_p50).toBe(10);
    expect(a.latency_p95).toBe(30);
  });
  it('percentile uses nearest-rank on a sorted copy', () => {
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([], 50)).toBe(0);
  });
});
