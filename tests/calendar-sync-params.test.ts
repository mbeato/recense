/**
 * calendar sync-param tests (Phase 20, CR-01 fix — TEMP-01).
 *
 * Pure-function coverage for the incremental-sync param/selection contract that the mock
 * CalendarFetcher seam cannot exercise:
 *  - buildCalendarListParams: full fetch sets timeMin+orderBy; incremental sets syncToken
 *    ALONE (the real API rejects timeMin/orderBy alongside syncToken with HTTP 400).
 *  - selectSyncEvents: full-fetch pass-through; incremental drops past confirmed events,
 *    keeps cancellations + undated events, and sorts ascending by start (so downstream
 *    "first per series" dedup is the next occurrence — D-04).
 */
import { describe, it, expect } from 'vitest';
import type { calendar_v3 } from 'googleapis';
import {
  buildCalendarListParams,
  selectSyncEvents,
} from '../src/source/calendar-adapter';

const NOW_ISO = '2026-06-15T00:00:00.000Z';
const NOW_MS = Date.parse(NOW_ISO);
const FUTURE = '2026-07-01T10:00:00Z';
const PAST = '2026-01-01T10:00:00Z';

function ev(
  partial: Partial<calendar_v3.Schema$Event> & { startDateTime?: string },
): calendar_v3.Schema$Event {
  const { startDateTime, ...rest } = partial;
  return {
    status: 'confirmed',
    ...(startDateTime ? { start: { dateTime: startDateTime } } : {}),
    ...rest,
  };
}

describe('buildCalendarListParams (CR-01)', () => {
  it('full fetch (null token): sets timeMin + orderBy, NO syncToken', () => {
    const p = buildCalendarListParams(null, NOW_ISO);
    expect(p.syncToken).toBeUndefined();
    expect(p.timeMin).toBe(NOW_ISO);
    expect(p.orderBy).toBe('startTime');
    expect(p.singleEvents).toBe(true);
  });

  it("full fetch (empty-string token): treated as full fetch (falsy)", () => {
    const p = buildCalendarListParams('', NOW_ISO);
    expect(p.syncToken).toBeUndefined();
    expect(p.timeMin).toBe(NOW_ISO);
    expect(p.orderBy).toBe('startTime');
  });

  it('incremental (real token): sets syncToken and OMITS timeMin/orderBy (API rejects them with 400)', () => {
    const p = buildCalendarListParams('tok-123', NOW_ISO);
    expect(p.syncToken).toBe('tok-123');
    expect(p.timeMin).toBeUndefined();
    expect(p.orderBy).toBeUndefined();
    expect(p.singleEvents).toBe(true);
  });
});

describe('selectSyncEvents (CR-01)', () => {
  it('full fetch: returns events unchanged (server already filtered + sorted)', () => {
    const raw = [ev({ id: 'a', startDateTime: PAST }), ev({ id: 'b', startDateTime: FUTURE })];
    expect(selectSyncEvents(raw, null, NOW_MS)).toBe(raw);
  });

  it('incremental: drops past CONFIRMED events, keeps future ones', () => {
    const raw = [ev({ id: 'past', startDateTime: PAST }), ev({ id: 'future', startDateTime: FUTURE })];
    const out = selectSyncEvents(raw, 'tok', NOW_MS);
    expect(out.map(e => e.id)).toEqual(['future']);
  });

  it('incremental: keeps cancellations regardless of date (tombstoning depends on them)', () => {
    const raw = [ev({ id: 'cancel-past', status: 'cancelled', startDateTime: PAST })];
    const out = selectSyncEvents(raw, 'tok', NOW_MS);
    expect(out.map(e => e.id)).toEqual(['cancel-past']);
  });

  it('incremental: keeps undated (all-day, no resolvable start) events', () => {
    const raw = [ev({ id: 'undated' })];
    const out = selectSyncEvents(raw, 'tok', NOW_MS);
    expect(out.map(e => e.id)).toEqual(['undated']);
  });

  it('incremental: sorts ascending by start so first instance per series is the next occurrence', () => {
    const later = '2026-08-01T10:00:00Z';
    const raw = [
      ev({ id: 'later', recurringEventId: 'series', startDateTime: later }),
      ev({ id: 'sooner', recurringEventId: 'series', startDateTime: FUTURE }),
    ];
    const out = selectSyncEvents(raw, 'tok', NOW_MS);
    expect(out.map(e => e.id)).toEqual(['sooner', 'later']);
  });
});
