/**
 * SchemaRelationDeriver — offline schema-relation derivation (SREL-01/02, D-01/D-03/D-04/D-06).
 *
 * Runs inside the offline sleep pass (Phase C, after induceSchemas(), before runEvictionSweep()).
 * Derives:
 *   SREL-01: schema↔schema `schema_rel` edges from member-centroid cosine similarity.
 *   SREL-02: super-schema cluster nodes (type='schema', origin='inferred') linked to child
 *            schemas via existing `kind='abstracts'` edges (recursive abstraction — D-03).
 * Both artifacts are wipe-and-rebuildable derived caches. Zero LLM call, zero inferred signal
 * (D-37). All writes in a single atomic transaction (D-04).
 *
 * Threat mitigations:
 *  - T-18-01 / D-37: stmtGetClusterableNodes filters tombstoned=0, origin!='inferred',
 *    type IN ('fact','entity'). Inferred content cannot launder into schema_rel derivation.
 *  - T-18-02 / D-03: super-schemas are type='schema', excluded from leaf re-clustering by
 *    schema-induction.ts:186-192 (type IN ('fact','entity') guard). Invariant marked inline;
 *    exclusion test in plan 18-04.
 *  - T-18-04 / D-04: wipe + recompute run inside one db.transaction (no partial-write
 *    corruption). A mid-derive crash leaves wipe-then-rebuild-clean state on the next pass.
 *  - T-18-05 / D-04: super-schema wipe is scoped to 'super::' id prefix — leaf schemas from
 *    induceSchemas() use UUID ids and are never matched by the scoped DELETE.
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

interface SchemaWithCentroid {
  id: string;
  centroid: Float32Array | null;
}

// ---------------------------------------------------------------------------
// Module-level pure helpers for clustering
// ---------------------------------------------------------------------------

/**
 * Average-linkage distance between two sets of centroids.
 * distance = mean(1 − cosineSimF32(a, b)) over all cross-cluster pairs.
 * Pure function — no side effects, no imports beyond cosineSimF32.
 */
function avgLinkageDist(vecsA: Float32Array[], vecsB: Float32Array[]): number {
  // Guard against division by zero: an empty side yields NaN, and NaN compares false under
  // every `<`/`===` in the merge loop, which would silently suppress all merges (WR-01).
  if (vecsA.length === 0 || vecsB.length === 0) return Infinity;
  let sum = 0;
  for (const a of vecsA) {
    for (const b of vecsB) {
      sum += 1 - cosineSimF32(a, b);
    }
  }
  return sum / (vecsA.length * vecsB.length);
}

/**
 * Stable pair key for deterministic tie-breaking in the clustering merge loop.
 * Encodes the two clusters by their lexicographically smallest member id each.
 * IDs within each cluster are maintained in sorted order so ids[0] is the minimum.
 * A null-character separator is used to avoid collisions between id strings.
 */
function clusterPairKey(idsA: string[], idsB: string[]): string {
  const minA = idsA[0]!; // ids kept sorted; first element is always the smallest
  const minB = idsB[0]!;
  return minA <= minB ? `${minA}\0${minB}` : `${minB}\0${minA}`;
}

/**
 * Deterministic super-schema label from child schema values. No LLM call.
 * Mirrors fallbackName() in schema-induction.ts:516-519.
 * Honours the $0/rebuildable constraint per Claude's Discretion (18-CONTEXT.md).
 */
function superSchemaLabel(childValues: string[]): string {
  const summary = childValues.slice(0, 3).join(' + ');
  return `super:${summary}`.slice(0, 200);
}

// ---------------------------------------------------------------------------
// NoopSchemaRelationDeriver — test/legacy default (does nothing)
// ---------------------------------------------------------------------------

/**
 * No-op implementation for tests and call sites that don't need schema-relation derivation.
 * Mirrors the NoopConsolidationSink pattern — satisfies the Consolidator DI contract.
 */
export class NoopSchemaRelationDeriver {
  async deriveSchemaRelations(): Promise<void> {
    // intentional no-op
  }
}

// ---------------------------------------------------------------------------
// SchemaRelationDeriver
// ---------------------------------------------------------------------------

/**
 * Derives schema↔schema `schema_rel` edges from member-centroid cosine similarity (SREL-01)
 * and materializes super-schema cluster nodes via agglomerative clustering (SREL-02).
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
  private readonly stmtDeleteSuperSchemaEdges: Database.Statement;
  private readonly stmtDeleteSuperSchemaNodes: Database.Statement;

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
    // EXCLUDES them from leaf re-clustering. Plan 18-04 adds the super-schema sentinel test.
    // Copied VERBATIM from schema-induction.ts:199-202.
    this.stmtGetSchemaNodes = db.prepare(
      "SELECT id, value FROM node WHERE type = 'schema' AND tombstoned = 0"
    );

    // D-04 rebuild-from-scratch: wipe prior derived artifacts before recompute.
    // Scoped, bound-?, prepared once — mirrors stmtDeleteAbstractsEdges :210-212.
    this.stmtDeleteSchemaRelEdges = db.prepare(
      "DELETE FROM edge WHERE kind = 'schema_rel'"
    );

    // SREL-02 / D-04: wipe prior super-schema artifacts before recompute.
    // Identification rule: id LIKE 'super::%' + type='schema' + origin='inferred'.
    // Leaf schemas from induceSchemas() use UUID ids (newId()) — never match 'super::%'.
    // T-18-05: scoped DELETE cannot accidentally remove leaf schemas.
    // Delete edges first (referential order: edge.src refs node.id).
    //
    // FK-01 fix: delete ALL edges that reference a super-schema as src OR dst, regardless
    // of kind. Prior to this fix the statement filtered AND kind='abstracts', which missed
    // kind='relation' edges created when a super-schema appeared as a top-k candidate in
    // Phase B applyDecision 'extend' and was wired as the src of an 'extends' relation edge.
    // stmtDeleteSchemaRelEdges above handles kind='schema_rel'; the OR dst guard below covers
    // any future edge kinds that could reference a super-schema on either endpoint.
    this.stmtDeleteSuperSchemaEdges = db.prepare(
      "DELETE FROM edge WHERE src LIKE 'super::%' OR dst LIKE 'super::%'"
    );
    this.stmtDeleteSuperSchemaNodes = db.prepare(
      "DELETE FROM node WHERE id LIKE 'super::%' AND type = 'schema' AND origin = 'inferred'"
    );
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Derive schema↔schema `schema_rel` edges (SREL-01) and super-schema cluster nodes
   * (SREL-02) from member-centroid cosine similarity. Atomic wipe-and-rebuild (D-04).
   *
   * Phase A (async-free — centroids come from persisted member embeddings):
   *   For each live schema, recompute its centroid from observed members only.
   *   Skip schemas with no valid observed centroid (e.g. super-schemas from prior pass,
   *   whose 'abstracts' children are schema nodes, absent from the fact/entity lookup).
   *   Collect schema-pair relationships whose centroid cosine ≥ threshold.
   *   Cluster schemas with valid centroids via average-linkage agglomerative algorithm.
   *
   * Phase B (sync write — one db.transaction with no await inside):
   *   Wipe prior schema_rel edges + super-schema nodes/edges (D-04).
   *   Upsert the collected pairs and new super-schema hierarchy.
   *
   * A crash mid-derive leaves wipe-then-rebuild-clean state; next pass rebuilds from scratch.
   * Artifacts are disposable derived cache — no checkpoint granularity needed.
   */
  async deriveSchemaRelations(): Promise<void> {
    // ── Phase A: collect centroids from observed members ──────────────────

    const schemaNodes = this.stmtGetSchemaNodes.all() as SchemaNodeRow[];
    if (schemaNodes.length < 2) {
      // Fewer than 2 schemas → no pairs to relate and no clusters to form.
      // Still wipe any prior derived artifacts for D-04 idempotency.
      // .immediate(): acquire the write lock up front, matching the rest of the sleep pass's
      // Phase B discipline (M-5) — a DEFERRED txn can hit SQLITE_BUSY_SNAPSHOT when the viz
      // server holds a concurrent SHARED read lock (WR-02).
      this.db.transaction(() => {
        this.stmtDeleteSchemaRelEdges.run();
        this.stmtDeleteSuperSchemaEdges.run();
        this.stmtDeleteSuperSchemaNodes.run();
      }).immediate();
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

    // SREL-02 (plan 18-02): cluster schemas with valid centroids into super-schema groups.
    // Super-schemas from a prior pass have null centroids (their 'abstracts' children are
    // schema nodes, absent from clusterableById), so they are naturally excluded here.
    const clusterableForSuper = schemasWithCentroids
      .filter((s): s is { id: string; centroid: Float32Array } => s.centroid !== null);
    const clusters = this.clusterSchemaCentroids(
      clusterableForSuper.map(s => ({ schemaId: s.id, centroid: s.centroid })),
    );

    // Schema value lookup for deterministic super-schema label generation (no LLM).
    const schemaValueById = new Map<string, string>(schemaNodes.map(s => [s.id, s.value]));

    // ── Phase B: sync write inside one transaction — NO await inside (T-02-ASYNC) ──

    const nowMs = this.clock.nowMs();

    this.db.transaction(() => {
      // D-04 wipe-from-scratch: delete all prior derived artifacts (idempotent rebuild).
      // Order: schema_rel edges, then super-schema child abstracts edges, then super-schema nodes.
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

      // SREL-02: materialize super-schema cluster nodes + abstracts edges.
      // Wipe + recreate runs inside this same atomic transaction (D-04).
      this.deriveSuperSchemas(clusters, schemaValueById, nowMs);
    }).immediate(); // M-5 write-lock discipline — avoid SQLITE_BUSY_SNAPSHOT (WR-02)
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Deterministic average-linkage agglomerative clustering over schema centroids (SREL-02, D-03).
   *
   * Distance metric: 1 − cosineSimF32(a, b) in [0, 1].
   * Merge rule: merge the cluster pair with the minimum average-linkage distance when
   * that distance ≤ config.schemaClusterCutHeight. Stop when no pair qualifies.
   * Tie-breaking: lexicographic cluster-pair key (each cluster's sorted min id) → deterministic.
   * Structural invariant: only emit clusters with ≥ 2 members as super-schema candidates.
   * A cluster of one is not a hierarchy level — no super-schema node is materialised for it.
   *
   * Average-linkage was chosen over single-linkage for compactness: single-linkage can
   * produce long-chain "chaining" merges that form one large, incoherent super-schema;
   * average-linkage is more conservative and naturally produces tighter groupings.
   *
   * Pure: no this.store or this.db calls inside this method body.
   *
   * @param schemas - Schemas with non-null centroids to cluster (inferred/null-centroid excluded)
   * @returns Array of clusters, each an array of ≥2 schemaIds (already sorted)
   */
  private clusterSchemaCentroids(
    schemas: Array<{ schemaId: string; centroid: Float32Array }>,
  ): string[][] {
    if (schemas.length < 2) return [];

    type Cluster = { ids: string[]; vecs: Float32Array[] };

    // Start: each schema is its own cluster. IDs sorted for stable tie-breaking.
    let clusters: Cluster[] = schemas.map(s => ({
      ids: [s.schemaId],
      vecs: [s.centroid],
    }));

    // Agglomerative merge loop: O(n²) per iteration, acceptable at schema-graph scale (~10-50).
    for (;;) {
      if (clusters.length < 2) break;

      let bestDist = Infinity;
      let bestKey = '';
      let bestI = -1;
      let bestJ = -1;

      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const dist = avgLinkageDist(clusters[i]!.vecs, clusters[j]!.vecs);
          // Deterministic tie-breaking: prefer pair with lexicographically smaller key.
          const key = clusterPairKey(clusters[i]!.ids, clusters[j]!.ids);
          if (dist < bestDist || (dist === bestDist && key < bestKey)) {
            bestDist = dist;
            bestKey = key;
            bestI = i;
            bestJ = j;
          }
        }
      }

      // No more merges: minimum distance exceeds the cut height.
      if (bestDist > this.config.schemaClusterCutHeight) break;

      // Merge bestJ into bestI. IDs kept sorted for stable pair-key computation.
      const merged: Cluster = {
        ids: [...clusters[bestI]!.ids, ...clusters[bestJ]!.ids].sort(),
        vecs: [...clusters[bestI]!.vecs, ...clusters[bestJ]!.vecs],
      };
      // Replace bestI with merged; remove bestJ (j > i always, so splice j first).
      clusters[bestI] = merged;
      clusters.splice(bestJ, 1);
    }

    // Structural invariant: a cluster of one is not a hierarchy level.
    // Only ≥ 2-member clusters become super-schema candidates.
    return clusters.filter(c => c.ids.length >= 2).map(c => c.ids);
  }

  /**
   * Materialize super-schema nodes and their child 'abstracts' edges (SREL-02, D-03).
   *
   * MUST be called INSIDE a db.transaction — no await, no async ops (T-02-ASYNC).
   * Wipes old module-created super-schemas by 'super::' id prefix, then recreates (D-04).
   *
   * D-03 CRITICAL GUARD: super-schemas are type='schema', origin='inferred'. The
   * induceSchemas() clusterable query at schema-induction.ts:186-192 gates on
   * type IN ('fact','entity'), structurally excluding super-schemas from leaf re-clustering.
   * This coupling is what keeps super-schemas out of the leaf induction pipeline.
   * The dedicated exclusion test in plan 18-04 asserts this invariant at runtime.
   *
   * @param clusters - Array of child schema id arrays (each ≥ 2 members, sorted)
   * @param schemaValueById - Node values keyed by schema id for deterministic labelling
   * @param nowMs - Timestamp for edge last_access (D-12 clock discipline, never Date.now())
   */
  private deriveSuperSchemas(
    clusters: string[][],
    schemaValueById: Map<string, string>,
    nowMs: number,
  ): void {
    // D-04 scoped wipe: target only module-created super-schemas.
    // Identification rule: id LIKE 'super::%' + type='schema' + origin='inferred'.
    // Leaf schemas from induceSchemas() use UUID ids (newId()) — never match 'super::%'.
    // T-18-05: this scoped DELETE cannot accidentally remove any leaf schema node.
    // Edges before nodes (referential order: edge.src references node.id).
    this.stmtDeleteSuperSchemaEdges.run();
    this.stmtDeleteSuperSchemaNodes.run();

    for (const childIds of clusters) {
      // Deterministic super-schema id: 'super::' prefix + sorted child ids joined by '|'.
      // Reruns over identical inputs produce identical ids (D-04 rebuildability).
      // childIds are already sorted from clusterSchemaCentroids; sort() here is defensive.
      const sortedIds = [...childIds].sort();
      const superId = `super::${sortedIds.join('|')}`;

      // Deterministic label — no LLM call ($0 + rebuildable per Claude's Discretion).
      const childValues = sortedIds.map(id => schemaValueById.get(id) ?? id);
      const label = superSchemaLabel(childValues);

      // D-03 CRITICAL GUARD: super-schema nodes are type='schema', origin='inferred'.
      // The induceSchemas() clusterable query (schema-induction.ts:186-192) filters
      // type IN ('fact','entity'), structurally excluding super-schemas from leaf
      // re-clustering. This coupling prevents super-schemas from becoming leaf members.
      // Exclusion test in plan 18-04 asserts this invariant holds at runtime.
      // CONSOL-03: write via owned primitive — no raw INSERT.
      this.store.upsertNode({
        id: superId,
        type: 'schema',
        value: label,
        origin: 'inferred',
      });

      for (const childId of sortedIds) {
        // Recursive abstraction: super-schema 'abstracts' child schema.
        // Reuses existing 'abstracts' edge kind — same pattern as schema-abstracts-member.
        // D-12: time via passed-in nowMs, never Date.now() inside a transaction.
        // CONSOL-03: write via owned primitive — no raw INSERT.
        this.store.upsertEdge({
          src: superId,
          dst: childId,
          rel: 'abstracts',
          w: 0.8,
          kind: 'abstracts',
          last_access: nowMs,
        });
      }
    }
  }
}
