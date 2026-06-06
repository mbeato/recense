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
import Database from 'better-sqlite3';
import { realClock, type Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { EpisodicStore } from '../db/episode-store';
import type { SemanticStore } from '../db/semantic-store';
import type { StrengthDecayManager } from '../strength/decay';
import type { CandidateRetriever } from '../retrieval/topk';
import type { Embedder } from '../model/embedder';
import type { Judge, JudgeRelation } from '../model/judge';
import type { ClaimExtractor } from '../model/claim-extractor';
import type { Origin, PendingContradiction } from '../lib/types';
import { newId } from '../lib/hash';
import { normalizeValue } from './normalize';
import { routeContradiction, isOscillation, countDistinctProvenance } from './update-decision';

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
  private readonly embedder: Embedder;
  private readonly judge: Judge;
  private readonly extractor: ClaimExtractor;
  private readonly config: EngineConfig;
  private readonly clock: Clock;

  constructor(
    db: Database.Database,
    episodes: EpisodicStore,
    store: SemanticStore,
    strength: StrengthDecayManager,
    retriever: CandidateRetriever,
    embedder: Embedder,
    judge: Judge,
    extractor: ClaimExtractor,
    config: EngineConfig,
    clock: Clock = realClock,
  ) {
    this.db = db;
    this.episodes = episodes;
    this.store = store;
    this.strength = strength;
    this.retriever = retriever;
    this.embedder = embedder;
    this.judge = judge;
    this.extractor = extractor;
    this.config = config;
    this.clock = clock;
  }

  // ── Private helper: re-embed dirty nodes in batch ───────────────────────

  /**
   * SELECT all nodes WHERE embedded_hash IS NULL, batch-embed their values,
   * then call store.setEmbedding() for each. The ONLY embedding writer path.
   * After this runs, newly appended/changed nodes are nominable via topk.
   */
  private async reembedDirty(): Promise<void> {
    const dirtyRows = this.db
      .prepare('SELECT id, value FROM node WHERE embedded_hash IS NULL')
      .all() as Array<{ id: string; value: string }>;

    if (dirtyRows.length === 0) return;

    const values = dirtyRows.map(r => r.value);
    const vecs = await this.embedder.embed(values);

    // Synchronous writes after the await (T-02-ASYNC: no await inside any write)
    for (let i = 0; i < dirtyRows.length; i++) {
      this.store.setEmbedding(dirtyRows[i]!.id, vecs[i]!);
    }
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

    for (const episode of unconsolidated) {
      // CONSOL-01: per-role skip — assistant turns have a higher threshold because they
      // average 4.5× the length of user turns and are mostly restatement (D-13).
      // consolSkipThreshold (0.2) remains the default for user/tool roles.
      const skipThreshold = episode.role === 'assistant'
        ? this.config.consolSkipThresholdAssistant
        : this.config.consolSkipThreshold;
      if (episode.salience < skipThreshold && episode.hard_keep === 0) {
        continue;
      }

      // ── Per-episode Phase A: all async work into plain array ───────────
      const claimOrigin: Origin = episode.origin; // inherit episode origin (T-02-SELFCONF)
      const claims = await this.extractor.extract(episode.content, episode.role);
      const decisions: ClaimDecision[] = [];

      // Batch-embed all claim query vectors in ONE call (T-02-ASYNC: Phase A, before any
      // db.transaction). Empty-claims episodes make zero embed calls.
      const claimValues = claims.map(c => c.value);
      const claimVecs = claimValues.length > 0
        ? await this.embedder.embed(claimValues)
        : [];

      for (let claimIdx = 0; claimIdx < claims.length; claimIdx++) {
        const claim = claims[claimIdx]!;
        const queryVec = claimVecs[claimIdx];
        if (!queryVec) continue;

        const candidates = this.retriever.topk(queryVec, this.config.candidateK);

        let relation: JudgeRelation;
        let bestCandidateId: string | null = null;
        let magnitude = 0; // only meaningful for 'contradict' (D-15)

        // D-17: zero-inference fast path — normalized exact-match → confirm, no judge call
        const fastPathCandidate = candidates.find(
          c => normalizeValue(this.store.getNode(c.id)?.value ?? '') === normalizeValue(claim.value)
        );
        if (fastPathCandidate) {
          relation = 'confirm';
          bestCandidateId = fastPathCandidate.id;
        } else if (
          candidates.length === 0 ||
          candidates[0]!.score < this.config.unrelatedSimilarityThreshold
        ) {
          // UPDATE-02 safe-direction: low cosine → auto-unrelated, no judge call
          relation = 'unrelated';
          bestCandidateId = null;
        } else {
          // Escalate to judge — read candidate values from graph (UPDATE-01 "current value")
          const candidatesWithValues = candidates.map(c => ({
            id: c.id,
            value: this.store.getNode(c.id)?.value ?? '',
          }));
          const verdict = await this.judge.judge(claim.value, candidatesWithValues);
          relation = verdict.relation;
          bestCandidateId = verdict.best_candidate_id;
          magnitude = verdict.magnitude;
        }

        decisions.push({
          claimValue: claim.value,
          claimType: claim.type,
          claimOrigin,
          relation,
          bestCandidateId,
          episodeSessionId: episode.session_id,
          magnitude,
          episodeSourceInferenceId: episode.source_inference_id,
        });
      }

      // ── Per-episode Phase B: synchronous write — one transaction (CONSOL-02) ──
      // All decisions for this episode + markConsolidated in ONE atomic transaction.
      // No await inside (T-02-ASYNC). If a later episode's Phase A crashes, this
      // episode's checkpoint is already committed and will not be re-applied.
      const episodeId = episode.id;
      this.db.transaction(() => {
        for (const decision of decisions) {
          this.applyDecision(decision, episodeId);
        }
        this.episodes.markConsolidated(episodeId);
      })();
    }

    // ── Phase C: Re-embed nodes dirtied by this pass, then eviction sweep ──
    await this.reembedDirty();
    this.strength.runEvictionSweep();
  }

  // ── Private: apply a single claim decision within a transaction ──────────

  private applyDecision(decision: ClaimDecision, episodeId: string): void {
    switch (decision.relation) {
      case 'confirm': {
        if (decision.bestCandidateId) {
          // Pass inherited episode origin — StrengthDecayManager blocks 'inferred' (T-02-SELFCONF)
          this.strength.strengthen(decision.bestCandidateId, decision.claimOrigin);
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
          this.store.upsertEdge({
            src: decision.bestCandidateId,
            dst: newId_,
            rel: 'extends',
            w: 0.1,
            kind: 'relation',
          });
        } else {
          // extend with no candidate → treat as standalone (defensive)
          this.store.upsertNode({
            id: newId(),
            type: decision.claimType as 'entity' | 'fact' | 'schema',
            value: decision.claimValue,
            origin: decision.claimOrigin,
          });
        }
        break;
      }

      case 'unrelated': {
        this.store.upsertNode({
          id: newId(),
          type: decision.claimType as 'entity' | 'fact' | 'schema',
          value: decision.claimValue,
          origin: decision.claimOrigin,
        });
        break;
      }

      case 'contradict': {
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
            this.store.upsertNode({
              id: newId(),
              type: decision.claimType as 'entity' | 'fact' | 'schema',
              value: decision.claimValue,
              origin: decision.claimOrigin,
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
            this.store.upsertNode({
              id: newId(),
              type: decision.claimType as 'entity' | 'fact' | 'schema',
              value: decision.claimValue,
              origin: decision.claimOrigin,
              prev_value: node.value, // explicit carry across tombstone-always boundary (D-20)
            });
          }
        } else if (action === 'append-new') {
          // Extreme / categorical: genuine divergence — both values coexist (no tombstone)
          this.store.upsertNode({
            id: newId(),
            type: decision.claimType as 'entity' | 'fact' | 'schema',
            value: decision.claimValue,
            origin: decision.claimOrigin,
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
              const entries = JSON.parse(
                updatedNode.pending_contradictions,
              ) as PendingContradiction[];
              const distinctCount = countDistinctProvenance(entries);

              // Force-destabilize when N distinct independent sessions have contradicted
              // this node (Chen-2020 lock-in fix, D-19 / UPDATE-05 criterion 3).
              if (distinctCount >= this.config.contradictionN) {
                // Apply same D-20 oscillation guard to the forced reconcile
                if (isOscillation(decision.claimValue, updatedNode.prev_value)) {
                  // Flip-back via force-destabilize — append standalone (both coexist)
                  this.store.upsertNode({
                    id: newId(),
                    type: decision.claimType as 'entity' | 'fact' | 'schema',
                    value: decision.claimValue,
                    origin: decision.claimOrigin,
                  });
                } else {
                  // Force-reconcile: tombstone old + set new current carrying prev_value (D-20)
                  this.store.tombstone(decision.bestCandidateId);
                  this.store.upsertNode({
                    id: newId(),
                    type: decision.claimType as 'entity' | 'fact' | 'schema',
                    value: decision.claimValue,
                    origin: decision.claimOrigin,
                    prev_value: updatedNode.value, // carry breadcrumb (same as band reconcile)
                  });
                }
              }
            }
          }
          // If not provenance-eligible: drop silently — no recordContradiction call.
        }
        break;
      }
    }
  }
}
