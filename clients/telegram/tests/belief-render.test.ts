/**
 * clients/telegram/tests/belief-render.test.ts — Phase 68 Plan 02 Task 1.
 *
 * Covers push-codec.ts's v3 belief codec (encodeBeliefCallbackData /
 * decodeBeliefCallbackData) and belief-render.ts's asDisplayText /
 * renderBeliefDecisionMessage / beliefKeyboard.
 *
 * No src/ imports — CLIENT-01 structural guard (scanned by import-boundary.test.ts).
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  encodeBeliefCallbackData,
  decodeBeliefCallbackData,
  encodeCallbackData,
  decodeCallbackData,
  encodeProposalCallbackData,
  decodeProposalCallbackData,
} from '../push-codec';
import {
  asDisplayText,
  renderBeliefDecisionMessage,
  beliefKeyboard,
} from '../belief-render';
import type { StoredBeliefProposal } from '../types';

// ── Fixtures ────────────────────────────────────────────────────────────────

function hex(seed: string, len: number): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, len);
}

function makeBelief(overrides: Partial<StoredBeliefProposal> = {}): StoredBeliefProposal {
  const serverProposalId = overrides.serverProposalId ?? hex('server-' + (overrides.id ?? 'default'), 64);
  return {
    kind: 'belief',
    id: overrides.id ?? serverProposalId.slice(0, 32),
    serverProposalId,
    entityDescriptor: 'Acme Corp — Backend Engineer',
    changeField: 'status',
    changeFrom: 'applied',
    changeTo: 'interviewing',
    evidenceQuote: 'Thanks for applying — we would like to schedule an interview.',
    confidence: 'high',
    serverCreatedAtMs: Date.now(),
    localStatus: 'pending',
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    createdAt: new Date().toISOString(),
    maxTtlMs: 86_400_000,
    ...overrides,
  };
}

const ID32 = hex('local-id-fixture', 32);

// ── v3 belief callback codec ──────────────────────────────────────────────

describe('encodeBeliefCallbackData — byte budget', () => {
  it('encoded payload is 36 bytes and starts with "3|" for a 32-hex id', () => {
    const encoded = encodeBeliefCallbackData(ID32, 'a');
    expect(encoded.startsWith('3|')).toBe(true);
    expect(Buffer.byteLength(encoded, 'utf8')).toBe(36);
    expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(64);
  });
});

describe('decodeBeliefCallbackData — round-trip', () => {
  const cases: Array<['a' | 'e' | 'r' | 's', 'approve' | 'edit' | 'reject' | 'snooze']> = [
    ['a', 'approve'],
    ['e', 'edit'],
    ['r', 'reject'],
    ['s', 'snooze'],
  ];

  for (const [code, action] of cases) {
    it(`round-trips "${code}" → ${action}`, () => {
      const encoded = encodeBeliefCallbackData(ID32, code);
      const decoded = decodeBeliefCallbackData(encoded);
      expect(decoded).not.toBeNull();
      expect(decoded!.localId).toBe(ID32);
      expect(decoded!.action).toBe(action);
    });
  }
});

describe('decodeBeliefCallbackData — malformed input returns null', () => {
  it('returns null for a v1 string', () => {
    const v1 = encodeCallbackData('550e8400-e29b-41d4-a716-446655440000', new Date().toISOString(), 'c');
    expect(decodeBeliefCallbackData(v1)).toBeNull();
  });

  it('returns null for a v2 string', () => {
    const v2 = encodeProposalCallbackData('550e8400-e29b-41d4-a716-446655440000', 'a');
    expect(decodeBeliefCallbackData(v2)).toBeNull();
  });

  it('returns null for a 2-part string', () => {
    expect(decodeBeliefCallbackData(`3|${ID32}`)).toBeNull();
  });

  it('returns null for a 4-part string', () => {
    expect(decodeBeliefCallbackData(`3|${ID32}|a|extra`)).toBeNull();
  });

  it('returns null for an id that is 31 hex chars', () => {
    expect(decodeBeliefCallbackData(`3|${ID32.slice(0, 31)}|a`)).toBeNull();
  });

  it('returns null for an id containing a slash', () => {
    const withSlash = ID32.slice(0, 16) + '/' + ID32.slice(17);
    expect(decodeBeliefCallbackData(`3|${withSlash}|a`)).toBeNull();
  });

  it('returns null for an id with uppercase hex', () => {
    expect(decodeBeliefCallbackData(`3|${ID32.toUpperCase()}|a`)).toBeNull();
  });

  it('returns null for an unknown code', () => {
    expect(decodeBeliefCallbackData(`3|${ID32}|x`)).toBeNull();
  });
});

describe('v1 / v2 / v3 codec isolation', () => {
  it('decodeProposalCallbackData (v2) returns null for a v3 string', () => {
    const v3 = encodeBeliefCallbackData(ID32, 'a');
    expect(decodeProposalCallbackData(v3)).toBeNull();
  });

  it('decodeCallbackData (v1) returns null for a v3 string', () => {
    const v3 = encodeBeliefCallbackData(ID32, 'a');
    expect(decodeCallbackData(v3)).toBeNull();
  });
});

// ── asDisplayText ──────────────────────────────────────────────────────────

describe('asDisplayText', () => {
  it('collapses newlines, tabs, and runs of spaces to a single space', () => {
    const raw = 'line one\n\nline   two\t\ttabbed  three';
    expect(asDisplayText(raw, 200)).toBe('line one line two tabbed three');
  });

  it('truncates past its cap with a single-character ellipsis', () => {
    const raw = 'a'.repeat(50);
    const out = asDisplayText(raw, 10);
    expect(out.length).toBe(10);
    expect(out.endsWith('…')).toBe(true);
    expect(out).toBe('a'.repeat(9) + '…');
  });

  it('trims leading/trailing whitespace and leaves short strings untouched', () => {
    expect(asDisplayText('  hello  ', 200)).toBe('hello');
  });
});

// ── renderBeliefDecisionMessage ────────────────────────────────────────────

describe('renderBeliefDecisionMessage', () => {
  it('output for a one-item group contains the entity descriptor, change field, both transition sides, and the evidence quote', () => {
    const belief = makeBelief();
    const rendered = renderBeliefDecisionMessage([belief]);
    expect(rendered).toContain(belief.entityDescriptor);
    expect(rendered).toContain(belief.changeField);
    expect(rendered).toContain(belief.changeFrom as string);
    expect(rendered).toContain(belief.changeTo);
    expect(rendered).toContain(belief.evidenceQuote);
  });

  it('renders changeFrom === null as the fixed literal "(unset)"', () => {
    const belief = makeBelief({ changeFrom: null });
    const rendered = renderBeliefDecisionMessage([belief]);
    expect(rendered).toContain('(unset)');
  });

  it('a forged field-line-shaped quote renders on ONE line inside the quote delimiters', () => {
    // Built by concatenation (not a literal template) so the fixture itself does not
    // read as a structural field line in this source file.
    const genuine = 'Genuine excerpt from the email body.';
    const forgedNumber = String(2);
    const forgedField = ['status', 'rejected', '→', 'ghosted'].join(' ');
    const forgedLine = forgedNumber + '.' + ' ' + forgedField + ':' + ' value';
    const evidenceQuote = genuine + '\n' + forgedLine;

    const belief = makeBelief({ evidenceQuote });
    const rendered = renderBeliefDecisionMessage([belief]);
    const lines = rendered.split('\n');

    // Exactly one real numbered constituent line ("1. ...") — the forged "2. ..."
    // text never becomes its own rendered line.
    const numberedLines = lines.filter(l => /^\d+\.\s/.test(l));
    expect(numberedLines).toHaveLength(1);

    // The quote line carries both halves joined by a single space, not a newline.
    const quoteLine = lines.find(l => l.includes(genuine));
    expect(quoteLine).toBeDefined();
    expect(quoteLine).toContain(forgedLine.replace(/\s+/g, ' ').trim());
  });

  it('output matches no numeric-confidence pattern', () => {
    const belief = makeBelief({ confidence: 'high' });
    const rendered = renderBeliefDecisionMessage([belief]);
    expect(/confidence\D{0,3}\d/i.test(rendered)).toBe(false);
  });

  it('a group of 12 constituents renders at most 10 numbered blocks and an overflow line naming the remainder', () => {
    const group = Array.from({ length: 12 }, (_, i) =>
      makeBelief({ id: hex('overflow-' + String(i), 32), serverCreatedAtMs: Date.now() + i }),
    );
    const rendered = renderBeliefDecisionMessage(group);
    const numberedLines = rendered.split('\n').filter(l => /^\d+\.\s/.test(l));
    expect(numberedLines.length).toBeLessThanOrEqual(10);
    expect(rendered).toContain('2 more not shown');
  });
});

// ── beliefKeyboard ──────────────────────────────────────────────────────────

describe('beliefKeyboard', () => {
  it('produces one row per constituent; every approve label contains → and both transition sides; no label equals a bare Approve', () => {
    const group = [
      makeBelief({ id: hex('kb-1', 32), changeFrom: 'applied', changeTo: 'interviewing' }),
      makeBelief({ id: hex('kb-2', 32), changeFrom: 'interviewing', changeTo: 'rejected' }),
    ];
    const kb = beliefKeyboard(group);
    expect(kb.inline_keyboard).toHaveLength(2);

    kb.inline_keyboard.forEach((row, i) => {
      const approveBtn = row[0];
      expect(approveBtn).toBeDefined();
      expect(approveBtn!.text).toContain('→');
      expect(approveBtn!.text).toContain(group[i]!.changeFrom as string);
      expect(approveBtn!.text).toContain(group[i]!.changeTo);
      expect(approveBtn!.text).not.toBe('Approve');
      expect(approveBtn!.text).not.toBe('✅ Approve');
    });
  });

  it("every button's callback_data decodes back to that constituent's local id", () => {
    const group = [
      makeBelief({ id: hex('decode-1', 32) }),
      makeBelief({ id: hex('decode-2', 32) }),
    ];
    const kb = beliefKeyboard(group);
    kb.inline_keyboard.forEach((row, i) => {
      const approveBtn = row[0];
      const rejectBtn = row[1];
      expect(approveBtn).toBeDefined();
      expect(rejectBtn).toBeDefined();
      const decodedApprove = decodeBeliefCallbackData(approveBtn!.callback_data);
      const decodedReject = decodeBeliefCallbackData(rejectBtn!.callback_data);
      expect(decodedApprove?.localId).toBe(group[i]!.id);
      expect(decodedApprove?.action).toBe('approve');
      expect(decodedReject?.localId).toBe(group[i]!.id);
      expect(decodedReject?.action).toBe('reject');
    });
  });

  it('a group of 12 constituents renders at most 10 button rows', () => {
    const group = Array.from({ length: 12 }, (_, i) => makeBelief({ id: hex('kb-overflow-' + String(i), 32) }));
    const kb = beliefKeyboard(group);
    expect(kb.inline_keyboard.length).toBeLessThanOrEqual(10);
  });
});
