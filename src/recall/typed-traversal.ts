/**
 * Typed-path traversal module (Phase 37, TYPED-02).
 *
 * Two exports:
 *  - typedReach  — single-hop predicate-filtered traversal from an anchor node,
 *                  path-weight ranked, top-K capped, stable id tiebreak.
 *  - matchPredicate — LLM-free 12-way cosine of the already-computed query vec
 *                     against pre-loaded gloss embeddings; returns argmax predicate
 *                     iff cosine >= threshold, else null.
 *
 * Design invariants:
 *  - NEVER calls upsertNode/upsertEdge/tombstone/strengthen (D-08 hard invariant).
 *  - ALWAYS uses store.getOutEdgesWithRel (LANDMINE 1 fix) — getOutEdges omits rel.
 *  - ALWAYS filters PRED_SET.has(e.rel) && e.kind === 'relation' (LANDMINE 2) before
 *    any predicate comparison — excludes links_to / extends edges that share kind='relation'
 *    but are NOT typed predicates.
 *  - v1: callers pass a single-element predicatePath (D-07; multi-hop deferred per CONTEXT.md).
 *
 * Port of spike 004 lib/traverse.ts (typedReach), parameterized over live SemanticStore
 * instead of the spike's inline db.prepare('SELECT dst, rel, w').
 */
import { PRED_SET } from '../model/typed-predicates';
import type { Predicate } from '../model/typed-predicates';
import type { SemanticStore } from '../db/semantic-store';

/**
 * Typed traversal: follow predicatePath hop by hop from anchor, keeping only edges
 * whose rel === path[hop] AND PRED_SET.has(rel) AND kind === 'relation'.
 *
 * Returns the top-K frontier node ids ranked by accumulated path-weight, with a
 * stable id tiebreak (ascending lexicographic) for deterministic output.
 *
 * Returns [] when:
 *  - the anchor has no matching typed predicate edge
 *  - predicatePath is empty
 *
 * LANDMINE 1: uses store.getOutEdgesWithRel, NOT store.getOutEdges (which omits rel).
 * LANDMINE 2: PRED_SET.has(e.rel) && e.kind === 'relation' filter applied before
 *             predicate comparison — links_to / extends share kind='relation' but
 *             are not typed predicates and must not be followed.
 *
 * @param store         - SemanticStore instance (uses getOutEdgesWithRel).
 * @param anchor        - Starting node id.
 * @param predicatePath - Ordered sequence of typed predicates to follow (v1: length 1).
 * @param K             - Maximum number of nodes to return.
 */
export function typedReach(
  store: SemanticStore,
  anchor: string,
  predicatePath: string[],
  K: number,
): string[] {
  if (predicatePath.length === 0 || K <= 0) return [];

  // best[node] = max accumulated path-weight reaching it along the typed path.
  // Identical to spike traverse.ts:46 but uses store.getOutEdgesWithRel instead
  // of the spike's inline SELECT.
  let frontier = new Map<string, number>([[anchor, 0]]);

  for (const pred of predicatePath) {
    const next = new Map<string, number>();
    for (const [node, acc] of frontier) {
      for (const e of store.getOutEdgesWithRel(node)) {
        // LANDMINE 2: exclude links_to / extends and any non-relation kind edges
        // before checking the predicate name (must precede the pred comparison).
        if (!PRED_SET.has(e.rel) || e.kind !== 'relation') continue;
        // predicate filter = the sole variable (D-06 typed-path control fairness)
        if (e.rel !== pred) continue;
        const score = acc + e.w;
        const prev = next.get(e.dst);
        if (prev === undefined || score > prev) next.set(e.dst, score);
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }

  // Sort: higher path-weight first; stable id tiebreak (ascending) for determinism.
  // Verbatim from spike traverse.ts:61.
  return [...frontier.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, K)
    .map(([id]) => id);
}

/**
 * LLM-free 12-way cosine predicate match.
 *
 * Computes cosine similarity between the already-embedded query cue vector and
 * each of the (up to 12) pre-loaded predicate gloss vectors using a plain
 * Float32Array dot-product loop (~12 × 1536 FLOPs — negligible online latency).
 *
 * Returns the argmax predicate iff its cosine >= threshold, else returns null.
 * Returns null when glossEmbeddings is null or has no entries (not yet embedded
 * → caller falls through to the existing schema-neighborhood path).
 *
 * No LLM call. No new embed call. Reuses the cueVec already computed by RecallEngine.
 *
 * @param cueVec          - The already-embedded query vec (Float32Array, e.g. 1536-dim).
 * @param glossEmbeddings - Pre-loaded record of predicate → gloss embedding, or null.
 * @param threshold       - Min cosine for confident predicate match (predicateGlossThreshold).
 */
export function matchPredicate(
  cueVec: Float32Array,
  glossEmbeddings: Record<Predicate, Float32Array> | null,
  threshold: number,
): Predicate | null {
  if (!glossEmbeddings) return null;

  const entries = Object.entries(glossEmbeddings) as Array<[Predicate, Float32Array]>;
  if (entries.length === 0) return null;

  let bestPredicate: Predicate | null = null;
  let bestCosine = -Infinity;

  for (const [pred, glossVec] of entries) {
    const cosine = cosineSimilarity(cueVec, glossVec);
    if (cosine > bestCosine) {
      bestCosine = cosine;
      bestPredicate = pred;
    }
  }

  if (bestPredicate === null || bestCosine < threshold) return null;
  return bestPredicate;
}

// ─── Internal helper ──────────────────────────────────────────────────────────

/**
 * Cosine similarity between two Float32Arrays of the same length.
 * Returns the dot product divided by the product of magnitudes.
 * Returns 0 if either vector is the zero vector (magnitude = 0).
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
