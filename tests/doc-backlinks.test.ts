/**
 * Tests for GET /doc/backlinks?slug= and GET /doc/backlinks?fact= endpoints (39-01 Task 1).
 *
 * Coverage:
 *   - Doc view: returns incoming doc_link/doc_reference/doc_containment edges for a slug
 *   - Doc view: returns 200 with backlinks:[] when no incoming wiki-meaningful edges
 *   - Atom/fact view: returns citedByDocs for docs that cite the fact via 'cites' edge
 *   - Returns 404 for unknown slug
 *   - Returns 400 for empty slug param
 *   - Returns 403 for bad Host header (loopback guard inherited)
 *   - Engine edge kinds (derived_from, abstracts) do NOT appear in backlinks (D-06)
 *   - Route is read-only: exactly 1 new Database() in server.ts
 *
 * IMPORTANT: uses a TEMP throwaway DB; never touches ~/.config/recense/recense.db.
 * No live generation in tests — spawn is mocked.
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
// Mock child_process.spawn so no real CLI is invoked
// ---------------------------------------------------------------------------
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
    on: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `backlinks-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

const T0 = 1_000_000;

// Doc A is the target (receives incoming links)
const DOC_A_SLUG = 'doc-a';
const DOC_A_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// Doc B links TO doc A (doc_link edge B→A)
const DOC_B_SLUG = 'doc-b';
const DOC_B_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// Doc C has no incoming links — used to test empty backlinks case
const DOC_C_SLUG = 'doc-c';
const DOC_C_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// A fact/atom cited by Doc A (cites edge A→F)
const FACT_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

let server: http.Server;
let port: number;
let tmpDbPath: string;

beforeEach(async () => {
  port = await getFreePort();
  tmpDbPath = makeTempDbPath();

  // Write-enabled DB: seed doc nodes + edges.
  const writeDb = new Database(tmpDbPath);
  writeDb.pragma('foreign_keys = ON');
  initSchema(writeDb);

  const clock = new FakeClock(T0);
  const store = new SemanticStore(writeDb, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });

  // Doc A — the target doc that receives incoming links
  store.upsertNode({
    id: DOC_A_ID,
    type: 'doc',
    value: '# Doc A\n\nContent.',
    origin: 'inferred',
    s: 0,
    c: 1.0,
    last_access: T0,
  });
  store.upsertNodeDoc({ node_id: DOC_A_ID, slug: DOC_A_SLUG, generated_at: T0, updated_at: T0 });
  store.upsertNodeScope({ node_id: DOC_A_ID, scope: DOC_A_SLUG, updated_at: T0 });

  // Doc B — links to Doc A via doc_link edge
  store.upsertNode({
    id: DOC_B_ID,
    type: 'doc',
    value: '# Doc B\n\nLinks to A.',
    origin: 'inferred',
    s: 0,
    c: 1.0,
    last_access: T0,
  });
  store.upsertNodeDoc({ node_id: DOC_B_ID, slug: DOC_B_SLUG, generated_at: T0, updated_at: T0 });
  store.upsertNodeScope({ node_id: DOC_B_ID, scope: DOC_B_SLUG, updated_at: T0 });

  // Doc C — isolated doc with no incoming wiki edges
  store.upsertNode({
    id: DOC_C_ID,
    type: 'doc',
    value: '# Doc C\n\nIsolated.',
    origin: 'inferred',
    s: 0,
    c: 1.0,
    last_access: T0,
  });
  store.upsertNodeDoc({ node_id: DOC_C_ID, slug: DOC_C_SLUG, generated_at: T0, updated_at: T0 });
  store.upsertNodeScope({ node_id: DOC_C_ID, scope: DOC_C_SLUG, updated_at: T0 });

  // Fact F — cited by Doc A
  store.upsertNode({
    id: FACT_ID,
    type: 'fact',
    value: 'Some important fact.',
    origin: 'observed',
    s: 0.5,
    c: 0.8,
    last_access: T0,
  });

  // Edge: B → A (doc_link) — this is the backlink we test for
  store.upsertEdge({ src: DOC_B_ID, dst: DOC_A_ID, rel: 'links', kind: 'doc_link', w: 1.0, last_access: T0 });

  // Edge: A → F (cites) — for the atom reverse-cites test
  store.upsertEdge({ src: DOC_A_ID, dst: FACT_ID, rel: 'cites', kind: 'cites', w: 1.0, last_access: T0 });

  // Engine-internal edge: A → B (derived_from) — must NOT appear in backlinks (D-06)
  store.upsertEdge({ src: DOC_A_ID, dst: DOC_B_ID, rel: 'derived_from', kind: 'derived_from', w: 1.0, last_access: T0 });

  writeDb.close();

  server = startVizServer(tmpDbPath, port);
  await new Promise<void>(r => server.listening ? r() : server.once('listening', r));
});

afterEach(async () => {
  await new Promise<void>(r => server.close(() => r()));
  try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests — doc view (slug param)
// ---------------------------------------------------------------------------

describe('GET /doc/backlinks?slug= (doc view)', () => {
  it('returns 200 with backlinks containing the linking doc when there are incoming doc_link edges', async () => {
    const r = await makeRequest(port, `/doc/backlinks?slug=${DOC_A_SLUG}`);
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as { backlinks: Array<{ srcId: string; slug: string; label: string; kind: string }> };
    expect(Array.isArray(json.backlinks)).toBe(true);
    const entry = json.backlinks.find(b => b.srcId === DOC_B_ID);
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('doc_link');
    expect(entry!.slug).toBe(DOC_B_SLUG);
  });

  it('returns 200 with backlinks:[] for a doc with no incoming wiki-meaningful edges', async () => {
    const r = await makeRequest(port, `/doc/backlinks?slug=${DOC_C_SLUG}`);
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as { backlinks: unknown[] };
    expect(Array.isArray(json.backlinks)).toBe(true);
    expect(json.backlinks).toHaveLength(0);
  });

  it('excludes engine edge kinds (derived_from) from backlinks (D-06)', async () => {
    // Doc A has an outgoing derived_from → Doc B. But Doc B's backlinks (incoming to B)
    // from A should NOT include derived_from edges. Similarly, Doc A's backlinks from B
    // only include doc_link (not derived_from from the A→B direction).
    const r = await makeRequest(port, `/doc/backlinks?slug=${DOC_B_SLUG}`);
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as { backlinks: Array<{ kind: string }> };
    const engineEdges = json.backlinks.filter(b => b.kind === 'derived_from' || b.kind === 'abstracts');
    expect(engineEdges).toHaveLength(0);
  });

  it('returns 404 for an unknown slug', async () => {
    const r = await makeRequest(port, '/doc/backlinks?slug=does-not-exist');
    expect(r.statusCode).toBe(404);
  });

  it('returns 400 for empty slug param', async () => {
    const r = await makeRequest(port, '/doc/backlinks?slug=');
    expect(r.statusCode).toBe(400);
  });

  it('returns 400 for missing slug param (no fact param either)', async () => {
    const r = await makeRequest(port, '/doc/backlinks');
    expect(r.statusCode).toBe(400);
  });

  it('returns 403 for mismatched Host header (loopback guard inherited)', async () => {
    const r = await makeRequest(port, `/doc/backlinks?slug=${DOC_A_SLUG}`, 'GET', 'attacker.com');
    expect(r.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Tests — atom/fact view (fact param)
// ---------------------------------------------------------------------------

describe('GET /doc/backlinks?fact= (atom view)', () => {
  it('returns 200 with citedByDocs containing the doc that cites the fact', async () => {
    const r = await makeRequest(port, `/doc/backlinks?fact=${FACT_ID}`);
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as { citedByDocs: Array<{ srcId: string; slug: string; label: string }> };
    expect(Array.isArray(json.citedByDocs)).toBe(true);
    const entry = json.citedByDocs.find(d => d.srcId === DOC_A_ID);
    expect(entry).toBeDefined();
    expect(entry!.slug).toBe(DOC_A_SLUG);
  });

  it('returns 200 with citedByDocs:[] for a fact with no citing docs', async () => {
    // Insert an uncited fact via SemanticStore (which handles value_hash etc.)
    const writeDb = new Database(tmpDbPath);
    writeDb.pragma('foreign_keys = ON');
    const clock = new FakeClock(T0);
    const store2 = new SemanticStore(writeDb, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });
    const uncitedId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    store2.upsertNode({
      id: uncitedId,
      type: 'fact',
      value: 'uncited fact',
      origin: 'observed',
      s: 0.5,
      c: 0.8,
      last_access: T0,
    });
    writeDb.close();

    const r = await makeRequest(port, `/doc/backlinks?fact=${uncitedId}`);
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as { citedByDocs: unknown[] };
    expect(Array.isArray(json.citedByDocs)).toBe(true);
    expect(json.citedByDocs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Source assertions
// ---------------------------------------------------------------------------

describe('Source assertions', () => {
  it('/doc/backlinks route exists in server.ts', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/server.ts'),
      'utf8',
    );
    expect(src).toContain('/doc/backlinks');
  });

  it('stmtDocBacklinks prepared statement exists in server.ts (compiled once at construction)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/server.ts'),
      'utf8',
    );
    expect(src).toContain('stmtDocBacklinks');
  });

  it('backlinks filter contains all three wiki-meaningful edge kinds (D-06)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/server.ts'),
      'utf8',
    );
    expect(src).toContain("'doc_link'");
    expect(src).toContain("'doc_reference'");
    expect(src).toContain("'doc_containment'");
  });

  it('server.ts opens exactly 1 new Database (read-only invariant, WIKI-03)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/server.ts'),
      'utf8',
    );
    // Count non-comment occurrences of 'new Database'
    const uncommented = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const matches = uncommented.match(/new Database/g);
    expect(matches).toHaveLength(1);
  });
});
