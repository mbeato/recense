/**
 * clients/telegram/tests/belief-poll.test.ts — Phase 68 Plan 02 Task 2.
 *
 * Stub-server behavioral proof of runBeliefBridgePass (gates, dedup, entity+day
 * batching, cap, rollback) and runBeliefPollTick (default-OFF gate, delegation,
 * own in-flight guard). Drives against a node:http stub on a free port and
 * MockTelegramTransport, never against a live recense serve instance.
 *
 * No src/ imports — CLIENT-01 structural guard (scanned by import-boundary.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { runBeliefBridgePass } from '../belief-bridge';
import {
  createBeliefProposalClient,
  PROPOSAL_SCHEMA_VERSION,
  type BeliefProposalClient,
} from '../belief-proposal-client';
import { MockTelegramTransport, type TelegramTransport, type TelegramUpdate } from '../transport';
import { getProposal } from '../proposal-store';
import { readStateCursor, writeStateCursor, readBeliefPromptLedger, writeBeliefPromptLedger } from '../state';
import { runBeliefPollTick } from '../index';
import type { ClientConfig } from '../config';

// ── Helpers ──────────────────────────────────────────────────────────────────

let _counter = 0;

function tmpPath(prefix: string): string {
  return path.join(os.tmpdir(), `brain-belief-poll-test-${prefix}-${Date.now()}-${String(++_counter)}.json`);
}

function pid(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
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

function makeClientConfig(overrides: Partial<ClientConfig> = {}): ClientConfig {
  return {
    telegramToken: 'test-token',
    serveUrl: 'http://127.0.0.1:9999',
    serveToken: 'test-serve-token',
    allowlist: ['111'],
    pollIntervalMs: 500,
    statePath: tmpPath('cfg-state'),
    enabled: true,
    proactiveEnabled: false,
    pushPollMs: 120_000,
    quietHoursStart: 22,
    quietHoursEnd: 7,
    digestHour: 8,
    snoozeDurationMs: 86_400_000,
    beliefBridgeEnabled: false,
    beliefPollMs: 300_000,
    ...overrides,
  };
}

/** A transport whose sendMessage always throws — for rollback assertions. */
class ThrowingTransport implements TelegramTransport {
  async getUpdates(): Promise<TelegramUpdate[]> {
    return [];
  }
  async sendMessage(): Promise<void> {
    throw new Error('network down');
  }
  async answerCallbackQuery(): Promise<void> {
    // no-op
  }
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

// ── Stub server ─────────────────────────────────────────────────────────────

let server: http.Server;
let port: number;
let listBody: unknown;

beforeEach(async () => {
  listBody = { items: [] };
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/proposals') {
      if (typeof listBody === 'number') {
        res.writeHead(listBody, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'stub_error' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(listBody));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  port = await getFreePort();
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function baseUrl(): string {
  return `http://127.0.0.1:${String(port)}`;
}

function makeClient(): BeliefProposalClient {
  return createBeliefProposalClient(baseUrl(), 'test-token');
}

// ── runBeliefBridgePass ─────────────────────────────────────────────────────

describe('runBeliefBridgePass — gates, dedup, batching, cap, rollback', () => {
  it('an empty list response sends zero messages and writes zero store rows (D-08 hold-exclusion sentinel)', async () => {
    listBody = { items: [] };
    const transport = new MockTelegramTransport();
    const storePath = tmpPath('empty-store');
    const statePath = tmpPath('empty-state');
    await runBeliefBridgePass({
      client: makeClient(), transport, chatIds: [111], storePath, statePath,
      dailyCap: 10, log: () => {}, nowMs: Date.now(),
    });
    expect(transport.sent).toHaveLength(0);
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it('a list containing one malformed item (missing change_to) sends nothing at all — the whole pass stops', async () => {
    const malformed = makeRecord(pid('malformed-1'));
    delete malformed['change_to'];
    listBody = { items: [malformed, makeRecord(pid('malformed-2'))] };
    const transport = new MockTelegramTransport();
    await runBeliefBridgePass({
      client: makeClient(), transport, chatIds: [111],
      storePath: tmpPath('wireshape-store'), statePath: tmpPath('wireshape-state'),
      dailyCap: 10, log: () => {}, nowMs: Date.now(),
    });
    expect(transport.sent).toHaveLength(0);
  });

  it('a record whose schema_version is 18 stops the pass with nothing sent', async () => {
    listBody = { items: [makeRecord(pid('schema-1'), { schema_version: 18 })] };
    const transport = new MockTelegramTransport();
    await runBeliefBridgePass({
      client: makeClient(), transport, chatIds: [111],
      storePath: tmpPath('schema-store'), statePath: tmpPath('schema-state'),
      dailyCap: 10, log: () => {}, nowMs: Date.now(),
    });
    expect(transport.sent).toHaveLength(0);
  });

  it("a record whose kind is not 'belief' is skipped while the rest of the pass continues", async () => {
    const good = makeRecord(pid('kind-good'));
    const bad = makeRecord(pid('kind-bad'), { kind: 'tool' });
    listBody = { items: [bad, good] };
    const transport = new MockTelegramTransport();
    await runBeliefBridgePass({
      client: makeClient(), transport, chatIds: [111],
      storePath: tmpPath('kind-store'), statePath: tmpPath('kind-state'),
      dailyCap: 10, log: () => {}, nowMs: Date.now(),
    });
    expect(transport.sent).toHaveLength(1);
  });

  it("a record whose status is not 'pending' is never surfaced", async () => {
    const good = makeRecord(pid('status-good'));
    const approved = makeRecord(pid('status-approved'), { status: 'approved' });
    listBody = { items: [approved, good] };
    const transport = new MockTelegramTransport();
    await runBeliefBridgePass({
      client: makeClient(), transport, chatIds: [111],
      storePath: tmpPath('status-store'), statePath: tmpPath('status-state'),
      dailyCap: 10, log: () => {}, nowMs: Date.now(),
    });
    expect(transport.sent).toHaveLength(1);
  });

  it('three pending records sharing one entity_descriptor produce exactly ONE sendMessage call carrying three button rows', async () => {
    const entity = 'Acme Corp — Backend Engineer';
    listBody = {
      items: [
        makeRecord(pid('batch-1'), { entity_descriptor: entity }),
        makeRecord(pid('batch-2'), { entity_descriptor: entity }),
        makeRecord(pid('batch-3'), { entity_descriptor: entity }),
      ],
    };
    const transport = new MockTelegramTransport();
    await runBeliefBridgePass({
      client: makeClient(), transport, chatIds: [111],
      storePath: tmpPath('batch-store'), statePath: tmpPath('batch-state'),
      dailyCap: 10, log: () => {}, nowMs: Date.now(),
    });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.replyMarkup?.inline_keyboard).toHaveLength(3);
  });

  it('two records for two different entities produce exactly TWO sendMessage calls', async () => {
    listBody = {
      items: [
        makeRecord(pid('two-entities-1'), { entity_descriptor: 'Entity A' }),
        makeRecord(pid('two-entities-2'), { entity_descriptor: 'Entity B' }),
      ],
    };
    const transport = new MockTelegramTransport();
    await runBeliefBridgePass({
      client: makeClient(), transport, chatIds: [111],
      storePath: tmpPath('two-entities-store'), statePath: tmpPath('two-entities-state'),
      dailyCap: 10, log: () => {}, nowMs: Date.now(),
    });
    expect(transport.sent).toHaveLength(2);
  });

  it('re-running the pass over the identical list sends nothing the second time (dedup on the derived local id)', async () => {
    listBody = { items: [makeRecord(pid('dedup-1'))] };
    const transport = new MockTelegramTransport();
    const storePath = tmpPath('dedup-store');
    const statePath = tmpPath('dedup-state');
    const client = makeClient();
    const deps = { client, transport, chatIds: [111], storePath, statePath, dailyCap: 10, log: () => {} };

    await runBeliefBridgePass({ ...deps, nowMs: Date.now() });
    expect(transport.sent).toHaveLength(1);

    await runBeliefBridgePass({ ...deps, nowMs: Date.now() });
    expect(transport.sent).toHaveLength(1); // still 1 — no new send
  });

  it('a second pass on the same local day for an already-prompted entity sends nothing even for a brand-new proposal id, and the ledger records the local day it was set for', async () => {
    const entity = 'Acme Corp';
    const storePath = tmpPath('sameday-store');
    const statePath = tmpPath('sameday-state');
    const transport = new MockTelegramTransport();
    const client = makeClient();
    const day1 = Date.parse('2026-08-03T12:00:00.000Z');

    listBody = { items: [makeRecord(pid('sameday-1'), { entity_descriptor: entity })] };
    await runBeliefBridgePass({
      client, transport, chatIds: [111], storePath, statePath, dailyCap: 10, log: () => {}, nowMs: day1,
    });
    expect(transport.sent).toHaveLength(1);

    // Same day, brand-new proposal id for the SAME entity → suppressed.
    listBody = { items: [makeRecord(pid('sameday-2'), { entity_descriptor: entity })] };
    await runBeliefBridgePass({
      client, transport, chatIds: [111], storePath, statePath, dailyCap: 10, log: () => {}, nowMs: day1 + 5_000,
    });
    expect(transport.sent).toHaveLength(1); // still 1

    const ledger = readBeliefPromptLedger(statePath);
    expect(ledger.counts[entity]).toBe(1);
    expect(ledger.date).toBe('2026-08-03');
  });

  it('(checker W3) day-boundary resurface round-trip: dropped on the already-prompted day, sent on the next local day', async () => {
    const entity = 'Globex Inc';
    const storePath = tmpPath('resurface-store');
    const statePath = tmpPath('resurface-state');
    const transport = new MockTelegramTransport();
    const client = makeClient();
    const dayN = Date.parse('2026-08-05T09:00:00.000Z');
    const dayNplus1 = Date.parse('2026-08-06T09:00:00.000Z');

    // Seed the ledger as "already prompted today" for day N (simulating an earlier
    // prompt in the same local day for this entity).
    writeBeliefPromptLedger(statePath, { date: '2026-08-05', counts: { [entity]: 1 } });

    const recordId = pid('resurface-round-trip');
    listBody = { items: [makeRecord(recordId, { entity_descriptor: entity })] };

    // Day N: entity already prompted → the still-pending proposal is dropped, nothing sent.
    await runBeliefBridgePass({
      client, transport, chatIds: [111], storePath, statePath, dailyCap: 10, log: () => {}, nowMs: dayN,
    });
    expect(transport.sent).toHaveLength(0);

    // Day N+1: same still-pending proposal is in the list again → ledger has reset → IS sent.
    await runBeliefBridgePass({
      client, transport, chatIds: [111], storePath, statePath, dailyCap: 10, log: () => {}, nowMs: dayNplus1,
    });
    expect(transport.sent).toHaveLength(1);
  });

  it('when tryReserveProposalSlot returns false, nothing is sent and no rows are written', async () => {
    const id = pid('cap-exhausted');
    listBody = { items: [makeRecord(id)] };
    const transport = new MockTelegramTransport();
    const storePath = tmpPath('cap-store');
    await runBeliefBridgePass({
      client: makeClient(), transport, chatIds: [111],
      storePath, statePath: tmpPath('cap-state'),
      dailyCap: 0, log: () => {}, nowMs: Date.now(),
    });
    expect(transport.sent).toHaveLength(0);
    expect(getProposal(id.slice(0, 32), storePath)).toBeNull();
  });

  it('when sendMessage throws, the rows written for that group are removed again so the next pass can retry', async () => {
    const id = pid('send-fail');
    listBody = { items: [makeRecord(id)] };
    const storePath = tmpPath('sendfail-store');
    await runBeliefBridgePass({
      client: makeClient(), transport: new ThrowingTransport(), chatIds: [111],
      storePath, statePath: tmpPath('sendfail-state'),
      dailyCap: 10, log: () => {}, nowMs: Date.now(),
    });
    expect(getProposal(id.slice(0, 32), storePath)).toBeNull();
  });

  it('a pass whose listProposals throws logs and resolves — it never rejects', async () => {
    listBody = 500; // stub server returns 500 → ProposalHttpError
    const transport = new MockTelegramTransport();
    const logs: string[] = [];
    await expect(
      runBeliefBridgePass({
        client: makeClient(), transport, chatIds: [111],
        storePath: tmpPath('throw-store'), statePath: tmpPath('throw-state'),
        dailyCap: 10, log: (m: string) => logs.push(m), nowMs: Date.now(),
      }),
    ).resolves.toBeUndefined();
    expect(logs.some(l => l.includes('list failed'))).toBe(true);
    expect(transport.sent).toHaveLength(0);
  });
});

// ── state.ts — read-modify-write sibling-field preservation ────────────────

describe('state.ts — writeStateCursor / writeBeliefPromptLedger preserve each other', () => {
  it('writeStateCursor then writeBeliefPromptLedger then writeStateCursor again — both cursor and ledger remain readable', () => {
    const statePath = tmpPath('rmw-state');
    writeStateCursor(statePath, 'cursor-1');
    writeBeliefPromptLedger(statePath, { date: '2026-08-03', counts: { 'Acme Corp': 2 } });
    writeStateCursor(statePath, 'cursor-2');

    expect(readStateCursor(statePath)).toBe('cursor-2');
    const ledger = readBeliefPromptLedger(statePath);
    expect(ledger.date).toBe('2026-08-03');
    expect(ledger.counts['Acme Corp']).toBe(2);
  });
});

// ── runBeliefPollTick — gate + delegation (checker W2) ──────────────────────

describe('(checker W2) runBeliefPollTick — default-OFF gate + delegation', () => {
  it('beliefBridgeEnabled: false calls neither listProposals nor sendMessage', async () => {
    let listCalled = false;
    const stubClient: BeliefProposalClient = {
      listProposals: async () => {
        listCalled = true;
        return [];
      },
      approve: async () => {},
      reject: async () => {},
    };
    const transport = new MockTelegramTransport();
    const config = makeClientConfig({ beliefBridgeEnabled: false });

    await runBeliefPollTick(config, transport, stubClient);

    expect(listCalled).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });

  it('beliefBridgeEnabled: true delegates to runBeliefBridgePass (listProposals invoked)', async () => {
    let listCalled = false;
    const stubClient: BeliefProposalClient = {
      listProposals: async () => {
        listCalled = true;
        return [];
      },
      approve: async () => {},
      reject: async () => {},
    };
    const transport = new MockTelegramTransport();
    const config = makeClientConfig({ beliefBridgeEnabled: true });

    await runBeliefPollTick(config, transport, stubClient, {
      storePath: tmpPath('w2-store'),
      statePath: tmpPath('w2-state'),
      nowMs: Date.now(),
    });

    expect(listCalled).toBe(true);
  });
});
