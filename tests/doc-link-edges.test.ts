/**
 * doc-link-edges tests (READER-04, 27-05 Task 1 — TDD RED).
 *
 * Covers doc_link edge creation from recense://doc/<id> refs in generated markdown:
 *  (a) generateDoc returns linkedDocRefs from recense://doc/<id> refs in the prose.
 *  (b) writeDoc creates one doc_link edge per unique linked doc ref whose target EXISTS.
 *  (c) dangling ref (no live doc node) is skipped — no dangling FK.
 *  (d) doc_link edges are FK-clean (PRAGMA foreign_key_check empty).
 *  (e) exactly one doc_link edge when the same ref appears twice (dedup).
 *  (f) no doc_link edge created when target doc is tombstoned.
 *
 * IMPORTANT: uses a TEMP throwaway DB (`:memory:`), NEVER ~/.config/recense/recense.db.
 * No live generation — generateDoc is called with a pre-seeded provider stub.
 */
import Database from 'better-sqlite3';
import { describe, test, expect } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { writeDoc } from '../src/consolidation/doc-writer';
import { generateDoc } from '../src/reader/doc-generator';
import type { ModelProvider } from '../src/model/provider';

// ── helpers ────────────────────────────────────────────────────────────────

function makeStore(): { db: Database.Database; store: SemanticStore } {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const clock = new FakeClock(1000);
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: ':memory:' });
  return { db, store };
}

/** Seed a live fact node. */
function seedFact(store: SemanticStore, id: string, value = 'Some fact'): void {
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

/** Seed a live doc node (simulates a previously written doc). */
function seedDoc(store: SemanticStore, db: Database.Database, docId: string, slug: string): void {
  // Use writeDoc to create the doc node with the full sidecar setup.
  seedFact(store, `fact-for-${docId}`);
  writeDoc(store, db, {
    docId,
    slug,
    markdown: `# ${slug} doc`,
    citedFactIds: [`fact-for-${docId}`],
    now: 1000,
  });
}

/**
 * Minimal ModelProvider stub for generateDoc tests.
 * Returns a markdown body with inline recense://doc/<id> refs.
 */
function makeDocRefProvider(markdown: string): ModelProvider {
  return {
    generate: async () => markdown,
    embed: async (texts: string[]) => texts.map(() => new Float32Array(3).fill(0)),
    judge: async () => ({ verdict: 'unrelated' as const, best_candidate_id: undefined, contradicted_ids: [] }),
  } as unknown as ModelProvider;
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('doc_link edge creation (READER-04)', () => {
  // (a) generateDoc returns linkedDocRefs from recense://doc/<id> refs in prose
  test('(a) generateDoc returns linkedDocRefs parsed from recense://doc/<id> refs', async () => {
    const { db, store } = makeStore();
    // Seed the two doc nodes that will be referenced
    seedDoc(store, db, 'doc-target-1', 'target-one');
    seedDoc(store, db, 'doc-target-2', 'target-two');
    // Seed a fact for the doc being generated
    seedFact(store, 'fact-main');

    const markdown = [
      `# My Project`,
      ``,
      `This project links to [target one](recense://doc/doc-target-1) and`,
      `also to [target two](recense://doc/doc-target-2).`,
      ``,
      `A [cited claim](recense://fact/fact-main) from a real fact.`,
    ].join('\n');

    const provider = makeDocRefProvider(markdown);
    const result = await generateDoc({ db, store, provider }, 'myproject');

    expect(result.linkedDocRefs).toBeDefined();
    expect(result.linkedDocRefs).toHaveLength(2);
    expect(result.linkedDocRefs.sort()).toEqual(['doc-target-1', 'doc-target-2'].sort());
  });

  // (b) writeDoc creates one doc_link edge per unique linked doc ref that EXISTS
  test('(b) writeDoc creates doc_link edges to existing doc nodes only', () => {
    const { db, store } = makeStore();
    seedDoc(store, db, 'doc-alpha', 'alpha');
    seedDoc(store, db, 'doc-beta', 'beta');
    seedFact(store, 'fact-for-main');

    writeDoc(store, db, {
      docId: 'doc-main',
      slug: 'main',
      markdown: '# Main linking alpha and beta',
      citedFactIds: ['fact-for-main'],
      linkedDocRefs: ['doc-alpha', 'doc-beta'],
      now: 5000,
    });

    const edges = db.prepare(
      "SELECT src, dst, kind FROM edge WHERE src = ? AND kind = 'doc_link'"
    ).all('doc-main') as Array<{ src: string; dst: string; kind: string }>;

    expect(edges).toHaveLength(2);
    const dsts = edges.map(e => e.dst).sort();
    expect(dsts).toEqual(['doc-alpha', 'doc-beta'].sort());
  });

  // (c) dangling ref (no live doc node) is skipped — no FK violation
  test('(c) dangling recense://doc ref is skipped (no node exists)', () => {
    const { db, store } = makeStore();
    seedDoc(store, db, 'doc-real', 'real');
    seedFact(store, 'fact-for-main');

    writeDoc(store, db, {
      docId: 'doc-main',
      slug: 'main',
      markdown: '# Main',
      citedFactIds: ['fact-for-main'],
      // 'doc-real' exists; 'doc-nonexistent-xxxx' does not
      linkedDocRefs: ['doc-real', 'doc-nonexistent-xxxx'],
      now: 5000,
    });

    const edges = db.prepare(
      "SELECT dst FROM edge WHERE src = ? AND kind = 'doc_link'"
    ).all('doc-main') as Array<{ dst: string }>;

    // Only one edge — the dangling ref is skipped
    expect(edges).toHaveLength(1);
    expect(edges[0]!.dst).toBe('doc-real');

    // FK-clean
    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations).toHaveLength(0);
  });

  // (d) PRAGMA foreign_key_check is empty after doc_link edge creation
  test('(d) PRAGMA foreign_key_check is empty after doc_link edge creation', () => {
    const { db, store } = makeStore();
    seedDoc(store, db, 'doc-ref-target', 'ref-target');
    seedFact(store, 'fact-fk');

    writeDoc(store, db, {
      docId: 'doc-source',
      slug: 'source',
      markdown: '# Source',
      citedFactIds: ['fact-fk'],
      linkedDocRefs: ['doc-ref-target'],
      now: 6000,
    });

    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations).toHaveLength(0);
  });

  // (e) same ref appearing twice is deduped to one doc_link edge
  test('(e) duplicate linkedDocRefs are deduped to one doc_link edge per unique target', () => {
    const { db, store } = makeStore();
    seedDoc(store, db, 'doc-dup-target', 'dup-target');
    seedFact(store, 'fact-dup');

    writeDoc(store, db, {
      docId: 'doc-dup',
      slug: 'dup',
      markdown: '# Dup',
      citedFactIds: ['fact-dup'],
      // Same ref twice
      linkedDocRefs: ['doc-dup-target', 'doc-dup-target'],
      now: 7000,
    });

    const edges = db.prepare(
      "SELECT dst FROM edge WHERE src = ? AND kind = 'doc_link'"
    ).all('doc-dup') as Array<{ dst: string }>;
    expect(edges).toHaveLength(1);
    expect(edges[0]!.dst).toBe('doc-dup-target');
  });

  // (f) tombstoned target doc node is skipped (not a live doc)
  test('(f) ref to tombstoned target doc node is skipped', () => {
    const { db, store } = makeStore();
    // Seed a doc then tombstone it
    seedDoc(store, db, 'doc-tombstoned', 'tombstoned');
    store.tombstone('doc-tombstoned');
    seedFact(store, 'fact-main');

    writeDoc(store, db, {
      docId: 'doc-linker',
      slug: 'linker',
      markdown: '# Linker',
      citedFactIds: ['fact-main'],
      linkedDocRefs: ['doc-tombstoned'],
      now: 8000,
    });

    const edges = db.prepare(
      "SELECT dst FROM edge WHERE src = ? AND kind = 'doc_link'"
    ).all('doc-linker') as Array<{ dst: string }>;
    // Tombstoned doc is not a live node — skip
    expect(edges).toHaveLength(0);

    // FK-clean
    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations).toHaveLength(0);
  });

  // (g) end-to-end: generateDoc + writeDoc produces correct doc_link edges
  test('(g) end-to-end: generateDoc then writeDoc creates the expected doc_link edge', async () => {
    const { db, store } = makeStore();
    seedDoc(store, db, 'doc-linked', 'linked');
    seedFact(store, 'fact-e2e');

    // The generated markdown references doc-linked and a non-existent doc
    const markdown = [
      `# E2E Doc`,
      ``,
      `References [linked project](recense://doc/doc-linked) and`,
      `[missing](recense://doc/does-not-exist-9999).`,
      ``,
      `[A real fact](recense://fact/fact-e2e) here.`,
    ].join('\n');

    const provider = makeDocRefProvider(markdown);
    const result = await generateDoc({ db, store, provider }, 'e2e-slug');

    // generateDoc returns ALL doc refs from the prose; writeDoc is responsible for the in-set guard.
    expect(result.linkedDocRefs).toContain('doc-linked');
    // does-not-exist-9999 IS returned by generateDoc (present in prose) — writeDoc will skip it.
    expect(result.linkedDocRefs).toContain('does-not-exist-9999');

    writeDoc(store, db, {
      docId: result.docId,
      slug: 'e2e-slug',
      markdown: result.markdown,
      citedFactIds: result.citedFactIds,
      linkedDocRefs: result.linkedDocRefs,
      now: 9000,
    });

    const edges = db.prepare(
      "SELECT dst FROM edge WHERE src = ? AND kind = 'doc_link'"
    ).all(result.docId) as Array<{ dst: string }>;

    // Only one edge to 'doc-linked'; dangling skipped
    expect(edges).toHaveLength(1);
    expect(edges[0]!.dst).toBe('doc-linked');

    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations).toHaveLength(0);
  });

  // Source assertion: doc_link in doc-writer.ts
  test('source: doc-writer.ts contains doc_link edge creation', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(
      require('node:path').resolve(__dirname, '../src/consolidation/doc-writer.ts'),
      'utf8',
    );
    expect(src).toContain('doc_link');
    expect(src).toContain('linkedDocRefs');
  });

  // Source assertion: generateDoc parses recense://doc/ refs
  test('source: doc-generator.ts parses recense://doc/ refs and returns linkedDocRefs', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(
      require('node:path').resolve(__dirname, '../src/reader/doc-generator.ts'),
      'utf8',
    );
    expect(src).toContain('recense://doc/');
    expect(src).toContain('linkedDocRefs');
  });
});
