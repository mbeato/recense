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
import type { EpisodicStore } from '../db/episode-store';
import type { SemanticStore } from '../db/semantic-store';
import type { StrengthDecayManager } from '../strength/decay';
import type { CandidateRetriever } from '../retrieval/topk';
import { cosineSimF32 } from '../retrieval/topk';
import type { JudgeRelation } from '../model/judge';
import type { ModelProvider } from '../model/provider';
import type { ExtractedClaim, ActionType } from '../model/claim-extractor';
import { extractClaimsWithChunking } from '../model/claim-extractor';
import { promptForSource } from '../source/extraction-prompts';
import type { Origin, PendingContradiction, EpisodeRow, EpisodeRole } from '../lib/types';
import { newId } from '../lib/hash';
import { normalizeValue } from './normalize';
import { routeContradiction, isOscillation, countDistinctProvenance } from './update-decision';
import type { SchemaInducer } from './schema-induction';
import { NoopSchemaRelationDeriver } from './schema-relations';
import type { SchemaRelationDeriver } from './schema-relations';
import { NoopConsolidationSink, type ConsolidationSink } from './sink';

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
   * TEMP-02: Calendar source event id parsed from provenance header (gcal episodes only).
   * null when source !== 'gcal' or the · Event: token is absent.
   */
  gcalSourceEventId?: string | null;
  /**
   * TEMP-02: RRULE string from provenance header (recurring gcal masters only).
   * null for one-off gcal events and all non-gcal sources (D-04).
   */
  gcalRecurrenceRule?: string | null;
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
  private readonly config: EngineConfig;
  private readonly clock: Clock;
  private readonly sink: ConsolidationSink;
  private readonly log: (msg: string) => void;

  // M1: prepared statements for entity-anchored candidate expansion (T-01-SQL).
  // Compiled once in the constructor; sync reads only (T-02-ASYNC — no await, never inside
  // a db.transaction). Mirrors the B2 stmtStaleEntityIds precedent in engine.ts:140-158.
  private readonly stmtProvenanceSiblingFacts: Statement<[string], { id: string; value: string }>;
  private readonly stmtLiveNodesForLinks: Statement<[], { id: string; value: string }>;

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
  ) {
    this.db = db;
    this.episodes = episodes;
    this.store = store;
    this.strength = strength;
    this.retriever = retriever;
    this.provider = provider;
    this.inducer = inducer;
    this.deriver = deriver;
    this.config = config;
    this.clock = clock;
    this.sink = sink;
    this.log = log;

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
  private async prefetchExtractions(episodes: EpisodeRow[]): Promise<Map<string, ExtractedClaim[] | Error>> {
    const results = new Map<string, ExtractedClaim[] | Error>();
    let idx = 0;

    const workerFn = async (): Promise<void> => {
      while (idx < episodes.length) {
        const episode = episodes[idx++]!;
        try {
          const promptPrefix =
            promptForSource(episode.source) + episode.role + '\n\nDocument content:\n';
          const claims = await extractClaimsWithChunking(
            this.provider,
            promptPrefix,
            episode.content,
          );
          results.set(episode.id, claims);
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
    const dirtyRows = this.db
      .prepare('SELECT id, value, value_hash FROM node WHERE embedded_hash IS NULL')
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
    const unconsolidated = this.episodes.listUnconsolidated();
    // H-2: track which episodes were quarantined this pass (for logging/observability).
    // Quarantined episodes are NOT marked consolidated — they will be retried next pass.
    const quarantine = new Set<string>();

    // ── Phase A optimization: prefetch claim extractions ────────────────────
    // Extraction depends only on episode content/source/role — never on graph state.
    // Hoist it before the ordered loop with a bounded pool (PREFETCH_CONCURRENCY=4).
    // Episodes are still processed in order below (EPISODE ORDER IS SEMANTICS: episode N's
    // claims are judged against graph state written by episodes 1..N-1). Only extraction
    // is parallelised; echo detection, embedding, judging, and all writes remain in order.
    const eligibleForPrefetch = unconsolidated.filter(ep => isEligibleForExtraction(ep, this.config));
    const prefetchedExtractions = await this.prefetchExtractions(eligibleForPrefetch);

    for (let episode of unconsolidated) {
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

        // ── Per-episode Phase A: all async work into plain array ───────────
        const claimOrigin: Origin = episode.origin; // inherit episode origin (T-02-SELFCONF)
        // Claim extraction via ModelProvider.generate (SEAM-01, D-46):
        // Consume prefetched result when available (see prefetchExtractions above).
        // If extraction failed for this episode, rethrow the stored error so H-2 quarantine
        // applies. Fallback to inline extraction if not in map (defensive — should not occur
        // for eligible episodes, but guards against unexpected eligibility-predicate drift).
        const prefetched = prefetchedExtractions.get(episode.id);
        let claims: ExtractedClaim[];
        if (prefetched !== undefined) {
          if (prefetched instanceof Error) throw prefetched;
          claims = prefetched;
        } else {
          // Inline fallback: prefetch skipped this episode (eligibility drift guard).
          // extractClaimsWithChunking handles both single and multi-chunk paths,
          // including the raised EXTRACTION_MAX_TOKENS and salvage parsing.
          const promptPrefix =
            promptForSource(episode.source) + episode.role + '\n\nDocument content:\n';
          claims = await extractClaimsWithChunking(this.provider, promptPrefix, episode.content);
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
            decisionSlots[claimIdx] = {
              claimValue: claim.value,
              claimType: claim.type,
              claimOrigin,
              relation: 'confirm',
              bestCandidateId: fastPathCandidate.id,
              episodeSessionId: episode.session_id,
              magnitude: 0,
              episodeSourceInferenceId: episode.source_inference_id,
              episodeRole: episode.role,
              contradictedIds: [],
              claimDueAt: claim.due_at,        // TEMP-02
              claimActionType: claim.action_type, // TEMP-02
              gcalSourceEventId,               // TEMP-02
              gcalRecurrenceRule,              // TEMP-02
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

            // UPDATE-02 refined gate: auto-unrelated fires ONLY when cosine gate is true
            // AND no anchor candidates exist. When anchors exist, fall through to judge
            // escalation regardless of cosine score (M1 distant-contradiction rescue).
            const cosineGate = candidates.length === 0 ||
              candidates[0]!.score < this.config.unrelatedSimilarityThreshold;

            if (cosineGate && anchors.length === 0) {
              // UPDATE-02 safe-direction: low cosine, no anchors → auto-unrelated, no judge call
              decisionSlots[claimIdx] = {
                claimValue: claim.value,
                claimType: claim.type,
                claimOrigin,
                relation: 'unrelated',
                bestCandidateId: null,
                episodeSessionId: episode.session_id,
                magnitude: 0,
                episodeSourceInferenceId: episode.source_inference_id,
                episodeRole: episode.role,
                contradictedIds: [],
                claimDueAt: claim.due_at,        // TEMP-02
                claimActionType: claim.action_type, // TEMP-02
                gcalSourceEventId,               // TEMP-02
                gcalRecurrenceRule,              // TEMP-02
              };
            } else {
              // Escalate to judge — cosine candidates first (D-17 precedence), anchors appended.
              // Reads current values from graph (UPDATE-01 "current value").
              const judgeCandidates = [
                ...candidates.map(c => ({
                  id: c.id,
                  value: this.store.getNode(c.id)?.value ?? '',
                })),
                ...anchors, // anchors carry value from SQL / stmtLiveNodesForLinks row
              ];
              pendingJudges.push({
                slotIdx: claimIdx,
                claimValue: claim.value,
                claimType: claim.type,
                candidates: judgeCandidates,
                claimDueAt: claim.due_at,        // TEMP-02
                claimActionType: claim.action_type, // TEMP-02
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
            magnitude: verdict.magnitude,
            episodeSourceInferenceId: episode.source_inference_id,
            episodeRole: episode.role,
            contradictedIds,
            claimDueAt: pendingJudges[i]!.claimDueAt,          // TEMP-02
            claimActionType: pendingJudges[i]!.claimActionType,  // TEMP-02
            gcalSourceEventId,                                    // TEMP-02
            gcalRecurrenceRule,                                   // TEMP-02
          };
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
        this.db.transaction(() => {
          for (const decision of decisions) {
            this.applyDecision(decision, episodeId);
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
    }

    // ── Phase C: Re-embed nodes dirtied by this pass, then eviction sweep ──
    await this.reembedDirty();
    // D-37: schema induction after Phase C reembedDirty(), before eviction.
    // Schemas depend on fresh embeddings; tombstoned schemas must be swept in the same pass.
    await this.inducer.induceSchemas();
    // D-07: schema-relation derivation after induceSchemas() (needs fresh centroids + schema nodes),
    // before runEvictionSweep(). Artifacts are disposable derived cache — a mid-derive crash
    // leaves wipe-then-rebuild-clean state on the next pass; no extra try/catch needed.
    await this.deriver.deriveSchemaRelations();
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

  // ── Private: apply a single claim decision within a transaction ──────────

  private applyDecision(decision: ClaimDecision, episodeId: string): void {
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
        } else {
          // extend with no candidate → treat as standalone (defensive)
          const standaloneId = newId();
          this.store.upsertNode({
            id: standaloneId,
            type: decision.claimType as 'entity' | 'fact' | 'schema',
            value: decision.claimValue,
            origin: decision.claimOrigin,
          });
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
        break;
      }

      case 'contradict': {
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

        // Route by PE magnitude / resistance (spec §4 step 3, D-15/D-16)
        const action = routeContradiction(decision.magnitude, resistance, this.config);

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

              // Force-destabilize when N distinct independent sessions have contradicted
              // this node (Chen-2020 lock-in fix, D-19 / UPDATE-05 criterion 3).
              if (distinctCount >= this.config.contradictionN) {
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
   */
  private applySecondaryContradiction(
    nodeId: string,
    decision: ClaimDecision,
    episodeId: string,
  ): void {
    const node = this.store.getNode(nodeId);
    if (!node || node.tombstoned) return;

    const effectiveS = this.strength.effectiveStrength(
      node.s, node.last_access, this.clock.nowMs(), this.config.lambda,
    );
    const resistance = effectiveS * node.c; // D-16
    const action = routeContradiction(decision.magnitude, resistance, this.config);

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

          if (distinctCount >= this.config.contradictionN) {
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
