/**
 * recall-cli — on-demand latency-tolerant recall adapter (LEARN-02, D-40).
 *
 * Entry point: invoked explicitly with --query <text> [--db <path>]
 * (not spawned from the hot SessionStart hook path — that stays cue-less, LLM-free).
 *
 * Design invariants:
 *  - Acquires the O_EXCL lockfile before any DB open → single-writer preserved (D-43 append).
 *  - All logging goes to LOG_PATH (file only); stdout receives ONLY JSON (never raw errors).
 *  - Never writes to stdout/stderr except the JSON result — callers parse stdout directly.
 *  - query string is treated as data (embedded + placed in prompt as content); never
 *    shell-interpolated, never eval'd; length-bounded inside RecallEngine (T-04-03-I).
 *
 * Threat mitigations:
 *  - T-04-03-Tlock: acquireLock() before DB open; releaseLock() in finally.
 *  - T-04-03-I: --query argv is passed directly as data; never interpolated in shell.
 *  - T-04-03-K / T-05-02-KEY: DefaultModelProvider reads API keys from env via SDK defaults.
 *    Neither key is logged, committed, or written to stdout.
 *  - T-04-03-R: SessionStart CLI (session-start-cli.ts) is not modified; stays cue-less.
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
import { DefaultModelProvider } from '../model/provider';
import { RecallEngine } from '../recall';
import { acquireLock, releaseLock } from './lockfile';
import { SQLiteActivationTraceSink, NoopActivationTraceSink } from '../viz/activation-sink';

const LOG_PATH = '/tmp/brain-memory-recall.log';

/** Append a timestamped line to the log file (never stdout). */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] recall-cli: ${msg}\n`);

/**
 * Resolve dbPath from --db <path> argv or BRAIN_MEMORY_DB env var.
 * Returns undefined if neither is supplied.
 */
function resolveDbPath(): string | undefined {
  const idx = process.argv.indexOf('--db');
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return process.env['BRAIN_MEMORY_DB'];
}

/**
 * Resolve query string from --query <text> argv.
 * Returns undefined if --query is not supplied or has no value.
 * T-04-03-I: returned as-is — treated as data only inside RecallEngine.
 */
function resolveQuery(): string | undefined {
  const idx = process.argv.indexOf('--query');
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return undefined;
}

const SAFE_NULL_RESULT = JSON.stringify({ inference: null, episodeId: null, origin: 'inferred' });

async function main(): Promise<void> {
  // ── 1. Validate args BEFORE acquiring lock (WR-02: lock leak prevention) ──
  // process.exit() inside a try/finally does NOT unwind the stack, so exiting
  // while the lock is held leaks it for up to LOCK_STALE_MS (5 min). Validate
  // here — before acquireLock() — so these exits are always lock-free.
  // WR-03: every early exit writes SAFE_NULL_RESULT to stdout first so callers
  // doing JSON.parse(stdout) always receive parseable JSON, never an empty string.
  const dbPath = resolveDbPath();
  if (!dbPath) {
    log('No DB path supplied (--db <path> or BRAIN_MEMORY_DB env var) — exiting');
    process.stdout.write(SAFE_NULL_RESULT);
    process.exit(0);
  }

  const query = resolveQuery();
  if (!query) {
    log('No --query supplied — exiting');
    process.stdout.write(SAFE_NULL_RESULT);
    process.exit(0);
  }

  // ── 2. Lock guard (single-writer for episode append, D-43) ──────────────
  if (!acquireLock()) {
    log('Lock held by another process — exiting');
    // WR-03: lock-held is a normal runtime condition; always emit JSON so callers
    // can JSON.parse(stdout) without throwing on an empty string.
    process.stdout.write(SAFE_NULL_RESULT);
    process.exit(0);
  }

  try {
    // ── 3. Open DB and initialize schema ──────────────────────────────────
    const db = new Database(dbPath);
    initSchema(db);

    // ── 4. Instantiate the full RecallEngine dependency graph ─────────────
    const config = { ...DEFAULT_CONFIG, dbPath };

    const episodes = new EpisodicStore(db, realClock, config);
    const store    = new SemanticStore(db, realClock, config);
    const strength = new StrengthDecayManager(db, realClock, config);
    const retriever = new CandidateRetriever(db);

    // T-04-03-K / T-05-02-KEY: keys read from process.env by SDK inside DefaultModelProvider.
    // Resolved provider names are logged by the caller (never secrets).
    const provider = new DefaultModelProvider({ generateConfig: config, judgeConfig: config, embedConfig: config });

    // VIZ-01: inject SQLite trace sink iff viz_trace_enabled='1' (set by `brain viz`, Plan 03).
    // Default OFF: when the meta key is absent or '0' the Noop sink is used — zero extra cost.
    const traceFlagRaw = db.prepare(
      "SELECT value FROM meta WHERE key = 'viz_trace_enabled'"
    ).get() as { value: string } | undefined;
    const traceEnabled = traceFlagRaw?.value === '1';
    const traceSink = traceEnabled
      ? new SQLiteActivationTraceSink(db, realClock)
      : new NoopActivationTraceSink();

    const engine = new RecallEngine(
      db, realClock, config, provider, retriever, store, strength, episodes, traceSink,
    );

    // ── 5. Run recall and emit JSON to stdout ─────────────────────────────
    const result = await engine.recall(query, 'recall-session');
    process.stdout.write(JSON.stringify(result));

    db.close();
  } catch (err) {
    log(`Recall error: ${err}`);
    // Error discipline: safe null JSON to stdout — never a raw error (would corrupt JSON)
    process.stdout.write(SAFE_NULL_RESULT);
  } finally {
    // ── 6. Always release the lock ─────────────────────────────────────────
    releaseLock();
  }
}

main().catch(err => {
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] recall-cli FATAL: ${err}\n`);
  releaseLock(); // best-effort cleanup
  process.exit(1);
});
