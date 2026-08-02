/**
 * CLASSIFY-04 structural guard: no ATS/job-board sender-domain fingerprint table anywhere
 * under src/.
 *
 * WHY this matters (D-03): a sender-domain -> verdict mapping degrades silently, because
 * employers frequently whitelabel their ATS mail onto their own verified domains
 * (Greenhouse/Lever/Workday etc. mail arriving from "careers.acme.com", not the vendor's
 * own domain). A hardcoded fingerprint table would look correct in review and then quietly
 * stop matching real mail as whitelabeling spreads — and it would give the model false
 * confidence in whichever cases DID still match. Sender domain may only reach the model as
 * prose inside the classification prompt (a weak-prior caveat sentence), never as a lookup
 * table in config or code. This test is the shipped, non-vacuous enforcement of that rule —
 * closing CLASSIFY-04's "no fingerprint table" clause with code, not just review discipline.
 *
 * Shape mirrors tests/src-import-boundary.test.ts: exported pure predicate, a real src/ walk
 * asserting [], and a non-vacuousness check that plants a synthetic offender through the SAME
 * predicate (so the guard cannot pass by having a real bug in an unused copy).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC_DIR = resolve(__dirname, '..', 'src');

/** Recursively collect all .ts files under dir. */
function collectTsFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      result.push(full);
    }
  }
  return result;
}

/**
 * Known ATS/job-board vendor domain tokens (D-03). Exported so the non-vacuousness test below
 * plants offenders drawn from the SAME list the real predicate checks — two independently
 * maintained lists would be the exact duplication defect this guard exists to prevent.
 */
export const ATS_DOMAIN_TOKENS: readonly string[] = [
  'greenhouse.io',
  'lever.co',
  'myworkday.com',
  'ashbyhq.com',
  'workable.com',
  'smartrecruiters.com',
  'icims.com',
  'taleo.net',
  'jobvite.com',
  'breezy.hr',
  'linkedin.com/jobs',
];

/**
 * Returns offender descriptions for files whose text contains a case-insensitive match for
 * any known ATS/job-board vendor domain token, or [] if clean.
 *
 * Flags the fingerprint TABLE (a domain literal in code), not the concept — prose describing
 * "applicant tracking systems" or "whitelabeled domains" without a literal vendor domain is
 * explicitly allowed (D-03 permits the weak-prior caveat in the classification prompt).
 */
export function findAtsDomainOffenders(files: Array<{ path: string; text: string }>): string[] {
  const offenders: string[] = [];
  for (const { path, text } of files) {
    const lower = text.toLowerCase();
    for (const token of ATS_DOMAIN_TOKENS) {
      if (lower.includes(token.toLowerCase())) {
        offenders.push(`${path}: contains ATS domain literal "${token}"`);
      }
    }
  }
  return offenders;
}

describe('CLASSIFY-04 no-ATS-domain-fingerprint-table guard', () => {
  it('no file under src/ contains a known ATS/job-board vendor domain literal', () => {
    const files = collectTsFiles(SRC_DIR).map((path) => ({
      path,
      text: readFileSync(path, 'utf8'),
    }));
    const offenders = findAtsDomainOffenders(files);
    expect(offenders).toEqual([]);
  });

  it('is not vacuous: the same predicate flags a synthetic file planting one offender', () => {
    const offenders = findAtsDomainOffenders([
      {
        path: 'src/source/__synthetic-ats-fingerprint-table.ts',
        text: "const ATS_SENDERS = { greenhouse: 'greenhouse.io', lever: 'lever.co' };",
      },
    ]);
    expect(offenders.length).toBeGreaterThan(0);
  });

  it('allows ATS-concept prose with no domain literal (D-03 permits the weak-prior caveat)', () => {
    const offenders = findAtsDomainOffenders([
      {
        path: 'src/source/__synthetic-prose-only.ts',
        text:
          "// Applicant-tracking systems frequently whitelabel their mail onto the employer's " +
          "own domain, so sender domain must never decide a verdict on its own.",
      },
    ]);
    expect(offenders).toEqual([]);
  });
});
