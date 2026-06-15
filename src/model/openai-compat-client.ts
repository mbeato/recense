/**
 * Generic OpenAI-compatible transport adapter behind the Judge/ClaimExtractor seam (ECR-01).
 *
 * Wraps the OpenAI SDK (pointed at any OpenAI-compatible endpoint) and exposes the narrow
 * `AnthropicLike` shape the call sites use. Designed for cloud OpenAI-compat providers
 * such as DeepSeek — NOT for local Ollama (use OllamaClient for that).
 *
 * Deliberate omissions vs. OllamaClient:
 *  - No native /api/chat constrained-decoding path (cloud endpoints support json_object natively).
 *  - No <think>...</think> stripping (cloud providers surface reasoning as hidden tokens; the
 *    visible content is clean JSON without manual stripping).
 *
 * Token budget (mirrors OllamaClient MIN_MAX_TOKENS):
 *  - DeepSeek V4-Pro is a reasoning model: it emits ~1,200+ hidden reasoning tokens before the
 *    visible JSON answer. With max_tokens=256 (what the engine judge sends), the reasoning alone
 *    exhausts the budget and the visible content is empty. MIN_MAX_TOKENS=8192 floor prevents
 *    this — same as OllamaClient (Qwen 3.6 has the same property).
 *
 * json_object response_format is used when `extra.jsonSchema` is present — sufficient for the
 * engine judge which parses JSON from the text response via parseVerdict (verified: the
 * Anthropic path ignores jsonSchema; json_schema strict mode is not required here).
 *
 * Credential discipline (extends T-02-KEY / T-04-KEY / T-05-KEY / T-ECR-01):
 *  - DEEPSEEK_API_KEY is read from process.env by the OpenAI SDK at client construction.
 *    The key is NEVER passed as a literal, NEVER stored in config objects, NEVER logged,
 *    and the client object is NEVER written to any output stream.
 */
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import type { AnthropicLike } from './anthropic-client';

/**
 * Minimum max_tokens for OpenAI-compat reasoning cloud models (mirrors OllamaClient).
 * DeepSeek V4-Pro emits ~1,200+ hidden reasoning tokens before the visible answer;
 * with max_tokens=256 (what the engine judge sends) the reasoning exhausts the budget
 * and the visible response is empty. 8192 gives 6-7k headroom beyond typical reasoning.
 */
const MIN_MAX_TOKENS = 8192;

/**
 * Flatten an Anthropic message `content` (string | content-block[]) into a single
 * string by concatenating text blocks. Non-text blocks are ignored — call sites only send text.
 */
function flattenContent(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('');
}

/**
 * Flatten an Anthropic `system` param (string | TextBlockParam[]) into a string.
 */
function flattenSystem(system: Anthropic.MessageCreateParamsNonStreaming['system']): string {
  if (system === undefined) return '';
  if (typeof system === 'string') return system;
  return system.map(block => block.text).join('');
}

/**
 * Minimal AnthropicLike adapter for any OpenAI-compatible cloud endpoint.
 * Construct with an OpenAI client already pointed at the provider base URL.
 *
 * @param openai - OpenAI SDK client pointed at the target endpoint.
 * @param model  - Model id string to pass in every request.
 */
export class OpenAICompatClient implements AnthropicLike {
  readonly messages: AnthropicLike['messages'];

  constructor(openai: OpenAI, model?: string) {
    this.messages = {
      create: async (
        params: Anthropic.MessageCreateParamsNonStreaming,
        extra?: { jsonSchema?: object }
      ): Promise<Anthropic.Message> => {
        // Build messages array: system role first (if non-empty), then user/assistant turns.
        const openaiMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

        const systemText = flattenSystem(params.system);
        if (systemText !== '') {
          openaiMessages.push({ role: 'system', content: systemText });
        }

        for (const m of params.messages) {
          openaiMessages.push({ role: m.role, content: flattenContent(m.content) });
        }

        // Use json_object when a JSON schema is requested — sufficient for the judge
        // (parseVerdict salvages JSON from plain text regardless, but json_object gives
        // cleaner output from cloud providers that honor it).
        // Apply MIN_MAX_TOKENS floor: DeepSeek V4-Pro is a reasoning model and can emit
        // 1000+ hidden reasoning tokens before the visible JSON. Without this floor the
        // 256-token judge budget is exhausted by reasoning, returning empty content.
        const resp = await openai.chat.completions.create({
          model: model ?? params.model,
          messages: openaiMessages,
          max_tokens: Math.max(params.max_tokens ?? 0, MIN_MAX_TOKENS),
          temperature: params.temperature ?? 0,
          response_format: extra?.jsonSchema ? { type: 'json_object' } : undefined,
        });

        const text = resp.choices[0]?.message?.content ?? '';

        return {
          id: resp.id ?? 'openai-compat',
          type: 'message',
          role: 'assistant',
          model: params.model,
          content: [{ type: 'text', text, citations: null }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        } as unknown as Anthropic.Message;
      },
    };
  }
}
