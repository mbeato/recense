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
});
