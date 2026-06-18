/**
 * dedup-entities-cli — recense dedup-entities (Phase 25, Plan 25-02, D-11).
 *
 * Opt-in, manual CLI subcommand wrapping the EntityDedup engine. Default mode is
 * a write-nothing dry-run that prints the clusters it WOULD merge. A real mutating
 * run requires explicitly omitting --dry-run (T-25-06: dry-run-first design).
 *
 * Design invariants (from CONTEXT.md):
 *  D-11  Separate, manual, opt-in CLI subcommand — NOT wired into the hourly sleep pass.
 *        Mirrors the "gated live-write needs a real off-switch" lesson.
 *  D-12  LLM-free, ~$0 — reuses stored embeddings + cosineSimF32; no new runtime dep.
 *
 * Safety invariants:
 *  WR-02  Validate DB path BEFORE acquireLock — process.exit() with the lock held leaks it.
 *  T-25-07  Lock released in finally on every mutating-run path.
 *  T-25-08  Shared lockfile with hourly sleep pass (acquireLock) — mutating run exits
 *           if the lock is held by a concurrent writer.
 *
 * Entry point:
 *  - Spawned by recense.ts dispatcher (`recense dedup-entities [--dry-run] [--threshold N] [--db PATH]`)
 *  - `require.main === module` guard: never auto-runs when imported by unit tests.
 */
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { EventStore } from '../db/event-store';
import { SQLiteConsolidationSink } from '../consolidation/sink';
import { EntityDedup, type MergeCluster } from '../consolidation/entity-dedup';
import { acquireLock, releaseLock } from './lockfile';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';

const LOG_PATH = '/tmp/recense-dedup-entities.log';

/** Append a timestamped line to the log file. */
const fileLog = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] dedup-entities: ${msg}\n`);

/**
 * Print the dry-run report to stdout (no DB writes — D-11).
 * Uses process.stdout.write (not console.log) for consistency with the CLI pattern.
 */
export function printDryRun(clusters: MergeCluster[]): void {
  const totalDups = clusters.reduce((sum, c) => sum + c.duplicates.length, 0);
  process.stdout.write('recense dedup-entities — DRY RUN (nothing written)\n\n');
  for (const cluster of clusters) {
    process.stdout.write(`  MERGE  canonical: ${cluster.canonicalValue}\n`);
    for (const dup of cluster.duplicates) {
      process.stdout.write(`    dup: ${dup.value} (cosine=${dup.cosine.toFixed(3)})\n`);
    }
  }
  process.stdout.write(
    `\nplan: ${clusters.length} cluster(s), ${totalDups} node(s) would be tombstoned\n`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv;

  // ── Parse flags ───────────────────────────────────────────────────────────────
  // Default: dry-run ON (T-25-06 / D-11). The real mutating run requires explicit
  // --no-dry-run. Passing --dry-run is also accepted (explicit safe mode).
  const isDryRun = !argv.includes('--no-dry-run'); // default=dry-run; --no-dry-run opts out

  // --threshold <n>: override the D-01 default of 0.88
  const threshIdx = argv.indexOf('--threshold');
  const threshold = threshIdx >= 0 ? parseFloat(argv[threshIdx + 1] ?? '0.88') : 0.88;

  // ── Dry-run: open DB read-only to enumerate candidates; no lock needed ─────────
  if (isDryRun) {
    // WR-02: for dry-run we still need a DB to read from.
    // But we do NOT need the write lock — no writes occur.
    const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
    if (!dbPath) {
      process.stderr.write(
        'recense dedup-entities: No DB path (--db <path> or RECENSE_DB env var) — exiting\n',
      );
      process.exit(0);
    }

    let db: Database.Database | undefined;
    try {
      db = new Database(dbPath);
      initSchema(db);
      const config = { ...DEFAULT_CONFIG, dbPath };
      const store = new SemanticStore(db, realClock, config);
      const eventStore = new EventStore(db);
      const sink = new SQLiteConsolidationSink(eventStore, realClock);
      const dedup = new EntityDedup(db, store, sink, realClock, config);

      const result = dedup.run({ threshold, dryRun: true });
      printDryRun(result.clusters);
    } catch (err) {
      fileLog(`dry-run error: ${err}`);
      process.exitCode = 1;
    } finally {
      db?.close();
    }
    return;
  }

  // ── Real (mutating) run: validate DB path BEFORE acquiring the lock (WR-02) ───
  const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
  if (!dbPath) {
    process.stderr.write(
      'recense dedup-entities: No DB path (--db <path> or RECENSE_DB env var) — exiting\n',
    );
    process.exit(0);
  }

  // Acquire the shared write lock (T-25-08: races the hourly sleep pass)
  if (!acquireLock()) {
    process.stderr.write('recense dedup-entities: Lock held by another process — exiting\n');
    process.exit(0);
  }

  let db: Database.Database | undefined;
  try {
    fileLog('dedup-entities real run starting');

    db = new Database(dbPath);
    initSchema(db);
    const config = { ...DEFAULT_CONFIG, dbPath };
    const store = new SemanticStore(db, realClock, config);
    const eventStore = new EventStore(db);
    const sink = new SQLiteConsolidationSink(eventStore, realClock);
    const dedup = new EntityDedup(db, store, sink, realClock, config);

    const result = dedup.run({ threshold, dryRun: false });
    process.stdout.write(
      `dedup-entities: ${result.mergedClusters} cluster(s) merged, ${result.tombstoned} node(s) tombstoned\n`,
    );
    fileLog(
      `done: mergedClusters=${result.mergedClusters} tombstoned=${result.tombstoned}`,
    );
  } catch (err) {
    fileLog(`error: ${err}`);
    process.exitCode = 1;
  } finally {
    db?.close();
    releaseLock();
  }
}

// Only run when invoked as the entry point (dispatched via recense.ts subprocess),
// NOT when imported by a unit test of the exported helpers above.
if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] dedup-entities FATAL: ${err}\n`);
    releaseLock();
    process.exit(1);
  });
}
