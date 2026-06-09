/**
 * ADAPT-02: Hand-rolled O_EXCL lockfile — concurrent-acquire coverage.
 *
 * DEBT-02: redirect the lock to a per-pid path so this test never touches the
 * production lock held by the live watcher. Must be set BEFORE the lockfile
 * import — vitest pool:forks evaluates the module fresh per fork at load time.
 *
 * Tests:
 *  1. First acquireLock() returns true; second returns false while held.
 *  2. After releaseLock(), acquireLock() returns true again.
 *  3. A stale lock (mtime older than LOCK_STALE_MS) is reclaimed.
 */
import { tmpdir } from 'os';
import { join } from 'path';
// DEBT-02: set hermetic per-pid lock path BEFORE importing lockfile module.
process.env['BRAIN_MEMORY_LOCK_PATH'] = join(tmpdir(), `brain-memory-test-lock-${process.pid}.lock`);
import { writeFileSync, utimesSync, existsSync } from 'fs';
import { describe, it, expect, afterEach } from 'vitest';
import { acquireLock, releaseLock, LOCK_PATH } from '../src/adapter/lockfile';

describe('acquireLock / releaseLock', () => {
  afterEach(() => {
    // Clean up the lock file after each test to avoid cross-test leakage
    releaseLock();
  });

  it('first acquire returns true; second acquire while held returns false', () => {
    const got1 = acquireLock();
    const got2 = acquireLock();
    expect(got1).toBe(true);
    expect(got2).toBe(false);
  });

  it('acquire succeeds after release', () => {
    expect(acquireLock()).toBe(true);
    releaseLock();
    expect(acquireLock()).toBe(true);
  });

  it('reclaims a stale lock (mtime older than LOCK_STALE_MS)', () => {
    // Write the lock file directly and back-date its mtime to 10 minutes ago
    // so the staleness branch is exercised deterministically
    writeFileSync(LOCK_PATH, 'stale-pid-99999');
    const staleMtime = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago
    utimesSync(LOCK_PATH, staleMtime, staleMtime);

    // Verify the file exists and is stale before calling acquireLock
    expect(existsSync(LOCK_PATH)).toBe(true);

    // acquireLock should reclaim the stale lock and return true
    const got = acquireLock();
    expect(got).toBe(true);
  });
});
