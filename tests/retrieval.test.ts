/**
 * RET-01: Cue-less ranked retrieval — non-tombstoned nodes sorted by effective_s,
 *         hard_keep pinned first, 1-hop spreading activation, token-budget cap.
 * RET-02: retrieve(queryVec) distinguishes 'ok', 'deleted', and 'unreachable'.
 *
 * Tests are written against RetrievalEngine behavior.
 * RED phase: engine.ts is a stub — tests fail as expected until Task 2 (GREEN).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { CandidateRetriever } from '../src/retrieval/topk';
import { StrengthDecayManager } from '../src/strength/decay';
import { AllocationGate } from '../src/gate/allocation-gate';
import { RetrievalEngine } from '../src/retrieval/engine';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';

const BASE_CONFIG = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

describe('RetrievalEngine', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let store: SemanticStore;
  let retriever: CandidateRetriever;
  let strength: StrengthDecayManager;
  let gate: AllocationGate;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    store = new SemanticStore(db, clock, BASE_CONFIG);
    retriever = new CandidateRetriever(db);
    strength = new StrengthDecayManager(db, clock, BASE_CONFIG);
    gate = new AllocationGate(BASE_CONFIG);
  });

  afterEach(() => { db.close(); });

  /** Construct a RetrievalEngine with the shared collaborators and given config. */
  function makeEngine(config = BASE_CONFIG): RetrievalEngine {
    return new RetrievalEngine(db, clock, config, retriever, store, strength, gate);
  }

  /** Insert a live (tombstoned=0) node with explicit strength. */
  function addNode(id: string, value: string, s: number = 0.5): void {
    store.upsertNode({ id, type: 'fact', value, origin: 'observed', s });
  }

  /** Insert a live node with an embedding attached. */
  function addEmbeddedNode(id: string, value: string, vec: Float32Array, s: number = 0.5): void {
    store.upsertNode({ id, type: 'fact', value, origin: 'observed', s });
    store.setEmbedding(id, vec);
  }

  /** Return the i-th 16-dim standard-basis unit vector. */
  function basisVec(i: number): Float32Array {
    const v = new Float32Array(16);
    v[i] = 1.0;
    return v;
  }

  // ─── RET-01: cue-less ranking and tombstone exclusion ────────────────────────

  describe('retrieveCueless() — ranking and tombstone exclusion (RET-01)', () => {
    it('returns only live (tombstoned=0) nodes sorted by effectiveStrength descending', () => {
      // All created at the same clock instant → effectiveStrength = s (no decay yet)
      addNode('high', 'high strength node', 0.9);
      addNode('mid', 'mid strength node', 0.5);
      addNode('low', 'low strength node', 0.1);
      // Tombstoned node with highest s value — must be excluded
      addNode('dead', 'tombstoned node value', 0.99);
      store.tombstone('dead');

      const result = makeEngine().retrieveCueless();

      expect(result.status).toBe('ok');
      const ids = result.results.map(r => r.id);
      expect(ids).not.toContain('dead');
      expect(ids).toContain('high');
      expect(ids).toContain('mid');
      expect(ids).toContain('low');

      // Scores must be non-increasing: high > mid > low
      const high = result.results.find(r => r.id === 'high')!;
      const mid = result.results.find(r => r.id === 'mid')!;
      const low = result.results.find(r => r.id === 'low')!;
      expect(high.score).toBeGreaterThan(mid.score);
      expect(mid.score).toBeGreaterThan(low.score);
    });
  });

  // ─── RET-01: hard_keep pinning ───────────────────────────────────────────────

  describe('hard_keep pinning (RET-01, D-24)', () => {
    it('pins a hard_keep node to index 0 regardless of its strength score', () => {
      // High-strength node with no directive pattern → not hard_keep
      addNode('strong', 'this is a random fact', 0.99);
      // Low-strength node matching "always" directive → hardKeep = true
      addNode('rule', 'always remember this important rule', 0.01);

      const result = makeEngine().retrieveCueless();

      // hard_keep node must be first, despite lowest strength
      expect(result.results[0]?.id).toBe('rule');
    });

    it('L-6: inferred-origin node is NOT hard-keep-pinned (subject to budget instead)', () => {
      // An inferred-origin node with directive vocabulary must NOT be unconditionally pinned.
      // It falls into the regular (budget-capped) bucket, stopping the C-2 amplification loop.
      store.upsertNode({
        id: 'inferred-directive',
        type: 'fact',
        value: 'always remember the user prefers TypeScript',
        origin: 'inferred',
        s: 0.01,
      });
      // An observed-origin node with the same directive vocabulary DOES pin.
      addNode('observed-directive', 'always remember the user prefers TypeScript', 0.01);
      // A non-directive observed node with high strength (to demonstrate budget behavior)
      addNode('strong', 'some random high-strength fact', 0.99);

      const result = makeEngine().retrieveCueless();

      // observed-directive pins to slot 0 (hard_keep, origin=observed)
      expect(result.results[0]?.id).toBe('observed-directive');
      // inferred-directive must NOT be in the hard_keep bucket — index > 0 and subject to budget
      const inferredIdx = result.results.findIndex(r => r.id === 'inferred-directive');
      expect(inferredIdx).toBeGreaterThan(0);
    });

    it('L-6 regression: observed-origin hard_keep node still pins', () => {
      // Guard against regressions: the fix must not affect observed-origin pinning.
      addNode('strong', 'some random fact', 0.99);
      addNode('observed-rule', 'always remember this rule', 0.01);

      const result = makeEngine().retrieveCueless();

      // observed-rule (hard_keep) must still be first
      expect(result.results[0]?.id).toBe('observed-rule');
    });
  });

  // ─── RET-01: token-budget cap ────────────────────────────────────────────────

  describe('injectionTokenBudget enforcement (RET-01, D-25)', () => {
    it('respects token budget for regular nodes; hard_keep included regardless', () => {
      // budget = 5 tokens = 20 chars
      const tightConfig = { ...BASE_CONFIG, injectionTokenBudget: 5 };
      // hard_keep node — value is 40 chars, exceeds entire budget; still must be included
      addNode('rule', 'always do exactly this. it is important!', 0.5);
      // Regular nodes with 8-char values each
      addNode('r1', '12345678', 0.8);
      addNode('r2', 'abcdefgh', 0.7);
      addNode('r3', 'ABCDEFGH', 0.6);

      const result = makeEngine(tightConfig).retrieveCueless();

      const ids = result.results.map(r => r.id);
      // hard_keep node must always be included
      expect(ids).toContain('rule');

      // Regular node total chars must stay within budget × 4 chars
      const regularChars = result.results
        .filter(r => r.id !== 'rule')
        .reduce((sum, r) => sum + r.value.length, 0);
      expect(regularChars).toBeLessThanOrEqual(tightConfig.injectionTokenBudget * 4);
    });
  });

  // ─── RET-01: 1-hop spreading activation ─────────────────────────────────────

  describe('1-hop spreading activation (RET-01, D-26/27/28)', () => {
    it('boosts a low-strength neighbor into the injected set via high-w edge', () => {
      // Short 4-char values so budget is tightly bounded
      addNode('seed', 'AAAA', 0.9);       // base_score ≈ 0.9
      addNode('neighbor', 'CCCC', 0.05);  // base_score ≈ 0.05; will be boosted to ≈ 0.95
      addNode('unrelated', 'BBBB', 0.4);  // base_score ≈ 0.4; no activation

      // Edge from seed to neighbor: w=1.0, spreadDecay=1.0 → boost = 0.9 × 1.0 × 1.0 = 0.9
      store.upsertEdge({ src: 'seed', dst: 'neighbor', rel: 'related', w: 1.0, kind: 'relation' });

      // Budget = 2 tokens = 8 chars — fits exactly 2 nodes of 4 chars each
      const config = { ...BASE_CONFIG, injectionTokenBudget: 2, spreadDecay: 1.0 };
      const result = makeEngine(config).retrieveCueless();

      const ids = result.results.map(r => r.id);
      // After activation: neighbor (0.95) > seed (0.9) > unrelated (0.4)
      // With 8-char budget, neighbor and seed are included; unrelated is pushed out
      expect(ids).toContain('neighbor');
      expect(ids).toContain('seed');
      expect(ids).not.toContain('unrelated');
    });

    it('traverses abstracts edges as well as relation edges (D-27, forward-compat)', () => {
      addNode('schema', 'SSSS', 0.9);
      addNode('fact', 'FFFF', 0.05);

      store.upsertEdge({ src: 'schema', dst: 'fact', rel: 'generalizes', w: 1.0, kind: 'abstracts' });

      const config = { ...BASE_CONFIG, injectionTokenBudget: 2, spreadDecay: 1.0 };
      const result = makeEngine(config).retrieveCueless();

      const ids = result.results.map(r => r.id);
      // 'fact' boosted via abstracts edge (0.05 + 0.9 = 0.95 > schema's 0.9)
      expect(ids).toContain('fact');
    });
  });

  // ─── RET-01: tombstoned neighbor exclusion ───────────────────────────────────

  describe('tombstoned neighbor exclusion from activation (T-02-STALE)', () => {
    it('does not include tombstoned neighbors in the injected set after activation', () => {
      addNode('seed', 'live seed node', 0.9);
      addNode('dead_neighbor', 'this was relevant', 0.5);
      store.tombstone('dead_neighbor');
      store.upsertEdge({ src: 'seed', dst: 'dead_neighbor', rel: 'related', w: 1.0, kind: 'relation' });

      const result = makeEngine().retrieveCueless();

      const ids = result.results.map(r => r.id);
      expect(ids).not.toContain('dead_neighbor');
    });
  });

  // ─── RET-02: retrieve(queryVec) → 'ok' ──────────────────────────────────────

  describe('retrieve(queryVec) — ok status (RET-02)', () => {
    it('returns status ok when best live match cosine ≥ deletedSimilarityThreshold', () => {
      addEmbeddedNode('live_match', 'live matching node', basisVec(0), 0.9);

      const result = makeEngine().retrieve(basisVec(0));

      expect(result.status).toBe('ok');
      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.id).toBe('live_match');
    });
  });

  // ─── RET-02: retrieve(queryVec) → 'deleted' ─────────────────────────────────

  describe('retrieve(queryVec) — deleted status (RET-02)', () => {
    it('returns status deleted when tombstoned node has best cosine ≥ threshold', () => {
      // Live node with orthogonal embedding — cosine with basisVec(0) = 0
      addEmbeddedNode('live_other', 'live node orthogonal to query', basisVec(1), 0.9);
      // Tombstoned node with exact match — cosine = 1.0 ≥ 0.7
      addEmbeddedNode('dead_match', 'tombstoned matching node', basisVec(0), 0.9);
      store.tombstone('dead_match');

      const result = makeEngine().retrieve(basisVec(0));

      expect(result.status).toBe('deleted');
    });
  });

  // ─── RET-02: retrieve(queryVec) → 'unreachable' ─────────────────────────────

  describe('retrieve(queryVec) — unreachable status (RET-02)', () => {
    it('returns status unreachable when neither live nor tombstoned match clears threshold', () => {
      // Live and tombstoned nodes have orthogonal embeddings (cosine = 0 with basisVec(0))
      addEmbeddedNode('live_other', 'live node orthogonal to query', basisVec(1), 0.9);
      addEmbeddedNode('dead_other', 'tombstoned node orthogonal to query', basisVec(2), 0.9);
      store.tombstone('dead_other');

      const result = makeEngine().retrieve(basisVec(0));

      expect(result.status).toBe('unreachable');
    });
  });

  // ─── retrieve() without cue delegates to retrieveCueless() ──────────────────

  describe('retrieve() without cue (RET-01/D-30)', () => {
    it('retrieve(undefined) returns same shape as retrieveCueless() with status ok', () => {
      addNode('n1', 'some remembered fact', 0.5);

      const engine = makeEngine();
      const cueless = engine.retrieveCueless();
      const noArgs = engine.retrieve(undefined);

      expect(noArgs.status).toBe('ok');
      expect(noArgs.results).toEqual(cueless.results);
    });
  });

  // ─── retrieveRanked: ranked top-k with floor (B1/B2) ────────────────────────

  describe('retrieveRanked(queryVec, k, floor)', () => {
    /** Insert a live entity node with an embedding attached. */
    function addEmbeddedEntityNode(id: string, value: string, vec: Float32Array, s: number = 0.5): void {
      store.upsertNode({ id, type: 'entity', value, origin: 'observed', s });
      store.setEmbedding(id, vec);
    }

    /** Insert a consolidation_event row linking node_id and episode_id (for B2 sibling wiring). */
    function linkNodeToEpisode(nodeId: string, episodeId: string): void {
      db.prepare(
        'INSERT INTO consolidation_event (id, ts, schema_version, event_type, node_id, episode_id) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(`ce-${nodeId}-${episodeId}`, Date.now(), 5, 'confirm', nodeId, episodeId);
    }

    it('returns multiple live hits >= floor sorted descending; excludes below-floor node', () => {
      // Three nodes all at basisVec(0): cosine with basisVec(0) = 1.0 (above floor 0.3)
      addEmbeddedNode('ranked-a', 'fact a', basisVec(0), 0.9);
      addEmbeddedNode('ranked-b', 'fact b', basisVec(0), 0.7);
      addEmbeddedNode('ranked-c', 'fact c', basisVec(0), 0.5);
      // One node at basisVec(1): cosine with basisVec(0) = 0.0 (below floor 0.3)
      addEmbeddedNode('ranked-d', 'fact d below floor', basisVec(1), 0.9);

      const engine = makeEngine();
      const results = engine.retrieveRanked(basisVec(0), 10, 0.3);

      const ids = results.map(r => r.id);
      expect(ids).toContain('ranked-a');
      expect(ids).toContain('ranked-b');
      expect(ids).toContain('ranked-c');
      expect(ids).not.toContain('ranked-d'); // cosine 0.0 < floor 0.3

      // Results must be sorted descending by score
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
      }

      // Result items must have id, value, score
      expect(results[0]).toMatchObject({ id: expect.any(String), value: expect.any(String), score: expect.any(Number) });
    });

    it('entity is excluded when all fact-siblings (sharing a consolidation episode) are tombstoned', () => {
      // Entity + fact share episode ep-100; fact is tombstoned
      addEmbeddedEntityNode('ent-stale', 'Ana', basisVec(0), 0.9);
      addEmbeddedNode('fact-stale', 'Ana lives in Denver', basisVec(0), 0.9);
      linkNodeToEpisode('ent-stale', 'ep-100');
      linkNodeToEpisode('fact-stale', 'ep-100');
      store.tombstone('fact-stale'); // only fact-sibling is now tombstoned

      const engine = makeEngine();
      const results = engine.retrieveRanked(basisVec(0), 10, 0.0);

      const ids = results.map(r => r.id);
      expect(ids).not.toContain('ent-stale'); // excluded: all fact-siblings are tombstoned
      expect(ids).not.toContain('fact-stale'); // tombstoned, excluded by topk
    });

    it('entity is NOT excluded when >= 1 live fact-sibling exists', () => {
      // Entity + two facts share ep-200; one fact tombstoned, one still live
      addEmbeddedEntityNode('ent-live', 'Ana', basisVec(0), 0.9);
      addEmbeddedNode('fact-live-a', 'Ana lives in Denver', basisVec(0), 0.9);
      addEmbeddedNode('fact-live-b', 'Ana has a dog', basisVec(0), 0.9);
      linkNodeToEpisode('ent-live', 'ep-200');
      linkNodeToEpisode('fact-live-a', 'ep-200');
      linkNodeToEpisode('fact-live-b', 'ep-200');
      store.tombstone('fact-live-a'); // one fact tombstoned, fact-live-b remains live

      const engine = makeEngine();
      const results = engine.retrieveRanked(basisVec(0), 10, 0.0);

      const ids = results.map(r => r.id);
      expect(ids).toContain('ent-live'); // NOT excluded: fact-live-b is still live
      expect(ids).toContain('fact-live-b');
      expect(ids).not.toContain('fact-live-a'); // tombstoned, excluded by topk
    });

    it('orphan entity (zero consolidation_event rows) is NOT excluded (H-5 precedent)', () => {
      // Orphan: type=entity but no consolidation_event rows at all — seeded/pre-SEAM-02 corpus
      addEmbeddedEntityNode('ent-orphan', "Biscuit is Ana's dog", basisVec(0), 0.9);
      // No linkNodeToEpisode call — zero consolidation_event rows for ent-orphan

      const engine = makeEngine();
      const results = engine.retrieveRanked(basisVec(0), 10, 0.0);

      const ids = results.map(r => r.id);
      expect(ids).toContain('ent-orphan'); // NOT excluded: orphan/seeded node (H-5 global-treat)
    });

    it('retrieve() D-29 regression: ok/deleted/unreachable classification unchanged by retrieveRanked addition', () => {
      // ok: live node with exact-match embedding
      addEmbeddedNode('reg-live', 'regression live node', basisVec(0), 0.9);
      // deleted scenario: tombstoned node matches, live node is orthogonal
      addEmbeddedNode('reg-dead', 'regression tombstoned node', basisVec(3), 0.9);
      addEmbeddedNode('reg-other', 'orthogonal live node', basisVec(1), 0.9);
      store.tombstone('reg-dead');

      const engine = makeEngine();

      // ok: live node at basisVec(0) → cosine 1.0 >= deletedSimilarityThreshold 0.7
      const okResult = engine.retrieve(basisVec(0));
      expect(okResult.status).toBe('ok');
      expect(okResult.results[0]?.id).toBe('reg-live');

      // deleted: tombstoned node at basisVec(3), no live match at that dim
      const deletedResult = engine.retrieve(basisVec(3));
      expect(deletedResult.status).toBe('deleted');

      // unreachable: query at basisVec(5) — no live or tombstoned node there
      const unreachResult = engine.retrieve(basisVec(5));
      expect(unreachResult.status).toBe('unreachable');
    });
  });

  // ─── L-2 topk side: dimension-mismatch safety ───────────────────────────────

  describe('topk dimension-mismatch safety (L-2 topk side)', () => {
    it('skips mismatched-dim nodes — returns only matching-dim node without throwing or NaN', () => {
      // Insert a correctly-dimensioned node (16-dim basisVec via the normal write path)
      addEmbeddedNode('good-dim', 'correctly embedded node', basisVec(0), 0.9);

      // Insert a second node with a DIFFERENT embedding dimension via raw SQL.
      // This bypasses the plan-2 setEmbedding dims-assert, simulating legacy/provider-switch data.
      const mismatchId = 'bad-dim';
      store.upsertNode({
        id: mismatchId,
        type: 'fact',
        value: 'mismatched dims node',
        origin: 'observed',
        s: 0.9,
      });
      // 8-dim Float32Array → 32 bytes; query will be 16-dim → mismatch must be skipped
      const shortVec = new Float32Array(8);
      shortVec[0] = 1.0;
      const shortBuf = Buffer.from(shortVec.buffer.slice(0));
      db.prepare(
        'UPDATE node SET embedding=?, embedded_hash=? WHERE id=?'
      ).run(shortBuf, 'fake-hash', mismatchId);

      const queryVec = basisVec(0); // 16-dim query
      const results = retriever.topk(queryVec, 10);

      // The correctly-dimensioned node must appear
      expect(results.find(r => r.id === 'good-dim')).toBeDefined();
      // The mismatched-dim node must be silently skipped (no throw, not present)
      expect(results.find(r => r.id === 'bad-dim')).toBeUndefined();
      // No NaN scores
      for (const r of results) {
        expect(Number.isNaN(r.score)).toBe(false);
      }
    });
  });
});
