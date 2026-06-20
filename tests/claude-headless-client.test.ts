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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import {
  createClaudeHeadlessClient,
  createClaudeHeadlessSurveyClient,
  buildSurveyHeadlessArgs,
  SURVEY_SYSTEM,
  setHeadlessUsageSink,
} from '../src/model/claude-headless-client';
import { DEFAULT_CONFIG } from '../src/lib/config';

function cfg(overrides: Record<string, unknown> = {}) {
  return { ...DEFAULT_CONFIG, dbPath: ':memory:', modelProvider: 'claude-headless', ...overrides } as any;
}

describe('createClaudeHeadlessClient', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    nextClose = { code: 0, stdout: '' };
    // Always reset the sink so tests never leak state into each other.
    setHeadlessUsageSink(null);
  });

  afterEach(() => {
    setHeadlessUsageSink(null);
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

  // ── EVAL-04 usage sink tests ────────────────────────────────────────────────

  it('default (null sink): sink is never called and behavior is identical', async () => {
    const spy = vi.fn();
    // Do NOT install the sink — verify the default null path.
    nextClose = { code: 0, stdout: JSON.stringify({ result: 'answer', usage: { input_tokens: 10 }, total_cost_usd: 0.001, duration_ms: 500 }) };
    const { client } = createClaudeHeadlessClient(cfg({ claudeHeadlessModel: 'claude-haiku-4-5' }));
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'x' }],
    } as any);
    // Production result unchanged.
    expect(msg.content).toEqual([{ type: 'text', text: 'answer' }]);
    // Spy was never installed — it was never called.
    expect(spy).not.toHaveBeenCalled();
  });

  it('installed sink receives parsed usage from a successful call', async () => {
    const usagePayload = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 10,
    };
    nextClose = {
      code: 0,
      stdout: JSON.stringify({
        result: 'ok',
        usage: usagePayload,
        total_cost_usd: 0.0012,
        duration_ms: 1234,
      }),
    };

    const captured: unknown[] = [];
    setHeadlessUsageSink(u => captured.push(u));

    const { client } = createClaudeHeadlessClient(cfg({ claudeHeadlessModel: 'claude-sonnet-4-6' }));
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'judge prompt' }],
    } as any);

    // Production result unchanged.
    expect(msg.content).toEqual([{ type: 'text', text: 'ok' }]);
    // Sink called exactly once with the correct payload.
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      model: 'claude-sonnet-4-6',
      usage: usagePayload,
      total_cost_usd: 0.0012,
      duration_ms: 1234,
    });
  });

  it('failure path (non-zero exit) does not invoke the sink', async () => {
    nextClose = { code: 1, stdout: JSON.stringify({ result: 'irrelevant', usage: { input_tokens: 9 }, total_cost_usd: 0.0001 }) };

    const captured: unknown[] = [];
    setHeadlessUsageSink(u => captured.push(u));

    const { client } = createClaudeHeadlessClient(cfg());
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'x' }],
    } as any);

    // Fail-safe empty result.
    expect(msg.content).toEqual([{ type: 'text', text: '' }]);
    // Sink must NOT be called on failure — no usage to report.
    expect(captured).toHaveLength(0);
  });

  it('a throwing sink does not break the call (result still returned)', async () => {
    nextClose = { code: 0, stdout: JSON.stringify({ result: 'safe', usage: { input_tokens: 5 }, total_cost_usd: 0.0005, duration_ms: 300 }) };

    setHeadlessUsageSink(() => { throw new Error('sink exploded'); });

    const { client } = createClaudeHeadlessClient(cfg({ claudeHeadlessModel: 'claude-haiku-4-5' }));
    // Must not throw.
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'x' }],
    } as any);

    // Production result is unaffected — throwing sink is swallowed.
    expect(msg.content).toEqual([{ type: 'text', text: 'safe' }]);
  });

  it('setHeadlessUsageSink(null) clears the sink; subsequent calls do not invoke it', async () => {
    const captured: unknown[] = [];
    setHeadlessUsageSink(u => captured.push(u));
    // Clear it.
    setHeadlessUsageSink(null);

    nextClose = { code: 0, stdout: JSON.stringify({ result: 'after-clear', usage: { input_tokens: 1 }, total_cost_usd: 0.00001, duration_ms: 100 }) };
    const { client } = createClaudeHeadlessClient(cfg());
    await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'x' }],
    } as any);

    // Sink was cleared — never called.
    expect(captured).toHaveLength(0);
  });
});

// ── Survey transport: buildSurveyHeadlessArgs ───────────────────────────────

describe('buildSurveyHeadlessArgs', () => {
  it('includes -p and --output-format json', () => {
    const args = buildSurveyHeadlessArgs('claude-sonnet-4-6', 'a system prompt', '/some/dir');
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
  });

  it('includes the model flag', () => {
    const args = buildSurveyHeadlessArgs('claude-sonnet-4-6', 'system', '/some/dir');
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('claude-sonnet-4-6');
  });

  it('includes the system prompt flag', () => {
    const args = buildSurveyHeadlessArgs('claude-sonnet-4-6', 'my survey system', '/some/dir');
    const sysIdx = args.indexOf('--system-prompt');
    expect(sysIdx).toBeGreaterThanOrEqual(0);
    expect(args[sysIdx + 1]).toBe('my survey system');
  });

  it('includes --setting-sources project (self-ingestion guard)', () => {
    const args = buildSurveyHeadlessArgs('claude-sonnet-4-6', 'system', '/some/dir');
    const ssIdx = args.indexOf('--setting-sources');
    expect(ssIdx).toBeGreaterThanOrEqual(0);
    expect(args[ssIdx + 1]).toBe('project');
  });

  it('includes --strict-mcp-config', () => {
    const args = buildSurveyHeadlessArgs('claude-sonnet-4-6', 'system', '/some/dir');
    expect(args).toContain('--strict-mcp-config');
  });

  it('includes --exclude-dynamic-system-prompt-sections', () => {
    const args = buildSurveyHeadlessArgs('claude-sonnet-4-6', 'system', '/some/dir');
    expect(args).toContain('--exclude-dynamic-system-prompt-sections');
  });

  it('includes --tools Read Grep Glob (read-only tool set, NOT none)', () => {
    const args = buildSurveyHeadlessArgs('claude-sonnet-4-6', 'system', '/some/dir');
    const toolsIdx = args.indexOf('--tools');
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(args[toolsIdx + 1]).toBe('Read');
    expect(args[toolsIdx + 2]).toBe('Grep');
    expect(args[toolsIdx + 3]).toBe('Glob');
    // CRITICAL: must NOT contain '--tools' 'none' (Pitfall 1)
    const toolsNoneIdx = args.indexOf('none');
    expect(toolsNoneIdx).toBe(-1);
  });

  it('includes --add-dir with the survey directory', () => {
    const args = buildSurveyHeadlessArgs('claude-sonnet-4-6', 'system', '/some/dir');
    const addDirIdx = args.indexOf('--add-dir');
    expect(addDirIdx).toBeGreaterThanOrEqual(0);
    expect(args[addDirIdx + 1]).toBe('/some/dir');
  });

  it('includes --permission-mode bypassPermissions', () => {
    const args = buildSurveyHeadlessArgs('claude-sonnet-4-6', 'system', '/some/dir');
    const pmIdx = args.indexOf('--permission-mode');
    expect(pmIdx).toBeGreaterThanOrEqual(0);
    expect(args[pmIdx + 1]).toBe('bypassPermissions');
  });

  it('does NOT contain --tools none', () => {
    const args = buildSurveyHeadlessArgs('claude-sonnet-4-6', 'system', '/some/dir');
    // Find all '--tools' occurrences and assert none is followed by 'none'
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--tools') {
        expect(args[i + 1]).not.toBe('none');
      }
    }
  });

  it('uses the supplied surveyDir as the --add-dir value', () => {
    const args = buildSurveyHeadlessArgs('claude-sonnet-4-6', 'system', '/Users/vtx/my-project');
    expect(args).toContain('/Users/vtx/my-project');
    const addDirIdx = args.indexOf('--add-dir');
    expect(args[addDirIdx + 1]).toBe('/Users/vtx/my-project');
  });
});

// ── SURVEY_SYSTEM ────────────────────────────────────────────────────────────

describe('SURVEY_SYSTEM', () => {
  it('is a non-empty string', () => {
    expect(typeof SURVEY_SYSTEM).toBe('string');
    expect(SURVEY_SYSTEM.length).toBeGreaterThan(0);
  });

  it('does NOT contain "no tool use" (NEUTRAL_SYSTEM forbidden phrase — tools must be permitted)', () => {
    // NEUTRAL_SYSTEM says "No preamble, no commentary, no tool use, no markdown fences..."
    // SURVEY_SYSTEM must NOT reuse that text or tools would be suppressed
    expect(SURVEY_SYSTEM.toLowerCase()).not.toContain('no tool use');
  });
});

// ── createClaudeHeadlessSurveyClient ─────────────────────────────────────────

describe('createClaudeHeadlessSurveyClient', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    nextClose = { code: 0, stdout: '' };
    setHeadlessUsageSink(null);
  });

  afterEach(() => {
    setHeadlessUsageSink(null);
  });

  it('spawns with cwd === os.tmpdir() (neutral cwd — Pitfall 4 defensive choice)', async () => {
    nextClose = { code: 0, stdout: JSON.stringify({ result: 'ok' }) };
    const { client } = createClaudeHeadlessSurveyClient(
      cfg({ claudeHeadlessModel: 'claude-sonnet-4-6' }),
      '/some/survey/dir',
    );
    await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'survey prompt' }],
    } as any);

    const call = spawnCalls[0]!;
    expect(call.opts.cwd).toBe(os.tmpdir());
  });

  it('passes --add-dir with the survey dir', async () => {
    nextClose = { code: 0, stdout: JSON.stringify({ result: 'ok' }) };
    const { client } = createClaudeHeadlessSurveyClient(cfg(), '/some/survey/dir');
    await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'survey prompt' }],
    } as any);

    const call = spawnCalls[0]!;
    const addDirIdx = call.args.indexOf('--add-dir');
    expect(addDirIdx).toBeGreaterThanOrEqual(0);
    expect(call.args[addDirIdx + 1]).toBe('/some/survey/dir');
  });

  it('passes --tools Read Grep Glob (not none)', async () => {
    nextClose = { code: 0, stdout: JSON.stringify({ result: 'ok' }) };
    const { client } = createClaudeHeadlessSurveyClient(cfg(), '/some/dir');
    await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'x' }],
    } as any);

    const call = spawnCalls[0]!;
    const toolsIdx = call.args.indexOf('--tools');
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(call.args[toolsIdx + 1]).toBe('Read');
    expect(call.args[toolsIdx + 2]).toBe('Grep');
    expect(call.args[toolsIdx + 3]).toBe('Glob');
    expect(call.args).not.toContain('none');
  });

  it('passes --permission-mode bypassPermissions', async () => {
    nextClose = { code: 0, stdout: JSON.stringify({ result: 'ok' }) };
    const { client } = createClaudeHeadlessSurveyClient(cfg(), '/some/dir');
    await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'x' }],
    } as any);

    const call = spawnCalls[0]!;
    const pmIdx = call.args.indexOf('--permission-mode');
    expect(pmIdx).toBeGreaterThanOrEqual(0);
    expect(call.args[pmIdx + 1]).toBe('bypassPermissions');
  });

  it('strips ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN (billing guard preserved)', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-should-not-leak';
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'tok-should-not-leak';
    nextClose = { code: 0, stdout: JSON.stringify({ result: 'ok' }) };

    const { client } = createClaudeHeadlessSurveyClient(cfg(), '/some/dir');
    await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'x' }],
    } as any);

    const call = spawnCalls[0]!;
    expect(call.opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call.opts.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();

    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_AUTH_TOKEN'];
  });

  it('passes --setting-sources project (self-ingestion guard preserved)', async () => {
    nextClose = { code: 0, stdout: JSON.stringify({ result: 'ok' }) };
    const { client } = createClaudeHeadlessSurveyClient(cfg(), '/some/dir');
    await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'x' }],
    } as any);

    const call = spawnCalls[0]!;
    const ssIdx = call.args.indexOf('--setting-sources');
    expect(ssIdx).toBeGreaterThanOrEqual(0);
    expect(call.args[ssIdx + 1]).toBe('project');
  });

  it('uses a non-empty system prompt that is NOT NEUTRAL_SYSTEM (NEUTRAL_SYSTEM forbids tool use)', async () => {
    nextClose = { code: 0, stdout: JSON.stringify({ result: 'ok' }) };
    const { client } = createClaudeHeadlessSurveyClient(cfg(), '/some/dir');
    await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'x' }],
    } as any);

    const call = spawnCalls[0]!;
    const sysIdx = call.args.indexOf('--system-prompt');
    expect(sysIdx).toBeGreaterThanOrEqual(0);
    const systemPrompt = call.args[sysIdx + 1]!;
    expect(systemPrompt.length).toBeGreaterThan(0);
    // Must NOT be NEUTRAL_SYSTEM (which says "no tool use")
    expect(systemPrompt).not.toContain('no tool use');
  });

  it('parses the JSON envelope result correctly', async () => {
    nextClose = { code: 0, stdout: JSON.stringify({ result: 'survey observations here' }) };
    const { client } = createClaudeHeadlessSurveyClient(cfg(), '/some/dir');
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: 'survey this' }],
    } as any);
    expect(msg.content).toEqual([{ type: 'text', text: 'survey observations here' }]);
  });

  it('returns empty text on non-zero exit (fail-safe preserved)', async () => {
    nextClose = { code: 1, stdout: 'irrelevant' };
    const { client } = createClaudeHeadlessSurveyClient(cfg(), '/some/dir');
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'x' }],
    } as any);
    expect(msg.content).toEqual([{ type: 'text', text: '' }]);
  });
});

// ── Regression guard: existing default path is UNCHANGED ─────────────────────

describe('existing default path regression (createClaudeHeadlessClient unchanged)', () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    nextClose = { code: 0, stdout: '' };
  });

  it('still carries --tools none on the default path (MUST stay green)', async () => {
    nextClose = { code: 0, stdout: JSON.stringify({ result: '{"relation":"unrelated"}' }) };
    const { client } = createClaudeHeadlessClient(cfg({ claudeHeadlessModel: 'claude-sonnet-4-6' }));
    await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'judge prompt here' }],
    } as any);

    const call = spawnCalls[0]!;
    expect(call.args).toContain('--tools');
    const toolsIdx = call.args.indexOf('--tools');
    expect(call.args[toolsIdx + 1]).toBe('none');
  });

  it('default path spawns cwd === os.tmpdir()', async () => {
    nextClose = { code: 0, stdout: JSON.stringify({ result: 'ok' }) };
    const { client } = createClaudeHeadlessClient(cfg());
    await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'x' }],
    } as any);
    expect(spawnCalls[0]!.opts.cwd).toBe(os.tmpdir());
  });
});
