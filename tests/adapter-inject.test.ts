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
import { unlinkSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { initSchema } from '../src/db/schema';
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
});
