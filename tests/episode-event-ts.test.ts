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
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema, SCHEMA_VERSION } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { EpisodicStore } from '../src/db/episode-store';

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
