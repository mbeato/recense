import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { CandidateRetriever } from '../src/retrieval/topk';
import { StrengthDecayManager } from '../src/strength/decay';
import { AllocationGate } from '../src/gate/allocation-gate';
import { RetrievalEngine } from '../src/retrieval/engine';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { ARMS, resolveSeeds, readEmbedding, edgeExistence, type ArmContext } from '../src/eval/bridge-arms';
import { loadAdjacency } from '../src/eval/ppr-reference';
import type { BridgeProbe } from '../src/eval/bridge-probes';

const cfg = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

function basis(i: number): Float32Array { const v = new Float32Array(16); v[i] = 1; return v; }

describe('bridge arms', () => {
  let db: Database.Database;
  let store: SemanticStore;
  let ctx: ArmContext;
  let probe: BridgeProbe;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    store = new SemanticStore(db, clock, cfg);
    const add = (id: string, value: string, vec: Float32Array, type: 'fact' | 'entity' = 'fact') => {
      store.upsertNode({ id, type, value, origin: 'observed', s: 0.5 });
      store.setEmbedding(id, vec);
    };
    add('seed', 'urby-www deploys to Cloudflare Pages', basis(0));
    add('bridge', 'Cloudflare', basis(1), 'entity');
    add('term', 'the dashboard custom domain attachment is locked', basis(2));
    add('noise', 'unrelated weekend plans', basis(3));
    store.upsertEdge({ src: 'seed', dst: 'bridge', rel: 'runs_on', w: 0.1, kind: 'relation' });
    store.upsertEdge({ src: 'bridge', dst: 'term', rel: 'extends', w: 0.1, kind: 'relation' });

    const retriever = new CandidateRetriever(db);
    const engine = new RetrievalEngine(db, clock, cfg, retriever, store, new StrengthDecayManager(db, clock, cfg), new AllocationGate(cfg));
    ctx = { db, store, retriever, engine, adjacency: loadAdjacency(db), k: 10, floor: 0.3, e2eSeedK: 3 };
    probe = {
      id: 'bp001', query: 'urby-www deploys to Cloudflare Pages',
      seed: { id: 'seed', type: 'fact', value: 'urby-www deploys to Cloudflare Pages' },
      bridge: { id: 'bridge', type: 'entity', value: 'Cloudflare' },
      terminal: { id: 'term', type: 'fact', value: 'the dashboard custom domain attachment is locked' },
      path: [
        { src: 'seed', rel: 'runs_on', kind: 'relation', dir: 'fwd', dst: 'bridge' },
        { src: 'bridge', rel: 'extends', kind: 'relation', dir: 'fwd', dst: 'term' },
      ],
      seed_outdeg: 1, dilution: 'lo', stratum: 'entity:lo', cosine_seed_terminal: 0,
    };
  });
  afterEach(() => db.close());

  it('reads a stored embedding back as Float32Array', () => {
    expect(Array.from(readEmbedding(db, 'seed')!)).toEqual(Array.from(basis(0)));
    expect(readEmbedding(db, 'nope')).toBeNull();
  });

  it('hybrid (graph-off baseline) does not reach the orthogonal terminal; ppr-exact does', () => {
    const input = { probe, queryVec: basis(0), mode: 'oracle' as const };
    const hybrid = ARMS.find(a => a.name === 'hybrid')!.run(input, ctx)!;
    const ppr = ARMS.find(a => a.name === 'ppr-exact')!.run(input, ctx)!;
    expect(hybrid.rankedIds).not.toContain('term');
    expect(ppr.rankedIds).toContain('term');
    expect(ppr.rankedIds).not.toContain('seed');
    expect(ppr.nodesExpanded).toBeGreaterThan(0);
  });

  it('typed arm walks the gold predicate path only when both hops are forward typed predicates', () => {
    const typed = ARMS.find(a => a.name === 'typed')!;
    expect(typed.run({ probe, queryVec: basis(0), mode: 'oracle' }, ctx)).toBeNull();
    store.upsertEdge({ src: 'bridge', dst: 'term', rel: 'uses', w: 0.1, kind: 'relation' });
    const typedProbe = { ...probe, path: [probe.path[0], { ...probe.path[1], rel: 'uses' }] as BridgeProbe['path'] };
    expect(typed.run({ probe: typedProbe, queryVec: basis(0), mode: 'oracle' }, ctx)!.rankedIds).toContain('term');
  });

  it('resolveSeeds: oracle returns the gold seed; e2e returns hybrid hits', () => {
    expect(Array.from(resolveSeeds({ probe, queryVec: basis(0), mode: 'oracle' }, ctx).keys())).toEqual(['seed']);
    const e2e = resolveSeeds({ probe, queryVec: basis(0), mode: 'e2e' }, ctx);
    expect(e2e.has('seed')).toBe(true);
    for (const m of e2e.values()) expect(m).toBeGreaterThan(0);
  });

  it('edgeExistence checks real edge rows', () => {
    const ex = edgeExistence(db);
    expect(ex.has('seed', 'runs_on', 'bridge')).toBe(true);
    expect(ex.has('seed', 'runs_on', 'term')).toBe(false);
  });
});
