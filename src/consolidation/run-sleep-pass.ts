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
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import Database from 'better-sqlite3';
import { setHeadlessFeature } from '../model/claude-headless-client';
import { DEFAULT_CONFIG } from '../lib/config';
import type { EngineConfig } from '../lib/config';
import { loadMergedConfig } from '../adapter/settings-loader';
import { realClock } from '../lib/clock';
import type { Clock } from '../lib/clock';
import { EpisodicStore } from '../db/episode-store';
import { SemanticStore } from '../db/semantic-store';
import { StrengthDecayManager } from '../strength/decay';
import { CandidateRetriever, buildVectorIndex, vectorIndexPath } from '../retrieval/topk';
import { DefaultModelProvider } from '../model/provider';
import type { ModelProvider as ModelProviderSeam } from '../model/provider';
import { getTwoTierStats } from '../model/judge';
import type { ExtractedClaim } from '../model/claim-extractor';
import { Consolidator } from '../consolidation/consolidator';
import { SchemaInducer } from '../consolidation/schema-induction';
import { SchemaRelationDeriver } from '../consolidation/schema-relations';
import { CorpusPromoter, SubjectPromoter } from '../consolidation/corpus-promoter';
import { DocGraphDeriver } from '../consolidation/doc-graph-deriver';
import { InsightReflector } from '../consolidation/insight-reflector';
import { embedAndStoreGlosses, loadGlossEmbeddings } from '../consolidation/gloss-embeddings';
import { EntityDedup } from '../consolidation/entity-dedup';
import { FactDedup } from '../consolidation/fact-dedup';
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
// consumePendingCorpusMarkers — crash-safe marker-consume for pending promotions
// ---------------------------------------------------------------------------

/**
 * Consume all `pending-corpus-promotion:<scope>` meta markers written by the deferred
 * `recense ingest-project` path (Plan 32-03, D-05), force-promoting each scope's corpus
 * before the generateCorpusDocs pass fills the new stubs.
 *
 * Must be called BEFORE generateCorpusDocs (run-sleep-pass.ts CORPUS-06 block) so that
 * stubs created here are filled in the SAME pass.
 *
 * CRASH-SAFE ORDER (T-32-MARK):
 *  For each marker:
 *    1. Parse scope = key.slice('pending-corpus-promotion:'.length)
 *    2. await promoter.promoteScope(scope)   ← stubs written
 *    3. store.deleteMeta(key)                ← marker cleared ONLY after success
 *
 *  If promoteScope throws, the marker is NOT cleared — the next pass retries
 *  (idempotent: promoteScope reuses existing stubs by slug).
 *
 * BEST-EFFORT (per-marker try/catch):
 *  A failure on one scope does not abort the others. The sleep pass must continue.
 *
 * T-01-SQL (bound LIKE literal): the scan uses a compiled prepared statement with
 *  a literal LIKE pattern (not interpolated user input) — safe per T-01-SQL.
 *
 * @param db       Open, schema-initialised SQLite database.
 * @param store    SemanticStore instance (same db handle).
 * @param promoter CorpusPromoter instance (for promoteScope calls).
 * @param log      Timestamped log function (callers provide their own log sink).
 */
export async function consumePendingCorpusMarkers(
  db: Database.Database,
  store: SemanticStore,
  promoter: Pick<CorpusPromoter, 'promoteScope'>,
  log: (msg: string) => void,
): Promise<void> {
  // T-01-SQL: prepared statement with a bound LIKE literal (static string, not user input)
  const stmtScanMarkers = db.prepare(
    "SELECT key FROM meta WHERE key LIKE 'pending-corpus-promotion:%'"
  );

  const markerRows = stmtScanMarkers.all() as Array<{ key: string }>;

  for (const { key } of markerRows) {
    const scope = key.slice('pending-corpus-promotion:'.length);

    try {
      const result = await promoter.promoteScope(scope);
      log(
        `CORPUS-MARKER: consumed scope=${scope} promoted=${result.promoted.length} containment=${result.containment}`,
      );

      // CRASH-SAFE: clear marker ONLY after a successful promoteScope (T-32-MARK)
      store.deleteMeta(key);
      log(`CORPUS-MARKER: cleared marker key=${key}`);
    } catch (err) {
      // Best-effort per-marker: log + leave marker so the next pass retries
      log(`CORPUS-MARKER: promoteScope failed for scope=${scope} (marker NOT cleared — will retry): ${err}`);
    }
  }
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
/**
 * Phase 25 go-nightly (RECENSE_SLEEP_DEDUP=1, dark-default OFF): end-of-pass graph hygiene.
 *
 * The existing entity/fact dedup is a precision-first, SAME-normalized-value collapser
 * (blocking key = normalizeValue, confirm with cosine >= 0.88) — it only merges textual
 * duplicates ("ccusage"≡"ccusage"), never cross-value semantic variants, so the per-pass
 * risk is low and the result is idempotent. Opt-in CLI meant duplicates accumulated between
 * manual runs; running it nightly keeps the graph clean.
 *
 * SAFETY (founder SPOF — no other DB backups): take a consistent VACUUM INTO snapshot FIRST
 * as the rollback point. If the snapshot fails, SKIP dedup entirely — a destructive merge must
 * never run without a restore point. A dedup error after a good snapshot is logged, not thrown,
 * so it can't abort the rest of the pass; the snapshot is retained for manual restore.
 */
function runGraphHygiene(
  db: Database.Database,
  store: SemanticStore,
  sink: SQLiteConsolidationSink,
  config: EngineConfig,
  clock: Clock,
  log: (msg: string) => void,
): void {
  const SNAP_KEEP = 5;
  const DEDUP_THRESHOLD = 0.88; // Phase 25 D-01 proven default (cosine within same-value bucket)
  const base = basename(config.dbPath);

  // 1. Consistent pre-dedup snapshot (WAL-safe, compacted). Skip dedup if this fails.
  try {
    const dir = join(dirname(config.dbPath), 'snapshots');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const stamp = new Date(clock.nowMs()).toISOString().replace(/[:.]/g, '-');
    const snapPath = join(dir, `${base}.${stamp}.bak`);
    db.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`);
    log(`graph-hygiene: snapshot -> ${snapPath}`);
    // Prune oldest beyond SNAP_KEEP (lexicographic sort == chronological for ISO stamps).
    const snaps = readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.`) && f.endsWith('.bak'))
      .sort();
    for (const old of snaps.slice(0, Math.max(0, snaps.length - SNAP_KEEP))) {
      try { unlinkSync(join(dir, old)); } catch { /* best-effort prune */ }
    }
  } catch (err) {
    log(`graph-hygiene: snapshot FAILED (${String(err).slice(0, 80)}) — SKIPPING dedup (no rollback point)`);
    return;
  }

  // 2. Same-value entity + fact dedup (FK-safe rewire→tombstone; never deletes; idempotent).
  try {
    const ent = new EntityDedup(db, store, sink, clock, config).run({ threshold: DEDUP_THRESHOLD, dryRun: false });
    log(`graph-hygiene: entity dedup — ${ent.mergedClusters} clusters merged, ${ent.tombstoned} tombstoned`);
    const fct = new FactDedup(db, store, sink, clock, config).run({ threshold: DEDUP_THRESHOLD, dryRun: false });
    log(`graph-hygiene: fact dedup — ${fct.mergedClusters} clusters merged, ${fct.tombstoned} tombstoned`);
  } catch (err) {
    log(`graph-hygiene: dedup error (${String(err).slice(0, 120)}) — snapshot retained for restore`);
  }
}

export async function runConsolidation(
  db: Database.Database,
  dbPath: string,
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void,
  opts?: { replayExtract?: (content: string) => ExtractedClaim[] },
): Promise<void> {
  // ── 4. Instantiate the full Consolidator dependency graph ─────────────────
  // Base config: settings.json merged with env overrides (D-05 / D-06).
  // env wins over settings.json wins over preset wins over DEFAULT_CONFIG.
  const config = loadMergedConfig(dbPath, env);
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

  // D-11 (Phase 39.2): DocGraphDeriver — LLM-free, wipe-and-rebuild, sole owner of
  // doc_reference + doc_containment edges. Runs in Phase C after corpusPromoter.promote()
  // (stubs + subject-schema-ids meta must exist first). Zero new deps — uses (db, store, config, clock).
  const docGraphDeriver = new DocGraphDeriver(db, store, config, realClock);

  // Plan 39.1-03 (D-05 Stage-2 integration): SubjectPromoter — exhaust-gate subject promotion.
  // Runs AFTER consolidate() (schema induction complete — Pitfall 6) and BEFORE
  // generateCorpusDocs (so new hub/subject stubs exist before the fill loop).
  // Uses inducerProvider (judge-tier) for the Stage-2 subject-proposal LLM call.
  // corpusSubjectDriftThreshold env override read at the CORPUS-06 call site below.
  const subjectPromoter = new SubjectPromoter(db, store, realClock, inducerProvider, {
    corpusSubjectDriftThreshold: parseInt(env['RECENSE_CORPUS_SUBJECT_DRIFT_THRESHOLD'] ?? '3', 10) || 3,
  });

  // D-07 (REFLECT-01, Plan 38-02): InsightReflector — synthesizes one judge-tier insight node
  // per qualifying stale schema cluster. Runs in Phase C after corpusPromoter.promote() and
  // before runEvictionSweep() so dissolved-cluster tombstoned insights are swept the same pass.
  // Reuses the judge-tier provider (inducerProvider) which already has generateConfig: judgeConfig.
  const insightReflector = new InsightReflector(db, store, inducerProvider, config, realClock, {
    massFloorHigh: config.reflectMassFloorHigh,
    massFloorLow: config.reflectMassFloorLow,
    confidenceCeiling: config.reflectConfidenceCeiling,
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
    insightReflector,
    docGraphDeriver,  // D-11/D-20 (Phase 39.2): sole doc-edge owner, runs after promote()
  );

  // ── 5. Run the sleep pass ──────────────────────────────────────────────────
  // Provenance high-water mark so Phase-19 viz lighting (below) can scope exactly
  // the nodes THIS pass touches — consolidation_event.ts (ms) bounds the pass.
  const passStartTs = realClock.nowMs();

  // Phase 37 (TYPED-02): ensure the 12 predicate-gloss embeddings are stored ONCE so the
  // online recall typed-path can activate (matchPredicate returns null until they exist).
  // Idempotent — skip if already present; fail-soft so an embed hiccup never aborts the pass.
  if (!loadGlossEmbeddings(store)) {
    try {
      await embedAndStoreGlosses(consolidatorProvider, store);
      log('gloss embeddings: stored 12 predicate glosses (typed-recall path now active)');
    } catch (err) {
      log(`gloss embeddings: skipped (embed failed: ${String(err).slice(0, 80)}) — recall stays on neighborhood path`);
    }
  }

  // EVAL-04 two-tier observability: the escalation counter is process-global. Each hourly
  // sleep pass is a FRESH process (counter starts at 0), so the canary log below reports this
  // pass for free — NO reset here. (A reset would corrupt the EVAL-02 harness, which drives
  // many runConsolidation passes in one long-lived process and accumulates the counter.)
  await consolidator.consolidate();

  // CORPUS-06: Offline corpus doc generation — fill empty schema-anchored stub docs
  // with prose NOW (while the sleep pass holds its lock) so the online /doc click
  // never pays the ~42s LLM cost. Runs AFTER consolidate() so CorpusPromoter (Phase C
  // inside the consolidator) has already created any new stubs this pass produced.
  //
  // Gate: config.corpusGen — resolved from settings.json (D-06) with env still winning (D-05).
  //   RECENSE_CORPUS_GEN=0  env var → corpusGen=false (env wins; founder's sleep.env unbroken)
  //   settings.json lite preset     → corpusGen=false (when no env var set)
  //   default / full preset         → corpusGen=true
  if (config.corpusGen) {
    // Plan 32-03 D-05: Consume pending-corpus-promotion:<scope> markers BEFORE generateCorpusDocs
    // so that force-promoted scope stubs (landing + chapters) are filled in the SAME pass.
    // Crash-safe order: promoteScope first, deleteMeta only on success (T-32-MARK).
    // Best-effort: a per-marker failure logs + leaves the marker for retry; does NOT abort.
    // corpusPromoter is the same instance built above.
    try {
      await consumePendingCorpusMarkers(db, store, corpusPromoter, log);
    } catch (err) {
      // consumePendingCorpusMarkers already handles per-marker errors internally.
      // This outer catch is a final safety net — should never fire in practice.
      log(`CORPUS-06: consumePendingCorpusMarkers threw unexpectedly: ${err}`);
    }

    // Plan 39.1-03 (D-05 Stage-2): Run subject promotion AFTER consolidate() (so schema
    // induction for this pass is complete — Pitfall 6) and BEFORE generateCorpusDocs (so
    // the new hub/subject stubs exist before the fill loop runs).
    //
    // scope = cwdToScope() resolves the active project scope for this pass.
    // Best-effort: a promoter failure MUST NOT abort the sleep pass — log and continue.
    // T-39.1-09: exhaust-gate failure is non-fatal; consolidation + hygiene still complete.
    const scope = cwdToScope(process.cwd());
    try {
      const subjectResult = await subjectPromoter.promoteSubjects(scope);
      log(
        `EXHAUST-GATE: proposed=${subjectResult.proposed.length} ` +
        `created=${subjectResult.created} refreshQueued=${subjectResult.refreshQueued.length} ` +
        `scope=${scope}`,
      );
    } catch (err) {
      log(`EXHAUST-GATE: subjectPromoter threw (non-fatal): ${err}`);
    }

    // Plan 39.1-03 (D-07): Drain pending-subject-doc-gen markers written by generateCorpusDocs
    // when overflow stubs were deferred last pass. These markers identify hub/subject stubs
    // that exceeded the maxDocs cap — they should be included in THIS pass's generation loop.
    //
    // The markers themselves are NOT consumed here — they are written and cleared by
    // generateCorpusDocs itself (crash-safe: cleared only on successful generation of the
    // matching stub). This drain step is therefore a no-op at the SQL level; the pending
    // markers are automatically picked up by generateCorpusDocs below because the corresponding
    // stubs are still empty (length(value)=0) and the marker-write is idempotent ('1').
    //
    // For observability: log the pending count before generation so operators can see the queue.
    try {
      const stmtCountPending = db.prepare(
        "SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'pending-subject-doc-gen:%'"
      );
      const pendingRow = stmtCountPending.get() as { n: number };
      if (pendingRow.n > 0) {
        log(`EXHAUST-GATE: ${pendingRow.n} deferred subject/hub stubs in marker queue (will drain this pass)`);
      }
    } catch (err) {
      log(`EXHAUST-GATE: pending-marker count failed (non-fatal): ${err}`);
    }

    const maxDocs = config.corpusGenMax;
    // D-09: tag corpus-gen LLM calls as 'corpus_gen' so the ledger breaks them out
    // from default Sonnet 'judge' calls. Reset in finally so a mid-generation error
    // cannot mistag later calls (T-44-10).
    setHeadlessFeature('corpus_gen');
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
    } finally {
      setHeadlessFeature(null);
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

  // EVAL-04 two-tier judge canary: log the real escalation rate this pass saw, so production
  // confirms the cost projection and surfaces any drift (e.g. Haiku over-flagging → escalation
  // spikes → savings erode). Only logs when the lever is active.
  if (config.twoTierJudge) {
    const tt = getTwoTierStats();
    const rate = tt.cheap_calls > 0 ? Math.round((100 * tt.escalations) / tt.cheap_calls) : 0;
    log(`two-tier judge: ${tt.cheap_calls} claims triaged, ${tt.escalations} escalated to Sonnet (${rate}% escalation)`);
  }

  // Phase 25 go-nightly (opt-in): pre-dedup snapshot + same-value entity/fact dedup.
  // Dark-default OFF; flip RECENSE_SLEEP_DEDUP=1 in sleep.env after watching one pass.
  if (env['RECENSE_SLEEP_DEDUP'] === '1') {
    runGraphHygiene(db, store, sink, config, realClock, log);
  }

  // Phase 41 (PERF-01, D-05/D-06): rebuild + persist the exact vector index sidecar.
  // Placed AFTER consolidation + graph hygiene so it reflects the LAST completed pass
  // (D-05) — all build cost stays offline. The cold online callers (SessionStart inject,
  // recall-cli, ambient-recall) read this ready artifact instead of re-marshaling ~10k
  // embedding BLOB rows per invocation (the D-06 cold win). It is a DERIVED cache: a build
  // failure is logged, NEVER thrown, and never aborts the pass (mirrors the graph-hygiene
  // error posture). The offline consolidator is NOT repointed at it — its retriever stays
  // brute-force (D-07), running mid-pass before this end-of-pass index exists.
  try {
    const indexPath = vectorIndexPath(config.dbPath);
    const n = buildVectorIndex(db, indexPath);
    log(`index: rebuilt ${n} vectors -> ${indexPath}`);
  } catch (err) {
    log(`index: rebuild FAILED (${String(err).slice(0, 120)}) — derived cache, pass continues (graph is source of truth)`);
  }

  log('Sleep pass complete');
}
