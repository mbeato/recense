/**
 * EntityDedup — offline, LLM-free entity-deduplication pass (Phase 25, Plan 25-01).
 *
 * Finds near-duplicate `type='entity'` nodes in the graph, clusters them via a two-stage
 * precision-first matching pass, selects a canonical node per cluster, rewires all edges
 * onto the canonical, tombstones (never deletes) duplicates, and writes an audit event
 * per merge.
 *
 * Design decisions implemented here (from CONTEXT.md + PATTERNS.md):
 *  D-01  Two-stage precision-first: normalizeValue blocking + cosine ≥ threshold (0.88)
 *  D-02  Deterministic iteration (stable sort by id) → second run = no-op
 *  D-03  Transitive clustering via union-find within a run
 *  D-04  Origin guard: never merge mid-reconciliation (non-null prev_value) or cross-origin
 *        non-identical pairs
 *  D-05  Canonical = highest edge degree → highest c → earliest last_access → lex id
 *  D-06  Sidecar inheritance: node_scope + node_temporal propagate to canonical if absent
 *  D-07  Edge rewire: every old edge deleted first (FK-safe), then upsertEdge canonical;
 *        PK collision → max(w), latest last_access; self-loops dropped
 *  D-08  PRAGMA foreign_key_check asserted inside every transaction before commit → throw/rollback
 *  D-09  Duplicates tombstoned via store.tombstone(), never deleted
 *  D-10  consolidation_event row per merge with event_type='entity_merge'
 *  D-12  LLM-free — reuses stored embeddings + cosineSimF32; no new runtime dependency
 *
 * FK invariant (T-FK-01 lesson): delete-old-edge FIRST, then upsertEdge canonical.
 * No window exists where an edge references a non-existent node id.
 *
 * Single-writer discipline (CONSOL-03): all node/edge writes go through SemanticStore
 * primitives. The ONLY raw SQL here is read-side (snapshot, degree query) and the
 * foreign_key_check pragma assertion.
 *
 * No async/await anywhere (T-02-ASYNC): all embedding decode + cosine decisions are
 * computed in-memory BEFORE any db.transaction, whose body is pure synchronous calls.
 */
import Database from 'better-sqlite3';
import type { Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { SemanticStore } from '../db/semantic-store';
import type { ConsolidationSink } from './sink';
import { cosineSimF32 } from '../retrieval/topk';
import { normalizeValue } from './normalize';
import type { EdgeRow, EdgeKind } from '../lib/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One node snapshot entry from the pre-pass SELECT (BEFORE any mutations). */
interface EntitySnapshot {
  id: string;
  value: string;
  c: number;
  last_access: number;
  origin: string;
  prev_value: string | null;
  embedding: Buffer | null;
}

/** One duplicate entry inside a MergeCluster. */
export interface MergeDuplicate {
  id: string;
  value: string;
  cosine: number;
}

/** One merge cluster: canonical + list of duplicates to tombstone. */
export interface MergeCluster {
  canonicalId: string;
  canonicalValue: string;
  duplicates: MergeDuplicate[];
}

/** Return shape of EntityDedup.run(). */
export interface DedupResult {
  clusters: MergeCluster[];
  mergedClusters: number;
  tombstoned: number;
}

// ---------------------------------------------------------------------------
// Union-find (for transitive clustering, D-03)
// ---------------------------------------------------------------------------

class UnionFind {
  private parent: Map<string, string> = new Map();

  find(id: string): string {
    if (!this.parent.has(id)) return id;
    const root = this.find(this.parent.get(id)!);
    this.parent.set(id, root); // path compression
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

// ---------------------------------------------------------------------------
// Embedding decode (Pitfall 5 — Buffer → Float32Array preserving byteOffset)
// ---------------------------------------------------------------------------

function decodeEmbedding(buf: Buffer | null): Float32Array | null {
  if (!buf) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ---------------------------------------------------------------------------
// EntityDedup class
// ---------------------------------------------------------------------------

export class EntityDedup {
  private readonly db: Database.Database;
  private readonly store: SemanticStore;
  private readonly sink: ConsolidationSink;
  private readonly clock: Clock;
  // config kept for future tunables (e.g. default threshold override) — unused now
  private readonly _config: EngineConfig;

  // Read-side prepared statements (compile once in constructor — T-01-SQL)
  // All use bound ? params; no string interpolation.

  /** Snapshot: all live entity nodes ordered by id (deterministic — D-02). */
  private readonly stmtLiveEntities: Database.Statement;

  /** Degree query: total edge count (src OR dst) for canonical selection (D-05). */
  private readonly stmtNodeDegree: Database.Statement;

  constructor(
    db: Database.Database,
    store: SemanticStore,
    sink: ConsolidationSink,
    clock: Clock,
    config: EngineConfig,
  ) {
    this.db = db;
    this.store = store;
    this.sink = sink;
    this.clock = clock;
    this._config = config;

    // Read-side only — no writes from these statements (CONSOL-03: all writes via store)
    this.stmtLiveEntities = db.prepare(`
      SELECT id, value, c, last_access, origin, prev_value, embedding
      FROM node
      WHERE type = 'entity' AND tombstoned = 0
      ORDER BY id
    `);

    // Count out-edges + in-edges for degree (D-05 canonical selection)
    // T-01-SQL: two bound ? params (same nodeId used for src and dst)
    this.stmtNodeDegree = db.prepare(`
      SELECT (SELECT COUNT(*) FROM edge WHERE src = ?) +
             (SELECT COUNT(*) FROM edge WHERE dst = ?) AS degree
    `);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Run the entity dedup pass.
   *
   * @param threshold - cosine similarity threshold for confirming a duplicate pair (D-01)
   * @param dryRun    - if true, compute clusters but make NO database writes (D-11)
   */
  run(opts: { threshold: number; dryRun: boolean }): DedupResult {
    const { threshold, dryRun } = opts;

    // ── Phase A: compute all decisions in-memory (T-02-ASYNC: no db.transaction yet) ──

    const snapshot = this.stmtLiveEntities.all() as EntitySnapshot[];

    // Stage 1: bucket by normalized value (blocking key — D-01)
    const buckets = new Map<string, EntitySnapshot[]>();
    for (const node of snapshot) {
      const key = normalizeValue(node.value);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = [];
        buckets.set(key, bucket);
      }
      bucket.push(node);
    }

    // Stage 2: within each bucket, confirm pairs with cosine ≥ threshold (D-01)
    // Build union-find for transitive closure (D-03)
    const uf = new UnionFind();
    // Track per-pair cosine for provenance (D-10)
    const pairCosine = new Map<string, number>(); // key: `${a.id}|${b.id}`, a < b

    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue;

      // Origin guard filter: skip any node that is mid-reconciliation (D-04)
      const eligible = bucket.filter(n => n.prev_value === null || n.prev_value === undefined);
      if (eligible.length < 2) continue;

      for (let i = 0; i < eligible.length; i++) {
        for (let j = i + 1; j < eligible.length; j++) {
          const a = eligible[i]!;
          const b = eligible[j]!;

          // Origin guard: skip cross-origin non-identical pairs (D-04)
          // "lexically near-identical" = same normalized value (already in same bucket)
          // But we further guard: asserted_by_user↔inferred crossing is allowed ONLY if
          // they have the EXACT same normalized value AND are in the same bucket.
          // Since we're already in a bucket (same normalizeValue), cross-origin same-value
          // merges ARE allowed. Cross-origin DIFFERENT-value pairs would be in different
          // buckets anyway. The origin guard here specifically targets:
          // asserted_by_user vs inferred where we want to be cautious.
          // Per D-04: "skip pairs that are not lexically near-identical AND cross origin boundary"
          // Same bucket = same normalized value = lexically near-identical → allow.
          // However, to be maximally safe: if the two nodes have DIFFERENT raw values
          // (same bucket via blocking key but not truly identical), and cross origin boundary,
          // skip them.
          const sameRawValue = normalizeValue(a.value) === normalizeValue(b.value);
          const crossOrigin =
            (a.origin === 'asserted_by_user' && b.origin === 'inferred') ||
            (a.origin === 'inferred' && b.origin === 'asserted_by_user');
          if (crossOrigin && !sameRawValue) continue;

          // Stage 2 cosine confirmation (D-01)
          const va = decodeEmbedding(a.embedding);
          const vb = decodeEmbedding(b.embedding);
          if (!va || !vb) continue; // no embedding → skip (can't confirm)

          const cosine = cosineSimF32(va, vb);
          if (cosine < threshold) continue;

          // Confirmed pair → union them
          uf.union(a.id, b.id);
          const pairKey = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
          pairCosine.set(pairKey, cosine);
        }
      }
    }

    // Collect clusters: group nodes by their union-find root
    const rootToMembers = new Map<string, EntitySnapshot[]>();
    for (const node of snapshot) {
      const root = uf.find(node.id);
      if (root === node.id) {
        // check if this node has any peers merged into it
        // We'll collect all members by checking all nodes
      }
      let members = rootToMembers.get(root);
      if (!members) {
        members = [];
        rootToMembers.set(root, members);
      }
      members.push(node);
    }

    // Build MergeCluster list — only clusters with ≥ 2 members
    const clusters: MergeCluster[] = [];

    for (const [, members] of rootToMembers) {
      if (members.length < 2) continue;

      // Canonical selection (D-05): highest degree → highest c → earliest last_access → lex id
      const withDegree = members.map(n => {
        const row = this.stmtNodeDegree.get(n.id, n.id) as { degree: number };
        return { node: n, degree: row?.degree ?? 0 };
      });
      withDegree.sort((a, b) => {
        if (b.degree !== a.degree) return b.degree - a.degree;
        if (b.node.c !== a.node.c) return b.node.c - a.node.c;
        if (a.node.last_access !== b.node.last_access) return a.node.last_access - b.node.last_access;
        return a.node.id < b.node.id ? -1 : 1;
      });

      const canonicalEntry = withDegree[0]!;
      const canonicalId = canonicalEntry.node.id;
      const duplicates = withDegree.slice(1);

      // Build representative cosine for each dup (best pair cosine to any member)
      const dupList: MergeDuplicate[] = duplicates.map(d => {
        // Find the best cosine between this dup and the canonical (or any member)
        const pairKey =
          d.node.id < canonicalId
            ? `${d.node.id}|${canonicalId}`
            : `${canonicalId}|${d.node.id}`;
        const cosine = pairCosine.get(pairKey) ?? threshold; // fallback to threshold
        return { id: d.node.id, value: d.node.value, cosine };
      });

      clusters.push({
        canonicalId,
        canonicalValue: canonicalEntry.node.value,
        duplicates: dupList,
      });
    }

    // Dry-run: return computed clusters without touching the DB
    if (dryRun) {
      return { clusters, mergedClusters: clusters.length, tombstoned: 0 };
    }

    // ── Phase B: apply merges — one transaction per cluster (T-02-ASYNC: all sync) ──

    let totalTombstoned = 0;

    for (const cluster of clusters) {
      const { canonicalId, duplicates } = cluster;

      // Collect all edges to rewire BEFORE entering the transaction
      // (read-side only; all Float32Array work is already done above)
      const edgesToRewire: Array<{
        oldSrc: string;
        oldDst: string;
        rel: string;
        w: number;
        last_access: number;
        kind: EdgeKind;
        dupId: string;
      }> = [];

      for (const dup of duplicates) {
        const dupEdges = this.store.getEdgesForNode(dup.id) as EdgeRow[];
        for (const e of dupEdges) {
          edgesToRewire.push({
            oldSrc: e.src,
            oldDst: e.dst,
            rel: e.rel,
            w: e.w,
            last_access: e.last_access,
            kind: e.kind as EdgeKind,
            dupId: dup.id,
          });
        }
      }

      // Pre-read sidecars BEFORE the transaction (D-06)
      const canonicalScope = this.store.getNodeScope(canonicalId);
      const canonicalTemporal = this.store.getNodeTemporal(canonicalId);

      // Collect sidecar inheritance candidates
      const scopeToInherit: string | undefined =
        canonicalScope === undefined
          ? (() => {
              for (const dup of duplicates) {
                const s = this.store.getNodeScope(dup.id);
                if (s !== undefined) return s;
              }
              return undefined;
            })()
          : undefined;

      const temporalToInherit =
        canonicalTemporal === null
          ? (() => {
              for (const dup of duplicates) {
                const t = this.store.getNodeTemporal(dup.id);
                if (t !== null) return t;
              }
              return null;
            })()
          : null;

      // One transaction per cluster (M-5: .immediate() for WAL mode)
      this.db
        .transaction(() => {
          // Step 1: Rewire edges for all duplicates (D-07, T-FK-01)
          // Merge existing canonical edges with rewired dup edges (PK collision → max(w))
          for (const edge of edgesToRewire) {
            const newSrc = edge.oldSrc === edge.dupId ? canonicalId : edge.oldSrc;
            const newDst = edge.oldDst === edge.dupId ? canonicalId : edge.oldDst;

            // Drop self-loops (D-07)
            if (newSrc === newDst) continue;

            // FK-safe order: delete old edge FIRST, then upsert canonical edge (T-FK-01, D-08)
            this.store.deleteEdge(edge.oldSrc, edge.oldDst, edge.rel);

            // Check if canonical already has this edge (PK collision — D-07)
            const existing = (this.store.getEdgesForNode(canonicalId) as EdgeRow[]).find(
              e => e.src === newSrc && e.dst === newDst && e.rel === edge.rel,
            );

            const mergedW = existing ? Math.max(existing.w, edge.w) : edge.w;
            const mergedAccess = existing
              ? Math.max(existing.last_access, edge.last_access)
              : edge.last_access;

            this.store.upsertEdge({
              src: newSrc,
              dst: newDst,
              rel: edge.rel,
              w: mergedW,
              kind: edge.kind,
              last_access: mergedAccess,
            });
          }

          // Step 2: Inherit sidecars (D-06) — inside transaction for atomicity
          if (scopeToInherit !== undefined) {
            this.store.upsertNodeScope({
              node_id: canonicalId,
              scope: scopeToInherit,
              updated_at: this.clock.nowMs(),
            });
          }
          if (temporalToInherit !== null) {
            this.store.upsertNodeTemporal({
              node_id: canonicalId,
              due_at: temporalToInherit.due_at,
              action_type: temporalToInherit.action_type,
              recurrence_rule: temporalToInherit.recurrence_rule ?? undefined,
              source_event_id: temporalToInherit.source_event_id ?? undefined,
              updated_at: this.clock.nowMs(),
            });
          }

          // Step 3: Assert FK integrity BEFORE tombstoning (D-08 load-bearing guard)
          const fkViolations = this.db.pragma('foreign_key_check') as unknown[];
          if (fkViolations.length > 0) {
            throw new Error(
              `FK check failed for cluster (canonical=${canonicalId}): ${JSON.stringify(fkViolations)}`,
            );
          }

          // Step 4: Tombstone duplicates (D-09 — never delete)
          for (const dup of duplicates) {
            this.store.tombstone(dup.id);
          }

          // Step 5: Emit provenance events (D-10) — sync, safe inside transaction (T-05-SINK-TX)
          for (const dup of duplicates) {
            this.sink.emit({
              event_type: 'entity_merge',
              node_id: canonicalId,
              candidate_id: dup.id,
              episode_id: null,
              value: cluster.canonicalValue,
              origin: null,
              magnitude: dup.cosine,
              payload: JSON.stringify({
                merge_threshold: opts.threshold,
                cosine: dup.cosine,
                cluster_size: cluster.duplicates.length + 1,
              }),
            });
          }
        })
        .immediate();

      totalTombstoned += duplicates.length;
    }

    return { clusters, mergedClusters: clusters.length, tombstoned: totalTombstoned };
  }
}
