/**
 * TelegramChannel tests (Phase 7 — primary query surface / LOCK-CHANNEL-SPLIT).
 * All tests use MockTelegramTransport — no real network, no bot token.
 *
 * Covers:
 *  (a) Empty allowlist → fetch() returns {messages:[],commitTo:null} (fail-closed, idle).
 *  (b) Allowlist filtering by numeric user id; unlisted senders dropped silently.
 *  (c) Mapping update → InboundMessage (id=update_id, sender=chat.id, text, ts=date*1000).
 *  (d) Non-text updates ignored.
 *  (e) Dedup cursor — cursor:telegram only changes after explicit commitCursor(), NOT fetch().
 *      fetch() performs NO write (T-LOCK-01).
 *  (f) Cold start — fetch() returns {messages:[],commitTo:<baseline>} with meta STILL NULL;
 *      cursor written only after explicit commitCursor() call.
 *  (g) Zero new updates → fetch() returns {messages:[],commitTo:null} (idle).
 *  (h) currentCursor() reflects the persisted value after commitCursor().
 *  (i) send() forwards chatId+text to the transport; injection-shaped text unmodified.
 *  (j) No self-echo: a bot never receives its own sends.
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
  it('fetch() returns {messages:[],commitTo:null} when allowlist is empty', async () => {
    const { ch } = makeChannel({ updates: [update(10, 111, 'hi')], allowlist: [] });
    const result = await ch.fetch();
    expect(result).toEqual({ messages: [], commitTo: null });
  });
});

// ── (b)/(c) Allowlist filtering + mapping ─────────────────────────────────────

describe('TelegramChannel — allowlist filtering + mapping', () => {
  it('fetch() returns only allowlisted-sender updates; unlisted dropped', async () => {
    const { ch } = makeChannel({
      updates: [update(10, 111, 'what is my load?'), update(11, 999, 'spam')],
      allowlist: [ALLOWED_ID],
    });
    const result = await ch.fetch();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.text).toBe('what is my load?');
    // commitTo covers ALL scanned updates (including unlisted)
    expect(result.commitTo).toBe('11');
  });

  it('maps update → InboundMessage (id=update_id, sender=chat.id, ts=date*1000)', async () => {
    const { ch } = makeChannel({ updates: [update(42, 111, 'q', 1_700_000_500)], allowlist: [ALLOWED_ID] });
    const result = await ch.fetch();
    expect(result.messages[0]).toMatchObject({ id: '42', sender: '111', text: 'q', ts: 1_700_000_500_000 });
    expect(result.commitTo).toBe('42');
  });

  it('ignores non-text updates (no message / no text); commitTo still covers them', async () => {
    const { ch } = makeChannel({
      updates: [update(10, 111, undefined), update(11, 111, 'real question')],
      allowlist: [ALLOWED_ID],
    });
    const result = await ch.fetch();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.text).toBe('real question');
    expect(result.commitTo).toBe('11');
  });
});

// ── (e) fetch() is write-free; cursor only changes via commitCursor() ──────────

describe('TelegramChannel — fetch() performs NO write (T-LOCK-01)', () => {
  it('cursor:telegram is still null/unchanged after fetch() on cold start', async () => {
    const meta = new InMemoryMeta();
    const { ch } = makeChannel({
      updates: [update(10, 111, 'hi')],
      allowlist: [ALLOWED_ID],
      meta,
      coldStart: true,
    });
    expect(meta.getMeta('cursor:telegram')).toBeNull();
    await ch.fetch();
    // fetch() must not write the cursor — it's still null
    expect(meta.getMeta('cursor:telegram')).toBeNull();
  });

  it('cursor:telegram unchanged after fetch() on normal path', async () => {
    const meta = new InMemoryMeta();
    meta.setMeta('cursor:telegram', '0'); // pre-seed (non-cold-start)
    const { ch } = makeChannel({
      updates: [update(10, 111, 'q')],
      allowlist: [ALLOWED_ID],
      meta,
    });
    await ch.fetch();
    // fetch() must not advance the cursor
    expect(meta.getMeta('cursor:telegram')).toBe('0');
  });

  it('cursor advances only after explicit commitCursor() call', async () => {
    const meta = new InMemoryMeta();
    meta.setMeta('cursor:telegram', '0');
    const { ch } = makeChannel({
      updates: [update(10, 111, 'q'), update(12, 111, 'r')],
      allowlist: [ALLOWED_ID],
      meta,
    });
    const { commitTo } = await ch.fetch();
    expect(meta.getMeta('cursor:telegram')).toBe('0'); // not yet advanced
    ch.commitCursor(commitTo!);
    expect(meta.getMeta('cursor:telegram')).toBe('12'); // now advanced
  });

  it('does not re-return updates after cursor has advanced via commitCursor()', async () => {
    const meta = new InMemoryMeta();
    const updates = [update(10, 111, 'one'), update(12, 111, 'two')];
    const { ch: ch1 } = makeChannel({ updates, allowlist: [ALLOWED_ID], meta });
    const { commitTo } = await ch1.fetch();
    expect(commitTo).toBe('12');
    ch1.commitCursor(commitTo!);
    expect(meta.getMeta('cursor:telegram')).toBe('12');

    const { ch: ch2 } = makeChannel({ updates, allowlist: [ALLOWED_ID], meta });
    const second = await ch2.fetch();
    expect(second).toEqual({ messages: [], commitTo: null });
  });

  it('cursor advances past ALL updates including unlisted ones', async () => {
    const meta = new InMemoryMeta();
    const { ch } = makeChannel({
      updates: [update(10, 111, 'ok'), update(11, 999, 'spam')],
      allowlist: [ALLOWED_ID],
      meta,
    });
    const { commitTo } = await ch.fetch();
    expect(commitTo).toBe('11'); // covers unlisted update_id=11
    ch.commitCursor(commitTo!);
    expect(meta.getMeta('cursor:telegram')).toBe('11');
  });
});

// ── (g) Zero new updates → idle ───────────────────────────────────────────────

describe('TelegramChannel — zero new updates (idle, commitTo:null)', () => {
  it('fetch() returns {messages:[],commitTo:null} when no updates after cursor', async () => {
    const { ch } = makeChannel({ updates: [], allowlist: [ALLOWED_ID] });
    const result = await ch.fetch();
    expect(result).toEqual({ messages: [], commitTo: null });
  });
});

// ── (f) Cold start ────────────────────────────────────────────────────────────

describe('TelegramChannel — cold start (no backlog replay)', () => {
  it('fetch() returns {messages:[],commitTo:<baseline>} with meta cursor STILL NULL', async () => {
    const meta = new InMemoryMeta();
    const { ch } = makeChannel({
      updates: [update(10, 111, 'old1'), update(11, 111, 'old2'), update(12, 111, 'old3')],
      allowlist: [ALLOWED_ID],
      meta,
      coldStart: true,
    });
    const result = await ch.fetch();
    expect(result.messages).toEqual([]);
    expect(result.commitTo).toBe('12'); // max scanned update_id
    // meta cursor must still be null — fetch() performs no write (T-LOCK-01)
    expect(meta.getMeta('cursor:telegram')).toBeNull();
  });

  it('commitCursor() writes the baseline under caller control', async () => {
    const meta = new InMemoryMeta();
    const { ch } = makeChannel({
      updates: [update(10, 111, 'old')],
      allowlist: [ALLOWED_ID],
      meta,
      coldStart: true,
    });
    const { commitTo } = await ch.fetch();
    expect(meta.getMeta('cursor:telegram')).toBeNull(); // not yet written
    ch.commitCursor(commitTo!);
    expect(meta.getMeta('cursor:telegram')).toBe('10'); // now persisted
  });

  it('after cold-start baseline committed, a newly-arrived allowed update IS delivered', async () => {
    const meta = new InMemoryMeta();
    const { ch: ch1 } = makeChannel({
      updates: [update(10, 111, 'old')],
      allowlist: [ALLOWED_ID],
      meta,
      coldStart: true,
    });
    const { commitTo } = await ch1.fetch();
    ch1.commitCursor(commitTo!); // write baseline '10' to meta
    expect(meta.getMeta('cursor:telegram')).toBe('10');

    const { ch: ch2 } = makeChannel({
      updates: [update(10, 111, 'old'), update(20, 111, 'new question')],
      allowlist: [ALLOWED_ID],
      meta,
    });
    const result = await ch2.fetch();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.text).toBe('new question');
    expect(result.commitTo).toBe('20');
  });
});

// ── (h) currentCursor() ───────────────────────────────────────────────────────

describe('TelegramChannel — currentCursor()', () => {
  it('returns null before any commit', () => {
    const meta = new InMemoryMeta();
    const { ch } = makeChannel({ updates: [], allowlist: [ALLOWED_ID], meta, coldStart: true });
    expect(ch.currentCursor()).toBeNull();
  });

  it('returns the persisted cursor value after commitCursor()', () => {
    const meta = new InMemoryMeta();
    meta.setMeta('cursor:telegram', '42');
    const { ch } = makeChannel({ updates: [], allowlist: [ALLOWED_ID], meta });
    expect(ch.currentCursor()).toBe('42');
  });

  it('reflects writes made via commitCursor()', async () => {
    const meta = new InMemoryMeta();
    const { ch } = makeChannel({
      updates: [update(15, 111, 'q')],
      allowlist: [ALLOWED_ID],
      meta,
    });
    const { commitTo } = await ch.fetch();
    ch.commitCursor(commitTo!);
    expect(ch.currentCursor()).toBe('15');
  });
});

// ── (i) send() + injection guard ──────────────────────────────────────────────

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

// ── (j) No self-echo ──────────────────────────────────────────────────────────

describe('TelegramChannel — no self-echo', () => {
  it('a sent reply does NOT reappear as an inbound update (bot identity is separate)', async () => {
    const meta = new InMemoryMeta();
    const { ch, transport } = makeChannel({ updates: [update(10, 111, 'q')], allowlist: [ALLOWED_ID], meta });
    const { messages, commitTo } = await ch.fetch();
    expect(messages).toHaveLength(1);
    ch.commitCursor(commitTo!);
    await ch.send(messages[0]!.sender, "don't have that one");
    // The send is recorded on the transport but is NOT an update — a second fetch sees nothing new.
    expect(transport.sent).toHaveLength(1);
    const second = await ch.fetch();
    expect(second).toEqual({ messages: [], commitTo: null });
  });
});

// ── commitCursor monotonicity ─────────────────────────────────────────────────

describe('TelegramChannel — commitCursor monotonicity', () => {
  it('does not regress the cursor when commitTo <= current', () => {
    const meta = new InMemoryMeta();
    const { ch } = makeChannel({ updates: [], allowlist: [ALLOWED_ID], meta });
    ch.commitCursor('50');
    expect(meta.getMeta('cursor:telegram')).toBe('50');
    ch.commitCursor('30'); // regression attempt — no-op
    expect(meta.getMeta('cursor:telegram')).toBe('50');
    ch.commitCursor('50'); // equal — no-op
    expect(meta.getMeta('cursor:telegram')).toBe('50');
  });
});
