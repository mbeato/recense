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
import type { Clock } from '../lib/clock';
import { EpisodicStore } from '../db/episode-store';
import { SemanticStore } from '../db/semantic-store';
import { StrengthDecayManager } from '../strength/decay';
import { CandidateRetriever } from '../retrieval/topk';
import { DefaultModelProvider } from '../model/provider';
import type { ModelProvider as ModelProviderSeam } from '../model/provider';
import type { ExtractedClaim } from '../model/claim-extractor';
import { Consolidator } from '../consolidation/consolidator';
import { SchemaInducer } from '../consolidation/schema-induction';
import { SchemaRelationDeriver } from '../consolidation/schema-relations';
import { CorpusPromoter } from '../consolidation/corpus-promoter';
import { generateCorpusDocs } from '../consolidation/corpus-generator';
import { EventStore } from '../db/event-store';
import { SQLiteConsolidationSink } from '../consolidation/sink';
import { SwitchableActivationTraceSink } from '../viz/activation-sink';
import { newId } from '../lib/hash';
import { cwdToScope, resolveNodeScope } from '../lib/scope';

/**
 * Phase 19 cascade tunables (Item 2 transport (b): the pass spaces emits).
 * The spacing lives entirely AFTER consolidate() — it never touches the critical
 * graph writer or its transaction.
 */
/** Max node-ops replayed as cascade steps. Bounds the extra background-process
 *  lifetime to ~CASCADE_MAX * CASCADE_GAP_MS (≈7s); a longer pass shows its
 *  opening flurry, then stops (honest truncation, never fabrication). */
export const CASCADE_MAX = 24;
/** Gap between cascade emits (ms). ~matches the viz poll (POLL_MS=250) so the
 *  frontend picks up roughly one activation per poll instead of a single burst. */
export const CASCADE_GAP_MS = 300;

/** Default spacer — real wall-clock sleep. Injectable so tests stay instant. */
const realSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Phase 19 viz lighting: replay the consolidation_event provenance a sleep pass just
 * wrote as a PROGRESSIVE, spaced cascade — one tiny flag-gated activation trace per
 * genuine node operation (created / updated / tombstoned / abstracted) since
 * `sinceTs`, in chronological (ts ASC) order. Because schema-induction, belief
 * correction, and tombstoning run at different times within the pass, replaying by
 * ts reproduces that progression for free, so the second brain reads as THINKING
 * rather than firing one summary pulse.
 *
 * Honest by construction — every emit is a node the pass actually touched; a no-op
 * pass fires nothing. Flag-gated via the switchable sink (writes only while a viz
 * window holds viz_trace_enabled on); when OFF it returns immediately (no sleeping,
 * no waste). Cross-process for free: the viz polls the same activation_trace table
 * over WAL. Fire-and-forget — wrapped in try/catch so viz lighting can NEVER surface
 * to or affect the consolidation result (mirrors the engine emit guard, T-10-05).
 * Awaited inside the caller's lock so it never writes to a closing DB. Exported for
 * direct verification; `sleep` is injectable so tests don't wall-clock-block.
 */
export async function lightConsolidatedNodes(
  db: Database.Database,
  clock: Clock,
  sinceTs: number,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<void> {
  try {
    const traceSink = new SwitchableActivationTraceSink(db, clock);
    // Flag OFF → nothing to do; bail before any query or sleep (no waste).
    if (!traceSink.refresh()) return;
    const ops = db.prepare(
      `SELECT node_id FROM consolidation_event
       WHERE ts >= ? AND node_id IS NOT NULL
       ORDER BY ts ASC LIMIT ?`,
    ).all(sinceTs, CASCADE_MAX) as Array<{ node_id: string }>;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (!op) continue;
      traceSink.emit({ query_id: newId(), seeds: [op.node_id], hops: [] });
      // Space between steps so the viz replays a cascade, not a burst — but not
      // after the last, so we don't hold the lock for a trailing idle gap.
      if (i < ops.length - 1) await sleep(CASCADE_GAP_MS);
    }
  } catch {
    // Never let viz lighting affect the pass.
  }
}

/**
 * Phase 999.3 (SCOPE-01, D-S3): stamp single-tenant PROVENANCE scope on every node this
 * pass touched, derived from the cwd of its contributing episode(s).
 *
 * For each node with a consolidation_event since `sinceTs`, collect the DISTINCT cwd of
 * ALL its contributing episodes (across passes, via the consolidation_event → episode
 * provenance join), map each via cwdToScope, and resolve with resolveNodeScope:
 * single known project → that slug; >1 distinct project or personal/home/empty/unknown →
 * 'global'. Idempotent — re-running upserts the same row.
 *
 * Provenance, NOT tenancy (D-S1): scope is a derived DISPLAY annotation. It NEVER feeds
 * retrieval ranking/score/filter. Belief consolidation (node values, dedup, tombstoning,
 * judge) is untouched — this is a purely additive sidecar write AFTER consolidate().
 *
 * Best-effort by construction (D-S2): the whole body is wrapped in try/catch so a
 * scope-write error can NEVER abort or alter the belief write. A pass that touched no
 * node writes nothing. Synchronous (no I/O beyond the shared DB handle). Exported for
 * direct verification.
 */
export function stampNodeScopes(
  db: Database.Database,
  store: SemanticStore,
  clock: Clock,
  sinceTs: number,
): void {
  try {
    // Nodes this pass touched (any consolidation_event since the pass high-water mark).
    const touched = db
      .prepare(
        `SELECT DISTINCT node_id FROM consolidation_event
         WHERE ts >= ? AND node_id IS NOT NULL`,
      )
      .all(sinceTs) as Array<{ node_id: string }>;
    if (touched.length === 0) return;

    // All contributing episodes' cwd for a given node — across ALL passes, not just this
    // one — so a node confirmed by episodes from two projects resolves to 'global' (D-S3).
    const cwdStmt = db.prepare(
      `SELECT DISTINCT e.cwd AS cwd
       FROM consolidation_event ce
       JOIN episode e ON e.id = ce.episode_id
       WHERE ce.node_id = ?`,
    );
    const now = clock.nowMs();
    for (const { node_id } of touched) {
      const cwds = (cwdStmt.all(node_id) as Array<{ cwd: string | null }>).map(r => r.cwd ?? '');
      const scope = resolveNodeScope(cwds.map(cwdToScope));
      store.upsertNodeScope({ node_id, scope, updated_at: now });
    }
  } catch {
    // Never let provenance stamping affect the pass (D-S2 best-effort).
  }
}

// ---------------------------------------------------------------------------
// Provider overlay — moved here from sleep-pass-cli (re-exported for back-compat)
// ---------------------------------------------------------------------------

/** Provider values accepted by EngineConfig.modelProvider (the validation union). */
export const VALID_PROVIDERS = ['anthropic', 'vertex', 'local', 'deepseek', 'claude-headless'] as const;
export type ModelProvider = (typeof VALID_PROVIDERS)[number];

/** Env-derived overlay applied on top of DEFAULT_CONFIG for the sleep pass. */
export interface ProviderOverlay {
  modelProvider: ModelProvider;
  localModel?: string;
  localBaseUrl?: string;
  deepseekModel?: string;
  deepseekBaseUrl?: string;
  claudeHeadlessModel?: string;
}

/**
 * Resolve the model-provider overlay from env, FAIL-SAFE:
 *  - Provider precedence: env[roleEnvKey] (if set+valid) →
 *    RECENSE_MODEL_PROVIDER (if set+valid) → DEFAULT_CONFIG.modelProvider.
 *    Unknown/empty values at any tier are skipped (fail-safe, default unchanged).
 *  - When (and only when) the resolved provider is 'local', optional
 *    RECENSE_LOCAL_MODEL / RECENSE_LOCAL_BASE_URL overlay localModel /
 *    localBaseUrl; absent → DEFAULT_CONFIG values are kept.
 *  - Per-role local model (V5 postmortem 2026-06-12): when roleEnvKey is set, a
 *    role-specific model key derived by replacing the _PROVIDER suffix with
 *    _LOCAL_MODEL (e.g. RECENSE_JUDGE_LOCAL_MODEL) takes precedence over
 *    RECENSE_LOCAL_MODEL. Roles validated independently (extraction bake-off
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
  const baseRaw = env['RECENSE_MODEL_PROVIDER'];
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
    const localModel = (roleModelKey && env[roleModelKey]) || env['RECENSE_LOCAL_MODEL'];
    const localBaseUrl = env['RECENSE_LOCAL_BASE_URL'];
    if (localModel) overlay.localModel = localModel;
    if (localBaseUrl) overlay.localBaseUrl = localBaseUrl;
  }

  if (provider === 'deepseek') {
    // Per-role deepseek model key wins over the shared RECENSE_DEEPSEEK_MODEL key.
    const roleModelKey = roleEnvKey?.endsWith('_PROVIDER')
      ? roleEnvKey.replace(/_PROVIDER$/, '_DEEPSEEK_MODEL')
      : undefined;
    const deepseekModel = (roleModelKey && env[roleModelKey]) || env['RECENSE_DEEPSEEK_MODEL'];
    const deepseekBaseUrl = env['RECENSE_DEEPSEEK_BASE_URL'];
    if (deepseekModel) overlay.deepseekModel = deepseekModel;
    if (deepseekBaseUrl) overlay.deepseekBaseUrl = deepseekBaseUrl;
  }

  if (provider === 'claude-headless') {
    // Per-role model resolution (QUICK-260617-qat): judge defaults to Sonnet, extract to
    // Haiku (spike 003). An explicit per-role env pin
    // (RECENSE_JUDGE_CLAUDE_HEADLESS_MODEL / RECENSE_EXTRACTOR_CLAUDE_HEADLESS_MODEL) wins,
    // then the shared RECENSE_CLAUDE_HEADLESS_MODEL, then the per-role DEFAULT_CONFIG default.
    const roleModelKey = roleEnvKey?.endsWith('_PROVIDER')
      ? roleEnvKey.replace(/_PROVIDER$/, '_CLAUDE_HEADLESS_MODEL')
      : undefined;
    const isExtractor = roleEnvKey?.includes('EXTRACTOR') ?? false;
    const roleDefault = isExtractor
      ? DEFAULT_CONFIG.claudeHeadlessExtractModel
      : DEFAULT_CONFIG.claudeHeadlessJudgeModel;
    overlay.claudeHeadlessModel =
      (roleModelKey && env[roleModelKey]) || env['RECENSE_CLAUDE_HEADLESS_MODEL'] || roleDefault;
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
 * @param opts   Optional replay seam. Valid ONLY when the cache was built with the same
 *               extractor (granite) + same content chunking. When set, overrides only
 *               the consolidator provider's `generate` head to return cached claims;
 *               embed/judge/judgeBatch run for real; granite/Ollama is never called.
 */
export async function runConsolidation(
  db: Database.Database,
  dbPath: string,
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void,
  opts?: { replayExtract?: (content: string) => ExtractedClaim[] },
): Promise<void> {
  // ── 4. Instantiate the full Consolidator dependency graph ─────────────────
  // Base config (no model-provider overlay — stores/retriever are LLM-free).
  const config = { ...DEFAULT_CONFIG, dbPath };
  // EVAL-04 cost lever (A/B toggle): two-tier judge (Haiku triage → Sonnet on contradict).
  // Applied to the base config BEFORE the judgeConfig spread so the judge head inherits it.
  if (env['RECENSE_TWO_TIER_JUDGE'] === '1') config.twoTierJudge = true;
  // Per-role provider routing in the SAME process (fail-safe overlay each):
  //  - judgeConfig    → AnthropicJudge + SchemaInducer default namingFn.
  //  - extractorConfig → AnthropicClaimExtractor.
  const judgeConfig = { ...config, ...resolveProviderOverlay(env, 'RECENSE_JUDGE_PROVIDER') };
  const extractorConfig = { ...config, ...resolveProviderOverlay(env, 'RECENSE_EXTRACTOR_PROVIDER') };
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

  // Replay wrapper: intercept ONLY `generate`; embed/judge/judgeBatch delegate to the real
  // consolidatorProvider so the configured embedder/threshold/judge still run for real.
  // When opts.replayExtract is not set, activeConsolidatorProvider is the original (no-op).
  const REPLAY_MARKER = '\n\nDocument content:\n';
  const activeConsolidatorProvider: ModelProviderSeam = opts?.replayExtract
    ? {
        generate(prompt: string): Promise<string> {
          const idx = prompt.lastIndexOf(REPLAY_MARKER);
          const content = idx >= 0 ? prompt.slice(idx + REPLAY_MARKER.length) : prompt;
          return Promise.resolve(JSON.stringify(opts.replayExtract!(content)));
        },
        embed: (texts) => consolidatorProvider.embed(texts),
        judge: (claim, candidates) => consolidatorProvider.judge(claim, candidates),
        judgeBatch: (items) => consolidatorProvider.judgeBatch(items),
      }
    : consolidatorProvider;

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

  // D-07: SchemaRelationDeriver — LLM-free, deterministic, no ModelProvider injected.
  const deriver = new SchemaRelationDeriver(db, store, config, realClock);

  // D-04 (Phase 28, CORPUS-02/03/05): CorpusPromoter — LLM-free, idempotent corpus-promotion
  // pass that runs in Phase C after deriveSchemaRelations(). Produces doc_containment +
  // doc_reference edges between schema-anchored doc stubs; wipe-and-rebuild on each pass.
  // corpusCosineThreshold is set LOWER than config.schemaRelSimilarityThreshold so the
  // corpus ladder enriches past the ~12 schema_rel baseline among promoted schemas.
  const corpusPromoter = new CorpusPromoter(db, store, realClock, {
    highMass: 10,
    lowMass: 7,
    noiseCap: 0.5,
    corpusCosineThreshold: 0.55,  // enrichment knob: lower than schemaRelSimilarityThreshold (~0.72)
    massGapMin: 2,
    minMembers: 4,
  });

  const consolidator = new Consolidator(
    db,
    episodes,
    store,
    strength,
    retriever,
    activeConsolidatorProvider,
    inducer,
    config,
    realClock,
    sink,
    log,
    deriver,
    corpusPromoter,
  );

  // ── 5. Run the sleep pass ──────────────────────────────────────────────────
  // Provenance high-water mark so Phase-19 viz lighting (below) can scope exactly
  // the nodes THIS pass touches — consolidation_event.ts (ms) bounds the pass.
  const passStartTs = realClock.nowMs();
  await consolidator.consolidate();

  // CORPUS-06: Offline corpus doc generation — fill empty schema-anchored stub docs
  // with prose NOW (while the sleep pass holds its lock) so the online /doc click
  // never pays the ~42s LLM cost. Runs AFTER consolidate() so CorpusPromoter (Phase C
  // inside the consolidator) has already created any new stubs this pass produced.
  //
  // Env gates:
  //   RECENSE_CORPUS_GEN=0   → skip entirely (default: on)
  //   RECENSE_CORPUS_GEN_MAX → override the per-pass maxDocs cap (default: 25)
  if (env['RECENSE_CORPUS_GEN'] !== '0') {
    const maxDocs = parseInt(env['RECENSE_CORPUS_GEN_MAX'] ?? '25', 10) || 25;
    try {
      const corpusGenResult = await generateCorpusDocs(
        { db, store, provider: inducerProvider },
        { maxDocs, log, now: realClock.nowMs() },
      );
      log(
        `CORPUS-06: generated=${corpusGenResult.generated} ` +
        `failed=${corpusGenResult.failed} deferred=${corpusGenResult.deferred}`,
      );
    } catch (err) {
      // Best-effort: corpus generation failure MUST NOT abort the sleep pass
      // (which has already successfully run consolidation). Log and continue.
      log(`CORPUS-06: corpus generation threw unexpectedly: ${err}`);
    }
  }

  // Phase 999.3 (SCOPE-01, D-S3): stamp single-tenant provenance scope on the nodes this
  // pass touched, from their contributing-episode cwd. Additive + best-effort — runs after
  // consolidate() and never affects belief writes or retrieval ranking (D-S1/D-S2).
  stampNodeScopes(db, store, realClock, passStartTs);

  // Phase 19: light the second brain when it does real work on its own.
  // Awaited so the spaced cascade completes inside the caller's lock/DB lifetime.
  await lightConsolidatedNodes(db, realClock, passStartTs);

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
