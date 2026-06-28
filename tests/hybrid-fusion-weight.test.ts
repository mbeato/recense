/**
 * Phase 47 Plan 01 regression tests: bm25FusionWeight isolation + doc-gather preservation.
 *
 * Tests:
 *  A. Isolation (D-02 gate): retrieveRanked with bm25FusionWeight=0 returns byte-identical
 *     ordered ids to the pure-cosine topk path — BM25 contributes nothing when w=0.
 *  B. Param-default preservation: hybridTopk(vec, text, k) with NO bm25FusionWeight arg
 *     behaves identically to hybridTopk(vec, text, k, ..., 1) — doc-gather callers unaffected.
 *  C. Knob is live: hybridTopk(..., w=0) vs hybridTopk(..., w=1) produce different orderings
 *     when BM25 and cosine rankings diverge, proving the weight actually flows into rrfFuse.
 *
 * Brain setup (4 nodes, dim=16, queryVec=basisVec(0), queryText="salmon"):
 *   nodeA: basisVec(0) → cosine=1.0, NO BM25 match for "salmon"
 *   nodeB: mixedVec(0.8, 0.6) → cosine=0.8, NO BM25 match for "salmon"
 *   nodeC: basisVec(1) → cosine=0.0, BM25 match for "salmon" (rank 0 or 1 in BM25)
 *   nodeD: basisVec(2) → cosine=0.0, BM25 match for "salmon" (rank 0 or 1 in BM25)
 *
 * RRF math (k=60, fusion k_topk=2, cosine ranks: A=0,B=1,C=2,D=3):
 *   w=0: scores = {A:1/61, B:1/62, C:1/63, D:1/64} → top-2 = [nodeA, nodeB] (cosine order)
 *   w=1: nodeC/D each gain ≥1/62 from BM25, surpassing nodeA(1/61) → top-2 = {nodeC, nodeD}
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { CandidateRetriever } from '../src/retrieval/topk';
import { RetrievalEngine } from '../src/retrieval/engine';
import { StrengthDecayManager } from '../src/strength/decay';
import { AllocationGate } from '../src/gate/allocation-gate';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Return the i-th 16-dim standard-basis unit vector. */
function basisVec(i: number, dims = 16): Float32Array {
  const v = new Float32Array(dims);
  v[i % dims] = 1.0;
  return v;
}

/**
 * Unit vector with components at dims 0 and 1.
 * cosine(mixedVec(a, b), basisVec(0)) = a  (when a²+b²=1).
 */
function mixedVec(a: number, b: number, dims = 16): Float32Array {
  const v = new Float32Array(dims);
  v[0] = a;
  v[1] = b;
  return v;
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('bm25FusionWeight isolation + doc-gather preservation (Phase 47 D-02)', () => {
  let db: Database.Database;
  let store: SemanticStore;
  let retriever: CandidateRetriever;
  let engine: RetrievalEngine;

  /** Query vector aligned with nodeA (cosine=1) and nodeB (cosine=0.8), orthogonal to nodeC/D. */
  const QUERY_VEC = basisVec(0);
  /** Query text that lexically matches nodeC and nodeD but NOT nodeA/nodeB. */
  const QUERY_TEXT = 'salmon';
  const K = 2;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const config: EngineConfig = {
      ...DEFAULT_CONFIG,
      dbPath: ':memory:',
      embeddingDimensions: 16,
      bm25FusionWeight: 0,  // explicit dark default — matches DEFAULT_CONFIG
    };

    store = new SemanticStore(db, clock, config);
    retriever = new CandidateRetriever(db);
    const strength = new StrengthDecayManager(db, clock, config);
    const gate = new AllocationGate(config);
    engine = new RetrievalEngine(db, clock, config, retriever, store, strength, gate);

    // Seed: nodeA and nodeB have high cosine, no BM25 match for "salmon"
    store.upsertNode({ id: 'nodeA', type: 'fact', value: 'facts about france', origin: 'observed' });
    store.setEmbedding('nodeA', basisVec(0));        // cosine = 1.0

    store.upsertNode({ id: 'nodeB', type: 'fact', value: 'history of europe', origin: 'observed' });
    store.setEmbedding('nodeB', mixedVec(0.8, 0.6)); // cosine = 0.8

    // Seed: nodeC and nodeD have zero cosine but strong BM25 match for "salmon"
    store.upsertNode({ id: 'nodeC', type: 'fact', value: 'salmon fishing in alaska', origin: 'observed' });
    store.setEmbedding('nodeC', basisVec(1));         // cosine = 0.0

    store.upsertNode({ id: 'nodeD', type: 'fact', value: 'salmon recipe with herbs', origin: 'observed' });
    store.setEmbedding('nodeD', basisVec(2));         // cosine = 0.0
  });

  afterEach(() => { db.close(); });

  // ── Test A: byte-identical w=0 isolation (D-02 gate) ─────────────────────

  it('A — w=0: retrieveRanked ids deep-equal pure-cosine topk order', () => {
    // Pure cosine baseline (no queryText, no fusion)
    const pureIds = retriever.topk(QUERY_VEC, K).map(r => r.id);
    // Sanity: cosine order must be [nodeA, nodeB]
    expect(pureIds).toEqual(['nodeA', 'nodeB']);

    // Engine hybrid path with bm25FusionWeight=0 (config dark default):
    // even though queryText is supplied (→ hybridTopk), BM25 weight=0 nulls lexical contribution.
    // RRF with weights=[1,0] preserves cosine rank order → same top-2 as pure topk.
    const hybridIds = engine.retrieveRanked(QUERY_VEC, K, 0, QUERY_TEXT).map(r => r.id);

    expect(hybridIds).toEqual(pureIds);
  });

  // ── Test B: param-default-1 preservation (doc-gather unaffected) ─────────

  it('B — omitted bm25FusionWeight equals explicit =1 (doc-gather callers unchanged)', () => {
    // 3-arg call as existing doc-gather callers invoke it (no bm25FusionWeight passed):
    // bm25FusionWeight defaults to 1 → BM25 at full weight.
    const omittedIds = retriever.hybridTopk(QUERY_VEC, QUERY_TEXT, K).map(r => r.id);

    // Explicit bm25FusionWeight=1: must be byte-identical
    const explicit1Ids = retriever.hybridTopk(
      QUERY_VEC, QUERY_TEXT, K,
      undefined, 0, undefined, undefined, 1,
    ).map(r => r.id);

    expect(omittedIds).toEqual(explicit1Ids);
  });

  // ── Test C: knob is live (w=0 ≠ w=1 when rankings diverge) ─────────────

  it('C — w=0 and w=1 differ: BM25 matches float above cosine leaders when w=1', () => {
    // w=0 → BM25 contributes nothing → pure cosine order
    const w0Ids = retriever.hybridTopk(
      QUERY_VEC, QUERY_TEXT, K,
      undefined, 0, undefined, undefined, 0,
    ).map(r => r.id);

    // w=1 → BM25 boosts nodeC and nodeD above nodeA and nodeB
    const w1Ids = retriever.hybridTopk(
      QUERY_VEC, QUERY_TEXT, K,
      undefined, 0, undefined, undefined, 1,
    ).map(r => r.id);

    // w=0 must return the cosine leaders
    expect(w0Ids).toEqual(['nodeA', 'nodeB']);

    // w=1 must elevate the BM25 matches (nodeC and nodeD), not the cosine leaders.
    // RRF math: nodeC/D each accumulate ≥1/61(cosine) + 1/62(BM25) ≈ 0.0325 >
    //            nodeA's 1/61 ≈ 0.0164, so both BM25 matches beat both cosine leaders.
    expect(new Set(w1Ids)).toEqual(new Set(['nodeC', 'nodeD']));

    // The two results must differ (proves the weight is wired, not dead)
    expect(w0Ids).not.toEqual(w1Ids);
  });
});
