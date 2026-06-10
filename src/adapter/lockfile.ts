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
import { openSync, writeSync, closeSync, unlinkSync, statSync, existsSync, readFileSync, renameSync, utimesSync } from 'fs';
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
 * 30 minutes (WR-02) — comfortably beyond a worst-case API-bound pass.
 *
 * The previous 5-minute window was a real single-writer hazard: a sleep/ingest
 * pass making per-episode Haiku + embedding calls can exceed 5 min on a backlog or
 * under rate-limiting, at which point a *live* pass looks stale and gets reclaimed
 * → two concurrent graph writers. 30 min makes a false-stale reclaim of a healthy
 * pass extremely unlikely. The complementary defense is ownership-checked release
 * (see releaseLock): even if a reclaim happens, the slow original will not delete
 * the new owner's lock. If a future run can legitimately exceed 30 min, switch to
 * `proper-lockfile` with mtime heartbeats.
 */
export const LOCK_STALE_MS = 30 * 60 * 1000;

/**
 * Attempt to acquire the sleep-pass lock.
 *
 * Returns true  → lock acquired; caller may proceed.
 * Returns false → lock is held by another live process; caller should exit 0.
 * Throws        → unexpected FS error (not EEXIST / ENOENT); caller propagates.
 *
 * Stale-takeover TOCTOU fix (H-4a): instead of unlinkSync + openSync('wx') — which
 * lets two concurrent processes both delete + recreate the lock — we use a
 * renameSync to a per-pid '.reap.<pid>' sentinel. Only ONE process can rename
 * a given path; the loser gets ENOENT and falls through to the O_EXCL create
 * (which gets EEXIST → returns false). Exactly one winner.
 *
 * PID-liveness check (H-4b): a FRESH lock whose recorded PID is dead (ESRCH) is
 * treated as stale and reclaimed immediately — no waiting for the full 30-min
 * window after a hard kill of the holder.
 */
export function acquireLock(): boolean {
  const lockPath = getLockPath();

  if (existsSync(lockPath)) {
    let stale = false;

    try {
      const { mtimeMs } = statSync(lockPath);

      if (Date.now() - mtimeMs >= LOCK_STALE_MS) {
        // Old by mtime — treat as stale regardless of PID
        stale = true;
      } else {
        // Fresh by mtime — probe the recorded PID for liveness (H-4b)
        let pidStr: string;
        try {
          pidStr = readFileSync(lockPath, 'utf8').trim();
        } catch {
          // File vanished or unreadable — conservative: treat as held
          return false;
        }

        if (!pidStr || !/^\d+$/.test(pidStr)) {
          // Non-numeric or empty PID on a fresh lock — conservative: treat as held (L-3 cousin)
          return false;
        }

        const pid = parseInt(pidStr, 10);
        try {
          process.kill(pid, 0); // signal 0 = liveness probe; throws on dead/no-permission
          // No exception → process alive; EPERM would also reach here (alive, not ours)
          return false; // held by a live process
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ESRCH') {
            // No such process → holder is dead; reclaim it
            stale = true;
          } else {
            // EPERM or other: process exists, we can't signal it → treat as held
            return false;
          }
        }
      }
    } catch {
      // File removed between existsSync + statSync by a concurrent unlink — fall through
    }

    if (stale) {
      // Atomic takeover via rename (H-4a): only ONE process can rename a given path.
      // The winner gets the '.reap.<pid>' file; the loser gets ENOENT and falls through
      // to the O_EXCL create below (which will get EEXIST → return false).
      const reapPath = lockPath + '.reap.' + String(process.pid);
      try {
        renameSync(lockPath, reapPath);
        // We won the rename race — clean up our sentinel before the O_EXCL create
        try { unlinkSync(reapPath); } catch { /* ignore — best-effort cleanup */ }
        // Fall through to O_EXCL create
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          // Another process renamed it first — fall through; O_EXCL below will EEXIST
        } else {
          throw e; // unexpected FS error
        }
      }
    }
  }

  // Atomic create — 'wx' = O_WRONLY | O_CREAT | O_EXCL
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
 * Acquire the sleep-pass lock, retrying briefly to ride out short-lived holds.
 *
 * Shared by recall-cli and watcher-cli (LOCK-RETRY-HELPER): a bounded retry lets an
 * interactive recall or a watcher tick coexist with the other's per-tick hold without
 * failing on the first collision. Returns false only if the lock stays held across all
 * attempts (e.g. a sleep-pass or LLM-response-in-flight).
 *
 * Default: 8 attempts × 150ms delay ≈ 1050ms worst-case wait.
 */
export async function acquireLockWithRetry(attempts = 8, delayMs = 150): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (acquireLock()) return true;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

/**
 * Release the sleep-pass lock.
 *
 * WR-02 — ownership-checked: after a stale-reclaim the lock file may belong to a
 * NEW owner, so a slow original must NOT delete it (doing so would admit a third
 * concurrent writer). We unlink only when the recorded pid is ours, or when the
 * file is missing/unreadable (best-effort).
 *
 * L-3 — empty-but-fresh guard: an empty lockfile that is fresh by mtime is NOT
 * provably ours — it may be another process's just-created lock whose PID write
 * is still pending. Leave it alone rather than racing the write.
 *
 * Best-effort: ignores ENOENT (already removed by a concurrent releaseLock or
 * stale-reclaim). All other errors propagate.
 */
export function releaseLock(): void {
  const lockPath = getLockPath();
  let owner: string | null = null;
  try {
    owner = readFileSync(lockPath, 'utf8').trim();
  } catch {
    owner = null; // missing/unreadable — fall through to best-effort unlink
  }

  // Not our lock — a reclaim handed it to another live process. Leave it alone.
  if (owner !== null && owner !== '' && owner !== String(process.pid)) return;

  // L-3: empty-but-fresh lockfile is not provably ours — another process may have
  // just created it and not yet written its PID. Leave it alone.
  if (owner === '') {
    try {
      const { mtimeMs } = statSync(lockPath);
      if (Date.now() - mtimeMs < LOCK_STALE_MS) return; // fresh, not provably ours
    } catch {
      // File vanished between read and stat — fall through to best-effort unlink
    }
  }

  try {
    unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// heartbeatLock — refresh lock mtime to prevent false-stale reclaims (L-11)
// ---------------------------------------------------------------------------

/**
 * Touch the lock mtime to prevent it from expiring during a long batch (L-11).
 *
 * A watcher batch processing 100 messages × multi-second LLM responds can
 * theoretically exceed the 30-min stale window, causing a live lock to be
 * reclaimed. Calling heartbeatLock() once per processed message refreshes the
 * mtime so the lock always appears fresh to any concurrent acquireLock() probe.
 *
 * No-op (silent) when the lock file is absent or unreadable — a failed heartbeat
 * is not worth crashing the batch over.
 *
 * Exported for use in runTick (watcher-cli.ts) and for unit testing.
 */
export function heartbeatLock(): void {
  try {
    utimesSync(getLockPath(), new Date(), new Date());
  } catch {
    // ENOENT / unreadable — no-op
  }
}
