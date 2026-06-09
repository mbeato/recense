/**
 * ingest-cli — brain-ingest CLI (Phase 6, D-66).
 *
 * Runs enabled source adapters (pull→redact→append via IngestionPipeline) then the
 * sleep-pass consolidation in one process under a single O_EXCL lock (CONSOL-03).
 *
 * Design invariants:
 *  - enabledSources defaults to [] → pull phase is a no-op; behaviour is identical
 *    to sleep-pass-cli (the off-switch). Safe drop-in for the launchd job.
 *  - One adapter failing (network/auth) is logged and isolated — it never blocks
 *    consolidation or the other adapters, and never leaks token/secret material (D-66).
 *  - Adapters run BEFORE the lock-guarded consolidation; all async pull() calls
 *    complete before any synchronous db.transaction append (async-before-sync).
 *  - Arg validation happens BEFORE acquireLock (WR-02: lock leak prevention).
 *  - File-only logging — never stdout (stdio is /dev/null under launchd, T-03-2-I).
 *
 * Threat mitigations:
 *  - T-06-24: runPullPhase wraps each adapter in its own try/catch; consolidation runs
 *             regardless of adapter failures (D-66 isolation).
 *  - T-06-25: catch logs err.toString() + adapter.source only — token/secret never logged.
 *  - T-06-26: acquireLock wraps the full cycle; releaseLock in finally (CONSOL-03/WR-02).
 *  - T-06-27: enabledSources=[] default → no ingestion without explicit opt-in.
 *
 * launchd compatibility:
 *  The existing hourly wrapper (scripts/sleep-pass-launchd.sh) execs BRAIN_MEMORY_SLEEP_JS
 *  with no args; dbPath comes from BRAIN_MEMORY_DB env. With no args this CLI defaults to
 *  --all, so it is a drop-in replacement for sleep-pass-cli.js once BRAIN_MEMORY_SLEEP_JS
 *  is updated. The activation step is a human-gated checkpoint (Task 3, T-06-27).
 */
import { appendFileSync } from 'fs';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import type { EngineConfig } from '../lib/config';
import { realClock } from '../lib/clock';
import { EpisodicStore } from '../db/episode-store';
import { SemanticStore } from '../db/semantic-store';
import { AllocationGate, IngestionPipeline } from '../ingest/pipeline';
import type { SourceAdapter, NormalizedRecord } from '../source/source-adapter';
import { GmailAdapter } from '../source/gmail-adapter';
import { TranscriptAdapter } from '../source/transcript-adapter';
import { ObsidianAdapter } from '../source/obsidian-adapter';
import { runConsolidation } from '../consolidation/run-sleep-pass';
import { acquireLock, releaseLock } from './lockfile';

const LOG_PATH = '/tmp/brain-memory-ingest.log';

/** Append a timestamped line to the log file (never stdout). */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] brain-ingest: ${msg}\n`);

/**
 * Resolve dbPath from --db <path> argv or BRAIN_MEMORY_DB env var.
 * Returns undefined if neither is supplied.
 * Identical to sleep-pass-cli.resolveDbPath (T-03-2-Dpath: argv array element, never shell string).
 */
function resolveDbPath(): string | undefined {
  const dbArgIdx = process.argv.indexOf('--db');
  if (dbArgIdx !== -1 && process.argv[dbArgIdx + 1]) {
    return process.argv[dbArgIdx + 1];
  }
  return process.env['BRAIN_MEMORY_DB'];
}

/**
 * Build adapter instances for each source named in config.enabledSources (D-63 discretion).
 *
 * Fail-safe: unknown source names are logged and skipped (not fatal).
 * Default-off: with enabledSources=[] (the default) this returns [] — no adapters,
 * no pull, a safe no-op before any source is explicitly enabled.
 *
 * @param config Engine config — reads config.enabledSources and per-source sub-configs.
 * @param meta   Cursor-persistence store. MUST be the SemanticStore instance (D-67):
 *               SemanticStore.getMeta/setMeta is the sole accessor for the meta table,
 *               where adapter cursors (cursor:gmail, cursor:granola, cursor:obsidian) live.
 *               Passing the EpisodicStore silently disables cursors — re-fetches all data hourly.
 */
export function buildAdapters(
  config: EngineConfig,
  meta: Pick<SemanticStore, 'getMeta' | 'setMeta'>,
): SourceAdapter[] {
  const adapters: SourceAdapter[] = [];
  for (const source of config.enabledSources) {
    switch (source) {
      case 'gmail':
        adapters.push(new GmailAdapter(config, meta));
        break;
      case 'granola':
        adapters.push(new TranscriptAdapter(config, meta));
        break;
      case 'obsidian':
        adapters.push(new ObsidianAdapter(config, meta));
        break;
      default:
        // Unknown source — log and skip (fail-safe: unknown names never throw)
        appendFileSync(
          LOG_PATH,
          `[${new Date().toISOString()}] brain-ingest: unknown source '${source}' in enabledSources — skipping\n`,
        );
    }
  }
  return adapters;
}

/**
 * Run the pull phase for all adapters with per-adapter failure isolation (D-66).
 *
 * For each adapter:
 *  1. Await adapter.pull() — async I/O completes fully before any DB write.
 *  2. On success: wrap the synchronous append loop in a single db.transaction for speed
 *     (async-before-sync pattern; NO await inside the transaction, better-sqlite3 invariant).
 *  3. On failure: log the error string + adapter.source (never the token, T-06-25)
 *     and CONTINUE to the next adapter — one failure never blocks others or consolidation.
 *
 * @param adapters List of instantiated SourceAdapters to pull from.
 * @param pipeline IngestionPipeline — gate.score + store.append for each record.
 * @param db       Open database — used to wrap per-adapter appends in a single transaction.
 * @param log      Logging function (file-backed in CLI, captured array in tests).
 */
export async function runPullPhase(
  adapters: SourceAdapter[],
  pipeline: IngestionPipeline,
  db: Database.Database,
  log: (msg: string) => void,
): Promise<void> {
  for (const adapter of adapters) {
    // ── async pull (I/O completes before any sync write) ────────────────────
    let records: NormalizedRecord[];
    try {
      records = await adapter.pull();
    } catch (err) {
      // T-06-25: log the error STRING + adapter source only — never the token.
      log(`adapter ${adapter.source} failed: ${String(err)}`);
      continue; // D-66 isolation: other adapters and consolidation still run
    }

    // ── sync appends wrapped in one transaction (async-before-sync) ─────────
    let appended = 0;
    const appendBatch = db.transaction((batch: NormalizedRecord[]) => {
      for (const r of batch) {
        // recordEvent is synchronous (better-sqlite3 invariant — no await inside tx)
        pipeline.recordEvent({
          content: r.content,
          role: r.role,
          origin: r.origin,
          sessionId: `ingest:${r.source}`,
          source: r.source,
          externalId: r.external_id,
        });
        appended++;
      }
    });
    appendBatch(records);

    log(`${adapter.source}: pulled ${records.length} records, appended ${appended}`);
  }
}

async function main(): Promise<void> {
  // ── 1. Validate args BEFORE acquiring lock (WR-02: lock leak prevention) ──
  // process.exit() inside a try/finally does NOT unwind the stack, so exiting
  // while the lock is held leaks it. Validate here — before acquireLock().
  const dbPath = resolveDbPath();
  if (!dbPath) {
    log('No DB path supplied (--db <path> or BRAIN_MEMORY_DB env var) — exiting');
    process.exit(0);
  }

  // Source selection: --all (default) or a single <source> positional arg.
  // When invoked by the launchd wrapper (no args) we default to --all.
  const hasAllFlag = process.argv.includes('--all');
  // Positional args: everything after "node script.js" that is not a flag and
  // not the value consumed by --db.
  const positionals = process.argv.slice(2).filter((a, idx, arr) => {
    if (a.startsWith('--')) return false; // flag
    const prevArg = arr[idx - 1];
    if (prevArg === '--db') return false; // value for --db
    return true;
  });

  const singleSource = !hasAllFlag && positionals.length === 1 ? positionals[0] : undefined;

  // Validate single-source arg if supplied
  const knownSources = new Set(['gmail', 'granola', 'obsidian']);
  if (singleSource !== undefined && !knownSources.has(singleSource)) {
    log(`Unknown source '${singleSource}' — expected one of: gmail, granola, obsidian`);
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
    log('brain-ingest starting');

    // ── 3. Open DB and initialize schema ────────────────────────────────────
    db = new Database(dbPath);
    initSchema(db);

    // ── 4. Build config + stores ─────────────────────────────────────────────
    const config = { ...DEFAULT_CONFIG, dbPath };

    // For single-source runs, filter enabledSources to only the requested adapter.
    // This lets manual backfill runs target a single source without editing config.
    const effectiveConfig: EngineConfig = singleSource
      ? { ...config, enabledSources: config.enabledSources.includes(singleSource) ? [singleSource] : [] }
      : config;

    const gate = new AllocationGate(effectiveConfig);
    const episodes = new EpisodicStore(db, realClock, effectiveConfig);
    // SemanticStore is the cursor store (D-67): getMeta/setMeta back all adapter cursors.
    const semanticStore = new SemanticStore(db, realClock, effectiveConfig);
    const pipeline = new IngestionPipeline(gate, episodes);

    // ── 5. Pull phase — adapters run BEFORE the graph-writer step ────────────
    // With enabledSources=[] (default) buildAdapters returns [] and this is a no-op.
    const adapters = buildAdapters(effectiveConfig, semanticStore);
    await runPullPhase(adapters, pipeline, db, log);

    // ── 6. Consolidation phase — under the same lock (CONSOL-03) ────────────
    await runConsolidation(db, dbPath, process.env, log);
  } catch (err) {
    log(`brain-ingest error: ${err}`);
  } finally {
    // ── 7. Always close the DB, then release the lock (DEBT-03/CR-02/WR-03) ──
    // Close first: flushes the WAL checkpoint and releases the read lock.
    // Release lock second: O_EXCL unlock after DB handle is gone.
    db?.close();
    releaseLock();
  }
}

// Only run when invoked as the entry point (launchd / manual), NOT when
// imported by a unit test of the exported functions above.
if (require.main === module) {
  main().catch(err => {
    // Fatal: something went wrong before the try/finally could run
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] brain-ingest FATAL: ${err}\n`);
    releaseLock(); // best-effort cleanup
    process.exit(1);
  });
}
