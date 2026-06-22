/**
 * corpus-budget-cap tests (Phase 39.1, Plan 03, Task 1).
 *
 * Covers Plan 39.1-03 behavior assertions:
 *
 *  (1) Hub dispatch (D-01/D-04 / BLOCKER-1): a bare scope slug is routed to
 *      generateDocForHub; the subjectDocs arg has length > 0 and each entry
 *      carries both a `name` and a `docId` (linked index, not bare names).
 *
 *  (2) Subject dispatch (BLOCKER-2): a 'scope:name' slug is routed to
 *      generateDocForSubject; schemaIds are rebuilt from the
 *      'subject-schema-ids:<slug>' meta key with ZERO extra provider.generate
 *      calls beyond the one for the doc itself.
 *
 *  (3) Budget cap (D-07): with maxDocs=1 and 3 empty subject stubs:
 *       - exactly 1 doc is generated
 *       - 2 'pending-subject-doc-gen:*' markers are written
 *       - a second pass (maxDocs=1) generates the next and clears one marker
 *         (self-draining queue).
 *
 *  (4) Hub vs subject dispatch: a bare-scope stub is dispatched to the hub
 *      generator; a 'scope:name' stub is dispatched to the subject generator.
 *
 * All tests use in-memory SQLite. The provider stubs are minimal — no real LLM.
 */
import Database from 'better-sqlite3';
import { describe, test, expect, vi } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { generateCorpusDocs } from '../src/consolidation/corpus-generator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: Database.Database; store: SemanticStore } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const clock = new FakeClock(1000);
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: ':memory:' });
  return { db, store };
}

/** Seed a live fact node (origin='observed', type='fact'). */
function seedFact(store: SemanticStore, id: string): void {
  store.upsertNode({
    id,
    type: 'fact',
    value: `fact text for ${id}`,
    origin: 'observed',
    s: 0.5,
    c: 0.8,
    last_access: 500,
  });
}

/** Seed a live schema node. */
function seedSchema(store: SemanticStore, id: string, label: string): void {
  store.upsertNode({
    id,
    type: 'schema',
    value: label,
    origin: 'inferred',
    s: 0,
    c: 1.0,
    last_access: 500,
  });
}

/** Create an 'abstracts' edge from schemaId → memberId. */
function abstracts(db: Database.Database, schemaId: string, memberId: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO edge (src, dst, rel, w, last_access, kind) VALUES (?, ?, 'abstracts', 0.8, 400, 'abstracts')"
  ).run(schemaId, memberId);
}

/**
 * Seed an empty doc stub (hub or subject) exactly as SubjectPromoter does:
 *   value='', origin='inferred', FTS-suppressed, node_doc sidecar, node_scope.
 * Returns the stub's node id.
 */
function seedEmptyDocStub(
  store: SemanticStore,
  db: Database.Database,
  id: string,
  slug: string,
  scope: string,
  now = 1000,
): string {
  store.upsertNode({
    id,
    type: 'doc',
    value: '',
    origin: 'inferred',
    s: 0,
    c: 1.0,
    last_access: now,
  });
  // FTS suppression (mirrors SubjectPromoter / CorpusPromoter)
  db.prepare('DELETE FROM node_fts WHERE node_id = ?').run(id);
  store.upsertNodeDoc({ node_id: id, slug, generated_at: now, updated_at: now });
  store.upsertNodeScope({ node_id: id, scope, updated_at: now });
  return id;
}

/** Write a doc_containment edge from hub → subject (as SubjectPromoter writes). */
function containmentEdge(store: SemanticStore, hubId: string, subjectId: string): void {
  store.upsertEdge({
    src: hubId,
    dst: subjectId,
    rel: 'doc_containment',
    kind: 'doc_containment',
    w: 1.0,
    last_access: 1000,
  });
}

/** Count 'pending-subject-doc-gen:*' markers in the meta table. */
function countPendingMarkers(db: Database.Database): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'pending-subject-doc-gen:%'"
  ).get() as { n: number };
  return row.n;
}

/** List all pending marker keys. */
function listPendingMarkers(db: Database.Database): string[] {
  return (
    db.prepare(
      "SELECT key FROM meta WHERE key LIKE 'pending-subject-doc-gen:%'"
    ).all() as Array<{ key: string }>
  ).map(r => r.key);
}

// ---------------------------------------------------------------------------
// Test provider factory
// ---------------------------------------------------------------------------

/**
 * A stub ModelProvider that captures all generate() calls.
 * Returns a canned markdown string for each call.
 * `capturedPrompts` accumulates all prompts so tests can inspect dispatch.
 */
function makeStubProvider(
  markdownFn: (prompt: string, callIdx: number) => string,
): {
  provider: {
    generate: ReturnType<typeof vi.fn>;
    embed: never;
    judge: never;
    judgeBatch: never;
  };
  callCount: { value: number };
  capturedPrompts: string[];
} {
  const callCount = { value: 0 };
  const capturedPrompts: string[] = [];
  const provider = {
    generate: vi.fn(async (prompt: string): Promise<string> => {
      const idx = callCount.value++;
      capturedPrompts.push(prompt);
      return markdownFn(prompt, idx);
    }),
    embed: undefined as never,
    judge: undefined as never,
    judgeBatch: undefined as never,
  };
  return { provider, callCount, capturedPrompts };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('corpus-budget-cap / hub+subject dispatch', () => {

  // ── (1) Hub dispatch: linked {name, docId}[] index ─────────────────────────

  test('(1) hub stub dispatched to generateDocForHub with linked {name,docId}[] from doc_containment children', async () => {
    const { db, store } = makeDb();
    const scope = 'test-scope';

    // Seed two subject stubs (already filled so they are skipped by the loop)
    const subj1Id = 'subj-1-id';
    const subj2Id = 'subj-2-id';
    store.upsertNode({ id: subj1Id, type: 'doc', value: '# subject 1', origin: 'inferred', s: 0, c: 1.0, last_access: 1000 });
    store.upsertNodeDoc({ node_id: subj1Id, slug: `${scope}:retrieval`, generated_at: 1000, updated_at: 1000 });
    store.upsertNodeScope({ node_id: subj1Id, scope, updated_at: 1000 });

    store.upsertNode({ id: subj2Id, type: 'doc', value: '# subject 2', origin: 'inferred', s: 0, c: 1.0, last_access: 1000 });
    store.upsertNodeDoc({ node_id: subj2Id, slug: `${scope}:sleep-pass`, generated_at: 1000, updated_at: 1000 });
    store.upsertNodeScope({ node_id: subj2Id, scope, updated_at: 1000 });

    // Seed empty hub stub
    const hubId = 'hub-stub-id';
    seedEmptyDocStub(store, db, hubId, scope, scope);

    // Write doc_containment edges: hub → subject stubs
    containmentEdge(store, hubId, subj1Id);
    containmentEdge(store, hubId, subj2Id);

    // Capture the subjectDocs argument by inspecting the prompt (it contains docIds)
    const capturedSubjectDocs: Array<{ name: string; docId: string }> = [];

    const { provider } = makeStubProvider((prompt) => {
      // The hub prompt embeds [docId] prefixes before each subject name —
      // extract them to verify the LINKED index was passed (not bare names).
      const matches = [...prompt.matchAll(/\[([a-z0-9-]+)\]\s+([a-z-]+)/g)];
      for (const m of matches) {
        capturedSubjectDocs.push({ docId: m[1]!, name: m[2]! });
      }
      return `# ${scope} Hub\n\n[Overview](recense://fact/fake-id)\n`;
    });

    const logs: string[] = [];
    const result = await generateCorpusDocs(
      { db, store, provider: provider as any },
      { maxDocs: 25, now: 2000, log: (m) => logs.push(m) },
    );
    // Debug: if generation failed, show logs
    if (result.generated === 0) {
      throw new Error(`Hub generation failed. Logs:\n${logs.join('\n')}`);
    }

    // The hub should have been generated (non-empty value)
    const hubNode = db.prepare('SELECT value FROM node WHERE id = ?').get(hubId) as { value: string } | undefined;
    expect(hubNode?.value.trim().length).toBeGreaterThan(0);

    // BLOCKER-1: subjectDocs has length > 0 and each entry carries name + docId
    expect(capturedSubjectDocs.length).toBeGreaterThan(0);
    for (const entry of capturedSubjectDocs) {
      expect(entry.docId.length).toBeGreaterThan(0);
      expect(entry.name.length).toBeGreaterThan(0);
    }
  });

  // ── (2) Subject dispatch: meta-rebuilt schemaIds, zero extra LLM calls ──────

  test('(2) subject stub dispatched to generateDocForSubject with schemaIds from meta; zero extra LLM calls', async () => {
    const { db, store } = makeDb();
    const scope = 'myproject';
    const subjectSlug = `${scope}:retrieval`;

    // Seed a schema and some facts
    const schemaId = 'schema-retrieval-001';
    seedSchema(store, schemaId, 'retrieval');
    seedFact(store, 'fact-r1');
    seedFact(store, 'fact-r2');
    abstracts(db, schemaId, 'fact-r1');
    abstracts(db, schemaId, 'fact-r2');

    // Seed node_scope entries for facts so gatherFactsForSubject finds them
    store.upsertNodeScope({ node_id: 'fact-r1', scope, updated_at: 1000 });
    store.upsertNodeScope({ node_id: 'fact-r2', scope, updated_at: 1000 });

    // Persist the subject-schema-ids meta key (as Plan 02 SubjectPromoter does)
    store.setMeta(`subject-schema-ids:${subjectSlug}`, JSON.stringify([schemaId]));

    // Seed empty subject stub
    const stubId = 'subj-retrieval-id';
    seedEmptyDocStub(store, db, stubId, subjectSlug, scope);

    const { provider, callCount } = makeStubProvider((_prompt, _idx) => {
      // Return minimal markdown for the subject doc
      return `# Retrieval deep-dive\n\nContent about retrieval for ${scope}.\n`;
    });

    // Record generate call count BEFORE
    const callsBefore = callCount.value;

    await generateCorpusDocs(
      { db, store, provider: provider as any },
      { maxDocs: 25, now: 2000 },
    );

    // BLOCKER-2: exactly 1 provider.generate call (for the doc itself — NOT a second call to
    // reconstruct schemaIds). If schemaIds were re-computed via LLM, callCount would be > 1.
    const callsAfter = callCount.value;
    expect(callsAfter - callsBefore).toBe(1);

    // Subject stub was filled
    const stubNode = db.prepare('SELECT value FROM node WHERE id = ?').get(stubId) as { value: string } | undefined;
    expect(stubNode?.value.trim().length).toBeGreaterThan(0);
  });

  // ── (3) Budget cap: maxDocs=1, 3 subject stubs → 1 generated, 2 markers ───

  test('(3a) budget cap: maxDocs=1, 3 subject stubs → 1 generated + 2 deferred markers written', async () => {
    const { db, store } = makeDb();
    const scope = 'capscope';

    // Seed 3 subject stubs + their meta keys
    const subjects = ['alpha', 'beta', 'gamma'];
    for (const name of subjects) {
      const slug = `${scope}:${name}`;
      const id = `stub-${name}`;
      const schemaId = `schema-${name}`;

      seedSchema(store, schemaId, name);
      seedFact(store, `fact-${name}`);
      abstracts(db, schemaId, `fact-${name}`);
      store.upsertNodeScope({ node_id: `fact-${name}`, scope, updated_at: 1000 });

      store.setMeta(`subject-schema-ids:${slug}`, JSON.stringify([schemaId]));
      seedEmptyDocStub(store, db, id, slug, scope);
    }

    const { provider } = makeStubProvider(() => `# Subject\n\nContent.\n`);
    const logs: string[] = [];

    const result = await generateCorpusDocs(
      { db, store, provider: provider as any },
      { maxDocs: 1, log: (m) => logs.push(m), now: 2000 },
    );

    // Exactly 1 doc generated
    expect(result.generated).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.deferred).toBe(2);

    // Exactly 2 pending-subject-doc-gen markers written
    const markerCount = countPendingMarkers(db);
    expect(markerCount).toBe(2);

    // A deferred log line was emitted
    const deferLine = logs.find(l => l.includes('deferring'));
    expect(deferLine).toBeDefined();
  });

  test('(3b) self-draining: second pass (maxDocs=1) generates the next stub + clears one marker', async () => {
    const { db, store } = makeDb();
    const scope = 'drainscope';

    const subjects = ['alpha', 'beta', 'gamma'];
    for (const name of subjects) {
      const slug = `${scope}:${name}`;
      const id = `stub-${name}`;
      const schemaId = `schema-${name}`;

      seedSchema(store, schemaId, name);
      seedFact(store, `fact-${name}`);
      abstracts(db, schemaId, `fact-${name}`);
      store.upsertNodeScope({ node_id: `fact-${name}`, scope, updated_at: 1000 });

      store.setMeta(`subject-schema-ids:${slug}`, JSON.stringify([schemaId]));
      seedEmptyDocStub(store, db, id, slug, scope);
    }

    const { provider } = makeStubProvider(() => `# Subject\n\nContent.\n`);

    // Pass 1: maxDocs=1 → generates 1, defers 2
    const result1 = await generateCorpusDocs(
      { db, store, provider: provider as any },
      { maxDocs: 1, now: 2000 },
    );
    expect(result1.generated).toBe(1);
    const markersAfterPass1 = countPendingMarkers(db);
    expect(markersAfterPass1).toBe(2);

    // Pass 2: maxDocs=1 → generates 1 more, marker for the generated stub is cleared
    const result2 = await generateCorpusDocs(
      { db, store, provider: provider as any },
      { maxDocs: 1, now: 3000 },
    );
    expect(result2.generated).toBe(1);

    // The generated stub's marker should have been cleared (self-draining)
    // Total markers: started with 2, generated 1 (clears 1 marker), defers 0 more (1 stub left in queue)
    // After pass 2: 2 - 1 (cleared) + 0 (no new overflow: only 1 stub left which is processed) = 1
    const markersAfterPass2 = countPendingMarkers(db);
    expect(markersAfterPass2).toBeLessThan(markersAfterPass1);
  });

  // ── (4) Hub vs subject dispatch separation ────────────────────────────────

  test('(4) bare scope slug dispatched to hub generator; scope:name slug to subject generator', async () => {
    const { db, store } = makeDb();
    const scope = 'dispatch-test';

    // Hub stub (bare scope slug) — already has subject stubs as children
    const hubId = 'hub-dispatch-id';
    seedEmptyDocStub(store, db, hubId, scope, scope);

    // Subject stub ('scope:name' slug) + meta key
    const subjectSlug = `${scope}:config`;
    const subjectId = 'subj-config-id';
    const schemaId = 'schema-config-001';
    seedSchema(store, schemaId, 'config');
    seedFact(store, 'fact-cfg1');
    abstracts(db, schemaId, 'fact-cfg1');
    store.upsertNodeScope({ node_id: 'fact-cfg1', scope, updated_at: 1000 });
    store.setMeta(`subject-schema-ids:${subjectSlug}`, JSON.stringify([schemaId]));
    seedEmptyDocStub(store, db, subjectId, subjectSlug, scope);

    // Wire hub → subject containment so hub generate gets a non-empty index
    containmentEdge(store, hubId, subjectId);

    const capturedPrompts: string[] = [];
    const { provider } = makeStubProvider((prompt) => {
      capturedPrompts.push(prompt);
      return `# Generated\n\nContent.\n`;
    });

    await generateCorpusDocs(
      { db, store, provider: provider as any },
      { maxDocs: 25, now: 2000 },
    );

    // Both stubs should be generated
    expect(capturedPrompts.length).toBe(2);

    // Hub prompt contains 'PROJECT HUB OVERVIEW' (from buildHubDocPrompt)
    const hubPrompt = capturedPrompts.find(p => p.includes('PROJECT HUB OVERVIEW'));
    expect(hubPrompt).toBeDefined();

    // Subject prompt contains 'SUBJECT DEEP-DIVE' (from buildSubjectDocPrompt)
    const subjectPrompt = capturedPrompts.find(p => p.includes('SUBJECT DEEP-DIVE'));
    expect(subjectPrompt).toBeDefined();
  });

  // ── (5) Missing meta key → log + skip, no LLM call ─────────────────────────

  test('(5) subject stub with missing subject-schema-ids meta → logged + skipped (no LLM call)', async () => {
    const { db, store } = makeDb();
    const scope = 'metascope';
    const subjectSlug = `${scope}:orphan`;
    const stubId = 'stub-orphan-id';

    // Seed subject stub but NO meta key
    seedEmptyDocStub(store, db, stubId, subjectSlug, scope);

    const { provider, callCount } = makeStubProvider(() => '# content\n');
    const logs: string[] = [];

    const result = await generateCorpusDocs(
      { db, store, provider: provider as any },
      { maxDocs: 25, log: (m) => logs.push(m), now: 2000 },
    );

    // No LLM call should have been made
    expect(callCount.value).toBe(0);
    // Failed count = 1 (skipped due to missing meta)
    expect(result.failed).toBe(1);
    // A log line about the missing meta should exist
    const skipLine = logs.find(l => l.includes('subject-schema-ids:') && l.includes('not found'));
    expect(skipLine).toBeDefined();

    // Stub remains empty
    const stubNode = db.prepare('SELECT value FROM node WHERE id = ?').get(stubId) as { value: string };
    expect(stubNode.value.trim()).toBe('');
  });

});
