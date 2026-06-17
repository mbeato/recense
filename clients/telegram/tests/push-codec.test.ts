/**
 * clients/telegram/tests/push-codec.test.ts
 *
 * TDD RED/GREEN tests for push-codec.ts (Plan 22-01 Task 3).
 *
 * Covers:
 *   - encodeCallbackData produces compact payload ≤ 64 bytes for all three outcomes (Pitfall 2)
 *   - Round-trip: decodeCallbackData(encodeCallbackData(...)) returns original fields (A1 mitigation)
 *   - occurrenceDueAt reconstructed as .000Z ISO (idempotency key match)
 *   - Outcome code mapping: c→completed, d→dismissed, s→snoozed
 *   - Malformed / wrong-version / missing-fields / non-numeric-epoch / unknown-code → null (T-22-02)
 *
 * No src/ imports — CLIENT-01 structural guard enforced.
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  encodeCallbackData,
  decodeCallbackData,
  encodeProposalCallbackData,
  decodeProposalCallbackData,
} from '../push-codec';

// Representative UUID v4 (36 chars) — the max-length node_id format
const UUID = '550e8400-e29b-41d4-a716-446655440000';
const DUE_AT = '2026-06-20T14:00:00.000Z';

// ── 64-byte limit (Landmine 1 / Pitfall 2) ────────────────────────────────────

describe('encodeCallbackData — 64-byte constraint', () => {
  it('encoded "c" outcome is ≤ 64 bytes for a full UUID v4 node_id', () => {
    const encoded = encodeCallbackData(UUID, DUE_AT, 'c');
    expect(encoded.length).toBeLessThanOrEqual(64);
  });

  it('encoded "d" outcome is ≤ 64 bytes', () => {
    const encoded = encodeCallbackData(UUID, DUE_AT, 'd');
    expect(encoded.length).toBeLessThanOrEqual(64);
  });

  it('encoded "s" outcome is ≤ 64 bytes', () => {
    const encoded = encodeCallbackData(UUID, DUE_AT, 's');
    expect(encoded.length).toBeLessThanOrEqual(64);
  });

  it('format is version|uuid|epochSec|code (pipe-delimited)', () => {
    const encoded = encodeCallbackData(UUID, DUE_AT, 'c');
    const parts = encoded.split('|');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('1'); // version prefix
    expect(parts[1]).toBe(UUID);
    expect(parts[2]).toMatch(/^\d{10}$/); // epoch seconds (10 digits for dates 2001–2286)
    expect(parts[3]).toBe('c');
  });
});

// ── Round-trip + idempotency key reconstruction (A1 mitigation) ───────────────

describe('decodeCallbackData — round-trip', () => {
  it('round-trip "c" → completed with .000Z ISO', () => {
    const encoded = encodeCallbackData(UUID, DUE_AT, 'c');
    const decoded = decodeCallbackData(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.nodeId).toBe(UUID);
    expect(decoded!.occurrenceDueAt).toBe(new Date(DUE_AT).toISOString()); // .000Z form
    expect(decoded!.outcome).toBe('completed');
  });

  it('round-trip "d" → dismissed', () => {
    const encoded = encodeCallbackData(UUID, DUE_AT, 'd');
    const decoded = decodeCallbackData(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.outcome).toBe('dismissed');
    expect(decoded!.nodeId).toBe(UUID);
  });

  it('round-trip "s" → snoozed', () => {
    const encoded = encodeCallbackData(UUID, DUE_AT, 's');
    const decoded = decodeCallbackData(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.outcome).toBe('snoozed');
    expect(decoded!.nodeId).toBe(UUID);
  });

  it('occurrenceDueAt always has .000Z millisecond suffix (A1 idempotency key normalization)', () => {
    // Input without milliseconds — encode normalizes via new Date().toISOString()
    const dueWithoutMs = '2026-06-20T14:00:00Z';
    const encoded = encodeCallbackData(UUID, dueWithoutMs, 'c');
    const decoded = decodeCallbackData(encoded);
    expect(decoded).not.toBeNull();
    // Must end in .000Z — the SQLite stored form for calendar events
    expect(decoded!.occurrenceDueAt).toMatch(/\.000Z$/);
    // Must equal new Date(dueWithoutMs).toISOString() — normalized form
    expect(decoded!.occurrenceDueAt).toBe(new Date(dueWithoutMs).toISOString());
  });

  it('different due_at values produce different encoded epochs', () => {
    const due1 = '2026-06-20T14:00:00.000Z';
    const due2 = '2026-06-21T14:00:00.000Z';
    const e1 = encodeCallbackData(UUID, due1, 'c');
    const e2 = encodeCallbackData(UUID, due2, 'c');
    expect(e1).not.toBe(e2);
  });
});

// ── Malformed input → null (T-22-02 input validation) ─────────────────────────

describe('decodeCallbackData — malformed input returns null', () => {
  it('returns null for empty string', () => {
    expect(decodeCallbackData('')).toBeNull();
  });

  it('returns null for arbitrary garbage string', () => {
    expect(decodeCallbackData('garbage')).toBeNull();
  });

  it('returns null for wrong version prefix', () => {
    // Old/future format with version '2'
    expect(decodeCallbackData(`2|${UUID}|1750420800|c`)).toBeNull();
  });

  it('returns null when version prefix is missing (only 3 parts)', () => {
    expect(decodeCallbackData(`${UUID}|1750420800|c`)).toBeNull();
  });

  it('returns null for non-numeric epoch', () => {
    expect(decodeCallbackData(`1|${UUID}|not-a-number|c`)).toBeNull();
  });

  it('returns null for NaN epoch (empty epoch segment)', () => {
    expect(decodeCallbackData(`1|${UUID}||c`)).toBeNull();
  });

  it('returns null for unknown outcome code', () => {
    expect(decodeCallbackData(`1|${UUID}|1750420800|x`)).toBeNull();
  });

  it('returns null for outcome code "z"', () => {
    expect(decodeCallbackData(`1|${UUID}|1750420800|z`)).toBeNull();
  });

  it('returns null when fewer than 4 pipe-delimited segments', () => {
    expect(decodeCallbackData('1|shortpayload')).toBeNull();
  });

  it('returns null for a JSON blob (not compact format)', () => {
    expect(
      decodeCallbackData(JSON.stringify({ node_id: UUID, due_at: DUE_AT, outcome: 'completed' })),
    ).toBeNull();
  });

  it('returns null for ISO date in epoch position (non-numeric)', () => {
    expect(decodeCallbackData(`1|${UUID}|${DUE_AT}|c`)).toBeNull();
  });
});

// ── v2 proposal codec — round-trip (Phase 23) ─────────────────────────────────

describe('encodeProposalCallbackData / decodeProposalCallbackData — v2 round-trip', () => {
  const cases: Array<['a' | 'e' | 'r' | 's', 'approve' | 'edit' | 'reject' | 'snooze']> = [
    ['a', 'approve'],
    ['e', 'edit'],
    ['r', 'reject'],
    ['s', 'snooze'],
  ];

  for (const [code, action] of cases) {
    it(`round-trips "${code}" → ${action}`, () => {
      const encoded = encodeProposalCallbackData(UUID, code);
      const decoded = decodeProposalCallbackData(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.proposalId).toBe(UUID);
      expect(decoded!.action).toBe(action);
    });
  }

  it('encoded format is 2|{proposalId}|{code}', () => {
    const encoded = encodeProposalCallbackData(UUID, 'a');
    const parts = encoded.split('|');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('2');
    expect(parts[1]).toBe(UUID);
    expect(parts[2]).toBe('a');
  });

  it('encoded v2 payload for a real UUID is < 64 bytes', () => {
    const encoded = encodeProposalCallbackData(randomUUID(), 'a');
    expect(Buffer.byteLength(encoded)).toBeLessThan(64);
  });
});

// ── v2 proposal codec — malformed input → null ────────────────────────────────

describe('decodeProposalCallbackData — malformed input returns null', () => {
  it('returns null for empty string', () => {
    expect(decodeProposalCallbackData('')).toBeNull();
  });

  it('returns null for wrong part count (4 parts)', () => {
    expect(decodeProposalCallbackData(`2|${UUID}|a|extra`)).toBeNull();
  });

  it('returns null for too few parts (2 parts)', () => {
    expect(decodeProposalCallbackData(`2|${UUID}`)).toBeNull();
  });

  it('returns null for unknown action code', () => {
    expect(decodeProposalCallbackData(`2|${UUID}|x`)).toBeNull();
  });

  it('returns null for empty proposalId', () => {
    expect(decodeProposalCallbackData(`2||a`)).toBeNull();
  });

  it("returns null for a future version '3'", () => {
    expect(decodeProposalCallbackData(`3|${UUID}|a`)).toBeNull();
  });
});

// ── v1 / v2 mutual exclusivity (no cross-version confusion) ───────────────────

describe('v1 / v2 codec isolation', () => {
  it('decodeProposalCallbackData returns null for a legacy v1 string', () => {
    const v1 = encodeCallbackData(UUID, DUE_AT, 'c');
    expect(decodeProposalCallbackData(v1)).toBeNull();
  });

  it('decodeCallbackData (v1) returns null for a v2 string', () => {
    const v2 = encodeProposalCallbackData(UUID, 'a');
    expect(decodeCallbackData(v2)).toBeNull();
  });
});
