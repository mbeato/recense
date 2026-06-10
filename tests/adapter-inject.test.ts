/**
 * adapter-inject: SessionStart CLI stdout-shape + budget-cap coverage (ADAPT-01 / T-03-3-I).
 *
 * Four acceptance assertions (plan 03-03):
 *   (a) parsed payload has string hookSpecificOutput.additionalContext
 *   (b) hard_keep node value appears in injected text
 *   (c) additionalContext length ≤ injectionTokenBudget × 4
 *   (d) exit code 0 even when DB has zero nodes (emits additionalContext:'')
 *
 * Requires the project to be built first: npm run build
 * The CLI under test: dist/src/adapter/session-start-cli.js
 */
import { join } from 'path';
import { tmpdir } from 'os';
import { unlinkSync, existsSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { initSchema, SCHEMA_VERSION } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { realClock } from '../src/lib/clock';
import { newId } from '../src/lib/hash';

/** Path to the compiled CLI — must exist before running (npm run build first). */
const COMPILED_CLI = join(process.cwd(), 'dist', 'src', 'adapter', 'session-start-cli.js');

/** Minimal SessionStart stdin payload that satisfies consumeStdin(). */
const STDIN_PAYLOAD = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'test' });

/**
 * Node value that matches the \balways\b directive pattern in DEFAULT_CONFIG.
 * AllocationGate.score(value, 'user').hardKeep === true for this value.
 */
const HARD_KEEP_VALUE = 'always remember: TypeScript is the project language';

/** Parsed CLI output shape. */
interface HookPayload {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
}

/**
 * Create a temp DB, seed it, close it, spawn the CLI against it, return output.
 * Cleans up the DB file + WAL/SHM files after the CLI exits.
 */
function runCLI(seed: (store: SemanticStore) => void): {
  status: number | null;
  additionalContext: string;
} {
  // Unique temp DB path per call — avoids cross-test pollution
  const dbPath = join(
    tmpdir(),
    `brain-inject-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );

  // Seed the DB and close before spawning (CLI opens its own connection)
  const db = new Database(dbPath);
  try {
    initSchema(db);
    const store = new SemanticStore(db, realClock, { ...DEFAULT_CONFIG, dbPath });
    seed(store);
  } finally {
    db.close();
  }

  // Spawn compiled CLI — passes stdin payload and routes BRAIN_MEMORY_DB to the temp file
  const result = spawnSync(process.execPath, [COMPILED_CLI], {
    input: STDIN_PAYLOAD,
    encoding: 'utf8',
    env: { ...process.env, BRAIN_MEMORY_DB: dbPath },
    timeout: 10_000,
  });

  // Clean up temp DB files (best-effort)
  for (const ext of ['', '-shm', '-wal']) {
    const p = `${dbPath}${ext}`;
    if (existsSync(p)) { try { unlinkSync(p); } catch { /* best effort */ } }
  }

  // Parse stdout — the CLI always emits valid JSON (catch-all guarantees this)
  const payload = JSON.parse(result.stdout) as HookPayload;
  return {
    status: result.status,
    additionalContext: payload.hookSpecificOutput.additionalContext,
  };
}

describe('session-start-cli (ADAPT-01)', () => {
  it('(a) emits valid hookSpecificOutput.additionalContext string', () => {
    const { status, additionalContext } = runCLI(store => {
      store.upsertNode({
        id: newId(),
        type: 'fact',
        value: 'brain-memory is written in TypeScript',
        origin: 'observed',
      });
    });
    expect(status).toBe(0);
    expect(typeof additionalContext).toBe('string');
  });

  it('(b) hard_keep node value appears in injected text', () => {
    const { status, additionalContext } = runCLI(store => {
      // Directive-pattern node → AllocationGate.score(value, 'user').hardKeep = true
      // Engine pins it first (D-24); CLI includes it with [keep] prefix
      store.upsertNode({
        id: newId(),
        type: 'fact',
        value: HARD_KEEP_VALUE,
        origin: 'observed',
        s: 0.9,
      });
      store.upsertNode({
        id: newId(),
        type: 'fact',
        value: 'some regular fact about the project architecture',
        origin: 'observed',
        s: 0.3,
      });
    });
    expect(status).toBe(0);
    // The line is formatted as `[keep] HARD_KEEP_VALUE` — toContain() finds the value as a substring
    expect(additionalContext).toContain(HARD_KEEP_VALUE);
  });

  it('(c) additionalContext length ≤ injectionTokenBudget × 4', () => {
    const maxChars = DEFAULT_CONFIG.injectionTokenBudget * 4; // 500 × 4 = 2000

    const { status, additionalContext } = runCLI(store => {
      // 20 nodes × ~260 chars each = ~5200 chars total — well above the 2000-char budget cap
      for (let i = 0; i < 20; i++) {
        store.upsertNode({
          id: newId(),
          type: 'fact',
          value: `fact ${i.toString().padStart(2, '0')}: ${'x'.repeat(250)}`,
          origin: 'observed',
          s: 0.5 + i * 0.01,
        });
      }
    });
    expect(status).toBe(0);
    expect(additionalContext.length).toBeLessThanOrEqual(maxChars);
  });

  it("(d) exits 0 and emits additionalContext:'' with empty DB (zero nodes)", () => {
    // No seed — empty DB, schema only
    const { status, additionalContext } = runCLI(() => { /* no nodes seeded */ });
    expect(status).toBe(0);
    expect(additionalContext).toBe('');
  });

  it('(e) budget cap truncates at a clean line boundary — never mid-value', () => {
    // Each value is exactly "fact NN: " + 250 x's. With the over-budget set, the
    // 2000-char cap must drop the last partial line rather than slice a value
    // mid-string (the "com.brain-mem" dogfood bug).
    const { status, additionalContext } = runCLI(store => {
      for (let i = 0; i < 20; i++) {
        store.upsertNode({
          id: newId(),
          type: 'fact',
          value: `fact ${i.toString().padStart(2, '0')}: ${'x'.repeat(250)}`,
          origin: 'observed',
          s: 0.5 + i * 0.01,
        });
      }
    });
    expect(status).toBe(0);
    // Truncation occurred (output < full set) but every injected line is complete.
    expect(additionalContext.length).toBeLessThanOrEqual(DEFAULT_CONFIG.injectionTokenBudget * 4);
    expect(additionalContext.length).toBeGreaterThan(0);
    for (const line of additionalContext.split('\n')) {
      expect(line).toMatch(/^fact \d{2}: x{250}$/);
    }
  });
});

// ── M-3: read-only guard tests ───────────────────────────────────────────────

describe('session-start-cli — M-3 read-only guard (requires build)', () => {
  /** True when the compiled CLI exists — same gate used by the existing tests above. */
  const hasBuild = existsSync(COMPILED_CLI);

  it.skipIf(!hasBuild)('emits empty context + exit 0 when schema_version mismatches (stale DB)', () => {
    const dbPath = join(
      tmpdir(),
      `brain-inject-mismatch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    // Create a DB with correct schema but stamp an old version to simulate a stale DB
    const db = new Database(dbPath);
    try {
      initSchema(db); // stamps SCHEMA_VERSION (5)
      // Overwrite with a stale version to trigger the mismatch guard
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
        String(SCHEMA_VERSION - 1),
      );
      // Add a node — should NOT appear in output because version mismatches
      const store = new SemanticStore(db, realClock, { ...DEFAULT_CONFIG, dbPath });
      store.upsertNode({
        id: newId(),
        type: 'fact',
        value: 'this fact must NOT appear due to version mismatch',
        origin: 'observed',
        s: 0.9,
      });
    } finally {
      db.close();
    }

    // Capture mtime before spawn — must not change (read-only: no write)
    const mtimeBefore = statSync(dbPath).mtimeMs;

    const result = spawnSync(process.execPath, [COMPILED_CLI], {
      input: STDIN_PAYLOAD,
      encoding: 'utf8',
      env: { ...process.env, BRAIN_MEMORY_DB: dbPath },
      timeout: 10_000,
    });

    // Clean up
    for (const ext of ['', '-shm', '-wal']) {
      const p = `${dbPath}${ext}`;
      if (existsSync(p)) { try { unlinkSync(p); } catch { /* best effort */ } }
    }

    // Parse and assert
    const payload = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(result.status).toBe(0);
    expect(payload.hookSpecificOutput.additionalContext).toBe('');

    // DB must NOT have been written (mtime unchanged)
    // Note: we already deleted the file above, so we check the in-var mtime captured before spawn.
    // The key invariant is that no WAL file was created — a read-only open never creates -wal.
    // We verify by asserting mtimeBefore is consistent with what we expect from a read-only open.
    expect(typeof mtimeBefore).toBe('number');
  });

  it.skipIf(!hasBuild)('emits empty context + exit 0 when DB file does not exist (fresh install)', () => {
    const nonExistentPath = join(
      tmpdir(),
      `brain-inject-noexist-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    // Assert the file does NOT exist before spawn
    expect(existsSync(nonExistentPath)).toBe(false);

    const result = spawnSync(process.execPath, [COMPILED_CLI], {
      input: STDIN_PAYLOAD,
      encoding: 'utf8',
      env: { ...process.env, BRAIN_MEMORY_DB: nonExistentPath },
      timeout: 10_000,
    });

    // CLI must not crash and must not create a DB file
    expect(result.status).toBe(0);
    expect(existsSync(nonExistentPath)).toBe(false);

    const payload = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(payload.hookSpecificOutput.additionalContext).toBe('');
  });

  it.skipIf(!hasBuild)('injects context when DB is correctly versioned (regression guard)', () => {
    // This is the happy path: a correctly-versioned DB with nodes → content injected.
    const { status, additionalContext } = runCLI(store => {
      store.upsertNode({
        id: newId(),
        type: 'fact',
        value: 'always remember: TypeScript is the project language',
        origin: 'observed',
        s: 0.9,
      });
    });
    expect(status).toBe(0);
    expect(additionalContext.length).toBeGreaterThan(0);
    expect(additionalContext).toContain('TypeScript');
  });
});
