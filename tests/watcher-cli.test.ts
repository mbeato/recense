/**
 * Unit tests for watcher-cli helpers (Phase 7, D-71 / LOCK-CHANNEL-SPLIT).
 *
 * Tests the exported pure helpers only — main() is behind require.main guard
 * and is never invoked here.
 *
 * Coverage:
 *   runTick (pre-fetched message list, pure respond loop):
 *     (a) respond() returns null → channel.send NOT called (safe-null discipline, T-07-04)
 *     (b) respond() returns non-null reply → channel.send called once with sender + reply
 *     (c) respond() throws → runTick does NOT throw (error caught + logged)
 *     (d) multiple messages → send called for each non-null reply
 *     (e) empty message list → no send, no throw
 *   runLockedTick — guarantee tests (LOCK-CHANNEL-SPLIT invariants):
 *     (f) no-loss: lock held → cursor NOT advanced; same messages available next tick
 *     (g) idle fetch: commitTo=null, messages=[] → lock NEVER acquired
 *     (h) tickInFlight: overlapping ticks → second is a no-op (no commit, no send)
 *     (i) monotonic commit: messages with id <= current cursor → dropped; commit skipped
 *     (j) cold start: fetch returns baseline, commitCursor persists it under the lock
 *   resolveDbPath:
 *     (k) BRAIN_MEMORY_DB env var → returned as dbPath
 */
import { writeFileSync, unlinkSync, existsSync, statSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockChannel } from '../src/channel/channel';
import type { Channel, InboundMessage, FetchResult } from '../src/channel/channel';
import { runTick, runLockedTick, resolveDbPath } from '../src/adapter/watcher-cli';
import { LOCK_PATH } from '../src/adapter/lockfile';
import type { ResponderResult } from '../src/responder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noopLog = (_msg: string): void => {};

const MSG: InboundMessage = {
  id: '1',
  sender: '+15551234567',
  text: 'hello memory',
  ts: Date.now(),
};

/** Stub responder that returns a scripted reply (or null). */
function makeResponder(reply: string | null): {
  respond(q: string, s: string): Promise<ResponderResult>;
} {
  return {
    async respond(_q: string, _s: string): Promise<ResponderResult> {
      return { reply, origin: reply !== null ? 'fact' : 'none', episodeId: null };
    },
  };
}

/** Stub responder that always throws — tests error containment. */
function makeThrowingResponder(): {
  respond(q: string, s: string): Promise<ResponderResult>;
} {
  return {
    async respond(_q: string, _s: string): Promise<never> {
      throw new Error('respond threw intentionally');
    },
  };
}

// ---------------------------------------------------------------------------
// runTick tests — pre-fetched message list, pure respond loop
// ---------------------------------------------------------------------------

describe('runTick', () => {
  it('(a) reply === null → channel.send NOT called', async () => {
    const channel = new MockChannel();
    await runTick(channel, [MSG], makeResponder(null), 'sess', noopLog);
    expect(channel.sent).toHaveLength(0);
  });

  it('(b) reply non-null → channel.send called once with sender + reply', async () => {
    const channel = new MockChannel();
    await runTick(channel, [MSG], makeResponder('the answer'), 'sess', noopLog);
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toEqual({ recipient: '+15551234567', text: 'the answer' });
  });

  it('(c) respond() throws → runTick does NOT throw; send not called', async () => {
    const channel = new MockChannel();
    await expect(
      runTick(channel, [MSG], makeThrowingResponder(), 'sess', noopLog),
    ).resolves.toBeUndefined();
    expect(channel.sent).toHaveLength(0);
  });

  it('(d) multiple messages → send called for each non-null reply', async () => {
    const msg2: InboundMessage = { id: '2', sender: '+15559876543', text: 'hi', ts: Date.now() };
    const channel = new MockChannel();
    await runTick(channel, [MSG, msg2], makeResponder('ok'), 'sess', noopLog);
    expect(channel.sent).toHaveLength(2);
    expect(channel.sent[0]?.recipient).toBe('+15551234567');
    expect(channel.sent[1]?.recipient).toBe('+15559876543');
  });

  it('(e) empty message list → no send, no throw', async () => {
    const channel = new MockChannel();
    await expect(runTick(channel, [], makeResponder('hi'), 'sess', noopLog)).resolves.toBeUndefined();
    expect(channel.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runLockedTick — guarantee tests (LOCK-CHANNEL-SPLIT)
// ---------------------------------------------------------------------------

describe('runLockedTick — guarantee: no-loss (lock held)', () => {
  // Use a per-test lock path to avoid cross-test contamination.
  const CUSTOM_LOCK = LOCK_PATH + '.test-noloss';

  beforeEach(() => {
    // Remove any previous left-over lock
    if (existsSync(CUSTOM_LOCK)) {
      try { unlinkSync(CUSTOM_LOCK); } catch { /* ignore */ }
    }
    process.env['BRAIN_MEMORY_LOCK_PATH'] = CUSTOM_LOCK;
    // Pre-create a fresh lock file (mtime just now → acquireLock() sees it as held)
    writeFileSync(CUSTOM_LOCK, String(process.pid));
  });

  afterEach(() => {
    delete process.env['BRAIN_MEMORY_LOCK_PATH'];
    if (existsSync(CUSTOM_LOCK)) {
      try { unlinkSync(CUSTOM_LOCK); } catch { /* ignore */ }
    }
  });

  it('(f) lock held → cursor NOT advanced (no-loss invariant #2)', async () => {
    const channel = new MockChannel({
      fetchScript: [{ messages: [MSG], commitTo: '1' }],
    });
    await runLockedTick(channel, makeResponder('pong'), 'sess', noopLog);

    // Lock was held → cursor was NOT advanced — no-loss: next tick can re-fetch same messages
    expect(channel.committed).toHaveLength(0);
    expect(channel.sent).toHaveLength(0);
  }, 10_000); // 10s timeout: acquireLockWithRetry(8 attempts × 150ms) = ~1050ms
});

describe('runLockedTick — guarantee: idle fetch', () => {
  const CUSTOM_LOCK = LOCK_PATH + '.test-idle';

  beforeEach(() => {
    if (existsSync(CUSTOM_LOCK)) {
      try { unlinkSync(CUSTOM_LOCK); } catch { /* ignore */ }
    }
    process.env['BRAIN_MEMORY_LOCK_PATH'] = CUSTOM_LOCK;
  });

  afterEach(() => {
    delete process.env['BRAIN_MEMORY_LOCK_PATH'];
    if (existsSync(CUSTOM_LOCK)) {
      try { unlinkSync(CUSTOM_LOCK); } catch { /* ignore */ }
    }
  });

  it('(g) idle fetch (commitTo:null, messages:[]) → lock NEVER acquired', async () => {
    const channel = new MockChannel({
      fetchScript: [{ messages: [], commitTo: null }],
    });
    await runLockedTick(channel, makeResponder('reply'), 'sess', noopLog);

    // Nothing was committed and the lock was never created (lock file absent)
    expect(channel.committed).toHaveLength(0);
    expect(channel.sent).toHaveLength(0);
    expect(existsSync(CUSTOM_LOCK)).toBe(false);
  });
});

describe('runLockedTick — guarantee: tickInFlight', () => {
  const CUSTOM_LOCK = LOCK_PATH + '.test-inflight';

  beforeEach(() => {
    if (existsSync(CUSTOM_LOCK)) {
      try { unlinkSync(CUSTOM_LOCK); } catch { /* ignore */ }
    }
    process.env['BRAIN_MEMORY_LOCK_PATH'] = CUSTOM_LOCK;
  });

  afterEach(() => {
    delete process.env['BRAIN_MEMORY_LOCK_PATH'];
    if (existsSync(CUSTOM_LOCK)) {
      try { unlinkSync(CUSTOM_LOCK); } catch { /* ignore */ }
    }
  });

  it('(h) overlapping ticks — second is a no-op (tickInFlight guard)', async () => {
    // L-11 reorder: tickInFlight is now checked BEFORE fetch(). tick1 sets the flag
    // synchronously before its first await; tick2 starts synchronously next and
    // immediately hits the guard (before calling fetch at all).
    let resolveRespond!: () => void;
    const respondBlocker = new Promise<void>(r => { resolveRespond = r; });
    const slowResponder = {
      async respond(_q: string, _s: string): Promise<ResponderResult> {
        await respondBlocker;
        return { reply: 'ok', origin: 'fact' as const, episodeId: null };
      },
    };

    // Only one fetchScript entry — tick2 is blocked before it can call fetch
    const channel = new MockChannel({
      fetchScript: [
        { messages: [MSG], commitTo: '1' }, // consumed by tick1 only
      ],
    });

    // Fire both ticks without awaiting
    const tick1 = runLockedTick(channel, slowResponder, 'sess', noopLog);
    const tick2 = runLockedTick(channel, slowResponder, 'sess', noopLog);

    // Unblock tick1's responder so it can finish
    resolveRespond();

    await tick1;
    await tick2;

    // tick1 committed once; tick2 was blocked by tickInFlight before fetch → no second commit
    expect(channel.committed).toHaveLength(1);
    expect(channel.committed[0]).toBe('1');
    expect(channel.sent).toHaveLength(1);
  });
});

describe('runLockedTick — guarantee: monotonic commit', () => {
  const CUSTOM_LOCK = LOCK_PATH + '.test-monotonic';

  beforeEach(() => {
    if (existsSync(CUSTOM_LOCK)) {
      try { unlinkSync(CUSTOM_LOCK); } catch { /* ignore */ }
    }
    process.env['BRAIN_MEMORY_LOCK_PATH'] = CUSTOM_LOCK;
  });

  afterEach(() => {
    delete process.env['BRAIN_MEMORY_LOCK_PATH'];
    if (existsSync(CUSTOM_LOCK)) {
      try { unlinkSync(CUSTOM_LOCK); } catch { /* ignore */ }
    }
  });

  it('(i) stale messages dropped + commit skipped when ids <= current cursor', async () => {
    const channel = new MockChannel({
      fetchScript: [{ messages: [MSG], commitTo: '1' }], // MSG.id='1'
    });

    // Pre-seed the cursor to a value higher than MSG.id — simulates a prior commit
    channel.commitCursor('5'); // committed=['5'], cursor='5'

    await runLockedTick(channel, makeResponder('reply'), 'sess', noopLog);

    // Under the lock: cursor='5', MSG.id='1' → 1 <= 5 → dropped (no send)
    expect(channel.sent).toHaveLength(0);
    // commitTo='1' <= cursor='5' → skipCommit=true → no new commit entry
    expect(channel.committed).toHaveLength(1); // only the seeded '5'
    expect(channel.committed[0]).toBe('5');
  });
});

describe('runLockedTick — guarantee: cold start', () => {
  const CUSTOM_LOCK = LOCK_PATH + '.test-coldstart';

  beforeEach(() => {
    if (existsSync(CUSTOM_LOCK)) {
      try { unlinkSync(CUSTOM_LOCK); } catch { /* ignore */ }
    }
    process.env['BRAIN_MEMORY_LOCK_PATH'] = CUSTOM_LOCK;
  });

  afterEach(() => {
    delete process.env['BRAIN_MEMORY_LOCK_PATH'];
    if (existsSync(CUSTOM_LOCK)) {
      try { unlinkSync(CUSTOM_LOCK); } catch { /* ignore */ }
    }
  });

  it('(j) cold start: fetch returns baseline, commitCursor persists it under the lock', async () => {
    // Cold start: no messages (no backlog to answer), commitTo = baseline update_id
    const channel = new MockChannel({
      fetchScript: [{ messages: [], commitTo: '100' }], // cold start baseline
    });

    // Before runLockedTick: nothing committed
    expect(channel.committed).toHaveLength(0);
    expect(channel.currentCursor()).toBeNull();

    await runLockedTick(channel, makeResponder('hi'), 'sess', noopLog);

    // After: baseline was committed under the lock (commitTo='100', cursor was null → not idle)
    expect(channel.committed).toEqual(['100']);
    expect(channel.currentCursor()).toBe('100');
    // No messages to answer
    expect(channel.sent).toHaveLength(0);
  });

  it('idle path: commitTo:null with empty messages never touches the lock', async () => {
    // After baseline is committed, subsequent empty polls return the idle sentinel
    const channel = new MockChannel({
      fetchScript: [{ messages: [], commitTo: null }],
    });

    await runLockedTick(channel, makeResponder('hi'), 'sess', noopLog);

    expect(channel.committed).toHaveLength(0);
    // Lock was never acquired — lock file absent
    expect(existsSync(CUSTOM_LOCK)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C-1: rejecting fetch resolves runLockedTick (belt-and-suspenders)
// ---------------------------------------------------------------------------

describe('runLockedTick — C-1: rejecting fetch resolves cleanly', () => {
  const CUSTOM_LOCK = LOCK_PATH + '.test-fetchreject';

  beforeEach(() => {
    if (existsSync(CUSTOM_LOCK)) {
      try { unlinkSync(CUSTOM_LOCK); } catch { /* ignore */ }
    }
    process.env['BRAIN_MEMORY_LOCK_PATH'] = CUSTOM_LOCK;
  });

  afterEach(() => {
    delete process.env['BRAIN_MEMORY_LOCK_PATH'];
    if (existsSync(CUSTOM_LOCK)) {
      try { unlinkSync(CUSTOM_LOCK); } catch { /* ignore */ }
    }
  });

  it('runLockedTick resolves (does not reject) when channel.fetch() throws', async () => {
    const rejectingChannel: Channel = {
      async fetch(): Promise<FetchResult> { throw new Error('network boom'); },
      commitCursor(_v: string) {},
      currentCursor(): string | null { return null; },
      async send(_r: string, _t: string): Promise<void> {},
    };
    const noop = { async respond(_q: string, _s: string): Promise<ResponderResult> {
      return { reply: null, origin: 'none' as const, episodeId: null };
    }};
    await expect(
      runLockedTick(rejectingChannel, noop, 'sess', noopLog),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// L-11: tickInFlight skips fetch entirely (prove with a call counter)
// ---------------------------------------------------------------------------

describe('runLockedTick — L-11: tickInFlight blocks fetch', () => {
  const CUSTOM_LOCK = LOCK_PATH + '.test-fetchcount';

  beforeEach(() => {
    if (existsSync(CUSTOM_LOCK)) {
      try { unlinkSync(CUSTOM_LOCK); } catch { /* ignore */ }
    }
    process.env['BRAIN_MEMORY_LOCK_PATH'] = CUSTOM_LOCK;
  });

  afterEach(() => {
    delete process.env['BRAIN_MEMORY_LOCK_PATH'];
    if (existsSync(CUSTOM_LOCK)) {
      try { unlinkSync(CUSTOM_LOCK); } catch { /* ignore */ }
    }
  });

  it('second concurrent runLockedTick returns without calling fetch', async () => {
    let fetchCount = 0;
    let resolveRespond!: () => void;
    const respondBlocker = new Promise<void>(r => { resolveRespond = r; });

    const slowResponder = {
      async respond(_q: string, _s: string): Promise<ResponderResult> {
        await respondBlocker;
        return { reply: 'ok', origin: 'fact' as const, episodeId: null };
      },
    };

    let cursor: string | null = null;
    const countingChannel: Channel = {
      async fetch(): Promise<FetchResult> {
        fetchCount++;
        return { messages: [MSG], commitTo: '1' };
      },
      commitCursor(v: string) { cursor = v; },
      currentCursor(): string | null { return cursor; },
      async send(_r: string, _t: string): Promise<void> {},
    };

    // tick1: sets tickInFlight=true before its first await
    // tick2: immediately hits the guard — never calls fetch
    const tick1 = runLockedTick(countingChannel, slowResponder, 'sess', noopLog);
    const tick2 = runLockedTick(countingChannel, slowResponder, 'sess', noopLog);

    resolveRespond();
    await tick1;
    await tick2;

    // Only tick1 called fetch; tick2 was blocked before reaching it
    expect(fetchCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// H-3: unconfigured watcher stays alive past the poll interval (no unref)
// ---------------------------------------------------------------------------

describe('watcher-cli — H-3: unconfigured-channel process stays alive', () => {
  const WATCHER_CLI_DIST = join(__dirname, '..', 'dist', 'src', 'adapter', 'watcher-cli.js');

  it('process is still alive ~700ms after start with no channel config (KeepAlive safe)', async () => {
    if (!existsSync(WATCHER_CLI_DIST)) {
      console.warn('SKIP H-3: dist not built — run npm run build first');
      return;
    }

    const tempDb = join(tmpdir(), `brain-watcher-h3-${Date.now()}.db`);
    const child = spawn(process.execPath, [WATCHER_CLI_DIST, '--db', tempDb], {
      // No BRAIN_MEMORY_TELEGRAM_TOKEN, no channel config → unconfigured idle path
      env: {
        ...process.env,
        BRAIN_MEMORY_DB: tempDb,
        BRAIN_MEMORY_LOCK_PATH: LOCK_PATH + '.test-h3-alive',
      },
      stdio: 'ignore',
    });

    await new Promise<void>(resolve => setTimeout(resolve, 700));

    const isAlive = child.exitCode === null && !child.killed;
    child.kill('SIGTERM');

    // Cleanup
    try { unlinkSync(tempDb); } catch { /* ignore */ }

    expect(isAlive).toBe(true);
  }, 5000);
});

// ---------------------------------------------------------------------------
// resolveDbPath tests
// ---------------------------------------------------------------------------

describe('resolveDbPath', () => {
  const origEnv = process.env['BRAIN_MEMORY_DB'];
  const origArgv = process.argv.slice();

  afterEach(() => {
    // Restore env + argv after each test
    if (origEnv !== undefined) {
      process.env['BRAIN_MEMORY_DB'] = origEnv;
    } else {
      delete process.env['BRAIN_MEMORY_DB'];
    }
    process.argv.splice(0, process.argv.length, ...origArgv);
  });

  it('(k) returns BRAIN_MEMORY_DB env var when set', () => {
    delete process.env['BRAIN_MEMORY_DB'];
    process.argv = ['node', 'script.js']; // no --db flag
    process.env['BRAIN_MEMORY_DB'] = '/tmp/test.db';
    expect(resolveDbPath()).toBe('/tmp/test.db');
  });

  it('returns undefined when neither --db nor BRAIN_MEMORY_DB is set', () => {
    delete process.env['BRAIN_MEMORY_DB'];
    process.argv = ['node', 'script.js'];
    expect(resolveDbPath()).toBeUndefined();
  });

  it('--db flag takes precedence over env var', () => {
    process.env['BRAIN_MEMORY_DB'] = '/tmp/env.db';
    process.argv = ['node', 'script.js', '--db', '/tmp/arg.db'];
    expect(resolveDbPath()).toBe('/tmp/arg.db');
  });
});
