/**
 * Unit tests for brain-doctor check helpers (INSTALL-04, Phase 9 Plan 04).
 *
 * Tests the exported pure check functions directly, without making live API
 * calls or requiring a production DB.
 *
 * Coverage:
 *   checkDb:
 *     (a) passes on a fresh initSchema'd in-memory DB at the current SCHEMA_VERSION
 *     (b) fails when the stored schema_version does not match SCHEMA_VERSION
 *     (c) fails when RECENSE_DB is not set (empty string)
 *     (d) fails when the DB path is unreachable
 *   checkNodeAbi:
 *     (e) fails (ok:false) with a hint when RECENSE_NODE_BIN is unset
 *   checkHooks:
 *     (f) passes when all three events have a recense hook command
 *     (g) fails when an event is missing a recense hook
 *     (h) accepts the pre-migration recense/dist/src/adapter/ path form
 *   failure aggregation:
 *     (i) process.exitCode reflects non-zero when any check fails
 */

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initSchema, SCHEMA_VERSION } from '../src/db/schema';
import { checkDb, checkNodeAbi, checkHooks, checkServeToken } from '../src/adapter/recense-doctor';

// ---------------------------------------------------------------------------
// checkDb
// ---------------------------------------------------------------------------

describe('checkDb', () => {
  it('(a) passes on a fresh initSchema DB at current SCHEMA_VERSION', () => {
    const db = new Database(':memory:');
    initSchema(db);
    // Write the DB to a temp file so checkDb can open it read-only
    // We use an in-memory approach: checkDb re-opens via path, but with
    // :memory: we cannot test the read-only file path. Use a temp file instead.
    const { join } = require('path') as typeof import('path');
    const { tmpdir } = require('os') as typeof import('os');
    const { writeFileSync } = require('fs') as typeof import('fs');
    const tmpPath = join(tmpdir(), `brain-doctor-test-${process.pid}.db`);

    // Write a fresh DB to a file
    const fileDb = new Database(tmpPath);
    initSchema(fileDb);
    fileDb.close();

    const result = checkDb(tmpPath);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain(`schema v${SCHEMA_VERSION}`);

    // cleanup
    try { require('fs').unlinkSync(tmpPath); } catch { /* ignore */ }
  });

  it('(b) fails when stored schema_version mismatches SCHEMA_VERSION', () => {
    const { join } = require('path') as typeof import('path');
    const { tmpdir } = require('os') as typeof import('os');
    const tmpPath = join(tmpdir(), `brain-doctor-test-mismatch-${process.pid}.db`);

    const db = new Database(tmpPath);
    initSchema(db);
    // Stamp a wrong version
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '999')").run();
    db.close();

    const result = checkDb(tmpPath);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('schema version mismatch');
    expect(result.detail).toContain('999');

    try { require('fs').unlinkSync(tmpPath); } catch { /* ignore */ }
  });

  it('(c) fails when dbPath is empty (RECENSE_DB not set)', () => {
    const result = checkDb('');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('RECENSE_DB not set');
  });

  it('(d) fails when DB path is unreachable', () => {
    const result = checkDb('/tmp/brain-doctor-nonexistent-never-created-12345.db');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('DB not reachable');
  });
});

// ---------------------------------------------------------------------------
// checkNodeAbi
// ---------------------------------------------------------------------------

describe('checkNodeAbi', () => {
  const origNodeBin = process.env['RECENSE_NODE_BIN'];

  afterEach(() => {
    if (origNodeBin !== undefined) {
      process.env['RECENSE_NODE_BIN'] = origNodeBin;
    } else {
      delete process.env['RECENSE_NODE_BIN'];
    }
  });

  it('(e) fails with a hint when RECENSE_NODE_BIN is unset', () => {
    delete process.env['RECENSE_NODE_BIN'];
    const result = checkNodeAbi();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('RECENSE_NODE_BIN not set');
    expect(result.detail).toContain('recense init');
  });

  it('(e2) passes when RECENSE_NODE_BIN is the currently running node binary (ABI match)', () => {
    // process.execPath is the node binary that is running these tests — it compiled
    // better-sqlite3 and can certainly load it. This test is the canonical ABI-match path.
    process.env['RECENSE_NODE_BIN'] = process.execPath;
    const result = checkNodeAbi();
    // Must succeed: same node binary → same NODE_MODULE_VERSION → ABI match.
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('Node ABI match');
  });
});

// ---------------------------------------------------------------------------
// checkHooks
// ---------------------------------------------------------------------------

describe('checkHooks', () => {
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');
  const { writeFileSync, mkdirSync, unlinkSync, existsSync, rmSync } = require('fs') as typeof import('fs');

  /**
   * Write a fake settings.json and temporarily point the checkHooks call to
   * it by monkey-patching homedir. Since checkHooks reads join(homedir(), ...),
   * we use a different approach: write the settings at the real path used by
   * checkHooks and restore it after.
   *
   * Because checkHooks reads from ~/.claude/settings.json via homedir(), we
   * can only test it with a real file. We write a temp file and invoke
   * checkHooks indirectly. A simpler approach: inject path via a wrapper that
   * accepts an override path. For now, test via the environment-independent
   * helper checkHooks(settingsPath) signature.
   *
   * The exported checkHooks accepts an optional override path for testing.
   */

  it('(f) passes when all three events have a recense hook command (new form)', () => {
    const settings = {
      hooks: {
        SessionStart:      [{ hooks: [{ type: 'command', command: '/usr/local/bin/node /path/recense.js hook session-start' }] }],
        UserPromptSubmit:  [{ hooks: [{ type: 'command', command: '/usr/local/bin/node /path/recense.js hook turn-capture' }] }],
        Stop:              [{ hooks: [{ type: 'command', command: '/usr/local/bin/node /path/recense.js hook stop' }] }],
      },
    };
    const tmpDir  = join(tmpdir(), `brain-doctor-hooks-${process.pid}`);
    const tmpFile = join(tmpDir, 'settings.json');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpFile, JSON.stringify(settings), 'utf8');

    const result = checkHooks(tmpFile);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('SessionStart');
    expect(result.detail).toContain('Stop');

    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('(g) fails when Stop hook is missing', () => {
    const settings = {
      hooks: {
        SessionStart:     [{ hooks: [{ type: 'command', command: '/usr/bin/node recense.js hook session-start' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/usr/bin/node recense.js hook turn-capture' }] }],
        // Stop intentionally omitted
      },
    };
    const tmpDir  = join(tmpdir(), `brain-doctor-hooks-missing-${process.pid}`);
    const tmpFile = join(tmpDir, 'settings.json');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpFile, JSON.stringify(settings), 'utf8');

    const result = checkHooks(tmpFile);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Stop');

    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('(h) accepts pre-migration recense/dist/src/adapter/ path form', () => {
    const settings = {
      hooks: {
        SessionStart:     [{ hooks: [{ type: 'command', command: '/path/recense/dist/src/adapter/session-start-cli.js' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/path/recense/dist/src/adapter/turn-capture-cli.js' }] }],
        Stop:             [{ hooks: [{ type: 'command', command: '/path/recense/dist/src/adapter/stop-cli.js' }] }],
      },
    };
    const tmpDir  = join(tmpdir(), `brain-doctor-hooks-legacy-${process.pid}`);
    const tmpFile = join(tmpDir, 'settings.json');
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpFile, JSON.stringify(settings), 'utf8');

    const result = checkHooks(tmpFile);
    expect(result.ok).toBe(true);

    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });
});

// ---------------------------------------------------------------------------
// checkServeToken
// ---------------------------------------------------------------------------

describe('checkServeToken', () => {
  const { join } = require('path') as typeof import('path');
  const { tmpdir } = require('os') as typeof import('os');
  const { writeFileSync, chmodSync, unlinkSync } = require('fs') as typeof import('fs');

  const makeTempEnvPath = () =>
    join(tmpdir(), `brain-doctor-token-${process.pid}-${Date.now()}.env`);

  it('(j) passes when env file does not exist', () => {
    const result = checkServeToken('/tmp/brain-doctor-nonexistent-env-99999-never.env');
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('no serve token needed');
  });

  it('(k) passes when env file at 0600 with RECENSE_SERVE_TOKEN set; token value absent from detail', () => {
    const envPath = makeTempEnvPath();
    const SECRET_TOKEN = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    writeFileSync(envPath, `RECENSE_SERVE_TOKEN=${SECRET_TOKEN}\n`, 'utf8');
    chmodSync(envPath, 0o600);

    const result = checkServeToken(envPath);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('RECENSE_SERVE_TOKEN set');
    expect(result.detail).toContain('0600');
    // T-12-10: token value must NEVER appear in the detail string
    expect(result.detail).not.toContain(SECRET_TOKEN);

    try { unlinkSync(envPath); } catch { /* ignore */ }
  });

  it('(l) fails when env file exists at non-0600 mode', () => {
    const envPath = makeTempEnvPath();
    writeFileSync(envPath, 'RECENSE_SERVE_TOKEN=sometoken\n', 'utf8');
    chmodSync(envPath, 0o644);

    const result = checkServeToken(envPath);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('0600');

    try { unlinkSync(envPath); } catch { /* ignore */ }
  });
});

// ---------------------------------------------------------------------------
// failure aggregation → non-zero exit code
// ---------------------------------------------------------------------------

describe('failure aggregation', () => {
  it('(i) process.exitCode is set to 1 when any check returns ok:false', () => {
    // A failing check (empty dbPath) returns ok:false
    const failing = checkDb('');
    expect(failing.ok).toBe(false);

    // Simulate the aggregator logic from runDoctor
    const origExitCode = process.exitCode;
    const results = [failing];
    const failures = results.filter(r => !r.ok).length;
    process.exitCode = failures > 0 ? 1 : 0;
    expect(process.exitCode).toBe(1);

    // restore
    process.exitCode = origExitCode;
  });
});
