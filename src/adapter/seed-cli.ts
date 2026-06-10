/**
 * seed-cli — brain-seed one-shot cold-start bootstrap CLI (Phase 8, D-77/D-78/D-79).
 *
 * Reads memory files from env-configured paths, extracts entity/fact claims via
 * ProviderClaimExtractor, and writes them to the graph through ColdStartSeeder.
 * One-shot: if 'seeded' meta flag is already set, this is a no-op.
 *
 * Design invariants:
 *  - Validates all args BEFORE acquireLock (WR-02: lock leak prevention).
 *  - Acquires the shared single-writer lock before any DB open (D-78/T-08-LOCK).
 *  - File-only logging — never emits JSON to stdout (bootstrap CLI, not a hook).
 *  - API key is read from env by the SDK inside DefaultModelProvider; never logged (T-08-KEY).
 *
 * Threat mitigations:
 *  - T-08-LOCK: acquireLock() before new Database(); releaseLock() in finally AND main().catch.
 *  - T-08-KEY: only the resolved provider NAME is logged; keys are never handled here.
 *  - T-08-PATH: ColdStartSeeder.collectSources() fs.realpathSync guard is untouched (D-78).
 *  - T-08-SEED-OVERWRITE: D-81 zero-sources guard in ColdStartSeeder.seed() catches
 *    misconfigured runs cleanly; the seeded flag is not burned.
 */
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { DefaultModelProvider } from '../model/provider';
import { ProviderClaimExtractor } from '../model/claim-extractor';
import { resolveProviderOverlay } from '../consolidation/run-sleep-pass';
import { ColdStartSeeder } from '../seeder/cold-start';
import { acquireLock, releaseLock } from './lockfile';
import { resolveDbPath as resolveSharedDbPath } from './runtime-config';

const LOG_PATH = '/tmp/brain-memory-seed.log';

/** Append a timestamped line to the log file (never stdout). */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] brain-seed: ${msg}\n`);

/**
 * Resolve dbPath from --db <path> argv or BRAIN_MEMORY_DB env var.
 * Returns undefined if neither is supplied.
 *
 * M-8: delegates to the shared resolveDbPath with fallbackToDefault=false.
 * Exported for backward-compat with any importer; delegates to runtime-config.
 */
export function resolveDbPath(): string | undefined {
  return resolveSharedDbPath(process.argv, { fallbackToDefault: false });
}

/**
 * Resolve cold-start source paths from env, fail-safe (D-79).
 * Each value is the env var when set and non-empty, else DEFAULT_CONFIG default (now '').
 * Exported so tests can assert env-over-default behaviour without running main().
 */
export function resolveColdStartPaths(env: NodeJS.ProcessEnv): {
  memoryDir: string;
  claudeFile: string;
} {
  const memoryDir =
    (env['BRAIN_MEMORY_COLD_START_MEMORY_DIR'] ?? '').trim() ||
    DEFAULT_CONFIG.coldStartMemoryDir;
  const claudeFile =
    (env['BRAIN_MEMORY_COLD_START_CLAUDE_FILE'] ?? '').trim() ||
    DEFAULT_CONFIG.coldStartClaudeFile;
  return { memoryDir, claudeFile };
}

async function main(): Promise<void> {
  // ── 1. Validate args BEFORE acquiring lock (WR-02: lock leak prevention) ──
  const dbPath = resolveDbPath();
  if (!dbPath) {
    log('no DB path (--db <path> or BRAIN_MEMORY_DB env var) — exiting');
    process.exit(0);
  }

  // ── 2. Resolve cold-start paths; exit early if nothing to seed (pre-lock no-op) ──
  const { memoryDir, claudeFile } = resolveColdStartPaths(process.env);
  if (!memoryDir && !claudeFile) {
    log(
      'nothing to seed — set BRAIN_MEMORY_COLD_START_MEMORY_DIR / BRAIN_MEMORY_COLD_START_CLAUDE_FILE',
    );
    process.exit(0);
  }

  // ── 3. Acquire the shared single-writer lock (D-78/T-08-LOCK) ──────────
  if (!acquireLock()) {
    log('lock held by another process — exiting');
    process.exit(0);
  }

  // CR-02/WR-03: declare db outside try so finally can close it on every path.
  let db: Database.Database | undefined;
  try {
    // ── 4. Open DB and build config ────────────────────────────────────────
    db = new Database(dbPath);
    initSchema(db);

    const config = {
      ...DEFAULT_CONFIG,
      dbPath,
      coldStartMemoryDir: memoryDir,
      coldStartClaudeFile: claudeFile,
    };

    // ── 5. Resolve extractor provider overlay (T-08-KEY: log name only) ───
    const extractorOverlay = resolveProviderOverlay(
      process.env,
      'BRAIN_MEMORY_EXTRACTOR_PROVIDER',
    );
    const extractorConfig = { ...config, ...extractorOverlay };
    log(`extractor provider: ${extractorConfig.modelProvider}`); // resolved name only — never keys

    // ── 6. Wire SemanticStore + ProviderClaimExtractor + ColdStartSeeder ──
    const provider = new DefaultModelProvider({
      generateConfig: extractorConfig,
      judgeConfig: extractorConfig,
      embedConfig: config,
    });
    const store = new SemanticStore(db, realClock, config);
    const extractor = new ProviderClaimExtractor(provider);
    const seeder = new ColdStartSeeder(store, extractor, config);

    await seeder.seed();
    log('seed complete');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // D-81: zero-sources throw is a safe no-op; log friendly and exit 0
    if (msg.includes('no source files resolved')) {
      log(`nothing to seed — no-op (seeded flag NOT set): ${msg}`);
    } else {
      // CR-02: set exitCode instead of process.exit(1) — process.exit() inside
      // try/finally skips the finally block, leaking the single-writer lock for
      // up to LOCK_STALE_MS (5 min). Setting exitCode lets finally run, then the
      // process exits 1 once the event loop drains.
      log(`fatal: ${msg}`);
      process.exitCode = 1;
    }
  } finally {
    // ── 7. Always close the DB and release the lock (CR-02/WR-03/T-08-LOCK) ──
    db?.close();
    releaseLock();
  }
}

// Only run when invoked as the entry point (manual / scripted), NOT when
// imported by a unit test of the exported helpers above.
if (require.main === module) {
  main().catch(err => {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] brain-seed FATAL: ${err}\n`);
    releaseLock(); // best-effort cleanup
    process.exit(1);
  });
}
