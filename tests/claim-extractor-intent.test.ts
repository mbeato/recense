/**
 * ExtractedClaim intent-classification extension tests (Plan 63-01, D-04/D-05/D-06).
 *
 * Behavioral contract:
 *   - IntentStatus, INTENT_STATUSES, toIntentStatus are exported from claim-extractor
 *   - IntentConfidence, INTENT_CONFIDENCES, toIntentConfidence are exported from claim-extractor
 *   - toIntentStatus/toIntentConfidence drop (undefined) on any out-of-enum value — never
 *     a coerced fallback (D-05, the deliberate inversion of toActionType)
 *   - parseClaimsFromArray/parseClaims apply an all-or-nothing gate: intent_status,
 *     intent_entity, intent_confidence appear together or not at all (D-05)
 *   - Existing claim shapes (no intent fields) are unchanged; the TEMP-02 due_at/action_type
 *     gate is untouched and independent of the intent gate
 */
import { describe, it, expect } from 'vitest';
import {
  parseClaims,
  parseClaimsFromArray,
  IntentStatus,
  INTENT_STATUSES,
  toIntentStatus,
  IntentConfidence,
  INTENT_CONFIDENCES,
  toIntentConfidence,
} from '../src/model/claim-extractor';

// ---------------------------------------------------------------------------
// toIntentStatus coercion (D-05)
// ---------------------------------------------------------------------------

describe('toIntentStatus coercion', () => {
  it("returns 'applied' for 'applied'", () => {
    expect(toIntentStatus('applied')).toBe('applied');
  });

  it("returns 'interviewing' for 'interviewing'", () => {
    expect(toIntentStatus('interviewing')).toBe('interviewing');
  });

  it("returns 'rejected' for 'rejected'", () => {
    expect(toIntentStatus('rejected')).toBe('rejected');
  });

  it("returns 'offer' for 'offer'", () => {
    expect(toIntentStatus('offer')).toBe('offer');
  });

  it("returns undefined for an out-of-enum string ('ghosted')", () => {
    expect(toIntentStatus('ghosted')).toBeUndefined();
  });

  it('returns undefined for wrong case (Applied)', () => {
    expect(toIntentStatus('Applied')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(toIntentStatus('')).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(toIntentStatus(null)).toBeUndefined();
  });

  it('returns undefined for a number (42)', () => {
    expect(toIntentStatus(42)).toBeUndefined();
  });

  it('returns undefined for an object', () => {
    expect(toIntentStatus({ status: 'applied' })).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(toIntentStatus(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// toIntentConfidence coercion (D-05/D-06)
// ---------------------------------------------------------------------------

describe('toIntentConfidence coercion', () => {
  it("returns 'high' for 'high'", () => {
    expect(toIntentConfidence('high')).toBe('high');
  });

  it("returns 'medium' for 'medium'", () => {
    expect(toIntentConfidence('medium')).toBe('medium');
  });

  it("returns 'low' for 'low'", () => {
    expect(toIntentConfidence('low')).toBe('low');
  });

  it("returns undefined for an out-of-enum string ('certain')", () => {
    expect(toIntentConfidence('certain')).toBeUndefined();
  });

  it('returns undefined for a raw numeric confidence (0.9) — D-06', () => {
    expect(toIntentConfidence(0.9)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(toIntentConfidence(null)).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(toIntentConfidence('')).toBeUndefined();
  });

  it('returns undefined for an object', () => {
    expect(toIntentConfidence({ level: 'high' })).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(toIntentConfidence(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// INTENT_STATUSES / INTENT_CONFIDENCES sets
// ---------------------------------------------------------------------------

describe('INTENT_STATUSES', () => {
  it('contains exactly the 4 valid intent status values', () => {
    const expected: IntentStatus[] = ['applied', 'interviewing', 'rejected', 'offer'];
    for (const s of expected) {
      expect(INTENT_STATUSES.has(s)).toBe(true);
    }
    expect(INTENT_STATUSES.size).toBe(4);
  });
});

describe('INTENT_CONFIDENCES', () => {
  it('contains exactly the 3 valid confidence levels', () => {
    const expected: IntentConfidence[] = ['high', 'medium', 'low'];
    for (const c of expected) {
      expect(INTENT_CONFIDENCES.has(c)).toBe(true);
    }
    expect(INTENT_CONFIDENCES.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// parseClaimsFromArray all-or-nothing intent gate (D-05)
// ---------------------------------------------------------------------------

describe('parseClaimsFromArray intent gate', () => {
  it('carries all three intent fields when all are present and valid', () => {
    const claims = parseClaimsFromArray([
      {
        type: 'fact',
        value: 'Applied to recense role at Acme Corp',
        intent_status: 'applied',
        intent_entity: 'Acme Corp',
        intent_confidence: 'high',
      },
    ]);
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim.intent_status).toBe('applied');
    expect(claim.intent_entity).toBe('Acme Corp');
    expect(claim.intent_confidence).toBe('high');
  });

  it('trims whitespace on intent_entity when all three are present', () => {
    const claims = parseClaimsFromArray([
      {
        type: 'fact',
        value: 'x',
        intent_status: 'offer',
        intent_entity: '  Acme Corp  ',
        intent_confidence: 'medium',
      },
    ]);
    expect(claims[0]!.intent_entity).toBe('Acme Corp');
  });

  it('drops all three when intent_status is out of enum (ghosted)', () => {
    const claims = parseClaimsFromArray([
      {
        type: 'fact',
        value: 'x',
        intent_status: 'ghosted',
        intent_entity: 'Acme Corp',
        intent_confidence: 'high',
      },
    ]);
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim.value).toBe('x');
    expect(claim.intent_status).toBeUndefined();
    expect(claim.intent_entity).toBeUndefined();
    expect(claim.intent_confidence).toBeUndefined();
  });

  it('drops all three when intent_status is wrong case (Applied)', () => {
    const claims = parseClaimsFromArray([
      {
        type: 'fact',
        value: 'x',
        intent_status: 'Applied',
        intent_entity: 'Acme Corp',
        intent_confidence: 'high',
      },
    ]);
    const claim = claims[0]!;
    expect(claim.intent_status).toBeUndefined();
    expect(claim.intent_entity).toBeUndefined();
    expect(claim.intent_confidence).toBeUndefined();
  });

  it('drops all three when intent_confidence is out of enum (certain)', () => {
    const claims = parseClaimsFromArray([
      {
        type: 'fact',
        value: 'x',
        intent_status: 'applied',
        intent_entity: 'Acme Corp',
        intent_confidence: 'certain',
      },
    ]);
    const claim = claims[0]!;
    expect(claim.intent_status).toBeUndefined();
    expect(claim.intent_entity).toBeUndefined();
    expect(claim.intent_confidence).toBeUndefined();
  });

  it('drops all three when intent_confidence is a raw numeric (0.9) — D-06', () => {
    const claims = parseClaimsFromArray([
      {
        type: 'fact',
        value: 'x',
        intent_status: 'applied',
        intent_entity: 'Acme Corp',
        intent_confidence: 0.9,
      },
    ]);
    const claim = claims[0]!;
    expect(claim.intent_status).toBeUndefined();
    expect(claim.intent_entity).toBeUndefined();
    expect(claim.intent_confidence).toBeUndefined();
  });

  it('drops all three when intent_confidence is missing', () => {
    const claims = parseClaimsFromArray([
      {
        type: 'fact',
        value: 'x',
        intent_status: 'applied',
        intent_entity: 'Acme Corp',
      },
    ]);
    const claim = claims[0]!;
    expect(claim.intent_status).toBeUndefined();
    expect(claim.intent_entity).toBeUndefined();
    expect(claim.intent_confidence).toBeUndefined();
  });

  it('drops all three when intent_entity is missing', () => {
    const claims = parseClaimsFromArray([
      {
        type: 'fact',
        value: 'x',
        intent_status: 'applied',
        intent_confidence: 'high',
      },
    ]);
    const claim = claims[0]!;
    expect(claim.intent_status).toBeUndefined();
    expect(claim.intent_entity).toBeUndefined();
    expect(claim.intent_confidence).toBeUndefined();
  });

  it('drops all three when intent_entity is empty', () => {
    const claims = parseClaimsFromArray([
      {
        type: 'fact',
        value: 'x',
        intent_status: 'applied',
        intent_entity: '',
        intent_confidence: 'high',
      },
    ]);
    const claim = claims[0]!;
    expect(claim.intent_status).toBeUndefined();
    expect(claim.intent_entity).toBeUndefined();
    expect(claim.intent_confidence).toBeUndefined();
  });

  it('drops all three when intent_entity is whitespace-only', () => {
    const claims = parseClaimsFromArray([
      {
        type: 'fact',
        value: 'x',
        intent_status: 'applied',
        intent_entity: '   ',
        intent_confidence: 'high',
      },
    ]);
    const claim = claims[0]!;
    expect(claim.intent_status).toBeUndefined();
    expect(claim.intent_entity).toBeUndefined();
    expect(claim.intent_confidence).toBeUndefined();
  });

  it('drops all three when intent_entity is non-string', () => {
    const claims = parseClaimsFromArray([
      {
        type: 'fact',
        value: 'x',
        intent_status: 'applied',
        intent_entity: 42,
        intent_confidence: 'high',
      },
    ]);
    const claim = claims[0]!;
    expect(claim.intent_status).toBeUndefined();
    expect(claim.intent_entity).toBeUndefined();
    expect(claim.intent_confidence).toBeUndefined();
  });

  it('drops all three when only intent_status is present (partial classification never accepted)', () => {
    const claims = parseClaimsFromArray([
      { type: 'fact', value: 'x', intent_status: 'offer' },
    ]);
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim.value).toBe('x');
    expect(claim.intent_status).toBeUndefined();
    expect(claim.intent_entity).toBeUndefined();
    expect(claim.intent_confidence).toBeUndefined();
  });

  it('leaves all three undefined when no intent fields are present (backward-compat)', () => {
    const claims = parseClaimsFromArray([
      { type: 'entity', value: 'Jane Doe is the founder', links: ['recense project'] },
    ]);
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim.intent_status).toBeUndefined();
    expect(claim.intent_entity).toBeUndefined();
    expect(claim.intent_confidence).toBeUndefined();
  });

  it('keeps both temporal and intent fields independently on the same claim', () => {
    const claims = parseClaimsFromArray([
      {
        type: 'fact',
        value: 'Interview scheduled for 2026-08-10',
        due_at: '2026-08-10T14:00:00Z',
        action_type: 'appointment',
        intent_status: 'interviewing',
        intent_entity: 'Acme Corp',
        intent_confidence: 'medium',
      },
    ]);
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim.due_at).toBe('2026-08-10T14:00:00Z');
    expect(claim.action_type).toBe('appointment');
    expect(claim.intent_status).toBe('interviewing');
    expect(claim.intent_entity).toBe('Acme Corp');
    expect(claim.intent_confidence).toBe('medium');
  });

  it('an item with invalid intent fields still returns its claim (type/value/links survive)', () => {
    const claims = parseClaimsFromArray([
      {
        type: 'fact',
        value: 'Some fact',
        links: ['Acme Corp'],
        intent_status: 'ghosted',
        intent_entity: 'Acme Corp',
        intent_confidence: 'high',
      },
    ]);
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim.value).toBe('Some fact');
    expect(claim.links).toEqual(['Acme Corp']);
    expect(claim.intent_status).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseClaims (fence-tolerant wrapper) — production entry path coverage
// ---------------------------------------------------------------------------

describe('parseClaims intent gate (production entry path)', () => {
  it('carries all three intent fields through the fence-tolerant wrapper', () => {
    const json = JSON.stringify([
      {
        type: 'fact',
        value: 'Offer received from Acme Corp',
        intent_status: 'offer',
        intent_entity: 'Acme Corp',
        intent_confidence: 'high',
      },
    ]);
    const claims = parseClaims(json);
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim.intent_status).toBe('offer');
    expect(claim.intent_entity).toBe('Acme Corp');
    expect(claim.intent_confidence).toBe('high');
  });

  it('drops all three through the fence-tolerant wrapper on out-of-enum status', () => {
    const fenced =
      '```json\n[{"type":"fact","value":"x","intent_status":"ghosted",' +
      '"intent_entity":"Acme Corp","intent_confidence":"high"}]\n```';
    const claims = parseClaims(fenced);
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim.value).toBe('x');
    expect(claim.intent_status).toBeUndefined();
    expect(claim.intent_entity).toBeUndefined();
    expect(claim.intent_confidence).toBeUndefined();
  });
});
