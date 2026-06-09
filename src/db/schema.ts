/**
 * SQLite DDL + initSchema for brain-memory (STORE-01).
 *
 * Four record types: episode, node, edge, meta.
 * All tables use CREATE TABLE IF NOT EXISTS — initSchema is idempotent.
 * Schema version is tracked in the meta table; future migrations add ALTER TABLE
 * branches below the current DDL without removing old ones.
 */
import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 4;

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
    session_id          TEXT    NOT NULL,
    source              TEXT    NOT NULL DEFAULT 'claude-code',
    external_id         TEXT,
    cwd                 TEXT    NOT NULL DEFAULT ''
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

  -- SEAM-02: ConsolidationSink event stream (append-only, single-writer: offline pass).
  -- Each row mirrors one applyDecision branch + schema emitted/falsified (D-49).
  -- Written atomically inside the same per-episode db.transaction as the graph mutation (D-48).
  -- schema_version uses SCHEMA_VERSION at emit time so corpus consumers can version-gate (D-49).
  CREATE TABLE IF NOT EXISTS consolidation_event (
    id             TEXT    PRIMARY KEY,
    ts             INTEGER NOT NULL,
    schema_version INTEGER NOT NULL,
    event_type     TEXT    NOT NULL,
    node_id        TEXT,
    candidate_id   TEXT,
    episode_id     TEXT,
    value          TEXT,
    origin         TEXT,
    magnitude      REAL,
    payload        TEXT
  );

  -- VIZ: ring-buffered spreading-activation trace (schema v4, append-only, capped at 50 rows).
  -- Written by SQLiteActivationTraceSink; read by the viz server's read-only handle.
  -- Ring eviction: DELETE WHERE id NOT IN (SELECT id FROM activation_trace ORDER BY id DESC LIMIT 50)
  -- run after every insert (single-writer, viz server never writes).
  CREATE TABLE IF NOT EXISTS activation_trace (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    query_id  TEXT    NOT NULL,
    seeds     TEXT    NOT NULL,  -- JSON array of node ids
    hops      TEXT    NOT NULL   -- JSON array of {node_id, score, hop}
  );
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

  // v2 migration: add source/external_id to existing DBs.
  // SQLite ALTER TABLE ADD COLUMN has no IF NOT EXISTS, so guard with PRAGMA table_info.
  // Fresh DBs already have the columns from DDL above → PRAGMA check skips the ALTER.
  // Equivalent to: PRAGMA table_info(episode) → Set of column names.
  const cols = new Set(
    (db.pragma('table_info(episode)') as Array<{ name: string }>).map(r => r.name)
  );
  if (!cols.has('source')) {
    db.exec("ALTER TABLE episode ADD COLUMN source TEXT NOT NULL DEFAULT 'claude-code'");
  }
  if (!cols.has('external_id')) {
    db.exec('ALTER TABLE episode ADD COLUMN external_id TEXT');
  }

  // New indexes land here (not in DDL) because the columns may arrive via ALTER above.
  // idx_episode_source_consolidated: hot path for per-source sleep pass queries.
  // uq_episode_source_external: the dedup backstop (D-59). NULL external_id rows are
  // treated as distinct by SQLite's unique index semantics — legacy claude-code episodes
  // never collide with each other (INGEST-01 preserved).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_episode_source_consolidated
      ON episode(source, consolidated);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_episode_source_external
      ON episode(source, external_id);
  `);

  // v3 migration: add cwd to existing DBs for cross-project scoping (DEBT-06).
  // Same PRAGMA table_info guard as the v2 migration above — idempotent re-run.
  // Fresh DBs already have cwd from the DDL above → guard skips the ALTER.
  // Existing v2 DBs: cwd absent → ALTER TABLE adds it with DEFAULT '' (no backfill, no data loss).
  if (!cols.has('cwd')) {
    db.exec("ALTER TABLE episode ADD COLUMN cwd TEXT NOT NULL DEFAULT ''");
  }

  // idx_episode_cwd: accelerates cwd-scoped retrieval join (DEBT-06 Option A soft filter).
  // Uses CREATE INDEX IF NOT EXISTS — idempotent.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_episode_cwd
      ON episode(cwd, consolidated);
  `);

  // v4 migration: activation_trace ring-buffered table + ts index (VIZ-02).
  // Table uses CREATE TABLE IF NOT EXISTS in DDL above → idempotent, no ALTER needed.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_activation_trace_ts
      ON activation_trace(ts DESC);
  `);

  // Stamp or update schema version in the now-guaranteed meta table
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)"
  ).run(String(SCHEMA_VERSION));
}
