/**
 * Tests for GET /doc/staleness?slug= endpoint (27-04 Task 1, READER-03).
 *
 * Coverage:
 *   - Returns {generated_at, stale:[{factId,prev_value,value}], tombstoned:[...]}
 *   - Changed fact (last_access > generated_at + prev_value set) appears in `stale`
 *   - Tombstoned cited fact appears in `tombstoned`
 *   - Unchanged fact (last_access <= generated_at) excluded from both lists
 *   - Returns 404 for unknown slug
 *   - Returns 400 for empty slug param
 *   - Returns 403 for bad Host header (loopback guard inherited)
 *   - Route uses kind='cites' reverse lookup (grep verified below)
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
  return path.join(os.tmpdir(), `staleness-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

// Time constants (epoch ms)
const T0 = 1_000_000;   // doc generated_at baseline
const T_BEFORE = T0 - 1000;   // last_access before T0 → unchanged
const T_AFTER = T0 + 5000;    // last_access after T0 → stale

const DOC_SLUG = 'staleness-test';
const DOC_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const FACT_UNCHANGED_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const FACT_CHANGED_ID   = 'bbbbbbbb-0000-0000-0000-000000000002';
const FACT_TOMBSTONED_ID = 'cccccccc-0000-0000-0000-000000000003';

let server: http.Server;
let port: number;
let tmpDbPath: string;

beforeEach(async () => {
  port = await getFreePort();
  tmpDbPath = makeTempDbPath();

  // Write-enabled DB: seed doc node + three cited facts.
  const writeDb = new Database(tmpDbPath);
  writeDb.pragma('foreign_keys = ON');
  initSchema(writeDb);

  const clock = new FakeClock(T0);
  const store = new SemanticStore(writeDb, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });

  // Fact 1: unchanged — last_access = T_BEFORE (< T0), so NOT stale.
  store.upsertNode({
    id: FACT_UNCHANGED_ID,
    type: 'fact',
    value: 'unchanged fact value',
    origin: 'observed',
    s: 0.5,
    c: 0.8,
    last_access: T_BEFORE,
  });

  // Fact 2: changed — last_access = T_AFTER (> T0) + prev_value set via direct SQL.
  store.upsertNode({
    id: FACT_CHANGED_ID,
    type: 'fact',
    value: 'updated fact value (current)',
    origin: 'observed',
    s: 0.5,
    c: 0.8,
    last_access: T_AFTER,
  });
  // Set prev_value directly (SemanticStore.upsertNode does not expose prev_value param)
  writeDb.prepare('UPDATE node SET prev_value = ? WHERE id = ?')
    .run('original fact value (before change)', FACT_CHANGED_ID);

  // Fact 3: tombstoned — last_access doesn't matter; tombstoned=1 is the signal.
  store.upsertNode({
    id: FACT_TOMBSTONED_ID,
    type: 'fact',
    value: 'tombstoned fact value',
    origin: 'observed',
    s: 0.5,
    c: 0.8,
    last_access: T_BEFORE,
  });
  writeDb.prepare('UPDATE node SET tombstoned = 1 WHERE id = ?')
    .run(FACT_TOMBSTONED_ID);

  // Doc node at generated_at = T0.
  store.upsertNode({
    id: DOC_ID,
    type: 'doc',
    value: '# Doc\n\nSome prose.',
    origin: 'inferred',
    s: 0,
    c: 1.0,
    last_access: T0,
  });
  store.upsertNodeDoc({ node_id: DOC_ID, slug: DOC_SLUG, generated_at: T0, updated_at: T0 });
  store.upsertNodeScope({ node_id: DOC_ID, scope: DOC_SLUG, updated_at: T0 });

  // Cites edges: doc → all three facts.
  store.upsertEdge({ src: DOC_ID, dst: FACT_UNCHANGED_ID, rel: 'cites', kind: 'cites', w: 1.0, last_access: T0 });
  store.upsertEdge({ src: DOC_ID, dst: FACT_CHANGED_ID,   rel: 'cites', kind: 'cites', w: 1.0, last_access: T0 });
  store.upsertEdge({ src: DOC_ID, dst: FACT_TOMBSTONED_ID, rel: 'cites', kind: 'cites', w: 1.0, last_access: T0 });

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

describe('GET /doc/staleness?slug=', () => {
  it('returns 200 with generated_at from the doc node_doc row', async () => {
    const r = await makeRequest(port, `/doc/staleness?slug=${DOC_SLUG}`);
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as { generated_at: number; stale: unknown[]; tombstoned: unknown[] };
    expect(json.generated_at).toBe(T0);
  });

  it('includes changed fact in stale with prev_value and current value', async () => {
    const r = await makeRequest(port, `/doc/staleness?slug=${DOC_SLUG}`);
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as {
      generated_at: number;
      stale: Array<{ factId: string; prev_value: string | null; value: string }>;
      tombstoned: string[];
    };
    const staleEntry = json.stale.find(s => s.factId === FACT_CHANGED_ID);
    expect(staleEntry).toBeDefined();
    expect(staleEntry!.prev_value).toBe('original fact value (before change)');
    expect(staleEntry!.value).toBe('updated fact value (current)');
  });

  it('includes tombstoned cited fact id in tombstoned list', async () => {
    const r = await makeRequest(port, `/doc/staleness?slug=${DOC_SLUG}`);
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as { tombstoned: string[] };
    expect(json.tombstoned).toContain(FACT_TOMBSTONED_ID);
  });

  it('excludes the unchanged fact (last_access <= generated_at) from both lists', async () => {
    const r = await makeRequest(port, `/doc/staleness?slug=${DOC_SLUG}`);
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as {
      stale: Array<{ factId: string }>;
      tombstoned: string[];
    };
    const inStale = json.stale.some(s => s.factId === FACT_UNCHANGED_ID);
    const inTombstoned = json.tombstoned.includes(FACT_UNCHANGED_ID);
    expect(inStale).toBe(false);
    expect(inTombstoned).toBe(false);
  });

  it('returns 404 for an unknown slug', async () => {
    const r = await makeRequest(port, '/doc/staleness?slug=does-not-exist');
    expect(r.statusCode).toBe(404);
    const json = JSON.parse(r.body) as { error: string };
    expect(json.error).toContain('no doc');
  });

  it('returns 400 for empty slug param', async () => {
    const r = await makeRequest(port, '/doc/staleness?slug=');
    expect(r.statusCode).toBe(400);
  });

  it('returns 400 for missing slug param', async () => {
    const r = await makeRequest(port, '/doc/staleness');
    expect(r.statusCode).toBe(400);
  });

  it('returns 403 for mismatched Host header (loopback guard inherited)', async () => {
    const r = await makeRequest(port, `/doc/staleness?slug=${DOC_SLUG}`, 'GET', 'attacker.com');
    expect(r.statusCode).toBe(403);
  });
});

describe('Source assertions', () => {
  it('/doc/staleness route exists in server.ts', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/server.ts'),
      'utf8',
    );
    expect(src).toContain('/doc/staleness');
  });

  it('server.ts uses kind="cites" reverse lookup for staleness', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/server.ts'),
      'utf8',
    );
    // Must reference kind = 'cites' (the cites reverse lookup)
    expect(src).toMatch(/kind\s*=\s*'cites'/);
  });
});
