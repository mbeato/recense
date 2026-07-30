/**
 * graph-hygiene interval gate — quick-260729-s8a (Cause B).
 *
 * The Stop hook spawns a detached sleep pass EVERY turn; runGraphHygiene used to run its
 * VACUUM INTO + entity/fact dedup on every single one of those passes (measured 486s, holding
 * the write lock the whole time). These tests cover the meta-persisted interval gate that now
 * limits it to at most once per RECENSE_HYGIENE_INTERVAL_HOURS (default 20h; 0 = every pass).
 *
 * Real file-backed DB (VACUUM INTO needs a real file, not :memory:). FakeClock must be advanced
 * between two runs within a single test — the snapshot filename is derived from clock.nowMs()
 * and VACUUM INTO fails if the target file already exists.
 */
import { mkdtempSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG, type EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { EventStore } from '../src/db/event-store';
import { SQLiteConsolidationSink } from '../src/consolidation/sink';
import {
  runGraphHygiene,
  resolveHygieneIntervalMs,
  GRAPH_HYGIENE_META_KEY,
  GRAPH_HYGIENE_DEFAULT_INTERVAL_MS,
} from '../src/consolidation/run-sleep-pass';

describe('graph-hygiene interval gate', () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;
  let clock: FakeClock;
  let store: SemanticStore;
  let sink: SQLiteConsolidationSink;
  let config: EngineConfig;
  let logs: string[];
  const log = (msg: string): void => { logs.push(msg); };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recense-hygiene-'));
    dbPath = join(dir, 'brain.db');
    db = new Database(dbPath);
    initSchema(db);
    clock = new FakeClock(Date.UTC(2026, 0, 1));
    config = { ...DEFAULT_CONFIG, dbPath };
    store = new SemanticStore(db, clock, config);
    const eventStore = new EventStore(db);
    sink = new SQLiteConsolidationSink(eventStore, clock);
    logs = [];
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env['RECENSE_HYGIENE_INTERVAL_HOURS'];
  });

  function snapCount(): number {
    const snapDir = join(dir, 'snapshots');
    try {
      return readdirSync(snapDir).filter(f => f.endsWith('.bak')).length;
    } catch {
      return 0;
    }
  }

  it('runs on the first call (empty meta)', () => {
    runGraphHygiene(db, store, sink, config, clock, log, process.env);

    expect(logs.some(l => l.includes('graph-hygiene: snapshot'))).toBe(true);
    expect(snapCount()).toBe(1);
    expect(store.getMeta(GRAPH_HYGIENE_META_KEY)).toBe(String(clock.nowMs()));
  });

  it('skips a second call inside the interval (clock+5min)', () => {
    runGraphHygiene(db, store, sink, config, clock, log, process.env);
    const firstStamp = store.getMeta(GRAPH_HYGIENE_META_KEY);
    logs = [];

    clock.advanceMs(5 * 60 * 1000);
    runGraphHygiene(db, store, sink, config, clock, log, process.env);

    expect(logs.some(l => l.includes('skipped'))).toBe(true);
    expect(snapCount()).toBe(1); // no second snapshot
    expect(store.getMeta(GRAPH_HYGIENE_META_KEY)).toBe(firstStamp); // unchanged
  });

  it('runs again after the default interval elapses', () => {
    runGraphHygiene(db, store, sink, config, clock, log, process.env);
    const firstStamp = store.getMeta(GRAPH_HYGIENE_META_KEY);
    logs = [];

    clock.advanceMs(GRAPH_HYGIENE_DEFAULT_INTERVAL_MS + 60_000); // past the 20h default
    runGraphHygiene(db, store, sink, config, clock, log, process.env);

    expect(logs.some(l => l.includes('graph-hygiene: snapshot'))).toBe(true);
    expect(snapCount()).toBe(2);
    expect(store.getMeta(GRAPH_HYGIENE_META_KEY)).not.toBe(firstStamp);
    expect(store.getMeta(GRAPH_HYGIENE_META_KEY)).toBe(String(clock.nowMs()));
  });

  it('RECENSE_HYGIENE_INTERVAL_HOURS=0 forces a run even with a fresh stamp (escape hatch)', () => {
    runGraphHygiene(db, store, sink, config, clock, log, process.env);
    logs = [];

    process.env['RECENSE_HYGIENE_INTERVAL_HOURS'] = '0';
    clock.advanceMs(1000); // barely any time passed, and the stamp is fresh
    runGraphHygiene(db, store, sink, config, clock, log, process.env);

    expect(logs.some(l => l.includes('graph-hygiene: snapshot'))).toBe(true);
    expect(snapCount()).toBe(2);
  });

  it('RECENSE_HYGIENE_INTERVAL_HOURS=1: skips at +30min, runs at +90min', () => {
    process.env['RECENSE_HYGIENE_INTERVAL_HOURS'] = '1';
    runGraphHygiene(db, store, sink, config, clock, log, process.env);
    logs = [];

    clock.advanceMs(30 * 60 * 1000);
    runGraphHygiene(db, store, sink, config, clock, log, process.env);
    expect(logs.some(l => l.includes('skipped'))).toBe(true);
    expect(snapCount()).toBe(1);
    logs = [];

    clock.advanceMs(60 * 60 * 1000); // total +90min from first run
    runGraphHygiene(db, store, sink, config, clock, log, process.env);
    expect(logs.some(l => l.includes('graph-hygiene: snapshot'))).toBe(true);
    expect(snapCount()).toBe(2);
  });
});

describe('resolveHygieneIntervalMs', () => {
  afterEach(() => {
    delete process.env['RECENSE_HYGIENE_INTERVAL_HOURS'];
  });

  it('returns the default when the env var is absent', () => {
    delete process.env['RECENSE_HYGIENE_INTERVAL_HOURS'];
    expect(resolveHygieneIntervalMs(process.env)).toBe(GRAPH_HYGIENE_DEFAULT_INTERVAL_MS);
  });

  it('returns 0 (always-run escape hatch) when set to "0"', () => {
    expect(resolveHygieneIntervalMs({ RECENSE_HYGIENE_INTERVAL_HOURS: '0' })).toBe(0);
  });

  it('falls back to the default on a negative value', () => {
    expect(resolveHygieneIntervalMs({ RECENSE_HYGIENE_INTERVAL_HOURS: '-1' })).toBe(GRAPH_HYGIENE_DEFAULT_INTERVAL_MS);
  });

  it('falls back to the default on an unparseable value', () => {
    expect(resolveHygieneIntervalMs({ RECENSE_HYGIENE_INTERVAL_HOURS: 'abc' })).toBe(GRAPH_HYGIENE_DEFAULT_INTERVAL_MS);
  });

  it('scales a valid positive value to milliseconds', () => {
    expect(resolveHygieneIntervalMs({ RECENSE_HYGIENE_INTERVAL_HOURS: '5' })).toBe(5 * 60 * 60 * 1000);
  });
});
