/**
 * tests/recall-scope-filter.test.ts — scope filter on RecallEngine.recall() (RECALL-01 / D-01 / D-S1).
 *
 * Verifies:
 *  - Test 1 (filter excludes other projects): members with scope in {slug, global} survive;
 *    members scoped to another named project are excluded from the neighborhood/compose input.
 *  - Test 2 (no scope = unchanged): recall with no scope arg produces an identical neighborhood
 *    to a no-scope baseline run on the same seed.
 *  - Test 3 (empty after filter): when NO assembled member is in {slug, global}, recall returns
 *    NULL_RESULT (inference null, episodeId null) WITHOUT throwing and WITHOUT an LLM compose call.
 *  - Test 4 (D-S1 ranking guard): scope filter is applied only to the assembled neighborhood
 *    AFTER schemaNode resolution and topk; bestMatch/topk selection and schema resolution order
 *    are unchanged whether or not a scope is passed.
 *  - Test 5 (D-S1 source guard): grep of topk.ts source contains NO reference to 'scope'
 *    filtering logic (D-S1 invariant: scope never enters ranking).
 *
 * Harness: in-memory Database, initSchema, FakeClock, DEFAULT_CONFIG, MockModelProvider.
 * ZERO API calls.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
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
import { RecallEngine } from '../src/recall';
import { newId } from '../src/lib/hash';

// ---------------------------------------------------------------------------
// Harness helpers
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
  const config: EngineConfig = { ...DEFAULT_CONFIG, dbPath: ':memory:', ...configOverrides };
  const store = new SemanticStore(db, clock, config);
  const episodes = new EpisodicStore(db, clock, config);
  const strength = new StrengthDecayManager(db, clock, config);
  const retriever = new CandidateRetriever(db);
  return { db, clock, store, episodes, strength, retriever, config };
}

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

/**
 * Capturing provider: records the compose prompt for later inspection.
 * embed always returns unit vector in dim 0 (best match = whatever has dim 0 embedding).
 */
function makeCapturingProvider(
  dims: number,
  onPrompt: (prompt: string) => void,
  responseText = 'captured scope inference',
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
      throw new Error('judge should not be called in recall-scope-filter tests');
    },
    async judgeBatch(items) {
      if (items.length === 0) return [];
      throw new Error('judgeBatch should not be called in recall-scope-filter tests');
    },
  };
}

/** Provider that throws if generate is called (for empty-result guard tests). */
function makeNoGenerateProvider(dims: number): ModelProvider {
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      const vec = new Float32Array(dims);
      vec[0] = 1.0;
      return texts.map(() => vec.slice());
    },
    async generate(_prompt: string): Promise<string> {
      throw new Error('generate MUST NOT be called when neighborhood is empty after scope filter');
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
    h.db, h.clock, h.config, provider, h.retriever, h.store, h.strength, h.episodes,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RecallEngine scope filter (RECALL-01 / D-01 / D-S1)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  // ── Test 1: filter excludes other projects ─────────────────────────────────
  //
  // Seed a schema abstracting members across scopes {usage, tonos, global}.
  // recall(query, session, 'usage') must yield a neighborhood/compose input that contains
  // the usage + global members and EXCLUDES the tonos member.

  it('Test 1: scope filter includes {slug, global} members, excludes other named-project members', async () => {
    const dims = h.config.embeddingDimensions;

    // Schema node at dim 0 → best cosine match for query
    const schemaId = await seedNodeWithEmbedding(h, {
      value: 'project architecture patterns',
      type: 'schema',
      origin: 'inferred',
      vectorDim: 0,
    });

    // Three member nodes — one per scope
    const usageMemberId = await seedNodeWithEmbedding(h, {
      value: 'usage member: contextscope audits per-turn Claude Code context',
      type: 'fact',
      vectorDim: 1,
    });
    const tonosMemberId = await seedNodeWithEmbedding(h, {
      value: 'tonos member: Tonos uses a daily eval pipeline',
      type: 'fact',
      vectorDim: 2,
    });
    const globalMemberId = await seedNodeWithEmbedding(h, {
      value: 'global member: TypeScript is the standard for this stack',
      type: 'fact',
      vectorDim: 3,
    });

    // Wire all three members to the schema
    h.store.upsertEdge({ src: schemaId, dst: usageMemberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });
    h.store.upsertEdge({ src: schemaId, dst: tonosMemberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });
    h.store.upsertEdge({ src: schemaId, dst: globalMemberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });

    // Assign scopes
    h.store.upsertNodeScope({ node_id: usageMemberId, scope: 'usage', updated_at: 1 });
    h.store.upsertNodeScope({ node_id: tonosMemberId, scope: 'tonos', updated_at: 1 });
    h.store.upsertNodeScope({ node_id: globalMemberId, scope: 'global', updated_at: 1 });

    let capturedPrompt = '';
    const provider = makeCapturingProvider(dims, (p) => { capturedPrompt = p; });
    const engine = makeEngine(h, provider);

    const result = await engine.recall('architecture', 'test-session', 'usage');

    // The call should succeed (inference returned)
    expect(result.origin).toBe('inferred');
    expect(result.inference).toBe('captured scope inference');
    expect(result.episodeId).not.toBeNull();

    // The compose prompt must contain usage + global members
    expect(capturedPrompt).toContain('usage member: contextscope audits per-turn Claude Code context');
    expect(capturedPrompt).toContain('global member: TypeScript is the standard for this stack');

    // The compose prompt must NOT contain the tonos member
    expect(capturedPrompt).not.toContain('tonos member: Tonos uses a daily eval pipeline');
  });

  // ── Test 2: no scope = unchanged ──────────────────────────────────────────
  //
  // recall with no scope arg produces the identical neighborhood it produces today.
  // Assert against a baseline run on the same seed.

  it('Test 2: recall with no scope argument produces byte-identical neighborhood to baseline', async () => {
    const dims = h.config.embeddingDimensions;

    const schemaId = await seedNodeWithEmbedding(h, {
      value: 'development patterns',
      type: 'schema',
      origin: 'inferred',
      vectorDim: 0,
    });
    const member1Id = await seedNodeWithEmbedding(h, {
      value: 'member alpha: usage scoped',
      type: 'fact',
      vectorDim: 1,
    });
    const member2Id = await seedNodeWithEmbedding(h, {
      value: 'member beta: tonos scoped',
      type: 'fact',
      vectorDim: 2,
    });
    h.store.upsertEdge({ src: schemaId, dst: member1Id, rel: 'abstracts', w: 0.8, kind: 'abstracts' });
    h.store.upsertEdge({ src: schemaId, dst: member2Id, rel: 'abstracts', w: 0.8, kind: 'abstracts' });
    h.store.upsertNodeScope({ node_id: member1Id, scope: 'usage', updated_at: 1 });
    h.store.upsertNodeScope({ node_id: member2Id, scope: 'tonos', updated_at: 1 });

    // Baseline run: no scope (two-arg form)
    let baselinePrompt = '';
    const baselineProvider = makeCapturingProvider(dims, (p) => { baselinePrompt = p; }, 'baseline inference');
    const baselineEngine = makeEngine(h, baselineProvider);
    await baselineEngine.recall('development', 'test-session');

    // Scope-omitted run (explicit undefined)
    let unscopedPrompt = '';
    const unscopedProvider = makeCapturingProvider(dims, (p) => { unscopedPrompt = p; }, 'unscoped inference');
    const unscopedEngine = makeEngine(h, unscopedProvider);
    await unscopedEngine.recall('development', 'test-session', undefined);

    // Both forms must produce identical prompts (both members included, order preserved)
    expect(unscopedPrompt).toBe(baselinePrompt);
    expect(baselinePrompt).toContain('member alpha: usage scoped');
    expect(baselinePrompt).toContain('member beta: tonos scoped');
  });

  // ── Test 3: empty after filter → NULL_RESULT, NO LLM compose call ─────────
  //
  // When NO assembled member is in {slug, global}, recall returns NULL_RESULT
  // (inference null, episodeId null) WITHOUT throwing and WITHOUT an LLM compose call.

  it('Test 3: returns NULL_RESULT (no LLM call) when all members are filtered out by scope', async () => {
    const dims = h.config.embeddingDimensions;

    const schemaId = await seedNodeWithEmbedding(h, {
      value: 'schema for out-of-scope test',
      type: 'schema',
      origin: 'inferred',
      vectorDim: 0,
    });
    const tonosMember1Id = await seedNodeWithEmbedding(h, {
      value: 'tonos member: eval pipeline fact',
      type: 'fact',
      vectorDim: 1,
    });
    const tonosMember2Id = await seedNodeWithEmbedding(h, {
      value: 'tonos member: daily pipeline detail',
      type: 'fact',
      vectorDim: 2,
    });
    h.store.upsertEdge({ src: schemaId, dst: tonosMember1Id, rel: 'abstracts', w: 0.8, kind: 'abstracts' });
    h.store.upsertEdge({ src: schemaId, dst: tonosMember2Id, rel: 'abstracts', w: 0.8, kind: 'abstracts' });
    h.store.upsertNodeScope({ node_id: tonosMember1Id, scope: 'tonos', updated_at: 1 });
    h.store.upsertNodeScope({ node_id: tonosMember2Id, scope: 'tonos', updated_at: 1 });

    // Using noGenerateProvider: if generate is called, the test fails
    const provider = makeNoGenerateProvider(dims);
    const engine = makeEngine(h, provider);

    // Requesting 'usage' scope → all tonos members filtered out → NULL_RESULT
    const result = await engine.recall('pipeline', 'test-session', 'usage');

    expect(result.origin).toBe('inferred');
    expect(result.inference).toBeNull();
    expect(result.episodeId).toBeNull();

    // No episode appended when inference is null
    const rows = (h.db.prepare("SELECT * FROM episode WHERE origin = 'inferred'").all()) as unknown[];
    expect(rows).toHaveLength(0);
  });

  // ── Test 4: D-S1 ranking guard — schema resolution unchanged with/without scope ────
  //
  // The resolved schemaNode id is the same with and without scope when the best cosine match
  // is out-of-scope. topk + schema resolution run before the filter.

  it('Test 4 (D-S1): schema resolution is identical with/without scope when best cosine match is out-of-scope', async () => {
    const dims = h.config.embeddingDimensions;

    // Schema at dim 0 → best cosine match for the query
    const schemaId = await seedNodeWithEmbedding(h, {
      id: 'schema-ds1-test',
      value: 'the correct schema (out-of-scope cosine winner)',
      type: 'schema',
      origin: 'inferred',
      vectorDim: 0,
    });
    // One member scoped to 'tonos' (out of 'usage')
    const tonosMemberId = await seedNodeWithEmbedding(h, {
      value: 'tonos member: out of scope for usage recall',
      type: 'fact',
      vectorDim: 1,
    });
    // One member scoped to 'usage' (in scope)
    const usageMemberId = await seedNodeWithEmbedding(h, {
      value: 'usage member: in scope, should survive filter',
      type: 'fact',
      vectorDim: 2,
    });

    h.store.upsertEdge({ src: schemaId, dst: tonosMemberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });
    h.store.upsertEdge({ src: schemaId, dst: usageMemberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });
    h.store.upsertNodeScope({ node_id: tonosMemberId, scope: 'tonos', updated_at: 1 });
    h.store.upsertNodeScope({ node_id: usageMemberId, scope: 'usage', updated_at: 1 });

    let promptWithScope = '';
    let promptWithoutScope = '';

    const engineWithScope = makeEngine(
      h,
      makeCapturingProvider(dims, (p) => { promptWithScope = p; }, 'inference with scope'),
    );
    const engineWithoutScope = makeEngine(
      h,
      makeCapturingProvider(dims, (p) => { promptWithoutScope = p; }, 'inference without scope'),
    );

    // Run with scope 'usage'
    const resultWithScope = await engineWithScope.recall('query', 'test-session', 'usage');
    // Run without scope
    const resultWithoutScope = await engineWithoutScope.recall('query', 'test-session');

    // Both must succeed (inference is non-null — schema is the same in both cases)
    expect(resultWithScope.inference).toBe('inference with scope');
    expect(resultWithoutScope.inference).toBe('inference without scope');

    // Both prompts must reference the SAME schema label (D-S1: schema resolution unchanged)
    expect(promptWithScope).toContain('the correct schema (out-of-scope cosine winner)');
    expect(promptWithoutScope).toContain('the correct schema (out-of-scope cosine winner)');

    // Scoped run: only usage member in prompt
    expect(promptWithScope).toContain('usage member: in scope, should survive filter');
    expect(promptWithScope).not.toContain('tonos member: out of scope for usage recall');

    // Unscoped run: both members in prompt
    expect(promptWithoutScope).toContain('usage member: in scope, should survive filter');
    expect(promptWithoutScope).toContain('tonos member: out of scope for usage recall');
  });

  // ── Test 5: D-S1 source guard — topk.ts contains NO scope reference ──────
  //
  // The test reads the topk.ts source file and asserts no line references scope filtering
  // (D-S1: scope NEVER enters the CandidateRetriever / ranking path).

  it('Test 5 (D-S1 source guard): topk.ts contains no scope filtering reference', () => {
    const topkPath = path.join(__dirname, '..', 'src', 'retrieval', 'topk.ts');
    const topkSource = fs.readFileSync(topkPath, 'utf-8');

    // Guard: 'scope' must not appear as part of a scope-filter operation in topk.ts.
    // We allow the word 'scope' in comments that reference the design decision (D-S1),
    // but it must never appear in code contexts (variable/property access, filtering).
    // Simple check: split by lines, find any line that contains 'scope' outside a comment.
    const nonCommentLines = topkSource.split('\n').filter(line => {
      const trimmed = line.trimStart();
      return trimmed.includes('scope') && !trimmed.startsWith('//') && !trimmed.startsWith('*');
    });
    expect(nonCommentLines, `topk.ts must not reference scope in code (D-S1). Found:\n${nonCommentLines.join('\n')}`).toHaveLength(0);
  });
});
