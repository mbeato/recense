/**
 * clients/telegram/tests/memory-client-hitl.test.ts
 *
 * Tests for hitlEpisode() — the source:'hitl' audit-episode writer (H-12 / ACT-03).
 *
 * Key invariants tested:
 *   - POST target is /v1/add (episodic-only; never a node-write path — D-43)
 *   - origin matches /^hitl:/ (e.g. hitl:approve, hitl:reject, hitl:execute)
 *   - body.content contains tool name and a serialized arg value
 *   - body.content does NOT contain the serve Bearer token (H-13 / T-13-05)
 *   - all four canonical decision types round-trip the correct origin suffix
 *
 * Uses a real mock HTTP server (mirrors memory-client-surface.test.ts pattern).
 * No imports from ../../src/ — CLIENT-01 structural guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { createMemoryClient } from '../memory-client';

// ---------------------------------------------------------------------------
// Mock server helpers
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

let mockServer: http.Server;
let mockPort: number;

/** Body of the last POST /v1/add received by the mock server. */
let lastAddBody: Record<string, unknown>;
/** Number of POST /v1/add requests received. */
let addRequestCount: number;
/** Last Authorization header received. */
let lastAuthHeader: string;

beforeEach(async () => {
  lastAddBody = {};
  addRequestCount = 0;
  lastAuthHeader = '';

  mockPort = await getFreePort();
  mockServer = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/add') {
      addRequestCount++;
      lastAuthHeader = req.headers['authorization'] ?? '';
      let data = '';
      req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      req.on('end', () => {
        try { lastAddBody = JSON.parse(data) as Record<string, unknown>; } catch { lastAddBody = {}; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(r => mockServer.listen(mockPort, '127.0.0.1', r));
});

afterEach(async () => {
  await new Promise<void>(r => mockServer.close(() => r()));
});

// ---------------------------------------------------------------------------
// Basic POST target and origin format
// ---------------------------------------------------------------------------

describe('hitlEpisode() — POST /v1/add', () => {
  it('calls POST /v1/add (episodic-only path — D-43)', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await client.hitlEpisode({ decision: 'approve', tool: 'send_email', args: { to: 'alice@example.com' } });
    expect(addRequestCount).toBe(1);
  });

  it('origin starts with "hitl:" for approve decision', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await client.hitlEpisode({ decision: 'approve', tool: 'send_email', args: { to: 'alice@example.com' } });
    expect(typeof lastAddBody['origin']).toBe('string');
    expect((lastAddBody['origin'] as string)).toMatch(/^hitl:/);
  });

  it('origin is "hitl:approve" for approve decision', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await client.hitlEpisode({ decision: 'approve', tool: 'send_email', args: {} });
    expect(lastAddBody['origin']).toBe('hitl:approve');
  });

  it('origin is "hitl:reject" for reject decision', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await client.hitlEpisode({ decision: 'reject' });
    expect(lastAddBody['origin']).toBe('hitl:reject');
  });

  it('origin is "hitl:snooze" for snooze decision', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await client.hitlEpisode({ decision: 'snooze' });
    expect(lastAddBody['origin']).toBe('hitl:snooze');
  });

  it('origin is "hitl:execute" for execute decision', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await client.hitlEpisode({ decision: 'execute', tool: 'run_script', args: { script: 'backup.sh' } });
    expect(lastAddBody['origin']).toBe('hitl:execute');
  });

  it('origin is "hitl:edit" for edit decision', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await client.hitlEpisode({ decision: 'edit' });
    expect(lastAddBody['origin']).toBe('hitl:edit');
  });
});

// ---------------------------------------------------------------------------
// content field: tool name + arg value present, token absent
// ---------------------------------------------------------------------------

describe('hitlEpisode() — content field', () => {
  it('content is a string', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await client.hitlEpisode({ decision: 'approve', tool: 'send_email', args: { to: 'alice@example.com' } });
    expect(typeof lastAddBody['content']).toBe('string');
  });

  it('content contains the tool name', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await client.hitlEpisode({ decision: 'approve', tool: 'send_email', args: { to: 'bob@example.com' } });
    expect((lastAddBody['content'] as string)).toContain('send_email');
  });

  it('content contains a serialized arg value', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await client.hitlEpisode({ decision: 'approve', tool: 'send_email', args: { to: 'carol@example.com' } });
    expect((lastAddBody['content'] as string)).toContain('carol@example.com');
  });

  it('content does NOT contain the serve Bearer token (H-13)', async () => {
    const secretToken = 'SUPER_SECRET_SERVE_TOKEN_DO_NOT_LOG';
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, secretToken);
    await client.hitlEpisode({ decision: 'approve', tool: 'send_email', args: { to: 'alice@example.com' } });
    expect((lastAddBody['content'] as string)).not.toContain(secretToken);
  });

  it('content contains the serverName when provided', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await client.hitlEpisode({ decision: 'execute', tool: 'run_job', args: {}, serverName: 'my-mcp-server' });
    expect((lastAddBody['content'] as string)).toContain('my-mcp-server');
  });

  it('content mentions isError flag when true', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await client.hitlEpisode({ decision: 'execute', tool: 'run_job', args: {}, isError: true });
    expect((lastAddBody['content'] as string)).toMatch(/error|failed|isError/i);
  });

  it('content includes truncated result when provided', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'test-serve-token');
    await client.hitlEpisode({
      decision: 'execute',
      tool: 'run_job',
      args: {},
      result: 'Job completed successfully in 3.2s',
    });
    expect((lastAddBody['content'] as string)).toContain('Job completed');
  });
});

// ---------------------------------------------------------------------------
// Auth header is sent (serve token in Authorization header, not in content)
// ---------------------------------------------------------------------------

describe('hitlEpisode() — auth header', () => {
  it('sends Authorization: Bearer <token> header', async () => {
    const client = createMemoryClient(`http://127.0.0.1:${mockPort}`, 'my-serve-token');
    await client.hitlEpisode({ decision: 'approve' });
    expect(lastAuthHeader).toBe('Bearer my-serve-token');
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('hitlEpisode() — error handling', () => {
  it('rejects when serve returns non-2xx', async () => {
    const p404 = await getFreePort();
    const srv404 = http.createServer((_req, res) => { res.writeHead(503); res.end(); });
    await new Promise<void>(r => srv404.listen(p404, '127.0.0.1', r));

    const client = createMemoryClient(`http://127.0.0.1:${p404}`, 'token');
    await expect(client.hitlEpisode({ decision: 'approve' })).rejects.toThrow('serve HTTP 503');
    await new Promise<void>(r => srv404.close(() => r()));
  });
});
