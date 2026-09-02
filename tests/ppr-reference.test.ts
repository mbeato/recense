import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { eligibleWeight, loadAdjacency, pprExact, rankFromScores } from '../src/eval/ppr-reference';

const cfg = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

describe('eligibleWeight', () => {
  it('follows the spec table with kind fallback', () => {
    expect(eligibleWeight('relation', 'depends_on', 'fwd')).toBe(1.0);
    expect(eligibleWeight('relation', 'depends_on', 'rev')).toBe(0.8);
    expect(eligibleWeight('relation', 'extends', 'fwd')).toBe(0.7);
    expect(eligibleWeight('abstracts', 'abstracts', 'rev')).toBe(0.8);
    expect(eligibleWeight('doc_containment', 'doc_containment', 'fwd')).toBe(0);
  });
});

describe('pprExact', () => {
  let db: Database.Database;
  let store: SemanticStore;
  const node = (id: string, type: 'fact' | 'entity' | 'schema' = 'fact') =>
    store.upsertNode({ id, type, value: `value of ${id}`, origin: 'observed' });
  const edge = (src: string, dst: string, rel = 'depends_on', kind: 'relation' | 'abstracts' = 'relation') =>
    store.upsertEdge({ src, dst, rel, w: 0.1, kind });

  beforeEach(() => {
    db = new Database(':memory:');
    initSchema(db);
    store = new SemanticStore(db, new FakeClock(Date.UTC(2026, 0, 1)), cfg);
  });
  afterEach(() => db.close());

  it('reaches a 2-hop terminal and conserves total mass', () => {
    node('A'); node('B'); node('C'); node('Z');
    edge('A', 'B'); edge('B', 'C');
    const adj = loadAdjacency(db);
    const scores = pprExact(adj, new Map([['A', 1]]));
    const sum = Array.from(scores).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(scores[adj.index.get('C')!]).toBeGreaterThan(0);
    expect(scores[adj.index.get('Z')!]).toBe(0);
    expect(rankFromScores(adj, scores, new Set(['A']), 10)).toEqual(['B', 'C']);
  });

  it('row-normalizes so a hub does not out-emit a quiet node', () => {
    node('S'); node('H'); node('Q'); node('Qn');
    for (let i = 0; i < 50; i++) { node(`Hn${i}`); edge('H', `Hn${i}`); }
    edge('S', 'H'); edge('S', 'Q'); edge('Q', 'Qn');
    const adj = loadAdjacency(db);
    const scores = pprExact(adj, new Map([['S', 1]]));
    expect(scores[adj.index.get('Qn')!]).toBeGreaterThan(scores[adj.index.get('Hn0')!]! * 10);
  });

  it('traverses abstracts in reverse to reach sibling facts under a schema', () => {
    node('F1'); node('F2'); node('SCH', 'schema');
    edge('F1', 'SCH', 'abstracts', 'abstracts'); edge('F2', 'SCH', 'abstracts', 'abstracts');
    const adj = loadAdjacency(db);
    const scores = pprExact(adj, new Map([['F1', 1]]));
    expect(scores[adj.index.get('F2')!]).toBeGreaterThan(0);
  });

  it('ignores tombstoned nodes', () => {
    node('A'); node('B'); node('C');
    edge('A', 'B'); edge('B', 'C');
    store.tombstone('B');
    const adj = loadAdjacency(db);
    expect(adj.index.has('B')).toBe(false);
    const scores = pprExact(adj, new Map([['A', 1]]));
    expect(scores[adj.index.get('C')!]).toBe(0);
  });

  it('is deterministic', () => {
    node('A'); node('B'); node('C');
    edge('A', 'B'); edge('A', 'C');
    const adj = loadAdjacency(db);
    const a = Array.from(pprExact(adj, new Map([['A', 1]])));
    const b = Array.from(pprExact(adj, new Map([['A', 1]])));
    expect(a).toEqual(b);
  });
});
