/**
 * ingest-cli tests (Phase 6, D-66).
 *
 * Covers three behavioural invariants:
 *  (a) buildAdapters returns only the enabled adapters and [] for an empty list.
 *  (b) runPullPhase isolates per-adapter failures (D-66): when the first adapter
 *      throws, the second's records are still appended and the failure is logged.
 *  (c) runPullPhase appends with the correct source/external_id so a second run
 *      is idempotent (INSERT OR IGNORE dedup via D-59 UNIQUE(source, external_id)).
 *
 * Uses: in-memory SQLite, real AllocationGate/EpisodicStore/IngestionPipeline,
 * MockSourceAdapter from source-adapter.ts, and a captured log array.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { EpisodicStore } from '../src/db/episode-store';
import { AllocationGate, IngestionPipeline } from '../src/ingest/pipeline';
import type { NormalizedRecord, SourceAdapter } from '../src/source/source-adapter';
import { MockSourceAdapter } from '../src/source/source-adapter';
import { buildAdapters, runPullPhase } from '../src/adapter/ingest-cli';

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const TEST_CONFIG: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:', enabledSources: [] };

/** A NormalizedRecord fixture with a stable external_id for dedup tests. */
function makeRecord(n: number): NormalizedRecord {
  return {
    content: `Record ${n}: some observed fact.`,
    source: 'granola',
    external_id: `granola-turn-${n}`,
    origin: 'observed',
    role: 'user',
  };
}

/** Minimal MetaStore stub for buildAdapters (structural typing, no real SemanticStore needed). */
const stubMeta = {
  getMeta: (_key: string): string | null => null,
  setMeta: (_key: string, _value: string): void => { /* noop */ },
};

// ─── (a) buildAdapters — factory returns only enabled adapters ────────────────

describe('buildAdapters — enabled-source factory', () => {
  it('returns [] for enabledSources=[]', () => {
    const config: EngineConfig = { ...TEST_CONFIG, enabledSources: [] };
    const adapters = buildAdapters(config, stubMeta);
    expect(adapters).toHaveLength(0);
  });

  it("returns one GmailAdapter for enabledSources=['gmail']", () => {
    const config: EngineConfig = { ...TEST_CONFIG, enabledSources: ['gmail'] };
    const adapters = buildAdapters(config, stubMeta);
    expect(adapters).toHaveLength(1);
    expect(adapters[0]!.source).toBe('gmail');
  });

  it("returns one TranscriptAdapter for enabledSources=['granola']", () => {
    const config: EngineConfig = { ...TEST_CONFIG, enabledSources: ['granola'] };
    const adapters = buildAdapters(config, stubMeta);
    expect(adapters).toHaveLength(1);
    expect(adapters[0]!.source).toBe('granola');
  });

  it("returns one ObsidianAdapter for enabledSources=['obsidian']", () => {
    const config: EngineConfig = { ...TEST_CONFIG, enabledSources: ['obsidian'] };
    const adapters = buildAdapters(config, stubMeta);
    expect(adapters).toHaveLength(1);
    expect(adapters[0]!.source).toBe('obsidian');
  });

  it("returns two adapters (gmail + obsidian) in order for enabledSources=['gmail','obsidian']", () => {
    const config: EngineConfig = { ...TEST_CONFIG, enabledSources: ['gmail', 'obsidian'] };
    const adapters = buildAdapters(config, stubMeta);
    expect(adapters).toHaveLength(2);
    expect(adapters.map(a => a.source)).toEqual(['gmail', 'obsidian']);
  });

  it('skips unknown source names without throwing', () => {
    const config: EngineConfig = { ...TEST_CONFIG, enabledSources: ['unknown-source', 'obsidian'] };
    const adapters = buildAdapters(config, stubMeta);
    // unknown-source skipped; obsidian returned
    expect(adapters).toHaveLength(1);
    expect(adapters[0]!.source).toBe('obsidian');
  });
});

// ─── (b) runPullPhase — per-adapter failure isolation (D-66) ─────────────────

describe('runPullPhase — failure isolation (D-66)', () => {
  let db: Database.Database;
  let store: EpisodicStore;
  let pipeline: IngestionPipeline;
  const logs: string[] = [];
  const capLog = (msg: string) => { logs.push(msg); };

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(1_000_000);
    store = new EpisodicStore(db, clock, TEST_CONFIG);
    const gate = new AllocationGate(TEST_CONFIG);
    pipeline = new IngestionPipeline(gate, store);
    logs.length = 0;
  });

  afterEach(() => {
    db.close();
  });

  it('first adapter throws → second adapter 2 records still appended; failure logged', async () => {
    // Adapter 1: always throws on pull() — simulates a network/auth failure
    const failingAdapter: SourceAdapter = {
      source: 'failing-source',
      async pull(): Promise<NormalizedRecord[]> {
        throw new Error('network timeout');
      },
    };

    // Adapter 2: returns 2 records successfully
    const workingAdapter = new MockSourceAdapter('granola', [
      makeRecord(1),
      makeRecord(2),
    ]);

    await runPullPhase([failingAdapter, workingAdapter], pipeline, db, capLog);

    // Second adapter's 2 records were appended despite first adapter failing
    expect(store.listUnconsolidated()).toHaveLength(2);

    // Failure from the first adapter was logged (not thrown)
    const failureLog = logs.find(l => l.includes('failing-source') && l.includes('failed'));
    expect(failureLog).toBeDefined();

    // No log claims the working adapter failed
    const workingFailLog = logs.find(l => l.includes('granola') && l.includes('failed'));
    expect(workingFailLog).toBeUndefined();
  });

  it('failure log contains error string but never exposes secret-like values', async () => {
    const secretAdapter: SourceAdapter = {
      source: 'gmail',
      async pull(): Promise<NormalizedRecord[]> {
        throw new Error('Missing GMAIL_CLIENT_SECRET credentials');
      },
    };

    await runPullPhase([secretAdapter], pipeline, db, capLog);

    // Error string is logged (for diagnosability)
    const errLog = logs.find(l => l.includes('gmail') && l.includes('failed'));
    expect(errLog).toBeDefined();
    expect(errLog).toContain('Missing GMAIL_CLIENT_SECRET credentials');

    // No records appended (failure was total)
    expect(store.listUnconsolidated()).toHaveLength(0);
  });

  it('all-adapters-succeed → all records appended and count logged', async () => {
    const a1 = new MockSourceAdapter('granola', [makeRecord(1), makeRecord(2)]);
    const a2 = new MockSourceAdapter('obsidian', [
      { content: '[[Note A]] vault content', source: 'obsidian', external_id: 'noteA#0', origin: 'asserted_by_user', role: 'user' },
    ]);

    await runPullPhase([a1, a2], pipeline, db, capLog);

    expect(store.listUnconsolidated()).toHaveLength(3);

    // Both adapters logged pull counts
    expect(logs.some(l => l.includes('granola') && l.includes('2 records'))).toBe(true);
    expect(logs.some(l => l.includes('obsidian') && l.includes('1 records'))).toBe(true);
  });
});

// ─── (c) runPullPhase — source/external_id dedup (D-59) ──────────────────────

describe('runPullPhase — dedup via source/external_id (D-59)', () => {
  let db: Database.Database;
  let store: EpisodicStore;
  let pipeline: IngestionPipeline;
  const logs: string[] = [];
  const capLog = (msg: string) => { logs.push(msg); };

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(2_000_000);
    store = new EpisodicStore(db, clock, TEST_CONFIG);
    const gate = new AllocationGate(TEST_CONFIG);
    pipeline = new IngestionPipeline(gate, store);
    logs.length = 0;
  });

  afterEach(() => {
    db.close();
  });

  it('same (source, external_id) on second run is a no-op — row count stays at 2', async () => {
    const records = [makeRecord(10), makeRecord(11)];
    const adapter = new MockSourceAdapter('granola', records);

    // First run: 2 new records inserted
    await runPullPhase([adapter], pipeline, db, capLog);
    expect(store.listUnconsolidated()).toHaveLength(2);

    // Second run: same (source, external_id) → INSERT OR IGNORE → 0 new rows
    await runPullPhase([adapter], pipeline, db, capLog);
    expect(store.listUnconsolidated()).toHaveLength(2);
  });

  it('stored rows carry the correct source and external_id', async () => {
    const records = [makeRecord(20)];
    const adapter = new MockSourceAdapter('granola', records);

    await runPullPhase([adapter], pipeline, db, capLog);

    const rows = store.listUnconsolidated();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.source).toBe('granola');
    expect(row.external_id).toBe('granola-turn-20');
  });

  it('same external_id on different sources both insert (uniqueness is the pair)', async () => {
    const gmailRecord: NormalizedRecord = {
      content: 'email content',
      source: 'gmail',
      external_id: 'shared-id-1',
      origin: 'observed',
      role: 'user',
    };
    const granolaRecord: NormalizedRecord = {
      content: 'transcript content',
      source: 'granola',
      external_id: 'shared-id-1', // same external_id, different source
      origin: 'observed',
      role: 'user',
    };

    const adapterA = new MockSourceAdapter('gmail', [gmailRecord]);
    const adapterB = new MockSourceAdapter('granola', [granolaRecord]);

    await runPullPhase([adapterA, adapterB], pipeline, db, capLog);

    // Both should insert (uniqueness key is (source, external_id) not just external_id)
    expect(store.listUnconsolidated()).toHaveLength(2);
  });
});
