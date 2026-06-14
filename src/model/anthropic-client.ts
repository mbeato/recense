/**
 * Narrow transport factory behind the Judge/ClaimExtractor seams (per QUICK-99b).
 *
 * Selects between the direct Anthropic SDK and AnthropicVertex based on
 * EngineConfig.modelProvider. This is a deliberate transport-only seam — NOT the
 * full Phase 5 SEAM-01 ModelProvider abstraction.
 *
 * Credential discipline (extends T-02-KEY / T-04-KEY):
 *  - Direct path: Anthropic() reads ANTHROPIC_API_KEY from process.env automatically.
 *  - Vertex path: AnthropicVertex authenticates via GCP Application Default Credentials (ADC).
 *  - Local path: Ollama needs no real key; a dummy 'ollama' api key is used. The OpenAI
 *    client is wrapped in OllamaClient and never logged or exposed.
 *  - Credentials are NEVER passed as literals, NEVER logged, and NEVER committed.
 *  - The client object is never exposed to any output stream.
 */
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import OpenAI from 'openai';
import type { EngineConfig } from '../lib/config';
import { OllamaClient } from './ollama-client';

/**
 * Minimal structural type satisfied by both Anthropic and AnthropicVertex clients.
 * Narrows to only the `messages.create` overload the Judge/ClaimExtractor call sites use.
 * The response Message type (including TextBlock) comes from @anthropic-ai/sdk,
 * so Anthropic.TextBlock narrowing at call sites is valid for both providers.
 *
 * The optional `extra` second argument carries recense-internal options that are
 * transport-specific (e.g. jsonSchema for the OllamaClient native constrained-decoding
 * path). For Anthropic/Vertex transports the extra arg lands in the ignored RequestOptions
 * slot — jsonSchema never reaches the Anthropic API body (QUICK-260612-clb, T-CLB-seam).
 */
export type AnthropicLike = {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      extra?: { jsonSchema?: object }
    ): Promise<Anthropic.Message>;
  };
};

/**
 * SDK-level timeout and retry bounds (M-4).
 *
 * A hung API call holds the global single-writer lock. With default timeouts (~10 min)
 * the hold can approach the 30-min stale window where H-4's lock reclaim fires.
 * 60 s + 2 retries = at most ~3 min worst-case, well within the stale window.
 *
 * Applied to: Anthropic SDK, AnthropicVertex SDK, OpenAI SDK (embedder).
 *
 * LOCAL_SDK_TIMEOUT_MS applies only to the local Ollama path.  Local models can be
 * slow: when the consolidator dispatches 2+ judge calls concurrently, Ollama serialises
 * them internally.  A 35b reasoning model takes ~47 s per judgeOnce pass; the second
 * concurrent request queues ~47 s then processes ~47 s = ~94 s total from when it was
 * sent — exceeding the 60 s cloud limit.  300 s (5 min) gives 3× headroom while still
 * staying well inside the 30-min H-4 lock-reclaim window (worst case: 3 retries ×
 * 300 s = 15 min).
 *
 * SDK_MAX_RETRIES is env-overridable via RECENSE_SDK_MAX_RETRIES.
 * The eval harness sets it to 10 before loading dist modules so that engine-level
 * 429s during consolidation self-throttle via the SDK's native retry-after backoff,
 * rather than failing after the default 2 attempts.
 * Invalid or absent → production default 2.
 */
export const SDK_TIMEOUT_MS = 60_000;
export const LOCAL_SDK_TIMEOUT_MS = 300_000;
export const SDK_MAX_RETRIES: number = (() => {
  const raw = process.env['RECENSE_SDK_MAX_RETRIES'];
  if (!raw) return 2;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
})();

/**
 * Pure helper — returns the correct model id string for the configured provider.
 * No client construction; safe to call in tests without credentials.
 */
export function resolveModelId(config: EngineConfig): string {
  if (config.modelProvider === 'vertex') return config.vertexModel;
  if (config.modelProvider === 'local') return config.localModel;
  return config.anthropicModel;
}

/**
 * Build the appropriate SDK client for the configured provider and return it
 * together with the resolved model id.
 *
 * When modelProvider === 'vertex': builds an options object containing only
 * non-empty projectId/region values (empty strings fall through to the SDK's
 * native ANTHROPIC_VERTEX_PROJECT_ID / CLOUD_ML_REGION env vars).
 * When modelProvider === 'anthropic': constructs a plain Anthropic() client
 * (reads ANTHROPIC_API_KEY from env automatically).
 */
export function createAnthropicClient(config: EngineConfig): { client: AnthropicLike; model: string } {
  const model = resolveModelId(config);

  if (config.modelProvider === 'vertex') {
    // Build options only for non-empty values; the SDK reads the env vars natively
    // for anything left out. Never log or expose these values.
    const opts: {
      projectId?: string;
      region?: string;
      timeout?: number;
      maxRetries?: number;
    } = {};
    if (config.vertexProjectId) opts.projectId = config.vertexProjectId;
    if (config.vertexRegion) opts.region = config.vertexRegion;
    opts.timeout = SDK_TIMEOUT_MS;
    opts.maxRetries = SDK_MAX_RETRIES;
    const client = new AnthropicVertex(opts);
    // Cast to AnthropicLike: the extra second arg (`{ jsonSchema? }`) lands in the
    // ignored RequestOptions slot at runtime. The SDK does not send unknown option keys
    // to the Anthropic API — jsonSchema never reaches the request body (T-CLB-seam).
    return { client: client as unknown as AnthropicLike, model };
  }

  if (config.modelProvider === 'local') {
    // Local path: OpenAI-compatible Ollama endpoint. Dummy api key 'ollama' (Ollama
    // ignores it); never log the client. Wrapped in OllamaClient to satisfy AnthropicLike.
    // Uses LOCAL_SDK_TIMEOUT_MS (300 s) instead of the cloud 60 s: concurrent judge calls
    // queue behind each other in Ollama and the second can take ~94 s to respond.
    const openai = new OpenAI({
      baseURL: config.localBaseUrl,
      apiKey: 'ollama',
      timeout: LOCAL_SDK_TIMEOUT_MS,
      maxRetries: SDK_MAX_RETRIES,
    });
    // Pass localBaseUrl so OllamaClient can derive the native /api/chat endpoint
    // for constrained-decoding calls (QUICK-260612-clb).
    const client = new OllamaClient(openai, config.localBaseUrl);
    return { client, model };
  }

  // Default: direct Anthropic SDK — reads ANTHROPIC_API_KEY from env automatically.
  // Cast to AnthropicLike: same reasoning as the vertex path above (T-CLB-seam).
  const client = new Anthropic({ timeout: SDK_TIMEOUT_MS, maxRetries: SDK_MAX_RETRIES });
  return { client: client as unknown as AnthropicLike, model };
}
