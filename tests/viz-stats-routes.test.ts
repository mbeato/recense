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
      summary: {
        today_tokens: number;
        week_tokens: number;
        month_tokens: number;
        avg_tokens_per_day: number;
        retail_usd_30d: number;
        today_vs_typical_pct: number | null;
        week_vs_typical_pct: number | null;
        trend_pct: number | null;
        trend_direction: string;
        heaviest_day: unknown;
      };
      lever_deltas: unknown[];
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
    // GAP-2a/2b: empty ledger yields a fully-zeroed summary, never an error.
    expect(json.summary.today_tokens).toBe(0);
    expect(json.summary.week_tokens).toBe(0);
    expect(json.summary.month_tokens).toBe(0);
    expect(json.summary.avg_tokens_per_day).toBe(0);
    expect(json.summary.retail_usd_30d).toBe(0);
    expect(json.summary.today_vs_typical_pct).toBeNull();
    expect(json.summary.week_vs_typical_pct).toBeNull();
    expect(json.summary.trend_pct).toBeNull();
    expect(json.summary.heaviest_day).toBeNull();
    // GAP-2c: empty ledger yields an empty levers array, mirroring buckets []).
    expect(json.lever_deltas).toEqual([]);
  });

  it('returns zero-filled daily buckets for window=30d with seeded rows', async () => {
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
    // Every calendar day in the window is present (zero-filled), so the x-axis
    // never distorts time and per-day averages divide by calendar days.
    expect(json.buckets.length).toBe(31);
    const active = json.buckets.filter((b) => b.tokens > 0);
    expect(active.length).toBe(1);
    expect(active[0]!.tokens).toBe(100 + 50 + 200 + 100);
    expect(active[0]!.cost_usd).toBeCloseTo(0.006);
    // Zero-filled days carry honest zeros, not nulls.
    const idle = json.buckets.find((b) => b.tokens === 0);
    expect(idle).toBeTruthy();
    expect(idle!.cost_usd).toBe(0);
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

  it('summary reflects seeded ledger sums and lever_deltas carry one entry per COST_EVENT (GAP-2a/2b/2c)', async () => {
    const now = Date.now();
    // Well before both COST_EVENTS markers (2026-07-03, 2026-06-25).
    insertLedgerRow(now - 40 * 86_400_000, 'extract', 'claude-haiku-4-5', 500, 0, 0.001);
    // After both markers, inside the trailing 7d/30d windows.
    insertLedgerRow(now - 3 * 86_400_000, 'extract', 'claude-haiku-4-5', 200, 0, 0.0005);
    insertLedgerRow(now, 'judge', 'claude-sonnet-4-6', 100, 50, 0.002);
    await restartServer();

    const r = await makeRequest(port, '/stats/usage?window=30d');
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as {
      summary: {
        today_tokens: number;
        week_tokens: number;
        month_tokens: number;
        avg_tokens_per_day: number;
        trend_direction: string;
      };
      lever_deltas: Array<{
        date: string; label: string; before_avg: number; after_avg: number; pct_saved: number | null;
      }>;
    };

    // Today's row (100+50=150 tokens) lands in today/week/month sums.
    expect(json.summary.today_tokens).toBe(150);
    expect(json.summary.week_tokens).toBeGreaterThanOrEqual(150 + 200);
    expect(json.summary.month_tokens).toBeGreaterThanOrEqual(150 + 200);
    expect(json.summary.avg_tokens_per_day).toBeCloseTo(json.summary.month_tokens / 30);
    expect(['up', 'down', 'flat']).toContain(json.summary.trend_direction);

    expect(json.lever_deltas.length).toBe(2);
    for (const lever of json.lever_deltas) {
      expect(typeof lever.before_avg).toBe('number');
      expect(typeof lever.after_avg).toBe('number');
      expect(lever.pct_saved === null || typeof lever.pct_saved === 'number').toBe(true);
    }
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

// ---------------------------------------------------------------------------
// GET /stats/brain-health
// ---------------------------------------------------------------------------

function insertNode(
  id: string,
  type: string,
  value: string,
  tombstoned: number,
): void {
  const writeDb = new Database(tmpDbPath);
  writeDb.prepare(`
    INSERT INTO node (id, type, value, value_hash, origin, s, c, last_access, tombstoned)
    VALUES (?, ?, ?, ?, 'observed', 0.1, 0.5, ?, ?)
  `).run(id, type, value, `hash-${id}`, Date.now(), tombstoned);
  writeDb.close();
}

function insertConsolidationEvent(
  id: string,
  ts: number,
  event_type: string,
  node_id: string | null,
): void {
  const writeDb = new Database(tmpDbPath);
  writeDb.prepare(`
    INSERT INTO consolidation_event (id, ts, schema_version, event_type, node_id)
    VALUES (?, ?, 1, ?, ?)
  `).run(id, ts, event_type, node_id);
  writeDb.close();
}

function insertEpisode(id: string, consolidated: number): void {
  const writeDb = new Database(tmpDbPath);
  writeDb.prepare(`
    INSERT INTO episode (id, ts, content, origin, salience, consolidated, role, session_id)
    VALUES (?, ?, ?, 'observed', 0.5, ?, 'user', 'sess-1')
  `).run(id, Date.now(), `content-${id}`, consolidated);
  writeDb.close();
}

describe('GET /stats/brain-health', () => {
  it('returns 200 with every group zeroed and status=none when the DB is empty', async () => {
    const r = await makeRequest(port, '/stats/brain-health');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/json');
    const json = JSON.parse(r.body) as {
      node_growth: { points: unknown[]; approximate: boolean };
      kind_mix: Record<string, number>;
      reconsolidations_per_day: unknown[];
      tombstones_per_day: unknown[];
      judge_activity: { fires: number; escalation_rate: number | null };
      episodes: { pending: number; consolidated: number };
      last_sleep_pass: { ts: number | null; duration_ms: number | null; status: string };
    };
    expect(json.node_growth.points).toEqual([]);
    expect(json.node_growth.approximate).toBe(true);
    expect(json.kind_mix).toEqual({ entity: 0, fact: 0, schema: 0, doc: 0, insight: 0 });
    expect(json.reconsolidations_per_day).toEqual([]);
    expect(json.tombstones_per_day).toEqual([]);
    expect(json.judge_activity).toEqual({ fires: 0, escalation_rate: null });
    expect(json.episodes).toEqual({ pending: 0, consolidated: 0 });
    expect(json.last_sleep_pass).toEqual({ ts: null, duration_ms: null, status: 'none' });
  });

  it('returns all six metric groups + a derived last_sleep_pass from a seeded fixture', async () => {
    const now = Date.now();

    // kind_mix fixture: 1 entity, 2 live facts + 1 tombstoned fact (excluded), 1 schema, 1 doc, 1 insight.
    insertNode('n-entity-1', 'entity', 'Entity One', 0);
    insertNode('n-fact-1', 'fact', 'Fact One', 0);
    insertNode('n-fact-2', 'fact', 'Fact Two', 0);
    insertNode('n-fact-tombstoned', 'fact', 'Dead Fact', 1);
    insertNode('n-schema-1', 'schema', 'Schema One', 0);
    insertNode('n-doc-1', 'doc', 'Doc One', 0);
    insertNode('n-insight-1', 'insight', 'Insight One', 0);

    // node_growth fixture: birth events across 3 past days ('unrelated' IS a birth —
    // the standalone new-node branch), plus a 'confirm' that must NOT count (it
    // strengthens the existing candidate; node_id is the existing node, not a birth).
    insertConsolidationEvent('ev-extend-1', now - 3 * 86_400_000, 'extend', 'n-fact-1');
    insertConsolidationEvent('ev-unrelated-1', now - 3 * 86_400_000, 'unrelated', 'n-fact-2');
    insertConsolidationEvent('ev-confirm-1', now - 2 * 86_400_000, 'confirm', 'n-fact-1');
    insertConsolidationEvent('ev-append-1', now - 2 * 86_400_000, 'contradict_append_new', 'n-fact-2');
    insertConsolidationEvent('ev-schema-1', now - 1 * 86_400_000, 'schema_emitted', 'n-schema-1');

    // reconsolidation/tombstone fixture, clustered within the last 5 minutes ("the last batch").
    const batchStart = now - 5 * 60_000;
    insertConsolidationEvent('ev-reconcile-1', batchStart, 'contradict_reconcile', 'n-fact-1');
    insertConsolidationEvent('ev-destab-1', now - 3 * 60_000, 'contradict_force_destabilize', 'n-fact-2');
    insertConsolidationEvent('ev-osc-1', now - 2 * 60_000, 'contradict_oscillation', 'n-fact-1');
    insertConsolidationEvent('ev-merge-1', now - 1 * 60_000, 'entity_merge', 'n-entity-1');
    insertConsolidationEvent('ev-falsified-1', now, 'schema_falsified', 'n-schema-1');

    // judge activity fixture: 3 judge calls, all Sonnet — production-realistic:
    // feature_tag='judge' rows are ALWAYS the Sonnet judge model (deriveFeatureTag
    // in claude-headless-client.ts tags Haiku rows 'extract'), which is exactly why
    // the server cannot measure escalation and reports escalation_rate: null.
    insertLedgerRow(now, 'judge', 'claude-sonnet-4-6', 100, 50, 0.01);
    insertLedgerRow(now, 'judge', 'claude-sonnet-4-6', 100, 50, 0.01);
    insertLedgerRow(now, 'judge', 'claude-sonnet-4-6', 100, 50, 0.01);

    // episodes fixture: 2 pending, 3 consolidated.
    insertEpisode('ep-1', 0);
    insertEpisode('ep-2', 0);
    insertEpisode('ep-3', 1);
    insertEpisode('ep-4', 1);
    insertEpisode('ep-5', 1);

    await restartServer();

    const r = await makeRequest(port, '/stats/brain-health');
    expect(r.statusCode).toBe(200);
    const json = JSON.parse(r.body) as {
      node_growth: { points: Array<{ date: string; count: number }>; approximate: boolean };
      kind_mix: Record<string, number>;
      reconsolidations_per_day: Array<{ date: string; count: number }>;
      tombstones_per_day: Array<{ date: string; count: number }>;
      judge_activity: { fires: number; escalation_rate: number | null };
      episodes: { pending: number; consolidated: number };
      last_sleep_pass: { ts: number | null; duration_ms: number | null; status: string };
    };

    expect(json.node_growth.approximate).toBe(true);
    // 4 birth days: extend+unrelated (-3d), contradict_append_new (-2d, confirm on
    // that day excluded — not a birth), schema_emitted (-1d), contradict_oscillation
    // (today, from the recon fixture below — it mints a coexisting node).
    expect(json.node_growth.points.length).toBe(4);
    expect(json.node_growth.points[3]!.count).toBe(5); // cumulative running total

    expect(json.kind_mix).toEqual({ entity: 1, fact: 2, schema: 1, doc: 1, insight: 1 });

    const reconTotal = json.reconsolidations_per_day.reduce((sum, r) => sum + r.count, 0);
    expect(reconTotal).toBe(3); // reconcile + force_destabilize + oscillation

    const tombTotal = json.tombstones_per_day.reduce((sum, r) => sum + r.count, 0);
    expect(tombTotal).toBe(4); // reconcile + force_destabilize + schema_falsified + entity_merge

    expect(json.judge_activity.fires).toBe(3);
    // escalation_rate is honestly unavailable (null) — the ledger cannot
    // distinguish escalated judge calls (no-fabricated-metrics posture).
    expect(json.judge_activity.escalation_rate).toBeNull();

    expect(json.episodes.pending).toBe(2);
    expect(json.episodes.consolidated).toBe(3);

    expect(json.last_sleep_pass.status).toBe('unknown');
    expect(json.last_sleep_pass.ts).toBe(now);
    expect(json.last_sleep_pass.duration_ms).toBeGreaterThan(0);
    expect(json.last_sleep_pass.duration_ms).toBeLessThanOrEqual(5 * 60_000 + 1000);
  });

  it('never emits an "ok"/"success" literal for last_sleep_pass.status', async () => {
    insertConsolidationEvent('ev-1', Date.now(), 'confirm', 'n-1');
    await restartServer();
    const r = await makeRequest(port, '/stats/brain-health');
    const json = JSON.parse(r.body) as { last_sleep_pass: { status: string } };
    expect(json.last_sleep_pass.status).not.toBe('ok');
    expect(json.last_sleep_pass.status).not.toBe('success');
    expect(json.last_sleep_pass.status).toBe('unknown');
  });

  it('returns 405 for non-GET methods', async () => {
    const r = await makeRequest(port, '/stats/brain-health', 'POST', '{}');
    expect(r.statusCode).toBe(405);
  });

  it('returns 403 for a non-loopback Host header (DNS-rebinding guard)', async () => {
    const r = await makeRequest(port, '/stats/brain-health', 'GET', undefined, 'evil.com');
    expect(r.statusCode).toBe(403);
  });
});
