/**
 * Behavioral tests for the stdio MCP server (Phase 11, MCP-01/MCP-02, D-11/D-12).
 *
 * Harness: in-process SDK client over InMemoryTransport.createLinkedPair() —
 * no subprocess spawn, no network. MockModelProvider keeps embedding offline.
 * Server opens its own DB via the dbPath override (the standalone-agents proof):
 * ':memory:' for empty-DB cases, a scratch temp-file DB for populated cases.
 *
 * Coverage:
 *   factory       — createBrainMcpServer({ dbPath, provider }) returns a connectable server
 *   tools/list    — exactly three snake_case tools: memory_add, memory_ask, memory_search
 *   memory_search — populated DB returns structured provenance { value, origin, score, lastUpdatedMs }
 *   memory_search — calls provider.embed exactly once, provider.generate zero times (D-08)
 *   memory_search — empty DB returns { results: [] } without error
 *   memory_add    — episodic-only write (no graph mutation, MCP-03), deferred ack (D-10),
 *                   inferred-origin clamp (D-05), lock-held isError without process exit
 *   memory_ask    — { answer, origin } shape (D-09), no-answer → { answer: null, origin: 'none' }
 *
 * Write/compose tests use a temp-file DB (':memory:' is per-connection — a second
 * verification handle could not see the server's writes) and override
 * BRAIN_MEMORY_LOCK_PATH so lock acquisition is hermetic per test dir.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { initSchema } from '../src/db/schema';
import { realClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { MockModelProvider } from '../src/model/provider';
import type { ModelProvider } from '../src/model/provider';
import { newId } from '../src/lib/hash';
import { createBrainMcpServer, validateOrigin } from '../src/adapter/mcp-cli';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SearchRow {
  value: string;
  origin: string;
  score: number;
  lastUpdatedMs: number;
}

/** Connect an in-process SDK client to a freshly built server (Pitfall 5: await both). */
async function connectClient(
  opts: { dbPath: string; provider: ModelProvider },
): Promise<Client> {
  const server = await createBrainMcpServer(opts);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

// ---------------------------------------------------------------------------
// Shared harness — empty ':memory:' DB, deterministic offline embedding
// ---------------------------------------------------------------------------

describe('mcp-server (in-process SDK client)', () => {
  let client: Client;

  beforeEach(async () => {
    // generateScript intentionally empty: any generate() call throws "queue exhausted",
    // so a green memory_search below PROVES the read path never generates (D-08).
    const mock = new MockModelProvider({
      embedFn: () => new Float32Array([0.1, 0.2, 0.3]),
    });
    client = await connectClient({ dbPath: ':memory:', provider: mock });
  });

  afterEach(async () => {
    await client.close();
  });

  it('tools/list returns exactly the three brain tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    expect(names).toEqual(['memory_add', 'memory_ask', 'memory_search']);
  });

  it('memory_search returns a results array on an empty DB', async () => {
    const result = await client.callTool({
      name: 'memory_search',
      arguments: { query: 'anything' },
    });
    expect(result.isError ?? false).toBe(false);
    const structured = result.structuredContent as { results: SearchRow[] };
    expect(Array.isArray(structured.results)).toBe(true);
    expect(structured.results.length).toBe(0);
  });

  it('memory_search makes zero generation calls (empty generateScript stays unexhausted)', async () => {
    // The shared mock's generateScript is [] — any provider.generate() call would throw
    // and surface as isError. A falsy isError proves zero generation calls.
    const result = await client.callTool({
      name: 'memory_search',
      arguments: { query: 'does recall generate?' },
    });
    expect(result.isError ?? false).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Populated-DB provenance — scratch temp-file DB seeded before server start
// ---------------------------------------------------------------------------

describe('mcp-server memory_search provenance (populated DB)', () => {
  let tmpDir: string;
  let client: Client;
  let embedCalls: number;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'brain-mcp-test-'));
    const dbPath = join(tmpDir, 'test.db');

    // Seed one fact node with a unit-vector embedding, then close — the server
    // opens its own handle on the same path (dbPath override, D-12).
    const db = new Database(dbPath);
    initSchema(db);
    const config = { ...DEFAULT_CONFIG, dbPath };
    const store = new SemanticStore(db, realClock, config);
    const id = newId();
    store.upsertNode({
      id,
      type: 'fact',
      value: 'the sky is blue',
      origin: 'observed',
      tombstoned: false,
    });
    const vec = new Float32Array(config.embeddingDimensions);
    vec[0] = 1.0;
    store.setEmbedding(id, vec);
    db.close();

    embedCalls = 0;
    const mock = new MockModelProvider({
      embedFn: () => {
        embedCalls++;
        const v = new Float32Array(config.embeddingDimensions);
        v[0] = 1.0; // cosine 1.0 against the seeded node — clears deletedSimilarityThreshold
        return v;
      },
    });
    client = await connectClient({ dbPath, provider: mock });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns structured per-result provenance { value, origin, score, lastUpdatedMs }', async () => {
    const result = await client.callTool({
      name: 'memory_search',
      arguments: { query: 'what color is the sky' },
    });
    expect(result.isError ?? false).toBe(false);
    const structured = result.structuredContent as { results: SearchRow[] };
    expect(Array.isArray(structured.results)).toBe(true);
    expect(structured.results.length).toBe(1);
    const row = structured.results[0]!;
    expect(row.value).toBe('the sky is blue');
    expect(row.origin).toBe('observed');
    expect(typeof row.score).toBe('number');
    expect(row.score).toBeGreaterThan(0);
    expect(typeof row.lastUpdatedMs).toBe('number');
    expect(row.lastUpdatedMs).toBeGreaterThan(0);
  });

  it('calls provider.embed exactly once and provider.generate zero times', async () => {
    const result = await client.callTool({
      name: 'memory_search',
      arguments: { query: 'what color is the sky' },
    });
    // generateScript is [] — falsy isError proves zero generate() calls (D-08).
    expect(result.isError ?? false).toBe(false);
    expect(embedCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Row-count helpers — second handle on the SAME temp-file DB the server writes
// ---------------------------------------------------------------------------

/** Count rows in a table via a short-lived verification handle. */
function countRows(dbPath: string, table: 'episode' | 'node'): number {
  const db = new Database(dbPath);
  try {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  } finally {
    db.close();
  }
}

/** Read the newest episode row (by rowid) for origin/content assertions. */
function newestEpisode(dbPath: string): { origin: string; content: string; source: string; external_id: string | null } | undefined {
  const db = new Database(dbPath);
  try {
    return db
      .prepare('SELECT origin, content, source, external_id FROM episode ORDER BY rowid DESC LIMIT 1')
      .get() as { origin: string; content: string; source: string; external_id: string | null } | undefined;
  } finally {
    db.close();
  }
}

/** Count episodes carrying a given origin (D-05 zero-inferred assertion). */
function countEpisodesWithOrigin(dbPath: string, origin: string): number {
  const db = new Database(dbPath);
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM episode WHERE origin = ?').get(origin) as { c: number }).c;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// memory_add — episodic-only write, origin clamp, deferred ack, per-call lock
// ---------------------------------------------------------------------------

describe('mcp-server memory_add (episodic-only write)', () => {
  let tmpDir: string;
  let dbPath: string;
  let lockPath: string;
  let client: Client;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'brain-mcp-add-'));
    dbPath = join(tmpDir, 'test.db');
    lockPath = join(tmpDir, 'test.lock');
    // Hermetic lock: never touch the real /tmp sleep-pass lock (DEBT-02 call-time read).
    process.env['BRAIN_MEMORY_LOCK_PATH'] = lockPath;
    const mock = new MockModelProvider({
      embedFn: () => new Float32Array([0.1, 0.2, 0.3]),
    });
    client = await connectClient({ dbPath, provider: mock });
  });

  afterEach(async () => {
    await client.close();
    delete process.env['BRAIN_MEMORY_LOCK_PATH'];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores exactly one episode and returns the deferred ack (D-10)', async () => {
    const before = countRows(dbPath, 'episode');
    const result = await client.callTool({
      name: 'memory_add',
      arguments: { content: 'Max prefers TypeScript', origin: 'asserted_by_user' },
    });
    expect(result.isError ?? false).toBe(false);
    const sc = result.structuredContent as { status: string; message: string };
    expect(sc.status).toBe('queued');
    expect(sc.message).toContain('consolidation');
    expect(countRows(dbPath, 'episode')).toBe(before + 1);
    const row = newestEpisode(dbPath)!;
    expect(row.origin).toBe('asserted_by_user');
    expect(row.content).toBe('Max prefers TypeScript');
    expect(row.source).toBe('mcp'); // flat source tag (D-06)
    expect(row.external_id).toBeNull(); // no dedup (D-07)
  });

  it('defaults origin to observed when omitted', async () => {
    const result = await client.callTool({
      name: 'memory_add',
      arguments: { content: 'the build is green' },
    });
    expect(result.isError ?? false).toBe(false);
    expect(newestEpisode(dbPath)!.origin).toBe('observed');
  });

  it('does not mutate the graph — node table count unchanged (MCP-03)', async () => {
    const nodesBefore = countRows(dbPath, 'node');
    const result = await client.callTool({
      name: 'memory_add',
      arguments: { content: 'graph must stay untouched' },
    });
    expect(result.isError ?? false).toBe(false);
    expect(countRows(dbPath, 'node')).toBe(nodesBefore);
  });

  it("never stores an 'inferred' episode — clamped or rejected (D-05)", async () => {
    // Defense in depth: the zod enum rejects 'inferred' at the SDK layer; if a
    // future schema loosening let it through, validateOrigin clamps it. Either
    // way the invariant is: zero origin='inferred' rows from a client write.
    let accepted = false;
    try {
      const res = await client.callTool({
        name: 'memory_add',
        arguments: { content: 'x', origin: 'inferred' },
      });
      accepted = !(res.isError ?? false);
    } catch {
      // SDK-level zod validation error — the strict-enum path
    }
    if (accepted) {
      // Clamp path: the stored row must be 'observed', never 'inferred'
      expect(newestEpisode(dbPath)!.origin).toBe('observed');
    }
    expect(countEpisodesWithOrigin(dbPath, 'inferred')).toBe(0);
  });

  it('validateOrigin clamps inferred/unknown/undefined to observed (D-05 helper)', () => {
    expect(validateOrigin('inferred')).toBe('observed');
    expect(validateOrigin('anything-else')).toBe('observed');
    expect(validateOrigin(undefined)).toBe('observed');
    expect(validateOrigin('asserted_by_user')).toBe('asserted_by_user');
  });

  it('returns isError when the lock is held, and the server keeps running', async () => {
    // Hold the lock as a live process (our own PID) — acquireLockWithRetry must
    // give up after its bounded retries and the handler must NOT process.exit.
    writeFileSync(lockPath, String(process.pid));
    const before = countRows(dbPath, 'episode');
    const result = await client.callTool({
      name: 'memory_add',
      arguments: { content: 'should not be stored' },
    });
    expect(result.isError).toBe(true);
    expect(countRows(dbPath, 'episode')).toBe(before); // nothing written
    // Server is still alive and answering requests (no process.exit)
    const { tools } = await client.listTools();
    expect(tools.length).toBe(3);
  }, 15_000);
});
