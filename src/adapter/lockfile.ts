/**
 * Hand-rolled O_EXCL cross-process lockfile for the sleep pass (D-31, spec §8).
 *
 * Zero external dependencies — uses Node.js 'fs' stdlib only.
 *
 * Atomic guarantee: openSync(path, 'wx') maps to open(2) with O_EXCL.
 * Exactly one caller wins the race; the loser gets EEXIST and returns false.
 *
 * Stale detection: a lock whose mtime is older than LOCK_STALE_MS is treated as
 * abandoned (process died without cleanup). The next acquireLock() reclaims it.
 *
 * TOCTOU note: the exists+stat+unlink → open('wx') sequence has a tiny window
 * where two processes both pass the stale check. O_EXCL ensures only one wins.
 * This is correct for a non-safety-critical local background pass.
 *
 * Threat mitigations:
 *  - T-03-2-Tlock: atomic O_EXCL create; EEXIST loser returns false.
 */
import { openSync, writeSync, closeSync, unlinkSync, statSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Default lock path (module-level constant, backward-compat export).
 * Tests that need the hermetic per-pid path should read `getLockPath()` or
 * set `process.env['BRAIN_MEMORY_LOCK_PATH']` before calling acquireLock/releaseLock.
 *
 * Exported so tests can reference the default value when needed.
 */
export const LOCK_PATH = join(tmpdir(), 'brain-memory-sleep.lock');

/**
 * DEBT-02: resolve the effective lock path at CALL TIME (not module-load time).
 *
 * TypeScript `import` statements are hoisted before user code runs, which means
 * any `process.env` assignment in a test file happens AFTER this module is loaded.
 * Reading the env var inside each function ensures the override is visible even
 * when set after the module has already been imported.
 *
 * Returns `BRAIN_MEMORY_LOCK_PATH` env var if set, otherwise the default LOCK_PATH.
 * Zero production-behavior change when the env var is unset.
 */
function getLockPath(): string {
  return process.env['BRAIN_MEMORY_LOCK_PATH'] ?? LOCK_PATH;
}

/**
 * 5 minutes — the sleep pass should complete well within this window.
 * If a future API-heavy run approaches this limit, switch to `proper-lockfile`
 * with a generous `stale` value. For now, hand-rolled is sufficient.
 */
export const LOCK_STALE_MS = 5 * 60 * 1000;

/**
 * Attempt to acquire the sleep-pass lock.
 *
 * Returns true  → lock acquired; caller may proceed.
 * Returns false → lock is held by another live process; caller should exit 0.
 * Throws        → unexpected FS error (not EEXIST); caller propagates.
 */
export function acquireLock(): boolean {
  const lockPath = getLockPath();
  // 1. Check for stale lock (process died without cleanup)
  if (existsSync(lockPath)) {
    try {
      const { mtimeMs } = statSync(lockPath);
      if (Date.now() - mtimeMs < LOCK_STALE_MS) return false; // fresh → held
    } catch {
      // File removed between existsSync + statSync by a concurrent unlink — fine.
    }
    // Stale (or just removed) — unlink and fall through to O_EXCL create
    try { unlinkSync(lockPath); } catch {
      // Another process cleaned it first — fine; the O_EXCL below resolves the race.
    }
  }

  // 2. Atomic create — 'wx' = O_WRONLY | O_CREAT | O_EXCL
  try {
    const fd = openSync(lockPath, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false; // lost the race
    throw err; // unexpected FS error — propagate to caller
  }
}

/**
 * Release the sleep-pass lock.
 * Best-effort: ignores ENOENT (already removed by a concurrent releaseLock or
 * stale-reclaim). All other errors propagate.
 */
export function releaseLock(): void {
  const lockPath = getLockPath();
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}
