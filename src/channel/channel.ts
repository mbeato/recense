/**
 * Channel seam (Phase 7, D-70).
 *
 * Defines the one-value transport boundary for conversational access:
 *   fetch         — poll for new allowlisted inbound messages; performs NO write.
 *                   Returns messages and the cursor value to commit (commitTo).
 *   commitCursor  — advance the dedup cursor past processed messages; called by
 *                   the watcher UNDER the single-writer lock, after processing.
 *   currentCursor — return the currently persisted cursor value (or null if unset).
 *   send          — deliver a reply to a recipient handle
 *
 * The fetch/commitCursor split is the load-bearing invariant of the lock-narrowing
 * refactor (LOCK-CHANNEL-SPLIT): fetch() is write-free so idle ticks never contend
 * for the lock with `brain recall`; the cursor advances only after successful
 * processing, preserving no-message-loss (invariant #2, D-75).
 *
 * Transport selection stays STRICTLY BELOW this layer (D-70): the iMessage
 * implementation lives in imessage-channel.ts; the responder and watcher are
 * channel-agnostic. OSS self-hosters can add Telegram/Signal/CLI channels without
 * touching the responder.
 *
 * Threat mitigations:
 *  - T-07-01: allowlist check is performed by the impl ABOVE this layer (D-74 fail-closed);
 *    an empty allowlist means fetch() returns {messages:[], commitTo:null} so idle ticks
 *    never acquire the lock (T-LOCK-01).
 *  - T-07-KEY: no secrets (env keys, tokens, handles) at construction; impls read config
 *    lazily on first fetch()/send() call — no side effects at new time.
 *  - T-LOCK-01: commitCursor is the ONLY cursor writer and is called under the lock.
 *
 * Structure: Channel interface + InboundMessage type + FetchResult type +
 *            MockChannel (scripted-queue, no network, no filesystem, suitable for all unit tests).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single inbound message from a channel transport.
 *
 * id     — stable dedup key; for chat.db the ROWID cast to string; for Telegram the update_id.
 * sender — normalized handle (E.164 phone or email) matching config.channel.allowlist.
 * text   — decoded message body (attributedBody fallback applied before this point).
 * ts     — message timestamp as Unix milliseconds.
 */
export interface InboundMessage {
  id: string;
  sender: string;
  text: string;
  ts: number;
}

/**
 * Return value of Channel.fetch().
 *
 * messages  — allowlisted inbound messages since the last committed cursor.
 * commitTo  — the cursor value the caller SHOULD commit after processing all messages.
 *             MUST be null when zero updates/rows were scanned (idle tick contract: callers
 *             skip lock acquisition when commitTo === null && messages.length === 0).
 *             On cold start (first-ever boot, no cursor persisted), commitTo is the computed
 *             baseline update_id/rowid even though messages is empty — the caller commits it
 *             under the lock to record the baseline.
 */
export interface FetchResult {
  messages: InboundMessage[];
  commitTo: string | null;
}

// ---------------------------------------------------------------------------
// Channel seam interface (D-70)
// ---------------------------------------------------------------------------

/**
 * Transport boundary for conversational access (D-70).
 *
 * Implementations: TelegramChannel, DefaultIMessageChannel, MockChannel.
 *
 * The fetch/commitCursor split ensures the expensive network/DB read is off the
 * single-writer lock: only the cursor write (commitCursor) and the LLM response path
 * need the lock. Idle ticks — where fetch returns {messages:[], commitTo:null} — never
 * touch the lock (LOCK-CHANNEL-SPLIT invariant).
 */
export interface Channel {
  /**
   * Poll for new allowlisted inbound messages WITHOUT writing anything.
   *
   * Performs the network or DB read and returns the allowlisted messages AND the cursor
   * value that WOULD be committed (`commitTo` = max scanned id). MUST perform no write:
   * no setMeta, no cursor advance.
   *
   * commitTo MUST be null when zero updates/rows were scanned — this signals an idle tick
   * to the caller, which then skips lock acquisition entirely (no lock contention with
   * `brain recall` during idle periods).
   *
   * Cold start: returns {messages:[], commitTo:<baseline>} — the baseline write is deferred
   * to commitCursor() called by the watcher under the lock.
   *
   * Never throws; errors are caught by the impl and logged to file.
   */
  fetch(): Promise<FetchResult>;

  /**
   * Advance the dedup cursor past commitTo. Called by the watcher UNDER the lock,
   * AFTER all messages in the batch have been processed.
   *
   * Belt-and-suspenders monotonicity: if commitTo <= the currently stored cursor
   * (by numeric comparison), this is a no-op — the cursor never regresses.
   *
   * commitTo — the value returned by the preceding fetch() call.
   */
  commitCursor(commitTo: string): void;

  /**
   * Return the currently persisted cursor value, or null if not yet set (first boot).
   * Read by the watcher under the lock to drop stale messages and to decide whether to
   * skip a redundant commit (monotonic guard).
   */
  currentCursor(): string | null;

  /**
   * Send a reply to the given recipient handle.
   *
   * recipient — normalized E.164 or email handle (the sender field from InboundMessage).
   * text      — reply body; never contains raw error payloads (safe-null discipline).
   */
  send(recipient: string, text: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// MockChannel — deterministic, no network, no filesystem; for unit tests
// ---------------------------------------------------------------------------

/**
 * Scripted mock for unit tests. Mirrors the MockModelProvider pattern (SEAM-01).
 *
 * fetch() returns scripted FetchResult batches in order; returns {messages:[],commitTo:null}
 * when the script is exhausted (never throws — matches production empty-poll behavior).
 * commitCursor(v) records every successful (non-skipped) call on the public `committed`
 * array and updates the internal cursor, honoring the monotonic skip: if v <= current
 * cursor, it is a no-op (neither recorded nor stored).
 * currentCursor() returns the current internal cursor, or null if no commit has occurred.
 * send() records all calls on the public `sent` array for test assertions.
 * Constructor is side-effect-free: no network, no filesystem, no credentials.
 */
export class MockChannel implements Channel {
  private readonly fetchScript: FetchResult[];
  private fetchIdx = 0;
  private cursor: string | null = null;

  /** All fetch-result commits recorded here: ['<commitTo>', ...] — in call order. */
  readonly committed: string[] = [];

  /** All send() calls recorded here for test assertions: [{recipient, text}, ...] */
  readonly sent: Array<{ recipient: string; text: string }> = [];

  constructor({
    fetchScript = [],
  }: {
    fetchScript?: FetchResult[];
  } = {}) {
    // Deep-copy to prevent test mutations leaking across instances
    this.fetchScript = fetchScript.map(b => ({ messages: [...b.messages], commitTo: b.commitTo }));
  }

  async fetch(): Promise<FetchResult> {
    if (this.fetchIdx >= this.fetchScript.length) {
      return { messages: [], commitTo: null };
    }
    return this.fetchScript[this.fetchIdx++]!;
  }

  commitCursor(commitTo: string): void {
    // Belt-and-suspenders monotonic skip: never let the cursor regress
    if (this.cursor !== null && Number(commitTo) <= Number(this.cursor)) return;
    this.cursor = commitTo;
    this.committed.push(commitTo);
  }

  currentCursor(): string | null {
    return this.cursor;
  }

  async send(recipient: string, text: string): Promise<void> {
    this.sent.push({ recipient, text });
  }
}
