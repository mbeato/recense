/**
 * Synthetic unit-vector corpus for STORE-03 brute-force cosine top-k tests.
 *
 * Produces N standard-basis unit vectors (sparse: 1.0 at position i, 0.0 elsewhere).
 * With dims >= N, all vectors are mutually orthogonal.
 *
 * Ground truth: for each query vectors[i], the nearest neighbor is itself (cosine = 1.0).
 * All other pairs have cosine = 0.0 (orthogonal). No tie-breaking needed for top-1 checks.
 */
export function makeSyntheticVectors(dims: number = 16): {
  vectors: Float32Array[];
  /** groundTruth[i] = expected top-1 index when querying with vectors[i] */
  groundTruth: number[];
} {
  const n = Math.min(dims, 8); // use at most 8 vectors (fits in any reasonable dims)
  const vectors = Array.from({ length: n }, (_, i) => {
    const v = new Float32Array(dims);
    v[i] = 1.0;
    return v;
  });
  // Self-similarity is always the top hit: groundTruth[i] = i
  const groundTruth = Array.from({ length: n }, (_, i) => i);
  return { vectors, groundTruth };
}
