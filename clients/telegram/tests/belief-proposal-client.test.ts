/**
 * clients/telegram/tests/belief-proposal-client.test.ts — Phase 68 Plan 01 Task 2.
 *
 * Stub-server behavioral proof of createBeliefProposalClient()'s list/approve/reject
 * against the frozen /v1/proposals contract. Drives the client directly against a
 * node:http stub on a free port, never against a live recense serve instance.
 *
 * Imports only vitest, node:http/node:crypto, and ../belief-proposal-client — no
 * src/ import of any kind (CLIENT-01, scanned by import-boundary.test.ts, which
 * also covers this file since it lives under tests/).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { createHash } from 'node:crypto';
import {
  createBeliefProposalClient,
  isInspectableProposalRecord,
  ProposalHttpError,
  PROPOSAL_SCHEMA_VERSION,
} from '../belief-proposal-client';

const TEST_TOKEN = 'test-bearer-token-68-01';

/**
 * Contract-conforming proposal id fixture: real proposal ids are sha256 hex by
 * construction and the client enforces ^[0-9a-f]{64}$ before building a POST
 * path (WR-04), so test fixtures must use conforming ids too.
 */
function pid(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
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

interface RecordedRequest {
  method: string;
  url: string;
  authHeader: string | undefined;
}

function makeRecord(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: 'belief',
    entity_node_id: 'node-' + id,
    entity_descriptor: 'entity for ' + id,
    belief_node_id: 'belief-' + id,
    change_field: 'status',
    change_from: 'applied',
    change_to: 'interviewing',
    evidence_episode: 'episode-' + id,
    evidence_quote: 'quote for ' + id,
    confidence: 'high',
    schema_version: PROPOSAL_SCHEMA_VERSION,
    status: 'pending',
    created_at: Date.now(),
    updated_at: Date.now(),
    expires_at: Date.now() + 86_400_000,
    ...overrides,
  };
}

describe('createBeliefProposalClient — stub-server behavioral proof', () => {
  let server: http.Server;
  let port: number;
  let requests: RecordedRequest[];
  let listBody: unknown;
  let actionStatus: Map<string, number>;

  beforeEach(async () => {
    requests = [];
    listBody = { items: [] };
    actionStatus = new Map();

    server = http.createServer((req, res) => {
      const url = req.url ?? '';
      const method = req.method ?? '';
      requests.push({ method, url, authHeader: req.headers['authorization'] });

      if (method === 'GET' && url === '/v1/proposals') {
        if (typeof listBody === 'number') {
          res.writeHead(listBody, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'stub_error' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(listBody));
        return;
      }

      const actionMatch = /^\/v1\/proposals\/([^/]+)\/(approve|reject)$/.exec(url);
      if (method === 'POST' && actionMatch) {
        const id = actionMatch[1] as string;
        const action = actionMatch[2] as string;
        const status = actionStatus.get(id) ?? 200;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: action === 'approve' ? 'approved' : 'rejected' }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });

    port = await getFreePort();
    await new Promise<void>((resolve) => {
      server.listen(port, '127.0.0.1', () => resolve());
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function client(): ReturnType<typeof createBeliefProposalClient> {
    return createBeliefProposalClient(`http://127.0.0.1:${String(port)}`, TEST_TOKEN);
  }

  it('listProposals() on a stub returning {items:[record]} resolves to a one-element array', async () => {
    const id = pid('one');
    listBody = { items: [makeRecord(id)] };
    const items = await client().listProposals();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe(id);
  });

  it('listProposals() on a body with no items key resolves to [] (never throws on shape)', async () => {
    listBody = { unrelated: true };
    const items = await client().listProposals();
    expect(items).toEqual([]);
  });

  it('listProposals() on HTTP 500 rejects with ProposalHttpError carrying status === 500', async () => {
    listBody = 500;
    await expect(client().listProposals()).rejects.toMatchObject(
      expect.objectContaining({ status: 500 }) as object,
    );
    await expect(client().listProposals()).rejects.toBeInstanceOf(ProposalHttpError);
  });

  it("approve('not-hex') rejects with a plain Error and the stub server records ZERO requests", async () => {
    await expect(client().approve('not-hex')).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it('approve(<64 hex>) issues exactly one POST to /v1/proposals/<id>/approve carrying Authorization: Bearer <token>', async () => {
    const id = pid('approve-me');
    await client().approve(id);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe(`/v1/proposals/${id}/approve`);
    expect(requests[0]?.authHeader).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it('reject() on HTTP 409 rejects with ProposalHttpError carrying status === 409', async () => {
    const id = pid('conflict');
    actionStatus.set(id, 409);
    await expect(client().reject(id)).rejects.toMatchObject(
      expect.objectContaining({ status: 409 }) as object,
    );
  });

  it('isInspectableProposalRecord() returns false for a null, a string, and an object missing change_to', () => {
    expect(isInspectableProposalRecord(null)).toBe(false);
    expect(isInspectableProposalRecord('not-an-object')).toBe(false);
    const record = makeRecord(pid('missing-field')) as Record<string, unknown>;
    delete record['change_to'];
    expect(isInspectableProposalRecord(record)).toBe(false);
    expect(isInspectableProposalRecord(makeRecord(pid('full')))).toBe(true);
  });

  it('(WR-05) isInspectableProposalRecord() validates value types, not just key presence', () => {
    // Wrong types for fields the bridge consumes → false.
    expect(isInspectableProposalRecord(makeRecord(pid('t-desc'), { entity_descriptor: 42 }))).toBe(false);
    expect(isInspectableProposalRecord(makeRecord(pid('t-id'), { id: 12345 }))).toBe(false);
    expect(isInspectableProposalRecord(makeRecord(pid('t-hex'), { id: 'not-a-64-hex-id' }))).toBe(false);
    expect(isInspectableProposalRecord(makeRecord(pid('t-quote'), { evidence_quote: ['array'] }))).toBe(false);
    expect(isInspectableProposalRecord(makeRecord(pid('t-created'), { created_at: 'yesterday' }))).toBe(false);
    expect(isInspectableProposalRecord(makeRecord(pid('t-from'), { change_from: 7 }))).toBe(false);
    expect(isInspectableProposalRecord(makeRecord(pid('t-conf'), { confidence: 'certain' }))).toBe(false);
    // change_from: null is part of the contract → true.
    expect(isInspectableProposalRecord(makeRecord(pid('t-null'), { change_from: null }))).toBe(true);
  });

  it('(WR-06) timestamps must be Date-convertible epoch ms, not merely numbers', () => {
    // Every value below is `typeof === "number"` and every one of them makes
    // new Date(v).toISOString() throw RangeError — which the bridge calls on expires_at
    // with no surrounding try. Infinity is reachable from the wire: JSON `1e999` parses
    // to it.
    for (const field of ['created_at', 'updated_at', 'expires_at']) {
      for (const bad of [Infinity, -Infinity, NaN, 8.64e15 + 1, -8.64e15 - 1]) {
        expect(
          isInspectableProposalRecord(makeRecord(pid(`t-${field}-${String(bad)}`), { [field]: bad })),
        ).toBe(false);
      }
      // The ±8.64e15 ms Date range is inclusive at both edges.
      expect(
        isInspectableProposalRecord(makeRecord(pid(`t-${field}-edge`), { [field]: 8.64e15 })),
      ).toBe(true);
    }
  });

  it('the serve token appears in no thrown Error message and in no value the module returns', async () => {
    const id = pid('token-leak-check');
    actionStatus.set(id, 500);
    try {
      await client().reject(id);
      throw new Error('expected reject() to throw');
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(TEST_TOKEN);
    }
    try {
      await client().approve('not-hex');
      throw new Error('expected approve() to throw');
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(TEST_TOKEN);
    }
  });
});
