/**
 * Phase 44 Plan 04 — config-cli tests.
 *
 * Covers Task 1 (config-cli.ts): runConfigCommand set/show/get/preset
 *   — set→show round-trips, D-11 preset/override divergence label,
 *   — D-12 core guardrail warning on core-disabling set,
 *   — preset switching clears conflicting overrides.
 *
 * Covers Task 2 (recense-scheduler.ts): __FREQUENCY__ plist rendering
 *   — getSchedulerIntervalSeconds / renderPlistContent helpers,
 *   — config apply spy (schedulerOverride injection),
 *   — default-preserving fallback when sleepFrequencyHours is unset.
 *
 * All tests use a tmp directory; the founder's ~/.config/recense/settings.json is
 * never touched. RECENSE_DB is set to ':memory:' so resolveDbPath never fails.
 */

import {
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runConfigCommand } from '../src/adapter/config-cli';
import {
  getSchedulerIntervalSeconds,
  renderPlistContent,
} from '../src/adapter/recense-scheduler';
import { writeSettingsFile, loadSettingsFile } from '../src/adapter/settings-loader';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_DIR = join(tmpdir(), `recense-config-cli-test-${process.pid}`);
const TMP_SETTINGS = join(TMP_DIR, 'settings.json');

function ensureTmpDir() {
  if (!existsSync(TMP_DIR)) mkdirSync(TMP_DIR, { recursive: true });
}

function cleanupTmpSettings() {
  if (existsSync(TMP_SETTINGS)) unlinkSync(TMP_SETTINGS);
}

/** Run runConfigCommand silently (suppress console.log). */
function silentRun(
  sub: string,
  args: string[],
  schedulerOverride?: (s: string, a: string[]) => void,
) {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    runConfigCommand(sub, args, TMP_SETTINGS, schedulerOverride);
  } finally {
    spy.mockRestore();
  }
}

beforeEach(() => {
  ensureTmpDir();
  cleanupTmpSettings();
  // Ensure resolveDbPath has a valid RECENSE_DB (avoids missing-DB path errors)
  process.env['RECENSE_DB'] = ':memory:';
});

afterEach(() => {
  cleanupTmpSettings();
  delete process.env['RECENSE_DB'];
  // Clean up any env vars set during tests
  delete process.env['RECENSE_CORPUS_GEN'];
  delete process.env['RECENSE_CORPUS_GEN_MAX'];
  delete process.env['RECENSE_CORPUS_SUBJECT_DRIFT_THRESHOLD'];
});

// ---------------------------------------------------------------------------
// Task 1: show/get/set/preset round-trips + D-11/D-12
// ---------------------------------------------------------------------------

describe('runConfigCommand set → show round-trip', () => {
  it('set corpusGenMax stores override; show reflects it with source settings.json', () => {
    silentRun('set', ['corpusGenMax', '10']);

    const sf = loadSettingsFile(TMP_SETTINGS);
    expect(sf?.overrides.corpusGenMax).toBe(10);

    // show output should contain settings.json source for corpusGenMax
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => lines.push(msg));
    try {
      runConfigCommand('show', [], TMP_SETTINGS);
    } finally {
      spy.mockRestore();
    }
    const output = lines.join('\n');
    expect(output).toContain('settings.json');
    expect(output).toContain('10');
  });

  it('set consolSkipThreshold to valid value (0.3) stores override correctly', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    silentRun('set', ['consolSkipThreshold', '0.3']);
    stderrSpy.mockRestore();

    const sf = loadSettingsFile(TMP_SETTINGS);
    expect(sf?.overrides.consolSkipThreshold).toBe(0.3);
  });

  it('get corpusGenMax returns 10 with source settings.json after set', () => {
    silentRun('set', ['corpusGenMax', '10']);

    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => lines.push(msg));
    try {
      runConfigCommand('get', ['corpusGenMax'], TMP_SETTINGS);
    } finally {
      spy.mockRestore();
    }
    const output = lines.join('\n');
    expect(output).toContain('10');
    expect(output).toContain('settings.json');
  });

  it('set corpusGen boolean coerces string true', () => {
    silentRun('set', ['corpusGen', 'true']);
    const sf = loadSettingsFile(TMP_SETTINGS);
    expect(sf?.overrides.corpusGen).toBe(true);
  });

  it('set corpusGen boolean coerces 0 as false', () => {
    silentRun('set', ['corpusGen', '0']);
    // corpusGen is a BOOLEAN_KEY — '0' is not 'true'/'1' so it should be false
    const sf = loadSettingsFile(TMP_SETTINGS);
    expect(sf?.overrides.corpusGen).toBe(false);
  });

  it('set unknown key exits with non-zero and writes nothing', () => {
    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrLines.push(String(msg));
      return true;
    });
    // Use throwing mock so code stops after process.exit (otherwise mocked exit is a no-op)
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('EXIT:1'); }) as never);

    let threw = false;
    try {
      runConfigCommand('set', ['bogusKey', '1'], TMP_SETTINGS);
    } catch (e) {
      if (e instanceof Error && e.message === 'EXIT:1') threw = true;
      else throw e;
    } finally {
      stderrSpy.mockRestore();
      vi.restoreAllMocks();
    }

    expect(threw).toBe(true);
    expect(stderrLines.some(l => l.includes('bogusKey'))).toBe(true);
    expect(existsSync(TMP_SETTINGS)).toBe(false);
  });
});

describe('D-11 preset divergence label', () => {
  it('shows plain preset name when no overrides set', () => {
    // No settings file → defaults to Standard (no modification)
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => lines.push(msg));
    try {
      runConfigCommand('show', [], TMP_SETTINGS);
    } finally {
      spy.mockRestore();
    }
    const output = lines.join('\n');
    expect(output).toContain('Preset: Standard');
    expect(output).not.toContain('(modified)');
  });

  it('shows (modified) when an override differs from preset baseline', () => {
    // Standard preset has corpusGen=false; override it to true → divergence
    silentRun('set', ['corpusGen', 'true']);

    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => lines.push(msg));
    try {
      runConfigCommand('show', [], TMP_SETTINGS);
    } finally {
      spy.mockRestore();
    }
    const output = lines.join('\n');
    expect(output).toContain('(modified)');
  });
});

describe('D-12 core guardrail — core-disabling set rejected', () => {
  it('rejects consolSkipThreshold = 1 (exactly 1 disables all extraction)', () => {
    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrLines.push(String(msg));
      return true;
    });

    silentRun('set', ['consolSkipThreshold', '1']);

    stderrSpy.mockRestore();

    // D-12 guardrail should warn
    expect(stderrLines.some(l => l.toLowerCase().includes('guardrail') || l.toLowerCase().includes('rejected'))).toBe(true);
  });

  it('rejects consolSkipThreshold = 2 (above 1)', () => {
    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrLines.push(String(msg));
      return true;
    });

    silentRun('set', ['consolSkipThreshold', '2']);

    stderrSpy.mockRestore();
    expect(stderrLines.some(l => l.toLowerCase().includes('guardrail') || l.toLowerCase().includes('rejected'))).toBe(true);
  });

  it('rejects consolSkipThresholdAssistant = 1', () => {
    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrLines.push(String(msg));
      return true;
    });

    silentRun('set', ['consolSkipThresholdAssistant', '1']);

    stderrSpy.mockRestore();
    expect(stderrLines.some(l => l.toLowerCase().includes('guardrail') || l.toLowerCase().includes('rejected'))).toBe(true);
  });

  it('allows consolSkipThreshold = 0.5 (valid — in (0,1) range)', () => {
    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrLines.push(String(msg));
      return true;
    });

    silentRun('set', ['consolSkipThreshold', '0.5']);

    stderrSpy.mockRestore();
    expect(stderrLines.length).toBe(0);

    const sf = loadSettingsFile(TMP_SETTINGS);
    expect(sf?.overrides.consolSkipThreshold).toBe(0.5);
  });

  it('show output always contains the always-on core line (D-12)', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => lines.push(msg));
    try {
      runConfigCommand('show', [], TMP_SETTINGS);
    } finally {
      spy.mockRestore();
    }
    const output = lines.join('\n');
    expect(output).toContain('always on');
    expect(output).toContain('extract + reconsolidation');
  });
});

describe('preset subcommand — D-11 clean switch', () => {
  it('sets preset to lite', () => {
    silentRun('preset', ['lite']);
    const sf = loadSettingsFile(TMP_SETTINGS);
    expect(sf?.preset).toBe('lite');
  });

  it('switches to standard and clears overrides defined by standard preset', () => {
    // Start on full with an override for corpusGenMax
    writeSettingsFile(
      { preset: 'full', overrides: { corpusGenMax: 50, consolSkipThreshold: 0.3 } },
      TMP_SETTINGS,
    );

    silentRun('preset', ['standard']);

    const sf = loadSettingsFile(TMP_SETTINGS);
    expect(sf?.preset).toBe('standard');
    // corpusGenMax is defined by full preset but NOT by standard — keep override
    // standard DOES define corpusGen + schemaInductionEnabled — clear those if present
    // In this case consolSkipThreshold is NOT defined by standard preset, so it's kept
    expect(sf?.overrides.consolSkipThreshold).toBe(0.3);
  });

  it('switching to lite clears schemaInductionEnabled and corpusGen overrides', () => {
    // Start with schemaInductionEnabled and corpusGen overrides
    writeSettingsFile(
      { preset: 'standard', overrides: { schemaInductionEnabled: false, corpusGen: true } },
      TMP_SETTINGS,
    );

    silentRun('preset', ['lite']);

    const sf = loadSettingsFile(TMP_SETTINGS);
    expect(sf?.preset).toBe('lite');
    // lite preset explicitly defines schemaInductionEnabled and corpusGen — clear them
    expect(sf?.overrides.schemaInductionEnabled).toBeUndefined();
    expect(sf?.overrides.corpusGen).toBeUndefined();
  });

  it('rejects invalid preset name and exits 1', () => {
    const stderrLines: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrLines.push(String(msg));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('EXIT:1'); }) as never);

    let threw = false;
    try {
      runConfigCommand('preset', ['ultra'], TMP_SETTINGS);
    } catch (e) {
      if (e instanceof Error && e.message === 'EXIT:1') threw = true;
      else throw e;
    } finally {
      stderrSpy.mockRestore();
      vi.restoreAllMocks();
    }

    expect(threw).toBe(true);
    expect(stderrLines.some(l => l.includes('lite') || l.includes('standard') || l.includes('full'))).toBe(true);
  });
});

describe('sleepFrequencyHours set/get round-trip', () => {
  it('sets sleepFrequencyHours and get retrieves it', () => {
    silentRun('set', ['sleepFrequencyHours', '6']);
    const sf = loadSettingsFile(TMP_SETTINGS);
    expect(sf?.overrides.sleepFrequencyHours).toBe(6);

    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg: string) => lines.push(msg));
    try {
      runConfigCommand('get', ['sleepFrequencyHours'], TMP_SETTINGS);
    } finally {
      spy.mockRestore();
    }
    const output = lines.join('\n');
    expect(output).toContain('6');
    expect(output).toContain('settings.json');
  });
});

describe('config apply — schedulerOverride spy', () => {
  it('calls runSchedulerCommand("install", []) on darwin (via schedulerOverride)', () => {
    const calls: Array<[string, string[]]> = [];
    const schedulerSpy = (sub: string, args: string[]) => { calls.push([sub, args]); };

    // Override platform check for test (apply checks process.platform === 'darwin')
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });

    try {
      runConfigCommand('apply', [], TMP_SETTINGS, schedulerSpy);
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['install', []]);
  });

  it('config apply with no sleepFrequencyHours does not throw (scheduler still called)', () => {
    // No settings file — defaults apply
    const calls: Array<[string, string[]]> = [];
    const schedulerSpy = (sub: string, args: string[]) => { calls.push([sub, args]); };

    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: true });

    let threw = false;
    try {
      runConfigCommand('apply', [], TMP_SETTINGS, schedulerSpy);
    } catch {
      threw = true;
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }

    expect(threw).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Task 2: __FREQUENCY__ plist rendering helpers
// ---------------------------------------------------------------------------

describe('getSchedulerIntervalSeconds', () => {
  it('returns 21600 when sleepFrequencyHours = 6', () => {
    writeSettingsFile({ preset: 'standard', overrides: { sleepFrequencyHours: 6 } }, TMP_SETTINGS);
    const seconds = getSchedulerIntervalSeconds(TMP_SETTINGS);
    expect(seconds).toBe(21600); // 6 * 3600
  });

  it('returns 3600 (default) when sleepFrequencyHours is not set', () => {
    // No settings file
    const seconds = getSchedulerIntervalSeconds(TMP_SETTINGS);
    expect(seconds).toBe(3600); // 1 hour default
  });

  it('returns 3600 when settings file exists but sleepFrequencyHours is absent', () => {
    writeSettingsFile({ preset: 'standard', overrides: {} }, TMP_SETTINGS);
    const seconds = getSchedulerIntervalSeconds(TMP_SETTINGS);
    expect(seconds).toBe(3600);
  });

  it('coerces non-integer sleepFrequencyHours to integer seconds', () => {
    writeSettingsFile(
      { preset: 'standard', overrides: { sleepFrequencyHours: 2.5 } },
      TMP_SETTINGS,
    );
    const seconds = getSchedulerIntervalSeconds(TMP_SETTINGS);
    // 2.5 * 3600 = 9000; parseInt(9000) = 9000
    expect(seconds).toBe(9000);
  });
});

describe('renderPlistContent', () => {
  const FAKE_TEMPLATE = `<key>StartInterval</key>
<integer>__FREQUENCY__</integer>
<key>ProgramArguments</key>
<string>__WRAPPER__</string>
<key>RECENSE_SLEEP_ENV</key>
<string>__ENV_FILE__</string>`;

  it('substitutes __FREQUENCY__ with the given interval seconds', () => {
    const rendered = renderPlistContent(FAKE_TEMPLATE, '/path/to/wrapper.sh', '/path/to/sleep.env', 21600);
    expect(rendered).toContain('<integer>21600</integer>');
    expect(rendered).not.toContain('__FREQUENCY__');
  });

  it('substitutes __WRAPPER__ and __ENV_FILE__ alongside __FREQUENCY__', () => {
    const rendered = renderPlistContent(FAKE_TEMPLATE, '/usr/local/bin/wrapper.sh', '/home/user/.env', 3600);
    expect(rendered).toContain('/usr/local/bin/wrapper.sh');
    expect(rendered).toContain('/home/user/.env');
    expect(rendered).toContain('<integer>3600</integer>');
    expect(rendered).not.toContain('__WRAPPER__');
    expect(rendered).not.toContain('__ENV_FILE__');
  });

  it('given sleepFrequencyHours=6, rendered plist contains StartInterval 21600', () => {
    // End-to-end: write settings, compute interval, render template
    writeSettingsFile({ preset: 'standard', overrides: { sleepFrequencyHours: 6 } }, TMP_SETTINGS);
    const intervalSeconds = getSchedulerIntervalSeconds(TMP_SETTINGS);
    const rendered = renderPlistContent(
      FAKE_TEMPLATE,
      '/wrapper.sh',
      '/sleep.env',
      intervalSeconds,
    );
    expect(rendered).toContain('<integer>21600</integer>');
  });

  it('with unset sleepFrequencyHours, rendered plist contains StartInterval 3600', () => {
    const intervalSeconds = getSchedulerIntervalSeconds(TMP_SETTINGS);
    const rendered = renderPlistContent(
      FAKE_TEMPLATE,
      '/wrapper.sh',
      '/sleep.env',
      intervalSeconds,
    );
    expect(rendered).toContain('<integer>3600</integer>');
  });
});
