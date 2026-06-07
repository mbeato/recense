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
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { EpisodicStore } from '../db/episode-store';
import { SemanticStore } from '../db/semantic-store';
import { StrengthDecayManager } from '../strength/decay';
import { CandidateRetriever } from '../retrieval/topk';
import { OpenAIEmbedder } from '../model/embedder';
import { AnthropicJudge } from '../model/judge';
import { AnthropicClaimExtractor } from '../model/claim-extractor';
import { Consolidator } from '../consolidation/consolidator';
import { SchemaInducer } from '../consolidation/schema-induction';
import { acquireLock, releaseLock } from './lockfile';

const LOG_PATH = '/tmp/brain-memory-sleep.log';

/** Append a timestamped line to the log file (never stdout). */
const log = (msg: string): void =>
  appendFileSync(LOG_PATH, `[${new Date().toISOString()}] sleep-pass: ${msg}\n`);

/**
 * Resolve dbPath from --db <path> argv or BRAIN_MEMORY_DB env var.
 * Returns undefined if neither is supplied.
 */
function resolveDbPath(): string | undefined {
  const dbArgIdx = process.argv.indexOf('--db');
  if (dbArgIdx !== -1 && process.argv[dbArgIdx + 1]) {
    return process.argv[dbArgIdx + 1];
  }
  return process.env['BRAIN_MEMORY_DB'];
}

/** Provider values accepted by EngineConfig.modelProvider (the validation union). */
const VALID_PROVIDERS = ['anthropic', 'vertex', 'local'] as const;
type ModelProvider = (typeof VALID_PROVIDERS)[number];

/** Env-derived overlay applied on top of DEFAULT_CONFIG for the sleep pass. */
export interface ProviderOverlay {
  modelProvider: ModelProvider;
  localModel?: string;
  localBaseUrl?: string;
}

/**
 * Resolve the model-provider overlay from env, FAIL-SAFE:
 *  - BRAIN_MEMORY_MODEL_PROVIDER → modelProvider, validated against the union.
 *    Unset OR unknown value → DEFAULT_CONFIG.modelProvider (default unchanged).
 *  - When (and only when) the resolved provider is 'local', optional
 *    BRAIN_MEMORY_LOCAL_MODEL / BRAIN_MEMORY_LOCAL_BASE_URL overlay localModel /
 *    localBaseUrl; absent → DEFAULT_CONFIG values are kept.
 * Pure (env passed in) and network-free so it is unit-testable.
 */
export function resolveProviderOverlay(env: NodeJS.ProcessEnv): ProviderOverlay {
  const raw = env['BRAIN_MEMORY_MODEL_PROVIDER'];
  const provider: ModelProvider = (VALID_PROVIDERS as readonly string[]).includes(raw ?? '')
    ? (raw as ModelProvider)
    : DEFAULT_CONFIG.modelProvider;

  const overlay: ProviderOverlay = { modelProvider: provider };

  if (provider === 'local') {
    const localModel = env['BRAIN_MEMORY_LOCAL_MODEL'];
    const localBaseUrl = env['BRAIN_MEMORY_LOCAL_BASE_URL'];
    if (localModel) overlay.localModel = localModel;
    if (localBaseUrl) overlay.localBaseUrl = localBaseUrl;
  }

  return overlay;
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

  try {
    log('Sleep pass starting');

    // ── 3. Open DB and initialize schema ────────────────────────────────────
    const db = new Database(dbPath);
    initSchema(db);

    // ── 4. Instantiate the full Consolidator dependency graph ────────────────
    // Overlay env-derived provider (fail-safe: unset/unknown → DEFAULT_CONFIG).
    const overlay = resolveProviderOverlay(process.env);
    const config = { ...DEFAULT_CONFIG, dbPath, ...overlay };
    log(`provider: ${config.modelProvider}`); // resolved provider only — never secrets

    const episodes = new EpisodicStore(db, realClock, config);
    const store = new SemanticStore(db, realClock, config);
    const strength = new StrengthDecayManager(db, realClock, config);
    const retriever = new CandidateRetriever(db);

    // Production model impls — keys read from process.env by SDK (T-03-2-E)
    const embedder = new OpenAIEmbedder(config.openaiEmbedModel, config.embeddingDimensions);
    const judge = new AnthropicJudge(config);
    const extractor = new AnthropicClaimExtractor(config);

    const inducer = new SchemaInducer(
      db, store, strength, retriever, embedder, config, realClock,
      // No namingFn supplied — defaults to createAnthropicClient (T-04-01-K)
    );

    const consolidator = new Consolidator(
      db,
      episodes,
      store,
      strength,
      retriever,
      embedder,
      judge,
      extractor,
      inducer,
      config,
      realClock,
    );

    // ── 5. Run the sleep pass ────────────────────────────────────────────────
    await consolidator.consolidate();

    log('Sleep pass complete');
  } catch (err) {
    log(`Sleep pass error: ${err}`);
  } finally {
    // ── 6. Always release the lock ───────────────────────────────────────────
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
