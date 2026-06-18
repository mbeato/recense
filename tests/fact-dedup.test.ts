/**
 * FactDedup unit tests — Phase 26, Plan 26-08.
 *
 * Mirrors the entity-dedup test harness pattern: `new Database(':memory:')` +
 * `initSchema(db)` + `FakeClock` + `SemanticStore` + `MockConsolidationSink`.
 *
 * Cases covered:
 *  Test 1  — dry-run: tombstones 0, clusters reported
 *  Test 2  — real run tombstones losers + keeps canonical + rewires edges
 *  Test 3  — pollution pair NOT clustered (SUBCHECK_OK excluded, D-05)
 *  Test 4  — "exit code 0" pollution NOT clustered (D-05)
 *  Test 5  — "completed with status" pollution NOT clustered (D-05)
 *  Test 6  — repeatability: second run reports 0 merges (D-02)
 *  Test 7  — tombstone-not-delete: loser row exists with tombstoned=1 (D-09)
 *  Test 8  — FK clean: PRAGMA foreign_key_check empty after run (D-08)
 *  Test 9  — edge rewire: dup edge rewired to canonical after merge (D-07)
 *  Test 10 — canonical selection: highest-degree node chosen canonical (D-05)
 *  Test 11 — origin guard: mid-reconciliation node never merged (D-04)
 *  Test 12 — provenance event: consolidation_event row with fact_merge (D-10)
 *  Test 13 — transitive cluster: A~B + B~C collapses to one canonical (D-03)
 *  Test 14 — distinct facts: non-similar nodes NOT clustered
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { EventStore } from '../src/db/event-store';
import { MockConsolidationSink } from '../src/consolidation/sink';
import { FactDedup, isSelfIngestionPollution } from '../src/consolidation/fact-dedup';

const TEST_CONFIG: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  db: Database.Database;
  store: SemanticStore;
  sink: MockConsolidationSink;
  clock: FakeClock;
  dedup: FactDedup;
}

function makeHarness(): Harness {
  const db = new Database(':memory:');
  // Enable FK enforcement for the harness — same as production
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const clock = new FakeClock(1_000_000);
  const store = new SemanticStore(db, clock, TEST_CONFIG);
  const eventStore = new EventStore(db);
  const sink = new MockConsolidationSink();
  const dedup = new FactDedup(db, store, sink, clock, TEST_CONFIG);
  return { db, store, sink, clock, dedup };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a node row directly (bypassing upsertNode so we can set embedding and origin freely).
 * Value-hash is a placeholder; the dedup pass reads embedding not value_hash.
 */
function insertFactNode(
  db: Database.Database,
  opts: {
    id: string;
    value: string;
    origin?: string;
    prev_value?: string | null;
    c?: number;
    last_access?: number;
    embedding?: Float32Array | null;
    tombstoned?: number;
  },
): void {
  const {
    id,
    value,
    origin = 'observed',
    prev_value = null,
    c = 0.5,
    last_access = 1_000_000,
    embedding = null,
    tombstoned = 0,
  } = opts;

  let embBuf: Buffer | null = null;
  if (embedding) {
    embBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  }

  db.prepare(
    `INSERT INTO node (id, type, value, value_hash, origin, s, c, last_access,
      prev_value, pending_contradictions, tombstoned, training_eligible, embedding)
     VALUES (?, 'fact', ?, 'hash-placeholder', ?, 0.5, ?, ?,
      ?, '[]', ?, 0, ?)`,
  ).run(id, value, origin, c, last_access, prev_value, tombstoned, embBuf);
}

/**
 * Build a unit Float32Array of given length (all 1/√dims — produces cosine=1 with another such vector).
 */
function unitVec(dims: number): Float32Array {
  return new Float32Array(dims).fill(1 / Math.sqrt(dims));
}

/**
 * Build a Float32Array orthogonal to the unit vector (all zeros except last dim = 1).
 * cosine(unitVec, orthogVec) ≈ 1/√dims ≈ 0.026 for dims=16 — well below 0.88 threshold.
 */
function orthogVec(dims: number): Float32Array {
  const v = new Float32Array(dims);
  v[dims - 1] = 1;
  return v;
}

const DIMS = 16; // Small dims for test speed — cosine math is identical

// ---------------------------------------------------------------------------
// isSelfIngestionPollution predicate unit tests
// ---------------------------------------------------------------------------

describe('isSelfIngestionPollution', () => {
  it('matches SUBCHECK_OK', () => {
    expect(isSelfIngestionPollution('Reply with exactly the token SUBCHECK_OK and nothing else')).toBe(true);
    expect(isSelfIngestionPollution('Reply with exactly this token and nothing else: SUBCHECK_OK')).toBe(true);
  });

  it('matches exit code 0 artifact', () => {
    expect(isSelfIngestionPollution('Task b34yx1k6p completed with exit code 0')).toBe(true);
    expect(isSelfIngestionPollution('Task b50b19s3i executed with exit code 0')).toBe(true);
  });

  it('matches completed with status artifact', () => {
    expect(isSelfIngestionPollution('Task a3fb completed successfully')).toBe(true);
    expect(isSelfIngestionPollution('Task a79d completed with status complete')).toBe(true);
  });

  it('does NOT match real facts', () => {
    expect(isSelfIngestionPollution('recense is good for agents but not human readable')).toBe(false);
    expect(isSelfIngestionPollution('User restarted the session')).toBe(false);
    expect(isSelfIngestionPollution('brain memory is the product name')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FactDedup integration tests
// ---------------------------------------------------------------------------

describe('FactDedup', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  // ---------------------------------------------------------------------------
  // Test 1: Dry-run returns clusters but makes no writes
  // ---------------------------------------------------------------------------

  it('Test 1 — dry-run: returns clusters without writing any DB changes', () => {
    const vec = unitVec(DIMS);
    insertFactNode(h.db, { id: 'f1', value: 'brain memory is used by agents', embedding: vec, last_access: 1000 });
    insertFactNode(h.db, { id: 'f2', value: 'brain memory is used by agents', embedding: vec, last_access: 900 });

    const result = h.dedup.run({ threshold: 0.88, dryRun: true });
    expect(result.mergedClusters).toBeGreaterThan(0); // would merge
    expect(result.tombstoned).toBe(0); // dry-run: nothing written

    // No tombstone written
    const f2 = h.store.getNode('f2');
    expect(f2!.tombstoned).toBe(0);

    // No audit events emitted
    expect(h.sink.events.filter(e => e.event_type === 'fact_merge')).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Real run tombstones losers, keeps canonical, rewires edges
  // ---------------------------------------------------------------------------

  it('Test 2 — real run: tombstones losers, keeps canonical, rewires edges', () => {
    const vec = unitVec(DIMS);
    // 'can' has more edges → canonical
    insertFactNode(h.db, { id: 'can', value: 'brain memory is used by agents', embedding: vec, last_access: 1000 });
    insertFactNode(h.db, { id: 'dup', value: 'brain memory is used by agents', embedding: vec, last_access: 900 });
    insertFactNode(h.db, { id: 'tgt', value: 'some target fact', embedding: orthogVec(DIMS) });
    insertFactNode(h.db, { id: 'e1', value: 'extra1', embedding: orthogVec(DIMS) });
    insertFactNode(h.db, { id: 'e2', value: 'extra2', embedding: orthogVec(DIMS) });

    // Give 'can' 3 edges → highest degree → canonical
    h.store.upsertEdge({ src: 'can', dst: 'e1', rel: 'r', w: 0.5, kind: 'relation' });
    h.store.upsertEdge({ src: 'can', dst: 'e2', rel: 'r', w: 0.5, kind: 'relation' });
    // 'dup' → 'tgt' edge (will be rewired to can → tgt)
    h.store.upsertEdge({ src: 'dup', dst: 'tgt', rel: 'related', w: 0.4, kind: 'relation' });

    const result = h.dedup.run({ threshold: 0.88, dryRun: false });
    expect(result.mergedClusters).toBe(1);
    expect(result.tombstoned).toBe(1);

    // canonical survives
    const canNode = h.store.getNode('can');
    expect(canNode).not.toBeNull();
    expect(canNode!.tombstoned).toBe(0);

    // duplicate tombstoned (not deleted)
    const dupNode = h.store.getNode('dup');
    expect(dupNode).not.toBeNull();
    expect(dupNode!.tombstoned).toBe(1);

    // dup → tgt edge rewired to can → tgt
    const canEdges = h.store.getEdgesForNode('can');
    const rewired = canEdges.find(e => e.dst === 'tgt' && e.rel === 'related');
    expect(rewired).toBeDefined();

    // old dup → tgt edge gone
    const stale = h.db
      .prepare('SELECT * FROM edge WHERE src = ? AND dst = ? AND rel = ?')
      .get('dup', 'tgt', 'related');
    expect(stale).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Test 3: SUBCHECK_OK pollution pair NOT clustered (D-05)
  // ---------------------------------------------------------------------------

  it('Test 3 — pollution exclusion: SUBCHECK_OK pair NOT clustered', () => {
    const vec = unitVec(DIMS);
    // Two near-identical pollution values — should NOT form a cluster
    insertFactNode(h.db, {
      id: 'poll1',
      value: 'Reply with exactly the token SUBCHECK_OK and nothing else',
      embedding: vec,
    });
    insertFactNode(h.db, {
      id: 'poll2',
      value: 'Reply with exactly this token and nothing else: SUBCHECK_OK',
      embedding: vec,
    });

    const result = h.dedup.run({ threshold: 0.88, dryRun: false });
    expect(result.mergedClusters).toBe(0);
    expect(result.tombstoned).toBe(0);

    // Both pollution nodes still live and unmodified
    expect(h.store.getNode('poll1')!.tombstoned).toBe(0);
    expect(h.store.getNode('poll2')!.tombstoned).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Test 4: "exit code 0" pollution NOT clustered (D-05)
  // ---------------------------------------------------------------------------

  it('Test 4 — pollution exclusion: "exit code 0" pair NOT clustered', () => {
    const vec = unitVec(DIMS);
    insertFactNode(h.db, {
      id: 'exit1',
      value: 'Task b34yx1k6p completed with exit code 0',
      embedding: vec,
    });
    insertFactNode(h.db, {
      id: 'exit2',
      value: 'Task b50b19s3i executed with exit code 0',
      embedding: vec,
    });

    const result = h.dedup.run({ threshold: 0.88, dryRun: false });
    expect(result.mergedClusters).toBe(0);
    expect(result.tombstoned).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Test 5: "completed with status" pollution NOT clustered (D-05)
  // ---------------------------------------------------------------------------

  it('Test 5 — pollution exclusion: "completed with status" pair NOT clustered', () => {
    const vec = unitVec(DIMS);
    insertFactNode(h.db, {
      id: 'status1',
      value: 'Task a3fb completed successfully',
      embedding: vec,
    });
    insertFactNode(h.db, {
      id: 'status2',
      value: 'Task a79d completed with status complete',
      embedding: vec,
    });

    const result = h.dedup.run({ threshold: 0.88, dryRun: false });
    expect(result.mergedClusters).toBe(0);
    expect(result.tombstoned).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Test 6: Repeatability — second run is a no-op (D-02)
  // ---------------------------------------------------------------------------

  it('Test 6 — repeatability: second run reports 0 merges', () => {
    const vec = unitVec(DIMS);
    insertFactNode(h.db, { id: 'f1', value: 'brain memory is good', embedding: vec });
    insertFactNode(h.db, { id: 'f2', value: 'brain memory is good', embedding: vec });

    const first = h.dedup.run({ threshold: 0.88, dryRun: false });
    expect(first.mergedClusters).toBe(1);
    expect(first.tombstoned).toBe(1);

    const second = h.dedup.run({ threshold: 0.88, dryRun: false });
    expect(second.mergedClusters).toBe(0);
    expect(second.tombstoned).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Test 7: Tombstone-not-delete (D-09)
  // ---------------------------------------------------------------------------

  it('Test 7 — tombstone-not-delete: loser row exists with tombstoned=1', () => {
    const vec = unitVec(DIMS);
    insertFactNode(h.db, { id: 'can', value: 'recense learns from experience', embedding: vec, last_access: 1000 });
    insertFactNode(h.db, { id: 'dup', value: 'recense learns from experience', embedding: vec, last_access: 900 });
    insertFactNode(h.db, { id: 'e1', value: 'extra1', embedding: orthogVec(DIMS) });
    insertFactNode(h.db, { id: 'e2', value: 'extra2', embedding: orthogVec(DIMS) });

    h.store.upsertEdge({ src: 'can', dst: 'e1', rel: 'r', w: 0.5, kind: 'relation' });
    h.store.upsertEdge({ src: 'can', dst: 'e2', rel: 'r', w: 0.5, kind: 'relation' });

    h.dedup.run({ threshold: 0.88, dryRun: false });

    // Loser still in DB with tombstoned=1 (NOT deleted)
    const dupNode = h.store.getNode('dup');
    expect(dupNode).not.toBeNull();
    expect(dupNode!.tombstoned).toBe(1);

    // No raw DELETE was performed — row is just marked
    const row = h.db
      .prepare("SELECT id, tombstoned FROM node WHERE id = 'dup'")
      .get() as { id: string; tombstoned: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.tombstoned).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Test 8: FK clean (D-08)
  // ---------------------------------------------------------------------------

  it('Test 8 — FK clean: PRAGMA foreign_key_check empty after run', () => {
    const vec = unitVec(DIMS);
    insertFactNode(h.db, { id: 'can', value: 'recense is open source', embedding: vec, last_access: 1000 });
    insertFactNode(h.db, { id: 'dup', value: 'recense is open source', embedding: vec, last_access: 900 });
    insertFactNode(h.db, { id: 'tgt', value: 'target node', embedding: orthogVec(DIMS) });
    insertFactNode(h.db, { id: 'e1', value: 'e1', embedding: orthogVec(DIMS) });
    insertFactNode(h.db, { id: 'e2', value: 'e2', embedding: orthogVec(DIMS) });

    h.store.upsertEdge({ src: 'can', dst: 'e1', rel: 'r', w: 0.5, kind: 'relation' });
    h.store.upsertEdge({ src: 'can', dst: 'e2', rel: 'r', w: 0.5, kind: 'relation' });
    h.store.upsertEdge({ src: 'dup', dst: 'tgt', rel: 'related', w: 0.4, kind: 'relation' });

    h.dedup.run({ threshold: 0.88, dryRun: false });

    const violations = h.db.pragma('foreign_key_check') as unknown[];
    expect(violations).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 9: Canonical selection (D-05)
  // ---------------------------------------------------------------------------

  it('Test 10 — canonical selection: highest-degree fact node chosen canonical', () => {
    const vec = unitVec(DIMS);
    insertFactNode(h.db, { id: 'low', value: 'recense has good performance', embedding: vec, last_access: 1000 });
    insertFactNode(h.db, { id: 'mid', value: 'recense has good performance', embedding: vec, last_access: 900 });
    insertFactNode(h.db, { id: 'high', value: 'recense has good performance', embedding: vec, last_access: 800 });
    insertFactNode(h.db, { id: 'x1', value: 'extra1', embedding: orthogVec(DIMS) });
    insertFactNode(h.db, { id: 'x2', value: 'extra2', embedding: orthogVec(DIMS) });
    insertFactNode(h.db, { id: 'x3', value: 'extra3', embedding: orthogVec(DIMS) });

    // Give 'high' 3 edges — most-connected, should be canonical
    h.store.upsertEdge({ src: 'high', dst: 'x1', rel: 'r', w: 0.5, kind: 'relation' });
    h.store.upsertEdge({ src: 'high', dst: 'x2', rel: 'r', w: 0.5, kind: 'relation' });
    h.store.upsertEdge({ src: 'high', dst: 'x3', rel: 'r', w: 0.5, kind: 'relation' });
    h.store.upsertEdge({ src: 'mid', dst: 'x1', rel: 'r', w: 0.5, kind: 'relation' });

    h.dedup.run({ threshold: 0.88, dryRun: false });

    // 'high' survives (most edges)
    expect(h.store.getNode('high')!.tombstoned).toBe(0);
    // 'low' and 'mid' tombstoned
    expect(h.store.getNode('low')!.tombstoned).toBe(1);
    expect(h.store.getNode('mid')!.tombstoned).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Test 11: Origin guard — mid-reconciliation node never merged (D-04)
  // ---------------------------------------------------------------------------

  it('Test 11 — origin guard: mid-reconciliation node never merged', () => {
    const vec = unitVec(DIMS);
    // n1 has prev_value set (mid-reconciliation) — must not be merged
    insertFactNode(h.db, { id: 'n1', value: 'recense stores facts', embedding: vec, prev_value: 'old fact' });
    insertFactNode(h.db, { id: 'n2', value: 'recense stores facts', embedding: vec });

    const result = h.dedup.run({ threshold: 0.88, dryRun: false });
    expect(result.mergedClusters).toBe(0);
    expect(result.tombstoned).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Test 12: Provenance event (D-10)
  // ---------------------------------------------------------------------------

  it('Test 12 — provenance: consolidation_event row with fact_merge after merge', () => {
    const vec = unitVec(DIMS);
    insertFactNode(h.db, { id: 'can', value: 'recense is fast', embedding: vec, last_access: 1000 });
    insertFactNode(h.db, { id: 'dup', value: 'recense is fast', embedding: vec, last_access: 900 });
    insertFactNode(h.db, { id: 'e1', value: 'e1', embedding: orthogVec(DIMS) });
    insertFactNode(h.db, { id: 'e2', value: 'e2', embedding: orthogVec(DIMS) });

    h.store.upsertEdge({ src: 'can', dst: 'e1', rel: 'r', w: 0.5, kind: 'relation' });
    h.store.upsertEdge({ src: 'can', dst: 'e2', rel: 'r', w: 0.5, kind: 'relation' });

    h.dedup.run({ threshold: 0.88, dryRun: false });

    const events = h.sink.events.filter(e => e.event_type === 'fact_merge');
    expect(events.length).toBeGreaterThanOrEqual(1);

    const mergeEvent = events.find(e => e.node_id === 'can' && e.candidate_id === 'dup');
    expect(mergeEvent).toBeDefined();
    expect(mergeEvent!.event_type).toBe('fact_merge');
    expect(mergeEvent!.magnitude).not.toBeNull();
    expect(mergeEvent!.magnitude!).toBeGreaterThanOrEqual(0.88);
  });

  // ---------------------------------------------------------------------------
  // Test 13: Transitive cluster (D-03)
  // ---------------------------------------------------------------------------

  it('Test 13 — transitive cluster: A~B + B~C collapses to one canonical', () => {
    const vec = unitVec(DIMS);
    insertFactNode(h.db, { id: 'a', value: 'recense remembers', embedding: vec, last_access: 1000 });
    insertFactNode(h.db, { id: 'b', value: 'recense remembers', embedding: vec, last_access: 900 });
    insertFactNode(h.db, { id: 'c', value: 'recense remembers', embedding: vec, last_access: 800 });

    const result = h.dedup.run({ threshold: 0.88, dryRun: false });
    expect(result.mergedClusters).toBe(1);
    expect(result.tombstoned).toBe(2); // 2 duplicates tombstoned, 1 canonical survives

    const rows = h.db
      .prepare("SELECT id, tombstoned FROM node WHERE type='fact'")
      .all() as Array<{ id: string; tombstoned: number }>;
    const live = rows.filter(r => r.tombstoned === 0);
    const dead = rows.filter(r => r.tombstoned === 1);
    expect(live).toHaveLength(1);
    expect(dead).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Test 14: Distinct facts NOT clustered
  // ---------------------------------------------------------------------------

  it('Test 14 — distinct facts: non-similar nodes NOT clustered', () => {
    const vec = unitVec(DIMS);
    const ortho = orthogVec(DIMS);
    // These have the same normalized value but very different embeddings
    // Actually use truly different values so they're in different buckets too
    insertFactNode(h.db, { id: 'a', value: 'recense stores memories efficiently', embedding: vec });
    insertFactNode(h.db, { id: 'b', value: 'the weather is nice today', embedding: ortho });

    const result = h.dedup.run({ threshold: 0.88, dryRun: false });
    expect(result.mergedClusters).toBe(0);
    expect(result.tombstoned).toBe(0);

    // Both nodes still live
    expect(h.store.getNode('a')!.tombstoned).toBe(0);
    expect(h.store.getNode('b')!.tombstoned).toBe(0);
  });
});
