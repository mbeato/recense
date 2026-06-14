/**
 * runtime-paths — ABI-safe path resolution for the tray app.
 *
 * This module is INTENTIONALLY isolated from the engine (apps/tray is a
 * separate package with no engine dependency). It replicates the pure logic
 * from engine files — DO NOT import from src/:
 *   - src/adapter/pin-node.ts   (readPinnedNodeBin)
 *   - src/adapter/runtime-config.ts (defaultDbPath, sleepEnvPath, resolveDbPath)
 *
 * Only node builtins are used: fs, os, path.
 *
 * ABI invariant: resolveNodeBin() NEVER returns the Electron binary path.
 * In an Electron process, the runtime executable IS Electron — spawning
 * a child with it would use Electron's bundled Node, which is ABI-incompatible
 * with the system-compiled better-sqlite3 addon.
 *
 * Security (T-16-04): reads ONLY the RECENSE_NODE_BIN and
 * RECENSE_SLEEP_JS lines via targeted regex; never sources or echoes
 * the full sleep.env file (which carries API keys and tokens).
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * The one true default DB location.
 * Must stay in sync with src/adapter/runtime-config.ts defaultDbPath().
 */
export function defaultDbPath(): string {
  return join(homedir(), '.config', 'recense', 'recense.db');
}

/**
 * Default location of the sleep.env file written by `recense init` (chmod-600).
 * Must stay in sync with src/adapter/runtime-config.ts sleepEnvPath().
 */
export function sleepEnvPath(): string {
  return (
    process.env['RECENSE_SLEEP_ENV'] ??
    join(homedir(), '.config', 'recense', 'sleep.env')
  );
}

// ---------------------------------------------------------------------------
// Node binary resolution (ABI guard)
// ---------------------------------------------------------------------------

/**
 * Resolve the ABI-safe node binary for spawning the viz server child process.
 *
 * Precedence (mirrors readPinnedNodeBin from src/adapter/pin-node.ts):
 *   1. RECENSE_NODE_BIN env var — trimmed; wins if non-empty
 *   2. RECENSE_NODE_BIN= line in sleep.env — surrounding quotes stripped
 *   3. Literal 'node' — PATH-resolved; works when launched from a shell
 *
 * NEVER returns the Electron binary path — that will cause a guaranteed
 * better-sqlite3 ABI crash (NODE_MODULE_VERSION mismatch).
 *
 * File reads are best-effort (any error falls through to the 'node' fallback).
 */
export function resolveNodeBin(): string {
  // 1. Env var wins (trimmed)
  const fromEnv = process.env['RECENSE_NODE_BIN'];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  // 2. Parse RECENSE_NODE_BIN from sleep.env
  const envFile = sleepEnvPath();
  try {
    if (existsSync(envFile)) {
      for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
        const m = line.match(/^\s*RECENSE_NODE_BIN\s*=\s*(.+?)\s*$/);
        if (m) {
          const val = m[1]!.replace(/^['"]|['"]$/g, '').trim();
          if (val) return val;
        }
      }
    }
  } catch {
    // best-effort — fall through to default
  }

  // 3. Fallback: PATH-resolved 'node' (never the Electron binary)
  return 'node';
}

// ---------------------------------------------------------------------------
// brain.js entry resolution
// ---------------------------------------------------------------------------

/**
 * Derive the brain.js CLI entry point for the viz server child.
 *
 * Precedence:
 *   1. RECENSE_BRAIN_JS env var — explicit override
 *   2. Sibling brain.js of RECENSE_SLEEP_JS from sleep.env:
 *      dirname(RECENSE_SLEEP_JS) + '/brain.js'
 *   3. undefined — path unresolvable; caller must error
 *
 * The sleep.env line RECENSE_SLEEP_JS points at e.g.:
 *   /repo/dist/src/adapter/sleep-pass-cli.js
 * brain.js is the sibling dispatcher in the same dist/src/adapter/ directory.
 *
 * File reads are best-effort (any error returns undefined).
 */
export function resolveBrainJs(): string | undefined {
  // 1. Explicit env override
  const fromEnv = process.env['RECENSE_BRAIN_JS'];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  // 2. Parse RECENSE_SLEEP_JS from sleep.env, derive sibling brain.js
  const envFile = sleepEnvPath();
  try {
    if (existsSync(envFile)) {
      for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
        const m = line.match(/^\s*RECENSE_SLEEP_JS\s*=\s*(.+?)\s*$/);
        if (m) {
          const val = m[1]!.replace(/^['"]|['"]$/g, '').trim();
          if (val) return join(dirname(val), 'brain.js');
        }
      }
    }
  } catch {
    // best-effort — fall through
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// DB path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the DB path for hook/CLI invocations.
 *
 * Precedence (mirrors resolveDbPath from src/adapter/runtime-config.ts):
 *   1. --db <path> argv flag
 *   2. RECENSE_DB env var
 *   3. defaultDbPath()
 *
 * `argv` defaults to process.argv so callers can omit it.
 */
export function resolveDbPath(argv: string[] = process.argv): string {
  const i = argv.indexOf('--db');
  if (i !== -1 && typeof argv[i + 1] === 'string' && argv[i + 1] !== '') {
    return argv[i + 1] as string;
  }
  const fromEnv = process.env['RECENSE_DB'];
  if (fromEnv !== undefined) return fromEnv;
  // GUI apps launched from Finder/Dock do NOT inherit shell env, so a system
  // configured via sleep.env (setup-dogfood.sh writes RECENSE_DB there;
  // the launchd agents load it) would silently fall through to the default —
  // an empty DB — and the viz shows zero nodes. Read the engine's own config
  // file before falling back (founder hit this 2026-06-12: 1811-node repo DB
  // vs empty default DB).
  const fromSleepEnv = readSleepEnvDb();
  if (fromSleepEnv !== undefined) return fromSleepEnv;
  return defaultDbPath();
}

/** Parse RECENSE_DB out of sleep.env (best-effort; undefined if absent). */
function readSleepEnvDb(): string | undefined {
  try {
    const content = readFileSync(sleepEnvPath(), 'utf8');
    const m = content.match(/^\s*RECENSE_DB=(.+)\s*$/m);
    const v = m && m[1] ? m[1].trim().replace(/^["']|["']$/g, '') : '';
    return v !== '' ? v : undefined;
  } catch {
    return undefined; // no sleep.env — fresh install, default path is correct
  }
}
