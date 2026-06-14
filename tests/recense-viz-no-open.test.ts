/**
 * tests/brain-viz-no-open.test.ts — integration test for `recense viz --no-open` (OQ-1).
 *
 * Verifies:
 *   1. `node dist/src/adapter/brain-viz-cli.js --no-open --db <tempdb>` starts the
 *      HTTP server (GET /graph → HTTP 200 with { nodes, links } arrays) without opening
 *      a browser window.
 *   2. D-96: meta.viz_trace_enabled = '1' while the server is running.
 *   3. D-96: meta.viz_trace_enabled = '0' after the server receives SIGTERM.
 *
 * This test binds an ephemeral free port (--port) so it never collides with the
 * tray-owned viz server on 7810. Run it serially:
 *   npx vitest run tests/brain-viz-no-open.test.ts
 *
 * The child is killed in afterEach/finally even on assertion failure (no port leak).
 * Build-gated: spawns dist/src/adapter/brain-viz-cli.js — requires `npm run build` first.
 */

import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { createServer } from 'net';
import Database from 'better-sqlite3';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';

const BRAIN_VIZ_JS = join(__dirname, '..', 'dist', 'src', 'adapter', 'brain-viz-cli.js');
const SKIP_NO_DIST = !existsSync(BRAIN_VIZ_JS);
// Never use the default 7810 here — the live Recense tray keeps a viz server
// on it, and polling that server makes /graph succeed against the wrong DB.
let VIZ_URL = '';

/** Ask the OS for a free ephemeral port. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new Error('could not allocate a free port')));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll url + path until HTTP 200, up to timeoutMs. Returns the parsed JSON body or null. */
async function pollUntilOk(
  path: string,
  timeoutMs = 5000,
  intervalMs = 250,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${VIZ_URL}${path}`);
      if (r.ok) return r.json();
    } catch {
      // server not up yet — keep polling
    }
    await new Promise<void>(res => setTimeout(res, intervalMs));
  }
  return null;
}

/** Synchronously read the viz_trace_enabled meta value from the DB (read-only handle). */
function readTraceFlag(dbPath: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'viz_trace_enabled'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

/** Wait for a child process to exit, resolving with its exit code. */
function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Force-kill if it hasn't exited in time
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP_NO_DIST).sequential('recense viz --no-open (OQ-1 / D-96)', () => {
  let tmpDir: string;
  let dbPath: string;
  let child: ChildProcess | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'brain-viz-no-open-'));
    dbPath = join(tmpDir, 'recense.db');
    // Seed the DB file so brain-viz-cli L-10 guard passes
    const db = new Database(dbPath);
    initSchema(db);
    db.close();
  });

  afterEach(async () => {
    // Always kill the child so the port is released — even if the test threw
    if (child && !child.killed) {
      child.kill('SIGTERM');
      // Give it a moment to clean up before the next test or teardown
      await new Promise<void>(res => setTimeout(res, 300));
    }
    child = null;
    try { rmSync(tmpDir, { recursive: true }); } catch { /* best-effort */ }
  });

  it('serves /graph and restores D-96 trace flag after SIGTERM', async () => {
    // ── Spawn the CLI in server-only (--no-open) mode on a free port ─────────
    const port = await getFreePort();
    VIZ_URL = `http://127.0.0.1:${port}`;
    child = spawn(
      process.execPath,
      [BRAIN_VIZ_JS, '--no-open', '--db', dbPath, '--port', String(port)],
      {
        env: process.env,
        stdio: 'pipe',
      },
    );

    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });

    // ── Wait for /graph to respond ───────────────────────────────────────────
    const graphData = await pollUntilOk('/graph');

    expect(
      graphData,
      `Server did not start within 5s.\nstderr: ${stderr}\nstdout: ${stdout}`,
    ).not.toBeNull();

    const g = graphData as { nodes: unknown; links: unknown };
    expect(Array.isArray(g.nodes), '/graph response should have a nodes array').toBe(true);
    expect(Array.isArray(g.links), '/graph response should have a links array').toBe(true);

    // ── D-96: trace flag should be '1' while the server is running ───────────
    const flagWhileRunning = readTraceFlag(dbPath);
    expect(
      flagWhileRunning,
      `viz_trace_enabled should be '1' while server is running (got '${flagWhileRunning}')`,
    ).toBe('1');

    // ── SIGTERM the child and wait for exit ──────────────────────────────────
    child.kill('SIGTERM');
    const exitCode = await waitForExit(child, 5000);
    // Signal-terminated processes exit with null code on Linux/macOS — accept that.
    // What matters is that the process exited (exitCode !== undefined via the timeout path).
    expect(exitCode === 0 || exitCode === null, `Process should have exited (code: ${exitCode})`).toBe(true);

    // ── D-96: trace flag must be '0' after exit ──────────────────────────────
    // Give SQLite a moment to flush the WAL if applicable
    await new Promise<void>(res => setTimeout(res, 100));
    const flagAfterExit = readTraceFlag(dbPath);
    expect(
      flagAfterExit,
      `viz_trace_enabled should be '0' after SIGTERM (got '${flagAfterExit}')`,
    ).toBe('0');
  }, 20_000); // generous timeout: server start + SIGTERM round-trip
});
