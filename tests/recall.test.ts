/**
 * Behavioral tests for RecallEngine (on-demand recall, LEARN-02).
 *
 * Harness: in-memory Database, initSchema, FakeClock, DEFAULT_CONFIG,
 * ModelProvider mock, no network. Mirrors schema-induction.test.ts.
 *
 * Coverage:
 *   LEARN-02  — recall returns origin:'inferred', non-null episodeId, appends inferred episode
 *   LEARN-02  — ephemeral-as-fact: node/edge counts unchanged across recall
 *   D-41      — cue is embedded exactly once (online embed, recall path only)
 *   D-42      — neighborhood respects recallNeighborhoodBudget; tombstoned neighbors excluded
 *   D-43      — inference logged as inferred-origin episode with role:'assistant'
 *   T-02-PARSE — null inference on empty/malformed compose output
 *
 * Phase-5 Plan-02 migration: RecallEngine now takes a single ModelProvider instead of
 * separate Embedder + optional AnthropicFactory. Tests use MockModelProvider.
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
import type { ModelProvider } from '../src/model/provider';
import type { EpisodeRow } from '../src/lib/types';
import { RecallEngine } from '../src/recall';
import type { RecallResult } from '../src/recall';
import { newId } from '../src/lib/hash';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a MockModelProvider for recall tests.
 * embed head: unit vector in dim 0 for any text (matches query embedding).
 * generate head: scripted to return a fixed inference string.
 * judge head: empty (recall never calls judge).
 */
function makeStubProvider(
  dims: number,
  inference = 'test inference from schema prior',
): MockModelProvider {
  return new MockModelProvider({
    embedFn: (_text: string) => {
      const vec = new Float32Array(dims);
      vec[0] = 1.0;
      return vec;
    },
    generateScript: [inference],
  });
}

/**
 * Create a capturing ModelProvider that records the prompt string and returns a fixed response.
 * Useful for asserting that specific context appears in the compose prompt.
 */
function makeCapturingProvider(
  dims: number,
  onPrompt: (prompt: string) => void,
  responseText = 'captured inference',
): ModelProvider {
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      const vec = new Float32Array(dims);
      vec[0] = 1.0;
      return texts.map(() => vec.slice());
    },
    async generate(prompt: string): Promise<string> {
      onPrompt(prompt);
      return responseText;
    },
    async judge(): Promise<never> {
      throw new Error('judge should not be called in recall tests');
    },
  };
}

interface Harness {
  db: Database.Database;
  clock: FakeClock;
  store: SemanticStore;
  episodes: EpisodicStore;
  strength: StrengthDecayManager;
  retriever: CandidateRetriever;
  config: EngineConfig;
}

function makeHarness(configOverrides?: Partial<EngineConfig>): Harness {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const config: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:', ...configOverrides };
  const store = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, store, episodes, strength, retriever, config };
}

/**
 * Seed a node and attach a deterministic embedding.
 * vectorDim: which dimension is set to 1.0 (all others 0). Default: 0.
 */
async function seedNodeWithEmbedding(
  h: Harness,
  opts: {
    id?: string;
    value: string;
    type?: 'fact' | 'entity' | 'schema';
    origin?: 'observed' | 'asserted_by_user' | 'inferred';
    tombstoned?: boolean;
    vectorDim?: number;
  }
): Promise<string> {
  const id = opts.id ?? newId();
  h.store.upsertNode({
    id,
    type: opts.type ?? 'fact',
    value: opts.value,
    origin: opts.origin ?? 'observed',
    tombstoned: opts.tombstoned ?? false,
  });
  const vec = new Float32Array(h.config.embeddingDimensions);
  vec[opts.vectorDim ?? 0] = 1.0;
  h.store.setEmbedding(id, vec);
  return id;
}

/**
 * Build a RecallEngine with an optional ModelProvider.
 * Default provider: unit-vector embed (dim 0) + empty generate queue
 * (throws if called, which is the correct behavior for tests that expect NULL_RESULT).
 */
function makeEngine(h: Harness, provider?: ModelProvider): RecallEngine {
  const defaultProvider = new MockModelProvider({
    embedFn: (_text: string) => {
      const vec = new Float32Array(h.config.embeddingDimensions);
      vec[0] = 1.0;
      return vec;
    },
    generateScript: [],  // throws if generate is unexpectedly called (safety net)
    judgeScript: [],
  });
  return new RecallEngine(
    h.db, h.clock, h.config,
    provider ?? defaultProvider,
    h.retriever, h.store, h.strength, h.episodes,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RecallEngine', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  // ── LEARN-02: baseline happy path ─────────────────────────────────────────

  it('LEARN-02: returns origin:inferred, non-null episodeId, appends inferred-origin episode', async () => {
    // Schema node: dim 0 → cosine 1.0 with query → best topk match
    const schemaId = await seedNodeWithEmbedding(h, {
      value: 'TypeScript development patterns',
      type: 'schema',
      origin: 'inferred',
      vectorDim: 0,
    });
    // Member node: dim 1 → cosine 0 with query (won't be best match)
    const memberId = await seedNodeWithEmbedding(h, {
      value: 'TypeScript is strongly typed',
      type: 'fact',
      vectorDim: 1,
    });
    h.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });

    const engine = makeEngine(h, makeStubProvider(h.config.embeddingDimensions, 'TypeScript suits large codebases'));
    const result: RecallResult = await engine.recall('What do I know about TypeScript?', 'test-session');

    expect(result.origin).toBe('inferred');
    expect(result.episodeId).not.toBeNull();
    expect(result.inference).toBe('TypeScript suits large codebases');

    // Inferred episode must be in the DB
    const rows = h.db.prepare("SELECT * FROM episode WHERE origin = 'inferred'").all() as EpisodeRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(result.episodeId);
    expect(rows[0]!.role).toBe('assistant');
    expect(rows[0]!.session_id).toBe('test-session');
    expect(rows[0]!.salience).toBe(0);
    expect(rows[0]!.hard_keep).toBe(0);
  });

  // ── Ephemeral-as-fact guarantee (LEARN-02) ────────────────────────────────

  it('ephemeral-as-fact: node and edge counts are UNCHANGED after recall', async () => {
    const schemaId = await seedNodeWithEmbedding(h, {
      value: 'Tech schema',
      type: 'schema',
      origin: 'inferred',
    });
    const memberId = await seedNodeWithEmbedding(h, {
      value: 'a fact',
      type: 'fact',
      vectorDim: 1,
    });
    h.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });

    const nodeBefore = (h.db.prepare('SELECT count(*) as c FROM node').get() as { c: number }).c;
    const edgeBefore = (h.db.prepare('SELECT count(*) as c FROM edge').get() as { c: number }).c;

    const engine = makeEngine(h, makeStubProvider(h.config.embeddingDimensions));
    await engine.recall('any question', 'test-session');

    const nodeAfter = (h.db.prepare('SELECT count(*) as c FROM node').get() as { c: number }).c;
    const edgeAfter = (h.db.prepare('SELECT count(*) as c FROM edge').get() as { c: number }).c;

    expect(nodeAfter).toBe(nodeBefore); // no node written (ephemeral-as-fact)
    expect(edgeAfter).toBe(edgeBefore); // no edge written
  });

  // ── Null result: empty embed (D-41) ─────────────────────────────────────

  it('returns null result when embedder returns no vector (empty embed)', async () => {
    const emptyProvider: ModelProvider = {
      embed: async (_texts) => [],
      generate: async (_prompt) => { throw new Error('generate should not be called'); },
      judge: async () => { throw new Error('judge should not be called'); },
    };
    const engine = new RecallEngine(
      h.db, h.clock, h.config, emptyProvider, h.retriever, h.store, h.strength, h.episodes,
    );
    const result = await engine.recall('any query', 'test-session');

    expect(result.origin).toBe('inferred');
    expect(result.inference).toBeNull();
    expect(result.episodeId).toBeNull();
  });

  // ── Null result: no embedded nodes (empty DB) ────────────────────────────

  it('returns null result when no embedded nodes exist (empty topk)', async () => {
    const engine = makeEngine(h);
    const result = await engine.recall('any query', 'test-session');

    expect(result.origin).toBe('inferred');
    expect(result.inference).toBeNull();
    expect(result.episodeId).toBeNull();
  });

  // ── Null result: no schema reachable ─────────────────────────────────────

  it('returns null inference when best match is a plain fact (no schema reachable)', async () => {
    // Only a plain fact node — no schema node, no abstracts edges
    await seedNodeWithEmbedding(h, {
      value: 'just a fact',
      type: 'fact',
      vectorDim: 0, // best match for query
    });

    // generate never called (no schema found) → scripted but unconsumed is fine
    const engine = makeEngine(
      h,
      makeStubProvider(h.config.embeddingDimensions, 'this should never appear'),
    );
    const result = await engine.recall('any query', 'test-session');

    expect(result.inference).toBeNull();
    expect(result.episodeId).toBeNull();
    expect(result.origin).toBe('inferred');

    // No episode appended
    const rows = h.db.prepare("SELECT * FROM episode").all() as EpisodeRow[];
    expect(rows).toHaveLength(0);
  });

  // ── D-42: tombstoned neighbors excluded from neighborhood ────────────────

  it('D-42: tombstoned neighbors are excluded from the neighborhood', async () => {
    const schemaId = await seedNodeWithEmbedding(h, {
      value: 'test schema',
      type: 'schema',
      origin: 'inferred',
      vectorDim: 0,
    });
    const liveId = await seedNodeWithEmbedding(h, {
      value: 'live neighbor fact',
      type: 'fact',
      vectorDim: 1,
    });
    const deadId = await seedNodeWithEmbedding(h, {
      value: 'tombstoned neighbor fact',
      type: 'fact',
      tombstoned: true,
      vectorDim: 2,
    });
    h.store.upsertEdge({ src: schemaId, dst: liveId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });
    h.store.upsertEdge({ src: schemaId, dst: deadId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });

    let capturedPrompt = '';
    const engine = makeEngine(
      h,
      makeCapturingProvider(h.config.embeddingDimensions, (p) => { capturedPrompt = p; }),
    );
    await engine.recall('test query', 'test-session');

    expect(capturedPrompt).toContain('live neighbor fact');
    expect(capturedPrompt).not.toContain('tombstoned neighbor fact');
  });

  // ── D-42: recallNeighborhoodBudget caps the neighborhood ─────────────────

  it('D-42: recallNeighborhoodBudget limits the neighborhood size', async () => {
    const h2 = makeHarness({ recallNeighborhoodBudget: 2 });

    const schemaId = await seedNodeWithEmbedding(h2, {
      value: 'budget schema',
      type: 'schema',
      origin: 'inferred',
      vectorDim: 0,
    });
    // Seed 5 member nodes
    for (let i = 0; i < 5; i++) {
      const memberId = await seedNodeWithEmbedding(h2, {
        value: `member-${i}`,
        type: 'fact',
        vectorDim: i + 1, // dims 1–5, cosine 0 with query
      });
      h2.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });
    }

    let capturedPrompt = '';
    const provider = makeCapturingProvider(
      h2.config.embeddingDimensions,
      (p) => { capturedPrompt = p; },
    );
    const engine = new RecallEngine(
      h2.db, h2.clock, h2.config, provider, h2.retriever, h2.store, h2.strength, h2.episodes,
    );
    await engine.recall('test query', 'test-session');

    // Count how many of member-0..4 appear in the prompt
    const included = [0, 1, 2, 3, 4].filter(i => capturedPrompt.includes(`member-${i}`));
    expect(included.length).toBeLessThanOrEqual(2); // budget = 2
  });

  // ── T-02-PARSE: null inference on "null" LLM response ────────────────────

  it('T-02-PARSE: returns null result when compose response is "null"', async () => {
    const schemaId = await seedNodeWithEmbedding(h, {
      value: 'null schema',
      type: 'schema',
      origin: 'inferred',
    });
    const memberId = await seedNodeWithEmbedding(h, {
      value: 'a member',
      type: 'fact',
      vectorDim: 1,
    });
    h.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });

    const engine = makeEngine(h, makeStubProvider(h.config.embeddingDimensions, 'null'));
    const result = await engine.recall('test', 'test-session');

    expect(result.inference).toBeNull();
    expect(result.episodeId).toBeNull();
    expect(result.origin).toBe('inferred');
    // No episode appended when inference is null
    const rows = h.db.prepare("SELECT * FROM episode").all() as EpisodeRow[];
    expect(rows).toHaveLength(0);
  });

  // ── T-02-PARSE: null inference on empty LLM response ────────────────────

  it('T-02-PARSE: returns null result when compose response is empty string', async () => {
    const schemaId = await seedNodeWithEmbedding(h, {
      value: 'empty schema',
      type: 'schema',
      origin: 'inferred',
    });
    const memberId = await seedNodeWithEmbedding(h, {
      value: 'a member',
      type: 'fact',
      vectorDim: 1,
    });
    h.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });

    const engine = makeEngine(h, makeStubProvider(h.config.embeddingDimensions, ''));
    const result = await engine.recall('test', 'test-session');

    expect(result.inference).toBeNull();
    expect(result.episodeId).toBeNull();
  });

  // ── Fix-2: reverse-lookup — member best-match resolves schema via incoming abstracts edge ──

  it('Fix-2: when bestMatch is a member node with incoming abstracts edge, recall resolves schema and returns inference', async () => {
    // Member node at dim 0 → cosine 1.0 with query → best topk match
    const memberId = await seedNodeWithEmbedding(h, {
      value: 'TypeScript is strongly typed',
      type: 'fact',
      vectorDim: 0, // same dim as default embedder → best match
    });
    // Schema node at dim 1 → cosine 0 with query → NOT the best match
    const schemaId = await seedNodeWithEmbedding(h, {
      value: 'TypeScript development patterns',
      type: 'schema',
      origin: 'inferred',
      vectorDim: 1,
    });
    // Directed schema→member edge (the direction schema-induction creates)
    h.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });

    const nodeBefore = (h.db.prepare('SELECT count(*) as c FROM node').get() as { c: number }).c;
    const edgeBefore = (h.db.prepare('SELECT count(*) as c FROM edge').get() as { c: number }).c;

    const engine = makeEngine(
      h,
      makeStubProvider(h.config.embeddingDimensions, 'TypeScript suits large codebases'),
    );
    const result: RecallResult = await engine.recall('What do I know about TypeScript?', 'test-session');

    // Recall must resolve the schema via reverse (incoming abstracts) lookup
    expect(result.origin).toBe('inferred');
    expect(result.inference).toBe('TypeScript suits large codebases');
    expect(result.episodeId).not.toBeNull();

    // Inferred episode must be appended
    const rows = h.db.prepare("SELECT * FROM episode WHERE origin = 'inferred'").all() as EpisodeRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('assistant');

    // Ephemeral-as-fact guarantee: node and edge counts must be unchanged
    const nodeAfter = (h.db.prepare('SELECT count(*) as c FROM node').get() as { c: number }).c;
    const edgeAfter = (h.db.prepare('SELECT count(*) as c FROM edge').get() as { c: number }).c;
    expect(nodeAfter).toBe(nodeBefore);
    expect(edgeAfter).toBe(edgeBefore);
  });

  // ── Fix-2: neighborhood assembled from schema's members (not bestMatch's out-edges) ──

  it('Fix-2: neighborhood in prompt comes from schema members when bestMatch is a member', async () => {
    // Three member nodes — only two are connected to the schema
    // Member-0 at dim 0 → best match
    const member0Id = await seedNodeWithEmbedding(h, {
      value: 'fact about TypeScript interfaces',
      type: 'fact',
      vectorDim: 0,
    });
    // Member-1 at dim 1 → connected to schema
    const member1Id = await seedNodeWithEmbedding(h, {
      value: 'fact about TypeScript generics',
      type: 'fact',
      vectorDim: 1,
    });
    // Schema at dim 2
    const schemaId = await seedNodeWithEmbedding(h, {
      value: 'TypeScript type system',
      type: 'schema',
      origin: 'inferred',
      vectorDim: 2,
    });
    // Schema→member-0 and schema→member-1 edges
    h.store.upsertEdge({ src: schemaId, dst: member0Id, rel: 'abstracts', w: 0.8, kind: 'abstracts' });
    h.store.upsertEdge({ src: schemaId, dst: member1Id, rel: 'abstracts', w: 0.8, kind: 'abstracts' });

    let capturedPrompt = '';
    const engine = makeEngine(
      h,
      makeCapturingProvider(h.config.embeddingDimensions, (p) => { capturedPrompt = p; }),
    );
    await engine.recall('TypeScript types', 'test-session');

    // Prompt must include the schema label and both members' values
    expect(capturedPrompt).toContain('TypeScript type system');
    expect(capturedPrompt).toContain('fact about TypeScript interfaces');
    expect(capturedPrompt).toContain('fact about TypeScript generics');
  });

  // ── Single embed call (D-41) ──────────────────────────────────────────────

  it('D-41: embeds the query cue exactly once', async () => {
    let embedCallCount = 0;
    const countingProvider: ModelProvider = {
      async embed(texts: string[]): Promise<Float32Array[]> {
        embedCallCount += texts.length;
        const vec = new Float32Array(h.config.embeddingDimensions);
        vec[0] = 1.0;
        return texts.map(() => vec.slice());
      },
      async generate(_prompt: string): Promise<string> {
        return 'counted inference';
      },
      async judge(): Promise<never> {
        throw new Error('judge should not be called in embed count test');
      },
    };

    const schemaId = await seedNodeWithEmbedding(h, {
      value: 'schema',
      type: 'schema',
      origin: 'inferred',
    });
    const memberId = await seedNodeWithEmbedding(h, {
      value: 'member',
      type: 'fact',
      vectorDim: 1,
    });
    h.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });

    const engine = new RecallEngine(
      h.db, h.clock, h.config, countingProvider, h.retriever, h.store, h.strength, h.episodes,
    );
    await engine.recall('test query', 'test-session');

    expect(embedCallCount).toBe(1); // exactly one online embed (D-41)
  });
});
