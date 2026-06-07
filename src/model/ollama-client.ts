/**
 * Local/Ollama transport adapter behind the Judge/ClaimExtractor seam (QUICK-260607-b25).
 *
 * Wraps the OpenAI SDK (pointed at an Ollama OpenAI-compatible endpoint) and exposes
 * the narrow `AnthropicLike` shape the call sites use. This lets the existing
 * AnthropicJudge / AnthropicClaimExtractor route to a local reasoning model when
 * EngineConfig.modelProvider === 'local', with ZERO call-site changes.
 *
 * Locked design decisions (from the contradiction eval + seam inspection):
 *  - max_tokens floor = 8192: Qwen 3.6 are reasoning models; below ~8192 they truncate
 *    mid-think and return empty content → false `unrelated`/`[]`. The adapter applies
 *    max_tokens = Math.max(requested ?? 0, 8192). Call-site max_tokens are NOT edited.
 *  - temperature 0: deterministic; matches the validated eval config.
 *  - NO response_format json_object: prose calls (schema-naming, recall-compose) also flow
 *    through this seam; JSON calls rely on the engine's salvage parsers.
 *  - Strip <think>...</think> blocks: Qwen emits them; stripping keeps prose clean and lets
 *    the JSON-salvage parsers work without json_object mode.
 *
 * Credential discipline (extends T-02-KEY / T-04-KEY / T-99b-KEY):
 *  - Ollama needs no real key; a dummy 'ollama' api key is used. The client is never
 *    logged, never exposed to any output stream.
 */
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';
import type { AnthropicLike } from './anthropic-client';

/** Minimum max_tokens for local reasoning models (decision 3 — see file header). */
const MIN_MAX_TOKENS = 8192;

/**
 * Strip <think>...</think> reasoning blocks emitted by Qwen reasoning models.
 * Non-greedy; tolerates an unclosed <think> by stripping to end of string.
 */
function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/g, '')
    .trim();
}

/**
 * Flatten an Anthropic message `content` (string | content-block[]) into a single
 * string by concatenating text blocks. Non-text blocks are ignored — the call sites
 * only send text.
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
 * Adapter wrapping the OpenAI SDK to satisfy AnthropicLike. Construct with an OpenAI
 * client already pointed at the Ollama base URL.
 */
export class OllamaClient implements AnthropicLike {
  readonly messages: AnthropicLike['messages'];

  constructor(openai: OpenAI) {
    this.messages = {
      create: async (
        params: Anthropic.MessageCreateParamsNonStreaming
      ): Promise<Anthropic.Message> => {
        // Map Anthropic params → OpenAI chat-completions params.
        const openaiMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

        const systemText = flattenSystem(params.system);
        if (systemText !== '') {
          openaiMessages.push({ role: 'system', content: systemText });
        }

        for (const m of params.messages) {
          // Anthropic roles are 'user' | 'assistant' — both valid for OpenAI chat.
          openaiMessages.push({ role: m.role, content: flattenContent(m.content) });
        }

        const completion = await openai.chat.completions.create({
          model: params.model,
          // Decision 3: floor max_tokens so reasoning models don't truncate mid-think.
          max_tokens: Math.max(params.max_tokens ?? 0, MIN_MAX_TOKENS),
          // Decision 4: deterministic.
          temperature: 0,
          // Decision 5: NO response_format json_object (would break prose calls).
          messages: openaiMessages,
        });

        const raw = completion.choices[0]?.message?.content ?? '';
        // Decision 6: strip <think> blocks before returning.
        const text = stripThinkBlocks(raw);

        // Return a minimal Anthropic.Message-compatible object (decision 7).
        return {
          id: completion.id ?? 'ollama',
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
