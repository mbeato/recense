/**
 * SemanticStore — the owned write primitive for the semantic graph (STORE-01, STORE-02).
 *
 * Invariants enforced here (never delegated to callers):
 *  - value_hash = sha256(value) on every write (STORE-02).
 *  - embedded_hash = null whenever value_hash changes (dirty-flag, STORE-02).
 *  - embedding is written ONLY by setEmbedding (single writer, Pitfall 2).
 *  - All SQL uses prepared statements with named parameters (T-01-SQL).
 *  - No async/await anywhere (better-sqlite3 is synchronous, Pitfall 1).
 *
 * Threat mitigations:
 *  - T-01-SQL: every .run()/.get()/.all() uses bound parameters, never string interpolation.
 *  - T-01-DIRTY: setEmbedding is the only writer of node.embedding; prepared statements
 *    are not exported so no code path can bypass the owned primitive.
 */
import Database from 'better-sqlite3';
import { sha256 } from '../lib/hash';
import type { Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { NodeRow, UpsertNodeParams, EdgeKind } from '../lib/types';

export class SemanticStore {
  private readonly db: Database.Database;
  private readonly clock: Clock;
  private readonly config: EngineConfig;

  // Prepared statements — initialized once in constructor (never per-call)
  private readonly stmtGetNode: Database.Statement;
  private readonly stmtInsertNode: Database.Statement;
  private readonly stmtSetEmbedding: Database.Statement;
  private readonly stmtTombstone: Database.Statement;
  private readonly stmtUpdateContradictions: Database.Statement;
  private readonly stmtGetMeta: Database.Statement;
  private readonly stmtSetMeta: Database.Statement;
  private readonly stmtUpsertEdge: Database.Statement;

  // Transaction-wrapped upsertNode body (defined in constructor, called in upsertNode)
  private readonly txUpsertNode: (params: UpsertNodeParams) => void;

  constructor(db: Database.Database, clock: Clock, config: EngineConfig) {
    this.db = db;
    this.clock = clock;
    this.config = config;

    // ── Prepared statements (all use ? or @named params — T-01-SQL) ──────────

    this.stmtGetNode = db.prepare('SELECT * FROM node WHERE id = ?');

    this.stmtInsertNode = db.prepare(`
      INSERT INTO node (
        id, type, value, value_hash, embedding, embedded_hash,
        origin, s, c, last_access, prev_value, prev_ts,
        pending_contradictions, tombstoned, training_eligible
      ) VALUES (
        @id, @type, @value, @value_hash, @embedding, @embedded_hash,
        @origin, @s, @c, @last_access, @prev_value, @prev_ts,
        @pending_contradictions, @tombstoned, @training_eligible
      )
      ON CONFLICT(id) DO UPDATE SET
        type                   = excluded.type,
        value                  = excluded.value,
        value_hash             = excluded.value_hash,
        embedding              = excluded.embedding,
        embedded_hash          = excluded.embedded_hash,
        origin                 = excluded.origin,
        s                      = excluded.s,
        c                      = excluded.c,
        last_access            = excluded.last_access,
        prev_value             = excluded.prev_value,
        prev_ts                = excluded.prev_ts,
        pending_contradictions = excluded.pending_contradictions,
        tombstoned             = excluded.tombstoned,
        training_eligible      = excluded.training_eligible
    `);

    // setEmbedding: the ONLY writer of node.embedding (T-01-DIRTY)
    this.stmtSetEmbedding = db.prepare(
      'UPDATE node SET embedding = @embedding, embedded_hash = @embedded_hash WHERE id = @id'
    );

    // tombstone: sets tombstoned=1 and clears training_eligible in one statement
    this.stmtTombstone = db.prepare(
      'UPDATE node SET tombstoned = 1, training_eligible = 0 WHERE id = ?'
    );

    this.stmtUpdateContradictions = db.prepare(
      'UPDATE node SET pending_contradictions = ? WHERE id = ?'
    );

    this.stmtGetMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
    this.stmtSetMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');

    this.stmtUpsertEdge = db.prepare(`
      INSERT INTO edge (src, dst, rel, w, last_access, kind)
      VALUES (@src, @dst, @rel, @w, @last_access, @kind)
      ON CONFLICT(src, dst, rel) DO UPDATE SET
        w           = excluded.w,
        last_access = excluded.last_access,
        kind        = excluded.kind
    `);

    // ── Transaction — defined once, called in upsertNode ─────────────────────
    // IMPORTANT: no async/await inside; better-sqlite3 transactions are synchronous.
    this.txUpsertNode = db.transaction((params: UpsertNodeParams): void => {
      const newHash = sha256(params.value);
      const existing = this.stmtGetNode.get(params.id) as NodeRow | undefined;

      // Dirty if value changed OR this is a new node
      const becomesDirty = !existing || existing.value_hash !== newHash;

      // Preserve existing s/c/tombstoned when not explicitly overridden
      const tombstoned =
        params.tombstoned !== undefined
          ? params.tombstoned ? 1 : 0
          : existing?.tombstoned ?? 0;
      const c = params.c !== undefined ? params.c : (existing?.c ?? 0.5);
      const s = params.s !== undefined ? params.s : (existing?.s ?? 0.1);
      const lastAccess = params.last_access ?? this.clock.nowMs();

      // training_eligible: origin ∈ {observed,asserted_by_user} ∧ ¬tombstoned ∧ c ≥ τ
      const trainingEligible =
        params.origin !== 'inferred' && tombstoned === 0 && c >= this.config.trainingConfidenceThreshold
          ? 1
          : 0;

      this.stmtInsertNode.run({
        id: params.id,
        type: params.type,
        value: params.value,
        value_hash: newHash,
        // Dirty: null out embedding so Phase 2 knows to re-embed (STORE-02)
        embedding: becomesDirty ? null : (existing?.embedding ?? null),
        embedded_hash: becomesDirty ? null : (existing?.embedded_hash ?? null),
        origin: params.origin,
        s,
        c,
        last_access: lastAccess,
        // One-deep superseded pointer — carry old value when value changes
        prev_value: becomesDirty ? (existing?.value ?? null) : (existing?.prev_value ?? null),
        prev_ts: becomesDirty ? (existing?.last_access ?? null) : (existing?.prev_ts ?? null),
        // Preserve pending_contradictions — managed exclusively by recordContradiction
        pending_contradictions: existing?.pending_contradictions ?? '[]',
        tombstoned,
        training_eligible: trainingEligible,
      });
    });
  }

  // ── Public write primitive ──────────────────────────────────────────────

  /**
   * Upsert a node.
   * Atomically: sets value_hash = sha256(value); nulls embedded_hash when
   * value changes (dirty-flag, STORE-02); computes training_eligible.
   * The only code path that writes node.value.
   */
  upsertNode(params: UpsertNodeParams): void {
    this.txUpsertNode(params);
  }

  /**
   * Store an embedding for node `id` and mark it clean (embedded_hash = value_hash).
   * The ONLY writer of node.embedding — never called from outside SemanticStore (T-01-DIRTY).
   * Pitfall 5: stores Buffer from vec.buffer with correct byteOffset + byteLength.
   */
  setEmbedding(id: string, vec: Float32Array): void {
    const existing = this.stmtGetNode.get(id) as NodeRow | undefined;
    if (!existing) return; // no-op if node doesn't exist

    // Float32Array → Buffer: preserve byteOffset so the round-trip is correct (Pitfall 5)
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.stmtSetEmbedding.run({
      id,
      embedding: buf,
      embedded_hash: existing.value_hash, // marks node as clean
    });
  }

  /**
   * Mark a node as tombstoned (superseded).
   * Clears training_eligible in the same statement.
   */
  tombstone(id: string): void {
    this.stmtTombstone.run(id);
  }

  /**
   * Append a provenance-distinct contradiction episode ID.
   * Append-only; no threshold logic (that belongs to Phase 2 consolidation).
   */
  recordContradiction(nodeId: string, episodeId: string): void {
    const node = this.stmtGetNode.get(nodeId) as NodeRow | undefined;
    if (!node) return;
    const contradictions = JSON.parse(node.pending_contradictions) as string[];
    contradictions.push(episodeId);
    this.stmtUpdateContradictions.run(JSON.stringify(contradictions), nodeId);
  }

  /** Read a node row by id. Returns null if not found. */
  getNode(id: string): NodeRow | null {
    const row = this.stmtGetNode.get(id) as NodeRow | undefined;
    return row ?? null;
  }

  /**
   * Upsert a weighted graph edge.
   * ON CONFLICT updates w, last_access, kind.
   */
  upsertEdge(params: {
    src: string;
    dst: string;
    rel: string;
    w: number;
    kind: EdgeKind;
    last_access?: number;
  }): void {
    this.stmtUpsertEdge.run({
      src: params.src,
      dst: params.dst,
      rel: params.rel,
      w: params.w,
      kind: params.kind,
      last_access: params.last_access ?? this.clock.nowMs(),
    });
  }

  /** Read a meta value by key. Returns null if not found. */
  getMeta(key: string): string | null {
    const row = this.stmtGetMeta.get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Write or overwrite a meta key/value pair. */
  setMeta(key: string, value: string): void {
    this.stmtSetMeta.run(key, value);
  }
}
