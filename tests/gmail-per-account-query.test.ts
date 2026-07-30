/**
 * gmail-per-account-query tests (Phase 62, plan 01 — EMAIL-02).
 *
 * Covers:
 *  1. resolveAccountQuery / GmailAdapter.pull() — per-account query with fallback
 *     to the global gmail.query, including independently-keyed cursors.
 *  2. Pitfall-8 regression lock: the incremental (users.history.list) branch
 *     carries no `q`, while the query-backfill (users.messages.list) branch does —
 *     proving the two branches differ, not just that one string is absent.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import {
  GmailAdapter,
  type GmailFetcher,
  type RawGmailMessage,
} from '../src/source/gmail-adapter';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRaw(overrides: Partial<RawGmailMessage> = {}): RawGmailMessage {
  return {
    id: 'msg-001',
    headers: { from: 'alice@acme.com', subject: 'test', date: '' },
    bodyText: 'body',
    ...overrides,
  };
}

/** Fake GmailFetcher — scripted result; captures last call arguments. */
class FakeGmailFetcher implements GmailFetcher {
  public capturedQuery: string | undefined;
  public capturedHistoryId: string | null | undefined;

  constructor(
    private readonly result: { messages: RawGmailMessage[]; newHistoryId: string | null } = {
      messages: [makeRaw()],
      newHistoryId: 'hist-1',
    }
  ) {}

  async fetchMessages(
    query: string,
    startHistoryId: string | null
  ): Promise<{ messages: RawGmailMessage[]; newHistoryId: string | null }> {
    this.capturedQuery = query;
    this.capturedHistoryId = startHistoryId;
    return this.result;
  }
}

function makeStore(): SemanticStore {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 5, 9));
  return new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: ':memory:' });
}

function configWith(googleAccounts: EngineConfig['googleAccounts']): EngineConfig {
  return { ...DEFAULT_CONFIG, dbPath: ':memory:', googleAccounts };
}

// ── 1. Per-account query resolution ────────────────────────────────────────────

describe('GmailAdapter.pull() — per-account query resolution (EMAIL-02)', () => {
  it('an adapter for "work" with a configured query calls fetchMessages with that query', async () => {
    const config = configWith([{ id: 'default' }, { id: 'work', query: 'label:job-search' }]);
    const store = makeStore();
    const fetcher = new FakeGmailFetcher();
    const adapter = new GmailAdapter(config, store, 'work', fetcher);

    await adapter.pull();

    expect(fetcher.capturedQuery).toBe('label:job-search');
  });

  it('an adapter for "default" in the same config calls fetchMessages with config.gmail.query', async () => {
    const config = configWith([{ id: 'default' }, { id: 'work', query: 'label:job-search' }]);
    const store = makeStore();
    const fetcher = new FakeGmailFetcher();
    const adapter = new GmailAdapter(config, store, 'default', fetcher);

    await adapter.pull();

    expect(fetcher.capturedQuery).toBe(config.gmail.query);
  });

  it('an adapter for an id absent from googleAccounts falls back to config.gmail.query', async () => {
    const config = configWith([{ id: 'default' }]);
    const store = makeStore();
    const fetcher = new FakeGmailFetcher();
    const adapter = new GmailAdapter(config, store, 'ghost', fetcher);

    await adapter.pull();

    expect(fetcher.capturedQuery).toBe(config.gmail.query);
  });

  it('an account whose query is "" or all-whitespace falls back to config.gmail.query', async () => {
    const configEmpty = configWith([{ id: 'work', query: '' }]);
    const configWhitespace = configWith([{ id: 'work', query: '   ' }]);
    const store = makeStore();

    const fetcherEmpty = new FakeGmailFetcher();
    await new GmailAdapter(configEmpty, store, 'work', fetcherEmpty).pull();
    expect(fetcherEmpty.capturedQuery).toBe(configEmpty.gmail.query);

    const fetcherWhitespace = new FakeGmailFetcher();
    await new GmailAdapter(configWhitespace, store, 'work', fetcherWhitespace).pull();
    expect(fetcherWhitespace.capturedQuery).toBe(configWhitespace.gmail.query);
  });

  it('two adapters over the same meta store use independently-keyed cursors and each keeps its own query', async () => {
    const config = configWith([{ id: 'default' }, { id: 'work', query: 'label:job-search' }]);
    const store = makeStore();

    const fetcherDefault = new FakeGmailFetcher({ messages: [makeRaw()], newHistoryId: 'hist-default' });
    const adapterDefault = new GmailAdapter(config, store, 'default', fetcherDefault);
    const { commitCursor: commitDefault } = await adapterDefault.pull();
    commitDefault();

    const fetcherWork = new FakeGmailFetcher({ messages: [makeRaw()], newHistoryId: 'hist-work' });
    const adapterWork = new GmailAdapter(config, store, 'work', fetcherWork);
    const { commitCursor: commitWork } = await adapterWork.pull();
    commitWork();

    expect(store.getMeta('cursor:gmail:default')).toBe('hist-default');
    expect(store.getMeta('cursor:gmail:work')).toBe('hist-work');
    expect(fetcherDefault.capturedQuery).toBe(config.gmail.query);
    expect(fetcherWork.capturedQuery).toBe('label:job-search');

    // Second pull per account passes its own persisted cursor, still resolving its own query.
    const fetcherWork2 = new FakeGmailFetcher();
    const adapterWork2 = new GmailAdapter(config, store, 'work', fetcherWork2);
    await adapterWork2.pull();
    expect(fetcherWork2.capturedHistoryId).toBe('hist-work');
    expect(fetcherWork2.capturedQuery).toBe('label:job-search');
  });
});

// ── 2. Pitfall-8 regression lock — incremental branch carries no `q` ──────────

describe('Pitfall-8 regression lock — users.history.list carries no q; users.messages.list does', () => {
  const source = readFileSync(join(__dirname, '../src/source/gmail-adapter.ts'), 'utf8');

  function sliceBetween(text: string, startMarker: string, endMarker: string): string {
    const start = text.indexOf(startMarker);
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf(endMarker, start);
    expect(end).toBeGreaterThan(start);
    return text.slice(start, end);
  }

  it('the users.history.list call site carries no q (locks in backfill-only scoping, EMAIL-02)', () => {
    const historySlice = sliceBetween(source, 'gmail.users.history.list({', '});');
    // A future change adding `q` here would silently alter the documented backfill-only
    // semantics — this regression test is the tripwire.
    expect(historySlice).not.toMatch(/(^|[^A-Za-z0-9_])q\s*:/);
  });

  it('the users.messages.list call site (query-backfill branch) DOES carry q — proves the branches differ', () => {
    const messagesSlice = sliceBetween(source, 'gmail.users.messages.list({', '});');
    expect(messagesSlice).toMatch(/(^|[^A-Za-z0-9_])q\s*:/);
  });
});
