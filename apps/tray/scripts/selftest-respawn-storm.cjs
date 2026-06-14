#!/usr/bin/env node
'use strict';

/**
 * Zero-framework self-test for the T-16-06 respawn-storm fix in
 * server-lifecycle.ts (compiled to dist/src/server-lifecycle.js).
 *
 * Reproduces the exact conditions of the 11,755-spawn storm observed in the
 * packaged app: port 7810 held by an UNHEALTHY listener (answers HTTP 500, so
 * isServerRunning() reads "not running" and ensureServer() takes the spawn
 * path) while the spawned child insta-crashes (EADDRINUSE in the real storm;
 * an exit-1 stub here). Pre-fix code stacked respawn timers (each failure
 * cycle scheduled twice, silently overwriting the live timer reference) and
 * always re-armed at BACKOFF_INITIAL_MS — yielding hundreds of spawns in
 * seconds. Fixed code is single-flight with a monotonic module-level delay:
 * ~3-4 spawns in 10 seconds.
 *
 * Asserts: spawn count over 10 real seconds is <= 5.
 *
 * Precondition: port 7810 must be FREE (quit the tray / viz server first).
 * If the port is busy this test exits 2 with a message — it never kills
 * whatever holds the port.
 *
 * Run: npm run build && node scripts/selftest-respawn-storm.cjs
 * Exit: 0 = pass, 1 = assertion failure, 2 = port 7810 busy.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const PORT = 7810;
const RUN_MS = 10_000;
const MAX_SPAWNS = 5;

// ── Temp fixtures ─────────────────────────────────────────────────────────────

const stamp = `${Date.now()}-${process.pid}`;
const spawnCountFile = path.join(os.tmpdir(), `selftest-respawn-count-${stamp}.txt`);
const crashScript = path.join(os.tmpdir(), `selftest-respawn-crash-${stamp}.js`);
const fakeDb = path.join(os.tmpdir(), `selftest-respawn-db-${stamp}.db`);

fs.writeFileSync(spawnCountFile, '');
fs.writeFileSync(fakeDb, '');
// Instrumented insta-crashing child: record one line per spawn, exit 1.
// The spawn-count file path is baked in so no env plumbing is needed.
fs.writeFileSync(
  crashScript,
  `require('fs').appendFileSync(${JSON.stringify(spawnCountFile)}, 'spawn\\n');\n` +
    'process.exit(1);\n',
);

function cleanup() {
  for (const f of [spawnCountFile, crashScript, fakeDb]) {
    try { fs.unlinkSync(f); } catch { /* best-effort */ }
  }
}

// ── Env overrides (win over sleep.env per runtime-paths resolution) ──────────
// Set BEFORE requiring the lifecycle module so no real config is read/touched.

process.env.RECENSE_NODE_BIN = process.execPath;
process.env.RECENSE_JS = crashScript;
process.env.RECENSE_DB = fakeDb;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Preflight: hold port 7810 with an unhealthy (HTTP 500) listener so
  // isServerRunning() sees "not running" while the real port stays bound.
  const unhealthy = http.createServer((_req, res) => {
    res.statusCode = 500;
    res.end('unhealthy');
  });

  await new Promise((resolve) => {
    unhealthy.once('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error(`port ${PORT} busy — quit the tray / viz server first`);
        cleanup();
        process.exit(2);
      }
      console.error(`unexpected listen error: ${err.message}`);
      cleanup();
      process.exit(2);
    });
    unhealthy.listen(PORT, '127.0.0.1', resolve);
  });

  // Require the COMPILED module only after env overrides are in place.
  // Note: rootDir="." with include=["src"] → output lands at dist/src/.
  const { ensureServer, stopServer } = require('../dist/src/server-lifecycle');

  console.log(`storm conditions armed: 500-listener on :${PORT}, insta-crash child`);
  const handle = await ensureServer({});

  // Let the respawn machinery run under storm conditions for 10 real seconds.
  await new Promise((resolve) => setTimeout(resolve, RUN_MS));

  // Tear down: clears the pending backoff timer + sets `stopping` so the
  // process can exit cleanly.
  stopServer(handle);
  await new Promise((resolve) => unhealthy.close(resolve));

  const spawnCount = fs
    .readFileSync(spawnCountFile, 'utf8')
    .split('\n')
    .filter(Boolean).length;
  console.log(`spawn count over ${RUN_MS / 1000}s: ${spawnCount} (max allowed: ${MAX_SPAWNS})`);

  try {
    assert.ok(
      spawnCount <= MAX_SPAWNS,
      `respawn storm: ${spawnCount} spawns in ${RUN_MS / 1000}s (expected <= ${MAX_SPAWNS})`,
    );
    assert.ok(spawnCount >= 1, 'expected at least one spawn — harness broken?');
    console.log('\n  PASS  respawn storm bounded by single-flight timer + monotonic backoff');
    cleanup();
    process.exit(0);
  } catch (err) {
    console.error(`\n  FAIL  ${err.message}`);
    cleanup();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`  FAIL  unexpected error: ${err.message}`);
  cleanup();
  process.exit(1);
});
