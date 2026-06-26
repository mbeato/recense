/**
 * Tests for brain-init helpers (INSTALL-01/02/03 + D-88/D-89/D-90/D-91 + D-04..D-10).
 *
 * Tests exported helpers only — never runs main() (no real readline, no real API
 * calls, no real settings.json, no real recense.db).
 *
 * All API provider calls are mocked. Env files and settings.json use temp paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Hoist mock helpers so vi.mock class bodies can reference them ─────────────
// vi.hoisted() ensures these are evaluated before the vi.mock() factories run.
const { mockAnthropicCreate, mockOpenAiCreate } = vi.hoisted(() => ({
  mockAnthropicCreate: vi.fn(),
  mockOpenAiCreate: vi.fn(),
}));

// Use classes (not arrow functions) because `new Anthropic()` requires a real constructor.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages: { create: typeof mockAnthropicCreate };
    constructor(_config: { apiKey: string }) {
      this.messages = { create: mockAnthropicCreate };
    }
  },
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    embeddings: { create: typeof mockOpenAiCreate };
    constructor(_config: { apiKey: string }) {
      this.embeddings = { create: mockOpenAiCreate };
    }
  },
}));

import {
  resolveExistingEnv,
  isKeyUnchanged,
  captureNodeBin,
  writeEnvFile,
  validateApiKey,
  mergeSettingsHooks,
  parseProviderChoice,
  shouldBlockOnLeak,
} from '../src/adapter/recense-init';
import { resolveDbPath } from '../src/adapter/runtime-config';

// ── resolveExistingEnv ────────────────────────────────────────────────────────

describe('resolveExistingEnv', () => {
  it('returns empty Map when the file does not exist', () => {
    const m = resolveExistingEnv('/tmp/nonexistent-brain-init-test-xyz987.env');
    expect(m.size).toBe(0);
  });

  it('parses KEY=value pairs into the Map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-init-test-'));
    const envPath = join(dir, 'sleep.env');
    writeFileSync(envPath, 'RECENSE_DB=/path/to/recense.db\nANTHROPIC_API_KEY=sk-ant-test\n');
    const m = resolveExistingEnv(envPath);
    expect(m.get('RECENSE_DB')).toBe('/path/to/recense.db');
    expect(m.get('ANTHROPIC_API_KEY')).toBe('sk-ant-test');
  });

  it('skips comment lines (# prefix) and blank lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-init-test-'));
    const envPath = join(dir, 'sleep.env');
    writeFileSync(envPath, '# comment\n\nKEY=value\n# another comment\n\n');
    const m = resolveExistingEnv(envPath);
    expect(m.size).toBe(1);
    expect(m.get('KEY')).toBe('value');
  });

  it('splits on the first = only (values may contain = signs)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-init-test-'));
    const envPath = join(dir, 'sleep.env');
    writeFileSync(envPath, 'API_KEY=abc=def=ghi\n');
    const m = resolveExistingEnv(envPath);
    expect(m.get('API_KEY')).toBe('abc=def=ghi');
  });
});

// ── isKeyUnchanged ────────────────────────────────────────────────────────────

describe('isKeyUnchanged', () => {
  it('returns true when the two key strings are identical', () => {
    expect(isKeyUnchanged('sk-ant-test-key', 'sk-ant-test-key')).toBe(true);
  });

  it('returns false when the key strings differ', () => {
    expect(isKeyUnchanged('sk-ant-old-key', 'sk-ant-new-key')).toBe(false);
  });

  it('returns true for empty string compared to empty string', () => {
    expect(isKeyUnchanged('', '')).toBe(true);
  });

  it('returns false for empty string vs a non-empty key', () => {
    expect(isKeyUnchanged('', 'sk-ant-test')).toBe(false);
  });

  it('is symmetric — order of arguments does not change the result', () => {
    expect(isKeyUnchanged('key-a', 'key-b')).toBe(false);
    expect(isKeyUnchanged('key-b', 'key-a')).toBe(false);
  });
});

// ── captureNodeBin ────────────────────────────────────────────────────────────

describe('captureNodeBin', () => {
  it('returns process.execPath (INSTALL-03)', () => {
    expect(captureNodeBin()).toBe(process.execPath);
  });

  it('returns an absolute path (starts with /)', () => {
    expect(captureNodeBin().startsWith('/')).toBe(true);
  });
});

// ── writeEnvFile ──────────────────────────────────────────────────────────────

describe('writeEnvFile', () => {
  it('writes KEY=value lines to the target path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-init-test-'));
    const envPath = join(dir, 'sleep.env');
    writeEnvFile(envPath, { FOO: 'bar', BAZ: 'qux' });
    const content = readFileSync(envPath, 'utf8');
    expect(content).toContain('FOO=bar');
    expect(content).toContain('BAZ=qux');
  });

  it('writes the file with mode 0o600 (chmod-600, T-09-17)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-init-test-'));
    const envPath = join(dir, 'sleep.env');
    writeEnvFile(envPath, { KEY: 'val' });
    const mode = statSync(envPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates parent directories if they do not yet exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-init-test-'));
    const envPath = join(dir, 'nested', 'deep', 'sleep.env');
    writeEnvFile(envPath, { K: 'v' });
    expect(readFileSync(envPath, 'utf8')).toContain('K=v');
  });

  it('is idempotent — re-run overwrites with mode 0o600 preserved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-init-test-'));
    const envPath = join(dir, 'sleep.env');
    writeEnvFile(envPath, { KEY: 'first' });
    writeEnvFile(envPath, { KEY: 'second' });
    const content = readFileSync(envPath, 'utf8');
    expect(content).toContain('KEY=second');
    expect(content).not.toContain('KEY=first');
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it('preserves comments and unrecognized keys on re-write (IN-03)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-init-test-'));
    const envPath = join(dir, 'sleep.env');
    // Simulate a file with guidance comments + a commented placeholder + an extra key
    writeFileSync(
      envPath,
      '# guidance comment\nRECENSE_DB=/old/path.db\n# GMAIL_CLIENT_ID=\nCUSTOM_EXTRA=keepme\n',
    );
    // Re-run init only touches RECENSE_DB
    writeEnvFile(envPath, { RECENSE_DB: '/new/path.db' });
    const content = readFileSync(envPath, 'utf8');
    expect(content).toContain('# guidance comment');       // comment preserved
    expect(content).toContain('# GMAIL_CLIENT_ID=');        // placeholder preserved
    expect(content).toContain('CUSTOM_EXTRA=keepme');       // unrecognized key preserved
    expect(content).toContain('RECENSE_DB=/new/path.db'); // known key updated
    expect(content).not.toContain('/old/path.db');
  });

  it('drops keys listed in removeKeys, even when absent from vars (T-45-07)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-init-test-'));
    const envPath = join(dir, 'sleep.env');
    // Simulate a prior direct-api run that wrote ANTHROPIC_API_KEY into sleep.env.
    writeFileSync(envPath, 'RECENSE_DB=/db\nANTHROPIC_API_KEY=sk-ant-stale\n');
    // Subscription re-run: write the provider, drop the stale Anthropic key.
    writeEnvFile(envPath, { RECENSE_MODEL_PROVIDER: 'claude-headless' }, ['ANTHROPIC_API_KEY']);
    const content = readFileSync(envPath, 'utf8');
    expect(content).toContain('RECENSE_MODEL_PROVIDER=claude-headless');
    expect(content).not.toContain('ANTHROPIC_API_KEY'); // stale leak key removed
    expect(content).not.toContain('sk-ant-stale');
    expect(content).toContain('RECENSE_DB=/db'); // unrelated key preserved
  });
});

// ── validateApiKey ────────────────────────────────────────────────────────────

describe('validateApiKey', () => {
  beforeEach(() => {
    mockAnthropicCreate.mockReset();
    mockOpenAiCreate.mockReset();
  });

  it('returns ok=false immediately for an empty key', async () => {
    const r = await validateApiKey('', 'anthropic');
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });

  it('returns ok=true when the Anthropic call succeeds (mocked)', async () => {
    mockAnthropicCreate.mockResolvedValueOnce({ content: [] } as unknown);
    const r = await validateApiKey('sk-ant-valid', 'anthropic');
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('returns ok=false with error when the Anthropic call throws (mocked 401)', async () => {
    mockAnthropicCreate.mockRejectedValueOnce(new Error('401 Authentication error'));
    const r = await validateApiKey('sk-ant-bad', 'anthropic');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/401/);
  });

  it('returns ok=true when the OpenAI call succeeds (mocked)', async () => {
    mockOpenAiCreate.mockResolvedValueOnce({ data: [] } as unknown);
    const r = await validateApiKey('sk-openai-valid', 'openai');
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('returns ok=false with error when the OpenAI call throws (mocked auth error)', async () => {
    mockOpenAiCreate.mockRejectedValueOnce(new Error('Incorrect API key provided'));
    const r = await validateApiKey('sk-openai-bad', 'openai');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Incorrect API key/);
  });
});

// ── mergeSettingsHooks (Task 2 — D-88/T-09-18) ───────────────────────────────

describe('mergeSettingsHooks', () => {
  const FAKE_NODE = '/usr/bin/node';
  const FAKE_BRAIN = '/path/to/dist/src/adapter/recense.js';
  const FAKE_DB = '/home/u/.config/recense/recense.db';

  it('adds SessionStart, UserPromptSubmit, and Stop recense hook entries to a fresh file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-init-settings-'));
    const settingsPath = join(dir, 'settings.json');

    mergeSettingsHooks(settingsPath, FAKE_NODE, FAKE_BRAIN, FAKE_DB);

    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      const groups = s.hooks[event] as Array<{ hooks: Array<{ command: string }> }>;
      const hasHook = groups.some(g =>
        g.hooks?.some(h => /recense.*hook/.test(h.command ?? '')),
      );
      expect(hasHook, `${event} hook missing`).toBe(true);
    }
  });

  it('removes old-style brain entries (basename match) and adds new-style (T-09-18)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-init-settings-'));
    const settingsPath = join(dir, 'settings.json');

    // Pre-populate with old-style entries
    const initial = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: '/nd/session-start-cli.js', timeout: 5 }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/nd/turn-capture-cli.js', timeout: 5 }] }],
        Stop: [{ hooks: [{ type: 'command', command: '/nd/stop-cli.js', timeout: 5 }] }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(initial));

    mergeSettingsHooks(settingsPath, FAKE_NODE, FAKE_BRAIN, FAKE_DB);

    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      const groups = s.hooks[event] as Array<{ hooks: Array<{ command: string }> }>;
      const allCmds = groups.flatMap(g => g.hooks?.map(h => h.command ?? '') ?? []);
      // Old-style entries must be removed
      for (const cmd of allCmds) {
        expect(cmd).not.toMatch(/session-start-cli\.js|turn-capture-cli\.js|stop-cli\.js/);
      }
      // New-style entry must be present
      const hasNew = allCmds.some(cmd => /recense.*hook/.test(cmd));
      expect(hasNew, `new-style hook missing for ${event}`).toBe(true);
    }
  });

  it('preserves non-recense hook entries (Pitfall 2 / T-09-18)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-init-settings-'));
    const settingsPath = join(dir, 'settings.json');

    const initial = {
      hooks: {
        SessionStart: [{
          hooks: [
            { type: 'command', command: '/other/tool/session-hook.sh', timeout: 10 },
            { type: 'command', command: '/nd/session-start-cli.js', timeout: 5 },
          ],
        }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(initial));

    mergeSettingsHooks(settingsPath, FAKE_NODE, FAKE_BRAIN, FAKE_DB);

    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const allCmds = (s.hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>)
      .flatMap(g => g.hooks?.map(h => h.command ?? '') ?? []);

    // Non-recense hook preserved
    expect(allCmds.some(cmd => cmd === '/other/tool/session-hook.sh')).toBe(true);
    // Old-style recense hook removed
    expect(allCmds.some(cmd => /session-start-cli\.js/.test(cmd))).toBe(false);
    // New-style recense hook present
    expect(allCmds.some(cmd => /recense.*hook/.test(cmd))).toBe(true);
  });

  it('writes with 2-space JSON formatting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-init-settings-'));
    const settingsPath = join(dir, 'settings.json');
    mergeSettingsHooks(settingsPath, FAKE_NODE, FAKE_BRAIN, FAKE_DB);
    const raw = readFileSync(settingsPath, 'utf8');
    // 2-space indentation: no tab characters
    expect(raw).not.toContain('\t');
    // Has at least one indented line
    expect(raw.split('\n').filter(l => l.startsWith('  ')).length).toBeGreaterThan(0);
  });

  it('is idempotent — running twice does not duplicate hook entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-init-settings-'));
    const settingsPath = join(dir, 'settings.json');
    mergeSettingsHooks(settingsPath, FAKE_NODE, FAKE_BRAIN, FAKE_DB);
    mergeSettingsHooks(settingsPath, FAKE_NODE, FAKE_BRAIN, FAKE_DB);

    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      const groups = s.hooks[event] as Array<{ hooks: Array<{ command: string }> }>;
      const brainEntries = groups
        .flatMap(g => g.hooks ?? [])
        .filter(h => /recense.*hook/.test(h.command ?? ''));
      expect(brainEntries.length).toBe(1);
    }
  });

  // ── CR-01 regression: the wired hook command must pin --db to the configured DB,
  //    and the hook's own resolver must recover exactly that path from its argv.
  //    This is the guard against the init-vs-hook DB-path divergence that silently
  //    broke the core loop on a default install.
  it('pins --db <configured> into every hook command and round-trips through resolveDbPath (CR-01)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-init-settings-'));
    const settingsPath = join(dir, 'settings.json');
    mergeSettingsHooks(settingsPath, FAKE_NODE, FAKE_BRAIN, FAKE_DB);

    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      const groups = s.hooks[event] as Array<{ hooks: Array<{ command: string }> }>;
      const cmd = groups
        .flatMap(g => g.hooks ?? [])
        .map(h => h.command ?? '')
        .find(c => /recense.*hook/.test(c));
      expect(cmd, `${event} recense hook missing`).toBeTruthy();
      // Command literally carries the configured DB
      expect(cmd).toContain(`--db ${FAKE_DB}`);
      // And the hook (running this exact command) resolves back to the same DB,
      // independent of process.env — proving init and the hooks now agree.
      const argv = (cmd as string).split(/\s+/);
      const prevEnv = process.env['RECENSE_DB'];
      delete process.env['RECENSE_DB'];
      try {
        expect(resolveDbPath(argv)).toBe(FAKE_DB);
      } finally {
        if (prevEnv !== undefined) process.env['RECENSE_DB'] = prevEnv;
      }
    }
  });

  it('strips brain hooks from matcher-scoped groups and adds to an unmatched group (WR-03)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-init-settings-'));
    const settingsPath = join(dir, 'settings.json');

    // SessionStart with a matcher-scoped group holding BOTH a stale recense hook and a
    // non-recense hook — the kind of layout that previously double-fired / went stale.
    const initial = {
      hooks: {
        SessionStart: [{
          matcher: 'startup',
          hooks: [
            { type: 'command', command: '/other/tool/on-start.sh', timeout: 10 },
            { type: 'command', command: '/nd/session-start-cli.js', timeout: 5 },
          ],
        }],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(initial));

    mergeSettingsHooks(settingsPath, FAKE_NODE, FAKE_BRAIN, FAKE_DB);

    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const groups = s.hooks.SessionStart as Array<{ matcher?: string; hooks: Array<{ command: string }> }>;

    // The matcher group keeps its non-recense hook and lost the stale brain entry.
    const matcherGroup = groups.find(g => g.matcher === 'startup')!;
    expect(matcherGroup.hooks.some(h => h.command === '/other/tool/on-start.sh')).toBe(true);
    expect(matcherGroup.hooks.some(h => /session-start-cli\.js/.test(h.command))).toBe(false);

    // The recense hook now lives in an unmatched group, pinned with --db, exactly once.
    const brainEntries = groups
      .flatMap(g => g.hooks ?? [])
      .filter(h => /recense.*hook/.test(h.command ?? ''));
    expect(brainEntries).toHaveLength(1);
    expect(brainEntries[0]!.command).toContain(`--db ${FAKE_DB}`);
    const unmatched = groups.find(g => g.matcher === undefined)!;
    expect(unmatched.hooks.some(h => /recense.*hook/.test(h.command))).toBe(true);
  });
});

// ── parseProviderChoice (D-04) ────────────────────────────────────────────────

describe('parseProviderChoice', () => {
  it('returns subscription for empty input (default pre-selection)', () => {
    expect(parseProviderChoice('')).toBe('subscription');
  });

  it('returns subscription for "1"', () => {
    expect(parseProviderChoice('1')).toBe('subscription');
  });

  it('returns subscription for "s"', () => {
    expect(parseProviderChoice('s')).toBe('subscription');
  });

  it('returns subscription for "S" (case-insensitive)', () => {
    expect(parseProviderChoice('S')).toBe('subscription');
  });

  it('returns subscription for "subscription"', () => {
    expect(parseProviderChoice('subscription')).toBe('subscription');
  });

  it('returns direct-api for "2"', () => {
    expect(parseProviderChoice('2')).toBe('direct-api');
  });

  it('returns direct-api for "d"', () => {
    expect(parseProviderChoice('d')).toBe('direct-api');
  });

  it('returns direct-api for "direct"', () => {
    expect(parseProviderChoice('direct')).toBe('direct-api');
  });

  it('returns direct-api for "direct-api"', () => {
    expect(parseProviderChoice('direct-api')).toBe('direct-api');
  });

  it('returns local for "3"', () => {
    expect(parseProviderChoice('3')).toBe('local');
  });

  it('returns local for "l"', () => {
    expect(parseProviderChoice('l')).toBe('local');
  });

  it('returns local for "local"', () => {
    expect(parseProviderChoice('local')).toBe('local');
  });

  it('falls back to subscription for unrecognized input', () => {
    expect(parseProviderChoice('xyz')).toBe('subscription');
  });

  it('trims surrounding whitespace', () => {
    expect(parseProviderChoice('  2  ')).toBe('direct-api');
  });
});

// ── shouldBlockOnLeak (D-07) ──────────────────────────────────────────────────

describe('shouldBlockOnLeak', () => {
  const makeSettingsFile = (content: string): string => {
    const dir = mkdtempSync(tmpdir() + '/recense-init-gate-test-');
    const file = join(dir, 'settings.json');
    writeFileSync(file, content, 'utf8');
    return file;
  };

  it('returns true when ANTHROPIC_API_KEY is set and non-empty in settings.json', () => {
    const settingsPath = makeSettingsFile(
      JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-api03-xxx' } }),
    );
    expect(shouldBlockOnLeak(settingsPath)).toBe(true);
  });

  it('returns false when ANTHROPIC_API_KEY is absent from settings.json', () => {
    const settingsPath = makeSettingsFile(
      JSON.stringify({ env: { OTHER_KEY: 'value' } }),
    );
    expect(shouldBlockOnLeak(settingsPath)).toBe(false);
  });

  it('returns false when env block is absent from settings.json', () => {
    const settingsPath = makeSettingsFile(JSON.stringify({ hooks: {} }));
    expect(shouldBlockOnLeak(settingsPath)).toBe(false);
  });

  it('returns false when ANTHROPIC_API_KEY is an empty string', () => {
    const settingsPath = makeSettingsFile(
      JSON.stringify({ env: { ANTHROPIC_API_KEY: '' } }),
    );
    expect(shouldBlockOnLeak(settingsPath)).toBe(false);
  });

  it('returns false when the settings file does not exist (T-45-02)', () => {
    expect(shouldBlockOnLeak('/tmp/nonexistent-recense-gate-test-999.json')).toBe(false);
  });

  it('returns false for malformed JSON without throwing (T-45-02)', () => {
    const settingsPath = makeSettingsFile('{not valid json');
    expect(() => shouldBlockOnLeak(settingsPath)).not.toThrow();
    expect(shouldBlockOnLeak(settingsPath)).toBe(false);
  });
});
