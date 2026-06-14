/**
 * tests/memory-ops-trace.test.ts — end-to-end flag-gated trace emission through
 * wireMemoryEngine (quick-260612-p8l).
 *
 * Verifies the SwitchableActivationTraceSink wiring in memory-ops:
 *   1. flag absent (default): search surfaces hits but writes ZERO activation_trace
 *      rows (fail-closed Noop default).
 *   2. flag=1 before wiring: search writes exactly one row — seeds contain the
 *      surfaced node id, hops is [].
 *   3. flag flip mid-process (load-bearing): a long-running process picks up a
 *      `recense viz` flag flip on the next search WITHOUT restart (per-request
 *      traceSink.refresh()), in both directions (off→on→off).
 *   4. zero-hit search: no row even when flag=1 (no empty-seeds emission).
 *
 * Harness: temp FILE DB per test (better-sqlite3 cannot open :memory: readonly —
 * serve-cli.test.ts pattern), MockModelProvider with a fixed embedFn, node seeded
 * with an embedding identical to the embedFn output so cosine = 1.0 (clears the
 * 0.3 search floor). SCRATCH temp DB only — never the production DB.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initSchema } from '../src/db/schema';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { FakeClock } from '../src/lib/clock';
import { SemanticStore } from '../src/db/semantic-store';
import { wireMemoryEngine, MemoryOps } from '../src/adapter/memory-ops';
import { MockModelProvider } from '../src/model/provider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `memory-ops-trace-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/** Fixed embedding shared by the mock provider and the seeded node (cosine = 1.0). */
const FIXED_VEC = new Float32Array([0.1, 0.2, 0.3]);

const SEEDED_NODE_ID = 'trace-test-node-1';

/** Seed one searchable node whose embedding equals the mock embedFn output. */
function seedSearchableNode(dbPath: string): void {
  const db = new Database(dbPath);
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath });
  store.upsertNode({
    id: SEEDED_NODE_ID,
    type: 'fact',
    value: 'a seeded searchable fact',
    origin: 'observed',
    s: 0.8,
  });
  store.setEmbedding(SEEDED_NODE_ID, FIXED_VEC);
  db.close();
}

/** Set viz_trace_enabled via a separate short-lived handle (mid-process flip). */
function setFlag(dbPath: string, value: '0' | '1'): void {
  const db = new Database(dbPath);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('viz_trace_enabled', ?)").run(value);
  db.close();
}

/** Count activation_trace rows via a separate short-lived handle. */
function countTraceRows(dbPath: string): number {
  const db = new Database(dbPath);
  const row = db.prepare('SELECT COUNT(*) AS n FROM activation_trace').get() as { n: number };
  db.close();
  return row.n;
}

interface TraceRow { seeds: string; hops: string; query_id: string }

function getLatestTraceRow(dbPath: string): TraceRow {
  const db = new Database(dbPath);
  const row = db.prepare('SELECT query_id, seeds, hops FROM activation_trace ORDER BY id DESC LIMIT 1')
    .get() as TraceRow;
  db.close();
  return row;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tmpDbPath: string;
let ops: MemoryOps;
let close: () => void;

async function wire(): Promise<void> {
  const wired = await wireMemoryEngine({
    dbPath: tmpDbPath,
    provider: new MockModelProvider({ embedFn: () => FIXED_VEC }),
    source: 'test',
  });
  ops = wired.ops;
  close = wired.close;
}

beforeEach(() => {
  tmpDbPath = makeTempDbPath();
  // Schema + seed on a setup handle, closed before wiring (serve-cli pattern).
  const setupDb = new Database(tmpDbPath);
  initSchema(setupDb);
  setupDb.close();
});

afterEach(() => {
  try { close(); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('memory-ops flag-gated trace emission (wireMemoryEngine)', () => {
  it('flag absent (default): search returns the seeded hit but writes ZERO trace rows', async () => {
    seedSearchableNode(tmpDbPath);
    await wire();

    const rows = await ops.search('q');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe('a seeded searchable fact');

    // Fail-closed Noop default — no viz_trace_enabled key means no writes.
    expect(countTraceRows(tmpDbPath)).toBe(0);
  });

  it('flag=1 before wiring: search writes exactly one row with seeds=[node id], hops=[]', async () => {
    seedSearchableNode(tmpDbPath);
    setFlag(tmpDbPath, '1');
    await wire();

    const rows = await ops.search('q');
    expect(rows).toHaveLength(1);

    expect(countTraceRows(tmpDbPath)).toBe(1);
    const trace = getLatestTraceRow(tmpDbPath);
    expect(JSON.parse(trace.seeds) as string[]).toContain(SEEDED_NODE_ID);
    expect(JSON.parse(trace.hops)).toEqual([]);
  });

  it('flag flip mid-process: SAME ops instance picks up off→on→off without restart', async () => {
    seedSearchableNode(tmpDbPath);
    await wire(); // flag absent at wiring time

    // Off: no rows.
    await ops.search('q');
    expect(countTraceRows(tmpDbPath)).toBe(0);

    // Flip ON via a separate handle — next search on the SAME instance must emit.
    setFlag(tmpDbPath, '1');
    await ops.search('q');
    expect(countTraceRows(tmpDbPath)).toBe(1);

    // Flip OFF — no additional row.
    setFlag(tmpDbPath, '0');
    await ops.search('q');
    expect(countTraceRows(tmpDbPath)).toBe(1);
  });

  it('zero-hit search: no row even when flag=1 (no empty-seeds emission)', async () => {
    // No node seeded — search surfaces nothing.
    setFlag(tmpDbPath, '1');
    await wire();

    const rows = await ops.search('q');
    expect(rows).toHaveLength(0);
    expect(countTraceRows(tmpDbPath)).toBe(0);
  });
});
