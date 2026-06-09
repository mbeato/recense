/**
 * Unit tests for imessage-watcher-cli helpers (Phase 7, D-71).
 *
 * Tests the exported pure helpers only — main() is behind require.main guard
 * and is never invoked here.
 *
 * Coverage:
 *   runTick:
 *     (a) respond() returns null → channel.send NOT called (safe-null discipline, T-07-04)
 *     (b) respond() returns non-null reply → channel.send called once with sender + reply
 *     (c) respond() throws → runTick does NOT throw (error caught + logged)
 *   runLockedTick:
 *     (d) lock file present (lock held) → receive() NOT called (lock-skip branch, T-07-07)
 *   resolveDbPath:
 *     (e) BRAIN_MEMORY_DB env var → returned as dbPath
 */
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockChannel } from '../src/channel/channel';
import type { InboundMessage } from '../src/channel/channel';
import { runTick, runLockedTick, resolveDbPath } from '../src/adapter/imessage-watcher-cli';
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
// runTick tests
// ---------------------------------------------------------------------------

describe('runTick', () => {
  it('(a) reply === null → channel.send NOT called', async () => {
    const channel = new MockChannel({ receiveScript: [[MSG]] });
    await runTick(channel, makeResponder(null), 'sess', noopLog);
    expect(channel.sent).toHaveLength(0);
  });

  it('(b) reply non-null → channel.send called once with sender + reply', async () => {
    const channel = new MockChannel({ receiveScript: [[MSG]] });
    await runTick(channel, makeResponder('the answer'), 'sess', noopLog);
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toEqual({ recipient: '+15551234567', text: 'the answer' });
  });

  it('(c) respond() throws → runTick does NOT throw; send not called', async () => {
    const channel = new MockChannel({ receiveScript: [[MSG]] });
    await expect(
      runTick(channel, makeThrowingResponder(), 'sess', noopLog),
    ).resolves.toBeUndefined();
    expect(channel.sent).toHaveLength(0);
  });

  it('multiple messages in one tick → send called for each non-null reply', async () => {
    const msg2: InboundMessage = { id: '2', sender: '+15559876543', text: 'hi', ts: Date.now() };
    const channel = new MockChannel({ receiveScript: [[MSG, msg2]] });
    await runTick(channel, makeResponder('ok'), 'sess', noopLog);
    expect(channel.sent).toHaveLength(2);
    expect(channel.sent[0]?.recipient).toBe('+15551234567');
    expect(channel.sent[1]?.recipient).toBe('+15559876543');
  });

  it('empty receive() → no send, no throw', async () => {
    const channel = new MockChannel({ receiveScript: [[]] });
    await expect(runTick(channel, makeResponder('hi'), 'sess', noopLog)).resolves.toBeUndefined();
    expect(channel.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runLockedTick — lock-skip tests
// ---------------------------------------------------------------------------

describe('runLockedTick — lock held', () => {
  beforeEach(() => {
    // Pre-create a fresh lock file (mtime just now → stale check sees it as held)
    writeFileSync(LOCK_PATH, String(process.pid));
  });

  afterEach(() => {
    // Clean up any lock file left by the test
    if (existsSync(LOCK_PATH)) {
      try { unlinkSync(LOCK_PATH); } catch { /* ignore */ }
    }
  });

  it('(d) lock held → receive NOT called (tick skipped entirely)', async () => {
    const channel = new MockChannel({ receiveScript: [[MSG]] });
    const responder = makeResponder('pong');
    await runLockedTick(channel, responder, 'sess', noopLog);

    // Lock was held → entire tick was skipped → send not called
    expect(channel.sent).toHaveLength(0);

    // Verify receive() was not consumed: calling it now still returns the message
    const received = await channel.receive();
    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe('1');
  });
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

  it('(e) returns BRAIN_MEMORY_DB env var when set', () => {
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
