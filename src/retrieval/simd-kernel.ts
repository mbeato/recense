/**
 * simd-kernel.ts — WASM SIMD kernel loader and JS partial-select helper.
 *
 * Exports:
 *   loadSimdKernel(data, norms, count, dim) → SimdKernel | null
 *     Blob decode + SIMD feature-detect + instantiate-once loader.
 *     Returns null (never throws) on any detection / instantiation failure (D-08):
 *       - dim % 4 !== 0 (kernel requires f32x4 — 4-element SIMD lanes)
 *       - data.length !== count * dim (shape mismatch)
 *       - WebAssembly.validate(bytes) === false (SIMD opcodes unsupported on this runtime)
 *       - any compile / instantiate throw
 *
 *   partialSelectTopK(scores, ids, k) → Array<{id, score}>
 *     Fixed-size min-heap partial selection. Set-identical to full .sort().slice(k)
 *     (D-02), tolerating identical-score tie reorder at the boundary.
 *
 * Memory layout (single shared WebAssembly.Memory, four contiguous regions):
 *   [qPtr=0          → dim*4 bytes      ] query f32[dim]
 *   [mPtr=dim*4      → count*dim*4 bytes] matrix f32[count*dim]  (loaded once at construction)
 *   [rnPtr=mPtr+...  → count*4 bytes    ] precomputed reciprocal row-norms f32[count]
 *   [outPtr=rnPtr+...→ count*4 bytes    ] scores output f32[count]
 *
 * Thread-safety: the kernel is NOT thread-safe (single shared WASM memory, reusable views).
 * Callers must not invoke scanCosine concurrently on the same kernel instance.
 *
 * Security (T-51-21, T-51-22, T-51-23):
 *   - Bounds guards before any allocation; mismatch → null, never out-of-bounds.
 *   - All fault paths go through one try/catch → null (mirrors loadVectorIndex D-08).
 *   - Reciprocal norms: norms[r]===0 → 0 (no NaN/Infinity, matches cosineSimF32 denom guard).
 */
import { wasmBytes } from './simd-kernel-wasm';

/** Kernel handle returned by a successful loadSimdKernel call. */
export interface SimdKernel {
  /**
   * Scan all corpus rows for cosine similarity against `query`.
   *
   * @param query  Float32Array of length dim (same dim passed to loadSimdKernel).
   * @param qNorm  L2 norm of `query`; pass 0 to get all-zero scores (denom guard).
   * @returns      New Float32Array of length count; element r is cosine(query, row_r).
   *               Caller receives a COPY (the internal WASM score region is reusable).
   */
  scanCosine(query: Float32Array, qNorm: number): Float32Array;
}

/**
 * Decode the committed WASM blob, feature-detect SIMD support, compile and instantiate
 * a kernel once over the index matrix, and return a kernel handle.
 *
 * Returns null on any fault — never throws (D-08, mirrors loadVectorIndex try/catch→null shape).
 *
 * @param data   Row-major Float32Array; length must equal count*dim.
 * @param norms  Float64Array of length count; element r is ||row_r|| (from sidecar).
 * @param count  Number of rows in the matrix.
 * @param dim    Embedding dimensionality; must be divisible by 4 (f32x4 SIMD lane width).
 */
export function loadSimdKernel(
  data: Float32Array,
  norms: Float64Array,
  count: number,
  dim: number,
): SimdKernel | null {
  try {
    // Pre-validate shape before any allocation (T-51-21)
    if (dim % 4 !== 0) return null;
    if (data.length !== count * dim) return null;

    // Feature-detect SIMD: the blob carries v128/f32x4 opcodes, so validate()
    // returns false on runtimes without SIMD support (D-09 discretion, per PATTERNS).
    // Copy into a fresh Uint8Array (ArrayBuffer-backed) so WebAssembly.validate /
    // WebAssembly.Module receive a proper BufferSource (not a Node Buffer pool slice).
    const bytes = new Uint8Array(wasmBytes());
    if (!WebAssembly.validate(bytes)) return null;

    // Synchronous compile — runs once at load time, off the per-query hot path.
    const mod = new WebAssembly.Module(bytes);

    // Memory layout: four contiguous regions
    const qPtr = 0;
    const mPtr = dim * 4;
    const rnPtr = mPtr + count * dim * 4;
    const outPtr = rnPtr + count * 4;
    const total = outPtr + count * 4;
    const pages = Math.ceil(total / 65536) + 4;

    const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    const instance = new WebAssembly.Instance(mod, { env: { mem: memory } });

    // Type the exported scan function (WAT: scan(qPtr,mPtr,rnPtr,outPtr,recipQNorm,n,dimsBytes))
    const scan = instance.exports['scan'] as (
      qPtr: number,
      mPtr: number,
      rnPtr: number,
      outPtr: number,
      recipQNorm: number,
      n: number,
      dimsBytes: number,
    ) => void;

    // Load the corpus ONCE at construction (never per-query)
    new Float32Array(memory.buffer, mPtr, count * dim).set(data);

    // Precompute per-row reciprocal norms once into the rnPtr region (f32).
    // Zero row-norm → 0 reciprocal → score 0, matching cosineSimF32 denom guard (T-51-23).
    const recipNormsView = new Float32Array(memory.buffer, rnPtr, count);
    for (let r = 0; r < count; r++) {
      const norm = norms[r]!;
      recipNormsView[r] = norm === 0 ? 0 : 1 / norm;
    }

    // Persistent views over the query and scores regions (reused each scanCosine call)
    const qView = new Float32Array(memory.buffer, qPtr, dim);
    const scoresView = new Float32Array(memory.buffer, outPtr, count);

    const dimsBytes = dim * 4;

    return {
      scanCosine(query: Float32Array, qNorm: number): Float32Array {
        qView.set(query);
        const recipQNorm = qNorm === 0 ? 0 : 1 / qNorm;
        scan(qPtr, mPtr, rnPtr, outPtr, recipQNorm, count, dimsBytes);
        // Return a COPY so the caller holds a stable array (the view aliases reusable WASM memory)
        return scoresView.slice(0, count);
      },
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// partialSelectTopK — fixed-size min-heap partial selection (D-02)
// ---------------------------------------------------------------------------

/**
 * Return the k highest-scoring {id, score} entries, sorted descending.
 *
 * Set-identical to:
 *   Array.from({length: scores.length}, (_,i) => ({id: ids[i], score: scores[i]}))
 *     .sort((a,b) => b.score - a.score).slice(0, k)
 *
 * Tolerates identical-score tie reorder at the k-boundary (D-02).
 * Pure JS — no dependencies. O(n log k) time, O(k) space.
 *
 * @param scores Float32Array of cosine scores (output of kernel.scanCosine or scalar scan)
 * @param ids    Parallel id array; ids[i] corresponds to scores[i]
 * @param k      Number of top entries to return; k=0 → []; k>=count → all sorted
 */
export function partialSelectTopK(
  scores: Float32Array,
  ids: string[],
  k: number,
): Array<{ id: string; score: number }> {
  if (k <= 0) return [];

  const n = scores.length;
  if (k >= n) {
    // Return all entries sorted descending
    const all: Array<{ id: string; score: number }> = new Array(n);
    for (let i = 0; i < n; i++) {
      all[i] = { id: ids[i]!, score: scores[i]! };
    }
    return all.sort((a, b) => b.score - a.score);
  }

  // Fixed-size min-heap of capacity k.
  // Each entry: [score, original index]. Heap invariant: heap[0] is the minimum.
  // heap[i]! is safe — all accesses stay within heap.length (invariant maintained below).
  const heap: Array<[number, number]> = [];

  /** Sift element at position i toward the root (min-heap restore after push). */
  function siftUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent]![0] <= heap[i]![0]) break;
      const tmp = heap[parent]!;
      heap[parent] = heap[i]!;
      heap[i] = tmp;
      i = parent;
    }
  }

  /** Sift element at position i toward the leaves (min-heap restore after root pop). */
  function siftDown(i: number): void {
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let min = i;
      if (l < heap.length && heap[l]![0] < heap[min]![0]) min = l;
      if (r < heap.length && heap[r]![0] < heap[min]![0]) min = r;
      if (min === i) break;
      const tmp = heap[min]!;
      heap[min] = heap[i]!;
      heap[i] = tmp;
      i = min;
    }
  }

  for (let i = 0; i < n; i++) {
    const s = scores[i]!;
    if (heap.length < k) {
      // Heap not yet full: push and restore heap property
      heap.push([s, i]);
      siftUp(heap.length - 1);
    } else if (s > heap[0]![0]) {
      // Score beats the current minimum: replace the min and re-heapify
      heap[0] = [s, i];
      siftDown(0);
    }
  }

  // Map heap entries back to {id, score} and sort descending
  return heap
    .map(([score, idx]) => ({ id: ids[idx]!, score }))
    .sort((a, b) => b.score - a.score);
}
