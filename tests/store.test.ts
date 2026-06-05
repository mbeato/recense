/**
 * STORE-01: all four record types persist and round-trip.
 * STORE-02: owned write primitive dirty-flag discipline.
 * STORE-03: brute-force cosine top-k retrieval (added in Task 4 RED commit).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema, SCHEMA_VERSION } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { CandidateRetriever, cosineSimF32 } from '../src/retrieval/topk';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { sha256 } from '../src/lib/hash';
import type { PendingContradiction } from '../src/lib/types';
import { makeSyntheticVectors } from './fixtures/synthetic-embeddings';

const testConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

// ─── initSchema ─────────────────────────────────────────────────────────────

describe('initSchema', () => {
  it('creates all four required tables', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = rows.map(r => r.name);
    expect(names).toContain('node');
    expect(names).toContain('edge');
    expect(names).toContain('episode');
    expect(names).toContain('meta');
    db.close();
  });

  it(`records schema_version ${SCHEMA_VERSION} in meta`, () => {
    const db = new Database(':memory:');
    initSchema(db);
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe(String(SCHEMA_VERSION));
    db.close();
  });

  it('is idempotent — calling twice does not throw', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();
    db.close();
  });
});

// ─── SemanticStore ───────────────────────────────────────────────────────────

describe('SemanticStore', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let store: SemanticStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    store = new SemanticStore(db, clock, testConfig);
  });

  afterEach(() => {
    db.close();
  });

  // ── upsertNode / getNode (STORE-01) ─────────────────────────────────────

  describe('upsertNode / getNode', () => {
    it('persists a new node — value_hash correct, embedded_hash is null (dirty)', () => {
      store.upsertNode({
        id: 'n1',
        type: 'fact',
        value: 'Max is the founder',
        origin: 'asserted_by_user',
      });
      const node = store.getNode('n1');
      expect(node).not.toBeNull();
      expect(node!.value_hash).toBe(sha256('Max is the founder'));
      expect(node!.embedded_hash).toBeNull();
    });

    it('returns null for an unknown id', () => {
      expect(store.getNode('nonexistent')).toBeNull();
    });

    it('persists type, origin, s, c, tombstoned, pending_contradictions defaults', () => {
      store.upsertNode({
        id: 'n1',
        type: 'entity',
        value: 'Alice',
        origin: 'observed',
        s: 0.3,
        c: 0.7,
      });
      const node = store.getNode('n1')!;
      expect(node.type).toBe('entity');
      expect(node.value).toBe('Alice');
      expect(node.origin).toBe('observed');
      expect(node.s).toBe(0.3);
      expect(node.c).toBe(0.7);
      expect(node.tombstoned).toBe(0);
      expect(node.pending_contradictions).toBe('[]');
    });

    it('sets last_access to clock.nowMs() for a new node', () => {
      store.upsertNode({ id: 'n1', type: 'fact', value: 'v', origin: 'observed' });
      expect(store.getNode('n1')!.last_access).toBe(clock.nowMs());
    });
  });

  // ── STORE-02: dirty-flag discipline ─────────────────────────────────────

  describe('dirty-flag invariant (STORE-02)', () => {
    it('re-dirties embedded_hash when value changes', () => {
      store.upsertNode({ id: 'n1', type: 'fact', value: 'old value', origin: 'observed' });
      store.setEmbedding('n1', new Float32Array([0.1, 0.2, 0.3]));
      expect(store.getNode('n1')!.embedded_hash).not.toBeNull();

      store.upsertNode({ id: 'n1', type: 'fact', value: 'new value', origin: 'observed' });
      const node = store.getNode('n1')!;
      expect(node.embedded_hash).toBeNull();
      expect(node.value_hash).toBe(sha256('new value'));
    });

    it('does NOT re-dirty embedded_hash when value is unchanged', () => {
      store.upsertNode({ id: 'n1', type: 'fact', value: 'same value', origin: 'observed' });
      store.setEmbedding('n1', new Float32Array([0.1, 0.2, 0.3]));
      const hashBefore = store.getNode('n1')!.embedded_hash;
      expect(hashBefore).not.toBeNull();

      store.upsertNode({ id: 'n1', type: 'fact', value: 'same value', origin: 'observed' });
      expect(store.getNode('n1')!.embedded_hash).toBe(hashBefore);
    });

    it('carries prev_value to old value and prev_ts when value changes', () => {
      store.upsertNode({ id: 'n1', type: 'fact', value: 'old value', origin: 'observed' });
      const oldTs = store.getNode('n1')!.last_access;

      clock.advanceDays(1);
      store.upsertNode({ id: 'n1', type: 'fact', value: 'new value', origin: 'observed' });
      const node = store.getNode('n1')!;
      expect(node.prev_value).toBe('old value');
      expect(node.prev_ts).toBe(oldTs);
    });

    it('preserves prev_value when value is unchanged', () => {
      store.upsertNode({ id: 'n1', type: 'fact', value: 'v1', origin: 'observed' });
      store.upsertNode({ id: 'n1', type: 'fact', value: 'v2', origin: 'observed' });
      store.upsertNode({ id: 'n1', type: 'fact', value: 'v2', origin: 'observed' });
      expect(store.getNode('n1')!.prev_value).toBe('v1');
    });
  });

  // ── setEmbedding ────────────────────────────────────────────────────────

  describe('setEmbedding', () => {
    it('stores the vector and marks embedded_hash = value_hash (clean)', () => {
      store.upsertNode({ id: 'n1', type: 'fact', value: 'test embedding', origin: 'observed' });
      const vec = new Float32Array([0.1, 0.2, 0.3, 0.4]);
      store.setEmbedding('n1', vec);
      const node = store.getNode('n1')!;
      expect(node.embedded_hash).toBe(node.value_hash);
      expect(node.embedding).not.toBeNull();
    });

    it('round-trips Float32Array correctly (Pitfall 5: byteOffset+length)', () => {
      store.upsertNode({ id: 'n1', type: 'fact', value: 'vec test', origin: 'observed' });
      const vec = new Float32Array([1.5, -0.5, 0.0, 3.14]);
      store.setEmbedding('n1', vec);
      const buf = store.getNode('n1')!.embedding!;
      const decoded = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      for (let i = 0; i < vec.length; i++) {
        // Float32 precision loss is acceptable; use closeTo
        expect(decoded[i]).toBeCloseTo(vec[i]!, 5);
      }
    });
  });

  // ── training_eligible ───────────────────────────────────────────────────

  describe('training_eligible', () => {
    it('is 1 for asserted_by_user, c >= 0.6, not tombstoned', () => {
      store.upsertNode({ id: 'n1', type: 'fact', value: 'v', origin: 'asserted_by_user', c: 0.8 });
      expect(store.getNode('n1')!.training_eligible).toBe(1);
    });

    it('is 1 for observed, c >= 0.6, not tombstoned', () => {
      store.upsertNode({ id: 'n1', type: 'fact', value: 'v', origin: 'observed', c: 0.9 });
      expect(store.getNode('n1')!.training_eligible).toBe(1);
    });

    it('is 0 for inferred origin (self-confirmation guard)', () => {
      store.upsertNode({ id: 'n1', type: 'fact', value: 'v', origin: 'inferred', c: 0.9 });
      expect(store.getNode('n1')!.training_eligible).toBe(0);
    });

    it('is 0 when c < trainingConfidenceThreshold (0.6)', () => {
      store.upsertNode({ id: 'n1', type: 'fact', value: 'v', origin: 'observed', c: 0.5 });
      expect(store.getNode('n1')!.training_eligible).toBe(0);
    });

    it('is 0 after tombstone even if c was sufficient', () => {
      store.upsertNode({ id: 'n1', type: 'fact', value: 'v', origin: 'observed', c: 0.8 });
      expect(store.getNode('n1')!.training_eligible).toBe(1);
      store.tombstone('n1');
      expect(store.getNode('n1')!.training_eligible).toBe(0);
    });
  });

  // ── tombstone ───────────────────────────────────────────────────────────

  describe('tombstone', () => {
    it('sets tombstoned = 1', () => {
      store.upsertNode({ id: 'n1', type: 'fact', value: 'v', origin: 'observed' });
      store.tombstone('n1');
      expect(store.getNode('n1')!.tombstoned).toBe(1);
    });
  });

  // ── recordContradiction ─────────────────────────────────────────────────

  describe('recordContradiction', () => {
    it('appends PendingContradiction entries (append-only, D-19)', () => {
      store.upsertNode({ id: 'n1', type: 'fact', value: 'v', origin: 'observed' });
      store.recordContradiction('n1', { episode_id: 'ep_001', session_id: 'sess_a', origin: 'observed' });
      store.recordContradiction('n1', { episode_id: 'ep_002', session_id: 'sess_b', origin: 'asserted_by_user' });
      const contradictions = JSON.parse(store.getNode('n1')!.pending_contradictions) as PendingContradiction[];
      expect(contradictions).toHaveLength(2);
      expect(contradictions[0]!.episode_id).toBe('ep_001');
      expect(contradictions[0]!.session_id).toBe('sess_a');
      expect(contradictions[0]!.origin).toBe('observed');
      expect(contradictions[1]!.episode_id).toBe('ep_002');
    });

    it('pending_contradictions survives a same-value upsertNode (no spurious reset)', () => {
      store.upsertNode({ id: 'n1', type: 'fact', value: 'v', origin: 'observed' });
      store.recordContradiction('n1', { episode_id: 'ep_001', session_id: 'sess_a', origin: 'observed' });
      store.upsertNode({ id: 'n1', type: 'fact', value: 'v', origin: 'observed' });
      const contradictions = JSON.parse(store.getNode('n1')!.pending_contradictions) as PendingContradiction[];
      expect(contradictions[0]!.episode_id).toBe('ep_001');
    });
  });

  // ── explicit prev_value carry (D-20) ─────────────────────────────────────

  describe('explicit prev_value carry (D-20)', () => {
    it('upsertNode with prev_value on a NEW id writes it to the node', () => {
      store.upsertNode({
        id: 'n-new',
        type: 'fact',
        value: 'current-value',
        origin: 'observed',
        prev_value: 'old-x',
      });
      expect(store.getNode('n-new')!.prev_value).toBe('old-x');
    });

    it('REGRESSION: upsertNode WITHOUT prev_value still carries the old value into prev_value on value change (STORE-02)', () => {
      // Insert initial node
      store.upsertNode({ id: 'n-reg', type: 'fact', value: 'first-value', origin: 'observed' });
      expect(store.getNode('n-reg')!.prev_value).toBeNull(); // new node, no prev

      // Change value without supplying prev_value — store should carry 'first-value' into prev_value
      store.upsertNode({ id: 'n-reg', type: 'fact', value: 'second-value', origin: 'observed' });
      expect(store.getNode('n-reg')!.prev_value).toBe('first-value');
      expect(store.getNode('n-reg')!.value).toBe('second-value');
    });
  });

  // ── tombstoned exclusion from topk (T-02-STALE) ──────────────────────────

  describe('tombstoned exclusion from topk', () => {
    it('tombstoned node is not returned by topk even though its embedding column is non-null', () => {
      const db2 = new Database(':memory:');
      initSchema(db2);
      const clock2 = new FakeClock(Date.UTC(2026, 0, 1));
      const store2 = new SemanticStore(db2, clock2, testConfig);
      const retriever2 = new CandidateRetriever(db2);

      const vec = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

      store2.upsertNode({ id: 'live', type: 'fact', value: 'live node', origin: 'observed' });
      store2.setEmbedding('live', vec);

      store2.upsertNode({ id: 'dead', type: 'fact', value: 'tombstoned node', origin: 'observed' });
      store2.setEmbedding('dead', vec);
      store2.tombstone('dead');

      // Verify embedding column is non-null for tombstoned node (would be nominated without filter)
      const deadRow = db2.prepare('SELECT embedding FROM node WHERE id = ?').get('dead') as { embedding: Buffer | null };
      expect(deadRow.embedding).not.toBeNull();

      const results = retriever2.topk(vec, 10);
      const ids = results.map(r => r.id);
      expect(ids).toContain('live');
      expect(ids).not.toContain('dead');

      db2.close();
    });
  });

  // ── upsertEdge / meta (STORE-01) ────────────────────────────────────────

  describe('upsertEdge (STORE-01)', () => {
    it('inserts a relation edge without throwing', () => {
      store.upsertNode({ id: 'n1', type: 'entity', value: 'Alice', origin: 'observed' });
      store.upsertNode({ id: 'n2', type: 'entity', value: 'Bob', origin: 'observed' });
      expect(() =>
        store.upsertEdge({ src: 'n1', dst: 'n2', rel: 'knows', w: 0.5, kind: 'relation' })
      ).not.toThrow();
    });

    it('inserts an abstracts edge without throwing', () => {
      store.upsertNode({ id: 'n1', type: 'fact', value: 'fact', origin: 'observed' });
      store.upsertNode({ id: 's1', type: 'schema', value: 'schema', origin: 'inferred' });
      expect(() =>
        store.upsertEdge({ src: 's1', dst: 'n1', rel: 'generalizes', w: 0.8, kind: 'abstracts' })
      ).not.toThrow();
    });
  });

  describe('meta get/set (STORE-01)', () => {
    it('round-trips a meta key/value pair', () => {
      store.setMeta('seeded', 'true');
      expect(store.getMeta('seeded')).toBe('true');
    });

    it('returns null for a missing key', () => {
      expect(store.getMeta('nonexistent')).toBeNull();
    });

    it('overwrites an existing meta value', () => {
      store.setMeta('key', 'v1');
      store.setMeta('key', 'v2');
      expect(store.getMeta('key')).toBe('v2');
    });
  });
});

// ─── STORE-03: cosineSimF32 + CandidateRetriever.topk ─────────────────────

describe('cosineSimF32 (STORE-03)', () => {
  it('returns 1.0 for identical unit vectors', () => {
    const a = new Float32Array([1, 0, 0, 0]);
    expect(cosineSimF32(a, a)).toBeCloseTo(1.0, 5);
  });

  it('returns 0.0 for orthogonal unit vectors', () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosineSimF32(a, b)).toBeCloseTo(0.0, 5);
  });

  it('returns 0.0 when either norm is zero (denom guard)', () => {
    const zero = new Float32Array([0, 0, 0, 0]);
    const a = new Float32Array([1, 0, 0, 0]);
    expect(cosineSimF32(zero, a)).toBe(0);
    expect(cosineSimF32(a, zero)).toBe(0);
  });
});

describe('CandidateRetriever.topk (STORE-03)', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let store: SemanticStore;
  let retriever: CandidateRetriever;
  const testConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    store = new SemanticStore(db, clock, testConfig);
    retriever = new CandidateRetriever(db);
  });

  afterEach(() => {
    db.close();
  });

  it('returns exactly k results sorted by cosine score descending', () => {
    const { vectors, groundTruth } = makeSyntheticVectors();
    for (let i = 0; i < vectors.length; i++) {
      store.upsertNode({ id: `vec${i}`, type: 'fact', value: `value ${i}`, origin: 'observed' });
      store.setEmbedding(`vec${i}`, vectors[i]!);
    }
    const k = 3;
    const results = retriever.topk(vectors[0]!, k);
    expect(results).toHaveLength(k);
    // Top hit must be the self-similar vector
    expect(results[0]!.id).toBe(`vec${groundTruth[0]}`);
    expect(results[0]!.score).toBeCloseTo(1.0, 5);
    // Scores must be non-increasing
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1]!.score).toBeGreaterThanOrEqual(results[i]!.score);
    }
  });

  it('top-k ranking matches ground truth for every query vector', () => {
    const { vectors, groundTruth } = makeSyntheticVectors();
    for (let i = 0; i < vectors.length; i++) {
      store.upsertNode({ id: `vec${i}`, type: 'fact', value: `value ${i}`, origin: 'observed' });
      store.setEmbedding(`vec${i}`, vectors[i]!);
    }
    for (let i = 0; i < vectors.length; i++) {
      const results = retriever.topk(vectors[i]!, 1);
      expect(results[0]!.id).toBe(`vec${groundTruth[i]}`);
    }
  });

  it('excludes nodes with null embedding (dirty nodes not retrieval candidates)', () => {
    const vec = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    store.upsertNode({ id: 'embedded', type: 'fact', value: 'embedded', origin: 'observed' });
    store.setEmbedding('embedded', vec);
    store.upsertNode({ id: 'dirty', type: 'fact', value: 'dirty node', origin: 'observed' });
    // dirty has no embedding — should not appear in results
    const results = retriever.topk(vec, 10);
    const ids = results.map(r => r.id);
    expect(ids).toContain('embedded');
    expect(ids).not.toContain('dirty');
  });

  it('returns empty array when no nodes have embeddings', () => {
    store.upsertNode({ id: 'n1', type: 'fact', value: 'no embed', origin: 'observed' });
    const results = retriever.topk(new Float32Array(16), 5);
    expect(results).toHaveLength(0);
  });
});
