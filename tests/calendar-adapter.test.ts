/**
 * calendar-adapter tests (Phase 20, plan 04 — TEMP-01/TEMP-04).
 *
 * All tests use injected FakeCalendarFetcher — no network, no OAuth credentials.
 *
 * Covers:
 *  1. Two one-off events → 2 records (source='gcal', origin='observed', no RRULE token, When ends in 'Z')
 *  2. Recurring series → exactly ONE record with `· RRULE: ` token + correct masterId in Event token
 *  3. One-off event → content has NO `· RRULE:` token
 *  4. Cancelled master (no recurringEventId) → 0 records, id in meta calendar:cancelled:<acct>
 *  5. Cancelled instance (recurringEventId set) → NOT added to cancelled set
 *  6. gone:true → cursor wiped to '', 0 records, commitCursor is a no-op
 *  7. Post-wipe full-fetch: fetcher called with falsy syncToken on next pull (empty cursor → full fetch)
 *  8. UTC normalization: dateTime with tz offset → When token ends in 'Z'
 *  9. Construction without env creds does NOT throw
 * 10. nextSyncToken captured (not nextPageToken) — commitCursor persists newSyncToken
 * 11. commitCursor only writes cursor after being invoked (deferred M-6)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import {
  CalendarAdapter,
  CalendarFetcher,
  RawCalendarEvent,
  normalizeCalendarEvent,
} from '../src/source/calendar-adapter';

// ── Shared config ─────────────────────────────────────────────────────────────

const TEST_CONFIG: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

// ── In-memory MetaStore stub ──────────────────────────────────────────────────

class FakeMeta {
  private readonly store = new Map<string, string>();
  getMeta(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setMeta(key: string, value: string): void {
    this.store.set(key, value);
  }
}

// ── FakeCalendarFetcher — scripted, no network ─────────────────────────────────

class FakeCalendarFetcher implements CalendarFetcher {
  /** The syncToken received on the last fetchEvents call (for assertion). */
  public lastReceivedSyncToken: string | null = undefined as unknown as string | null;

  constructor(
    private readonly script: {
      events: RawCalendarEvent[];
      newSyncToken: string | null;
      gone: boolean;
    }[] = [],
    private callIndex = 0,
  ) {}

  async fetchEvents(
    _accountId: string,
    syncToken: string | null,
  ): Promise<{ events: RawCalendarEvent[]; newSyncToken: string | null; gone: boolean }> {
    this.lastReceivedSyncToken = syncToken;
    const result = this.script[this.callIndex] ?? { events: [], newSyncToken: null, gone: false };
    this.callIndex++;
    return result;
  }
}

// ── RawCalendarEvent fixtures ─────────────────────────────────────────────────

function makeOneOff(id: string, start = '2026-07-01T10:00:00Z'): RawCalendarEvent {
  return {
    id,
    summary: `Meeting ${id}`,
    descriptionText: 'details here',
    start: { dateTime: start },
    status: 'confirmed',
  };
}

function makeRecurringInstance(
  instanceId: string,
  masterId: string,
  start = '2026-07-07T10:00:00Z',
  rrule = 'RRULE:FREQ=WEEKLY;BYDAY=MO',
): RawCalendarEvent {
  return {
    id: instanceId,
    summary: 'Weekly standup',
    descriptionText: 'weekly sync',
    start: { dateTime: start },
    status: 'confirmed',
    recurringEventId: masterId,
    recurrence: [rrule],
  };
}

function makeCancelledMaster(id: string): RawCalendarEvent {
  return {
    id,
    summary: 'Cancelled series',
    start: { dateTime: '2026-07-01T10:00:00Z' },
    status: 'cancelled',
  };
}

function makeCancelledInstance(instanceId: string, masterId: string): RawCalendarEvent {
  return {
    id: instanceId,
    summary: 'Cancelled instance',
    start: { dateTime: '2026-07-01T10:00:00Z' },
    status: 'cancelled',
    recurringEventId: masterId,
  };
}

// ── 1. Two one-off events → 2 records ─────────────────────────────────────────

describe('CalendarAdapter — two one-off events', () => {
  it('returns 2 records with correct metadata, no RRULE token', async () => {
    const meta = new FakeMeta();
    const fetcher = new FakeCalendarFetcher([
      {
        events: [makeOneOff('evt-1'), makeOneOff('evt-2')],
        newSyncToken: 'sync-abc',
        gone: false,
      },
    ]);
    const adapter = new CalendarAdapter(TEST_CONFIG, meta, 'default', fetcher);
    const { records } = await adapter.pull();

    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.source).toBe('gcal');
      expect(r.origin).toBe('observed');
      expect(r.role).toBe('user');
      // Each record should have a When token ending in 'Z' (UTC)
      const whenMatch = r.content.match(/·\s*When:\s*(\S+)/);
      expect(whenMatch).not.toBeNull();
      expect(whenMatch![1]).toMatch(/Z$/);
      // No RRULE token on one-off events
      expect(r.content).not.toContain('· RRULE:');
    }
  });

  it('cursor is NOT committed until commitCursor() is called (M-6 deferred)', async () => {
    const meta = new FakeMeta();
    const fetcher = new FakeCalendarFetcher([
      { events: [makeOneOff('evt-1')], newSyncToken: 'sync-xyz', gone: false },
    ]);
    const adapter = new CalendarAdapter(TEST_CONFIG, meta, 'default', fetcher);
    const { commitCursor } = await adapter.pull();

    // cursor not yet written
    expect(meta.getMeta('cursor:calendar:default')).toBeNull();
    commitCursor();
    // cursor written after commitCursor
    expect(meta.getMeta('cursor:calendar:default')).toBe('sync-xyz');
  });
});

// ── 2. Recurring series → ONE record with RRULE token ─────────────────────────

describe('CalendarAdapter — recurring series collapses to one record', () => {
  it('yields exactly ONE record for a recurring series', async () => {
    const meta = new FakeMeta();
    const fetcher = new FakeCalendarFetcher([
      {
        events: [makeRecurringInstance('inst-001', 'master-1')],
        newSyncToken: 'sync-rec',
        gone: false,
      },
    ]);
    const adapter = new CalendarAdapter(TEST_CONFIG, meta, 'default', fetcher);
    const { records } = await adapter.pull();

    expect(records).toHaveLength(1);
  });

  it('recurring record content contains `· RRULE: FREQ=WEEKLY;BYDAY=MO` (strips RRULE: prefix)', async () => {
    const meta = new FakeMeta();
    const fetcher = new FakeCalendarFetcher([
      {
        events: [makeRecurringInstance('inst-001', 'master-1')],
        newSyncToken: 'sync-rec',
        gone: false,
      },
    ]);
    const adapter = new CalendarAdapter(TEST_CONFIG, meta, 'default', fetcher);
    const { records } = await adapter.pull();

    expect(records[0]!.content).toContain('· RRULE: FREQ=WEEKLY;BYDAY=MO');
  });

  it('recurring record Event token uses the master id (recurringEventId)', async () => {
    const meta = new FakeMeta();
    const fetcher = new FakeCalendarFetcher([
      {
        events: [makeRecurringInstance('inst-001', 'master-1')],
        newSyncToken: 'sync-rec',
        gone: false,
      },
    ]);
    const adapter = new CalendarAdapter(TEST_CONFIG, meta, 'default', fetcher);
    const { records } = await adapter.pull();

    expect(records[0]!.content).toContain('· Event: master-1');
  });

  it('two instances of the same series collapse to ONE record', async () => {
    const meta = new FakeMeta();
    const fetcher = new FakeCalendarFetcher([
      {
        events: [
          makeRecurringInstance('inst-001', 'master-1', '2026-07-07T10:00:00Z'),
          makeRecurringInstance('inst-002', 'master-1', '2026-07-14T10:00:00Z'),
        ],
        newSyncToken: 'sync-rec',
        gone: false,
      },
    ]);
    const adapter = new CalendarAdapter(TEST_CONFIG, meta, 'default', fetcher);
    const { records } = await adapter.pull();

    // Must collapse to ONE record per series (D-04)
    expect(records).toHaveLength(1);
  });
});

// ── 3. One-off event has NO RRULE token ───────────────────────────────────────

describe('CalendarAdapter — one-off event has no RRULE token', () => {
  it('one-off event content does NOT contain `· RRULE:`', async () => {
    const meta = new FakeMeta();
    const fetcher = new FakeCalendarFetcher([
      { events: [makeOneOff('evt-1')], newSyncToken: 'tok', gone: false },
    ]);
    const adapter = new CalendarAdapter(TEST_CONFIG, meta, 'default', fetcher);
    const { records } = await adapter.pull();

    expect(records[0]!.content).not.toContain('· RRULE:');
  });
});

// ── 4. Cancelled master → 0 records, side-channel set ─────────────────────────

describe('CalendarAdapter — cancelled master (no recurringEventId)', () => {
  it('produces 0 records and adds master id to meta calendar:cancelled:<acct>', async () => {
    const meta = new FakeMeta();
    const fetcher = new FakeCalendarFetcher([
      {
        events: [makeCancelledMaster('master-gone')],
        newSyncToken: 'tok',
        gone: false,
      },
    ]);
    const adapter = new CalendarAdapter(TEST_CONFIG, meta, 'default', fetcher);
    const { records } = await adapter.pull();

    expect(records).toHaveLength(0);

    const cancelled: string[] = JSON.parse(
      meta.getMeta('calendar:cancelled:default') ?? '[]'
    );
    expect(cancelled).toContain('master-gone');
  });
});

// ── 5. Cancelled instance (has recurringEventId) → NOT in cancelled set ────────

describe('CalendarAdapter — cancelled instance (recurringEventId set)', () => {
  it('cancelled instance is NOT added to the cancelled set (does not tombstone the series)', async () => {
    const meta = new FakeMeta();
    const fetcher = new FakeCalendarFetcher([
      {
        events: [makeCancelledInstance('inst-001', 'master-1')],
        newSyncToken: 'tok',
        gone: false,
      },
    ]);
    const adapter = new CalendarAdapter(TEST_CONFIG, meta, 'default', fetcher);
    const { records } = await adapter.pull();

    expect(records).toHaveLength(0);

    const cancelled: string[] = JSON.parse(
      meta.getMeta('calendar:cancelled:default') ?? '[]'
    );
    // Instance cancellation must NOT add anything to the set (D-05)
    expect(cancelled).toHaveLength(0);
  });
});

// ── 6. gone:true → cursor wiped, 0 records, commitCursor no-op ────────────────

describe('CalendarAdapter — 410 GONE response', () => {
  it('wipes cursor to "" and returns 0 records when fetcher returns gone=true', async () => {
    const meta = new FakeMeta();
    // Set an existing cursor to verify it gets wiped
    meta.setMeta('cursor:calendar:default', 'stale-sync-token');

    const fetcher = new FakeCalendarFetcher([
      { events: [], newSyncToken: null, gone: true },
    ]);
    const adapter = new CalendarAdapter(TEST_CONFIG, meta, 'default', fetcher);
    const { records, commitCursor } = await adapter.pull();

    expect(records).toHaveLength(0);
    expect(meta.getMeta('cursor:calendar:default')).toBe('');

    // commitCursor is a no-op on gone (should not overwrite the wiped '')
    commitCursor();
    expect(meta.getMeta('cursor:calendar:default')).toBe('');
  });
});

// ── 7. Post-wipe full-fetch: fetcher receives falsy syncToken ──────────────────

describe('CalendarAdapter — post-GONE full-fetch contract', () => {
  it('passes falsy (empty/null) syncToken to fetcher after a gone wipe', async () => {
    const meta = new FakeMeta();

    // Step 1: wipe the cursor (simulate a prior gone)
    meta.setMeta('cursor:calendar:default', '');

    // Step 2: the fetcher on this pull should receive the empty string (falsy)
    const fetcher = new FakeCalendarFetcher([
      {
        events: [makeOneOff('evt-1')],
        newSyncToken: 'new-sync-token',
        gone: false,
      },
    ]);
    const adapter = new CalendarAdapter(TEST_CONFIG, meta, 'default', fetcher);
    await adapter.pull();

    // Fetcher must have received a falsy syncToken (empty string → full fetch)
    expect(fetcher.lastReceivedSyncToken).toBeFalsy();
  });

  it('re-ingesting the same events after a gone wipe produces no duplicate records (same external_ids)', async () => {
    const meta = new FakeMeta();

    // First pull: normal fetch
    const fetcher = new FakeCalendarFetcher([
      { events: [makeOneOff('evt-A'), makeOneOff('evt-B')], newSyncToken: 'tok-1', gone: false },
      // Second pull: gone → wipes cursor
      { events: [], newSyncToken: null, gone: true },
      // Third pull: full fetch with same events
      { events: [makeOneOff('evt-A'), makeOneOff('evt-B')], newSyncToken: 'tok-2', gone: false },
    ]);
    const adapter = new CalendarAdapter(TEST_CONFIG, meta, 'default', fetcher);

    const { records: r1, commitCursor: cc1 } = await adapter.pull();
    cc1();
    expect(r1).toHaveLength(2);

    const { records: r2 } = await adapter.pull(); // gone wipe
    expect(r2).toHaveLength(0);
    expect(meta.getMeta('cursor:calendar:default')).toBe('');

    const { records: r3 } = await adapter.pull(); // full re-fetch
    expect(r3).toHaveLength(2);

    // external_ids must be the same across r1 and r3 (so episode dedup fires)
    const ids1 = r1.map(r => r.external_id).sort();
    const ids3 = r3.map(r => r.external_id).sort();
    expect(ids1).toEqual(ids3);
  });
});

// ── 8. UTC normalization ───────────────────────────────────────────────────────

describe('CalendarAdapter — UTC normalization', () => {
  it('converts tz-offset dateTime to UTC (When token ends in Z)', async () => {
    const meta = new FakeMeta();
    const eventWithOffset = makeOneOff('evt-tz', '2026-07-01T10:00:00-05:00');
    const fetcher = new FakeCalendarFetcher([
      { events: [eventWithOffset], newSyncToken: 'tok', gone: false },
    ]);
    const adapter = new CalendarAdapter(TEST_CONFIG, meta, 'default', fetcher);
    const { records } = await adapter.pull();

    const whenMatch = records[0]!.content.match(/·\s*When:\s*(\S+)/);
    expect(whenMatch).not.toBeNull();
    expect(whenMatch![1]).toMatch(/Z$/);
    // 10:00 -05:00 = 15:00 UTC
    expect(whenMatch![1]).toContain('15:00:00');
  });
});

// ── 9. Construction without env creds does NOT throw ──────────────────────────

describe('CalendarAdapter — construction is side-effect-free (D-68)', () => {
  it('constructing CalendarAdapter with a named account does not throw even without env creds', () => {
    const meta = new FakeMeta();
    // No fetcher → defaults to RealCalendarFetcher which reads env lazily
    expect(() => new CalendarAdapter(TEST_CONFIG, meta, 'work')).not.toThrow();
  });
});

// ── 10. normalizeCalendarEvent pure function ───────────────────────────────────

describe('normalizeCalendarEvent (pure function)', () => {
  it('source is "gcal" and origin is "observed" (D-09/D-61)', () => {
    const raw = makeOneOff('evt-1');
    const rec = normalizeCalendarEvent(raw, 'default', TEST_CONFIG);
    expect(rec.source).toBe('gcal');
    expect(rec.origin).toBe('observed');
  });

  it('Acct token in content matches the accountId passed in', () => {
    const raw = makeOneOff('evt-1');
    const rec = normalizeCalendarEvent(raw, 'work', TEST_CONFIG);
    expect(rec.content).toContain('· Acct: work');
  });

  it('external_id is content-addressed (changes when When changes)', () => {
    const raw1 = makeOneOff('evt-1', '2026-07-01T10:00:00Z');
    const raw2 = makeOneOff('evt-1', '2026-07-08T10:00:00Z');  // same id, different date
    const rec1 = normalizeCalendarEvent(raw1, 'default', TEST_CONFIG);
    const rec2 = normalizeCalendarEvent(raw2, 'default', TEST_CONFIG);
    // Different When → different content → different external_id
    expect(rec1.external_id).not.toBe(rec2.external_id);
  });

  it('recurring instance: Event token uses recurringEventId, not instance id', () => {
    const raw = makeRecurringInstance('inst-001', 'master-1');
    const rec = normalizeCalendarEvent(raw, 'default', TEST_CONFIG);
    expect(rec.content).toContain('· Event: master-1');
    expect(rec.content).not.toContain('· Event: inst-001');
  });

  it('one-off: Event token uses its own id', () => {
    const raw = makeOneOff('evt-standalone');
    const rec = normalizeCalendarEvent(raw, 'default', TEST_CONFIG);
    expect(rec.content).toContain('· Event: evt-standalone');
  });

  it('RRULE token has the FREQ value (strips RRULE: prefix from recurrence field)', () => {
    const raw = makeRecurringInstance('inst-1', 'master-1', '2026-07-07T10:00:00Z',
      'RRULE:FREQ=DAILY;COUNT=5');
    const rec = normalizeCalendarEvent(raw, 'default', TEST_CONFIG);
    expect(rec.content).toContain('· RRULE: FREQ=DAILY;COUNT=5');
    expect(rec.content).not.toContain('RRULE:FREQ=');  // no double-prefix
  });
});

// ── 11. Per-account cursor key ─────────────────────────────────────────────────

describe('CalendarAdapter — per-account cursor key (D-10)', () => {
  it('uses cursor:calendar:<accountId> (not a shared cursor)', async () => {
    const meta = new FakeMeta();
    const fetcher = new FakeCalendarFetcher([
      { events: [], newSyncToken: 'token-work', gone: false },
    ]);
    const adapter = new CalendarAdapter(TEST_CONFIG, meta, 'work', fetcher);
    const { commitCursor } = await adapter.pull();
    commitCursor();

    expect(meta.getMeta('cursor:calendar:work')).toBe('token-work');
    // Other account keys are not set
    expect(meta.getMeta('cursor:calendar:default')).toBeNull();
  });
});
