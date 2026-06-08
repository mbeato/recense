/**
 * SchemaInducer — offline schema induction (LEARN-01, LEARN-03, D-35/36/37/38).
 *
 * Runs inside the offline sleep pass (Phase C, after reembedDirty(), before runEvictionSweep()).
 * Clusters non-inferred fact/entity nodes by embedding centroid, forms named schema nodes
 * once a cluster meets min-support + cohesion criteria, and strengthens schemas using the
 * JOINING instance's non-inferred origin (never the schema's own 'inferred' origin).
 *
 * Threat mitigations:
 *  - T-04-01-E: stmtGetClusterableNodes filters tombstoned=0, origin!='inferred' (D-37).
 *  - T-04-01-SC: strengthen() called with JOINING instance's origin, never the schema's
 *    'inferred' origin; decay.ts:102 blocks inferred claims (D-38).
 *  - T-04-01-P: naming output is length-bounded, treated as node.value only (not executed).
 *  - T-04-01-K: createAnthropicClient reads keys from process.env via SDK default.
 *  - T-04-01-A: all naming/embedding awaits complete into arrays before db.transaction.
 *
 * Design:
 *  - CONSOL-03: all node/edge writes via owned primitives (upsertNode/upsertEdge) — no
 *    raw INSERT on node or edge tables.
 *  - T-02-ASYNC: async-before-sync; NO await inside any db.transaction.
 *  - T-01-SQL: all queries via prepared statements compiled once in constructor.
 *  - D-12: all time reads via this.clock.nowMs() — never Date.now() directly.
 *  - Pitfall 5: Float32Array decoded with byteOffset + byteLength / 4 (never bare Buffer).
 */
import Database from 'better-sqlite3';
import type { Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { Origin } from '../lib/types';
import type { SemanticStore } from '../db/semantic-store';
import type { StrengthDecayManager } from '../strength/decay';
import type { CandidateRetriever } from '../retrieval/topk';
import type { ModelProvider } from '../model/provider';
import { cosineSimF32 } from '../retrieval/topk';
import { newId } from '../lib/hash';

// ---------------------------------------------------------------------------
// Schema name validation
// ---------------------------------------------------------------------------

/**
 * Returns false when the candidate schema name looks like an LLM refusal, clarifying
 * question, or sentence (not a 2-5 word label). Protects against naming calls that
 * return meta-commentary instead of a concise concept label.
 *
 * Rejects when ANY of:
 *  - empty after trim
 *  - contains '?' (questions / refusals)
 *  - word count > 8 (the prompt asks for 2-5 words; allow slack but reject sentences)
 *  - case-insensitively matches any known refusal / meta-commentary prefix
 */
function isValidSchemaName(name: string): boolean {
  if (!name) return false;
  if (name.includes('?')) return false;
  if (name.split(/\s+/).filter(Boolean).length > 8) return false;
  const lower = name.toLowerCase();
  const refusalPatterns = [
    "i don't",
    "i do not",
    "i cannot",
    "i can't",
    "i'm not",
    "i am not",
    "i'm unable",
    "i am unable",
    "i'm sorry",
    "i apologize",
    "could you",
    "please share",
    "please provide",
    "as an ai",
    "i don't have access",
    "does not contain",
    "no shared",
    "unable to",
  ];
  for (const pattern of refusalPatterns) {
    if (lower.includes(pattern)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Optional naming function injection point.
 * Production: defaults to one Anthropic call per qualifying new schema.
 * Tests: inject a synchronous stub to avoid network calls.
 */
export type NamingFn = (memberValues: string[]) => Promise<string>;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ClusterableNodeRow {
  id: string;
  value: string;
  origin: string;
  embedding: Buffer;
}

interface SchemaNodeRow {
  id: string;
  value: string;
}

interface AllSchemaRow {
  id: string;
  tombstoned: number;
}

interface ClusterableNode {
  id: string;
  value: string;
  origin: Origin;
  vec: Float32Array;
}

interface SchemaWithCentroid {
  id: string;
  centroid: Float32Array | null;
  memberIds: Set<string>;
}

interface CandidateBucket {
  members: ClusterableNode[];
  centroid: Float32Array;
}

interface JoinOp {
  schemaId: string;
  node: ClusterableNode;
}

interface NewSchemaOp {
  name: string;
  members: ClusterableNode[];
}

// ---------------------------------------------------------------------------
// SchemaInducer
// ---------------------------------------------------------------------------

export class SchemaInducer {
  private readonly db: Database.Database;
  private readonly store: SemanticStore;
  private readonly strength: StrengthDecayManager;
  private readonly retriever: CandidateRetriever;
  private readonly provider: ModelProvider;
  private readonly config: EngineConfig;
  private readonly clock: Clock;
  private readonly namingFn: NamingFn;

  // Prepared statements compiled once — never per-call (T-01-SQL)
  private readonly stmtGetClusterableNodes: Database.Statement;
  private readonly stmtGetSchemaMembers: Database.Statement;
  private readonly stmtGetSchemaNodes: Database.Statement;
  private readonly stmtGetAllSchemaNodes: Database.Statement;
  private readonly stmtDeleteAbstractsEdges: Database.Statement;

  constructor(
    db: Database.Database,
    store: SemanticStore,
    strength: StrengthDecayManager,
    retriever: CandidateRetriever,
    provider: ModelProvider,
    config: EngineConfig,
    clock: Clock,
    namingFn?: NamingFn,
  ) {
    this.db = db;
    this.store = store;
    this.strength = strength;
    this.retriever = retriever;
    this.provider = provider;
    this.config = config;
    this.clock = clock;
    this.namingFn = namingFn ?? ((values) => this.callLlmNaming(values));

    // T-04-01-E: filter tombstoned=0, origin!='inferred', type IN ('fact','entity'),
    // embedding IS NOT NULL — an inferred node can never launder into a schema (D-37)
    this.stmtGetClusterableNodes = db.prepare(
      "SELECT id, value, origin, embedding FROM node " +
      "WHERE tombstoned = 0 AND origin != 'inferred' " +
      "AND type IN ('fact','entity') AND embedding IS NOT NULL"
    );

    // Schema members via abstracts edges (one row per member)
    this.stmtGetSchemaMembers = db.prepare(
      "SELECT dst FROM edge WHERE src = ? AND kind = 'abstracts'"
    );

    // All non-tombstoned schema nodes (to recompute centroids each pass)
    this.stmtGetSchemaNodes = db.prepare(
      "SELECT id, value FROM node WHERE type = 'schema' AND tombstoned = 0"
    );

    // All schema nodes (including tombstoned) — for D-39 falsification scan every pass
    this.stmtGetAllSchemaNodes = db.prepare(
      "SELECT id, tombstoned FROM node WHERE type = 'schema'"
    );

    // Abstracts-edge cleanup: scoped WHERE src = ? AND kind = 'abstracts' (T-04-02-T, T-01-SQL)
    this.stmtDeleteAbstractsEdges = db.prepare(
      "DELETE FROM edge WHERE src = ? AND kind = 'abstracts'"
    );
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Induce schema nodes from clusterable instances (LEARN-01, D-35/36/38).
   * Also runs a falsification stage every pass (D-39, ROADMAP criterion 4):
   *   (1) Erosion: tombstone schemas whose surviving non-inferred member count < schemaMinSupport.
   *   (2) Cleanup: delete all outgoing abstracts edges from every tombstoned schema —
   *       whether tombstoned by erosion (this pass) or by the consolidator's applyDecision
   *       contradict → reconcile path (prior pass).
   *
   * Phase A: ALL async work (embedding, LLM naming) → plain arrays.
   * Phase B: synchronous DB writes — no await inside db.transaction (T-02-ASYNC).
   *
   * NOTE: the falsification stage runs even when clusterableRows is empty —
   * tombstoned schemas must always be cleaned up, regardless of cluster activity.
   *
   * Threat mitigations:
   *  - T-04-02-T: stmtDeleteAbstractsEdges scoped to WHERE src=? AND kind='abstracts'
   *    (prepared once in constructor, bound ? — no string interpolation).
   *  - T-04-02-I: post-condition: zero abstracts edges point at a tombstoned schema.
   *  - T-04-02-DEL: only edges deleted — member nodes themselves are never deleted.
   */
  async induceSchemas(): Promise<void> {
    // ── Phase A: async ──────────────────────────────────────────────────────

    // 1. Fetch all clusterable nodes (non-inferred, non-tombstoned fact/entity with embedding).
    // No early return: the falsification stage in Phase B must run every pass.
    const clusterableRows = this.stmtGetClusterableNodes.all() as ClusterableNodeRow[];

    // Collect ops into plain arrays before the synchronous transaction (T-02-ASYNC).
    const joinOps: JoinOp[] = [];
    const newSchemaOps: NewSchemaOp[] = [];

    if (clusterableRows.length > 0) {
      // 2. Decode embeddings (Pitfall 5: byteOffset + byteLength / 4)
      const clusterableNodes: ClusterableNode[] = clusterableRows.map(row => ({
        id: row.id,
        value: row.value,
        origin: row.origin as Origin,
        vec: new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4),
      }));

      // 3. Load existing schemas and compute their centroids from persisted member embeddings
      //    Centroid is recomputed-from-members each pass (NOT stored on node — no DB migration)
      const schemaNodeRows = this.stmtGetSchemaNodes.all() as SchemaNodeRow[];
      const existingSchemas: SchemaWithCentroid[] = [];

      for (const schemaRow of schemaNodeRows) {
        const memberRows = this.stmtGetSchemaMembers.all(schemaRow.id) as { dst: string }[];
        const memberIds = new Set(memberRows.map(r => r.dst));

        const memberVecs: Float32Array[] = [];
        for (const memberId of memberIds) {
          const node = this.store.getNode(memberId);
          if (!node || !node.embedding || node.tombstoned === 1 || node.origin === 'inferred') continue;
          memberVecs.push(new Float32Array(
            node.embedding.buffer, node.embedding.byteOffset, node.embedding.byteLength / 4,
          ));
        }

        if (memberVecs.length === 0) {
          existingSchemas.push({ id: schemaRow.id, centroid: null, memberIds });
          continue;
        }

        // Compute mean centroid
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

        existingSchemas.push({ id: schemaRow.id, centroid, memberIds });
      }

      // 4. Assign each clusterable node: JOIN existing schema or hold in candidate bucket
      //    D-35: leader/centroid incremental clustering

      // Build a global set of node IDs already indexed under any existing schema.
      // Nodes already in a schema are skipped from JOIN/candidate processing:
      //  - They don't need to re-join (would produce duplicate edges + redundant strengthens).
      //  - Without this guard, existing members fall into candidate buckets and form spurious
      //    duplicate schemas on subsequent passes (correctness guard, not just optimisation).
      const alreadyInSchema = new Set<string>();
      for (const schema of existingSchemas) {
        for (const memberId of schema.memberIds) {
          alreadyInSchema.add(memberId);
        }
      }

      const candidateBuckets: CandidateBucket[] = [];

      for (const node of clusterableNodes) {
        // Skip nodes already indexed under any schema (they're already linked)
        if (alreadyInSchema.has(node.id)) continue;

        // Find nearest existing schema centroid
        let bestSchemaId: string | null = null;
        let bestSim = -1;

        for (const schema of existingSchemas) {
          if (!schema.centroid) continue;
          const sim = cosineSimF32(node.vec, schema.centroid);
          if (sim > bestSim) {
            bestSim = sim;
            bestSchemaId = schema.id;
          }
        }

        if (bestSim >= this.config.schemaJoinCentroidThreshold && bestSchemaId !== null) {
          // JOIN existing schema
          joinOps.push({ schemaId: bestSchemaId, node });
          // Track the new join so subsequent nodes in this pass don't double-join
          const schema = existingSchemas.find(s => s.id === bestSchemaId)!;
          schema.memberIds.add(node.id);
          alreadyInSchema.add(node.id);
        } else {
          // Seed a candidate bucket or join an existing one
          // Leader clustering: join the first bucket whose centroid cosine >= cohesion threshold
          let joinedBucket = false;
          for (const bucket of candidateBuckets) {
            const sim = cosineSimF32(node.vec, bucket.centroid);
            if (sim >= this.config.schemaCohesionThreshold) {
              // Update running centroid (incremental mean)
              const n = bucket.members.length + 1;
              for (let i = 0; i < bucket.centroid.length; i++) {
                bucket.centroid[i] = (bucket.centroid[i]! * (n - 1) + node.vec[i]!) / n;
              }
              bucket.members.push(node);
              joinedBucket = true;
              break;
            }
          }
          if (!joinedBucket) {
            candidateBuckets.push({ members: [node], centroid: node.vec.slice() });
          }
        }
      }

      // 5. Name qualifying buckets — ONE LLM call per new schema (D-36)
      for (const bucket of candidateBuckets) {
        if (bucket.members.length < this.config.schemaMinSupport) continue;

        // Check intra-cluster cohesion (mean pairwise cosine, D-36)
        const vecs = bucket.members.map(m => m.vec);
        let totalSim = 0;
        let pairs = 0;
        for (let i = 0; i < vecs.length; i++) {
          for (let j = i + 1; j < vecs.length; j++) {
            totalSim += cosineSimF32(vecs[i]!, vecs[j]!);
            pairs++;
          }
        }
        const cohesion = pairs > 0 ? totalSim / pairs : 1.0;
        if (cohesion < this.config.schemaCohesionThreshold) continue;

        // One naming call per qualifying bucket (T-02-PARSE: safe fallback on error)
        const memberValues = bucket.members.map(m => m.value);
        let name: string;
        try {
          name = await this.namingFn(memberValues);
          // Length-bound the label (T-04-01-P: treated as untrusted label only),
          // then validate: reject refusals, questions, and sentence-length responses.
          const candidate = String(name).trim().slice(0, 200);
          name = isValidSchemaName(candidate) ? candidate : this.fallbackName(bucket.members);
        } catch {
          // T-02-PARSE safe fallback: deterministic placeholder from most-central member
          name = this.fallbackName(bucket.members);
        }

        newSchemaOps.push({ name, members: bucket.members });
      }
    } // end if (clusterableRows.length > 0)

    // ── Phase B: synchronous DB writes — NO await inside transaction (T-02-ASYNC) ──
    this.db.transaction(() => {
      const nowMs = this.clock.nowMs();

      // Process JOIN assignments to existing schemas
      for (const op of joinOps) {
        // Add abstracts edge from schema to member
        this.store.upsertEdge({
          src: op.schemaId,
          dst: op.node.id,
          rel: 'abstracts',
          w: 0.8,
          kind: 'abstracts',
          last_access: nowMs,
        });
        // D-38 CRITICAL: strengthen with the JOINING INSTANCE's origin, NOT the schema's 'inferred'
        // decay.ts:102 blocks 'inferred' — so this MUST be the member's non-inferred origin
        this.strength.strengthen(op.schemaId, op.node.origin);
      }

      // Process new schema creation
      for (const op of newSchemaOps) {
        const schemaId = newId();
        // Schema node: type='schema', origin='inferred' (D-38)
        // training_eligible derivation in upsertNode already excludes inferred — no extra work
        this.store.upsertNode({
          id: schemaId,
          type: 'schema',
          value: op.name,
          origin: 'inferred',
        });
        for (const member of op.members) {
          // Member link: kind='abstracts'
          this.store.upsertEdge({
            src: schemaId,
            dst: member.id,
            rel: 'abstracts',
            w: 0.8,
            kind: 'abstracts',
            last_access: nowMs,
          });
          // D-38: pass member's non-inferred origin to strengthen()
          // decay.ts:102 would no-op if we accidentally passed 'inferred'
          this.strength.strengthen(schemaId, member.origin);
        }
      }

      // ── Falsification stage (D-39) — runs every pass ──────────────────────
      //
      // (1) Erosion: for each non-tombstoned schema, count surviving non-tombstoned
      //     non-inferred members. If count < schemaMinSupport, tombstone the schema.
      // (2) Cleanup invariant: for EVERY tombstoned schema (erosion this pass, OR
      //     tombstoned by the consolidator's contradict route on a prior applyDecision),
      //     delete all outgoing abstracts edges so no edge dangles to a dead schema.
      //
      // No `await` here — all reads and writes are synchronous better-sqlite3 ops (T-02-ASYNC).
      // stmtDeleteAbstractsEdges uses a bound `?` (T-04-02-T, T-01-SQL).
      const allSchemas = this.stmtGetAllSchemaNodes.all() as AllSchemaRow[];
      const newlyTombstoned = new Set<string>();

      // Step 1: erosion scan (non-tombstoned schemas only)
      for (const schema of allSchemas) {
        if (schema.tombstoned === 0) {
          const memberRows = this.stmtGetSchemaMembers.all(schema.id) as Array<{ dst: string }>;
          let surviveCount = 0;
          for (const row of memberRows) {
            const member = this.store.getNode(row.dst);
            if (member && member.tombstoned === 0 && member.origin !== 'inferred') {
              surviveCount++;
            }
          }
          if (surviveCount < this.config.schemaMinSupport) {
            this.store.tombstone(schema.id);
            newlyTombstoned.add(schema.id);
          }
        }
      }

      // Step 2: cleanup — delete abstracts edges from all tombstoned schemas
      // (both schemas already tombstoned before this transaction and those eroded above)
      for (const schema of allSchemas) {
        if (schema.tombstoned === 1 || newlyTombstoned.has(schema.id)) {
          this.stmtDeleteAbstractsEdges.run(schema.id);
        }
      }
    })();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Call the model to name a cluster, routing through ModelProvider.generate (SEAM-01, D-46).
   * T-04-01-K: keys are handled below the ModelProvider seam — never in this file.
   * T-04-01-P: output is an untrusted label only — length-bounded, never executed.
   */
  private async callLlmNaming(memberValues: string[]): Promise<string> {
    const valuesStr = memberValues.map(v => `"${v}"`).join(', ');
    const prompt = `These are related memory facts: ${valuesStr}. Provide a SHORT (2-5 words) human-readable label for the shared concept or pattern. Reply with ONLY the label, no punctuation.`;

    const text = (await this.provider.generate(prompt, { maxTokens: 50 })).trim();

    if (!text) throw new Error('Empty schema naming response');
    return text;
  }

  /**
   * T-02-PARSE safe fallback: deterministic placeholder derived from the first member value.
   * Used when the LLM naming call fails or returns an empty string.
   */
  private fallbackName(members: ClusterableNode[]): string {
    const base = members[0]?.value ?? 'unnamed';
    return `schema:${base}`.slice(0, 200);
  }
}
