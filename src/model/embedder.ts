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
 * ~24 000 chars ≈ 6 000 tokens (4 chars/token average) — well under the limit
 * while providing a clear safety margin against per-text failures that would
 * quarantine an episode via H-2.
 *
 * Truncation is lossy: the tail of the text is discarded. For node values
 * (typically short) this fires only on pathological inputs; for episode-level
 * embeddings (detectEcho path) a truncated vector is better than a failed one.
 */
export const EMBEDDER_INPUT_MAX_CHARS = 24_000;

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
      if (t.length > EMBEDDER_INPUT_MAX_CHARS) {
        console.warn(
          `[brain-memory] OpenAIEmbedder: input[${i}] length ${t.length} chars exceeds ` +
            `EMBEDDER_INPUT_MAX_CHARS (${EMBEDDER_INPUT_MAX_CHARS}) — truncating`,
        );
        return t.slice(0, EMBEDDER_INPUT_MAX_CHARS);
      }
      return t;
    });

    const response = await this.client.embeddings.create({
      model: this.model,
      input: guarded,
      dimensions: this.dims,
    });

    // Map response.data[i].embedding (number[]) → Float32Array, preserving input order
    return response.data.map(item => new Float32Array(item.embedding));
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
