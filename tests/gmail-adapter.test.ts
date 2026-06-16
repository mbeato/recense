/**
 * GmailAdapter unit tests (Phase 6, plan 04).
 *
 * All tests use injected fake GmailFetcher — no network, no OAuth credentials.
 *
 * Covers:
 *  1. normalizeGmailMessage — provenance header, field mapping, origin='observed'
 *  2. Secrets in body redacted; sender email preserved (D-63/D-64)
 *  3. pull() — 2 messages → 2 records + cursor:gmail written to meta
 *  4. pull() — existing cursor forwarded as startHistoryId (incremental, not backfill)
 *  5. No record ever carries origin='asserted_by_user' (D-61 correctness guard)
 *  6. Guard: constructing GmailAdapter without creds does NOT throw (lazy env read)
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import {
  GmailAdapter,
  normalizeGmailMessage,
  type GmailFetcher,
  type RawGmailMessage,
} from '../src/source/gmail-adapter';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_CONFIG: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

function makeRaw(overrides: Partial<RawGmailMessage> = {}): RawGmailMessage {
  return {
    id: 'msg-001',
    headers: {
      from: 'alice@acme.com',
      subject: 'Re: pricing discussion',
      date: 'Mon, 9 Jun 2026 10:00:00 +0000',
    },
    bodyText: 'Hello, let me know your thoughts on the Q3 pricing.',
    ...overrides,
  };
}

/** Simple fake GmailFetcher — scripted result; captures last call arguments. */
class FakeGmailFetcher implements GmailFetcher {
  public capturedQuery: string | undefined;
  public capturedHistoryId: string | null | undefined;

  constructor(
    private readonly result: {
      messages: RawGmailMessage[];
      newHistoryId: string | null;
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

/** Build a fresh in-memory SemanticStore (mirrors seeder.test.ts setup). */
function makeStore(): SemanticStore {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 5, 9)); // 2026-06-09
  return new SemanticStore(db, clock, TEST_CONFIG);
}

// ── 1. normalizeGmailMessage — field mapping ──────────────────────────────────

describe('normalizeGmailMessage — field mapping', () => {
  it('builds provenance header From: … · Re: …', () => {
    const raw = makeRaw();
    const record = normalizeGmailMessage(raw, 'default', TEST_CONFIG);
    expect(record.content).toMatch(/^From: alice@acme.com · Re: Re: pricing discussion/);
  });

  it('sets external_id to the message id', () => {
    const raw = makeRaw({ id: 'abc-xyz-123' });
    const record = normalizeGmailMessage(raw, 'default', TEST_CONFIG);
    expect(record.external_id).toBe('abc-xyz-123');
  });

  it("sets origin to 'observed' (D-61 HARD-CODED)", () => {
    const record = normalizeGmailMessage(makeRaw(), 'default', TEST_CONFIG);
    expect(record.origin).toBe('observed');
  });

  it("sets source to 'gmail'", () => {
    const record = normalizeGmailMessage(makeRaw(), 'default', TEST_CONFIG);
    expect(record.source).toBe('gmail');
  });

  it("sets role to 'user'", () => {
    const record = normalizeGmailMessage(makeRaw(), 'default', TEST_CONFIG);
    expect(record.role).toBe('user');
  });

  it('concatenates provenance header with body text separated by newline', () => {
    const raw = makeRaw({ bodyText: 'The body content here.' });
    const record = normalizeGmailMessage(raw, 'default', TEST_CONFIG);
    expect(record.content).toContain('\nThe body content here.');
  });
});

// ── 2. Secret redaction — API key removed, sender email preserved (D-63/D-64) ──

describe('normalizeGmailMessage — boundary redaction', () => {
  it('redacts OpenAI API key in body; preserves sender email in provenance header', () => {
    const raw = makeRaw({
      headers: { from: 'bob@example.com', subject: 'API credentials', date: '' },
      bodyText: 'My key is sk-ABCDEFGHIJKLMNOPQRSTU and you should use it.',
    });
    const record = normalizeGmailMessage(raw, 'default', TEST_CONFIG);

    // Secret stripped
    expect(record.content).toContain('[REDACTED:API_KEY]');
    expect(record.content).not.toContain('sk-ABCDEFGHIJKLMNOPQRSTU');

    // Sender email preserved (D-64 — PII is the asset)
    expect(record.content).toContain('bob@example.com');
  });

  it('redaction covers the provenance header too — a secret in Subject is stripped', () => {
    const raw = makeRaw({
      headers: {
        from: 'alice@acme.com',
        subject: 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234',
        date: '',
      },
      bodyText: 'see subject',
    });
    const record = normalizeGmailMessage(raw, 'default', TEST_CONFIG);
    expect(record.content).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234');
  });
});

// ── 3. pull() — 2 messages → 2 records + cursor written ──────────────────────

describe('GmailAdapter.pull() — basic fetch and cursor write', () => {
  let store: SemanticStore;

  beforeEach(() => {
    store = makeStore();
  });

  it('returns one NormalizedRecord per message from the fake fetcher', async () => {
    const fake = new FakeGmailFetcher({
      messages: [
        makeRaw({ id: 'id-1', bodyText: 'first message' }),
        makeRaw({ id: 'id-2', bodyText: 'second message' }),
      ],
      newHistoryId: 'h-999',
    });

    const adapter = new GmailAdapter(TEST_CONFIG, store, 'default', fake);
    const { records } = await adapter.pull();

    expect(records).toHaveLength(2);
    expect(records[0]!.external_id).toBe('id-1');
    expect(records[1]!.external_id).toBe('id-2');
  });

  it('writes newHistoryId to cursor:gmail:default after a successful pull (D-10)', async () => {
    const fake = new FakeGmailFetcher({
      messages: [makeRaw()],
      newHistoryId: 'h-42',
    });

    const adapter = new GmailAdapter(TEST_CONFIG, store, 'default', fake);
    const { commitCursor } = await adapter.pull();

    // M-6: cursor NOT written until commitCursor() is called
    expect(store.getMeta('cursor:gmail:default')).toBeNull();
    commitCursor();
    expect(store.getMeta('cursor:gmail:default')).toBe('h-42');
  });

  it('does NOT write cursor when newHistoryId is null', async () => {
    const fake = new FakeGmailFetcher({
      messages: [],
      newHistoryId: null,
    });

    const adapter = new GmailAdapter(TEST_CONFIG, store, 'default', fake);
    const { commitCursor: commitNull } = await adapter.pull();
    commitNull(); // null newHistoryId → commitCursor is a no-op
    expect(store.getMeta('cursor:gmail:default')).toBeNull();
  });
});

// ── 4. pull() — existing cursor forwarded as startHistoryId ──────────────────

describe('GmailAdapter.pull() — cursor forwarding (incremental)', () => {
  it('passes existing cursor:gmail:default as startHistoryId to the fetcher (D-10)', async () => {
    const store = makeStore();
    // Pre-populate an existing per-account cursor (D-10 key format)
    store.setMeta('cursor:gmail:default', 'h-100');

    const fake = new FakeGmailFetcher({
      messages: [],
      newHistoryId: 'h-200',
    });

    const adapter = new GmailAdapter(TEST_CONFIG, store, 'default', fake);
    await adapter.pull();

    expect(fake.capturedHistoryId).toBe('h-100');
  });

  it('passes null as startHistoryId when no prior cursor exists (backfill path)', async () => {
    const store = makeStore();
    // No cursor set — first pull

    const fake = new FakeGmailFetcher({
      messages: [],
      newHistoryId: 'h-001',
    });

    const adapter = new GmailAdapter(TEST_CONFIG, store, 'default', fake);
    await adapter.pull();

    expect(fake.capturedHistoryId).toBeNull();
  });
});

// ── 5. No record ever carries origin='asserted_by_user' (D-61 guard) ─────────

describe('GmailAdapter.pull() — D-61 origin guard', () => {
  it("no returned record has origin='asserted_by_user'", async () => {
    const store = makeStore();
    const fake = new FakeGmailFetcher({
      messages: [
        makeRaw({ id: 'a' }),
        makeRaw({ id: 'b' }),
        makeRaw({ id: 'c' }),
      ],
      newHistoryId: 'h-1',
    });

    const adapter = new GmailAdapter(TEST_CONFIG, store, 'default', fake);
    const { records } = await adapter.pull();

    for (const record of records) {
      expect(record.origin).not.toBe('asserted_by_user');
    }
  });

  it("normalizeGmailMessage always returns origin='observed', never user-assertion", () => {
    const raws: RawGmailMessage[] = [
      makeRaw({ id: 'x1' }),
      makeRaw({ id: 'x2', bodyText: 'I always prefer TypeScript' }), // sounds directive-like
      makeRaw({ id: 'x3', bodyText: 'Actually that was wrong' }), // sounds like correction
    ];

    for (const raw of raws) {
      const record = normalizeGmailMessage(raw, 'default', TEST_CONFIG);
      expect(record.origin).toBe('observed');
    }
  });
});

// ── 6. Lazy construction guard — no env read at new time (D-68/T-06-12) ──────

describe('GmailAdapter — lazy env construction guard', () => {
  it('constructing GmailAdapter (default real fetcher) does NOT throw when creds absent', () => {
    const store = makeStore();

    // Temporarily remove Gmail env vars to prove construction doesn't read them
    const saved = {
      clientId: process.env['GMAIL_CLIENT_ID'],
      clientSecret: process.env['GMAIL_CLIENT_SECRET'],
      refreshToken: process.env['GMAIL_REFRESH_TOKEN'],
    };
    delete process.env['GMAIL_CLIENT_ID'];
    delete process.env['GMAIL_CLIENT_SECRET'];
    delete process.env['GMAIL_REFRESH_TOKEN'];

    try {
      // Must NOT throw — creds are only needed on first pull() call, not at new
      expect(() => new GmailAdapter(TEST_CONFIG, store)).not.toThrow();
    } finally {
      // Restore env vars regardless of test outcome
      if (saved.clientId !== undefined) process.env['GMAIL_CLIENT_ID'] = saved.clientId;
      if (saved.clientSecret !== undefined) process.env['GMAIL_CLIENT_SECRET'] = saved.clientSecret;
      if (saved.refreshToken !== undefined) process.env['GMAIL_REFRESH_TOKEN'] = saved.refreshToken;
    }
  });

  it('pull() with the real fetcher throws when creds are missing (lazy read confirmed)', async () => {
    const store = makeStore();

    const saved = {
      clientId: process.env['GMAIL_CLIENT_ID'],
      clientSecret: process.env['GMAIL_CLIENT_SECRET'],
      refreshToken: process.env['GMAIL_REFRESH_TOKEN'],
    };
    delete process.env['GMAIL_CLIENT_ID'];
    delete process.env['GMAIL_CLIENT_SECRET'];
    delete process.env['GMAIL_REFRESH_TOKEN'];

    let threwOnPull = false;
    try {
      const adapter = new GmailAdapter(TEST_CONFIG, store); // must NOT throw here
      await adapter.pull(); // MUST throw here (creds missing on first call)
    } catch {
      threwOnPull = true;
    } finally {
      if (saved.clientId !== undefined) process.env['GMAIL_CLIENT_ID'] = saved.clientId;
      if (saved.clientSecret !== undefined) process.env['GMAIL_CLIENT_SECRET'] = saved.clientSecret;
      if (saved.refreshToken !== undefined) process.env['GMAIL_REFRESH_TOKEN'] = saved.refreshToken;
    }

    // Confirms creds are read lazily on pull(), not at construction
    expect(threwOnPull).toBe(true);
  });
});
