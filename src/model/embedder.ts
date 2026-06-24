/**
 * Embedder seam (Phase 2, D-21/D-22).
 *
 * Narrow seam: the sleep pass calls embed(); the real OpenAI call lives in
 * OpenAIEmbedder; tests use MockEmbedder (no network).
 *
 * Phase 5 SEAM-01 will subsume this into ModelProvider.embed.
 * Keep this minimal — only what the consolidation pass needs.
 *
 * Threat mitigations:
 *  - T-02-KEY: OpenAI SDK reads OPENAI_API_KEY from process.env by default.
 *    The key is never passed as a literal, never logged, and never committed.
 *    OpenAIEmbedder never prints or exposes the client or key to any output stream.
 */
import OpenAI from 'openai';
import { SDK_TIMEOUT_MS, SDK_MAX_RETRIES } from './anthropic-client';

/**
 * Maximum characters per embedding input text (Phase 14 hardening).
 *
 * The OpenAI text-embedding-3-small model has an 8192-token context limit.
 * The "4 chars/token" rule of thumb only holds for prose: dense content —
 * generated project-hub docs full of `recense://fact/<uuid>` URIs, code, JSON,
 * markdown tables — tokenizes closer to ~2.5 chars/token, so a 24 000-char doc
 * exceeded 8192 tokens and 400'd ("maximum input length is 8192 tokens"),
 * poisoning the whole atomic batch and stalling consolidation. 16 000 chars
 * stays under 8192 tokens even at ~2 chars/token. The embed() fallback below is
 * the backstop for anything still over the limit (or otherwise rejected).
 *
 * Truncation is lossy: the tail of the text is discarded. The full text remains
 * in the node value (graph = source of truth); only the embedding input — used
 * for retrieval similarity — is computed on a representative prefix.
 */
export const EMBEDDER_INPUT_MAX_CHARS = 16_000;

/**
 * Maximum inputs per OpenAI embeddings request. The API rejects requests with
 * more than 2048 inputs ("400 Invalid 'input': array length must be 2048 or
 * less"). A single consolidation pass over a large haystack can produce more
 * claims than this, so embed() chunks the input array into batches of this size
 * and concatenates the results in order rather than failing the whole pass.
 */
export const EMBEDDER_MAX_BATCH = 2048;

/**
 * Batch text embeddings — index-aligned, awaited fully BEFORE any DB write phase.
 * Output is Float32Array to feed setEmbedding / CandidateRetriever directly.
 */
export interface Embedder {
  /** Batch-embed N texts → N vectors, index-aligned. Awaited fully BEFORE the DB write phase. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

// ---------------------------------------------------------------------------
// Real implementation — wraps the OpenAI SDK
// ---------------------------------------------------------------------------

export class OpenAIEmbedder implements Embedder {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly dims: number;

  constructor(model: string, dims: number) {
    // T-02-KEY: OpenAI() reads OPENAI_API_KEY from process.env automatically.
    // Do not pass the key as a literal argument.
    // Do not log this.client or any key-bearing value.
    // M-4: explicit timeout/maxRetries so a hung embed call can't hold the lock indefinitely.
    this.client = new OpenAI({ timeout: SDK_TIMEOUT_MS, maxRetries: SDK_MAX_RETRIES });
    this.model = model;
    this.dims = dims;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    // Phase 14: guard against arbitrarily long inputs that would cause API failures
    // (quarantining an episode via H-2). Truncate each text to EMBEDDER_INPUT_MAX_CHARS
    // and log a warning so the caller knows truncation occurred. A truncated vector
    // is always better than a failed call that quarantines the episode.
    const guarded = texts.map((t, i) => {
      // Empty-input guard: OpenAI rejects an empty string with
      // `400 Invalid 'input[N]': input cannot be an empty string`, and because the
      // batch is atomic, ONE empty input fails the whole call — poisoning the entire
      // pass. Substitute a single space (index alignment preserved; callers still get
      // N vectors for N inputs). Whitespace-only inputs hit this too (TRIM is empty).
      if (t.trim().length === 0) {
        console.warn(
          `[recense] OpenAIEmbedder: input[${i}] is empty/whitespace — ` +
            `substituting a placeholder to avoid a batch-poisoning 400`,
        );
        return ' ';
      }
      if (t.length > EMBEDDER_INPUT_MAX_CHARS) {
        console.warn(
          `[recense] OpenAIEmbedder: input[${i}] length ${t.length} chars exceeds ` +
            `EMBEDDER_INPUT_MAX_CHARS (${EMBEDDER_INPUT_MAX_CHARS}) — truncating`,
        );
        return t.slice(0, EMBEDDER_INPUT_MAX_CHARS);
      }
      return t;
    });

    // OpenAI's embeddings endpoint accepts at most EMBEDDER_MAX_BATCH inputs per
    // request. Chunk so a pass that produces >2048 claims embeds across multiple
    // calls (in order) instead of failing with a 400 and degrading the memory.
    const out: Float32Array[] = [];
    for (let start = 0; start < guarded.length; start += EMBEDDER_MAX_BATCH) {
      const batch = guarded.slice(start, start + EMBEDDER_MAX_BATCH);
      const vecs = await this.embedBatch(batch);
      for (const v of vecs) out.push(v);
    }
    return out;
  }

  /**
   * Embed one chunk (≤ EMBEDDER_MAX_BATCH inputs), index-aligned.
   *
   * Poison-pill resilience: the embeddings endpoint is atomic — if ANY single
   * input is rejected (empty string, > 8192 tokens, bad encoding), the WHOLE
   * request 400s. The guards above prevent the common cases, but a request that
   * still fails must never abort the entire sleep pass (that froze consolidation
   * for ~40h: one over-token doc 400'd every reembedDirty batch). So on a batch
   * failure we fall back to embedding inputs ONE AT A TIME, isolating the bad
   * input. An input that still fails gets a zero vector (index alignment held;
   * the node stays in the graph — source of truth — just not vector-retrievable
   * until its value next changes). A degraded vector always beats a stalled brain.
   */
  private async embedBatch(batch: string[]): Promise<Float32Array[]> {
    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: batch,
        dimensions: this.dims,
      });
      // Preserve input order: response.data[i] aligns with batch[i].
      return response.data.map(item => new Float32Array(item.embedding));
    } catch (err) {
      if (batch.length === 1) {
        console.warn(
          `[recense] OpenAIEmbedder: single input rejected (${String(err)}) — ` +
            `substituting a zero vector so one poison input cannot stall the pass`,
        );
        return [new Float32Array(this.dims)];
      }
      console.warn(
        `[recense] OpenAIEmbedder: batch of ${batch.length} rejected (${String(err)}) — ` +
          `retrying one input at a time to isolate the poison input`,
      );
      const out: Float32Array[] = [];
      for (const text of batch) out.push((await this.embedBatch([text]))[0]!);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Mock — deterministic, no network; used by all unit tests
// ---------------------------------------------------------------------------

/** Deterministic mock for unit tests — maps each text to a Float32Array via the provided fn. */
export class MockEmbedder implements Embedder {
  /** Public so tests can bridge to MockModelProvider.embedFn (Plan 05-02 SEAM-01 wiring). */
  constructor(readonly fn: (t: string) => Float32Array) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(this.fn);
  }
}
