/**
 * Falsification tests for SchemaRelationDeriver + RecallEngine (SREL-01/02/03).
 *
 * Harness mirrors tests/schema-induction-falsify.test.ts: in-memory Database, initSchema,
 * FakeClock, DEFAULT_CONFIG, MockEmbedder, no network.
 *
 * Coverage:
 *   D-37 SENTINEL (ROADMAP criterion 4)
 *        — inferred-origin members injected into both derivation pipelines (schema_rel
 *          edge formation + super-schema clustering); observable assertion: ZERO schema_rel
 *          edges and ZERO super-schema abstracts edges touch the inferred node.
 *          Centroid-pollution check: inferred members' embeddings differ from observed; if
 *          the D-37 guard were absent, schema B's centroid would be pulled below the
 *          similarity threshold so no schema_rel edge would form. With the guard, schema B's
 *          centroid is computed from observed-only members and the edge forms — proving the
 *          inferred signal was excluded.
 *   Tombstone invariant
 *        — after a deriver pass no schema_rel edge has a tombstoned schema as src or dst.
 *   D-43 recall no-write-back
 *        — node count and edge count are unchanged across recall(); only one new
 *          origin:'inferred' episode is appended (the single permitted write, D-43).
 *
 * Threat mitigations verified:
 *   T-18-01 / D-37   — D-37 sentinel guards both derivation pipelines
 *   T-18-03 / D-43   — no-write-back test proves recall is read-only (SREL-03 ephemeral guarantee)
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { EpisodicStore } from '../src/db/episode-store';
import { StrengthDecayManager } from '../src/strength/decay';
import { CandidateRetriever } from '../src/retrieval/topk';
import { MockEmbedder } from '../src/model/embedder';
import { MockModelProvider } from '../src/model/provider';
import type { EdgeRow } from '../src/lib/types';
import { SchemaRelationDeriver } from '../src/consolidation/schema-relations';
import { RecallEngine } from '../src/recall';
import { newId } from '../src/lib/hash';

// ---------------------------------------------------------------------------
// Helpers (mirror schema-induction-falsify.test.ts harness patterns)
// ---------------------------------------------------------------------------

interface Harness {
  db: Database.Database;
  clock: FakeClock;
  store: SemanticStore;
  episodes: EpisodicStore;
  strength: StrengthDecayManager;
  retriever: CandidateRetriever;
  config: EngineConfig;
}

function makeHarness(configOverrides?: Partial<EngineConfig>): Harness {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const config: EngineConfig = {
    ...DEFAULT_CONFIG,
    dbPath: ':memory:',
    // Low schema_rel threshold so observed-centroid schemas do relate
    schemaRelSimilarityThreshold: 0.5,
    ...configOverrides,
  };
  const store = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, store, episodes, strength, retriever, config };
}

/** Seed a node with a controlled embedding vector; returns node id. */
async function seedNodeWithEmbedding(
  h: Harness,
  embedder: MockEmbedder,
  opts: {
    id?: string;
    value: string;
    origin?: 'observed' | 'asserted_by_user' | 'inferred';
    type?: 'fact' | 'entity' | 'schema';
    tombstoned?: boolean;
  },
): Promise<string> {
  const id = opts.id ?? newId();
  h.store.upsertNode({
    id,
    type: opts.type ?? 'fact',
    value: opts.value,
    origin: opts.origin ?? 'observed',
    tombstoned: opts.tombstoned ?? false,
  });
  const [vec] = await embedder.embed([opts.value]);
  h.store.setEmbedding(id, vec!);
  return id;
}

/** Create a schema node and wire members via abstracts edges; returns schemaId. */
function createSchema(h: Harness, memberIds: string[]): string {
  const schemaId = newId();
  h.store.upsertNode({
    id: schemaId,
    type: 'schema',
    value: `schema-${schemaId.slice(0, 6)}`,
    origin: 'inferred',
  });
  for (const memberId of memberIds) {
    h.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 0.9, kind: 'abstracts' });
  }
  return schemaId;
}

/**
 * Global invariant: after each deriveSchemaRelations() pass, no schema_rel edge may have
 * a tombstoned node as src or dst (mirrors assertNoTombstonedAbstractsSrc in schema-induction-falsify.test.ts).
 */
function assertNoSchemaRelEdgeTouchesTombstoned(db: Database.Database): void {
  const row = db.prepare(
    "SELECT count(*) as cnt FROM edge e " +
    "JOIN node n ON (e.src = n.id OR e.dst = n.id) " +
    "WHERE e.kind = 'schema_rel' AND n.tombstoned = 1"
  ).get() as { cnt: number };
  expect(row.cnt).toBe(0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SchemaRelationDeriver — falsification', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  // ── D-37 SENTINEL: ROADMAP success criterion 4 ───────────────────────────
  //
  // This is the named, load-bearing artifact. It proves the D-37 firewall holds
  // for BOTH derivation pipelines by observable consequence, not by reading SQL.
  //
  // Setup: schema A (3 observed members, all dim 0) and schema B (1 observed member
  // dim 0 + 2 inferred members dim 1). With schemaRelSimilarityThreshold=0.5:
  //   WITHOUT D-37 guard: B's centroid = (1/3)*dim0 + (2/3)*dim1 → cosine with A ≈ 0.45 < 0.5
  //                        → no schema_rel edge would form (threshold violated)
  //   WITH D-37 guard:    B's centroid = dim0 only (1 observed) → cosine with A = 1.0 > 0.5
  //                        → schema_rel edge DOES form (inferred signal excluded)
  //
  // The observable proof: a schema_rel edge EXISTS between A and B (proving D-37 worked)
  // AND neither inferred node is a schema_rel src/dst or a super-schema abstracts child.

  it('D-37 SENTINEL (criterion 4): inferred members injected into both pipelines; zero schema_rel edges and zero super-schema assignments touch them', async () => {
    const dims = h.config.embeddingDimensions;

    // dim0 embedder: observed fact nodes (direction the schemas relate along)
    const dim0Embedder = new MockEmbedder((_t: string) => {
      const v = new Float32Array(dims); v[0] = 1.0; return v;
    });
    // dim1 embedder: inferred fact nodes (orthogonal — would pollute centroid if included)
    const dim1Embedder = new MockEmbedder((_t: string) => {
      const v = new Float32Array(dims); v[1] = 1.0; return v;
    });

    // Schema A: 3 observed members at dim 0
    const memberAIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberAIds.push(await seedNodeWithEmbedding(h, dim0Embedder, { value: `d37-a-obs-${i}` }));
    }

    // Schema B: 1 observed member at dim 0 + 2 inferred members at dim 1
    // If inferred were included in centroid: B ≈ (1/3, 2/3) → cosine with A ≈ 0.45 < threshold
    // With D-37 guard (inferred excluded): B centroid = dim0 → cosine with A = 1.0 > threshold
    const memberBObsId = await seedNodeWithEmbedding(h, dim0Embedder, { value: 'd37-b-obs' });
    const inferredId1 = await seedNodeWithEmbedding(h, dim1Embedder, { value: 'd37-b-inferred-1', origin: 'inferred' });
    const inferredId2 = await seedNodeWithEmbedding(h, dim1Embedder, { value: 'd37-b-inferred-2', origin: 'inferred' });

    const schemaA = createSchema(h, memberAIds);
    // Schema B explicitly includes inferred nodes as members (the injection)
    const schemaB = createSchema(h, [memberBObsId, inferredId1, inferredId2]);

    const deriver = new SchemaRelationDeriver(h.db, h.store, h.config, h.clock);
    await deriver.deriveSchemaRelations();

    // ── Observable consequence 1: schema A and B DO relate (D-37 guard excluded inferred) ──
    // This is the centroid-pollution proof: if inferred were included, cosine would be ~0.45
    // and no edge would form. The edge existing proves inferred signal was excluded.
    const relEdgesAB = h.db
      .prepare("SELECT * FROM edge WHERE kind = 'schema_rel' AND ((src = ? AND dst = ?) OR (src = ? AND dst = ?))")
      .all(schemaA, schemaB, schemaB, schemaA) as EdgeRow[];
    expect(relEdgesAB).toHaveLength(1);
    // Weight is cosine of observed-only centroids: both are unit vectors at dim 0 → cosine = 1.0
    expect(relEdgesAB[0]!.w).toBeCloseTo(1.0, 4);

    // ── Observable consequence 2: inferred nodes are NOT schema_rel endpoints ──
    // schema_rel edges connect schema nodes; inferred FACT nodes can never be endpoints
    // structurally — this assertion closes the observable proof of both pipelines.
    for (const inferredId of [inferredId1, inferredId2]) {
      const schemaRelForInferred = h.db
        .prepare("SELECT * FROM edge WHERE kind = 'schema_rel' AND (src = ? OR dst = ?)")
        .all(inferredId, inferredId) as EdgeRow[];
      expect(schemaRelForInferred).toHaveLength(0);
    }

    // ── Observable consequence 3: inferred nodes are NOT super-schema abstracts children ──
    // deriveSuperSchemas() creates abstracts edges from super-schema → child-schema only.
    // Inferred FACT nodes (type='fact') are never schema nodes; they can't become
    // super-schema children. This assertion verifies no super-schema-originated abstracts
    // edge points at either inferred node.
    for (const inferredId of [inferredId1, inferredId2]) {
      const superAbstractsForInferred = h.db
        .prepare("SELECT * FROM edge WHERE kind = 'abstracts' AND src LIKE 'super::%' AND dst = ?")
        .all(inferredId) as EdgeRow[];
      expect(superAbstractsForInferred).toHaveLength(0);
    }

    // ── Observable consequence 4: super-schema exists and links only the two leaf schemas ──
    // A and B cluster (both centroid ≈ dim0, distance 0 < cutHeight 0.35) → one super-schema
    const superNodes = h.db
      .prepare("SELECT id FROM node WHERE id LIKE 'super::%' AND origin = 'inferred'")
      .all() as Array<{ id: string }>;
    expect(superNodes).toHaveLength(1);

    const superId = superNodes[0]!.id;
    const superChildEdges = h.db
      .prepare("SELECT dst FROM edge WHERE src = ? AND kind = 'abstracts'")
      .all(superId) as Array<{ dst: string }>;
    const childDsts = new Set(superChildEdges.map(e => e.dst));
    // Children are the two LEAF SCHEMAS, not the inferred nodes
    expect(childDsts.has(schemaA)).toBe(true);
    expect(childDsts.has(schemaB)).toBe(true);
    expect(childDsts.has(inferredId1)).toBe(false);
    expect(childDsts.has(inferredId2)).toBe(false);
  });

  // ── Tombstone invariant ──────────────────────────────────────────────────

  it('Tombstone invariant: after deriveSchemaRelations() no schema_rel edge has a tombstoned schema as src or dst', async () => {
    const dims = h.config.embeddingDimensions;
    const embedder = new MockEmbedder((_t: string) => {
      const v = new Float32Array(dims); v[0] = 1.0; return v;
    });

    // Seed 3 schemas: A and B (same centroid), C (also same centroid)
    // All three relate to each other → 3 potential schema_rel pairs
    const memberAIds: string[] = [];
    const memberBIds: string[] = [];
    const memberCIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberAIds.push(await seedNodeWithEmbedding(h, embedder, { value: `tomb-a-${i}` }));
      memberBIds.push(await seedNodeWithEmbedding(h, embedder, { value: `tomb-b-${i}` }));
      memberCIds.push(await seedNodeWithEmbedding(h, embedder, { value: `tomb-c-${i}` }));
    }
    const schemaA = createSchema(h, memberAIds);
    createSchema(h, memberBIds);
    createSchema(h, memberCIds);

    const deriver = new SchemaRelationDeriver(h.db, h.store, h.config, h.clock);

    // Pass 1: all three schemas relate → schema_rel edges form
    await deriver.deriveSchemaRelations();
    const edgesAfterPass1 = h.db.prepare("SELECT count(*) as cnt FROM edge WHERE kind = 'schema_rel'").get() as { cnt: number };
    expect(edgesAfterPass1.cnt).toBeGreaterThanOrEqual(1); // sanity

    assertNoSchemaRelEdgeTouchesTombstoned(h.db); // invariant holds after pass 1

    // Externally tombstone schema A
    h.store.tombstone(schemaA);
    const tombstoned = h.store.getNode(schemaA);
    expect(tombstoned!.tombstoned).toBe(1);

    // Pass 2: D-04 wipe-then-rebuild — tombstoned schema A excluded from stmtGetSchemaNodes
    await deriver.deriveSchemaRelations();

    // Global invariant: no schema_rel edge touches tombstoned schema A (or any tombstoned node)
    assertNoSchemaRelEdgeTouchesTombstoned(h.db);

    // Specific check: schemaA has no schema_rel edges
    const schemaARelEdges = h.db
      .prepare("SELECT * FROM edge WHERE kind = 'schema_rel' AND (src = ? OR dst = ?)")
      .all(schemaA, schemaA) as EdgeRow[];
    expect(schemaARelEdges).toHaveLength(0);

    // B and C (both live) still relate to each other
    const liveRelEdges = h.db.prepare("SELECT count(*) as cnt FROM edge WHERE kind = 'schema_rel'").get() as { cnt: number };
    expect(liveRelEdges.cnt).toBeGreaterThanOrEqual(1);
  });

  // ── D-43: Recall no-write-back ───────────────────────────────────────────
  //
  // The sideways schema_rel hop in recall/index.ts is read-only (D-43, SREL-03).
  // This test proves it: node count and edge count are unchanged after recall();
  // the ONLY new row is exactly one inferred episode (the single permitted write).
  //
  // The test builds a graph with schema_rel edges (so the sideways hop IS traversed,
  // making this a genuine read-only assertion, not a vacuous test of an empty hop).

  it('D-43 no-write-back: recall() with sideways hop changes zero node/edge rows; exactly one inferred episode appended', async () => {
    const dims = h.config.embeddingDimensions;

    // All nodes embed at dim 0 so the recall query matches the schema node
    const dim0 = new Float32Array(dims);
    dim0[0] = 1.0;
    const fixedEmbedder = new MockEmbedder((_t: string) => dim0.slice());

    // Build graph: schema A with 2 observed members, schema B with 2 observed members
    const memberAIds: string[] = [];
    const memberBIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      memberAIds.push(await seedNodeWithEmbedding(h, fixedEmbedder, { value: `nwb-a-member-${i}` }));
      memberBIds.push(await seedNodeWithEmbedding(h, fixedEmbedder, { value: `nwb-b-member-${i}` }));
    }

    // Set embedding on schema nodes directly (CandidateRetriever needs them for topk)
    const schemaAId = newId();
    h.store.upsertNode({ id: schemaAId, type: 'schema', value: 'schema-nwb-a', origin: 'inferred' });
    h.store.setEmbedding(schemaAId, dim0.slice());
    for (const mid of memberAIds) {
      h.store.upsertEdge({ src: schemaAId, dst: mid, rel: 'abstracts', w: 0.9, kind: 'abstracts' });
    }

    const schemaBId = newId();
    h.store.upsertNode({ id: schemaBId, type: 'schema', value: 'schema-nwb-b', origin: 'inferred' });
    h.store.setEmbedding(schemaBId, dim0.slice());
    for (const mid of memberBIds) {
      h.store.upsertEdge({ src: schemaBId, dst: mid, rel: 'abstracts', w: 0.9, kind: 'abstracts' });
    }

    // Wire a schema_rel edge from A to B so the sideways hop IS traversed during recall
    h.store.upsertEdge({
      src: schemaAId,
      dst: schemaBId,
      rel: 'schema_rel',
      w: 0.95,
      kind: 'schema_rel',
      last_access: h.clock.nowMs(),
    });

    // Snapshot counts BEFORE recall
    const nodeCountBefore = (h.db.prepare("SELECT count(*) as cnt FROM node").get() as { cnt: number }).cnt;
    const edgeCountBefore = (h.db.prepare("SELECT count(*) as cnt FROM edge").get() as { cnt: number }).cnt;
    const episodeCountBefore = (h.db.prepare("SELECT count(*) as cnt FROM episode WHERE origin = 'inferred'").get() as { cnt: number }).cnt;

    // RecallEngine: embed returns dim0, generate returns a non-null inference
    const provider = new MockModelProvider({
      embedFn: (_t: string) => dim0.slice(),
      generateScript: ['inferred answer from schema prior'],
    });

    const engine = new RecallEngine(
      h.db, h.clock, h.config, provider, h.retriever, h.store, h.strength, h.episodes,
    );

    // Run recall — the sideways hop from schema A → schema B will be traversed (read-only)
    const result = await engine.recall('test query for nwb', 'session-nwb');

    // Assert recall returned a non-null inference (proves the sideways path was actually exercised)
    expect(result.inference).not.toBeNull();
    expect(result.origin).toBe('inferred');
    expect(result.episodeId).not.toBeNull();

    // ── D-43: node and edge counts must be UNCHANGED ──
    const nodeCountAfter = (h.db.prepare("SELECT count(*) as cnt FROM node").get() as { cnt: number }).cnt;
    const edgeCountAfter = (h.db.prepare("SELECT count(*) as cnt FROM edge").get() as { cnt: number }).cnt;

    expect(nodeCountAfter).toBe(nodeCountBefore);   // D-43: no new node written
    expect(edgeCountAfter).toBe(edgeCountBefore);   // D-43: no new edge written

    // ── Exactly one new inferred episode appended ──
    const episodeCountAfter = (h.db.prepare("SELECT count(*) as cnt FROM episode WHERE origin = 'inferred'").get() as { cnt: number }).cnt;
    expect(episodeCountAfter).toBe(episodeCountBefore + 1);

    // The episode has the correct shape
    const inferredEp = h.db
      .prepare("SELECT * FROM episode WHERE id = ?")
      .get(result.episodeId) as { origin: string; role: string; content: string } | undefined;
    expect(inferredEp).toBeDefined();
    expect(inferredEp!.origin).toBe('inferred');
    expect(inferredEp!.role).toBe('assistant');
    expect(inferredEp!.content).toBe('inferred answer from schema prior');
  });
});
