/**
 * tests/honest-trace.test.ts
 *
 * Behavior guards for the Phase-56 extraction of the honest 1-hop filter
 * (src/retrieval/honest-trace.ts) — the single shared helper both engine
 * ambient recall (Phase 55) and the future spontaneous emitter (Phase 56-02)
 * must import so the filter can never drift between the two callers (D-07).
 *
 * A fake in-memory HonestTraceReader stands in for SemanticStore so these
 * tests exercise buildHonestOneHopTrace as a pure function with zero DB.
 */

import { describe, it, expect } from 'vitest';
import { buildHonestOneHopTrace, projectHopsForSink, type HonestTraceReader } from '../src/retrieval/honest-trace';

type FakeEdge = { dst: string; rel: string; w: number; kind: string };

function makeFakeReader(
  edgesBySrc: Record<string, FakeEdge[]>,
  tombstoned: Set<string> = new Set(),
): HonestTraceReader {
  return {
    getOutEdgesWithRel(id: string) {
      return edgesBySrc[id] ?? [];
    },
    getNode(id: string) {
      return { tombstoned: tombstoned.has(id) ? 1 : 0 };
    },
  };
}

describe('buildHonestOneHopTrace', () => {
  it('returns exactly the top-N by weight, truncating the rest', () => {
    const edges: FakeEdge[] = [
      { dst: 'r1', rel: 'uses', w: 0.90, kind: 'relation' },
      { dst: 'r2', rel: 'uses', w: 0.85, kind: 'relation' },
      { dst: 'r3', rel: 'uses', w: 0.80, kind: 'relation' },
      { dst: 'r4', rel: 'uses', w: 0.75, kind: 'relation' },
      { dst: 'r5', rel: 'uses', w: 0.70, kind: 'relation' },
      { dst: 'r6', rel: 'uses', w: 0.65, kind: 'relation' },
      { dst: 'r7', rel: 'uses', w: 0.60, kind: 'relation' },
      { dst: 'r8', rel: 'uses', w: 0.55, kind: 'relation' },
    ];
    const reader = makeFakeReader({ seed: edges });
    const result = buildHonestOneHopTrace([{ node_id: 'seed', score: 0.9 }], reader, 6);

    expect(result.hops).toHaveLength(6);
    expect(result.hops.map(h => h.node_id).sort()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    expect(result.seeds).toEqual([{ node_id: 'seed', score: 0.9 }]);
  });

  it('skips a tombstoned dst BEFORE its slot is filled — never displaces a live edge', () => {
    const edges: FakeEdge[] = [
      { dst: 'dead', rel: 'uses', w: 0.99, kind: 'relation' }, // highest weight, tombstoned
      { dst: 'r1', rel: 'uses', w: 0.90, kind: 'relation' },
      { dst: 'r2', rel: 'uses', w: 0.85, kind: 'relation' },
    ];
    const reader = makeFakeReader({ seed: edges }, new Set(['dead']));
    const result = buildHonestOneHopTrace([{ node_id: 'seed', score: 0.9 }], reader, 2);

    expect(result.hops.map(h => h.node_id).sort()).toEqual(['r1', 'r2']);
  });

  it('excludes edges with kind !== "relation" OR rel not in PRED_SET', () => {
    const edges: FakeEdge[] = [
      { dst: 'abs1', rel: 'abstracts', w: 0.99, kind: 'abstracts' }, // wrong kind
      { dst: 'ext1', rel: 'extends', w: 0.98, kind: 'relation' },    // structural, not PRED_SET
      { dst: 'link1', rel: 'links_to', w: 0.97, kind: 'relation' },  // structural, not PRED_SET
      { dst: 'r1', rel: 'uses', w: 0.5, kind: 'relation' },          // genuine semantic predicate
    ];
    const reader = makeFakeReader({ seed: edges });
    const result = buildHonestOneHopTrace([{ node_id: 'seed', score: 0.9 }], reader, 6);

    expect(result.hops.map(h => h.node_id)).toEqual(['r1']);
  });

  it('every hop is { node_id, src: seedId, rel, score: null, hop: 1 }; seeds passthrough unchanged', () => {
    const edges: FakeEdge[] = [{ dst: 'r1', rel: 'uses', w: 0.5, kind: 'relation' }];
    const reader = makeFakeReader({ seed: edges });
    const seeds = [{ node_id: 'seed', score: 0.42 }];
    const result = buildHonestOneHopTrace(seeds, reader, 6);

    expect(result.seeds).toBe(seeds);
    expect(result.hops).toEqual([{ node_id: 'r1', src: 'seed', rel: 'uses', score: null, hop: 1 }]);
  });

  it('a hop carries the `rel` of the real out-edge that produced it (Phase 69 RECALL-03)', () => {
    const edges: FakeEdge[] = [
      { dst: 'r1', rel: 'built_by', w: 0.9, kind: 'relation' },
      { dst: 'r2', rel: 'depends_on', w: 0.5, kind: 'relation' },
    ];
    const reader = makeFakeReader({ seed: edges });
    const result = buildHonestOneHopTrace([{ node_id: 'seed', score: 0.9 }], reader, 6);

    const byDst = new Map(result.hops.map(h => [h.node_id, h.rel]));
    expect(byDst.get('r1')).toBe('built_by');
    expect(byDst.get('r2')).toBe('depends_on');
  });

  it('projectHopsForSink strips `rel` back to the pre-phase 4-key shape (D-06)', () => {
    const edges: FakeEdge[] = [{ dst: 'r1', rel: 'uses', w: 0.5, kind: 'relation' }];
    const reader = makeFakeReader({ seed: edges });
    const result = buildHonestOneHopTrace([{ node_id: 'seed', score: 0.9 }], reader, 6);
    const projected = projectHopsForSink(result.hops);

    // D-06: the viz sink keeps receiving exactly what it receives today — assert the
    // pre-phase key set, not just absence of `rel`, so an unrelated future key addition
    // would also fail this lock.
    for (const hop of projected) {
      expect(Object.keys(hop).sort()).toEqual(['hop', 'node_id', 'score', 'src']);
    }
    expect(projected).toEqual([{ node_id: 'r1', src: 'seed', score: null, hop: 1 }]);
  });

  it('resolves equal-weight edges deterministically by dst id ascending (D-03)', () => {
    const edges: FakeEdge[] = [
      { dst: 'zzz', rel: 'uses', w: 0.5, kind: 'relation' },
      { dst: 'aaa', rel: 'uses', w: 0.5, kind: 'relation' },
      { dst: 'mmm', rel: 'uses', w: 0.5, kind: 'relation' },
    ];
    const reader = makeFakeReader({ seed: edges });
    const result = buildHonestOneHopTrace([{ node_id: 'seed', score: 0.9 }], reader, 6);

    expect(result.hops.map(h => h.node_id)).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('de-dups on the (src, dst) pair', () => {
    const edges: FakeEdge[] = [
      { dst: 'r1', rel: 'uses', w: 0.9, kind: 'relation' },
      { dst: 'r1', rel: 'depends_on', w: 0.8, kind: 'relation' }, // same dst, different rel
    ];
    const reader = makeFakeReader({ seed: edges });
    const result = buildHonestOneHopTrace([{ node_id: 'seed', score: 0.9 }], reader, 6);

    expect(result.hops).toHaveLength(1);
    expect(result.hops[0]!.node_id).toBe('r1');
  });
});
