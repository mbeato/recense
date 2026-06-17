/**
 * Tests for SCOPE-01 consolidation scope-stamping path (Plan 999.3-01, D-S3).
 *
 * stampNodeScopes (run-sleep-pass.ts) runs AFTER consolidate(): for each node touched
 * this pass it derives a provenance scope from the cwd of its contributing episode(s)
 * via the consolidation_event → episode join, and upserts node_scope.
 *
 * Verifies:
 *  - A node built from a single VTX-cwd episode → scope 'vtx'.
 *  - A node built from an empty-cwd episode → scope 'global'.
 *  - A node contributed to by episodes spanning two projects → scope 'global' (D-S3).
 *  - The stamp is purely additive + best-effort: belief consolidation is unchanged, and a
 *    pass that touched nothing writes no node_scope rows.
 *
 * Uses MockModelProvider (scripted claims, no API) + in-memory SQLite + a real
 * SQLiteConsolidationSink so consolidation_event rows exist for the provenance join.
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
import { MockModelProvider } from '../src/model/provider';
import type { ModelProvider } from '../src/model/provider';
import { Consolidator } from '../src/consolidation/consolidator';
import { SchemaInducer } from '../src/consolidation/schema-induction';
import { EventStore } from '../src/db/event-store';
import { SQLiteConsolidationSink } from '../src/consolidation/sink';
import { stampNodeScopes } from '../src/consolidation/run-sleep-pass';

// ---------------------------------------------------------------------------
// Embed helpers (mirrors consolidation-temporal.test.ts)
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

function makeZeroEmbedFn(dims: number): (_text: string) => Float32Array {
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

/** Consolidator with a REAL SQLiteConsolidationSink so consolidation_event rows exist. */
function makeConsolidator(h: Harness, provider: ModelProvider): Consolidator {
  const sink = new SQLiteConsolidationSink(new EventStore(h.db), h.clock);
  return new Consolidator(
    h.db, h.episodes, h.store, h.strength, h.retriever,
    provider, makeNoOpSchemaInducer(h), h.config, h.clock,
    sink,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stampNodeScopes — SCOPE-01, D-S3', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('single VTX-cwd episode → node scope "vtx"', async () => {
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [
        JSON.stringify([{ type: 'fact', value: 'VTX has roughly 60 athletes' }]),
      ],
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);

    h.episodes.append({
      content: 'VTX has roughly 60 athletes',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-vtx',
      cwd: '/Users/vtx/VTX',
    });

    const passStart = h.clock.nowMs();
    await consolidator.consolidate();
    stampNodeScopes(h.db, h.store, h.clock, passStart);

    const nodes = h.db.prepare('SELECT id FROM node').all() as { id: string }[];
    expect(nodes).toHaveLength(1);
    expect(h.store.getNodeScope(nodes[0]!.id)).toBe('vtx');
  });

  it('empty-cwd episode → node scope "global"', async () => {
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [
        JSON.stringify([{ type: 'fact', value: 'Max signs emails as max' }]),
      ],
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);

    h.episodes.append({
      content: 'Max signs emails as max',
      origin: 'observed',
      salience: 0.9,
      hard_keep: 1,
      role: 'user',
      session_id: 'sess-global',
      // cwd omitted → defaults to '' → global
    });

    const passStart = h.clock.nowMs();
    await consolidator.consolidate();
    stampNodeScopes(h.db, h.store, h.clock, passStart);

    const nodes = h.db.prepare('SELECT id FROM node').all() as { id: string }[];
    expect(nodes).toHaveLength(1);
    expect(h.store.getNodeScope(nodes[0]!.id)).toBe('global');
  });

  it('node contributed to by two projects → scope "global" (D-S3)', async () => {
    // Pre-seed a node + embedding so both episodes exact-match confirm into it (D-17).
    const value = 'Shared fact across two projects';
    const embedFn = makeSyntheticEmbedFn(h.config.embeddingDimensions);
    h.store.upsertNode({ id: 'shared-node', type: 'fact', value, origin: 'observed' });
    const [vec] = await new MockEmbedder(embedFn).embed([value]);
    h.store.setEmbedding('shared-node', vec!);

    const provider = new MockModelProvider({
      embedFn,
      generateScript: [
        JSON.stringify([{ type: 'fact', value }]), // episode 1
        JSON.stringify([{ type: 'fact', value }]), // episode 2
      ],
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);

    h.episodes.append({
      content: value, origin: 'observed', salience: 0.9, hard_keep: 1,
      role: 'user', session_id: 'sess-p1', cwd: '/Users/vtx/VTX',
    });
    h.episodes.append({
      content: value, origin: 'observed', salience: 0.9, hard_keep: 1,
      role: 'user', session_id: 'sess-p2', cwd: '/Users/vtx/putyouon',
    });

    const passStart = h.clock.nowMs();
    await consolidator.consolidate();
    stampNodeScopes(h.db, h.store, h.clock, passStart);

    // Both episodes confirmed into the one shared node (no new node minted).
    const nodeCount = (h.db.prepare('SELECT COUNT(*) AS n FROM node').get() as { n: number }).n;
    expect(nodeCount).toBe(1);
    expect(h.store.getNodeScope('shared-node')).toBe('global');
  });

  it('best-effort + additive: a pass that touched nothing writes no node_scope rows', async () => {
    // No episodes appended → consolidate() is a no-op → no consolidation_event → no scope.
    const provider = new MockModelProvider({
      embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
      generateScript: [],
      judgeScript: [],
    });
    const consolidator = makeConsolidator(h, provider);

    const passStart = h.clock.nowMs();
    await consolidator.consolidate();
    stampNodeScopes(h.db, h.store, h.clock, passStart);

    const scopeCount = (h.db.prepare('SELECT COUNT(*) AS n FROM node_scope').get() as { n: number }).n;
    expect(scopeCount).toBe(0);
  });

  it('belief consolidation is unchanged whether or not the scope stamp runs', async () => {
    // Run consolidation WITHOUT the scope stamp; capture node values.
    const value = 'Recense is the desktop product name';
    const makeProvider = () =>
      new MockModelProvider({
        embedFn: makeZeroEmbedFn(h.config.embeddingDimensions),
        generateScript: [JSON.stringify([{ type: 'fact', value }])],
        judgeScript: [],
      });

    const consolidator = makeConsolidator(h, makeProvider());
    h.episodes.append({
      content: value, origin: 'observed', salience: 0.9, hard_keep: 1,
      role: 'user', session_id: 'sess-belief', cwd: '/Users/vtx/brain-memory',
    });
    await consolidator.consolidate();

    const beforeStamp = h.db.prepare('SELECT id, value, s, c, tombstoned FROM node ORDER BY id').all();
    stampNodeScopes(h.db, h.store, h.clock, 0);
    const afterStamp = h.db.prepare('SELECT id, value, s, c, tombstoned FROM node ORDER BY id').all();

    // Node belief state is byte-identical before and after the additive scope stamp.
    expect(afterStamp).toEqual(beforeStamp);
    // And the scope was written (brain-memory cwd).
    const id = (beforeStamp[0] as { id: string }).id;
    expect(h.store.getNodeScope(id)).toBe('brain-memory');
  });
});
