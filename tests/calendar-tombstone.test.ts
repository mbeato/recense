/**
 * calendar-tombstone tests (Phase 20, plan 04 — D-05/CONSOL-03).
 *
 * Covers runCalendarCancellations:
 *  1. Node for cancelled master 'evt-A' is tombstoned; 'evt-B' node untouched
 *  2. Meta calendar:cancelled:default is cleared after tombstoning
 *  3. Empty/absent cancelled set → no-op (returns 0)
 *  4. buildAdapters: calendar.enabled=false → zero CalendarAdapter instances
 *  5. buildAdapters: calendar.enabled=true + two accounts → two CalendarAdapter instances
 *  6. knownSources includes 'gcal'
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { runCalendarCancellations } from '../src/consolidation/calendar-tombstone';
import { buildAdapters } from '../src/adapter/ingest-cli';

// ── Shared helpers ────────────────────────────────────────────────────────────

const TEST_CONFIG: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

const stubMeta = {
  getMeta: (_key: string): string | null => null,
  setMeta: (_key: string, _value: string): void => { /* noop */ },
};

function makeStore(): { db: Database.Database; store: SemanticStore } {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 5, 15));
  const store = new SemanticStore(db, clock, TEST_CONFIG);
  return { db, store };
}

/**
 * Insert a node + node_temporal row with the given source_event_id.
 * Returns the node id so callers can assert tombstoned state.
 */
function insertNodeWithTemporal(
  store: SemanticStore,
  nodeId: string,
  sourceEventId: string,
): string {
  store.upsertNode({
    id: nodeId,
    type: 'fact',
    value: `Calendar event ${nodeId}`,
    origin: 'observed',
  });
  store.upsertNodeTemporal({
    node_id: nodeId,
    due_at: '2026-07-01T10:00:00.000Z',
    action_type: 'meeting',
    recurrence_rule: null,
    source_event_id: sourceEventId,
    updated_at: Date.UTC(2026, 5, 15),
  });
  return nodeId;
}

// ── 1-2. Tombstone a cancelled master, clear the meta set ────────────────────

describe('runCalendarCancellations — tombstones cancelled master nodes', () => {
  let store: SemanticStore;

  beforeEach(() => {
    ({ store } = makeStore());
    insertNodeWithTemporal(store, 'node-A', 'evt-A');
    insertNodeWithTemporal(store, 'node-B', 'evt-B');
    // Set cancelled set: only evt-A
    store.setMeta('calendar:cancelled:default', JSON.stringify(['evt-A']));
  });

  it('tombstones the node whose source_event_id matches the cancelled master', () => {
    runCalendarCancellations(store, store, ['default']);

    const nodeA = store.getNode('node-A');
    expect(nodeA).not.toBeNull();
    expect(nodeA!.tombstoned).toBe(1);
  });

  it('leaves the non-cancelled node untouched', () => {
    runCalendarCancellations(store, store, ['default']);

    const nodeB = store.getNode('node-B');
    expect(nodeB).not.toBeNull();
    expect(nodeB!.tombstoned).toBe(0);
  });

  it('clears the cancelled set after tombstoning (idempotent)', () => {
    runCalendarCancellations(store, store, ['default']);

    const cancelled: string[] = JSON.parse(
      store.getMeta('calendar:cancelled:default') ?? '[]'
    );
    expect(cancelled).toHaveLength(0);
  });

  it('returns the count of tombstoned nodes', () => {
    const count = runCalendarCancellations(store, store, ['default']);
    expect(count).toBe(1);
  });
});

// ── 3. Empty cancelled set → no-op ───────────────────────────────────────────

describe('runCalendarCancellations — empty/absent cancelled set is a no-op', () => {
  it('returns 0 when the cancelled set is empty', () => {
    const { store } = makeStore();
    insertNodeWithTemporal(store, 'node-A', 'evt-A');
    // No cancelled set in meta

    const count = runCalendarCancellations(store, store, ['default']);
    expect(count).toBe(0);

    const nodeA = store.getNode('node-A');
    expect(nodeA!.tombstoned).toBe(0);
  });

  it('returns 0 when the cancelled set is explicitly empty ([])', () => {
    const { store } = makeStore();
    store.setMeta('calendar:cancelled:default', '[]');

    const count = runCalendarCancellations(store, store, ['default']);
    expect(count).toBe(0);
  });
});

// ── 4-6. buildAdapters gcal wiring + knownSources ─────────────────────────────

describe('buildAdapters — gcal wiring', () => {
  it('calendar.enabled=false → zero CalendarAdapter instances (fail-safe)', () => {
    const config: EngineConfig = {
      ...TEST_CONFIG,
      enabledSources: ['gcal'],
      calendar: { enabled: false },
      googleAccounts: [{ id: 'default' }],
    };
    const adapters = buildAdapters(config, stubMeta);
    expect(adapters.filter(a => a.source === 'gcal')).toHaveLength(0);
  });

  it('calendar.enabled=true + two accounts → two CalendarAdapter instances', () => {
    const config: EngineConfig = {
      ...TEST_CONFIG,
      enabledSources: ['gcal'],
      calendar: { enabled: true },
      googleAccounts: [{ id: 'default' }, { id: 'work' }],
    };
    const adapters = buildAdapters(config, stubMeta);
    const calAdapters = adapters.filter(a => a.source === 'gcal');
    expect(calAdapters).toHaveLength(2);
  });

  it("'gcal' is in knownSources (does not log unknown-source warning)", () => {
    // We can't easily inspect knownSources directly; instead verify buildAdapters
    // with calendar.enabled=true produces adapters (no "unknown source" fallthrough)
    const config: EngineConfig = {
      ...TEST_CONFIG,
      enabledSources: ['gcal'],
      calendar: { enabled: true },
      googleAccounts: [{ id: 'default' }],
    };
    // Should not throw and should return adapter (not fall through to unknown-source log)
    expect(() => buildAdapters(config, stubMeta)).not.toThrow();
    const adapters = buildAdapters(config, stubMeta);
    expect(adapters).toHaveLength(1);
  });
});
