/**
 * Spec §5 "Exact-PPR oracle test": with generous budgets, truncated spread's top-k must
 * closely match exact PPR on the same graph and weights. Divergence flags over-truncation
 * or a weighting bug in either implementation.
 */
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { initSchema } from '../src/db/schema';
import { SemanticStore } from '../src/db/semantic-store';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { loadAdjacency, pprExact, rankFromScores } from '../src/eval/ppr-reference';
import { spreadActivation, spreadParamsFromConfig } from '../src/retrieval/activation';
import { SqliteSpreadReader } from '../src/retrieval/spread-reader';

/** Deterministic LCG so the random graph is stable across runs. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function buildRandomGraph(nodes: number, edges: number, seed: number) {
  const db = new Database(':memory:');
  initSchema(db);
  const store = new SemanticStore(db, new FakeClock(Date.UTC(2026, 0, 1)), { ...DEFAULT_CONFIG, dbPath: ':memory:' });
  const rnd = lcg(seed);
  const rels = ['depends_on', 'uses', 'extends', 'part_of'];
  for (let i = 0; i < nodes; i++) store.upsertNode({ id: `n${i}`, type: 'fact', value: `node ${i}`, origin: 'observed' });
  const seen = new Set<string>();
  let added = 0;
  while (added < edges) {
    const a = Math.floor(rnd() * nodes); const b = Math.floor(rnd() * nodes);
    if (a === b) continue;
    const rel = rels[Math.floor(rnd() * rels.length)]!;
    const key = `${a}|${b}|${rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    store.upsertEdge({ src: `n${a}`, dst: `n${b}`, rel, w: 0.1, kind: 'relation' });
    added++;
  }
  return db;
}

function overlapAt(a: string[], b: string[], k: number): number {
  const sa = new Set(a.slice(0, k));
  let hit = 0;
  for (const id of b.slice(0, k)) if (sa.has(id)) hit++;
  return hit / k;
}

describe('spread vs exact PPR', () => {
  it('top-10 overlap ≥ 0.7 on random graphs with generous spread budgets', () => {
    const cfg = { ...DEFAULT_CONFIG, dbPath: ':memory:' };
    for (const seed of [7, 42, 1337]) {
      const db = buildRandomGraph(200, 500, seed);
      const adj = loadAdjacency(db);
      const seedId = adj.ids[0]!;
      const exact = rankFromScores(adj, pprExact(adj, new Map([[seedId, 1]])), new Set([seedId]), 10);
      const spread = spreadActivation(
        new SqliteSpreadReader(db),
        new Map([[seedId, 1]]),
        { ...spreadParamsFromConfig(cfg as never, 6), activationFloor: 1e-7, frontierCap: 100_000 },
      );
      const ranked = Array.from(spread.entries())
        .sort((a, b) => (b[1].activation - a[1].activation) || (a[0] < b[0] ? -1 : 1))
        .map(e => e[0]);
      expect(exact.length).toBeGreaterThan(0);
      expect(overlapAt(exact, ranked, Math.min(10, exact.length))).toBeGreaterThanOrEqual(0.7);
      db.close();
    }
  });
});
