/**
 * server-lifecycle — viz server attach-or-spawn with crash backoff and D-96 SIGTERM.
 *
 * Design invariants:
 *   D-07:  if port 7810 is already serving, attach instead of spawning a second server.
 *   L-10:  abort with MissingDbError when recense.db is absent (caller shows dialog + quits).
 *   D-96:  the spawned child owns viz_trace_enabled via its own exit handlers.
 *          The tray's sole obligation is to SIGTERM the child on all quit paths.
 *          Never open a second DB write handle for the flag from here.
 *   T-16-03: spawn on resolveNodeBin() (pinned system node), NEVER on the Electron binary.
 *            Pass ONLY RECENSE_DB additively. Do not add NODE_MODE env vars to child.
 *   T-16-05: pipe child output to append-only /tmp/recense-tray.log — never tray stdout.
 *   T-16-06: exponential backoff (1s→30s cap) with a `stopping` guard prevents tight respawn
 *            loops on a persistently-failing server. At most ONE respawn timer is ever
 *            pending (scheduleRespawn is a no-op while a timer is live), and the backoff
 *            delay is a single module-level monotonic value shared by every trigger path —
 *            stacked timers + per-call delays were the 11,755-spawn storm.
 */

import { appendFileSync, existsSync } from 'fs';
import { ChildProcess, spawn } from 'child_process';
import { resolveNodeBin, resolveBrainJs, resolveDbPath } from './runtime-paths';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOG_PATH = '/tmp/recense-tray.log';
const HEALTH_PORT = 7810;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

// ---------------------------------------------------------------------------
// Logging (append-only file — never tray stdout, T-16-05)
// ---------------------------------------------------------------------------

function log(msg: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] lifecycle: ${msg}\n`);
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Handle returned by ensureServer().
 *   attached=true  — server was already running; no child owned by the tray.
 *   attached=false — server spawned by this call; child is the live process.
 */
export interface ServerHandle {
  attached: boolean;
  child: ChildProcess | null;
}

/**
 * Thrown by ensureServer() when recense.db is missing (L-10).
 * The 16-05 caller converts this to dialog.showErrorBox + app.quit.
 */
export class MissingDbError extends Error {
  readonly dbPath: string;
  constructor(dbPath: string) {
    super(`recense viz: DB not found at ${dbPath} — run \`recense init\` first`);
    this.name = 'MissingDbError';
    this.dbPath = dbPath;
  }
}

/**
 * Thrown by ensureServer() when recense.js cannot be resolved.
 */
export class MissingBrainJsError extends Error {
  constructor() {
    super(
      'recense viz: cannot resolve recense.js entry — ' +
        'set RECENSE_JS or RECENSE_SLEEP_JS in sleep.env',
    );
    this.name = 'MissingBrainJsError';
  }
}

/** Options for ensureServer(). */
export interface EnsureServerOpts {
  /**
   * Called when the spawned server becomes unhealthy (unexpected exit).
   * Wire this to a "dim tray icon" function in the main orchestrator.
   */
  onUnhealthy?: () => void;
  /**
   * Called when a respawned server passes its health check (recovered from crash).
   * Wire this to a "restore tray icon" function in the main orchestrator.
   */
  onHealthy?: () => void;
  /**
   * argv override for resolveDbPath() — for testing; defaults to process.argv.
   */
  argv?: string[];
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Set to true by stopServer() to prevent the crash-backoff loop from
 * respawning during deliberate tray quit. Reset to false by ensureServer()
 * AFTER its health-check await (and only if stopServer() did not fire during
 * that yield) so the tray can respawn after a stop+restart cycle without
 * erasing an in-flight quit signal.
 */
let stopping = false;

/** Active backoff timer, if any. Cleared by stopServer(). */
let backoffTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Monotonic backoff delay shared across ALL respawn-trigger paths (child exit,
 * health-check failure, respawn error). Each scheduling attempt doubles it
 * (capped at BACKOFF_CAP_MS); a healthy respawn or stopServer() resets it to
 * BACKOFF_INITIAL_MS. Per-call delays let insta-crashing children loop at 1s
 * forever — this shared value is what makes escalation actually monotonic.
 */
let respawnDelayMs = BACKOFF_INITIAL_MS;

/**
 * Most recently spawned child process.
 *
 * Tracked separately from the ServerHandle returned by ensureServer() so
 * that stopServer() can SIGTERM the live child even after a crash-backoff
 * cycle replaced the original child with a new one (D-96 correctness).
 */
let activeChild: ChildProcess | null = null;

// ---------------------------------------------------------------------------
// isServerRunning
// ---------------------------------------------------------------------------

/**
 * Probe the viz server health by GETting /graph.
 *
 * /graph is the lightest available endpoint — no /health exists (server.ts LOCKED).
 * Returns true when the response status is 2xx; false on any error.
 */
export async function isServerRunning(port: number = HEALTH_PORT): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/graph`);
    return r.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// ensureServer
// ---------------------------------------------------------------------------

/**
 * Attach to the viz server if port 7810 is already bound (D-07), else spawn it.
 *
 * Spawn shape: spawn(nodeBin, [brainJs, 'viz', '--no-open'], {
 *   env: { ...process.env, RECENSE_DB: dbPath }, stdio: 'pipe' })
 *
 * Crash backoff is registered on the spawned child's 'exit' event.
 *
 * @throws MissingDbError   if recense.db does not exist (L-10).
 * @throws MissingBrainJsError if recense.js entry cannot be resolved.
 */
export async function ensureServer(opts: EnsureServerOpts = {}): Promise<ServerHandle> {
  // D-07: attach path — no second server if one is already running on 7810
  if (await isServerRunning(HEALTH_PORT)) {
    log('attached to existing server on port 7810 (D-07)');
    return { attached: true, child: null };
  }

  // Re-check after the async yield above: stopServer() may have fired during
  // the health check (e.g., before-quit racing a backoff retry that already
  // passed its `stopping` guard). Abort instead of resetting the quit guard
  // below and spawning a child that nothing will ever SIGTERM (D-96).
  if (stopping) {
    log('ensureServer aborted — stopServer() fired during health check');
    return { attached: false, child: null };
  }

  // Allow respawn after a previous stop+restart cycle. Everything from here
  // to spawn() is synchronous, so stopServer() cannot interleave again.
  stopping = false;

  // L-10: guard — abort with typed error when recense.db is missing
  const dbPath = resolveDbPath(opts.argv);
  if (!existsSync(dbPath)) {
    throw new MissingDbError(dbPath);
  }

  // ABI: resolve pinned system node (never the Electron binary — T-16-03)
  const nodeBin = resolveNodeBin();
  const brainJs = resolveBrainJs();
  if (!brainJs) {
    throw new MissingBrainJsError();
  }

  // Spawn the viz server child.
  // - NOT detached: tray owns the child lifecycle.
  // - stdio: 'pipe': output piped to append-only log (never tray stdout — T-16-05).
  // - Pass ONLY RECENSE_DB additively. No extra NODE_MODE vars (T-16-03).
  const child = spawn(nodeBin, [brainJs, 'viz', '--no-open'], {
    env: { ...process.env, RECENSE_DB: dbPath },
    stdio: 'pipe',
  });
  // Track the active child so stopServer() can SIGTERM the live process even
  // after a crash-backoff cycle spawned a replacement child (D-96 correctness).
  activeChild = child;

  // T-16-05: pipe child stdout/stderr to the append-only log file
  child.stdout?.on('data', (chunk: Buffer) => {
    try { appendFileSync(LOG_PATH, chunk); } catch { /* best-effort */ }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    try { appendFileSync(LOG_PATH, chunk); } catch { /* best-effort */ }
  });

  child.on('error', (err: Error) => {
    log(`server process error: ${err.message}`);
  });

  // T-16-06: crash backoff — respawn with exponential delay (1s → 30s cap)
  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    log(`server exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
    if (!stopping) {
      opts.onUnhealthy?.();
      scheduleRespawn(opts, respawnDelayMs);
      respawnDelayMs = Math.min(respawnDelayMs * 2, BACKOFF_CAP_MS);
    }
  });

  log(`spawned server (pid=${child.pid ?? 'unknown'}) nodeBin=${nodeBin}`);
  return { attached: false, child };
}

// ---------------------------------------------------------------------------
// stopServer
// ---------------------------------------------------------------------------

/**
 * Gracefully stop the managed viz server.
 *
 * D-96: SIGTERM triggers the child's process.on('exit') handler which restores
 * viz_trace_enabled = '0'. The tray must NEVER open a second DB write handle
 * for the flag — the child owns it.
 *
 * Sets `stopping = true` to suppress the crash-backoff respawn loop.
 * Clears any pending backoff timer.
 * All operations are best-effort (never throws).
 */
export function stopServer(handle: ServerHandle): void {
  try {
    stopping = true;
    if (backoffTimer !== null) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
    }
    // Fresh backoff for the next stop/restart cycle.
    respawnDelayMs = BACKOFF_INITIAL_MS;
    // D-96: SIGTERM so the child's exit handler restores viz_trace_enabled OFF.
    // Use activeChild (most recently spawned child) rather than handle.child so
    // that a crash-backoff respawn cycle does not leave the replacement child
    // running after quit (D-96 correctness with backoff respawn).
    const toKill = activeChild ?? handle.child;
    toKill?.kill('SIGTERM');
    activeChild = null;
    log('stopServer: SIGTERM sent to child (D-96)');
  } catch { /* best-effort — never throw in cleanup */ }
}

// ---------------------------------------------------------------------------
// Internal: exponential backoff respawn
// ---------------------------------------------------------------------------

/**
 * Schedule a server respawn after `delayMs` milliseconds.
 *
 * Single-flight: at most one respawn timer is ever pending — a call while a
 * timer is live is a no-op (stacked timers were the respawn-storm multiplier).
 * Callers pass the module-level `respawnDelayMs` and double it after the call,
 * so escalation is monotonic (1s → 2s → 4s → ... → BACKOFF_CAP_MS) across all
 * trigger paths. A successful health check after a respawn resets the delay;
 * so does stopServer(). The `stopping` guard prevents respawn during
 * deliberate tray quit (T-16-06).
 */
function scheduleRespawn(opts: EnsureServerOpts, delayMs: number): void {
  if (stopping) return;
  // Single-flight guard: a respawn is already pending — never stack a second
  // timer (this was the storm multiplier: each failure cycle scheduled twice,
  // doubling the live-timer population every cycle).
  if (backoffTimer !== null) return;
  const cappedDelay = Math.min(delayMs, BACKOFF_CAP_MS);
  log(`scheduling respawn in ${cappedDelay}ms`);

  backoffTimer = setTimeout(() => {
    backoffTimer = null;
    if (stopping) return;

    ensureServer(opts)
      .then(async (_handle) => {
        // Verify the new server is actually healthy
        const healthy = await isServerRunning(HEALTH_PORT);
        if (!healthy) {
          log('respawned server failed health check — doubling backoff');
          opts.onUnhealthy?.();
          scheduleRespawn(opts, respawnDelayMs);
          respawnDelayMs = Math.min(respawnDelayMs * 2, BACKOFF_CAP_MS);
        } else {
          log('respawned server is healthy (backoff reset)');
          respawnDelayMs = BACKOFF_INITIAL_MS;
          // Notify the main orchestrator so it can restore the tray icon state
          opts.onHealthy?.();
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`respawn error: ${msg}`);
        scheduleRespawn(opts, respawnDelayMs);
        respawnDelayMs = Math.min(respawnDelayMs * 2, BACKOFF_CAP_MS);
      });
  }, cappedDelay);
}
