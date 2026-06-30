/**
 * tests/topk-simd.test.ts — Phase 51 Plan 03, Task 2.
 *
 * CandidateRetriever integration tests for the WASM SIMD kernel path (SCALE-03).
 *
 * Two cases:
 *
 *   Case 1 (kernel set-identity — D-07 end-to-end):
 *     DIM=8 (divisible by 4) so loadSimdKernel returns a real kernel handle.
 *     Asserts the WASM-accelerated indexed top-k is set-identical to brute-force
 *     cosineSimF32 scores (recall@10=1.000) with close-but-not-bitwise scores
 *     (toBeCloseTo(6) — sub-ULP f32x4 horizontal-sum differences are accepted per D-07).
 *
 *   Case 2 (forced kernel-unavailable — D-08 silent scalar fallback):
 *     DIM=9 (NOT divisible by 4) so loadSimdKernel returns null → topkIndexed runs the
 *     verbatim scalar dot loop. Asserts the retriever still returns a set-identical top-k
 *     to brute-force (no throw, no recall loss). This exercises the D-08 silent-fallback
 *     contract at the integration level; the loader-returns-null unit path is covered in
 *     Plan 02 (tests/simd-kernel.test.ts).
 *
 * Fixture machinery reused from tests/topk-index.test.ts:
 *   - temp file DB per test (makeTempDbPath)
 *   - deterministic unit-ish vectors (vec / seed LCG)
 *   - SemanticStore.upsertNode + setEmbedding to seed nodes
 *   - buildVectorIndex to write the sidecar
 *   - bruteforceTopk as cosineSimF32 ground-truth reference
 *   - idSet for order-independent set comparison
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
// Shared helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  return path.join(
    os.tmpdir(),
    `topk-simd-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

/**
 * Deterministic pseudo-random unit-ish vector seeded from `seed` with a given dimension.
 * Same LCG as topk-index.test.ts — directly comparable fixture vectors.
 */
function vec(seed: number, dim: number): Float32Array {
  const v = new Float32Array(dim);
  let x = seed * 2654435761;
  for (let i = 0; i < dim; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    v[i] = ((x % 2000) - 1000) / 1000; // [-1, 1]
  }
  return v;
}

function seedNode(
  store: SemanticStore,
  id: string,
  v: Float32Array,
): void {
  store.upsertNode({
    id,
    type: 'fact',
    value: `fact ${id}`,
    origin: 'observed',
    s: 0.8,
  });
  store.setEmbedding(id, v);
}

/** Brute-force reference top-k via cosineSimF32. */
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

const idSet = (rows: Array<{ id: string }>): Set<string> =>
  new Set(rows.map(r => r.id));

// ---------------------------------------------------------------------------
// Case 1: kernel set-identity (DIM=8, divisible by 4 → SIMD kernel active)
// ---------------------------------------------------------------------------

describe('CandidateRetriever SIMD kernel — set-identity (Phase 51-03)', () => {
  const DIM = 8; // % 4 === 0 → loadSimdKernel returns a real kernel
  const NODE_COUNT = 40;
  const K = 10;

  let tmpDbPath: string;
  let indexPath: string;
  let db: Database.Database;
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
    for (let i = 1; i <= NODE_COUNT; i++) {
      const v = vec(i, DIM);
      seedNode(store, `n${i}`, v);
      livePairs.push({ id: `n${i}`, v });
    }
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(indexPath); } catch { /* ignore */ }
  });

  it('1. WASM-indexed top-k is set-identical to brute-force with close cosine scores (D-07)', () => {
    const n = buildVectorIndex(db, indexPath);
    expect(n).toBe(NODE_COUNT);

    const indexed = new CandidateRetriever(db, { indexPath });

    // Run several queries to exercise the kernel across different query directions.
    const querySeeds = [7, 13, 42, 99];
    for (const seed of querySeeds) {
      const q = vec(seed, DIM);
      const got = indexed.topk(q, K);
      const ref = bruteforceTopk(livePairs, q, K);

      // Set-identical top-k (D-07 recall@10=1.000 bar — order-independent).
      expect(idSet(got)).toEqual(idSet(ref));

      // Scores close-but-not-necessarily-bitwise-equal (D-07: f32x4 horizontal-sum
      // ordering produces sub-ULP differences from scalar sequential summation).
      const refScore = new Map(ref.map(r => [r.id, r.score]));
      for (const hit of got) {
        expect(hit.score).toBeCloseTo(refScore.get(hit.id)!, 6);
        // Not RRF, not zero — a genuine cosine value from the WASM kernel.
        expect(hit.score).not.toBe(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Case 2: forced kernel-unavailable → scalar fallback set-identical (D-08)
// ---------------------------------------------------------------------------

describe('CandidateRetriever SIMD kernel — forced fallback (Phase 51-03)', () => {
  // DIM=9 is NOT divisible by 4 → loadSimdKernel returns null → topkIndexed
  // runs the verbatim scalar dot loop. This exercises the D-08 integration contract.
  // (The loader-returns-null unit cases are in tests/simd-kernel.test.ts, Plan 02.)
  const DIM = 9;
  const NODE_COUNT = 30;
  const K = 10;

  let tmpDbPath: string;
  let indexPath: string;
  let db: Database.Database;
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
    for (let i = 1; i <= NODE_COUNT; i++) {
      const v = vec(i, DIM);
      seedNode(store, `n${i}`, v);
      livePairs.push({ id: `n${i}`, v });
    }
  });

  afterEach(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
    try { fs.unlinkSync(indexPath); } catch { /* ignore */ }
  });

  it('2. dim%4≠0 → kernel null → scalar fallback returns set-identical top-k, no throw (D-08)', () => {
    // Build the sidecar with DIM=9 vectors (dim%4≠0 → loadSimdKernel returns null).
    const n = buildVectorIndex(db, indexPath);
    expect(n).toBe(NODE_COUNT);

    // Indexed retriever: index loads fine, kernel is null (dim%4≠0), scalar fallback runs.
    // Must not throw on construction or on topk calls.
    let indexed: CandidateRetriever;
    expect(() => {
      indexed = new CandidateRetriever(db, { indexPath });
    }).not.toThrow();

    // Brute-force-only retriever (no index) — the reference scalar path.
    const bruteforce = new CandidateRetriever(db);

    const querySeeds = [5, 17, 33];
    for (const seed of querySeeds) {
      const q = vec(seed, DIM);

      // Both paths must not throw and must produce set-identical results.
      let got: Array<{ id: string; score: number }>;
      expect(() => {
        got = indexed!.topk(q, K);
      }).not.toThrow();

      const ref = bruteforceTopk(livePairs, q, K);

      // Set-identical — scalar fallback must have full recall (no fallback degradation).
      expect(idSet(got!)).toEqual(idSet(ref));

      // Brute-force retriever is also set-identical to the reference.
      const bf = bruteforce.topk(q, K);
      expect(idSet(bf)).toEqual(idSet(ref));
    }
  });
});
