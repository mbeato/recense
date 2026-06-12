/**
 * Unit tests for the pure PE-gated routing functions (spec §4, D-15/D-16/D-19/D-20).
 *
 * All functions under test are pure — no DB, no network, no clock side-effects.
 * This file proves the routing bands and the D-19/D-20 correctness guards in isolation.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { PendingContradiction } from '../src/lib/types';
import {
  routeContradiction,
  isOscillation,
  countDistinctProvenance,
} from '../src/consolidation/update-decision';

// peReconcileBandLow=0.8, peReconcileBandHigh=2.0, peAppendNewMinResistance=0.3 (DEFAULT_CONFIG)
const config = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

// ---------------------------------------------------------------------------
// routeContradiction
// ---------------------------------------------------------------------------

describe('routeContradiction', () => {
  it('low ratio → hold (weak challenge vs strong fact)', () => {
    // resistance=0.5, magnitude=0.3: ratio = 0.6 < 0.8 → hold
    expect(routeContradiction(0.3, 0.5, config)).toBe('hold');
  });

  it('mid ratio → reconcile (tombstone old + set new current)', () => {
    // resistance=0.5, magnitude=0.5: ratio = 1.0, between 0.8 and 2.0 → reconcile
    expect(routeContradiction(0.5, 0.5, config)).toBe('reconcile');
  });

  it('high ratio, well-established node → append-new (extreme / categorical contradiction)', () => {
    // resistance=0.5 >= peAppendNewMinResistance(0.3), magnitude=1.0: ratio=2.0 → append-new
    expect(routeContradiction(1.0, 0.5, config)).toBe('append-new');
  });

  it('high ratio, fresh node → reconcile (peAppendNewMinResistance guard blocks append-new)', () => {
    // resistance=0.1 < peAppendNewMinResistance(0.3): append-new blocked → reconcile
    // This is the D-16 fix: fresh node (s=0.1, c=0.5, resistance=0.05) never reaches append-new
    expect(routeContradiction(0.5, 0.1, config)).toBe('reconcile');
  });

  it('boundary: ratio exactly at peReconcileBandLow (0.8) → reconcile (not hold)', () => {
    // ratio = 0.8/1.0 = 0.8. Check is `ratio < 0.8` → false → falls to reconcile band
    expect(routeContradiction(0.8, 1.0, config)).toBe('reconcile');
  });

  it('boundary: ratio exactly at peReconcileBandHigh (2.0), established node → append-new', () => {
    // ratio = 2.0/1.0 = 2.0. resistance=1.0 >= 0.3 → append-new
    expect(routeContradiction(2.0, 1.0, config)).toBe('append-new');
  });

  it('boundary: ratio exactly at peReconcileBandHigh (2.0), fresh node → reconcile', () => {
    // ratio = 2.0*0.1 / 0.1 = 2.0. resistance=0.1 < 0.3 → reconcile (guard fires)
    expect(routeContradiction(0.2, 0.1, config)).toBe('reconcile');
  });

  it('resistance=0 does not divide-by-zero (EPS floor → huge ratio → reconcile via guard)', () => {
    // resistance=0 → denominator = EPS ≈ 1e-9; ratio ≈ 5e8 >> 2.0 but resistance=0 < 0.3 → reconcile
    const action = routeContradiction(0.5, 0, config);
    expect(action).toBe('reconcile'); // defined action, no NaN/Infinity crash; guard prevents append-new
  });

  it('peAppendNewMinResistance boundary: resistance exactly at threshold → append-new allowed', () => {
    // resistance=0.3 exactly matches peAppendNewMinResistance; ratio=3.0 >= 2.0 → append-new
    expect(routeContradiction(0.9, 0.3, config)).toBe('append-new');
  });

  it('peAppendNewMinResistance boundary: resistance just below threshold → reconcile', () => {
    // resistance=0.299 < 0.3; ratio=3.0 >= 2.0 but guard blocks → reconcile
    expect(routeContradiction(0.9, 0.299, config)).toBe('reconcile');
  });

  it('D-16: lazy decay erodes resistance — borderline magnitude flips hold → reconcile', () => {
    // Demonstrates: a magnitude that HOLDs against fresh resistance reconciles once the
    // node has decayed. This is the "lazy decay erodes resistance" property (D-16).
    //
    // Node: s=0.5, c=0.9 → fresh resistance = 0.5 * 0.9 = 0.45
    // Magnitude = 0.1: ratio = 0.1/0.45 ≈ 0.22 < 0.8 → HOLD

    const s = 0.5;
    const c = 0.9;
    const lambda = config.lambda; // 0.05 day^-1 (DEFAULT_CONFIG)
    const freshResistance = s * c; // 0.45

    // After 30 days: effective_s = 0.5 * exp(-0.05 * 30) = 0.5 * exp(-1.5) ≈ 0.112
    const deltaDays = 30;
    const decayedS = s * Math.exp(-lambda * deltaDays); // ≈ 0.112
    const decayedResistance = decayedS * c; // ≈ 0.101

    const magnitude = 0.1;

    // Against fresh resistance: 0.1/0.45 ≈ 0.22 < 0.8 → hold
    expect(routeContradiction(magnitude, freshResistance, config)).toBe('hold');

    // Against decayed resistance: 0.1/0.101 ≈ 0.99, between 0.8 and 2.0 → reconcile
    expect(routeContradiction(magnitude, decayedResistance, config)).toBe('reconcile');
  });
});

// ---------------------------------------------------------------------------
// isOscillation
// ---------------------------------------------------------------------------

describe('isOscillation', () => {
  it('exact normalized match → true (flip-back detected)', () => {
    expect(isOscillation('engineer', 'engineer')).toBe(true);
  });

  it('different value → false (no flip-back)', () => {
    expect(isOscillation('engineer', 'manager')).toBe(false);
  });

  it('null prevValue → false (first-write node has no oscillation history)', () => {
    expect(isOscillation('engineer', null)).toBe(false);
  });

  it('case-different but normalizes equal → true', () => {
    expect(isOscillation('ENGINEER', 'engineer')).toBe(true);
  });

  it('whitespace-different but normalizes equal → true', () => {
    expect(isOscillation('  engineer  ', 'engineer')).toBe(true);
    expect(isOscillation('foo  bar', '  Foo Bar  ')).toBe(true);
  });

  it('empty prevValue → false (empty string normalizes to empty, but non-null empty still compares)', () => {
    // A truly empty prev_value is unusual but should compare correctly
    expect(isOscillation('', '')).toBe(true);   // both normalize to ''
    expect(isOscillation('value', '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// countDistinctProvenance
// ---------------------------------------------------------------------------

describe('countDistinctProvenance', () => {
  it('three entries across two session_ids → 2 (counts distinct sessions)', () => {
    const entries: PendingContradiction[] = [
      { episode_id: 'e1', session_id: 'session-a', origin: 'observed' },
      { episode_id: 'e2', session_id: 'session-a', origin: 'observed' }, // duplicate session
      { episode_id: 'e3', session_id: 'session-b', origin: 'observed' },
    ];
    expect(countDistinctProvenance(entries)).toBe(2);
  });

  it('origin=inferred entry is excluded — cannot contribute to destabilization count', () => {
    const entries: PendingContradiction[] = [
      { episode_id: 'e1', session_id: 'session-a', origin: 'inferred' }, // excluded
      { episode_id: 'e2', session_id: 'session-b', origin: 'observed' },
    ];
    // session-a is excluded (inferred), count = 1 (only session-b)
    expect(countDistinctProvenance(entries)).toBe(1);
  });

  it('repeated same session_id counts once (chatty session cannot inflate count to N)', () => {
    const entries: PendingContradiction[] = [
      { episode_id: 'e1', session_id: 'session-a', origin: 'observed' },
      { episode_id: 'e2', session_id: 'session-a', origin: 'observed' },
      { episode_id: 'e3', session_id: 'session-a', origin: 'observed' },
    ];
    expect(countDistinctProvenance(entries)).toBe(1);
  });

  it('empty entries → 0', () => {
    expect(countDistinctProvenance([])).toBe(0);
  });

  it('all inferred entries → 0 (no eligible sessions)', () => {
    const entries: PendingContradiction[] = [
      { episode_id: 'e1', session_id: 'session-a', origin: 'inferred' },
      { episode_id: 'e2', session_id: 'session-b', origin: 'inferred' },
    ];
    expect(countDistinctProvenance(entries)).toBe(0);
  });

  it('mixed observed and asserted_by_user origins both count (only inferred is excluded)', () => {
    const entries: PendingContradiction[] = [
      { episode_id: 'e1', session_id: 'session-a', origin: 'observed' },
      { episode_id: 'e2', session_id: 'session-b', origin: 'asserted_by_user' },
      { episode_id: 'e3', session_id: 'session-c', origin: 'inferred' }, // excluded
    ];
    expect(countDistinctProvenance(entries)).toBe(2);
  });
});
