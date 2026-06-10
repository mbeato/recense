/**
 * Tests for runtime-config — the single source of truth for DB-path and env
 * resolution shared by `brain init` and the three Claude Code hooks.
 *
 * Guards Phase 9 CR-01: init and the hooks previously diverged on the default DB
 * path and only read BRAIN_MEMORY_DB from the (often-absent) shell env.
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
} from '../src/adapter/runtime-config';

describe('defaultDbPath', () => {
  it('is ~/.config/brain-memory/brain.db (the one init seeds)', () => {
    expect(defaultDbPath()).toBe(join(homedir(), '.config', 'brain-memory', 'brain.db'));
  });
});

describe('resolveDbPath precedence', () => {
  let prev: string | undefined;
  beforeEach(() => { prev = process.env['BRAIN_MEMORY_DB']; delete process.env['BRAIN_MEMORY_DB']; });
  afterEach(() => { if (prev !== undefined) process.env['BRAIN_MEMORY_DB'] = prev; else delete process.env['BRAIN_MEMORY_DB']; });

  it('prefers the --db argv flag above all else', () => {
    process.env['BRAIN_MEMORY_DB'] = '/env/path.db';
    expect(resolveDbPath(['node', 'brain.js', 'hook', 'stop', '--db', '/flag/path.db'])).toBe('/flag/path.db');
  });

  it('falls back to BRAIN_MEMORY_DB when no --db flag', () => {
    process.env['BRAIN_MEMORY_DB'] = '/env/path.db';
    expect(resolveDbPath(['node', 'brain.js', 'hook', 'stop'])).toBe('/env/path.db');
  });

  it('falls back to the shared default when neither flag nor env is present', () => {
    expect(resolveDbPath(['node', 'brain.js', 'hook', 'stop'])).toBe(defaultDbPath());
  });

  it('ignores a dangling --db with no value', () => {
    expect(resolveDbPath(['node', 'brain.js', 'hook', 'stop', '--db'])).toBe(defaultDbPath());
  });

  // M-8: fallbackToDefault option
  it('{ fallbackToDefault: false } returns undefined when neither --db nor env is set', () => {
    expect(resolveDbPath([], { fallbackToDefault: false })).toBeUndefined();
  });

  it('{ fallbackToDefault: false } still returns env path when BRAIN_MEMORY_DB is set', () => {
    process.env['BRAIN_MEMORY_DB'] = '/env/path.db';
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
  const KEYS = ['BRAIN_MEMORY_DB', 'ANTHROPIC_API_KEY', 'BRAIN_MEMORY_TEST_ONLY'];
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
    const p = writeEnv('BRAIN_MEMORY_DB=/real/brain.db\nBRAIN_MEMORY_TEST_ONLY=x\n');
    const applied = hydrateRuntimeEnv(p);
    expect(process.env['BRAIN_MEMORY_DB']).toBe('/real/brain.db');
    expect(process.env['BRAIN_MEMORY_TEST_ONLY']).toBe('x');
    expect(applied).toContain('BRAIN_MEMORY_DB');
  });

  it('does NOT override a key already set in the shell env (set-only-if-missing)', () => {
    process.env['BRAIN_MEMORY_DB'] = '/shell/wins.db';
    const p = writeEnv('BRAIN_MEMORY_DB=/file/loses.db\n');
    const applied = hydrateRuntimeEnv(p);
    expect(process.env['BRAIN_MEMORY_DB']).toBe('/shell/wins.db');
    expect(applied).not.toContain('BRAIN_MEMORY_DB');
  });

  it('returns [] when the env file is absent', () => {
    expect(hydrateRuntimeEnv('/tmp/nope-brain-hydrate.env')).toEqual([]);
  });
});

describe('sleepEnvPath', () => {
  it('honors BRAIN_MEMORY_SLEEP_ENV override', () => {
    const prev = process.env['BRAIN_MEMORY_SLEEP_ENV'];
    process.env['BRAIN_MEMORY_SLEEP_ENV'] = '/custom/sleep.env';
    try {
      expect(sleepEnvPath()).toBe('/custom/sleep.env');
    } finally {
      if (prev !== undefined) process.env['BRAIN_MEMORY_SLEEP_ENV'] = prev;
      else delete process.env['BRAIN_MEMORY_SLEEP_ENV'];
    }
  });
});
