/**
 * clients/telegram/tests/typed-confirm.test.ts
 *
 * Tests for the typed-confirmation state machine (D-09 / ACT-03):
 *   - Destructive approve registers a pending entry and does NOT execute (callTool = 0).
 *   - Correct typed value executes (callTool fires once) and clears the pending entry.
 *   - Wrong typed value aborts (no callTool) + writes a confirm-failed episode.
 *   - A normal Q&A message from a user with NO pending entry still reaches ask (no regression).
 *
 * No imports from ../../src/ — CLIENT-01 structural guard.
 *
 * Uses an in-memory MockMemoryClient (no HTTP server) and a mock McpConnectionFactory
 * so that tests are fully deterministic without live network calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  runClientTick,
  handleProposalAction,
  _clearPendingTypedConfirm,
  type ApprovalTestHooks,
} from '../index';
import { MockTelegramTransport } from '../transport';
import type { TelegramUpdate } from '../transport';
import { writeStateCursor } from '../state';
import { putProposal } from '../proposal-store';
import { encodeProposalCallbackData } from '../push-codec';
import type { ClientConfig } from '../config';
import type { MemoryClient, HitlEpisodeEntry } from '../memory-client';
import type { McpConnectionFactory, McpToolResult } from '../mcp-client';
import type { McpServerConfig, StoredProposal } from '../types';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ALLOWED_ID = '222';
const CHAT_ID = 222;
let _counter = 0;

function uniqueStorePath(): string {
  return path.join(os.tmpdir(), `tc-store-${Date.now()}-${++_counter}.json`);
}

function uniqueStatePath(): string {
  return path.join(os.tmpdir(), `tc-state-${Date.now()}-${++_counter}.json`);
}

function rmFile(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

function makeConfig(statePath: string): ClientConfig {
  return {
    telegramToken: 'test-token',
    serveUrl: 'http://127.0.0.1:9998',
    serveToken: 'test-serve-token',
    allowlist: [ALLOWED_ID],
    pollIntervalMs: 500,
    statePath,
    enabled: true,
    proactiveEnabled: false,
    pushPollMs: 120_000,
    quietHoursStart: 22,
    quietHoursEnd: 7,
    digestHour: 8,
    snoozeDurationMs: 86_400_000,
  };
}

/** A proposal that is destructive (requires typed confirmation). */
function makeDestructiveProposal(storePath: string): StoredProposal {
  const proposal: StoredProposal = {
    id: 'prop-destructive-001',
    serverName: 'test-server',
    tool: 'delete_file',
    args: { path: '/tmp/test.txt' },
    dueAt: new Date(Date.now() + 3_600_000).toISOString(), // due in 1 hour
    maxTtlMs: 3_600_000,
    createdAt: new Date().toISOString(),
    destructive: true,
    expectedConfirmValue: 'delete_file',
  };
  putProposal(proposal, storePath);
  return proposal;
}

/** A proposal that is NON-destructive (no typed confirmation). */
function makeNonDestructiveProposal(storePath: string): StoredProposal {
  const proposal: StoredProposal = {
    id: 'prop-safe-001',
    serverName: 'test-server',
    tool: 'list_files',
    args: { dir: '/tmp' },
    dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    maxTtlMs: 3_600_000,
    createdAt: new Date().toISOString(),
    destructive: false,
    expectedConfirmValue: 'list_files',
  };
  putProposal(proposal, storePath);
  return proposal;
}

/** MCP server config that allowlists both test tools. */
const TEST_MCP_CONFIGS: McpServerConfig[] = [{
  name: 'test-server',
  transport: 'stdio',
  command: '/bin/echo',
  allowedTools: [
    { name: 'delete_file', destructive: true },
    { name: 'list_files', destructive: false },
  ],
}];

/**
 * Build a mock McpConnectionFactory that records callTool invocations and
 * returns a scripted result.
 */
function makeMockConnectionFactory(callLog: Array<{ name: string; arguments: Record<string, unknown> }>): McpConnectionFactory {
  return () => ({
    async connect() {},
    async listTools() { return { tools: [] }; },
    async callTool(params) {
      callLog.push({ name: params.name, arguments: params.arguments });
      const result: McpToolResult = {
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      };
      return result;
    },
    async close() {},
  });
}

/**
 * Build a mock MemoryClient that records ask/hitlEpisode calls for assertions.
 * ask() returns { answer: null, origin: 'none' } so no reply is sent.
 */
function makeMockMemoryClient(): {
  client: MemoryClient;
  askCalls: string[];
  hitlCalls: HitlEpisodeEntry[];
} {
  const askCalls: string[] = [];
  const hitlCalls: HitlEpisodeEntry[] = [];

  const client: MemoryClient = {
    async ask(query) {
      askCalls.push(query);
      return { answer: null, origin: 'none' };
    },
    async search() { return []; },
    async surface() { return []; },
    async surfaceSeen() {},
    async hitlEpisode(entry) {
      hitlCalls.push({ ...entry });
    },
  };

  return { client, askCalls, hitlCalls };
}

function makeV2CallbackUpdate(proposalId: string, action: 'a' | 'r' | 's' | 'e', updateId = 10): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: CHAT_ID },
      data: encodeProposalCallbackData(proposalId, action),
    },
  };
}

function makeTextMessageUpdate(text: string, updateId = 20): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: CHAT_ID },
      chat: { id: CHAT_ID, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('typed-confirm state machine', () => {
  let storePath: string;
  let statePath: string;

  beforeEach(() => {
    storePath = uniqueStorePath();
    statePath = uniqueStatePath();
    _clearPendingTypedConfirm();
  });

  afterEach(() => {
    rmFile(storePath);
    rmFile(statePath);
    _clearPendingTypedConfirm();
  });

  // ── Test 1: Destructive approve registers pending entry, does NOT execute ──

  it('destructive approve sends confirm prompt and zero callTool fires', async () => {
    const proposal = makeDestructiveProposal(storePath);
    writeStateCursor(statePath, '0');

    const callLog: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const { client, hitlCalls } = makeMockMemoryClient();
    const hooks: ApprovalTestHooks = {
      storePath,
      mcpConfigs: TEST_MCP_CONFIGS,
      connectionFactory: makeMockConnectionFactory(callLog),
    };

    const t = new MockTelegramTransport([makeV2CallbackUpdate(proposal.id, 'a')]);
    const cfg = makeConfig(statePath);

    await runClientTick(cfg, t, client, hooks);

    // No execution — destructive approve only sends a prompt
    expect(callLog).toHaveLength(0);

    // A confirm prompt was sent
    expect(t.sent.length).toBeGreaterThanOrEqual(1);
    const prompt = t.sent.find(s => s.text.includes('Destructive action'));
    expect(prompt).toBeDefined();
    expect(prompt?.text).toContain(proposal.expectedConfirmValue);

    // answerCallbackQuery fired (Pitfall #1)
    expect(t.answeredCallbacks).toHaveLength(1);

    // confirm-requested episode written
    expect(hitlCalls.some(h => h.decision === 'confirm-requested')).toBe(true);
  });

  // ── Test 2: Correct typed value executes and clears the pending entry ──

  it('correct typed value executes (callTool fires) and the entry is consumed', async () => {
    const proposal = makeDestructiveProposal(storePath);
    writeStateCursor(statePath, '0');

    const callLog: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const { client, hitlCalls } = makeMockMemoryClient();
    const hooks: ApprovalTestHooks = {
      storePath,
      mcpConfigs: TEST_MCP_CONFIGS,
      connectionFactory: makeMockConnectionFactory(callLog),
    };
    const cfg = makeConfig(statePath);

    // Step 1: approve the destructive proposal (registers pending entry)
    const t1 = new MockTelegramTransport([makeV2CallbackUpdate(proposal.id, 'a', 10)]);
    await runClientTick(cfg, t1, client, hooks);
    expect(callLog).toHaveLength(0); // no execute yet

    // Step 2: send the correct typed value
    writeStateCursor(statePath, '10');
    const t2 = new MockTelegramTransport([makeTextMessageUpdate(proposal.expectedConfirmValue, 20)]);
    await runClientTick(cfg, t2, client, hooks);

    // callTool fired exactly once with the immutable stored args (H-06)
    expect(callLog).toHaveLength(1);
    expect(callLog[0]?.name).toBe(proposal.tool);

    // execute episode written
    expect(hitlCalls.some(h => h.decision === 'execute')).toBe(true);
    const execEpisode = hitlCalls.find(h => h.decision === 'execute');
    expect(execEpisode?.isError).toBe(false);
  });

  // ── Test 3: Wrong typed value aborts (no callTool) + failure episode ──

  it('wrong typed value aborts without callTool and writes confirm-failed episode', async () => {
    const proposal = makeDestructiveProposal(storePath);
    writeStateCursor(statePath, '0');

    const callLog: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const { client, hitlCalls } = makeMockMemoryClient();
    const hooks: ApprovalTestHooks = {
      storePath,
      mcpConfigs: TEST_MCP_CONFIGS,
      connectionFactory: makeMockConnectionFactory(callLog),
    };
    const cfg = makeConfig(statePath);

    // Step 1: approve (registers pending entry)
    const t1 = new MockTelegramTransport([makeV2CallbackUpdate(proposal.id, 'a', 10)]);
    await runClientTick(cfg, t1, client, hooks);

    // Step 2: send WRONG value
    writeStateCursor(statePath, '10');
    const t2 = new MockTelegramTransport([makeTextMessageUpdate('wrong-value', 20)]);
    await runClientTick(cfg, t2, client, hooks);

    // No execution
    expect(callLog).toHaveLength(0);

    // An abort message was sent to the user
    const abortMsg = t2.sent.find(s => s.text.toLowerCase().includes('did not match') || s.text.toLowerCase().includes('abort'));
    expect(abortMsg).toBeDefined();

    // confirm-failed episode written
    expect(hitlCalls.some(h => h.decision === 'confirm-failed')).toBe(true);
  });

  // ── Test 4: Non-pending user message still routes to ask (no regression) ──

  it('normal Q&A message from user with no pending entry reaches ask (no swallow)', async () => {
    // No proposal, no pending entry
    writeStateCursor(statePath, '0');

    const { client, askCalls } = makeMockMemoryClient();
    const hooks: ApprovalTestHooks = { storePath, mcpConfigs: TEST_MCP_CONFIGS };
    const cfg = makeConfig(statePath);

    const t = new MockTelegramTransport([makeTextMessageUpdate('what is my load this week?', 10)]);
    await runClientTick(cfg, t, client, hooks);

    // ask() was called with the user's text (no typed-confirm swallowing, Pitfall #3)
    expect(askCalls).toHaveLength(1);
    expect(askCalls[0]).toBe('what is my load this week?');
  });

  // ── Test 5: Non-destructive approve executes directly (no typed-confirm prompt) ──

  it('non-destructive approve executes immediately without a typed-confirm prompt', async () => {
    const proposal = makeNonDestructiveProposal(storePath);
    writeStateCursor(statePath, '0');

    const callLog: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const { client } = makeMockMemoryClient();
    const hooks: ApprovalTestHooks = {
      storePath,
      mcpConfigs: TEST_MCP_CONFIGS,
      connectionFactory: makeMockConnectionFactory(callLog),
    };
    const cfg = makeConfig(statePath);

    const t = new MockTelegramTransport([makeV2CallbackUpdate(proposal.id, 'a', 10)]);
    await runClientTick(cfg, t, client, hooks);

    // Direct execution — no confirm prompt needed
    expect(callLog).toHaveLength(1);
    expect(callLog[0]?.name).toBe(proposal.tool);
    const promptMsg = t.sent.find(s => s.text.includes('Destructive action'));
    expect(promptMsg).toBeUndefined();
  });

  // ── Test 6: handleProposalAction exports allow direct testing ──

  it('handleProposalAction: destructive approve via direct call registers pending entry', async () => {
    const proposal = makeDestructiveProposal(storePath);

    const callLog: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const { client, hitlCalls } = makeMockMemoryClient();
    const t = new MockTelegramTransport([]);

    await handleProposalAction(
      t, client, TEST_MCP_CONFIGS, storePath,
      CHAT_ID,
      { proposalId: proposal.id, action: 'approve' },
      makeMockConnectionFactory(callLog),
    );

    // No execution
    expect(callLog).toHaveLength(0);
    // Prompt was sent
    expect(t.sent.some(s => s.text.includes('Destructive action'))).toBe(true);
    // confirm-requested episode
    expect(hitlCalls.some(h => h.decision === 'confirm-requested')).toBe(true);
  });
});
