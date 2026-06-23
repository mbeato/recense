/**
 * derive-doc-graph-cli — recense derive-doc-graph [--db <path>] [--dry-run] (Phase 39.2, D-19).
 *
 * LLM-free, lock-guarded CLI that runs the DocGraphDeriver against the live DB
 * for immediate backfill and inspection — without waiting for an organic sleep pass.
 *   1. Derives doc_reference edges from shared schema-member IDF overlap + schema_rel adjacency (D-01..D-05)
 *   2. Derives doc_containment edges from abstraction-ladder position + hub→subject (D-06..D-09, D-11)
 *   3. Emits a JSON result line {containment, reference, dryRun}
 *
 * Design invariants:
 *  WR-02  Validate DB path BEFORE acquireLock — process.exit() with the lock held leaks it.
 *  T-25-07  Lock released in finally on every path (the shared write-lock pattern).
 *  D-04  Wipe-and-rebuild inside one db.transaction().immediate() — idempotent (DocGraphDeriver contract).
 *  T-02-ASYNC  Phase B inside DocGraphDeriver is a single IMMEDIATE transaction with no
 *              await inside — no nested transactions from the CLI layer.
 *  D-12  All time reads via realClock.nowMs() — never Date.now() directly.
 *  require.main guard: importing this module never auto-runs main() (test isolation).
 *
 * Entry point: dispatched by recense.ts via spawnScript('derive-doc-graph-cli.js', ...).
 *
 * CLI usage:
 *   recense derive-doc-graph [--db <path>] [--dry-run]
 */
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { DocGraphDeriver } from '../consolidation/doc-graph-deriver';
import { acquireLock, releaseLock } from './lockfile';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';

const LOG_PATH = '/tmp/recense-derive-doc-graph.log';

/** Append a timestamped line to the log file. */
const fileLog = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] derive-doc-graph: ${msg}\n`);

async function main(): Promise<void> {
  const argv = process.argv;

  // ── 1. Parse args ─────────────────────────────────────────────────────────
  // No positional arg — operates on all docs in DB.
  const isDryRun = argv.includes('--dry-run');

  // ── 2. Validate DB path BEFORE acquiring lock (WR-02) ─────────────────────
  const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
  if (!dbPath) {
    process.stderr.write(
      'recense derive-doc-graph: No DB path (--db <path> or RECENSE_DB env var) — exiting\n',
    );
    process.exit(0);
  }

  // ── 3. Acquire the shared write lock (T-25-08) ────────────────────────────
  if (!acquireLock()) {
    process.stderr.write('recense derive-doc-graph: Lock held by another process — exiting\n');
    process.exit(0);
  }

  let db: Database.Database | undefined;
  try {
    fileLog(`starting: dbPath=${dbPath} dryRun=${isDryRun}`);

    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    initSchema(db);

    const config = { ...DEFAULT_CONFIG, dbPath };
    const store = new SemanticStore(db, realClock, config);

    // ── 4. Construct DocGraphDeriver ───────────────────────────────────────
    const deriver = new DocGraphDeriver(db, store, config, realClock);

    fileLog(`running deriveDocGraph (dryRun=${isDryRun})`);

    // ── 5. Run the derivation pass ─────────────────────────────────────────
    const result = await deriver.deriveDocGraph({ dryRun: isDryRun });

    fileLog(
      `done: containment=${result.containment} reference=${result.reference}`,
    );

    // ── 6. Emit result JSON ────────────────────────────────────────────────
    process.stdout.write(
      JSON.stringify({
        containment: result.containment,
        reference: result.reference,
        dryRun: isDryRun,
      }) + '\n',
    );
  } catch (err) {
    fileLog(`error: ${err}`);
    process.stderr.write(`recense derive-doc-graph: ${err}\n`);
    process.exitCode = 1;
  } finally {
    db?.close();
    releaseLock();
  }
}

// Only run when invoked as the entry point (dispatched via recense.ts subprocess),
// NOT when imported by a unit test or when require()-d without being main.
if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] derive-doc-graph FATAL: ${err}\n`);
    releaseLock();
    process.exit(1);
  });
}
