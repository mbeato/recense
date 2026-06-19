/**
 * doc-generator tests (READER-01, 27-02 Task 2 — TDD RED).
 *
 * Covers the generateDoc citation-verify loop:
 *  (a) citationCount equals the number of real cited fact IDs found.
 *  (b) invented count equals the number of cited IDs with no live node.
 *  (c) Invented IDs are excluded from citedFactIds in the result.
 *  (d) The prompt sent to provider.generate contains "HARD RULES" (verbatim slice prompt shape).
 *  (e) generateDoc uses the judgeConfig as generateConfig (D-04 — no new model var).
 */
import Database from 'better-sqlite3';
import { describe, test, expect, vi } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { generateDoc } from '../src/reader/doc-generator';
import type { CandidateRetriever } from '../src/retrieval/topk';

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

// ── tests ──────────────────────────────────────────────────────────────────

describe('generateDoc', () => {
  test('(a)(b)(c) citation-verify loop: real ids included, invented excluded', async () => {
    const { db, store } = makeStore();
    // Seed two live facts
    seedFact(store, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'fact about infrastructure');
    seedFact(store, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'fact about pipelines');
    // Also seed one as scope-tagged so gatherFacts can return them
    store.upsertNodeScope({ node_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', scope: 'myproject', updated_at: 500 });
    store.upsertNodeScope({ node_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', scope: 'myproject', updated_at: 500 });

    // Canned markdown: two real citations + one invented UUID
    const fakeInvented = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    const markdown = [
      '# My Project',
      '',
      `Some [real claim A](recense://fact/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa).`,
      `Some [real claim B](recense://fact/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb).`,
      `[invented](recense://fact/${fakeInvented}).`,
    ].join('\n');

    const provider = makeStubProvider(markdown);

    const result = await generateDoc(
      { db, store, provider: provider as any },
      'myproject',
    );

    expect(result.citationCount).toBe(2);  // only the 2 real citations
    expect(result.invented).toBe(1);        // 1 invented
    expect(result.citedFactIds).not.toContain(fakeInvented);
    expect(result.citedFactIds).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    expect(result.citedFactIds).toContain('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
  });

  test('(d) prompt sent to provider contains "HARD RULES"', async () => {
    const { db, store } = makeStore();
    seedFact(store, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'some fact');
    store.upsertNodeScope({ node_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', scope: 'testslug', updated_at: 500 });

    const capturePrompt = { value: '' };
    const provider = makeStubProvider('# Doc\n', capturePrompt);

    await generateDoc(
      { db, store, provider: provider as any },
      'testslug',
    );

    expect(capturePrompt.value).toContain('HARD RULES');
  });

  test('result contains markdown, docId, citationCount, invented, tombstoned fields', async () => {
    const { db, store } = makeStore();
    seedFact(store, 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'some data');
    store.upsertNodeScope({ node_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', scope: 'proj', updated_at: 500 });

    const markdown = `# Proj\n[claim](recense://fact/ffffffff-ffff-ffff-ffff-ffffffffffff).`;
    const provider = makeStubProvider(markdown);

    const result = await generateDoc(
      { db, store, provider: provider as any },
      'proj',
    );

    expect(typeof result.markdown).toBe('string');
    expect(typeof result.docId).toBe('string');
    expect(result.docId.length).toBeGreaterThan(0);
    expect(typeof result.citationCount).toBe('number');
    expect(typeof result.invented).toBe('number');
    expect(typeof result.tombstoned).toBe('number');
  });

  test('(e) generateDoc does not itself write any doc node to the DB', async () => {
    // generateDoc is a pure generator — writing is the CLI's job (composes with writeDoc)
    const { db, store } = makeStore();
    seedFact(store, '11111111-1111-1111-1111-111111111111', 'some data');
    store.upsertNodeScope({ node_id: '11111111-1111-1111-1111-111111111111', scope: 'proj2', updated_at: 500 });

    const provider = makeStubProvider('# Proj2');

    await generateDoc(
      { db, store, provider: provider as any },
      'proj2',
    );

    // No doc node should exist in the DB
    const docNodes = db.prepare("SELECT id FROM node WHERE type = 'doc'").all();
    expect(docNodes).toHaveLength(0);
  });

  // ── Truncated-id resolution + canonicalization (D-05 bug fix) ─────────────
  // The env judge model emits 8-char hex PREFIXES instead of full UUIDs. The
  // verify loop must resolve them via unique-prefix match and canonicalize the prose.

  test('(prefix) 8-char prefix ref for a live fact resolves + canonicalizes', async () => {
    const { db, store } = makeStore();
    const fullId = 'e751c852-9a05-4394-9397-bf18955d6ae5';
    seedFact(store, fullId, 'tonos is a daily eval pipeline');
    store.upsertNodeScope({ node_id: fullId, scope: 'tonos', updated_at: 500 });

    // Model emits only the 8-char prefix (the observed production bug)
    const markdown = `# Tonos\n\nThe [eval pipeline](recense://fact/e751c852) runs daily.`;
    const provider = makeStubProvider(markdown);

    const result = await generateDoc({ db, store, provider: provider as any }, 'tonos');

    // The truncated ref must resolve to the full fact
    expect(result.citationCount).toBe(1);
    expect(result.invented).toBe(0);
    expect(result.citedFactIds).toContain(fullId);
    // The returned markdown must be canonicalized to the full UUID
    expect(result.markdown).toContain(`recense://fact/${fullId}`);
    expect(result.markdown).not.toContain('recense://fact/e751c852)');
  });

  test('(prefix) genuinely-unknown prefix is counted as invented', async () => {
    const { db, store } = makeStore();
    const fullId = 'aaaa1111-2222-3333-4444-555566667777';
    seedFact(store, fullId, 'a known fact');
    store.upsertNodeScope({ node_id: fullId, scope: 'proj', updated_at: 500 });

    // One real prefix + one totally-unknown prefix
    const markdown = [
      '# Proj',
      'real [claim](recense://fact/aaaa1111).',
      'fake [claim](recense://fact/deadbeef).', // no node starts with deadbeef
    ].join('\n');
    const provider = makeStubProvider(markdown);

    const result = await generateDoc({ db, store, provider: provider as any }, 'proj');

    expect(result.citationCount).toBe(1);      // aaaa1111 resolves
    expect(result.invented).toBe(1);           // deadbeef is invented
    expect(result.citedFactIds).toEqual([fullId]);
    // Canonicalized real ref; invented ref left untouched
    expect(result.markdown).toContain(`recense://fact/${fullId}`);
    expect(result.markdown).toContain('recense://fact/deadbeef');
  });

  test('(prefix) ambiguous prefix (>1 match) is counted as invented, no edge', async () => {
    const { db, store } = makeStore();
    // Two facts sharing the same 8-char prefix → ambiguous
    const idA = 'abcdef00-1111-1111-1111-111111111111';
    const idB = 'abcdef00-2222-2222-2222-222222222222';
    seedFact(store, idA, 'fact A');
    seedFact(store, idB, 'fact B');
    store.upsertNodeScope({ node_id: idA, scope: 'proj', updated_at: 500 });
    store.upsertNodeScope({ node_id: idB, scope: 'proj', updated_at: 500 });

    // Model cites the shared prefix — cannot be disambiguated
    const markdown = `# Proj\nambiguous [claim](recense://fact/abcdef00).`;
    const provider = makeStubProvider(markdown);

    const result = await generateDoc({ db, store, provider: provider as any }, 'proj');

    expect(result.citationCount).toBe(0);  // ambiguous → not verified
    expect(result.invented).toBe(1);       // counted as invented (cannot resolve safely)
    expect(result.citedFactIds).toHaveLength(0);
    // Ambiguous ref left untouched (not canonicalized to either candidate)
    expect(result.markdown).toContain('recense://fact/abcdef00');
  });

  test('(prefix) two different truncations of the SAME fact dedup to one cite', async () => {
    const { db, store } = makeStore();
    const fullId = 'cafe1234-5678-90ab-cdef-1234567890ab';
    seedFact(store, fullId, 'a fact cited two ways');
    store.upsertNodeScope({ node_id: fullId, scope: 'proj', updated_at: 500 });

    // The full UUID AND its 8-char prefix both appear → must dedup to one canonical id
    const markdown = [
      '# Proj',
      `first [ref](recense://fact/${fullId}).`,
      'second [ref](recense://fact/cafe1234).',
    ].join('\n');
    const provider = makeStubProvider(markdown);

    const result = await generateDoc({ db, store, provider: provider as any }, 'proj');

    expect(result.citationCount).toBe(1);  // deduped to one unique fact
    expect(result.citedFactIds).toEqual([fullId]);
    // Both refs now point at the full UUID
    expect(result.markdown).not.toContain('recense://fact/cafe1234)');
  });

  // ── Fail-loud on empty generation (timeout/subprocess-failure guard) ──────
  // The headless client returns EMPTY content on timeout/non-zero-exit/spawn-failure.
  // generateDoc must THROW on empty output so the CLI never persists a silent empty doc.

  test('(empty) empty markdown output THROWS and writes nothing', async () => {
    const { db, store } = makeStore();
    seedFact(store, '22222222-2222-2222-2222-222222222222', 'a fact');
    store.upsertNodeScope({ node_id: '22222222-2222-2222-2222-222222222222', scope: 'projx', updated_at: 500 });

    const provider = makeStubProvider(''); // simulate a timeout → empty content

    await expect(
      generateDoc({ db, store, provider: provider as any }, 'projx'),
    ).rejects.toThrow(/empty output/i);

    // Nothing written: no doc node exists
    const docNodes = db.prepare("SELECT id FROM node WHERE type = 'doc'").all();
    expect(docNodes).toHaveLength(0);
  });

  test('(empty) whitespace-only markdown output THROWS', async () => {
    const { db, store } = makeStore();
    seedFact(store, '33333333-3333-3333-3333-333333333333', 'a fact');
    store.upsertNodeScope({ node_id: '33333333-3333-3333-3333-333333333333', scope: 'projy', updated_at: 500 });

    const provider = makeStubProvider('   \n  \t  \n'); // whitespace-only → still a failure

    await expect(
      generateDoc({ db, store, provider: provider as any }, 'projy'),
    ).rejects.toThrow(/empty output/i);
  });

  // ── Sibling-doc cross-linking (READER-04) ──────────────────────────────────
  // The generator must (1) put a RELATED DOCS block in the prompt when other live docs
  // exist (and omit it when none do), and (2) resolve+canonicalize recense://doc refs so
  // doc_link edges form organically in production.

  /** Seed a live doc node with a node_doc sidecar + a body (for title extraction). */
  function seedDocNode(store: SemanticStore, id: string, slug: string, body: string): void {
    store.upsertNode({ id, type: 'doc', value: body, origin: 'inferred', s: 0, c: 1.0, last_access: 500 });
    store.upsertNodeDoc({ node_id: id, slug, generated_at: 400, updated_at: 400 });
    store.upsertNodeScope({ node_id: id, scope: slug, updated_at: 400 });
  }

  test('(sibling) RELATED DOCS block is included when other live docs exist', async () => {
    const { db, store } = makeStore();
    seedFact(store, '44444444-4444-4444-4444-444444444444', 'a fact about vtx');
    store.upsertNodeScope({ node_id: '44444444-4444-4444-4444-444444444444', scope: 'vtx', updated_at: 500 });
    // A sibling doc (tonos) already exists
    seedDocNode(store, 'aaaa1111-2222-4333-8444-555566667777', 'tonos', '# Tonos — Project Deep-Dive\n\nbody');

    const capturePrompt = { value: '' };
    const provider = makeStubProvider('# VTX\n', capturePrompt);
    await generateDoc({ db, store, provider: provider as any }, 'vtx');

    expect(capturePrompt.value).toContain('RELATED PROJECT DOCS');
    // Lists the sibling by id + slug + extracted H1 title
    expect(capturePrompt.value).toContain('aaaa1111-2222-4333-8444-555566667777');
    expect(capturePrompt.value).toContain('tonos');
    expect(capturePrompt.value).toContain('Tonos — Project Deep-Dive');
    // Instructs the recense://doc/<docId> link form
    expect(capturePrompt.value).toContain('recense://doc/');
  });

  test('(sibling) RELATED DOCS block is OMITTED when no other docs exist', async () => {
    const { db, store } = makeStore();
    seedFact(store, '55555555-5555-5555-5555-555555555555', 'a fact');
    store.upsertNodeScope({ node_id: '55555555-5555-5555-5555-555555555555', scope: 'lonely', updated_at: 500 });

    const capturePrompt = { value: '' };
    const provider = makeStubProvider('# Lonely\n', capturePrompt);
    await generateDoc({ db, store, provider: provider as any }, 'lonely');

    expect(capturePrompt.value).not.toContain('RELATED PROJECT DOCS');
  });

  test('(sibling) the doc being generated is NOT listed as its own sibling', async () => {
    const { db, store } = makeStore();
    seedFact(store, '66666666-6666-6666-6666-666666666666', 'a fact');
    store.upsertNodeScope({ node_id: '66666666-6666-6666-6666-666666666666', scope: 'self', updated_at: 500 });
    // A prior doc for the SAME slug exists (the one being regenerated)
    seedDocNode(store, 'dddd1111-2222-4333-8444-555566667777', 'self', '# Self\n\nbody');

    const capturePrompt = { value: '' };
    const provider = makeStubProvider('# Self v2\n', capturePrompt);
    await generateDoc({ db, store, provider: provider as any }, 'self');

    // No RELATED DOCS block (only doc is the same-slug one, excluded)
    expect(capturePrompt.value).not.toContain('RELATED PROJECT DOCS');
  });

  test('(sibling) full doc-ref resolves to the sibling and is canonicalized + reported', async () => {
    const { db, store } = makeStore();
    seedFact(store, '77777777-7777-7777-7777-777777777777', 'a fact');
    store.upsertNodeScope({ node_id: '77777777-7777-7777-7777-777777777777', scope: 'vtx', updated_at: 500 });
    const tonosId = 'aaaa1111-2222-4333-8444-555566667777';
    seedDocNode(store, tonosId, 'tonos', '# Tonos\n\nbody');

    // Prose references tonos by its FULL id
    const markdown = `# VTX\n\nVTX relies on [tonos](recense://doc/${tonosId}).`;
    const provider = makeStubProvider(markdown);
    const result = await generateDoc({ db, store, provider: provider as any }, 'vtx');

    // The resolved full id is reported for doc-writer
    expect(result.linkedDocRefs).toContain(tonosId);
    // The prose keeps the full canonical id
    expect(result.markdown).toContain(`recense://doc/${tonosId}`);
  });

  test('(sibling) TRUNCATED doc-ref resolves via unique-prefix + canonicalizes to the full id', async () => {
    const { db, store } = makeStore();
    seedFact(store, '88888888-8888-8888-8888-888888888888', 'a fact');
    store.upsertNodeScope({ node_id: '88888888-8888-8888-8888-888888888888', scope: 'vtx', updated_at: 500 });
    const tonosId = 'aaaa1111-2222-4333-8444-555566667777';
    seedDocNode(store, tonosId, 'tonos', '# Tonos\n\nbody');

    // The model TRUNCATES the doc id to an 8-char prefix (as it does for fact ids)
    const truncated = 'aaaa1111';
    const markdown = `# VTX\n\nVTX uses [tonos](recense://doc/${truncated}).`;
    const provider = makeStubProvider(markdown);
    const result = await generateDoc({ db, store, provider: provider as any }, 'vtx');

    // Resolved to the FULL canonical id (not the truncated prefix)
    expect(result.linkedDocRefs).toContain(tonosId);
    expect(result.linkedDocRefs).not.toContain(truncated);
    // Prose rewritten to the full canonical id so the reader's ?id= click agrees
    expect(result.markdown).toContain(`recense://doc/${tonosId}`);
    expect(result.markdown).not.toContain(`recense://doc/${truncated})`);
  });

  test('(sibling) unknown/ambiguous doc-ref is DROPPED (no edge target)', async () => {
    const { db, store } = makeStore();
    seedFact(store, '99999999-9999-9999-9999-999999999999', 'a fact');
    store.upsertNodeScope({ node_id: '99999999-9999-9999-9999-999999999999', scope: 'vtx', updated_at: 500 });
    // Two docs sharing a prefix → an ambiguous prefix ref must resolve to neither
    seedDocNode(store, 'abcd1111-0000-4000-8000-000000000001', 'one', '# One');
    seedDocNode(store, 'abcd1111-0000-4000-8000-000000000002', 'two', '# Two');

    const markdown = [
      `# VTX`,
      `[unknown](recense://doc/ffffffff-ffff-4fff-8fff-ffffffffffff)`,  // no such doc
      `[ambiguous](recense://doc/abcd1111)`,                            // matches BOTH → ambiguous
    ].join('\n');
    const provider = makeStubProvider(markdown);
    const result = await generateDoc({ db, store, provider: provider as any }, 'vtx');

    // Neither the unknown nor the ambiguous ref is linked
    expect(result.linkedDocRefs).toHaveLength(0);
  });

  test('source: doc-generator gathers sibling docs + canonicalizes doc-refs', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../src/reader/doc-generator.ts'), 'utf8');
    expect(src).toContain('gatherSiblingDocs');
    expect(src).toContain('RELATED PROJECT DOCS');
    // doc-refs resolved against LIVE doc nodes only
    expect(src).toContain("type = 'doc' AND tombstoned = 0");
  });
});
