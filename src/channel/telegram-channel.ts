/**
 * TelegramChannel — Telegram bot transport (Phase 7, primary query surface).
 *
 * Why Telegram over iMessage: a bot has its OWN identity, so it never receives its
 * own outbound replies. The iMessage self-echo loop (sender == recipient on a shared
 * Apple ID) is structurally impossible here. No Full Disk Access, no chat.db, no
 * osascript — just the Telegram Bot API over HTTPS.
 *
 * Design (mirrors DefaultIMessageChannel):
 *  - Fail-closed allowlist: empty allowlist → fetch() returns {messages:[],commitTo:null}.
 *  - cursor:telegram in the meta store dedups updates (getUpdates offset semantics).
 *  - Cold start (no cursor): fetch() returns {messages:[],commitTo:<baseline>} and performs
 *    NO write — the caller writes the baseline under the single-writer lock.
 *  - Cursor advanced past ALL scanned updates (listed or not) so unlisted updates are
 *    confirmed and not re-fetched.
 *
 * Threat mitigations:
 *  - Injection: reply text is sent as a JSON body field (chat_id + text), never
 *    interpolated into a URL, shell, or query — fetch with a JSON body treats it as data.
 *  - Info disclosure: the bot token lives in BRAIN_MEMORY_TELEGRAM_TOKEN (env), is part
 *    of the API path only, and is never logged.
 *  - Fail-closed: empty allowlist answers no one; unlisted senders are silently ignored.
 *  - T-LOCK-01: fetch() is write-free; commitCursor() is the only cursor writer,
 *    called by the watcher under the lock (LOCK-CHANNEL-SPLIT).
 *
 * Structure: TelegramTransport seam + DefaultTelegramTransport (fetch, zero deps) +
 *            MockTelegramTransport (scripted) + TelegramChannel (Channel impl).
 */

import type { Channel, InboundMessage, FetchResult } from './channel';
import type { EngineConfig } from '../lib/config';

// ---------------------------------------------------------------------------
// Telegram Bot API update shape (only the fields we consume)
// ---------------------------------------------------------------------------

export interface TelegramUpdate {
  /** Monotonically increasing update identifier — the dedup cursor (offset). */
  update_id: number;
  /** Present for message updates; absent for other update types we ignore. */
  message?: {
    message_id: number;
    /** Sender — matched (by numeric id) against the allowlist. */
    from?: { id: number; is_bot?: boolean; username?: string };
    /** Conversation — replies are sent back to chat.id. */
    chat?: { id: number };
    /** Unix seconds. */
    date: number;
    /** Message body; non-text updates (stickers, photos) have no text and are ignored. */
    text?: string;
  };
}

// ---------------------------------------------------------------------------
// TelegramTransport seam (injected — Default uses fetch, Mock is scripted)
// ---------------------------------------------------------------------------

/**
 * Seam for Telegram Bot API I/O. Injected into TelegramChannel so unit tests can
 * replace real network calls with MockTelegramTransport.
 */
export interface TelegramTransport {
  /**
   * Fetch updates with update_id >= offset (Telegram getUpdates semantics: passing
   * offset also confirms/forgets updates with a lower id). Returns ascending by update_id.
   */
  getUpdates(offset: number): Promise<TelegramUpdate[]>;

  /** Send a text message to a chat. text is treated as data, never interpolated. */
  sendMessage(chatId: number, text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// DefaultTelegramTransport — production impl via global fetch (zero dependencies)
// ---------------------------------------------------------------------------

interface GetUpdatesResponse {
  ok: boolean;
  result?: TelegramUpdate[];
}

/**
 * Production transport backed by the Telegram Bot API over HTTPS.
 *
 * Uses Node's global fetch (Node 18+) — no npm dependency. The bot token is part of
 * the API path (Telegram's scheme) and is never logged. getUpdates uses timeout=0
 * (short poll) to fit the watcher's per-tick lock model.
 */
export class DefaultTelegramTransport implements TelegramTransport {
  private readonly base: string;

  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    const res = await fetch(`${this.base}/getUpdates?offset=${String(offset)}&timeout=0`);
    const body = (await res.json()) as GetUpdatesResponse;
    return body.ok && body.result ? body.result : [];
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    // text + chat_id travel in a JSON body — never interpolated into the URL/shell.
    await fetch(`${this.base}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  }
}

// ---------------------------------------------------------------------------
// MockTelegramTransport — scripted updates, no network; for unit tests
// ---------------------------------------------------------------------------

/**
 * Scripted transport for unit tests. Records sendMessage calls on a public `sent` array;
 * getUpdates(offset) returns scripted updates with update_id >= offset (Telegram semantics).
 * A sent reply is NEVER added to the update queue — modeling that a bot does not receive
 * its own messages (the no-self-echo property).
 */
export class MockTelegramTransport implements TelegramTransport {
  readonly sent: Array<{ chatId: number; text: string }> = [];
  private readonly updates: TelegramUpdate[];

  constructor(updates: TelegramUpdate[] = []) {
    this.updates = [...updates].sort((a, b) => a.update_id - b.update_id);
  }

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    return this.updates.filter(u => u.update_id >= offset);
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.sent.push({ chatId, text });
  }
}

// ---------------------------------------------------------------------------
// MetaStore interface (structural, avoids circular import)
// ---------------------------------------------------------------------------

interface MetaStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

// ---------------------------------------------------------------------------
// TelegramChannel — Channel impl
// ---------------------------------------------------------------------------

export class TelegramChannel implements Channel {
  private readonly config: EngineConfig;
  private readonly transport: TelegramTransport;
  private readonly meta: MetaStore;
  private readonly log: (msg: string) => void;

  constructor(
    config: EngineConfig,
    transport: TelegramTransport,
    meta: MetaStore,
    log: (msg: string) => void
  ) {
    this.config = config;
    this.transport = transport;
    this.meta = meta;
    this.log = log;
  }

  /**
   * Poll Telegram for new allowlisted messages. Performs NO write (T-LOCK-01).
   *
   * Fail-closed: empty allowlist → {messages:[], commitTo:null} — idle, lock never touched.
   * Cold start (no cursor): fetches baseline, returns {messages:[], commitTo:<baseline>} with
   *   the meta cursor STILL NULL — the caller writes it under the lock via commitCursor().
   * Normal: fetches updates after the cursor; if zero → {messages:[], commitTo:null} (idle);
   *   otherwise returns the allowlisted InboundMessage[] and the max scanned update_id as commitTo.
   *   commitTo covers ALL scanned updates (listed or not) so unlisted ones are confirmed.
   */
  async fetch(): Promise<FetchResult> {
    // Fail-closed — empty allowlist answers no one; commitTo=null signals idle (no lock needed)
    if (this.config.telegram.allowlist.length === 0) {
      return { messages: [], commitTo: null };
    }

    const cursorRaw = this.meta.getMeta('cursor:telegram');

    // Cold start (first-ever boot — no cursor persisted): baseline at the current max
    // update_id and answer NOTHING. Telegram queues updates for ~24h; without this, a
    // first boot would replay/answer the whole backlog. The baseline write is deferred to
    // commitCursor() so it lands under the single-writer lock (T-LOCK-01).
    if (cursorRaw === null) {
      const pending = await this.transport.getUpdates(0);
      const baseline = pending.reduce((max, u) => Math.max(max, u.update_id), 0);
      this.log('cold start: telegram baseline at update_id ' + String(baseline) + ' — backlog skipped (write deferred to commitCursor)');
      return { messages: [], commitTo: String(baseline) };
    }

    const cursor = parseInt(cursorRaw, 10);

    // offset = cursor + 1 → fetch updates with update_id > cursor (Telegram confirms <= cursor)
    const updates = await this.transport.getUpdates(cursor + 1);
    if (updates.length === 0) {
      // No new updates — return commitTo:null to signal idle (caller skips lock acquisition)
      return { messages: [], commitTo: null };
    }

    // commitTo covers ALL scanned updates (listed or not) — unlisted ones are confirmed so
    // they are not re-fetched on the next tick. (Same invariant as before, now in commitTo.)
    const maxId = updates.reduce((max, u) => Math.max(max, u.update_id), cursor);

    const allow = new Set(this.config.telegram.allowlist.map(s => s.trim()));

    const result: InboundMessage[] = [];
    for (const u of updates) {
      const msg = u.message;
      // Ignore non-text or malformed updates (stickers, joins, channel posts, etc.)
      if (!msg || !msg.from || !msg.chat || typeof msg.text !== 'string' || msg.text.length === 0) {
        continue;
      }
      const fromId = String(msg.from.id);
      if (allow.has(fromId)) {
        result.push({
          id: String(u.update_id),
          sender: String(msg.chat.id), // reply target
          text: msg.text,
          ts: msg.date * 1000, // Telegram date is Unix seconds → ms
        });
      } else {
        this.log('ignored unlisted telegram sender');
      }
    }

    return { messages: result, commitTo: String(maxId) };
  }

  /**
   * Advance cursor:telegram past commitTo. Called under the single-writer lock (T-LOCK-01).
   *
   * Belt-and-suspenders monotonicity: if commitTo <= the stored cursor, does nothing.
   */
  commitCursor(commitTo: string): void {
    const current = this.meta.getMeta('cursor:telegram');
    if (current !== null && Number(commitTo) <= Number(current)) return; // monotonic — no regression
    this.meta.setMeta('cursor:telegram', commitTo);
  }

  /**
   * Return the currently persisted cursor:telegram value, or null if unset (first boot).
   * Read by the watcher under the lock to drop stale messages and check monotonicity.
   */
  currentCursor(): string | null {
    return this.meta.getMeta('cursor:telegram');
  }

  /**
   * Send a reply to a chat via the injected transport.
   * recipient is the numeric chat id (as a string from InboundMessage.sender).
   */
  async send(recipient: string, text: string): Promise<void> {
    await this.transport.sendMessage(Number(recipient), text);
  }
}
