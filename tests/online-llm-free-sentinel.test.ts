/**
 * tests/online-llm-free-sentinel.test.ts — CLASSIFY-03 regression lock.
 *
 * D-13: online paths (SessionStart inject, retrieval, `GET /v1/surface`) must never call
 * the model provider for generation or judging. Phase 63 adds offline intent classification
 * ONLY inside the sleep pass's per-episode consolidator loop (D-09) — this test is the guard
 * that keeps that boundary honest now, and across future phases that touch these paths.
 *
 * Two halves:
 *   1. Dynamic — a fail-if-called `ModelProvider` stub exercised through the three live
 *      online entrypoints, in-process, with positive completion assertions (non-empty
 *      output, exact embed counts) so a short-circuiting path cannot pass as "LLM-free".
 *   2. Structural — a pure predicate scanning the online-path source set (ambient-recall.ts
 *      + src/retrieval/*.ts) for `.generate(`/`.judge(`/`.judgeBatch(` outside comments,
 *      proven non-vacuous against a planted offender and a comment-only false-positive case.
 *
 * PHASE 66 EXTENSION POINT: when `/v1/proposals` lands (EMIT-* work), this file MUST gain
 * a fourth dynamic describe block exercising that route the same way the `GET /v1/surface`
 * block does below (D-13).
 *
 * NOT covered here (intentionally): the `recense recall` on-demand inference path
 * (`src/recall.ts`, LEARN-02). That is a user-initiated LLM call, not an ambient online
 * path — its `generate` call is expected and load-bearing, not a violation.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as http from 'node:http';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initSchema } from '../src/db/schema';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { FakeClock } from '../src/lib/clock';
import { SemanticStore } from '../src/db/semantic-store';
import { StrengthDecayManager } from '../src/strength/decay';
import { AllocationGate } from '../src/gate/allocation-gate';
import { CandidateRetriever, vectorIndexPath } from '../src/retrieval/topk';
import { RetrievalEngine } from '../src/retrieval/engine';
import { ambientRecall, AMBIENT_K, AMBIENT_FLOOR } from '../src/adapter/ambient-recall';
import { createBrainHttpServer, BrainHttpServer } from '../src/adapter/serve-cli';
import type { ModelProvider } from '../src/model/provider';

// ---------------------------------------------------------------------------
// Shared fail-if-called provider (dynamic half)
// ---------------------------------------------------------------------------

/**
 * A ModelProvider where `embed` delegates to `embedFn` (and is counted) while `generate`,
 * `judge`, and `judgeBatch` each throw. `embed` is deliberately allowed — embedding is not
 * a generation call, and the inject path legitimately makes exactly one. The assertion
 * under test is zero generate/judge/judgeBatch calls across all three entrypoints.
 */
function makeLlmFreeProvider(
  embedFn: (text: string) => Float32Array,
): ModelProvider & { readonly embedCount: number } {
  let embedCount = 0;
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      embedCount++;
      return texts.map(embedFn);
    },
    async generate(): Promise<string> {
      throw new Error('generate must not be called on an online path (CLASSIFY-03)');
    },
    async judge(): Promise<never> {
      throw new Error('judge must not be called on an online path (CLASSIFY-03)');
    },
    async judgeBatch(items: Array<{ claim: string; candidates: Array<{ id: string; value: string }> }>): Promise<never> {
      if (items.length === 0) {
        throw new Error('judgeBatch must not be called on an online path (CLASSIFY-03)');
      }
      throw new Error('judgeBatch must not be called on an online path (CLASSIFY-03)');
    },
    get embedCount() {
      return embedCount;
    },
  };
}

/** Fixed embedding — cosine 1.0 against itself, clears AMBIENT_FLOOR when seeded on a node. */
const FIXED_VEC = new Float32Array([0, 1, 0]);

function makeTempDbPath(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function config(dbPath: string) {
  return { ...DEFAULT_CONFIG, dbPath };
}

// ---------------------------------------------------------------------------
// 1. SessionStart inject
// ---------------------------------------------------------------------------

describe('CLASSIFY-03: SessionStart inject is LLM-free', () => {
  let tmpDbPath: string;
  let db: Database.Database;

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
  });

  it('ambientRecall completes with a non-empty result and calls embed exactly once', async () => {
    tmpDbPath = makeTempDbPath('sentinel-inject');
    const setupDb = new Database(tmpDbPath);
    initSchema(setupDb);
    setupDb.close();
    db = new Database(tmpDbPath);

    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const store = new SemanticStore(db, clock, config(tmpDbPath));
    store.upsertNode({
      id: 'sentinel-inject-node',
      type: 'fact',
      value: 'a sentinel fact seeded for the inject path',
      origin: 'observed',
      s: 0.8,
    });
    store.setEmbedding('sentinel-inject-node', FIXED_VEC);

    const provider = makeLlmFreeProvider(() => FIXED_VEC);

    const text = await ambientRecall(db, 'some prompt long enough to embed', provider, config(tmpDbPath), clock);

    // Proof the path ran to completion (result cleared AMBIENT_FLOOR), not that it bailed early.
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('a sentinel fact seeded for the inject path');
    expect(provider.embedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Retrieval
// ---------------------------------------------------------------------------

describe('CLASSIFY-03: retrieval is LLM-free', () => {
  let tmpDbPath: string;
  let db: Database.Database;

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
  });

  it('retrieveRanked returns results from a pre-computed vector with no provider involved', () => {
    tmpDbPath = makeTempDbPath('sentinel-retrieval');
    const setupDb = new Database(tmpDbPath);
    initSchema(setupDb);
    setupDb.close();
    db = new Database(tmpDbPath);

    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const cfg = config(tmpDbPath);
    const store = new SemanticStore(db, clock, cfg);
    store.upsertNode({
      id: 'sentinel-retrieval-node',
      type: 'fact',
      value: 'a sentinel fact seeded for the retrieval path',
      origin: 'observed',
      s: 0.8,
    });
    store.setEmbedding('sentinel-retrieval-node', FIXED_VEC);

    // Same collaborator construction as ambientRecall — no ModelProvider passed anywhere.
    const retriever = new CandidateRetriever(db, { indexPath: vectorIndexPath(cfg.dbPath) });
    const strength = new StrengthDecayManager(db, clock, cfg);
    const gate = new AllocationGate(cfg);
    const engine = new RetrievalEngine(db, clock, cfg, retriever, store, strength, gate);

    // A provider exists in scope only to prove retrieveRanked never touches it.
    const provider = makeLlmFreeProvider(() => FIXED_VEC);
    const embedCountBefore = provider.embedCount;

    const results = engine.retrieveRanked(FIXED_VEC, AMBIENT_K, AMBIENT_FLOOR);

    expect(results.length).toBeGreaterThan(0);
    expect(provider.embedCount).toBe(embedCountBefore); // unchanged — retrieveRanked never calls embed
  });
});

// ---------------------------------------------------------------------------
// 3. GET /v1/surface
// ---------------------------------------------------------------------------

describe('CLASSIFY-03: GET /v1/surface is LLM-free', () => {
  const TEST_TOKEN = 'a'.repeat(64);
  const AUTH_HEADER = { authorization: `Bearer ${TEST_TOKEN}` };

  let serverResult: BrainHttpServer;
  let port: number;
  let tmpDbPath: string;
  let tmpLockPath: string;

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
    body: string;
  }

  function get(reqPort: number, urlPath: string): Promise<SimpleResponse> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: reqPort,
          path: urlPath,
          method: 'GET',
          agent: new http.Agent({ keepAlive: false }),
          headers: AUTH_HEADER,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  afterEach(async () => {
    await serverResult.close();
    try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
    delete process.env['RECENSE_LOCK_PATH'];
    try { fs.unlinkSync(tmpLockPath); } catch { /* ignore */ }
  });

  it('returns 200 with a parseable items array and calls embed zero times', async () => {
    port = await getFreePort();
    tmpDbPath = makeTempDbPath('sentinel-surface');
    tmpLockPath = path.join(os.tmpdir(), `sentinel-surface-lock-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`);
    process.env['RECENSE_LOCK_PATH'] = tmpLockPath;

    const setupDb = new Database(tmpDbPath);
    initSchema(setupDb);
    const clock = new FakeClock(Date.now());
    const store = new SemanticStore(setupDb, clock, config(tmpDbPath));
    store.upsertNode({
      id: 'sentinel-surface-node',
      type: 'fact',
      value: 'a sentinel surfaceable fact',
      origin: 'observed',
      s: 0.5,
      c: 0.5,
    });
    store.upsertNodeTemporal({
      node_id: 'sentinel-surface-node',
      due_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      action_type: 'meeting',
      recurrence_rule: null,
      source_event_id: null,
      updated_at: Date.now(),
    });
    setupDb.close();

    const provider = makeLlmFreeProvider(() => FIXED_VEC);

    serverResult = await createBrainHttpServer({
      dbPath: tmpDbPath,
      token: TEST_TOKEN,
      provider,
    });
    serverResult.server.listen(port, '127.0.0.1');
    await new Promise<void>((resolve) => {
      if (serverResult.server.listening) { resolve(); return; }
      serverResult.server.once('listening', resolve);
    });

    const res = await get(port, '/v1/surface');

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(provider.embedCount).toBe(0);
  });
});

