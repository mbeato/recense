/**
 * tests/proposal-reference-e2e.test.ts — Phase 67 Plan 03 Task 1.
 *
 * D-05: this repo-level test is the ONLY place both halves of the Phase 66/67
 * contract can be observed at once. The adapter's own in-dir tests are
 * forbidden from importing the engine (CONSUME-02) — so the end-to-end proof
 * lives here instead. This file imports engine modules to seed a real
 * `action_proposal` row and stand up the real `createBrainHttpServer` surface,
 * AND imports the adapter's public entry (`syncProposals`) from
 * `clients/proposal-reference/index` to exercise it exactly as a real
 * consumer would. The main assertions never call `client.approve`/`.reject`
 * directly and never reimplement the outcome loop — if they did, this file
 * would stop proving CONSUME-01. That asymmetry (test -> client is legal,
 * client -> src/ is not) is what makes this the one place the boundary can be
 * proven end-to-end. Cross-references: 67-CONTEXT.md D-03, D-05.
 *
 * Covers every <behavior> case from the plan: the happy path (two pending
 * high-confidence belief proposals approved through the adapter), the D-03
 * refusal round-trip (a proposal whose belief has moved -> 409 conflict ->
 * terminal local row -> no retry), D-02 replay safety, the reject path, the
 * D-01 auth gate, and the LLM-free online-path invariant (the whole e2e runs
 * against a fail-if-called ModelProvider).
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
import { createProposalClient } from '../clients/proposal-reference/proposal-client';
import { syncProposals } from '../clients/proposal-reference/index';
import { listLocalRows, findByProposalId } from '../clients/proposal-reference/local-store';

// ---------------------------------------------------------------------------
// Shared fail-if-called provider (mirrors tests/proposal-routes.test.ts) —
// proves the whole e2e, including every adapter-driven call, stays LLM-free.
// ---------------------------------------------------------------------------

function makeLlmFreeProvider(): ModelProvider & { readonly embedCount: number } {
  let embedCount = 0;
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      embedCount++;
      return texts.map(() => new Float32Array([0, 1, 0]));
    },
    async generate(): Promise<string> {
      throw new Error('generate must not be called by the reference adapter e2e');
    },
    async judge(): Promise<never> {
      throw new Error('judge must not be called by the reference adapter e2e');
    },
    async judgeBatch(): Promise<never> {
      throw new Error('judgeBatch must not be called by the reference adapter e2e');
    },
    get embedCount() {
      return embedCount;
    },
  };
}

function makeTempDbPath(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeTempStorePath(prefix: string): string {
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

describe('proposal-reference adapter e2e: real HTTP surface + adapter public entry (D-05)', () => {
  const TEST_TOKEN = 'c'.repeat(64);

  let serverResult: BrainHttpServer;
  let port: number;
  let tmpDbPath: string;
  let tmpLockPath: string;
  let seedDb: Database.Database;
  let seedCounter = 0;
  let tmpStorePaths: string[];

  interface SeedOverrides {
    confidence?: 'high' | 'medium' | 'low';
    beliefTombstoned?: boolean;
  }

  interface SeedResult {
    proposalId: string;
    entityNodeId: string;
    beliefNodeId: string;
    entityDescriptor: string;
  }

  /** Seeds a fresh entity node, belief node, episode, and pending action_proposal row. */
  function seedProposal(overrides?: SeedOverrides): SeedResult {
    seedCounter += 1;
    const n = seedCounter;
    const now = Date.now();
    const entityNodeId = hexId(`e2e-entity-${n}`);
    const beliefNodeId = hexId(`e2e-belief-${n}`);
    const episodeId = hexId(`e2e-episode-${n}`);
    const proposalId = hexId(`e2e-proposal-${n}`);
    const entityDescriptor = `e2e-descriptor-${n}`;

    const store = new SemanticStore(seedDb, realClock, config(tmpDbPath));
    store.upsertNode({ id: entityNodeId, type: 'entity', value: `entity ${n}`, origin: 'observed' });
    store.upsertNode({ id: beliefNodeId, type: 'fact', value: `belief ${n}`, origin: 'observed' });
    if (overrides?.beliefTombstoned) store.tombstone(beliefNodeId);

    seedDb.prepare(`
      INSERT INTO episode (id, ts, content, origin, salience, role, session_id, source)
      VALUES (@id, @ts, @content, 'observed', 0.5, 'user', 'seed-session', 'seed')
    `).run({ id: episodeId, ts: now, content: `episode content ${n}` });

    const proposalStore = new ActionProposalStore(seedDb, realClock);
    const row: ActionProposalRecord = {
      id: proposalId,
      kind: 'belief',
      entity_node_id: entityNodeId,
      entity_descriptor: entityDescriptor,
      belief_node_id: beliefNodeId,
      change_field: 'status',
      change_from: null,
      change_to: `e2e-status-token-${n}`,
      evidence_episode: episodeId,
      evidence_quote: `e2e quote ${n}`,
      confidence: overrides?.confidence ?? 'high',
      schema_version: SCHEMA_VERSION,
      status: 'pending',
      created_at: now,
      updated_at: now,
      expires_at: now + 1_000_000,
    };
    proposalStore.insert(row);

    return { proposalId, entityNodeId, beliefNodeId, entityDescriptor };
  }

  function getProposalStatus(id: string): string {
    const row = seedDb.prepare('SELECT status FROM action_proposal WHERE id = ?').get(id) as
      | { status: string }
      | undefined;
    return row?.status ?? '';
  }

  function newStorePath(): string {
    const p = makeTempStorePath('proposal-reference-e2e-store');
    tmpStorePaths.push(p);
    return p;
  }

  beforeEach(async () => {
    tmpDbPath = makeTempDbPath('proposal-reference-e2e');
    tmpLockPath = path.join(
      os.tmpdir(),
      `proposal-reference-e2e-lock-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`,
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
    tmpStorePaths = [];
  });

  afterEach(async () => {
    try { seedDb.close(); } catch { /* ignore */ }
    await serverResult.close();
    delete process.env['RECENSE_LOCK_PATH'];
    try { fs.unlinkSync(tmpLockPath); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
    for (const p of tmpStorePaths) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  });

  // ── Happy path (CONSUME-01) ───────────────────────────────────────────────

  it('happy path: two pending high-confidence belief proposals are approved through the adapter\'s own syncProposals, and the two schemas never meet', async () => {
    const seedA = seedProposal();
    const seedB = seedProposal();
    const storePath = newStorePath();
    const client = createProposalClient(`http://127.0.0.1:${port}`, TEST_TOKEN);

    const report = await syncProposals(client, storePath, noopLog);

    expect(report.applied).toBe(2);
    expect(getProposalStatus(seedA.proposalId)).toBe('approved');
    expect(getProposalStatus(seedB.proposalId)).toBe('approved');

    const localRows = listLocalRows(storePath);
    expect(localRows).toHaveLength(2);
    const rowA = findByProposalId(seedA.proposalId, storePath);
    const rowB = findByProposalId(seedB.proposalId, storePath);
    expect(rowA?.localStatus).toBe('applied');
    expect(rowB?.localStatus).toBe('applied');
    expect(rowA?.entityDescriptor).toBe(seedA.entityDescriptor);
    expect(rowB?.entityDescriptor).toBe(seedB.entityDescriptor);
  });

  // ── Refusal round-trip (D-03) ──────────────────────────────────────────────

  it('refusal round-trip: approving a proposal whose belief has moved returns 409 conflict, marks the local row refused/terminal, and issues no further approve on a second sync', async () => {
    const seed = seedProposal({ beliefTombstoned: true });
    const storePath = newStorePath();
    const client = createProposalClient(`http://127.0.0.1:${port}`, TEST_TOKEN);

    const report = await syncProposals(client, storePath, noopLog);

    expect(report.refused).toBe(1);
    const row = findByProposalId(seed.proposalId, storePath);
    expect(row?.localStatus).toBe('refused');
    expect(row?.refusalReason).toBe('conflict');

    // Deviation from the plan's literal wording (documented in 67-03-SUMMARY.md,
    // Rule 1): the engine durably settles a stale-belief refusal to
    // status='superseded' at approve time (D-10, src/db/action-proposal-store.ts
    // ProposalStaleError doc comment; also asserted by the sibling
    // tests/proposal-routes.test.ts EMIT-07 matrix) — it does NOT leave the row
    // 'pending'. This is a stronger proof of "terminal, never retried": the
    // proposal is durably settled and therefore no longer listed at all.
    expect(getProposalStatus(seed.proposalId)).toBe('superseded');

    // A second sync sees the proposal is no longer pending (durably settled),
    // so it is never re-listed and therefore never re-approved — the terminal
    // refusal is never retried.
    const secondReport = await syncProposals(client, storePath, noopLog);
    expect(secondReport.listed).toBe(0);
    expect(secondReport.applied).toBe(0);
    expect(secondReport.refused).toBe(0);
    const rowAfterSecondSync = findByProposalId(seed.proposalId, storePath);
    expect(rowAfterSecondSync).toEqual(row);
  });

  // ── Replay safety (D-02) ───────────────────────────────────────────────────

  it('replay safety: running syncProposals twice on the happy-path fixture leaves exactly one local row per proposal id', async () => {
    const seed = seedProposal();
    const storePath = newStorePath();
    const client = createProposalClient(`http://127.0.0.1:${port}`, TEST_TOKEN);

    const firstReport = await syncProposals(client, storePath, noopLog);
    expect(firstReport.applied).toBe(1);

    const secondReport = await syncProposals(client, storePath, noopLog);
    expect(secondReport.applied).toBe(0);

    const rows = listLocalRows(storePath).filter(r => r.proposalId === seed.proposalId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.localStatus).toBe('applied');
  });

  // ── Reject path ────────────────────────────────────────────────────────────

  it('reject path: a low-confidence proposal drives POST .../reject, the DB row is rejected, and the local row is applied', async () => {
    const seed = seedProposal({ confidence: 'low' });
    const storePath = newStorePath();
    const client = createProposalClient(`http://127.0.0.1:${port}`, TEST_TOKEN);

    const report = await syncProposals(client, storePath, noopLog);

    expect(report.applied).toBe(1);
    expect(getProposalStatus(seed.proposalId)).toBe('rejected');
    const row = findByProposalId(seed.proposalId, storePath);
    expect(row?.localStatus).toBe('applied');
  });

  // ── Auth (D-01) ────────────────────────────────────────────────────────────

  it('auth: constructing the adapter client with a wrong token and running syncProposals throws, and no action_proposal row leaves pending status unapplied', async () => {
    const seed = seedProposal();
    const storePath = newStorePath();
    const wrongToken = 'd'.repeat(64);
    const wrongClient = createProposalClient(`http://127.0.0.1:${port}`, wrongToken);

    await expect(syncProposals(wrongClient, storePath, noopLog)).rejects.toThrow();

    // Nothing was approved/rejected — the seeded proposal is exactly where it started.
    expect(getProposalStatus(seed.proposalId)).toBe('pending');
    expect(listLocalRows(storePath)).toHaveLength(0);
  });

  // ── LLM-free (engine invariant) ────────────────────────────────────────────

  it('LLM-free: the whole e2e runs against a fail-if-called ModelProvider whose generate/judge/judgeBatch throw if invoked', async () => {
    // The beforeEach hook already wired createBrainHttpServer with
    // makeLlmFreeProvider(). This test simply exercises the full outcome loop
    // once more and relies on the fact that any accidental generate/judge/
    // judgeBatch call anywhere in the request path would throw synchronously
    // and fail this test with that thrown error, proving the online path
    // (including every route the adapter drives) never invokes the LLM.
    const seed = seedProposal();
    const storePath = newStorePath();
    const client = createProposalClient(`http://127.0.0.1:${port}`, TEST_TOKEN);

    const report = await syncProposals(client, storePath, noopLog);

    expect(report.applied).toBe(1);
    expect(getProposalStatus(seed.proposalId)).toBe('approved');
  });
});
