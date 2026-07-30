/**
 * gmail-auth-loopback tests (Phase 62, plan 02 — EMAIL-01).
 *
 * Exercises the real loopback catcher against localhost only: successful
 * callback, wrong-state rejection, bounded timeout, and idempotent close.
 * Also source-asserts the listener host argument (T-62-07).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

import { startLoopbackCatcher } from '../src/adapter/gmail-auth-cli';

const SOURCE = readFileSync(join(__dirname, '../src/adapter/gmail-auth-cli.ts'), 'utf8');
// Comment lines may legitimately explain the threat mitigation by naming the
// forbidden bind address — the plan's own verification greps only
// non-comment lines (`grep -v '^\s*[*/#]'`).
const SOURCE_CODE_ONLY = SOURCE.split('\n')
  .filter((line) => !/^\s*(\*|\/\/|\/\*|#)/.test(line))
  .join('\n');

describe('startLoopbackCatcher', () => {
  it('resolves ok on a matching state callback, response status 200', async () => {
    const catcher = await startLoopbackCatcher('known-state', 5_000);
    const res = await fetch(`http://127.0.0.1:${catcher.port}/?code=C&state=known-state`);
    expect(res.status).toBe(200);
    await expect(catcher.result).resolves.toEqual({ ok: true, code: 'C' });
    catcher.close();
    catcher.close(); // idempotent
  });

  it('rejects a wrong-state callback with status 400 and state_mismatch', async () => {
    const catcher = await startLoopbackCatcher('right-state', 5_000);
    const res = await fetch(`http://127.0.0.1:${catcher.port}/?code=C&state=WRONG`);
    expect(res.status).toBe(400);
    await expect(catcher.result).resolves.toEqual({ ok: false, reason: 'state_mismatch' });
    catcher.close();
  });

  it('settles with timeout when never hit, then the port stops accepting connections', async () => {
    const catcher = await startLoopbackCatcher('unused-state', 50);
    await expect(catcher.result).resolves.toEqual({ ok: false, reason: 'timeout' });

    await new Promise((r) => setTimeout(r, 20));
    await expect(fetch(`http://127.0.0.1:${catcher.port}/`)).rejects.toBeTruthy();

    catcher.close(); // idempotent — safe to call again
  });

  it('binds 127.0.0.1 (connecting via that address succeeds)', async () => {
    const catcher = await startLoopbackCatcher('bind-state', 5_000);
    const res = await fetch(`http://127.0.0.1:${catcher.port}/?code=C&state=bind-state`);
    expect(res.ok).toBe(true);
    catcher.close();
  });
});

describe('source assertions — loopback bind address', () => {
  it('calls listen with the literal host 127.0.0.1', () => {
    expect(SOURCE).toContain("listen(0, '127.0.0.1'");
  });

  it('does not contain 0.0.0.0 in code (comments may explain the prohibition)', () => {
    expect(SOURCE_CODE_ONLY).not.toContain('0.0.0.0');
  });
});
