// ---------------------------------------------------------------------------
// Client-local type contracts (engine-free copies of the channel shapes)
// ---------------------------------------------------------------------------

/** An inbound message from the Telegram channel. */
export interface InboundMessage {
  id: string;
  sender: string;
  text: string;
  ts: number;
}

/**
 * Return value of a fetch operation.
 *
 * messages  — allowlisted inbound messages since the last committed cursor.
 * commitTo  — the cursor value the caller SHOULD commit after processing all messages.
 *             null on idle tick (nothing to process, no cursor advance needed).
 *             On cold start (no cursor persisted), commitTo is the computed baseline
 *             update_id even when messages is empty — the caller commits it to record
 *             the baseline.
 */
export interface FetchResult {
  messages: InboundMessage[];
  commitTo: string | null;
}
