/**
 * sleep-pass-cli — detached sleep-pass runner (ADAPT-02, D-31).
 *
 * Entry points:
 *  1. Spawned detached by stop-cli.ts (fires per turn via the Stop hook).
 *  2. Triggered periodically by launchd (Plan 04 dogfood setup).
 *
 * Design invariants:
 *  - Acquires the O_EXCL lockfile before any DB open → single-writer preserved.
 *  - All logging goes to LOG_PATH (stdio is /dev/null when detached; RESEARCH §2).
 *  - Never writes to stdout/stderr — the Stop hook's file descriptors are closed.
 *  - This is the ONLY Phase-3 entry point that is async and makes API calls
 *    (Embedder + Judge). All such cost is quarantined here, off the online path.
 *
 * Threat mitigations:
 *  - T-03-2-Tlock: acquireLock() before DB open; releaseLock() in finally.
 *  - T-03-2-I: stdio is 'ignore' in the spawn call in stop-cli (RESEARCH §2).
 *  - T-03-2-Dpath: dbPath comes from argv array element or env var, never shell string.
 *  - T-03-2-E: child runs as same user; no privilege change.
 */
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { runConsolidation } from '../consolidation/run-sleep-pass';
import { acquireLock, releaseLock, heartbeatLock } from './lockfile';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';
import { setHeadlessUsageSink } from '../model/claude-headless-client';
import type { HeadlessUsage } from '../model/claude-headless-client';

// Back-compat re-exports: resolveProviderOverlay, ProviderOverlay, and VALID_PROVIDERS
// were originally defined here and are imported by tests/sleep-pass-provider.test.ts.
// The canonical definitions now live in src/consolidation/run-sleep-pass.ts.
export type { ProviderOverlay } from '../consolidation/run-sleep-pass';
export { VALID_PROVIDERS, resolveProviderOverlay } from '../consolidation/run-sleep-pass';

const LOG_PATH = '/tmp/recense-sleep.log';

/**
 * DEBT-02: lock-mtime heartbeat interval. Must be comfortably below LOCK_STALE_MS
 * (30 min) so a long pass refreshes its lock several times before it could ever be
 * judged stale. 5 min gives a 6× margin.
 */
const LOCK_HEARTBEAT_MS = 5 * 60 * 1000;

/** Append a timestamped line to the log file (never stdout). */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] sleep-pass: ${msg}\n`);

// M-8: delegate to the shared resolveDbPath with fallbackToDefault=false so a missing
// --db flag / RECENSE_DB env causes the missing-path exit (process.exit(0) below).
function resolveDbPath(): string | undefined {
  return resolveSharedDbPath(process.argv, { fallbackToDefault: false });
}

async function main(): Promise<void> {
  // ── 0. Raise the headless `claude -p` timeout for this pass ──────────────────
  // The headless transport defaults to 120s (claude-headless-client.ts), which is
  // fine for the short judge/extract calls but too short for corpus doc generation:
  // landing docs (Phase 32-02) can have 100+ citations and take 200s+ to generate,
  // so under the default they SIGKILL → empty → not persisted. Mirror the 600s
  // default already set by the other corpus entry points (generate-doc-cli.ts,
  // generate-corpus-cli.ts, ingest-project-cli.ts) so the scheduled deferred path
  // (ingest-project → marker → sleep pass generateCorpusDocs) fills large stubs.
  // Conditional: an explicit env override still wins.
  if (!process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS']) {
    process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS'] = '600000';
  }

  // ── 1. Validate args BEFORE acquiring lock (WR-02: lock leak prevention) ──
  // process.exit() inside a try/finally does NOT unwind the stack, so exiting
  // while the lock is held leaks it for up to LOCK_STALE_MS (5 min). Validate
  // here — before acquireLock() — so this exit is always lock-free.
  const dbPath = resolveDbPath();
  if (!dbPath) {
    log('No DB path supplied (--db <path> or RECENSE_DB env var) — exiting');
    process.exit(0);
  }

  // ── 2. Lock guard ───────────────────────────────────────────────────────────
  if (!acquireLock()) {
    log('Lock held by another process — exiting');
    process.exit(0);
  }

  // ── 2b. Lock heartbeat (DEBT-02) ────────────────────────────────────────────
  // A full backlog drain makes per-episode headless-Haiku calls and can exceed
  // LOCK_STALE_MS (30 min) under rate-limiting. Without a heartbeat the lock's mtime
  // stays frozen at acquisition time, so a concurrent launchd/stop-cli spawn judges
  // this *live* pass stale and reclaims the lock → multiple concurrent graph writers
  // (duplicate extraction, wasted subscription tokens). Refresh the mtime on a timer
  // ≪ the stale window so the lock always looks fresh while we're alive. unref() so the
  // timer never keeps the process alive past main(); cleared in finally on every path.
  const heartbeat = setInterval(heartbeatLock, LOCK_HEARTBEAT_MS);
  heartbeat.unref();

  // DEBT-03: declare db outside try so finally can close it on every path (CR-02/WR-03).
  let db: Database.Database | undefined;
  try {
    log('Sleep pass starting');

    // ── 3. Open DB and initialize schema ────────────────────────────────────
    db = new Database(dbPath);
    initSchema(db);

    // ── 3b. Install the production token-usage ledger sink (D-08/D-09/D-10) ──
    // Best-effort: sink body is wrapped in its own try/catch (belt-and-suspenders
    // on top of the headless client's own emit guard). A failing INSERT MUST NEVER
    // abort or slow the sleep pass. Logs nothing on failure to avoid secret leakage
    // (T-44-09). Only token counts + model + feature_tag are persisted — never
    // prompt/secret contents.
    const stmtLedgerInsert = db.prepare(`
      INSERT INTO token_usage_ledger
        (ts, feature_tag, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, total_cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    setHeadlessUsageSink((u: HeadlessUsage) => {
      try {
        stmtLedgerInsert.run(
          Date.now(),
          u.feature_tag ?? 'unknown',
          u.model,
          u.usage?.['input_tokens'] ?? 0,
          u.usage?.['output_tokens'] ?? 0,
          u.usage?.['cache_creation_input_tokens'] ?? 0,
          u.usage?.['cache_read_input_tokens'] ?? 0,
          u.total_cost_usd ?? 0,
        );
      } catch {
        // Swallowed — ledger write failure must never abort or slow the sleep pass (D-08).
      }
    });

    // ── 4+5+6. Run the full Consolidator dependency graph ───────────────────
    // (wiring, consolidate(), SEAM-02 event summary — shared with ingest-cli)
    await runConsolidation(db, dbPath, process.env, log);
  } catch (err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`Sleep pass error: ${detail}`);
  } finally {
    // ── 7. Stop heartbeat, clear sink, close the DB, then release the lock ────
    // (DEBT-02/03/CR-02/WR-03)
    // Clear the heartbeat first so it cannot refresh (and thus resurrect) the lock
    // mtime after releaseLock() removes the file.
    // Belt-and-suspenders: clear the ledger sink on both success and error paths so
    // no stale sink reference outlives the DB lifetime (T-44-08).
    // Close DB next (flushes the WAL checkpoint, releases the read lock); release lock last.
    clearInterval(heartbeat);
    setHeadlessUsageSink(null);
    db?.close();
    releaseLock();
  }
}

// Only run when invoked as the entry point (launchd / stop-cli spawn), NOT when
// imported by a unit test of the exported helpers above.
if (require.main === module) {
  main().catch(err => {
    // Fatal: something went wrong before the try/finally could run
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] sleep-pass FATAL: ${detail}\n`);
    releaseLock(); // best-effort cleanup
    process.exit(1);
  });
}
