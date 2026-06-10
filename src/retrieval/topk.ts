/**
 * CandidateRetriever — brute-force cosine top-k over non-null node embeddings (STORE-03).
 *
 * Design decisions:
 *  - Read-only: never writes the embedding column (graph is source of truth; vector is derived).
 *  - Brute-force: exact cosine scan is sub-ms at v1 scale (≤1k nodes × 1536 dims ≈ 1-3ms).
 *  - Seam: swap to sqlite-vec/HNSW only when measured latency hurts (v1.3 roadmap).
 *  - Pitfall 5: Float32Array decoded with byteOffset + length (Buffer slices may have nonzero byteOffset).
 */
import Database from 'better-sqlite3';

/**
 * Compute cosine similarity between two Float32Array vectors.
 * Returns 0 when either vector's norm is 0 (denom guard prevents NaN/Infinity).
 *
 * noUncheckedIndexedAccess: indices use non-null assertion (!) — safe because
 * both arrays have identical, known length `a.length`.
 */
export function cosineSimF32(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Brute-force cosine top-k retrieval over embedded, non-tombstoned nodes (STORE-03).
 *
 * Only nodes with `embedding IS NOT NULL AND tombstoned = 0` are scored.
 * - Dirty nodes (embedded_hash IS NULL) are excluded because they have no valid embedding.
 * - Tombstoned nodes are excluded because tombstone() sets tombstoned = 1 but does NOT null
 *   the embedding; without this filter a stale superseded node remains nominable and could be
 *   re-judged or re-confirmed (T-02-STALE). Exclusion is correct for both the Phase-2
 *   consolidator and Phase-3 retrieval since they share this primitive.
 */
export class CandidateRetriever {
  private readonly stmtSelectEmbedded: Database.Statement;
  // D-29: second scan includes tombstoned nodes (their embeddings are NOT nulled by tombstone())
  private readonly stmtSelectTombstoned: Database.Statement;

  constructor(db: Database.Database) {
    // Select only nodes that have been embedded AND are not tombstoned (T-02-STALE)
    this.stmtSelectEmbedded = db.prepare(
      'SELECT id, embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 0'
    );
    // tombstone() does NOT null the embedding — tombstoned nodes remain cosine-scannable (D-29)
    this.stmtSelectTombstoned = db.prepare(
      'SELECT id, embedding FROM node WHERE embedding IS NOT NULL AND tombstoned = 1'
    );
  }

  /**
   * Return the top-k nodes by cosine similarity to `queryVec`, sorted descending.
   * Nodes with null embedding are excluded (read-only on the graph).
   *
   * L-2 (topk side): rows whose decoded length !== queryVec.length are silently skipped.
   * This guards against legacy data or a future embed-provider change that produces a
   * different dimensionality — a mismatched cosine would yield NaN and scramble the sort.
   * The write-side dims assertion (plan 2 setEmbedding guard) prevents new mismatches;
   * this guard handles any pre-existing ones.
   */
  topk(queryVec: Float32Array, k: number): Array<{ id: string; score: number }> {
    const rows = this.stmtSelectEmbedded.all() as Array<{ id: string; embedding: Buffer }>;

    return rows
      .flatMap(row => {
        // Pitfall 5: pass byteOffset + length to handle Buffer slices correctly
        const v = new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        );
        // L-2: skip dimension-mismatched vectors rather than producing NaN scores
        if (v.length !== queryVec.length) return [];
        return [{ id: row.id, score: cosineSimF32(queryVec, v) }];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /**
   * Return the top-k TOMBSTONED nodes by cosine similarity to `queryVec`, sorted descending.
   * Used for the 'deleted' classification second scan (D-29/RET-02).
   * Mirrors topk() exactly — same Float32Array decode (Pitfall 5), same dim guard (L-2), same sort+slice.
   */
  topkTombstoned(queryVec: Float32Array, k: number): Array<{ id: string; score: number }> {
    const rows = this.stmtSelectTombstoned.all() as Array<{ id: string; embedding: Buffer }>;

    return rows
      .flatMap(row => {
        // Pitfall 5: byteOffset + length (Buffer slices may have nonzero byteOffset)
        const v = new Float32Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 4,
        );
        // L-2: skip dimension-mismatched vectors
        if (v.length !== queryVec.length) return [];
        return [{ id: row.id, score: cosineSimF32(queryVec, v) }];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
