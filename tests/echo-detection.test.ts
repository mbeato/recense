/**
 * Echo-detection tests (LEARN-03, D-44/D-45).
 *
 * Four cases:
 *   1. EpisodicStore primitives — listRecentInferred + backfillSourceInferenceId
 *   2. Backfill — a turn echoing a recent inferred episode has source_inference_id set
 *      after consolidate()
 *   3. Guard exclusion — because source_inference_id is backfilled, the existing
 *      consolidator guard (episodeSourceInferenceId === null) prevents both
 *      recordContradiction and strengthen — the echo can neither destabilize nor
 *      strengthen a fact
 *   4. Recency window — inferred episodes outside echoRecencyWindowMs are ignored;
 *      the later turn is processed normally (not backfilled)
 *   5. Non-echo control — a turn whose embedding is unrelated (cosine 0) is never backfilled
 *
 * Phase-5 Plan-02 migration: Consolidator now takes a single ModelProvider instead of
 * separate Embedder/Judge/ClaimExtractor. Tests use MockModelProvider.
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
import type { JudgeVerdict } from '../src/model/judge';
import { MockModelProvider } from '../src/model/provider';
import type { ModelProvider } from '../src/model/provider';
import type { PendingContradiction } from '../src/lib/types';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { newId } from '../src/lib/hash';

// ---------------------------------------------------------------------------
// Embed function helpers — return raw (text: string) => Float32Array for MockModelProvider
// ---------------------------------------------------------------------------

/** All texts → [1, 0, 0, ...] — cosine similarity 1.0 between any two vectors. */
function makeAlwaysSameEmbedFn(dims: number): (text: string) => Float32Array {
  return (_text: string) => {
    const vec = new Float32Array(dims);
    vec[0] = 1.0;
    return vec;
  };
}

/** All texts → [0, 0, 0, ...] — cosine similarity 0 (denom guard returns 0). */
function makeZeroEmbedFn(dims: number): (text: string) => Float32Array {
  return (_text: string) => new Float32Array(dims);
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
    // Process all user/tool episodes; skip low-salience assistant episodes.
    // Inferred episodes use role='assistant' with salience=0 → skipped automatically,
    // so they never pollute the test by going through claim extraction.
    consolSkipThreshold: 0.0,
    consolSkipThresholdAssistant: 0.5,
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

/**
 * No-op SchemaInducer for echo tests.
 * SchemaInducer now takes a ModelProvider; embed/generate heads unused when namingFn bypasses
 * the LLM. Empty MockModelProvider suffices.
 */
function makeNoOpSchemaInducer(h: Harness): SchemaInducer {
  return new SchemaInducer(
    h.db, h.store, h.strength, h.retriever,
    new MockModelProvider(),
    h.config, h.clock,
    async (_values: string[]) => 'no-op-schema',
  );
}

/** Build a Consolidator from a ModelProvider. */
function makeConsolidator(h: Harness, provider: ModelProvider): Consolidator {
  return new Consolidator(
    h.db, h.episodes, h.store, h.strength, h.retriever,
    provider,
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

    // Echo guard fires (cosine 1.0 ≥ 0.85) → episode short-circuited → generate never called
    const provider = new MockModelProvider({
      embedFn: makeAlwaysSameEmbedFn(h.config.embeddingDimensions),
      generateScript: [],  // never consumed — echo guard short-circuits the episode
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);

    await consolidator.consolidate();

    const updated = h.episodes.getEpisode(echoTurn.id);
    expect(updated?.source_inference_id).toBe(inferredEp.id);
  });

  it('Guard exclusion: echo turn cannot record a contradiction or strengthen a fact', async () => {
    // Seed a fact node (dirty — reembedDirty() will embed it during consolidate())
    const factNodeId = newId();
    h.store.upsertNode({
      id: factNodeId,
      type: 'fact',
      value: 'I use Python for data work',  // different from the claim below → judge needed
      origin: 'observed',
      s: 0.1,  // resistance = s × c = 0.05
      c: 0.5,
    });

    // Prior inferred episode (within the recency window)
    const inferredEp = h.episodes.append({
      content: 'I use TypeScript for data work',
      origin: 'inferred',
      salience: 0,
      hard_keep: 0,
      role: 'assistant',        // salience 0 + assistant → skipped by consolSkipThresholdAssistant
      session_id: 'session-inf',
    });

    h.clock.advanceMs(1_000);

    // The echo turn: observed, restates the inference content
    const echoTurn = h.episodes.append({
      content: 'I use TypeScript for data work',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 1,
      role: 'user',
      session_id: 'session-echo',
    });

    // All embeddings → [1,0,...]:
    //   - echo detection: cosine(echo turn, inferred ep) = 1.0 ≥ 0.85 → backfill
    //   - topk: cosine(claim vec, fact node vec) = 1.0 > 0.3 → escalate to judge
    // Echo guard fires → episode short-circuited → generate and judge are NEVER called
    const contradictVerdict: JudgeVerdict = {
      relation: 'contradict',
      magnitude: 0.01,
      best_candidate_id: factNodeId,
    };
    const provider = new MockModelProvider({
      embedFn: makeAlwaysSameEmbedFn(h.config.embeddingDimensions),
      // Scripts provided to prove guard fires before consumption (queue never touched)
      generateScript: [JSON.stringify([{ type: 'fact', value: 'I use TypeScript for data work' }])],
      judgeScript: [contradictVerdict],
    });

    const consolidator = makeConsolidator(h, provider);

    const factBefore = h.store.getNode(factNodeId)!;
    const sBefore = factBefore.s;

    await consolidator.consolidate();

    // The echo turn's source_inference_id must be backfilled (guard precondition confirmed)
    const updatedEcho = h.episodes.getEpisode(echoTurn.id);
    expect(updatedEcho?.source_inference_id).toBe(inferredEp.id);

    const updatedFact = h.store.getNode(factNodeId)!;

    // No pending_contradiction recorded — guard fired because episodeSourceInferenceId !== null
    const pending = JSON.parse(updatedFact.pending_contradictions) as PendingContradiction[];
    expect(pending).toHaveLength(0);

    // Strength unchanged — echo can neither strengthen (no confirm) nor destabilize (guard)
    expect(updatedFact.s).toBe(sBefore);
  });

  it('confirm path: echo turn fast-path-confirms a fact but s and c stay unchanged', async () => {
    // CR-01 RED test: before the fix, the echo turn's claim routes through the D-17 fast path
    // (exact normalized match → confirm) and calls strengthen(), incrementing s and c.
    // After the fix, the episode is short-circuited before claim processing and s/c stay unchanged.

    const factNodeId = newId();
    const factValue = 'Max uses TypeScript';

    // Seed the fact node; reembedDirty() will embed it during consolidate()
    h.store.upsertNode({
      id: factNodeId,
      type: 'fact',
      value: factValue,
      origin: 'observed',
      s: 0.3,
      c: 0.7,
    });

    // Prior inferred episode (within recency window)
    h.episodes.append({
      content: factValue,
      origin: 'inferred',
      salience: 0,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'session-inf',
    });

    h.clock.advanceMs(1_000);

    // Echo turn — same value, so D-17 fast path would confirm the fact node IF guard didn't fire
    h.episodes.append({
      content: factValue,
      origin: 'observed',
      salience: 0.8,
      hard_keep: 1,
      role: 'user',
      session_id: 'session-echo',
    });

    // Echo guard fires → processing short-circuited → generate never called
    const provider = new MockModelProvider({
      embedFn: makeAlwaysSameEmbedFn(h.config.embeddingDimensions),
      generateScript: [JSON.stringify([{ type: 'fact', value: factValue }])], // never consumed
      judgeScript: [],
    });

    const consolidator = makeConsolidator(h, provider);

    const factBefore = h.store.getNode(factNodeId)!;
    const sBefore = factBefore.s;
    const cBefore = factBefore.c;

    await consolidator.consolidate();

    const factAfter = h.store.getNode(factNodeId)!;
    // Guard must prevent strengthen — s and c must be unchanged (CR-01 self-confirmation guard)
    expect(factAfter.s).toBe(sBefore);
    expect(factAfter.c).toBe(cBefore);
  });

  it('unrelated path: echo turn classified unrelated mints no new node', async () => {
    // CR-01 RED test: before the fix, the echo turn's claim auto-routes to unrelated
    // (no graph nodes → topk returns [] → candidates.length === 0) and calls upsertNode,
    // minting a new node. After the fix, the episode is short-circuited before processing.

    // No existing nodes — topk returns 0 candidates → auto-unrelated (no judge call needed)

    // Prior inferred episode
    h.episodes.append({
      content: 'Max is a great developer',
      origin: 'inferred',
      salience: 0,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'session-inf',
    });

    h.clock.advanceMs(1_000);

    // Echo turn — same content as inferred episode
    h.episodes.append({
      content: 'Max is a great developer',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 1,
      role: 'user',
      session_id: 'session-echo',
    });

    // Echo guard fires → processing short-circuited → generate never called, no node minted
    const provider = new MockModelProvider({
      embedFn: makeAlwaysSameEmbedFn(h.config.embeddingDimensions),
      generateScript: [JSON.stringify([{ type: 'fact', value: 'Max is a great developer' }])], // never consumed
      judgeScript: [],
    });

    const consolidator = makeConsolidator(h, provider);

    const nodesBefore = h.db.prepare('SELECT COUNT(*) as count FROM node').get() as { count: number };
    expect(nodesBefore.count).toBe(0);

    await consolidator.consolidate();

    // Echo guard must prevent node minting — no new node should exist (CR-01)
    const nodesAfter = h.db.prepare('SELECT COUNT(*) as count FROM node').get() as { count: number };
    expect(nodesAfter.count).toBe(0);
  });

  it('Recency window: out-of-window inferred episode is ignored and turn is not backfilled', async () => {
    // Append an inferred episode at t=0
    h.episodes.append({
      content: 'Max uses Rust',
      origin: 'inferred',
      salience: 0,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'session-inf',
    });

    // Advance clock by echoRecencyWindowMs + 1 ms — the inferred episode is now outside the window
    h.clock.advanceMs(h.config.echoRecencyWindowMs + 1);

    // Append the echo turn — same content but now the inferred episode is stale
    const echoTurn = h.episodes.append({
      content: 'Max uses Rust',    // would match, but inferred ep is outside the window
      origin: 'observed',
      salience: 0.8,
      hard_keep: 1,
      role: 'user',
      session_id: 'session-echo',
    });

    // Inferred ep outside window → no backfill → episode IS processed normally → generate called
    // No existing graph nodes → auto-unrelated → no judge call → '[]' claims (no nodes minted)
    const provider = new MockModelProvider({
      embedFn: makeAlwaysSameEmbedFn(h.config.embeddingDimensions),
      generateScript: ['[]'],  // episode processed normally; empty claims → no nodes, no judge
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);

    await consolidator.consolidate();

    // source_inference_id remains null — the inferred episode was outside the recency window
    const updated = h.episodes.getEpisode(echoTurn.id);
    expect(updated?.source_inference_id).toBeNull();

    // The echo turn WAS processed normally (consolidated=1)
    expect(updated?.consolidated).toBe(1);
  });

  it('Non-echo control: an unrelated turn (cosine 0) is never backfilled', async () => {
    // Append a prior inferred episode
    h.episodes.append({
      content: 'Max works on a memory engine',
      origin: 'inferred',
      salience: 0,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'session-inf',
    });

    h.clock.advanceMs(1_000);

    // An unrelated turn
    const unrelatedTurn = h.episodes.append({
      content: 'Completely different topic',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 1,
      role: 'user',
      session_id: 'session-unrelated',
    });

    // Zero embedder: cosine(zero, zero) = 0 < 0.85 → no echo backfill
    // Episode processed normally → generate called → '[]' (no claims, no judge)
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: ['[]'],  // episode processed normally; empty claims → no nodes
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);

    await consolidator.consolidate();

    // source_inference_id is still null — cosine was below echoSimilarityThreshold
    const updated = h.episodes.getEpisode(unrelatedTurn.id);
    expect(updated?.source_inference_id).toBeNull();
  });
});
