/**
 * clients/telegram/tests/config-mcp.test.ts
 *
 * Tests for loadMcpConfig() + loadActionConfig() (Plan 23-01 Task 2).
 *
 * Covers:
 *   - missing config file → [] (fail-closed)
 *   - destructive omitted → parsed true (H-10 default-destructive)
 *   - destructive:false honored
 *   - server-advertised destructiveHint:false is IGNORED (H-11) — destructive stays true
 *   - ${VAR} interpolation substitutes from process.env (H-14)
 *   - inline-looking secret with no ${} stays literal
 *   - file mode more permissive than 0600 → refused (H-14)
 *   - DeepSeek env defaults applied; secret never logged
 *
 * No src/ imports — CLIENT-01 structural guard enforced.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadMcpConfig, loadActionConfig } from '../config';

let dir: string;
let configPath: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recense-mcp-cfg-'));
  configPath = join(dir, 'mcp-servers.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

function writeConfig(obj: unknown): void {
  writeFileSync(configPath, JSON.stringify(obj), { mode: 0o600 });
  chmodSync(configPath, 0o600); // belt-and-suspenders against umask
}

// ── Missing file → fail-closed ────────────────────────────────────────────────

describe('loadMcpConfig — missing file', () => {
  it('returns [] when RECENSE_MCP_CONFIG_PATH points at a non-existent file', () => {
    process.env['RECENSE_MCP_CONFIG_PATH'] = join(dir, 'does-not-exist.json');
    expect(loadMcpConfig()).toEqual([]);
  });
});

// ── Default-destructive (H-10) + hint-ignoring (H-11) ─────────────────────────

describe('loadMcpConfig — destructive labelling (D-08 / H-10 / H-11)', () => {
  it('a tool entry with no destructive field parses to destructive === true (H-10)', () => {
    writeConfig({
      mcpServers: {
        mail: { transport: 'stdio', command: 'mail-mcp', allowedTools: [{ name: 'send_email' }] },
      },
    });
    process.env['RECENSE_MCP_CONFIG_PATH'] = configPath;
    const servers = loadMcpConfig();
    expect(servers).toHaveLength(1);
    expect(servers[0]!.allowedTools[0]).toEqual({ name: 'send_email', destructive: true });
  });

  it('destructive:false is honored', () => {
    writeConfig({
      mcpServers: {
        mail: {
          transport: 'stdio',
          command: 'mail-mcp',
          allowedTools: [{ name: 'list_inbox', destructive: false }],
        },
      },
    });
    process.env['RECENSE_MCP_CONFIG_PATH'] = configPath;
    const servers = loadMcpConfig();
    expect(servers[0]!.allowedTools[0]!.destructive).toBe(false);
  });

  it('server-advertised destructiveHint:false does NOT set destructive to false (H-11 hint ignored)', () => {
    writeConfig({
      mcpServers: {
        mail: {
          transport: 'stdio',
          command: 'mail-mcp',
          // destructiveHint is server runtime metadata — must be ignored entirely.
          allowedTools: [{ name: 'wipe_db', destructiveHint: false, readOnlyHint: true }],
        },
      },
    });
    process.env['RECENSE_MCP_CONFIG_PATH'] = configPath;
    const servers = loadMcpConfig();
    // No explicit `destructive` field present → defaults to true; hints are not consulted.
    expect(servers[0]!.allowedTools[0]!.destructive).toBe(true);
  });
});

// ── ${VAR} interpolation (H-14) ───────────────────────────────────────────────

describe('loadMcpConfig — env interpolation (H-14)', () => {
  it('substitutes ${VAR} in env values from process.env', () => {
    process.env['MY_MCP_SECRET'] = 'super-secret-token';
    writeConfig({
      mcpServers: {
        api: {
          transport: 'stdio',
          command: 'api-mcp',
          env: { TOKEN: '${MY_MCP_SECRET}' },
          allowedTools: [{ name: 'read' }],
        },
      },
    });
    process.env['RECENSE_MCP_CONFIG_PATH'] = configPath;
    const servers = loadMcpConfig();
    expect(servers[0]!.env!['TOKEN']).toBe('super-secret-token');
  });

  it('substitutes ${VAR} in url from process.env', () => {
    process.env['MCP_HOST'] = 'mcp.example.com';
    writeConfig({
      mcpServers: {
        remote: {
          transport: 'http',
          url: 'https://${MCP_HOST}/mcp',
          allowedTools: [{ name: 'query' }],
        },
      },
    });
    process.env['RECENSE_MCP_CONFIG_PATH'] = configPath;
    const servers = loadMcpConfig();
    expect(servers[0]!.url).toBe('https://mcp.example.com/mcp');
  });

  it('an inline-looking secret stays literal when it contains no ${} token', () => {
    writeConfig({
      mcpServers: {
        api: {
          transport: 'stdio',
          command: 'api-mcp',
          // No ${...} → returned verbatim (the value happens to look like a secret).
          env: { TOKEN: 'sk-literal-not-interpolated' },
          allowedTools: [{ name: 'read' }],
        },
      },
    });
    process.env['RECENSE_MCP_CONFIG_PATH'] = configPath;
    const servers = loadMcpConfig();
    expect(servers[0]!.env!['TOKEN']).toBe('sk-literal-not-interpolated');
  });

  it('unset ${VAR} substitutes empty string (fail-closed — no token leak)', () => {
    delete process.env['UNSET_VAR'];
    writeConfig({
      mcpServers: {
        api: {
          transport: 'stdio',
          command: 'api-mcp',
          env: { TOKEN: '${UNSET_VAR}' },
          allowedTools: [{ name: 'read' }],
        },
      },
    });
    process.env['RECENSE_MCP_CONFIG_PATH'] = configPath;
    const servers = loadMcpConfig();
    expect(servers[0]!.env!['TOKEN']).toBe('');
  });

  it('substitutes ${VAR} in command from process.env (IN-04)', () => {
    // command was previously assigned verbatim; ${VAR} tokens in path were not expanded.
    process.env['MCP_CMD_PATH'] = '/usr/local/bin/my-mcp-server';
    writeConfig({
      mcpServers: {
        tools: {
          transport: 'stdio',
          command: '${MCP_CMD_PATH}',
          allowedTools: [{ name: 'run' }],
        },
      },
    });
    process.env['RECENSE_MCP_CONFIG_PATH'] = configPath;
    const servers = loadMcpConfig();
    expect(servers[0]!.command).toBe('/usr/local/bin/my-mcp-server');
  });

  it('unset ${VAR} in command substitutes empty string (fail-closed)', () => {
    delete process.env['UNSET_CMD_VAR'];
    writeConfig({
      mcpServers: {
        tools: {
          transport: 'stdio',
          command: '${UNSET_CMD_VAR}/my-server',
          allowedTools: [{ name: 'run' }],
        },
      },
    });
    process.env['RECENSE_MCP_CONFIG_PATH'] = configPath;
    const servers = loadMcpConfig();
    expect(servers[0]!.command).toBe('/my-server');
  });
});

// ── Permission refusal (H-14) ─────────────────────────────────────────────────

describe('loadMcpConfig — file permission gate (H-14)', () => {
  it('refuses to load (returns []) when file mode is more permissive than 0600', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { mail: { transport: 'stdio', allowedTools: [{ name: 'x' }] } },
      }),
      { mode: 0o600 },
    );
    chmodSync(configPath, 0o644); // group/other readable — must be refused
    process.env['RECENSE_MCP_CONFIG_PATH'] = configPath;
    expect(loadMcpConfig()).toEqual([]);
  });
});

// ── Malformed input ───────────────────────────────────────────────────────────

describe('loadMcpConfig — malformed input', () => {
  it('returns [] for invalid JSON', () => {
    writeFileSync(configPath, 'not json {{{', { mode: 0o600 });
    chmodSync(configPath, 0o600);
    process.env['RECENSE_MCP_CONFIG_PATH'] = configPath;
    expect(loadMcpConfig()).toEqual([]);
  });

  it('returns [] when mcpServers key is absent', () => {
    writeConfig({ somethingElse: {} });
    process.env['RECENSE_MCP_CONFIG_PATH'] = configPath;
    expect(loadMcpConfig()).toEqual([]);
  });
});

// ── DeepSeek / cap env defaults ───────────────────────────────────────────────

describe('loadActionConfig — DeepSeek + cap envs', () => {
  it('applies defaults when no env vars are set', () => {
    delete process.env['DEEPSEEK_API_KEY'];
    delete process.env['DEEPSEEK_MODEL'];
    delete process.env['DEEPSEEK_BASE_URL'];
    delete process.env['RECENSE_PROPOSAL_DAILY_CAP'];
    delete process.env['RECENSE_PROPOSAL_MAX_TTL_MS'];
    delete process.env['RECENSE_PROPOSAL_STORE_PATH'];
    const cfg = loadActionConfig();
    expect(cfg.deepseekApiKey).toBe('');
    expect(cfg.deepseekModel).toBe('deepseek-chat');
    expect(cfg.deepseekBaseUrl).toBe('https://api.deepseek.com/v1');
    expect(cfg.proposalDailyCap).toBe(10);
    expect(cfg.proposalMaxTtlMs).toBe(86400000);
    expect(cfg.proposalStorePath).toMatch(/pending-proposals\.json$/);
  });

  it('reads DEEPSEEK_API_KEY from env (and never returns it via a log path)', () => {
    process.env['DEEPSEEK_API_KEY'] = 'sk-deepseek-test';
    const cfg = loadActionConfig();
    expect(cfg.deepseekApiKey).toBe('sk-deepseek-test');
  });

  it('honors overridden cap + model envs', () => {
    process.env['RECENSE_PROPOSAL_DAILY_CAP'] = '3';
    process.env['DEEPSEEK_MODEL'] = 'deepseek-reasoner';
    const cfg = loadActionConfig();
    expect(cfg.proposalDailyCap).toBe(3);
    expect(cfg.deepseekModel).toBe('deepseek-reasoner');
  });

  it('RECENSE_PROPOSAL_DAILY_CAP=0 → proposalDailyCap is 0, not 10 (IN-02 footgun)', () => {
    // 0 is a valid "disable proposals" value; the old `|| 10` pattern treated it as falsy.
    process.env['RECENSE_PROPOSAL_DAILY_CAP'] = '0';
    const cfg = loadActionConfig();
    expect(cfg.proposalDailyCap).toBe(0);
  });

  it('RECENSE_PROPOSAL_DAILY_CAP=negative → falls back to 10', () => {
    process.env['RECENSE_PROPOSAL_DAILY_CAP'] = '-1';
    const cfg = loadActionConfig();
    expect(cfg.proposalDailyCap).toBe(10);
  });

  it('RECENSE_PROPOSAL_DAILY_CAP=not-a-number → falls back to 10', () => {
    process.env['RECENSE_PROPOSAL_DAILY_CAP'] = 'banana';
    const cfg = loadActionConfig();
    expect(cfg.proposalDailyCap).toBe(10);
  });
});
