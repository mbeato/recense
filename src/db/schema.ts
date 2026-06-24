/**
 * SQLite DDL + initSchema for recense (STORE-01).
 *
 * Four record types: episode, node, edge, meta.
 * All tables use CREATE TABLE IF NOT EXISTS — initSchema is idempotent.
 * Schema version is tracked in the meta table; future migrations add ALTER TABLE
 * branches below the current DDL without removing old ones.
 */
import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 14;

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
    type                   TEXT    NOT NULL CHECK(type IN ('entity','fact','schema','doc','insight')),
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
    kind        TEXT    NOT NULL CHECK(kind IN ('relation','abstracts','schema_rel','cites','doc_link','doc_containment','doc_reference','derived_from')),
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

  -- TEMP-02: sparse sidecar for temporal annotations (Phase 20).
  -- 1:1 with the temporal subset of nodes (not all nodes have due_at/action_type).
  -- Single writer: sleep pass consolidator only (CONSOL-03).
  -- FK → node(id): tombstoning a node does NOT auto-delete node_temporal; the consolidator
  -- must update or ignore stale rows (Phase 21 surfacing reads tombstoned=0 filter on node).
  CREATE TABLE IF NOT EXISTS node_temporal (
    node_id         TEXT    PRIMARY KEY REFERENCES node(id),
    due_at          TEXT    NOT NULL,    -- ISO-8601 UTC; next occurrence >= now for recurring
    action_type     TEXT    NOT NULL CHECK(action_type IN (
                      'deadline','flight','appointment','receipt','payment','meeting','other'
                    )),
    recurrence_rule TEXT,               -- RRULE string for recurring events (NULL for one-off)
    source_event_id TEXT,               -- Calendar event id for dedup and cancellation linkage
    updated_at      INTEGER NOT NULL    -- epoch ms; set on every upsert
  );

  -- SCOPE-01: sparse sidecar for single-tenant PROVENANCE attribution (Phase 999.3, D-S2).
  -- 1:1 with the scoped subset of nodes (a node carries a scope only once consolidation
  -- has stamped it). Mirrors the node_temporal precedent exactly: additive, derived
  -- operational annotation — the node table stays the pure belief record (faithfulness).
  -- scope is a PROVENANCE primitive (which project a fact came from), NOT a tenancy
  -- boundary: retrieval ranking/score/selection never read it (D-S1). Single writer:
  -- the sleep-pass consolidator only (CONSOL-03). FK → node(id): tombstoning a node does
  -- NOT auto-delete node_scope; stale rows are harmless (scope is display-only).
  CREATE TABLE IF NOT EXISTS node_scope (
    node_id    TEXT    PRIMARY KEY REFERENCES node(id),
    scope      TEXT    NOT NULL,    -- project slug (e.g. 'vtx') or 'global'
    updated_at INTEGER NOT NULL     -- epoch ms; set on every upsert
  );

  -- READER-01: doc metadata sidecar (1:1 with type='doc' nodes, Phase 27).
  -- generated_at is a DEDICATED column — NOT node.last_access — so the staleness predicate
  -- (node.last_access > doc.generated_at) cannot be corrupted when the doc node is accessed
  -- (CONTEXT D §generatedAt). Single writer: doc-writer path only (CONSOL-03 discipline).
  -- FK → node(id): tombstoning a doc node does NOT auto-delete node_doc; stale rows are harmless.
  CREATE TABLE IF NOT EXISTS node_doc (
    node_id      TEXT    PRIMARY KEY REFERENCES node(id),
    slug         TEXT    NOT NULL,      -- project slug (matches node_scope.scope)
    generated_at INTEGER NOT NULL,      -- epoch ms; set once on first generate, updated on regen
    updated_at   INTEGER NOT NULL       -- epoch ms; always updated
  );

  -- REFLECT-01: insight metadata sidecar (1:1 with type='insight' nodes, Phase 38).
  -- anchor_schema_id: the schema cluster this insight was synthesized from (D-02).
  -- generated_at is a DEDICATED column — NOT node.last_access — so the staleness predicate
  -- cannot be corrupted when the insight node is accessed (mirrors node_doc D §generatedAt).
  -- generated_at is write-once: ON CONFLICT DO UPDATE SET omits it (only anchor_schema_id + updated_at update).
  -- Single writer: InsightReflector path only (CONSOL-03 discipline).
  -- FK → node(id): tombstoning an insight node does NOT auto-delete node_insight;
  -- BUT the hard-delete eviction sweep in decay.ts MUST child-wipe this table BEFORE
  -- DELETE FROM node (FK-safe eviction — T-38-01). See decay.ts stmtDeleteInsightForNode.
  CREATE TABLE IF NOT EXISTS node_insight (
    node_id         TEXT    PRIMARY KEY REFERENCES node(id),
    anchor_schema_id TEXT   NOT NULL,   -- schema node id this insight was derived from
    generated_at    INTEGER NOT NULL,   -- epoch ms; set once on first generate, write-once (never updated on conflict)
    updated_at      INTEGER NOT NULL    -- epoch ms; always updated
  );

  -- COST-01: token-usage ledger (append-only, single-writer: sleep pass only).
  -- One row per LLM call; feature_tag identifies the sleep-pass phase (extract/judge/corpus_gen/schema_abstract).
  -- ts stores Date.now() ms so any window (rolling 30d, all-time) is a cheap aggregate query (D-08/D-09/D-10).
  CREATE TABLE IF NOT EXISTS token_usage_ledger (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                  INTEGER NOT NULL,
    feature_tag         TEXT    NOT NULL,
    model               TEXT    NOT NULL,
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
    total_cost_usd      REAL    NOT NULL DEFAULT 0
  );

  -- SURF-02: operational surface-outcome log (append-only, single-writer: serve path only).
  -- Idempotency key: (node_id, occurrence_due_at) — one row per node per occurrence.
  -- For recurring items, consolidator recomputes due_at to next occurrence, so distinct
  -- occurrences each get their own row (D-05). Sleep pass NEVER reads or writes this table (D-08).
  CREATE TABLE IF NOT EXISTS surfaced_event (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id           TEXT    NOT NULL REFERENCES node(id),
    occurrence_due_at TEXT    NOT NULL,           -- ISO-8601 UTC; the due_at at surface time
    outcome           TEXT    NOT NULL DEFAULT 'surfaced'
                              CHECK(outcome IN ('surfaced','seen','snoozed','completed','dismissed')),
    snooze_until      TEXT,                       -- ISO-8601 UTC; non-null when outcome='snoozed'
    created_at        INTEGER NOT NULL,           -- epoch ms; immutable
    updated_at        INTEGER NOT NULL,           -- epoch ms; updated on every outcome change
    UNIQUE(node_id, occurrence_due_at)
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
  db.pragma('busy_timeout = 5000');      // wait up to 5s on write collision rather than throwing SQLITE_BUSY (T-LOCK-02 defense-in-depth)

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

  // v4 migration: activation_trace ring-buffered table (VIZ-02).
  // Table uses CREATE TABLE IF NOT EXISTS in DDL above → idempotent, no ALTER needed.
  // idx_activation_trace_ts was created here but is a DEAD INDEX (queries hit by id, not ts).
  // It is dropped below in the v5 migration to keep the index set clean.

  // v5 migration: drop dead indexes + create hot-path indexes (M-10, L-7).
  //  - idx_node_eviction: dead — the eviction sweep is a full scan (c is monotonically
  //    non-decreasing so the c < 0.15 gate is never true in practice; M-1).
  //  - idx_activation_trace_ts: dead — activation_trace rows are read by id, not ts.
  //  - idx_consolidation_event_node/episode: two full-scans per SessionStart (M-10).
  //  - idx_episode_origin_ts: listRecentInferred / detectEcho (M-10).
  //  - idx_edge_dst: getInEdges WHERE dst=? — edge PK is src-prefix so has no dst coverage (L-7).
  db.exec(`
    DROP INDEX IF EXISTS idx_node_eviction;
    DROP INDEX IF EXISTS idx_activation_trace_ts;
    CREATE INDEX IF NOT EXISTS idx_consolidation_event_node
      ON consolidation_event(node_id);
    CREATE INDEX IF NOT EXISTS idx_consolidation_event_episode
      ON consolidation_event(episode_id);
    CREATE INDEX IF NOT EXISTS idx_episode_origin_ts
      ON episode(origin, ts);
    CREATE INDEX IF NOT EXISTS idx_edge_dst
      ON edge(dst);
  `);

  // v6 migration: FTS5 keyword index for hybrid BM25+cosine retrieval (Phase 17 LEVER 1).
  // Standalone table (not external-content): node.id is TEXT PK with unstable implicit rowid
  // → external-content FTS5 would silently corrupt on VACUUM. Standalone + manual sync is correct.
  // node_id UNINDEXED: not a retrieval column; used only for JOIN to node table.
  // Backfill from live (non-tombstoned) nodes — rebuildable derived cache (mirrors embedding doctrine).
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
      node_id UNINDEXED,
      value,
      tokenize='unicode61 remove_diacritics 2'
    );
  `);

  // Backfill: only if empty (idempotent re-run safe).
  // Only live (tombstoned=0) nodes enter the index; tombstone() sync keeps it current.
  // Plain DELETE FROM node_fts WHERE ... works; the special 'delete' command does NOT — do not use.
  const ftsCount = (db.prepare('SELECT count(*) AS n FROM node_fts').get() as { n: number }).n;
  if (ftsCount === 0) {
    db.exec(`
      INSERT INTO node_fts(node_id, value)
      SELECT id, value FROM node WHERE tombstoned = 0
    `);
  }

  // v7 migration: expand edge.kind CHECK constraint to include 'schema_rel' (Phase 18 SREL-01).
  // SQLite does not support ALTER TABLE DROP CONSTRAINT, so table recreation is required.
  // Guard: check whether the existing edge table DDL already includes 'schema_rel' — idempotent
  // re-run safe. In-memory / fresh DBs already have the updated DDL from above → guard skips.
  const edgeDdl = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='edge'")
    .get() as { sql: string } | undefined)?.sql ?? '';
  if (!edgeDdl.includes('schema_rel')) {
    // PRAGMA foreign_keys must be set OUTSIDE a transaction (SQLite requirement).
    db.pragma('foreign_keys = OFF');
    // Wrap the create/copy/drop/rename in an explicit transaction so a crash mid-swap
    // rolls back atomically (CR-02): without it, SQLite auto-commits each statement, and a
    // crash between `DROP TABLE edge` and the RENAME would leave the edge table gone while a
    // fresh empty `edge` (with up-to-date DDL) is recreated on restart — silently skipping
    // re-migration and permanently losing the entire edge graph. SQLite allows DDL in a txn.
    db.exec(`
      BEGIN;
      CREATE TABLE edge_v7 (
        src         TEXT    NOT NULL REFERENCES node(id),
        dst         TEXT    NOT NULL REFERENCES node(id),
        rel         TEXT    NOT NULL,
        w           REAL    NOT NULL DEFAULT 0.1,
        last_access INTEGER NOT NULL,
        kind        TEXT    NOT NULL CHECK(kind IN ('relation','abstracts','schema_rel')),
        PRIMARY KEY (src, dst, rel)
      );
      INSERT INTO edge_v7 SELECT * FROM edge;
      DROP TABLE edge;
      ALTER TABLE edge_v7 RENAME TO edge;
      COMMIT;
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_edge_dst ON edge(dst);`);
    db.pragma('foreign_keys = ON');
  }

  // v8 migration: node_temporal sidecar for temporal annotations (Phase 20, TEMP-02).
  // Table uses CREATE TABLE IF NOT EXISTS in DDL above → idempotent on fresh DBs.
  // Existing v7 DBs: node_temporal absent → DDL above creates it (IF NOT EXISTS catches it).
  // No ALTER TABLE needed — the whole table is new (no column additions to existing tables).
  // Index for Phase 21 surfacing: query by due_at range (LLM-free hot path).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_node_temporal_due_at
      ON node_temporal(due_at);
  `);

  // v9 migration: surfaced_event operational table (Phase 21, SURF-02).
  // Table uses CREATE TABLE IF NOT EXISTS in DDL above → idempotent on fresh DBs.
  // Existing v8 DBs: surfaced_event absent → DDL above creates it (IF NOT EXISTS catches it).
  // No ALTER TABLE needed — the whole table is new.
  // Indexes for Phase 21 exclusion query: (node_id, occurrence_due_at) covered by UNIQUE constraint.
  // outcome+snooze_until index: exclusion filter WHERE outcome IN (...) OR snooze_until > now.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_surfaced_event_node_occ
      ON surfaced_event(node_id, occurrence_due_at);
    CREATE INDEX IF NOT EXISTS idx_surfaced_event_outcome
      ON surfaced_event(outcome, snooze_until);
  `);

  // v10 migration: node_scope sidecar for single-tenant provenance (Phase 999.3, SCOPE-01).
  // Table uses CREATE TABLE IF NOT EXISTS in DDL above → idempotent on fresh DBs.
  // Existing v9 DBs: node_scope absent → DDL above creates it (IF NOT EXISTS catches it).
  // No ALTER TABLE needed — the whole table is new (no column additions to existing tables).
  // Index for future scope-grouped queries (importer/migration plan 02); display path
  // reads by node_id (PK) so the index is forward-looking, not on a current hot path.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_node_scope_scope
      ON node_scope(scope);
  `);

  // v11 migration: extend node.type CHECK to include 'doc'; extend edge.kind CHECK to include
  // 'cites' and 'doc_link'. SQLite cannot ALTER a CHECK constraint — table recreation required.
  // Guard: check whether the live DDL already includes 'doc' / 'cites' — idempotent re-run safe.
  // In-memory / fresh DBs built from the updated DDL above already have the new constraints →
  // guard skips. The node table recreation must also re-create all node-referencing indexes and
  // FTS triggers that reference node; the edge recreation re-creates idx_edge_dst.
  //
  // T-27-01 atomicity: both recreations are wrapped in explicit BEGIN/COMMIT so a crash mid-swap
  // rolls back cleanly (mirrors the v7 CR-02 pattern).
  // T-27-02 idempotency: the guard checks the live DDL string — a re-run is a no-op if the
  // constraint already includes 'doc' / 'cites'.
  //
  // node recreation guard — check live DDL for 'doc'
  const nodeDdl = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='node'")
    .get() as { sql: string } | undefined)?.sql ?? '';
  if (!nodeDdl.includes("'doc'")) {
    // PRAGMA foreign_keys must be set OUTSIDE a transaction (SQLite requirement).
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE node_v11 (
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
      INSERT INTO node_v11 SELECT * FROM node;
      DROP TABLE node;
      ALTER TABLE node_v11 RENAME TO node;
      COMMIT;
    `);
    // Re-create node indexes (dropped with the old table).
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_node_dirty
        ON node(embedded_hash) WHERE embedded_hash IS NULL;
    `);
    // Re-create node_fts virtual table (may still exist; IF NOT EXISTS is safe).
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
        node_id UNINDEXED,
        value,
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
    db.pragma('foreign_keys = ON');
  }

  // edge recreation guard — check live DDL for 'cites'
  const edgeDdlV11 = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='edge'")
    .get() as { sql: string } | undefined)?.sql ?? '';
  if (!edgeDdlV11.includes("'cites'")) {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE edge_v11 (
        src         TEXT    NOT NULL REFERENCES node(id),
        dst         TEXT    NOT NULL REFERENCES node(id),
        rel         TEXT    NOT NULL,
        w           REAL    NOT NULL DEFAULT 0.1,
        last_access INTEGER NOT NULL,
        kind        TEXT    NOT NULL CHECK(kind IN ('relation','abstracts','schema_rel','cites','doc_link')),
        PRIMARY KEY (src, dst, rel)
      );
      INSERT INTO edge_v11 SELECT * FROM edge;
      DROP TABLE edge;
      ALTER TABLE edge_v11 RENAME TO edge;
      COMMIT;
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_edge_dst ON edge(dst);`);
    db.pragma('foreign_keys = ON');
  }

  // v12 migration: extend edge.kind CHECK to include 'doc_containment' and 'doc_reference'.
  // These two new kinds support schema-anchored corpus edges (Phase 28):
  //   doc_containment — directed parent→child schema-doc edge
  //   doc_reference   — undirected/cosine-derived semantic peer edge
  // SQLite cannot ALTER a CHECK constraint — table recreation is required.
  // Guard: check whether the live edge DDL already includes 'doc_containment' — idempotent.
  // In-memory / fresh DBs built from the updated DDL above already have the new constraint →
  // guard skips. doc_link is NOT retired (scope-doc→scope-doc links still use it).
  // T-28-FK: mirrors the v11 pattern exactly — foreign_keys=OFF, BEGIN/COMMIT swap, recreate idx.
  const edgeDdlV12 = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='edge'")
    .get() as { sql: string } | undefined)?.sql ?? '';
  if (!edgeDdlV12.includes("'doc_containment'")) {
    // PRAGMA foreign_keys must be set OUTSIDE a transaction (SQLite requirement).
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE edge_v12 (
        src         TEXT    NOT NULL REFERENCES node(id),
        dst         TEXT    NOT NULL REFERENCES node(id),
        rel         TEXT    NOT NULL,
        w           REAL    NOT NULL DEFAULT 0.1,
        last_access INTEGER NOT NULL,
        kind        TEXT    NOT NULL CHECK(kind IN ('relation','abstracts','schema_rel','cites','doc_link','doc_containment','doc_reference')),
        PRIMARY KEY (src, dst, rel)
      );
      INSERT INTO edge_v12 SELECT * FROM edge;
      DROP TABLE edge;
      ALTER TABLE edge_v12 RENAME TO edge;
      COMMIT;
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_edge_dst ON edge(dst);`);
    db.pragma('foreign_keys = ON');
  }

  // v11 migration: add node_doc sidecar table + idx_node_doc_slug.
  // Table uses CREATE TABLE IF NOT EXISTS in DDL above → idempotent on fresh DBs.
  // Existing v10 DBs: node_doc absent → DDL above creates it (IF NOT EXISTS catches it).
  // No ALTER TABLE needed — the whole table is new (no column additions to existing tables).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_node_doc_slug
      ON node_doc(slug);
  `);

  // v13 migration: extend node.type CHECK to include 'insight' (Phase 38, REFLECT-01 D-01).
  // SQLite cannot ALTER a CHECK constraint — table recreation required.
  // Guard: check whether the live node DDL already includes 'insight' — idempotent re-run safe.
  // In-memory / fresh DBs built from the updated DDL above already have the new constraint → guard skips.
  // T-38-02 atomicity: wrapped in BEGIN/COMMIT so a crash mid-swap rolls back cleanly (mirrors v11 pattern).
  // T-38-02 idempotency: the guard checks the live DDL string — a re-run is a no-op.
  const nodeDdlV13 = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='node'")
    .get() as { sql: string } | undefined)?.sql ?? '';
  if (!nodeDdlV13.includes("'insight'")) {
    // PRAGMA foreign_keys must be set OUTSIDE a transaction (SQLite requirement).
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE node_v13 (
        id                     TEXT    PRIMARY KEY,
        type                   TEXT    NOT NULL CHECK(type IN ('entity','fact','schema','doc','insight')),
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
      INSERT INTO node_v13 SELECT * FROM node;
      DROP TABLE node;
      ALTER TABLE node_v13 RENAME TO node;
      COMMIT;
    `);
    // Re-create node indexes (dropped with the old table).
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_node_dirty
        ON node(embedded_hash) WHERE embedded_hash IS NULL;
    `);
    // Re-create node_fts virtual table (may still exist; IF NOT EXISTS is safe).
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS node_fts USING fts5(
        node_id UNINDEXED,
        value,
        tokenize='unicode61 remove_diacritics 2'
      );
    `);
    db.pragma('foreign_keys = ON');
  }

  // v13 migration: extend edge.kind CHECK to include 'derived_from' (Phase 38, REFLECT-01 D-02).
  // 'derived_from' edges connect insight nodes to their anchor schema + cited member fact/entity nodes.
  // SQLite cannot ALTER a CHECK constraint — table recreation required.
  // Guard: check whether the live edge DDL already includes 'derived_from' — idempotent re-run safe.
  // T-38-02: mirrors the v12 pattern exactly — foreign_keys=OFF, BEGIN/COMMIT swap, recreate idx.
  const edgeDdlV13 = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='edge'")
    .get() as { sql: string } | undefined)?.sql ?? '';
  if (!edgeDdlV13.includes("'derived_from'")) {
    // PRAGMA foreign_keys must be set OUTSIDE a transaction (SQLite requirement).
    db.pragma('foreign_keys = OFF');
    db.exec(`
      BEGIN;
      CREATE TABLE edge_v13 (
        src         TEXT    NOT NULL REFERENCES node(id),
        dst         TEXT    NOT NULL REFERENCES node(id),
        rel         TEXT    NOT NULL,
        w           REAL    NOT NULL DEFAULT 0.1,
        last_access INTEGER NOT NULL,
        kind        TEXT    NOT NULL CHECK(kind IN ('relation','abstracts','schema_rel','cites','doc_link','doc_containment','doc_reference','derived_from')),
        PRIMARY KEY (src, dst, rel)
      );
      INSERT INTO edge_v13 SELECT * FROM edge;
      DROP TABLE edge;
      ALTER TABLE edge_v13 RENAME TO edge;
      COMMIT;
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_edge_dst ON edge(dst);`);
    db.pragma('foreign_keys = ON');
  }

  // v13 migration: add node_insight sidecar table + idx_node_insight_anchor (Phase 38, REFLECT-01).
  // Table uses CREATE TABLE IF NOT EXISTS in DDL above → idempotent on fresh DBs.
  // Existing v12 DBs: node_insight absent → DDL above creates it (IF NOT EXISTS catches it).
  // No ALTER TABLE needed — the whole table is new (no column additions to existing tables).
  // idx_node_insight_anchor: accelerates the InsightReflector's per-anchor-schema lookup
  // and the recall staleness walk (getInEdges(schemaId) + sidecar freshness check).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_node_insight_anchor
      ON node_insight(anchor_schema_id);
  `);

  // v14 migration: token_usage_ledger + ts index (Phase 44, COST-01, D-08/D-09/D-10).
  // Table uses CREATE TABLE IF NOT EXISTS in DDL above → idempotent on fresh DBs.
  // Existing v13 DBs: token_usage_ledger absent → DDL above creates it (IF NOT EXISTS catches it).
  // No ALTER TABLE needed — the whole table is new (no column additions to existing tables).
  // idx_token_usage_ledger_ts: cheap window queries (rolling 30d / all-time aggregate by ts range).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_token_usage_ledger_ts
      ON token_usage_ledger (ts);
  `);

  // Stamp schema version — read first to guard against downgrade (M-9).
  // Throws when stored > SCHEMA_VERSION so a stale launchd binary can't re-stamp a future DB
  // and mask the mismatch from doctor. Stamps only on fresh DB or upgrade.
  const storedRaw = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
    { value: string } | undefined;
  const stored = storedRaw ? Number(storedRaw.value) : null;
  if (stored !== null && stored > SCHEMA_VERSION) {
    throw new Error(
      'DB schema_version ' + stored + ' is newer than this binary (' + SCHEMA_VERSION +
      ') — upgrade recense; refusing to downgrade-stamp'
    );
  }
  if (stored === null || stored < SCHEMA_VERSION) {
    db.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)"
    ).run(String(SCHEMA_VERSION));
  }
}
