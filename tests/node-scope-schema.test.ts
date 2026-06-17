/**
 * Schema v10 — node_scope sidecar table tests (Plan 999.3-01, D-S2).
 *
 * Behavioral contract:
 *   - SCHEMA_VERSION === 10 (bumped by exactly 1 from 9)
 *   - node_scope table exists with correct columns (node_id PK FK→node.id,
 *     scope NOT NULL, updated_at NOT NULL)
 *   - idx_node_scope_scope index exists on node_scope(scope)
 *   - initSchema is idempotent: running twice does not error
 *   - Existing v9 DB (node_scope absent) gains the table on re-run (additive,
 *     CREATE TABLE IF NOT EXISTS — no ALTER, mirrors node_temporal)
 *   - scope lives in a SIDECAR, never as a column on the node table (faithfulness)
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
  it('is 10 (bumped by exactly 1 from the pre-plan value of 9)', () => {
    expect(SCHEMA_VERSION).toBe(10);
  });
});

describe('node_scope table', () => {
  it('exists after initSchema', () => {
    const db = makeDb();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='node_scope'")
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe('node_scope');
  });

  it('has node_id as the PRIMARY KEY', () => {
    const db = makeDb();
    const cols = db.pragma('table_info(node_scope)') as Array<{
      name: string;
      pk: number;
      notnull: number;
      type: string;
    }>;
    const pkCol = cols.find(c => c.pk === 1);
    expect(pkCol).toBeDefined();
    expect(pkCol!.name).toBe('node_id');
  });

  it('has scope column with NOT NULL', () => {
    const db = makeDb();
    const cols = db.pragma('table_info(node_scope)') as Array<{ name: string; notnull: number }>;
    const scopeCol = cols.find(c => c.name === 'scope');
    expect(scopeCol).toBeDefined();
    expect(scopeCol!.notnull).toBe(1);
  });

  it('has updated_at column with NOT NULL', () => {
    const db = makeDb();
    const cols = db.pragma('table_info(node_scope)') as Array<{ name: string; notnull: number }>;
    const uaCol = cols.find(c => c.name === 'updated_at');
    expect(uaCol).toBeDefined();
    expect(uaCol!.notnull).toBe(1);
  });

  it('references node(id) via a foreign key (sidecar, not a node column)', () => {
    const db = makeDb();
    const fks = db.pragma('foreign_key_list(node_scope)') as Array<{ table: string; from: string; to: string }>;
    const fk = fks.find(f => f.table === 'node' && f.from === 'node_id');
    expect(fk).toBeDefined();
    expect(fk!.to).toBe('id');
  });

  it('does NOT add a scope column to the node table (faithfulness: node stays the pure belief record)', () => {
    const db = makeDb();
    const cols = db.pragma('table_info(node)') as Array<{ name: string }>;
    const names = cols.map(c => c.name);
    expect(names).not.toContain('scope');
  });
});

describe('idx_node_scope_scope index', () => {
  it('exists on node_scope(scope)', () => {
    const db = makeDb();
    const indexes = db.pragma('index_list(node_scope)') as Array<{ name: string }>;
    const scopeIdx = indexes.find(i => i.name === 'idx_node_scope_scope');
    expect(scopeIdx).toBeDefined();
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

  it('creates node_scope on a DB that lacks it (v9 simulation)', () => {
    // Simulate a v9 DB: full schema then drop node_scope, restamp version to 9.
    const db = new Database(':memory:');
    initSchema(db);
    db.exec('DROP TABLE IF EXISTS node_scope');
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '9')").run();

    const before = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='node_scope'")
      .get();
    expect(before).toBeUndefined();

    // Re-running initSchema must create node_scope via CREATE TABLE IF NOT EXISTS (additive).
    initSchema(db);

    const after = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='node_scope'")
      .get() as { name: string } | undefined;
    expect(after).toBeDefined();
    expect(after!.name).toBe('node_scope');
  });
});
