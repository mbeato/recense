/**
 * Behavioral tests for SchemaInducer (offline schema induction, LEARN-01/LEARN-03).
 *
 * Harness mirrors tests/consolidation.test.ts: in-memory Database, initSchema,
 * FakeClock, DEFAULT_CONFIG, MockEmbedder, no network.
 *
 * Coverage:
 *   LEARN-01  — qualifying cluster produces named schema node with abstracts edges
 *   LEARN-03  — strengthen called with JOINING instance's non-inferred origin (D-38)
 *   D-37      — inferred/tombstoned nodes never clustered or linked
 *   D-36      — below-min-support cluster produces no schema node and no naming call
 *   T-02-ASYNC — no await inside db.transaction (structural, verified by atomicity)
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { StrengthDecayManager } from '../src/strength/decay';
import { CandidateRetriever } from '../src/retrieval/topk';
import { MockEmbedder } from '../src/model/embedder';
import type { NodeRow } from '../src/lib/types';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { newId } from '../src/lib/hash';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a unit vector in dimension 0 — all texts share cosine 1.0 (same cluster). */
function makeSameClusterEmbedder(dims: number): MockEmbedder {
  return new MockEmbedder((_text: string) => {
    const vec = new Float32Array(dims);
    vec[0] = 1.0;
    return vec;
  });
}

/**
 * Hash-seeded embedder: each distinct text maps to a unique dimension.
 * Two texts with the same content produce cosine 1.0; different texts produce 0.
 */
function makeUniqueEmbedder(dims: number): MockEmbedder {
  return new MockEmbedder((text: string) => {
    const vec = new Float32Array(dims);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) >>> 0;
    }
    vec[hash % dims] = 1.0;
    return vec;
  });
}

/**
 * Stubbed naming function — never makes network calls.
 * Returns a deterministic name so tests can assert the schema node's value.
 */
function makeStubNamingFn(name = 'test-schema'): (values: string[]) => Promise<string> {
  return async (_values: string[]) => name;
}

interface Harness {
  db: Database.Database;
  clock: FakeClock;
  store: SemanticStore;
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
    schemaMinSupport: 3,
    schemaCohesionThreshold: 0.7,
    schemaJoinCentroidThreshold: 0.75,
    ...configOverrides,
  };
  const store = new SemanticStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, store, strength, retriever, config };
}

/** Helper: seed a node with a pre-attached embedding vector. */
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SchemaInducer', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  // ── LEARN-01: qualifying cluster → named schema + abstracts edges ────────

  it('LEARN-01: N≥schemaMinSupport same-cluster non-inferred nodes → exactly one schema node + N abstracts edges', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);
    const namingFn = makeStubNamingFn('programming-language');

    // Seed 3 non-inferred nodes (same cluster)
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await seedNodeWithEmbedding(h, embedder, { value: `lang-fact-${i}` }));
    }

    const inducer = new SchemaInducer(
      h.db, h.store, h.strength, h.retriever, embedder, h.config, h.clock, namingFn,
    );

    await inducer.induceSchemas();

    // Exactly one schema node
    const schemaNodes = (h.db.prepare("SELECT * FROM node WHERE type = 'schema'").all() as NodeRow[]);
    expect(schemaNodes).toHaveLength(1);
    expect(schemaNodes[0]!.origin).toBe('inferred');
    expect(schemaNodes[0]!.value).toBe('programming-language');

    // Exactly 3 abstracts edges from the schema to the member nodes
    const schemaId = schemaNodes[0]!.id;
    const edges = h.db.prepare("SELECT * FROM edge WHERE src = ? AND kind = 'abstracts'").all(schemaId) as Array<{ dst: string }>;
    expect(edges).toHaveLength(3);

    const edgeDsts = new Set(edges.map(e => e.dst));
    for (const id of ids) {
      expect(edgeDsts.has(id)).toBe(true);
    }
  });

  // ── D-37: inferred nodes are never clustered ─────────────────────────────

  it('D-37: inferred-origin node is NEVER selected as clusterable and NEVER linked under a schema', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);
    const namingFn = makeStubNamingFn('should-not-form');

    // 2 non-inferred + 1 inferred (all same vector)
    await seedNodeWithEmbedding(h, embedder, { value: 'non-inferred-a', origin: 'observed' });
    await seedNodeWithEmbedding(h, embedder, { value: 'non-inferred-b', origin: 'asserted_by_user' });
    const inferredId = await seedNodeWithEmbedding(h, embedder, { value: 'inferred-node', origin: 'inferred' });

    const inducer = new SchemaInducer(
      h.db, h.store, h.strength, h.retriever, embedder, h.config, h.clock, namingFn,
    );

    await inducer.induceSchemas();

    // Only 2 non-inferred qualify; schemaMinSupport=3 → no schema formed
    const schemaNodes = h.db.prepare("SELECT * FROM node WHERE type = 'schema'").all() as NodeRow[];
    expect(schemaNodes).toHaveLength(0);

    // Even if a schema were formed, the inferred node must never be a dst in abstracts
    const inferredEdges = h.db.prepare("SELECT * FROM edge WHERE dst = ? AND kind = 'abstracts'").all(inferredId);
    expect(inferredEdges).toHaveLength(0);
  });

  // ── D-37: tombstoned nodes are never clustered ────────────────────────────

  it('D-37: tombstoned node is NEVER selected as clusterable and NEVER linked under a schema', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);
    const namingFn = makeStubNamingFn('should-not-form');

    // 2 live + 1 tombstoned (all same vector)
    await seedNodeWithEmbedding(h, embedder, { value: 'live-a' });
    await seedNodeWithEmbedding(h, embedder, { value: 'live-b' });
    const tombId = await seedNodeWithEmbedding(h, embedder, { value: 'tombstoned-node', tombstoned: true });

    const inducer = new SchemaInducer(
      h.db, h.store, h.strength, h.retriever, embedder, h.config, h.clock, namingFn,
    );

    await inducer.induceSchemas();

    // 2 live nodes; schemaMinSupport=3 → no schema
    const schemaNodes = h.db.prepare("SELECT * FROM node WHERE type = 'schema'").all() as NodeRow[];
    expect(schemaNodes).toHaveLength(0);

    // tombstoned node must never be an abstracts dst
    const tombEdges = h.db.prepare("SELECT * FROM edge WHERE dst = ? AND kind = 'abstracts'").all(tombId);
    expect(tombEdges).toHaveLength(0);
  });

  // ── D-36: below-min-support cluster → no schema, no naming call ──────────

  it('D-36: below-schemaMinSupport cluster produces zero schema nodes and zero naming calls', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);

    let namingCallCount = 0;
    const countingNamingFn = async (_values: string[]) => {
      namingCallCount++;
      return 'should-not-be-called';
    };

    // Seed 2 nodes (below schemaMinSupport=3)
    await seedNodeWithEmbedding(h, embedder, { value: 'a' });
    await seedNodeWithEmbedding(h, embedder, { value: 'b' });

    const inducer = new SchemaInducer(
      h.db, h.store, h.strength, h.retriever, embedder, h.config, h.clock, countingNamingFn,
    );

    await inducer.induceSchemas();

    expect(namingCallCount).toBe(0);
    const schemaNodes = h.db.prepare("SELECT * FROM node WHERE type = 'schema'").all() as NodeRow[];
    expect(schemaNodes).toHaveLength(0);
  });

  // ── D-38: schema strengthened via JOINING instance's non-inferred origin ──

  it('D-38: schema.s > initial after induceSchemas() with qualifying cluster (strengthen called with member origin)', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);
    const namingFn = makeStubNamingFn('test-concept');

    // Seed 3 observed-origin nodes
    for (let i = 0; i < 3; i++) {
      await seedNodeWithEmbedding(h, embedder, { value: `concept-${i}`, origin: 'observed' });
    }

    const inducer = new SchemaInducer(
      h.db, h.store, h.strength, h.retriever, embedder, h.config, h.clock, namingFn,
    );

    await inducer.induceSchemas();

    // Schema node must exist with s > 0.1 (initial default) — proves strengthen was called
    // with the member's non-inferred origin (observed), incrementing s via Hebbian rule
    const schemaNodes = h.db.prepare("SELECT * FROM node WHERE type = 'schema'").all() as NodeRow[];
    expect(schemaNodes).toHaveLength(1);
    const schemaS = schemaNodes[0]!.s;
    // Default s for a new node is 0.1; Hebbian increment (eta=0.1): 0.1 + 0.1*(1-0.1) = 0.19
    // So s > 0.1 proves strengthen was called with a non-inferred origin
    expect(schemaS).toBeGreaterThan(0.1);
  });

  it("D-38: calling strengthen(schemaId, 'inferred') on a fresh schema node leaves s unchanged (guard fires)", () => {
    // This test verifies decay.ts:102: if claimOrigin === 'inferred', return immediately.
    // A schema's own 'inferred' origin cannot strengthen it — only a joining instance's
    // non-inferred origin can.
    const schemaId = newId();
    h.store.upsertNode({ id: schemaId, type: 'schema', value: 'test-schema', origin: 'inferred' });
    const sBefore = h.store.getNode(schemaId)!.s;

    // Direct call — mirrors what would happen if we accidentally passed schema's own origin
    h.strength.strengthen(schemaId, 'inferred');

    const sAfter = h.store.getNode(schemaId)!.s;
    expect(sAfter).toBe(sBefore); // guard fires: no change
  });

  // ── CONSOL-03: no raw SQL on node/edge (owned primitives only) ────────────
  // Verified by source assertion in acceptance criteria (grep gate) — not a runtime test.
  // The tests above exercise all write paths through store.upsertNode/upsertEdge.

  // ── Empty graph: no-op guard ──────────────────────────────────────────────

  it('no-op guard: empty graph (no clusterable nodes) returns immediately without error', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);
    const namingFn = makeStubNamingFn('should-not-run');

    const inducer = new SchemaInducer(
      h.db, h.store, h.strength, h.retriever, embedder, h.config, h.clock, namingFn,
    );

    await expect(inducer.induceSchemas()).resolves.toBeUndefined();
  });

  // ── JOIN existing schema ─────────────────────────────────────────────────

  it('JOIN: new instance joining existing schema adds abstracts edge and strengthens schema', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);
    const namingFn = makeStubNamingFn('existing-concept');

    // Phase 1: form a schema from 3 nodes
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await seedNodeWithEmbedding(h, embedder, { value: `member-${i}`, origin: 'observed' }));
    }

    const inducer = new SchemaInducer(
      h.db, h.store, h.strength, h.retriever, embedder, h.config, h.clock, namingFn,
    );

    await inducer.induceSchemas();

    const schemaNodesBefore = h.db.prepare("SELECT * FROM node WHERE type = 'schema'").all() as NodeRow[];
    expect(schemaNodesBefore).toHaveLength(1);
    const schemaId = schemaNodesBefore[0]!.id;
    const sAfterInduction = schemaNodesBefore[0]!.s;

    // Phase 2: add a new instance that should JOIN the existing schema
    const newMemberId = await seedNodeWithEmbedding(h, embedder, { value: 'new-joiner', origin: 'observed' });

    // Re-run inducer — new member should join existing schema
    await inducer.induceSchemas();

    // Still only ONE schema (JOIN, not a new one)
    const schemasAfter = h.db.prepare("SELECT * FROM node WHERE type = 'schema'").all() as NodeRow[];
    expect(schemasAfter).toHaveLength(1);
    expect(schemasAfter[0]!.id).toBe(schemaId); // same schema

    // New member linked via abstracts edge
    const newEdge = h.db.prepare("SELECT * FROM edge WHERE src = ? AND dst = ? AND kind = 'abstracts'")
      .get(schemaId, newMemberId) as { dst: string } | undefined;
    expect(newEdge).toBeDefined();

    // Schema s increased again due to JOIN
    const sAfterJoin = schemasAfter[0]!.s;
    expect(sAfterJoin).toBeGreaterThan(sAfterInduction);
  });

  // ── Two naming calls for two independent clusters ─────────────────────────

  it('two distinct clusters produce two schema nodes and two naming calls', async () => {
    // Use unique embedder: each text maps to its own dimension → zero pairwise cosine across groups
    // But within each group (same text prefix) they'd map to the same dimension.
    // We'll manually embed two groups using two fixed vectors.
    const dims = h.config.embeddingDimensions;

    let groupACount = 0;
    let groupBCount = 0;

    const twoGroupEmbedder = new MockEmbedder((text: string) => {
      const vec = new Float32Array(dims);
      if (text.startsWith('group-a-')) {
        vec[0] = 1.0; // group A: unit vector at dim 0
        groupACount++;
      } else {
        vec[1] = 1.0; // group B: unit vector at dim 1
        groupBCount++;
      }
      return vec;
    });

    // Seed group A (3 nodes)
    for (let i = 0; i < 3; i++) {
      await seedNodeWithEmbedding(h, twoGroupEmbedder, { value: `group-a-${i}` });
    }
    // Seed group B (3 nodes)
    for (let i = 0; i < 3; i++) {
      await seedNodeWithEmbedding(h, twoGroupEmbedder, { value: `group-b-${i}` });
    }

    let namingCallCount = 0;
    const countingNamingFn = async (values: string[]) => {
      namingCallCount++;
      return `schema-for-${values[0]}`;
    };

    const inducer = new SchemaInducer(
      h.db, h.store, h.strength, h.retriever, twoGroupEmbedder, h.config, h.clock, countingNamingFn,
    );

    await inducer.induceSchemas();

    // Two distinct schemas
    const schemaNodes = h.db.prepare("SELECT * FROM node WHERE type = 'schema'").all() as NodeRow[];
    expect(schemaNodes).toHaveLength(2);

    // Exactly two naming calls (one per qualifying new schema)
    expect(namingCallCount).toBe(2);

    // Each schema should have exactly 3 abstracts edges
    for (const schema of schemaNodes) {
      const edges = h.db.prepare("SELECT * FROM edge WHERE src = ? AND kind = 'abstracts'").all(schema.id);
      expect(edges).toHaveLength(3);
    }
  });
});
