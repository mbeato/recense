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
});
