/**
 * SemanticStore.upsertNodeScope / getNodeScope / getNodeScopes tests (Plan 999.3-01, D-S2).
 *
 * Behavioral contract:
 *   - upsertNodeScope inserts a node_scope row for an existing node.
 *   - A second upsert for the same node_id REPLACES (idempotent — one row, latest scope).
 *   - getNodeScope returns the stored scope, or undefined when none exists.
 *   - getNodeScopes(ids[]) batch-reads a Map<node_id, scope> for recall surfacing.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';

interface Harness {
  db: Database.Database;
  store: SemanticStore;
  clock: FakeClock;
}

const TEST_CONFIG: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

function makeHarness(): Harness {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(1_000);
  const store = new SemanticStore(db, clock, TEST_CONFIG);
  return { db, store, clock };
}

/** Insert a minimal node row so the FK on node_scope is satisfied. */
function insertNode(db: Database.Database, id: string, value: string = 'test value'): void {
  db.prepare(
    `INSERT INTO node (id, type, value, value_hash, origin, s, c, last_access,
      pending_contradictions, tombstoned, training_eligible)
     VALUES (?, 'fact', ?, 'hash-placeholder', 'observed', 0.1, 0.5, 1000, '[]', 0, 0)`,
  ).run(id, value);
}

describe('SemanticStore.upsertNodeScope / getNodeScope', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('inserts a node_scope row for an existing node', () => {
    insertNode(h.db, 'n1');
    h.store.upsertNodeScope({ node_id: 'n1', scope: 'vtx', updated_at: 1000 });
    expect(h.store.getNodeScope('n1')).toBe('vtx');
  });

  it('returns undefined for a node with no scope row', () => {
    insertNode(h.db, 'n2');
    expect(h.store.getNodeScope('n2')).toBeUndefined();
  });

  it('returns undefined for an unknown node_id', () => {
    expect(h.store.getNodeScope('does-not-exist')).toBeUndefined();
  });

  it('is idempotent: a second upsert replaces the row (one row, latest scope)', () => {
    insertNode(h.db, 'n3');
    h.store.upsertNodeScope({ node_id: 'n3', scope: 'vtx', updated_at: 1000 });
    h.store.upsertNodeScope({ node_id: 'n3', scope: 'global', updated_at: 2000 });

    const count = (
      h.db.prepare('SELECT COUNT(*) AS n FROM node_scope WHERE node_id = ?').get('n3') as { n: number }
    ).n;
    expect(count).toBe(1);
    expect(h.store.getNodeScope('n3')).toBe('global');
  });

  it('stores updated_at verbatim', () => {
    insertNode(h.db, 'n4');
    h.store.upsertNodeScope({ node_id: 'n4', scope: 'tonos', updated_at: 4242 });
    const row = h.db
      .prepare('SELECT updated_at FROM node_scope WHERE node_id = ?')
      .get('n4') as { updated_at: number };
    expect(row.updated_at).toBe(4242);
  });
});

describe('SemanticStore.getNodeScopes (batch)', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('returns a Map of node_id → scope for multiple ids', () => {
    insertNode(h.db, 'a');
    insertNode(h.db, 'b');
    insertNode(h.db, 'c');
    h.store.upsertNodeScope({ node_id: 'a', scope: 'vtx', updated_at: 1 });
    h.store.upsertNodeScope({ node_id: 'b', scope: 'global', updated_at: 1 });
    // c has no scope row

    const map = h.store.getNodeScopes(['a', 'b', 'c']);
    expect(map.get('a')).toBe('vtx');
    expect(map.get('b')).toBe('global');
    expect(map.has('c')).toBe(false);
  });

  it('returns an empty Map for an empty id list', () => {
    const map = h.store.getNodeScopes([]);
    expect(map.size).toBe(0);
  });

  it('handles a single id', () => {
    insertNode(h.db, 'solo');
    h.store.upsertNodeScope({ node_id: 'solo', scope: 'brain-memory', updated_at: 1 });
    const map = h.store.getNodeScopes(['solo']);
    expect(map.get('solo')).toBe('brain-memory');
  });
});
