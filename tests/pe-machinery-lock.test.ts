/**
 * DRIFT-01 structural lock: the PE gate's machinery and the schema's column set are pinned.
 *
 * This test is the executable form of DRIFT-01 ("no new data model, no bi-temporal or
 * supersedes-chain columns, machinery unmodified") and of CONTEXT D-08 ("routeContradiction,
 * isOscillation, and the band thresholds are NOT modified"). It is expected to fail loudly
 * on any future attempt to modify the PE gate or add bi-temporal columns — that failure is
 * the intended signal, not a flaky test.
 *
 * If this test fails: DRIFT-01 forbids modifying routeContradiction/isOscillation or adding
 * a bi-temporal/supersedes column in this phase. If a later milestone genuinely needs to
 * change one of the pinned functions, update the pinned constant in the SAME commit as the
 * change and record the rationale in that commit message — do not delete this test.
 *
 * Shape mirrors tests/no-ats-domain-table.test.ts and tests/src-import-boundary.test.ts:
 * exported pure helpers, a real check against the live source/schema, and a non-vacuousness
 * check that plants a synthetic offender through the SAME helper.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { initSchema } from '../src/db/schema';
import { DEFAULT_CONFIG } from '../src/lib/config';

const UPDATE_DECISION_PATH = resolve(__dirname, '..', 'src', 'consolidation', 'update-decision.ts');

// ---------------------------------------------------------------------------
// Source pin — normalized function body extraction
// ---------------------------------------------------------------------------

/**
 * Extract `export function <fnName>(...)  { ... }`'s body from `source`, normalized:
 * comments (// and block) stripped, whitespace runs collapsed to a single space, trimmed.
 *
 * The pin is deliberately over the NORMALIZED body, not a hash of the file: comment and
 * formatting changes stay free, semantic edits do not.
 */
export function normalizedFunctionBody(source: string, fnName: string): string {
  const marker = `export function ${fnName}(`;
  const startIdx = source.indexOf(marker);
  if (startIdx === -1) {
    throw new Error(`normalizedFunctionBody: function "${fnName}" not found in source`);
  }
  // Walk past the parameter list (balanced parens), starting just after the marker's '('.
  let i = startIdx + marker.length;
  let parenDepth = 1;
  while (parenDepth > 0) {
    if (source[i] === '(') parenDepth++;
    else if (source[i] === ')') parenDepth--;
    i++;
  }
  // Scan forward to the function body's opening brace (past any return-type annotation).
  while (source[i] !== '{') i++;
  const bodyStart = i;
  let braceDepth = 0;
  let j = bodyStart;
  do {
    if (source[j] === '{') braceDepth++;
    else if (source[j] === '}') braceDepth--;
    j++;
  } while (braceDepth > 0);
  const bodyEnd = j; // one past the closing brace
  let body = source.slice(bodyStart, bodyEnd);
  body = body.replace(/\/\*[\s\S]*?\*\//g, ' '); // block comments
  body = body.replace(/\/\/.*$/gm, ' ');          // line comments
  body = body.replace(/\s+/g, ' ').trim();        // collapse whitespace
  return body;
}

// Pinned expected normalized bodies — computed once from the shipped source at the time
// this lock was written (Plan 65-07). Re-derive with normalizedFunctionBody if a later
// milestone legitimately changes either function, and record why in the same commit.
const PINNED_ROUTE_CONTRADICTION_BODY =
  "{ const ratio = peMagnitude / Math.max(resistance, EPS); if (ratio < config.peReconcileBandLow) return 'hold'; if (ratio < config.peReconcileBandHigh) return 'reconcile'; if (resistance < config.peAppendNewMinResistance) return 'reconcile'; return 'append-new'; }";

const PINNED_IS_OSCILLATION_BODY =
  '{ if (prevValue === null) return false; return normalizeValue(newValue) === normalizeValue(prevValue); }';

// ---------------------------------------------------------------------------
// Schema pin — bi-temporal / supersedes-chain token ban
// ---------------------------------------------------------------------------

/**
 * Token names that would signal a bi-temporal validity or supersedes-chain data model
 * (CONTEXT D-12, v9.0 DEFER). None of these may appear as a column name on node, edge, or
 * episode — the v9.0 tombstone-always model stands; this phase does not reopen it.
 */
export const BITEMPORAL_TOKENS: readonly string[] = [
  'valid_from',
  'valid_to',
  'supersedes',
  'superseded_by',
  'asserted_at',
  'effective_at',
  'tx_time',
  'valid_time',
];

/** Returns the subset of `columns` that match a bi-temporal/supersedes token, or [] if clean. */
export function findBitemporalTokenViolations(columns: readonly string[]): string[] {
  const columnSet = new Set(columns);
  return BITEMPORAL_TOKENS.filter((token) => columnSet.has(token));
}

// Pinned exact column sets for node and edge — these tables may NOT gain any column this
// phase (only `episode` is permitted a nullable provenance sidecar, and only under the
// FALLBACK verdict — this milestone's VERDICT is PRIMARY, so `episode` is unchanged too;
// pinning it against the token list only, not an exact set, keeps the guard correct under
// either verdict without re-deriving it per plan).
const PINNED_NODE_COLUMNS = [
  'id', 'type', 'value', 'value_hash', 'embedding', 'embedded_hash', 'origin', 's', 'c',
  'last_access', 'prev_value', 'prev_ts', 'pending_contradictions', 'tombstoned',
  'training_eligible',
];
const PINNED_EDGE_COLUMNS = ['src', 'dst', 'rel', 'w', 'last_access', 'kind'];

describe('DRIFT-01 machinery lock (D-08)', () => {
  describe('source pin — routeContradiction and isOscillation are byte-unmodified (normalized)', () => {
    const liveSource = readFileSync(UPDATE_DECISION_PATH, 'utf8');

    it('routeContradiction matches its pinned normalized body', () => {
      const actual = normalizedFunctionBody(liveSource, 'routeContradiction');
      expect(actual).toBe(PINNED_ROUTE_CONTRADICTION_BODY);
    });

    it('isOscillation matches its pinned normalized body', () => {
      const actual = normalizedFunctionBody(liveSource, 'isOscillation');
      expect(actual).toBe(PINNED_IS_OSCILLATION_BODY);
    });

    it('non-vacuousness: a synthetic routeContradiction with one comparison flipped does NOT match the pin', () => {
      const mutated = liveSource.replace(
        'if (ratio < config.peReconcileBandLow) return',
        'if (ratio <= config.peReconcileBandLow) return',
      );
      expect(mutated).not.toBe(liveSource); // guard the replace actually matched something
      const actual = normalizedFunctionBody(mutated, 'routeContradiction');
      expect(actual).not.toBe(PINNED_ROUTE_CONTRADICTION_BODY);
    });

    it('comment/whitespace changes stay free: a synthetic source with an added comment still matches the pin', () => {
      const withComment = liveSource.replace(
        'export function routeContradiction(',
        '// a harmless clarifying comment\nexport function routeContradiction(',
      );
      const actual = normalizedFunctionBody(withComment, 'routeContradiction');
      expect(actual).toBe(PINNED_ROUTE_CONTRADICTION_BODY);
    });
  });

  describe('schema pin — node/edge exact column sets; node/edge/episode bi-temporal token ban', () => {
    function freshDb(): Database.Database {
      const db = new Database(':memory:');
      initSchema(db);
      return db;
    }

    it('node table column set equals the pinned exact set', () => {
      const db = freshDb();
      try {
        const columns = (db.pragma('table_info(node)') as Array<{ name: string }>).map((r) => r.name);
        expect(columns.sort()).toEqual([...PINNED_NODE_COLUMNS].sort());
      } finally {
        db.close();
      }
    });

    it('edge table column set equals the pinned exact set', () => {
      const db = freshDb();
      try {
        const columns = (db.pragma('table_info(edge)') as Array<{ name: string }>).map((r) => r.name);
        expect(columns.sort()).toEqual([...PINNED_EDGE_COLUMNS].sort());
      } finally {
        db.close();
      }
    });

    it('node, edge, and episode column sets contain zero bi-temporal/supersedes tokens', () => {
      const db = freshDb();
      try {
        const nodeCols = (db.pragma('table_info(node)') as Array<{ name: string }>).map((r) => r.name);
        const edgeCols = (db.pragma('table_info(edge)') as Array<{ name: string }>).map((r) => r.name);
        const episodeCols = (db.pragma('table_info(episode)') as Array<{ name: string }>).map((r) => r.name);
        expect(findBitemporalTokenViolations(nodeCols)).toEqual([]);
        expect(findBitemporalTokenViolations(edgeCols)).toEqual([]);
        // episode is checked against the token list ONLY (not an exact set) because the D-02
        // FALLBACK verdict (not selected this plan — PRIMARY was chosen) would have added a
        // nullable `provenance_key` column here as a provenance sidecar, not a bi-temporal
        // validity or supersedes-chain column. Pinning an exact episode column set would make
        // this guard plan-shape-dependent; the token scan is the invariant that actually
        // matters and holds under either verdict.
        expect(findBitemporalTokenViolations(episodeCols)).toEqual([]);
      } finally {
        db.close();
      }
    });

    it('non-vacuousness: a synthetic column list containing valid_from is flagged', () => {
      const violations = findBitemporalTokenViolations(['id', 'value', 'valid_from', 'valid_to']);
      expect(violations).toContain('valid_from');
      expect(violations).toContain('valid_to');
      expect(violations.length).toBeGreaterThan(0);
    });
  });

  describe('config pin — PE band + contradiction thresholds unchanged from pre-Phase-65', () => {
    it('DEFAULT_CONFIG PE values equal their pre-Phase-65 numbers', () => {
      // Origins: src/lib/config.ts DEFAULT_CONFIG, unchanged since Phase 2 (peReconcileBandLow/
      // High, peAppendNewMinResistance) and Phase 65's own D-16 addition (contradictionN was
      // already 3 pre-Phase-65; contradictionNBySource is the NEW dark per-source override and
      // is deliberately NOT pinned here — only the four values DRIFT-01 protects are).
      expect(DEFAULT_CONFIG.peReconcileBandLow).toBe(0.8);
      expect(DEFAULT_CONFIG.peReconcileBandHigh).toBe(2.0);
      expect(DEFAULT_CONFIG.peAppendNewMinResistance).toBe(0.3);
      expect(DEFAULT_CONFIG.contradictionN).toBe(3);
    });
  });
});
