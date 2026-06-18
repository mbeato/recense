/**
 * node-doc-store tests (READER-01, 27-01 Task 2).
 *
 * Covers:
 *  (a) NodeType accepts 'doc'; EdgeKind accepts 'cites' and 'doc_link' (compile-time via typed fixture).
 *  (b) upsertNodeDoc insert + getNodeDoc read round-trip.
 *  (c) Second upsert with different updated_at preserves original generated_at (write-once).
 *  (d) getNodeDoc returns undefined for unknown node_id.
 */
import Database from 'better-sqlite3';
import { describe, test, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { NodeType, EdgeKind, NodeDocRow, UpsertNodeDocParams } from '../src/lib/types';

// ── Typed fixture: compile-time check that 'doc', 'cites', 'doc_link' are accepted ──────

// If NodeType doesn't include 'doc', this will produce a TypeScript error at compile time.
const _typeCheck: NodeType = 'doc';
// If EdgeKind doesn't include 'cites' or 'doc_link', this will produce TS errors.
const _kindCheckCites: EdgeKind = 'cites';
const _kindCheckDocLink: EdgeKind = 'doc_link';

// Suppress unused variable warning
void _typeCheck;
void _kindCheckCites;
void _kindCheckDocLink;

// ── helpers ────────────────────────────────────────────────────────────────

function makeStore(): { db: Database.Database; store: SemanticStore } {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(1000);
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: ':memory:' });
  return { db, store };
}

/** Insert a doc node via upsertNode so we have a valid FK target. */
function seedDocNode(store: SemanticStore, id: string): void {
  store.upsertNode({
    id,
    type: 'doc',
    value: `# Doc ${id}`,
    origin: 'inferred',
    s: 0,
    c: 1.0,
    last_access: 1000,
  });
}

// ── (b) insert + read round-trip ──────────────────────────────────────────

describe('SemanticStore.upsertNodeDoc + getNodeDoc', () => {
  test('upsertNodeDoc inserts a row; getNodeDoc returns it', () => {
    const { store } = makeStore();
    seedDocNode(store, 'doc-1');

    const params: UpsertNodeDocParams = {
      node_id: 'doc-1',
      slug: 'my-project',
      generated_at: 5000,
      updated_at: 5000,
    };
    store.upsertNodeDoc(params);

    const row: NodeDocRow | undefined = store.getNodeDoc('doc-1');
    expect(row).toBeDefined();
    expect(row!.node_id).toBe('doc-1');
    expect(row!.slug).toBe('my-project');
    expect(row!.generated_at).toBe(5000);
    expect(row!.updated_at).toBe(5000);
  });

  test('getNodeDoc returns undefined for unknown node_id', () => {
    const { store } = makeStore();
    const row = store.getNodeDoc('does-not-exist');
    expect(row).toBeUndefined();
  });

  // ── (c) second upsert preserves original generated_at ──────────────────

  test('second upsertNodeDoc updates updated_at but preserves generated_at', () => {
    const { store } = makeStore();
    seedDocNode(store, 'doc-2');

    // First insert: generated_at = 1000, updated_at = 1000
    store.upsertNodeDoc({ node_id: 'doc-2', slug: 'proj-a', generated_at: 1000, updated_at: 1000 });

    // Second call (simulating a re-render without regen): updated_at advances, generated_at must NOT change
    store.upsertNodeDoc({ node_id: 'doc-2', slug: 'proj-a', generated_at: 9999, updated_at: 2000 });

    const row = store.getNodeDoc('doc-2');
    expect(row).toBeDefined();
    // generated_at must stay at 1000 (the original first-write value)
    expect(row!.generated_at).toBe(1000);
    // updated_at reflects the latest write
    expect(row!.updated_at).toBe(2000);
  });

  test('slug can be updated on second upsert', () => {
    const { store } = makeStore();
    seedDocNode(store, 'doc-3');

    store.upsertNodeDoc({ node_id: 'doc-3', slug: 'proj-old', generated_at: 500, updated_at: 500 });
    store.upsertNodeDoc({ node_id: 'doc-3', slug: 'proj-new', generated_at: 9999, updated_at: 600 });

    const row = store.getNodeDoc('doc-3');
    expect(row!.slug).toBe('proj-new');
    expect(row!.generated_at).toBe(500);  // unchanged
    expect(row!.updated_at).toBe(600);
  });

  // ── multiple docs — each has independent generated_at ──────────────────

  test('multiple doc nodes each have independent node_doc rows', () => {
    const { store } = makeStore();
    seedDocNode(store, 'doc-a');
    seedDocNode(store, 'doc-b');

    store.upsertNodeDoc({ node_id: 'doc-a', slug: 'proj-a', generated_at: 100, updated_at: 100 });
    store.upsertNodeDoc({ node_id: 'doc-b', slug: 'proj-b', generated_at: 200, updated_at: 200 });

    const rowA = store.getNodeDoc('doc-a');
    const rowB = store.getNodeDoc('doc-b');

    expect(rowA!.slug).toBe('proj-a');
    expect(rowA!.generated_at).toBe(100);
    expect(rowB!.slug).toBe('proj-b');
    expect(rowB!.generated_at).toBe(200);
  });
});
