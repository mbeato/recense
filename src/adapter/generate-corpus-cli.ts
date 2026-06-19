/**
 * generate-corpus-cli — recense generate-corpus [--db <path>] [--max <n>] (CORPUS-06).
 *
 * Write-capable, lock-guarded CLI that fills empty schema-anchored corpus doc stubs with
 * generated prose in a single offline batch:
 *   1. Validate DB path (WR-02: before acquireLock so exit with lock held never happens)
 *   2. Acquire the shared write lock
 *   3. Build a judge-tier DefaultModelProvider (generateConfig=judgeConfig, D-04)
 *   4. Call generateCorpusDocs — fills empty stubs, skips non-empty ones (idempotent)
 *   5. Emit a JSON result line { generated, failed, deferred }
 *   6. Release lock in finally
 *
 * Design invariants:
 *  WR-02  Validate DB path BEFORE acquireLock.
 *  T-25-07  Lock released in finally on every path.
 *  D-04  generateConfig = judgeConfig (judge-tier is the strong model slot).
 *  D-12  now passed from realClock.nowMs() — never Date.now() directly in engine code.
 *  require.main guard: importing this module never auto-runs main() (test isolation).
 *
 * Entry point: dispatched by recense.ts via spawnScript('generate-corpus-cli.js', ...).
 *
 * CLI usage:
 *   recense generate-corpus [--db <path>] [--max <n>]
 *
 *   --db   Path to the recense SQLite database (falls back to RECENSE_DB env var).
 *   --max  Per-pass doc cap (default 25). Stubs beyond the cap are left for next run.
 */
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { DefaultModelProvider } from '../model/provider';
import { generateCorpusDocs } from '../consolidation/corpus-generator';
import { acquireLock, releaseLock } from './lockfile';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';
import { resolveProviderOverlay } from '../consolidation/run-sleep-pass';

const LOG_PATH = '/tmp/recense-generate-corpus.log';

/** Append a timestamped line to the log file. */
const fileLog = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] generate-corpus: ${msg}\n`);

async function main(): Promise<void> {
  const argv = process.argv;

  // ── 1. Parse args ─────────────────────────────────────────────────────────
  // --max <n>: per-pass doc cap (default 25). Optional.
  const maxIdx = argv.indexOf('--max');
  const maxDocs =
    maxIdx !== -1 && argv[maxIdx + 1] ? parseInt(argv[maxIdx + 1]!, 10) || 25 : 25;

  // ── 2. Validate DB path BEFORE acquiring lock (WR-02) ─────────────────────
  const dbPath = resolveSharedDbPath(argv, { fallbackToDefault: false });
  if (!dbPath) {
    process.stderr.write(
      'recense generate-corpus: No DB path (--db <path> or RECENSE_DB env var) — exiting\n',
    );
    process.exit(0);
  }

  // ── 3. Acquire the shared write lock (T-25-08) ────────────────────────────
  if (!acquireLock()) {
    process.stderr.write('recense generate-corpus: Lock held by another process — exiting\n');
    process.exit(0);
  }

  let db: Database.Database | undefined;
  try {
    fileLog(`starting: dbPath=${dbPath} maxDocs=${maxDocs}`);

    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    initSchema(db);

    const config = { ...DEFAULT_CONFIG, dbPath };
    const store = new SemanticStore(db, realClock, config);

    // ── 4. Build judge-tier provider (D-04 — generateConfig = judgeConfig) ───
    // Doc generation produces ~4000 tokens of cited prose. Same timeout defence as
    // generate-doc-cli: raise to 600s when unset to prevent SIGKILL on long LLM calls.
    if (!process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS']) {
      process.env['RECENSE_CLAUDE_HEADLESS_TIMEOUT_MS'] = '600000';
    }

    const judgeConfig = { ...config, ...resolveProviderOverlay(process.env, 'RECENSE_JUDGE_PROVIDER') };
    const embedConfig = config;
    const provider = new DefaultModelProvider({
      generateConfig: judgeConfig,  // D-04: judge tier is the generate head
      judgeConfig,
      embedConfig,
    });

    fileLog(`generating: maxDocs=${maxDocs} provider=${judgeConfig.modelProvider}`);

    // ── 5. Generate ────────────────────────────────────────────────────────────
    const result = await generateCorpusDocs(
      { db, store, provider },
      {
        maxDocs,
        log: fileLog,
        now: realClock.nowMs(),
      },
    );

    fileLog(
      `done: generated=${result.generated} failed=${result.failed} deferred=${result.deferred}`,
    );

    // ── 6. Emit result JSON ─────────────────────────────────────────────────────
    process.stdout.write(
      JSON.stringify({
        generated: result.generated,
        failed: result.failed,
        deferred: result.deferred,
      }) + '\n',
    );
  } catch (err) {
    fileLog(`error: ${err}`);
    process.stderr.write(`recense generate-corpus: ${err}\n`);
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
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] generate-corpus FATAL: ${err}\n`);
    releaseLock();
    process.exit(1);
  });
}
