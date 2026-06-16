/**
 * Shared transient-network-error retry helper for OpenAI-compatible transports (KXE).
 *
 * Problem: The OpenAI SDK's native `maxRetries` only covers connection setup and
 * retryable HTTP statuses (429/5xx). The observed
 *   `FetchError: Invalid response body … read ECONNRESET`
 * is thrown by undici *while reading the response body* — after the SDK's retry
 * wrapper has already accepted the response — so the SDK never re-attempts it.
 *
 * This module provides:
 *   isTransientNetworkError  — predicate that identifies transient OS-level errors
 *   withRetry                — bounded retry wrapper with exponential back-off
 *
 * Scope: transient network throws only. Non-transient errors (HTTP 4xx/5xx status,
 * AbortError) pass through immediately without retry.
 *
 * No new dependencies — back-off sleeps via built-in setTimeout.
 */

/** OS-level codes that indicate a transient transport failure worth retrying. */
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EPIPE']);

/**
 * Walk a property chain on an unknown value defensively.
 * Returns the value at the path if every step is an object with that key,
 * or `undefined` if any step is missing/not-an-object.
 */
function safeProp(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const key of keys) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * Predicate: returns true iff the thrown value is a transient network error
 * that is safe to retry (ECONNRESET / ETIMEDOUT / ECONNREFUSED / EPIPE, or
 * 'socket hang up' variants thrown by undici/node when the response body read fails).
 *
 * Returns false for:
 *   - AbortError / APIUserAbortError (real timeout budget — caller must respect it)
 *   - Errors with a numeric `status` (HTTP APIErrors — 4xx / 5xx; the SDK already
 *     handles status-based retries; auth/validation/model-not-found must fail fast)
 *   - Any other error with no transient signal
 *   - Non-Error values (strings, null, etc.)
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;

  // Fast-reject: AbortError / APIUserAbortError — never retry real timeout budget.
  const name = safeProp(err, 'name');
  const ctorName = safeProp(err, 'constructor', 'name');
  if (name === 'AbortError' || ctorName === 'APIUserAbortError') return false;

  // Fast-reject: HTTP APIErrors exposed by the OpenAI SDK — always have a numeric status.
  const status = safeProp(err, 'status');
  if (typeof status === 'number') return false;

  // Check OS error codes on err, err.cause, err.cause.cause (max depth 3).
  const code0 = safeProp(err, 'code');
  if (typeof code0 === 'string' && TRANSIENT_CODES.has(code0)) return true;

  const cause = safeProp(err, 'cause');
  const code1 = safeProp(cause, 'code');
  if (typeof code1 === 'string' && TRANSIENT_CODES.has(code1)) return true;

  const cause2 = safeProp(cause, 'cause');
  const code2 = safeProp(cause2, 'code');
  if (typeof code2 === 'string' && TRANSIENT_CODES.has(code2)) return true;

  // Check message substrings: covers FetchError "Invalid response body … read ECONNRESET"
  // and Node's "socket hang up" thrown directly.
  const msg = safeProp(err, 'message');
  const causeMsg = safeProp(cause, 'message');
  const combined = [msg, causeMsg]
    .filter((m): m is string => typeof m === 'string')
    .join(' ');

  if (combined.includes('socket hang up')) return true;
  for (const code of TRANSIENT_CODES) {
    if (combined.includes(code)) return true;
  }

  return false;
}

/** Maximum back-off cap in milliseconds. */
const MAX_BACKOFF_MS = 4_000;

/**
 * Retry wrapper with exponential back-off for transient network errors.
 *
 * Calls `fn()`. On success returns its value immediately (fn called once).
 * On a transient error (isTransientNetworkError returns true), waits
 * `baseDelayMs * 2^attempt` (capped at MAX_BACKOFF_MS) and retries.
 * `maxRetries` is the number of *additional* attempts after the first call,
 * so `maxRetries=2` ⇒ at most 3 total calls (original + 2 retries).
 * If every attempt throws transient, rethrows the last error.
 * On a non-transient error, rethrows immediately (fn called exactly once).
 *
 * @param fn           - Async function to execute.
 * @param maxRetries   - Maximum number of retry attempts (≥ 0).
 * @param baseDelayMs  - Base back-off delay in milliseconds (default 250).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelayMs = 250
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientNetworkError(err)) {
        throw err;
      }
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * Math.pow(2, attempt), MAX_BACKOFF_MS);
        await new Promise<void>(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
