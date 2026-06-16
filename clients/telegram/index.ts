import { appendFileSync } from 'fs';
import { type ClientConfig, loadClientConfig } from './config';
import { readStateCursor, writeStateCursor } from './state';
import { DefaultTelegramTransport, type TelegramTransport, type InlineKeyboardMarkup } from './transport';
import { type FetchResult, type InboundMessage, type CollectedCallbackQuery } from './types';
import { createMemoryClient, type MemoryClient, type SurfaceItem } from './memory-client';
import { encodeCallbackData, decodeCallbackData } from './push-codec';

// ---------------------------------------------------------------------------
// Log helper — append-only file log; never stdout (background process, T-13-05)
// Bearer token and bot token MUST NOT appear in log messages.
// ---------------------------------------------------------------------------

const LOG_PATH = '/tmp/recense-telegram-client.log';

/** Append a timestamped line to the log file. */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] telegram-client: ${msg}\n`);

// ---------------------------------------------------------------------------
// In-process tick serialization guards
//
// tickInFlight: Set true BEFORE the first await inside runClientTick; cleared in
//   the outermost finally so it resets even on the early-return (ask error / idle)
//   paths. Prevents a second setInterval tick from overlapping with an in-flight respond.
//
// pushInFlight: Independent guard for runPushTick — the push timer and the reactive
//   tick run on separate setIntervals and must each have their own guard. Never share.
// ---------------------------------------------------------------------------

let tickInFlight = false;
let pushInFlight = false;

// ---------------------------------------------------------------------------
// Inlined Telegram fetch logic
// Ported from src/channel/telegram-channel.ts TelegramChannel.fetch().
// Cursor source is the client-local state file (readStateCursor), not MetaStore.
// ---------------------------------------------------------------------------

/**
 * Poll Telegram for new allowlisted messages and callback_query updates.
 * Performs NO state write (T-LOCK-01).
 *
 * Fail-closed: empty allowlist → {messages:[], callbackQueries:[], commitTo:null} — idle,
 *   no ask call made.
 * Private chats only: the allowlist authorizes the SENDER, but replies go to the CHAT —
 *   a group update from an allowlisted sender would broadcast memory content to unlisted
 *   members, so non-private chats are skipped (still confirmed via commitTo).
 * Cold start (no cursor): paginates to exhaustion (L-9), returns baseline commitTo with
 *   empty messages so the caller can commit the baseline and skip the backlog.
 * Normal: fetches updates after cursor; zero new → idle; otherwise returns allowlisted
 *   InboundMessages, collected callback_query items, and max scanned update_id as commitTo.
 * Never throws (C-1): transport errors are caught, logged, and returned as idle.
 */
export async function fetchMessages(
  transport: TelegramTransport,
  config: Pick<ClientConfig, 'allowlist' | 'statePath'>,
): Promise<FetchResult> {
  try {
    // Fail-closed — empty allowlist answers no one; commitTo=null signals idle (D-10)
    if (config.allowlist.length === 0) {
      return { messages: [], callbackQueries: [], commitTo: null };
    }

    const cursorRaw = readStateCursor(config.statePath);

    // Cold start (no cursor persisted): paginate to exhaustion to get the true current
    // max update_id — a >100-update backlog is only partially scanned by a single
    // getUpdates(0) call (Telegram default page = 100). Answer NOTHING; caller commits
    // the baseline so the next tick fetches only genuinely new messages (D-71, L-9).
    if (cursorRaw === null) {
      let offset = 0;
      let maxId = 0;
      while (true) {
        const page = await transport.getUpdates(offset);
        if (page.length === 0) break;
        for (const u of page) {
          if (u.update_id > maxId) maxId = u.update_id;
        }
        offset = maxId + 1;
      }
      log('cold start: telegram baseline at update_id ' + String(maxId) + ' — backlog skipped');
      return { messages: [], callbackQueries: [], commitTo: String(maxId) };
    }

    const cursor = parseInt(cursorRaw, 10);
    // offset = cursor + 1 → fetch updates with update_id > cursor (Telegram confirms <= cursor)
    const updates = await transport.getUpdates(cursor + 1);
    if (updates.length === 0) {
      // No new updates — commitTo:null signals idle (caller skips cursor write)
      return { messages: [], callbackQueries: [], commitTo: null };
    }

    // commitTo covers ALL scanned updates (listed or not) — unlisted ones are confirmed
    // so they are not re-fetched on the next tick.
    const maxId = updates.reduce((max, u) => Math.max(max, u.update_id), cursor);
    const allow = new Set(config.allowlist.map(s => s.trim()));

    const messages: InboundMessage[] = [];
    const callbackQueries: CollectedCallbackQuery[] = [];

    for (const u of updates) {
      // Collect callback_query updates (allowlist applied in runClientTick, not here,
      // so all callback_query items are returned; update_id already covered by maxId).
      if (u.callback_query) {
        const cq = u.callback_query;
        callbackQueries.push({ id: cq.id, data: cq.data, fromId: cq.from.id });
      }

      const msg = u.message;
      // Ignore non-text or malformed updates (stickers, photos, joins, channel posts, etc.)
      if (
        !msg ||
        !msg.from ||
        !msg.chat ||
        typeof msg.text !== 'string' ||
        msg.text.length === 0
      ) {
        continue;
      }
      const fromId = String(msg.from.id);
      if (!allow.has(fromId)) {
        log('ignored unlisted telegram sender');
        continue;
      }
      // Private chats only: in a Telegram private chat, chat.id === from.id — require
      // both the declared type and the id equality so a group reply target can never
      // leak memory content to unlisted chat members. Skipped updates stay covered by
      // commitTo (computed above), so they are confirmed and not re-fetched.
      if (msg.chat.type !== 'private' || String(msg.chat.id) !== fromId) {
        log('ignored non-private telegram chat');
        continue;
      }
      messages.push({
        id: String(u.update_id),
        sender: String(msg.chat.id), // reply target (=== sender id in a private chat)
        text: msg.text,
        ts: msg.date * 1000, // Telegram date is Unix seconds → ms
      });
    }

    return { messages, callbackQueries, commitTo: String(maxId) };
  } catch (err) {
    // C-1: "never throws" — transport errors must not crash the poll loop.
    // Log to file, return idle so the cursor is never advanced on fetch error.
    log('telegram fetch error: ' + String(err));
    return { messages: [], callbackQueries: [], commitTo: null };
  }
}

// ---------------------------------------------------------------------------
// Full tick: fetch + stale-filter + respond + callback_query drain + cursor commit
// Ported from src/adapter/watcher-cli.ts runLockedTick (engine lock removed).
// ---------------------------------------------------------------------------

/**
 * Fetch-then-respond tick, lock-free (cursor is client-local state file).
 *
 * Flow:
 *  1. tickInFlight guard — if already in-flight, log + return without fetching.
 *  2. fetchMessages() — write-free; errors return idle (C-1 never-throws).
 *  3. Idle check — commitTo === null && messages empty && no callbackQueries → return.
 *  4. Re-read live cursor via readStateCursor; drop messages with id <= cursor (stale).
 *  5. Monotonic commit check — if commitTo <= cursor, skip cursor write.
 *  6. Respond loop — ask() each message; safe-null: only send when answer !== null
 *     && origin !== 'none'. Inferred answers carry a visible '(inferred) ' prefix
 *     unless the server-composed answer already ends with the marker.
 *  7. D-04 no-loss: if ask() throws (serve unreachable / non-2xx), log + RETURN
 *     WITHOUT committing cursor → message retried next tick, no message loss.
 *  8. callback_query draining — decode → allowlist check → surfaceSeen → answerCallbackQuery.
 *     Critical: callback errors do NOT hold the cursor (unlike D-04 for messages). The
 *     surfaceSeen upsert is idempotent; a re-tap resends; cursor-hold would re-process
 *     the same callback on every tick. answerCallbackQuery ALWAYS called (clears spinner).
 *  9. Commit cursor via writeStateCursor when not skipCommit.
 */
export async function runClientTick(
  config: ClientConfig,
  transport: TelegramTransport,
  memoryClient: MemoryClient,
): Promise<void> {
  // ── 1. In-process tick guard (must be set BEFORE first await) ────────────
  if (tickInFlight) {
    log('tick already in flight — skipping re-entry');
    return;
  }
  tickInFlight = true;

  try {
    // ── 2. Fetch UNLOCKED — no state write ─────────────────────────────────
    // Belt-and-suspenders outer catch: fetchMessages should never throw (C-1),
    // but if it does, log and return without advancing the cursor.
    let messages: InboundMessage[];
    let callbackQueries: CollectedCallbackQuery[];
    let commitTo: string | null;
    try {
      ({ messages, callbackQueries, commitTo } = await fetchMessages(transport, config));
    } catch (err) {
      log('fetch error: ' + String(err));
      return;
    }

    // ── 3. Idle check ───────────────────────────────────────────────────────
    if (commitTo === null && messages.length === 0 && callbackQueries.length === 0) {
      return;
    }

    // ── 4. Re-read live cursor to drop stale messages ───────────────────────
    // A previous tick may have committed the cursor between our unlocked fetch()
    // and now. Drop any message whose id <= the current committed cursor.
    const cursor = readStateCursor(config.statePath);
    const filtered =
      cursor !== null
        ? messages.filter(m => Number(m.id) > Number(cursor))
        : messages;

    // ── 5. Monotonic commit check ───────────────────────────────────────────
    // If commitTo <= cursor, the cursor already covers this batch — skip the write.
    const skipCommit =
      commitTo !== null && cursor !== null && Number(commitTo) <= Number(cursor);

    // ── 6–7. Respond loop ───────────────────────────────────────────────────
    for (const m of filtered) {
      let answer: string | null = null;
      let origin = 'none';
      try {
        ({ answer, origin } = await memoryClient.ask(m.text));
      } catch (err) {
        // D-04: serve unreachable or non-2xx → log, no reply, cursor NOT advanced.
        // Message will be retried on the next tick (no message loss).
        log('ask error — serve unreachable, cursor not advanced: ' + String(err));
        return;
      }
      // Safe-null (origin semantics D-09): only reply when memory has a grounded answer.
      // origin === 'none' or answer === null → stay silent (T-07-04 / D-75).
      if (answer !== null && origin !== 'none') {
        // Provenance presentation (docs/reference-client.md rule 1): mark inferred
        // answers visibly so the user knows they are reading an inference, not a
        // record. Idempotent: recense serve already embeds a trailing " (inferred)"
        // marker in inferred answers (src/responder), so the prefix is only added
        // when no marker is present — answers are never double-marked.
        const text =
          origin === 'inferred' && !answer.endsWith('(inferred)')
            ? '(inferred) ' + answer
            : answer;
        try {
          await transport.sendMessage(Number(m.sender), text);
        } catch (sendErr) {
          // Send errors do not prevent cursor advance — the message was answered.
          log('send error: ' + String(sendErr));
        }
      }
    }

    // ── 8. callback_query draining ──────────────────────────────────────────
    // MUST drain AFTER the message respond loop and BEFORE cursor commit.
    // Critical distinction from D-04: callback errors do NOT block cursor advance.
    // surfaceSeen is idempotent; a re-tap resends; cursor-hold would cause infinite
    // re-processing of the same callback. answerCallbackQuery is ALWAYS called on
    // every branch (allowlisted, unlisted, malformed, surfaceSeen-error) to clear
    // the Telegram client-side spinner (Pitfall 1 — answerCallbackQuery is mandatory).
    if (callbackQueries.length > 0) {
      const allow = new Set(config.allowlist.map(s => s.trim()));

      for (const cq of callbackQueries) {
        const fromId = String(cq.fromId);

        if (!allow.has(fromId)) {
          // Unlisted sender: skip surfaceSeen but still answer (T-22-01)
          log('callback_query from unlisted sender — ignored');
          try { await transport.answerCallbackQuery(cq.id); } catch (e) { log('answerCallbackQuery error (unlisted): ' + String(e)); }
          continue;
        }

        // Decode callback_data — returns null on malformed input (T-22-02)
        const decoded = decodeCallbackData(cq.data ?? '');
        if (!decoded) {
          log('callback_query: no callback_data or unrecognized format — skipping surfaceSeen');
          try { await transport.answerCallbackQuery(cq.id); } catch (e) { log('answerCallbackQuery error (malformed): ' + String(e)); }
          continue;
        }

        // Compute snooze_until only for snoozed outcome (D-09 fixed +snoozeDurationMs)
        const snoozeUntil =
          decoded.outcome === 'snoozed'
            ? new Date(Date.now() + config.snoozeDurationMs).toISOString()
            : undefined;

        try {
          await memoryClient.surfaceSeen({
            node_id: decoded.nodeId,
            occurrence_due_at: decoded.occurrenceDueAt,
            outcome: decoded.outcome,
            snooze_until: snoozeUntil,
          });
        } catch (err) {
          // Unlike message errors (D-04 no-loss), callback_query errors do NOT hold
          // the cursor. Log and continue — answerCallbackQuery still fires below.
          log('surfaceSeen error for callback_query: ' + String(err));
        }

        // MUST call on every branch — unconditional spinner clear (Pitfall 1)
        try {
          await transport.answerCallbackQuery(cq.id);
        } catch (err) {
          log('answerCallbackQuery error: ' + String(err));
        }
      }
    }

    // ── 9. Commit cursor AFTER successful processing ─────────────────────────
    // Cold start: commitTo is non-null with an empty filtered array — persists the
    // baseline so the next tick fetches only genuinely new messages (D-71).
    if (!skipCommit && commitTo !== null) {
      writeStateCursor(config.statePath, commitTo);
    }
  } finally {
    // Always reset the in-process guard — even on the ask-error return path
    tickInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Proactive push helpers
// ---------------------------------------------------------------------------

/**
 * Check if a given local hour falls within quiet hours.
 *
 * Handles midnight-crossing ranges (start > end, e.g. 22→7):
 *   start === end → false (no quiet hours configured)
 *   start < end  → standard range: h >= start && h < end
 *   start > end  → midnight-crossing: h >= start || h < end
 *
 * Exported for direct testing of boundary conditions.
 */
export function isInQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end;
  // midnight-crossing (e.g. start=22, end=7): quiet from 22:00 to 06:59
  return hour >= start || hour < end;
}

/**
 * Build a Telegram inline keyboard with three buttons for a surfaced item.
 *
 * One row: "✅ Done" | "🗑 Dismiss" | "💤 Snooze"
 * callback_data uses the compact encoding from push-codec.ts (≤ 51 bytes, well within 64).
 * due_at normalized through new Date(item.due_at).toISOString() (A1 mitigation).
 */
function buildButtonMarkup(item: SurfaceItem): InlineKeyboardMarkup {
  const dueIso = new Date(item.due_at).toISOString();
  return {
    inline_keyboard: [[
      { text: '✅ Done',    callback_data: encodeCallbackData(item.node_id, dueIso, 'c') },
      { text: '🗑 Dismiss', callback_data: encodeCallbackData(item.node_id, dueIso, 'd') },
      { text: '💤 Snooze', callback_data: encodeCallbackData(item.node_id, dueIso, 's') },
    ]],
  };
}

/**
 * Render a surfaced item as a plain-text push message.
 * Data only — never interpolated as Telegram markup.
 */
function renderText(item: SurfaceItem): string {
  return `[${item.action_type}] ${item.value}\nDue: ${item.due_at}`;
}

/**
 * Send a surfaced item to a Telegram chat and mark it as surfaced (D-02 send-then-mark).
 *
 * Order:
 *   1. sendMessage() — at-least-once: a crash after send = rare duplicate, not silent drop.
 *   2. surfaceSeen({ outcome: 'surfaced' }) — marks the item so it is excluded from future
 *      surface() responses (server-side dedup via surfaced_event, D-03).
 *
 * T-22-03: text is plain data, never markup. Token never logged.
 */
async function sendSurfacedItem(
  transport: TelegramTransport,
  memoryClient: MemoryClient,
  _config: ClientConfig,
  chatId: number,
  item: SurfaceItem,
): Promise<void> {
  // 1. Send first (at-least-once — D-02)
  await transport.sendMessage(chatId, renderText(item), buildButtonMarkup(item));
  // 2. Mark after send
  await memoryClient.surfaceSeen({
    node_id: item.node_id,
    occurrence_due_at: new Date(item.due_at).toISOString(),
    outcome: 'surfaced',
  });
}

/**
 * Proactive push tick: poll GET /v1/surface and push due items to Telegram.
 *
 * Never calls getUpdates (D-01 — the push timer is a SEPARATE timer from runClientTick).
 * Never throws (C-1) — errors are caught and logged; the setInterval callback is safe.
 *
 * P0 (tier=0): pushed immediately, bypassing quiet hours (D-05 — urgent deadline).
 * P1 (tier=1): held until the configured digestHour, outside quiet hours (D-06/D-07).
 *   If digestHour has zero P1 items, sends nothing (never-empty-digest, D-06).
 *
 * Dedup is server-side (surfaced_event). No in-memory surfaced-set — a restarted client
 * polls GET /v1/surface and gets exactly the items not yet marked (D-03).
 *
 * Gate: if RECENSE_PROACTIVE_ENABLED is not "true" (D-11), this function returns
 * immediately without doing anything. Reactive Q&A is unaffected.
 */
export async function runPushTick(
  config: ClientConfig,
  transport: TelegramTransport,
  memoryClient: MemoryClient,
): Promise<void> {
  // D-11: default-OFF gate. Belt-and-suspenders on top of the main() guard.
  if (!config.proactiveEnabled) return;

  if (pushInFlight) {
    log('push tick already in flight — skipping');
    return;
  }
  pushInFlight = true;

  try {
    const items = await memoryClient.surface();
    const localHour = new Date().getHours();
    const inQuiet = isInQuietHours(localHour, config.quietHoursStart, config.quietHoursEnd);
    const isDigest = localHour === config.digestHour;

    const p0 = items.filter(i => i.tier === 0);
    const p1 = items.filter(i => i.tier === 1);

    // D-05: P0 always sends — bypasses quiet hours (urgent deadline)
    for (const item of p0) {
      for (const chatIdStr of config.allowlist) {
        await sendSurfacedItem(transport, memoryClient, config, Number(chatIdStr), item);
      }
    }

    // D-06/D-07: P1 only at digest hour, outside quiet hours, and only if ≥1 item
    if (isDigest && !inQuiet && p1.length > 0) {
      for (const item of p1) {
        for (const chatIdStr of config.allowlist) {
          await sendSurfacedItem(transport, memoryClient, config, Number(chatIdStr), item);
        }
      }
    }
  } catch (err) {
    // C-1 never-throws — setInterval callback must not reject
    log('push tick error: ' + String(err));
  } finally {
    pushInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Main entry point for the Telegram reference client.
 *
 * Fail-closed (D-10): if config.enabled is false (token missing or allowlist empty),
 * logs the reason and returns WITHOUT starting the poll interval.
 * Process-not-running is NOT the gate — runtime flag is.
 *
 * When enabled: starts the reactive poll loop at config.pollIntervalMs (floor already
 * applied in loadClientConfig), logs startup, and holds the event loop indefinitely via
 * the live setInterval handle (launchd KeepAlive service lifecycle).
 *
 * When proactiveEnabled: additionally starts a SEPARATE push timer at config.pushPollMs
 * (D-01 split-timer design — push timer NEVER calls getUpdates). Guarded by the
 * default-OFF RECENSE_PROACTIVE_ENABLED flag (D-11).
 */
export async function main(): Promise<void> {
  const config = loadClientConfig();

  if (!config.enabled) {
    const reason =
      config.telegramToken === ''
        ? 'TELEGRAM_BOT_TOKEN missing'
        : config.serveToken === ''
          ? 'RECENSE_SERVE_TOKEN missing'
          : 'RECENSE_CLIENT_ALLOWLIST is empty';
    log('client disabled — ' + reason + ' (fail-closed, D-10); idling without polling');
    return;
  }

  const transport = new DefaultTelegramTransport(config.telegramToken);
  const memoryClient = createMemoryClient(config.serveUrl, config.serveToken);

  // Catch-all for stray rejections from setInterval callbacks (belt-and-suspenders)
  process.on('unhandledRejection', (err) => {
    appendFileSync(
      LOG_PATH,
      `[${new Date().toISOString()}] telegram-client FATAL unhandledRejection: ${String(err)}\n`,
    );
  });

  // Reactive Q&A loop — sole getUpdates consumer (D-01)
  setInterval(() => {
    runClientTick(config, transport, memoryClient).catch(err =>
      log('runClientTick rejected: ' + String(err)),
    );
  }, config.pollIntervalMs);

  log('telegram client started (pollIntervalMs=' + String(config.pollIntervalMs) + 'ms)');

  // D-01: SEPARATE push timer — never calls getUpdates; guarded by D-11 off-switch
  if (config.proactiveEnabled) {
    setInterval(() => {
      runPushTick(config, transport, memoryClient).catch(err =>
        log('runPushTick rejected: ' + String(err)),
      );
    }, config.pushPollMs);
    log('push timer started (pushPollMs=' + String(config.pushPollMs) + 'ms)');
  }

  // Hold the event loop indefinitely — the setInterval handle is the keep-alive.
  return new Promise<never>(() => {});
}

// ---------------------------------------------------------------------------
// Entry guard — run only when invoked as the main module, not when imported
// by tests. Allows `require('./index')` without launching the poll loop.
// ---------------------------------------------------------------------------

if (require.main === module) {
  main().catch(err => {
    appendFileSync(
      LOG_PATH,
      `[${new Date().toISOString()}] telegram-client FATAL: ${String(err)}\n`,
    );
    process.exit(1);
  });
}
