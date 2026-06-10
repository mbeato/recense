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
import { writeFileSync, utimesSync, existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { acquireLock, releaseLock, heartbeatLock, LOCK_STALE_MS } from '../src/adapter/lockfile';

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

// ---------------------------------------------------------------------------
// H-4b: PID-liveness — fresh lock with a dead PID is reclaimed
// ---------------------------------------------------------------------------

describe('acquireLock — H-4b: PID-liveness check on fresh locks', () => {
  const FRESH_LOCK_PATH = join(tmpdir(), `brain-memory-fresh-lock-${process.pid}.lock`);

  beforeAll(() => {
    process.env['BRAIN_MEMORY_LOCK_PATH'] = FRESH_LOCK_PATH;
  });

  afterAll(() => {
    delete process.env['BRAIN_MEMORY_LOCK_PATH'];
  });

  afterEach(() => {
    try { if (existsSync(FRESH_LOCK_PATH)) unlinkSync(FRESH_LOCK_PATH); } catch { /* ignore */ }
  });

  it('reclaims a fresh lock whose recorded PID is definitely dead', () => {
    // PID 999999 is astronomically unlikely to be a live process on any system
    const deadPid = '999999';
    writeFileSync(FRESH_LOCK_PATH, deadPid);
    // Keep it fresh (mtime = now)
    const now = new Date();
    utimesSync(FRESH_LOCK_PATH, now, now);

    // Should reclaim: PID 999999 is dead → ESRCH → treat as stale
    const got = acquireLock();
    expect(got).toBe(true);
  });

  it('returns false for a fresh lock whose PID is the current live process', () => {
    // Our own PID is definitely alive
    writeFileSync(FRESH_LOCK_PATH, String(process.pid));
    const now = new Date();
    utimesSync(FRESH_LOCK_PATH, now, now);

    // Should NOT reclaim — the holder is alive (signal 0 succeeds)
    const got = acquireLock();
    expect(got).toBe(false);
  });

  it('returns false for a fresh lock with a non-numeric PID (conservative)', () => {
    writeFileSync(FRESH_LOCK_PATH, 'not-a-pid');
    const now = new Date();
    utimesSync(FRESH_LOCK_PATH, now, now);

    const got = acquireLock();
    expect(got).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// H-4a: atomic stale-takeover — single-process TOCTOU simulation
// ---------------------------------------------------------------------------

describe('acquireLock — H-4a: atomic stale-takeover (single-winner)', () => {
  const TOCTOU_LOCK_PATH = join(tmpdir(), `brain-memory-toctou-lock-${process.pid}.lock`);

  beforeAll(() => {
    process.env['BRAIN_MEMORY_LOCK_PATH'] = TOCTOU_LOCK_PATH;
  });

  afterAll(() => {
    delete process.env['BRAIN_MEMORY_LOCK_PATH'];
  });

  afterEach(() => {
    try { if (existsSync(TOCTOU_LOCK_PATH)) unlinkSync(TOCTOU_LOCK_PATH); } catch { /* ignore */ }
    // Also clean up any leftover .reap. files
    try {
      const reapGlob = TOCTOU_LOCK_PATH + '.reap.' + String(process.pid);
      if (existsSync(reapGlob)) unlinkSync(reapGlob);
    } catch { /* ignore */ }
  });

  it('exactly one of two sequential acquireLock() calls wins when lock is stale', () => {
    // Write a stale lock (mtime 40min ago)
    writeFileSync(TOCTOU_LOCK_PATH, 'stale-pid-88888');
    const staleMtime = new Date(Date.now() - 40 * 60 * 1000);
    utimesSync(TOCTOU_LOCK_PATH, staleMtime, staleMtime);

    // First call wins
    const first = acquireLock();
    expect(first).toBe(true);

    // Second call sees the new (fresh) lock and returns false
    const second = acquireLock();
    expect(second).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L-3: releaseLock does not delete an empty-but-fresh lock
// ---------------------------------------------------------------------------

describe('releaseLock — L-3: empty-but-fresh lock left intact', () => {
  const L3_LOCK_PATH = join(tmpdir(), `brain-memory-l3-lock-${process.pid}.lock`);

  beforeAll(() => {
    process.env['BRAIN_MEMORY_LOCK_PATH'] = L3_LOCK_PATH;
  });

  afterAll(() => {
    delete process.env['BRAIN_MEMORY_LOCK_PATH'];
  });

  afterEach(() => {
    try { if (existsSync(L3_LOCK_PATH)) unlinkSync(L3_LOCK_PATH); } catch { /* ignore */ }
  });

  it('releaseLock does NOT delete a fresh empty lockfile (another process just created it)', () => {
    // Simulate another process's just-created lock: empty content, fresh mtime
    writeFileSync(L3_LOCK_PATH, '');
    const now = new Date();
    utimesSync(L3_LOCK_PATH, now, now);

    releaseLock(); // we are NOT the owner (empty = not us)

    // Lock file must still exist — releaseLock must not delete a fresh empty lock
    expect(existsSync(L3_LOCK_PATH)).toBe(true);
  });

  it('releaseLock DOES delete a stale empty lockfile (safe to clean up)', () => {
    // An empty + stale lock is safe to remove
    writeFileSync(L3_LOCK_PATH, '');
    const staleMtime = new Date(Date.now() - (LOCK_STALE_MS + 1000));
    utimesSync(L3_LOCK_PATH, staleMtime, staleMtime);

    releaseLock();

    // Stale empty lock should be removed
    expect(existsSync(L3_LOCK_PATH)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// L-11: heartbeatLock updates mtime; no-op when lock absent
// ---------------------------------------------------------------------------

describe('heartbeatLock — L-11: mtime heartbeat', () => {
  const HEARTBEAT_LOCK_PATH = join(tmpdir(), `brain-memory-heartbeat-lock-${process.pid}.lock`);

  beforeAll(() => {
    process.env['BRAIN_MEMORY_LOCK_PATH'] = HEARTBEAT_LOCK_PATH;
  });

  afterAll(() => {
    delete process.env['BRAIN_MEMORY_LOCK_PATH'];
  });

  afterEach(() => {
    try { if (existsSync(HEARTBEAT_LOCK_PATH)) unlinkSync(HEARTBEAT_LOCK_PATH); } catch { /* ignore */ }
  });

  it('heartbeatLock() updates the lock file mtime', async () => {
    // Create lock with an old mtime
    writeFileSync(HEARTBEAT_LOCK_PATH, String(process.pid));
    const oldMtime = new Date(Date.now() - 5000);
    utimesSync(HEARTBEAT_LOCK_PATH, oldMtime, oldMtime);

    const before = Date.now();
    heartbeatLock();

    const { mtimeMs } = statSync(HEARTBEAT_LOCK_PATH);
    expect(mtimeMs).toBeGreaterThanOrEqual(before - 100); // allow small clock skew
  });

  it('heartbeatLock() is a no-op when lock file does not exist', () => {
    // Ensure file does not exist
    expect(existsSync(HEARTBEAT_LOCK_PATH)).toBe(false);
    // Should not throw
    expect(() => heartbeatLock()).not.toThrow();
  });
});
