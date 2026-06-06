/**
 * ADAPT-02: adapter write-path coverage.
 *
 * Tests:
 *  (a) turn-capture-cli writes role='user', origin='observed', correct session_id
 *      to the episodic store when given a UserPromptSubmit-shaped stdin payload.
 *  (b) stop-cli writes role='assistant', origin='observed' when given a
 *      Stop-shaped stdin payload.
 *  (c) stop-cli exits 0 within a generous timeout (2s) and does NOT wait for its
 *      detached child — i.e., the detached spawn + unref pattern is non-blocking.
 */
import { spawnSync } from 'child_process';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initSchema } from '../src/db/schema';

/** Absolute path to the compiled dist directory. */
const DIST_DIR = join(__dirname, '..', 'dist', 'src', 'adapter');

/** Create a fresh temp DB path for isolation. */
function makeTempDbPath(suffix: string): string {
  return join(tmpdir(), `brain-adapter-test-${suffix}-${Date.now()}.db`);
}

/** Cleanup helper. */
function rmIfExists(p: string): void {
  try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
}

describe('turn-capture-cli (UserPromptSubmit → role=user)', () => {
  let dbPath: string;

  afterEach(() => {
    rmIfExists(dbPath);
  });

  it('writes episode with role=user, origin=observed, correct session_id', () => {
    dbPath = makeTempDbPath('turn-capture');

    const payload = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Hello, remember my name is Alice',
      session_id: 'test-session-001',
    });

    const result = spawnSync(
      process.execPath,
      [join(DIST_DIR, 'turn-capture-cli.js')],
      {
        input: payload,
        encoding: 'utf8',
        env: { ...process.env, BRAIN_MEMORY_DB: dbPath },
        timeout: 5000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');

    // Verify the episode was written to the DB
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM episode ORDER BY ts ASC').all() as Array<{
      role: string;
      origin: string;
      session_id: string;
      content: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('user');
    expect(rows[0]!.origin).toBe('observed');
    expect(rows[0]!.session_id).toBe('test-session-001');
    expect(rows[0]!.content).toContain('Alice');

    db.close();
  });

  it('exits 0 with empty prompt (no episode written, but no error)', () => {
    dbPath = makeTempDbPath('turn-capture-empty');

    const payload = JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: '',
      session_id: 'test-session-002',
    });

    const result = spawnSync(
      process.execPath,
      [join(DIST_DIR, 'turn-capture-cli.js')],
      {
        input: payload,
        encoding: 'utf8',
        env: { ...process.env, BRAIN_MEMORY_DB: dbPath },
        timeout: 5000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');

    // DB may not exist or have 0 rows (empty prompt skips recordEvent)
    if (existsSync(dbPath)) {
      const db = new Database(dbPath);
      const rows = db.prepare('SELECT * FROM episode').all();
      expect(rows).toHaveLength(0);
      db.close();
    }
  });
});

describe('stop-cli (Stop → role=assistant)', () => {
  let dbPath: string;

  afterEach(() => {
    rmIfExists(dbPath);
  });

  it('writes episode with role=assistant, origin=observed, correct session_id', () => {
    dbPath = makeTempDbPath('stop-cli');

    const payload = JSON.stringify({
      hook_event_name: 'Stop',
      last_assistant_message: 'I have completed the task.',
      session_id: 'test-session-003',
    });

    const result = spawnSync(
      process.execPath,
      [join(DIST_DIR, 'stop-cli.js')],
      {
        input: payload,
        encoding: 'utf8',
        env: { ...process.env, BRAIN_MEMORY_DB: dbPath },
        timeout: 5000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');

    // Verify the episode was written to the DB
    const db = new Database(dbPath);
    const rows = db.prepare('SELECT * FROM episode ORDER BY ts ASC').all() as Array<{
      role: string;
      origin: string;
      session_id: string;
      content: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('assistant');
    expect(rows[0]!.origin).toBe('observed');
    expect(rows[0]!.session_id).toBe('test-session-003');
    expect(rows[0]!.content).toContain('completed the task');

    db.close();
  });

  it('exits 0 within 2s (non-blocking — detached child does not block parent)', () => {
    dbPath = makeTempDbPath('stop-cli-timing');

    const payload = JSON.stringify({
      hook_event_name: 'Stop',
      last_assistant_message: 'Response for timing test',
      session_id: 'test-session-timing',
    });

    const start = Date.now();
    const result = spawnSync(
      process.execPath,
      [join(DIST_DIR, 'stop-cli.js')],
      {
        input: payload,
        encoding: 'utf8',
        env: { ...process.env, BRAIN_MEMORY_DB: dbPath },
        timeout: 5000,
      },
    );
    const elapsed = Date.now() - start;

    expect(result.status).toBe(0);
    // Parent should return well within 2s even though the detached child is running
    expect(elapsed).toBeLessThan(2000);
  });

  it('exits 0 with malformed stdin (error discipline)', () => {
    dbPath = makeTempDbPath('stop-cli-malformed');

    const result = spawnSync(
      process.execPath,
      [join(DIST_DIR, 'stop-cli.js')],
      {
        input: 'not-valid-json',
        encoding: 'utf8',
        env: { ...process.env, BRAIN_MEMORY_DB: dbPath },
        timeout: 5000,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
  });
});
