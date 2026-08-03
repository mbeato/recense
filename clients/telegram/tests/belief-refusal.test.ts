/**
 * clients/telegram/tests/belief-refusal.test.ts — Phase 68 Plan 03 Task 2.
 *
 * Behavioral proof of handleBeliefProposalAction's full refusal-status mapping
 * (503 defers, 400/404 terminal-refused, 409 needs_reconciliation (WR-03),
 * 401 neutral-pending) and the approval-rate self-report counters (D-09).
 * Covers every <behavior> bullet.
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
import { readBeliefStats, writeBeliefStats } from '../state';
import { MockTelegramTransport } from '../transport';
import { ProposalHttpError, type BeliefProposalClient } from '../belief-proposal-client';
import type { MemoryClient } from '../memory-client';
import type { StoredBeliefProposal } from '../types';

// ── Helpers ──────────────────────────────────────────────────────────────────

let _counter = 0;

function tmpPath(prefix: string): string {
  return path.join(os.tmpdir(), `brain-belief-refusal-test-${prefix}-${Date.now()}-${String(++_counter)}.json`);
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

function makeMemoryClient(): MemoryClient {
  return {
    async ask() { return { answer: null, origin: 'none' }; },
    async search() { return []; },
    async surface() { return []; },
    async surfaceSeen() {},
    async hitlEpisode() {},
  };
}

function putBeliefRow(storePath: string, record: ActionProposalRecord, nowMs: number): StoredBeliefProposal {
  const row = toStoredBeliefProposal(record, nowMs);
  putProposal(row, storePath);
  return row;
}

const TEST_TOKEN = 'super-secret-serve-token-do-not-leak';
const TEST_DETAIL = 'proposal superseded by a later belief update';

interface ScriptedOpts {
  approveThrows?: () => never;
  rejectThrows?: () => never;
}

function makeScriptedClient(opts: ScriptedOpts): { client: BeliefProposalClient; approveCalls: string[]; rejectCalls: string[] } {
  const approveCalls: string[] = [];
  const rejectCalls: string[] = [];
  const client: BeliefProposalClient = {
    async listProposals() { return []; },
    async approve(id: string) {
      approveCalls.push(id);
      if (opts.approveThrows) opts.approveThrows();
    },
    async reject(id: string) {
      rejectCalls.push(id);
      if (opts.rejectThrows) opts.rejectThrows();
    },
  };
  return { client, approveCalls, rejectCalls };
}

const CHAT_ID = 777;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleBeliefProposalAction — refusal-status mapping (D-04)', () => {
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

  it('(WR-03) a 409 response parks the row needs_reconciliation, replies neutrally about the outcome, and does NOT increment refused', async () => {
    const nowMs = Date.now();
    const row = putBeliefRow(storePath, makeRecord(pid('409-1')), nowMs);
    const { client } = makeScriptedClient({
      approveThrows: () => { throw new ProposalHttpError(409); },
    });
    const t = new MockTelegramTransport();

    await handleBeliefProposalAction(t, makeMemoryClient(), client, storePath, statePath, CHAT_ID, { localId: row.id, action: 'approve' }, nowMs);

    const reread = getProposal(row.id, storePath);
    expect(reread && 'localStatus' in reread ? reread.localStatus : undefined).toBe('needs_reconciliation');
    // A 409 may be this client's OWN crash-lost earlier approve — "nothing was
    // applied" would be false in that case, so the reply must stay neutral.
    expect(t.sent.some(s => s.text.toLowerCase().includes('moved on the server'))).toBe(true);
    expect(t.sent.some(s => s.text.toLowerCase().includes('nothing was applied'))).toBe(false);
    expect(readBeliefStats(statePath).refused).toBe(0);
  });

  it('a 404 response marks the row terminal with the same class of reply', async () => {
    const nowMs = Date.now();
    const row = putBeliefRow(storePath, makeRecord(pid('404-1')), nowMs);
    const { client } = makeScriptedClient({
      approveThrows: () => { throw new ProposalHttpError(404); },
    });
    const t = new MockTelegramTransport();

    await handleBeliefProposalAction(t, makeMemoryClient(), client, storePath, statePath, CHAT_ID, { localId: row.id, action: 'approve' }, nowMs);

    const reread = getProposal(row.id, storePath);
    expect(reread && 'localStatus' in reread ? reread.localStatus : undefined).toBe('terminal');
    expect(t.sent.some(s => s.text.toLowerCase().includes('nothing was applied'))).toBe(true);
    expect(readBeliefStats(statePath).refused).toBe(1);
  });

  it('a 400 response marks the row terminal', async () => {
    const nowMs = Date.now();
    const row = putBeliefRow(storePath, makeRecord(pid('400-1')), nowMs);
    const { client } = makeScriptedClient({
      approveThrows: () => { throw new ProposalHttpError(400); },
    });
    const t = new MockTelegramTransport();

    await handleBeliefProposalAction(t, makeMemoryClient(), client, storePath, statePath, CHAT_ID, { localId: row.id, action: 'approve' }, nowMs);

    const reread = getProposal(row.id, storePath);
    expect(reread && 'localStatus' in reread ? reread.localStatus : undefined).toBe('terminal');
    expect(readBeliefStats(statePath).refused).toBe(1);
  });

  it('a 503 response leaves the row pending, replies that memory is busy, and increments no counter', async () => {
    const nowMs = Date.now();
    const row = putBeliefRow(storePath, makeRecord(pid('503-1')), nowMs);
    const { client } = makeScriptedClient({
      approveThrows: () => { throw new ProposalHttpError(503); },
    });
    const t = new MockTelegramTransport();

    await handleBeliefProposalAction(t, makeMemoryClient(), client, storePath, statePath, CHAT_ID, { localId: row.id, action: 'approve' }, nowMs);

    const reread = getProposal(row.id, storePath);
    expect(reread && 'localStatus' in reread ? reread.localStatus : undefined).toBe('pending');
    expect(t.sent.some(s => s.text.toLowerCase().includes('busy'))).toBe(true);
    const stats = readBeliefStats(statePath);
    expect(stats.approved).toBe(0);
    expect(stats.rejected).toBe(0);
    expect(stats.refused).toBe(0);
  });

  it('a 401 response leaves the row pending, and replies neutrally without leaking that a token exists', async () => {
    const nowMs = Date.now();
    const row = putBeliefRow(storePath, makeRecord(pid('401-1')), nowMs);
    const { client } = makeScriptedClient({
      approveThrows: () => { throw new ProposalHttpError(401); },
    });
    const t = new MockTelegramTransport();

    await handleBeliefProposalAction(t, makeMemoryClient(), client, storePath, statePath, CHAT_ID, { localId: row.id, action: 'approve' }, nowMs);

    const reread = getProposal(row.id, storePath);
    expect(reread && 'localStatus' in reread ? reread.localStatus : undefined).toBe('pending');
    const reply = t.sent.map(s => s.text).join('\n');
    expect(reply.toLowerCase()).not.toContain('token');
    expect(reply.toLowerCase()).not.toContain('bearer');
    expect(reply.toLowerCase()).not.toContain('auth');
    expect(readBeliefStats(statePath).refused).toBe(0);
  });

  it('after a 503 the same button can be tapped again and a second POST is issued', async () => {
    const nowMs = Date.now();
    const row = putBeliefRow(storePath, makeRecord(pid('503-retry-1')), nowMs);
    const { client, approveCalls } = makeScriptedClient({
      approveThrows: () => { throw new ProposalHttpError(503); },
    });
    const t = new MockTelegramTransport();

    await handleBeliefProposalAction(t, makeMemoryClient(), client, storePath, statePath, CHAT_ID, { localId: row.id, action: 'approve' }, nowMs);
    await handleBeliefProposalAction(t, makeMemoryClient(), client, storePath, statePath, CHAT_ID, { localId: row.id, action: 'approve' }, nowMs);

    expect(approveCalls).toHaveLength(2);
  });

  it('after a 409 the same button issues no further POST', async () => {
    const nowMs = Date.now();
    const row = putBeliefRow(storePath, makeRecord(pid('409-retry-1')), nowMs);
    const { client, approveCalls } = makeScriptedClient({
      approveThrows: () => { throw new ProposalHttpError(409); },
    });
    const t = new MockTelegramTransport();

    await handleBeliefProposalAction(t, makeMemoryClient(), client, storePath, statePath, CHAT_ID, { localId: row.id, action: 'approve' }, nowMs);
    await handleBeliefProposalAction(t, makeMemoryClient(), client, storePath, statePath, CHAT_ID, { localId: row.id, action: 'approve' }, nowMs);

    expect(approveCalls).toHaveLength(1);
  });

  it('a successful approve increments approved; a successful reject increments rejected', async () => {
    const nowMs = Date.now();
    const rowA = putBeliefRow(storePath, makeRecord(pid('success-approve-1')), nowMs);
    const rowB = putBeliefRow(storePath, makeRecord(pid('success-reject-1')), nowMs);
    const { client } = makeScriptedClient({});
    const t = new MockTelegramTransport();

    await handleBeliefProposalAction(t, makeMemoryClient(), client, storePath, statePath, CHAT_ID, { localId: rowA.id, action: 'approve' }, nowMs);
    await handleBeliefProposalAction(t, makeMemoryClient(), client, storePath, statePath, CHAT_ID, { localId: rowB.id, action: 'reject' }, nowMs);

    const stats = readBeliefStats(statePath);
    expect(stats.approved).toBe(1);
    expect(stats.rejected).toBe(1);
  });

  it('counters survive a simulated process restart (fresh read from the state file)', async () => {
    const nowMs = Date.now();
    const row = putBeliefRow(storePath, makeRecord(pid('restart-1')), nowMs);
    const { client } = makeScriptedClient({});
    const t = new MockTelegramTransport();

    await handleBeliefProposalAction(t, makeMemoryClient(), client, storePath, statePath, CHAT_ID, { localId: row.id, action: 'approve' }, nowMs);

    // Fresh read — simulates the process restarting and re-reading from disk.
    const stats = readBeliefStats(statePath);
    expect(stats.approved).toBe(1);
  });

  it('the self-report line is absent on the 9th decision and present on the 10th', async () => {
    const nowMs = Date.now();
    // Pre-seed 8 prior approved decisions directly via writeBeliefStats.
    writeBeliefStats(statePath, { approved: 8, rejected: 0, refused: 0 });

    const row9 = putBeliefRow(storePath, makeRecord(pid('selfreport-9')), nowMs);
    const { client } = makeScriptedClient({});
    const t9 = new MockTelegramTransport();
    await handleBeliefProposalAction(t9, makeMemoryClient(), client, storePath, statePath, CHAT_ID, { localId: row9.id, action: 'approve' }, nowMs);
    expect(readBeliefStats(statePath).approved).toBe(9);
    expect(t9.sent.some(s => s.text.toLowerCase().includes('approved') && /\d+\s*approved/i.test(s.text))).toBe(false);

    const row10 = putBeliefRow(storePath, makeRecord(pid('selfreport-10')), nowMs);
    const t10 = new MockTelegramTransport();
    await handleBeliefProposalAction(t10, makeMemoryClient(), client, storePath, statePath, CHAT_ID, { localId: row10.id, action: 'approve' }, nowMs);
    expect(readBeliefStats(statePath).approved).toBe(10);
    expect(t10.sent.some(s => /10/.test(s.text))).toBe(true);
  });

  it('the self-report line contains approved, rejected and refused counts and no numeric confidence value', async () => {
    const nowMs = Date.now();
    writeBeliefStats(statePath, { approved: 6, rejected: 2, refused: 1 });
    const row = putBeliefRow(storePath, makeRecord(pid('selfreport-content')), nowMs);
    const { client } = makeScriptedClient({});
    const t = new MockTelegramTransport();

    await handleBeliefProposalAction(t, makeMemoryClient(), client, storePath, statePath, CHAT_ID, { localId: row.id, action: 'approve' }, nowMs);

    const reportMsg = t.sent.find(s => /7/.test(s.text) && /2/.test(s.text) && /1/.test(s.text));
    expect(reportMsg).toBeDefined();
    expect(reportMsg?.text.toLowerCase()).not.toContain('confidence');
    // No bare numeric-only fragment resembling a raw confidence float (e.g. "0.87").
    expect(/0\.\d+/.test(reportMsg?.text ?? '')).toBe(false);
  });

  it('no reply message contains the serve token or the raw serve error detail string', async () => {
    const nowMs = Date.now();
    process.env['RECENSE_SERVE_TOKEN'] = TEST_TOKEN;
    const statuses = [400, 401, 404, 409, 503];
    const t = new MockTelegramTransport();
    for (const status of statuses) {
      const row = putBeliefRow(storePath, makeRecord(pid('leak-check-' + String(status))), nowMs);
      const { client } = makeScriptedClient({
        approveThrows: () => { throw new ProposalHttpError(status); },
      });
      await handleBeliefProposalAction(t, makeMemoryClient(), client, storePath, statePath, CHAT_ID, { localId: row.id, action: 'approve' }, nowMs);
    }
    delete process.env['RECENSE_SERVE_TOKEN'];

    const allText = t.sent.map(s => s.text).join('\n');
    expect(allText).not.toContain(TEST_TOKEN);
    expect(allText).not.toContain(TEST_DETAIL);
    expect(allText.toLowerCase()).not.toContain('bearer');
  });
});
