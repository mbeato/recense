/**
 * Schema v8 — node_temporal sidecar table tests (Plan 20-01, D-01).
 *
 * Behavioral contract:
 *   - SCHEMA_VERSION === 9
 *   - node_temporal table exists with correct columns (node_id PK, due_at, action_type,
 *     recurrence_rule, source_event_id, updated_at)
 *   - idx_node_temporal_due_at index exists on node_temporal(due_at)
 *   - CHECK constraint on action_type rejects values outside the 7-item closed enum
 *   - initSchema is idempotent: running twice does not error
 *   - Existing v7 DB (node_temporal absent) gains the table on re-run
 */
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { initSchema, SCHEMA_VERSION } from '../src/db/schema';

/** Open a fresh in-memory DB with the schema applied. */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

describe('SCHEMA_VERSION', () => {
  it('is 12', () => {
    expect(SCHEMA_VERSION).toBe(12);
  });
});

describe('node_temporal table', () => {
  it('exists after initSchema', () => {
    const db = makeDb();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='node_temporal'")
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe('node_temporal');
  });

  it('has node_id as the PRIMARY KEY', () => {
    const db = makeDb();
    const cols = db.pragma('table_info(node_temporal)') as Array<{
      name: string;
      pk: number;
      notnull: number;
      type: string;
    }>;
    const pkCol = cols.find(c => c.pk === 1);
    expect(pkCol).toBeDefined();
    expect(pkCol!.name).toBe('node_id');
  });

  it('has action_type column with NOT NULL and a CHECK constraint reference in the table DDL', () => {
    const db = makeDb();
    const ddl = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='node_temporal'")
        .get() as { sql: string }
    ).sql;
    expect(ddl).toContain('action_type');
    expect(ddl).toContain('CHECK');
    // Verify the enum values are embedded in the DDL
    for (const val of ['deadline', 'flight', 'appointment', 'receipt', 'payment', 'meeting', 'other']) {
      expect(ddl).toContain(val);
    }
  });

  it('has updated_at column', () => {
    const db = makeDb();
    const cols = db.pragma('table_info(node_temporal)') as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('updated_at');
  });

  it('has recurrence_rule and source_event_id nullable columns', () => {
    const db = makeDb();
    const cols = db.pragma('table_info(node_temporal)') as Array<{
      name: string;
      notnull: number;
    }>;
    const rrCol = cols.find(c => c.name === 'recurrence_rule');
    const srcCol = cols.find(c => c.name === 'source_event_id');
    expect(rrCol).toBeDefined();
    expect(srcCol).toBeDefined();
    expect(rrCol!.notnull).toBe(0); // nullable
    expect(srcCol!.notnull).toBe(0); // nullable
  });
});

describe('node_temporal CHECK constraint', () => {
  it("rejects action_type='bogus' (outside the closed enum)", () => {
    const db = makeDb();
    // Insert a node first (FK constraint requires node.id to exist)
    db.prepare(
      `INSERT INTO node (id, type, value, value_hash, origin, s, c, last_access,
        pending_contradictions, tombstoned, training_eligible)
       VALUES ('n1','fact','test','h1','observed',0.1,0.5,1,'[]',0,0)`,
    ).run();

    expect(() => {
      db
        .prepare(
          `INSERT INTO node_temporal (node_id, due_at, action_type, updated_at)
           VALUES ('n1','2026-07-01T00:00:00Z','bogus',1000)`,
        )
        .run();
    }).toThrow();
  });

  it("accepts action_type='flight' (within the closed enum)", () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO node (id, type, value, value_hash, origin, s, c, last_access,
        pending_contradictions, tombstoned, training_eligible)
       VALUES ('n2','fact','test','h2','observed',0.1,0.5,1,'[]',0,0)`,
    ).run();

    expect(() => {
      db
        .prepare(
          `INSERT INTO node_temporal (node_id, due_at, action_type, updated_at)
           VALUES ('n2','2026-07-04T08:00:00Z','flight',1000)`,
        )
        .run();
    }).not.toThrow();
  });

  it('accepts all 7 valid action_type values', () => {
    const db = makeDb();
    const validTypes = ['deadline', 'flight', 'appointment', 'receipt', 'payment', 'meeting', 'other'];
    for (const [i, actionType] of validTypes.entries()) {
      const nodeId = `node-${i}`;
      db.prepare(
        `INSERT INTO node (id, type, value, value_hash, origin, s, c, last_access,
          pending_contradictions, tombstoned, training_eligible)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(nodeId, 'fact', `val${i}`, `h${i}`, 'observed', 0.1, 0.5, 1, '[]', 0, 0);

      expect(() => {
        db
          .prepare(
            `INSERT INTO node_temporal (node_id, due_at, action_type, updated_at)
             VALUES (?, '2026-07-01T00:00:00Z', ?, 1000)`,
          )
          .run(nodeId, actionType);
      }).not.toThrow();
    }
  });
});

describe('idx_node_temporal_due_at index', () => {
  it('exists on node_temporal(due_at)', () => {
    const db = makeDb();
    const indexes = db.pragma('index_list(node_temporal)') as Array<{ name: string }>;
    const dueatIdx = indexes.find(i => i.name === 'idx_node_temporal_due_at');
    expect(dueatIdx).toBeDefined();
  });
});

describe('initSchema idempotency', () => {
  it('can be called twice on the same DB without error', () => {
    const db = new Database(':memory:');
    expect(() => {
      initSchema(db);
      initSchema(db);
    }).not.toThrow();
  });

  it('creates node_temporal on a DB that lacks it (v7 simulation)', () => {
    // Simulate a v7 DB by creating all tables EXCEPT node_temporal, then running initSchema
    const db = new Database(':memory:');
    // Apply DDL minus the node_temporal block (simulate v7 state)
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS episode (
        id TEXT PRIMARY KEY, ts INTEGER NOT NULL, content TEXT NOT NULL,
        origin TEXT NOT NULL, salience REAL NOT NULL, hard_keep INTEGER NOT NULL DEFAULT 0,
        consolidated INTEGER NOT NULL DEFAULT 0, source_inference_id TEXT,
        role TEXT NOT NULL, session_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'claude-code', external_id TEXT, cwd TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS node (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, value TEXT NOT NULL,
        value_hash TEXT NOT NULL, embedding BLOB, embedded_hash TEXT,
        origin TEXT NOT NULL, s REAL NOT NULL DEFAULT 0.1, c REAL NOT NULL DEFAULT 0.5,
        last_access INTEGER NOT NULL, prev_value TEXT, prev_ts INTEGER,
        pending_contradictions TEXT NOT NULL DEFAULT '[]',
        tombstoned INTEGER NOT NULL DEFAULT 0, training_eligible INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS edge (
        src TEXT NOT NULL, dst TEXT NOT NULL, rel TEXT NOT NULL,
        w REAL NOT NULL DEFAULT 0.1, last_access INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('relation','abstracts','schema_rel')),
        PRIMARY KEY (src, dst, rel)
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS consolidation_event (
        id TEXT PRIMARY KEY, ts INTEGER NOT NULL, schema_version INTEGER NOT NULL,
        event_type TEXT NOT NULL, node_id TEXT, candidate_id TEXT,
        episode_id TEXT, value TEXT, origin TEXT, magnitude REAL, payload TEXT
      );
      CREATE TABLE IF NOT EXISTS activation_trace (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
        query_id TEXT NOT NULL, seeds TEXT NOT NULL, hops TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
        node_id UNINDEXED, value, tokenize='unicode61 remove_diacritics 2'
      );
      INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '7');
    `);

    // node_temporal must not exist yet
    const before = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='node_temporal'")
      .get();
    expect(before).toBeUndefined();

    // Running initSchema must create node_temporal
    initSchema(db);

    const after = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='node_temporal'")
      .get() as { name: string } | undefined;
    expect(after).toBeDefined();
    expect(after!.name).toBe('node_temporal');
  });
});
