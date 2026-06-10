/**
 * Behavioral tests for the Consolidator (offline sleep pass).
 * Covers: CONSOL-01/02/03, UPDATE-01/02/03/04/05 (all routes including
 * PE-gated reconcile, append-new, force-destabilize, oscillation guard).
 *
 * Harness mirrors tests/seeder.test.ts: in-memory Database, initSchema, FakeClock,
 * DEFAULT_CONFIG, and fully deterministic mocks (no network).
 *
 * Phase-2 ROADMAP criteria proven through the integrated path:
 *   Criterion 1 — changed fact reconciles (tombstoned old, new current, excluded from topk)
 *   Criterion 3 — N distinct-session contradictions force-destabilize regardless of strength
 *   Criterion 5 — two real reconciles: flip-back escalates to append-new (oscillation guard)
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
import { MockEmbedder } from '../src/model/embedder';
import type { JudgeVerdict } from '../src/model/judge';
import { MockModelProvider } from '../src/model/provider';
import type { ModelProvider } from '../src/model/provider';
import type { NodeRow, PendingContradiction } from '../src/lib/types';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { MockConsolidationSink } from '../src/consolidation/sink';
import { newId } from '../src/lib/hash';

// ---------------------------------------------------------------------------
// SchemaInducer stub for consolidation tests
// ---------------------------------------------------------------------------

/**
 * Returns a no-op SchemaInducer for consolidation tests.
 * SchemaInducer now takes a ModelProvider — embed head unused in induceSchemas(),
 * namingFn bypasses generate head. No-op provider suffices.
 */
function makeNoOpSchemaInducer(h: Harness): SchemaInducer {
  return new SchemaInducer(
    h.db, h.store, h.strength, h.retriever,
    new MockModelProvider(),  // embed/generate heads unused when namingFn is provided
    h.config, h.clock,
    async (_values: string[]) => 'no-op-schema',
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Hash-seeded synthetic embed function: maps text to a deterministic Float32Array.
 * Two texts with the same content produce cosine similarity 1.0; different texts near-zero.
 */
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

/** Returns the same unit vector regardless of text — simulates cosine > threshold. */
function makeAlwaysSameEmbedFn(dims: number): (text: string) => Float32Array {
  return (_text: string) => {
    const vec = new Float32Array(dims);
    vec[0] = 1.0;
    return vec;
  };
}

/** Returns a zero-vector — cosine similarity 0. */
function makeZeroEmbedFn(dims: number): (text: string) => Float32Array {
  return (_text: string) => new Float32Array(dims);
}

/**
 * Hash-seeded synthetic embedder: kept for standalone pre-seeding of node embeddings.
 */
function makeSyntheticEmbedder(dims: number): MockEmbedder {
  return new MockEmbedder(makeSyntheticEmbedFn(dims));
}

function makeAlwaysSameEmbedder(dims: number): MockEmbedder {
  return new MockEmbedder(makeAlwaysSameEmbedFn(dims));
}

function makeZeroEmbedder(dims: number): MockEmbedder {
  return new MockEmbedder(makeZeroEmbedFn(dims));
}

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
    // Lower thresholds so test values clearly straddle them
    consolSkipThreshold: 0.2,
    unrelatedSimilarityThreshold: 0.3,
    candidateK: 5,
  };
  const store = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, episodes, store, strength, retriever, config };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Consolidator', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  // ── CONSOL-01: salience skip ─────────────────────────────────────────────

  it('CONSOL-01 skip: low-salience non-hard-keep episode produces no claims or decisions', async () => {
    // generateScript: non-empty but should never be consumed (episode is skipped)
    const provider = new MockModelProvider({
      embedFn: makeSyntheticEmbedFn(h.config.embeddingDimensions),
      generateScript: [JSON.stringify([{ type: 'fact', value: 'should be skipped' }])],
      judgeScript: [],
    });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'low salience content',
      origin: 'observed',
      // Below consolSkipThreshold (0.2) and hard_keep=0 → should be skipped
      salience: 0.1,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-skip',
    });

    await consolidator.consolidate();

    // No nodes should have been appended
    const nodes = h.db.prepare('SELECT * FROM node').all() as NodeRow[];
    expect(nodes).toHaveLength(0);
    // Provider generate was never called (if it were, the queue would be consumed but not throw)
  });

  it('CONSOL-01 hard_keep override: low-salience hard_keep=1 episode IS processed', async () => {
    const provider = new MockModelProvider({
      embedFn: makeSyntheticEmbedFn(h.config.embeddingDimensions),
      generateScript: [JSON.stringify([{ type: 'fact', value: 'hard kept claim' }])],
      judgeScript: [],  // no existing nodes → auto-unrelated, no judge call
    });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'hard keep episode',
      origin: 'observed',
      salience: 0.05, // below threshold
      hard_keep: 1,   // but force-kept
      role: 'user',
      session_id: 'session-hk',
    });

    await consolidator.consolidate();

    const nodes = h.db.prepare('SELECT * FROM node').all() as NodeRow[];
    expect(nodes.length).toBeGreaterThanOrEqual(1);
  });

  // ── UPDATE-03 confirm + origin guard (D-17 fast path) ───────────────────

  it('UPDATE-03 confirm: observed-origin claim fast-path confirms a node and increases s', async () => {
    const nodeId = newId();
    const nodeValue = 'max uses typescript';

    // Seed node first
    h.store.upsertNode({ id: nodeId, type: 'fact', value: nodeValue, origin: 'observed', s: 0.3, c: 0.6 });
    // Embed the node so it can be retrieved
    const embedder = makeSyntheticEmbedder(h.config.embeddingDimensions);
    const [vec] = await embedder.embed([nodeValue]);
    h.store.setEmbedding(nodeId, vec!);

    const nodeRowBefore = h.store.getNode(nodeId)!;
    const sBefore = nodeRowBefore.s;

    // Claim with same (normalized) value → fast path confirm, no judge call
    const provider = new MockModelProvider({
      embedFn: embedder.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: nodeValue }])],
      judgeScript: [],  // D-17 fast path: exact match → confirm, no judge call
    });

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'confirming content',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-confirm',
    });

    await consolidator.consolidate();

    const nodeRowAfter = h.store.getNode(nodeId)!;
    expect(nodeRowAfter.s).toBeGreaterThan(sBefore);
  });

  it('UPDATE-03 inferred-echo: inferred-origin claim CANNOT strengthen a node (s unchanged)', async () => {
    const nodeId = newId();
    const nodeValue = 'inferred echo node';

    h.store.upsertNode({ id: nodeId, type: 'fact', value: nodeValue, origin: 'observed', s: 0.3, c: 0.6 });
    const embedder = makeSyntheticEmbedder(h.config.embeddingDimensions);
    const [vec] = await embedder.embed([nodeValue]);
    h.store.setEmbedding(nodeId, vec!);

    const sBefore = h.store.getNode(nodeId)!.s;

    const provider = new MockModelProvider({
      embedFn: embedder.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: nodeValue }])],
      judgeScript: [],
    });

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    // Episode with origin='inferred' — claim inherits this origin
    h.episodes.append({
      content: 'inferred echo content',
      origin: 'inferred',
      salience: 0.8,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'session-inferred',
    });

    await consolidator.consolidate();

    const sAfter = h.store.getNode(nodeId)!.s;
    // s must NOT change — inferred echo cannot strengthen
    expect(sAfter).toBe(sBefore);
  });

  // ── UPDATE-02 safe-direction: low cosine → auto-unrelated, no judge call ─

  it('UPDATE-02 safe-direction: claim with best-candidate cosine < threshold classifies unrelated without judge call', async () => {
    const nodeId = newId();
    // Seed a node that is already embedded with a very different vector
    h.store.upsertNode({ id: nodeId, type: 'fact', value: 'existing node', origin: 'observed', s: 0.3, c: 0.6 });

    // Use the always-same embedder ONLY for setting the existing node embedding
    const sameEmbedder = makeAlwaysSameEmbedder(h.config.embeddingDimensions);
    const [existingVec] = await sameEmbedder.embed(['existing node']);
    h.store.setEmbedding(nodeId, existingVec!);

    // The claim will be embedded with the zero embedder — cosine(zero, anything) = 0 < 0.3 threshold
    // If judge is called, it will throw (queue exhausted) — proves no judge call
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [JSON.stringify([{ type: 'fact', value: 'completely unrelated claim' }])],
      judgeScript: [],  // empty: if called, throws — proves auto-unrelated path taken
    });

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'unrelated content',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-unrelated-auto',
    });

    // Should not throw (judge queue empty, but judge should not be called)
    await expect(consolidator.consolidate()).resolves.toBeUndefined();

    // A standalone node should be appended
    const nodes = h.db.prepare('SELECT * FROM node').all() as NodeRow[];
    // Should have the original + newly appended standalone node
    expect(nodes.length).toBeGreaterThanOrEqual(2);
  });

  // ── UPDATE-03 extend: judge extend verdict appends node + relation edge ──

  it('UPDATE-03 extend: extend verdict appends new node and a relation edge to the candidate', async () => {
    const candidateId = newId();
    const candidateValue = 'base knowledge node';

    // Seed candidate and embed it with same-vector embedder so cosine > threshold
    h.store.upsertNode({ id: candidateId, type: 'fact', value: candidateValue, origin: 'observed', s: 0.3, c: 0.6 });
    const sameEmbedder = makeAlwaysSameEmbedder(h.config.embeddingDimensions);
    const [vec] = await sameEmbedder.embed([candidateValue]);
    h.store.setEmbedding(candidateId, vec!);

    const extendVerdict: JudgeVerdict = {
      best_candidate_id: candidateId,
      relation: 'extend',
      magnitude: 0,
    };
    const provider = new MockModelProvider({
      embedFn: sameEmbedder.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: 'extension of base node' }])],
      judgeScript: [extendVerdict],
    });

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'extending knowledge',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-extend',
    });

    await consolidator.consolidate();

    const nodes = h.db.prepare('SELECT * FROM node').all() as NodeRow[];
    expect(nodes.length).toBe(2); // original + new extended node

    const edges = h.db.prepare('SELECT * FROM edge').all();
    expect(edges.length).toBeGreaterThanOrEqual(1);

    const edge = h.db
      .prepare('SELECT * FROM edge WHERE src = ? AND kind = ?')
      .get(candidateId, 'relation') as { src: string; dst: string; kind: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge?.src).toBe(candidateId);
  });

  // ── UPDATE-03 unrelated (judge): standalone node, no edge ────────────────

  it('UPDATE-03 unrelated (judge): judge unrelated verdict appends standalone node with no edge', async () => {
    const candidateId = newId();
    h.store.upsertNode({ id: candidateId, type: 'fact', value: 'some node', origin: 'observed', s: 0.3, c: 0.6 });
    const sameEmbedder = makeAlwaysSameEmbedder(h.config.embeddingDimensions);
    const [vec] = await sameEmbedder.embed(['some node']);
    h.store.setEmbedding(candidateId, vec!);

    const unrelatedVerdict: JudgeVerdict = {
      best_candidate_id: null,
      relation: 'unrelated',
      magnitude: 0,
    };
    const provider = new MockModelProvider({
      embedFn: sameEmbedder.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: 'truly unrelated new claim' }])],
      judgeScript: [unrelatedVerdict],
    });

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'something unrelated',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-judge-unrelated',
    });

    await consolidator.consolidate();

    const nodes = h.db.prepare('SELECT * FROM node').all() as NodeRow[];
    expect(nodes.length).toBe(2); // original + new standalone

    const edges = h.db.prepare('SELECT * FROM edge').all();
    expect(edges.length).toBe(0); // no edges
  });

  // ── contradict HOLD (re-audited for D-19 filter) ─────────────────────────
  //
  // These two tests prove the D-19 filter at record time:
  //   (a) a provenance-eligible episode IS recorded (the Plan-02 contract, preserved)
  //   (b) an inferred-origin episode is DROPPED — recordContradiction is NOT called

  it('contradict HOLD: provenance-eligible episode records PendingContradiction; node is NOT tombstoned', async () => {
    // Node: s=0.5, c=0.7 → resistance = 0.35 (no decay — FakeClock, same timestamp)
    // magnitude=0.1 → ratio = 0.1/0.35 ≈ 0.286 < peReconcileBandLow(0.8) → HOLD
    const candidateId = newId();
    h.store.upsertNode({ id: candidateId, type: 'fact', value: 'established fact', origin: 'observed', s: 0.5, c: 0.7 });
    const sameEmbedder = makeAlwaysSameEmbedder(h.config.embeddingDimensions);
    const [vec] = await sameEmbedder.embed(['established fact']);
    h.store.setEmbedding(candidateId, vec!);

    const contradictVerdict: JudgeVerdict = {
      best_candidate_id: candidateId,
      relation: 'contradict',
      magnitude: 0.1, // HOLD band: ratio≈0.29 < 0.8
    };
    const provider = new MockModelProvider({
      embedFn: sameEmbedder.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: 'contradicting claim here' }])],
      judgeScript: [contradictVerdict],
    });

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    // Provenance-eligible episode: origin='observed', source_inference_id=null
    h.episodes.append({
      content: 'contradicting content',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-contradict',
      source_inference_id: null,
    });

    await consolidator.consolidate();

    const node = h.store.getNode(candidateId)!;
    // Node is NOT tombstoned — HOLD (not reconcile)
    expect(node.tombstoned).toBe(0);

    // pending_contradictions must have grown by 1 — provenance-eligible episode IS recorded
    const contradictions = JSON.parse(node.pending_contradictions) as PendingContradiction[];
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]!.session_id).toBe('session-contradict');
    expect(contradictions[0]!.origin).toBe('observed');
  });

  it('contradict HOLD D-19 filter: inferred-origin contradiction is DROPPED — recordContradiction NOT called', async () => {
    // D-19: claimOrigin='inferred' → skip recordContradiction entirely.
    // Inferred echoes cannot inflate the force-destabilization count.
    const candidateId = newId();
    h.store.upsertNode({ id: candidateId, type: 'fact', value: 'well known fact', origin: 'observed', s: 0.5, c: 0.7 });
    const sameEmbedder = makeAlwaysSameEmbedder(h.config.embeddingDimensions);
    const [vec] = await sameEmbedder.embed(['well known fact']);
    h.store.setEmbedding(candidateId, vec!);

    const contradictVerdict: JudgeVerdict = {
      best_candidate_id: candidateId,
      relation: 'contradict',
      magnitude: 0.1, // HOLD band
    };
    // The claim inherits episode.origin='inferred' inside the consolidator
    const provider = new MockModelProvider({
      embedFn: sameEmbedder.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: 'inferred-origin contradiction' }])],
      judgeScript: [contradictVerdict],
    });

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    // Episode with origin='inferred' → claimOrigin is 'inferred' → NOT provenance-eligible (D-19)
    h.episodes.append({
      content: 'inferred contradiction content',
      origin: 'inferred',
      salience: 0.8,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'session-inferred-contradict',
      source_inference_id: null,
    });

    await consolidator.consolidate();

    const node = h.store.getNode(candidateId)!;
    // Node is NOT tombstoned — inferred-origin does not even trigger HOLD recording
    expect(node.tombstoned).toBe(0);

    // pending_contradictions must be EMPTY — inferred contradiction is dropped (D-19)
    const contradictions = JSON.parse(node.pending_contradictions) as PendingContradiction[];
    expect(contradictions).toHaveLength(0);
  });

  // ── CONSOL-02 re-embed dirty nodes ────────────────────────────────────────

  it('CONSOL-02 re-embed: dirty nodes (embedded_hash IS NULL) are embedded after the pass', async () => {
    // Seed nodes without embedding (as cold-start leaves them)
    const nodeId1 = newId();
    const nodeId2 = newId();
    h.store.upsertNode({ id: nodeId1, type: 'fact', value: 'node one to embed', origin: 'observed' });
    h.store.upsertNode({ id: nodeId2, type: 'fact', value: 'node two to embed', origin: 'observed' });

    // Both should start dirty (embedded_hash IS NULL)
    expect(h.store.getNode(nodeId1)!.embedded_hash).toBeNull();
    expect(h.store.getNode(nodeId2)!.embedded_hash).toBeNull();

    // No episodes → generate/judge never called; only embed is needed (for reembedDirty)
    const provider = new MockModelProvider({
      embedFn: makeSyntheticEmbedFn(h.config.embeddingDimensions),
      generateScript: [],
      judgeScript: [],
    });

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    // No episodes to consolidate — but reembedDirty should still run
    await consolidator.consolidate();

    // Both nodes should now have embeddings
    expect(h.store.getNode(nodeId1)!.embedded_hash).not.toBeNull();
    expect(h.store.getNode(nodeId2)!.embedded_hash).not.toBeNull();

    // Should be retrievable via topk now
    const queryVec = new Float32Array(h.config.embeddingDimensions);
    queryVec[0] = 1.0;
    const results = h.retriever.topk(queryVec, 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  // ── CONSOL-02 resumable checkpoint ────────────────────────────────────────

  it('CONSOL-02 resumable: re-running consolidate() after completion is a no-op (no double-apply)', async () => {
    const nodeId = newId();
    const nodeValue = 'resumable test node';
    h.store.upsertNode({ id: nodeId, type: 'fact', value: nodeValue, origin: 'observed', s: 0.3, c: 0.6 });
    const embedder = makeSyntheticEmbedder(h.config.embeddingDimensions);
    const [vec] = await embedder.embed([nodeValue]);
    h.store.setEmbedding(nodeId, vec!);

    // Claim that will fast-path confirm the node
    const provider = new MockModelProvider({
      embedFn: embedder.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: nodeValue }])],
      judgeScript: [],
    });

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'confirming content for resumable test',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-resumable',
    });

    // First run
    await consolidator.consolidate();
    const sAfterFirst = h.store.getNode(nodeId)!.s;

    // Second run — all episodes are now consolidated=1, should be a no-op
    // Need a fresh provider since first run consumed the generate queue
    const provider2 = new MockModelProvider({
      embedFn: embedder.fn,
      generateScript: [],  // no unconsolidated episodes → generate never called
      judgeScript: [],
    });
    const consolidator2 = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider2, makeNoOpSchemaInducer(h), h.config, h.clock,
    );
    await consolidator2.consolidate();
    const sAfterSecond = h.store.getNode(nodeId)!.s;

    expect(sAfterSecond).toBe(sAfterFirst);

    // All episodes should be consolidated
    const unconsolidated = h.episodes.listUnconsolidated();
    expect(unconsolidated).toHaveLength(0);
  });

  it('CONSOL-02 resumable: partial pass (2nd episode generate throws) — 1st committed, 2nd quarantined, resume consolidates 2nd', async () => {
    const nodeId1 = newId();
    const nodeId2 = newId();
    const val1 = 'first confirm node';
    const val2 = 'second confirm node';

    h.store.upsertNode({ id: nodeId1, type: 'fact', value: val1, origin: 'observed', s: 0.3, c: 0.6 });
    h.store.upsertNode({ id: nodeId2, type: 'fact', value: val2, origin: 'observed', s: 0.3, c: 0.6 });

    const embedder = makeSyntheticEmbedder(h.config.embeddingDimensions);
    const [vec1] = await embedder.embed([val1]);
    const [vec2] = await embedder.embed([val2]);
    h.store.setEmbedding(nodeId1, vec1!);
    h.store.setEmbedding(nodeId2, vec2!);

    // Two episodes: first confirms node1, second confirms node2
    const ep1 = h.episodes.append({
      content: 'first episode',
      origin: 'observed',
      salience: 0.9, // higher salience processed first
      hard_keep: 0,
      role: 'user',
      session_id: 'session-resume-1',
    });
    h.episodes.append({
      content: 'second episode',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-resume-2',
    });

    // Inline provider: first generate call returns claims for ep1, second call throws (queue exhausted)
    // MockModelProvider throws "generate queue exhausted" after the 1 scripted response is consumed
    const throwingProvider: ModelProvider = {
      async embed(texts: string[]): Promise<Float32Array[]> {
        return texts.map(embedder.fn);
      },
      async generate(_prompt: string): Promise<string> {
        // Track calls: first returns val1 claims, second throws
        if ((throwingProvider as any)._generateCalls === undefined) {
          (throwingProvider as any)._generateCalls = 0;
        }
        (throwingProvider as any)._generateCalls++;
        if ((throwingProvider as any)._generateCalls === 1) {
          return JSON.stringify([{ type: 'fact', value: val1 }]);
        }
        throw new Error('simulated crash on second episode');
      },
      async judge(): Promise<never> {
        throw new Error('judge should not be called');
      },
    };

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, throwingProvider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    // First pass — H-2: error on 2nd episode is caught; consolidate() resolves (no throw)
    await expect(consolidator.consolidate()).resolves.toBeUndefined();

    // First episode must already be consolidated=1
    const ep1Row = h.episodes.getEpisode(ep1.id)!;
    expect(ep1Row.consolidated).toBe(1);

    // First node's strength was increased
    const s1AfterCrash = h.store.getNode(nodeId1)!.s;
    expect(s1AfterCrash).toBeGreaterThan(0.3);

    // Now resume with a normal provider for the second episode only
    const resumeProvider = new MockModelProvider({
      embedFn: embedder.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: val2 }])],
      judgeScript: [],
    });
    const consolidator2 = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, resumeProvider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    await consolidator2.consolidate();

    // First node's strength should NOT have increased again
    const s1AfterResume = h.store.getNode(nodeId1)!.s;
    expect(s1AfterResume).toBe(s1AfterCrash);

    // Second node's strength should have increased
    const s2AfterResume = h.store.getNode(nodeId2)!.s;
    expect(s2AfterResume).toBeGreaterThan(0.3);
  });

  // ── ROADMAP Criterion 1: changed fact reconciles ─────────────────────────
  //
  // Mid-band contradict: old node tombstoned + new current value set, carrying
  // prev_value = superseded value; tombstoned node absent from topk nomination.

  it('criterion 1: mid-band contradict tombstones old node, mints new current with prev_value, excluded from topk', async () => {
    // Node: s=0.5, c=0.7 → resistance = 0.5 * 0.7 = 0.35 (FakeClock, no decay)
    // magnitude=0.5 → ratio = 0.5/0.35 ≈ 1.43, between 0.8 and 2.0 → 'reconcile'
    const oldNodeId = newId();
    const oldValue = 'engineer';
    h.store.upsertNode({ id: oldNodeId, type: 'fact', value: oldValue, origin: 'observed', s: 0.5, c: 0.7 });
    const sameEmbedder = makeAlwaysSameEmbedder(h.config.embeddingDimensions);
    const [vec] = await sameEmbedder.embed([oldValue]);
    h.store.setEmbedding(oldNodeId, vec!);

    const newValue = 'manager';
    const contradictVerdict: JudgeVerdict = {
      best_candidate_id: oldNodeId,
      relation: 'contradict',
      magnitude: 0.5, // mid-band: ratio ≈ 1.43
    };
    const provider = new MockModelProvider({
      embedFn: sameEmbedder.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: newValue }])],
      judgeScript: [contradictVerdict],
    });

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'role changed to manager',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-reconcile',
      source_inference_id: null,
    });

    await consolidator.consolidate();

    // Old node must be tombstoned (superseded)
    const oldNode = h.store.getNode(oldNodeId)!;
    expect(oldNode.tombstoned).toBe(1);

    // A new current node with the new value must exist
    const allNodes = h.db.prepare('SELECT * FROM node').all() as NodeRow[];
    const newCurrentNodes = allNodes.filter(n => n.value === newValue && n.tombstoned === 0);
    expect(newCurrentNodes).toHaveLength(1);

    // The new node carries the superseded value as prev_value (D-20 oscillation breadcrumb)
    expect(newCurrentNodes[0]!.prev_value).toBe(oldValue);

    // topk MUST NOT include the tombstoned old node (CandidateRetriever excludes tombstoned=1)
    const queryVec = new Float32Array(h.config.embeddingDimensions);
    queryVec[0] = 1.0;
    const topkResults = h.retriever.topk(queryVec, 10);
    const topkIds = topkResults.map(r => r.id);
    expect(topkIds).not.toContain(oldNodeId);
  });

  // ── ROADMAP Criterion 3: force-destabilize at N distinct sessions ─────────
  //
  // A strong node that resists individual contradictions (HOLD) is force-destabilized
  // once N *distinct* sessions have contradicted it (Chen-2020 lock-in fix, D-19).

  it('criterion 3: N distinct-session contradictions force-destabilize regardless of strength', async () => {
    // Strong node: s=0.9, c=0.8 → resistance = 0.72 (FakeClock, no decay)
    // HOLD magnitude=0.1: ratio = 0.1/0.72 ≈ 0.14 < 0.8 → HOLD for each individual episode
    // contradictionN=3 (DEFAULT_CONFIG): after 3 distinct sessions → force-destabilize
    const strongNodeId = newId();
    const strongValue = 'established strong belief';
    const contradictingValue = 'updated belief after evidence';

    h.store.upsertNode({
      id: strongNodeId, type: 'fact', value: strongValue,
      origin: 'observed', s: 0.9, c: 0.8,
    });
    const sameEmbedder = makeAlwaysSameEmbedder(h.config.embeddingDimensions);
    const [vec] = await sameEmbedder.embed([strongValue]);
    h.store.setEmbedding(strongNodeId, vec!);

    // Three HOLD-band contradictions from three distinct sessions
    const holdVerdict = (): JudgeVerdict => ({
      best_candidate_id: strongNodeId,
      relation: 'contradict',
      magnitude: 0.1, // HOLD band vs resistance=0.72
    });
    const provider = new MockModelProvider({
      embedFn: sameEmbedder.fn,
      // Three episodes → three generate calls → three entries in script
      generateScript: [
        JSON.stringify([{ type: 'fact', value: contradictingValue }]),
        JSON.stringify([{ type: 'fact', value: contradictingValue }]),
        JSON.stringify([{ type: 'fact', value: contradictingValue }]),
      ],
      judgeScript: [holdVerdict(), holdVerdict(), holdVerdict()],
    });

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    // Three episodes from three distinct sessions (all provenance-eligible)
    for (let i = 1; i <= 3; i++) {
      h.episodes.append({
        content: `contradiction from session ${i}`,
        origin: 'observed',
        salience: 0.8,
        hard_keep: 0,
        role: 'user',
        session_id: `session-force-${i}`,
        source_inference_id: null,
      });
    }

    await consolidator.consolidate();

    // After N=3 distinct sessions: force-destabilize → old node tombstoned
    const oldNode = h.store.getNode(strongNodeId)!;
    expect(oldNode.tombstoned).toBe(1);

    // New current node with the contradicting value must exist
    const allNodes = h.db.prepare('SELECT * FROM node').all() as NodeRow[];
    const newCurrentNodes = allNodes.filter(n => n.value === contradictingValue && n.tombstoned === 0);
    expect(newCurrentNodes).toHaveLength(1);

    // New node carries prev_value = superseded value (same as band reconcile)
    expect(newCurrentNodes[0]!.prev_value).toBe(strongValue);
  });

  it('criterion 3 control: N contradictions sharing ONE session_id do NOT force-destabilize', async () => {
    // One chatty session repeating the same contradiction N times cannot reach N distinct.
    const strongNodeId = newId();
    h.store.upsertNode({
      id: strongNodeId, type: 'fact', value: 'chatty test belief',
      origin: 'observed', s: 0.9, c: 0.8,
    });
    const sameEmbedder = makeAlwaysSameEmbedder(h.config.embeddingDimensions);
    const [vec] = await sameEmbedder.embed(['chatty test belief']);
    h.store.setEmbedding(strongNodeId, vec!);

    const holdVerdict = (): JudgeVerdict => ({
      best_candidate_id: strongNodeId,
      relation: 'contradict',
      magnitude: 0.1,
    });
    const provider = new MockModelProvider({
      embedFn: sameEmbedder.fn,
      generateScript: [
        JSON.stringify([{ type: 'fact', value: 'chatty contradiction' }]),
        JSON.stringify([{ type: 'fact', value: 'chatty contradiction' }]),
        JSON.stringify([{ type: 'fact', value: 'chatty contradiction' }]),
      ],
      judgeScript: [holdVerdict(), holdVerdict(), holdVerdict()],
    });

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    // Three episodes ALL from the SAME session_id
    for (let i = 0; i < 3; i++) {
      h.episodes.append({
        content: 'same session contradiction',
        origin: 'observed',
        salience: 0.8,
        hard_keep: 0,
        role: 'user',
        session_id: 'session-same', // same session every time
        source_inference_id: null,
      });
    }

    await consolidator.consolidate();

    // Distinct sessions = 1 < contradictionN=3 → NOT force-destabilized
    const node = h.store.getNode(strongNodeId)!;
    expect(node.tombstoned).toBe(0);

    // pending_contradictions has 3 entries but all same session
    const contradictions = JSON.parse(node.pending_contradictions) as PendingContradiction[];
    expect(contradictions).toHaveLength(3);
    expect(contradictions.every(c => c.session_id === 'session-same')).toBe(true);
  });

  // ── Per-role skip threshold (consolSkipThresholdAssistant) ──────────────────

  it('per-role skip: user episode salience 0.3 is still processed (user threshold unchanged at 0.2)', async () => {
    // 0.3 >= consolSkipThreshold(0.2) → processed for user role
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),  // auto-unrelated
      generateScript: [JSON.stringify([{ type: 'fact', value: 'user low-salience claim' }])],
      judgeScript: [],
    });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'user episode salience 0.3',
      origin: 'observed',
      salience: 0.3,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-role-user',
      source_inference_id: null,
    });

    await consolidator.consolidate();

    const nodes = h.db.prepare('SELECT * FROM node').all() as NodeRow[];
    expect(nodes.length).toBeGreaterThanOrEqual(1); // claim extracted, node minted
  });

  it('per-role skip: assistant episode salience 0.3 is SKIPPED under the 0.5 assistant threshold', async () => {
    // 0.3 < consolSkipThresholdAssistant(0.5) and hard_keep=0 → skipped
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [JSON.stringify([{ type: 'fact', value: 'should be skipped for assistant' }])],
      judgeScript: [],
    });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'assistant episode salience 0.3',
      origin: 'observed',
      salience: 0.3,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'session-role-assistant-skip',
      source_inference_id: null,
    });

    await consolidator.consolidate();

    const nodes = h.db.prepare('SELECT * FROM node').all() as NodeRow[];
    expect(nodes).toHaveLength(0); // episode skipped → no claims, no nodes
  });

  it('per-role skip: assistant episode salience 0.6 is processed (above assistant threshold)', async () => {
    // 0.6 >= consolSkipThresholdAssistant(0.5) → processed
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [JSON.stringify([{ type: 'fact', value: 'high-salience assistant claim' }])],
      judgeScript: [],
    });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'assistant episode salience 0.6',
      origin: 'observed',
      salience: 0.6,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'session-role-assistant-high',
      source_inference_id: null,
    });

    await consolidator.consolidate();

    const nodes = h.db.prepare('SELECT * FROM node').all() as NodeRow[];
    expect(nodes.length).toBeGreaterThanOrEqual(1);
  });

  it('per-role skip: assistant episode salience 0.05 with hard_keep=1 is processed (hard_keep bypass)', async () => {
    // 0.05 < consolSkipThresholdAssistant(0.5) but hard_keep=1 → processed via bypass
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [JSON.stringify([{ type: 'fact', value: 'force-kept assistant claim' }])],
      judgeScript: [],
    });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'assistant episode salience 0.05 hard_keep=1',
      origin: 'observed',
      salience: 0.05,
      hard_keep: 1,
      role: 'assistant',
      session_id: 'session-role-assistant-hk',
      source_inference_id: null,
    });

    await consolidator.consolidate();

    const nodes = h.db.prepare('SELECT * FROM node').all() as NodeRow[];
    expect(nodes.length).toBeGreaterThanOrEqual(1); // hard_keep bypasses skip
  });

  it('per-role skip: consolSkipThresholdAssistant=0.2 restores prior behavior (reversibility)', async () => {
    // Setting consolSkipThresholdAssistant=0.2 means the assistant 0.3 episode is now processed
    const reversibleConfig: EngineConfig = { ...h.config, consolSkipThresholdAssistant: 0.2 };
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [JSON.stringify([{ type: 'fact', value: 'reversibility claim' }])],
      judgeScript: [],
    });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), reversibleConfig, h.clock,
    );

    h.episodes.append({
      content: 'assistant episode salience 0.3 reversible',
      origin: 'observed',
      salience: 0.3,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'session-reversibility',
      source_inference_id: null,
    });

    await consolidator.consolidate();

    // With assistant threshold lowered to 0.2, 0.3 >= 0.2 → processed
    const nodes = h.db.prepare('SELECT * FROM node').all() as NodeRow[];
    expect(nodes.length).toBeGreaterThanOrEqual(1);
  });

  // ── Batch per-claim embeddings (T-02-ASYNC: Phase A, before db.transaction) ─

  it('per-episode claims are embedded in a single batch call (3 claims → 1 embed call)', async () => {
    // Pre-seed + pre-embed 3 nodes so all 3 claims fast-path confirm (D-17 → no new dirty nodes)
    // This means Phase A prefix = 0 embed calls, Phase C = 0 embed calls.
    // Only embed call is the single batch per-claim query-vector embed.
    const dims = h.config.embeddingDimensions;
    const synth = makeSyntheticEmbedder(dims);

    const claimValues = ['batch claim alpha', 'batch claim beta', 'batch claim gamma'];
    for (const val of claimValues) {
      const id = newId();
      h.store.upsertNode({ id, type: 'fact', value: val, origin: 'observed' });
      const [vec] = await synth.embed([val]);
      h.store.setEmbedding(id, vec!);
    }

    let embedCallCount = 0;
    const countingProvider: ModelProvider = {
      async embed(texts: string[]): Promise<Float32Array[]> {
        embedCallCount++;
        return texts.map(synth.fn);
      },
      async generate(_prompt: string): Promise<string> {
        return JSON.stringify(claimValues.map(v => ({ type: 'fact', value: v })));
      },
      async judge(): Promise<never> {
        throw new Error('judge should not be called in batch-embed test');
      },
    };

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, countingProvider,
      makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'episode with 3 claims for batch embed test',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-batch-embed',
      source_inference_id: null,
    });

    await consolidator.consolidate();

    // Exactly 1 embed call: the batch per-claim query-vector embed
    // Phase A prefix: 0 (no dirty nodes — all pre-embedded)
    // Per-claim: 1 call with ['batch claim alpha', 'batch claim beta', 'batch claim gamma']
    // Phase C: 0 (all confirms → no new dirty nodes)
    expect(embedCallCount).toBe(1);
  });

  it('zero-claims episode makes no per-claim embed call', async () => {
    // generate returns [] → the batch guard (claimValues.length > 0) prevents any embed call
    const dims = h.config.embeddingDimensions;
    const synth = makeSyntheticEmbedder(dims);

    let embedCallCount = 0;
    const countingProvider: ModelProvider = {
      async embed(texts: string[]): Promise<Float32Array[]> {
        embedCallCount++;
        return texts.map(synth.fn);
      },
      async generate(): Promise<string> {
        return '[]';  // empty claims
      },
      async judge(): Promise<never> {
        throw new Error('judge should not be called');
      },
    };

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, countingProvider,
      makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'episode that yields zero claims',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-zero-claims',
      source_inference_id: null,
    });

    await consolidator.consolidate();

    // No embed calls at all:
    // Phase A prefix: 0 (no dirty nodes), Per-claim: 0 (zero claims), Phase C: 0 (no new nodes)
    expect(embedCallCount).toBe(0);
  });

  // ── ROADMAP Criterion 5: oscillation through two real reconciles ──────────
  //
  // Two successive consolidate() passes:
  //   Pass 1 — mid-band contradict → reconcile: 'engineer' tombstoned, 'manager' minted
  //            carrying prev_value='engineer'.
  //   Pass 2 — mid-band contradict → reconcile attempt → isOscillation('engineer','engineer')
  //            → escalate to append-new: 'manager' stays current, new 'engineer' appended.

  it('criterion 5: flip-back to carried prev_value escalates to append-new (no tombstone-cycle)', async () => {
    const sameEmbedder = makeAlwaysSameEmbedder(h.config.embeddingDimensions);

    // Seed 'engineer' node (s=0.5, c=0.7)
    const engineerNodeId = newId();
    const engineerValue = 'engineer';
    h.store.upsertNode({
      id: engineerNodeId, type: 'fact', value: engineerValue,
      origin: 'observed', s: 0.5, c: 0.7,
    });
    const [engVec] = await sameEmbedder.embed([engineerValue]);
    h.store.setEmbedding(engineerNodeId, engVec!);

    // ── PASS 1: 'manager' claim contradicts 'engineer' node → reconcile ──
    // resistance = 0.5 * 0.7 = 0.35; magnitude=0.5 → ratio≈1.43 → reconcile
    // isOscillation('manager', null) → false → tombstone 'engineer', mint 'manager'
    // 'manager' node carries prev_value='engineer'
    const pass1Verdict: JudgeVerdict = {
      best_candidate_id: engineerNodeId,
      relation: 'contradict',
      magnitude: 0.5, // mid-band reconcile
    };
    const pass1Provider = new MockModelProvider({
      embedFn: sameEmbedder.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: 'manager' }])],
      judgeScript: [pass1Verdict],
    });
    const pass1Consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, pass1Provider,
      makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'role changed to manager',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-osc-1',
      source_inference_id: null,
    });

    await pass1Consolidator.consolidate();

    // Verify pass 1 outcome: 'engineer' tombstoned, 'manager' exists with prev_value='engineer'
    const engineerNodeAfterPass1 = h.store.getNode(engineerNodeId)!;
    expect(engineerNodeAfterPass1.tombstoned).toBe(1);

    const allNodesAfterPass1 = h.db.prepare('SELECT id, value, prev_value, tombstoned FROM node').all() as NodeRow[];
    const managerNode = allNodesAfterPass1.find(n => n.value === 'manager' && n.tombstoned === 0)!;
    expect(managerNode).toBeDefined();
    expect(managerNode.prev_value).toBe('engineer'); // one-deep breadcrumb carried

    const managerNodeId = managerNode.id;

    // ── PASS 2: 'engineer' claim contradicts 'manager' node → oscillation ──
    // After pass 1's Phase C, 'manager' node is now embedded (nominatable).
    // 'manager' node defaults: s=0.1, c=0.5 → resistance=0.05
    // magnitude=0.06 → ratio=1.2 → 'reconcile' (mid-band)
    // isOscillation('engineer', 'engineer') → true → escalate to APPEND-NEW
    const pass2Verdict: JudgeVerdict = {
      best_candidate_id: managerNodeId,
      relation: 'contradict',
      magnitude: 0.06, // mid-band vs resistance=0.05; triggers oscillation guard
    };
    const pass2Provider = new MockModelProvider({
      embedFn: sameEmbedder.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: 'engineer' }])],
      judgeScript: [pass2Verdict],
    });
    const pass2Consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, pass2Provider,
      makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'actually back to engineer',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-osc-2',
      source_inference_id: null,
    });

    await pass2Consolidator.consolidate();

    // 'manager' node must NOT be tombstoned by the flip-back (oscillation guard fires)
    const managerNodeAfterPass2 = h.store.getNode(managerNodeId)!;
    expect(managerNodeAfterPass2.tombstoned).toBe(0);
    expect(managerNodeAfterPass2.value).toBe('manager');

    // A new 'engineer' node must have been appended as standalone (append-new)
    const allNodesAfterPass2 = h.db.prepare('SELECT id, value, tombstoned FROM node').all() as NodeRow[];
    const currentEngineerNodes = allNodesAfterPass2.filter(n => n.value === 'engineer' && n.tombstoned === 0);
    expect(currentEngineerNodes).toHaveLength(1); // new standalone 'engineer', not the tombstoned original

    // Both 'manager' and 'engineer' now coexist as current nodes (no tombstone cycle)
    const currentNodes = allNodesAfterPass2.filter(n => n.tombstoned === 0);
    expect(currentNodes.length).toBe(2); // manager + new engineer

    // The original engineerNodeId remains tombstoned (it was tombstoned in pass 1)
    expect(allNodesAfterPass2.find(n => n.id === engineerNodeId)!.tombstoned).toBe(1);
  });
  // ── C-2: assistant-role episodes never strengthen (self-confirmation guard) ────
  //
  // An assistant-role episode whose claim exact-matches an existing node must NOT
  // increase s or c (the memory's own restated output cannot strengthen itself).
  // A user-role episode with the same exact match MUST increase s (regression guard).
  // In both cases a 'confirm' sink event is emitted (for audit trail).

  it('C-2: assistant-role confirm does NOT strengthen (s and c unchanged)', async () => {
    const nodeId = newId();
    const nodeValue = 'always use TypeScript';

    h.store.upsertNode({ id: nodeId, type: 'fact', value: nodeValue, origin: 'observed', s: 0.3, c: 0.5 });
    const embedder = makeSyntheticEmbedder(h.config.embeddingDimensions);
    const [vec] = await embedder.embed([nodeValue]);
    h.store.setEmbedding(nodeId, vec!);

    const sBefore = h.store.getNode(nodeId)!.s;
    const cBefore = h.store.getNode(nodeId)!.c;

    const provider = new MockModelProvider({
      embedFn: embedder.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: nodeValue }])], // D-17 fast path
      judgeScript: [],
    });
    const sink = new MockConsolidationSink();
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider,
      makeNoOpSchemaInducer(h), h.config, h.clock, sink,
    );

    // Assistant-role episode: must not strengthen even on exact match
    h.episodes.append({
      content: 'assistant confirming content',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'assistant',
      session_id: 'session-c2-assistant',
    });

    await consolidator.consolidate();

    const nodeAfter = h.store.getNode(nodeId)!;
    // s and c must be UNCHANGED — assistant confirm does not strengthen
    expect(nodeAfter.s).toBe(sBefore);
    expect(nodeAfter.c).toBe(cBefore);
    // confirm event still emitted for audit trail
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.event_type).toBe('confirm');
  });

  // ── H-2: per-episode poison isolation ───────────────────────────────────────
  //
  // A poison episode (generate throws) must not block LATER episodes in the same pass.
  // The failing episode is quarantined (NOT marked consolidated) so it is retried next pass.

  it('H-2: poison episode does NOT block later episodes — second episode consolidated, first retryable', async () => {
    const nodeId2 = newId();
    const val2 = 'second episode value for H-2 test';
    h.store.upsertNode({ id: nodeId2, type: 'fact', value: val2, origin: 'observed', s: 0.3, c: 0.5 });
    const embedder = makeSyntheticEmbedder(h.config.embeddingDimensions);
    const [vec2] = await embedder.embed([val2]);
    h.store.setEmbedding(nodeId2, vec2!);

    // First episode: generate REJECTS (poison)
    const poisonEp = h.episodes.append({
      content: 'poison episode content',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-h2-poison',
    });

    // Second episode: generate succeeds with a valid claim
    const goodEp = h.episodes.append({
      content: 'good episode content',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-h2-good',
    });

    let generateCalls = 0;
    const poisonProvider: ModelProvider = {
      async embed(texts: string[]): Promise<Float32Array[]> {
        return texts.map(embedder.fn);
      },
      async generate(_prompt: string): Promise<string> {
        generateCalls++;
        if (generateCalls === 1) {
          throw new Error('H-2 simulated poison episode');
        }
        return JSON.stringify([{ type: 'fact', value: val2 }]);
      },
      async judge(): Promise<never> {
        throw new Error('judge should not be called');
      },
    };

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, poisonProvider,
      makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    // H-2: consolidate() must NOT throw even though the first episode's generate rejects
    await expect(consolidator.consolidate()).resolves.toBeUndefined();

    // First (poison) episode must NOT be consolidated — it should be retried next pass
    const poisonRow = h.episodes.getEpisode(poisonEp.id)!;
    expect(poisonRow.consolidated).toBe(0);

    // Second episode MUST be consolidated — poison must not block it
    const goodRow = h.episodes.getEpisode(goodEp.id)!;
    expect(goodRow.consolidated).toBe(1);
  });

  it('H-2 + L-4: corrupt pending_contradictions does not abort the pass', async () => {
    // Seed a node with a deliberately corrupt pending_contradictions column
    const nodeId = newId();
    const nodeValue = 'test node for corrupt JSON';
    h.store.upsertNode({ id: nodeId, type: 'fact', value: nodeValue, origin: 'observed', s: 0.5, c: 0.7 });
    const sameEmbedder = makeAlwaysSameEmbedder(h.config.embeddingDimensions);
    const [vec] = await sameEmbedder.embed([nodeValue]);
    h.store.setEmbedding(nodeId, vec!);
    // Corrupt the pending_contradictions column directly via SQL
    h.db.prepare('UPDATE node SET pending_contradictions = ? WHERE id = ?').run('{not json', nodeId);

    // Contradict HOLD band: magnitude=0.1, resistance = 0.5 * 0.7 = 0.35, ratio < 0.8 → HOLD
    const holdVerdict: JudgeVerdict = {
      best_candidate_id: nodeId,
      relation: 'contradict',
      magnitude: 0.1,
    };
    const provider = new MockModelProvider({
      embedFn: sameEmbedder.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: 'contradict the corrupt node' }])],
      judgeScript: [holdVerdict],
    });

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider,
      makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'contradicting episode',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-l4-corrupt',
      source_inference_id: null,
    });

    // Must not throw — corrupt JSON is repaired to [] and the pass completes
    await expect(consolidator.consolidate()).resolves.toBeUndefined();

    // The node's pending_contradictions should now be valid JSON (repaired by defensive parse)
    const updatedNode = h.store.getNode(nodeId)!;
    expect(() => JSON.parse(updatedNode.pending_contradictions)).not.toThrow();
  });

  it('C-2 regression guard: user-role confirm DOES strengthen (user-role still works)', async () => {
    const nodeId = newId();
    const nodeValue = 'always use TypeScript';

    h.store.upsertNode({ id: nodeId, type: 'fact', value: nodeValue, origin: 'observed', s: 0.3, c: 0.5 });
    const embedder = makeSyntheticEmbedder(h.config.embeddingDimensions);
    const [vec] = await embedder.embed([nodeValue]);
    h.store.setEmbedding(nodeId, vec!);

    const sBefore = h.store.getNode(nodeId)!.s;

    const provider = new MockModelProvider({
      embedFn: embedder.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: nodeValue }])], // D-17 fast path
      judgeScript: [],
    });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider,
      makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    // User-role episode: confirm MUST strengthen
    h.episodes.append({
      content: 'user confirming content',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-c2-user',
    });

    await consolidator.consolidate();

    const sAfter = h.store.getNode(nodeId)!.s;
    expect(sAfter).toBeGreaterThan(sBefore);
  });
});

// ---------------------------------------------------------------------------
// SEAM-02: sink event_type sequence per applyDecision branch (D-49)
// Each applyDecision branch must emit exactly one sink event whose event_type
// matches the branch taken (per-decision granularity, D-49).
// ---------------------------------------------------------------------------

describe('Consolidator sink events per applyDecision branch (SEAM-02, D-49)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  function makeConsolidatorWithSink(
    provider: ModelProvider,
    sink: MockConsolidationSink,
  ): Consolidator {
    return new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever,
      provider, makeNoOpSchemaInducer(h), h.config, h.clock,
      sink,
    );
  }

  // ── confirm ───────────────────────────────────────────────────────────────

  it('confirm branch emits exactly one confirm event', async () => {
    const nodeId = newId();
    const value = 'sink-confirm node';
    h.store.upsertNode({ id: nodeId, type: 'fact', value, origin: 'observed', s: 0.3, c: 0.6 });
    const embedder = makeSyntheticEmbedder(h.config.embeddingDimensions);
    const [vec] = await embedder.embed([value]);
    h.store.setEmbedding(nodeId, vec!);

    const provider = new MockModelProvider({
      embedFn: embedder.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value }])],  // D-17 fast-path confirm
      judgeScript: [],
    });
    const sink = new MockConsolidationSink();
    const consolidator = makeConsolidatorWithSink(provider, sink);

    h.episodes.append({ content: 'confirm episode', origin: 'observed', salience: 0.8, hard_keep: 0, role: 'user', session_id: 'sess-sink-confirm' });
    await consolidator.consolidate();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.event_type).toBe('confirm');
    expect(sink.events[0]!.node_id).toBe(nodeId);
  });

  // ── extend ────────────────────────────────────────────────────────────────

  it('extend branch emits exactly one extend event (new node_id, candidate_id = bestCandidateId)', async () => {
    const candidateId = newId();
    const candidateValue = 'sink-extend base';
    h.store.upsertNode({ id: candidateId, type: 'fact', value: candidateValue, origin: 'observed', s: 0.3, c: 0.6 });
    const sameEmb = makeAlwaysSameEmbedder(h.config.embeddingDimensions);
    const [vec] = await sameEmb.embed([candidateValue]);
    h.store.setEmbedding(candidateId, vec!);

    const extendVerdict: JudgeVerdict = { best_candidate_id: candidateId, relation: 'extend', magnitude: 0 };
    const provider = new MockModelProvider({
      embedFn: sameEmb.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: 'extension of base' }])],
      judgeScript: [extendVerdict],
    });
    const sink = new MockConsolidationSink();
    const consolidator = makeConsolidatorWithSink(provider, sink);

    h.episodes.append({ content: 'extend episode', origin: 'observed', salience: 0.8, hard_keep: 0, role: 'user', session_id: 'sess-sink-extend' });
    await consolidator.consolidate();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.event_type).toBe('extend');
    expect(sink.events[0]!.candidate_id).toBe(candidateId);
    // node_id must differ from candidateId (new node minted)
    expect(sink.events[0]!.node_id).not.toBe(candidateId);
  });

  // ── unrelated ─────────────────────────────────────────────────────────────

  it('unrelated branch emits exactly one unrelated event', async () => {
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),  // auto-unrelated
      generateScript: [JSON.stringify([{ type: 'fact', value: 'standalone unrelated claim' }])],
      judgeScript: [],
    });
    const sink = new MockConsolidationSink();
    const consolidator = makeConsolidatorWithSink(provider, sink);

    h.episodes.append({ content: 'unrelated episode', origin: 'observed', salience: 0.8, hard_keep: 0, role: 'user', session_id: 'sess-sink-unrelated' });
    await consolidator.consolidate();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.event_type).toBe('unrelated');
  });

  // ── contradict_hold ───────────────────────────────────────────────────────

  it('contradict HOLD branch emits contradict_hold', async () => {
    // s=0.5, c=0.7 → resistance=0.35; magnitude=0.1 → ratio≈0.29 → HOLD
    const candidateId = newId();
    h.store.upsertNode({ id: candidateId, type: 'fact', value: 'hold fact', origin: 'observed', s: 0.5, c: 0.7 });
    const sameEmb = makeAlwaysSameEmbedder(h.config.embeddingDimensions);
    const [vec] = await sameEmb.embed(['hold fact']);
    h.store.setEmbedding(candidateId, vec!);

    const holdVerdict: JudgeVerdict = { best_candidate_id: candidateId, relation: 'contradict', magnitude: 0.1 };
    const provider = new MockModelProvider({
      embedFn: sameEmb.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: 'contradicting hold' }])],
      judgeScript: [holdVerdict],
    });
    const sink = new MockConsolidationSink();
    const consolidator = makeConsolidatorWithSink(provider, sink);

    h.episodes.append({ content: 'hold episode', origin: 'observed', salience: 0.8, hard_keep: 0, role: 'user', session_id: 'sess-sink-hold', source_inference_id: null });
    await consolidator.consolidate();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.event_type).toBe('contradict_hold');
    expect(sink.events[0]!.node_id).toBe(candidateId);
  });

  // ── contradict_reconcile ──────────────────────────────────────────────────

  it('contradict reconcile branch emits contradict_reconcile', async () => {
    // s=0.5, c=0.7 → resistance=0.35; magnitude=0.5 → ratio≈1.43 → reconcile
    const candidateId = newId();
    h.store.upsertNode({ id: candidateId, type: 'fact', value: 'reconcile-fact-original', origin: 'observed', s: 0.5, c: 0.7 });
    const sameEmb = makeAlwaysSameEmbedder(h.config.embeddingDimensions);
    const [vec] = await sameEmb.embed(['reconcile-fact-original']);
    h.store.setEmbedding(candidateId, vec!);

    const reconcileVerdict: JudgeVerdict = { best_candidate_id: candidateId, relation: 'contradict', magnitude: 0.5 };
    const provider = new MockModelProvider({
      embedFn: sameEmb.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: 'reconcile-fact-new' }])],
      judgeScript: [reconcileVerdict],
    });
    const sink = new MockConsolidationSink();
    const consolidator = makeConsolidatorWithSink(provider, sink);

    h.episodes.append({ content: 'reconcile episode', origin: 'observed', salience: 0.8, hard_keep: 0, role: 'user', session_id: 'sess-sink-reconcile', source_inference_id: null });
    await consolidator.consolidate();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.event_type).toBe('contradict_reconcile');
  });

  // ── contradict_oscillation ────────────────────────────────────────────────

  it('contradict oscillation (flip-back to prev_value) emits contradict_oscillation', async () => {
    // Node with prev_value='flip-back-orig', current value='flip-back-new'.
    // Claim = 'flip-back-orig' → isOscillation → 'contradict_oscillation'
    const candidateId = newId();
    // Seed with prev_value already set (simulating a prior reconcile)
    h.store.upsertNode({
      id: candidateId, type: 'fact', value: 'flip-back-new',
      origin: 'observed', s: 0.1, c: 0.5,
      prev_value: 'flip-back-orig',
    });
    const sameEmb = makeAlwaysSameEmbedder(h.config.embeddingDimensions);
    const [vec] = await sameEmb.embed(['flip-back-new']);
    h.store.setEmbedding(candidateId, vec!);

    // s=0.1, c=0.5 → resistance=0.05; magnitude=0.06 → ratio=1.2, in reconcile band (0.8-2.0)
    // isOscillation('flip-back-orig', 'flip-back-orig') → true → escalate to 'contradict_oscillation'
    const oscVerdict: JudgeVerdict = { best_candidate_id: candidateId, relation: 'contradict', magnitude: 0.06 };
    const provider = new MockModelProvider({
      embedFn: sameEmb.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: 'flip-back-orig' }])],  // flip back
      judgeScript: [oscVerdict],
    });
    const sink = new MockConsolidationSink();
    const consolidator = makeConsolidatorWithSink(provider, sink);

    h.episodes.append({ content: 'oscillation episode', origin: 'observed', salience: 0.8, hard_keep: 0, role: 'user', session_id: 'sess-sink-osc', source_inference_id: null });
    await consolidator.consolidate();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.event_type).toBe('contradict_oscillation');
  });

  // ── contradict_append_new ─────────────────────────────────────────────────

  it('contradict append-new branch emits contradict_append_new', async () => {
    // s=0.1, c=0.5 → resistance=0.05; magnitude=0.9 → ratio=18 > 2.0 → append-new
    const candidateId = newId();
    h.store.upsertNode({ id: candidateId, type: 'fact', value: 'append-new-original', origin: 'observed', s: 0.1, c: 0.5 });
    const sameEmb = makeAlwaysSameEmbedder(h.config.embeddingDimensions);
    const [vec] = await sameEmb.embed(['append-new-original']);
    h.store.setEmbedding(candidateId, vec!);

    const appendVerdict: JudgeVerdict = { best_candidate_id: candidateId, relation: 'contradict', magnitude: 0.9 };
    const provider = new MockModelProvider({
      embedFn: sameEmb.fn,
      generateScript: [JSON.stringify([{ type: 'fact', value: 'append-new-value' }])],
      judgeScript: [appendVerdict],
    });
    const sink = new MockConsolidationSink();
    const consolidator = makeConsolidatorWithSink(provider, sink);

    h.episodes.append({ content: 'append-new episode', origin: 'observed', salience: 0.8, hard_keep: 0, role: 'user', session_id: 'sess-sink-append-new' });
    await consolidator.consolidate();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]!.event_type).toBe('contradict_append_new');
  });

  // ── contradict_force_destabilize ──────────────────────────────────────────

  it('force-destabilize at contradictionN distinct emits contradict_force_destabilize', async () => {
    // N=3 distinct sessions HOLD → force-destabilize on the 3rd
    // The 3rd episode's applyDecision emits 'contradict_force_destabilize'
    const candidateId = newId();
    h.store.upsertNode({ id: candidateId, type: 'fact', value: 'force-dest-node', origin: 'observed', s: 0.9, c: 0.8 });
    const sameEmb = makeAlwaysSameEmbedder(h.config.embeddingDimensions);
    const [vec] = await sameEmb.embed(['force-dest-node']);
    h.store.setEmbedding(candidateId, vec!);

    const holdVerdict = (): JudgeVerdict => ({ best_candidate_id: candidateId, relation: 'contradict', magnitude: 0.1 });
    const provider = new MockModelProvider({
      embedFn: sameEmb.fn,
      generateScript: [
        JSON.stringify([{ type: 'fact', value: 'destabilize-new' }]),
        JSON.stringify([{ type: 'fact', value: 'destabilize-new' }]),
        JSON.stringify([{ type: 'fact', value: 'destabilize-new' }]),
      ],
      judgeScript: [holdVerdict(), holdVerdict(), holdVerdict()],
    });
    const sink = new MockConsolidationSink();
    const consolidator = makeConsolidatorWithSink(provider, sink);

    for (let i = 1; i <= 3; i++) {
      h.episodes.append({ content: `force-dest ep ${i}`, origin: 'observed', salience: 0.8, hard_keep: 0, role: 'user', session_id: `sess-fd-${i}`, source_inference_id: null });
    }
    await consolidator.consolidate();

    // 3 decisions were processed:
    //  ep1 → hold → emit 'contradict_hold'
    //  ep2 → hold → emit 'contradict_hold'
    //  ep3 → hold + force-destabilize → emit 'contradict_force_destabilize'
    expect(sink.events).toHaveLength(3);
    expect(sink.events[0]!.event_type).toBe('contradict_hold');
    expect(sink.events[1]!.event_type).toBe('contradict_hold');
    expect(sink.events[2]!.event_type).toBe('contradict_force_destabilize');
  });

  // ── D-48 in-transaction: no await between mutation and emit ───────────────

  it('D-48: sink.emit is called inside the transaction (Consolidator emits synchronously with graph write)', async () => {
    // This test uses a sink that verifies the emit happens during the transaction body.
    // We track whether a node was written by the time emit() fires by reading the DB
    // inside emit() — if it sees the new node, the emit is co-transactional (D-48).
    const nodeValue = 'in-tx-node';
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [JSON.stringify([{ type: 'fact', value: nodeValue }])],
      judgeScript: [],
    });

    let nodeVisibleDuringEmit = false;
    const coTxSink = {
      emit(_event: { event_type: string }) {
        // Inside the transaction, the new node should already be visible to same-connection reads
        const rows = h.db.prepare('SELECT count(*) as c FROM node WHERE value = ?').get(nodeValue) as { c: number };
        nodeVisibleDuringEmit = rows.c > 0;
      },
    };

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever,
      provider, makeNoOpSchemaInducer(h), h.config, h.clock,
      coTxSink as any,
    );

    h.episodes.append({ content: 'in-tx episode', origin: 'observed', salience: 0.8, hard_keep: 0, role: 'user', session_id: 'sess-intx' });
    await consolidator.consolidate();

    expect(nodeVisibleDuringEmit).toBe(true);
  });
});
