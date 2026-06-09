/**
 * Channel seam (Phase 7, D-70).
 *
 * Defines the one-value transport boundary for conversational access:
 *   receive — poll for new allowlisted inbound messages; advances cursor internally
 *   send    — deliver a reply to a recipient handle
 *
 * Transport selection stays STRICTLY BELOW this layer (D-70): the iMessage
 * implementation lives in imessage-channel.ts; the responder and watcher are
 * channel-agnostic. OSS self-hosters can add Telegram/Signal/CLI channels without
 * touching the responder.
 *
 * Threat mitigations:
 *  - T-07-01: allowlist check is performed by the impl ABOVE this layer (D-74 fail-closed);
 *    an empty allowlist means receive() returns [] for all senders until configured.
 *  - T-07-KEY: no secrets (env keys, tokens, handles) at construction; impls read config
 *    lazily on first receive()/send() call — no side effects at new time.
 *
 * Structure: Channel interface + InboundMessage type + MockChannel (scripted-queue,
 * no network, no filesystem, suitable for all unit tests).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single inbound message from a channel transport.
 *
 * id     — stable dedup key; for chat.db the ROWID cast to string.
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

// ---------------------------------------------------------------------------
// Channel seam interface (D-70)
// ---------------------------------------------------------------------------

/**
 * Transport boundary for conversational access (D-70).
 *
 * Implementations: DefaultIMessageChannel (iMessage / chat.db + osascript),
 * MockChannel (scripted queues, deterministic, no I/O).
 *
 * Allowlist gating and dedup are handled by the implementation; callers receive
 * only messages that have already been filtered and are new since the last call.
 */
export interface Channel {
  /**
   * Poll for new allowlisted inbound messages.
   *
   * Returns messages that arrived since the last call (the impl advances its own
   * dedup cursor internally). Returns an empty array when there are no new messages
   * or when the allowlist is empty (D-74 fail-closed). Never throws; errors are
   * caught by the impl and logged to file.
   */
  receive(): Promise<InboundMessage[]>;

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
 * receive() returns scripted InboundMessage[] batches in order; returns [] when
 * the script is exhausted (never throws — matches production empty-poll behavior).
 * send() records all calls on the public `sent` array for test assertions.
 * Constructor is side-effect-free: no network, no filesystem, no credentials.
 */
export class MockChannel implements Channel {
  private readonly receiveScript: InboundMessage[][];
  private receiveIdx = 0;

  /** All send() calls recorded here for test assertions: [{recipient, text}, ...] */
  readonly sent: Array<{ recipient: string; text: string }> = [];

  constructor({
    receiveScript = [],
  }: {
    receiveScript?: InboundMessage[][];
  } = {}) {
    this.receiveScript = receiveScript.map(batch => [...batch]);
  }

  async receive(): Promise<InboundMessage[]> {
    if (this.receiveIdx >= this.receiveScript.length) {
      return [];
    }
    return this.receiveScript[this.receiveIdx++]!;
  }

  async send(recipient: string, text: string): Promise<void> {
    this.sent.push({ recipient, text });
  }
}
