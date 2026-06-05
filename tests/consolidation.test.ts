/**
 * Behavioral tests for the Consolidator (offline sleep pass).
 * Covers: CONSOL-01/02/03, UPDATE-01/02/03 (confirm/extend/unrelated/HOLD routes).
 *
 * Harness mirrors tests/seeder.test.ts: in-memory Database, initSchema, FakeClock,
 * DEFAULT_CONFIG, and fully deterministic mocks (no network).
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
import type { JudgeVerdict } from '../src/model/judge';
import { MockClaimExtractor } from '../src/model/claim-extractor';
import type { ExtractedClaim } from '../src/model/claim-extractor';
import type { NodeRow, PendingContradiction } from '../src/lib/types';
import { Consolidator } from '../src/consolidation/consolidator';
import { newId } from '../src/lib/hash';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Hash-seeded synthetic embedder: maps text to a deterministic Float32Array of
 * config.embeddingDimensions length. Two texts with the same content produce
 * cosine similarity 1.0 (same vector); different texts produce near-zero.
 */
function makeSyntheticEmbedder(dims: number): MockEmbedder {
  return new MockEmbedder((text: string) => {
    const vec = new Float32Array(dims);
    // Simple hash: use each character code to seed a direction
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash + text.charCodeAt(i)) >>> 0;
    }
    // Place all weight on the dimension indexed by hash % dims
    vec[hash % dims] = 1.0;
    return vec;
  });
}

/** Returns the same unit vector regardless of text — simulates cosine > threshold. */
function makeAlwaysSameEmbedder(dims: number): MockEmbedder {
  return new MockEmbedder((_text: string) => {
    const vec = new Float32Array(dims);
    vec[0] = 1.0;
    return vec;
  });
}

/** Returns a zero-vector — cosine similarity 0. */
function makeZeroEmbedder(dims: number): MockEmbedder {
  return new MockEmbedder((_text: string) => new Float32Array(dims));
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
    const extractor = new MockClaimExtractor([{ type: 'fact', value: 'should be skipped' }]);
    const judge = new MockJudge([]);
    const embedder = makeSyntheticEmbedder(h.config.embeddingDimensions);
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, embedder, judge, extractor, h.config, h.clock,
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
    // Judge queue was never touched (we set it empty; if it were touched it would throw)
  });

  it('CONSOL-01 hard_keep override: low-salience hard_keep=1 episode IS processed', async () => {
    const claim: ExtractedClaim = { type: 'fact', value: 'hard kept claim' };
    const extractor = new MockClaimExtractor([claim]);
    // No judge calls needed — no existing nodes, so auto-unrelated
    const judge = new MockJudge([]);
    const embedder = makeSyntheticEmbedder(h.config.embeddingDimensions);
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, embedder, judge, extractor, h.config, h.clock,
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

    // Claim with same (normalized) value → fast path confirm
    const extractor = new MockClaimExtractor([{ type: 'fact', value: nodeValue }]);
    const judge = new MockJudge([]); // should not be called

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, embedder, judge, extractor, h.config, h.clock,
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

    const extractor = new MockClaimExtractor([{ type: 'fact', value: nodeValue }]);
    const judge = new MockJudge([]);

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, embedder, judge, extractor, h.config, h.clock,
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
    const zeroEmbedder = makeZeroEmbedder(h.config.embeddingDimensions);

    // If judge is called, it will throw (queue is exhausted) — proves no judge call
    const judge = new MockJudge([]);

    const extractor = new MockClaimExtractor([{ type: 'fact', value: 'completely unrelated claim' }]);

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, zeroEmbedder, judge, extractor, h.config, h.clock,
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
    const judge = new MockJudge([extendVerdict]);
    const extractor = new MockClaimExtractor([{ type: 'fact', value: 'extension of base node' }]);

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, sameEmbedder, judge, extractor, h.config, h.clock,
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
    const judge = new MockJudge([unrelatedVerdict]);
    const extractor = new MockClaimExtractor([{ type: 'fact', value: 'truly unrelated new claim' }]);

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, sameEmbedder, judge, extractor, h.config, h.clock,
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

  // ── contradict HOLD ───────────────────────────────────────────────────────

  it('contradict HOLD: judge contradict verdict records PendingContradiction; node is NOT tombstoned', async () => {
    const candidateId = newId();
    h.store.upsertNode({ id: candidateId, type: 'fact', value: 'established fact', origin: 'observed', s: 0.5, c: 0.7 });
    const sameEmbedder = makeAlwaysSameEmbedder(h.config.embeddingDimensions);
    const [vec] = await sameEmbedder.embed(['established fact']);
    h.store.setEmbedding(candidateId, vec!);

    const contradictVerdict: JudgeVerdict = {
      best_candidate_id: candidateId,
      relation: 'contradict',
      magnitude: 0.4,
    };
    const judge = new MockJudge([contradictVerdict]);
    const extractor = new MockClaimExtractor([{ type: 'fact', value: 'contradicting claim here' }]);

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, sameEmbedder, judge, extractor, h.config, h.clock,
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
    // Node is NOT tombstoned — HOLD only this slice
    expect(node.tombstoned).toBe(0);

    // pending_contradictions should have grown by 1
    const contradictions = JSON.parse(node.pending_contradictions) as PendingContradiction[];
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]!.session_id).toBe('session-contradict');
    expect(contradictions[0]!.origin).toBe('observed');
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

    const embedder = makeSyntheticEmbedder(h.config.embeddingDimensions);
    const judge = new MockJudge([]);
    const extractor = new MockClaimExtractor([]);

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, embedder, judge, extractor, h.config, h.clock,
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
    const extractor = new MockClaimExtractor([{ type: 'fact', value: nodeValue }]);
    const judge = new MockJudge([]);

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, embedder, judge, extractor, h.config, h.clock,
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

    // Second run — all episodes are now consolidated=1, should be no-op
    await consolidator.consolidate();
    const sAfterSecond = h.store.getNode(nodeId)!.s;

    expect(sAfterSecond).toBe(sAfterFirst);

    // All episodes should be consolidated
    const unconsolidated = h.episodes.listUnconsolidated();
    expect(unconsolidated).toHaveLength(0);
  });

  it('CONSOL-02 resumable: partial pass (throw on 2nd episode) — 1st episode committed, resume does not double-apply', async () => {
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

    // Build a throwing extractor: returns claims for ep1 fine, but throws on ep2
    let callCount = 0;
    const throwingExtractor = {
      async extract(content: string, _sourceType: string): Promise<ExtractedClaim[]> {
        callCount++;
        if (callCount === 1) {
          return [{ type: 'fact' as const, value: val1 }];
        }
        throw new Error('simulated crash on second episode');
      },
    };

    const judge = new MockJudge([]);
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, embedder, judge, throwingExtractor, h.config, h.clock,
    );

    // First pass — throws on second episode
    await expect(consolidator.consolidate()).rejects.toThrow('simulated crash on second episode');

    // First episode must already be consolidated=1
    const ep1Row = h.episodes.getEpisode(ep1.id)!;
    expect(ep1Row.consolidated).toBe(1);

    // First node's strength was increased
    const s1AfterCrash = h.store.getNode(nodeId1)!.s;
    expect(s1AfterCrash).toBeGreaterThan(0.3);

    // Now resume with a normal extractor for the second episode only
    const resumeExtractor = new MockClaimExtractor([{ type: 'fact', value: val2 }]);
    const consolidator2 = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, embedder, new MockJudge([]), resumeExtractor, h.config, h.clock,
    );

    await consolidator2.consolidate();

    // First node's strength should NOT have increased again
    const s1AfterResume = h.store.getNode(nodeId1)!.s;
    expect(s1AfterResume).toBe(s1AfterCrash);

    // Second node's strength should have increased
    const s2AfterResume = h.store.getNode(nodeId2)!.s;
    expect(s2AfterResume).toBeGreaterThan(0.3);
  });
});
