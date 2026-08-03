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
import { CandidateRetriever, cosineSimF32 } from './topk';
import { StrengthDecayManager } from '../strength/decay';
import { SemanticStore } from '../db/semantic-store';
import { AllocationGate } from '../gate/allocation-gate';
import type { ActivationTraceSink } from '../viz/activation-sink';
import { NoopActivationTraceSink } from '../viz/activation-sink';
import { buildHonestOneHopTrace, projectHopsForSink } from './honest-trace';
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

/**
 * Phase 55 D-01/D-02: per-seed cap on emitted 1-hop ambient trace edges. Named
 * tunable (mirrors the Phase 52 D-06 decay-constant precedent) — tune at the
 * founder visual checkpoint; the number only matters against the rendered feel.
 */
const AMBIENT_HOP_TOPN = 6;

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
  // H-5: set of node_ids that have AT LEAST ONE consolidation_event row (event-backed).
  // Nodes absent from this set (orphan/seeded nodes) are unioned in as global.
  private readonly stmtGetEventBackedNodeIds: Database.Statement;

  // B2 entity support-count invalidation (T-01-SQL: compiled once in constructor).
  // Returns entity node IDs to EXCLUDE from retrieveRanked: those that are event-backed,
  // have >=1 fact-sibling sharing a consolidation episode, and have NO live (tombstoned=0) fact-sibling.
  // H-5 orphan exception: entities with zero consolidation_event rows are NOT returned here
  // (the first EXISTS clause filters them out — same global-treat as retrieveCueless orphan union).
  // Indexed: idx_consolidation_event_node / idx_consolidation_event_episode (v5 schema migration).
  private readonly stmtStaleEntityIds: Database.Statement;

  // LEVER 2 (Phase 17): temporal support signal — MAX(episode.ts) per node via consolidation join.
  // Accepts a JSON array string of node IDs (json_each binding); returns one row per node that
  // has at least one consolidation_event row. Nodes absent from the result are orphans/seeded
  // corpus (no consolidation_event rows) → treated as undated, never demoted on missing data.
  // Indexed: idx_consolidation_event_node + idx_consolidation_event_episode (v5 schema).
  private readonly stmtLatestSupportTs: Database.Statement;

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

    // H-5: returns ALL node_ids that appear in at least one consolidation_event row.
    // Used to distinguish "event-backed" nodes (explicitly scoped to a project or global)
    // from "orphan" nodes (seeded corpus, pre-SEAM-02 consolidations) which have no event rows.
    // Orphan nodes are treated as global and always surface in cwd-scoped retrieval.
    this.stmtGetEventBackedNodeIds = db.prepare(
      'SELECT DISTINCT node_id FROM consolidation_event WHERE node_id IS NOT NULL'
    );

    // B2: entity nodes to exclude from retrieveRanked — event-backed entities whose every
    // fact-sibling (a fact node sharing >=1 consolidation episode) is tombstoned.
    // Subquery 1 (EXISTS ce): event-backed guard — entities with zero consolidation_event rows
    //   are orphans/seeded corpus (H-5) and are NOT returned → never filtered from results.
    // Subquery 2 (EXISTS a JOIN b JOIN f): fact-sibling exists — entity and fact share an episode.
    // Subquery 3 (NOT EXISTS ...tombstoned=0): no live fact-sibling remains.
    // Industry remedy (Graphiti / TMS): never cascade-delete entities; filter at recall instead.
    this.stmtStaleEntityIds = db.prepare(`
      SELECT DISTINCT e.id FROM node e
      WHERE e.type = 'entity'
        AND EXISTS (
          SELECT 1 FROM consolidation_event ce WHERE ce.node_id = e.id
        )
        AND EXISTS (
          SELECT 1 FROM consolidation_event a
          JOIN consolidation_event b ON a.episode_id = b.episode_id
          JOIN node f ON b.node_id = f.id
          WHERE a.node_id = e.id AND f.type = 'fact'
        )
        AND NOT EXISTS (
          SELECT 1 FROM consolidation_event a
          JOIN consolidation_event b ON a.episode_id = b.episode_id
          JOIN node f ON b.node_id = f.id
          WHERE a.node_id = e.id AND f.type = 'fact' AND f.tombstoned = 0
        )
    `);

    // LEVER 2 (Phase 17): MAX(episode.ts) per candidate node via the consolidation_event join.
    // The json_each(?) binding accepts a JSON array string so this statement is prepared once
    // and reused across calls (T-01-SQL). Only returns rows for nodes that have at least one
    // consolidation_event row — orphan/seeded nodes produce no row and stay undated.
    this.stmtLatestSupportTs = db.prepare(`
      SELECT ce.node_id, MAX(e.ts) AS latest_ts
      FROM consolidation_event ce
      JOIN episode e ON ce.episode_id = e.id
      WHERE ce.node_id IN (SELECT value FROM json_each(?))
      GROUP BY ce.node_id
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

    // ── DEBT-06 cwd soft filter (Option A / D-93) + H-5 orphan union ──────────────
    // When cwd is provided, restrict the candidate set to:
    //   - project-specific nodes: ≥1 supporting episode with matching cwd, AND
    //   - global nodes: all supporting episodes have cwd='' (evidence-backed global facts).
    //   - orphan (event-less) nodes treated as global (H-5): seeded corpus + pre-SEAM-02 nodes
    //     have zero consolidation_event rows and were previously invisible in cwd-scoped calls,
    //     silently gating 83% of the live graph. They are now unioned in unconditionally.
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
      // H-5: build event-backed set; nodes absent from it are orphans → treated as global.
      const eventBackedIds = new Set<string>(
        (this.stmtGetEventBackedNodeIds.all() as Array<{ node_id: string }>)
          .map(r => r.node_id),
      );
      rows = rows.filter(r =>
        projectIds.has(r.id) ||
        globalIds.has(r.id) ||
        !eventBackedIds.has(r.id)  // orphan (event-less) nodes treated as global (H-5)
      );
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
        // D-07: carry per-seed retrieval score into the presentation payload.
        // seedScore was already destructured at line 271; this additive change
        // surfaces it so the viz can render brightness ∝ score (inside the
        // existing T-10-05 fire-and-forget guard — zero impact on ranking/results).
        const seedPayload = seeds.map(([id, score]) => ({ node_id: id, score }));
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
        this.traceSink.emit({ query_id: newId(), seeds: seedPayload, hops: hopEntries });
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
   * Phase 55 (SC1/SC2/SC3): builds the honest ambient 1-hop trace payload for retrieveRanked's
   * fire-and-forget emit. Delegates to the shared `buildHonestOneHopTrace` helper (Phase 56
   * extraction, D-07 correctness spine) — the single source of truth for the honest 1-hop
   * filter, also imported by the Phase-56 spontaneous emitter so the filter can never drift
   * between the two callers. See honest-trace.ts for the full filter/sort/liveness rationale.
   * Read-only; callers wrap this in the existing try/catch fire-and-forget guard (T-10-05) —
   * this method itself does not swallow errors.
   */
  private buildAmbientTracePayload(
    seeds: Array<{ node_id: string; score: number }>,
  ): { seeds: Array<{ node_id: string; score: number }>; hops: Array<{ node_id: string; src: string; rel: string; score: null; hop: 1 }> } {
    return buildHonestOneHopTrace(seeds, this.store, AMBIENT_HOP_TOPN);
  }

  /**
   * Ranked top-k retrieval with cosine floor for the product question-answering path (memory_ask / B1).
   *
   * Returns the top-k live nodes whose cosine similarity to queryVec >= floor, sorted descending.
   * Below-floor and tombstoned nodes are absent: topk() already excludes tombstoned=1 (T-02-STALE),
   * and the floor gate is applied here.
   *
   * LEVER 1 (Phase 17): When `queryText` is provided, routes through hybridTopk (BM25+cosine RRF)
   * instead of pure cosine topk. The floor is applied to the cosine score component of fused
   * results (BM25-only hits have score=0 — they fail the 0.3 floor in product context by design;
   * the eval arm uses NO floor to allow all RRF-fused results through).
   * Existing 3-arg callers (HybridResponder, correctness harness) are byte-for-byte unchanged.
   *
   * LEVER 2 (Phase 17): When `opts.temporalAnnotate` or `config.temporalAnnotation` is true,
   * fetches MAX(episode.ts) per candidate via the consolidation_event→episode join, sorts
   * candidates newest-supported-first, and prefixes each value with `[YYYY-MM-DD]`. Orphan nodes
   * (no consolidation_event rows) are treated as undated and never demoted below dated nodes
   * purely on missing data — they maintain their original cosine/RRF rank position.
   *
   * B2 entity support-count invalidation: entity nodes that are event-backed, have >=1 fact-sibling
   * (sharing a consolidation_event episode_id), and have NO live (tombstoned=0) fact-sibling are
   * excluded. This prevents a stale "Biscuit is Ana's dog" entity node from winning a query after
   * its supporting facts are tombstoned (industry remedy: Graphiti / TMS filter-at-recall).
   * H-5 orphan exception: entities with zero consolidation_event rows are NOT filtered — they are
   * seeded/pre-SEAM-02 corpus treated as global (same as the retrieveCueless orphan union).
   *
   * Read-only: no graph writes (spec §8). LLM-free: no API calls (PROJECT.md).
   * DO NOT modify retrieve() or retrieveCueless() — D-29 deleted/unreachable classification and
   * the session-start budget logic depend on their existing behaviour.
   *
   * B1/B2/B3: used by HybridResponder facts-first branch and the correctness harness query step.
   *
   * RECALL-01 (Phase 69, D-02): `opts.anchoredIds` unions entity-anchored candidates (ids the
   * caller resolved via a SEPARATE lexical/indexed lookup, e.g. name-matched entity nodes) into
   * the result set. Anchored candidates are floor-EXEMPT — they cleared a different, lexical
   * bar in the caller's anchor module, not this method's cosine floor — but they are NEVER
   * stale-entity- or liveness-exempt: they pass through the exact same `staleEntityIds`/
   * `tombstoned` guard as every cosine hit (B2 discipline holds for anchored rows too). Each
   * anchored row's score is the REAL cosine of its stored embedding against `queryVec`
   * (clamped to [0,1]); a null or shape-mismatched embedding scores `0` — never a synthesized
   * magnitude (no-inflated-metrics). With `opts.anchoredIds` absent, the union is a no-op and
   * output is byte-identical to pre-phase (D-09).
   *
   * RECALL-03 (Phase 69, D-06): `opts.hopCollector` receives the FULL 1-hop trace (each hop
   * carrying `rel`) for every returned row — cosine AND anchored — computed via the SAME single
   * `buildAmbientTracePayload` pass this method already runs for the viz trace sink, never a
   * second edge-read pass. The sink itself keeps receiving exactly the hops it received
   * pre-phase (filtered back down to the viz-lit seed set, projected to the pre-phase 4-key
   * shape) — `hopCollector` is strictly additive.
   */
  retrieveRanked(
    queryVec: Float32Array,
    k: number,
    floor: number,
    queryText?: string,
    opts?: {
      temporalAnnotate?: boolean;
      vizFloor?: number;
      anchoredIds?: string[];
      hopCollector?: (hops: Array<{ node_id: string; src: string; rel: string; score: null; hop: 1 }>) => void;
    },
  ): Array<{ id: string; value: string; score: number }> {
    // LEVER 1: route through hybridTopk when queryText is supplied; else pure cosine topk.
    // hybridTopk returns results sorted by RRF rank; the cosine score component is preserved
    // in the score field (BM25-only hits get score=0) for the floor gate below.
    // Phase 35 RANK-01: pass strength weight + clock + lambda on the hybrid branch only (D-08).
    // The cue-less fallback (topk) is left entirely untouched — ambient-recall stays no-fusion.
    const hits = queryText
      ? this.retriever.hybridTopk(
          queryVec, queryText, k, undefined,
          this.config.rankStrengthWeight,
          this.clock.nowMs(),
          this.config.lambda,
          this.config.bm25FusionWeight,  // Phase 47 D-02: tunable BM25-list weight (dark=0 → pure cosine)
        )
      : this.retriever.topk(queryVec, k);

    // Apply floor to the cosine score component and resolve node values.
    // Pure cosine (no queryText): sorted descending → break early once below floor.
    // Hybrid (queryText): RRF order ≠ cosine order → can't break early; use continue.
    const candidates: Array<{ id: string; value: string; score: number }> = [];
    for (const hit of hits) {
      if (hit.score < floor) {
        if (!queryText) break; // pure cosine: sorted desc → all remaining also below floor
        else continue;         // hybrid: RRF rank interleaves BM25 hits → must scan all
      }
      const node = this.store.getNode(hit.id);
      if (!node) continue; // guard: node was deleted between topk scan and getNode
      candidates.push({ id: hit.id, value: node.value, score: hit.score });
    }

    // B2: build the stale-entity exclusion set once per call (prepared statement, T-01-SQL).
    // H-5: entities with zero consolidation_event rows are NOT in this set (orphan-is-global).
    const staleEntityIds = new Set<string>(
      (this.stmtStaleEntityIds.all() as Array<{ id: string }>).map(r => r.id),
    );
    const filtered = candidates.filter(r => !staleEntityIds.has(r.id));

    // ── RECALL-01 anchored union (Phase 69, D-02) ───────────────────────────────
    // Entity-anchored candidates union in here — AFTER staleEntityIds exists but BEFORE the
    // vizFloor lighting scan — so they travel through the SAME B2/liveness discipline as cosine
    // hits (engine B2 comment above, T-69-02-BYPASS): floor-EXEMPT (a different, lexical bar
    // already cleared them) but never stale-entity- or liveness-exempt. Score is the true cosine
    // of the stored embedding, decoded exactly as entity-resolution.ts's dense channel does
    // (byteLength % 4 guard, length-equality guard, Number.isFinite guard) — a null/unusable
    // embedding scores 0, never an invented magnitude (T-69-02-FAKE, no-inflated-metrics); the
    // row still appears because the caller asked for it by name, not by similarity.
    const anchoredRows: Array<{ id: string; value: string; score: number }> = [];
    if (opts?.anchoredIds && opts.anchoredIds.length > 0) {
      const filteredIds = new Set(filtered.map(r => r.id));
      // Defensive hot-path bound (T-69-02-DOS): the caller (the entity-anchor module) already
      // caps at MAX_ANCHORED_FACTS; this slice keeps this method's worst case bounded regardless
      // of caller discipline.
      for (const id of opts.anchoredIds.slice(0, 16)) {
        if (filteredIds.has(id)) continue; // already present via cosine — no duplicate row
        if (staleEntityIds.has(id)) continue; // B2: anchoring never bypasses the stale-entity filter
        const node = this.store.getNode(id);
        if (!node || node.tombstoned === 1) continue; // liveness: anchoring never bypasses tombstone
        let score = 0;
        const embedding = node.embedding;
        if (embedding && embedding.byteLength % 4 === 0) {
          const decoded = new Float32Array(embedding.buffer, embedding.byteOffset, embedding.byteLength / 4);
          if (decoded.length === queryVec.length) {
            const cos = Math.max(0, cosineSimF32(queryVec, decoded));
            score = Number.isFinite(cos) ? cos : 0;
          }
        }
        anchoredRows.push({ id, value: node.value, score });
      }
    }
    // Stable id-asc tiebreak keeps ordering deterministic when scores tie (matches the
    // dst-asc-tiebreak convention buildHonestOneHopTrace already uses, D-03 precedent).
    // D-09 byte-identity: when nothing was actually unioned in, skip the sort entirely and
    // keep `filtered`'s existing order verbatim — the hybrid (queryText) branch's order is RRF
    // rank, NOT score-sorted, so re-sorting unconditionally would silently reorder that branch's
    // output even with opts.anchoredIds absent.
    const unioned = anchoredRows.length > 0
      ? [...filtered, ...anchoredRows].sort(
          (a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
      : filtered;

    // Phase-19 viz lighting: when a vizFloor BELOW the injection floor is supplied,
    // the trace lights every node the topk scan GENUINELY retrieved down to vizFloor —
    // even when none cleared `floor` (a real read that surfaced nothing to the caller
    // still accessed real nodes; the founder's "thought hard, nothing came back, but I
    // did access real nodes" framing). The RETURNED/injected results are unchanged (still
    // gated at `floor`); this reuses the same scan (no extra cost). Honest by construction:
    // only ids the scan actually returned, minus stale entities; never synthesized, and if
    // the scan reached nothing ≥ vizFloor the set is empty (no fire).
    let vizSeedIds: string[] | null = null;
    // Phase 55 D-06: real cosine/RRF score per vizSeedId, captured alongside the id in the
    // same scan (no extra pass over hits) — resolved into the emitted seed payload below.
    let vizSeedScores: Map<string, number> | null = null;
    if (opts?.vizFloor != null && opts.vizFloor < floor) {
      const vf = opts.vizFloor;
      const cap = Math.max(k, 6);
      vizSeedIds = [];
      vizSeedScores = new Map<string, number>();
      for (const hit of hits) {
        if (hit.score < vf) { if (!queryText) break; else continue; }
        if (staleEntityIds.has(hit.id)) continue;
        vizSeedIds.push(hit.id);
        vizSeedScores.set(hit.id, hit.score);
        if (vizSeedIds.length >= cap) break;
      }
    }

    // LEVER 2: temporal annotation (driven by opts.temporalAnnotate OR config.temporalAnnotation).
    // Fetch MAX(episode.ts) per candidate via json_each binding (prepared once, T-01-SQL).
    // Orphan nodes have no consolidation_event rows → absent from tsMap → undated.
    // Sort: among dated nodes, newest-supported-first; undated nodes maintain their original
    // cosine/RRF rank position (stable sort by originalIndex when comparing dated vs undated).
    let finalResults: Array<{ id: string; value: string; score: number }>;
    if (opts?.temporalAnnotate ?? this.config.temporalAnnotation) {
      const nodeIdsJson = JSON.stringify(unioned.map(c => c.id));
      const tsRows = this.stmtLatestSupportTs.all(nodeIdsJson) as Array<{
        node_id: string;
        latest_ts: number;
      }>;
      const tsMap = new Map<string, number>(tsRows.map(r => [r.node_id, r.latest_ts]));

      // CR-01 fix: subsequence reorder — don't express "sort dated sub-sequence in place"
      // as a mixed comparator (intransitive when an undated node lies between two dated nodes).
      // Collect the original slot positions occupied by dated nodes (in original order),
      // sort those slot references newest-first, write the dated nodes back into those same
      // slots, and leave undated (orphan) nodes fixed at their original positions.
      const datedSlots: number[] = unioned
        .map((c, i) => (tsMap.has(c.id) ? i : -1))
        .filter((i): i is number => i !== -1);
      const datedSorted: number[] = datedSlots
        .slice()
        .sort((i, j) => tsMap.get(unioned[j]!.id)! - tsMap.get(unioned[i]!.id)!);
      const reordered = unioned.slice();
      datedSlots.forEach((slot, i) => { reordered[slot] = unioned[datedSorted[i]!]!; });
      // Apply [YYYY-MM-DD] prefix to dated nodes; leave undated (orphan) values unchanged.
      const annotated = reordered.map(c => {
        const ts = tsMap.get(c.id);
        if (ts !== undefined) {
          // Prefix with ISO date of the newest supporting episode
          const dateStr = new Date(ts).toISOString().slice(0, 10);
          return { ...c, value: `[${dateStr}] ${c.value}` };
        }
        return c; // orphan: undated, value unchanged
      });
      finalResults = annotated;
    } else {
      finalResults = unioned;
    }

    // ── Trace emission + hop hand-off (D-97 guarded, mirrors retrieveCueless ~L279-300) ──
    // retrieveRanked is flat top-k + floor + stale-entity filter (+ RECALL-01 anchored union)
    // — no spread loop ran, so the results ARE the seeds. Phase 55: hops are each seed's REAL
    // 1-hop kind==='relation' out-edges (WR-02: rank-only score:null, never an invented
    // magnitude). This makes HybridResponder's facts-first branch (the common memory_ask /
    // Telegram answer path) light the viz with honest spreading-activation pathways; the
    // inference fallback already emits via RecallEngine. Callers wired with the Noop sink
    // (correctness harness, session-start) have traceEnabled === false and skip the sink half.
    // Phase 55 (D-06): seed payload carries each seed's REAL cosine/RRF score; hops are the
    // seeds' real top-N live kind==='relation' out-edges (SC1/SC2/SC3), built via the shared
    // helper INSIDE this existing try/catch fire-and-forget guard (D-08).
    //
    // Phase 69 (Plan 02, RECALL-01/03, D-06): SAME shared block for both the temporal and
    // non-temporal return paths — buildAmbientTracePayload runs AT MOST ONCE per call on every
    // path. `emitSeeds` (the viz-lit set — unchanged from pre-phase) covers what the sink is
    // ALLOWED to see; `hopSeedIds` additionally covers every row actually being returned
    // (including RECALL-01 anchored rows) so `opts.hopCollector` gets hops for the injected
    // block's facts even when they never touched the viz-lit set. Only ONE call to
    // buildAmbientTracePayload computes hops for the union of both; the sink then re-derives its
    // pre-phase-identical payload by filtering that single hop array down to `src ∈ emitSeeds`.
    // Equivalence argument (T-69-02-SINK): buildHonestOneHopTrace is per-seed independent —
    // each seed's weight-sort/topN-cap/liveness walk and its (src,dst) dedup key are scoped to
    // that seed alone, so adding MORE seeds to the same pass never changes the hops produced for
    // seeds already in the batch. Filtering the combined-batch hop array down to
    // `src ∈ emitSeeds` therefore reproduces byte-for-byte what calling
    // buildAmbientTracePayload(emitSeeds) ALONE would have produced — so with no opts.anchoredIds
    // (hopSeedIds === emitSeeds ids), sink output is unchanged from pre-phase (D-09).
    const emitSeeds: Array<{ node_id: string; score: number }> = vizSeedIds
      ? vizSeedIds.map(id => ({ node_id: id, score: vizSeedScores!.get(id) ?? 0 }))
      : finalResults.map(r => ({ node_id: r.id, score: r.score }));
    if (this.traceEnabled || opts?.hopCollector != null) {
      try {
        const seedsForHopPass: Array<{ node_id: string; score: number }> = [];
        const seenHopSeedIds = new Set<string>();
        for (const s of emitSeeds) {
          if (seenHopSeedIds.has(s.node_id)) continue;
          seenHopSeedIds.add(s.node_id);
          seedsForHopPass.push(s);
        }
        for (const r of finalResults) {
          if (seenHopSeedIds.has(r.id)) continue;
          seenHopSeedIds.add(r.id);
          seedsForHopPass.push({ node_id: r.id, score: r.score });
        }
        const { hops } = this.buildAmbientTracePayload(seedsForHopPass);
        if (opts?.hopCollector != null) opts.hopCollector(hops);
        if (this.traceEnabled && emitSeeds.length > 0) {
          const emitSeedIdSet = new Set(emitSeeds.map(s => s.node_id));
          const sinkHops = hops.filter(h => emitSeedIdSet.has(h.src));
          this.traceSink.emit({ query_id: newId(), seeds: emitSeeds, hops: projectHopsForSink(sinkHops) });
        }
      } catch {
        // Fire-and-forget: neither a sink failure nor a collector throw may surface to the
        // caller (T-10-05, T-69-02-FAILOPEN).
      }
    }

    return finalResults;
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
