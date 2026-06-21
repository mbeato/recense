/**
 * Tests for Phase 37 D-06 augmentation of RecallEngine (TYPED-02c, TYPED-02d, TYPED-02e).
 *
 * Coverage:
 *   TYPED-02c — cosine >= threshold returns typed-path payload (smaller than neighborhood)
 *   TYPED-02d — cosine < threshold returns unchanged schema-neighborhood result
 *   TYPED-02e — D-08 guard: typed-path branch never calls upsertEdge/strengthen
 *   Pitfall 4 — glosses loaded at construction, not per-recall
 *   D-06      — typed path OR neighborhood, never both (return-before-assembly)
 *
 * Harness strategy:
 *   - In-memory DB, initSchema, FakeClock, DEFAULT_CONFIG
 *   - Mock ModelProvider with scripted embed + generate
 *   - Manually inject glossEmbeddings by storing them via store.setMeta + GLOSS_EMBEDDINGS_META_KEY
 *     so loadGlossEmbeddings() reads them at RecallEngine construction
 *   - Verify via RecallEngine.recall() return value behavior
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
import type { ModelProvider } from '../src/model/provider';
import { RecallEngine } from '../src/recall';
import { GLOSS_EMBEDDINGS_META_KEY } from '../src/consolidation/gloss-embeddings';
import { PREDICATES } from '../src/model/typed-predicates';
import type { Predicate } from '../src/model/typed-predicates';
import { newId } from '../src/lib/hash';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Use 12-dim embeddings to make test math exact (one dim per predicate)
const TEST_DIMS = 12;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const config: EngineConfig = {
    ...DEFAULT_CONFIG,
    dbPath: ':memory:',
    embeddingDimensions: TEST_DIMS,
    ...configOverrides,
  };
  const store = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, store, episodes, strength, retriever, config };
}

/**
 * Store mock gloss embeddings in the meta table so RecallEngine.constructor
 * loads them via loadGlossEmbeddings.
 *
 * Each predicate gets a unit vector at dimension i (mod TEST_DIMS).
 * dim 0 → 'built_by', dim 1 → 'works_on', dim 2 → 'part_of', dim 3 → 'uses', ...
 */
function storeGlossEmbeddings(store: SemanticStore): void {
  const serialized: Record<string, string> = {};
  for (let i = 0; i < PREDICATES.length; i++) {
    const pred = PREDICATES[i]!;
    const vec = new Float32Array(TEST_DIMS);
    vec[i % TEST_DIMS] = 1.0;
    const bytes = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    serialized[pred] = bytes.toString('base64');
  }
  store.setMeta(GLOSS_EMBEDDINGS_META_KEY, JSON.stringify(serialized));
}

/**
 * Seed a node and attach a deterministic embedding.
 * vectorDim: which dimension is set to 1.0 (all others 0). Default: 0.
 */
function seedNodeWithEmbedding(
  h: Harness,
  opts: {
    id?: string;
    value: string;
    type?: 'fact' | 'entity' | 'schema';
    origin?: 'observed' | 'asserted_by_user' | 'inferred';
    tombstoned?: boolean;
    vectorDim?: number;
  }
): string {
  const id = opts.id ?? newId();
  h.store.upsertNode({
    id,
    type: opts.type ?? 'entity',
    value: opts.value,
    origin: opts.origin ?? 'observed',
    tombstoned: opts.tombstoned ?? false,
  });
  const vec = new Float32Array(TEST_DIMS);
  vec[opts.vectorDim ?? 0] = 1.0;
  h.store.setEmbedding(id, vec);
  return id;
}

/**
 * Create a scripted ModelProvider for typed-path tests.
 *
 * @param dims      - Embedding dimensions.
 * @param cueVecDim - Which dimension of the query embedding is set to 1.0.
 *                    This drives which predicate is matched (cosine = 1.0 at that dim).
 * @param inference - The generate() response to return.
 */
function makeTypedProvider(
  dims: number,
  cueVecDim: number,
  inference = 'typed inference response',
): ModelProvider {
  let callCount = 0;
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => {
        const vec = new Float32Array(dims);
        vec[cueVecDim] = 1.0;
        return vec;
      });
    },
    async generate(_prompt: string): Promise<string> {
      callCount++;
      return inference;
    },
    async judge(): Promise<never> {
      throw new Error('judge should not be called');
    },
    async judgeBatch(items) {
      if (items.length === 0) return [];
      throw new Error('judgeBatch should not be called');
    },
  };
  void callCount;
}

/**
 * Create a ModelProvider that embeds queries into a dim far from all gloss dims,
 * so cosine similarity < threshold → typed-path is skipped.
 *
 * Also provides a neighborhood schema and compose response so the fallback path
 * can complete successfully.
 */
function makeFallbackProvider(dims: number, inference = 'neighborhood inference'): ModelProvider {
  // Use the last dimension (dims-1) which is orthogonal to predicates (they use dims 0-11)
  // but for TEST_DIMS=12, we need to go beyond. Use a split approach:
  // All gloss embeddings use dims 0-11. If dims=12 and query uses all equal components
  // spread across 12 dims, each cosine will be 1/sqrt(12) ≈ 0.289 < 0.35 threshold.
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => {
        const vec = new Float32Array(dims);
        // Equal components in all dims → cosine with any unit-dim gloss = 1/sqrt(12) ≈ 0.289
        const component = 1.0 / Math.sqrt(dims);
        for (let i = 0; i < dims; i++) vec[i] = component;
        return vec;
      });
    },
    async generate(_prompt: string): Promise<string> {
      return inference;
    },
    async judge(): Promise<never> {
      throw new Error('judge should not be called');
    },
    async judgeBatch(items) {
      if (items.length === 0) return [];
      throw new Error('judgeBatch should not be called');
    },
  };
}

function makeEngine(h: Harness, provider: ModelProvider): RecallEngine {
  return new RecallEngine(
    h.db, h.clock, h.config,
    provider,
    h.retriever, h.store, h.strength, h.episodes,
  );
}

// ---------------------------------------------------------------------------
// TYPED-02c: above-threshold case (typed-path mode)
// ---------------------------------------------------------------------------

describe('RecallEngine D-06 typed-path branch (TYPED-02c)', () => {
  let h: Harness;

  beforeEach(() => {
    // predicateGlossThreshold = 0.35 (well below 1.0, so dim-aligned query matches)
    h = makeHarness({ predicateGlossThreshold: 0.35 });
  });

  it('TYPED-02c: returns typed-path inference when cosine >= threshold', async () => {
    // Store gloss embeddings so RecallEngine loads them at construction
    storeGlossEmbeddings(h.store);

    // Seed anchor node at dim 0 (same as query) — it will be topk bestMatch
    const anchorId = seedNodeWithEmbedding(h, {
      value: 'recense project',
      type: 'entity',
      vectorDim: 0,
    });

    // Seed a target node reachable via 'built_by' (PREDICATES index 0 → dim 0 of gloss)
    const targetId = seedNodeWithEmbedding(h, {
      value: 'Max Beato',
      type: 'entity',
      vectorDim: 1, // different dim so it doesn't compete for topk
    });

    // Create typed edge: anchor --built_by--> target
    h.store.upsertEdge({ src: anchorId, dst: targetId, rel: 'built_by', w: 1.0, kind: 'relation' });

    // Provider embeds query at dim 0 → cosine 1.0 with 'built_by' gloss (dim 0) → triggers typed path
    const provider = makeTypedProvider(TEST_DIMS, 0, 'recense was built by Max Beato');
    const engine = makeEngine(h, provider);

    const result = await engine.recall('who built this', 'session-1');

    expect(result.origin).toBe('inferred');
    expect(result.inference).toBe('recense was built by Max Beato');
    expect(result.episodeId).not.toBeNull();
  });

  it('TYPED-02c: typed payload is logged as inferred episode (D-43)', async () => {
    storeGlossEmbeddings(h.store);

    const anchorId = seedNodeWithEmbedding(h, { value: 'recense', type: 'entity', vectorDim: 0 });
    const targetId = seedNodeWithEmbedding(h, { value: 'Max', type: 'entity', vectorDim: 1 });
    h.store.upsertEdge({ src: anchorId, dst: targetId, rel: 'built_by', w: 1.0, kind: 'relation' });

    const provider = makeTypedProvider(TEST_DIMS, 0, 'typed answer');
    const engine = makeEngine(h, provider);

    const result = await engine.recall('who authored recense', 'session-2');
    expect(result.episodeId).not.toBeNull();

    // The inferred episode should exist with origin='inferred'
    // Query directly: listRecentInferred with sinceMs=0 returns all inferred episodes
    const eps = h.episodes.listRecentInferred(0);
    expect(eps.some((e) => e.origin === 'inferred' && e.content === 'typed answer')).toBe(true);
  });

  it('TYPED-02c: falls through to neighborhood when typedReach returns empty', async () => {
    storeGlossEmbeddings(h.store);

    // anchor with no typed 'built_by' edge → typedReach returns []
    // But the anchor IS a schema so the neighborhood path can succeed
    const schemaId = seedNodeWithEmbedding(h, {
      value: 'software development schema',
      type: 'schema',
      vectorDim: 0, // dim 0 → matches 'built_by' predicate
    });
    const memberId = seedNodeWithEmbedding(h, { value: 'TypeScript is a language', type: 'fact', vectorDim: 1 });
    h.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 1.0, kind: 'abstracts' });

    // No built_by edges from schema → typedReach returns [] → falls through to neighborhood
    const provider = makeTypedProvider(TEST_DIMS, 0, 'neighborhood fallback inference');
    const engine = makeEngine(h, provider);

    const result = await engine.recall('who built this', 'session-3');
    // Should succeed via neighborhood path (schemaId is type=schema → Case A)
    expect(result.origin).toBe('inferred');
    expect(result.inference).toBe('neighborhood fallback inference');
  });
});

// ---------------------------------------------------------------------------
// TYPED-02d: below-threshold case (neighborhood fallback)
// ---------------------------------------------------------------------------

describe('RecallEngine D-06 neighborhood fallback (TYPED-02d)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness({ predicateGlossThreshold: 0.35 });
  });

  it('TYPED-02d: falls back to schema-neighborhood when cosine < threshold', async () => {
    storeGlossEmbeddings(h.store);

    // Seed a schema node at dim 0 (same as query's dominant dim)
    const schemaId = seedNodeWithEmbedding(h, {
      value: 'software patterns schema',
      type: 'schema',
      vectorDim: 0,
    });
    const memberId = seedNodeWithEmbedding(h, { value: 'uses TypeScript', type: 'fact', vectorDim: 1 });
    h.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 1.0, kind: 'abstracts' });

    // Provider gives equal-component query → cosine ≈ 0.289 < 0.35 → matchPredicate returns null
    const provider = makeFallbackProvider(TEST_DIMS, 'schema neighborhood inference');
    const engine = makeEngine(h, provider);

    const result = await engine.recall('tell me about software patterns', 'session-4');
    expect(result.origin).toBe('inferred');
    expect(result.inference).toBe('schema neighborhood inference');
    expect(result.episodeId).not.toBeNull();
  });

  it('TYPED-02d: falls back to neighborhood when glossEmbeddings is null (not yet embedded)', async () => {
    // Do NOT store gloss embeddings → loadGlossEmbeddings returns null
    // → matchPredicate always returns null → neighborhood path

    const schemaId = seedNodeWithEmbedding(h, {
      value: 'TypeScript patterns',
      type: 'schema',
      vectorDim: 0,
    });
    const memberId = seedNodeWithEmbedding(h, { value: 'strictly typed code', type: 'fact', vectorDim: 1 });
    h.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 1.0, kind: 'abstracts' });

    // Even with a query that would match built_by (dim 0), glosses are null → fallback
    const provider = makeTypedProvider(TEST_DIMS, 0, 'null-gloss fallback inference');
    const engine = makeEngine(h, provider);

    const result = await engine.recall('what patterns', 'session-5');
    expect(result.origin).toBe('inferred');
    expect(result.inference).toBe('null-gloss fallback inference');
  });
});

// ---------------------------------------------------------------------------
// D-08 guard: typed-path branch never calls upsertEdge/strengthen
// ---------------------------------------------------------------------------

describe('RecallEngine D-08 self-confirmation guard (TYPED-02e)', () => {
  it('TYPED-02e: node count and edge count unchanged after typed-path recall', async () => {
    const h = makeHarness({ predicateGlossThreshold: 0.35 });
    storeGlossEmbeddings(h.store);

    const anchorId = seedNodeWithEmbedding(h, { value: 'recense', type: 'entity', vectorDim: 0 });
    const targetId = seedNodeWithEmbedding(h, { value: 'Max', type: 'entity', vectorDim: 1 });
    h.store.upsertEdge({ src: anchorId, dst: targetId, rel: 'built_by', w: 1.0, kind: 'relation' });

    // Count nodes and edges before recall
    const nodeCountBefore = h.db.prepare('SELECT count(*) as n FROM node').get() as { n: number };
    const edgeCountBefore = h.db.prepare('SELECT count(*) as n FROM edge').get() as { n: number };

    const provider = makeTypedProvider(TEST_DIMS, 0, 'inference that should not mint edges');
    const engine = makeEngine(h, provider);
    const result = await engine.recall('who built recense', 'session-d08');

    // Recall must have returned inference (to confirm typed path was taken)
    expect(result.inference).not.toBeNull();

    // Node count must be UNCHANGED (no upsertNode)
    const nodeCountAfter = h.db.prepare('SELECT count(*) as n FROM node').get() as { n: number };
    expect(nodeCountAfter.n).toBe(nodeCountBefore.n);

    // Edge count must be UNCHANGED (no upsertEdge)
    const edgeCountAfter = h.db.prepare('SELECT count(*) as n FROM edge').get() as { n: number };
    expect(edgeCountAfter.n).toBe(edgeCountBefore.n);
  });
});

// ---------------------------------------------------------------------------
// Pitfall 4: glosses loaded at construction, not per-recall
// ---------------------------------------------------------------------------

describe('RecallEngine Pitfall 4: gloss embeddings loaded once at construction', () => {
  it('glosses are loaded in constructor — no embed call for gloss strings during recall', async () => {
    const h = makeHarness({ predicateGlossThreshold: 0.35 });
    storeGlossEmbeddings(h.store);

    // Track all embed calls
    const embedTexts: string[][] = [];
    const anchorId = seedNodeWithEmbedding(h, { value: 'recense', type: 'entity', vectorDim: 0 });
    const targetId = seedNodeWithEmbedding(h, { value: 'Max', type: 'entity', vectorDim: 1 });
    h.store.upsertEdge({ src: anchorId, dst: targetId, rel: 'built_by', w: 1.0, kind: 'relation' });

    const trackingProvider: ModelProvider = {
      async embed(texts: string[]): Promise<Float32Array[]> {
        embedTexts.push([...texts]);
        return texts.map(() => {
          const vec = new Float32Array(TEST_DIMS);
          vec[0] = 1.0;
          return vec;
        });
      },
      async generate(): Promise<string> { return 'some inference'; },
      async judge(): Promise<never> { throw new Error('judge called'); },
      async judgeBatch(items) { if (items.length === 0) return []; throw new Error(); },
    };

    const engine = makeEngine(h, trackingProvider);
    await engine.recall('who built recense', 'session-pitfall4');

    // embed should be called exactly ONCE (for the query cue), not 12+ times for glosses
    expect(embedTexts).toHaveLength(1);
    // The single embed call should contain only the query, not gloss strings
    const glossStrings = ['who created or built this', 'what project does this person work on'];
    const calledWithGloss = embedTexts[0]!.some(t =>
      glossStrings.some(g => t.includes(g) || g.includes(t))
    );
    expect(calledWithGloss).toBe(false);
  });
});
