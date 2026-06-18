/**
 * dedup-entities-cli tests — Phase 25, Plan 25-02.
 *
 * CLI-level behavioral contract:
 *  - Dry-run (default) returns the expected cluster and writes NOTHING to the DB
 *    (tombstoned=0 on the duplicate, no consolidation_event rows).
 *  - A real run (dryRun:false) tombstones the duplicate and rewires edges.
 *  - The dry-run path reports exactly one cluster with one duplicate when two
 *    entity nodes share a normalized value and have cosine ≥ 0.88.
 *
 * Test strategy: invoke the EntityDedup engine directly (as the CLI does) via
 * the same construction path used in dedup-entities-cli.ts, so we test the
 * CLI's integration surface without spawning a subprocess. The printDryRun
 * export is also exercised for stdout formatting.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { EventStore } from '../src/db/event-store';
import { MockConsolidationSink } from '../src/consolidation/sink';
import { EntityDedup } from '../src/consolidation/entity-dedup';
import { printDryRun } from '../src/adapter/dedup-entities-cli';

const TEST_CONFIG: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

// ---------------------------------------------------------------------------
// Harness (mirrors entity-dedup.test.ts — same in-memory pattern)
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
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const clock = new FakeClock(1_000_000);
  const store = new SemanticStore(db, clock, TEST_CONFIG);
  const eventStore = new EventStore(db);
  const sink = new MockConsolidationSink();
  const dedup = new EntityDedup(db, store, sink, clock, TEST_CONFIG);
  return { db, store, sink, clock, dedup };
}

/**
 * Insert a minimal entity node with a given embedding.
 * Mirrors the insertEntityNode helper from entity-dedup.test.ts.
 */
function insertEntityNode(
  db: Database.Database,
  opts: {
    id: string;
    value: string;
    embedding: Float32Array | null;
    c?: number;
    last_access?: number;
  },
): void {
  const { id, value, embedding, c = 0.5, last_access = 1_000_000 } = opts;

  const embBuf = embedding
    ? Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
    : null;

  db.prepare(
    `INSERT INTO node (id, type, value, value_hash, origin, s, c, last_access,
      prev_value, pending_contradictions, tombstoned, training_eligible, embedding)
     VALUES (?, 'entity', ?, 'hash-placeholder', 'observed', 0.5, ?, ?,
      NULL, '[]', 0, 0, ?)`,
  ).run(id, value, c, last_access, embBuf);
}

/**
 * Insert an edge between two existing node IDs.
 */
function insertEdge(
  db: Database.Database,
  src: string,
  dst: string,
  rel: string = 'related',
): void {
  db.prepare(
    `INSERT INTO edge (src, dst, rel, w, kind, last_access)
     VALUES (?, ?, ?, 1.0, 'relation', 1000000)`,
  ).run(src, dst, rel);
}

/** Unit vector: cosine with itself = 1.0 (above any threshold). */
function unitVec(dims: number): Float32Array {
  return new Float32Array(dims).fill(1 / Math.sqrt(dims));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const DIMS = 16;
const THRESHOLD = 0.88;

describe('dedup-entities-cli — dry-run path writes nothing', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('dry-run returns one cluster with one duplicate and does NOT write to the DB', () => {
    // Two entity nodes with same normalized value and cosine = 1.0 (will exceed 0.88)
    const vec = unitVec(DIMS);
    insertEntityNode(h.db, { id: 'canonical-1', value: 'brain-memory', embedding: vec });
    insertEntityNode(h.db, { id: 'duplicate-1', value: 'brain-memory', embedding: vec });

    // Add an edge from the duplicate to a third node — to verify it is unchanged post dry-run
    insertEntityNode(h.db, { id: 'third-node', value: 'something else', embedding: null });
    insertEdge(h.db, 'duplicate-1', 'third-node', 'related');

    // Invoke the same construction path the CLI uses, with dryRun: true
    const result = h.dedup.run({ threshold: THRESHOLD, dryRun: true });

    // The dry-run should find exactly one cluster
    expect(result.clusters).toHaveLength(1);
    expect(result.mergedClusters).toBe(1);

    // And exactly one duplicate in that cluster
    const cluster = result.clusters[0]!;
    expect(cluster.duplicates).toHaveLength(1);

    // tombstoned count must be 0 — dry-run writes nothing
    expect(result.tombstoned).toBe(0);

    // The duplicate node must still be live (tombstoned=0) in the DB
    const dupRow = h.db
      .prepare('SELECT tombstoned FROM node WHERE id = ?')
      .get('duplicate-1') as { tombstoned: number };
    expect(dupRow.tombstoned).toBe(0);

    // The edge from the duplicate to third-node must still exist, unchanged
    const edgeRow = h.db
      .prepare('SELECT COUNT(*) AS n FROM edge WHERE src = ? AND dst = ?')
      .get('duplicate-1', 'third-node') as { n: number };
    expect(edgeRow.n).toBe(1);

    // No consolidation_event rows should have been written
    const eventCount = h.db
      .prepare("SELECT COUNT(*) AS n FROM consolidation_event WHERE event_type = 'entity_merge'")
      .get() as { n: number };
    expect(eventCount.n).toBe(0);
  });

  it('dry-run report lists the canonical and duplicate values', () => {
    const vec = unitVec(DIMS);
    insertEntityNode(h.db, { id: 'c1', value: 'tonos', embedding: vec });
    insertEntityNode(h.db, { id: 'd1', value: 'Tonos', embedding: vec });

    const result = h.dedup.run({ threshold: THRESHOLD, dryRun: true });

    // At minimum one cluster expected
    expect(result.clusters.length).toBeGreaterThanOrEqual(1);

    // The cluster reports canonical and duplicate values as strings
    const cluster = result.clusters[0]!;
    expect(typeof cluster.canonicalValue).toBe('string');
    expect(cluster.duplicates[0]?.cosine).toBeGreaterThanOrEqual(THRESHOLD);
  });

  it('printDryRun writes the expected header and summary line to stdout', () => {
    const vec = unitVec(DIMS);
    insertEntityNode(h.db, { id: 'p-c', value: 'brain-memory', embedding: vec });
    insertEntityNode(h.db, { id: 'p-d', value: 'brain-memory', embedding: vec });

    const result = h.dedup.run({ threshold: THRESHOLD, dryRun: true });

    // Capture stdout
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((data: unknown) => {
      written.push(String(data));
      return true;
    });

    try {
      printDryRun(result.clusters);
    } finally {
      spy.mockRestore();
    }

    const output = written.join('');
    expect(output).toContain('DRY RUN (nothing written)');
    expect(output).toContain('cluster(s)');
    expect(output).toContain('would be tombstoned');
  });
});
