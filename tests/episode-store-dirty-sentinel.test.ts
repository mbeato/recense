/**
 * Dirty-sentinel touch behavior tests for EpisodicStore.append (L8N-01).
 *
 * Three invariants under test:
 *  (a) append() with origin:'observed' on a NEW insert → sentinel file exists after call.
 *  (b) append() with origin:'inferred' → sentinel file NOT created (D-43: inferred never
 *      consolidates, so must not trigger a sleep pass).
 *  (c) append() that is a dedup no-op (second call with same source+external_id,
 *      info.changes === 0) → sentinel NOT touched. First call DOES touch; test deletes
 *      the sentinel between calls and asserts it is still absent after the second.
 *
 * Cross-check: the existing episode-dedup.test.ts uses testConfig with empty
 * dirtySentinelPath (DEFAULT_CONFIG default), confirming the empty-path is a no-op.
 */
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, rmSync } from 'fs';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { EpisodicStore } from '../src/db/episode-store';

/** Minimal valid AppendEventParams — only fields that vary per test change. */
const BASE_PARAMS = {
  content: 'sentinel test content',
  salience: 0.5,
  hard_keep: 0 as const,
  role: 'user' as const,
  session_id: 'sess-sentinel',
  source_inference_id: null,
};

describe('EpisodicStore dirty-sentinel touch (L8N-01)', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let store: EpisodicStore;
  let tmpPath: string;

  beforeEach(() => {
    // Unique sentinel path per test — never the real ~/.config path
    tmpPath = join(
      tmpdir(),
      `brain-sentinel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    // Ensure a clean slate (should not exist, but be defensive)
    if (existsSync(tmpPath)) rmSync(tmpPath);

    db = new Database(':memory:');
    initSchema(db);
    clock = new FakeClock(1_000_000);
    // Inject the sentinel path via config — this is the only setup that differs from
    // episode-dedup.test.ts (which uses empty dirtySentinelPath via DEFAULT_CONFIG).
    store = new EpisodicStore(db, clock, {
      ...DEFAULT_CONFIG,
      dbPath: ':memory:',
      dirtySentinelPath: tmpPath,
    });
  });

  afterEach(() => {
    if (existsSync(tmpPath)) rmSync(tmpPath);
    db.close();
  });

  // ── (a) Normal observed write → sentinel created ─────────────────────────────

  it('(a) append() with origin:observed creates the sentinel file', () => {
    expect(existsSync(tmpPath)).toBe(false); // pre-condition

    store.append({
      ...BASE_PARAMS,
      origin: 'observed',
      source: 'claude-code',
      external_id: null,
    });

    expect(existsSync(tmpPath)).toBe(true);
  });

  // ── (b) Inferred write → sentinel NOT created (D-43) ────────────────────────

  it('(b) append() with origin:inferred does NOT create the sentinel file', () => {
    expect(existsSync(tmpPath)).toBe(false); // pre-condition

    store.append({
      ...BASE_PARAMS,
      origin: 'inferred',
      source: 'claude-code',
      external_id: null,
    });

    expect(existsSync(tmpPath)).toBe(false);
  });

  // ── (c) Dedup no-op → sentinel NOT touched after first write ────────────────

  it('(c) dedup no-op (second call, same source+external_id) does NOT touch the sentinel', () => {
    // First call: genuine new insert → sentinel created
    store.append({
      ...BASE_PARAMS,
      origin: 'observed',
      source: 'gmail',
      external_id: 'sentinel-dedup-msg-001',
    });
    expect(existsSync(tmpPath)).toBe(true);

    // Remove the sentinel between calls — simulates it being consumed/reset
    rmSync(tmpPath);
    expect(existsSync(tmpPath)).toBe(false);

    // Second call: dedup hit (0 rows changed) → sentinel must remain absent
    store.append({
      ...BASE_PARAMS,
      content: 'different content — same dedup key',
      origin: 'observed',
      source: 'gmail',
      external_id: 'sentinel-dedup-msg-001',
    });

    expect(existsSync(tmpPath)).toBe(false);
  });
});
