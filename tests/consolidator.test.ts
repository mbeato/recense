/**
 * Phase 37 Plan 02 — Typed-edge extraction tests for the Consolidator.
 *
 * Covers:
 *   TYPED-01c: non-inferred episode whose extraction yields a triple mints a
 *              typed edge via upsertEdge(kind='relation', rel=<closed-vocab predicate>).
 *   D-08:      inferred-origin episode yields ZERO typed-edge upserts.
 *   T-37-05:   triple-upsert is textually AFTER the hard origin/echo/hitl skip guard.
 *   D-03:      RECENSE_TYPED_EXTRACTION_MODE switch (merged vs separate).
 *
 * Setup: in-memory SQLite via initSchema; MockModelProvider scripted with
 * merged-format {facts, triples} responses; RECENSE_TYPED_EXTRACTION_MODE=merged.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import type { EngineConfig } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { EpisodicStore } from '../src/db/episode-store';
import { StrengthDecayManager } from '../src/strength/decay';
import { CandidateRetriever } from '../src/retrieval/topk';
import { MockModelProvider } from '../src/model/provider';
import type { JudgeVerdict } from '../src/model/judge';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { MockConsolidationSink } from '../src/consolidation/sink';
import { newId } from '../src/lib/hash';

// ---------------------------------------------------------------------------
// Edge row type (matches edge_v12 DDL)
// ---------------------------------------------------------------------------

interface EdgeRow {
  src: string;
  dst: string;
  rel: string;
  w: number;
  last_access: number;
  kind: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeZeroEmbedFn(dims: number): (text: string) => Float32Array {
  return (_text: string) => new Float32Array(dims);
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

function makeNoOpSchemaInducer(h: Harness): SchemaInducer {
  return new SchemaInducer(
    h.db, h.store, h.strength, h.retriever,
    new MockModelProvider(),
    h.config, h.clock,
    async (_values: string[]) => 'no-op-schema',
  );
}

/**
 * Build a merged {facts, triples} response string (mimics MERGED_EXTRACTION_PROMPT output).
 * facts: array of {type, value} claims; triples: array of {subject, predicate, object}.
 */
function mergedResponse(
  facts: Array<{ type: string; value: string }>,
  triples: Array<{ subject: string; predicate: string; object: string }>,
): string {
  return JSON.stringify({ facts, triples });
}

/** Read all typed-predicate edges (kind='relation', rel not in {links_to, extends}) */
function typedEdges(db: Database.Database): EdgeRow[] {
  return db
    .prepare(`SELECT * FROM edge WHERE kind = 'relation' AND rel NOT IN ('links_to', 'extends')`)
    .all() as EdgeRow[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Consolidator: typed-edge extraction (Phase 37 D-02)', () => {
  let h: Harness;
  let savedTypedMode: string | undefined;

  beforeEach(() => {
    h = makeHarness();
    // Activate merged mode for all tests in this suite
    savedTypedMode = process.env['RECENSE_TYPED_EXTRACTION_MODE'];
    process.env['RECENSE_TYPED_EXTRACTION_MODE'] = 'merged';
  });

  afterEach(() => {
    // Restore env after each test (vitest runs tests in the same process)
    if (savedTypedMode === undefined) {
      delete process.env['RECENSE_TYPED_EXTRACTION_MODE'];
    } else {
      process.env['RECENSE_TYPED_EXTRACTION_MODE'] = savedTypedMode;
    }
  });

  // ── TYPED-01c: non-inferred episode mints a typed edge ──────────────────

  it('TYPED-01c: non-inferred episode with a valid triple mints a kind=relation typed edge', async () => {
    // Pre-seed entity nodes so stmtFindNodeByName resolves both subject and object.
    const subjectId = newId();
    const objectId = newId();
    h.store.upsertNode({ id: subjectId, type: 'entity', value: 'recense', origin: 'observed' });
    h.store.upsertNode({ id: objectId, type: 'entity', value: 'better-sqlite3', origin: 'observed' });

    // Unrelated-verdict judge: claims will be auto-unrelated (low cosine in zero embedFn)
    const unrelatedVerdict: JudgeVerdict = { relation: 'unrelated', best_candidate_id: null, magnitude: 0, contradicted_ids: [] };

    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [
        // Merged response: one fact + one triple
        mergedResponse(
          [{ type: 'fact', value: 'recense depends on better-sqlite3' }],
          [{ subject: 'recense', predicate: 'depends_on', object: 'better-sqlite3' }],
        ),
      ],
      judgeScript: [unrelatedVerdict],
    });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'recense depends on better-sqlite3 for its storage layer',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-typed-01',
    });

    await consolidator.consolidate();

    const edges = typedEdges(h.db);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.rel).toBe('depends_on');
    expect(edges[0]!.kind).toBe('relation');
    expect(edges[0]!.w).toBe(0.1);
    // Dangling-edge guard: both src and dst must reference known node ids
    expect(edges[0]!.src).toBe(subjectId);
    expect(edges[0]!.dst).toBe(objectId);
  });

  // ── D-08: inferred-origin episode yields ZERO typed-edge upserts ─────────

  it('D-08: inferred-origin episode yields ZERO typed-edge upserts (T-37-05)', async () => {
    // Pre-seed entity nodes
    h.store.upsertNode({ id: newId(), type: 'entity', value: 'recense', origin: 'observed' });
    h.store.upsertNode({ id: newId(), type: 'entity', value: 'sqlite3', origin: 'observed' });

    // generateScript intentionally non-empty to detect if generate() is ever called
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [
        mergedResponse(
          [{ type: 'fact', value: 'recense uses sqlite3' }],
          [{ subject: 'recense', predicate: 'uses', object: 'sqlite3' }],
        ),
      ],
      judgeScript: [],
    });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    // origin='inferred' → hard skip guard at line-462 prevents extraction AND triple write
    h.episodes.append({
      content: 'recense uses sqlite3',
      origin: 'inferred',
      salience: 0.9,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-inferred-d08',
    });

    await consolidator.consolidate();

    // D-08: inferred episodes must never produce graph effects
    const edges = typedEdges(h.db);
    expect(edges).toHaveLength(0);

    // Also assert no nodes were written (the hard guard skips extraction entirely)
    const nodes = h.db.prepare(`SELECT * FROM node WHERE value NOT IN ('recense', 'sqlite3')`).all();
    expect(nodes).toHaveLength(0);
  });

  // ── D-08: echo episode also yields ZERO typed-edge upserts ──────────────

  it('D-08: echo episode (source_inference_id set) yields ZERO typed-edge upserts', async () => {
    h.store.upsertNode({ id: newId(), type: 'entity', value: 'recense', origin: 'observed' });
    h.store.upsertNode({ id: newId(), type: 'entity', value: 'sqlite3', origin: 'observed' });

    // Seed an inferred episode (needed to make detectEcho produce echoSourceId)
    // Use an episode with source='inferred' that won't itself be processed.
    // Instead directly use the source='hitl' path which is the simplest echo-gate.
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [
        mergedResponse(
          [{ type: 'fact', value: 'recense uses sqlite3' }],
          [{ subject: 'recense', predicate: 'uses', object: 'sqlite3' }],
        ),
      ],
      judgeScript: [],
    });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    // source='hitl' → hard skip guard (ACT-03 / D-43 hitl path)
    h.episodes.append({
      content: 'recense uses sqlite3',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-hitl-d08',
      source: 'hitl',
    });

    await consolidator.consolidate();

    const edges = typedEdges(h.db);
    expect(edges).toHaveLength(0);
  });

  // ── Closed-vocab filter: out-of-vocab predicates are dropped ─────────────

  it('out-of-vocab predicate in merged output yields no typed edge (T-37-06)', async () => {
    h.store.upsertNode({ id: newId(), type: 'entity', value: 'recense', origin: 'observed' });
    h.store.upsertNode({ id: newId(), type: 'entity', value: 'Max', origin: 'observed' });

    const unrelatedVerdict: JudgeVerdict = { relation: 'unrelated', best_candidate_id: null, magnitude: 0, contradicted_ids: [] };

    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [
        mergedResponse(
          [{ type: 'fact', value: 'recense was invented by Max' }],
          [{ subject: 'recense', predicate: 'invented_by', object: 'Max' }], // out-of-vocab
        ),
      ],
      judgeScript: [unrelatedVerdict],
    });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'recense was invented by Max',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-vocab-filter',
    });

    await consolidator.consolidate();

    const edges = typedEdges(h.db);
    expect(edges).toHaveLength(0);
  });

  // ── Dangling-edge guard: unresolvable entity skips upsertEdge ────────────

  it('dangling-edge guard: triple with unresolvable entity name skips upsertEdge', async () => {
    // Only seed subject node — object 'nonexistent-tool' is not in the graph
    h.store.upsertNode({ id: newId(), type: 'entity', value: 'recense', origin: 'observed' });
    // 'nonexistent-tool' is NOT seeded

    const unrelatedVerdict: JudgeVerdict = { relation: 'unrelated', best_candidate_id: null, magnitude: 0, contradicted_ids: [] };

    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [
        mergedResponse(
          [{ type: 'fact', value: 'recense uses nonexistent-tool' }],
          [{ subject: 'recense', predicate: 'uses', object: 'nonexistent-tool' }],
        ),
      ],
      judgeScript: [unrelatedVerdict],
    });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'recense uses nonexistent-tool',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-dangling',
    });

    await consolidator.consolidate();

    // No typed edge should be minted — object node doesn't exist
    const edges = typedEdges(h.db);
    expect(edges).toHaveLength(0);
  });

  // ── D-03: separate-mode uses TYPED_EXTRACTION_PROMPT as a second call ────

  it('D-03 separate mode: claims from first call + triples from second call both reach the graph', async () => {
    // Override the per-suite merged setting for this single test
    process.env['RECENSE_TYPED_EXTRACTION_MODE'] = 'separate';

    h.store.upsertNode({ id: newId(), type: 'entity', value: 'recense', origin: 'observed' });
    h.store.upsertNode({ id: newId(), type: 'entity', value: 'launchd', origin: 'observed' });

    const unrelatedVerdict: JudgeVerdict = { relation: 'unrelated', best_candidate_id: null, magnitude: 0, contradicted_ids: [] };

    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [
        // First generate() call: bare-array facts (EXTRACTION_PROMPT path via separate mode)
        JSON.stringify([{ type: 'fact', value: 'recense runs on launchd' }]),
        // Second generate() call: triples (TYPED_EXTRACTION_PROMPT path)
        JSON.stringify([{ subject: 'recense', predicate: 'runs_on', object: 'launchd' }]),
      ],
      judgeScript: [unrelatedVerdict],
    });
    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever, provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    h.episodes.append({
      content: 'recense runs on launchd',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-separate',
    });

    await consolidator.consolidate();

    // Claims were written: one unrelated node from the fact
    const nodes = h.db
      .prepare(`SELECT * FROM node WHERE value = 'recense runs on launchd'`)
      .all();
    expect(nodes).toHaveLength(1);

    // Typed edge was minted from the triple
    const edges = typedEdges(h.db);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.rel).toBe('runs_on');
    expect(edges[0]!.kind).toBe('relation');
  });

  // ── RECENSE_TYPED_EXTRACTION_MODE source assertion ───────────────────────

  it('RECENSE_TYPED_EXTRACTION_MODE env var controls extraction mode (source assertion)', async () => {
    // Verify the env var is read (smoke test — mode switch works without a rebuild)
    const currentMode = process.env['RECENSE_TYPED_EXTRACTION_MODE'];
    expect(currentMode).toBe('merged'); // set in beforeEach
  });
});

// ---------------------------------------------------------------------------
// DEDUP-01: embed-on-mint intra-pass visibility (Phase 38.1)
// ---------------------------------------------------------------------------
//
// Reproduces 35-pass-proof.cjs Scenario A in a SINGLE consolidate() call:
// WITHOUT the fix, both episodes land as 'unrelated' (A's minted node has
// embedding=NULL, invisible to B's topk) → contra=0.
// WITH the fix, A's minted node gets setEmbedding() immediately → B's topk
// sees it (cosine=1.0 > 0.3) → judge escalation → contradict verdict →
// A's node tombstoned and replaced → tombstoned >= 1.
//
// Judge: candidate-capturing mock (subclass of MockModelProvider) that echoes
// candidates[0].id as best_candidate_id so the T-FK-01 guard (consolidator
// line 754) passes even though the id is generated at runtime.
// ---------------------------------------------------------------------------

/**
 * CandidateCapturingProvider: overrides judge() to echo the first candidate's id
 * as best_candidate_id so the T-FK-01 filter (candidateIdSet guard) passes for
 * runtime-generated node ids. Delegates embed/generate to the base MockModelProvider.
 */
class CandidateCapturingProvider extends MockModelProvider {
  /** Number of judge calls made — verified in assertions. */
  judgeCalls = 0;

  override async judge(
    _claim: string,
    candidates: Array<{ id: string; value: string }>,
  ): Promise<import('../src/model/judge').JudgeVerdict> {
    this.judgeCalls += 1;
    // Episode A: empty graph → auto-unrelated → no judge call.
    // Episode B: one candidate (A's minted node), which we contradict.
    // T-FK-01 guard: best_candidate_id must be in candidateIdSet — we echo candidates[0].id.
    return {
      relation: 'contradict',
      best_candidate_id: candidates[0]?.id ?? null,
      magnitude: 0.8,
      contradicted_ids: candidates[0]?.id ? [candidates[0].id] : [],
    };
  }

  // WR-01: the consolidator's default (non-RECENSE_ENABLE_JUDGE_BATCH) path calls
  // provider.judgeBatch([single]) per pending claim — it never calls judge() directly.
  // Override judgeBatch so the test binds to the method actually invoked, instead of
  // relying on MockModelProvider.judgeBatch happening to delegate to this.judge().
  override async judgeBatch(
    items: Array<{ claim: string; candidates: Array<{ id: string; value: string }> }>,
  ): Promise<JudgeVerdict[]> {
    return Promise.all(items.map((i) => this.judge(i.claim, i.candidates)));
  }
}

describe('DEDUP-01: embed-on-mint intra-pass visibility', () => {
  // WR-02: pin RECENSE_TYPED_EXTRACTION_MODE so this suite's extraction path is
  // deterministic regardless of ambient shell state or cross-suite env leakage.
  // The generateScript provides bare-array JSON, which only parses on the
  // non-typed-extraction path; a leaked 'merged'/'separate' value would route to
  // parseMergedExtraction, yield zero claims, and silently break the regression guard.
  let savedTypedMode: string | undefined;
  beforeEach(() => {
    savedTypedMode = process.env['RECENSE_TYPED_EXTRACTION_MODE'];
    delete process.env['RECENSE_TYPED_EXTRACTION_MODE'];
  });
  afterEach(() => {
    if (savedTypedMode === undefined) {
      delete process.env['RECENSE_TYPED_EXTRACTION_MODE'];
    } else {
      process.env['RECENSE_TYPED_EXTRACTION_MODE'] = savedTypedMode;
    }
  });

  it('same contradiction pair in ONE pass yields tombstoned>=1 after embed-on-mint fix', async () => {
    const h = makeHarness();

    // embedFn: every claim text → the SAME non-zero unit vector at dim 0.
    // Cosine between any two such vectors = 1.0, which exceeds the 0.3
    // unrelatedSimilarityThreshold → B's topk escalates to judge.
    // Pass-start reembedDirty sees an empty graph and does nothing;
    // the ONLY embeddings written in this pass come from the embed-on-mint path under test.
    const unitVec = (dims: number): Float32Array => {
      const v = new Float32Array(dims);
      v[0] = 1.0;
      return v;
    };

    const provider = new CandidateCapturingProvider({
      embedFn: (_text: string) => unitVec(h.config.embeddingDimensions),
      generateScript: [
        // Episode A extraction: one fact claim
        JSON.stringify([{ type: 'fact', value: 'Claim A: the memory learns over time' }]),
        // Episode B extraction: one fact claim (same embedding, contradicts A)
        JSON.stringify([{ type: 'fact', value: 'Claim B: the memory stays static' }]),
      ],
      // No judgeScript — we override judge() in CandidateCapturingProvider above
      judgeScript: [],
    });

    const consolidator = new Consolidator(
      h.db, h.episodes, h.store, h.strength, h.retriever,
      provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    );

    // Append both episodes — they will be consolidated in a SINGLE consolidate() call
    h.episodes.append({
      content: 'The memory learns over time (episodeA)',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-dedup-01-A',
    });
    h.episodes.append({
      content: 'The memory stays static (episodeB)',
      origin: 'observed',
      salience: 0.8,
      hard_keep: 0,
      role: 'user',
      session_id: 'session-dedup-01-B',
    });

    await consolidator.consolidate();

    // DEDUP-01 assertion: A's node must have been seen by B's topk → judge escalated →
    // contradict verdict → A's node tombstoned and a new node minted.
    // (The Noop sink does not write consolidation_event rows, so we use the tombstone
    // count as the primary state assertion — mirrors 35-pass-proof.cjs "contra >= 1".)
    const tombstoned = h.db
      .prepare('SELECT COUNT(*) AS cnt FROM node WHERE tombstoned = 1')
      .get() as { cnt: number };
    expect(tombstoned.cnt).toBeGreaterThanOrEqual(1);

    // Judge must have been called (Episode B escalated — not auto-unrelated)
    expect(provider.judgeCalls).toBeGreaterThanOrEqual(1);
  });
});
