/**
 * remember-cli tests — Phase 33, Plan 33-01.
 *
 * Covers the 5 required behaviors:
 *  Test 1: INSERT path (no neighbor) — stores verbatim, seeds high s/c, scopes, emits 'unrelated'
 *  Test 2: CONTRADICT → reconcile — tombstones old, mints new, emits 'contradict_reconcile', FK clean
 *  Test 3: D-04 force-reconcile — high-resistance node + explicit remember STILL lands
 *  Test 4: D-03 passive resistance — seeded s/c makes high-resistance node hold against passive PE
 *  Test 5: idempotent re-insert — byte-identical re-remember is a no-op (no duplicate live node)
 *
 * Test strategy: call `runRemember` directly (exported from remember-cli.ts) with a stub
 * judge/embed provider — NO real `claude -p` / NO network. Tests are deterministic + offline.
 * The stub embed returns a fixed Float32Array; the stub judge returns a configurable verdict.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG, type EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { EventStore } from '../src/db/event-store';
import { SQLiteConsolidationSink } from '../src/consolidation/sink';
import { StrengthDecayManager } from '../src/strength/decay';
import { routeContradiction } from '../src/consolidation/update-decision';
import { newId } from '../src/lib/hash';
import { runRemember } from '../src/adapter/remember-cli';

// ---------------------------------------------------------------------------
// Config and harness
// ---------------------------------------------------------------------------

const TEST_CONFIG: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };
const DIMS = 16;

interface Harness {
  db: Database.Database;
  store: SemanticStore;
  sink: SQLiteConsolidationSink;
  strength: StrengthDecayManager;
  clock: FakeClock;
}

function makeHarness(): Harness {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const clock = new FakeClock(1_000_000);
  const store = new SemanticStore(db, clock, TEST_CONFIG);
  const eventStore = new EventStore(db);
  const sink = new SQLiteConsolidationSink(eventStore, clock);
  const strength = new StrengthDecayManager(db, clock, TEST_CONFIG);
  return { db, store, sink, strength, clock };
}

/**
 * Build a unit Float32Array (cosine with itself = 1.0).
 * All test embeddings use this so topk always finds them above the cosine floor.
 */
function unitVec(dims: number = DIMS): Float32Array {
  return new Float32Array(dims).fill(1 / Math.sqrt(dims));
}

/**
 * A slightly different vector that still has cosine ≥ NEIGHBOR_COSINE_FLOOR (0.30).
 * Used to seed existing nodes so topk nominates them as candidates.
 */
function neighborVec(dims: number = DIMS): Float32Array {
  const v = new Float32Array(dims).fill(1 / Math.sqrt(dims));
  // Slightly modify to distinguish from unitVec, but cosine stays high (~0.97)
  if (v[0] !== undefined) v[0] = 1.5 / Math.sqrt(dims);
  // Re-normalize
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / mag);
}

/**
 * Stub embed provider: returns a fixed Float32Array for every text.
 * The returned vector is pre-normalized (unit vector) so topk cosines are predictable.
 */
function makeStubProvider(verdict?: {
  best_candidate_id: string | null;
  relation: string;
  magnitude: number;
}) {
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => unitVec(DIMS));
    },
    async judge(
      _claim: string,
      _candidates: Array<{ id: string; value: string }>,
    ): Promise<{ best_candidate_id: string | null; relation: string; magnitude: number }> {
      if (verdict) return verdict;
      return { best_candidate_id: null, relation: 'unrelated', magnitude: 0 };
    },
  };
}

/**
 * Stub retriever: returns a fixed candidate list.
 */
function makeStubRetriever(hits: Array<{ id: string; score: number }> = []) {
  return {
    topk(_queryVec: Float32Array, _k: number): Array<{ id: string; score: number }> {
      return hits;
    },
  };
}

/**
 * Insert a live fact node with a known embedding.
 * Mirrors the pattern in dedup-entities-cli.test.ts.
 */
function insertFactNode(
  db: Database.Database,
  opts: {
    id: string;
    value: string;
    embedding?: Float32Array;
    s?: number;
    c?: number;
    last_access?: number;
    prev_value?: string | null;
  },
): void {
  const { id, value, embedding, s = 0.5, c = 0.5, last_access = 1_000_000, prev_value = null } = opts;

  const embBuf = embedding
    ? Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
    : null;

  // Compute value_hash manually (mirrors SemanticStore.upsertNode)
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const value_hash = crypto.createHash('sha256').update(value).digest('hex');

  db.prepare(
    `INSERT OR REPLACE INTO node (id, type, value, value_hash, origin, s, c, last_access,
      prev_value, pending_contradictions, tombstoned, training_eligible, embedding, embedded_hash)
     VALUES (?, 'fact', ?, ?, 'observed', ?, ?, ?,
      ?, '[]', 0, 0, ?, NULL)`,
  ).run(id, value, value_hash, s, c, last_access, prev_value, embBuf);

  // Sync to FTS
  db.prepare(`INSERT OR REPLACE INTO node_fts (node_id, value) VALUES (?, ?)`).run(id, value);
}

// ---------------------------------------------------------------------------
// Helper: query consolidation events from DB
// ---------------------------------------------------------------------------

function getEvents(db: Database.Database): Array<{
  event_type: string;
  node_id: string | null;
  candidate_id: string | null;
}> {
  return db
    .prepare(`SELECT event_type, node_id, candidate_id FROM consolidation_event ORDER BY ts`)
    .all() as Array<{ event_type: string; node_id: string | null; candidate_id: string | null }>;
}

// ---------------------------------------------------------------------------
// Test 1: INSERT path (no neighbor)
// ---------------------------------------------------------------------------

describe('Test 1: INSERT, no neighbor', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('stores verbatim, seeds high s/c, creates node_scope row, emits unrelated event, no tombstones', async () => {
    const provider = makeStubProvider(); // no verdict needed — no candidates
    const retriever = makeStubRetriever([]); // no neighbors

    const result = await runRemember(
      h.db, h.store, h.sink, h.strength, h.clock, TEST_CONFIG,
      provider, retriever,
      'api budget is ~$8 left',
      'brain-memory',
    );

    expect(result.action).toBe('insert');

    // Node exists, is live, verbatim value, seeded high s/c
    const node = h.store.getNode(result.newNodeId);
    expect(node).not.toBeNull();
    expect(node!.value).toBe('api budget is ~$8 left');
    expect(node!.origin).toBe('asserted_by_user');
    expect(node!.tombstoned).toBe(0);
    expect(node!.s).toBeGreaterThan(0.5);
    expect(node!.c).toBeGreaterThan(0.5);

    // node_scope row exists with the resolved scope
    const scope = h.store.getNodeScope(result.newNodeId);
    expect(scope).toBe('brain-memory');

    // Exactly one consolidation event of type 'unrelated'
    const events = getEvents(h.db);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('unrelated');
    expect(events[0]!.candidate_id).toBeNull();

    // No tombstones anywhere
    const tombstoned = h.db.prepare(`SELECT COUNT(*) as n FROM node WHERE tombstoned = 1`).get() as { n: number };
    expect(tombstoned.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: CONTRADICT → reconcile
// ---------------------------------------------------------------------------

describe('Test 2: CONTRADICT → reconcile', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('tombstones old belief, mints new node, emits exactly one contradict_reconcile, FK clean', async () => {
    const existingId = newId();
    const existingValue = 'api budget ~$14-15 left';
    insertFactNode(h.db, {
      id: existingId,
      value: existingValue,
      embedding: neighborVec(),
      s: 0.5,
      c: 0.5,
    });

    const newValue = 'api budget is ~$8 left';
    const provider = makeStubProvider({
      best_candidate_id: existingId,
      relation: 'contradict',
      magnitude: 0.6,
    });
    const retriever = makeStubRetriever([{ id: existingId, score: 0.8 }]);

    const result = await runRemember(
      h.db, h.store, h.sink, h.strength, h.clock, TEST_CONFIG,
      provider, retriever,
      newValue,
      'brain-memory',
    );

    expect(result.action).toBe('reconcile');
    expect(result.supersededNodeId).toBe(existingId);
    expect(result.prevValue).toBe(existingValue);

    // Old node tombstoned
    const oldNode = h.store.getNode(existingId);
    expect(oldNode).not.toBeNull();
    expect(oldNode!.tombstoned).toBe(1);

    // New node is live with correct value and prev_value breadcrumb
    const newNode = h.store.getNode(result.newNodeId);
    expect(newNode).not.toBeNull();
    expect(newNode!.value).toBe(newValue);
    expect(newNode!.origin).toBe('asserted_by_user');
    expect(newNode!.tombstoned).toBe(0);
    expect(newNode!.prev_value).toBe(existingValue);

    // Exactly one 'contradict_reconcile' consolidation_event
    const events = getEvents(h.db);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('contradict_reconcile');
    expect(events[0]!.node_id).toBe(result.newNodeId);
    expect(events[0]!.candidate_id).toBe(existingId);

    // FK integrity check
    const fkCheck = h.db.pragma('foreign_key_check') as unknown[];
    expect(fkCheck).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 3: D-04 force-reconcile
// ---------------------------------------------------------------------------

describe('Test 3: D-04 force-reconcile — high-resistance node still lands', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('proves D-04 override is load-bearing: routeContradiction returns hold but correction still applies', async () => {
    // Seed the existing belief with VERY HIGH s/c so routeContradiction returns 'hold'
    // for a low-to-moderate PE magnitude.
    const highS = 0.98;
    const highC = 0.99;
    const existingId = newId();
    const existingValue = 'api budget ~$14-15 left';
    insertFactNode(h.db, {
      id: existingId,
      value: existingValue,
      embedding: neighborVec(),
      s: highS,
      c: highC,
      last_access: 1_000_000, // same as clock → no decay → effectiveS ≈ highS
    });

    // With magnitude=0.15 and resistance = highS * highC ≈ 0.97, ratio ≈ 0.154 << peReconcileBandLow
    // routeContradiction should return 'hold' → D-04 must override to 'reconcile'
    const testMagnitude = 0.15;
    const effectiveS = highS; // clock is at last_access so Δt≈0 → no decay
    const resistance = effectiveS * highC;

    // Assert that without D-04, routeContradiction returns 'hold' for this magnitude/resistance
    // This proves the D-04 override is load-bearing (not a no-op)
    const naturalAction = routeContradiction(testMagnitude, resistance, TEST_CONFIG);
    expect(naturalAction).toBe('hold');

    // Now run remember with a judge verdict of contradict+same magnitude
    const newValue = 'api budget is ~$8 left';
    const provider = makeStubProvider({
      best_candidate_id: existingId,
      relation: 'contradict',
      magnitude: testMagnitude,
    });
    const retriever = makeStubRetriever([{ id: existingId, score: 0.8 }]);

    const result = await runRemember(
      h.db, h.store, h.sink, h.strength, h.clock, TEST_CONFIG,
      provider, retriever,
      newValue,
      'brain-memory',
    );

    // D-04: the explicit remember MUST reconcile despite 'hold' routing
    expect(result.action).toBe('reconcile');

    // Old node tombstoned
    const oldNode = h.store.getNode(existingId);
    expect(oldNode!.tombstoned).toBe(1);

    // New node is live
    const newNode = h.store.getNode(result.newNodeId);
    expect(newNode!.value).toBe(newValue);
    expect(newNode!.tombstoned).toBe(0);

    // Exactly one contradict_reconcile event
    const events = getEvents(h.db);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe('contradict_reconcile');
  });
});

// ---------------------------------------------------------------------------
// Test 4: D-03 passive resistance — NOT exercised by explicit remember
// ---------------------------------------------------------------------------

describe('Test 4: D-03 passive resistance via the pure routing function', () => {
  it('proves that a remember-seeded node would hold against a typical passive PE magnitude', () => {
    // A remember-created node gets SEED_S=0.9, SEED_C=0.95
    // Resistance = effectiveStrength(0.9, now, now, λ) * 0.95 ≈ 0.9 * 0.95 = 0.855
    // (Δt ≈ 0 at creation: no decay yet)
    const SEED_S = 0.9;
    const SEED_C = 0.95;
    const typicalPassiveMagnitude = 0.4; // typical sleep-pass PE for observed contradiction
    const resistance = SEED_S * SEED_C; // ≈ 0.855 (Δt=0 so effectiveS = s)

    // The passive path (sleep pass) routes through routeContradiction WITHOUT D-04 override
    const passiveAction = routeContradiction(typicalPassiveMagnitude, resistance, TEST_CONFIG);

    // D-03: the high resistance should yield 'hold' for a typical passive magnitude
    // (ratio = 0.4 / 0.855 ≈ 0.468, compared to DEFAULT_CONFIG.peReconcileBandLow)
    expect(passiveAction).toBe('hold');
  });
});

// ---------------------------------------------------------------------------
// Test 5: idempotent re-insert
// ---------------------------------------------------------------------------

describe('Test 5: idempotent re-insert — byte-identical re-remember is a no-op', () => {
  let h: Harness;
  beforeEach(() => { h = makeHarness(); });

  it('second remember of byte-identical text does not create a duplicate live node', async () => {
    const verbatimText = 'api budget is ~$8 left';
    const provider = makeStubProvider({
      best_candidate_id: null,
      relation: 'unrelated',
      magnitude: 0,
    });
    const retriever = makeStubRetriever([]);

    // First remember — should store a new node
    const result1 = await runRemember(
      h.db, h.store, h.sink, h.strength, h.clock, TEST_CONFIG,
      provider, retriever,
      verbatimText,
      'brain-memory',
    );
    expect(result1.action).toBe('insert');
    expect(result1.newNodeId).toBeDefined();

    // Clear events counter to see only second-call effects
    const eventsAfterFirst = getEvents(h.db);
    const firstEventCount = eventsAfterFirst.length;

    // Second remember — byte-identical text should be a no-op (idempotency guard)
    const result2 = await runRemember(
      h.db, h.store, h.sink, h.strength, h.clock, TEST_CONFIG,
      provider, retriever,
      verbatimText,
      'brain-memory',
    );

    // The second call returns the first call's node id (no duplicate)
    expect(result2.newNodeId).toBe(result1.newNodeId);
    expect(result2.action).toBe('insert'); // short-circuit returns 'insert' with existing id

    // No new consolidation events were emitted for the second call
    const eventsAfterSecond = getEvents(h.db);
    expect(eventsAfterSecond.length).toBe(firstEventCount); // no new events

    // Only one live node with the verbatim value exists
    const liveNodes = h.db
      .prepare(`SELECT id FROM node WHERE value = ? AND tombstoned = 0`)
      .all(verbatimText) as Array<{ id: string }>;
    expect(liveNodes).toHaveLength(1);
    expect(liveNodes[0]!.id).toBe(result1.newNodeId);

    // FK integrity check
    const fkCheck = h.db.pragma('foreign_key_check') as unknown[];
    expect(fkCheck).toHaveLength(0);
  });
});
