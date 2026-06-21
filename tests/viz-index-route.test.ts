/**
 * Tests for GET /index endpoint (39-02 Task 1, WIKI-01).
 *
 * Coverage:
 *   - Returns 200 with { projects: [...], schemas: [...] }
 *   - A project-scoped doc (slug 'tonos') appears under projects, not schemas
 *   - UUID-slug schema-anchored docs appear under schemas with human label (D-04)
 *   - A schema doc whose backing schema node is missing still appears (label falls back to slug)
 *   - Each entry includes { slug, label, id }
 *   - Route takes no params (returns all docs)
 *   - No new Database opened (read-only invariant, T-39-07)
 *   - Returns 403 for bad Host header (loopback guard inherited)
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
  return path.join(os.tmpdir(), `index-route-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

// Project-scoped doc: slug is a human string ('tonos')
const PROJECT_DOC_ID   = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PROJECT_DOC_SLUG = 'tonos';

// Schema-anchored doc 1: slug is a UUID, schema node provides human label
const SCHEMA_UUID_1    = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SCHEMA_DOC_ID_1  = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SCHEMA_LABEL_1   = 'performance goals';

// Schema-anchored doc 2: slug is a UUID, no backing schema node → label falls back to slug
const SCHEMA_UUID_2    = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const SCHEMA_DOC_ID_2  = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
// (no schema node created for SCHEMA_UUID_2)

let server: http.Server;
let port: number;
let tmpDbPath: string;

beforeEach(async () => {
  port = await getFreePort();
  tmpDbPath = makeTempDbPath();

  const writeDb = new Database(tmpDbPath);
  writeDb.pragma('foreign_keys = ON');
  initSchema(writeDb);

  const clock = new FakeClock(T0);
  const store = new SemanticStore(writeDb, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });

  // ── Project-scoped doc: slug = 'tonos' (human-readable) ──────────────────
  store.upsertNode({
    id: PROJECT_DOC_ID,
    type: 'doc',
    value: '# Tonos\n\nProject deep-dive.',
    origin: 'inferred',
    s: 0,
    c: 1.0,
    last_access: T0,
  });
  store.upsertNodeDoc({ node_id: PROJECT_DOC_ID, slug: PROJECT_DOC_SLUG, generated_at: T0, updated_at: T0 });
  store.upsertNodeScope({ node_id: PROJECT_DOC_ID, scope: PROJECT_DOC_SLUG, updated_at: T0 });

  // ── Schema-anchored doc 1: slug = UUID, schema node exists → human label ──
  // The schema node must have id = SCHEMA_UUID_1 and type='schema'
  store.upsertNode({
    id: SCHEMA_UUID_1,
    type: 'schema',
    value: SCHEMA_LABEL_1,
    origin: 'observed',
    s: 0.5,
    c: 0.8,
    last_access: T0,
  });
  store.upsertNode({
    id: SCHEMA_DOC_ID_1,
    type: 'doc',
    value: '# Performance Goals\n\nSchema deep-dive.',
    origin: 'inferred',
    s: 0,
    c: 1.0,
    last_access: T0,
  });
  // The slug = SCHEMA_UUID_1 so the stmtDocNodes LEFT JOIN matches it to the schema node
  store.upsertNodeDoc({ node_id: SCHEMA_DOC_ID_1, slug: SCHEMA_UUID_1, generated_at: T0, updated_at: T0 });
  store.upsertNodeScope({ node_id: SCHEMA_DOC_ID_1, scope: SCHEMA_UUID_1, updated_at: T0 });

  // ── Schema-anchored doc 2: slug = UUID, NO schema node → label = slug ─────
  store.upsertNode({
    id: SCHEMA_DOC_ID_2,
    type: 'doc',
    value: '# Orphan Schema Doc\n\nNo backing schema.',
    origin: 'inferred',
    s: 0,
    c: 1.0,
    last_access: T0,
  });
  store.upsertNodeDoc({ node_id: SCHEMA_DOC_ID_2, slug: SCHEMA_UUID_2, generated_at: T0, updated_at: T0 });
  store.upsertNodeScope({ node_id: SCHEMA_DOC_ID_2, scope: SCHEMA_UUID_2, updated_at: T0 });

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
// Tests
// ---------------------------------------------------------------------------

describe('GET /index', () => {
  it('returns 200 with projects and schemas arrays', async () => {
    const r = await makeRequest(port, '/index');
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as { projects: unknown[]; schemas: unknown[] };
    expect(Array.isArray(json.projects)).toBe(true);
    expect(Array.isArray(json.schemas)).toBe(true);
  });

  it('returns JSON content-type', async () => {
    const r = await makeRequest(port, '/index');
    expect(r.headers['content-type']).toContain('application/json');
  });

  it('places the project-scoped doc (slug "tonos") under projects, not schemas', async () => {
    const r = await makeRequest(port, '/index');
    const json = JSON.parse(r.body) as {
      projects: Array<{ slug: string; label: string; id: string }>;
      schemas: Array<{ slug: string; label: string; id: string }>;
    };
    const inProjects = json.projects.some(e => e.slug === PROJECT_DOC_SLUG);
    const inSchemas = json.schemas.some(e => e.slug === PROJECT_DOC_SLUG);
    expect(inProjects).toBe(true);
    expect(inSchemas).toBe(false);
  });

  it('places UUID-slug docs under schemas, not projects', async () => {
    const r = await makeRequest(port, '/index');
    const json = JSON.parse(r.body) as {
      projects: Array<{ slug: string; label: string; id: string }>;
      schemas: Array<{ slug: string; label: string; id: string }>;
    };
    const s1InSchemas = json.schemas.some(e => e.slug === SCHEMA_UUID_1);
    const s2InSchemas = json.schemas.some(e => e.slug === SCHEMA_UUID_2);
    const s1InProjects = json.projects.some(e => e.slug === SCHEMA_UUID_1);
    expect(s1InSchemas).toBe(true);
    expect(s2InSchemas).toBe(true);
    expect(s1InProjects).toBe(false);
  });

  it('resolves schema doc label to the human schema value (D-04), not the raw UUID', async () => {
    const r = await makeRequest(port, '/index');
    const json = JSON.parse(r.body) as {
      schemas: Array<{ slug: string; label: string; id: string }>;
    };
    const entry = json.schemas.find(e => e.slug === SCHEMA_UUID_1);
    expect(entry).toBeDefined();
    expect(entry!.label).toBe(SCHEMA_LABEL_1);
    expect(entry!.label).not.toBe(SCHEMA_UUID_1);
  });

  it('falls back to slug as label when backing schema node is missing', async () => {
    const r = await makeRequest(port, '/index');
    const json = JSON.parse(r.body) as {
      schemas: Array<{ slug: string; label: string; id: string }>;
    };
    const entry = json.schemas.find(e => e.slug === SCHEMA_UUID_2);
    expect(entry).toBeDefined();
    // No schema node → COALESCE falls back to slug
    expect(entry!.label).toBe(SCHEMA_UUID_2);
  });

  it('each entry includes slug, label, and id fields', async () => {
    const r = await makeRequest(port, '/index');
    const json = JSON.parse(r.body) as {
      projects: Array<{ slug: string; label: string; id: string }>;
      schemas: Array<{ slug: string; label: string; id: string }>;
    };
    for (const entry of [...json.projects, ...json.schemas]) {
      expect(typeof entry.slug).toBe('string');
      expect(typeof entry.label).toBe('string');
      expect(typeof entry.id).toBe('string');
    }
  });

  it('includes all three seeded docs (1 project + 2 schemas)', async () => {
    const r = await makeRequest(port, '/index');
    const json = JSON.parse(r.body) as {
      projects: Array<{ slug: string }>;
      schemas: Array<{ slug: string }>;
    };
    expect(json.projects.length).toBeGreaterThanOrEqual(1);
    expect(json.schemas.length).toBeGreaterThanOrEqual(2);
    expect(json.projects.some(e => e.slug === PROJECT_DOC_SLUG)).toBe(true);
    expect(json.schemas.some(e => e.slug === SCHEMA_UUID_1)).toBe(true);
    expect(json.schemas.some(e => e.slug === SCHEMA_UUID_2)).toBe(true);
  });

  it('returns 403 for mismatched Host header (loopback guard inherited)', async () => {
    const r = await makeRequest(port, '/index', 'GET', 'attacker.com');
    expect(r.statusCode).toBe(403);
  });
});

describe('Source assertions', () => {
  it('/index route exists in server.ts', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/server.ts'),
      'utf8',
    );
    expect(src).toContain('/index');
  });

  it('server.ts has exactly 1 new Database() call (read-only invariant, T-39-07)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/server.ts'),
      'utf8',
    );
    // Strip comment lines before counting (grep -v '^[[:space:]]*//')
    const nonCommentLines = src.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
    const matches = nonCommentLines.match(/new Database/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(1);
  });

  it('/index handler reuses stmtDocNodes (not a new db.prepare inside the handler)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/server.ts'),
      'utf8',
    );
    // stmtDocNodes is the pre-compiled statement; verify it appears in server.ts
    expect(src).toContain('stmtDocNodes');
    // The handler for /index should reference stmtDocNodes.all() (not db.prepare inside)
    const indexHandlerMatch = src.match(/\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/\s*if\s*\(url\s*===\s*['"]\/index['"]\)[\s\S]{0,1000}/);
    if (indexHandlerMatch) {
      // If we found the /index block, ensure it doesn't re-prepare stmtDocNodes inline
      expect(indexHandlerMatch[0]).not.toContain('db.prepare');
    }
  });
});
