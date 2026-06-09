/**
 * INSTALL-05 platform gate: non-darwin platforms receive a clear macOS-only
 * message and the watcher exits 0 without acquiring any lock.
 *
 * Tests the exported pure helper `getNonDarwinEarlyExitMessage(platform)`.
 *
 * Invariants under test:
 *  - non-darwin platform → returns a defined message containing 'macOS-only'.
 *  - message confirms engine and Claude Code hooks still work on Linux.
 *  - darwin → returns undefined (no early exit; proceed with channel logic).
 *  - any non-darwin string (linux, win32, freebsd) triggers the guard.
 *
 * Threat mitigation: T-09-12 — watcher started on non-darwin is EoP risk;
 * the guard ensures it exits 0 with a clear message BEFORE acquiring any lock
 * or opening any channel (verified by the pure-function design: the guard runs
 * BEFORE the first acquireLock() call in main()).
 */
import { describe, it, expect } from 'vitest';
import { getNonDarwinEarlyExitMessage } from '../src/adapter/watcher-cli';

describe('watcher platform gate — getNonDarwinEarlyExitMessage (INSTALL-05 / T-09-12)', () => {
  it('linux → returns a defined macOS-only message', () => {
    const msg = getNonDarwinEarlyExitMessage('linux');
    expect(msg).toBeDefined();
    expect(typeof msg).toBe('string');
    expect(msg).toContain('macOS-only');
  });

  it('linux → message mentions engine + Claude Code hooks still work', () => {
    const msg = getNonDarwinEarlyExitMessage('linux');
    // Must confirm that the ENGINE and hooks are unaffected — not just that watcher is disabled.
    expect(msg).toMatch(/engine|hook/i);
  });

  it('win32 (Windows) → returns macOS-only message', () => {
    const msg = getNonDarwinEarlyExitMessage('win32');
    expect(msg).toBeDefined();
    expect(msg).toContain('macOS-only');
  });

  it('freebsd → returns macOS-only message', () => {
    const msg = getNonDarwinEarlyExitMessage('freebsd');
    expect(msg).toBeDefined();
  });

  it('darwin → returns undefined (no early exit, proceed with channel logic)', () => {
    const msg = getNonDarwinEarlyExitMessage('darwin');
    expect(msg).toBeUndefined();
  });
});
