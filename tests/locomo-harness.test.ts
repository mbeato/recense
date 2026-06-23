/**
 * Unit-test scaffold for the LoCoMo harness (BENCH-01).
 *
 * Wave 0 scaffolds — pinned before locomo-harness.cjs is built (Plan 40-02).
 *
 * Active tests (no harness dependency):
 *  1. locomo10.json + locomo-mini.json parse with the documented schema
 *     (qa[].{question,answer,evidence[],category}; session_N arrays of {speaker,dia_id,text};
 *     session_N_date_time strings; sample_id, speaker_a, speaker_b).
 *     NOTE: actual turn field is "speaker", not "name" — RESEARCH had a slight inaccuracy.
 *     The actual locomo10.json nests sessions under a top-level "conversation" key;
 *     locomo-mini.json normalises this to flat top-level sessions.
 *  2. R@K session-hit predicate (inline reference implementation):
 *     parse "D1:9" → session index 0 via parseInt(e.split(':')[0].replace('D',''))-1,
 *     build hitSessions Set, assert hit=true when retrieved-session set intersects
 *     hitSessions and hit=false otherwise.
 *
 * Skipped tests (depend on Plan 40-02 locomo-harness.cjs):
 *  3. (it.skip) spawnSync(harness.cjs, ['--dry-run','--eval',fixture]) exits 0.
 *
 * NOTE on schema deviation found in Wave 0:
 *  RESEARCH documented LoCoMo turns as {name, dia_id, text} but actual locomo10.json uses
 *  {speaker, dia_id, text} and sessions are nested under a top-level "conversation" key.
 *  The harness implementation (Plan 40-02) must accommodate this real schema.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MINI_FIXTURE_PATH  = path.resolve(__dirname, '../scripts/eval/fixtures/locomo-mini.json');
// locomo10.json is gitignored; tests that load it are conditional on its presence
const LOCOMO10_PATH = path.resolve(__dirname, '../scripts/eval/locomo10.json');
const LOCOMO10_EXISTS = fs.existsSync(LOCOMO10_PATH);

// ---------------------------------------------------------------------------
// Types (actual observed schema)
// ---------------------------------------------------------------------------

/** A single dialog turn — actual field is "speaker", not "name" per RESEARCH. */
interface LoCoMoTurn {
  speaker: string;   // e.g. "Caroline"
  dia_id:  string;   // e.g. "D1:1"
  text:    string;
}

interface LoCoMoQA {
  question?:           string;
  answer?:             string | number;
  adversarial_answer?: string;
  evidence:            string[];  // e.g. ["D1:9", "D1:11"]
  category:            number;    // 1=multi-hop,2=temporal,3=open-domain,4=single-hop,5=adversarial
}

/** Flat top-level structure (as in locomo-mini.json and the harness target format). */
interface FlatConversation {
  sample_id:              string;
  speaker_a:              string;
  speaker_b:              string;
  session_1:              LoCoMoTurn[];
  session_1_date_time:    string;
  session_2?:             LoCoMoTurn[];
  session_2_date_time?:   string;
  qa:                     LoCoMoQA[];
}

/** Nested structure as it actually appears in locomo10.json. */
interface NestedConversation {
  sample_id: string;
  conversation: {
    speaker_a: string;
    speaker_b: string;
    session_1: LoCoMoTurn[];
    session_1_date_time: string;
    [key: string]: unknown;
  };
  qa: LoCoMoQA[];
}

// ---------------------------------------------------------------------------
// R@K session-hit reference implementation (inline, no harness dependency)
// ---------------------------------------------------------------------------

/**
 * Parse a LoCoMo evidence dialog-ID to a 0-based session index.
 * "D1:9"  → parseInt("1") - 1 = 0 (session_1)
 * "D3:4"  → parseInt("3") - 1 = 2 (session_3)
 *
 * This is the reference implementation locked by Test 2 before Plan 40-02 wires
 * it to real retrieval. The harness must implement the same logic.
 */
function evidenceToSessionIdx(dialogId: string): number {
  // dialogId format: "D{N}:{turn_within_session}"
  const sessionNum = parseInt(dialogId.split(':')[0].replace('D', ''), 10);
  return sessionNum - 1; // 0-based index
}

/**
 * R@K session-level hit predicate.
 *
 * Returns true if any session index in retrievedSessionIdxs intersects
 * the hitSessions set derived from qa.evidence.
 */
function isSessionHit(
  evidenceDialogIds: string[],
  retrievedSessionIdxs: Set<number>,
): boolean {
  const hitSessions = new Set(evidenceDialogIds.map(e => evidenceToSessionIdx(e)));
  for (const s of hitSessions) {
    if (retrievedSessionIdxs.has(s)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('locomo-harness', () => {

  // ── Test 1 (active): Schema validation for locomo-mini.json ──────────────

  it('locomo-mini.json parses with documented flat schema (sample_id, speaker_a/b, session_1+date, qa[])', () => {
    const raw = fs.readFileSync(MINI_FIXTURE_PATH, 'utf8');
    const conversations = JSON.parse(raw) as FlatConversation[];

    expect(Array.isArray(conversations)).toBe(true);
    expect(conversations.length).toBeGreaterThanOrEqual(1);

    for (const conv of conversations) {
      // Top-level identity fields
      expect(typeof conv.sample_id).toBe('string');
      expect(conv.sample_id.length).toBeGreaterThan(0);
      expect(typeof conv.speaker_a).toBe('string');
      expect(conv.speaker_a.length).toBeGreaterThan(0);
      expect(typeof conv.speaker_b).toBe('string');

      // session_1 and its date_time must be present
      expect(Array.isArray(conv.session_1)).toBe(true);
      expect(conv.session_1.length).toBeGreaterThan(0);
      expect(typeof conv.session_1_date_time).toBe('string');
      expect(conv.session_1_date_time.length).toBeGreaterThan(0);

      // Each session_1 turn: {speaker, dia_id, text} — actual field is "speaker" not "name"
      for (const turn of conv.session_1) {
        expect(turn).toHaveProperty('speaker');
        expect(typeof turn.speaker).toBe('string');
        expect(turn).toHaveProperty('dia_id');
        expect(typeof turn.dia_id).toBe('string');
        expect(turn).toHaveProperty('text');
        expect(typeof turn.text).toBe('string');
      }

      // QA array structure
      expect(Array.isArray(conv.qa)).toBe(true);
      expect(conv.qa.length).toBeGreaterThan(0);

      for (const qa of conv.qa) {
        // evidence must be an array of strings
        expect(Array.isArray(qa.evidence)).toBe(true);
        for (const ev of qa.evidence) {
          expect(typeof ev).toBe('string');
          // Evidence format: "D{N}:{turn}" e.g. "D1:9"
          expect(ev).toMatch(/^D\d+:\d+$/);
        }
        // category must be an integer 1–5
        expect(typeof qa.category).toBe('number');
        expect(qa.category).toBeGreaterThanOrEqual(1);
        expect(qa.category).toBeLessThanOrEqual(5);
      }
    }
  });

  // ── Test 1b (active): Schema validation for locomo10.json (if present) ───

  (LOCOMO10_EXISTS ? it : it.skip)(
    'locomo10.json parses as 10-element array with nested "conversation" schema and 1986 QA pairs',
    () => {
      const raw = fs.readFileSync(LOCOMO10_PATH, 'utf8');
      const conversations = JSON.parse(raw) as NestedConversation[];

      expect(Array.isArray(conversations)).toBe(true);
      expect(conversations).toHaveLength(10);

      for (const conv of conversations) {
        expect(typeof conv.sample_id).toBe('string');

        // Sessions are nested under "conversation" key in the raw dataset
        expect(conv).toHaveProperty('conversation');
        expect(typeof conv.conversation.speaker_a).toBe('string');

        // session_1 must exist inside conversation
        expect(Array.isArray(conv.conversation.session_1)).toBe(true);
        expect(conv.conversation.session_1.length).toBeGreaterThan(0);

        // Turn shape: {speaker, dia_id, text} — NOT {name, dia_id, text}
        const turn = conv.conversation.session_1[0];
        expect(turn).toHaveProperty('speaker');
        expect(turn).toHaveProperty('dia_id');
        expect(turn).toHaveProperty('text');

        // QA array
        expect(Array.isArray(conv.qa)).toBe(true);
        expect(conv.qa.length).toBeGreaterThan(0);
      }

      // Total QA: 1986 (RESEARCH Item 2)
      const totalQA = conversations.reduce((sum, c) => sum + c.qa.length, 0);
      expect(totalQA).toBe(1986);
    },
  );

  // ── Test 2 (active): R@K session-hit predicate (inline reference math) ───
  //
  // Locks the hit logic before Plan 40-02 wires it to real retrieval.
  // evidenceToSessionIdx: "D1:9" → 0, "D3:4" → 2, "D10:1" → 9

  it('R@K session-hit predicate: evidenceToSessionIdx and isSessionHit behave correctly', () => {

    // ── evidenceToSessionIdx ──

    // "D1:9" → session index 0 (session_1)
    expect(evidenceToSessionIdx('D1:9')).toBe(0);
    // "D1:11" → session index 0 (same session, different turn)
    expect(evidenceToSessionIdx('D1:11')).toBe(0);
    // "D2:3" → session index 1 (session_2)
    expect(evidenceToSessionIdx('D2:3')).toBe(1);
    // "D3:4" → session index 2
    expect(evidenceToSessionIdx('D3:4')).toBe(2);
    // "D10:1" → session index 9 (session_10)
    expect(evidenceToSessionIdx('D10:1')).toBe(9);

    // ── isSessionHit ──

    // Hit: retrieved set intersects hitSessions
    // qa.evidence = ["D1:9"] → hitSessions = {0}; retrieved includes session 0 → HIT
    expect(isSessionHit(['D1:9'], new Set([0, 2]))).toBe(true);

    // Hit: evidence spans multiple sessions; retrieved covers one of them
    // qa.evidence = ["D1:9", "D2:3"] → hitSessions = {0, 1}; retrieved = {1} → HIT
    expect(isSessionHit(['D1:9', 'D2:3'], new Set([1]))).toBe(true);

    // Miss: retrieved set has no session in hitSessions
    // qa.evidence = ["D1:9"] → hitSessions = {0}; retrieved = {1, 2} → MISS
    expect(isSessionHit(['D1:9'], new Set([1, 2]))).toBe(false);

    // Miss: empty retrieved set
    expect(isSessionHit(['D1:9'], new Set())).toBe(false);

    // Edge: evidence references same session twice (different turns) → still session 0
    expect(isSessionHit(['D1:9', 'D1:11'], new Set([0]))).toBe(true);
    expect(isSessionHit(['D1:9', 'D1:11'], new Set([1]))).toBe(false);

    // At K=5: evidence in session 5 (D6:1 → idx 5); retrieved top-5 = sessions 0-4 → MISS
    expect(isSessionHit(['D6:1'], new Set([0, 1, 2, 3, 4]))).toBe(false);
    // At K=10: retrieved includes session 5 → HIT
    expect(isSessionHit(['D6:1'], new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe(true);
  });

  // ── Test 3 (active — Plan 40-02): dry-run smoke ─────────────────────────────
  //
  // spawnSync(harness.cjs, ['--dry-run', '--eval', MINI_FIXTURE_PATH]) exits 0
  // and writes one result line per scoreable QA pair (category !== 5).
  // Mini fixture has 5 QA pairs; 1 is category 5 → 4 result lines expected.

  it('harness --dry-run exits 0 and writes result lines per scoreable QA pair', () => {
    const HARNESS_PATH = path.resolve(__dirname, '../scripts/eval/locomo-harness.cjs');
    const OUT = path.join(os.tmpdir(), `locomo-dry-smoke-${Date.now()}-${process.pid}.jsonl`);

    try {
      const result = spawnSync(
        process.execPath,
        [HARNESS_PATH, '--dry-run', '--eval', MINI_FIXTURE_PATH, '--out', OUT],
        { encoding: 'utf8', cwd: path.resolve(__dirname, '..'), timeout: 30_000 },
      );

      // Must exit 0
      expect(result.status).toBe(0);
      // Must log dry-run mode
      expect(result.stdout).toContain('[dry-run]');

      // Output file must exist with result lines
      expect(fs.existsSync(OUT)).toBe(true);
      const lines = fs.readFileSync(OUT, 'utf8').split('\n').filter(l => l.trim());
      // Mini fixture: 5 QA pairs, 1 category-5 → 4 scoreable rows
      expect(lines.length).toBe(4);

      // Each result line must have required fields
      for (const line of lines) {
        const rec = JSON.parse(line) as Record<string, unknown>;
        expect(rec).toHaveProperty('sample_id');
        expect(rec).toHaveProperty('hypothesis');
        expect(rec.hypothesis).toBe('dry-run-stub-answer');
        // category 5 must never appear in output
        expect(rec.category).not.toBe(5);
      }
    } finally {
      try { fs.unlinkSync(OUT); } catch {}
    }
  });

  // ── Test 4 (active — Plan 40-02): no-flag guard exits non-zero ───────────────
  //
  // Running the harness with no mode flag must exit non-zero (T-40-03).

  it('harness exits non-zero when no mode flag is passed (--run gate)', () => {
    const HARNESS_PATH = path.resolve(__dirname, '../scripts/eval/locomo-harness.cjs');

    const result = spawnSync(
      process.execPath,
      [HARNESS_PATH],
      { encoding: 'utf8', cwd: path.resolve(__dirname, '..'), timeout: 10_000 },
    );

    expect(result.status).not.toBe(0);
    // Must print usage guidance
    expect(result.stderr).toContain('--dry-run');
  });

  // ── Structural pin: source contains category-5 skip and [Session N] tag ──────
  //
  // These structural pins ensure the harness maintains the R@K tag→hit contract
  // even after future edits. They are lightweight source inspections, not runtime.

  it('harness source contains category-5 skip guard', () => {
    const HARNESS_PATH = path.resolve(__dirname, '../scripts/eval/locomo-harness.cjs');
    const src = fs.readFileSync(HARNESS_PATH, 'utf8');
    // The scoreable filter must exclude category 5
    expect(src).toMatch(/category.*!==.*5|category.*===.*5/);
  });

  it('harness source contains [Session N] tag in formatSession (load-bearing for R@K)', () => {
    const HARNESS_PATH = path.resolve(__dirname, '../scripts/eval/locomo-harness.cjs');
    const src = fs.readFileSync(HARNESS_PATH, 'utf8');
    // The [Session N] tag is inserted by formatSession and parsed by the R@K hit logic
    expect(src).toContain('[Session ');
    // Evidence parsing must use the D-prefix dialog ID format
    expect(src).toContain("replace('D', '')");
  });

});
