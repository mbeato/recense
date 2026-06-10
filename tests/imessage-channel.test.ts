/**
 * DefaultIMessageChannel tests (Phase 7, D-70/D-74/T-07-02/T-07-03 / LOCK-CHANNEL-SPLIT).
 * All tests use MockChatDbReader + MockOsascriptSender — no real chat.db, no osascript.
 *
 * Covers:
 *  (a) Empty allowlist → fetch() returns {messages:[],commitTo:null} (D-74 fail-closed, idle).
 *  (b) Configured allowlist → only matching-sender rows returned; unlisted dropped silently.
 *  (c) Dedup — cursor:imessage only changes after explicit commitCursor(), NOT fetch().
 *      fetch() performs NO write (T-LOCK-01).
 *  (d) Cold start — fetch() returns {messages:[],commitTo:<baseline>} with meta STILL NULL;
 *      cursor written only after explicit commitCursor() call.
 *  (e) Zero new rows → fetch() returns {messages:[],commitTo:null} (idle, lock never acquired).
 *  (f) currentCursor() reflects the persisted value after commitCursor().
 *  (g) send() forwards recipient+text to MockOsascriptSender.sent.
 *  (h) Injection-shaped text passed through to sender UNMODIFIED (T-07-02 data-not-script).
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
  coldStart?: boolean;
}): {
  ch: DefaultIMessageChannel;
  sender: MockOsascriptSender;
  meta: InMemoryMeta;
} {
  const sender = opts.sender ?? new MockOsascriptSender();
  const meta = opts.meta ?? new InMemoryMeta();
  // Filtering/dedup/mapping tests exercise delivery of available rows — they assume an
  // already-watching channel. Pre-seed a baseline cursor of 0 (an explicit, non-null
  // cursor → pollNew(0) delivers all rows) so they are unaffected by the cold-start
  // baseline policy. Cold-start tests pass coldStart:true to keep a null cursor.
  if (!opts.coldStart && meta.getMeta('cursor:imessage') === null) {
    meta.setMeta('cursor:imessage', '0');
  }
  const ch = new DefaultIMessageChannel(
    makeConfig(opts.allowlist),
    new MockChatDbReader(opts.rows),
    sender,
    meta,
    () => {} // no-op log function (log output not under test here)
  );
  return { ch, sender, meta };
}

// ── (a) Empty allowlist → fetch() returns idle sentinel ──────────────────────

describe('DefaultIMessageChannel — empty allowlist (D-74 fail-closed)', () => {
  it('fetch() returns {messages:[],commitTo:null} when allowlist is empty, rows available', async () => {
    const { ch } = makeChannel({ rows: [ROW_ALLOWED], allowlist: [] });
    const result = await ch.fetch();
    expect(result).toEqual({ messages: [], commitTo: null });
  });

  it('fetch() returns {messages:[],commitTo:null} when allowlist is empty and no rows', async () => {
    const { ch } = makeChannel({ rows: [], allowlist: [] });
    const result = await ch.fetch();
    expect(result).toEqual({ messages: [], commitTo: null });
  });
});

// ── (b) Allowlist filtering — only matching sender returned; unlisted dropped ─

describe('DefaultIMessageChannel — allowlist filtering (D-74)', () => {
  it('returns only matching-sender rows; unlisted sender rows are dropped', async () => {
    const { ch } = makeChannel({
      rows: [ROW_ALLOWED, ROW_UNLISTED],
      allowlist: [ALLOWED_HANDLE],
    });
    const result = await ch.fetch();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.sender).toBe(ALLOWED_HANDLE);
    expect(result.messages[0]!.text).toBe('what is my training load?');
    // commitTo covers ALL scanned rows (T-07-03) including unlisted
    expect(result.commitTo).toBe('101');
  });

  it('returns empty messages[] but non-null commitTo when all rows are from unlisted senders', async () => {
    const { ch } = makeChannel({ rows: [ROW_UNLISTED], allowlist: [ALLOWED_HANDLE] });
    const result = await ch.fetch();
    expect(result.messages).toEqual([]);
    // commitTo = maxRowid of scanned rows (still need to commit to skip them next tick)
    expect(result.commitTo).toBe('101');
  });

  it('maps row fields to InboundMessage (id=rowid, sender, text, ts=dateMs)', async () => {
    const { ch } = makeChannel({ rows: [ROW_ALLOWED], allowlist: [ALLOWED_HANDLE] });
    const result = await ch.fetch();
    expect(result.messages[0]).toMatchObject({
      id: '100',
      sender: ALLOWED_HANDLE,
      text: 'what is my training load?',
      ts: 1_700_000_000_000,
    });
    expect(result.commitTo).toBe('100');
  });
});

// ── (e) Zero new rows → idle (commitTo:null) ──────────────────────────────────

describe('DefaultIMessageChannel — zero new rows (idle)', () => {
  it('fetch() returns {messages:[],commitTo:null} when there are no new rows', async () => {
    const { ch } = makeChannel({ rows: [], allowlist: [ALLOWED_HANDLE] });
    const result = await ch.fetch();
    expect(result).toEqual({ messages: [], commitTo: null });
  });
});

// ── (c) fetch() is write-free; cursor only changes via commitCursor() ─────────

describe('DefaultIMessageChannel — fetch() performs NO write (T-LOCK-01)', () => {
  it('cursor:imessage unchanged after fetch() on normal path', async () => {
    const meta = new InMemoryMeta();
    meta.setMeta('cursor:imessage', '0'); // pre-seed non-cold-start
    const { ch } = makeChannel({
      rows: [ROW_ALLOWED, ROW_ALLOWED_2],
      allowlist: [ALLOWED_HANDLE],
      meta,
    });
    await ch.fetch();
    // fetch() must not advance the cursor
    expect(meta.getMeta('cursor:imessage')).toBe('0');
  });

  it('cursor advances only after explicit commitCursor() call', async () => {
    const meta = new InMemoryMeta();
    meta.setMeta('cursor:imessage', '0');
    const { ch } = makeChannel({
      rows: [ROW_ALLOWED, ROW_ALLOWED_2],
      allowlist: [ALLOWED_HANDLE],
      meta,
    });
    const { commitTo } = await ch.fetch();
    expect(meta.getMeta('cursor:imessage')).toBe('0'); // not yet advanced
    ch.commitCursor(commitTo!);
    expect(meta.getMeta('cursor:imessage')).toBe('102'); // now advanced to maxRowid
  });

  it('does not re-return rows after cursor advanced via commitCursor()', async () => {
    const meta = new InMemoryMeta();

    const { ch: ch1 } = makeChannel({
      rows: [ROW_ALLOWED, ROW_ALLOWED_2],
      allowlist: [ALLOWED_HANDLE],
      meta,
    });
    const { commitTo } = await ch1.fetch();
    expect(commitTo).toBe('102');
    ch1.commitCursor(commitTo!);
    expect(meta.getMeta('cursor:imessage')).toBe('102');

    // Second channel shares same meta (cursor at 102) → MockChatDbReader.pollNew(102) → empty
    const { ch: ch2 } = makeChannel({
      rows: [ROW_ALLOWED, ROW_ALLOWED_2],
      allowlist: [ALLOWED_HANDLE],
      meta,
    });
    const second = await ch2.fetch();
    expect(second).toEqual({ messages: [], commitTo: null });
  });

  it('commitTo advances past ALL rows including unlisted ones (T-07-03)', async () => {
    const meta = new InMemoryMeta();
    const { ch } = makeChannel({
      rows: [ROW_ALLOWED, ROW_UNLISTED],
      allowlist: [ALLOWED_HANDLE],
      meta,
    });
    const { commitTo } = await ch.fetch();
    // commitTo must be 101 (ROW_UNLISTED rowid), not just 100 (ROW_ALLOWED rowid)
    expect(commitTo).toBe('101');
    ch.commitCursor(commitTo!);
    expect(meta.getMeta('cursor:imessage')).toBe('101');
  });
});

// ── (d) Cold start ────────────────────────────────────────────────────────────

describe('DefaultIMessageChannel — cold start (no history replay on first boot)', () => {
  it('fetch() returns {messages:[],commitTo:<baseline>} with meta cursor STILL NULL', async () => {
    const meta = new InMemoryMeta();
    const { ch } = makeChannel({
      rows: [ROW_ALLOWED, ROW_UNLISTED, ROW_ALLOWED_2], // rowids 100, 101, 102
      allowlist: [ALLOWED_HANDLE],
      meta,
      coldStart: true,
    });
    const result = await ch.fetch();
    expect(result.messages).toEqual([]); // no backfill
    expect(result.commitTo).toBe('102'); // max rowid as baseline
    // meta cursor must still be null — fetch() performs no write (T-LOCK-01)
    expect(meta.getMeta('cursor:imessage')).toBeNull();
  });

  it('cold start with no rows baselines commitTo at 0; meta cursor null until commitCursor', async () => {
    const meta = new InMemoryMeta();
    const { ch } = makeChannel({ rows: [], allowlist: [ALLOWED_HANDLE], meta, coldStart: true });
    const result = await ch.fetch();
    expect(result.messages).toEqual([]);
    expect(result.commitTo).toBe('0');
    expect(meta.getMeta('cursor:imessage')).toBeNull();
    ch.commitCursor(result.commitTo!);
    expect(meta.getMeta('cursor:imessage')).toBe('0');
  });

  it('commitCursor() writes the baseline under caller control', async () => {
    const meta = new InMemoryMeta();
    const { ch } = makeChannel({
      rows: [ROW_ALLOWED, ROW_ALLOWED_2],
      allowlist: [ALLOWED_HANDLE],
      meta,
      coldStart: true,
    });
    const { commitTo } = await ch.fetch();
    expect(meta.getMeta('cursor:imessage')).toBeNull();
    ch.commitCursor(commitTo!);
    expect(meta.getMeta('cursor:imessage')).toBe('102');
  });

  it('after cold-start baseline committed, a newly-arrived allowed row IS delivered', async () => {
    const meta = new InMemoryMeta();
    // First boot: baseline at 102, answer nothing.
    const { ch: ch1 } = makeChannel({
      rows: [ROW_ALLOWED, ROW_ALLOWED_2], // 100, 102
      allowlist: [ALLOWED_HANDLE],
      meta,
      coldStart: true,
    });
    const { commitTo } = await ch1.fetch();
    ch1.commitCursor(commitTo!); // write baseline
    expect(meta.getMeta('cursor:imessage')).toBe('102');

    // A genuinely new message arrives after baseline (rowid 200) — must be delivered.
    const NEW_ROW: ChatDbRow = {
      rowid: 200,
      handle: ALLOWED_HANDLE,
      text: 'a brand new question',
      dateMs: 1_700_000_009_000,
      isFromMe: false,
    };
    const { ch: ch2 } = makeChannel({
      rows: [ROW_ALLOWED, ROW_ALLOWED_2, NEW_ROW],
      allowlist: [ALLOWED_HANDLE],
      meta, // cursor is now '102' (non-null) — normal incremental path
    });
    const result = await ch2.fetch();
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.text).toBe('a brand new question');
    expect(result.commitTo).toBe('200');
  });
});

// ── (f) currentCursor() ───────────────────────────────────────────────────────

describe('DefaultIMessageChannel — currentCursor()', () => {
  it('returns null before any commit (cold start)', () => {
    const meta = new InMemoryMeta();
    const { ch } = makeChannel({ rows: [], allowlist: [ALLOWED_HANDLE], meta, coldStart: true });
    expect(ch.currentCursor()).toBeNull();
  });

  it('returns the persisted cursor value after commitCursor()', () => {
    const meta = new InMemoryMeta();
    meta.setMeta('cursor:imessage', '99');
    const { ch } = makeChannel({ rows: [], allowlist: [ALLOWED_HANDLE], meta });
    expect(ch.currentCursor()).toBe('99');
  });

  it('reflects writes made via commitCursor()', async () => {
    const meta = new InMemoryMeta();
    const { ch } = makeChannel({
      rows: [ROW_ALLOWED],
      allowlist: [ALLOWED_HANDLE],
      meta,
    });
    const { commitTo } = await ch.fetch();
    ch.commitCursor(commitTo!);
    expect(ch.currentCursor()).toBe('100');
  });
});

// ── commitCursor monotonicity ─────────────────────────────────────────────────

describe('DefaultIMessageChannel — commitCursor monotonicity', () => {
  it('does not regress the cursor when commitTo <= current', () => {
    const meta = new InMemoryMeta();
    const { ch } = makeChannel({ rows: [], allowlist: [ALLOWED_HANDLE], meta });
    ch.commitCursor('100');
    expect(meta.getMeta('cursor:imessage')).toBe('100');
    ch.commitCursor('50'); // regression attempt — no-op
    expect(meta.getMeta('cursor:imessage')).toBe('100');
    ch.commitCursor('100'); // equal — no-op
    expect(meta.getMeta('cursor:imessage')).toBe('100');
  });
});

// ── (g) send() forwards recipient + text to MockOsascriptSender ───────────────

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

// ── C-1: fetch() never throws even when reader throws ────────────────────────

describe('DefaultIMessageChannel — C-1 never-throws contract', () => {
  it('fetch() resolves to idle when reader.pollNew() throws (chat.db lock)', async () => {
    const throwingReader = {
      maxRowId(): number { return 0; },
      pollNew(_cursor: number): never { throw new Error('SQLITE_BUSY: unable to open db'); },
    };
    const meta = new InMemoryMeta();
    meta.setMeta('cursor:imessage', '0'); // non-null cursor → reaches pollNew
    const ch = new DefaultIMessageChannel(
      makeConfig([ALLOWED_HANDLE]),
      throwingReader as any,
      new MockOsascriptSender(),
      meta,
      () => {},
    );
    const result = await ch.fetch();
    expect(result).toEqual({ messages: [], commitTo: null });
  });

  it('fetch() resolves to idle when reader.maxRowId() throws (cold start path)', async () => {
    const throwingReader = {
      maxRowId(): never { throw new Error('SQLITE_BUSY: database is locked'); },
      pollNew(_cursor: number): never { throw new Error('unreachable'); },
    };
    const meta = new InMemoryMeta(); // null cursor → cold start path → maxRowId()
    const ch = new DefaultIMessageChannel(
      makeConfig([ALLOWED_HANDLE]),
      throwingReader as any,
      new MockOsascriptSender(),
      meta,
      () => {},
    );
    const result = await ch.fetch();
    expect(result).toEqual({ messages: [], commitTo: null });
  });
});

// ── (h) Injection-shaped text passed as data, not script (T-07-02) ────────────

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
