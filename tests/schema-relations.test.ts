/**
 * Behavioral tests for SchemaRelationDeriver (offline schema-relation derivation, SREL-01).
 *
 * Harness mirrors tests/schema-induction.test.ts: in-memory Database, initSchema,
 * FakeClock, DEFAULT_CONFIG, MockEmbedder, no network.
 *
 * Coverage:
 *   SREL-01  — two schemas with similar centroids → schema_rel edge with cosine as weight
 *   D-04     — deriveSchemaRelations() twice produces identical schema_rel edge set (idempotency)
 *   D-37     — inferred-origin nodes NEVER contribute signal to schema_rel derivation
 *   D-37     — zero schema_rel edges derive from inferred-origin members
 *   D-01     — schemas below threshold produce no schema_rel edge
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { MockEmbedder } from '../src/model/embedder';
import type { EdgeRow } from '../src/lib/types';
import { SchemaRelationDeriver } from '../src/consolidation/schema-relations';
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
  config: EngineConfig;
}

function makeHarness(configOverrides?: Partial<EngineConfig>): Harness {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const config: EngineConfig = {
    ...DEFAULT_CONFIG,
    dbPath: ':memory:',
    // Low threshold so test schemas relate
    schemaRelSimilarityThreshold: 0.5,
    ...configOverrides,
  };
  const store = new SemanticStore(db, clock, config);
  return { db, clock, store, config };
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
});
