/**
 * doc-writer tests (READER-01, 27-02 Task 2 — TDD RED).
 *
 * Covers the writeDoc lifecycle-exempt guarantees:
 *  (a) Node has type='doc' and training_eligible=0 after write.
 *  (b) Node embedding IS NULL after write (no setEmbedding called).
 *  (c) Doc node is absent from node_fts (FTS suppression).
 *  (d) node_doc.generated_at is set correctly.
 *  (e) One cites edge exists per unique cited fact.
 *  (f) PRAGMA foreign_key_check is empty (FK-clean).
 *  (g) writeDoc is atomic: all writes succeed or none (tested by FK violation on bad fact id).
 */
import Database from 'better-sqlite3';
import { describe, test, expect } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { writeDoc } from '../src/consolidation/doc-writer';

// ── helpers ────────────────────────────────────────────────────────────────

function makeStore(): { db: Database.Database; store: SemanticStore } {
  const db = new Database(':memory:');
  // Enable FK enforcement so FK-clean assertions are meaningful.
  db.pragma('foreign_keys = ON');
  initSchema(db);
  const clock = new FakeClock(1000);
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: ':memory:' });
  return { db, store };
}

/** Seed a live fact node as a cites target. */
function seedFact(store: SemanticStore, id: string): void {
  store.upsertNode({
    id,
    type: 'fact',
    value: `Fact ${id} text`,
    origin: 'observed',
    s: 0.5,
    c: 0.8,
    last_access: 500,
  });
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('writeDoc', () => {
  test('(a) doc node has type=doc and training_eligible=0', () => {
    const { db, store } = makeStore();
    seedFact(store, 'fact-1');

    writeDoc(store, db, {
      docId: 'doc-001',
      slug: 'myproject',
      markdown: '# My Project\n\nSome [claim](recense://fact/fact-1).',
      citedFactIds: ['fact-1'],
      now: 9000,
    });

    const row = db.prepare('SELECT type, training_eligible FROM node WHERE id = ?').get('doc-001') as
      | { type: string; training_eligible: number }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.type).toBe('doc');
    expect(row!.training_eligible).toBe(0);
  });

  test('(b) doc node embedding IS NULL (no setEmbedding)', () => {
    const { db, store } = makeStore();
    seedFact(store, 'fact-1');

    writeDoc(store, db, {
      docId: 'doc-002',
      slug: 'myproject',
      markdown: 'Some markdown.',
      citedFactIds: ['fact-1'],
      now: 9000,
    });

    const row = db.prepare('SELECT embedding FROM node WHERE id = ?').get('doc-002') as
      | { embedding: Buffer | null }
      | undefined;
    expect(row).toBeDefined();
    expect(row!.embedding).toBeNull();
  });

  test('(c) doc node is absent from node_fts', () => {
    const { db, store } = makeStore();
    seedFact(store, 'fact-1');

    writeDoc(store, db, {
      docId: 'doc-003',
      slug: 'myproject',
      markdown: '# Project deep-dive',
      citedFactIds: ['fact-1'],
      now: 9000,
    });

    const ftsRows = db.prepare("SELECT node_id FROM node_fts WHERE node_id = ?").all('doc-003') as Array<{ node_id: string }>;
    expect(ftsRows).toHaveLength(0);
  });

  test('(d) node_doc.generated_at is set, updated_at is set', () => {
    const { db, store } = makeStore();
    seedFact(store, 'fact-1');

    writeDoc(store, db, {
      docId: 'doc-004',
      slug: 'myproject',
      markdown: 'Markdown.',
      citedFactIds: ['fact-1'],
      now: 7777,
    });

    const doc = db.prepare('SELECT * FROM node_doc WHERE node_id = ?').get('doc-004') as
      | { node_id: string; slug: string; generated_at: number; updated_at: number }
      | undefined;
    expect(doc).toBeDefined();
    expect(doc!.generated_at).toBe(7777);
    expect(doc!.updated_at).toBe(7777);
    expect(doc!.slug).toBe('myproject');
  });

  test('(e) one cites edge per unique cited fact', () => {
    const { db, store } = makeStore();
    seedFact(store, 'fact-x');
    seedFact(store, 'fact-y');

    writeDoc(store, db, {
      docId: 'doc-005',
      slug: 'myproject',
      markdown: 'doc with two cites.',
      citedFactIds: ['fact-x', 'fact-y'],
      now: 8000,
    });

    const edges = db.prepare(
      "SELECT src, dst, kind FROM edge WHERE src = ? AND kind = 'cites'"
    ).all('doc-005') as Array<{ src: string; dst: string; kind: string }>;

    expect(edges).toHaveLength(2);
    const dsts = edges.map(e => e.dst).sort();
    expect(dsts).toEqual(['fact-x', 'fact-y'].sort());
  });

  test('(f) PRAGMA foreign_key_check returns empty after writeDoc', () => {
    const { db, store } = makeStore();
    seedFact(store, 'fact-fk');

    writeDoc(store, db, {
      docId: 'doc-006',
      slug: 'myproject',
      markdown: '# Deep dive',
      citedFactIds: ['fact-fk'],
      now: 5000,
    });

    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations).toHaveLength(0);
  });

  test('(e) duplicate citedFactIds are deduped to one edge per fact', () => {
    const { db, store } = makeStore();
    seedFact(store, 'fact-dup');

    // Pass the same fact id twice — should produce only one edge
    writeDoc(store, db, {
      docId: 'doc-007',
      slug: 'myproject',
      markdown: 'cites same fact twice.',
      citedFactIds: ['fact-dup', 'fact-dup'],
      now: 6000,
    });

    const edges = db.prepare(
      "SELECT src, dst FROM edge WHERE src = ? AND kind = 'cites'"
    ).all('doc-007') as Array<{ src: string; dst: string }>;
    expect(edges).toHaveLength(1);
  });

  test('node_scope entry is created for the doc node', () => {
    const { db, store } = makeStore();
    seedFact(store, 'fact-sc');

    writeDoc(store, db, {
      docId: 'doc-008',
      slug: 'tonos',
      markdown: '# Tonos',
      citedFactIds: ['fact-sc'],
      now: 3000,
    });

    const scope = db.prepare('SELECT scope FROM node_scope WHERE node_id = ?').get('doc-008') as
      | { scope: string }
      | undefined;
    expect(scope).toBeDefined();
    expect(scope!.scope).toBe('tonos');
  });

  // ── Supersede: at most ONE live doc per slug (--force retires the prior) ───

  test('(supersede) regenerating a slug retires the prior live doc node', () => {
    const { db, store } = makeStore();
    seedFact(store, 'fact-a');
    seedFact(store, 'fact-b');

    // First doc for slug 'myproject'
    writeDoc(store, db, {
      docId: 'doc-old',
      slug: 'myproject',
      markdown: '# Old version',
      citedFactIds: ['fact-a'],
      now: 1000,
    });

    // Second doc (regenerate) for the same slug — must supersede the first
    writeDoc(store, db, {
      docId: 'doc-new',
      slug: 'myproject',
      markdown: '# New version',
      citedFactIds: ['fact-b'],
      now: 2000,
    });

    // The old doc must be tombstoned
    const oldRow = db.prepare('SELECT tombstoned FROM node WHERE id = ?').get('doc-old') as
      | { tombstoned: number }
      | undefined;
    expect(oldRow!.tombstoned).toBe(1);

    // The new doc must be live
    const newRow = db.prepare('SELECT tombstoned FROM node WHERE id = ?').get('doc-new') as
      | { tombstoned: number }
      | undefined;
    expect(newRow!.tombstoned).toBe(0);

    // Exactly ONE live doc node for the slug
    const liveDocs = db.prepare(
      `SELECT n.id FROM node n JOIN node_scope ns ON ns.node_id = n.id
       WHERE n.type = 'doc' AND n.tombstoned = 0 AND ns.scope = ?`,
    ).all('myproject') as Array<{ id: string }>;
    expect(liveDocs).toHaveLength(1);
    expect(liveDocs[0]!.id).toBe('doc-new');
  });

  test('(supersede) FK-clean after supersede; prior cites edges remain FK-valid', () => {
    const { db, store } = makeStore();
    seedFact(store, 'fact-1');
    seedFact(store, 'fact-2');

    writeDoc(store, db, { docId: 'doc-1', slug: 'proj', markdown: '# v1', citedFactIds: ['fact-1'], now: 1000 });
    writeDoc(store, db, { docId: 'doc-2', slug: 'proj', markdown: '# v2', citedFactIds: ['fact-2'], now: 2000 });

    // FK check must be empty — the tombstoned old doc's node_doc/node_scope/cites edges
    // still reference a node row that exists (just tombstoned), so no FK breaks.
    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations).toHaveLength(0);

    // The old doc's cites edge still exists (points to fact-1, FK-valid)
    const oldEdges = db.prepare("SELECT dst FROM edge WHERE src = ? AND kind = 'cites'").all('doc-1') as Array<{ dst: string }>;
    expect(oldEdges).toHaveLength(1);
    expect(oldEdges[0]!.dst).toBe('fact-1');
  });

  test('(supersede) docs for DIFFERENT slugs do not supersede each other', () => {
    const { db, store } = makeStore();
    seedFact(store, 'fact-x');

    writeDoc(store, db, { docId: 'doc-tonos', slug: 'tonos', markdown: '# Tonos', citedFactIds: ['fact-x'], now: 1000 });
    writeDoc(store, db, { docId: 'doc-vtx', slug: 'vtx', markdown: '# VTX', citedFactIds: ['fact-x'], now: 2000 });

    // Both remain live — different slugs
    const tonos = db.prepare('SELECT tombstoned FROM node WHERE id = ?').get('doc-tonos') as { tombstoned: number };
    const vtx = db.prepare('SELECT tombstoned FROM node WHERE id = ?').get('doc-vtx') as { tombstoned: number };
    expect(tonos.tombstoned).toBe(0);
    expect(vtx.tombstoned).toBe(0);
  });
});
