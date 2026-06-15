/**
 * SemanticStore.upsertNodeTemporal idempotent writer tests (Plan 20-01, D-01).
 *
 * Behavioral contract:
 *   - upsertNodeTemporal inserts a node_temporal row for an existing node
 *   - Calling upsertNodeTemporal twice for the same node_id REPLACES (idempotent — one row)
 *   - getNodeTemporal returns stored fields verbatim (due_at, action_type, source_event_id)
 *   - Nullable fields (recurrence_rule, source_event_id) accept null and undefined
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

/** Insert a minimal node row so FK constraint on node_temporal is satisfied. */
function insertNode(db: Database.Database, id: string, value: string = 'test value'): void {
  db.prepare(
    `INSERT INTO node (id, type, value, value_hash, origin, s, c, last_access,
      pending_contradictions, tombstoned, training_eligible)
     VALUES (?, 'fact', ?, 'hash-placeholder', 'observed', 0.1, 0.5, 1000, '[]', 0, 0)`,
  ).run(id, value);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SemanticStore.upsertNodeTemporal', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('inserts a node_temporal row for an existing node', () => {
    insertNode(h.db, 'n1');
    h.store.upsertNodeTemporal({
      node_id: 'n1',
      due_at: '2026-07-04T08:00:00Z',
      action_type: 'flight',
      updated_at: 1000,
    });

    const row = h.store.getNodeTemporal('n1');
    expect(row).not.toBeNull();
    expect(row!.node_id).toBe('n1');
    expect(row!.due_at).toBe('2026-07-04T08:00:00Z');
    expect(row!.action_type).toBe('flight');
  });

  it('returns stored source_event_id verbatim', () => {
    insertNode(h.db, 'n2');
    h.store.upsertNodeTemporal({
      node_id: 'n2',
      due_at: '2026-08-15T09:00:00Z',
      action_type: 'appointment',
      source_event_id: 'gcal-event-abc123',
      updated_at: 2000,
    });

    const row = h.store.getNodeTemporal('n2');
    expect(row!.source_event_id).toBe('gcal-event-abc123');
  });

  it('stores recurrence_rule verbatim', () => {
    insertNode(h.db, 'n3');
    h.store.upsertNodeTemporal({
      node_id: 'n3',
      due_at: '2026-09-01T10:00:00Z',
      action_type: 'meeting',
      recurrence_rule: 'RRULE:FREQ=WEEKLY;BYDAY=MO',
      updated_at: 3000,
    });

    const row = h.store.getNodeTemporal('n3');
    expect(row!.recurrence_rule).toBe('RRULE:FREQ=WEEKLY;BYDAY=MO');
  });

  it('treats undefined recurrence_rule and source_event_id as null', () => {
    insertNode(h.db, 'n4');
    h.store.upsertNodeTemporal({
      node_id: 'n4',
      due_at: '2026-07-01T00:00:00Z',
      action_type: 'deadline',
      updated_at: 4000,
      // recurrence_rule and source_event_id omitted
    });

    const row = h.store.getNodeTemporal('n4');
    expect(row!.recurrence_rule).toBeNull();
    expect(row!.source_event_id).toBeNull();
  });

  it('treats null recurrence_rule and source_event_id as null', () => {
    insertNode(h.db, 'n5');
    h.store.upsertNodeTemporal({
      node_id: 'n5',
      due_at: '2026-07-01T00:00:00Z',
      action_type: 'receipt',
      recurrence_rule: null,
      source_event_id: null,
      updated_at: 5000,
    });

    const row = h.store.getNodeTemporal('n5');
    expect(row!.recurrence_rule).toBeNull();
    expect(row!.source_event_id).toBeNull();
  });

  it('is idempotent: second upsert with new due_at replaces the row (one row, latest value)', () => {
    insertNode(h.db, 'n6');
    h.store.upsertNodeTemporal({
      node_id: 'n6',
      due_at: '2026-07-01T00:00:00Z',
      action_type: 'deadline',
      updated_at: 1000,
    });
    h.store.upsertNodeTemporal({
      node_id: 'n6',
      due_at: '2026-07-15T00:00:00Z',
      action_type: 'payment',
      updated_at: 2000,
    });

    // Exactly one row in node_temporal for n6
    const count = (
      h.db
        .prepare('SELECT COUNT(*) AS n FROM node_temporal WHERE node_id = ?')
        .get('n6') as { n: number }
    ).n;
    expect(count).toBe(1);

    // The latest values are stored
    const row = h.store.getNodeTemporal('n6');
    expect(row!.due_at).toBe('2026-07-15T00:00:00Z');
    expect(row!.action_type).toBe('payment');
  });

  it('returns null for an unknown node_id', () => {
    const row = h.store.getNodeTemporal('does-not-exist');
    expect(row).toBeNull();
  });
});
