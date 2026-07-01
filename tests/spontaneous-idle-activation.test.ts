/**
 * tests/spontaneous-idle-activation.test.ts
 *
 * Phase 56 Plan 04 — SPONT-06 regression lock (D-10): a deterministic guard proving
 *   (1) every emitted spontaneous hop `(src → dst)` is a REAL live `kind='relation'`
 *       PRED_SET out-edge of its seed in the store — cross-checked against the store,
 *       not trusted from the payload — with `score:null`, `hop:1`, and honest `src`
 *       attribution (never a guessed seeds[0]);
 *   (2) the spontaneous emit-payload construction writes no `activation_trace` row and
 *       opens no new `Database()` (D-10/D-11 — read-only/single-writer preserved).
 *
 * Determinism comes from a fixed eligible pool + an injected deterministic rng passed
 * into `pickSpontaneousSeeds` (Phase 56-02) — re-running the pipeline reproduces
 * identical picked seeds and hops.
 *
 * Static source-text guard mirrors tests/viz-ambient-liveliness.test.ts's readServer()
 * + block-slice + toContain/not.toContain style (Phase 54 precedent).
 */
import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initSchema } from '../src/db/schema';
import { FakeClock } from '../src/lib/clock';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { SemanticStore } from '../src/db/semantic-store';
import { buildHonestOneHopTrace, type HonestTraceReader } from '../src/retrieval/honest-trace';
import { pickSpontaneousSeeds } from '../src/viz/server';
import { PRED_SET } from '../src/model/typed-predicates';

const BASE_CONFIG = { ...DEFAULT_CONFIG, dbPath: ':memory:' };

// Mirrors src/viz/server.ts SPONT_HOP_TOPN (not exported; literal per plan D-10 discretion,
// same convention as AMBIENT_HOP_TOPN in tests/activation-trace-wiring.test.ts).
const SPONT_HOP_TOPN = 6;

/** Deterministic seeded LCG rng — same seed always yields the same output sequence. */
function makeSeededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/**
 * Fixture store with the exact edge shapes the honesty guard must distinguish:
 *   - seedA: 8 live PRED_SET ('uses') out-edges (r1..r8) — one MORE than SPONT_HOP_TOPN (6),
 *     to prove top-N truncation by weight; plus a structural `extends` edge (kind='relation'
 *     but NOT a PRED_SET predicate) at the highest weight of all (must still be excluded);
 *     plus a PRED_SET edge to a TOMBSTONED dst at a high weight (must be excluded — liveness
 *     checked before the slot is filled, not merely lowest-priority).
 *   - seedB / seedC: one live PRED_SET out-edge each, for sampling/attribution variety.
 */
function buildFixture() {
  const db = new Database(':memory:');
  initSchema(db);
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const store = new SemanticStore(db, clock, BASE_CONFIG);

  store.upsertNode({ id: 'seedA', type: 'fact', value: 'seed A', origin: 'observed', s: 0.8 });
  store.upsertNode({ id: 'seedB', type: 'fact', value: 'seed B', origin: 'observed', s: 0.7 });
  store.upsertNode({ id: 'seedC', type: 'fact', value: 'seed C', origin: 'observed', s: 0.6 });

  const liveWeights = [0.90, 0.85, 0.80, 0.75, 0.70, 0.65, 0.60, 0.55];
  liveWeights.forEach((w, i) => {
    const id = `r${i + 1}`;
    store.upsertNode({ id, type: 'fact', value: `relation target ${id}`, origin: 'observed', s: 0.5 });
    store.upsertEdge({ src: 'seedA', dst: id, rel: 'uses', w, kind: 'relation' });
  });

  store.upsertNode({ id: 'ext1', type: 'fact', value: 'structural target', origin: 'observed', s: 0.5 });
  store.upsertEdge({ src: 'seedA', dst: 'ext1', rel: 'extends', w: 0.99, kind: 'relation' });

  store.upsertNode({ id: 'dead1', type: 'fact', value: 'dead target', origin: 'observed', s: 0.5, tombstoned: true });
  store.upsertEdge({ src: 'seedA', dst: 'dead1', rel: 'uses', w: 0.95, kind: 'relation' });

  store.upsertNode({ id: 'b1', type: 'fact', value: 'seedB target', origin: 'observed', s: 0.5 });
  store.upsertEdge({ src: 'seedB', dst: 'b1', rel: 'depends_on', w: 0.5, kind: 'relation' });

  store.upsertNode({ id: 'c1', type: 'fact', value: 'seedC target', origin: 'observed', s: 0.5 });
  store.upsertEdge({ src: 'seedC', dst: 'c1', rel: 'part_of', w: 0.5, kind: 'relation' });

  return { db, store };
}

function readServer(): string {
  return fs.readFileSync(path.resolve(__dirname, '..', 'src/viz/server.ts'), 'utf8');
}

/** Strip JSDoc/comment-only lines before token assertions (mirrors viz-ambient-liveliness.test.ts). */
function stripComments(src: string): string {
  return src.split('\n').filter(line => !/^\s*(\*|\/\/)/.test(line)).join('\n');
}

describe('SPONT-06: spontaneous hop honesty guard (real edge cross-check)', () => {
  it('honest: every emitted hop is a real live PRED_SET out-edge of its picked seed (deterministic)', () => {
    const { db, store } = buildFixture();
    try {
      const reader: HonestTraceReader = store; // same {getOutEdgesWithRel, getNode} shape the server builds

      // Fixed eligible pool (D-10 discretion) + injected deterministic rng — every seed in the
      // pool is eligible (>=1 real PRED_SET out-edge), count === pool.length so the full pool is
      // picked (guaranteeing seedA is present to exercise top-N truncation) while the injected
      // rng still exercises pickSpontaneousSeeds' shuffle deterministically.
      const pool = ['seedA', 'seedB', 'seedC'];
      const seeds = pickSpontaneousSeeds(pool, pool.length, makeSeededRng(42));
      const { hops } = buildHonestOneHopTrace(seeds, reader, SPONT_HOP_TOPN);

      // Determinism: a fresh run with the same seed reproduces identical picked seeds and hops.
      const seedsAgain = pickSpontaneousSeeds(pool, pool.length, makeSeededRng(42));
      const { hops: hopsAgain } = buildHonestOneHopTrace(seedsAgain, reader, SPONT_HOP_TOPN);
      expect(seedsAgain.map(s => s.node_id)).toEqual(seeds.map(s => s.node_id));
      expect(hopsAgain).toEqual(hops);

      // Picked seeds are distinct.
      const seedIds = seeds.map(s => s.node_id);
      expect(new Set(seedIds).size).toBe(seedIds.length);

      expect(hops.length).toBeGreaterThan(0);

      hops.forEach(hop => {
        // Real-edge cross-check against the store — not a trust-the-payload check.
        const edge = store.getOutEdgesWithRel(hop.src).find(e => e.dst === hop.node_id);
        expect(edge).toBeDefined();
        expect(edge!.kind).toBe('relation');
        expect(PRED_SET.has(edge!.rel)).toBe(true);

        // dst is live.
        expect(store.getNode(hop.node_id)?.tombstoned).toBe(0);

        // Honest attribution: src is one of the actually-picked seeds (no guessed seeds[0]).
        expect(seedIds).toContain(hop.src);

        // Rank-only honesty: no fabricated magnitude.
        expect(hop.score).toBeNull();
        expect(hop.hop).toBe(1);
      });

      // Structural (`extends`) and tombstoned targets never appear as hops, even at the
      // highest weight of all seedA's edges.
      expect(hops.some(h => h.node_id === 'ext1')).toBe(false);
      expect(hops.some(h => h.node_id === 'dead1')).toBe(false);

      // Top-N cap: seedA has 8 live semantic edges > SPONT_HOP_TOPN (6) — truncated to 6.
      const seedAHops = hops.filter(h => h.src === 'seedA');
      expect(seedAHops.length).toBe(SPONT_HOP_TOPN);
      expect(seedAHops.map(h => h.node_id).sort()).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    } finally {
      db.close();
    }
  });
});

describe('SPONT-06: no activation_trace write / no new Database() (D-10/D-11)', () => {
  it('the spontaneous emit-payload construction (pickSpontaneousSeeds + buildHonestOneHopTrace) writes nothing', () => {
    const { db, store } = buildFixture();
    try {
      const before = db
        .prepare('SELECT COUNT(*) AS c, COALESCE(MAX(id), 0) AS m FROM activation_trace')
        .get() as { c: number; m: number };

      const reader: HonestTraceReader = store;
      const pool = ['seedA', 'seedB', 'seedC'];
      const seeds = pickSpontaneousSeeds(pool, pool.length, makeSeededRng(7));
      buildHonestOneHopTrace(seeds, reader, SPONT_HOP_TOPN);

      const after = db
        .prepare('SELECT COUNT(*) AS c, COALESCE(MAX(id), 0) AS m FROM activation_trace')
        .get() as { c: number; m: number };

      expect(after.c).toBe(before.c);
      expect(after.m).toBe(before.m);
    } finally {
      db.close();
    }
  });

  it('static: the spontaneous emitter region in server.ts opens no new Database() and writes no activation_trace row', () => {
    const src = readServer();
    const startMarker = 'eligible-seed pool for the spontaneous idle emitter';
    const endMarker = 'spontaneousInterval.unref();';
    const start = src.indexOf(startMarker);
    const end = src.indexOf(endMarker);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = stripComments(src.slice(start, end + endMarker.length));

    // No second writer-capable handle and no write statement of any kind in this region —
    // the spontaneous path reads via prepared SELECTs only (D-11 replay-ring exclusion is
    // automatic because nothing is ever written).
    expect(block).not.toContain('new Database(');
    expect(block).not.toContain('INSERT INTO activation_trace');
    expect(block).not.toContain('.run(');
    // Sanity: confirms the slice actually captured the real emitter body, not an empty match.
    expect(block).toContain('pickSpontaneousSeeds');
    expect(block).toContain('buildHonestOneHopTrace');
  });
});
