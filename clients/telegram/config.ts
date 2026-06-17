import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { AllowlistEntry, McpServerConfig } from './types';

/**
 * Runtime configuration for the Telegram reference client.
 *
 * All values are sourced from environment variables (loaded from a client-owned
 * chmod-600 env file by the launchd wrapper). No EngineConfig dependency.
 */
export interface ClientConfig {
  /** TELEGRAM_BOT_TOKEN — the bot's API token. */
  telegramToken: string;
  /** RECENSE_SERVE_URL — URL of the recense serve instance. Default: http://127.0.0.1:7701 */
  serveUrl: string;
  /** RECENSE_SERVE_TOKEN — Bearer token for recense serve (engine's auth token, copied into client env). */
  serveToken: string;
  /** RECENSE_CLIENT_ALLOWLIST — comma-separated numeric Telegram user IDs allowed to query. */
  allowlist: string[];
  /** RECENSE_CLIENT_POLL_MS — poll interval in ms. Default: 2000, floor: 500. */
  pollIntervalMs: number;
  /** RECENSE_CLIENT_STATE_PATH — path to the cursor state JSON file. */
  statePath: string;
  /**
   * Fail-closed gate (D-10): false when telegramToken is missing, serveToken is missing,
   * or allowlist is empty. Process-not-running is NOT the gate.
   */
  enabled: boolean;
  /**
   * RECENSE_PROACTIVE_ENABLED — default false (D-11).
   * Only the literal string "true" (case-insensitive) enables the push timer and digest.
   * Orthogonal to `enabled`: reactive Q&A keeps working when proactiveEnabled is false.
   */
  proactiveEnabled: boolean;
  /** RECENSE_PUSH_POLL_MS — push poll interval in ms. Default: 120000 (2 min), floor: 10000. */
  pushPollMs: number;
  /** RECENSE_QUIET_HOURS_START — local hour (0–23) when quiet hours begin. Default: 22. */
  quietHoursStart: number;
  /** RECENSE_QUIET_HOURS_END — local hour (0–23) when quiet hours end. Default: 7. */
  quietHoursEnd: number;
  /** RECENSE_DIGEST_HOUR — local hour at which the P1 daily digest fires. Default: 8. */
  digestHour: number;
  /** RECENSE_SNOOZE_DURATION_MS — snooze offset in ms. Default: 86400000 (24h = D-09 fixed +1 day). */
  snoozeDurationMs: number;
}

/**
 * Load client configuration from environment variables.
 *
 * Fail-closed (D-10 / T-13-02): enabled is false when TELEGRAM_BOT_TOKEN or
 * RECENSE_SERVE_TOKEN is missing, or when the allowlist is empty. This is a hard
 * runtime guard — an instance with an empty allowlist answers no one.
 */
export function loadClientConfig(): ClientConfig {
  const telegramToken = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
  const serveUrl = process.env['RECENSE_SERVE_URL'] ?? 'http://127.0.0.1:7701';
  const serveToken = process.env['RECENSE_SERVE_TOKEN'] ?? '';
  const rawAllowlist = process.env['RECENSE_CLIENT_ALLOWLIST'] ?? '';
  const allowlist = rawAllowlist.split(',').map(s => s.trim()).filter(Boolean);
  const pollIntervalMs = Math.max(
    parseInt(process.env['RECENSE_CLIENT_POLL_MS'] ?? '2000', 10) || 2000,
    500,
  );
  const statePath =
    process.env['RECENSE_CLIENT_STATE_PATH'] ??
    join(homedir(), '.config', 'recense', 'telegram-client-state.json');

  // Fail-closed: disable when any required field is absent (D-10)
  const enabled = telegramToken !== '' && serveToken !== '' && allowlist.length > 0;

  // D-11: default-OFF proactive gate — only literal "true" (case-insensitive) enables push
  const proactiveEnabled = (process.env['RECENSE_PROACTIVE_ENABLED'] ?? '').toLowerCase() === 'true';
  const pushPollMs = Math.max(
    parseInt(process.env['RECENSE_PUSH_POLL_MS'] ?? '120000', 10) || 120000,
    10_000,  // floor: 10s minimum to prevent accidental flooding
  );
  const quietHoursStart = parseInt(process.env['RECENSE_QUIET_HOURS_START'] ?? '22', 10);
  const quietHoursEnd   = parseInt(process.env['RECENSE_QUIET_HOURS_END']   ?? '7',  10);
  const digestHour      = parseInt(process.env['RECENSE_DIGEST_HOUR']       ?? '8',  10);
  const snoozeDurationMs = parseInt(process.env['RECENSE_SNOOZE_DURATION_MS'] ?? '86400000', 10) || 86400000;

  return {
    telegramToken, serveUrl, serveToken, allowlist, pollIntervalMs, statePath, enabled,
    proactiveEnabled, pushPollMs, quietHoursStart, quietHoursEnd, digestHour, snoozeDurationMs,
  };
}

// ---------------------------------------------------------------------------
// Approval-gated MCP execution config (Phase 23)
// ---------------------------------------------------------------------------

/**
 * Runtime config for the proposal/approval/execution path (Phase 23).
 *
 * The DeepSeek key is loaded here but MUST NEVER be passed to any log() call (H-13 / T-13-05).
 * This struct is intentionally separate from ClientConfig so the reactive Q&A path keeps
 * working with no DeepSeek dependency.
 */
export interface ActionConfig {
  /** DEEPSEEK_API_KEY — bearer key for the proposal LLM. Default ''. NEVER logged. */
  deepseekApiKey: string;
  /** DEEPSEEK_MODEL — model id. Default 'deepseek-chat'. */
  deepseekModel: string;
  /** DEEPSEEK_BASE_URL — OpenAI-compat base URL. Default 'https://api.deepseek.com/v1'. */
  deepseekBaseUrl: string;
  /** RECENSE_PROPOSAL_DAILY_CAP — max proposals generated per day (D-01 / H-15). Default 10. */
  proposalDailyCap: number;
  /** RECENSE_PROPOSAL_MAX_TTL_MS — absolute proposal TTL in ms (D-07). Default 86400000 (24h). */
  proposalMaxTtlMs: number;
  /** RECENSE_PROPOSAL_STORE_PATH — path to the pending-proposals JSON file (0600). */
  proposalStorePath: string;
}

/**
 * Load the approval/execution config from environment variables.
 *
 * The DeepSeek API key is read here and intentionally never passed to log() anywhere
 * in the codebase (H-13 / T-13-05).
 */
export function loadActionConfig(): ActionConfig {
  const deepseekApiKey = process.env['DEEPSEEK_API_KEY'] ?? '';
  const deepseekModel = process.env['DEEPSEEK_MODEL'] ?? 'deepseek-chat';
  const deepseekBaseUrl = process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com/v1';
  // Use Number.isFinite + n >= 0 so RECENSE_PROPOSAL_DAILY_CAP=0 (disable proposals) is
  // honored rather than silently becoming 10 (the || 10 footgun — IN-02).
  const _capRaw = parseInt(process.env['RECENSE_PROPOSAL_DAILY_CAP'] ?? '', 10);
  const proposalDailyCap = Number.isFinite(_capRaw) && _capRaw >= 0 ? _capRaw : 10;
  const proposalMaxTtlMs =
    parseInt(process.env['RECENSE_PROPOSAL_MAX_TTL_MS'] ?? '86400000', 10) || 86400000;
  const proposalStorePath =
    process.env['RECENSE_PROPOSAL_STORE_PATH'] ??
    join(homedir(), '.config', 'recense', 'pending-proposals.json');

  return {
    deepseekApiKey, deepseekModel, deepseekBaseUrl,
    proposalDailyCap, proposalMaxTtlMs, proposalStorePath,
  };
}

/**
 * Interpolate `${VAR}` tokens in a config string value from process.env (H-14).
 *
 * Secrets must live in environment variables, never inline as literals in mcp-servers.json.
 * A value containing no `${...}` token is returned verbatim (an inline literal stays literal).
 * An unresolved `${VAR}` (env var unset) substitutes the empty string — fail-closed: a missing
 * secret yields '' rather than leaking the literal token to the MCP server.
 */
function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, varName: string) =>
    process.env[varName] ?? '',
  );
}

/**
 * Parse one allowlist entry. destructive defaults to true when the field is absent (H-10 / D-08).
 * Server-advertised destructiveHint / readOnlyHint are NEVER consulted — only the explicit
 * `destructive` field in the user-owned config file (D-08).
 */
function parseAllowlistEntry(raw: unknown): AllowlistEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['name'] !== 'string' || obj['name'] === '') return null;
  // H-10: unlabeled tools default to destructive. Only an explicit boolean `false` opts out.
  // destructiveHint / readOnlyHint are server runtime metadata and are deliberately ignored.
  const destructive = typeof obj['destructive'] === 'boolean' ? obj['destructive'] : true;
  return { name: obj['name'], destructive };
}

/**
 * Load the MCP server registry from the mcp-servers.json config file (D-05).
 *
 * Path: RECENSE_MCP_CONFIG_PATH (default ~/.config/recense/mcp-servers.json).
 *
 * Fail-closed behavior:
 *   - Missing file → [] (no servers configured = nothing proposable).
 *   - File mode more permissive than 0600 → refuse to load, return [] (H-14).
 *   - Malformed JSON or unexpected shape → [].
 *
 * Format (mcp.json-style keyed object):
 *   {
 *     "mcpServers": {
 *       "<name>": {
 *         "transport": "stdio" | "http",
 *         "command"?: string, "args"?: string[],
 *         "url"?: string,
 *         "env"?: { "KEY": "${ENV_VAR}" },
 *         "allowedTools": [{ "name": string, "destructive"?: boolean }]
 *       }
 *     }
 *   }
 *
 * Secrets in `env` values and `url` are `${ENV_VAR}`-interpolated from process.env (H-14).
 * Server-advertised destructiveHint / readOnlyHint are never read from this file (D-08 / H-11).
 */
export function loadMcpConfig(): McpServerConfig[] {
  const configPath =
    process.env['RECENSE_MCP_CONFIG_PATH'] ??
    join(homedir(), '.config', 'recense', 'mcp-servers.json');

  // Missing file → fail-closed: no servers configured.
  if (!existsSync(configPath)) return [];

  // H-14: refuse a file readable/writable by group or others (more permissive than 0600).
  try {
    const mode = statSync(configPath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      // Never log the file contents — only the permission warning.
      console.warn(
        `[recense] refusing to load ${configPath}: file mode ${mode.toString(8)} is more permissive than 0600 (H-14)`,
      );
      return [];
    }
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return [];
  }

  if (typeof parsed !== 'object' || parsed === null) return [];
  const mcpServers = (parsed as Record<string, unknown>)['mcpServers'];
  if (typeof mcpServers !== 'object' || mcpServers === null) return [];

  const result: McpServerConfig[] = [];
  for (const [name, rawServer] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (typeof rawServer !== 'object' || rawServer === null) continue;
    const s = rawServer as Record<string, unknown>;

    const transport = s['transport'] === 'http' ? 'http' : 'stdio';

    const allowedTools: AllowlistEntry[] = Array.isArray(s['allowedTools'])
      ? (s['allowedTools'] as unknown[])
          .map(parseAllowlistEntry)
          .filter((e): e is AllowlistEntry => e !== null)
      : [];

    const server: McpServerConfig = { name, transport, allowedTools };

    if (typeof s['command'] === 'string') server.command = s['command'];
    if (Array.isArray(s['args'])) {
      server.args = (s['args'] as unknown[])
        .filter((a): a is string => typeof a === 'string')
        .map(interpolateEnv);
    }
    if (typeof s['url'] === 'string') server.url = interpolateEnv(s['url']);
    if (typeof s['env'] === 'object' && s['env'] !== null) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(s['env'] as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = interpolateEnv(v);
      }
      server.env = env;
    }

    result.push(server);
  }

  return result;
}
