/**
 * Embedder seam tests (Phase 2, D-21/D-22).
 * All tests use MockEmbedder — no network calls.
 * Round-trip: MockEmbedder -> setEmbedding -> CandidateRetriever.topk.
 */
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { CandidateRetriever } from '../src/retrieval/topk';
import { MockEmbedder, OpenAIEmbedder } from '../src/model/embedder';
import type { Embedder } from '../src/model/embedder';

const DIMS = 16; // small dims for test speed; exercises the same Float32 round-trip

/**
 * Hash-seeded deterministic vector generator.
 * djb2-style hash → normalized Float32Array of exactly `dims` length.
 * Two different texts produce different vectors (hash collision rate negligible for tests).
 */
function makeHashVecFn(dims: number): (text: string) => Float32Array {
  return (text: string) => {
    const vec = new Float32Array(dims);
    let hash = 5381;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
    }
    for (let i = 0; i < dims; i++) {
      vec[i] = Math.sin(hash * (i + 1) * 0.1);
    }
    // Normalize to unit vector so cosine similarity = dot product
    const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < dims; i++) vec[i]! /= norm;
    }
    return vec;
  };
}

// ── MockEmbedder ─────────────────────────────────────────────────────────────

describe('MockEmbedder', () => {
  it('returns texts.map(fn) — order and count preserved', async () => {
    const fn = makeHashVecFn(DIMS);
    const mock = new MockEmbedder(fn);
    const texts = ['alpha', 'beta', 'gamma'];
    const results = await mock.embed(texts);
    expect(results).toHaveLength(texts.length);
    for (let i = 0; i < texts.length; i++) {
      const expected = fn(texts[i]!);
      const got = results[i]!;
      expect(got).toBeInstanceOf(Float32Array);
      expect(got.length).toBe(DIMS);
      for (let d = 0; d < DIMS; d++) {
        expect(got[d]).toBeCloseTo(expected[d]!, 10);
      }
    }
  });

  it('returns empty array for empty input — no-op', async () => {
    const mock = new MockEmbedder(makeHashVecFn(DIMS));
    const results = await mock.embed([]);
    expect(results).toHaveLength(0);
  });

  it('each returned vector is a Float32Array of exactly `dims` length', async () => {
    const mock = new MockEmbedder(makeHashVecFn(DIMS));
    const results = await mock.embed(['one', 'two', 'three']);
    for (const vec of results) {
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(DIMS);
    }
  });

  it('satisfies the Embedder interface (type-level check via assignment)', () => {
    const embedder: Embedder = new MockEmbedder(makeHashVecFn(DIMS));
    expect(typeof embedder.embed).toBe('function');
  });
});

// ── OpenAIEmbedder (export / class shape only — no network) ─────────────────

describe('OpenAIEmbedder (export verification)', () => {
  it('is exported as a constructor function', () => {
    // T-02-KEY: we only verify the export exists.
    // Actual construction requires OPENAI_API_KEY in process.env — not tested here.
    expect(typeof OpenAIEmbedder).toBe('function');
  });
});

// ── Round-trip: setEmbedding → CandidateRetriever.topk ───────────────────────

describe('Embedder round-trip: setEmbedding -> topk', () => {
  it('synthetic vector stored via setEmbedding is returned top-1 by topk at score >= 0.99', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const config = { ...DEFAULT_CONFIG, dbPath: ':memory:' };
    const store = new SemanticStore(db, clock, config);
    const retriever = new CandidateRetriever(db);

    const fn = makeHashVecFn(DIMS);
    const mock = new MockEmbedder(fn);

    const nodeId = 'node-roundtrip';
    const nodeValue = 'the founder uses TypeScript';
    store.upsertNode({ id: nodeId, type: 'fact', value: nodeValue, origin: 'observed' });

    // Embed and store
    const [vec] = await mock.embed([nodeValue]);
    store.setEmbedding(nodeId, vec!);

    // Query with the same vector — must return the node as top-1 with score >= 0.99
    const results = retriever.topk(vec!, 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.id).toBe(nodeId);
    expect(results[0]!.score).toBeGreaterThanOrEqual(0.99);

    db.close();
  });

  it('multiple nodes: the queried node stays top-1 against unrelated neighbors', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const config = { ...DEFAULT_CONFIG, dbPath: ':memory:' };
    const store = new SemanticStore(db, clock, config);
    const retriever = new CandidateRetriever(db);

    const fn = makeHashVecFn(DIMS);
    const mock = new MockEmbedder(fn);

    // Insert three nodes with different values (→ different hash vectors, mutually distinct)
    const nodes = [
      { id: 'n1', value: 'TypeScript is the language' },
      { id: 'n2', value: 'SQLite stores the graph' },
      { id: 'n3', value: 'vectors enable similarity search' },
    ];

    for (const n of nodes) {
      store.upsertNode({ id: n.id, type: 'fact', value: n.value, origin: 'observed' });
      const [v] = await mock.embed([n.value]);
      store.setEmbedding(n.id, v!);
    }

    // Query for n2's vector — must come back top-1
    const [qVec] = await mock.embed([nodes[1]!.value]);
    const results = retriever.topk(qVec!, 3);
    expect(results[0]!.id).toBe('n2');
    expect(results[0]!.score).toBeGreaterThanOrEqual(0.99);

    db.close();
  });
});
