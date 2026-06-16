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
