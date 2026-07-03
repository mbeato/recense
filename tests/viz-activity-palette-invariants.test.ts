/**
 * tests/viz-activity-palette-invariants.test.ts
 *
 * Phase 57 Plan 01 — dedicated invariants file (D-12) that owns all Phase-57
 * palette/motion locks. Seeded here with the D-10 shared-source-sync invariant
 * (subsumes the never-written WR-02 lock); later Phase-57 plans extend this file
 * with luminance-band membership, dim floors, and per-channel monotonic SC3
 * ordering checks.
 *
 * Mirrors:
 *   - tests/viz-ambient-liveliness.test.ts — readFileSync/stripComments source-parse
 *     harness (readConstantsJs/readServer + export-const regex convention).
 *   - tests/spontaneous-idle-activation.test.ts — marker-slice static-guard style.
 *
 * D-10 shared source of truth: src/viz/modules/constants.js is the SOLE authored
 * home of every scheduler scalar the viz server needs; src/viz/server.ts derives
 * them via source-parse at startVizServer init (see parseSchedulerScalars()) and
 * never re-declares an independent literal. This test locks that structurally —
 * it fails if a scheduler literal is ever re-added to server.ts, or if a scalar's
 * value in server.ts's parse target ever diverges from constants.js.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSchedulerScalars } from '../src/viz/server';

const ROOT = path.resolve(__dirname, '..');
const MODULES_ROOT = path.resolve(ROOT, 'src/viz/modules');

function readConstantsJs(): string {
  return fs.readFileSync(path.resolve(ROOT, 'src/viz/modules/constants.js'), 'utf8');
}

function readServer(): string {
  return fs.readFileSync(path.resolve(ROOT, 'src/viz/server.ts'), 'utf8');
}

/** Strip JSDoc inner lines and standalone comment lines before token assertions. */
function stripComments(src: string): string {
  return src.split('\n').filter(line => !/^\s*(\*|\/\/)/.test(line)).join('\n');
}

/** The seven scheduler scalars migrated to a single authored home in constants.js (D-10). */
const SCHEDULER_SCALAR_NAMES = [
  'REPLAY_IDLE_GAP_MS',
  'REPLAY_CADENCE_MS',
  'REPLAY_HISTORY_N',
  'SPONT_CADENCE_MS',
  'SPONT_SEED_COUNT',
  'SPONT_HOP_TOPN',
  'SPONT_POOL_REFRESH_MS',
] as const;

describe('D-10 shared source of truth', () => {
  const constantsSrc = readConstantsJs();
  const serverSrc = readServer();
  const serverSrcNoComments = stripComments(serverSrc);

  describe('Test A: WR-01 anti-duplication lock', () => {
    for (const name of SCHEDULER_SCALAR_NAMES) {
      it(`server.ts does not re-declare a literal for ${name}`, () => {
        // A bare `const NAME = <number>` re-declaration is exactly the WR-01 mirror-drift
        // shape being killed — the name may still appear as a destructured/derived binding
        // from parseSchedulerScalars(), which does not match this literal-assignment pattern.
        const literalRedeclaration = new RegExp(`const\\s+${name}\\s*=\\s*[\\d.]+`);
        expect(serverSrcNoComments).not.toMatch(literalRedeclaration);
      });
    }
  });

  describe('Test B: single-source presence', () => {
    for (const name of SCHEDULER_SCALAR_NAMES) {
      it(`constants.js declares ${name} exactly once as an export const`, () => {
        const matches = constantsSrc.match(new RegExp(`export\\s+const\\s+${name}\\s*=`, 'g'));
        expect(matches).not.toBeNull();
        expect(matches).toHaveLength(1);
      });
    }
  });

  describe('Test C: runtime sync (red-if-drift guard)', () => {
    /**
     * Parse a named scalar's numeric value directly out of constants.js's source text,
     * using the same export-const regex convention server.ts's parseSchedulerScalars() uses.
     */
    function parseFromConstantsJs(name: string): number {
      const match = constantsSrc.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*([\\d.]+)`));
      expect(match).not.toBeNull();
      return Number(match![1]);
    }

    // Call the REAL parse mechanism server.ts uses at startVizServer init, against the
    // real constants.js file — proving the two consumption paths (this direct regex check
    // vs. server.ts's own parseSchedulerScalars()) can never silently diverge.
    const parsedByServer = parseSchedulerScalars(MODULES_ROOT);

    it('REPLAY_CADENCE_MS: the value server.ts parses equals constants.js', () => {
      expect(parsedByServer.REPLAY_CADENCE_MS).toBe(parseFromConstantsJs('REPLAY_CADENCE_MS'));
    });

    it('SPONT_HOP_TOPN: the value server.ts parses equals constants.js', () => {
      expect(parsedByServer.SPONT_HOP_TOPN).toBe(parseFromConstantsJs('SPONT_HOP_TOPN'));
    });
  });

  describe('static: server.ts derives scheduler scalars from constants.js', () => {
    it('contains a readFileSync call resolving modules/constants.js', () => {
      expect(serverSrc).toMatch(/readFileSync.*constants\.js/);
    });
  });
});

// =============================================================================
// Future Phase-57 invariant groups extend this file with additional describe()
// blocks below (D-12) — one section header per group:
//
//   describe('luminance-band membership', ...)   — every KIND_COLOR entry's computed
//                                                    luminance falls inside the named band (D-02).
//   describe('dim floors', ...)                  — every dim factor stays >= its perceptual
//                                                    floor on the dark bg (D-05).
//   describe('SC3 motion ordering', ...)          — per-channel monotonic ordering across
//                                                    live > replay > spontaneous > twinkle
//                                                    on the salient channels (D-06).
// =============================================================================
