/**
 * tests/brain-dispatch.test.ts — H-1 regression: brain dispatcher must forward argv[3..]
 * to spawned child CLIs, not argv[4..] (which drops the first positional/flag).
 *
 * Build-gated: spawns dist/src/adapter/brain.js so the test ONLY runs when dist/ exists.
 * The pretest build script (M-11) ensures dist/ is always fresh before `npm test`.
 *
 * The key behavior under test:
 *   `brain ingest --db <tmp> <unknown-source>` must reach the child with all three tokens
 *   (--db <path> <source>) so ingest-cli.ts logs "Unknown source '<source>'".
 *   Before the H-1 fix, argv.slice(4) dropped the <source> token; the child defaulted to
 *   --all, never logged the unknown source, and the test would have failed.
 */

import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect } from 'vitest';

const BRAIN_JS = join(__dirname, '..', 'dist', 'src', 'adapter', 'brain.js');
const INGEST_LOG = '/tmp/brain-memory-ingest.log';

// Skip the entire suite when dist/ has not been built (CI guard).
const SKIP_NO_DIST = !existsSync(BRAIN_JS);

describe.skipIf(SKIP_NO_DIST)('brain dispatcher (H-1): argv[3..] forwarding', () => {
  it('ingest child receives positional source arg and logs Unknown source', () => {
    // Use a unique source name that will definitely trigger the "Unknown source" log.
    const uniqueSource = `bogus-src-${Math.random().toString(36).slice(2)}`;

    // Create a temp dir for a throw-away DB path (ingest-cli exits 0 on unknown source
    // before creating the DB, so an actual SQLite file is not needed here — just a path).
    const tmpDir = mkdtempSync(join(tmpdir(), 'brain-dispatch-test-'));
    const tmpDb = join(tmpDir, 'test.db');

    // Truncate / clear the ingest log so we don't see stale entries.
    try { writeFileSync(INGEST_LOG, ''); } catch { /* ignore — log may not exist yet */ }

    try {
      // Spawn: brain ingest --db <tmpDb> <uniqueSource>
      // With the pre-fix slice(4), the child only received `[uniqueSource]` minus `--db <path>`,
      // so it had no --db and would exit before logging. With the fix (slice(3)), the child
      // receives `['ingest', '--db', tmpDb, uniqueSource]` → resolves dbPath + logs unknown source.
      spawnSync(process.execPath, [BRAIN_JS, 'ingest', '--db', tmpDb, uniqueSource], {
        stdio: 'pipe',
        timeout: 15_000,
        env: { ...process.env, BRAIN_MEMORY_DB: '' }, // clear env DB so --db flag must work
      });

      // Read the ingest log
      let logContent = '';
      try { logContent = readFileSync(INGEST_LOG, 'utf8'); } catch { /* file may not exist */ }

      // The log must contain the unique source name in the "Unknown source" line.
      expect(logContent).toContain(`Unknown source '${uniqueSource}'`);
    } finally {
      try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
    }
  });
});
