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
 */
import { mkdtempSync, rmSync } from 'fs';
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
import { createBrainMcpServer } from '../src/adapter/mcp-cli';

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
