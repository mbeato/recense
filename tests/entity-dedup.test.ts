/**
 * EntityDedup unit tests — Phase 25, Plan 25-01.
 *
 * Tests use the in-memory harness pattern from node-scope-store.test.ts:
 * `new Database(':memory:')` + `initSchema(db)` + `FakeClock` + `SemanticStore`.
 *
 * Cases covered:
 *  Test 1  — repeatability (DEDUP-01): second run returns 0 merges
 *  Test 2  — edge inheritance (DEDUP-02): duplicate edge rewired to canonical
 *  Test 3  — PK collision merge (D-07): max(w), latest last_access survives
 *  Test 4  — self-loop drop (D-07): canonical→canonical edge not written
 *  Test 5  — tombstone-not-delete (D-09): duplicate row exists with tombstoned=1
 *  Test 6  — FK clean (D-08): PRAGMA foreign_key_check empty after run
 *  Test 7  — origin guard (D-04): mid-reconciliation or cross-origin non-identical never merged
 *  Test 8  — provenance event (D-10): consolidation_event row with event_type='entity_merge'
 *  Test 9  — canonical selection (D-05): highest-degree node chosen canonical
 *  Test 10 — transitive cluster (D-03): A~B + B~C collapses to one canonical for {A,B,C}
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
import { EntityDedup } from '../src/consolidation/entity-dedup';

const TEST_CONFIG: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface Harness {
  db: Database.Database;
  store: SemanticStore;
  sink: MockConsolidationSink;
  clock: FakeClock;
  dedup: EntityDedup;
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
  const dedup = new EntityDedup(db, store, sink, clock, TEST_CONFIG);
  return { db, store, sink, clock, dedup };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a node row directly (bypassing upsertNode so we can set embedding and origin freely).
 * Value-hash is a placeholder; the dedup pass reads embedding not value_hash.
 */
function insertEntityNode(
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
     VALUES (?, 'entity', ?, 'hash-placeholder', ?, 0.5, ?, ?,
      ?, '[]', ?, 0, ?)`,
  ).run(id, value, origin, c, last_access, prev_value, tombstoned, embBuf);
}

/**
 * Build a unit Float32Array of given length (all 1/√dims — produces cosine=1 with another such vector).
 */
function unitVec(dims: number): Float32Array {
  const v = new Float32Array(dims).fill(1 / Math.sqrt(dims));
  return v;
}

/**
 * Build a Float32Array orthogonal to the unit vector (all zeros except last dim = 1).
 * cosine(unitVec, orthogVec) ≈ 1/√dims ≈ 0.026 for dims=1536 — well below 0.88 threshold.
 */
function orthogVec(dims: number): Float32Array {
  const v = new Float32Array(dims);
  v[dims - 1] = 1;
  return v;
}

const DIMS = 16; // Small dims for test speed — cosine math is identical

// ---------------------------------------------------------------------------
// Test 1: Repeatability (DEDUP-01)
// ---------------------------------------------------------------------------
describe('EntityDedup', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('Test 1 — repeatability: second run reports 0 merges', () => {
    const vec = unitVec(DIMS);
    insertEntityNode(h.db, { id: 'n1', value: 'brain memory', embedding: vec });
    insertEntityNode(h.db, { id: 'n2', value: 'brain memory', embedding: vec });

    const first = h.dedup.run({ threshold: 0.88, dryRun: false });
    expect(first.mergedClusters).toBe(1);
    expect(first.tombstoned).toBe(1);

    const second = h.dedup.run({ threshold: 0.88, dryRun: false });
    expect(second.mergedClusters).toBe(0);
    expect(second.tombstoned).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Test 2: Edge inheritance (DEDUP-02)
  // ---------------------------------------------------------------------------

  it('Test 2 — edge inheritance: duplicate edge rewired to canonical after merge', () => {
    const vec = unitVec(DIMS);
    // n1 will become canonical (inserted first, but n2 will have lower degree)
    insertEntityNode(h.db, { id: 'canonical', value: 'brain memory', embedding: vec });
    insertEntityNode(h.db, { id: 'duplicate', value: 'brain memory', embedding: vec });
    // Third node target of the duplicate's edge
    insertEntityNode(h.db, { id: 'target', value: 'some target', embedding: orthogVec(DIMS) });

    // duplicate → target edge (will be rewired to canonical → target)
    h.store.upsertEdge({ src: 'duplicate', dst: 'target', rel: 'related', w: 0.5, kind: 'relation' });

    h.dedup.run({ threshold: 0.88, dryRun: false });

    // The canonical should now have an edge to target
    const canonicalNode = h.store.getNode('canonical');
    expect(canonicalNode).not.toBeNull();
    expect(canonicalNode!.tombstoned).toBe(0);

    const allEdges = h.store.getEdgesForNode('canonical');
    const rewired = allEdges.find(e => e.dst === 'target' && e.rel === 'related');
    expect(rewired).toBeDefined();

    // The old duplicate → target edge should be gone
    const dupEdges = h.store.getEdgesForNode('duplicate');
    const staleEdge = dupEdges.find(e => e.src === 'duplicate' && e.dst === 'target');
    expect(staleEdge).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Test 3: PK collision merge (D-07)
  // ---------------------------------------------------------------------------

  it('Test 3 — PK collision: max(w) + latest last_access survives on edge conflict', () => {
    const vec = unitVec(DIMS);
    insertEntityNode(h.db, { id: 'can', value: 'brain memory', embedding: vec, last_access: 1000 });
    insertEntityNode(h.db, { id: 'dup', value: 'brain memory', embedding: vec, last_access: 900 });
    insertEntityNode(h.db, { id: 'x', value: 'target x', embedding: orthogVec(DIMS) });

    // Both canonical and duplicate have edge to x — canonical has higher w
    h.store.upsertEdge({ src: 'can', dst: 'x', rel: 'uses', w: 0.8, kind: 'relation', last_access: 1000 });
    h.store.upsertEdge({ src: 'dup', dst: 'x', rel: 'uses', w: 0.3, kind: 'relation', last_access: 500 });

    h.dedup.run({ threshold: 0.88, dryRun: false });

    const edges = h.store.getEdgesForNode('can');
    const edge = edges.find(e => e.src === 'can' && e.dst === 'x' && e.rel === 'uses');
    expect(edge).toBeDefined();
    // w should be max(0.8, 0.3) = 0.8
    expect(edge!.w).toBeCloseTo(0.8, 5);
    // last_access should be max(1000, 500) = 1000
    expect(edge!.last_access).toBe(1000);
  });

  // ---------------------------------------------------------------------------
  // Test 4: Self-loop drop (D-07)
  // ---------------------------------------------------------------------------

  it('Test 4 — self-loop drop: canonical→canonical edge not written', () => {
    const vec = unitVec(DIMS);
    insertEntityNode(h.db, { id: 'can', value: 'brain memory', embedding: vec, last_access: 1000 });
    insertEntityNode(h.db, { id: 'dup', value: 'brain memory', embedding: vec, last_access: 900 });

    // dup → can edge: after rewire this becomes can → can (self-loop — must be dropped)
    h.store.upsertEdge({ src: 'dup', dst: 'can', rel: 'alias', w: 0.5, kind: 'relation' });

    h.dedup.run({ threshold: 0.88, dryRun: false });

    const allEdges = h.store.getEdgesForNode('can');
    const selfLoop = allEdges.find(e => e.src === 'can' && e.dst === 'can');
    expect(selfLoop).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Test 5: Tombstone-not-delete (D-09)
  // ---------------------------------------------------------------------------

  it('Test 5 — tombstone-not-delete: duplicate row exists with tombstoned=1 after merge', () => {
    const vec = unitVec(DIMS);
    insertEntityNode(h.db, { id: 'can', value: 'brain memory', embedding: vec, last_access: 1000 });
    insertEntityNode(h.db, { id: 'dup', value: 'brain memory', embedding: vec, last_access: 900 });

    h.dedup.run({ threshold: 0.88, dryRun: false });

    // Duplicate still exists in the DB, just tombstoned
    const dupNode = h.store.getNode('dup');
    expect(dupNode).not.toBeNull();
    expect(dupNode!.tombstoned).toBe(1);

    // Canonical is alive
    const canNode = h.store.getNode('can');
    expect(canNode).not.toBeNull();
    expect(canNode!.tombstoned).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Test 6: FK clean (D-08)
  // ---------------------------------------------------------------------------

  it('Test 6 — FK clean: PRAGMA foreign_key_check returns empty after run', () => {
    const vec = unitVec(DIMS);
    insertEntityNode(h.db, { id: 'can', value: 'brain memory', embedding: vec, last_access: 1000 });
    insertEntityNode(h.db, { id: 'dup', value: 'brain memory', embedding: vec, last_access: 900 });
    insertEntityNode(h.db, { id: 'tgt', value: 'some target', embedding: orthogVec(DIMS) });
    h.store.upsertEdge({ src: 'dup', dst: 'tgt', rel: 'related', w: 0.4, kind: 'relation' });

    h.dedup.run({ threshold: 0.88, dryRun: false });

    const violations = h.db.pragma('foreign_key_check') as unknown[];
    expect(violations).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Test 7: Origin guard (D-04)
  // ---------------------------------------------------------------------------

  it('Test 7 — origin guard: node with non-null prev_value is never merged', () => {
    const vec = unitVec(DIMS);
    // n1 has prev_value set (mid-reconciliation) — must not be merged
    insertEntityNode(h.db, { id: 'n1', value: 'brain memory', embedding: vec, prev_value: 'old brain' });
    insertEntityNode(h.db, { id: 'n2', value: 'brain memory', embedding: vec });

    const result = h.dedup.run({ threshold: 0.88, dryRun: false });
    // No merge should happen because n1 is mid-reconciliation
    expect(result.mergedClusters).toBe(0);
    expect(result.tombstoned).toBe(0);
  });

  it('Test 7b — origin guard: cross-origin non-identical pair not merged', () => {
    // Two nodes with slightly different values (non-identical normalized value)
    // and crossing asserted_by_user↔inferred boundary
    const vec = unitVec(DIMS);
    insertEntityNode(h.db, { id: 'u1', value: 'brain memory project', embedding: vec, origin: 'asserted_by_user' });
    insertEntityNode(h.db, { id: 'i1', value: 'brain memory system', embedding: vec, origin: 'inferred' });

    const result = h.dedup.run({ threshold: 0.88, dryRun: false });
    // Different normalized values → blocked (stage-1 block key differs)
    // Even if they ended up in same bucket due to cosine similarity, origin guard rejects cross-origin non-identical
    expect(result.mergedClusters).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Test 8: Provenance event (D-10)
  // ---------------------------------------------------------------------------

  it('Test 8 — provenance: consolidation_event row with entity_merge after merge', () => {
    const vec = unitVec(DIMS);
    insertEntityNode(h.db, { id: 'can', value: 'brain memory', embedding: vec, last_access: 1000 });
    insertEntityNode(h.db, { id: 'dup', value: 'brain memory', embedding: vec, last_access: 900 });

    h.dedup.run({ threshold: 0.88, dryRun: false });

    const events = h.sink.events.filter(e => e.event_type === 'entity_merge');
    expect(events.length).toBeGreaterThanOrEqual(1);

    const mergeEvent = events.find(e => e.node_id === 'can' && e.candidate_id === 'dup');
    expect(mergeEvent).toBeDefined();
    expect(mergeEvent!.event_type).toBe('entity_merge');
    // magnitude = confirming cosine (≥ threshold)
    expect(mergeEvent!.magnitude).not.toBeNull();
    expect(mergeEvent!.magnitude!).toBeGreaterThanOrEqual(0.88);
  });

  // ---------------------------------------------------------------------------
  // Test 9: Canonical selection (D-05)
  // ---------------------------------------------------------------------------

  it('Test 9 — canonical selection: highest-degree node chosen canonical and keeps its id', () => {
    const vec = unitVec(DIMS);
    // Three nodes all matching
    insertEntityNode(h.db, { id: 'low', value: 'brain memory', embedding: vec, last_access: 1000 });
    insertEntityNode(h.db, { id: 'mid', value: 'brain memory', embedding: vec, last_access: 900 });
    insertEntityNode(h.db, { id: 'high', value: 'brain memory', embedding: vec, last_access: 800 });
    // 'high' and 'low' are extra nodes (not duplicates) to create edge degree differences
    insertEntityNode(h.db, { id: 'x1', value: 'extra1', embedding: orthogVec(DIMS) });
    insertEntityNode(h.db, { id: 'x2', value: 'extra2', embedding: orthogVec(DIMS) });
    insertEntityNode(h.db, { id: 'x3', value: 'extra3', embedding: orthogVec(DIMS) });

    // Give 'high' 3 edges — most-connected, should be canonical
    h.store.upsertEdge({ src: 'high', dst: 'x1', rel: 'r', w: 0.5, kind: 'relation' });
    h.store.upsertEdge({ src: 'high', dst: 'x2', rel: 'r', w: 0.5, kind: 'relation' });
    h.store.upsertEdge({ src: 'high', dst: 'x3', rel: 'r', w: 0.5, kind: 'relation' });
    // 'mid' has 1 edge
    h.store.upsertEdge({ src: 'mid', dst: 'x1', rel: 'r', w: 0.5, kind: 'relation' });
    // 'low' has 0 edges

    h.dedup.run({ threshold: 0.88, dryRun: false });

    // 'high' should survive (most edges)
    const highNode = h.store.getNode('high');
    expect(highNode).not.toBeNull();
    expect(highNode!.tombstoned).toBe(0);

    // 'low' and 'mid' should be tombstoned
    const lowNode = h.store.getNode('low');
    expect(lowNode!.tombstoned).toBe(1);
    const midNode = h.store.getNode('mid');
    expect(midNode!.tombstoned).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Test 10: Transitive cluster (D-03)
  // ---------------------------------------------------------------------------

  it('Test 10 — transitive cluster: A~B + B~C collapses to one canonical for {A,B,C}', () => {
    const vec = unitVec(DIMS);
    // All three match each other (same normalized value + cosine ≥ threshold)
    insertEntityNode(h.db, { id: 'a', value: 'brain memory', embedding: vec, last_access: 1000 });
    insertEntityNode(h.db, { id: 'b', value: 'brain memory', embedding: vec, last_access: 900 });
    insertEntityNode(h.db, { id: 'c', value: 'brain memory', embedding: vec, last_access: 800 });

    const result = h.dedup.run({ threshold: 0.88, dryRun: false });
    expect(result.mergedClusters).toBe(1);
    expect(result.tombstoned).toBe(2); // 2 duplicates tombstoned, 1 canonical survives

    // Exactly one node should have tombstoned=0
    const rows = h.db
      .prepare(`SELECT id, tombstoned FROM node WHERE type='entity'`)
      .all() as Array<{ id: string; tombstoned: number }>;
    const live = rows.filter(r => r.tombstoned === 0);
    const dead = rows.filter(r => r.tombstoned === 1);
    expect(live).toHaveLength(1);
    expect(dead).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Dry-run mode: no writes
  // ---------------------------------------------------------------------------

  it('dry-run: returns clusters without writing any DB changes', () => {
    const vec = unitVec(DIMS);
    insertEntityNode(h.db, { id: 'can', value: 'brain memory', embedding: vec, last_access: 1000 });
    insertEntityNode(h.db, { id: 'dup', value: 'brain memory', embedding: vec, last_access: 900 });

    const result = h.dedup.run({ threshold: 0.88, dryRun: true });
    expect(result.mergedClusters).toBeGreaterThan(0); // would merge

    // No tombstone written
    const dupNode = h.store.getNode('dup');
    expect(dupNode!.tombstoned).toBe(0);

    // No audit events emitted
    expect(h.sink.events.filter(e => e.event_type === 'entity_merge')).toHaveLength(0);
  });
});
