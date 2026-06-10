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
import { acquireLock, releaseLock } from './lockfile';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';

// Back-compat re-exports: resolveProviderOverlay, ProviderOverlay, and VALID_PROVIDERS
// were originally defined here and are imported by tests/sleep-pass-provider.test.ts.
// The canonical definitions now live in src/consolidation/run-sleep-pass.ts.
export type { ProviderOverlay } from '../consolidation/run-sleep-pass';
export { VALID_PROVIDERS, resolveProviderOverlay } from '../consolidation/run-sleep-pass';

const LOG_PATH = '/tmp/brain-memory-sleep.log';

/** Append a timestamped line to the log file (never stdout). */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] sleep-pass: ${msg}\n`);

// M-8: delegate to the shared resolveDbPath with fallbackToDefault=false so a missing
// --db flag / BRAIN_MEMORY_DB env causes the missing-path exit (process.exit(0) below).
function resolveDbPath(): string | undefined {
  return resolveSharedDbPath(process.argv, { fallbackToDefault: false });
}

async function main(): Promise<void> {
  // ── 1. Validate args BEFORE acquiring lock (WR-02: lock leak prevention) ──
  // process.exit() inside a try/finally does NOT unwind the stack, so exiting
  // while the lock is held leaks it for up to LOCK_STALE_MS (5 min). Validate
  // here — before acquireLock() — so this exit is always lock-free.
  const dbPath = resolveDbPath();
  if (!dbPath) {
    log('No DB path supplied (--db <path> or BRAIN_MEMORY_DB env var) — exiting');
    process.exit(0);
  }

  // ── 2. Lock guard ───────────────────────────────────────────────────────────
  if (!acquireLock()) {
    log('Lock held by another process — exiting');
    process.exit(0);
  }

  // DEBT-03: declare db outside try so finally can close it on every path (CR-02/WR-03).
  let db: Database.Database | undefined;
  try {
    log('Sleep pass starting');

    // ── 3. Open DB and initialize schema ────────────────────────────────────
    db = new Database(dbPath);
    initSchema(db);

    // ── 4+5+6. Run the full Consolidator dependency graph ───────────────────
    // (wiring, consolidate(), SEAM-02 event summary — shared with ingest-cli)
    await runConsolidation(db, dbPath, process.env, log);
  } catch (err) {
    log(`Sleep pass error: ${err}`);
  } finally {
    // ── 7. Always close the DB, then release the lock (DEBT-03/CR-02/WR-03) ──
    // Close first: flushes the WAL checkpoint and releases the read lock.
    // Release lock second: O_EXCL unlock after DB handle is gone.
    db?.close();
    releaseLock();
  }
}

// Only run when invoked as the entry point (launchd / stop-cli spawn), NOT when
// imported by a unit test of the exported helpers above.
if (require.main === module) {
  main().catch(err => {
    // Fatal: something went wrong before the try/finally could run
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] sleep-pass FATAL: ${err}\n`);
    releaseLock(); // best-effort cleanup
    process.exit(1);
  });
}
