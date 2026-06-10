/**
 * recall-cli — on-demand latency-tolerant recall adapter (LEARN-02, D-40).
 *
 * Entry point: `brain recall "<text>"` (positional) or `--query <text>` [--db <path>]
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
import { releaseLock, acquireLockWithRetry } from './lockfile';
import { SQLiteActivationTraceSink, NoopActivationTraceSink } from '../viz/activation-sink';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';
import { resolveProviderOverlay } from '../consolidation/run-sleep-pass';

const LOG_PATH = '/tmp/brain-memory-recall.log';

/** Append a timestamped line to the log file (never stdout). */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] recall-cli: ${msg}\n`);

// M-8: delegate to the shared resolveDbPath with fallbackToDefault=false so a missing
// --db flag / BRAIN_MEMORY_DB env causes the missing-path exit (process.exit(0) below).
function resolveDbPath(): string | undefined {
  return resolveSharedDbPath(process.argv, { fallbackToDefault: false });
}

/**
 * Resolve query string from argv. Accepts BOTH forms:
 *   brain recall "some question"     (positional — the natural form)
 *   brain recall --query "some question"   (explicit flag — back-compat)
 * Returns undefined if neither is present.
 * T-04-03-I: returned as-is — treated as data only inside RecallEngine.
 */
function resolveQuery(): string | undefined {
  const argv = process.argv;
  // Explicit --query wins (back-compat).
  const idx = argv.indexOf('--query');
  if (idx !== -1 && typeof argv[idx + 1] === 'string' && argv[idx + 1] !== '') {
    return argv[idx + 1];
  }
  // Otherwise take the first positional arg, skipping the 'recall' subcommand token
  // and any flag/value pairs (--db <path>, --query <text>) and bare flags.
  const start = argv[2] === 'recall' ? 3 : 2;
  for (let i = start; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db' || a === '--query') { i++; continue; } // flag consumes its value
    if (a === undefined || a.startsWith('-')) continue;     // skip flags
    return a;                                               // first bare token = query
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
  // The always-on watcher acquires this same lock every poll tick (~500ms) around a
  // brief getUpdates fetch + cursor write. A single non-retrying acquire would make
  // interactive recall fail intermittently whenever it collides with a watcher tick.
  // Retry briefly (bounded) so recall coexists with the watcher; only give up if the
  // lock stays held (e.g. the watcher is mid-LLM-response to a Telegram message).
  if (!(await acquireLockWithRetry())) {
    log('Lock held by another process after retries — exiting');
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

    // M-7: apply provider overlay so BRAIN_MEMORY_MODEL_PROVIDER / role-specific provider
    // env vars route generate+judge to the configured provider. embed stays base config.
    // Log resolved provider NAMES only (never keys — T-04-03-K / T-05-02-KEY).
    const generateConfig = { ...config, ...resolveProviderOverlay(process.env, 'BRAIN_MEMORY_EXTRACTOR_PROVIDER') };
    const judgeConfig    = { ...config, ...resolveProviderOverlay(process.env, 'BRAIN_MEMORY_JUDGE_PROVIDER') };
    log('providers — generate: ' + generateConfig.modelProvider + ' | judge: ' + judgeConfig.modelProvider);
    const provider = new DefaultModelProvider({ generateConfig, judgeConfig, embedConfig: config });

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
