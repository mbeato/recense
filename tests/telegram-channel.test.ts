/**
 * TelegramChannel tests (Phase 7 — primary query surface).
 * All tests use MockTelegramTransport — no real network, no bot token.
 *
 * Covers:
 *  (a) Empty allowlist → receive() returns [] (fail-closed).
 *  (b) Allowlist filtering by numeric user id; unlisted senders dropped silently.
 *  (c) Mapping update → InboundMessage (id=update_id, sender=chat.id, text, ts=date*1000).
 *  (d) Non-text updates ignored.
 *  (e) Dedup cursor — cursor:telegram advances; an update is never returned twice.
 *  (f) Cold start — first boot baselines at max update_id, answers nothing pending.
 *  (g) send() forwards chatId+text to the transport; injection-shaped text unmodified.
 *  (h) No self-echo: a bot never receives its own sends (transport.sent is separate from updates).
 */
import { describe, it, expect } from 'vitest';
import { TelegramChannel } from '../src/channel/telegram-channel';
import { MockTelegramTransport } from '../src/channel/telegram-channel';
import type { TelegramUpdate } from '../src/channel/telegram-channel';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';

// ── In-memory meta stub ───────────────────────────────────────────────────────

class InMemoryMeta {
  private readonly store = new Map<string, string>();
  getMeta(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setMeta(key: string, value: string): void {
    this.store.set(key, value);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ALLOWED_ID = '111';
const UNLISTED_ID = '999';

function update(update_id: number, fromId: number, text: string | undefined, date = 1_700_000_000): TelegramUpdate {
  return {
    update_id,
    message: text === undefined ? undefined : {
      message_id: update_id,
      from: { id: fromId },
      chat: { id: fromId },
      date,
      text,
    },
  };
}

function makeConfig(allowlist: string[]): EngineConfig {
  return {
    ...DEFAULT_CONFIG,
    dbPath: ':memory:',
    telegram: { ...DEFAULT_CONFIG.telegram, allowlist },
  };
}

function makeChannel(opts: {
  updates: TelegramUpdate[];
  allowlist: string[];
  meta?: InMemoryMeta;
  coldStart?: boolean;
}): { ch: TelegramChannel; transport: MockTelegramTransport; meta: InMemoryMeta } {
  const transport = new MockTelegramTransport(opts.updates);
  const meta = opts.meta ?? new InMemoryMeta();
  // Non-cold-start tests assume an already-watching channel: pre-seed a baseline cursor
  // of 0 (non-null) so getUpdates(1) delivers the fixture updates. Cold-start tests keep null.
  if (!opts.coldStart && meta.getMeta('cursor:telegram') === null) {
    meta.setMeta('cursor:telegram', '0');
  }
  const ch = new TelegramChannel(makeConfig(opts.allowlist), transport, meta, () => {});
  return { ch, transport, meta };
}

// ── (a) Empty allowlist ───────────────────────────────────────────────────────

describe('TelegramChannel — empty allowlist (fail-closed)', () => {
  it('returns [] when allowlist is empty even with available updates', async () => {
    const { ch } = makeChannel({ updates: [update(10, 111, 'hi')], allowlist: [] });
    expect(await ch.receive()).toEqual([]);
  });
});

// ── (b)/(c) Allowlist filtering + mapping ─────────────────────────────────────

describe('TelegramChannel — allowlist filtering + mapping', () => {
  it('returns only allowlisted-sender updates; unlisted dropped', async () => {
    const { ch } = makeChannel({
      updates: [update(10, 111, 'what is my load?'), update(11, 999, 'spam')],
      allowlist: [ALLOWED_ID],
    });
    const msgs = await ch.receive();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe('what is my load?');
  });

  it('maps update → InboundMessage (id=update_id, sender=chat.id, ts=date*1000)', async () => {
    const { ch } = makeChannel({ updates: [update(42, 111, 'q', 1_700_000_500)], allowlist: [ALLOWED_ID] });
    const msgs = await ch.receive();
    expect(msgs[0]).toMatchObject({ id: '42', sender: '111', text: 'q', ts: 1_700_000_500_000 });
  });

  it('ignores non-text updates (no message / no text)', async () => {
    const { ch } = makeChannel({
      updates: [update(10, 111, undefined), update(11, 111, 'real question')],
      allowlist: [ALLOWED_ID],
    });
    const msgs = await ch.receive();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe('real question');
  });
});

// ── (e) Dedup cursor ──────────────────────────────────────────────────────────

describe('TelegramChannel — dedup cursor', () => {
  it('advances cursor:telegram and does not re-return confirmed updates', async () => {
    const meta = new InMemoryMeta();
    const updates = [update(10, 111, 'one'), update(12, 111, 'two')];
    const { ch: ch1 } = makeChannel({ updates, allowlist: [ALLOWED_ID], meta });
    expect(await ch1.receive()).toHaveLength(2);
    expect(meta.getMeta('cursor:telegram')).toBe('12');

    const { ch: ch2 } = makeChannel({ updates, allowlist: [ALLOWED_ID], meta });
    expect(await ch2.receive()).toEqual([]);
  });

  it('advances cursor past ALL updates including unlisted ones', async () => {
    const meta = new InMemoryMeta();
    const { ch } = makeChannel({
      updates: [update(10, 111, 'ok'), update(11, 999, 'spam')],
      allowlist: [ALLOWED_ID],
      meta,
    });
    await ch.receive();
    expect(meta.getMeta('cursor:telegram')).toBe('11');
  });
});

// ── (f) Cold start ────────────────────────────────────────────────────────────

describe('TelegramChannel — cold start (no backlog replay)', () => {
  it('first boot (null cursor) returns [] and baselines at max update_id', async () => {
    const meta = new InMemoryMeta();
    const { ch } = makeChannel({
      updates: [update(10, 111, 'old1'), update(11, 111, 'old2'), update(12, 111, 'old3')],
      allowlist: [ALLOWED_ID],
      meta,
      coldStart: true,
    });
    expect(await ch.receive()).toEqual([]);
    expect(meta.getMeta('cursor:telegram')).toBe('12');
  });

  it('after cold-start baseline, a newly-arrived allowed update IS delivered', async () => {
    const meta = new InMemoryMeta();
    const { ch: ch1 } = makeChannel({
      updates: [update(10, 111, 'old')],
      allowlist: [ALLOWED_ID],
      meta,
      coldStart: true,
    });
    expect(await ch1.receive()).toEqual([]);
    expect(meta.getMeta('cursor:telegram')).toBe('10');

    const { ch: ch2 } = makeChannel({
      updates: [update(10, 111, 'old'), update(20, 111, 'new question')],
      allowlist: [ALLOWED_ID],
      meta,
    });
    const msgs = await ch2.receive();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe('new question');
  });
});

// ── (g) send() + injection guard ──────────────────────────────────────────────

describe('TelegramChannel — send()', () => {
  it('forwards chatId (numeric) + text to the transport', async () => {
    const { ch, transport } = makeChannel({ updates: [], allowlist: [ALLOWED_ID] });
    await ch.send('111', 'your load is 42');
    expect(transport.sent).toEqual([{ chatId: 111, text: 'your load is 42' }]);
  });

  it('passes injection-shaped text unmodified (data, never interpolated)', async () => {
    const INJECTION = 'hi"} ; rm -rf / {"x":"';
    const { ch, transport } = makeChannel({ updates: [], allowlist: [ALLOWED_ID] });
    await ch.send('111', INJECTION);
    expect(transport.sent[0]!.text).toBe(INJECTION);
  });
});

// ── (h) No self-echo ──────────────────────────────────────────────────────────

describe('TelegramChannel — no self-echo', () => {
  it('a sent reply does NOT reappear as an inbound update (bot identity is separate)', async () => {
    const meta = new InMemoryMeta();
    const { ch, transport } = makeChannel({ updates: [update(10, 111, 'q')], allowlist: [ALLOWED_ID], meta });
    const msgs = await ch.receive();
    expect(msgs).toHaveLength(1);
    await ch.send(msgs[0]!.sender, "don't have that one");
    // The send is recorded on the transport but is NOT an update — a second receive sees nothing new.
    expect(transport.sent).toHaveLength(1);
    expect(await ch.receive()).toEqual([]);
  });
});
