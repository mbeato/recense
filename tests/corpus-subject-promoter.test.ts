/**
 * corpus-subject-promoter.test.ts — Stage-2 subject-proposal LLM call tests (Plan 39.1-02, Task 2).
 *
 * Requirements covered (D-02 / D-03 / D-05 / Pitfall 1 / Security V5):
 *  - Idempotency: when the provider returns a name normalizing to an EXISTING slug, no new stub created.
 *  - New name: when the provider returns a genuinely new name, exactly one new stub with scope:name slug.
 *  - Proposal not issued when zero gates are open (provider call count 0).
 *  - Names length-bounded (>200 chars rejected before slug construction).
 *  - Subject slugs are always scope:name format (never UUID slugs — D-03 demotion).
 *  - Prompt contains "do NOT rename" anchor instruction (idempotency guard, Pitfall 1).
 *  - relatedSchemaIds carried through to meta key (BLOCKER-2 cross-plan contract).
 *
 * All tests use in-memory SQLite (better-sqlite3 ':memory:').
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

/** Track prompt text from generate calls for assertion. */
function makeMockProvider(response: string): ModelProvider & { callCount: number; lastPrompt: string } {
  let callCount = 0;
  let lastPrompt = '';
  return {
    get callCount() { return callCount; },
    get lastPrompt() { return lastPrompt; },
    async generate(prompt: string, _opts?: object): Promise<string> {
      callCount++;
      lastPrompt = prompt;
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
  origin: 'observed' | 'inferred' = 'observed',
): void {
  store.upsertNode({ id, type: 'fact', value, origin, s: 0.5, c: 0.8, last_access: 500 });
  store.upsertNodeScope({ node_id: id, scope, updated_at: 1000 });
  void db;
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

/**
 * Seed a scope with one schema + N members (all in scope), sufficient to open CREATE gate.
 * Returns the schemaId.
 */
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
    const id = `${schemaId}-member-${i}`;
    seedNode(db, store, id, `${schemaLabel} fact ${i}`, scope);
    abstracts(db, schemaId, id);
  }
}

// ---------------------------------------------------------------------------
// D-05: proposal call not issued when no gate is open
// ---------------------------------------------------------------------------

describe('SubjectPromoter — Stage-2: proposal not issued when no gate open (D-05)', () => {
  it('provider.generate not called when no schemas qualify', async () => {
    const { db, store, clock } = makeDb();
    const provider = makeMockProvider('[]');
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);

    const result = await promoter.promoteSubjects('empty-stage2-scope');
    expect(provider.callCount).toBe(0);
    expect(result.proposed).toHaveLength(0);
    expect(result.created).toBe(0);
  });

  it('provider.generate not called when all schemas are below minMembers (4)', async () => {
    const { db, store, clock } = makeDb();
    // Schema with only 3 members → CREATE gate not open (minMembers = 4)
    seedScopeWithSchema(db, store, 'scope-below-min', 'schema-below', 'Below Min Schema', 3);

    const provider = makeMockProvider('[]');
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects('scope-below-min');
    expect(provider.callCount).toBe(0);
    expect(result.created).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Prompt content assertions (D-05 / Pitfall 1 idempotency)
// ---------------------------------------------------------------------------

describe('SubjectPromoter — Stage-2: prompt content', () => {
  it('prompt contains the "do NOT rename" anchor instruction', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'prompt-check-scope';

    // Pre-create an existing subject doc so it appears in the anchor list
    const existingSlug = `${scope}:existing-subject`;
    const existingDocId = 'doc-existing-anchor';
    store.upsertNode({ id: existingDocId, type: 'doc', value: '', origin: 'inferred', s: 0, c: 1.0, last_access: 1000 });
    store.upsertNodeDoc({ node_id: existingDocId, slug: existingSlug, generated_at: 1000, updated_at: 1000 });
    store.upsertNodeScope({ node_id: existingDocId, scope, updated_at: 1000 });

    // New schema to trigger CREATE gate
    seedScopeWithSchema(db, store, scope, 'schema-prompt', 'New Schema', 5);

    const provider = makeMockProvider(
      JSON.stringify([{ name: 'New Schema', relatedSchemaIds: ['schema-prompt'] }])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    await promoter.promoteSubjects(scope);

    expect(provider.callCount).toBe(1);
    expect(provider.lastPrompt).toContain('do NOT rename');
    expect(provider.lastPrompt).toContain('existing-subject'); // existing slug name in prompt
  });

  it('prompt lists existing subject names when present', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'prompt-existing-scope';

    // Two pre-existing subject docs
    for (const name of ['retrieval', 'sleep-pass']) {
      const slug = `${scope}:${name}`;
      const docId = `doc-${name}`;
      store.upsertNode({ id: docId, type: 'doc', value: '', origin: 'inferred', s: 0, c: 1.0, last_access: 1000 });
      store.upsertNodeDoc({ node_id: docId, slug, generated_at: 1000, updated_at: 1000 });
      store.upsertNodeScope({ node_id: docId, scope, updated_at: 1000 });
    }

    seedScopeWithSchema(db, store, scope, 'schema-new', 'New Topic Schema', 5);

    const provider = makeMockProvider(
      JSON.stringify([{ name: 'New Topic Schema', relatedSchemaIds: ['schema-new'] }])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    await promoter.promoteSubjects(scope);

    expect(provider.lastPrompt).toContain('retrieval');
    expect(provider.lastPrompt).toContain('sleep-pass');
  });
});

// ---------------------------------------------------------------------------
// Idempotency: existing slug → refresh, not create (Pitfall 1)
// ---------------------------------------------------------------------------

describe('SubjectPromoter — Stage-2: idempotency (Pitfall 1)', () => {
  it('when provider returns a name normalizing to EXISTING slug, NO new stub is created', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'idempotent-scope';

    // Pre-create subject doc with slug 'idempotent-scope:retrieval'
    const existingSlug = `${scope}:retrieval`;
    const existingDocId = 'doc-retrieval-existing';
    store.upsertNode({ id: existingDocId, type: 'doc', value: '', origin: 'inferred', s: 0, c: 1.0, last_access: 1000 });
    store.upsertNodeDoc({ node_id: existingDocId, slug: existingSlug, generated_at: 1000, updated_at: 1000 });
    store.upsertNodeScope({ node_id: existingDocId, scope, updated_at: 1000 });

    // New schema to open CREATE gate (so Stage-2 fires), but the LLM confirms existing
    seedScopeWithSchema(db, store, scope, 'schema-retrieval', 'Some New Schema', 5);

    // Provider returns "Retrieval" which normalizes to "retrieval" (the existing slug suffix)
    const provider = makeMockProvider(
      JSON.stringify([{ name: 'Retrieval', relatedSchemaIds: ['schema-retrieval'] }])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);

    const docCountBefore = (db.prepare("SELECT COUNT(*) as n FROM node WHERE type='doc' AND tombstoned=0").get() as { n: number }).n;
    const result = await promoter.promoteSubjects(scope);
    const docCountAfter = (db.prepare("SELECT COUNT(*) as n FROM node WHERE type='doc' AND tombstoned=0").get() as { n: number }).n;

    // One provider call was made (Stage-2 ran because CREATE gate was open for Some New Schema)
    expect(provider.callCount).toBe(1);

    // Existing subject was NOT re-created
    expect(result.created).toBe(0);
    expect(result.refreshQueued).toContain(existingSlug);

    // Only the hub stub was created (the subject stub was not re-created)
    // docCountBefore = 1 (existing subject); after = 2 (hub added) or same if hub existed
    expect(docCountAfter).toBeLessThanOrEqual(docCountBefore + 1); // at most hub added
  });

  it('when provider returns a genuinely new name, exactly one new stub with scope:name slug', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'new-subject-scope';

    seedScopeWithSchema(db, store, scope, 'schema-A', 'Alpha Schema', 5);

    const provider = makeMockProvider(
      JSON.stringify([{ name: 'Alpha Subject', relatedSchemaIds: ['schema-A'] }])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects(scope);

    expect(provider.callCount).toBe(1);
    expect(result.created).toBe(1);
    expect(result.subjectDocIds).toHaveLength(1);

    // Verify the stub has scope:name slug format
    const subjectDocId = result.subjectDocIds[0]!;
    const slugRow = db.prepare('SELECT slug FROM node_doc WHERE node_id = ?').get(subjectDocId) as
      | { slug: string }
      | undefined;
    expect(slugRow).toBeDefined();
    expect(slugRow!.slug).toMatch(/^new-subject-scope:/);
    expect(slugRow!.slug).toBe('new-subject-scope:alpha-subject');

    // Verify it is NOT a UUID slug (D-03 demotion)
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(UUID_RE.test(slugRow!.slug)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Security V5: name length bound (<=200 chars)
// ---------------------------------------------------------------------------

describe('SubjectPromoter — Stage-2: name length bound (Security V5)', () => {
  it('names longer than 200 chars are rejected before slug construction', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'length-bound-scope';
    seedScopeWithSchema(db, store, scope, 'schema-lb', 'Length Bound Schema', 5);

    const longName = 'A'.repeat(201); // 201 chars — exceeds bound
    const validName = 'Valid Short Name';

    const provider = makeMockProvider(
      JSON.stringify([
        { name: longName, relatedSchemaIds: ['schema-lb'] },
        { name: validName, relatedSchemaIds: ['schema-lb'] },
      ])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects(scope);

    // Only the valid name should be accepted
    expect(result.created).toBe(1);
    const slugRow = db.prepare('SELECT slug FROM node_doc WHERE node_id = ?').get(result.subjectDocIds[0]!) as
      | { slug: string }
      | undefined;
    expect(slugRow!.slug).toBe('length-bound-scope:valid-short-name');
  });

  it('exactly 200 char name is accepted', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'length-200-scope';
    seedScopeWithSchema(db, store, scope, 'schema-200', '200 Char Schema', 5);

    const exactName = 'a'.repeat(200); // exactly 200 — at the limit, should pass
    const provider = makeMockProvider(
      JSON.stringify([{ name: exactName, relatedSchemaIds: ['schema-200'] }])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects(scope);

    expect(result.created).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// D-03 demotion: no UUID-slug stubs created
// ---------------------------------------------------------------------------

describe('SubjectPromoter — D-03: no UUID slug stubs created', () => {
  it('no doc stub is created with a UUID slug during promoteSubjects', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'no-uuid-scope';

    seedScopeWithSchema(db, store, scope, 'schema-uuid-test', 'UUID Test Schema', 5);

    const provider = makeMockProvider(
      JSON.stringify([
        { name: 'UUID Test', relatedSchemaIds: ['schema-uuid-test'] },
      ])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    await promoter.promoteSubjects(scope);

    // Verify no doc node was created with a UUID-format slug
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
// relatedSchemaIds carried through (BLOCKER-2 contract for Plan 03)
// ---------------------------------------------------------------------------

describe('SubjectPromoter — relatedSchemaIds meta persistence (BLOCKER-2)', () => {
  it('subject-schema-ids:<slug> meta key is written for each created subject', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'meta-scope';

    seedScopeWithSchema(db, store, scope, 'schema-meta-A', 'Meta Schema A', 5);
    seedScopeWithSchema(db, store, scope, 'schema-meta-B', 'Meta Schema B', 4);

    const provider = makeMockProvider(
      JSON.stringify([
        { name: 'Meta Subject', relatedSchemaIds: ['schema-meta-A', 'schema-meta-B'] },
      ])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects(scope);

    expect(result.created).toBe(1);
    const expectedSlug = `${scope}:meta-subject`;

    // Verify the meta key was written
    const metaValue = store.getMeta(`subject-schema-ids:${expectedSlug}`);
    expect(metaValue).not.toBeNull();

    const parsed = JSON.parse(metaValue!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toContain('schema-meta-A');
    expect(parsed).toContain('schema-meta-B');
  });

  it('subject-schema-ids meta written for refreshed subjects too', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'refresh-meta-scope';
    const schemaId = 'schema-refresh-meta';

    // Create existing subject doc
    const existingSlug = `${scope}:refresh-meta-schema`;
    const docId = 'doc-refresh-meta';
    store.upsertNode({ id: docId, type: 'doc', value: '', origin: 'inferred', s: 0, c: 1.0, last_access: 1000 });
    store.upsertNodeDoc({ node_id: docId, slug: existingSlug, generated_at: 500, updated_at: 1000 });
    store.upsertNodeScope({ node_id: docId, scope, updated_at: 1000 });

    // Members with last_access > generated_at (500) → 3 touched → REFRESH gate fires
    seedSchema(store, schemaId, 'Refresh Meta Schema');
    for (let i = 0; i < 3; i++) {
      const id = `refresh-meta-member-${i}`;
      store.upsertNode({ id, type: 'fact', value: `refresh fact ${i}`, origin: 'observed', s: 0.5, c: 0.8, last_access: 1000 });
      store.upsertNodeScope({ node_id: id, scope, updated_at: 1000 });
      abstracts(db, schemaId, id);
    }

    const provider = makeMockProvider(
      JSON.stringify([
        { name: 'Refresh Meta Schema', relatedSchemaIds: [schemaId] },
      ])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects(scope);

    expect(result.refreshQueued).toContain(existingSlug);

    // Meta key written for refreshed subject
    const metaValue = store.getMeta(`subject-schema-ids:${existingSlug}`);
    expect(metaValue).not.toBeNull();
    const parsed = JSON.parse(metaValue!);
    expect(parsed).toContain(schemaId);
  });
});

// ---------------------------------------------------------------------------
// FTS suppression + origin='inferred' for created stubs
// ---------------------------------------------------------------------------

describe('SubjectPromoter — stub invariants', () => {
  it('every created subject stub has value="" and origin="inferred"', async () => {
    const { db, store, clock } = makeDb();
    const scope = 'stub-invariant-scope';
    seedScopeWithSchema(db, store, scope, 'schema-stub', 'Stub Schema', 5);

    const provider = makeMockProvider(
      JSON.stringify([{ name: 'Stub Subject', relatedSchemaIds: ['schema-stub'] }])
    );
    const promoter = new SubjectPromoter(db, store, clock, provider, DEFAULT_CONFIG);
    const result = await promoter.promoteSubjects(scope);

    expect(result.created).toBe(1);
    for (const docId of result.subjectDocIds) {
      const row = db.prepare('SELECT value, origin FROM node WHERE id = ?').get(docId) as
        | { value: string; origin: string }
        | undefined;
      expect(row).toBeDefined();
      expect(row!.value).toBe('');
      expect(row!.origin).toBe('inferred');
    }
  });
});
