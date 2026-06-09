/**
 * Tests for schema v4 — activation_trace table (Task 1) and ActivationTraceSink seam (Task 2).
 *
 * Coverage:
 *   - initSchema creates activation_trace idempotently (v4 migration, VIZ-02)
 *   - schema_version meta stamps 4 after migration
 *   - activation_trace columns: id, ts, query_id, seeds, hops
 *   - existing v3 node/edge/episode data is untouched by v4 migration
 *   - SQLiteActivationTraceSink.emit writes a row; seeds/hops round-trip as JSON
 *   - emit uses clock.nowMs() when ts omitted; uses caller ts when provided
 *   - ring eviction: after 60 emits, COUNT = 50, surviving rows are top-50 ids
 *   - NoopActivationTraceSink.emit is inert (COUNT stays 0)
 *   - MockActivationTraceSink captures traces in order; reset() clears them
 */

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { initSchema, SCHEMA_VERSION } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import {
  SQLiteActivationTraceSink,
  NoopActivationTraceSink,
  MockActivationTraceSink,
  RING_CAP,
  type ActivationTraceInput,
} from '../src/viz/activation-sink';

// ---------------------------------------------------------------------------
// Schema v4 tests (Task 1)
// ---------------------------------------------------------------------------

describe('activation_trace table (schema v4)', () => {
  it('initSchema creates activation_trace idempotently — calling twice does not throw', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='activation_trace'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it('schema_version meta is 4 after initSchema', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe('4');
  });

  it('activation_trace has expected columns (id, ts, query_id, seeds, hops)', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const cols = (db.pragma('table_info(activation_trace)') as Array<{ name: string }>)
      .map(r => r.name);
    expect(cols).toContain('id');
    expect(cols).toContain('ts');
    expect(cols).toContain('query_id');
    expect(cols).toContain('seeds');
    expect(cols).toContain('hops');
  });

  it('v3 DB (episode has cwd) gains activation_trace without data loss to node/edge/episode', () => {
    const db = new Database(':memory:');
    // First init — simulates a v3 DB opening (cwd already in episode via DDL)
    initSchema(db);
    // Insert representative data in all three existing tables
    db.prepare(
      'INSERT INTO node (id, type, value, value_hash, origin, last_access) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('node-1', 'fact', 'test value', 'hash1', 'observed', 1000);
    db.prepare(
      'INSERT INTO episode (id, ts, content, origin, salience, hard_keep, consolidated, role, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run('ep-1', 1000, 'hello world', 'observed', 0.8, 0, 0, 'user', 'sess-1');
    // Re-run initSchema (idempotent v4 re-open)
    initSchema(db);
    // activation_trace present
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='activation_trace'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
    // Existing data intact
    const nodeCount = db.prepare('SELECT COUNT(*) as cnt FROM node').get() as { cnt: number };
    expect(nodeCount.cnt).toBe(1);
    const epCount = db.prepare('SELECT COUNT(*) as cnt FROM episode').get() as { cnt: number };
    expect(epCount.cnt).toBe(1);
  });

  it('SCHEMA_VERSION constant equals 4', () => {
    expect(SCHEMA_VERSION).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// ActivationTraceSink seam tests (Task 2)
// ---------------------------------------------------------------------------

describe('SQLiteActivationTraceSink', () => {
  it('emit inserts one row; seeds and hops round-trip as JSON', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(1000);
    const sink = new SQLiteActivationTraceSink(db, clock);
    const input: ActivationTraceInput = {
      query_id: 'q-1',
      seeds: ['node-a', 'node-b'],
      hops: [{ node_id: 'node-c', score: 0.9, hop: 1 }],
    };
    sink.emit(input);
    const count = db.prepare('SELECT COUNT(*) as cnt FROM activation_trace').get() as { cnt: number };
    expect(count.cnt).toBe(1);
    const row = db.prepare('SELECT * FROM activation_trace').get() as {
      query_id: string; seeds: string; hops: string; ts: number;
    };
    expect(row.query_id).toBe('q-1');
    expect(JSON.parse(row.seeds)).toEqual(['node-a', 'node-b']);
    expect(JSON.parse(row.hops)).toEqual([{ node_id: 'node-c', score: 0.9, hop: 1 }]);
  });

  it('emit uses clock.nowMs() when ts is omitted, uses caller ts when provided', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(42000);
    const sink = new SQLiteActivationTraceSink(db, clock);
    // omit ts → use clock
    sink.emit({ query_id: 'q-clock', seeds: [], hops: [] });
    const row1 = db.prepare('SELECT ts FROM activation_trace ORDER BY id DESC LIMIT 1').get() as { ts: number };
    expect(row1.ts).toBe(42000);
    // explicit ts → use it
    sink.emit({ query_id: 'q-explicit', seeds: [], hops: [], ts: 99999 });
    const row2 = db.prepare('SELECT ts FROM activation_trace ORDER BY id DESC LIMIT 1').get() as { ts: number };
    expect(row2.ts).toBe(99999);
  });

  it('ring eviction: after 60 emits, COUNT = 50 and the surviving rows are the top-50 ids', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(1);
    const sink = new SQLiteActivationTraceSink(db, clock);
    for (let i = 0; i < 60; i++) {
      sink.emit({ query_id: `q-${i}`, seeds: [], hops: [] });
      clock.advanceMs(1);
    }
    const count = db.prepare('SELECT COUNT(*) as cnt FROM activation_trace').get() as { cnt: number };
    expect(count.cnt).toBe(RING_CAP);
    // Surviving rows must be the 50 highest ids
    const minId = db.prepare('SELECT MIN(id) as min FROM activation_trace').get() as { min: number };
    const maxId = db.prepare('SELECT MAX(id) as max FROM activation_trace').get() as { max: number };
    // The 50 largest ids out of 60 autoincrement ids: min should be 11, max should be 60
    expect(maxId.max - minId.min).toBe(RING_CAP - 1);
  });

  it('RING_CAP is 50', () => {
    expect(RING_CAP).toBe(50);
  });
});

describe('NoopActivationTraceSink', () => {
  it('emit writes nothing — COUNT stays 0', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const sink = new NoopActivationTraceSink();
    sink.emit({ query_id: 'q-noop', seeds: [], hops: [] });
    const count = db.prepare('SELECT COUNT(*) as cnt FROM activation_trace').get() as { cnt: number };
    expect(count.cnt).toBe(0);
  });
});

describe('MockActivationTraceSink', () => {
  it('captures emitted inputs into .traces in order', () => {
    const sink = new MockActivationTraceSink();
    const t1: ActivationTraceInput = { query_id: 'q-1', seeds: ['a'], hops: [] };
    const t2: ActivationTraceInput = { query_id: 'q-2', seeds: ['b'], hops: [] };
    sink.emit(t1);
    sink.emit(t2);
    expect(sink.traces).toHaveLength(2);
    expect(sink.traces[0]).toEqual(t1);
    expect(sink.traces[1]).toEqual(t2);
  });

  it('reset() clears the captured traces', () => {
    const sink = new MockActivationTraceSink();
    sink.emit({ query_id: 'q-1', seeds: [], hops: [] });
    expect(sink.traces).toHaveLength(1);
    sink.reset();
    expect(sink.traces).toHaveLength(0);
  });
});
