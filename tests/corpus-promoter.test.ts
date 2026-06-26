/**
 * corpus-promoter tests — Plan 28-03.
 *
 * Requirements covered:
 *  - CORPUS-02 (Req 2): LLM-free mass-gated promotion: gate returns ~15–60 candidates;
 *      noise filter excludes schemas with noise_frac ≥ 0.5; deterministic.
 *  - CORPUS-03 (Req 3): RETIRED here — doc_containment/doc_reference derivation moved out of
 *      CorpusPromoter to the sole-owner DocGraphDeriver (D-11, commit 9e6f309). Edge derivation
 *      coverage now lives in tests/doc-graph-deriver.test.ts.
 *  - CORPUS-05 (Req 5, D-43 BLOCKING): Self-confirmation guard — source schema s/c/incident
 *      edge weights and member set UNCHANGED after promote(); new nodes are exclusively type='doc';
 *      new edges are exclusively doc_containment/doc_reference/cites; FK-clean.
 *
 * All tests use in-memory SQLite (better-sqlite3 ':memory:').
 * No LLM calls, no embeddings beyond in-test Float32Array fixtures.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { CorpusPromoter, NoopCorpusPromoter } from '../src/consolidation/corpus-promoter';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: Database.Database; store: SemanticStore; clock: FakeClock } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const clock = new FakeClock(1000);
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: ':memory:' });
  return { db, store, clock };
}

/** Insert a live fact/entity node with an embedding so it contributes to centroids. */
function seedNode(
  store: SemanticStore,
  id: string,
  value: string,
  type: 'fact' | 'entity',
  embedding: number[],
): void {
  store.upsertNode({ id, type, value, origin: 'observed', s: 0.5, c: 0.8, last_access: 500 });
  // Set embedding via store (the only setter — STORE-01). setEmbedding takes Float32Array.
  store.setEmbedding(id, new Float32Array(embedding));
}

/** Insert a schema node (no embedding — schemas are structural, not embedded). */
function seedSchema(store: SemanticStore, id: string, value: string): void {
  store.upsertNode({ id, type: 'schema', value, origin: 'observed', s: 0.3, c: 0.6, last_access: 400 });
}

/** Create an 'abstracts' edge from a schema to a fact/entity. */
function abstracts(db: Database.Database, schemaId: string, memberId: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO edge (src, dst, rel, w, last_access, kind) VALUES (?, ?, 'abstracts', 0.8, 400, 'abstracts')",
  ).run(schemaId, memberId);
}

/** Helper: get the DEFAULT corpus promoter opts (matching run-sleep-pass constants). */
function defaultOpts() {
  return {
    highMass: 10,
    lowMass: 7,
    noiseCap: 0.5,
    corpusCosineThreshold: 0.80,
    massGapMin: 2,
    minMembers: 4,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * buildLiveShapedBrain: seeds a brain with enough schema variety to exercise the gate.
 * Returns { db, store, clock, schemaIds }.
 *
 * - 3 "content" schemas each with HIGH_MASS (≥10) clean members → should be promoted
 * - 1 "mid" schema with mass in [7,9] → promoted only via hysteresis (existing doc)
 * - 1 "low" schema with mass < 7 → never promoted; tombstones its doc stub
 * - 1 "noise" schema with mass ≥ 10 but noise_frac ≥ 0.5 → filtered out
 *
 * To get corpus edges, the three content schemas are given embeddings that make two of them
 * cosine-similar (>= corpusCosineThreshold=0.80) with a mass gap ≥ massGapMin=2.
 */
function buildLiveShapedBrain() {
  const { db, store, clock } = makeDb();

  // ── Content schema A: mass=12, embedding cluster α ──────────────────────
  // 12 clean fact members
  const schemaA = 'schema-alpha-0000-0000-0000-000000000000';
  seedSchema(store, schemaA, 'Tonos Athlete Performance Analytics');

  // Embedding: [1,0,0,0] cluster → we add slight variation
  const membersA: string[] = [];
  for (let i = 0; i < 12; i++) {
    const id = `fact-a-${i}-000000000000000000000000000000`;
    seedNode(store, id, `Tonos athlete metric fact ${i}`, 'fact', [0.9 + i * 0.005, 0.1, 0.0, 0.0]);
    abstracts(db, schemaA, id);
    membersA.push(id);
  }

  // ── Content schema B: mass=10, embedding cluster α (similar to A) ────────
  const schemaB = 'schema-beta-0000-0000-0000-000000000000';
  seedSchema(store, schemaB, 'VTX Athlete Training Protocols');

  for (let i = 0; i < 10; i++) {
    const id = `fact-b-${i}-000000000000000000000000000000`;
    seedNode(store, id, `VTX training protocol fact ${i}`, 'fact', [0.88 + i * 0.005, 0.12, 0.0, 0.0]);
    abstracts(db, schemaB, id);
  }

  // ── Content schema C: mass=15, embedding cluster β (distant from A/B) ───
  const schemaC = 'schema-gamma-000-0000-0000-000000000000';
  seedSchema(store, schemaC, 'GSD Phase Execution Plans');

  for (let i = 0; i < 15; i++) {
    const id = `fact-c-${i}-000000000000000000000000000000`;
    seedNode(store, id, `GSD phase execution fact ${i}`, 'fact', [0.0, 0.0, 0.9 + i * 0.004, 0.1]);
    abstracts(db, schemaC, id);
  }

  // ── Mid schema: mass=8 (in hysteresis band [7,9]) ────────────────────────
  const schemaMid = 'schema-mid-00000-0000-0000-000000000000';
  seedSchema(store, schemaMid, 'DeepSeek Documentation Sources');

  for (let i = 0; i < 8; i++) {
    const id = `fact-m-${i}-000000000000000000000000000000`;
    seedNode(store, id, `DeepSeek doc source fact ${i}`, 'fact', [0.0, 0.9, 0.0, 0.0]);
    abstracts(db, schemaMid, id);
  }

  // ── Low schema: mass=4 (below LOW_MASS=7) ───────────────────────────────
  const schemaLow = 'schema-low-00000-0000-0000-000000000000';
  seedSchema(store, schemaLow, 'Brain Memory Configuration');

  for (let i = 0; i < 4; i++) {
    const id = `fact-l-${i}-000000000000000000000000000000`;
    seedNode(store, id, `Brain memory config fact ${i}`, 'fact', [0.5, 0.5, 0.0, 0.0]);
    abstracts(db, schemaLow, id);
  }

  // ── Noise schema: mass=11 but noise_frac ≥ 0.5 ───────────────────────────
  const schemaNoise = 'schema-noise-000-0000-0000-000000000000';
  seedSchema(store, schemaNoise, 'Output File Paths');
  // 11 members: 7 file paths (noise) + 4 clean → noise_frac = 7/11 ≈ 0.636 ≥ 0.5
  const noiseValues = [
    '/private/tmp/output.txt',
    '/Users/vtx/brain-memory/dist/corpus-promoter.js',
    '/tmp/recense-test.log',
    'toolu_01A2B3C4D5',
    'Commit abc1234def5',
    '/Users/vtx/.claude/worktrees/agent1',
    '.claude/worktrees/session-abc',
    'Legit fact about file paths design',
    'Another legit insight',
    'Third legit content fact',
    'Fourth clean member',
  ];
  for (let i = 0; i < noiseValues.length; i++) {
    const id = `node-n-${i}-000000000000000000000000000000`;
    seedNode(store, id, noiseValues[i]!, 'fact', [0.3, 0.3, 0.3, 0.1]);
    abstracts(db, schemaNoise, id);
  }

  return {
    db,
    store,
    clock,
    schemas: { schemaA, schemaB, schemaC, schemaMid, schemaLow, schemaNoise },
  };
}

// ---------------------------------------------------------------------------
// CORPUS-02: mass gate + noise filter
// ---------------------------------------------------------------------------

describe('CorpusPromoter — CORPUS-02: mass gate + noise filter', () => {

  it('gate returns the correct schema candidates based on mass and noise filter', async () => {
    const { db, store, clock, schemas } = buildLiveShapedBrain();
    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());
    const result = await promoter.promote();

    // schemaA (mass=12), schemaB (mass=10), schemaC (mass=15) → promoted (mass >= HIGH_MASS=10, noise < 0.5)
    expect(result.promoted).toContain(schemas.schemaA);
    expect(result.promoted).toContain(schemas.schemaB);
    expect(result.promoted).toContain(schemas.schemaC);

    // schemaNoise (mass=11, noise_frac ≈ 0.636) → filtered out
    expect(result.promoted).not.toContain(schemas.schemaNoise);

    // schemaMid (mass=8, no existing doc) → not promoted (below HIGH_MASS, no doc stub)
    expect(result.promoted).not.toContain(schemas.schemaMid);

    // schemaLow (mass=4) → never promoted
    expect(result.promoted).not.toContain(schemas.schemaLow);
  });

  it('D-37 firewall (CR-01): inferred members do not count toward mass', async () => {
    const { db, store, clock } = buildLiveShapedBrain();
    // A schema whose only real (observed) evidence is below LOW_MASS=7, but which has
    // enough INFERRED members to cross HIGH_MASS=10 if they were (wrongly) counted.
    const schemaInferred = 'schema-inferred-mass';
    seedSchema(store, schemaInferred, 'Inferred-mass schema');
    // 6 observed members → real mass 6 (< LOW_MASS) → must never promote.
    for (let i = 0; i < 6; i++) {
      const id = `obs-${i}`;
      store.upsertNode({ id, type: 'fact', value: `observed fact ${i}`, origin: 'observed', s: 0.5, c: 0.8, last_access: 500 });
      abstracts(db, schemaInferred, id);
    }
    // 8 inferred members → would lift mass to 14 (≥ HIGH_MASS) if the firewall were missing.
    for (let i = 0; i < 8; i++) {
      const id = `inf-${i}`;
      store.upsertNode({ id, type: 'fact', value: `inferred fact ${i}`, origin: 'inferred', s: 0.5, c: 0.8, last_access: 500 });
      abstracts(db, schemaInferred, id);
    }

    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());
    const result = await promoter.promote();

    // Inferred output must not launder a sub-threshold schema over the promotion gate.
    expect(result.promoted).not.toContain(schemaInferred);
  });

  it('gate is deterministic: two promote() calls on the same DB produce identical candidate sets', async () => {
    const { db, store, clock } = buildLiveShapedBrain();
    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());

    const result1 = await promoter.promote();
    const result2 = await promoter.promote();

    const sorted1 = [...result1.promoted].sort();
    const sorted2 = [...result2.promoted].sort();
    expect(sorted1).toEqual(sorted2);
  });

  it('promote() returns a summary with promoted count, containment, reference and tombstoned', async () => {
    const { db, store, clock } = buildLiveShapedBrain();
    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());
    const result = await promoter.promote();

    expect(typeof result.promoted.length).toBe('number');
    expect(typeof result.containment).toBe('number');
    expect(typeof result.reference).toBe('number');
    expect(typeof result.tombstoned).toBe('number');
    expect(result.promoted.length).toBeGreaterThan(0);
  });

  it('noise filter excludes schemas where noise_frac >= 0.5 (path/tool/commit members)', async () => {
    const { db, store, clock, schemas } = buildLiveShapedBrain();
    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());
    const result = await promoter.promote();
    expect(result.promoted).not.toContain(schemas.schemaNoise);
  });

  it('noise filter PASSES schemas with noise_frac < 0.5', async () => {
    const { db, store, clock } = makeDb();
    // Schema with 3 clean + 1 noise (noise_frac=0.25 < 0.5) and mass=12
    const schemaId = 'schema-mix-00000-0000-0000-000000000000';
    seedSchema(store, schemaId, 'VTX Slot Projects');

    const mixValues = [
      'VTX athlete slot project alpha',
      'VTX backend slot 2 configuration',
      'VTX frontend component design',
      '/private/tmp/log.txt',   // 1 noise
    ];
    // Add more clean members to reach mass=12 (need >= 10)
    for (let i = 0; i < 8; i++) {
      const id = `fact-mix-${i}-000000000000000000000000000000`;
      seedNode(store, id, `VTX clean fact ${i}`, 'entity', [0.6, 0.4, 0.0, 0.0]);
      abstracts(db, schemaId, id);
    }
    for (let i = 0; i < mixValues.length; i++) {
      const id = `node-mix-${i}-000000000000000000000000000000`;
      seedNode(store, id, mixValues[i]!, 'fact', [0.6, 0.4, 0.0, 0.0]);
      abstracts(db, schemaId, id);
    }
    // Total: 8 + 4 = 12 members, 1 noise → noise_frac = 1/12 ≈ 0.083 < 0.5

    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());
    const result = await promoter.promote();
    expect(result.promoted).toContain(schemaId);
  });

  it('hysteresis: schema with existing doc stub is kept above LOW_MASS even if below HIGH_MASS', async () => {
    const { db, store, clock, schemas } = buildLiveShapedBrain();

    // Manually create a doc stub for schemaMid (mass=8, which is in [LOW_MASS=7, HIGH_MASS=10))
    const existingDocId = 'doc-mid-existing-000-0000-0000-000000000000';
    store.upsertNode({
      id: existingDocId,
      type: 'doc',
      value: '',
      origin: 'inferred',
      s: 0,
      c: 1.0,
      last_access: clock.nowMs(),
    });
    store.upsertNodeDoc({ node_id: existingDocId, slug: schemas.schemaMid, generated_at: clock.nowMs(), updated_at: clock.nowMs() });
    store.upsertNodeScope({ node_id: existingDocId, scope: schemas.schemaMid, updated_at: clock.nowMs() });

    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());
    const result = await promoter.promote();

    // schemaMid should be promoted via hysteresis (mass=8 >= LOW_MASS=7, has existing doc)
    expect(result.promoted).toContain(schemas.schemaMid);
  });

  it('schema below LOW_MASS that has a doc stub gets its doc tombstoned', async () => {
    const { db, store, clock, schemas } = buildLiveShapedBrain();

    // Create a doc stub for schemaLow (mass=4 < LOW_MASS=7)
    const lowDocId = 'doc-low-existing-000-0000-0000-000000000000';
    store.upsertNode({
      id: lowDocId,
      type: 'doc',
      value: '',
      origin: 'inferred',
      s: 0,
      c: 1.0,
      last_access: clock.nowMs(),
    });
    store.upsertNodeDoc({ node_id: lowDocId, slug: schemas.schemaLow, generated_at: clock.nowMs(), updated_at: clock.nowMs() });
    store.upsertNodeScope({ node_id: lowDocId, scope: schemas.schemaLow, updated_at: clock.nowMs() });

    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());
    const result = await promoter.promote();

    // schemaLow should NOT be promoted
    expect(result.promoted).not.toContain(schemas.schemaLow);

    // The doc stub should have been tombstoned
    const docRow = db.prepare('SELECT tombstoned FROM node WHERE id = ?').get(lowDocId) as
      | { tombstoned: number }
      | undefined;
    expect(docRow).toBeDefined();
    expect(docRow!.tombstoned).toBe(1);
    expect(result.tombstoned).toBeGreaterThanOrEqual(1);
  });

  it('dryRun returns counts without writing', async () => {
    const { db, store, clock } = buildLiveShapedBrain();
    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());
    const result = await promoter.promote({ dryRun: true });

    expect(result.promoted.length).toBeGreaterThan(0);

    // No doc nodes written
    const docCount = (db.prepare("SELECT COUNT(*) as n FROM node WHERE type = 'doc'").get() as { n: number }).n;
    expect(docCount).toBe(0);

    // No corpus edges written
    const edgeCount = (db.prepare("SELECT COUNT(*) as n FROM edge WHERE kind IN ('doc_containment', 'doc_reference')").get() as { n: number }).n;
    expect(edgeCount).toBe(0);
  });

});

// ---------------------------------------------------------------------------
// CORPUS-05: self-confirmation guard (D-43, BLOCKING)
// ---------------------------------------------------------------------------

describe('CorpusPromoter — CORPUS-05: self-confirmation guard (D-43)', () => {

  /**
   * Snapshot every source schema's s, c, incident edge weights (both directions),
   * and its abstracts member set. Run promote(). Re-snapshot and assert byte-for-byte equality.
   *
   * This is the D-43 self-confirmation guard. It is BLOCKING per the plan and security domain.
   * It also asserts:
   *  (a) The only NEW nodes are type='doc'
   *  (b) The only NEW edges have kind IN {doc_containment, doc_reference, cites}
   *  (c) PRAGMA foreign_key_check is empty after promote()
   */
  it('CORPUS-05: source schema s/c/incident-edges/member-set unchanged after promote(); new nodes=doc; FK clean', async () => {
    const { db, store, clock, schemas } = buildLiveShapedBrain();
    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());

    // ── Pre-promote snapshot ────────────────────────────────────────────────
    const allSchemaIds = Object.values(schemas);

    function snapshotSchemas() {
      return allSchemaIds.map(schemaId => {
        const node = db.prepare('SELECT s, c FROM node WHERE id = ?').get(schemaId) as
          | { s: number; c: number }
          | undefined;
        const outEdges = db.prepare(
          'SELECT dst, rel, kind, w FROM edge WHERE src = ? ORDER BY dst, kind'
        ).all(schemaId) as Array<{ dst: string; rel: string; kind: string; w: number }>;
        const inEdges = db.prepare(
          'SELECT src, rel, kind, w FROM edge WHERE dst = ? ORDER BY src, kind'
        ).all(schemaId) as Array<{ src: string; rel: string; kind: string; w: number }>;
        const members = db.prepare(
          "SELECT dst FROM edge WHERE src = ? AND kind = 'abstracts' ORDER BY dst"
        ).all(schemaId) as Array<{ dst: string }>;

        return { schemaId, node, outEdges, inEdges, members };
      });
    }

    function snapshotAllNodes() {
      return (db.prepare('SELECT id, type FROM node WHERE tombstoned = 0').all() as
        Array<{ id: string; type: string }>);
    }

    function snapshotAllEdges() {
      return (db.prepare("SELECT src, dst, kind FROM edge ORDER BY src, dst, kind").all() as
        Array<{ src: string; dst: string; kind: string }>);
    }

    const schemasBefore = snapshotSchemas();
    const nodesBefore = snapshotAllNodes();
    const edgesBefore = snapshotAllEdges();

    // ── Run promote() ───────────────────────────────────────────────────────
    await promoter.promote();

    // ── Post-promote snapshot ───────────────────────────────────────────────
    const schemasAfter = snapshotSchemas();
    const nodesAfter = snapshotAllNodes();
    const edgesAfter = snapshotAllEdges();

    // (A) Source schema s/c/incident-edges/member-set UNCHANGED
    for (let i = 0; i < schemasBefore.length; i++) {
      const before = schemasBefore[i]!;
      const after = schemasAfter[i]!;

      expect(after.node?.s).toBe(before.node?.s);
      expect(after.node?.c).toBe(before.node?.c);
      expect(after.members).toEqual(before.members);
      // Incident edge weights and connections are unchanged
      expect(after.outEdges).toEqual(before.outEdges);
      expect(after.inEdges).toEqual(before.inEdges);
    }

    // (B) New nodes are exclusively type='doc'
    const nodeIdsBefore = new Set(nodesBefore.map(n => n.id));
    const newNodes = nodesAfter.filter(n => !nodeIdsBefore.has(n.id));
    for (const newNode of newNodes) {
      expect(newNode.type).toBe('doc');
    }

    // (C) New edges are exclusively doc_containment / doc_reference / cites
    const edgeKeysBefore = new Set(edgesBefore.map(e => `${e.src}|${e.dst}|${e.kind}`));
    const newEdges = edgesAfter.filter(e => !edgeKeysBefore.has(`${e.src}|${e.dst}|${e.kind}`));
    const allowedNewKinds = new Set(['doc_containment', 'doc_reference', 'cites']);
    for (const newEdge of newEdges) {
      expect(allowedNewKinds.has(newEdge.kind)).toBe(true);
    }

    // (D) PRAGMA foreign_key_check is empty
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    expect(fkViolations).toHaveLength(0);
  });

  it('promote() makes ZERO LLM calls (no model provider injected — fully SQL/JS)', async () => {
    // CorpusPromoter takes no ModelProvider — this test verifies it constructs without one
    // and completes successfully (if it called an LLM it would throw or hang in tests)
    const { db, store, clock } = buildLiveShapedBrain();

    // Construct with no model provider — if promote() tried to call an LLM it would error
    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());
    const result = await promoter.promote();

    // Success without any thrown error = no LLM call made
    expect(result.promoted.length).toBeGreaterThan(0);
  });

});

// ---------------------------------------------------------------------------
// NoopCorpusPromoter
// ---------------------------------------------------------------------------

describe('NoopCorpusPromoter', () => {
  it('NoopCorpusPromoter.promote() completes without error and returns zero counts', async () => {
    const noop = new NoopCorpusPromoter();
    const result = await noop.promote();
    expect(result.promoted).toHaveLength(0);
    expect(result.containment).toBe(0);
    expect(result.reference).toBe(0);
    expect(result.tombstoned).toBe(0);
  });
});
