/**
 * Tests for runtime-config — the single source of truth for DB-path and env
 * resolution shared by `recense init` and the three Claude Code hooks.
 *
 * Guards Phase 9 CR-01: init and the hooks previously diverged on the default DB
 * path and only read RECENSE_DB from the (often-absent) shell env.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import {
  defaultDbPath,
  resolveDbPath,
  sleepEnvPath,
  loadConfiguredEnv,
  hydrateRuntimeEnv,
  resolveEnabledSources,
} from '../src/adapter/runtime-config';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { INTENT_CONFIDENCES } from '../src/model/claim-extractor';
import { routeContradiction } from '../src/consolidation/update-decision';

describe('defaultDbPath', () => {
  it('is ~/.config/recense/recense.db (the one init seeds)', () => {
    expect(defaultDbPath()).toBe(join(homedir(), '.config', 'recense', 'recense.db'));
  });
});

describe('resolveDbPath precedence', () => {
  let prev: string | undefined;
  beforeEach(() => { prev = process.env['RECENSE_DB']; delete process.env['RECENSE_DB']; });
  afterEach(() => { if (prev !== undefined) process.env['RECENSE_DB'] = prev; else delete process.env['RECENSE_DB']; });

  it('prefers the --db argv flag above all else', () => {
    process.env['RECENSE_DB'] = '/env/path.db';
    expect(resolveDbPath(['node', 'recense.js', 'hook', 'stop', '--db', '/flag/path.db'])).toBe('/flag/path.db');
  });

  it('falls back to RECENSE_DB when no --db flag', () => {
    process.env['RECENSE_DB'] = '/env/path.db';
    expect(resolveDbPath(['node', 'recense.js', 'hook', 'stop'])).toBe('/env/path.db');
  });

  it('falls back to the shared default when neither flag nor env is present', () => {
    expect(resolveDbPath(['node', 'recense.js', 'hook', 'stop'])).toBe(defaultDbPath());
  });

  it('ignores a dangling --db with no value', () => {
    expect(resolveDbPath(['node', 'recense.js', 'hook', 'stop', '--db'])).toBe(defaultDbPath());
  });

  // M-8: fallbackToDefault option
  it('{ fallbackToDefault: false } returns undefined when neither --db nor env is set', () => {
    expect(resolveDbPath([], { fallbackToDefault: false })).toBeUndefined();
  });

  it('{ fallbackToDefault: false } still returns env path when RECENSE_DB is set', () => {
    process.env['RECENSE_DB'] = '/env/path.db';
    expect(resolveDbPath([], { fallbackToDefault: false })).toBe('/env/path.db');
  });

  it('{ fallbackToDefault: false } --db flag always wins regardless of toggle', () => {
    expect(resolveDbPath(['node', 'x', '--db', '/x.db'], { fallbackToDefault: false })).toBe('/x.db');
  });

  it('fallbackToDefault omitted (default) returns defaultDbPath() when nothing is set', () => {
    expect(resolveDbPath([])).toBe(defaultDbPath());
  });
});

describe('loadConfiguredEnv', () => {
  it('returns {} when the env file does not exist', () => {
    expect(loadConfiguredEnv('/tmp/does-not-exist-brain-xyz.env')).toEqual({});
  });

  it('parses key=value lines, skipping comments and blanks; splits on first = only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-runtime-cfg-'));
    const envPath = join(dir, 'sleep.env');
    writeFileSync(envPath, '# comment\n\nANTHROPIC_API_KEY=sk-ant=weird\nOPENAI_API_KEY=sk-oai\n');
    const env = loadConfiguredEnv(envPath);
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant=weird');
    expect(env['OPENAI_API_KEY']).toBe('sk-oai');
    expect(Object.keys(env)).toHaveLength(2);
  });
});

describe('hydrateRuntimeEnv', () => {
  const KEYS = ['RECENSE_DB', 'ANTHROPIC_API_KEY', 'RECENSE_TEST_ONLY'];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  });

  const writeEnv = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-hydrate-'));
    const p = join(dir, 'sleep.env');
    writeFileSync(p, content);
    return p;
  };

  it('sets keys that are absent from the ambient env', () => {
    const p = writeEnv('RECENSE_DB=/real/recense.db\nRECENSE_TEST_ONLY=x\n');
    const applied = hydrateRuntimeEnv(p);
    expect(process.env['RECENSE_DB']).toBe('/real/recense.db');
    expect(process.env['RECENSE_TEST_ONLY']).toBe('x');
    expect(applied).toContain('RECENSE_DB');
  });

  it('does NOT override a key already set in the shell env (set-only-if-missing)', () => {
    process.env['RECENSE_DB'] = '/shell/wins.db';
    const p = writeEnv('RECENSE_DB=/file/loses.db\n');
    const applied = hydrateRuntimeEnv(p);
    expect(process.env['RECENSE_DB']).toBe('/shell/wins.db');
    expect(applied).not.toContain('RECENSE_DB');
  });

  it('returns [] when the env file is absent', () => {
    expect(hydrateRuntimeEnv('/tmp/nope-brain-hydrate.env')).toEqual([]);
  });
});

describe('sleepEnvPath', () => {
  it('honors RECENSE_SLEEP_ENV override', () => {
    const prev = process.env['RECENSE_SLEEP_ENV'];
    process.env['RECENSE_SLEEP_ENV'] = '/custom/sleep.env';
    try {
      expect(sleepEnvPath()).toBe('/custom/sleep.env');
    } finally {
      if (prev !== undefined) process.env['RECENSE_SLEEP_ENV'] = prev;
      else delete process.env['RECENSE_SLEEP_ENV'];
    }
  });
});

describe('resolveEnabledSources', () => {
  it('returns [] when RECENSE_ENABLED_SOURCES is unset (default-off, D-66/D-63)', () => {
    expect(resolveEnabledSources({})).toEqual([]);
  });

  it('returns ["gmail"] when RECENSE_ENABLED_SOURCES="gmail"', () => {
    expect(resolveEnabledSources({ RECENSE_ENABLED_SOURCES: 'gmail' })).toEqual(['gmail']);
  });

  it('splits comma-separated values and trims whitespace', () => {
    expect(resolveEnabledSources({ RECENSE_ENABLED_SOURCES: 'gmail, gcal' })).toEqual(['gmail', 'gcal']);
  });

  it('returns [] when RECENSE_ENABLED_SOURCES is empty string (preserves default-off)', () => {
    expect(resolveEnabledSources({ RECENSE_ENABLED_SOURCES: '' })).toEqual([]);
  });

  it('drops empty segments from comma-separated values', () => {
    expect(resolveEnabledSources({ RECENSE_ENABLED_SOURCES: 'gmail,,gcal' })).toEqual(['gmail', 'gcal']);
  });
});

describe('Phase 65 dark knobs — stock defaults reproduce pre-phase behavior', () => {
  const testConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

  it('provenance-distinctness stays dark: disabled, no per-source override, global N unchanged', () => {
    expect(DEFAULT_CONFIG.provenanceDistinctnessEnabled).toBe(false);
    expect(DEFAULT_CONFIG.contradictionNBySource).toEqual({});
    expect(DEFAULT_CONFIG.contradictionN).toBe(3);
  });

  it('status-drift layer defaults ON with the event_ts staleness guard armed', () => {
    expect(DEFAULT_CONFIG.statusDriftEnabled).toBe(true);
    expect(DEFAULT_CONFIG.statusDriftEventTsGuard).toBe(true);
  });

  it('damping key-set is parity-guarded against the live IntentConfidence enum', () => {
    expect(Object.keys(DEFAULT_CONFIG.statusDriftConfidenceDamping).sort())
      .toEqual([...INTENT_CONFIDENCES].sort());
  });

  it('every damping factor sits inside the non-amplification domain [0, 1]', () => {
    for (const factor of Object.values(DEFAULT_CONFIG.statusDriftConfidenceDamping)) {
      expect(factor).toBeGreaterThanOrEqual(0);
      expect(factor).toBeLessThanOrEqual(1);
    }
  });

  it('the low:0 mechanism, proven not asserted: magnitude 0 always routes to hold via the real routeContradiction', () => {
    // Empirical basis for the low:0 gate-to-hold design (D-09). If peReconcileBandLow is ever
    // lowered to 0, this test is the tripwire — magnitude 0 / resistance would then land exactly
    // on the band boundary instead of strictly below it.
    const resistances = [0.1 * 0.5, 0.9 * 0.9, 0];
    for (const resistance of resistances) {
      expect(routeContradiction(0, resistance, testConfig)).toBe('hold');
    }
  });

  it('provenanceMinResidualChars is a positive integer defaulting to 20', () => {
    expect(DEFAULT_CONFIG.provenanceMinResidualChars).toBe(20);
    expect(Number.isInteger(DEFAULT_CONFIG.provenanceMinResidualChars)).toBe(true);
    expect(DEFAULT_CONFIG.provenanceMinResidualChars).toBeGreaterThan(0);
  });
});
