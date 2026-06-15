/**
 * ExtractedClaim temporal extension tests (Plan 20-01, D-02/D-03).
 *
 * Behavioral contract:
 *   - ActionType, ACTION_TYPES, toActionType are exported from claim-extractor
 *   - toActionType coerces unknown values to 'other' (D-02 robustness)
 *   - parseClaims populates due_at/action_type only when due_at is present (D-03)
 *   - Existing claim shapes (no temporal fields) are byte-for-byte unchanged
 */
import { describe, it, expect } from 'vitest';
import {
  parseClaims,
  ActionType,
  ACTION_TYPES,
  toActionType,
} from '../src/model/claim-extractor';

// ---------------------------------------------------------------------------
// toActionType coercion (D-02)
// ---------------------------------------------------------------------------

describe('toActionType coercion', () => {
  it("returns 'flight' for 'flight'", () => {
    expect(toActionType('flight')).toBe('flight');
  });

  it("returns 'deadline' for 'deadline'", () => {
    expect(toActionType('deadline')).toBe('deadline');
  });

  it("returns 'appointment' for 'appointment'", () => {
    expect(toActionType('appointment')).toBe('appointment');
  });

  it("returns 'other' for an unknown string 'xyz'", () => {
    expect(toActionType('xyz')).toBe('other');
  });

  it("returns 'other' for undefined", () => {
    expect(toActionType(undefined)).toBe('other');
  });

  it("returns 'other' for a number (42)", () => {
    expect(toActionType(42)).toBe('other');
  });

  it("returns 'other' for null", () => {
    expect(toActionType(null)).toBe('other');
  });

  it("returns 'other' for an empty string", () => {
    expect(toActionType('')).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// ACTION_TYPES set
// ---------------------------------------------------------------------------

describe('ACTION_TYPES', () => {
  it('contains exactly the 7 valid action types', () => {
    const expected: ActionType[] = [
      'deadline', 'flight', 'appointment', 'receipt', 'payment', 'meeting', 'other',
    ];
    for (const t of expected) {
      expect(ACTION_TYPES.has(t)).toBe(true);
    }
    expect(ACTION_TYPES.size).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// parseClaims temporal field extraction (D-03)
// ---------------------------------------------------------------------------

describe('parseClaims temporal fields', () => {
  it('carries due_at and valid action_type when both are present', () => {
    const json = JSON.stringify([
      {
        type: 'fact',
        value: 'Flight AA123 to NYC departs 2026-07-04T08:00:00Z',
        due_at: '2026-07-04T08:00:00Z',
        action_type: 'flight',
      },
    ]);
    const claims = parseClaims(json);
    expect(claims).toHaveLength(1);
    expect(claims[0].due_at).toBe('2026-07-04T08:00:00Z');
    expect(claims[0].action_type).toBe('flight');
  });

  it('coerces out-of-enum action_type to "other" when due_at is present (D-02)', () => {
    const json = JSON.stringify([
      {
        type: 'fact',
        value: 'Some time-sensitive fact',
        due_at: '2026-08-01T12:00:00Z',
        action_type: 'invalid_type',
      },
    ]);
    const claims = parseClaims(json);
    expect(claims).toHaveLength(1);
    expect(claims[0].due_at).toBe('2026-08-01T12:00:00Z');
    expect(claims[0].action_type).toBe('other');
  });

  it('sets action_type to "other" when due_at is present but action_type is missing', () => {
    const json = JSON.stringify([
      {
        type: 'fact',
        value: 'Invoice due 2026-06-30',
        due_at: '2026-06-30T23:59:00Z',
        // action_type omitted
      },
    ]);
    const claims = parseClaims(json);
    expect(claims).toHaveLength(1);
    expect(claims[0].due_at).toBe('2026-06-30T23:59:00Z');
    expect(claims[0].action_type).toBe('other');
  });

  it('leaves due_at and action_type undefined when due_at is absent (D-03)', () => {
    const json = JSON.stringify([
      {
        type: 'fact',
        value: 'Never inflate metrics',
        action_type: 'flight', // action_type present but no due_at — must be ignored
      },
    ]);
    const claims = parseClaims(json);
    expect(claims).toHaveLength(1);
    expect(claims[0].due_at).toBeUndefined();
    expect(claims[0].action_type).toBeUndefined();
  });

  it('leaves due_at and action_type undefined for a claim with no temporal fields', () => {
    const json = JSON.stringify([
      { type: 'entity', value: 'Jane Doe is the founder', links: ['recense project'] },
    ]);
    const claims = parseClaims(json);
    expect(claims).toHaveLength(1);
    expect(claims[0].due_at).toBeUndefined();
    expect(claims[0].action_type).toBeUndefined();
  });

  it('handles mixed temporal and non-temporal claims in a single response', () => {
    const json = JSON.stringify([
      { type: 'entity', value: 'Max Beato is the founder' },
      {
        type: 'fact',
        value: 'Flight departs 2026-07-04',
        due_at: '2026-07-04T08:00:00Z',
        action_type: 'flight',
      },
      { type: 'fact', value: 'Prefers lowercase' },
    ]);
    const claims = parseClaims(json);
    expect(claims).toHaveLength(3);

    expect(claims[0].due_at).toBeUndefined();
    expect(claims[0].action_type).toBeUndefined();

    expect(claims[1].due_at).toBe('2026-07-04T08:00:00Z');
    expect(claims[1].action_type).toBe('flight');

    expect(claims[2].due_at).toBeUndefined();
    expect(claims[2].action_type).toBeUndefined();
  });

  it('ignores whitespace-only due_at values (treats as missing)', () => {
    const json = JSON.stringify([
      {
        type: 'fact',
        value: 'Some fact',
        due_at: '   ',
        action_type: 'deadline',
      },
    ]);
    const claims = parseClaims(json);
    expect(claims).toHaveLength(1);
    expect(claims[0].due_at).toBeUndefined();
    expect(claims[0].action_type).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Backward-compatibility: existing claim shapes unchanged
// ---------------------------------------------------------------------------

describe('backward-compatibility: existing claim shapes', () => {
  it('parses entity + fact without temporal fields identically to before', () => {
    const json = JSON.stringify([
      { type: 'entity', value: 'recense project', links: [] },
      { type: 'fact', value: 'Preferred test runner is vitest', links: ['recense project'] },
    ]);
    const claims = parseClaims(json);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ type: 'entity', value: 'recense project' });
    expect(claims[1]).toMatchObject({ type: 'fact', value: 'Preferred test runner is vitest' });
    // Temporal fields must be absent
    expect(claims[0].due_at).toBeUndefined();
    expect(claims[1].due_at).toBeUndefined();
  });

  it('does not break fenced-JSON parsing (real model output regression)', () => {
    const fenced =
      '```json\n[{"type":"entity","value":"recense project","links":[]},\n' +
      '{"type":"fact","value":"Never inflate metrics","links":[]}]\n```';
    const claims = parseClaims(fenced);
    expect(claims).toHaveLength(2);
    expect(claims[0].due_at).toBeUndefined();
  });
});
