/**
 * Consolidator — offline sleep pass, the single graph writer (CONSOL-03, spec §8).
 *
 * Implements the three-phase async-before-sync structure (T-02-ASYNC, Pitfall 1):
 *   Phase A: ALL async work (re-embed dirty, extract claims, embed queries, nominate,
 *            classify via D-17 fast path / UPDATE-02 safe-direction / judge). Results
 *            collected into plain arrays. NO `await` inside any db.transaction.
 *   Phase B: Synchronous DB writes. One db.transaction per episode applies every
 *            decision then calls episodes.markConsolidated() — atomic, so a
 *            killed/restarted pass never double-applies a strength increment (CONSOL-02).
 *   Phase C: Re-embed nodes dirtied by this pass (newly appended), then
 *            runEvictionSweep() once.
 *
 * All node/episode writes route EXCLUSIVELY through owned primitives
 * (upsertNode / setEmbedding / strengthen / tombstone / recordContradiction /
 *  markConsolidated / upsertEdge). No raw SQL on node or episode here (CONSOL-03).
 *
 * Threat mitigations:
 *  - T-02-ASYNC: no `await` inside any db.transaction (grep gate + atomicity test).
 *  - T-02-WRITE: all writes go through owned primitives (grep gate).
 *  - T-02-DOUBLE: consolidated=1 set inside per-episode transaction (resume test).
 *  - T-02-SELFCONF: confirm passes inherited episode origin into strengthen() — the
 *    origin guard in StrengthDecayManager blocks `inferred` (inferred-echo test).
 *  - T-02-SELFCONF2: contradict HOLD only records provenance-eligible episodes
 *    (claimOrigin !== 'inferred' && source_inference_id === null); inferred echoes
 *    cannot inflate the force-destabilization count (D-19, Plan 03).
 *  - T-02-OSC: D-20 oscillation guard escalates a flip-back reconcile to append-new
 *    before tombstone-cycling; prev_value is carried explicitly on the new node so the
 *    guard is functional in the real flow even across tombstone-always boundaries.
 */
import Database, { type Statement } from 'better-sqlite3';
import { realClock, type Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import { setHeadlessFeature } from '../model/claude-headless-client';
import type { EpisodicStore } from '../db/episode-store';
import type { SemanticStore } from '../db/semantic-store';
import type { StrengthDecayManager } from '../strength/decay';
import type { CandidateRetriever } from '../retrieval/topk';
import { cosineSimF32, ftsQueryFromText } from '../retrieval/topk';
import type { JudgeRelation } from '../model/judge';
import type { ModelProvider } from '../model/provider';
import type { ExtractedClaim, ActionType, IntentStatus, IntentConfidence } from '../model/claim-extractor';
import { extractClaimsWithChunking, parseMergedExtraction, TYPED_EXTRACTION_PROMPT, EXTRACTION_MAX_TOKENS } from '../model/claim-extractor';
import { parseTriples, type Triple } from '../model/typed-predicates';
import { promptForSource, isTypedExtractionSource } from '../source/extraction-prompts';
import type { Origin, PendingContradiction, EpisodeRow, EpisodeRole } from '../lib/types';
import { newId } from '../lib/hash';
import { normalizeValue } from './normalize';
import { EntityResolver } from './entity-resolution';
import { StatusDrift, isEmissionEligible } from './status-drift';
import { routeContradiction, isOscillation, countDistinctProvenance } from './update-decision';
import { orderEpisodesForConsolidation } from './episode-order';
import type { SchemaInducer } from './schema-induction';
import { NoopSchemaRelationDeriver } from './schema-relations';
import type { SchemaRelationDeriver } from './schema-relations';
import { NoopConsolidationSink, type ConsolidationSink, type ConsolidationEventType } from './sink';
import {
  BELIEF_CHANGE_FIELD_STATUS,
  NoopActionProposalSink,
  type ActionProposalSink,
} from './action-proposal-sink';
import { NoopCorpusPromoter } from './corpus-promoter';
import type { CorpusPromoter } from './corpus-promoter';
import { NoopInsightReflector } from './insight-reflector';
import type { InsightReflector } from './insight-reflector';
import { NoopDocGraphDeriver } from './doc-graph-deriver';
import type { DocGraphDeriver } from './doc-graph-deriver';

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Defensive JSON parse for the pending_contradictions column (L-4).
 * Returns [] on any parse failure so a corrupt row does not abort the consolidation pass.
 */
function safeParseContradictions(json: string): PendingContradiction[] {
  try {
    return JSON.parse(json) as PendingContradiction[];
  } catch {
    return [];
  }
}

/**
 * Eligibility predicate for claim-extraction prefetch (Phase A optimization).
 *
 * Returns true when an episode should have its claims extracted. Duplicates the
 * two cheap sync guards that precede the extract call in the ordered per-episode loop
 * so both sites cannot drift:
 *   - CONSOL-01: skip below salience threshold (per-source override or per-role default)
 *   - WR-01: inferred-origin episodes never produce graph effects (hard structural guard)
 *
 * Echo detection (D-44/D-45) is async and cannot be evaluated here; episodes that
 * later fail echo detection waste one prefetched extraction — acceptable in practice
 * because echo only triggers when recent inferred episodes exist.
 */
function isEligibleForExtraction(episode: EpisodeRow, config: EngineConfig): boolean {
  const skipThreshold =
    config.salience.consolSkipThresholdBySource[episode.source] ??
    (episode.role === 'assistant'
      ? config.consolSkipThresholdAssistant
      : config.consolSkipThreshold);
  if (episode.salience < skipThreshold && episode.hard_keep === 0) {
    return false;
  }
  if (episode.origin === 'inferred') {
    return false;
  }
  // ACT-03 / D-43: audit episodes (source='hitl') are never belief input.
  // Excluding them from prefetch prevents generate() from being called on audit content,
  // closing the self-confirmation hole (never let inferred/retrieved output strengthen a fact).
  if (episode.source === 'hitl') {
    return false;
  }
  return true;
}

/** Concurrency for the Phase A extraction prefetch pool. */
const PREFETCH_CONCURRENCY = 4;

/**
 * Episode batch size for the chunked prefetch loop (FIX-STALL-01).
 *
 * Problem: the one-shot prefetchExtractions() awaited ALL N eligible episodes before
 * the per-episode loop ran. With N=308, 4-concurrent claude-headless workers at ~30s/episode,
 * the prefetch took ~38 min — exceeding LOCK_STALE_MS (30 min). The hourly launchd job
 * reclaimed the stale lock and relaunched with the same unchanged backlog, looping forever
 * (markConsolidated was never called).
 *
 * Fix: process episodes in batches of PREFETCH_EPISODE_BATCH_SIZE. Each batch:
 *   1. prefetchExtractions(batch) → ~20 × 30s / 4 concurrent = ~2.5 min
 *   2. per-episode loop for the batch → calls markConsolidated N times, checkpointing progress
 *   3. advance to next batch
 *
 * At 20 episodes/batch, each batch prefetch takes ~2.5 min. A 300-episode backlog needs 15
 * batches ≈ 37 min total, but each batch checkpoints 20 committed episodes before the next
 * starts — so even if the lock stales mid-run, the next pass starts with a smaller backlog
 * rather than repeating from zero.
 *
 * Tunable: set RECENSE_PREFETCH_EPISODE_BATCH_SIZE env to override. Constraints:
 *   - Too small → many batches, each with its own reembedDirty-like overhead (negligible).
 *   - Too large → approaches the old one-shot problem. Keep batch × 30s / 4 < 20 min.
 *   - Default 20: 20 × 30s / 4 = 2.5 min/batch (13% of the 30-min stale window).
 */
const PREFETCH_EPISODE_BATCH_SIZE_DEFAULT = 20;
function getPrefetchBatchSize(): number {
  const raw = process.env['RECENSE_PREFETCH_EPISODE_BATCH_SIZE'];
  if (!raw) return PREFETCH_EPISODE_BATCH_SIZE_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : PREFETCH_EPISODE_BATCH_SIZE_DEFAULT;
}

// ---------------------------------------------------------------------------
// Internal types — collect Phase A results into plain arrays before any DB write
// ---------------------------------------------------------------------------

interface ClaimDecision {
  claimValue: string;
  claimType: string;
  claimOrigin: Origin;
  relation: JudgeRelation;
  bestCandidateId: string | null;
  episodeSessionId: string;
  /**
   * The episode's source-asserted event time (EMAIL-04), or `null` when the source asserts
   * none. Consumed by the drift layer's `event_ts` staleness guard (DRIFT-04 / D-11b); `null`
   * makes the guard abstain into pre-Phase-65 behavior rather than guess. This is NOT
   * `episode.ts` (ingest time) — the two must never be conflated: `ts` is when recense LEARNED
   * the episode, `event_ts` is when the source says it happened. Required (not optional) so a
   * fill site that omits it is a compile error — do not "helpfully" make this optional.
   */
  episodeEventTs: number | null;
  /**
   * The episode's source adapter name. Consumed by the per-source force-destabilization
   * threshold lookup (D-16, keyed by config's per-source contradiction-count override map).
   * Deliberately the raw source string rather than a boolean (a `gmailSourced` local already
   * exists at the hoisted intent-field gate for that purpose) because that override map is
   * keyed by arbitrary source names. Required (not optional) so a fill site that omits it is
   * a compile error.
   */
  episodeSource: string;
  /** Judge-emitted PE severity [0,1]; meaningful only for 'contradict' verdicts (D-15). */
  magnitude: number;
  /** Episode's source_inference_id — null means provenance-eligible for D-19 recording. */
  episodeSourceInferenceId: string | null;
  /** Episode role — assistant-role confirms must NOT strengthen (C-2 self-confirmation guard). */
  episodeRole: EpisodeRole;
  /**
   * M2: ALL candidate ids (from the judge candidate set) that the judge listed as contradicted.
   * Filtered to the exact candidate set passed to that judge call before routing (T-UE6-02).
   * Empty for fast-path, auto-unrelated, and non-contradict verdicts.
   */
  contradictedIds: string[];
  /**
   * TEMP-02: temporal annotation from the extracted claim.
   * undefined when the claim had no due_at (backward-compat — no node_temporal row written).
   */
  claimDueAt?: string;
  /** TEMP-02: action type; undefined when claimDueAt is undefined. */
  claimActionType?: ActionType;
  /**
   * CLASSIFY-02: intent classification, threaded from ExtractedClaim.intent_status.
   * All three claimIntent* fields present together or all absent (D-05) — mirrors the
   * all-or-nothing gate already enforced in claim-extractor.ts's parseClaimsFromArray.
   * D-10 / WR-01 (Phase 64): populated for `episode.source === 'gmail'` episodes ONLY,
   * enforced by the hoisted `gmailSourced` gate at all three claim-side fill sites. Absence
   * for any other source is structural — the extraction model has no channel to smuggle
   * these fields onto a non-gmail decision, regardless of prompt-injection or model drift.
   * INERT this phase (D-08): nothing consumes these fields and no DB row is written from
   * them. Phase 64 resolves claimIntentEntity against the canonical entity list, Phase 65
   * maps claimIntentConfidence onto PE magnitude, Phase 66 persists via action_proposal.
   */
  claimIntentStatus?: IntentStatus;
  /** CLASSIFY-02: see claimIntentStatus JSDoc — all-or-nothing with it (D-05). */
  claimIntentEntity?: string;
  /** CLASSIFY-02: see claimIntentStatus JSDoc — all-or-nothing with it (D-05). */
  claimIntentConfidence?: IntentConfidence;
  /**
   * RESOLVE-03 (Phase 64): the recense graph node id this decision's `claimIntentEntity`
   * descriptor resolved to, via `EntityResolver.resolve` (src/consolidation/entity-resolution.ts).
   * All-or-nothing with `claimResolvedEntityDescriptor` (D-07): both present together or both
   * absent — absence means the resolver abstained (no-candidates / below-floor / margin-too-close)
   * or the decision never carried a `claimIntentEntity` to resolve in the first place. This id is
   * recense-INTERNAL lineage only — it is NOT a stable foreign key across belief correction
   * (tombstone-and-mint-new can retire the node this id points at); Phase 66's contract docs own
   * stating that caveat to consumers. The raw `claimIntentEntity` above stays untouched beside
   * this field — it is the resolution INPUT, never overwritten by the output. INERT this phase
   * (D-09): nothing consumes this field and no DB row is written from it — Phase 65 is the first
   * consumer.
   */
  claimResolvedEntityId?: string;
  /**
   * RESOLVE-03 (Phase 64): the resolved node's own canonical `value` string, verbatim, in
   * recense's vocabulary (D-08) — NEVER a consumer id and never a normalized/prettified form;
   * recense has zero knowledge of any consumer's schema. All-or-nothing with
   * `claimResolvedEntityId` (D-07); see that field's JSDoc for the shared contract. INERT this
   * phase (D-09).
   */
  claimResolvedEntityDescriptor?: string;
  /**
   * TEMP-02: Calendar source event id parsed from provenance header (gcal episodes only).
   * null when source !== 'gcal' or the · Event: token is absent.
   */
  gcalSourceEventId?: string | null;
  /**
   * TEMP-02: RRULE string from provenance header (recurring gcal masters only).
   * null for one-off gcal events and all non-gcal sources (D-04).
   */
  gcalRecurrenceRule?: string | null;
  /**
   * DEDUP-01: precomputed claim embedding vector for embed-on-mint.
   * Set from claimVecs[claimIdx] at decision-fill time so applyDecision can stamp
   * the embedding synchronously inside the Phase B transaction without an API call.
   * Undefined for fast-path confirms (no mint) and when claimVec is absent (guard).
   */
  claimVec?: Float32Array;
}

/** Claim that escalated to provider.judge — carries its slot index for ordered reassembly. */
interface PendingJudge {
  slotIdx: number;
  claimValue: string;
  claimType: string;
  candidates: Array<{ id: string; value: string }>;
  /** TEMP-02: temporal fields carried through to the ClaimDecision after verdict. */
  claimDueAt?: string;
  claimActionType?: ActionType;
  /** CLASSIFY-02: intent fields carried through to the ClaimDecision after verdict (D-05). */
  claimIntentStatus?: IntentStatus;
  claimIntentEntity?: string;
  claimIntentConfidence?: IntentConfidence;
}

// ---------------------------------------------------------------------------
// Consolidator
// ---------------------------------------------------------------------------

export class Consolidator {
  private readonly db: Database.Database;
  private readonly episodes: EpisodicStore;
  private readonly store: SemanticStore;
  private readonly strength: StrengthDecayManager;
  private readonly retriever: CandidateRetriever;
  private readonly provider: ModelProvider;
  private readonly inducer: SchemaInducer;
  private readonly deriver: SchemaRelationDeriver | NoopSchemaRelationDeriver;
  private readonly corpusPromoter: CorpusPromoter | NoopCorpusPromoter;
  private readonly insightReflector: InsightReflector | NoopInsightReflector;
  private readonly docGraphDeriver: DocGraphDeriver | NoopDocGraphDeriver;
  private readonly config: EngineConfig;
  private readonly clock: Clock;
  private readonly sink: ConsolidationSink;
  // EMIT-01 (Phase 66): domain-neutral proposal emit seam. Defaults to Noop — two independent
  // barriers with actionProposalSinkEnabled (T-66-12): even if this param IS injected as a real
  // sink, maybeEmitProposal's own isEmissionEligible + all-or-nothing gates still apply.
  private readonly proposalSink: ActionProposalSink;
  private readonly log: (msg: string) => void;
  // RESOLVE-01/02/03 (Phase 64): standalone, LLM-free entity resolver. Constructed once here
  // (not per episode) — mirrors why entity-resolution.ts prepares its own statements in its
  // constructor rather than per resolve() call.
  private readonly entityResolver: EntityResolver;
  // DRIFT-01..04 (Phase 65): standalone, LLM-free, read-only status-drift decision module.
  // Constructed once here (not per episode), mirroring entityResolver above. Consulted
  // structurally BEFORE both routeContradiction call sites (never inside them) — see the
  // primary contradict branch and applySecondaryContradiction.
  private readonly statusDrift: StatusDrift;
  // DRIFT-05 (Plan 65-10 consumer): observability-only drift outcome counters — never gate
  // behavior. Promoted to instance fields (rather than consolidate()-method-scope `let`s,
  // Phase 46/64's pattern) because applyDecision and applySecondaryContradiction are separate
  // private methods and cannot close over a method-local variable. Reset at the START of
  // consolidate() so counts are per-pass, not cumulative across the process lifetime.
  private driftEvaluations = 0;
  private driftDamped = 0;
  private driftStaleDropped = 0;
  private driftEventTsUnknown = 0;
  // EMIT-66 (Phase 66): count of proposals actually emitted this pass (observability only,
  // mirrors the DRIFT-05 counter precedent above — never gates behavior).
  private proposalsEmitted = 0;

  // M1: prepared statements for entity-anchored candidate expansion (T-01-SQL).
  // Compiled once in the constructor; sync reads only (T-02-ASYNC — no await, never inside
  // a db.transaction). Mirrors the B2 stmtStaleEntityIds precedent in engine.ts:140-158.
  private readonly stmtProvenanceSiblingFacts: Statement<[string], { id: string; value: string }>;
  private readonly stmtLiveNodesForLinks: Statement<[], { id: string; value: string }>;
  // Phase 46 (D-03): BM25 lexical candidate statement — compiled once (T-01-SQL).
  // Mirrors CandidateRetriever.stmtBm25 SQL exactly; lives here because stmtBm25 is private.
  // bm25() returns negative-is-better; ORDER BY rank ASC = best-first.
  // JOIN node excludes tombstoned rows. MATCH arg MUST be ftsQueryFromText() output (T-17-02-T).
  // Sync Phase A read — never inside db.transaction (T-02-ASYNC).
  private readonly stmtBm25Candidates: Database.Statement;

  // Phase 37 Fix-2: typed-triple entity resolution lives in SemanticStore.resolveEntityByName
  // (ranked exact → entity-type → shortest-containing). The old stmtFindNodeByName used
  // `LIKE '%name%' LIMIT 1` with no ORDER BY and minted garbage edges on the live graph
  // (e.g. "OpenAI" resolved to the node OPENAI_API_KEY). Resolution is now via this.store.

  constructor(
    db: Database.Database,
    episodes: EpisodicStore,
    store: SemanticStore,
    strength: StrengthDecayManager,
    retriever: CandidateRetriever,
    provider: ModelProvider,
    inducer: SchemaInducer,
    config: EngineConfig,
    clock: Clock = realClock,
    sink: ConsolidationSink = new NoopConsolidationSink(),
    log: (msg: string) => void = () => {},
    deriver: SchemaRelationDeriver | NoopSchemaRelationDeriver = new NoopSchemaRelationDeriver(),
    corpusPromoter: CorpusPromoter | NoopCorpusPromoter = new NoopCorpusPromoter(),
    insightReflector: InsightReflector | NoopInsightReflector = new NoopInsightReflector(),
    // D-11/D-20 (Phase 39.2): DocGraphDeriver — sole owner of doc_reference + doc_containment edges.
    // Defaulted to Noop so existing Consolidator constructions (tests) are unaffected.
    docGraphDeriver: DocGraphDeriver | NoopDocGraphDeriver = new NoopDocGraphDeriver(),
    // EMIT-01 (Phase 66): trailing param, Noop default — the ~10 existing
    // `new Consolidator(...)` call sites across tests keep compiling unchanged.
    proposalSink: ActionProposalSink = new NoopActionProposalSink(),
  ) {
    this.db = db;
    this.episodes = episodes;
    this.store = store;
    this.strength = strength;
    this.retriever = retriever;
    this.provider = provider;
    this.inducer = inducer;
    this.deriver = deriver;
    this.corpusPromoter = corpusPromoter;
    this.insightReflector = insightReflector;
    this.docGraphDeriver = docGraphDeriver;
    this.config = config;
    this.clock = clock;
    this.sink = sink;
    this.proposalSink = proposalSink;
    this.log = log;
    // RESOLVE-01/02/03 (Phase 64, D-04): constructed with (db, store, config) — no
    // ModelProvider — the type-level guarantee that resolution can never call an LLM.
    this.entityResolver = new EntityResolver(db, store, config);
    // DRIFT-01..04 (Phase 65): constructed with (db, config) — no ModelProvider, no
    // SemanticStore — the type-level guarantee that drift evaluation can never call an LLM.
    this.statusDrift = new StatusDrift(db, config);

    // M1: compile prepared statements once (T-01-SQL).
    // stmtProvenanceSiblingFacts: given an entity node id, return DISTINCT live fact siblings
    // (nodes of type='fact' sharing >=1 consolidation_event episode with the entity).
    // Indexed by idx_consolidation_event_node / idx_consolidation_event_episode (v5 migration).
    this.stmtProvenanceSiblingFacts = db.prepare(`
      SELECT DISTINCT f.id, f.value
      FROM consolidation_event a
      JOIN consolidation_event b ON a.episode_id = b.episode_id
      JOIN node f ON b.node_id = f.id
      WHERE a.node_id = ? AND f.type = 'fact' AND f.tombstoned = 0
    `);
    // stmtLiveNodesForLinks: all live nodes for link-anchor containment matching.
    // Small-N full scan (~1.5k nodes at target scale); link matching done in JS via
    // normalizeValue containment (T-UE6-03: sub-ms at target volume).
    this.stmtLiveNodesForLinks = db.prepare(
      `SELECT id, value FROM node WHERE tombstoned = 0`
    );
    // Phase 46 (D-03): BM25 lexical candidate statement.
    // SQL matches CandidateRetriever.stmtBm25 (topk.ts:301-306) exactly.
    this.stmtBm25Candidates = db.prepare(`
      SELECT f.node_id AS id
      FROM node_fts f JOIN node n ON n.id = f.node_id AND n.tombstoned = 0
      WHERE node_fts MATCH ?
      ORDER BY rank LIMIT ?
    `);

  }

  // ── Private helper: prefetch claim extractions in parallel ──────────────

  /**
   * Phase A optimization: extract claims for all eligible episodes through a
   * bounded pool (PREFETCH_CONCURRENCY=4) BEFORE the ordered per-episode loop.
   *
   * Claim extraction depends ONLY on episode content/source/role — never on graph
   * state — so it is safe to run out-of-order relative to other episodes.
   *
   * Results are keyed by episode.id. A failed extraction stores the Error so the
   * ordered loop can rethrow it, quarantining that episode with H-2 semantics.
   * Episodes that fail echo detection later waste one prefetched extraction (acceptable).
   *
   * T-02-ASYNC and CONSOL-02 are unaffected: all writes still happen in the ordered
   * per-episode loop's synchronous Phase B transaction.
   */
  private async prefetchExtractions(episodes: EpisodeRow[]): Promise<Map<string, { claims: ExtractedClaim[]; triples: Triple[] } | Error>> {
    const results = new Map<string, { claims: ExtractedClaim[]; triples: Triple[] } | Error>();
    let idx = 0;

    // D-02/D-03 (Phase 37): typed extraction mode for D-02-eligible sources.
    // Activation: RECENSE_TYPED_EXTRACTION_MODE=merged OR =separate.
    // When unset (default), typed extraction is disabled — existing behavior preserved.
    // 'merged': MERGED_EXTRACTION_PROMPT — one provider.generate call emits {facts, triples};
    //   parseMergedExtraction routes facts → claims, triples → typed edges.
    // 'separate': bare-array facts via existing extractClaimsWithChunking path PLUS a
    //   second TYPED_EXTRACTION_PROMPT generate call for triples (D-03 regression fallback).
    // Source eligibility: obsidian/claude-code/default only (isTypedExtractionSource=true).
    // gmail/gcal/granola/etc. always use the bare-array path — D-02 scope (RESEARCH OQ2).
    const rawTypedMode = process.env['RECENSE_TYPED_EXTRACTION_MODE'];
    const typedMode = rawTypedMode === 'merged' ? 'merged'
      : rawTypedMode === 'separate' ? 'separate'
      : 'off'; // default: typed extraction disabled (backward-compatible)

    const workerFn = async (): Promise<void> => {
      while (idx < episodes.length) {
        const episode = episodes[idx++]!;
        try {
          const promptPrefix = promptForSource(episode.source) + episode.role + '\n\nDocument content:\n';
          // D-02 scope: only obsidian/claude-code/default sources participate in typed extraction.
          const isTypedSource = isTypedExtractionSource(episode.source);

          let claims: ExtractedClaim[];
          let triples: Triple[];

          if (isTypedSource && typedMode === 'merged') {
            // D-02: one generate call emits {facts, triples}; route via parseMergedExtraction.
            // extractClaimsWithChunking is intentionally bypassed: the merged JSON object must
            // not be split across chunks. Episodes are already capped at maxContentBytes (~8 KB)
            // by EpisodicStore, so a single generate call is safe at EXTRACTION_MAX_TOKENS.
            const rawText = await this.provider.generate(promptPrefix + episode.content, {
              maxTokens: EXTRACTION_MAX_TOKENS,
            });
            const parsed = parseMergedExtraction(rawText);
            claims = parsed.claims;
            triples = parsed.triples;
          } else if (isTypedSource && typedMode === 'separate') {
            // D-03 separate fallback: facts via existing extractClaimsWithChunking path,
            // THEN a second dedicated TYPED_EXTRACTION_PROMPT call for triples.
            claims = await extractClaimsWithChunking(
              this.provider,
              promptPrefix,
              episode.content,
            );
            const tripleText = await this.provider.generate(
              TYPED_EXTRACTION_PROMPT + episode.content,
              { maxTokens: EXTRACTION_MAX_TOKENS },
            );
            triples = parseTriples(tripleText);
          } else {
            // typedMode === 'off' (default) OR non-typed source: bare-array path, no triples.
            // Preserves existing behavior when RECENSE_TYPED_EXTRACTION_MODE is not set.
            claims = await extractClaimsWithChunking(
              this.provider,
              promptPrefix,
              episode.content,
            );
            triples = [];
          }

          results.set(episode.id, { claims, triples });
        } catch (err) {
          results.set(episode.id, err instanceof Error ? err : new Error(String(err)));
        }
      }
    };

    const workers: Promise<void>[] = [];
    for (let i = 0; i < Math.min(PREFETCH_CONCURRENCY, episodes.length); i++) {
      workers.push(workerFn());
    }
    await Promise.all(workers);
    return results;
  }

  // ── Private helper: re-embed dirty nodes in batch ───────────────────────

  /**
   * SELECT all nodes WHERE embedded_hash IS NULL, batch-embed their values,
   * then call store.setEmbedding() for each. The ONLY embedding writer path.
   * After this runs, newly appended/changed nodes are nominable via topk.
   */
  private async reembedDirty(): Promise<void> {
    // L-1: capture value_hash alongside id+value so we can guard against stale-vector
    // race in setEmbedding. Between this SELECT and the setEmbedding call, another writer
    // (e.g. a concurrent reconcile) could update the node's value, making the freshly-
    // computed embedding stale. Passing expectedValueHash lets setEmbedding no-op if that
    // happens — the node stays dirty (embedded_hash IS NULL) and will be re-embedded next pass.
    // FIX-EMBED-POISON: exclude empty-value stubs and tombstoned nodes. Corpus
    // promotion mints doc stubs with value='' (prose generated lazily on first
    // access); embedding an empty string makes OpenAI 400 the whole atomic batch
    // (`input[N] cannot be an empty string`), aborting the entire sleep pass here —
    // before any episode is consolidated — and stalling indefinitely because the
    // poison stub stays dirty. Empty stubs are FTS-suppressed and not meant to embed
    // until they have prose; tombstoned nodes are dead.
    const dirtyRows = this.db
      .prepare(`SELECT id, value, value_hash FROM node
                WHERE embedded_hash IS NULL AND TRIM(value) <> '' AND tombstoned = 0`)
      .all() as Array<{ id: string; value: string; value_hash: string }>;

    if (dirtyRows.length === 0) return;

    const values = dirtyRows.map(r => r.value);
    const vecs = await this.provider.embed(values);

    // Synchronous writes after the await (T-02-ASYNC: no await inside any write)
    for (let i = 0; i < dirtyRows.length; i++) {
      // L-1: pass captured value_hash — setEmbedding skips if the value changed (stale guard)
      this.store.setEmbedding(dirtyRows[i]!.id, vecs[i]!, dirtyRows[i]!.value_hash);
    }
  }

  // ── Private helper: echo detection ──────────────────────────────────────

  /**
   * Echo-detection step for the offline sleep pass (D-44/D-45).
   *
   * Checks whether a replayed turn merely echoes a prior inferred episode: embeds the
   * turn content and all recent inferred episodes (within echoRecencyWindowMs), computes
   * cosine similarity, and returns the id of the best inferred episode when the highest
   * cosine >= echoSimilarityThreshold; otherwise returns null.
   *
   * Phase A only — awaits the embedder fully before any DB write (T-02-ASYNC).
   * Cost is offline; per-turn capture remains LLM-free (D-44 constraint).
   *
   * Skips inferred-origin episodes (an inference is never an echo of itself).
   */
  private async detectEcho(episode: EpisodeRow): Promise<string | null> {
    // An inferred episode is never classified as an echo of itself (D-44)
    if (episode.origin === 'inferred') return null;

    // H-6: use episode.ts as window anchor, not clock.nowMs() (episode-relative window).
    // This way a Friday replay of a Monday inference is detected correctly regardless of
    // when the sleep pass actually runs — the window is keyed to the episode's own timestamp.
    const sinceMs = episode.ts - this.config.echoRecencyWindowMs;
    const recent = this.episodes.listRecentInferred(sinceMs);
    if (recent.length === 0) return null;
    // Cap to candidates at or before the replayed episode (prevents a future inferred episode
    // from being treated as the echo source of a past replay during out-of-order consolidation).
    const recentCapped = recent.filter(r => r.ts <= episode.ts);
    if (recentCapped.length === 0) return null;

    // Batch-embed [turn, ...recentCapped inferred] in one call (offline cost, T-02-ASYNC Phase A)
    const texts = [episode.content, ...recentCapped.map(r => r.content)];
    const vecs = await this.provider.embed(texts);

    const episodeVec = vecs[0];
    if (!episodeVec) return null;

    let bestId: string | null = null;
    let bestSim = -1;

    for (let i = 0; i < recentCapped.length; i++) {
      const recentEp = recentCapped[i]!;
      const recentVec = vecs[i + 1];
      if (!recentVec) continue;
      // Safety: skip if the same id appears (shouldn't happen — inferred vs non-inferred, and ts-capped)
      if (recentEp.id === episode.id) continue;
      const sim = cosineSimF32(episodeVec, recentVec);
      if (sim > bestSim) {
        bestSim = sim;
        bestId = recentEp.id;
      }
    }

    return bestSim >= this.config.echoSimilarityThreshold ? bestId : null;
  }

  /**
   * Mark a skipped episode as consolidated so it is not re-scanned on every future pass.
   *
   * A skipped episode (salience-filtered OR inferred/echo/hitl hard-stop) produces zero graph
   * effects, but MUST be marked consolidated=1 so listUnconsolidated() excludes it on subsequent
   * passes. Centralised here so the "a skipped episode is always marked" rule cannot silently
   * diverge across the two skip sites — the same duplicated-logic drift that caused FK-01/FK-02.
   *
   * M-5: .immediate() prevents SQLITE_BUSY_SNAPSHOT in WAL mode on upgrade race.
   * better-sqlite3 API: transaction.immediate() calls the transaction in IMMEDIATE mode.
   */
  private markSkipped(episodeId: string): void {
    this.db.transaction(() => this.episodes.markConsolidated(episodeId)).immediate();
  }

  // ── Public interface ─────────────────────────────────────────────────────

  /**
   * Run the offline sleep pass.
   *
   * Phase A: async work only (embed, extract, nominate, classify).
   * Phase B: synchronous DB writes — one transaction per episode.
   * Phase C: re-embed nodes dirtied by Phase B, then eviction sweep.
   */
  async consolidate(): Promise<void> {
    // DRIFT-05: reset the drift counters at the START of the pass — they are instance fields
    // (see field declarations above) so applyDecision/applySecondaryContradiction can
    // increment them, but must still read as per-pass, not cumulative-across-lifetime.
    this.driftEvaluations = 0;
    this.driftDamped = 0;
    this.driftStaleDropped = 0;
    this.driftEventTsUnknown = 0;
    this.proposalsEmitted = 0;

    // ── Phase A prefix: Re-embed dirty nodes so nomination is meaningful ────
    // (seeded/newly-appended nodes start with embedded_hash IS NULL)
    await this.reembedDirty();

    // ── Per-episode loop: async work → sync write atomically (CONSOL-02) ───
    //
    // Structure: for each episode, do ALL async work (extract, embed, classify)
    // into a plain array FIRST, then immediately commit that episode's decisions
    // inside a single db.transaction. No await ever appears inside a transaction
    // (T-02-ASYNC — better-sqlite3 is synchronous). Each episode is checkpointed
    // individually so a crash between episodes never double-applies (CONSOL-02).
    const unconsolidated = orderEpisodesForConsolidation(this.episodes.listUnconsolidated());
    // H-2: track which episodes were quarantined this pass (for logging/observability).
    // Quarantined episodes are NOT marked consolidated — they will be retried next pass.
    const quarantine = new Set<string>();

    // ── Phase A optimization: chunked prefetch claim extractions ────────────
    // FIX-STALL-01: process episodes in batches of PREFETCH_EPISODE_BATCH_SIZE instead of
    // one blocking prefetch over ALL episodes before the per-episode loop starts.
    //
    // OLD (broken at scale): await prefetchExtractions(ALL 308 episodes) → 38 min →
    //   exceeds LOCK_STALE_MS (30 min) → launchd reclaims lock → restarts from 308 unchanged
    //   backlog → markConsolidated is NEVER called → infinite stall loop.
    //
    // NEW (batched): for each chunk of PREFETCH_EPISODE_BATCH_SIZE episodes:
    //   1. prefetchExtractions(chunk) → ~2.5 min/chunk (20 eps × 30s / 4 workers)
    //   2. per-episode loop for the chunk → markConsolidated called N times per chunk
    //   3. advance to next chunk
    // Progress is checkpointed after each batch, so a stale-lock restart resumes from a
    // smaller backlog rather than replaying the full N every time.
    //
    // EPISODE ORDER IS SEMANTICS: episodes within a chunk are extracted in parallel (order
    // doesn't matter for extraction) but processed in the original listUnconsolidated() order
    // in the per-episode loop. Cross-chunk ordering is also preserved (we slice unconsolidated
    // in index order). The invariant "episode N's claims are judged against graph state written
    // by episodes 1..N-1" is maintained because the per-episode loop always runs in original order.
    //
    // Extraction depends only on episode content/source/role — never on graph state (safe to
    // parallelize across the chunk). All writes still happen in the ordered per-episode loop (Phase B).
    //
    // EMAIL-04 (plan 62-05): `listUnconsolidated()` supplies D-03/D-10 replay priority
    // (`hard_keep` desc, then salience desc). `orderEpisodesForConsolidation` then refines it
    // so that, among episodes carrying a source-asserted `event_ts`, the older event is
    // processed first — WITHOUT changing which index slots those episodes occupy. So the
    // "episode N is judged against graph state written by 1..N-1" invariant above and the
    // chunk-prefix truncation behaviour both still hold: a truncated pass still processes the
    // same prefix and the same count, just with the right email in each slot. The SQL
    // `ORDER BY` in `episode-store.ts` is deliberately left unchanged — a global chronological
    // sort would let an old, low-salience backlog message displace a high-salience recent
    // episode out of a truncated pass, degrading resilience for every source, not just email.
    const prefetchBatchSize = getPrefetchBatchSize();
    // prefetchedExtractions accumulates results from all chunks — reused across the loop below.
    // The Map is populated chunk-by-chunk; the per-episode loop below always finds a result for
    // eligible episodes because the chunk covers exactly the sub-slice being processed.
    const prefetchedExtractions = new Map<string, { claims: ExtractedClaim[]; triples: Triple[] } | Error>();

    // Phase 46 D-06: candidate-source counters (observability only — never gate behavior).
    // Declared at consolidate() METHOD scope so they accumulate across all chunks and episodes.
    // Verified via RECON-03: judgeFiredContradiction > 0 after adding BM25.
    let cosineCandidateTotal = 0;
    let anchorCandidateTotal = 0;
    let bm25CandidateTotal = 0;
    let judgeFiredContradiction = 0;

    // RESOLVE-03 / D-06 (Phase 64): resolution attempt/hit/abstain + per-channel candidate
    // counters. Declared at consolidate() METHOD scope (same discipline as the Phase 46
    // counters above) so they accumulate across all chunks and episodes — this is the data
    // Phase 65's DRIFT-05 honest-measurement pass depends on (observable abstention, never
    // silent — T-64-08).
    let resolutionAttempts = 0;
    let resolutionHits = 0;
    let resolutionAbstains = 0;
    let resolutionExactTotal = 0;
    let resolutionBm25Total = 0;
    let resolutionDenseTotal = 0;

    // Process unconsolidated in chunks. Each chunk: prefetch → per-episode loop → next chunk.
    for (let chunkStart = 0; chunkStart < unconsolidated.length; chunkStart += prefetchBatchSize) {
      const chunk = unconsolidated.slice(chunkStart, chunkStart + prefetchBatchSize);
      const eligibleInChunk = chunk.filter(ep => isEligibleForExtraction(ep, this.config));
      const chunkResults = await this.prefetchExtractions(eligibleInChunk);
      // Merge into the shared map so the per-episode loop below can look up results.
      for (const [id, result] of chunkResults) {
        prefetchedExtractions.set(id, result);
      }

      // ── Per-episode loop for this chunk ─────────────────────────────────
      for (let episode of chunk) {
      // H-2: per-episode isolation — mirrors the per-adapter isolation in D-66 (runPullPhase).
      // A deterministically-failing episode (bad API 400 on its content, corrupt DB row)
      // must not block later episodes or abort Phase C / induction / eviction.
      // On error: log, quarantine (don't markConsolidated), continue.
      try {
        // CONSOL-01: per-source + per-role skip threshold (D-60).
        // Per-source override wins when present (e.g. gmail 0.4); otherwise falls back to
        // the per-role default (assistant 0.5, all other roles 0.2). LLM-free at the gate.
        const skipThreshold =
          this.config.salience.consolSkipThresholdBySource[episode.source] ??
          (episode.role === 'assistant'
            ? this.config.consolSkipThresholdAssistant
            : this.config.consolSkipThreshold);
        if (episode.salience < skipThreshold && episode.hard_keep === 0) {
          this.markSkipped(episode.id);
          continue;
        }

        // ── Echo detection (D-44/D-45): backfill source_inference_id BEFORE claim processing ──
        // A replayed turn whose embedding cosines >= echoSimilarityThreshold against a recent
        // inferred episode (within echoRecencyWindowMs) has its source_inference_id backfilled
        // for audit. The structural guard below then short-circuits the episode before claims
        // are extracted, preventing any graph effects regardless of the verdict branch taken.
        // Phase A only: detectEcho awaits the embedder fully before any db.transaction (T-02-ASYNC).
        const echoSourceId = await this.detectEcho(episode);
        if (echoSourceId !== null) {
          this.episodes.backfillSourceInferenceId(episode.id, echoSourceId);
          // Refresh the in-memory copy so the guard below reads the backfilled source_inference_id.
          episode = { ...episode, source_inference_id: echoSourceId };
        }

        // ── WR-01 / CR-01 / ACT-03: hard stop — no graph effects for inferred, echo, or hitl episodes ──
        // WR-01: inferred-origin episodes are ephemeral; they must NEVER produce graph effects
        //        (LEARN-02 ephemeral-as-fact guarantee). The salience skip above is a tunable
        //        performance heuristic; this is the hard structural correctness guard.
        // CR-01: an echo of a prior inference (echoSourceId !== null) carries no independent
        //        evidence — allowing it to strengthen a fact or mint a node is self-confirmation
        //        (LEARN-03, correctness invariant). The contradict→HOLD guard at applyDecision
        //        was the only branch that previously blocked this; confirm/extend/unrelated did not.
        // ACT-03 / D-43: source='hitl' episodes are first-class audit records produced by the
        //        HITL approval gate; they embed retrieved tool RESULTS (the system's own output)
        //        and must NEVER produce graph effects (self-confirmation hole D-43). markConsolidated
        //        is still called so rows are not re-scanned on every pass (they remain queryable as
        //        an audit trail by source='hitl'). Duplicates the isEligibleForExtraction guard so
        //        both sites cannot drift (per the header comment above isEligibleForExtraction).
        // Backfill persists above for the audit trail; no claims are extracted for any of these classes.
        if (episode.origin === 'inferred' || echoSourceId !== null || episode.source === 'hitl') {
          this.markSkipped(episode.id);
          continue;
        }

        // ── D-10 / WR-01: hoisted once-per-episode source gate ──
        // Gates all three claim-side intent fill sites below (sites 1-3) so intent fields are
        // populated for gmail episodes only, regardless of what an extraction response smuggles.
        // Positioned textually AFTER the hard stop above — it inherits that guard by construction
        // (Pitfall 6 / D-03 discipline) and must never be hoisted above it.
        const gmailSourced = episode.source === 'gmail';

        // ── Per-episode Phase A: all async work into plain array ───────────
        const claimOrigin: Origin = episode.origin; // inherit episode origin (T-02-SELFCONF)
        // Claim extraction via ModelProvider.generate (SEAM-01, D-46):
        // Consume prefetched result when available (see prefetchExtractions above).
        // If extraction failed for this episode, rethrow the stored error so H-2 quarantine
        // applies. Fallback to inline extraction if not in map (defensive — should not occur
        // for eligible episodes, but guards against unexpected eligibility-predicate drift).
        // D-02/D-03 (Phase 37): prefetched result now carries {claims, triples}.
        const rawTypedModeInline = process.env['RECENSE_TYPED_EXTRACTION_MODE'];
        const typedMode = rawTypedModeInline === 'merged' ? 'merged'
          : rawTypedModeInline === 'separate' ? 'separate'
          : 'off'; // default: typed extraction disabled (backward-compatible)
        const prefetched = prefetchedExtractions.get(episode.id);
        let claims: ExtractedClaim[];
        let episodeTriples: Triple[];
        if (prefetched !== undefined) {
          if (prefetched instanceof Error) throw prefetched;
          claims = prefetched.claims;
          episodeTriples = prefetched.triples;
        } else {
          // Inline fallback: prefetch skipped this episode (eligibility drift guard).
          const promptPrefix = promptForSource(episode.source) + episode.role + '\n\nDocument content:\n';
          const isTypedSource = isTypedExtractionSource(episode.source);

          if (isTypedSource && typedMode === 'merged') {
            const rawText = await this.provider.generate(promptPrefix + episode.content, {
              maxTokens: EXTRACTION_MAX_TOKENS,
            });
            const parsed = parseMergedExtraction(rawText);
            claims = parsed.claims;
            episodeTriples = parsed.triples;
          } else if (isTypedSource && typedMode === 'separate') {
            claims = await extractClaimsWithChunking(this.provider, promptPrefix, episode.content);
            const tripleText = await this.provider.generate(
              TYPED_EXTRACTION_PROMPT + episode.content,
              { maxTokens: EXTRACTION_MAX_TOKENS },
            );
            episodeTriples = parseTriples(tripleText);
          } else {
            // typedMode === 'off' (default) OR non-typed source: bare-array path, no triples.
            claims = await extractClaimsWithChunking(this.provider, promptPrefix, episode.content);
            episodeTriples = [];
          }
        }

        // Batch-embed all claim query vectors in ONE call (T-02-ASYNC: Phase A, before any
        // db.transaction). Empty-claims episodes make zero embed calls.
        const claimValues = claims.map(c => c.value);
        const claimVecs = claimValues.length > 0
          ? await this.provider.embed(claimValues)
          : [];

        // TEMP-02: parse gcal provenance header tokens once per episode (pure string parse,
        // never an LLM call — CONSOL-03 discipline). Both fields are null for non-gcal sources
        // and for gcal episodes missing the respective token.
        const { sourceEventId: gcalSourceEventId, recurrenceRule: gcalRecurrenceRule } =
          this.parseGcalProvenance(episode.source, episode.content);

        // ── Concurrent judge calls within one episode ────────────────────
        // Sync work per claim (topk retrieval, D-17 fast-path exact-match, UPDATE-02
        // low-cosine auto-unrelated) reads pre-episode graph state and runs in claim order.
        // Claims that escalate to provider.judge are collected and awaited with Promise.all
        // (claims within one episode are independent — they all see the same graph snapshot).
        // Decisions are reassembled in original claim order via indexed slots.
        // If any judge call rejects, Promise.all rejects and the episode is quarantined (H-2).
        // EPISODE ORDER IS SEMANTICS: this optimization is intra-episode only; the outer loop
        // still processes episodes sequentially and all writes happen in Phase B order.

        // Pre-allocate slots so we can fill in order after concurrent judge resolution.
        const decisionSlots: (ClaimDecision | null)[] = new Array(claims.length).fill(null);
        const pendingJudges: PendingJudge[] = [];

        for (let claimIdx = 0; claimIdx < claims.length; claimIdx++) {
          const claim = claims[claimIdx]!;
          const queryVec = claimVecs[claimIdx];
          if (!queryVec) continue;

          const candidates = this.retriever.topk(queryVec, this.config.candidateK);

          // D-17: zero-inference fast path — normalized exact-match → confirm, no judge call
          // Fast path evaluated on cosine candidates only (unchanged, D-17 priority preserved).
          const fastPathCandidate = candidates.find(
            c => normalizeValue(this.store.getNode(c.id)?.value ?? '') === normalizeValue(claim.value)
          );
          if (fastPathCandidate) {
            // CLASSIFY-02 / D-09: this fill site is textually AFTER the origin === 'inferred' ||
            // echoSourceId !== null || episode.source === 'hitl' hard stop at the top of this
            // per-episode loop iteration (see the WR-01/CR-01/ACT-03 guard above) — the guard is
            // inherited by construction, never re-implemented as an independent scan over
            // episodes (Pitfall 6: this exact defect class shipped twice before, closing the
            // self-confirmation hole).
            decisionSlots[claimIdx] = {
              claimValue: claim.value,
              claimType: claim.type,
              claimOrigin,
              relation: 'confirm',
              bestCandidateId: fastPathCandidate.id,
              episodeSessionId: episode.session_id,
              episodeEventTs: episode.event_ts ?? null,
              episodeSource: episode.source,
              magnitude: 0,
              episodeSourceInferenceId: episode.source_inference_id,
              episodeRole: episode.role,
              contradictedIds: [],
              claimDueAt: claim.due_at,        // TEMP-02
              claimActionType: claim.action_type, // TEMP-02
              gcalSourceEventId,               // TEMP-02
              gcalRecurrenceRule,              // TEMP-02
              claimIntentStatus: gmailSourced ? claim.intent_status : undefined,         // CLASSIFY-02 / D-10
              claimIntentEntity: gmailSourced ? claim.intent_entity : undefined,         // CLASSIFY-02 / D-10
              claimIntentConfidence: gmailSourced ? claim.intent_confidence : undefined, // CLASSIFY-02 / D-10
            };
          } else {
            // M1: entity-anchored candidate expansion (Phase A sync reads — T-02-ASYNC preserved).
            // Run AFTER D-17 fast path. Two anchor sources:
            //   (a) Link anchors — claim.links containment-match against live nodes.
            //   (b) Provenance-sibling anchors — live fact siblings of entity-type cosine candidates.
            // All reads are sync prepared statements, never inside db.transaction (T-02-ASYNC).
            const cosineIdSet = new Set(candidates.map(c => c.id));
            const anchors: Array<{ id: string; value: string }> = [];

            // (a) Link anchors — D-17 containment: normalizeValue(node.value).includes(normLink)
            for (const link of (claim.links ?? [])) {
              const normLink = normalizeValue(link);
              if (normLink.length < 3) continue; // skip noise tokens (M1 design)
              for (const row of this.stmtLiveNodesForLinks.all()) {
                if (!cosineIdSet.has(row.id) && !anchors.some(a => a.id === row.id)) {
                  if (normalizeValue(row.value).includes(normLink)) {
                    anchors.push({ id: row.id, value: row.value });
                    if (anchors.length >= this.config.entityAnchorK) break; // T-UE6-03 cap
                  }
                }
              }
              if (anchors.length >= this.config.entityAnchorK) break;
            }

            // (b) Provenance-sibling anchors — entity-type nodes in cosine top-k
            if (anchors.length < this.config.entityAnchorK) {
              for (const c of candidates) {
                const node = this.store.getNode(c.id);
                if (node?.type === 'entity') {
                  const siblings = this.stmtProvenanceSiblingFacts.all(c.id);
                  for (const sib of siblings) {
                    if (!cosineIdSet.has(sib.id) && !anchors.some(a => a.id === sib.id)) {
                      anchors.push({ id: sib.id, value: sib.value });
                      if (anchors.length >= this.config.entityAnchorK) break; // T-UE6-03 cap
                    }
                  }
                }
                if (anchors.length >= this.config.entityAnchorK) break;
              }
            }

            // Phase 46 (D-03): BM25 lexical candidate pass.
            // Third union member: cosine ∪ M1-anchors (existing) ∪ BM25 (new).
            // Phase A sync read — before any db.transaction (T-02-ASYNC invariant).
            // ftsQueryFromText is the mandatory MATCH sanitizer (T-17-02-T — never pass raw text).
            // Dark-knob: bm25CandidateK=0 reproduces today's exact behavior (D-07).
            // FTS-absent fallback: try/catch mirrors topk.ts:hybridTopk lines 460-465.
            const bm25Candidates: Array<{ id: string }> = [];
            if (this.config.bm25CandidateK > 0) {
              const ftsQuery = ftsQueryFromText(claim.value);
              if (ftsQuery) {
                try {
                  const bm25Rows = this.stmtBm25Candidates.all(ftsQuery, this.config.bm25CandidateK) as Array<{ id: string }>;
                  for (const row of bm25Rows) {
                    if (!cosineIdSet.has(row.id) && !anchors.some(a => a.id === row.id)) {
                      bm25Candidates.push(row);
                    }
                  }
                } catch {
                  // FTS table absent or MATCH syntax error — graceful degradation (mirrors topk.ts:hybridTopk)
                }
              }
            }

            // D-06: accumulate candidate-source counters after each source resolves.
            cosineCandidateTotal += candidates.length;
            anchorCandidateTotal += anchors.length;
            bm25CandidateTotal += bm25Candidates.length;

            // Phase 46 D-04: extend gate — auto-unrelated fires only when cosine is low,
            // no anchors, AND no BM25 candidates. A BM25 lexical hit rescues a low-cosine
            // claim into judge escalation exactly like an anchor does. This is the load-bearing
            // change that lets the judge see cosine-0.48 contradictions it currently auto-drops.
            const cosineGate = candidates.length === 0 ||
              candidates[0]!.score < this.config.unrelatedSimilarityThreshold;

            if (cosineGate && anchors.length === 0 && bm25Candidates.length === 0) {
              // low cosine, no anchors, no BM25 hits → auto-unrelated, no judge call
              decisionSlots[claimIdx] = {
                claimValue: claim.value,
                claimType: claim.type,
                claimOrigin,
                relation: 'unrelated',
                bestCandidateId: null,
                episodeSessionId: episode.session_id,
                episodeEventTs: episode.event_ts ?? null,
                episodeSource: episode.source,
                magnitude: 0,
                episodeSourceInferenceId: episode.source_inference_id,
                episodeRole: episode.role,
                contradictedIds: [],
                claimDueAt: claim.due_at,        // TEMP-02
                claimActionType: claim.action_type, // TEMP-02
                gcalSourceEventId,               // TEMP-02
                gcalRecurrenceRule,              // TEMP-02
                claimVec: queryVec,              // DEDUP-01: embed-on-mint
                claimIntentStatus: gmailSourced ? claim.intent_status : undefined,         // CLASSIFY-02 / D-10
                claimIntentEntity: gmailSourced ? claim.intent_entity : undefined,         // CLASSIFY-02 / D-10
                claimIntentConfidence: gmailSourced ? claim.intent_confidence : undefined, // CLASSIFY-02 / D-10
              };
            } else {
              // Phase 46 D-02: extend union — cosine → anchors → BM25 (D-02 ordering).
              // BM25 candidates are deduped from cosine+anchor ids already above; no additional
              // dedup needed here. Value fetched via store (mirrors cosine candidate pattern).
              const judgeCandidates = [
                ...candidates.map(c => ({
                  id: c.id,
                  value: this.store.getNode(c.id)?.value ?? '',
                })),
                ...anchors, // anchors carry value from SQL / stmtLiveNodesForLinks row
                ...bm25Candidates.map(c => ({
                  id: c.id,
                  value: this.store.getNode(c.id)?.value ?? '',
                })), // BM25 lexical hits (Phase 46 D-02)
              ];
              pendingJudges.push({
                slotIdx: claimIdx,
                claimValue: claim.value,
                claimType: claim.type,
                candidates: judgeCandidates,
                claimDueAt: claim.due_at,        // TEMP-02
                claimActionType: claim.action_type, // TEMP-02
                claimIntentStatus: gmailSourced ? claim.intent_status : undefined,         // CLASSIFY-02 / D-10
                claimIntentEntity: gmailSourced ? claim.intent_entity : undefined,         // CLASSIFY-02 / D-10
                claimIntentConfidence: gmailSourced ? claim.intent_confidence : undefined, // CLASSIFY-02 / D-10
              });
            }
          }
        }

        // ONE judgeBatch call per episode (batch = all pending claims for this episode).
        // Amortizes one think block across N claims; ≤2 LLM calls total (forward + optional
        // contradict-only swap). If the batch rejects, the episode is quarantined per H-2.
        // T-02-ASYNC: this single await is Phase A — before any db.transaction (CONSOL-02).
        //
        // Judge batching DEFAULTS OFF (260613). The cea0125 batch-of-N path was a perf
        // optimization (one think block amortized across N claims) that was NEVER
        // correctness-validated and regressed local EVAL-02 belief-correction 84.6% -> 53.8%:
        // the 35b judge loses per-pair accuracy when several contradiction pairs share one
        // think block. Per-claim judging is the validated baseline behavior. Batching is now
        // OPT-IN via RECENSE_ENABLE_JUDGE_BATCH=1 for stacks where it has been validated.
        // items.length===1 delegates to this.judge() byte-identically (judgeBatch contract),
        // so the per-claim path is exactly the pre-batching behavior.
        const judgeVerdicts = process.env.RECENSE_ENABLE_JUDGE_BATCH === '1'
          ? await this.provider.judgeBatch(
              pendingJudges.map(p => ({ claim: p.claimValue, candidates: p.candidates }))
            )
          : await Promise.all(
              pendingJudges.map(p =>
                this.provider
                  .judgeBatch([{ claim: p.claimValue, candidates: p.candidates }])
                  .then(r => r[0]!)
              )
            );

        // Fill judge-escalated slots in original claim order
        for (let i = 0; i < pendingJudges.length; i++) {
          const { slotIdx, claimValue, claimType } = pendingJudges[i]!;
          const verdict = judgeVerdicts[i]!;
          // M2 / T-UE6-02: filter contradicted_ids to the exact candidate set passed to this
          // judge call — drops any hallucinated ids the model might emit (defensive).
          const candidateIdSet = new Set(pendingJudges[i]!.candidates.map(c => c.id));
          const contradictedIds = (verdict.contradicted_ids ?? []).filter(id => candidateIdSet.has(id));
          // T-FK-01: filter best_candidate_id against the same candidate set — same treatment as
          // contradictedIds above. A hallucinated or out-of-set id would be used as edge.src in the
          // extend branch (upsertEdge src=bestCandidateId) causing a FK violation if the id is
          // absent from the node table. Null-coerce so extend falls to the standalone path instead.
          const rawBestId = verdict.best_candidate_id;
          const bestCandidateId = rawBestId !== null && candidateIdSet.has(rawBestId) ? rawBestId : null;
          decisionSlots[slotIdx] = {
            claimValue,
            claimType,
            claimOrigin,
            relation: verdict.relation,
            bestCandidateId,
            episodeSessionId: episode.session_id,
            episodeEventTs: episode.event_ts ?? null,
            episodeSource: episode.source,
            magnitude: verdict.magnitude,
            episodeSourceInferenceId: episode.source_inference_id,
            episodeRole: episode.role,
            contradictedIds,
            claimDueAt: pendingJudges[i]!.claimDueAt,          // TEMP-02
            claimActionType: pendingJudges[i]!.claimActionType,  // TEMP-02
            gcalSourceEventId,                                    // TEMP-02
            gcalRecurrenceRule,                                   // TEMP-02
            claimVec: claimVecs[pendingJudges[i]!.slotIdx] ?? undefined, // DEDUP-01: embed-on-mint
            // D-10: values arrive pre-gated from the site-3 pendingJudges.push above — this site
            // inherits by construction and does NOT re-gate. WARNING: if site 3's gate is ever
            // removed, this site does NOT compensate and the WR-01 smuggling path reopens here.
            claimIntentStatus: pendingJudges[i]!.claimIntentStatus,         // CLASSIFY-02
            claimIntentEntity: pendingJudges[i]!.claimIntentEntity,         // CLASSIFY-02
            claimIntentConfidence: pendingJudges[i]!.claimIntentConfidence, // CLASSIFY-02
          };
        }

        // ── RESOLVE-01/02/03 (Phase 64): entity resolution branch ───────────
        // Textually AFTER the WR-01/CR-01/ACT-03 hard stop above (inferred/echo/hitl episodes
        // already `continue`d out of this iteration) and after ALL FOUR intent fill sites
        // (fast-path confirm, auto-unrelated, and both pendingJudges/post-judge-fill sites), so
        // one branch here covers every decision route instead of a fourth copy per route. This
        // is NOT an independent scan over episodes — it runs later in the same per-episode
        // iteration as the hard stop and inherits that guard by construction (Pitfall 6 / D-03;
        // this exact defect class — an independent scan silently failing to inherit the guard —
        // has shipped twice before in this codebase).
        for (let i = 0; i < decisionSlots.length; i++) {
          const slot = decisionSlots[i];
          // D-03: zero resolution cost for episodes/claims without intent fields.
          // `slot == null` covers both the array's `null` sentinel and the `undefined` that
          // TS's noUncheckedIndexedAccess adds to every index access.
          if (slot == null || slot.claimIntentEntity === undefined) continue;
          resolutionAttempts++;
          // Index alignment: claimVecs[i] is the embedding of decisionSlots[i]'s claim (see
          // the "Index alignment (load-bearing)" note in the plan interfaces) — the dense
          // channel is free here, no new embed call (D-04).
          const resolution = this.entityResolver.resolve({
            descriptor: slot.claimIntentEntity,
            vec: claimVecs[i],
          });
          resolutionExactTotal += resolution.channelCounts.exact;
          resolutionBm25Total += resolution.channelCounts.bm25;
          resolutionDenseTotal += resolution.channelCounts.dense;
          if (resolution.resolved) {
            // D-07: all-or-nothing — both fields assigned together, at this single write point.
            slot.claimResolvedEntityId = resolution.nodeId;
            slot.claimResolvedEntityDescriptor = resolution.descriptor;
            resolutionHits++;
          } else {
            // Never assign one field without the other — abstained means both stay undefined.
            resolutionAbstains++;
          }
        }

        // Filter null slots (claims skipped due to missing queryVec)
        const decisions: ClaimDecision[] = decisionSlots.filter((d): d is ClaimDecision => d !== null);

        // ── Per-episode Phase B: synchronous write — one transaction (CONSOL-02) ──
        // All decisions for this episode + markConsolidated in ONE atomic transaction.
        // No await inside (T-02-ASYNC). If a later episode's Phase A crashes, this
        // episode's checkpoint is already committed and will not be re-applied.
        // M-5: .immediate() — this is the critical multi-statement write transaction;
        // DEFERRED mode in WAL can fail with SQLITE_BUSY_SNAPSHOT when another connection
        // holds a SHARED lock (e.g. retrieval running in another process) and this
        // transaction tries to upgrade from DEFERRED→EXCLUSIVE at first write statement.
        const episodeId = episode.id;
        // M-5: .immediate() — better-sqlite3 API: transaction.immediate() calls the transaction
        // in IMMEDIATE mode (acquires RESERVED lock upfront, preventing SQLITE_BUSY_SNAPSHOT
        // on upgrade race in WAL mode when a concurrent reader holds a SHARED lock).
        // D-02 (Phase 37): resolve triple entity names → node ids BEFORE Phase B transaction.
        // Resolution happens against the PRE-transaction graph state (nodes written by this
        // episode in applyDecision do NOT exist yet, so dangling-edge guard is clean).
        // D-08 guard: we only reach this point because the hard skip guard at the
        // origin/echo/hitl check above already `continue`d for inferred/echo/hitl episodes.
        // T-37-06: predicates are already vocab-filtered by parseTriples (PRED_SET guard).
        // Dangling-edge guard: skip upsertEdge when either endpoint cannot be resolved.
        // Self-loop guard: skip when src and dst resolve to the same node.
        const resolvedTriples: Array<{ srcId: string; dstId: string; rel: string }> = [];
        for (const triple of episodeTriples) {
          const srcId = this.store.resolveEntityByName(triple.subject);
          const dstId = this.store.resolveEntityByName(triple.object);
          if (!srcId || !dstId || srcId === dstId) continue;
          resolvedTriples.push({ srcId, dstId, rel: triple.predicate });
        }

        // D-06: count contradiction decisions before Phase B (applyDecision is a separate method
        // and cannot see consolidate()-local counters — increment at the call site, not inside).
        for (const decision of decisions) {
          if (decision.relation === 'contradict') judgeFiredContradiction++;
        }
        this.db.transaction(() => {
          for (const decision of decisions) {
            this.applyDecision(decision, episodeId, episode.content);
          }
          // D-02 (Phase 37): mint typed edges from pre-resolved triples.
          // Triple-upsert is AFTER the line-462 hard skip guard (T-37-05 / Pitfall 6).
          for (const t of resolvedTriples) {
            this.store.upsertEdge({
              src: t.srcId,
              dst: t.dstId,
              rel: t.rel,
              w: 0.1,    // initial weight; mirrors the 'extends' pattern at line ~822
              kind: 'relation',
            });
          }
          this.episodes.markConsolidated(episodeId);
        }).immediate();
      } catch (err) {
        // H-2: poison-episode isolation — log and quarantine without marking consolidated.
        // The episode will be retried on the next pass. One bad episode must not abort the
        // loop or Phase C / induction / eviction (mirrors D-66 per-adapter isolation).
        this.log(`episode ${episode.id} skipped (consolidation error): ${String(err)}`);
        quarantine.add(episode.id);
        // fall through to next episode (continue implicit after catch)
      }
      } // end per-episode loop for this chunk
    } // end chunked prefetch outer loop (FIX-STALL-01)

    // Phase 46 D-06: emit accumulated candidate-source counters after all chunks complete.
    this.log(
      `RECON-03 candidates: cosine=${cosineCandidateTotal} anchors=${anchorCandidateTotal} bm25=${bm25CandidateTotal} | judgeFiredContradiction=${judgeFiredContradiction}`
    );
    // RESOLVE-03 / D-06 (Phase 64): observable resolution attempt/hit/abstain counts, emitted
    // once per pass after all chunks complete — this is the data Phase 65's DRIFT-05 honest-
    // measurement pass depends on.
    this.log(
      `RESOLVE-64 attempts=${resolutionAttempts} hits=${resolutionHits} abstains=${resolutionAbstains} | exact=${resolutionExactTotal} bm25=${resolutionBm25Total} dense=${resolutionDenseTotal}`
    );
    // DRIFT-05 (Plan 65-10 consumer): observable drift-layer outcome counts, emitted once per
    // pass after all chunks complete — mirrors the Phase 46/64 observability precedents above.
    this.log(
      `DRIFT-65 evaluations=${this.driftEvaluations} damped=${this.driftDamped} staleDropped=${this.driftStaleDropped} eventTsUnknown=${this.driftEventTsUnknown}`
    );
    // EMIT-66 (Phase 66): observable proposal-emission count for this pass — the data any
    // future emission calibration will read, mirroring the RESOLVE-64/DRIFT-65 precedents.
    this.log(`EMIT-66 proposals=${this.proposalsEmitted}`);

    // ── Phase C: Re-embed nodes dirtied by this pass, then eviction sweep ──
    await this.reembedDirty();
    // D-11 (Phase 44): schema induction + derivation are gated on config.schemaInductionEnabled.
    // Lite preset sets this to false → skips the optional schema-abstraction layer entirely.
    // Default-on (undefined treated as true): old callers without the field keep existing behaviour.
    // Only the optional layer is gated — extract + PE-reconsolidation (Phase A/B) never toggle (D-12).
    if (this.config.schemaInductionEnabled !== false) {
      // D-37: schema induction after Phase C reembedDirty(), before eviction.
      // Schemas depend on fresh embeddings; tombstoned schemas must be swept in the same pass.
      // D-09: tag schema-induction LLM calls as 'schema_abstract' so the ledger breaks them
      // out from default Sonnet 'judge' calls. Reset in finally so a mid-induction error
      // cannot mistag later calls (T-44-10).
      setHeadlessFeature('schema_abstract');
      try {
        await this.inducer.induceSchemas();
      } finally {
        setHeadlessFeature(null);
      }
      // D-07: schema-relation derivation after induceSchemas() (needs fresh centroids + schema nodes),
      // before runEvictionSweep(). Artifacts are disposable derived cache — a mid-derive crash
      // leaves wipe-then-rebuild-clean state on the next pass; no extra try/catch needed.
      await this.deriver.deriveSchemaRelations();
    } else {
      this.log('schema induction skipped (preset=lite / schemaInductionEnabled=false)');
    }
    // D-04 (Phase 28, CORPUS-02/03/05): corpus promotion after schema-relation derivation
    // (needs fresh schema_rel / super-schema edges), before eviction so the new s=0 doc stubs
    // are present (eviction leaves lifecycle-exempt s=0 nodes alone). LLM-free + idempotent.
    await this.corpusPromoter.promote();
    // D-11/D-20 (Phase 39.2): DocGraphDeriver — wipe+rebuild all doc_reference + doc_containment
    // edges from schema/fact graph. Runs AFTER promote() (stubs + subject-schema-ids meta fresh)
    // and BEFORE insightReflector.reflect() (deriver is sole owner; no competing writers — D-11).
    await this.docGraphDeriver.deriveDocGraph();
    // D-07 (REFLECT-01, Plan 38-02): insight reflection after corpus promotion, before eviction.
    // A dissolved-cluster tombstoned insight is collected by runEvictionSweep() in the same pass.
    await this.insightReflector.reflect();
    this.strength.runEvictionSweep();
  }

  // ── Private: gcal provenance parse + temporal write helper ──────────────

  /**
   * Deterministic parse of gcal provenance header tokens (TEMP-02, CONSOL-03).
   *
   * Called once per episode in Phase A; both fields are null when source !== 'gcal'.
   * Tokens emitted by the CalendarAdapter (plan 04):
   *   · Event: <id>       — always present for gcal episodes
   *   · RRULE: <rrule>    — present only for recurring masters (null for one-off)
   *
   * Pure string regex — never an LLM call (CONSOL-03 sole-writer discipline).
   */
  private parseGcalProvenance(
    source: string,
    content: string,
  ): { sourceEventId: string | null; recurrenceRule: string | null } {
    if (source !== 'gcal') {
      return { sourceEventId: null, recurrenceRule: null };
    }
    const eventMatch = content.match(/·\s*Event:\s*(\S+)/);
    const rruleMatch = content.match(/·\s*RRULE:\s*([^\n·]+)/);
    return {
      sourceEventId: eventMatch ? (eventMatch[1] ?? null) : null,
      recurrenceRule: rruleMatch ? (rruleMatch[1]?.trim() ?? null) : null,
    };
  }

  /**
   * Write a node_temporal row when the decision carries a temporal claim (TEMP-02).
   *
   * Called after every upsertNode that creates or confirms a node for a temporal claim.
   * No-op when claimDueAt is undefined (non-temporal claims are not annotated).
   *
   * CONSOL-03: this is the SOLE writer of node_temporal — adapters never write it.
   * Belief node.s / node.c are untouched — temporal annotation is a separate sidecar.
   */
  private maybeWriteNodeTemporal(nodeId: string, decision: ClaimDecision): void {
    if (decision.claimDueAt === undefined) return;
    this.store.upsertNodeTemporal({
      node_id: nodeId,
      due_at: decision.claimDueAt,
      action_type: decision.claimActionType ?? 'other',  // D-02: fallback for undefined
      recurrence_rule: decision.gcalRecurrenceRule ?? null,
      source_event_id: decision.gcalSourceEventId ?? null,
      updated_at: this.clock.nowMs(),
    });
  }

  // ── Private: emit a domain-neutral action proposal for a decisive change (Phase 66) ──────

  /**
   * D-06: called synchronously inside the per-episode `db.transaction` already open around
   * `applyDecision` — the proposal row and the graph mutation it describes commit or roll
   * back together. No `await` may ever be introduced here — T-02-ASYNC's discipline extends
   * to this seam.
   *
   * D-05: the gate is `isEmissionEligible`, imported from `./status-drift` — never a locally
   * re-derived event-type set. A non-eligible event type (confirm/extend/unrelated/oscillation/
   * hold) returns immediately with no emission.
   *
   * All-or-nothing (Phase 63's D-05 / Phase 64's D-07): a partial claimIntent-family /
   * claimResolvedEntity-family field set means the classifier or the resolver abstained — this
   * emits nothing rather than a partial or guessed proposal (research Pitfall 4).
   *
   * `change_from`/`change_to` asymmetry is intentional, not a bug: `change_from` is recense's
   * PRIOR belief TEXT verbatim (human-readable, often a full sentence) while `change_to` is a
   * token from recense's own closed `IntentStatus` vocabulary. A consumer maps on `change_to`;
   * `change_from` exists so an approver sees what recense believed before. Never "normalise"
   * either side by paraphrasing — paraphrase is exactly the confused-deputy surface Pitfall 2
   * forbids.
   */
  private maybeEmitProposal(
    eventType: ConsolidationEventType,
    decision: ClaimDecision,
    episodeId: string,
    episodeContent: string,
    beliefNodeId: string,
    changeFrom: string | null,
  ): void {
    if (!isEmissionEligible(eventType)) return;

    const {
      claimResolvedEntityId,
      claimResolvedEntityDescriptor,
      claimIntentStatus,
      claimIntentConfidence,
    } = decision;
    if (
      claimResolvedEntityId === undefined ||
      claimResolvedEntityDescriptor === undefined ||
      claimIntentStatus === undefined ||
      claimIntentConfidence === undefined
    ) {
      return;
    }

    this.proposalSink.emit({
      kind: 'belief',
      entity_node_id: claimResolvedEntityId,
      entity_descriptor: claimResolvedEntityDescriptor,
      belief_node_id: beliefNodeId,
      change_field: BELIEF_CHANGE_FIELD_STATUS,
      change_from: changeFrom,
      change_to: claimIntentStatus,
      evidence_episode: episodeId,
      evidence_quote: episodeContent,
      confidence: claimIntentConfidence,
    });
    this.proposalsEmitted++;
  }

  // ── Private: apply a single claim decision within a transaction ──────────

  private applyDecision(decision: ClaimDecision, episodeId: string, episodeContent: string): void {
    switch (decision.relation) {
      case 'confirm': {
        if (decision.bestCandidateId) {
          // C-2: assistant-role episodes must NOT strengthen — the memory's own output restated
          // by Claude is self-confirmation (session-inject echo). User/tool roles still strengthen.
          // The inferred-origin guard in StrengthDecayManager (T-02-SELFCONF) remains as a second layer.
          if (decision.episodeRole !== 'assistant') {
            this.strength.strengthen(decision.bestCandidateId, decision.claimOrigin);
          }
          // TEMP-02: refresh node_temporal for the existing node (keeps recurring due_at current
          // on re-ingest — the CalendarAdapter computes next-occurrence deterministically each pass).
          this.maybeWriteNodeTemporal(decision.bestCandidateId, decision);
          // Always emit — records the confirm event for audit regardless of role (D-49 compliance).
          this.sink.emit({
            event_type: 'confirm',
            node_id: decision.bestCandidateId,
            candidate_id: decision.bestCandidateId,
            episode_id: episodeId,
            value: decision.claimValue,
            origin: decision.claimOrigin,
            magnitude: decision.magnitude,
          });
          this.maybeEmitProposal('confirm', decision, episodeId, episodeContent, decision.bestCandidateId, null);
        }
        break;
      }

      case 'extend': {
        if (decision.bestCandidateId) {
          const newId_ = newId();
          this.store.upsertNode({
            id: newId_,
            type: decision.claimType as 'entity' | 'fact' | 'schema',
            value: decision.claimValue,
            origin: decision.claimOrigin,
          });
          if (decision.claimVec) { this.store.setEmbedding(newId_, decision.claimVec); } // DEDUP-01: value==claimValue
          this.maybeWriteNodeTemporal(newId_, decision); // TEMP-02
          this.store.upsertEdge({
            src: decision.bestCandidateId,
            dst: newId_,
            rel: 'extends',
            w: 0.1,
            kind: 'relation',
          });
          // SEAM-02 D-49: new node_id + bestCandidateId as candidate_id
          this.sink.emit({
            event_type: 'extend',
            node_id: newId_,
            candidate_id: decision.bestCandidateId,
            episode_id: episodeId,
            value: decision.claimValue,
            origin: decision.claimOrigin,
            magnitude: decision.magnitude,
          });
          this.maybeEmitProposal('extend', decision, episodeId, episodeContent, newId_, null);
        } else {
          // extend with no candidate → treat as standalone (defensive)
          const standaloneId = newId();
          this.store.upsertNode({
            id: standaloneId,
            type: decision.claimType as 'entity' | 'fact' | 'schema',
            value: decision.claimValue,
            origin: decision.claimOrigin,
          });
          if (decision.claimVec) { this.store.setEmbedding(standaloneId, decision.claimVec); } // DEDUP-01: value==claimValue
          this.maybeWriteNodeTemporal(standaloneId, decision); // TEMP-02
          // SEAM-02 D-49: defensive standalone counts as extend (no candidate_id)
          this.sink.emit({
            event_type: 'extend',
            node_id: standaloneId,
            candidate_id: null,
            episode_id: episodeId,
            value: decision.claimValue,
            origin: decision.claimOrigin,
            magnitude: decision.magnitude,
          });
          this.maybeEmitProposal('extend', decision, episodeId, episodeContent, standaloneId, null);
        }
        break;
      }

      case 'unrelated': {
        const unrelatedId = newId();
        this.store.upsertNode({
          id: unrelatedId,
          type: decision.claimType as 'entity' | 'fact' | 'schema',
          value: decision.claimValue,
          origin: decision.claimOrigin,
        });
        if (decision.claimVec) { this.store.setEmbedding(unrelatedId, decision.claimVec); } // DEDUP-01: value==claimValue (root-cause site)
        this.maybeWriteNodeTemporal(unrelatedId, decision); // TEMP-02
        // SEAM-02 D-49: standalone new node
        this.sink.emit({
          event_type: 'unrelated',
          node_id: unrelatedId,
          candidate_id: null,
          episode_id: episodeId,
          value: decision.claimValue,
          origin: decision.claimOrigin,
          magnitude: decision.magnitude,
        });
        this.maybeEmitProposal('unrelated', decision, episodeId, episodeContent, unrelatedId, null);
        break;
      }

      case 'contradict': {
        // DRIFT-01..04 (Phase 65): consult the drift layer BEFORE the M2 secondary loop below
        // and BEFORE the primary routing call — a stale claim must have no graph effect on
        // secondaries either (T-65-08-STALEHOLD). Positioned textually AFTER the WR-01/CR-01/
        // ACT-03 hard stop in the per-episode loop above (which has already `continue`d out
        // inferred/echo/hitl episodes before applyDecision is ever reached) — this block does
        // NOT re-check origin/echo/hitl itself, inheriting that guard by call-site position
        // rather than re-implementing it (Pitfall 6: this exact defect class shipped twice
        // before). Guarded on bestCandidateId !== null: when null there is no node to compare
        // timestamps against, so evaluation is skipped and today's behavior is unchanged (the
        // branch already breaks below when bestCandidateId is null).
        //
        // routeContradiction itself is NOT modified and gets no new branch — the guard sits
        // structurally before it (D-11), which is what keeps DRIFT-01's "machinery unmodified"
        // true. `driftMagnitude` carries the (possibly damped) value into routing; every
        // `sink.emit` payload below deliberately keeps `magnitude: decision.magnitude`
        // UNCHANGED — the sink records the judge's own emitted severity, and rewriting it with
        // the damped value would make the audit trail lie about what the judge said.
        let driftMagnitude = decision.magnitude;
        if (decision.bestCandidateId !== null) {
          this.driftEvaluations++;
          const drift = this.statusDrift.evaluate({
            magnitude: decision.magnitude,
            confidence: decision.claimIntentConfidence,
            claimEventTs: decision.episodeEventTs,
            candidateNodeId: decision.bestCandidateId,
          });
          if (drift.action === 'drop') {
            // DRIFT-04 crux: DROP, not hold — a held contradiction is recorded into
            // pending_contradictions and would accumulate toward force-destabilization, so
            // three stale backfilled rejections would eventually flip a newer, correct belief.
            // Dropping produces no graph effect at all, mirroring the existing "not
            // provenance-eligible: drop silently" behavior in the hold branch below. `break`s
            // out of the whole case — no secondary routing (loop below never runs), no primary
            // routing, no recordContradiction, and no sink emit occurs.
            this.driftStaleDropped++;
            break;
          }
          driftMagnitude = drift.magnitude;
          if (drift.damped) this.driftDamped++;
          if (drift.staleness === 'unknown-claim-ts' || drift.staleness === 'unknown-prior-ts') {
            this.driftEventTsUnknown++;
          }
        }

        // M2: route secondary contradicted nodes BEFORE the primary break/guard (plan 260611-ue6 Task 3).
        // contradictedIds is already filtered to the candidate set (T-UE6-02 — fill section above).
        // Skip the primary id here — it is handled by the existing primary block below so that
        // all existing routing logic (D-20 oscillation, D-19 hold, D-15/D-16, force-destabilize)
        // remains byte-identical. Secondaries NEVER mint — only the primary reconcile mints one
        // new node per claim (single-new-node invariant).
        for (const secId of decision.contradictedIds) {
          if (secId !== decision.bestCandidateId) {
            this.applySecondaryContradiction(secId, decision, episodeId);
          }
        }

        if (!decision.bestCandidateId) break;

        // Read the candidate node and compute D-16 resistance = effective_s * c.
        // effectiveStrength() is a pure function on StrengthDecayManager — no DB write.
        const node = this.store.getNode(decision.bestCandidateId);
        if (!node) break;

        const effectiveS = this.strength.effectiveStrength(
          node.s, node.last_access, this.clock.nowMs(), this.config.lambda,
        );
        const resistance = effectiveS * node.c; // D-16

        // Route by PE magnitude / resistance (spec §4 step 3, D-15/D-16). driftMagnitude is
        // decision.magnitude unchanged unless the drift layer above damped it (DRIFT-01: the
        // routing function itself is untouched).
        const action = routeContradiction(driftMagnitude, resistance, this.config);

        if (action === 'reconcile') {
          // D-20 oscillation guard: if the new value normalizes to the superseded prev_value,
          // escalate to append-new so both values coexist rather than tombstone-cycling.
          if (isOscillation(decision.claimValue, node.prev_value)) {
            // Flip-back detected — append standalone (no prev_value; genuine ambiguity)
            const oscId = newId();
            this.store.upsertNode({
              id: oscId,
              type: decision.claimType as 'entity' | 'fact' | 'schema',
              value: decision.claimValue,
              origin: decision.claimOrigin,
            });
            if (decision.claimVec) { this.store.setEmbedding(oscId, decision.claimVec); } // DEDUP-01: value==claimValue
            this.maybeWriteNodeTemporal(oscId, decision); // TEMP-02
            // SEAM-02 D-49: oscillation escalated from reconcile → 'contradict_oscillation'
            this.sink.emit({
              event_type: 'contradict_oscillation',
              node_id: oscId,
              candidate_id: decision.bestCandidateId,
              episode_id: episodeId,
              value: decision.claimValue,
              origin: decision.claimOrigin,
              magnitude: decision.magnitude,
            });
            this.maybeEmitProposal('contradict_oscillation', decision, episodeId, episodeContent, oscId, node.value);
          } else {
            // Mid-band reconcile (UPDATE-04 tombstone-always, no in-place rewrite):
            //   1. Tombstone the superseded node.
            //   2. Mint a brand-new id for the new current value, carrying the superseded
            //      node's CURRENT value as prev_value — this is the one-deep oscillation
            //      breadcrumb. Without this explicit carry, the new node would have
            //      prev_value=null (txUpsertNode only auto-carries on existing-id updates)
            //      and isOscillation() would always be false on the next contradiction (D-20).
            this.store.tombstone(decision.bestCandidateId);
            const reconciledId = newId();
            this.store.upsertNode({
              id: reconciledId,
              type: decision.claimType as 'entity' | 'fact' | 'schema',
              value: decision.claimValue,
              origin: decision.claimOrigin,
              prev_value: node.value, // explicit carry across tombstone-always boundary (D-20)
            });
            if (decision.claimVec) { this.store.setEmbedding(reconciledId, decision.claimVec); } // DEDUP-01: value==claimValue
            this.maybeWriteNodeTemporal(reconciledId, decision); // TEMP-02
            // SEAM-02 D-49: tombstone-and-replace → 'contradict_reconcile'
            this.sink.emit({
              event_type: 'contradict_reconcile',
              node_id: reconciledId,
              candidate_id: decision.bestCandidateId,
              episode_id: episodeId,
              value: decision.claimValue,
              origin: decision.claimOrigin,
              magnitude: decision.magnitude,
            });
            this.maybeEmitProposal('contradict_reconcile', decision, episodeId, episodeContent, reconciledId, node.value);
          }
        } else if (action === 'append-new') {
          // Extreme / categorical: genuine divergence — both values coexist (no tombstone)
          const appendNewId = newId();
          this.store.upsertNode({
            id: appendNewId,
            type: decision.claimType as 'entity' | 'fact' | 'schema',
            value: decision.claimValue,
            origin: decision.claimOrigin,
          });
          if (decision.claimVec) { this.store.setEmbedding(appendNewId, decision.claimVec); } // DEDUP-01: value==claimValue
          this.maybeWriteNodeTemporal(appendNewId, decision); // TEMP-02
          // SEAM-02 D-49: extreme divergence → 'contradict_append_new'
          this.sink.emit({
            event_type: 'contradict_append_new',
            node_id: appendNewId,
            candidate_id: decision.bestCandidateId,
            episode_id: episodeId,
            value: decision.claimValue,
            origin: decision.claimOrigin,
            magnitude: decision.magnitude,
          });
          this.maybeEmitProposal('contradict_append_new', decision, episodeId, episodeContent, appendNewId, node.value);
        } else {
          // action === 'hold'
          // D-19: record ONLY if the episode is provenance-eligible.
          // Drop: (a) inferred-origin claims (mirrors the strengthen() origin-guard) AND
          //       (b) episodes with source_inference_id set (echoes of prior inferred output).
          // An inferred echo can neither strengthen nor destabilize a fact.
          if (
            decision.claimOrigin !== 'inferred' &&
            decision.episodeSourceInferenceId === null
          ) {
            this.store.recordContradiction(decision.bestCandidateId, {
              episode_id: episodeId,
              session_id: decision.episodeSessionId,
              origin: decision.claimOrigin,
            } satisfies PendingContradiction);

            // Re-read node to get the freshly-appended pending_contradictions
            const updatedNode = this.store.getNode(decision.bestCandidateId);
            if (updatedNode) {
              // L-4: defensive parse — corrupt column returns [] so other claims remain processable
              const entries = safeParseContradictions(updatedNode.pending_contradictions);
              const distinctCount = countDistinctProvenance(entries);

              // D-16 (Phase 65): per-source force-destabilization threshold, falling back to
              // the global contradictionN — mirrors the consolSkipThresholdBySource idiom
              // above. The empty default map ({}) means every source falls back to the global
              // 3, so this is behavior-neutral until an entry is added; Plan 65-10's dry-run
              // supplies evidence for any entry.
              const threshold = this.config.contradictionNBySource[decision.episodeSource] ?? this.config.contradictionN;

              // Force-destabilize when N distinct independent sessions have contradicted
              // this node (Chen-2020 lock-in fix, D-19 / UPDATE-05 criterion 3).
              if (distinctCount >= threshold) {
                // Apply same D-20 oscillation guard to the forced reconcile
                if (isOscillation(decision.claimValue, updatedNode.prev_value)) {
                  // Flip-back via force-destabilize — append standalone (both coexist)
                  const fdOscId = newId();
                  this.store.upsertNode({
                    id: fdOscId,
                    type: decision.claimType as 'entity' | 'fact' | 'schema',
                    value: decision.claimValue,
                    origin: decision.claimOrigin,
                  });
                  if (decision.claimVec) { this.store.setEmbedding(fdOscId, decision.claimVec); } // DEDUP-01: value==claimValue
                  this.maybeWriteNodeTemporal(fdOscId, decision); // TEMP-02
                  // SEAM-02 D-49: force-destabilize (oscillation variant) → still 'contradict_force_destabilize'
                  this.sink.emit({
                    event_type: 'contradict_force_destabilize',
                    node_id: fdOscId,
                    candidate_id: decision.bestCandidateId,
                    episode_id: episodeId,
                    value: decision.claimValue,
                    origin: decision.claimOrigin,
                    magnitude: decision.magnitude,
                  });
                  this.maybeEmitProposal('contradict_force_destabilize', decision, episodeId, episodeContent, fdOscId, updatedNode.value);
                } else {
                  // Force-reconcile: tombstone old + set new current carrying prev_value (D-20)
                  this.store.tombstone(decision.bestCandidateId);
                  const fdId = newId();
                  this.store.upsertNode({
                    id: fdId,
                    type: decision.claimType as 'entity' | 'fact' | 'schema',
                    value: decision.claimValue,
                    origin: decision.claimOrigin,
                    prev_value: updatedNode.value, // carry breadcrumb (same as band reconcile)
                  });
                  if (decision.claimVec) { this.store.setEmbedding(fdId, decision.claimVec); } // DEDUP-01: value==claimValue
                  this.maybeWriteNodeTemporal(fdId, decision); // TEMP-02
                  // SEAM-02 D-49: N-distinct force-destabilize → 'contradict_force_destabilize'
                  this.sink.emit({
                    event_type: 'contradict_force_destabilize',
                    node_id: fdId,
                    candidate_id: decision.bestCandidateId,
                    episode_id: episodeId,
                    value: decision.claimValue,
                    origin: decision.claimOrigin,
                    magnitude: decision.magnitude,
                  });
                  this.maybeEmitProposal('contradict_force_destabilize', decision, episodeId, episodeContent, fdId, updatedNode.value);
                }
              } else {
                // Hold only (distinctCount < contradictionN) → 'contradict_hold'
                // SEAM-02 D-49: hold recorded, not yet force-destabilized
                this.sink.emit({
                  event_type: 'contradict_hold',
                  node_id: decision.bestCandidateId,
                  candidate_id: decision.bestCandidateId,
                  episode_id: episodeId,
                  value: decision.claimValue,
                  origin: decision.claimOrigin,
                  magnitude: decision.magnitude,
                });
              }
            }
          }
          // If not provenance-eligible: drop silently — no recordContradiction call, no emit.
        }
        break;
      }
    }
  }

  // ── Private: PE-gate routing for a secondary contradicted node (M2) ─────────

  /**
   * Apply the prediction-error gate to a secondary contradicted node.
   *
   * M2 design (plan 260611-ue6 Task 3): a judge verdict can list MULTIPLE contradicted
   * node ids (contradicted_ids). The primary id is handled by the existing applyDecision
   * contradict branch which includes D-20 oscillation guard and mints exactly one new node.
   * Every OTHER id in the list is routed here.
   *
   * Secondaries NEVER mint a new node — the primary already minted the single new current
   * value for this claim. The routing mirrors the primary branch for hold/force-destabilize,
   * tombstone (reconcile), and coexist (append-new), but without any upsertNode call.
   *
   * Threat mitigations:
   *  - T-UE6-01: only tombstone/hold/coexist routes; no confirm/extend/strengthen (no
   *    self-confirmation surface from secondary routing).
   *  - D-19: hold path applies the same provenance-eligibility gate as the primary — inferred-
   *    origin and echo episodes cannot destabilize secondaries.
   *  - D-20: oscillation guard does NOT apply here — secondaries carry no new value to compare.
   *  - T-02-ASYNC: pure sync method (no await); never called inside a db.transaction.
   *
   * Proposal-seam exclusion (66-04-PLAN.md:196, restated here because WR-03 of the v10
   * cross-review correctly noted the decision was only visible as an ABSENT call): this
   * method emits three event types that `isEmissionEligible` accepts — contradict_reconcile,
   * contradict_append_new, contradict_force_destabilize — and deliberately does NOT route any
   * of them through the proposal gate, including the two branches that tombstone. The reason
   * is not that secondaries are harmless: it is that a secondary is an ADDITIONAL prior node
   * contradicted by the SAME claim the primary branch already emitted a proposal for. Routing
   * secondaries through the gate would mint N proposals for one transition, identical in
   * entity, change_field, and change_to and differing only in belief_node_id — N decision
   * cards for one human decision, which is the approval-fatigue failure mode the whole seam
   * exists to avoid. The primary's proposal names the transition; the secondaries are
   * bookkeeping against superseded prior nodes and have no from→to a consumer could act on.
   * This exclusion is behaviorally locked by the zero-row assertion in
   * tests/action-proposal-emission.test.ts — do not "fix" it by adding a gate call here.
   */
  private applySecondaryContradiction(
    nodeId: string,
    decision: ClaimDecision,
    episodeId: string,
  ): void {
    const node = this.store.getNode(nodeId);
    if (!node || node.tombstoned) return;

    // DRIFT-01..04 (Phase 65): same drift consultation as the primary branch, evaluated per
    // SECONDARY node id — "most recent supporting evidence" is a property of the node being
    // contradicted, not of the claim, so this cannot be hoisted to a single claim-level check.
    // Confidence damping resolves to the same factor as the primary branch because it is a
    // claim-level property; that is expected, not duplicated logic. `return` here is this
    // void-returning method's equivalent of the primary branch's `break` — it short-circuits
    // before any routing, recordContradiction, or sink emit for this secondary.
    this.driftEvaluations++;
    const drift = this.statusDrift.evaluate({
      magnitude: decision.magnitude,
      confidence: decision.claimIntentConfidence,
      claimEventTs: decision.episodeEventTs,
      candidateNodeId: nodeId,
    });
    if (drift.action === 'drop') {
      this.driftStaleDropped++;
      return;
    }
    const driftMagnitude = drift.magnitude;
    if (drift.damped) this.driftDamped++;
    if (drift.staleness === 'unknown-claim-ts' || drift.staleness === 'unknown-prior-ts') {
      this.driftEventTsUnknown++;
    }

    const effectiveS = this.strength.effectiveStrength(
      node.s, node.last_access, this.clock.nowMs(), this.config.lambda,
    );
    const resistance = effectiveS * node.c; // D-16
    const action = routeContradiction(driftMagnitude, resistance, this.config);

    if (action === 'reconcile') {
      // Tombstone only — primary already minted the new current node (no D-20 guard needed:
      // secondaries carry no new value and cannot oscillate)
      this.store.tombstone(nodeId);
      this.sink.emit({
        event_type: 'contradict_reconcile',
        node_id: nodeId,
        candidate_id: nodeId,
        episode_id: episodeId,
        value: decision.claimValue,
        origin: decision.claimOrigin,
        magnitude: decision.magnitude,
      });
    } else if (action === 'append-new') {
      // Established secondary: genuine divergence → leave live (coexists with primary's new node).
      // Audit-only emit; no graph mutation, no mint.
      this.sink.emit({
        event_type: 'contradict_append_new',
        node_id: nodeId,
        candidate_id: nodeId,
        episode_id: episodeId,
        value: decision.claimValue,
        origin: decision.claimOrigin,
        magnitude: decision.magnitude,
      });
    } else {
      // hold — apply the same D-19 provenance-eligibility gate as the primary
      if (
        decision.claimOrigin !== 'inferred' &&
        decision.episodeSourceInferenceId === null
      ) {
        this.store.recordContradiction(nodeId, {
          episode_id: episodeId,
          session_id: decision.episodeSessionId,
          origin: decision.claimOrigin,
        } satisfies PendingContradiction);

        const updatedNode = this.store.getNode(nodeId);
        if (updatedNode) {
          const entries = safeParseContradictions(updatedNode.pending_contradictions);
          const distinctCount = countDistinctProvenance(entries);

          // D-16 (Phase 65): same per-source threshold lookup as the primary branch — both
          // sites are converted so a partial conversion cannot leave this path on a different
          // bar (T-65-08-THRESH).
          const threshold = this.config.contradictionNBySource[decision.episodeSource] ?? this.config.contradictionN;

          if (distinctCount >= threshold) {
            // Force-destabilize secondary: tombstone only (no mint — primary already minted)
            this.store.tombstone(nodeId);
            this.sink.emit({
              event_type: 'contradict_force_destabilize',
              node_id: nodeId,
              candidate_id: nodeId,
              episode_id: episodeId,
              value: decision.claimValue,
              origin: decision.claimOrigin,
              magnitude: decision.magnitude,
            });
          } else {
            // Hold only — distinctCount < contradictionN; record persisted, not yet destabilized
            this.sink.emit({
              event_type: 'contradict_hold',
              node_id: nodeId,
              candidate_id: nodeId,
              episode_id: episodeId,
              value: decision.claimValue,
              origin: decision.claimOrigin,
              magnitude: decision.magnitude,
            });
          }
        }
      }
      // Not provenance-eligible: drop silently — mirrors primary D-19 rule
    }
  }
}
