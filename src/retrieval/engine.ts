/**
 * RetrievalEngine — LLM-free online retrieval over the consolidated graph (RET-01/RET-02).
 *
 * Design decisions:
 *  - Read-only on the graph: never writes s/c/last_access/embeddings (spec §8).
 *  - LLM-free: no API calls; all cost lives in the offline sleep pass (PROJECT.md).
 *  - Clock-injectable: all time reads via this.clock.nowMs() (D-12); the global
 *    time function is never called directly inside this file.
 *  - Dependency-injected: all collaborators passed via constructor for testability.
 *  - Prepared statements compiled once in constructor — never per-call (T-01-SQL).
 *
 * Threat mitigations:
 *  - T-03-1-E: effectiveStrength() is the ONLY strength call (pure, no side effects);
 *    the write-path decay method is a graph write (single-writer, spec §8) and is
 *    never invoked from this class.
 *  - T-03-1-T: getOutEdges/topkTombstoned use bound params; no string interpolation.
 *  - T-03-1-I: token-budget cap (injectionTokenBudget×4 chars) bounds injected content.
 */
import Database from 'better-sqlite3';
import type { Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { NodeRow } from '../lib/types';
import { CandidateRetriever } from './topk';
import { StrengthDecayManager } from '../strength/decay';
import { SemanticStore } from '../db/semantic-store';
import { AllocationGate } from '../gate/allocation-gate';
import type { ActivationTraceSink } from '../viz/activation-sink';
import { NoopActivationTraceSink } from '../viz/activation-sink';
import { newId } from '../lib/hash';

export type RetrieveStatus = 'ok' | 'deleted' | 'unreachable';

export interface RetrieveResult {
  results: Array<{ id: string; value: string; score: number }>;
  status: RetrieveStatus;
}

/** Number of seeds to spread activation from (top base-ranked nodes). */
const SEED_K = 10;

/** Char-per-token proxy used throughout (same as live hooks: budget × 4). */
const CHARS_PER_TOKEN = 4;

export class RetrievalEngine {
  private readonly clock: Clock;
  private readonly config: EngineConfig;
  private readonly retriever: CandidateRetriever;
  private readonly store: SemanticStore;
  private readonly strength: StrengthDecayManager;
  private readonly gate: AllocationGate;
  private readonly traceSink: ActivationTraceSink;
  /** D-97: derived once in ctor so the Noop path pays zero per-call cost. */
  private readonly traceEnabled: boolean;

  // Prepared statement compiled once — SELECT all live nodes for cue-less rank
  // CRITICAL: effectiveStrength() is the ONLY strength call legal from this path.
  // The write-path decay method is a single-writer violation here (spec §8) — never called.
  // All time reads go through this.clock.nowMs() — the global time fn is not used here (D-12).
  private readonly stmtGetAllLiveNodes: Database.Statement;

  // DEBT-06 cwd soft filter statements (compiled once in constructor — T-01-SQL).
  // stmtGetProjectNodeIds: node IDs that have ≥1 supporting episode with the given cwd.
  // stmtGetGlobalNodeIds:  node IDs whose ALL supporting episodes have cwd='' (global facts).
  private readonly stmtGetProjectNodeIds: Database.Statement;
  private readonly stmtGetGlobalNodeIds: Database.Statement;

  constructor(
    db: Database.Database,
    clock: Clock,
    config: EngineConfig,
    retriever: CandidateRetriever,
    store: SemanticStore,
    strength: StrengthDecayManager,
    gate: AllocationGate,
    traceSink: ActivationTraceSink = new NoopActivationTraceSink(),
  ) {
    this.clock = clock;
    this.config = config;
    this.retriever = retriever;
    this.store = store;
    this.strength = strength;
    this.gate = gate;
    this.traceSink = traceSink;
    // D-97: derive once so the Noop hot path pays zero per-call work (no instanceof per query).
    this.traceEnabled = !(traceSink instanceof NoopActivationTraceSink);

    // Read all non-tombstoned nodes for cue-less rank.
    // origin included for L-6: inferred-origin nodes are excluded from hard_keep pinning.
    this.stmtGetAllLiveNodes = db.prepare(
      'SELECT id, value, s, last_access, origin FROM node WHERE tombstoned = 0'
    );

    // DEBT-06 Option A: cwd soft filter helpers (T-09-05: cwd bound as param, never interpolated).
    // Returns node_ids that have at least one supporting episode matching the given cwd.
    this.stmtGetProjectNodeIds = db.prepare(`
      SELECT DISTINCT ce.node_id
      FROM consolidation_event ce
      JOIN episode e ON ce.episode_id = e.id
      WHERE e.cwd = ? AND ce.node_id IS NOT NULL
    `);

    // Returns node_ids whose ALL supporting episodes have cwd='' (globally-visible facts).
    // HAVING MAX(...) = 0 ensures every linked episode has cwd='' (none have a project cwd).
    // Only includes nodes that have at least one consolidation_event entry.
    this.stmtGetGlobalNodeIds = db.prepare(`
      SELECT ce.node_id
      FROM consolidation_event ce
      JOIN episode e ON ce.episode_id = e.id
      WHERE ce.node_id IS NOT NULL AND ce.episode_id IS NOT NULL
      GROUP BY ce.node_id
      HAVING MAX(CASE WHEN e.cwd != '' THEN 1 ELSE 0 END) = 0
    `);
  }

  /**
   * Cue-less bulk retrieval: rank all live nodes by effective strength, apply 1-hop
   * spreading activation, pin hard_keep nodes first, fill to token budget.
   *
   * When `cwd` is a non-empty string, applies a SOFT filter (DEBT-06 / D-93):
   *   - Include nodes whose supporting episodes contain ≥1 episode with `cwd = cwd` (project-specific).
   *   - Include nodes whose ALL supporting episodes have `cwd = ''` (global/older facts — always shown).
   *   - Exclude nodes supported only by episodes from other cwds (cross-project bleed).
   *
   * When `cwd` is undefined or '' (no project context), returns all live nodes (backward-compat).
   *
   * Returns { results, status: 'ok' } — status is always 'ok' (no cue to miss).
   *
   * RET-01 / D-24/26/27/28 / DEBT-06.
   */
  retrieveCueless(cwd?: string): RetrieveResult {
    const nowMs = this.clock.nowMs();

    // ── Step 1: Compute base scores for all live nodes ─────────────────────────
    // D-24: score = w_s·effective_s + w_r·recency(last_access).
    // NOTE: effective_s already encodes recency via exp(−λ·Δt since last_access).
    // w_r > 0 double-counts the same Δt — keep w_r ≈ 0 (DEFAULT_CONFIG = 0.0)
    // unless dogfood shows effective_s alone misses fresh-session recall (D-24 caveat).
    let rows = this.stmtGetAllLiveNodes.all() as Array<{
      id: string;
      value: string;
      s: number;
      last_access: number;
      origin: string;
    }>;

    // ── DEBT-06 cwd soft filter (Option A / D-93) ───────────────────────────────
    // When cwd is provided, restrict the candidate set to:
    //   - project-specific nodes: ≥1 supporting episode with matching cwd, AND
    //   - global nodes: all supporting episodes have cwd='' (evidence-backed global facts).
    // Orphan nodes (no consolidation_event entries) are excluded in cwd-scoped calls.
    // When cwd is empty/undefined, behavior is identical to today (all live nodes).
    if (cwd) {
      const projectIds = new Set<string>(
        (this.stmtGetProjectNodeIds.all(cwd) as Array<{ node_id: string }>)
          .map(r => r.node_id),
      );
      const globalIds = new Set<string>(
        (this.stmtGetGlobalNodeIds.all() as Array<{ node_id: string }>)
          .map(r => r.node_id),
      );
      rows = rows.filter(r => projectIds.has(r.id) || globalIds.has(r.id));
    }

    const scores = new Map<string, number>();
    const nodeValues = new Map<string, string>();
    // L-6: track origin per node so inferred nodes can be excluded from hard_keep pinning.
    const nodeOrigins = new Map<string, string>();

    for (const row of rows) {
      const eff = this.strength.effectiveStrength(
        row.s,
        row.last_access,
        nowMs,
        this.config.lambda,
      );
      // Recency shape for w_r term: exponential decay matching effective_s form.
      // With default w_r=0.0 this term drops out entirely.
      const deltaDays = (nowMs - row.last_access) / 86_400_000;
      const recency = Math.exp(-this.config.lambda * deltaDays);

      scores.set(row.id, this.config.rankWeightS * eff + this.config.rankWeightR * recency);
      nodeValues.set(row.id, row.value);
      nodeOrigins.set(row.id, row.origin);
    }

    // ── Step 2: 1-hop spreading activation from top base-ranked seeds ──────────
    // D-26: seeds = top SEED_K nodes by base score.
    // D-27: traverse both 'relation' and 'abstracts' edges (abstracts is a no-op
    //       this phase — no schema nodes yet — but path is forward-compatible with
    //       Phase 4 at zero rework).
    // D-28: additive boost = seed_score × edge_w × spreadDecay; then global re-rank.
    const sortedByBase = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
    const seeds = sortedByBase.slice(0, SEED_K);

    for (const [seedId, seedScore] of seeds) {
      const edges = this.store.getOutEdges(seedId);
      for (const edge of edges) {
        // Exclude tombstoned neighbors (T-02-STALE / consistent with topk filter)
        const neighbor = this.store.getNode(edge.dst);
        if (!neighbor || neighbor.tombstoned === 1) continue;

        // Additive boost to the neighbor's score (D-28)
        const boost = seedScore * edge.w * this.config.spreadDecay;
        scores.set(edge.dst, (scores.get(edge.dst) ?? 0) + boost);

        // Ensure neighbor is in the value map (it should already be from the live scan;
        // this guard handles any edge that points to a node not yet seen)
        if (!nodeValues.has(edge.dst)) {
          nodeValues.set(edge.dst, neighbor.value);
        }
      }
    }

    // ── Step 3: Re-rank all nodes (seeds + activated neighbors) by final score ──
    const finalRanked = Array.from(scores.entries())
      .filter(([id]) => nodeValues.has(id))
      .sort((a, b) => b[1] - a[1]);

    // ── Trace emission (D-97 guarded): zero work on the Noop/session-start path ─
    // Seeds payload + 1-hop hops payload built ONLY inside the guard — no cost when Noop.
    // T-10-05: wrapped in try/catch fire-and-forget so a sink error never corrupts results.
    if (this.traceEnabled) {
      try {
        const seedIds = seeds.map(([id]) => id);
        // Collect activated neighbors: nodes whose score was boosted in the spread loop.
        // We track these by iterating seeds again and reading their out-edges from the scores map.
        const hopEntries: Array<{ node_id: string; score: number; hop: number }> = [];
        const seenInHops = new Set<string>();
        for (const [seedId] of seeds) {
          const edges = this.store.getOutEdges(seedId);
          for (const edge of edges) {
            if (seenInHops.has(edge.dst)) continue;
            seenInHops.add(edge.dst);
            const score = scores.get(edge.dst);
            if (score !== undefined) {
              hopEntries.push({ node_id: edge.dst, score, hop: 1 });
            }
          }
        }
        this.traceSink.emit({ query_id: newId(), seeds: seedIds, hops: hopEntries });
      } catch {
        // Fire-and-forget: a sink failure must never surface to the caller (T-10-05).
      }
    }

    // ── Step 4: hard_keep pin + token-budget fill (D-24/D-25) ──────────────────
    // hard_keep nodes always go first — never budget-capped (D-24).
    // Regular nodes fill remaining chars up to injectionTokenBudget × 4 (D-25).
    const budgetChars = this.config.injectionTokenBudget * CHARS_PER_TOKEN;

    const hardKeep: Array<{ id: string; value: string; score: number }> = [];
    const regular: Array<{ id: string; value: string; score: number }> = [];

    for (const [id, score] of finalRanked) {
      const value = nodeValues.get(id)!;
      // L-6: inferred-origin nodes are excluded from hard_keep pinning — they must not
      // re-inject assistant-minted content unconditionally (amplifies the C-2 loop).
      // Only user/tool-origin (observed/asserted_by_user) nodes with directive vocabulary pin.
      if (this.gate.score(value, 'user').hardKeep && nodeOrigins.get(id) !== 'inferred') {
        hardKeep.push({ id, value, score });
      } else {
        regular.push({ id, value, score });
      }
    }

    // hard_keep nodes included unconditionally (pinned before budget accounting)
    const results: Array<{ id: string; value: string; score: number }> = [...hardKeep];
    let chars = hardKeep.reduce((sum, n) => sum + n.value.length, 0);

    // Fill remaining budget with regular nodes in rank order
    for (const node of regular) {
      if (chars + node.value.length > budgetChars) break;
      results.push(node);
      chars += node.value.length;
    }

    return { results, status: 'ok' };
  }

  /**
   * Point-lookup retrieval with optional pre-computed cue vector.
   *
   * - No cue → returns retrieveCueless() (D-30).
   * - With cue → Pass 1 scans live nodes; if best cosine ≥ deletedSimilarityThreshold
   *   returns that node with status 'ok'. Pass 2 scans tombstoned nodes; best cosine
   *   ≥ threshold → 'deleted'; otherwise 'unreachable' (D-29/D-30/RET-02).
   *
   * Never embeds a cue here (all embedding cost lives in the offline pass).
   * Never calls the write-path decay method (single-writer, spec §8).
   */
  retrieve(queryVec?: Float32Array): RetrieveResult {
    // No cue → cue-less bulk inject (D-30)
    if (queryVec === undefined) return this.retrieveCueless();

    // Pass 1: scan live (non-tombstoned) nodes
    const liveHits = this.retriever.topk(queryVec, this.config.candidateK);
    const bestLive = liveHits[0];
    if (bestLive !== undefined && bestLive.score >= this.config.deletedSimilarityThreshold) {
      const node = this.store.getNode(bestLive.id);
      if (node) {
        return {
          results: [{ id: bestLive.id, value: node.value, score: bestLive.score }],
          status: 'ok',
        };
      }
    }

    // Pass 2: scan tombstoned nodes for 'deleted' classification (D-29)
    const tombHits = this.retriever.topkTombstoned(queryVec, this.config.candidateK);
    const bestTomb = tombHits[0];
    if (bestTomb !== undefined && bestTomb.score >= this.config.deletedSimilarityThreshold) {
      return { results: [], status: 'deleted' };
    }

    // Neither live nor tombstoned match clears threshold → unreachable
    return { results: [], status: 'unreachable' };
  }
}
