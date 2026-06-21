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
import type {
  NodeRow,
  UpsertNodeParams,
  EdgeKind,
  PendingContradiction,
  UpsertNodeTemporalParams,
  NodeTemporalRow,
  UpsertNodeScopeParams,
  UpsertNodeDocParams,
  NodeDocRow,
} from '../lib/types';

export class SemanticStore {
  private readonly db: Database.Database;
  private readonly clock: Clock;
  private readonly config: EngineConfig;

  // Prepared statements — initialized once in constructor (never per-call)
  private readonly stmtGetNode: Database.Statement;
  private readonly stmtInsertNode: Database.Statement;
  private readonly stmtSetEmbedding: Database.Statement;
  private readonly stmtTombstone: Database.Statement;
  // FTS sync statements — derived-cache mirror of embedding doctrine (T-01-DIRTY).
  // DELETE-before-INSERT on value change prevents duplicate rows (FTS5 has no uniqueness).
  // Prepared once in constructor (T-01-SQL); called inside txUpsertNode and tombstone().
  private readonly stmtFtsDelete: Database.Statement;
  private readonly stmtFtsInsert: Database.Statement;
  private readonly stmtUpdateContradictions: Database.Statement;
  private readonly stmtGetMeta: Database.Statement;
  private readonly stmtSetMeta: Database.Statement;
  /** deleteMeta: DELETE FROM meta WHERE key = ? — used by the sleep-pass marker-consume (Plan 32-03). */
  private readonly stmtDeleteMeta: Database.Statement;
  private readonly stmtUpsertEdge: Database.Statement;
  private readonly stmtGetOutEdges: Database.Statement;
  // Phase 37 — LANDMINE 1 fix: typed-path traversal requires rel in the result.
  // getOutEdges omits rel; use getOutEdgesWithRel for any predicate-filtered traversal.
  // Pitfall 1: never use getOutEdges for typed traversal — rel is absent, predicate filter silently drops all edges.
  private readonly stmtGetOutEdgesWithRel: Database.Statement;
  private readonly stmtGetInEdges: Database.Statement;
  // entity-dedup rewire helpers (Phase 25 addition — CONSOL-03 single-writer, T-01-SQL)
  private readonly stmtDeleteEdge: Database.Statement;
  private readonly stmtGetAllEdgesForNode: Database.Statement;
  // node_temporal: single idempotent writer + read helpers (TEMP-02, Plan 20-01).
  // Written exclusively by the sleep-pass consolidator (single writer, CONSOL-03).
  private readonly stmtUpsertNodeTemporal: Database.Statement;
  private readonly stmtGetNodeTemporal: Database.Statement;
  // node_temporal lookup by source_event_id — used by calendar-tombstone.ts (Plan 20-04).
  private readonly stmtGetNodeIdsBySourceEventId: Database.Statement;
  // node_scope: single idempotent writer + single/batch readers (SCOPE-01, Plan 999.3-01).
  // Written exclusively by the sleep-pass consolidator (single writer, CONSOL-03).
  private readonly stmtUpsertNodeScope: Database.Statement;
  private readonly stmtGetNodeScope: Database.Statement;
  // node_doc: single idempotent writer + reader (READER-01, Plan 27-01).
  // generated_at is write-once: ON CONFLICT preserves the original value, only slug+updated_at update.
  // Written exclusively by the doc-writer path (CONSOL-03 single-writer discipline).
  private readonly stmtUpsertNodeDoc: Database.Statement;
  private readonly stmtGetNodeDoc: Database.Statement;

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

    // FTS sync: stmtFtsDelete/stmtFtsInsert are the ONLY writers of node_fts (derived-cache discipline).
    // DELETE-then-INSERT prevents duplicate rows on value change (FTS5 has no uniqueness constraint).
    // Sync rides inside txUpsertNode's IMMEDIATE transaction (single-writer preserved, Pitfall 7).
    this.stmtFtsDelete = db.prepare('DELETE FROM node_fts WHERE node_id = ?');
    this.stmtFtsInsert = db.prepare('INSERT INTO node_fts(node_id, value) VALUES (?, ?)');

    this.stmtUpdateContradictions = db.prepare(
      'UPDATE node SET pending_contradictions = ? WHERE id = ?'
    );

    this.stmtGetMeta = db.prepare('SELECT value FROM meta WHERE key = ?');
    this.stmtSetMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    // deleteMeta: removes a meta row by key (Plan 32-03 marker-consume — crash-safe clear).
    // T-01-SQL: bound ? param, no string interpolation.
    this.stmtDeleteMeta = db.prepare('DELETE FROM meta WHERE key = ?');

    this.stmtUpsertEdge = db.prepare(`
      INSERT INTO edge (src, dst, rel, w, last_access, kind)
      VALUES (@src, @dst, @rel, @w, @last_access, @kind)
      ON CONFLICT(src, dst, rel) DO UPDATE SET
        w           = excluded.w,
        last_access = excluded.last_access,
        kind        = excluded.kind
    `);

    // Edge read for spreading activation (Phase 3 RET-01, D-26/27)
    // Excludes tombstoned neighbors at the application layer (RetrievalEngine checks
    // getNode(edge.dst)?.tombstoned — avoids JOIN complexity on a small table)
    // T-01-SQL: bound ? param, no string interpolation
    // NOTE: omits `rel` — do NOT use for typed predicate traversal; use getOutEdgesWithRel instead (Pitfall 1).
    this.stmtGetOutEdges = db.prepare(
      'SELECT dst, w, kind FROM edge WHERE src = ?'
    );

    // Phase 37: typed-path traversal requires the `rel` field (LANDMINE 1 fix, D-01).
    // Callers: typed-traversal only. Filter by PRED_SET.has(edge.rel) after the call
    // to exclude `links_to` / `extends` edges (LANDMINE 2).
    // T-01-SQL: bound ? param, no string interpolation.
    this.stmtGetOutEdgesWithRel = db.prepare(
      'SELECT dst, rel, w, kind FROM edge WHERE src = ?'
    );

    // Reverse-edge read for schema reverse-lookup (Phase 4 LEARN-02, Fix-2).
    // Mirrors stmtGetOutEdges but queries by dst — lets recall find schemas that
    // abstract the matched member node via incoming 'abstracts' edges.
    // T-01-SQL: bound ? param, no string interpolation
    this.stmtGetInEdges = db.prepare(
      'SELECT src, w, kind FROM edge WHERE dst = ?'
    );

    // entity-dedup rewire helpers (Phase 25 addition, CONSOL-03 single-writer).
    // T-01-SQL: bound ? params only — no string interpolation anywhere.
    this.stmtDeleteEdge = db.prepare(
      'DELETE FROM edge WHERE src = ? AND dst = ? AND rel = ?'
    );
    // Fetch all edges touching a node in either direction for rewire planning.
    this.stmtGetAllEdgesForNode = db.prepare(
      'SELECT src, dst, rel, w, last_access, kind FROM edge WHERE src = ? OR dst = ?'
    );

    // node_temporal INSERT OR REPLACE — idempotent on re-consolidation (TEMP-02).
    // Uses INSERT OR REPLACE (not ON CONFLICT DO UPDATE) so the PK row is fully replaced
    // on every write; this is correct because node_temporal is a complete snapshot of the
    // temporal state, not an incremental update.
    // T-01-SQL: all values bound via named parameters; no string interpolation.
    this.stmtUpsertNodeTemporal = db.prepare(`
      INSERT OR REPLACE INTO node_temporal
        (node_id, due_at, action_type, recurrence_rule, source_event_id, updated_at)
      VALUES
        (@node_id, @due_at, @action_type, @recurrence_rule, @source_event_id, @updated_at)
    `);

    this.stmtGetNodeTemporal = db.prepare(
      'SELECT node_id, due_at, action_type, recurrence_rule, source_event_id, updated_at FROM node_temporal WHERE node_id = ?'
    );

    // calendar-tombstone.ts (Plan 20-04): find all nodes whose temporal annotation
    // has a matching source_event_id (i.e. calendar events cancelled by the master).
    // T-01-SQL: bound ? param, no string interpolation.
    this.stmtGetNodeIdsBySourceEventId = db.prepare(
      'SELECT node_id FROM node_temporal WHERE source_event_id = ?'
    );

    // node_scope INSERT OR REPLACE — idempotent on re-consolidation (SCOPE-01).
    // node_scope is a complete snapshot of the node's provenance, so full-row replace
    // (not incremental update) is correct. T-01-SQL: named params, no interpolation.
    this.stmtUpsertNodeScope = db.prepare(`
      INSERT OR REPLACE INTO node_scope (node_id, scope, updated_at)
      VALUES (@node_id, @scope, @updated_at)
    `);
    this.stmtGetNodeScope = db.prepare(
      'SELECT scope FROM node_scope WHERE node_id = ?'
    );

    // node_doc INSERT — generated_at is write-once (READER-01, Plan 27-01).
    // ON CONFLICT(node_id) DO UPDATE: updates slug and updated_at but NOT generated_at —
    // this preserves the original generation timestamp for the staleness predicate
    // (node.last_access > doc.generated_at). T-01-SQL: named params, no interpolation.
    this.stmtUpsertNodeDoc = db.prepare(`
      INSERT INTO node_doc (node_id, slug, generated_at, updated_at)
      VALUES (@node_id, @slug, @generated_at, @updated_at)
      ON CONFLICT(node_id) DO UPDATE SET
        slug       = excluded.slug,
        updated_at = excluded.updated_at
    `);
    this.stmtGetNodeDoc = db.prepare(
      'SELECT node_id, slug, generated_at, updated_at FROM node_doc WHERE node_id = ?'
    );

    // ── Transaction — defined once, called in upsertNode ─────────────────────
    // IMPORTANT: no async/await inside; better-sqlite3 transactions are synchronous.
    // M-5: wrap in lambda that calls rawTx.immediate(params) so every upsertNode runs in
    // IMMEDIATE mode. This prevents SQLITE_BUSY_SNAPSHOT in WAL mode — the deferred read
    // inside this transaction (stmtGetNode.get) + following write creates an upgrade race
    // when a concurrent writer holds a SHARED lock. IMMEDIATE acquires a RESERVED lock
    // upfront, serialising all upsertNode calls correctly.
    // better-sqlite3 API: rawTx.immediate(params) calls the transaction in IMMEDIATE mode.
    // The wrapper keeps the stored type as (params) => void so call sites are unchanged.
    const rawTxUpsertNode = db.transaction((params: UpsertNodeParams): void => {
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
        // One-deep superseded pointer: explicit prev_value wins (D-20 tombstone-and-replace carry);
        // when omitted, carry old value on value-change or preserve prev_value if unchanged.
        prev_value: params.prev_value !== undefined
          ? params.prev_value
          : (becomesDirty ? (existing?.value ?? null) : (existing?.prev_value ?? null)),
        prev_ts: becomesDirty ? (existing?.last_access ?? null) : (existing?.prev_ts ?? null),
        // Preserve pending_contradictions — managed exclusively by recordContradiction
        pending_contradictions: existing?.pending_contradictions ?? '[]',
        tombstoned,
        training_eligible: trainingEligible,
      });

      // FTS sync — inside the same IMMEDIATE transaction as the node write (single-writer preserved,
      // Pitfall 7). DELETE-then-INSERT keeps no stale or duplicate FTS rows.
      this.stmtFtsDelete.run(params.id);
      if (tombstoned === 0) {
        this.stmtFtsInsert.run(params.id, params.value);
      }
    });
    this.txUpsertNode = (params: UpsertNodeParams) => rawTxUpsertNode.immediate(params);
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
   *
   * L-1: stale-vector guard — optional `expectedValueHash` parameter.
   * When provided, compares against the node's current value_hash. If they differ the
   * node's value changed between when the caller captured it for embedding and now; the
   * vector is for a stale value and must NOT be stamped. No-op on mismatch.
   * Callers that capture `value_hash` at read time MUST pass it here to close the race.
   *
   * L-2: embedding dims stamp — first call writes `embedding_dims` to meta; subsequent calls
   * assert the same dimensionality. Throws on mismatch to catch misconfigured providers early.
   */
  setEmbedding(id: string, vec: Float32Array, expectedValueHash?: string): void {
    const existing = this.stmtGetNode.get(id) as NodeRow | undefined;
    if (!existing) return; // no-op if node doesn't exist

    // L-1: stale-vector guard — skip if value changed between capture and write-back
    if (expectedValueHash !== undefined && existing.value_hash !== expectedValueHash) return;

    // L-2: stamp embedding dims on first write; assert consistency on subsequent writes
    const dims = vec.length;
    const storedDims = this.getMeta('embedding_dims');
    if (storedDims === null) {
      this.setMeta('embedding_dims', String(dims));
    } else if (parseInt(storedDims, 10) !== dims) {
      throw new Error(
        `embedding_dims mismatch: stored=${storedDims}, received=${dims} for node ${id} — provider dimensionality changed`
      );
    }

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
   * FTS sync: removes node from node_fts so tombstoned values never surface in MATCH queries.
   */
  tombstone(id: string): void {
    this.stmtTombstone.run(id);
    // FTS sync: remove from index so tombstoned values never surface in MATCH queries.
    this.stmtFtsDelete.run(id);
  }

  /**
   * Append a provenance-distinct contradiction record.
   * Append-only; no threshold/destabilization logic (that belongs to Phase 2 consolidation).
   * The entry carries episode_id, session_id, and origin so the consolidator can count
   * distinct sessions while excluding inferred-origin entries (D-19).
   * Writes via stmtUpdateContradictions bound-parameter prepared statement (T-02-SQL).
   */
  recordContradiction(nodeId: string, entry: PendingContradiction): void {
    const node = this.stmtGetNode.get(nodeId) as NodeRow | undefined;
    if (!node) return;
    // L-4: defensive parse — on corrupt column reset to [] and continue (write-back repairs it).
    let contradictions: PendingContradiction[];
    try {
      contradictions = JSON.parse(node.pending_contradictions) as PendingContradiction[];
    } catch {
      // Corrupt column: treat as empty and write back the repaired array with this new entry.
      contradictions = [];
    }
    contradictions.push(entry);
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

  /**
   * Read all outgoing edges from a node. Returns empty array if none.
   * NOTE: omits the `rel` field — do NOT use for predicate-filtered typed traversal.
   * For typed-path traversal, use getOutEdgesWithRel (Phase 37 LANDMINE 1 fix, Pitfall 1).
   */
  getOutEdges(nodeId: string): Array<{ dst: string; w: number; kind: string }> {
    return this.stmtGetOutEdges.all(nodeId) as Array<{ dst: string; w: number; kind: string }>;
  }

  /**
   * Read all outgoing edges from a node, INCLUDING the `rel` predicate field (Phase 37, D-01).
   *
   * Use this for ANY predicate-filtered typed traversal — getOutEdges omits rel, causing
   * predicate filters to silently drop all edges (LANDMINE 1 / Pitfall 1).
   *
   * After calling, always filter by PRED_SET.has(edge.rel) to exclude `links_to` / `extends`
   * edges that share kind='relation' but are NOT typed predicates (LANDMINE 2).
   *
   * T-01-SQL: bound ? param only — no string interpolation.
   */
  getOutEdgesWithRel(nodeId: string): Array<{ dst: string; rel: string; w: number; kind: string }> {
    return this.stmtGetOutEdgesWithRel.all(nodeId) as Array<{ dst: string; rel: string; w: number; kind: string }>;
  }

  /**
   * Read all incoming edges to a node (WHERE dst = nodeId).
   * Mirrors getOutEdges but queries by destination. Used by RecallEngine to resolve
   * schemas that abstract a matched member via incoming 'abstracts' edges (Fix-2, LEARN-02).
   * Returns empty array if none.
   */
  getInEdges(nodeId: string): Array<{ src: string; w: number; kind: string }> {
    return this.stmtGetInEdges.all(nodeId) as Array<{ src: string; w: number; kind: string }>;
  }

  /**
   * Delete a single edge by PK (src, dst, rel).
   * Used exclusively by the entity-dedup edge-rewire pass (Phase 25).
   * Must be called BEFORE upsertEdge with the canonical id to maintain FK safety (T-FK-01).
   * T-01-SQL: bound ? params, no string interpolation.
   */
  deleteEdge(src: string, dst: string, rel: string): void {
    this.stmtDeleteEdge.run(src, dst, rel);
  }

  /**
   * Read all edges touching nodeId in either direction (src OR dst).
   * Returns the full EdgeRow shape for rewire planning in the entity-dedup pass (Phase 25).
   * T-01-SQL: bound positional params — nodeId passed twice for the OR clause.
   */
  getEdgesForNode(nodeId: string): Array<import('../lib/types').EdgeRow> {
    return this.stmtGetAllEdgesForNode.all(nodeId, nodeId) as Array<import('../lib/types').EdgeRow>;
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

  /**
   * Delete a meta key/value pair (Plan 32-03 — marker-consume crash-safe clear).
   *
   * Used to CLEAR a pending-corpus-promotion:<scope> marker AFTER a successful
   * promoteScope call. If promoteScope throws, deleteMeta is NOT called — the marker
   * survives for the next sleep pass to retry (crash-safe order, T-32-MARK).
   *
   * T-01-SQL: bound ? param, no string interpolation.
   */
  deleteMeta(key: string): void {
    this.stmtDeleteMeta.run(key);
  }

  /**
   * Idempotent write to the node_temporal sidecar (TEMP-02, Plan 20-01).
   *
   * Uses INSERT OR REPLACE so a second call for the same node_id replaces the row
   * with the latest values — correct for re-consolidation on incremental sync.
   *
   * IMPORTANT: this is the ONLY write path for node_temporal. Adapters and
   * extraction code must never call this — it is invoked exclusively by the
   * sleep-pass consolidator after upsertNode succeeds (CONSOL-03 discipline).
   *
   * T-01-SQL: all parameters are bound; no string interpolation.
   */
  upsertNodeTemporal(params: UpsertNodeTemporalParams): void {
    this.stmtUpsertNodeTemporal.run({
      node_id: params.node_id,
      due_at: params.due_at,
      action_type: params.action_type,
      recurrence_rule: params.recurrence_rule ?? null,
      source_event_id: params.source_event_id ?? null,
      updated_at: params.updated_at,
    });
  }

  /**
   * Read the node_temporal row for a given node_id.
   * Returns null when no temporal annotation exists for the node.
   * Used by tests and by the calendar-tombstone path in Phase 20 plan 04.
   */
  getNodeTemporal(nodeId: string): NodeTemporalRow | null {
    const row = this.stmtGetNodeTemporal.get(nodeId) as NodeTemporalRow | undefined;
    return row ?? null;
  }

  /**
   * Find all node_ids whose node_temporal.source_event_id matches the given calendar event id.
   *
   * Used exclusively by the calendar-tombstone sleep-pass step (Plan 20-04, D-05):
   * when a Calendar event is cancelled, tombstone all nodes linked to that event.
   *
   * Returns an empty array when no matching rows exist.
   * T-01-SQL: bound ? param, no string interpolation.
   */
  getNodeIdsBySourceEventId(sourceEventId: string): string[] {
    const rows = this.stmtGetNodeIdsBySourceEventId.all(sourceEventId) as { node_id: string }[];
    return rows.map(r => r.node_id);
  }

  /**
   * Write a node_scope row — single-tenant PROVENANCE attribution (SCOPE-01, D-S2).
   *
   * Uses INSERT OR REPLACE so a second call for the same node_id replaces the row with
   * the latest scope — correct for re-consolidation on incremental sync.
   *
   * IMPORTANT: this is the ONLY write path for node_scope. Adapters and retrieval code
   * must never call it — it is invoked exclusively by the sleep-pass consolidator after
   * upsertNode succeeds (CONSOL-03 discipline). scope NEVER feeds retrieval ranking (D-S1).
   *
   * T-01-SQL: all parameters are bound; no string interpolation.
   */
  upsertNodeScope(params: UpsertNodeScopeParams): void {
    this.stmtUpsertNodeScope.run({
      node_id: params.node_id,
      scope: params.scope,
      updated_at: params.updated_at,
    });
  }

  /**
   * Read the provenance scope for a single node_id.
   * Returns undefined when no scope annotation exists for the node.
   */
  getNodeScope(nodeId: string): string | undefined {
    const row = this.stmtGetNodeScope.get(nodeId) as { scope: string } | undefined;
    return row?.scope;
  }

  /**
   * Batch-read scopes for several node ids → Map<node_id, scope> (recall surfacing, D-S6).
   * Avoids N queries on the recall display path. Nodes without a scope row are simply
   * absent from the returned Map (caller treats absence as 'global'). Display-only — this
   * read happens AFTER ranking and never influences selection/order (D-S1).
   */
  getNodeScopes(nodeIds: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (nodeIds.length === 0) return out;
    // Bind each id as a separate ? placeholder (T-01-SQL: no interpolation of ids).
    const placeholders = nodeIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT node_id, scope FROM node_scope WHERE node_id IN (${placeholders})`)
      .all(...nodeIds) as Array<{ node_id: string; scope: string }>;
    for (const r of rows) out.set(r.node_id, r.scope);
    return out;
  }

  /**
   * Write a node_doc sidecar row — doc metadata for READER-01 (Plan 27-01).
   *
   * generated_at is WRITE-ONCE: the ON CONFLICT clause updates only slug and updated_at,
   * leaving generated_at at its original value. This preserves the staleness predicate
   * (node.last_access > doc.generated_at, READER-03) across re-renders that do not
   * regenerate the doc content (CONTEXT D §generatedAt).
   *
   * To reset generated_at (i.e. after full doc regeneration), call this method with the
   * new generated_at value — the ON CONFLICT clause will NOT update it, so the caller
   * must DELETE the old row and re-insert if a true generated_at reset is needed.
   * For the v1 use case (generate-once or regenerate-and-replace), simply delete the old
   * node_doc row before calling upsertNodeDoc with the new generated_at.
   *
   * IMPORTANT: this is the ONLY write path for node_doc. No raw SQL on node_doc outside
   * SemanticStore (single-writer invariant, CONSOL-03). T-01-SQL: all params are bound.
   */
  upsertNodeDoc(params: UpsertNodeDocParams): void {
    this.stmtUpsertNodeDoc.run({
      node_id: params.node_id,
      slug: params.slug,
      generated_at: params.generated_at,
      updated_at: params.updated_at,
    });
  }

  /**
   * Read the node_doc sidecar row for a given node_id.
   * Returns undefined when no doc annotation exists for the node.
   */
  getNodeDoc(nodeId: string): NodeDocRow | undefined {
    const row = this.stmtGetNodeDoc.get(nodeId) as NodeDocRow | undefined;
    return row;
  }
}
