/**
 * clients/telegram/tests/memory-client-surface.test.ts
 *
 * Pins the surface() GET / surfaceSeen() POST behaviour against a real mock
 * HTTP server.  Key invariants tested:
 *
 *   - surface() uses method:'GET', not POST (pins Landmine 3 — postJson is POST-only)
 *   - surface({ limit }) appends ?limit= to the URL
 *   - surfaceSeen() sends a POST with the exact body (node_id, occurrence_due_at, outcome)
 *   - snooze round-trip: snooze_until present in POST body (WR-01 satisfiable)
 *   - non-2xx response from surfaceSeen() → rejects with 'serve HTTP 404'
 *
 * No imports from ../../src/ — CLIENT-01 structural guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { createMemoryClient, type SurfaceItem } from '../memory-client';

// ---------------------------------------------------------------------------
// Helpers (copied verbatim from telegram-client.test.ts — shared harness)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mock server state (reset per test via beforeEach)
// ---------------------------------------------------------------------------

let mockServer: http.Server;
let mockPort: number;

/** Items scripted to be returned by GET /v1/surface. */
let scriptedSurfaceItems: SurfaceItem[];
/** Method of the last /v1/surface request. */
let lastSurfaceMethod: string;
/** Full URL (path + query) of the last /v1/surface request. */
let lastSurfaceUrl: string;
/** Parsed JSON body of the last POST /v1/surface/seen request. */
let lastSeenBody: Record<string, unknown>;
/** Number of POST /v1/surface/seen requests received. */
let seenRequestCount: number;

beforeEach(async () => {
  scriptedSurfaceItems = [];
  lastSurfaceMethod = '';
  lastSurfaceUrl = '';
  lastSeenBody = {};
  seenRequestCount = 0;

  mockPort = await getFreePort();
  mockServer = http.createServer((req, res) => {
    // POST /v1/surface/seen — record body, return 200
    if (req.method === 'POST' && req.url === '/v1/surface/seen') {
      seenRequestCount++;
      let data = '';
      req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      req.on('end', () => {
        try { lastSeenBody = JSON.parse(data) as Record<string, unknown>; } catch { lastSeenBody = {}; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    // GET /v1/surface (with optional ?limit) — record method + url, return scripted items
    if (req.method === 'GET' && req.url?.startsWith('/v1/surface')) {
      lastSurfaceMethod = req.method;
      lastSurfaceUrl = req.url ?? '';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ items: scriptedSurfaceItems }));
      return;
    }
    // Catch-all
    res.writeHead(404); res.end();
  });
  await new Promise<void>(r => mockServer.listen(mockPort, '127.0.0.1', r));
});

afterEach(async () => {
  await new Promise<void>(r => mockServer.close(() => r()));
});

// ---------------------------------------------------------------------------
// surface() — GET branch
// ---------------------------------------------------------------------------

describe('surface() — GET /v1/surface', () => {
  it('issues a GET request, NOT a POST (pins Landmine 3)', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await client.surface();
    expect(lastSurfaceMethod).toBe('GET');
  });

  it('returns the scripted SurfaceItem array', async () => {
    const item: SurfaceItem = {
      node_id: 'abc-123',
      value: 'dentist appointment',
      due_at: '2026-06-20T14:00:00.000Z',
      action_type: 'reminder',
      tier: 0,
      score: 0.95,
    };
    scriptedSurfaceItems = [item];
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    const items = await client.surface();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ node_id: 'abc-123', tier: 0, score: 0.95 });
  });

  it('returns [] when the response has an empty items array', async () => {
    scriptedSurfaceItems = [];
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    const items = await client.surface();
    expect(items).toEqual([]);
  });

  it('surface({ limit: 2 }) appends ?limit=2 to the URL', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await client.surface({ limit: 2 });
    expect(lastSurfaceUrl).toContain('?limit=2');
  });

  it('surface() without limit does not append any query string', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await client.surface();
    expect(lastSurfaceUrl).toBe('/v1/surface');
  });
});

// ---------------------------------------------------------------------------
// surfaceSeen() — POST branch
// ---------------------------------------------------------------------------

describe('surfaceSeen() — POST /v1/surface/seen', () => {
  it('sends a POST with node_id, occurrence_due_at, and outcome in the body', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await client.surfaceSeen({
      node_id: 'node-001',
      occurrence_due_at: '2026-06-20T14:00:00.000Z',
      outcome: 'completed',
    });
    expect(seenRequestCount).toBe(1);
    expect(lastSeenBody['node_id']).toBe('node-001');
    expect(lastSeenBody['occurrence_due_at']).toBe('2026-06-20T14:00:00.000Z');
    expect(lastSeenBody['outcome']).toBe('completed');
  });

  it('snooze round-trip: body includes snooze_until (WR-01 satisfiable)', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    const snoozeUntil = '2026-06-21T14:00:00.000Z';
    await client.surfaceSeen({
      node_id: 'node-002',
      occurrence_due_at: '2026-06-20T14:00:00.000Z',
      outcome: 'snoozed',
      snooze_until: snoozeUntil,
    });
    expect(lastSeenBody['outcome']).toBe('snoozed');
    expect(lastSeenBody['snooze_until']).toBe(snoozeUntil);
  });

  it('resolves on a 200 response', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await expect(
      client.surfaceSeen({ node_id: 'x', occurrence_due_at: '2026-06-20T14:00:00.000Z' }),
    ).resolves.toBeUndefined();
  });

  it('rejects with "serve HTTP 404" when server returns 404', async () => {
    // Spin a dedicated all-404 server for this test
    const p404 = await getFreePort();
    const srv404 = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    await new Promise<void>(r => srv404.listen(p404, '127.0.0.1', r));

    const client = createMemoryClient(`http://127.0.0.1:${p404}`, 'test-serve-token');
    await expect(
      client.surfaceSeen({
        node_id: 'gone-node',
        occurrence_due_at: '2026-06-20T14:00:00.000Z',
        outcome: 'completed',
      }),
    ).rejects.toThrow('serve HTTP 404');

    await new Promise<void>(r => srv404.close(() => r()));
  });
});
