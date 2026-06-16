/**
 * ingest-cli multi-account tests (Phase 20, plan 03 — TEMP-04).
 *
 * Covers:
 *  1. DEFAULT_CONFIG.calendar.enabled === false and googleAccounts defaults
 *  2. DEFAULT_SALIENCE_CONFIG gcal weights: sourceWeights.gcal === 0.45,
 *     consolSkipThresholdBySource.gcal === 0.3
 *  3. buildAdapters with two accounts returns two gmail adapters using per-account cursors
 *  4. migrateLegacyCursorGmail: legacy cursor:gmail → cursor:gmail:default once; no-op on repeat
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import {
  buildAdapters,
  migrateLegacyCursorGmail,
} from '../src/adapter/ingest-cli';
import type { GmailFetcher, RawGmailMessage } from '../src/source/gmail-adapter';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_CONFIG: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

/** Minimal MetaStore stub for tests that don't need a real SemanticStore. */
const stubMeta = {
  getMeta: (_key: string): string | null => null,
  setMeta: (_key: string, _value: string): void => { /* noop */ },
};

function makeRaw(id = 'msg-001'): RawGmailMessage {
  return {
    id,
    headers: { from: 'sender@example.com', subject: 'test', date: '' },
    bodyText: 'body',
  };
}

class FakeGmailFetcher implements GmailFetcher {
  public capturedHistoryId: string | null | undefined;
  constructor(private readonly historyId: string | null) {}
  async fetchMessages(
    _query: string,
    startHistoryId: string | null
  ): Promise<{ messages: RawGmailMessage[]; newHistoryId: string | null }> {
    this.capturedHistoryId = startHistoryId;
    return { messages: [makeRaw()], newHistoryId: this.historyId };
  }
}

function makeStore(): { db: Database.Database; store: SemanticStore } {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 5, 15));
  const store = new SemanticStore(db, clock, TEST_CONFIG);
  return { db, store };
}

// ── 1. DEFAULT_CONFIG calendar + googleAccounts ────────────────────────────────

describe('DEFAULT_CONFIG — calendar and googleAccounts defaults', () => {
  it('calendar.enabled defaults to false (fail-safe — no Calendar adapter without explicit opt-in)', () => {
    expect(DEFAULT_CONFIG.calendar.enabled).toBe(false);
  });

  it('googleAccounts defaults to [{ id: "default" }] (backward-compat single-account path)', () => {
    expect(DEFAULT_CONFIG.googleAccounts).toEqual([{ id: 'default' }]);
  });
});

// ── 2. DEFAULT_SALIENCE_CONFIG gcal weights ────────────────────────────────────

describe('DEFAULT_SALIENCE_CONFIG — gcal source weights', () => {
  it('sourceWeights.gcal === 0.45 (D-09: more structured than email 0.35, below obsidian 0.9)', () => {
    expect(DEFAULT_CONFIG.salience.sourceWeights['gcal']).toBe(0.45);
  });

  it('consolSkipThresholdBySource.gcal === 0.3 (moderate skip threshold for structured events)', () => {
    expect(DEFAULT_CONFIG.salience.consolSkipThresholdBySource['gcal']).toBe(0.3);
  });
});

// ── 3. buildAdapters — two gmail accounts → two per-account adapters ───────────

describe('buildAdapters — multi-account gmail (TEMP-04)', () => {
  let db: Database.Database;
  let store: SemanticStore;

  beforeEach(() => {
    ({ db, store } = makeStore());
  });

  afterEach(() => {
    db.close();
  });

  it('with googleAccounts=[default, work] and gmail enabled → two adapters, both source=gmail', () => {
    const config: EngineConfig = {
      ...TEST_CONFIG,
      enabledSources: ['gmail'],
      googleAccounts: [{ id: 'default' }, { id: 'work' }],
    };
    const adapters = buildAdapters(config, stubMeta);
    expect(adapters).toHaveLength(2);
    for (const a of adapters) {
      expect(a.source).toBe('gmail');
    }
  });

  it("'default' adapter reads cursor:gmail:default and 'work' adapter reads cursor:gmail:work (D-10)", async () => {
    const fakeDefault = new FakeGmailFetcher('def-hist-1');
    const fakeWork = new FakeGmailFetcher('work-hist-1');

    // Pre-populate per-account cursors
    store.setMeta('cursor:gmail:default', 'prev-def');
    store.setMeta('cursor:gmail:work', 'prev-work');

    // Build adapters with injected fetchers
    // We create them directly to inject fakes, then verify cursor isolation
    const { GmailAdapter } = await import('../src/source/gmail-adapter');
    const config: EngineConfig = {
      ...TEST_CONFIG,
      googleAccounts: [{ id: 'default' }, { id: 'work' }],
    };

    const defAdapter = new GmailAdapter(config, store, 'default', fakeDefault);
    const workAdapter = new GmailAdapter(config, store, 'work', fakeWork);

    await defAdapter.pull();
    await workAdapter.pull();

    expect(fakeDefault.capturedHistoryId).toBe('prev-def');
    expect(fakeWork.capturedHistoryId).toBe('prev-work');
  });

  it("two accounts write to independent cursor keys (D-10 isolation)", async () => {
    const fakeDefault = new FakeGmailFetcher('new-def-h');
    const fakeWork = new FakeGmailFetcher('new-work-h');

    const { GmailAdapter } = await import('../src/source/gmail-adapter');
    const config: EngineConfig = {
      ...TEST_CONFIG,
      googleAccounts: [{ id: 'default' }, { id: 'work' }],
    };

    const defAdapter = new GmailAdapter(config, store, 'default', fakeDefault);
    const workAdapter = new GmailAdapter(config, store, 'work', fakeWork);

    const { commitCursor: commitDef } = await defAdapter.pull();
    const { commitCursor: commitWork } = await workAdapter.pull();
    commitDef();
    commitWork();

    expect(store.getMeta('cursor:gmail:default')).toBe('new-def-h');
    expect(store.getMeta('cursor:gmail:work')).toBe('new-work-h');
    // Legacy key untouched (migration not triggered here — no legacy cursor present)
    expect(store.getMeta('cursor:gmail')).toBeNull();
  });

  it('with googleAccounts=[default] (DEFAULT_CONFIG) and gmail enabled → one adapter', () => {
    const config: EngineConfig = { ...TEST_CONFIG, enabledSources: ['gmail'] };
    // TEST_CONFIG inherits googleAccounts: [{ id: 'default' }] from DEFAULT_CONFIG
    const adapters = buildAdapters(config, stubMeta);
    expect(adapters).toHaveLength(1);
    expect(adapters[0]!.source).toBe('gmail');
  });
});

// ── 4. migrateLegacyCursorGmail — D-10 one-time migration ──────────────────────

describe('migrateLegacyCursorGmail — legacy cursor:gmail → cursor:gmail:default (D-10)', () => {
  let db: Database.Database;
  let store: SemanticStore;

  beforeEach(() => {
    ({ db, store } = makeStore());
  });

  afterEach(() => {
    db.close();
  });

  it('copies cursor:gmail to cursor:gmail:default when only the legacy key exists', () => {
    store.setMeta('cursor:gmail', 'hist-123');
    const logs: string[] = [];
    migrateLegacyCursorGmail(store, (msg) => logs.push(msg));
    expect(store.getMeta('cursor:gmail:default')).toBe('hist-123');
    expect(logs.some(l => l.includes('cursor migration'))).toBe(true);
  });

  it('is a no-op on second run (cursor:gmail:default already set)', () => {
    store.setMeta('cursor:gmail', 'hist-123');
    const logs: string[] = [];

    // First run — migrates
    migrateLegacyCursorGmail(store, (msg) => logs.push(msg));
    expect(store.getMeta('cursor:gmail:default')).toBe('hist-123');

    // Mutate legacy key — second run must NOT overwrite the already-migrated value
    store.setMeta('cursor:gmail', 'hist-456');
    const logs2: string[] = [];
    migrateLegacyCursorGmail(store, (msg) => logs2.push(msg));

    // Still 'hist-123', not 'hist-456' (idempotent)
    expect(store.getMeta('cursor:gmail:default')).toBe('hist-123');
    // No migration log on the second run
    expect(logs2).toHaveLength(0);
  });

  it('is a no-op when no legacy cursor:gmail exists', () => {
    // No cursor:gmail set — nothing to migrate
    const logs: string[] = [];
    migrateLegacyCursorGmail(store, (msg) => logs.push(msg));
    expect(store.getMeta('cursor:gmail:default')).toBeNull();
    expect(logs).toHaveLength(0);
  });

  it('does not touch cursor:gmail:work or any other per-account cursors', () => {
    store.setMeta('cursor:gmail', 'hist-abc');
    store.setMeta('cursor:gmail:work', 'work-h-99');

    migrateLegacyCursorGmail(store, () => {});

    expect(store.getMeta('cursor:gmail:default')).toBe('hist-abc');
    // work cursor untouched
    expect(store.getMeta('cursor:gmail:work')).toBe('work-h-99');
  });
});
