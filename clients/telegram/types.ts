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
 * A callback_query update collected during fetchMessages.
 * Passed to runClientTick for draining after the message respond loop.
 */
export interface CollectedCallbackQuery {
  /** callback_query.id — passed to answerCallbackQuery to clear the Telegram spinner. */
  id: string;
  /** callback_query.data — the encoded payload (may be absent for URL buttons). */
  data: string | undefined;
  /** callback_query.from.id — checked against the allowlist before calling surfaceSeen. */
  fromId: number;
}

/**
 * Return value of a fetch operation.
 *
 * messages        — allowlisted inbound messages since the last committed cursor.
 * callbackQueries — button-tap updates collected from the same getUpdates batch.
 *                   Allowlist check is applied in runClientTick (not in fetchMessages).
 * commitTo        — the cursor value the caller SHOULD commit after processing all messages.
 *                   null on idle tick (nothing to process, no cursor advance needed).
 *                   On cold start (no cursor persisted), commitTo is the computed baseline
 *                   update_id even when messages is empty — the caller commits it to record
 *                   the baseline.
 */
export interface FetchResult {
  messages: InboundMessage[];
  callbackQueries: CollectedCallbackQuery[];
  commitTo: string | null;
}
