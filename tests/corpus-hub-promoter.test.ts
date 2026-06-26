/**
 * corpus-hub-promoter.test.ts — Hub + subject stub tests (Plan 39.1-02, Task 3).
 *
 * Requirements covered (D-04 / D-03 / T-39.1-06 / BLOCKER-2):
 *  - After promoteSubjects, the hub doc exists with slug = scope.
 *  - hub→subject doc_containment edge derivation is now owned by DocGraphDeriver (D-11);
 *    that coverage lives in tests/doc-graph-deriver.test.ts. promoteSubjects here is asserted
 *    only for the stubs + meta it produces (the deriver's inputs).
 *  - For each created/refreshed subject, store.getMeta('subject-schema-ids:<slug>') round-trips
 *    the JSON array equal to relatedSchemaIds (BLOCKER-2 contract for Plan 03).
 *  - Every created subject stub has length(value)=0, origin='inferred', no node_fts row.
 *  - D-03 demotion: no doc stub is created with a UUID slug.
 *  - D-43: inferred members do not contribute to mass/drift counts (verifies origin firewall
 *    in the gate path, extending exhaust-gate.test.ts assertions).
 *
 * All tests use in-memory SQLite (better-sqlite3 ':memory:').
 */
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { SubjectPromoter } from '../src/consolidation/corpus-promoter';
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

function makeMockProvider(response: string): ModelProvider {
  return {
    async generate(_prompt: string, _opts?: object): Promise<string> {
      return response;
    },
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => new Float32Array(4));
    },
    async judge(_claim: string, _candidates: Array<{ id: string; value: string }>) {
      return { best_candidate_id: null, relation: 'unrelated' as const, magnitude: 0, contradicted_ids: [] };
    },
    async judgeBatch(items: Array<{ claim: string; candidates: Array<{ id: string; value: string }> }>) {
      return items.map(() => ({ best_candidate_id: null, relation: 'unrelated' as const, magnitude: 0, contradicted_ids: [] }));
    },
  };
}

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
  void db;
}

function abstracts(db: Database.Database, schemaId: string, memberId: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO edge (src, dst, rel, w, last_access, kind) VALUES (?, ?, 'abstracts', 0.8, 500, 'abstracts')",
  ).run(schemaId, memberId);
}

function seedSchema(store: SemanticStore, id: string, value: string): void {
  store.upsertNode({ id, type: 'schema', value, origin: 'observed', s: 0.3, c: 0.6, last_access: 400 });
}

function seedScopeWithSchema(
  db: Database.Database,
  store: SemanticStore,
  scope: string,
  schemaId: string,
  schemaLabel: string,
  memberCount: number,
): void {
  seedSchema(store, schemaId, schemaLabel);
  for (let i = 0; i < memberCount; i++) {
    const id = `${schemaId}-m${i}`;
    seedNode(db, store, id, `${schemaLabel} fact ${i}`, scope);
    abstracts(db, schemaId, id);
  }
}

// ---------------------------------------------------------------------------
// Hub stub: slug = scope, with doc_containment edges to subjects
// ---------------------------------------------------------------------------

describe('SubjectPromoter — hub stub (D-04)', () => {
  it('after promoteSubjects, hub doc node exists with slug = scope', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'hub-test-scope';

    seedScopeWithSchema(db, store, scope, 'schema-hub-A', 'Hub Schema A', 5);

    const provider = makeMockProvider(
      JSON.stringify([{ name: 'Hub Subject A', relatedSchemaIds: ['schema-hub-A'] }])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects(scope);

    expect(result.hubDocId).not.toBeNull();

    // Hub doc exists with slug = scope
    const hubRow = db.prepare(
      "SELECT n.id, nd.slug FROM node n JOIN node_doc nd ON nd.node_id = n.id WHERE nd.slug = ? AND n.type = 'doc' AND n.tombstoned = 0"
    ).get(scope) as { id: string; slug: string } | undefined;
    expect(hubRow).toBeDefined();
    expect(hubRow!.slug).toBe(scope);
    expect(hubRow!.id).toBe(result.hubDocId);
  });

  it('hub stub is empty (value="") and FTS-suppressed', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'hub-empty-scope';
    seedScopeWithSchema(db, store, scope, 'schema-hub-empty', 'Hub Empty Schema', 5);

    const provider = makeMockProvider(
      JSON.stringify([{ name: 'Hub Empty Subject', relatedSchemaIds: ['schema-hub-empty'] }])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects(scope);

    expect(result.hubDocId).not.toBeNull();

    // Hub stub value must be empty (fill-in-place contract — BUG-2c)
    const hubNode = db.prepare('SELECT value, origin FROM node WHERE id = ?').get(result.hubDocId!) as
      | { value: string; origin: string }
      | undefined;
    expect(hubNode).toBeDefined();
    expect(hubNode!.value).toBe('');
    expect(hubNode!.origin).toBe('inferred');

    // FTS suppressed
    const hubFts = db.prepare('SELECT node_id FROM node_fts WHERE node_id = ?').get(result.hubDocId!);
    expect(hubFts).toBeUndefined();
  });

  it('promoteSubjects is idempotent: second call does not create duplicate hub or subject stubs', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'hub-idempotent-scope';
    seedScopeWithSchema(db, store, scope, 'schema-idem', 'Idempotent Schema', 5);

    const provider = makeMockProvider(
      JSON.stringify([{ name: 'Idempotent Schema', relatedSchemaIds: ['schema-idem'] }])
    );

    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result1 = await promoter.promoteSubjects(scope);
    expect(result1.created).toBe(1);

    // Count doc nodes after first call
    const docCountAfterFirst = (db.prepare("SELECT COUNT(*) as n FROM node WHERE type='doc' AND tombstoned=0").get() as { n: number }).n;

    // Second call: subject doc exists and drift < threshold → no gate opens → no new stubs.
    // Gate stays closed because members have last_access=500 and generated_at was set to
    // clock.nowMs()=1000, so 0 members have last_access > generated_at.
    await promoter.promoteSubjects(scope);

    // No new doc stubs should be created on the second call
    const docCountAfterSecond = (db.prepare("SELECT COUNT(*) as n FROM node WHERE type='doc' AND tombstoned=0").get() as { n: number }).n;
    expect(docCountAfterSecond).toBe(docCountAfterFirst);

    // Hub doc still exists in DB after the second call (not deleted)
    const hubStillExists = db.prepare(
      "SELECT id FROM node n JOIN node_doc nd ON nd.node_id = n.id WHERE nd.slug = ? AND n.type = 'doc' AND n.tombstoned = 0"
    ).get(scope);
    expect(hubStillExists).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// subject-schema-ids meta key round-trip (BLOCKER-2)
// ---------------------------------------------------------------------------

describe('SubjectPromoter — subject-schema-ids meta round-trip (BLOCKER-2)', () => {
  it('getMeta("subject-schema-ids:<slug>") returns JSON array equal to relatedSchemaIds', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'meta-rt-scope';

    seedScopeWithSchema(db, store, scope, 'schema-rt-A', 'RT Schema A', 5);
    seedScopeWithSchema(db, store, scope, 'schema-rt-B', 'RT Schema B', 4);

    const provider = makeMockProvider(
      JSON.stringify([
        { name: 'RT Subject', relatedSchemaIds: ['schema-rt-A', 'schema-rt-B'] },
      ])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects(scope);

    const expectedSlug = `${scope}:rt-subject`;
    const metaValue = store.getMeta(`subject-schema-ids:${expectedSlug}`);
    expect(metaValue).not.toBeNull();

    const parsed = JSON.parse(metaValue!);
    expect(parsed).toEqual(expect.arrayContaining(['schema-rt-A', 'schema-rt-B']));
    expect(parsed).toHaveLength(2);
    void result;
  });

  it('meta key uses byte-identical format "subject-schema-ids:<subjectSlug>"', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'meta-format-scope';
    seedScopeWithSchema(db, store, scope, 'schema-fmt', 'Format Schema', 5);

    const provider = makeMockProvider(
      JSON.stringify([{ name: 'Format Subject', relatedSchemaIds: ['schema-fmt'] }])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    await promoter.promoteSubjects(scope);

    const subjectSlug = `${scope}:format-subject`;
    const metaKey = `subject-schema-ids:${subjectSlug}`;

    // Must be readable by the exact key Plan 03 will use
    const metaValue = store.getMeta(metaKey);
    expect(metaValue).not.toBeNull();
    expect(JSON.parse(metaValue!)).toContain('schema-fmt');
  });
});

// ---------------------------------------------------------------------------
// Subject stub invariants: value='', origin='inferred', no node_fts row
// ---------------------------------------------------------------------------

describe('SubjectPromoter — subject stub invariants', () => {
  it('every created subject stub has value="", origin="inferred", no node_fts row', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'stub-all-scope';
    seedScopeWithSchema(db, store, scope, 'schema-all', 'Stub All Schema', 5);

    const provider = makeMockProvider(
      JSON.stringify([{ name: 'Stub All Subject', relatedSchemaIds: ['schema-all'] }])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects(scope);

    expect(result.created).toBe(1);
    for (const docId of result.subjectDocIds) {
      const row = db.prepare('SELECT value, origin FROM node WHERE id = ?').get(docId) as
        | { value: string; origin: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row!.value).toBe('');      // empty stub (fill-in-place, BUG-2c)
      expect(row!.origin).toBe('inferred');

      const ftsRow = db.prepare('SELECT node_id FROM node_fts WHERE node_id = ?').get(docId);
      expect(ftsRow).toBeUndefined();  // FTS suppressed
    }
  });

  it('subject stub scope annotation is project scope (NOT schemaId) — D-03 demotion', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'demotion-scope';
    const schemaId = 'schema-demotion';
    seedScopeWithSchema(db, store, scope, schemaId, 'Demotion Schema', 5);

    const provider = makeMockProvider(
      JSON.stringify([{ name: 'Demotion Subject', relatedSchemaIds: [schemaId] }])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects(scope);

    expect(result.created).toBe(1);
    const subjectDocId = result.subjectDocIds[0]!;

    // node_scope.scope must be the PROJECT SCOPE, not the schemaId
    const scopeRow = db.prepare('SELECT scope FROM node_scope WHERE node_id = ?').get(subjectDocId) as
      | { scope: string }
      | undefined;
    expect(scopeRow).toBeDefined();
    expect(scopeRow!.scope).toBe(scope);           // project scope ✓
    expect(scopeRow!.scope).not.toBe(schemaId);    // NOT schemaId ✓
  });
});

// ---------------------------------------------------------------------------
// D-03 demotion: no UUID-slug stubs
// ---------------------------------------------------------------------------

describe('SubjectPromoter — D-03: no UUID slug stubs during promoteSubjects', () => {
  it('all doc stubs created by promoteSubjects have non-UUID slugs', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'uuid-demotion-scope';

    seedScopeWithSchema(db, store, scope, 'schema-uuid-dm', 'UUID Demotion Schema', 5);

    const provider = makeMockProvider(
      JSON.stringify([
        { name: 'Subject One', relatedSchemaIds: ['schema-uuid-dm'] },
        { name: 'Subject Two', relatedSchemaIds: ['schema-uuid-dm'] },
      ])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    await promoter.promoteSubjects(scope);

    const allDocSlugs = db.prepare(
      "SELECT nd.slug FROM node n JOIN node_doc nd ON nd.node_id = n.id WHERE n.type = 'doc'"
    ).all() as Array<{ slug: string }>;

    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const row of allDocSlugs) {
      expect(UUID_RE.test(row.slug)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// D-43 (extended from exhaust-gate): inferred members do not inflate mass/drift
// ---------------------------------------------------------------------------

describe('SubjectPromoter — D-43 (extended): inferred origin firewall in hub path', () => {
  it('hub stub is NOT created when only inferred members satisfy mass (origin firewall)', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'inferred-hub-scope';

    // Schema with 5 inferred members (would appear in scope) and 0 observed
    // → effective mass = 0 → CREATE gate never opens → no LLM call → no hub stub
    const schemaId = 'schema-inferred-hub';
    seedSchema(store, schemaId, 'Inferred Hub Schema');
    for (let i = 0; i < 5; i++) {
      const id = `inf-hub-${i}`;
      store.upsertNode({ id, type: 'fact', value: `inferred hub fact ${i}`, origin: 'inferred', s: 0.5, c: 0.8, last_access: 500 });
      store.upsertNodeScope({ node_id: id, scope, updated_at: 1000 });
      abstracts(db, schemaId, id);
    }

    const provider = makeMockProvider(
      JSON.stringify([{ name: 'Inferred Hub Subject', relatedSchemaIds: [schemaId] }])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects(scope);

    // Gate never opened → no hub stub created
    expect(result.hubDocId).toBeNull();
    expect(result.created).toBe(0);
  });
});
