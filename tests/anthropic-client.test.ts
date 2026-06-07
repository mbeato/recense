/**
 * Unit tests for the anthropic-client provider factory.
 *
 * Only resolveModelId is tested here — it is pure (no creds, no network).
 * createAnthropicClient is NOT called; client construction requires credentials.
 */
import { describe, it, expect } from 'vitest';
import type OpenAI from 'openai';
import { resolveModelId } from '../src/model/anthropic-client';
import { OllamaClient } from '../src/model/ollama-client';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';

const baseConfig: EngineConfig = {
  ...DEFAULT_CONFIG,
  dbPath: ':memory:',
};

describe('resolveModelId', () => {
  it('returns anthropicModel when modelProvider is anthropic (default)', () => {
    const config: EngineConfig = { ...baseConfig, modelProvider: 'anthropic' };
    expect(resolveModelId(config)).toBe(config.anthropicModel);
  });

  it('returns vertexModel when modelProvider is vertex', () => {
    const config: EngineConfig = { ...baseConfig, modelProvider: 'vertex' };
    expect(resolveModelId(config)).toBe(config.vertexModel);
  });

  it('returns localModel when modelProvider is local', () => {
    const config: EngineConfig = { ...baseConfig, modelProvider: 'local' };
    expect(resolveModelId(config)).toBe(config.localModel);
  });

  it('default config resolves to anthropicModel (zero behavior change)', () => {
    expect(resolveModelId(baseConfig)).toBe(DEFAULT_CONFIG.anthropicModel);
  });
});

describe('OllamaClient adapter', () => {
  /**
   * Build a fake OpenAI-shaped client that records the params it was called with
   * and returns a scripted assistant content string.
   */
  function makeFakeOpenAI(content: string): { openai: OpenAI; calls: any[] } {
    const calls: any[] = [];
    const openai = {
      chat: {
        completions: {
          create: async (params: any) => {
            calls.push(params);
            return { id: 'cmpl-test', choices: [{ message: { content } }] };
          },
        },
      },
    } as unknown as OpenAI;
    return { openai, calls };
  }

  it('floors max_tokens to 8192 when caller passes 256', async () => {
    const { openai, calls } = makeFakeOpenAI('hello');
    const client = new OllamaClient(openai);
    await client.messages.create({
      model: 'qwen3.6:35b-a3b',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls[0].max_tokens).toBe(8192);
    expect(calls[0].temperature).toBe(0);
    expect('response_format' in calls[0]).toBe(false);
  });

  it('keeps a larger requested max_tokens above the floor', async () => {
    const { openai, calls } = makeFakeOpenAI('hello');
    const client = new OllamaClient(openai);
    await client.messages.create({
      model: 'qwen3.6:35b-a3b',
      max_tokens: 16000,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls[0].max_tokens).toBe(16000);
  });

  it('strips <think>...</think> blocks from returned content', async () => {
    const { openai } = makeFakeOpenAI('<think>reasoning here</think>{"relation":"contradict"}');
    const client = new OllamaClient(openai);
    const msg = await client.messages.create({
      model: 'qwen3.6:35b-a3b',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const text = msg.content.map(b => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toBe('{"relation":"contradict"}');
  });

  it('strips an unclosed <think> block to end of string', async () => {
    const { openai } = makeFakeOpenAI('answer<think>never closed');
    const client = new OllamaClient(openai);
    const msg = await client.messages.create({
      model: 'qwen3.6:35b-a3b',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const text = msg.content.map(b => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toBe('answer');
  });

  it('returns an Anthropic.Message-shaped object with a single text block', async () => {
    const { openai } = makeFakeOpenAI('hi there');
    const client = new OllamaClient(openai);
    const msg = await client.messages.create({
      model: 'qwen3.6:35b-a3b',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(msg.type).toBe('message');
    expect(msg.role).toBe('assistant');
    expect(msg.model).toBe('qwen3.6:35b-a3b');
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]!.type).toBe('text');
    expect(msg.stop_reason).toBe('end_turn');
  });

  it('maps the system param to a leading system message', async () => {
    const { openai, calls } = makeFakeOpenAI('ok');
    const client = new OllamaClient(openai);
    await client.messages.create({
      model: 'qwen3.6:35b-a3b',
      max_tokens: 256,
      system: 'you are a judge',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls[0].messages[0]).toEqual({ role: 'system', content: 'you are a judge' });
    expect(calls[0].messages[1]).toEqual({ role: 'user', content: 'hi' });
  });
});
