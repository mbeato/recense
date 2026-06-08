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
import { DefaultModelProvider } from '../model/provider';
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
 *  - Provider precedence: env[roleEnvKey] (if set+valid) →
 *    BRAIN_MEMORY_MODEL_PROVIDER (if set+valid) → DEFAULT_CONFIG.modelProvider.
 *    Unknown/empty values at any tier are skipped (fail-safe, default unchanged).
 *  - When (and only when) the resolved provider is 'local', optional
 *    BRAIN_MEMORY_LOCAL_MODEL / BRAIN_MEMORY_LOCAL_BASE_URL overlay localModel /
 *    localBaseUrl; absent → DEFAULT_CONFIG values are kept.
 *  - roleEnvKey is optional: calling with no role key behaves EXACTLY as the
 *    original single-overlay resolver (backward-compatible — bc2 tests).
 * Pure (env passed in) and network-free so it is unit-testable.
 */
export function resolveProviderOverlay(
  env: NodeJS.ProcessEnv,
  roleEnvKey?: string,
): ProviderOverlay {
  const isValid = (v: string | undefined): v is ModelProvider =>
    (VALID_PROVIDERS as readonly string[]).includes(v ?? '');

  const roleRaw = roleEnvKey ? env[roleEnvKey] : undefined;
  const baseRaw = env['BRAIN_MEMORY_MODEL_PROVIDER'];
  const provider: ModelProvider = isValid(roleRaw)
    ? roleRaw
    : isValid(baseRaw)
      ? baseRaw
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
    // Base config (no model-provider overlay — stores/retriever are LLM-free).
    const config = { ...DEFAULT_CONFIG, dbPath };
    // Per-role provider routing in the SAME process (fail-safe overlay each):
    //  - judgeConfig    → AnthropicJudge + SchemaInducer default namingFn.
    //  - extractorConfig → AnthropicClaimExtractor.
    const judgeConfig = { ...config, ...resolveProviderOverlay(process.env, 'BRAIN_MEMORY_JUDGE_PROVIDER') };
    const extractorConfig = { ...config, ...resolveProviderOverlay(process.env, 'BRAIN_MEMORY_EXTRACTOR_PROVIDER') };
    // resolved providers only — never secrets/keys
    log(`extractor: ${extractorConfig.modelProvider} | judge: ${judgeConfig.modelProvider}`);

    const episodes = new EpisodicStore(db, realClock, config);
    const store = new SemanticStore(db, realClock, config);
    const strength = new StrengthDecayManager(db, realClock, config);
    const retriever = new CandidateRetriever(db);

    // Per-role ModelProvider instances (D-47 split routing preserved below the seam):
    //  - consolidatorProvider: extract head → extractorConfig, judge head → judgeConfig, embed → base config
    //  - inducerProvider:      generate/judge head → judgeConfig (naming is reasoning-ish, low volume)
    // Keys read from process.env by SDK inside DefaultModelProvider — never passed here (T-03-2-E, T-05-KEY).
    const consolidatorProvider = new DefaultModelProvider({
      generateConfig: extractorConfig,
      judgeConfig,
      embedConfig: config,
    });
    const inducerProvider = new DefaultModelProvider({
      generateConfig: judgeConfig,
      judgeConfig,
      embedConfig: config,
    });

    const inducer = new SchemaInducer(
      // schema-naming routes to the judge provider (reasoning-ish, low volume)
      db, store, strength, retriever, inducerProvider, judgeConfig, realClock,
      // No namingFn supplied — defaults to provider.generate() via callLlmNaming
    );

    const consolidator = new Consolidator(
      db,
      episodes,
      store,
      strength,
      retriever,
      consolidatorProvider,
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
