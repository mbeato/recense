/**
 * CR-03 (BLOCKER) regression lock — `62-VERIFICATION.md` gaps[1] / `62-REVIEW.md` CR-03.
 *
 * Plan `62-10` closes this: before the fix, `parseEmailDate` accepted a sender-forged
 * `Date:` header inside the 48h future-skew window UNCLAMPED. Since plan 62-05,
 * `orderEpisodesForConsolidation` sorts event-time-bearing episodes ascending by
 * `event_ts` and this codebase's reconcile semantics are last-applied-wins, so the
 * MAXIMUM `event_ts` in a batch is processed last and its claim survives. Every genuine
 * message has `Date: <= now`, so a sender who stamps `Date:` 1-47 hours ahead was
 * *guaranteed* the maximum — a position genuinely unobtainable by honest sending.
 *
 * ## The `62-VERIFICATION.md` gaps[1] `missing:` bullets are mutually inconsistent
 *
 * `missing:` asked for both:
 *   - bullet 1: clamp accepted future-dated headers to `nowMs` (`Math.min(parsed, nowMs)`)
 *   - bullet 3: an ordering test with `Date: now+47h` and `Date: now-1h` asserting the
 *     forged one does NOT occupy the final event-time-bearing slot
 *
 * These cannot both be satisfied literally. With `NOW` as defined below, the clamp maps
 * the forged `now+47h` header to exactly `NOW`, while the genuine `now-1h` header parses
 * to `NOW - 3_600_000`. `NOW > NOW - 3_600_000`, so under `orderEpisodesForConsolidation`'s
 * ascending sort the forged episode STILL occupies the final event-time-bearing slot.
 * Bullet 3's literal assertion fails under bullet 1's prescribed fix.
 *
 * Plan `62-10`'s `<interfaces>` § CRITICAL locks the resolution: implement bullet 1
 * verbatim, and assert the property that IS true and is the actual security content —
 * after the clamp, `parseEmailDate` can never return a value greater than `nowMs`, so the
 * maximum ordering position a forged `Date:` can buy is exactly the position obtainable
 * for free by sending the message at the pull instant. That is what Blocks 1 and 2 below
 * assert. Block 3 additionally proves the final slot is decided by the deterministic,
 * non-sender-controlled `EpisodeRow.id` tie-break, not by the forged header value.
 *
 * The residual bullet 3 was actually gesturing at — a clamped forged header still
 * outranks genuine messages dated earlier in the same pull window — is NOT closed by this
 * fix. It is deliberately locked as a named, bounded, accepted residual in a separate
 * describe block added by plan `62-10` Task 3, with its bound and its real fix (Gmail's
 * server-assigned `internalDate`) recorded rather than left implied.
 */
import { describe, it, expect } from 'vitest';

import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { normalizeGmailMessage, parseEmailDate } from '../src/source/gmail-adapter';
import type { RawGmailMessage } from '../src/source/gmail-adapter';
import { orderEpisodesForConsolidation } from '../src/consolidation/episode-order';
import type { EpisodeRow } from '../src/lib/types';

const TEST_CONFIG: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };
const NOW = Date.UTC(2026, 5, 9); // 2026-06-09T00:00:00Z — matches tests/gmail-event-ts.test.ts

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Every header string is derived from NOW — never a hardcoded date literal — so this
// file cannot silently rot as NOW-relative arithmetic drifts.
const forged47h = new Date(NOW + 47 * HOUR_MS).toUTCString();
const forged24h = new Date(NOW + 24 * HOUR_MS).toUTCString();
const presentDated = new Date(NOW).toUTCString();
const genuineMinus1h = new Date(NOW - 1 * HOUR_MS).toUTCString();
const genuineMinus30d = new Date(NOW - 30 * DAY_MS).toUTCString();
const farFuture72h = new Date(NOW + 72 * HOUR_MS).toUTCString();

function makeRaw(overrides: Partial<RawGmailMessage> = {}): RawGmailMessage {
  return {
    id: 'msg-001',
    headers: {
      from: 'alice@acme.com',
      subject: 'Re: pricing discussion',
      date: presentDated,
    },
    bodyText: 'Hello, let me know your thoughts on the Q3 pricing.',
    ...overrides,
  };
}

let rowCounter = 0;

function makeRow(overrides: Partial<EpisodeRow> = {}): EpisodeRow {
  rowCounter += 1;
  return {
    id: overrides.id ?? `ep-${String(rowCounter).padStart(4, '0')}`,
    ts: 1_700_000_000_000,
    content: 'content',
    origin: 'observed',
    salience: 0.5,
    hard_keep: 0,
    consolidated: 0,
    source_inference_id: null,
    role: 'user',
    session_id: 'session-1',
    source: 'gmail',
    external_id: null,
    cwd: '',
    event_ts: null,
    ...overrides,
  };
}

// ── Block 1 — parseEmailDate clamp invariant (CR-03) ──────────────────────────────

describe('parseEmailDate clamp invariant (CR-03)', () => {
  it('a forged now+47h header clamps to exactly NOW', () => {
    expect(parseEmailDate(forged47h, NOW)).toBe(NOW);
  });

  it('a forged now+24h header clamps to exactly NOW', () => {
    expect(parseEmailDate(forged24h, NOW)).toBe(NOW);
  });

  it('an honest present-dated header parses to exactly NOW', () => {
    expect(parseEmailDate(presentDated, NOW)).toBe(NOW);
  });

  it('a genuine now-1h header is unchanged by the clamp (the clamp is a no-op on every non-future header)', () => {
    expect(parseEmailDate(genuineMinus1h, NOW)).toBe(NOW - 1 * HOUR_MS);
  });

  it('a genuine now-30d header is unchanged by the clamp', () => {
    expect(parseEmailDate(genuineMinus30d, NOW)).toBe(NOW - 30 * DAY_MS);
  });

  it('a header beyond the 48h skew window (now+72h) still returns null — the beyond-window branch is untouched', () => {
    expect(parseEmailDate(farFuture72h, NOW)).toBeNull();
  });

  it('invariant: parseEmailDate never returns a value greater than NOW, for any header, ever', () => {
    const headers = [
      forged47h,
      forged24h,
      presentDated,
      genuineMinus1h,
      genuineMinus30d,
      farFuture72h,
      '',
      '   ',
      'not a date',
      'Thu, 01 Jan 1970 00:00:00 +0000',
    ];
    for (const header of headers) {
      const result = parseEmailDate(header, NOW);
      expect(result === null || result <= NOW).toBe(true);
    }
  });
});

// ── Block 2 — no marginal advantage from forging (CR-03) ──────────────────────────

describe('no marginal advantage from forging a future Date: header (CR-03)', () => {
  it('a forged now+47h header produces the IDENTICAL parsed value as an honest present-dated header', () => {
    // Pre-fix contrast: pre-fix, parseEmailDate(forged47h, NOW) exceeded
    // parseEmailDate(presentDated, NOW) by exactly 47 hours — buying the forged episode
    // a position after messages that arrive up to 48h LATER than the attacker's own
    // message, a position genuinely unobtainable by honest sending. Post-fix, both are NOW.
    expect(parseEmailDate(forged47h, NOW)).toBe(parseEmailDate(presentDated, NOW));
  });

  it('the same equality holds through the real normalizer: forged and present-dated messages produce equal event_ts', () => {
    const forgedRecord = normalizeGmailMessage(makeRaw({ headers: { from: 'a@x.com', subject: 's', date: forged47h } }), 'default', TEST_CONFIG, NOW);
    const presentRecord = normalizeGmailMessage(makeRaw({ headers: { from: 'a@x.com', subject: 's', date: presentDated } }), 'default', TEST_CONFIG, NOW);

    expect(forgedRecord.event_ts).toBe(presentRecord.event_ts);
  });
});

// ── Block 3 — end-to-end ordering consequence through orderEpisodesForConsolidation ──
// (CR-03, 62-VERIFICATION.md gaps[1] bullet 3's scenario, resolved per the file doc block)

describe('end-to-end ordering consequence through orderEpisodesForConsolidation (CR-03)', () => {
  function buildRows(forgedId: string, presentId: string) {
    const forgedTs = normalizeGmailMessage(
      makeRaw({ id: 'forged-msg', headers: { from: 'attacker@evil.com', subject: 'forged', date: forged47h } }),
      'default',
      TEST_CONFIG,
      NOW
    ).event_ts;
    const presentTs = normalizeGmailMessage(
      makeRaw({ id: 'present-msg', headers: { from: 'honest@acme.com', subject: 'present', date: presentDated } }),
      'default',
      TEST_CONFIG,
      NOW
    ).event_ts;
    const olderTs = normalizeGmailMessage(
      makeRaw({ id: 'older-msg', headers: { from: 'honest@acme.com', subject: 'older', date: genuineMinus1h } }),
      'default',
      TEST_CONFIG,
      NOW
    ).event_ts;

    const forged = makeRow({ id: forgedId, event_ts: forgedTs });
    const present = makeRow({ id: presentId, event_ts: presentTs });
    const older = makeRow({ id: 'older', event_ts: olderTs });

    return { forged, present, older };
  }

  it('forged.event_ts === present.event_ts, both === NOW, and older.event_ts < NOW', () => {
    const { forged, present, older } = buildRows('zzz-forged', 'aaa-present');
    expect(forged.event_ts).toBe(present.event_ts);
    expect(forged.event_ts).toBe(NOW);
    expect(present.event_ts).toBe(NOW);
    expect(older.event_ts).not.toBeNull();
    expect(older.event_ts!).toBeLessThan(NOW);
  });

  it('the final event-time-bearing slot is decided by the id tie-break, not by the forged header value', () => {
    // Run A: forged's id sorts AFTER present's id ('zzz-forged' > 'aaa-present').
    const runA = buildRows('zzz-forged', 'aaa-present');
    const resultA = orderEpisodesForConsolidation([runA.forged, runA.present, runA.older]);
    const finalA = resultA[resultA.length - 1]!.id;

    // Run B: forged's id sorts BEFORE present's id ('aaa-forged' < 'zzz-present').
    const runB = buildRows('aaa-forged', 'zzz-present');
    const resultB = orderEpisodesForConsolidation([runB.forged, runB.present, runB.older]);
    const finalB = resultB[resultB.length - 1]!.id;

    // If the forged header's VALUE decided the final slot (pre-fix: forged is strictly
    // greatest), 'forged' would land last in BOTH runs regardless of id. Post-fix,
    // forged.event_ts === present.event_ts, so the id tie-break — an EpisodicStore-minted
    // id, never sender-controlled — decides, and which of forged/present is last flips
    // between the two runs.
    const finalAIsForged = finalA === runA.forged.id;
    const finalBIsForged = finalB === runB.forged.id;
    expect(finalAIsForged).not.toBe(finalBIsForged);
  });

  it('older (genuinely earliest) is never in the final slot in either id-tie-break run', () => {
    const runA = buildRows('zzz-forged', 'aaa-present');
    const resultA = orderEpisodesForConsolidation([runA.forged, runA.present, runA.older]);
    expect(resultA[resultA.length - 1]!.id).not.toBe('older');

    const runB = buildRows('aaa-forged', 'zzz-present');
    const resultB = orderEpisodesForConsolidation([runB.forged, runB.present, runB.older]);
    expect(resultB[resultB.length - 1]!.id).not.toBe('older');
  });

  it('a far-future (beyond-48h) header still yields event_ts=null and keeps its original index, mirroring tests/episode-order.test.ts:140', () => {
    const farFutureRecord = normalizeGmailMessage(
      makeRaw({ id: 'far-future-msg', headers: { from: 'x@x.com', subject: 'far future', date: farFuture72h } }),
      'default',
      TEST_CONFIG,
      NOW
    );
    expect(farFutureRecord.event_ts).toBeNull();

    const farFutureRow = makeRow({ id: 'far-future-rejected', event_ts: farFutureRecord.event_ts });
    const { forged, present } = buildRows('zzz-forged', 'aaa-present');

    const input = [farFutureRow, forged, present];
    const result = orderEpisodesForConsolidation(input);

    // The null-event_ts row never moves — it keeps index 0.
    expect(result[0]!.id).toBe('far-future-rejected');
  });
});

// ── NAMED RESIDUAL — a clamped forged header still outranks earlier-in-window genuine ──
// messages (CR-03 accepted residual, plan 62-10 Task 3)
//
// The clamp closes the net-new capability plan 62-05 introduced: parseEmailDate can never
// return a value greater than nowMs, so a forged Date: no longer buys a position after
// messages that arrive up to 48 hours LATER than the attacker's own message (that position
// was genuinely unobtainable by honest sending, and is now unreachable by forgery too).
//
// It does NOT reduce the residual to zero. Within a single pull, a clamped forged header
// still sorts after genuine messages dated EARLIER in that same pull window — because the
// clamp caps the forged value at nowMs, and any genuine message sent before nowMs still has
// a smaller event_ts. This block locks that residual as a DELIBERATE, measured, accepted
// boundary — not an aspiration and not an undiscovered bug. 62-VERIFICATION.md gaps[1]
// bullet 3 asked for an assertion that the forged header does NOT land in the final
// event-time-bearing slot; that literal wording is unachievable under the prescribed clamp
// (see this file's top doc block for the arithmetic), so asserting it here would be a test
// that fails for the right reason today and gets "fixed" by weakening the clamp later. The
// tests below assert the true post-fix reality instead, with its exact bound.
//
// The residual is bounded by the pull interval (GmailAdapter.pull() reads nowMs once per
// pull, per this plan's <threat_model> trust-boundary table) and is equivalent to the
// sender simply sending at the pull instant — a capability the sender already has. Driving
// it to zero requires a server-assigned receipt time (Gmail's internalDate, not
// sender-controlled) as the event_ts source or the clamp ceiling — a change to
// RawGmailMessage, RealGmailFetcher.fetchMessages, and every test fake, deliberately out of
// scope for this gap-closure wave and flagged for the backlog.
describe('parseEmailDate clamp — NAMED RESIDUAL: a clamped forged header still outranks earlier-in-window genuine messages (CR-03 accepted residual)', () => {
  it('DELIBERATE LOCK: the 62-VERIFICATION.md bullet-3 scenario, asserted at its true post-fix value — the forged header DOES still land in the final event-time-bearing slot', () => {
    const forged = makeRow({ id: 'forged', event_ts: parseEmailDate(forged47h, NOW) });
    const older = makeRow({ id: 'older', event_ts: parseEmailDate(genuineMinus1h, NOW) });

    expect(forged.event_ts).toBe(NOW);
    expect(older.event_ts).toBe(NOW - 3_600_000);

    const result = orderEpisodesForConsolidation([forged, older]);

    // This is the accepted residual, not a regression: forged.event_ts (NOW) is still
    // greater than older.event_ts (NOW - 1h), so the ascending sort still places forged
    // last. What the clamp removed is the UNBOUNDED version of this — pre-fix, forged
    // could have outranked messages up to 48h newer than the pull instant, not just 1h
    // older within the same pull.
    expect(result[result.length - 1]!.id).toBe('forged');
  });

  it('the bound: a forged header buys EXACTLY ZERO milliseconds of advantage over an honest header sent at the pull instant', () => {
    const advantage = parseEmailDate(forged47h, NOW)! - parseEmailDate(presentDated, NOW)!;
    expect(advantage).toBe(0);
    // The residual is therefore bounded by how far behind nowMs the genuine messages in the
    // same pull are — i.e. by the pull interval — and is equivalent to the sender simply
    // sending at the pull instant, a capability the sender already has without forging
    // anything.
  });

  it('pre-fix contrast, measured: the raw header still carries the full 47-hour forgery, but the parse no longer propagates it', () => {
    // The raw Date.parse result is untouched by the clamp — the forged header itself still
    // claims to be 47 hours in the future.
    expect(Date.parse(forged47h) - NOW).toBe(47 * 3_600_000);
    // But parseEmailDate's output no longer reflects that forgery: the delta collapses to
    // zero. Pre-fix, this second expression was ALSO 47 * 3_600_000 — identical to the raw
    // header delta, i.e. the parse propagated the forgery unchanged. That is exactly what
    // Task 1's RED evidence recorded and Task 2's clamp closed.
    expect(parseEmailDate(forged47h, NOW)! - NOW).toBe(0);
  });
});
