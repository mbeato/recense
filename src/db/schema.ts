/**
 * SQLite DDL + initSchema for brain-memory (STORE-01).
 *
 * Four record types: episode, node, edge, meta.
 * All tables use CREATE TABLE IF NOT EXISTS — initSchema is idempotent.
 * Schema version is tracked in the meta table; future migrations add ALTER TABLE
 * branches below the current DDL without removing old ones.
 */
import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

/**
 * Full DDL for all four tables plus three hot-path indexes (spec §1, RESEARCH Pattern 1).
 * Design notes:
 *  - pending_contradictions: JSON TEXT array (small, ≤N=3 entries before destabilization)
 *  - prev_value + prev_ts: two nullable columns, not JSON (typed reads without parse step)
 *  - embedding: BLOB (Float32Array → Buffer); NULL when dirty
 *  - embedded_hash: NULL == never embedded; != value_hash == stale
 *  - idx_node_dirty: partial index over dirty nodes (WHERE embedded_hash IS NULL)
 */
export const DDL = `
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
    session_id          TEXT    NOT NULL
  );

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
    kind        TEXT    NOT NULL CHECK(kind IN ('relation','abstracts')),
    PRIMARY KEY (src, dst, rel)
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_episode_unconsolidated
    ON episode(consolidated, salience DESC);

  CREATE TABLE IF NOT EXISTS eval_snapshot (
    id              TEXT    PRIMARY KEY,
    ts              INTEGER NOT NULL,
    query           TEXT    NOT NULL,
    expected_answer TEXT    NOT NULL,
    created_session TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_node_dirty
    ON node(embedded_hash) WHERE embedded_hash IS NULL;

  CREATE INDEX IF NOT EXISTS idx_node_eviction
    ON node(tombstoned, s, c);
`;

/**
 * Create all tables, set WAL mode + FK enforcement, and stamp the schema version.
 *
 * Safe to call multiple times — idempotent via CREATE TABLE IF NOT EXISTS.
 * WAL mode enables concurrent reads during the offline consolidation pass.
 */
export function initSchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL');       // concurrent reads + offline pass
  db.pragma('foreign_keys = ON');        // enforce REFERENCES constraints
  db.pragma('synchronous = NORMAL');     // safe with WAL; faster than FULL

  // DDL runs unconditionally — all statements use IF NOT EXISTS
  db.exec(DDL);

  // Stamp or update schema version in the now-guaranteed meta table
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)"
  ).run(String(SCHEMA_VERSION));
}
