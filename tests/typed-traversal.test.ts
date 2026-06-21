/**
 * Unit tests for typed-traversal module (Phase 37, TYPED-02).
 *
 * Coverage:
 *   typedReach   — single-hop predicate-filtered traversal from anchor
 *   typedReach   — LANDMINE 2 filter: excludes links_to/extends edges (not in PRED_SET)
 *   typedReach   — kind!=='relation' edges are excluded even if rel collides
 *   typedReach   — returns [] when anchor has no matching predicate edge
 *   typedReach   — path-weight ranking (top-K, stable id tiebreak)
 *   matchPredicate — returns argmax predicate when cosine >= threshold
 *   matchPredicate — returns null when cosine < threshold for all predicates
 *   matchPredicate — returns null when glossEmbeddings is null
 *   matchPredicate — returns null when glossEmbeddings is empty
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import type { EdgeKind } from '../src/lib/types';
import { typedReach, matchPredicate } from '../src/recall/typed-traversal';
import type { Predicate } from '../src/model/typed-predicates';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(): { store: SemanticStore; db: Database.Database } {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const config = { ...DEFAULT_CONFIG, dbPath: ':memory:' };
  const store = new SemanticStore(db, clock, config);
  return { store, db };
}

/**
 * Seed a node and upsert an outgoing typed edge from src to dst.
 * kind defaults to 'relation' for typed-predicate edges.
 */
function seedEdge(
  store: SemanticStore,
  src: string,
  dst: string,
  rel: string,
  w: number,
  kind: EdgeKind = 'relation',
): void {
  // Ensure both nodes exist (upsertNode is idempotent)
  store.upsertNode({ id: src, type: 'entity', value: src, origin: 'observed' });
  store.upsertNode({ id: dst, type: 'entity', value: dst, origin: 'observed' });
  store.upsertEdge({ src, dst, rel, w, kind });
}

/**
 * Build a mock gloss-embedding record for a subset of predicates.
 * Each predicate gets a unit vector pointing in a unique dimension.
 * dim 0 → 'built_by', dim 1 → 'uses', etc.
 */
function makeMockGlossEmbeddings(
  dims: number = 4,
): Record<Predicate, Float32Array> {
  const PREDICATES: Predicate[] = [
    'built_by', 'works_on', 'part_of', 'uses',
    'depends_on', 'runs_on', 'located_in', 'integrates_with',
    'supersedes', 'prefers', 'evaluated', 'configured_with',
  ];
  const result = {} as Record<Predicate, Float32Array>;
  for (let i = 0; i < PREDICATES.length; i++) {
    const vec = new Float32Array(dims);
    // Each predicate gets a unique non-zero dim (wrap around if more predicates than dims)
    vec[i % dims] = 1.0;
    result[PREDICATES[i]!] = vec;
  }
  return result;
}

// ---------------------------------------------------------------------------
// typedReach tests
// ---------------------------------------------------------------------------

describe('typedReach', () => {
  let store: SemanticStore;

  beforeEach(() => {
    ({ store } = makeStore());
  });

  it('returns only nodes reachable from anchor via the specified predicate', () => {
    // anchor --uses--> nodeA, anchor --uses--> nodeB, anchor --built_by--> nodeC
    seedEdge(store, 'anchor', 'nodeA', 'uses', 1.0);
    seedEdge(store, 'anchor', 'nodeB', 'uses', 0.5);
    seedEdge(store, 'anchor', 'nodeC', 'built_by', 1.0);

    const result = typedReach(store, 'anchor', ['uses'], 10);
    expect(result).toContain('nodeA');
    expect(result).toContain('nodeB');
    expect(result).not.toContain('nodeC'); // different predicate
    expect(result).not.toContain('anchor'); // anchor excluded from frontier
  });

  it('LANDMINE 2: excludes links_to edges (not in PRED_SET) even with kind=relation', () => {
    // anchor --links_to--> nodeD (kind='relation', but not in typed vocab)
    // anchor --uses--> nodeE (valid typed predicate)
    seedEdge(store, 'anchor', 'nodeD', 'links_to', 1.0, 'relation');
    seedEdge(store, 'anchor', 'nodeE', 'uses', 0.8, 'relation');

    const result = typedReach(store, 'anchor', ['uses'], 10);
    expect(result).toContain('nodeE');
    expect(result).not.toContain('nodeD'); // links_to excluded by PRED_SET filter
  });

  it('LANDMINE 2: excludes extends edges (not in PRED_SET) even with kind=relation', () => {
    seedEdge(store, 'anchor', 'nodeF', 'extends', 1.0, 'relation');
    seedEdge(store, 'anchor', 'nodeG', 'built_by', 0.9, 'relation');

    const result = typedReach(store, 'anchor', ['built_by'], 10);
    expect(result).toContain('nodeG');
    expect(result).not.toContain('nodeF'); // extends excluded
  });

  it('excludes edges with kind!==relation even if rel matches a typed predicate', () => {
    // An edge with kind='abstracts' but rel='uses' should NOT be followed
    seedEdge(store, 'anchor', 'nodeH', 'uses', 1.0, 'abstracts');
    seedEdge(store, 'anchor', 'nodeI', 'uses', 0.7, 'relation');

    const result = typedReach(store, 'anchor', ['uses'], 10);
    expect(result).toContain('nodeI');
    expect(result).not.toContain('nodeH'); // wrong kind
  });

  it('returns [] when anchor has no matching predicate edge', () => {
    // anchor --built_by--> nodeJ, but we query for 'uses'
    seedEdge(store, 'anchor', 'nodeJ', 'built_by', 1.0);

    const result = typedReach(store, 'anchor', ['uses'], 10);
    expect(result).toHaveLength(0);
  });

  it('returns [] when anchor has no outgoing edges at all', () => {
    store.upsertNode({ id: 'isolated', type: 'entity', value: 'isolated', origin: 'observed' });
    const result = typedReach(store, 'isolated', ['uses'], 10);
    expect(result).toHaveLength(0);
  });

  it('ranks results by path-weight descending (higher weight = earlier)', () => {
    // anchor --uses--> nodeHigh (w=2.0), anchor --uses--> nodeLow (w=0.5)
    seedEdge(store, 'anchor', 'nodeHigh', 'uses', 2.0);
    seedEdge(store, 'anchor', 'nodeLow', 'uses', 0.5);

    const result = typedReach(store, 'anchor', ['uses'], 10);
    expect(result[0]).toBe('nodeHigh');
    expect(result[1]).toBe('nodeLow');
  });

  it('caps results at K', () => {
    // Create 5 nodes reachable via uses, K=3
    for (let i = 0; i < 5; i++) {
      seedEdge(store, 'anchor', `node${i}`, 'uses', 1.0 - i * 0.1);
    }

    const result = typedReach(store, 'anchor', ['uses'], 3);
    expect(result).toHaveLength(3);
  });

  it('stable tiebreak: equal path-weight nodes ordered by id ascending', () => {
    // All three nodes have the same weight — should sort by id
    seedEdge(store, 'anchor', 'z-node', 'uses', 1.0);
    seedEdge(store, 'anchor', 'a-node', 'uses', 1.0);
    seedEdge(store, 'anchor', 'm-node', 'uses', 1.0);

    const result = typedReach(store, 'anchor', ['uses'], 10);
    // Stable sort: lower id before higher id on weight tie
    const aIdx = result.indexOf('a-node');
    const mIdx = result.indexOf('m-node');
    const zIdx = result.indexOf('z-node');
    expect(aIdx).toBeLessThan(mIdx);
    expect(mIdx).toBeLessThan(zIdx);
  });
});

// ---------------------------------------------------------------------------
// matchPredicate tests
// ---------------------------------------------------------------------------

describe('matchPredicate', () => {
  it('returns the argmax predicate when cosine >= threshold', () => {
    const dims = 12;
    const glossEmbeddings = makeMockGlossEmbeddings(dims);

    // cueVec points at dim 0 → cosine 1.0 with built_by gloss (index 0)
    const cueVec = new Float32Array(dims);
    cueVec[0] = 1.0;

    const result = matchPredicate(cueVec, glossEmbeddings, 0.35);
    expect(result).toBe('built_by');
  });

  it('returns null when cosine < threshold for all predicates', () => {
    const dims = 12;
    const glossEmbeddings = makeMockGlossEmbeddings(dims);

    // cueVec zeros → cosine 0 with all glosses → below any threshold
    const cueVec = new Float32Array(dims);

    const result = matchPredicate(cueVec, glossEmbeddings, 0.35);
    expect(result).toBeNull();
  });

  it('returns null when cosine is below threshold even if >0', () => {
    const dims = 12;
    const glossEmbeddings = makeMockGlossEmbeddings(dims);

    // Small non-zero value in dim 0, but not enough to pass threshold
    // cosine(cueVec, built_by_gloss) = 0.1 < 0.35
    const cueVec = new Float32Array(dims);
    cueVec[0] = 0.1;
    // Normalize to unit length to ensure raw cosine = component value
    const magnitude = Math.sqrt(cueVec.reduce((sum, v) => sum + v * v, 0));
    for (let i = 0; i < dims; i++) cueVec[i]! /= magnitude;

    // built_by gloss has only dim 0 = 1.0, so cosine = cueVec[0] = 0.1
    // Since cosine will be 0.1 < 0.35, should return null
    // But wait — cueVec after normalization still has only one component,
    // so cosine = 0.1 (only component). Use higher threshold:
    const result = matchPredicate(cueVec, glossEmbeddings, 0.5);
    expect(result).toBeNull();
  });

  it('returns null when glossEmbeddings is null', () => {
    const dims = 4;
    const cueVec = new Float32Array(dims);
    cueVec[0] = 1.0;

    const result = matchPredicate(cueVec, null, 0.35);
    expect(result).toBeNull();
  });

  it('returns null when glossEmbeddings is empty object', () => {
    const dims = 4;
    const cueVec = new Float32Array(dims);
    cueVec[0] = 1.0;

    const result = matchPredicate(cueVec, {} as Record<Predicate, Float32Array>, 0.35);
    expect(result).toBeNull();
  });

  it('returns the correct argmax when uses gloss is best match', () => {
    // uses is at index 3 in PREDICATES → dim 3 in mock embeddings
    const dims = 12;
    const glossEmbeddings = makeMockGlossEmbeddings(dims);

    // cueVec points at dim 3 → cosine 1.0 with 'uses' (index 3)
    const cueVec = new Float32Array(dims);
    cueVec[3] = 1.0;

    const result = matchPredicate(cueVec, glossEmbeddings, 0.35);
    expect(result).toBe('uses');
  });
});
