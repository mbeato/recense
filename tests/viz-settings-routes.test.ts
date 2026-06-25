/**
 * Tests for GET /settings, POST /settings, and GET /usage routes (44-05).
 *
 * Coverage:
 *   GET /settings → 200 with {preset, overrides, effective}
 *   POST /settings {preset:'lite'} → 200; subsequent GET reflects lite preset
 *   POST /settings {overrides:{consolSkipThreshold:0.3}} → 200; effective reflects override
 *   POST /settings {overrides:{bogus:1}} → 400 unknown key
 *   POST /settings with malformed body → 400 bad json
 *   POST /settings with invalid preset name → 400 invalid preset
 *   POST /settings with invalid override type → 400 invalid type
 *   DELETE /settings → 405 method not allowed
 *   GET /usage (empty ledger) → 200 with zeroed totals
 *   GET /usage (seeded rows) → 200 with correct rolling-30d / all-time breakdowns
 *   POST /usage → 405 method not allowed
 *   GET /settings with non-loopback Host → 403 (DNS-rebinding guard)
 *   GET /usage with non-loopback Host → 403
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
    `viz-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function makeTempSettingsPath(): string {
  return path.join(
    os.tmpdir(),
    `viz-settings-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
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

  // Initialise the DB with the full schema (token_usage_ledger created by initSchema).
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

// ---------------------------------------------------------------------------
// GET /settings
// ---------------------------------------------------------------------------

describe('GET /settings', () => {
  it('returns 200 with default preset + overrides + effective when no settings file exists', async () => {
    const r = await makeRequest(port, '/settings');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    const json = JSON.parse(r.body) as { preset: string; overrides: Record<string, unknown>; effective: unknown };
    expect(json.preset).toBe('standard'); // default when no file
    expect(json.overrides).toEqual({});
    expect(json.effective).toBeTruthy();
    // effective must include dbPath
    expect((json.effective as Record<string, unknown>)['dbPath']).toBe(tmpDbPath);
  });

  it('returns 403 for a non-loopback Host header (DNS-rebinding guard)', async () => {
    const r = await makeRequest(port, '/settings', 'GET', undefined, 'attacker.com');
    expect(r.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST /settings
// ---------------------------------------------------------------------------

describe('POST /settings', () => {
  it('updates preset and returns 200 with updated effective config', async () => {
    const r = await makeRequest(port, '/settings', 'POST', JSON.stringify({ preset: 'lite' }));
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as { preset: string; overrides: Record<string, unknown>; effective: Record<string, unknown> };
    expect(json.preset).toBe('lite');
    // lite preset disables corpusGen and schemaInduction
    expect(json.effective['corpusGen']).toBe(false);
    expect(json.effective['schemaInductionEnabled']).toBe(false);
  });

  it('subsequent GET reflects the updated preset', async () => {
    await makeRequest(port, '/settings', 'POST', JSON.stringify({ preset: 'lite' }));
    const r = await makeRequest(port, '/settings');
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as { preset: string };
    expect(json.preset).toBe('lite');
  });

  it('updates a whitelisted override key and merges with existing overrides', async () => {
    // Set initial override
    await makeRequest(port, '/settings', 'POST', JSON.stringify({ overrides: { consolSkipThreshold: 0.3 } }));
    // Add another override — first one should be preserved
    const r = await makeRequest(port, '/settings', 'POST', JSON.stringify({ overrides: { corpusGenMax: 10 } }));
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as { overrides: Record<string, unknown>; effective: Record<string, unknown> };
    expect(json.overrides['consolSkipThreshold']).toBe(0.3);
    expect(json.overrides['corpusGenMax']).toBe(10);
    expect(json.effective['consolSkipThreshold']).toBe(0.3);
    expect(json.effective['corpusGenMax']).toBe(10);
  });

  it('returns 400 for an unknown override key (T-44-15 key whitelist)', async () => {
    const r = await makeRequest(port, '/settings', 'POST', JSON.stringify({ overrides: { bogus: 1 } }));
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('unknown key');
  });

  it('returns 400 for malformed JSON body', async () => {
    const r = await makeRequest(port, '/settings', 'POST', 'not-json{{{');
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('bad json');
  });

  it('returns 400 for an invalid preset name', async () => {
    const r = await makeRequest(port, '/settings', 'POST', JSON.stringify({ preset: 'ultra' }));
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('invalid preset');
  });

  it('returns 400 for wrong type on a boolean override key (corpusGen must be boolean)', async () => {
    const r = await makeRequest(port, '/settings', 'POST', JSON.stringify({ overrides: { corpusGen: 'yes' } }));
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('invalid type');
  });

  it('returns 400 for wrong type on a number override key (consolSkipThreshold must be number)', async () => {
    const r = await makeRequest(port, '/settings', 'POST', JSON.stringify({ overrides: { consolSkipThreshold: true } }));
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('invalid type');
  });

  it('returns 405 for non-GET/POST methods (DELETE)', async () => {
    const r = await makeRequest(port, '/settings', 'DELETE');
    expect(r.statusCode).toBe(405);
  });

  it('returns 403 for a non-loopback Host header (DNS-rebinding guard)', async () => {
    const r = await makeRequest(port, '/settings', 'POST', JSON.stringify({ preset: 'lite' }), 'attacker.com');
    expect(r.statusCode).toBe(403);
  });

  it('accepts all valid whitelist keys without error', async () => {
    const validOverrides = {
      consolSkipThreshold: 0.3,
      consolSkipThresholdAssistant: 0.6,
      corpusSubjectDriftThreshold: 5,
      corpusGen: true,
      corpusGenMax: 15,
      schemaInductionEnabled: false,
      sleepFrequencyHours: 2,
    };
    const r = await makeRequest(port, '/settings', 'POST', JSON.stringify({ overrides: validOverrides }));
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as { overrides: Record<string, unknown> };
    expect(json.overrides['consolSkipThreshold']).toBe(0.3);
    expect(json.overrides['sleepFrequencyHours']).toBe(2);
    expect(json.overrides['schemaInductionEnabled']).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GET /usage
// ---------------------------------------------------------------------------

describe('GET /usage', () => {
  it('returns 200 with zeroed aggregates when the ledger is empty', async () => {
    const r = await makeRequest(port, '/usage');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    const json = JSON.parse(r.body) as {
      window_days: number;
      rolling_30d: { byFeature: unknown[]; totalTokens: number; totalCostUsd: number };
      all_time: { byFeature: unknown[]; totalTokens: number; totalCostUsd: number };
    };
    expect(json.window_days).toBe(30);
    expect(json.rolling_30d.byFeature).toEqual([]);
    expect(json.rolling_30d.totalTokens).toBe(0);
    expect(json.rolling_30d.totalCostUsd).toBe(0);
    expect(json.all_time.byFeature).toEqual([]);
    expect(json.all_time.totalTokens).toBe(0);
    expect(json.all_time.totalCostUsd).toBe(0);
  });

  it('includes only rows within the 30d window in rolling_30d, all rows in all_time', async () => {
    // Seed ledger rows directly (write-enabled DB, then re-open read-only in server).
    const writeDb = new Database(tmpDbPath);
    const now = Date.now();
    const old = now - 35 * 86_400_000; // 35 days ago — outside 30d window
    const recent = now - 5 * 86_400_000; // 5 days ago — inside 30d window

    writeDb.prepare(`
      INSERT INTO token_usage_ledger (ts, feature_tag, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, total_cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(old, 'extract', 'claude-haiku-4-5', 100, 50, 0, 0, 0.001);

    writeDb.prepare(`
      INSERT INTO token_usage_ledger (ts, feature_tag, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, total_cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(recent, 'judge', 'claude-sonnet-4-6', 200, 100, 10, 5, 0.005);

    writeDb.prepare(`
      INSERT INTO token_usage_ledger (ts, feature_tag, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, total_cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(recent, 'corpus_gen', 'claude-sonnet-4-6', 400, 300, 20, 10, 0.01);

    writeDb.close();

    // Restart the server to pick up the new rows (the read-only handle was opened before rows were inserted).
    await new Promise<void>((r) => server.close(() => r()));
    server = startVizServer(tmpDbPath, port, { settingsPath: tmpSettingsPath });
    await new Promise<void>((r) => (server.listening ? r() : server.once('listening', r)));

    const r = await makeRequest(port, '/usage');
    expect(r.statusCode).toBe(200);

    type FeatureRow = {
      feature_tag: string;
      input_tokens: number;
      output_tokens: number;
      total_cost_usd: number;
    };
    const json = JSON.parse(r.body) as {
      rolling_30d: { byFeature: FeatureRow[]; totalTokens: number; totalCostUsd: number };
      all_time: { byFeature: FeatureRow[]; totalTokens: number; totalCostUsd: number };
    };

    // rolling_30d should include judge + corpus_gen only (extract is 35d old)
    const r30Tags = json.rolling_30d.byFeature.map((row) => row.feature_tag).sort();
    expect(r30Tags).toEqual(['corpus_gen', 'judge']);
    expect(json.rolling_30d.totalTokens).toBe(200 + 100 + 400 + 300); // judge + corpus_gen
    expect(json.rolling_30d.totalCostUsd).toBeCloseTo(0.005 + 0.01);

    // all_time should include extract + judge + corpus_gen
    const allTags = json.all_time.byFeature.map((row) => row.feature_tag).sort();
    expect(allTags).toEqual(['corpus_gen', 'extract', 'judge']);
    expect(json.all_time.totalTokens).toBe(100 + 50 + 200 + 100 + 400 + 300);
    expect(json.all_time.totalCostUsd).toBeCloseTo(0.001 + 0.005 + 0.01);
  });

  it('returns per-feature rows with correct column names', async () => {
    const writeDb = new Database(tmpDbPath);
    const now = Date.now();
    writeDb.prepare(`
      INSERT INTO token_usage_ledger (ts, feature_tag, model, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, total_cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(now, 'schema_abstract', 'claude-sonnet-4-6', 50, 30, 5, 2, 0.002);
    writeDb.close();

    await new Promise<void>((r) => server.close(() => r()));
    server = startVizServer(tmpDbPath, port, { settingsPath: tmpSettingsPath });
    await new Promise<void>((r) => (server.listening ? r() : server.once('listening', r)));

    const r = await makeRequest(port, '/usage');
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as {
      all_time: { byFeature: Array<Record<string, unknown>> };
    };
    const row = json.all_time.byFeature.find((x) => x['feature_tag'] === 'schema_abstract');
    expect(row).toBeTruthy();
    expect(row!['input_tokens']).toBe(50);
    expect(row!['output_tokens']).toBe(30);
    expect(row!['cache_write_tokens']).toBe(5);
    expect(row!['cache_read_tokens']).toBe(2);
    expect(row!['total_cost_usd']).toBeCloseTo(0.002);
  });

  it('returns 405 for non-GET methods', async () => {
    const r = await makeRequest(port, '/usage', 'POST', '{}');
    expect(r.statusCode).toBe(405);
  });

  it('returns 403 for a non-loopback Host header (DNS-rebinding guard)', async () => {
    const r = await makeRequest(port, '/usage', 'GET', undefined, 'evil.com');
    expect(r.statusCode).toBe(403);
  });
});
