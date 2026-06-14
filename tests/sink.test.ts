/**
 * Tests for SEAM-02 ConsolidationSink — EventStore + SQLiteConsolidationSink + NoopConsolidationSink.
 *
 * TDD: RED phase first (Task 1), then reconstructCorpus replay (Task 3).
 *
 * Coverage:
 *   - initSchema creates consolidation_event idempotently
 *   - SCHEMA_VERSION not bumped (still 1)
 *   - EventStore.append writes a row via prepared statement, usable inside existing transaction (D-48)
 *   - SQLiteConsolidationSink.emit mints stable id + ts + schema_version per event
 *   - NoopConsolidationSink.emit is inert
 *   - MockConsolidationSink captures events
 *   - reconstructCorpus: replay on a real sleep-pass output returns schema_version-stamped records
 */

import Database from 'better-sqlite3';
import { existsSync, copyFileSync, unlinkSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, afterAll } from 'vitest';
import { initSchema, SCHEMA_VERSION } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { EventStore } from '../src/db/event-store';
import {
  SQLiteConsolidationSink,
  NoopConsolidationSink,
  MockConsolidationSink,
  reconstructCorpus,
  type ConsolidationEventInput,
} from '../src/consolidation/sink';

// ---------------------------------------------------------------------------
// consolidation_event table (schema.ts)
// ---------------------------------------------------------------------------

describe('consolidation_event table (schema)', () => {
  it('initSchema creates consolidation_event idempotently — calling twice does not error', () => {
    const db = new Database(':memory:');
    initSchema(db);
    expect(() => initSchema(db)).not.toThrow();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='consolidation_event'")
      .all() as Array<{ name: string }>;
    expect(tables).toHaveLength(1);
  });

  it('schema_version meta matches SCHEMA_VERSION (consolidation_event remains additive)', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe(String(SCHEMA_VERSION));
  });
});

// ---------------------------------------------------------------------------
// EventStore
// ---------------------------------------------------------------------------

describe('EventStore', () => {
  it('append writes a row with all columns', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const store = new EventStore(db);
    const ts = 1_700_000_000_000;

    store.append({
      id: 'evt-001',
      ts,
      schema_version: SCHEMA_VERSION,
      event_type: 'confirm',
      node_id: 'node-aaa',
      candidate_id: 'cand-bbb',
      episode_id: 'ep-ccc',
      value: 'test value',
      origin: 'observed',
      magnitude: 0.75,
      payload: null,
    });

    const row = db
      .prepare('SELECT * FROM consolidation_event WHERE id = ?')
      .get('evt-001') as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row!['id']).toBe('evt-001');
    expect(row!['ts']).toBe(ts);
    expect(row!['schema_version']).toBe(SCHEMA_VERSION);
    expect(row!['event_type']).toBe('confirm');
    expect(row!['node_id']).toBe('node-aaa');
    expect(row!['candidate_id']).toBe('cand-bbb');
    expect(row!['episode_id']).toBe('ep-ccc');
    expect(row!['value']).toBe('test value');
    expect(row!['origin']).toBe('observed');
    expect(row!['magnitude']).toBe(0.75);
    expect(row!['payload']).toBeNull();
  });

  it('append handles null optional fields', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const store = new EventStore(db);

    store.append({
      id: 'evt-002',
      ts: 12345,
      schema_version: SCHEMA_VERSION,
      event_type: 'unrelated',
      node_id: null,
      candidate_id: null,
      episode_id: null,
      value: null,
      origin: null,
      magnitude: null,
      payload: null,
    });

    const row = db
      .prepare('SELECT * FROM consolidation_event WHERE id = ?')
      .get('evt-002') as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!['node_id']).toBeNull();
  });

  it('append is synchronous and usable inside an existing db.transaction (D-48)', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const store = new EventStore(db);

    // Called inside a wrapping transaction — must not open its own (better-sqlite3 is synchronous)
    db.transaction(() => {
      store.append({
        id: 'txn-evt',
        ts: 99999,
        schema_version: SCHEMA_VERSION,
        event_type: 'extend',
        node_id: 'nX',
        candidate_id: 'nY',
        episode_id: 'ep-tx',
        value: 'txn value',
        origin: 'asserted_by_user',
        magnitude: null,
        payload: null,
      });
    })();

    const row = db
      .prepare('SELECT id FROM consolidation_event WHERE id = ?')
      .get('txn-evt') as { id: string } | undefined;
    expect(row?.id).toBe('txn-evt');
  });
});

// ---------------------------------------------------------------------------
// SQLiteConsolidationSink
// ---------------------------------------------------------------------------

describe('SQLiteConsolidationSink', () => {
  it('emit mints a UUID id, ts from injected clock, and schema_version=SCHEMA_VERSION', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(1_000_000);
    const eventStore = new EventStore(db);
    const sink = new SQLiteConsolidationSink(eventStore, clock);

    sink.emit({
      event_type: 'confirm',
      node_id: 'node-A',
      episode_id: 'ep-A',
      value: 'my fact',
      origin: 'observed',
    });

    const rows = db.prepare('SELECT * FROM consolidation_event').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // id is a UUID (36 chars, has dashes at positions 8,13,18,23)
    expect(typeof row['id']).toBe('string');
    expect((row['id'] as string).length).toBe(36);

    // ts from the injected clock
    expect(row['ts']).toBe(1_000_000);

    // schema_version is SCHEMA_VERSION
    expect(row['schema_version']).toBe(SCHEMA_VERSION);

    // event_type and other fields
    expect(row['event_type']).toBe('confirm');
    expect(row['node_id']).toBe('node-A');
    expect(row['origin']).toBe('observed');
  });

  it('each emit call mints a distinct id', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(2_000_000);
    const eventStore = new EventStore(db);
    const sink = new SQLiteConsolidationSink(eventStore, clock);

    sink.emit({ event_type: 'confirm', node_id: 'n1' });
    sink.emit({ event_type: 'extend', node_id: 'n2' });

    const rows = db.prepare('SELECT id FROM consolidation_event').all() as Array<{ id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
  });

  it('emit is usable inside an existing db.transaction (D-48 in-transaction)', () => {
    const db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(3_000_000);
    const eventStore = new EventStore(db);
    const sink = new SQLiteConsolidationSink(eventStore, clock);

    expect(() => {
      db.transaction(() => {
        sink.emit({ event_type: 'schema_emitted', node_id: 'schema-1' });
      })();
    }).not.toThrow();

    const count = (db.prepare('SELECT count(*) as c FROM consolidation_event').get() as { c: number }).c;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// NoopConsolidationSink
// ---------------------------------------------------------------------------

describe('NoopConsolidationSink', () => {
  it('emit is a no-op — does not throw and writes nothing', () => {
    const sink = new NoopConsolidationSink();
    // Should not throw for any event type
    expect(() => sink.emit({ event_type: 'confirm', node_id: 'n1' })).not.toThrow();
    expect(() => sink.emit({ event_type: 'schema_falsified' })).not.toThrow();
    expect(() => sink.emit({ event_type: 'contradict_force_destabilize', node_id: 'n2' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// MockConsolidationSink
// ---------------------------------------------------------------------------

describe('MockConsolidationSink', () => {
  it('captures all emitted events in order', () => {
    const sink = new MockConsolidationSink();

    sink.emit({ event_type: 'confirm', node_id: 'n1', value: 'fact1' });
    sink.emit({ event_type: 'extend', node_id: 'n2', candidate_id: 'c1' });
    sink.emit({ event_type: 'schema_emitted', node_id: 'schema-1' });

    expect(sink.events).toHaveLength(3);
    expect(sink.events[0]!.event_type).toBe('confirm');
    expect(sink.events[1]!.event_type).toBe('extend');
    expect(sink.events[2]!.event_type).toBe('schema_emitted');
  });

  it('events array is initially empty', () => {
    const sink = new MockConsolidationSink();
    expect(sink.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ConsolidationEventType completeness (all 10 values compile)
// ---------------------------------------------------------------------------

describe('ConsolidationEventType enum completeness', () => {
  it('MockConsolidationSink accepts all 10 event types without TypeScript errors', () => {
    const sink = new MockConsolidationSink();
    // All 10 values from the interface spec (D-49)
    const allTypes: Array<ConsolidationEventInput['event_type']> = [
      'confirm',
      'extend',
      'unrelated',
      'contradict_hold',
      'contradict_reconcile',
      'contradict_oscillation',
      'contradict_append_new',
      'contradict_force_destabilize',
      'schema_emitted',
      'schema_falsified',
    ];
    for (const t of allTypes) {
      sink.emit({ event_type: t });
    }
    expect(sink.events).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// reconstructCorpus — runs only when recense.db exists (D-54, CI guard)
// ---------------------------------------------------------------------------

// M-11: path-agnostic — works from any checkout, not just $HOME/recense
const BRAIN_DB = path.resolve('recense.db');
const COPY_DB = path.join(os.tmpdir(), 'seam02-sink-test.db');

describe('reconstructCorpus (real-data, guarded by recense.db existence)', () => {
  afterAll(() => {
    if (existsSync(COPY_DB)) {
      try { unlinkSync(COPY_DB); } catch { /* ignore */ }
    }
  });

  it.skipIf(!existsSync(BRAIN_DB) || !process.env['RECENSE_RUN_LIVE_TESTS'])(
    'returns schema_version-stamped records after events are written',
    () => {
      // Copy the real DB so we do NOT write to production
      copyFileSync(BRAIN_DB, COPY_DB);
      const db = new Database(COPY_DB);
      initSchema(db); // idempotent — ensures consolidation_event table exists

      // Write a few synthetic events directly via EventStore
      const eventStore = new EventStore(db);
      const clock = new FakeClock(Date.now());
      const sink = new SQLiteConsolidationSink(eventStore, clock);

      // Pick a real node_id from the DB (if any) to make the JOIN meaningful
      const someNode = db
        .prepare('SELECT id FROM node WHERE training_eligible = 1 LIMIT 1')
        .get() as { id: string } | undefined;

      sink.emit({
        event_type: 'confirm',
        node_id: someNode?.id ?? null,
        episode_id: 'test-ep',
        value: 'test fact',
        origin: 'observed',
      });
      sink.emit({
        event_type: 'schema_emitted',
        node_id: null,
        episode_id: 'test-ep-2',
        value: 'TestSchema',
        origin: 'inferred',
      });

      const corpus = reconstructCorpus(db);
      expect(corpus.length).toBeGreaterThanOrEqual(1);
      // Every record carries a valid emit-time schema_version. Mixed versions are
      // expected by design (D-49): records emitted under an older SCHEMA_VERSION
      // keep that version so consumers can version-gate. The just-emitted events
      // must carry the current SCHEMA_VERSION, so the max present equals it.
      for (const record of corpus) {
        expect(record.schema_version).not.toBeNull();
        expect(record.schema_version).toBeGreaterThanOrEqual(1);
        expect(record.schema_version).toBeLessThanOrEqual(SCHEMA_VERSION);
      }
      expect(Math.max(...corpus.map((r) => r.schema_version))).toBe(SCHEMA_VERSION);

      db.close();
    }
  );
});
