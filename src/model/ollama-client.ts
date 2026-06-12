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
 * Constrained-decoding native path (QUICK-260612-clb):
 *  - When `extra.jsonSchema` is provided, bypasses the OpenAI-compat /v1 endpoint (which
 *    silently ignores response_format json_schema — ollama#10001/#10937) and POSTs directly
 *    to the native /api/chat endpoint with `format=<schema>, think:false, temperature:0`.
 *  - The nativeUrl is derived ONLY from the config-controlled localBaseUrl (T-CLB-02: no
 *    user-supplied URL; host is the operator's own localhost Ollama).
 *  - No key handling: local path uses dummy 'ollama' key inside the SDK (T-05-KEY).
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
 * client already pointed at the Ollama base URL, plus the localBaseUrl so the native
 * /api/chat endpoint can be derived for constrained-decoding calls.
 *
 * T-CLB-02: nativeUrl is derived solely from localBaseUrl (config-controlled, never
 * from user input). No SSRF surface — host is the operator's own Ollama instance.
 */
export class OllamaClient implements AnthropicLike {
  readonly messages: AnthropicLike['messages'];

  /**
   * @param openai      - OpenAI SDK client pointed at the Ollama /v1 endpoint.
   * @param localBaseUrl - The full Ollama base URL including the /v1 suffix
   *                       (e.g. 'http://localhost:11434/v1'). Used to derive the
   *                       native /api/chat URL for constrained-decoding requests.
   *                       Defaults to 'http://localhost:11434/v1'.
   */
  constructor(openai: OpenAI, localBaseUrl: string = 'http://localhost:11434/v1') {
    // Derive the native endpoint once at construction time (T-CLB-02).
    // Strip the trailing /v1 (with or without trailing slash) to get the root URL.
    const nativeUrl = localBaseUrl.replace(/\/v1\/?$/, '') + '/api/chat';

    this.messages = {
      create: async (
        params: Anthropic.MessageCreateParamsNonStreaming,
        extra?: { jsonSchema?: object }
      ): Promise<Anthropic.Message> => {
        // ── Native constrained-decoding path ──────────────────────────────
        // When a JSON schema is requested, use the native /api/chat endpoint.
        // The OpenAI-compat /v1/chat/completions endpoint silently ignores
        // response_format json_schema (ollama#10001/#10937), making constrained
        // output impossible via the compat route.
        if (extra?.jsonSchema !== undefined) {
          // Map messages exactly as the OpenAI-compat path does.
          const nativeMessages: Array<{ role: string; content: string }> = [];
          const systemText = flattenSystem(params.system);
          if (systemText !== '') {
            nativeMessages.push({ role: 'system', content: systemText });
          }
          for (const m of params.messages) {
            nativeMessages.push({ role: m.role, content: flattenContent(m.content) });
          }

          const nativeBody = {
            model: params.model,
            messages: nativeMessages,
            stream: false,
            think: false,  // Disable reasoning pass; leakage still stripped below (defensive)
            format: extra.jsonSchema,
            options: {
              temperature: 0,
              num_predict: Math.max(params.max_tokens ?? 0, MIN_MAX_TOKENS),
            },
          };

          // T-CLB-02: nativeUrl is config-controlled (set at construction); no user-supplied URL.
          const resp = await fetch(nativeUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(nativeBody),
          });

          const json = (await resp.json()) as { message: { content: string } };
          const raw = json.message?.content ?? '';
          // Defensive: stripThinkBlocks should be a no-op with think:false, but any leakage
          // is a model bug the bake-off can flag. Strip it so callers always get clean output.
          const text = stripThinkBlocks(raw);

          return {
            id: 'ollama-native',
            type: 'message',
            role: 'assistant',
            model: params.model,
            content: [{ type: 'text', text, citations: null }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          } as unknown as Anthropic.Message;
        }

        // ── OpenAI-compat path (unchanged) ────────────────────────────────
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
