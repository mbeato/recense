/**
 * tests/activation-trace-wiring.test.ts
 *
 * Task 1 (engine): Verify that RetrievalEngine and RecallEngine accept an optional
 *   ActivationTraceSink (last constructor param, Noop default) and emit guarded traces.
 *
 * Task 2 (flag): Verify that the viz_trace_enabled meta flag gates SQLite vs Noop sink
 *   selection in the recall-cli / watcher-cli injection pattern.
 *
 * D-97 hot-path guard: all "engine" tests confirm the Noop path doesn't throw and
 * returns byte-identical results. session-start-cli stays 7-arg / no sink.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { EpisodicStore } from '../src/db/episode-store';
import { StrengthDecayManager } from '../src/strength/decay';
import { CandidateRetriever } from '../src/retrieval/topk';
import { AllocationGate } from '../src/gate/allocation-gate';
import { RetrievalEngine } from '../src/retrieval/engine';
import { RecallEngine } from '../src/recall';
import {
  MockActivationTraceSink,
  NoopActivationTraceSink,
  SQLiteActivationTraceSink,
} from '../src/viz/activation-sink';
import { MockModelProvider } from '../src/model/provider';
import { newId } from '../src/lib/hash';

const BASE_CONFIG = { ...DEFAULT_CONFIG, dbPath: ':memory:' };
const DIMS = 16;

/** Unit vector in the given dimension (default 0). */
function makeVec(dim = 0): Float32Array {
  const v = new Float32Array(DIMS);
  v[dim] = 1.0;
  return v;
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

function makeRetrievalDeps(db: Database.Database) {
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const store = new SemanticStore(db, clock, BASE_CONFIG);
  const retriever = new CandidateRetriever(db);
  const strength = new StrengthDecayManager(db, clock, BASE_CONFIG);
  const gate = new AllocationGate(BASE_CONFIG);
  return { clock, store, retriever, strength, gate };
}

function makeRecallDeps(db: Database.Database) {
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const store = new SemanticStore(db, clock, BASE_CONFIG);
  const retriever = new CandidateRetriever(db);
  const strength = new StrengthDecayManager(db, clock, BASE_CONFIG);
  const episodes = new EpisodicStore(db, clock, BASE_CONFIG);
  return { clock, store, retriever, strength, episodes };
}

// ---------------------------------------------------------------------------
// engine: RetrievalEngine trace wiring
// ---------------------------------------------------------------------------

describe('engine: RetrievalEngine trace wiring', () => {
  let db: Database.Database;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('default (7-arg, no sink): retrieveCueless does not throw', () => {
    const { clock, store, retriever, strength, gate } = makeRetrievalDeps(db);
    store.upsertNode({ id: 'n1', type: 'fact', value: 'a test fact', origin: 'observed', s: 0.5 });

    // 7-arg constructor — no trace sink; must not throw (Noop default)
    const engine = new RetrievalEngine(db, clock, BASE_CONFIG, retriever, store, strength, gate);
    expect(() => engine.retrieveCueless()).not.toThrow();
  });

  it('mock sink: retrieveCueless emits exactly 1 trace with non-empty seeds and hops', () => {
    const { clock, store, retriever, strength, gate } = makeRetrievalDeps(db);
    // Insert 2 nodes and a connecting edge so spreading activation has neighbors to traverse
    store.upsertNode({ id: 'seed1', type: 'fact', value: 'seed node value', origin: 'observed', s: 0.9 });
    store.upsertNode({ id: 'nbr1',  type: 'fact', value: 'neighbor value',  origin: 'observed', s: 0.5 });
    store.upsertEdge({ src: 'seed1', dst: 'nbr1', rel: 'related', w: 0.8, kind: 'relation' });

    const mockSink = new MockActivationTraceSink();
    // 8th optional param — fails RED because RetrievalEngine constructor has only 7 params yet
    const engine = new RetrievalEngine(
      db, clock, BASE_CONFIG, retriever, store, strength, gate, mockSink,
    );

    engine.retrieveCueless();

    // RED FAILURES: these assertions fail until GREEN implements the emit guard
    expect(mockSink.traces).toHaveLength(1);
    const trace = mockSink.traces[0]!;
    expect(trace.seeds.length).toBeGreaterThan(0);
    expect(trace.hops.length).toBeGreaterThan(0);
    expect(typeof trace.query_id).toBe('string');
    expect(trace.query_id.length).toBeGreaterThan(0);
    trace.hops.forEach(h => {
      expect(h).toHaveProperty('node_id');
      expect(typeof h.node_id).toBe('string');
      expect(h).toHaveProperty('score');
      expect(typeof h.score).toBe('number');
      expect(h.hop).toBe(1);  // all hops are 1-hop
    });
  });

  it('noop sink: retrieveCueless returns byte-identical results to no-sink path', () => {
    const { clock, store, retriever, strength, gate } = makeRetrievalDeps(db);
    store.upsertNode({ id: 'n1', type: 'fact', value: 'fact A', origin: 'observed', s: 0.7 });
    store.upsertNode({ id: 'n2', type: 'fact', value: 'fact B', origin: 'observed', s: 0.4 });

    // Baseline (no sink) vs explicit Noop — results must be identical
    const baseline = new RetrievalEngine(db, clock, BASE_CONFIG, retriever, store, strength, gate);
    const withNoop  = new RetrievalEngine(
      db, clock, BASE_CONFIG, retriever, store, strength, gate, new NoopActivationTraceSink(),
    );

    const r1 = baseline.retrieveCueless();
    const r2 = withNoop.retrieveCueless();

    expect(r2.status).toBe(r1.status);
    expect(r2.results.map(n => n.id)).toEqual(r1.results.map(n => n.id));
  });
});

// ---------------------------------------------------------------------------
// engine: RecallEngine trace wiring
// ---------------------------------------------------------------------------

describe('engine: RecallEngine trace wiring', () => {
  let db: Database.Database;

  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  it('mock sink: recall emits 1 trace with seeds=[bestMatch.id] and hops from neighborhood', async () => {
    const { clock, store, retriever, strength, episodes } = makeRecallDeps(db);

    // Build a schema graph: schema node + 2 member nodes connected by abstracts edges
    const schemaId  = newId();
    const memberId1 = newId();
    const memberId2 = newId();
    store.upsertNode({ id: schemaId,  type: 'schema', value: 'TypeScript dev patterns',    origin: 'observed', s: 0.9 });
    store.upsertNode({ id: memberId1, type: 'fact',   value: 'use strict types',           origin: 'observed', s: 0.7 });
    store.upsertNode({ id: memberId2, type: 'fact',   value: 'prefer interfaces over any', origin: 'observed', s: 0.6 });
    // schema→member 'abstracts' edges — enable Case A (schema is best match) and Case B (member is best match)
    store.upsertEdge({ src: schemaId, dst: memberId1, rel: 'abstracts', w: 0.9, kind: 'abstracts' });
    store.upsertEdge({ src: schemaId, dst: memberId2, rel: 'abstracts', w: 0.8, kind: 'abstracts' });

    // Set identical embeddings on all nodes — topk will return one of them as bestMatch
    store.setEmbedding(schemaId,  makeVec(0));
    store.setEmbedding(memberId1, makeVec(0));
    store.setEmbedding(memberId2, makeVec(0));

    const provider = new MockModelProvider({
      embedFn:        () => makeVec(0),
      generateScript: ['TypeScript: strict types and interface-first design'],
    });

    const mockSink = new MockActivationTraceSink();
    // 9th optional param — fails RED because RecallEngine constructor has only 8 params yet
    const engine = new RecallEngine(
      db, clock, BASE_CONFIG, provider, retriever, store, strength, episodes, mockSink,
    );

    await engine.recall('TypeScript patterns', 'test-session');

    // RED FAILURES: these assertions fail until GREEN implements the emit guard
    expect(mockSink.traces).toHaveLength(1);
    const trace = mockSink.traces[0]!;
    expect(trace.seeds).toHaveLength(1);
    // Phase 52 (D-07/WR-02): seeds are now {node_id, score:null} — not bare strings
    expect(typeof trace.seeds[0]).toBe('object');
    expect(typeof (trace.seeds[0] as any).node_id).toBe('string');
    expect((trace.seeds[0] as any).score).toBeNull();
    expect(trace.hops.length).toBeGreaterThan(0);
    trace.hops.forEach(h => {
      expect(h).toHaveProperty('node_id');
      expect(typeof h.node_id).toBe('string');
      expect(h).toHaveProperty('score');
      // WR-02: recall has only rank order, no measured activation/similarity
      // magnitude — it emits an honest null rather than a fabricated number.
      expect(h.score).toBeNull();
      expect(h.hop).toBe(1);
    });
  });

  it('noop sink: recall does not throw and returns origin: inferred', async () => {
    const { clock, store, retriever, strength, episodes } = makeRecallDeps(db);

    const schemaId  = newId();
    const memberId  = newId();
    store.upsertNode({ id: schemaId, type: 'schema', value: 'pattern X', origin: 'observed', s: 0.8 });
    store.upsertNode({ id: memberId, type: 'fact',   value: 'fact Y',    origin: 'observed', s: 0.7 });
    store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 0.9, kind: 'abstracts' });
    store.setEmbedding(schemaId, makeVec(0));
    store.setEmbedding(memberId,  makeVec(0));

    const provider = new MockModelProvider({
      embedFn:        () => makeVec(0),
      generateScript: ['test inference text'],
    });

    const engine = new RecallEngine(
      db, clock, BASE_CONFIG, provider, retriever, store, strength, episodes,
      new NoopActivationTraceSink(),
    );

    const result = await engine.recall('test query', 'test-session');
    // Noop sink: must not throw, must not corrupt result
    expect(result.origin).toBe('inferred');
  });
});

// ---------------------------------------------------------------------------
// flag: viz_trace_enabled gate controls sink injection (Task 2)
// ---------------------------------------------------------------------------

describe('flag: viz_trace_enabled gate controls sink injection', () => {
  it('flag OFF (no meta key): traceEnabled resolves to false', () => {
    const db = makeDb();
    // Default DB has no viz_trace_enabled meta entry
    const flagRaw = db.prepare("SELECT value FROM meta WHERE key = 'viz_trace_enabled'")
      .get() as { value: string } | undefined;
    const traceEnabled = flagRaw?.value === '1';
    expect(traceEnabled).toBe(false);
    db.close();
  });

  it('flag OFF: Noop sink writes zero rows to activation_trace', () => {
    const db = makeDb();
    const clock = new FakeClock(Date.UTC(2026, 0, 1));

    // Simulate the recall-cli pattern: read flag → build Noop sink
    const flagRaw = db.prepare("SELECT value FROM meta WHERE key = 'viz_trace_enabled'")
      .get() as { value: string } | undefined;
    const traceSink = flagRaw?.value === '1'
      ? new SQLiteActivationTraceSink(db, clock)
      : new NoopActivationTraceSink();

    traceSink.emit({ query_id: newId(), seeds: ['n1'], hops: [{ node_id: 'n2', score: 0.8, hop: 1 }] });

    const rows = db.prepare('SELECT * FROM activation_trace').all();
    expect(rows).toHaveLength(0);
    db.close();
  });

  it('flag ON (viz_trace_enabled=1): SQLite sink writes 1 row to activation_trace', () => {
    const db = makeDb();
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('viz_trace_enabled', '1')").run();
    const clock = new FakeClock(Date.UTC(2026, 0, 1));

    // Simulate the recall-cli pattern: read flag → build SQLite sink
    const flagRaw = db.prepare("SELECT value FROM meta WHERE key = 'viz_trace_enabled'")
      .get() as { value: string } | undefined;
    const traceSink = flagRaw?.value === '1'
      ? new SQLiteActivationTraceSink(db, clock)
      : new NoopActivationTraceSink();

    traceSink.emit({ query_id: newId(), seeds: ['node-a'], hops: [{ node_id: 'node-b', score: 0.8, hop: 1 }] });

    const rows = db.prepare('SELECT * FROM activation_trace').all();
    expect(rows).toHaveLength(1);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// engine: retrieveRanked vizFloor — Phase 19 "light every read" (real read,
// injection unchanged). The trace lights nodes the topk scan GENUINELY reached
// down to vizFloor even when none cleared the injection floor; returned/injected
// results stay floor-gated; nothing fires when the scan reaches nothing.
// ---------------------------------------------------------------------------

describe('engine: retrieveRanked vizFloor lights genuinely-retrieved nodes below the injection floor', () => {
  let db: Database.Database;
  beforeEach(() => { db = makeDb(); });
  afterEach(() => { db.close(); });

  // Unit vector whose cosine with makeVec(0) ([1,0,…]) is exactly `c`.
  function vecWithCosine(c: number): Float32Array {
    const v = new Float32Array(DIMS);
    v[0] = c;
    v[1] = Math.sqrt(Math.max(0, 1 - c * c));
    return v;
  }

  function seedThreeNodes(store: SemanticStore) {
    store.upsertNode({ id: 'hi',  type: 'fact', value: 'high match', origin: 'observed', s: 0.7 });
    store.upsertNode({ id: 'mid', type: 'fact', value: 'mid match',  origin: 'observed', s: 0.6 });
    store.upsertNode({ id: 'lo',  type: 'fact', value: 'low match',  origin: 'observed', s: 0.5 });
    store.setEmbedding('hi',  vecWithCosine(0.60)); // ≥ injection floor 0.45
    store.setEmbedding('mid', vecWithCosine(0.35)); // < 0.45 but ≥ vizFloor 0.25
    store.setEmbedding('lo',  vecWithCosine(0.10)); // < vizFloor 0.25
  }

  it('vizFloor: trace lights [hi, mid] while injected set stays [hi]', () => {
    const { clock, store, retriever, strength, gate } = makeRetrievalDeps(db);
    seedThreeNodes(store);
    const sink = new MockActivationTraceSink();
    const engine = new RetrievalEngine(db, clock, BASE_CONFIG, retriever, store, strength, gate, sink);

    const results = engine.retrieveRanked(makeVec(0), 5, 0.45, undefined, { vizFloor: 0.25 });

    // Injection/returned set unchanged — floor-gated at 0.45.
    expect(results.map(r => r.id)).toEqual(['hi']);
    // Trace lit the genuinely-retrieved set down to vizFloor: includes below-floor
    // 'mid', excludes below-vizFloor 'lo'.
    expect(sink.traces).toHaveLength(1);
    // Phase 55 (D-06): seeds are now {node_id, score} objects, not bare strings.
    expect(sink.traces[0]!.seeds.map(s => (s as any).node_id).sort()).toEqual(['hi', 'mid']);
  });

  it('without vizFloor: unchanged — trace seeds equal the injected set [hi]', () => {
    const { clock, store, retriever, strength, gate } = makeRetrievalDeps(db);
    seedThreeNodes(store);
    const sink = new MockActivationTraceSink();
    const engine = new RetrievalEngine(db, clock, BASE_CONFIG, retriever, store, strength, gate, sink);

    const results = engine.retrieveRanked(makeVec(0), 5, 0.45);

    expect(results.map(r => r.id)).toEqual(['hi']);
    expect(sink.traces).toHaveLength(1);
    // Phase 55 (D-06): seeds are now {node_id, score} objects, not bare strings.
    expect(sink.traces[0]!.seeds.map(s => (s as any).node_id)).toEqual(['hi']);
  });

  it('honesty guard: scan reaches nothing ≥ vizFloor → no trace fires', () => {
    const { clock, store, retriever, strength, gate } = makeRetrievalDeps(db);
    seedThreeNodes(store);
    const sink = new MockActivationTraceSink();
    const engine = new RetrievalEngine(db, clock, BASE_CONFIG, retriever, store, strength, gate, sink);

    // Query orthogonal to every node (dim 5) → all cosines 0 < vizFloor.
    const results = engine.retrieveRanked(makeVec(5), 5, 0.45, undefined, { vizFloor: 0.25 });

    expect(results).toHaveLength(0);
    expect(sink.traces).toHaveLength(0);
  });

  // ── Phase 55 SC2/SC3 machine guards (honesty regression lock) ───────────────
  // Real-edge cross-check, kind allowlist (D-05), liveness (D-07, Pitfall 2),
  // top-N cap (D-01/D-02), and the seed-real/hop-null score split (D-06/WR-02).

  it('SC2/SC3 honesty guard: real-edge cross-check, kind allowlist, liveness, top-N cap, score split', () => {
    const { clock, store, retriever, strength, gate } = makeRetrievalDeps(db);

    // Seed node with an exact-match embedding so it retrieves as the sole candidate.
    store.upsertNode({ id: 'seed', type: 'fact', value: 'seed fact', origin: 'observed', s: 0.8 });
    store.setEmbedding('seed', makeVec(0));

    // 8 live kind='relation' out-edges, deterministic descending weights 0.90 → 0.55.
    const relDsts = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'];
    relDsts.forEach((id, i) => {
      store.upsertNode({ id, type: 'fact', value: `relation target ${id}`, origin: 'observed', s: 0.5 });
      store.upsertEdge({ src: 'seed', dst: id, rel: 'related', w: 0.9 - i * 0.05, kind: 'relation' });
    });

    // Non-relation edges at HIGHER weight than any relation edge — must never leak (D-05).
    store.upsertNode({ id: 'abs1', type: 'schema', value: 'abstract target', origin: 'observed', s: 0.5 });
    store.upsertEdge({ src: 'seed', dst: 'abs1', rel: 'abstracts', w: 0.99, kind: 'abstracts' });
    store.upsertNode({ id: 'doc1', type: 'doc', value: 'doc target', origin: 'observed', s: 0.5 });
    store.upsertEdge({ src: 'seed', dst: 'doc1', rel: 'doc_link', w: 0.98, kind: 'doc_link' });

    // Tombstoned relation edge at the HIGHEST weight — must be excluded WITHOUT
    // displacing a live hop from a top-N slot (D-07, Pitfall 2: filter-before-truncate).
    store.upsertNode({ id: 'dead1', type: 'fact', value: 'dead target', origin: 'observed', s: 0.5 });
    store.upsertEdge({ src: 'seed', dst: 'dead1', rel: 'related', w: 0.99, kind: 'relation' });
    store.tombstone('dead1');

    const sink = new MockActivationTraceSink();
    const engine = new RetrievalEngine(db, clock, BASE_CONFIG, retriever, store, strength, gate, sink);

    const results = engine.retrieveRanked(makeVec(0), 5, 0.0);

    expect(results.map(r => r.id)).toEqual(['seed']);
    expect(sink.traces).toHaveLength(1);
    const trace = sink.traces[0]!;

    // Seed shape + real score (D-06) — never null, never fabricated.
    expect(trace.seeds).toHaveLength(1);
    const seedObj = trace.seeds[0] as any;
    expect(seedObj.node_id).toBe('seed');
    expect(typeof seedObj.score).toBe('number');
    expect(seedObj.score).not.toBeNull();

    // Real-edge cross-check (SC3): every emitted hop is an actual out-edge of the seed.
    const realOutEdgeDsts = new Set(store.getOutEdgesWithRel('seed').map(e => e.dst));
    trace.hops.forEach(h => expect(realOutEdgeDsts.has(h.node_id)).toBe(true));

    // Src-pairing honesty (SC3, Phase 55 edge lines): every hop carries `src` = the ACTUAL
    // seed it is a real out-edge of (never a guessed seeds[0]). Here the sole seed is 'seed',
    // and (src → node_id) MUST be a genuine relation edge in the store — this is the property
    // that makes the drawn pathway honest rather than fabricated.
    trace.hops.forEach(h => {
      expect((h as any).src).toBe('seed');
      const realPairs = new Set(
        store.getOutEdgesWithRel((h as any).src).filter(e => e.kind === 'relation').map(e => e.dst),
      );
      expect(realPairs.has(h.node_id)).toBe(true);
    });

    // Kind-allowlist guard (D-05): only kind='relation' dsts ever appear as hops.
    expect(trace.hops.some(h => h.node_id === 'abs1')).toBe(false);
    expect(trace.hops.some(h => h.node_id === 'doc1')).toBe(false);

    // Liveness guard (D-07): tombstoned dst absent AND live-hop count not reduced
    // by the dead high-weight edge displacing a live one from the top-N slots.
    expect(trace.hops.some(h => h.node_id === 'dead1')).toBe(false);

    // Top-N cap guard (D-01/D-02): 8 live relation edges > AMBIENT_HOP_TOPN (6) —
    // asserted against the literal engine default (not exported; see plan discretion).
    expect(trace.hops.length).toBe(6);
    // Confirms weight-sort correctness too: top-6 by weight among the 8 live edges
    // are r1..r6 (0.90..0.65); r7/r8 (0.60/0.55) are truncated, not the tombstoned dead1.
    expect(trace.hops.map(h => h.node_id).sort()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);

    // Score-honesty split (D-06/WR-02): every hop is score:null/hop:1 (rank-only,
    // no fabricated magnitude), while the seed above carries the real measured score.
    trace.hops.forEach(h => {
      expect(h.score).toBeNull();
      expect(h.hop).toBe(1);
    });
  });

  it('D-03 tiebreak: equal-weight relation edges resolve deterministically (dst id ascending)', () => {
    const { clock, store, retriever, strength, gate } = makeRetrievalDeps(db);
    store.upsertNode({ id: 'seed2', type: 'fact', value: 'seed fact 2', origin: 'observed', s: 0.8 });
    store.setEmbedding('seed2', makeVec(0));

    // 3 relation edges, identical weight, dst ids intentionally out of alpha order.
    ['zzz', 'aaa', 'mmm'].forEach(id => {
      store.upsertNode({ id, type: 'fact', value: `tie target ${id}`, origin: 'observed', s: 0.5 });
      store.upsertEdge({ src: 'seed2', dst: id, rel: 'related', w: 0.5, kind: 'relation' });
    });

    const sink = new MockActivationTraceSink();
    const engine = new RetrievalEngine(db, clock, BASE_CONFIG, retriever, store, strength, gate, sink);
    engine.retrieveRanked(makeVec(0), 5, 0.0);

    expect(sink.traces).toHaveLength(1);
    const hopIds = sink.traces[0]!.hops.map(h => h.node_id);
    expect(hopIds).toEqual(['aaa', 'mmm', 'zzz']);
  });
});
