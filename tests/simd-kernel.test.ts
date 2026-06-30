/**
 * Unit tests for simd-kernel.ts (Phase 51 Plan 02).
 *
 * Case 1 — scanCosine exactness (D-07):
 *   kernel.scanCosine(q, qNorm) must match cosineSimF32(q, row_r) for every row
 *   within toBeCloseTo(6); zero-norm row yields exactly 0.
 *
 * Case 2 — partialSelectTopK set-identity (D-02):
 *   idSet(partialSelectTopK(scores, ids, k)) equals idSet(full sort + slice)
 *   for k in {0, 1, 10, count}; tolerates identical-score tie reorder.
 *
 * Case 3 — safe fallback (D-08):
 *   loadSimdKernel returns null (never throws) on dim%4!==0, data-length
 *   mismatch, and a forced compile failure (truncated WASM bytes).
 */
import { describe, it, expect, vi } from 'vitest';
import { loadSimdKernel, partialSelectTopK } from '../src/retrieval/simd-kernel';
import { cosineSimF32 } from '../src/retrieval/topk';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const DIM = 8; // divisible by 4 — exercises the f32x4 SIMD path (not just fallback)
const COUNT = 10;

/** Deterministic pseudo-random Float32Array seeded from `seed`. Mirrors topk-index.test.ts vec(). */
function vec(seed: number, dim: number = DIM): Float32Array {
  const v = new Float32Array(dim);
  let x = (seed * 2654435761) >>> 0;
  for (let i = 0; i < dim; i++) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    v[i] = ((x % 2000) - 1000) / 1000;
  }
  return v;
}

function l2norm(v: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!;
  return Math.sqrt(sum);
}

/**
 * Build a contiguous data matrix + norms array for `count` rows x `dim` dims.
 * Row r is vec(r+1). Returns data: Float32Array, norms: Float64Array.
 */
function buildFixture(
  count: number,
  dim: number,
): { data: Float32Array; norms: Float64Array } {
  const data = new Float32Array(count * dim);
  const norms = new Float64Array(count);
  for (let r = 0; r < count; r++) {
    const row = vec(r + 1, dim);
    data.set(row, r * dim);
    norms[r] = l2norm(row);
  }
  return { data, norms };
}

/** Get row r from the data buffer as a read-only view. */
function getRow(data: Float32Array, r: number, dim: number): Float32Array {
  return data.subarray(r * dim, r * dim + dim);
}

/** Extract the id set from a scored array. */
const idSet = (rows: Array<{ id: string }>): Set<string> => new Set(rows.map(r => r.id));

// ---------------------------------------------------------------------------
// Case 1 — scanCosine exactness (D-07)
// ---------------------------------------------------------------------------

describe('loadSimdKernel + scanCosine (Case 1 — exactness D-07)', () => {
  it('loadSimdKernel returns non-null on SIMD-capable runtime with valid data', () => {
    const { data, norms } = buildFixture(COUNT, DIM);
    const kernel = loadSimdKernel(data, norms, COUNT, DIM);
    // On modern Node.js v128/f32x4 SIMD is supported; loadSimdKernel must return a kernel.
    expect(kernel).not.toBeNull();
  });

  it('scanCosine matches cosineSimF32 for every row within toBeCloseTo(6)', () => {
    const { data, norms } = buildFixture(COUNT, DIM);
    const kernel = loadSimdKernel(data, norms, COUNT, DIM);
    expect(kernel).not.toBeNull();
    if (!kernel) return;

    // Several seeded query vectors
    for (const seed of [7, 13, 42, 99]) {
      const q = vec(seed);
      const qNorm = l2norm(q);
      const scores = kernel.scanCosine(q, qNorm);
      expect(scores).toHaveLength(COUNT);
      for (let r = 0; r < COUNT; r++) {
        const row = getRow(data, r, DIM);
        const expected = cosineSimF32(q, row);
        // D-07: sub-ULP f32x4 horizontal-sum differences — toBeCloseTo, NOT toBe
        expect(scores[r]!).toBeCloseTo(expected, 6);
      }
    }
  });

  it('scanCosine returns exactly 0 for a zero-norm row', () => {
    const { data, norms } = buildFixture(COUNT, DIM);
    // Force row 3 to have zero norm
    const zeroRow = 3;
    data.fill(0, zeroRow * DIM, (zeroRow + 1) * DIM);
    norms[zeroRow] = 0;

    const kernel = loadSimdKernel(data, norms, COUNT, DIM);
    expect(kernel).not.toBeNull();
    if (!kernel) return;

    const q = vec(7);
    const qNorm = l2norm(q);
    const scores = kernel.scanCosine(q, qNorm);
    // Zero row-norm → reciprocal = 0 → score = 0 (denom guard, matches cosineSimF32)
    expect(scores[zeroRow]!).toBe(0);
  });

  it('scanCosine returns all 0s for a zero query-norm', () => {
    const { data, norms } = buildFixture(COUNT, DIM);
    const kernel = loadSimdKernel(data, norms, COUNT, DIM);
    expect(kernel).not.toBeNull();
    if (!kernel) return;

    const zeroQuery = new Float32Array(DIM); // all zeros
    const scores = kernel.scanCosine(zeroQuery, 0);
    // Zero query-norm → recipQNorm = 0 → all scores = 0
    for (let r = 0; r < COUNT; r++) {
      expect(scores[r]!).toBe(0);
    }
  });

  it('scanCosine returns a stable copy (not aliased to WASM memory)', () => {
    const { data, norms } = buildFixture(COUNT, DIM);
    const kernel = loadSimdKernel(data, norms, COUNT, DIM);
    expect(kernel).not.toBeNull();
    if (!kernel) return;

    const q1 = vec(1);
    const q2 = vec(2);
    const scores1 = kernel.scanCosine(q1, l2norm(q1));
    const scores2 = kernel.scanCosine(q2, l2norm(q2));
    // scores1 must not be aliased — it must not change after a second call
    expect(scores1).not.toBe(scores2);
    // Re-running q1 must reproduce identical values
    const scores1Again = kernel.scanCosine(q1, l2norm(q1));
    for (let r = 0; r < COUNT; r++) {
      expect(scores1[r]!).toBeCloseTo(scores1Again[r]!, 10);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 2 — partialSelectTopK set-identity (D-02)
// ---------------------------------------------------------------------------

describe('partialSelectTopK (Case 2 — set-identity D-02)', () => {
  it('k=0 returns []', () => {
    const scores = Float32Array.from([0.9, 0.8, 0.7]);
    const ids = ['a', 'b', 'c'];
    expect(partialSelectTopK(scores, ids, 0)).toEqual([]);
  });

  it('k >= scores.length returns all entries sorted descending', () => {
    const scores = Float32Array.from([0.3, 0.9, 0.1, 0.7]);
    const ids = ['a', 'b', 'c', 'd'];
    const result = partialSelectTopK(scores, ids, 10);
    expect(result).toHaveLength(4);
    // Must be sorted descending
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1]!.score).toBeGreaterThanOrEqual(result[i]!.score);
    }
    expect(idSet(result)).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  it('returns exactly k entries sorted descending for k < count', () => {
    const scores = Float32Array.from([0.1, 0.9, 0.5, 0.3, 0.8]);
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const result = partialSelectTopK(scores, ids, 3);
    expect(result).toHaveLength(3);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1]!.score).toBeGreaterThanOrEqual(result[i]!.score);
    }
    // Top-3: b(0.9), e(0.8), c(0.5)
    expect(idSet(result)).toEqual(new Set(['b', 'e', 'c']));
  });

  it('set-identical to full sort+slice for k=1', () => {
    const n = 20;
    const scores = new Float32Array(n);
    const ids: string[] = [];
    let x = 12345 >>> 0;
    for (let i = 0; i < n; i++) {
      x = (x * 1664525 + 1013904223) >>> 0;
      scores[i] = (x % 10000) / 10000;
      ids.push(`id${i}`);
    }
    const got = idSet(partialSelectTopK(scores, ids, 1));
    const expected = idSet(
      Array.from({ length: n }, (_, i) => ({ id: ids[i]!, score: scores[i]! }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 1),
    );
    expect(got).toEqual(expected);
  });

  it('set-identical to full sort+slice for multiple seeds and k values', () => {
    const n = 50;
    const ids: string[] = Array.from({ length: n }, (_, i) => `node${i}`);

    for (const lcgSeed of [0xdeadbeef, 0xcafebabe, 0x12345678]) {
      const scores = new Float32Array(n);
      let x = lcgSeed >>> 0;
      for (let i = 0; i < n; i++) {
        x = (x * 1664525 + 1013904223) >>> 0;
        scores[i] = (x % 100000) / 100000;
      }

      const fullSorted = Array.from({ length: n }, (_, i) => ({
        id: ids[i]!,
        score: scores[i]!,
      })).sort((a, b) => b.score - a.score);

      for (const k of [1, 10, n]) {
        const got = idSet(partialSelectTopK(scores, ids, k));
        const expected = idSet(fullSorted.slice(0, k));
        expect(got).toEqual(expected);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Case 3 — safe fallback (D-08): null not throw
// ---------------------------------------------------------------------------

describe('loadSimdKernel safe fallback (Case 3 — D-08)', () => {
  it('returns null (not throw) when dim % 4 !== 0', () => {
    const badDim = DIM + 1; // 9, 9%4=1
    // Use data sized for DIM rows (length mismatch doesn't matter — dim guard fires first)
    const { data, norms } = buildFixture(COUNT, DIM);
    let result: ReturnType<typeof loadSimdKernel> | undefined;
    expect(() => {
      result = loadSimdKernel(data, norms, COUNT, badDim);
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it('returns null (not throw) on data-length mismatch (count*dim !== data.length)', () => {
    const { data, norms } = buildFixture(COUNT, DIM);
    // Pass count+1 but data is only COUNT*DIM long — length guard fires
    let result: ReturnType<typeof loadSimdKernel> | undefined;
    expect(() => {
      result = loadSimdKernel(data, norms, COUNT + 1, DIM);
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it('returns null (not throw) on compile failure (truncated/invalid WASM bytes)', async () => {
    // Mock wasmBytes to return a truncated WASM header (invalid module) to exercise
    // the try/catch → null path for WebAssembly.validate() returning false.
    // "\0asm" without the 4-byte version field is not a valid WASM module.
    const simdWasm = await import('../src/retrieval/simd-kernel-wasm');
    vi.spyOn(simdWasm, 'wasmBytes').mockReturnValue(new Uint8Array([0x00, 0x61, 0x73, 0x6d]));

    const { data, norms } = buildFixture(COUNT, DIM);
    let result: ReturnType<typeof loadSimdKernel> | undefined;
    expect(() => {
      result = loadSimdKernel(data, norms, COUNT, DIM);
    }).not.toThrow();
    expect(result).toBeNull();

    vi.restoreAllMocks();
  });
});
