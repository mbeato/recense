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
 * Seam for Telegram Bot API I/O. Injected into the poll loop so unit tests can
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
 * (short poll) to fit the poll loop's per-tick model.
 */
export class DefaultTelegramTransport implements TelegramTransport {
  private readonly base: string;

  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  async getUpdates(offset: number): Promise<TelegramUpdate[]> {
    const res = await fetch(`${this.base}/getUpdates?offset=${String(offset)}&timeout=0`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error('telegram getUpdates HTTP ' + String(res.status));
    const body = (await res.json()) as GetUpdatesResponse;
    return body.ok && body.result ? body.result : [];
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    // text + chat_id travel in a JSON body — never interpolated into the URL/shell.
    const res = await fetch(`${this.base}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error('telegram sendMessage HTTP ' + String(res.status));
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
