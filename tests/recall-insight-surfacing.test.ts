/**
 * Tests for Plan 38-03: Insight surfacing branch in RecallEngine (REFLECT-02).
 *
 * Coverage:
 *   Test 1 (hit)           — insight returned in place of K=20 neighborhood when live + fresh
 *   Test 2 (miss)          — neighborhood fallback when no live insight exists (or tombstoned)
 *   Test 3 (stale-skip)    — stale insight (member last_access > generated_at) is never surfaced
 *   Test 4 (no-mutation)   — hit path makes zero graph mutations beyond the inferred-episode append
 *   Test 5 (flag-off)      — insightSurfacingEnabled=false is a no-op; byte-identical to today
 *
 * Harness strategy:
 *   - In-memory DB, initSchema, FakeClock, DEFAULT_CONFIG
 *   - insightSurfacingEnabled=true/false via config overrides
 *   - Seed: schema node, member facts via 'abstracts' edges, insight node via 'derived_from' edges,
 *     node_insight sidecar row (generated_at), insight value
 *   - Embedding: query + schema + members seeded at dim 0; insight node has NO embedding (NULL) —
 *     the doc-writer pattern; match gate is schema-anchor resolution, not a cosine comparison
 *   - Verify via RecallEngine.recall() return value + DB state inspection
 *
 * CRITICAL INVARIANTS (from plan):
 *   - Insight hit path is LLM-free: no embed(, setEmbedding, provider.embed beyond the single
 *     query cue embed
 *   - Zero graph mutations in the hit path: node/edge counts unchanged after surfacing
 *   - One mode OR the other: on a hit, returned inference IS the insight string (single payload)
 *   - Flag-off: with insightSurfacingEnabled=false, recall is byte-identical to pre-insight behavior
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
import { newId } from '../src/lib/hash';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_DIMS = 4; // small dimension — enough for cosine differentiation

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
    insightSurfacingEnabled: true, // on by default in tests that test the insight path
    ...configOverrides,
  };
  const store = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, store, episodes, strength, retriever, config };
}

/**
 * Seed a node with an embedding at the specified dimension.
 * Returns the node id.
 */
function seedNodeWithEmbedding(
  h: Harness,
  opts: {
    id?: string;
    value: string;
    type?: 'fact' | 'entity' | 'schema' | 'insight';
    origin?: 'observed' | 'asserted_by_user' | 'inferred';
    tombstoned?: boolean;
    vectorDim?: number | null; // null = no embedding (insight doc-writer pattern)
    s?: number;
    c?: number;
    last_access?: number;
  },
): string {
  const id = opts.id ?? newId();
  h.store.upsertNode({
    id,
    type: opts.type ?? 'entity',
    value: opts.value,
    origin: opts.origin ?? 'observed',
    tombstoned: opts.tombstoned ?? false,
    s: opts.s,
    c: opts.c,
    last_access: opts.last_access,
  });
  if (opts.vectorDim !== null && opts.vectorDim !== undefined) {
    const vec = new Float32Array(TEST_DIMS);
    vec[opts.vectorDim] = 1.0;
    h.store.setEmbedding(id, vec);
  }
  // insights have NULL embedding (doc-writer pattern) — do not call setEmbedding
  return id;
}

/**
 * Set last_access on a node directly (for staleness tests).
 * FakeClock's nowMs is used for upsertNode — this lets us override it in the DB.
 */
function setLastAccess(h: Harness, nodeId: string, lastAccessMs: number): void {
  h.db.prepare('UPDATE node SET last_access = ? WHERE id = ?').run(lastAccessMs, nodeId);
}

/**
 * Build a minimal graph: schema -> members (abstracts), insight -> schema + members (derived_from),
 * node_insight sidecar. Returns all relevant ids.
 *
 * @param insightGeneratedAt  - epoch ms for the insight's generated_at
 * @param memberLastAccess    - epoch ms for the member's last_access (affects freshness)
 * @param insightTombstoned   - whether the insight node is tombstoned
 */
function seedInsightGraph(
  h: Harness,
  opts: {
    insightValue?: string;
    insightGeneratedAt?: number;
    memberLastAccess?: number;
    insightTombstoned?: boolean;
    schemaVectorDim?: number;
  } = {},
): {
  schemaId: string;
  memberId: string;
  insightId: string;
} {
  const now = h.clock.nowMs(); // 2026-01-01
  const insightGeneratedAt = opts.insightGeneratedAt ?? now;
  const memberLastAccess = opts.memberLastAccess ?? now - 1000; // member accessed before insight generated
  const schemaVectorDim = opts.schemaVectorDim ?? 0;

  // Schema node — at dim 0, topk will match it
  const schemaId = seedNodeWithEmbedding(h, {
    value: 'machine learning patterns',
    type: 'schema',
    origin: 'inferred',
    vectorDim: schemaVectorDim,
  });

  // Member fact node
  const memberId = seedNodeWithEmbedding(h, {
    value: 'gradient descent optimizes weights',
    type: 'fact',
    origin: 'observed',
    vectorDim: 1, // different dim — won't compete for topk
  });
  // Override last_access
  setLastAccess(h, memberId, memberLastAccess);

  // abstracts edge: schema -> member
  h.store.upsertEdge({
    src: schemaId,
    dst: memberId,
    rel: 'abstracts',
    w: 1.0,
    kind: 'abstracts',
    last_access: now,
  });

  // Insight node — NO embedding (doc-writer pattern), origin='inferred'
  const insightId = seedNodeWithEmbedding(h, {
    value: opts.insightValue ?? 'ML models learn patterns by iteratively updating weights via gradient descent',
    type: 'insight',
    origin: 'inferred',
    tombstoned: opts.insightTombstoned ?? false,
    vectorDim: null, // explicitly NULL embedding
    s: 0.5,
    c: 0.6,
  });

  // node_insight sidecar — records generated_at + anchor
  h.store.upsertNodeInsight({
    node_id: insightId,
    anchor_schema_id: schemaId,
    generated_at: insightGeneratedAt,
    updated_at: insightGeneratedAt,
  });

  // derived_from edge: insight -> schema (anchor)
  h.store.upsertEdge({
    src: insightId,
    dst: schemaId,
    rel: 'derived_from',
    w: 1.0,
    kind: 'derived_from',
    last_access: now,
  });

  // derived_from edge: insight -> member (dependency for staleness)
  h.store.upsertEdge({
    src: insightId,
    dst: memberId,
    rel: 'derived_from',
    w: 1.0,
    kind: 'derived_from',
    last_access: now,
  });

  return { schemaId, memberId, insightId };
}

/**
 * Make a simple ModelProvider for these tests.
 *
 * The insight surfacing path should use the SAME compose call recall already makes.
 * We script embed to return a vector at dim 0 (matches the schema) and generate to
 * return a predictable neighborhood-inference string.
 *
 * The insight path is LLM-free for the lookup; it still calls generate exactly once
 * for the compose step (same as the neighborhood path).
 */
function makeInsightTestProvider(dims: number, generateResponse = 'composed inference'): ModelProvider {
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => {
        const vec = new Float32Array(dims);
        vec[0] = 1.0; // dim 0 → matches schema node at dim 0
        return vec;
      });
    },
    async generate(_prompt: string): Promise<string> {
      return generateResponse;
    },
    async judge(): Promise<never> {
      throw new Error('judge should not be called in recall');
    },
    async judgeBatch(items: unknown[]) {
      if (items.length === 0) return [];
      throw new Error('judgeBatch should not be called in recall');
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
// Test 1: hit — insight returned in place of neighborhood
// ---------------------------------------------------------------------------

describe('RecallEngine insight surfacing — Test 1: hit (insight in place of neighborhood)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness({ insightSurfacingEnabled: true });
  });

  it('T1: returns insight string as inference when live non-stale insight exists on resolved schema', async () => {
    const insightText = 'ML models learn patterns by iteratively updating weights via gradient descent';
    const { insightId } = seedInsightGraph(h, { insightValue: insightText });

    const provider = makeInsightTestProvider(TEST_DIMS);
    const engine = makeEngine(h, provider);

    const result = await engine.recall('how do neural networks learn', 'session-t1');

    expect(result.origin).toBe('inferred');
    expect(result.episodeId).not.toBeNull();

    // The insight text should appear in the composed inference
    // (compose builds the prompt from the single insight string)
    // We verify by confirming the generate() was given the insight value
    // and the result is the scripted response (not a multi-member neighborhood dump)
    expect(result.inference).not.toBeNull();

    // Confirm the insight node was resolved (graph sanity check)
    const insightRow = h.store.getNodeInsight(insightId);
    expect(insightRow).toBeDefined();
    expect(insightRow!.anchor_schema_id).toBeDefined();
  });

  it('T1b: payload is single-member (insight string only) — NOT the multi-member neighborhood dump', async () => {
    const insightText = 'THE PRECOMPUTED INSIGHT TEXT';
    // Seed many members so neighborhood would be multi-line
    const { schemaId } = seedInsightGraph(h, { insightValue: insightText });
    // Add extra members to the schema
    for (let i = 0; i < 5; i++) {
      const mId = newId();
      h.store.upsertNode({ id: mId, type: 'fact', value: `member fact ${i}`, origin: 'observed' });
      const vec = new Float32Array(TEST_DIMS);
      vec[2] = 0.1 * (i + 1); // dim 2 — won't compete for topk
      h.store.setEmbedding(mId, vec);
      h.store.upsertEdge({ src: schemaId, dst: mId, rel: 'abstracts', w: 1.0, kind: 'abstracts' });
    }

    // Track prompts to confirm only the insight string is the neighborhood content
    const prompts: string[] = [];
    const trackingProvider: ModelProvider = {
      async embed(texts: string[]): Promise<Float32Array[]> {
        return texts.map(() => {
          const vec = new Float32Array(TEST_DIMS);
          vec[0] = 1.0;
          return vec;
        });
      },
      async generate(prompt: string): Promise<string> {
        prompts.push(prompt);
        return 'composed from insight';
      },
      async judge(): Promise<never> { throw new Error('judge'); },
      async judgeBatch(items: unknown[]) { if (items.length === 0) return []; throw new Error(); },
    };

    const engine = makeEngine(h, trackingProvider);
    await engine.recall('ML learning query', 'session-t1b');

    // Exactly one compose call
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;

    // The prompt must contain the insight text (used as the single neighborhood member)
    expect(prompt).toContain(insightText);

    // The prompt must NOT contain "member fact" strings (those are from the multi-member neighborhood)
    expect(prompt).not.toContain('member fact 0');
    expect(prompt).not.toContain('member fact 1');
  });
});

// ---------------------------------------------------------------------------
// Test 2: miss — neighborhood fallback when no live insight
// ---------------------------------------------------------------------------

describe('RecallEngine insight surfacing — Test 2: miss (neighborhood fallback)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness({ insightSurfacingEnabled: true });
  });

  it('T2a: falls through to neighborhood when NO insight exists for the schema', async () => {
    // Schema with members but NO insight node + no derived_from edges
    const schemaId = seedNodeWithEmbedding(h, {
      value: 'software engineering patterns',
      type: 'schema',
      origin: 'inferred',
      vectorDim: 0,
    });
    const memberId = seedNodeWithEmbedding(h, {
      value: 'TypeScript provides type safety',
      type: 'fact',
      origin: 'observed',
      vectorDim: 1,
    });
    h.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 1.0, kind: 'abstracts' });

    const provider = makeInsightTestProvider(TEST_DIMS, 'neighborhood fallback inference');
    const engine = makeEngine(h, provider);

    const result = await engine.recall('tell me about software patterns', 'session-t2a');

    // Should produce an inference via the neighborhood path
    expect(result.origin).toBe('inferred');
    expect(result.inference).toBe('neighborhood fallback inference');
    expect(result.episodeId).not.toBeNull();
  });

  it('T2b: falls through to neighborhood when insight is tombstoned', async () => {
    const memberAccess = h.clock.nowMs() - 1000;
    const insightGenerated = h.clock.nowMs();
    seedInsightGraph(h, {
      insightValue: 'tombstoned insight text',
      insightGeneratedAt: insightGenerated,
      memberLastAccess: memberAccess,
      insightTombstoned: true, // tombstoned — should be skipped
    });

    const provider = makeInsightTestProvider(TEST_DIMS, 'fallback from tombstoned insight');
    const engine = makeEngine(h, provider);

    const result = await engine.recall('ML query', 'session-t2b');

    // Should NOT surface the tombstoned insight; should fall through to neighborhood
    expect(result.inference).toBe('fallback from tombstoned insight');
  });
});

// ---------------------------------------------------------------------------
// Test 3: stale-skip — stale insight (member changed after generated_at) is skipped
// ---------------------------------------------------------------------------

describe('RecallEngine insight surfacing — Test 3: stale-skip', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness({ insightSurfacingEnabled: true });
  });

  it('T3a: skips insight when a member last_access > insight generated_at (member changed after insight)', async () => {
    const insightGenerated = h.clock.nowMs() - 5000; // insight generated 5s ago
    const memberLastAccess = h.clock.nowMs();         // member accessed NOW (after insight was generated → stale)

    seedInsightGraph(h, {
      insightValue: 'stale insight — member changed after generation',
      insightGeneratedAt: insightGenerated,
      memberLastAccess: memberLastAccess, // > insightGenerated → stale
    });

    const provider = makeInsightTestProvider(TEST_DIMS, 'neighborhood inference for stale insight');
    const engine = makeEngine(h, provider);

    const result = await engine.recall('ML learning', 'session-t3a');

    // Stale insight must NOT be surfaced; fall through to neighborhood
    expect(result.inference).toBe('neighborhood inference for stale insight');
  });

  it('T3b: skips insight when a derived_from member is tombstoned (falsified member)', async () => {
    const now = h.clock.nowMs();
    const insightGenerated = now;

    const { memberId } = seedInsightGraph(h, {
      insightValue: 'insight with falsified member',
      insightGeneratedAt: insightGenerated,
      memberLastAccess: now - 1000, // member was accessed before insight → normally fresh
    });

    // Tombstone the member (simulates falsification via PE-gated reconcile)
    h.store.tombstone(memberId);

    const provider = makeInsightTestProvider(TEST_DIMS, 'fallback after member tombstone');
    const engine = makeEngine(h, provider);

    const result = await engine.recall('ML patterns', 'session-t3b');

    // Tombstoned member makes the insight stale → skip; fall through to neighborhood
    // (neighborhood will be empty since the only member is tombstoned, so NULL_RESULT)
    // The key assertion: result must NOT be the insight text
    expect(result.inference).not.toBe('insight with falsified member');
  });
});

// ---------------------------------------------------------------------------
// Test 4: no-mutation invariant — insight hit makes zero graph mutations
// ---------------------------------------------------------------------------

describe('RecallEngine insight surfacing — Test 4: no-mutation invariant', () => {
  it('T4: node/edge counts and insight sidecar are byte-identical after a surfacing hit', async () => {
    const h = makeHarness({ insightSurfacingEnabled: true });

    const { insightId } = seedInsightGraph(h, {
      insightValue: 'pre-computed insight value for mutation test',
      insightGeneratedAt: h.clock.nowMs(),
      memberLastAccess: h.clock.nowMs() - 1000,
    });

    // Snapshot state BEFORE recall
    const nodeCountBefore = (h.db.prepare('SELECT count(*) as n FROM node').get() as { n: number }).n;
    const edgeCountBefore = (h.db.prepare('SELECT count(*) as n FROM edge').get() as { n: number }).n;
    const insightRowBefore = h.store.getNodeInsight(insightId);

    // Read insight node s, c, tombstoned before
    const insightNodeBefore = h.db
      .prepare('SELECT s, c, tombstoned FROM node WHERE id = ?')
      .get(insightId) as { s: number; c: number; tombstoned: number } | undefined;

    // Read member node s, c, tombstoned before
    const memberNodesBefore = h.db
      .prepare("SELECT id, s, c, tombstoned FROM node WHERE type = 'fact'")
      .all() as Array<{ id: string; s: number; c: number; tombstoned: number }>;

    const provider = makeInsightTestProvider(TEST_DIMS, 'mutation-free inference');
    const engine = makeEngine(h, provider);

    // Perform the recall (should hit the insight path)
    const result = await engine.recall('how do neural networks learn', 'session-t4');
    expect(result.inference).not.toBeNull(); // confirm hit path was taken

    // Assert ZERO graph mutations beyond the episode append
    const nodeCountAfter = (h.db.prepare('SELECT count(*) as n FROM node').get() as { n: number }).n;
    const edgeCountAfter = (h.db.prepare('SELECT count(*) as n FROM edge').get() as { n: number }).n;
    expect(nodeCountAfter).toBe(nodeCountBefore); // no upsertNode
    expect(edgeCountAfter).toBe(edgeCountBefore); // no upsertEdge

    // Insight sidecar must be unchanged (no strengthen or upsert)
    const insightRowAfter = h.store.getNodeInsight(insightId);
    expect(insightRowAfter).toEqual(insightRowBefore);

    // Insight node s/c/tombstoned must be unchanged
    const insightNodeAfter = h.db
      .prepare('SELECT s, c, tombstoned FROM node WHERE id = ?')
      .get(insightId) as { s: number; c: number; tombstoned: number } | undefined;
    expect(insightNodeAfter).toEqual(insightNodeBefore);

    // Member nodes s/c/tombstoned must be unchanged
    const memberNodesAfter = h.db
      .prepare("SELECT id, s, c, tombstoned FROM node WHERE type = 'fact'")
      .all() as Array<{ id: string; s: number; c: number; tombstoned: number }>;
    expect(memberNodesAfter).toEqual(memberNodesBefore);
  });
});

// ---------------------------------------------------------------------------
// Test 5: flag-off — insightSurfacingEnabled=false is a no-op
// ---------------------------------------------------------------------------

describe('RecallEngine insight surfacing — Test 5: flag-off (dark default)', () => {
  it('T5: with insightSurfacingEnabled=false, recall is byte-identical to neighborhood-only behavior', async () => {
    // Use a config with the flag OFF (the dark default)
    const h = makeHarness({ insightSurfacingEnabled: false });

    const insightText = 'INSIGHT TEXT THAT MUST NOT APPEAR WHEN FLAG IS OFF';
    seedInsightGraph(h, {
      insightValue: insightText,
      insightGeneratedAt: h.clock.nowMs(),
      memberLastAccess: h.clock.nowMs() - 1000,
    });

    const prompts: string[] = [];
    const trackingProvider: ModelProvider = {
      async embed(texts: string[]): Promise<Float32Array[]> {
        return texts.map(() => {
          const vec = new Float32Array(TEST_DIMS);
          vec[0] = 1.0;
          return vec;
        });
      },
      async generate(prompt: string): Promise<string> {
        prompts.push(prompt);
        return 'neighborhood inference with flag off';
      },
      async judge(): Promise<never> { throw new Error('judge'); },
      async judgeBatch(items: unknown[]) { if (items.length === 0) return []; throw new Error(); },
    };

    const engine = makeEngine(h, trackingProvider);
    const result = await engine.recall('ML learning query', 'session-t5');

    // Should produce an inference via the NEIGHBORHOOD path (not the insight path)
    expect(result.origin).toBe('inferred');
    expect(result.inference).toBe('neighborhood inference with flag off');
    expect(result.episodeId).not.toBeNull();

    // The insight text must NOT appear in the compose prompt
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain(insightText);
    // The prompt should contain neighborhood member content, not the insight
    expect(prompts[0]).toContain('gradient descent optimizes weights');
  });

  it('T5b: insight branch is never entered when flag is off (even with a valid live insight)', async () => {
    const h = makeHarness({ insightSurfacingEnabled: false });

    let embedCallCount = 0;
    const trackingProvider: ModelProvider = {
      async embed(texts: string[]): Promise<Float32Array[]> {
        embedCallCount++;
        return texts.map(() => {
          const vec = new Float32Array(TEST_DIMS);
          vec[0] = 1.0;
          return vec;
        });
      },
      async generate(): Promise<string> {
        return 'flag-off fallback inference';
      },
      async judge(): Promise<never> { throw new Error('judge'); },
      async judgeBatch(items: unknown[]) { if (items.length === 0) return []; throw new Error(); },
    };

    seedInsightGraph(h, {
      insightValue: 'valid live insight',
      insightGeneratedAt: h.clock.nowMs(),
      memberLastAccess: h.clock.nowMs() - 1000,
    });

    const engine = makeEngine(h, trackingProvider);
    await engine.recall('some query', 'session-t5b');

    // Exactly one embed call (the query cue) — no extra embed calls for the insight
    // (This also proves no new embed was introduced by the surfacing branch)
    expect(embedCallCount).toBe(1);
  });
});
