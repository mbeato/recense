/**
 * doc-generator-hub-subject tests (Phase 39.1, Plan 01 Task 3).
 *
 * Covers the new hub and subject generation paths:
 *  (a) generateDocForHub returns non-empty markdown + verified citedFactIds; when
 *      passed a non-empty subjectDocs array, the returned markdown contains a
 *      recense://doc/<docId> ref per passed docId (linked index, NOT bare names)
 *      and GenerateDocResult.linkedDocRefs contains those docIds.
 *  (b) generateDocForHub throws when the mock provider returns an empty string.
 *  (c) generateDocForSubject gathers across multiple schemaIds and returns a
 *      GenerateDocResult with subjectName-as-thesis framing.
 *  (d) Neither generateDocForHub nor generateDocForSubject writes to the DB
 *      (read-only invariant — node + edge row counts unchanged before/after).
 */
import Database from 'better-sqlite3';
import { describe, test, expect } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import {
  generateDocForHub,
  generateDocForSubject,
  buildHubDocPrompt,
  buildSubjectDocPrompt,
} from '../src/reader/doc-generator';

// ── helpers ────────────────────────────────────────────────────────────────

function makeStore(): { db: Database.Database; store: SemanticStore } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const clock = new FakeClock(1000);
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: ':memory:' });
  return { db, store };
}

function seedFact(store: SemanticStore, id: string, value = `fact text ${id}`): void {
  store.upsertNode({
    id,
    type: 'fact',
    value,
    origin: 'observed',
    s: 0.5,
    c: 0.8,
    last_access: 500,
  });
}

function seedSchema(store: SemanticStore, id: string, label: string): void {
  store.upsertNode({ id, type: 'schema', value: label, origin: 'inferred', s: 0, c: 1.0, last_access: 500 });
}

function seedAbstractsEdge(store: SemanticStore, schemaId: string, dstId: string): void {
  store.upsertEdge({ src: schemaId, dst: dstId, rel: 'abstracts', kind: 'abstracts', w: 1 });
}

/** Seed a live doc node with a node_doc sidecar (needed for verifyCitations to resolve doc refs). */
function seedDocNode(store: SemanticStore, id: string, slug: string, body = `# ${slug}\n\nbody`): void {
  store.upsertNode({ id, type: 'doc', value: body, origin: 'inferred', s: 0, c: 1.0, last_access: 500 });
  store.upsertNodeDoc({ node_id: id, slug, generated_at: 400, updated_at: 400 });
  store.upsertNodeScope({ node_id: id, scope: slug, updated_at: 400 });
}

/** A stub provider that returns canned markdown when generate() is called. */
function makeStubProvider(markdown: string, capturePrompt?: { value: string }) {
  return {
    generate: async (prompt: string) => {
      if (capturePrompt) capturePrompt.value = prompt;
      return markdown;
    },
    embed: async (_texts: string[]) => [new Float32Array(4).fill(0.5)],
    judge: async () => ({ verdict: 'unrelated', magnitude: 0, best_candidate_id: null, contradicted_ids: [], reasoning: '' }),
  };
}

/** Count all rows in all important tables. */
function countRows(db: Database.Database): { nodes: number; edges: number; docs: number; scopes: number } {
  return {
    nodes: (db.prepare('SELECT COUNT(*) AS n FROM node').get() as { n: number }).n,
    edges: (db.prepare('SELECT COUNT(*) AS n FROM edge').get() as { n: number }).n,
    docs:  (db.prepare('SELECT COUNT(*) AS n FROM node_doc').get() as { n: number }).n,
    scopes: (db.prepare('SELECT COUNT(*) AS n FROM node_scope').get() as { n: number }).n,
  };
}

// ── Test group (a): generateDocForHub linked index ──────────────────────────

describe('generateDocForHub', () => {
  test('(a) returns non-empty markdown and verified citedFactIds', async () => {
    const { db, store } = makeStore();
    const factId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    seedFact(store, factId, 'brain-memory is a memory engine');
    store.upsertNodeScope({ node_id: factId, scope: 'brain-memory', updated_at: 500 });

    const markdown = `# brain-memory Hub\n\n[Memory engine](recense://fact/${factId}).`;
    const provider = makeStubProvider(markdown);

    const result = await generateDocForHub(
      { db, store, provider: provider as any },
      'brain-memory',
      [],
    );

    expect(result.markdown.trim().length).toBeGreaterThan(0);
    expect(result.citationCount).toBeGreaterThanOrEqual(1);
    expect(result.citedFactIds).toContain(factId);
    expect(typeof result.docId).toBe('string');
    expect(result.docId.length).toBeGreaterThan(0);
    expect(Array.isArray(result.linkedDocRefs)).toBe(true);
  });

  test('(a) hub markdown with subjectDocs contains recense://doc/<docId> per entry', async () => {
    const { db, store } = makeStore();
    const factId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    seedFact(store, factId, 'brain-memory has a sleep pass');
    store.upsertNodeScope({ node_id: factId, scope: 'brain-memory', updated_at: 500 });

    // Seed two live subject docs so verifyCitations can resolve their doc refs
    const sleepDocId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const retrievalDocId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    seedDocNode(store, sleepDocId, 'brain-memory:sleep-pass');
    seedDocNode(store, retrievalDocId, 'brain-memory:retrieval');

    const subjectDocs = [
      { name: 'sleep pass', docId: sleepDocId },
      { name: 'retrieval', docId: retrievalDocId },
    ];

    // Mock returns hub markdown with recense://doc refs for both subjects
    const markdown = [
      `# brain-memory Hub`,
      '',
      `[Memory engine](recense://fact/${factId}).`,
      '',
      `## Subject Index`,
      `- [sleep pass](recense://doc/${sleepDocId})`,
      `- [retrieval](recense://doc/${retrievalDocId})`,
    ].join('\n');
    const provider = makeStubProvider(markdown);

    const result = await generateDocForHub(
      { db, store, provider: provider as any },
      'brain-memory',
      subjectDocs,
    );

    // Both docIds must appear as recense://doc/ refs in the markdown
    expect(result.markdown).toContain(`recense://doc/${sleepDocId}`);
    expect(result.markdown).toContain(`recense://doc/${retrievalDocId}`);
    // linkedDocRefs must contain both resolved doc ids
    expect(result.linkedDocRefs).toContain(sleepDocId);
    expect(result.linkedDocRefs).toContain(retrievalDocId);
  });

  test('(a) subjectDocs prompt uses {name, docId} — NOT subjectNames string[]', () => {
    // Source assertion: buildHubDocPrompt signature accepts { name, docId }
    const prompt = buildHubDocPrompt(
      'brain-memory',
      '[fact-id] some fact',
      [],
      [{ name: 'sleep pass', docId: 'doc-id-1' }],
    );
    // The prompt template must embed recense://doc/ token so index entries become doc_link refs
    expect(prompt).toContain('recense://doc/');
    // The docId is present in the prompt (for the model to use)
    expect(prompt).toContain('doc-id-1');
    // The subject name is present
    expect(prompt).toContain('sleep pass');
  });

  test('(a) hub prompt includes HARD RULES', () => {
    const prompt = buildHubDocPrompt('brain-memory', '[id] fact', [], []);
    expect(prompt).toContain('HARD RULES');
  });

  // ── Test group (b): generateDocForHub throws on empty model output ──────────

  test('(b) throws when provider returns empty string', async () => {
    const { db, store } = makeStore();
    seedFact(store, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'some fact');
    store.upsertNodeScope({ node_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', scope: 'scope1', updated_at: 500 });

    const provider = makeStubProvider('');

    await expect(
      generateDocForHub({ db, store, provider: provider as any }, 'scope1', []),
    ).rejects.toThrow(/empty output/i);
  });

  test('(b) throws when provider returns whitespace-only string', async () => {
    const { db, store } = makeStore();
    seedFact(store, 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'some fact');
    store.upsertNodeScope({ node_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', scope: 'scope2', updated_at: 500 });

    const provider = makeStubProvider('   \n  \t  \n');

    await expect(
      generateDocForHub({ db, store, provider: provider as any }, 'scope2', []),
    ).rejects.toThrow(/empty output/i);
  });
});

// ── Test group (c): generateDocForSubject gathers across multiple schemaIds ─

describe('generateDocForSubject', () => {
  test('(c) gathers across multiple schemaIds (union dedup) and returns GenerateDocResult', async () => {
    const { db, store } = makeStore();
    const schema1Id = 'schema1-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const schema2Id = 'schema2-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const factId1 = '11111111-1111-1111-1111-111111111111';
    const factId2 = '22222222-2222-2222-2222-222222222222';
    const sharedFactId = '33333333-3333-3333-3333-333333333333';

    seedSchema(store, schema1Id, 'sleep pass internals');
    seedSchema(store, schema2Id, 'sleep pass scheduling');
    seedFact(store, factId1, 'the sleep pass runs every hour');
    seedFact(store, factId2, 'the sleep pass uses haiku for extraction');
    seedFact(store, sharedFactId, 'the sleep pass is the core offline path');  // shared

    // schema1 → factId1 + sharedFact; schema2 → factId2 + sharedFact
    seedAbstractsEdge(store, schema1Id, factId1);
    seedAbstractsEdge(store, schema1Id, sharedFactId);
    seedAbstractsEdge(store, schema2Id, factId2);
    seedAbstractsEdge(store, schema2Id, sharedFactId);  // overlap

    // Mock provider cites both schema-specific facts and the shared one
    const markdown = [
      `# Sleep Pass`,
      `[Runs hourly](recense://fact/${factId1}).`,
      `[Uses Haiku](recense://fact/${factId2}).`,
      `[Core path](recense://fact/${sharedFactId}).`,
    ].join('\n');
    const provider = makeStubProvider(markdown);

    const result = await generateDocForSubject(
      { db, store, provider: provider as any },
      { scope: 'brain-memory', subjectName: 'sleep pass', schemaIds: [schema1Id, schema2Id] },
    );

    expect(result.markdown.trim().length).toBeGreaterThan(0);
    // All three facts should be cited (sharedFact appears once, not twice — deduped by gather)
    expect(result.citationCount).toBe(3);
    expect(result.citedFactIds).toContain(factId1);
    expect(result.citedFactIds).toContain(factId2);
    expect(result.citedFactIds).toContain(sharedFactId);
    // Shape assertion
    expect(typeof result.docId).toBe('string');
    expect(result.docId.length).toBeGreaterThan(0);
    expect(Array.isArray(result.linkedDocRefs)).toBe(true);
  });

  test('(c) subject prompt frames subjectName as thesis (not schema UUID label)', () => {
    const prompt = buildSubjectDocPrompt('brain-memory', 'sleep pass', '[id] a fact', []);
    expect(prompt).toContain('sleep pass');
    expect(prompt).toContain('thesis');
    expect(prompt).toContain('HARD RULES');
    // Must NOT reference a schema UUID label framing
    expect(prompt).not.toContain('schema UUID');
  });

  test('(c) returns GenerateDocResult shape with all required fields', async () => {
    const { db, store } = makeStore();
    const schemaId = 'schema-shape-check-0000-000000000001';
    seedSchema(store, schemaId, 'shape check');

    const provider = makeStubProvider('# Shape\n\nno citations here.');

    const result = await generateDocForSubject(
      { db, store, provider: provider as any },
      { scope: 'proj', subjectName: 'shape check', schemaIds: [schemaId] },
    );

    expect(typeof result.markdown).toBe('string');
    expect(typeof result.docId).toBe('string');
    expect(result.docId.length).toBeGreaterThan(0);
    expect(Array.isArray(result.citedFactIds)).toBe(true);
    expect(typeof result.citationCount).toBe('number');
    expect(typeof result.invented).toBe('number');
    expect(typeof result.tombstoned).toBe('number');
    expect(Array.isArray(result.linkedDocRefs)).toBe(true);
  });

  test('(c) empty output THROWS', async () => {
    const { db, store } = makeStore();
    const schemaId = 'schema-empty-subj-0000-000000000001';
    seedSchema(store, schemaId, 'empty test');

    const provider = makeStubProvider('');

    await expect(
      generateDocForSubject(
        { db, store, provider: provider as any },
        { scope: 'proj', subjectName: 'empty test', schemaIds: [schemaId] },
      ),
    ).rejects.toThrow(/empty output/i);
  });
});

// ── Test group (d): both generators are read-only ──────────────────────────

describe('read-only invariant', () => {
  test('(d) generateDocForHub does NOT write any nodes or edges to the DB', async () => {
    const { db, store } = makeStore();
    const factId = 'aaaabbbb-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    seedFact(store, factId, 'some fact about the project');
    store.upsertNodeScope({ node_id: factId, scope: 'myproj', updated_at: 500 });

    const before = countRows(db);

    const markdown = `# MyProj\n\n[Some fact](recense://fact/${factId}).`;
    const provider = makeStubProvider(markdown);

    await generateDocForHub(
      { db, store, provider: provider as any },
      'myproj',
      [],
    );

    const after = countRows(db);
    expect(after.nodes).toBe(before.nodes);
    expect(after.edges).toBe(before.edges);
    expect(after.docs).toBe(before.docs);
    expect(after.scopes).toBe(before.scopes);
  });

  test('(d) generateDocForSubject does NOT write any nodes or edges to the DB', async () => {
    const { db, store } = makeStore();
    const schemaId = 'schema-ro-0000-0000-0000-000000000001';
    const factId = 'factro00-0000-0000-0000-000000000001';
    seedSchema(store, schemaId, 'retrieval patterns');
    seedFact(store, factId, 'retrieval uses cosine similarity');
    seedAbstractsEdge(store, schemaId, factId);

    const before = countRows(db);

    const markdown = `# Retrieval\n\n[Cosine similarity](recense://fact/${factId}).`;
    const provider = makeStubProvider(markdown);

    await generateDocForSubject(
      { db, store, provider: provider as any },
      { scope: 'brain-memory', subjectName: 'retrieval', schemaIds: [schemaId] },
    );

    const after = countRows(db);
    expect(after.nodes).toBe(before.nodes);
    expect(after.edges).toBe(before.edges);
    expect(after.docs).toBe(before.docs);
    expect(after.scopes).toBe(before.scopes);
  });
});

// ── Source assertion tests ─────────────────────────────────────────────────

describe('source assertions', () => {
  test('verifyCitations is NOT duplicated — defined exactly once in doc-generator.ts', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../src/reader/doc-generator.ts'), 'utf8');
    const count = (src.match(/function verifyCitations/g) ?? []).length;
    expect(count).toBe(1);
  });

  test('generateDocForSchema is still present (backward-compat — not removed)', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../src/reader/doc-generator.ts'), 'utf8');
    expect(src).toContain('generateDocForSchema');
  });

  test('buildHubDocPrompt embeds recense://doc/ token so index entries become doc_link refs', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../src/reader/doc-generator.ts'), 'utf8');
    expect(src).toContain('buildHubDocPrompt');
    expect(src).toContain('recense://doc/');
    expect(src).toContain('buildSubjectDocPrompt');
  });

  test('both new generators contain the empty-output guard', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../src/reader/doc-generator.ts'), 'utf8');
    // Count occurrences of the empty-output guard across all generator functions
    const guardCount = (src.match(/if \(md\.trim\(\)\.length === 0\)/g) ?? []).length;
    expect(guardCount).toBeGreaterThanOrEqual(2);  // generateDocForHub + generateDocForSubject (plus existing ones)
  });
});
