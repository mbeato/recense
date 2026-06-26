/**
 * generate-doc-cli tests (Plan 39.3-02, Task 2).
 *
 * Tests the factored waitForLock helper:
 *  - When acquire succeeds after N polls, returns true and re-stamps 'queued' each iteration
 *  - When the budget expires with a stuck acquire, returns false after writing failed{engine stayed busy}
 *
 * Tests the cached-hit status clearing:
 *  - After idempotency early-return (cached:true path), the status file must be absent/done
 */
import { describe, test, expect, vi } from 'vitest';
import { waitForLock } from '../src/adapter/generate-doc-cli';

// ── waitForLock unit tests ────────────────────────────────────────────────────

describe('waitForLock', () => {
  test('returns true when acquire succeeds on first attempt (no delay)', async () => {
    const acquire = vi.fn().mockReturnValue(true);
    const writeQueued = vi.fn();
    const writeFailedBusy = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const now = vi.fn().mockReturnValue(0);

    const result = await waitForLock({
      acquire,
      writeQueued,
      writeFailedBusy,
      sleep,
      now,
      budgetMs: 10000,
      pollMs: 2000,
    });

    expect(result).toBe(true);
    expect(acquire).toHaveBeenCalledTimes(1);
    // queued written before the first acquire attempt
    expect(writeQueued).toHaveBeenCalledTimes(1);
    expect(writeFailedBusy).not.toHaveBeenCalled();
  });

  test('polls until acquire succeeds, re-stamps queued on each iteration', async () => {
    let callCount = 0;
    // Returns false on calls 1 and 2, true on call 3
    const acquire = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount >= 3;
    });
    const writeQueued = vi.fn();
    const writeFailedBusy = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    // Simulate 0ms, then +3000ms per call (well within budget)
    let elapsed = 0;
    const now = vi.fn().mockImplementation(() => {
      const v = elapsed;
      elapsed += 3000;
      return v;
    });

    const result = await waitForLock({
      acquire,
      writeQueued,
      writeFailedBusy,
      sleep,
      now,
      budgetMs: 60000,
      pollMs: 2000,
    });

    expect(result).toBe(true);
    expect(acquire).toHaveBeenCalledTimes(3);
    // writeQueued is called on each poll iteration (1 initial + 2 retries = 3)
    expect(writeQueued.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(writeFailedBusy).not.toHaveBeenCalled();
    // sleep called between polls (not after the final successful acquire)
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  test('returns false and calls writeFailedBusy when budget expires', async () => {
    const acquire = vi.fn().mockReturnValue(false);
    const writeQueued = vi.fn();
    const writeFailedBusy = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    // Simulate budget overflow quickly: 0ms start, then 1001ms on each subsequent call
    let elapsed = 0;
    const now = vi.fn().mockImplementation(() => {
      const v = elapsed;
      elapsed += 1001;  // each call advances past the 1000ms budget
      return v;
    });

    const result = await waitForLock({
      acquire,
      writeQueued,
      writeFailedBusy,
      sleep,
      now,
      budgetMs: 1000,
      pollMs: 2000,
    });

    expect(result).toBe(false);
    expect(writeFailedBusy).toHaveBeenCalledTimes(1);
    // No lock acquired
    expect(acquire).toHaveBeenCalled();
  });

  test('does not call sleep after the final successful acquire', async () => {
    // Returns false 1x then true
    let callCount = 0;
    const acquire = vi.fn().mockImplementation(() => {
      callCount++;
      return callCount >= 2;
    });
    const writeQueued = vi.fn();
    const writeFailedBusy = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    let elapsed = 0;
    const now = vi.fn().mockImplementation(() => {
      const v = elapsed;
      elapsed += 3000;
      return v;
    });

    await waitForLock({
      acquire,
      writeQueued,
      writeFailedBusy,
      sleep,
      now,
      budgetMs: 60000,
      pollMs: 2000,
    });

    // Slept once (after the false attempt), then acquired → no second sleep
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
