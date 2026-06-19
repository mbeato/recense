/**
 * Schema v11 migration tests (READER-01, 27-01).
 *
 * Covers:
 *  (a) Fresh DB: type='doc' / kind='cites' / kind='doc_link' inserts succeed; bogus values rejected.
 *  (b) Pre-v11 DB: simulated old DDL → after initSchema the migration ran and existing rows preserved.
 *  (c) FK integrity: PRAGMA foreign_key_check returns empty after migration.
 *  (d) node_doc sidecar exists with expected columns; idx_node_doc_slug index exists.
 *  (e) meta.schema_version = '11' after initSchema.
 *  (f) Idempotency: calling initSchema a second time leaves data intact.
 */
import Database from 'better-sqlite3';
import { describe, test, expect } from 'vitest';
import { initSchema, SCHEMA_VERSION } from '../src/db/schema';

// ── helpers ────────────────────────────────────────────────────────────────

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  initSchema(db);
  return db;
}

/** Insert a minimal valid node row and return its id. */
function insertNode(
  db: Database.Database,
  id: string,
  type: string,
): void {
  db.prepare(`
    INSERT INTO node (id, type, value, value_hash, embedding, embedded_hash,
      origin, s, c, last_access, prev_value, prev_ts,
      pending_contradictions, tombstoned, training_eligible)
    VALUES (?, ?, 'test value', 'hash_${id}', NULL, NULL,
      'observed', 0.1, 0.5, 0, NULL, NULL,
      '[]', 0, 0)
  `).run(id, type);
}

/** Insert a minimal valid edge row. */
function insertEdge(
  db: Database.Database,
  src: string,
  dst: string,
  kind: string,
): void {
  db.prepare(`
    INSERT INTO edge (src, dst, rel, w, last_access, kind)
    VALUES (?, ?, 'test_rel', 1.0, 0, ?)
  `).run(src, dst, kind);
}

// ── (a) Fresh DB — CHECK constraints ──────────────────────────────────────

describe('schema v11 (now v12) fresh DB', () => {
  test('SCHEMA_VERSION constant is 12', () => {
    expect(SCHEMA_VERSION).toBe(12);
  });

  test("node type='doc' insert succeeds on fresh DB", () => {
    const db = freshDb();
    expect(() => insertNode(db, 'doc-node-1', 'doc')).not.toThrow();
  });

  test("node type='entity'/'fact'/'schema' still accepted", () => {
    const db = freshDb();
    expect(() => insertNode(db, 'n-entity', 'entity')).not.toThrow();
    expect(() => insertNode(db, 'n-fact', 'fact')).not.toThrow();
    expect(() => insertNode(db, 'n-schema', 'schema')).not.toThrow();
  });

  test("node type='bogus' is rejected by CHECK constraint", () => {
    const db = freshDb();
    expect(() => insertNode(db, 'n-bogus', 'bogus')).toThrow();
  });

  test("edge kind='cites' insert succeeds on fresh DB", () => {
    const db = freshDb();
    insertNode(db, 'src-1', 'doc');
    insertNode(db, 'dst-1', 'fact');
    expect(() => insertEdge(db, 'src-1', 'dst-1', 'cites')).not.toThrow();
  });

  test("edge kind='doc_link' insert succeeds on fresh DB", () => {
    const db = freshDb();
    insertNode(db, 'src-2', 'doc');
    insertNode(db, 'dst-2', 'doc');
    expect(() => insertEdge(db, 'src-2', 'dst-2', 'doc_link')).not.toThrow();
  });

  test("edge kind='relation'/'abstracts'/'schema_rel' still accepted", () => {
    const db = freshDb();
    insertNode(db, 'e1', 'entity');
    insertNode(db, 'e2', 'entity');
    insertNode(db, 'e3', 'schema');
    expect(() => insertEdge(db, 'e1', 'e2', 'relation')).not.toThrow();
    expect(() => insertEdge(db, 'e3', 'e2', 'abstracts')).not.toThrow();
    // schema_rel uses different rel to avoid PK conflict
    db.prepare(`INSERT INTO edge (src, dst, rel, w, last_access, kind) VALUES (?, ?, 'schema_rel_r', 1.0, 0, 'schema_rel')`).run('e3', 'e2');
  });

  test("edge kind='bogus' is rejected by CHECK constraint", () => {
    const db = freshDb();
    insertNode(db, 'src-b', 'entity');
    insertNode(db, 'dst-b', 'entity');
    expect(() => insertEdge(db, 'src-b', 'dst-b', 'bogus')).toThrow();
  });
});

// ── (b)/(c) Pre-v11 DB migration ──────────────────────────────────────────

describe('schema v11 migration from pre-v11 DB', () => {
  /** Build a raw in-memory DB with the OLD DDL (no 'doc', no 'cites'/'doc_link') and
   *  seed it with a fact row so we can assert row-preservation after migration. */
  function buildPreV11Db(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Old node DDL without 'doc'
    db.exec(`
      CREATE TABLE IF NOT EXISTS node (
        id                     TEXT    PRIMARY KEY,
        type                   TEXT    NOT NULL CHECK(type IN ('entity','fact','schema')),
        value                  TEXT    NOT NULL,
        value_hash             TEXT    NOT NULL,
        embedding              BLOB,
        embedded_hash          TEXT,
        origin                 TEXT    NOT NULL CHECK(origin IN ('observed','asserted_by_user','inferred')),
        s                      REAL    NOT NULL DEFAULT 0.1,
        c                      REAL    NOT NULL DEFAULT 0.5,
        last_access            INTEGER NOT NULL,
        prev_value             TEXT,
        prev_ts                INTEGER,
        pending_contradictions TEXT    NOT NULL DEFAULT '[]',
        tombstoned             INTEGER NOT NULL DEFAULT 0,
        training_eligible      INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS edge (
        src         TEXT    NOT NULL REFERENCES node(id),
        dst         TEXT    NOT NULL REFERENCES node(id),
        rel         TEXT    NOT NULL,
        w           REAL    NOT NULL DEFAULT 0.1,
        last_access INTEGER NOT NULL,
        kind        TEXT    NOT NULL CHECK(kind IN ('relation','abstracts','schema_rel')),
        PRIMARY KEY (src, dst, rel)
      );

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS episode (
        id                  TEXT    PRIMARY KEY,
        ts                  INTEGER NOT NULL,
        content             TEXT    NOT NULL,
        origin              TEXT    NOT NULL CHECK(origin IN ('observed','asserted_by_user','inferred')),
        salience            REAL    NOT NULL,
        hard_keep           INTEGER NOT NULL DEFAULT 0,
        consolidated        INTEGER NOT NULL DEFAULT 0,
        source_inference_id TEXT    REFERENCES episode(id),
        role                TEXT    NOT NULL CHECK(role IN ('user','assistant','tool')),
        session_id          TEXT    NOT NULL,
        source              TEXT    NOT NULL DEFAULT 'claude-code',
        external_id         TEXT,
        cwd                 TEXT    NOT NULL DEFAULT ''
      );

      INSERT INTO meta (key, value) VALUES ('schema_version', '10');
    `);

    // Seed a fact row that must survive migration
    db.prepare(`
      INSERT INTO node (id, type, value, value_hash, embedding, embedded_hash,
        origin, s, c, last_access, prev_value, prev_ts,
        pending_contradictions, tombstoned, training_eligible)
      VALUES ('seed-fact-1', 'fact', 'The sky is blue', 'hash_seed', NULL, NULL,
        'observed', 0.8, 0.9, 1000, NULL, NULL, '[]', 0, 1)
    `).run();

    // Seed an edge (entity → fact)
    db.prepare(`
      INSERT INTO node (id, type, value, value_hash, embedding, embedded_hash,
        origin, s, c, last_access, prev_value, prev_ts,
        pending_contradictions, tombstoned, training_eligible)
      VALUES ('seed-entity-1', 'entity', 'sky', 'hash_ent', NULL, NULL,
        'observed', 0.5, 0.5, 1000, NULL, NULL, '[]', 0, 0)
    `).run();
    db.prepare(`
      INSERT INTO edge (src, dst, rel, w, last_access, kind)
      VALUES ('seed-entity-1', 'seed-fact-1', 'about', 0.8, 1000, 'relation')
    `).run();

    return db;
  }

  test('migration runs: type=doc insert succeeds after migrating pre-v11 DB', () => {
    const db = buildPreV11Db();
    // Run initSchema — this should trigger the v11 migration
    initSchema(db);

    // Now type='doc' should be accepted
    expect(() => insertNode(db, 'new-doc-1', 'doc')).not.toThrow();
  });

  test('migration preserves seeded fact row', () => {
    const db = buildPreV11Db();
    initSchema(db);

    const row = db.prepare('SELECT id, value, type FROM node WHERE id = ?').get('seed-fact-1') as
      { id: string; value: string; type: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.value).toBe('The sky is blue');
    expect(row!.type).toBe('fact');
  });

  test('migration preserves seeded edge row', () => {
    const db = buildPreV11Db();
    initSchema(db);

    const edge = db.prepare('SELECT * FROM edge WHERE src = ?').get('seed-entity-1') as
      { src: string; dst: string; rel: string; kind: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.dst).toBe('seed-fact-1');
    expect(edge!.kind).toBe('relation');
  });

  test('PRAGMA foreign_key_check returns empty after migration', () => {
    const db = buildPreV11Db();
    initSchema(db);

    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations).toHaveLength(0);
  });

  test("meta.schema_version = '12' after migration", () => {
    const db = buildPreV11Db();
    initSchema(db);

    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      { value: string } | undefined;
    expect(row?.value).toBe('12');
  });

  test('migration is idempotent: second initSchema call leaves data intact', () => {
    const db = buildPreV11Db();
    initSchema(db);
    insertNode(db, 'post-migration-node', 'doc');

    // Second call should be a no-op
    expect(() => initSchema(db)).not.toThrow();

    // Data still present
    const row = db.prepare('SELECT id FROM node WHERE id = ?').get('post-migration-node') as
      { id: string } | undefined;
    expect(row?.id).toBe('post-migration-node');
  });
});

// ── (d) node_doc sidecar ──────────────────────────────────────────────────

describe('node_doc sidecar table', () => {
  test('node_doc table exists with expected columns', () => {
    const db = freshDb();
    const cols = (db.pragma('table_info(node_doc)') as Array<{ name: string }>).map(r => r.name);
    expect(cols).toContain('node_id');
    expect(cols).toContain('slug');
    expect(cols).toContain('generated_at');
    expect(cols).toContain('updated_at');
  });

  test('idx_node_doc_slug index exists', () => {
    const db = freshDb();
    const indexes = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='node_doc'").all() as
        Array<{ name: string }>
    ).map(r => r.name);
    expect(indexes).toContain('idx_node_doc_slug');
  });

  test('node_doc insert + read round-trip works', () => {
    const db = freshDb();
    insertNode(db, 'doc-for-sidecar', 'doc');
    db.prepare(`
      INSERT INTO node_doc (node_id, slug, generated_at, updated_at)
      VALUES (?, 'test-project', 1000, 2000)
    `).run('doc-for-sidecar');

    const row = db.prepare('SELECT * FROM node_doc WHERE node_id = ?').get('doc-for-sidecar') as
      { node_id: string; slug: string; generated_at: number; updated_at: number } | undefined;
    expect(row?.slug).toBe('test-project');
    expect(row?.generated_at).toBe(1000);
    expect(row?.updated_at).toBe(2000);
  });

  test('generated_at column is separate from node.last_access', () => {
    const db = freshDb();
    insertNode(db, 'doc-ts-test', 'doc');
    db.prepare(`
      INSERT INTO node_doc (node_id, slug, generated_at, updated_at)
      VALUES (?, 'ts-proj', 9999, 9999)
    `).run('doc-ts-test');

    // Advance node.last_access
    db.prepare('UPDATE node SET last_access = 12345 WHERE id = ?').run('doc-ts-test');

    const nodeRow = db.prepare('SELECT last_access FROM node WHERE id = ?').get('doc-ts-test') as
      { last_access: number } | undefined;
    const docRow = db.prepare('SELECT generated_at FROM node_doc WHERE node_id = ?').get('doc-ts-test') as
      { generated_at: number } | undefined;

    // last_access advanced but generated_at unchanged — they are independent columns
    expect(nodeRow?.last_access).toBe(12345);
    expect(docRow?.generated_at).toBe(9999);
  });
});

// ── (e) schema version stamp ──────────────────────────────────────────────

describe('schema version stamp', () => {
  test('fresh DB is stamped v12', () => {
    const db = freshDb();
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      { value: string } | undefined;
    expect(row?.value).toBe('12');
  });
});
