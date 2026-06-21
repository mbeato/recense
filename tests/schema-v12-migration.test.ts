/**
 * Schema v12 migration tests (CORPUS-03/04, 28-01).
 *
 * Covers:
 *  (a) Fresh DB: kind='doc_containment' and kind='doc_reference' inserts succeed; bogus rejected.
 *  (b) kind='doc_link' still accepted after v12 migration (not retired).
 *  (c) Pre-v12 DB (v11-shaped edge table): after initSchema the migration ran.
 *  (d) FK integrity: PRAGMA foreign_key_check returns empty after migration on seeded v11 DB.
 *  (e) Idempotency: calling initSchema a second time on a v12 DB is a no-op.
 *  (f) meta.schema_version == '12' after migration.
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

/** Insert a minimal valid node row. */
function insertNode(db: Database.Database, id: string, type = 'entity'): void {
  db.prepare(`
    INSERT INTO node (id, type, value, value_hash, embedding, embedded_hash,
      origin, s, c, last_access, prev_value, prev_ts,
      pending_contradictions, tombstoned, training_eligible)
    VALUES (?, ?, 'test value', 'hash_${id}', NULL, NULL,
      'observed', 0.1, 0.5, 0, NULL, NULL,
      '[]', 0, 0)
  `).run(id, type);
}

/** Insert a minimal valid edge row with the given kind. */
function insertEdge(db: Database.Database, src: string, dst: string, kind: string): void {
  db.prepare(`
    INSERT INTO edge (src, dst, rel, w, last_access, kind)
    VALUES (?, ?, 'test_rel_${kind}', 1.0, 0, ?)
  `).run(src, dst, kind);
}

// ── (a)/(b) Fresh DB — CHECK constraints ──────────────────────────────────

describe('schema v12 fresh DB — edge.kind CHECK', () => {
  test('SCHEMA_VERSION constant is 13 (v13: insight + derived_from + node_insight)', () => {
    expect(SCHEMA_VERSION).toBe(13);
  });

  test("edge kind='doc_containment' insert succeeds on fresh DB", () => {
    const db = freshDb();
    insertNode(db, 'doc-parent', 'doc');
    insertNode(db, 'doc-child', 'doc');
    expect(() => insertEdge(db, 'doc-parent', 'doc-child', 'doc_containment')).not.toThrow();
  });

  test("edge kind='doc_reference' insert succeeds on fresh DB", () => {
    const db = freshDb();
    insertNode(db, 'doc-a', 'doc');
    insertNode(db, 'doc-b', 'doc');
    expect(() => insertEdge(db, 'doc-a', 'doc-b', 'doc_reference')).not.toThrow();
  });

  test("edge kind='doc_link' still accepted (not retired by v12)", () => {
    const db = freshDb();
    insertNode(db, 'scope-doc-1', 'doc');
    insertNode(db, 'scope-doc-2', 'doc');
    expect(() => insertEdge(db, 'scope-doc-1', 'scope-doc-2', 'doc_link')).not.toThrow();
  });

  test("existing edge kinds still accepted after v12 migration", () => {
    const db = freshDb();
    insertNode(db, 'n1', 'entity');
    insertNode(db, 'n2', 'entity');
    insertNode(db, 'n3', 'schema');
    insertNode(db, 'n4', 'fact');
    insertNode(db, 'n5', 'doc');
    expect(() => insertEdge(db, 'n1', 'n2', 'relation')).not.toThrow();
    expect(() => insertEdge(db, 'n3', 'n1', 'abstracts')).not.toThrow();
    db.prepare(`INSERT INTO edge (src, dst, rel, w, last_access, kind) VALUES (?, ?, 'sr_rel', 1.0, 0, 'schema_rel')`).run('n3', 'n2');
    expect(() => insertEdge(db, 'n5', 'n4', 'cites')).not.toThrow();
  });

  test("bogus edge kind is rejected by CHECK constraint", () => {
    const db = freshDb();
    insertNode(db, 'src-b', 'entity');
    insertNode(db, 'dst-b', 'entity');
    expect(() => insertEdge(db, 'src-b', 'dst-b', 'bogus_kind')).toThrow();
  });
});

// ── (c)/(d) Pre-v12 DB migration (v11-shaped edge table) ──────────────────

describe('schema v12 migration from pre-v12 (v11-shaped) DB', () => {
  /**
   * Build an in-memory DB with the OLD v11 edge DDL
   * (kind CHECK without 'doc_containment'/'doc_reference') and seed rows.
   */
  function buildPreV12Db(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
      CREATE TABLE IF NOT EXISTS node (
        id                     TEXT    PRIMARY KEY,
        type                   TEXT    NOT NULL CHECK(type IN ('entity','fact','schema','doc')),
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
        kind        TEXT    NOT NULL CHECK(kind IN ('relation','abstracts','schema_rel','cites','doc_link')),
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

      INSERT INTO meta (key, value) VALUES ('schema_version', '11');
    `);

    // Seed a fact node and entity so we can test FK integrity and row-preservation
    db.prepare(`
      INSERT INTO node (id, type, value, value_hash, embedding, embedded_hash,
        origin, s, c, last_access, prev_value, prev_ts,
        pending_contradictions, tombstoned, training_eligible)
      VALUES ('seed-fact-v12', 'fact', 'Test fact for v12 migration', 'hash_v12', NULL, NULL,
        'observed', 0.8, 0.9, 1000, NULL, NULL, '[]', 0, 1)
    `).run();

    db.prepare(`
      INSERT INTO node (id, type, value, value_hash, embedding, embedded_hash,
        origin, s, c, last_access, prev_value, prev_ts,
        pending_contradictions, tombstoned, training_eligible)
      VALUES ('seed-entity-v12', 'entity', 'test entity', 'hash_ent_v12', NULL, NULL,
        'observed', 0.5, 0.5, 1000, NULL, NULL, '[]', 0, 0)
    `).run();

    db.prepare(`
      INSERT INTO edge (src, dst, rel, w, last_access, kind)
      VALUES ('seed-entity-v12', 'seed-fact-v12', 'about', 0.8, 1000, 'relation')
    `).run();

    return db;
  }

  test("migration runs: doc_containment insert succeeds after migrating pre-v12 DB", () => {
    const db = buildPreV12Db();
    initSchema(db);

    insertNode(db, 'new-doc-parent', 'doc');
    insertNode(db, 'new-doc-child', 'doc');
    expect(() => insertEdge(db, 'new-doc-parent', 'new-doc-child', 'doc_containment')).not.toThrow();
  });

  test("migration runs: doc_reference insert succeeds after migrating pre-v12 DB", () => {
    const db = buildPreV12Db();
    initSchema(db);

    insertNode(db, 'peer-doc-a', 'doc');
    insertNode(db, 'peer-doc-b', 'doc');
    expect(() => insertEdge(db, 'peer-doc-a', 'peer-doc-b', 'doc_reference')).not.toThrow();
  });

  test("doc_link still accepted after migrating pre-v12 DB (not retired)", () => {
    const db = buildPreV12Db();
    initSchema(db);

    insertNode(db, 'linked-doc-1', 'doc');
    insertNode(db, 'linked-doc-2', 'doc');
    expect(() => insertEdge(db, 'linked-doc-1', 'linked-doc-2', 'doc_link')).not.toThrow();
  });

  test('migration preserves seeded node row', () => {
    const db = buildPreV12Db();
    initSchema(db);

    const row = db.prepare('SELECT id, value, type FROM node WHERE id = ?').get('seed-fact-v12') as
      { id: string; value: string; type: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.value).toBe('Test fact for v12 migration');
    expect(row!.type).toBe('fact');
  });

  test('migration preserves seeded edge row', () => {
    const db = buildPreV12Db();
    initSchema(db);

    const edge = db.prepare('SELECT * FROM edge WHERE src = ?').get('seed-entity-v12') as
      { src: string; dst: string; rel: string; kind: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.dst).toBe('seed-fact-v12');
    expect(edge!.kind).toBe('relation');
  });

  test('(d) PRAGMA foreign_key_check returns empty after migration (T-28-FK)', () => {
    const db = buildPreV12Db();
    initSchema(db);

    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations).toHaveLength(0);
  });

  test("(f) meta.schema_version == '13' after migration (v13: insight + derived_from)", () => {
    const db = buildPreV12Db();
    initSchema(db);

    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      { value: string } | undefined;
    expect(row?.value).toBe('13');
  });

  test('(e) idempotency: second initSchema call on v12 DB is a no-op', () => {
    const db = buildPreV12Db();
    initSchema(db);

    insertNode(db, 'post-v12-node', 'doc');

    // Second call — must not throw, must not lose data
    expect(() => initSchema(db)).not.toThrow();

    const row = db.prepare('SELECT id FROM node WHERE id = ?').get('post-v12-node') as
      { id: string } | undefined;
    expect(row?.id).toBe('post-v12-node');
  });

  test('idempotency: re-running initSchema does not add duplicate edge rows', () => {
    const db = buildPreV12Db();
    initSchema(db);

    const countBefore = (db.prepare('SELECT COUNT(*) as n FROM edge').get() as { n: number }).n;

    // Second initSchema — the guard skips the migration; no rows added or dropped
    initSchema(db);

    const countAfter = (db.prepare('SELECT COUNT(*) as n FROM edge').get() as { n: number }).n;
    expect(countAfter).toBe(countBefore);
  });
});

// ── version stamp guard ────────────────────────────────────────────────────

describe('schema v12 version stamp', () => {
  test('fresh DB is stamped v13 (v13: insight + derived_from + node_insight sidecar)', () => {
    const db = freshDb();
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      { value: string } | undefined;
    expect(row?.value).toBe('13');
  });

  test('downgrade guard: stored > SCHEMA_VERSION still throws', () => {
    const db = new Database(':memory:');
    // Bootstrap a minimal meta + all required tables so initSchema can run once
    initSchema(db);
    // Forcibly write a future version
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION + 1),
    );
    // Second call must throw because stored > SCHEMA_VERSION
    expect(() => initSchema(db)).toThrow(/newer than this binary/);
  });
});
