/**
 * clients/telegram/tests/no-numeric-confidence.test.ts — Phase 68 Plan 03 Task 3.
 *
 * Absence proof for APPROVE-04's second half: confidence is never a programmatic
 * gate anywhere under clients/telegram/. Modeled on import-boundary.test.ts's
 * collectTsFiles walk, planted-offender block, and MIN_SCANNED_FILES
 * non-vacuousness floor.
 *
 * Confidence is categorical-only (`'high' | 'medium' | 'low'`, StoredBeliefProposal —
 * see types.ts) and is rendered as plain text at most (belief-render.ts). This test
 * scans for three numeric-confidence shapes:
 *   1. A comparison operator between `confidence` and a numeric literal (either
 *      order — `confidence > 0.7` or `0.7 < confidence`).
 *   2. A numeric coercion (`Number(`, `parseFloat(`, `parseInt(`) applied around a
 *      confidence expression.
 *   3. A `confidence:` property assigned a numeric literal (`confidence: 0.87`).
 *
 * Every planted offender below is built by string concatenation so this file
 * never contains a literal its own scan would flag (mirrors belief-poll.test.ts's
 * pid() and import-boundary.test.ts's SRC concatenation convention).
 *
 * No src/ imports — CLIENT-01 structural guard (scanned by import-boundary.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CLIENT_DIR = resolve(__dirname, '..'); // clients/telegram/

/** Every TypeScript flavor is scanned — .mts/.cts/.tsx must not escape the walk. */
const TS_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx'];

/**
 * Non-vacuousness floor (guard the guard): mirrors import-boundary.test.ts's
 * MIN_SCANNED_FILES discipline. clients/telegram/ holds well over 30 committed
 * TypeScript files as of Phase 68 Plan 03 (plus generated dist/*.d.ts when
 * built, which the walk skips). If the walk ever returns fewer than this, the
 * scan itself is broken and must fail loudly instead of passing on an empty scan.
 */
const MIN_SCANNED_FILES = 30;

/** This file's own basename — excluded from the scan so its planted-offender
 *  strings (built by concatenation specifically so they never appear as a
 *  literal a regex could match) never risk a false self-flag. */
const SELF_BASENAME = 'no-numeric-confidence.test.ts';

/** Recursively collect all TypeScript files under dir, skipping dist and this file. */
function collectTsFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectTsFiles(full));
    } else if (entry.name !== SELF_BASENAME && TS_EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
      result.push(full);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// The three regex shapes
// ---------------------------------------------------------------------------

/** Shape 1: a comparison operator between `confidence` and a numeric literal, either order. */
const COMPARISON_RE = /confidence\s*[<>]=?\s*\d+(?:\.\d+)?|confidence\s*[=!]==?\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*[<>]=?\s*confidence|\d+(?:\.\d+)?\s*[=!]==?\s*confidence/i;

/** Shape 2: a numeric coercion function applied around a confidence expression. */
const COERCION_RE = /(?:Number|parseFloat|parseInt)\s*\([^)]*confidence[^)]*\)/i;

/** Shape 3: a `confidence:` property assigned a numeric literal. */
const ASSIGNMENT_RE = /\bconfidence\s*:\s*\d+(?:\.\d+)?\b/i;

const ANY_NUMERIC_CONFIDENCE_RE = new RegExp(
  `(?:${COMPARISON_RE.source})|(?:${COERCION_RE.source})|(?:${ASSIGNMENT_RE.source})`,
  'i',
);

describe('APPROVE-04 absence proof: no numeric-confidence gate under clients/telegram/', () => {
  it('no file scans positive for any numeric-confidence shape', () => {
    const files = collectTsFiles(CLIENT_DIR);
    // Guard the guard: an empty or partial walk must fail, not pass vacuously.
    expect(files.length).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);

    const violations: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (ANY_NUMERIC_CONFIDENCE_RE.test(text)) {
        violations.push(f);
      }
    }
    expect(violations).toEqual([]);
  });

  it('the comparison regex catches its bypass form (planted offender, built by concatenation)', () => {
    const offenders = [
      'confiden' + 'ce > 0.7',
      'confiden' + 'ce >= 0.5',
      '0.3' + ' < confiden' + 'ce',
      'confiden' + 'ce === 0.8',
      'row.confiden' + 'ce > 0.9 ? approve() : reject()',
    ];
    for (const line of offenders) {
      expect(COMPARISON_RE.test(line), `should flag: ${line}`).toBe(true);
      expect(ANY_NUMERIC_CONFIDENCE_RE.test(line), `should flag: ${line}`).toBe(true);
    }
  });

  it('the coercion regex catches its bypass form (planted offender, built by concatenation)', () => {
    const offenders = [
      'Number' + '(row.confiden' + 'ce)',
      'parseFloat' + '(c.confiden' + 'ce)',
      'parseInt' + '(record.confiden' + 'ce, 10)',
    ];
    for (const line of offenders) {
      expect(COERCION_RE.test(line), `should flag: ${line}`).toBe(true);
      expect(ANY_NUMERIC_CONFIDENCE_RE.test(line), `should flag: ${line}`).toBe(true);
    }
  });

  it('the assignment regex catches its bypass form (planted offender, built by concatenation)', () => {
    const offenders = [
      'confiden' + 'ce: 0.87,',
      'confiden' + 'ce: 1,',
      '{ confiden' + 'ce: 0.42 }',
    ];
    for (const line of offenders) {
      expect(ASSIGNMENT_RE.test(line), `should flag: ${line}`).toBe(true);
      expect(ANY_NUMERIC_CONFIDENCE_RE.test(line), `should flag: ${line}`).toBe(true);
    }
  });

  it('lawful categorical strings and comparisons are NOT flagged', () => {
    const lawful = [
      "confiden" + "ce: 'high' | 'medium' | 'low';",
      "confiden" + "ce: record.confiden" + "ce,",
      "`${c.confiden" + "ce}`",
      "if (c.confiden" + "ce === 'high') { approve(); }",
      "const label = row.confiden" + "ce;",
      "REQUIRED_RECORD_KEYS = ['confiden" + "ce'];",
    ];
    for (const line of lawful) {
      expect(ANY_NUMERIC_CONFIDENCE_RE.test(line), `should NOT flag: ${line}`).toBe(false);
    }
  });
});
