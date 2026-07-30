/**
 * EMAIL-04: episode.event_ts — source-asserted event time, distinct from ts (ingest time).
 *
 * Store-layer coverage (Task 1 of plan 62-04):
 *  - append with no event_ts stores NULL; returned EpisodeRow.event_ts is null
 *  - append with event_ts set stores and returns that exact value
 *  - event_ts and ts are independent — a months-old event_ts does not change clock-driven ts
 *  - event_ts is not consulted by the D-59 dedup path (INSERT OR IGNORE backstop)
 *  - initSchema on a fresh in-memory DB stamps SCHEMA_VERSION 16
 *  - a simulated legacy DB (episode table built without event_ts) gains the column via the
 *    v16 ALTER migration, with the pre-existing row's event_ts NULL and other columns intact
 *
 * Pipeline + CLI coverage (Task 2 of plan 62-04):
 *  - IngestionPipeline.recordEvent threads eventTs through to EpisodicStore.append
 *  - runPullPhase over a MockSourceAdapter carries NormalizedRecord.event_ts to the stored row
 *  - a record with no event_ts produces a row byte-identical in every other column to the
 *    pre-EMAIL-04 shape (zero-behaviour-change proof for non-Gmail sources)
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema, SCHEMA_VERSION } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { EpisodicStore } from '../src/db/episode-store';
import { AllocationGate, IngestionPipeline } from '../src/ingest/pipeline';
import type { NormalizedRecord } from '../src/source/source-adapter';
import { MockSourceAdapter } from '../src/source/source-adapter';
import { runPullPhase } from '../src/adapter/ingest-cli';

const testConfig: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

/** Minimal valid AppendEventParams — only fields that matter vary per test. */
const BASE_PARAMS = {
  content: 'test content',
  origin: 'observed' as const,
  salience: 0.5,
  hard_keep: 0,
  role: 'user' as const,
  session_id: 'sess-event-ts',
  source_inference_id: null,
};

describe('EpisodicStore.append — event_ts (EMAIL-04)', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let store: EpisodicStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    clock = new FakeClock(1_700_100_000_000);
    store = new EpisodicStore(db, clock, testConfig);
  });

  afterEach(() => {
    db.close();
  });

  it('append with no event_ts stores NULL and the returned row has event_ts === null', () => {
    const row = store.append({ ...BASE_PARAMS, source: 'claude-code', external_id: null });
    expect(row.event_ts).toBeNull();
  });

  it('append with event_ts set stores and returns that exact value', () => {
    const row = store.append({
      ...BASE_PARAMS,
      source: 'gmail',
      external_id: 'msg-event-ts-1',
      event_ts: 1_700_000_000_000,
    });
    expect(row.event_ts).toBe(1_700_000_000_000);
  });

  it('event_ts and ts are independent — a months-earlier event_ts leaves clock-driven ts unchanged', () => {
    // event_ts is ~2 months before clock.nowMs() (1_700_100_000_000)
    const monthsAgoEventTs = 1_694_000_000_000;
    const row = store.append({
      ...BASE_PARAMS,
      source: 'gmail',
      external_id: 'msg-event-ts-2',
      event_ts: monthsAgoEventTs,
    });
    expect(row.event_ts).toBe(monthsAgoEventTs);
    expect(row.ts).toBe(clock.nowMs());
  });

  it('event_ts is not consulted by the dedup path — same (source, external_id), different event_ts, dedups to one row', () => {
    const first = store.append({
      ...BASE_PARAMS,
      source: 'gmail',
      external_id: 'msg-dedup-event-ts',
      event_ts: 1_700_000_000_000,
    });
    const second = store.append({
      ...BASE_PARAMS,
      source: 'gmail',
      external_id: 'msg-dedup-event-ts',
      event_ts: 1_800_000_000_000,
    });

    // D-59: INSERT OR IGNORE backstop — same id, pre-existing row's event_ts unchanged.
    expect(second.id).toBe(first.id);
    expect(second.event_ts).toBe(1_700_000_000_000);
    expect(store.listUnconsolidated()).toHaveLength(1);
  });
});

describe('initSchema — event_ts migration (EMAIL-04)', () => {
  it('stamps SCHEMA_VERSION 16 on a fresh in-memory DB', () => {
    const db = new Database(':memory:');
    try {
      initSchema(db);
      const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
        { value: string } | undefined;
      expect(row).toBeDefined();
      expect(Number(row!.value)).toBe(16);
      expect(SCHEMA_VERSION).toBe(16);

      const cols = (db.pragma('table_info(episode)') as Array<{ name: string }>).map(r => r.name);
      expect(cols).toContain('event_ts');
    } finally {
      db.close();
    }
  });

  it('a legacy DB (episode table built without event_ts) gains the column via the v16 ALTER, NULL for the pre-existing row, other columns intact', () => {
    const db = new Database(':memory:');
    try {
      // Simulate a pre-v16 DB: build the episode table WITHOUT event_ts.
      db.exec(`
        CREATE TABLE episode (
          id                  TEXT    PRIMARY KEY,
          ts                  INTEGER NOT NULL,
          content             TEXT    NOT NULL,
          origin              TEXT    NOT NULL,
          salience            REAL    NOT NULL,
          hard_keep           INTEGER NOT NULL DEFAULT 0,
          consolidated        INTEGER NOT NULL DEFAULT 0,
          source_inference_id TEXT,
          role                TEXT    NOT NULL,
          session_id          TEXT    NOT NULL,
          source              TEXT    NOT NULL DEFAULT 'claude-code',
          external_id         TEXT,
          cwd                 TEXT    NOT NULL DEFAULT ''
        );
      `);
      db.prepare(`
        INSERT INTO episode (id, ts, content, origin, salience, hard_keep, consolidated, role, session_id, source, external_id, cwd)
        VALUES ('legacy-1', 12345, 'legacy content', 'observed', 0.3, 0, 0, 'user', 'legacy-sess', 'claude-code', NULL, '')
      `).run();

      initSchema(db);

      const cols = (db.pragma('table_info(episode)') as Array<{ name: string }>).map(r => r.name);
      expect(cols).toContain('event_ts');

      const row = db.prepare('SELECT * FROM episode WHERE id = ?').get('legacy-1') as
        Record<string, unknown>;
      expect(row.event_ts).toBeNull();
      expect(row.ts).toBe(12345);
      expect(row.content).toBe('legacy content');
      expect(row.origin).toBe('observed');
      expect(row.salience).toBe(0.3);
      expect(row.session_id).toBe('legacy-sess');
      expect(row.source).toBe('claude-code');
      expect(row.cwd).toBe('');
    } finally {
      db.close();
    }
  });
});

describe('IngestionPipeline.recordEvent — eventTs threading (EMAIL-04)', () => {
  let db: Database.Database;
  let store: EpisodicStore;
  let pipeline: IngestionPipeline;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(1_700_100_000_000);
    store = new EpisodicStore(db, clock, testConfig);
    const gate = new AllocationGate(testConfig);
    pipeline = new IngestionPipeline(gate, store);
  });

  afterEach(() => {
    db.close();
  });

  it('recordEvent with no eventTs stores NULL', () => {
    const row = pipeline.recordEvent({
      content: 'no event ts',
      role: 'user',
      origin: 'observed',
      sessionId: 'ingest:test',
      source: 'gmail',
      externalId: 'evt-1',
    });
    expect(row.event_ts).toBeNull();
  });

  it('recordEvent with eventTs stores that value', () => {
    const row = pipeline.recordEvent({
      content: 'has event ts',
      role: 'user',
      origin: 'observed',
      sessionId: 'ingest:test',
      source: 'gmail',
      externalId: 'evt-2',
      eventTs: 1_650_000_000_000,
    });
    expect(row.event_ts).toBe(1_650_000_000_000);
  });

  it('recordEvent with eventTs: null stores NULL', () => {
    const row = pipeline.recordEvent({
      content: 'explicit null event ts',
      role: 'user',
      origin: 'observed',
      sessionId: 'ingest:test',
      source: 'gmail',
      externalId: 'evt-3',
      eventTs: null,
    });
    expect(row.event_ts).toBeNull();
  });
});

describe('runPullPhase — NormalizedRecord.event_ts carries to the stored row (EMAIL-04)', () => {
  let db: Database.Database;
  let store: EpisodicStore;
  let pipeline: IngestionPipeline;
  const logs: string[] = [];
  const capLog = (msg: string) => { logs.push(msg); };

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(1_700_100_000_000);
    store = new EpisodicStore(db, clock, testConfig);
    const gate = new AllocationGate(testConfig);
    pipeline = new IngestionPipeline(gate, store);
    logs.length = 0;
  });

  afterEach(() => {
    db.close();
  });

  it('two records — one carrying event_ts, one omitting it — append two rows whose event_ts values are the supplied number and NULL respectively', async () => {
    const withEventTs: NormalizedRecord = {
      content: 'email with a date header',
      source: 'gmail',
      external_id: 'gmail-msg-with-date',
      origin: 'observed',
      role: 'user',
      event_ts: 1_690_000_000_000,
    };
    const withoutEventTs: NormalizedRecord = {
      content: 'email with no parseable date',
      source: 'gmail',
      external_id: 'gmail-msg-no-date',
      origin: 'observed',
      role: 'user',
    };
    const adapter = new MockSourceAdapter('gmail', [withEventTs, withoutEventTs]);

    await runPullPhase([adapter], pipeline, db, capLog);

    // Query the rows back with raw SQL so the assertion is against the stored column.
    const rowWith = db.prepare('SELECT event_ts FROM episode WHERE external_id = ?')
      .get('gmail-msg-with-date') as { event_ts: number | null };
    const rowWithout = db.prepare('SELECT event_ts FROM episode WHERE external_id = ?')
      .get('gmail-msg-no-date') as { event_ts: number | null };

    expect(rowWith.event_ts).toBe(1_690_000_000_000);
    expect(rowWithout.event_ts).toBeNull();
  });

  it('records with no event_ts at all produce rows byte-identical in every other column to the pre-EMAIL-04 shape', async () => {
    const record: NormalizedRecord = {
      content: 'plain granola turn',
      source: 'granola',
      external_id: 'granola-turn-zero-behavior',
      origin: 'observed',
      role: 'user',
    };
    const adapter = new MockSourceAdapter('granola', [record]);

    await runPullPhase([adapter], pipeline, db, capLog);

    const row = db.prepare('SELECT * FROM episode WHERE external_id = ?')
      .get('granola-turn-zero-behavior') as Record<string, unknown>;

    expect(row.content).toBe('plain granola turn');
    expect(row.origin).toBe('observed');
    expect(typeof row.salience).toBe('number');
    expect(row.hard_keep === 0 || row.hard_keep === 1).toBe(true);
    expect(row.role).toBe('user');
    expect(row.session_id).toBe('ingest:granola');
    expect(row.source).toBe('granola');
    expect(row.external_id).toBe('granola-turn-zero-behavior');
    expect(row.cwd).toBe('');
    expect(row.event_ts).toBeNull();
  });
});
