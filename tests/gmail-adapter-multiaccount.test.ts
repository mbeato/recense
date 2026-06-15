/**
 * GmailAdapter multi-account tests (Phase 20, plan 03 — TEMP-04).
 *
 * All tests use injected FakeGmailFetcher — no network, no OAuth credentials.
 *
 * Covers:
 *  1. normalizeGmailMessage carries · Acct: <accountId> in provenance header (D-09)
 *  2. GmailAdapter writes/reads cursor:gmail:<accountId> (D-10)
 *  3. Default account uses cursor:gmail:default (D-10 backward-compat)
 *  4. Every record has source==='gmail' and origin==='observed' (D-09/D-61 guards)
 *  5. Constructing GmailAdapter('work') without env creds does NOT throw (D-68 lazy read)
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
      from: 'alice@work.com',
      subject: 'Q3 budget review',
      date: 'Mon, 15 Jun 2026 10:00:00 +0000',
    },
    bodyText: 'Please review the attached Q3 budget spreadsheet.',
    ...overrides,
  };
}

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

function makeStore(): SemanticStore {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 5, 15)); // 2026-06-15
  return new SemanticStore(db, clock, TEST_CONFIG);
}

// ── 1. normalizeGmailMessage — account id in provenance header (D-09) ──────────

describe('normalizeGmailMessage — account id in provenance header (D-09)', () => {
  it("'work' account id appears as '· Acct: work' in content", () => {
    const raw = makeRaw();
    const record = normalizeGmailMessage(raw, 'work', TEST_CONFIG);
    expect(record.content).toContain('· Acct: work');
  });

  it("'default' account id appears as '· Acct: default' in content", () => {
    const raw = makeRaw();
    const record = normalizeGmailMessage(raw, 'default', TEST_CONFIG);
    expect(record.content).toContain('· Acct: default');
  });

  it('source stays gmail regardless of account id (D-09 — weighting unchanged)', () => {
    const raw = makeRaw();
    expect(normalizeGmailMessage(raw, 'work', TEST_CONFIG).source).toBe('gmail');
    expect(normalizeGmailMessage(raw, 'personal', TEST_CONFIG).source).toBe('gmail');
  });

  it('origin stays observed regardless of account id (D-61 correctness guard)', () => {
    const raw = makeRaw();
    expect(normalizeGmailMessage(raw, 'work', TEST_CONFIG).origin).toBe('observed');
  });

  it('account id is embedded between subject and body — full header shape', () => {
    const raw = makeRaw({ headers: { from: 'bob@co.com', subject: 'Hello', date: '' } });
    const record = normalizeGmailMessage(raw, 'work', TEST_CONFIG);
    // Full provenance: "From: bob@co.com · Re: Hello · Acct: work"
    expect(record.content).toMatch(/^From: bob@co\.com · Re: Hello · Acct: work/);
  });
});

// ── 2. Per-account cursor key (D-10) ──────────────────────────────────────────

describe("GmailAdapter — per-account cursor key 'cursor:gmail:<id>' (D-10)", () => {
  let store: SemanticStore;

  beforeEach(() => {
    store = makeStore();
  });

  it("'work' account writes to cursor:gmail:work (D-10)", async () => {
    const fake = new FakeGmailFetcher({ messages: [makeRaw()], newHistoryId: 'work-h-1' });
    const adapter = new GmailAdapter(TEST_CONFIG, store, 'work', fake);
    const { commitCursor } = await adapter.pull();

    expect(store.getMeta('cursor:gmail:work')).toBeNull(); // not written yet (M-6)
    commitCursor();
    expect(store.getMeta('cursor:gmail:work')).toBe('work-h-1');
  });

  it("'default' account writes to cursor:gmail:default (D-10)", async () => {
    const fake = new FakeGmailFetcher({ messages: [makeRaw()], newHistoryId: 'def-h-1' });
    const adapter = new GmailAdapter(TEST_CONFIG, store, 'default', fake);
    const { commitCursor } = await adapter.pull();

    commitCursor();
    expect(store.getMeta('cursor:gmail:default')).toBe('def-h-1');
  });

  it("'work' adapter reads its own cursor:gmail:work and passes it as startHistoryId", async () => {
    store.setMeta('cursor:gmail:work', 'prev-work-h-5');
    const fake = new FakeGmailFetcher({ messages: [], newHistoryId: null });
    const adapter = new GmailAdapter(TEST_CONFIG, store, 'work', fake);
    await adapter.pull();
    expect(fake.capturedHistoryId).toBe('prev-work-h-5');
  });

  it('two accounts have independent cursors — no cross-contamination', async () => {
    const fakeWork = new FakeGmailFetcher({ messages: [], newHistoryId: 'w-h-99' });
    const fakeDef = new FakeGmailFetcher({ messages: [], newHistoryId: 'd-h-77' });

    const workAdapter = new GmailAdapter(TEST_CONFIG, store, 'work', fakeWork);
    const defAdapter = new GmailAdapter(TEST_CONFIG, store, 'default', fakeDef);

    const { commitCursor: commitWork } = await workAdapter.pull();
    const { commitCursor: commitDef } = await defAdapter.pull();
    commitWork();
    commitDef();

    expect(store.getMeta('cursor:gmail:work')).toBe('w-h-99');
    expect(store.getMeta('cursor:gmail:default')).toBe('d-h-77');
  });
});

// ── 3. D-09/D-61 source+origin guards ──────────────────────────────────────────

describe('GmailAdapter.pull() — source and origin guards (D-09/D-61)', () => {
  it("every record from 'work' account has source==='gmail' and origin==='observed'", async () => {
    const store = makeStore();
    const fake = new FakeGmailFetcher({
      messages: [
        makeRaw({ id: 'w1' }),
        makeRaw({ id: 'w2' }),
        makeRaw({ id: 'w3' }),
      ],
      newHistoryId: null,
    });
    const adapter = new GmailAdapter(TEST_CONFIG, store, 'work', fake);
    const { records } = await adapter.pull();

    for (const r of records) {
      expect(r.source).toBe('gmail');
      expect(r.origin).toBe('observed');
    }
  });

  it("source stays 'gmail' not 'gmail:work' — source never includes account suffix (D-09)", async () => {
    const store = makeStore();
    const fake = new FakeGmailFetcher({
      messages: [makeRaw({ id: 'x1' })],
      newHistoryId: null,
    });
    const adapter = new GmailAdapter(TEST_CONFIG, store, 'work', fake);
    const { records } = await adapter.pull();

    expect(records[0]!.source).toBe('gmail');
    expect(records[0]!.source).not.toContain(':');
  });
});

// ── 4. Lazy credential read — construction must NOT throw when creds absent (D-68) ───

describe("GmailAdapter('work') — lazy credential read (D-68)", () => {
  it("constructing GmailAdapter('work') without GOOGLE_WORK_REFRESH_TOKEN does NOT throw", () => {
    const store = makeStore();

    // Save and remove all Google/Gmail env vars to prove construction is side-effect-free
    const saved: Record<string, string | undefined> = {
      GOOGLE_CLIENT_ID: process.env['GOOGLE_CLIENT_ID'],
      GOOGLE_CLIENT_SECRET: process.env['GOOGLE_CLIENT_SECRET'],
      GOOGLE_WORK_REFRESH_TOKEN: process.env['GOOGLE_WORK_REFRESH_TOKEN'],
      GMAIL_CLIENT_ID: process.env['GMAIL_CLIENT_ID'],
      GMAIL_CLIENT_SECRET: process.env['GMAIL_CLIENT_SECRET'],
      GMAIL_REFRESH_TOKEN: process.env['GMAIL_REFRESH_TOKEN'],
    };
    for (const key of Object.keys(saved)) {
      delete process.env[key];
    }

    try {
      // Must NOT throw — creds are only needed on first pull() call, not at new
      expect(() => new GmailAdapter(TEST_CONFIG, store, 'work')).not.toThrow();
    } finally {
      for (const [key, val] of Object.entries(saved)) {
        if (val !== undefined) process.env[key] = val;
      }
    }
  });
});
