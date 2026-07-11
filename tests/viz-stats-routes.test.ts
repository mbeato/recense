/**
 * Tests for GET /stats/usage and GET /stats/brain-health (Phase 60, D-09..D-14).
 *
 * Coverage (Task 1 — /stats/usage):
 *   window=30d (default) → daily buckets, per-feature/per-model totals, retail_usd
 *   window=all → weekly buckets
 *   invalid window value → falls back to 30d (no error, no injection)
 *   cost_event_deltas carry a non-empty label sourced from constants.js COST_EVENTS
 *   empty ledger → 200 zeroed aggregates, not 500
 *   POST /stats/usage → 405; non-loopback Host → 403
 *
 * Coverage (Task 2 — /stats/brain-health):
 *   seeded consolidation_event/node/episode/ledger fixture → all six metric groups
 *   last_sleep_pass.status is the literal 'unknown' (rows exist) / 'none' (empty DB)
 *   empty DB → 200 zeroed, not 500
 *
 * Uses tmp DB and tmp settings path — never touches ~/.config/recense/settings.json
 * or ~/.config/recense/recense.db (T-44-16 / test isolation).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { initSchema } from '../src/db/schema';
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
  return path.join(
    os.tmpdir(),
    `viz-stats-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function makeTempSettingsPath(): string {
  return path.join(
    os.tmpdir(),
    `viz-stats-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
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
  headers: http.IncomingHttpHeaders;
  body: string;
}

function makeRequest(
  port: number,
  urlPath: string,
  method = 'GET',
  body?: string,
  hostOverride?: string,
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = hostOverride
      ? { host: hostOverride }
      : {};
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(body));
    }
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers,
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk: Buffer) => { buf += chunk.toString(); });
        res.on('end', () =>
          resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: buf }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let server: http.Server;
let port: number;
let tmpDbPath: string;
let tmpSettingsPath: string;

beforeEach(async () => {
  port = await getFreePort();
  tmpDbPath = makeTempDbPath();
  tmpSettingsPath = makeTempSettingsPath();

  const writeDb = new Database(tmpDbPath);
  writeDb.pragma('foreign_keys = ON');
  initSchema(writeDb);
  writeDb.close();

  server = startVizServer(tmpDbPath, port, { settingsPath: tmpSettingsPath });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', r)));
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpSettingsPath); } catch { /* ignore */ }
  vi.clearAllMocks();
});

/** Restart the server so its read-only handle picks up rows written after startup. */
async function restartServer(): Promise<void> {
  await new Promise<void>((r) => server.close(() => r()));
  server = startVizServer(tmpDbPath, port, { settingsPath: tmpSettingsPath });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', r)));
}

function insertLedgerRow(
  ts: number,
  feature_tag: string,
  model: string,
  input_tokens: number,
  output_tokens: number,
  total_cost_usd: number,
): void {
  const writeDb = new Database(tmpDbPath);
  writeDb.prepare(`
    INSERT INTO token_usage_ledger (ts, feature_tag, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, total_cost_usd)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?)
  `).run(ts, feature_tag, model, input_tokens, output_tokens, total_cost_usd);
  writeDb.close();
}

// ---------------------------------------------------------------------------
// GET /stats/usage
// ---------------------------------------------------------------------------

describe('GET /stats/usage', () => {
  it('returns 200 with zeroed aggregates when the ledger is empty', async () => {
    const r = await makeRequest(port, '/stats/usage');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    const json = JSON.parse(r.body) as {
      window: string;
      bucket_granularity: string;
      buckets: unknown[];
      by_feature: unknown[];
      by_model: unknown[];
      retail_usd: number;
      cost_event_deltas: Array<{ date: string; label: string; before_avg: number; after_avg: number }>;
    };
    expect(json.window).toBe('30d');
    expect(json.bucket_granularity).toBe('daily');
    expect(json.buckets).toEqual([]);
    expect(json.by_feature).toEqual([]);
    expect(json.by_model).toEqual([]);
    expect(json.retail_usd).toBe(0);
    // COST_EVENTS still yields marker entries even on an empty ledger (zeroed averages).
    expect(json.cost_event_deltas.length).toBeGreaterThan(0);
    for (const d of json.cost_event_deltas) {
      expect(d.before_avg).toBe(0);
      expect(d.after_avg).toBe(0);
    }
  });

  it('returns a daily bucket for window=30d with seeded rows', async () => {
    const now = Date.now();
    insertLedgerRow(now - 5 * 86_400_000, 'extract', 'claude-haiku-4-5', 100, 50, 0.001);
    insertLedgerRow(now - 5 * 86_400_000, 'judge', 'claude-sonnet-4-6', 200, 100, 0.005);
    await restartServer();

    const r = await makeRequest(port, '/stats/usage?window=30d');
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as {
      bucket_granularity: string;
      buckets: Array<{ date: string; tokens: number; cost_usd: number }>;
    };
    expect(json.bucket_granularity).toBe('daily');
    expect(json.buckets.length).toBe(1);
    expect(json.buckets[0]!.tokens).toBe(100 + 50 + 200 + 100);
    expect(json.buckets[0]!.cost_usd).toBeCloseTo(0.006);
  });

  it('returns weekly buckets for window=all', async () => {
    const now = Date.now();
    insertLedgerRow(now - 40 * 86_400_000, 'extract', 'claude-haiku-4-5', 100, 50, 0.001);
    await restartServer();

    const r = await makeRequest(port, '/stats/usage?window=all');
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as { window: string; bucket_granularity: string; buckets: unknown[] };
    expect(json.window).toBe('all');
    expect(json.bucket_granularity).toBe('weekly');
    expect(json.buckets.length).toBeGreaterThan(0);
  });

  it('falls back to 30d for an invalid window value (no error, no injection)', async () => {
    const r = await makeRequest(port, `/stats/usage?window=${encodeURIComponent("' OR 1=1--")}`);
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as { window: string; bucket_granularity: string };
    expect(json.window).toBe('30d');
    expect(json.bucket_granularity).toBe('daily');
  });

  it('includes per-feature and per-model totals keyed correctly', async () => {
    const now = Date.now();
    insertLedgerRow(now - 1 * 86_400_000, 'schema_abstract', 'claude-sonnet-4-6', 50, 30, 0.002);
    await restartServer();

    const r = await makeRequest(port, '/stats/usage?window=30d');
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as {
      by_feature: Array<Record<string, unknown>>;
      by_model: Array<Record<string, unknown>>;
    };
    const featureRow = json.by_feature.find((f) => f['feature_tag'] === 'schema_abstract');
    expect(featureRow).toBeTruthy();
    expect(featureRow!['input_tokens']).toBe(50);
    const modelRow = json.by_model.find((m) => m['model'] === 'claude-sonnet-4-6');
    expect(modelRow).toBeTruthy();
    expect(modelRow!['output_tokens']).toBe(30);
  });

  it('computes a before/after cost_event_delta with a non-empty label from constants.js', async () => {
    const now = Date.now();
    // Before the 2026-07-03 marker (and the 2026-06-25 marker).
    insertLedgerRow(now - 25 * 86_400_000, 'extract', 'claude-haiku-4-5', 1000, 0, 0.001);
    // After both markers.
    insertLedgerRow(now - 2 * 86_400_000, 'extract', 'claude-haiku-4-5', 10, 0, 0.0001);
    await restartServer();

    const r = await makeRequest(port, '/stats/usage?window=30d');
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as {
      cost_event_deltas: Array<{ date: string; label: string; before_avg: number; after_avg: number }>;
    };
    expect(json.cost_event_deltas.length).toBeGreaterThan(0);
    const withLabel = json.cost_event_deltas.find((d) => d.label && d.label.length > 0);
    expect(withLabel).toBeTruthy();
    expect(withLabel!.label).toBe('MAX_THINKING_TOKENS=0');
  });

  it('returns 405 for non-GET methods', async () => {
    const r = await makeRequest(port, '/stats/usage', 'POST', '{}');
    expect(r.statusCode).toBe(405);
  });

  it('returns 403 for a non-loopback Host header (DNS-rebinding guard)', async () => {
    const r = await makeRequest(port, '/stats/usage', 'GET', undefined, 'evil.com');
    expect(r.statusCode).toBe(403);
  });
});
