/**
 * T-62-17-08 structural guard: no file under src/ imports the bare `css-tree` package
 * or anything under `tests/`.
 *
 * Documented as an invariant since 62-17 (`62-17-PLAN.md`'s threat register), but
 * UNENFORCED until this plan (62-23): the only prior check was a one-shot `grep` embedded
 * in that plan's own verify gate, never shipped as a test. WR-10 (`62-REVIEW.md`) proved
 * by construction that `src/` could compile cleanly against both the bare `css-tree`
 * parser and the test-only liveness oracle (`tests/support/css-liveness-oracle.ts`), because
 * `tests/support/css-tree-ambient.d.ts`'s `declare module 'css-tree'` is program-global and
 * root `tsconfig.json`'s `include` covered `tests/` too. 62-23 fixed the compile-time half
 * (root `include` narrowed to `["src","scripts"]`, tests/ ambient declarations scoped to
 * `tests/tsconfig.json`) — this file is the runtime-suite half: a shipped regression lock
 * so a future `src/` file that reaches for the parser surface or the test-only oracle fails
 * `vitest run`, not just an occasional manual `tsc`.
 *
 * This matters beyond tidiness: the liveness oracle is this phase's independent ground
 * truth for CSS hiding-declaration detection. Ground truth reachable from production is
 * ground truth that can be made to agree with production, destroying its adjudication
 * value — the exact circularity WR-09 named as this phase's root cause.
 *
 * The offender predicate is exported so the real `src/` walk below and the
 * non-vacuousness check use the SAME code path — two copies of a guard predicate is the
 * same duplication defect this phase keeps filing at a different layer (CR-05 is the CSS
 * production/oracle instance of it).
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
 * Returns offender descriptions for `source` (attributed to `filePath`), or [] if clean.
 *
 * Ban list (deliberately closed):
 *   - bare `css-tree` import (`from 'css-tree'` / `require('css-tree')`) — the
 *     `css-tree/tokenizer` subpath is the adopted surface and must NOT be reported.
 *   - any import specifier resolving into `tests/support/` — the test-only oracle tree.
 *
 * NOT banned (must never be reported): `css-tree/tokenizer` (adopted, typed via
 * `src/types/css-tree-tokenizer.d.ts`), `htmlparser2` (adopted per 62-21-SUMMARY.md).
 */
// RED (Task 2, TDD): stub predicate — deliberately does not implement the ban list yet.
// The non-vacuousness check below must fail against this stub; GREEN replaces this body.
export function findBoundaryOffenders(_filePath: string, _source: string): string[] {
  return [];
}

describe('T-62-17-08 import-boundary guard (62-23)', () => {
  it('no file under src/ imports the bare css-tree package or anything under tests/support/', () => {
    const offenders: string[] = [];
    for (const f of collectTsFiles(SRC_DIR)) {
      offenders.push(...findBoundaryOffenders(f, readFileSync(f, 'utf8')));
    }
    expect(offenders).toEqual([]);
  });

  it('is not vacuous: the same predicate flags a synthetic file planting one offender of each kind', () => {
    const syntheticOffenders = [
      { path: 'src/source/__synthetic-bare-css-tree.ts', source: "import { parse } from 'css-tree';" },
      {
        path: 'src/source/__synthetic-tests-import.ts',
        source: "import { liveHidingSelectors } from '../../tests/support/css-liveness-oracle';",
      },
    ];
    const found: string[] = [];
    for (const { path, source } of syntheticOffenders) {
      found.push(...findBoundaryOffenders(path, source));
    }
    expect(found.length).toBe(2);
  });

  it('permits the adopted css-tree/tokenizer subpath — no offender', () => {
    const source = "import { tokenize, tokenTypes } from 'css-tree/tokenizer';";
    expect(findBoundaryOffenders('src/source/synthetic.ts', source)).toEqual([]);
  });

  it('permits the adopted HTML parser (htmlparser2, 62-21-SUMMARY.md) — no offender', () => {
    const source = "import { Parser } from 'htmlparser2';";
    expect(findBoundaryOffenders('src/source/synthetic.ts', source)).toEqual([]);
  });
});
