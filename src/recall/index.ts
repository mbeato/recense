/**
 * RecallEngine — on-demand latency-tolerant recall with schema-prior compose (LEARN-02).
 *
 * This is the ONLY Phase-4 path that embeds online (D-41).
 * SessionStart and retrieval paths are NOT modified and remain cue-less/LLM-free.
 *
 * Design:
 *  - Online embed via Embedder seam (D-41): one call per recall, off the hot path.
 *  - 1-hop neighborhood from bestMatch.getOutEdges (D-42): budget-capped, tombstoned excluded.
 *  - Schema identification: if the topk best match is a schema node, use it directly
 *    (Case A). Otherwise walk INCOMING edges of bestMatch — any edge with kind='abstracts'
 *    whose src is a live schema node resolves the prior (Case B, reverse-lookup).
 *    Schema-induction creates schema→member edges; most queries match members, so
 *    Case B is the common path (Fix-2, LEARN-02).
 *  - LLM compose via createAnthropicClient (D-43, T-02-PARSE safe fallback).
 *  - Episode append: ONLY write in this path — origin='inferred', role='assistant', salience=0.
 *
 * Hard invariants:
 *  - NEVER calls store.upsertNode/upsertEdge/tombstone or strength.strengthen.
 *    The inference is NEVER a graph fact (LEARN-02 ephemeral-as-fact guarantee).
 *  - All time reads via this.clock.nowMs() (D-12).
 *  - Keys from process.env via SDK defaults — never literals, never logged (T-04-03-K).
 *  - Query is treated as data (embedded + placed in prompt as content), never executed
 *    or shell-interpolated (T-04-03-I).
 *
 * Threat mitigations:
 *  - T-04-03-I: query length-bounded (MAX_QUERY_BYTES); never shell-interpolated.
 *  - T-04-03-SC: no upsertNode/upsertEdge/strengthen calls. Asserted via source grep.
 *  - T-04-03-K: createAnthropicClient reads ANTHROPIC_API_KEY from env via SDK default.
 *  - T-04-03-P: compose output parsed with safe fallback — null inference on malformed/empty.
 *  - T-04-03-R: SessionStart CLI unchanged; this is the only online-embed path in Phase 4.
 *  - T-04-03-Tlock: acquireLock before DB open in recall-cli (single-writer for D-43 append).
 */
import Database from 'better-sqlite3';
import Anthropic from '@anthropic-ai/sdk';
import type { Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { Embedder } from '../model/embedder';
import { CandidateRetriever } from '../retrieval/topk';
import { SemanticStore } from '../db/semantic-store';
import { StrengthDecayManager } from '../strength/decay';
import { EpisodicStore } from '../db/episode-store';
import { createAnthropicClient, type AnthropicLike } from '../model/anthropic-client';

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

/**
 * Optional injectable factory for the Anthropic client.
 *
 * Production: omit — defaults to createAnthropicClient (reads ANTHROPIC_API_KEY from env).
 * Tests: inject a stub returning deterministic text to avoid any network calls.
 *
 * Mirrors the NamingFn injection pattern from SchemaInducer (04-01).
 */
export type RecallAnthropicFactory = (config: EngineConfig) => { client: AnthropicLike; model: string };

export class RecallEngine {
  private readonly clock: Clock;
  private readonly config: EngineConfig;
  /** Online Embedder — used ONLY on this latency-tolerant path (D-41). */
  private readonly embedder: Embedder;
  private readonly retriever: CandidateRetriever;
  private readonly store: SemanticStore;
  /**
   * StrengthDecayManager — kept in DI for constructor symmetry with sleep-pass-cli.
   * NEVER called from recall (ephemeral-as-fact guarantee, LEARN-02).
   */
  private readonly strength: StrengthDecayManager;
  private readonly episodes: EpisodicStore;
  private readonly anthropicFactory: RecallAnthropicFactory;

  constructor(
    db: Database.Database, // part of DI pattern; all reads go through store/retriever
    clock: Clock,
    config: EngineConfig,
    embedder: Embedder,
    retriever: CandidateRetriever,
    store: SemanticStore,
    strength: StrengthDecayManager,
    episodes: EpisodicStore,
    anthropicFactory?: RecallAnthropicFactory,
  ) {
    // Suppress unused-variable lint for the db parameter (held for DI symmetry):
    void db;
    this.clock = clock;
    this.config = config;
    this.embedder = embedder;
    this.retriever = retriever;
    this.store = store;
    this.strength = strength;
    this.episodes = episodes;
    this.anthropicFactory = anthropicFactory ?? createAnthropicClient;
  }

  /**
   * Embed query cue online (D-41), assemble bounded 1-hop neighborhood, apply matched
   * schema as prior via LLM compose, log inference as an ephemeral inferred episode (D-43).
   *
   * Returns RecallResult tagged `origin:'inferred'`. `inference` and `episodeId` are null
   * when no schema is reachable, or when the compose output is empty/malformed (T-02-PARSE).
   *
   * NEVER calls store.upsertNode/upsertEdge/tombstone or strength.strengthen.
   * The ONLY write is episodes.append({ origin:'inferred', ... }).
   */
  async recall(query: string, sessionId: string): Promise<RecallResult> {
    // T-04-03-I: length-bound the query before use in the compose prompt
    const boundedQuery = query.slice(0, MAX_QUERY_BYTES);

    // ── (1) Online cue embed — the ONLY permitted online embed in Phase 4 (D-41) ──
    const [cueVec] = await this.embedder.embed([boundedQuery]);
    if (!cueVec) return NULL_RESULT;

    // ── (2) Top match via CandidateRetriever ──────────────────────────────────
    const topHits = this.retriever.topk(cueVec, this.config.candidateK);
    const bestMatch = topHits[0];
    if (!bestMatch) return NULL_RESULT;

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

    // Assemble bounded 1-hop neighborhood from the RESOLVED schema's outgoing edges.
    // Using schemaNode.id (not bestMatch.id) ensures the same neighborhood whether
    // the query matched the schema itself or one of its members.
    const neighborhood: Array<{ id: string; value: string }> = [];
    const edges = this.store.getOutEdges(schemaNode.id);
    let nodeCount = 0;

    for (const edge of edges) {
      if (nodeCount >= this.config.recallNeighborhoodBudget) break;
      const neighbor = this.store.getNode(edge.dst);
      if (!neighbor || neighbor.tombstoned === 1) continue;

      neighborhood.push({ id: neighbor.id, value: neighbor.value });
      nodeCount++;
    }

    // ── (4) Compose inference via schema-prior (T-04-03-P safe fallback) ─────
    let inferenceText: string | null = null;
    try {
      const { client, model } = this.anthropicFactory(this.config);

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

      const msg = await client.messages.create({
        model,
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      });

      // Extract text blocks; T-02-PARSE safe fallback on malformed or empty output
      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim();

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
