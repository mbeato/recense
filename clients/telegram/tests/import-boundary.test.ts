/**
 * CLIENT-01 structural guard: clients/telegram imports nothing from src/.
 *
 * D-06 precedent: DEBT-01 guard-test pattern applied to import boundaries.
 * Uses a static file scan (not runtime import resolution) — catches barrel
 * re-exports and any aliased path that resolves to the engine src/ tree.
 *
 * The scan covers all .ts files under clients/telegram/ including this tests/
 * subdirectory (strengthens the guard: the test itself must not import src/).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const CLIENT_DIR = resolve(__dirname, '..'); // clients/telegram/

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

describe('CLIENT-01 import-boundary guard (D-06)', () => {
  it('no file in clients/telegram/ imports anything from src/', () => {
    const files = collectTsFiles(CLIENT_DIR);
    const violations: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      // Match any import/require that resolves to the engine src/ tree via a
      // relative path traversal. Both ESM (from '...') and CJS (require('...')) forms.
      if (
        /from\s+['"][^'"]*\/src\//.test(text) ||
        /require\s*\(\s*['"][^'"]*\/src\//.test(text)
      ) {
        violations.push(f);
      }
    }
    expect(violations).toEqual([]);
  });
});
