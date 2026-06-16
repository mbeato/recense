/**
 * Tests for OpenAICompatClient retry wiring (KXE task 2).
 *
 * Uses a fake OpenAI-shaped object so no real network calls are made.
 * Exercises the public client.messages.create() surface.
 */
import { describe, it, expect, vi } from 'vitest';
import type OpenAI from 'openai';
import { OpenAICompatClient } from '../src/model/openai-compat-client';

/** Minimal completion shape that passes through the adapter mapping. */
function makeCompletion(content: string) {
  return {
    id: 'cmpl-test',
    choices: [{ message: { content } }],
  };
}

/** Minimal params required by the AnthropicLike interface. */
const BASE_PARAMS = {
  model: 'deepseek-chat',
  max_tokens: 256,
  messages: [{ role: 'user' as const, content: 'classify this' }],
};

describe('OpenAICompatClient – retry wiring (KXE)', () => {
  it('happy path: create called once, returns well-formed Anthropic.Message', async () => {
    const createFn = vi.fn().mockResolvedValue(makeCompletion('{"relation":"unrelated"}'));
    const fakeOpenAI = {
      chat: { completions: { create: createFn } },
    } as unknown as OpenAI;

    const client = new OpenAICompatClient(fakeOpenAI, 'deepseek-chat', 2);
    const msg = await client.messages.create(BASE_PARAMS);

    expect(createFn).toHaveBeenCalledTimes(1);
    expect(msg.type).toBe('message');
    expect(msg.role).toBe('assistant');
    expect(msg.stop_reason).toBe('end_turn');
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]!.type).toBe('text');
    const text = msg.content[0]!.type === 'text' ? (msg.content[0] as { type: 'text'; text: string }).text : '';
    expect(text).toBe('{"relation":"unrelated"}');
  });

  it('ECONNRESET: retries once and returns the parsed Anthropic.Message on success (create called twice)', async () => {
    const econnreset = Object.assign(new Error('Invalid response body while trying to fetch — read ECONNRESET'), {
      code: 'ECONNRESET',
    });
    const createFn = vi.fn()
      .mockRejectedValueOnce(econnreset)
      .mockResolvedValue(makeCompletion('{"relation":"unrelated"}'));
    const fakeOpenAI = {
      chat: { completions: { create: createFn } },
    } as unknown as OpenAI;

    const client = new OpenAICompatClient(fakeOpenAI, 'deepseek-chat', 2);
    const msg = await client.messages.create(BASE_PARAMS);

    expect(createFn).toHaveBeenCalledTimes(2);
    expect(msg.type).toBe('message');
    expect(msg.role).toBe('assistant');
    const text = msg.content[0]!.type === 'text' ? (msg.content[0] as { type: 'text'; text: string }).text : '';
    expect(text).toBe('{"relation":"unrelated"}');
  });

  it('FetchError message shape: retries on "read ECONNRESET" substring in message (create called twice)', async () => {
    const fetchErr = new Error('Invalid response body while trying to fetch https://api.deepseek.com/v1/chat/completions: read ECONNRESET');
    const createFn = vi.fn()
      .mockRejectedValueOnce(fetchErr)
      .mockResolvedValue(makeCompletion('{"verdict":"ok"}'));
    const fakeOpenAI = {
      chat: { completions: { create: createFn } },
    } as unknown as OpenAI;

    const client = new OpenAICompatClient(fakeOpenAI, 'deepseek-chat', 2);
    const msg = await client.messages.create(BASE_PARAMS);

    expect(createFn).toHaveBeenCalledTimes(2);
    const text = msg.content[0]!.type === 'text' ? (msg.content[0] as { type: 'text'; text: string }).text : '';
    expect(text).toBe('{"verdict":"ok"}');
  });

  it('401 Unauthorized: does NOT retry — rejects after exactly one create call', async () => {
    const authErr = Object.assign(new Error('Unauthorized'), { status: 401 });
    const createFn = vi.fn().mockRejectedValue(authErr);
    const fakeOpenAI = {
      chat: { completions: { create: createFn } },
    } as unknown as OpenAI;

    const client = new OpenAICompatClient(fakeOpenAI, 'deepseek-chat', 2);
    await expect(client.messages.create(BASE_PARAMS)).rejects.toBe(authErr);
    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it('400 Bad Request: does NOT retry — rejects after exactly one create call', async () => {
    const badReq = Object.assign(new Error('Bad Request'), { status: 400 });
    const createFn = vi.fn().mockRejectedValue(badReq);
    const fakeOpenAI = {
      chat: { completions: { create: createFn } },
    } as unknown as OpenAI;

    const client = new OpenAICompatClient(fakeOpenAI, 'deepseek-chat', 2);
    await expect(client.messages.create(BASE_PARAMS)).rejects.toBe(badReq);
    expect(createFn).toHaveBeenCalledTimes(1);
  });

  it('default maxRetries parameter keeps constructor backwards-compatible (2 args)', async () => {
    const createFn = vi.fn().mockResolvedValue(makeCompletion('{}'));
    const fakeOpenAI = {
      chat: { completions: { create: createFn } },
    } as unknown as OpenAI;

    // Constructing with only 2 args (no maxRetries) should not throw
    const client = new OpenAICompatClient(fakeOpenAI, 'deepseek-chat');
    const msg = await client.messages.create(BASE_PARAMS);
    expect(msg.type).toBe('message');
    expect(createFn).toHaveBeenCalledTimes(1);
  });
});
