/**
 * Tests for GET /graph?type=doc corpus endpoint (27-05 Task 2, READER-04).
 *
 * Coverage:
 *   - GET /graph?type=doc returns only doc nodes and only doc_link links
 *   - GET /graph?type=doc excludes fact/entity nodes and cites/relation links
 *   - GET /graph (no filter) still returns all nodes and all edges
 *   - GET /graph?type=doc with no doc nodes returns {nodes:[], links:[]}
 *   - Source assertions: type='doc' filter and kind='doc_link' filter present in server.ts
 *   - Source assertions: #btn-corpus in reader.js, index.html, styles.css (expanded-only gate)
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
import { writeDoc } from '../src/consolidation/doc-writer';
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
  return path.join(os.tmpdir(), `corpus-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

function makeRequest(port: number, urlPath: string): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'GET',
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function makeStore(db: Database.Database): SemanticStore {
  const clock = new FakeClock(1000);
  return new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: ':memory:' });
}

function seedFact(store: SemanticStore, id: string): void {
  store.upsertNode({
    id,
    type: 'fact',
    value: `Fact ${id} text`,
    origin: 'observed',
    s: 0.5,
    c: 0.8,
    last_access: 500,
  });
}

function seedEntity(store: SemanticStore, id: string): void {
  store.upsertNode({
    id,
    type: 'entity',
    value: `Entity ${id}`,
    origin: 'observed',
    s: 0.5,
    c: 0.8,
    last_access: 500,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /graph?type=doc corpus endpoint (READER-04)', () => {
  let dbPath: string;
  let db: Database.Database;
  let store: SemanticStore;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    dbPath = makeTempDbPath();
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    initSchema(db);
    store = makeStore(db);

    // Seed two fact nodes (for cites edges and general graph population)
    seedFact(store, 'fact-a');
    seedFact(store, 'fact-b');
    seedEntity(store, 'entity-z');

    // Write two doc nodes with a doc_link edge between them
    writeDoc(store, db, {
      docId: 'doc-one',
      slug: 'one',
      markdown: '# Doc One',
      citedFactIds: ['fact-a'],
      linkedDocRefs: ['doc-two'],  // will be skipped since doc-two doesn't exist yet
      now: 1000,
    });
    writeDoc(store, db, {
      docId: 'doc-two',
      slug: 'two',
      markdown: '# Doc Two',
      citedFactIds: ['fact-b'],
      linkedDocRefs: [],
      now: 2000,
    });
    // Manually create a doc_link edge from doc-one to doc-two (since doc-two didn't exist
    // when doc-one was written above — using store to stay single-writer-compliant)
    store.upsertEdge({
      src: 'doc-one',
      dst: 'doc-two',
      rel: 'doc_link',
      kind: 'doc_link',
      w: 1.0,
      last_access: 3000,
    });

    // Also create a relation edge between fact nodes for full-graph verification
    store.upsertEdge({
      src: 'fact-a',
      dst: 'fact-b',
      rel: 'related',
      kind: 'relation',
      w: 0.5,
      last_access: 1000,
    });

    // Close the write DB before the server opens it read-only
    db.close();

    port = await getFreePort();
    server = startVizServer(dbPath, port);
    await new Promise<void>(r => server.once('listening', r));
  });

  afterEach(async () => {
    await new Promise<void>(r => server.close(() => r()));
    try { fs.unlinkSync(dbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* ignore */ }
  });

  it('GET /graph?type=doc returns only doc nodes', async () => {
    const res = await makeRequest(port, '/graph?type=doc');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { nodes: Array<{ id: string; type: string }>; links: unknown[] };
    const nodeIds = data.nodes.map(n => n.id);
    expect(nodeIds).toContain('doc-one');
    expect(nodeIds).toContain('doc-two');
    // Must NOT contain fact or entity nodes
    expect(nodeIds).not.toContain('fact-a');
    expect(nodeIds).not.toContain('fact-b');
    expect(nodeIds).not.toContain('entity-z');
    // All returned nodes are type='doc'
    for (const n of data.nodes) {
      expect(n.type).toBe('doc');
    }
  });

  it('GET /graph?type=doc returns only doc_link edges', async () => {
    const res = await makeRequest(port, '/graph?type=doc');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as {
      nodes: unknown[];
      links: Array<{ source: string; target: string; kind: string }>;
    };
    // All returned links must be kind='doc_link'
    for (const l of data.links) {
      expect(l.kind).toBe('doc_link');
    }
    // The doc-one → doc-two link must appear
    const link = data.links.find(l => l.source === 'doc-one' && l.target === 'doc-two');
    expect(link).toBeDefined();
    // cites edges and relation edges must NOT appear
    const nonDocLinks = data.links.filter(l => l.kind !== 'doc_link');
    expect(nonDocLinks).toHaveLength(0);
  });

  it('GET /graph (no filter) still returns all nodes including facts', async () => {
    const res = await makeRequest(port, '/graph');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as { nodes: Array<{ id: string }>; links: unknown[] };
    const nodeIds = data.nodes.map(n => n.id);
    // Full graph includes both doc nodes AND fact/entity nodes
    expect(nodeIds).toContain('doc-one');
    expect(nodeIds).toContain('fact-a');
    expect(nodeIds).toContain('entity-z');
  });

  it('GET /graph (no filter) still returns all edge kinds including cites', async () => {
    const res = await makeRequest(port, '/graph');
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body) as {
      nodes: unknown[];
      links: Array<{ kind: string }>;
    };
    const kinds = new Set(data.links.map(l => l.kind));
    // Full graph has both 'cites' and 'doc_link' edges
    expect(kinds.has('cites')).toBe(true);
    expect(kinds.has('doc_link')).toBe(true);
    expect(kinds.has('relation')).toBe(true);
  });

  it('GET /graph?type=doc with no doc nodes returns empty nodes and links', async () => {
    // Create a fresh DB with only fact nodes
    const emptyDbPath = makeTempDbPath();
    let emptyDb = new Database(emptyDbPath);
    emptyDb.pragma('foreign_keys = ON');
    initSchema(emptyDb);
    const emptyStore = makeStore(emptyDb);
    seedFact(emptyStore, 'fact-only');
    emptyDb.close();

    const emptyPort = await getFreePort();
    const emptyServer = startVizServer(emptyDbPath, emptyPort);
    await new Promise<void>(r => emptyServer.once('listening', r));

    try {
      const res = await makeRequest(emptyPort, '/graph?type=doc');
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body) as { nodes: unknown[]; links: unknown[] };
      expect(data.nodes).toHaveLength(0);
      expect(data.links).toHaveLength(0);
    } finally {
      await new Promise<void>(r => emptyServer.close(() => r()));
      try { fs.unlinkSync(emptyDbPath); } catch { /* ignore */ }
    }
  });

  // Source assertions

  it('source: server.ts has type=doc filter for corpus endpoint', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/server.ts'),
      'utf8',
    );
    expect(src).toMatch(/type\s*=\s*'doc'/);
    expect(src).toContain('type=doc');
  });

  it('source: server.ts has kind=doc_link filter for corpus endpoint', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/server.ts'),
      'utf8',
    );
    expect(src).toMatch(/kind\s*=\s*'doc_link'/);
  });

  it('source: reader.js has #btn-corpus and /graph?type=doc fetch', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/modules/reader.js'),
      'utf8',
    );
    expect(src).toContain('btn-corpus');
    expect(src).toContain('type=doc');
  });

  it('source: index.html has #btn-corpus button', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/index.html'),
      'utf8',
    );
    expect(src).toContain('btn-corpus');
  });

  it('source: styles.css has expanded-only gate for #btn-corpus', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/viz/css/styles.css'),
      'utf8',
    );
    expect(src).toContain('#btn-corpus');
    expect(src).toContain('.mode-window #btn-corpus');
  });
});
