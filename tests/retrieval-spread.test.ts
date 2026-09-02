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

const cfg = { ...DEFAULT_CONFIG, dbPath: ':memory:' };
function basis(i: number): Float32Array { const v = new Float32Array(16); v[i] = 1; return v; }

describe('retrieveRanked spread channel', () => {
  let db: Database.Database;
  let store: SemanticStore;
  let engine: RetrievalEngine;

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    store = new SemanticStore(db, clock, cfg);
    const add = (id: string, value: string, vec: Float32Array) => {
      store.upsertNode({ id, type: 'fact', value, origin: 'observed', s: 0.5 });
      store.setEmbedding(id, vec);
    };
    add('seed', 'urby-www deploys to Cloudflare Pages', basis(0));
    add('near', 'urby-www deploy pipeline uses wrangler', basis(0)); // cosine sibling
    add('term', 'the dashboard custom domain attachment is locked', basis(2));
    store.upsertEdge({ src: 'seed', dst: 'term', rel: 'runs_on', w: 0.1, kind: 'relation' });
    engine = new RetrievalEngine(db, clock, cfg, new CandidateRetriever(db), store, new StrengthDecayManager(db, clock, cfg), new AllocationGate(cfg));
  });
  afterEach(() => db.close());

  it('is byte-identical with spreadHops absent, 0, or feature-dark', () => {
    const base = engine.retrieveRanked(basis(0), 5, 0.3);
    expect(engine.retrieveRanked(basis(0), 5, 0.3, undefined, { spreadHops: 0 })).toEqual(base);
    expect(engine.retrieveRanked(basis(0), 5, 0.3, undefined, {})).toEqual(base);
  });

  it('surfaces a connected-but-orthogonal fact through the associative channel, slot-capped', () => {
    const base = engine.retrieveRanked(basis(0), 5, 0.3);
    expect(base.map(r => r.id)).not.toContain('term');
    const spread = engine.retrieveRanked(basis(0), 5, 0.3, undefined, { spreadHops: 2 });
    expect(spread.map(r => r.id)).toContain('term');
    const assoc = spread.filter(r => !base.some(b => b.id === r.id));
    expect(assoc.length).toBeLessThanOrEqual(cfg.spreadAssocSlotCap);
    const term = spread.find(r => r.id === 'term')!;
    expect(term.score).toBeGreaterThan(0);   // real activation, never fabricated
    expect(term.score).toBeLessThanOrEqual(1);
  });

  it('assocAdmit gates associative rows only: rejecting the id drops it, admitting keeps it, cosine rows untouched', () => {
    const rejected = engine.retrieveRanked(basis(0), 5, 0.3, undefined, { spreadHops: 2, assocAdmit: id => id !== 'term' });
    expect(rejected.map(r => r.id)).not.toContain('term');
    expect(rejected.map(r => r.id)).toEqual(engine.retrieveRanked(basis(0), 5, 0.3).map(r => r.id));
    const admitted = engine.retrieveRanked(basis(0), 5, 0.3, undefined, { spreadHops: 2, assocAdmit: () => true });
    expect(admitted.map(r => r.id)).toContain('term');
  });

  it('associative rows never bypass tombstone discipline', () => {
    store.tombstone('term');
    const spread = engine.retrieveRanked(basis(0), 5, 0.3, undefined, { spreadHops: 2 });
    expect(spread.map(r => r.id)).not.toContain('term');
  });

  it('fails open: a broken spread never breaks retrieval', () => {
    // Simulate breakage by dropping the edge table's index target — instead, monkeypatch:
    const anyEngine = engine as unknown as { spreadReader: { edgesTouching: () => never } };
    anyEngine.spreadReader.edgesTouching = () => { throw new Error('boom'); };
    const rows = engine.retrieveRanked(basis(0), 5, 0.3, undefined, { spreadHops: 2 });
    expect(rows.length).toBeGreaterThan(0);  // hybrid results still returned
  });

  it('config-driven: spreadHops from config flows through opts (ambient wiring shape)', () => {
    const hot = { ...cfg, spreadHops: 2 };
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    const e2 = new RetrievalEngine(db, clock, hot, new CandidateRetriever(db), store, new StrengthDecayManager(db, clock, hot), new AllocationGate(hot));
    const rows = e2.retrieveRanked(basis(0), 5, 0.3, undefined, { spreadHops: hot.spreadHops });
    expect(rows.map(r => r.id)).toContain('term');
  });
});
