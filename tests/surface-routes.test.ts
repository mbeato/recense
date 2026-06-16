/**
 * tests/surface-routes.test.ts — TDD RED for GET /v1/surface + POST /v1/surface/seen routes
 * (Plan 21-03, Task 2).
 *
 * Behavior under test:
 *   GET /v1/surface (authenticated)
 *     → 200 { items: SurfaceItem[] } sorted (tier ASC, score DESC)
 *     → 401 without auth header
 *     → 401 with wrong token
 *     → no readBody call (read path, no lock)
 *
 *   POST /v1/surface/seen (authenticated)
 *     → 200 { status: 'recorded' } on valid { node_id, occurrence_due_at, outcome?, snooze_until? }
 *     → 400 bad_request: non-string node_id
 *     → 400 bad_request: missing occurrence_due_at
 *     → 400 bad_request: occurrence_due_at is not a parseable date
 *     → 400 bad_request: outcome outside the 5-value enum
 *     → 400 bad_request: snooze_until present but not a parseable date
 *     → 404 not_found: node_id not in node table (SurfaceTargetNotFoundError)
 *     → 503 service_unavailable: MemoryBusyError
 *     → 401 without auth
 *
 * These tests MUST FAIL before Task 2 implementation (RED state):
 *   /v1/surface and /v1/surface/seen routes are not yet registered in serve-cli.ts — all
 *   requests fall through to the 404 catch-all.
 *
 * Harness: node:http.request (no fetch), MockModelProvider, temp file DB, hermetic lock path.
 * Mirrors serve-cli.test.ts pattern exactly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as http from 'node:http';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initSchema } from '../src/db/schema';
import { createBrainHttpServer, BrainHttpServer } from '../src/adapter/serve-cli';
import { MockModelProvider } from '../src/model/provider';

// ---------------------------------------------------------------------------
// Helpers (mirrors serve-cli.test.ts)
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `surface-routes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

interface SimpleResponse {
  statusCode: number;
  body: string;
}

function get(port: number, urlPath: string, headers: Record<string, string> = {}): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'GET',
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
    req.end();
  });
}

function post(
  port: number,
  urlPath: string,
  reqBody: string,
  headers: Record<string, string> = {},
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        agent: new http.Agent({ keepAlive: false }),
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(reqBody),
          ...headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.write(reqBody);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'a'.repeat(64);
const AUTH_HEADER = { authorization: `Bearer ${TEST_TOKEN}` };

let serverResult: BrainHttpServer;
let port: number;
let tmpDbPath: string;
let tmpLockPath: string;

beforeEach(async () => {
  port = await getFreePort();
  tmpDbPath = makeTempDbPath();
  tmpLockPath = path.join(os.tmpdir(), `surface-routes-lock-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`);
  process.env['RECENSE_LOCK_PATH'] = tmpLockPath;

  // Must use a file-based DB (separateReadHandle: true requires a file)
  const setupDb = new Database(tmpDbPath);
  initSchema(setupDb);
  setupDb.close();

  serverResult = await createBrainHttpServer({
    dbPath: tmpDbPath,
    token: TEST_TOKEN,
    provider: new MockModelProvider({ embedFn: () => new Float32Array([0.1, 0.2, 0.3]) }),
  });
  serverResult.server.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => {
    if (serverResult.server.listening) { resolve(); return; }
    serverResult.server.once('listening', resolve);
  });
});

afterEach(async () => {
  await serverResult.close();
  try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
  delete process.env['RECENSE_LOCK_PATH'];
  try { fs.unlinkSync(tmpLockPath); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function seedNode(id: string, s: number, value = `value-of-${id}`): void {
  const db = new Database(tmpDbPath);
  db.prepare(`
    INSERT INTO node (id, type, value, value_hash, origin, s, c, last_access, tombstoned, pending_contradictions, training_eligible)
    VALUES (?, 'fact', ?, ?, 'observed', ?, 0.5, ?, 0, '[]', 0)
  `).run(id, value, `hash-${id}`, s, Date.now());
  db.close();
}

function seedTemporal(nodeId: string, dueAtMs: number): string {
  const dueAt = new Date(dueAtMs).toISOString();
  const db = new Database(tmpDbPath);
  db.prepare(`
    INSERT INTO node_temporal (node_id, due_at, action_type, recurrence_rule, source_event_id, updated_at)
    VALUES (?, ?, 'meeting', NULL, NULL, ?)
  `).run(nodeId, dueAt, Date.now());
  db.close();
  return dueAt;
}

// ---------------------------------------------------------------------------
// GET /v1/surface — authenticated read
// ---------------------------------------------------------------------------

describe('GET /v1/surface — happy paths', () => {
  it('returns 200 with { items: [] } on empty DB', async () => {
    const res = await get(port, '/v1/surface', AUTH_HEADER);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { items: unknown[] };
    expect(body).toHaveProperty('items');
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toEqual([]);
  });

  it('returns 200 with ranked items when seeded node_temporal exists', async () => {
    seedNode('surface-route-node', 0.7);
    const dueAt = seedTemporal('surface-route-node', Date.now() + 60 * 60 * 1000);

    const res = await get(port, '/v1/surface', AUTH_HEADER);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { items: { node_id: string; due_at: string; tier: number }[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.node_id).toBe('surface-route-node');
    expect(body.items[0]!.due_at).toBe(dueAt);
    expect(body.items[0]!.tier).toBe(0); // 1h from now → P0
  });

  it('P0 items appear before lower-tier items', async () => {
    seedNode('p0-route-node', 0.5);
    seedNode('lower-route-node', 0.9);
    seedTemporal('p0-route-node', Date.now() + 2 * 60 * 60 * 1000);          // 2h → P0
    seedTemporal('lower-route-node', Date.now() + 5 * 24 * 60 * 60 * 1000); // 5d → lower

    const res = await get(port, '/v1/surface', AUTH_HEADER);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { items: { node_id: string; tier: number }[] };
    expect(body.items.length).toBeGreaterThanOrEqual(2);
    const p0Idx    = body.items.findIndex(i => i.node_id === 'p0-route-node');
    const lowerIdx = body.items.findIndex(i => i.node_id === 'lower-route-node');
    expect(p0Idx).toBeGreaterThanOrEqual(0);
    expect(lowerIdx).toBeGreaterThanOrEqual(0);
    expect(p0Idx).toBeLessThan(lowerIdx);
  });
});

describe('GET /v1/surface — auth gate', () => {
  it('returns 401 without Authorization header', async () => {
    const res = await get(port, '/v1/surface');
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('unauthorized');
  });

  it('returns 401 with wrong token', async () => {
    const res = await get(port, '/v1/surface', { authorization: 'Bearer ' + 'b'.repeat(64) });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('unauthorized');
  });
});

// ---------------------------------------------------------------------------
// POST /v1/surface/seen — write path
// ---------------------------------------------------------------------------

describe('POST /v1/surface/seen — happy path', () => {
  it('returns 200 { status: "recorded" } for valid request with existing node', async () => {
    seedNode('seen-route-node', 0.5);
    const dueAt = seedTemporal('seen-route-node', Date.now() + 60 * 60 * 1000);

    const res = await post(
      port,
      '/v1/surface/seen',
      JSON.stringify({ node_id: 'seen-route-node', occurrence_due_at: dueAt, outcome: 'seen' }),
      AUTH_HEADER,
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string };
    expect(body.status).toBe('recorded');
  });

  it('accepts seen request without optional outcome (defaults to seen)', async () => {
    seedNode('seen-default-route', 0.5);
    const dueAt = seedTemporal('seen-default-route', Date.now() + 60 * 60 * 1000);

    const res = await post(
      port,
      '/v1/surface/seen',
      JSON.stringify({ node_id: 'seen-default-route', occurrence_due_at: dueAt }),
      AUTH_HEADER,
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string };
    expect(body.status).toBe('recorded');
  });
});

describe('POST /v1/surface/seen — auth gate', () => {
  it('returns 401 without Authorization header', async () => {
    const res = await post(
      port,
      '/v1/surface/seen',
      JSON.stringify({ node_id: 'x', occurrence_due_at: new Date().toISOString() }),
    );
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('unauthorized');
  });
});

describe('POST /v1/surface/seen — 400 validation', () => {
  it('returns 400 when node_id is missing', async () => {
    const res = await post(
      port,
      '/v1/surface/seen',
      JSON.stringify({ occurrence_due_at: new Date().toISOString() }),
      AUTH_HEADER,
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('bad_request');
  });

  it('returns 400 when node_id is not a string', async () => {
    const res = await post(
      port,
      '/v1/surface/seen',
      JSON.stringify({ node_id: 42, occurrence_due_at: new Date().toISOString() }),
      AUTH_HEADER,
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('bad_request');
  });

  it('returns 400 when occurrence_due_at is missing', async () => {
    const res = await post(
      port,
      '/v1/surface/seen',
      JSON.stringify({ node_id: 'x' }),
      AUTH_HEADER,
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('bad_request');
  });

  it('returns 400 when occurrence_due_at is not a string', async () => {
    const res = await post(
      port,
      '/v1/surface/seen',
      JSON.stringify({ node_id: 'x', occurrence_due_at: 12345 }),
      AUTH_HEADER,
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('bad_request');
  });

  it('returns 400 when occurrence_due_at is not a parseable date', async () => {
    const res = await post(
      port,
      '/v1/surface/seen',
      JSON.stringify({ node_id: 'x', occurrence_due_at: 'not-a-date' }),
      AUTH_HEADER,
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('bad_request');
  });

  it('returns 400 when outcome is outside the 5-value enum', async () => {
    const res = await post(
      port,
      '/v1/surface/seen',
      JSON.stringify({
        node_id: 'x',
        occurrence_due_at: new Date().toISOString(),
        outcome: 'ignored',
      }),
      AUTH_HEADER,
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('bad_request');
  });

  it('returns 400 when snooze_until is present but not a parseable date', async () => {
    const res = await post(
      port,
      '/v1/surface/seen',
      JSON.stringify({
        node_id: 'x',
        occurrence_due_at: new Date().toISOString(),
        outcome: 'snoozed',
        snooze_until: 'not-a-date',
      }),
      AUTH_HEADER,
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('bad_request');
  });

  // WR-01: snooze_until is REQUIRED when outcome='snoozed'. Without it the upsert would
  // write snooze_until=NULL, isExcluded() would never exclude the item, and the "snooze"
  // would silently re-surface forever. The route must reject the combination with 400.
  it("returns 400 when outcome='snoozed' but snooze_until is omitted", async () => {
    const res = await post(
      port,
      '/v1/surface/seen',
      JSON.stringify({
        node_id: 'x',
        occurrence_due_at: new Date().toISOString(),
        outcome: 'snoozed',
      }),
      AUTH_HEADER,
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('bad_request');
  });

  it("returns 400 when outcome='snoozed' but snooze_until is explicitly null", async () => {
    const res = await post(
      port,
      '/v1/surface/seen',
      JSON.stringify({
        node_id: 'x',
        occurrence_due_at: new Date().toISOString(),
        outcome: 'snoozed',
        snooze_until: null,
      }),
      AUTH_HEADER,
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('bad_request');
  });
});

describe('POST /v1/surface/seen — 404 for unknown node', () => {
  it('returns 404 not_found when node_id does not exist in node table', async () => {
    const res = await post(
      port,
      '/v1/surface/seen',
      JSON.stringify({
        node_id: 'totally-unknown-node-id',
        occurrence_due_at: new Date(Date.now() + 3_600_000).toISOString(),
        outcome: 'seen',
      }),
      AUTH_HEADER,
    );
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// D-43 sentinel: surface + seen cycle leaves node.s and node.c unchanged
// ---------------------------------------------------------------------------

describe('D-43 sentinel: surface + seen cycle does not mutate belief table', () => {
  it('node.s and node.c are unchanged after GET /v1/surface + POST /v1/surface/seen', async () => {
    const nodeId = 'sentinel-node-route';
    const S_INITIAL = 0.42;
    const C_INITIAL = 0.65;

    // Seed node with known s/c values
    const seedDb = new Database(tmpDbPath);
    seedDb.prepare(`
      INSERT INTO node (id, type, value, value_hash, origin, s, c, last_access, tombstoned, pending_contradictions, training_eligible)
      VALUES (?, 'fact', 'meeting tomorrow', 'hash-sentinel', 'observed', ?, ?, ?, 0, '[]', 0)
    `).run(nodeId, S_INITIAL, C_INITIAL, Date.now());
    const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    seedDb.prepare(`
      INSERT INTO node_temporal (node_id, due_at, action_type, recurrence_rule, source_event_id, updated_at)
      VALUES (?, ?, 'meeting', NULL, NULL, ?)
    `).run(nodeId, dueAt, Date.now());

    const before = seedDb.prepare('SELECT s, c FROM node WHERE id = ?').get(nodeId) as { s: number; c: number };
    seedDb.close();

    // 1. GET /v1/surface — read path
    const surfaceRes = await get(port, '/v1/surface', AUTH_HEADER);
    expect(surfaceRes.statusCode).toBe(200);

    // 2. POST /v1/surface/seen — write path
    const seenRes = await post(
      port,
      '/v1/surface/seen',
      JSON.stringify({ node_id: nodeId, occurrence_due_at: dueAt, outcome: 'seen' }),
      AUTH_HEADER,
    );
    expect(seenRes.statusCode).toBe(200);

    // 3. Assert node.s and node.c unchanged (D-43)
    const checkDb = new Database(tmpDbPath);
    const after = checkDb.prepare('SELECT s, c FROM node WHERE id = ?').get(nodeId) as { s: number; c: number };
    checkDb.close();

    expect(after.s).toBe(before.s);
    expect(after.c).toBe(before.c);
  });
});
