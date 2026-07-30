/**
 * Phase 62 Plan 05 — orderEpisodesForConsolidation tests (EMAIL-04).
 *
 * Pure function, no DB needed: builds EpisodeRow fixtures with a small helper.
 * Covers the permutation/slot-preservation/idempotence contract from the interface
 * spec, plus the T-62-30 security case (a rejected far-future Date: header, which
 * plan 62-04's parseEmailDate reduces to event_ts=null, must never reposition to
 * the end of the batch).
 */
import { describe, it, expect } from 'vitest';
import { orderEpisodesForConsolidation } from '../src/consolidation/episode-order';
import type { EpisodeRow } from '../src/lib/types';

let counter = 0;

function makeRow(overrides: Partial<EpisodeRow> = {}): EpisodeRow {
  counter += 1;
  return {
    id: overrides.id ?? `ep-${String(counter).padStart(4, '0')}`,
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

describe('orderEpisodesForConsolidation (EMAIL-04)', () => {
  it('reverse-chronological case: descending event_ts input (newest-first) comes back oldest-first', () => {
    const newest = makeRow({ id: 'newest', event_ts: 3000, salience: 0.9 });
    const middle = makeRow({ id: 'middle', event_ts: 2000, salience: 0.8 });
    const oldest = makeRow({ id: 'oldest', event_ts: 1000, salience: 0.7 });

    const result = orderEpisodesForConsolidation([newest, middle, oldest]);

    expect(result.map(r => r.id)).toEqual(['oldest', 'middle', 'newest']);
  });

  it('slot preservation: a null-event_ts row keeps its index; both event-bearing rows keep their indices', () => {
    const gmailNew = makeRow({ id: 'gmail-new', event_ts: 2000, salience: 0.9 });
    const claudeCode = makeRow({ id: 'claude-code', event_ts: null, salience: 0.8, source: 'claude-code' });
    const gmailOld = makeRow({ id: 'gmail-old', event_ts: 1000, salience: 0.7 });

    const result = orderEpisodesForConsolidation([gmailNew, claudeCode, gmailOld]);

    expect(result.map(r => r.id)).toEqual(['gmail-old', 'claude-code', 'gmail-new']);
    // The null row never moved off index 1.
    expect(result[1]!.id).toBe('claude-code');
  });

  it('all-null input is returned deep-equal to the input (non-Gmail passes are provably unaffected)', () => {
    const rows = [
      makeRow({ id: 'a', event_ts: null }),
      makeRow({ id: 'b', event_ts: null }),
      makeRow({ id: 'c', event_ts: null }),
    ];

    const result = orderEpisodesForConsolidation(rows);

    expect(result).toEqual(rows);
    expect(result.map(r => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('empty array is a no-op', () => {
    expect(orderEpisodesForConsolidation([])).toEqual([]);
  });

  it('single-element array is a no-op', () => {
    const rows = [makeRow({ id: 'solo', event_ts: 1000 })];
    expect(orderEpisodesForConsolidation(rows)).toEqual(rows);
  });

  it('permutation property: shuffled 50-row mixed fixture preserves length and id multiset', () => {
    const rows: EpisodeRow[] = [];
    for (let i = 0; i < 50; i++) {
      rows.push(
        makeRow({
          id: `row-${i}`,
          // Every third row is null (non-Gmail); the rest carry a shuffled-looking event_ts.
          event_ts: i % 3 === 0 ? null : ((i * 7919) % 1000) * 1000,
        }),
      );
    }

    const result = orderEpisodesForConsolidation(rows);

    expect(result).toHaveLength(rows.length);
    expect(result.map(r => r.id).sort()).toEqual(rows.map(r => r.id).sort());
  });

  it('non-mutation: input array order and row objects are unchanged after the call', () => {
    const rows = [
      makeRow({ id: 'x', event_ts: 3000 }),
      makeRow({ id: 'y', event_ts: 1000 }),
      makeRow({ id: 'z', event_ts: 2000 }),
    ];
    const preCallClone = rows.map(r => ({ ...r }));

    orderEpisodesForConsolidation(rows);

    expect(rows.map(r => r.id)).toEqual(['x', 'y', 'z']);
    expect(rows).toEqual(preCallClone);
  });

  it('determinism and idempotence: repeated calls deep-equal each other, and f(f(x)) deep-equals f(x)', () => {
    const rows = [
      makeRow({ id: 'x', event_ts: 3000 }),
      makeRow({ id: 'y', event_ts: 1000 }),
      makeRow({ id: 'z', event_ts: null }),
    ];

    const firstCall = orderEpisodesForConsolidation(rows);
    const secondCall = orderEpisodesForConsolidation(rows);
    expect(firstCall).toEqual(secondCall);

    const twiceApplied = orderEpisodesForConsolidation(firstCall);
    expect(twiceApplied).toEqual(firstCall);
  });

  it('equal-timestamp tie-break: two rows sharing an event_ts come back ordered by id ascending, stably', () => {
    const rowB = makeRow({ id: 'b-row', event_ts: 5000 });
    const rowA = makeRow({ id: 'a-row', event_ts: 5000 });

    const firstCall = orderEpisodesForConsolidation([rowB, rowA]);
    expect(firstCall.map(r => r.id)).toEqual(['a-row', 'b-row']);

    const secondCall = orderEpisodesForConsolidation([rowB, rowA]);
    expect(secondCall.map(r => r.id)).toEqual(['a-row', 'b-row']);
  });

  it('T-62-30 security case: a row whose event_ts is null because its Date: header was rejected as implausibly future keeps its original index — it does NOT move to the end', () => {
    // Simulates plan 62-04's parseEmailDate: an implausibly-future Date: header collapses
    // to event_ts=null rather than being clamped to "now" or "the future" — so it can never
    // buy a late position in the reorder. Placed at index 0 with two legitimate event-time
    // rows after it; if the manipulation worked, this row would end up last (index 2).
    const forgedFutureRejected = makeRow({ id: 'forged-future-rejected', event_ts: null });
    const legitOld = makeRow({ id: 'legit-old', event_ts: 1000 });
    const legitNew = makeRow({ id: 'legit-new', event_ts: 2000 });

    const result = orderEpisodesForConsolidation([forgedFutureRejected, legitOld, legitNew]);

    expect(result[0]!.id).toBe('forged-future-rejected');
    expect(result.map(r => r.id)).not.toEqual(['legit-old', 'legit-new', 'forged-future-rejected']);
    expect(result.map(r => r.id)).toEqual(['forged-future-rejected', 'legit-old', 'legit-new']);
  });
});
