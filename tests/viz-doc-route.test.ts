/**
 * Tests for the DB-backed /doc, /doc/meta, and POST /doc/generate routes (27-03 Task 1).
 *
 * Coverage:
 *   - GET /doc?slug=<seeded> returns 200 text/plain markdown body
 *   - GET /doc?slug=<missing> returns 202 {status:'generating'} (spawn stubbed)
 *   - GET /doc/meta?slug=<seeded> returns {nodeId, generated_at, citedFactIds:[...]}
 *   - GET /doc/meta?slug=<missing> returns 404
 *   - POST /doc/generate?slug=<slug> returns 202 {status:'generating'}
 *   - Malformed Host header returns 403 (loopback guard)
 *   - GET /doc with no slug param returns 400
 *   - DOC_ROOT file-read path is gone: grep asserts 0 occurrences of DOC_ROOT in server.ts
 *   - spawn is invoked for missing slug (server stays read-only — no write SQL)
 *
 * IMPORTANT: uses a TEMP throwaway DB; never touches ~/.config/recense/recense.db.
 * Spawn is mocked (never triggers real LLM).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { startVizServer } from '../src/viz/server';

// ---------------------------------------------------------------------------
// Mock child_process.spawn so no real CLI is invoked (T-27-10 test isolation)
// ---------------------------------------------------------------------------
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const emitter = {
      unref: vi.fn(),
      on: vi.fn(),
    };
    return emitter;
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `viz-doc-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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
  headers: http.IncomingHttpHeaders;
  body: string;
}

function makeRequest(
  port: number,
  urlPath: string,
  method = 'GET',
  hostOverride?: string,
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: hostOverride ? { host: hostOverride } : undefined,
      },
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
// Fixtures
// ---------------------------------------------------------------------------

const DOC_MARKDOWN = '# Tonos\n\nA deep-dive about [tonos](recense://fact/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa).';
const FACT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FACT2_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const DOC_SLUG = 'tonos';

let server: http.Server;
let port: number;
let tmpDbPath: string;

beforeEach(async () => {
  port = await getFreePort();
  tmpDbPath = makeTempDbPath();

  // Set up the write-enabled DB with a seeded doc node.
  const writeDb = new Database(tmpDbPath);
  writeDb.pragma('foreign_keys = ON');
  initSchema(writeDb);

  const clock = new FakeClock(1000);
  const store = new SemanticStore(writeDb, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });

  // Seed two fact nodes (the doc will cite them).
  store.upsertNode({ id: FACT_ID, type: 'fact', value: 'tonos is a sports platform', origin: 'observed', s: 0.5, c: 0.8, last_access: 900 });
  store.upsertNode({ id: FACT2_ID, type: 'fact', value: 'tonos uses TypeScript', origin: 'observed', s: 0.5, c: 0.8, last_access: 900 });

  // Seed a doc node for DOC_SLUG via store primitives (same path as doc-writer).
  const docId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  store.upsertNode({ id: docId, type: 'doc', value: DOC_MARKDOWN, origin: 'inferred', s: 0, c: 1.0, last_access: 1000 });
  store.upsertNodeDoc({ node_id: docId, slug: DOC_SLUG, generated_at: 1000, updated_at: 1000 });
  store.upsertNodeScope({ node_id: docId, scope: DOC_SLUG, updated_at: 1000 });

  // Seed cites edges: doc → fact1, doc → fact2.
  store.upsertEdge({ src: docId, dst: FACT_ID, rel: 'cites', kind: 'cites', w: 1.0, last_access: 1000 });
  store.upsertEdge({ src: docId, dst: FACT2_ID, rel: 'cites', kind: 'cites', w: 1.0, last_access: 1000 });

  // BUG-2a (28-04): seed an EMPTY stub doc (CorpusPromoter eager placeholder, value='').
  // The route must treat it as a miss → 202 + spawn, not serve an empty 200.
  const stubId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  store.upsertNode({ id: stubId, type: 'doc', value: '', origin: 'inferred', s: 0, c: 1.0, last_access: 1000 });
  store.upsertNodeDoc({ node_id: stubId, slug: 'emptystub', generated_at: 1000, updated_at: 1000 });
  store.upsertNodeScope({ node_id: stubId, scope: 'emptystub', updated_at: 1000 });

  // Regression (2026-06-25): a subject doc whose node_scope is the bare PROJECT ROOT
  // ('vtx') but whose slug is the full 'project:subject' ('vtx:athlete-management').
  // This is the real-world pattern (subject docs scoped to root for coloring/containment);
  // the old scope-keyed resolver could not open it because scope != slug. /doc must key
  // on the slug.
  const subjId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
  store.upsertNode({ id: subjId, type: 'doc', value: '# Athlete Management\n\nbody', origin: 'inferred', s: 0, c: 1.0, last_access: 1000 });
  store.upsertNodeDoc({ node_id: subjId, slug: 'vtx:athlete-management', generated_at: 1000, updated_at: 1000 });
  store.upsertNodeScope({ node_id: subjId, scope: 'vtx', updated_at: 1000 }); // ROOT scope, deliberately != slug

  writeDb.close();

  // Start the viz server (read-only handle).
  server = startVizServer(tmpDbPath, port);
  await new Promise<void>(r => server.listening ? r() : server.once('listening', r));
});

afterEach(async () => {
  await new Promise<void>(r => server.close(() => r()));
  try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /doc?slug=', () => {
  it('returns 200 text/plain markdown for a seeded slug', async () => {
    const r = await makeRequest(port, `/doc?slug=${DOC_SLUG}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/plain');
    expect(r.body).toContain('# Tonos');
    expect(r.body).toContain('recense://fact/');
  });

  it('resolves a subject doc whose node_scope (root) differs from its slug (regression: scope-keyed resolver missed these)', async () => {
    const r = await makeRequest(port, `/doc?slug=${encodeURIComponent('vtx:athlete-management')}`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('# Athlete Management');
  });

  it('returns 202 {status:generating} for a missing slug and triggers spawn', async () => {
    const { spawn } = await import('node:child_process');
    const r = await makeRequest(port, '/doc?slug=unknown-project');
    expect(r.statusCode).toBe(202);
    const json = JSON.parse(r.body) as { status: string };
    expect(json.status).toBe('generating');
    // Verify the CLI was spawned (server stays read-only).
    expect(spawn).toHaveBeenCalled();
  });

  it('returns 202 {status:generating} for an EMPTY stub (not an empty 200) and triggers spawn', async () => {
    const { spawn } = await import('node:child_process');
    const r = await makeRequest(port, '/doc?slug=emptystub');
    expect(r.statusCode).toBe(202);
    const json = JSON.parse(r.body) as { status: string };
    expect(json.status).toBe('generating');
    expect(spawn).toHaveBeenCalled();
  });

  it('202 generating payload carries elapsedMs (server-authoritative progress)', async () => {
    // The reader seeds its progress bar from this elapsedMs so a node reopened mid-generation
    // resumes the real progress instead of restarting at 0s. Contract: a non-negative number.
    const r = await makeRequest(port, '/doc?slug=elapsed-probe');
    expect(r.statusCode).toBe(202);
    const json = JSON.parse(r.body) as { status: string; elapsedMs: number };
    expect(json.status).toBe('generating');
    expect(typeof json.elapsedMs).toBe('number');
    expect(json.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('returns 400 for empty slug param', async () => {
    const r = await makeRequest(port, '/doc?slug=');
    expect(r.statusCode).toBe(400);
  });

  it('returns 400 when slug param is missing', async () => {
    const r = await makeRequest(port, '/doc');
    expect(r.statusCode).toBe(400);
  });

  it('sanitizes slug — strips special chars before DB lookup', async () => {
    // "../../etc/passwd" strips all path separators/dots → "etcpasswd" → DB miss → 202 generating
    // (no file read, no path traversal — server is DB-only, T-27-11)
    const r = await makeRequest(port, '/doc?slug=..%2F..%2Fetc%2Fpasswd');
    // After sanitization "etcpasswd" → no doc in DB → generates
    expect(r.statusCode).toBe(202);
    const json = JSON.parse(r.body) as { status: string };
    expect(json.status).toBe('generating');
  });
});

// READER-04: doc-ref click opens by doc NODE id via ?id= (exact-or-unique-prefix).
const DOC_NODE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
describe('GET /doc?id= (READER-04 doc-ref click)', () => {
  it('returns 200 markdown for an EXACT doc node id', async () => {
    const r = await makeRequest(port, `/doc?id=${DOC_NODE_ID}`);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('# Tonos');
  });

  it('returns 200 markdown for a UNIQUE-PREFIX doc node id (truncated ref)', async () => {
    // The generator may truncate doc ids; an unambiguous 8-char prefix resolves.
    const r = await makeRequest(port, '/doc?id=cccccccc');
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('# Tonos');
  });

  it('returns 404 for an unknown doc id (no generate-on-miss spawn)', async () => {
    const r = await makeRequest(port, '/doc?id=ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(r.statusCode).toBe(404);
  });

  it('/doc/meta?id= resolves the doc and returns its slug + cited ids', async () => {
    const r = await makeRequest(port, `/doc/meta?id=${DOC_NODE_ID}`);
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as { nodeId: string; slug: string; citedFactIds: string[] };
    expect(json.slug).toBe(DOC_SLUG);
    expect(json.citedFactIds).toContain(FACT_ID);
  });

  it('/doc/meta?id= returns 404 for an unknown id', async () => {
    const r = await makeRequest(port, '/doc/meta?id=ffffffff-ffff-4fff-8fff-ffffffffffff');
    expect(r.statusCode).toBe(404);
  });
});

describe('GET /doc/meta?slug=', () => {
  it('returns nodeId, generated_at, and citedFactIds for a seeded slug', async () => {
    const r = await makeRequest(port, `/doc/meta?slug=${DOC_SLUG}`);
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as { nodeId: string; generated_at: number; citedFactIds: string[] };
    expect(typeof json.nodeId).toBe('string');
    expect(typeof json.generated_at).toBe('number');
    expect(Array.isArray(json.citedFactIds)).toBe(true);
    expect(json.citedFactIds).toContain(FACT_ID);
    expect(json.citedFactIds).toContain(FACT2_ID);
  });

  it('returns 404 for an unknown slug', async () => {
    const r = await makeRequest(port, '/doc/meta?slug=no-such-project');
    expect(r.statusCode).toBe(404);
  });

  it('returns 400 for empty slug', async () => {
    const r = await makeRequest(port, '/doc/meta?slug=');
    expect(r.statusCode).toBe(400);
  });
});

describe('POST /doc/generate?slug=', () => {
  it('returns 202 {status:generating} and triggers spawn', async () => {
    const { spawn } = await import('node:child_process');
    const r = await makeRequest(port, `/doc/generate?slug=${DOC_SLUG}`, 'POST');
    expect(r.statusCode).toBe(202);
    const json = JSON.parse(r.body) as { status: string };
    expect(json.status).toBe('generating');
    expect(spawn).toHaveBeenCalled();
  });

  it('returns 400 for empty slug', async () => {
    const r = await makeRequest(port, '/doc/generate?slug=', 'POST');
    expect(r.statusCode).toBe(400);
  });

  // Regenerate flow (RGS-01): after a force-regen is POSTed, the slug is in-flight. A
  // subsequent GET /doc must return 202 so the reader polls and shows the phase stepper —
  // even though the OLD doc row still exists in the DB (the force-regen replaces it only
  // when the CLI finishes). Without this, GET /doc serves the stale doc with 200 and the
  // stepper never appears: the regenerate button just flickers back to the old content.
  it('GET /doc returns 202 (not stale 200) while a force-regen is in flight for a seeded slug', async () => {
    // 1. Sanity: with nothing in flight, the seeded doc serves 200.
    const before = await makeRequest(port, `/doc?slug=${DOC_SLUG}`);
    expect(before.statusCode).toBe(200);
    expect(before.body).toBe(DOC_MARKDOWN);

    // 2. Force-regen: marks the slug in-flight (mocked spawn never fires 'close', so it stays in-flight).
    const post = await makeRequest(port, `/doc/generate?slug=${DOC_SLUG}`, 'POST');
    expect(post.statusCode).toBe(202);

    // 3. GET /doc must now report generating, not re-serve the stale doc.
    const during = await makeRequest(port, `/doc?slug=${DOC_SLUG}`);
    expect(during.statusCode).toBe(202);
    const json = JSON.parse(during.body) as { status: string };
    expect(json.status).toBe('generating');
  });
});

describe('Host-header loopback guard (T-10-09)', () => {
  it('returns 403 for a mismatched Host header on /doc route', async () => {
    const r = await makeRequest(port, `/doc?slug=${DOC_SLUG}`, 'GET', 'attacker.com');
    expect(r.statusCode).toBe(403);
  });

  it('returns 403 for a mismatched Host header on /doc/meta route', async () => {
    const r = await makeRequest(port, `/doc/meta?slug=${DOC_SLUG}`, 'GET', 'evil.example.com');
    expect(r.statusCode).toBe(403);
  });
});

describe('DOC_ROOT file-read path removed (T-27-11)', () => {
  it('server.ts has no DOC_ROOT references (file-backed /doc path removed)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/viz/server.ts'), 'utf8');
    const count = (src.match(/DOC_ROOT/g) ?? []).length;
    expect(count).toBe(0);
  });
});
