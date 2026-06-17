/**
 * Behavioral tests for SchemaRelationDeriver (offline schema-relation derivation, SREL-01/02).
 *
 * Harness mirrors tests/schema-induction.test.ts: in-memory Database, initSchema,
 * FakeClock, DEFAULT_CONFIG, MockEmbedder, no network.
 *
 * Coverage:
 *   SREL-01  — two schemas with similar centroids → schema_rel edge with cosine as weight
 *   SREL-02  — cluster of ≥2 similar schemas → super-schema node + abstracts child edges (D-03)
 *   D-01     — schemas below threshold produce no schema_rel edge
 *   D-03     — super-schema-as-schema exclusion: super-schemas never re-clustered as leaf members
 *   D-04     — deriveSchemaRelations() twice produces identical schema_rel edge set + super-schema set
 *   D-37     — inferred-origin nodes NEVER contribute signal to schema_rel derivation
 *   FK-01    — deriveSchemaRelations() does NOT throw when a kind='relation' edge (e.g. extends)
 *              survives from a prior pass with src=super::… (regression for FK crash)
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
import { MockModelProvider } from '../src/model/provider';
import type { EdgeRow, NodeRow } from '../src/lib/types';
import { SchemaRelationDeriver } from '../src/consolidation/schema-relations';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { newId } from '../src/lib/hash';

// ---------------------------------------------------------------------------
// Helpers (mirror schema-induction.test.ts patterns)
// ---------------------------------------------------------------------------

/** Returns a unit vector in dimension 0 — all embeddings share cosine 1.0. */
function makeSameClusterEmbedder(dims: number): MockEmbedder {
  return new MockEmbedder((_text: string) => {
    const vec = new Float32Array(dims);
    vec[0] = 1.0;
    return vec;
  });
}

/**
 * Orthogonal-embedder: dim 0 for group A, dim 1 for group B.
 * Within-group cosine = 1.0; cross-group cosine = 0.0.
 */
function makeGroupedEmbedder(dims: number, group: 'A' | 'B'): MockEmbedder {
  const idx = group === 'A' ? 0 : 1;
  return new MockEmbedder((_text: string) => {
    const vec = new Float32Array(dims);
    vec[idx] = 1.0;
    return vec;
  });
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
    // Low threshold so test schemas relate (D-01 tests override this)
    schemaRelSimilarityThreshold: 0.5,
    ...configOverrides,
  };
  const store = new SemanticStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, store, strength, retriever, config };
}

/**
 * Seed a fact/entity node with an embedding; return its id.
 * Mirrors seedNodeWithEmbedding in schema-induction.test.ts.
 */
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

/** Create a schema node and wire members via abstracts edges. */
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

/** Return all schema_rel edges from the database. */
function getSchemaRelEdges(h: Harness): EdgeRow[] {
  return h.db.prepare("SELECT * FROM edge WHERE kind = 'schema_rel'").all() as EdgeRow[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SchemaRelationDeriver', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  // ── SREL-01: two schemas with similar centroids → schema_rel edge ─────────

  it('SREL-01: two schemas with cosine >= threshold → one schema_rel edge with cosine as weight', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);

    // Seed 3 observed members for schema A (all same direction)
    const memberAIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberAIds.push(await seedNodeWithEmbedding(h, embedder, { value: `a-fact-${i}` }));
    }
    // Seed 3 observed members for schema B (same direction → centroids cosine = 1.0)
    const memberBIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberBIds.push(await seedNodeWithEmbedding(h, embedder, { value: `b-fact-${i}` }));
    }

    const schemaA = createSchema(h, memberAIds);
    const schemaB = createSchema(h, memberBIds);

    const deriver = new SchemaRelationDeriver(h.db, h.store, h.config, h.clock);
    await deriver.deriveSchemaRelations();

    const relEdges = getSchemaRelEdges(h);
    expect(relEdges).toHaveLength(1);
    const edge = relEdges[0]!;
    // Edge connects the two schemas (either direction)
    const endpoints = new Set([edge.src, edge.dst]);
    expect(endpoints.has(schemaA)).toBe(true);
    expect(endpoints.has(schemaB)).toBe(true);
    // Weight is centroid cosine (1.0 for identical centroids)
    expect(edge.w).toBeCloseTo(1.0, 4);
    expect(edge.kind).toBe('schema_rel');
    expect(edge.rel).toBe('schema_rel');
  });

  // ── D-01: schemas below threshold → no schema_rel edge ───────────────────

  it('D-01: two schemas with centroid cosine < threshold → no schema_rel edge', async () => {
    const dims = h.config.embeddingDimensions;
    const embedderA = makeGroupedEmbedder(dims, 'A');
    const embedderB = makeGroupedEmbedder(dims, 'B');

    // Members of A in dim 0, members of B in dim 1 → cosine = 0.0 < threshold 0.5
    const memberAIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberAIds.push(await seedNodeWithEmbedding(h, embedderA, { value: `a-orthogonal-${i}` }));
    }
    const memberBIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberBIds.push(await seedNodeWithEmbedding(h, embedderB, { value: `b-orthogonal-${i}` }));
    }

    createSchema(h, memberAIds);
    createSchema(h, memberBIds);

    // Override to high threshold
    h = makeHarness({ schemaRelSimilarityThreshold: 0.9 });
    // Re-seed into the new harness
    const memberCIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberCIds.push(await seedNodeWithEmbedding(h, makeGroupedEmbedder(h.config.embeddingDimensions, 'A'), { value: `c-${i}` }));
    }
    const memberDIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberDIds.push(await seedNodeWithEmbedding(h, makeGroupedEmbedder(h.config.embeddingDimensions, 'B'), { value: `d-${i}` }));
    }
    createSchema(h, memberCIds);
    createSchema(h, memberDIds);

    const deriver = new SchemaRelationDeriver(h.db, h.store, h.config, h.clock);
    await deriver.deriveSchemaRelations();

    expect(getSchemaRelEdges(h)).toHaveLength(0);
  });

  // ── D-04: wipe-then-rebuild idempotency ──────────────────────────────────

  it('D-04: running deriveSchemaRelations() twice produces an identical schema_rel edge set', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);

    const memberAIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberAIds.push(await seedNodeWithEmbedding(h, embedder, { value: `idem-a-${i}` }));
    }
    const memberBIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberBIds.push(await seedNodeWithEmbedding(h, embedder, { value: `idem-b-${i}` }));
    }

    const schemaA = createSchema(h, memberAIds);
    const schemaB = createSchema(h, memberBIds);

    const deriver = new SchemaRelationDeriver(h.db, h.store, h.config, h.clock);

    await deriver.deriveSchemaRelations();
    const firstRun = getSchemaRelEdges(h).map(e => `${e.src}|${e.dst}|${e.w}`).sort();

    await deriver.deriveSchemaRelations();
    const secondRun = getSchemaRelEdges(h).map(e => `${e.src}|${e.dst}|${e.w}`).sort();

    expect(secondRun).toEqual(firstRun);
    // Sanity: the schemas are connected
    const endpoints = new Set(firstRun.join('|').split('|'));
    expect(endpoints.has(schemaA)).toBe(true);
    expect(endpoints.has(schemaB)).toBe(true);
  });

  // ── D-37 sentinel: inferred-origin members contribute ZERO signal ─────────

  it('D-37: inferred-origin node injected as schema member contributes zero schema_rel signal', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);

    // Schema X: 3 observed members (would relate to schema Y by centroid similarity)
    const memberXIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberXIds.push(await seedNodeWithEmbedding(h, embedder, { value: `x-obs-${i}` }));
    }

    // Schema Y: 2 observed + 1 inferred member (same direction)
    const memberYObsIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      memberYObsIds.push(await seedNodeWithEmbedding(h, embedder, { value: `y-obs-${i}` }));
    }
    const inferredId = await seedNodeWithEmbedding(h, embedder, { value: 'inferred-member', origin: 'inferred' });

    createSchema(h, memberXIds);
    // Schema Y members include the inferred node via the abstracts edge
    const schemaY = createSchema(h, [...memberYObsIds, inferredId]);

    const deriver = new SchemaRelationDeriver(h.db, h.store, h.config, h.clock);
    await deriver.deriveSchemaRelations();

    // The inferred node must not be an endpoint of any schema_rel edge
    const inferredEdges = h.db
      .prepare("SELECT * FROM edge WHERE kind = 'schema_rel' AND (src = ? OR dst = ?)")
      .all(inferredId, inferredId) as EdgeRow[];
    expect(inferredEdges).toHaveLength(0);

    // The inferred node must not appear as a schema_rel src/dst via schemaY either
    // (schemaY's centroid recomputed from observed-only: still relates to schemaX)
    const schemaYRelEdges = h.db
      .prepare("SELECT * FROM edge WHERE kind = 'schema_rel' AND (src = ? OR dst = ?)")
      .all(schemaY, schemaY) as EdgeRow[];
    // schemaY centroid is valid (2 observed members) → it DOES relate to schemaX
    expect(schemaYRelEdges).toHaveLength(1);

    // D-37 strictest check: the centroid for schema Y was NOT polluted by inferred member
    // → w should still be ~1.0 (identical unit vectors from observed members only)
    expect(schemaYRelEdges[0]!.w).toBeCloseTo(1.0, 4);
  });

  // ── D-37: schemas with NO observed members are skipped entirely ───────────

  it('D-37: schema with only inferred members produces no schema_rel edge (no valid centroid)', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);

    // Schema A: 3 observed members
    const memberAIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberAIds.push(await seedNodeWithEmbedding(h, embedder, { value: `valid-obs-${i}` }));
    }

    // Schema B: 1 inferred member only (no observed embedding to anchor the centroid)
    const inferredId = await seedNodeWithEmbedding(h, embedder, { value: 'inferred-only', origin: 'inferred' });

    createSchema(h, memberAIds);
    const schemaB = createSchema(h, [inferredId]);

    const deriver = new SchemaRelationDeriver(h.db, h.store, h.config, h.clock);
    await deriver.deriveSchemaRelations();

    // schemaB has no valid centroid → no schema_rel edges involving it
    const schemaBEdges = h.db
      .prepare("SELECT * FROM edge WHERE kind = 'schema_rel' AND (src = ? OR dst = ?)")
      .all(schemaB, schemaB) as EdgeRow[];
    expect(schemaBEdges).toHaveLength(0);
  });

  // ── SREL-02 / D-03: super-schema materialization ─────────────────────────

  it('SREL-02 / D-03: two similar schemas cluster into one super-schema node with abstracts edges; lone dissimilar schema produces none', async () => {
    const dims = h.config.embeddingDimensions;
    const dims0Embedder = makeSameClusterEmbedder(dims); // all embed at dim 0
    const dims1Embedder = new MockEmbedder((_t: string) => {
      const v = new Float32Array(dims); v[1] = 1.0; return v; // orthogonal to dim 0
    });

    // Schemas A and B: members all at dim 0 → centroids identical → will cluster (cosine 1.0)
    const memberAIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberAIds.push(await seedNodeWithEmbedding(h, dims0Embedder, { value: `super-a-${i}` }));
    }
    const memberBIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberBIds.push(await seedNodeWithEmbedding(h, dims0Embedder, { value: `super-b-${i}` }));
    }
    const schemaA = createSchema(h, memberAIds);
    const schemaB = createSchema(h, memberBIds);

    // Schema C: members at dim 1 → orthogonal centroid → will NOT cluster with A/B
    const memberCIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberCIds.push(await seedNodeWithEmbedding(h, dims1Embedder, { value: `super-c-${i}` }));
    }
    createSchema(h, memberCIds);

    const deriver = new SchemaRelationDeriver(h.db, h.store, h.config, h.clock);
    await deriver.deriveSchemaRelations();

    // Exactly one super-schema should form (from A + B cluster)
    const superSchemaNodes = h.db
      .prepare("SELECT * FROM node WHERE id LIKE 'super::%' AND type = 'schema' AND origin = 'inferred'")
      .all() as NodeRow[];
    expect(superSchemaNodes).toHaveLength(1);

    const superId = superSchemaNodes[0]!.id;

    // Super-schema must have exactly 2 abstracts edges (to schemaA and schemaB)
    const childEdges = h.db
      .prepare("SELECT * FROM edge WHERE src = ? AND kind = 'abstracts'")
      .all(superId) as EdgeRow[];
    expect(childEdges).toHaveLength(2);
    const childIds = new Set(childEdges.map(e => e.dst));
    expect(childIds.has(schemaA)).toBe(true);
    expect(childIds.has(schemaB)).toBe(true);
  });

  // ── D-04 extended idempotency: schema_rel edges AND super-schema set ──────

  it('D-04 extended: two runs produce identical schema_rel edge set AND identical super-schema node/edge set', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);

    const memberAIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberAIds.push(await seedNodeWithEmbedding(h, embedder, { value: `idem2-a-${i}` }));
    }
    const memberBIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberBIds.push(await seedNodeWithEmbedding(h, embedder, { value: `idem2-b-${i}` }));
    }
    createSchema(h, memberAIds);
    createSchema(h, memberBIds);

    const deriver = new SchemaRelationDeriver(h.db, h.store, h.config, h.clock);

    // First run
    await deriver.deriveSchemaRelations();
    const relEdges1 = getSchemaRelEdges(h).map(e => `${e.src}|${e.dst}|${e.w}`).sort();
    const superNodes1 = (h.db
      .prepare("SELECT id, value FROM node WHERE id LIKE 'super::%'")
      .all() as Array<{ id: string; value: string }>)
      .map(n => `${n.id}|${n.value}`).sort();
    const superEdges1 = (h.db
      .prepare("SELECT src, dst, kind FROM edge WHERE src LIKE 'super::%' AND kind = 'abstracts'")
      .all() as Array<{ src: string; dst: string; kind: string }>)
      .map(e => `${e.src}|${e.dst}`).sort();

    // Second run (D-04 wipe + rebuild)
    await deriver.deriveSchemaRelations();
    const relEdges2 = getSchemaRelEdges(h).map(e => `${e.src}|${e.dst}|${e.w}`).sort();
    const superNodes2 = (h.db
      .prepare("SELECT id, value FROM node WHERE id LIKE 'super::%'")
      .all() as Array<{ id: string; value: string }>)
      .map(n => `${n.id}|${n.value}`).sort();
    const superEdges2 = (h.db
      .prepare("SELECT src, dst, kind FROM edge WHERE src LIKE 'super::%' AND kind = 'abstracts'")
      .all() as Array<{ src: string; dst: string; kind: string }>)
      .map(e => `${e.src}|${e.dst}`).sort();

    expect(relEdges2).toEqual(relEdges1);
    expect(superNodes2).toEqual(superNodes1);
    expect(superEdges2).toEqual(superEdges1);
    // Sanity: something actually formed
    expect(superNodes1.length).toBe(1);
  });

  // ── FK-01 regression: kind='relation' edge on super-schema must not block node DELETE ─

  it('FK-01: deriveSchemaRelations() does not throw when a kind=relation edge has src=super-schema (FK crash regression)', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);

    // Seed two schemas that will cluster into a super-schema.
    const memberAIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberAIds.push(await seedNodeWithEmbedding(h, embedder, { value: `fk01-a-${i}` }));
    }
    const memberBIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberBIds.push(await seedNodeWithEmbedding(h, embedder, { value: `fk01-b-${i}` }));
    }
    createSchema(h, memberAIds);
    createSchema(h, memberBIds);

    // First pass: produce a super-schema node.
    const deriver = new SchemaRelationDeriver(h.db, h.store, h.config, h.clock);
    await deriver.deriveSchemaRelations();

    const superNodes = h.db
      .prepare("SELECT id FROM node WHERE id LIKE 'super::%'")
      .all() as Array<{ id: string }>;
    expect(superNodes.length).toBeGreaterThanOrEqual(1);

    const superId = superNodes[0]!.id;

    // Simulate the Phase B 'extend' path: mint a new fact node and wire a kind='relation'
    // edge from the super-schema as src (this is exactly what applyDecision 'extend' does
    // when a super-schema is retrieved as a top-k candidate in a subsequent pass).
    const extendedNodeId = newId();
    h.store.upsertNode({ id: extendedNodeId, type: 'fact', value: 'extended fact', origin: 'observed' });
    h.store.upsertEdge({ src: superId, dst: extendedNodeId, rel: 'extends', w: 0.1, kind: 'relation' });

    // Confirm the 'relation' edge exists before the second deriver run.
    const relEdgeBefore = h.db
      .prepare("SELECT * FROM edge WHERE src = ? AND kind = 'relation'")
      .all(superId) as EdgeRow[];
    expect(relEdgeBefore).toHaveLength(1);

    // Second pass: must NOT throw even though the super-schema has a kind='relation' edge.
    // Before the FK-01 fix, stmtDeleteSuperSchemaEdges filtered AND kind='abstracts' and
    // missed this edge, causing stmtDeleteSuperSchemaNodes to fail with
    // "FOREIGN KEY constraint failed".
    await expect(deriver.deriveSchemaRelations()).resolves.toBeUndefined();
  });

  // ── FK-02 regression: node_scope row on super-schema must not block node DELETE ─

  it('FK-02: deriveSchemaRelations() does not throw when a node_scope row references a super-schema (FK crash regression)', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);

    // Seed two schemas that will cluster into a super-schema.
    const memberAIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberAIds.push(await seedNodeWithEmbedding(h, embedder, { value: `fk02-a-${i}` }));
    }
    const memberBIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberBIds.push(await seedNodeWithEmbedding(h, embedder, { value: `fk02-b-${i}` }));
    }
    createSchema(h, memberAIds);
    createSchema(h, memberBIds);

    // First pass: produce a super-schema node.
    const deriver = new SchemaRelationDeriver(h.db, h.store, h.config, h.clock);
    await deriver.deriveSchemaRelations();

    const superNodes = h.db
      .prepare("SELECT id FROM node WHERE id LIKE 'super::%'")
      .all() as Array<{ id: string }>;
    expect(superNodes.length).toBeGreaterThanOrEqual(1);

    const superId = superNodes[0]!.id;

    // Simulate Phase 999.3 stampNodeScopes stamping the super-schema node: a node_scope row
    // (node_id REFERENCES node(id)) survives into the next pass. This is exactly what happens
    // in production — stampNodeScopes() writes a scope for every node with a consolidation_event,
    // and super-schemas accrue schema_falsified events, so they get stamped.
    h.store.upsertNodeScope({ node_id: superId, scope: 'global', updated_at: h.clock.nowMs() });

    const scopeBefore = h.db
      .prepare('SELECT * FROM node_scope WHERE node_id = ?')
      .all(superId);
    expect(scopeBefore).toHaveLength(1);

    // Second pass: must NOT throw even though the super-schema has a node_scope row.
    // Before the FK-02 fix the super-schema wipe cleaned only edges, so
    // stmtDeleteSuperSchemaNodes failed with "FOREIGN KEY constraint failed".
    await expect(deriver.deriveSchemaRelations()).resolves.toBeUndefined();

    // The stale scope row for the wiped super-schema id must be gone (the deriver itself
    // never re-stamps scope; only a real pass does).
    const scopeAfter = h.db
      .prepare('SELECT * FROM node_scope WHERE node_id = ?')
      .all(superId);
    expect(scopeAfter).toHaveLength(0);
  });

  // ── D-03 critical guard: super-schemas excluded from leaf re-clustering ───

  it('D-03 exclusion guard: after deriver runs, re-running induceSchemas() never adds super-schema as a leaf member', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);

    // Seed 3 facts for schema A and 3 for schema B — identical direction → cluster
    const memberAIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberAIds.push(await seedNodeWithEmbedding(h, embedder, { value: `excl-a-${i}` }));
    }
    const memberBIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberBIds.push(await seedNodeWithEmbedding(h, embedder, { value: `excl-b-${i}` }));
    }
    createSchema(h, memberAIds);
    createSchema(h, memberBIds);

    // Step 1: run deriver → super-schema materialises
    const deriver = new SchemaRelationDeriver(h.db, h.store, h.config, h.clock);
    await deriver.deriveSchemaRelations();

    const superNodes = h.db
      .prepare("SELECT id FROM node WHERE id LIKE 'super::%'")
      .all() as Array<{ id: string }>;
    expect(superNodes.length).toBeGreaterThanOrEqual(1); // sanity: at least one super-schema formed

    // Step 2: run induceSchemas() on the same DB (represents the next sleep pass)
    const inducer = new SchemaInducer(
      h.db, h.store, h.strength, h.retriever, new MockModelProvider(), h.config, h.clock,
      async (_values: string[]) => 'excl-schema',
    );
    await inducer.induceSchemas();

    // D-03 CRITICAL GUARD: no abstracts edge has a super-schema node as its dst
    // (i.e., induceSchemas() never adds a super-schema as a clusterable leaf member)
    const dangling = h.db
      .prepare(
        `SELECT * FROM edge WHERE kind = 'abstracts' AND dst LIKE 'super::%'`
      )
      .all() as EdgeRow[];
    // The only abstracts edges with 'super::' prefix on their src side should be
    // the deriver's own super-schema → child-schema edges. There must be ZERO
    // where dst LIKE 'super::%' (no leaf schema abstracts a super-schema node).
    expect(dangling).toHaveLength(0);

    // Additional check: super-schema nodes are NOT in the clusterable set
    // (i.e., no embedding was set on them by induceSchemas via reembed path)
    // The type='schema' filter structurally excludes them — verify origin stays 'inferred'
    for (const { id } of superNodes) {
      const node = h.store.getNode(id);
      expect(node).not.toBeNull();
      expect(node!.type).toBe('schema');
      expect(node!.origin).toBe('inferred');
    }
  });
});
