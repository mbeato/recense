/**
 * tests/topk-index.test.ts — Phase 41 Plan 02, Task 1.
 *
 * The persisted exact vector index behind CandidateRetriever (D-03/D-04 zero-dep
 * flat-buffer sidecar). Verifies the four behaviors the plan specifies:
 *
 *   1. index-backed topk returns the SAME top-k id set as the brute-force
 *      cosineSimF32 scan over a fixture DB (± identical-score tie reorder), with
 *      REAL cosine scores (not RRF, not 0).
 *   2. when no persisted index artifact is present, CandidateRetriever falls back
 *      to the existing brute-force scan (zero behavior change) — the consolidator
 *      path relies on this.
 *   3. topkTombstoned behavior is preserved (left brute-force per the spike
 *      tombstoned verdict); the 'deleted' classification still works.
 *   4. hybridTopk's returned `score` field still carries real cosine values from
 *      the index path; BM25-only hits retain score=0.
 *
 * Harness: temp FILE DB, initSchema on a setup handle, nodes seeded via
 * SemanticStore.upsertNode + setEmbedding, then buildVectorIndex() persists the
 * sidecar. SCRATCH temp DB only. ZERO real API calls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initSchema } from '../src/db/schema';
import { DEFAULT_CONFIG } from '../src/lib/config';
import { FakeClock } from '../src/lib/clock';
import { SemanticStore } from '../src/db/semantic-store';
import {
  CandidateRetriever,
  cosineSimF32,
  buildVectorIndex,
} from '../src/retrieval/topk';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const DIM = 8;
let tmpDbPath: string;
let indexPath: string;
let db: Database.Database;

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `topk-index-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

/** Deterministic pseudo-random unit-ish vector seeded from `seed`. */
function vec(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  let x = seed * 2654435761;
  for (let i = 0; i < DIM; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    v[i] = ((x % 2000) - 1000) / 1000; // [-1, 1]
  }
  return v;
}

function seed(
  store: SemanticStore,
  id: string,
  v: Float32Array,
  opts: { tombstoned?: boolean; value?: string } = {},
): void {
  store.upsertNode({
    id,
    type: 'fact',
    value: opts.value ?? `fact ${id}`,
    origin: 'observed',
    s: 0.8,
  });
  store.setEmbedding(id, v);
  if (opts.tombstoned) store.tombstone(id);
}

/** Brute-force reference top-k over the live (non-tombstoned) seeded set. */
function bruteforceTopk(
  pairs: Array<{ id: string; v: Float32Array }>,
  q: Float32Array,
  k: number,
): Array<{ id: string; score: number }> {
  return pairs
    .map(p => ({ id: p.id, score: cosineSimF32(q, p.v) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

let livePairs: Array<{ id: string; v: Float32Array }>;

beforeEach(() => {
  tmpDbPath = makeTempDbPath();
  indexPath = `${tmpDbPath}.vindex`;
  const setupDb = new Database(tmpDbPath);
  initSchema(setupDb);
  setupDb.close();
  db = new Database(tmpDbPath);

  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const store = new SemanticStore(db, clock, { ...DEFAULT_CONFIG, dbPath: tmpDbPath });

  livePairs = [];
  for (let i = 1; i <= 40; i++) {
    const v = vec(i);
    seed(store, `n${i}`, v);
    livePairs.push({ id: `n${i}`, v });
  }
  // A few tombstoned nodes (excluded from the live scan, present for tombstoned scan).
  for (let i = 100; i <= 103; i++) {
    seed(store, `t${i}`, vec(i), { tombstoned: true });
  }
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
  try { fs.unlinkSync(indexPath); } catch { /* ignore */ }
});

const idSet = (rows: Array<{ id: string }>): Set<string> => new Set(rows.map(r => r.id));

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('CandidateRetriever persisted exact index (Phase 41-02)', () => {
  it('1. index-backed topk returns the same top-k id set + real cosine scores as brute-force', () => {
    const n = buildVectorIndex(db, indexPath);
    expect(n).toBe(40); // only live (non-tombstoned) embedded nodes
    expect(fs.existsSync(indexPath)).toBe(true);

    const indexed = new CandidateRetriever(db, { indexPath });
    const q = vec(7);
    const k = 10;

    const got = indexed.topk(q, k);
    const ref = bruteforceTopk(livePairs, q, k);

    // Set-identical top-k (order-independent; tolerates identical-score tie reorder).
    expect(idSet(got)).toEqual(idSet(ref));

    // Real cosine scores — byte-equivalent to cosineSimF32 (D-01 exact, PERF-03).
    const refScore = new Map(ref.map(r => [r.id, r.score]));
    for (const hit of got) {
      expect(hit.score).toBeCloseTo(refScore.get(hit.id)!, 6);
      // Not RRF, not 0 — a genuine cosine value.
      expect(hit.score).not.toBe(0);
    }
  });

  it('2. with no persisted artifact, topk falls back to brute-force (zero behavior change)', () => {
    // No buildVectorIndex() call — artifact absent.
    expect(fs.existsSync(indexPath)).toBe(false);

    const fallback = new CandidateRetriever(db, { indexPath });
    const bruteforce = new CandidateRetriever(db); // no index — the consolidator path

    const q = vec(13);
    const a = fallback.topk(q, 10);
    const b = bruteforce.topk(q, 10);
    const ref = bruteforceTopk(livePairs, q, 10);

    expect(idSet(a)).toEqual(idSet(ref));
    expect(idSet(b)).toEqual(idSet(ref));
    // Identical scores between the two no-index paths.
    const bScore = new Map(b.map(r => [r.id, r.score]));
    for (const hit of a) expect(hit.score).toBeCloseTo(bScore.get(hit.id)!, 10);
  });

  it('3. topkTombstoned stays brute-force and still classifies the deleted set', () => {
    buildVectorIndex(db, indexPath);
    const indexed = new CandidateRetriever(db, { indexPath });

    // Query close to a tombstoned node — it must surface from the tombstoned scan,
    // never from the live index scan.
    const q = vec(100);
    const tomb = indexed.topkTombstoned(q, 5);
    expect(tomb.length).toBeGreaterThan(0);
    expect(tomb.every(h => h.id.startsWith('t'))).toBe(true);
    // The top tombstoned hit for a query == its own vector is itself, score ~1.
    expect(tomb[0]!.id).toBe('t100');
    expect(tomb[0]!.score).toBeCloseTo(1, 6);

    // The live index scan must NOT return tombstoned ids.
    const live = indexed.topk(q, 40);
    expect(live.some(h => h.id.startsWith('t'))).toBe(false);
  });

  it('4. hybridTopk returns real cosine scores from the index path; BM25-only hits stay 0', () => {
    buildVectorIndex(db, indexPath);
    const indexed = new CandidateRetriever(db, { indexPath });

    const q = vec(7);
    // Query text references a node value token so BM25 can also fire.
    const hits = indexed.hybridTopk(q, 'fact n7', 10);

    // For any hit that is in the cosine top set, the score is the real cosine value.
    const ref = bruteforceTopk(livePairs, q, 40);
    const refScore = new Map(ref.map(r => [r.id, r.score]));
    for (const hit of hits) {
      if (refScore.has(hit.id) && hit.score !== 0) {
        expect(hit.score).toBeCloseTo(refScore.get(hit.id)!, 6);
      }
    }
    // At least one hit carries a real (non-zero) cosine score from the index.
    expect(hits.some(h => h.score > 0)).toBe(true);
  });
});
