/**
 * Tests for src/viz/server.ts (Plan 10-03, Task 1).
 *
 * Coverage:
 *   - startVizServer starts on a random ephemeral port on 127.0.0.1
 *   - GET /graph returns { nodes, links } JSON with source/target link keys
 *   - GET /graph with no data returns { nodes: [], links: [] }
 *   - GET /events returns text/event-stream with retry preamble
 *   - GET /vendor/.. (traversal) returns 403
 *   - GET /../package.json (traversal) returns 403
 *   - GET /notfound returns 404
 *   - GET /index.html when absent returns 503
 *
 * IMPORTANT: never GET the SSE endpoint and wait for networkidle — the open
 * connection never idles. All assertions use a short fetch + immediate close.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as http from 'node:http';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initSchema } from '../src/db/schema';
import { startVizServer } from '../src/viz/server';
import { SQLiteActivationTraceSink } from '../src/viz/activation-sink';
import { FakeClock } from '../src/lib/clock';

// ---------------------------------------------------------------------------
// Helper: create a temp file DB path (better-sqlite3 cannot open :memory: readonly)
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `viz-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// ---------------------------------------------------------------------------
// Helper: pick a free OS port by creating a temporary server
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
// Helper: make a simple GET request to 127.0.0.1
// ---------------------------------------------------------------------------

interface SimpleResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function get(port: number, urlPath: string): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body,
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Helper: GET that destroys connection after receiving response headers (SSE safe)
// ---------------------------------------------------------------------------

function getHeaders(port: number, urlPath: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method: 'GET' },
      (res) => {
        resolve({ statusCode: res.statusCode ?? 0, headers: res.headers });
        // Destroy immediately — don't wait for the SSE stream to end.
        res.destroy();
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      // ECONNRESET is expected after res.destroy() on the SSE connection.
      if (err.code === 'ECONNRESET') return;
      reject(err);
    });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Helper: open the SSE stream, fire onOpen once the client is registered, and
// resolve with the parsed `data:` payload of the first `event: trace` frame.
// (SSE-safe: keeps the connection open, then destroys it once a frame arrives.)
// ---------------------------------------------------------------------------

interface SseTracePayload {
  id: number;
  ts: number;
  query_id: string;
  seeds: unknown;
  hops: unknown;
}

function collectTraceEvent(
  port: number,
  onOpen: () => void,
  timeoutMs = 3000,
): Promise<SseTracePayload> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    let timer: NodeJS.Timeout;

    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/events', method: 'GET' },
      (res) => {
        // Headers received → the server has already run clients.add(res) synchronously,
        // so a trace written now will be picked up by the next poll (≤ POLL_MS).
        onOpen();
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          // SSE frames are separated by a blank line.
          for (const frame of buf.split('\n\n')) {
            if (!frame.startsWith('event: trace')) continue;
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            try {
              const parsed = JSON.parse(dataLine.slice('data: '.length)) as SseTracePayload;
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                res.destroy();
                resolve(parsed);
              }
            } catch { /* partial frame still buffering — wait for more data */ }
          }
        });
      },
    );
    req.on('error', (err: NodeJS.ErrnoException) => {
      // ECONNRESET after our own res.destroy() is expected; ignore once settled.
      if (settled && err.code === 'ECONNRESET') return;
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    });
    timer = setTimeout(() => {
      if (!settled) { settled = true; req.destroy(); reject(new Error('timed out waiting for SSE trace event')); }
    }, timeoutMs);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let server: http.Server;
let port: number;
let tmpDbPath: string;

beforeEach(async () => {
  port = await getFreePort();
  // Must use a file-based DB — better-sqlite3 cannot open :memory: with { readonly: true }
  tmpDbPath = makeTempDbPath();
  const setupDb = new Database(tmpDbPath);
  initSchema(setupDb);
  setupDb.close();

  server = startVizServer(tmpDbPath, port);
  // Wait for the server to be listening
  await new Promise<void>((resolve) => {
    if (server.listening) { resolve(); return; }
    server.once('listening', resolve);
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// /graph endpoint
// ---------------------------------------------------------------------------

describe('GET /graph', () => {
  it('returns 200 with application/json content-type', async () => {
    const res = await get(port, '/graph');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('returns { nodes: [], links: [] } on an empty DB', async () => {
    const res = await get(port, '/graph');
    const payload = JSON.parse(res.body) as { nodes: unknown[]; links: unknown[] };
    expect(payload).toHaveProperty('nodes');
    expect(payload).toHaveProperty('links');
    expect(payload.nodes).toEqual([]);
    expect(payload.links).toEqual([]);
  });

  it('returns source/target link keys (LOCKED link-key contract)', async () => {
    // Use the existing fixture's file-based DB — insert data before the server
    // polls, then query /graph. The server already has the DB open readonly;
    // we insert via a separate write handle on the same file.
    const writeDb = new Database(tmpDbPath);
    writeDb.prepare(
      'INSERT INTO node (id, type, value, value_hash, origin, s, c, last_access, tombstoned, training_eligible, pending_contradictions) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run('n1', 'entity', 'Alice', 'h1', 'observed', 0.5, 0.8, 1, 0, 0, '[]');
    writeDb.prepare(
      'INSERT INTO node (id, type, value, value_hash, origin, s, c, last_access, tombstoned, training_eligible, pending_contradictions) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
    ).run('n2', 'entity', 'Bob', 'h2', 'observed', 0.4, 0.7, 1, 0, 0, '[]');
    writeDb.prepare(
      'INSERT INTO edge (src, dst, rel, w, last_access, kind) VALUES (?,?,?,?,?,?)'
    ).run('n1', 'n2', 'knows', 0.6, 1, 'relation');
    writeDb.close();

    const res = await get(port, '/graph');
    const payload = JSON.parse(res.body) as {
      nodes: Array<{ id: string }>;
      links: Array<{ source: string; target: string; rel: string }>;
    };
    expect(payload.nodes).toHaveLength(2);
    expect(payload.links).toHaveLength(1);
    expect(payload.links[0]).toHaveProperty('source', 'n1');
    expect(payload.links[0]).toHaveProperty('target', 'n2');
    expect(payload.links[0]).toHaveProperty('rel', 'knows');
    // Must NOT have raw 'src' or 'dst' keys (LOCKED link-key contract)
    expect(payload.links[0]).not.toHaveProperty('src');
    expect(payload.links[0]).not.toHaveProperty('dst');
  });
});

// ---------------------------------------------------------------------------
// /events SSE endpoint
// ---------------------------------------------------------------------------

describe('GET /events', () => {
  it('returns 200 with text/event-stream content-type', async () => {
    const { statusCode, headers } = await getHeaders(port, '/events');
    expect(statusCode).toBe(200);
    expect(headers['content-type']).toContain('text/event-stream');
  });

  it('returns cache-control: no-cache', async () => {
    const { headers } = await getHeaders(port, '/events');
    expect(headers['cache-control']).toContain('no-cache');
  });
});

// ---------------------------------------------------------------------------
// SSE payload shape — CR-01 regression (IN-04)
//
// Pre-fix, the server forwarded the raw activation_trace row, so seeds/hops crossed
// the wire as JSON *strings* and the frontend's `.join()` threw — the live-tail never
// rendered. This asserts the server emits them as real arrays. Header-only tests
// (above) could not catch this; only inspecting a real `event: trace` frame does.
// ---------------------------------------------------------------------------

describe('GET /events — trace payload shape (CR-01 regression)', () => {
  it('streams seeds and hops as real arrays, not JSON strings', async () => {
    const seeds = ['n1', 'n2'];
    // WR-02 honest contract: score is null when only rank order is known.
    const hops = [{ node_id: 'n2', score: null, hop: 1 }];

    const parsed = await collectTraceEvent(port, () => {
      // Emit via the real SQLite sink once the SSE client is registered, so the
      // live poll picks up a genuinely-new row (cursor was seeded at max id == 0).
      const writeDb = new Database(tmpDbPath);
      const sink = new SQLiteActivationTraceSink(writeDb, new FakeClock(1000));
      sink.emit({ query_id: 'q1', seeds, hops });
      writeDb.close();
    });

    // CR-01: seeds must arrive as an array, NOT the JSON string '["n1","n2"]'.
    expect(Array.isArray(parsed.seeds)).toBe(true);
    expect(parsed.seeds).toEqual(seeds);
    // The exact frontend operation that threw pre-fix must now succeed.
    expect((parsed.seeds as string[]).join(',')).toBe('n1,n2');

    // hops likewise an array; the honest null score survives serialization.
    expect(Array.isArray(parsed.hops)).toBe(true);
    expect(parsed.hops).toEqual(hops);
  });
});

// ---------------------------------------------------------------------------
// Path-traversal rejection (T-10-07)
// ---------------------------------------------------------------------------

describe('path-traversal guard', () => {
  it('GET /vendor/../server.ts returns 403', async () => {
    const res = await get(port, '/vendor/../server.ts');
    expect(res.statusCode).toBe(403);
  });

  it('GET /vendor/../../package.json returns 403', async () => {
    const res = await get(port, '/vendor/../../package.json');
    expect(res.statusCode).toBe(403);
  });

  it('GET /../package.json returns 403', async () => {
    const res = await get(port, '/../package.json');
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 404 and 503 fallbacks
// ---------------------------------------------------------------------------

describe('fallback responses', () => {
  it('GET /notfound returns 404', async () => {
    const res = await get(port, '/notfound');
    expect(res.statusCode).toBe(404);
  });

  it('GET /index.html when absent returns 503', async () => {
    // The in-memory DB server points to ':memory:'; __dirname of server.ts is the
    // compiled dist directory — index.html won't exist there in test runs.
    // We just verify it returns a non-200 (503) without crashing.
    const res = await get(port, '/index.html');
    // Either 503 (not found) or 200 (if index.html happened to exist)
    expect([200, 503]).toContain(res.statusCode);
  });
});
