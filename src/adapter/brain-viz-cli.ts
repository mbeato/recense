/**
 * brain viz — local brain-activation visualization launcher (VIZ-03).
 *
 * What it does:
 *   1. Opens a WRITE handle to brain.db solely to flip meta.viz_trace_enabled = '1' (D-96).
 *   2. Registers process exit handlers to restore the flag to '0' on any exit (runtime
 *      off-switch — the prior dogfood incident showed plan-ordering alone is not enough).
 *   3. Starts the read-only viz HTTP/SSE server on PORT (127.0.0.1 only, D-95/T-10-09).
 *   4. Opens a chromeless app-window (macOS: Google Chrome --app=<url>, D-103).
 *      Falls back to a plain browser tab if the app-window launch fails.
 *   5. Prints the URL to stdout for headless/CI runs.
 *
 * The write handle touches ONLY the meta table (viz_trace_enabled key).
 * It NEVER writes to node/edge — the graph stays read-only from the viz perspective.
 *
 * Design invariants:
 *   D-80: resolveDbPath() — owner-agnostic path, never hardcoded.
 *   D-95: viz server opens its own readonly DB handle (inside startVizServer).
 *   D-96: trace flag set ON at startup, restored OFF in all exit paths.
 *   D-103: chromeless app-window preferred; browser-tab fallback.
 *   T-10-08: only meta writes from this file; grep-asserted no upsertNode/upsertEdge/tombstone.
 *
 * Threat mitigations:
 *   T-10-08: write handle touches meta.viz_trace_enabled only; verified by acceptance grep.
 *   T-10-09: bind address enforced inside startVizServer (127.0.0.1 only).
 */

import { spawn } from 'child_process';
import Database from 'better-sqlite3';
import { initSchema } from '../db/schema';
import { DEFAULT_CONFIG } from '../lib/config';
import { realClock } from '../lib/clock';
import { SemanticStore } from '../db/semantic-store';
import { resolveDbPath } from './runtime-config';
import { startVizServer } from '../viz/server';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORT = 7810;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // D-80: owner-agnostic path resolution via resolveDbPath() (never hardcoded).
  const dbPath = resolveDbPath();

  // ── 1. Open write handle for flag flip (meta table only) ────────────────────
  const db = new Database(dbPath);
  initSchema(db);
  const config = { ...DEFAULT_CONFIG, dbPath };
  const store = new SemanticStore(db, realClock, config);

  // D-96: set trace flag ON so recall-cli / watcher-cli inject the SQLite sink.
  store.setMeta('viz_trace_enabled', '1');

  // ── 2. Exit handlers — restore flag so it never stays stuck ON ─────────────
  // The prior dogfood incident (gated-live-write-needs-real-offswitch) showed
  // that plan-ordering is not a gate; always register a runtime restore.
  process.on('exit', () => {
    try { store.setMeta('viz_trace_enabled', '0'); } catch { /* best-effort */ }
    try { db.close(); } catch { /* best-effort */ }
  });
  process.on('SIGINT',  () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  // ── 3. Start the read-only viz server (opens its own readonly DB handle) ────
  const url = `http://127.0.0.1:${PORT}`;
  startVizServer(dbPath, PORT);
  // The server's http.createServer().listen() keeps the event loop alive.

  // ── 4. Open a chromeless app-window (D-103) ─────────────────────────────────
  // macOS: 'open -a "Google Chrome" --args --app=<url>'
  // On failure (Chrome not installed, non-macOS, etc.) fall back to a plain browser tab.
  try {
    spawn('open', ['-a', 'Google Chrome', '--args', `--app=${url}`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch {
    // Browser-tab fallback: 'open <url>' uses the system default browser.
    try {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      // Headless/CI — URL already printed to stdout below; nothing more to do.
    }
  }

  // ── 5. Print URL to stdout (headless/CI usability) ─────────────────────────
  process.stdout.write(`brain viz → ${url}\n`);
  process.stdout.write('Press Ctrl-C to stop.\n');
}

main().catch((err: unknown) => {
  process.stderr.write(`brain viz fatal: ${err}\n`);
  process.exit(1);
});
