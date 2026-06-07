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
 */
export type AnthropicLike = {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
};

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
    const opts: { projectId?: string; region?: string } = {};
    if (config.vertexProjectId) opts.projectId = config.vertexProjectId;
    if (config.vertexRegion) opts.region = config.vertexRegion;
    const client = new AnthropicVertex(opts);
    return { client, model };
  }

  if (config.modelProvider === 'local') {
    // Local path: OpenAI-compatible Ollama endpoint. Dummy api key 'ollama' (Ollama
    // ignores it); never log the client. Wrapped in OllamaClient to satisfy AnthropicLike.
    const openai = new OpenAI({ baseURL: config.localBaseUrl, apiKey: 'ollama' });
    const client = new OllamaClient(openai);
    return { client, model };
  }

  // Default: direct Anthropic SDK — reads ANTHROPIC_API_KEY from env automatically.
  const client = new Anthropic();
  return { client, model };
}
