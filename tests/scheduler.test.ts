/**
 * Scheduler platform dispatch tests (SCHED-01 / SCHED-02).
 *
 * Verifies that runSchedulerCommand routes to the correct platform branch for
 * install/status/run WITHOUT actually registering launchd agents, running pgrep,
 * or entering the blocking croner loop.
 *
 * Test strategy:
 *  - Mock child_process.execSync to prevent real OS calls.
 *  - Temporarily override process.platform via Object.defineProperty.
 *  - Spy on console.log and process.exit to assert dispatch output.
 *
 * Invariants under test:
 *  - darwin + run → stderr "use launchd" + exit 1.
 *  - linux + install → prints foreground-process guidance (not launchd commands).
 *  - linux + status → calls pgrep (not launchctl).
 *  - darwin + status → calls launchctl print (not pgrep).
 *  - unknown sub → "Usage" stderr + exit 1.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// Mock child_process so no real OS calls are made
vi.mock('child_process', () => ({
  execSync: vi.fn((cmd: string) => {
    if (typeof cmd === 'string' && cmd.includes('id -u')) return '501';
    // pgrep exit code: 0 = running.  We return empty string (no throw) to simulate "running".
    return '';
  }),
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}));

// Mock fs so darwin install doesn't write to ~/Library/LaunchAgents in tests
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: vi.fn((path: string, encoding?: string) => {
      // Return a minimal valid plist for the template substitution
      if (typeof path === 'string' && path.includes('plist.template')) {
        return '<plist>__WRAPPER__ __ENV_FILE__</plist>';
      }
      return actual.readFileSync(path, encoding as BufferEncoding);
    }),
    writeFileSync: vi.fn(() => undefined),
    appendFileSync: vi.fn(() => undefined),
  };
});

import { runSchedulerCommand } from '../src/adapter/recense-scheduler';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const origPlatform = process.platform;

function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
}

// ---------------------------------------------------------------------------
// Tests: darwin run → exit 1 with launchd guidance
// ---------------------------------------------------------------------------

describe('runSchedulerCommand — darwin', () => {
  beforeEach(() => setPlatform('darwin'));
  afterEach(() => {
    restorePlatform();
    vi.clearAllMocks();
  });

  it('run → writes launchd message to stderr and exits 1', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    runSchedulerCommand('run', []);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('launchd'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('status → calls launchctl print (darwin path)', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    runSchedulerCommand('status', []);

    const calls = vi.mocked(execSync).mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('launchctl print'))).toBe(true);

    consoleSpy.mockRestore();
  });

  it('install → does not print Linux guidance text', () => {
    const logOutput: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      logOutput.push(String(msg));
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    try { runSchedulerCommand('install', []); } catch { /* plist write may throw in test env */ }

    // Darwin install should NOT print the Linux "stops when this process exits" guidance
    const joined = logOutput.join('\n');
    expect(joined).not.toContain('stops when this process exits');

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Tests: linux/non-darwin install + status
// ---------------------------------------------------------------------------

describe('runSchedulerCommand — linux', () => {
  beforeEach(() => setPlatform('linux'));
  afterEach(() => {
    restorePlatform();
    vi.clearAllMocks();
  });

  it('install → prints guidance mentioning recense scheduler run (not launchd)', () => {
    const logOutput: string[] = [];
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      logOutput.push(String(msg));
    });

    runSchedulerCommand('install', []);

    const joined = logOutput.join('\n');
    expect(joined).toContain('recense scheduler run');
    // Must NOT call launchctl commands
    const execCalls = vi.mocked(execSync).mock.calls.map(c => c[0] as string);
    expect(execCalls.every(c => !c.includes('launchctl'))).toBe(true);

    consoleSpy.mockRestore();
  });

  it('status → calls pgrep -f "recense scheduler run"', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    runSchedulerCommand('status', []);

    const calls = vi.mocked(execSync).mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('pgrep') && c.includes('recense scheduler run'))).toBe(true);

    consoleSpy.mockRestore();
  });

  it('status (not running) → informational message, no error exit', () => {
    // Simulate pgrep finding nothing (throws on non-zero exit)
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (cmd.includes('pgrep')) throw new Error('no process found');
      return '';
    });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    runSchedulerCommand('status', []);

    // Exit must NOT be called — not-running is informational on Linux (D-92)
    expect(exitSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Tests: default / unknown subcommand
// ---------------------------------------------------------------------------

describe('runSchedulerCommand — default / unknown sub', () => {
  afterEach(() => {
    restorePlatform();
    vi.clearAllMocks();
  });

  it('unknown sub → writes "Usage" to stderr + exits 1', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    runSchedulerCommand('unknown', []);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('undefined sub → writes "Usage" to stderr + exits 1', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    runSchedulerCommand(undefined, []);

    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
