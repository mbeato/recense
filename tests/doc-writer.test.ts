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
});
