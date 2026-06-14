import { appendFileSync } from 'fs';
import { type ClientConfig, loadClientConfig } from './config';
import { readStateCursor, writeStateCursor } from './state';
import { DefaultTelegramTransport, type TelegramTransport } from './transport';
import { type FetchResult, type InboundMessage } from './types';
import { createMemoryClient, type MemoryClient } from './memory-client';

// ---------------------------------------------------------------------------
// Log helper — append-only file log; never stdout (background process, T-13-05)
// Bearer token and bot token MUST NOT appear in log messages.
// ---------------------------------------------------------------------------

const LOG_PATH = '/tmp/recense-telegram-client.log';

/** Append a timestamped line to the log file. */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] telegram-client: ${msg}\n`);

// ---------------------------------------------------------------------------
// In-process tick serialization guard (equivalent to T-LOCK-02 in watcher-cli)
//
// Set true BEFORE the first await inside runClientTick; cleared in the outermost
// finally so it resets even on the early-return (ask error / idle) paths.
// Prevents a second setInterval tick from overlapping with an in-flight respond.
// ---------------------------------------------------------------------------

let tickInFlight = false;

// ---------------------------------------------------------------------------
// Inlined Telegram fetch logic
// Ported from src/channel/telegram-channel.ts TelegramChannel.fetch().
// Cursor source is the client-local state file (readStateCursor), not MetaStore.
// ---------------------------------------------------------------------------

/**
 * Poll Telegram for new allowlisted messages. Performs NO state write (T-LOCK-01).
 *
 * Fail-closed: empty allowlist → {messages:[], commitTo:null} — idle, no ask call made.
 * Private chats only: the allowlist authorizes the SENDER, but replies go to the CHAT —
 *   a group update from an allowlisted sender would broadcast memory content to unlisted
 *   members, so non-private chats are skipped (still confirmed via commitTo).
 * Cold start (no cursor): paginates to exhaustion (L-9), returns baseline commitTo with
 *   empty messages so the caller can commit the baseline and skip the backlog.
 * Normal: fetches updates after cursor; zero new → idle; otherwise returns allowlisted
 *   InboundMessages and max scanned update_id as commitTo.
 * Never throws (C-1): transport errors are caught, logged, and returned as idle.
 */
export async function fetchMessages(
  transport: TelegramTransport,
  config: Pick<ClientConfig, 'allowlist' | 'statePath'>,
): Promise<FetchResult> {
  try {
    // Fail-closed — empty allowlist answers no one; commitTo=null signals idle (D-10)
    if (config.allowlist.length === 0) {
      return { messages: [], commitTo: null };
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
      return { messages: [], commitTo: String(maxId) };
    }

    const cursor = parseInt(cursorRaw, 10);
    // offset = cursor + 1 → fetch updates with update_id > cursor (Telegram confirms <= cursor)
    const updates = await transport.getUpdates(cursor + 1);
    if (updates.length === 0) {
      // No new updates — commitTo:null signals idle (caller skips cursor write)
      return { messages: [], commitTo: null };
    }

    // commitTo covers ALL scanned updates (listed or not) — unlisted ones are confirmed
    // so they are not re-fetched on the next tick.
    const maxId = updates.reduce((max, u) => Math.max(max, u.update_id), cursor);
    const allow = new Set(config.allowlist.map(s => s.trim()));

    const messages: InboundMessage[] = [];
    for (const u of updates) {
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

    return { messages, commitTo: String(maxId) };
  } catch (err) {
    // C-1: "never throws" — transport errors must not crash the poll loop.
    // Log to file, return idle so the cursor is never advanced on fetch error.
    log('telegram fetch error: ' + String(err));
    return { messages: [], commitTo: null };
  }
}

// ---------------------------------------------------------------------------
// Full tick: fetch + stale-filter + respond + cursor commit
// Ported from src/adapter/watcher-cli.ts runLockedTick (engine lock removed).
// ---------------------------------------------------------------------------

/**
 * Fetch-then-respond tick, lock-free (cursor is client-local state file).
 *
 * Flow:
 *  1. tickInFlight guard — if already in-flight, log + return without fetching.
 *  2. fetchMessages() — write-free; errors return idle (C-1 never-throws).
 *  3. Idle check — commitTo === null && messages empty → return.
 *  4. Re-read live cursor via readStateCursor; drop messages with id <= cursor (stale).
 *  5. Monotonic commit check — if commitTo <= cursor, skip cursor write.
 *  6. Respond loop — ask() each message; safe-null: only send when answer !== null
 *     && origin !== 'none'. Inferred answers carry a visible '(inferred) ' prefix
 *     unless the server-composed answer already ends with the marker.
 *  7. D-04 no-loss: if ask() throws (serve unreachable / non-2xx), log + RETURN
 *     WITHOUT committing cursor → message retried next tick, no message loss.
 *  8. Commit cursor via writeStateCursor when not skipCommit.
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
    let commitTo: string | null;
    try {
      ({ messages, commitTo } = await fetchMessages(transport, config));
    } catch (err) {
      log('fetch error: ' + String(err));
      return;
    }

    // ── 3. Idle check ───────────────────────────────────────────────────────
    if (commitTo === null && messages.length === 0) {
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

    // ── 8. Commit cursor AFTER successful processing ─────────────────────────
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
// Entry point
// ---------------------------------------------------------------------------

/**
 * Main entry point for the Telegram reference client.
 *
 * Fail-closed (D-10): if config.enabled is false (token missing or allowlist empty),
 * logs the reason and returns WITHOUT starting the poll interval.
 * Process-not-running is NOT the gate — runtime flag is.
 *
 * When enabled: starts the poll loop at config.pollIntervalMs (floor already applied
 * in loadClientConfig), logs startup, and holds the event loop indefinitely via the
 * live setInterval handle (launchd KeepAlive service lifecycle).
 */
export async function main(): Promise<void> {
  const config = loadClientConfig();

  if (!config.enabled) {
    const reason =
      config.telegramToken === ''
        ? 'TELEGRAM_BOT_TOKEN missing'
        : config.serveToken === ''
          ? 'BRAIN_SERVE_TOKEN missing'
          : 'BRAIN_CLIENT_ALLOWLIST is empty';
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

  setInterval(() => {
    runClientTick(config, transport, memoryClient).catch(err =>
      log('runClientTick rejected: ' + String(err)),
    );
  }, config.pollIntervalMs);

  log('telegram client started (pollIntervalMs=' + String(config.pollIntervalMs) + 'ms)');

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
