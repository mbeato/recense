/**
 * clients/telegram/tests/approval-handler.test.ts
 *
 * Integration tests for the v2 proposal callback handler (handleProposalAction +
 * the full approval pipeline through runClientTick):
 *
 *   - Approve of an expired proposal → no callTool, an `expired` episode, user notified,
 *       answerCallbackQuery fired.
 *   - Approve where the tool was removed from the allowlist post-propose → refused (H-04),
 *       no callTool.
 *   - Reject → audited (reject episode), no callTool, answerCallbackQuery fired.
 *   - Snooze → audited (snooze episode), no callTool, answerCallbackQuery fired.
 *   - Execute success → callTool fires once, hitl:execute episode (isError=false),
 *       answerCallbackQuery fired.
 *   - Execute with result.isError=true → isError episode written, answerCallbackQuery fired.
 *   - Execute throws (transport error) → isError episode written, answerCallbackQuery fired.
 *
 * Extends the MockTelegramTransport + proposal-store pattern established in
 * callback-query.test.ts and typed-confirm.test.ts.
 *
 * No imports from ../../src/ — CLIENT-01 structural guard.
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
import type { MemoryClient, HitlEpisodeEntry, SurfaceSeenParams } from '../memory-client';
import type { McpConnectionFactory, McpToolResult } from '../mcp-client';
import type { McpServerConfig, StoredProposal } from '../types';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ALLOWED_ID = '333';
const CHAT_ID = 333;
let _counter = 0;

function uniqueStorePath(): string {
  return path.join(os.tmpdir(), `ah-store-${Date.now()}-${++_counter}.json`);
}

function uniqueStatePath(): string {
  return path.join(os.tmpdir(), `ah-state-${Date.now()}-${++_counter}.json`);
}

function rmFile(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

function makeConfig(statePath: string): ClientConfig {
  return {
    telegramToken: 'test-token',
    serveUrl: 'http://127.0.0.1:9997',
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

/** Base proposal factory — builds a valid non-expired non-destructive proposal. */
function makeProposal(
  storePath: string,
  overrides: Partial<StoredProposal> = {},
): StoredProposal {
  const proposal: StoredProposal = {
    id: `prop-${++_counter}`,
    serverName: 'test-server',
    tool: 'read_file',
    args: { path: '/tmp/notes.txt' },
    nodeId: 'test-node-abc',
    dueAt: new Date(Date.now() + 3_600_000).toISOString(), // 1h from now
    maxTtlMs: 3_600_000,
    createdAt: new Date().toISOString(),
    destructive: false,
    expectedConfirmValue: 'read_file',
    ...overrides,
  };
  putProposal(proposal, storePath);
  return proposal;
}

/** MCP configs that allowlist the 'read_file' tool only (not 'delete_file'). */
const TEST_MCP_CONFIGS_SAFE: McpServerConfig[] = [{
  name: 'test-server',
  transport: 'stdio',
  command: '/bin/echo',
  allowedTools: [
    { name: 'read_file', destructive: false },
  ],
}];

/** MCP configs with an EMPTY allowlist — simulates post-propose allowlist revocation. */
const TEST_MCP_CONFIGS_EMPTY: McpServerConfig[] = [{
  name: 'test-server',
  transport: 'stdio',
  command: '/bin/echo',
  allowedTools: [],
}];

interface MockCallLog {
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  resultOverride?: Partial<McpToolResult>;
  shouldThrow?: string;
}

function makeMockConnectionFactory(log: MockCallLog): McpConnectionFactory {
  return () => ({
    async connect() {},
    async listTools() { return { tools: [] }; },
    async callTool(params) {
      if (log.shouldThrow) throw new Error(log.shouldThrow);
      log.calls.push({ name: params.name, arguments: params.arguments });
      const result: McpToolResult = {
        content: [{ type: 'text', text: 'file contents here' }],
        isError: false,
        ...(log.resultOverride ?? {}),
      };
      return result;
    },
    async close() {},
  });
}

function makeMockMemoryClient(): {
  client: MemoryClient;
  hitlCalls: HitlEpisodeEntry[];
  sentMessages: Array<{ chatId: number; text: string }>;
  surfaceSeenCalls: SurfaceSeenParams[];
} {
  const hitlCalls: HitlEpisodeEntry[] = [];
  const sentMessages: Array<{ chatId: number; text: string }> = [];
  const surfaceSeenCalls: SurfaceSeenParams[] = [];

  const client: MemoryClient = {
    async ask() { return { answer: null, origin: 'none' }; },
    async search() { return []; },
    async surface() { return []; },
    async surfaceSeen(params) { surfaceSeenCalls.push({ ...params }); },
    async hitlEpisode(entry) { hitlCalls.push({ ...entry }); },
  };

  return { client, hitlCalls, sentMessages, surfaceSeenCalls };
}

function makeV2Update(proposalId: string, action: 'a' | 'r' | 's' | 'e', updateId = 10): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: CHAT_ID },
      data: encodeProposalCallbackData(proposalId, action),
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('approval-handler integration tests', () => {
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

  // ── 1. Expired proposal ──

  it('approve of expired proposal → no callTool, expired episode, user notified, ack fired', async () => {
    const proposal = makeProposal(storePath, {
      // Set dueAt and TTL in the PAST so loadExecutable returns 'expired'
      dueAt: new Date(Date.now() - 1_000).toISOString(),
      maxTtlMs: 1, // effectively zero
      createdAt: new Date(Date.now() - 10_000).toISOString(),
    });
    writeStateCursor(statePath, '0');

    const callLog: MockCallLog = { calls: [] };
    const { client, hitlCalls } = makeMockMemoryClient();
    const t = new MockTelegramTransport([makeV2Update(proposal.id, 'a')]);
    const cfg = makeConfig(statePath);
    const hooks: ApprovalTestHooks = {
      storePath,
      mcpConfigs: TEST_MCP_CONFIGS_SAFE,
      connectionFactory: makeMockConnectionFactory(callLog),
    };

    await runClientTick(cfg, t, client, hooks);

    // No callTool
    expect(callLog.calls).toHaveLength(0);

    // User notified about expiry
    expect(t.sent.some(s => s.text.toLowerCase().includes('expired'))).toBe(true);

    // Expired episode written
    expect(hitlCalls.some(h => h.decision === 'expired')).toBe(true);

    // answerCallbackQuery fired (Pitfall #1)
    expect(t.answeredCallbacks).toHaveLength(1);
  });

  // ── 2. Post-propose allowlist revocation ──

  it('approve where tool removed from allowlist → refused (H-04), no callTool', async () => {
    const proposal = makeProposal(storePath); // valid non-expired proposal
    writeStateCursor(statePath, '0');

    const callLog: MockCallLog = { calls: [] };
    const { client, hitlCalls } = makeMockMemoryClient();
    const t = new MockTelegramTransport([makeV2Update(proposal.id, 'a')]);
    const cfg = makeConfig(statePath);

    // Pass EMPTY allowlist — simulates post-propose revocation
    const hooks: ApprovalTestHooks = {
      storePath,
      mcpConfigs: TEST_MCP_CONFIGS_EMPTY,
      connectionFactory: makeMockConnectionFactory(callLog),
    };

    await runClientTick(cfg, t, client, hooks);

    // No execution
    expect(callLog.calls).toHaveLength(0);

    // User notified about allowlist revocation
    expect(t.sent.some(s => s.text.includes('allowlist'))).toBe(true);

    // allowlist-revoked episode
    expect(hitlCalls.some(h => h.decision === 'allowlist-revoked')).toBe(true);

    // answerCallbackQuery fired
    expect(t.answeredCallbacks).toHaveLength(1);
  });

  // ── 3. Reject ──

  it('reject → reject episode, no callTool, answerCallbackQuery fired', async () => {
    const proposal = makeProposal(storePath);
    writeStateCursor(statePath, '0');

    const callLog: MockCallLog = { calls: [] };
    const { client, hitlCalls } = makeMockMemoryClient();
    const t = new MockTelegramTransport([makeV2Update(proposal.id, 'r')]);
    const cfg = makeConfig(statePath);
    const hooks: ApprovalTestHooks = {
      storePath,
      mcpConfigs: TEST_MCP_CONFIGS_SAFE,
      connectionFactory: makeMockConnectionFactory(callLog),
    };

    await runClientTick(cfg, t, client, hooks);

    expect(callLog.calls).toHaveLength(0);
    expect(hitlCalls.some(h => h.decision === 'reject')).toBe(true);
    expect(t.answeredCallbacks).toHaveLength(1);
  });

  // ── 4. Snooze ──

  it('snooze → snooze episode, no callTool, answerCallbackQuery fired', async () => {
    const proposal = makeProposal(storePath);
    writeStateCursor(statePath, '0');

    const callLog: MockCallLog = { calls: [] };
    const { client, hitlCalls } = makeMockMemoryClient();
    const t = new MockTelegramTransport([makeV2Update(proposal.id, 's')]);
    const cfg = makeConfig(statePath);
    const hooks: ApprovalTestHooks = {
      storePath,
      mcpConfigs: TEST_MCP_CONFIGS_SAFE,
      connectionFactory: makeMockConnectionFactory(callLog),
    };

    await runClientTick(cfg, t, client, hooks);

    expect(callLog.calls).toHaveLength(0);
    expect(hitlCalls.some(h => h.decision === 'snooze')).toBe(true);
    expect(t.answeredCallbacks).toHaveLength(1);
  });

  // ── 5. Execute success ──

  it('execute success → callTool fires once, execute episode (isError=false), ack fired', async () => {
    const proposal = makeProposal(storePath);
    writeStateCursor(statePath, '0');

    const callLog: MockCallLog = { calls: [] };
    const { client, hitlCalls } = makeMockMemoryClient();
    const t = new MockTelegramTransport([makeV2Update(proposal.id, 'a')]);
    const cfg = makeConfig(statePath);
    const hooks: ApprovalTestHooks = {
      storePath,
      mcpConfigs: TEST_MCP_CONFIGS_SAFE,
      connectionFactory: makeMockConnectionFactory(callLog),
    };

    await runClientTick(cfg, t, client, hooks);

    // callTool fired with the IMMUTABLE stored args (H-06 — no re-query)
    expect(callLog.calls).toHaveLength(1);
    expect(callLog.calls[0]?.name).toBe(proposal.tool);
    expect(callLog.calls[0]?.arguments).toEqual(proposal.args);

    // execute episode with isError=false
    const execEpisode = hitlCalls.find(h => h.decision === 'execute');
    expect(execEpisode).toBeDefined();
    expect(execEpisode?.isError).toBe(false);
    expect(execEpisode?.tool).toBe(proposal.tool);
    expect(execEpisode?.serverName).toBe(proposal.serverName);

    // answerCallbackQuery fired
    expect(t.answeredCallbacks).toHaveLength(1);
  });

  // ── 6. Execute with result.isError=true ──

  it('execute with result.isError=true → failure episode written, ack fired', async () => {
    const proposal = makeProposal(storePath);
    writeStateCursor(statePath, '0');

    const callLog: MockCallLog = {
      calls: [],
      resultOverride: {
        content: [{ type: 'text', text: 'permission denied' }],
        isError: true,
      },
    };
    const { client, hitlCalls } = makeMockMemoryClient();
    const t = new MockTelegramTransport([makeV2Update(proposal.id, 'a')]);
    const cfg = makeConfig(statePath);
    const hooks: ApprovalTestHooks = {
      storePath,
      mcpConfigs: TEST_MCP_CONFIGS_SAFE,
      connectionFactory: makeMockConnectionFactory(callLog),
    };

    await runClientTick(cfg, t, client, hooks);

    // callTool was still invoked (the error came from the tool, not the transport)
    expect(callLog.calls).toHaveLength(1);

    // execute episode with isError=true (Pitfall #2)
    const execEpisode = hitlCalls.find(h => h.decision === 'execute');
    expect(execEpisode).toBeDefined();
    expect(execEpisode?.isError).toBe(true);

    // User sees a failure summary
    expect(t.sent.some(s => s.text.toLowerCase().includes('failed'))).toBe(true);

    // answerCallbackQuery fired
    expect(t.answeredCallbacks).toHaveLength(1);
  });

  // ── 7. Execute throws (transport error) ──

  it('execute throws transport error → isError failure episode written, ack fired', async () => {
    const proposal = makeProposal(storePath);
    writeStateCursor(statePath, '0');

    const callLog: MockCallLog = {
      calls: [],
      shouldThrow: 'MCP server connection refused',
    };
    const { client, hitlCalls } = makeMockMemoryClient();
    const t = new MockTelegramTransport([makeV2Update(proposal.id, 'a')]);
    const cfg = makeConfig(statePath);
    const hooks: ApprovalTestHooks = {
      storePath,
      mcpConfigs: TEST_MCP_CONFIGS_SAFE,
      connectionFactory: makeMockConnectionFactory(callLog),
    };

    await runClientTick(cfg, t, client, hooks);

    // execute failure episode (Pitfall #2: transport throw also records isError=true)
    const execEpisode = hitlCalls.find(h => h.decision === 'execute');
    expect(execEpisode).toBeDefined();
    expect(execEpisode?.isError).toBe(true);

    // User sees a failure summary
    expect(t.sent.some(s => s.text.toLowerCase().includes('failed'))).toBe(true);

    // answerCallbackQuery always fired (Pitfall #1)
    expect(t.answeredCallbacks).toHaveLength(1);
  });

  // ── 8. answerCallbackQuery fires on every branch (Pitfall #1 invariant) ──

  it('answerCallbackQuery fires on every handled callback branch', async () => {
    const storePath2 = uniqueStorePath();
    const statePath2 = uniqueStatePath();

    try {
      const scenarios: Array<{ label: string; action: 'a' | 'r' | 's'; mcpConfigs: McpServerConfig[] }> = [
        { label: 'reject', action: 'r', mcpConfigs: TEST_MCP_CONFIGS_SAFE },
        { label: 'snooze', action: 's', mcpConfigs: TEST_MCP_CONFIGS_SAFE },
        { label: 'approve-success', action: 'a', mcpConfigs: TEST_MCP_CONFIGS_SAFE },
      ];

      for (const scenario of scenarios) {
        const proposal = makeProposal(storePath2);
        writeStateCursor(statePath2, '0');

        const callLog: MockCallLog = { calls: [] };
        const { client } = makeMockMemoryClient();
        const t = new MockTelegramTransport([makeV2Update(proposal.id, scenario.action)]);
        const cfg = makeConfig(statePath2);
        const hooks: ApprovalTestHooks = {
          storePath: storePath2,
          mcpConfigs: scenario.mcpConfigs,
          connectionFactory: makeMockConnectionFactory(callLog),
        };

        await runClientTick(cfg, t, client, hooks);

        expect(t.answeredCallbacks.length).toBeGreaterThanOrEqual(1);
        rmFile(statePath2);
      }
    } finally {
      rmFile(storePath2);
      rmFile(statePath2);
    }
  });

  // ── 9. handleProposalAction: direct call for expiry and allowlist scenarios ──

  it('direct handleProposalAction call: expired → no callTool, expired episode', async () => {
    const proposal = makeProposal(storePath, {
      dueAt: new Date(Date.now() - 1_000).toISOString(),
      maxTtlMs: 1,
      createdAt: new Date(Date.now() - 10_000).toISOString(),
    });

    const callLog: MockCallLog = { calls: [] };
    const { client, hitlCalls } = makeMockMemoryClient();
    const t = new MockTelegramTransport([]);

    await handleProposalAction(
      t, client, TEST_MCP_CONFIGS_SAFE, storePath,
      CHAT_ID,
      { proposalId: proposal.id, action: 'approve' },
      makeMockConnectionFactory(callLog),
    );

    expect(callLog.calls).toHaveLength(0);
    expect(hitlCalls.some(h => h.decision === 'expired')).toBe(true);
    expect(t.sent.some(s => s.text.includes('expired'))).toBe(true);
  });

  it('direct handleProposalAction call: allowlist revocation → no callTool (H-04)', async () => {
    const proposal = makeProposal(storePath); // valid, non-expired

    const callLog: MockCallLog = { calls: [] };
    const { client, hitlCalls } = makeMockMemoryClient();
    const t = new MockTelegramTransport([]);

    // Pass empty allowlist — simulates allowlist revocation after propose
    await handleProposalAction(
      t, client, TEST_MCP_CONFIGS_EMPTY, storePath,
      CHAT_ID,
      { proposalId: proposal.id, action: 'approve' },
      makeMockConnectionFactory(callLog),
    );

    expect(callLog.calls).toHaveLength(0);
    expect(hitlCalls.some(h => h.decision === 'allowlist-revoked')).toBe(true);
  });

  // ── GAP-02 (23-10): terminal surfaceSeen on execute and reject ─────────────

  // 10. Successful execute records surfaceSeen with outcome:'completed' (GAP-02)
  it('successful execute records surfaceSeen({outcome:"completed"}) with nodeId + dueAt', async () => {
    const proposal = makeProposal(storePath, { nodeId: 'test-surface-node-1' });
    writeStateCursor(statePath, '0');

    const callLog: MockCallLog = { calls: [] }; // default: isError=false
    const { client, surfaceSeenCalls } = makeMockMemoryClient();
    const t = new MockTelegramTransport([makeV2Update(proposal.id, 'a')]);
    const cfg = makeConfig(statePath);
    const hooks: ApprovalTestHooks = {
      storePath,
      mcpConfigs: TEST_MCP_CONFIGS_SAFE,
      connectionFactory: makeMockConnectionFactory(callLog),
    };

    await runClientTick(cfg, t, client, hooks);

    // Exactly one surfaceSeen call with outcome:'completed'
    const completedCalls = surfaceSeenCalls.filter(c => c.outcome === 'completed');
    expect(completedCalls).toHaveLength(1);
    expect(completedCalls[0]?.node_id).toBe('test-surface-node-1');
    expect(completedCalls[0]?.occurrence_due_at).toBe(proposal.dueAt);
  });

  // 11. Reject records surfaceSeen with outcome:'dismissed' (GAP-02)
  it('reject records surfaceSeen({outcome:"dismissed"}) with nodeId + dueAt', async () => {
    const proposal = makeProposal(storePath, { nodeId: 'test-surface-node-2' });
    writeStateCursor(statePath, '0');

    const callLog: MockCallLog = { calls: [] };
    const { client, surfaceSeenCalls } = makeMockMemoryClient();
    const t = new MockTelegramTransport([makeV2Update(proposal.id, 'r')]);
    const cfg = makeConfig(statePath);
    const hooks: ApprovalTestHooks = {
      storePath,
      mcpConfigs: TEST_MCP_CONFIGS_SAFE,
      connectionFactory: makeMockConnectionFactory(callLog),
    };

    await runClientTick(cfg, t, client, hooks);

    // Exactly one surfaceSeen call with outcome:'dismissed'
    const dismissedCalls = surfaceSeenCalls.filter(c => c.outcome === 'dismissed');
    expect(dismissedCalls).toHaveLength(1);
    expect(dismissedCalls[0]?.node_id).toBe('test-surface-node-2');
    expect(dismissedCalls[0]?.occurrence_due_at).toBe(proposal.dueAt);
    // No callTool was made
    expect(callLog.calls).toHaveLength(0);
  });

  // 12. Failed execute (isError=true) does NOT record surfaceSeen('completed') (GAP-02)
  it('failed execute (isError=true) does NOT record surfaceSeen({outcome:"completed"})', async () => {
    const proposal = makeProposal(storePath, { nodeId: 'test-surface-node-3' });
    writeStateCursor(statePath, '0');

    const callLog: MockCallLog = {
      calls: [],
      resultOverride: {
        content: [{ type: 'text', text: 'permission denied' }],
        isError: true,
      },
    };
    const { client, surfaceSeenCalls } = makeMockMemoryClient();
    const t = new MockTelegramTransport([makeV2Update(proposal.id, 'a')]);
    const cfg = makeConfig(statePath);
    const hooks: ApprovalTestHooks = {
      storePath,
      mcpConfigs: TEST_MCP_CONFIGS_SAFE,
      connectionFactory: makeMockConnectionFactory(callLog),
    };

    await runClientTick(cfg, t, client, hooks);

    // No 'completed' surfaceSeen — failed execute is a non-terminal retry path
    const completedCalls = surfaceSeenCalls.filter(c => c.outcome === 'completed');
    expect(completedCalls).toHaveLength(0);
  });

  // 13. Reject when proposal already gone (getProposal returns null) — no throw, no surfaceSeen (GAP-02)
  it('reject for missing proposal (not in store) does not throw and records no surfaceSeen', async () => {
    // Do NOT put any proposal in the store — simulate already-gone proposal
    const nonExistentId = 'prop-does-not-exist-9999';
    writeStateCursor(statePath, '0');

    const callLog: MockCallLog = { calls: [] };
    const { client, surfaceSeenCalls, hitlCalls } = makeMockMemoryClient();
    const t = new MockTelegramTransport([makeV2Update(nonExistentId, 'r')]);
    const cfg = makeConfig(statePath);
    const hooks: ApprovalTestHooks = {
      storePath,
      mcpConfigs: TEST_MCP_CONFIGS_SAFE,
      connectionFactory: makeMockConnectionFactory(callLog),
    };

    // Must not throw
    await expect(runClientTick(cfg, t, client, hooks)).resolves.toBeUndefined();

    // No surfaceSeen at all (getProposal returned null → skip surfaceSeen)
    expect(surfaceSeenCalls).toHaveLength(0);
    // hitlEpisode(reject) still written
    expect(hitlCalls.some(h => h.decision === 'reject')).toBe(true);
  });
});
