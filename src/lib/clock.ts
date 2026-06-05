/**
 * Injectable clock seam (D-12).
 *
 * This is the ONLY file in the codebase that calls Date.now().
 * All components receive a Clock instance via constructor injection.
 * Tests use FakeClock to advance time deterministically (STR-03).
 */

export interface Clock {
  /** Returns current time in milliseconds (equivalent to Date.now()). */
  nowMs(): number;
}

/**
 * Production clock — the sole site that calls Date.now().
 * grep -rn 'Date\.now\(' src/ should return only this file.
 */
export const realClock: Clock = {
  nowMs: () => Date.now(),
};

/**
 * Advanceable test clock for deterministic time-based tests (D-12, STR-03).
 * Used by the STR-03 invariant test to fast-forward a simulated month.
 */
export class FakeClock implements Clock {
  private _now: number;

  constructor(initialMs: number = 0) {
    this._now = initialMs;
  }

  nowMs(): number {
    return this._now;
  }

  /** Advance by `days` calendar days (days × 86_400_000 ms). */
  advanceDays(days: number): void {
    this._now += days * 86_400_000;
  }

  /** Advance by an arbitrary number of milliseconds. */
  advanceMs(ms: number): void {
    this._now += ms;
  }

  /** Jump to an absolute timestamp. */
  setNow(ms: number): void {
    this._now = ms;
  }
}
