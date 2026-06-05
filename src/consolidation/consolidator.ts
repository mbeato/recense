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
import type { Origin } from '../lib/types';
import { newId } from '../lib/hash';
import { normalizeValue } from './normalize';

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
}

interface EpisodeDecisionGroup {
  episodeId: string;
  decisions: ClaimDecision[];
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
      // CONSOL-01: skip low-salience non-hard-keep episodes
      if (episode.salience < this.config.consolSkipThreshold && episode.hard_keep === 0) {
        continue;
      }

      // ── Per-episode Phase A: all async work into plain array ───────────
      const claimOrigin: Origin = episode.origin; // inherit episode origin (T-02-SELFCONF)
      const claims = await this.extractor.extract(episode.content, episode.role);
      const decisions: ClaimDecision[] = [];

      for (const claim of claims) {
        const [queryVec] = await this.embedder.embed([claim.value]);
        if (!queryVec) continue;

        const candidates = this.retriever.topk(queryVec, this.config.candidateK);

        let relation: JudgeRelation;
        let bestCandidateId: string | null = null;

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
        }

        decisions.push({
          claimValue: claim.value,
          claimType: claim.type,
          claimOrigin,
          relation,
          bestCandidateId,
          episodeSessionId: episode.session_id,
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

  private applyDecision(decision: ClaimDecision, _episodeId: string): void {
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
        // HOLD — band routing (reconcile / append-new / force-destabilize) is Plan 03.
        // Record provenance-distinct contradiction entry on the candidate.
        if (decision.bestCandidateId) {
          this.store.recordContradiction(decision.bestCandidateId, {
            episode_id: _episodeId,
            session_id: decision.episodeSessionId,
            origin: decision.claimOrigin,
          });
        }
        break;
      }
    }
  }
}
