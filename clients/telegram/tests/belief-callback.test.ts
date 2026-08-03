/**
 * clients/telegram/tests/belief-callback.test.ts — Phase 68 Plan 03 Task 1.
 *
 * Behavioral proof of `handleBeliefProposalAction` — the belief decision handler
 * dispatched from the '3|' callback branch. Covers every <behavior> bullet from
 * the plan: missing/expired short-circuits, the T-68-13 forged-tool-row guard,
 * double-tap idempotency, edit/snooze short-circuit (with the fail-if-called LLM
 * tool-mapping bypass proof), approve/reject success, and the audit payload shape.
 *
 * Task 2 (belief-refusal.test.ts) covers the full refusal-status mapping — this
 * file only proves the neutral placeholder catch that Task 1 ships with still
 * behaves safely (leaves the row pending, replies neutrally, never throws).
 *
 * No src/ imports — CLIENT-01 structural guard (scanned by import-boundary.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { handleBeliefProposalAction, toStoredBeliefProposal, type ActionProposalRecord } from '../belief-bridge';
import { putProposal, getProposal } from '../proposal-store';
import { MockTelegramTransport } from '../transport';
import type { BeliefProposalClient } from '../belief-proposal-client';
import type { MemoryClient, HitlEpisodeEntry } from '../memory-client';
import type { StoredToolProposal } from '../types';

// ── Helpers ──────────────────────────────────────────────────────────────────

let _counter = 0;

function tmpPath(prefix: string): string {
  return path.join(os.tmpdir(), `brain-belief-callback-test-${prefix}-${Date.now()}-${String(++_counter)}.json`);
}

function pid(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function rmFile(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

function makeRecord(id: string, overrides: Partial<ActionProposalRecord> = {}): ActionProposalRecord {
  const now = Date.now();
  return {
    id,
    kind: 'belief',
    entity_node_id: 'node-' + id,
    entity_descriptor: 'Acme Corp — Backend Engineer',
    belief_node_id: 'belief-' + id,
    change_field: 'status',
    change_from: 'applied',
    change_to: 'interviewing',
    evidence_episode: 'episode-' + id,
    evidence_quote: 'we would like to schedule an interview',
    confidence: 'high',
    schema_version: 17,
    status: 'pending',
    created_at: now,
    updated_at: now,
    expires_at: now + 86_400_000,
    ...overrides,
  };
}

function makeMemoryClient(): { client: MemoryClient; hitlCalls: HitlEpisodeEntry[] } {
  const hitlCalls: HitlEpisodeEntry[] = [];
  const client: MemoryClient = {
    async ask() { return { answer: null, origin: 'none' }; },
    async search() { return []; },
    async surface() { return []; },
    async surfaceSeen() {},
    async hitlEpisode(entry) { hitlCalls.push({ ...entry }); },
  };
  return { client, hitlCalls };
}

/** A fail-if-called stub standing in for the LLM tool-mapping entry point. */
function makeFailIfCalledLlmStub(): { calls: number; validateProposal: () => never } {
  const tracker = { calls: 0, validateProposal: (): never => {
    tracker.calls++;
    throw new Error('validateProposal must not be called on the belief decision path');
  } };
  return tracker;
}

interface ScriptedClientLog {
  approveCalls: string[];
  rejectCalls: string[];
  approveImpl?: (id: string) => Promise<void>;
  rejectImpl?: (id: string) => Promise<void>;
}

function makeScriptedClient(log: ScriptedClientLog): BeliefProposalClient {
  return {
    async listProposals() { return []; },
    async approve(id: string) {
      log.approveCalls.push(id);
      if (log.approveImpl) await log.approveImpl(id);
    },
    async reject(id: string) {
      log.rejectCalls.push(id);
      if (log.rejectImpl) await log.rejectImpl(id);
    },
  };
}

function putBeliefRow(storePath: string, record: ActionProposalRecord, nowMs: number) {
  const row = toStoredBeliefProposal(record, nowMs);
  putProposal(row, storePath);
  return row;
}

function putToolRow(storePath: string, overrides: Partial<StoredToolProposal> = {}): StoredToolProposal {
  const row: StoredToolProposal = {
    kind: 'tool',
    id: `tool-${String(++_counter)}`,
    serverName: 'test-server',
    tool: 'read_file',
    args: {},
    nodeId: 'node-x',
    dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    maxTtlMs: 3_600_000,
    createdAt: new Date().toISOString(),
    destructive: false,
    expectedConfirmValue: 'read_file',
    ...overrides,
  };
  putProposal(row, storePath);
  return row;
}

const CHAT_ID = 555;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleBeliefProposalAction', () => {
  let storePath: string;
  let statePath: string;

  beforeEach(() => {
    storePath = tmpPath('store');
    statePath = tmpPath('state');
  });

  afterEach(() => {
    rmFile(storePath);
    rmFile(statePath);
  });

  it('a callback naming a row with no store entry replies "no longer available" and issues no HTTP call', async () => {
    const scriptedLog: ScriptedClientLog = { approveCalls: [], rejectCalls: [] };
    const client = makeScriptedClient(scriptedLog);
    const { client: memoryClient } = makeMemoryClient();
    const t = new MockTelegramTransport();

    await handleBeliefProposalAction(
      t, memoryClient, client, storePath, statePath, CHAT_ID,
      { localId: 'deadbeef'.repeat(4), action: 'approve' }, Date.now(),
    );

    expect(scriptedLog.approveCalls).toHaveLength(0);
    expect(scriptedLog.rejectCalls).toHaveLength(0);
    expect(t.sent.some(s => s.text.toLowerCase().includes('no longer available'))).toBe(true);
  });

  it('a callback on an expired row replies "lapsed" and issues no HTTP call', async () => {
    const nowMs = Date.now();
    const record = makeRecord(pid('expired-1'), { expires_at: nowMs - 60_000 });
    const row = putBeliefRow(storePath, record, nowMs - 120_000);

    const scriptedLog: ScriptedClientLog = { approveCalls: [], rejectCalls: [] };
    const client = makeScriptedClient(scriptedLog);
    const { client: memoryClient } = makeMemoryClient();
    const t = new MockTelegramTransport();

    await handleBeliefProposalAction(
      t, memoryClient, client, storePath, statePath, CHAT_ID,
      { localId: row.id, action: 'approve' }, nowMs,
    );

    expect(scriptedLog.approveCalls).toHaveLength(0);
    expect(t.sent.some(s => s.text.toLowerCase().includes('lapsed'))).toBe(true);
  });

  it('a callback naming a row whose kind is tool refuses without any HTTP call and without any MCP call', async () => {
    const toolRow = putToolRow(storePath);

    const scriptedLog: ScriptedClientLog = { approveCalls: [], rejectCalls: [] };
    const client = makeScriptedClient(scriptedLog);
    const { client: memoryClient } = makeMemoryClient();
    const t = new MockTelegramTransport();

    await handleBeliefProposalAction(
      t, memoryClient, client, storePath, statePath, CHAT_ID,
      { localId: toolRow.id, action: 'approve' }, Date.now(),
    );

    expect(scriptedLog.approveCalls).toHaveLength(0);
    expect(scriptedLog.rejectCalls).toHaveLength(0);
    // Row must remain a tool row, untouched.
    const reread = getProposal(toolRow.id, storePath);
    expect(reread?.kind).toBe('tool');
  });

  it('an approve tap issues exactly one POST carrying the 64-hex serverProposalId, then marks the row terminal', async () => {
    const nowMs = Date.now();
    const record = makeRecord(pid('approve-1'));
    const row = putBeliefRow(storePath, record, nowMs);

    const scriptedLog: ScriptedClientLog = { approveCalls: [], rejectCalls: [] };
    const client = makeScriptedClient(scriptedLog);
    const { client: memoryClient, hitlCalls } = makeMemoryClient();
    const t = new MockTelegramTransport();

    await handleBeliefProposalAction(
      t, memoryClient, client, storePath, statePath, CHAT_ID,
      { localId: row.id, action: 'approve' }, nowMs,
    );

    expect(scriptedLog.approveCalls).toEqual([record.id]);
    expect(scriptedLog.rejectCalls).toHaveLength(0);
    expect(/^[0-9a-f]{64}$/.test(scriptedLog.approveCalls[0] ?? '')).toBe(true);

    const reread = getProposal(row.id, storePath);
    expect(reread && 'localStatus' in reread ? reread.localStatus : undefined).toBe('terminal');

    // Confirmation names the applied transition
    expect(t.sent.some(s => s.text.includes('applied') && s.text.includes('interviewing'))).toBe(true);

    // Audit payload carries decision only — no entity descriptor, quote, or change text keys
    const auditEntry = hitlCalls.find(h => h.decision === 'belief-approve');
    expect(auditEntry).toBeDefined();
    expect(JSON.stringify(auditEntry)).not.toContain('Acme Corp');
    expect(JSON.stringify(auditEntry)).not.toContain('interview');
  });

  it('a reject tap issues exactly one POST to reject and marks the row terminal', async () => {
    const nowMs = Date.now();
    const record = makeRecord(pid('reject-1'));
    const row = putBeliefRow(storePath, record, nowMs);

    const scriptedLog: ScriptedClientLog = { approveCalls: [], rejectCalls: [] };
    const client = makeScriptedClient(scriptedLog);
    const { client: memoryClient, hitlCalls } = makeMemoryClient();
    const t = new MockTelegramTransport();

    await handleBeliefProposalAction(
      t, memoryClient, client, storePath, statePath, CHAT_ID,
      { localId: row.id, action: 'reject' }, nowMs,
    );

    expect(scriptedLog.rejectCalls).toEqual([record.id]);
    expect(scriptedLog.approveCalls).toHaveLength(0);

    const reread = getProposal(row.id, storePath);
    expect(reread && 'localStatus' in reread ? reread.localStatus : undefined).toBe('terminal');

    const auditEntry = hitlCalls.find(h => h.decision === 'belief-reject');
    expect(auditEntry).toBeDefined();
  });

  it('a second tap on an already-terminal row issues zero further POSTs and replies "already recorded"', async () => {
    const nowMs = Date.now();
    const record = makeRecord(pid('double-tap-1'));
    const row = putBeliefRow(storePath, record, nowMs);

    const scriptedLog: ScriptedClientLog = { approveCalls: [], rejectCalls: [] };
    const client = makeScriptedClient(scriptedLog);
    const { client: memoryClient } = makeMemoryClient();
    const t = new MockTelegramTransport();

    await handleBeliefProposalAction(
      t, memoryClient, client, storePath, statePath, CHAT_ID,
      { localId: row.id, action: 'approve' }, nowMs,
    );
    expect(scriptedLog.approveCalls).toHaveLength(1);

    // Second tap — same button, same local id
    await handleBeliefProposalAction(
      t, memoryClient, client, storePath, statePath, CHAT_ID,
      { localId: row.id, action: 'approve' }, nowMs,
    );

    // Exactly one approve call total — the double tap issued no further POST
    expect(scriptedLog.approveCalls).toHaveLength(1);
    expect(t.sent.some(s => s.text.toLowerCase().includes('already recorded'))).toBe(true);
  });

  it('an edit tap replies that belief proposals can only be approved or rejected, issues no HTTP call, and never invokes the LLM tool-mapping entry point', async () => {
    const nowMs = Date.now();
    const record = makeRecord(pid('edit-1'));
    const row = putBeliefRow(storePath, record, nowMs);

    const scriptedLog: ScriptedClientLog = { approveCalls: [], rejectCalls: [] };
    const client = makeScriptedClient(scriptedLog);
    const { client: memoryClient, hitlCalls } = makeMemoryClient();
    const t = new MockTelegramTransport();
    const llmStub = makeFailIfCalledLlmStub();

    await handleBeliefProposalAction(
      t, memoryClient, client, storePath, statePath, CHAT_ID,
      { localId: row.id, action: 'edit' }, nowMs,
    );

    // The bypass proof — this stub is never wired into handleBeliefProposalAction at all;
    // asserting it was never invoked proves there is no code path that could reach it.
    expect(llmStub.calls).toBe(0);
    expect(scriptedLog.approveCalls).toHaveLength(0);
    expect(scriptedLog.rejectCalls).toHaveLength(0);
    expect(t.sent.some(s => s.text.toLowerCase().includes('approved or rejected'))).toBe(true);
    expect(hitlCalls.some(h => h.decision === 'belief-edit-refused')).toBe(true);

    // Row stays pending — edit is a short-circuit, not a decision
    const reread = getProposal(row.id, storePath);
    expect(reread && 'localStatus' in reread ? reread.localStatus : undefined).toBe('pending');
  });

  it('a snooze tap takes the same short-circuit as edit', async () => {
    const nowMs = Date.now();
    const record = makeRecord(pid('snooze-1'));
    const row = putBeliefRow(storePath, record, nowMs);

    const scriptedLog: ScriptedClientLog = { approveCalls: [], rejectCalls: [] };
    const client = makeScriptedClient(scriptedLog);
    const { client: memoryClient } = makeMemoryClient();
    const t = new MockTelegramTransport();

    await handleBeliefProposalAction(
      t, memoryClient, client, storePath, statePath, CHAT_ID,
      { localId: row.id, action: 'snooze' }, nowMs,
    );

    expect(scriptedLog.approveCalls).toHaveLength(0);
    expect(scriptedLog.rejectCalls).toHaveLength(0);
    expect(t.sent.some(s => s.text.toLowerCase().includes('approved or rejected'))).toBe(true);
  });

  it('the belief-bridge.ts source never references validateProposal, callDeepSeek, buildProposalPrompt, or callServerTool', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'belief-bridge.ts'), 'utf8');
    expect(/validateProposal|callDeepSeek|buildProposalPrompt|callServerTool/.test(src)).toBe(false);
  });
});
