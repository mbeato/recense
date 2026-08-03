/**
 * CLIENT-01 structural guard: clients/telegram imports nothing from src/.
 *
 * D-06 precedent: DEBT-01 guard-test pattern applied to import boundaries.
 * Uses a static file scan (not runtime import resolution) — catches barrel
 * re-exports and any aliased path that resolves to the engine src/ tree.
 *
 * The scan covers all TypeScript files (.ts/.mts/.cts/.tsx) under
 * clients/telegram/ including this tests/ subdirectory (strengthens the
 * guard: the test itself must not import src/).
 *
 * Hardened per review WR-02 (kept in lockstep with the sibling
 * clients/proposal-reference/tests/import-boundary.test.ts):
 * - trailing slash after `src` is optional, so the bare engine-barrel
 *   directory import (which resolves to the real, populated engine barrel
 *   index) is caught;
 * - dynamic `import(...)` is covered alongside `from '...'` and `require(...)`;
 * - `.mts`/`.cts`/`.tsx` files cannot escape the walk;
 * - a file-count floor makes an empty/partial walk fail loudly instead of
 *   passing vacuously.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CLIENT_DIR = resolve(__dirname, '..'); // clients/telegram/

/**
 * Matches any static import (`from '...'`), CJS `require('...')`, or dynamic
 * `import('...')` whose specifier reaches a `src` path segment — with or
 * without a trailing slash, so the bare engine-barrel directory import is
 * caught too.
 */
const IMPORT_RE = /(?:from\s+|require\s*\(\s*|import\s*\(\s*)['"][^'"]*\/src(?:\/|['"])/;

/** Every TypeScript flavor is scanned — .mts/.cts/.tsx must not escape the walk. */
const TS_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx'];

/**
 * Non-vacuousness floor (guard the guard): the directory holds 25 committed
 * TypeScript files today (plus generated dist/*.d.ts when built). If the walk
 * ever returns fewer than this, the scan itself is broken (or the tree was
 * restructured) and the guard must fail loudly instead of passing on an
 * empty scan.
 */
const MIN_SCANNED_FILES = 15;

/** Recursively collect all TypeScript files under dir. */
function collectTsFiles(dir: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectTsFiles(full));
    } else if (TS_EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
      result.push(full);
    }
  }
  return result;
}

describe('CLIENT-01 import-boundary guard (D-06)', () => {
  it('no file in clients/telegram/ imports anything from src/', () => {
    const files = collectTsFiles(CLIENT_DIR);
    // Guard the guard: an empty or partial walk must fail, not pass vacuously.
    expect(files.length).toBeGreaterThanOrEqual(MIN_SCANNED_FILES);

    const violations: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (IMPORT_RE.test(text)) {
        violations.push(f);
      }
    }
    expect(violations).toEqual([]);
  });

  it('the scan regex catches every known bypass form (planted offenders)', () => {
    // Built by concatenation so this file itself never contains a literal
    // engine-import specifier the directory scan above would flag.
    const SRC = '../../s' + 'rc';
    const offenders = [
      "import { SemanticStore } from '" + SRC + "'", // bare barrel, no trailing slash
      "import { initSchema } from '" + SRC + "/db/schema'", // static deep import
      "const mod = await import('" + SRC + "/db/schema')", // dynamic import()
      "const cfg = require('" + SRC + "/lib/config')", // CJS require
      'export * from "' + SRC + '"', // re-export barrel form
    ];
    for (const line of offenders) {
      expect(IMPORT_RE.test(line), `should flag: ${line}`).toBe(true);
    }
  });

  it('the scan regex does not flag lawful non-engine imports', () => {
    const lawful = [
      "import { loadConfig } from '../config'",
      "import { createHash } from 'node:crypto'",
      "import x from './source/thing'", // '/sour...' is not a src segment
      "import y from 'some-package/srcery'", // 'src' prefix of a longer name
    ];
    for (const line of lawful) {
      expect(IMPORT_RE.test(line), `should not flag: ${line}`).toBe(false);
    }
  });
});
