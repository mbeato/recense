/**
 * DefaultIMessageChannel tests (Phase 7, D-70/D-74/T-07-02/T-07-03).
 * All tests use MockChatDbReader + MockOsascriptSender — no real chat.db, no osascript.
 *
 * Covers:
 *  (a) Empty allowlist → receive() returns [] (D-74 fail-closed).
 *  (b) Configured allowlist → only matching-sender rows returned; unlisted dropped silently.
 *  (c) Dedup — cursor:imessage advanced so a ROWID is never returned twice.
 *  (d) send() forwards recipient+text to MockOsascriptSender.sent.
 *  (e) Injection-shaped text passed through to sender UNMODIFIED (T-07-02 data-not-script).
 */
import { describe, it, expect } from 'vitest';
import { DefaultIMessageChannel, MockOsascriptSender } from '../src/channel/imessage-channel';
import { MockChatDbReader } from '../src/channel/chat-db-reader';
import type { ChatDbRow } from '../src/channel/chat-db-reader';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';

// ── In-memory meta stub ───────────────────────────────────────────────────────

/** Minimal MetaStore for testing cursor:imessage persistence without a real DB. */
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

const ALLOWED_HANDLE = '+14155550101';
const UNLISTED_HANDLE = '+19995550202';

const ROW_ALLOWED: ChatDbRow = {
  rowid: 100,
  handle: ALLOWED_HANDLE,
  text: 'what is my training load?',
  dateMs: 1_700_000_000_000,
  isFromMe: false,
};

const ROW_UNLISTED: ChatDbRow = {
  rowid: 101,
  handle: UNLISTED_HANDLE,
  text: 'spam message',
  dateMs: 1_700_000_001_000,
  isFromMe: false,
};

const ROW_ALLOWED_2: ChatDbRow = {
  rowid: 102,
  handle: ALLOWED_HANDLE,
  text: 'follow up question',
  dateMs: 1_700_000_002_000,
  isFromMe: false,
};

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeConfig(allowlist: string[]): EngineConfig {
  return {
    ...DEFAULT_CONFIG,
    dbPath: ':memory:',
    channel: {
      ...DEFAULT_CONFIG.channel,
      allowlist,
    },
  };
}

function makeChannel(opts: {
  rows: ChatDbRow[];
  allowlist: string[];
  sender?: MockOsascriptSender;
  meta?: InMemoryMeta;
}): {
  ch: DefaultIMessageChannel;
  sender: MockOsascriptSender;
  meta: InMemoryMeta;
} {
  const sender = opts.sender ?? new MockOsascriptSender();
  const meta = opts.meta ?? new InMemoryMeta();
  const ch = new DefaultIMessageChannel(
    makeConfig(opts.allowlist),
    new MockChatDbReader(opts.rows),
    sender,
    meta,
    () => {} // no-op log function (log output not under test here)
  );
  return { ch, sender, meta };
}

// ── (a) Empty allowlist → receive() returns [] ────────────────────────────────

describe('DefaultIMessageChannel — empty allowlist (D-74 fail-closed)', () => {
  it('returns [] when allowlist is empty even with available rows', async () => {
    const { ch } = makeChannel({ rows: [ROW_ALLOWED], allowlist: [] });
    const msgs = await ch.receive();
    expect(msgs).toEqual([]);
  });

  it('returns [] when allowlist is empty and no rows exist', async () => {
    const { ch } = makeChannel({ rows: [], allowlist: [] });
    const msgs = await ch.receive();
    expect(msgs).toEqual([]);
  });
});

// ── (b) Allowlist filtering — only matching sender returned; unlisted dropped ─

describe('DefaultIMessageChannel — allowlist filtering (D-74)', () => {
  it('returns only matching-sender rows; unlisted sender rows are dropped', async () => {
    const { ch } = makeChannel({
      rows: [ROW_ALLOWED, ROW_UNLISTED],
      allowlist: [ALLOWED_HANDLE],
    });
    const msgs = await ch.receive();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.sender).toBe(ALLOWED_HANDLE);
    expect(msgs[0]!.text).toBe('what is my training load?');
  });

  it('returns [] when all rows are from unlisted senders', async () => {
    const { ch } = makeChannel({ rows: [ROW_UNLISTED], allowlist: [ALLOWED_HANDLE] });
    const msgs = await ch.receive();
    expect(msgs).toEqual([]);
  });

  it('maps row fields to InboundMessage (id=rowid, sender, text, ts=dateMs)', async () => {
    const { ch } = makeChannel({ rows: [ROW_ALLOWED], allowlist: [ALLOWED_HANDLE] });
    const msgs = await ch.receive();
    expect(msgs[0]).toMatchObject({
      id: '100',
      sender: ALLOWED_HANDLE,
      text: 'what is my training load?',
      ts: 1_700_000_000_000,
    });
  });

  it('returns [] when there are no rows', async () => {
    const { ch } = makeChannel({ rows: [], allowlist: [ALLOWED_HANDLE] });
    const msgs = await ch.receive();
    expect(msgs).toEqual([]);
  });
});

// ── (c) Dedup cursor — cursor:imessage advances; same ROWID not returned twice ─

describe('DefaultIMessageChannel — dedup cursor (T-07-03)', () => {
  it('does not re-return rows after cursor has advanced past their ROWID', async () => {
    const meta = new InMemoryMeta();

    // First receive() — delivers two allowed rows
    const { ch: ch1 } = makeChannel({
      rows: [ROW_ALLOWED, ROW_ALLOWED_2],
      allowlist: [ALLOWED_HANDLE],
      meta,
    });
    const first = await ch1.receive();
    expect(first).toHaveLength(2);

    // Cursor must now be at max rowid seen (102)
    expect(meta.getMeta('cursor:imessage')).toBe('102');

    // Second channel instance shares the same meta (cursor at 102).
    // MockChatDbReader.pollNew(102) filters to rows with rowid > 102 → none.
    const { ch: ch2 } = makeChannel({
      rows: [ROW_ALLOWED, ROW_ALLOWED_2],
      allowlist: [ALLOWED_HANDLE],
      meta,
    });
    const second = await ch2.receive();
    expect(second).toEqual([]);
  });

  it('advances cursor past ALL rows including unlisted ones (T-07-03)', async () => {
    const meta = new InMemoryMeta();
    const { ch } = makeChannel({
      rows: [ROW_ALLOWED, ROW_UNLISTED],
      allowlist: [ALLOWED_HANDLE],
      meta,
    });

    await ch.receive();
    // Cursor must be 101 (ROW_UNLISTED rowid), not just 100 (ROW_ALLOWED rowid)
    expect(meta.getMeta('cursor:imessage')).toBe('101');
  });
});

// ── (d) send() forwards recipient + text to MockOsascriptSender ───────────────

describe('DefaultIMessageChannel — send() (D-70)', () => {
  it('forwards recipient and text to MockOsascriptSender.sent', async () => {
    const { ch, sender } = makeChannel({ rows: [], allowlist: [ALLOWED_HANDLE] });
    await ch.send(ALLOWED_HANDLE, 'your training load is 42 TSS');
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]).toEqual({
      recipient: ALLOWED_HANDLE,
      text: 'your training load is 42 TSS',
    });
  });

  it('records multiple send() calls in order', async () => {
    const { ch, sender } = makeChannel({ rows: [], allowlist: [ALLOWED_HANDLE] });
    await ch.send(ALLOWED_HANDLE, 'first reply');
    await ch.send(ALLOWED_HANDLE, 'second reply');
    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[0]!.text).toBe('first reply');
    expect(sender.sent[1]!.text).toBe('second reply');
  });
});

// ── (e) Injection-shaped text passed as data, not script (T-07-02) ────────────

describe('DefaultIMessageChannel — injection guard (T-07-02)', () => {
  it('passes injection-shaped text unmodified to sender — treated as data, not script', async () => {
    // A string that would break AppleScript or shell if it were interpolated.
    // At the MockOsascriptSender boundary it must arrive bit-for-bit unchanged.
    const INJECTION_TEXT = 'hello" & do shell script "rm -rf /' + "' end tell";
    const { ch, sender } = makeChannel({ rows: [], allowlist: [ALLOWED_HANDLE] });
    await ch.send(ALLOWED_HANDLE, INJECTION_TEXT);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.text).toBe(INJECTION_TEXT);
  });

  it('passes text containing quotes and backticks unmodified', async () => {
    const QUOTED_TEXT = 'he said "hello" and `goodbye`';
    const { ch, sender } = makeChannel({ rows: [], allowlist: [ALLOWED_HANDLE] });
    await ch.send(ALLOWED_HANDLE, QUOTED_TEXT);
    expect(sender.sent[0]!.text).toBe(QUOTED_TEXT);
  });
});
