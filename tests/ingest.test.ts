/**
 * INGEST-01: EpisodicStore unconditional append.
 * INGEST-02: AllocationGate honest salience + hard-keep flag.
 * Pipeline: end-to-end recordEvent vertical slice.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { EpisodicStore } from '../src/db/episode-store';
import type { AppendEventParams } from '../src/db/episode-store';

const testConfig: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

// ─── INGEST-01: EpisodicStore ─────────────────────────────────────────────────

describe('INGEST-01: EpisodicStore unconditional append', () => {
  let db: Database.Database;
  let clock: FakeClock;
  let store: EpisodicStore;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    clock = new FakeClock(1_000_000);
    store = new EpisodicStore(db, clock, testConfig);
  });

  it('appends 50 events unconditionally regardless of salience or role', () => {
    for (let i = 0; i < 50; i++) {
      const role = i % 3 === 0 ? 'user' as const : i % 3 === 1 ? 'assistant' as const : 'tool' as const;
      store.append({
        content: `message ${i}`,
        origin: 'observed',
        salience: Math.random() * 0.05, // very low salience
        hard_keep: 0,
        role,
        session_id: 'sess-1',
        source_inference_id: null,
      });
    }
    expect(store.listUnconsolidated()).toHaveLength(50);
  });

  it('stored row carries all passed fields and consolidated=0', () => {
    clock.setNow(9_999_000);
    const row = store.append({
      content: 'hello world',
      origin: 'asserted_by_user',
      salience: 0.75,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-abc',
      source_inference_id: null,
    });
    expect(row.content).toBe('hello world');
    expect(row.origin).toBe('asserted_by_user');
    expect(row.salience).toBe(0.75);
    expect(row.hard_keep).toBe(1);
    expect(row.role).toBe('user');
    expect(row.session_id).toBe('sess-abc');
    expect(row.consolidated).toBe(0);
    expect(row.ts).toBe(9_999_000);
  });

  it('caps content longer than maxContentBytes and adds truncation marker', () => {
    const longContent = 'a'.repeat(10_000); // > 8 KB default
    const row = store.append({
      content: longContent,
      origin: 'observed',
      salience: 0.1,
      hard_keep: 0,
      role: 'tool',
      session_id: 'sess-1',
      source_inference_id: null,
    });
    const markerBytes = Buffer.byteLength('…[truncated]', 'utf8');
    expect(Buffer.byteLength(row.content, 'utf8')).toBeLessThanOrEqual(
      testConfig.maxContentBytes + markerBytes,
    );
    expect(row.content).toContain('[truncated]');
    expect(row.content.length).toBeLessThan(longContent.length);
  });

  it('stores content shorter than maxContentBytes verbatim (no truncation)', () => {
    const content = 'a short message that fits easily';
    const row = store.append({
      content,
      origin: 'observed',
      salience: 0.5,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'sess-1',
      source_inference_id: null,
    });
    expect(row.content).toBe(content);
    expect(row.content).not.toContain('[truncated]');
  });

  it('listUnconsolidated returns hard_keep=1 rows before hard_keep=0 rows', () => {
    store.append({ content: 'low-sal-free', origin: 'observed', salience: 0.9, hard_keep: 0, role: 'user', session_id: 's', source_inference_id: null });
    store.append({ content: 'kept-low-sal', origin: 'observed', salience: 0.1, hard_keep: 1, role: 'user', session_id: 's', source_inference_id: null });

    const rows = store.listUnconsolidated();
    expect(rows[0]!.hard_keep).toBe(1);
    expect(rows[1]!.hard_keep).toBe(0);
  });

  it('listUnconsolidated sorts salience DESC within each hard_keep group', () => {
    store.append({ content: 'a', origin: 'observed', salience: 0.3, hard_keep: 0, role: 'user', session_id: 's', source_inference_id: null });
    store.append({ content: 'b', origin: 'observed', salience: 0.7, hard_keep: 0, role: 'user', session_id: 's', source_inference_id: null });
    store.append({ content: 'c', origin: 'observed', salience: 0.5, hard_keep: 1, role: 'user', session_id: 's', source_inference_id: null });
    store.append({ content: 'd', origin: 'observed', salience: 0.9, hard_keep: 1, role: 'user', session_id: 's', source_inference_id: null });

    const rows = store.listUnconsolidated();
    // hard_keep=1 group, salience DESC
    expect(rows[0]!.content).toBe('d'); // hk=1, sal=0.9
    expect(rows[1]!.content).toBe('c'); // hk=1, sal=0.5
    // hard_keep=0 group, salience DESC
    expect(rows[2]!.content).toBe('b'); // hk=0, sal=0.7
    expect(rows[3]!.content).toBe('a'); // hk=0, sal=0.3
  });

  it('getEpisode round-trips all fields', () => {
    // source_inference_id has an FK REFERENCES episode(id) — insert the parent first
    const parent = store.append({
      content: 'parent inference episode',
      origin: 'inferred',
      salience: 0.1,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'sess-rt',
      source_inference_id: null,
    });
    const appended = store.append({
      content: 'round-trip test',
      origin: 'inferred',
      salience: 0.42,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'sess-rt',
      source_inference_id: parent.id,
    });
    const retrieved = store.getEpisode(appended.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(appended.id);
    expect(retrieved!.content).toBe('round-trip test');
    expect(retrieved!.origin).toBe('inferred');
    expect(retrieved!.salience).toBeCloseTo(0.42);
    expect(retrieved!.role).toBe('assistant');
    expect(retrieved!.session_id).toBe('sess-rt');
    expect(retrieved!.source_inference_id).toBe(parent.id);
    expect(retrieved!.consolidated).toBe(0);
  });

  it('getEpisode returns null for an unknown id', () => {
    expect(store.getEpisode('does-not-exist')).toBeNull();
  });
});
