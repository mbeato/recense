/**
 * watcher-cli — long-running channel watcher (D-71, KeepAlive).
 *
 * Generic entry point for any configured query channel (Telegram primary, iMessage optional).
 * Loaded by launchd KeepAlive (never spawned per-turn).
 *
 * Design invariants:
 *  - Validate args BEFORE lock (WR-02: lock leak prevention).
 *  - All logging goes to LOG_PATH (file only); never stdout except JSON/empty.
 *  - channel.fetch() runs UNLOCKED — network/db read, no cursor write (LOCK-CHANNEL-SPLIT).
 *  - The single-writer lock is acquired only when there is work (non-null commitTo or
 *    non-empty messages). Idle ticks never contend with `brain recall` (T-LOCK-02).
 *  - commitCursor() is called UNDER the lock, AFTER processing — cursor advances only after
 *    successful (or allowlist-skipped) handling of all messages in the batch (D-75/inv #2).
 *  - Lock-deferred ticks (lock held after retries) return WITHOUT advancing the cursor —
 *    next tick re-fetches the same messages (no-loss invariant #2 preserved).
 *  - tickInFlight guard serializes overlapping setInterval ticks (in-process, T-LOCK-02).
 *  - Releases lock before any process.exit — see WR-02.
 *  - Allowlist read from config; default empty = fail-closed (D-74).
 *  - Inbound questions NEVER written as observed/asserted (D-75 self-confirmation guard).
 *
 * Threat mitigations:
 *  - WR-02: arg validation BEFORE first acquireLockWithRetry(); releaseLock() in finally.
 *  - T-04-03-I: question text treated as data only; never shell-interpolated.
 *  - T-04-03-K: DefaultModelProvider reads API keys from env via SDK defaults.
 *  - T-07-06: inbound question text is never written as observed/asserted_by_user (D-75).
 *  - T-07-07: pollIntervalMs floored at 500ms; lock skipped (not blocked) on contention;
 *    unconfigured watcher idles without polling, no KeepAlive restart thrash.
 *  - T-LOCK-01: commitCursor is the only cursor writer, called under the lock after processing.
 *  - T-LOCK-02: tickInFlight prevents overlapping ticks; busy_timeout=5000 waits on SQLITE_BUSY.
 *  - T-LOCK-03: lock-deferred ticks re-fetch (no-loss); at-least-once (duplicate reply on crash
 *    between send and commit — accepted, documented in LOCK-REFACTOR-DESIGN.md invariant #2).
 */
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';
import { resolveProviderOverlay } from '../consolidation/run-sleep-pass';
import { EpisodicStore } from '../db/episode-store';
import { SemanticStore } from '../db/semantic-store';
import { StrengthDecayManager } from '../strength/decay';
import { CandidateRetriever } from '../retrieval/topk';
import { AllocationGate } from '../gate/allocation-gate';
import { DefaultModelProvider } from '../model/provider';
import { RetrievalEngine } from '../retrieval/engine';
import { RecallEngine } from '../recall';
import { HybridResponder } from '../responder';
import type { Channel, InboundMessage } from '../channel/channel';
import type { ResponderResult } from '../responder';
import { DefaultIMessageChannel, DefaultOsascriptSender } from '../channel/imessage-channel';
import { DefaultChatDbReader } from '../channel/chat-db-reader';
import { TelegramChannel, DefaultTelegramTransport } from '../channel/telegram-channel';
import { acquireLockWithRetry, releaseLock, heartbeatLock } from './lockfile';
import { SwitchableActivationTraceSink } from '../viz/activation-sink';

const LOG_PATH = '/tmp/brain-memory-watcher.log';

/** Append a timestamped line to the log file (never stdout). */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] watcher: ${msg}\n`);

/**
 * Platform guard for INSTALL-05 / T-09-12.
 *
 * Returns a clear macOS-only message if `platform` is not 'darwin' — callers
 * should log the message and `process.exit(0)` BEFORE acquiring any lock or
 * opening any channel (no silent failure, no lock leak).
 * Returns undefined on darwin (normal execution path).
 *
 * Pure function (platform passed in) so tests can verify without mocking
 * the read-only `process.platform` property.
 */
export function getNonDarwinEarlyExitMessage(platform: string): string | undefined {
  if (platform !== 'darwin') {
    return (
      'iMessage/Telegram watcher is macOS-only; ' +
      'the engine and Claude Code hooks run on Linux without it'
    );
  }
  return undefined;
}

/**
 * Resolve dbPath from --db <path> argv or BRAIN_MEMORY_DB env var.
 * Returns undefined if neither is supplied (fallbackToDefault=false).
 *
 * M-8: delegates to the shared resolveDbPath from runtime-config.
 * Exported for backward-compat with tests/watcher-cli.test.ts.
 */
export function resolveDbPath(): string | undefined {
  return resolveSharedDbPath(process.argv, { fallbackToDefault: false });
}

// ---------------------------------------------------------------------------
// In-process tick serialization guard (T-LOCK-02)
// ---------------------------------------------------------------------------

/**
 * Set to true while a runLockedTick call is in flight; prevents a second setInterval
 * tick from overlapping with the first. Cleared in the outermost finally of runLockedTick
 * so it resets even on the lock-deferred (early-return) path.
 *
 * This is the in-process complement to the O_EXCL lockfile: fetch() moving off the lock
 * removes the implicit serialization the lock previously provided, so we need this guard.
 */
let tickInFlight = false;

/**
 * Pure per-tick respond loop: iterates the pre-fetched message list and responds.
 * Does NOT call channel.fetch() or channel.commitCursor() — those are owned by the caller
 * (runLockedTick) for precise lock control.
 * Exported for unit testing.
 *
 * T-07-04: on respond() returning null, stay silent (safe-null discipline — never
 *   send a raw error to the channel).
 * T-07-06: inbound question text is never appended as observed/asserted (D-75).
 * Errors from respond() are caught and logged — never rethrown.
 */
export async function runTick(
  channel: Channel,
  messages: InboundMessage[],
  responder: { respond(question: string, sessionId: string): Promise<ResponderResult> },
  sessionId: string,
  logFn: (msg: string) => void,
): Promise<void> {
  try {
    for (const m of messages) {
      try {
        const res = await responder.respond(m.text, sessionId);
        if (res.reply !== null) {
          await channel.send(m.sender, res.reply);
        }
        // res.reply === null: safe-null discipline — stay silent (T-07-04)
      } catch (err) {
        logFn('respond error: ' + err);
      }
      // L-11: refresh the lock mtime once per message so a long multi-message batch
      // (100 msgs × multi-second LLM responds) is never falsely reclaimed mid-batch.
      heartbeatLock();
    }
  } catch (err) {
    logFn('tick error: ' + err);
  }
}

/**
 * Fetch-before-lock tick: fetches messages UNLOCKED, then acquires the lock only when
 * there is work to do, processes the messages, and commits the cursor under the lock.
 *
 * Flow (LOCK-WATCHER-REWORK, post-L-11/C-1 reorder):
 *  1. tickInFlight guard — if already in-flight, log + return WITHOUT fetching (L-11: saves
 *     the network read during an ongoing long respond).
 *  2. channel.fetch() — UNLOCKED network/db read, no write. Wrapped in its own try/catch so
 *     a thrown error (should not happen — impl contract — but belt-and-suspenders C-1) logs
 *     and returns cleanly.
 *  3. commitTo === null && messages.length === 0 → return (idle tick, lock never touched).
 *  4. acquireLockWithRetry() — if lock held after retries, log + return WITHOUT committing
 *     cursor (re-fetch on next tick → no message loss, invariant #2 preserved).
 *  5. Under the lock:
 *     a. Re-read live cursor via currentCursor() and drop messages with id <= cursor (stale).
 *     b. If commitTo <= cursor (monotonic), skip the commitCursor call.
 *     c. runTick() — respond loop over filtered messages.
 *     d. channel.commitCursor(commitTo) if not skipping.
 *  6. releaseLock() in finally (always, even on error).
 *
 * Exported so tests can verify the lock-skip and tickInFlight-skip branches.
 */
export async function runLockedTick(
  channel: Channel,
  responder: { respond(question: string, sessionId: string): Promise<ResponderResult> },
  sessionId: string,
  logFn: (msg: string) => void,
): Promise<void> {
  // ── 1. In-process tick guard FIRST (L-11 + T-LOCK-02) ────────────────────────
  // Moved ahead of fetch(): a long in-flight respond (LLM call, multi-message batch)
  // now stops the NEXT tick BEFORE it does a redundant network fetch. Previously the
  // guard came after fetch(), wasting a getUpdates call on every skipped tick.
  if (tickInFlight) {
    logFn('tick already in flight — skipping re-entry');
    return;
  }
  tickInFlight = true;

  try {
    // ── 2. Fetch UNLOCKED — network/db read, no cursor write (LOCK-CHANNEL-SPLIT) ─
    // Belt-and-suspenders catch (C-1): impls should never throw (they wrap errors
    // internally), but if one does, we log and return cleanly rather than propagating
    // an unhandled rejection from the setInterval callback.
    let messages: InboundMessage[];
    let commitTo: string | null;
    try {
      ({ messages, commitTo } = await channel.fetch());
    } catch (err) {
      logFn('fetch error: ' + String(err));
      return; // tickInFlight reset in outer finally
    }

    // ── 3. Idle check — nothing to do, never touch the lock ──────────────────────
    if (commitTo === null && messages.length === 0) {
      return;
    }

    // ── 4. Acquire the single-writer lock ──────────────────────────────────────
    // If the lock stays held (sleep-pass or another long holder), defer this tick:
    // the cursor is NOT advanced so the next tick re-fetches the same messages (inv #2).
    if (!(await acquireLockWithRetry())) {
      logFn('lock held after retries — tick deferred, cursor NOT advanced');
      return; // tickInFlight reset in outer finally
    }

    try {
      // ── 5a. Re-read live cursor to drop stale messages ──────────────────────
      // A previous tick may have committed the cursor between our unlocked fetch()
      // and now. Drop any message whose id <= the current committed cursor.
      const cursor = channel.currentCursor();
      const filtered = cursor !== null
        ? messages.filter(m => Number(m.id) > Number(cursor))
        : messages;

      // ── 5b. Monotonic commit check ──────────────────────────────────────────
      // If commitTo <= cursor, the cursor already covers this batch — skip the commit
      // call. Still run the respond loop (filtered messages will be empty if all stale).
      const skipCommit =
        commitTo !== null && cursor !== null && Number(commitTo) <= Number(cursor);

      // ── 5c. Respond loop (pure: send only, no cursor write) ─────────────────
      await runTick(channel, filtered, responder, sessionId, logFn);

      // ── 5d. Commit cursor AFTER processing, under the lock ──────────────────
      // Cold start: commitTo is non-null with an empty messages array — persists the
      // baseline so the next tick fetches only genuinely new messages (D-71).
      if (!skipCommit && commitTo !== null) {
        channel.commitCursor(commitTo);
      }
    } finally {
      releaseLock();
    }
  } finally {
    // Always reset the in-process guard — even on the lock-deferred return path
    tickInFlight = false;
  }
}

export async function main(): Promise<void> {
  // ── 0. Platform gate (INSTALL-05 / T-09-12) ─────────────────────────────────
  // Must run BEFORE any lock acquisition or channel open — a non-darwin process
  // that opens iMessage DB or Telegram has EoP risk. Exits 0 with a clear message;
  // the engine and Claude Code hooks are unaffected on non-darwin platforms.
  const earlyExitMsg = getNonDarwinEarlyExitMessage(process.platform);
  if (earlyExitMsg) {
    log(earlyExitMsg);
    process.exit(0);
  }

  // ── 1. Validate args BEFORE acquiring lock (WR-02: lock leak prevention) ──────
  // process.exit() inside a try/finally does NOT unwind the stack, so exiting while
  // the lock is held leaks it for up to LOCK_STALE_MS (5 min). Validate here —
  // before the first acquireLockWithRetry() — so this exit is always lock-free.
  const dbPath = resolveDbPath();
  if (!dbPath) {
    log('No DB path supplied (--db <path> or BRAIN_MEMORY_DB env var) — exiting');
    process.exit(0);
  }

  // ── 2. Open brain.db and initialize schema ──────────────────────────────────
  const db = new Database(dbPath);
  initSchema(db);
  const config = { ...DEFAULT_CONFIG, dbPath };

  // ── 3. Channel selection + configured-check ─────────────────────────────────
  // Telegram is the primary surface (a bot has its own identity → no self-echo loop).
  // iMessage is an optional fallback. A channel must be fully configured to be "ready";
  // if none is, idle without polling (WR-02: no lock acquired when unconfigured — no
  // KeepAlive restart thrash).
  const telegramToken = process.env['BRAIN_MEMORY_TELEGRAM_TOKEN'];
  const telegramReady =
    config.telegram.enable && config.telegram.allowlist.length > 0 && !!telegramToken;
  const imessageReady =
    config.channel.enable && config.channel.allowlist.length > 0 && !!config.channel.chatDbPath;
  if (config.telegram.enable && !telegramToken) {
    log('telegram.enable set but BRAIN_MEMORY_TELEGRAM_TOKEN is missing — Telegram disabled');
  }
  if (!telegramReady && !imessageReady) {
    log('no channel configured; idling');
    // H-3: the setInterval is intentionally NOT unref'd — it IS the keep-alive handle.
    // With unref(), Node exits immediately (pending Promise alone does not hold the event
    // loop) → launchd KeepAlive restarts the process on every throttle interval (thrash).
    // A non-unref'd 60s interval keeps the process alive without polling.
    setInterval(() => { /* noop heartbeat — intentionally ref'd to hold the event loop */ }, 60_000);
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await new Promise<never>(() => {});
    return; // unreachable — satisfies TypeScript return-type check
  }

  // ── 4. Wire the full collaborator graph (same as recall-cli.ts) ─────────────
  const episodes = new EpisodicStore(db, realClock, config);
  const store    = new SemanticStore(db, realClock, config);
  const strength = new StrengthDecayManager(db, realClock, config);
  const retriever = new CandidateRetriever(db);
  const gate     = new AllocationGate(config);

  // M-7: apply provider overlay so BRAIN_MEMORY_MODEL_PROVIDER / BRAIN_MEMORY_EXTRACTOR_PROVIDER
  // / BRAIN_MEMORY_JUDGE_PROVIDER env vars route generate+judge to the configured provider
  // (e.g. a local model). embed stays base config (OpenAI regardless of overlay).
  // Log resolved provider NAMES only (never keys — T-04-03-K / T-07-KEY).
  const generateConfig = { ...config, ...resolveProviderOverlay(process.env, 'BRAIN_MEMORY_EXTRACTOR_PROVIDER') };
  const judgeConfig    = { ...config, ...resolveProviderOverlay(process.env, 'BRAIN_MEMORY_JUDGE_PROVIDER') };
  log('providers — generate: ' + generateConfig.modelProvider + ' | judge: ' + judgeConfig.modelProvider);
  const provider = new DefaultModelProvider({
    generateConfig,
    judgeConfig,
    embedConfig: config,
  });

  // VIZ-01 / WR-04: inject a switchable trace sink driven by viz_trace_enabled
  // (set by `brain viz`, Plan 03). Default OFF (Noop) until the flag reads '1'.
  // Because this watcher is a long-running launchd KeepAlive process, the sink
  // re-checks the flag once per poll tick (see refresh() in the loop below) and
  // flips between SQLite and Noop on transition — so enabling `brain viz` AFTER
  // the watcher is already running makes Telegram-driven retrieval/recall appear
  // in the live visualization WITHOUT a restart.
  const traceSink = new SwitchableActivationTraceSink(db, realClock);

  const retrieval = new RetrievalEngine(db, realClock, config, retriever, store, strength, gate, traceSink);
  const recall    = new RecallEngine(db, realClock, config, provider, retriever, store, strength, episodes, traceSink);
  const responder = new HybridResponder(realClock, config, provider, retrieval, recall, episodes);

  // ── 5. Construct the active channel (Telegram preferred) ─────────────────────
  // SemanticStore implements MetaStore (getMeta/setMeta for cursor:telegram / cursor:imessage).
  let channel: Channel;
  if (telegramReady) {
    channel = new TelegramChannel(config, new DefaultTelegramTransport(telegramToken!), store, log);
    log('using Telegram channel');
  } else {
    channel = new DefaultIMessageChannel(
      config,
      new DefaultChatDbReader(config.channel.chatDbPath),
      new DefaultOsascriptSender(),
      store,
      log,
    );
    log('using iMessage channel');
  }

  // ── 6. Poll loop ─────────────────────────────────────────────────────────────
  // Per-tick: channel.fetch() runs UNLOCKED (network/db read only — no cursor write).
  // The single-writer lock is acquired only when there is work to do (non-null commitTo
  // or non-empty messages), keeping idle ticks from contending with `brain recall`.
  // Cursor is committed via channel.commitCursor() UNDER the lock, AFTER processing —
  // lock-deferred ticks re-fetch the same messages on the next tick (no-loss, D-75).
  // tickInFlight guard prevents overlapping setInterval ticks (in-process serialization).
  // Floor at 500ms to prevent excessive syscalls (T-07-07).
  const intervalMs = Math.max(
    telegramReady ? config.telegram.pollIntervalMs : config.channel.pollIntervalMs,
    500
  );
  setInterval(() => {
    // WR-04: cheap indexed meta read — pick up `brain viz` toggles without restart.
    traceSink.refresh();
    // C-1: explicit .catch so a stray rejection from runLockedTick logs FATAL rather than
    // propagating as an unhandledRejection (which would kill the process on Node ≥15).
    runLockedTick(channel, responder, 'watcher-session', log).catch(err =>
      log('runLockedTick rejected: ' + String(err))
    );
  }, intervalMs);

  log('watcher started (pollIntervalMs=' + String(intervalMs) + 'ms)');

  // The setInterval keeps the event loop alive — main() never resolves from here.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  return new Promise<never>(() => {});
}

// C-1: catch-all for any stray rejection that escapes the per-tick .catch above.
// Logs FATAL to the watcher log (not silently killed) so diagnostics remain visible.
process.on('unhandledRejection', (err) => {
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] watcher FATAL unhandledRejection: ${String(err)}\n`);
});

// Only run when invoked as the entry point (launchd KeepAlive), NOT when
// imported by a unit test of the exported helpers above.
if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] watcher FATAL: ${err}\n`);
    releaseLock(); // best-effort cleanup
    process.exit(1);
  });
}
