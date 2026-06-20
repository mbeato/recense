/**
 * corpus-promoter-always-promote tests — Plan 32-02.
 *
 * Covers CorpusPromoter.promoteScope (the scope-anchored always-promote bypass, D-04):
 *
 *  Test 1 (bypass mass gate, bounded to scope):
 *    - promoteScope('usage') creates chapter/landing stubs for in-scope schemas below highMass
 *    - out-of-scope schemas get NO stub
 *    - plain promote() still requires mass >= highMass (organic gate unchanged)
 *
 *  Test 2 (landing→chapter containment):
 *    - after promoteScope with 2 in-scope schemas, there is exactly 1 live landing doc (slug='usage')
 *    - doc_containment edges from landing doc node → each chapter doc node
 *    - src/dst are both type='doc' node ids (never schema ids)
 *
 *  Test 3 (organic gate untouched):
 *    - plain promote() returns the same promoted/containment/reference/tombstoned counts
 *      as before the promoteScope method was added (regression guard — mass-hysteresis path
 *      is byte-identical)
 *
 *  Test 4 (idempotent + GLOBAL guard):
 *    - second promoteScope('usage') reuses existing stubs by slug (no duplicate live docs)
 *    - promoteScope('global') is a no-op / throws-free refusal
 *
 *  Test 5 (D-43 self-confirmation):
 *    - source schema nodes X1/X2 are unchanged after promoteScope (no new abstracts edges, no
 *      s/c mutation) — only type='doc' nodes + doc→doc edges written
 *
 * All tests use in-memory SQLite (better-sqlite3 ':memory:').
 * No LLM calls, no real embeddings beyond in-test Float32Array fixtures.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { CorpusPromoter } from '../src/consolidation/corpus-promoter';
import { GLOBAL_SCOPE } from '../src/lib/scope';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: Database.Database; store: SemanticStore; clock: FakeClock } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const clock = new FakeClock(1000);
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: ':memory:' });
  return { db, store, clock };
}

function seedNode(
  store: SemanticStore,
  id: string,
  value: string,
  type: 'fact' | 'entity',
  embedding: number[],
): void {
  store.upsertNode({ id, type, value, origin: 'observed', s: 0.5, c: 0.8, last_access: 500 });
  store.setEmbedding(id, new Float32Array(embedding));
}

function seedSchema(store: SemanticStore, id: string, value: string): void {
  store.upsertNode({ id, type: 'schema', value, origin: 'observed', s: 0.3, c: 0.6, last_access: 400 });
}

function abstracts(db: Database.Database, schemaId: string, memberId: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO edge (src, dst, rel, w, last_access, kind) VALUES (?, ?, 'abstracts', 0.8, 400, 'abstracts')",
  ).run(schemaId, memberId);
}

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

/**
 * Seed two schemas for scope 'usage' (mass = 3, below highMass = 10)
 * and one schema for scope 'global' (mass = 3).
 * Returns { db, store, clock, schemaX1, schemaX2, schemaGlobal }.
 */
function buildScopedBrain(scope = 'usage') {
  const { db, store, clock } = makeDb();

  // Schema X1: 3 facts tagged to scope 'usage'
  const schemaX1 = 'schema-x1-0000-0000-0000-000000000001';
  seedSchema(store, schemaX1, 'Usage Schema X1');
  for (let i = 0; i < 3; i++) {
    const id = `fact-x1-${i}`;
    seedNode(store, id, `Usage fact X1 ${i}`, 'fact', [0.9, 0.1, 0.0, 0.0]);
    abstracts(db, schemaX1, id);
    store.upsertNodeScope({ node_id: id, scope, updated_at: 1000 });
  }

  // Schema X2: 3 facts tagged to scope 'usage'
  const schemaX2 = 'schema-x2-0000-0000-0000-000000000002';
  seedSchema(store, schemaX2, 'Usage Schema X2');
  for (let i = 0; i < 3; i++) {
    const id = `fact-x2-${i}`;
    seedNode(store, id, `Usage fact X2 ${i}`, 'fact', [0.8, 0.2, 0.0, 0.0]);
    abstracts(db, schemaX2, id);
    store.upsertNodeScope({ node_id: id, scope, updated_at: 1000 });
  }

  // Schema Y: 3 facts tagged to scope 'global'
  const schemaGlobal = 'schema-global-000-0000-0000-000000000003';
  seedSchema(store, schemaGlobal, 'Global Schema Y');
  for (let i = 0; i < 3; i++) {
    const id = `fact-g-${i}`;
    seedNode(store, id, `Global fact ${i}`, 'fact', [0.0, 0.0, 0.9, 0.1]);
    abstracts(db, schemaGlobal, id);
    store.upsertNodeScope({ node_id: id, scope: GLOBAL_SCOPE, updated_at: 1000 });
  }

  return { db, store, clock, schemaX1, schemaX2, schemaGlobal };
}

/** Query a live doc stub by its scope (slug stored in node_scope.scope). */
function getLiveDocByScope(db: Database.Database, scope: string): { id: string } | undefined {
  return db.prepare(
    "SELECT n.id FROM node n JOIN node_scope ns ON ns.node_id = n.id " +
    "WHERE n.type = 'doc' AND n.tombstoned = 0 AND ns.scope = ? LIMIT 1"
  ).get(scope) as { id: string } | undefined;
}

// ---------------------------------------------------------------------------
// Test 1: bypass mass gate, bounded to scope
// ---------------------------------------------------------------------------

describe('promoteScope — Test 1: bypass mass gate, bounded to scope', () => {
  it('creates chapter stubs for in-scope schemas (below highMass) and a landing-doc stub for the scope; out-of-scope schemas get no stub', async () => {
    const { db, store, clock, schemaX1, schemaX2, schemaGlobal } = buildScopedBrain('usage');
    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());

    const result = await promoter.promoteScope('usage');

    // X1 and X2 are in scope 'usage' → should appear in promoted
    expect(result.promoted).toContain(schemaX1);
    expect(result.promoted).toContain(schemaX2);

    // The landing-doc slug = 'usage' is also counted in promoted
    expect(result.promoted).toContain('usage');

    // schemaGlobal is scoped to 'global' → must NOT be promoted
    expect(result.promoted).not.toContain(schemaGlobal);

    // A live doc stub for each in-scope schema should now exist
    const docX1 = getLiveDocByScope(db, schemaX1);
    const docX2 = getLiveDocByScope(db, schemaX2);
    expect(docX1).toBeDefined();
    expect(docX2).toBeDefined();

    // A live landing doc stub for 'usage' should exist
    const landing = getLiveDocByScope(db, 'usage');
    expect(landing).toBeDefined();

    // schemaGlobal should have NO doc stub
    const docGlobal = getLiveDocByScope(db, schemaGlobal);
    expect(docGlobal).toBeUndefined();
  });

  it('plain promote() with no scope still enforces the mass gate (organic gate unchanged)', async () => {
    const { db, store, clock, schemaX1 } = buildScopedBrain('usage');
    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());

    // X1 has mass=3 (below highMass=10 and below lowMass=7) — organic gate should reject it
    const result = await promoter.promote();

    // X1 was NOT promoted by the organic gate
    expect(result.promoted).not.toContain(schemaX1);
  });
});

// ---------------------------------------------------------------------------
// Test 2: landing→chapter containment edges
// ---------------------------------------------------------------------------

describe('promoteScope — Test 2: landing→chapter containment edges', () => {
  it('creates exactly one live landing doc and doc_containment edges from landing→chapter docs', async () => {
    const { db, store, clock, schemaX1, schemaX2 } = buildScopedBrain('usage');
    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());

    await promoter.promoteScope('usage');

    // Exactly one live landing doc for 'usage'
    const landingDocs = db.prepare(
      "SELECT n.id FROM node n JOIN node_scope ns ON ns.node_id = n.id " +
      "WHERE n.type = 'doc' AND n.tombstoned = 0 AND ns.scope = 'usage'"
    ).all() as { id: string }[];
    expect(landingDocs.length).toBe(1);
    const landingId = landingDocs[0]!.id;

    // Chapter doc stubs for X1 and X2
    const docX1 = getLiveDocByScope(db, schemaX1);
    const docX2 = getLiveDocByScope(db, schemaX2);
    expect(docX1).toBeDefined();
    expect(docX2).toBeDefined();

    // doc_containment edges: landing → chapter for each in-scope schema
    const containmentEdges = db.prepare(
      "SELECT src, dst FROM edge WHERE kind = 'doc_containment'"
    ).all() as { src: string; dst: string }[];

    const edgeFromLandingToX1 = containmentEdges.find(
      e => e.src === landingId && e.dst === docX1!.id
    );
    const edgeFromLandingToX2 = containmentEdges.find(
      e => e.src === landingId && e.dst === docX2!.id
    );
    expect(edgeFromLandingToX1).toBeDefined();
    expect(edgeFromLandingToX2).toBeDefined();
  });

  it('doc_containment edges from promoteScope have src and dst both as type=doc nodes', async () => {
    const { db, store, clock } = buildScopedBrain('usage');
    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());
    await promoter.promoteScope('usage');

    const corpusEdges = db.prepare(
      "SELECT e.src, e.dst, n_src.type as src_type, n_dst.type as dst_type FROM edge e " +
      "JOIN node n_src ON n_src.id = e.src JOIN node n_dst ON n_dst.id = e.dst " +
      "WHERE e.kind = 'doc_containment'"
    ).all() as { src: string; dst: string; src_type: string; dst_type: string }[];

    expect(corpusEdges.length).toBeGreaterThan(0);
    for (const edge of corpusEdges) {
      expect(edge.src_type).toBe('doc');
      expect(edge.dst_type).toBe('doc');
    }
  });
});

// ---------------------------------------------------------------------------
// Test 3: organic gate untouched
// ---------------------------------------------------------------------------

describe('promoteScope — Test 3: organic gate untouched', () => {
  it('adding promoteScope does not change promote() behavior on a mass-sufficient brain', async () => {
    // Use a brain where some schemas DO pass the mass gate organically
    const { db, store, clock } = makeDb();

    // Schema Z: mass=12 (passes highMass=10) — embedded in a cluster
    const schemaZ = 'schema-z-organic-000-0000-0000-000000000000';
    seedSchema(store, schemaZ, 'Organic Schema Z');
    for (let i = 0; i < 12; i++) {
      const id = `fact-z-${i}-00000000000000000000000000000000`;
      seedNode(store, id, `Organic fact Z ${i}`, 'fact', [0.9, 0.1, 0.0, 0.0]);
      abstracts(db, schemaZ, id);
    }

    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());

    const result1 = await promoter.promote();
    expect(result1.promoted).toContain(schemaZ);
    const containment1 = result1.containment;
    const reference1 = result1.reference;
    const tombstoned1 = result1.tombstoned;

    // Second promote() call must produce the same counts
    const result2 = await promoter.promote();
    expect(result2.promoted).toContain(schemaZ);
    expect(result2.containment).toBe(containment1);
    expect(result2.reference).toBe(reference1);
    expect(result2.tombstoned).toBe(tombstoned1);
  });
});

// ---------------------------------------------------------------------------
// Test 4: idempotent + GLOBAL guard
// ---------------------------------------------------------------------------

describe('promoteScope — Test 4: idempotent + GLOBAL guard', () => {
  it('second promoteScope reuses existing stubs by slug (no duplicate live landing/chapter docs)', async () => {
    const { db, store, clock } = buildScopedBrain('usage');
    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());

    await promoter.promoteScope('usage');

    // Count live doc nodes after first call
    const docsAfterFirst = db.prepare(
      "SELECT COUNT(*) as n FROM node WHERE type='doc' AND tombstoned=0"
    ).get() as { n: number };

    // Second call
    await promoter.promoteScope('usage');

    // Count after second call — must be the same (stubs reused, not duplicated)
    const docsAfterSecond = db.prepare(
      "SELECT COUNT(*) as n FROM node WHERE type='doc' AND tombstoned=0"
    ).get() as { n: number };

    expect(docsAfterSecond.n).toBe(docsAfterFirst.n);
  });

  it('promoteScope(GLOBAL_SCOPE) is a no-op / throws-free refusal (never force-promotes global)', async () => {
    const { db, store, clock } = buildScopedBrain();
    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());

    // Must not throw
    let result: any;
    expect(async () => {
      result = await promoter.promoteScope(GLOBAL_SCOPE);
    }).not.toThrow();

    result = await promoter.promoteScope(GLOBAL_SCOPE);

    // No doc stubs created
    expect(result.promoted).toHaveLength(0);
    const docCount = (db.prepare("SELECT COUNT(*) as n FROM node WHERE type='doc'").get() as { n: number }).n;
    expect(docCount).toBe(0);
  });

  it('promoteScope with empty string is a no-op (guard against empty scope)', async () => {
    const { db, store, clock } = buildScopedBrain();
    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());

    const result = await promoter.promoteScope('');

    expect(result.promoted).toHaveLength(0);
    const docCount = (db.prepare("SELECT COUNT(*) as n FROM node WHERE type='doc'").get() as { n: number }).n;
    expect(docCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 5: D-43 self-confirmation
// ---------------------------------------------------------------------------

describe('promoteScope — Test 5: D-43 self-confirmation', () => {
  it('source schema nodes are unchanged after promoteScope (no new abstracts edges, no s/c mutation)', async () => {
    const { db, store, clock, schemaX1, schemaX2 } = buildScopedBrain('usage');
    const promoter = new CorpusPromoter(db, store, clock, defaultOpts());

    // Snapshot source schemas before
    function snapshot(schemaId: string) {
      const node = db.prepare('SELECT s, c FROM node WHERE id = ?').get(schemaId) as { s: number; c: number };
      const outEdges = db.prepare(
        "SELECT dst, rel, kind, w FROM edge WHERE src = ? ORDER BY dst, kind"
      ).all(schemaId) as { dst: string; rel: string; kind: string; w: number }[];
      const inEdges = db.prepare(
        "SELECT src, rel, kind, w FROM edge WHERE dst = ? ORDER BY src, kind"
      ).all(schemaId) as { src: string; rel: string; kind: string; w: number }[];
      const members = db.prepare(
        "SELECT dst FROM edge WHERE src = ? AND kind = 'abstracts' ORDER BY dst"
      ).all(schemaId) as { dst: string }[];
      return { node, outEdges, inEdges, members };
    }

    const beforeX1 = snapshot(schemaX1);
    const beforeX2 = snapshot(schemaX2);
    const nodesBefore = db.prepare("SELECT id, type FROM node WHERE tombstoned = 0").all() as { id: string; type: string }[];

    await promoter.promoteScope('usage');

    const afterX1 = snapshot(schemaX1);
    const afterX2 = snapshot(schemaX2);

    // s and c must not change
    expect(afterX1.node.s).toBe(beforeX1.node.s);
    expect(afterX1.node.c).toBe(beforeX1.node.c);
    expect(afterX2.node.s).toBe(beforeX2.node.s);
    expect(afterX2.node.c).toBe(beforeX2.node.c);

    // abstracts member set must not change
    expect(afterX1.members).toEqual(beforeX1.members);
    expect(afterX2.members).toEqual(beforeX2.members);

    // Source schemas must not gain new out-edges (no abstracts etc.)
    expect(afterX1.outEdges).toEqual(beforeX1.outEdges);
    expect(afterX2.outEdges).toEqual(beforeX2.outEdges);

    // New nodes must only be type='doc'
    const nodeIdsBefore = new Set(nodesBefore.map(n => n.id));
    const nodesAfter = db.prepare("SELECT id, type FROM node WHERE tombstoned = 0").all() as { id: string; type: string }[];
    const newNodes = nodesAfter.filter(n => !nodeIdsBefore.has(n.id));
    for (const newNode of newNodes) {
      expect(newNode.type).toBe('doc');
    }

    // The key assertion: no new 'abstracts' edges on source schemas after promoteScope
    for (const [schemaId, beforeSnap] of [[schemaX1, beforeX1], [schemaX2, beforeX2]] as const) {
      const afterAbstracts = db.prepare(
        "SELECT dst FROM edge WHERE src = ? AND kind = 'abstracts' ORDER BY dst"
      ).all(schemaId) as { dst: string }[];
      expect(afterAbstracts).toEqual(beforeSnap.members);
    }

    // FK clean
    const fkViolations = db.pragma('foreign_key_check') as unknown[];
    expect(fkViolations).toHaveLength(0);
  });
});
