/**
 * Unit-test scaffold for the LoCoMo scorer (BENCH-01).
 *
 * Wave 0 scaffolds — pinned before locomo-scorer.cjs is built (Plan 40-03).
 *
 * Active tests (no scorer dependency):
 *  1. locomo-mini.json fixture loads, is a 1-element array, and contains ≥1 category-5 row.
 *     This pins the fixture contract that Plan 03's scorer depends on.
 *
 * Skipped tests (depend on Plan 40-03 locomo-scorer.cjs):
 *  2. (it.skip) Scorer category-5 denominator: given a fixture with N total and K category-5
 *     rows, the J-score denominator equals N - K (adversarial excluded from scoring).
 *
 * NOTE on schema deviation found in Wave 0:
 *  RESEARCH documented LoCoMo turns as {name, dia_id, text} but actual locomo10.json uses
 *  {speaker, dia_id, text} and sessions are nested under a top-level "conversation" key.
 *  locomo-mini.json normalises this to flat top-level sessions matching the harness target.
 *  Tests check the fixture's normalised shape (flat, with "speaker" turns).
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MINI_FIXTURE_PATH = path.resolve(__dirname, '../scripts/eval/fixtures/locomo-mini.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LoCoMoTurn {
  speaker: string;
  dia_id:  string;
  text:    string;
}

interface LoCoMoQA {
  question?:            string;
  answer?:              string | number;
  adversarial_answer?:  string;
  evidence:             string[];
  category:             number;
}

interface LoCoMoConversation {
  sample_id:              string;
  speaker_a:              string;
  speaker_b:              string;
  session_1:              LoCoMoTurn[];
  session_1_date_time:    string;
  session_2?:             LoCoMoTurn[];
  session_2_date_time?:   string;
  qa:                     LoCoMoQA[];
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function loadMiniFixture(): LoCoMoConversation[] {
  const raw = fs.readFileSync(MINI_FIXTURE_PATH, 'utf8');
  return JSON.parse(raw) as LoCoMoConversation[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('locomo-scorer', () => {

  // ── Test 1 (active): Fixture contract — 1-element array with ≥1 category-5 row ─────────

  it('locomo-mini.json loads as 1-element array and contains at least one category-5 (adversarial) row', () => {
    const conversations = loadMiniFixture();

    // Must be a 1-element array (the dry-run fixture scope)
    expect(Array.isArray(conversations)).toBe(true);
    expect(conversations).toHaveLength(1);

    const conv = conversations[0];

    // Must have qa array
    expect(conv).toHaveProperty('qa');
    expect(Array.isArray(conv.qa)).toBe(true);
    expect(conv.qa.length).toBeGreaterThan(0);

    // Must have at least one category-5 (adversarial) row
    const adversarialRows = conv.qa.filter(q => q.category === 5);
    expect(adversarialRows.length).toBeGreaterThanOrEqual(1);

    // Must have at least 3 distinct non-adversarial categories (confirms fixture exercises the filter)
    const nonAdversarial = conv.qa.filter(q => q.category !== 5);
    const distinctCategories = new Set(nonAdversarial.map(q => q.category));
    expect(distinctCategories.size).toBeGreaterThanOrEqual(2);
  });

  // ── Test 2 (skipped — Plan 40-03 ships locomo-scorer.cjs): category-5 denominator ──────
  //
  // TODO(Plan 40-03): un-skip once locomo-scorer.cjs exists.
  // The scorer must: (a) skip ALL qa rows where category === 5 from both numerator and
  // denominator, (b) compute J = count(CORRECT) / count(non-adversarial).
  // Given the mini fixture (5 QA, 1 cat5), the denominator must be 4.

  it.skip('scorer denominator equals total QA minus category-5 count (Plan 40-03 gate)', () => {
    // This test will be implemented once locomo-scorer.cjs is built in Plan 40-03.
    // Expected: loadMiniFixture()[0].qa has 5 entries, 1 is category 5.
    // scorer denominator = 5 - 1 = 4.
    // J-score = (count CORRECT) / 4.
    throw new Error('TODO: implement in Plan 40-03');
  });

});
