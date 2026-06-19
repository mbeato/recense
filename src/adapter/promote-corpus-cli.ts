/**
 * promote-corpus-cli — recense promote-corpus [--db <path>] [--dry-run] (Phase 28, CORPUS-02/03/05).
 *
 * LLM-free, lock-guarded CLI that runs the D-04 idempotent corpus-promotion pass:
 *   1. LLM-free mass gate + noise filter selects 15–60 schema candidates (CORPUS-02)
 *   2. Centroid-cosine + mass-direction ladder builds doc_containment + doc_reference
 *      edges between schema-anchored doc stubs (CORPUS-03)
 *   3. Eager lifecycle-exempt doc-node stubs for newly promoted schemas (no LLM call)
 *   4. Wipe-and-rebuild of all doc_containment + doc_reference edges (idempotent)
 *   5. Emit a JSON result line {promoted, containment, reference, tombstoned, dryRun}
 *
 * Design invariants:
 *  WR-02  Validate DB path BEFORE acquireLock — process.exit() with the lock held leaks it.
 *  T-25-07  Lock released in finally on every path (the shared write-lock pattern).
 *  D-03  All corpus edges are written between type='doc' nodes only; source schemas
 *         are never mutated (CORPUS-05 self-confirmation guard by construction).
 *  T-02-ASYNC  Phase B inside CorpusPromoter is a single IMMEDIATE transaction with no
 *              await inside — no nested transactions from the CLI layer.
 *  D-12  All time reads via realClock.nowMs() — never Date.now() directly.
 *  require.main guard: importing this module never auto-runs main() (test isolation).
 *  T-28-PATH  dbPath validated to exist before any write attempt; no UUID schema-id
 *             positional arg accepted (the CLI operates on ALL schemas; no positional).
 *
 * Entry point: dispatched by recense.ts via spawnScript('promote-corpus-cli.js', ...).
 *
 * CLI usage:
 *   recense promote-corpus [--db <path>] [--dry-run]
 */
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { CorpusPromoter } from '../consolidation/corpus-promoter';
import { acquireLock, releaseLock } from './lockfile';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';

const LOG_PATH = '/tmp/recense-promote-corpus.log';

/** Append a timestamped line to the log file. */
const fileLog = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] promote-corpus: ${msg}\n`);

async function main(): Promise<void> {
  const argv = process.argv;

  // ── 1. Parse args ─────────────────────────────────────────────────────────
  // No positional schema-id arg — the CLI operates on ALL schemas in the DB.
  // (T-28-PATH: rejecting a positional schema UUID would introduce a path where
  //  the promoter runs on a subset, breaking idempotency and the CORPUS-05 guard.)
  const isDryRun = argv.includes('--dry-run');

  // ── 2. Validate DB path BEFORE acquiring lock (WR-02) ─────────────────────
  const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
  if (!dbPath) {
    process.stderr.write(
      'recense promote-corpus: No DB path (--db <path> or RECENSE_DB env var) — exiting\n',
    );
    process.exit(0);
  }

  // ── 3. Acquire the shared write lock (T-25-08) ────────────────────────────
  if (!acquireLock()) {
    process.stderr.write('recense promote-corpus: Lock held by another process — exiting\n');
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

    // ── 4. Construct CorpusPromoter (same constants as sleep-pass) ─────────
    // corpusCosineThreshold is lower than schemaRelSimilarityThreshold so the
    // corpus ladder enriches past the ~12 schema_rel baseline (D-01R enrichment knob).
    const promoter = new CorpusPromoter(db, store, realClock, {
      highMass: 10,
      lowMass: 7,
      noiseCap: 0.5,
      corpusCosineThreshold: 0.55,
      massGapMin: 2,
      minMembers: 4,
    });

    fileLog(`running promote (dryRun=${isDryRun})`);

    // ── 5. Run the promotion pass ──────────────────────────────────────────
    const result = await promoter.promote({ dryRun: isDryRun });

    fileLog(
      `done: promoted=${result.promoted.length} containment=${result.containment} ` +
      `reference=${result.reference} tombstoned=${result.tombstoned}`,
    );

    // ── 6. Emit result JSON ────────────────────────────────────────────────
    process.stdout.write(
      JSON.stringify({
        promoted: result.promoted.length,
        containment: result.containment,
        reference: result.reference,
        tombstoned: result.tombstoned,
        dryRun: isDryRun,
      }) + '\n',
    );
  } catch (err) {
    fileLog(`error: ${err}`);
    process.stderr.write(`recense promote-corpus: ${err}\n`);
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
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] promote-corpus FATAL: ${err}\n`);
    releaseLock();
    process.exit(1);
  });
}
