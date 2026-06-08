/**
 * Integration tests for source-aware ingestion + consolidation (D-57/D-60).
 *
 * Tests two properties added in 06-03:
 *   (a) gmail-source episode salience is lower than the same content scored as
 *       claude-code — sourceWeight applied post-cap (D-60 honest gate).
 *   (b) Re-calling recordEvent with the same (source='gmail', externalId) returns
 *       the original row without inserting a duplicate (dedup via 06-01 / D-59).
 *
 * Reuses the consolidator test harness (in-memory DB, FakeClock, MockModelProvider).
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { EpisodicStore } from '../src/db/episode-store';
import { StrengthDecayManager } from '../src/strength/decay';
import { CandidateRetriever } from '../src/retrieval/topk';
import { MockModelProvider } from '../src/model/provider';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { AllocationGate } from '../src/gate/allocation-gate';
import { IngestionPipeline } from '../src/ingest/pipeline';

// ---------------------------------------------------------------------------
// Harness helpers (mirrors tests/consolidation.test.ts)
// ---------------------------------------------------------------------------

/** Hash-seeded synthetic embed: deterministic, no network. */
function makeSyntheticEmbedFn(dims: number): (text: string) => Float32Array {
  return (text: string) => {
    const vec = new Float32Array(dims);
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) >>> 0;
    }
    vec[hash % dims] = 1.0;
    return vec;
  };
}

interface Harness {
  db: Database.Database;
  clock: FakeClock;
  episodes: EpisodicStore;
  store: SemanticStore;
  strength: StrengthDecayManager;
  retriever: CandidateRetriever;
  gate: AllocationGate;
  pipeline: IngestionPipeline;
  config: EngineConfig;
}

function makeHarness(): Harness {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const config: EngineConfig = {
    ...DEFAULT_CONFIG,
    dbPath: ':memory:',
    consolSkipThreshold: 0.2,
    unrelatedSimilarityThreshold: 0.3,
    candidateK: 5,
  };
  const store = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  const gate = new AllocationGate(config);
  const pipeline = new IngestionPipeline(gate, episodes);
  return { db, clock, episodes, store, strength, retriever, gate, pipeline, config };
}

function makeNoOpSchemaInducer(h: Harness, provider: MockModelProvider): SchemaInducer {
  return new SchemaInducer(
    h.db, h.store, h.strength, h.retriever,
    provider,
    h.config, h.clock,
    async (_values: string[]) => 'no-op-schema',
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Source-aware ingestion: D-57/D-60 (gmail sourceWeight + dedup)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  // ── (a) Gmail salience is lower than equivalent claude-code salience ────────

  it('gmail episode has lower salience than the same content scored as claude-code (D-60)', () => {
    const content = 'the decision was made to adopt TypeScript across the project';

    const gmailRow = h.pipeline.recordEvent({
      content,
      role: 'user',
      origin: 'observed',
      sessionId: 'sess-gmail',
      source: 'gmail',
      externalId: 'm42',
    });

    const claudeCodeRow = h.pipeline.recordEvent({
      content,
      role: 'user',
      origin: 'observed',
      sessionId: 'sess-cc',
      // source omitted → defaults to 'claude-code'
    });

    // sourceWeight('gmail')=0.35 applied post-cap → gmail salience < claude-code salience (D-60)
    expect(gmailRow.salience).toBeLessThan(claudeCodeRow.salience);
    // Sanity: both are non-zero (gate is honest, not silent, D-03)
    expect(gmailRow.salience).toBeGreaterThan(0);
    expect(claudeCodeRow.salience).toBeGreaterThan(0);
  });

  it('gmail episode source field is persisted correctly (D-57)', () => {
    const row = h.pipeline.recordEvent({
      content: 'a meeting note from email',
      role: 'user',
      origin: 'observed',
      sessionId: 'sess-src',
      source: 'gmail',
      externalId: 'm99',
    });

    expect(row.source).toBe('gmail');
    expect(row.external_id).toBe('m99');
  });

  // ── (b) Dedup: same (source, externalId) does not insert a second row ──────

  it('dedup: second recordEvent with same (source, externalId) returns the original row (D-59)', () => {
    const first = h.pipeline.recordEvent({
      content: 'decision: adopt TypeScript',
      role: 'user',
      origin: 'observed',
      sessionId: 'sess-dup',
      source: 'gmail',
      externalId: 'm1',
    });

    const second = h.pipeline.recordEvent({
      content: 'decision: adopt TypeScript',
      role: 'user',
      origin: 'observed',
      sessionId: 'sess-dup',
      source: 'gmail',
      externalId: 'm1',
    });

    // Dedup: second call returns the pre-existing row (same id, no new insert)
    expect(second.id).toBe(first.id);
    // Only one unconsolidated episode in the store
    expect(h.episodes.listUnconsolidated()).toHaveLength(1);
  });

  it('no dedup when externalId is null — every call inserts unconditionally (INGEST-01)', () => {
    h.pipeline.recordEvent({
      content: 'event alpha',
      role: 'user',
      origin: 'observed',
      sessionId: 'sess-nodp',
      source: 'gmail',
      // externalId omitted → null → INSERT OR IGNORE treats NULLs as distinct
    });

    h.pipeline.recordEvent({
      content: 'event alpha',
      role: 'user',
      origin: 'observed',
      sessionId: 'sess-nodp',
      source: 'gmail',
      // externalId omitted again → second null is distinct from first null
    });

    expect(h.episodes.listUnconsolidated()).toHaveLength(2);
  });

  // ── Consolidator integration: source-aware skip threshold (D-60) ──────────

  it('consolidator runs end-to-end on a source-attributed episode without error', async () => {
    // Append a gmail episode (expected to be below consolSkipThresholdBySource.gmail=0.4)
    h.pipeline.recordEvent({
      content: 'hi there',
      role: 'user',
      origin: 'observed',
      sessionId: 'sess-consol',
      source: 'gmail',
      externalId: 'msg-1',
    });

    const provider = new MockModelProvider({
      embedFn: makeSyntheticEmbedFn(h.config.embeddingDimensions),
      generateScript: [JSON.stringify([{ type: 'fact', value: 'never reached — gmail skipped' }])],
      judgeScript: [],
    });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever,
      provider, makeNoOpSchemaInducer(h, provider), h.config, h.clock,
    );

    // Must complete without throwing
    await expect(consolidator.consolidate()).resolves.toBeUndefined();

    // gmail sourceWeight=0.35 → salience is very low; consolSkipThresholdBySource.gmail=0.4
    // The episode is skipped by the per-source threshold and stays unconsolidated
    expect(h.episodes.listUnconsolidated()).toHaveLength(1);
    // generate() was not consumed (episode was skipped)
    // provider.generateScript had 1 item; if it had been consumed the next call would throw
  });
});
