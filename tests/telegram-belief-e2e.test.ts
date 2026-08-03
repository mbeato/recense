/**
 * tests/telegram-belief-e2e.test.ts — Phase 68 Plan 03 Task 3.
 *
 * Repo-level end-to-end proof against a real `createBrainHttpServer`: drives the
 * belief poll pass to bridge one pending server proposal into exactly one
 * Telegram prompt with a transition-labeled button, decodes that button's real
 * callback_data, feeds it to `handleBeliefProposalAction`, and asserts the
 * server-side proposal status becomes 'approved' with the local row terminal.
 * Then forces a second real POST (by resetting the local row back to pending —
 * simulating a resumed/racing client) and asserts the client maps the server's
 * genuine 409 response to a terminal refusal with no state inversion (the
 * server-side status stays 'approved', never flips to anything else).
 *
 * Follows tests/proposal-reference-e2e.test.ts's harness precedent: real
 * createBrainHttpServer, seeded ActionProposalStore, getFreePort, an LLM-free
 * fail-if-called ModelProvider. This file lives outside clients/telegram/ so it
 * may import from src/ — that asymmetry (test -> client is legal, client -> src/
 * is not) is what makes this the one place the boundary can be proven
 * end-to-end (mirrors 67's D-05 rationale).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as http from 'node:http';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { initSchema, SCHEMA_VERSION } from '../src/db/schema';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { realClock } from '../src/lib/clock';
import { SemanticStore } from '../src/db/semantic-store';
import { ActionProposalStore, type ActionProposalRecord } from '../src/db/action-proposal-store';
import { createBrainHttpServer, type BrainHttpServer } from '../src/adapter/serve-cli';
import type { ModelProvider } from '../src/model/provider';
import { createBeliefProposalClient } from '../clients/telegram/belief-proposal-client';
import { runBeliefBridgePass, handleBeliefProposalAction } from '../clients/telegram/belief-bridge';
import { decodeBeliefCallbackData } from '../clients/telegram/push-codec';
import { MockTelegramTransport } from '../clients/telegram/transport';
import { getProposal, putProposal } from '../clients/telegram/proposal-store';
import type { MemoryClient } from '../clients/telegram/memory-client';
import type { StoredBeliefProposal } from '../clients/telegram/types';

// ---------------------------------------------------------------------------
// Shared fail-if-called provider (mirrors tests/proposal-reference-e2e.test.ts)
// ---------------------------------------------------------------------------

function makeLlmFreeProvider(): ModelProvider {
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => new Float32Array([0, 1, 0]));
    },
    async generate(): Promise<string> {
      throw new Error('generate must not be called by the telegram belief e2e');
    },
    async judge(): Promise<never> {
      throw new Error('judge must not be called by the telegram belief e2e');
    },
    async judgeBatch(): Promise<never> {
      throw new Error('judgeBatch must not be called by the telegram belief e2e');
    },
  };
}

function makeNoopMemoryClient(): MemoryClient {
  return {
    async ask() { return { answer: null, origin: 'none' }; },
    async search() { return []; },
    async surface() { return []; },
    async surfaceSeen() {},
    async hitlEpisode() {},
  };
}

function makeTempDbPath(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeTempPath(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as { port: number };
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

function config(dbPath: string) {
  return { ...DEFAULT_CONFIG, dbPath };
}

function hexId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

const noopLog = (_msg: string): void => {};
const CHAT_ID = 424242;

describe('telegram belief e2e: real HTTP surface + belief-bridge/handleBeliefProposalAction (Phase 68 Plan 03)', () => {
  const TEST_TOKEN = 'e'.repeat(64);

  let serverResult: BrainHttpServer;
  let port: number;
  let tmpDbPath: string;
  let tmpLockPath: string;
  let seedDb: Database.Database;
  let storePath: string;
  let statePath: string;

  function seedProposal(): { proposalId: string; entityDescriptor: string } {
    const now = Date.now();
    const entityNodeId = hexId('e2e-entity');
    const beliefNodeId = hexId('e2e-belief');
    const episodeId = hexId('e2e-episode');
    const proposalId = hexId('e2e-proposal');
    const entityDescriptor = 'Acme Corp — Backend Engineer';

    const store = new SemanticStore(seedDb, realClock, config(tmpDbPath));
    store.upsertNode({ id: entityNodeId, type: 'entity', value: 'Acme Corp', origin: 'observed' });
    store.upsertNode({ id: beliefNodeId, type: 'fact', value: 'application status', origin: 'observed' });

    seedDb.prepare(`
      INSERT INTO episode (id, ts, content, origin, salience, role, session_id, source)
      VALUES (@id, @ts, @content, 'observed', 0.5, 'user', 'seed-session', 'seed')
    `).run({ id: episodeId, ts: now, content: 'we would like to schedule an interview' });

    const proposalStore = new ActionProposalStore(seedDb, realClock);
    const row: ActionProposalRecord = {
      id: proposalId,
      kind: 'belief',
      entity_node_id: entityNodeId,
      entity_descriptor: entityDescriptor,
      belief_node_id: beliefNodeId,
      change_field: 'status',
      change_from: 'applied',
      change_to: 'interviewing',
      evidence_episode: episodeId,
      evidence_quote: 'we would like to schedule an interview',
      confidence: 'high',
      schema_version: SCHEMA_VERSION,
      status: 'pending',
      created_at: now,
      updated_at: now,
      expires_at: now + 1_000_000,
    };
    proposalStore.insert(row);

    return { proposalId, entityDescriptor };
  }

  function getProposalStatus(id: string): string {
    const row = seedDb.prepare('SELECT status FROM action_proposal WHERE id = ?').get(id) as
      | { status: string }
      | undefined;
    return row?.status ?? '';
  }

  beforeEach(async () => {
    tmpDbPath = makeTempDbPath('telegram-belief-e2e');
    tmpLockPath = path.join(
      os.tmpdir(),
      `telegram-belief-e2e-lock-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`,
    );
    process.env['RECENSE_LOCK_PATH'] = tmpLockPath;

    const setupDb = new Database(tmpDbPath);
    initSchema(setupDb);
    setupDb.close();

    port = await getFreePort();
    const provider = makeLlmFreeProvider();
    serverResult = await createBrainHttpServer({ dbPath: tmpDbPath, token: TEST_TOKEN, provider });
    serverResult.server.listen(port, '127.0.0.1');
    await new Promise<void>((resolve) => {
      if (serverResult.server.listening) { resolve(); return; }
      serverResult.server.once('listening', resolve);
    });

    seedDb = new Database(tmpDbPath);
    storePath = makeTempPath('telegram-belief-e2e-store');
    statePath = makeTempPath('telegram-belief-e2e-state');
  });

  afterEach(async () => {
    try { seedDb.close(); } catch { /* ignore */ }
    await serverResult.close();
    delete process.env['RECENSE_LOCK_PATH'];
    try { fs.unlinkSync(tmpLockPath); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(storePath); } catch { /* ignore */ }
    try { fs.unlinkSync(statePath); } catch { /* ignore */ }
  });

  it('bridges one pending server proposal into one transition-labeled prompt, applies approve through the frozen contract, and maps a genuine second-POST 409 to a terminal refusal with no state inversion', async () => {
    const seed = seedProposal();
    const client = createBeliefProposalClient(`http://127.0.0.1:${String(port)}`, TEST_TOKEN);
    const transport = new MockTelegramTransport();
    const memoryClient = makeNoopMemoryClient();

    // ── 1. Bridge: list -> batch -> store-first -> send exactly one prompt ──
    await runBeliefBridgePass({
      client, transport, chatIds: [CHAT_ID], storePath, statePath,
      dailyCap: 10, log: noopLog, nowMs: Date.now(),
    });

    expect(transport.sent).toHaveLength(1);
    const sent = transport.sent[0];
    expect(sent?.text).toContain(seed.entityDescriptor);
    const buttons = sent?.replyMarkup?.inline_keyboard.flat() ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    // The approve button's label carries the transition itself (D-05 — never a bare "Approve").
    const approveButton = buttons.find(b => b.callback_data.startsWith('3|') && b.text.includes('interviewing'));
    expect(approveButton).toBeDefined();

    // ── 2. Decode the REAL callback_data and drive the decision handler ────
    const decoded = decodeBeliefCallbackData(approveButton?.callback_data ?? '');
    expect(decoded).not.toBeNull();
    expect(decoded?.action).toBe('approve');

    await handleBeliefProposalAction(
      transport, memoryClient, client, storePath, statePath, CHAT_ID,
      decoded as { localId: string; action: 'approve' | 'edit' | 'reject' | 'snooze' },
      Date.now(),
    );

    // Server-side: the real approve endpoint fired.
    expect(getProposalStatus(seed.proposalId)).toBe('approved');

    // Local: the row is terminal.
    const localId = decoded?.localId ?? '';
    const localRow = getProposal(localId, storePath);
    expect(localRow && 'localStatus' in localRow ? localRow.localStatus : undefined).toBe('terminal');

    // ── 3. Force a genuine second POST: reset the local row back to pending  ──
    // (simulating a resumed/racing client whose local state has not yet caught
    // up) so the second tap actually reaches the server instead of being
    // short-circuited by the local already-terminal guard.
    const rowBeforeReset = getProposal(localId, storePath) as StoredBeliefProposal;
    putProposal({ ...rowBeforeReset, localStatus: 'pending' }, storePath);

    await handleBeliefProposalAction(
      transport, memoryClient, client, storePath, statePath, CHAT_ID,
      decoded as { localId: string; action: 'approve' | 'edit' | 'reject' | 'snooze' },
      Date.now(),
    );

    // No state inversion: the server-side status is still 'approved', never
    // flipped to anything else by the second (409-refused) approve attempt.
    expect(getProposalStatus(seed.proposalId)).toBe('approved');

    // The refusal was mapped to terminal, never left dangling as pending.
    const localRowAfterSecondTap = getProposal(localId, storePath);
    expect(localRowAfterSecondTap && 'localStatus' in localRowAfterSecondTap ? localRowAfterSecondTap.localStatus : undefined).toBe('terminal');

    // The reply on the second tap is the genuine refusal message (proves the
    // real HTTP 409 round-trip was mapped, not the "already recorded"
    // short-circuit, which is a different code path).
    const lastReply = transport.sent[transport.sent.length - 1];
    expect(lastReply?.text.toLowerCase()).toContain('nothing was applied');
  });
});
