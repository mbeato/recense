/**
 * tests/proposal-routes.test.ts — Plan 66-03 Task 3.
 *
 * Route integration tests for GET /v1/proposals and POST /v1/proposals/:id/approve|reject
 * against the real HTTP server (createBrainHttpServer). Fixtures are seeded directly against
 * the same on-disk DB the server holds, via a second better-sqlite3 connection — WAL mode
 * (set by initSchema) makes those writes visible to the server's own handles.
 *
 * Covers: auth-fires-before-parse (T-12-03), the frozen ACTION_PROPOSAL_FIELDS response
 * contract, the approve/reject happy paths, the EMIT-07 refusal matrix (superseded/
 * entity_gone/expired), malformed/unknown id + unknown action handling, the
 * D-43-for-proposals node-table-unchanged proof, and the no-payload-data-in-responses check.
 *
 * Uses the same fail-if-called ModelProvider shape as tests/online-llm-free-sentinel.test.ts
 * (D-13) so an accidental LLM call on these routes fails loudly here too — the dedicated
 * /v1/proposals extension of that sentinel lands in 66-05.
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
import {
  ActionProposalStore,
  ACTION_PROPOSAL_FIELDS,
  type ActionProposalRecord,
  type ProposalStatus,
} from '../src/db/action-proposal-store';
import { createBrainHttpServer, type BrainHttpServer } from '../src/adapter/serve-cli';
import type { ModelProvider } from '../src/model/provider';

// ---------------------------------------------------------------------------
// Shared fail-if-called provider (mirrors tests/online-llm-free-sentinel.test.ts)
// ---------------------------------------------------------------------------

function makeLlmFreeProvider(): ModelProvider & { readonly embedCount: number } {
  let embedCount = 0;
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      embedCount++;
      return texts.map(() => new Float32Array([0, 1, 0]));
    },
    async generate(): Promise<string> {
      throw new Error('generate must not be called by the /v1/proposals routes');
    },
    async judge(): Promise<never> {
      throw new Error('judge must not be called by the /v1/proposals routes');
    },
    async judgeBatch(): Promise<never> {
      throw new Error('judgeBatch must not be called by the /v1/proposals routes');
    },
    get embedCount() {
      return embedCount;
    },
  };
}

function makeTempDbPath(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

// Sentinel substrings planted into evidence_quote/entity_descriptor/change_to so the
// "no payload data in responses" assertions are proving something real (a distinctive
// string that could only appear if the route leaked it).
const EVIDENCE_SENTINEL = 'SENTINEL-EVIDENCE-QUOTE-XYZ';
const DESCRIPTOR_SENTINEL = 'SENTINEL-ENTITY-DESCRIPTOR-XYZ';
const CHANGE_TO_SENTINEL = 'SENTINEL-CHANGE-TO-XYZ';

interface SimpleResponse {
  statusCode: number;
  body: string;
}

describe('proposal routes: GET /v1/proposals, POST /v1/proposals/:id/approve|reject', () => {
  const TEST_TOKEN = 'b'.repeat(64);

  let serverResult: BrainHttpServer;
  let port: number;
  let tmpDbPath: string;
  let tmpLockPath: string;
  let seedDb: Database.Database;
  let seedCounter = 0;

  function request(
    method: string,
    urlPath: string,
    opts?: { auth?: boolean; body?: string },
  ): Promise<SimpleResponse> {
    return new Promise((resolve, reject) => {
      const headers: http.OutgoingHttpHeaders = {};
      if (opts?.auth !== false) headers['authorization'] = `Bearer ${TEST_TOKEN}`;
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: urlPath,
          method,
          agent: new http.Agent({ keepAlive: false }),
          headers,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      if (opts?.body !== undefined) req.write(opts.body);
      req.end();
    });
  }

  interface SeedOverrides {
    expiresAt?: number;
    entityTombstoned?: boolean;
    beliefTombstoned?: boolean;
    status?: ProposalStatus;
  }

  interface SeedResult {
    proposalId: string;
    entityNodeId: string;
    beliefNodeId: string;
    episodeId: string;
  }

  /** Seeds a fresh entity node, belief node, episode, and action_proposal row. */
  function seedProposal(overrides?: SeedOverrides): SeedResult {
    seedCounter += 1;
    const n = seedCounter;
    const now = Date.now();
    const entityNodeId = hexId(`entity-${n}`);
    const beliefNodeId = hexId(`belief-${n}`);
    const episodeId = hexId(`episode-${n}`);
    const proposalId = hexId(`proposal-${n}`);

    const store = new SemanticStore(seedDb, realClock, config(tmpDbPath));
    store.upsertNode({ id: entityNodeId, type: 'entity', value: `entity ${n}`, origin: 'observed' });
    store.upsertNode({ id: beliefNodeId, type: 'fact', value: `belief ${n}`, origin: 'observed' });
    if (overrides?.entityTombstoned) store.tombstone(entityNodeId);
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
      entity_descriptor: `${DESCRIPTOR_SENTINEL}-${n}`,
      belief_node_id: beliefNodeId,
      change_field: 'status',
      change_from: null,
      change_to: `${CHANGE_TO_SENTINEL}-${n}`,
      evidence_episode: episodeId,
      evidence_quote: `${EVIDENCE_SENTINEL}-${n}`,
      confidence: 'high',
      schema_version: SCHEMA_VERSION,
      status: overrides?.status ?? 'pending',
      created_at: now,
      updated_at: now,
      expires_at: overrides?.expiresAt ?? now + 1_000_000,
    };
    proposalStore.insert(row);

    return { proposalId, entityNodeId, beliefNodeId, episodeId };
  }

  function getProposalStatus(id: string): string {
    const row = seedDb.prepare('SELECT status FROM action_proposal WHERE id = ?').get(id) as
      | { status: string }
      | undefined;
    return row?.status ?? '';
  }

  beforeEach(async () => {
    tmpDbPath = makeTempDbPath('proposal-routes');
    tmpLockPath = path.join(
      os.tmpdir(),
      `proposal-routes-lock-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`,
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
  });

  afterEach(async () => {
    try { seedDb.close(); } catch { /* ignore */ }
    await serverResult.close();
    delete process.env['RECENSE_LOCK_PATH'];
    try { fs.unlinkSync(tmpLockPath); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
  });

  // ── T-66-01: auth fires before parse ──────────────────────────────────────

  it('GET /v1/proposals with no Authorization header returns 401 {"error":"unauthorized"}', async () => {
    const res = await request('GET', '/v1/proposals', { auth: false });
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('{"error":"unauthorized"}');
  });

  it('POST .../approve with no Authorization header returns 401 even with a malformed body attached', async () => {
    const seed = seedProposal();
    const res = await request('POST', `/v1/proposals/${seed.proposalId}/approve`, {
      auth: false,
      body: 'not valid json{{{',
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).toBe('{"error":"unauthorized"}');
  });

  // ── GET /v1/proposals response contract ───────────────────────────────────

  it('GET /v1/proposals returns 200 with pending items matching the ACTION_PROPOSAL_FIELDS key set, excluding non-pending rows', async () => {
    const pending = seedProposal();
    const approved = seedProposal({ status: 'approved' });

    const res = await request('GET', '/v1/proposals');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { items: Array<Record<string, unknown>> };
    const ids = body.items.map((item) => item.id);
    expect(ids).toContain(pending.proposalId);
    expect(ids).not.toContain(approved.proposalId);
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(Object.keys(ACTION_PROPOSAL_FIELDS).sort());
    }
  });

  // ── CR-01: the list filter is the exact complement of the refusal classifier ──
  // Both fixtures below are the SAME ones the EMIT-07 refusal matrix uses further down;
  // pre-fix each was listed to every consumer and then guaranteed to 409 on the tap.

  it('CR-01: GET /v1/proposals excludes a pending proposal whose belief node is tombstoned', async () => {
    const live = seedProposal();
    const superseded = seedProposal({ beliefTombstoned: true });

    const res = await request('GET', '/v1/proposals');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { items: Array<Record<string, unknown>> };
    const ids = body.items.map((item) => item.id);
    expect(ids).toContain(live.proposalId);
    expect(ids).not.toContain(superseded.proposalId);
    // Still pending in the DB — the filter is a read-side complement, not a lazy sweep.
    expect(getProposalStatus(superseded.proposalId)).toBe('pending');
  });

  it('CR-01: GET /v1/proposals excludes a pending proposal whose entity node is tombstoned', async () => {
    const live = seedProposal();
    const entityGone = seedProposal({ entityTombstoned: true });

    const res = await request('GET', '/v1/proposals');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { items: Array<Record<string, unknown>> };
    const ids = body.items.map((item) => item.id);
    expect(ids).toContain(live.proposalId);
    expect(ids).not.toContain(entityGone.proposalId);
    expect(getProposalStatus(entityGone.proposalId)).toBe('pending');
  });

  // ── Approve / reject happy paths ──────────────────────────────────────────

  it('POST .../approve on a pending fresh proposal returns 200 {status:"approved"} and persists it', async () => {
    const seed = seedProposal();
    const res = await request('POST', `/v1/proposals/${seed.proposalId}/approve`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'approved' });
    expect(getProposalStatus(seed.proposalId)).toBe('approved');
  });

  it('a second approve on the same id returns 409 {error:"conflict", detail:"proposal is not pending"}', async () => {
    const seed = seedProposal();
    const first = await request('POST', `/v1/proposals/${seed.proposalId}/approve`);
    expect(first.statusCode).toBe(200);

    const second = await request('POST', `/v1/proposals/${seed.proposalId}/approve`);
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body)).toEqual({ error: 'conflict', detail: 'proposal is not pending' });
    expect(getProposalStatus(seed.proposalId)).toBe('approved');
  });

  it('POST .../reject on a pending proposal returns 200 {status:"rejected"} and persists it', async () => {
    const seed = seedProposal();
    const res = await request('POST', `/v1/proposals/${seed.proposalId}/reject`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'rejected' });
    expect(getProposalStatus(seed.proposalId)).toBe('rejected');
  });

  // ── EMIT-07 refusal matrix ─────────────────────────────────────────────────

  it('approve on a proposal whose belief node is tombstoned returns 409 superseded and writes status=superseded', async () => {
    const seed = seedProposal({ beliefTombstoned: true });
    const res = await request('POST', `/v1/proposals/${seed.proposalId}/approve`);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'conflict', detail: 'proposal superseded' });
    expect(getProposalStatus(seed.proposalId)).toBe('superseded');
  });

  it('approve on a proposal whose entity node is tombstoned returns 409 entity retired and writes status=superseded', async () => {
    const seed = seedProposal({ entityTombstoned: true });
    const res = await request('POST', `/v1/proposals/${seed.proposalId}/approve`);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'conflict', detail: 'proposal entity retired' });
    expect(getProposalStatus(seed.proposalId)).toBe('superseded');
  });

  it('approve on an expired proposal returns 409 expired and writes status=expired', async () => {
    const seed = seedProposal({ expiresAt: Date.now() - 1_000_000 });
    const res = await request('POST', `/v1/proposals/${seed.proposalId}/approve`);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body)).toEqual({ error: 'conflict', detail: 'proposal expired' });
    expect(getProposalStatus(seed.proposalId)).toBe('expired');
  });

  // ── Malformed / unknown id, unknown action ────────────────────────────────

  it('POST /v1/proposals/not-hex/approve returns 400 bad_request', async () => {
    const res = await request('POST', '/v1/proposals/not-hex/approve');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: 'bad_request', detail: 'invalid proposal id' });
  });

  it('POST /v1/proposals/<valid-but-unknown-64hex>/approve returns 404', async () => {
    const unknownId = hexId('an-id-nobody-ever-inserted');
    const res = await request('POST', `/v1/proposals/${unknownId}/approve`);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found', detail: 'proposal does not exist' });
  });

  it('POST /v1/proposals/<64hex>/frobnicate returns 404', async () => {
    const seed = seedProposal();
    const res = await request('POST', `/v1/proposals/${seed.proposalId}/frobnicate`);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
  });

  // ── D-43-for-proposals: node table is provably untouched ─────────────────

  it('leaves the node table byte-identical across one approve and one reject', async () => {
    const toApprove = seedProposal();
    const toReject = seedProposal();

    const before = seedDb.prepare('SELECT * FROM node ORDER BY id').all();

    const approveRes = await request('POST', `/v1/proposals/${toApprove.proposalId}/approve`);
    expect(approveRes.statusCode).toBe(200);
    const rejectRes = await request('POST', `/v1/proposals/${toReject.proposalId}/reject`);
    expect(rejectRes.statusCode).toBe(200);

    const after = seedDb.prepare('SELECT * FROM node ORDER BY id').all();
    expect(after).toEqual(before);
  });

  // ── No payload data ever leaves the engine in a response body ─────────────

  it('no 4xx/5xx response body contains evidence_quote, entity_descriptor, or change_to', async () => {
    const seed = seedProposal();
    const okRes = await request('POST', `/v1/proposals/${seed.proposalId}/approve`);
    expect(okRes.statusCode).toBe(200);

    const conflictRes = await request('POST', `/v1/proposals/${seed.proposalId}/approve`); // 409
    const badIdRes = await request('POST', '/v1/proposals/not-hex/approve'); // 400
    const notFoundRes = await request('POST', `/v1/proposals/${hexId('nobody-inserted-this')}/approve`); // 404
    const unauthRes = await request('GET', '/v1/proposals', { auth: false }); // 401

    for (const res of [conflictRes, badIdRes, notFoundRes, unauthRes]) {
      expect(res.body).not.toContain(EVIDENCE_SENTINEL);
      expect(res.body).not.toContain(DESCRIPTOR_SENTINEL);
      expect(res.body).not.toContain(CHANGE_TO_SENTINEL);
    }
  });
});
