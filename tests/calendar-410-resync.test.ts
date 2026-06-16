/**
 * calendar-410-resync tests (Phase 20, plan 04 — 410-GONE full-resync).
 *
 * Covers the full 3-step resync scenario:
 *  1. Normal pull → events ingested as episodes
 *  2. Pull after stale syncToken → fetcher returns gone=true → cursor wiped
 *  3. Pull with wiped cursor (empty string) → full fetch → same events → no duplicate episodes
 *
 * The key invariant: UNIQUE(source, external_id) in EpisodicStore deduplicates re-ingested
 * records, so the episode count after the third pull is identical to after the first pull.
 *
 * Uses a real EpisodicStore + IngestionPipeline (in-memory SQLite) to verify dedup.
 */

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';

import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { EpisodicStore } from '../src/db/episode-store';
import { SemanticStore } from '../src/db/semantic-store';
import { AllocationGate, IngestionPipeline } from '../src/ingest/pipeline';
import { CalendarAdapter, CalendarFetcher, RawCalendarEvent } from '../src/source/calendar-adapter';
import { runPullPhase } from '../src/adapter/ingest-cli';

// ── Helpers ───────────────────────────────────────────────────────────────────

const TEST_CONFIG: EngineConfig = {
  ...DEFAULT_CONFIG,
  dbPath: ':memory:',
  enabledSources: ['gcal'],
  calendar: { enabled: true },
};

function makeEvent(id: string, start = '2026-07-01T10:00:00Z'): RawCalendarEvent {
  return {
    id,
    summary: `Event ${id}`,
    start: { dateTime: start },
    status: 'confirmed',
  };
}

class FakeCalendarFetcher implements CalendarFetcher {
  public lastReceivedSyncToken: string | null = null;
  private callIndex = 0;

  constructor(
    private readonly script: Array<{
      events: RawCalendarEvent[];
      newSyncToken: string | null;
      gone: boolean;
    }>
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

// ── Test ───────────────────────────────────────────────────────────────────────

describe('410-GONE resync — duplicate-free re-ingestion', () => {
  it('three-step resync: episode count is identical after full re-fetch (no duplicates)', async () => {
    const db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(Date.UTC(2026, 5, 15));
    const episodes = new EpisodicStore(db, clock, TEST_CONFIG);
    const semanticStore = new SemanticStore(db, clock, TEST_CONFIG);
    const gate = new AllocationGate(TEST_CONFIG);
    const pipeline = new IngestionPipeline(gate, episodes);

    const SAME_EVENTS = [makeEvent('evt-001'), makeEvent('evt-002')];

    const fetcher = new FakeCalendarFetcher([
      // Pull 1: normal fetch, returns 2 events
      { events: SAME_EVENTS, newSyncToken: 'sync-token-1', gone: false },
      // Pull 2: stale token → 410 GONE → cursor wiped
      { events: [], newSyncToken: null, gone: true },
      // Pull 3: full re-fetch (empty cursor → full fetch) → same 2 events
      { events: SAME_EVENTS, newSyncToken: 'sync-token-2', gone: false },
    ]);

    const adapter = new CalendarAdapter(TEST_CONFIG, semanticStore, 'default', fetcher);

    // ── Pull 1: normal ingest ───────────────────────────────────────────────
    await runPullPhase([adapter], pipeline, db, () => {});

    const countAfterPull1 = (
      db.prepare("SELECT COUNT(*) as n FROM episode WHERE source = 'gcal'").get() as { n: number }
    ).n;
    expect(countAfterPull1).toBe(2);

    // ── Pull 2: 410 GONE → wipe cursor ─────────────────────────────────────
    await runPullPhase([adapter], pipeline, db, () => {});

    // cursor should be wiped
    expect(semanticStore.getMeta('cursor:calendar:default')).toBe('');

    // ── Pull 3: full re-fetch (empty cursor → full fetch) ───────────────────
    await runPullPhase([adapter], pipeline, db, () => {});

    // Fetcher must have been called with a falsy syncToken (empty cursor → omit syncToken)
    expect(fetcher.lastReceivedSyncToken).toBeFalsy();

    // Episode count must be 2 — no duplicates (UNIQUE(source, external_id) dedup)
    const countAfterPull3 = (
      db.prepare("SELECT COUNT(*) as n FROM episode WHERE source = 'gcal'").get() as { n: number }
    ).n;
    expect(countAfterPull3).toBe(2);
    expect(countAfterPull3).toBe(countAfterPull1);
  });
});
