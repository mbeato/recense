/**
 * Phase 44 Plan 03 — token_usage_ledger + feature-tag plumbing tests (D-08/D-09/D-10).
 *
 * Covers:
 *   Task 1 — feature_tag derivation at both headless-client emit sites:
 *     - setHeadlessFeature('corpus_gen') → sink receives feature_tag='corpus_gen'
 *     - ambient cleared + Sonnet model → model-derived fallback 'judge'
 *     - ambient cleared + Haiku model  → model-derived fallback 'extract'
 *     - unknown model                   → 'unknown'
 *   Task 2 — best-effort / never-abort guard:
 *     - sink that throws does NOT interrupt surrounding flow
 *   Task 2 — production ledger sink (DB row assertions):
 *     - one row per emitted HeadlessUsage, correct feature_tag + token columns
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db/schema';

// ── Mock node:child_process.spawn ────────────────────────────────────────────
// Mirrors the pattern in tests/claude-headless-client.test.ts so we can drive
// the headless client without a real `claude` binary.

interface SpawnCall { bin: string; args: string[]; opts: unknown; stdin: string }
const spawnCalls: SpawnCall[] = [];
let nextClose: { code: number; stdout: string } = { code: 0, stdout: '' };

function makeFakeChild(stdinHolder: { value: string }) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: (d: string) => void; end: () => void };
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = {
    write: (d: string) => { stdinHolder.value += d; },
    end: () => {},
  };
  child.kill = vi.fn();
  setImmediate(() => {
    if (nextClose.stdout) child.stdout.emit('data', nextClose.stdout);
    child.emit('close', nextClose.code);
  });
  return child;
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn((bin: string, args: string[], opts: unknown) => {
    const stdinHolder = { value: '' };
    const child = makeFakeChild(stdinHolder);
    queueMicrotask(() => spawnCalls.push({ bin, args, opts, stdin: stdinHolder.value }));
    return child;
  }),
}));

import {
  setHeadlessUsageSink,
  setHeadlessFeature,
  type HeadlessUsage,
} from '../src/model/claude-headless-client';
import { DEFAULT_CONFIG } from '../src/lib/config';

/** Create a minimal EngineConfig pointing at the in-memory DB. */
function cfg(overrides: Record<string, unknown> = {}) {
  return { ...DEFAULT_CONFIG, dbPath: ':memory:', modelProvider: 'claude-headless', ...overrides } as typeof DEFAULT_CONFIG & { dbPath: string };
}

/** Build a valid `claude -p --output-format json` envelope string. */
function envelope(opts: {
  model?: string;
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
  cost?: number;
} = {}) {
  return JSON.stringify({
    result: 'ok',
    usage: {
      input_tokens: opts.input ?? 10,
      output_tokens: opts.output ?? 5,
      cache_creation_input_tokens: opts.cacheWrite ?? 0,
      cache_read_input_tokens: opts.cacheRead ?? 0,
    },
    total_cost_usd: opts.cost ?? 0.001,
    duration_ms: 100,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 1 tests — feature_tag derivation
// ─────────────────────────────────────────────────────────────────────────────

describe('feature_tag derivation at headless client emit sites', () => {
  // Lazily import the createClaudeHeadlessClient after the mock is in place
  // (vi.mock is hoisted, so the import can happen at the describe level).
  let createClaudeHeadlessClient: (c: ReturnType<typeof cfg>) => { client: { messages: { create: (p: unknown) => Promise<unknown> } }; model: string };

  beforeEach(async () => {
    // Import dynamically so the vi.mock is already in effect
    const mod = await import('../src/model/claude-headless-client');
    createClaudeHeadlessClient = mod.createClaudeHeadlessClient as typeof createClaudeHeadlessClient;
    spawnCalls.length = 0;
    nextClose = { code: 0, stdout: '' };
    // Always clear state between tests
    setHeadlessFeature(null);
    setHeadlessUsageSink(null);
  });

  afterEach(() => {
    setHeadlessFeature(null);
    setHeadlessUsageSink(null);
  });

  it('setHeadlessFeature ambient overrides model-derived fallback (corpus_gen)', async () => {
    const captured: HeadlessUsage[] = [];
    setHeadlessUsageSink(u => captured.push(u));
    setHeadlessFeature('corpus_gen');

    // Use a Sonnet model — without the ambient tag, fallback would be 'judge'
    nextClose = { code: 0, stdout: envelope({ input: 10, output: 5 }) };
    const { client } = createClaudeHeadlessClient(cfg({ claudeHeadlessModel: 'claude-sonnet-4-6' }));
    await client.messages.create({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.feature_tag).toBe('corpus_gen');
  });

  it('model-derived fallback: Sonnet → "judge" when ambient is null', async () => {
    const captured: HeadlessUsage[] = [];
    setHeadlessUsageSink(u => captured.push(u));
    setHeadlessFeature(null); // no ambient

    nextClose = { code: 0, stdout: envelope() };
    const { client } = createClaudeHeadlessClient(cfg({ claudeHeadlessModel: 'claude-sonnet-4-6' }));
    await client.messages.create({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.feature_tag).toBe('judge');
  });

  it('model-derived fallback: Haiku → "extract" when ambient is null', async () => {
    const captured: HeadlessUsage[] = [];
    setHeadlessUsageSink(u => captured.push(u));
    setHeadlessFeature(null);

    nextClose = { code: 0, stdout: envelope() };
    const { client } = createClaudeHeadlessClient(cfg({ claudeHeadlessModel: 'claude-haiku-4-5' }));
    await client.messages.create({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hi' }] });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.feature_tag).toBe('extract');
  });

  it('model-derived fallback: unknown model → "unknown"', async () => {
    const captured: HeadlessUsage[] = [];
    setHeadlessUsageSink(u => captured.push(u));
    setHeadlessFeature(null);

    nextClose = { code: 0, stdout: envelope() };
    const { client } = createClaudeHeadlessClient(cfg({ claudeHeadlessModel: 'claude-opus-99' }));
    await client.messages.create({ model: 'claude-opus-99', messages: [{ role: 'user', content: 'hi' }] });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.feature_tag).toBe('unknown');
  });

  it('setHeadlessFeature("schema_abstract") tags schema-phase calls correctly', async () => {
    const captured: HeadlessUsage[] = [];
    setHeadlessUsageSink(u => captured.push(u));
    setHeadlessFeature('schema_abstract');

    nextClose = { code: 0, stdout: envelope() };
    const { client } = createClaudeHeadlessClient(cfg({ claudeHeadlessModel: 'claude-sonnet-4-6' }));
    await client.messages.create({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }] });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.feature_tag).toBe('schema_abstract');
  });

  it('clearing the ambient tag restores model-derived fallback', async () => {
    const captured: HeadlessUsage[] = [];
    setHeadlessUsageSink(u => captured.push(u));

    // First call with ambient set
    setHeadlessFeature('corpus_gen');
    nextClose = { code: 0, stdout: envelope() };
    const { client } = createClaudeHeadlessClient(cfg({ claudeHeadlessModel: 'claude-sonnet-4-6' }));
    await client.messages.create({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'first' }] });

    // Clear ambient — should now use model-derived fallback
    setHeadlessFeature(null);
    nextClose = { code: 0, stdout: envelope() };
    await client.messages.create({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'second' }] });

    expect(captured).toHaveLength(2);
    expect(captured[0]!.feature_tag).toBe('corpus_gen');
    expect(captured[1]!.feature_tag).toBe('judge');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 2 tests — best-effort guard + production ledger sink
// ─────────────────────────────────────────────────────────────────────────────

describe('production ledger sink — best-effort guard', () => {
  let createClaudeHeadlessClient: (c: ReturnType<typeof cfg>) => { client: { messages: { create: (p: unknown) => Promise<unknown> } }; model: string };

  beforeEach(async () => {
    const mod = await import('../src/model/claude-headless-client');
    createClaudeHeadlessClient = mod.createClaudeHeadlessClient as typeof createClaudeHeadlessClient;
    spawnCalls.length = 0;
    nextClose = { code: 0, stdout: '' };
    setHeadlessFeature(null);
    setHeadlessUsageSink(null);
  });

  afterEach(() => {
    setHeadlessFeature(null);
    setHeadlessUsageSink(null);
  });

  it('a throwing sink does NOT interrupt surrounding flow (best-effort guard)', async () => {
    let sinkCallCount = 0;
    setHeadlessUsageSink(() => {
      sinkCallCount++;
      throw new Error('ledger write failed — simulated');
    });

    nextClose = { code: 0, stdout: envelope() };
    const { client } = createClaudeHeadlessClient(cfg({ claudeHeadlessModel: 'claude-sonnet-4-6' }));

    // Should NOT throw despite the sink throwing
    let result: unknown;
    await expect(
      client.messages.create({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'hi' }],
      }).then(r => { result = r; }),
    ).resolves.toBeUndefined();

    // Sink was called (the throw is swallowed)
    expect(sinkCallCount).toBe(1);
    // Result is still a valid Anthropic message shape
    const msg = result as { content: Array<{ type: string; text: string }> };
    expect(msg.content[0]?.type).toBe('text');
    expect(msg.content[0]?.text).toBe('ok');
  });
});

describe('production ledger sink — DB row assertions', () => {
  let createClaudeHeadlessClient: (c: ReturnType<typeof cfg>) => { client: { messages: { create: (p: unknown) => Promise<unknown> } }; model: string };

  beforeEach(async () => {
    const mod = await import('../src/model/claude-headless-client');
    createClaudeHeadlessClient = mod.createClaudeHeadlessClient as typeof createClaudeHeadlessClient;
    spawnCalls.length = 0;
    nextClose = { code: 0, stdout: '' };
    setHeadlessFeature(null);
    setHeadlessUsageSink(null);
  });

  afterEach(() => {
    setHeadlessFeature(null);
    setHeadlessUsageSink(null);
  });

  it('appends exactly one row per emitted HeadlessUsage with correct columns', async () => {
    const db = new Database(':memory:');
    initSchema(db);

    // Production-style sink matching what sleep-pass-cli.ts will install (D-08).
    const stmtInsert = db.prepare(`
      INSERT INTO token_usage_ledger
        (ts, feature_tag, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, total_cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    setHeadlessUsageSink((u: HeadlessUsage) => {
      try {
        stmtInsert.run(
          Date.now(),
          u.feature_tag ?? 'unknown',
          u.model,
          u.usage?.['input_tokens'] ?? 0,
          u.usage?.['output_tokens'] ?? 0,
          u.usage?.['cache_creation_input_tokens'] ?? 0,
          u.usage?.['cache_read_input_tokens'] ?? 0,
          u.total_cost_usd ?? 0,
        );
      } catch {
        // best-effort
      }
    });

    // Emit 1: corpus_gen with known token counts
    setHeadlessFeature('corpus_gen');
    nextClose = { code: 0, stdout: envelope({ input: 100, output: 50, cacheWrite: 10, cacheRead: 5, cost: 0.002 }) };
    const { client } = createClaudeHeadlessClient(cfg({ claudeHeadlessModel: 'claude-sonnet-4-6' }));
    await client.messages.create({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'gen' }] });

    // Emit 2: judge (model-derived fallback, no ambient)
    setHeadlessFeature(null);
    nextClose = { code: 0, stdout: envelope({ input: 20, output: 8, cost: 0.0005 }) };
    await client.messages.create({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'judge' }] });

    const rows = db.prepare('SELECT * FROM token_usage_ledger ORDER BY id').all() as Array<{
      id: number; ts: number; feature_tag: string; model: string;
      input_tokens: number; output_tokens: number;
      cache_write_tokens: number; cache_read_tokens: number;
      total_cost_usd: number;
    }>;

    // Exactly two rows
    expect(rows).toHaveLength(2);

    // Row 1 — corpus_gen
    expect(rows[0]!.feature_tag).toBe('corpus_gen');
    expect(rows[0]!.model).toBe('claude-sonnet-4-6');
    expect(rows[0]!.input_tokens).toBe(100);
    expect(rows[0]!.output_tokens).toBe(50);
    expect(rows[0]!.cache_write_tokens).toBe(10);
    expect(rows[0]!.cache_read_tokens).toBe(5);
    expect(rows[0]!.total_cost_usd).toBeCloseTo(0.002);
    expect(rows[0]!.ts).toBeGreaterThan(0);

    // Row 2 — judge (model-derived fallback)
    expect(rows[1]!.feature_tag).toBe('judge');
    expect(rows[1]!.model).toBe('claude-sonnet-4-6');
    expect(rows[1]!.input_tokens).toBe(20);
    expect(rows[1]!.output_tokens).toBe(8);

    db.close();
  });

  it('token_usage_ledger table exists in initSchema (idempotent CREATE IF NOT EXISTS)', () => {
    const db = new Database(':memory:');
    // Run initSchema twice — idempotent
    initSchema(db);
    initSchema(db);

    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='token_usage_ledger'"
    ).get() as { name: string } | undefined;

    expect(row?.name).toBe('token_usage_ledger');

    // Verify the ts index exists
    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_token_usage_ledger_ts'"
    ).get() as { name: string } | undefined;
    expect(idx?.name).toBe('idx_token_usage_ledger_ts');

    db.close();
  });
});
