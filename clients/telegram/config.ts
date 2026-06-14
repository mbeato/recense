import { homedir } from 'os';
import { join } from 'path';

/**
 * Runtime configuration for the Telegram reference client.
 *
 * All values are sourced from environment variables (loaded from a client-owned
 * chmod-600 env file by the launchd wrapper). No EngineConfig dependency.
 */
export interface ClientConfig {
  /** TELEGRAM_BOT_TOKEN — the bot's API token. */
  telegramToken: string;
  /** BRAIN_SERVE_URL — URL of the recense serve instance. Default: http://127.0.0.1:7701 */
  serveUrl: string;
  /** BRAIN_SERVE_TOKEN — Bearer token for recense serve (engine's auth token, copied into client env). */
  serveToken: string;
  /** BRAIN_CLIENT_ALLOWLIST — comma-separated numeric Telegram user IDs allowed to query. */
  allowlist: string[];
  /** BRAIN_CLIENT_POLL_MS — poll interval in ms. Default: 2000, floor: 500. */
  pollIntervalMs: number;
  /** BRAIN_CLIENT_STATE_PATH — path to the cursor state JSON file. */
  statePath: string;
  /**
   * Fail-closed gate (D-10): false when telegramToken is missing, serveToken is missing,
   * or allowlist is empty. Process-not-running is NOT the gate.
   */
  enabled: boolean;
}

/**
 * Load client configuration from environment variables.
 *
 * Fail-closed (D-10 / T-13-02): enabled is false when TELEGRAM_BOT_TOKEN or
 * BRAIN_SERVE_TOKEN is missing, or when the allowlist is empty. This is a hard
 * runtime guard — an instance with an empty allowlist answers no one.
 */
export function loadClientConfig(): ClientConfig {
  const telegramToken = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
  const serveUrl = process.env['BRAIN_SERVE_URL'] ?? 'http://127.0.0.1:7701';
  const serveToken = process.env['BRAIN_SERVE_TOKEN'] ?? '';
  const rawAllowlist = process.env['BRAIN_CLIENT_ALLOWLIST'] ?? '';
  const allowlist = rawAllowlist.split(',').map(s => s.trim()).filter(Boolean);
  const pollIntervalMs = Math.max(
    parseInt(process.env['BRAIN_CLIENT_POLL_MS'] ?? '2000', 10) || 2000,
    500,
  );
  const statePath =
    process.env['BRAIN_CLIENT_STATE_PATH'] ??
    join(homedir(), '.config', 'recense', 'telegram-client-state.json');

  // Fail-closed: disable when any required field is absent (D-10)
  const enabled = telegramToken !== '' && serveToken !== '' && allowlist.length > 0;

  return { telegramToken, serveUrl, serveToken, allowlist, pollIntervalMs, statePath, enabled };
}
