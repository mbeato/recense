/**
 * EMAIL-04: parseEmailDate + normalizeGmailMessage/GmailAdapter.pull() event_ts coverage.
 *
 * parseEmailDate is the security-load-bearing parse of an attacker-controlled Date: header
 * (T-62-23/24/25) — confident-or-null, with a bounded future-skew clamp.
 *
 * Covers:
 *  1. parseEmailDate — well-formed headers (numeric offset, named zone), empty/whitespace/
 *     malformed → null, below-plausibility-floor → null, beyond-future-skew → null,
 *     24h-future passes and is clamped to nowMs (CR-03) / 72h-future rejected, never throws,
 *     pure/deterministic.
 *  2. normalizeGmailMessage — event_ts from the default fixture date; null on empty/far-future
 *     date; every other field unchanged; provenance header carries no date.
 *  3. End-to-end: GmailAdapter.pull() over two messages a month apart returns two records
 *     whose event_ts values differ and match their respective headers.
 */
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import {
  GmailAdapter,
  normalizeGmailMessage,
  parseEmailDate,
  type GmailFetcher,
  type RawGmailMessage,
} from '../src/source/gmail-adapter';

const TEST_CONFIG: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };
const NOW = Date.UTC(2026, 5, 9); // 2026-06-09T00:00:00Z

function makeRaw(overrides: Partial<RawGmailMessage> = {}): RawGmailMessage {
  return {
    id: 'msg-001',
    threadId: 'thread-001',
    headers: {
      from: 'alice@acme.com',
      subject: 'Re: pricing discussion',
      // CR-03 reconciliation: this must be <= NOW (2026-06-09T00:00:00Z), not on the same
      // day at a later time-of-day — the clamp now returns nowMs for ANY header later than
      // nowMs, so a same-day-but-later fixture would silently be clamped and no longer
      // exercise plain well-formed parsing. See the CR-03 reconciliation note below.
      date: 'Mon, 8 Jun 2026 10:00:00 +0000',
    },
    bodyText: 'Hello, let me know your thoughts on the Q3 pricing.',
    ...overrides,
  };
}

// ── 1. parseEmailDate ──────────────────────────────────────────────────────────

// CR-03 reconciliation (plan 62-10): before the clamp, a header later than NOW but still
// inside the accepted window parsed to its raw (unclamped) value, so these three fixtures
// — originally 'Mon, 9 Jun 2026 10:00:00', ten hours AFTER NOW=2026-06-09T00:00:00Z — happened
// to sit in that accepted-future window and asserted the unclamped value. Post-clamp, any
// header later than nowMs now correctly returns nowMs, which would make these fixtures
// silently start testing the clamp instead of plain well-formed parsing. Moved to the day
// BEFORE NOW so they stay outside the clamp's reach and keep testing what they always meant
// to test: correct RFC 2822 parsing. The clamp itself is tested by its own dedicated
// describe block in tests/gmail-future-date-ordering.test.ts and by the 24h-future case below.
describe('parseEmailDate — bounded, attacker-hostile Date: header parse (EMAIL-04)', () => {
  it('parses a well-formed RFC 2822 header to the correct epoch ms', () => {
    const result = parseEmailDate('Mon, 8 Jun 2026 10:00:00 +0000', NOW);
    expect(result).toBe(Date.UTC(2026, 5, 8, 10, 0, 0));
  });

  it('parses a header with a numeric offset (+0530)', () => {
    const result = parseEmailDate('Mon, 8 Jun 2026 10:00:00 +0530', NOW);
    expect(result).not.toBeNull();
    expect(result).toBe(Date.parse('Mon, 8 Jun 2026 10:00:00 +0530'));
  });

  it('parses a header with a named zone (GMT)', () => {
    const result = parseEmailDate('Mon, 8 Jun 2026 10:00:00 GMT', NOW);
    expect(result).not.toBeNull();
    expect(result).toBe(Date.parse('Mon, 8 Jun 2026 10:00:00 GMT'));
  });

  it("empty string returns null", () => {
    expect(parseEmailDate('', NOW)).toBeNull();
  });

  it("whitespace-only string returns null", () => {
    expect(parseEmailDate('   ', NOW)).toBeNull();
  });

  it("'not a date' returns null", () => {
    expect(parseEmailDate('not a date', NOW)).toBeNull();
  });

  it('a header below the plausibility floor (1970) returns null', () => {
    expect(parseEmailDate('Thu, 01 Jan 1970 00:00:00 +0000', NOW)).toBeNull();
  });

  it('a header beyond the future-skew tolerance (2036) returns null', () => {
    expect(parseEmailDate('Mon, 9 Jun 2036 10:00:00 +0000', NOW)).toBeNull();
  });

  it('a header 24 hours in the future PARSES (inside the 48h tolerance) and is clamped to nowMs', () => {
    const future24h = new Date(NOW + 24 * 60 * 60 * 1000).toUTCString();
    expect(parseEmailDate(future24h, NOW)).not.toBeNull();
    // CR-03: the clamp is what makes this NOW rather than NOW + 24h — a silent revert of
    // the clamp fails this assertion even though the non-null assertion above still holds.
    expect(parseEmailDate(future24h, NOW)).toBe(NOW);
  });

  it('a header 72 hours in the future returns null (beyond the 48h tolerance)', () => {
    const future72h = new Date(NOW + 72 * 60 * 60 * 1000).toUTCString();
    expect(parseEmailDate(future72h, NOW)).toBeNull();
  });

  it('never throws for any of the above inputs', () => {
    const inputs = [
      '', '   ', 'not a date', 'Thu, 01 Jan 1970 00:00:00 +0000',
      'Mon, 9 Jun 2036 10:00:00 +0000', 'Mon, 9 Jun 2026 10:00:00 +0000',
    ];
    for (const input of inputs) {
      expect(() => parseEmailDate(input, NOW)).not.toThrow();
    }
  });

  it('is pure — the same input yields the same output and the input string is unmodified', () => {
    const header = 'Mon, 9 Jun 2026 10:00:00 +0000';
    const before = header;
    const a = parseEmailDate(header, NOW);
    const b = parseEmailDate(header, NOW);
    expect(a).toBe(b);
    expect(header).toBe(before);
  });
});

// ── 2. normalizeGmailMessage — event_ts wiring ────────────────────────────────

describe('normalizeGmailMessage — event_ts from Date: header (EMAIL-04)', () => {
  it('a message with the default fixture date yields the matching non-null event_ts', () => {
    const record = normalizeGmailMessage(makeRaw(), 'default', TEST_CONFIG, NOW);
    expect(record.event_ts).toBe(Date.UTC(2026, 5, 8, 10, 0, 0));
  });

  it("a message with date: '' yields event_ts === null", () => {
    const raw = makeRaw({ headers: { from: 'alice@acme.com', subject: 'Re: pricing discussion', date: '' } });
    const record = normalizeGmailMessage(raw, 'default', TEST_CONFIG, NOW);
    expect(record.event_ts).toBeNull();
  });

  it('a message with a far-future date yields event_ts === null while every other field is unchanged', () => {
    const raw = makeRaw({
      headers: { from: 'alice@acme.com', subject: 'Re: pricing discussion', date: 'Mon, 9 Jun 2036 10:00:00 +0000' },
    });
    const withFarFuture = normalizeGmailMessage(raw, 'default', TEST_CONFIG, NOW);
    const withDefault = normalizeGmailMessage(makeRaw(), 'default', TEST_CONFIG, NOW);

    expect(withFarFuture.event_ts).toBeNull();
    // Every other field is identical to the otherwise-same default-date message.
    expect(withFarFuture.content).toBe(withDefault.content);
    expect(withFarFuture.source).toBe(withDefault.source);
    expect(withFarFuture.external_id).toBe(withDefault.external_id);
    expect(withFarFuture.origin).toBe(withDefault.origin);
    expect(withFarFuture.role).toBe(withDefault.role);
  });

  it('record.content still matches the provenance shape with no date interpolated into it', () => {
    const record = normalizeGmailMessage(makeRaw(), 'default', TEST_CONFIG, NOW);
    expect(record.content).toMatch(/^From: .* · Re: .* · Acct: /);
    expect(record.content).not.toContain('2026-06-08');
    expect(record.content).not.toContain('Mon, 8 Jun 2026');
  });
});

// ── 3. End-to-end — GmailAdapter.pull() ───────────────────────────────────────

class FakeGmailFetcher implements GmailFetcher {
  constructor(private readonly messages: RawGmailMessage[]) {}
  async fetchMessages(
    _query: string,
    _startHistoryId: string | null
  ): Promise<{ messages: RawGmailMessage[]; newHistoryId: string | null }> {
    return { messages: this.messages, newHistoryId: 'h-1' };
  }
}

function makeStore(): SemanticStore {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(NOW);
  return new SemanticStore(db, clock, TEST_CONFIG);
}

describe('GmailAdapter.pull() — event_ts end-to-end (EMAIL-04)', () => {
  it('two messages dated a month apart return two records whose event_ts values differ and match their headers', async () => {
    const store = makeStore();
    const olderDate = 'Mon, 9 Mar 2026 10:00:00 +0000';
    const newerDate = 'Tue, 9 Jun 2026 10:00:00 +0000';
    const fake = new FakeGmailFetcher([
      makeRaw({ id: 'older-msg', headers: { from: 'a@x.com', subject: 'older', date: olderDate } }),
      makeRaw({ id: 'newer-msg', headers: { from: 'b@x.com', subject: 'newer', date: newerDate } }),
    ]);

    const adapter = new GmailAdapter(TEST_CONFIG, store, 'default', fake);
    const { records } = await adapter.pull();

    expect(records).toHaveLength(2);
    const older = records.find(r => r.external_id === 'older-msg')!;
    const newer = records.find(r => r.external_id === 'newer-msg')!;

    expect(older.event_ts).toBe(Date.parse(olderDate));
    expect(newer.event_ts).toBe(Date.parse(newerDate));
    expect(older.event_ts).not.toBe(newer.event_ts);
  });
});
