/**
 * Channel seam tests (Phase 7, D-70).
 * All tests use MockChannel — no network, no filesystem, no credentials.
 *
 * Covers:
 *  1. MockChannel returns scripted receive batches in queue order.
 *  2. Exhausted receive queue returns [] (not a throw).
 *  3. send() records calls on the public `sent` array.
 *  4. MockChannel satisfies the Channel interface (type-level check).
 *  5. Empty receive script returns [] immediately.
 */
import { describe, it, expect } from 'vitest';
import { MockChannel } from '../src/channel/channel';
import type { Channel, InboundMessage } from '../src/channel/channel';

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

// ── MockChannel — scripted receive batches ────────────────────────────────────

describe('MockChannel — scripted receive batches', () => {
  it('returns scripted batches in queue order', async () => {
    const ch = new MockChannel({
      receiveScript: [[MSG_A, MSG_B], [MSG_C]],
    });
    const first = await ch.receive();
    const second = await ch.receive();
    expect(first).toEqual([MSG_A, MSG_B]);
    expect(second).toEqual([MSG_C]);
  });

  it('exhausted receive queue returns [] — never throws', async () => {
    const ch = new MockChannel({
      receiveScript: [[MSG_A]],
    });
    await ch.receive(); // consumes the only batch
    const empty = await ch.receive();
    expect(empty).toEqual([]);
    // calling again still returns [] without throwing
    const stillEmpty = await ch.receive();
    expect(stillEmpty).toEqual([]);
  });

  it('empty receive script returns [] on first call', async () => {
    const ch = new MockChannel();
    const result = await ch.receive();
    expect(result).toEqual([]);
  });

  it('each batch is independent — no cross-batch contamination', async () => {
    const ch = new MockChannel({
      receiveScript: [[MSG_A], [MSG_B], [MSG_C]],
    });
    const b1 = await ch.receive();
    const b2 = await ch.receive();
    const b3 = await ch.receive();
    expect(b1).toHaveLength(1);
    expect(b1[0]!.id).toBe('100');
    expect(b2[0]!.id).toBe('101');
    expect(b3[0]!.id).toBe('102');
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

  it('send() does not affect the receive queue', async () => {
    const ch = new MockChannel({ receiveScript: [[MSG_A]] });
    await ch.send('+14155550101', 'reply');
    const msgs = await ch.receive();
    expect(msgs).toEqual([MSG_A]);
    expect(ch.sent).toHaveLength(1);
  });
});

// ── MockChannel — Channel interface compliance ────────────────────────────────

describe('MockChannel — interface compliance', () => {
  it('satisfies the Channel interface (type-level check via assignment)', () => {
    const ch: Channel = new MockChannel();
    expect(typeof ch.receive).toBe('function');
    expect(typeof ch.send).toBe('function');
  });
});
