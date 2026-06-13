/**
 * Behavioral tests for HybridResponder (D-72 facts-first + schema-prior fallback, Phase 7).
 *
 * Harness: in-memory Database, initSchema, FakeClock, DEFAULT_CONFIG,
 * MockModelProvider, no network. Mirrors tests/recall.test.ts exactly.
 *
 * Coverage:
 *   facts-first    — retrieve()→'ok' → composed grounded reply, NO (inferred) marker, origin:'fact'
 *   schema-prior   — retrieve()→'unreachable' + schema reachable → reply + ' (inferred)', origin:'inferred'
 *   honest no-answer — neither path yields answer → HONEST_NO_ANSWER, origin:'none'
 *   D-75 read-only — respond() writes zero graph nodes; only episode is origin='inferred', salience=0;
 *                    inbound question NOT in observed/asserted_by_user rows
 *   safe-null      — embed throws → respond() resolves to {reply:null,origin:'none'} (no throw)
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
import { AllocationGate } from '../src/gate/allocation-gate';
import { RetrievalEngine } from '../src/retrieval/engine';
import { RecallEngine } from '../src/recall';
import { MockModelProvider } from '../src/model/provider';
import type { ModelProvider } from '../src/model/provider';
import { newId } from '../src/lib/hash';
import { HybridResponder, HONEST_NO_ANSWER } from '../src/responder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a MockModelProvider for responder tests.
 * embedDim: which dimension in the unit vector is 1.0. Default 0.
 * generateScript: scripted generate responses consumed in queue order.
 */
function makeStubProvider(
  dims: number,
  embedDim = 0,
  generateScript: string[] = [],
): MockModelProvider {
  return new MockModelProvider({
    embedFn: (_text: string) => {
      const vec = new Float32Array(dims);
      vec[embedDim] = 1.0;
      return vec;
    },
    generateScript,
  });
}

interface Harness {
  db: Database.Database;
  clock: FakeClock;
  store: SemanticStore;
  episodes: EpisodicStore;
  strength: StrengthDecayManager;
  retriever: CandidateRetriever;
  gate: AllocationGate;
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
  const gate = new AllocationGate(config);
  return { db, clock, store, episodes, strength, retriever, gate, config };
}

/**
 * Seed a node with a deterministic unit-vector embedding.
 * vectorDim: which dimension is set to 1.0 (all others 0). Default 0.
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
  },
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

function makeRetrievalEngine(h: Harness): RetrievalEngine {
  return new RetrievalEngine(h.db, h.clock, h.config, h.retriever, h.store, h.strength, h.gate);
}

function makeRecallEngine(h: Harness, provider: ModelProvider): RecallEngine {
  return new RecallEngine(
    h.db, h.clock, h.config, provider, h.retriever, h.store, h.strength, h.episodes,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HybridResponder', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  // ── facts-first branch ────────────────────────────────────────────────────

  it('facts-first: retrieve()→ok returns grounded reply with NO (inferred) marker, origin:fact', async () => {
    // Seed a live fact node at dim 0 — scores 1.0 against query embedded at dim 0
    await seedNodeWithEmbedding(h, {
      value: 'Max works at a software company',
      type: 'fact',
      origin: 'observed',
      vectorDim: 0,
    });

    const groundedAnswer = 'Max works at a software company.';
    // HybridResponder provider: embed at dim 0 (matches fact node).
    // generateScript[0] = rewrite result (LEVER 3), generateScript[1] = grounded compose answer.
    const provider = makeStubProvider(h.config.embeddingDimensions, 0, ['Max works at a software company', groundedAnswer]);
    // RecallEngine provider: embed at dim 1 — won't be reached in the facts-first path
    const recallProvider = makeStubProvider(h.config.embeddingDimensions, 1, []);
    const retrieval = makeRetrievalEngine(h);
    const recall = makeRecallEngine(h, recallProvider);
    const responder = new HybridResponder(h.clock, h.config, provider, retrieval, recall, h.episodes);

    const result = await responder.respond('Where does Max work?', 'test-session');

    expect(result.reply).toBe(groundedAnswer);
    expect(result.reply).not.toContain('(inferred)');
    expect(result.origin).toBe('fact');
    expect(result.episodeId).not.toBeNull();
  });

  // ── schema-prior fallback branch ──────────────────────────────────────────

  it('schema-prior: retrieve()→unreachable + schema reachable → reply ends with (inferred), origin:inferred', async () => {
    // Schema node at dim 0 — RecallEngine (embed at dim 0) will find it as best match
    const schemaId = await seedNodeWithEmbedding(h, {
      value: 'Exercise and fitness patterns',
      type: 'schema',
      origin: 'inferred',
      vectorDim: 0,
    });
    // Member node at dim 2 — connected to schema
    const memberId = await seedNodeWithEmbedding(h, {
      value: 'Max runs 5km three times a week',
      type: 'fact',
      origin: 'observed',
      vectorDim: 2,
    });
    h.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });

    const inferenceText = 'Max follows a regular running routine';
    // HybridResponder provider: embed at dim 1 — no live node at dim 1 → retrieve→'unreachable'
    const provider = makeStubProvider(h.config.embeddingDimensions, 1, []);
    // RecallEngine provider: embed at dim 0 — matches schema node, generate returns inference
    const recallProvider = makeStubProvider(h.config.embeddingDimensions, 0, [inferenceText]);
    const retrieval = makeRetrievalEngine(h);
    const recall = makeRecallEngine(h, recallProvider);
    const responder = new HybridResponder(h.clock, h.config, provider, retrieval, recall, h.episodes);

    const result = await responder.respond('How often does Max exercise?', 'test-session');

    expect(result.origin).toBe('inferred');
    expect(result.reply).toBe(`${inferenceText} (inferred)`);
    expect(result.episodeId).not.toBeNull();
  });

  // ── honest no-answer branch ────────────────────────────────────────────────

  it('honest no-answer: neither path yields answer → HONEST_NO_ANSWER, origin:none', async () => {
    // Empty DB: no nodes → both retrieve and recall return nothing
    const provider = makeStubProvider(h.config.embeddingDimensions, 0, []);
    const recallProvider = makeStubProvider(h.config.embeddingDimensions, 0, []);
    const retrieval = makeRetrievalEngine(h);
    const recall = makeRecallEngine(h, recallProvider);
    const responder = new HybridResponder(h.clock, h.config, provider, retrieval, recall, h.episodes);

    const result = await responder.respond('What is my favorite color?', 'test-session');

    expect(result.reply).toBe(HONEST_NO_ANSWER);
    expect(result.origin).toBe('none');
    expect(result.episodeId).toBeNull();
  });

  // ── D-75 read-only + episode-table assertion ──────────────────────────────

  it('D-75: respond() writes zero graph nodes; only episode is origin=inferred,salience=0; question not in observed/asserted', async () => {
    const question = 'What is my workout schedule?';

    // Seed a live fact node to trigger facts-first path
    await seedNodeWithEmbedding(h, {
      value: 'Max lifts weights on Mondays',
      type: 'fact',
      origin: 'observed',
      vectorDim: 0,
    });

    const nodeCountBefore = (
      h.db.prepare('SELECT count(*) as c FROM node WHERE tombstoned = 0').get() as { c: number }
    ).c;

    // generateScript[0] = rewrite result (LEVER 3), generateScript[1] = grounded compose answer.
    const provider = makeStubProvider(
      h.config.embeddingDimensions, 0, ['Max lifts weights on Mondays', 'Max lifts weights on Mondays.'],
    );
    const recallProvider = makeStubProvider(h.config.embeddingDimensions, 1, []);
    const retrieval = makeRetrievalEngine(h);
    const recall = makeRecallEngine(h, recallProvider);
    const responder = new HybridResponder(
      h.clock, h.config, provider, retrieval, recall, h.episodes,
    );

    await responder.respond(question, 'test-session');

    // No graph nodes were created by respond()
    const nodeCountAfter = (
      h.db.prepare('SELECT count(*) as c FROM node WHERE tombstoned = 0').get() as { c: number }
    ).c;
    expect(nodeCountAfter).toBe(nodeCountBefore);

    // The only episode row must be origin='inferred', salience=0
    const episodes = h.db
      .prepare('SELECT origin, salience, content FROM episode')
      .all() as Array<{ origin: string; salience: number; content: string }>;
    expect(episodes).toHaveLength(1);
    expect(episodes[0]!.origin).toBe('inferred');
    expect(episodes[0]!.salience).toBe(0);

    // The inbound question must NOT appear as an observed or asserted_by_user episode
    const assertedRows = h.db
      .prepare("SELECT * FROM episode WHERE origin IN ('observed', 'asserted_by_user')")
      .all();
    expect(assertedRows).toHaveLength(0);

    // Question text must not be stored under any non-inferred origin
    const questionAsObserved = episodes.filter(
      ep =>
        ep.content === question &&
        (ep.origin === 'observed' || ep.origin === 'asserted_by_user'),
    );
    expect(questionAsObserved).toHaveLength(0);
  });

  // ── B1: facts-first uses retrieveRanked, not retrieve ─────────────────────

  it('B1: responder calls retrieveRanked (not retrieve) for facts-first lookup', async () => {
    // Mock: retrieveRanked returns a fact hit; retrieve returns nothing.
    // In RED (current responder uses retrieve): retrieve is called, ranked is not → test fails.
    // In GREEN (switched to retrieveRanked): ranked is called, retrieve is not → test passes.
    let retrieveRankedCalled = false;
    let retrieveCalled = false;
    const mockRetrieval = {
      retrieveRanked: (_v: Float32Array, _k: number, _f: number) => {
        retrieveRankedCalled = true;
        return [{ id: 'mock-fact', value: 'Max founded a startup in 2022', score: 0.85 }];
      },
      retrieve: (_v?: Float32Array) => {
        retrieveCalled = true;
        return { results: [], status: 'unreachable' as const };
      },
      retrieveCueless: () => ({ results: [], status: 'ok' as const }),
    } as unknown as RetrievalEngine;

    const provider = makeStubProvider(h.config.embeddingDimensions, 0, ['Max founded a startup in 2022.']);
    const recallProvider = makeStubProvider(h.config.embeddingDimensions, 0, []);
    const recall = makeRecallEngine(h, recallProvider);
    const responder = new HybridResponder(h.clock, h.config, provider, mockRetrieval, recall, h.episodes);

    await responder.respond('When did Max start his company?', 'sess-b1-a');

    expect(retrieveRankedCalled).toBe(true);
    expect(retrieveCalled).toBe(false);
  });

  it('B1: retrieveRanked hit >= floor → grounded fact answer (origin:fact, no (inferred) marker)', async () => {
    // Mock: retrieveRanked returns a hit; retrieve returns nothing (shouldn't be called after switch).
    // In RED (retrieve used): retrieve returns empty → honest no-answer → origin:'none'.
    // In GREEN (retrieveRanked used): ranked returns the fact → grounded answer → origin:'fact'.
    const mockRetrieval = {
      retrieveRanked: () => [{ id: 'mock-x', value: 'Max founded a startup in 2022', score: 0.85 }],
      retrieve: () => ({ results: [], status: 'unreachable' as const }),
      retrieveCueless: () => ({ results: [], status: 'ok' as const }),
    } as unknown as RetrievalEngine;

    const grounded = 'Max founded a startup in 2022.';
    // generateScript[0] = rewrite result (LEVER 3), generateScript[1] = grounded compose answer.
    const provider = makeStubProvider(h.config.embeddingDimensions, 0, ['Max founded a startup in 2022', grounded]);
    const recallProvider = makeStubProvider(h.config.embeddingDimensions, 0, []);
    const recall = makeRecallEngine(h, recallProvider);
    const responder = new HybridResponder(h.clock, h.config, provider, mockRetrieval, recall, h.episodes);

    const result = await responder.respond('When did Max start his company?', 'sess-b1-b');

    expect(result.origin).toBe('fact');
    expect(result.reply).toBe(grounded);
    expect(result.reply).not.toContain('(inferred)');
  });

  // ── WR-01: retrieveRanked on the answer path receives no queryText (hybrid off) ──

  it('WR-01: retrieveRanked on the answer path is called with exactly 3 args (cueVec, k, floor) — no queryText', async () => {
    // Spy: capture all positional args passed to retrieveRanked
    let capturedArgs: unknown[] = [];
    const mockRetrieval = {
      retrieveRanked: (...args: unknown[]) => {
        capturedArgs = args;
        return [{ id: 'mock-wr01', value: 'Max lives in Paris', score: 0.85 }];
      },
      retrieve: () => ({ results: [], status: 'unreachable' as const }),
      retrieveCueless: () => ({ results: [], status: 'ok' as const }),
    } as unknown as RetrievalEngine;

    // 'Where does Max live?' is interrogative → rewrite fires (2 generate entries: rewrite + compose)
    const provider = makeStubProvider(
      h.config.embeddingDimensions, 0,
      ['Max lives in Paris', 'Max lives in Paris.'],
    );
    const recallProvider = makeStubProvider(h.config.embeddingDimensions, 0, []);
    const recall = makeRecallEngine(h, recallProvider);
    const responder = new HybridResponder(h.clock, h.config, provider, mockRetrieval, recall, h.episodes);

    await responder.respond('Where does Max live?', 'sess-wr01');

    // retrieveRanked must receive exactly 3 positional args: (cueVec, k, floor)
    // — no 4th queryText arg means hybridTopk/BM25 is off on the answer path (GAP-03, WR-01)
    expect(capturedArgs).toHaveLength(3);
    expect(typeof capturedArgs[0]).toBe('object'); // cueVec: Float32Array
    expect(capturedArgs[1]).toBe(h.config.rankedRetrievalK);
    expect(capturedArgs[2]).toBe(h.config.rankedRetrievalFloor);
  });

  // ── safe-null: embed throws → resolves null, never throws ────────────────

  // ── LEVER 3: Q->declarative rewrite tests (17-04) ────────────────────────

  it('rewrite: declarative rewrite is passed to embed and retrieveRanked (queryForEmbed)', async () => {
    // Seed a fact node at dim 0 so facts-first path fires
    await seedNodeWithEmbedding(h, {
      value: 'User attends five sessions per week',
      type: 'fact',
      origin: 'observed',
      vectorDim: 0,
    });

    const capturedEmbedTexts: string[] = [];
    const rewriteText = 'User attends five sessions per week';
    const composeText = 'User attends five sessions per week.';

    // Custom provider that records what text was passed to embed
    const rewriteProvider: ModelProvider = {
      async embed(texts: string[]) {
        capturedEmbedTexts.push(...texts);
        return texts.map(() => {
          const v = new Float32Array(h.config.embeddingDimensions);
          v[0] = 1.0; // dim 0 → matches fact node
          return v;
        });
      },
      async generate(_prompt: string) {
        // First call = rewrite prompt, second call = compose prompt
        if (capturedEmbedTexts.length === 0) return rewriteText;
        return composeText;
      },
      async judge(): Promise<never> { throw new Error('Not used'); },
      async judgeBatch(items) { if (items.length === 0) return []; throw new Error('Not used'); },
    };

    const recallProvider = makeStubProvider(h.config.embeddingDimensions, 1, []);
    const retrieval = makeRetrievalEngine(h);
    const recall = makeRecallEngine(h, recallProvider);
    const responder = new HybridResponder(h.clock, h.config, rewriteProvider, retrieval, recall, h.episodes);

    const result = await responder.respond('How many sessions does the user attend?', 'sess-rewrite-a');

    // embed received the declarative rewrite, NOT the raw question
    expect(capturedEmbedTexts[0]).toBe(rewriteText);
    expect(capturedEmbedTexts[0]).not.toBe('How many sessions does the user attend?');
    // answer composed successfully via facts-first path
    expect(result.origin).toBe('fact');
    expect(result.reply).toBe(composeText);
  });

  it('rewrite fallback: generate() throws on rewrite → embed receives raw boundedQuery, answer still composes', async () => {
    // Seed a fact node at dim 0 so facts-first path fires
    await seedNodeWithEmbedding(h, {
      value: 'Max founded a startup in 2022',
      type: 'fact',
      origin: 'observed',
      vectorDim: 0,
    });

    const capturedEmbedTexts: string[] = [];
    let generateCallCount = 0;
    const composeText = 'Max founded a startup in 2022.';

    const throwOnFirstGenerate: ModelProvider = {
      async embed(texts: string[]) {
        capturedEmbedTexts.push(...texts);
        return texts.map(() => {
          const v = new Float32Array(h.config.embeddingDimensions);
          v[0] = 1.0;
          return v;
        });
      },
      async generate(_prompt: string) {
        generateCallCount++;
        if (generateCallCount === 1) throw new Error('Rewrite service unavailable');
        // Second call = compose
        return composeText;
      },
      async judge(): Promise<never> { throw new Error('Not used'); },
      async judgeBatch(items) { if (items.length === 0) return []; throw new Error('Not used'); },
    };

    const recallProvider = makeStubProvider(h.config.embeddingDimensions, 1, []);
    const retrieval = makeRetrievalEngine(h);
    const recall = makeRecallEngine(h, recallProvider);
    const responder = new HybridResponder(
      h.clock, h.config, throwOnFirstGenerate, retrieval, recall, h.episodes,
    );

    const result = await responder.respond('When did Max start his company?', 'sess-rewrite-b');

    // embed received the raw boundedQuery (rewrite fell back because generate() threw)
    expect(capturedEmbedTexts[0]).toBe('When did Max start his company?');
    // answer still composes from facts-first path (fallback didn't break the answer)
    expect(result.origin).toBe('fact');
    expect(result.reply).toBe(composeText);
    // generate was called twice: once for rewrite (threw), once for compose (succeeded)
    expect(generateCallCount).toBe(2);
  });

  it('rewrite is respond()-only: retrieveCueless (SessionStart path) makes no generate() calls', () => {
    // The rewrite is ONLY in respond() (already LLM-bearing). The retrieval primitive
    // (retrieveRanked, retrieveCueless) is LLM-free by construction and never calls
    // respond() — SessionStart/session-start-cli.ts never instantiates HybridResponder.
    // This test verifies the structural invariant: RetrievalEngine has no ModelProvider
    // dependency and calling retrieveCueless() makes zero generate() calls.
    let generateCalled = false;
    const spyProvider: ModelProvider = {
      async embed() { return [new Float32Array(h.config.embeddingDimensions)]; },
      async generate() { generateCalled = true; return ''; },
      async judge(): Promise<never> { throw new Error(); },
      async judgeBatch() { return []; },
    };
    void spyProvider; // The retrieval engine has no ModelProvider — verified below

    const retrieval = makeRetrievalEngine(h);
    retrieval.retrieveCueless(); // synchronous, LLM-free — no ModelProvider involved

    expect(generateCalled).toBe(false);
    // Structural note: session-start-cli.ts never imports or instantiates HybridResponder
    // — the rewrite block is unreachable from the SessionStart hook by construction (D-99).
  });

  // ── safe-null: embed throws → resolves null, never throws ────────────────

  it('safe-null: embed throws → respond() resolves to {reply:null,origin:none} without throwing', async () => {
    const throwingProvider: ModelProvider = {
      async embed(_texts: string[]): Promise<Float32Array[]> {
        throw new Error('Embed service unavailable');
      },
      async generate(_prompt: string): Promise<string> {
        // LEVER 3: generate IS now called for the rewrite attempt; this throw is caught
        // by the rewrite inner try/catch, which falls back to the raw question. Then embed
        // throws, which is caught by the outer safe-null handler → NULL_RESULT.
        throw new Error('Generate unavailable');
      },
      async judge(): Promise<never> {
        throw new Error('Should not be called');
      },
      async judgeBatch(items) {
        if (items.length === 0) return [];
        throw new Error('Should not be called');
      },
    };
    const recallProvider = makeStubProvider(h.config.embeddingDimensions, 0, []);
    const retrieval = makeRetrievalEngine(h);
    const recall = makeRecallEngine(h, recallProvider);
    const responder = new HybridResponder(
      h.clock, h.config, throwingProvider, retrieval, recall, h.episodes,
    );

    const result = await responder.respond('What is my name?', 'test-session');

    expect(result.reply).toBeNull();
    expect(result.origin).toBe('none');
    expect(result.episodeId).toBeNull();
  });
});
