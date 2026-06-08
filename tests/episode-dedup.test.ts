/**
 * INGEST-01 extension: dedup-aware EpisodicStore.append (D-59).
 *
 * Five behaviour invariants:
 *  1. Fresh (source, external_id) → inserts one row, returns it with correct fields.
 *  2. Same (source, external_id) twice → second call is a no-op, returns the FIRST row.
 *  3. source='claude-code', external_id=null × 2 → both insert (NULL is always distinct).
 *  4. Same external_id, different source → both insert (uniqueness is the pair).
 *  5. Omitting source/external_id defaults to 'claude-code'/null (back-compat).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { EpisodicStore } from '../src/db/episode-store';

const testConfig: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

/** Minimal valid AppendEventParams for dedup tests — only fields that matter vary per test. */
const BASE_PARAMS = {
  content: 'test content',
  origin: 'observed' as const,
  salience: 0.5,
  hard_keep: 0,
  role: 'user' as const,
  session_id: 'sess-dedup',
  source_inference_id: null,
};

describe('EpisodicStore dedup-aware append (D-59)', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let store: EpisodicStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    clock = new FakeClock(1_000_000);
    store = new EpisodicStore(db, clock, testConfig);
  });

  afterEach(() => {
    db.close();
  });

  // ── Behaviour 1: fresh (source, external_id) inserts and returns correct fields ──

  it('fresh (source, external_id) inserts one row with correct source and external_id', () => {
    const row = store.append({
      ...BASE_PARAMS,
      source: 'email',
      external_id: 'msg-001',
    });

    expect(row.source).toBe('email');
    expect(row.external_id).toBe('msg-001');
    expect(store.listUnconsolidated()).toHaveLength(1);
  });

  // ── Behaviour 2: same (source, external_id) twice → idempotent dedup ──────────

  it('appending the same (source, external_id) twice returns the first row with the same id', () => {
    const first = store.append({
      ...BASE_PARAMS,
      source: 'email',
      external_id: 'msg-42',
    });

    const second = store.append({
      ...BASE_PARAMS,
      content: 'different content — same dedup key',
      source: 'email',
      external_id: 'msg-42',
    });

    // Must be the exact same row — same id, original content
    expect(second.id).toBe(first.id);
    expect(second.content).toBe(first.content);
    // Exactly one row in the store
    expect(store.listUnconsolidated()).toHaveLength(1);
  });

  // ── Behaviour 3: NULL external_id is always distinct (INGEST-01 preserved) ───

  it('two appends with source=claude-code and external_id=null both insert (NULL never dedups)', () => {
    const r1 = store.append({ ...BASE_PARAMS, source: 'claude-code', external_id: null });
    const r2 = store.append({ ...BASE_PARAMS, source: 'claude-code', external_id: null });

    expect(r1.id).not.toBe(r2.id);
    expect(store.listUnconsolidated()).toHaveLength(2);
  });

  // ── Behaviour 4: same external_id, different source → both insert ─────────────

  it('same external_id with different source both insert (uniqueness is the (source, external_id) pair)', () => {
    const r1 = store.append({ ...BASE_PARAMS, source: 'email', external_id: 'shared-key' });
    const r2 = store.append({ ...BASE_PARAMS, source: 'calendar', external_id: 'shared-key' });

    expect(r1.id).not.toBe(r2.id);
    expect(store.listUnconsolidated()).toHaveLength(2);
  });

  // ── Behaviour 5: back-compat — omitting source/external_id uses safe defaults ─

  it('omitting source defaults to claude-code', () => {
    const row = store.append({ ...BASE_PARAMS });
    expect(row.source).toBe('claude-code');
  });

  it('omitting external_id defaults to null', () => {
    const row = store.append({ ...BASE_PARAMS });
    expect(row.external_id).toBeNull();
  });

  it('back-compat: legacy append without source/external_id still inserts unconditionally', () => {
    // Simulates existing call sites (turn-capture, stop-cli) that omit new fields
    for (let i = 0; i < 5; i++) {
      store.append({ ...BASE_PARAMS, content: `legacy message ${i}` });
    }
    expect(store.listUnconsolidated()).toHaveLength(5);
  });
});
