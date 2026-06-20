/**
 * corpus-generator-landing tests — Plan 32-02.
 *
 * Covers the landing-doc extension to generateCorpusDocs:
 *
 *  Test 1 (landing doc generated):
 *    A landing-doc stub (type='doc', value='', node_doc.slug='usage', node_scope.scope='usage')
 *    with some node_scope='usage' facts is filled IN PLACE (same node id) with non-empty prose
 *    via the project-scope path (generateDoc); node_doc.slug stays 'usage'.
 *
 *  Test 2 (schema chapters still generated):
 *    An existing schema-anchored stub (slug = a live schema id) is still filled via
 *    generateDocForSchema in the same pass (no regression to the existing schema path).
 *
 *  Test 3 (per-doc isolation preserved):
 *    A landing stub whose generation throws does not abort the loop; the schema stub in the
 *    same batch still generates (failed count incremented for the landing stub).
 *
 * All tests use in-memory SQLite. The provider is a stub (no real LLM calls).
 * Stubs are seeded exactly as CorpusPromoter.promoteScope creates them (via store helpers).
 */
import Database from 'better-sqlite3';
import { describe, test, expect, vi } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { generateCorpusDocs } from '../src/consolidation/corpus-generator';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDb(): { db: Database.Database; store: SemanticStore } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const clock = new FakeClock(1000);
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: ':memory:' });
  return { db, store };
}

function seedFact(store: SemanticStore, id: string, scope?: string): void {
  store.upsertNode({ id, type: 'fact', value: `fact ${id}`, origin: 'observed', s: 0.5, c: 0.8, last_access: 500 });
  if (scope) {
    store.upsertNodeScope({ node_id: id, scope, updated_at: 1000 });
  }
}

function seedSchema(store: SemanticStore, id: string, label: string): void {
  store.upsertNode({ id, type: 'schema', value: label, origin: 'observed', s: 0.3, c: 0.6, last_access: 400 });
}

function abstracts(db: Database.Database, schemaId: string, memberId: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO edge (src, dst, rel, w, last_access, kind) VALUES (?, ?, 'abstracts', 0.8, 400, 'abstracts')",
  ).run(schemaId, memberId);
}

/**
 * Seed an empty corpus doc stub for a SCHEMA (as CorpusPromoter.promote() does).
 * slug = schemaId, node_scope.scope = schemaId.
 */
function seedSchemaStub(store: SemanticStore, stubId: string, schemaId: string, now = 1000): string {
  store.upsertNode({ id: stubId, type: 'doc', value: '', origin: 'inferred', s: 0, c: 1.0, last_access: now });
  store.upsertNodeDoc({ node_id: stubId, slug: schemaId, generated_at: now, updated_at: now });
  store.upsertNodeScope({ node_id: stubId, scope: schemaId, updated_at: now });
  return stubId;
}

/**
 * Seed an empty landing-doc stub for a PROJECT SCOPE (as CorpusPromoter.promoteScope() does).
 * slug = scope string, node_scope.scope = scope string.
 */
function seedLandingStub(store: SemanticStore, stubId: string, scope: string, now = 1000): string {
  store.upsertNode({ id: stubId, type: 'doc', value: '', origin: 'inferred', s: 0, c: 1.0, last_access: now });
  store.upsertNodeDoc({ node_id: stubId, slug: scope, generated_at: now, updated_at: now });
  store.upsertNodeScope({ node_id: stubId, scope, updated_at: now });
  return stubId;
}

/** Stub provider: returns canned markdown or throws based on call index. */
function makeCallOrderProvider(responses: Array<string | Error>) {
  let callCount = 0;
  return {
    generate: vi.fn(async (_prompt: string): Promise<string> => {
      const response = responses[callCount++] ?? '# Default\n\nContent.';
      if (response instanceof Error) throw response;
      return response;
    }),
    embed: undefined as never,
    judge: undefined as never,
    judgeBatch: undefined as never,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('generateCorpusDocs — landing-doc extension (Plan 32-02)', () => {

  test('Test 1: landing-doc stub filled in place via the project-scope path; slug preserved', async () => {
    const { db, store } = makeDb();

    // Seed facts tagged to 'usage'
    seedFact(store, 'fact-usage-1', 'usage');
    seedFact(store, 'fact-usage-2', 'usage');

    // Seed a landing-doc stub (slug='usage', scope='usage')
    const landingId = seedLandingStub(store, 'stub-landing-usage', 'usage');

    const provider = makeCallOrderProvider(['# Usage Overview\n\nGenerated landing doc for usage project.']);

    const result = await generateCorpusDocs(
      { db, store, provider: provider as any },
      { maxDocs: 25, now: 2000 },
    );

    // Should have generated 1 (the landing doc)
    expect(result.generated).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.deferred).toBe(0);

    // Landing stub filled IN PLACE (same node id)
    const doc = db.prepare('SELECT id, value, tombstoned FROM node WHERE id = ?').get(landingId) as
      | { id: string; value: string; tombstoned: number }
      | undefined;
    expect(doc).toBeDefined();
    expect(doc!.id).toBe(landingId);      // same id — fill in place
    expect(doc!.tombstoned).toBe(0);
    expect(doc!.value.length).toBeGreaterThan(0);
    expect(doc!.value).toContain('# Usage Overview');

    // node_doc.slug still 'usage' (not changed to a UUID)
    const nd = db.prepare('SELECT slug FROM node_doc WHERE node_id = ?').get(landingId) as
      | { slug: string }
      | undefined;
    expect(nd?.slug).toBe('usage');
  });

  test('Test 2: schema-chapter stubs still generated in the same pass (no regression)', async () => {
    const { db, store } = makeDb();

    // Seed a schema and its stub
    const schemaId = 'schema-test-0000-0000-0000-000000000001';
    seedSchema(store, schemaId, 'Test Schema Label');
    seedFact(store, 'fact-schema-1');
    abstracts(db, schemaId, 'fact-schema-1');
    const schemaStubId = seedSchemaStub(store, 'stub-schema', schemaId);

    // Seed a landing-doc stub
    const landingId = seedLandingStub(store, 'stub-landing', 'myproject');
    seedFact(store, 'fact-proj-1', 'myproject');

    // Provider returns different content per call (schema first, then landing, order may vary)
    const provider = makeCallOrderProvider([
      '# Schema Chapter\n\nSchema doc content.',
      '# Project Overview\n\nLanding doc content.',
    ]);

    const result = await generateCorpusDocs(
      { db, store, provider: provider as any },
      { maxDocs: 25, now: 2000 },
    );

    // Both generated
    expect(result.generated).toBe(2);
    expect(result.failed).toBe(0);

    // Schema stub filled
    const schemaDoc = db.prepare('SELECT value FROM node WHERE id = ?').get(schemaStubId) as { value: string };
    expect(schemaDoc.value.length).toBeGreaterThan(0);

    // Landing stub filled
    const landingDoc = db.prepare('SELECT value FROM node WHERE id = ?').get(landingId) as { value: string };
    expect(landingDoc.value.length).toBeGreaterThan(0);
  });

  test('Test 3: landing stub generation failure does not abort loop; schema stub still generated', async () => {
    const { db, store } = makeDb();

    // Seed landing-doc stub that will throw
    const landingId = seedLandingStub(store, 'stub-landing-throw', 'failscope');
    seedFact(store, 'fact-fail-1', 'failscope');

    // Seed schema stub that should succeed
    const schemaId = 'schema-iso-0000-0000-0000-000000000001';
    seedSchema(store, schemaId, 'Isolated Schema');
    seedFact(store, 'fact-iso-1');
    abstracts(db, schemaId, 'fact-iso-1');
    const schemaStubId = seedSchemaStub(store, 'stub-iso-schema', schemaId);

    // Provider: first call throws (landing doc), second succeeds (schema doc)
    // Note: ordering depends on query order — landing comes before/after schema stubs
    // We use a provider that throws on the first call to test isolation
    let callCount = 0;
    const provider = {
      generate: vi.fn(async (_prompt: string): Promise<string> => {
        callCount++;
        if (callCount === 1) {
          throw new Error('simulated LLM failure for landing doc');
        }
        return '# Schema Doc\n\nContent.';
      }),
      embed: undefined as never,
      judge: undefined as never,
      judgeBatch: undefined as never,
    };

    const logs: string[] = [];
    const result = await generateCorpusDocs(
      { db, store, provider: provider as any },
      { maxDocs: 25, log: (m) => logs.push(m), now: 2000 },
    );

    // 1 generated, 1 failed
    expect(result.generated).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.deferred).toBe(0);

    // Landing stub still empty (throw prevented writeDoc)
    const landingDoc = db.prepare('SELECT value FROM node WHERE id = ?').get(landingId) as { value: string };
    expect(landingDoc.value.trim()).toBe('');

    // Schema stub filled
    const schemaDoc = db.prepare('SELECT value FROM node WHERE id = ?').get(schemaStubId) as { value: string };
    expect(schemaDoc.value.length).toBeGreaterThan(0);

    // A failure log line should exist
    const failLine = logs.find(l => l.includes('failed'));
    expect(failLine).toBeDefined();
  });

});
