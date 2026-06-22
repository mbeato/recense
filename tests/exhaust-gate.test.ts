/**
 * exhaust-gate.test.ts — Stage-1 LLM-free gate assertions (Plan 39.1-02, Task 1).
 *
 * Requirements covered (D-05 / D-06 / T-39.1-05 / D-43):
 *  - Stage-1 gate evaluation issues ZERO provider.generate calls (D-05 LLM-free).
 *  - REFRESH gate fires when driftCount >= corpusSubjectDriftThreshold (default 3).
 *  - REFRESH gate does NOT fire when driftCount < 3.
 *  - D-43: inferred members do not contribute to mass or drift counts (D-37 firewall).
 *  - FTS suppression: newly created stubs have no node_fts row.
 *
 * All tests use in-memory SQLite (better-sqlite3 ':memory:').
 * The provider mock tracks generate() call count — asserted to be 0 in gate-only path.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { SubjectPromoter, normalizeSubjectName } from '../src/consolidation/corpus-promoter';
import type { ModelProvider } from '../src/model/provider';

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

/** A mock ModelProvider that tracks generate() calls and returns a fixed response. */
function makeMockProvider(response = '[]'): ModelProvider & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async generate(_prompt: string, _opts?: object): Promise<string> {
      callCount++;
      return response;
    },
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => new Float32Array(4));
    },
    async judge(_claim: string, _candidates: Array<{ id: string; value: string }>) {
      return { verdict: 'standalone' as const, best_candidate_id: null, contradicted_ids: [] };
    },
  };
}

/** Seed a fact/entity node with scope annotation. */
function seedNode(
  db: Database.Database,
  store: SemanticStore,
  id: string,
  value: string,
  scope: string,
  opts: { origin?: 'observed' | 'inferred'; last_access?: number } = {},
): void {
  const { origin = 'observed', last_access = 500 } = opts;
  store.upsertNode({ id, type: 'fact', value, origin, s: 0.5, c: 0.8, last_access });
  store.upsertNodeScope({ node_id: id, scope, updated_at: 1000 });
  void db; // used to insert edge in abstracts
}

/** Create an 'abstracts' edge from schema to member. */
function abstracts(db: Database.Database, schemaId: string, memberId: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO edge (src, dst, rel, w, last_access, kind) VALUES (?, ?, 'abstracts', 0.8, 500, 'abstracts')",
  ).run(schemaId, memberId);
}

/** Seed a schema node. */
function seedSchema(store: SemanticStore, id: string, value: string): void {
  store.upsertNode({ id, type: 'schema', value, origin: 'observed', s: 0.3, c: 0.6, last_access: 400 });
}

// ---------------------------------------------------------------------------
// normalizeSubjectName helper
// ---------------------------------------------------------------------------

describe('normalizeSubjectName', () => {
  it('lowercases and replaces non-alphanumeric runs with hyphens', () => {
    expect(normalizeSubjectName('Sleep Pass')).toBe('sleep-pass');
    expect(normalizeSubjectName('Config & Tuning')).toBe('config-tuning');
    expect(normalizeSubjectName('  retrieval  ')).toBe('retrieval');
    expect(normalizeSubjectName('UPPER_CASE')).toBe('upper-case');
  });

  it('trims leading and trailing hyphens', () => {
    expect(normalizeSubjectName('---hello---')).toBe('hello');
  });

  it('collapses multiple non-alphanumeric chars to a single hyphen', () => {
    expect(normalizeSubjectName('one   two   three')).toBe('one-two-three');
  });
});

// ---------------------------------------------------------------------------
// Stage-1 gate: zero LLM calls (D-05)
// ---------------------------------------------------------------------------

describe('SubjectPromoter — Stage-1 gate (D-05 LLM-free)', () => {
  it('evaluates gates with ZERO provider.generate calls when no gate is open', async () => {
    const { db, store, clock } = makeDb();
    const provider = makeMockProvider();
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);

    // Empty scope — no schemas, no members
    const result = await promoter.promoteSubjects('empty-scope');

    // No gate open → no LLM call
    expect(provider.callCount).toBe(0);
    expect(result.created).toBe(0);
    expect(result.proposed).toHaveLength(0);
  });

  it('evaluates gates with ZERO provider.generate calls when all schemas are below mass floor', async () => {
    const { db, store, clock } = makeDb();
    const provider = makeMockProvider();

    // Schema with only 3 members (below minMembers=4)
    seedSchema(store, 'schema-low', 'Low Mass Schema');
    for (let i = 0; i < 3; i++) {
      const id = `fact-low-${i}`;
      seedNode(db, store, id, `low fact ${i}`, 'test-scope');
      abstracts(db, 'schema-low', id);
    }

    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects('test-scope');

    expect(provider.callCount).toBe(0);
    expect(result.created).toBe(0);
  });

  it('GLOBAL_SCOPE guard: promoteSubjects(GLOBAL_SCOPE) returns empty without any call', async () => {
    const { db, store, clock } = makeDb();
    const provider = makeMockProvider();
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);

    const result = await promoter.promoteSubjects('global');
    expect(provider.callCount).toBe(0);
    expect(result.hubDocId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// REFRESH drift gate (D-06)
// ---------------------------------------------------------------------------

describe('SubjectPromoter — REFRESH drift gate (D-06)', () => {

  function buildScopeWithExistingSubject(
    db: Database.Database,
    store: SemanticStore,
    clock: FakeClock,
    scope: string,
    subjectSlug: string,
    membersWithLastAccess: number[], // last_access timestamps for members
  ): void {
    const schemaId = 'schema-drift-test';
    const generatedAt = 1000; // doc was generated at t=1000
    seedSchema(store, schemaId, 'Drift Test Schema');

    for (let i = 0; i < membersWithLastAccess.length; i++) {
      const id = `drift-member-${i}`;
      const la = membersWithLastAccess[i]!;
      store.upsertNode({ id, type: 'fact', value: `drift fact ${i}`, origin: 'observed', s: 0.5, c: 0.8, last_access: la });
      store.upsertNodeScope({ node_id: id, scope, updated_at: 1000 });
      abstracts(db, schemaId, id);
    }

    // Create existing subject doc stub
    const docId = `doc-existing-subject`;
    store.upsertNode({ id: docId, type: 'doc', value: '', origin: 'inferred', s: 0, c: 1.0, last_access: 1000 });
    store.upsertNodeDoc({ node_id: docId, slug: subjectSlug, generated_at: generatedAt, updated_at: 1000 });
    store.upsertNodeScope({ node_id: docId, scope, updated_at: 1000 });

    void clock;
  }

  it('REFRESH gate fires when driftCount >= corpusSubjectDriftThreshold (3)', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'refresh-scope';
    const subjectSlug = `${scope}:drift-test-schema`; // normalizeSubjectName('Drift Test Schema') = 'drift-test-schema'

    // 3 members with last_access > generatedAt (1000) → driftCount = 3 → gate fires
    buildScopeWithExistingSubject(db, store, clock, scope, subjectSlug, [2000, 2001, 2002]);

    // Mock provider returns the existing subject slug (confirmed existing)
    const provider = makeMockProvider(
      JSON.stringify([{ name: 'Drift Test Schema', relatedSchemaIds: ['schema-drift-test'] }])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects(scope);

    // Stage-2 was called (gate was open via REFRESH)
    expect(provider.callCount).toBe(1);
    // The existing subject was queued for refresh (not created anew)
    expect(result.refreshQueued).toContain(subjectSlug);
    expect(result.created).toBe(0); // no new stub — subject exists
  });

  it('REFRESH gate does NOT fire when driftCount < corpusSubjectDriftThreshold (3)', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'no-refresh-scope';
    const subjectSlug = `${scope}:drift-test-schema`;

    // 2 members with last_access > generatedAt (1000) → driftCount = 2 < 3 → gate does NOT fire
    buildScopeWithExistingSubject(db, store, clock, scope, subjectSlug, [2000, 2001]);

    const provider = makeMockProvider();
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);

    // With only the existing subject and drift < threshold, create gate is also closed
    // (subject doc already exists for this schema's slug → CREATE gate not open either)
    const result = await promoter.promoteSubjects(scope);

    // No gate open → zero provider calls
    expect(provider.callCount).toBe(0);
    expect(result.refreshQueued).toHaveLength(0);
    expect(result.created).toBe(0);
  });

  it('REFRESH gate boundary: exactly driftThreshold members fires the gate', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'boundary-scope';
    const subjectSlug = `${scope}:drift-test-schema`;

    // corpusSubjectDriftThreshold = 3; exactly 3 touched → gate fires
    buildScopeWithExistingSubject(db, store, clock, scope, subjectSlug, [2000, 2001, 2002]);

    const provider = makeMockProvider(
      JSON.stringify([{ name: 'Drift Test Schema', relatedSchemaIds: ['schema-drift-test'] }])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects(scope);

    expect(provider.callCount).toBe(1);
    expect(result.refreshQueued).toContain(subjectSlug);
  });

  it('REFRESH gate boundary: driftThreshold-1 (2) does NOT fire', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'boundary-under-scope';
    const subjectSlug = `${scope}:drift-test-schema`;

    // 2 touched (< 3) → gate does NOT fire
    buildScopeWithExistingSubject(db, store, clock, scope, subjectSlug, [2000, 2001]);

    const provider = makeMockProvider();
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects(scope);

    expect(provider.callCount).toBe(0);
    expect(result.refreshQueued).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// D-43: inferred members MUST NOT contribute to mass or drift (D-37 firewall)
// ---------------------------------------------------------------------------

describe('SubjectPromoter — D-43 self-confirmation guard (D-37 firewall)', () => {
  it('inferred members do NOT contribute to mass gate (Stage-1)', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'inferred-scope';

    // Schema with 3 observed + 6 inferred members.
    // Only observed count → real mass = 3 < minMembers=4 → CREATE gate NOT open.
    seedSchema(store, 'schema-inferred', 'Inferred Mass Schema');
    for (let i = 0; i < 3; i++) {
      const id = `obs-member-${i}`;
      store.upsertNode({ id, type: 'fact', value: `observed fact ${i}`, origin: 'observed', s: 0.5, c: 0.8, last_access: 500 });
      store.upsertNodeScope({ node_id: id, scope, updated_at: 1000 });
      abstracts(db, 'schema-inferred', id);
    }
    for (let i = 0; i < 6; i++) {
      const id = `inf-member-${i}`;
      store.upsertNode({ id, type: 'fact', value: `inferred fact ${i}`, origin: 'inferred', s: 0.5, c: 0.8, last_access: 500 });
      store.upsertNodeScope({ node_id: id, scope, updated_at: 1000 });
      abstracts(db, 'schema-inferred', id);
    }

    const provider = makeMockProvider();
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects(scope);

    // Real mass = 3 < 4 (minMembers) → gate never opens → zero LLM calls
    expect(provider.callCount).toBe(0);
    expect(result.created).toBe(0);
  });

  it('inferred members do NOT contribute to REFRESH drift count', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'drift-inferred-scope';
    const subjectSlug = `${scope}:drift-test-schema`;
    const schemaId = 'schema-drift-inferred';
    const generatedAt = 1000;

    seedSchema(store, schemaId, 'Drift Test Schema');

    // 2 observed members with last_access > generatedAt → real driftCount = 2 < 3
    for (let i = 0; i < 2; i++) {
      const id = `obs-drift-${i}`;
      store.upsertNode({ id, type: 'fact', value: `observed drift fact ${i}`, origin: 'observed', s: 0.5, c: 0.8, last_access: 2000 });
      store.upsertNodeScope({ node_id: id, scope, updated_at: 1000 });
      abstracts(db, schemaId, id);
    }
    // 5 inferred members with last_access > generatedAt → would inflate drift to 7 without firewall
    for (let i = 0; i < 5; i++) {
      const id = `inf-drift-${i}`;
      store.upsertNode({ id, type: 'fact', value: `inferred drift fact ${i}`, origin: 'inferred', s: 0.5, c: 0.8, last_access: 2000 });
      store.upsertNodeScope({ node_id: id, scope, updated_at: 1000 });
      abstracts(db, schemaId, id);
    }

    // Create existing subject doc (so CREATE gate is not open, only REFRESH relevant)
    const docId = 'doc-drift-inferred-test';
    store.upsertNode({ id: docId, type: 'doc', value: '', origin: 'inferred', s: 0, c: 1.0, last_access: 1000 });
    store.upsertNodeDoc({ node_id: docId, slug: subjectSlug, generated_at: generatedAt, updated_at: 1000 });
    store.upsertNodeScope({ node_id: docId, scope, updated_at: 1000 });

    const provider = makeMockProvider();
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);

    // Real drift = 2 (observed only) < 3 → REFRESH gate NOT open; CREATE gate NOT open (doc exists)
    const result = await promoter.promoteSubjects(scope);
    expect(provider.callCount).toBe(0);
    expect(result.refreshQueued).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FTS suppression invariant
// ---------------------------------------------------------------------------

describe('SubjectPromoter — FTS suppression', () => {
  it('newly created subject stubs have no row in node_fts', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'fts-scope';

    // Seed a schema with enough members to open the CREATE gate
    seedSchema(store, 'schema-fts', 'FTS Test Schema');
    for (let i = 0; i < 5; i++) {
      const id = `fts-fact-${i}`;
      seedNode(db, store, id, `fts fact ${i}`, scope);
      abstracts(db, 'schema-fts', id);
    }

    const provider = makeMockProvider(
      JSON.stringify([{ name: 'FTS Test Schema', relatedSchemaIds: ['schema-fts'] }])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects(scope);

    expect(result.created).toBeGreaterThan(0);

    // Verify no node_fts rows for created stubs
    for (const docId of result.subjectDocIds) {
      const ftsRow = db.prepare('SELECT node_id FROM node_fts WHERE node_id = ?').get(docId);
      expect(ftsRow).toBeUndefined();
    }
    // Hub stub also should be FTS-suppressed
    if (result.hubDocId) {
      const hubFts = db.prepare('SELECT node_id FROM node_fts WHERE node_id = ?').get(result.hubDocId);
      expect(hubFts).toBeUndefined();
    }
  });
});
