/**
 * Echo-detection tests (LEARN-03, D-44/D-45).
 *
 * Covers:
 *   1. EpisodicStore primitives — listRecentInferred + backfillSourceInferenceId
 *   2. Backfill — a turn echoing a recent inferred episode has source_inference_id set
 *      after consolidate()
 *
 * Extends in Task 2 with guard-exclusion, recency-window, and non-echo control cases.
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
import { MockEmbedder } from '../src/model/embedder';
import { MockJudge } from '../src/model/judge';
import { MockClaimExtractor } from '../src/model/claim-extractor';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';

// ---------------------------------------------------------------------------
// Embedder helpers
// ---------------------------------------------------------------------------

/** All texts → [1, 0, 0, ...] — cosine similarity 1.0 between any two vectors. */
function makeAlwaysSameEmbedder(dims: number): MockEmbedder {
  return new MockEmbedder((_text: string) => {
    const vec = new Float32Array(dims);
    vec[0] = 1.0;
    return vec;
  });
}

/** All texts → [0, 0, 0, ...] — cosine similarity 0 (denom guard returns 0). */
function makeZeroEmbedder(dims: number): MockEmbedder {
  return new MockEmbedder((_text: string) => new Float32Array(dims));
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Harness {
  db: Database.Database;
  clock: FakeClock;
  episodes: EpisodicStore;
  store: SemanticStore;
  strength: StrengthDecayManager;
  retriever: CandidateRetriever;
  config: EngineConfig;
}

function makeHarness(): Harness {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const config: EngineConfig = {
    ...DEFAULT_CONFIG,
    dbPath: ':memory:',
    // Process all episodes regardless of salience (no skip noise in these tests)
    consolSkipThreshold: 0.0,
    consolSkipThresholdAssistant: 0.0,
    echoSimilarityThreshold: 0.85,
    echoRecencyWindowMs: 86_400_000, // 24 h
    unrelatedSimilarityThreshold: 0.3,
    candidateK: 5,
  };
  const store = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, episodes, store, strength, retriever, config };
}

function makeNoOpSchemaInducer(h: Harness): SchemaInducer {
  const noOpEmbedder = new MockEmbedder(
    (_text: string) => new Float32Array(h.config.embeddingDimensions),
  );
  return new SchemaInducer(
    h.db, h.store, h.strength, h.retriever, noOpEmbedder, h.config, h.clock,
    async (_values: string[]) => 'no-op-schema',
  );
}

function makeConsolidator(h: Harness, embedder: MockEmbedder): Consolidator {
  // Claims that reference a nonexistent node → auto-unrelated (no judge call needed)
  const extractor = new MockClaimExtractor([]);
  const judge = new MockJudge([]);
  return new Consolidator(
    h.db, h.episodes, h.store, h.strength, h.retriever,
    embedder, judge, extractor,
    makeNoOpSchemaInducer(h), h.config, h.clock,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EpisodicStore echo primitives', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('listRecentInferred returns inferred episodes with ts >= sinceMs, newest first', () => {
    const t0 = Date.UTC(2026, 0, 1);       // 00:00
    const t1 = Date.UTC(2026, 0, 1, 12);   // 12:00 same day
    const t2 = Date.UTC(2026, 0, 2);       // next day

    h.clock.setNow(t0);
    const ep0 = h.episodes.append({
      content: 'inferred ep early',
      origin: 'inferred',
      salience: 0,
      hard_keep: 0,
      role: 'assistant',
      session_id: 's',
    });

    h.clock.setNow(t1);
    const ep1 = h.episodes.append({
      content: 'inferred ep late',
      origin: 'inferred',
      salience: 0,
      hard_keep: 0,
      role: 'assistant',
      session_id: 's',
    });

    h.clock.setNow(t2);
    // Observed episode — should never appear in listRecentInferred
    h.episodes.append({
      content: 'observed ep',
      origin: 'observed',
      salience: 0.5,
      hard_keep: 0,
      role: 'user',
      session_id: 's',
    });

    // Query from t0 — both inferred episodes qualify
    const all = h.episodes.listRecentInferred(t0);
    expect(all).toHaveLength(2);
    expect(all.every(e => e.origin === 'inferred')).toBe(true);
    // Newest first (ORDER BY ts DESC)
    expect(all[0]!.id).toBe(ep1.id);
    expect(all[1]!.id).toBe(ep0.id);

    // Query from t1 — only the later episode qualifies
    const recent = h.episodes.listRecentInferred(t1);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.id).toBe(ep1.id);
  });

  it('backfillSourceInferenceId sets source_inference_id on an existing episode', () => {
    const inferredEp = h.episodes.append({
      content: 'the inference',
      origin: 'inferred',
      salience: 0,
      hard_keep: 0,
      role: 'assistant',
      session_id: 's',
    });

    h.clock.advanceMs(1000);
    const turnEp = h.episodes.append({
      content: 'turn that echoes',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 's',
    });

    // Initially null
    expect(turnEp.source_inference_id).toBeNull();

    h.episodes.backfillSourceInferenceId(turnEp.id, inferredEp.id);

    const refreshed = h.episodes.getEpisode(turnEp.id);
    expect(refreshed?.source_inference_id).toBe(inferredEp.id);
  });
});

describe('echo detection via consolidate()', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('Backfill: an echoing turn gets source_inference_id set to the inferred episode id', async () => {
    // Append an inferred-origin episode (the prior inference)
    const inferredEp = h.episodes.append({
      content: 'Max tends to use TypeScript',
      origin: 'inferred',
      salience: 0,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'session-inference',
    });

    // Advance clock slightly (well within the 24-h window)
    h.clock.advanceMs(1_000);

    // A later user turn — identical content, will embed to same vector (cosine 1.0)
    const echoTurn = h.episodes.append({
      content: 'Max tends to use TypeScript',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 1,
      role: 'user',
      session_id: 'session-echo',
    });

    // makeAlwaysSameEmbedder: every text → [1,0,...] → cosine(turn, inferred) = 1.0 ≥ 0.85
    const embedder = makeAlwaysSameEmbedder(h.config.embeddingDimensions);
    const consolidator = makeConsolidator(h, embedder);

    await consolidator.consolidate();

    const updated = h.episodes.getEpisode(echoTurn.id);
    expect(updated?.source_inference_id).toBe(inferredEp.id);
  });
});
