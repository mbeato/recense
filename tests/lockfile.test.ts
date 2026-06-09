/**
 * ADAPT-02: Hand-rolled O_EXCL lockfile — concurrent-acquire coverage.
 *
 * DEBT-02: redirect the lock to a per-pid path so this test never touches the
 * production lock held by the live watcher.
 *
 * NOTE: TypeScript `import` statements are hoisted before any user code runs, so
 * setting `process.env` before an `import` line does NOT guarantee the module
 * reads the env var at load time. Instead, we set the env var in `beforeAll` and
 * rely on `acquireLock`/`releaseLock` reading the env var lazily at call time
 * (getLockPath() inside each function, not at module load).
 *
 * Tests:
 *  1. First acquireLock() returns true; second returns false while held.
 *  2. After releaseLock(), acquireLock() returns true again.
 *  3. A stale lock (mtime older than LOCK_STALE_MS) is reclaimed.
 */
import { writeFileSync, utimesSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { acquireLock, releaseLock } from '../src/adapter/lockfile';

/** Per-pid hermetic lock path — never collides with the production lock or sibling forks. */
const TEST_LOCK_PATH = join(tmpdir(), `brain-memory-test-lock-${process.pid}.lock`);

describe('acquireLock / releaseLock', () => {
  beforeAll(() => {
    // DEBT-02: set hermetic path before any acquireLock/releaseLock calls.
    // Functions read the env var at call time (getLockPath()), so this is safe
    // even though it runs after the module has already been imported.
    process.env['BRAIN_MEMORY_LOCK_PATH'] = TEST_LOCK_PATH;
  });

  afterAll(() => {
    delete process.env['BRAIN_MEMORY_LOCK_PATH'];
  });

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
    // Write the lock file directly and back-date its mtime well beyond the 30-minute
    // (WR-02) stale window so the staleness branch is exercised deterministically.
    writeFileSync(TEST_LOCK_PATH, 'stale-pid-99999');
    const staleMtime = new Date(Date.now() - 40 * 60 * 1000); // 40 minutes ago
    utimesSync(TEST_LOCK_PATH, staleMtime, staleMtime);

    // Verify the file exists and is stale before calling acquireLock
    expect(existsSync(TEST_LOCK_PATH)).toBe(true);

    // acquireLock should reclaim the stale lock and return true
    const got = acquireLock();
    expect(got).toBe(true);
  });

  it('releaseLock leaves a lock owned by another pid intact (WR-02)', () => {
    // After a stale-reclaim the lock can belong to a different live process; a slow
    // original must NOT delete it (that would admit a third concurrent writer).
    const otherPid = String(process.pid + 1);
    writeFileSync(TEST_LOCK_PATH, otherPid);
    releaseLock(); // we are NOT the recorded owner
    expect(existsSync(TEST_LOCK_PATH)).toBe(true);
    unlinkSync(TEST_LOCK_PATH); // manual cleanup (bypass ownership check)
  });
});
