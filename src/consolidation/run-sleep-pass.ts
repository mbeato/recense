/**
 * run-sleep-pass — shared Consolidator dependency-graph wiring (Phase 6, D-66).
 *
 * Extracted from sleep-pass-cli.ts so that ingest-cli.ts (brain-ingest) can
 * reuse the exact same consolidation wiring without drift.
 *
 * Contract:
 *  - Caller opens the DB, initialises the schema, and holds the lock.
 *  - This function wires + runs the full Consolidator (steps 4/5/6 from the
 *    original sleep-pass-cli main), then returns.
 *  - No lock operations, no DB open/close — those belong to the caller (CONSOL-03).
 *
 * Re-exports for back-compat:
 *  resolveProviderOverlay, ProviderOverlay, and VALID_PROVIDERS were originally
 *  defined in sleep-pass-cli.ts and are tested there. They are re-exported from
 *  sleep-pass-cli for zero test-import breakage.
 */
import Database from 'better-sqlite3';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { EpisodicStore } from '../db/episode-store';
import { SemanticStore } from '../db/semantic-store';
import { StrengthDecayManager } from '../strength/decay';
import { CandidateRetriever } from '../retrieval/topk';
import { DefaultModelProvider } from '../model/provider';
import { Consolidator } from '../consolidation/consolidator';
import { SchemaInducer } from '../consolidation/schema-induction';
import { EventStore } from '../db/event-store';
import { SQLiteConsolidationSink } from '../consolidation/sink';

// ---------------------------------------------------------------------------
// Provider overlay — moved here from sleep-pass-cli (re-exported for back-compat)
// ---------------------------------------------------------------------------

/** Provider values accepted by EngineConfig.modelProvider (the validation union). */
export const VALID_PROVIDERS = ['anthropic', 'vertex', 'local'] as const;
export type ModelProvider = (typeof VALID_PROVIDERS)[number];

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
 *  - Per-role local model (V5 postmortem 2026-06-12): when roleEnvKey is set, a
 *    role-specific model key derived by replacing the _PROVIDER suffix with
 *    _LOCAL_MODEL (e.g. BRAIN_MEMORY_JUDGE_LOCAL_MODEL) takes precedence over
 *    BRAIN_MEMORY_LOCAL_MODEL. Roles validated independently (extraction bake-off
 *    → qwen2.5:7b; judge eval v2 → qwen3.6:35b-a3b) need independent pins.
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
    // Per-role model pin wins over the shared key (roles are validated independently).
    const roleModelKey = roleEnvKey?.endsWith('_PROVIDER')
      ? roleEnvKey.replace(/_PROVIDER$/, '_LOCAL_MODEL')
      : undefined;
    const localModel = (roleModelKey && env[roleModelKey]) || env['BRAIN_MEMORY_LOCAL_MODEL'];
    const localBaseUrl = env['BRAIN_MEMORY_LOCAL_BASE_URL'];
    if (localModel) overlay.localModel = localModel;
    if (localBaseUrl) overlay.localBaseUrl = localBaseUrl;
  }

  return overlay;
}

// ---------------------------------------------------------------------------
// runConsolidation — the shared sleep-pass body
// ---------------------------------------------------------------------------

/**
 * Wire and run the full Consolidator dependency graph (D-66).
 *
 * Corresponds to steps 4+5+6 of the original sleep-pass-cli main():
 *  4. Instantiate the full Consolidator dependency graph.
 *  5. Run the sleep pass (consolidator.consolidate()).
 *  6. Log the SEAM-02 event summary.
 *
 * Called by:
 *  - sleep-pass-cli.ts  (original hourly pass, lock held in caller)
 *  - ingest-cli.ts      (brain-ingest: pull phase runs first, same lock)
 *
 * @param db     Open, schema-initialised SQLite database (caller responsibility).
 * @param dbPath Filesystem path of the database file — used for config.dbPath.
 * @param env    Process environment — read for model-provider overlay keys.
 * @param log    Timestamped logging function (never stdout, T-03-2-I).
 */
export async function runConsolidation(
  db: Database.Database,
  dbPath: string,
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void,
): Promise<void> {
  // ── 4. Instantiate the full Consolidator dependency graph ─────────────────
  // Base config (no model-provider overlay — stores/retriever are LLM-free).
  const config = { ...DEFAULT_CONFIG, dbPath };
  // Per-role provider routing in the SAME process (fail-safe overlay each):
  //  - judgeConfig    → AnthropicJudge + SchemaInducer default namingFn.
  //  - extractorConfig → AnthropicClaimExtractor.
  const judgeConfig = { ...config, ...resolveProviderOverlay(env, 'BRAIN_MEMORY_JUDGE_PROVIDER') };
  const extractorConfig = { ...config, ...resolveProviderOverlay(env, 'BRAIN_MEMORY_EXTRACTOR_PROVIDER') };
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

  // ── SEAM-02: ConsolidationSink — EventStore + SQLiteConsolidationSink (D-50) ──
  // Wired here so the live hourly pass appends events to consolidation_event.
  const eventStore = new EventStore(db);
  const sink = new SQLiteConsolidationSink(eventStore, realClock);

  const inducer = new SchemaInducer(
    // schema-naming routes to the judge provider (reasoning-ish, low volume)
    db, store, strength, retriever, inducerProvider, judgeConfig, realClock,
    // No namingFn supplied — defaults to provider.generate() via callLlmNaming
    undefined, sink,
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
    sink,
  );

  // ── 5. Run the sleep pass ──────────────────────────────────────────────────
  await consolidator.consolidate();

  // ── 6. Log SEAM-02 event summary (counts/types only — T-05-SINK-KEY) ──────
  const evtSummary = db
    .prepare('SELECT event_type, count(*) c FROM consolidation_event GROUP BY event_type')
    .all() as Array<{ event_type: string; c: number }>;
  if (evtSummary.length > 0) {
    const summary = evtSummary.map(r => `${r.event_type}:${r.c}`).join(' ');
    log(`SEAM-02 events: ${summary}`);
  }

  log('Sleep pass complete');
}
