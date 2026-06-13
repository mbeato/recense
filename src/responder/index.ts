/**
 * HybridResponder — facts-first + schema-prior fallback + honest no-answer (D-72, Phase 7).
 *
 * Hard invariants:
 *  - NEVER calls store.upsertNode/upsertEdge/tombstone or strength.strengthen.
 *    The responder is READ-ONLY on the graph (spec §8, D-75).
 *  - Inbound question text is NEVER written as a non-inferred episode. Only write is
 *    origin='inferred', salience=0 in the facts-first branch (D-75 self-confirmation guard).
 *  - All time reads via this.clock.nowMs() (D-12).
 *  - Keys from process.env via SDK defaults — never literals, never logged (T-04-03-K, T-05-KEY).
 *  - Query is treated as data (embedded + placed in prompt as content), never executed
 *    or shell-interpolated (T-04-03-I).
 *
 * Threat mitigations:
 *  - T-07-06 (self-confirmation): no upsertNode/upsertEdge/tombstone/strengthen calls;
 *    only write is origin='inferred', salience=0; inbound never appended as a fact (D-75).
 *  - T-07-02 (injection): MAX_QUERY_BYTES bound; query placed as data content, not code.
 *  - T-07-09 (spoofing): schema-prior answers carry ' (inferred)' marker (D-73); grounded facts unmarked.
 *  - T-07-04 (info disclosure): safe-null on any throw — reply=null, never a raw error string.
 *  - T-07-10 (stale fact): facts-first now uses RetrievalEngine.retrieveRanked (B1 fix); topk
 *    returns tombstoned=0 nodes only, and B2 entity invalidation excludes entities whose
 *    supporting facts are all tombstoned — stale facts never surfaced (RET-02 preserved).
 */
import type { Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { ModelProvider } from '../model/provider';
import type { RetrievalEngine } from '../retrieval/engine';
import type { RecallEngine } from '../recall';
import type { EpisodicStore } from '../db/episode-store';

// T-04-03-I: bound query length to cap compose prompt size (4 KB is generous)
const MAX_QUERY_BYTES = 4_000;

/**
 * Wh-/auxiliary interrogative leads that signal a question-form input.
 * Used by isInterrogative() to gate the LEVER 3 declarative rewrite (WR-03).
 * Allocation-free: Set lookup is O(1).
 */
const INTERROGATIVE_LEADS = new Set([
  'what', 'when', 'where', 'who', 'whom', 'whose', 'which', 'why', 'how',
  'do', 'does', 'did', 'is', 'are', 'was', 'were',
  'can', 'could', 'should', 'would', 'will',
]);

/**
 * Returns true if the query looks like a question — ends with '?' or opens with a
 * wh-/auxiliary interrogative lead (lowercased first token). Declarative inputs return false
 * and bypass the LEVER 3 rewrite (WR-03: skip the extra generate() for non-question inputs).
 */
function isInterrogative(query: string): boolean {
  const q = query.trim();
  if (q.endsWith('?')) return true;
  const firstWord = q.split(/\s+/)[0]?.toLowerCase() ?? '';
  return INTERROGATIVE_LEADS.has(firstWord);
}

/** Honest no-answer string (D-73): owner-neutral, no first-person identity claim, texting-feel. */
export const HONEST_NO_ANSWER = "don't have that one";

export interface ResponderResult {
  /**
   * The composed reply string, or null when the responder encounters a fatal error
   * (safe-null discipline — never throws, never leaks raw error).
   */
  reply: string | null;
  /**
   * Origin of the reply:
   *  'fact'     — grounded in a directly-retrieved fact (D-72 facts-first branch)
   *  'inferred' — composed via schema-prior fallback (D-72/D-73)
   *  'none'     — honest no-answer, or safe-null on error
   */
  origin: 'fact' | 'inferred' | 'none';
  /**
   * ID of the logged inferred-origin episode in the facts-first branch, or the
   * RecallEngine's episode ID in the schema-prior branch. null when origin is 'none'.
   */
  episodeId: string | null;
}

const NULL_RESULT: ResponderResult = { reply: null, origin: 'none', episodeId: null };
const HONEST_RESULT: ResponderResult = {
  reply: HONEST_NO_ANSWER,
  origin: 'none',
  episodeId: null,
};

/**
 * HybridResponder: online-embed the question, try facts-first via RetrievalEngine.retrieveRanked(cueVec, k, floor),
 * fall back to schema-prior RecallEngine.recall(), answer honestly when neither fires.
 *
 * B1 fix: facts-first uses retrieveRanked (top-k + floor 0.3) instead of the single-hit 0.7 bar,
 * so question-form cues (typically 0.4–0.6 cosine vs stored facts) can ground an answer.
 *
 * Concise reply with the fact-vs-(inferred) marker (D-73). Read-only on the graph except the
 * single inferred-episode log in the facts-first branch (D-75).
 */
export class HybridResponder {
  private readonly clock: Clock;
  private readonly config: EngineConfig;
  /** ModelProvider — embed head for online cue, generate head for facts-first compose. */
  private readonly provider: ModelProvider;
  private readonly retrieval: RetrievalEngine;
  /** RecallEngine — owns its own provider + all schema-prior logic; appends its own episode. */
  private readonly recall: RecallEngine;
  private readonly episodes: EpisodicStore;

  constructor(
    clock: Clock,
    config: EngineConfig,
    provider: ModelProvider,
    retrieval: RetrievalEngine,
    recall: RecallEngine,
    episodes: EpisodicStore,
  ) {
    this.clock = clock;
    this.config = config;
    this.provider = provider;
    this.retrieval = retrieval;
    this.recall = recall;
    this.episodes = episodes;
  }

  /**
   * Respond to an inbound question using the hybrid D-72 strategy.
   *
   * Steps:
   *  1. Bound query length (T-04-03-I).
   *  2. Wrap everything in try/catch — any throw returns safe-null (never rethrows).
   *  LEVER 3 (17-04, gated 17-08 WR-03): For interrogative inputs only, rewrite to a declarative
   *    statement (queryForEmbed) — skips the generate() for declarative inputs (no benefit, saves budget).
   *    Falls back to raw question on error — rewrite failure never blocks the answer.
   *    ONLY in respond(): SessionStart/retrieveCueless is LLM-free and never calls respond().
   *  3. Online embed: provider.embed([queryForEmbed]).
   *  4. Facts-first: retrieval.retrieveRanked(cueVec, k, floor) — pure cosine+temporal only (no BM25/hybrid).
   *     B1 fix: retrieveRanked uses top-k + floor (0.3) instead of the single-hit 0.7 bar.
   *     Question-form cues ("Where does Ana live?") score 0.4–0.6 against stored facts —
   *     structurally below retrieve()'s deletedSimilarityThreshold (0.7) but above the 0.3 floor.
   *  5. Schema-prior fallback: recall.recall(boundedQuery, sessionId).
   *  6. Honest no-answer: return HONEST_NO_ANSWER.
   *
   * NEVER calls store.upsertNode/upsertEdge/tombstone or strength.strengthen.
   * The ONLY graph write is episodes.append({ origin:'inferred', salience:0 }) in step 4.
   */
  async respond(question: string, sessionId: string): Promise<ResponderResult> {
    // T-04-03-I: length-bound the query before use in any prompt
    const boundedQuery = question.slice(0, MAX_QUERY_BYTES);

    try {
      // ── LEVER 3: Q->declarative rewrite (17-04, gated 17-08 WR-03) ──────────
      // Rewrites the question-form query to a declarative statement before embedding.
      // Attacks the measured Q->S cosine asymmetry (0.688 vs 0.797): stored facts are
      // declarative; question-form cues score structurally lower against them.
      //
      // WR-03 (17-08): rewrite is gated behind an interrogative check — declarative inputs
      // gain nothing from rewriting and skipping the generate() call saves budget. For
      // interrogative inputs the rewrite fires as before; falls back to the raw question
      // on any error — rewrite failure must never block the answer (T-07-04 safe-null).
      // ONLY in respond(): the retrieval primitive (retrieveRanked, retrieveCueless) is
      // LLM-free and never calls respond() — SessionStart hook is structurally separate (D-99).
      let queryForEmbed = boundedQuery;
      if (isInterrogative(boundedQuery)) {
        try {
          const rewritePrompt =
            `Rewrite the following question as a concise declarative statement of fact. ` +
            `Preserve ALL names, numbers, and proper nouns VERBATIM. ` +
            `Return ONLY the statement — no preamble, no explanation.\n\n` +
            `Question: ${boundedQuery}`;
          const rewritten = (await this.provider.generate(rewritePrompt, { maxTokens: 128 })).trim();
          if (rewritten) queryForEmbed = rewritten;
        } catch {
          // T-07-04: rewrite failure falls back to raw query — never blocks respond()
          queryForEmbed = boundedQuery;
        }
      }

      // ── (3) Online cue embed ──────────────────────────────────────────────
      const [cueVec] = await this.provider.embed([queryForEmbed]);
      if (!cueVec) return HONEST_RESULT;

      // ── (4) Facts-first: attempt retrieval of directly-stored facts ───────
      // B1: use retrieveRanked(k, floor) so question-form cues (0.4–0.6 cosine) surface facts
      // instead of failing retrieve()'s single-hit 0.7 bar. Staleness guarded by B2: topk
      // returns tombstoned=0 nodes only, and entity invalidation excludes entities whose
      // supporting facts are all tombstoned (previously guarded by T-07-10 via retrieve()).
      //
      // LEVER 1 (BM25/hybrid) intentionally absent on the answer path (17-08 GAP-03):
      //   - retrieve_miss=0 in attribution: BM25 recovered zero gold nodes that cosine missed.
      //   - 9ea5eabc regression: BM25 over-indexed stale "Hawaii" trip over current "Paris" — removed at root.
      //   - queryForEmbed continues to feed embed() above (LEVER 3 cosine-asymmetry fix).
      //   - node_fts + hybridTopk + ftsQueryFromText + rrfFuse infra retained; SCHEMA_VERSION=6 unchanged.
      const ranked = this.retrieval.retrieveRanked(
        cueVec,
        this.config.rankedRetrievalK,
        this.config.rankedRetrievalFloor,
      );
      if (ranked.length > 0) {
        // Build grounded compose prompt — facts as data content (T-04-03-I)
        const factLines = ranked.map(x => `- ${x.value}`).join('\n');
        const prompt =
          `You are answering a question using only the stored facts below.\n\n` +
          `Stored facts:\n${factLines}\n\n` +
          `Question: ${boundedQuery}\n\n` +
          `Answer in 1-2 sentences using ONLY the stored facts above. ` +
          `If the facts do not answer the question, respond with exactly: null`;

        let composedAnswer: string | null = null;
        try {
          const text = (await this.provider.generate(prompt, { maxTokens: 512 })).trim();
          if (text && text.toLowerCase() !== 'null') {
            composedAnswer = text;
          }
        } catch {
          // T-07-04: compose failure falls through to schema-prior (not safe-null yet)
          composedAnswer = null;
        }

        if (composedAnswer !== null) {
          // Log grounded answer as ephemeral inferred episode — the ONLY write in the facts-first branch (D-75).
          // HARD INVARIANT: origin='inferred', salience=0 — inbound question never written as a fact (D-75).
          // WR-01/CR-01 self-confirmation guard: salience=0 ensures this episode never strengthens the recalled fact.
          const ep = this.episodes.append({
            content: composedAnswer,
            origin: 'inferred',
            salience: 0,
            hard_keep: 0,
            role: 'assistant',
            session_id: sessionId,
            source_inference_id: null,
          });
          return { reply: composedAnswer, origin: 'fact', episodeId: ep.id };
        }
        // composedAnswer null: fall through to schema-prior
      }

      // ── (5) Schema-prior fallback: delegate to RecallEngine ───────────────
      // RecallEngine appends its own inferred episode — the responder does NOT append here.
      const rr = await this.recall.recall(boundedQuery, sessionId);
      if (rr.inference !== null) {
        return {
          reply: `${rr.inference} (inferred)`,
          origin: 'inferred',
          episodeId: rr.episodeId,
        };
      }

      // ── (6) Honest no-answer ──────────────────────────────────────────────
      return HONEST_RESULT;
    } catch {
      // T-07-04: safe-null on any unhandled error — never throw, never leak raw error
      return NULL_RESULT;
    }
  }
}
