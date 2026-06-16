/**
 * tests/surface-sentinel.test.ts — D-43 self-confirmation sentinel + endpoint integration
 * (Plan 21-04, SURF-03 / SC3 Phase 22 blocking gate).
 *
 * Task 1: D-43 self-confirmation sentinel
 *   Proves node.s and node.c are BYTE-IDENTICAL before and after a full
 *   GET /v1/surface + POST /v1/surface/seen cycle on a seeded node.
 *   SURF-03 / SC3: This test is the REQUIRED blocking gate — Phase 22 MUST NOT connect
 *   any push client until this sentinel passes.
 *
 * Task 2: Endpoint integration
 *   - GET /v1/surface ranking: P0 (tier=0, < 24h) appears before lower-tier (tier=1, > 24h)
 *   - POST /v1/surface/seen idempotency (D-05): double-POST collapses to exactly 1 row
 *   - POST /v1/surface/seen exclusion (D-07): dismissed items disappear from a later GET
 *   - Input validation: 400 on bad outcome enum, 404 on unknown node_id
 *   - D-08 grep guard: sleep-pass / consolidator source contains zero surfaced_event refs (SC2)
 *
 * Harness: node:http.request (no fetch), MockModelProvider (offline), temp file DB,
 * hermetic per-test RECENSE_LOCK_PATH — prevents contention with the hourly sleep pass.
 * Mirrors tests/serve-cli.test.ts pattern exactly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as http from 'node:http';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initSchema } from '../src/db/schema';
import { createBrainHttpServer, BrainHttpServer } from '../src/adapter/serve-cli';
import { MockModelProvider } from '../src/model/provider';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';

// ---------------------------------------------------------------------------
// Helpers (mirrors serve-cli.test.ts lines 40–115)
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  return path.join(
    os.tmpdir(),
    `surface-sentinel-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
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
  headers:    http.IncomingHttpHeaders;
  body:       string;
}

/** GET 127.0.0.1:<port><urlPath> with keepAlive:false so server.close() resolves cleanly. */
function get(
  port:    number,
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path:     urlPath,
        method:   'GET',
        agent:    new http.Agent({ keepAlive: false }),
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** POST 127.0.0.1:<port><urlPath> with JSON body + keepAlive:false. */
function post(
  port:     number,
  urlPath:  string,
  reqBody:  string,
  headers:  Record<string, string> = {},
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path:     urlPath,
        method:   'POST',
        agent:    new http.Agent({ keepAlive: false }),
        headers:  {
          'content-type':   'application/json',
          'content-length': Buffer.byteLength(reqBody),
          ...headers,
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on('error', reject);
    req.write(reqBody);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Fixtures (mirrors serve-cli.test.ts lines 121–163)
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'a'.repeat(64);
const AUTH_HEADER = { authorization: `Bearer ${TEST_TOKEN}` };

let serverResult: BrainHttpServer;
let port:         number;
let tmpDbPath:    string;
let tmpLockPath:  string;

beforeEach(async () => {
  port        = await getFreePort();
  tmpDbPath   = makeTempDbPath();
  // Hermetic per-test lock path — prevents contention with the hourly sleep pass or
  // parallel test workers holding the global lock (mirrors serve-cli.test.ts pattern).
  tmpLockPath = path.join(
    os.tmpdir(),
    `surface-sentinel-lock-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`,
  );
  process.env['RECENSE_LOCK_PATH'] = tmpLockPath;

  // Must use a file-based DB — better-sqlite3 cannot open :memory: with { readonly: true }
  // (required by separateReadHandle: true used inside wireMemoryEngine).
  const setupDb = new Database(tmpDbPath);
  initSchema(setupDb);
  setupDb.close();

  serverResult = await createBrainHttpServer({
    dbPath:   tmpDbPath,
    token:    TEST_TOKEN,
    provider: new MockModelProvider({ embedFn: () => new Float32Array([0.1, 0.2, 0.3]) }),
  });

  serverResult.server.listen(port, '127.0.0.1');
  await new Promise<void>((resolve) => {
    if (serverResult.server.listening) { resolve(); return; }
    serverResult.server.once('listening', resolve);
  });
});

afterEach(async () => {
  await serverResult.close();
  try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
  delete process.env['RECENSE_LOCK_PATH'];
  try { fs.unlinkSync(tmpLockPath); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Task 1: D-43 self-confirmation sentinel (SURF-03 / SC3 Phase 22 blocking gate)
// ---------------------------------------------------------------------------

describe('D-43 self-confirmation sentinel', () => {
  /**
   * SURF-03 / SC3 Phase 22 hard gate.
   *
   * Surfacing + seen-state writes MUST NOT strengthen a belief (node.s / node.c).
   * This is the load-bearing correctness-as-security control of the v4.0 milestone.
   * Phase 22 push client MUST NOT connect until this test is green.
   */
  it('node.s and node.c are byte-identical before and after a full surface+seen cycle', async () => {
    const fixedNow = Date.now();
    const dueAt    = new Date(fixedNow + 60 * 60 * 1000).toISOString(); // 1h from now → P0

    // 1. Seed the sentinel node with known s/c values directly into the DB.
    //    Uses a separate Database handle against tmpDbPath (mirrors store.test.ts lines 96–108).
    const seedDb    = new Database(tmpDbPath);
    const seedStore = new SemanticStore(
      seedDb,
      new FakeClock(fixedNow),
      { ...DEFAULT_CONFIG, dbPath: tmpDbPath },
    );
    seedStore.upsertNode({
      id:     'sentinel-node',
      type:   'fact',
      value:  'Max has a meeting tomorrow',
      origin: 'observed',
      s:      0.42,
      c:      0.65,
    });
    seedStore.upsertNodeTemporal({
      node_id:         'sentinel-node',
      due_at:          dueAt,
      action_type:     'meeting',
      recurrence_rule: null,
      source_event_id: null,
      updated_at:      fixedNow,
    });
    // Capture baseline s/c BEFORE any surface/seen call (D-43 before-snapshot)
    const before = seedDb
      .prepare('SELECT s, c FROM node WHERE id = ?')
      .get('sentinel-node') as { s: number; c: number };
    seedDb.close();

    // 2. GET /v1/surface — must return 200 and include the seeded sentinel-node.
    //    LLM-free, read-only, no lock (D-95).
    const surfaceRes = await get(port, '/v1/surface', AUTH_HEADER);
    expect(surfaceRes.statusCode).toBe(200);
    const surfaceBody = JSON.parse(surfaceRes.body) as {
      items: { node_id: string; due_at: string; tier: number }[];
    };
    expect(Array.isArray(surfaceBody.items)).toBe(true);
    const sentinelItem = surfaceBody.items.find(i => i.node_id === 'sentinel-node');
    expect(sentinelItem).toBeDefined();
    // Sentinel is due in 1h → P0 tier
    expect(sentinelItem!.tier).toBe(0);

    // 3. POST /v1/surface/seen — record outcome via the write path (per-call lock, T-12-02).
    //    SurfaceItem.due_at is the occurrence_due_at to echo back (interface note in plan).
    const seenRes = await post(
      port,
      '/v1/surface/seen',
      JSON.stringify({
        node_id:           'sentinel-node',
        occurrence_due_at: sentinelItem!.due_at,
        outcome:           'seen',
      }),
      AUTH_HEADER,
    );
    expect(seenRes.statusCode).toBe(200);

    // 4. D-43 assertion: node.s and node.c must be BYTE-IDENTICAL after the full cycle.
    //    If either value differs, surfacing is performing belief strengthening — Phase 22 BLOCKED.
    const checkDb = new Database(tmpDbPath);
    const after   = checkDb
      .prepare('SELECT s, c FROM node WHERE id = ?')
      .get('sentinel-node') as { s: number; c: number };
    checkDb.close();
    // SURF-03 / SC3 blocking gate — these two assertions are the gate condition
    expect(after.s).toBe(before.s); // node.s unchanged (D-43)
    expect(after.c).toBe(before.c); // node.c unchanged (D-43)
  });
});

// ---------------------------------------------------------------------------
// Task 2: Endpoint integration — ranking, idempotency, exclusion, D-08 guard
// ---------------------------------------------------------------------------

describe('GET /v1/surface ranking', () => {
  it('returns P0 (tier=0) items before lower-tier (tier=1) items — tier ASC, score DESC', async () => {
    const now    = Date.now();
    const seedDb = new Database(tmpDbPath);
    const store  = new SemanticStore(
      seedDb,
      new FakeClock(now),
      { ...DEFAULT_CONFIG, dbPath: tmpDbPath },
    );

    // P0 item: due in 2h → msToDue < 24h → tier 0
    store.upsertNode({
      id: 'rank-p0', type: 'fact', value: 'urgent meeting in 2h',
      origin: 'observed', s: 0.5, c: 0.5,
    });
    store.upsertNodeTemporal({
      node_id: 'rank-p0', due_at: new Date(now + 2 * 3_600_000).toISOString(),
      action_type: 'meeting', recurrence_rule: null, source_event_id: null, updated_at: now,
    });

    // Lower-tier item 1: due in 3 days → msToDue > 24h → tier 1
    store.upsertNode({
      id: 'rank-lower1', type: 'fact', value: 'flight in 3 days',
      origin: 'observed', s: 0.4, c: 0.5,
    });
    store.upsertNodeTemporal({
      node_id: 'rank-lower1', due_at: new Date(now + 3 * 24 * 3_600_000).toISOString(),
      action_type: 'flight', recurrence_rule: null, source_event_id: null, updated_at: now,
    });

    // Lower-tier item 2: due in 5 days → msToDue > 24h → tier 1
    store.upsertNode({
      id: 'rank-lower2', type: 'fact', value: 'deadline in 5 days',
      origin: 'observed', s: 0.6, c: 0.5,
    });
    store.upsertNodeTemporal({
      node_id: 'rank-lower2', due_at: new Date(now + 5 * 24 * 3_600_000).toISOString(),
      action_type: 'deadline', recurrence_rule: null, source_event_id: null, updated_at: now,
    });
    seedDb.close();

    const res = await get(port, '/v1/surface', AUTH_HEADER);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { items: { node_id: string; tier: number }[] };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(3);

    const p0Idx     = body.items.findIndex(i => i.node_id === 'rank-p0');
    const lower1Idx = body.items.findIndex(i => i.node_id === 'rank-lower1');
    const lower2Idx = body.items.findIndex(i => i.node_id === 'rank-lower2');

    expect(p0Idx).toBeGreaterThanOrEqual(0);
    expect(lower1Idx).toBeGreaterThanOrEqual(0);
    expect(lower2Idx).toBeGreaterThanOrEqual(0);
    // P0 tier assertion
    expect(body.items[p0Idx]!.tier).toBe(0);
    // P0 must appear before both lower-tier items (tier ASC)
    expect(p0Idx).toBeLessThan(lower1Idx);
    expect(p0Idx).toBeLessThan(lower2Idx);
  });
});

describe('POST /v1/surface/seen idempotency + exclusion', () => {
  it('D-05: double-POST with same (node_id, occurrence_due_at) collapses to exactly 1 surfaced_event row', async () => {
    const now    = Date.now();
    const dueAt  = new Date(now + 2 * 3_600_000).toISOString();
    const seedDb = new Database(tmpDbPath);
    const store  = new SemanticStore(
      seedDb,
      new FakeClock(now),
      { ...DEFAULT_CONFIG, dbPath: tmpDbPath },
    );
    store.upsertNode({
      id: 'idem-node', type: 'fact', value: 'idempotency target',
      origin: 'observed', s: 0.5, c: 0.5,
    });
    store.upsertNodeTemporal({
      node_id: 'idem-node', due_at: dueAt,
      action_type: 'meeting', recurrence_rule: null, source_event_id: null, updated_at: now,
    });
    seedDb.close();

    // First POST — outcome: 'seen'
    const res1 = await post(
      port, '/v1/surface/seen',
      JSON.stringify({ node_id: 'idem-node', occurrence_due_at: dueAt, outcome: 'seen' }),
      AUTH_HEADER,
    );
    expect(res1.statusCode).toBe(200);

    // Second POST — same idempotency key, different outcome: 'completed' (last-writer-wins)
    const res2 = await post(
      port, '/v1/surface/seen',
      JSON.stringify({ node_id: 'idem-node', occurrence_due_at: dueAt, outcome: 'completed' }),
      AUTH_HEADER,
    );
    expect(res2.statusCode).toBe(200);

    // Assert exactly ONE surfaced_event row exists for this key
    const checkDb = new Database(tmpDbPath);
    const row = checkDb
      .prepare(
        `SELECT COUNT(*) AS cnt, outcome
           FROM surfaced_event
          WHERE node_id = ? AND occurrence_due_at = ?`,
      )
      .get('idem-node', dueAt) as { cnt: number; outcome: string };
    checkDb.close();
    expect(row.cnt).toBe(1);               // D-05: idempotency key → exactly one row
    expect(row.outcome).toBe('completed'); // last-writer-wins on outcome
  });

  it('D-07: dismissed item is excluded from a subsequent GET /v1/surface', async () => {
    const now    = Date.now();
    const dueAt  = new Date(now + 2 * 3_600_000).toISOString();
    const seedDb = new Database(tmpDbPath);
    const store  = new SemanticStore(
      seedDb,
      new FakeClock(now),
      { ...DEFAULT_CONFIG, dbPath: tmpDbPath },
    );
    store.upsertNode({
      id: 'dismiss-node', type: 'fact', value: 'will be dismissed',
      origin: 'observed', s: 0.5, c: 0.5,
    });
    store.upsertNodeTemporal({
      node_id: 'dismiss-node', due_at: dueAt,
      action_type: 'meeting', recurrence_rule: null, source_event_id: null, updated_at: now,
    });
    seedDb.close();

    // POST seen with outcome 'dismissed' — marks this occurrence terminal
    const seenRes = await post(
      port, '/v1/surface/seen',
      JSON.stringify({ node_id: 'dismiss-node', occurrence_due_at: dueAt, outcome: 'dismissed' }),
      AUTH_HEADER,
    );
    expect(seenRes.statusCode).toBe(200);

    // GET /v1/surface — dismissed item must NOT appear (D-07 exclusion)
    const surfaceRes = await get(port, '/v1/surface', AUTH_HEADER);
    expect(surfaceRes.statusCode).toBe(200);
    const body = JSON.parse(surfaceRes.body) as { items: { node_id: string }[] };
    const found = body.items.find(i => i.node_id === 'dismiss-node');
    expect(found).toBeUndefined(); // D-07: dismissed occurrence excluded
  });

  it('returns 400 on invalid outcome value (not in enum)', async () => {
    // Validation fires before the node-existence check — outcome enum guard (T-21-07)
    const dueAt  = new Date(Date.now() + 3_600_000).toISOString();
    const seedDb = new Database(tmpDbPath);
    const store  = new SemanticStore(
      seedDb,
      new FakeClock(Date.now()),
      { ...DEFAULT_CONFIG, dbPath: tmpDbPath },
    );
    store.upsertNode({
      id: 'val-node', type: 'fact', value: 'validation target',
      origin: 'observed', s: 0.5, c: 0.5,
    });
    store.upsertNodeTemporal({
      node_id: 'val-node', due_at: dueAt,
      action_type: 'meeting', recurrence_rule: null, source_event_id: null, updated_at: Date.now(),
    });
    seedDb.close();

    const res = await post(
      port, '/v1/surface/seen',
      JSON.stringify({ node_id: 'val-node', occurrence_due_at: dueAt, outcome: 'banana' }),
      AUTH_HEADER,
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('bad_request');
  });

  it('returns 404 for unknown node_id (SurfaceTargetNotFoundError)', async () => {
    const res = await post(
      port, '/v1/surface/seen',
      JSON.stringify({
        node_id:           'no-such-node-xyzzy-d43',
        occurrence_due_at: new Date(Date.now() + 3_600_000).toISOString(),
        outcome:           'seen',
      }),
      AUTH_HEADER,
    );
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body) as { error: string };
    expect(body.error).toBe('not_found');
  });
});

describe('D-08 operational isolation', () => {
  it('SC2: sleep-pass / consolidator source files contain zero surfaced_event references', () => {
    /**
     * D-08 / SC2 invariant: surfaced_event is a serve-path-only operational table.
     * The consolidation / sleep-pass code MUST NEVER reference it — doing so would
     * create a covert channel that could violate D-43 (belief strengthening via surfacing).
     *
     * Implementation: in-process filesystem grep over src/consolidation/*.ts.
     * This is intentionally a structural test — it catches accidental coupling before
     * any runtime behavior shows it.
     */
    const consolidationDir = path.join(process.cwd(), 'src', 'consolidation');
    const tsFiles = fs.readdirSync(consolidationDir).filter(f => f.endsWith('.ts'));
    expect(tsFiles.length).toBeGreaterThan(0); // guard: if dir is empty the check is vacuous

    const violations: string[] = [];
    for (const file of tsFiles) {
      const content = fs.readFileSync(path.join(consolidationDir, file), 'utf8');
      if (content.includes('surfaced_event')) {
        violations.push(file);
      }
    }
    // D-08 / SC2: zero violations required — sleep pass is operationally isolated
    expect(violations).toEqual([]);
  });
});
