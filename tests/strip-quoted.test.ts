/**
 * strip-quoted.ts unit tests — Phase 65, Plan 65-02 (DRIFT-03).
 *
 * Plain strings only: no DB, no clock, no provider, no adapter, no config, no import from
 * `src/source/gmail-adapter.ts` and no `RawGmailMessage` construction. `stripQuotedForwarded`
 * and `isNearEmptyResidual` are pure functions over plain text; this suite proves that in
 * isolation, mirroring `tests/entity-resolution.test.ts`'s "no provider stub of any kind"
 * honesty framing.
 *
 * REVIEW-BLOCKING: D-07's farming semantics rest on this module. If `stripQuotedForwarded`
 * ever starts leaking quoted content into the residual, three forwards of one thread become
 * three independent provenances and a single manipulated email can force-destabilize a belief
 * (research Pitfall 3). The Outlook-style fixture (no `>` prefixes in the original body) is
 * the load-bearing proof that the boundary rule — not the quote-line rule — is what saves us;
 * weakening the boundary rule to rely on `>`-prefix detection alone is a regression, not a
 * simplification.
 */
import { describe, it, expect } from 'vitest';
import { stripQuotedForwarded, isNearEmptyResidual } from '../src/source/strip-quoted';

const MAX_QUOTE_STRIP_CODE_UNITS = 200_000;

// ---------------------------------------------------------------------------
// Shared fixture table — idempotence and monotonicity are asserted over EVERY
// entry here, not spot-checked, per the plan's Task 2 requirement.
// ---------------------------------------------------------------------------

const FIXTURES: ReadonlyArray<{ readonly label: string; readonly input: string }> = [
  { label: 'no markers present', input: 'Rejected. Thanks for applying.' },
  {
    label: 'own text above a >-quoted reply',
    input: 'My own reply.\n\n> quoted line one\n> quoted line two',
  },
  {
    label: 'own text above an On ... wrote: attribution',
    input: 'Short note.\n\nOn Mon, Jan 5, 2026 at 9:00 AM Alice <a@x.com> wrote:\n> old text',
  },
  {
    label: 'own text above a forwarded-message banner',
    input: 'FYI\n\n---------- Forwarded message ----------\nFrom: Bob\nbody',
  },
  { label: 'pure quote, nothing of the author\'s own', input: '> only a quote\n> nothing of my own' },
  { label: 'empty string', input: '' },
  // Gmail-style reply: own text, blank line, attribution, then >-prefixed original.
  {
    label: 'Gmail-style reply',
    input:
      'Thanks for the update, I appreciate hearing back.\n\n' +
      'On Mon, Jan 5, 2026 at 9:00 AM Alice Smith <alice@acme.com> wrote:\n' +
      '> Unfortunately we are moving forward with other candidates.\n' +
      '> Best,\n' +
      '> Alice',
  },
  // Outlook-style reply: own text, then -----Original Message-----, then a header block,
  // then original body with NO > prefixes — proves the boundary rule independent of the
  // quote-line rule.
  {
    label: 'Outlook-style reply (no > prefixes in original body)',
    input:
      'Got it, thank you.\n\n' +
      '-----Original Message-----\n' +
      'From: Bob Recruiter\n' +
      'Sent: Monday, January 5, 2026 9:00 AM\n' +
      'To: Jane Candidate\n' +
      'Subject: Re: Application status\n\n' +
      'We regret to inform you that we have decided to move forward with other candidates\n' +
      'at this time. We wish you the best in your job search.',
  },
  // Bare forward: the marker is the very first line.
  {
    label: 'bare forward, marker is the first line',
    input: '---------- Forwarded message ----------\nFrom: Bob\nSubject: Fwd: status\n\nSee below.',
  },
  // A one-word comment above the quote.
  {
    label: 'one-word comment above a quote',
    input: 'Thoughts?\n\nOn Tue, Jan 6, 2026 at 10:00 AM Carol <c@x.com> wrote:\n> Full original text here.',
  },
  // Genuine new status content above the quote.
  {
    label: 'genuine status content above a quote',
    input:
      'Unfortunately we are moving forward with other candidates.\n\n' +
      'On Wed, Jan 7, 2026 at 11:00 AM Dave <d@x.com> wrote:\n' +
      '> Any update on my application?',
  },
];

// ---------------------------------------------------------------------------
// stripQuotedForwarded
// ---------------------------------------------------------------------------

describe('stripQuotedForwarded', () => {
  it('returns unchanged text when no markers are present', () => {
    expect(stripQuotedForwarded('Rejected. Thanks for applying.')).toBe(
      'Rejected. Thanks for applying.'
    );
  });

  it('strips a >-quoted reply, trimming trailing whitespace', () => {
    expect(stripQuotedForwarded('My own reply.\n\n> quoted line one\n> quoted line two')).toBe(
      'My own reply.'
    );
  });

  it('strips at an On ... wrote: attribution boundary', () => {
    expect(
      stripQuotedForwarded(
        'Short note.\n\nOn Mon, Jan 5, 2026 at 9:00 AM Alice <a@x.com> wrote:\n> old text'
      )
    ).toBe('Short note.');
  });

  it('strips at a Forwarded message banner', () => {
    expect(
      stripQuotedForwarded('FYI\n\n---------- Forwarded message ----------\nFrom: Bob\nbody')
    ).toBe('FYI');
  });

  it('yields empty residual for a pure quote with nothing of the author\'s own', () => {
    expect(stripQuotedForwarded('> only a quote\n> nothing of my own')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(stripQuotedForwarded('')).toBe('');
  });

  it('Gmail-style: residual excludes the quoted original body', () => {
    const input =
      'Thanks for the update, I appreciate hearing back.\n\n' +
      'On Mon, Jan 5, 2026 at 9:00 AM Alice Smith <alice@acme.com> wrote:\n' +
      '> Unfortunately we are moving forward with other candidates.\n' +
      '> Best,\n' +
      '> Alice';
    expect(stripQuotedForwarded(input)).toBe('Thanks for the update, I appreciate hearing back.');
  });

  it('Outlook-style: residual excludes the original body even with NO > prefixes (proves the boundary rule)', () => {
    const input =
      'Got it, thank you.\n\n' +
      '-----Original Message-----\n' +
      'From: Bob Recruiter\n' +
      'Sent: Monday, January 5, 2026 9:00 AM\n' +
      'To: Jane Candidate\n' +
      'Subject: Re: Application status\n\n' +
      'We regret to inform you that we have decided to move forward with other candidates\n' +
      'at this time. We wish you the best in your job search.';
    const residual = stripQuotedForwarded(input);
    expect(residual).toBe('Got it, thank you.');
    // The original body has no `>` markers — a quote-line-only filter would leak it through.
    expect(residual).not.toContain('regret');
    expect(residual).not.toContain('Bob Recruiter');
  });

  it('bare forward as the first line yields empty residual', () => {
    expect(
      stripQuotedForwarded(
        '---------- Forwarded message ----------\nFrom: Bob\nSubject: Fwd: status\n\nSee below.'
      )
    ).toBe('');
  });

  it('a one-word comment above a quote yields that one word as the residual', () => {
    const input = 'Thoughts?\n\nOn Tue, Jan 6, 2026 at 10:00 AM Carol <c@x.com> wrote:\n> Full original text here.';
    const residual = stripQuotedForwarded(input);
    expect(residual).toBe('Thoughts?');
    expect(isNearEmptyResidual(residual, 20)).toBe(true);
  });

  it('genuine new status content above a quote is preserved and is not near-empty', () => {
    const input =
      'Unfortunately we are moving forward with other candidates.\n\n' +
      'On Wed, Jan 7, 2026 at 11:00 AM Dave <d@x.com> wrote:\n' +
      '> Any update on my application?';
    const residual = stripQuotedForwarded(input);
    expect(residual).toBe('Unfortunately we are moving forward with other candidates.');
    expect(isNearEmptyResidual(residual, 20)).toBe(false);
  });

  it('recognizes a signature delimiter (RFC 3676) as a boundary', () => {
    expect(stripQuotedForwarded('New content here.\n\n-- \nJane Doe\nSenior Engineer')).toBe(
      'New content here.'
    );
  });

  it('recognizes Begin forwarded message: as a boundary', () => {
    expect(stripQuotedForwarded('See this.\n\nBegin forwarded message:\n\nFrom: Bob\nbody')).toBe(
      'See this.'
    );
  });

  describe('over-cap fail-closed branch', () => {
    it('an input longer than MAX_QUOTE_STRIP_CODE_UNITS returns empty string, not the input', () => {
      const oversized = 'a'.repeat(MAX_QUOTE_STRIP_CODE_UNITS + 1);
      expect(stripQuotedForwarded(oversized)).toBe('');
    });

    it('an input exactly at the cap is processed normally, not treated as over-cap', () => {
      const atCap = 'x'.repeat(MAX_QUOTE_STRIP_CODE_UNITS);
      expect(stripQuotedForwarded(atCap)).toBe(atCap);
    });
  });

  describe('totality (never throws, always returns a string)', () => {
    it('a 2 MB single-line input returns a string and does not throw', () => {
      const twoMb = 'z'.repeat(2 * 1024 * 1024);
      const start = performance.now();
      let result = '';
      expect(() => {
        result = stripQuotedForwarded(twoMb);
      }).not.toThrow();
      const elapsedMs = performance.now() - start;
      expect(typeof result).toBe('string');
      // Backtracking guard, not a performance target: proves ATTRIBUTION_RE has not gone
      // quadratic against a large adversarial body.
      expect(elapsedMs).toBeLessThan(2000);
    });

    it('50,000 consecutive > characters returns a string and does not throw', () => {
      const input = '>'.repeat(50_000);
      let result = '';
      expect(() => {
        result = stripQuotedForwarded(input);
      }).not.toThrow();
      expect(typeof result).toBe('string');
    });

    it('an unterminated "On " fragment returns a string and does not throw', () => {
      let result = '';
      expect(() => {
        result = stripQuotedForwarded('On ');
      }).not.toThrow();
      expect(typeof result).toBe('string');
    });

    it('a lone "-----" returns a string and does not throw', () => {
      let result = '';
      expect(() => {
        result = stripQuotedForwarded('-----');
      }).not.toThrow();
      expect(typeof result).toBe('string');
    });

    it('10,000 alternating \\n> pairs returns a string and does not throw', () => {
      const input = '\n>'.repeat(10_000);
      let result = '';
      expect(() => {
        result = stripQuotedForwarded(input);
      }).not.toThrow();
      expect(typeof result).toBe('string');
    });

    it('a fixed-seed 200-iteration fuzz over a small pathological alphabet never throws', () => {
      // Small linear congruential generator, fixed seed 42 — deterministic, no dependency.
      let state = 42;
      const next = (): number => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state;
      };
      const alphabet = ['>', '-', '\n', 'O', 'n', 'w', 'r', 'o', 't', 'e', ':', ' '];
      for (let trial = 0; trial < 200; trial++) {
        const len = next() % 501; // 0-500 chars
        let s = '';
        for (let i = 0; i < len; i++) {
          s += alphabet[next() % alphabet.length];
        }
        let result = '';
        expect(() => {
          result = stripQuotedForwarded(s);
        }).not.toThrow();
        expect(typeof result).toBe('string');
      }
    });
  });

  describe('contract guarantees (asserted over the whole FIXTURES table)', () => {
    it.each(FIXTURES.map(f => [f.label, f.input] as const))(
      'idempotent: %s',
      (_label, input) => {
        const once = stripQuotedForwarded(input);
        const twice = stripQuotedForwarded(once);
        expect(twice).toBe(once);
      }
    );

    it.each(FIXTURES.map(f => [f.label, f.input] as const))(
      'monotone toward less content: %s',
      (_label, input) => {
        const output = stripQuotedForwarded(input);
        expect(output.length).toBeLessThanOrEqual(input.length);
      }
    );
  });
});

// ---------------------------------------------------------------------------
// isNearEmptyResidual
// ---------------------------------------------------------------------------

describe('isNearEmptyResidual', () => {
  it('empty string is near-empty', () => {
    expect(isNearEmptyResidual('', 20)).toBe(true);
  });

  it('pure whitespace is near-empty', () => {
    expect(isNearEmptyResidual('   \n\t  ', 20)).toBe(true);
  });

  it('short filler text is near-empty', () => {
    expect(isNearEmptyResidual('FYI', 20)).toBe(true);
  });

  it('substantive prose is not near-empty', () => {
    expect(
      isNearEmptyResidual('Unfortunately we are moving forward with other candidates.', 20)
    ).toBe(false);
  });

  it('counts only non-whitespace characters, not .length', () => {
    // 11 non-whitespace chars, .length is 21 — must gate on the 11, not the 21.
    const input = 'a b c d e f g h i j k';
    expect(input.length).toBe(21);
    expect(isNearEmptyResidual(input, 20)).toBe(true);
  });

  it('a threshold of 0 disables the gate — always returns false', () => {
    expect(isNearEmptyResidual('', 0)).toBe(false);
    expect(isNearEmptyResidual('anything at all', 0)).toBe(false);
    expect(isNearEmptyResidual('   ', 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mutation check (recorded manually in the SUMMARY, not asserted by this file):
// stopping only at FORWARD_MARKER_RE (dropping the ATTRIBUTION_RE and
// SIGNATURE_DELIM_RE boundaries) must fail the Gmail-style and Outlook-style
// fixtures above — see 65-02-SUMMARY.md for the recorded before/after diff and
// confirmation the suite goes red then green.
// ---------------------------------------------------------------------------
