/**
 * Falsification tests for SchemaInducer (LEARN-01, D-39, ROADMAP criterion 4).
 *
 * Covers:
 *   Erosion        — schema tombstoned + abstracts edges deleted when surviving member support drops
 *   Contradiction  — schema tombstoned via consolidator contradict route + edges cleaned up
 *   Healthy control — schema with sufficient members keeps all edges
 *   Global invariant — no abstracts edge has a tombstoned src after any pass
 *
 * Harness mirrors tests/schema-induction.test.ts: in-memory Database, initSchema,
 * FakeClock, DEFAULT_CONFIG, MockEmbedder, no network.
 *
 * Threat mitigations verified:
 *   T-04-02-T  — abstracts-edge DELETE scoped to tombstoned src only (checked via SQL assertions)
 *   T-04-02-I  — global invariant assertion proves zero dangling provenance (criterion 4)
 *   T-04-02-DEL — members survive after schema tombstone (only edges deleted, not nodes)
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
import type { JudgeVerdict } from '../src/model/judge';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { Consolidator } from '../src/consolidation/consolidator';
import { MockModelProvider } from '../src/model/provider';
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

/** Stubbed naming function — no network calls. */
function makeStubNamingFn(name = 'test-schema'): (values: string[]) => Promise<string> {
  return async (_values: string[]) => name;
}

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
    schemaMinSupport: 3,
    schemaCohesionThreshold: 0.7,
    schemaJoinCentroidThreshold: 0.75,
    unrelatedSimilarityThreshold: 0.3,
    consolSkipThreshold: 0.0,  // never skip episodes in these tests
    consolSkipThresholdAssistant: 0.0,
    ...configOverrides,
  };
  const store = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, store, episodes, strength, retriever, config };
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

/**
 * Global invariant: after each induceSchemas() pass, no abstracts edge may have
 * a tombstoned src node. Asserts via direct SQL count (criterion 4).
 */
function assertNoTombstonedAbstractsSrc(db: Database.Database): void {
  const row = db.prepare(
    "SELECT count(*) as cnt FROM edge e " +
    "JOIN node n ON e.src = n.id " +
    "WHERE e.kind = 'abstracts' AND n.tombstoned = 1"
  ).get() as { cnt: number };
  expect(row.cnt).toBe(0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SchemaInducer — falsification (D-39)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  // ── D-39 erosion ──────────────────────────────────────────────────────────

  it('D-39 erosion: surviving member count drops below schemaMinSupport → schema tombstoned + zero abstracts edges', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);
    const namingFn = makeStubNamingFn('induced-schema');

    // Pass 1: seed 3 members → induceSchemas() → one schema created with 3 abstracts edges
    const memberIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberIds.push(await seedNodeWithEmbedding(h, embedder, { value: `member-${i}` }));
    }

    const inducer = new SchemaInducer(
      h.db, h.store, h.strength, h.retriever, new MockModelProvider(), h.config, h.clock, namingFn,
    );
    await inducer.induceSchemas();

    // Verify schema was created
    const schemaNodesAfterPass1 = h.db
      .prepare("SELECT id FROM node WHERE type = 'schema' AND tombstoned = 0")
      .all() as Array<{ id: string }>;
    expect(schemaNodesAfterPass1).toHaveLength(1);
    const schemaId = schemaNodesAfterPass1[0]!.id;

    // Verify 3 abstracts edges exist
    const edgesAfterPass1 = h.db
      .prepare("SELECT count(*) as cnt FROM edge WHERE src = ? AND kind = 'abstracts'")
      .get(schemaId) as { cnt: number };
    expect(edgesAfterPass1.cnt).toBe(3);

    // Tombstone 2 of the 3 members — surviving support drops to 1 (< schemaMinSupport=3)
    h.store.tombstone(memberIds[0]!);
    h.store.tombstone(memberIds[1]!);

    // Pass 2: induceSchemas() should detect erosion and tombstone the schema + clean up edges
    await inducer.induceSchemas();

    // Schema must be tombstoned
    const schemaAfterPass2 = h.store.getNode(schemaId);
    expect(schemaAfterPass2).not.toBeNull();
    expect(schemaAfterPass2!.tombstoned).toBe(1);

    // Zero abstracts edges with tombstoned schema as src (criterion 4, T-04-02-I)
    const edgesAfterPass2 = h.db
      .prepare("SELECT count(*) as cnt FROM edge WHERE src = ? AND kind = 'abstracts'")
      .get(schemaId) as { cnt: number };
    expect(edgesAfterPass2.cnt).toBe(0);

    // Members themselves must still exist (T-04-02-DEL: falsification deletes edges, not members)
    const survivingMember = h.store.getNode(memberIds[2]!);
    expect(survivingMember).not.toBeNull();
    expect(survivingMember!.tombstoned).toBe(0);

    // Global invariant: no dangling abstracts edge after the pass
    assertNoTombstonedAbstractsSrc(h.db);
  });

  // ── D-39 contradiction ────────────────────────────────────────────────────

  it('D-39 contradiction: schema tombstoned via consolidator contradict route → zero abstracts edges after the pass', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);
    const namingFn = makeStubNamingFn('induced-schema');

    // Manually create a schema node with abstracts edges to 3 member nodes.
    // We bypass induceSchemas() here to have a known schemaId for the MockJudge verdict.
    const schemaId = 'contradiction-test-schema-id';
    h.store.upsertNode({ id: schemaId, type: 'schema', value: 'test-schema', origin: 'inferred' });
    // Intentionally do NOT call setEmbedding: reembedDirty() will embed it via the same-cluster
    // embedder, making it findable by topk before the claim is evaluated.

    const memberIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const mid = await seedNodeWithEmbedding(h, embedder, { value: `contradiction-member-${i}` });
      memberIds.push(mid);
      h.store.upsertEdge({
        src: schemaId,
        dst: mid,
        rel: 'abstracts',
        w: 0.8,
        kind: 'abstracts',
        last_access: h.clock.nowMs(),
      });
    }

    // Verify 3 abstracts edges exist before the pass
    const edgesBefore = h.db
      .prepare("SELECT count(*) as cnt FROM edge WHERE src = ? AND kind = 'abstracts'")
      .get(schemaId) as { cnt: number };
    expect(edgesBefore.cnt).toBe(3);

    // Episode that will be classified as contradicting the schema.
    // Claim value differs from schema value to avoid the D-17 fast-path (exact-match → confirm).
    h.episodes.append({
      content: 'contradicting-schema-content',
      origin: 'observed',
      salience: 1.0,
      hard_keep: 1,
      role: 'user',
      session_id: 'session-contradiction',
    });

    // MockModelProvider: claim generates contradicting content, judge returns reconcile verdict.
    // For the schema node: s=0.1, c=0.5 → resistance=0.05; ratio=0.06/0.05=1.2 (reconcile band [0.8,2.0)).
    const contradictVerdict: JudgeVerdict = {
      best_candidate_id: schemaId,
      relation: 'contradict',
      magnitude: 0.06,
    };
    const consolidatorProvider = new MockModelProvider({
      embedFn: embedder.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: 'contradicting-schema-content' }])],
      judgeScript: [contradictVerdict],
    });

    const inducer = new SchemaInducer(
      h.db, h.store, h.strength, h.retriever, new MockModelProvider(), h.config, h.clock, namingFn,
    );

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever,
      consolidatorProvider, inducer, h.config, h.clock,
    );

    // consolidate() will:
    //   Phase A: reembedDirty() → embeds the schema node so topk can find it
    //   Phase B: claim classified as contradict/reconcile → store.tombstone(schemaId)
    //   Phase C: induceSchemas() → falsification stage deletes the schema's abstracts edges
    await consolidator.consolidate();

    // Schema must be tombstoned (by the consolidator's applyDecision contradict/reconcile path)
    const schemaAfter = h.store.getNode(schemaId);
    expect(schemaAfter).not.toBeNull();
    expect(schemaAfter!.tombstoned).toBe(1);

    // Zero abstracts edges with tombstoned schema as src (criterion 4)
    const edgesAfter = h.db
      .prepare("SELECT count(*) as cnt FROM edge WHERE src = ? AND kind = 'abstracts'")
      .get(schemaId) as { cnt: number };
    expect(edgesAfter.cnt).toBe(0);

    // Members must still be live (falsification deletes edges, not member nodes — T-04-02-DEL)
    for (const mid of memberIds) {
      const member = h.store.getNode(mid);
      expect(member).not.toBeNull();
      expect(member!.tombstoned).toBe(0);
    }

    // Global invariant: no dangling abstracts edge after the pass
    assertNoTombstonedAbstractsSrc(h.db);
  });

  // ── D-39 healthy control ──────────────────────────────────────────────────

  it('D-39 healthy control: schema with members >= schemaMinSupport and no contradiction keeps all abstracts edges', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);
    const namingFn = makeStubNamingFn('healthy-schema');

    // Seed 3 members and induce a schema
    const memberIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      memberIds.push(await seedNodeWithEmbedding(h, embedder, { value: `healthy-member-${i}` }));
    }

    const inducer = new SchemaInducer(
      h.db, h.store, h.strength, h.retriever, new MockModelProvider(), h.config, h.clock, namingFn,
    );
    await inducer.induceSchemas();

    const schemaNodes = h.db
      .prepare("SELECT id FROM node WHERE type = 'schema' AND tombstoned = 0")
      .all() as Array<{ id: string }>;
    expect(schemaNodes).toHaveLength(1);
    const schemaId = schemaNodes[0]!.id;

    // All 3 members survive → run another pass with NO tombstoned members
    await inducer.induceSchemas();

    // Schema must remain alive
    const schemaAfter = h.store.getNode(schemaId);
    expect(schemaAfter).not.toBeNull();
    expect(schemaAfter!.tombstoned).toBe(0);

    // All 3 abstracts edges must still exist (healthy schema keeps its edges)
    const edgeCount = h.db
      .prepare("SELECT count(*) as cnt FROM edge WHERE src = ? AND kind = 'abstracts'")
      .get(schemaId) as { cnt: number };
    expect(edgeCount.cnt).toBe(3);

    // Global invariant
    assertNoTombstonedAbstractsSrc(h.db);
  });

  // ── Global invariant via direct SQL ──────────────────────────────────────

  it('Global invariant: after each pass no abstracts edge has a tombstoned src (SQL assertion)', async () => {
    const embedder = makeSameClusterEmbedder(h.config.embeddingDimensions);

    // Seed 3 members and induce a schema
    for (let i = 0; i < 3; i++) {
      await seedNodeWithEmbedding(h, embedder, { value: `inv-member-${i}` });
    }

    const inducer = new SchemaInducer(
      h.db, h.store, h.strength, h.retriever, new MockModelProvider(), h.config, h.clock,
      makeStubNamingFn('inv-schema'),
    );

    // Pass 1: schema induced
    await inducer.induceSchemas();
    assertNoTombstonedAbstractsSrc(h.db); // invariant holds after pass 1

    // Look up the schema
    const rows = h.db
      .prepare("SELECT id FROM node WHERE type = 'schema' AND tombstoned = 0")
      .all() as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    const schemaId = rows[0]!.id;

    // Externally tombstone the schema (simulates any tombstone path — contradict or erosion)
    h.store.tombstone(schemaId);

    // Pass 2: induceSchemas() must clean up the dangling edges
    await inducer.induceSchemas();
    assertNoTombstonedAbstractsSrc(h.db); // invariant holds after pass 2 (no dangling edges)

    // Confirm schema src had its edges cleared
    const edgeCount = h.db
      .prepare("SELECT count(*) as cnt FROM edge WHERE src = ? AND kind = 'abstracts'")
      .get(schemaId) as { cnt: number };
    expect(edgeCount.cnt).toBe(0);
  });
});
