/**
 * Channel seam tests (Phase 7, D-70 / LOCK-CHANNEL-SPLIT).
 * All tests use MockChannel — no network, no filesystem, no credentials.
 *
 * Covers:
 *  1. MockChannel.fetch() returns scripted FetchResult batches in queue order.
 *  2. Exhausted fetch queue returns {messages:[], commitTo:null} — never throws.
 *  3. MockChannel.commitCursor() records successful commits on committed[].
 *  4. MockChannel.currentCursor() reflects the last committed value (or null).
 *  5. commitCursor is a no-op when commitTo <= current cursor (monotonic invariant).
 *  6. send() records calls on the public `sent` array (unchanged behavior).
 *  7. MockChannel satisfies the Channel interface (type-level check).
 *  8. Empty fetch script returns {messages:[], commitTo:null} on first call.
 */
import { describe, it, expect } from 'vitest';
import { MockChannel } from '../src/channel/channel';
import type { Channel, InboundMessage, FetchResult } from '../src/channel/channel';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MSG_A: InboundMessage = {
  id: '100',
  sender: '+14155550101',
  text: 'what is my training load this week?',
  ts: 1_700_000_000_000,
};

const MSG_B: InboundMessage = {
  id: '101',
  sender: '+14155550101',
  text: 'how many rest days did i take last month?',
  ts: 1_700_000_001_000,
};

const MSG_C: InboundMessage = {
  id: '102',
  sender: 'coach@example.com',
  text: 'did the athlete sleep well?',
  ts: 1_700_000_002_000,
};

// ── MockChannel — fetch() scripted batches ────────────────────────────────────

describe('MockChannel — fetch() scripted batches', () => {
  it('returns scripted FetchResult batches in queue order', async () => {
    const ch = new MockChannel({
      fetchScript: [
        { messages: [MSG_A, MSG_B], commitTo: '101' },
        { messages: [MSG_C], commitTo: '102' },
      ],
    });
    const first = await ch.fetch();
    const second = await ch.fetch();
    expect(first).toEqual({ messages: [MSG_A, MSG_B], commitTo: '101' });
    expect(second).toEqual({ messages: [MSG_C], commitTo: '102' });
  });

  it('exhausted fetch queue returns {messages:[],commitTo:null} — never throws', async () => {
    const ch = new MockChannel({
      fetchScript: [{ messages: [MSG_A], commitTo: '100' }],
    });
    await ch.fetch(); // consumes the only batch
    const empty = await ch.fetch();
    expect(empty).toEqual({ messages: [], commitTo: null });
    // calling again still returns the idle result without throwing
    const stillEmpty = await ch.fetch();
    expect(stillEmpty).toEqual({ messages: [], commitTo: null });
  });

  it('empty fetch script returns {messages:[],commitTo:null} on first call', async () => {
    const ch = new MockChannel();
    const result = await ch.fetch();
    expect(result).toEqual({ messages: [], commitTo: null });
  });

  it('each batch is independent — no cross-batch contamination', async () => {
    const ch = new MockChannel({
      fetchScript: [
        { messages: [MSG_A], commitTo: '100' },
        { messages: [MSG_B], commitTo: '101' },
        { messages: [MSG_C], commitTo: '102' },
      ],
    });
    const b1 = await ch.fetch();
    const b2 = await ch.fetch();
    const b3 = await ch.fetch();
    expect(b1.messages[0]!.id).toBe('100');
    expect(b2.messages[0]!.id).toBe('101');
    expect(b3.messages[0]!.id).toBe('102');
  });
});

// ── MockChannel — commitCursor() + currentCursor() ────────────────────────────

describe('MockChannel — commitCursor() / currentCursor()', () => {
  it('currentCursor() returns null before any commit', () => {
    const ch = new MockChannel();
    expect(ch.currentCursor()).toBeNull();
  });

  it('commitCursor() records on committed[] and updates currentCursor()', () => {
    const ch = new MockChannel();
    ch.commitCursor('100');
    expect(ch.committed).toEqual(['100']);
    expect(ch.currentCursor()).toBe('100');
  });

  it('multiple commits accumulate in committed[] in order', () => {
    const ch = new MockChannel();
    ch.commitCursor('100');
    ch.commitCursor('200');
    ch.commitCursor('350');
    expect(ch.committed).toEqual(['100', '200', '350']);
    expect(ch.currentCursor()).toBe('350');
  });

  it('commitCursor is a no-op when commitTo <= current (monotonic invariant)', () => {
    const ch = new MockChannel();
    ch.commitCursor('200');
    // Attempt to regress the cursor
    ch.commitCursor('100'); // 100 < 200 → no-op
    ch.commitCursor('200'); // 200 == 200 → no-op
    expect(ch.committed).toEqual(['200']); // only the first commit recorded
    expect(ch.currentCursor()).toBe('200');
  });

  it('commitCursor advances after monotonic skip when a higher value arrives', () => {
    const ch = new MockChannel();
    ch.commitCursor('100');
    ch.commitCursor('50'); // skipped — monotonic
    ch.commitCursor('200'); // advances
    expect(ch.committed).toEqual(['100', '200']);
    expect(ch.currentCursor()).toBe('200');
  });
});

// ── MockChannel — send() recording ───────────────────────────────────────────

describe('MockChannel — send() recording', () => {
  it('records send calls with recipient and text', async () => {
    const ch = new MockChannel();
    await ch.send('+14155550101', 'your training load is 42 TSS');
    await ch.send('coach@example.com', 'athlete slept 7h30m last night');
    expect(ch.sent).toHaveLength(2);
    expect(ch.sent[0]).toEqual({ recipient: '+14155550101', text: 'your training load is 42 TSS' });
    expect(ch.sent[1]).toEqual({ recipient: 'coach@example.com', text: 'athlete slept 7h30m last night' });
  });

  it('sent array starts empty', () => {
    const ch = new MockChannel();
    expect(ch.sent).toEqual([]);
  });

  it('send() does not affect the fetch queue or committed[]', async () => {
    const ch = new MockChannel({
      fetchScript: [{ messages: [MSG_A], commitTo: '100' }],
    });
    await ch.send('+14155550101', 'reply');
    const result = await ch.fetch();
    expect(result.messages).toEqual([MSG_A]);
    expect(ch.sent).toHaveLength(1);
    expect(ch.committed).toHaveLength(0);
  });
});

// ── MockChannel — Channel interface compliance ────────────────────────────────

describe('MockChannel — interface compliance', () => {
  it('satisfies the Channel interface (type-level check via assignment)', () => {
    const ch: Channel = new MockChannel();
    expect(typeof ch.fetch).toBe('function');
    expect(typeof ch.commitCursor).toBe('function');
    expect(typeof ch.currentCursor).toBe('function');
    expect(typeof ch.send).toBe('function');
  });

  it('FetchResult idle sentinel: {messages:[], commitTo:null} when exhausted', async () => {
    const ch = new MockChannel();
    const r: FetchResult = await ch.fetch();
    expect(r.messages).toEqual([]);
    expect(r.commitTo).toBeNull();
  });
});
