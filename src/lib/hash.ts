import crypto from 'node:crypto';

/**
 * Compute SHA-256 hex digest.
 * Used as value_hash for dirty-flag tracking (STORE-02).
 * Uses Node built-in crypto — no external dependency (per "Don't Hand-Roll" guide).
 */
export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/**
 * Generate a random UUID v4.
 * Used as stable node/edge/episode IDs (per "Don't Hand-Roll" guide).
 */
export function newId(): string {
  return crypto.randomUUID();
}
