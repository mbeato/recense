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
 * Exported so tests can inspect / manipulate the lock file directly.
 *
 * DEBT-02: BRAIN_MEMORY_LOCK_PATH env override lets test processes redirect to a
 * per-pid path under tmpdir() so they never touch the production lock held by the
 * live watcher. When the env var is unset, behaviour is identical to before.
 */
export const LOCK_PATH =
  process.env['BRAIN_MEMORY_LOCK_PATH'] ?? join(tmpdir(), 'brain-memory-sleep.lock');

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
  // 1. Check for stale lock (process died without cleanup)
  if (existsSync(LOCK_PATH)) {
    try {
      const { mtimeMs } = statSync(LOCK_PATH);
      if (Date.now() - mtimeMs < LOCK_STALE_MS) return false; // fresh → held
    } catch {
      // File removed between existsSync + statSync by a concurrent unlink — fine.
    }
    // Stale (or just removed) — unlink and fall through to O_EXCL create
    try { unlinkSync(LOCK_PATH); } catch {
      // Another process cleaned it first — fine; the O_EXCL below resolves the race.
    }
  }

  // 2. Atomic create — 'wx' = O_WRONLY | O_CREAT | O_EXCL
  try {
    const fd = openSync(LOCK_PATH, 'wx');
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
  try {
    unlinkSync(LOCK_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}
