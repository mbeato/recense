/**
 * gmail-provenance-key.test.ts — Phase 65, Plan 65-06 (DRIFT-03/DRIFT-04).
 *
 * This suite is the ADAPTER-LEVEL half of DRIFT-03: it proves `threadId` flows from a
 * fake fetcher into `RawGmailMessage`, that `normalizeGmailMessage` derives and reports
 * `provenance_key` correctly behind the D-14 dark-launch switch, and that
 * `record.content` stays byte-identical (D-06's scope fence) regardless of the switch.
 * The PURE key derivation itself (domain normalization, residual gating, adversarial
 * From:/threadId handling) is proven in isolation in `tests/provenance-key.test.ts` —
 * this file does not re-prove that; it proves the wiring around it.
 *
 * It is also the FIRST HALF of DRIFT-04: the query-backfill chronological reorder
 * (`orderGmailBackfillByEventTime` + its `GmailAdapter.pull()` wiring). The SECOND half —
 * the routing-decision confidence damping and staleness guard — is proven in
 * `tests/status-drift.test.ts`.
 *
 * The content-invariance case below is the SHIPPED ENFORCEMENT of D-06's scope fence:
 * quote-stripping/provenance-key derivation must never leak into `record.content`.
 */
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { COLLAPSED_GMAIL_PROVENANCE_KEY } from '../src/source/provenance-key';
import {
  GmailAdapter,
  normalizeGmailMessage,
  orderGmailBackfillByEventTime,
  type GmailFetcher,
  type RawGmailMessage,
} from '../src/source/gmail-adapter';
import type { NormalizedRecord } from '../src/source/source-adapter';

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 5, 9);

const ENABLED_CONFIG: EngineConfig = {
  ...DEFAULT_CONFIG,
  dbPath: ':memory:',
  provenanceDistinctnessEnabled: true,
};
const DISABLED_CONFIG: EngineConfig = {
  ...DEFAULT_CONFIG,
  dbPath: ':memory:',
  provenanceDistinctnessEnabled: false,
};

function makeRaw(overrides: Partial<RawGmailMessage> = {}): RawGmailMessage {
  return {
    id: 'msg-001',
    threadId: 't1',
    headers: {
      from: 'hr@acme.com',
      subject: 'Status update',
      date: '',
    },
    bodyText: 'We are moving forward with the next round of interviews.',
    ...overrides,
  };
}

function forwardBody(sender: string, body = 'We regret to inform you that your application was not successful at this time.'): string {
  return `---------- Forwarded message ----------\nFrom: ${sender}\nSubject: Fwd: status\n\n${body}`;
}

/** Fake GmailFetcher — scripted result; counts invocations (D-04 "zero new API calls" proof). */
class FakeGmailFetcher implements GmailFetcher {
  public callCount = 0;
  public capturedHistoryId: string | null | undefined;

  constructor(
    private readonly result: { messages: RawGmailMessage[]; newHistoryId: string | null }
  ) {}

  async fetchMessages(
    _query: string,
    startHistoryId: string | null
  ): Promise<{ messages: RawGmailMessage[]; newHistoryId: string | null }> {
    this.callCount += 1;
    this.capturedHistoryId = startHistoryId;
    return this.result;
  }
}

/** Minimal MetaStore stub — structurally satisfies GmailAdapter's private MetaStore interface. */
function makeMetaStub(cursor: string | null): { getMeta(key: string): string | null; setMeta(key: string, value: string): void } {
  const store = new Map<string, string>();
  return {
    getMeta: (_key: string) => cursor,
    setMeta: (key: string, value: string) => { store.set(key, value); },
  };
}

/** Real SemanticStore-backed meta store, for tests that don't care about cursor value. */
function makeStore(): SemanticStore {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(NOW);
  return new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: ':memory:' });
}

// ── threadId flows ────────────────────────────────────────────────────────────

describe('threadId flows from fake fetcher into RawGmailMessage and into the derived key', () => {
  it('a fake fetcher returning threadId "abc123" produces a RawGmailMessage carrying it, and the derived key uses it', async () => {
    const fake = new FakeGmailFetcher({
      messages: [makeRaw({ id: 'm1', threadId: 'abc123' })],
      newHistoryId: 'h-1',
    });
    const store = makeStore();
    const adapter = new GmailAdapter(ENABLED_CONFIG, store, 'default', fake);
    const { records } = await adapter.pull();

    expect(records[0]!.provenance_key).toBe('ingest:gmail:acme.com:abc123');
  });
});

// ── Enabled / disabled dark-launch switch ─────────────────────────────────────

describe('provenance_key — D-14 dark-launch switch', () => {
  it('enabled: hr@acme.com on thread t1 with real body content yields the composed key', () => {
    const record = normalizeGmailMessage(makeRaw(), 'default', ENABLED_CONFIG, NOW);
    expect(record.provenance_key).toBe('ingest:gmail:acme.com:t1');
  });

  it('disabled (stock): the SAME message yields the collapsed key', () => {
    const record = normalizeGmailMessage(makeRaw(), 'default', DISABLED_CONFIG, NOW);
    expect(record.provenance_key).toBe(COLLAPSED_GMAIL_PROVENANCE_KEY);
  });
});

// ── Content invariance (D-06 scope fence) ─────────────────────────────────────

describe('content invariance — D-06 scope fence enforcement', () => {
  it('record.content is byte-identical between enabled and disabled runs, and matches the exact expected string', () => {
    const enabled = normalizeGmailMessage(makeRaw(), 'default', ENABLED_CONFIG, NOW);
    const disabled = normalizeGmailMessage(makeRaw(), 'default', DISABLED_CONFIG, NOW);

    const EXPECTED_CONTENT =
      'From: hr@acme.com · Re: Status update · Acct: default\n' +
      'We are moving forward with the next round of interviews.';

    // Exact-string assertion, not just cross-run equality: comparing only the two runs to
    // each other would pass even if BOTH had regressed identically.
    expect(enabled.content).toBe(EXPECTED_CONTENT);
    expect(disabled.content).toBe(EXPECTED_CONTENT);
    expect(enabled.content).toBe(disabled.content);
  });
});

// ── Raw-body sourcing (proves derivation reads raw.bodyText, not strippedBody) ───

describe('raw-body sourcing — the derivation reads raw.bodyText, never strippedBody', () => {
  // Mirrors gmail-adapter.ts's own MAX_STRIP_INPUT_CODE_UNITS value (not exported —
  // this suite intentionally does not import it, matching tests/gmail-hidden-content.test.ts's
  // own mirrored-constant discipline).
  const CAP_LENGTH = 1048576;

  it('a body longer than the strip cap, leading with a forward marker, still yields the collapsed key', () => {
    const overCapBody =
      forwardBody('HR <hr@acme.com>') + 'x'.repeat(CAP_LENGTH + 1000);
    expect(overCapBody.length).toBeGreaterThan(CAP_LENGTH);

    const raw = makeRaw({ id: 'over-cap', threadId: 't-huge', headers: { from: 'a@huge.com', subject: 'Fwd', date: '' }, bodyText: overCapBody });
    const record = normalizeGmailMessage(raw, 'default', ENABLED_CONFIG, NOW);

    // If the derivation wrongly read strippedBody (the short STRIP_INPUT_OMITTED_MARKER
    // sentinel for an over-cap body), that marker text reads as "no quote markers, plenty
    // of residual" and would NOT collapse — this assertion is what a strippedBody
    // regression breaks. See Mutation check #1 in 65-06-SUMMARY.md.
    expect(record.provenance_key).toBe(COLLAPSED_GMAIL_PROVENANCE_KEY);
  });
});

// ── Missing threadId ───────────────────────────────────────────────────────────

describe('missing threadId', () => {
  it('threadId === "" yields the collapsed key even when enabled', () => {
    const record = normalizeGmailMessage(makeRaw({ threadId: '' }), 'default', ENABLED_CONFIG, NOW);
    expect(record.provenance_key).toBe(COLLAPSED_GMAIL_PROVENANCE_KEY);
  });
});

// ── Three-independent / three-forward at adapter level ────────────────────────

describe('three-independent vs three-forward — adapter level', () => {
  it('three fake-fetched messages with distinct senders, threads, and real bodies yield three distinct keys', async () => {
    const fake = new FakeGmailFetcher({
      messages: [
        makeRaw({ id: 'i1', threadId: 'thread-1', headers: { from: 'recruiter@acme.com', subject: 's1', date: '' }, bodyText: 'We would like to schedule an interview next week.' }),
        makeRaw({ id: 'i2', threadId: 'thread-2', headers: { from: 'no-reply@bigco.example', subject: 's2', date: '' }, bodyText: 'Your application status has been updated to rejected.' }),
        makeRaw({ id: 'i3', threadId: 'thread-3', headers: { from: 'hiring@thirdco.test', subject: 's3', date: '' }, bodyText: 'Unfortunately we are moving forward with other candidates.' }),
      ],
      newHistoryId: 'h-i',
    });
    const store = makeStore();
    const adapter = new GmailAdapter(ENABLED_CONFIG, store, 'default', fake);
    const { records } = await adapter.pull();

    const keys = records.map(r => r.provenance_key);
    expect(new Set(keys).size).toBe(3);
  });

  it('three fake-fetched forwards of one thread, distinct forwarding senders and thread ids, yield ONE collapsed key', async () => {
    const fake = new FakeGmailFetcher({
      messages: [
        makeRaw({ id: 'f1', threadId: 'thread-b1', headers: { from: 'a@one.test', subject: 'Fwd: status', date: '' }, bodyText: forwardBody('HR <hr@acme.com>') }),
        makeRaw({ id: 'f2', threadId: 'thread-b2', headers: { from: 'b@two.test', subject: 'Fwd: status', date: '' }, bodyText: forwardBody('HR <hr@acme.com>') }),
        makeRaw({ id: 'f3', threadId: 'thread-b3', headers: { from: 'c@three.test', subject: 'Fwd: status', date: '' }, bodyText: forwardBody('HR <hr@acme.com>') }),
      ],
      newHistoryId: 'h-f',
    });
    const store = makeStore();
    const adapter = new GmailAdapter(ENABLED_CONFIG, store, 'default', fake);
    const { records } = await adapter.pull();

    const keys = records.map(r => r.provenance_key);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(COLLAPSED_GMAIL_PROVENANCE_KEY);
  });
});

// ── Backfill ordering (DRIFT-04 first half) ───────────────────────────────────

describe('backfill ordering — query-backfill batch is reordered oldest-event-first', () => {
  it('with no cursor, out-of-order Date: headers yield records in ascending event_ts order', async () => {
    const newest = 'Tue, 9 Jun 2026 10:00:00 +0000';
    const oldest = 'Mon, 9 Mar 2026 10:00:00 +0000';
    const middle = 'Fri, 1 May 2026 10:00:00 +0000';

    const fake = new FakeGmailFetcher({
      messages: [
        makeRaw({ id: 'newest-msg', threadId: 't-a', headers: { from: 'a@x.com', subject: 's', date: newest } }),
        makeRaw({ id: 'oldest-msg', threadId: 't-b', headers: { from: 'b@x.com', subject: 's', date: oldest } }),
        makeRaw({ id: 'middle-msg', threadId: 't-c', headers: { from: 'c@x.com', subject: 's', date: middle } }),
      ],
      newHistoryId: 'h-1',
    });
    const adapter = new GmailAdapter(ENABLED_CONFIG, makeMetaStub(null), 'default', fake);
    const { records } = await adapter.pull();

    expect(records.map(r => r.external_id)).toEqual(['oldest-msg', 'middle-msg', 'newest-msg']);
  });

  it('a batch mixing dated and undated messages reorders only the dated ones and leaves undated rows in their original index slots', async () => {
    const newest = 'Tue, 9 Jun 2026 10:00:00 +0000';
    const oldest = 'Mon, 9 Mar 2026 10:00:00 +0000';

    const fake = new FakeGmailFetcher({
      messages: [
        makeRaw({ id: 'undated-0', threadId: 't-u0', headers: { from: 'u0@x.com', subject: 's', date: '' } }),
        makeRaw({ id: 'newest-msg', threadId: 't-a', headers: { from: 'a@x.com', subject: 's', date: newest } }),
        makeRaw({ id: 'undated-2', threadId: 't-u2', headers: { from: 'u2@x.com', subject: 's', date: '' } }),
        makeRaw({ id: 'oldest-msg', threadId: 't-b', headers: { from: 'b@x.com', subject: 's', date: oldest } }),
      ],
      newHistoryId: 'h-2',
    });
    const adapter = new GmailAdapter(ENABLED_CONFIG, makeMetaStub(null), 'default', fake);
    const { records } = await adapter.pull();

    // Undated rows never move — indices 0 and 2 keep their original external_ids.
    expect(records[0]!.external_id).toBe('undated-0');
    expect(records[2]!.external_id).toBe('undated-2');
    // The dated rows (indices 1 and 3) are reordered ascending by event_ts within their slots.
    expect(records[1]!.external_id).toBe('oldest-msg');
    expect(records[3]!.external_id).toBe('newest-msg');

    // Permutation guarantee: same length, same multiset of external_ids.
    const inputIds = ['undated-0', 'newest-msg', 'undated-2', 'oldest-msg'].sort();
    const outputIds = records.map(r => r.external_id).sort();
    expect(outputIds).toEqual(inputIds);
  });

  it('with a cursor present (incremental), fetch order is preserved even when event_ts values are descending', async () => {
    const newest = 'Tue, 9 Jun 2026 10:00:00 +0000';
    const oldest = 'Mon, 9 Mar 2026 10:00:00 +0000';

    const fake = new FakeGmailFetcher({
      messages: [
        makeRaw({ id: 'first-fetched-newest', threadId: 't-a', headers: { from: 'a@x.com', subject: 's', date: newest } }),
        makeRaw({ id: 'second-fetched-oldest', threadId: 't-b', headers: { from: 'b@x.com', subject: 's', date: oldest } }),
      ],
      newHistoryId: 'h-3',
    });
    const adapter = new GmailAdapter(ENABLED_CONFIG, makeMetaStub('existing-cursor'), 'default', fake);
    const { records } = await adapter.pull();

    // Fetch order preserved — NOT reordered by event_ts, despite descending values.
    expect(records.map(r => r.external_id)).toEqual(['first-fetched-newest', 'second-fetched-oldest']);
  });

  it('no new API call: a single pull() invokes the injected fetcher exactly once', async () => {
    const fake = new FakeGmailFetcher({ messages: [makeRaw()], newHistoryId: 'h-once' });
    const adapter = new GmailAdapter(ENABLED_CONFIG, makeMetaStub(null), 'default', fake);
    await adapter.pull();

    expect(fake.callCount).toBe(1);
  });
});

// ── orderGmailBackfillByEventTime purity / permutation / idempotence ──────────

describe('orderGmailBackfillByEventTime — purity, permutation, idempotence', () => {
  function buildFixture(): NormalizedRecord[] {
    const base = (external_id: string, event_ts: number | null): NormalizedRecord => ({
      content: `content-${external_id}`,
      source: 'gmail',
      external_id,
      origin: 'observed',
      event_ts,
      role: 'user',
    });
    return [
      base('r0', null),
      base('r1', 3000),
      base('r2', 1000),
      base('r3', null),
      base('r4', 2000),
    ];
  }

  it('does not mutate the input array or any record object, over the shared fixture', () => {
    const input = buildFixture();
    const inputSnapshot = input.map(r => ({ ...r }));

    orderGmailBackfillByEventTime(input);

    expect(input).toEqual(inputSnapshot);
    // Reference-level immutability: none of the original record objects were mutated.
    for (let i = 0; i < input.length; i++) {
      expect(input[i]).toEqual(inputSnapshot[i]);
    }
  });

  it('is a permutation — same length, same multiset of external_ids, over the shared fixture', () => {
    const input = buildFixture();
    const output = orderGmailBackfillByEventTime(input);

    expect(output.length).toBe(input.length);
    expect(output.map(r => r.external_id).sort()).toEqual(input.map(r => r.external_id).sort());
  });

  it('is idempotent — reordering an already-ordered result yields the same result, over the shared fixture', () => {
    const input = buildFixture();
    const once = orderGmailBackfillByEventTime(input);
    const twice = orderGmailBackfillByEventTime(once);

    expect(twice).toEqual(once);
  });
});
