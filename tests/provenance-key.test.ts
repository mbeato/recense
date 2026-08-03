/**
 * provenance-key.ts unit tests — Phase 65, Plan 65-04 (DRIFT-03).
 *
 * No DB, no clock, no provider, no adapter — plain strings and the module under test only.
 * `normalizeSenderDomain` and `deriveGmailProvenanceKey` are pure functions over plain
 * strings; this suite proves that in isolation, mirroring `tests/strip-quoted.test.ts` and
 * `tests/entity-resolution.test.ts`'s "no provider stub of any kind" honesty framing.
 *
 * Uses `DEFAULT_CONFIG.provenanceMinResidualChars` as the threshold in every case (never a
 * hardcoded `20`) so this suite tracks the shipped default.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../src/lib/config';
import {
  COLLAPSED_GMAIL_PROVENANCE_KEY,
  normalizeSenderDomain,
  deriveGmailProvenanceKey,
} from '../src/source/provenance-key';

const THRESHOLD = DEFAULT_CONFIG.provenanceMinResidualChars;

/** One synthetic Gmail message used across the suite, plus its (unused-by-the-module) Gmail
 *  message id — carried ONLY so the no-message-id-leakage loop below has something to check
 *  against. `deriveGmailProvenanceKey` never receives `messageId`; it cannot leak what it is
 *  never given, but this loop proves that at the value level anyway (mirrors the Task 1
 *  source-level grep for the same ban). */
interface MessageFixture {
  readonly label: string;
  readonly messageId: string;
  readonly fromHeader: string;
  readonly threadId: string;
  readonly bodyText: string;
  readonly minResidualChars?: number;
}

/** Every fixture defined in this file, built ONCE at module scope (not inside an `it()`
 *  callback, which would defer construction to test-execution time and leave this array
 *  empty when the leakage loop below reads it during collection) and iterated by the
 *  no-message-id-leakage loop at the bottom. */
const ALL_FIXTURES: MessageFixture[] = [];

function fixture(f: MessageFixture): MessageFixture {
  ALL_FIXTURES.push(f);
  return f;
}

function keyFor(f: MessageFixture): string {
  return deriveGmailProvenanceKey({
    fromHeader: f.fromHeader,
    threadId: f.threadId,
    bodyText: f.bodyText,
    minResidualChars: f.minResidualChars ?? THRESHOLD,
  });
}

// ---------------------------------------------------------------------------
// Fixture data — built once, at module scope, referenced by the describe blocks below.
// ---------------------------------------------------------------------------

const ORIGINAL_STATUS_TEXT =
  'We regret to inform you that your application was not successful at this time.';

function forwardBody(sender: string, body = ORIGINAL_STATUS_TEXT): string {
  return `---------- Forwarded message ----------\nFrom: ${sender}\nSubject: Fwd: status\n\n${body}`;
}

function forwardWithComment(comment: string, body = ORIGINAL_STATUS_TEXT): string {
  return `${comment}\n\n---------- Forwarded message ----------\nFrom: HR\nSubject: Fwd: status\n\n${body}`;
}

// Direction A: three genuinely independent status emails.
const DIRECTION_A = [
  fixture({
    label: 'A1 recruiter interview',
    messageId: 'gmail-msg-a1-interview',
    fromHeader: 'recruiter@acme.com',
    threadId: 'thread-1',
    bodyText: 'We would like to schedule an interview next week.',
  }),
  fixture({
    label: 'A2 rejected notice',
    messageId: 'gmail-msg-a2-rejected',
    fromHeader: 'no-reply@bigco.example',
    threadId: 'thread-2',
    bodyText: 'Your application status has been updated to rejected.',
  }),
  fixture({
    label: 'A3 moving forward notice',
    messageId: 'gmail-msg-a3-forward',
    fromHeader: 'hiring@thirdco.test',
    threadId: 'thread-3',
    bodyText: 'Unfortunately we are moving forward with other candidates.',
  }),
];

// Direction B: three forwards of ONE underlying thread, three different forwarding senders,
// three different thread ids, pure forward (no new text) below the marker.
const DIRECTION_B_FORWARD = [
  fixture({
    label: 'B1 forward (pure)',
    messageId: 'gmail-msg-b1-fwd',
    fromHeader: 'a@one.test',
    threadId: 'thread-b1',
    bodyText: forwardBody('HR <hr@acme.com>'),
  }),
  fixture({
    label: 'B2 forward (pure)',
    messageId: 'gmail-msg-b2-fwd',
    fromHeader: 'b@two.test',
    threadId: 'thread-b2',
    bodyText: forwardBody('HR <hr@acme.com>'),
  }),
  fixture({
    label: 'B3 forward (pure)',
    messageId: 'gmail-msg-b3-fwd',
    fromHeader: 'c@three.test',
    threadId: 'thread-b3',
    bodyText: forwardBody('HR <hr@acme.com>'),
  }),
];

// Direction B, quote variant: >-quoted reply chain, no new text, three different senders/threads.
const QUOTE_BODY = `> ${ORIGINAL_STATUS_TEXT}\n> Best,\n> Alice`;
const DIRECTION_B_QUOTE = [
  fixture({
    label: 'Bq1 pure quote',
    messageId: 'gmail-msg-bq1',
    fromHeader: 'd@four.test',
    threadId: 'thread-q1',
    bodyText: QUOTE_BODY,
  }),
  fixture({
    label: 'Bq2 pure quote',
    messageId: 'gmail-msg-bq2',
    fromHeader: 'e@five.test',
    threadId: 'thread-q2',
    bodyText: QUOTE_BODY,
  }),
  fixture({
    label: 'Bq3 pure quote',
    messageId: 'gmail-msg-bq3',
    fromHeader: 'f@six.test',
    threadId: 'thread-q3',
    bodyText: QUOTE_BODY,
  }),
];

// Direction B, near-miss variant: a distinct one-word comment above the marker — the residual
// is below THRESHOLD, so it still collapses (proves the threshold, not just the marker, is
// load-bearing).
const DIRECTION_B_NEAR_MISS = [
  fixture({
    label: 'Bn1 FYI',
    messageId: 'gmail-msg-bn1',
    fromHeader: 'g@seven.test',
    threadId: 'thread-n1',
    bodyText: forwardWithComment('FYI'),
  }),
  fixture({
    label: 'Bn2 see this',
    messageId: 'gmail-msg-bn2',
    fromHeader: 'h@eight.test',
    threadId: 'thread-n2',
    bodyText: forwardWithComment('see this'),
  }),
  fixture({
    label: 'Bn3 thoughts?',
    messageId: 'gmail-msg-bn3',
    fromHeader: 'i@nine.test',
    threadId: 'thread-n3',
    bodyText: forwardWithComment('thoughts?'),
  }),
];

// Direction B defeated by genuine content: 60+ characters of new commentary above the marker.
const DIRECTION_B_GENUINE = [
  fixture({
    label: 'Bg1 genuine commentary',
    messageId: 'gmail-msg-bg1',
    fromHeader: 'j@ten.test',
    threadId: 'thread-g1',
    bodyText: forwardWithComment(
      'I wanted to follow up because I have not heard anything back from your team in three weeks.'
    ),
  }),
  fixture({
    label: 'Bg2 genuine commentary',
    messageId: 'gmail-msg-bg2',
    fromHeader: 'k@eleven.test',
    threadId: 'thread-g2',
    bodyText: forwardWithComment(
      'Sharing this update with you now since it directly affects our upcoming planning meeting.'
    ),
  }),
  fixture({
    label: 'Bg3 genuine commentary',
    messageId: 'gmail-msg-bg3',
    fromHeader: 'l@twelve.test',
    threadId: 'thread-g3',
    bodyText: forwardWithComment(
      'Just noting for the record that this came in today and needs a reply from someone on our side.'
    ),
  }),
];

// Same-thread accumulation: five messages, same sender domain, same thread id, real content.
const SAME_THREAD_ACCUMULATION = [
  'We received your application and will review it shortly.',
  'Thank you for your patience while we complete the review.',
  'We would like to schedule a phone screen with you.',
  'Following up to confirm the phone screen time works for you.',
  'We appreciate your continued interest in the role.',
].map((bodyText, i) =>
  fixture({
    label: `same-thread-${i}`,
    messageId: `gmail-msg-acc-${i}`,
    fromHeader: `contact${i}@acme.com`,
    threadId: 'thread-acc',
    bodyText,
  })
);

// Same domain, different threads.
const SAME_DOMAIN_DIFFERENT_THREADS = [
  fixture({
    label: 'same-domain-thread-1',
    messageId: 'gmail-msg-sd1',
    fromHeader: 'hr@acme.com',
    threadId: 'thread-sd1',
    bodyText: 'We would like to move forward with the next round of interviews.',
  }),
  fixture({
    label: 'same-domain-thread-2',
    messageId: 'gmail-msg-sd2',
    fromHeader: 'hr@acme.com',
    threadId: 'thread-sd2',
    bodyText: 'Thanks for your patience during our review process this month.',
  }),
  fixture({
    label: 'same-domain-thread-3',
    messageId: 'gmail-msg-sd3',
    fromHeader: 'hr@acme.com',
    threadId: 'thread-sd3',
    bodyText: 'We wanted to check in on your continued interest in the role.',
  }),
];

// Different subdomains, same thread — no public-suffix collapsing.
const DIFFERENT_SUBDOMAINS = [
  fixture({
    label: 'subdomain-1',
    messageId: 'gmail-msg-sub1',
    fromHeader: 'a@mail.acme.com',
    threadId: 'thread-sub',
    bodyText: 'We would like to schedule a follow-up call about your application.',
  }),
  fixture({
    label: 'subdomain-2',
    messageId: 'gmail-msg-sub2',
    fromHeader: 'b@acme.com',
    threadId: 'thread-sub',
    bodyText: 'Thank you again for your interest in joining our team this quarter.',
  }),
];

// Adversarial From: header cases.
const REAL_STATUS_BODY = 'We would like to move forward with scheduling your interview.';
const ADVERSARIAL_ZWJ_DOMAIN = fixture({
  label: 'adversarial-zwj-domain',
  messageId: 'gmail-msg-adv-zwj',
  fromHeader: 'alice@ac‍me.com',
  threadId: 'thread-adv-1',
  bodyText: REAL_STATUS_BODY,
});
const ADVERSARIAL_RFC2047_FAKE_FIRST = fixture({
  label: 'adversarial-rfc2047-fake-first',
  messageId: 'gmail-msg-adv-rfc2047',
  fromHeader: '=?utf-8?q?Spoofed_Name?= <fake@evil.test>, Real Person <real@acme.com>',
  threadId: 'thread-adv-2',
  bodyText: REAL_STATUS_BODY,
});
const ADVERSARIAL_OVERSIZED_DOMAIN = fixture({
  label: 'adversarial-oversized-domain',
  messageId: 'gmail-msg-adv-oversized',
  fromHeader: 'a@' + 'x'.repeat(300) + '.com',
  threadId: 'thread-adv-3',
  bodyText: REAL_STATUS_BODY,
});
const ADVERSARIAL_COLON_DOMAIN = fixture({
  label: 'adversarial-colon-domain',
  messageId: 'gmail-msg-adv-colon',
  fromHeader: 'a@ac:me.com',
  threadId: 'thread-adv-4',
  bodyText: REAL_STATUS_BODY,
});

// Adversarial threadId cases.
const ADVERSARIAL_THREAD_IDS: ReadonlyArray<{ readonly label: string; readonly threadId: string }> = [
  { label: 'empty string', threadId: '' },
  { label: 'contains the key separator', threadId: 'a:b' },
  { label: 'path-traversal-shaped', threadId: '../etc' },
  { label: '200-char id (over the 64-char bound)', threadId: 'a'.repeat(200) },
];
const ADVERSARIAL_THREAD_ID_FIXTURES = ADVERSARIAL_THREAD_IDS.map((c, i) =>
  fixture({
    label: `adversarial-threadid-${i}`,
    messageId: `gmail-msg-adv-tid-${i}`,
    fromHeader: 'a@acme.com',
    threadId: c.threadId,
    bodyText: REAL_STATUS_BODY,
  })
);
const ADVERSARIAL_THREAD_ID_VALID_HEX = fixture({
  label: 'adversarial-threadid-valid-hex',
  messageId: 'gmail-msg-adv-tid-valid',
  fromHeader: 'a@acme.com',
  threadId: '18c3f2a91b4d5e6f',
  bodyText: REAL_STATUS_BODY,
});

// ---------------------------------------------------------------------------
// normalizeSenderDomain
// ---------------------------------------------------------------------------

describe('normalizeSenderDomain', () => {
  it('extracts the domain from a bracketed address with a display name, lowercased', () => {
    expect(normalizeSenderDomain('"Alice Smith" <alice@Acme.COM>')).toBe('acme.com');
  });

  it('extracts a multi-label subdomain with no public-suffix collapsing', () => {
    expect(normalizeSenderDomain('bob@sub.example.co.uk')).toBe('sub.example.co.uk');
  });

  it('returns null when there is no @ to extract a domain from', () => {
    expect(normalizeSenderDomain('no-angle-brackets-here')).toBeNull();
  });

  it('returns null for an empty header', () => {
    expect(normalizeSenderDomain('')).toBeNull();
  });

  it('a multi-address From: is malformed but does not throw — the first address wins', () => {
    expect(normalizeSenderDomain('Weird <a@b>, Second <c@d.com>')).toBe('b');
  });

  it('strips invisible codepoints from the domain before parsing (zero-width joiner)', () => {
    // U+200D ZERO WIDTH JOINER inside the domain must not fragment the parse.
    expect(normalizeSenderDomain('alice@ac‍me.com')).toBe('acme.com');
  });

  it('removes exactly one trailing FQDN dot', () => {
    expect(normalizeSenderDomain('a@ACME.com.')).toBe('acme.com');
  });

  it('rejects a domain over the 253-char DNS bound rather than truncating', () => {
    expect(normalizeSenderDomain('a@' + 'x'.repeat(300) + '.com')).toBeNull();
  });

  it('rejects a domain containing a space', () => {
    expect(normalizeSenderDomain('a@acme .com')).toBeNull();
  });

  it('rejects a domain containing a colon', () => {
    expect(normalizeSenderDomain('a@ac:me.com')).toBeNull();
  });

  it('purity: two identical calls return identical results', () => {
    const a = normalizeSenderDomain('"Alice" <alice@acme.com>');
    const b = normalizeSenderDomain('"Alice" <alice@acme.com>');
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// deriveGmailProvenanceKey
// ---------------------------------------------------------------------------

describe('deriveGmailProvenanceKey', () => {
  it('composes ingest:gmail:<domain>:<threadId> for genuinely new content', () => {
    const key = deriveGmailProvenanceKey({
      fromHeader: 'a@acme.com',
      threadId: 'abc123',
      bodyText: 'We are moving forward with other candidates.',
      minResidualChars: THRESHOLD,
    });
    expect(key).toBe('ingest:gmail:acme.com:abc123');
  });

  it('collapses when the body is pure quotation (no independent residual)', () => {
    const key = deriveGmailProvenanceKey({
      fromHeader: 'a@acme.com',
      threadId: 'abc123',
      bodyText: '> quoted only\n> nothing new',
      minResidualChars: THRESHOLD,
    });
    expect(key).toBe(COLLAPSED_GMAIL_PROVENANCE_KEY);
  });

  it('collapses when threadId is empty', () => {
    const key = deriveGmailProvenanceKey({
      fromHeader: 'a@acme.com',
      threadId: '',
      bodyText: 'We are moving forward with other candidates.',
      minResidualChars: THRESHOLD,
    });
    expect(key).toBe(COLLAPSED_GMAIL_PROVENANCE_KEY);
  });

  it('collapses when fromHeader yields no domain', () => {
    const key = deriveGmailProvenanceKey({
      fromHeader: 'garbage',
      threadId: 'abc123',
      bodyText: 'We are moving forward with other candidates.',
      minResidualChars: THRESHOLD,
    });
    expect(key).toBe(COLLAPSED_GMAIL_PROVENANCE_KEY);
  });

  it('collapses when threadId is outside the safe charset', () => {
    const key = deriveGmailProvenanceKey({
      fromHeader: 'a@acme.com',
      threadId: 'ab/c 123',
      bodyText: 'We are moving forward with other candidates.',
      minResidualChars: THRESHOLD,
    });
    expect(key).toBe(COLLAPSED_GMAIL_PROVENANCE_KEY);
  });

  it('never contains a raw Gmail message id or external_id', () => {
    const key = deriveGmailProvenanceKey({
      fromHeader: 'a@acme.com',
      threadId: 'abc123',
      bodyText: 'We are moving forward with other candidates.',
      minResidualChars: THRESHOLD,
    });
    expect(key).not.toContain('18c3f2a91b4d5e6f9999'); // a plausible Gmail message id shape
  });

  it('purity: calling twice on the same input returns the identical string', () => {
    const input = {
      fromHeader: 'a@acme.com',
      threadId: 'abc123',
      bodyText: 'We are moving forward with other candidates.',
      minResidualChars: THRESHOLD,
    };
    expect(deriveGmailProvenanceKey(input)).toBe(deriveGmailProvenanceKey(input));
  });
});

// ---------------------------------------------------------------------------
// DRIFT-03 locked pair (D-07)
//
// These two assertions (Direction A, Direction B) ARE requirement DRIFT-03's success
// criterion 3 as written in ROADMAP.md. Both directions are first-class success criteria,
// not hardening: Direction A's failure means the differentiator ("email earns confidence
// through consolidation volume") is mathematically unreachable — countDistinctProvenance can
// never exceed 1 on Gmail-only evidence. Direction B's failure means a single manipulated
// email, forwarded three times through three different senders, can force-destabilize a
// belief off duplicated content (research Pitfall 3's farming vector). Weakening either
// direction silently reopens Pitfall 3. REVIEW-BLOCKING.
// ---------------------------------------------------------------------------

describe('DRIFT-03 locked pair (D-07)', () => {
  it('Direction A: three genuinely independent status emails derive three DISTINCT keys', () => {
    const keys = DIRECTION_A.map(keyFor);
    expect(new Set(keys).size).toBe(3);
  });

  it('Direction B: three forwards of ONE thread, three different forwarding senders and thread ids, derive ONE collapsed key', () => {
    const keys = DIRECTION_B_FORWARD.map(keyFor);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(COLLAPSED_GMAIL_PROVENANCE_KEY);
  });

  it('Direction B, quote variant: a >-quoted reply chain with no new text also collapses to ONE key', () => {
    const keys = DIRECTION_B_QUOTE.map(keyFor);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(COLLAPSED_GMAIL_PROVENANCE_KEY);
  });

  it('Direction B, near-miss: a distinct one-word comment above the marker still collapses to ONE key (proves the threshold, not just the marker, is load-bearing)', () => {
    const keys = DIRECTION_B_NEAR_MISS.map(keyFor);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(COLLAPSED_GMAIL_PROVENANCE_KEY);
  });

  it('threshold 0 flips the near-miss variant to three distinct keys (proves the threshold is the deciding factor, not an unrelated cause)', () => {
    const collapsedKeys = DIRECTION_B_NEAR_MISS.map(keyFor);
    expect(new Set(collapsedKeys).size).toBe(1);
    const flippedKeys = DIRECTION_B_NEAR_MISS.map((f) =>
      deriveGmailProvenanceKey({
        fromHeader: f.fromHeader,
        threadId: f.threadId,
        bodyText: f.bodyText,
        minResidualChars: 0,
      })
    );
    expect(new Set(flippedKeys).size).toBe(3);
  });

  it('Direction B defeated by genuine content: 60+ characters of new commentary above the marker escapes the collapse — three distinct keys', () => {
    const keys = DIRECTION_B_GENUINE.map(keyFor);
    expect(new Set(keys).size).toBe(3);
  });

  it('same-thread accumulation: five messages, same sender domain, same thread id, real content → ONE distinct key', () => {
    const keys = SAME_THREAD_ACCUMULATION.map(keyFor);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('ingest:gmail:acme.com:thread-acc');
  });

  it('same domain, different threads: thread lineage is a key component, not just sender', () => {
    const keys = SAME_DOMAIN_DIFFERENT_THREADS.map(keyFor);
    expect(new Set(keys).size).toBe(3);
  });

  it('different subdomains, same thread: no public-suffix collapsing — two distinct keys', () => {
    const keys = DIFFERENT_SUBDOMAINS.map(keyFor);
    expect(new Set(keys).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Adversarial From: header handling
// ---------------------------------------------------------------------------

describe('adversarial From: header handling', () => {
  it('an invisible codepoint inside the domain does not fragment the parse', () => {
    expect(keyFor(ADVERSARIAL_ZWJ_DOMAIN)).toBe('ingest:gmail:acme.com:thread-adv-1');
  });

  it('an RFC 2047 encoded-word display name with a fake address before the real one: first bracket wins (pinned semantics, not a defense)', () => {
    expect(normalizeSenderDomain(ADVERSARIAL_RFC2047_FAKE_FIRST.fromHeader)).toBe('evil.test');
    expect(keyFor(ADVERSARIAL_RFC2047_FAKE_FIRST)).toBe('ingest:gmail:evil.test:thread-adv-2');
  });

  it('a 300-char domain collapses (over the DNS bound)', () => {
    expect(keyFor(ADVERSARIAL_OVERSIZED_DOMAIN)).toBe(COLLAPSED_GMAIL_PROVENANCE_KEY);
  });

  it('a domain containing a colon collapses (colon is the key separator)', () => {
    expect(keyFor(ADVERSARIAL_COLON_DOMAIN)).toBe(COLLAPSED_GMAIL_PROVENANCE_KEY);
  });
});

// ---------------------------------------------------------------------------
// Adversarial threadId handling
// ---------------------------------------------------------------------------

describe('adversarial threadId handling', () => {
  it.each(ADVERSARIAL_THREAD_IDS.map((c, i) => [c.label, ADVERSARIAL_THREAD_ID_FIXTURES[i]!] as const))(
    '%s → collapses',
    (_label, f) => {
      expect(keyFor(f)).toBe(COLLAPSED_GMAIL_PROVENANCE_KEY);
    }
  );

  it('a valid 16-char hex thread id composes normally', () => {
    expect(keyFor(ADVERSARIAL_THREAD_ID_VALID_HEX)).toBe('ingest:gmail:acme.com:18c3f2a91b4d5e6f');
  });
});

// ---------------------------------------------------------------------------
// No message id leakage — the "dangerous shortcuts" ban, enforced at the value level
// (complements the Task 1 source-level grep for external_id/messageId/raw.id). The fixture
// list is built once above and iterated here, not a second independently-maintained list.
// ---------------------------------------------------------------------------

describe('no message id leakage', () => {
  it.each(ALL_FIXTURES.map((f) => [f.label, f] as const))(
    'derived key for fixture "%s" does not contain its Gmail message id',
    (_label, f) => {
      expect(keyFor(f)).not.toContain(f.messageId);
    }
  );

  it('the fixture list is non-trivial (guards against a vacuous loop)', () => {
    expect(ALL_FIXTURES.length).toBeGreaterThan(15);
  });
});
