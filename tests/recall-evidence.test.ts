/**
 * tests/recall-evidence.test.ts — RecallEngine evidence mode locks (RECALL-04, D-07).
 *
 * Verifies:
 *  - Typed-path evidence: path='typed', anchor + frontier nodes cited, predicate edges cited.
 *  - Neighborhood-path evidence: path='neighborhood', schema + members cited, abstracts
 *    (+ traversed schema_rel) edges cited.
 *  - Zero provider.generate calls in evidence mode (exact 0, not "less than").
 *  - Zero writes: episode and activation_trace row counts unchanged; episodeId is null.
 *  - Legacy RecallResult fields (inference/origin) survive unchanged in evidence mode.
 *  - Prose mode (opts omitted) is untouched: generate is called, an episode IS appended.
 *  - No-resolution case: evidence.path === 'none' with empty arrays (never omitted).
 *  - Scope filter still applies in evidence mode.
 *  - Citation format: recense://<type>/<raw node id>.
 *  - Source guard: 'evidence' never shares a line with 'episodes.append' or 'provider.generate'.
 *
 * Harness mirrors tests/recall-scope-filter.test.ts (in-memory DB, FakeClock, DEFAULT_CONFIG,
 * manual ModelProvider stubs) and tests/recall-engine.test.ts (gloss-embedding seeding for the
 * typed path). ZERO real API calls.
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
import type { ModelProvider } from '../src/model/provider';
import { RecallEngine } from '../src/recall';
import { SQLiteActivationTraceSink } from '../src/viz/activation-sink';
import { GLOSS_EMBEDDINGS_META_KEY } from '../src/consolidation/gloss-embeddings';
import { PREDICATES } from '../src/model/typed-predicates';
import { newId } from '../src/lib/hash';

// ---------------------------------------------------------------------------
// Harness helpers (mirrors recall-scope-filter.test.ts / recall-engine.test.ts)
// ---------------------------------------------------------------------------

const TEST_DIMS = 12; // one dim per predicate gloss, exact test math (recall-engine.test.ts precedent)

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

function seedNode(
  h: Harness,
  opts: {
    id?: string;
    value: string;
    type?: 'fact' | 'entity' | 'schema' | 'doc' | 'insight';
    origin?: 'observed' | 'asserted_by_user' | 'inferred';
    vectorDim?: number; // omit → no embedding row (not needed for nodes only reached via edges)
  },
): string {
  const id = opts.id ?? newId();
  h.store.upsertNode({
    id,
    type: opts.type ?? 'fact',
    value: opts.value,
    origin: opts.origin ?? 'observed',
  });
  if (opts.vectorDim !== undefined) {
    const vec = new Float32Array(TEST_DIMS);
    vec[opts.vectorDim] = 1.0;
    h.store.setEmbedding(id, vec);
  }
  return id;
}

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

/** Provider whose embed() places a unit component at `cueVecDim`; generate is call-counted. */
function makeProvider(opts: {
  dims: number;
  cueVecDim?: number; // omit → equal-component vector (no confident predicate match)
  generateResponse?: string;
  onGenerate?: () => void;
}): ModelProvider {
  const { dims, cueVecDim, generateResponse = 'stub inference', onGenerate } = opts;
  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => {
        const vec = new Float32Array(dims);
        if (cueVecDim !== undefined) {
          vec[cueVecDim] = 1.0;
        } else {
          const component = 1.0 / Math.sqrt(dims);
          for (let i = 0; i < dims; i++) vec[i] = component;
        }
        return vec;
      });
    },
    async generate(_prompt: string): Promise<string> {
      onGenerate?.();
      return generateResponse;
    },
    async judge(): Promise<never> {
      throw new Error('judge should not be called in recall-evidence tests');
    },
    async judgeBatch(items) {
      if (items.length === 0) return [];
      throw new Error('judgeBatch should not be called in recall-evidence tests');
    },
  };
}

function makeEngine(h: Harness, provider: ModelProvider, traceSink?: SQLiteActivationTraceSink): RecallEngine {
  return new RecallEngine(
    h.db, h.clock, h.config, provider, h.retriever, h.store, h.strength, h.episodes, traceSink,
  );
}

function episodeCount(h: Harness): number {
  return (h.db.prepare("SELECT count(*) as n FROM episode").get() as { n: number }).n;
}

function activationTraceCount(h: Harness): number {
  return (h.db.prepare("SELECT count(*) as n FROM activation_trace").get() as { n: number }).n;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RecallEngine evidence mode (RECALL-04, D-07)', () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  it('Test 1: typed path — evidence.path=typed, anchor + frontier nodes cited, predicate edges cited', async () => {
    h = makeHarness({ predicateGlossThreshold: 0.35 });
    storeGlossEmbeddings(h.store);

    const anchorId = seedNode(h, { id: 'anchor-1', value: 'recense project', type: 'entity', vectorDim: 0 });
    const targetId = seedNode(h, { id: 'target-1', value: 'Max Beato', type: 'entity', vectorDim: 1 });
    h.store.upsertEdge({ src: anchorId, dst: targetId, rel: 'built_by', w: 1.0, kind: 'relation' });

    let generateCalls = 0;
    const provider = makeProvider({ dims: TEST_DIMS, cueVecDim: 0, onGenerate: () => { generateCalls++; } });
    const engine = makeEngine(h, provider);

    const result = await engine.recall('who built this', 'session-1', undefined, { evidence: true });

    expect(result.evidence?.path).toBe('typed');
    const citedIds = result.evidence!.nodes.map(n => n.id);
    expect(citedIds).toContain(anchorId);
    expect(citedIds).toContain(targetId);
    expect(result.evidence!.edges).toContainEqual({ src: anchorId, rel: 'built_by', dst: targetId, kind: 'relation' });
    expect(generateCalls).toBe(0);
  });

  it('Test 1b (CR-02 regression): multi-anchor pool — every cited edge exists in the edge table; no fabricated bestMatch attribution', async () => {
    h = makeHarness({ predicateGlossThreshold: 0.35 });
    storeGlossEmbeddings(h.store);

    // Decoy anchor: cosine 1.0 with the cue (bestMatch, topHits[0]) but carries NO edges.
    const decoyId = seedNode(h, { id: 'decoy-anchor', value: 'decoy best match entity', type: 'entity', vectorDim: 0 });
    // Real anchor: lower cosine (0.6) — in the typedAnchorPoolK pool but NOT bestMatch —
    // and it holds the ONLY built_by edge to the frontier target.
    const realAnchorId = seedNode(h, { id: 'real-anchor', value: 'real edge-bearing entity', type: 'entity' });
    const realVec = new Float32Array(TEST_DIMS);
    realVec[0] = 0.6;
    realVec[1] = 0.8;
    h.store.setEmbedding(realAnchorId, realVec);
    const targetId = seedNode(h, { id: 'edge-target-1b', value: 'the frontier target', type: 'entity' });
    h.store.upsertEdge({ src: realAnchorId, dst: targetId, rel: 'built_by', w: 1.0, kind: 'relation' });

    const provider = makeProvider({ dims: TEST_DIMS, cueVecDim: 0 });
    const engine = makeEngine(h, provider);

    const result = await engine.recall('who built this thing', 'session-1b', undefined, { evidence: true });

    expect(result.evidence?.path).toBe('typed');
    // Every emitted (src, rel, dst) triple must be a REAL row in the edge table — the
    // whole point of --evidence is verifiable citations, never a guessed attribution.
    const edgeExists = h.db.prepare('SELECT 1 AS one FROM edge WHERE src = ? AND rel = ? AND dst = ?');
    expect(result.evidence!.edges.length).toBeGreaterThan(0);
    for (const e of result.evidence!.edges) {
      expect(
        edgeExists.get(e.src, e.rel, e.dst),
        `cited edge (${e.src} -${e.rel}-> ${e.dst}) does not exist in the edge table`,
      ).toBeDefined();
    }
    // The real traversed edge is cited; the decoy bestMatch is never fabricated as a src.
    expect(result.evidence!.edges).toContainEqual({ src: realAnchorId, rel: 'built_by', dst: targetId, kind: 'relation' });
    expect(result.evidence!.edges.some(e => e.src === decoyId)).toBe(false);
    // Contributing anchor + frontier node are cited.
    const citedIds = result.evidence!.nodes.map(n => n.id);
    expect(citedIds).toContain(realAnchorId);
    expect(citedIds).toContain(targetId);
  });

  it('Test 2: neighborhood path — evidence.path=neighborhood, schema+members cited, abstracts + schema_rel edges cited', async () => {
    const schemaAId = seedNode(h, { value: 'primary schema', type: 'schema', origin: 'inferred', vectorDim: 0 });
    const memberA1Id = seedNode(h, { value: 'member of primary schema', type: 'fact', vectorDim: 1 });
    const schemaBId = seedNode(h, { value: 'related schema', type: 'schema', origin: 'inferred' });
    const memberB1Id = seedNode(h, { value: 'member of related schema', type: 'fact' });

    h.store.upsertEdge({ src: schemaAId, dst: memberA1Id, rel: 'abstracts', w: 0.8, kind: 'abstracts' });
    h.store.upsertEdge({ src: schemaAId, dst: schemaBId, rel: 'schema_rel', w: 0.9, kind: 'schema_rel' });
    h.store.upsertEdge({ src: schemaBId, dst: memberB1Id, rel: 'abstracts', w: 0.8, kind: 'abstracts' });

    const provider = makeProvider({ dims: TEST_DIMS, cueVecDim: 0 });
    const engine = makeEngine(h, provider);

    const result = await engine.recall('tell me about the schema', 'session-2', undefined, { evidence: true });

    expect(result.evidence?.path).toBe('neighborhood');
    const citedIds = result.evidence!.nodes.map(n => n.id);
    expect(citedIds).toContain(schemaAId);
    expect(citedIds).toContain(memberA1Id);
    expect(citedIds).toContain(memberB1Id);

    const edgeTriples = result.evidence!.edges.map(e => `${e.src}->${e.rel}->${e.dst}`);
    expect(edgeTriples).toContain(`${schemaAId}->abstracts->${memberA1Id}`);
    expect(edgeTriples).toContain(`${schemaAId}->schema_rel->${schemaBId}`);
    expect(edgeTriples).toContain(`${schemaBId}->abstracts->${memberB1Id}`);
  });

  it('Test 3: evidence mode calls provider.generate exactly ZERO times', async () => {
    const schemaId = seedNode(h, { value: 'zero-generate schema', type: 'schema', origin: 'inferred', vectorDim: 0 });
    const memberId = seedNode(h, { value: 'zero-generate member', type: 'fact', vectorDim: 1 });
    h.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });

    let generateCalls = 0;
    const provider = makeProvider({ dims: TEST_DIMS, cueVecDim: 0, onGenerate: () => { generateCalls++; } });
    const engine = makeEngine(h, provider);

    await engine.recall('zero generate query', 'session-3', undefined, { evidence: true });

    expect(generateCalls).toBe(0);
  });

  it('Test 4: evidence mode appends ZERO episodes and ZERO activation_trace rows; episodeId is null', async () => {
    const schemaId = seedNode(h, { value: 'zero-write schema', type: 'schema', origin: 'inferred', vectorDim: 0 });
    const memberId = seedNode(h, { value: 'zero-write member', type: 'fact', vectorDim: 1 });
    h.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });

    // Wire a REAL SQLite trace sink so a prose-mode run WOULD write a row — proves this
    // assertion is meaningful, not vacuously true because tracing is Noop.
    const traceSink = new SQLiteActivationTraceSink(h.db, h.clock);
    const provider = makeProvider({ dims: TEST_DIMS, cueVecDim: 0 });
    const engine = makeEngine(h, provider, traceSink);

    const episodesBefore = episodeCount(h);
    const tracesBefore = activationTraceCount(h);

    const result = await engine.recall('zero write query', 'session-4', undefined, { evidence: true });

    expect(episodeCount(h)).toBe(episodesBefore);
    expect(activationTraceCount(h)).toBe(tracesBefore);
    expect(result.episodeId).toBeNull();
  });

  it('Test 5: inference is null and origin is inferred — legacy RecallResult fields survive', async () => {
    const schemaId = seedNode(h, { value: 'legacy-fields schema', type: 'schema', origin: 'inferred', vectorDim: 0 });
    const memberId = seedNode(h, { value: 'legacy-fields member', type: 'fact', vectorDim: 1 });
    h.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });

    const provider = makeProvider({ dims: TEST_DIMS, cueVecDim: 0 });
    const engine = makeEngine(h, provider);

    const result = await engine.recall('legacy fields query', 'session-5', undefined, { evidence: true });

    expect(result.inference).toBeNull();
    expect(result.origin).toBe('inferred');
  });

  it('Test 6: prose mode (opts omitted) is unchanged — generate IS called, an episode IS appended', async () => {
    const schemaId = seedNode(h, { value: 'prose schema', type: 'schema', origin: 'inferred', vectorDim: 0 });
    const memberId = seedNode(h, { value: 'prose member', type: 'fact', vectorDim: 1 });
    h.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });

    let generateCalls = 0;
    const provider = makeProvider({
      dims: TEST_DIMS, cueVecDim: 0, generateResponse: 'a prose inference',
      onGenerate: () => { generateCalls++; },
    });
    const engine = makeEngine(h, provider);

    const episodesBefore = episodeCount(h);
    const result = await engine.recall('prose query', 'session-6');

    expect(generateCalls).toBe(1);
    expect(episodeCount(h)).toBe(episodesBefore + 1);
    expect(result.inference).toBe('a prose inference');
    expect(result.episodeId).not.toBeNull();
    expect(result.evidence).toBeUndefined();
  });

  it('Test 7: when nothing resolves, evidence mode returns path=none with empty arrays', async () => {
    // Empty DB — no nodes at all, so topk returns [] and bestMatch is undefined.
    const provider = makeProvider({ dims: TEST_DIMS, cueVecDim: 0 });
    const engine = makeEngine(h, provider);

    const result = await engine.recall('nothing to find', 'session-7', undefined, { evidence: true });

    expect(result.evidence).toEqual({ path: 'none', nodes: [], edges: [] });
    expect(result.inference).toBeNull();
    expect(result.episodeId).toBeNull();
  });

  it('Test 8: scope filter still applies in evidence mode — out-of-scope member absent from evidence.nodes', async () => {
    const schemaId = seedNode(h, { value: 'scoped schema', type: 'schema', origin: 'inferred', vectorDim: 0 });
    const usageMemberId = seedNode(h, { value: 'usage-scoped member', type: 'fact', vectorDim: 1 });
    const tonosMemberId = seedNode(h, { value: 'tonos-scoped member', type: 'fact', vectorDim: 2 });
    h.store.upsertEdge({ src: schemaId, dst: usageMemberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });
    h.store.upsertEdge({ src: schemaId, dst: tonosMemberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });
    h.store.upsertNodeScope({ node_id: usageMemberId, scope: 'usage', updated_at: 1 });
    h.store.upsertNodeScope({ node_id: tonosMemberId, scope: 'tonos', updated_at: 1 });

    const provider = makeProvider({ dims: TEST_DIMS, cueVecDim: 0 });
    const engine = makeEngine(h, provider);

    const result = await engine.recall('scoped query', 'session-8', 'usage', { evidence: true });

    const citedIds = result.evidence!.nodes.map(n => n.id);
    expect(citedIds).toContain(usageMemberId);
    expect(citedIds).not.toContain(tonosMemberId);
    const edgeDsts = result.evidence!.edges.map(e => e.dst);
    expect(edgeDsts).not.toContain(tonosMemberId);
  });

  it('Test 9: citation format is recense://<type>/<raw node id> for every cited node', async () => {
    const schemaId = seedNode(h, { value: 'citation-format schema', type: 'schema', origin: 'inferred', vectorDim: 0 });
    const memberId = seedNode(h, { value: 'citation-format member', type: 'fact', vectorDim: 1 });
    h.store.upsertEdge({ src: schemaId, dst: memberId, rel: 'abstracts', w: 0.8, kind: 'abstracts' });

    const provider = makeProvider({ dims: TEST_DIMS, cueVecDim: 0 });
    const engine = makeEngine(h, provider);

    const result = await engine.recall('citation format query', 'session-9', undefined, { evidence: true });

    const CITE_RE = /^recense:\/\/(entity|fact|schema|doc|insight)\/([^/]+)$/;
    expect(result.evidence!.nodes.length).toBeGreaterThan(0);
    for (const n of result.evidence!.nodes) {
      const m = n.cite.match(CITE_RE);
      expect(m, `cite "${n.cite}" must match recense://<type>/<raw id>`).not.toBeNull();
      expect(m![1]).toBe(n.type);
      expect(m![2]).toBe(n.id);
    }
  });

  it('Test 10 (source guard): "evidence" never appears on the same line as episodes.append or provider.generate', () => {
    const srcPath = path.join(__dirname, '..', 'src', 'recall', 'index.ts');
    const src = fs.readFileSync(srcPath, 'utf-8');
    const offendingLines = src.split('\n').filter(line =>
      line.includes('evidence') && (line.includes('episodes.append') || line.includes('provider.generate')),
    );
    expect(offendingLines, `Found evidence + write-call on the same line:\n${offendingLines.join('\n')}`).toHaveLength(0);
  });
});
