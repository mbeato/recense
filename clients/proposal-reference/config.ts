import { homedir } from 'os';
import { join } from 'path';

/**
 * Runtime configuration for the proposal-reference adapter.
 *
 * All values are sourced from environment variables. No engine dependency —
 * CONSUME-02 forbids importing anything from `src/`.
 */
export interface AdapterConfig {
  /** RECENSE_SERVE_URL — URL of the recense serve instance. Default: http://127.0.0.1:7701 */
  serveUrl: string;
  /** RECENSE_SERVE_TOKEN — Bearer token for recense serve (engine's auth token). */
  serveToken: string;
  /** RECENSE_REFERENCE_STORE_PATH — path to the adapter's local row store JSON file. */
  localStorePath: string;
  /**
   * Fail-closed gate (D-01): false when serveToken is missing.
   * Process-not-running is NOT the gate — an adapter without a token simply
   * never calls the network, whether or not `recense serve` is up.
   */
  enabled: boolean;
}

/**
 * Load adapter configuration from environment variables.
 *
 * Fail-closed (D-01): enabled is false when RECENSE_SERVE_TOKEN is absent. This is
 * a hard runtime guard — an adapter without a token makes no network call at all.
 */
export function loadAdapterConfig(): AdapterConfig {
  const serveUrl = process.env['RECENSE_SERVE_URL'] ?? 'http://127.0.0.1:7701';
  const serveToken = process.env['RECENSE_SERVE_TOKEN'] ?? '';
  const localStorePath =
    process.env['RECENSE_REFERENCE_STORE_PATH'] ??
    join(homedir(), '.config', 'recense', 'proposal-reference-store.json');

  const enabled = serveToken !== '';

  return { serveUrl, serveToken, localStorePath, enabled };
}
