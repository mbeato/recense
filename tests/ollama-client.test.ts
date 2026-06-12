/**
 * OllamaClient — native constrained-decoding path tests (QUICK-260612-clb).
 *
 * These tests cover the new /api/chat native path that is invoked when
 * messages.create receives a jsonSchema extra argument. The existing
 * OpenAI-compat path tests remain in tests/anthropic-client.test.ts.
 *
 * T-05-KEY: no API keys in any of these tests.
 * T-CLB-02: the nativeUrl is derived from the constructor's localBaseUrl,
 *            not from user input — verified by checking fetch's URL arg.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type OpenAI from 'openai';
import { OllamaClient } from '../src/model/ollama-client';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = 'http://localhost:11434/v1';
const EXPECTED_NATIVE_URL = 'http://localhost:11434/api/chat';

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

const SAMPLE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['entity', 'fact'] },
      value: { type: 'string' },
      links: { type: 'array', items: { type: 'string' } },
    },
    required: ['type', 'value'],
  },
};

// ---------------------------------------------------------------------------
// Native constrained-decoding path (/api/chat)
// ---------------------------------------------------------------------------

describe('OllamaClient — native constrained-decoding path', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls /api/chat (not OpenAI-compat) when jsonSchema is provided', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: '[{"type":"fact","value":"x"}]' } }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const openai = {} as OpenAI; // should NOT be called
    const client = new OllamaClient(openai, BASE_URL);

    await client.messages.create(
      { model: 'qwen2.5:7b-instruct', max_tokens: 8192, messages: [{ role: 'user', content: 'extract' }] },
      { jsonSchema: SAMPLE_SCHEMA }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(EXPECTED_NATIVE_URL);
  });

  it('sends format=schema, think=false, stream=false, temperature=0 in the native body', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: '[]' } }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const openai = {} as OpenAI;
    const client = new OllamaClient(openai, BASE_URL);

    await client.messages.create(
      { model: 'qwen2.5:7b-instruct', max_tokens: 8192, messages: [{ role: 'user', content: 'extract' }] },
      { jsonSchema: SAMPLE_SCHEMA }
    );

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);

    expect(body.format).toEqual(SAMPLE_SCHEMA);
    expect(body.think).toBe(false);
    expect(body.stream).toBe(false);
    expect(body.options.temperature).toBe(0);
  });

  it('num_predict is at least MIN_MAX_TOKENS (8192) even when caller requests fewer', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: '[]' } }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const openai = {} as OpenAI;
    const client = new OllamaClient(openai, BASE_URL);

    await client.messages.create(
      { model: 'test-model', max_tokens: 256, messages: [{ role: 'user', content: 'hi' }] },
      { jsonSchema: { type: 'array' } }
    );

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.options.num_predict).toBeGreaterThanOrEqual(8192);
  });

  it('respects a large max_tokens value above the floor', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: '[]' } }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const openai = {} as OpenAI;
    const client = new OllamaClient(openai, BASE_URL);

    await client.messages.create(
      { model: 'test-model', max_tokens: 16000, messages: [{ role: 'user', content: 'hi' }] },
      { jsonSchema: { type: 'array' } }
    );

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.options.num_predict).toBe(16000);
  });

  it('returns the model response as an Anthropic.Message-shaped text block', async () => {
    const responseContent = '[{"type":"fact","value":"test claim"}]';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: responseContent } }),
    }));

    const openai = {} as OpenAI;
    const client = new OllamaClient(openai, BASE_URL);

    const msg = await client.messages.create(
      { model: 'qwen2.5:7b-instruct', max_tokens: 8192, messages: [{ role: 'user', content: 'extract' }] },
      { jsonSchema: SAMPLE_SCHEMA }
    );

    expect(msg.type).toBe('message');
    expect(msg.role).toBe('assistant');
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]!.type).toBe('text');
    const text = msg.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toBe(responseContent);
  });

  it('strips <think> blocks from native path response (defensive)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: '<think>reasoning</think>[{"type":"fact","value":"clean"}]' } }),
    }));

    const openai = {} as OpenAI;
    const client = new OllamaClient(openai, BASE_URL);

    const msg = await client.messages.create(
      { model: 'qwen2.5:7b-instruct', max_tokens: 8192, messages: [{ role: 'user', content: 'extract' }] },
      { jsonSchema: SAMPLE_SCHEMA }
    );

    const text = msg.content.map((b: any) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toBe('[{"type":"fact","value":"clean"}]');
  });

  it('derives nativeUrl by stripping /v1 suffix from localBaseUrl', async () => {
    // Test with a non-default localBaseUrl
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: '[]' } }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const openai = {} as OpenAI;
    const client = new OllamaClient(openai, 'http://remote-host:11434/v1');

    await client.messages.create(
      { model: 'test', max_tokens: 512, messages: [{ role: 'user', content: 'hi' }] },
      { jsonSchema: { type: 'array' } }
    );

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://remote-host:11434/api/chat');
  });
});

// ---------------------------------------------------------------------------
// No-schema path — must NOT invoke fetch
// ---------------------------------------------------------------------------

describe('OllamaClient — no jsonSchema (OpenAI-compat path unchanged)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT call fetch when no jsonSchema is provided', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { openai, calls } = makeFakeOpenAI('result text');
    const client = new OllamaClient(openai, BASE_URL);

    await client.messages.create({
      model: 'qwen2.5:7b-instruct',
      max_tokens: 8192,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1); // OpenAI-compat create was called
  });

  it('does NOT call fetch when extra is provided but jsonSchema is absent', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { openai, calls } = makeFakeOpenAI('result text');
    const client = new OllamaClient(openai, BASE_URL);

    // extra object exists but jsonSchema is undefined
    await client.messages.create(
      { model: 'test', max_tokens: 256, messages: [{ role: 'user', content: 'hi' }] },
      {}
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });
});
