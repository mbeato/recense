/**
 * DRIFT-05 harness smoke test (Phase 65, Plan 65-10).
 *
 * This suite validates the harness's SHAPE and its dry path only — the actual DRIFT-05
 * numbers (real belief-correction accuracy, real provenance-key distinctness against a real
 * multi-inbox export) come from a human-run pass recorded in the phase SUMMARY (Task 3's
 * checkpoint). A green run of this suite is NOT evidence that measurement was performed;
 * it is evidence that the case file is well-formed, pinned to the real derivation, and that
 * the .cjs harness runs end to end with zero network in --dry-run mode.
 *
 * Covers:
 *  1. Case file schema: >=12 cases, all eight required fields with correct types, unique
 *     case_id, every scenario value one of the seven allowed strings.
 *  2. Synthetic-domain guard: every `from` value in every message uses a `.test` or
 *     `.example` domain — no real correspondent is committed (T-65-10-PII).
 *  3. Case-file-versus-derivation consistency: every case's `expected_distinct_provenance`
 *     is recomputed from the REAL `deriveGmailProvenanceKey` (imported from `src/`, not
 *     `dist/`) over that case's messages at the default `provenanceMinResidualChars`
 *     threshold — the case file cannot silently drift away from the shipped derivation.
 *  4. `spawnSync`-ing the compiled harness with `--dry-run` exits 0, writes a JSON file with
 *     the three top-level sections, and the `methodology` block carries the no-external-bar
 *     sentence plus all six Phase 65 config values.
 *  5. The harness exits non-zero with a non-empty stderr message when `--cases` points at a
 *     nonexistent file.
 *  6. The dry path succeeds with `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` deleted from the child
 *     environment — the zero-network claim is enforced, not assumed.
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { spawnSync } from 'child_process';
import { describe, it, expect } from 'vitest';
import { deriveGmailProvenanceKey } from '../src/source/provenance-key';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { hasDistEntries, distSkipReason } from './support/dist-build';

// ── Constants ─────────────────────────────────────────────────────────────────

const CASES_PATH = resolve(__dirname, '../scripts/eval/cases/drift-05-cases.json');
const HARNESS_PATH = resolve(__dirname, '../scripts/eval/drift-05-dry-run.cjs');
const REPO_ROOT = resolve(__dirname, '..');

// Test 4 below spawns drift-05-dry-run.cjs, which requires dist/src/source/provenance-key et
// al at module load; pretest builds dist/ for `npm test`, but a bare `vitest run` in a fresh
// worktree does not. Test 5 (missing --cases file) is NOT gated: its assertions (non-zero
// exit, non-empty stderr) hold whether the harness fails on the missing --cases arg or on a
// missing-dist require crash, so it already passes on an unbuilt tree.
const DIST_ENTRIES = ['dist/src/source/provenance-key.js'];
const SKIP_NO_DIST = !hasDistEntries(...DIST_ENTRIES);

const REQUIRED_FIELDS = [
  'case_id', 'scenario', 'requirement', 'initial_status_fact',
  'messages', 'expected_outcome', 'expected_distinct_provenance', 'rationale',
] as const;

const ALLOWED_SCENARIOS = new Set([
  'hold-single-ambiguous', 'release-three-independent', 'forward-farm', 'quote-farm',
  'out-of-order', 'chronological-control', 'undated',
]);

const ALLOWED_OUTCOMES = new Set(['hold', 'corrected', 'unchanged']);

const SYNTHETIC_DOMAIN_RE = /@[^@>\s]+\.(test|example)$/;

interface DriftCase {
  case_id: string;
  scenario: string;
  requirement: string;
  initial_status_fact: string;
  messages: Array<{
    from: string;
    thread_id: string;
    date: string;
    body: string;
    intent_confidence: 'high' | 'medium' | 'low';
  }>;
  expected_outcome: string;
  expected_distinct_provenance: number;
  rationale: string;
}

function loadCases(): DriftCase[] {
  return JSON.parse(readFileSync(CASES_PATH, 'utf8')) as DriftCase[];
}

// ── Test 1: case file schema validation ────────────────────────────────────────

describe('DRIFT-05 harness smoke tests', () => {
  describe('Test 1: drift-05-cases.json schema validation', () => {
    it('loads, contains at least 12 cases, and every case has all eight required fields', () => {
      const cases = loadCases();
      expect(Array.isArray(cases)).toBe(true);
      expect(cases.length).toBeGreaterThanOrEqual(12);

      for (const c of cases as unknown as Record<string, unknown>[]) {
        for (const field of REQUIRED_FIELDS) {
          expect(c, `case missing field "${field}"`).toHaveProperty(field);
        }
      }
    });

    it('has unique case_id values', () => {
      const cases = loadCases();
      const ids = cases.map(c => c.case_id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('has every scenario value one of the seven allowed strings, all seven represented', () => {
      const cases = loadCases();
      for (const c of cases) {
        expect(ALLOWED_SCENARIOS.has(c.scenario), `unexpected scenario "${c.scenario}"`).toBe(true);
      }
      const seen = new Set(cases.map(c => c.scenario));
      for (const scenario of ALLOWED_SCENARIOS) {
        expect(seen.has(scenario), `scenario "${scenario}" never appears in the case file`).toBe(true);
      }
    });

    it('has expected_outcome one of hold/corrected/unchanged for every case', () => {
      const cases = loadCases();
      for (const c of cases) {
        expect(ALLOWED_OUTCOMES.has(c.expected_outcome), `case ${c.case_id} has invalid expected_outcome`).toBe(true);
      }
    });

    it('has correct field types on every message (from, thread_id, date, body, intent_confidence)', () => {
      const cases = loadCases();
      for (const c of cases) {
        expect(Array.isArray(c.messages), `case ${c.case_id} messages must be an array`).toBe(true);
        expect(c.messages.length).toBeGreaterThan(0);
        for (const m of c.messages) {
          expect(typeof m.from).toBe('string');
          expect(typeof m.thread_id).toBe('string');
          expect(typeof m.date).toBe('string');
          expect(typeof m.body).toBe('string');
          expect(['high', 'medium', 'low']).toContain(m.intent_confidence);
        }
      }
    });
  });

  // ── Test 2: synthetic-domain guard ────────────────────────────────────────────

  describe('Test 2: synthetic-domain guard (T-65-10-PII)', () => {
    it('every `from` value in every message uses a .test or .example domain', () => {
      const cases = loadCases();
      for (const c of cases) {
        for (const m of c.messages) {
          expect(
            SYNTHETIC_DOMAIN_RE.test(m.from),
            `case ${c.case_id} message from "${m.from}" is not a .test/.example domain`,
          ).toBe(true);
        }
      }
    });
  });

  // ── Test 3: case-file-versus-derivation consistency ───────────────────────────

  describe('Test 3: case-file-versus-derivation consistency (T-65-10-DRIFTCASE)', () => {
    it("every case's expected_distinct_provenance matches the REAL deriveGmailProvenanceKey at the default threshold", () => {
      const cases = loadCases();
      for (const c of cases) {
        const keys = new Set(
          c.messages.map(m => deriveGmailProvenanceKey({
            fromHeader: m.from,
            threadId: m.thread_id,
            bodyText: m.body,
            minResidualChars: DEFAULT_CONFIG.provenanceMinResidualChars,
          })),
        );
        // If this fails, FIX THE CASE FILE, not this assertion — the case file must never
        // drift away from the shipped derivation (T-65-10-DRIFTCASE).
        expect(
          keys.size,
          `case ${c.case_id}: expected_distinct_provenance=${c.expected_distinct_provenance} but the real derivation produced ${keys.size} distinct key(s)`,
        ).toBe(c.expected_distinct_provenance);
      }
    });
  });

  // ── Test 4: spawnSync dry-run invocation ──────────────────────────────────────

  describe('Test 4: --dry-run invocation (spawnSync, zero network)', () => {
    it.skipIf(SKIP_NO_DIST)(
      `exits 0, produces a JSON file with the three top-level sections, and the methodology block is honest${SKIP_NO_DIST ? ` [${distSkipReason(...DIST_ENTRIES)}]` : ''}`,
      () => {
      const outPath = resolve(REPO_ROOT, `scripts/eval/results/drift-05-smoke-${process.pid}.json`);
      // ANTHROPIC_API_KEY / OPENAI_API_KEY deliberately DELETED from the child env — the
      // zero-network claim is enforced here, not assumed.
      const childEnv = { ...process.env };
      delete childEnv.ANTHROPIC_API_KEY;
      delete childEnv.OPENAI_API_KEY;

      const result = spawnSync(
        process.execPath,
        [HARNESS_PATH, '--dry-run', '--out', outPath],
        { encoding: 'utf8', cwd: REPO_ROOT, env: childEnv, timeout: 60_000 },
      );

      try {
        expect(result.status, `harness stderr: ${result.stderr}`).toBe(0);

        const written = JSON.parse(readFileSync(outPath, 'utf8'));
        expect(written).toHaveProperty('provenance_distinctness');
        expect(written).toHaveProperty('belief_correction');
        expect(written).toHaveProperty('methodology');

        expect(written.belief_correction.provider).toBe('mock');

        expect(written.methodology.no_external_bar).toContain(
          'no external accuracy bar exists for this feature class',
        );
        const configUsedKeys = Object.keys(written.methodology.config_used);
        for (const key of [
          'contradictionNBySource',
          'provenanceDistinctnessEnabled',
          'provenanceMinResidualChars',
          'statusDriftEnabled',
          'statusDriftConfidenceDamping',
          'statusDriftEventTsGuard',
        ]) {
          expect(configUsedKeys, `methodology.config_used missing "${key}"`).toContain(key);
        }

        // Residual sweep reports a distinct-key count for each of the three default thresholds.
        expect(Object.keys(written.provenance_distinctness.residual_sweep_by_threshold).sort())
          .toEqual(['10', '20', '30']);
      } finally {
        try { require('fs').unlinkSync(outPath); } catch { /* best-effort cleanup */ }
      }
    });
  });

  // ── Test 5: missing --cases file ──────────────────────────────────────────────

  describe('Test 5: missing --cases file', () => {
    it('exits non-zero with a non-empty stderr message', () => {
      const childEnv = { ...process.env };
      delete childEnv.ANTHROPIC_API_KEY;
      delete childEnv.OPENAI_API_KEY;

      const result = spawnSync(
        process.execPath,
        [
          HARNESS_PATH, '--dry-run',
          '--cases', resolve(REPO_ROOT, 'scripts/eval/cases/does-not-exist-drift05.json'),
          '--out', resolve(REPO_ROOT, `scripts/eval/results/drift-05-smoke-missing-${process.pid}.json`),
        ],
        { encoding: 'utf8', cwd: REPO_ROOT, env: childEnv, timeout: 30_000 },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    });
  });
});
