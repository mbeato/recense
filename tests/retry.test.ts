/**
 * Unit tests for src/model/retry.ts
 *
 * Covers every bullet from the plan behavior block:
 *   isTransientNetworkError predicate: code/cause/message paths, AbortError, status, plain Error
 *   withRetry: success-first-try, retry-then-succeed, non-transient-immediate, exhaustion
 *
 * baseDelayMs=0 is passed to withRetry to keep tests fast (no real sleeps).
 */
import { describe, it, expect, vi } from 'vitest';
import { isTransientNetworkError, withRetry } from '../src/model/retry';

// ── isTransientNetworkError ──────────────────────────────────────────────────

describe('isTransientNetworkError', () => {
  it('returns true for ECONNRESET on err.code', () => {
    const err = Object.assign(new Error('network'), { code: 'ECONNRESET' });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('returns true for ETIMEDOUT on err.code', () => {
    const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('returns true for ECONNREFUSED on err.code', () => {
    const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('returns true for EPIPE on err.code', () => {
    const err = Object.assign(new Error('pipe'), { code: 'EPIPE' });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('returns true for transient code on err.cause.code (depth 2)', () => {
    const cause = Object.assign(new Error('inner'), { code: 'ECONNRESET' });
    const err = Object.assign(new Error('outer'), { cause });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('returns true for transient code on err.cause.cause.code (depth 3)', () => {
    const inner = Object.assign(new Error('innermost'), { code: 'ETIMEDOUT' });
    const mid = Object.assign(new Error('middle'), { cause: inner });
    const err = Object.assign(new Error('outer'), { cause: mid });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('returns true for "socket hang up" in err.message', () => {
    const err = new Error('socket hang up');
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('returns true for ECONNRESET substring in err.message (FetchError shape)', () => {
    const err = new Error('Invalid response body while trying to fetch https://api.deepseek.com — read ECONNRESET');
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('returns true for transient code substring in err.cause.message', () => {
    const cause = new Error('read ECONNRESET from socket');
    const err = Object.assign(new Error('FetchError'), { cause });
    expect(isTransientNetworkError(err)).toBe(true);
  });

  it('returns false for AbortError (real timeout budget — never retry)', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it('returns false for APIUserAbortError constructor name', () => {
    class APIUserAbortError extends Error {
      constructor() { super('user aborted'); this.name = 'APIUserAbortError'; }
    }
    const err = new APIUserAbortError();
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it('returns false for err with numeric status (HTTP APIError — 401)', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it('returns false for err with numeric status (HTTP APIError — 400)', () => {
    const err = Object.assign(new Error('Bad Request'), { status: 400 });
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it('returns false for err with numeric status (404 model-not-found)', () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it('returns false for a plain Error with no transient signal', () => {
    const err = new Error('something went wrong');
    expect(isTransientNetworkError(err)).toBe(false);
  });

  it('returns false for a non-Error value (null)', () => {
    expect(isTransientNetworkError(null)).toBe(false);
  });

  it('returns false for a non-Error value (plain string)', () => {
    expect(isTransientNetworkError('ECONNRESET')).toBe(false);
  });
});

// ── withRetry ────────────────────────────────────────────────────────────────

describe('withRetry', () => {
  it('calls fn exactly once on immediate success and returns the value', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, 2, 0);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error and succeeds on the second attempt (call count = 2)', async () => {
    const transientErr = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    const fn = vi.fn()
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValue('recovered');
    const result = await withRetry(fn, 2, 0);
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('rethrows immediately on a non-transient error without retry (call count = 1)', async () => {
    const authErr = Object.assign(new Error('Unauthorized'), { status: 401 });
    const fn = vi.fn().mockRejectedValue(authErr);
    await expect(withRetry(fn, 2, 0)).rejects.toBe(authErr);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts all retries and rethrows the last error', async () => {
    const err1 = Object.assign(new Error('reset-1'), { code: 'ECONNRESET' });
    const err2 = Object.assign(new Error('reset-2'), { code: 'ECONNRESET' });
    const err3 = Object.assign(new Error('reset-3'), { code: 'ECONNRESET' });
    const fn = vi.fn()
      .mockRejectedValueOnce(err1)
      .mockRejectedValueOnce(err2)
      .mockRejectedValueOnce(err3);
    // maxRetries=2 → at most 3 total calls (1 initial + 2 retries)
    await expect(withRetry(fn, 2, 0)).rejects.toBe(err3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('with maxRetries=0 does not retry — rethrows after exactly 1 call', async () => {
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, 0, 0)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry an AbortError (non-transient — call count = 1)', async () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, 2, 0)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
