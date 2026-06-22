/**
 * RecallEngine — on-demand latency-tolerant recall with schema-prior compose (LEARN-02).
 *
 * This is the ONLY Phase-4 path that embeds online (D-41).
 * SessionStart and retrieval paths are NOT modified and remain cue-less/LLM-free.
 *
 * Design:
 *  - Online embed via ModelProvider.embed seam (D-41): one call per recall, off the hot path.
 *  - 1-hop neighborhood from bestMatch.getOutEdges (D-42): budget-capped, tombstoned excluded.
 *  - Schema identification: if the topk best match is a schema node, use it directly
 *    (Case A). Otherwise walk INCOMING edges of bestMatch — any edge with kind='abstracts'
 *    whose src is a live schema node resolves the prior (Case B, reverse-lookup).
 *    Schema-induction creates schema→member edges; most queries match members, so
 *    Case B is the common path (Fix-2, LEARN-02).
 *  - LLM compose via ModelProvider.generate (D-43, T-02-PARSE safe fallback).
 *  - Episode append: ONLY write in this path — origin='inferred', role='assistant', salience=0.
 *
 * Hard invariants:
 *  - NEVER calls store.upsertNode/upsertEdge/tombstone or strength.strengthen.
 *    The inference is NEVER a graph fact (LEARN-02 ephemeral-as-fact guarantee).
 *  - All time reads via this.clock.nowMs() (D-12).
 *  - Keys from process.env via SDK defaults — never literals, never logged (T-04-03-K, T-05-KEY).
 *  - Query is treated as data (embedded + placed in prompt as content), never executed
 *    or shell-interpolated (T-04-03-I).
 *
 * Threat mitigations:
 *  - T-04-03-I: query length-bounded (MAX_QUERY_BYTES); never shell-interpolated.
 *  - T-04-03-SC: no upsertNode/upsertEdge/strengthen calls. Asserted via source grep.
 *  - T-04-03-K: ModelProvider reads API keys from env via SDK defaults (DefaultModelProvider).
 *  - T-04-03-P: compose output parsed with safe fallback — null inference on malformed/empty.
 *  - T-04-03-R: SessionStart CLI unchanged; this is the only online-embed path in Phase 4.
 *  - T-04-03-Tlock: acquireLock before DB open in recall-cli (single-writer for D-43 append).
 *  - T-05-02-KEY: provider names logged, not keys — T-03-2 discipline preserved.
 */
import Database from 'better-sqlite3';
import type { Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { ModelProvider } from '../model/provider';
import { CandidateRetriever } from '../retrieval/topk';
import { SemanticStore } from '../db/semantic-store';
import { StrengthDecayManager } from '../strength/decay';
import { EpisodicStore } from '../db/episode-store';
import type { ActivationTraceSink } from '../viz/activation-sink';
import { NoopActivationTraceSink } from '../viz/activation-sink';
import { newId } from '../lib/hash';
import { GLOBAL_SCOPE } from '../lib/scope';
import type { Predicate } from '../model/typed-predicates';
import { loadGlossEmbeddings } from '../consolidation/gloss-embeddings';
import { matchPredicate, typedReach } from './typed-traversal';

// T-04-03-I: bound query length to cap compose prompt size (4 KB is generous)
const MAX_QUERY_BYTES = 4_000;

export interface RecallResult {
  /** The ephemeral schema-prior inference. null if no schema found or compose failed. */
  inference: string | null;
  /** The id of the logged inferred-origin episode (for source_inference_id backfill). */
  episodeId: string | null;
  /** Tagged 'inferred' — callers must treat this as ephemeral, never write it to the graph. */
  origin: 'inferred';
}

const NULL_RESULT: RecallResult = { inference: null, episodeId: null, origin: 'inferred' };

export class RecallEngine {
  private readonly clock: Clock;
  private readonly config: EngineConfig;
  /** ModelProvider — embed head used ONLY on this latency-tolerant path (D-41). */
  private readonly provider: ModelProvider;
  private readonly retriever: CandidateRetriever;
  private readonly store: SemanticStore;
  /**
   * StrengthDecayManager — kept in DI for constructor symmetry with sleep-pass-cli.
   * NEVER called from recall (ephemeral-as-fact guarantee, LEARN-02).
   */
  private readonly strength: StrengthDecayManager;
  private readonly episodes: EpisodicStore;
  private readonly traceSink: ActivationTraceSink;
  /** D-97: derived once in ctor so the Noop path pays zero per-call cost. */
  private readonly traceEnabled: boolean;
  /**
   * Phase 37 D-07: pre-loaded gloss embeddings for 12-way cosine predicate match.
   * Loaded ONCE at construction (Pitfall 4: never per-recall).
   * null when embedAndStoreGlosses has not yet been run → always falls back to neighborhood.
   * NEVER re-embedded in recall() — glosses are offline sleep-pass artifacts (T-37-12).
   */
  private readonly glossEmbeddings: Record<Predicate, Float32Array> | null;

  constructor(
    db: Database.Database, // part of DI pattern; all reads go through store/retriever
    clock: Clock,
    config: EngineConfig,
    provider: ModelProvider,
    retriever: CandidateRetriever,
    store: SemanticStore,
    strength: StrengthDecayManager,
    episodes: EpisodicStore,
    traceSink: ActivationTraceSink = new NoopActivationTraceSink(),
  ) {
    // Suppress unused-variable lint for the db parameter (held for DI symmetry):
    void db;
    this.clock = clock;
    this.config = config;
    this.provider = provider;
    this.retriever = retriever;
    this.store = store;
    this.strength = strength;
    this.episodes = episodes;
    this.traceSink = traceSink;
    // D-97: derive once so the Noop hot path pays zero per-call work.
    this.traceEnabled = !(traceSink instanceof NoopActivationTraceSink);
    // Phase 37 D-07: load gloss embeddings once at construction (Pitfall 4 — never per-recall).
    // If null (not yet embedded by sleep pass), matchPredicate will return null on every call
    // and recall will always fall through to the existing schema-neighborhood path.
    // loadGlossEmbeddings is a synchronous read from the meta table — zero online LLM cost (T-37-12).
    this.glossEmbeddings = loadGlossEmbeddings(store);
  }

  /**
   * Embed query cue online (D-41), assemble bounded 1-hop neighborhood, apply matched
   * schema as prior via LLM compose, log inference as an ephemeral inferred episode (D-43).
   *
   * Returns RecallResult tagged `origin:'inferred'`. `inference` and `episodeId` are null
   * when no schema is reachable, or when the compose output is empty/malformed (T-02-PARSE).
   *
   * Optional `scope` parameter (RECALL-01, D-01): when provided, the assembled neighborhood
   * is post-filtered to retain only members whose node_scope is `scope` OR `GLOBAL_SCOPE`.
   * Members with no scope annotation are treated as global (kept) — mirrors the ambient-recall
   * display rule (D-S6). Members from other named projects are excluded.
   *
   * IMPORTANT: scope filtering is applied AFTER the full neighborhood is assembled — AFTER
   * schema resolution (Case A/B) and topk. Scope NEVER enters CandidateRetriever/topk.ts
   * (D-S1: scope is provenance, not a retrieval signal). When the filtered neighborhood is
   * empty, NULL_RESULT is returned without an LLM compose call (D-05 discretion).
   *
   * NEVER calls store.upsertNode/upsertEdge/tombstone or strength.strengthen.
   * The ONLY write is episodes.append({ origin:'inferred', ... }).
   */
  async recall(query: string, sessionId: string, scope?: string): Promise<RecallResult> {
    // T-04-03-I: length-bound the query before use in the compose prompt
    const boundedQuery = query.slice(0, MAX_QUERY_BYTES);

    // ── (1) Online cue embed — the ONLY permitted online embed in Phase 4 (D-41) ──
    const [cueVec] = await this.provider.embed([boundedQuery]);
    if (!cueVec) return NULL_RESULT;

    // ── (2) Top match via CandidateRetriever ──────────────────────────────────
    const topHits = this.retriever.topk(cueVec, this.config.candidateK);
    const bestMatch = topHits[0];
    if (!bestMatch) return NULL_RESULT;

    // ── (D-06 / D-07): Typed-path branch — LLM-free 12-way cosine on pre-loaded glosses ──
    //
    // LANDMINE 3: cueVec is already computed above — REUSE it here. No new online embed.
    // matchPredicate returns null when glossEmbeddings is null (not yet embedded by sleep pass)
    // or when all 12 cosine similarities are below predicateGlossThreshold.
    //
    // If a predicate matches:
    //   - typedReach follows exactly ONE hop from bestMatch.id along that predicate.
    //   - Compose the inference from the small labeled-triple payload.
    //   - Log as origin='inferred' episode (same as the neighborhood path below).
    //   - RETURN immediately — D-06: typed path OR neighborhood, NEVER both.
    //
    // If typedReach returns empty (anchor has no matching typed edge):
    //   - Fall through to the existing schema-neighborhood assembly (don't return NULL).
    //
    // If matchPredicate returns null: skip this block entirely → existing assembly unchanged.
    //
    // INVARIANT (D-08 / LANDMINE 4 / T-37-09):
    //   NEVER calls store.upsertNode/upsertEdge/tombstone or strength.strengthen here.
    //   The only write is the origin='inferred' episode append below.
    const matchedPredicate = matchPredicate(
      cueVec,
      this.glossEmbeddings,
      this.config.predicateGlossThreshold,
    );

    if (matchedPredicate !== null) {
      // D-07: single-hop typed traversal (v1 spec, predicatePath.length=1).
      // Phase 37 go-live: seed from ALL top-K retrieval candidates, not just bestMatch.
      // Live entity fragmentation (e.g. "Max" vs "Max (design lead)") and fact-sentence
      // rank-1 hits frequently starve a single-anchor traversal of the clean entity that
      // holds the typed edges; unioning the candidate pool ~doubled live firing (25%→50%)
      // with no new embed/LLM call. typedReach dedups by dst and ranks by path weight.
      const typedFrontier = typedReach(
        this.store,
        topHits.map((h) => h.id),
        [matchedPredicate],
        this.config.recallNeighborhoodBudget,
      );

      if (typedFrontier.length > 0) {
        // Resolve node values for the typed frontier
        const typedNodes: Array<{ id: string; value: string }> = [];
        for (const nodeId of typedFrontier) {
          const n = this.store.getNode(nodeId);
          if (!n || n.tombstoned === 1) continue;
          typedNodes.push({ id: n.id, value: n.value });
        }

        if (typedNodes.length > 0) {
          // Compose inference from labeled-triple payload (anchor --predicate--> node)
          // D-08: NEVER calls upsertNode/upsertEdge/strengthen/tombstone
          const anchorNode = this.store.getNode(bestMatch.id);
          const anchorLabel = anchorNode ? anchorNode.value : bestMatch.id;
          const tripleLines = typedNodes
            .map(n => `- ${anchorLabel} ${matchedPredicate} ${n.value}`)
            .join('\n');

          let typedInference: string | null = null;
          try {
            // T-04-03-I: query placed as data content, never interpolated as code
            const prompt =
              `You are reasoning over typed relational facts from a memory graph.\n\n` +
              `Predicate: "${matchedPredicate}" (${anchorLabel} ${matchedPredicate} ...)\n\n` +
              `Typed facts:\n${tripleLines}\n\n` +
              `Question: ${boundedQuery}\n\n` +
              `Based on these typed facts, provide a concise factual answer. ` +
              `If you cannot make a meaningful inference, respond with exactly: null`;

            const text = (await this.provider.generate(prompt, { maxTokens: 512 })).trim();
            typedInference = (!text || text.toLowerCase() === 'null') ? null : text;
          } catch {
            // T-02-PARSE: on any error, return null inference rather than throwing
            typedInference = null;
          }

          if (typedInference) {
            // Log as ephemeral inferred episode — the ONLY write in this branch (D-43)
            // D-08 guard: NEVER calls upsertNode/upsertEdge/tombstone/strengthen
            const ep = this.episodes.append({
              content: typedInference,
              origin: 'inferred',
              salience: 0,
              hard_keep: 0,
              role: 'assistant',
              session_id: sessionId,
              source_inference_id: null,
            });
            // D-06: return immediately — typed path OR neighborhood, NEVER both
            return { inference: typedInference, episodeId: ep.id, origin: 'inferred' };
          }
        }
      }
      // typedFrontier was empty or inference failed → fall through to existing neighborhood assembly
    }

    // ── (3) Identify schema and assemble bounded 1-hop neighborhood (D-42) ───
    //
    // Schema identification strategy (two cases):
    //  A) bestMatch IS a schema node → use it directly as the prior.
    //     This fires when a query directly matches the schema's topic embedding.
    //  B) bestMatch is a member/fact/entity → walk INCOMING edges looking for a
    //     schema that abstracts this node via an 'abstracts' edge (schema→member).
    //     This is the common case: schema-induction creates schema→member edges,
    //     so member nodes are best cosine matches for specific queries. Without
    //     this reverse lookup, recall returns NULL for most natural queries.
    //
    // Neighborhood is assembled from the RESOLVED schemaNode's OUTGOING edges
    // (i.e. the schema's members) regardless of which case resolved it, so
    // context is consistent and complete whether the query hit the schema or a member.
    const bestMatchNode = this.store.getNode(bestMatch.id);
    if (!bestMatchNode || bestMatchNode.tombstoned === 1) return NULL_RESULT;

    let schemaNode: { id: string; value: string } | null = null;

    // Case A: best match is a schema node → use directly
    if (bestMatchNode.type === 'schema') {
      schemaNode = { id: bestMatchNode.id, value: bestMatchNode.value };
    }

    // Case B: reverse-lookup via incoming 'abstracts' edges (Fix-2, LEARN-02)
    // schema-induction creates schema→member edges; bestMatch is typically a member.
    if (!schemaNode) {
      const inEdges = this.store.getInEdges(bestMatch.id);
      for (const inEdge of inEdges) {
        if (inEdge.kind !== 'abstracts') continue;
        const srcNode = this.store.getNode(inEdge.src);
        if (!srcNode || srcNode.tombstoned === 1 || srcNode.type !== 'schema') continue;
        schemaNode = { id: srcNode.id, value: srcNode.value };
        break; // take the first non-tombstoned schema parent
      }
    }

    // No schema reachable → no fabricated inference (D-42)
    if (!schemaNode) return NULL_RESULT;

    // ── (REFLECT-02 / D-05): Insight surfacing branch — gated by insightSurfacingEnabled ──
    //
    // When a live, non-stale insight exists for the resolved schema, return it IN PLACE OF
    // the K=20 member neighborhood — one mode OR the other per query, never both (D-05).
    //
    // MATCH GATE = SCHEMA-ANCHOR RESOLUTION (no embedding):
    //   The insight is already anchored to the resolved schemaNode via a 'derived_from' in-edge.
    //   The getInEdges walk filtered to kind='derived_from' + src.type='insight' selects the
    //   insight directly — the schema IS the match key (recall already resolved it via Case A/B).
    //   DO NOT compare the query embedding against the insight: insights have a NULL embedding
    //   (doc-writer pattern), so any cueVec/topk comparison against the insight is dead code.
    //
    // FRESHNESS GATE (D-06):
    //   An insight is stale iff ANY of its derived_from member dependencies is tombstoned OR
    //   has last_access > insight.generated_at (found via getOutEdges(insightId) filtered to
    //   derived_from, excluding the schema target). This is the reflector's staleness predicate
    //   applied read-side — prevents stale-insight self-confirmation (T-38-07).
    //
    // INVARIANT (D-43 / L137 / T-38-08):
    //   This branch makes NO upsertNode/upsertEdge/tombstone/strengthen calls.
    //   The ONLY write is the existing inferred-episode append at the end.
    //   Insights are origin='inferred' → strengthen() already no-ops on them.
    //   Surfacing an insight never reinforces the insight or its members.
    if (this.config.insightSurfacingEnabled) {
      // Walk INCOMING derived_from edges on the resolved schema to find the dependent insight.
      // Mirror of Case-B reverse-abstracts lookup above (L270-278): same in-edge walk pattern.
      const schemaInEdges = this.store.getInEdges(schemaNode.id);
      let liveInsightId: string | null = null;
      for (const inEdge of schemaInEdges) {
        if (inEdge.kind !== 'derived_from') continue;
        const candidateInsight = this.store.getNode(inEdge.src);
        if (!candidateInsight) continue;
        if (candidateInsight.tombstoned === 1) continue;
        if (candidateInsight.type !== 'insight') continue;
        liveInsightId = candidateInsight.id;
        break; // take the first live non-tombstoned insight anchored to this schema
      }

      if (liveInsightId !== null) {
        // FRESHNESS GATE: load the node_insight sidecar for the generation timestamp.
        const insightMeta = this.store.getNodeInsight(liveInsightId);
        let isStale = false;

        if (!insightMeta) {
          // No sidecar → cannot verify freshness → treat as stale (conservative)
          isStale = true;
        } else {
          // Walk this insight's OUTGOING derived_from edges to find its member dependencies.
          // Any dependency that is tombstoned OR has last_access > generated_at marks it stale.
          const insightOutEdges = this.store.getOutEdges(liveInsightId);
          for (const outEdge of insightOutEdges) {
            if (outEdge.kind !== 'derived_from') continue;
            if (outEdge.dst === schemaNode.id) continue; // skip the anchor schema edge itself
            const depNode = this.store.getNode(outEdge.dst);
            if (!depNode) {
              isStale = true;
              break;
            }
            if (depNode.tombstoned === 1) {
              isStale = true;
              break;
            }
            if (depNode.last_access > insightMeta.generated_at) {
              isStale = true;
              break;
            }
          }
        }

        if (!isStale) {
          // Live, non-stale insight found. Build a single-member compose payload from the
          // insight string — this is the compose-token win: one precomputed string vs ~K members.
          // Reuse the SAME compose path recall already uses (schema-prior + neighborLines).
          const insightNode = this.store.getNode(liveInsightId)!; // already verified non-null above
          const insightNeighborhood = [{ id: insightNode.id, value: insightNode.value }];

          // Compose from single-insight payload — same prompt structure as the neighborhood path.
          // D-43: NO upsertNode/upsertEdge/tombstone/strengthen here.
          let insightInference: string | null = null;
          try {
            const insightLine = `- ${insightNode.value}`;
            // T-04-03-I: query placed as data content, never interpolated as code
            const prompt =
              `You are reasoning over a memory graph using a learned schema as a prior.\n\n` +
              `Schema (learned pattern): "${schemaNode.value}"\n\n` +
              `Related memory nodes:\n${insightLine}\n\n` +
              `Question: ${boundedQuery}\n\n` +
              `Based on the schema and related memories, provide a concise factual inference. ` +
              `If you cannot make a meaningful inference, respond with exactly: null`;

            // T-05-KEY: provider.generate reads API keys from env via SDK (DefaultModelProvider)
            const text = (await this.provider.generate(prompt, { maxTokens: 512 })).trim();

            insightInference = (!text || text.toLowerCase() === 'null') ? null : text;
          } catch {
            // T-02-PARSE: on any error, fall through to neighborhood assembly (no throw)
            insightInference = null;
          }

          if (insightInference) {
            // Log as ephemeral inferred episode — the ONLY write in this branch (D-43).
            // NEVER calls upsertNode/upsertEdge/tombstone/strengthen (T-38-08).
            void insightNeighborhood; // satisfy lint: neighborhood built for tracing, logged below
            const ep = this.episodes.append({
              content: insightInference,
              origin: 'inferred',
              salience: 0,
              hard_keep: 0,
              role: 'assistant',
              session_id: sessionId,
              source_inference_id: null,
            });
            // D-05: return immediately — insight path OR neighborhood, NEVER both
            return { inference: insightInference, episodeId: ep.id, origin: 'inferred' };
          }
          // insightInference was null (compose returned null/empty) → fall through to neighborhood
        }
        // isStale → fall through to neighborhood assembly (the fallback)
      }
      // liveInsightId was null (no insight on schema) → fall through to neighborhood assembly
    }
    // insightSurfacingEnabled=false → fall through to neighborhood assembly (byte-identical to today)

    // Assemble bounded 1-hop neighborhood from the RESOLVED schema's outgoing edges.
    // Using schemaNode.id (not bestMatch.id) ensures the same neighborhood whether
    // the query matched the schema itself or one of its members.
    const neighborhood: Array<{ id: string; value: string }> = [];
    const edges = this.store.getOutEdges(schemaNode.id);
    let nodeCount = 0;

    for (const edge of edges) {
      if (nodeCount >= this.config.recallNeighborhoodBudget) break;
      // Primary neighborhood is the schema's MEMBERS only (schema→member = 'abstracts').
      // Skip 'schema_rel' edges here — those are the sideways hop below, and their dst is a
      // related schema label node, not a member (would pollute the neighborhood otherwise).
      if (edge.kind !== 'abstracts') continue;
      const neighbor = this.store.getNode(edge.dst);
      if (!neighbor || neighbor.tombstoned === 1) continue;

      neighborhood.push({ id: neighbor.id, value: neighbor.value });
      nodeCount++;
    }

    // ── (D-05 / SREL-03): Single sideways schema_rel hop — READ-ONLY ─────────
    // Follow top-N schema_rel edges (by weight) from the resolved schema to
    // related schemas, fold their 'abstracts' members into the same neighborhood.
    // Depth is capped at ONE sideways hop — do NOT recurse into the related
    // schemas' own schema_rel edges (bounds fan-out and latency, D-05).
    // Bounded by: recallSidewaysHopBudget (fan-out cap) + recallNeighborhoodBudget (total).
    // De-duplicates against members already assembled above.
    // INVARIANT: no upsertNode/upsertEdge/tombstone/strengthen here (D-43, T-04-03-SC).
    // schema_rel edges are stored undirected with a lexicographic src<dst convention
    // (schema-relations.ts), so the resolved schema may be EITHER endpoint. We must scan
    // both out-edges (resolved schema is src) AND in-edges (resolved schema is dst), else
    // ~50% of related schemas are silently missed for larger-id schemas (CR-01).
    const outRel = edges
      .filter(e => e.kind === 'schema_rel')
      .map(e => ({ relatedId: e.dst, w: e.w }));
    const inRel = this.store.getInEdges(schemaNode.id)
      .filter(e => e.kind === 'schema_rel')
      .map(e => ({ relatedId: e.src, w: e.w }));
    const relatedSchemaEdges = [...outRel, ...inRel]
      .sort((a, b) => b.w - a.w)
      .slice(0, this.config.recallSidewaysHopBudget);

    if (relatedSchemaEdges.length > 0) {
      // Build dedup set from members already assembled (and the schema node itself).
      const seen = new Set<string>(neighborhood.map(n => n.id));
      seen.add(schemaNode.id);

      for (const relEdge of relatedSchemaEdges) {
        if (nodeCount >= this.config.recallNeighborhoodBudget) break;
        const relatedSchema = this.store.getNode(relEdge.relatedId);
        if (!relatedSchema || relatedSchema.tombstoned === 1) continue;

        // Walk this related schema's 'abstracts' members only — no schema_rel recursion.
        const memberEdges = this.store.getOutEdges(relatedSchema.id)
          .filter(e => e.kind === 'abstracts');
        for (const memberEdge of memberEdges) {
          if (nodeCount >= this.config.recallNeighborhoodBudget) break;
          if (seen.has(memberEdge.dst)) continue;
          const member = this.store.getNode(memberEdge.dst);
          if (!member || member.tombstoned === 1) continue;
          seen.add(memberEdge.dst);
          neighborhood.push({ id: member.id, value: member.value });
          nodeCount++;
        }
      }
    }

    // ── (D-01 / RECALL-01): Post-resolution scope filter ─────────────────────
    // Applied AFTER the full neighborhood is assembled (primary members + sideways hop).
    // Scope filtering is a MEMBER filter, NOT a candidate prefilter — this preserves the
    // exact schema-resolution path (Case A/B + topk) so scope provably never alters ranking
    // (D-S1: scope is provenance-only, never a retrieval signal — 999.3).
    //
    // Retain only members whose scope is the passed slug OR GLOBAL_SCOPE.
    // Members with no scope entry (undefined) are treated as global and kept — mirrors the
    // ambient-recall display rule where unscoped renders no marker (D-S6).
    //
    // If scope is empty/undefined, skip filtering entirely (two-arg callers unchanged).
    if (scope) {
      const memberIds = neighborhood.map(n => n.id);
      const scopeMap = this.store.getNodeScopes(memberIds); // batch read, no SQL interpolation
      const kept = neighborhood.filter(n => {
        const nodeScope = scopeMap.get(n.id);
        // undefined → no scope annotation → treat as global → keep
        return nodeScope === undefined || nodeScope === scope || nodeScope === GLOBAL_SCOPE;
      });
      neighborhood.length = 0;
      for (const n of kept) neighborhood.push(n);
      // D-05 discretion: if the scope filter empties the neighborhood entirely,
      // return NULL_RESULT without an LLM compose call (no in-scope memory to reason over).
      if (neighborhood.length === 0) return NULL_RESULT;
    }

    // ── Trace emission (D-97 guarded): zero work on the Noop path ────────────
    // seeds = [bestMatch.id]; hops = neighborhood members in rank order.
    // T-10-05: wrapped in try/catch fire-and-forget so a sink error never corrupts recall.
    if (this.traceEnabled) {
      try {
        const hops = neighborhood.map((n) => ({
          node_id: n.id,
          // WR-02: recall has no measured activation/similarity magnitude here — only
          // rank order. Emit null rather than fabricate a score that reads as measured.
          score:   null,
          hop:     1 as const,
        }));
        this.traceSink.emit({ query_id: newId(), seeds: [bestMatch.id], hops });
      } catch {
        // Fire-and-forget: a sink failure must never surface to the caller (T-10-05).
      }
    }

    // ── (4) Compose inference via schema-prior (T-04-03-P safe fallback) ─────
    let inferenceText: string | null = null;
    try {
      // Build neighborhood lines excluding the schema node itself
      const neighborLines = neighborhood
        .filter(n => n.id !== schemaNode!.id)
        .map(n => `- ${n.value}`)
        .join('\n');

      // T-04-03-I: query placed as data content, never interpolated as code
      const prompt =
        `You are reasoning over a memory graph using a learned schema as a prior.\n\n` +
        `Schema (learned pattern): "${schemaNode.value}"\n\n` +
        (neighborLines ? `Related memory nodes:\n${neighborLines}\n\n` : '') +
        `Question: ${boundedQuery}\n\n` +
        `Based on the schema and related memories, provide a concise factual inference. ` +
        `If you cannot make a meaningful inference, respond with exactly: null`;

      // T-05-KEY: provider.generate reads API keys from env via SDK (DefaultModelProvider)
      const text = (await this.provider.generate(prompt, { maxTokens: 512 })).trim();

      // null on empty or explicit "null" LLM response (T-02-PARSE)
      if (!text || text.toLowerCase() === 'null') {
        inferenceText = null;
      } else {
        inferenceText = text;
      }
    } catch {
      // T-02-PARSE: on any error, return null inference rather than throwing
      inferenceText = null;
    }

    if (!inferenceText) return NULL_RESULT;

    // ── (5) Log as ephemeral inferred episode — the ONLY write in this path (D-43) ──
    // NEVER calls upsertNode/upsertEdge/tombstone/strengthen (ephemeral-as-fact guarantee)
    const ep = this.episodes.append({
      content: inferenceText,
      origin: 'inferred',
      salience: 0,        // inferred episodes are never replayed as claims
      hard_keep: 0,
      role: 'assistant',  // role CHECK constraint allows only user|assistant|tool
      session_id: sessionId,
      source_inference_id: null, // the inference itself has no prior source
    });

    return { inference: inferenceText, episodeId: ep.id, origin: 'inferred' };
  }
}
