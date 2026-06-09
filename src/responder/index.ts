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
 *  - T-07-10 (stale fact): reuses RetrievalEngine.retrieve which returns 'deleted'/'unreachable'
 *    for tombstoned/missing nodes — never surfaces a stale fact (RET-02).
 */
import type { Clock } from '../lib/clock';
import type { EngineConfig } from '../lib/config';
import type { ModelProvider } from '../model/provider';
import type { RetrievalEngine } from '../retrieval/engine';
import type { RecallEngine } from '../recall';
import type { EpisodicStore } from '../db/episode-store';

// T-04-03-I: bound query length to cap compose prompt size (4 KB is generous)
const MAX_QUERY_BYTES = 4_000;

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
 * HybridResponder: online-embed the question, try facts-first via RetrievalEngine.retrieve(cueVec),
 * fall back to schema-prior RecallEngine.recall(), answer honestly when neither fires.
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
   *  3. Online embed: provider.embed([boundedQuery]).
   *  4. Facts-first: retrieval.retrieve(cueVec). If ok + results → compose grounded answer.
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
      // ── (3) Online cue embed ──────────────────────────────────────────────
      const [cueVec] = await this.provider.embed([boundedQuery]);
      if (!cueVec) return HONEST_RESULT;

      // ── (4) Facts-first: attempt retrieval of directly-stored facts ───────
      const r = this.retrieval.retrieve(cueVec);
      if (r.status === 'ok' && r.results.length > 0) {
        // Build grounded compose prompt — facts as data content (T-04-03-I)
        const factLines = r.results.map(x => `- ${x.value}`).join('\n');
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
          // Log grounded answer as ephemeral inferred episode — the ONLY write in the facts-first branch (D-75)
          // HARD INVARIANT: origin='inferred', salience=0 — inbound question never written as a fact (D-75)
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
