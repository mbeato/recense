/**
 * doc-writer — lifecycle-exempt doc-node write (READER-01).
 *
 * Writes a type='doc' node + node_doc sidecar + node_scope + one kind='cites'
 * edge per unique cited fact in a SINGLE db.transaction().immediate() (single-writer
 * invariant, CONSOL-03 / T-27-07).
 *
 * Lifecycle exemptions (READER-01 hard invariants — all checked by tests):
 *  - No setEmbedding call → embedding stays NULL (doc is never embedded)
 *  - No upsertNodeTemporal call → not a temporal/actionable node
 *  - origin='inferred' → training_eligible forced to 0 by SemanticStore
 *  - s=0 → no Hebbian decay contribution (lifecycle exempt)
 *  - Doc node is DELETED from node_fts after upsertNode to suppress keyword search
 *    (the markdown body must not pollute fact-retrieval BM25)
 *  - No claim-extraction FROM the doc (generation never creates a new episode)
 *  - Generated prose never strengthens cited facts (D-43 self-confirmation guard)
 *
 * Single-writer invariant (T-27-07):
 *  All writes go through SemanticStore primitives only — no raw node/edge SQL
 *  inside doc-writer. The outer db.transaction().immediate() wraps the sequence.
 */
import type Database from 'better-sqlite3';
import type { SemanticStore } from '../db/semantic-store';

/** Parameters for writeDoc. */
export interface WriteDocParams {
  /** The pre-generated uuid for the doc node (caller supplies so CLI can report it). */
  docId: string;
  /** Project slug (stored in node_scope and node_doc). */
  slug: string;
  /** Generated markdown body. */
  markdown: string;
  /** Unique fact node IDs whose recense://fact/<id> was verified to resolve. */
  citedFactIds: string[];
  /** Epoch ms for generated_at / last_access / updated_at. */
  now: number;
}

/**
 * Write a lifecycle-exempt doc node atomically.
 *
 * All writes are wrapped in a single IMMEDIATE transaction:
 *  0. Supersede: tombstone any prior live doc node for the slug (one-live-doc-per-slug)
 *  1. upsertNode (type='doc', origin='inferred' → training_eligible=0, s=0, embedding=NULL)
 *  2. Delete from node_fts (FTS suppression — markdown body must not pollute search)
 *  3. upsertNodeDoc sidecar
 *  4. upsertNodeScope
 *  5. upsertEdge (kind='cites') for each unique cited fact id
 *
 * Invariant: after writeDoc there is exactly ONE live (tombstoned=0) type='doc' node for
 * the slug. A regenerate retires the prior doc instead of appending a second live node.
 *
 * @param store  SemanticStore instance (provides the owned write primitives).
 * @param db     The raw Database handle — needed for the transaction wrapper and FTS delete.
 * @param params Doc write parameters.
 */
export function writeDoc(
  store: SemanticStore,
  db: Database.Database,
  params: WriteDocParams,
): void {
  const { docId, slug, markdown, citedFactIds, now } = params;

  // Dedup cited fact IDs so we write exactly one edge per unique fact.
  const uniqueCitedIds = [...new Set(citedFactIds)];

  // Prepared statement for FTS delete — compiled inside writeDoc and used inside the
  // transaction. Safe: prepared statements are reentrant within the same connection.
  const stmtFtsDelete = db.prepare('DELETE FROM node_fts WHERE node_id = ?');

  // Find any EXISTING live doc node(s) for this slug so they can be superseded.
  // Invariant: at most ONE live type='doc' node per slug after writeDoc. A regenerate
  // (--force) must retire the prior doc, not append a second live node. Exclude the new
  // docId (it does not exist yet, but be defensive). FK-safe: tombstoning leaves the node
  // row + its node_doc/node_scope/cites edges intact (the row still exists), so no FK breaks.
  const stmtFindLiveDocsForSlug = db.prepare(
    `SELECT n.id
     FROM node n
     JOIN node_scope ns ON ns.node_id = n.id
     WHERE n.type = 'doc' AND n.tombstoned = 0 AND ns.scope = ? AND n.id != ?`,
  );

  // All writes in ONE IMMEDIATE transaction (single-writer invariant, T-27-07).
  // IMMEDIATE acquires a RESERVED lock upfront — prevents SQLITE_BUSY_SNAPSHOT in WAL mode
  // when concurrent readers hold a SHARED lock (same rationale as SemanticStore.txUpsertNode).
  const txWrite = db.transaction(() => {
    // 0. Supersede: tombstone any prior live doc node for this slug (one-live-doc-per-slug).
    //    store.tombstone() sets tombstoned=1, clears training_eligible, and removes the node
    //    from node_fts. node_doc/node_scope/cites edges are left in place but reference a
    //    now-tombstoned node — FK-consistent (the node row still exists). Done BEFORE the
    //    new write so the new doc is the only live one for the slug after this transaction.
    const priorLiveDocs = stmtFindLiveDocsForSlug.all(slug, docId) as Array<{ id: string }>;
    for (const { id } of priorLiveDocs) {
      store.tombstone(id);
    }

    // 1. Write the doc node.
    //    origin='inferred' → SemanticStore forces training_eligible=0 (lifecycle guard).
    //    s=0    → no Hebbian decay contribution.
    //    c=1.0  → high confidence (it is what was generated).
    //    Lifecycle: no setEmbedding → embedding stays NULL permanently.
    store.upsertNode({
      id: docId,
      type: 'doc',
      value: markdown,
      origin: 'inferred',
      s: 0,
      c: 1.0,
      tombstoned: false,
      last_access: now,
    });

    // 2. Suppress FTS indexing for the doc node.
    //    upsertNode auto-syncs FTS (stmtFtsInsert inside txUpsertNode). We delete the
    //    doc node from node_fts immediately after so its markdown body never pollutes
    //    BM25 keyword search. The FTS delete is idempotent (DELETE WHERE node_id = ?).
    stmtFtsDelete.run(docId);

    // 3. Write the node_doc sidecar.
    //    generated_at = now on first write; the ON CONFLICT SQL in SemanticStore preserves
    //    generated_at on subsequent re-renders (write-once staleness predicate).
    store.upsertNodeDoc({ node_id: docId, slug, generated_at: now, updated_at: now });

    // 4. Attribute the doc node to the project slug via node_scope (SCOPE-01 provenance).
    store.upsertNodeScope({ node_id: docId, scope: slug, updated_at: now });

    // 5. Write one kind='cites' edge per unique cited fact.
    //    src = doc node, dst = cited fact node.
    //    weight=1.0 (uniform); no decay (doc is lifecycle-exempt).
    for (const factId of uniqueCitedIds) {
      store.upsertEdge({
        src: docId,
        dst: factId,
        rel: 'cites',
        kind: 'cites',
        w: 1.0,
        last_access: now,
      });
    }
  });

  txWrite.immediate();
}
