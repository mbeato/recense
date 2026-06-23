/**
 * Smoke test for the latency-curve.cjs script (D-06b, Plan 40-04 Task 3).
 *
 * Runs the script in --quick mode (single small N=200, 2 queries, mock embeddings)
 * and asserts:
 *  1. Exit code is 0
 *  2. Output JSON is written and parseable
 *  3. Envelope has a `curve` array with at least one entry
 *  4. Each curve entry has p50_ms and p95_ms numeric keys
 *  5. Each curve entry has n_nodes and samples keys
 *
 * Zero API calls: --quick implies --mock-embed (zero-vector embeddings).
 * Mirrors the spawnSync pattern from eval-harness-smoke.test.ts.
 */

import * as fs   from 'fs';
import * as os   from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { describe, it, expect, afterAll } from 'vitest';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HARNESS_PATH   = path.resolve(__dirname, '../scripts/eval/latency-curve.cjs');
const FIXTURE_POOL   = path.resolve(__dirname, '../scripts/eval/fixtures/locomo-node-pool.json');
const REPO_ROOT      = path.resolve(__dirname, '..');
const OUT_PATH       = path.join(os.tmpdir(), `latency-curve-smoke-${Date.now()}-${process.pid}.json`);

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(() => {
  try { fs.unlinkSync(OUT_PATH); } catch {}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('latency-curve.cjs smoke', () => {
  it('--quick exits 0, emits curve JSON with p50_ms and p95_ms keys', () => {
    // Verify pre-conditions
    expect(fs.existsSync(HARNESS_PATH)).toBe(true);
    expect(fs.existsSync(FIXTURE_POOL)).toBe(true);

    const result = spawnSync(
      process.execPath,
      [
        HARNESS_PATH,
        '--quick',
        '--n-list', '200',
        '--queries-per-n', '2',
        '--out', OUT_PATH,
      ],
      {
        encoding: 'utf8',
        cwd:      REPO_ROOT,
        timeout:  60_000,    // 60s — scratch DB population at N=200 is fast
      },
    );

    // 1. Exit 0
    if (result.status !== 0) {
      // Emit stdout/stderr for debugging when the test fails
      console.error('stdout:', result.stdout);
      console.error('stderr:', result.stderr);
    }
    expect(result.status).toBe(0);

    // 2. Output file written
    expect(fs.existsSync(OUT_PATH)).toBe(true);

    // 3. Parse output
    const raw = fs.readFileSync(OUT_PATH, 'utf8');
    const data = JSON.parse(raw) as {
      meta:  Record<string, unknown>;
      curve: Array<{
        n_nodes: number;
        p50_ms:  number;
        p95_ms:  number;
        samples: number;
      }>;
    };

    // 4. Envelope structure
    expect(data).toHaveProperty('meta');
    expect(data).toHaveProperty('curve');
    expect(Array.isArray(data.curve)).toBe(true);
    expect(data.curve.length).toBeGreaterThanOrEqual(1);

    // 5. Curve entry keys
    const entry = data.curve[0];
    expect(entry).toBeDefined();
    expect(typeof entry!.n_nodes).toBe('number');
    expect(typeof entry!.p50_ms).toBe('number');
    expect(typeof entry!.p95_ms).toBe('number');
    expect(typeof entry!.samples).toBe('number');
    expect(entry!.samples).toBeGreaterThanOrEqual(1);

    // 6. meta fields
    expect(data.meta.eval).toBe('latency-curve');
    expect(data.meta.mock_embed).toBe(true);
  });
});
