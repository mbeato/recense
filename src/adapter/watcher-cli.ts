/**
 * watcher-cli — long-running channel watcher (D-71, KeepAlive).
 *
 * Generic entry point for any configured query channel (Telegram primary, iMessage optional).
 * Loaded by launchd KeepAlive (never spawned per-turn).
 *
 * Design invariants:
 *  - Validate args BEFORE lock (WR-02: lock leak prevention).
 *  - All logging goes to LOG_PATH (file only); never stdout except JSON/empty.
 *  - Acquires the O_EXCL lock before the inferred-episode append (D-75).
 *  - Releases lock before any process.exit — see WR-02.
 *  - Allowlist read from config; default empty = fail-closed (D-74).
 *  - Inbound questions NEVER written as observed/asserted (D-75 self-confirmation guard).
 *
 * Threat mitigations:
 *  - WR-02: acquireLock() AFTER arg validation; releaseLock() in finally.
 *  - T-04-03-I: question text treated as data only; never shell-interpolated.
 *  - T-04-03-K: DefaultModelProvider reads API keys from env via SDK defaults.
 *  - T-07-06: inbound question text is never written as observed/asserted_by_user (D-75).
 *  - T-07-07: pollIntervalMs floored at 500ms; lock skipped (not blocked) on contention;
 *    unconfigured watcher idles without polling, no KeepAlive restart thrash.
 */
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { EpisodicStore } from '../db/episode-store';
import { SemanticStore } from '../db/semantic-store';
import { StrengthDecayManager } from '../strength/decay';
import { CandidateRetriever } from '../retrieval/topk';
import { AllocationGate } from '../gate/allocation-gate';
import { DefaultModelProvider } from '../model/provider';
import { RetrievalEngine } from '../retrieval/engine';
import { RecallEngine } from '../recall';
import { HybridResponder } from '../responder';
import type { Channel } from '../channel/channel';
import type { ResponderResult } from '../responder';
import { DefaultIMessageChannel, DefaultOsascriptSender } from '../channel/imessage-channel';
import { DefaultChatDbReader } from '../channel/chat-db-reader';
import { TelegramChannel, DefaultTelegramTransport } from '../channel/telegram-channel';
import { acquireLock, releaseLock } from './lockfile';
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
 * Returns undefined if neither is supplied.
 */
export function resolveDbPath(): string | undefined {
  const dbArgIdx = process.argv.indexOf('--db');
  if (dbArgIdx !== -1 && process.argv[dbArgIdx + 1]) {
    return process.argv[dbArgIdx + 1];
  }
  return process.env['BRAIN_MEMORY_DB'];
}

/**
 * Pure per-tick body: receive → respond → send (no lock, no DB concerns).
 * Exported for unit testing.
 *
 * T-07-04: on respond() returning null, stay silent (safe-null discipline — never
 *   send a raw error to the channel).
 * T-07-06: inbound question text is never appended as observed/asserted (D-75).
 * Errors from receive() or respond() are caught and logged — never rethrown.
 */
export async function runTick(
  channel: Channel,
  responder: { respond(question: string, sessionId: string): Promise<ResponderResult> },
  sessionId: string,
  logFn: (msg: string) => void,
): Promise<void> {
  try {
    const msgs = await channel.receive();
    for (const m of msgs) {
      try {
        const res = await responder.respond(m.text, sessionId);
        if (res.reply !== null) {
          await channel.send(m.sender, res.reply);
        }
        // res.reply === null: safe-null discipline — stay silent (T-07-04)
      } catch (err) {
        logFn('respond error: ' + err);
      }
    }
  } catch (err) {
    logFn('tick error: ' + err);
  }
}

/**
 * Lock-guarded tick: acquires the shared single-writer lock (same file as sleep pass,
 * D-75/D-43), runs runTick, releases the lock in finally.
 *
 * The lock is acquired BEFORE receive() — the channel's cursor advance inside receive()
 * is a brain.db meta write, so acquiring first and skipping the entire tick on contention
 * guarantees no message is consumed-then-dropped. This per-tick scope mirrors recall-cli
 * (lock across the whole recall) and is released in finally before the next tick — it is
 * NEVER held across the long-running poll loop.
 *
 * Exported so tests can verify the lock-skip branch.
 */
export async function runLockedTick(
  channel: Channel,
  responder: { respond(question: string, sessionId: string): Promise<ResponderResult> },
  sessionId: string,
  logFn: (msg: string) => void,
): Promise<void> {
  if (!acquireLock()) {
    logFn('lock held — skipping tick');
    return;
  }
  try {
    await runTick(channel, responder, sessionId, logFn);
  } finally {
    releaseLock();
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
  // before the first acquireLock() — so this exit is always lock-free.
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
    // Enter an idle that never resolves and never polls — event loop stays alive
    // so launchd KeepAlive does not restart the process on a clean exit.
    const timer = setInterval(() => { /* noop heartbeat — keeps event loop alive */ }, 60_000);
    timer.unref();
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

  // T-04-03-K / T-07-KEY: keys read from process.env by SDK inside DefaultModelProvider.
  const provider = new DefaultModelProvider({
    generateConfig: config,
    judgeConfig: config,
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
  // Per-tick lock: acquires the shared single-writer lock (same brain-memory-sleep.lock
  // as the sleep pass, D-75) around the whole receive()→respond()→send() cycle.
  // Acquiring FIRST means the channel cursor advance (inside receive()) is also under
  // the lock — if contended, skip the entire tick (no message consumed then dropped).
  // Floor at 500ms to prevent excessive syscalls (T-07-07).
  const intervalMs = Math.max(
    telegramReady ? config.telegram.pollIntervalMs : config.channel.pollIntervalMs,
    500
  );
  setInterval(() => {
    // WR-04: cheap indexed meta read — pick up `brain viz` toggles without restart.
    traceSink.refresh();
    void runLockedTick(channel, responder, 'watcher-session', log);
  }, intervalMs);

  log('watcher started (pollIntervalMs=' + String(intervalMs) + 'ms)');

  // The setInterval keeps the event loop alive — main() never resolves from here.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  return new Promise<never>(() => {});
}

// Only run when invoked as the entry point (launchd KeepAlive), NOT when
// imported by a unit test of the exported helpers above.
if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] watcher FATAL: ${err}\n`);
    releaseLock(); // best-effort cleanup
    process.exit(1);
  });
}
