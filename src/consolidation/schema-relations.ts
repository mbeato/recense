/**
 * SchemaRelationDeriver — offline schema-relation derivation (SREL-01, D-01/D-04/D-06).
 *
 * Runs inside the offline sleep pass (Phase C, after induceSchemas(), before runEvictionSweep()).
 * Derives schema↔schema `schema_rel` edges from member-centroid cosine similarity and stores
 * them as a wipe-and-rebuildable derived cache. Zero LLM call, zero inferred signal (D-37).
 *
 * Threat mitigations:
 *  - T-18-01 / D-37: stmtGetClusterableNodes filters tombstoned=0, origin!='inferred',
 *    type IN ('fact','entity'). Inferred content cannot launder into schema_rel derivation.
 *  - T-18-04 / D-04: wipe + recompute run inside one db.transaction (no partial-write
 *    corruption). A mid-derive crash leaves wipe-then-rebuild-clean state on the next pass.
 *
 * Design (mirrors SchemaInducer structural contract exactly):
 *  - CONSOL-03: all node/edge writes via owned primitives (upsertNode/upsertEdge) — no raw
 *    INSERT on node or edge tables.
 *  - T-02-ASYNC: async-before-sync; NO await inside any db.transaction.
 *  - T-01-SQL: all queries via prepared statements compiled once in constructor.
 *  - D-12: all time reads via this.clock.nowMs() — never Date.now() directly.
 *  - Pitfall 5: Float32Array decoded with byteOffset + byteLength / 4 (never bare Buffer).
 */
import Database from 'better-sqlite3';
import type { Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { SemanticStore } from '../db/semantic-store';
import { cosineSimF32 } from '../retrieval/topk';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SchemaNodeRow {
  id: string;
  value: string;
}

interface ClusterableNodeRow {
  id: string;
  embedding: Buffer;
  origin: string;
  tombstoned: number;
}

// ---------------------------------------------------------------------------
// SchemaRelationDeriver
// ---------------------------------------------------------------------------

/**
 * Derives schema↔schema `schema_rel` edges from member-centroid cosine similarity.
 * One-abstraction-level-up sibling of SchemaInducer. Deterministic, LLM-free, rebuildable.
 */
export class SchemaRelationDeriver {
  private readonly db: Database.Database;
  private readonly store: SemanticStore;
  private readonly config: EngineConfig;
  private readonly clock: Clock;

  // Prepared statements compiled once — never per-call (T-01-SQL)
  private readonly stmtGetClusterableNodes: Database.Statement;
  private readonly stmtGetSchemaMembers: Database.Statement;
  private readonly stmtGetSchemaNodes: Database.Statement;
  private readonly stmtDeleteSchemaRelEdges: Database.Statement;

  constructor(
    db: Database.Database,
    store: SemanticStore,
    config: EngineConfig,
    clock: Clock,
  ) {
    this.db = db;
    this.store = store;
    this.config = config;
    this.clock = clock;

    // T-04-01-E / D-37: an inferred node can NEVER launder into a derived artifact.
    // Source ONLY this gated set. This is the load-bearing SREL-01/D-06 guarantee.
    // Copied VERBATIM from schema-induction.ts:186-192.
    this.stmtGetClusterableNodes = db.prepare(
      "SELECT id, origin, embedding FROM node " +
      "WHERE tombstoned = 0 AND origin != 'inferred' " +
      "AND type IN ('fact','entity') AND embedding IS NOT NULL"
    );

    // Schema members via abstracts edges (one row per member) — same as inducer :194-197
    this.stmtGetSchemaMembers = db.prepare(
      "SELECT dst FROM edge WHERE src = ? AND kind = 'abstracts'"
    );

    // Live schema nodes whose centroids we relate. NOTE (D-03 guard): super-schemas are
    // ALSO type='schema', so this query returns them too — that is intentional for the
    // relate step; the clusterable-node query above (type IN ('fact','entity')) already
    // EXCLUDES them from leaf re-clustering. Plan 18-02 adds the super-schema sentinel test.
    // Copied VERBATIM from schema-induction.ts:199-202.
    this.stmtGetSchemaNodes = db.prepare(
      "SELECT id, value FROM node WHERE type = 'schema' AND tombstoned = 0"
    );

    // D-04 rebuild-from-scratch: wipe prior derived artifacts before recompute.
    // Scoped, bound-?, prepared once — mirrors stmtDeleteAbstractsEdges :210-212.
    this.stmtDeleteSchemaRelEdges = db.prepare(
      "DELETE FROM edge WHERE kind = 'schema_rel'"
    );
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Derive schema↔schema `schema_rel` edges from member-centroid cosine similarity.
   *
   * Phase A (async-free — centroids come from persisted member embeddings):
   *   For each live schema, recompute its centroid from observed members only.
   *   Skip schemas with no valid observed centroid.
   *   Collect all schema-pair relationships whose centroid cosine ≥ threshold.
   *
   * Phase B (sync write — one db.transaction with no await inside):
   *   Wipe prior schema_rel edges (D-04), then upsert the collected pairs.
   *
   * A crash mid-derive leaves wipe-then-rebuild-clean state; next pass rebuilds from scratch.
   * Artifacts are disposable derived cache — no checkpoint granularity needed.
   *
   * // plan 18-02 (SREL-02) adds super-schema clustering here
   */
  async deriveSchemaRelations(): Promise<void> {
    // ── Phase A: collect centroids from observed members ──────────────────

    const schemaNodes = this.stmtGetSchemaNodes.all() as SchemaNodeRow[];
    if (schemaNodes.length < 2) {
      // Fewer than 2 schemas → no pairs to relate; wipe-and-exit for idempotency
      this.db.transaction(() => {
        this.stmtDeleteSchemaRelEdges.run();
      })();
      return;
    }

    // Build a lookup of all clusterable (observed) node embeddings for fast member lookup.
    // Using the gated stmtGetClusterableNodes — the D-37 firewall.
    const clusterableRows = this.stmtGetClusterableNodes.all() as ClusterableNodeRow[];
    const clusterableById = new Map<string, Buffer>();
    for (const row of clusterableRows) {
      clusterableById.set(row.id, row.embedding);
    }

    // Compute centroid per schema from observed members only (skip inferred/tombstoned).
    // Mirror schema-induction.ts:257-293 exactly.
    interface SchemaWithCentroid {
      id: string;
      centroid: Float32Array | null;
    }

    const schemasWithCentroids: SchemaWithCentroid[] = [];

    for (const schemaRow of schemaNodes) {
      const memberRows = this.stmtGetSchemaMembers.all(schemaRow.id) as { dst: string }[];
      const memberIds = memberRows.map(r => r.dst);

      const memberVecs: Float32Array[] = [];
      for (const memberId of memberIds) {
        const embBuf = clusterableById.get(memberId);
        if (!embBuf) continue; // not in gated set (inferred / tombstoned / null-embedding / schema-type)
        // Pitfall 5: decode with byteOffset + byteLength / 4 (never bare Buffer)
        memberVecs.push(new Float32Array(embBuf.buffer, embBuf.byteOffset, embBuf.byteLength / 4));
      }

      if (memberVecs.length === 0) {
        schemasWithCentroids.push({ id: schemaRow.id, centroid: null });
        continue;
      }

      // Compute mean centroid (mirror inducer :280-292)
      const dims = memberVecs[0]!.length;
      const centroid = new Float32Array(dims);
      for (const vec of memberVecs) {
        for (let i = 0; i < dims; i++) {
          centroid[i]! += vec[i]!;
        }
      }
      for (let i = 0; i < dims; i++) {
        centroid[i]! /= memberVecs.length;
      }

      schemasWithCentroids.push({ id: schemaRow.id, centroid });
    }

    // Collect unordered pairs whose centroid cosine ≥ schemaRelSimilarityThreshold.
    // Stable pair ordering (lexicographic by id) for determinism (D-04).
    interface RelPair {
      src: string;
      dst: string;
      sim: number;
    }

    const threshold = this.config.schemaRelSimilarityThreshold;
    const pairs: RelPair[] = [];

    for (let i = 0; i < schemasWithCentroids.length; i++) {
      const a = schemasWithCentroids[i]!;
      if (!a.centroid) continue;
      for (let j = i + 1; j < schemasWithCentroids.length; j++) {
        const b = schemasWithCentroids[j]!;
        if (!b.centroid) continue;
        const sim = cosineSimF32(a.centroid, b.centroid);
        if (sim >= threshold) {
          // Stable ordering: lexicographic by id so identical inputs always produce identical edges
          const [src, dst] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
          pairs.push({ src: src!, dst: dst!, sim });
        }
      }
    }

    // ── Phase B: sync write inside one transaction — NO await inside (T-02-ASYNC) ──

    const nowMs = this.clock.nowMs();

    this.db.transaction(() => {
      // D-04 wipe-from-scratch: delete all prior schema_rel edges (idempotent rebuild)
      this.stmtDeleteSchemaRelEdges.run();

      // Write the newly derived pairs via owned primitives (CONSOL-03 — no raw INSERT)
      for (const { src, dst, sim } of pairs) {
        this.store.upsertEdge({
          src,
          dst,
          rel: 'schema_rel',
          w: sim,
          kind: 'schema_rel',
          last_access: nowMs,
        });
      }
    })();
  }
}
