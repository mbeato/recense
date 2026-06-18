/**
 * QUICK-260617-qat — headless `claude -p` transport unit tests (mocked spawn).
 *
 * No real `claude` binary is invoked. We mock node:child_process.spawn and assert:
 *  (a) the argv carries the lean flag set + the resolved --model,
 *  (b) the spawn env has ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN STRIPPED
 *      (the load-bearing billing safeguard — the whole point of the transport),
 *  (c) cwd === os.tmpdir() (neutral cwd; no project CLAUDE.md / recursive Stop-hook),
 *  (d) a fake `{"result":"..."}` envelope is parsed into a {content:[{type:'text'}]} message,
 *  (e) a non-zero exit yields empty text (production fail-safe), not a throw.
 */
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mock node:child_process.spawn -----------------------------------------
const spawnCalls: Array<{ bin: string; args: string[]; opts: any; stdin: string }> = [];
let nextClose: { code: number; stdout: string } = { code: 0, stdout: '' };

function makeFakeChild(stdin: { value: string }) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: (d: string) => { stdin.value += d; }, end: () => {} };
  child.kill = vi.fn();
  // After the caller attaches its listeners (synchronously post-spawn), emit the envelope.
  setImmediate(() => {
    if (nextClose.stdout) child.stdout.emit('data', nextClose.stdout);
    child.emit('close', nextClose.code);
  });
  return child;
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn((bin: string, args: string[], opts: any) => {
    const stdin = { value: '' };
    const child = makeFakeChild(stdin);
    // Record the call once stdin has been written (next tick captures the final value).
    queueMicrotask(() => spawnCalls.push({ bin, args, opts, stdin: stdin.value }));
    return child;
  }),
}));

import { createClaudeHeadlessClient } from '../src/model/claude-headless-client';
import { DEFAULT_CONFIG } from '../src/lib/config';

function cfg(overrides: Record<string, unknown> = {}) {
  return { ...DEFAULT_CONFIG, dbPath: ':memory:', modelProvider: 'claude-headless', ...overrides } as any;
}

describe('createClaudeHeadlessClient', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    nextClose = { code: 0, stdout: '' };
  });

  it('builds the lean argv with the resolved --model and parses the envelope', async () => {
    nextClose = { code: 0, stdout: JSON.stringify({ result: '{"relation":"unrelated"}' }) };
    const { client, model } = createClaudeHeadlessClient(cfg({ claudeHeadlessModel: 'claude-sonnet-4-6' }));
    expect(model).toBe('claude-sonnet-4-6');

    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'judge prompt here' }],
    } as any);

    // (d) envelope .result becomes the text block
    expect(msg.content).toEqual([{ type: 'text', text: '{"relation":"unrelated"}' }]);

    const call = spawnCalls[0]!;
    // (a) lean flag set + model + hook-isolation flag
    expect(call.args).toEqual(expect.arrayContaining([
      '-p', '--tools', 'none', '--strict-mcp-config', '--exclude-dynamic-system-prompt-sections',
    ]));
    // hook isolation: --setting-sources project drops global capture/inject hooks
    // (prevents the self-ingestion loop) — must be a flag+value pair, in order.
    const ssIdx = call.args.indexOf('--setting-sources');
    expect(ssIdx).toBeGreaterThanOrEqual(0);
    expect(call.args[ssIdx + 1]).toBe('project');
    const modelIdx = call.args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(call.args[modelIdx + 1]).toBe('claude-sonnet-4-6');
    // stdin carries the user message
    expect(call.stdin).toBe('judge prompt here');
  });

  it('strips ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the spawn env (billing safeguard)', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-should-not-leak';
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'tok-should-not-leak';
    nextClose = { code: 0, stdout: JSON.stringify({ result: 'ok' }) };

    const { client } = createClaudeHeadlessClient(cfg());
    await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'x' }],
    } as any);

    const call = spawnCalls[0]!;
    // (b) keys absent from child env
    expect(call.opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call.opts.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    // (c) neutral cwd
    expect(call.opts.cwd).toBe(os.tmpdir());

    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_AUTH_TOKEN'];
  });

  it('returns empty text on non-zero exit (production fail-safe, no throw)', async () => {
    nextClose = { code: 1, stdout: 'irrelevant' };
    const { client } = createClaudeHeadlessClient(cfg());
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'x' }],
    } as any);
    expect(msg.content).toEqual([{ type: 'text', text: '' }]);
  });

  it('accepts a content-block array message shape', async () => {
    nextClose = { code: 0, stdout: JSON.stringify({ result: 'blockcontent' }) };
    const { client } = createClaudeHeadlessClient(cfg());
    await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'block prompt' }] }],
    } as any);
    expect(spawnCalls[0]!.stdin).toBe('block prompt');
  });
});
