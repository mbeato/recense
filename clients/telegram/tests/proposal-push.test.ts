/**
 * clients/telegram/tests/proposal-push.test.ts
 *
 * Phase 23 Plan 05 — Push-tick proposal generation vs. D-02 fallback unit coverage.
 *
 * No HTTP server needed: memoryClient is a direct mock (not an HTTP shim), and
 * the MCP connection and DeepSeek fetch are both injectable via ProposalTestHooks.
 *
 * Scenarios:
 *   1. Confident proposal path — mocked engine returns {tool,args}:
 *      - transport.sent has exactly one message
 *      - replyMarkup has a 4-button proposal keyboard (Approve/Edit/Reject/Snooze)
 *      - message text is the serialized {tool,args} payload (NOT DeepSeek prose)
 *      - each button callback_data is a v2 encoding (starts with "2|")
 *   2. {tool:null} fallback — mocked engine returns null:
 *      - transport.sent has exactly one message with the 3-button Phase-22 keyboard
 *      - no proposal card (no "Approve" button)
 *   3. Cap exhausted — tryReserveProposalSlot returns false immediately (dailyCap=0):
 *      - plain Phase-22 notify, no DeepSeek call at all
 *   4. Proposal persisted with destructive + expectedConfirmValue:
 *      - store has a StoredProposal with destructive=true and expectedConfirmValue
 *        matching the concrete payload value (the `to` field — D-09 typed confirm)
 *   5. send-then-mark ordering (D-02): surfaceSeen fires AFTER sendMessage in proposal path
 *   6. hitlEpisode audit:
 *      - confident proposal → hitlEpisode called with decision='propose', tool name + serverName
 *      - fallback (null tool) → hitlEpisode called with decision='notify-fallback'
 *   7. P1/tier-1 items are NEVER routed through the proposal path (D-01 plain notify only)
 *
 * No imports from ../../src/ — CLIENT-01 structural guard.
 * All MCP and DeepSeek calls use injectable mocks — zero live network calls.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPushTick, type ProposalTestHooks } from '../index';
import { MockTelegramTransport } from '../transport';
import { getProposal } from '../proposal-store';
import type { MemoryClient, SurfaceItem, HitlEpisodeEntry } from '../memory-client';
import type { ClientConfig, ActionConfig } from '../config';
import type { McpServerConfig } from '../types';
import type { McpConnection, McpConnectionFactory, McpToolDescriptor } from '../mcp-client';
import type { FetchImpl } from '../proposal-engine';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** A minimal email tool with required args: to, subject, body. */
const EMAIL_TOOL: McpToolDescriptor = {
  name: 'send_email',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['to', 'subject', 'body'],
  },
};

/** Confident DeepSeek args that pass validateProposal for EMAIL_TOOL. */
const CONFIDENT_ARGS = { to: 'coach@example.com', subject: 'Flight confirmation', body: 'Please confirm SFO→NYC' };

/** A P0 surface item for the test — due in 30 minutes. */
const P0_ITEM: SurfaceItem = {
  node_id: '550e8400-e29b-41d4-a716-446655440001',
  value: 'Flight booking confirmation',
  due_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  action_type: 'email',
  tier: 0,
  score: 0.92,
};

/** A P1 surface item — digest-only, should never trigger proposal generation. */
const P1_ITEM: SurfaceItem = {
  node_id: '550e8400-e29b-41d4-a716-446655440002',
  value: 'Review sprint backlog',
  due_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  action_type: 'review',
  tier: 1,
  score: 0.6,
};

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

/**
 * Build a mock McpConnectionFactory that scripted-returns EMAIL_TOOL (or an
 * overridden list) without spawning any subprocess or opening any socket.
 */
function makeMockConnectionFactory(tools: McpToolDescriptor[] = [EMAIL_TOOL]): McpConnectionFactory {
  const mockConn: McpConnection = {
    connect: async () => {},
    listTools: async () => ({ tools }),
    callTool: async () => ({ content: [], isError: false }),
    close: async () => {},
  };
  return () => mockConn;
}

/**
 * Build a mock fetchImpl for the DeepSeek chat/completions endpoint.
 * Returns a Response whose `choices[0].message.content` is the JSON-serialized
 * tool+args object or `{"tool":null}`.
 */
function makeDeepSeekFetch(
  toolName: string | null,
  args: Record<string, unknown> = {},
): FetchImpl {
  return async (_url, _init) => {
    const content =
      toolName !== null
        ? JSON.stringify({ tool: toolName, args })
        : JSON.stringify({ tool: null });
    const body = JSON.stringify({
      choices: [{ message: { content } }],
    });
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

/**
 * Build a mock MemoryClient with scripted surface() and search().
 * `hitlRecords` and `seenRecords` capture calls for assertion.
 */
function makeMockMemoryClient(
  surfaceItems: SurfaceItem[],
  hitlRecords?: HitlEpisodeEntry[],
  seenRecords?: Array<{ node_id: string; outcome?: string }>,
): MemoryClient {
  return {
    ask: async () => ({ answer: null, origin: 'none' }),
    search: async () => [{ content: 'coach@example.com is the email for booking' }],
    surface: async () => surfaceItems,
    surfaceSeen: async (params) => {
      if (seenRecords !== undefined) seenRecords.push({ node_id: params.node_id, outcome: params.outcome });
    },
    hitlEpisode: async (entry) => {
      if (hitlRecords !== undefined) hitlRecords.push(entry);
    },
  };
}

/**
 * Build a minimal ClientConfig with proactiveEnabled=true and a single allowlist entry.
 */
function makeClientConfig(overrides: Partial<ClientConfig> = {}): ClientConfig {
  return {
    telegramToken: 'test-token',
    serveUrl: 'http://127.0.0.1:9999',
    serveToken: 'test-serve-token',
    allowlist: ['111'],
    pollIntervalMs: 500,
    statePath: join(tmpdir(), 'test-state.json'),
    enabled: true,
    proactiveEnabled: true,
    pushPollMs: 120_000,
    quietHoursStart: 0,
    quietHoursEnd: 0, // no quiet hours
    digestHour: 99,   // impossible digest hour → digest never fires
    snoozeDurationMs: 86_400_000,
    ...overrides,
  };
}

/**
 * Build an ActionConfig pointing at a temp store path.
 * dailyCap defaults to 10 (sufficient); pass dailyCap=0 to test cap exhaustion.
 */
function makeActionConfig(storePath: string, dailyCap = 10): ActionConfig {
  return {
    deepseekApiKey: 'test-deepseek-key',
    deepseekModel: 'deepseek-chat',
    deepseekBaseUrl: 'https://api.deepseek.com/v1',
    proposalDailyCap: dailyCap,
    proposalMaxTtlMs: 86_400_000,
    proposalStorePath: storePath,
  };
}

/** One MCP server config with a single destructive=true email tool. */
function makeEmailServerConfig(): McpServerConfig {
  return {
    name: 'email-server',
    transport: 'stdio',
    command: '/usr/bin/fake-mcp',
    allowedTools: [{ name: 'send_email', destructive: true }],
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('proposal-push: runPushTick proposal path vs. D-02 fallback', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'proposal-push-test-'));
    storePath = join(tmpDir, 'pending-proposals.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── 1. Confident proposal path ────────────────────────────────────────────

  it('confident proposal: transport.sent has 4-button approval keyboard (not Phase-22 keyboard)', async () => {
    const t = new MockTelegramTransport();
    const mc = makeMockMemoryClient([P0_ITEM]);
    const cfg = makeClientConfig();

    const hooks: ProposalTestHooks = {
      actionConfig: makeActionConfig(storePath),
      mcpConfigs: [makeEmailServerConfig()],
      connectionFactory: makeMockConnectionFactory(),
      fetchImpl: makeDeepSeekFetch('send_email', CONFIDENT_ARGS),
    };

    await runPushTick(cfg, t, mc, hooks);

    expect(t.sent).toHaveLength(1);
    const sent = t.sent[0]!;
    expect(sent.replyMarkup).toBeDefined();
    const row = sent.replyMarkup!.inline_keyboard[0]!;
    expect(row).toHaveLength(4);
    const labels = row.map(b => b.text);
    expect(labels.some(l => l.includes('Approve'))).toBe(true);
    expect(labels.some(l => l.includes('Edit'))).toBe(true);
    expect(labels.some(l => l.includes('Reject'))).toBe(true);
    expect(labels.some(l => l.includes('Snooze'))).toBe(true);
  });

  it('confident proposal: text is the serialized payload (tool name + args) — never DeepSeek prose', async () => {
    const t = new MockTelegramTransport();
    const mc = makeMockMemoryClient([P0_ITEM]);
    const cfg = makeClientConfig();

    const hooks: ProposalTestHooks = {
      actionConfig: makeActionConfig(storePath),
      mcpConfigs: [makeEmailServerConfig()],
      connectionFactory: makeMockConnectionFactory(),
      fetchImpl: makeDeepSeekFetch('send_email', CONFIDENT_ARGS),
    };

    await runPushTick(cfg, t, mc, hooks);

    expect(t.sent).toHaveLength(1);
    const text = t.sent[0]!.text;
    // Data-only: contains the tool name
    expect(text).toContain('send_email');
    // Data-only: contains a serialized arg value
    expect(text).toContain('coach@example.com');
    // Card header
    expect(text).toContain('Proposed Action');
    // Not raw LLM content field — the raw response would not appear as-is in the card
    expect(text).not.toContain('"choices"');
    expect(text).not.toContain('"message"');
  });

  it('confident proposal: each button callback_data uses v2 encoding (starts with "2|")', async () => {
    const t = new MockTelegramTransport();
    const mc = makeMockMemoryClient([P0_ITEM]);
    const cfg = makeClientConfig();

    const hooks: ProposalTestHooks = {
      actionConfig: makeActionConfig(storePath),
      mcpConfigs: [makeEmailServerConfig()],
      connectionFactory: makeMockConnectionFactory(),
      fetchImpl: makeDeepSeekFetch('send_email', CONFIDENT_ARGS),
    };

    await runPushTick(cfg, t, mc, hooks);

    const row = t.sent[0]!.replyMarkup!.inline_keyboard[0]!;
    for (const btn of row) {
      expect(btn.callback_data.startsWith('2|')).toBe(true);
      expect(btn.callback_data.length).toBeLessThanOrEqual(64);
    }
  });

  // ── 2. {tool:null} fallback ───────────────────────────────────────────────

  it('{tool:null}: transport.sent has Phase-22 plain notify (3-button keyboard, no Approve)', async () => {
    const t = new MockTelegramTransport();
    const mc = makeMockMemoryClient([P0_ITEM]);
    const cfg = makeClientConfig();

    const hooks: ProposalTestHooks = {
      actionConfig: makeActionConfig(storePath),
      mcpConfigs: [makeEmailServerConfig()],
      connectionFactory: makeMockConnectionFactory(),
      fetchImpl: makeDeepSeekFetch(null), // {tool: null}
    };

    await runPushTick(cfg, t, mc, hooks);

    expect(t.sent).toHaveLength(1);
    const row = t.sent[0]!.replyMarkup?.inline_keyboard[0] ?? [];
    // Phase-22 keyboard has 3 buttons: Done / Dismiss / Snooze
    expect(row).toHaveLength(3);
    const labels = row.map(b => b.text);
    expect(labels.some(l => l.includes('Approve'))).toBe(false);
    expect(labels.some(l => l.includes('Done'))).toBe(true);
    expect(labels.some(l => l.includes('Snooze'))).toBe(true);
  });

  it('{tool:null}: no proposal card — v1 encoding (starts with "1|") on all buttons', async () => {
    const t = new MockTelegramTransport();
    const mc = makeMockMemoryClient([P0_ITEM]);
    const cfg = makeClientConfig();

    const hooks: ProposalTestHooks = {
      actionConfig: makeActionConfig(storePath),
      mcpConfigs: [makeEmailServerConfig()],
      connectionFactory: makeMockConnectionFactory(),
      fetchImpl: makeDeepSeekFetch(null),
    };

    await runPushTick(cfg, t, mc, hooks);

    const row = t.sent[0]!.replyMarkup!.inline_keyboard[0]!;
    for (const btn of row) {
      // Phase-22 buttons use v1 codec
      expect(btn.callback_data.startsWith('1|')).toBe(true);
    }
  });

  // ── 3. Cap exhausted ─────────────────────────────────────────────────────

  it('cap exhausted: plain Phase-22 notify, no DeepSeek call', async () => {
    const fetchCallCount = { n: 0 };
    const capExhaustedFetch: FetchImpl = async () => {
      fetchCallCount.n++;
      // Should never be called
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const t = new MockTelegramTransport();
    const mc = makeMockMemoryClient([P0_ITEM]);
    const cfg = makeClientConfig();

    const hooks: ProposalTestHooks = {
      actionConfig: makeActionConfig(storePath, 0), // dailyCap=0 → immediately exhausted
      mcpConfigs: [makeEmailServerConfig()],
      connectionFactory: makeMockConnectionFactory(),
      fetchImpl: capExhaustedFetch,
    };

    await runPushTick(cfg, t, mc, hooks);

    // Plain Phase-22 notify sent
    expect(t.sent).toHaveLength(1);
    const row = t.sent[0]!.replyMarkup!.inline_keyboard[0]!;
    expect(row).toHaveLength(3); // Done/Dismiss/Snooze
    // DeepSeek was never called
    expect(fetchCallCount.n).toBe(0);
  });

  // ── 4. Proposal persisted with destructive + expectedConfirmValue ─────────

  it('confident proposal: StoredProposal in store has destructive=true and expectedConfirmValue from args', async () => {
    const t = new MockTelegramTransport();
    const mc = makeMockMemoryClient([P0_ITEM]);
    const cfg = makeClientConfig();
    const actionCfg = makeActionConfig(storePath);

    const hooks: ProposalTestHooks = {
      actionConfig: actionCfg,
      mcpConfigs: [makeEmailServerConfig()],
      connectionFactory: makeMockConnectionFactory(),
      fetchImpl: makeDeepSeekFetch('send_email', CONFIDENT_ARGS),
    };

    await runPushTick(cfg, t, mc, hooks);

    // Extract the proposalId from the first Approve button's v2 callback_data
    const row = t.sent[0]!.replyMarkup!.inline_keyboard[0]!;
    const approveBtn = row.find(b => b.text.includes('Approve'))!;
    // callback_data format: "2|{proposalId}|a"
    const parts = approveBtn.callback_data.split('|');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('2');
    const proposalId = parts[1]!;

    // Read the proposal back from the store
    const stored = getProposal(proposalId, storePath);
    expect(stored).not.toBeNull();
    expect(stored!.tool).toBe('send_email');
    expect(stored!.args).toMatchObject(CONFIDENT_ARGS);
    // AllowlistEntry has destructive: true → proposal is destructive (D-08)
    expect(stored!.destructive).toBe(true);
    // deriveConfirmValue picks the `to` field (highest priority in the sequence: D-09)
    expect(stored!.expectedConfirmValue).toBe('coach@example.com');
    // serverName matches the McpServerConfig name
    expect(stored!.serverName).toBe('email-server');
  });

  // ── 5. send-then-mark ordering in proposal path (D-02) ───────────────────

  it('confident proposal: sendMessage fires BEFORE surfaceSeen (D-02 send-then-mark)', async () => {
    const callOrder: string[] = [];

    class OrderedTransport extends MockTelegramTransport {
      override async sendMessage(
        chatId: number,
        text: string,
        replyMarkup?: import('../transport').InlineKeyboardMarkup,
      ): Promise<void> {
        callOrder.push('sendMessage');
        return super.sendMessage(chatId, text, replyMarkup);
      }
    }

    const mc: MemoryClient = {
      ask: async () => ({ answer: null, origin: 'none' }),
      search: async () => [],
      surface: async () => [P0_ITEM],
      surfaceSeen: async () => { callOrder.push('surfaceSeen'); },
      hitlEpisode: async () => {},
    };

    const t = new OrderedTransport();
    const cfg = makeClientConfig();

    const hooks: ProposalTestHooks = {
      actionConfig: makeActionConfig(storePath),
      mcpConfigs: [makeEmailServerConfig()],
      connectionFactory: makeMockConnectionFactory(),
      fetchImpl: makeDeepSeekFetch('send_email', CONFIDENT_ARGS),
    };

    await runPushTick(cfg, t, mc, hooks);

    // send-then-mark
    expect(callOrder.indexOf('sendMessage')).toBeLessThan(callOrder.indexOf('surfaceSeen'));
  });

  // ── 6. hitlEpisode audit ──────────────────────────────────────────────────

  it('confident proposal: hitlEpisode called with decision=propose, tool, serverName', async () => {
    const hitlRecords: HitlEpisodeEntry[] = [];
    const mc = makeMockMemoryClient([P0_ITEM], hitlRecords);
    const t = new MockTelegramTransport();
    const cfg = makeClientConfig();

    const hooks: ProposalTestHooks = {
      actionConfig: makeActionConfig(storePath),
      mcpConfigs: [makeEmailServerConfig()],
      connectionFactory: makeMockConnectionFactory(),
      fetchImpl: makeDeepSeekFetch('send_email', CONFIDENT_ARGS),
    };

    await runPushTick(cfg, t, mc, hooks);

    expect(hitlRecords.length).toBeGreaterThanOrEqual(1);
    const proposeEntry = hitlRecords.find(e => e.decision === 'propose');
    expect(proposeEntry).toBeDefined();
    expect(proposeEntry!.tool).toBe('send_email');
    expect(proposeEntry!.serverName).toBe('email-server');
  });

  it('{tool:null}: hitlEpisode called with decision=notify-fallback', async () => {
    const hitlRecords: HitlEpisodeEntry[] = [];
    const mc = makeMockMemoryClient([P0_ITEM], hitlRecords);
    const t = new MockTelegramTransport();
    const cfg = makeClientConfig();

    const hooks: ProposalTestHooks = {
      actionConfig: makeActionConfig(storePath),
      mcpConfigs: [makeEmailServerConfig()],
      connectionFactory: makeMockConnectionFactory(),
      fetchImpl: makeDeepSeekFetch(null),
    };

    await runPushTick(cfg, t, mc, hooks);

    const fallbackEntry = hitlRecords.find(e => e.decision === 'notify-fallback');
    expect(fallbackEntry).toBeDefined();
  });

  // ── 7. P1 items never trigger proposal generation (D-01) ──────────────────

  it('P1 tier-1 item at digest hour: plain notify only, no proposal card', async () => {
    const localHour = new Date().getHours();
    const fetchCallCount = { n: 0 };
    const trackingFetch: FetchImpl = async () => {
      fetchCallCount.n++;
      return new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const t = new MockTelegramTransport();
    const mc = makeMockMemoryClient([P1_ITEM]);
    // Set digest hour = current hour so the P1 digest would fire
    const cfg = makeClientConfig({ digestHour: localHour, quietHoursStart: 0, quietHoursEnd: 0 });

    const hooks: ProposalTestHooks = {
      actionConfig: makeActionConfig(storePath),
      mcpConfigs: [makeEmailServerConfig()],
      connectionFactory: makeMockConnectionFactory(),
      fetchImpl: trackingFetch,
    };

    await runPushTick(cfg, t, mc, hooks);

    // P1 message sent (digest fired)
    expect(t.sent).toHaveLength(1);
    // 3-button Phase-22 keyboard (no proposal path for P1)
    const row = t.sent[0]!.replyMarkup!.inline_keyboard[0]!;
    expect(row).toHaveLength(3);
    expect(row.map(b => b.text).some(l => l.includes('Approve'))).toBe(false);
    // DeepSeek was never called for P1
    expect(fetchCallCount.n).toBe(0);
  });
});
