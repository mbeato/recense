/**
 * tests/retrieval-anchor-union.test.ts
 *
 * Phase 69 (Plan 02, RECALL-01/03): locks the union semantics of retrieveRanked's new
 * `opts.anchoredIds` + `opts.hopCollector` extension.
 *
 * Covers:
 *  - Byte-identity regression lock with no new opts (D-09) — a hard-coded expected string so
 *    any future change to the union path that perturbs the default output fails loudly.
 *  - Floor exemption: an anchored id below the cosine floor is returned anyway (RECALL-01).
 *  - No duplication of an anchored id already present via cosine.
 *  - B2/liveness non-exemption: tombstoned, missing, and stale-entity anchored ids are excluded
 *    (T-69-02-BYPASS) — anchoring never bypasses the same guard as cosine hits.
 *  - Honest scoring: real cosine, clamped to [0,1]; null/unusable embedding scores 0, never a
 *    synthesized magnitude (T-69-02-FAKE).
 *  - Single-pass hop hand-off: opts.hopCollector fires once per call with rel-carrying hops; a
 *    counting proxy on getOutEdgesWithRel proves no seed id is read twice even with both the
 *    viz trace sink AND a hopCollector active.
 *
 * Harness: temp FILE DB + real SemanticStore/CandidateRetriever/RetrievalEngine (brute-force
 * retriever path — no `.vindex` artifact). Mirrors tests/recall-scope.test.ts /
 * tests/retrieval.test.ts's B2 stale-entity harness. All fixtures are synthetic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initSchema } from '../src/db/schema';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { FakeClock } from '../src/lib/clock';
import { SemanticStore } from '../src/db/semantic-store';
import { CandidateRetriever } from '../src/retrieval/topk';
import { StrengthDecayManager } from '../src/strength/decay';
import { AllocationGate } from '../src/gate/allocation-gate';
import { RetrievalEngine } from '../src/retrieval/engine';
import { MockActivationTraceSink } from '../src/viz/activation-sink';

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `retrieval-anchor-union-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

let tmpDbPath: string;
let db: Database.Database;
let clock: FakeClock;
let store: SemanticStore;
let retriever: CandidateRetriever;
let strength: StrengthDecayManager;
let gate: AllocationGate;

function config() {
  return { ...DEFAULT_CONFIG, dbPath: tmpDbPath };
}

function makeEngine(sink?: MockActivationTraceSink): RetrievalEngine {
  return sink
    ? new RetrievalEngine(db, clock, config(), retriever, store, strength, gate, sink)
    : new RetrievalEngine(db, clock, config(), retriever, store, strength, gate);
}

beforeEach(() => {
  tmpDbPath = makeTempDbPath();
  const setupDb = new Database(tmpDbPath);
  initSchema(setupDb);
  setupDb.close();
  db = new Database(tmpDbPath);
  clock = new FakeClock(Date.UTC(2026, 0, 1));
  store = new SemanticStore(db, clock, config());
  retriever = new CandidateRetriever(db);
  strength = new StrengthDecayManager(db, clock, config());
  gate = new AllocationGate(config());
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
});

/** Insert a live fact node with an embedding attached. */
function addEmbeddedNode(id: string, value: string, vec: Float32Array, s = 0.8): void {
  store.upsertNode({ id, type: 'fact', value, origin: 'observed', s });
  store.setEmbedding(id, vec);
}

/** Insert a live entity node with an embedding attached (for B2 stale-entity fixtures). */
function addEmbeddedEntityNode(id: string, value: string, vec: Float32Array, s = 0.8): void {
  store.upsertNode({ id, type: 'entity', value, origin: 'observed', s });
  store.setEmbedding(id, vec);
}

/** Link a node to an episode via consolidation_event (for B2 sibling wiring). */
function linkNodeToEpisode(nodeId: string, episodeId: string): void {
  db.prepare(
    'INSERT INTO consolidation_event (id, ts, schema_version, event_type, node_id, episode_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(`ce-${nodeId}-${episodeId}`, Date.now(), 5, 'confirm', nodeId, episodeId);
}

const QUERY_VEC = new Float32Array([1, 0, 0]);
const VEC_A = new Float32Array([1, 0, 0]);           // cosine 1.0
const VEC_B = new Float32Array([0.8, 0.6, 0]);       // cosine ~0.8
const VEC_C = new Float32Array([0.6, 0.8, 0]);       // cosine ~0.6
const VEC_BELOW_FLOOR = new Float32Array([0.3, Math.sqrt(1 - 0.09), 0]); // cosine ~0.3, below 0.45
const VEC_ORTHOGONAL = new Float32Array([0, 1, 0]);  // cosine 0.0 vs QUERY_VEC

describe('retrieveRanked anchored union (RECALL-01/03)', () => {
  it('Test 1: byte-identity regression lock — no new opts, output unchanged (D-09)', () => {
    addEmbeddedNode('node-a', 'fact alpha', VEC_A);
    addEmbeddedNode('node-b', 'fact bravo', VEC_B);
    addEmbeddedNode('node-c', 'fact charlie', VEC_C);

    const engine = makeEngine();
    const result = engine.retrieveRanked(QUERY_VEC, 5, 0.45, undefined, { vizFloor: 0.25 });

    // Hard-coded expected string (verbatim engine output, including float32-imprecise cosine
    // digits) — any future change to the union path that perturbs the default output fails
    // loudly here rather than drifting silently.
    expect(JSON.stringify(result)).toBe(
      '[{"id":"node-a","value":"fact alpha","score":1},{"id":"node-b","value":"fact bravo","score":0.7999999928474427},{"id":"node-c","value":"fact charlie","score":0.6000000095367428}]',
    );
  });

  it('Test 2: opts.anchoredIds containing a live node BELOW the cosine floor causes it to appear', () => {
    addEmbeddedNode('node-a', 'fact alpha', VEC_A);
    addEmbeddedNode('node-below', 'fact below floor', VEC_BELOW_FLOOR);

    const engine = makeEngine();
    const withoutAnchor = engine.retrieveRanked(QUERY_VEC, 5, 0.45);
    expect(withoutAnchor.map(r => r.id)).not.toContain('node-below');

    const withAnchor = engine.retrieveRanked(QUERY_VEC, 5, 0.45, undefined, {
      anchoredIds: ['node-below'],
    });
    const row = withAnchor.find(r => r.id === 'node-below');
    expect(row).toBeDefined();
    expect(row!.score).toBeCloseTo(0.3, 3);
  });

  it('Test 3: an anchored id already present in the cosine hits is not duplicated', () => {
    addEmbeddedNode('node-a', 'fact alpha', VEC_A);

    const engine = makeEngine();
    const result = engine.retrieveRanked(QUERY_VEC, 5, 0.45, undefined, {
      anchoredIds: ['node-a'],
    });

    expect(result.filter(r => r.id === 'node-a')).toHaveLength(1);
  });

  it('Test 4a: a tombstoned anchored id is NOT returned (B2/liveness non-exemption)', () => {
    addEmbeddedNode('node-dead', 'fact dead', VEC_A);
    store.tombstone('node-dead');

    const engine = makeEngine();
    const result = engine.retrieveRanked(QUERY_VEC, 5, 0.45, undefined, {
      anchoredIds: ['node-dead'],
    });

    expect(result.map(r => r.id)).not.toContain('node-dead');
  });

  it('Test 4b: a missing anchored id is silently absent (no throw)', () => {
    addEmbeddedNode('node-a', 'fact alpha', VEC_A);

    const engine = makeEngine();
    expect(() =>
      engine.retrieveRanked(QUERY_VEC, 5, 0.45, undefined, { anchoredIds: ['does-not-exist'] }),
    ).not.toThrow();
    const result = engine.retrieveRanked(QUERY_VEC, 5, 0.45, undefined, {
      anchoredIds: ['does-not-exist'],
    });
    expect(result.map(r => r.id)).not.toContain('does-not-exist');
  });

  it('Test 4c: an anchored id in the B2 stale-entity exclusion set is NOT returned', () => {
    // Entity + its only fact-sibling share an episode; the fact-sibling is tombstoned, so the
    // entity itself is B2-stale — anchoring must not bypass this (T-69-02-BYPASS).
    addEmbeddedEntityNode('ent-stale', 'Ana', VEC_A);
    addEmbeddedNode('fact-stale', 'Ana lives in Denver', VEC_A);
    linkNodeToEpisode('ent-stale', 'ep-100');
    linkNodeToEpisode('fact-stale', 'ep-100');
    store.tombstone('fact-stale');

    const engine = makeEngine();
    const result = engine.retrieveRanked(QUERY_VEC, 5, 0.45, undefined, {
      anchoredIds: ['ent-stale'],
    });

    expect(result.map(r => r.id)).not.toContain('ent-stale');
  });

  it('Test 5a: an anchored row with a real ORTHOGONAL embedding scores exactly 0 after the [0,1] clamp', () => {
    addEmbeddedNode('node-orth', 'fact orthogonal', VEC_ORTHOGONAL);

    const engine = makeEngine();
    const result = engine.retrieveRanked(QUERY_VEC, 5, 0.45, undefined, {
      anchoredIds: ['node-orth'],
    });

    const row = result.find(r => r.id === 'node-orth');
    expect(row).toBeDefined();
    expect(row!.score).toBe(0);
  });

  it('Test 5b: an anchored row with a NULL embedding scores 0 and still appears (never invented)', () => {
    // upsertNode with no setEmbedding call → node.embedding stays null.
    store.upsertNode({ id: 'node-noembed', type: 'fact', value: 'fact no embedding', origin: 'observed', s: 0.8 });

    const engine = makeEngine();
    const result = engine.retrieveRanked(QUERY_VEC, 5, 0.45, undefined, {
      anchoredIds: ['node-noembed'],
    });

    const row = result.find(r => r.id === 'node-noembed');
    expect(row).toBeDefined();
    expect(row!.score).toBe(0);
  });

  it('Test 6: opts.hopCollector receives hops for the returned rows exactly once per call', () => {
    addEmbeddedNode('node-a', 'fact alpha', VEC_A);
    addEmbeddedNode('node-nbr', 'fact neighbor', VEC_B);
    store.upsertEdge({ src: 'node-a', dst: 'node-nbr', rel: 'uses', w: 0.9, kind: 'relation' });

    const engine = makeEngine();
    const collected: Array<Array<{ node_id: string; src: string; rel: string; score: null; hop: 1 }>> = [];
    const result = engine.retrieveRanked(QUERY_VEC, 5, 0.45, undefined, {
      hopCollector: hops => collected.push(hops),
    });

    expect(collected).toHaveLength(1); // exactly once per call
    const hops = collected[0]!;
    expect(hops.length).toBeGreaterThan(0);
    const resultIds = new Set(result.map(r => r.id));
    for (const hop of hops) {
      expect(resultIds.has(hop.src)).toBe(true); // src is one of the seeds (a returned row)
      expect(typeof hop.rel).toBe('string');
      expect(hop.rel.length).toBeGreaterThan(0);
    }
  });

  it('Test 7: single-pass hop hand-off — getOutEdgesWithRel is never called twice for the same seed, even with both the viz sink AND a hopCollector active', () => {
    addEmbeddedNode('node-a', 'fact alpha', VEC_A);
    addEmbeddedNode('node-nbr', 'fact neighbor', VEC_B);
    store.upsertEdge({ src: 'node-a', dst: 'node-nbr', rel: 'uses', w: 0.9, kind: 'relation' });

    const sink = new MockActivationTraceSink();
    const engine = makeEngine(sink);
    const callCounts = new Map<string, number>();

    // A faithful counting wrapper that still calls through to the real implementation, so the
    // trace/collector logic exercises real edges (not a fabricated stub).
    const realGetOutEdgesWithRel = store.getOutEdgesWithRel.bind(store);
    const countSpy = vi.spyOn(store, 'getOutEdgesWithRel').mockImplementation((id: string) => {
      callCounts.set(id, (callCounts.get(id) ?? 0) + 1);
      return realGetOutEdgesWithRel(id);
    });

    let collectedHops: unknown[] = [];
    engine.retrieveRanked(QUERY_VEC, 5, 0.45, undefined, {
      hopCollector: hops => { collectedHops = hops; },
    });

    for (const [, count] of callCounts) {
      expect(count).toBe(1); // no id read twice across the single shared hop pass
    }
    expect(collectedHops.length).toBeGreaterThan(0);
    expect(sink.traces).toHaveLength(1); // the viz sink still emits exactly once (D-06 shape)

    countSpy.mockRestore();
  });
});
