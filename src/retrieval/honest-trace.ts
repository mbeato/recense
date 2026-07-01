/**
 * honest-trace.ts — the single shared honest 1-hop trace builder (Phase 56 extraction).
 *
 * Extracted verbatim from Phase-55 `RetrievalEngine.buildAmbientTracePayload` (engine.ts) so
 * that ONE pure, dependency-injected function is the source of truth for the honest 1-hop
 * filter — both engine ambient recall and the Phase-56 spontaneous emitter import this
 * function, so the filter can never drift between the two callers when PRED_SET / edge-kind
 * rules change (D-07 correctness spine).
 *
 * For each seed, reads its REAL out-edges and keeps only genuine SEMANTIC association edges —
 * `kind === 'relation' && PRED_SET.has(rel)` — the same LANDMINE-2 filter typed-traversal.ts
 * uses. This excludes doc-graph kinds (doc_link etc.) AND the structural relation-kind edges
 * `links_to` / `extends` that share kind='relation' but are NOT semantic associations
 * (structural `extends` schema edges alone are ~83% of kind='relation' edges, so without the
 * PRED_SET half they would dominate the rendered pathways with non-association structure).
 * Sorts by weight desc with a deterministic dst-asc tiebreak (D-03), then walks in weight order
 * taking only live (non-tombstoned) dsts until `topN` are collected — liveness is checked
 * BEFORE a slot is filled (D-07, Pitfall 2: a dead high-weight edge is skipped, never displacing
 * a live one), and getNode is called lazily (bounded to ~top-N in the common case, not once per
 * out-edge). Hop scores are always null (WR-02, rank-only — no fabricated magnitude); seed
 * scores are passed through unchanged. Each hop carries `src` — the id of the ACTUAL seed whose
 * out-edge produced it: the (src→node_id) pair is a real relation edge in the graph, never a
 * guessed attribution. De-dups on the (src,dst) pair (an edge is unique per seed already; the
 * guard just protects against a src→dst appearing under two `rel`s).
 *
 * Pure / side-effect-free: reads only through the injected reader — no writes, no DB open.
 */
import { PRED_SET } from '../model/typed-predicates';

/** Structural subset of SemanticStore this helper depends on (dependency injection). */
export interface HonestTraceReader {
  getOutEdgesWithRel(id: string): Array<{ dst: string; rel: string; w: number; kind: string }>;
  getNode(id: string): { tombstoned: number } | undefined;
}

export function buildHonestOneHopTrace(
  seeds: Array<{ node_id: string; score: number }>,
  reader: HonestTraceReader,
  topN: number,
): { seeds: Array<{ node_id: string; score: number }>; hops: Array<{ node_id: string; src: string; score: null; hop: 1 }> } {
  const hops: Array<{ node_id: string; src: string; score: null; hop: 1 }> = [];
  const seenPairs = new Set<string>();

  for (const seed of seeds) {
    // Cheap in-memory semantic-edge filter FIRST, then weight-sort; getNode (a DB read) is
    // deferred to the bounded walk below so a high-degree seed does ~topN reads, not one
    // per out-edge.
    const semanticEdges = reader.getOutEdgesWithRel(seed.node_id)
      .filter(e => e.kind === 'relation' && PRED_SET.has(e.rel))
      .sort((a, b) => (b.w - a.w) || (a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : 0));

    let taken = 0;
    for (const edge of semanticEdges) {
      if (taken >= topN) break;
      if (reader.getNode(edge.dst)?.tombstoned === 1) continue; // liveness before the slot (D-07)
      const pairKey = `${seed.node_id} ${edge.dst}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      taken++;
      hops.push({ node_id: edge.dst, src: seed.node_id, score: null, hop: 1 });
    }
  }

  return { seeds, hops };
}
